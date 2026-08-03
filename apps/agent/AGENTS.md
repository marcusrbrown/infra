# Agent S3 Durable Storage Provisioner

The agent package is a private, operator-run AWS provisioner for `fro-bot/agent` durable session storage. It creates and verifies a dedicated S3 bucket, the account-level GitHub Actions OIDC provider, and one least-privilege IAM role and inline policy per consumer repository. It does not deploy an application, publish a package, or write AWS credentials to a GitHub repository.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Provision / teardown entrypoint | `server/provision.ts` | IAM + S3 convergence, readback verification, handoff manifest, teardown flags |
| Action key layout | `src/key-layout.ts` | Version-pinned S3 session and coordination-lock paths; unknown layouts fail closed |
| Provisioner tests | `server/provision.test.ts` | Mocked IAM/S3 boundary tests, drift handling, teardown safety |
| Key-layout tests | `src/key-layout.test.ts` | Canonical prefix and fail-closed layout contract |
| CLI wiring | `../../packages/cli/src/commands/agent/` | GitHub variable wiring, OIDC/resource prechecks, workflow verification |

## SECURITY BOUNDARY

- Provisioning credentials are dedicated operator-local credentials. The provisioner accepts `AGENT_AWS_ACCESS_KEY_ID` and `AGENT_AWS_SECRET_ACCESS_KEY` (plus the optional `AGENT_AWS_SESSION_TOKEN`) and deliberately ignores ambient `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` values.
- The provisioner uses native GitHub OIDC → AWS STS. No static AWS credential is written to a consumer repository.
- The bucket is separate from the gateway bucket. Each repository receives its own role and prefix-scoped policy; the session prefix has an explicit delete deny and the coordination lock is a separate exact object ARN.
- Content-triggered jobs must not reach the storage job. Only the protected `fro-bot-storage` environment on scheduled or main-branch dispatched runs may receive `id-token: write`.

## PROVISIONER INPUTS

Run the provisioner from the repository root so Bun loads the root `.env`. The following values are operator-local and must never be copied into a GitHub Environment or committed:

| Variable | Required | Description |
| --- | --- | --- |
| `AGENT_AWS_ACCESS_KEY_ID` | ✓ | Dedicated AWS provisioning access key |
| `AGENT_AWS_SECRET_ACCESS_KEY` | ✓ | Dedicated AWS provisioning secret |
| `AGENT_AWS_SESSION_TOKEN` | — | Optional session token for the dedicated credentials |
| `AGENT_AWS_REGION` | — | AWS SDK region; defaults to `us-east-1` |
| `AGENT_S3_BUCKET` | ✓ | Dedicated action-state bucket name |
| `AGENT_S3_EXPECTED_BUCKET_OWNER` | ✓ | Twelve-digit AWS account owner ID |
| `AGENT_S3_PREFIX` | ✓ | Canonical root prefix, without wildcard characters |
| `AGENT_S3_SESSION_PREFIX` | — | Optional explicit session prefix override |
| `AGENT_S3_METADATA_ARTIFACTS_PREFIX` | — | Optional metadata/artifacts prefix override |
| `AGENT_REPOSITORY_OWNER` | ✓ | GitHub repository owner |
| `AGENT_REPOSITORY_NAME` | ✓ | GitHub repository name |
| `AGENT_REPOSITORY_ID` | ✓ | Live GitHub repository ID |
| `AGENT_REPOSITORY_OWNER_ID` | ✓ | Live GitHub owner ID |
| `AGENT_WORKFLOW_NAME` | ✓ | Workflow name pinned in the IAM trust policy |
| `AGENT_ACTION_REF` | ✓ | Verified `fro-bot/agent` ref; the current admitted layout is `fro-bot/agent@v0.96.0` |

The `AGENT_S3_SESSION_PREFIX` and `AGENT_S3_METADATA_ARTIFACTS_PREFIX` values are optional inputs. The provisioner otherwise derives the action layout from `AGENT_S3_PREFIX` and the verified action ref. It refuses unknown or unverified layouts rather than widening IAM access.

## PROVISIONING FLOW

1. Install the AWS CLI and GitHub CLI locally. The AWS CLI is also required by `agent storage` for provision-first resource readback; storage passes dedicated `AGENT_AWS_*` credentials through a restricted child environment and ignores ambient `AWS_*` values.
2. Create the dedicated AWS credentials and seed the root `.env` with the `AGENT_*` values above.
3. Run the root wrapper:

   ```bash
   bun run provision:agent
   ```

   The wrapper invokes `apps/agent/server/provision.ts`. It discovers or creates the account-level `token.actions.githubusercontent.com` OIDC provider, appending the `sts.amazonaws.com` audience without recreating or changing existing thumbprints or audiences. It then verifies or creates the bucket, applies the managed S3 controls, creates or verifies the repository role and policy, and readback-verifies the result.

4. Save the single compact JSON line printed by the provisioner as the handoff manifest. Treat it as operator configuration: it contains identifiers and resource names, but never credential bytes.

Managed drift is reported and halts by default. Re-run with `--force` only after reviewing the reported difference:

```bash
bun run provision:agent -- --force
```

Foreign or shared-resource drift remains a hard stop even with `--force`.

### Handoff manifest

The emitted JSON object has this shape:

```json
{
  "owner": "OWNER",
  "repo": "REPO",
  "repository_id": "...",
  "repository_owner_id": "...",
  "bucket": "BUCKET",
  "bucket_region": "REGION",
  "expected_bucket_owner": "ACCOUNT_ID",
  "s3_prefix": "fro-bot-state/",
  "session_prefix": "fro-bot-state/github/OWNER/REPO/",
  "lock_key": "fro-bot-state/coordination/OWNER/REPO/locks/repo.json",
  "role_name": "fro-bot-agent-storage-OWNER-REPO",
  "role_arn": "arn:aws:iam::ACCOUNT_ID:role/ROLE",
  "policy_name": "POLICY",
  "action_ref_verified": true,
  "key_layout_version": "fro-bot/agent@v0.96.0",
  "oidc_provider_arn": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
}
```

The exact owner/repository IDs, bucket region, role ARN, and key paths must come from the emitted manifest and live readback; operators must not hand-edit them.

## CLI COMMAND FLOW

`agent setup` owns the model-credential onboarding previously exposed as `cliproxy setup`. It supports the same model-credential options, including `--repo`, `--harness`, `--key`, `--providers`, `--model`, `--force`, `--dry-run`, `--verify-smoke`, and `--ack-key-reuse`. The legacy `cliproxy setup` command remains a compatibility wrapper over the shared implementation. `agent setup` does not create AWS resources and does not modify the consumer workflow.

Durable storage is explicit and uses the handoff manifest:

```bash
bunx @marcusrbrown/infra agent storage \
  --repo OWNER/REPO \
  --manifest handoff.json
```

The command verifies live repository identity, the provisioned IAM role and S3 bucket, the repository OIDC subject, and the effective workflow/environment contract before writing only the five non-secret `FRO_BOT_S3_*` variables. AWS readback requires `AGENT_AWS_ACCESS_KEY_ID` and `AGENT_AWS_SECRET_ACCESS_KEY`; ambient `AWS_*` values are ignored. A failed workflow check emits a pasteable diff and never edits the workflow; apply the diff manually and rerun the command.

The storage teardown command removes those five variables and invokes the repository-scoped provisioner teardown:

```bash
bunx @marcusrbrown/infra agent storage teardown \
  --repo OWNER/REPO \
  --manifest handoff.json
```

The default is to retain session objects. Add `--purge-state` to remove them, or `--plan` for a readback-only preview. Both storage commands reject static AWS credential options. The storage preflight requires the local `aws` CLI.

## AWS RESOURCE CONTRACT

The provisioner owns these controls:

- S3 public-access-block with all four settings enabled.
- S3 versioning enabled and SSE-S3 (`AES256`) encryption.
- A bucket policy denying non-TLS requests.
- Owned lifecycle rules `fro-bot-agent-session-90d`, `fro-bot-agent-metadata-30d`, `fro-bot-agent-noncurrent-30d`, and `fro-bot-agent-abort-mpu-7d`. Unrelated lifecycle rules are preserved.
- An IAM role with a maximum session duration of at least 7200 seconds.
- Trust conditions for the `fro-bot-storage` environment, repository ID, owner ID, `refs/heads/main`, audience, and workflow. Both approved legacy and immutable-subject forms are represented by the provisioned trust policy.
- A least-privilege policy allowing session-prefix reads/writes and exact lock coordination operations. Session-object deletes and version deletes are explicitly denied.

S3 lifecycle expiry is based on object last-modified time. The documented “inactivity” behavior is therefore write-through-based: a run that writes the session refreshes its age. It is not read-inactivity tracking and does not cap state that an active writer continually touches.

## TEARDOWN

The provisioner teardown path is scoped to the repository in the manifest. It deletes the inline policy and role, removes the coordination lock, and preserves the shared bucket and GitHub OIDC provider. Session objects are retained by default. Use `--purge-state` only when the repository's session history should also be removed. Use `--plan` for a readback-only preview:

```bash
bun run provision:agent -- --teardown --manifest handoff.json --plan
bun run provision:agent -- --teardown --manifest handoff.json
bun run provision:agent -- --teardown --manifest handoff.json --purge-state
```

Teardown validates the manifest identity and role tags before mutating. A partial failure is safe to retry. If state deletion is impossible, the command reports `state purge impossible`, continues the scoped IAM cleanup, and leaves the shared resources intact.

## OPERATOR CHECKS

- Confirm the AWS account owner and bucket region before any mutation.
- Confirm the handoff manifest belongs to the intended live GitHub repository.
- Review every managed-drift diff before using `--force`.
- Never use the gateway bucket, wildcard repository prefixes, or static AWS credentials in a consumer workflow.
- Preserve the `fro-bot-storage` environment's required reviewer and main-only branch policy before the workflow references it.
- Use `.yaml` workflow files and SHA-pin all GitHub Actions with version comments.

## ANTI-PATTERNS

- Never let the AWS SDK fall back to ambient credentials for provisioning.
- Never widen an unknown action key layout to make a run work.
- Never delete the shared bucket or account-level OIDC provider during per-repo teardown.
- Never grant `id-token: write` at workflow level or to content-triggered jobs.
- Never pass secret values in command arguments or commit them to the repository.
