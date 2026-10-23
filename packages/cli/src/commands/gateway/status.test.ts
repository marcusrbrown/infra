import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {DEGRADED_BODY, LIMIT_BYTES, MIB, STARTED_AT, workspaceStdout} from './__fixtures__/workspace-probe'
import {
  gatewayStatusAction,
  getGatewayStatusSummary,
  getGatewayWorkspaceStatus,
  parseComposePs,
  parseComposePsOutput,
  type ComposePsEntry,
  type ServiceRow,
} from './status'
import {buildWorkspaceProbeScript} from './workspace-memory'

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
  kill?: () => void
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

// ─── SSH identity injection (GATEWAY_SSH_KEY) ─────────────────────────────────

describe('getGatewayComposeStatus — SSH identity injection', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {GATEWAY_SSH_KEY: process.env.GATEWAY_SSH_KEY}
  })

  afterEach(() => {
    if (originalEnv.GATEWAY_SSH_KEY === undefined) {
      delete process.env.GATEWAY_SSH_KEY
    } else {
      process.env.GATEWAY_SSH_KEY = originalEnv.GATEWAY_SSH_KEY
    }
  })

  it('includes -i <path> and IdentitiesOnly=yes in ssh argv when GATEWAY_SSH_KEY is set', async () => {
    const {getGatewayComposeStatus} = await import('./status')
    process.env.GATEWAY_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'

    let capturedCmd: string[] = []
    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])))
            c.close()
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

    await getGatewayComposeStatus('gateway.example.com', capturingSpawn)

    const iIdx = capturedCmd.indexOf('-i')
    expect(iIdx).toBeGreaterThan(-1)
    expect(capturedCmd[iIdx + 1]).toBeTruthy() // path to temp key file

    const identitiesOnlyIdx = capturedCmd.indexOf('IdentitiesOnly=yes')
    expect(identitiesOnlyIdx).toBeGreaterThan(-1)

    const destination = capturedCmd.find(arg => arg.includes('@'))
    expect(destination).toBe('root@gateway.example.com')
  })

  it('does not include -i or IdentitiesOnly=yes when GATEWAY_SSH_KEY is absent', async () => {
    const {getGatewayComposeStatus} = await import('./status')
    delete process.env.GATEWAY_SSH_KEY

    let capturedCmd: string[] = []
    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])))
            c.close()
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

    await getGatewayComposeStatus('gateway.example.com', capturingSpawn)

    expect(capturedCmd.indexOf('-i')).toBe(-1)
    expect(capturedCmd.indexOf('IdentitiesOnly=yes')).toBe(-1)
  })

  it('cleans up the temp key file after the SSH command completes', async () => {
    const {getGatewayComposeStatus} = await import('./status')
    const {statSync} = await import('node:fs')
    process.env.GATEWAY_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'

    let capturedKeyPath: string | undefined
    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      const iIdx = cmd.indexOf('-i')
      if (iIdx !== -1) capturedKeyPath = cmd[iIdx + 1]
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'gateway', State: 'running', Health: 'healthy'}])))
            c.close()
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

    await getGatewayComposeStatus('gateway.example.com', capturingSpawn)

    expect(capturedKeyPath).toBeTruthy()
    const keyPath = capturedKeyPath
    if (keyPath) {
      expect(() => statSync(keyPath)).toThrow()
    }
  })

  it('cleans up the temp key dir even when spawn throws synchronously', async () => {
    const {getGatewayComposeStatus} = await import('./status')
    const {statSync} = await import('node:fs')
    process.env.GATEWAY_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'

    let capturedKeyPath: string | undefined
    const throwingSpawn: SpawnFn = (cmd, _opts) => {
      const iIdx = cmd.indexOf('-i')
      if (iIdx !== -1) capturedKeyPath = cmd[iIdx + 1]
      throw new Error('spawn failed')
    }

    await expect(getGatewayComposeStatus('gateway.example.com', throwingSpawn)).rejects.toThrow('spawn failed')

    expect(capturedKeyPath).toBeTruthy()
    if (capturedKeyPath) {
      expect(() => statSync(capturedKeyPath as string)).toThrow()
    }
  })
})

// ─── Workspace memory probe ──────────────────────────────────────────────────

const composeJson = JSON.stringify([
  {Name: 'gateway', State: 'running', Health: 'healthy'},
  {Name: 'workspace', State: 'running', Health: ''},
  {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
])

const composeJsonDegraded = JSON.stringify([
  {Name: 'gateway', State: 'exited', Health: ''},
  {Name: 'workspace', State: 'running', Health: ''},
  {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
])

type Proc = ReturnType<SpawnFn>

function proc(stdout: string, exitCode = 0, stderr = ''): Proc {
  const encoder = new TextEncoder()
  return {
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(stdout))
        c.close()
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(stderr))
        c.close()
      },
    }),
    exited: Promise.resolve(exitCode),
  }
}

function hangingProc(onKill: () => void): Proc {
  return {
    stdout: new ReadableStream({}),
    stderr: new ReadableStream({}),
    exited: new Promise<number>(() => undefined),
    kill: onKill,
  }
}

// Routes by command: the compose call and the workspace probe get independent responders.
function makeRouter(compose: () => Proc, workspace: () => Proc): {spawn: SpawnFn; calls: string[][]} {
  const calls: string[][] = []
  const spawn: SpawnFn = cmd => {
    calls.push(cmd)
    return cmd.at(-1)?.includes('ps --format json') === true ? compose() : workspace()
  }
  return {spawn, calls}
}

describe('getGatewayWorkspaceStatus — spawn behavior', () => {
  let originalHost: string | undefined

  beforeEach(() => {
    originalHost = process.env.GATEWAY_HOST
    process.env.GATEWAY_HOST = 'gateway.example.com'
  })

  afterEach(() => {
    if (originalHost === undefined) delete process.env.GATEWAY_HOST
    else process.env.GATEWAY_HOST = originalHost
  })

  it('uses the same hardened ssh options as the compose call and sends the probe script as the remote command', async () => {
    let captured: string[] = []
    const spawn: SpawnFn = cmd => {
      captured = cmd
      return proc(workspaceStdout())
    }

    await getGatewayWorkspaceStatus('gateway.example.com', spawn)

    expect(captured[0]).toBe('ssh')
    expect(captured).toContain('BatchMode=yes')
    expect(captured).toContain('StrictHostKeyChecking=yes')
    expect(captured.some(arg => arg.startsWith('UserKnownHostsFile='))).toBe(true)
    expect(captured.at(-2)).toBe('root@gateway.example.com')
    expect(captured.at(-1)).toBe(buildWorkspaceProbeScript())
  })

  it('passes the explicit identity with IdentitiesOnly when GATEWAY_SSH_KEY is set and cleans the key up', async () => {
    const originalKey = process.env.GATEWAY_SSH_KEY
    process.env.GATEWAY_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'
    try {
      let captured: string[] = []
      const spawn: SpawnFn = cmd => {
        captured = cmd
        return proc(workspaceStdout())
      }

      await getGatewayWorkspaceStatus('gateway.example.com', spawn)

      const iIdx = captured.indexOf('-i')
      expect(iIdx).toBeGreaterThan(-1)
      expect(captured).toContain('IdentitiesOnly=yes')
      const keyPath = captured[iIdx + 1]
      expect(keyPath).toBeTruthy()
      const {statSync} = await import('node:fs')
      expect(() => statSync(keyPath as string)).toThrow()
    } finally {
      if (originalKey === undefined) delete process.env.GATEWAY_SSH_KEY
      else process.env.GATEWAY_SSH_KEY = originalKey
    }
  })

  it('rejects an invalid host before spawning', async () => {
    const neverSpawn: SpawnFn = () => {
      throw new Error('spawn must not be called for an invalid host')
    }

    await expect(getGatewayWorkspaceStatus('-oProxyCommand=evil', neverSpawn)).rejects.toThrow('Invalid GATEWAY_HOST')
  })

  it('returns unknown and kills the child when the call exceeds the timeout', async () => {
    let killed = false
    const spawn: SpawnFn = () =>
      hangingProc(() => {
        killed = true
      })

    const status = await getGatewayWorkspaceStatus('gateway.example.com', spawn, 50)

    expect(status.status).toBe('unknown')
    expect(status.status === 'unknown' && status.reason).toContain('timed out')
    expect(killed).toBe(true)
  })

  it('returns unknown when ssh exits non-zero without leaking stderr or the host', async () => {
    const spawn: SpawnFn = () => proc(workspaceStdout(), 255, 'ssh: Could not resolve hostname gateway.example.com')

    const status = await getGatewayWorkspaceStatus('gateway.example.com', spawn)

    expect(status.status).toBe('unknown')
    expect(JSON.stringify(status)).not.toContain('gateway.example.com')
  })

  it('returns unknown when spawn throws synchronously', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn failed')
    }

    expect((await getGatewayWorkspaceStatus('gateway.example.com', spawn)).status).toBe('unknown')
  })
})

describe('gatewayStatusAction — workspace memory', () => {
  let originalHost: string | undefined

  beforeEach(() => {
    originalHost = process.env.GATEWAY_HOST
    process.env.GATEWAY_HOST = 'gateway.example.com'
  })

  afterEach(() => {
    if (originalHost === undefined) delete process.env.GATEWAY_HOST
    else process.env.GATEWAY_HOST = originalHost
  })

  it('renders the happy path exactly and exits 0', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn, calls} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout()),
    )

    await gatewayStatusAction({key: undefined}, ctx, spawn)

    expect(calls).toHaveLength(2)
    expect(captured.exit).toBeNull()
    expect(captured.stdout.join('\n')).toBe(
      [
        'Gateway status',
        '',
        'Service          State      Health',
        '─────────────────────────────────────',
        'gateway          running    healthy',
        'workspace        running    n-a',
        'mitmproxy        running    healthy',
        '',
        'Workspace memory',
        '  Limit:       896 MiB',
        '  Usage:       412 MiB',
        '  Max events:  0',
        '  OOM kills:   0 (counted since the container last started)',
        `  Restarts:    0 (started ${STARTED_AT})`,
        '  OOMKilled:   false',
        '  OpenCode:    ready',
        '',
        'Status: OK',
      ].join('\n'),
    )
  })

  it('shows a non-zero kill count and stays OK', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout({oomKill: 2, maxEvents: 5, oomKilled: true, restartCount: 2})),
    )

    await gatewayStatusAction({key: undefined}, ctx, spawn)

    expect(expectCapturedToInclude(captured, 'OOM kills:   2 (counted since the container last started)')).toBe(true)
    expect(expectCapturedToInclude(captured, 'Max events:  5')).toBe(true)
    expect(expectCapturedToInclude(captured, 'OOMKilled:   true')).toBe(true)
    expect(expectCapturedToInclude(captured, 'Status: OK')).toBe(true)
    expect(captured.exit).toBeNull()
  })

  it.each(['starting', 'degraded', 'down'] as const)(
    'shows opencode %s and leaves the exit code unchanged',
    async state => {
      const {ctx, captured} = createCapturedCtx()
      const {spawn} = makeRouter(
        () => proc(composeJson),
        () => proc(workspaceStdout({readyz: `{"ready":false,"opencode":"${state}"}`})),
      )

      await gatewayStatusAction({key: undefined}, ctx, spawn)

      expect(expectCapturedToInclude(captured, `OpenCode:    ${state}`)).toBe(true)
      expect(expectCapturedToInclude(captured, 'Status: OK')).toBe(true)
      expect(captured.exit).toBeNull()
    },
  )

  it('shows opencode skipped near the limit', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout({currentBytes: LIMIT_BYTES - 16 * MIB, readyzSkipped: true})),
    )

    await gatewayStatusAction({key: undefined}, ctx, spawn)

    expect(expectCapturedToInclude(captured, 'Usage:       880 MiB')).toBe(true)
    expect(expectCapturedToInclude(captured, 'OpenCode:    skipped (within 64 MiB of the limit)')).toBe(true)
  })

  it('shows limit none when the container has no memory limit', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout({memory: 0})),
    )

    await gatewayStatusAction({key: undefined}, ctx, spawn)

    expect(expectCapturedToInclude(captured, 'Limit:       none')).toBe(true)
  })

  it('keeps exit code 1 and DEGRADED when compose is degraded and the probe succeeds', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJsonDegraded),
      () => proc(workspaceStdout()),
    )

    await expect(gatewayStatusAction({key: undefined}, ctx, spawn)).rejects.toBeInstanceOf(MockProcessExit)

    expect(expectCapturedToInclude(captured, 'DEGRADED')).toBe(true)
    expect(captured.exit?.code).toBe(1)
  })

  describe.each([
    ['the extra call fails over SSH', () => proc('', 255, 'Connection reset')],
    ['the extra call times out', () => hangingProc(() => undefined)],
    ['a section is missing', () => proc(workspaceStdout({omit: 'cgroup'}))],
    ['the readyz body is garbage', () => proc(workspaceStdout({readyz: 'not json at all'}))],
    ['the extra call cannot be spawned', () => proc(workspaceStdout(), 0)],
  ] as const)('when %s', (label, workspace) => {
    const timeoutMs = 50

    function routerFor(composeOutput: string) {
      if (label === 'the extra call cannot be spawned') {
        const calls: string[][] = []
        const spawn: SpawnFn = cmd => {
          calls.push(cmd)
          if (cmd.at(-1)?.includes('ps --format json') === true) return proc(composeOutput)
          throw new Error('spawn failed')
        }
        return {spawn, calls}
      }
      return makeRouter(() => proc(composeOutput), workspace)
    }

    it('reports the workspace block unknown while compose rows still render and the exit stays clean', async () => {
      const {ctx, captured} = createCapturedCtx()
      const {spawn} = routerFor(composeJson)

      await gatewayStatusAction({key: undefined}, ctx, spawn, timeoutMs)

      expect(expectCapturedToInclude(captured, 'Workspace memory: unknown')).toBe(true)
      expect(expectCapturedToInclude(captured, 'gateway          running    healthy')).toBe(true)
      expect(expectCapturedToInclude(captured, 'Status: OK')).toBe(true)
      expect(captured.exit).toBeNull()
    })

    it('does not change the DEGRADED exit code of a degraded compose state', async () => {
      const {ctx, captured} = createCapturedCtx()
      const {spawn} = routerFor(composeJsonDegraded)

      await expect(gatewayStatusAction({key: undefined}, ctx, spawn, timeoutMs)).rejects.toBeInstanceOf(MockProcessExit)

      expect(expectCapturedToInclude(captured, 'Workspace memory: unknown')).toBe(true)
      expect(expectCapturedToInclude(captured, 'DEGRADED')).toBe(true)
      expect(captured.exit?.code).toBe(1)
    })
  })

  it('does not run the workspace probe when the compose call fails', async () => {
    const {ctx} = createCapturedCtx()
    const {spawn, calls} = makeRouter(
      () => proc('', 1, 'Connection refused'),
      () => proc(workspaceStdout()),
    )

    await expect(gatewayStatusAction({key: undefined}, ctx, spawn)).rejects.toBeInstanceOf(MockProcessExit)

    expect(calls).toHaveLength(1)
  })
})

describe('gatewayStatusAction — --json', () => {
  let originalHost: string | undefined

  beforeEach(() => {
    originalHost = process.env.GATEWAY_HOST
    process.env.GATEWAY_HOST = 'gateway.example.com'
  })

  afterEach(() => {
    if (originalHost === undefined) delete process.env.GATEWAY_HOST
    else process.env.GATEWAY_HOST = originalHost
  })

  const services = [
    {service: 'gateway', state: 'running', health: 'healthy'},
    {service: 'workspace', state: 'running', health: 'n-a'},
    {service: 'mitmproxy', state: 'running', health: 'healthy'},
  ]

  const okWorkspace = {
    status: 'ok',
    limitBytes: LIMIT_BYTES,
    currentBytes: 412 * MIB,
    maxEvents: 0,
    oomKills: 0,
    oomKilled: false,
    restartCount: 0,
    startedAt: STARTED_AT,
    opencode: 'ready',
  }

  const proseMarkers = ['Gateway status', 'Service  ', '─────', 'Workspace memory', 'Status:']

  it('prints exactly one JSON line with ok, services and workspace for the happy path, and exits 0', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout()),
    )

    await gatewayStatusAction({key: undefined, json: true}, ctx, spawn)

    expect(captured.stdout).toHaveLength(1)
    expect(captured.stdout[0]).toBe(JSON.stringify({ok: true, services, workspace: okWorkspace}))
    expect(captured.exit).toBeNull()
    expect(captured.stderr).toHaveLength(0)
  })

  it('prints no table or prose in JSON mode', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout()),
    )

    await gatewayStatusAction({key: undefined, json: true}, ctx, spawn)

    for (const marker of proseMarkers) {
      expect(captured.stdout.join('\n')).not.toContain(marker)
    }
  })

  it('reports ok false and exits 1 when compose is degraded', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJsonDegraded),
      () => proc(workspaceStdout()),
    )

    await expect(gatewayStatusAction({key: undefined, json: true}, ctx, spawn)).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stdout).toHaveLength(1)
    const parsed = JSON.parse(captured.stdout[0] ?? '{}') as {ok: boolean; services: {service: string; state: string}[]}
    expect(parsed.ok).toBe(false)
    expect(parsed.services[0]).toMatchObject({service: 'gateway', state: 'exited'})
    expect(captured.exit?.code).toBe(1)
  })

  it('reports the workspace block unknown with a reason and keeps exit 0 when the extra call fails', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc('', 255, 'Connection reset'),
    )

    await gatewayStatusAction({key: undefined, json: true}, ctx, spawn)

    expect(captured.stdout).toHaveLength(1)
    expect(JSON.parse(captured.stdout[0] ?? '{}')).toEqual({
      ok: true,
      services,
      workspace: {status: 'unknown', reason: 'SSH command failed (exit 255)'},
    })
    expect(captured.exit).toBeNull()
  })

  it('reports an unknown workspace after a timeout without changing a degraded exit code', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = makeRouter(
      () => proc(composeJsonDegraded),
      () => hangingProc(() => undefined),
    )

    await expect(gatewayStatusAction({key: undefined, json: true}, ctx, spawn, 50)).rejects.toBeInstanceOf(
      MockProcessExit,
    )

    const parsed = JSON.parse(captured.stdout[0] ?? '{}') as {ok: boolean; workspace: {status: string}}
    expect(parsed.ok).toBe(false)
    expect(parsed.workspace.status).toBe('unknown')
    expect(captured.exit?.code).toBe(1)
  })

  it('keeps the compose-failure error on stderr, prints nothing to stdout and exits 1', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn, calls} = makeRouter(
      () => proc('', 1, 'Connection refused'),
      () => proc(workspaceStdout()),
    )

    await expect(gatewayStatusAction({key: undefined, json: true}, ctx, spawn)).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stdout).toHaveLength(0)
    expect(captured.stderr.join('')).toContain('Error')
    expect(captured.exit?.code).toBe(1)
    expect(calls).toHaveLength(1)
  })
})

describe('getGatewayStatusSummary — workspace suffix', () => {
  let originalHost: string | undefined

  beforeEach(() => {
    originalHost = process.env.GATEWAY_HOST
    process.env.GATEWAY_HOST = 'gateway.example.com'
  })

  afterEach(() => {
    if (originalHost === undefined) delete process.env.GATEWAY_HOST
    else process.env.GATEWAY_HOST = originalHost
  })

  const prefix = 'OK: gateway:running/healthy, workspace:running/n-a, mitmproxy:running/healthy'

  it('appends the tagged suffix after the unchanged compose prefix', async () => {
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout()),
    )

    const summary = await getGatewayStatusSummary('gateway.example.com', spawn)

    expect(summary.http).toBe(`${prefix}; workspace mem=412/896MiB oom_kills=0 opencode=ready`)
  })

  it('contains no table delimiter', async () => {
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout({oomKill: 1, readyz: DEGRADED_BODY})),
    )

    const summary = await getGatewayStatusSummary('gateway.example.com', spawn)

    expect(summary.http).not.toContain('|')
    expect(summary.http).toBe(`${prefix}; workspace mem=412/896MiB oom_kills=1 opencode=degraded`)
  })

  it('uses limit=none when no limit is set', async () => {
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc(workspaceStdout({memory: 0, readyzSkipped: true})),
    )

    const summary = await getGatewayStatusSummary('gateway.example.com', spawn)

    expect(summary.http).toBe(`${prefix}; workspace mem=412MiB limit=none oom_kills=0 opencode=skipped`)
  })

  it('reports workspace=unknown and keeps the compose prefix when the extra call fails', async () => {
    const {spawn} = makeRouter(
      () => proc(composeJson),
      () => proc('', 255, 'Connection reset'),
    )

    const summary = await getGatewayStatusSummary('gateway.example.com', spawn)

    expect(summary.http).toBe(`${prefix}; workspace=unknown`)
    expect(summary.http).not.toContain('|')
  })

  it('still probes and appends the suffix when a service is down, keeping the non-OK prefix', async () => {
    const {spawn, calls} = makeRouter(
      () => proc(composeJsonDegraded),
      () => proc(workspaceStdout()),
    )

    const summary = await getGatewayStatusSummary('gateway.example.com', spawn)

    expect(calls).toHaveLength(2)
    expect(summary.http).toBe(
      'DEGRADED: gateway:exited/n-a, workspace:running/n-a, mitmproxy:running/healthy; workspace mem=412/896MiB oom_kills=0 opencode=ready',
    )
    expect(summary.http).not.toContain('|')
    expect(summary.workspace).toMatchObject({status: 'ok', opencode: 'ready', limitBytes: LIMIT_BYTES})
  })

  it('lists every service row with its state in the DEGRADED summary', async () => {
    const {spawn} = makeRouter(
      () =>
        proc(
          JSON.stringify([
            {Name: 'gateway', State: 'exited', Health: ''},
            {Name: 'workspace', State: 'running', Health: ''},
            {Name: 'caddy', State: 'restarting', Health: 'unhealthy'},
            {Name: 'mitmproxy', State: 'running', Health: 'healthy'},
          ]),
        ),
      () => proc(workspaceStdout()),
    )

    const summary = await getGatewayStatusSummary('gateway.example.com', spawn)

    expect(summary.http).toBe(
      'DEGRADED: gateway:exited/n-a, workspace:running/n-a, caddy:restarting/unhealthy, mitmproxy:running/healthy; workspace mem=412/896MiB oom_kills=0 opencode=ready',
    )
    expect(summary.http.startsWith('DEGRADED:')).toBe(true)
    expect(summary.http).not.toContain('No services reported')
  })

  it('reports workspace=unknown, not a missing field, when a service is down and the probe fails', async () => {
    const {spawn} = makeRouter(
      () => proc(composeJsonDegraded),
      () => proc('', 255, 'Connection reset'),
    )

    const summary = await getGatewayStatusSummary('gateway.example.com', spawn)

    expect(summary.http).toBe(
      'DEGRADED: gateway:exited/n-a, workspace:running/n-a, mitmproxy:running/healthy; workspace=unknown',
    )
    expect(summary.workspace?.status).toBe('unknown')
  })

  it('does not add the suffix or run the probe when compose itself errors', async () => {
    const {spawn, calls} = makeRouter(
      () => proc('', 1, 'Connection refused'),
      () => proc(workspaceStdout()),
    )

    const summary = await getGatewayStatusSummary('gateway.example.com', spawn)

    expect(summary.http.startsWith('ERROR:')).toBe(true)
    expect(summary.http).not.toContain('workspace')
    expect(summary.workspace).toBeUndefined()
    expect(calls).toHaveLength(1)
  })
})
