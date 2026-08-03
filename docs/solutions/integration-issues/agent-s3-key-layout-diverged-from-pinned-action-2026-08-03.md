---
title: Agent S3 key layout diverged from the pinned action's real object-key contract
date: 2026-08-03
category: integration-issues
module: agent-storage
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "GitHub Actions storage run: AccessDenied (403) on s3:PutObject for the coordination lock"
  - "Denied path: fro-bot-state/coordination/marcusrbrown/infra/locks/repo.json"
  - "IAM granted access to S3 key paths the upstream action never writes"
  - "Lock acquisition failed; run proceeded without a lock (non-fatal degradation)"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - provisioning
  - iam
  - object-store
tags:
  - agent-storage
  - s3
  - iam
  - oidc
  - key-layout
  - upstream-contract
  - source-authority
  - access-denied
---

# Agent S3 key layout diverged from the pinned action's real object-key contract

## Problem

The `fro-bot/agent` S3 durable-storage feature provisions a per-repository IAM role whose grant is scoped to the exact S3 key paths the action reads and writes. During the rollout smoke, the role got `AccessDenied` (403) on `s3:PutObject` for the coordination lock: infra had encoded an S3 key layout that did not match what the pinned action actually writes, so the role was authorized on paths the action never touches.

## Symptoms

- Live GitHub Actions run emitted:
  - `is not authorized to perform: s3:PutObject on resource ".../fro-bot-state/coordination/marcusrbrown/infra/locks/repo.json" because no identity-based policy allows the s3:PutObject action`
  - `Lock acquisition failed`
  - `Coordination lock acquisition failed; proceeding without lock`
- The failure was non-fatal (the action degrades to running without a lock), so a green-ish run masked a broken storage contract. The end-of-run session backup would have failed the same way.

## What Didn't Work

1. **Pinning a version without verifying the paths.** The layout carried `KEY_LAYOUT_VERSION = 'fro-bot/agent@v0.96.0'` and a comment claiming the paths were "the plan's pinned contract," but the actual key strings were never validated against the action's source at that ref. The pin asserted a version; it did not prove the layout.
2. **Trusting internal self-consistency.** `apps/agent/src/key-layout.ts` and `apps/agent/server/provision.ts` agreed with each other — the IAM ARNs derived cleanly from the layout — so everything looked correct locally. They were consistently wrong: both encoded a fabricated scheme that diverged from the upstream authority on four axes:
   - an invented `github/` segment on the lock identity;
   - a hyphenated `owner-repo` segment instead of separate `owner/repo` segments;
   - an invented `storage/` contentType; and
   - a `storage.lock` filename instead of `repo.json`.
3. **Reprovisioning without `--force`.** After the code fix, the provisioner refused to re-put the inline policy, classifying it as managed drift. `--force` was required — but only safe because the bucket, OIDC provider, and role *trust* policy all read back as `current`, so `--force` re-put **only** the drifted inline policy.

## Solution

Correct `buildAgentKeyLayout` to match the upstream authority exactly. The action's key builder — verified at the pinned commit `fro-bot/agent@c29ac295` (v0.96.0), `packages/runtime/src/object-store/key-builder.ts` — produces:

```
${prefix}/${identity}/${owner}/${repo}/${contentType}[/${suffix}]
```

with `owner` and `repo` as **separate slash segments** (no `github/` wrapper added by the builder, no hyphenation, no `storage/` contentType). The lock is `getLockKey → buildObjectStoreKey(cfg, 'coordination', repo, 'locks', 'repo.json')`; session backup uses identity `github` (content types `sessions`, `runs`, `artifacts`, `metadata`).

Before (wrong):

```ts
const repositorySegment = `${ownerSegment}-${repoSegment}`
const sessionPrefix = `${normalizedPrefix}github/${repositorySegment}/storage/`
const lockPrefix = `${normalizedPrefix}coordination/github/${repositorySegment}/locks/`
const lockKey = `${lockPrefix}storage.lock`
```

After (matches upstream — `apps/agent/src/key-layout.ts`):

```ts
const sessionPrefix = `${normalizedPrefix}github/${ownerSegment}/${repoSegment}/`
const lockPrefix = `${normalizedPrefix}coordination/${ownerSegment}/${repoSegment}/locks/`
const lockKey = `${lockPrefix}repo.json`
```

The IAM policy and handoff manifest derive from the layout, so correcting the one function fixed the grant automatically (`apps/agent/server/provision.ts`):

```ts
const sessionObjectArn = `${bucketArn}/${layout.sessionPrefix}*`
const lockObjectArn = `${bucketArn}/${layout.lockKey}`
// AllowSessionObjects → Get/Put on sessionObjectArn
// AllowCoordinationLock → Delete/Get/Put on lockObjectArn
// DenySessionDeletes → Deny Delete on the session prefix (preserved)
```

Shipping sequence:

1. Merge the code fix (PR #1022); tests assert the exact upstream strings.
2. Re-provision the live IAM policy with the dedicated operator identity (`--force`, safe because only the inline policy was drifted).
3. Independently read back the live policy: lock grant on the exact `.../coordination/<owner>/<repo>/locks/repo.json`, session grant on `.../github/<owner>/<repo>/*`, `DenySessionDeletes` intact.
4. Regenerate the `0600` handoff manifest (`session_prefix` / `lock_key` change; the wired repository variables do not).
5. Re-run the storage smoke: lock acquired → session sync (uploaded, 0 failed) → lock released (no stale lock), **0 AccessDenied**.

## Why This Works

There is one authoritative layout function feeding both the manifest and the IAM policy, and its output now matches the object keys the action actually constructs. The lock grant targets the real `repo.json` object; the session grant covers the real `github/<owner>/<repo>/` tree spanning `sessions`/`runs`/`artifacts`/`metadata`. The role can no longer be "correctly" scoped to phantom paths.

## Prevention

- **Source-authority invariant.** When infra mirrors an upstream contract keyed to a pinned ref or SHA, verify the encoded values against the *actual upstream source at that exact ref* before encoding them. A version pin is not verification; internal self-consistency between two local modules is not verification. Read the upstream file at the SHA (`gh api repos/<owner>/<repo>/contents/<path>?ref=<sha> --jq .content | base64 -d`) and confirm the strings.
- **Tie re-verification to the version bump.** Any change to `KEY_LAYOUT_VERSION` must re-confirm the object-key construction at the new ref; treat the layout constants as a contract test against upstream, not a local convention.
- **Prefer a non-fatal failure that is still loud.** The lock 403 degraded silently to "proceeding without lock." A rollout smoke must inspect the run logs for `AccessDenied` explicitly rather than trusting the job's overall conclusion.
- **`--force` only after confirming scope.** When a converge is guarded as managed drift, verify that unrelated resources (bucket, OIDC provider, role trust) read back as `current` first, so `--force` re-puts only the intended resource.

## Related Issues

- [`workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`](../workflow-issues/gateway-first-deploy-cascade-2026-05-20.md) — upstream-contract verification precedent (verify-at-tag mindset).
- [`workflow-issues/gateway-deploy-stale-image-2026-05-31.md`](../workflow-issues/gateway-deploy-stale-image-2026-05-31.md) — pinned-ref vs actual-running-code freshness discipline.
- [`best-practices/dedicated-hermetic-aws-child-env-for-cli-subprocess-2026-08-03.md`](../best-practices/dedicated-hermetic-aws-child-env-for-cli-subprocess-2026-08-03.md) — the sibling credential-boundary fix from the same rollout.
- Operator procedure: [`docs/runbooks/agent-s3-durable-storage.md`](../../runbooks/agent-s3-durable-storage.md).
- PRs: #1022 (key-layout fix), #1014 (credential boundary).
