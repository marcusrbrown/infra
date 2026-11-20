/// <reference types="bun" />

/**
 * Behavior contract for the trace collection monitor.
 *
 * `fetch`, `gh`, the certificate reader and the clock are injected fakes: no test reaches the network, GitHub or
 * Discord, and no test runs the script's entrypoint. The fake GitHub keeps real state (labels, issues, this workflow's
 * run history) and honours the `state` and `labels` query of the issue list, so a test that expects an old closed
 * issue to be ignored proves the query, not only the filter.
 */

import type {GhResult, GhRunner} from './alert-issue'
import type {FetchLike} from './deploy-gate-notify'
import type {ProbeDeps} from './traces-monitor'
import {describe, expect, it} from 'bun:test'
import {
  ALERT_LABEL,
  buildDiscordContent,
  CERT_MIN_DAYS,
  HEALTH_MAX_AGE_MS,
  isValidDomain,
  lookupPreviousRun,
  planMonitor,
  PROBE_JOB_NAME,
  readMonitorEnv,
  REAL_MARKER,
  REHEARSAL_MARKER,
  runIssueStep,
  runNotifyStep,
  runProbe,
  verdictOf,
  WORKFLOW_FILE,
} from './traces-monitor'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WEBHOOK = 'https://discord.example/api/webhooks/1234567890/SECRET-token_value'
const REPO = 'marcusrbrown/infra'
const RUN_ID = 9_876_543_210
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN_ID}`
const RUNBOOK_URL = `https://github.com/${REPO}/blob/main/docs/runbooks/trace-collection.md`
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-20T12:00:00.000Z')

const iso = (date: Date): string => date.toISOString()
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000)
const daysAhead = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS)

function details(result: string, prefix = '- '): string[] {
  return [
    `${prefix}Workflow: Traces Monitor`,
    `${prefix}Run: ${RUN_URL}`,
    `${prefix}Probe job result: ${result}`,
    `${prefix}Runbook: ${RUNBOOK_URL}`,
  ]
}

function discordDetails(result: string, issue: number): string[] {
  const [workflow, run, outcome, runbook] = details(result, '')
  return [workflow ?? '', run ?? '', outcome ?? '', `Issue: https://github.com/${REPO}/issues/${issue}`, runbook ?? '']
}

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: String(RUN_ID),
    GITHUB_WORKFLOW: 'Traces Monitor',
    GITHUB_ACTOR: 'marcusrbrown',
    GITHUB_REPOSITORY_OWNER: 'marcusrbrown',
    ALERT_PROBE_RESULT: 'failure',
    ALERT_PROBE_DEPLOYED: 'true',
    ALERT_REHEARSE: 'none',
    ALERT_RUN_ATTEMPT: '1',
    ...overrides,
  }
}

// ─── Probe harness ───────────────────────────────────────────────────────────

interface ProbeScenario {
  readonly status?: number
  readonly body?: string
  readonly fetchError?: Error
  /** Resolves only when the request is aborted: a hung endpoint. */
  readonly hang?: boolean
  readonly certExpiry?: Date | Error
  /** TRACES_INGEST_OPEN, merged into the default environment. */
  readonly ingestOpen?: string
  /** The ingest path's answer; by default 404, which is healthy when ingest is not meant to be open. */
  readonly ingest?: {readonly status?: number; readonly error?: Error; readonly hang?: boolean; readonly body?: string}
  readonly environment?: Record<string, string | undefined>
}

function healthBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ok: true, at: iso(minutesAgo(1)), ...overrides})
}

async function probe(scenario: ProbeScenario = {}) {
  const allRequests: {url: string; init: RequestInit | undefined}[] = []
  const outputs: Record<string, string> = {}
  const logs: string[] = []
  const certHosts: string[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    allRequests.push({url: String(input), init})
    if (String(input).endsWith('/workstation/v1/traces')) {
      const ingest = scenario.ingest ?? {}
      if (ingest.error !== undefined) throw ingest.error
      if (ingest.hang === true) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      const ingestStatus = ingest.status ?? 404
      return new Response(ingestStatus === 204 || ingestStatus === 304 ? null : (ingest.body ?? 'no'), {
        status: ingestStatus,
      })
    }
    if (scenario.fetchError !== undefined) throw scenario.fetchError
    if (scenario.hang === true) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted https://traces.fro.bot/healthz')))
      })
    }
    const status = scenario.status ?? 200
    // A 204 or 304 cannot carry a body.
    const body = status === 204 || status === 304 ? null : (scenario.body ?? healthBody())
    return new Response(body, {status})
  }
  const deps: ProbeDeps = {
    fetch: fetchImpl,
    readCertificateExpiry: async host => {
      certHosts.push(host)
      const expiry = scenario.certExpiry ?? daysAhead(60)
      if (expiry instanceof Error) throw expiry
      return expiry
    },
    now: () => NOW,
    writeOutput: (name, value) => {
      outputs[name] = value
    },
    log: line => logs.push(line),
    appendSummary: line => logs.push(line),
    timeoutMs: 20,
  }
  const environment = scenario.environment ?? {
    TRACES_DOMAIN: 'traces.fro.bot',
    TRACES_INGEST_OPEN: scenario.ingestOpen,
  }
  const result = await runProbe(environment, deps)
  const requests = allRequests.filter(request => request.url.endsWith('/healthz'))
  const ingestRequests = allRequests.filter(request => request.url.endsWith('/workstation/v1/traces'))
  return {...result, requests, ingestRequests, allRequests, outputs, logs, certHosts}
}

// ─── Probe ───────────────────────────────────────────────────────────────────

describe('probe: the health path', () => {
  it('is healthy on a 200 with the boolean and a fresh timestamp, and probes once with no redirect followed', async () => {
    const run = await probe()

    expect(run).toMatchObject({exitCode: 0, verdict: 'healthy', reasons: []})
    expect(run.outputs).toEqual({deployed: 'true', urgent: 'false', categories: ''})
    expect(run.requests).toHaveLength(1)
    expect(run.requests[0]?.url).toBe('https://traces.fro.bot/healthz')
    expect(run.requests[0]?.init?.method).toBe('GET')
    expect(run.requests[0]?.init?.redirect).toBe('manual')
    expect(run.requests[0]?.init?.headers).toEqual({accept: 'application/json'})
    expect(run.certHosts).toEqual(['traces.fro.bot'])
  })

  it('sends no credential: no authorization header, no body', async () => {
    const run = await probe()
    const init = run.requests[0]?.init
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|token/i)
    expect(init?.body).toBeUndefined()
  })

  it('tolerates extra fields in the body', async () => {
    const run = await probe({body: healthBody({detail: 'x', checks: {a: 1}})})
    expect(run.verdict).toBe('healthy')
  })

  it('is unhealthy on a 503', async () => {
    const run = await probe({status: 503, body: 'unhealthy'})
    expect(run).toMatchObject({exitCode: 1, verdict: 'unhealthy', reasons: ['healthz-503']})
  })

  it.each([204, 301, 302, 401, 404, 429, 500, 502, 504])('is unhealthy on a %i', async status => {
    const run = await probe({status})
    expect(run.exitCode).toBe(1)
    expect(run.reasons).toEqual(['healthz-status'])
  })

  it('is unhealthy when the body says unhealthy, even on a 200', async () => {
    const run = await probe({body: healthBody({ok: false})})
    expect(run).toMatchObject({exitCode: 1, reasons: ['healthz-unhealthy']})
  })

  it.each([
    ['not JSON', 'ok'],
    ['an array', '[]'],
    ['no boolean', JSON.stringify({at: iso(minutesAgo(1))})],
    ['a string boolean', JSON.stringify({ok: 'true', at: iso(minutesAgo(1))})],
    ['no timestamp', JSON.stringify({ok: true})],
    ['a numeric timestamp', JSON.stringify({ok: true, at: Date.now()})],
    ['an unparsable timestamp', JSON.stringify({ok: true, at: 'T-yesterday'})],
    ['a timestamp from the future', JSON.stringify({ok: true, at: iso(new Date(NOW.getTime() + 10 * 60_000))})],
    ['an oversized body', JSON.stringify({ok: true, at: iso(minutesAgo(1)), pad: 'x'.repeat(5000)})],
    ['an empty body', ''],
  ])('is unhealthy on a body that is %s', async (_name, body) => {
    const run = await probe({body})
    expect(run).toMatchObject({exitCode: 1, reasons: ['healthz-body']})
  })

  // A frozen reporter keeps answering 200 with its last verdict. Only the timestamp gives it away.
  it('is unhealthy on a stale timestamp even when the boolean is true', async () => {
    const run = await probe({body: healthBody({at: iso(new Date(NOW.getTime() - HEALTH_MAX_AGE_MS - 1000))})})
    expect(run).toMatchObject({exitCode: 1, verdict: 'unhealthy', reasons: ['healthz-stale']})
  })

  it('accepts a timestamp exactly at the bound', async () => {
    const run = await probe({body: healthBody({at: iso(new Date(NOW.getTime() - HEALTH_MAX_AGE_MS))})})
    expect(run.verdict).toBe('healthy')
  })

  it('is unhealthy on a timeout, with the timeout reason and no error text', async () => {
    const run = await probe({hang: true})
    expect(run).toMatchObject({exitCode: 1, reasons: ['healthz-timeout']})
    expect(run.logs.join('\n')).not.toContain('aborted')
  })

  it('is unhealthy on a network or TLS error', async () => {
    const run = await probe({fetchError: new TypeError('unable to verify the first certificate for traces.fro.bot')})
    expect(run).toMatchObject({exitCode: 1, reasons: ['healthz-network']})
  })

  it('never writes the endpoint body, a header or an error message to any log line', async () => {
    const runs = [
      await probe({status: 503, body: 'SECRET-body detail: redis password is hunter2'}),
      await probe({body: 'SECRET-body not json'}),
      await probe({fetchError: new TypeError('connect ECONNREFUSED 203.0.113.7:443 SECRET-error')}),
      await probe({certExpiry: new Error('SECRET-cert-error')}),
    ]
    for (const run of runs) {
      const text = run.logs.join('\n')
      expect(run.exitCode).toBe(1)
      expect(text).not.toContain('SECRET')
      expect(text).not.toContain('hunter2')
      expect(text).not.toContain('ECONNREFUSED')
      expect(text).not.toContain('203.0.113.7')
    }
  })
})

describe('probe: the certificate', () => {
  it('is unhealthy when the certificate expires in under 14 days, even if the health path is fine', async () => {
    const run = await probe({certExpiry: daysAhead(CERT_MIN_DAYS - 1)})
    expect(run).toMatchObject({exitCode: 1, verdict: 'unhealthy', reasons: ['cert-expiring']})
  })

  it('accepts a certificate with exactly 14 days left', async () => {
    const run = await probe({certExpiry: daysAhead(CERT_MIN_DAYS)})
    expect(run.verdict).toBe('healthy')
  })

  it('is unhealthy on an already expired certificate', async () => {
    const run = await probe({certExpiry: daysAhead(-1)})
    expect(run.reasons).toEqual(['cert-expiring'])
  })

  it('is unhealthy when no valid certificate can be read, and still reports the health path', async () => {
    const run = await probe({certExpiry: new Error('self signed'), status: 503})
    expect(run.exitCode).toBe(1)
    expect(run.reasons.sort()).toEqual(['cert-unreadable', 'healthz-503'])
  })

  it('treats an unparsable expiry as unreadable', async () => {
    const run = await probe({certExpiry: new Date('not a date')})
    expect(run.reasons).toEqual(['cert-unreadable'])
  })
})

describe('probe: the ingest state', () => {
  const INGEST_URL = 'https://traces.fro.bot/workstation/v1/traces'

  it('sends one unauthenticated POST of an empty JSON body, with no redirect followed', async () => {
    const run = await probe()

    expect(run.ingestRequests).toHaveLength(1)
    const init = run.ingestRequests[0]?.init
    expect(run.ingestRequests[0]?.url).toBe(INGEST_URL)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{}')
    expect(init?.redirect).toBe('manual')
    expect(init?.headers).toEqual({'content-type': 'application/json'})
    expect(JSON.stringify(init?.headers).toLowerCase()).not.toMatch(/authorization|bearer|token/)
    expect(init?.signal).toBeDefined()
  })

  describe('when the variable says ingest is open', () => {
    it('is healthy on a 401', async () => {
      const run = await probe({ingestOpen: 'true', ingest: {status: 401}})
      expect(run).toMatchObject({exitCode: 0, verdict: 'healthy', urgent: false, categories: []})
    })

    // Mutation target: reading a 401 as unhealthy when ingest is open fails this.
    it.each([503, 404, 200, 202, 400, 403, 500, 302])('is unhealthy on a %i, by the two-runs rule', async status => {
      const run = await probe({ingestOpen: 'true', ingest: {status}})

      expect(run).toMatchObject({
        exitCode: 1,
        reasons: ['ingest-unexpected-status'],
        urgent: false,
        categories: ['ingest'],
      })
      expect(run.outputs).toEqual({deployed: 'true', urgent: 'false', categories: 'ingest'})
    })

    it('is unhealthy on a timeout and on a network error, with fixed reasons', async () => {
      const hung = await probe({ingestOpen: 'true', ingest: {hang: true}})
      expect(hung).toMatchObject({exitCode: 1, reasons: ['ingest-timeout'], urgent: false})

      const down = await probe({ingestOpen: 'true', ingest: {error: new TypeError('ECONNREFUSED SECRET-ingest')}})
      expect(down).toMatchObject({exitCode: 1, reasons: ['ingest-network'], urgent: false})
      expect(down.logs.join('\n')).not.toContain('SECRET')
    })
  })

  describe('when the variable says ingest is not open, or says nothing', () => {
    it.each([404, 503])('is healthy on a %i', async status => {
      const run = await probe({ingest: {status}})
      expect(run).toMatchObject({exitCode: 0, verdict: 'healthy', urgent: false})
    })

    it.each([401, 200, 201, 202, 204, 299])(
      'alerts at once on a %i: the route is open when it should not be',
      async status => {
        const run = await probe({ingest: {status}})

        expect(run).toMatchObject({
          exitCode: 1,
          verdict: 'unhealthy',
          reasons: ['ingest-open-unexpected'],
          urgent: true,
          categories: ['ingest'],
        })
        expect(run.outputs).toEqual({deployed: 'true', urgent: 'true', categories: 'ingest'})
        expect(run.logs.join('\n')).toContain('(urgent)')
      },
    )

    it.each([400, 403, 405, 413, 429, 500, 502, 302])('is unhealthy but not urgent on a %i', async status => {
      const run = await probe({ingest: {status}})
      expect(run).toMatchObject({exitCode: 1, reasons: ['ingest-unexpected-status'], urgent: false})
    })

    it('is unhealthy but not urgent on a timeout', async () => {
      const run = await probe({ingest: {hang: true}})
      expect(run).toMatchObject({exitCode: 1, reasons: ['ingest-timeout'], urgent: false})
    })

    it.each([undefined, '', 'false', 'True', 'TRUE', '1', 'yes', 'open'])(
      'reads the variable %j as not open',
      async value => {
        const run = await probe({ingestOpen: value, ingest: {status: 401}})
        expect(run).toMatchObject({urgent: true, reasons: ['ingest-open-unexpected']})
      },
    )
  })

  it('names every failing condition by its fixed category word, in a fixed order, and nothing else', async () => {
    const run = await probe({
      status: 503,
      body: 'SECRET-health-body',
      certExpiry: daysAhead(3),
      ingestOpen: 'true',
      ingest: {status: 200, body: 'SECRET-ingest-body'},
    })

    expect(run.exitCode).toBe(1)
    expect(run.categories).toEqual(['health', 'certificate', 'ingest'])
    expect(run.outputs.categories).toBe('health,certificate,ingest')
    expect(run.logs.join('\n')).not.toContain('SECRET')
  })

  it('never reads or logs the ingest response body', async () => {
    const run = await probe({ingest: {status: 401, body: 'SECRET-ingest-body {"error":"unauthorized"}'}})
    expect(run.logs.join('\n')).not.toContain('SECRET')
  })

  it('probes nothing at all while the stack is not deployed yet', async () => {
    const run = await probe({environment: {TRACES_DOMAIN: '', TRACES_INGEST_OPEN: 'true'}})
    expect(run.allRequests).toEqual([])
  })
})

describe('probe: not deployed yet', () => {
  it.each([undefined, '', '   '])(
    'exits green with a notice and probes nothing when TRACES_DOMAIN is %j',
    async value => {
      const run = await probe({environment: {TRACES_DOMAIN: value}})

      expect(run).toMatchObject({exitCode: 0, verdict: 'not-deployed', reasons: []})
      expect(run.outputs).toEqual({deployed: 'false', urgent: 'false', categories: ''})
      expect(run.requests).toEqual([])
      expect(run.certHosts).toEqual([])
      expect(run.logs.some(line => line.startsWith('::notice::') && line.includes('not deployed'))).toBe(true)
      expect(run.logs.some(line => line.includes('::error::'))).toBe(false)
    },
  )

  it.each([
    'traces.fro.bot/../x',
    'TRACES.fro.bot',
    'a b.example',
    '-x.example',
    'localhost',
    'traces.fro.bot:443',
    'user@traces.fro.bot',
    'traces.fro.bot.',
    `${'a'.repeat(64)}.example`,
  ])('refuses the hostname %j before it reaches a URL', async host => {
    const run = await probe({environment: {TRACES_DOMAIN: host}})

    expect(run).toMatchObject({exitCode: 1, verdict: 'unhealthy', reasons: ['invalid-domain']})
    expect(run.allRequests).toEqual([])
    expect(run.certHosts).toEqual([])
  })

  it('accepts the documented value', () => {
    expect(isValidDomain('traces.fro.bot')).toBe(true)
  })
})

// ─── Decision ────────────────────────────────────────────────────────────────

describe('verdictOf', () => {
  it.each([
    ['failure', 'true', 'unhealthy'],
    ['failure', '', 'unhealthy'],
    ['cancelled', '', 'unhealthy'],
    ['skipped', '', 'skipped'],
    ['success', 'true', 'healthy'],
    ['success', 'false', 'not-deployed'],
  ] as const)('maps probe %s with deployed=%j to %s', (probeResult, deployed, verdict) => {
    expect(verdictOf({probeResult, deployed})).toBe(verdict)
  })

  it('refuses a green probe that did not say whether it probed anything', () => {
    expect(() => verdictOf({probeResult: 'success', deployed: ''})).toThrow()
  })
})

describe('planMonitor', () => {
  it('needs two unhealthy runs in a row to alert', () => {
    expect(planMonitor({verdict: 'unhealthy', rehearse: 'none'}, 'unhealthy')).toEqual({
      kind: 'alert',
      identity: 'real',
    })
    expect(planMonitor({verdict: 'unhealthy', rehearse: 'none'}, 'healthy')).toEqual({kind: 'none'})
    expect(planMonitor({verdict: 'unhealthy', rehearse: 'none'}, 'unknown')).toEqual({kind: 'none'})
  })

  // Mutation target: making the urgent case wait for a second unhealthy run fails these.
  it('alerts at once for an urgent unhealthy run, whatever the run before it was', () => {
    for (const previous of ['healthy', 'unhealthy', 'unknown'] as const) {
      expect(planMonitor({verdict: 'unhealthy', rehearse: 'none', urgent: true}, previous)).toEqual({
        kind: 'alert',
        identity: 'real',
      })
    }
  })

  it('ignores the urgent flag on anything but an unhealthy run', () => {
    expect(planMonitor({verdict: 'healthy', rehearse: 'none', urgent: true}, 'unknown')).toEqual({
      kind: 'clear',
      identity: 'real',
    })
    expect(planMonitor({verdict: 'not-deployed', rehearse: 'none', urgent: true}, 'unknown')).toEqual({kind: 'none'})
  })

  it('clears on a healthy run and does nothing for not-deployed or skipped', () => {
    expect(planMonitor({verdict: 'healthy', rehearse: 'none'}, 'unhealthy')).toEqual({kind: 'clear', identity: 'real'})
    expect(planMonitor({verdict: 'not-deployed', rehearse: 'none'}, 'unhealthy')).toEqual({kind: 'none'})
    expect(planMonitor({verdict: 'skipped', rehearse: 'none'}, 'unhealthy')).toEqual({kind: 'none'})
  })

  it('uses the rehearsal identity whatever the probe said', () => {
    for (const verdict of ['healthy', 'unhealthy', 'not-deployed', 'skipped'] as const) {
      expect(planMonitor({verdict, rehearse: 'fail'}, 'healthy')).toEqual({kind: 'alert', identity: 'rehearsal'})
      expect(planMonitor({verdict, rehearse: 'clear'}, 'unhealthy')).toEqual({kind: 'clear', identity: 'rehearsal'})
    }
  })
})

describe('readMonitorEnv', () => {
  it('rejects values outside the known sets rather than guessing', () => {
    expect(() => readMonitorEnv(baseEnv({ALERT_PROBE_RESULT: 'timed_out'}))).toThrow()
    expect(() => readMonitorEnv(baseEnv({ALERT_PROBE_RESULT: ''}))).toThrow()
    expect(() => readMonitorEnv(baseEnv({ALERT_PROBE_DEPLOYED: 'yes'}))).toThrow()
    expect(() => readMonitorEnv(baseEnv({ALERT_REHEARSE: 'maybe'}))).toThrow()
    expect(() => readMonitorEnv(baseEnv({GITHUB_RUN_ID: ''}))).toThrow()
  })

  it('reads an empty rehearsal input (a scheduled run) as none', () => {
    expect(readMonitorEnv(baseEnv({ALERT_REHEARSE: ''})).rehearse).toBe('none')
    expect(readMonitorEnv(baseEnv({ALERT_REHEARSE: undefined})).rehearse).toBe('none')
  })
})

// ─── GitHub fake ─────────────────────────────────────────────────────────────

interface FakeIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: string[]
  pull_request?: unknown
}

interface FakeJob {
  name: string
  conclusion: string | null
}

interface FakeRun {
  id: number
  event: string
  updated_at: string
  conclusion?: string | null
  jobs: FakeJob[]
}

interface GhCall {
  readonly args: readonly string[]
  readonly stdin: string | undefined
  readonly method: string
}

interface FakeGhOptions {
  readonly labels?: readonly string[]
  readonly runs?: FakeRun[]
  readonly fail?: (call: GhCall) => GhResult | undefined
}

function fakeGh(initial: FakeIssue[], options: FakeGhOptions = {}) {
  const issues = [...initial]
  const labels = new Set(options.labels ?? [])
  const runs = options.runs ?? []
  const calls: GhCall[] = []
  let nextNumber = Math.max(100, ...issues.map(issue => issue.number + 1))
  let nextId = 5000
  const ok = (stdout: string): GhResult => ({code: 0, stdout, stderr: ''})

  const gh: GhRunner = async (args, stdin) => {
    const methodIndex = args.indexOf('--method')
    const method = methodIndex === -1 ? 'GET' : (args[methodIndex + 1] ?? 'GET')
    const call: GhCall = {args, stdin, method}
    calls.push(call)
    const forced = options.fail?.(call)
    if (forced !== undefined) return forced

    const path = args.at(-1) ?? ''
    const body = stdin === undefined ? {} : (JSON.parse(stdin) as Record<string, unknown>)

    if (method === 'GET' && path.includes(`/actions/workflows/${WORKFLOW_FILE}/runs?`)) {
      return ok(
        JSON.stringify({
          total_count: runs.length,
          workflow_runs: runs.map(run => ({
            id: run.id,
            event: run.event,
            status: 'completed',
            conclusion: run.conclusion ?? 'success',
            updated_at: run.updated_at,
          })),
        }),
      )
    }
    const jobList = /\/actions\/runs\/(\d+)\/jobs\?/.exec(path)
    if (method === 'GET' && jobList !== null) {
      const run = runs.find(candidate => candidate.id === Number(jobList[1]))
      if (run === undefined) return {code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)'}
      return ok(JSON.stringify({total_count: run.jobs.length, jobs: run.jobs}))
    }

    if (method === 'GET' && args.includes('--paginate')) {
      const query = new URLSearchParams(path.split('?')[1] ?? '')
      const state = query.get('state') ?? 'open'
      const label = query.get('labels')
      const matched = issues.filter(
        issue => (state === 'all' || issue.state === state) && (label === null || issue.labels.includes(label)),
      )
      const pages: FakeIssue[][] = []
      for (let index = 0; index < matched.length; index += 2) pages.push(matched.slice(index, index + 2))
      return ok(JSON.stringify(pages.length === 0 ? [[]] : pages.map(page => page.map(toApiIssue))))
    }
    const labelProbe = /^repos\/[^/]+\/[^/]+\/labels\/(.+)$/.exec(path)
    if (method === 'GET' && labelProbe !== null) {
      return labels.has(decodeURIComponent(labelProbe[1] ?? ''))
        ? ok('HTTP/2.0 200 OK\n')
        : {code: 1, stdout: 'HTTP/2.0 404 Not Found\n', stderr: 'gh: Not Found (HTTP 404)'}
    }
    if (method === 'POST' && /\/labels$/.test(path)) {
      labels.add(String(body.name))
      return ok(JSON.stringify({id: nextId++, name: body.name}))
    }
    if (method === 'POST' && /\/issues$/.test(path)) {
      const number = nextNumber++
      issues.push({
        number,
        title: String(body.title),
        body: String(body.body),
        state: 'open',
        labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
      })
      return ok(
        JSON.stringify({number, id: nextId++, state: 'open', html_url: `https://github.com/${REPO}/issues/${number}`}),
      )
    }
    const comment = /\/issues\/(\d+)\/comments$/.exec(path)
    if (method === 'POST' && comment !== null) {
      return ok(JSON.stringify({id: nextId++, html_url: `https://github.com/${REPO}/issues/${comment[1]}#c`}))
    }
    const patch = /\/issues\/(\d+)$/.exec(path)
    if (method === 'PATCH' && patch !== null) {
      const issue = issues.find(candidate => candidate.number === Number(patch[1]))
      if (issue === undefined) return {code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)'}
      if (typeof body.body === 'string') issue.body = body.body
      if (body.state !== undefined) issue.state = body.state === 'closed' ? 'closed' : 'open'
      return ok(JSON.stringify({number: issue.number, state: issue.state}))
    }
    return {code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}`}
  }

  return {
    gh,
    calls,
    issues,
    labels,
    runs,
    writes: () => calls.filter(call => call.method !== 'GET'),
    payloads: () => calls.flatMap(call => (call.stdin === undefined ? [] : [call.stdin])),
    comments: () =>
      calls
        .filter(call => /\/comments$/.test(call.args.at(-1) ?? ''))
        .map(call => ({
          issue: Number(/issues\/(\d+)\/comments$/.exec(call.args.at(-1) ?? '')?.[1]),
          body: String((JSON.parse(call.stdin ?? '{}') as {body?: unknown}).body),
        })),
  }
}

function toApiIssue(issue: FakeIssue): unknown {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(name => ({name})),
    ...(issue.pull_request === undefined ? {} : {pull_request: issue.pull_request}),
  }
}

function realIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number: 7,
    title: 'Trace collection stack is unhealthy',
    body: `${REAL_MARKER}\nolder text`,
    state: 'open',
    labels: [ALERT_LABEL],
    ...overrides,
  }
}

function rehearsalIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return realIssue({
    number: 8,
    title: '[Rehearsal] Trace collection stack alert',
    body: `${REHEARSAL_MARKER}\nolder rehearsal`,
    ...overrides,
  })
}

let nextRunId = 1000
function probedRun(conclusion: string | null, overrides: Partial<FakeRun> = {}): FakeRun {
  nextRunId += 1
  return {
    id: nextRunId,
    event: 'schedule',
    updated_at: iso(minutesAgo(15)),
    jobs: [
      {name: PROBE_JOB_NAME, conclusion},
      {name: 'Alert on trace collection failure', conclusion: 'success'},
    ],
    ...overrides,
  }
}

/** A previous run whose probe was unhealthy, and one whose probe was healthy. */
const previousUnhealthy = (): FakeRun => probedRun('failure')
const previousHealthy = (): FakeRun => probedRun('success')

interface IssueRun {
  readonly exitCode: number
  readonly outputs: Record<string, string>
  readonly logs: string[]
}

async function issueStep(
  overrides: Record<string, string | undefined>,
  fake: ReturnType<typeof fakeGh>,
): Promise<IssueRun> {
  const outputs: Record<string, string> = {}
  const logs: string[] = []
  const result = await runIssueStep(baseEnv(overrides), {
    gh: fake.gh,
    writeOutput: (name, value) => {
      outputs[name] = value
    },
    log: line => logs.push(line),
    appendSummary: line => logs.push(line),
    now: () => NOW,
  })
  return {exitCode: result.exitCode, outputs, logs}
}

interface Delivery {
  readonly calls: {url: string; body: string}[]
  readonly logs: string[]
  readonly summary: Awaited<ReturnType<typeof runNotifyStep>>
}

async function notifyStep(
  overrides: Record<string, string | undefined>,
  responder: (call: number) => Response = () => new Response(null, {status: 204}),
): Promise<Delivery> {
  const calls: {url: string; body: string}[] = []
  const logs: string[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({url: String(input), body: String(init?.body ?? '')})
    return responder(calls.length)
  }
  const summary = await runNotifyStep(
    baseEnv({
      ALERT_NOTIFY: 'created',
      ALERT_ISSUE_NUMBER: '101',
      CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: WEBHOOK,
      ...overrides,
    }),
    {
      fetch: fetchImpl,
      sleep: async () => {},
      log: line => logs.push(line),
      appendSummary: line => logs.push(line),
      timeoutMs: 20,
    },
  )
  return {calls, logs, summary}
}

// ─── Issue step: flap control ────────────────────────────────────────────────

describe('issue step: a healthy probe', () => {
  it('does nothing, and writes nothing, when the probe is healthy and no issue is open', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousHealthy()]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'success'}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.writes()).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
    // A healthy run never needs the history.
    expect(fake.calls.some(call => /actions\//.test(call.args.at(-1) ?? ''))).toBe(false)
  })

  it('comments, closes and asks for one recovery message on the first healthy run', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'success'}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.comments()).toEqual([
      {
        issue: 7,
        body: ['The health probe is healthy again, so this issue is closed.', '', ...details('success')].join('\n'),
      },
    ])
    expect(fake.issues[0]?.state).toBe('closed')
    expect(run.outputs).toEqual({notify: 'recovered', 'issue-number': '7'})
    expect(fake.writes().map(call => call.method)).toEqual(['POST', 'PATCH'])
  })

  it('leaves an open rehearsal issue alone', async () => {
    const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'success'}, fake)

    expect(fake.issues[0]?.state).toBe('open')
    expect(fake.writes()).toEqual([])
    expect(run.outputs.notify).toBe('none')
  })
})

describe('issue step: an unhealthy probe', () => {
  // Mutation target: dropping the "previous run was unhealthy" condition makes this open an issue.
  it('opens nothing on the first unhealthy run and says why', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousHealthy()]})
    const run = await issueStep({}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.writes()).toEqual([])
    expect(fake.issues).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
    expect(run.logs.some(line => line.startsWith('::notice::') && line.includes('two in a row'))).toBe(true)
  })

  it('opens nothing when there is no earlier run at all', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: []})
    const run = await issueStep({}, fake)

    expect(fake.writes()).toEqual([])
    expect(run.outputs.notify).toBe('none')
  })

  it('opens one labelled, marked issue on the second unhealthy run and asks for one Discord message', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep({}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.issues).toHaveLength(1)
    expect(fake.issues[0]?.labels).toEqual([ALERT_LABEL])
    expect(fake.issues[0]?.title).toBe('Trace collection stack is unhealthy')
    expect(fake.issues[0]?.body?.startsWith(`${REAL_MARKER}\n`)).toBe(true)
    expect(run.outputs).toEqual({notify: 'created', 'issue-number': '100'})
  })

  it('writes this exact issue body', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    await issueStep({}, fake)

    expect(fake.issues[0]?.body).toBe(
      [
        REAL_MARKER,
        'The trace collection stack failed its health probe on two runs in a row. Senders may be losing traces. Open the run for which check failed, then follow the runbook (docs/runbooks/trace-collection.md).',
        '',
        ...details('failure'),
        '',
        'This issue closes when a probe is healthy again.',
      ].join('\n'),
    )
  })

  it('treats a cancelled probe (the reported result of a timeout) as unhealthy', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'cancelled', ALERT_PROBE_DEPLOYED: ''}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.issues[0]?.body).toContain('- Probe job result: cancelled')
  })

  it('stays quiet while the outage continues: no comment, no message, the same issue number', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep({}, fake)

    expect(fake.issues).toHaveLength(1)
    expect(fake.writes()).toEqual([])
    expect(run.outputs).toEqual({notify: 'none', 'issue-number': '7'})
  })

  it('opens a new issue for a new outage and never reopens a closed one', async () => {
    const fake = fakeGh([realIssue({state: 'closed'})], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep({}, fake)

    expect(fake.issues).toHaveLength(2)
    expect(fake.issues.find(issue => issue.number === 7)?.state).toBe('closed')
    expect(run.outputs.notify).toBe('created')
    expect(fake.writes().some(call => call.method === 'PATCH')).toBe(false)
  })

  it('does not treat a labelled issue without the marker, or a pull request, as ours', async () => {
    const fake = fakeGh([realIssue({number: 3, body: 'by hand'}), realIssue({number: 4, pull_request: {url: 'x'}})], {
      labels: [ALERT_LABEL],
      runs: [previousUnhealthy()],
    })
    const run = await issueStep({}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.comments()).toEqual([])
  })

  it('creates the label on first use when it does not exist', async () => {
    const fake = fakeGh([], {runs: [previousUnhealthy()]})
    await issueStep({}, fake)

    expect(fake.labels.has(ALERT_LABEL)).toBe(true)
  })

  it('fails the job when the issue API fails, so a broken alert path is a red run', async () => {
    const fake = fakeGh([], {
      labels: [ALERT_LABEL],
      runs: [previousUnhealthy()],
      fail: call => (call.method === 'POST' ? {code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 500)'} : undefined),
    })
    const run = await issueStep({}, fake)

    expect(run.exitCode).toBe(1)
    expect(run.logs.join('\n')).toContain('::error::')
    expect(run.logs.join('\n')).not.toContain('Server Error')
  })
})

describe('issue step: the ingest state', () => {
  const urgent = {ALERT_PROBE_URGENT: 'true', ALERT_PROBE_CATEGORIES: 'ingest'}
  const ingestOrdinary = {ALERT_PROBE_URGENT: 'false', ALERT_PROBE_CATEGORIES: 'ingest'}
  const historyCalls = (fake: ReturnType<typeof fakeGh>): number =>
    fake.calls.filter(call => /actions\//.test(call.args.at(-1) ?? '')).length

  // Mutation target: making the at-once case wait for a second run fails this.
  it('opens an issue at once for an urgent run, with no earlier run and no history lookup', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousHealthy()]})
    const run = await issueStep(urgent, fake)

    expect(run.exitCode).toBe(0)
    expect(run.outputs).toEqual({notify: 'created', 'issue-number': '100'})
    expect(fake.issues).toHaveLength(1)
    expect(historyCalls(fake)).toBe(0)
    expect(fake.issues[0]?.body).toBe(
      [
        REAL_MARKER,
        'The ingest route answered a request that carried no token while ingest is not meant to be open. This alert was raised at once, without waiting for a second run. Follow the runbook (docs/runbooks/trace-collection.md).',
        '',
        ...details('failure'),
        '- Failing checks: ingest',
        `- Ingest open unexpectedly: first seen in ${RUN_URL}`,
        '',
        'This issue closes when a probe is healthy again.',
      ].join('\n'),
    )
  })

  it('does not open a second issue when one is already open: it adds one line to that issue, once', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})

    const first = await issueStep(urgent, fake)
    expect(first.outputs).toEqual({notify: 'none', 'issue-number': '7'})
    expect(fake.issues).toHaveLength(1)
    expect(fake.comments()).toEqual([])
    expect(fake.writes().map(call => call.method)).toEqual(['PATCH'])
    expect(fake.issues[0]?.body).toBe(
      `${REAL_MARKER}\nolder text\n- Ingest open unexpectedly: first seen in ${RUN_URL}`,
    )
    expect(fake.issues[0]?.state).toBe('open')

    // Every later urgent run finds the line and writes nothing.
    const second = await issueStep(urgent, fake)
    expect(second.outputs).toEqual({notify: 'none', 'issue-number': '7'})
    expect(fake.writes()).toHaveLength(1)
    expect(historyCalls(fake)).toBe(0)
  })

  it('leaves an open issue that already carries the line untouched', async () => {
    const annotated = realIssue({body: `${REAL_MARKER}\n- Ingest open unexpectedly: first seen in https://example/run`})
    const fake = fakeGh([annotated], {labels: [ALERT_LABEL]})
    await issueStep(urgent, fake)

    expect(fake.writes()).toEqual([])
  })

  it('fails the job when the annotation write is not confirmed', async () => {
    const fake = fakeGh([realIssue()], {
      labels: [ALERT_LABEL],
      fail: call => (call.method === 'PATCH' ? {code: 0, stdout: '{}', stderr: ''} : undefined),
    })
    expect((await issueStep(urgent, fake)).exitCode).toBe(1)
  })

  it('needs two runs for an ordinary ingest failure: the first strike opens nothing', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousHealthy()]})
    const run = await issueStep(ingestOrdinary, fake)

    expect(fake.writes()).toEqual([])
    expect(run.outputs.notify).toBe('none')
  })

  it('opens the issue on the second ordinary ingest failure and names the category', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep(ingestOrdinary, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.issues[0]?.body).toContain('- Failing checks: ingest')
    expect(fake.issues[0]?.body).toContain('failed its health probe on two runs in a row')
  })

  it('names several failing conditions by their fixed words', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    await issueStep({ALERT_PROBE_URGENT: 'false', ALERT_PROBE_CATEGORIES: 'health,certificate,ingest'}, fake)

    expect(fake.issues[0]?.body).toContain('- Failing checks: health, certificate, ingest')
  })

  it('ignores the urgent flag on a healthy probe, which clears, and in a rehearsal, which uses its own identity', async () => {
    const healthy = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const cleared = await issueStep({...urgent, ALERT_PROBE_RESULT: 'success'}, healthy)
    expect(cleared.outputs.notify).toBe('recovered')

    const rehearsal = fakeGh([], {labels: [ALERT_LABEL]})
    await issueStep(
      {...urgent, ALERT_REHEARSE: 'fail', ALERT_PROBE_RESULT: 'skipped', ALERT_PROBE_DEPLOYED: ''},
      rehearsal,
    )
    expect(rehearsal.issues[0]?.body).toContain('**Rehearsal.**')
    expect(rehearsal.issues[0]?.body).not.toContain('Failing checks')
    expect(rehearsal.issues[0]?.body).not.toContain('answered a request')
  })

  it('a re-run makes no API call even for an urgent result', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({...urgent, ALERT_RUN_ATTEMPT: '2'}, fake)

    expect(fake.calls).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })

  it('refuses a malformed urgent flag or category list rather than guessing', async () => {
    for (const bad of [
      {ALERT_PROBE_URGENT: 'yes'},
      {ALERT_PROBE_CATEGORIES: 'health,<script>'},
      {ALERT_PROBE_CATEGORIES: 'ingest,'},
    ]) {
      const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
      const run = await issueStep(bad, fake)
      expect(run.exitCode).toBe(1)
      expect(fake.calls).toEqual([])
    }
  })

  it('posts the urgent message once, with a fixed sentence and the category word', async () => {
    const run = await notifyStep({...urgent})
    const content = (JSON.parse(run.calls[0]?.body ?? '{}') as {content: string}).content

    expect(content).toBe(
      [
        '**Trace collection stack unhealthy**',
        'The ingest route answered a request that carried no token while ingest is not meant to be open. This alert was raised at once, without waiting for a second run. Check it now.',
        ...discordDetails('failure', 101).slice(0, 3),
        'Failing checks: ingest',
        ...discordDetails('failure', 101).slice(3),
      ].join('\n'),
    )
  })

  it('carries no response text: only the fixed words reach any written text', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    await issueStep({...urgent, INGEST_RESPONSE: 'SECRET-ingest-body'}, fake)
    const delivered = await notifyStep({...urgent, INGEST_RESPONSE: 'SECRET-ingest-body'})

    expect([...fake.payloads(), ...delivered.calls.map(call => call.body)].join('\n')).not.toContain('SECRET')
  })

  it('one outage with an urgent ingest route, end to end: opens at once, stays quiet, closes on recovery', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousHealthy()]})
    const posts: string[] = []

    async function tick(env: Record<string, string>): Promise<IssueRun> {
      const issue = await issueStep(env, fake)
      const delivered = await notifyStep({
        ...env,
        ALERT_NOTIFY: issue.outputs.notify,
        ALERT_ISSUE_NUMBER: issue.outputs['issue-number'],
      })
      posts.push(...delivered.calls.map(call => call.body))
      return issue
    }

    await tick(urgent)
    expect(fake.issues).toHaveLength(1)
    expect(posts).toHaveLength(1)

    await tick(urgent)
    await tick(urgent)
    expect(fake.issues).toHaveLength(1)
    expect(fake.writes().filter(call => call.method === 'PATCH')).toHaveLength(0)
    expect(posts).toHaveLength(1)

    await tick({ALERT_PROBE_RESULT: 'success'})
    expect(fake.issues[0]?.state).toBe('closed')
    expect(posts).toHaveLength(2)
  })
})

describe('issue step: not deployed yet', () => {
  // Mutation target: treating the unset variable as unhealthy makes this alert.
  it('does nothing at all, even with an unhealthy history, so the unset variable never alerts', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'success', ALERT_PROBE_DEPLOYED: 'false'}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.calls).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })

  it('leaves an open issue as it is', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'success', ALERT_PROBE_DEPLOYED: 'false'}, fake)

    expect(fake.calls).toEqual([])
    expect(fake.issues[0]?.state).toBe('open')
    expect(run.outputs.notify).toBe('none')
  })

  it('does nothing when the probe was skipped', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'skipped', ALERT_PROBE_DEPLOYED: ''}, fake)

    expect(fake.calls).toEqual([])
    expect(run.outputs.notify).toBe('none')
  })

  it('fails the job on a green probe that did not say whether it probed anything', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'success', ALERT_PROBE_DEPLOYED: ''}, fake)

    expect(run.exitCode).toBe(1)
    expect(fake.calls).toEqual([])
  })
})

// A re-run replays the first attempt's probe result, which can be older than the current outage.
describe('issue step: a re-run never updates the alert', () => {
  it.each(['2', '3', '12'])('makes no API call and requests no notification on attempt %s', async attempt => {
    for (const result of ['success', 'failure', 'cancelled'] as const) {
      const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
      const run = await issueStep({ALERT_PROBE_RESULT: result, ALERT_RUN_ATTEMPT: attempt}, fake)

      expect(run.exitCode).toBe(0)
      expect(fake.calls).toEqual([])
      expect(fake.issues[0]?.state).toBe('open')
      expect(run.outputs).toEqual({notify: 'none'})
      expect(run.logs.some(line => line.startsWith('::notice::A re-run does not update'))).toBe(true)
    }
  })

  it.each([undefined, '', 'two', '0', '1.5', '99999'])('treats the attempt value %j as a re-run', async attempt => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep({ALERT_PROBE_RESULT: 'success', ALERT_RUN_ATTEMPT: attempt}, fake)

    expect(fake.calls).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })

  it('applies to rehearsals too', async () => {
    const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'fail', ALERT_RUN_ATTEMPT: '2'}, fake)

    expect(fake.calls).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })
})

// ─── Previous run ────────────────────────────────────────────────────────────

describe('previous run lookup', () => {
  const context = readMonitorEnv(baseEnv())

  it('reads the conclusion of the probe JOB, not of the run', async () => {
    // The alert step failed (run red) but the probe was healthy: not an unhealthy strike.
    const run = probedRun('success', {conclusion: 'failure'})
    run.jobs = [
      {name: PROBE_JOB_NAME, conclusion: 'success'},
      {name: 'Alert on trace collection failure', conclusion: 'failure'},
    ]
    const fake = fakeGh([], {runs: [run]})

    expect(await lookupPreviousRun(context, fake.gh, NOW)).toBe('healthy')
  })

  it.each([
    ['success', 'healthy'],
    ['failure', 'unhealthy'],
    ['cancelled', 'unhealthy'],
    ['timed_out', 'unhealthy'],
  ] as const)('maps a probe conclusion of %s to %s', async (conclusion, expected) => {
    const fake = fakeGh([], {runs: [probedRun(conclusion)]})
    expect(await lookupPreviousRun(context, fake.gh, NOW)).toBe(expected)
  })

  it('steps over runs that did not probe (a rehearsal, a run still going) and reads the one before', async () => {
    const oldest = probedRun('success', {id: 1001})
    const failed = probedRun('failure', {id: 1002})
    const rehearsal = probedRun('skipped', {id: 1003})
    const running = probedRun(null, {id: 1004})

    // Listed in any order: the lookup sorts by id itself, newest first.
    expect(await lookupPreviousRun(context, fakeGh([], {runs: [oldest, failed, rehearsal, running]}).gh, NOW)).toBe(
      'unhealthy',
    )
    expect(await lookupPreviousRun(context, fakeGh([], {runs: [running, rehearsal, oldest]}).gh, NOW)).toBe('healthy')
  })

  it('ignores the current run and any run created after it', async () => {
    const newer = probedRun('failure', {id: RUN_ID + 5})
    const current = probedRun('failure', {id: RUN_ID})
    const older = probedRun('success', {id: RUN_ID - 1})
    const fake = fakeGh([], {runs: [newer, current, older]})

    expect(await lookupPreviousRun(context, fake.gh, NOW)).toBe('healthy')
  })

  it('ignores runs of other triggers', async () => {
    const fake = fakeGh([], {runs: [probedRun('failure', {event: 'pull_request'}), probedRun('success')]})
    expect(await lookupPreviousRun(context, fake.gh, NOW)).toBe('healthy')
  })

  it('is unknown when the previous run is older than an hour: a gap in the schedule is not consecutive', async () => {
    const fake = fakeGh([], {runs: [probedRun('failure', {updated_at: iso(minutesAgo(61))})]})
    expect(await lookupPreviousRun(context, fake.gh, NOW)).toBe('unknown')
  })

  it('is unknown when there is no history', async () => {
    expect(await lookupPreviousRun(context, fakeGh([]).gh, NOW)).toBe('unknown')
  })

  it('asks for completed runs of this workflow on main only, and never writes', async () => {
    const fake = fakeGh([], {runs: [probedRun('failure')]})
    await lookupPreviousRun(context, fake.gh, NOW)

    const listing = fake.calls[0]?.args.at(-1) ?? ''
    expect(listing).toContain(`actions/workflows/${WORKFLOW_FILE}/runs`)
    expect(listing).toContain('status=completed')
    expect(listing).toContain('branch=main')
    expect(fake.writes()).toEqual([])
  })

  it('fails the step, not silently healthy, when the history cannot be read', async () => {
    const down = fakeGh([realIssue()], {
      labels: [ALERT_LABEL],
      fail: call => (/actions\//.test(call.args.at(-1) ?? '') ? {code: 1, stdout: '', stderr: 'boom'} : undefined),
    })
    const run = await issueStep({}, down)
    expect(run.exitCode).toBe(1)
    expect(down.writes()).toEqual([])

    const malformed = fakeGh([], {
      fail: call =>
        /actions\//.test(call.args.at(-1) ?? '') ? {code: 0, stdout: '{"workflow_runs": 5}', stderr: ''} : undefined,
    })
    expect((await issueStep({}, malformed)).exitCode).toBe(1)
  })
})

// ─── Rehearsal ───────────────────────────────────────────────────────────────

describe('issue step: rehearsal', () => {
  it('is owner-only and refuses before any API call', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'fail', GITHUB_ACTOR: 'someone-else'}, fake)

    expect(run.exitCode).toBe(1)
    expect(fake.calls).toEqual([])
  })

  it('opens a marked rehearsal issue without consulting the history, whatever the probe did', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'fail', ALERT_PROBE_RESULT: 'skipped', ALERT_PROBE_DEPLOYED: ''}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.issues[0]?.title).toBe('[Rehearsal] Trace collection stack alert')
    expect(fake.issues[0]?.body?.startsWith(`${REHEARSAL_MARKER}\n`)).toBe(true)
    expect(fake.issues[0]?.body).not.toContain(REAL_MARKER)
    expect(fake.issues[0]?.body).toContain('- Probe job result: failure (rehearsal; no probe ran)')
    expect(fake.calls.some(call => /actions\//.test(call.args.at(-1) ?? ''))).toBe(false)
  })

  it('comments on an open rehearsal issue when rehearsed again, with no second Discord message', async () => {
    const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'fail', ALERT_PROBE_RESULT: 'skipped', ALERT_PROBE_DEPLOYED: ''}, fake)

    expect(run.outputs).toEqual({notify: 'none', 'issue-number': '8'})
    expect(fake.comments()[0]?.body).toContain('Rehearsal')
  })

  it('closes the rehearsal issue on a clear and leaves a real alert issue alone', async () => {
    const fake = fakeGh([rehearsalIssue(), realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep(
      {ALERT_REHEARSE: 'clear', ALERT_PROBE_RESULT: 'skipped', ALERT_PROBE_DEPLOYED: ''},
      fake,
    )

    expect(fake.issues.find(issue => issue.number === 8)?.state).toBe('closed')
    expect(fake.issues.find(issue => issue.number === 7)?.state).toBe('open')
    expect(run.outputs).toEqual({notify: 'recovered', 'issue-number': '8'})
  })

  it('never lets an open rehearsal issue absorb a real outage', async () => {
    const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const run = await issueStep({}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.comments()).toEqual([])
  })
})

// ─── Discord ─────────────────────────────────────────────────────────────────

describe('notify step', () => {
  it('posts nothing when no message was asked for', async () => {
    const run = await notifyStep({ALERT_NOTIFY: 'none'})

    expect(run.calls).toEqual([])
    expect(run.summary.outcome).toBe('skipped')
  })

  it('posts the outage message once, with mentions off and embeds suppressed', async () => {
    const run = await notifyStep({})

    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]?.url).toBe(WEBHOOK)
    const payload = JSON.parse(run.calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(payload.allowed_mentions).toEqual({parse: []})
    expect(payload.flags).toBe(4)
    expect(payload.content).toBe(
      [
        '**Trace collection stack unhealthy**',
        'The health probe failed on two runs in a row. Senders may be losing traces. Check it now.',
        ...discordDetails('failure', 101),
      ].join('\n'),
    )
  })

  it('posts the recovery message', async () => {
    const run = await notifyStep({ALERT_NOTIFY: 'recovered', ALERT_PROBE_RESULT: 'success', ALERT_ISSUE_NUMBER: '7'})

    const content = (JSON.parse(run.calls[0]?.body ?? '{}') as {content: string}).content
    expect(content).toBe(
      [
        '**Trace collection stack recovered**',
        'The health probe is healthy again. The alert issue is closed.',
        ...discordDetails('success', 7),
      ].join('\n'),
    )
  })

  it('marks a rehearsal message', async () => {
    const run = await notifyStep({ALERT_REHEARSE: 'fail'})

    const content = (JSON.parse(run.calls[0]?.body ?? '{}') as {content: string}).content
    expect(content.startsWith('**[REHEARSAL] Trace collection stack unhealthy**')).toBe(true)
    expect(content).toContain('Rehearsal: nothing was probed and nothing is wrong.')
  })

  it('skips with a log line, and does not fail, when the webhook is unset or blank', async () => {
    for (const webhook of [undefined, '', '   ']) {
      const run = await notifyStep({CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: webhook})
      expect(run.calls).toEqual([])
      expect(run.summary).toMatchObject({outcome: 'skipped', reason: 'webhook-unset'})
    }
  })

  it('never writes the webhook or the response text to any log line', async () => {
    const outcomes = [
      await notifyStep({}),
      await notifyStep({}, () => new Response(`echo ${WEBHOOK}`, {status: 500})),
      await notifyStep({CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: 'not a url'}),
    ]
    for (const run of outcomes) {
      const text = run.logs.join('\n')
      expect(text).not.toContain(WEBHOOK)
      expect(text).not.toContain('SECRET-token_value')
      expect(text).not.toContain('echo')
    }
  })
})

// ─── Content ─────────────────────────────────────────────────────────────────

describe('content is built from fixed strings and the github context only', () => {
  it('carries nothing from the endpoint, the probe log or the environment beyond the run link and the runbook path', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    await issueStep(
      {
        PROBE_ERROR: 'redis password is hunter2',
        HEALTH_DETAIL: 'worker down: langfuse-worker',
        TRACES_DOMAIN: 'traces.fro.bot',
        GH_TOKEN: 'ghs_secrettoken',
        CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: WEBHOOK,
      },
      fake,
    )
    const delivered = await notifyStep({})

    const written = [...fake.payloads(), ...delivered.calls.map(call => call.body)].join('\n')
    for (const forbidden of ['hunter2', 'langfuse-worker', 'ghs_secrettoken', 'SECRET-token_value', 'traces.fro.bot']) {
      expect(written).not.toContain(forbidden)
    }
    expect(written).toContain('docs/runbooks/trace-collection.md')
  })

  it('refuses a malformed run id, repository or server URL instead of building a link from it', () => {
    expect(() => readMonitorEnv(baseEnv({GITHUB_RUN_ID: '123 @everyone](http://evil.example)'}))).toThrow()
    expect(() => readMonitorEnv(baseEnv({GITHUB_REPOSITORY: 'a/b](http://evil.example)'}))).toThrow()
    expect(() => readMonitorEnv(baseEnv({GITHUB_SERVER_URL: 'http://github.com'}))).toThrow()
  })

  it('keeps mention, markup and link characters in the free-text workflow name out of every message', () => {
    const env = readMonitorEnv(baseEnv({GITHUB_WORKFLOW: 'Traces Monitor @everyone <@1234> [x](http://evil.example)'}))
    for (const kind of ['created', 'recovered'] as const) {
      const content = buildDiscordContent(kind, env, 12)
      expect(content).not.toMatch(/[@<>[\]()]/)
      expect(content).not.toContain('://evil')
      expect(content.length).toBeLessThan(1900)
    }
  })
})

// ─── Composition ─────────────────────────────────────────────────────────────

describe('one outage, end to end', () => {
  it('opens on the second unhealthy run, stays quiet, closes on the first healthy one, and posts to Discord twice', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const posts: string[] = []

    // Each scheduled run: the probe job's conclusion is recorded in the history for the NEXT run to read.
    async function tick(probeResult: 'success' | 'failure'): Promise<IssueRun> {
      const id = RUN_ID + fake.runs.length + 1
      const issue = await issueStep({GITHUB_RUN_ID: String(id), ALERT_PROBE_RESULT: probeResult}, fake)
      const delivered = await notifyStep({
        GITHUB_RUN_ID: String(id),
        ALERT_PROBE_RESULT: probeResult,
        ALERT_NOTIFY: issue.outputs.notify,
        ALERT_ISSUE_NUMBER: issue.outputs['issue-number'],
      })
      posts.push(...delivered.calls.map(call => call.body))
      fake.runs.unshift(probedRun(probeResult, {id, updated_at: iso(minutesAgo(1))}))
      return issue
    }
    // Run ids must exceed those already in the history, so start the history below the first tick.
    fake.runs.push(probedRun('success', {id: RUN_ID, updated_at: iso(minutesAgo(15))}))

    await tick('success')
    expect(fake.issues).toHaveLength(0)

    await tick('failure') // first strike
    expect(fake.issues).toHaveLength(0)
    expect(posts).toHaveLength(0)

    await tick('failure') // second strike: the issue opens
    expect(fake.issues).toHaveLength(1)
    expect(posts).toHaveLength(1)

    await tick('failure')
    await tick('failure')
    expect(fake.issues).toHaveLength(1)
    expect(fake.comments()).toEqual([])
    expect(posts).toHaveLength(1)

    await tick('success') // first healthy run: closes
    expect(fake.issues[0]?.state).toBe('closed')
    expect(posts).toHaveLength(2)

    await tick('success')
    expect(posts).toHaveLength(2)

    // A single blip after recovery is a first strike again.
    await tick('failure')
    expect(fake.issues).toHaveLength(1)
    expect(posts).toHaveLength(2)
  })

  it('keeps the issue work done when Discord fails', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL], runs: [previousUnhealthy()]})
    const issue = await issueStep({}, fake)
    const delivered = await notifyStep(
      {ALERT_NOTIFY: issue.outputs.notify, ALERT_ISSUE_NUMBER: issue.outputs['issue-number']},
      () => new Response('', {status: 429}),
    )

    expect(issue.exitCode).toBe(0)
    expect(fake.issues).toHaveLength(1)
    expect(delivered.summary.outcome).toBe('failed')
  })
})
