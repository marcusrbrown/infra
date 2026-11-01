import type {StatusEnvelope} from '../status/observation'
import type {SpawnFn} from './gateway/status'
import {afterEach, describe, expect, it, spyOn} from 'bun:test'
import {goke} from 'goke'
import {createCapturedCtx} from '../lib/mcp-ctx-fixture'
import {STATUS_SCHEMA_VERSION, statusEnvelopeSchema} from '../status/observation'
import {
  EXPECTED_OBSERVATION_IDS,
  FIXED_NOW,
  healthyGateway,
  healthyUmami,
  makeStatusDependencies,
  okWorkspace,
  probeObservation,
  withStatusEnv,
} from './__fixtures__/status-dependencies'
import {DEGRADED_BODY, LIMIT_BYTES, workspaceStdout} from './gateway/__fixtures__/workspace-probe'
import {getGatewayStatusSummary} from './gateway/status'
import {registerStatus, unifiedStatusAction} from './status'

// NOTE: dashboard is included in the unified status table alongside the other apps.

const APPS = ['keeweb', 'cliproxy', 'gateway', 'umami', 'dashboard', 'vpn', 'broker'] as const

function proc(stdout: string, exitCode = 0): ReturnType<SpawnFn> {
  const encoder = new TextEncoder()
  return {
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(stdout))
        c.close()
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close()
      },
    }),
    exited: Promise.resolve(exitCode),
  }
}

/** A child that never exits on its own; like Bun's `signal` option, aborting kills it and lets `exited` settle. */
function hangingProc(signal: AbortSignal | undefined, onKill: () => void): ReturnType<SpawnFn> {
  const exited = new Promise<number>(resolve => {
    signal?.addEventListener('abort', () => {
      onKill()
      resolve(143)
    })
  })

  return {stdout: new ReadableStream({}), stderr: new ReadableStream({}), exited}
}

async function runJson(overrides?: Parameters<typeof makeStatusDependencies>[0]) {
  const {ctx, captured} = createCapturedCtx()
  await withStatusEnv(() => unifiedStatusAction({json: true}, ctx, makeStatusDependencies(overrides)))
  expect(captured.stdout).toHaveLength(1)
  const envelope = statusEnvelopeSchema.parse(JSON.parse(captured.stdout[0] ?? ''))
  return {envelope, captured}
}

function appOf(envelope: StatusEnvelope, app: (typeof APPS)[number]) {
  const entry = envelope.apps.find(candidate => candidate.app === app)
  if (entry === undefined) throw new Error(`missing app ${app}`)
  return entry
}

function observation(envelope: StatusEnvelope, app: (typeof APPS)[number], id: string) {
  const found = appOf(envelope, app).observations.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`missing observation ${app}/${id}`)
  return found
}

async function runTable(overrides?: Parameters<typeof makeStatusDependencies>[0]) {
  const {ctx, captured} = createCapturedCtx()
  await withStatusEnv(() => unifiedStatusAction({}, ctx, makeStatusDependencies(overrides)))
  return captured
}

async function runWithGateway(workspaceOutput: () => ReturnType<SpawnFn>, composeOutput: () => ReturnType<SpawnFn>) {
  const spawn: SpawnFn = cmd =>
    cmd.at(-1)?.includes('ps --format json') === true ? composeOutput() : workspaceOutput()
  const {envelope} = await runJson({getGatewayStatusSummary: host => getGatewayStatusSummary(host, spawn)})
  return appOf(envelope, 'gateway')
}

function result(gateway: ReturnType<typeof appOf>, id: string) {
  return gateway.observations.find(entry => entry.id === id)
}

describe('top-level status --json (typed contract)', () => {
  it('emits the versioned envelope with all 7 apps and their declared observation ids', async () => {
    const {envelope, captured} = await runJson()

    expect(envelope.schemaVersion).toBe(STATUS_SCHEMA_VERSION)
    expect(envelope.generatedAt).toBe(FIXED_NOW.toISOString())
    expect(envelope.apps.map(entry => entry.app)).toEqual([...APPS])
    for (const app of APPS) {
      expect(appOf(envelope, app).observations.map(entry => entry.id)).toEqual(EXPECTED_OBSERVATION_IDS[app])
    }
    expect(captured.stderr).toEqual([])
    expect(captured.exit).toBeNull()
  })

  it('reports every healthy observation as pass and stamps the measured ones with a time', async () => {
    const {envelope} = await runJson()

    for (const app of APPS) {
      for (const entry of appOf(envelope, app).observations) {
        if (entry.result === 'not_measured') continue
        expect(entry.result).toBe('pass')
        expect(entry.observedAt).toBe(FIXED_NOW.toISOString())
      }
    }
  })

  it('moves workspace, versions, usage and last deploy into facts', async () => {
    const {envelope} = await runJson()

    expect(appOf(envelope, 'gateway').facts.workspace).toEqual({...okWorkspace})
    expect(appOf(envelope, 'gateway').facts.services).toEqual([{service: 'app', state: 'running', health: 'healthy'}])
    expect(appOf(envelope, 'cliproxy').facts).toEqual({
      runningVersion: 'v1.2.3',
      latestVersion: 'v1.2.4',
      usage: {recent: 12, errors: 0},
      managementAccess: 'ok',
    })
    expect(appOf(envelope, 'keeweb').facts).toEqual({lastDeploy: '2026-04-12T10:00:00Z', contentHash: 'match'})
    expect(appOf(envelope, 'vpn').facts).toEqual({peerCount: 1, serverPublicKey: 'TESTKEY=='})
    expect(appOf(envelope, 'broker').facts).toEqual({})
  })

  it('has no top-level per-app keys and no flat summary strings', async () => {
    const {captured} = await runJson()
    const parsed = JSON.parse(captured.stdout[0] ?? '') as Record<string, unknown>

    expect(Object.keys(parsed).sort()).toEqual(['apps', 'generatedAt', 'schemaVersion'])
    expect(captured.stdout[0]).not.toContain('"http":')
    expect(captured.stdout[0]).not.toContain('errorSummary')
  })

  it('declares deploy-state as not measured from config for every app until its reader exists', async () => {
    const {envelope} = await runJson()

    for (const app of APPS) {
      expect(observation(envelope, app, 'deploy-state')).toEqual({
        id: 'deploy-state',
        kind: 'deploy-state',
        source: 'config',
        result: 'not_measured',
        observedAt: null,
        detail: {reason: 'not-implemented'},
      })
    }
    expect(observation(envelope, 'cliproxy', 'provider-route')).toMatchObject({
      kind: 'end-to-end',
      source: 'config',
      result: 'not_measured',
      detail: {reason: 'not-implemented'},
    })
  })

  it('reports vpn reachability and end-to-end as not measured, and never runs a public probe for it', async () => {
    const probed: string[] = []
    const probe = (app: string) => async () => {
      probed.push(app)
      return probeObservation()
    }
    const {envelope} = await runJson({
      publicProbes: {
        keeweb: probe('keeweb'),
        cliproxy: probe('cliproxy'),
        gateway: probe('gateway'),
        umami: probe('umami'),
        dashboard: probe('dashboard'),
        broker: probe('broker'),
      },
    })

    for (const id of ['public-reachability', 'egress-route']) {
      expect(observation(envelope, 'vpn', id)).toMatchObject({
        result: 'not_measured',
        source: 'config',
        observedAt: null,
      })
    }
    expect(probed.sort()).toEqual(['broker', 'cliproxy', 'dashboard', 'gateway', 'keeweb', 'umami'])
  })

  it('keeps public reachability for all six apps that have a probe, with the probe detail', async () => {
    const {envelope} = await runJson()

    for (const app of ['keeweb', 'cliproxy', 'gateway', 'umami', 'dashboard', 'broker'] as const) {
      expect(observation(envelope, app, 'public-reachability')).toMatchObject({
        kind: 'reachability',
        source: 'http',
        result: 'pass',
        detail: {statusCode: 200, durationMs: 42},
      })
    }
  })

  it('passes a failed or unknown probe through for that app only', async () => {
    const {envelope} = await runJson({
      publicProbes: {
        ...makeStatusDependencies().publicProbes,
        umami: async () => probeObservation('fail'),
        broker: async () => probeObservation('unknown'),
      },
    })

    expect(observation(envelope, 'umami', 'public-reachability').result).toBe('fail')
    expect(observation(envelope, 'broker', 'public-reachability').result).toBe('unknown')
    expect(observation(envelope, 'keeweb', 'public-reachability').result).toBe('pass')
    expect(observation(envelope, 'umami', 'compose-services').result).toBe('pass')
  })

  it('makes only the gateway collector observations unknown when it rejects, without writing to stderr', async () => {
    const baseline = (await runJson()).envelope
    const {envelope, captured} = await runJson({
      getGatewayStatusSummary: async () => {
        throw new Error('Gateway exploded')
      },
    })

    for (const id of ['compose-services', 'workspace-memory']) {
      expect(observation(envelope, 'gateway', id)).toMatchObject({
        result: 'unknown',
        source: 'ssh',
        observedAt: FIXED_NOW.toISOString(),
        detail: {reason: 'check-failed'},
      })
    }
    expect(observation(envelope, 'gateway', 'public-reachability').result).toBe('pass')
    expect(observation(envelope, 'gateway', 'deploy-state').result).toBe('not_measured')
    expect(appOf(envelope, 'gateway').facts).toEqual({})
    for (const app of APPS.filter(name => name !== 'gateway')) {
      expect(appOf(envelope, app)).toEqual(appOf(baseline, app))
    }
    expect(captured.stderr).toEqual([])
    expect(captured.stdout).toHaveLength(1)
    expect(captured.exit).toBeNull()
  })

  it('makes the keeweb collector failure leave its probe and the other apps untouched', async () => {
    const {envelope, captured} = await runJson({
      getKeewebStatusSummary: async () => {
        throw new Error('Keeweb exploded')
      },
    })

    expect(appOf(envelope, 'keeweb').facts).toEqual({})
    expect(observation(envelope, 'keeweb', 'public-reachability').result).toBe('pass')
    expect(appOf(envelope, 'cliproxy').facts).toMatchObject({runningVersion: 'v1.2.3'})
    expect(captured.stderr).toEqual([])
  })

  it('makes the public reachability unknown when its probe rejects, and keeps the collector observations', async () => {
    const {envelope, captured} = await runJson({
      publicProbes: {
        ...makeStatusDependencies().publicProbes,
        dashboard: async () => {
          throw new Error('probe exploded')
        },
      },
    })

    expect(observation(envelope, 'dashboard', 'public-reachability')).toMatchObject({
      result: 'unknown',
      source: 'http',
      detail: {reason: 'check-failed'},
    })
    expect(observation(envelope, 'dashboard', 'compose-services').result).toBe('pass')
    expect(captured.stderr).toEqual([])
  })

  it('reports the ssh observations as not measured from config when GATEWAY_HOST is unset, and still probes', async () => {
    const {ctx, captured} = createCapturedCtx()
    let gatewayCollected = false
    await withStatusEnv(async () => {
      delete process.env.GATEWAY_HOST
      await unifiedStatusAction(
        {json: true},
        ctx,
        makeStatusDependencies({
          getGatewayStatusSummary: async () => {
            gatewayCollected = true
            return healthyGateway
          },
        }),
      )
    })
    const envelope = statusEnvelopeSchema.parse(JSON.parse(captured.stdout[0] ?? ''))

    expect(gatewayCollected).toBe(false)
    for (const id of ['compose-services', 'workspace-memory']) {
      expect(observation(envelope, 'gateway', id)).toEqual(
        expect.objectContaining({
          source: 'config',
          result: 'not_measured',
          observedAt: null,
          detail: {reason: 'missing-config'},
        }),
      )
    }
    expect(observation(envelope, 'gateway', 'public-reachability').result).toBe('pass')
    expect(appOf(envelope, 'gateway').facts).toEqual({})
    expect(captured.stderr).toEqual([])
  })

  it('treats every unset host variable as missing config for just that app', async () => {
    const {ctx, captured} = createCapturedCtx()
    await withStatusEnv(async () => {
      delete process.env.UMAMI_DOMAIN
      delete process.env.DASHBOARD_DOMAIN
      delete process.env.VPN_HOST
      await unifiedStatusAction({json: true}, ctx, makeStatusDependencies())
    })
    const envelope = statusEnvelopeSchema.parse(JSON.parse(captured.stdout[0] ?? ''))

    expect(observation(envelope, 'umami', 'compose-services').result).toBe('not_measured')
    expect(observation(envelope, 'dashboard', 'compose-services').result).toBe('not_measured')
    expect(observation(envelope, 'vpn', 'wireguard-interface').result).toBe('not_measured')
    expect(observation(envelope, 'gateway', 'compose-services').result).toBe('pass')
  })

  it('probes cliproxy at the configured CLIPROXY_URL without a trailing slash', async () => {
    const seen: (string | undefined)[] = []
    const {ctx} = createCapturedCtx()
    await withStatusEnv(async () => {
      process.env.CLIPROXY_URL = 'https://proxy.example.com/'
      await unifiedStatusAction(
        {json: true},
        ctx,
        makeStatusDependencies({
          publicProbes: {
            cliproxy: async options => {
              seen.push(options?.baseUrl)
              return probeObservation()
            },
          },
        }),
      )
    })

    expect(seen).toEqual(['https://proxy.example.com'])
  })

  it('drops observations a collector returns but the app did not declare, and fills ones it forgot', async () => {
    const {envelope} = await runJson({
      getUmamiStatusSummary: async () => ({
        observations: [
          {
            id: 'surprise',
            kind: 'resource',
            source: 'ssh',
            result: 'fail',
            observedAt: FIXED_NOW.toISOString(),
          },
        ],
        facts: {},
      }),
    })

    expect(appOf(envelope, 'umami').observations.map(entry => entry.id)).toEqual(EXPECTED_OBSERVATION_IDS.umami)
    expect(observation(envelope, 'umami', 'compose-services')).toMatchObject({
      result: 'unknown',
      detail: {reason: 'missing-result'},
    })
  })

  it('marks only a hung collector unknown with reason timeout, and still prints within the deadline', async () => {
    const baseline = (await runJson()).envelope
    const started = performance.now()
    const {envelope, captured} = await runJson({
      collectorDeadlineMs: 25,
      getUmamiStatusSummary: () => new Promise(() => undefined),
    })

    expect(performance.now() - started).toBeLessThan(1000)
    expect(observation(envelope, 'umami', 'compose-services')).toMatchObject({
      result: 'unknown',
      source: 'ssh',
      observedAt: FIXED_NOW.toISOString(),
      detail: {reason: 'timeout'},
    })
    expect(observation(envelope, 'umami', 'public-reachability').result).toBe('pass')
    expect(observation(envelope, 'umami', 'deploy-state').result).toBe('not_measured')
    expect(appOf(envelope, 'umami').facts).toEqual({})
    for (const app of APPS.filter(name => name !== 'umami')) {
      expect(appOf(envelope, app)).toEqual(appOf(baseline, app))
    }
    expect(captured.stderr).toEqual([])
    expect(captured.exit).toBeNull()
  })

  it('times out every hung collector independently', async () => {
    const hang = () => new Promise<never>(() => undefined)
    const {envelope} = await runJson({
      collectorDeadlineMs: 25,
      getGatewayStatusSummary: hang,
      getVpnStatusSummary: hang,
    })

    expect(observation(envelope, 'gateway', 'workspace-memory').detail).toEqual({reason: 'timeout'})
    expect(observation(envelope, 'vpn', 'wireguard-interface').detail).toEqual({reason: 'timeout'})
    expect(observation(envelope, 'dashboard', 'compose-services').result).toBe('pass')
  })

  it('aborts the signal of a timed-out collector, killing its ssh child, and keeps the other apps intact', async () => {
    const baseline = (await runJson()).envelope
    const killed: string[] = []
    const signals: (AbortSignal | undefined)[] = []
    const hangingSpawn: SpawnFn = (_cmd, opts) => {
      signals.push(opts.signal)
      return hangingProc(opts.signal, () => killed.push('ssh'))
    }

    const started = performance.now()
    const {envelope, captured} = await runJson({
      collectorDeadlineMs: 25,
      getGatewayStatusSummary: (host, signal) => getGatewayStatusSummary(host, hangingSpawn, signal),
    })

    expect(performance.now() - started).toBeLessThan(1000)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(killed).toEqual(['ssh'])
    expect(observation(envelope, 'gateway', 'compose-services').detail).toEqual({reason: 'timeout'})
    expect(observation(envelope, 'gateway', 'workspace-memory').detail).toEqual({reason: 'timeout'})
    for (const app of APPS.filter(name => name !== 'gateway')) {
      expect(appOf(envelope, app)).toEqual(appOf(baseline, app))
    }
    expect(captured.stderr).toEqual([])
  })

  it('aborts the workspace probe spawn too when compose finishes but the probe hangs', async () => {
    const killed: string[] = []
    const spawn: SpawnFn = (cmd, opts) =>
      cmd.at(-1)?.includes('ps --format json') === true
        ? proc(JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}]))
        : hangingProc(opts.signal, () => killed.push('probe'))

    const {envelope} = await runJson({
      collectorDeadlineMs: 25,
      getGatewayStatusSummary: (host, signal) => getGatewayStatusSummary(host, spawn, signal),
    })

    expect(killed).toEqual(['probe'])
    expect(observation(envelope, 'gateway', 'compose-services').detail).toEqual({reason: 'timeout'})
  })

  it('never aborts the signal of a collector that finishes before its deadline', async () => {
    const signals: (AbortSignal | undefined)[] = []
    await runJson({
      getUmamiStatusSummary: async (_host, signal) => {
        signals.push(signal)
        return healthyUmami
      },
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
  })

  it('does not apply the collector deadline to the public probe', async () => {
    const {envelope} = await runJson({
      collectorDeadlineMs: 10,
      publicProbes: {
        ...makeStatusDependencies().publicProbes,
        umami: async () => {
          await Bun.sleep(60)
          return probeObservation()
        },
      },
    })

    expect(observation(envelope, 'umami', 'public-reachability').result).toBe('pass')
  })

  it('ignores a collector that rejects after its deadline', async () => {
    const {envelope} = await runJson({
      collectorDeadlineMs: 10,
      getUmamiStatusSummary: async () => {
        await Bun.sleep(40)
        throw new Error('late failure')
      },
    })
    await Bun.sleep(80)

    expect(observation(envelope, 'umami', 'compose-services').detail).toEqual({reason: 'timeout'})
  })

  it('probes the broker at BROKER_DOMAIN, adding https when it has no scheme', async () => {
    for (const [domain, expected] of [
      ['broker.example.com', 'https://broker.example.com'],
      ['https://broker.example.com', 'https://broker.example.com'],
    ] as const) {
      const seen: (string | undefined)[] = []
      const {ctx} = createCapturedCtx()
      await withStatusEnv(async () => {
        process.env.BROKER_DOMAIN = domain
        await unifiedStatusAction(
          {json: true},
          ctx,
          makeStatusDependencies({
            publicProbes: {
              broker: async options => {
                seen.push(options?.baseUrl)
                return probeObservation()
              },
            },
          }),
        )
      })

      expect(seen).toEqual([expected])
    }
  })

  it('probes the broker at the default origin when BROKER_DOMAIN is unset or empty, ignoring BROKER_HOST', async () => {
    for (const domain of [undefined, '']) {
      const seen: (string | undefined)[] = []
      const {ctx} = createCapturedCtx()
      await withStatusEnv(async () => {
        process.env.BROKER_HOST = '203.0.113.7'
        if (domain !== undefined) process.env.BROKER_DOMAIN = domain
        await unifiedStatusAction(
          {json: true},
          ctx,
          makeStatusDependencies({
            publicProbes: {
              broker: async options => {
                seen.push(options?.baseUrl)
                return probeObservation()
              },
            },
          }),
        )
      })

      expect(seen).toEqual([undefined])
    }
  })

  it('exits 0 even when every observation fails', async () => {
    const failing = async () => {
      throw new Error('down')
    }
    const {ctx, captured} = createCapturedCtx()
    await withStatusEnv(() =>
      unifiedStatusAction(
        {json: true},
        ctx,
        makeStatusDependencies({
          getKeewebStatusSummary: failing,
          getCliproxyStatusSummary: failing,
          getGatewayStatusSummary: failing,
          getUmamiStatusSummary: failing,
          getDashboardStatusSummary: failing,
          getVpnStatusSummary: failing,
          publicProbes: {keeweb: async () => probeObservation('fail')},
        }),
      ),
    )

    expect(captured.exit).toBeNull()
    expect(captured.stderr).toEqual([])
    expect(statusEnvelopeSchema.safeParse(JSON.parse(captured.stdout[0] ?? '')).success).toBe(true)
  })
})

describe('top-level status table (rendered from observations)', () => {
  it('pins the whole table for a healthy fleet', async () => {
    const captured = await runTable()

    expect(captured.stdout.join('\n')).toBe(
      [
        '| App | Reachability | Container | Deploy | End-to-end | Resource |',
        '| keeweb | ✅ pass | — | ⚪ not measured | — | — |',
        '| cliproxy | ✅ pass | ✅ pass | ⚪ not measured | ⚪ not measured | — |',
        '| gateway | ✅ pass | ✅ pass | ⚪ not measured | — | ✅ pass |',
        '| umami | ✅ pass | ✅ pass | ⚪ not measured | — | — |',
        '| dashboard | ✅ pass | ✅ pass | ⚪ not measured | — | — |',
        '| vpn | ⚪ not measured | ✅ pass | ⚪ not measured | ⚪ not measured | — |',
        '| broker | ✅ pass | — | ⚪ not measured | — | — |',
      ].join('\n'),
    )
    expect(captured.exit).toBeNull()
  })

  it('shows fail, unknown and not measured cells for a degraded fleet, keeping the other apps', async () => {
    const captured = await runTable({
      publicProbes: {
        ...makeStatusDependencies().publicProbes,
        umami: async () => probeObservation('fail'),
        broker: async () => probeObservation('unknown'),
      },
      getDashboardStatusSummary: async () => {
        throw new Error('Dashboard exploded')
      },
    })
    const lines = captured.stdout

    expect(lines).toContain('| umami | ❌ fail | ✅ pass | ⚪ not measured | — | — |')
    expect(lines).toContain('| broker | ❓ unknown | — | ⚪ not measured | — | — |')
    expect(lines).toContain('| dashboard | ✅ pass | ❓ unknown | ⚪ not measured | — | — |')
    expect(lines).toContain('| keeweb | ✅ pass | — | ⚪ not measured | — | — |')
    expect(captured.stderr).toEqual(['dashboard status check failed: Dashboard exploded'])
  })

  it('reports a timed-out collector on stderr in table mode and keeps the other rows', async () => {
    const captured = await runTable({
      collectorDeadlineMs: 25,
      getVpnStatusSummary: () => new Promise(() => undefined),
    })

    expect(captured.stdout).toContain('| vpn | ⚪ not measured | ❓ unknown | ⚪ not measured | ⚪ not measured | — |')
    expect(captured.stdout).toContain('| keeweb | ✅ pass | — | ⚪ not measured | — | — |')
    expect(captured.stderr).toEqual(['vpn status check timed out after 25ms'])
  })

  it('keeps stderr lines for rejected probes in table mode', async () => {
    const captured = await runTable({
      publicProbes: {
        ...makeStatusDependencies().publicProbes,
        dashboard: async () => {
          throw new Error('probe exploded')
        },
      },
    })

    expect(captured.stderr).toEqual(['dashboard status check failed: probe exploded'])
  })

  it('has the same number of cells in every row and never prints the structured workspace', async () => {
    const captured = await runTable()

    expect(captured.stdout).toHaveLength(8)
    expect(captured.stdout.every(line => line.startsWith('| ') && line.endsWith(' |'))).toBe(true)
    expect(captured.stdout.every(line => line.split(' | ').length === 6)).toBe(true)
    expect(captured.stdout.join('\n')).not.toContain('limitBytes')
  })
})

describe('top-level status with the real gateway collector', () => {
  const composeJson = JSON.stringify([
    {Name: 'gateway', State: 'running', Health: 'healthy'},
    {Name: 'workspace', State: 'running', Health: ''},
  ])

  const composeJsonGatewayExited = JSON.stringify([
    {Name: 'gateway', State: 'exited', Health: ''},
    {Name: 'workspace', State: 'running', Health: ''},
  ])

  it('passes container health and the resource check for a healthy gateway', async () => {
    const gateway = await runWithGateway(
      () => proc(workspaceStdout()),
      () => proc(composeJson),
    )

    expect(result(gateway, 'compose-services')?.result).toBe('pass')
    expect(result(gateway, 'workspace-memory')?.result).toBe('pass')
    expect(gateway.facts.workspace).toMatchObject({status: 'ok', limitBytes: LIMIT_BYTES, opencode: 'ready'})
    expect(gateway.facts.services).toEqual([
      {service: 'gateway', state: 'running', health: 'healthy'},
      {service: 'workspace', state: 'running', health: 'n-a'},
    ])
  })

  it('reports an unknown resource check and the unknown block when the workspace call fails', async () => {
    const gateway = await runWithGateway(
      () => proc('', 255),
      () => proc(composeJson),
    )

    expect(result(gateway, 'compose-services')?.result).toBe('pass')
    expect(result(gateway, 'workspace-memory')).toMatchObject({result: 'unknown', detail: {reason: 'probe-failed'}})
    expect(gateway.facts.workspace).toEqual({status: 'unknown', reason: 'SSH command failed (exit 255)'})
  })

  it('reports a zero limit in facts and a passing resource check when no limit is set', async () => {
    const gateway = await runWithGateway(
      () => proc(workspaceStdout({memory: 0, readyzSkipped: true})),
      () => proc(composeJson),
    )

    expect(result(gateway, 'workspace-memory')?.result).toBe('pass')
    expect(gateway.facts.workspace).toMatchObject({status: 'ok', limitBytes: 0, opencode: 'skipped'})
  })

  it('fails container health but keeps facts.workspace when a service is down and the workspace runs', async () => {
    const gateway = await runWithGateway(
      () => proc(workspaceStdout()),
      () => proc(composeJsonGatewayExited),
    )

    expect(result(gateway, 'compose-services')).toMatchObject({result: 'fail', detail: {reason: 'degraded'}})
    expect(result(gateway, 'workspace-memory')?.result).toBe('pass')
    expect(gateway.facts.workspace).toMatchObject({status: 'ok', opencode: 'ready'})
  })

  it('fails the resource check on OOM kills', async () => {
    const gateway = await runWithGateway(
      () => proc(workspaceStdout({oomKill: 2})),
      () => proc(composeJson),
    )

    expect(result(gateway, 'workspace-memory')).toMatchObject({result: 'fail', detail: {reason: 'oom-kill'}})
    expect(result(gateway, 'compose-services')?.result).toBe('pass')
  })

  it('fails the resource check when the supervisor reports degraded', async () => {
    const gateway = await runWithGateway(
      () => proc(workspaceStdout({readyz: DEGRADED_BODY})),
      () => proc(composeJson),
    )

    expect(result(gateway, 'workspace-memory')).toMatchObject({
      result: 'fail',
      detail: {reason: 'supervisor-degraded'},
    })
  })

  it('makes both gateway observations unknown and omits facts.workspace when ssh compose fails', async () => {
    const gateway = await runWithGateway(
      () => proc(workspaceStdout()),
      () => proc('', 1),
    )

    expect(result(gateway, 'compose-services')).toMatchObject({result: 'unknown', detail: {reason: 'compose-failed'}})
    expect(result(gateway, 'workspace-memory')).toMatchObject({
      result: 'unknown',
      detail: {reason: 'compose-unavailable'},
    })
    expect('workspace' in gateway.facts).toBe(false)
  })

  it('fails container health when compose lists no services', async () => {
    const gateway = await runWithGateway(
      () => proc(workspaceStdout()),
      () => proc(''),
    )

    expect(result(gateway, 'compose-services')).toMatchObject({result: 'fail', detail: {reason: 'no-services'}})
  })
})

describe('top-level status command (registerStatus wiring)', () => {
  it('wires through goke without throwing', async () => {
    const cli = goke('test')

    registerStatus(cli, makeStatusDependencies())
    cli.parse(['bun', 'test', 'status'], {run: false})

    // Verify the command runs without throwing (goke uses its own ctx for output)
    await expect(cli.runMatchedCommand()).resolves.toBeUndefined()
  })
})

function sshHost(cmd: string[]): string | undefined {
  return cmd.find(arg => /^(?:root|ubuntu)@/.test(arg))?.split('@')[1]
}

describe('top-level status with the real default dependencies (production wiring)', () => {
  const originalFetch = globalThis.fetch
  let spawnSpy: ReturnType<typeof spyOn<typeof Bun, 'spawn'>> | undefined

  afterEach(() => {
    globalThis.fetch = originalFetch
    spawnSpy?.mockRestore()
    spawnSpy = undefined
  })

  const composeNdjson = (...names: string[]) =>
    names.map(name => JSON.stringify({Name: name, State: 'running', Health: 'healthy'})).join('\n')

  function remoteStdout(cmd: string[]): string {
    if (cmd[0] === 'gh') return JSON.stringify([{createdAt: '2026-10-30T09:00:00Z', url: 'https://example.com/run/1'}])

    const command = cmd.at(-1) ?? ''
    switch (sshHost(cmd)) {
      case 'cliproxy.fro.bot':
        return 'eceasy/cli-proxy-api:v7.2.139\npostgres:16\n'
      case 'gateway.example.com':
        return command.includes('ps --format json')
          ? JSON.stringify([
              {Name: 'gateway', State: 'running', Health: 'healthy'},
              {Name: 'workspace', State: 'running', Health: ''},
            ])
          : workspaceStdout()
      case 'umami.example.com':
        return composeNdjson('umami', 'db')
      case 'dashboard.example.com':
        return composeNdjson('dashboard')
      case 'vpn.example.com':
        return 'interface: wg0\n  public key: SERVERKEY==\n  listening port: 51820\n\npeer: PEER1==\n  allowed ips: 10.8.0.2/32\n'
      default:
        return ''
    }
  }

  function fakeFetch(): typeof fetch {
    const responses: Record<string, () => Response> = {
      'https://kw.igg.ms/': () => new Response('<html>KeeWeb</html>', {status: 200}),
      'https://cliproxy.fro.bot/healthz': () => Response.json({status: 'ok'}),
      'https://broker.fro.bot/healthz': () => Response.json({status: 'ok'}),
      'https://metrics.fro.bot/api/heartbeat': () => Response.json({ok: true}),
      'https://dashboard.fro.bot/api/healthz': () => Response.json({status: 'ok'}),
      'https://dashboard.fro.bot/operator/health': () => Response.json({contractVersion: '2.4.0'}),
    }

    return Object.assign(
      async (input: string | URL | Request) => {
        const handler = responses[String(input)]
        return handler === undefined ? new Response('not found', {status: 404}) : handler()
      },
      {preconnect: originalFetch.preconnect},
    )
  }

  it('builds a valid envelope from mocked fetch and ssh output', async () => {
    globalThis.fetch = fakeFetch()
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) =>
      proc(remoteStdout(cmd))) as unknown as typeof Bun.spawn)
    const {ctx, captured} = createCapturedCtx()
    const savedKey = process.env.CLIPROXY_MANAGEMENT_KEY

    try {
      await withStatusEnv(async () => {
        process.env.CLIPROXY_MANAGEMENT_KEY = ''
        await unifiedStatusAction({json: true}, ctx)
      })
    } finally {
      if (savedKey === undefined) delete process.env.CLIPROXY_MANAGEMENT_KEY
      else process.env.CLIPROXY_MANAGEMENT_KEY = savedKey
    }

    expect(captured.stderr).toEqual([])
    expect(captured.stdout).toHaveLength(1)
    const envelope = statusEnvelopeSchema.parse(JSON.parse(captured.stdout[0] ?? ''))

    expect(envelope.apps.map(entry => entry.app)).toEqual([...APPS])
    expect(observation(envelope, 'gateway', 'public-reachability')).toMatchObject({
      result: 'pass',
      source: 'http',
      detail: {statusCode: 200, contractVersion: '2.4.0'},
    })
    expect(observation(envelope, 'gateway', 'compose-services')).toMatchObject({result: 'pass', source: 'ssh'})
    expect(observation(envelope, 'gateway', 'workspace-memory').result).toBe('pass')
    expect(observation(envelope, 'broker', 'public-reachability')).toMatchObject({
      result: 'pass',
      source: 'http',
      detail: {statusCode: 200},
    })
    expect(observation(envelope, 'umami', 'public-reachability').result).toBe('pass')
    expect(observation(envelope, 'vpn', 'wireguard-interface').result).toBe('pass')
    expect(appOf(envelope, 'gateway').facts.workspace).toMatchObject({status: 'ok', limitBytes: LIMIT_BYTES})
    expect(appOf(envelope, 'cliproxy').facts).toMatchObject({runningVersion: 'v7.2.139', managementAccess: 'no-key'})
    expect(appOf(envelope, 'keeweb').facts.lastDeploy).toBe('2026-10-30T09:00:00Z')
    expect(appOf(envelope, 'vpn').facts).toEqual({peerCount: 1, serverPublicKey: 'SERVERKEY=='})
  })
})
