import {existsSync} from 'node:fs'
import {dirname} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {createCapturedCtx, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {
  CAN_LOCK,
  controlPathOf,
  controlPaths,
  createScratchHost,
  detailBody,
  detailOutput,
  recordingSpawn,
  type CheckFixture,
  type ScratchHost,
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
import {
  CONTROL_PERSIST,
  DEPLOY_FINISHED_SENTINEL,
  DEPLOY_UNFINISHED_SENTINEL,
  ingestStateSentinel,
  LOCK_BUSY_SENTINEL,
  OPEN_REFUSED_SENTINEL,
  REMOTE_COMMANDS,
} from './remote'

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

/** The scripts take a real `flock`; where neither it nor `perl` (for the stand-in) exists, those cases skip. */
const requiresLock = CAN_LOCK ? it : it.skip

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
  write?: 'ok' | 'no-sentinel' | 'fail' | 'lock-busy' | 'refused'
  detail?: string
  detailExit?: number
  configured?: string
  /** What `readDeployState` prints. Default: finished. */
  deployState?: 'finished' | 'unfinished' | 'garbage'
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
      if (behaviour.write === 'lock-busy') return {stdout: `${LOCK_BUSY_SENTINEL}\n`, exitCode: 1}
      if (behaviour.write === 'refused') return {stdout: `${OPEN_REFUSED_SENTINEL}\n`, exitCode: 0}
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
    if (call.command === REMOTE_COMMANDS.readDeployState) {
      if (behaviour.deployState === 'garbage') return {stdout: 'what\n'}
      return {
        stdout: `${behaviour.deployState === 'unfinished' ? DEPLOY_UNFINISHED_SENTINEL : DEPLOY_FINISHED_SENTINEL}\n`,
      }
    }
    throw new Error(`unexpected remote command: ${call.command}`)
  })
}

/**
 * A host that runs the real remote scripts under `sh` against a scratch directory, so a refusal is proven by what
 * the script does with the deploy marker, the pending-restarts file and `.env`, not by a canned answer.
 */
function realHost(scratch: ScratchHost, detail: string = detailOutput(detailBody({checks: passingChecks}))) {
  return recordingSpawn((call: SpawnCall) => {
    if (call.command === REMOTE_COMMANDS.reporterDetail) return {stdout: detail}
    if (
      call.command === REMOTE_COMMANDS.writeIngestState('held') ||
      call.command === REMOTE_COMMANDS.writeIngestState('open') ||
      call.command === REMOTE_COMMANDS.readDeployState
    ) {
      return scratch.run(call.command, call.stdin)
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
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${controlPathOf(call?.argv ?? [])}`,
      '-o',
      `ControlPersist=${CONTROL_PERSIST}`,
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

  it('says so, and never says held, when the ingest lock is busy: the hold did not happen', async () => {
    const world = host({write: 'lock-busy'})
    const {fetchFn, calls} = publicEndpoint([503])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestHoldAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(calls).toHaveLength(0)
    expect(err(captured)).toContain('holds the host lock')
    expect(err(captured)).toContain('Ingest may still be open')
    expect(out(captured)).not.toContain('Ingest is held')
  })

  describe.each([
    ['the deploy marker', ['.deploy-in-progress']],
    ['the pending-restarts file', ['.pending-restarts']],
  ])('with %s on the host', (_label, files) => {
    const hosts: ScratchHost[] = []
    afterEach(() => {
      for (const scratch of hosts.splice(0)) scratch.cleanup()
    })

    requiresLock('is never refused: it holds and proves 503', async () => {
      const scratch = createScratchHost('A=1\nTRACES_INGEST_STATE=open\n')
      hosts.push(scratch)
      for (const file of files) scratch.touch(file)
      const world = realHost(scratch)
      const {fetchFn} = publicEndpoint([503])
      const {ctx, captured} = createCapturedCtx()
      await tracesIngestHoldAction({}, ctx, deps(world.spawn, fetchFn))
      expect(out(captured)).toContain('Ingest is held')
      expect(scratch.env()).toBe('A=1\nTRACES_INGEST_STATE=held\n')
      expect(captured.exit).toBeNull()
    })
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

  // A dead Grafana or Prometheus is the monitoring verdict. It must not keep an operator from opening healthy ingest.
  it('opens when only a monitoring check fails: the ingest verdict is what it reads', async () => {
    const detail = detailOutput(
      detailBody({
        ok: true,
        monitoringOk: false,
        checks: [
          {id: 'collector-health', status: 'pass', detail: 'collector reports healthy', scope: 'ingest'},
          {id: 'grafana-health', status: 'fail', detail: 'grafana is unhealthy (http-503)', scope: 'monitoring'},
          {id: 'prometheus-health', status: 'fail', detail: 'prometheus is not ready', scope: 'monitoring'},
        ],
      }),
    )
    const world = host({detail})
    const {fetchFn} = publicEndpoint([401])
    const {ctx, captured} = createCapturedCtx()
    await tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))
    expect(world.calls.map(call => call.command)).toContain(REMOTE_COMMANDS.writeIngestState('open'))
    expect(out(captured)).toContain('Ingest is open')
    expect(captured.exit).toBeNull()
  })

  it('names only the ingest checks when it refuses, even if monitoring fails too', async () => {
    const detail = detailOutput(
      detailBody({
        ok: false,
        monitoringOk: false,
        checks: [
          {id: 'langfuse-worker', status: 'fail', detail: 'langfuse worker is unhealthy (http-503)', scope: 'ingest'},
          {id: 'grafana-health', status: 'fail', detail: 'grafana is unhealthy (http-503)', scope: 'monitoring'},
        ],
      }),
    )
    const world = host({detail})
    const {ctx, captured} = createCapturedCtx()
    await expect(
      tracesIngestOpenAction({}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn)),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expect(err(captured)).toContain('langfuse-worker: langfuse worker is unhealthy (http-503)')
    expect(err(captured)).not.toContain('grafana-health')
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

  it('makes the deploy check inside the one locked write script: one ssh call, no separate check', async () => {
    const world = host()
    const {ctx} = createCapturedCtx()
    await tracesIngestOpenAction({}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn))
    const writes = world.calls.filter(call => call.command.includes('TRACES_INGEST_STATE_SET'))
    expect(writes).toHaveLength(1)
    expect(world.calls.every(call => call.command !== REMOTE_COMMANDS.readDeployState)).toBe(true)
    const script = writes[0]?.argv.at(-1) ?? ''
    expect(script).toBe(REMOTE_COMMANDS.writeIngestState('open'))
    expect(script).toContain('flock -w 30 9')
    expect(script).toContain('.deploy-in-progress')
    expect(script).toContain('.pending-restarts')
    expect(script.indexOf('flock -w 30 9')).toBeLessThan(script.indexOf('.deploy-in-progress'))
    expect(script.indexOf('.deploy-in-progress')).toBeLessThan(script.indexOf('mv "$t" .env'))
  })

  describe.each([
    ['the deploy marker', ['.deploy-in-progress']],
    ['the pending-restarts file', ['.pending-restarts']],
    ['both', ['.deploy-in-progress', '.pending-restarts']],
  ])('with %s on the host and a passing, fresh verdict', (_label, files) => {
    const hosts: ScratchHost[] = []
    afterEach(() => {
      for (const scratch of hosts.splice(0)) scratch.cleanup()
    })
    requiresLock('refuses, says to run the deploy to completion, and changes nothing', async () => {
      const scratch = createScratchHost()
      hosts.push(scratch)
      for (const file of files) scratch.touch(file)
      const world = realHost(scratch)
      const {fetchFn, calls} = publicEndpoint([401])
      const {ctx, captured} = createCapturedCtx()
      await expect(tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)

      expect(err(captured)).toContain('a deploy is running or did not finish')
      expect(err(captured)).toContain('Run the deploy to completion')
      expect(err(captured)).toContain('Nothing was changed')
      expect(err(captured)).not.toContain('--force')
      expect(out(captured)).not.toContain('Ingest is open')
      expect(captured.exit).toEqual({code: 1})
      expect(scratch.env()).toBe('FOO=bar\nTRACES_INGEST_STATE=held\n')
      expect(scratch.dockerCalls()).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  requiresLock('opens end to end when no deploy file exists', async () => {
    const scratch = createScratchHost()
    try {
      const world = realHost(scratch)
      const {fetchFn} = publicEndpoint([401])
      const {ctx, captured} = createCapturedCtx()
      await tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))
      expect(out(captured)).toContain('Ingest is open')
      expect(scratch.env()).toBe('FOO=bar\nTRACES_INGEST_STATE=open\n')
      expect(scratch.dockerCalls()).toHaveLength(1)
    } finally {
      scratch.cleanup()
    }
  })

  it('still refuses on a failing verdict first, before it touches the host lock', async () => {
    const detail = detailOutput(detailBody({ok: false, checks: [{id: 'tempo-ready', status: 'fail', detail: 'x'}]}))
    const scratch = createScratchHost()
    try {
      const world = realHost(scratch, detail)
      const {ctx, captured} = createCapturedCtx()
      await expect(
        tracesIngestOpenAction({}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn)),
      ).rejects.toBeInstanceOf(MockProcessExit)
      expect(err(captured)).toContain('health verdict is not passing')
      expect(world.calls.map(call => call.command)).toEqual([REMOTE_COMMANDS.reporterDetail])
    } finally {
      scratch.cleanup()
    }
  })

  it('reports a refusal the host sent as a refusal, and never as open or as an ssh failure', async () => {
    const world = host({write: 'refused'})
    const {fetchFn, calls} = publicEndpoint([401])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(err(captured)).toContain('a deploy is running or did not finish')
    expect(err(captured)).not.toContain('Could not set the ingest state')
    expect(calls).toHaveLength(0)
  })

  it('says the lock was busy, and that nothing changed, when the ingest lock is not free', async () => {
    const world = host({write: 'lock-busy'})
    const {fetchFn, calls} = publicEndpoint([401])
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesIngestOpenAction({}, ctx, deps(world.spawn, fetchFn))).rejects.toBeInstanceOf(MockProcessExit)
    expect(err(captured)).toContain('holds the host lock')
    expect(err(captured)).toContain('Nothing was changed')
    expect(err(captured)).not.toContain('a deploy is running or did not finish')
    expect(calls).toHaveLength(0)
  })

  it('does not take a refusal sentinel from a failed command', async () => {
    // Exit non-zero with the sentinel in the output is not a refusal: it is a failure to report as one.
    const world = recordingSpawn(call =>
      call.command === REMOTE_COMMANDS.reporterDetail
        ? {stdout: detailOutput(detailBody({checks: passingChecks}))}
        : {stdout: `${OPEN_REFUSED_SENTINEL}\n`, exitCode: 2},
    )
    const {ctx, captured} = createCapturedCtx()
    await expect(
      tracesIngestOpenAction({}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn)),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expect(err(captured)).toContain('Could not set the ingest state')
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
    expect(out(captured)).toContain('Deploy:                 finished')
    expect(world.calls.every(call => call.stdin === undefined)).toBe(true)
  })

  it.each([
    ['unfinished', 'Deploy:                 unfinished'],
    ['garbage', 'Deploy:                 unknown'],
  ] as const)('reports the deploy state %s', async (deployState, line) => {
    const world = host({configured: 'TRACES_INGEST_STATE=held\n', deployState})
    const {ctx, captured} = createCapturedCtx()
    await tracesIngestStatusAction({}, ctx, deps(world.spawn, publicEndpoint([503]).fetchFn))
    expect(out(captured)).toContain(line)
    if (deployState === 'unfinished') expect(out(captured)).toContain('run it to completion')
  })

  it('reads the deploy state from the host files, not from a canned answer', async () => {
    const scratch = createScratchHost('TRACES_INGEST_STATE=held\n')
    try {
      scratch.touch('.pending-restarts')
      const world = recordingSpawn(call => {
        if (call.command === REMOTE_COMMANDS.readIngestState) return {stdout: 'TRACES_INGEST_STATE=held\n'}
        if (call.command === REMOTE_COMMANDS.readDeployState) return scratch.run(call.command)
        return {stdout: detailOutput(detailBody({checks: passingChecks}))}
      })
      const {ctx, captured} = createCapturedCtx()
      await tracesIngestStatusAction({}, ctx, deps(world.spawn, publicEndpoint([503]).fetchFn))
      expect(out(captured)).toContain('Deploy:                 unfinished')
    } finally {
      scratch.cleanup()
    }
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

// ─── One multiplexed ssh connection per command ───────────────────────────────

function expectOneSharedConnection(world: ReturnType<typeof host>): void {
  const paths = controlPaths(world.calls)
  expect(paths).toHaveLength(1)
  const [path] = paths
  expect(path).toBeDefined()
  for (const call of world.calls) {
    expect(call.argv).toContain('ControlMaster=auto')
    expect(call.argv).toContain(`ControlPath=${path}`)
  }
  expect(world.closes).toHaveLength(1)
  expect(world.closes[0]?.controlPath).toBe(path)
  expect(world.closes[0]?.directoryExisted).toBe(true)
  expect(existsSync(dirname(path ?? ''))).toBe(false)
}

describe('ingest commands reach the host over one multiplexed ssh connection', () => {
  it('hold: one connection, closed once', async () => {
    const world = host()
    const {ctx} = createCapturedCtx()
    await tracesIngestHoldAction({}, ctx, deps(world.spawn, publicEndpoint([503]).fetchFn))
    expectOneSharedConnection(world)
  })

  it('open: the verdict read and the state write share a connection', async () => {
    const world = host()
    const {ctx} = createCapturedCtx()
    await tracesIngestOpenAction({}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn))
    expect(world.calls).toHaveLength(2)
    expectOneSharedConnection(world)
  })

  it('open refused on the verdict: the connection is still closed once', async () => {
    const world = host({detailExit: 1})
    const {ctx} = createCapturedCtx()
    await expect(
      tracesIngestOpenAction({}, ctx, deps(world.spawn, publicEndpoint([401]).fetchFn)),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expectOneSharedConnection(world)
  })

  it('status: the reads that run side by side share one connection', async () => {
    const world = host()
    const {ctx} = createCapturedCtx()
    await tracesIngestStatusAction({}, ctx, deps(world.spawn, publicEndpoint([503]).fetchFn))
    expect(world.calls).toHaveLength(3)
    expectOneSharedConnection(world)
  })

  it('status: the first read runs before the others start, so the master exists when they ask for it', async () => {
    const events: string[] = []
    const inner = host()
    const spawn: IngestDeps['spawn'] = (argv, options) => {
      if (!argv.includes('-O')) events.push(`start ${argv.at(-1)?.slice(0, 20)}`)
      const child = inner.spawn(argv, options)
      if (argv.includes('-O')) return child
      return {
        ...child,
        exited: child.exited.then(code => {
          events.push(`end ${argv.at(-1)?.slice(0, 20)}`)
          return code
        }),
      }
    }
    const {ctx} = createCapturedCtx()
    await tracesIngestStatusAction({}, ctx, deps(spawn, publicEndpoint([503]).fetchFn))
    expect(events[0]).toMatch(/^start /)
    expect(events[1]).toMatch(/^end /)
  })

  it('two runs use different ControlPaths', async () => {
    const first = host()
    const second = host()
    await tracesIngestHoldAction({}, createCapturedCtx().ctx, deps(first.spawn, publicEndpoint([503]).fetchFn))
    await tracesIngestHoldAction({}, createCapturedCtx().ctx, deps(second.spawn, publicEndpoint([503]).fetchFn))
    expect(controlPaths(first.calls)[0]).not.toBe(controlPaths(second.calls)[0])
  })

  it('closes once and removes the directory when the ssh call throws', async () => {
    const world = host()
    const throwing: IngestDeps['spawn'] = (argv, options) => {
      if (!argv.includes('-O') && argv.at(-1) === REMOTE_COMMANDS.writeIngestState('held')) {
        throw new Error('spawn ssh ENOENT')
      }
      return world.spawn(argv, options)
    }
    const {ctx} = createCapturedCtx()
    await expect(tracesIngestHoldAction({}, ctx, deps(throwing, publicEndpoint([503]).fetchFn))).rejects.toThrow(
      'spawn ssh ENOENT',
    )
    expect(world.closes).toHaveLength(1)
    expect(existsSync(dirname(world.closes[0]?.controlPath ?? ''))).toBe(false)
  })

  it('a refusal before any ssh (a bad host) makes no close', async () => {
    process.env.TRACES_OTHER = '-oProxyCommand=evil'
    const world = host()
    const {ctx} = createCapturedCtx()
    await expect(
      tracesIngestHoldAction({key: 'TRACES_OTHER'}, ctx, deps(world.spawn, publicEndpoint([503]).fetchFn)),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expect(world.closes).toHaveLength(0)
  })
})
