import type {StatusEnvelope} from '../status/observation'
import type {SpawnFn} from './gateway/status'
import {describe, expect, it} from 'bun:test'
import {goke} from 'goke'
import {createCapturedCtx} from '../lib/mcp-ctx-fixture'
import {STATUS_SCHEMA_VERSION, statusEnvelopeSchema} from '../status/observation'
import {
  EXPECTED_OBSERVATION_IDS,
  FIXED_NOW,
  healthyGateway,
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

  it('makes only the gateway collector observations unknown when it rejects, and still writes the stderr line', async () => {
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
    expect(captured.stderr).toEqual(['gateway status check failed: Gateway exploded'])
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
    expect(captured.stderr).toEqual(['keeweb status check failed: Keeweb exploded'])
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
    expect(captured.stderr).toEqual(['dashboard status check failed: probe exploded'])
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
    expect(captured.stderr).toHaveLength(6)
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
