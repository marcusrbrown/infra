import type {AppId} from '../status/observation'
import type {SnapshotDependencies} from './status-snapshot'
import {chmod, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stripVTControlCharacters} from 'node:util'

import {APPS_NOT_YET_DEPLOYED} from '@marcusrbrown/infra-shared/status/history-schema'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'
import {goke} from 'goke'

import {createCapturedCtx} from '../lib/mcp-ctx-fixture'
import {readDeployStates} from '../status/deploy-state'
import {historyAppFileSchema, historyMetaSchema, loadHistory, recordByApp, writeHistory} from '../status/history'
import {readMonitorState} from '../status/monitor-state'
import {APP_IDS} from '../status/observation'
import {probeVpn} from '../status/public-probes'
import {
  deployObservation,
  FIXED_NOW,
  goRouteObservation,
  makeStatusDependencies,
  probeObservation,
  routeObservation,
  vpnProbeObservation,
} from './__fixtures__/status-dependencies'
import {MCP_ALLOWLIST} from './mcp'
import {registerStatus} from './status'
import {resolveRunIdentity, statusSnapshotAction} from './status-snapshot'

const TOKEN = 'ghs_snapshot_token_must_never_leak'
const HOUR = 3_600_000
const DAY = 24 * HOUR

type Env = Record<string, string | undefined>

const APP_NAMES: readonly string[] = APP_IDS

function snapshotDeps(overrides: Partial<SnapshotDependencies> = {}): SnapshotDependencies {
  const {publicProbes, readDeployStates: deploy, readMonitorState: monitor, now} = makeStatusDependencies()
  return {publicProbes, readDeployStates: deploy, readMonitorState: monitor, now, ...overrides}
}

function vpnProbeDeps(probe: NonNullable<SnapshotDependencies['publicProbes']['vpn']>): SnapshotDependencies {
  const base = snapshotDeps()
  return {...base, publicProbes: {...base.publicProbes, vpn: probe}}
}

function runEnv(run: string, attempt = '1', extra: Env = {}): Env {
  return {GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, ...extra}
}

async function readFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(dir, {recursive: true})) {
    if ((await stat(join(dir, entry))).isFile()) out[entry] = await readFile(join(dir, entry), 'utf8')
  }
  return out
}

describe('status snapshot', () => {
  let dir: string
  let history: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'status-snapshot-'))
    history = join(dir, 'history')
  })

  afterEach(async () => {
    await chmod(join(history, 'apps'), 0o700).catch(() => undefined)
    await rm(dir, {recursive: true, force: true})
  })

  async function run(
    options: {bootstrap?: boolean; now?: string; history?: string} = {},
    config: {deps?: SnapshotDependencies; env?: Env} = {},
  ) {
    const {ctx, captured} = createCapturedCtx()
    try {
      await statusSnapshotAction(
        {history: options.history ?? history, ...options},
        ctx,
        config.deps ?? snapshotDeps(),
        config.env ?? runEnv('1001'),
        // These tests are about the sampling mechanism, so no app is hidden; the hidden-app tests are further down.
        [],
      )
    } catch (error) {
      if (captured.exit === null) throw error
    }
    return captured
  }

  async function vpnSample(deps: SnapshotDependencies, env: Env) {
    const captured = await run({bootstrap: true}, {deps, env})
    const files = await readFiles(history)
    const vpn = historyAppFileSchema.parse(JSON.parse(files[join('apps', 'vpn.json')] ?? '[]'))
    return {captured, files, sample: vpn[0]}
  }

  it('bootstraps an empty directory with one sample per app, printing counts only', async () => {
    const captured = await run({bootstrap: true})

    expect(captured.exit).toBeNull()
    expect(captured.stderr).toEqual([])
    expect(captured.stdout).toHaveLength(4)
    expect(captured.stdout[0]).toBe(
      'samples: keeweb=1 cliproxy=1 gateway=1 umami=1 dashboard=1 vpn=1 broker=1 traces=1',
    )
    expect(captured.stdout[1]).toBe('added: 8')
    expect(captured.stdout[2]).toBe('trimmed: 0')
    expect(captured.stdout[3]).toMatch(/^bytes: \d+$/)

    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.meta).toEqual({schemaVersion: 1, lastSampleAt: FIXED_NOW.toISOString()})
    for (const app of APP_IDS) expect(loaded?.apps[app]).toHaveLength(1)
  })

  it('writes the observed results as short codes with run, attempt and sample time', async () => {
    await run({bootstrap: true}, {env: runEnv('4242', '3')})

    const keeweb = historyAppFileSchema.parse(JSON.parse(await readFile(join(history, 'apps', 'keeweb.json'), 'utf8')))
    const cliproxy = historyAppFileSchema.parse(
      JSON.parse(await readFile(join(history, 'apps', 'cliproxy.json'), 'utf8')),
    )
    const vpn = historyAppFileSchema.parse(JSON.parse(await readFile(join(history, 'apps', 'vpn.json'), 'utf8')))

    expect(keeweb).toEqual([
      {
        t: FIXED_NOW.toISOString(),
        run: '4242',
        att: 3,
        r: {'public-reachability': 'p', 'deploy-state': 'p'},
        d: {'public-reachability': {statusCode: 200}},
      },
    ])
    expect(Object.keys(cliproxy[0]?.r ?? {})).toEqual([
      'public-reachability',
      'deploy-state',
      'provider-route',
      'provider-route-go',
    ])
    // Only the observations this command measures: the VPN's TCP reachability and its deploy state, no end-to-end route.
    expect(Object.keys(vpn[0]?.r ?? {})).toEqual(['public-reachability', 'deploy-state'])
  })

  describe('vpn TCP reachability (the address is sensitive)', () => {
    // TEST-NET-3 (RFC 5737): never a real address.
    const ADDRESS = '203.0.113.7'
    const OTHER_ADDRESS = '203.0.113.9'

    it('hands the probe VPN_PROBE_HOST, and never VPN_HOST', async () => {
      const seen: unknown[] = []
      await vpnSample(
        vpnProbeDeps(async options => {
          seen.push(options)
          return probeObservation()
        }),
        runEnv('1001', '1', {VPN_PROBE_HOST: ADDRESS, VPN_HOST: OTHER_ADDRESS}),
      )
      expect(seen).toEqual([{host: ADDRESS}])

      seen.length = 0
      await rm(history, {recursive: true, force: true})
      await vpnSample(
        vpnProbeDeps(async options => {
          seen.push(options)
          return probeObservation()
        }),
        runEnv('1002', '1', {VPN_HOST: OTHER_ADDRESS}),
      )
      expect(seen).toEqual([{}])
    })

    it('records a pass, and a failure by its fixed reason code only', async () => {
      const passed = await vpnSample(
        vpnProbeDeps(async () => vpnProbeObservation('pass')),
        runEnv('1001', '1', {VPN_PROBE_HOST: ADDRESS}),
      )
      expect(passed.sample?.r['public-reachability']).toBe('p')

      await rm(history, {recursive: true, force: true})
      const failed = await vpnSample(
        vpnProbeDeps(async () => ({...vpnProbeObservation('fail'), detail: {reason: 'timeout', durationMs: 5000}})),
        runEnv('1002', '1', {VPN_PROBE_HOST: ADDRESS}),
      )
      expect(failed.sample?.r['public-reachability']).toBe('f')
      expect(failed.sample?.d?.['public-reachability']).toEqual({reason: 'timeout'})
    })

    it('records an unset secret as not measured, so the public history does not turn red before it exists', async () => {
      const unset = await vpnSample(
        vpnProbeDeps(options =>
          probeVpn({...options, connect: async () => Promise.reject(new Error('must not connect'))}),
        ),
        runEnv('1001'),
      )

      expect(unset.sample?.r['public-reachability']).toBe('n')
      expect(unset.sample?.d?.['public-reachability']).toEqual({reason: 'missing-config'})
    })

    it('never writes the address to the history, stdout or stderr, whatever the probe does', async () => {
      const throwing = await vpnSample(
        vpnProbeDeps(async options => {
          throw new Error(`boom ${options?.host}`)
        }),
        runEnv('1001', '1', {VPN_PROBE_HOST: ADDRESS, VPN_HOST: OTHER_ADDRESS}),
      )
      expect(throwing.sample?.r['public-reachability']).toBe('u')
      expect(throwing.sample?.d?.['public-reachability']).toEqual({reason: 'check-failed'})

      await rm(history, {recursive: true, force: true})
      const refused = await vpnSample(
        vpnProbeDeps(options =>
          probeVpn({
            ...options,
            connect: async target => {
              throw Object.assign(new Error(`connect ECONNREFUSED ${target.host}:22`), {code: 'ECONNREFUSED'})
            },
          }),
        ),
        runEnv('1002', '1', {VPN_PROBE_HOST: ADDRESS, VPN_HOST: OTHER_ADDRESS}),
      )
      expect(refused.sample?.d?.['public-reachability']).toEqual({reason: 'refused'})

      for (const {captured, files} of [throwing, refused]) {
        const everything = [...captured.stdout, ...captured.stderr, ...Object.values(files)].join('\n')
        expect(everything).not.toContain(ADDRESS)
        expect(everything).not.toContain(OTHER_ADDRESS)
      }
    })
  })

  it('appends a second sample on a normal run, giving two samples per app', async () => {
    await run({bootstrap: true}, {env: runEnv('1001')})
    const second = await run({}, {env: runEnv('1002')})

    expect(second.exit).toBeNull()
    expect(second.stdout[0]).toBe('samples: keeweb=2 cliproxy=2 gateway=2 umami=2 dashboard=2 vpn=2 broker=2 traces=2')
    const meta = historyMetaSchema.parse(JSON.parse(await readFile(join(history, 'meta.json'), 'utf8')))
    expect(meta.lastSampleAt).toBe(FIXED_NOW.toISOString())
  })

  it('creates the file of an app the history does not know yet, keeping every other sample', async () => {
    // The live artifact predates `traces`: it holds the other app files and no apps/traces.json.
    await run({bootstrap: true}, {env: runEnv('1001')})
    const before = await readFiles(history)
    await rm(join(history, 'apps', 'traces.json'))

    const second = await run({}, {env: runEnv('1002')})

    expect(second.exit).toBeNull()
    expect(second.stderr).toEqual([])
    expect(second.stdout[0]).toBe('samples: keeweb=2 cliproxy=2 gateway=2 umami=2 dashboard=2 vpn=2 broker=2 traces=1')
    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.apps.traces.map(entry => entry.run)).toEqual(['1002'])
    for (const app of APP_IDS.filter(id => id !== 'traces')) {
      const first = historyAppFileSchema.parse(JSON.parse(before[join('apps', `${app}.json`)] ?? '[]'))[0]
      expect(loaded?.apps[app].map(entry => entry.run)).toContain(first?.run)
    }
  })

  it('is a no-op for a rerun of the same run and attempt, and leaves the files byte-identical', async () => {
    await run({bootstrap: true}, {env: runEnv('1001')})
    const before = await readFiles(history)

    const rerun = await run({}, {env: runEnv('1001')})

    expect(rerun.exit).toBeNull()
    expect(rerun.stdout[1]).toBe('added: 0')
    expect(await readFiles(history)).toEqual(before)
  })

  it('records a new attempt of the same run as a new sample', async () => {
    await run({bootstrap: true}, {env: runEnv('1001', '1')})
    const retry = await run({}, {env: runEnv('1001', '2')})

    expect(retry.stdout[1]).toBe('added: 8')
  })

  it('identifies a local run by its own timestamp and keeps the stable id for a GitHub run', async () => {
    expect(resolveRunIdentity({}, FIXED_NOW)).toEqual({run: `local-${FIXED_NOW.toISOString()}`, att: 1})
    expect(resolveRunIdentity({GITHUB_RUN_ID: '  '}, FIXED_NOW)).toEqual({
      run: `local-${FIXED_NOW.toISOString()}`,
      att: 1,
    })
    expect(resolveRunIdentity({GITHUB_RUN_ID: '77'}, FIXED_NOW)).toEqual({run: '77', att: 1})
    expect(resolveRunIdentity({GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '3'}, FIXED_NOW)).toEqual({run: '77', att: 3})

    await run({bootstrap: true}, {env: {}})
    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.apps.keeweb[0]).toMatchObject({run: `local-${FIXED_NOW.toISOString()}`, att: 1})
  })

  it('adds one sample per app for each of two local snapshots taken at different times', async () => {
    const first = new Date(FIXED_NOW.getTime() - 2 * HOUR)
    const second = new Date(FIXED_NOW.getTime() - HOUR)
    await run({bootstrap: true, now: first.toISOString()}, {env: {}})

    const captured = await run({now: second.toISOString()}, {env: {}})

    expect(captured.exit).toBeNull()
    expect(captured.stdout[0]).toBe(
      'samples: keeweb=2 cliproxy=2 gateway=2 umami=2 dashboard=2 vpn=2 broker=2 traces=2',
    )
    expect(captured.stdout[1]).toBe('added: 8')
    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.apps.keeweb.map(entry => entry.run)).toEqual([
      `local-${first.toISOString()}`,
      `local-${second.toISOString()}`,
    ])
  })

  it('lets a local snapshot succeed after the bootstrap sample has aged out of the 90-day window', async () => {
    const first = new Date(FIXED_NOW.getTime() - 100 * DAY)
    await run({bootstrap: true, now: first.toISOString()}, {env: {}})

    const captured = await run({now: FIXED_NOW.toISOString()}, {env: {}})

    expect(captured.exit).toBeNull()
    expect(captured.stderr).toEqual([])
    expect(captured.stdout[0]).toBe(
      'samples: keeweb=1 cliproxy=1 gateway=1 umami=1 dashboard=1 vpn=1 broker=1 traces=1',
    )
    expect(captured.stdout[1]).toBe('added: 8')
    expect(captured.stdout[2]).toBe('trimmed: 8')
    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.apps.keeweb[0]).toMatchObject({t: FIXED_NOW.toISOString(), run: `local-${FIXED_NOW.toISOString()}`})
  })

  it('exits non-zero for an invalid run id, attempt or --now, writing nothing', async () => {
    for (const [options, env] of [
      [{bootstrap: true}, runEnv('not-a-number')],
      [{bootstrap: true}, runEnv('5', '0x1')],
      [{bootstrap: true, now: 'yesterday'}, runEnv('5')],
      [{bootstrap: true, now: '2026-11-01T12:00:00+02:00'}, runEnv('5')],
    ] as const) {
      const captured = await run(options, {env})

      expect(captured.exit).toEqual({code: 1})
      expect(captured.stdout).toEqual([])
    }
    expect(await readdir(dir)).toEqual([])
  })

  it('fails without --bootstrap when the history is missing, and writes nothing', async () => {
    const captured = await run()

    expect(captured.exit).toEqual({code: 1})
    expect(captured.stderr).toEqual(['status snapshot failed: history not found; pass --bootstrap to create it'])
    expect(captured.stdout).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  it('fails with --bootstrap when a history exists, leaving it untouched', async () => {
    await run({bootstrap: true}, {env: runEnv('1001')})
    const before = await readFiles(history)

    const captured = await run({bootstrap: true}, {env: runEnv('1002')})

    expect(captured.exit).toEqual({code: 1})
    expect(captured.stderr).toEqual(['status snapshot failed: history already exists; refusing to bootstrap over it'])
    expect(await readFiles(history)).toEqual(before)
  })

  it('makes no network or SSH call before it knows the history is usable', async () => {
    let probed = 0
    const captured = await run(
      {},
      {
        deps: snapshotDeps({
          publicProbes: {
            keeweb: async () => {
              probed += 1
              return probeObservation()
            },
          },
        }),
      },
    )

    expect(captured.exit).toEqual({code: 1})
    expect(probed).toBe(0)
  })

  it('exits non-zero and writes nothing when an invariant fails (future sample in the history)', async () => {
    await run({bootstrap: true}, {env: runEnv('1001')})
    const loaded = await loadHistory(history, 'existing')
    if (loaded === undefined) throw new Error('expected history')
    const future = new Date(FIXED_NOW.getTime() + 10 * 60_000).toISOString()
    await writeHistory(history, {
      meta: {schemaVersion: 1, lastSampleAt: future},
      apps: recordByApp(app => [...loaded.apps[app], {t: future, run: '555', att: 1, r: {'deploy-state': 'p'}}]),
    })
    const before = await readFiles(history)

    const captured = await run({}, {env: runEnv('1002')})

    expect(captured.exit).toEqual({code: 1})
    expect(captured.stderr).toEqual(['status snapshot failed: a sample is dated more than 5 minutes in the future'])
    expect(await readFiles(history)).toEqual(before)
  })

  it('rejects a stale history whose meta is newer than anything it holds', async () => {
    await run({bootstrap: true}, {env: runEnv('1001')})
    const meta = join(history, 'meta.json')
    await writeFile(
      meta,
      JSON.stringify({schemaVersion: 1, lastSampleAt: new Date(FIXED_NOW.getTime() + 4 * 60_000).toISOString()}),
    )
    const before = await readFiles(history)

    // The new sample (now + 1 min) is older than the meta claim (now + 4 min), which is still within skew.
    const captured = await run({now: new Date(FIXED_NOW.getTime() + 60_000).toISOString()}, {env: runEnv('1002')})

    expect(captured.exit).toEqual({code: 1})
    expect(captured.stderr).toEqual(['status snapshot failed: newest sample time would move backwards'])
    expect(await readFiles(history)).toEqual(before)
  })

  it('trims samples older than 90 days using the --now reference and reports the count', async () => {
    await run({bootstrap: true}, {env: runEnv('1001'), deps: snapshotDeps()})
    const loaded = await loadHistory(history, 'existing')
    if (loaded === undefined) throw new Error('expected history')
    await writeHistory(history, {
      ...loaded,
      apps: recordByApp(app => [
        {t: new Date(FIXED_NOW.getTime() - 100 * DAY).toISOString(), run: '1', att: 1, r: {'deploy-state': 'p'}},
        ...loaded.apps[app],
      ]),
    })

    const captured = await run({now: FIXED_NOW.toISOString()}, {env: runEnv('1002')})

    expect(captured.exit).toBeNull()
    expect(captured.stdout[0]).toBe(
      'samples: keeweb=2 cliproxy=2 gateway=2 umami=2 dashboard=2 vpn=2 broker=2 traces=2',
    )
    expect(captured.stdout[2]).toBe('trimmed: 8')
  })

  it('uses --now as the sample time', async () => {
    const at = '2026-10-15T08:30:00.000Z'
    await run({bootstrap: true, now: at})

    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.apps.gateway[0]?.t).toBe(at)
    expect(loaded?.meta.lastSampleAt).toBe(at)
  })

  it('exits 0 and stores fail, unknown and not_measured as data', async () => {
    const captured = await run(
      {bootstrap: true},
      {
        deps: snapshotDeps({
          publicProbes: {
            ...makeStatusDependencies().publicProbes,
            umami: async () => probeObservation('fail'),
            broker: async () => probeObservation('unknown'),
            dashboard: async () => {
              throw new Error('probe exploded: https://internal.example.invalid/secret')
            },
          },
          readDeployStates: async () => ({
            keeweb: deployObservation('fail'),
            gateway: deployObservation('unknown', {reason: 'at_gate', since: '2026-11-01T11:00:00Z'}),
          }),
          readMonitorState: async () => [
            routeObservation('fail', {reason: 'auth-401', probeAt: '2026-11-01T11:58:00.000Z'}),
            goRouteObservation(),
          ],
        }),
      },
    )

    expect(captured.exit).toBeNull()
    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.apps.umami[0]?.r).toEqual({'public-reachability': 'f', 'deploy-state': 'u'})
    expect(loaded?.apps.broker[0]?.r['public-reachability']).toBe('u')
    expect(loaded?.apps.dashboard[0]?.r['public-reachability']).toBe('u')
    expect(loaded?.apps.dashboard[0]?.d?.['public-reachability']).toEqual({reason: 'check-failed'})
    expect(loaded?.apps.keeweb[0]?.r['deploy-state']).toBe('f')
    expect(loaded?.apps.gateway[0]?.d?.['deploy-state']).toEqual({reason: 'at_gate', since: '2026-11-01T11:00:00Z'})
    expect(loaded?.apps.cliproxy[0]?.r['provider-route']).toBe('f')
    expect(loaded?.apps.cliproxy[0]?.d?.['provider-route']).toEqual({
      reason: 'auth-401',
      probeAt: '2026-11-01T11:58:00.000Z',
    })
    expect(JSON.stringify(await readFiles(history))).not.toContain('internal.example')
  })

  it('never prints URLs, hosts or error text, even for a failure that carries them', async () => {
    const failing = await run(
      {bootstrap: true},
      {
        deps: snapshotDeps({
          readDeployStates: async () => {
            throw new Error('GET https://api.github.com/repos/x/y failed for host 203.0.113.9')
          },
        }),
      },
    )
    const output = [...failing.stdout, ...failing.stderr].join('\n')

    expect(failing.exit).toBeNull()
    expect(output).not.toMatch(/https?:|\d+\.\d+\.\d+\.\d+|github\.com|failed/)

    await writeFile(join(dir, 'file'), 'x')
    const notDir = await run({bootstrap: true, history: join(dir, 'file', 'history')}, {env: runEnv('10')})
    expect(notDir.exit).toEqual({code: 1})
    expect(notDir.stderr).toHaveLength(1)
    expect(notDir.stderr[0]).toMatch(/^status snapshot failed: (?:filesystem error \(E[A-Z]+\)|unexpected error)$/)
    expect(notDir.stderr.join('')).not.toContain(dir)
  })

  it('does not run any SSH collector or spawn a process', async () => {
    const spawn = spyOn(Bun, 'spawn')
    try {
      await run({bootstrap: true})
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
    }
  })

  it('leaves the existing history untouched when a write fails', async () => {
    await run({bootstrap: true}, {env: runEnv('1001')})
    const before = await readFiles(history)
    await chmod(join(history, 'apps'), 0o500)

    const captured = await run({}, {env: runEnv('1002')})
    await chmod(join(history, 'apps'), 0o700)

    if (process.getuid?.() === 0) return // root ignores directory modes
    expect(captured.exit).toEqual({code: 1})
    expect(captured.stderr).toEqual(['status snapshot failed: filesystem error (EACCES)'])
    expect(await readFiles(history)).toEqual(before)
  })
})

describe('status snapshot with the real GitHub readers and a mocked fetch (integration)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'status-snapshot-int-'))
  })

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true})
  })

  interface Call {
    url: string
    authorization: string | null
  }

  const API_ORIGIN = 'https://api.github.com'
  const STORAGE_ORIGIN = 'https://logs.example-storage.test'
  const PROBE_AT = new Date(FIXED_NOW.getTime() - 5 * 60_000).toISOString()

  /**
   * Deployments: keeweb failed, dashboard is at its gate, everything else succeeded. Monitor: healthy 5 minutes ago.
   * The log endpoint answers 302 to a signed storage URL that serves the log text, like the real API.
   */
  function fakeGitHub() {
    const calls: Call[] = []
    const probeAt = PROBE_AT
    const stateOf = (id: number): string => {
      const app = APP_IDS[id - 100]
      return app === 'keeweb' ? 'failure' : app === 'dashboard' ? 'waiting' : 'success'
    }

    const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input)
      calls.push({url: input, authorization: new Headers(init?.headers).get('authorization')})

      if (url.origin === STORAGE_ORIGIN) {
        return url.pathname === '/signed/job-6.txt'
          ? new Response(
              `2026-11-01T11:55:00.0000000Z CLIProxy auth monitor probe: probe=healthy reason=ok at ${probeAt}\n`,
            )
          : new Response('not found', {status: 404})
      }
      if (url.pathname === '/repos/marcusrbrown/infra/deployments') {
        const index = APP_NAMES.indexOf(url.searchParams.get('environment') ?? '')
        return Response.json([{id: 100 + index, ref: 'main'}])
      }
      const statuses = /\/deployments\/(\d+)\/statuses$/.exec(url.pathname)
      if (statuses !== null) {
        return Response.json([{state: stateOf(Number(statuses[1])), created_at: '2026-11-01T11:00:00Z'}])
      }
      if (url.pathname.endsWith('/runs')) {
        return Response.json({workflow_runs: [{id: 5, event: 'schedule', head_branch: 'main', status: 'completed'}]})
      }
      if (url.pathname.endsWith('/jobs')) return Response.json({jobs: [{id: 6}]})
      if (url.pathname.endsWith('/logs')) {
        return new Response(null, {status: 302, headers: {location: `${STORAGE_ORIGIN}/signed/job-6.txt?sig=abc`}})
      }
      return new Response('not found', {status: 404})
    }

    return {fetchFn, calls}
  }

  it('produces valid per-app files from deployment and monitor responses, without leaking the token', async () => {
    const history = join(dir, 'history')
    const github = fakeGitHub()
    const {ctx, captured} = createCapturedCtx()
    const deps: SnapshotDependencies = {
      ...snapshotDeps(),
      readDeployStates,
      readMonitorState,
      fetch: github.fetchFn,
    }

    await statusSnapshotAction({history, bootstrap: true}, ctx, deps, runEnv('2002', '1', {GH_TOKEN: TOKEN}), [])

    expect(captured.exit).toBeNull()
    expect(captured.stderr).toEqual([])

    const files = await readFiles(history)
    for (const app of APP_IDS) {
      const samples = historyAppFileSchema.parse(JSON.parse(files[`apps/${app}.json`] ?? 'null'))
      expect(samples).toHaveLength(1)
    }
    expect(JSON.parse(files['apps/keeweb.json'] ?? '[]')[0].r['deploy-state']).toBe('f')
    expect(JSON.parse(files['apps/dashboard.json'] ?? '[]')[0]).toMatchObject({
      r: {'deploy-state': 'u'},
      d: {'deploy-state': {reason: 'at_gate', since: '2026-11-01T11:00:00Z'}},
    })
    expect(JSON.parse(files['apps/gateway.json'] ?? '[]')[0].r['deploy-state']).toBe('p')
    // The stored route result comes from the probe line the storage host served after the redirect.
    expect(JSON.parse(files['apps/cliproxy.json'] ?? '[]')[0]).toMatchObject({
      r: {'deploy-state': 'p', 'provider-route': 'p', 'provider-route-go': 'u'},
      d: {'provider-route': {reason: 'ok', probeAt: PROBE_AT}, 'provider-route-go': {reason: 'no-probe-line'}},
    })

    // The token travels as a bearer header to the API origin only; the signed storage request carries none.
    const apiCalls = github.calls.filter(call => call.url.startsWith(`${API_ORIGIN}/`))
    const storageCalls = github.calls.filter(call => call.url.startsWith(`${STORAGE_ORIGIN}/`))
    expect(apiCalls.length).toBeGreaterThan(0)
    expect(apiCalls.every(call => call.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(apiCalls.some(call => new URL(call.url).pathname.endsWith('/logs'))).toBe(true)
    expect(storageCalls).toHaveLength(1)
    expect(storageCalls.every(call => call.authorization === null)).toBe(true)
    expect(storageCalls.some(call => call.url.includes(TOKEN))).toBe(false)
    expect(apiCalls.length + storageCalls.length).toBe(github.calls.length)
    expect(JSON.stringify(files)).not.toContain(TOKEN)
    expect(captured.stdout.join('\n')).not.toContain(TOKEN)
    expect(JSON.stringify(files)).not.toMatch(/https?:|github\.com/)
  })

  it('stores deploy-state and provider-route as not measured, with no request, when no token is set', async () => {
    const history = join(dir, 'history')
    const github = fakeGitHub()
    const {ctx} = createCapturedCtx()

    await statusSnapshotAction(
      {history, bootstrap: true},
      ctx,
      {...snapshotDeps(), readDeployStates, readMonitorState, fetch: github.fetchFn},
      runEnv('2003'),
      [],
    )

    const files = await readFiles(history)
    expect(github.calls).toEqual([])
    expect(JSON.parse(files['apps/cliproxy.json'] ?? '[]')[0]).toMatchObject({
      r: {'public-reachability': 'p', 'deploy-state': 'n', 'provider-route': 'n', 'provider-route-go': 'n'},
      d: {
        'deploy-state': {reason: 'missing-config'},
        'provider-route': {reason: 'missing-config'},
        'provider-route-go': {reason: 'missing-config'},
      },
    })
  })
})

describe('status snapshot registration', () => {
  it('is a goke subcommand with --history, --bootstrap and --now in its help', () => {
    const cli = goke('infra')
    registerStatus(cli, makeStatusDependencies())
    cli.help()
    const help = stripVTControlCharacters(cli.helpText())

    expect(help).toContain('status snapshot')
    expect(help).toContain('--history <dir>')
    expect(help).toContain('--bootstrap')
    expect(help).toContain('--now [iso]')
  })

  it('runs through goke and writes the history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'status-snapshot-cli-'))
    try {
      const history = join(dir, 'h')
      const cli = goke('infra')
      registerStatus(cli, makeStatusDependencies())
      cli.parse(['bun', 'infra', 'status', 'snapshot', '--history', history, '--bootstrap'], {run: false})
      await cli.runMatchedCommand()

      expect((await loadHistory(history, 'existing'))?.apps.vpn).toHaveLength(1)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('does not break plain `status` routing', async () => {
    const cli = goke('infra')
    registerStatus(cli, makeStatusDependencies())
    cli.parse(['bun', 'infra', 'status'], {run: false})

    expect(cli.matchedCommandName).toBe('status')
  })

  it('stays off MCP_ALLOWLIST', () => {
    expect(MCP_ALLOWLIST.has('status snapshot')).toBe(false)
    expect(MCP_ALLOWLIST.has('status')).toBe(true)
    expect([...MCP_ALLOWLIST].some(name => name.includes('snapshot'))).toBe(false)
  })
})

describe('status snapshot for an app that is not yet deployed', () => {
  let dir: string
  let history: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'status-snapshot-hidden-'))
    history = join(dir, 'history')
  })

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true})
  })

  const HIDDEN: readonly AppId[] = ['traces']
  const DEPLOYED = APP_IDS.filter(app => !HIDDEN.includes(app))

  /** What the fakes were asked, by app. */
  function spies() {
    const probed: string[] = []
    const deployReadsFor: (readonly AppId[] | undefined)[] = []
    const probe = (app: string) => async () => {
      probed.push(app)
      return probeObservation()
    }
    const base = makeStatusDependencies()
    const deps: SnapshotDependencies = {
      ...snapshotDeps(),
      publicProbes: Object.fromEntries(APP_IDS.map(app => [app, probe(app)])),
      readDeployStates: async options => {
        deployReadsFor.push(options.apps)
        const wanted = options.apps ?? APP_IDS
        return Object.fromEntries(wanted.map(app => [app, deployObservation()]))
      },
      readMonitorState: base.readMonitorState,
    }
    return {deps, probed, deployReadsFor}
  }

  async function snapshot(
    deps: SnapshotDependencies,
    run: string,
    options: {bootstrap?: boolean},
    notYetDeployed?: readonly AppId[],
  ) {
    const {ctx, captured} = createCapturedCtx()
    await statusSnapshotAction({history, ...options}, ctx, deps, runEnv(run), notYetDeployed)
    return captured
  }

  it('makes no public probe and no deploy-state read for it, and records no sample', async () => {
    const {deps, probed, deployReadsFor} = spies()

    const captured = await snapshot(deps, '1', {bootstrap: true}, HIDDEN)

    expect(captured.exit).toBeNull()
    expect(probed.toSorted()).toEqual([...DEPLOYED].toSorted())
    expect(deployReadsFor).toEqual([DEPLOYED])
    expect(captured.stdout[0]).toBe(
      'samples: keeweb=1 cliproxy=1 gateway=1 umami=1 dashboard=1 vpn=1 broker=1 traces=0',
    )
    expect(captured.stdout[1]).toBe('added: 7')
    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.apps.traces).toEqual([])
    for (const app of DEPLOYED) expect(loaded?.apps[app]).toHaveLength(1)
  })

  it('writes no observation of it even when the readers would have answered', async () => {
    const {deps} = spies()

    await snapshot(deps, '1', {bootstrap: true}, HIDDEN)

    const files = await readFiles(history)
    expect(JSON.parse(files['apps/traces.json'] ?? 'null')).toEqual([])
    expect(files['apps/keeweb.json']).toContain('deploy-state')
  })

  it('leaves the samples it already holds for the app exactly as they were', async () => {
    const {deps} = spies()
    await snapshot(deps, '1', {bootstrap: true}, [])
    const before = await loadHistory(history, 'existing')
    if (before === undefined) throw new Error('expected history')
    const kept = before.apps.traces

    await snapshot(deps, '2', {}, HIDDEN)

    const after = await loadHistory(history, 'existing')
    expect(after?.apps.traces).toEqual(kept)
    expect(after?.apps.keeweb).toHaveLength(2)
  })

  it('records every app again once the list is empty', async () => {
    const {deps, probed, deployReadsFor} = spies()

    const captured = await snapshot(deps, '1', {bootstrap: true}, [])

    expect(probed.toSorted()).toEqual([...APP_IDS].toSorted())
    expect(deployReadsFor).toEqual([APP_IDS])
    expect(captured.stdout[1]).toBe('added: 8')
  })

  it('asks GitHub about no deployment environment of it, with the real deploy-state reader', async () => {
    const calls: string[] = []
    const fetchFn = async (input: string): Promise<Response> => {
      calls.push(input)
      const url = new URL(input)
      if (url.pathname.endsWith('/deployments')) return Response.json([{id: 7, ref: 'main'}])
      return Response.json([{state: 'success', created_at: '2026-11-01T11:00:00Z'}])
    }
    const {ctx} = createCapturedCtx()

    await statusSnapshotAction(
      {history, bootstrap: true},
      ctx,
      {...snapshotDeps(), readDeployStates, fetch: fetchFn},
      runEnv('3001', '1', {GH_TOKEN: TOKEN}),
      HIDDEN,
    )

    const environments = calls.flatMap(call => new URL(call).searchParams.get('environment') ?? [])
    expect(environments.toSorted()).toEqual([...DEPLOYED].toSorted())
    expect(calls.some(call => call.includes('environment=traces'))).toBe(false)
  })

  // Wiring with the real list, no injection: every app is deployed, so every app is probed, read and recorded.
  it('applies the real not-yet-deployed list when none is injected', async () => {
    expect(APPS_NOT_YET_DEPLOYED).toEqual([])
    const {deps, probed, deployReadsFor} = spies()

    const captured = await snapshot(deps, '1', {bootstrap: true})

    expect(probed.toSorted()).toEqual([...APP_IDS].toSorted())
    expect(deployReadsFor).toEqual([APP_IDS])
    expect(captured.stdout[1]).toBe('added: 8')
    const loaded = await loadHistory(history, 'existing')
    expect(loaded?.apps.traces).toHaveLength(1)
    expect(loaded?.apps.keeweb).toHaveLength(1)
  })
})
