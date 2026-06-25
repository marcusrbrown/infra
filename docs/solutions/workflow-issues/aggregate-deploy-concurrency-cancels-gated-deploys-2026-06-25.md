---
title: Aggregate deploy concurrency cancels gated deploys awaiting approval
date: 2026-06-25
category: docs/solutions/workflow-issues/
module: infra
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - An aggregate GitHub Actions workflow fans out to reusable workflows that wait at environment approval gates
  - A committed image pin is on main but the live service runs the old version, with no obvious deploy failure
  - Deploy runs show as CANCELLED (not skipped) at the merge SHA
tags:
  - github-actions
  - concurrency
  - deploy
  - approval-gate
  - reusable-workflow
  - queueing
  - cancellation
---

# Aggregate deploy concurrency cancels gated deploys awaiting approval

## Context

The deploy router `.github/workflows/deploy.yaml` (push to `main` + `workflow_dispatch`) fans out to per-app reusable workflows (`deploy-<app>.yaml`), each waiting at a per-app GitHub Environment approval gate before touching its droplet. The aggregate workflow carried a top-level `concurrency: { group: deploy-aggregate-${{ github.ref_name }}, cancel-in-progress: false }`. This stranded the umami `3.2.0` image pin: it landed on `main` (PR #670 / `c34bfc9`) but the live instance ran `3.1.0` for ~3 weeks.

## Symptoms

- A committed image pin is on `main`, but the live service stays on the older image for weeks (Umami `3.2.0` committed, production still on `3.1.0`).
- Deploy history shows a long streak of **`CANCELLED`** runs — eight or more in a row from `2026-06-24` through `2026-06-25` — rather than `skipped`.
- It *looks* like a `paths-filter` miss, but the deploy actually triggered and was cancelled.

## What Didn't Work / Investigation

- **First hypothesis: `paths-filter` / change-detection skipped umami.** Wrong. `git show` on the merge commit (`c34bfc9`) confirmed it changed `apps/umami/docker-compose.yaml`, and a deploy run (`28140849332`) *was* created at that SHA. The run was **cancelled, not skipped**.
- The distinction that cracked it: a deploy that "never ran" was really a run **cancelled while waiting at its environment approval gate**. `gh run list --workflow=deploy.yaml` showing `cancelled` (not `skipped`) at the merge SHA is the tell.

## Guidance / Solution

Remove the aggregate-level concurrency block from the deploy router. Each per-app reusable workflow already declares its own concurrency group, so the top-level group is redundant — and it is the only source of cross-app cancellation.

```yaml
# .github/workflows/deploy.yaml — REMOVE this top-level block:
concurrency:
  group: deploy-aggregate-${{ github.ref_name }}
  cancel-in-progress: false
```

Each per-app workflow keeps (already had) its own isolation:

```yaml
# .github/workflows/deploy-<app>.yaml
concurrency:
  group: deploy-<app>-${{ github.ref_name }}
  cancel-in-progress: false
```

Add a conventions/structure test pinning the invariant: `deploy.yaml` has **no** top-level concurrency, and each per-app workflow declares its own `deploy-<app>-` group with `cancel-in-progress: false`. The test fails if the aggregate block returns or a per-app block is removed.

## Why This Matters

GitHub concurrency with `cancel-in-progress: false` and the default `queue: single` allows one running and one **pending** run per group; a newer run joining the group **cancels the older pending run**. An environment-approval "waiting" run behaves as pending, so the aggregate group's waiting run gets cancelled by the next deploy-triggering merge — and because that run is the fan-out, every per-app child deploy it carried dies with it.

Per-app groups fix the blast radius: a `cliproxy` merge no longer shares a cancellation group with a waiting `umami` deploy. Same-app deploys still serialize correctly (their per-app group, `cancel-in-progress: false`). A called reusable workflow's `${{ github.ref_name }}` resolves to the **caller's** ref (`main`), so per-app group names stay stable across all main deploys.

## When to Apply

- Any aggregate/fan-out workflow whose child jobs wait at approval gates: put concurrency **per-app inside each reusable workflow**, never at the aggregate level.
- When diagnosing "a deploy didn't run", first check `CANCELLED` vs `SKIPPED` at the merge SHA — `CANCELLED` points to concurrency-group cancellation, not `paths-filter`.

## Examples

Before (aggregate group cancels the whole fan-out when a later merge arrives):

```yaml
# deploy.yaml
concurrency:
  group: deploy-aggregate-${{ github.ref_name }}   # waiting run cancelled by next merge → all child deploys die
  cancel-in-progress: false
jobs:
  detect-changes: ...
  deploy-umami: { uses: ./.github/workflows/deploy-umami.yaml }
  deploy-cliproxy: { uses: ./.github/workflows/deploy-cliproxy.yaml }
```

After (no aggregate group; each app's per-app group governs independently):

```yaml
# deploy.yaml — no top-level concurrency
jobs:
  detect-changes: ...
  deploy-umami: { uses: ./.github/workflows/deploy-umami.yaml }
  deploy-cliproxy: { uses: ./.github/workflows/deploy-cliproxy.yaml }

# deploy-umami.yaml (unchanged — already present)
concurrency:
  group: deploy-umami-${{ github.ref_name }}
  cancel-in-progress: false
```

## Prevention

- Conventions test that asserts the aggregate has no concurrency and each per-app workflow has its own group prevents regression.
- Pair with deploy drift-detection (committed image pin vs live deployed version) so any future stranded deploy is caught fast rather than weeks later.
- A consumed-but-stranded image pin can also hide behind a transient release failure — verify live deployed versions, not just `main` state, after a Renovate merge burst.

## Related

- infra PR #682 — fix(deploy): remove aggregate concurrency that cancels gated deploys
- infra PR #670 — umami `3.2.0` image bump (the stranded deploy)
- [gateway-deploy-stale-image-2026-05-31.md](./gateway-deploy-stale-image-2026-05-31.md) — deploy-freshness failure (stale image), same deploy-pipeline area, different mechanism.
- [gateway-do-firewall-in-deploy-path-2026-06-19.md](./gateway-do-firewall-in-deploy-path-2026-06-19.md) — "don't couple unrelated deploy concerns" theme.
- [cliproxy-healthcheck-tooling-migration-2026-06-09.md](./cliproxy-healthcheck-tooling-migration-2026-06-09.md) — deploy-gate fragility from app-image tooling.
- [vpn-lightsail-first-provision-cascade-2026-06-10.md](./vpn-lightsail-first-provision-cascade-2026-06-10.md) — paths-filter / change-detection workflow lesson.
