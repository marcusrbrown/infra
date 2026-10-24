---
title: Agent S3 IAM policy drifts from the Fro Bot Action's object-key contract
date: 2026-08-03
last_updated: 2026-10-23
category: docs/solutions/integration-issues/
module: apps/agent
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Storage run: AccessDenied (403) on s3:PutObject for a coordination lock object"
  - 'Run logs "Lock acquisition failed" / "proceeding without lock" while the job conclusion looks fine'
  - IAM grants paths the Action never writes, and misses a path it now does
root_cause: missing_permission
resolution_type: code_fix
related_components:
  - provisioning
  - iam
  - object-store
tags:
  - agent-storage
  - s3
  - iam
  - key-layout
  - upstream-contract
  - source-authority
  - access-denied
---

# Agent S3 IAM policy drifts from the Fro Bot Action's object-key contract

## Problem

`apps/agent` provisions a per-repository IAM role scoped to the exact S3 objects the `fro-bot/agent` Action reads and writes. If the Action touches an object the policy doesn't grant, the role gets `AccessDenied`. The lock failure is non-fatal, so the run degrades quietly and the job can still look green. This happened twice:

- **2026-08-03 — fabricated layout.** The first layout was never checked against upstream source. It invented a `github/` lock segment, a hyphenated `owner-repo` segment, a `storage/` content type and a `storage.lock` filename. The Action actually used `coordination/<owner>/<repo>/locks/repo.json`. Local modules agreed with each other and were both wrong. Fixed in #1022 by encoding the key builder's real output (separate `owner/repo` segments), then re-provisioning with `--force` after confirming only the inline policy had drifted.
- **2026-10-07 — new object.** The Action began coordinating through `locks/action.json` and no longer through `locks/repo.json`. The role had no grant for it, so the daily run failed with AccessDenied. Fixed in #1488 by adding the `AllowActionCoordinationLock` statement for that exact ARN (no wildcard) and re-provisioning. `locks/repo.json` stays granted because it is the gateway's shared-checkout lock.

## Current state

- `buildAgentKeyLayout` (`apps/agent/src/key-layout.ts:73`) derives the session prefix, `lockKey` (`locks/repo.json`) and `actionLockKey` (`apps/agent/src/key-layout.ts:80`, `locks/action.json`) from one place. The manifest and the IAM policy both come from it.
- `buildAgentStoragePolicy` grants the Action lock in its own statement, `AllowActionCoordinationLock` (`apps/agent/server/provision.ts:1617`), on the exact object ARN built at `apps/agent/server/provision.ts:1584`. Session access is a prefix grant with an explicit delete deny.
- `KEY_LAYOUT_VERSION` (`apps/agent/src/key-layout.ts:11`) labels the **layout** (`fro-bot-agent-s3-layout/1`), not an Action ref. It changes only when the object layout changes. The earlier ref-based labels survive only as legacy manifest labels accepted by `assertKnownKeyLayout` (`apps/agent/src/key-layout.ts:64`); the CLI keeps a matching list in `isKnownKeyLayoutVersion` (`packages/cli/src/commands/agent/key-layout.ts:15`).
- `agent storage` verifies only that the storage job pins `fro-bot/agent` to a full 40-hex SHA (`packages/cli/src/commands/agent/workflow-verify.ts:552`, the per-step ref check in the storage-job verifier). Tags and branches are rejected.
- The retired first-generation layout (no Action lock grant) fails closed.

## The rule

**An Action bump with an unchanged layout needs nothing.** No code change, no re-provision. The generated IAM policy does not depend on the Action ref.

**A new, renamed or moved object the Action reads or writes is a layout change.** Then:

1. Add the object to `buildAgentKeyLayout` and grant its **exact ARN** in `buildAgentStoragePolicy`. Never widen to wildcards.
2. Bump `KEY_LAYOUT_VERSION` in both `apps/agent/src/key-layout.ts` and `packages/cli/src/commands/agent/key-layout.ts`; keep the legacy-label lists in sync.
3. Re-provision with `bun run provision:agent` (`-- --force` only after reviewing the drift diff and the bucket, OIDC provider and role trust read back as current, so it re-puts just the drifted inline policy), then regenerate the handoff manifest.
4. Re-run `agent storage` verification and a storage smoke that inspects the run logs for `AccessDenied` (see `docs/runbooks/agent-s3-durable-storage.md`).

## Which case are you in?

- **Reviewing an Action bump.** Read the upstream change for S3 key construction and lock names, not just the version. Any new object name, lock scope or content type is a layout change. Renovate does not hold Action-SHA bumps behind the daemon approval gate (`.github/renovate.json5:88-90`), so the review is on you.
- **After the fact.** The daily storage run failing loudly on AccessDenied is the detector. Read the denied resource ARN in the log; if it's an object under the repo's `github/` or `coordination/` tree that the layout doesn't list, it's a layout change. If it's anywhere else, check the role, bucket and prefix wiring first.
- **Don't trust the job conclusion.** A lock 403 degrades to "proceeding without lock". Grep the run log for `AccessDenied`.
- **Source authority.** Verify against the upstream source at the exact ref the workflow pins. A version label is not verification, and agreement between `key-layout.ts` and `provision.ts` proves nothing.

## Regression guards

| Test | Pins |
| --- | --- |
| `apps/agent/server/provision.test.ts:981` | SHA-256 digest of the rendered IAM document, so an Action bump or a label change cannot alter IAM; the label never appears in the document |
| `apps/agent/server/provision.test.ts:1020`, `:1045` | `AllowActionCoordinationLock` is the exact object ARN, same actions as the repo lock, no wildcard, no sibling-repo or other lock objects |
| `apps/agent/src/key-layout.test.ts:56` | Full pinned layout output; a diff here is a re-provision event |
| `apps/agent/src/key-layout.test.ts:42`, `packages/cli/src/commands/agent/storage.test.ts:519` | Unknown labels, bare refs/SHAs and the retired layout fail closed; unrecognised manifest labels are rejected before any variable is written |
| `packages/cli/src/commands/agent/workflow-verify.test.ts:148`, `:157` | Any full-SHA pin is accepted without an infra edit; moveable tags are rejected |

## Related

- `apps/agent/AGENTS.md` and `docs/runbooks/agent-s3-durable-storage.md` — operator procedure, drift, rollback.
- [`best-practices/dedicated-hermetic-aws-child-env-for-cli-subprocess-2026-08-03.md`](../best-practices/dedicated-hermetic-aws-child-env-for-cli-subprocess-2026-08-03.md) — credential-boundary fix from the same rollout.
- PRs: #1022 (first layout fix), #1488 (Action lock grant), #1551 (layout decoupled from the Action version).
