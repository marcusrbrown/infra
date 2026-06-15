import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {streamDashboardLogs, type LogsSpawnFn, type StreamLogsOpts} from './logs'

// ─── Capturing spawn helper ───────────────────────────────────────────────────

function makeCapturingLogsSpawn(exitCode = 0): {spawn: LogsSpawnFn; capturedCmd: () => string[]} {
  let captured: string[] = []
  const spawn: LogsSpawnFn = (cmd, _opts) => {
    captured = [...cmd]
    return {exited: Promise.resolve(exitCode)}
  }
  return {spawn, capturedCmd: () => captured}
}

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

// ─── SSH identity injection (DASHBOARD_SSH_KEY) ───────────────────────────────

describe('streamDashboardLogs — SSH identity injection', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {
      CI: process.env.CI,
      DASHBOARD_SSH_KEY: process.env.DASHBOARD_SSH_KEY,
    }
    delete process.env.CI
  })

  afterEach(() => {
    if (originalEnv.CI === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = originalEnv.CI
    }

    if (originalEnv.DASHBOARD_SSH_KEY === undefined) {
      delete process.env.DASHBOARD_SSH_KEY
    } else {
      process.env.DASHBOARD_SSH_KEY = originalEnv.DASHBOARD_SSH_KEY
    }
  })

  it('includes -i <path> and IdentitiesOnly=yes in ssh argv when DASHBOARD_SSH_KEY is set', async () => {
    process.env.DASHBOARD_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'

    const {spawn, capturedCmd} = makeCapturingLogsSpawn(0)

    await streamDashboardLogs({host: 'dashboard.fro.bot', service: 'dashboard', tail: 100, allowCi: false}, spawn)

    const cmd = capturedCmd()
    const iIdx = cmd.indexOf('-i')
    expect(iIdx).toBeGreaterThan(-1)
    expect(cmd[iIdx + 1]).toBeTruthy()

    const identitiesOnlyIdx = cmd.indexOf('IdentitiesOnly=yes')
    expect(identitiesOnlyIdx).toBeGreaterThan(-1)

    const destination = cmd.find(arg => arg.includes('@'))
    expect(destination).toBe('root@dashboard.fro.bot')
  })

  it('does not include -i or IdentitiesOnly=yes when DASHBOARD_SSH_KEY is absent', async () => {
    delete process.env.DASHBOARD_SSH_KEY

    const {spawn, capturedCmd} = makeCapturingLogsSpawn(0)

    await streamDashboardLogs({host: 'dashboard.fro.bot', service: 'dashboard', tail: 100, allowCi: false}, spawn)

    const cmd = capturedCmd()
    expect(cmd.indexOf('-i')).toBe(-1)
    expect(cmd.indexOf('IdentitiesOnly=yes')).toBe(-1)
  })

  it('cleans up the temp key file after the SSH command completes', async () => {
    const {statSync} = await import('node:fs')
    process.env.DASHBOARD_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'

    let capturedKeyPath: string | undefined
    const capturingSpawn: LogsSpawnFn = (cmd, _opts) => {
      const iIdx = cmd.indexOf('-i')
      if (iIdx !== -1) capturedKeyPath = cmd[iIdx + 1]
      return {exited: Promise.resolve(0)}
    }

    await streamDashboardLogs(
      {host: 'dashboard.fro.bot', service: 'dashboard', tail: 100, allowCi: false},
      capturingSpawn,
    )

    expect(capturedKeyPath).toBeTruthy()
    const keyPath = capturedKeyPath
    if (keyPath) {
      expect(() => statSync(keyPath)).toThrow()
    }
  })
})
