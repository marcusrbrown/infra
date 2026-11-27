import type {LangfuseCredential} from './credentials'
import type {GateEvent} from './server'
import {Buffer} from 'node:buffer'
import {describe, expect, test} from 'bun:test'
import {createLimits} from './limits'
import {createServer} from './server'
import {basicHeader, makeToken, tokenLine, voidLine} from './testing'
import {createTokenStore} from './tokens'

const VIEWER_PAIR = 'pk-lf-viewer:sk-lf-viewer'
const VIEWER_AUTH = `Basic ${Buffer.from(VIEWER_PAIR).toString('base64')}`
const alice = makeToken('alice')
const bob = makeToken('bob')
const senderToken = makeToken('sender-group-marcusrbrown')

type UpstreamHandler = (url: string, init: RequestInit) => Response | Promise<Response>

interface FakeTimer {
  fn: () => void
  ms: number
  cancelled: boolean
}

interface Options {
  file?: string | Error
  upstream?: UpstreamHandler
  credential?: LangfuseCredential
  requestsPerWindow?: number
  perConsumerConcurrency?: number
  globalConcurrency?: number
  maxBodyBytes?: number
}

async function build(options: Options = {}) {
  let file: string | Error = options.file ?? tokenLine(alice, 'systematic') + tokenLine(bob, 'fro-bot-audit')
  const store = createTokenStore({
    path: '/run/readers/token',
    readText: async () => {
      if (file instanceof Error) throw file
      return file
    },
    log: () => {},
  })
  await store.refresh()

  const calls: {url: string; init: RequestInit}[] = []
  const events: GateEvent[] = []
  const timers: FakeTimer[] = []
  let now = 1_000_000
  const credential: LangfuseCredential = options.credential ?? {ok: true, authorization: VIEWER_AUTH}
  let credentialReads = 0

  const limits = createLimits({
    clock: () => now,
    requestsPerWindow: options.requestsPerWindow ?? 100,
    windowMs: 60_000,
    perConsumerConcurrency: options.perConsumerConcurrency ?? 4,
    globalConcurrency: options.globalConcurrency ?? 8,
  })

  const handler = createServer({
    store,
    credentials: {
      langfuse: () => {
        credentialReads += 1
        return credential
      },
    },
    limits,
    fetch: async (url, init) => {
      calls.push({url, init})
      return (options.upstream ?? (() => new Response('{"ok":true}', {headers: {'content-type': 'application/json'}})))(
        url,
        init,
      )
    },
    clock: () => now,
    schedule: (fn, ms) => {
      const timer: FakeTimer = {fn, ms, cancelled: false}
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    upstreams: {langfuse: 'http://langfuse-web:3000', grafana: 'http://grafana-mcp:8000'},
    log: event => events.push(event),
    deadlines: {headersMs: 60_000, responseMs: 90_000, maxBodyBytes: options.maxBodyBytes ?? 1024},
  })

  return {
    handler,
    store,
    limits,
    calls,
    events,
    timers,
    credentialReads: () => credentialReads,
    setFile: (value: string | Error) => {
      file = value
    },
    advance: (ms: number) => {
      now += ms
    },
    fire: (ms: number) => {
      for (const timer of timers) if (timer.ms === ms && !timer.cancelled) timer.fn()
    },
  }
}

function request(path: string, init: RequestInit & {token?: string | null; basic?: boolean} = {}): Request {
  const {token = alice, basic = false, headers, ...rest} = init
  const merged = new Headers(headers)
  if (token !== null && !merged.has('authorization')) {
    merged.set('authorization', basic ? basicHeader('reader', token) : `Bearer ${token}`)
  }
  return new Request(`http://gate:8090${path}`, {...rest, headers: merged})
}

/** Keeps dot segments and encodings that `new Request` would normalise away. */
function rawRequest(url: string, token: string = alice): Request {
  const req = new Request('http://gate:8090/placeholder', {headers: {authorization: `Bearer ${token}`}})
  Object.defineProperty(req, 'url', {value: url})
  return req
}

function controllableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    stream,
    push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    end: () => controller.close(),
    fail: (error: Error) => controller.error(error),
    cancelled: () => cancelled,
  }
}

function headerObject(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries())
}

describe('forwarding', () => {
  test('a Bearer token forwards an MCP POST with the Viewer Basic header and without the caller credential', async () => {
    const h = await build()
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})
    const res = await h.handler(
      request('/agent/langfuse/api/public/mcp', {
        method: 'POST',
        body,
        headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'},
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"ok":true}')
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]
    expect(call?.url).toBe('http://langfuse-web:3000/api/public/mcp')
    expect(call?.init.method).toBe('POST')
    expect(call?.init.redirect).toBe('manual')
    const forwarded = headerObject(call?.init ?? {})
    expect(forwarded.authorization).toBe(VIEWER_AUTH)
    expect(forwarded['content-type']).toBe('application/json')
    expect(JSON.stringify(forwarded)).not.toContain(alice)
    expect(new TextDecoder().decode(call?.init.body as Uint8Array)).toBe(body)
  })

  test('a token supplied as the Basic password forwards a GET read with its query', async () => {
    const h = await build()
    const res = await h.handler(request('/agent/langfuse/api/public/traces?limit=5&page=2', {basic: true}))
    expect(res.status).toBe(200)
    await res.text()
    const call = h.calls[0]
    expect(call?.url).toBe('http://langfuse-web:3000/api/public/traces?limit=5&page=2')
    expect(call?.init.method).toBe('GET')
    expect(call?.init.body).toBeUndefined()
    expect(headerObject(call?.init ?? {}).authorization).toBe(VIEWER_AUTH)
  })

  test('a Grafana MCP request carries no credential and none of the X-Grafana headers', async () => {
    const h = await build()
    const res = await h.handler(
      request('/agent/grafana/mcp', {
        method: 'POST',
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'x-grafana-url': 'http://evil',
          'x-grafana-api-key': 'k',
          'x-grafana-service-account-token': 't',
          cookie: 'a=b',
        },
      }),
    )
    await res.text()
    expect(h.calls[0]?.url).toBe('http://grafana-mcp:8000/mcp')
    const forwarded = headerObject(h.calls[0]?.init ?? {})
    expect(Object.keys(forwarded).filter(name => name.startsWith('x-grafana'))).toEqual([])
    expect(forwarded.authorization).toBeUndefined()
    expect(forwarded.cookie).toBeUndefined()
    expect(h.credentialReads()).toBe(0)
  })

  test('the forwarded request carries only allowlisted headers', async () => {
    const h = await build()
    const res = await h.handler(
      request('/agent/langfuse/api/public/traces', {
        headers: {
          accept: 'application/json',
          'user-agent': 'opencode',
          'mcp-protocol-version': '2025-06-18',
          cookie: 'session=1',
          'x-forwarded-for': '1.2.3.4',
          'x-forwarded-user': 'root',
          'x-grafana-url': 'http://evil',
          origin: 'http://evil',
          'x-langfuse-admin-api-key': 'admin',
          'langfuse-project-id': 'other',
          'accept-encoding': 'br',
        },
      }),
    )
    await res.text()
    const names = Object.keys(headerObject(h.calls[0]?.init ?? {})).sort()
    expect(names).toEqual(['accept', 'accept-encoding', 'authorization', 'host', 'mcp-protocol-version', 'user-agent'])
    expect(headerObject(h.calls[0]?.init ?? {})['accept-encoding']).toBe('identity')
  })

  test.each([
    ['/agent/langfuse/api/public/traces', 'GET', 'http://langfuse-web:3000/api/public/traces', 'langfuse-web:3000'],
    ['/agent/langfuse/api/public/mcp', 'POST', 'http://langfuse-web:3000/api/public/mcp', 'langfuse-web:3000'],
    ['/agent/grafana/mcp', 'POST', 'http://grafana-mcp:8000/mcp', 'grafana-mcp:8000'],
  ])('%s reaches its upstream with Host %s, whatever the client sent', async (path, method, url, host) => {
    const h = await build()
    const res = await h.handler(
      request(path, {
        method,
        body: method === 'POST' ? '{}' : undefined,
        headers: {host: 'traces.fro.bot', 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example'},
      }),
    )
    await res.text()
    expect(h.calls[0]?.url).toBe(url)
    const forwarded = headerObject(h.calls[0]?.init ?? {})
    expect(forwarded.host).toBe(host)
    expect(forwarded['x-forwarded-host']).toBeUndefined()
    expect(forwarded.forwarded).toBeUndefined()
  })

  test('the response carries only allowlisted headers', async () => {
    const h = await build({
      upstream: () =>
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'abc',
            server: 'nginx',
            'x-powered-by': 'next',
            'access-control-allow-origin': '*',
            etag: 'x',
            'cache-control': 'no-store',
          },
        }),
    })
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    await res.text()
    expect([...res.headers.keys()].sort()).toEqual(['content-type', 'mcp-session-id'])
  })

  test.each([400, 404, 409, 422, 500, 503])('an upstream %i passes through unchanged', async status => {
    const h = await build({
      upstream: () => new Response(`upstream ${status}`, {status, headers: {'content-type': 'text/plain'}}),
    })
    const res = await h.handler(request('/agent/langfuse/api/public/traces/abc'))
    expect(res.status).toBe(status)
    expect(await res.text()).toBe(`upstream ${status}`)
  })

  test('an upstream 429 keeps its Retry-After', async () => {
    const h = await build({upstream: () => new Response('slow down', {status: 429, headers: {'retry-after': '7'}})})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
  })

  test('an upstream with no body (204) answers with no body', async () => {
    const h = await build({upstream: () => new Response(null, {status: 204})})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(204)
    expect(res.body).toBeNull()
    expect(h.limits.stats().active).toBe(0)
  })
})

describe('authentication', () => {
  test.each([
    ['no token', null],
    ['an unknown token', makeToken('stranger')],
    ['a sender token', senderToken],
  ])('%s gives 401 and never reaches the upstream', async (_name, token) => {
    const h = await build()
    for (const path of ['/agent/langfuse/api/public/traces', '/agent/grafana/mcp', '/agent/langfuse/nope']) {
      const res = await h.handler(
        request(path, {
          token,
          method: path.endsWith('mcp') ? 'POST' : 'GET',
          body: path.endsWith('mcp') ? '{}' : undefined,
        }),
      )
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBeNull()
    }
    expect(h.calls).toHaveLength(0)
  })

  test('an unauthenticated unknown path is 401, not 404', async () => {
    const h = await build()
    const res = await h.handler(request('/anything', {token: null}))
    expect(res.status).toBe(401)
  })

  const bad: [string, string | Error][] = [
    ['missing', Object.assign(new Error('ENOENT'), {code: 'ENOENT'})],
    ['unreadable', Object.assign(new Error('EACCES'), {code: 'EACCES'})],
    ['empty', ''],
    ['malformed', 'not a token file\n'],
    ['void-only', voidLine()],
  ]

  test.each(bad)('a token file that is %s at start gives 401 for every token', async (_name, file) => {
    const h = await build({file})
    for (const token of [alice, bob, senderToken]) {
      const res = await h.handler(request('/agent/langfuse/api/public/traces', {token}))
      expect(res.status).toBe(401)
    }
    expect(h.calls).toHaveLength(0)
  })

  test.each(bad)('a token file that becomes %s after a reload gives 401 for every token', async (_name, file) => {
    const h = await build()
    expect((await h.handler(request('/agent/langfuse/api/public/traces'))).status).toBe(200)
    h.setFile(file)
    await h.store.refresh()
    for (const token of [alice, bob]) {
      const res = await h.handler(request('/agent/langfuse/api/public/traces', {token}))
      expect(res.status).toBe(401)
    }
    expect(h.calls).toHaveLength(1)
  })

  test('a rename-replace that removes one token makes only that token 401 on its next request', async () => {
    const h = await build()
    expect((await h.handler(request('/agent/langfuse/api/public/traces', {token: alice}))).status).toBe(200)
    expect((await h.handler(request('/agent/langfuse/api/public/traces', {token: bob}))).status).toBe(200)
    h.setFile(tokenLine(bob, 'fro-bot-audit'))
    await h.store.refresh()
    expect((await h.handler(request('/agent/langfuse/api/public/traces', {token: alice}))).status).toBe(401)
    expect((await h.handler(request('/agent/langfuse/api/public/traces', {token: bob}))).status).toBe(200)
  })

  test('a revoked token does not abort a request already in flight', async () => {
    const stream = controllableStream()
    const h = await build({upstream: () => new Response(stream.stream)})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    h.setFile(voidLine())
    await h.store.refresh()
    stream.push('still ')
    stream.push('flowing')
    stream.end()
    expect(await res.text()).toBe('still flowing')
  })
})

describe('method and path', () => {
  test.each([
    ['DELETE', '/agent/langfuse/api/public/traces'],
    ['POST', '/agent/langfuse/api/public/traces'],
    ['PUT', '/agent/langfuse/api/public/sessions/abc'],
    ['GET', '/agent/langfuse/api/public/mcp'],
    ['DELETE', '/agent/langfuse/api/public/mcp'],
    ['GET', '/agent/grafana/mcp'],
  ])('%s %s gives 405 with Allow and never reaches the upstream', async (method, path) => {
    const h = await build()
    const res = await h.handler(request(path, {method, body: method === 'POST' ? '{}' : undefined}))
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toMatch(/^(GET|POST)$/)
    expect(h.calls).toHaveLength(0)
  })

  test.each([
    '/agent/langfuse/project/x/traces',
    '/agent/langfuse/api/public/scores',
    '/agent/langfuse/api/public/ingestion',
    '/agent/grafana/api/dashboards',
    '/agent/grafana/login',
    '/healthz',
    '/',
  ])('%s gives 404', async path => {
    const h = await build()
    const res = await h.handler(request(path))
    expect(res.status).toBe(404)
    expect(h.calls).toHaveLength(0)
  })

  const refused = [
    'http://gate:8090/agent/langfuse/api/public/../traces',
    'http://gate:8090/agent/langfuse/api/public/%2e%2e/traces',
    'http://gate:8090/agent/langfuse/api/public/traces%2fabc',
    'http://gate:8090/agent/langfuse/api/public/traces%5cabc',
    'http://gate:8090/agent/langfuse/api/public//traces',
    'http://gate:8090/agent/langfuse/api/public/traces;x=1',
    'http://gate:8090/agent/langfuse/api/public/traces/a.b',
    'http://gate:8090/agent/langfuse/api/public/traces/abc%00',
    'http://gate:8090/agent/grafana/mcp/../../api/admin',
    'http://gate:8090/agent/langfuse/../grafana/mcp',
  ]
  test.each(refused)('%s gives 404 and never reaches the upstream', async url => {
    const h = await build()
    const res = await h.handler(rawRequest(url))
    expect(res.status).toBe(404)
    expect(h.calls).toHaveLength(0)
  })
})

describe('credentials', () => {
  test.each([
    ['missing', {ok: false, reason: 'missing'}],
    ['placeholder', {ok: false, reason: 'placeholder'}],
    ['malformed', {ok: false, reason: 'malformed'}],
    ['unreadable', {ok: false, reason: 'unreadable'}],
  ] as const)('a %s Langfuse credential gives 502 with a fixed reason and no fetch', async (_name, credential) => {
    const h = await build({credential})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({error: 'bad gateway', reason: 'credential-unavailable'})
    expect(h.calls).toHaveLength(0)
    expect(h.limits.stats().active).toBe(0)
  })

  test('a placeholder Langfuse credential does not block the Grafana route', async () => {
    const h = await build({credential: {ok: false, reason: 'placeholder'}})
    const res = await h.handler(request('/agent/grafana/mcp', {method: 'POST', body: '{}'}))
    expect(res.status).toBe(200)
    await res.text()
  })
})

describe('limits', () => {
  test('an over-budget consumer gets 429 with Retry-After while another consumer still passes', async () => {
    const h = await build({requestsPerWindow: 2})
    for (let i = 0; i < 2; i += 1) {
      const res = await h.handler(request('/agent/langfuse/api/public/traces', {token: alice}))
      await res.text()
      expect(res.status).toBe(200)
    }
    const denied = await h.handler(request('/agent/langfuse/api/public/traces', {token: alice}))
    expect(denied.status).toBe(429)
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await denied.json()).toEqual({error: 'too many requests', reason: 'rate'})
    const other = await h.handler(request('/agent/langfuse/api/public/traces', {token: bob}))
    expect(other.status).toBe(200)
    await other.text()
    expect(h.calls).toHaveLength(3)
  })

  test('the budget spans both routes', async () => {
    const h = await build({requestsPerWindow: 2})
    await (await h.handler(request('/agent/langfuse/api/public/traces'))).text()
    await (await h.handler(request('/agent/grafana/mcp', {method: 'POST', body: '{}'}))).text()
    const denied = await h.handler(request('/agent/grafana/mcp', {method: 'POST', body: '{}'}))
    expect(denied.status).toBe(429)
  })

  test('requests that are 404 or 405 do not spend budget', async () => {
    const h = await build({requestsPerWindow: 1})
    for (let i = 0; i < 5; i += 1) {
      expect((await h.handler(request('/agent/langfuse/nope'))).status).toBe(404)
      expect((await h.handler(request('/agent/langfuse/api/public/traces', {method: 'DELETE'}))).status).toBe(405)
    }
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(200)
    await res.text()
  })

  test('at the per-consumer cap the next request gets 429, and the slot is freed when the body ends', async () => {
    const streams = [controllableStream(), controllableStream(), controllableStream()]
    const queue = [...streams]
    const h = await build({perConsumerConcurrency: 2, upstream: () => new Response(queue.shift()?.stream)})
    const first = await h.handler(request('/agent/langfuse/api/public/traces'))
    const second = await h.handler(request('/agent/langfuse/api/public/traces'))
    const third = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({error: 'too many requests', reason: 'concurrency'})
    expect(third.headers.get('retry-after')).not.toBeNull()
    expect(h.calls).toHaveLength(2)

    streams[0]?.push('a')
    streams[0]?.end()
    expect(await first.text()).toBe('a')
    expect(h.limits.stats().active).toBe(1)

    const fourth = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(fourth.status).toBe(200)
    expect(h.limits.stats().active).toBe(2)
    streams[1]?.end()
    streams[2]?.end()
    await second.text()
    await fourth.text()
    expect(h.limits.stats().active).toBe(0)
  })

  test('the slot is freed when the client cancels the body', async () => {
    const stream = controllableStream()
    const h = await build({perConsumerConcurrency: 1, upstream: () => new Response(stream.stream)})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(h.limits.stats().active).toBe(1)
    expect((await h.handler(request('/agent/langfuse/api/public/traces'))).status).toBe(429)
    await res.body?.cancel()
    expect(h.limits.stats().active).toBe(0)
    expect(stream.cancelled()).toBe(true)
  })

  test('the slot is freed when the client cancels with a chunk still unread', async () => {
    const stream = controllableStream()
    const h = await build({perConsumerConcurrency: 1, upstream: () => new Response(stream.stream)})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    stream.push('unread')
    await Bun.sleep(0)
    expect(h.limits.stats().active).toBe(1)
    await res.body?.cancel()
    expect(h.limits.stats().active).toBe(0)
    expect((h.calls[0]?.init.signal as AbortSignal).aborted).toBe(true)
  })

  test('the slot is freed when the client request is aborted, and the upstream is aborted too', async () => {
    const stream = controllableStream()
    const h = await build({perConsumerConcurrency: 1, upstream: () => new Response(stream.stream)})
    const abort = new AbortController()
    const res = await h.handler(request('/agent/langfuse/api/public/traces', {signal: abort.signal}))
    expect(h.limits.stats().active).toBe(1)
    abort.abort()
    expect(h.limits.stats().active).toBe(0)
    expect((h.calls[0]?.init.signal as AbortSignal).aborted).toBe(true)
    await res.body?.cancel().catch(() => {})
  })

  test('the slot is freed when the upstream body errors', async () => {
    const stream = controllableStream()
    const h = await build({perConsumerConcurrency: 1, upstream: () => new Response(stream.stream)})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    const read = res.text().then(
      () => 'completed',
      () => 'errored',
    )
    stream.push('partial')
    await Bun.sleep(0)
    expect(h.limits.stats().active).toBe(1)
    stream.fail(new Error('upstream reset'))
    expect(await read).toBe('errored')
    expect(h.limits.stats().active).toBe(0)
  })

  test('the global cap gives 429 across consumers', async () => {
    const queue = [controllableStream(), controllableStream()]
    const h = await build({globalConcurrency: 2, upstream: () => new Response(queue.shift()?.stream)})
    await h.handler(request('/agent/langfuse/api/public/traces', {token: alice}))
    await h.handler(request('/agent/langfuse/api/public/traces', {token: bob}))
    const third = await h.handler(request('/agent/langfuse/api/public/sessions', {token: alice}))
    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({error: 'too many requests', reason: 'concurrency'})
  })
})

describe('deadlines', () => {
  test('an upstream that sends no headers within the deadline gives 504 and frees the slot', async () => {
    const h = await build({perConsumerConcurrency: 1, upstream: () => new Promise<Response>(() => {})})
    const pending = h.handler(request('/agent/langfuse/api/public/traces'))
    await Bun.sleep(0)
    expect(h.timers.filter(timer => timer.ms === 60_000)).toHaveLength(1)
    expect(h.limits.stats().active).toBe(1)
    h.fire(60_000)
    const res = await pending
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({error: 'gateway timeout'})
    expect((h.calls[0]?.init.signal as AbortSignal).aborted).toBe(true)
    expect(h.limits.stats().active).toBe(0)
  })

  test('the header deadline is cancelled once headers arrive', async () => {
    const h = await build()
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    await res.text()
    const headerTimers = h.timers.filter(timer => timer.ms === 60_000)
    expect(headerTimers).toHaveLength(1)
    expect(headerTimers[0]?.cancelled).toBe(true)
  })

  test('a body that never ends is cut at the response deadline and frees the slot', async () => {
    const stream = controllableStream()
    const h = await build({perConsumerConcurrency: 1, upstream: () => new Response(stream.stream)})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    const read = res.text().then(
      () => 'completed',
      () => 'errored',
    )
    stream.push('part')
    await Bun.sleep(0)
    h.fire(90_000)
    expect(await read).toBe('errored')
    expect(h.limits.stats().active).toBe(0)
  })

  test('an upstream that fails to connect gives 502 and frees the slot', async () => {
    const h = await build({
      perConsumerConcurrency: 1,
      upstream: () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:3000')
      },
    })
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({error: 'bad gateway', reason: 'upstream-unavailable'})
    expect(h.limits.stats().active).toBe(0)
  })
})

describe('redirects and cookies', () => {
  test('an upstream 3xx gives 502, is never followed, and does not leak Location', async () => {
    const h = await build({
      upstream: () => new Response(null, {status: 302, headers: {location: 'http://evil.example/login'}}),
    })
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({error: 'bad gateway', reason: 'upstream-redirect'})
    expect(res.headers.get('location')).toBeNull()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.init.redirect).toBe('manual')
    expect(h.limits.stats().active).toBe(0)
  })

  test.each([301, 303, 307, 308])('a %i is a 502 too', async status => {
    const h = await build({upstream: () => new Response(null, {status, headers: {location: '/x'}})})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(502)
  })

  test('an upstream that sets a cookie gives 502 and its body is discarded', async () => {
    const stream = controllableStream()
    const h = await build({
      upstream: () =>
        new Response(stream.stream, {
          status: 200,
          headers: {'set-cookie': 'session=abc; Path=/', 'content-type': 'text/html'},
        }),
    })
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({error: 'bad gateway', reason: 'upstream-cookie'})
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(stream.cancelled()).toBe(true)
    expect(h.limits.stats().active).toBe(0)
  })
})

// A reader whose own token is good must never be told its token is bad because the host-held credential is. The
// Langfuse upstream answers 401 or 403 to a refused Viewer pair; the gate turns that into its own 502.
describe('a Langfuse credential the upstream refuses', () => {
  const CANARY = 'upstream-body-canary-do-not-forward'

  test.each([401, 403])('an upstream %i gives 502 credential-refused, and the body is discarded', async status => {
    const stream = controllableStream()
    stream.push(CANARY)
    const h = await build({
      upstream: () => new Response(stream.stream, {status, headers: {'content-type': 'application/json'}}),
    })
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({error: 'bad gateway', reason: 'credential-refused'})
    expect(stream.cancelled()).toBe(true)
    expect(h.limits.stats().active).toBe(0)
  })

  test('the 502 carries nothing of the upstream answer: no www-authenticate, no body, no content type of its own', async () => {
    const h = await build({
      upstream: () =>
        new Response(CANARY, {
          status: 401,
          headers: {'www-authenticate': 'Basic realm="langfuse"', 'x-upstream': 'yes'},
        }),
    })
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.headers.get('www-authenticate')).toBeNull()
    expect(res.headers.get('x-upstream')).toBeNull()
    expect(await res.text()).not.toContain(CANARY)
  })

  test('it is logged with its reason and the upstream status, and never the body', async () => {
    const h = await build({upstream: () => new Response(CANARY, {status: 403})})
    await (await h.handler(request('/agent/langfuse/api/public/traces'))).text()
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({status: 502, reason: 'credential-refused', upstreamStatus: 403})
    expect(JSON.stringify(h.events)).not.toContain(CANARY)
  })

  test('it applies to the MCP path and the REST paths alike', async () => {
    for (const [path, init] of [
      ['/agent/langfuse/api/public/mcp', {method: 'POST', body: '{}'}],
      ['/agent/langfuse/api/public/sessions', {}],
      ['/agent/langfuse/api/public/health', {}],
    ] as const) {
      const h = await build({upstream: () => new Response('nope', {status: 401})})
      const res = await h.handler(request(path, init))
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({error: 'bad gateway', reason: 'credential-refused'})
    }
  })

  test.each([400, 404, 409, 422, 429, 500])('an upstream %i passes through unchanged', async status => {
    const h = await build({upstream: () => new Response('{"message":"x"}', {status})})
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(status)
    expect(await res.text()).toBe('{"message":"x"}')
  })

  test.each([401, 403])('a Grafana upstream %i is left alone: its refusals are JSON-RPC answers', async status => {
    const h = await build({upstream: () => new Response('{"jsonrpc":"2.0","error":{"code":-32001}}', {status})})
    const res = await h.handler(request('/agent/grafana/mcp', {method: 'POST', body: '{}'}))
    expect(res.status).toBe(status)
    expect(await res.text()).toContain('-32001')
  })

  test('a good answer is not touched', async () => {
    const h = await build()
    const res = await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(200)
    await res.text()
    expect(h.events[0]?.reason).toBeUndefined()
    expect(h.events[0]).not.toHaveProperty('upstreamStatus')
  })
})

describe('request body', () => {
  test('a declared length over the cap gives 413 and no fetch', async () => {
    const h = await build({maxBodyBytes: 16})
    const res = await h.handler(request('/agent/grafana/mcp', {method: 'POST', body: 'x'.repeat(17)}))
    expect(res.status).toBe(413)
    expect(h.calls).toHaveLength(0)
    expect(h.limits.stats().active).toBe(0)
  })

  test('a streamed body over the cap gives 413 and no fetch', async () => {
    const h = await build({maxBodyBytes: 16})
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(10)))
        controller.enqueue(new TextEncoder().encode('x'.repeat(10)))
        controller.close()
      },
    })
    const req = new Request('http://gate:8090/agent/grafana/mcp', {
      method: 'POST',
      body,
      headers: {authorization: `Bearer ${alice}`},
      duplex: 'half',
    } as RequestInit)
    const res = await h.handler(req)
    expect(res.status).toBe(413)
    expect(h.calls).toHaveLength(0)
  })

  test('a body at the cap passes', async () => {
    const h = await build({maxBodyBytes: 16})
    const res = await h.handler(request('/agent/grafana/mcp', {method: 'POST', body: 'x'.repeat(16)}))
    expect(res.status).toBe(200)
    await res.text()
  })
})

describe('audit log', () => {
  test('records consumer, route, status and fingerprint, and never any token or credential text', async () => {
    const h = await build()
    await (await h.handler(request('/agent/langfuse/api/public/traces', {token: alice, basic: true}))).text()
    await (await h.handler(request('/agent/grafana/mcp', {token: bob, method: 'POST', body: '{}'}))).text()
    await h.handler(request('/agent/langfuse/api/public/traces', {token: senderToken}))
    await h.handler(request('/agent/langfuse/api/public/traces', {token: null}))
    await h.handler(request('/agent/langfuse/nope', {token: alice}))
    await h.handler(request('/agent/langfuse/api/public/traces', {token: alice, method: 'DELETE'}))

    const byStatus = h.events.map(event => ({consumer: event.consumer, route: event.route, status: event.status}))
    expect(byStatus).toEqual([
      {consumer: 'systematic', route: 'langfuse-rest', status: 200},
      {consumer: 'fro-bot-audit', route: 'grafana-mcp', status: 200},
      {consumer: '-', route: 'none', status: 401},
      {consumer: '-', route: 'none', status: 401},
      {consumer: 'systematic', route: 'none', status: 404},
      {consumer: 'systematic', route: 'none', status: 405},
    ])
    expect(h.events[0]?.fingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(h.events[2]?.fingerprint).toBe('-')

    const text = JSON.stringify(h.events)
    for (const secret of [alice, bob, senderToken, VIEWER_PAIR, VIEWER_AUTH, basicHeader('reader', alice), 'Bearer ']) {
      expect(text).not.toContain(secret)
    }
    expect(text).not.toContain(Buffer.from(`reader:${alice}`).toString('base64'))
  })

  test('records 429 with a reason and 502 and 504 with their status', async () => {
    const h = await build({requestsPerWindow: 1, upstream: () => new Response(null, {status: 302})})
    await h.handler(request('/agent/langfuse/api/public/traces'))
    await h.handler(request('/agent/langfuse/api/public/traces'))
    expect(h.events.map(event => event.status)).toEqual([502, 429])
    expect(h.events[1]?.reason).toBe('rate')
    expect(h.events[0]?.reason).toBe('upstream-redirect')
  })

  test('never logs the query string or the path ids', async () => {
    const h = await build()
    await (await h.handler(request('/agent/langfuse/api/public/traces/secret-trace-id?name=private-question'))).text()
    const text = JSON.stringify(h.events)
    expect(text).not.toContain('secret-trace-id')
    expect(text).not.toContain('private-question')
  })
})

describe('internal faults', () => {
  test('an unexpected error gives a generic 502 with no detail and frees the slot', async () => {
    const h = await build({perConsumerConcurrency: 1})
    const broken = createServer({
      store: h.store,
      credentials: {
        langfuse: () => {
          throw new Error(`boom ${alice}`)
        },
      },
      limits: h.limits,
      fetch: async () => new Response('x'),
      clock: () => 0,
      schedule: () => () => {},
      upstreams: {langfuse: 'http://langfuse-web:3000', grafana: 'http://grafana-mcp:8000'},
      log: event => h.events.push(event),
      deadlines: {headersMs: 1, responseMs: 2, maxBodyBytes: 3},
    })
    const res = await broken(request('/agent/langfuse/api/public/traces'))
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain(alice)
    expect(JSON.parse(text)).toEqual({error: 'bad gateway', reason: 'internal-error'})
    expect(JSON.stringify(h.events)).not.toContain(alice)
    expect(h.limits.stats().active).toBe(0)
  })
})
