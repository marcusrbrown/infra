import type {JWTPayload, JWTVerifyOptions, KeyLike} from 'jose'
/**
 * OIDC JWT verification for GitHub Actions tokens.
 *
 * Uses `jose` for cryptographic verification against the GitHub Actions JWKS
 * endpoint. The JWKS is cached at module level with a bounded refresh rate to
 * avoid hammering the endpoint on unknown-kid errors.
 *
 * The replay denylist is keyed by `${iss}|${jti}` and evicts entries past
 * their token expiry + leeway. This prevents a valid token from being
 * presented twice within its validity window.
 */
import {createRemoteJWKSet, jwtVerify} from 'jose'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OidcClaims = JWTPayload & {
  repository?: string
  repository_id?: string
  repository_owner_id?: string
  workflow_ref?: string
  ref?: string
  ref_type?: string
  ref_protected?: string
  event_name?: string
  runner_environment?: string
  repository_visibility?: string
}

export type VerifyResult = {ok: true; claims: OidcClaims} | {ok: false; reason: string}

// ---------------------------------------------------------------------------
// JWKS — module-level cached remote set (production path)
// ---------------------------------------------------------------------------

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const GITHUB_JWKS_URL = new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`)

/**
 * Module-level JWKS for the production GitHub Actions OIDC endpoint.
 *
 * cacheMaxAge: 10 minutes — keys rotate infrequently; 10 min is safe.
 * cooldownDuration: 5 minutes — rate-limits unknown-kid refresh to ≥5 min
 * so a burst of tokens with an unknown kid cannot hammer the endpoint.
 */
const REMOTE_JWKS = createRemoteJWKSet(GITHUB_JWKS_URL, {
  cacheMaxAge: 10 * 60 * 1000, // 10 minutes in ms
  cooldownDuration: 5 * 60 * 1000, // 5 minutes in ms
})

// ---------------------------------------------------------------------------
// Replay denylist
// ---------------------------------------------------------------------------

/** Leeway added to exp before evicting a denylist entry (seconds). */
const REPLAY_EVICTION_LEEWAY_S = 60

/**
 * In-memory replay denylist.
 * Key: `${iss}|${jti}` — using both fields prevents cross-issuer collisions.
 * Value: expiry epoch (seconds) after which the entry is evicted.
 */
const replayDenylist = new Map<string, number>()

/**
 * Asserts that the given (jti, iss) pair has not been seen before within the
 * token's validity window. Throws on replay. Evicts expired entries.
 *
 * @param jti - JWT ID claim
 * @param iss - Issuer claim
 * @param exp - Expiry epoch (seconds since Unix epoch)
 */
export function assertNotReplayed(jti: string, iss: string, exp: number): void {
  const key = `${iss}|${jti}`
  const now = Math.floor(Date.now() / 1000)

  // Evict all entries that are past exp + leeway
  for (const [k, evictAt] of replayDenylist) {
    if (now > evictAt) {
      replayDenylist.delete(k)
    }
  }

  if (replayDenylist.has(key)) {
    throw new Error(`replay detected: jti=${jti} iss=${iss}`)
  }

  replayDenylist.set(key, exp + REPLAY_EVICTION_LEEWAY_S)
}

/**
 * Clears the replay denylist. Exposed for test isolation only.
 */
export function clearReplayDenylist(): void {
  replayDenylist.clear()
}

// ---------------------------------------------------------------------------
// JWKS function type
// ---------------------------------------------------------------------------

/**
 * A function that resolves a public key from a protected header.
 * Matches the signature expected by jose's jwtVerify.
 */
type JwksFunction = (
  protectedHeader: {kid?: string; alg?: string},
  token?: {payload: Uint8Array; signature: Uint8Array},
) => Promise<KeyLike | Uint8Array> | KeyLike | Uint8Array

// ---------------------------------------------------------------------------
// Verification options
// ---------------------------------------------------------------------------

export interface VerifyOidcTokenOptions {
  /** Expected audience — the broker-minted aud value. Not a secret. */
  audience: string
  /**
   * JWKS resolver. Defaults to the module-level cached remote JWKS.
   * Override in tests to avoid network calls.
   */
  jwks?: JwksFunction
  /**
   * Clock tolerance in seconds. Defaults to 30.
   * Pass 0 in tests that check exp/nbf boundary conditions.
   */
  clockTolerance?: number
}

// ---------------------------------------------------------------------------
// Main verification function
// ---------------------------------------------------------------------------

/**
 * Verifies a GitHub Actions OIDC JWT.
 *
 * Performs:
 * 1. Cryptographic signature verification (RS256 only, against JWKS).
 * 2. Standard JWT claims: iss, aud, exp, nbf, iat.
 * 3. Algorithm allowlist enforcement (RS256 only — rejects none, HS256, etc.).
 * 4. Replay denylist check on (jti, iss).
 *
 * Returns {ok: true, claims} on success or {ok: false, reason} on any failure.
 * Never throws — all errors are captured into the failure result.
 *
 * The expected audience is a config input (the broker-minted aud value).
 * It is not a secret — it is a cross-context replay defense that stops a
 * different relying party's token from being accepted here.
 */
export async function verifyOidcToken(token: string, opts: VerifyOidcTokenOptions): Promise<VerifyResult> {
  const {audience, jwks = REMOTE_JWKS, clockTolerance = 30} = opts

  const verifyOptions: JWTVerifyOptions = {
    issuer: GITHUB_OIDC_ISSUER,
    audience,
    algorithms: ['RS256'],
    clockTolerance,
  }

  let payload: OidcClaims
  try {
    const result = await jwtVerify(token, jwks as Parameters<typeof jwtVerify>[1], verifyOptions)
    payload = result.payload as OidcClaims
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {ok: false, reason: `JWT verification failed: ${message}`}
  }

  // Replay check — requires jti and iss
  const jti = payload.jti
  const iss = payload.iss
  const exp = payload.exp

  if (!jti) {
    return {ok: false, reason: 'missing jti claim — replay protection requires jti'}
  }
  if (!iss) {
    return {ok: false, reason: 'missing iss claim'}
  }
  if (exp === undefined) {
    return {ok: false, reason: 'missing exp claim'}
  }

  try {
    assertNotReplayed(jti, iss, exp)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {ok: false, reason: message}
  }

  return {ok: true, claims: payload}
}
