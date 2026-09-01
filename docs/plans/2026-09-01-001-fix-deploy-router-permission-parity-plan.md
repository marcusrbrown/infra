---
title: 'fix: Restore deploy router and guard reusable-workflow permission parity'
type: fix
status: active
date: 2026-09-01
---

# fix: Restore deploy router and guard reusable-workflow permission parity

## Overview

The `Deploy` router has failed at startup on every push to `main` since PR #1223 merged, blocking all push-triggered app deploys for roughly two days. The cause is a caller/callee permission mismatch introduced by that PR. This plan restores the router first, then adds an executable guardrail so the same class of mismatch fails locally instead of at GitHub's startup validation.

## Problem Frame

PR #1223 added a `supersede` job to `.github/workflows/deploy-dashboard.yaml` declaring job-level `permissions: {actions: write}`. That workflow is invoked by `.github/workflows/deploy.yaml` via `uses: ./.github/workflows/deploy-dashboard.yaml`. The router declares workflow-level `permissions: {contents: read}`, and its `deploy-dashboard` caller job declares no `permissions:` block — so the reusable call is capped below what the callee demands. GitHub rejects the entire run at startup validation with zero jobs created and the generic message "This run likely failed because of a workflow file issue."

Because the failure is at the router, **no app is deployable via push** — not just the dashboard. Issue #1227 confirms gateway, vpn, cliproxy, and dashboard are all running behind `main`.

Three pieces of evidence make the diagnosis decisive:

1. **In-repo control.** The `deploy-gateway` caller job declares `permissions: {contents: read, packages: write}` to match its callee's job-level permissions, and it works. Identical mechanism, correctly wired.
2. **Discriminator.** Standalone `workflow_dispatch` of `deploy-dashboard.yaml` succeeds (5/5 recent runs) because no caller caps it. Every router run since the merge fails (16+ consecutive). Same file, same job graph — only the invocation path differs.
3. **Validation timing.** All failures are on `push`, where `supersede`'s `if: github.event_name == 'workflow_dispatch'` guarantees the job is skipped. The run still fails, so permission validation happens before `if:` evaluation. A guard cannot avoid this.

If the router still fails after Unit 1, the next suspects in order are: another caller job whose grant is capped below its callee's demands, a callee workflow-level block exceeding its caller, a nested reusable-workflow call introduced later, and a non-permission parse or wiring error in `deploy.yaml` itself. The permission cap is the confirmed cause of the failures observed so far, not a guarantee that no second cause exists.

Local gates could not catch it. `actionlint` has no documented cross-workflow permission-cap checking, and the repo's own `conventions.test.ts` asserted the *opposite* invariant — that the caller job must have no `permissions:` block, on the rationale "(no GITHUB_TOKEN used)", which #1223 silently falsified.

## Requirements Trace

- R1. Push-triggered deploys through `deploy.yaml` start and reach their per-app approval gates again.
- R2. The dashboard supersede capability from #1223 keeps working on dispatch, unchanged in design.
- R3. A caller/callee permission mismatch fails in the local test suite rather than at GitHub startup.
- R4. The elevated `actions: write` scope does not reach the dashboard deploy job.
- R5. The diagnostic signature is recorded so the next occurrence is identified from symptoms rather than re-derived.

## Scope Boundaries

- The `supersede` job's design, its `if:` guard, and the job-level concurrency placement from #1223 are not revisited. They are correct; only the permission wiring was wrong.
- No new CI tooling, actionlint configuration, or workflow-linting dependency.
- No changes to any app's deploy logic.

### Deferred to Separate Tasks

- **Recovering stranded deploys** (gateway, vpn, cliproxy, dashboard running behind `main`): operator action once Unit 1 lands — re-dispatch or approve through the existing gates. Not a code change.
- **Closing issue #1234** ("dashboard: manual deploy run stuck in waiting"): appears already resolved per the #1227 update; needs operator confirmation.
- **Least-privilege audit of caller grants** (asserting callers grant no *more* than callees demand): a narrower invariant than R3 and more brittle; revisit only if over-granting appears.

## Context & Research

### Relevant Code and Patterns

- `.github/workflows/deploy.yaml` — the router. Workflow-level `permissions: {contents: read}`; seven reusable-workflow calls. The `deploy-gateway` caller job is the correct-wiring precedent to mirror.
- `.github/workflows/deploy-dashboard.yaml` — callee. Workflow-level `permissions: {contents: read}`; `supersede` job carries `permissions: {actions: write}`; `deploy-dashboard` job carries none.
- `packages/cli/src/conventions.test.ts` — the repo's executable convention enforcement. Reads workflows ad hoc via `listWorkflowFiles`/`parseYaml` against `REPO_ROOT`; no shared parsed-workflow cache.
- `findCrossOrgSecretsInherit` in `packages/cli/src/conventions.test.ts` — the existing precedent for walking `jobs[*].uses` to enforce a cross-workflow invariant. The parity walker should mirror this shape.
- `packages/cli/src/commands/agent/workflow-verify.ts` — a static workflow verifier, but aimed at validating a *consumer repository's* workflow from the CLI, not at repo self-checks.

### Permission wiring inventory (current state)

| Caller job in `deploy.yaml` | Caller grant | Callee | Callee job-level demands |
| --- | --- | --- | --- |
| `deploy-keeweb` | inherits `contents: read` | `deploy-keeweb.yaml` | none |
| `deploy-cliproxy` | inherits `contents: read` | `deploy-cliproxy.yaml` | none |
| `deploy-gateway` | explicit `contents: read`, `packages: write` | `deploy-gateway.yaml` | `build-images`: `contents: read`, `packages: write` |
| `deploy-umami` | inherits `contents: read` | `deploy-umami.yaml` | none |
| `deploy-vpn` | inherits `contents: read` | `deploy-vpn.yaml` | none |
| `deploy-dashboard` | inherits `contents: read` | `deploy-dashboard.yaml` | `supersede`: `actions: write` — **mismatch** |
| `deploy-broker` | inherits `contents: read` | `deploy-broker.yaml` | none |

Dashboard is the only mismatch. There are no reusable-workflow calls outside `deploy.yaml`.

### Institutional Learnings

- `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md` — **records this exact rule already**: a called reusable workflow's permissions are capped by the caller, and granting only in the callee is insufficient. The knowledge existed in June and the mistake recurred in August, which is the case for an enforceable gate rather than another document.
- `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md` — per-app concurrency belongs inside the app workflow, not the aggregate router. #1223's move of concurrency to the callee's deploy job is consistent with this; the plan must not undo it.
- `docs/solutions/integration-issues/npm-publish-stacked-auth-failures-2026-08-23.md` — cross-system contracts need explicit assertions; runtime logs alone cannot separate stacked causes.
- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — a green check is not proof of the intended contract; verify the effective behavior.

### External References

- [Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations) — "The `GITHUB_TOKEN` permissions passed from the caller workflow can be only downgraded (not elevated) by the called workflow."
- [Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) — GitHub's own example declares `permissions:` on the caller job.
- [actionlint](https://github.com/rhysd/actionlint) — documents reusable-workflow input/output/secret checking; no documented permission-cap validation across the call boundary.

Documentation is silent on the *failure mode* (startup rejection vs. silent downgrade) and on validation timing. Both are settled here empirically, not by citation.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "build-new-within-scope",
  "scope": "packages/cli/src/conventions.test.ts, .github/workflows/deploy.yaml, .github/workflows/deploy-*.yaml, packages/cli/src/commands/agent/workflow-verify.ts",
  "freshness": {
    "vcs_reference": "5d4dc36d0fe57184621eee9798ba98fdb096d3d8"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/cli/src/conventions.test.ts::findCrossOrgSecretsInherit",
      "description": "walks workflow jobs and flags cross-org reusable-workflow calls using `secrets: inherit`",
      "disposition": "insufficient",
      "insufficiency_reason": "Enforces a different invariant (secrets inheritance across orgs) and inspects only the caller side; it never resolves the callee file. Its traversal shape is the pattern to mirror, but no logic is reusable."
    },
    {
      "path_or_symbol": "packages/cli/src/conventions.test.ts::deploy.yaml fan-out secret tests",
      "description": "asserts `deploy.yaml` caller jobs forward specific named secrets into reusable workflows",
      "disposition": "insufficient",
      "insufficiency_reason": "Hardcodes individual secret names per caller job rather than deriving demands from the callee; it cannot generalize to permissions and would need one hand-written assertion per scope per caller."
    },
    {
      "path_or_symbol": "packages/cli/src/commands/agent/workflow-verify.ts",
      "description": "static verifier for a consumer repository's fro-bot workflow job-split, environment gate, and reachability",
      "disposition": "insufficient",
      "insufficiency_reason": "A user-facing CLI command that validates an external repository's workflow as an operator action. Repo self-check invariants live in the conventions test suite; coupling them to a shipped CLI command would widen its published surface for an internal concern."
    }
  ]
}
```

## Key Technical Decisions

- **Grant on the caller job, mirroring `deploy-gateway`.** This is both the repo's existing precedent and GitHub's documented pattern. The alternative — restructuring so the reusable workflow never demands elevated scope — would mean relocating `supersede` out of the callee, undoing working #1223 design during an active outage.
- **Include `contents: read` alongside `actions: write`.** Job-level `permissions:` replaces the workflow-level block rather than merging with it. Granting `actions: write` alone would drop `contents` to none for the whole call.
- **The elevated scope stays confined to `supersede`.** The caller grant is a ceiling, not an assignment. The callee's workflow-level `permissions: {contents: read}` keeps every job without an explicit block at read-only, so `actions: write` is held solely by `supersede` — the deploy job never sees it (R4). The existing assertion that the callee's `deploy-dashboard` job has no job-level `permissions:` is what preserves this and must stay.
- **Invert the caller-permissions test rather than delete it.** `conventions.test.ts` asserts the caller has no `permissions:` block, justified as "(no GITHUB_TOKEN used)". #1223 made that premise false. The test should assert the grant that is now required, so the invariant remains pinned in the direction that matters.
- **Rollback was considered and rejected.** Reverting #1223 outright would also restore the router, and would shed CI surface area rather than add to it. It is rejected because it reintroduces the stale-approval backlog that #1223 exists to fix — six dashboard releases in three days piling up behind one unapproved run — and trades a known one-block fix for re-litigating a solved problem. Reverting remains the fallback if Unit 1 does not restore the router.
- **The guardrail belongs in `conventions.test.ts`, not `workflow-verify.ts`.** The prior-art survey initially proposed extending the CLI verifier; that command exists to validate an external consumer repository on operator demand. This is a repo self-check and belongs with the other executable conventions.

## Open Questions

### Resolved During Planning

- **Can `supersede`'s `if:` guard avoid the failure?** No. Every failing run is a `push`, where the guard guarantees a skip, and the run still fails with zero jobs. Validation precedes condition evaluation.
- **Does the router's workflow-level `permissions:` apply to reusable calls?** Yes, empirically: five callees run correctly on the inherited `contents: read`, and gateway needed an explicit additive block only because it demanded more. GitHub's documentation is loosely worded here; repo behavior is unambiguous.
- **Are there other latent mismatches?** No. The inventory above covers all seven calls; dashboard is the only one.
- **Is another solution document sufficient?** No. The rule was already documented in June 2026 and the mistake recurred anyway.
- **Should the parity walker count the callee's workflow-level `permissions:` as a demand?** Yes. Documentation does not settle whether a callee workflow-level block exceeding its caller also fails. The walker takes the conservative reading and counts both layers — omitting workflow-level demands would leave a whole mismatch class uncovered for the sake of an unverified distinction.
- **Can Unit 1 be verified before merge?** Yes. `deploy.yaml` carries a `workflow_dispatch` trigger, so a branch-scoped dispatch exercises real startup validation against the branch's copy of both router and callee.

### Deferred to Implementation

- **The exact scope-ordering helper.** Comparison needs an ordering over `none` < `read` < `write`, plus handling for the `read-all`/`write-all` shorthand forms. Shape it against the real files rather than pre-specifying.

## Implementation Units

- [ ] **Unit 1: Restore router permission parity**

**Goal:** Push-triggered deploys start again. This is the production restore and should land on its own.

**Requirements:** R1, R2, R4

**Dependencies:** None

**Files:**
- Modify: `.github/workflows/deploy.yaml`
- Modify: `packages/cli/src/conventions.test.ts`

**Approach:**
- Add a `permissions:` block to the `deploy-dashboard` caller job granting `contents: read` and `actions: write`, placed and formatted to match the `deploy-gateway` caller job.
- Replace the assertion that the caller job has no `permissions:` block with one asserting it grants exactly the scopes the callee demands. Update the test name and its parenthetical rationale — the old text states a premise that is no longer true.
- Change nothing in `.github/workflows/deploy-dashboard.yaml`.

**Patterns to follow:**
- The `deploy-gateway` caller job in `.github/workflows/deploy.yaml` — same block shape, same placement relative to `if:` and `uses:`.

**Test scenarios:**
- Happy path: the `deploy-dashboard` caller job in `deploy.yaml` grants `actions: write` and `contents: read`.
- Regression: the callee's `deploy-dashboard` job still declares no job-level `permissions:`, so the elevated scope stays confined to `supersede`.
- Regression: the callee's workflow-level `permissions: {contents: read}` is unchanged.
- Regression: the `supersede` job's own permissions, event guard, and the deploy job's `needs` are unchanged from #1223.

**Verification:**
- The full suite passes locally.
- Pre-merge: push the branch and run `gh workflow run deploy.yaml --ref <branch>`. Jobs being created at all is the proof — startup validation passed. A router dispatch fans out to every app caller, so the resulting runs park at their Environment approval gates and should be cancelled rather than approved.
- After merge, the router run on the merge commit creates jobs and reaches the dashboard approval gate instead of `startup_failure`.

- [ ] **Unit 2: Guard caller/callee permission parity**

**Goal:** Any future callee job demanding a scope its caller does not grant fails the test suite.

**Requirements:** R3

**Dependencies:** Unit 1 (the repo must satisfy the invariant before it is enforced)

**Files:**
- Modify: `packages/cli/src/conventions.test.ts`

**Approach:**
- Add a helper that walks every job in `deploy.yaml` with a local `uses: ./.github/workflows/*.yaml`, resolves the callee file, and compares its demands against the caller job's effective grant (its explicit block, else the router's workflow-level block).
- Treat the callee's demand for each scope as the maximum of its workflow-level and job-level blocks. A workflow-level block exceeding the caller would fail the same way, and counting only job-level demands would leave that class uncovered.
- Mirror the traversal shape of `findCrossOrgSecretsInherit` rather than introducing a new parsing approach.
- Report every mismatch in one assertion failure with caller job, callee file, scope, demanded level, and granted level — a bare boolean would leave the next reader diagnosing from scratch, which is the exact failure this unit exists to prevent.

**Test scenarios:**
- Happy path: the current repo passes with zero mismatches.
- Edge case: a caller with an explicit `permissions:` block is evaluated against that block, not the workflow-level default.
- Edge case: scope ordering — a callee demanding `read` is satisfied by a caller granting `write`; a callee demanding `write` is not satisfied by `read`.
- Edge case: a callee whose *workflow-level* block demands an ungranted scope is detected, not only job-level demands.
- Error path: a synthetic callee demanding an ungranted scope is detected, and the message names the caller job, callee file, and scope.
- Regression: a callee with no permission blocks at all produces no finding.

**Verification:**
- Removing the `permissions:` block added in Unit 1 makes this test fail with a message identifying the dashboard caller and the `actions` scope.

- [ ] **Unit 3: Record the diagnostic signature**

**Goal:** The next occurrence is recognized from symptoms rather than re-derived over two days.

**Requirements:** R5

**Dependencies:** Unit 1

**Files:**
- Create: `docs/solutions/workflow-issues/reusable-workflow-permission-parity-startup-failure-2026-09-01.md`

**Approach:**
- Follow the frontmatter convention of neighbouring files in that directory.
- Lead with the *signature*, because that is the part that was expensive: `startup_failure`, zero jobs created, generic "workflow file issue" message, both files parsing cleanly, actionlint reporting nothing, and the callee succeeding under direct `workflow_dispatch` while failing under `workflow_call`.
- Record that the underlying rule was already documented in the June 2026 gateway best-practice note, and cross-reference it — the gap was enforcement, not knowledge.
- Note that `if:` guards do not avoid the failure, since validation precedes condition evaluation.

**Test expectation:** none — prose documentation with no behavioral change.

**Verification:**
- Lint passes (markdown formatting is covered).
- The document names the observable symptoms before the cause, so it is findable from the symptom.

## System-Wide Impact

- **Interaction graph:** `deploy.yaml` is the single entry point for all seven app deploys. A startup failure there blocks every app, which is why a dashboard-scoped change caused a repo-wide outage. Any future callee-side permission change carries the same blast radius.
- **Error propagation:** Startup validation failures produce no job logs and a generic message. There is no runtime signal to diagnose from — only the run conclusion and the workflow diff.
- **API surface parity:** None. No CLI, MCP, or deploy-script surface changes.
- **Integration coverage:** The parity guardrail is a static check. It cannot prove GitHub accepts the workflow; only a real router run does that.
- **Unchanged invariants:** The `supersede` job design and its event guard; job-level concurrency placement in the callee (required by the June 2026 aggregate-concurrency learning); the callee's workflow-level `contents: read`; the callee `deploy-dashboard` job having no job-level permissions; all per-app Environment approval gates.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Granting `actions: write` widens the router's dashboard call | The callee's workflow-level `contents: read` confines it to `supersede`; the existing assertion that the deploy job has no job-level block keeps that true, and Unit 1 re-asserts it |
| Local tooling cannot detect this failure mode | Verified pre-merge by dispatching the router on the branch (see Unit 1). `actionlint` has no cross-workflow permission-cap check, so the branch dispatch substitutes for a local gate |
| A branch dispatch fans out to all seven app callers | The resulting runs hold at their Environment approval gates and are cancelled rather than approved, so no deploy occurs |
| The parity guardrail produces false positives on future legitimate wiring | Keep the invariant to exactly "callee demands must be granted by the caller"; do not also enforce least privilege (deferred above) |
| Another mismatch is latent somewhere | The inventory shows none today; Unit 2 converts this from a one-time audit into a standing check |
| The guardrail encodes a mis-inferred rule | The comparison direction is confirmed by GitHub documentation and by the in-repo gateway control; the ambiguous part (callee workflow-level demands) is called out as a deferred decision rather than guessed |

## Documentation / Operational Notes

- After Unit 1 merges, the stranded deploys need operator action through the existing approval gates. Issue #1227 lists gateway, vpn, cliproxy, and dashboard as behind `main`.
- Issue #1227 should close referencing Unit 1; issue #1234 needs separate operator confirmation.
- The dashboard supersede behavior from #1223 remains unverified in production — it has never run through the router. The first successful router-driven dashboard deploy is its first real exercise.

## Sources & References

- Issue: #1227 (deploy router startup failure), #1234 (dashboard run stuck waiting)
- Introducing PR: #1223 (`d961e1f`)
- Related code: `.github/workflows/deploy.yaml`, `.github/workflows/deploy-dashboard.yaml`, `packages/cli/src/conventions.test.ts`
- Prior learning: `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`
- Prior learning: `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md`
- External: [Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
