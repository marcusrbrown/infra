import type {StatusSummary} from './status'
import {describe, expect, it} from 'bun:test'
import {goke} from 'goke'
import {createCapturedCtx, expectCapturedToInclude} from '../__test__/mcp-ctx-fixture'
import {registerStatus, unifiedStatusAction} from './status'

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
  version: 'v1.2.3',
  contentHash: '—',
  usageStats: '12 req / 0 fail',
}

const healthyGateway: StatusSummary = {
  app: 'gateway',
  http: 'OK: gateway:running/healthy',
  lastDeploy: '—',
  version: '—',
  contentHash: '—',
  usageStats: '—',
}

function makeDeps(overrides?: Partial<Parameters<typeof registerStatus>[1]>): Parameters<typeof registerStatus>[1] {
  return {
    getKeewebStatusSummary: async () => healthyKeeweb,
    getCliproxyStatusSummary: async () => healthyCliproxy,
    getGatewayStatusSummary: async () => healthyGateway,
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
    expect(expectCapturedToInclude(captured, '| cliproxy | OK | — | v1.2.3 | — | 12 req / 0 fail |')).toBe(true)
    expect(expectCapturedToInclude(captured, '| gateway | OK: gateway:running/healthy | — | — | — | — |')).toBe(true)
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
    expect(expectCapturedToInclude(captured, '| cliproxy | OK | — | v1.2.3 | — | 12 req / 0 fail |')).toBe(true)
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
    }

    expect(parsed.keeweb.http).toBe('OK')
    expect(parsed.cliproxy.version).toBe('v1.2.3')
    expect(parsed.gateway.http).toBe('OK: gateway:running/healthy')
  })

  it('does not write to global console (output is captured via ctx)', async () => {
    const {ctx, captured} = createCapturedCtx()

    await unifiedStatusAction({}, ctx, makeDeps())

    // Verify output went to ctx capture, not global console
    expect(captured.stdout.length).toBeGreaterThan(0)
    expect(expectCapturedToInclude(captured, '| App |')).toBe(true)
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
