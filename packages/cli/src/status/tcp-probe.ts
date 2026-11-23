import {createConnection} from 'node:net'

/**
 * A plain TCP connect, for a host that serves nothing over HTTPS (the VPN box).
 *
 * Success means the connection was accepted and then closed at once: nothing is sent and nothing is read, so
 * there is no SSH handshake and no banner. A failure is one of five fixed reason codes.
 *
 * The host is sensitive (for the VPN it is the `VPN_HOST` address). Nothing in this module copies it, or any
 * error text that could contain it, into a result: an outcome is a closed shape of booleans, a code and a time.
 */

export type TcpFailureReason = 'timeout' | 'refused' | 'unreachable' | 'dns' | 'error'

export interface TcpTarget {
  host: string
  port: number
}

/**
 * Resolves once the connection is accepted, after closing it. Rejects with the socket error otherwise. It must
 * stop what it started when `signal` aborts; the caller also stops waiting at that point.
 */
export type TcpConnect = (target: TcpTarget, signal: AbortSignal) => Promise<void>

export type TcpOutcome = {ok: true; durationMs: number} | {ok: false; reason: TcpFailureReason; durationMs: number}

export type ProbeHost = {kind: 'missing'} | {kind: 'invalid'} | {kind: 'valid'; host: string}

// The allowlist idea of `apps/vpn/src/host.ts` (`VALID_HOST_RE`): hostnames and IPv4 only, never a leading `-`,
// no port, no scheme, no path, no user. `packages/` cannot import `apps/`, so the pattern is restated here.
const VALID_HOST_RE = /^[a-z\d][a-z\d.-]*$/i
const MAX_HOST_LENGTH = 253

/** A missing or blank value is `missing`; a value outside the allowlist is `invalid`. The value is never echoed. */
export function parseProbeHost(value: string | undefined): ProbeHost {
  const host = value?.trim() ?? ''
  if (host === '') return {kind: 'missing'}
  if (host.length > MAX_HOST_LENGTH || !VALID_HOST_RE.test(host)) return {kind: 'invalid'}
  return {kind: 'valid', host}
}

const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN'])
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL', 'EAI_NONAME'])

/** Reads only the error's `code`, never its message: the message of a connect error contains the address. */
export function classifyConnectError(error: unknown): TcpFailureReason {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (typeof code !== 'string') return 'error'
  if (code === 'ETIMEDOUT') return 'timeout'
  if (code === 'ECONNREFUSED') return 'refused'
  if (UNREACHABLE_CODES.has(code)) return 'unreachable'
  if (DNS_CODES.has(code)) return 'dns'
  return 'error'
}

export interface TcpReachOptions {
  timeoutMs: number
  /** Extra attempts after a failure other than a refusal (the host answered, so it is never retried). Default 0. */
  retries?: number
  connect: TcpConnect
}

async function attempt(target: TcpTarget, timeoutMs: number, connect: TcpConnect): Promise<TcpOutcome> {
  const startedAt = performance.now()
  const controller = new AbortController()
  const timedOut = new Promise<'timeout'>(resolve => {
    controller.signal.addEventListener('abort', () => resolve('timeout'), {once: true})
  })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt))

  try {
    const connected = connect(target, controller.signal).then(() => 'connected' as const)
    // If the timeout wins, a later rejection of `connected` has no reader.
    connected.catch(() => undefined)
    const winner = await Promise.race([connected, timedOut])
    return winner === 'connected'
      ? {ok: true, durationMs: elapsed()}
      : {ok: false, reason: 'timeout', durationMs: elapsed()}
  } catch (error) {
    return {
      ok: false,
      reason: controller.signal.aborted ? 'timeout' : classifyConnectError(error),
      durationMs: elapsed(),
    }
  } finally {
    clearTimeout(timer)
    // Stops a connector that is still working once the race is over.
    controller.abort()
  }
}

/** Connect to `host:port`, retrying as `options.retries` allows. The duration is that of the final attempt. */
export async function tcpReach(host: string, port: number, options: TcpReachOptions): Promise<TcpOutcome> {
  const retries = options.retries ?? 0
  let outcome: TcpOutcome = {ok: false, reason: 'error', durationMs: 0}

  for (let tries = 0; tries <= retries; tries++) {
    outcome = await attempt({host, port}, options.timeoutMs, options.connect)
    if (outcome.ok || outcome.reason === 'refused') return outcome
  }

  return outcome
}

/** The part of a socket the default connector uses. It has no write or read: this connector sends nothing. */
export interface ProbeSocket {
  once: (event: 'connect' | 'error', listener: (error?: Error) => void) => unknown
  destroy: () => unknown
}

/** The default connector on `node:net`. `createSocket` is injectable so tests never open a real socket. */
export function createNetConnect(createSocket: (target: TcpTarget) => ProbeSocket = createConnection): TcpConnect {
  return (target, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }

      const socket = createSocket({host: target.host, port: target.port})
      const onAbort = (): void => {
        socket.destroy()
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, {once: true})

      socket.once('connect', () => {
        signal.removeEventListener('abort', onAbort)
        socket.destroy()
        resolve()
      })
      socket.once('error', error => {
        signal.removeEventListener('abort', onAbort)
        socket.destroy()
        reject(error)
      })
    })
}

export const netConnect: TcpConnect = createNetConnect()
