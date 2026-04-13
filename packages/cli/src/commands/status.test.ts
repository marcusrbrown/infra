import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'
import {goke} from 'goke'

import {registerStatus} from './status'

declare const process: {
  exitCode?: number
}

describe('top-level status command', () => {
  let logSpy: {mockRestore: () => void; mock: {calls: unknown[][]}}

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => undefined)
    process.exitCode = 0
  })

  afterEach(() => {
    logSpy.mockRestore()
    process.exitCode = 0
  })

  async function runStatusCommand(
    args: string[],
    dependencies: Parameters<typeof registerStatus>[1],
  ): Promise<string[]> {
    const cli = goke('test')
    registerStatus(cli, dependencies)
    cli.parse(['bun', 'test', 'status', ...args], {run: false})
    await cli.runMatchedCommand()

    return logSpy.mock.calls.map((call: unknown[]) => call.map((value: unknown) => String(value)).join(' '))
  }

  it('prints a unified table when both apps are healthy', async () => {
    const lines = await runStatusCommand([], {
      getKeewebStatusSummary: async () => ({
        app: 'keeweb',
        http: 'OK',
        lastDeploy: '2026-04-12 10:00',
        version: '—',
        contentHash: 'match',
        usageStats: '—',
      }),
      getCliproxyStatusSummary: async () => ({
        app: 'cliproxy',
        http: 'OK',
        lastDeploy: '—',
        version: 'v1.2.3',
        contentHash: '—',
        usageStats: '12 req / 0 fail',
      }),
    })

    expect(lines).toContain('| App | HTTP | Last Deploy | Version | Content Hash | Usage Stats |')
    expect(lines).toContain('| keeweb | OK | 2026-04-12 10:00 | — | match | — |')
    expect(lines).toContain('| cliproxy | OK | — | v1.2.3 | — | 12 req / 0 fail |')
  })

  it('shows an error row when one app fails and keeps the other result', async () => {
    const lines = await runStatusCommand([], {
      getKeewebStatusSummary: async () => {
        throw new Error('Keeweb exploded')
      },
      getCliproxyStatusSummary: async () => ({
        app: 'cliproxy',
        http: 'OK',
        lastDeploy: '—',
        version: 'v1.2.3',
        contentHash: '—',
        usageStats: '12 req / 0 fail',
      }),
    })

    expect(lines).toContain(
      '| keeweb | ❌ Keeweb exploded | ❌ Keeweb exploded | ❌ Keeweb exploded | ❌ Keeweb exploded | ❌ Keeweb exploded |',
    )
    expect(lines).toContain('| cliproxy | OK | — | v1.2.3 | — | 12 req / 0 fail |')
  })

  it('prints valid json with both app keys when --json is passed', async () => {
    const lines = await runStatusCommand(['--json'], {
      getKeewebStatusSummary: async () => ({
        app: 'keeweb',
        http: 'OK',
        lastDeploy: '2026-04-12 10:00',
        version: '—',
        contentHash: 'match',
        usageStats: '—',
      }),
      getCliproxyStatusSummary: async () => ({
        app: 'cliproxy',
        http: 'OK',
        lastDeploy: '—',
        version: 'v1.2.3',
        contentHash: '—',
        usageStats: '12 req / 0 fail',
      }),
    })

    expect(lines).toHaveLength(1)

    const [jsonOutput] = lines
    expect(jsonOutput).toBeDefined()

    const parsed = JSON.parse(jsonOutput ?? '{}') as {
      keeweb: {http: string}
      cliproxy: {version: string}
    }

    expect(parsed.keeweb.http).toBe('OK')
    expect(parsed.cliproxy.version).toBe('v1.2.3')
  })
})
