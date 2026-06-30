/**
 * Broker HTTP service.
 *
 * Exposes two routes:
 *   GET  /healthz    — liveness probe, no auth, serves even during startup.
 *   POST /v1/mint    — OIDC-authenticated mint endpoint.
 *
 * All collaborators are injected via `deps` so the handler is testable
 * without port binding, real OIDC, or real cliproxy.
 *
 * Security invariants:
 * - NEVER log or return the OIDC bearer, the minted key, or the management key.
 * - Authorization header values are always redacted before any logging.
 * - Error responses carry only a generic message — no claim bytes, no token
 *   fragments, no stack traces.
 * - /v1/mint returns 503 until the startup reconcile completes (isReady()).
 */

import type {AuditEvent, AuditLoggerDeps} from './audit'
import type {LiveEntry} from './live-set'
import type {OidcClaims, VerifyResult} from './oidc'
import type {EvaluateResult} from './policy'
import {auditDeny, auditDenyRateLimit, auditError, auditMint} from './audit'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal fetch-style handler: Request → Promise<Response>. */
export type FetchHandler = (req: Request) => Promise<Response>

/** Rate-limit check result. */
export interface RateLimitResult {
  allowed: boolean
  reason?: string
}

/** Injectable rate limiter. */
export interface RateLimiter {
  check: (repositoryId: string) => RateLimitResult
}

/** Injectable dependencies for the server. */
export interface ServerDeps {
  /** Verifies an OIDC JWT. Injected so tests need no network. */
  verifyOidcToken: (token: string) => Promise<VerifyResult>
  /** Evaluates verified claims against the trust policy. */
  evaluateClaims: (claims: Record<string, string | undefined>) => EvaluateResult
  /** Mints a cliproxy key for the given run ID. */
  mintKey: (runId: string) => Promise<string>
  /** Records a minted entry in the live set. */
  recordMint: (entry: LiveEntry) => void
  /** Returns true when the startup reconcile has completed. */
  isReady: () => boolean
  /** Per-repo and global rate limiter. */
  rateLimiter: RateLimiter
  /** Structured audit logger. */
  auditLogger: AuditLoggerDeps
  /** Clock function returning current time in ms (injectable for tests). */
  clock: () => number
  /**
   * Test-only: captured audit events for assertion.
   * Ignored by the handler; present only so test helpers can pass it
   * alongside the auditLogger without a separate out-of-band channel.
   */
  _auditEvents?: AuditEvent[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL for minted keys in milliseconds (30 minutes). */
const DEFAULT_KEY_TTL_MS = 30 * 60 * 1000

/** Source IP header set by Caddy. */
const FORWARDED_FOR_HEADER = 'x-forwarded-for'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the bearer token from an Authorization header.
 * Returns null if the header is missing or not a Bearer token.
 * Never logs the token value.
 */
function extractBearer(req: Request): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return null
  if (!authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

/**
 * Extracts the source IP from the request.
 * Reads X-Forwarded-For (set by Caddy) or falls back to a placeholder.
 */
function extractSrcIp(req: Request): string {
  const forwarded = req.headers.get(FORWARDED_FOR_HEADER)
  if (forwarded) {
    // X-Forwarded-For may be a comma-separated list; take the first entry.
    return forwarded.split(',')[0]?.trim() ?? 'unknown'
  }
  return 'unknown'
}

/**
 * Builds a JSON response with the given status and body.
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

/**
 * Builds the OpenCode auth.json payload carrying the minted key.
 *
 * Shape per apps/cliproxy/AGENTS.md "OPENCODE_CONFIG AND OPENCODE_AUTH_JSON SHAPES":
 *   {
 *     "anthropic": {"type": "api", "key": "<minted-key>"},
 *     "openai":    {"type": "api", "key": "<minted-key>"}
 *   }
 *
 * The same proxy key authenticates both anthropic and openai provider routes.
 */
function buildAuthJson(mintedKey: string): Record<string, {type: string; key: string}> {
  return {
    anthropic: {type: 'api', key: mintedKey},
    openai: {type: 'api', key: mintedKey},
  }
}

/**
 * Casts OidcClaims to the string-map shape expected by evaluateClaims.
 * Only string-valued fields are passed; numeric/array fields are omitted.
 */
function claimsToStringMap(claims: OidcClaims): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(claims)) {
    if (typeof v === 'string') {
      result[k] = v
    } else if (typeof v === 'number') {
      result[k] = String(v)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /healthz — liveness probe. No auth. Serves during startup. */
function handleHealthz(): Response {
  return jsonResponse(200, {status: 'ok'})
}

/** POST /v1/mint — OIDC-authenticated mint endpoint. */
async function handleMint(req: Request, deps: ServerDeps): Promise<Response> {
  const {verifyOidcToken, evaluateClaims, mintKey, recordMint, isReady, rateLimiter, auditLogger, clock} = deps

  const now = clock()
  const ts = new Date(now).toISOString()
  const srcIp = extractSrcIp(req)

  // 1. Startup gate — 503 until reconcile completes.
  if (!isReady()) {
    return jsonResponse(503, {error: 'service starting up — try again shortly'})
  }

  // 2. Extract bearer token. Never log the token value.
  const token = extractBearer(req)
  if (!token) {
    auditDeny({ts, srcIp, reason: 'missing or malformed Authorization header'}, auditLogger)
    return jsonResponse(401, {error: 'missing or malformed Authorization header'})
  }

  // 3. Verify OIDC token. On failure, log only the reason (no token bytes).
  const verifyResult = await verifyOidcToken(token)
  if (!verifyResult.ok) {
    auditDeny({ts, srcIp, reason: verifyResult.reason}, auditLogger)
    return jsonResponse(401, {error: 'OIDC token verification failed'})
  }

  const {claims} = verifyResult
  const jti = claims.jti
  const repositoryId = claims.repository_id
  const workflowRef = claims.workflow_ref
  // run_id is a GitHub Actions claim not in the base OidcClaims type; access via index.
  const runId = (claims as Record<string, unknown>).run_id as string | undefined

  // 4. Rate-limit check (per-repo and global). Check after verify so we have repositoryId.
  const repoIdForLimit = repositoryId ?? 'unknown'
  const limitResult = rateLimiter.check(repoIdForLimit)
  if (!limitResult.allowed) {
    auditDenyRateLimit(
      {ts, srcIp, jti, repositoryId, workflowRef, reason: limitResult.reason ?? 'rate limit exceeded'},
      auditLogger,
    )
    return jsonResponse(429, {error: 'rate limit exceeded'})
  }

  // 5. Evaluate claims against trust policy.
  const claimsMap = claimsToStringMap(claims)
  const evalResult = evaluateClaims(claimsMap)
  if (!evalResult.ok) {
    auditDeny({ts, srcIp, jti, repositoryId, workflowRef, reason: evalResult.reason}, auditLogger)
    return jsonResponse(403, {error: 'claims do not satisfy trust policy'})
  }

  // 6. Mint the key. On failure, return a generic 5xx with no secret bytes.
  let mintedKey: string
  try {
    mintedKey = await mintKey(runId ?? 'unknown')
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'mint failed'
    auditError({ts, srcIp, jti, repositoryId, workflowRef, reason}, auditLogger)
    // Generic body — no token bytes, no claim values, no key fragments.
    return jsonResponse(500, {error: 'internal error — mint failed'})
  }

  // 7. Record in live set. expiresAt is now + DEFAULT_KEY_TTL_MS.
  recordMint({
    key: mintedKey,
    runId: runId ?? 'unknown',
    jti: jti ?? 'unknown',
    expiresAt: now + DEFAULT_KEY_TTL_MS,
  })

  // 8. Audit the successful mint. Never log the minted key value.
  auditMint({ts, srcIp, jti, repositoryId, workflowRef, runId}, auditLogger)

  // 9. Return the auth.json payload.
  return jsonResponse(200, buildAuthJson(mintedKey))
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Creates a fetch-style handler for the broker HTTP service.
 *
 * Returns a function `(req: Request) => Promise<Response>` that can be
 * passed directly to `Bun.serve` or called in tests without port binding.
 *
 * All collaborators are injected via `deps` — no global state, no network
 * calls, no real OIDC in tests.
 */
export function createServer(deps: ServerDeps): FetchHandler {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return handleHealthz()
    }

    if (req.method === 'POST' && url.pathname === '/v1/mint') {
      return handleMint(req, deps)
    }

    return jsonResponse(404, {error: 'not found'})
  }
}

// ---------------------------------------------------------------------------
// Production entry point
// ---------------------------------------------------------------------------

/**
 * Starts the broker HTTP service on the given port.
 *
 * Binds only on the internal docker-network interface; Caddy terminates TLS.
 * All collaborators must be provided — this function does not supply defaults.
 */
export function serve(port: number, deps: ServerDeps): ReturnType<typeof Bun.serve> {
  const handler = createServer(deps)
  return Bun.serve({
    port,
    fetch: handler,
  })
}
