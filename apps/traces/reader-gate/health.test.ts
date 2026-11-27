import {describe, expect, test} from 'bun:test'

import {createHealthHandler} from './health'

const UPSTREAMS = {langfuse: 'http://langfuse-web:3000', grafana: 'http://grafana-mcp:8000'}

type Probe = (url: string, init: RequestInit) => Response | Promise<Response>

function build(probe: Probe, options: {cacheMs?: number; probeTimeoutMs?: number} = {}) {
  let now = 0
  const calls: {url: string; init: RequestInit}[] = []
  const handler = createHealthHandler({
    fetch: async (url, init) => {
      calls.push({url, init})
      return probe(url, init)
    },
    upstreams: UPSTREAMS,
    clock: () => now,
    cacheMs: options.cacheMs ?? 5000,
    probeTimeoutMs: options.probeTimeoutMs ?? 50,
  })
  return {
    handler,
    calls,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const get = (path = '/healthz', method = 'GET') => new Request(`http://gate:8091${path}`, {method})

describe('health endpoint', () => {
  test('reports both upstreams reachable', async () => {
    const h = build(() => new Response('ok'))
    const res = await h.handler(get())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ok: true, langfuse: true, grafana: true})
    expect(h.calls.map(call => call.url).sort()).toEqual([
      'http://grafana-mcp:8000/healthz',
      'http://langfuse-web:3000/api/public/health',
    ])
  })

  test('the probes carry no credentials and never follow a redirect', async () => {
    const h = build(() => new Response('ok'))
    await h.handler(get())
    for (const call of h.calls) {
      expect(call.init.method).toBe('GET')
      expect(call.init.redirect).toBe('manual')
      expect(new Headers(call.init.headers).has('authorization')).toBe(false)
    }
  })

  test('reports each upstream separately', async () => {
    const h = build(url => (url.includes('langfuse-web') ? new Response('down', {status: 503}) : new Response('ok')))
    const res = await h.handler(get())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ok: false, langfuse: false, grafana: true})
  })

  test('a connection error counts as unreachable for that upstream only', async () => {
    const h = build(url => {
      if (url.includes('grafana-mcp')) throw new Error('connect ECONNREFUSED')
      return new Response('ok')
    })
    const res = await h.handler(get())
    expect(await res.json()).toEqual({ok: false, langfuse: true, grafana: false})
  })

  test('answers with an HTTP response however the upstreams fail, so the compose healthcheck stays green', async () => {
    const handler = createHealthHandler({
      fetch: () => {
        throw new Error('synchronous failure')
      },
      upstreams: UPSTREAMS,
      clock: () => 0,
      cacheMs: 0,
      probeTimeoutMs: 10,
    })
    const res = await handler(get())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ok: false, langfuse: false, grafana: false})
  })

  test('a redirect counts as unreachable', async () => {
    const h = build(() => new Response(null, {status: 302, headers: {location: '/x'}}))
    expect(await (await h.handler(get())).json()).toEqual({ok: false, langfuse: false, grafana: false})
  })

  test('a probe that hangs counts as unreachable after the timeout', async () => {
    const h = build(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      {probeTimeoutMs: 10},
    )
    const res = await h.handler(get())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ok: false, langfuse: false, grafana: false})
  })

  test('the body holds exactly ok, langfuse and grafana', async () => {
    const h = build(() => new Response('ok'))
    const body = (await (await h.handler(get())).json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['grafana', 'langfuse', 'ok'])
  })

  test('answers from the cache inside the cache window, and probes again after it', async () => {
    const h = build(() => new Response('ok'))
    await h.handler(get())
    await h.handler(get())
    expect(h.calls).toHaveLength(2)
    h.advance(5001)
    await h.handler(get())
    expect(h.calls).toHaveLength(4)
  })

  test('concurrent requests share one probe round', async () => {
    const h = build(() => new Response('ok'))
    await Promise.all([h.handler(get()), h.handler(get()), h.handler(get())])
    expect(h.calls).toHaveLength(2)
  })

  test('other paths are 404 and other methods 405', async () => {
    const h = build(() => new Response('ok'))
    expect((await h.handler(get('/metrics'))).status).toBe(404)
    expect((await h.handler(get('/'))).status).toBe(404)
    expect((await h.handler(get('/healthz', 'POST'))).status).toBe(405)
    expect(h.calls).toHaveLength(0)
  })
})
