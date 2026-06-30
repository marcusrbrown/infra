/**
 * In-memory live set — the seam between the mint endpoint (Unit 3) and the
 * sweeper (Unit 4).
 *
 * Tracks every key the broker has minted but not yet revoked. The sweeper
 * reads this set to find entries past their TTL and to reconcile against
 * cliproxy's api-keys list on startup.
 *
 * Design constraints:
 * - Dependency-light: no I/O, no external imports.
 * - Unit-testable: all state is module-level but reset-able via
 *   `resetLiveSetForTest` (test-only export).
 * - Snapshot semantics: `listLive()` returns a copy so callers cannot
 *   corrupt internal state by mutating the returned array.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single live entry representing a minted-but-not-yet-revoked key. */
export interface LiveEntry {
  /** The minted cliproxy key (e.g. `ghact-<runId>-<rand>`). */
  key: string
  /** The GitHub Actions run ID that requested this key. */
  runId: string
  /** The JWT ID of the OIDC token that authorized this mint. */
  jti: string
  /** Unix epoch milliseconds after which the key should be swept. */
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** The live set: key → entry. */
let liveSet = new Map<string, LiveEntry>()

/** Whether the startup reconcile has completed. */
let readyFlag = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records a newly minted key in the live set.
 * Overwrites any existing entry for the same key (idempotent on retry).
 */
export function recordMint(entry: LiveEntry): void {
  liveSet.set(entry.key, entry)
}

/**
 * Returns a snapshot of all live entries.
 * Mutating the returned array does not affect internal state.
 */
export function listLive(): LiveEntry[] {
  return [...liveSet.values()]
}

/**
 * Removes a key from the live set (called after revocation).
 * No-op if the key is not present.
 */
export function removeKey(key: string): void {
  liveSet.delete(key)
}

/**
 * Marks the startup reconcile as complete.
 * After this call, `isReady()` returns true and `/v1/mint` begins serving.
 */
export function markReady(): void {
  readyFlag = true
}

/**
 * Returns true if the startup reconcile has completed.
 * The HTTP service gates `/v1/mint` on this flag (returns 503 until ready).
 */
export function isReady(): boolean {
  return readyFlag
}

// ---------------------------------------------------------------------------
// Test-only export
// ---------------------------------------------------------------------------

/**
 * Resets all module-level state. For test isolation only.
 * Never call this in production code.
 */
export function resetLiveSetForTest(): void {
  liveSet = new Map()
  readyFlag = false
}
