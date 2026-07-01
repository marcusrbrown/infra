/**
 * Broker trust policy — code-owned allowlist constant.
 *
 * This is a reviewed code constant, not a secret. It describes the required
 * claim values that a GitHub Actions OIDC token must satisfy before the broker
 * will mint a cliproxy credential.
 *
 * The fro-bot/agent numeric IDs and the integrate workflow ref were supplied
 * at integration time (cross-repo, fro-bot/agent#1081). The broker pins
 * job_workflow_ref (the reusable integrate file), not workflow_ref (which is
 * the harness-release caller), because the integrate job runs as a reusable
 * workflow.
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
   */
  readonly repository_id: string
  /**
   * Numeric GitHub owner (org/user) ID. Survives renames.
   */
  readonly repository_owner_id: string
  /**
   * Exact job_workflow_ref value: "owner/repo/.github/workflows/<file>@<ref>".
   * Pins the reusable workflow file that requested the token (authorizes any
   * job in that file), never the forgeable `workflow` name claim. The integrate
   * job runs in a reusable workflow called by harness-release.yaml, so the
   * token's `workflow_ref` is the caller (harness-release) while
   * `job_workflow_ref` is the integrate file — the correct claim to pin.
   */
  readonly job_workflow_ref: string
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
 * The broker trust policy for the fro-bot/agent harness integrate job.
 * Values sourced from fro-bot/agent#1081 and verified against the live
 * GitHub API.
 */
export const BROKER_TRUST_POLICY: BrokerTrustPolicy = Object.freeze({
  repository: 'fro-bot/agent',

  // Numeric repository ID (gh api repos/fro-bot/agent --jq .id).
  repository_id: '1126485011',

  // Numeric owner ID for the fro-bot org (gh api users/fro-bot --jq .id).
  repository_owner_id: '80104189',

  // The reusable integrate workflow file that requests the OIDC token.
  // Pinning job_workflow_ref authorizes any job in this file; harness-integrate
  // documents a one-job invariant so minting authority is not silently shared.
  job_workflow_ref: 'fro-bot/agent/.github/workflows/harness-integrate.yaml@refs/heads/main',

  allowed_refs: Object.freeze(['refs/heads/main']),

  ref_type: 'branch',

  ref_protected: 'true',

  // pull_request and pull_request_target are excluded: they allow untrusted
  // code from a fork or PR branch to trigger the workflow and obtain a token.
  allowed_event_names: Object.freeze(['workflow_dispatch', 'push', 'schedule']),

  runner_environment: 'github-hosted',

  // fro-bot/agent is a public repository.
  repository_visibility: 'public',
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
      const v = claims.job_workflow_ref
      if (v === undefined) return {ok: false, reason: 'missing required claim: job_workflow_ref'}
      if (v !== policy.job_workflow_ref)
        return {ok: false, reason: `job_workflow_ref mismatch: got ${v}, expected ${policy.job_workflow_ref}`}
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
