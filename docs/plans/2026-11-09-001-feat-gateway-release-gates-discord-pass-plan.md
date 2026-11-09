---
title: "feat: Run gateway release gates without a routine Discord session"
type: feat
status: completed
date: 2026-11-09
origin: docs/brainstorms/2026-11-09-gateway-release-gates-discord-pass-requirements.md
---

# feat: Run gateway release gates without a routine Discord session

## Overview

Rewrite the "Gateway release gates (agent-run)" section of `docs/runbooks/operator-surface-acceptance-automated.md`. After the rewrite, every gateway release runs G1, G3 and G2b's record checks on dashboard-launched runs with no operator. Every check that needs Discord moves into one Discord pass. That pass runs only when the upstream diff touches a written checklist, or when the last pass is three or more upstream refs old. The change is to the runbook, plus at most pointer edits in `docs/runbooks/operator-surface-acceptance.md` and the root `AGENTS.md`. It adds no code and no new files.

## Problem Frame

Every gate starts its runs with an operator `@fro-bot` mention. Gates 2 and 4 also need slash commands, a toggled role, and button clicks. As a result, every release needs a scripted Discord session, even when nothing on the Discord path changed. An agent-held identity can't do these steps. The gateway drops messages written by bots, and Discord accepts slash commands and component clicks only from users. Most Discord checks need staged setup, so passively watching for organic use was rejected (see origin: `docs/brainstorms/2026-11-09-gateway-release-gates-discord-pass-requirements.md`).

## Requirements Trace

- R1. G1 and G3 run on dashboard-launched runs, with no operator action.
- R2. G1.10 reads the reply from the dashboard run, not from a Discord thread.
- R3. G2b's record checks run on a dashboard-launched run. Its thread-notice check moves to the Discord pass.
- R4. The Discord pass contains mention intake and reply, G2a, the G2b thread notice and `run-finished` row, G2c, G2d, and G4a–G4f. It runs in one sitting, with today's steps and pass criteria.
- R5. The Discord pass runs when the upstream diff since its last pass touches Discord handling, shared run, cancel, approval or question code, discord.js, or OpenCode.
- R6. The Discord pass also runs when its last pass is three or more refs old.
- R7. The runbook carries the written R5 checklist. The result records which item triggered the pass, or that none did.
- R8. When the Discord pass doesn't run, each of its checks is reported as not run, with the ref of its last pass.
- R9. A release is a new upstream ref. A same-ref redeploy runs no gates.
- R10. The runbook marks each check as automated or Discord pass, and states the launch-budget timing.

## Scope Boundaries

- Changes to fro-bot/agent, the dashboard, or any infra code. None of these is needed.
- The dashboard browser pass in the same runbook, apart from its launch-budget paragraph. `docs/runbooks/operator-surface-acceptance.md` and the root `AGENTS.md` change only in a pointer sentence each, if at all.
- A second Discord bot, a test guild, the Discord MCP, or passive confirmation (see origin).
- Renaming the `## Gateway release gates (agent-run)` heading. Two documents link to its anchor.

### Deferred to Separate Tasks

- Root `AGENTS.md` lists `GET /operator/runs/:runId` as a live route, but fro-bot/agent v0.136.5 doesn't register it (`packages/gateway/src/server.ts:256-290`). Correct it in a separate docs fix.
- No upstream test covers the gateway dropping bot-written messages (`program.ts:908`). That would be an upstream issue, if wanted.

## Context & Research

### Relevant Code and Patterns

- Runbook section map (`docs/runbooks/operator-surface-acceptance-automated.md`):
  - intro 252–258; Inputs 260–275; Rules 277–288; Helpers 290–361
  - P0–P2 362–414
  - G1 416–498 (G1.10 at 431 and 481–488)
  - G2 500–591 (G2b 543–570, G2c 572–589, G2d 525–541)
  - G3 593–649 (G3.1 launch 609–613)
  - G4 651–696
  - Finish 698–702; Results 704–734 (`Drift:` at 730)
- Dashboard launch pattern: the browser pass's Launch panel and observer snippet (runbook lines 36, 42–63, 84–105). The observer currently keeps only `status` frames (line 100). The browser pass has no repo guard; it only says to select the repository first (line 36).
- Upstream v0.136.5 (`7f7bf89`):
  - Both surfaces converge at `launchWork` (`packages/gateway/src/execute/run.ts:2470`). The ownership ledger, `persistOwnership` and `patchRunDetails` have no surface branch (`run.ts:1093-1172`, `1794-1795`).
  - Restart recovery never reads persisted ownership (`execute/recovery.ts:4-13`). G3.4 passes because a COMPLETED record is never rewritten.
  - The web reply rides the SSE `output` event on `GET /operator/runs/:runId/stream`, as `{runId, text, final, seq}`. `flush()` sends the full buffer with `final: true` (`web/operator/web-sinks.ts:106-113`, `web/sse/manager.ts:1479-1492`). The final frame replays for 10 minutes. No run-record field carries the reply.
  - A web run has `thread_id: ''` (`run.ts:2532`). The cancel notice is skipped when it is empty (`discord/cancel-notice.ts:40-42`).
  - The dashboard launch limit is 3 per minute and 10 per hour, keyed by operator (`web/operator/launch-route.ts:76-81`, `:227`). It is an in-memory fixed window that starts at the operator's first launch and resets when the gateway restarts.
- Trigger inputs at v0.136.5:
  - discord.js `14.28.1` (`packages/gateway/package.json`)
  - `@opencode-ai/sdk` in `packages/runtime/package.json` and the root `package.json`
  - workspace `OPENCODE_VERSION` default (`deploy/workspace.Dockerfile`)
  - V2 pin `2.2.6` (`packages/runtime/src/shared/opencode-v2-pin.json`)
- Results live only in fro-bot/.github#3512 comments (runbook 706–707). The tracker has more than 200 comments. `gh api …/comments` returns the first page only unless it is called with `--paginate`.

### Institutional Learnings

- `docs/solutions/workflow-issues/opencode-v2-gateway-rollout-deploy-checks-do-not-prove-provider-routing-2026-10-31.md` (active): keep a real model-reply check after a pin change. G1.10 is that check, so it must stay automated, not move to the Discord pass.
- `docs/solutions/integration-issues/gateway-operator-health-probe-untrusted-peer-2026-10-14.md` (active): at boot, the CAS self-test logs 412s. Correlate them to the run window.
- The runbook's own rules stay in force:
  - A launch that created a run is never retried.
  - `idle_check` fails closed before every restart.
  - G3 log scans stay inside the run window.
  - The SSH ban list applies.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "docs/runbooks",
  "freshness": {
    "vcs_reference": "7eca42d"
  },
  "budget": {
    "max_search_passes": 2,
    "max_candidate_inspections": 6,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "docs/runbooks/operator-surface-acceptance-automated.md#gateway-release-gates-agent-run",
      "description": "Agent-run gateway release gates G1-G4 with operator Discord actions and the Results template",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "docs/runbooks/operator-surface-acceptance-automated.md#launch-budget",
      "description": "Browser pass dashboard Launch panel steps, launch spacing and the SSE observer snippet",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **Keep the last-pass ref in the #3512 Results comment.** Add a required `Discord pass:` line, read later with a paginated `gh` query. This needs no new file, service or per-release PR, and results already live there. If the tracker closes, the operator carries the newest line into the successor tracker's first results comment.
- **Anchor only on a fully passing Discord pass.** The line takes one of three forms:
  - `Discord pass: PASS on <REF> (trigger: <item>)`
  - `Discord pass: <FAIL|INCOMPLETE> on <REF> (trigger: <item>); last passed on <ref>`
  - `Discord pass: not run (trigger: none); last passed on <ref>` The anchor is the `PASS on` ref or the `last passed on` ref. A failed or incomplete pass leaves the anchor where it was, so the next release diffs from the last PASS and runs the pass again.
- **Deciding items.** `never passed` (no line), `stale (<n> refs)`, a checklist item, `trigger check failed`, or `none`.
- **Bootstrap with `never passed`.** No comment carries the line yet, so the first release under the new runbook runs the Discord pass.
- **Count "refs old" from fro-bot/agent releases in semver order.** Count the releases after the anchor, up to and including `$REF`, from the release list, not a lexical tag sort. Undeployed tags count too, which errs toward running the pass. A count of at least 3 requires the pass.
- **Write the R5 checklist as globs and pin fields, read against `compare/<anchor>...<REF>`.**
  - Run-path globs:
    - `packages/gateway/src/program.ts` (`messageCreate` and `interactionCreate` intake)
    - `packages/gateway/src/{discord,bindings,execute,approvals,web/operator}/**`
    - `packages/runtime/src/{coordination,agent}/**`
  - The implementer checks the other top-level gateway files and runtime directories at the pinned ref, and adds any that sit on the mention, interaction or run path.
  - Pin fields trigger only when the named value changes in the patch:
    - the discord.js version in `packages/gateway/package.json`
    - the `@opencode-ai/sdk` version in `packages/runtime/package.json` or the root `package.json`
    - the `OPENCODE_VERSION` default in `deploy/workspace.Dockerfile`
    - the version in `packages/runtime/src/shared/opencode-v2-pin.json`
  - `bun.lock` counts only when it moves discord.js or `@opencode-ai/sdk`. Other edits to these files don't trigger.
- **Fail closed.** Any of these requires the pass, with trigger `trigger check failed`:
  - a query error
  - an anchor that isn't an ancestor of `$REF`
  - a `compare` file list that is short, capped or unreadable
- **Have G1.10 read the final SSE `output` frame.** Extend the existing observer to keep `output` frames, then check that the `final: true` frame's `text` contains `$TAG-OK`. The observer starts at launch, so it doesn't depend on the 10-minute replay. An empty final frame is a G1.10 failure.
- **Add a launch guard.** Before each gate launch, read the repository selected in the Launch panel, and abort unless it equals `$OWNER_REPO`, the repo bound to `$CHANNEL`. After the launch, confirm the new run's record sits under `$OWNER_REPO` in S3.
- **Launch G3.1 from the dashboard with the same prompt.** Its log, S3 and restart checks don't depend on the surface. Its prompt starts a background shell plus a subagent, which is unchanged.
- **Space the launch budget.** The gateway gates and the browser pass share one per-operator fixed window of 10 launches per hour. Start the second set at least 60 minutes after the first launch of the earlier set, or after a gateway restart, which clears the counters (G3.4 restarts the gateway). The automated gates spend 3 launches: G1.10, G2b, and G3.1. The browser pass's 9 launches, plus 1 in reserve, fit only in a fresh window.
- **Treat G4c, G4d and G4f as Discord pass rows.** Their card edits need a Discord-started run, since a web run has no thread.

## Open Questions

### Resolved During Planning

- Does a dashboard run exercise G3? Yes. Ownership code has no surface branch, and restart never reloads it.
- Where does G1.10 read the reply? From the final SSE `output` frame. No record field carries it.
- Where does the last-pass ref live? On a `Discord pass:` line in the #3512 Results comment.

### Deferred to Implementation

- The exact `jq` filter for the last-pass query and for counting refs. Write it against the real comment and release lists, then read the output back.
- Whether G2b's dashboard run reuses the `sleep 120` prompt as is. It should, because the cancel safety rules are unchanged.
- Which other gateway and runtime paths join the checklist after the pinned-ref review.

## Implementation Units

- [x] **Unit 1: Automated gates on dashboard runs**

**Goal:** Make G1, G3 and G2b's record checks run with no operator action.

**Requirements:** R1, R2, R3, R10

**Dependencies:** None

**Files:**

- Modify: `docs/runbooks/operator-surface-acceptance-automated.md`

**Approach:**

- Intro and Inputs:
  - Say the automated gates need no Discord action.
  - Mark `CHANNEL`, `OP_ID` and `TRIGGER_ROLE` as Discord-pass-only inputs.
  - Replace "spend none of the launch budget" with the spacing rule from Key Technical Decisions.
  - Update "Gates 2 and 3 use the dashboard session" and the Logout ordering, so that G1 also uses the session.
- G1.10: replace the operator mention with a dashboard launch of the same prompt. Read the final `output` frame through an observer extended from the browser pass's snippet. Drop the thread read for G1.10.
- G3.1: replace the operator mention with a dashboard launch of the same background-shell-plus-subagent prompt. Keep `runkeys`, the log scan, the S3 read, the restart and G3.5 unchanged.
- G2b: launch run C1 from the dashboard and cancel it from the dashboard. Keep only the record checks (`phase`, `cancelledBy` `web-operator`).
- Write the launch guard from Key Technical Decisions, and use it before every gate launch.
- Mark every remaining check row as automated or Discord pass.

**Patterns to follow:**

- The browser pass's Launch panel steps and observer, the launch spacing, and the "never retry a launch that created a run" rule.

**Test scenarios:**

- Test expectation: none. This is a runbook text change. Unit 3 covers the lint and docs-site build verification.

**Verification:**

- G1, G3 and G2b's record checks contain no **Operator action** marker.
- G1.10's pass criterion names the final `output` frame and `$TAG-OK`.
- The intro no longer claims the gates spend no launch budget.

- [x] **Unit 2: Discord pass, trigger and results**

**Goal:** Group the Discord checks into one conditional pass with a written trigger and a durable last-pass record.

**Requirements:** R4, R5, R6, R7, R8, R9

**Dependencies:** Unit 1

**Files:**

- Modify: `docs/runbooks/operator-surface-acceptance-automated.md`

**Approach:**

- Add a subsection that gathers mention intake and reply, G2a, G2c, G2d, and G4a–G4f, plus run C1-D. Keep their steps and pass criteria as written. Discord-started runs still use the existing mention prompts.
  - C1-D is today's G2b run: a Discord-started `sleep 120` run, cancelled from the dashboard. It checks the thread notice (one notice, no mentions) and feeds the `run-finished` row.
  - The automated C1 covers only the record checks.
- Add a "When the Discord pass runs" step before the gates. In order:
  1. Find the newest `Discord pass:` line with a paginated query over #3512 comments, and read the anchor from it (see Key Technical Decisions). If none exists, the pass is required (`never passed`).
  2. Count fro-bot/agent releases after the anchor, up to and including `$REF`. A count of at least 3 requires the pass.
  3. Read the paginated `compare/<anchor>...<REF>` files against the checklist globs and pin fields. Any match requires the pass.
  4. Apply the fail-closed rule, then record the deciding item.
- State that a same-ref redeploy runs no gates.
- Results template:
  - Add the required `Discord pass:` line in one of its three forms.
  - When the pass doesn't run, Gates 2 and 4 report their Discord rows as `not run`.
  - Define `not run` next to the existing per-check statuses.
  - Each run (C1, C1-D, C2) appears once.

**Patterns to follow:**

- The existing gate check tables and the Results status vocabulary (runbook 706).

**Test scenarios:**

- Test expectation: none. This is a runbook text change. Implementation reads the queries back against live data (see Verification).

**Verification:**

- The last-pass query, run read-only against #3512, returns no line today, so the deciding item is `never passed`.
- The release count from v0.136.4 to v0.136.5 reads as 1.
- The paginated `compare` file list for v0.136.4...v0.136.5 is complete, it is checked against the globs and pin fields, and the matching item is noted.

- [x] **Unit 3: Cross-references and verification**

**Goal:** Keep the links and the docs site consistent.

**Requirements:** R10

**Dependencies:** Units 1 and 2

**Files:**

- Modify: `docs/runbooks/operator-surface-acceptance.md` (anchor pointer sentence, only if its wording names Discord actions)
- Modify: `AGENTS.md` (the "Operator surface acceptance" row, only if it needs a release-gate clause)

**Approach:**

- Keep the heading text, so the `#gateway-release-gates-agent-run` anchor still resolves.
- Introduce no new hostnames. The new commands use `gh api` paths, not URLs.

**Test scenarios:**

- Test expectation: none. This is docs text.

**Verification:**

- Prettier is clean on the changed files. A pre-existing failure on `AGENTS.md` counts as a baseline, not a regression.
- The docs-site build passes, including both redaction gates and `verify:status`.
- The frontmatter test passes for the plan and the origin doc.

## System-Wide Impact

- **Interaction graph:** The rewritten runbook adds three dashboard launches per release, through the same operator session as the browser pass.
- **Unchanged invariants:** These stay as they are:
  - the P0–P2 preconditions and the SSH ban list
  - `idle_check` before restarts
  - the cancel safety rules
  - the `/dev/null` check at the end of a pass
  - every pass criterion that moved into the Discord pass

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| A trigger checklist that is too narrow skips a Discord regression | The 3-ref staleness bound guarantees a periodic pass. The checklist covers Discord intake (`program.ts`, `bindings/`) and shared run code, and any trigger-check error requires the pass. |
| A failed Discord pass resets the staleness clock | Only a `PASS` line moves the anchor. |
| Upstream moves files and the globs miss them | The checklist names directories, not files. A `compare` diff with renames under those roots still matches. |
| #3512 closes or moves | The runbook names "the release tracker (currently #3512)" and tells the reader to carry the last line into the successor. |
| A dashboard launch on the wrong repo | The new launch guard aborts unless the selected repo is `$OWNER_REPO`, and the S3 record location is checked after launch. |
| The gate launches exhaust the browser pass's window | The spacing rule from Key Technical Decisions. |

## Sources & References

- **Origin document:** `docs/brainstorms/2026-11-09-gateway-release-gates-discord-pass-requirements.md`
- Upstream: fro-bot/agent `v0.136.5` (`7f7bf89`).
- Tracker: fro-bot/.github#3512, comments `6716182489` and `6717940148`.
