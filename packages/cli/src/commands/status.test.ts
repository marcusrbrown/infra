import type {SpawnFn} from './gateway/status'
import type {WorkspaceMemoryStatus} from './gateway/workspace-memory'
import type {StatusSummary} from './status'
import {describe, expect, it} from 'bun:test'
import {goke} from 'goke'
import {createCapturedCtx, expectCapturedToInclude} from '../lib/mcp-ctx-fixture'
import {LIMIT_BYTES, MIB, STARTED_AT, workspaceStdout} from './gateway/__fixtures__/workspace-probe'
import {getGatewayStatusSummary} from './gateway/status'
import {registerStatus, unifiedStatusAction} from './status'

// NOTE: dashboard is included in the unified status table alongside the other apps.

const healthyKeeweb: StatusSummary = {
  app: 'keeweb',
  http: 'OK',
  lastDeploy: '2026-04-12 10:00',
  version: '—',
  contentHash: 'match',
  usageStats: '—',
}

const healthyCliproxy: StatusSummary = {
  app: 'cliproxy',
  http: 'OK',
  lastDeploy: '—',
  version: 'v1.2.3 (latest v1.2.4)',
  contentHash: '—',
  usageStats: '12 req / 0 fail',
}

const okWorkspace: WorkspaceMemoryStatus = {
  status: 'ok',
  limitBytes: LIMIT_BYTES,
  currentBytes: 412 * MIB,
  maxEvents: 0,
  oomKills: 0,
  oomKilled: false,
  restartCount: 0,
  startedAt: STARTED_AT,
  opencode: 'ready',
}

const healthyGateway: StatusSummary = {
  app: 'gateway',
  http: 'OK: gateway:running/healthy; workspace mem=412/896MiB oom_kills=0 opencode=ready',
  lastDeploy: '—',
  version: '—',
  contentHash: '—',
  usageStats: '—',
  workspace: okWorkspace,
}

const healthyUmami: StatusSummary = {
  app: 'umami',
  http: 'OK: umami:running/healthy',
  lastDeploy: '—',
  version: '—',
  contentHash: '—',
  usageStats: '—',
}

const healthyVpn: StatusSummary = {
  app: 'vpn',
  http: 'OK: wg0 up, pubkey:TESTKEY== 1 peer(s)',
  lastDeploy: '—',
  version: '—',
  contentHash: '—',
  usageStats: '—',
}

const healthyDashboard: StatusSummary = {
  app: 'dashboard',
  http: 'OK: dashboard:running/healthy',
  lastDeploy: '—',
  version: '—',
  contentHash: '—',
  usageStats: '—',
}

const healthyBroker: StatusSummary = {
  app: 'broker',
  http: 'OK: GET https://broker.fro.bot/healthz → 200 (42ms)',
  lastDeploy: '—',
  version: '—',
  contentHash: '—',
  usageStats: '—',
}

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

function makeDeps(overrides?: Partial<Parameters<typeof registerStatus>[1]>): Parameters<typeof registerStatus>[1] {
  return {
    getKeewebStatusSummary: async () => healthyKeeweb,
    getCliproxyStatusSummary: async () => healthyCliproxy,
    getGatewayStatusSummary: async () => healthyGateway,
    getUmamiStatusSummary: async () => healthyUmami,
    getDashboardStatusSummary: async () => healthyDashboard,
    getVpnStatusSummary: async () => healthyVpn,
    getBrokerStatusSummary: async () => healthyBroker,
    ...overrides,
  }
}

describe('top-level status command (Tier-2 ctx capture)', () => {
  it('prints a unified table when all apps are healthy', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction({}, ctx, makeDeps())

    expect(
      expectCapturedToInclude(captured, '| App | HTTP | Last Deploy | Version | Content Hash | Usage Stats |'),
    ).toBe(true)
    expect(expectCapturedToInclude(captured, '| keeweb | OK | 2026-04-12 10:00 | — | match | — |')).toBe(true)
    expect(
      expectCapturedToInclude(captured, '| cliproxy | OK | — | v1.2.3 (latest v1.2.4) | — | 12 req / 0 fail |'),
    ).toBe(true)
    expect(
      expectCapturedToInclude(
        captured,
        '| gateway | OK: gateway:running/healthy; workspace mem=412/896MiB oom_kills=0 opencode=ready | — | — | — | — |',
      ),
    ).toBe(true)
    expect(expectCapturedToInclude(captured, '| umami | OK: umami:running/healthy | — | — | — | — |')).toBe(true)
    expect(expectCapturedToInclude(captured, '| dashboard | OK: dashboard:running/healthy | — | — | — | — |')).toBe(
      true,
    )
    expect(expectCapturedToInclude(captured, '| vpn | OK: wg0 up, pubkey:TESTKEY== 1 peer(s) | — | — | — | — |')).toBe(
      true,
    )
  })

  it('includes a vpn row sourced from getVpnStatusSummary()', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction({}, ctx, makeDeps())

    // The vpn row must appear in the table output
    expect(expectCapturedToInclude(captured, '| vpn |')).toBe(true)
  })

  it('shows an error row for vpn when getVpnStatusSummary rejects', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction(
      {},
      ctx,
      makeDeps({
        getVpnStatusSummary: async () => {
          throw new Error('VPN_HOST not set')
        },
      }),
    )

    expect(
      expectCapturedToInclude(
        captured,
        '| vpn | ❌ VPN_HOST not set | ❌ VPN_HOST not set | ❌ VPN_HOST not set | ❌ VPN_HOST not set | ❌ VPN_HOST not set |',
      ),
    ).toBe(true)
    expect(captured.stderr.join('')).toContain('vpn status check failed: VPN_HOST not set')
  })

  it('shows an error row when umami is unreachable and keeps the other results', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction(
      {},
      ctx,
      makeDeps({
        getUmamiStatusSummary: async () => {
          throw new Error('UMAMI_DOMAIN not set')
        },
      }),
    )

    expect(
      expectCapturedToInclude(
        captured,
        '| umami | ❌ UMAMI_DOMAIN not set | ❌ UMAMI_DOMAIN not set | ❌ UMAMI_DOMAIN not set | ❌ UMAMI_DOMAIN not set | ❌ UMAMI_DOMAIN not set |',
      ),
    ).toBe(true)
    expect(
      expectCapturedToInclude(
        captured,
        '| gateway | OK: gateway:running/healthy; workspace mem=412/896MiB oom_kills=0 opencode=ready | — | — | — | — |',
      ),
    ).toBe(true)
    expect(captured.stderr.join('')).toContain('umami status check failed: UMAMI_DOMAIN not set')
  })

  it('shows an error row when one app fails and keeps the other results', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction(
      {},
      ctx,
      makeDeps({
        getKeewebStatusSummary: async () => {
          throw new Error('Keeweb exploded')
        },
      }),
    )

    expect(
      expectCapturedToInclude(
        captured,
        '| keeweb | ❌ Keeweb exploded | ❌ Keeweb exploded | ❌ Keeweb exploded | ❌ Keeweb exploded | ❌ Keeweb exploded |',
      ),
    ).toBe(true)
    expect(
      expectCapturedToInclude(captured, '| cliproxy | OK | — | v1.2.3 (latest v1.2.4) | — | 12 req / 0 fail |'),
    ).toBe(true)
    // Rejection reason must also appear in stderr so MCP consumers can see it
    expect(captured.stderr.join('')).toContain('keeweb status check failed: Keeweb exploded')
  })

  it('prints valid json with all app keys when --json is passed', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction({json: true}, ctx, makeDeps())

    expect(captured.stdout).toHaveLength(1)

    const [jsonOutput] = captured.stdout
    expect(jsonOutput).toBeDefined()

    const parsed = JSON.parse(jsonOutput ?? '{}') as {
      keeweb: {http: string}
      cliproxy: {version: string}
      gateway: {http: string}
      umami: {http: string}
      dashboard: {http: string}
      vpn: {http: string}
      broker: {http: string}
    }

    expect(parsed.keeweb.http).toBe('OK')
    expect(parsed.cliproxy.version).toBe('v1.2.3 (latest v1.2.4)')
    expect(parsed.gateway.http).toBe('OK: gateway:running/healthy; workspace mem=412/896MiB oom_kills=0 opencode=ready')
    expect(parsed.umami.http).toBe('OK: umami:running/healthy')
    expect(parsed.dashboard.http).toBe('OK: dashboard:running/healthy')
    expect(parsed.vpn.http).toBe('OK: wg0 up, pubkey:TESTKEY== 1 peer(s)')
    expect(parsed.broker.http).toContain('OK')
  })

  it('serializes the structured workspace status for gateway in --json output', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction({json: true}, ctx, makeDeps())

    const parsed = JSON.parse(captured.stdout[0] ?? '{}') as {gateway: {workspace?: WorkspaceMemoryStatus}}

    expect(parsed.gateway.workspace).toEqual(okWorkspace)
  })

  it('serializes an unknown workspace status with its reason', async () => {
    const {ctx, captured} = createCapturedCtx()
    const unknownWorkspace: WorkspaceMemoryStatus = {status: 'unknown', reason: 'timed out after 10s'}

    await unifiedStatusAction(
      {json: true},
      ctx,
      makeDeps({
        getGatewayStatusSummary: async () => ({
          ...healthyGateway,
          http: 'OK: gateway:running/healthy; workspace=unknown',
          workspace: unknownWorkspace,
        }),
      }),
    )

    const parsed = JSON.parse(captured.stdout[0] ?? '{}') as {
      gateway: {http: string; workspace?: WorkspaceMemoryStatus}
    }

    expect(parsed.gateway.workspace).toEqual(unknownWorkspace)
    expect(parsed.gateway.http).toBe('OK: gateway:running/healthy; workspace=unknown')
  })

  it('omits the workspace key for every app except gateway', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction({json: true}, ctx, makeDeps())

    const parsed = JSON.parse(captured.stdout[0] ?? '{}') as Record<string, object>

    for (const app of ['keeweb', 'cliproxy', 'umami', 'dashboard', 'vpn', 'broker']) {
      expect(parsed[app]).toBeDefined()
      expect('workspace' in (parsed[app] ?? {})).toBe(false)
    }
    expect('workspace' in (parsed.gateway ?? {})).toBe(true)
  })

  it('keeps the table to the six existing columns and never prints the structured workspace', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction({}, ctx, makeDeps())

    expect(captured.stdout).toHaveLength(8)
    expect(captured.stdout.every(line => line.startsWith('| ') && line.endsWith(' |'))).toBe(true)
    expect(captured.stdout.every(line => line.split(' | ').length === 6)).toBe(true)
    expect(captured.stdout.join('\n')).not.toContain('limitBytes')
    expect(captured.stdout.join('\n')).not.toContain('"workspace"')
  })

  describe('with the real gateway summary', () => {
    const composeJson = JSON.stringify([
      {Name: 'gateway', State: 'running', Health: 'healthy'},
      {Name: 'workspace', State: 'running', Health: ''},
    ])

    const composeJsonGatewayExited = JSON.stringify([
      {Name: 'gateway', State: 'exited', Health: ''},
      {Name: 'workspace', State: 'running', Health: ''},
    ])

    async function runWithGateway(
      workspaceOutput: () => ReturnType<SpawnFn>,
      composeOutput: () => ReturnType<SpawnFn>,
    ) {
      const spawn: SpawnFn = cmd =>
        cmd.at(-1)?.includes('ps --format json') === true ? composeOutput() : workspaceOutput()
      const originalHost = process.env.GATEWAY_HOST
      process.env.GATEWAY_HOST = 'gateway.example.com'
      try {
        const {ctx, captured} = createCapturedCtx()
        await unifiedStatusAction(
          {json: true},
          ctx,
          makeDeps({getGatewayStatusSummary: host => getGatewayStatusSummary(host, spawn)}),
        )
        const parsed = JSON.parse(captured.stdout[0] ?? '{}') as {
          gateway: {http: string; workspace?: WorkspaceMemoryStatus}
        }
        return parsed.gateway
      } finally {
        if (originalHost === undefined) delete process.env.GATEWAY_HOST
        else process.env.GATEWAY_HOST = originalHost
      }
    }

    it('reports workspace=unknown in the string and the structured field when the extra call fails', async () => {
      const gateway = await runWithGateway(
        () => proc('', 255),
        () => proc(composeJson),
      )

      expect(gateway.http).toBe('OK: gateway:running/healthy, workspace:running/n-a; workspace=unknown')
      expect(gateway.workspace?.status).toBe('unknown')
    })

    it('reports limit=none in the string and a zero limit in the structured field', async () => {
      const gateway = await runWithGateway(
        () => proc(workspaceStdout({memory: 0, readyzSkipped: true})),
        () => proc(composeJson),
      )

      expect(gateway.http).toBe(
        'OK: gateway:running/healthy, workspace:running/n-a; workspace mem=412MiB limit=none oom_kills=0 opencode=skipped',
      )
      expect(gateway.workspace).toMatchObject({status: 'ok', limitBytes: 0, opencode: 'skipped'})
    })

    it('keeps gateway.workspace in --json when a service is down but the workspace is running', async () => {
      const gateway = await runWithGateway(
        () => proc(workspaceStdout()),
        () => proc(composeJsonGatewayExited),
      )

      expect(
        gateway.http.startsWith('DEGRADED: gateway:exited/n-a, workspace:running/n-a; workspace mem=412/896MiB'),
      ).toBe(true)
      expect(gateway.workspace).toMatchObject({status: 'ok', opencode: 'ready'})
    })

    it('omits gateway.workspace when compose returns no services', async () => {
      const gateway = await runWithGateway(
        () => proc(workspaceStdout()),
        () => proc('', 1),
      )

      expect(gateway.http.startsWith('ERROR:')).toBe(true)
      expect('workspace' in gateway).toBe(false)
    })
  })

  it('does not write to global console (output is captured via ctx)', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction({}, ctx, makeDeps())

    // Verify output went to ctx capture, not global console
    expect(captured.stdout.length).toBeGreaterThan(0)
    expect(expectCapturedToInclude(captured, '| App |')).toBe(true)
  })

  it('renders an equal cliproxy version as the latest marker', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction(
      {},
      ctx,
      makeDeps({
        getCliproxyStatusSummary: async () => ({...healthyCliproxy, version: 'v1.2.3 (latest)'}),
      }),
    )

    expect(expectCapturedToInclude(captured, '| cliproxy | OK | — | v1.2.3 (latest) | — | 12 req / 0 fail |')).toBe(
      true,
    )
  })

  it('keeps every compact version branch scannable in the unified table', async () => {
    const branches = [
      ['v1.2.3 (latest)', 'v1.2.3 (latest)'],
      ['v1.2.3 (latest v1.2.4)', 'v1.2.3 (latest v1.2.4)'],
      ['unknown (latest v1.2.4)', 'unknown (latest v1.2.4)'],
      ['v1.2.3 (latest unknown)', 'v1.2.3 (latest unknown)'],
      ['v1.2.3 (latest: no key)', 'v1.2.3 (latest: no key)'],
      ['unknown', 'unknown'],
    ] as const

    for (const [version, expected] of branches) {
      const {ctx, captured} = createCapturedCtx()
      await unifiedStatusAction(
        {},
        ctx,
        makeDeps({getCliproxyStatusSummary: async () => ({...healthyCliproxy, version})}),
      )

      expect(expectCapturedToInclude(captured, `| cliproxy | OK | — | ${expected} | — | 12 req / 0 fail |`)).toBe(true)
    }
  })
})

describe('top-level status command (registerStatus wiring)', () => {
  it('wires through goke without throwing', async () => {
    const cli = goke('test')

    registerStatus(cli, makeDeps())
    cli.parse(['bun', 'test', 'status'], {run: false})

    // Verify the command runs without throwing (goke uses its own ctx for output)
    await expect(cli.runMatchedCommand()).resolves.toBeUndefined()
  })
})
