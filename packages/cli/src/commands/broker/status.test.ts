import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude, MockProcessExit} from '../../__test__/mcp-ctx-fixture'
import {brokerStatusAction, checkBrokerHealth, getBrokerStatusSummary} from './status'

const originalFetch = globalThis.fetch

type FetchReplacement = (url: string, init?: RequestInit) => Promise<Response>

function createFetchImplementation(handler: FetchReplacement): typeof fetch {
  return Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      if (typeof input !== 'string') {
        throw new TypeError(`Unexpected non-string fetch input: ${String(input)}`)
      }

      return handler(input, init)
    },
    {preconnect: originalFetch.preconnect},
  )
}

// ─── checkBrokerHealth ────────────────────────────────────────────────────────

describe('checkBrokerHealth', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns ok for HTTP 200', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('{"status":"ok"}', {status: 200}))

    const result = await checkBrokerHealth('https://broker.example.com')

    expect(result.ok).toBe(true)
    expect(result.summary).toContain('GET https://broker.example.com/healthz → 200')
    expect(result.summary).toContain('ms')
  })

  it('returns not-ok for HTTP 500', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('error', {status: 500}))

    const result = await checkBrokerHealth('https://broker.example.com')

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('→ 500')
  })

  it('returns not-ok for network failures', async () => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new Error('Network timeout')
    })

    const result = await checkBrokerHealth('https://broker.example.com')

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('Network timeout')
  })
})

// ─── getBrokerStatusSummary ───────────────────────────────────────────────────

describe('getBrokerStatusSummary', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns host-not-set sentinel when host is empty', async () => {
    const summary = await getBrokerStatusSummary('')

    expect(summary.app).toBe('broker')
    expect(summary.http).toContain('host not set')
  })

  it('returns OK http when /healthz returns 200', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('{"status":"ok"}', {status: 200}))

    const summary = await getBrokerStatusSummary('broker.example.com')

    expect(summary.app).toBe('broker')
    expect(summary.http).toMatch(/^OK/)
  })

  it('returns ERROR http when /healthz returns 500', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('error', {status: 500}))

    const summary = await getBrokerStatusSummary('broker.example.com')

    expect(summary.app).toBe('broker')
    expect(summary.http).toMatch(/^ERROR/)
  })
})

// ─── brokerStatusAction ───────────────────────────────────────────────────────

describe('brokerStatusAction (ctx capture)', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {
      BROKER_DOMAIN: process.env.BROKER_DOMAIN,
      BROKER_HOST: process.env.BROKER_HOST,
    }
    delete process.env.BROKER_DOMAIN
    delete process.env.BROKER_HOST
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
    globalThis.fetch = originalFetch
  })

  it('outputs broker status header through ctx (MCP-capturable)', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('{"status":"ok"}', {status: 200}))

    const {ctx, captured} = createCapturedCtx()
    await brokerStatusAction({url: 'https://broker.example.com'}, ctx)

    expect(expectCapturedToInclude(captured, 'Broker status')).toBe(true)
    expect(expectCapturedToInclude(captured, 'HTTP reachability')).toBe(true)
    expect(expectCapturedToInclude(captured, 'Summary:')).toBe(true)
  })

  it('calls ctx.process.exit(1) on HTTP error', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('error', {status: 500}))

    const {ctx, captured} = createCapturedCtx()
    let threw: unknown
    try {
      await brokerStatusAction({url: 'https://broker.example.com'}, ctx)
    } catch (error) {
      threw = error
    }

    expect(threw).toBeInstanceOf(MockProcessExit)
    expect(captured.exit?.code).toBe(1)
    expect(expectCapturedToInclude(captured, 'ERROR')).toBe(true)
  })

  it('shows graceful warning when no host is set (no env, no --url)', async () => {
    const {ctx, captured} = createCapturedCtx()
    await brokerStatusAction({}, ctx)

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toMatch(/BROKER_DOMAIN|BROKER_HOST|host not set/i)
    // Must not exit(1) — graceful degradation
    expect(captured.exit).toBeNull()
  })

  it('uses BROKER_DOMAIN env when no --url provided', async () => {
    process.env.BROKER_DOMAIN = 'broker.example.com'
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('broker.example.com')) return new Response('{"status":"ok"}', {status: 200})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await brokerStatusAction({}, ctx)

    expect(expectCapturedToInclude(captured, 'Broker status')).toBe(true)
    expect(expectCapturedToInclude(captured, 'OK')).toBe(true)
  })

  it('uses BROKER_HOST env as fallback when BROKER_DOMAIN is not set', async () => {
    process.env.BROKER_HOST = 'broker.example.com'
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('broker.example.com')) return new Response('{"status":"ok"}', {status: 200})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await brokerStatusAction({}, ctx)

    expect(expectCapturedToInclude(captured, 'Broker status')).toBe(true)
  })

  it('rejects an invalid host and exits with code 1', async () => {
    const {ctx, captured} = createCapturedCtx()
    let threw: unknown
    try {
      await brokerStatusAction({url: 'https://-oProxyCommand=evil'}, ctx)
    } catch (error) {
      threw = error
    }

    expect(threw).toBeInstanceOf(MockProcessExit)
    expect(captured.exit?.code).toBe(1)
  })

  it('routes unexpected thrown error through ctx.console.error + ctx.process.exit(1)', async () => {
    const {ctx, captured} = createCapturedCtx()
    let callCount = 0
    const originalLog = ctx.console.log
    ctx.console.log = (...args: unknown[]) => {
      callCount++
      if (callCount === 1) {
        throw new Error('Unexpected internal error during status output')
      }

      originalLog(...args)
    }

    globalThis.fetch = createFetchImplementation(async () => new Response('{"status":"ok"}', {status: 200}))

    await expect(brokerStatusAction({url: 'https://broker.example.com'}, ctx)).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('Unexpected internal error')
    expect(captured.exit).toEqual({code: 1})
  })
})
