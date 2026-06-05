import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {VALID_SERVICES, validateService} from './logs'

// ─── validateService ─────────────────────────────────────────────────────────

describe('validateService', () => {
  it('accepts gateway as a valid service', () => {
    expect(() => validateService('gateway')).not.toThrow()
  })

  it('accepts workspace as a valid service', () => {
    expect(() => validateService('workspace')).not.toThrow()
  })

  it('accepts mitmproxy as a valid service', () => {
    expect(() => validateService('mitmproxy')).not.toThrow()
  })

  it('rejects an unknown service name with a message listing valid services', () => {
    expect(() => validateService('frobnicator')).toThrow(VALID_SERVICES.join(', '))
  })
})

// ─── streamGatewayLogs — host validation (SEC1) ───────────────────────────────

describe('streamGatewayLogs — host validation (SEC1)', () => {
  it('rejects a leading-hyphen host and does not invoke ssh', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(
      streamGatewayLogs({host: '-oProxyCommand=evil', service: 'gateway', tail: 100, allowCi: false}, neverSpawn),
    ).rejects.toThrow('Invalid GATEWAY_HOST')
  })

  it('rejects a host with shell metacharacters and does not invoke ssh', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(
      streamGatewayLogs(
        {host: 'gateway.example.com;rm -rf', service: 'gateway', tail: 100, allowCi: false},
        neverSpawn,
      ),
    ).rejects.toThrow('Invalid GATEWAY_HOST')
  })

  it('rejects an empty host and does not invoke ssh', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(
      streamGatewayLogs({host: '', service: 'gateway', tail: 100, allowCi: false}, neverSpawn),
    ).rejects.toThrow('Invalid GATEWAY_HOST')
  })

  it('accepts a valid FQDN and invokes ssh normally', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    const result = await streamGatewayLogs(
      {host: 'gateway.example.com', service: 'gateway', tail: 100, allowCi: false},
      makeSpawnOk(),
    )

    expect(result.refused).toBe(false)
  })

  it('accepts localhost as a valid host', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    const result = await streamGatewayLogs(
      {host: 'localhost', service: 'gateway', tail: 100, allowCi: false},
      makeSpawnOk(),
    )

    expect(result.refused).toBe(false)
  })

  it('accepts an IPv4 address as a valid host', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    const result = await streamGatewayLogs(
      {host: '147.182.133.210', service: 'gateway', tail: 100, allowCi: false},
      makeSpawnOk(),
    )

    expect(result.refused).toBe(false)
  })
})

// ─── CI guard ────────────────────────────────────────────────────────────────

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

    const {streamGatewayLogs} = await import('./logs')

    const messages: string[] = []
    const result = await streamGatewayLogs(
      {host: 'gateway.example.com', service: 'gateway', tail: 100, allowCi: false},
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

    const {streamGatewayLogs} = await import('./logs')

    const warnings: string[] = []
    const result = await streamGatewayLogs(
      {host: 'gateway.example.com', service: 'gateway', tail: 100, allowCi: true},
      makeSpawnOk(),
      undefined,
      (msg: string) => {
        warnings.push(msg)
      },
    )

    expect(result.refused).toBe(false)
    expect(warnings.some(w => w.includes('Discord tokens'))).toBe(true)
  })

  it('streams logs in non-CI context, printing stderr warning first', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    const warnings: string[] = []
    const result = await streamGatewayLogs(
      {host: 'gateway.example.com', service: 'gateway', tail: 100, allowCi: false},
      makeSpawnOk(),
      undefined,
      (msg: string) => {
        warnings.push(msg)
      },
    )

    expect(result.refused).toBe(false)
    expect(warnings.some(w => w.includes('Discord tokens'))).toBe(true)
  })
})

// ─── --tail forwarding ───────────────────────────────────────────────────────

describe('tail forwarding', () => {
  it('forwards --tail N to docker compose logs command', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamGatewayLogs({host: 'gateway.example.com', service: 'gateway', tail: 25, allowCi: false}, spawnCapture)

    expect(capturedCmd.join(' ')).toContain('--tail=25')
  })
})

// ─── SSH command includes repo-pinned UserKnownHostsFile ─────────────────────

describe('streamGatewayLogs — SSH command includes UserKnownHostsFile', () => {
  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to ssh', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamGatewayLogs({host: 'gateway.example.com', service: 'gateway', tail: 100, allowCi: false}, spawnCapture)

    const knownHostsIdx = capturedCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
    expect(knownHostsIdx).toBeGreaterThan(-1)
    expect(capturedCmd[knownHostsIdx - 1]).toBe('-o')
    expect(capturedCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)
  })

  it('does not weaken StrictHostKeyChecking when UserKnownHostsFile is added', async () => {
    delete process.env.CI

    const {streamGatewayLogs} = await import('./logs')

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamGatewayLogs({host: 'gateway.example.com', service: 'gateway', tail: 100, allowCi: false}, spawnCapture)

    const strictIdx = capturedCmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
    expect(strictIdx).toBeGreaterThan(-1)
    expect(capturedCmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
  })
})
