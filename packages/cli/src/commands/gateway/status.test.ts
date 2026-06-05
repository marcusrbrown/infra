import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude, MockProcessExit} from '../../__test__/mcp-ctx-fixture'
import {gatewayStatusAction, parseComposePs, parseComposePsOutput, type ComposePsEntry, type ServiceRow} from './status'

// ─── parseComposePs ──────────────────────────────────────────────────────────

describe('parseComposePs', () => {
  it('parses all 3 services running with gateway and mitmproxy healthy, workspace n-a', () => {
    const raw: ComposePsEntry[] = [
      {Name: 'gateway', State: 'running', Health: 'healthy'},
      {Name: 'workspace', State: 'running', Health: ''},
      {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
    ]

    const rows = parseComposePs(raw)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({service: 'gateway', state: 'running', health: 'healthy'} satisfies ServiceRow)
    expect(rows[1]).toEqual({service: 'workspace', state: 'running', health: 'n-a'} satisfies ServiceRow)
    expect(rows[2]).toEqual({service: 'mitmproxy', state: 'running', health: 'healthy'} satisfies ServiceRow)
  })

  it('shows exited state when a container has exited', () => {
    const raw: ComposePsEntry[] = [
      {Name: 'gateway', State: 'exited', Health: ''},
      {Name: 'workspace', State: 'running', Health: ''},
      {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
    ]

    const rows = parseComposePs(raw)

    expect(rows[0]).toEqual({service: 'gateway', state: 'exited', health: 'n-a'} satisfies ServiceRow)
  })

  it('maps unhealthy health status', () => {
    const raw: ComposePsEntry[] = [{Name: 'gateway', State: 'running', Health: 'unhealthy'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('unhealthy')
  })

  it('maps starting health status', () => {
    const raw: ComposePsEntry[] = [{Name: 'gateway', State: 'running', Health: 'starting'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('starting')
  })

  it('returns n-a for unknown health values', () => {
    const raw: ComposePsEntry[] = [{Name: 'gateway', State: 'running', Health: 'something-weird'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('n-a')
  })

  it('returns empty array for empty input', () => {
    expect(parseComposePs([])).toEqual([])
  })
})

// ─── isAllRunning ─────────────────────────────────────────────────────────────

describe('isAllRunning', () => {
  it('returns true when all services are running', async () => {
    const {isAllRunning} = await import('./status')
    const rows: ServiceRow[] = [
      {service: 'gateway', state: 'running', health: 'healthy'},
      {service: 'workspace', state: 'running', health: 'n-a'},
      {service: 'mitmproxy', state: 'running', health: 'healthy'},
    ]

    expect(isAllRunning(rows)).toBe(true)
  })

  it('returns false when any service is not running', async () => {
    const {isAllRunning} = await import('./status')
    const rows: ServiceRow[] = [
      {service: 'gateway', state: 'exited', health: 'n-a'},
      {service: 'workspace', state: 'running', health: 'n-a'},
      {service: 'mitmproxy', state: 'running', health: 'healthy'},
    ]

    expect(isAllRunning(rows)).toBe(false)
  })
})

// ─── getGatewayComposeStatus (SSH mocked) ────────────────────────────────────

type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

function makeSpawnOk(jsonOutput: string): SpawnFn {
  return (_cmd, _opts) => {
    const encoder = new TextEncoder()
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(jsonOutput))
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

// ─── SSH command includes repo-pinned UserKnownHostsFile ─────────────────────

describe('getGatewayComposeStatus — SSH command includes UserKnownHostsFile', () => {
  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to ssh when the file exists', async () => {
    const {getGatewayComposeStatus} = await import('./status')
    let capturedCmd: string[] = []

    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])))
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

    await getGatewayComposeStatus('gateway.fro.bot', capturingSpawn)

    const knownHostsIdx = capturedCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
    expect(knownHostsIdx).toBeGreaterThan(-1)
    expect(capturedCmd[knownHostsIdx - 1]).toBe('-o')
    expect(capturedCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)
  })

  it('does not weaken StrictHostKeyChecking when UserKnownHostsFile is added', async () => {
    const {getGatewayComposeStatus} = await import('./status')
    let capturedCmd: string[] = []

    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])))
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

    await getGatewayComposeStatus('gateway.fro.bot', capturingSpawn)

    const strictIdx = capturedCmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
    expect(strictIdx).toBeGreaterThan(-1)
    expect(capturedCmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
  })
})

describe('getGatewayComposeStatus — host validation (SEC1)', () => {
  it('rejects a leading-hyphen host and does not invoke ssh', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(getGatewayComposeStatus('-oProxyCommand=evil', neverSpawn)).rejects.toThrow('Invalid GATEWAY_HOST')
  })

  it('rejects a host with shell metacharacters and does not invoke ssh', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(getGatewayComposeStatus('gateway.example.com;rm -rf', neverSpawn)).rejects.toThrow(
      'Invalid GATEWAY_HOST',
    )
  })

  it('rejects an empty host and does not invoke ssh', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(getGatewayComposeStatus('', neverSpawn)).rejects.toThrow('Invalid GATEWAY_HOST')
  })

  it('accepts a valid FQDN and invokes ssh normally', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const psOutput = JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])
    const result = await getGatewayComposeStatus('gateway.example.com', makeSpawnOk(psOutput))

    expect(result.ok).toBe(true)
  })

  it('accepts localhost as a valid host', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const psOutput = JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])
    const result = await getGatewayComposeStatus('localhost', makeSpawnOk(psOutput))

    expect(result.ok).toBe(true)
  })

  it('accepts an IPv4 address as a valid host', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const psOutput = JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])
    const result = await getGatewayComposeStatus('147.182.133.210', makeSpawnOk(psOutput))

    expect(result.ok).toBe(true)
  })
})

describe('getGatewayComposeStatus', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {GATEWAY_HOST: process.env.GATEWAY_HOST}
    process.env.GATEWAY_HOST = 'gateway.example.com'
  })

  afterEach(() => {
    if (originalEnv.GATEWAY_HOST === undefined) {
      delete process.env.GATEWAY_HOST
    } else {
      process.env.GATEWAY_HOST = originalEnv.GATEWAY_HOST
    }
  })

  it('returns ok=true with 3 service rows when all services are running', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const psOutput = JSON.stringify([
      {Name: 'gateway', State: 'running', Health: 'healthy'},
      {Name: 'workspace', State: 'running', Health: ''},
      {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
    ])

    const result = await getGatewayComposeStatus('gateway.example.com', makeSpawnOk(psOutput))

    expect(result.ok).toBe(true)
    expect(result.services).toHaveLength(3)
    expect(result.services[0]).toEqual({service: 'gateway', state: 'running', health: 'healthy'})
    expect(result.services[1]).toEqual({service: 'workspace', state: 'running', health: 'n-a'})
    expect(result.services[2]).toEqual({service: 'mitmproxy', state: 'running', health: 'healthy'})
  })

  it('returns ok=false when gateway service is exited', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const psOutput = JSON.stringify([
      {Name: 'gateway', State: 'exited', Health: ''},
      {Name: 'workspace', State: 'running', Health: ''},
      {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
    ])

    const result = await getGatewayComposeStatus('gateway.example.com', makeSpawnOk(psOutput))

    expect(result.ok).toBe(false)
    expect(result.services[0]?.state).toBe('exited')
  })

  it('returns ok=false with error when SSH fails', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const result = await getGatewayComposeStatus('gateway.example.com', makeSpawnError('Connection refused'))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('SSH')
  })
})

// ─── parseComposePsOutput ─────────────────────────────────────────────────────

// Realistic fixture shape matching live droplet output
const ndjsonFixture = [
  String.raw`{"Command":"\"docker-entrypoint.sh\"","CreatedAt":"2026-05-20 08:20:18 +0000 UTC","ExitCode":0,"Health":"healthy","ID":"01e1a16f5752","Image":"fro-bot-gateway","Labels":"","LocalVolumes":"0","Mounts":"","Name":"fro-bot-gateway-1","Names":"fro-bot-gateway-1","Networks":"gateway_default","Ports":"","Project":"gateway","Publishers":null,"RunningFor":"2 hours ago","Service":"gateway","Size":"0B","State":"running","Status":"Up 2 hours (healthy)"}`,
  String.raw`{"Command":"\"mitmproxy\"","CreatedAt":"2026-05-20 08:20:18 +0000 UTC","ExitCode":0,"Health":"healthy","ID":"02b2c27f6863","Image":"fro-bot-mitmproxy","Labels":"","LocalVolumes":"0","Mounts":"","Name":"fro-bot-mitmproxy-1","Names":"fro-bot-mitmproxy-1","Networks":"gateway_default","Ports":"","Project":"gateway","Publishers":null,"RunningFor":"2 hours ago","Service":"mitmproxy","Size":"0B","State":"running","Status":"Up 2 hours (healthy)"}`,
  String.raw`{"Command":"\"sleep infinity\"","CreatedAt":"2026-05-20 08:20:18 +0000 UTC","ExitCode":0,"Health":"","ID":"03c3d38g7974","Image":"fro-bot-workspace","Labels":"","LocalVolumes":"0","Mounts":"","Name":"fro-bot-workspace-1","Names":"fro-bot-workspace-1","Networks":"gateway_default","Ports":"","Project":"gateway","Publishers":null,"RunningFor":"2 hours ago","Service":"workspace","Size":"0B","State":"running","Status":"Up 2 hours"}`,
]

describe('parseComposePsOutput', () => {
  it('parses NDJSON with 3 lines into 3 entries with correct Name/State/Health', () => {
    const raw = ndjsonFixture.join('\n')
    const entries = parseComposePsOutput(raw)

    expect(entries).toHaveLength(3)
    expect(entries[0]?.Name).toBe('fro-bot-gateway-1')
    expect(entries[0]?.State).toBe('running')
    expect(entries[0]?.Health).toBe('healthy')
    expect(entries[1]?.Name).toBe('fro-bot-mitmproxy-1')
    expect(entries[1]?.State).toBe('running')
    expect(entries[1]?.Health).toBe('healthy')
    expect(entries[2]?.Name).toBe('fro-bot-workspace-1')
    expect(entries[2]?.State).toBe('running')
    expect(entries[2]?.Health).toBe('')
  })

  it('parses legacy single JSON array format', () => {
    const raw = JSON.stringify([
      {Name: 'fro-bot-gateway-1', State: 'running', Health: 'healthy'},
      {Name: 'fro-bot-mitmproxy-1', State: 'running', Health: 'healthy'},
    ])
    const entries = parseComposePsOutput(raw)

    expect(entries).toHaveLength(2)
    expect(entries[0]?.Name).toBe('fro-bot-gateway-1')
    expect(entries[1]?.Name).toBe('fro-bot-mitmproxy-1')
  })

  it('returns empty array for empty string', () => {
    expect(parseComposePsOutput('')).toEqual([])
  })

  it('returns empty array for whitespace-only input', () => {
    expect(parseComposePsOutput('   \n  \n  ')).toEqual([])
  })

  it('parses a single NDJSON line', () => {
    const raw = ndjsonFixture.at(0) ?? ''
    const entries = parseComposePsOutput(raw)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.Name).toBe('fro-bot-gateway-1')
  })

  it('handles trailing newline correctly', () => {
    const raw = `${ndjsonFixture.join('\n')}\n`
    const entries = parseComposePsOutput(raw)

    expect(entries).toHaveLength(3)
  })

  it('throws on a malformed NDJSON line', () => {
    const raw = `${ndjsonFixture[0]}\nnot-valid-json\n${ndjsonFixture[2]}`

    expect(() => parseComposePsOutput(raw)).toThrow()
  })
})

// ─── getGatewayComposeStatus — NDJSON integration ────────────────────────────

describe('getGatewayComposeStatus — NDJSON stdout', () => {
  it('parses NDJSON docker compose ps output and returns correct services', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const ndjsonOutput = ndjsonFixture.join('\n')
    const result = await getGatewayComposeStatus('gateway.example.com', makeSpawnOk(ndjsonOutput))

    expect(result.ok).toBe(true)
    expect(result.services).toHaveLength(3)
    expect(result.services[0]).toEqual({service: 'fro-bot-gateway-1', state: 'running', health: 'healthy'})
    expect(result.services[1]).toEqual({service: 'fro-bot-mitmproxy-1', state: 'running', health: 'healthy'})
    expect(result.services[2]).toEqual({service: 'fro-bot-workspace-1', state: 'running', health: 'n-a'})
  })

  it('returns ok=false with error message when NDJSON contains a malformed line', async () => {
    const {getGatewayComposeStatus} = await import('./status')

    const badOutput = `${ndjsonFixture[0]}\nnot-valid-json`
    const result = await getGatewayComposeStatus('gateway.example.com', makeSpawnOk(badOutput))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Failed to parse docker compose ps output')
  })
})

// ─── Tier-2: gatewayStatusAction ctx capture ─────────────────────────────────

type StatusSpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

function makeStatusSpawnOk(jsonOutput: string): StatusSpawnFn {
  return (_cmd, _opts) => {
    const encoder = new TextEncoder()
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(jsonOutput))
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

function makeStatusSpawnError(message: string): StatusSpawnFn {
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

describe('gatewayStatusAction — ctx capture (Tier-2)', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {GATEWAY_HOST: process.env.GATEWAY_HOST}
    process.env.GATEWAY_HOST = 'gateway.example.com'
  })

  afterEach(() => {
    if (originalEnv.GATEWAY_HOST === undefined) {
      delete process.env.GATEWAY_HOST
    } else {
      process.env.GATEWAY_HOST = originalEnv.GATEWAY_HOST
    }
  })

  it('routes "Status: OK" to ctx.console.log when all services are running', async () => {
    const {ctx, captured} = createCapturedCtx()

    const psOutput = JSON.stringify([
      {Name: 'gateway', State: 'running', Health: 'healthy'},
      {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
    ])

    await gatewayStatusAction({key: undefined}, ctx, makeStatusSpawnOk(psOutput))

    expect(expectCapturedToInclude(captured, 'Status: OK')).toBe(true)
  })

  it('routes "Gateway status" header to ctx.console.log', async () => {
    const {ctx, captured} = createCapturedCtx()

    const psOutput = JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])

    await gatewayStatusAction({key: undefined}, ctx, makeStatusSpawnOk(psOutput))

    expect(expectCapturedToInclude(captured, 'Gateway status')).toBe(true)
  })

  it('routes error to ctx.console.error and calls ctx.process.exit(1) when SSH fails', async () => {
    const {ctx, captured} = createCapturedCtx()

    await expect(
      gatewayStatusAction({key: undefined}, ctx, makeStatusSpawnError('Connection refused')),
    ).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stderr.join('').includes('Error')).toBe(true)
    expect(captured.exit?.code).toBe(1)
  })

  it('routes error to ctx.console.error and calls ctx.process.exit(1) when GATEWAY_HOST is unset', async () => {
    delete process.env.GATEWAY_HOST
    const {ctx, captured} = createCapturedCtx()

    await expect(gatewayStatusAction({key: undefined}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stderr.join('').includes('GATEWAY_HOST')).toBe(true)
    expect(captured.exit?.code).toBe(1)
  })

  it('routes "Status: DEGRADED" to ctx.console.log and exits 1 when a service is not running', async () => {
    const {ctx, captured} = createCapturedCtx()

    const psOutput = JSON.stringify([
      {Name: 'gateway', State: 'exited', Health: ''},
      {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
    ])

    await expect(gatewayStatusAction({key: undefined}, ctx, makeStatusSpawnOk(psOutput))).rejects.toBeInstanceOf(
      MockProcessExit,
    )

    expect(expectCapturedToInclude(captured, 'DEGRADED')).toBe(true)
    expect(captured.exit?.code).toBe(1)
  })
})

// ─── SSH error redaction — host value must not leak in returned error strings ──

describe('getGatewayComposeStatus — SSH error redaction', () => {
  it('does not include the resolved host value in the error when SSH fails', async () => {
    const {getGatewayComposeStatus} = await import('./status')
    const secretLookingHost = 'TOPSECRETHOSTNAME'

    const mockSpawn = (_cmd: string[], _opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'}) => {
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(''))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(`ssh: Could not resolve hostname ${secretLookingHost}: Name or service not known`))
            c.close()
          },
        }),
        exited: Promise.resolve(255),
      }
    }

    const result = await getGatewayComposeStatus(secretLookingHost, mockSpawn)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain(secretLookingHost)
  })

  it('does not leak the host even when OpenSSH lowercases it in stderr', async () => {
    const {getGatewayComposeStatus} = await import('./status')
    // A misdirected secret-shaped value passes the hostname regex and becomes the host;
    // OpenSSH lowercases it in the "Could not resolve hostname" stderr line.
    const secretHost = 'AKIAIOSFODNN7EXAMPLE'

    const mockSpawn = (_cmd: string[], _opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'}) => {
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(
              encoder.encode(`ssh: Could not resolve hostname ${secretHost.toLowerCase()}: Name or service not known`),
            )
            c.close()
          },
        }),
        exited: Promise.resolve(255),
      }
    }

    const result = await getGatewayComposeStatus(secretHost, mockSpawn)

    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(secretHost)
    expect(result.error).not.toContain(secretHost.toLowerCase())
  })
})
