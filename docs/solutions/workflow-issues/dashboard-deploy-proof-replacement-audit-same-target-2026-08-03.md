---
title: 'Dashboard deployment correctness needs replacement, audit-pin, and same-target proofs'
date: 2026-08-03
category: workflow-issues
module: apps/dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - A production deployment replaces a digest-pinned dashboard image and writes the resulting pin back to the repository
  - The audit-pin commit is intentionally excluded from automatic dashboard deployment
  - A same-target deployment must validate the committed pin through the cache-first path
tags:
  - dashboard
  - deployment
  - image-retention
  - digest-pinning
  - convergence
  - audit-pin
  - github-actions
  - docker-compose
---

# Dashboard deployment correctness needs three independent proofs

## Context

The dashboard deploy now has a locked, digest-first remote transaction. The relevant implementation landed in [PR #1005](https://github.com/marcusrbrown/infra/pull/1005), was hardened for GNU empty lock metadata in [PR #1007](https://github.com/marcusrbrown/infra/pull/1007), and gained post-convergence evidence plus container-ID normalization in [PR #1010](https://github.com/marcusrbrown/infra/pull/1010). This document is grounded against the current `main` tree at [`4c006fc`](https://github.com/marcusrbrown/infra/commit/4c006fc), with the production sequence below occurring immediately before and after the dashboard pin merge.

The durable lesson is that deployment correctness required **three distinct production proofs**:

1. **Replacement proof:** the requested release digest was staged, published, and is running.
2. **Audit-pin proof:** the successful deployment produced the reviewed Compose pin recorded in `main`.
3. **Same-target proof:** an explicit, environment-gated deployment from the committed pin reconverged the identical digest through the cache path without opening another audit PR.

One green workflow does not establish all three.

## Problem

A versioned deployment can be healthy and still leave an incomplete evidence chain. The remote transaction proves the new image is live, but the audit-pin commit is a repository write-back that is deliberately skipped by the normal deploy router to avoid a deployment loop. Merging that audit commit therefore does not itself prove that the committed pin was deployed.

There were several smaller proof gaps in the same boundary:

- A capacity check before acquisition did not prove that the host still had the required headroom after Compose recreated the stack.
- A staged image, active Compose file, and running container could be checked at different times without an explicit digest-parity contract.
- The replaced image was intentionally retained only until the next deployment attempt, so local inspectability was bounded rollback evidence, not durable storage.
- Caddy's persistent state needed explicit runtime evidence; seeing a healthy dashboard container alone did not prove that `caddy_data` and `caddy_config` survived recreation.
- `docker compose ps -q` may return a short container ID while a full-ID inventory returns the same container with 64 characters. Comparing those strings directly can make a correct convergence look unverifiable.

## Replacement proof: run 30785307051

[Production run 30785307051](https://github.com/marcusrbrown/infra/actions/runs/30785307051) was the versioned deployment of `2026.08.1`. It checked out `main` at `3b9639090e5af675751293623579acd5352e1adb`, dispatched with the expected digest, and completed successfully at `2026-08-03T04:50:14Z`.

The exact dashboard digest was:

```text
sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64
```

The production evidence formed a digest-parity chain across the release, staged, active, and runtime surfaces:

| Surface | Run evidence | Result |
| --- | --- | --- |
| Release input | `DEPLOY_DIGEST: sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64` | Requested digest |
| Staged acquisition | `evidence=image-verified:ghcr.io/fro-bot/dashboard@sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64` | Exact repository digest verified after pull |
| Active Compose | `evidence=active-compose:post-convergence:ref=ghcr.io/fro-bot/dashboard:2026.08.1@sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64;digest=sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64` | Published pin matches |
| Runtime | `evidence=runtime-digest:sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64` and `evidence=running-dashboard:post-convergence:digest=sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64;health=healthy` | Running digest matches and is healthy |

The old active image was also captured before mutation:

```text
evidence=active-compose:baseline:ref=ghcr.io/fro-bot/dashboard:2026.08.0@sha256:0225422b9b870c2cb748ca2868cd98624969ce00f53bdb910a56a24471acf6ce;digest=sha256:0225422b9b870c2cb748ca2868cd98624969ce00f53bdb910a56a24471acf6ce
evidence=running-dashboard:baseline:digest=sha256:0225422b9b870c2cb748ca2868cd98624969ce00f53bdb910a56a24471acf6ce;health=healthy
```

The deploy also proved capacity at the final boundary, not only before acquisition:

```text
evidence=capacity:post-acquisition:free-bytes=19399602176
evidence=capacity:post-convergence:free-bytes=19403386880
```

The post-convergence checkpoint is the acceptance boundary. The host must still satisfy the existing 6 GiB floor after dashboard and Caddy have converged; otherwise the deployment must fail rather than report success after a transiently sufficient pre-mutation check.

## Persistent state and inspectability evidence

The same run emitted fixed, redacted persistent-state evidence after convergence:

```text
evidence=persistent-state:dashboard-data=/data,bind,writable,canonical,uidgid=1000:1000,mode=0700;caddy-data=/data,volume,writable,labels=dashboard/caddy_data;caddy-config=/config,volume,writable,labels=dashboard/caddy_config
```

This proves the dashboard's `/data` bind mount is the canonical writable `1000:1000` directory and that Caddy has both writable named volumes with the expected Compose project and volume labels. It is the runtime proof that Caddy recreation preserved persistent volume state. Do not replace this with `docker compose down -v`; that destroys Caddy's ACME/TLS state.

The replaced dashboard image was still locally inspectable immediately after replacement:

```text
evidence=prior-dashboard:post-convergence:digest=sha256:0225422b9b870c2cb748ca2868cd98624969ce00f53bdb910a56a24471acf6ce;local-inspectable=true
```

That retention is deliberately bounded. Pruning occurs at the beginning of the next deployment attempt, so the prior image is a temporary rollback generation, not a permanent rollback guarantee. The next attempt may remove it.

## Normalize container identity before inspection

Compose can emit a short ID while the inventory command emits the full ID. The convergence readback must request and compare canonical full IDs:

```sh
docker compose ps --no-trunc -q dashboard
docker ps --no-trunc \
  --filter 'label=com.docker.compose.project=dashboard' \
  --filter 'label=com.docker.compose.service=dashboard' \
  --format '{{.ID}}'
```

The `--no-trunc` change is part of [PR #1010](https://github.com/marcusrbrown/infra/pull/1010). The test case deliberately supplies `abcdef123456` from Compose and `abcdef1234567890` from inventory, then requires the full-ID path to succeed. Evidence output does not expose raw container IDs; normalize internally and emit only the fixed allowlisted evidence shapes.

## Audit-pin proof: PR #1021 is evidence-only

After the remote transaction converged and the advisory probes finished, the versioned workflow wrote the exact generated Compose pin into its worktree and opened [audit PR #1021](https://github.com/marcusrbrown/infra/pull/1021). The run log shows the ordering:

```text
✓ Remote dashboard transaction converged
✓ Same-origin operator health check passed: .../operator/health → 200
✓ Public HTTPS probe succeeded: .../api/healthz
✓ Updated local compose pin: .../apps/dashboard/docker-compose.yaml
✓ Deploy complete.
```

The audit PR commit was [`741524b`](https://github.com/marcusrbrown/infra/commit/741524b171a4d4455db47bebc8b780aa1a162ce3), and [PR #1021](https://github.com/marcusrbrown/infra/pull/1021) merged as [`bcf3d44`](https://github.com/marcusrbrown/infra/commit/bcf3d448c374faf4bf6f810101e69514f203eb81). It changed the committed dashboard pin from `2026.08.0@sha256:0225422b...` to `2026.08.1@sha256:85c114ef...`.

The pin write-back is **evidence-only**. It records what already deployed successfully; it is not a second authorization path and it must not be treated as proof that the post-merge committed pin has reconverged in production.

The deploy router explicitly excludes a dashboard commit whose message starts with `chore(dashboard): pin image to ` from automatic deployment in [`deploy.yaml`](https://github.com/marcusrbrown/infra/blob/main/.github/workflows/deploy.yaml#L174-L180). That exclusion is intentional: without it, a successful versioned deployment would open an audit PR, merge the pin, trigger another deployment, and repeat the audit write-back indefinitely.

## Same-target proof: run 30786511189

Because the audit-pin commit skips automatic deployment, the committed pin required a separate explicit dispatch. [Production run 30786511189](https://github.com/marcusrbrown/infra/actions/runs/30786511189) was manually dispatched against `main` at `bcf3d448c374faf4bf6f810101e69514f203eb81` on `2026-08-03`. It used the no-version/committed-pin mode behind the `dashboard` environment gate in [`deploy-dashboard.yaml`](https://github.com/marcusrbrown/infra/blob/main/.github/workflows/deploy-dashboard.yaml#L123-L127).

This run is the required same-target proof, not a redundant rerun:

```text
evidence=active-compose:baseline:ref=ghcr.io/fro-bot/dashboard:2026.08.1@sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64;digest=sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64
evidence=running-dashboard:baseline:digest=sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64;health=healthy
evidence=acquisition:mode=cache
evidence=image-verified:ghcr.io/fro-bot/dashboard@sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64
evidence=storage:post-convergence:probe=/var/lib/docker,/var/lib/containerd;mount=/;source=/dev/vda1;fstype=ext4;free-bytes=19422998528
evidence=capacity:post-convergence:free-bytes=19422998528
evidence=active-compose:post-convergence:ref=ghcr.io/fro-bot/dashboard:2026.08.1@sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64;digest=sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64
evidence=running-dashboard:post-convergence:digest=sha256:85c114ef372d1aa99a281797be48a43dd651c7c0e2b878f302d94e73dd1f2f64;health=healthy
evidence=persistent-state:dashboard-data=/data,bind,writable,canonical,uidgid=1000:1000,mode=0700;caddy-data=/data,volume,writable,labels=dashboard/caddy_data;caddy-config=/config,volume,writable,labels=dashboard/caddy_config
```

The raw `prior-dashboard` line is intentionally omitted here. In same-target mode it equals the
current digest and describes the pre-deploy baseline, not a distinct replaced generation. The
replacement run is the retention proof; this run is the idempotent reconvergence proof.

The run also showed the audit step as **skipped**, because no version input was supplied. It therefore reconverged the committed pin through the exact cache path and created no redundant audit PR. The two advisory probes again passed: same-origin operator health returned `200`, and the public `/api/healthz` probe succeeded.

## Cache is a safety mechanism, not deployment authorization

The cache-first path is safe only because it verifies the complete exact staged image set by `repository@digest`. Run 30786511189 recorded `acquisition:mode=cache` and verified both the dashboard digest above and the pinned Caddy digest:

```text
evidence=image-verified:caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
```

A cached image can make rollback or same-target reconvergence possible when the registry is unavailable, and a failed pull may fall back only if the complete exact cache is present. A tag-only image, a wrong digest, or an image merely left over from a prior deploy is not enough.

Conversely, cache presence is **not authorization to deploy an unverified image**. Authorization still comes from the reviewed Compose pin or an explicit versioned dispatch whose resolved GHCR digest matches its supplied digest. If the image has not passed that release and digest verification, do not publish it just because Docker can find it locally. The rollback runbook records the same boundary: cache may assist recovery, but the reviewed Compose pin plus the normal gated deploy remains the source of truth.

## What did not work

- **Treating one green versioned workflow as the whole proof.** It proved replacement and enabled the audit write-back, but not deployment of the resulting committed pin.
- **Treating the audit PR merge as a deployment.** The router intentionally skips the `chore(dashboard): pin image to ...` commit to prevent loops. A separate environment-gated dispatch is required.
- **Checking capacity only before acquisition.** Image pull and Compose convergence can change disk usage; the post-convergence checkpoint is the final capacity acceptance boundary.
- **Comparing a short Compose ID with a full inventory ID.** Use `--no-trunc` on both readbacks and normalize before inspection.
- **Assuming the prior image is retained forever.** It remains inspectable only until the next deployment attempt's pre-acquisition prune.
- **Treating any local cache hit as permission to deploy.** Exact digest verification and the reviewed/explicit release contract remain mandatory.

## Durable procedure

For a versioned dashboard release:

1. Dispatch the environment-gated versioned workflow with the release version and, when available, the expected digest.
2. Require exact release/staged/active/runtime digest parity.
3. Require post-acquisition and post-convergence capacity checks; the latter must remain above the 6 GiB floor.
4. Require explicit dashboard `/data`, Caddy `/data`, and Caddy `/config` persistent-state evidence.
5. Require the prior digest to remain locally inspectable when a replacement occurred, while treating that retention as bounded.
6. Run the advisory probes only after remote convergence; open the audit pin only after those steps succeed.
7. Merge the audit pin, then explicitly dispatch the no-version committed-pin mode through the `dashboard` environment gate.
8. Require same-target cache/committed-pin mode to verify the identical digest, reconverge it, pass the same evidence gates, and skip creation of another audit PR.

For rollback, revert or otherwise review a specific Compose `tag@digest` pin and deploy it through the normal gated path. Never substitute an unverified cached image for that authorization.

## Related

- [PR #1005 — prevent deploy disk exhaustion](https://github.com/marcusrbrown/infra/pull/1005)
- [PR #1007 — handle GNU empty lock metadata](https://github.com/marcusrbrown/infra/pull/1007)
- [PR #1010 — verify post-convergence deploy state](https://github.com/marcusrbrown/infra/pull/1010)
- [PR #1021 — pin image to 2026.08.1](https://github.com/marcusrbrown/infra/pull/1021)
- [Run 30785307051 — versioned replacement](https://github.com/marcusrbrown/infra/actions/runs/30785307051)
- [Run 30786511189 — same-target committed-pin reconvergence](https://github.com/marcusrbrown/infra/actions/runs/30786511189)
- [`apps/dashboard/AGENTS.md`](https://github.com/marcusrbrown/infra/blob/main/apps/dashboard/AGENTS.md) — current deploy contract and anti-patterns
- [`dashboard-released-image-rollback.md`](https://github.com/marcusrbrown/infra/blob/main/docs/runbooks/dashboard-released-image-rollback.md) — reviewed-pin rollback procedure and bounded cache retention
- [`dashboard-caddy-bind-mount-stale-reload-2026-07-26.md`](../integration-issues/dashboard-caddy-bind-mount-stale-reload-2026-07-26.md) — Caddy recreation and persistent-volume warning
