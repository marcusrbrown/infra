import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {streamUmamiLogs, type LogsSpawnFn, type StreamLogsOpts} from './logs'

// ─── streamUmamiLogs ─────────────────────────────────────────────────────────

function makeLogsSpawn(exitCode = 0): LogsSpawnFn {
  return (_cmd, _opts) => ({exited: Promise.resolve(exitCode)})
}

describe('logs command', () => {
  let originalCI: string | undefined
  let originalUmamiDomain: string | undefined

  beforeEach(() => {
    originalCI = process.env.CI
    originalUmamiDomain = process.env.UMAMI_DOMAIN
  })

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = originalCI
    }

    if (originalUmamiDomain === undefined) {
      delete process.env.UMAMI_DOMAIN
    } else {
      process.env.UMAMI_DOMAIN = originalUmamiDomain
    }
  })

  it('refuses to stream logs in CI without --allow-ci', async () => {
    process.env.CI = 'true'

    const opts: StreamLogsOpts = {
      host: 'metrics.fro.bot',
      service: 'umami',
      tail: 100,
      allowCi: false,
    }

    const messages: string[] = []
    const result = await streamUmamiLogs(opts, makeLogsSpawn(), msg => messages.push(msg))

    expect(result.refused).toBe(true)
    expect(messages.join('')).toContain('Refusing to stream logs in CI')
  })

  it('proceeds in CI when --allow-ci is set', async () => {
    process.env.CI = 'true'

    const opts: StreamLogsOpts = {
      host: 'metrics.fro.bot',
      service: 'umami',
      tail: 100,
      allowCi: true,
    }

    const warnings: string[] = []
    const result = await streamUmamiLogs(opts, makeLogsSpawn(), undefined, msg => warnings.push(msg))

    expect(result.refused).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  it('always emits a sensitive-data warning to stderr', async () => {
    delete process.env.CI

    const opts: StreamLogsOpts = {
      host: 'metrics.fro.bot',
      service: 'umami',
      tail: 100,
      allowCi: false,
    }

    const warnings: string[] = []
    await streamUmamiLogs(opts, makeLogsSpawn(), undefined, msg => warnings.push(msg))

    expect(warnings.join('')).toContain('sensitive')
  })

  it('rejects invalid host before spawning SSH', async () => {
    delete process.env.CI

    const opts: StreamLogsOpts = {
      host: '-oProxyCommand=evil',
      service: 'umami',
      tail: 100,
      allowCi: false,
    }

    let spawnCalled = false
    const spy: LogsSpawnFn = (_cmd, _opts) => {
      spawnCalled = true
      return {exited: Promise.resolve(0)}
    }

    await expect(streamUmamiLogs(opts, spy)).rejects.toThrow('Invalid UMAMI_DOMAIN')
    expect(spawnCalled).toBe(false)
  })

  it('returns exitCode from the SSH subprocess', async () => {
    delete process.env.CI

    const opts: StreamLogsOpts = {
      host: 'metrics.fro.bot',
      service: 'umami',
      tail: 50,
      allowCi: false,
    }

    const result = await streamUmamiLogs(opts, makeLogsSpawn(42))

    expect(result.refused).toBe(false)
    expect(result.exitCode).toBe(42)
  })
})
