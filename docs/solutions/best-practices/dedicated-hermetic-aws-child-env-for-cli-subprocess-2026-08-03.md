---
title: Use a dedicated hermetic child environment when a CLI shells out to a cloud CLI
date: 2026-08-03
category: best-practices
module: agent-storage
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "A CLI spawns a cloud CLI (aws, gcloud, az) that reads credentials from ambient env or config files"
  - "The operation must run under a dedicated identity distinct from other credentials on the machine"
  - "The project auto-loads a repo-root .env (Bun loads .env from CWD by default)"
related_components:
  - iam
  - provisioning
tags:
  - aws
  - subprocess
  - hermetic-env
  - default-deny
  - dedicated-identity
  - bun-dotenv
  - credential-isolation
---

# Use a dedicated hermetic child environment when a CLI shells out to a cloud CLI

## Context

The `agent storage` preflight shells out to the `aws` CLI to read back provisioned S3/IAM resources. It must run under a *dedicated* operator identity (`AGENT_AWS_*`), deliberately isolated from the object-only `fro-bot-gateway` identity and every other secret in the repo-root `.env`. The original implementation built the child process environment from ambient `process.env`. Because Bun auto-loads the repo-root `.env` from the current working directory, the unrelated `AWS_*` values in that file were present in `process.env` and the `aws` subprocess silently inherited the wrong identity — the preflight failed closed in a way that looked like a resource problem, not a credential-selection problem.

## Guidance

When a CLI spawns a cloud CLI under a dedicated identity, construct an explicit **default-deny** child environment. Pass through only the process-mechanics variables the child genuinely needs, source the credentials exclusively from the dedicated variables, and force the cloud CLI's config-file lookups to inert paths so ambient default config cannot leak in.

```ts
// packages/cli/src/commands/agent/storage.ts — buildAwsChildEnv
const accessKeyId = sourceEnv.AGENT_AWS_ACCESS_KEY_ID?.trim()
const secretAccessKey = sourceEnv.AGENT_AWS_SECRET_ACCESS_KEY?.trim()
if (!accessKeyId || !secretAccessKey) {
  throw new Error('Dedicated AWS credentials are required for agent storage preflight. ...')
}

const childEnv: Record<string, string> = {}
for (const [key, value] of Object.entries(sourceEnv)) {
  if (
    value !== undefined &&
    (key === 'PATH' || key === 'HOME' || key === 'TMPDIR' ||
      AWS_CHILD_LOCALE_KEYS.has(key) || key.startsWith('LC_'))
  ) {
    childEnv[key] = value
  }
}

// Force the aws CLI to ignore ambient default config/credentials files —
// preserving HOME alone still lets it read ~/.aws/config and ~/.aws/credentials.
childEnv.AWS_CONFIG_FILE = '/dev/null'
childEnv.AWS_SHARED_CREDENTIALS_FILE = '/dev/null'

childEnv.AWS_ACCESS_KEY_ID = accessKeyId
childEnv.AWS_SECRET_ACCESS_KEY = secretAccessKey
childEnv.AWS_REGION = sourceEnv.AGENT_AWS_REGION?.trim() || manifest.bucket_region
childEnv.AWS_DEFAULT_REGION = childEnv.AWS_REGION

const sessionToken = sourceEnv.AGENT_AWS_SESSION_TOKEN?.trim()
if (sessionToken) childEnv.AWS_SESSION_TOKEN = sessionToken

return childEnv
```

Also redact the exact dedicated credential values from the subprocess `stdout`/`stderr` and any operation string before they can reach a log or error.

## Why This Matters

Inheriting `process.env` wholesale makes credential selection *implicit* and order-dependent: whichever `AWS_*` values happen to be present win, and an auto-loaded `.env` puts unrelated identities in scope. That is both a correctness bug (wrong identity → confusing fail-closed readbacks) and a blast-radius concern (unrelated secrets are visible to the child). A hermetic, default-deny child env makes the identity explicit and reproducible.

Forcing `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` to `/dev/null` closes the subtler leak: preserving `HOME` alone still lets the AWS CLI load `~/.aws/config` and `~/.aws/credentials`, which can inject endpoint, CA-bundle, or retry overrides into a safety-gate readback.

## When to Apply

- Any CLI that spawns `aws`/`gcloud`/`az` (or similar) and must pin a specific identity.
- Any Bun project that auto-loads a repo-root `.env` and then shells out — assume the child inherits everything in that file unless you scrub it.
- Preflight/safety gates whose *result* decides whether to mutate remote state: hermeticity prevents ambient config from changing the answer.

## Examples

Before — child inherits ambient identity:

```ts
Bun.spawn(['aws', ...args], { env: process.env }) // wrong identity silently wins
```

After — explicit dedicated identity, config files neutralized:

```ts
Bun.spawn(['aws', ...args], { env: buildAwsChildEnv(manifest) })
```

## Related

- [`docs/runbooks/agent-s3-durable-storage.md`](../../runbooks/agent-s3-durable-storage.md) — canonical operator workflow; states `agent storage` uses `AGENT_AWS_*` and ignores ambient `AWS_*`.
- [`integration-issues/discord-mcp-empty-env-jvm-timeout-2026-06-12.md`](../integration-issues/discord-mcp-empty-env-jvm-timeout-2026-06-12.md) — Bun `.env` / ambient-env behavior precedent.
- [`workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md`](../workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md) — dedicated-vs-ambient AWS credential isolation precedent.
- [`integration-issues/agent-s3-key-layout-diverged-from-pinned-action-2026-08-03.md`](../integration-issues/agent-s3-key-layout-diverged-from-pinned-action-2026-08-03.md) — the sibling key-layout fix from the same rollout.
- PR #1014.
