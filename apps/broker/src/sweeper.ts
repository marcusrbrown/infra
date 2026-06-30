/**
 * Sweeper — TTL backstop + reconcile sweep.
 *
 * Guarantees minted keys are revoked even when a run crashes or cancels
 * without signalling. Two mechanisms:
 *
 * 1. `sweepExpired(now, deps)` — for each live entry with expiresAt <= now,
 *    revokes the key and removes it from the live set. This is the mandatory
 *    TTL backstop, independent of any run-end callback.
 *
 * 2. `reconcile(deps)` — lists cliproxy's current api-keys; for every key
 *    that starts with KEY_PREFIX (`ghact-`) AND is NOT in the current live
 *    set, revokes it. Recovers from a broker restart where the in-memory live
 *    set is empty but stale broker-owned keys remain in cliproxy.
 *
 *    SAFETY INVARIANT: reconcile NEVER deletes a non-`ghact-` key. The prefix
 *    guard is explicit and tested hard.
 *
 * 3. `startupReconcile(deps)` — runs reconcile once, then calls markReady().
 *    Order is mandatory: reconcile BEFORE markReady so /v1/mint cannot serve
 *    before stale keys are cleared.
 *
 * 4. `startSweeper(deps, opts)` — schedules periodic sweepExpired and
 *    reconcile via injectable timer. Returns a stop handle.
 *
 * All collaborators are injected via deps/opts so tests need no network and
 * no real timers.
 */

import type {AuditLoggerDeps} from './audit'
import type {LiveEntry} from './live-set'
import type {MintDeps} from './mint'

import {auditRevoke} from './audit'
import {KEY_PREFIX} from './mint'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Signature of revokeKey from mint.ts (injectable for tests). */
export type RevokeKeyFn = (key: string, deps: MintDeps) => Promise<void>

/** Signature of listApiKeys from mint.ts (injectable for tests). */
export type ListApiKeysFn = (deps: MintDeps) => Promise<string[]>

/** Minimal logger interface for sweeper error reporting. */
export interface SweeperLogger {
  error: (msg: string) => void
}

/** Injectable dependencies for the sweeper. */
export interface SweeperDeps {
  /** Revoke a cliproxy key. Injected from mint.ts. */
  revokeKey: RevokeKeyFn
  /** List all current cliproxy api-keys. Injected from mint.ts. */
  listApiKeys: ListApiKeysFn
  /** List all live (minted, not yet revoked) entries. Injected from live-set.ts. */
  listLive: () => LiveEntry[]
  /** Remove a key from the live set. Injected from live-set.ts. */
  removeKey: (key: string) => void
  /** Mark the startup reconcile as complete. Injected from live-set.ts. */
  markReady: () => void
  /** MintDeps forwarded to revokeKey and listApiKeys. */
  mintDeps: MintDeps
  /** Logger for error reporting. Defaults to console when omitted. */
  logger?: SweeperLogger
  /** Audit logger for revoke events. When omitted, revoke events are not audited. */
  auditLogger?: AuditLoggerDeps
}

/** Injectable options for startSweeper. */
export interface SweeperOpts {
  /** How often to run sweepExpired (ms). Default: 60_000. */
  sweepIntervalMs?: number
  /** How often to run reconcile (ms). Default: 300_000. */
  reconcileIntervalMs?: number
  /** Injectable setInterval (default: globalThis.setInterval). */
  setInterval?: typeof globalThis.setInterval
  /** Injectable clearInterval (default: globalThis.clearInterval). */
  clearInterval?: typeof globalThis.clearInterval
  /** Injectable clock returning current epoch ms (default: Date.now). */
  clock?: () => number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SWEEP_INTERVAL_MS = 60_000
const DEFAULT_RECONCILE_INTERVAL_MS = 300_000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sweep all live entries whose expiresAt <= now.
 *
 * For each expired entry: revokes the key via cliproxy management API, then
 * removes it from the live set. This is the mandatory TTL backstop —
 * independent of any run-end callback.
 *
 * Errors from individual revocations are logged and do not abort the sweep
 * of remaining entries (TTL is the floor; a single failure must not block
 * other sweeps).
 */
export async function sweepExpired(now: number, deps: SweeperDeps): Promise<void> {
  const {revokeKey, removeKey, listLive, mintDeps, logger = console, auditLogger} = deps
  const entries = listLive()
  const ts = new Date(now).toISOString()

  for (const entry of entries) {
    if (entry.expiresAt <= now) {
      try {
        await revokeKey(entry.key, mintDeps)
        // Only remove from live set on successful revoke so the next tick retries.
        removeKey(entry.key)
        // Emit revoke audit event — never log the key value, only run identity.
        if (auditLogger) {
          auditRevoke({ts, srcIp: 'sweeper', runId: entry.runId, jti: entry.jti, reason: 'ttl-expired'}, auditLogger)
        }
      } catch (error) {
        // Log the failure but leave the entry in the live set so the next tick retries.
        // TTL is the mandatory backstop; a single revoke failure must not
        // block the rest of the sweep.
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`[sweeper] sweepExpired: revokeKey failed for key prefix ${entry.key.slice(0, 12)}…: ${message}`)
      }
    }
  }
}

/**
 * Reconcile cliproxy's api-keys list against the in-memory live set.
 *
 * Lists all current cliproxy api-keys. For every key that:
 *   - starts with the broker prefix (`ghact-`), AND
 *   - is NOT present in the current live set
 * → revokes it.
 *
 * This recovers from a broker restart where the in-memory live set is empty
 * but stale broker-owned keys remain in cliproxy.
 *
 * SAFETY INVARIANT: only keys starting with `ghact-` are ever revoked.
 * Non-broker keys (durable key, other consumers' keys) are NEVER touched.
 * This guard is explicit and tested.
 */
export async function reconcile(deps: SweeperDeps): Promise<void> {
  const {revokeKey, listApiKeys, listLive, mintDeps, logger = console} = deps

  let allKeys: string[]
  try {
    allKeys = await listApiKeys(mintDeps)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[sweeper] reconcile: listApiKeys failed — skipping this tick: ${message}`)
    return
  }

  const liveEntries = listLive()

  // Build a set of keys currently in the live set for O(1) lookup.
  const liveKeys = new Set(liveEntries.map(e => e.key))

  for (const key of allKeys) {
    // SAFETY: only touch broker-owned keys. Never delete non-ghact- keys.
    if (!key.startsWith(KEY_PREFIX)) {
      continue
    }

    // Key is broker-owned but not in the live set → stale, revoke it.
    if (!liveKeys.has(key)) {
      try {
        await revokeKey(key, mintDeps)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`[sweeper] reconcile: revokeKey failed for key prefix ${key.slice(0, 12)}…: ${message}`)
      }
    }
  }
}

/** Maximum attempts for the startup reconcile before proceeding. */
const STARTUP_RECONCILE_MAX_ATTEMPTS = 3

/** Backoff delays between startup reconcile attempts (ms). */
const STARTUP_RECONCILE_BACKOFF_MS = [500, 1_000] as const

/**
 * Run the startup reconcile (with bounded retry), then mark the broker as ready.
 *
 * Order is mandatory: reconcile BEFORE markReady. The HTTP service gates
 * /v1/mint on the ready flag (returns 503 until ready). This ensures stale
 * keys from a previous broker instance are cleared before any new mint is
 * accepted.
 *
 * If reconcile fails on all attempts, logs the error and proceeds to markReady
 * anyway — the TTL sweeper is the mandatory backstop, and blocking startup
 * permanently is worse than a brief stale-key window.
 */
export async function startupReconcile(deps: SweeperDeps): Promise<void> {
  const {logger = console} = deps

  for (let attempt = 0; attempt < STARTUP_RECONCILE_MAX_ATTEMPTS; attempt++) {
    try {
      await reconcile(deps)
      deps.markReady()
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const remaining = STARTUP_RECONCILE_MAX_ATTEMPTS - attempt - 1
      if (remaining > 0) {
        const delay = STARTUP_RECONCILE_BACKOFF_MS[attempt] ?? 1_000
        logger.error(
          `[sweeper] startupReconcile: attempt ${attempt + 1}/${STARTUP_RECONCILE_MAX_ATTEMPTS} failed — retrying in ${delay}ms: ${message}`,
        )
        await new Promise<void>(resolve => setTimeout(resolve, delay))
      } else {
        logger.error(
          `[sweeper] startupReconcile: all ${STARTUP_RECONCILE_MAX_ATTEMPTS} attempts failed — proceeding to ready (TTL sweeper is the backstop): ${message}`,
        )
      }
    }
  }

  deps.markReady()
}

/**
 * Schedule periodic sweepExpired and reconcile via injectable timer.
 *
 * Returns a stop handle that clears both intervals. Call stop() on shutdown
 * to prevent timer leaks.
 *
 * Defaults:
 *   sweepIntervalMs:     60_000  (1 min)
 *   reconcileIntervalMs: 300_000 (5 min)
 *   setInterval/clearInterval: globalThis
 *   clock: Date.now
 */
export function startSweeper(deps: SweeperDeps, opts: SweeperOpts = {}): () => void {
  const {
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    reconcileIntervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
    setInterval: setIntervalFn = globalThis.setInterval,
    clearInterval: clearIntervalFn = globalThis.clearInterval,
    clock = Date.now,
  } = opts

  const sweepId = setIntervalFn(async () => {
    await sweepExpired(clock(), deps)
  }, sweepIntervalMs)

  const reconcileId = setIntervalFn(async () => {
    await reconcile(deps)
  }, reconcileIntervalMs)

  return () => {
    clearIntervalFn(sweepId)
    clearIntervalFn(reconcileId)
  }
}
