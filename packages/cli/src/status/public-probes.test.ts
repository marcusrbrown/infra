import {afterEach, describe, expect, it} from 'bun:test'

import {observationSchema} from './observation'
import {
  httpGet,
  probeBroker,
  probeCliproxy,
  probeDashboard,
  probeGateway,
  probeKeeweb,
  probeUmami,
  PUBLIC_PROBES,
  type ProbeOptions,
} from './public-probes'

const originalFetch = globalThis.fetch
const NOW = new Date('2026-11-01T12:00:00.000Z')

type FetchHandler = (url: string, init: RequestInit | undefined, call: number) => Promise<Response>

interface FetchRecorder {
  urls: string[]
}

function installFetch(handler: FetchHandler): FetchRecorder {
  const recorder: FetchRecorder = {urls: []}
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      if (typeof input !== 'string') {
        throw new TypeError(`Unexpected non-string fetch input: ${String(input)}`)
      }
      recorder.urls.push(input)
      return handler(input, init, recorder.urls.length)
    },
    {preconnect: originalFetch.preconnect},
  )
  return recorder
}

function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) {
      reject(new Error('test fetch invoked without an abort signal'))
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason))
  })
}

const baseOptions: ProbeOptions = {now: () => NOW}

afterEach(() => {
  globalThis.fetch = originalFetch
})

interface ProbeCase {
  name: string
  probe: (options?: ProbeOptions) => ReturnType<typeof probeBroker>
  url: string
  okBody: string
}

const probeCases: ProbeCase[] = [
  {name: 'keeweb', probe: probeKeeweb, url: 'https://kw.igg.ms/', okBody: '<html></html>'},
  {name: 'cliproxy', probe: probeCliproxy, url: 'https://cliproxy.fro.bot/healthz', okBody: 'ok'},
  {name: 'broker', probe: probeBroker, url: 'https://broker.fro.bot/healthz', okBody: '{"status":"ok"}'},
  {name: 'umami', probe: probeUmami, url: 'https://metrics.fro.bot/api/heartbeat', okBody: '{"ok":true}'},
  {name: 'dashboard', probe: probeDashboard, url: 'https://dashboard.fro.bot/api/healthz', okBody: '{"ok":true}'},
  {
    name: 'gateway',
    probe: probeGateway,
    url: 'https://dashboard.fro.bot/operator/health',
    okBody: '{"contractVersion":"2026-10-01"}',
  },
]

describe('PUBLIC_PROBES', () => {
  it('has one probe for each public app and none for vpn', () => {
    expect(Object.keys(PUBLIC_PROBES).toSorted()).toEqual([
      'broker',
      'cliproxy',
      'dashboard',
      'gateway',
      'keeweb',
      'umami',
    ])
  })
})

describe.each(probeCases)('$name probe', ({name, probe, url, okBody}) => {
  it('probes the expected public endpoint and returns a pass reachability observation', async () => {
    const recorder = installFetch(async () => new Response(okBody, {status: 200}))

    const observation = await probe(baseOptions)

    expect(recorder.urls).toEqual([url])
    expect(observation.kind).toBe('reachability')
    expect(observation.result).toBe('pass')
    expect(observation.source).toBe('http')
    expect(observation.observedAt).toBe('2026-11-01T12:00:00.000Z')
    expect(observation.detail?.statusCode).toBe(200)
    expect(observation.detail?.durationMs).toBeGreaterThanOrEqual(0)
    expect(observationSchema.safeParse(observation).success).toBe(true)
  })

  it('reports fail on a 5xx without retrying, and never copies the response body', async () => {
    const recorder = installFetch(async () => new Response('SECRET-UPSTREAM-BODY', {status: 503}))

    const observation = await probe(baseOptions)

    expect(observation.result).toBe('fail')
    expect(observation.detail?.statusCode).toBe(503)
    expect(recorder.urls).toHaveLength(1)
    expect(JSON.stringify(observation)).not.toContain('SECRET-UPSTREAM-BODY')
    expect(observationSchema.safeParse(observation).success).toBe(true)
  })

  it('reports fail on a 404', async () => {
    installFetch(async () => new Response('nope', {status: 404}))

    const observation = await probe(baseOptions)

    expect(observation.result).toBe('fail')
    expect(observation.detail?.statusCode).toBe(404)
  })

  it('reports unknown after exactly one retry on a network error, without leaking the error text', async () => {
    const recorder = installFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND secret-host.internal')
    })

    const observation = await probe(baseOptions)

    expect(observation.result).toBe('unknown')
    expect(observation.detail?.reason).toBe(name === 'gateway' ? 'dependency-unreachable' : 'network-error')
    expect(recorder.urls).toHaveLength(2)
    const serialized = JSON.stringify(observation)
    expect(serialized).not.toContain('ENOTFOUND')
    expect(serialized).not.toContain('secret-host')
    expect(observation.observedAt).toBe('2026-11-01T12:00:00.000Z')
    expect(observationSchema.safeParse(observation).success).toBe(true)
  })

  it('recovers when the retry succeeds', async () => {
    const recorder = installFetch(async (_url, _init, call) => {
      if (call === 1) {
        throw new Error('connection reset')
      }
      return new Response(okBody, {status: 200})
    })

    const observation = await probe(baseOptions)

    expect(observation.result).toBe('pass')
    expect(recorder.urls).toHaveLength(2)
  })

  it('reports unknown with a timeout reason when the request hangs, after one retry', async () => {
    const recorder = installFetch(async (_url, init) => hangUntilAborted(init))

    const observation = await probe({...baseOptions, timeoutMs: 15})

    expect(observation.result).toBe('unknown')
    // The gateway is observed through the dashboard, so any unreachable result is a dependency problem.
    expect(observation.detail?.reason).toBe(name === 'gateway' ? 'dependency-unreachable' : 'timeout')
    expect(recorder.urls).toHaveLength(2)
  })

  it('passes an abort signal to every request', async () => {
    let sawSignal = false
    installFetch(async (_url, init) => {
      sawSignal = init?.signal instanceof AbortSignal
      return new Response(okBody, {status: 200})
    })

    await probe(baseOptions)

    expect(sawSignal).toBe(true)
  })

  it('honours a baseUrl override', async () => {
    const recorder = installFetch(async () => new Response(okBody, {status: 200}))

    await probe({...baseOptions, baseUrl: 'https://probe.example.test'})

    expect(recorder.urls).toHaveLength(1)
    expect(recorder.urls[0]?.startsWith('https://probe.example.test')).toBe(true)
  })
})

describe('umami probe body predicate', () => {
  it('fails on 200 with {ok:false}', async () => {
    installFetch(async () => new Response('{"ok":false}', {status: 200}))
    const observation = await probeUmami(baseOptions)
    expect(observation.result).toBe('fail')
    expect(observation.detail?.statusCode).toBe(200)
  })

  it.each(['not json', '[]', 'null', '{"ok":"true"}', '{}', ''])('fails on 200 with body %j', async body => {
    installFetch(async () => new Response(body, {status: 200}))
    expect((await probeUmami(baseOptions)).result).toBe('fail')
  })

  it('does not retry on a bad body', async () => {
    const recorder = installFetch(async () => new Response('{"ok":false}', {status: 200}))
    await probeUmami(baseOptions)
    expect(recorder.urls).toHaveLength(1)
  })
})

describe('gateway probe', () => {
  it('passes on 200 with a non-empty contractVersion and carries it in detail', async () => {
    installFetch(async () => new Response('{"contractVersion":"2026-10-01","extra":"ignored"}', {status: 200}))

    const observation = await probeGateway(baseOptions)

    expect(observation.result).toBe('pass')
    expect(observation.detail?.contractVersion).toBe('2026-10-01')
    expect(JSON.stringify(observation)).not.toContain('ignored')
    expect(observationSchema.safeParse(observation).success).toBe(true)
  })

  it.each([
    ['empty string', '{"contractVersion":""}'],
    ['whitespace', '{"contractVersion":"   "}'],
    ['missing', '{}'],
    ['non-string', '{"contractVersion":2}'],
    ['null', '{"contractVersion":null}'],
    ['not json', 'upstream connect error'],
    ['array', '[]'],
    ['oversized', `{"contractVersion":"${'v'.repeat(65)}"}`],
    ['control characters', String.raw`{"contractVersion":"v1\nINJECTED"}`],
  ])('fails on 200 with %s contractVersion', async (_name, body) => {
    installFetch(async () => new Response(body, {status: 200}))

    const observation = await probeGateway(baseOptions)

    expect(observation.result).toBe('fail')
    expect(observation.detail?.statusCode).toBe(200)
    expect(observation.detail?.contractVersion).toBeUndefined()
    expect(observationSchema.safeParse(observation).success).toBe(true)
  })

  it('is unknown with a dependency reason when the dashboard cannot be reached', async () => {
    const recorder = installFetch(async () => {
      throw new Error('connect ECONNREFUSED')
    })

    const observation = await probeGateway(baseOptions)

    expect(observation.result).toBe('unknown')
    expect(observation.detail?.reason).toBe('dependency-unreachable')
    expect(recorder.urls).toHaveLength(2)
    expect(JSON.stringify(observation)).not.toContain('ECONNREFUSED')
  })

  it('is unknown with a dependency reason when the dashboard request times out', async () => {
    installFetch(async (_url, init) => hangUntilAborted(init))

    const observation = await probeGateway({...baseOptions, timeoutMs: 15})

    expect(observation.result).toBe('unknown')
    expect(observation.detail?.reason).toBe('dependency-unreachable')
  })

  it('fails on a 502 from the dashboard route', async () => {
    installFetch(async () => new Response('bad gateway', {status: 502}))
    const observation = await probeGateway(baseOptions)
    expect(observation.result).toBe('fail')
    expect(observation.detail?.statusCode).toBe(502)
  })
})

describe('httpGet', () => {
  it('does not retry by default', async () => {
    const recorder = installFetch(async () => {
      throw new Error('boom')
    })

    const attempt = await httpGet('https://example.test/', {timeoutMs: 1000})

    expect(attempt.kind).toBe('network-error')
    expect(recorder.urls).toHaveLength(1)
  })

  it('retries network errors up to the requested count', async () => {
    const recorder = installFetch(async () => {
      throw new Error('boom')
    })

    const attempt = await httpGet('https://example.test/', {timeoutMs: 1000, retries: 2})

    expect(attempt.kind).toBe('network-error')
    expect(recorder.urls).toHaveLength(3)
  })

  it('keeps the response and measures duration on success', async () => {
    installFetch(async () => new Response('hi', {status: 200, statusText: 'OK'}))

    const attempt = await httpGet('https://example.test/', {timeoutMs: 1000})

    expect(attempt.kind).toBe('response')
    if (attempt.kind === 'response') {
      expect(attempt.status).toBe(200)
      expect(attempt.response.statusText).toBe('OK')
      expect(attempt.durationMs).toBeGreaterThanOrEqual(0)
      expect(attempt.body).toBeUndefined()
    }
  })

  it('reads the body only when asked', async () => {
    installFetch(async () => new Response('hello', {status: 200}))

    const attempt = await httpGet('https://example.test/', {timeoutMs: 1000, readBody: true})

    expect(attempt.kind === 'response' ? attempt.body : null).toBe('hello')
  })

  it('classifies an abort as a timeout and keeps the error for callers that format messages', async () => {
    installFetch(async (_url, init) => hangUntilAborted(init))

    const attempt = await httpGet('https://example.test/', {timeoutMs: 10})

    expect(attempt.kind).toBe('network-error')
    if (attempt.kind === 'network-error') {
      expect(attempt.timedOut).toBe(true)
      expect(attempt.error).toBeInstanceOf(Error)
    }
  })

  it('classifies a plain error as not timed out', async () => {
    installFetch(async () => {
      throw new Error('boom')
    })

    const attempt = await httpGet('https://example.test/', {timeoutMs: 1000})

    expect(attempt.kind === 'network-error' ? attempt.timedOut : null).toBe(false)
  })
})
