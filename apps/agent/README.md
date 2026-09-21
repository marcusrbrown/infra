# Agent

Operator-run AWS provisioner for `fro-bot/agent` durable S3 session storage. No deploy target, no Docker Compose, no deploy workflow, and no GitHub Environment — this package is not deployable.

It provisions an account-level GitHub Actions OIDC provider, a dedicated S3 bucket, and one least-privilege IAM role and inline policy per consumer repository. It does not deploy an application, publish a package, or write any AWS credential to a GitHub repository. `apps/agent/src/key-layout.ts` pins a versioned S3 key layout and fails closed on unknown or unverified layouts rather than widening IAM access.

## Provisioning

The only entry point is the provisioner script, run from the repository root so Bun loads the root `.env`:

```bash
bun run provision:agent
```

This invokes `apps/agent/server/provision.ts`, which discovers or creates the account-level `token.actions.githubusercontent.com` OIDC provider, verifies or creates the bucket and its managed S3 controls, creates or verifies the repository IAM role and policy, and readback-verifies the result. Managed drift is reported and halts by default:

```bash
bun run provision:agent -- --force
```

Foreign or shared-resource drift remains a hard stop even with `--force`.

Teardown is scoped to one repository and defaults to retaining session objects:

```bash
bun run provision:agent -- --teardown --manifest handoff.json --plan
bun run provision:agent -- --teardown --manifest handoff.json
bun run provision:agent -- --teardown --manifest handoff.json --purge-state
```

## Configuration

No GitHub Environment. Provisioning inputs are operator-local values in the repo-root `.env` only — never a GitHub Environment, never committed:

| Variable                             | Required | Description                                          |
| ------------------------------------ | -------- | ---------------------------------------------------- |
| `AGENT_AWS_ACCESS_KEY_ID`            | ✓        | Dedicated AWS provisioning access key                |
| `AGENT_AWS_SECRET_ACCESS_KEY`        | ✓        | Dedicated AWS provisioning secret                    |
| `AGENT_AWS_SESSION_TOKEN`            | —        | Optional session token for the dedicated credentials |
| `AGENT_AWS_REGION`                   | —        | AWS SDK region; defaults to `us-east-1`              |
| `AGENT_S3_BUCKET`                    | ✓        | Dedicated action-state bucket name                   |
| `AGENT_S3_EXPECTED_BUCKET_OWNER`     | ✓        | Twelve-digit AWS account owner ID                    |
| `AGENT_S3_PREFIX`                    | ✓        | Canonical root prefix, without wildcard characters   |
| `AGENT_S3_SESSION_PREFIX`            | —        | Optional explicit session prefix override            |
| `AGENT_S3_METADATA_ARTIFACTS_PREFIX` | —        | Optional metadata/artifacts prefix override          |
| `AGENT_REPOSITORY_OWNER`             | ✓        | GitHub repository owner                              |
| `AGENT_REPOSITORY_NAME`              | ✓        | GitHub repository name                               |
| `AGENT_REPOSITORY_ID`                | ✓        | Live GitHub repository ID                            |
| `AGENT_REPOSITORY_OWNER_ID`          | ✓        | Live GitHub owner ID                                 |
| `AGENT_WORKFLOW_NAME`                | ✓        | Workflow name pinned in the IAM trust policy         |
| `AGENT_ACTION_REF`                   | ✓        | Verified `fro-bot/agent` ref                         |

The provisioner deliberately ignores ambient `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` values — only the `AGENT_AWS_*` names are read. No static AWS credential is ever written to GitHub.

Provisioning emits a single compact JSON handoff manifest (identifiers and resource names, never credential bytes). Wiring that manifest into a consumer repository writes exactly five non-secret repository variables: `FRO_BOT_S3_ROLE_TO_ASSUME`, `FRO_BOT_S3_BUCKET`, `FRO_BOT_S3_REGION`, `FRO_BOT_S3_PREFIX`, `FRO_BOT_S3_EXPECTED_BUCKET_OWNER`. The consuming repository must pre-create a `fro-bot-storage` GitHub Environment (required reviewer, main-only deployment-branch policy) before its workflow references it; that environment belongs to the consumer repository, not to this one.

## Operations

Security boundary, AWS resource contract, teardown detail, and anti-patterns: [`apps/agent/AGENTS.md`](AGENTS.md).

Rollout, Go/No-Go, and monitoring: [`docs/runbooks/agent-s3-durable-storage.md`](../../docs/runbooks/agent-s3-durable-storage.md).

Key operational notes:

- Never let the AWS SDK fall back to ambient credentials for provisioning.
- Never widen an unknown action key layout to make a run work.
- Never delete the shared bucket or account-level OIDC provider during per-repo teardown.
- Never grant `id-token: write` at workflow level or to content-triggered jobs.
- Never pass secret values in command arguments or commit them to the repository.

## CLI

```bash
bunx @marcusrbrown/infra agent setup                                          # generalized model-credential onboarding
bunx @marcusrbrown/infra agent storage --repo OWNER/REPO --manifest FILE      # wire non-secret S3 variables + verify workflow
bunx @marcusrbrown/infra agent storage teardown --repo OWNER/REPO --manifest FILE  # unwire variables + remove repo-scoped resources
```

`agent storage` verifies live repository identity, the provisioned IAM role and S3 bucket, the repository OIDC subject, and the effective workflow/environment contract before writing variables. AWS readback requires `AGENT_AWS_ACCESS_KEY_ID` and `AGENT_AWS_SECRET_ACCESS_KEY`; both storage commands reject static AWS credential options and require the local `aws` CLI.
