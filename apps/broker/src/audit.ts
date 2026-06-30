/**
 * Structured audit event emitter for the broker.
 *
 * Emits one JSON line per event through an injected logger. The default
 * logger wraps `console` but is overridable for tests.
 *
 * Security invariants (enforced here, not by callers):
 * - NEVER log token bytes: the OIDC bearer, the minted key, the management
 *   key, or any raw claim payload.
 * - The `Authorization` header value is always redacted before logging.
 * - Only identity metadata and decision context appear in audit events.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata carried by every audit event. */
export interface AuditMeta {
  /** ISO-8601 timestamp. */
  ts: string
  /** Source IP of the request (from X-Forwarded-For or socket). */
  srcIp: string
  /** GitHub Actions run ID (from OIDC claims). May be undefined on early deny. */
  runId?: string
  /** JWT ID of the OIDC token. May be undefined on early deny. */
  jti?: string
  /** Numeric GitHub repository ID. May be undefined on early deny. */
  repositoryId?: string
  /** Exact workflow_ref claim value. May be undefined on early deny. */
  workflowRef?: string
  /** Audit decision: mint | deny | deny-ratelimit | revoke | error. */
  decision: 'mint' | 'deny' | 'deny-ratelimit' | 'revoke' | 'error'
  /** Human-readable reason for the decision (no token bytes). */
  reason?: string
}

/** A structured audit event as written to the log. */
export interface AuditEvent extends AuditMeta {
  type: 'broker-audit'
}

/** Injectable logger interface. Default wraps console. */
export interface AuditLoggerDeps {
  log: (event: AuditEvent) => void
}

// ---------------------------------------------------------------------------
// Default logger
// ---------------------------------------------------------------------------

/**
 * Default audit logger: writes one JSON line to stdout via console.log.
 * Injected in production; replaced in tests.
 */
export const defaultAuditLogger: AuditLoggerDeps = {
  log: (event: AuditEvent) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(event))
  },
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/**
 * Redacts the value of an Authorization header, returning a safe placeholder.
 * Accepts the raw header string (e.g. "Bearer eyJ...") and returns "[REDACTED]".
 */
export function redactAuthorizationHeader(_value: string): string {
  return '[REDACTED]'
}

/**
 * Strips any field from an object that could carry a token or secret.
 * Returns a new object with sensitive fields replaced by "[REDACTED]".
 *
 * Sensitive field names (case-insensitive): authorization, token, key,
 * secret, password, credential, bearer.
 */
export function redactSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE = /authorization|token|key|secret|password|credential|bearer/i
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    result[k] = SENSITIVE.test(k) ? '[REDACTED]' : v
  }
  return result
}

// ---------------------------------------------------------------------------
// Audit emitters
// ---------------------------------------------------------------------------

/**
 * Emits a `mint` audit event — a key was successfully minted.
 * Never includes the minted key value.
 */
export function auditMint(meta: Omit<AuditMeta, 'decision'>, logger: AuditLoggerDeps = defaultAuditLogger): void {
  logger.log({type: 'broker-audit', ...meta, decision: 'mint'})
}

/**
 * Emits a `deny` audit event — a mint request was denied (auth/policy failure).
 * Never includes the OIDC bearer or any token bytes.
 */
export function auditDeny(meta: Omit<AuditMeta, 'decision'>, logger: AuditLoggerDeps = defaultAuditLogger): void {
  logger.log({type: 'broker-audit', ...meta, decision: 'deny'})
}

/**
 * Emits a `deny-ratelimit` audit event — a mint request was denied by rate limiter.
 */
export function auditDenyRateLimit(
  meta: Omit<AuditMeta, 'decision'>,
  logger: AuditLoggerDeps = defaultAuditLogger,
): void {
  logger.log({type: 'broker-audit', ...meta, decision: 'deny-ratelimit'})
}

/**
 * Emits a `revoke` audit event — a key was revoked (by sweeper or run-end callback).
 * Never includes the key value.
 */
export function auditRevoke(meta: Omit<AuditMeta, 'decision'>, logger: AuditLoggerDeps = defaultAuditLogger): void {
  logger.log({type: 'broker-audit', ...meta, decision: 'revoke'})
}

/**
 * Emits an `error` audit event — an unexpected error occurred during mint.
 * Never includes token bytes, claim payloads, or the minted key.
 */
export function auditError(meta: Omit<AuditMeta, 'decision'>, logger: AuditLoggerDeps = defaultAuditLogger): void {
  logger.log({type: 'broker-audit', ...meta, decision: 'error'})
}
