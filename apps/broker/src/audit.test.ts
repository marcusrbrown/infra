/**
 * Tests for the broker audit module.
 *
 * Covers:
 * - auditRevoke emits a revoke event with correct shape
 * - redactSensitiveFields strips token/key/secret/etc. fields
 * - redactAuthorizationHeader always returns [REDACTED]
 * - No token bytes appear in audit events
 */

import type {AuditEvent} from './audit'

import {describe, expect, test} from 'bun:test'
import {auditDeny, auditMint, auditRevoke, redactAuthorizationHeader, redactSensitiveFields} from './audit'

// ---------------------------------------------------------------------------
// auditRevoke
// ---------------------------------------------------------------------------

describe('auditRevoke', () => {
  test('emits a revoke event with decision=revoke', () => {
    const events: AuditEvent[] = []
    const logger = {log: (e: AuditEvent) => events.push(e)}

    auditRevoke(
      {
        ts: '2026-01-01T00:00:00.000Z',
        srcIp: 'sweeper',
        runId: 'run-abc-123',
        jti: 'jti-xyz',
        reason: 'ttl-expired',
      },
      logger,
    )

    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event?.type).toBe('broker-audit')
    expect(event?.decision).toBe('revoke')
    expect(event?.runId).toBe('run-abc-123')
    expect(event?.jti).toBe('jti-xyz')
    expect(event?.reason).toBe('ttl-expired')
    expect(event?.srcIp).toBe('sweeper')
  })

  test('revoke event never contains key bytes (only run identity)', () => {
    const events: AuditEvent[] = []
    const logger = {log: (e: AuditEvent) => events.push(e)}

    const SECRET_KEY = 'ghact-run-abc-123-deadbeef01234567'

    auditRevoke(
      {
        ts: '2026-01-01T00:00:00.000Z',
        srcIp: 'sweeper',
        runId: 'run-abc-123',
        jti: 'jti-xyz',
        reason: 'ttl-expired',
        // key is intentionally NOT passed — only run identity
      },
      logger,
    )

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(SECRET_KEY)
  })

  test('uses defaultAuditLogger when no logger is provided', () => {
    // Just verify it does not throw — defaultAuditLogger writes to console.log
    expect(() =>
      auditRevoke({
        ts: '2026-01-01T00:00:00.000Z',
        srcIp: 'sweeper',
        runId: 'run-abc-123',
        jti: 'jti-xyz',
        reason: 'ttl-expired',
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// auditMint and auditDeny (shape checks)
// ---------------------------------------------------------------------------

describe('auditMint', () => {
  test('emits a mint event with decision=mint', () => {
    const events: AuditEvent[] = []
    const logger = {log: (e: AuditEvent) => events.push(e)}

    auditMint(
      {
        ts: '2026-01-01T00:00:00.000Z',
        srcIp: '10.0.0.1',
        runId: 'run-123',
        jti: 'jti-abc',
        repositoryId: '999',
        workflowRef: 'fro-bot/agent/.github/workflows/integrate.yaml@refs/heads/main',
      },
      logger,
    )

    expect(events[0]?.decision).toBe('mint')
    expect(events[0]?.type).toBe('broker-audit')
  })
})

describe('auditDeny', () => {
  test('emits a deny event with decision=deny', () => {
    const events: AuditEvent[] = []
    const logger = {log: (e: AuditEvent) => events.push(e)}

    auditDeny(
      {
        ts: '2026-01-01T00:00:00.000Z',
        srcIp: '10.0.0.1',
        reason: 'missing jti claim',
      },
      logger,
    )

    expect(events[0]?.decision).toBe('deny')
    expect(events[0]?.reason).toBe('missing jti claim')
  })
})

// ---------------------------------------------------------------------------
// redactSensitiveFields
// ---------------------------------------------------------------------------

describe('redactSensitiveFields', () => {
  test('redacts authorization field', () => {
    const result = redactSensitiveFields({authorization: 'Bearer eyJhbGci...'})
    expect(result.authorization).toBe('[REDACTED]')
  })

  test('redacts token field', () => {
    const result = redactSensitiveFields({token: 'secret-token-value'})
    expect(result.token).toBe('[REDACTED]')
  })

  test('redacts key field', () => {
    const result = redactSensitiveFields({key: 'ghact-run-123-abc'})
    expect(result.key).toBe('[REDACTED]')
  })

  test('redacts secret field', () => {
    const result = redactSensitiveFields({secret: 'my-secret'})
    expect(result.secret).toBe('[REDACTED]')
  })

  test('redacts password field', () => {
    const result = redactSensitiveFields({password: 'hunter2'})
    expect(result.password).toBe('[REDACTED]')
  })

  test('redacts credential field', () => {
    const result = redactSensitiveFields({credential: 'cred-value'})
    expect(result.credential).toBe('[REDACTED]')
  })

  test('redacts bearer field', () => {
    const result = redactSensitiveFields({bearer: 'eyJhbGci...'})
    expect(result.bearer).toBe('[REDACTED]')
  })

  test('preserves non-sensitive fields', () => {
    const result = redactSensitiveFields({runId: 'run-123', srcIp: '10.0.0.1', decision: 'mint'})
    expect(result.runId).toBe('run-123')
    expect(result.srcIp).toBe('10.0.0.1')
    expect(result.decision).toBe('mint')
  })

  test('redaction is case-insensitive', () => {
    const result = redactSensitiveFields({Authorization: 'Bearer token', TOKEN: 'value', Key: 'key-value'})
    expect(result.Authorization).toBe('[REDACTED]')
    expect(result.TOKEN).toBe('[REDACTED]')
    expect(result.Key).toBe('[REDACTED]')
  })

  test('returns a new object (does not mutate input)', () => {
    const input = {token: 'secret', runId: 'run-1'}
    const result = redactSensitiveFields(input)
    expect(result).not.toBe(input)
    expect(input.token).toBe('secret') // original unchanged
  })
})

// ---------------------------------------------------------------------------
// redactAuthorizationHeader
// ---------------------------------------------------------------------------

describe('redactAuthorizationHeader', () => {
  test('always returns [REDACTED] regardless of input', () => {
    expect(redactAuthorizationHeader('Bearer eyJhbGci...')).toBe('[REDACTED]')
    expect(redactAuthorizationHeader('')).toBe('[REDACTED]')
    expect(redactAuthorizationHeader('Basic dXNlcjpwYXNz')).toBe('[REDACTED]')
    expect(redactAuthorizationHeader('ghact-run-123-abc')).toBe('[REDACTED]')
  })
})
