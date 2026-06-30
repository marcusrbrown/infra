/**
 * cliproxy mint/revoke client.
 *
 * Adds and removes short-lived `ghact-`-prefixed keys from the cliproxy
 * management API using a single-flight lock to prevent lost-update races on
 * the shared `api-keys` array.
 *
 * Single-instance invariant: the lock is valid because there is exactly one
 * broker instance (single droplet, no horizontal scaling). If the broker is
 * ever scaled out, this in-process lock is insufficient and a distributed lock
 * or CAS-capable management API is required.
 *
 * Learnings applied:
 * - Never upload config.yaml; never replace the array wholesale.
 * - GET → append single key → PUT → GET-back and assert presence.
 * - Bounded retry ONLY on read-back mismatch; never on HTTP error.
 * - Single serialized management auth path — IP-ban after ~5 bad attempts.
 * - Never log the management key or the minted key value.
 */

import {managementHeaders, parseManagementKeyList} from '@marcusrbrown/infra-shared/cliproxy/management'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal fetch signature used by the mint/revoke client.
 * Accepts a URL and optional RequestInit; returns a Promise<Response>.
 * Using a structural type rather than `typeof globalThis.fetch` avoids
 * requiring the `preconnect` property that Bun adds to the global fetch.
 */
export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Injectable dependencies for the mint/revoke client. */
export interface MintDeps {
  /** fetch implementation — defaults to globalThis.fetch. */
  fetch?: FetchFn
  /** Base URL of the cliproxy management API (no trailing slash). */
  managementUrl: string
  /** Management API key (x-management-key header value). Never logged. */
  managementKey: string
}

// ---------------------------------------------------------------------------
// Single-flight lock
// ---------------------------------------------------------------------------

/**
 * Module-level promise chain acting as a single-flight mutex.
 *
 * All management-API mutations (mint and revoke) acquire this lock so no two
 * GET-modify-write cycles interleave against the shared `api-keys` array.
 *
 * This is valid because there is exactly one broker instance (single droplet).
 * Scaling out breaks this invariant — see module-level comment.
 */
let lockChain: Promise<unknown> = Promise.resolve()

/**
 * Acquire the single-flight lock and run `fn` exclusively.
 * Returns the result of `fn`. Releases the lock even if `fn` throws.
 */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lockChain.then(() => fn())
  // Swallow errors on the chain tail so a failed operation does not
  // permanently poison the lock for subsequent callers.
  lockChain = next.catch(() => undefined)
  return next
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum read-back attempts after a PUT (mismatch-only retry). */
const MAX_READBACK_ATTEMPTS = 3

/** Key prefix for broker-minted keys. Greppable; never trust slug identity. */
const KEY_PREFIX = 'ghact'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique broker key for the given run.
 * Format: `ghact-<runId>-<random>` — greppable prefix, random suffix for uniqueness.
 */
function generateKey(runId: string): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `${KEY_PREFIX}-${runId}-${random}`
}

/**
 * GET the current api-keys list from cliproxy.
 * Throws on any non-2xx response (fail-closed).
 * Uses parseManagementKeyList (strict) — never the permissive toStringArray.
 */
async function getApiKeys(baseUrl: string, managementKey: string, fetchFn: FetchFn): Promise<string[]> {
  const endpoint = `${baseUrl}/v0/management/api-keys`
  const response = await fetchFn(endpoint, {
    method: 'GET',
    headers: managementHeaders(managementKey),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GET /v0/management/api-keys failed with HTTP ${response.status}: ${body}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError)
    throw new Error(`GET /v0/management/api-keys returned malformed JSON: ${message}`)
  }

  return parseManagementKeyList(payload)
}

/**
 * PUT the full api-keys array back to cliproxy.
 * Throws on any non-2xx response (fail-closed).
 *
 * The body is the bare string array — NOT wrapped in {value: ...} or
 * {api-keys: ...}. Wrappers return 200 but store nothing (verified live).
 */
async function putApiKeys(baseUrl: string, managementKey: string, keys: string[], fetchFn: FetchFn): Promise<void> {
  const endpoint = `${baseUrl}/v0/management/api-keys`
  const response = await fetchFn(endpoint, {
    method: 'PUT',
    headers: managementHeaders(managementKey),
    body: JSON.stringify(keys),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`PUT /v0/management/api-keys failed with HTTP ${response.status}: ${body}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived cliproxy key for the given run.
 *
 * Generates a key with the format `ghact-<runId>-<random>`, then — holding
 * the single-flight lock — performs:
 *   1. GET /v0/management/api-keys (read current list)
 *   2. Append the new key (preserving ALL existing keys)
 *   3. PUT the full array back
 *   4. GET-back and assert the new key is present
 *
 * Step 4 retries up to MAX_READBACK_ATTEMPTS times on mismatch only (the
 * "PUT returns 200 but stores nothing" trap). HTTP errors throw immediately
 * with no retry (IP-ban avoidance).
 *
 * Returns the minted key string. Never logs the key value or the management key.
 */
export async function mintKey(runId: string, deps: MintDeps): Promise<string> {
  const {managementUrl, managementKey, fetch: fetchFn = globalThis.fetch} = deps
  const key = generateKey(runId)

  return withLock(async () => {
    // Step 1: GET current list (strict parse — throws on malformed)
    const existing = await getApiKeys(managementUrl, managementKey, fetchFn)

    // Step 2: Append the new key (preserve all existing keys)
    const updated = [...existing, key]

    // Step 3: PUT the full array back
    await putApiKeys(managementUrl, managementKey, updated, fetchFn)

    // Step 4: GET-back with bounded retry on mismatch only
    let lastError: Error | null = null
    for (let attempt = 0; attempt < MAX_READBACK_ATTEMPTS; attempt++) {
      // HTTP errors from the read-back propagate immediately (no retry)
      const readBack = await getApiKeys(managementUrl, managementKey, fetchFn)

      if (readBack.includes(key)) {
        lastError = null
        break
      }

      lastError = new Error(
        `mintKey read-back mismatch: key not present in api-keys after PUT (attempt ${attempt + 1}/${MAX_READBACK_ATTEMPTS})`,
      )
    }

    if (lastError) {
      throw lastError
    }

    return key
  })
}

/**
 * Revoke a cliproxy key by sending DELETE /v0/management/api-keys?value=<key>.
 *
 * Idempotent: a 404 (key already absent) is treated as success.
 * All other non-2xx responses throw immediately (no retry).
 *
 * Runs under the same single-flight lock as mintKey so a revoke never
 * interleaves with a concurrent mint's GET-modify-write cycle.
 *
 * Never logs the key value or the management key.
 */
export async function revokeKey(key: string, deps: MintDeps): Promise<void> {
  const {managementUrl, managementKey, fetch: fetchFn = globalThis.fetch} = deps

  return withLock(async () => {
    const endpoint = `${managementUrl}/v0/management/api-keys?value=${encodeURIComponent(key)}`
    const response = await fetchFn(endpoint, {
      method: 'DELETE',
      headers: managementHeaders(managementKey),
      signal: AbortSignal.timeout(10_000),
    })

    // 404 = key already absent — idempotent success
    if (response.status === 404) {
      return
    }

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`DELETE /v0/management/api-keys failed with HTTP ${response.status}: ${body}`)
    }
  })
}

/**
 * List the current api-keys from cliproxy.
 *
 * Exported so the sweeper can reuse the same fetch path (and benefit from the
 * single-flight lock context) without duplicating the GET logic.
 *
 * Runs under the single-flight lock so a concurrent mint's GET-modify-write
 * cycle is never interleaved with a reconcile list.
 */
export async function listApiKeys(deps: MintDeps): Promise<string[]> {
  const {managementUrl, managementKey, fetch: fetchFn = globalThis.fetch} = deps
  return withLock(() => getApiKeys(managementUrl, managementKey, fetchFn))
}

/**
 * The greppable key prefix used for all broker-minted keys.
 * Exported so the sweeper can identify broker-owned keys without trusting slug identity.
 */
export {KEY_PREFIX}
