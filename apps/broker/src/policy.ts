/**
 * Broker trust policy — code-owned allowlist constant.
 *
 * This is a reviewed code constant, not a secret. It describes the required
 * claim values that a GitHub Actions OIDC token must satisfy before the broker
 * will mint a cliproxy credential.
 *
 * The exact fro-bot/agent numeric IDs and workflow path are filled at
 * integration time (cross-repo, tracked in fro-bot/agent#1060). The
 * placeholder values below MUST be replaced with real values before the broker
 * is deployed. They are intentionally non-numeric strings so a type-check or
 * test will catch an unset placeholder.
 *
 * Pattern: apps/gateway/src/deploy.ts WORKSPACE_PERMISSION_POLICY
 */

// ---------------------------------------------------------------------------
// Policy type
// ---------------------------------------------------------------------------

export interface BrokerTrustPolicy {
  /** Exact repository slug (owner/repo). */
  readonly repository: string
  /**
   * Numeric GitHub repository ID. Survives renames; prevents typosquat.
   * PLACEHOLDER — replace with the real fro-bot/agent repository_id.
   */
  readonly repository_id: string
  /**
   * Numeric GitHub owner (org/user) ID. Survives renames.
   * PLACEHOLDER — replace with the real fro-bot org repository_owner_id.
   */
  readonly repository_owner_id: string
  /**
   * Exact workflow_ref value: "owner/repo/.github/workflows/<file>@<ref>".
   * Pin this, never the forgeable `workflow` name claim.
   * PLACEHOLDER — replace with the real integrate workflow path and ref.
   */
  readonly workflow_ref: string
  /** Allowed ref values (e.g. refs/heads/main). */
  readonly allowed_refs: readonly string[]
  /** ref_type must be "branch". */
  readonly ref_type: string
  /** ref_protected must be "true". */
  readonly ref_protected: string
  /**
   * Allowed event_name values. pull_request and pull_request_target are
   * explicitly excluded — they allow untrusted code to trigger the workflow.
   */
  readonly allowed_event_names: readonly string[]
  /** runner_environment must be "github-hosted". */
  readonly runner_environment: string
  /** repository_visibility must be "private". */
  readonly repository_visibility: string
}

// ---------------------------------------------------------------------------
// Policy constant
// ---------------------------------------------------------------------------

/**
 * The broker trust policy.
 *
 * IMPORTANT: repository_id, repository_owner_id, and workflow_ref are
 * PLACEHOLDERS. Replace them with the real fro-bot/agent values before
 * deploying. See fro-bot/agent#1060.
 */
export const BROKER_TRUST_POLICY: BrokerTrustPolicy = Object.freeze({
  repository: 'fro-bot/agent',

  // PLACEHOLDER: replace with the real numeric repository ID from
  // `gh api repos/fro-bot/agent --jq .id`
  repository_id: 'PLACEHOLDER_REPOSITORY_ID',

  // PLACEHOLDER: replace with the real numeric owner ID from
  // `gh api orgs/fro-bot --jq .id` (or `gh api users/fro-bot --jq .id`)
  repository_owner_id: 'PLACEHOLDER_REPOSITORY_OWNER_ID',

  // PLACEHOLDER: replace with the exact workflow_ref for the integrate
  // workflow, e.g. "fro-bot/agent/.github/workflows/integrate.yaml@refs/heads/main"
  workflow_ref: 'PLACEHOLDER_WORKFLOW_REF',

  allowed_refs: Object.freeze(['refs/heads/main']),

  ref_type: 'branch',

  ref_protected: 'true',

  // pull_request and pull_request_target are excluded: they allow untrusted
  // code from a fork or PR branch to trigger the workflow and obtain a token.
  allowed_event_names: Object.freeze(['workflow_dispatch', 'push', 'schedule']),

  runner_environment: 'github-hosted',

  repository_visibility: 'private',
} as const)

// ---------------------------------------------------------------------------
// Claim evaluation
// ---------------------------------------------------------------------------

export type EvaluateResult = {ok: true} | {ok: false; reason: string}

/**
 * Evaluates a set of verified JWT claims against the broker trust policy.
 *
 * Returns {ok: true} if all required claims are present and match the policy.
 * Returns {ok: false, reason} with a human-readable denial reason otherwise.
 *
 * This function is pure — it has no side effects and does not perform I/O.
 */
export function evaluateClaims(claims: Record<string, string | undefined>, policy: BrokerTrustPolicy): EvaluateResult {
  // Reject the pull_request sub form explicitly. GitHub sets sub to
  // "repo:owner/repo:pull_request" for PR-triggered workflows.
  const sub = claims.sub
  if (sub !== undefined && sub.includes(':pull_request')) {
    return {ok: false, reason: 'sub claim contains pull_request form — denied'}
  }

  // Required claim presence + value checks
  const checks: (() => EvaluateResult | null)[] = [
    () => {
      const v = claims.repository_id
      if (v === undefined) return {ok: false, reason: 'missing required claim: repository_id'}
      if (v !== policy.repository_id)
        return {ok: false, reason: `repository_id mismatch: got ${v}, expected ${policy.repository_id}`}
      return null
    },
    () => {
      const v = claims.repository_owner_id
      if (v === undefined) return {ok: false, reason: 'missing required claim: repository_owner_id'}
      if (v !== policy.repository_owner_id)
        return {
          ok: false,
          reason: `repository_owner_id mismatch: got ${v}, expected ${policy.repository_owner_id}`,
        }
      return null
    },
    () => {
      const v = claims.workflow_ref
      if (v === undefined) return {ok: false, reason: 'missing required claim: workflow_ref'}
      if (v !== policy.workflow_ref)
        return {ok: false, reason: `workflow_ref mismatch: got ${v}, expected ${policy.workflow_ref}`}
      return null
    },
    () => {
      const v = claims.ref
      if (v === undefined) return {ok: false, reason: 'missing required claim: ref'}
      if (!(policy.allowed_refs as readonly string[]).includes(v))
        return {ok: false, reason: `ref not in allowlist: ${v}`}
      return null
    },
    () => {
      const v = claims.ref_type
      if (v === undefined) return {ok: false, reason: 'missing required claim: ref_type'}
      if (v !== policy.ref_type) return {ok: false, reason: `ref_type mismatch: got ${v}, expected ${policy.ref_type}`}
      return null
    },
    () => {
      const v = claims.ref_protected
      if (v === undefined) return {ok: false, reason: 'missing required claim: ref_protected'}
      if (v !== policy.ref_protected)
        return {
          ok: false,
          reason: `ref_protected mismatch: got ${v}, expected ${policy.ref_protected}`,
        }
      return null
    },
    () => {
      const v = claims.event_name
      if (v === undefined) return {ok: false, reason: 'missing required claim: event_name'}
      if (!(policy.allowed_event_names as readonly string[]).includes(v))
        return {ok: false, reason: `event_name not in allowlist: ${v}`}
      return null
    },
    () => {
      const v = claims.runner_environment
      if (v === undefined) return {ok: false, reason: 'missing required claim: runner_environment'}
      if (v !== policy.runner_environment)
        return {
          ok: false,
          reason: `runner_environment mismatch: got ${v}, expected ${policy.runner_environment}`,
        }
      return null
    },
    () => {
      const v = claims.repository_visibility
      if (v === undefined) return {ok: false, reason: 'missing required claim: repository_visibility'}
      if (v !== policy.repository_visibility)
        return {
          ok: false,
          reason: `repository_visibility mismatch: got ${v}, expected ${policy.repository_visibility}`,
        }
      return null
    },
  ]

  for (const check of checks) {
    const result = check()
    if (result !== null) return result
  }

  return {ok: true}
}
