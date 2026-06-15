import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {streamDashboardLogs, type LogsSpawnFn, type StreamLogsOpts} from './logs'

// NOTE: dashboard logs is intentionally CLI-only and NOT in the MCP allowlist.
// Logs may contain sensitive data (DB passwords, app secrets, user data).

// ─── streamDashboardLogs ─────────────────────────────────────────────────────

function makeLogsSpawn(exitCode = 0): LogsSpawnFn {
  return (_cmd, _opts) => ({exited: Promise.resolve(exitCode)})
}

describe('logs command', () => {
  let originalCI: string | undefined
  let originalDashboardDomain: string | undefined

  beforeEach(() => {
    originalCI = process.env.CI
    originalDashboardDomain = process.env.DASHBOARD_DOMAIN
  })

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = originalCI
    }

    if (originalDashboardDomain === undefined) {
      delete process.env.DASHBOARD_DOMAIN
    } else {
      process.env.DASHBOARD_DOMAIN = originalDashboardDomain
    }
  })

  it('refuses to stream logs in CI without --allow-ci', async () => {
    process.env.CI = 'true'

    const opts: StreamLogsOpts = {
      host: 'dashboard.fro.bot',
      service: 'dashboard',
      tail: 100,
      allowCi: false,
    }

    const messages: string[] = []
    const result = await streamDashboardLogs(opts, makeLogsSpawn(), msg => messages.push(msg))

    expect(result.refused).toBe(true)
    expect(messages.join('')).toContain('Refusing to stream logs in CI')
  })

  it('proceeds in CI when --allow-ci is set', async () => {
    process.env.CI = 'true'

    const opts: StreamLogsOpts = {
      host: 'dashboard.fro.bot',
      service: 'dashboard',
      tail: 100,
      allowCi: true,
    }

    const warnings: string[] = []
    const result = await streamDashboardLogs(opts, makeLogsSpawn(), undefined, msg => warnings.push(msg))

    expect(result.refused).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  it('always emits a sensitive-data warning to stderr', async () => {
    delete process.env.CI

    const opts: StreamLogsOpts = {
      host: 'dashboard.fro.bot',
      service: 'dashboard',
      tail: 100,
      allowCi: false,
    }

    const warnings: string[] = []
    await streamDashboardLogs(opts, makeLogsSpawn(), undefined, msg => warnings.push(msg))

    expect(warnings.join('')).toContain('sensitive')
  })

  it('rejects invalid host before spawning SSH', async () => {
    delete process.env.CI

    const opts: StreamLogsOpts = {
      host: '-oProxyCommand=evil',
      service: 'dashboard',
      tail: 100,
      allowCi: false,
    }

    let spawnCalled = false
    const spy: LogsSpawnFn = (_cmd, _opts) => {
      spawnCalled = true
      return {exited: Promise.resolve(0)}
    }

    await expect(streamDashboardLogs(opts, spy)).rejects.toThrow('Invalid DASHBOARD_DOMAIN')
    expect(spawnCalled).toBe(false)
  })

  it('returns exitCode from the SSH subprocess', async () => {
    delete process.env.CI

    const opts: StreamLogsOpts = {
      host: 'dashboard.fro.bot',
      service: 'dashboard',
      tail: 50,
      allowCi: false,
    }

    const result = await streamDashboardLogs(opts, makeLogsSpawn(42))

    expect(result.refused).toBe(false)
    expect(result.exitCode).toBe(42)
  })

  it('accepts caddy as a valid service', async () => {
    delete process.env.CI

    const opts: StreamLogsOpts = {
      host: 'dashboard.fro.bot',
      service: 'caddy',
      tail: 100,
      allowCi: false,
    }

    const result = await streamDashboardLogs(opts, makeLogsSpawn(0))
    expect(result.refused).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  it('rejects an unknown service when called directly (bypassing the CLI action)', async () => {
    delete process.env.CI

    const opts: StreamLogsOpts = {
      host: 'dashboard.fro.bot',
      service: 'notaservice',
      tail: 100,
      allowCi: false,
    }

    let spawnCalled = false
    const spy: LogsSpawnFn = (_cmd, _opts) => {
      spawnCalled = true
      return {exited: Promise.resolve(0)}
    }

    await expect(streamDashboardLogs(opts, spy)).rejects.toThrow(/Invalid service/)
    expect(spawnCalled).toBe(false)
  })
})

// ─── SSH command includes repo-pinned UserKnownHostsFile ─────────────────────

describe('streamDashboardLogs — SSH command includes UserKnownHostsFile', () => {
  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to ssh', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: LogsSpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamDashboardLogs(
      {host: 'dashboard.fro.bot', service: 'dashboard', tail: 100, allowCi: false},
      spawnCapture,
    )

    const knownHostsIdx = capturedCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
    expect(knownHostsIdx).toBeGreaterThan(-1)
    expect(capturedCmd[knownHostsIdx - 1]).toBe('-o')
    expect(capturedCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)
  })

  it('does not weaken StrictHostKeyChecking when UserKnownHostsFile is added', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: LogsSpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamDashboardLogs(
      {host: 'dashboard.fro.bot', service: 'dashboard', tail: 100, allowCi: false},
      spawnCapture,
    )

    const strictIdx = capturedCmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
    expect(strictIdx).toBeGreaterThan(-1)
    expect(capturedCmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
  })
})
