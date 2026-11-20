import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {createCapturedCtx, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {
  detailBody,
  detailOutput,
  recordingSpawn,
  type CheckFixture,
  type SpawnCall,
} from './__fixtures__/remote-fixture'
import {
  observedState,
  probeIngestPaths,
  tracesIngestHoldAction,
  tracesIngestOpenAction,
  tracesIngestStatusAction,
  type FetchLike,
  type IngestDeps,
} from './ingest'
import {ingestStateSentinel, REMOTE_COMMANDS} from './remote'

const ENV_KEYS = ['TRACES_HOST', 'TRACES_DOMAIN', 'TRACES_SSH_KEY', 'TRACES_OTHER'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  delete process.env.TRACES_SSH_KEY
  process.env.TRACES_HOST = 'host.example.invalid'
  process.env.TRACES_DOMAIN = 'traces.example.invalid'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const GROUPS = ['marcusrbrown', 'fro-bot', 'workstation']
const passingChecks: CheckFixture[] = [{id: 'collector-health', status: 'pass', detail: 'collector reports healthy'}]

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: unknown
}

/** A public endpoint that answers each call from a list of statuses (the last one repeats). `'down'` is unreachable. */
function publicEndpoint(statuses: readonly (number | 'down')[]) {
  const calls: FetchCall[] = []
  let round = 0
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body,
    })
    const status = statuses[Math.min(Math.floor(round / GROUPS.length), statuses.length - 1)]
    round += 1
    if (status === 'down' || status === undefined) throw new TypeError('connect failed')
    return new Response('', {status})
  }
  return {fetchFn, calls}
}

interface HostBehaviour {
  write?: 'ok' | 'no-sentinel' | 'fail'
  detail?: string
  detailExit?: number
  configured?: string
}

function host(behaviour: HostBehaviour = {}) {
  return recordingSpawn((call: SpawnCall) => {
    if (
      call.command === REMOTE_COMMANDS.writeIngestState('held') ||
      call.command === REMOTE_COMMANDS.writeIngestState('open')
    ) {
      const state = call.command === REMOTE_COMMANDS.writeIngestState('held') ? 'held' : 'open'
      if (behaviour.write === 'fail') return {stderr: 'docker: no such service', exitCode: 1}
      if (behaviour.write === 'no-sentinel') return {stdout: 'recreated\n', exitCode: 0}
      return {stdout: `Container caddy recreated\n${ingestStateSentinel(state)}\n`}
    }
    if (call.command === REMOTE_COMMANDS.reporterDetail) {
      return {
        stdout: behaviour.detail ?? detailOutput(detailBody({checks: passingChecks})),
        exitCode: behaviour.detailExit ?? 0,
      }
    }
    if (call.command === REMOTE_COMMANDS.readIngestState) {
      return {stdout: behaviour.configured ?? 'TRACES_INGEST_STATE=held\n'}
    }
    throw new Error(`unexpected remote command: ${call.command}`)
  })
}

function deps(
  spawn: IngestDeps['spawn'],
  fetchFn: FetchLike,
  extra: Partial<IngestDeps> = {},
): IngestDeps & {slept: number[]} {
  const slept: number[] = []
  return {
    spawn,
    fetch: fetchFn,
    attempts: 3,
    intervalMs: 5,
    sleep: async ms => {
      slept.push(ms)
    },
    ...extra,
    slept,
  }
}

const out = (captured: {stdout: string[]}) => captured.stdout.join('\n')
const err = (captured: {stderr: string[]}) => captured.stderr.join('\n')

// ─── Observing the public endpoint ────────────────────────────────────────────

describe('probeIngestPaths and observedState', () => {
  it('sends one unauthenticated empty POST to each group path, with no credential', async () => {
    const {fetchFn, calls} = publicEndpoint([503])
    const statuses = await probeIngestPaths('https://traces.example.invalid', fetchFn)
    expect(statuses).toEqual({marcusrbrown: 503, 'fro-bot': 503, workstation: 503})
    expect(calls.map(call => call.url).sort()).toEqual(
      GROUPS.map(group => `https://traces.example.invalid/${group}/v1/traces`).sort(),
    )
    for (const call of calls) {
      expect(call.method).toBe('POST')
      expect(call.body).toBe('{}')
      expect(Object.keys(call.headers).map(key => key.toLowerCase())).not.toContain('authorization')
    }
  })

  it('records an unreachable path as such', async () => {
    const {fetchFn} = publicEndpoint(['down'])
    expect(await probeIngestPaths('https://traces.example.invalid', fetchFn)).toEqual({
      marcusrbrown: 'unreachable',
      'fro-bot': 'unreachable',
      workstation: 'unreachable',
    })
  })

  it('names a state only when every path agrees: 404 off, 503 held, 401 open', () => {
    const all = (status: number | 'unreachable') => ({marcusrbrown: status, 'fro-bot': status, workstation: status})
    expect(observedState(all(404))).toBe('off')
    expect(observedState(all(503))).toBe('held')
    expect(observedState(all(401))).toBe('open')
    expect(observedState(all(200))).toBeUndefined()
    expect(observedState(all('unreachable'))).toBeUndefined()
    expect(observedState({...all(503), workstation: 401})).toBeUndefined()
  })
})

// ─── hold ─────────────────────────────────────────────────────────────────────

describe('traces ingest hold', () => {
  it('sets the state over ssh with the new line on stdin, recreating only Caddy, without asking the reporter', async () => {
    const world = host()
    const {fetchFn} = publicEndpoint([503])
    const {ctx, captured} = createCapturedCtx()
    await tracesIngestHoldAction({}, ctx, deps(world.spawn, fetchFn))

    expect(world.calls).toHaveLength(1)
    const call = world.calls[0]
    expect(call?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=10',
      ...buildKnownHostsArgs(),
      'root@host.example.invalid',
      REMOTE_COMMANDS.writeIngestState('held'),
    ])
    expect(call?.stdin).toBe('TRACES_INGEST_STATE=held\n')
    expect(call?.command).toContain('--force-recreate --no-deps caddy')
    // Not consulted: the reporter's verdict plays no part in a hold.
    expect(world.calls.some(entry => entry.command === REMOTE_COMMANDS.reporterDetail)).toBe(false)
    expect(out(captured)).toContain('Ingest is held')
    expect(captured.exit).toBeNull()
  })

  it('says held only after every ingest path answered 503 from outside', async () => {
    const world = host()
    const {fetchFn, calls} = publicEndpoint([503])
    const {ctx, captured} = createCapturedCtx()
    await tracesIngestHoldAction({}, ctx, deps(world.spawn, fetchFn))
    expect(calls).toHaveLength(3)
    expect(out(captured)).toContain('marcusrbrown 503')
  })

  it('waits out the Caddy restart: unreachable, then 503', async () => {
    const world = host()
    const {fetchFn} = publicEndpoint(['down', 502, 503])
    const {ctx, captured} = createCapturedCtx()
    const d = deps(world.spawn, fetchFn)
    await tracesIngestHoldAction({}, ctx, d)
    expect(out(captured)).toContain('Ingest is held')
    expect(d.slept).toHaveLength(2)
  })

  it.each([
    ['the route is still open (401)', 401],
    ['the route is off (404)', 404],
    ['the endpoint answers 200', 200],
    ['the endpoint is unreachable', 'down'],
  ] as const)('does not say held when %s', async (_label, status) => {
    const world = host()
    const {fetchFn, calls} = publicEndpoint([status])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestHoldAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(out(captured)).not.toContain('Ingest is held')
    expect(err(captured)).not.toContain('Ingest is held')
    expect(err(captured)).toContain('NOT confirmed')
    expect(calls).toHaveLength(9) // three paths, three attempts
    expect(captured.exit).toEqual({code: 1})
  })

  it('does not say held when one path is not 503', async () => {
    const world = host()
    let call = 0
    const fetchFn: FetchLike = async () => new Response('', {status: call++ % 3 === 2 ? 401 : 503})
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestHoldAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(out(captured)).not.toContain('Ingest is held')
  })

  it.each(['fail', 'no-sentinel'] as const)('stops without probing when the host command %s', async write => {
    const world = host({write})
    const {fetchFn, calls} = publicEndpoint([503])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestHoldAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(calls).toHaveLength(0)
    expect(out(captured)).not.toContain('Ingest is held')
    expect(err(captured)).toContain('Could not set the ingest state')
  })

  it('refuses a host starting with - before any ssh, and does not echo it', async () => {
    process.env.TRACES_OTHER = '-oProxyCommand=evil'
    const world = host()
    const {fetchFn, calls} = publicEndpoint([503])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestHoldAction({key: 'TRACES_OTHER'}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(
      MockProcessExit,
    )
    expect(world.calls).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(err(captured)).not.toContain('ProxyCommand')
  })

  it('refuses a bad TRACES_DOMAIN before any ssh', async () => {
    process.env.TRACES_DOMAIN = 'traces.example.invalid/evil'
    const world = host()
    const {fetchFn} = publicEndpoint([503])
    const {ctx} = createCapturedCtx()
    await expect(tracesIngestHoldAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(world.calls).toHaveLength(0)
  })
})

// ─── open ─────────────────────────────────────────────────────────────────────

describe('traces ingest open', () => {
  it('opens when the verdict is passing, and says open only after every path answers 401 from outside', async () => {
    const world = host()
    const {fetchFn, calls} = publicEndpoint([401])
    const {ctx, captured} = createCapturedCtx()
    await tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))

    expect(world.calls.map(call => call.command)).toEqual([
      REMOTE_COMMANDS.reporterDetail,
      REMOTE_COMMANDS.writeIngestState('open'),
    ])
    expect(world.calls[1]?.stdin).toBe('TRACES_INGEST_STATE=open\n')
    expect(calls).toHaveLength(3)
    expect(out(captured)).toContain('Ingest is open')
  })

  it.each([
    [
      'a failing check',
      detailOutput(
        detailBody({
          ok: false,
          checks: [{id: 'langfuse-worker', status: 'fail', detail: 'langfuse worker is unhealthy (http-503)'}],
        }),
      ),
      0,
    ],
    [
      'an unknown check',
      detailOutput(detailBody({ok: false, checks: [{id: 'tempo-ready', status: 'unknown', detail: 'no answer'}]})),
      0,
    ],
    ['a stale verdict', detailOutput(detailBody({ok: true, stale: true})), 0],
    ['no run yet', detailOutput(detailBody({ok: false, ran: false, checks: []})), 0],
    ['an unreadable answer', 'not json\n', 0],
    ['a failed exec', detailOutput(detailBody()), 1],
  ] as const)('refuses with %s, and changes nothing', async (_label, detail, detailExit) => {
    const world = host({detail, detailExit})
    const {fetchFn, calls} = publicEndpoint([401])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)

    // Only the read happened: no state write, no public probe.
    expect(world.calls.map(call => call.command)).toEqual([REMOTE_COMMANDS.reporterDetail])
    expect(world.calls.every(call => call.stdin === undefined)).toBe(true)
    expect(calls).toHaveLength(0)
    expect(out(captured)).not.toContain('Ingest is open')
    expect(err(captured)).toContain('Refusing to open ingest')
  })

  it('reports why the verdict is not passing', async () => {
    const detail = detailOutput(
      detailBody({
        ok: false,
        checks: [{id: 'langfuse-worker', status: 'fail', detail: 'langfuse worker is unhealthy (http-503)'}],
      }),
    )
    const world = host({detail})
    const {ctx, captured} = createCapturedCtx()
    await expect(
      tracesIngestOpenAction({}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn)),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expect(err(captured)).toContain('langfuse-worker: langfuse worker is unhealthy (http-503)')
  })

  it('does not say open when the public endpoint never asks for a token', async () => {
    const world = host()
    const {fetchFn} = publicEndpoint([503])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(out(captured)).not.toContain('Ingest is open')
    expect(err(captured)).toContain('NOT confirmed')
  })

  it('stops when the host command does not confirm', async () => {
    const world = host({write: 'no-sentinel'})
    const {fetchFn, calls} = publicEndpoint([401])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(calls).toHaveLength(0)
    expect(out(captured)).not.toContain('Ingest is open')
  })

  it('refuses a bad host before any ssh', async () => {
    process.env.TRACES_OTHER = '-oProxyCommand=evil'
    const world = host()
    const {ctx} = createCapturedCtx()
    await expect(
      tracesIngestOpenAction({key: 'TRACES_OTHER'}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn)),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expect(world.calls).toHaveLength(0)
  })
})

// ─── status ───────────────────────────────────────────────────────────────────

describe('traces ingest status', () => {
  it('shows the configured state, the observed state and the verdict, and exits cleanly when they agree', async () => {
    const world = host({configured: 'TRACES_INGEST_STATE=held\n'})
    const {ctx, captured} = createCapturedCtx()
    await tracesIngestStatusAction({}, ctx, deps(world.spawn, publicEndpoint([503]).fetchFn))
    expect(out(captured)).toContain('Configured on the host: held')
    expect(out(captured)).toContain('Seen from outside:      held')
    expect(out(captured)).toContain('Health verdict:         passing')
    expect(world.calls.every(call => call.stdin === undefined)).toBe(true)
  })

  it('exits 1 when the configured state is not what Caddy serves', async () => {
    const world = host({configured: 'TRACES_INGEST_STATE=held\n'})
    const {ctx, captured} = createCapturedCtx()
    await expect(
      tracesIngestStatusAction({}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn)),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expect(out(captured)).toContain('Seen from outside:      open')
  })

  it('exits 1 when the configured state cannot be read', async () => {
    const world = host({configured: 'garbage\n'})
    const {ctx, captured} = createCapturedCtx()
    await expect(
      tracesIngestStatusAction({}, ctx, deps(world.spawn, publicEndpoint([503]).fetchFn)),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expect(out(captured)).toContain('Configured on the host: unknown')
  })
})
