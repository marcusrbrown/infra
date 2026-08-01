---
title: "feat: Fro Bot Agent S3 durable storage + generalized agent config command"
type: feat
status: active
date: 2026-08-01
origin: docs/brainstorms/2026-08-01-fro-bot-agent-s3-durable-storage-requirements.md
deepened: 2026-08-01
---

# feat: Fro Bot Agent S3 durable storage + generalized agent config command

## Overview

Enable the `fro-bot/agent` GitHub Action's Durable Object Storage (S3) feature for the repos where the action runs, and consolidate per-repo action configuration behind a generalized `agent` CLI command. Two artifacts ship: a new operator-run AWS provisioner (dedicated S3 bucket + account-level GitHub OIDC provider + one IAM role per consumer repo) and a generalized `agent` command group that absorbs `cliproxy setup`, wires non-secret S3 GitHub variables, and verifies (never mutates) the consumer workflow storage job-split. Credentials use native GitHub OIDC → AWS STS — no static AWS keys in any repo, no broker involvement. Content-triggered runs (pull_request/comment/issue) are excluded from durable storage by design; only environment-gated `schedule`/`workflow_dispatch@main` runs get it.

## Problem Frame

The action supports persisting OpenCode session state to S3 (`fro-bot-state/github/<owner-repo>/storage/...`) so state carries across ephemeral CI runs, but none of the supporting infra exists: no bucket, no OIDC provider, no IAM roles, and `cliproxy setup` touches no S3 config and only analyzes-and-warns about `fro-bot.yaml`. The action runs prompt-injectable, untrusted-content-influenced code, so any credential a run can reach is reachable by injected code; durable storage adds durable-memory poisoning, cross-repo exfiltration, and lock-manipulation risks. The design contains blast radius per repo (per-repo role + exact S3 prefix ARNs) and keeps durable storage away from content-triggered runs (no `id-token` on those jobs). See origin: `docs/brainstorms/2026-08-01-fro-bot-agent-s3-durable-storage-requirements.md`.

## Requirements Trace

| ID | Requirement | Advanced by |
| --- | --- | --- |
| R1 | Dedicated action-state S3 bucket (separate from gateway), public-access blocked, SSE-S3, versioning, TLS-only, lifecycle | Unit 2 |
| R2 | Account-level GitHub OIDC provider, idempotent, non-destructive | Unit 1 |
| R3 | Per-repo IAM role; trust pins aud + environment sub (legacy+immutable) + repository_id/owner_id/ref/workflow; no wildcard | Unit 3 |
| R4 | Per-repo least-privilege policy: session-prefix ARN + separate lock ARN; no DeleteObjectVersion; fail-closed on key-layout mismatch | Unit 3 |
| R5 | Generalized `agent` command owns all action config; absorbs `cliproxy setup`; no regression | Unit 5, Unit 6 |
| R6 | Command writes S3 config as non-secret variables only; refuses static AWS creds | Unit 6 |
| R7 | Command verifies workflow storage job-split (effective job graph); diff-not-mutate | Unit 7 |
| R8 | Provision-first: command verifies AWS resources exist, fails closed otherwise | Unit 6 |
| R9 | Durable storage only for schedule/workflow_dispatch@main via `fro-bot-storage` environment | Unit 3, Unit 7 |
| R10 | `id-token: write` only at storage job level; explicit job timeout; STS TTL headroom | Unit 7 (verifier), Unit 8 (docs) |
| R11 | Provisioner-owned retention/lifecycle (write-through-based expiry semantics documented) | Unit 2 |
| R12 | Fleet-ready abstraction, this-repo-first rollout, no multi-repo automation in first pass | Unit 3, Unit 6 |
| R13 | Fail closed unless repo OIDC subject form matches the approved form; gate immutable-sub transition | Unit 4, Unit 6 |
| R14 | Re-verify trust boundary on reusable-workflow/action-pin changes | Unit 7 |
| — | Teardown/deprovision path (operator-chosen state retention) | Unit 9 |

## Scope Boundaries

- No changes to the gateway provisioner, gateway bucket (`fro-bot-gateway-fronomenal`), gateway IAM user, or gateway bindings/run-state.
- No management of gateway "bindings" (gateway runtime control-plane state, created via `/fro-bot add-project`).
- No broker use/extension for AWS credentials — native OIDC → STS only.
- The `agent` command does not auto-edit consumer `fro-bot.yaml` (verify + diff only) and does not create AWS resources.
- No static AWS access keys written to any consumer repo.
- No durable storage for content-triggered (pull_request/comment/issue) runs.
- No GitHub `sub` customization (`PUT .../actions/oidc/customization/sub`).
- Initial rollout is `marcusrbrown/infra` only.

### Deferred to Separate Tasks

- Onboarding consumer repos beyond `marcusrbrown/infra`: incremental via the same command after the pattern is proven live.
- Category-specific S3 retention requiring an upstream `fro-bot/agent` object-tagging change: separate upstream coordination.
- KMS/customer-managed-key encryption: only if a concrete key-revocation/compliance need emerges.
- Applying the actual `marcusrbrown/infra` `fro-bot.yaml` job-split edit: the plan ships the verifier + emitted diff; the operator applies the workflow change (per R7).

## Context & Research

### Relevant Code and Patterns

- **CLI command group (goke):** `packages/cli/src/cli.ts` (`register*Commands` wiring); `packages/cli/src/commands/cliproxy/index.ts` (`registerCliproxyCommands`); per-action file + barrel `index.ts` convention. `cliproxy setup` at `packages/cli/src/commands/cliproxy/setup.ts` with helpers `setup/templates.ts` (`HarnessTemplate`, `getHarnessTemplate`), `setup/gh.ts` (`runGh`, `applyGhValue`, `withGhRetry` — secrets via stdin, variables via `--body`), `setup/validation.ts`, `setup/workflow-analyzer.ts` (`checkFroBotWorkflow`, `analyzeFroBotWorkflow`, `findFroBotAgentStepBodies`, `formatWorkflowSnippet`).
- **AWS provisioner patterns:** `apps/vpn/server/provision.ts` (`@aws-sdk/client-lightsail`, idempotent helpers, DI for testability, `Bun.spawn` only for SSH) and `apps/gateway/server/provision-droplet.ts` (`ensureRunStateLifecycleRule`: GET-merge-by-ID-PUT-readback, `redactLifecycleError`). AWS SDK deps already present: `@aws-sdk/client-s3` (apps/gateway), `@aws-sdk/client-lightsail` (apps/vpn); no IAM client yet.
- **Workflow-contract verification:** `packages/cli/src/conventions.test.ts` (`parseYaml` + typed shape assertions on jobs/permissions/secrets/`workflow_call`) — the model for the effective-job-graph verifier.
- **gh mechanism:** `setup/gh.ts` `applyGhValue('variable', ...)` for non-secret S3 variables.
- **MCP:** `packages/cli/src/commands/mcp.ts` `MCP_ALLOWLIST` — mutating commands excluded; `agent setup`/`agent storage` stay CLI-only.
- **Root scripts:** `provision:<app>` / `deploy:<app>` wrappers load root `.env` (operator-local AWS creds).

### Institutional Learnings

- First provision/deploy is a live contract test, not a happy path (`docs/solutions/workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md`, `.../broker-first-deploy-cascade-2026-06-30.md`): verify live behavior; match provider's exact "already exists" phrasing for idempotency; **pair provisioners with a cleanup/delete path so failed/disabled runs don't strand billable resources** (motivates Unit 9).
- Dedicated provisioning credentials, never ambient AWS fallback (`docs/runbooks/vpn-egress-box.md`); provisioning creds separate from runtime creds.
- No secret bytes via argv; materialize to temp files, clean up in `finally` (`.../ssh-agent-too-many-authentication-failures-2026-06-13.md`).
- Green deploy ≠ live-process-correct; readback must verify actual state (`.../broker-credential-lifecycle-restart-races-2026-07-02.md`) — provisioner readback-verifies each resource.
- New workflow/provisioning contracts get a `conventions.test.ts` assertion.

### External References

- AWS IAM condition keys (last-modified 2026-08-01): `token.actions.githubusercontent.com:repository_id`/`repository_owner_id`/`ref`/`workflow`/`job_workflow_ref` supported — <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html>. Added Jan 2026 (AWS What's New 2026-01-01). GitHub's "custom claims unavailable in AWS" doc is stale.
- OIDC in AWS — <https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws>; `sub` forms per trigger; environment sub `repo:OWNER/REPO:environment:NAME`.
- `aws-actions/configure-aws-credentials` v4 (SHA-pin, not moving tag) — OIDC role-to-assume, `role-duration-seconds`, `role-session-name`, sets `AWS_SESSION_TOKEN`; thumbprint no longer required for GitHub.
- S3 lifecycle API — <https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketLifecycleConfiguration.html> (Expiration, NoncurrentVersionExpiration, AbortIncompleteMultipartUpload).

## Key Technical Decisions

- **Native GitHub OIDC → AWS STS, no broker, no static keys.** Per-repo role assumed via `sts:AssumeRoleWithWebIdentity`; stolen STS creds expire, zero rotation burden. Broker rejected (adds a high-value AWS authority + network dependency, doesn't stop same-job injection).
- **Environment-gated storage; content-triggered runs excluded.** A `fro-bot-storage` GitHub Environment (main-only deployment-branch policy) gates the storage job; only that job holds `id-token: write`. PR/comment/issue jobs get no `id-token`, so injected content can't mint an OIDC token. This is the primary security boundary, not fork-token withholding.
- **Trust policy pins environment sub + AWS-supported GitHub claims** (`repository_id`, `repository_owner_id`, `ref=refs/heads/main`, `workflow`), `StringEquals`, accepting both legacy and immutable `sub` forms. No `repo:owner/*` wildcard.
- **IAM least-privilege with separated lock ARN.** `s3:ListBucket` prefix-scoped; `GetObject`/`PutObject` on `<bucket>/<prefix>/github/<owner-repo>/storage/*`; `GetObject`/`PutObject`/`DeleteObject` on the exact coordination-lock ARN only; never `DeleteObjectVersion`. `DeleteObject` is NOT granted on the session prefix (prevents an injected run wiping session history). Key patterns are pinned to the consumer's action version; provisioner fails closed on layout mismatch rather than widening.
- **Dedicated bucket, SSE-S3, versioning + lifecycle.** Separate from the gateway bucket. Retention is last-modified/write-through-based (documented, not read-inactivity): session ~90d, metadata/artifacts ~30d, noncurrent versions ~30d, abort-incomplete-multipart ~7d. `s3-expected-bucket-owner` set on every request. SSE-S3 over KMS (the role must decrypt its own sessions, so KMS can't contain the threat).
- **Account-level OIDC provider is shared and non-destructive.** List first; if a `token.actions.githubusercontent.com` provider exists, verify/append the `sts.amazonaws.com` audience — never recreate or re-thumbprint (Marcus's account may already have one for other projects).
- **Generalized `agent` command absorbs `cliproxy setup` via shared helpers + thin wrapper.** New `commands/agent/` group; `cliproxy setup` stays a working compatibility wrapper (a multiword legacy command needs a wrapper registration, not a goke single-token alias). Shared `setup/` helper modules are reused, not duplicated.
- **Provision-first, wire-second, verify-not-mutate.** AWS resource creation in a new provisioner; the command wires non-secret variables and verifies the workflow job-split (fails closed if resources or workflow shape are missing); the operator applies structural workflow edits.
- **Provisioner drift policy: warn-and-halt with `--force`.** On detecting a drifted role/policy/bucket setting, emit a diff and halt unless `--force` is passed (mirrors the gateway readback-verify discipline).
- **Per-resource idempotency contract.** Every provisioned resource follows discover → compare-canonical → mutate-if-absent-or-`--force` → readback → classify (`current` no-op / `absent` create / `managed-drift` halt-unless-force / `foreign-or-shared-drift` halt, never mutate). Rerun converges from observed live AWS state, not a local state file — a failed first run resumes safely.
- **Shared account-level resources get stricter do-no-harm rules than per-repo resources.** The OIDC provider is append-only (exactly one provider for `token.actions.githubusercontent.com` or halt on ambiguity; URL exact-match; append `sts.amazonaws.com` audience only if missing; thumbprints read-only, never removed/updated). The bucket is verified by owner before any mutation (`HeadBucket`/owner check; halt on wrong-owner or region mismatch, never reuse a foreign or mislocated bucket).
- **`workflow` trust claim is a drift tripwire, not a primary boundary.** The `workflow` claim is the human-readable, renameable workflow name; pinning it adds defense-in-depth but is not load-bearing. The real boundary is the environment `sub` + `repository_id`/`repository_owner_id` + `ref`. Rollout must capture the live OIDC claims and document which claims AWS actually enforces. If the storage job ever moves behind a reusable workflow, `job_workflow_ref` must be pinned to the approved reusable-workflow ref/SHA and the trust policy updated — otherwise the design is rejected (R14).
- **Canonical S3 key/prefix construction.** All prefixes and object ARNs are built canonically: no leading slash, no `*`/`?` in operator-supplied segments, single normalized trailing slash, repo segment validated/encoded. `ListBucket` uses delimiter-bounded `s3:prefix` values (or `StringLike` only on `<prefix>/github/<owner-repo>/storage/*`); object ARNs are always delimiter-bounded to prevent sibling-prefix overmatch (e.g. `<owner-repo>-evil`).
- **Least-privilege via explicit deny, not absence-of-allow alone.** The session-prefix delete boundary is an explicit `Deny` on `s3:DeleteObject`/`s3:DeleteObjectVersion` (not merely un-granted), so future policy accretion can't silently widen it for a prompt-injectable principal. Tests assert effective denies (policy-simulator/readback), not just JSON absence.
- **`apps/agent` is a private operator-tool-only workspace package.** `private: true`, no `deploy` script, no deploy workflow, no publish config; `provision:agent` is the only entrypoint. It declares `@aws-sdk/client-iam` and `@aws-sdk/client-s3` as its own deps (not borrowed from another workspace). Only `packages/cli` (the new user-facing `agent` command) gets a changeset. Filename `server/provision.ts` mirrors the VPN AWS-provisioner precedent (`apps/vpn/server/provision.ts`), deliberately not the droplet `provision-droplet.ts` name.
- **Shared setup core lives in a neutral module, not under `cliproxy`.** Extract the reusable GitHub-write/template/workflow helpers to a neutral location (e.g. `packages/cli/src/commands/agent/setup-core/` or `packages/cli/src/lib/github-setup/`) that both `agent setup` and the `cliproxy setup` wrapper import — so the legacy command name doesn't remain the architectural owner. Do not import `commands/cliproxy/setup/*` into `commands/agent/*`.

## Open Questions

### Resolved During Planning

- Command structure? Resolved: generalized `agent` group absorbing `cliproxy setup` (thin wrapper for the legacy command).
- Workflow edits? Resolved: verify + emit diff; operator applies (no auto-mutation).
- Rollout scope? Resolved: this-repo-first, fleet-ready abstraction, no multi-repo automation in the first pass.
- Encryption/retention/timeout/SSE? Resolved: SSE-S3; 90d/30d/30d + 7d abort-MPU (write-through semantics); explicit job timeout + STS ≥2h.
- Credential mechanism? Resolved: native OIDC → STS, no broker, no static keys.
- OIDC provider already exists in the account? Resolved: non-destructive list-and-append audience.
- Provisioner drift handling? Resolved: warn-and-halt + `--force`.
- Lifecycle "inactivity" semantics? Resolved: S3 expiry is last-modified-based; documented as write-through inactivity, not read-inactivity.
- Teardown in scope? Resolved: yes, as Unit 9.

### Deferred to Implementation

- Exact coordination-lock S3 key path at the pinned action version — verify against `fro-bot/agent` source at the consumer's pin before shaping the IAM ARN; fail closed on mismatch.
- Exact bucket name (globally unique) and target region — operator input at provision time; conditional `LocationConstraint` (omit for us-east-1).
- Precise `agent` subcommand surface (e.g. `agent setup` vs `agent storage setup`) and the `cliproxy setup` wrapper mechanics.
- Exact `role-duration-seconds` and `timeout-minutes` values (baseline: ≥7200s STS, bounded job timeout).
- Whether attacker-writable objects need an independent max-lifetime/quota beyond activity-based retention.
- `role-session-name` shape for CloudTrail attribution (baseline: include run id/attempt).
- Exact `gh api` shape for the GitHub Environment readback (existence + required-reviewer + main-only deployment-branch policy) the verifier asserts.
- Neutral module path for the extracted shared setup core (`packages/cli/src/commands/agent/setup-core/` vs `packages/cli/src/lib/github-setup/`).

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Repo lifecycle state machine (the two artifacts move a repo through these states):

```text
Unprovisioned --(provisioner: OIDC provider + bucket + per-repo role/policy)--> Provisioned
Provisioned   --(agent command: verify resources, wire non-secret vars)-------> Wired
Wired         --(operator applies verified fro-bot.yaml job-split edit)--------> StorageEnabled
StorageEnabled --(agent teardown: unwire vars, purge lock, retain|purge state)-> Unwired
Unwired       --(provisioner teardown: delete role/policy [+ optional objects])-> Unprovisioned
```

Provisioner order (each step idempotent + readback-verified, fail-closed): OIDC provider (list/verify/append audience) → bucket (owner-verify + create + public-access-block + versioning + SSE-S3 + TLS-only policy + lifecycle) → per-repo role + inline policy (session-prefix ARN + separate lock ARN) → readback verify → emit handoff manifest.

**Cross-artifact handoff manifest** (provisioner → command → teardown; the single contract that prevents state drift across the two artifacts). The provisioner emits this (printed JSON) after successful readback; the command verifies it against live GitHub repo identity before wiring; teardown accepts the same identity tuple and refuses if the role's tags/name/trust don't match the target repo:

```text
owner, repo, repository_id, repository_owner_id,
bucket, bucket_region (canonical, from readback), expected_bucket_owner,
s3_prefix, session_prefix, lock_key,
role_name, role_arn, policy_name,
action_ref_verified, key_layout_version
```

## Implementation Units

- [ ] **Unit 1: AWS OIDC provider provisioning (idempotent, non-destructive)**

  **Goal:** Ensure the account-level GitHub OIDC provider exists with the `sts.amazonaws.com` audience, without disrupting a pre-existing provider.

  **Requirements:** R2.

  **Dependencies:** None (foundation). Adds `@aws-sdk/client-iam` to the new provisioner package.

  **Files:**
  - Create: `apps/agent/server/provision.ts` (OIDC-provider section + handoff manifest emit), `apps/agent/package.json` (`private: true`, no deploy/publish; deps `@aws-sdk/client-iam` + `@aws-sdk/client-s3`)
  - Create: `apps/agent/server/provision.test.ts`
  - Modify: `package.json` (root `provision:agent` script), `bun.lock` (new workspace package)

  **Approach:**
  - `ListOpenIDConnectProvidersCommand` → require exactly one provider for `token.actions.githubusercontent.com` (halt on ambiguity/multiple); if it exists, `GetOpenIDConnectProviderCommand`, verify URL exact-match, verify `ClientIDList` contains `sts.amazonaws.com`, append via `AddClientIDToOpenIDConnectProviderCommand` only if missing; else `CreateOpenIDConnectProviderCommand` (URL, `ClientIDList: ['sts.amazonaws.com']`; thumbprint not required for GitHub). Never recreate an existing provider, never remove/update its thumbprints or other audiences (append-only).
  - Dedicated operator-local AWS creds (root `.env`); never ambient fallback. DI the IAM client for testability (mirror `apps/vpn/server/provision.ts`).
  - Handle `EntityAlreadyExists` as a benign race (GET-confirm).

  **Execution note:** Test-first on the idempotency/branching logic with a mocked IAM client.

  **Patterns to follow:** `apps/vpn/server/provision.ts` idempotent-helper + DI structure; `redactLifecycleError` redaction style.

  **Test scenarios:**
  - Happy path: no provider exists → creates one with the correct URL + audience.
  - Edge: provider exists with `sts.amazonaws.com` already present → no mutation (idempotent no-op).
  - Edge: provider exists WITHOUT `sts.amazonaws.com` → appends audience, does not recreate.
  - Error: `CreateOpenIDConnectProvider` throws `EntityAlreadyExists` → GET-confirms and proceeds.
  - Error: missing operator AWS creds → fails closed with a clear message, no ambient fallback.

  **Verification:** Mocked-IAM tests cover all branches; a real provider is never recreated or re-thumbprinted.

- [ ] **Unit 2: Dedicated S3 bucket provisioning (security controls + lifecycle)**

  **Goal:** Create/verify the dedicated action-state bucket with public-access block, versioning, SSE-S3, TLS-only policy, and lifecycle rules.

  **Requirements:** R1, R11.

  **Dependencies:** Unit 1 (same provisioner, `@aws-sdk/client-s3` already available).

  **Files:**
  - Modify: `apps/agent/server/provision.ts` (bucket section), `apps/agent/server/provision.test.ts`

  **Approach:**
  - Before mutating: `HeadBucket` + owner verification. Halt (never reuse) if the bucket exists in another account, has a wrong `ExpectedBucketOwner`, or exists in a different region than requested. Derive/print the expected-bucket-owner from STS caller identity; the handoff records the canonical region from readback, not the requested region.
  - `CreateBucketCommand` with conditional `CreateBucketConfiguration.LocationConstraint` (omit for us-east-1); tolerate bucket-already-owned-by-this-account. Then `PutPublicAccessBlockCommand` (all four true), `PutBucketVersioningCommand` (Enabled), `PutBucketEncryptionCommand` (`AES256`), `PutBucketPolicyCommand` (deny non-TLS `aws:SecureTransport=false`), `PutBucketLifecycleConfigurationCommand`. Pass `ExpectedBucketOwner` on every supporting call.
  - Lifecycle rules with canonical owned IDs (`fro-bot-agent-session-90d`, `fro-bot-agent-metadata-30d`, `fro-bot-agent-noncurrent-30d`, `fro-bot-agent-abort-mpu-7d`): session-prefix Expiration ~90d, metadata/artifacts-prefix Expiration ~30d, NoncurrentVersionExpiration ~30d, AbortIncompleteMultipartUpload ~7d. Reuse the GET-merge-by-ID-PUT-readback comparator from `ensureRunStateLifecycleRule`: merge only the owned-ID rules, preserve any rule whose ID is not in the owned set, so a reused bucket's unrelated lifecycle rules are never clobbered. Note (R11): S3 expiry is last-modified-based; "90d inactivity" holds only because the action writes-through each run — document as write-through inactivity, not read-inactivity.
  - Readback-verify each setting; warn-and-halt on drift unless `--force`.

  **Execution note:** Test-first; assert the exact lifecycle rule set and the region-conditional LocationConstraint.

  **Patterns to follow:** `apps/gateway/server/provision-droplet.ts` `ensureRunStateLifecycleRule` (shape-tolerant readback comparator).

  **Test scenarios:**
  - Happy path: bucket absent → created with all controls; lifecycle rules match canonical set; readback passes.
  - Edge: us-east-1 → no LocationConstraint; non-us-east-1 → LocationConstraint present.
  - Edge: bucket exists, controls already current → idempotent no-op (no redundant PUTs).
  - Edge: bucket exists with drifted lifecycle/versioning/SSE → warn-and-halt; `--force` re-applies.
  - Error: bucket owned by another account (ExpectedBucketOwner mismatch) → fails closed.
  - Error: readback mismatch after PUT → throws (no silent success).

  **Verification:** Mocked-S3 tests prove control set, region conditional, idempotency, drift-halt, and readback-fail-throws.

- [ ] **Unit 3: Per-repo IAM role + trust policy**

  **Goal:** Create/verify one IAM role per consumer repo with the OIDC trust policy (environment sub + GitHub-claim conditions).

  **Requirements:** R3, R9, R12.

  **Dependencies:** Units 1-2.

  **Files:**
  - Modify: `apps/agent/server/provision.ts` (role/trust section), `apps/agent/server/provision.test.ts`

  **Approach:**
  - `GetRoleCommand` → `CreateRoleCommand` (`AssumeRolePolicyDocument` = trust JSON, `MaxSessionDuration` ≥ 7200) if absent; else compare trust policy and warn-and-halt on drift (`--force` updates via `UpdateAssumeRolePolicyCommand`).
  - Trust `Condition` `StringEquals`: `:aud`=`sts.amazonaws.com`; `:sub` accepts both `repo:<owner>/<repo>:environment:fro-bot-storage` and the immutable `repo:<owner>@<owner_id>/<repo>@<repo_id>:environment:fro-bot-storage` form; `:repository_id`, `:repository_owner_id`, `:ref`=`refs/heads/main`, `:workflow` (tripwire only — see Key Decisions; the load-bearing pins are repository_id/owner_id + environment sub + ref). No wildcard. Role naming per-repo (e.g. `fro-bot-agent-storage-<owner>-<repo>`); tag the role + policy with repo identity + a managed-by marker for readback/teardown safety.
  - IAM eventual consistency: bounded retry/readback after `CreateRole`/`UpdateAssumeRolePolicy`/`PutRolePolicy` so a subsequent step (or the command preflight) doesn't fail on propagation lag.
  - Sub-form fail-closed (R13): only the approved sub form(s) are emitted; if the target repo's live OIDC config would emit a form the policy wasn't built for, the command halts (see Unit 6).
  - Fleet-ready: role/prefix derived per-repo from inputs; NO repo-inventory loop or onboarding automation in this pass.

  **Execution note:** Test-first on the trust-policy JSON shape.

  **Patterns to follow:** Broker trust-claim shape in `apps/broker/src/policy.ts` (claim names/values reference); provisioner idempotency from Units 1-2.

  **Test scenarios:**
  - Happy path: role absent → created; trust policy contains both sub forms + all four claim conditions, StringEquals, no wildcard.
  - Edge: role exists, trust identical → no-op.
  - Edge: role exists, trust drifted → warn-and-halt; `--force` updates.
  - Error: attempt to write a `repo:owner/*` wildcard sub → rejected by construction (assert the generator never emits a wildcard).

  **Verification:** Trust JSON asserted field-by-field; no wildcard path exists.

- [ ] **Unit 4: Per-repo IAM policy + action-version key-layout pin (fail-closed)**

  **Goal:** Attach the least-privilege inline policy scoping S3 access to the repo's session prefix + separate coordination-lock ARN, pinned to the consumer action's verified key layout.

  **Requirements:** R4, R13.

  **Dependencies:** Unit 3.

  **Files:**
  - Modify: `apps/agent/server/provision.ts` (policy section), `apps/agent/server/provision.test.ts`
  - Create: `apps/agent/src/key-layout.ts` (pinned action key-layout patterns + validation), `apps/agent/src/key-layout.test.ts`

  **Approach:**
  - Inline policy via `PutRolePolicyCommand`: `s3:ListBucket` on bucket ARN with `s3:prefix` condition scoped to the repo prefixes; `s3:GetObject`/`s3:PutObject` on `<bucket>/<prefix>/github/<owner-repo>/storage/*`; `s3:GetObject`/`s3:PutObject`/`s3:DeleteObject` on the exact coordination-lock object ARN only. Never `s3:DeleteObject`/`s3:DeleteObjectVersion` on the session prefix.
  - `key-layout.ts` holds the session + coordination-lock key patterns pinned to a specific `fro-bot/agent` version; the provisioner fails closed (refuses to apply) if the target repo's pinned action version isn't a known-verified layout — never widen to make a mismatch work.
  - Explicit `Deny` (not mere absence) on `s3:DeleteObject`/`s3:DeleteObjectVersion` for the session-prefix ARN, so future policy accretion can't silently widen it.
  - Canonical prefix/ARN construction (see Key Decisions): delimiter-bounded object ARNs; `ListBucket` `s3:prefix` delimiter-bounded; validate the repo segment to prevent sibling overmatch.
  - Enumerate the exact S3 actions the pinned action's adapter needs at key-layout-verification time and decide each explicitly: `HeadObject` (rides on GetObject), and whether `s3:GetObjectAttributes`/`s3:GetObjectVersion`/`s3:GetObjectVersionAttributes`/`ListBucketVersions`/`GetBucketLocation` are required or intentionally denied. Version delete stays denied.
  - The exact lock path is a deferred-to-implementation verification against the pinned action source (see Open Questions).

  **Execution note:** Test-first; the deny-boundaries are the security contract.

  **Patterns to follow:** Least-privilege ARN scoping; `conventions.test.ts` explicit-shape assertions.

  **Test scenarios:**
  - Happy path: policy grants GetObject/PutObject on the session prefix and Get/Put/Delete on the lock ARN only.
  - Security: policy does NOT grant DeleteObject or DeleteObjectVersion on the session prefix (explicit negative assertion).
  - Security: `s3:ListBucket` is prefix-conditioned, not bucket-wide read.
  - Edge: unknown/unverified action key-layout version → provisioner fails closed, applies nothing.
  - Edge: lock ARN is the exact object key, not a wildcard over `coordination/*`.

  **Verification:** Policy JSON asserted including negative (no delete on session prefix); fail-closed on unrecognized layout.

- [ ] **Unit 5: Scaffold `agent` command group; migrate shared setup helpers**

  **Goal:** Create the `agent` command group reusing the `cliproxy setup` helper modules, with `cliproxy setup` preserved as a compatibility wrapper — no behavior/test regression.

  **Requirements:** R5.

  **Dependencies:** None (CLI-side; parallel to provisioner units).

  **Files:**
  - Create: `packages/cli/src/commands/agent/index.ts` (`registerAgentCommands`), `packages/cli/src/commands/agent/setup.ts`
  - Modify: `packages/cli/src/cli.ts` (register `registerAgentCommands`), `packages/cli/src/commands/cliproxy/setup.ts` (delegate to shared impl / wrapper)
  - Test: `packages/cli/src/commands/agent/setup.test.ts`, and keep `packages/cli/src/commands/cliproxy/setup.test.ts` green

  **Approach:**
  - Reuse (do not duplicate) `setup/templates.ts`, `setup/gh.ts`, `setup/validation.ts`, `setup/workflow-analyzer.ts`. Extract the shared `runSetupCommand` core so both `agent setup` and the `cliproxy setup` wrapper call it.
  - `cliproxy setup` remains registered and behaves identically (multiword legacy command → thin wrapper, not a goke alias).
  - Keep `@clack/prompts` scoped to setup; preserve interactive/non-interactive dual mode and `--dry-run`.
  - Compatibility contract (R5): `cliproxy setup` keeps model-credential wiring unchanged; S3 is additive/opt-in.

  **Execution note:** Characterization-first — assert current `cliproxy setup` behavior is preserved before refactoring the shared core.

  **Patterns to follow:** `packages/cli/src/commands/cliproxy/index.ts` registration; existing setup tests.

  **Test scenarios:**
  - Happy path: `agent setup` with model-cred options only behaves exactly as `cliproxy setup` does today.
  - Compat: `cliproxy setup` still works and produces identical GitHub writes/warnings (no regression).
  - Edge: help text and command registration list include `agent` group; MCP allowlist unchanged (agent commands not exposed).
  - Edge: `--dry-run` short-circuits before validation for both entrypoints.

  **Verification:** Full existing setup test suite green; new agent tests prove parity; conventions test still 0 fail.

- [ ] **Unit 6: `agent` S3 wiring + provision-first + OIDC subject precheck**

  **Goal:** Add S3 durable-storage configuration to the `agent` command: verify AWS resources exist, validate repo OIDC subject form, and wire non-secret S3 variables (refusing static creds).

  **Requirements:** R6, R8, R12, R13.

  **Dependencies:** Unit 5 (command scaffold); Units 1-4 (resources to verify against).

  **Files:**
  - Modify: `packages/cli/src/commands/agent/setup.ts`
  - Create: `packages/cli/src/commands/agent/storage.ts` (S3 wiring + prechecks), `packages/cli/src/commands/agent/storage.test.ts`

  **Approach:**
  - Provision-first (R8): before wiring, verify the per-repo role + bucket exist (e.g. `gh`/AWS preflight or an OIDC dry-run readback); fail closed with "run the provisioner first" guidance and wire nothing if absent. Verify the provisioner handoff manifest against live GitHub repo identity (owner/repo/repository_id/repository_owner_id) before writing any variable — refuse on mismatch (guards against stale/copy-paste manifest).
  - OIDC subject precheck (R13): read `GET /repos/{owner}/{repo}/actions/oidc/customization/sub` via `gh api`; if a custom template is active or the repo emits an immutable-sub form the trust policy wasn't built for, fail closed and require explicit re-verification.
  - Wire non-secret variables only via `applyGhValue('variable', ...)`: role ARN, bucket, region, prefix, expected-bucket-owner (exact names finalized in impl; map to the action's `role-to-assume`/`s3-bucket`/`aws-region`/`s3-prefix`/`s3-expected-bucket-owner`). Never write `AWS_ACCESS_KEY_ID`/secret; refuse static-cred input (R6). Storage jobs must preserve outbound egress restrictions (harden-runner or equivalent) allowing only GitHub OIDC, AWS STS, and the regional S3 endpoints — injected code with live STS creds can otherwise exfiltrate during the TTL even with perfect IAM (verified in Unit 7 / documented in Unit 8).
  - S3 is opt-in: a repo not enabling storage is never blocked by S3 checks (R5 compat).

  **Execution note:** Test-first; the fail-closed gates are the contract.

  **Patterns to follow:** `setup/gh.ts` `applyGhValue`; `setup/validation.ts` precheck style; `setup/workflow-analyzer.ts` `gh api` fetch.

  **Test scenarios:**
  - Happy path: resources exist + standard OIDC sub → writes exactly the non-secret S3 variables, no secrets.
  - Error: resources absent → fails closed, wires nothing, emits "run provisioner first".
  - Security: custom OIDC sub template present → fails closed, requires re-verification.
  - Security: attempt to pass static AWS keys → refused.
  - Compat: repo without storage opt-in → S3 checks are non-blocking; model-cred wiring proceeds.

  **Verification:** Tests prove provision-first gate, OIDC precheck fail-closed, non-secret-only writes, and opt-in compatibility.

- [ ] **Unit 7: Workflow storage job-split verifier (effective job graph)**

  **Goal:** Verify the consumer `fro-bot.yaml` enforces the storage job-split by resolving the effective job graph, and emit a precise diff when non-compliant — never mutate.

  **Requirements:** R7, R9, R10, R14.

  **Dependencies:** Unit 6 (invoked from the wiring flow).

  **Files:**
  - Create: `packages/cli/src/commands/agent/workflow-verify.ts`, `packages/cli/src/commands/agent/workflow-verify.test.ts`
  - Modify: `packages/cli/src/commands/agent/setup.ts` (invoke verifier)

  **Approach:**
  - Fetch `.github/workflows/fro-bot.yaml` via `gh api` (reuse analyzer fetch). Parse with `parseYaml` and resolve the effective trigger→job→permissions/environment matrix (not a regex/local-shape check).
  - Compliance: a storage job bound to the `fro-bot-storage` environment with job-level `id-token: write`, reachable ONLY from `schedule` and `workflow_dispatch` on `refs/heads/main`; the `fro-bot/agent` action pin exposes S3 inputs and is SHA-pinned.
  - Explicit trigger denylist: treat as content-triggered (must NOT reach a storage/id-token job) every non-(schedule/dispatch@main) event, especially `pull_request_target`, `workflow_run`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issues`, `issue_comment`, `discussion`, `discussion_comment`. Fail closed on any event the verifier can't prove safe.
  - Effective-graph hard cases the verifier must model (not just local shape): workflow-level `permissions` inheritance vs job-level overrides; `id-token` never workflow-wide; statically-decidable `if:` on `github.event_name`; conservative matrix expansion; transitive `needs:` reachability AND artifact/cache handoff from a content-reachable job into a storage job (durable-poison vector); reject job-level reusable-workflow `uses:` for storage jobs unless SHA-pinned and separately verified (R14). Fail closed on any dynamic expression it can't prove safe.
  - Current `fro-bot.yaml` is a single `fro-bot` job with `contents: read`, no matrix/needs/reusable-`uses`/`environment` — the verifier starts simple but the graph model is required so a future refactor can't slip a leak past it.
  - GitHub Environment readback (not visible in YAML): via `gh api`, verify the `fro-bot-storage` environment exists with a required reviewer and a `main`-only deployment-branch policy — fail closed if absent or permissive. The output separates "workflow YAML compliant" from "GitHub Environment policy verified" so a shape-compliant workflow referencing an unprotected/auto-created environment can't pass.
  - Non-compliant → emit a unified diff / pasteable job-split snippet (extend `formatWorkflowSnippet`); do not edit the file.

  **Execution note:** Test-first against a matrix of mock `fro-bot.yaml` fixtures (compliant + each violation).

  **Patterns to follow:** `conventions.test.ts` `parseYaml` shape assertions; `setup/workflow-analyzer.ts` fetch + snippet formatting.

  **Test scenarios:**
  - Happy path: compliant workflow (storage job env-gated + job-level id-token; content jobs without) → passes.
  - Security: `id-token: write` at workflow level → rejected.
  - Security: `id-token` on a job reachable by `pull_request`/`issue_comment` → rejected.
  - Security: storage job routed through an unpinned reusable workflow → rejected (R14).
  - Security: `pull_request_target` or `workflow_run` reaches the storage job → rejected (explicit denylist).
  - Security: a storage (schedule-only) job consumes an artifact/output from a content-reachable job via `needs:` → rejected (poison-handoff).
  - Security: `fro-bot-storage` environment missing / no required reviewer / not main-only (Environment API readback) → fail closed, distinct from YAML compliance.
  - Edge: storage job triggers include something beyond schedule/workflow_dispatch@main → rejected.
  - Edge: dynamic `if:`/matrix the verifier can't prove safe → fail closed.
  - Edge: action pin lacks S3 inputs / not SHA-pinned → flagged.
  - Diff: non-compliant workflow → emits an accurate pasteable job-split diff, file unchanged.

  **Verification:** Fixture matrix covers compliant + every violation; verifier never writes the workflow.

- [ ] **Unit 8: Conventions test + operator docs**

  **Goal:** Add the workflow/provisioning contract assertions and document the provisioner, the `agent` command, and the operator runbook (job-split, timeouts, STS TTL).

  **Requirements:** R5, R10, R11.

  **Dependencies:** Units 1-7.

  **Files:**
  - Modify: `packages/cli/src/conventions.test.ts` (new contract assertions), `packages/cli/AGENTS.md`, `AGENTS.md` (root), `apps/gateway/AGENTS.md` (cross-ref if needed)
  - Create: `apps/agent/AGENTS.md`, `docs/runbooks/agent-s3-durable-storage.md`

  **Approach:**
  - Conventions assertions: `agent` group registered; MCP allowlist still excludes mutating agent commands; any new workflow contract the verifier depends on. No secret-via-argv, `.yaml` + SHA-pin conventions upheld.
  - Docs: provisioner usage (operator-local AWS creds, `provision:agent`, drift `--force`), the `agent` command flow, the required `fro-bot.yaml` job-split shape, the **corrected rollout sequence with environment pre-create before workflow reference**, `fro-bot-storage` environment (required reviewer + main-only branch policy), explicit `timeout-minutes` replacing `timeout:0`, STS `role-duration-seconds` ≥ 2h, `role-session-name` for CloudTrail, harden-runner egress allowlist for storage jobs, retention semantics (write-through-based, not read-inactivity), the security model (content runs excluded, no static creds), and the Go/No-Go + rollback checklist from Documentation / Operational Notes.
  - Changeset: `packages/cli/src/` user-facing (new `agent` command) → add a changeset.

  **Test scenarios:**
  - `conventions.test.ts`: new assertions pass; existing suite unaffected.
  - Docs are cross-checked against implemented names/behavior (no drift).
  - `Test expectation: none` for the AGENTS.md/runbook prose portions (docs, not behavior) — the conventions assertions carry the behavioral checks.

  **Verification:** Conventions suite green; docs match implemented contract; changeset present.

- [ ] **Unit 9: Teardown / deprovision path**

  **Goal:** Provide a deprovision path that removes per-repo AWS resources and unwires the repo, letting the operator choose whether to retain or purge session objects — so disabling storage doesn't strand billable resources.

**Teardown order (order-tolerant but this is the recommended sequence to minimize operator surprise):** (1) command unwires repo S3 variables / marks storage disabled; (2) delete the repo's lock object; (3) optional `--purge-state` deletes the repo's session-prefix objects; (4) delete inline policy; (5) delete role; (6) readback-verify role/policy absent and shared bucket/OIDC still present. Each sub-step is independently idempotent: role-absent-but-variables-present still unwires; variables-absent-but-role-present still tears down; lock/state-delete failure (e.g. missing admin creds) reports "state purge impossible" and continues scoped cleanup. Includes a `--plan`/dry-run readback and a stranded-resource audit (roles matching `fro-bot-agent-storage-*` with no matching repo variables; lock objects older than max-job-timeout+grace; incomplete multipart uploads; orphaned noncurrent versions).

  **Requirements:** Teardown (origin Deferred/flow-analysis + VPN cleanup learning).

  **Dependencies:** Units 1-6.

  **Files:**
  - Modify: `apps/agent/server/provision.ts` (teardown mode / flag), `apps/agent/server/provision.test.ts`
  - Modify: `packages/cli/src/commands/agent/storage.ts` (unwire variables), `packages/cli/src/commands/agent/storage.test.ts`
  - Modify: `docs/runbooks/agent-s3-durable-storage.md` (teardown procedure)

  **Approach:**
  - Provisioner teardown: delete the per-repo inline policy + role (`DeleteRolePolicyCommand`, `DeleteRoleCommand`); purge the coordination-lock object; leave the shared OIDC provider and bucket intact. Session objects: default RETAIN; explicit `--purge-state` deletes the repo's session prefix objects. Idempotent (safe when already absent).
  - Command unwire: remove the S3 GitHub variables from the repo (leave model-cred config untouched).
  - Partial-failure safety: teardown is idempotent and order-tolerant; failing midway can be re-run to convergence.

  **Execution note:** Test-first; assert retain-by-default and shared-resource preservation.

  **Test scenarios:**
  - Happy path: teardown deletes role + policy + lock; retains session objects by default; OIDC provider and bucket untouched.
  - Edge: `--purge-state` also deletes the repo's session-prefix objects.
  - Edge: teardown re-run when role/policy already absent → idempotent no-op.
  - Security: teardown never deletes another repo's prefix or the shared bucket.
  - Command: unwire removes S3 variables, leaves model-cred variables/secrets intact.

  **Verification:** Tests prove scoped deletion, retain-default, idempotency, and shared-resource preservation.

## System-Wide Impact

- **Interaction graph:** New `apps/agent/` provisioner (operator-run, IAM+S3) and new `packages/cli/src/commands/agent/` group; `cliproxy setup` becomes a wrapper over shared setup core. No runtime coupling to gateway/broker.
- **Error propagation:** Provisioner fails closed on drift (warn-and-halt + `--force`), unrecognized action key-layout, ExpectedBucketOwner mismatch, and readback mismatch. Command fails closed when resources absent or OIDC sub non-standard. Verifier fails closed on any job-split violation.
- **State lifecycle risks:** Partial provisioning (role created, policy failed) → teardown/re-run converges. Enabled→disabled leaves session state unless `--purge-state`. STS-expiry-before-lock-release mitigated by ≥2h TTL + bounded job timeout.
- **API surface parity:** `agent setup` and `cliproxy setup` share one core; both must stay in parity (compat tests).
- **Integration coverage:** OIDC→STS assume-role, cross-repo prefix isolation, and lock-vs-session delete boundaries are runtime behaviors mocked in unit tests here and verified live during rollout (see Risks).
- **Unchanged invariants:** Gateway bucket/IAM/bindings/run-state untouched; broker untouched; existing `cliproxy setup` model-cred behavior unchanged; MCP allowlist unchanged. `apps/agent` is a private operator-tool package (no deploy workflow, no publish); the shared account-level OIDC provider and bucket are never mutated destructively and are preserved across per-repo teardown.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Coordination-lock key path differs at the pinned action version → IAM too narrow (wedges runs) or too broad | Pin key layout in `key-layout.ts`; provisioner fails closed on unrecognized version; verify exact lock path against pinned action source before applying (deferred-to-impl). |
| Account already has a GitHub OIDC provider → destructive recreate breaks other projects | Non-destructive list-and-append audience; never recreate/re-thumbprint. |
| STS expiry before post-action lock release → wedged state | STS `role-duration-seconds` ≥ 7200 + explicit `timeout-minutes`; documented in runbook. |
| Shape-compliant workflow still leaks id-token (reusable workflow / shared job) | Verifier resolves effective job graph and rejects unpinned reusable-workflow indirection (R14). |
| Immutable-sub transition silently breaks trust match | Trust policy accepts both sub forms; command OIDC precheck fails closed on unexpected form. |
| Absorbing `cliproxy setup` regresses existing users | Shared helper reuse + wrapper; characterization tests; S3 additive/opt-in. |
| Lifecycle "inactivity" misunderstood as read-based | Documented as last-modified/write-through expiry; not read-inactivity. |
| Cross-repo/gateway data access under prompt injection | Per-repo role, prefix-scoped ARNs, separate lock ARN, no DeleteObjectVersion; dedicated bucket. |
| Live AWS behavior differs from SDK/docs (first-provision) | Treat first provision as a live contract test; readback-verify; rollout on `marcusrbrown/infra` first. |
| `fro-bot-storage` environment auto-created unprotected when the workflow first references it | Pre-create the protected environment (required reviewer + main-only) BEFORE applying the workflow split; verifier reads back the environment policy via `gh api` and fails closed. |
| Static workflow verifier greenlights a poison-handoff (storage job consumes artifact/output from a content-reachable job) | Verifier models transitive `needs:` reachability + artifact/cache handoff and fails closed on dynamic expressions it can't prove safe. |
| `pull_request_target`/`workflow_run` reach a storage job | Explicit trigger denylist in the verifier; only schedule + workflow_dispatch@main may reach id-token/storage jobs. |
| Injected code exfiltrates STS creds/session data over arbitrary egress during the TTL | harden-runner (or equivalent) egress allowlist on storage jobs limited to GitHub OIDC + AWS STS + regional S3; verified/documented. |
| Stale/copy-paste handoff manifest wires the wrong role/bucket/prefix | Command verifies the manifest against live GitHub repo identity before wiring; teardown refuses on role-tag/identity mismatch. |
| Reused bucket's unrelated lifecycle rules clobbered | Merge only owned rule IDs; preserve foreign rules (shape-tolerant comparator). |

## Documentation / Operational Notes

- New runbook `docs/runbooks/agent-s3-durable-storage.md`: provision (operator-local AWS creds via `provision:agent`), pre-create the protected environment, wire (`agent` command), apply the `fro-bot.yaml` job-split (from the verifier's diff), and teardown — with the Go/No-Go checklist and rollback procedure below.
- **Corrected rollout sequence** (the environment must be pre-created protected BEFORE the workflow references it — otherwise GitHub auto-creates it unprotected, per the VPN environment learning): (1) provision AWS; (2) **pre-create `fro-bot-storage` GitHub Environment with required reviewer + main-only deployment-branch policy**; (3) run the `agent` command to wire non-secret variables; (4) operator applies the workflow job-split; (5) run the verifier (YAML + environment readback); (6) trigger `workflow_dispatch@main` and approve the environment gate; (7) live-verify; (8) do not onboard repo #2 until every probe passes on `marcusrbrown/infra`.
- **Go/No-Go live verification (GO only if all pass):** OIDC provider readback non-destructive (audience appended, thumbprints/other audiences unchanged, not recreated); bucket public-access-block all-true, versioning Enabled, SSE `AES256`, non-TLS denied, not the gateway bucket; per-repo role trust pins environment sub + repository_id (`1200110668`) + repository_owner_id (`831617`) + ref, no wildcard; STS `AssumeRoleWithWebIdentity` succeeds end-to-end with `roleSessionName` carrying run id; forced cache miss restores session state from S3; write lands only under `<prefix>/github/marcusrbrown-infra/storage/...`; lock acquire/release leaves no lock. **Negative probes (each must fail closed):** wrong expected-bucket-owner; cross-repo prefix read; gateway-bucket read/write; session-object delete; object-version delete; anonymous/public read; set-public-ACL. **Content-triggered run:** no `id-token`, no AWS env vars, OIDC token unavailable, storage disabled, behavior matches pre-storage.
- **Rollback:** partial-provision-before-workflow-change → don't wire; audit + delete per-repo role/policy/lock; retain shared bucket/OIDC. Workflow-changed-but-verification-failed → revert the split / disable S3 inputs, `agent` unwire variables, confirm content jobs still run, purge stale lock. Credential-boundary-violation (content job got id-token / cross-repo or gateway access succeeded / version-delete succeeded) → disable the environment, revert split, remove variables, detach+delete role, preserve objects for forensics, review CloudTrail since enablement, do not re-enable until trust policy + verifier are fixed.
- **24h monitoring:** alert on any AssumeRole failure, any S3 access outside the repo prefix, any content-triggered AWS credential presence, lock objects older than timeout+grace, unexpected noncurrent-version growth, any bucket public-access finding, lifecycle drift. Check at +1h/+4h/+24h.
- Changeset required (new user-facing `agent` CLI command).
- No deploy pipeline fires from this work; the provisioner is operator-run.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-08-01-fro-bot-agent-s3-durable-storage-requirements.md](../brainstorms/2026-08-01-fro-bot-agent-s3-durable-storage-requirements.md)
- Related code: `packages/cli/src/commands/cliproxy/setup.ts` (+ `setup/*`), `apps/vpn/server/provision.ts`, `apps/gateway/server/provision-droplet.ts` (`ensureRunStateLifecycleRule`), `apps/broker/src/policy.ts`, `packages/cli/src/conventions.test.ts`, `.github/workflows/fro-bot.yaml`
- Institutional: `docs/solutions/workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md`, `docs/runbooks/vpn-egress-box.md`, `docs/solutions/workflow-issues/broker-first-deploy-cascade-2026-06-30.md`
- External: AWS IAM condition keys (2026-08-01), `aws-actions/configure-aws-credentials` v4, S3 lifecycle API, GitHub OIDC-in-AWS docs (see origin doc Sources for URLs)
