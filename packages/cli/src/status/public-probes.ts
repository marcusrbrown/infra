import type {AppId, Observation, ObservationDetail} from './observation'
import type {TcpConnect} from './tcp-probe'

import {notMeasured} from './collect'
import {netConnect, parseProbeHost, tcpReach} from './tcp-probe'

/**
 * Public HTTPS probes: one per publicly reachable app, shared by `status` and the snapshot.
 *
 * `packages/` never imports `apps/`, so the umami heartbeat, dashboard healthz and gateway operator-health
 * predicates are reimplemented here from the deploy-time probes in `apps/*\/src/deploy.ts`.
 *
 * Result rules (every probe):
 * - 2xx and the body predicate (if any) holds → `pass`
 * - any other HTTP status, or a 2xx whose body fails the predicate → `fail` (never retried: the server answered)
 * - network error or timeout, after one retry → `unknown` (we could not observe the endpoint, so we cannot
 *   say it is down)
 *
 * Observations never carry response bodies, URLs or error text; see `observationDetailSchema`.
 *
 * The VPN box serves nothing over HTTPS, so its probe is a TCP connect (see `probeVpn`).
 */

export const PUBLIC_PROBE_TIMEOUT_MS = 10_000
const PUBLIC_PROBE_RETRIES = 1
export const MAX_BODY_CHARS = 64 * 1024

export const KEEWEB_ORIGIN = 'https://kw.igg.ms'
export const CLIPROXY_ORIGIN = 'https://cliproxy.fro.bot'
export const BROKER_ORIGIN = 'https://broker.fro.bot'
export const UMAMI_ORIGIN = 'https://metrics.fro.bot'
export const DASHBOARD_ORIGIN = 'https://dashboard.fro.bot'
export const TRACES_ORIGIN = 'https://traces.fro.bot'

/** Observation id used by every public probe. */
export const PUBLIC_REACHABILITY_ID = 'public-reachability'

// ─── Low-level GET ────────────────────────────────────────────────────────────

export interface HttpResponseAttempt {
  kind: 'response'
  response: Response
  status: number
  ok: boolean
  durationMs: number
  /** Present only for a 2xx when `readBody` was requested and the read finished; truncated to `MAX_BODY_CHARS`. */
  body?: string
}

export interface HttpNetworkErrorAttempt {
  kind: 'network-error'
  /** Raw error for callers that format their own human-readable message. Never copy it into an observation. */
  error: unknown
  timedOut: boolean
  durationMs: number
}

export type HttpAttempt = HttpResponseAttempt | HttpNetworkErrorAttempt

export interface HttpGetOptions {
  timeoutMs: number
  /** Extra attempts after a network error. HTTP responses are never retried. Default 0. */
  retries?: number
  readBody?: boolean
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false
  }

  return error.name === 'TimeoutError' || error.name === 'AbortError'
}

/** Best effort: a non-2xx body is never read, so release it without waiting or throwing. */
function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => undefined)
  } catch {
    // Nothing to release.
  }
}

/**
 * Read at most `MAX_BODY_CHARS` decoded characters, then cancel the stream. A read error or the abort
 * signal (the request timeout) yields `undefined`; the caller already has the status code.
 */
async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    return ''
  }

  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
    }
    signal.addEventListener('abort', () => reject(signal.reason), {once: true})
  })
  aborted.catch(() => undefined)

  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < MAX_BODY_CHARS) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (chunk.done) {
        text += decoder.decode()
        break
      }
      text += decoder.decode(chunk.value, {stream: true})
    }

    return text.slice(0, MAX_BODY_CHARS)
  } catch {
    return undefined
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/**
 * GET with an abort timeout and optional retry on network error. Only a rejected `fetch()` is retried.
 * A non-2xx response returns at once with its status and no body. A 2xx body that cannot be read in time
 * comes back as a response attempt with `body` undefined. Duration is that of the final attempt.
 */
export async function httpGet(url: string, options: HttpGetOptions): Promise<HttpAttempt> {
  const retries = options.retries ?? 0
  let lastError: HttpNetworkErrorAttempt | undefined

  for (let attempt = 0; attempt <= retries; attempt++) {
    const startedAt = performance.now()
    const signal = AbortSignal.timeout(options.timeoutMs)

    let response: Response
    try {
      response = await fetch(url, {signal})
    } catch (error) {
      lastError = {
        kind: 'network-error',
        error,
        timedOut: isTimeoutError(error),
        durationMs: Math.max(0, performance.now() - startedAt),
      }
      continue
    }

    let body: string | undefined
    if (!response.ok) {
      discardBody(response)
    } else if (options.readBody === true) {
      body = await readBoundedBody(response, signal)
    }

    return {
      kind: 'response',
      response,
      status: response.status,
      ok: response.ok,
      durationMs: Math.max(0, performance.now() - startedAt),
      body,
    }
  }

  // The loop always runs at least once, so lastError is set here.
  return lastError as HttpNetworkErrorAttempt
}

// ─── Probe plumbing ───────────────────────────────────────────────────────────

export interface ProbeOptions {
  /** Replaces the default origin, e.g. for tests. The probe path is still appended. */
  baseUrl?: string
  timeoutMs?: number
  now?: () => Date
  /**
   * The VPN box address, for `probeVpn` only; no other probe reads it. It is sensitive: the caller reads it from
   * the environment (see `vpnProbeHost`), and the probe never copies it into an observation.
   */
  host?: string
  /** Replaces the TCP connector, so tests never open a socket. `probeVpn` only. */
  connect?: TcpConnect
}

type BodyVerdict = {ok: true; detail?: Pick<ObservationDetail, 'contractVersion'>} | {ok: false}

interface ProbeSpec {
  origin: string
  path: string
  /** When set, the body is read and a 2xx only passes if this accepts it. */
  checkBody?: (body: string) => BodyVerdict
  /** Reason recorded when the endpoint cannot be reached. */
  unreachableReason: 'network-error' | 'dependency-unreachable'
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }

  return parsed as Record<string, unknown>
}

/**
 * Traces health path: `{ok: true, at: <string>}`. The body is exactly a boolean and a timestamp by design (the
 * path is public), so only the boolean is read. A 503 is a failing verdict and is a `fail` through the status
 * code before the body is ever looked at.
 */
function checkTracesHealth(body: string): BodyVerdict {
  return parseJsonObject(body)?.ok === true ? {ok: true} : {ok: false}
}

/** Umami heartbeat: `{ok: true}`. */
function checkUmamiHeartbeat(body: string): BodyVerdict {
  return parseJsonObject(body)?.ok === true ? {ok: true} : {ok: false}
}

const CONTRACT_VERSION_PATTERN = /^[\w.+-]{1,64}$/

/**
 * Gateway operator health: a non-empty string `contractVersion`. Stricter than the deploy-time probe in that
 * the value must also fit the observation detail bounds (≤64 chars of `[A-Za-z0-9_.+-]`), so an unexpected
 * value is a `fail` rather than being copied through.
 */
function checkOperatorHealth(body: string): BodyVerdict {
  const version = parseJsonObject(body)?.contractVersion
  // The pattern also rules out empty and whitespace-only values.
  if (typeof version !== 'string' || !CONTRACT_VERSION_PATTERN.test(version)) {
    return {ok: false}
  }

  return {ok: true, detail: {contractVersion: version}}
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

async function runProbe(spec: ProbeSpec, options: ProbeOptions = {}): Promise<Observation> {
  const url = `${stripTrailingSlash(options.baseUrl ?? spec.origin)}${spec.path}`
  const attempt = await httpGet(url, {
    timeoutMs: options.timeoutMs ?? PUBLIC_PROBE_TIMEOUT_MS,
    retries: PUBLIC_PROBE_RETRIES,
    readBody: spec.checkBody !== undefined,
  })
  const observedAt = (options.now?.() ?? new Date()).toISOString()
  const durationMs = Math.round(attempt.durationMs)

  const make = (result: 'pass' | 'fail' | 'unknown', detail: ObservationDetail): Observation => ({
    id: PUBLIC_REACHABILITY_ID,
    kind: 'reachability',
    result,
    observedAt,
    source: 'http',
    detail,
  })

  if (attempt.kind === 'network-error') {
    let reason = attempt.timedOut ? 'timeout' : 'network-error'
    if (spec.unreachableReason === 'dependency-unreachable') {
      reason = 'dependency-unreachable'
    }

    return make('unknown', {durationMs, reason})
  }

  const detail: ObservationDetail = {statusCode: attempt.status, durationMs}
  if (!attempt.ok) {
    return make('fail', detail)
  }

  if (spec.checkBody === undefined) {
    return make('pass', detail)
  }

  const verdict = spec.checkBody(attempt.body ?? '')
  return verdict.ok ? make('pass', {...detail, ...verdict.detail}) : make('fail', detail)
}

// ─── Probes ───────────────────────────────────────────────────────────────────

/** KeeWeb: the page itself answers 2xx. */
export function probeKeeweb(options?: ProbeOptions): Promise<Observation> {
  return runProbe({origin: KEEWEB_ORIGIN, path: '/', unreachableReason: 'network-error'}, options)
}

/** CLIProxyAPI: `/healthz` answers 2xx. */
export function probeCliproxy(options?: ProbeOptions): Promise<Observation> {
  return runProbe({origin: CLIPROXY_ORIGIN, path: '/healthz', unreachableReason: 'network-error'}, options)
}

/** Broker: `/healthz` answers 2xx. */
export function probeBroker(options?: ProbeOptions): Promise<Observation> {
  return runProbe({origin: BROKER_ORIGIN, path: '/healthz', unreachableReason: 'network-error'}, options)
}

/** Umami: `/api/heartbeat` answers 2xx with `{ok: true}`. */
export function probeUmami(options?: ProbeOptions): Promise<Observation> {
  return runProbe(
    {origin: UMAMI_ORIGIN, path: '/api/heartbeat', checkBody: checkUmamiHeartbeat, unreachableReason: 'network-error'},
    options,
  )
}

/** Dashboard: `/api/healthz` answers 2xx. */
export function probeDashboard(options?: ProbeOptions): Promise<Observation> {
  return runProbe({origin: DASHBOARD_ORIGIN, path: '/api/healthz', unreachableReason: 'network-error'}, options)
}

/** Traces: `/healthz` answers 200 with `{ok: true}`. Unauthenticated; the reporter's cached verdict, never a probe. */
export function probeTraces(options?: ProbeOptions): Promise<Observation> {
  return runProbe(
    {origin: TRACES_ORIGIN, path: '/healthz', checkBody: checkTracesHealth, unreachableReason: 'network-error'},
    options,
  )
}

/**
 * Gateway, observed through the dashboard's same-origin operator route (the gateway has no public listener of
 * its own): 200 with a non-empty string `contractVersion`. If the dashboard cannot be reached the gateway's
 * state is not observable, so the result is `unknown` with reason `dependency-unreachable`, not `fail`.
 */
export function probeGateway(options?: ProbeOptions): Promise<Observation> {
  return runProbe(
    {
      origin: DASHBOARD_ORIGIN,
      path: '/operator/health',
      checkBody: checkOperatorHealth,
      unreachableReason: 'dependency-unreachable',
    },
    options,
  )
}

// ─── VPN: a TCP connect to the SSH port ───────────────────────────────────────

/** The box serves nothing over HTTPS, so its probe is a TCP connect to the SSH port. */
export const VPN_PROBE_PORT = 22
export const VPN_PROBE_TIMEOUT_MS = 5000
const VPN_PROBE_RETRIES = 1

const VPN_REACHABILITY = {id: PUBLIC_REACHABILITY_ID, kind: 'reachability', source: 'tcp'} as const

/**
 * Where the VPN probe's address comes from. Only `VPN_PROBE_HOST` (a repository secret read by the snapshot step
 * and nothing else) when `fallbackToVpnHost` is false. On an operator workstation `status` also accepts
 * `VPN_HOST`, which the SSH check already reads there. The address goes to the probe and nowhere else.
 */
export function vpnProbeHost(
  env: Record<string, string | undefined>,
  options: {fallbackToVpnHost: boolean},
): string | undefined {
  const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim() ?? ''
    return trimmed === '' ? undefined : trimmed
  }

  return clean(env.VPN_PROBE_HOST) ?? (options.fallbackToVpnHost ? clean(env.VPN_HOST) : undefined)
}

/**
 * VPN box: a TCP connect to port 22, accepted and closed at once. Nothing is sent or read.
 * - no address configured → `not_measured` / `missing-config`, never a failure: the public page must not turn red
 *   before the secret exists
 * - an address outside the host allowlist → `unknown` / `invalid-config`; the value is never echoed
 * - accepted → `pass`
 * - timeout, refusal, ICMP unreachable → `fail` (the box, or the path to it, is down)
 * - DNS failure, any other error → `unknown` (the check could not decide)
 *
 * The reason is one of a fixed set, so neither the address nor error text can reach an observation.
 */
export async function probeVpn(options: ProbeOptions = {}): Promise<Observation> {
  const parsed = parseProbeHost(options.host)
  if (parsed.kind === 'missing') return notMeasured(VPN_REACHABILITY, 'missing-config')

  const make = (result: 'pass' | 'fail' | 'unknown', detail: ObservationDetail): Observation => ({
    ...VPN_REACHABILITY,
    result,
    observedAt: (options.now?.() ?? new Date()).toISOString(),
    detail,
  })
  if (parsed.kind === 'invalid') return make('unknown', {reason: 'invalid-config'})

  const outcome = await tcpReach(parsed.host, VPN_PROBE_PORT, {
    timeoutMs: options.timeoutMs ?? VPN_PROBE_TIMEOUT_MS,
    retries: VPN_PROBE_RETRIES,
    connect: options.connect ?? netConnect,
  })
  if (outcome.ok) return make('pass', {durationMs: outcome.durationMs})

  const down = outcome.reason === 'timeout' || outcome.reason === 'refused' || outcome.reason === 'unreachable'
  return make(down ? 'fail' : 'unknown', {reason: outcome.reason, durationMs: outcome.durationMs})
}

/** The public probe for each app that has one. */
export const PUBLIC_PROBES = {
  keeweb: probeKeeweb,
  cliproxy: probeCliproxy,
  gateway: probeGateway,
  umami: probeUmami,
  dashboard: probeDashboard,
  broker: probeBroker,
  traces: probeTraces,
  vpn: probeVpn,
} as const satisfies Partial<Record<AppId, (options?: ProbeOptions) => Promise<Observation>>>
