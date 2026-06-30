/**
 * Tests for the BROKER_TRUST_POLICY allowlist and evaluateClaims function.
 *
 * The policy pins specific claim values. The exact fro-bot/agent numeric IDs
 * and workflow path are placeholders here — filled at integration time (#1060).
 * These tests verify the evaluation logic against the policy structure.
 */
import {describe, expect, test} from 'bun:test'
import {BROKER_TRUST_POLICY, evaluateClaims} from './policy'

// ---------------------------------------------------------------------------
// Build a valid claim set that satisfies the policy
// ---------------------------------------------------------------------------

function validClaims(): Record<string, string> {
  return {
    iss: 'https://token.actions.githubusercontent.com',
    sub: `repo:${BROKER_TRUST_POLICY.repository}:ref:refs/heads/main`,
    repository: BROKER_TRUST_POLICY.repository,
    repository_id: BROKER_TRUST_POLICY.repository_id,
    repository_owner_id: BROKER_TRUST_POLICY.repository_owner_id,
    workflow_ref: BROKER_TRUST_POLICY.workflow_ref,
    ref: BROKER_TRUST_POLICY.allowed_refs[0] ?? 'refs/heads/main',
    ref_type: 'branch',
    ref_protected: 'true',
    event_name: 'workflow_dispatch',
    runner_environment: 'github-hosted',
    repository_visibility: 'private',
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('evaluateClaims — happy path', () => {
  test('all allowlisted claims → ok', () => {
    const result = evaluateClaims(validClaims(), BROKER_TRUST_POLICY)
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Forgeable-name trap
// ---------------------------------------------------------------------------

describe('evaluateClaims — workflow_ref vs workflow name', () => {
  test('workflow_ref path differs from policy → deny', () => {
    const claims = {
      ...validClaims(),
      // Same repo, same workflow name in the path, but different file path
      workflow_ref: `fro-bot/agent/.github/workflows/other-workflow.yaml@refs/heads/main`,
    }
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/workflow_ref/i)
    }
  })
})

// ---------------------------------------------------------------------------
// pull_request denial
// ---------------------------------------------------------------------------

describe('evaluateClaims — pull_request denial', () => {
  test('event_name: pull_request → deny', () => {
    const claims = {...validClaims(), event_name: 'pull_request'}
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/event_name|pull_request/i)
    }
  })

  test('event_name: pull_request_target → deny', () => {
    const claims = {...validClaims(), event_name: 'pull_request_target'}
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
  })

  test('sub in pull_request form → deny', () => {
    // GitHub sets sub to "repo:owner/repo:pull_request" for PR events
    const claims = {
      ...validClaims(),
      sub: `repo:${BROKER_TRUST_POLICY.repository}:pull_request`,
      event_name: 'workflow_dispatch', // even if event_name looks ok, sub form is rejected
    }
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/pull_request/i)
    }
  })
})

// ---------------------------------------------------------------------------
// repository_id mismatch (rename/typosquat)
// ---------------------------------------------------------------------------

describe('evaluateClaims — repository_id mismatch', () => {
  test('repository name matches but repository_id differs → deny', () => {
    const claims = {
      ...validClaims(),
      repository: BROKER_TRUST_POLICY.repository,
      repository_id: '999999999', // different numeric ID
    }
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/repository_id/i)
    }
  })

  test('repository_owner_id mismatch → deny', () => {
    const claims = {
      ...validClaims(),
      repository_owner_id: '111111111',
    }
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/repository_owner_id/i)
    }
  })
})

// ---------------------------------------------------------------------------
// Missing required claims
// ---------------------------------------------------------------------------

describe('evaluateClaims — missing claims', () => {
  const requiredClaims = [
    'repository_id',
    'repository_owner_id',
    'workflow_ref',
    'ref',
    'ref_type',
    'ref_protected',
    'event_name',
    'runner_environment',
    'repository_visibility',
  ] as const

  for (const claim of requiredClaims) {
    test(`missing ${claim} → deny with clear reason`, () => {
      const claims = {...validClaims()}
      delete (claims as Record<string, string>)[claim]
      const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(new RegExp(claim, 'i'))
      }
    })
  }
})

// ---------------------------------------------------------------------------
// ref allowlist
// ---------------------------------------------------------------------------

describe('evaluateClaims — ref allowlist', () => {
  test('ref not in allowed_refs → deny', () => {
    const claims = {
      ...validClaims(),
      ref: 'refs/heads/feature-branch', // not in allowed_refs
    }
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/ref not in allowlist/i)
    }
  })

  test('ref in allowed_refs → passes ref check', () => {
    const claims = {
      ...validClaims(),
      ref: BROKER_TRUST_POLICY.allowed_refs[0] ?? 'refs/heads/main',
    }
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    // Should pass (assuming all other claims are valid)
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runner_environment and repository_visibility
// ---------------------------------------------------------------------------

describe('evaluateClaims — environment and visibility', () => {
  test('runner_environment: self-hosted → deny', () => {
    const claims = {...validClaims(), runner_environment: 'self-hosted'}
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/runner_environment/i)
    }
  })

  test('repository_visibility: public → deny', () => {
    const claims = {...validClaims(), repository_visibility: 'public'}
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/repository_visibility/i)
    }
  })
})

// ---------------------------------------------------------------------------
// ref_protected
// ---------------------------------------------------------------------------

describe('evaluateClaims — ref_protected', () => {
  test('ref_protected: false → deny', () => {
    const claims = {...validClaims(), ref_protected: 'false'}
    const result = evaluateClaims(claims, BROKER_TRUST_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/ref_protected/i)
    }
  })
})

// ---------------------------------------------------------------------------
// BROKER_TRUST_POLICY shape
// ---------------------------------------------------------------------------

describe('BROKER_TRUST_POLICY structure', () => {
  test('policy is frozen (immutable)', () => {
    expect(Object.isFrozen(BROKER_TRUST_POLICY)).toBe(true)
  })

  test('policy excludes pull_request from allowed event_names', () => {
    expect(BROKER_TRUST_POLICY.allowed_event_names).not.toContain('pull_request')
    expect(BROKER_TRUST_POLICY.allowed_event_names).not.toContain('pull_request_target')
  })

  test('policy requires github-hosted runner', () => {
    expect(BROKER_TRUST_POLICY.runner_environment).toBe('github-hosted')
  })

  test('policy requires private repository', () => {
    expect(BROKER_TRUST_POLICY.repository_visibility).toBe('private')
  })
})
