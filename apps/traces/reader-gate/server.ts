// The proxy handler. One request, in this order:
//
//   1. token       Bearer or Basic password, looked up in the token store. No token, an unknown one or a bad file: 401.
//   2. route       canonical path and method against the allowlist: 404 or 405. Neither reaches an upstream.
//   3. credential  the Langfuse Viewer pair, from the host file. Missing or a placeholder: 502.
//   4. limits      per-consumer budget and concurrency, global concurrency: 429 with Retry-After.
//   5. forward     allowlisted request headers, the host credential, redirects never followed, 60 s to headers: 504.
//   6. answer      allowlisted response headers. An upstream 3xx or Set-Cookie is a 502, and so is a Langfuse 401 (the
//                  host-held credential was refused: `credential-refused`). A Langfuse 403 is not: it is the Viewer
//                  role refusing the operation, and it passes through. The slot is held until the body ends,
//                  errors or is cancelled, or the response deadline passes.
//
// There is no registry of running requests: a revoked token fails on its next request, and a request already running
// ends within the deadlines. Every collaborator is injected, so the handler runs in tests with no port, clock or
// network. Logs carry the consumer, route, status and fingerprint, never a token, a credential, a path id or a query.

import type {LangfuseCredential} from './credentials'
import type {Limits} from './limits'
import type {RouteName, UpstreamName} from './paths'
import type {ReaderIdentity} from './tokens'
import {extractToken} from './auth'
import {filterRequestHeaders, filterResponseHeaders} from './headers'
import {matchRequest} from './paths'

export interface GateEvent {
  type: 'reader-gate'
  ts: string
  consumer: string
  fingerprint: string
  route: RouteName | 'none'
  method: string
  status: number
  ms: number
  reason?: string
  /** The upstream's own status, set only when the gate replaced its answer (`credential-refused`). */
  upstreamStatus?: number
}

export interface Deadlines {
  headersMs: number
  responseMs: number
  maxBodyBytes: number
}

export interface ServerDeps {
  store: {lookup: (token: string) => ReaderIdentity | null}
  credentials: {langfuse: () => LangfuseCredential}
  limits: Limits
  fetch: (url: string, init: RequestInit) => Promise<Response>
  clock: () => number
  /** Run `fn` after `ms`. Returns a function that cancels it. */
  schedule: (fn: () => void, ms: number) => () => void
  upstreams: Record<UpstreamName, string>
  log: (event: GateEvent) => void
  deadlines: Deadlines
}

export type Handler = (req: Request) => Promise<Response>

interface Context {
  consumer: string
  fingerprint: string
  route: RouteName | 'none'
  reason?: string
  upstreamStatus?: number
  release?: () => void
}

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

interface ErrorOptions {
  reason?: string
  headers?: Record<string, string>
}

function gateError(status: number, error: string, options: ErrorOptions = {}): Response {
  const body = options.reason === undefined ? {error} : {error, reason: options.reason}
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...options.headers},
  })
}

function badGateway(ctx: Context, reason: string): Response {
  ctx.reason = reason
  return gateError(502, 'bad gateway', {reason})
}

export function createServer(deps: ServerDeps): Handler {
  return async req => {
    const started = deps.clock()
    const ctx: Context = {consumer: '-', fingerprint: '-', route: 'none'}
    let response: Response
    try {
      response = await handle(req, deps, ctx)
    } catch {
      ctx.release?.()
      response = req.signal.aborted ? gateError(499, 'client closed request') : badGateway(ctx, 'internal-error')
    }
    deps.log({
      type: 'reader-gate',
      ts: new Date(started).toISOString(),
      consumer: ctx.consumer,
      fingerprint: ctx.fingerprint,
      route: ctx.route,
      method: KNOWN_METHODS.has(req.method) ? req.method : 'OTHER',
      status: response.status,
      ms: deps.clock() - started,
      ...(ctx.reason === undefined ? {} : {reason: ctx.reason}),
      ...(ctx.upstreamStatus === undefined ? {} : {upstreamStatus: ctx.upstreamStatus}),
    })
    return response
  }
}

async function handle(req: Request, deps: ServerDeps, ctx: Context): Promise<Response> {
  const token = extractToken(req.headers)
  const reader = token === null ? null : deps.store.lookup(token)
  if (!reader) return gateError(401, 'unauthorized')
  ctx.consumer = reader.consumer
  ctx.fingerprint = reader.fingerprint

  const match = matchRequest(req.url, req.method)
  if (match.kind === 'not-found') return gateError(404, 'not found')
  if (match.kind === 'method-not-allowed') {
    return gateError(405, 'method not allowed', {headers: {allow: match.allow}})
  }
  ctx.route = match.route

  // The Host is the upstream's own, port included: both upstreams match it against an allow-list.
  const fixed: Record<string, string> = {host: new URL(deps.upstreams[match.upstream]).host}
  if (match.upstream === 'langfuse') {
    const credential = deps.credentials.langfuse()
    if (!credential.ok) {
      const response = badGateway(ctx, 'credential-unavailable')
      ctx.reason = `credential-${credential.reason}`
      return response
    }
    fixed.authorization = credential.authorization
  }

  const lease = deps.limits.acquire(reader.consumer)
  if (!lease.ok) {
    ctx.reason = lease.reason
    return gateError(429, 'too many requests', {
      reason: lease.reason === 'rate' ? 'rate' : 'concurrency',
      headers: {'retry-after': String(lease.retryAfterSeconds)},
    })
  }
  ctx.release = lease.release

  const controller = new AbortController()
  const onClientAbort = (): void => {
    controller.abort()
    lease.release()
  }
  if (req.signal.aborted) onClientAbort()
  else req.signal.addEventListener('abort', onClientAbort, {once: true})

  let body: Uint8Array | undefined
  if (req.method === 'POST') {
    const read = await readBody(req, deps.deadlines.maxBodyBytes)
    if (read === 'too-large') {
      lease.release()
      ctx.reason = 'payload-too-large'
      return gateError(413, 'payload too large')
    }
    body = read
  }

  const url = `${deps.upstreams[match.upstream]}${match.upstreamPath}${match.query === '' ? '' : `?${match.query}`}`
  const init: RequestInit = {
    method: req.method,
    headers: filterRequestHeaders(req.headers, fixed),
    redirect: 'manual',
    signal: controller.signal,
    ...(body === undefined ? {} : {body}),
  }

  const started = deps.clock()
  const outcome = await awaitHeaders(deps, url, init, controller)
  if (outcome.kind === 'deadline') {
    lease.release()
    ctx.reason = 'deadline'
    return gateError(504, 'gateway timeout')
  }
  if (outcome.kind === 'error') {
    lease.release()
    if (req.signal.aborted) return gateError(499, 'client closed request')
    return badGateway(ctx, 'upstream-unavailable')
  }

  const upstream = outcome.response
  // Langfuse refusing the host-held Viewer pair is the gate's own fault, not the reader's: a 401 passed through would
  // read as "your token is bad". Its body is dropped, the refusal is logged. Only a 401 is that. A 403 is a role denial,
  // for example the Viewer calling an MCP write tool: it is the answer to the reader's request, not a fault of the key,
  // and it is not retryable, so it passes through unchanged. Grafana's refusals are JSON-RPC errors.
  if (match.upstream === 'langfuse' && upstream.status === 401) {
    upstream.body?.cancel().catch(() => {})
    lease.release()
    ctx.upstreamStatus = upstream.status
    return badGateway(ctx, 'credential-refused')
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    upstream.body?.cancel().catch(() => {})
    lease.release()
    return badGateway(ctx, 'upstream-redirect')
  }
  if (upstream.headers.has('set-cookie')) {
    upstream.body?.cancel().catch(() => {})
    lease.release()
    return badGateway(ctx, 'upstream-cookie')
  }

  const headers = filterResponseHeaders(upstream.headers)
  if (upstream.body === null) {
    lease.release()
    return new Response(null, {status: upstream.status, headers})
  }
  const remaining = Math.max(1, deps.deadlines.responseMs - (deps.clock() - started))
  const guarded = guardBody(upstream.body, {
    schedule: deps.schedule,
    expiresInMs: remaining,
    release: lease.release,
    abort: () => controller.abort(),
  })
  return new Response(guarded, {status: upstream.status, headers})
}

type Outcome = {kind: 'response'; response: Response} | {kind: 'deadline'} | {kind: 'error'}

/** Wait for the upstream's response headers, at most `headersMs`. The fetch is aborted if the deadline passes. */
async function awaitHeaders(
  deps: ServerDeps,
  url: string,
  init: RequestInit,
  controller: AbortController,
): Promise<Outcome> {
  let timedOut = false
  let cancelTimer = (): void => {}
  const deadline = new Promise<Outcome>(resolve => {
    cancelTimer = deps.schedule(() => {
      timedOut = true
      controller.abort()
      resolve({kind: 'deadline'})
    }, deps.deadlines.headersMs)
  })

  try {
    const pending = deps.fetch(url, init)
    pending.then(
      response => {
        if (timedOut) response.body?.cancel().catch(() => {})
      },
      () => {},
    )
    const first = await Promise.race([pending.then((response): Outcome => ({kind: 'response', response})), deadline])
    return first
  } catch {
    return timedOut ? {kind: 'deadline'} : {kind: 'error'}
  } finally {
    cancelTimer()
  }
}

async function readBody(req: Request, max: number): Promise<Uint8Array | 'too-large'> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return 'too-large'
  if (req.body === null) return new Uint8Array()

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      reader.cancel().catch(() => {})
      return 'too-large'
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

interface GuardHooks {
  schedule: ServerDeps['schedule']
  expiresInMs: number
  release: () => void
  abort: () => void
}

/**
 * Pass the upstream body through and hold the slot until it ends. The slot is released when the body ends or errors,
 * when the client cancels, and when the response deadline passes (the stream then errors, so a cut response never
 * looks complete).
 */
function guardBody(source: ReadableStream<Uint8Array>, hooks: GuardHooks): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let ended = false

  const cancelExpiry = hooks.schedule(() => {
    end(() => streamController?.error(new Error('response deadline')))
    hooks.abort()
    reader.cancel().catch(() => {})
  }, hooks.expiresInMs)

  function end(finish: () => void): void {
    if (ended) return
    ended = true
    cancelExpiry()
    hooks.release()
    finish()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
    },
    async pull(controller) {
      try {
        const {done, value} = await reader.read()
        if (ended) return
        if (done) end(() => controller.close())
        else controller.enqueue(value)
      } catch (error) {
        end(() => controller.error(error))
      }
    },
    async cancel(reason) {
      end(() => {})
      hooks.abort()
      await reader.cancel(reason).catch(() => {})
    },
  })
}
