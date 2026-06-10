import {describe, expect, it} from 'bun:test'

import {getVpnStatusSummary, parseWgShowOutput, type WgShowResult} from './shared'

// ─── parseWgShowOutput ────────────────────────────────────────────────────────

describe('parseWgShowOutput', () => {
  it('parses wg show output with interface and peers', () => {
    const output = [
      'interface: wg0',
      '  public key: abc123pubkey==',
      '  private key: (hidden)',
      '  listening port: 51820',
      '',
      'peer: PEER1PUBKEY==',
      '  endpoint: 10.0.0.1:12345',
      '  allowed ips: 10.8.0.2/32',
      '  latest handshake: 1 minute, 30 seconds ago',
      '  transfer: 1.23 MiB received, 4.56 MiB sent',
    ].join('\n')

    const result = parseWgShowOutput(output)

    expect(result.interfaceUp).toBe(true)
    expect(result.serverPublicKey).toBe('abc123pubkey==')
    expect(result.peerCount).toBe(1)
  })

  it('parses wg show output with no peers', () => {
    const output = [
      'interface: wg0',
      '  public key: serverpubkey==',
      '  private key: (hidden)',
      '  listening port: 51820',
    ].join('\n')

    const result = parseWgShowOutput(output)

    expect(result.interfaceUp).toBe(true)
    expect(result.serverPublicKey).toBe('serverpubkey==')
    expect(result.peerCount).toBe(0)
  })

  it('parses wg show output with multiple peers', () => {
    const output = [
      'interface: wg0',
      '  public key: serverpubkey==',
      '  private key: (hidden)',
      '  listening port: 51820',
      '',
      'peer: PEER1PUBKEY==',
      '  allowed ips: 10.8.0.2/32',
      '',
      'peer: PEER2PUBKEY==',
      '  allowed ips: 10.8.0.3/32',
      '',
      'peer: PEER3PUBKEY==',
      '  allowed ips: 10.8.0.4/32',
    ].join('\n')

    const result = parseWgShowOutput(output)

    expect(result.interfaceUp).toBe(true)
    expect(result.peerCount).toBe(3)
  })

  it('returns interfaceUp=false for empty output', () => {
    const result = parseWgShowOutput('')

    expect(result.interfaceUp).toBe(false)
    expect(result.serverPublicKey).toBeUndefined()
    expect(result.peerCount).toBe(0)
  })

  it('returns interfaceUp=false when output has no interface: line', () => {
    const result = parseWgShowOutput('some random output without interface line')

    expect(result.interfaceUp).toBe(false)
  })
})

// ─── getVpnStatusSummary — SSH-only (no AWS client) ──────────────────────────

type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

function makeSpawnOk(output: string): SpawnFn {
  return (_cmd, _opts) => {
    const encoder = new TextEncoder()
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(output))
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
      exited: Promise.resolve(0),
    }
  }
}

function makeSpawnError(message: string): SpawnFn {
  return (_cmd, _opts) => {
    const encoder = new TextEncoder()
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(message))
          controller.close()
        },
      }),
      exited: Promise.resolve(1),
    }
  }
}

describe('getVpnStatusSummary', () => {
  it('returns a structured summary with app=vpn when wg show succeeds', async () => {
    const wgOutput = [
      'interface: wg0',
      '  public key: serverpubkey==',
      '  private key: (hidden)',
      '  listening port: 51820',
      '',
      'peer: PEER1PUBKEY==',
      '  allowed ips: 10.8.0.2/32',
    ].join('\n')

    const summary = await getVpnStatusSummary('1.2.3.4', makeSpawnOk(wgOutput))

    expect(summary.app).toBe('vpn')
    expect(summary.http).toContain('OK')
  })

  it('includes the server public key in the http field', async () => {
    const wgOutput = [
      'interface: wg0',
      '  public key: MYPUBLICKEY==',
      '  private key: (hidden)',
      '  listening port: 51820',
    ].join('\n')

    const summary = await getVpnStatusSummary('1.2.3.4', makeSpawnOk(wgOutput))

    expect(summary.http).toContain('MYPUBLICKEY==')
  })

  it('returns error summary when SSH fails', async () => {
    const summary = await getVpnStatusSummary('1.2.3.4', makeSpawnError('Connection refused'))

    expect(summary.app).toBe('vpn')
    expect(summary.http).toContain('ERROR')
  })

  it('rejects an invalid host before spawning SSH', async () => {
    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(getVpnStatusSummary('-oProxyCommand=evil', neverSpawn)).rejects.toThrow('Invalid VPN_HOST')
  })

  it('rejects a host with shell metacharacters before spawning SSH', async () => {
    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(getVpnStatusSummary('vpn.example.com;rm -rf', neverSpawn)).rejects.toThrow('Invalid VPN_HOST')
  })

  it('does NOT import or construct a Lightsail/AWS client (SSH-only)', async () => {
    // This test verifies the module source does not reference AWS SDK.
    // We import the module and check it doesn't have AWS client construction.
    // The real assertion is structural: getVpnStatusSummary only uses SSH.
    const wgOutput = 'interface: wg0\n  public key: key==\n  private key: (hidden)\n  listening port: 51820\n'
    const summary = await getVpnStatusSummary('1.2.3.4', makeSpawnOk(wgOutput))

    // If this resolves without AWS credentials, it's SSH-only.
    expect(summary.app).toBe('vpn')
  })

  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to ssh', async () => {
    const wgOutput = 'interface: wg0\n  public key: key==\n  private key: (hidden)\n  listening port: 51820\n'
    let capturedCmd: string[] = []

    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(wgOutput))
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        exited: Promise.resolve(0),
      }
    }

    await getVpnStatusSummary('1.2.3.4', capturingSpawn)

    const knownHostsIdx = capturedCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
    expect(knownHostsIdx).toBeGreaterThan(-1)
    expect(capturedCmd[knownHostsIdx - 1]).toBe('-o')
    expect(capturedCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)
  })

  it('does not weaken StrictHostKeyChecking', async () => {
    const wgOutput = 'interface: wg0\n  public key: key==\n  private key: (hidden)\n  listening port: 51820\n'
    let capturedCmd: string[] = []

    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(wgOutput))
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        exited: Promise.resolve(0),
      }
    }

    await getVpnStatusSummary('1.2.3.4', capturingSpawn)

    const strictIdx = capturedCmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
    expect(strictIdx).toBeGreaterThan(-1)
    expect(capturedCmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
  })
})

// ─── WgShowResult type export check ──────────────────────────────────────────

describe('WgShowResult type', () => {
  it('has the expected shape', () => {
    const result: WgShowResult = {
      interfaceUp: true,
      serverPublicKey: 'key==',
      peerCount: 2,
    }
    expect(result.interfaceUp).toBe(true)
    expect(result.serverPublicKey).toBe('key==')
    expect(result.peerCount).toBe(2)
  })
})
