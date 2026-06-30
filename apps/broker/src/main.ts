/**
 * Broker service entry point.
 *
 * Wires together:
 *   1. startupReconcile — clears stale ghact- keys from cliproxy before serving /v1/mint.
 *   2. startSweeper — periodic TTL backstop + reconcile sweep.
 *   3. serve — Bun.serve on the configured port.
 *
 * Startup order is mandatory:
 *   startupReconcile → markReady → serve /v1/mint
 *
 * /healthz serves immediately (before reconcile completes).
 * /v1/mint returns 503 until startupReconcile calls markReady().
 */

import {defaultAuditLogger} from './audit'
import {isReady, listLive, markReady, recordMint, removeKey} from './live-set'
import {listApiKeys, mintKey, revokeKey} from './mint'
import {verifyOidcToken} from './oidc'
import {BROKER_TRUST_POLICY, evaluateClaims} from './policy'
import {createRateLimiter} from './rate-limit'
import {serve} from './server'
import {startSweeper, startupReconcile} from './sweeper'

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const _rawPort = Number(process.env.BROKER_PORT ?? '3000')
const PORT = Number.isInteger(_rawPort) && _rawPort > 0 ? _rawPort : 3000
const MANAGEMENT_URL = process.env.CLIPROXY_MANAGEMENT_URL ?? 'https://cliproxy.fro.bot'
const MANAGEMENT_KEY = process.env.CLIPROXY_MANAGEMENT_KEY ?? ''
const BROKER_AUD = process.env.BROKER_AUD ?? ''

if (!MANAGEMENT_KEY) {
  console.error('CLIPROXY_MANAGEMENT_KEY is required')
  process.exit(1)
}

if (!BROKER_AUD) {
  console.error('BROKER_AUD is required')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Shared mint deps
// ---------------------------------------------------------------------------

const mintDeps = {
  managementUrl: MANAGEMENT_URL,
  managementKey: MANAGEMENT_KEY,
}

// ---------------------------------------------------------------------------
// Sweeper deps
// ---------------------------------------------------------------------------

const sweeperDeps = {
  revokeKey,
  listApiKeys,
  listLive,
  removeKey,
  markReady,
  mintDeps,
  auditLogger: defaultAuditLogger,
}

// ---------------------------------------------------------------------------
// Server deps
// ---------------------------------------------------------------------------

// Token bucket rate limiter: 10 mints per repo per minute, 50 global per minute.
// Sized above realistic max-parallel-CI but bounding abuse/DoS.
const rateLimiter = createRateLimiter()

const serverDeps = {
  verifyOidcToken: (token: string) => verifyOidcToken(token, {audience: BROKER_AUD}),
  evaluateClaims: (claims: Record<string, string | undefined>) => evaluateClaims(claims, BROKER_TRUST_POLICY),
  mintKey: (runId: string) => mintKey(runId, mintDeps),
  recordMint,
  isReady,
  rateLimiter,
  auditLogger: defaultAuditLogger,
  clock: Date.now,
}

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

console.warn(`[broker] Starting up on port ${PORT}`)

// 1. Run startup reconcile (clears stale ghact- keys) before serving /v1/mint.
//    markReady() is called inside startupReconcile after reconcile completes.
await startupReconcile(sweeperDeps)

// 2. Start periodic sweeper (TTL backstop + reconcile).
const stopSweeper = startSweeper(sweeperDeps)

// 3. Start the HTTP service.
const server = serve(PORT, serverDeps)

console.warn(`[broker] Serving on port ${PORT}`)

// Graceful shutdown
process.on('SIGTERM', () => {
  console.warn('[broker] SIGTERM received — shutting down')
  stopSweeper()
  server.stop()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.warn('[broker] SIGINT received — shutting down')
  stopSweeper()
  server.stop()
  process.exit(0)
})
