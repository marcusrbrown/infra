---
title: 'fix: cliproxy setup gate reliability (F3 concurrency, F4 transient-empty)'
type: fix
status: completed
date: 2026-05-27
origin: 'GitHub issue #311 (ce:review run 20260527-094713-8fe918ca)'
---

# fix: cliproxy setup gate reliability (F3 concurrency, F4 transient-empty)

## Overview

The `cliproxy setup` command reads a repo's existing GitHub secret/variable names
(`listExistingGhNames`) and uses that list to drive two safety gates before writing:

1. The **ack-key-reuse gate** — fires when `existingSecrets.includes('OPENCODE_AUTH_JSON')`.
2. The **collision gate** — `collectCollisions` blocks (non-interactive) or prompts
   (interactive) when a write would overwrite an existing name.

Both gates trust the pre-write list. The ce:review of PR #312 surfaced two reliability
findings against that trust:

- **F4** — When `gh secret list` returns an empty list on a *successful* (zero-exit)
  invocation that is nonetheless unreliable — token scope blindness, eventual-consistency
  lag — both gates silently disable themselves and the destructive write proceeds with no
  acknowledgment. (The hard-failure path is already safe: `listExistingGhNames` throws on
  non-zero `gh` exit, so a network error or auth failure fails closed today.)
- **F3** — Two operators running `setup` against the same repo concurrently both read a
  stale/empty list, both pass the gates, both write `OPENCODE_AUTH_JSON`, last-write-wins.
  GitHub's secrets API is write-only and offers no lock or compare-and-swap, so there is no
  primitive to make this safe.

This plan closes the practical F4 window with a post-write readback verification and
treats F3 as an accepted, documented limitation with a targeted warning where a destructive
overwrite is already being flagged.

## Problem Frame

Origin: issue #311, the consolidated ce:review follow-up hub for the cliproxy setup
refactor. F3 and F4 are the two P1 reliability items the issue flags for individual
treatment. Research (repo-research-analyst + learnings-researcher, 2026-05-27) narrowed both:

- **F4's catastrophic path already fails closed.** `listExistingGhNames`
  (`packages/cli/src/commands/cliproxy/setup/gh.ts`) runs `gh <kind> list --repo <repo>
  --json name`; on non-zero exit it throws `Unable to list existing GitHub ${kind}s`. The
  residual risk is exclusively the **zero-exit-empty** case: `gh` succeeds but the returned
  list does not reflect reality (scope-limited token, replication lag).
- **F4's readback can catch the token-scope-blindness sub-case but not the
  pre-existing-clobber sub-case.** After we write `OPENCODE_AUTH_JSON`, re-listing and not
  seeing it proves the token's list view is unreliable (it cannot see a secret we just
  wrote) — so the pre-write empty that disabled the gates was untrustworthy. It cannot prove
  whether a *different* value existed before our write (the name is present on readback
  either way). The readback materially shrinks the window without claiming to close it.
- **F3 has no clean primitive.** Write-only secrets, no lock/CAS. Post-write readback cannot
  detect a concurrent clobber because after our write the value is ours and values are not
  readable. Last-write-wins is inherent. Learnings search found zero prior art on optimistic
  concurrency for GitHub secrets.

The strongest local precedent is the F1 fix already shipped in PR #312:
`parseManagementKeyList` in `packages/cli/src/commands/cliproxy/shared.ts` — "never returns
`[]` on malformed input; mutating callers must fail loud." F4 applies the same philosophy at
the GitHub-list boundary: an empty list that drives a destructive decision must be
corroborated, not blindly trusted.

## Requirements Trace

- R1. (F4) After a successful write, verify the written names are visible on a fresh
  `listExistingGhNames` readback — for BOTH secrets (`plan.template.secrets`) and variables
  (`plan.template.variables`), since both gates rely on the same list view. When one or more
  written names are absent on a *successful* readback (verified mismatch), emit a loud,
  actionable warning that the token's list view is unreliable and the pre-write safety gates
  may have been bypassed — directing the operator to verify manually. Distinguish this from
  the *cannot-verify* case (the readback `gh` call itself failed), which emits a softer
  "could not verify written values are visible" warning — a weaker signal than a confirmed
  mismatch.
- R2. (F4) The entire post-write verification block — readback calls, set-difference
  computation, AND warning emission — must not throw and must not trigger the key-creation
  rollback path. The writes already succeeded; any failure inside verification is a warning,
  never a destructive unwind. Guarding only the `gh` call is insufficient: a throw during
  diff computation or log formatting would still reach the `mutationError` rollback.
- R3. (F4) The happy path (readback confirms all written names present) emits no new output
  and does not alter existing success messaging.
- R4. (F3) The non-interactive `--force` overwrite warning states that concurrent `setup`
  runs against the same repo are not coordinated and resolve last-write-wins.
- R5. (F3) `packages/cli/AGENTS.md` documents the concurrency boundary AND is explicit that
  the overwrite-site warning only covers the *detected-collision* path — the fresh-run race
  (two concurrent runs both seeing an empty list, neither detecting a collision) produces NO
  runtime signal and is mitigated solely by operator coordination. The docs must not imply
  the warning protects fresh concurrent runs. The transient-empty caveat is documented as a
  known limitation that Unit 1's post-write readback surfaces as a warning.

## Scope Boundaries

- No locking, mutex, or compare-and-swap for GitHub secret writes — the API offers none.
- No pre-write token-scope probe (the post-write readback covers the same blindness more
  cheaply and after the fact, which is sufficient for a warning).
- No change to the hard-error path of `listExistingGhNames` — it already throws and
  fails closed.
- No change to the ack-key-reuse gate or collision gate decision logic themselves — F4 adds
  a *post-write corroboration*, it does not move the gates.
- No new CLI flags. (The `--fresh-repo` acknowledgment flag considered during planning was
  rejected: it burdens every genuine fresh-repo `--key` setup to cover a rare window the
  readback already surfaces.)

### Deferred to Separate Tasks

- F11/F15/F16 (type-safety + DI hardening): separate `ce:work` bundle, tracked in #311.
- F17/F24 (advisory docs): separate small docs PR, tracked in #311.
- F13/F23 (smoke-test misattribution, rollback orphan-key hint): comments-only per #311;
  not in this plan.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/cliproxy/setup.ts` — `runSetupCommand`. The pre-write list read
  is `gh.withGhRetry('Checking existing GitHub secrets and variables', () =>
  Promise.all([listExistingGhNames(repo,'secret'), listExistingGhNames(repo,'variable')]))`.
  The write loop is `gh.withGhRetry('Writing GitHub secrets and variables', ...)` iterating
  `plan.template.secrets` / `plan.template.variables` through `applyGhValue`. The
  non-interactive `--force` overwrite warning is `log.warn('Overwriting existing GitHub
  values: ...')`.
- `packages/cli/src/commands/cliproxy/setup/gh.ts` — `listExistingGhNames(repo, kind)` throws
  on non-zero exit (`gh.ts:173-176`); `withGhRetry` retries only rate-limit errors
  (`gh.ts:97-114`). `applyGhValue` pipes secret bytes via stdin.
- `packages/cli/src/commands/cliproxy/shared.ts` — `parseManagementKeyList` (the F1
  fail-closed precedent): strict parse, never coerces unknown shapes to `[]`.
- `packages/cli/src/commands/cliproxy/setup.test.ts` — `runSetupCommand` action-handler tests
  with the DI surface (`gh`, `prompts`, `smoke`, `validation`, `ctx`). `makeCtx()` returns
  `{ctx, logs, errors}`. `makeSpinner()` and `autoPromptValue` helpers exist.

### Institutional Learnings

- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — for
  `gh secret set`, verify the stored value structurally rather than trusting a success
  signal; don't "just retry" when the real problem is data the command can't see. Directly
  endorses the F4 write→readback approach.
- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — guards must
  not silently pass on bad data; missing/unreliable inputs should fail loudly rather than
  degrade into a misleading "nothing to do" state.

### External References

- None. Internal gate control flow over the `gh` CLI and our own helpers; strong local
  pattern (`parseManagementKeyList`). External research skipped per Phase 1.2.

## Key Technical Decisions

- **Post-write readback over pre-write probe (F4):** Re-list secret and variable names after
  the write and confirm every written name is present. Cheaper than a pre-write token-scope
  probe and catches the same token-blindness failure mode, after the write, as a warning.
  Rationale: the write is idempotent and presumed correct; the only thing in doubt is our
  *visibility*, which a readback measures directly.
- **Warning, not throw; no rollback (F4):** The readback runs after secrets are written. A
  visibility failure must not throw (which would trigger the `keyCreatedByThisRun` rollback
  and delete a key whose secrets are correctly written). Wrap the readback so its own
  `gh`-failure also degrades to the same warning.
- **Verify all written names, secrets AND variables, not just `OPENCODE_AUTH_JSON` (F4):** A
  missing-any signal is strictly stronger and costs nothing extra — we already hold
  `plan.template.secrets` and `plan.template.variables`. The collision gate uses both lists,
  so corroborating only secrets would leave the variable side of the gate uncorroborated.
- **Distinguish "verified mismatch" from "cannot verify" (F4):** A successful readback that
  omits a written name is a strong signal (the token's list view is provably unreliable). A
  readback whose `gh` call fails is a weaker "could not verify" signal. Both warn and neither
  throws, but the wording differs so the operator can gauge severity.
- **F3 warning does NOT cover the fresh-run race (F3):** Attaching the concurrency note to the
  overwrite-warning site only surfaces it when a collision is already detected. The actual
  race — two fresh runs both seeing an empty list, neither detecting a collision — fires no
  overwrite warning and therefore no runtime signal. This is an accepted limitation, not a
  mitigation; the plan documents it honestly rather than implying the warning guards fresh
  concurrent runs. A per-run advisory was rejected as noise on every clean run; the residual
  fresh-run race is mitigated solely by operator coordination (documented in AGENTS.md).
- **F3 is accept + document, with the warning placed where overwrite is already flagged:**
  Rather than a per-run advisory (noise on every clean run), extend the existing
  non-interactive `--force` overwrite `log.warn` to name the concurrency hazard, and document
  the full boundary in AGENTS.md. A destructive overwrite is the exact moment the operator
  should hear "this is last-write-wins; don't run two at once."

## Open Questions

### Resolved During Planning

- Should F4 add a `--fresh-repo` acknowledgment flag? No — rejected as over-burdensome for a
  rare window the post-write readback already surfaces. (See Scope Boundaries.)
- Should F3 get post-write reconciliation / concurrent-writer detection? No — readback cannot
  detect a concurrent clobber on write-only secrets; detection would be heuristic and weak.
  Accept + document.
- Where does the F4 readback live? After the "Writing GitHub secrets and variables"
  `withGhRetry` block, before `assertProxyKeyWorks`, inside its own try/catch that degrades
  to a warning.

### Deferred to Implementation

- Exact helper name and signature for the readback verification (inline vs. small named
  helper in `setup.ts`). Decide when touching the code; favor a named helper for testability.
- Whether the readback reuses the injected `gh.listExistingGhNames` (it should, for DI
  testability) — confirm the `RunSetupDeps.gh` surface already exposes it (it does).

## Implementation Units

- [x] **Unit 1: F4 post-write readback verification**

**Goal:** After a successful write, re-list secret AND variable names and warn loudly if any
written name is not visible, signaling an unreliable token list view that may have bypassed
the pre-write gates. Distinguish a verified mismatch (readback succeeded, name absent) from a
cannot-verify case (readback call failed).

**Requirements:** R1, R2, R3

**Dependencies:** None (builds on the shipped PR #312 structure).

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- After the `gh.withGhRetry('Writing GitHub secrets and variables', ...)` block and before
  `assertProxyKeyWorks`, add a readback step (favor a small named helper for testability,
  e.g. `verifyWrittenSecretsVisible`).
- Compute written names from `plan.template.secrets.map(s => s.name)` and
  `plan.template.variables.map(v => v.name)`. Re-list via the injected
  `gh.listExistingGhNames(plan.repo, 'secret')` and `gh.listExistingGhNames(plan.repo,
  'variable')`. Compute the per-kind set difference. Verifying both kinds matters because the
  collision gate uses both lists — corroborating only secrets leaves the variable side
  uncorroborated.
- Verified mismatch (readback succeeded, a written name absent): emit a loud warning naming
  the absent names per kind, directing the operator to verify manually (`gh secret list
  --repo <repo>` / `gh variable list --repo <repo>`), and stating the pre-write gates rely on
  the same list view and may have been bypassed. Use `log.warn` (warning, not failure — do
  NOT throw).
- Cannot verify (a readback `gh` call failed): emit a softer, distinctly-worded "could not
  verify written values are visible" warning so the operator can gauge that this is weaker
  than a confirmed mismatch.
- The non-throw guard must wrap the ENTIRE verification block — both readback calls, the
  set-difference computation, AND warning emission — not just the `gh` calls. A throw during
  diff or log formatting would otherwise reach the `mutationError` rollback and wrongly delete
  a key whose secrets are written. Guarding only the `gh` call is insufficient.
- Do not alter the existing success messaging on the happy path.

**Patterns to follow:**
- `parseManagementKeyList` fail-loud philosophy in
  `packages/cli/src/commands/cliproxy/shared.ts`.
- The existing `withGhRetry` / `log.warn` usage already in `runSetupCommand`.
- DI via `RunSetupDeps.gh.listExistingGhNames` for test injection.

**Test scenarios:**
- Happy path: pre-write list `[]`, write succeeds, post-write readback returns all written
  secret AND variable names → no new warning emitted; success path unchanged.
- Token-scope blindness (secret): pre-write `[]`, write succeeds, secret readback still
  missing `OPENCODE_AUTH_JSON` → "verified mismatch" warning; assert the text names the absent
  secret, mentions manual verification (`gh secret list`), and states the gates may have been
  bypassed.
- Token-scope blindness (variable): secret readback shows all written secrets, but the
  variable readback is missing a written variable name (e.g., `FRO_BOT_MODEL`) → "verified
  mismatch" warning lists the absent variable. (Covers the variable-side gate gap.)
- Partial visibility: readback shows some but not all written names → warning lists exactly
  the absent names per kind.
- Cannot-verify (secret readback gh-fails): injected `listExistingGhNames` throws on the
  post-write secret call → "could not verify" warning (distinct wording from verified
  mismatch), command does NOT throw, `deleteManagementApiKey` NOT called (assert via spy).
- Whole-block guard: a throw is injected during warning emission / diff path (not just the
  `gh` call) → still degrades to a warning, command does NOT throw, rollback NOT fired.
- Existing-secret + acknowledged path unaffected: pre-write list shows `OPENCODE_AUTH_JSON`,
  `--ack-key-reuse` supplied, write succeeds, readback shows all names → no new warning.

**Verification:**
- Verified-mismatch warning fires only when a written secret or variable name is absent on a
  successful readback; cannot-verify warning fires only when a readback `gh` call fails.
- The command never throws or rolls back due to any readback outcome (including a throw in the
  diff/warning path, not just the `gh` call).
- Full suite green; happy-path snapshot/output unchanged.

- [x] **Unit 2: F3 concurrency caveat — warning extension + AGENTS.md documentation**

**Goal:** Surface the last-write-wins concurrency hazard where a destructive overwrite is
already flagged, and document the concurrency + transient-empty boundaries as known
operational limitations.

**Requirements:** R4, R5

**Dependencies:** None (independent of Unit 1; can land in the same PR).

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Modify: `packages/cli/AGENTS.md`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- Extend the existing non-interactive `--force` overwrite warning (`log.warn('Overwriting
  existing GitHub values: ...')`) to add one sentence: concurrent `setup` runs against the
  same repo are not coordinated and resolve last-write-wins. Keep it to the existing warning
  site — do not add a per-run advisory that would fire on clean runs.
- In `packages/cli/AGENTS.md`, add a short "Operational limitations" note under the cliproxy
  setup section (or extend the existing migration-recipe area): (a) `setup` is not
  concurrency-safe — don't run it against the same repo from two places at once
  (last-write-wins, no GitHub locking primitive); (b) crucially, state that the overwrite-site
  warning only fires on the *detected-collision* path — the fresh-run race (two concurrent
  runs both seeing an empty list, neither detecting a collision) produces NO runtime signal
  and is mitigated solely by operator coordination. Do not imply the warning protects fresh
  concurrent runs; (c) the transient-empty caveat — a zero-exit empty list can disable the
  safety gates, which Unit 1's post-write readback surfaces as a warning.

**Patterns to follow:**
- Present-tense, current-behavior documentation voice (no "previously/now" framing) per repo
  docs conventions.
- The existing AGENTS.md migration-recipe section added in PR #312.

**Test scenarios:**
- Non-interactive `--force` with collisions present → assert the overwrite warning text now
  includes the concurrency/last-write-wins sentence.
- Non-interactive `--force` with no collisions → assert the concurrency sentence is NOT
  emitted (warning only fires on actual overwrite, no new noise on clean runs). This is the
  fresh-run race path that produces no signal — the test documents that the warning does NOT
  cover it.

**Verification:**
- Overwrite warning carries the concurrency caveat only when an overwrite is actually
  flagged.
- AGENTS.md documents both limitations in present-tense operational language.

## System-Wide Impact

- **Interaction graph:** Unit 1 adds two post-write read-only invocations per setup run
  (`gh secret list` + `gh variable list`). They sit between the write loop and
  `assertProxyKeyWorks`. No effect on the workflow-wiring check or smoke test.
- **Error propagation:** The readback must be a terminal warning, never a thrown error — a
  throw post-write would enter the `catch (mutationError)` rollback and delete the
  just-created key. This is the single most important correctness constraint in the plan.
- **State lifecycle risks:** None added. Secrets are already written before readback; readback
  is observational.
- **API surface parity:** `cliproxy setup` only. No other command reads-then-writes GitHub
  secrets (confirmed by research — `listExistingGhNames` has exactly one caller).
- **Gate coverage parity:** The collision gate uses BOTH secret and variable name lists, so
  the F4 readback corroborates both — verifying only secrets would leave the variable side of
  the gate uncorroborated.
- **F3 fresh-run-race honesty:** The overwrite-site warning fires only on the
  detected-collision path. The fresh-run race (two concurrent runs both seeing an empty list)
  produces no collision and therefore no warning — an accepted, documented limitation, not a
  mitigation. Operator coordination is the only control.
- **Integration coverage:** The readback uses the injected `gh.listExistingGhNames`, so the
  rollback-not-fired assertion must use the DI spy on `deleteManagementApiKey`.
- **Unchanged invariants:** The ack-key-reuse gate and collision gate decision logic are
  unchanged. The hard-error fail-closed behavior of `listExistingGhNames` is unchanged. The
  happy-path output and the dual-provider/anthropic-only byte-identical secret values shipped
  in 0.8.0 are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Readback throw (anywhere in the block, not just the `gh` call) triggers key-deletion rollback | Wrap the ENTIRE verification block — readback calls, diff computation, warning emission — in one try/catch that degrades any failure to a cannot-verify warning; explicit test injects a throw in the warning/diff path and asserts `deleteManagementApiKey` not called. |
| New warning adds noise to legitimate fresh-repo setups | Warning fires only when a written name is absent on a successful readback — a genuine fresh repo readback shows the just-written names, so no warning. |
| Variable-side transient-empty bypasses the collision gate uncorroborated | F4 readback verifies variables as well as secrets; dedicated test covers a stale variable-side list. |
| Operators read the F3 warning as protecting fresh concurrent runs | AGENTS.md states explicitly that the warning only covers the detected-collision path; the fresh-run race has no runtime signal and relies on operator coordination. |
| F4 readback gives false reassurance (cannot detect pre-existing clobber via name presence) | Documented explicitly in AGENTS.md (Unit 2) and in the plan's Problem Frame: readback catches token-scope blindness, not pre-existing-value clobber. The ack-key-reuse gate remains the primary guard for the visible-secret case. |
| F3 fundamentally unsolvable with current GitHub API | Accepted and documented; warning placed at the overwrite site; no false promise of safety. |

## Documentation / Operational Notes

- A **minor changeset** lands with the PR: Unit 1 adds a new user-facing warning to a shipped
  command (`packages/cli/src/` runtime change). Unit 2's AGENTS.md change alone would not
  warrant a changeset, but it ships in the same PR. Changeset describes the F4 readback
  warning and the F3 concurrency caveat in present-tense, current-behavior voice — no plan-ID
  or session taxonomy in the changeset or commit messages.
- Update issue #311: check off F4 and F3 with a one-line note pointing at the merge PR.

## Sources & References

- **Origin:** GitHub issue #311 — cliproxy setup refactor ce:review follow-ups (consolidated).
- ce:review run `20260527-094713-8fe918ca` (synthesis, gitignored).
- Related code: `packages/cli/src/commands/cliproxy/setup.ts`,
  `packages/cli/src/commands/cliproxy/setup/gh.ts`,
  `packages/cli/src/commands/cliproxy/shared.ts`.
- Related learnings: `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`,
  `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`.
- Shipped precedent: PR #312 (`parseManagementKeyList` fail-closed parser).
