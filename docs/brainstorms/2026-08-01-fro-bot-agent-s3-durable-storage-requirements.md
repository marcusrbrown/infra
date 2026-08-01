---
date: 2026-08-01
topic: fro-bot-agent-s3-durable-storage
---

# Fro Bot Agent S3 Durable Storage + Generalized Agent Config Command

## Summary

Enable the `fro-bot/agent` GitHub Action's Durable Object Storage (S3) feature across the repos where Marcus runs the action, and consolidate per-repo action configuration behind a generalized `agent` CLI command. This delivers two artifacts:

1. **A generalized per-repo `agent` config command** that owns all `fro-bot/agent` action configuration — absorbing today's `cliproxy setup` model-credential wiring (`OPENCODE_AUTH_JSON`, `OPENCODE_CONFIG`, `FRO_BOT_MODEL`) and adding S3 durable-storage wiring (role ARN, bucket, region, prefix as non-secret GitHub variables). The command wires config and **verifies** the consumer workflow's storage job-split; it does not auto-edit consumer workflows and it never provisions AWS resources.
2. **A new operator-run AWS provisioner** that creates the dedicated action-state S3 bucket, the account-level GitHub OIDC provider, and one OIDC-assumable IAM role per consumer repo (per-repo S3 prefix scoping).

The action's durable storage persists OpenCode **session state** under `fro-bot-state/github/<owner-repo>/storage/...`. This is a distinct namespace from the gateway daemon's bindings/run-state (identity segment `discord`/`discord-gateway`) even though both use the same object-store adapter and `fro-bot-state` prefix root. The action never reads or writes gateway bindings. Credentials use native GitHub OIDC → AWS STS — no static AWS keys in any repo, and the credential broker is deliberately not used.

## Problem Frame

The `fro-bot/agent` action supports durable session persistence to S3 (sessions, prompt artifacts, run metadata) so that agent runs can carry state across otherwise-ephemeral CI invocations, with the GitHub Actions cache as the hot path and S3 as the canonical backend. Marcus wants this enabled in the repos where the action is deployed, but none of that infra exists today:

- No dedicated S3 bucket, GitHub OIDC provider, or IAM roles for the action.
- The infra CLI's `cliproxy setup` provisions the action's model-credential secrets/variables per repo but touches no S3/object-store config, and only *analyzes and warns* about `fro-bot.yaml` wiring — it never edits it.
- Consumer `fro-bot.yaml` workflows (including `marcusrbrown/infra`) currently declare only `contents: read`, mint no OIDC token, and run all triggers (including `pull_request`, `issue_comment`, `issues`) in a single job.

The action runs prompt-injectable, untrusted-content-influenced code (it processes issues/PRs/mentions). Any AWS credential a run can reach is reachable by injected code during that run. Durable storage adds a new risk class beyond credential exposure: durable-memory poisoning, exfiltration of prior session state, and lock manipulation that persists across runs. The design must contain blast radius per repo and must keep durable storage away from content-triggered runs.

## Actors

- A1. **`fro-bot/agent` GitHub Action** (ephemeral, per-repo CI): consumes S3 durable-storage inputs and AWS credentials from the run environment; persists OpenCode session state to S3. Pinned at `v0.96.0` in `marcusrbrown/infra` (S3 inputs available); other consumer repos require per-repo pin verification.
- A2. **Generalized `agent` CLI command** (operator-run, this repo): wires per-repo GitHub variables/secrets and verifies workflow job-split; absorbs `cliproxy setup`.
- A3. **AWS action-storage provisioner** (operator-run, holds AWS admin creds locally): creates bucket, OIDC provider, and per-repo IAM roles; never writes credentials into consumer repos.
- A4. **Consumer repo `fro-bot.yaml`** (per repo): must split a storage-enabled job (environment-gated, `id-token: write`) from content-triggered jobs (no `id-token`).
- A5. **AWS STS + IAM** (Marcus's AWS account): issues short-lived credentials via `AssumeRoleWithWebIdentity` against per-repo trust policies.
- A6. **Operator (Marcus)**: runs the provisioner and the config command, applies the workflow job-split edit, and approves any gated deploys.

## Key Flows

- F1. **Provision AWS storage foundation (operator, once + per repo)**
  - Operator runs the provisioner with local AWS admin creds → creates the dedicated action-state bucket (public-access blocked, default SSE-S3, versioning on, lifecycle rules, TLS-only policy), ensures the account-level GitHub OIDC provider exists, and creates one IAM role + scoped policy per consumer repo. Readback-verifies each resource.
  - Covered by: R1, R2, R3, R4, R11

- F2. **Configure a repo (operator, per repo)**
  - Operator runs the generalized `agent` command targeting a repo → it sets non-secret GitHub variables (role ARN, bucket, region, prefix), (re)wires the model-credential config it inherits from `cliproxy setup`, verifies the repo's `fro-bot.yaml` has the correct storage job-split, and emits a precise diff/instructions if not. It writes no AWS resources and no static AWS credentials.
  - Covered by: R5, R6, R7, R8, R12

- F3. **Storage-enabled run (schedule / workflow_dispatch@main)**
  - A scheduled or dispatched run on `main` enters the storage job (bound to the `fro-bot-storage` environment, `id-token: write`) → assumes the per-repo role via OIDC → receives short-lived STS creds → the action reads/writes only that repo's S3 prefix and coordination lock → persists session state; STS TTL exceeds run + post-action lock release.
  - Covered by: R3, R4, R9, R10

- F4. **Content-triggered run (pull_request / comment / issue)**
  - A PR/comment/issue-triggered run executes in a job with no `id-token` permission and no storage environment → cannot mint an OIDC token → runs without durable storage, exactly as today.
  - Covered by: R9, R10

## Requirements

**AWS provisioning (new provisioner)**
- R1. A dedicated S3 bucket, separate from the gateway bucket (`fro-bot-gateway-fronomenal`), holds action durable state. It has public access fully blocked, default SSE-S3 (`AES256`) encryption, versioning enabled, an enforced bucket-owner/TLS posture, and lifecycle rules (see R11). Never reuse the gateway bucket, the gateway IAM user, or gateway credentials.
- R2. An account-level GitHub OIDC provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`) exists and is created idempotently.
- R3. One IAM role per consumer repo, assumable only via `sts:AssumeRoleWithWebIdentity`. Trust policy pins audience `sts.amazonaws.com`, the environment subject `repo:<owner>/<repo>:environment:fro-bot-storage` (accepting both current legacy and immutable `sub` forms), and the AWS-supported GitHub-claim conditions `repository_id`, `repository_owner_id`, `ref` (`refs/heads/main`), and `workflow`. No `repo:<owner>/<repo>:*` wildcard. No reliance on custom-claim support that AWS lacks (AWS added `repository_id`/`repository_owner_id`/`ref`/`workflow`/`job_workflow_ref` as IAM condition keys in Jan 2026 — verified against the AWS IAM condition-keys doc). The `fro-bot-storage` GitHub Environment additionally enforces a main-only deployment-branch policy; combined with the `ref=refs/heads/main` trust condition, a `workflow_dispatch` on any non-main ref is denied at both the environment gate and the OIDC trust policy.
- R4. Each per-repo IAM policy grants only: `s3:ListBucket` constrained to that repo's prefixes; `s3:GetObject`/`s3:PutObject` on the repo's exact session-state object ARN (`<bucket>/<prefix>/github/<owner-repo>/*`); and `s3:GetObject`/`s3:PutObject`/`s3:DeleteObject` on the repo's exact coordination-lock ARN. No bucket administration, no lifecycle/policy/encryption/versioning admin, and no `s3:DeleteObjectVersion`. The coordination-lock path is separate from the session-state prefix and must be enumerated explicitly (a policy scoped only to the session prefix would break lock release, which uses object deletion). The session-state and coordination-lock key patterns are pinned to the consumer's `fro-bot/agent` action version; the provisioner fails closed and refuses to apply an IAM policy if the pinned action's key layout does not match the verified patterns — it never widens access to keep a mismatched layout working.
- R11. Retention/lifecycle is provisioner-owned: session state expires after ~90 days of inactivity, per-run metadata/artifacts after ~30 days, and noncurrent object versions after ~30 days; incomplete multipart uploads abort after a short period. The action does not uniformly tag objects by retention class, so retention that must distinguish object categories may require per-repo prefix rules or an upstream tagging change — this is called out as a plan-time detail. Retention is activity-based and therefore does not bound state an injected run keeps actively touching; the durable-memory-poisoning threat is contained by per-repo isolation and the content-run storage exclusion, not by lifecycle expiry. An independent maximum object lifetime and a lock/noncurrent-version quota to cap malicious churn are a plan-time hardening to evaluate, not assumed solved by the inactivity rules.

**Per-repo configuration command (generalized `agent`)**
- R5. A generalized per-repo `agent` config command owns all `fro-bot/agent` action configuration. It absorbs the current `cliproxy setup` behavior (model-credential secrets/variables and workflow analysis) and adds S3 durable-storage configuration. `cliproxy setup` continues to work for existing users (thin alias or migration path); no current setup behavior or test regresses. The compatibility contract is explicit: `cliproxy setup` keeps performing model-credential wiring unchanged; S3 durable storage is additive and opt-in; and the new workflow-split verifier gates only repos that opt into storage — a repo that does not enable storage is never rejected or blocked by the storage checks, and no repo is left partially migrated.
- R6. The command writes S3 configuration as non-secret GitHub **variables** (role ARN, bucket, region, prefix, expected-bucket-owner). It never writes static AWS access keys or secrets into a consumer repo, and it refuses static-credential configuration by default.
- R7. The command **verifies** the consumer `fro-bot.yaml` storage job-split and reports a precise diff/instructions when the workflow is non-compliant. It does not auto-edit consumer workflows. Compliance means: a storage-enabled job bound to the `fro-bot-storage` environment with `id-token: write`; content-triggered execution (pull_request/comment/issue) in a separate job without `id-token`; and a compatible SHA-pinned `fro-bot/agent` action version exposing the S3 inputs. Verification resolves the effective job graph, not just local YAML shape: it confirms the concrete trigger→job→permissions/environment matrix, confirms `id-token` is not granted workflow-wide or to any shared/matrix job reachable by content triggers, and rejects routing the storage job through a reusable workflow (job-level `uses:`) unless that called workflow is SHA-pinned and separately verified — because a reusable-workflow call changes `job_workflow_ref` and the effective OIDC boundary.
- R8. The command verifies the AWS resources for the target repo already exist (provision-first, wire-second) and fails closed with actionable guidance if they do not. It wires the action's S3 inputs (`s3-backup`, `s3-bucket`, `aws-region`, `s3-prefix`, `s3-expected-bucket-owner`, SSE mode) through the verified workflow contract.
- R12. The command is fleet-ready: it operates on a named target repo and its abstractions (per-repo role ARN, per-repo prefix) support N repos, but the initial rollout targets and verifies `marcusrbrown/infra` alone as the proving ground. Additional repos onboard incrementally through the same command once the pattern is proven live.

**Workflow security model (verified, not auto-applied)**
- R9. Durable storage is available only to storage-enabled runs — `schedule` and `workflow_dispatch` on `main` bound to the `fro-bot-storage` environment. `pull_request`, `pull_request_review_comment`, `issue_comment`, `discussion_comment`, and `issues` runs must not have durable storage.
- R10. `id-token: write` is granted only at the storage job level, never workflow-wide. Content-triggered jobs have no `id-token` permission so injected code cannot mint an OIDC token. The storage job carries an explicit whole-job timeout, and the STS session duration exceeds run time plus post-action persistence/lock-release headroom (the current workflow passes `timeout: 0`, which must be replaced with an explicit cap).
- R13. The provisioner and config command validate the consumer repo's GitHub OIDC subject configuration and fail closed unless it matches the approved subject form the trust policy was built for. A repo carrying a custom `sub` template, or a transition to the immutable-subject form the policy was not built for, is not silently trusted — it requires an explicit re-verification/rotation step before storage is enabled or the trust policy is updated to match.
- R14. The storage job's OIDC trust boundary is re-verified whenever its inputs change: the storage job must not be refactored into or behind a reusable workflow, and the action pin must not change its S3 key layout or emitted claim shape, without a re-verification pass that reads the live OIDC claims from the pinned workflow shape and fails closed on mismatch.

## Acceptance Examples

- AE1. **Covers R1, R3, R4.** Given the provisioner runs against a clean account, when it completes, then a dedicated action-state bucket exists (separate from the gateway bucket, SSE-S3, versioning on, public access blocked), the GitHub OIDC provider exists, and a per-repo role exists whose policy grants object access only to that repo's prefix plus its coordination lock and denies `DeleteObjectVersion`.
- AE2. **Covers R9, R10.** Given a repo configured for storage, when a `pull_request`-triggered run executes, then it runs in a job with no `id-token` permission, cannot assume the AWS role, and completes without durable storage — behaviorally identical to today.
- AE3. **Covers R3, R9.** Given a repo configured for storage, when a `schedule` run on `main` executes in the `fro-bot-storage` environment job, then it assumes the per-repo role via OIDC, receives short-lived STS credentials, and the action persists session state to only that repo's S3 prefix.
- AE4. **Covers R3, R4.** Given repo A's storage job, when it attempts to read repo B's prefix or the gateway bucket, then it receives `AccessDenied`.
- AE5. **Covers R6, R7.** Given the `agent` command runs against a repo whose `fro-bot.yaml` lacks the job-split, when it finishes, then it has written the non-secret S3 variables, written no static AWS credentials, and emitted a precise diff describing the required storage job-split without modifying the workflow file.
- AE6. **Covers R5.** Given an existing user of `cliproxy setup`, when they run the new generalized `agent` command with no S3 options, then the model-credential wiring behaves exactly as `cliproxy setup` does today.
- AE7. **Covers R8.** Given the `agent` command is asked to wire a repo before the AWS role/bucket exist, when it runs, then it fails closed with guidance to run the provisioner first and wires nothing.
- AE8. **Covers R13.** Given a consumer repo whose GitHub OIDC config carries a custom `sub` template or has switched to the immutable-subject form the trust policy was not built for, when the provisioner or command runs, then it fails closed and requires explicit re-verification before enabling storage rather than silently proceeding.
- AE9. **Covers R7, R14.** Given a `fro-bot.yaml` that is locally shape-compliant but routes the storage job through an unpinned reusable workflow, when the verifier runs, then it rejects the workflow as non-compliant rather than greenlighting it.

## Success Criteria

- Durable storage works end-to-end on `marcusrbrown/infra` for scheduled/dispatched runs (session state persists and restores from S3), verified by a forced cache miss restoring from S3.
- No static AWS credentials exist in any consumer repo; all AWS access is short-lived STS via OIDC.
- Content-triggered runs (PR/comment/issue) provably cannot obtain AWS credentials or durable storage.
- Cross-repo isolation holds: repo A cannot access repo B's state or the gateway bucket (AccessDenied verified).
- The generalized `agent` command fully replaces `cliproxy setup`'s responsibilities with no regression to existing model-credential provisioning behavior or tests.
- The gateway's bucket, IAM user, bindings, and run-state lifecycle are untouched.

## Scope Boundaries

- No changes to the gateway provisioner, gateway bucket, gateway IAM user, or gateway bindings/run-state. Action storage is a separate bucket and separate roles.
- No management of gateway "bindings" — those are gateway runtime control-plane state created via `/fro-bot add-project`, not per-repo config.
- No use or extension of the credential broker for AWS credentials. Native GitHub OIDC → STS only.
- The `agent` command does not auto-edit consumer `fro-bot.yaml` workflows (verify + diff only) and does not create AWS resources (the provisioner owns those).
- No static AWS access keys written to any consumer repo.
- No durable storage for content-triggered (`pull_request`/comment/issue) runs.
- No custom GitHub `sub` customization (`PUT .../actions/oidc/customization/sub`); the environment-scoped subject plus AWS-supported claim conditions are sufficient.
- Initial rollout is `marcusrbrown/infra` only; full-fleet enablement is incremental follow-on via the same command, not part of the first pass.
- First pass implements the per-repo abstraction shape (per-repo role ARN, per-repo prefix) but adds no multi-repo onboarding automation, repo-inventory loop, or generic provider plumbing — fleet enablement stays operator-driven, one repo at a time, through the same command.

### Deferred to Separate Tasks

- Onboarding additional consumer repos beyond `marcusrbrown/infra`: incremental, via the same command, after the pattern is proven live.
- Category-specific S3 retention (distinguishing session vs metadata vs lock objects) if it requires an upstream `fro-bot/agent` object-tagging change: separate upstream coordination.
- Any KMS/customer-managed-key requirement: only if a concrete key-level revocation/compliance need emerges (SSE-S3 is the baseline).

## Key Decisions

- **Dedicated bucket + per-repo OIDC role, native OIDC (no broker).** Prompt injection can still abuse a repo's own legitimate S3 capability during a run, but cannot reach other repos or gateway control-plane state; stolen STS credentials expire without rotation work. Per-repo buckets add marginal isolation inside one AWS account while multiplying policies/lifecycle/drift — rejected. Static keys rejected (durable theft, rotation burden). Broker rejected: it would add a high-value AWS authority and a network/deploy dependency without preventing same-job injection from obtaining credentials.
- **Environment-scoped OIDC subject, content-triggered runs excluded from storage.** Gating storage behind a `fro-bot-storage` environment (only `schedule`/`workflow_dispatch@main`) and withholding `id-token` from content-triggered jobs is a stronger boundary than matching a default-branch subject, because several comment/issue events also run against the default branch. This sidesteps both the weak `:pull_request` subject and durable-memory poisoning by untrusted content. Fork-token withholding is treated as defense-in-depth, not the boundary.
- **AWS can pin GitHub claims (verified).** AWS IAM trust policies support `token.actions.githubusercontent.com:repository_id`/`repository_owner_id`/`ref`/`workflow`/`job_workflow_ref` (added Jan 2026 per the AWS IAM condition-keys doc). GitHub's "custom claims unavailable in AWS" documentation is stale. This lets the trust policy add claim-based hardening on top of the environment subject. (`job_workflow_ref` is absent here because the workflow invokes an action, not a reusable workflow — not used.)
- **SSE-S3 over KMS.** The storage role must decrypt its own sessions, so KMS cannot contain this threat; a shared CMK adds cost/coupling without cross-repo isolation. SSE-S3 is the baseline; CMK only for a concrete future requirement.
- **Generalized `agent` command absorbing `cliproxy setup`.** S3 durable storage and the CLIProxy model credential share only "per-repo `fro-bot/agent` action config"; that shared concept is the right home. Bolting S3 onto the cliproxy-named command is semantically wrong.
- **Provision-first, wire-second, verify-not-mutate.** AWS resource creation lives in a new operator-run provisioner; the per-repo command wires non-secret variables and verifies the workflow job-split, keeping structural workflow edits in the operator's reviewable control.
- **Durable storage serves scheduled/dispatched session continuity, not content-triggered runs.** The feature's value here is state carried across `schedule`/`workflow_dispatch@main` runs; excluding `pull_request`/comment/issue runs is a deliberate security boundary (those are the untrusted-content entry points), accepted as narrowing the feature rather than treated as a gap. A read-only/session-recovery mode for content-triggered runs is a possible future exploration, explicitly out of scope now.

## Dependencies / Assumptions

- Marcus's AWS account with operator-local admin credentials for provisioning (never the gateway data-plane key). The specific account ID, region, and globally-unique bucket name are decided at provision time.
- `fro-bot/agent` action pin per consumer repo must expose the S3 inputs (`marcusrbrown/infra` is at `v0.96.0`, which does; other repos verified individually before onboarding).
- `marcusrbrown/infra` real identifiers (from the live GitHub API): `repository_id` `1200110668`, `repository_owner_id` `831617`, default branch `main`, current OIDC `use_default: true` / `use_immutable_subject: false`.
- The action's S3 key layout (`{prefix}/github/<owner-repo>/storage/...` plus a separate `coordination/.../locks/` path) is taken from the pinned action source; the exact coordination-lock key must be re-confirmed against the pinned version at plan time, since an upstream key-layout change should fail IAM closed until reviewed.
- harden-runner (or equivalent egress control) on storage jobs must allow the exact OIDC, STS, and regional S3 endpoints without reopening arbitrary egress.
- `marcusrbrown/infra`'s current `fro-bot.yaml` is a single job with `contents: read` and no OIDC token — the first rollout step is the operator applying the storage job-split (per the verifier's emitted diff, R7) before the repo can be wired. The repo is not in a wire-ready state until then.

## Outstanding Questions

### Deferred to Planning

- Exact IAM policy ARNs and the confirmed coordination-lock key path at the pinned action version.
- The precise `fro-bot.yaml` job-split shape the verifier checks for and the diff it emits (single workflow with two jobs vs separate workflows).
- Command surface details: exact command name/subcommands under `agent`, flags, interactive vs non-interactive parity with today's `cliproxy setup`, and the `cliproxy setup` alias/migration mechanics.
- Provisioner shape: filename/pattern (`server/provision*.ts`), idempotency/readback approach, and how the per-repo role loop is driven (repo inventory input).
- Whether the OIDC-config precheck (`use_default`/`use_immutable_subject`) needs to fail closed when a repo already has a custom `sub` template.
- Explicit whole-job timeout value and STS session-duration value.
- Whether attacker-writable durable objects need an independent maximum lifetime and a lock/noncurrent-version quota beyond activity-based retention (R11).

## Sources / Research

- <https://github.com/fro-bot/agent#durable-object-storage-s3> — action durable storage feature.
- `fro-bot/agent` `action.yaml` — S3 inputs (`s3-backup`, `s3-bucket`, `aws-region`, `s3-endpoint`, `s3-prefix` default `fro-bot-state`, `s3-expected-bucket-owner`, `s3-allow-insecure-endpoint`, `s3-sse-encryption`, `s3-sse-kms-key-id`); credentials via env (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/optional `AWS_SESSION_TOKEN`).
- `apps/gateway/src/deploy.ts`, `apps/gateway/server/provision-droplet.ts`, `apps/gateway/AGENTS.md` — gateway object-store contract (`S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `OBJECT_STORE_HOSTS`), run-state 30-day lifecycle, and the gateway bindings namespace (`fro-bot-state/discord-gateway/...`).
- `packages/cli/src/commands/cliproxy/setup.ts`, `setup/templates.ts`, `setup/gh.ts`, `setup/validation.ts` — current per-repo action config command (secrets/variables via `gh`, `@clack/prompts`, `HarnessTemplate` abstraction, workflow analysis).
- `apps/broker/src/policy.ts`, `apps/broker/src/oidc.ts` — real verified `fro-bot/agent` OIDC claims and the `job_workflow_ref`-vs-`workflow_ref` distinction (broker does its own JWT verification, unlike native AWS trust policies).
- `.github/workflows/fro-bot.yaml` — this repo's trigger set, `contents: read`-only permissions, `fro-bot/agent@v0.96.0` pin, `timeout: 0`.
- AWS IAM User Guide "IAM and AWS STS condition context keys" (last-modified 2026-08-01) + AWS "What's New" (2026-01-01) — GitHub-claim IAM condition-key support (`repository_id`, `repository_owner_id`, `ref`, `workflow`, `job_workflow_ref`).
- GitHub Docs "About security hardening with OpenID Connect" / "Configuring OpenID Connect in Amazon Web Services" — `sub` formats per trigger (`repo:OWNER/REPO:pull_request`, `...:environment:NAME`, `...:ref:refs/heads/BRANCH`); the "custom claims unavailable in AWS" line is stale.
- `aws-actions/configure-aws-credentials` README — immutable `sub` example and claim-support note.
