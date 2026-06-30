import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {streamBrokerLogs} from './logs'

// ─── SpawnFn type ─────────────────────────────────────────────────────────────

type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'inherit'; stderr: 'inherit'},
) => {
  exited: Promise<number>
}

function makeNeverSpawn(): SpawnFn {
  return () => {
    throw new Error('spawn should not have been called')
  }
}

function makeSpawnOk(): SpawnFn {
  return (_cmd, _opts) => ({exited: Promise.resolve(0)})
}

// ─── streamBrokerLogs — host validation ──────────────────────────────────────

describe('streamBrokerLogs — host validation', () => {
  it('rejects a leading-hyphen host and does not invoke ssh', async () => {
    delete process.env.CI

    await expect(
      streamBrokerLogs({host: '-oProxyCommand=evil', tail: 100, service: 'broker', allowCi: false}, makeNeverSpawn()),
    ).rejects.toThrow('Invalid BROKER_HOST')
  })

  it('rejects a host with shell metacharacters and does not invoke ssh', async () => {
    delete process.env.CI

    await expect(
      streamBrokerLogs(
        {host: 'broker.example.com;rm -rf', tail: 100, service: 'broker', allowCi: false},
        makeNeverSpawn(),
      ),
    ).rejects.toThrow('Invalid BROKER_HOST')
  })

  it('rejects an empty host and does not invoke ssh', async () => {
    delete process.env.CI

    await expect(
      streamBrokerLogs({host: '', tail: 100, service: 'broker', allowCi: false}, makeNeverSpawn()),
    ).rejects.toThrow('Invalid BROKER_HOST')
  })

  it('accepts a valid FQDN and invokes ssh normally', async () => {
    delete process.env.CI

    const result = await streamBrokerLogs(
      {host: 'broker.example.com', tail: 100, service: 'broker', allowCi: false},
      makeSpawnOk(),
    )

    expect(result.refused).toBe(false)
  })

  it('accepts localhost as a valid host', async () => {
    delete process.env.CI

    const result = await streamBrokerLogs(
      {host: 'localhost', tail: 100, service: 'broker', allowCi: false},
      makeSpawnOk(),
    )

    expect(result.refused).toBe(false)
  })

  it('accepts an IPv4 address as a valid host', async () => {
    delete process.env.CI

    const result = await streamBrokerLogs(
      {host: '1.2.3.4', tail: 100, service: 'broker', allowCi: false},
      makeSpawnOk(),
    )

    expect(result.refused).toBe(false)
  })
})

// ─── CI guard ────────────────────────────────────────────────────────────────

describe('CI guard', () => {
  let originalCI: string | undefined

  beforeEach(() => {
    originalCI = process.env.CI
  })

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = originalCI
    }
  })

  it('refuses to stream logs in CI without --allow-ci', async () => {
    process.env.CI = 'true'

    const messages: string[] = []
    const result = await streamBrokerLogs(
      {host: 'broker.example.com', tail: 100, service: 'broker', allowCi: false},
      makeNeverSpawn(),
      (msg: string) => {
        messages.push(msg)
      },
    )

    expect(result.refused).toBe(true)
    expect(messages.some(m => m.includes('--allow-ci'))).toBe(true)
  })

  it('streams logs in CI when --allow-ci is set, printing stderr warning first', async () => {
    process.env.CI = 'true'

    const warnings: string[] = []
    const result = await streamBrokerLogs(
      {host: 'broker.example.com', tail: 100, service: 'broker', allowCi: true},
      makeSpawnOk(),
      undefined,
      (msg: string) => {
        warnings.push(msg)
      },
    )

    expect(result.refused).toBe(false)
    expect(warnings.some(w => w.includes('sensitive'))).toBe(true)
  })

  it('streams logs in non-CI context, printing stderr warning first', async () => {
    delete process.env.CI

    const warnings: string[] = []
    const result = await streamBrokerLogs(
      {host: 'broker.example.com', tail: 100, service: 'broker', allowCi: false},
      makeSpawnOk(),
      undefined,
      (msg: string) => {
        warnings.push(msg)
      },
    )

    expect(result.refused).toBe(false)
    expect(warnings.some(w => w.includes('sensitive'))).toBe(true)
  })
})

// ─── SSH command contract ─────────────────────────────────────────────────────

describe('streamBrokerLogs — SSH command contract', () => {
  it('SSH command includes StrictHostKeyChecking=yes', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamBrokerLogs({host: 'broker.example.com', tail: 100, service: 'broker', allowCi: false}, spawnCapture)

    const strictIdx = capturedCmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
    expect(strictIdx).toBeGreaterThan(-1)
    expect(capturedCmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
  })

  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to ssh', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamBrokerLogs({host: 'broker.example.com', tail: 100, service: 'broker', allowCi: false}, spawnCapture)

    const knownHostsIdx = capturedCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
    expect(knownHostsIdx).toBeGreaterThan(-1)
    expect(capturedCmd[knownHostsIdx - 1]).toBe('-o')
    expect(capturedCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)
  })

  it('forwards --tail N to the docker compose logs command', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamBrokerLogs({host: 'broker.example.com', tail: 25, service: 'broker', allowCi: false}, spawnCapture)

    expect(capturedCmd.join(' ')).toContain('25')
  })

  it('forwards the service name to the docker compose logs command', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamBrokerLogs({host: 'broker.example.com', tail: 100, service: 'caddy', allowCi: false}, spawnCapture)

    const remoteCmd = capturedCmd.at(-1)
    expect(remoteCmd).toContain('caddy')
  })
})
