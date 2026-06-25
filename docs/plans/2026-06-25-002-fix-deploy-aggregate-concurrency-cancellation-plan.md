---
title: "fix: Stop aggregate deploy concurrency from cancelling gated deploys"
type: fix
status: active
date: 2026-06-25
---

# fix: Stop aggregate deploy concurrency from cancelling gated deploys

## Overview

The aggregate deploy router (`.github/workflows/deploy.yaml`) carries a top-level `concurrency: deploy-aggregate-${{ github.ref_name }}` with `cancel-in-progress: false`. Because the aggregate run is a single run that fans out to the per-app reusable workflows and waits at per-app environment approval gates, a deploy run awaiting approval gets cancel-replaced when the next deploy-triggering merge to `main` arrives — stranding every app deploy that run carried. Each per-app reusable workflow already declares its own independent per-app concurrency group, so the aggregate-level group is redundant and is the sole cause of the cross-app cancellation. The fix removes the aggregate-level `concurrency` block and locks the intended state with a conventions test.

## Problem Frame

Investigated live this session: the umami `3.2.0` image pin (PR #670) landed on `main` but the live instance ran `3.1.0` for ~3 weeks. The deploy run for that merge (`c34bfc9`) was **cancelled**, not skipped — and the deploy history shows 8+ consecutive cancelled Renovate deploy runs (2026-06-24 → 2026-06-25).

Mechanism: `deploy.yaml`'s aggregate run builds, then waits at the per-app environment approval gate (often hours, until a human approves). When the next deploy-triggering merge arrives while the aggregate run is still waiting, GitHub's concurrency queue (`cancel-in-progress: false`, default `queue: single` = one pending max) **cancels the older pending/waiting run and replaces it with the newer one**. Because the cancelled run is the aggregate fan-out, all of its in-flight child deploys die with it. The umami bump stranded visibly because no later merge re-touched `apps/umami/` to re-trigger it; the cliproxy bumps self-healed only because a later cliproxy bump re-triggered and happened to get approved before the next merge.

The per-app reusable workflows (`deploy-<app>.yaml`) already each declare `concurrency: { group: deploy-<app>-${{ github.ref_name }}, cancel-in-progress: false }`, so per-app isolation already exists at the callee level — but it never takes effect because the **caller** (aggregate) run is cancelled first. Removing the aggregate-level concurrency lets the existing per-app groups govern queueing independently.

## Requirements Trace

- R1. A deploy run awaiting its environment approval gate for one app is not cancelled when a later deploy-triggering merge for a *different* app arrives.
- R2. A later deploy-triggering merge for the *same* app still supersedes/queues correctly (per-app concurrency `cancel-in-progress: false` preserved).
- R3. The intended state — aggregate router has no top-level `concurrency`, and every callable `deploy-<app>.yaml` retains its per-app concurrency group with `cancel-in-progress: false` — is enforced by a conventions test so it can't silently regress.

## Scope Boundaries

- Not changing the per-app environment approval-gate model (reviewer + main-only branch policy stays).
- Not changing `cancel-in-progress` semantics (stays `false` everywhere — a queued same-app deploy waits, it does not cancel a running one).
- Not changing the paths-filter / detect-changes routing.

### Deferred to Separate Tasks

- Deploy drift-detection (compare each app's committed image pin vs live deployed version to catch a stranded deploy fast): a separate follow-up — it treats the symptom; this plan removes the cause.

## Context & Research

### Relevant Code and Patterns

- `.github/workflows/deploy.yaml` — aggregate router; `concurrency: deploy-aggregate-${{ github.ref_name }}` at the top level (the block to remove). Fans out to `deploy-<app>.yaml` via `uses:`.
- `.github/workflows/deploy-{keeweb,cliproxy,gateway,umami,vpn,dashboard}.yaml` — each already has `concurrency: { group: deploy-<app>-${{ github.ref_name }}, cancel-in-progress: false }`. No change needed; the conventions test asserts these stay.
- `packages/cli/src/conventions.test.ts` — executable workflow-convention enforcement (SHA-pinned actions, `.yaml` extension, no `ssh-keyscan`, paths-filter quantifier). Add the concurrency assertions here.

### Institutional Learnings

- `docs/solutions/workflow-issues/` cliproxy deploy-readiness and gateway deploy docs — prior deploy-pipeline fixes follow the same "fix in workflow YAML + lock with conventions test" pattern.

### External References

- GitHub Actions docs (verified during planning): a called reusable workflow's own top-level `concurrency` is valid and operates independently; `${{ github.ref_name }}` inside a called workflow resolves to the **caller's** ref (`main`), so `deploy-<app>-${{ github.ref_name }}` is a stable per-app group across all main deploys; with `cancel-in-progress: false` and default `queue: single`, a newer run joining a group cancels the older **pending** run. The one doc-ambiguous point — whether an environment-approval "waiting" run is classified as `pending` for concurrency — is resolved empirically by the live evidence (the cancelled runs).

## Key Technical Decisions

- **Remove the aggregate-level `concurrency` entirely rather than tune it.** The aggregate run has no legitimate need for a cross-app serialization group; per-app groups already exist and are the correct granularity. Keeping any aggregate group re-introduces the cancellation. (An alternative — `queue: max` on the aggregate — is not available as a documented top-level option and would still couple unrelated apps.)
- **Keep per-app groups keyed by `${{ github.ref_name }}`.** Verified to resolve to the caller's `main`; stable, and future-proofs the workflows if ever triggered on another branch. No churn needed since they're already in this form.

## Open Questions

### Resolved During Planning

- Does per-app concurrency already exist? → Yes, all 6 callable deploy workflows already declare it correctly. The fix is only the aggregate removal + a test.
- Does removing the aggregate concurrency let two runs of the *same* app overlap? → No. Each app's callee concurrency group (`deploy-<app>-main`, `cancel-in-progress: false`) still serializes that app's deploys independently.

### Deferred to Implementation

- Exact assertion style for the conventions test (parse YAML vs. structural string checks) — match the existing assertions in `conventions.test.ts`.

## Implementation Units

- [ ] **Unit 1: Remove aggregate-level concurrency from the deploy router**

**Goal:** Eliminate the cross-app cancellation by deleting the `concurrency` block from the aggregate `deploy.yaml`, so each app's existing per-app concurrency governs independently.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `.github/workflows/deploy.yaml`

**Approach:**
- Delete the top-level `concurrency: { group: deploy-aggregate-${{ github.ref_name }}, cancel-in-progress: false }` block. Leave everything else (permissions, `on`, `detect-changes`, the 6 fan-out jobs) unchanged.
- Do not add any replacement aggregate concurrency.

**Test expectation:** none for the YAML change itself — behavior is covered by Unit 2's conventions assertions.

**Verification:**
- `deploy.yaml` has no top-level `concurrency:` key.
- The 6 per-app `deploy-<app>.yaml` concurrency blocks are untouched.

- [ ] **Unit 2: Add conventions test pinning the concurrency invariant**

**Goal:** Lock the intended state so it can't silently regress: aggregate router has no concurrency, every callable per-app deploy workflow has its per-app concurrency with `cancel-in-progress: false`.

**Requirements:** R3

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/cli/src/conventions.test.ts`

**Approach:**
- Add assertions in the workflow-conventions area mirroring existing structural checks.
- Assert `.github/workflows/deploy.yaml` does NOT contain a top-level `concurrency` block (the aggregate group must not return).
- Assert each `.github/workflows/deploy-<app>.yaml` (keeweb, cliproxy, gateway, umami, vpn, dashboard) DOES contain a `concurrency` block with a `deploy-<app>` group and `cancel-in-progress: false`.

**Execution note:** Load `systematic:test-driven-development`. Write the assertions RED against the pre-change state where useful (the aggregate-has-no-concurrency assertion fails before Unit 1), then GREEN after Unit 1.

**Patterns to follow:**
- Existing workflow-convention assertions in `packages/cli/src/conventions.test.ts` (it already reads `.github/workflows/*.yaml` and makes structural assertions).

**Test scenarios:**
- Happy path: `deploy.yaml` content has no top-level `concurrency:` → assertion passes after Unit 1.
- Happy path: each of the 6 `deploy-<app>.yaml` files contains `concurrency:` with group `deploy-<app>-` and `cancel-in-progress: false`.
- Edge (regression guard): if an aggregate `concurrency` were re-added to `deploy.yaml`, the test fails.
- Edge (regression guard): if any per-app workflow loses its `concurrency` block, the test fails.

**Verification:**
- `bun test packages/cli/src/conventions.test.ts` passes.
- Re-adding aggregate concurrency or removing a per-app block makes the test fail (verify by temporary local mutation, then revert).

## System-Wide Impact

- **Interaction graph:** Only the deploy router's run-level concurrency changes. detect-changes, paths-filter routing, fan-out jobs, and per-app gates are unchanged.
- **State lifecycle risks:** Removing aggregate serialization means two *different* apps' deploys can now run concurrently (each in its own aggregate run). This is desired and safe — they target different droplets and never shared state. Same-app concurrency is still serialized by the per-app group.
- **Unchanged invariants:** per-app environment approval gates; `cancel-in-progress: false` everywhere; paths-filter `predicate-quantifier: every`; the per-app concurrency groups themselves.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Two aggregate runs for the same app could overlap if the per-app group didn't actually isolate | Per-app group `deploy-<app>-main` + `cancel-in-progress: false` already serializes each app; verified the groups exist and resolve to a stable caller-ref key. |
| Concurrent deploys of different apps cause runner/resource contention | Each app deploys to its own droplet over SSH; off-droplet GHCR builds run on GitHub runners with ample capacity. No shared mutable state. Acceptable. |
| The fix regresses later (someone re-adds aggregate concurrency) | Unit 2 conventions test fails on re-addition. |

## Documentation / Operational Notes

- No changeset — `.github/workflows/` + test only, not published `packages/cli/src` runtime surface.
- After merge, a routine multi-app Renovate burst should no longer strand deploys: each app's gated run waits independently until approved, rather than being cancelled by an unrelated app's merge.
- Pairs with the deferred drift-detection follow-up (separate task) as defense-in-depth.

## Sources & References

- Live investigation this session: cancelled deploy runs `28140849332` (umami c34bfc9) and the 06-24/06-25 cancellation streak; umami live-vs-pinned drift (3.1.0 live, 3.2.0 pinned).
- Related code: `.github/workflows/deploy.yaml`, `.github/workflows/deploy-<app>.yaml`, `packages/cli/src/conventions.test.ts`
- GitHub Actions docs: concurrency for workflows/jobs; reusing workflow configurations (caller `github` context); concurrency queueing/`cancel-in-progress` semantics.
