import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {streamVpnLogs} from './logs'

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

// ─── streamVpnLogs — host validation (SEC1) ───────────────────────────────────

describe('streamVpnLogs — host validation (SEC1)', () => {
  it('rejects a leading-hyphen host and does not invoke ssh', async () => {
    delete process.env.CI

    await expect(
      streamVpnLogs({host: '-oProxyCommand=evil', tail: 100, allowCi: false}, makeNeverSpawn()),
    ).rejects.toThrow('Invalid VPN_HOST')
  })

  it('rejects a host with shell metacharacters and does not invoke ssh', async () => {
    delete process.env.CI

    await expect(
      streamVpnLogs({host: 'vpn.example.com;rm -rf', tail: 100, allowCi: false}, makeNeverSpawn()),
    ).rejects.toThrow('Invalid VPN_HOST')
  })

  it('rejects an empty host and does not invoke ssh', async () => {
    delete process.env.CI

    await expect(streamVpnLogs({host: '', tail: 100, allowCi: false}, makeNeverSpawn())).rejects.toThrow(
      'Invalid VPN_HOST',
    )
  })

  it('accepts a valid FQDN and invokes ssh normally', async () => {
    delete process.env.CI

    const result = await streamVpnLogs({host: 'vpn.example.com', tail: 100, allowCi: false}, makeSpawnOk())

    expect(result.refused).toBe(false)
  })

  it('accepts localhost as a valid host', async () => {
    delete process.env.CI

    const result = await streamVpnLogs({host: 'localhost', tail: 100, allowCi: false}, makeSpawnOk())

    expect(result.refused).toBe(false)
  })

  it('accepts an IPv4 address as a valid host', async () => {
    delete process.env.CI

    const result = await streamVpnLogs({host: '1.2.3.4', tail: 100, allowCi: false}, makeSpawnOk())

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
    const result = await streamVpnLogs(
      {host: 'vpn.example.com', tail: 100, allowCi: false},
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
    const result = await streamVpnLogs(
      {host: 'vpn.example.com', tail: 100, allowCi: true},
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
    const result = await streamVpnLogs(
      {host: 'vpn.example.com', tail: 100, allowCi: false},
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

// ─── SSH user + privilege contract ───────────────────────────────────────────

describe('streamVpnLogs — SSH user + privilege contract', () => {
  it('SSH user contract: connects as ubuntu@host, not root@host', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamVpnLogs({host: 'vpn.example.com', tail: 100, allowCi: false}, spawnCapture)

    const destination = capturedCmd.find(arg => arg.includes('@'))
    expect(destination).toBeDefined()
    expect(destination).toMatch(/^ubuntu@/)
    expect(destination).not.toMatch(/^root@/)
  })

  it('privilege contract: journalctl is prefixed with sudo', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamVpnLogs({host: 'vpn.example.com', tail: 100, allowCi: false}, spawnCapture)

    // The last element of the SSH command is the remote command to run
    const remoteCmd = capturedCmd.at(-1)
    expect(remoteCmd).toMatch(/^sudo journalctl/)
  })
})

// ─── --tail forwarding ───────────────────────────────────────────────────────

describe('tail forwarding', () => {
  it('forwards --tail N to journalctl command', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamVpnLogs({host: 'vpn.example.com', tail: 25, allowCi: false}, spawnCapture)

    expect(capturedCmd.join(' ')).toContain('25')
  })
})

// ─── SSH command includes repo-pinned UserKnownHostsFile ─────────────────────

describe('streamVpnLogs — SSH command includes UserKnownHostsFile', () => {
  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to ssh', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamVpnLogs({host: 'vpn.example.com', tail: 100, allowCi: false}, spawnCapture)

    const knownHostsIdx = capturedCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
    expect(knownHostsIdx).toBeGreaterThan(-1)
    expect(capturedCmd[knownHostsIdx - 1]).toBe('-o')
    expect(capturedCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)
  })

  it('does not weaken StrictHostKeyChecking when UserKnownHostsFile is added', async () => {
    delete process.env.CI

    let capturedCmd: string[] = []
    const spawnCapture: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      return {exited: Promise.resolve(0)}
    }

    await streamVpnLogs({host: 'vpn.example.com', tail: 100, allowCi: false}, spawnCapture)

    const strictIdx = capturedCmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
    expect(strictIdx).toBeGreaterThan(-1)
    expect(capturedCmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
  })
})
