# Agent S3 Durable Storage

This runbook covers provisioning, protected-environment setup, repository wiring, workflow rollout, live verification, monitoring, rollback, and teardown for `fro-bot/agent` durable S3 storage. The provisioner is operator-run and creates AWS resources; the `agent` CLI configures GitHub and verifies the consumer workflow. It does not edit the consumer workflow automatically, and no deploy pipeline is part of this operation.

For package-level details, see [`apps/agent/AGENTS.md`](../../apps/agent/AGENTS.md).

---

## Security model

Durable storage is intentionally available only to trusted scheduled or manually dispatched runs on `main`. The storage job is protected by the `fro-bot-storage` GitHub Environment and receives `id-token: write` at job level. Pull-request, comment, issue, discussion, `pull_request_target`, and `workflow_run` paths remain content-triggered paths with no OIDC token and no AWS storage access.

The workflow uses native GitHub OIDC → AWS STS. No static AWS credentials are written to the repository. Each consumer repository has its own IAM role and delimiter-bounded S3 prefix. The dedicated bucket is separate from the gateway bucket. The session prefix cannot be deleted by the storage role, and object version deletion is denied. This limits cross-repository access and reduces the impact of prompt-injected content, but it does not make untrusted content safe to run with AWS credentials; the content job must remain outside the storage path.

---

## Prerequisites

Before provisioning:

1. Install and authenticate the AWS CLI and GitHub CLI on the operator machine. The provisioner and storage readback use dedicated `AGENT_AWS_*` variables; `agent storage` ignores ambient AWS identities and runs `aws` with a restricted child environment. `aws` must be available on `PATH`.
2. Create dedicated AWS provisioning credentials with only the IAM and S3 permissions required by the provisioner. Do not use the gateway's S3 credentials and do not rely on ambient `AWS_*` credentials for provisioning.
3. Seed the repository-root `.env` with the dedicated operator credentials and provisioner inputs:

   ```bash
   AGENT_AWS_ACCESS_KEY_ID=<dedicated-access-key>
   AGENT_AWS_SECRET_ACCESS_KEY=<dedicated-secret-key>
   # AGENT_AWS_SESSION_TOKEN=<optional-session-token>
   # AGENT_AWS_REGION=us-east-1
   AGENT_S3_BUCKET=<dedicated-bucket-name>
   AGENT_S3_EXPECTED_BUCKET_OWNER=<twelve-digit-account-id>
   AGENT_S3_PREFIX=fro-bot-state/
   AGENT_REPOSITORY_OWNER=marcusrbrown
   AGENT_REPOSITORY_NAME=infra
   AGENT_REPOSITORY_ID=<live-repository-id>
   AGENT_REPOSITORY_OWNER_ID=<live-owner-id>
   AGENT_WORKFLOW_NAME=<workflow-name>
   AGENT_ACTION_REF=fro-bot/agent@v0.96.0
   ```

   `AGENT_AWS_SESSION_TOKEN`, `AGENT_AWS_REGION`, `AGENT_S3_SESSION_PREFIX`, and `AGENT_S3_METADATA_ARTIFACTS_PREFIX` are optional. The provisioner defaults the region to `us-east-1` and derives the verified action key layout from the root prefix unless explicit prefixes are supplied.

4. Confirm that the action ref is the verified key-layout version. The current admitted layout is `fro-bot/agent@v0.96.0`; an unknown ref fails closed.

The `AGENT_*` values are operator-local. They are not GitHub Environment values, workflow secrets, or repository variables.

---

## Corrected rollout sequence

The order is significant. GitHub auto-creates an environment without protection when a workflow first references it, so the environment must exist and be protected before the workflow change is applied.

### 1. Provision AWS

Run the root wrapper from the repository root:

```bash
bun run provision:agent
```

The provisioner converges, with readback verification, on:

- the account-level GitHub OIDC provider with the `sts.amazonaws.com` audience;
- the dedicated S3 bucket with public-access block, versioning, SSE-S3, non-TLS denial, and owned lifecycle rules;
- the repository-scoped IAM role and policy; and
- the handoff manifest printed as one compact JSON line.

Save the manifest to a local operator-controlled file, for example:

```bash
bun run provision:agent > handoff.json
```

If the bucket or role has managed drift, the default behavior is warn-and-halt. Review the diff and use `--force` only to reapply the canonical managed state:

```bash
bun run provision:agent -- --force
```

Foreign or shared-resource drift is never overridden by `--force`.

### 2. Pre-create the protected GitHub Environment

Before any workflow references the environment, create `fro-bot-storage` in the consumer repository with:

- at least one required reviewer; and
- a custom deployment-branch policy containing exactly `main`.

Verify both the environment protection rule and the deployment-branch policy. Do not rely on the workflow's first reference to create the environment.

### 3. Wire the repository variables

Run the storage command with the saved manifest:

```bash
bunx @marcusrbrown/infra agent storage \
  --repo marcusrbrown/infra \
  --manifest handoff.json
```

The command performs fail-closed checks before writing any S3 variable:

- the manifest's owner, repository, repository ID, and owner ID match live GitHub metadata;
- the IAM role and S3 bucket exist, have the expected owner, and have the manifest's region;
- the repository uses the approved default OIDC subject configuration;
- static AWS credential options are absent; and
- the workflow and protected environment satisfy the storage contract.

The AWS readback requires `AGENT_AWS_ACCESS_KEY_ID` and `AGENT_AWS_SECRET_ACCESS_KEY`; `AGENT_AWS_SESSION_TOKEN` and `AGENT_AWS_REGION` are optional. Credential bytes are never placed in AWS argv, error text, logs, or repository values. If any precheck or workflow verification fails, no repository variables are written.

After all checks pass it writes exactly these non-secret repository variables:

| Variable                           | Value                            |
| ---------------------------------- | -------------------------------- |
| `FRO_BOT_S3_ROLE_TO_ASSUME`        | Manifest `role_arn`              |
| `FRO_BOT_S3_BUCKET`                | Manifest `bucket`                |
| `FRO_BOT_S3_REGION`                | Manifest `bucket_region`         |
| `FRO_BOT_S3_PREFIX`                | Manifest `s3_prefix`             |
| `FRO_BOT_S3_EXPECTED_BUCKET_OWNER` | Manifest `expected_bucket_owner` |

If the workflow is not yet compliant, the command reports the violations and emits a pasteable diff; it does not modify the workflow. Apply the diff and rerun the storage command to complete verification.

### 4. Apply the `fro-bot.yaml` job split

The operator applies the verifier's diff to `.github/workflows/fro-bot.yaml`. The required effective job graph is:

- a storage-capable job bound to `fro-bot-storage`;
- job-level `permissions: id-token: write` on that storage job only;
- storage reachability limited to `schedule` and `workflow_dispatch` where `github.ref == 'refs/heads/main'`;
- content-triggered jobs with no `id-token` permission and no storage environment;
- no workflow-level `id-token` permission or `write-all` permissions;
- no `needs:` or artifact/cache/output handoff from a content-reachable job into the storage job;
- a SHA-pinned `fro-bot/agent` action with all five S3 inputs wired from the `FRO_BOT_S3_*` variables; and
- no unverified job-level reusable-workflow indirection for the storage job.

The storage job must also have an explicit positive `timeout-minutes` value. Replace `timeout: 0`; an unbounded job is not an acceptable storage contract. The `aws-actions/configure-aws-credentials` step must request `role-duration-seconds` of at least `7200`, and its `role-session-name` must include the GitHub run ID (and attempt when available) for CloudTrail attribution.

The storage job's harden-runner or equivalent egress policy must allow only:

- GitHub's OIDC endpoint;
- AWS STS; and
- the regional S3 endpoint for the provisioned bucket.

It must not reopen arbitrary outbound egress. Action references in workflow files use `.yaml` files and immutable SHA pins with version comments.

### 5. Run the verifier again

Rerun the storage command after applying the workflow edit:

```bash
bunx @marcusrbrown/infra agent storage \
  --repo marcusrbrown/infra \
  --manifest handoff.json
```

The verifier reads both the workflow YAML and the live GitHub Environment policy. It must report workflow YAML compliant and GitHub Environment policy verified.

### 6. Dispatch and approve

Dispatch `fro-bot.yaml` on `main`, then approve the `fro-bot-storage` environment deployment. Do not use a pull-request, comment, issue, discussion, `pull_request_target`, or `workflow_run` event for the first storage probe.

### 7. Live-verify

Run the Go/No-Go probes below. Do not onboard a second repository until every probe passes for `marcusrbrown/infra`.

---

## Handoff manifest shape

The provisioner emits a JSON object with these fields:

```text
owner, repo, repository_id, repository_owner_id,
bucket, bucket_region, expected_bucket_owner,
s3_prefix, session_prefix, lock_key,
role_name, role_arn, policy_name,
action_ref_verified, key_layout_version, oidc_provider_arn
```

The CLI consumes the manifest for identity/resource checks and variable wiring. Teardown uses the same manifest and refuses to act if the role identity or shared resource readback does not match.

---

## Go/No-Go checklist

Proceed only if every item is verified:

### AWS and trust

- [ ] The GitHub OIDC provider was read back without recreation.
- [ ] `sts.amazonaws.com` is present; existing thumbprints and unrelated audiences are unchanged.
- [ ] The bucket is not the gateway bucket.
- [ ] Public-access-block has all four settings enabled.
- [ ] Versioning is `Enabled` and encryption is `AES256`.
- [ ] Non-TLS requests are denied.
- [ ] The per-repo role trust pins the `fro-bot-storage` environment subject, live `repository_id`, live `repository_owner_id`, `refs/heads/main`, and the expected workflow; it emits no wildcard repository subject.
- [ ] For `marcusrbrown/infra`, the live repository ID is `1200110668` and the owner ID is `831617`; the handoff manifest matches both values. If GitHub identity changes, use live API readback rather than retaining stale values.
- [ ] End-to-end OIDC → STS succeeds with a session name containing the run ID.

### Workflow and storage behavior

- [ ] `fro-bot-storage` has a required reviewer and an exact main-only branch policy.
- [ ] The storage job has job-level `id-token: write`, an explicit positive `timeout-minutes`, and no content-trigger reachability.
- [ ] The STS role duration is at least 7200 seconds.
- [ ] The storage job has no artifact/cache/output handoff from a content-reachable job.
- [ ] A forced cache miss restores session state from S3.
- [ ] Writes land only under `<prefix>/github/<owner-repo>/storage/...` (for this rollout, `<prefix>/github/marcusrbrown-infra/storage/...`).
- [ ] Lock acquire and release complete, leaving no stale lock.
- [ ] Content-triggered execution has no `id-token`, no AWS environment, no available OIDC token, and no durable storage; its behavior matches the pre-storage path.

### Negative probes

Each operation below must fail closed:

- [ ] Wrong `s3-expected-bucket-owner`.
- [ ] Read of another repository's prefix.
- [ ] Read or write of the gateway bucket.
- [ ] Delete of a session object.
- [ ] Delete of an object version.
- [ ] Anonymous or public read.
- [ ] Setting a public ACL.

Any failed negative probe is a No-Go. Disable the environment and follow [Rollback](#rollback) before investigating further.

---

## Retention semantics

Lifecycle expiry is based on S3 last-modified time, not read activity. The action writes through session state on a storage-enabled run, so session retention is documented as write-through-based inactivity. The provisioner-owned baseline is:

- session state: approximately 90 days;
- metadata/artifacts: approximately 30 days;
- noncurrent object versions: approximately 30 days; and
- incomplete multipart uploads: approximately 7 days.

These rules do not limit state that an active writer continually refreshes. The security boundary is per-repository IAM isolation and exclusion of content runs, not lifecycle expiry.

---

## Monitoring for the first 24 hours

Check at approximately +1 hour, +4 hours, and +24 hours. Alert and stop rollout if any of the following occurs:

- an unexpected `AssumeRoleWithWebIdentity` failure;
- S3 access outside the repository prefix;
- AWS credential presence in a content-triggered job;
- a lock object older than the job timeout plus grace period;
- unexpected growth of noncurrent object versions;
- any public-access finding on the bucket; or
- lifecycle configuration drift.

Use CloudTrail, GitHub Actions job logs, S3 access logs or equivalent AWS audit data, and the provisioner's readback/audit helpers. Do not log OIDC tokens, AWS session credentials, or secret values.

---

## Rollback

### Provisioned, workflow unchanged

Do not wire the repository. Audit the manifest and AWS resources, then remove the repository-scoped role, inline policy, and coordination lock. Retain the shared bucket and OIDC provider:

```bash
bunx @marcusrbrown/infra agent storage teardown \
  --repo OWNER/REPO \
  --manifest handoff.json
```

Use `--purge-state` only when the session objects should not be retained.

### Workflow changed, verification failed

1. Revert the workflow split or disable the S3 inputs.
2. Run `agent storage teardown` to remove the five S3 variables and the repository-scoped AWS resources.
3. Confirm content jobs still run without storage.
4. Remove any stale coordination lock after confirming no storage run is active.

### Credential-boundary violation

If a content job received `id-token`, cross-repository or gateway access succeeded, or version deletion succeeded:

1. Disable the `fro-bot-storage` environment and stop dispatches.
2. Revert the workflow split and remove the five repository variables.
3. Detach and delete the repository role and inline policy.
4. Preserve affected objects for forensics; do not purge them during the first response.
5. Review CloudTrail and GitHub Actions logs from storage enablement onward.
6. Correct the trust policy, workflow verifier, or egress policy and repeat the complete Go/No-Go checklist before re-enabling storage.

---

## Routine teardown

The CLI teardown unwires only the five `FRO_BOT_S3_*` variables and leaves model credential configuration untouched. It then calls the provisioner teardown for the matching manifest:

```bash
# Preview; retains state by default
bunx @marcusrbrown/infra agent storage teardown \
  --repo OWNER/REPO --manifest handoff.json --plan

# Remove role, policy, lock, and variables; retain session objects
bunx @marcusrbrown/infra agent storage teardown \
  --repo OWNER/REPO --manifest handoff.json

# Explicitly purge versioned session state as part of teardown
bunx @marcusrbrown/infra agent storage teardown \
  --repo OWNER/REPO --manifest handoff.json --purge-state
```

The operation is idempotent and order-tolerant. It preserves the shared S3 bucket and account-level GitHub OIDC provider. Re-run after a partial failure.

---

## Related commands

| Command | Purpose |
| --- | --- |
| `bun run provision:agent` | Create or verify AWS OIDC, bucket, role, and policy; print manifest |
| `bun run provision:agent -- --force` | Reapply managed drift after review |
| `bunx @marcusrbrown/infra agent setup` | Configure model credentials; generalized replacement for `cliproxy setup` |
| `bunx @marcusrbrown/infra agent storage --repo OWNER/REPO --manifest handoff.json` | Preflight, wire non-secret S3 variables, and verify workflow/environment |
| `bunx @marcusrbrown/infra agent storage teardown --repo OWNER/REPO --manifest handoff.json` | Unwire variables and remove repo-scoped storage resources |

All `agent` setup/storage commands are mutating or environment-sensitive and are CLI-only; they are excluded from the MCP allowlist.
