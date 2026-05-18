import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {parseComposePs, type ComposePsEntry, type ServiceRow} from './status'

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
