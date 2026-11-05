import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'bun:test'

import {DECLARED_OBSERVATIONS} from './declared'
import {
  GO_MONITOR_OBSERVATION_ID,
  GO_PROBE_REASON_STATE,
  MONITOR_API_CALL_BUDGET,
  MONITOR_LOG_RETRY_BUDGET,
  MONITOR_OBSERVATION_ID,
  MONITOR_STALE_AFTER_MS,
  parseGoProbeLine,
  parseProbeLine,
  PROBE_REASON_STATE,
  readMonitorState,
} from './monitor-state'
import {observationSchema, type Observation} from './observation'

const NOW = new Date('2026-11-01T23:00:00.000Z')
const TOKEN = 'ghs_test_token_must_never_leak'
const SIGNED_LOG_URL = 'https://logs.example.invalid/signed/job-log?sig=abc'
const PROBE_AT = '2026-11-01T22:56:01.220Z'

function fixtureText(name: string): string {
  return readFileSync(join(import.meta.dir, '__fixtures__', name), 'utf8')
}

function fixtureJson<T>(name: string): T {
  return JSON.parse(fixtureText(name)) as T
}

interface RunFixture {
  id: number
  run_attempt: number
  event: string
  status: string
  conclusion: string | null
  head_branch: string
  created_at: string
}

const realRun = fixtureJson<{workflow_runs: RunFixture[]}>('monitor-runs.json').workflow_runs[0] as RunFixture
const realJobs = fixtureJson<{jobs: unknown[]}>('monitor-jobs.json')

/** Wrap bare lines the way the runner does: a timestamp prefix on every line. */
function runnerLog(...lines: string[]): string {
  return `${lines.map((line, index) => `2026-11-01T22:56:0${index % 10}.1234567Z ${line}`).join('\n')}\n`
}

function probeLine(state = 'healthy', reason = 'ok', at = PROBE_AT): string {
  return `CLIProxy auth monitor probe: probe=${state} reason=${reason} at ${at}`
}

function goProbeLine(state = 'healthy', reason = 'ok', at = PROBE_AT): string {
  return `CLIProxy Go monitor probe: probe=${state} reason=${reason} at ${at}`
}

interface Scenario {
  runs?: RunFixture[]
  jobs?: unknown[]
  /** Successive log bodies; the last one repeats. */
  logs?: string[]
  runsStatus?: number
  jobsStatus?: number
  logStatus?: number
  blobStatus?: number
  throwOn?: 'runs' | 'jobs' | 'logs' | 'blob'
  ignoreRunFilters?: boolean
}

interface Request {
  url: URL
  headers: Headers
  redirect?: RequestInit['redirect']
}

function fakeGitHub(scenario: Scenario = {}) {
  const requests: Request[] = []
  const runs = scenario.runs ?? [realRun]
  const jobs = scenario.jobs ?? realJobs.jobs
  const logs = scenario.logs ?? [runnerLog(probeLine())]
  let blobReads = 0

  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    requests.push({url, headers: new Headers(init?.headers), redirect: init?.redirect})

    if (url.href === SIGNED_LOG_URL) {
      if (scenario.throwOn === 'blob') throw new TypeError('socket hang up')
      if (scenario.blobStatus !== undefined) return new Response('denied', {status: scenario.blobStatus})
      const body = logs[Math.min(blobReads, logs.length - 1)] ?? ''
      blobReads += 1
      return new Response(body)
    }

    if (url.pathname === '/repos/marcusrbrown/infra/actions/workflows/cliproxy-auth-monitor.yaml/runs') {
      if (scenario.throwOn === 'runs') throw new TypeError('connect ECONNREFUSED')
      if (scenario.runsStatus !== undefined) return new Response('{"message":"x"}', {status: scenario.runsStatus})
      const event = url.searchParams.get('event')
      const branch = url.searchParams.get('branch')
      const filtered = scenario.ignoreRunFilters
        ? runs
        : runs.filter(run => run.event === event && run.head_branch === branch)
      return Response.json({workflow_runs: filtered.slice(0, Number(url.searchParams.get('per_page')))})
    }

    if (/^\/repos\/marcusrbrown\/infra\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      if (scenario.throwOn === 'jobs') throw new TypeError('connect ECONNREFUSED')
      if (scenario.jobsStatus !== undefined) return new Response('{"message":"x"}', {status: scenario.jobsStatus})
      return Response.json({jobs})
    }

    if (/^\/repos\/marcusrbrown\/infra\/actions\/jobs\/\d+\/logs$/.test(url.pathname)) {
      if (scenario.throwOn === 'logs') throw new TypeError('connect ECONNREFUSED')
      if (scenario.logStatus !== undefined) return new Response('{"message":"gone"}', {status: scenario.logStatus})
      return new Response(null, {status: 302, headers: {location: SIGNED_LOG_URL}})
    }

    return new Response('unexpected', {status: 404})
  }

  const apiRequests = () => requests.filter(request => request.url.origin === 'https://api.github.com')
  const logApiRequests = () => apiRequests().filter(request => request.url.pathname.endsWith('/logs'))

  return {fetchFn, requests, apiRequests, logApiRequests}
}

function run(overrides: Partial<RunFixture> = {}): RunFixture {
  return {...realRun, ...overrides}
}

function pick(observations: readonly Observation[], id: string): Observation {
  const found = observations.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`readMonitorState returned no ${id} observation`)
  return found
}

async function readWithToken(scenario: Scenario, token: string | undefined) {
  const github = fakeGitHub(scenario)
  const observations = await readMonitorState({token, fetch: github.fetchFn, now: NOW})
  const observation = pick(observations, MONITOR_OBSERVATION_ID)
  const goObservation = pick(observations, GO_MONITOR_OBSERVATION_ID)
  return {observation, goObservation, observations, ...github}
}

function read(scenario: Scenario = {}) {
  return readWithToken(scenario, TOKEN)
}

describe('contract', () => {
  it('uses the id and kind the cliproxy declaration expects', () => {
    const declared = DECLARED_OBSERVATIONS.cliproxy.find(entry => entry.id === MONITOR_OBSERVATION_ID)
    expect(declared?.kind).toBe('end-to-end')
  })

  it('states a bounded budget: 3 API calls plus one log retry, and a 45 minute freshness limit', () => {
    expect(MONITOR_API_CALL_BUDGET).toBe(3)
    expect(MONITOR_LOG_RETRY_BUDGET).toBe(1)
    expect(MONITOR_STALE_AFTER_MS).toBe(45 * 60_000)
  })

  it('declares the Go route as its own end-to-end monitor observation', () => {
    const declared = DECLARED_OBSERVATIONS.cliproxy.find(entry => entry.id === GO_MONITOR_OBSERVATION_ID)
    expect(declared).toMatchObject({id: 'provider-route-go', kind: 'end-to-end', source: 'monitor', owner: 'github'})
  })

  it('only accepts Go reason/state pairs the Go classifier can emit', () => {
    expect(GO_PROBE_REASON_STATE).toEqual({
      ok: 'healthy',
      'billing-not-go': 'dead',
      'provider-missing': 'dead',
      'privacy-noncompliant': 'dead',
      'quota-or-billing': 'dead',
      'auth-401': 'dead',
      'auth-unavailable-503': 'dead',
      'probe-misconfigured': 'unknown',
      'unrelated-http': 'unknown',
      timeout: 'unknown',
      network: 'unknown',
    })
  })

  it('only accepts reason/state pairs the cliproxy classifier can emit', () => {
    expect(PROBE_REASON_STATE).toEqual({
      ok: 'healthy',
      'auth-401': 'dead',
      'auth-unavailable-503': 'dead',
      'provider-missing': 'dead',
      'unrelated-http': 'unknown',
      timeout: 'unknown',
      network: 'unknown',
    })
  })
})

describe('parseProbeLine', () => {
  it('strips the runner timestamp, a BOM and CRLF, and parses the recorded log shape', () => {
    // Build the CRLF input here so the test does not depend on the line endings git leaves on disk.
    const crlf = fixtureText('monitor-log-healthy.txt').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
    expect(crlf).toContain('\r\n')

    expect(parseProbeLine(crlf)).toEqual({kind: 'probe', state: 'healthy', reason: 'ok', at: PROBE_AT})
  })

  it('does not match the daily report summary line', () => {
    const summary =
      'CLIProxy auth monitor summary: probe=healthy reason=ok transition=none issue=none discord=none at 2026-11-01T22:56:01.220Z'
    expect(parseProbeLine(runnerLog(summary))).toEqual({kind: 'none'})
  })

  it('accepts a line without a runner prefix', () => {
    expect(parseProbeLine(`${probeLine('dead', 'auth-401')}\n`)).toMatchObject({kind: 'probe', state: 'dead'})
  })

  it.each([
    ['an unknown state', probeLine('broken', 'ok')],
    ['an unknown reason', probeLine('healthy', 'bogus')],
    ['a state that does not match its reason', probeLine('healthy', 'auth-401')],
    ['a non-ISO time', probeLine('healthy', 'ok', 'yesterday')],
    ['trailing fields', `${probeLine()} issue=https://example.invalid/1`],
    ['a missing time', 'CLIProxy auth monitor probe: probe=healthy reason=ok'],
    ['extra whitespace', probeLine().replace('probe=healthy reason', 'probe=healthy  reason')],
  ])('marks %s as malformed', (_label, line) => {
    expect(parseProbeLine(runnerLog(line))).toEqual({kind: 'malformed'})
  })

  it('rejects two probe lines, even identical ones', () => {
    expect(parseProbeLine(runnerLog(probeLine(), probeLine()))).toEqual({kind: 'multiple'})
  })

  it('ignores lines that merely contain the prefix mid-line', () => {
    expect(parseProbeLine(runnerLog(`echo "${probeLine()}"`))).toEqual({kind: 'none'})
  })

  it('reports an empty or whitespace-only log as none', () => {
    expect(parseProbeLine('')).toEqual({kind: 'none'})
    expect(parseProbeLine('\n  \n')).toEqual({kind: 'none'})
  })
})

describe('parseGoProbeLine', () => {
  it('parses a Go probe line and ignores the Claude one in the same log', () => {
    const log = runnerLog(probeLine('dead', 'auth-401'), goProbeLine('healthy', 'ok'))

    expect(parseGoProbeLine(log)).toEqual({kind: 'probe', state: 'healthy', reason: 'ok', at: PROBE_AT})
    expect(parseProbeLine(log)).toEqual({kind: 'probe', state: 'dead', reason: 'auth-401', at: PROBE_AT})
  })

  it('reads one line of each route as neither multiple nor missing', () => {
    const log = runnerLog(probeLine(), goProbeLine())

    expect(parseProbeLine(log).kind).toBe('probe')
    expect(parseGoProbeLine(log).kind).toBe('probe')
  })

  it('reports a log with only the Claude line as no Go line', () => {
    expect(parseGoProbeLine(runnerLog(probeLine()))).toEqual({kind: 'none'})
  })

  it('does not match a Go summary line', () => {
    expect(parseGoProbeLine(runnerLog(`CLIProxy Go monitor summary: probe=healthy reason=ok at ${PROBE_AT}`))).toEqual({
      kind: 'none',
    })
  })

  it('rejects two Go lines', () => {
    expect(parseGoProbeLine(runnerLog(goProbeLine(), goProbeLine()))).toEqual({kind: 'multiple'})
  })

  it.each(['quota-or-billing', 'billing-not-go', 'privacy-noncompliant', 'probe-misconfigured'])(
    'rejects the Go-only reason %s on a Claude line, and accepts it on a Go line',
    reason => {
      const state = reason === 'probe-misconfigured' ? 'unknown' : 'dead'

      expect(parseProbeLine(runnerLog(probeLine(state, reason)))).toEqual({kind: 'malformed'})
      expect(parseGoProbeLine(runnerLog(goProbeLine(state, reason)))).toMatchObject({kind: 'probe', reason})
    },
  )

  it.each([
    ['an unknown reason', goProbeLine('dead', 'bogus')],
    ['a state that does not match its reason', goProbeLine('healthy', 'quota-or-billing')],
    ['a non-ISO time', goProbeLine('healthy', 'ok', 'yesterday')],
    ['trailing fields', `${goProbeLine()} cost=0.1`],
  ])('marks %s as malformed', (_label, line) => {
    expect(parseGoProbeLine(runnerLog(line))).toEqual({kind: 'malformed'})
  })
})

describe('readMonitorState', () => {
  it('reads a healthy probe on a successful run as pass, keeping the probe time apart from the read time', async () => {
    const {observation} = await read({logs: [fixtureText('monitor-log-healthy.txt')]})

    expect(observation).toEqual({
      id: 'provider-route',
      kind: 'end-to-end',
      source: 'monitor',
      result: 'pass',
      observedAt: NOW.toISOString(),
      detail: {reason: 'ok', probeAt: PROBE_AT},
    })
  })

  it('reads probe=dead on a failed run as fail, keeping the probe time', async () => {
    const {observation} = await read({
      runs: [run({conclusion: 'failure'})],
      logs: [runnerLog(probeLine('dead', 'auth-401'))],
    })

    expect(observation).toEqual({
      id: 'provider-route',
      kind: 'end-to-end',
      source: 'monitor',
      result: 'fail',
      observedAt: NOW.toISOString(),
      detail: {reason: 'auth-401', probeAt: PROBE_AT},
    })
  })

  it('still reads the probe from a failed run whose reconciliation failed after the line', async () => {
    const {observation} = await read({
      runs: [run({conclusion: 'failure'})],
      logs: [
        runnerLog(
          probeLine('healthy', 'ok'),
          'Error: issue reconciliation failed',
          '##[error]Process completed with exit code 1.',
        ),
      ],
    })

    expect(observation.result).toBe('pass')
  })

  it('reads a cancelled run that has a probe line', async () => {
    const {observation} = await read({runs: [run({conclusion: 'cancelled'})]})

    expect(observation.result).toBe('pass')
  })

  it.each([
    ['unrelated-http', 'unrelated-http'],
    ['timeout', 'timeout'],
    ['network', 'network'],
  ])('keeps the reason for probe=unknown (%s)', async (reason, expected) => {
    const {observation} = await read({logs: [runnerLog(probeLine('unknown', reason))]})

    expect(observation).toMatchObject({result: 'unknown', detail: {reason: expected, probeAt: PROBE_AT}})
  })

  it.each([
    ['provider-missing', 'dead'],
    ['auth-unavailable-503', 'dead'],
  ])('reads %s as fail', async (reason, state) => {
    const {observation} = await read({logs: [runnerLog(probeLine(state, reason))]})

    expect(observation).toMatchObject({result: 'fail', detail: {reason}})
  })

  describe('two routes in one job log', () => {
    const NOW_ISO = NOW.toISOString()

    it('returns one observation per route, in declared order, from the one log read', async () => {
      const {observations, logApiRequests} = await read({logs: [runnerLog(probeLine(), goProbeLine())]})

      expect(observations.map(observation => observation.id)).toEqual(['provider-route', 'provider-route-go'])
      expect(observations).toEqual([
        {
          id: 'provider-route',
          kind: 'end-to-end',
          source: 'monitor',
          result: 'pass',
          observedAt: NOW_ISO,
          detail: {reason: 'ok', probeAt: PROBE_AT},
        },
        {
          id: 'provider-route-go',
          kind: 'end-to-end',
          source: 'monitor',
          result: 'pass',
          observedAt: NOW_ISO,
          detail: {reason: 'ok', probeAt: PROBE_AT},
        },
      ])
      expect(logApiRequests()).toHaveLength(1)
    })

    it('keeps the routes independent: Claude healthy and Go dead', async () => {
      const {observation, goObservation} = await read({
        logs: [runnerLog(probeLine(), goProbeLine('dead', 'quota-or-billing'))],
      })

      expect(observation).toMatchObject({result: 'pass', detail: {reason: 'ok'}})
      expect(goObservation).toMatchObject({result: 'fail', detail: {reason: 'quota-or-billing', probeAt: PROBE_AT}})
    })

    it('keeps the routes independent: Claude dead and Go healthy', async () => {
      const {observation, goObservation} = await read({
        logs: [runnerLog(probeLine('dead', 'auth-401'), goProbeLine())],
      })

      expect(observation).toMatchObject({result: 'fail', detail: {reason: 'auth-401'}})
      expect(goObservation.result).toBe('pass')
    })

    it('makes only the Go observation unknown when the Go line is missing (a log from before the Go route)', async () => {
      const {observation, goObservation} = await read({logs: [runnerLog(probeLine())]})

      expect(observation.result).toBe('pass')
      expect(goObservation).toMatchObject({result: 'unknown', source: 'monitor', detail: {reason: 'no-probe-line'}})
    })

    it('makes only the Go observation unknown when the Go line is malformed', async () => {
      const {observation, goObservation} = await read({
        logs: [runnerLog(probeLine(), goProbeLine('healthy', 'quota-or-billing'))],
      })

      expect(observation.result).toBe('pass')
      expect(goObservation).toMatchObject({result: 'unknown', detail: {reason: 'malformed-probe-line'}})
    })

    it('makes only the Go observation unknown for two Go lines', async () => {
      const {observation, goObservation} = await read({
        logs: [runnerLog(probeLine(), goProbeLine(), goProbeLine())],
      })

      expect(observation.result).toBe('pass')
      expect(goObservation).toMatchObject({result: 'unknown', detail: {reason: 'multiple-probe-lines'}})
    })

    it('makes only the Claude observation unknown when the Claude line carries a Go-only reason', async () => {
      const {observation, goObservation} = await read({
        logs: [runnerLog(probeLine('dead', 'quota-or-billing'), goProbeLine())],
      })

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'malformed-probe-line'}})
      expect(goObservation.result).toBe('pass')
    })

    it('judges freshness per route', async () => {
      const old = '2026-11-01T21:00:00.000Z'
      const {observation, goObservation} = await read({
        logs: [runnerLog(probeLine(), goProbeLine('dead', 'auth-401', old))],
      })

      expect(observation.result).toBe('pass')
      expect(goObservation).toMatchObject({result: 'unknown', detail: {reason: 'stale', probeAt: old}})
    })

    it('gives both routes the same unknown reason when the run itself cannot be read', async () => {
      const {observations} = await read({runsStatus: 500})

      expect(observations.map(observation => observation.detail)).toEqual([
        {reason: 'api-error'},
        {reason: 'api-error'},
      ])
      expect(observations.map(observation => observation.id)).toEqual(['provider-route', 'provider-route-go'])
    })

    it('never carries log text, cost or usage into either observation', async () => {
      const hostile = `${goProbeLine('dead', 'quota-or-billing')} list_cost=0.00006 allowance=41`
      const {observations} = await read({logs: [runnerLog(probeLine(), hostile)]})

      for (const observation of observations) {
        expect(observationSchema.safeParse(observation).success).toBe(true)
        expect(JSON.stringify(observation)).not.toMatch(/list_cost|allowance|0\.00006/)
      }
    })
  })

  describe('freshness', () => {
    it('reads a healthy probe older than 45 minutes as unknown / stale, keeping probeAt', async () => {
      const at = '2026-11-01T22:14:00.000Z'
      const {observation} = await read({logs: [runnerLog(probeLine('healthy', 'ok', at))]})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'stale', probeAt: at}})
    })

    it('treats a dead probe older than 45 minutes as stale too', async () => {
      const at = '2026-11-01T21:00:00.000Z'
      const {observation} = await read({logs: [runnerLog(probeLine('dead', 'auth-401', at))]})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'stale'}})
    })

    it('accepts a probe exactly 45 minutes old and rejects one a second older', async () => {
      const exact = new Date(NOW.getTime() - MONITOR_STALE_AFTER_MS).toISOString()
      const older = new Date(NOW.getTime() - MONITOR_STALE_AFTER_MS - 1000).toISOString()

      expect((await read({logs: [runnerLog(probeLine('healthy', 'ok', exact))]})).observation.result).toBe('pass')
      expect((await read({logs: [runnerLog(probeLine('healthy', 'ok', older))]})).observation).toMatchObject({
        result: 'unknown',
        detail: {reason: 'stale'},
      })
    })

    it('rejects a probe time far in the future as malformed', async () => {
      const at = '2026-11-02T03:00:00.000Z'
      const {observation} = await read({logs: [runnerLog(probeLine('healthy', 'ok', at))]})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'malformed-probe-line'}})
    })
  })

  describe('which run is read', () => {
    it('asks for the newest schedule-event run on main', async () => {
      const {apiRequests} = await read()
      const [first] = apiRequests()

      expect(first?.url.searchParams.get('event')).toBe('schedule')
      expect(first?.url.searchParams.get('branch')).toBe('main')
      expect(first?.url.searchParams.get('per_page')).toBe('1')
    })

    it('skips a newer workflow_dispatch run and uses the earlier schedule run', async () => {
      const dispatch = run({id: 999, event: 'workflow_dispatch', created_at: '2026-11-01T22:58:00Z'})
      const scheduled = run({id: 41359564834})
      const {observation, apiRequests} = await read({
        runs: [dispatch, scheduled],
        logs: [runnerLog(probeLine('healthy', 'ok'))],
      })

      expect(observation.result).toBe('pass')
      expect(apiRequests().some(request => request.url.pathname.includes('/actions/runs/999/'))).toBe(false)
    })

    it('does not trust a response that ignored the event filter', async () => {
      const {observation} = await read({
        runs: [run({event: 'workflow_dispatch'})],
        ignoreRunFilters: true,
      })

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'no-run'}})
    })

    it('does not trust a response from another branch', async () => {
      const {observation} = await read({runs: [run({head_branch: 'feat/x'})], ignoreRunFilters: true})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'no-run'}})
    })

    it('reports no run at all as unknown / no-run', async () => {
      const {observation} = await read({runs: []})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'no-run'}})
    })

    it.each(['queued', 'in_progress', 'waiting', 'requested'])(
      'reads a %s run as unknown / running without reading logs',
      async status => {
        const {observation, apiRequests} = await read({runs: [run({status, conclusion: null})]})

        expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'running'}})
        expect(apiRequests()).toHaveLength(1)
      },
    )

    it('reports a run without exactly one job as unknown / job-missing', async () => {
      expect((await read({jobs: []})).observation).toMatchObject({detail: {reason: 'job-missing'}})
      const twoJobs = [realJobs.jobs[0], realJobs.jobs[0]]
      expect((await read({jobs: twoJobs})).observation).toMatchObject({detail: {reason: 'job-missing'}})
    })
  })

  describe('log problems', () => {
    it('retries once when the log is empty and uses the second read', async () => {
      const {observation, logApiRequests} = await read({logs: ['', runnerLog(probeLine())]})

      expect(observation.result).toBe('pass')
      expect(logApiRequests()).toHaveLength(1 + MONITOR_LOG_RETRY_BUDGET)
    })

    it('reports a log that is still empty after the retry as unknown / log-empty', async () => {
      const {observation, apiRequests, logApiRequests} = await read({logs: ['', '   \n']})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'log-empty'}})
      expect(logApiRequests()).toHaveLength(2)
      expect(apiRequests()).toHaveLength(MONITOR_API_CALL_BUDGET + MONITOR_LOG_RETRY_BUDGET)
    })

    it('reports a log with no probe line as unknown / no-probe-line without retrying', async () => {
      const {observation, logApiRequests} = await read({logs: [runnerLog('Run bun install', 'done')]})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'no-probe-line'}})
      expect(logApiRequests()).toHaveLength(1)
    })

    it('reports a log with only the summary line as unknown / no-probe-line', async () => {
      const summary =
        'CLIProxy auth monitor summary: probe=healthy reason=ok transition=none issue=none discord=none at 2026-11-01T22:56:01.220Z'
      const {observation} = await read({logs: [runnerLog(summary)]})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'no-probe-line'}})
    })

    it('rejects a log with two probe lines', async () => {
      const {observation} = await read({logs: [runnerLog(probeLine('healthy', 'ok'), probeLine('dead', 'auth-401'))]})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'multiple-probe-lines'}})
    })

    it.each([
      ['an unknown state', probeLine('broken', 'ok')],
      ['an unrecognized reason', probeLine('dead', 'new-surprise')],
      ['a malformed line', 'CLIProxy auth monitor probe: garbage'],
    ])('reports %s as unknown / malformed-probe-line', async (_label, line) => {
      const {observation} = await read({logs: [runnerLog(line)]})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'malformed-probe-line'}})
    })

    it('never copies log text, URLs or issue fields into the observation', async () => {
      const hostile = `${probeLine()} issue=https://github.com/marcusrbrown/infra/issues/1 discord=https://discord.example.invalid/api/webhooks/1/secret`
      const {observation} = await read({logs: [runnerLog(hostile)]})
      const text = JSON.stringify(observation)

      expect(text).not.toContain('discord')
      expect(text).not.toContain('issues/1')
      expect(text).not.toContain('secret')
      expect(observationSchema.safeParse(observation).success).toBe(true)
    })
  })

  describe('transport', () => {
    it('uses 3 API calls on the normal path and never sends the token to the signed log URL', async () => {
      const {requests, apiRequests} = await read()

      expect(apiRequests()).toHaveLength(MONITOR_API_CALL_BUDGET)
      expect(requests).toHaveLength(MONITOR_API_CALL_BUDGET + 1)
      const logRequest = requests.find(request => request.url.pathname.endsWith('/logs'))
      expect(logRequest?.redirect).toBe('manual')
      for (const request of apiRequests()) {
        expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
        expect(request.url.href).not.toContain(TOKEN)
      }
      const blob = requests.find(request => request.url.href === SIGNED_LOG_URL)
      expect(blob?.headers.get('authorization')).toBeNull()
    })

    it('never makes more than the stated budget, even when the log keeps coming back empty', async () => {
      const {requests} = await read({logs: ['']})

      // runs, jobs, log redirect, signed-URL read, then one retry of the last two.
      expect(requests).toHaveLength(MONITOR_API_CALL_BUDGET + MONITOR_LOG_RETRY_BUDGET + 2)
    })

    it('accepts a direct 200 log without a redirect', async () => {
      const github = fakeGitHub()
      const direct = async (input: string, init?: RequestInit) =>
        new URL(input).pathname.endsWith('/logs') ? new Response(runnerLog(probeLine())) : github.fetchFn(input, init)
      const [observation] = await readMonitorState({token: TOKEN, fetch: direct, now: NOW})

      expect(observation?.result).toBe('pass')
    })

    it('refuses a non-https redirect target', async () => {
      const github = fakeGitHub()
      const downgraded = async (input: string, init?: RequestInit) =>
        new URL(input).pathname.endsWith('/logs')
          ? new Response(null, {status: 302, headers: {location: 'http://logs.example.invalid/x'}})
          : github.fetchFn(input, init)
      const [observation] = await readMonitorState({token: TOKEN, fetch: downgraded, now: NOW})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'api-error'}})
    })

    it.each([
      ['a 403 on the run list', {runsStatus: 403}],
      ['a 500 on the run list', {runsStatus: 500}],
      ['a 500 on the jobs read', {jobsStatus: 500}],
      ['a 404 on the log read', {logStatus: 404}],
      ['a 500 on the signed log URL', {blobStatus: 500}],
      ['a network error on the run list', {throwOn: 'runs'}],
      ['a network error on the jobs read', {throwOn: 'jobs'}],
      ['a network error on the log read', {throwOn: 'logs'}],
      ['a network error on the signed log URL', {throwOn: 'blob'}],
    ] as [string, Scenario][])('reports %s as unknown / api-error', async (_label, scenario) => {
      const {observation} = await read(scenario)

      expect(observation).toMatchObject({result: 'unknown', source: 'monitor', detail: {reason: 'api-error'}})
      expect(observationSchema.safeParse(observation).success).toBe(true)
      expect(JSON.stringify(observation)).not.toContain(TOKEN)
    })
  })

  describe('missing token', () => {
    it.each([undefined, '', '  '])('reports not_measured / config for %p without any request', async token => {
      const {observation, goObservation, requests} = await readWithToken({}, token)

      expect(requests).toHaveLength(0)
      expect(observation).toEqual({
        id: 'provider-route',
        kind: 'end-to-end',
        source: 'config',
        result: 'not_measured',
        observedAt: null,
        detail: {reason: 'missing-config'},
      })
      expect(goObservation).toEqual({
        id: 'provider-route-go',
        kind: 'end-to-end',
        source: 'config',
        result: 'not_measured',
        observedAt: null,
        detail: {reason: 'missing-config'},
      })
    })
  })

  it('always returns an observation that validates against the contract', async () => {
    const scenarios: Scenario[] = [
      {},
      {runs: []},
      {logs: ['']},
      {logs: [runnerLog(probeLine('dead', 'auth-401'))], runs: [run({conclusion: 'failure'})]},
      {runsStatus: 500},
    ]
    for (const scenario of scenarios) {
      expect(observationSchema.safeParse((await read(scenario)).observation).success).toBe(true)
    }
  })
})
