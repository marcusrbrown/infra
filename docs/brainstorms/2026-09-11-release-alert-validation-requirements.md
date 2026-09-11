---
date: 2026-09-11
topic: release-alert-validation
---

# Release Alert Validation

## Summary

Release Alert will gain deterministic local coverage and an owner-only synthetic `workflow_dispatch` path that proves its real GitHub issue create-and-update behavior without failing or publishing a release.

---

## Problem Frame

The Release Alert workflow has live proof that it can create an incident issue: failed Release run `33142690493` created issue #1209 on August 28, 2026. It does not have live proof that a later failure finds that existing open issue, comments on it, and avoids creating a duplicate.

Deliberately breaking the Release workflow to exercise that branch would put package publication and incident signaling at risk. Static workflow checks alone are also insufficient: this repository has repeatedly found GitHub-runtime failures in automation that passed YAML parsing, tests, and review.

---

## Actors

- A1. Repository owner: manually starts synthetic validation, inspects the result, and closes the test issue afterward.
- A2. Release Alert workflow: handles real Release failures and isolated synthetic validation runs.
- A3. GitHub Issues: stores the production incident thread and the separate synthetic test thread.

---

## Key Flows

- F1. First synthetic alert
  - **Trigger:** A1 starts Release Alert through `workflow_dispatch` when no synthetic test issue is open.
  - **Actors:** A1, A2, A3
  - **Steps:** The workflow verifies the caller, uses synthetic-only identity, searches for an existing matching issue, and creates one when none exists.
  - **Outcome:** Exactly one open synthetic test issue exists with evidence linking it to the validation run.
  - **Covered by:** R2, R3, R4, R5, R7, R8, R10
- F2. Synthetic dedupe and update
  - **Trigger:** A1 starts Release Alert through `workflow_dispatch` again while the synthetic test issue remains open.
  - **Actors:** A1, A2, A3
  - **Steps:** The workflow finds the existing synthetic issue and adds a new run-specific comment instead of creating another issue.
  - **Outcome:** One synthetic issue remains open and contains evidence from both runs.
  - **Covered by:** R2, R3, R4, R7, R9, R10
- F3. Production Release failure
  - **Trigger:** The Release workflow completes with failure.
  - **Actors:** A2, A3
  - **Steps:** Release Alert follows its existing production issue-create or issue-update behavior.
  - **Outcome:** Production alert behavior remains unchanged by the validation capability.
  - **Covered by:** R1, R4, R6

---

## Requirements

**Production isolation**

- R1. Existing Release-failure alert behavior must remain unchanged.
- R2. Synthetic validation must reserve the exact title `Release workflow failure (synthetic validation)`, label `release-publish-failure-test`, and marker `<!-- release-publish-failure-test:v1 -->`.
- R3. An existing synthetic issue matches only when all three reserved identity fields match. Zero matches selects create; one match selects comment; multiple matches fail closed without mutation.
- R4. A synthetic run must never select, comment on, close, or otherwise mutate a production Release Alert issue.
- R5. Synthetic validation must not start or fail a Release run, publish a package, or alter release state.
- R6. Production and synthetic paths must keep the workflow's existing `issues: write` permission with every other `GITHUB_TOKEN` scope disabled, remain checkout-free and dependency-install-free, and use no new secret, environment, PAT, App token, or broader permission.

**Live validation**

- R7. `.github/workflows/release-alert.yaml` must expose `workflow_dispatch` solely as the synthetic entrypoint; its existing failed-Release `workflow_run` entrypoint remains the production path. The synthetic path must compare `github.actor` with `github.repository_owner` and fail before issue lookup or mutation when they differ. Owner-only execution is a governance control against repository issue spam, not a limitation inherent to GitHub issue mutation.
- R8. When no matching synthetic issue is open, a synthetic run must create exactly one issue.
- R9. When exactly one matching synthetic issue is open, a synthetic run must comment on it and must not create another issue.
- R10. Each synthetic mutation must surface the exact issue number and URL, then fetch that same issue and its comments from GitHub before reporting success. Comment-path success requires the returned comment body to contain the current workflow run URL; missing or stale readback fails closed.
- R11. The synthetic issue remains open after the two-run proof until A1 closes it manually.

**Deterministic coverage**

- R12. Local tests must exercise the same create-versus-comment decision behavior used by the workflow.
- R13. Local tests must cover zero, one, and multiple matching issues; production-versus-synthetic isolation; unauthorized synthetic invocation; and exact-object readback requirements.
- R14. Deterministic coverage must stay narrow, execute the same create-versus-comment decision logic used by the workflow, and avoid a workflow emulator or generalized issue-testing framework.

---

## Acceptance Examples

- AE1. **Covers R7.** Given a non-owner manually starts synthetic validation, when the workflow evaluates authorization, it fails before issue lookup or mutation.
- AE2. **Covers R2, R3, R4, R8, R10.** Given no synthetic test issue is open and a production alert issue may exist, when the owner runs synthetic validation, exactly one synthetic issue is created, its number and URL are read back, and the production issue is untouched.
- AE3. **Covers R2, R3, R4, R9, R10.** Given one synthetic test issue is open, when the owner runs synthetic validation again, that exact issue receives one run-specific comment, the issue and comment are read back, and no second synthetic issue is created.
- AE4. **Covers R3, R4.** Given multiple open issues match the complete synthetic identity, when validation runs, it fails without mutating any issue.
- AE5. **Covers R1, R5, R6.** Given synthetic validation runs twice, when both runs finish, no Release run was started, no package was published, production Release Alert behavior is unchanged, the workflow remains checkout-free, and token permissions remain `issues: write` with every other scope disabled.
- AE6. **Covers R11.** Given the two-run proof succeeds, when validation is complete, the synthetic issue remains available for inspection until the owner closes it manually.

---

## Success Criteria

- Deterministic tests detect regressions in create, comment, dedupe, ambiguity handling, isolation, owner-only behavior, and exact-object verification before merge.
- Two owner-triggered synthetic runs produce one issue and one follow-up comment, with GitHub API readback proving the exact object changed and no production alert mutation.
- The live proof requires no failed Release run, package publication, new secret, or elevated permission.
- The synthetic issue can be inspected and then closed manually without additional workflow lifecycle behavior.

---

## Scope Boundaries

- No intentional Release failure or package publication for validation.
- No change to the production issue identity or Release-failure trigger.
- No automated closing, cleanup dispatch, or workflow-managed synthetic issue lifecycle beyond create and comment; manual close remains part of the operator procedure.
- No generalized GitHub issue-testing framework for unrelated workflows.
- No attempt to validate every Release workflow branch through this capability.

---

## Key Decisions

- **Local and live validation:** deterministic tests cover decision logic, while synthetic dispatch proves GitHub permissions and issue mutation behavior.
- **Same-workflow entrypoint:** `workflow_dispatch` lives on Release Alert and selects only the synthetic path; `workflow_run` retains production failure handling.
- **Separate synthetic identity:** production and test issues cannot collide even when both are open.
- **Conjunctive, fail-closed matching:** title, label, and marker must all match; ambiguity never selects an arbitrary issue.
- **Owner-only mutation:** `github.actor` must equal `github.repository_owner` before lookup or mutation so synthetic validation cannot become a collaborator-accessible issue-spam endpoint.
- **Least-privilege token:** both paths stay on `GITHUB_TOKEN` with only the existing `issues: write` scope; preserving the checkout-free workflow avoids granting `contents: read` merely to load repository code.
- **Minimal test seam:** local tests execute the workflow's actual create-versus-comment decision logic without adding a checkout, dependency installation, workflow emulator, or reusable issue framework.
- **Exact-object proof:** success requires the issue number/URL plus API readback of the same issue and run-specific comment.
- **Manual cleanup:** preserving the test issue after the second run keeps evidence inspectable and avoids carrying cleanup-only workflow code.

---

## Dependencies / Assumptions

- Release Alert retains only `issues: write` on `GITHUB_TOKEN`; every other scope remains disabled.
- GitHub continues to restrict manual workflow dispatch to actors with repository write access; the workflow still enforces the stricter owner-only requirement itself.
- Bot-authored synthetic issues remain excluded from Fro Bot's issue-triggered work by its existing bot-author guard.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R10][Technical] What bounded retry budget should exact-comment readback use for GitHub API propagation before failing closed?

---

## Sources / Research

- `.github/workflows/release-alert.yaml` — current production issue create/update behavior.
- `.github/workflows/release.yaml` — Release trigger and package publication boundary.
- `.github/workflows/fro-bot.yaml` — bot-authored issue exclusion.
- `packages/cli/src/conventions.test.ts` — existing executable workflow conventions.
- Issue #1209 and Release run `33142690493` — live proof of the production issue-create branch.
- `docs/solutions/workflow-issues/approval-gated-run-cancellation-2026-09-02.md` — precedent for live runtime verification after static checks pass.
