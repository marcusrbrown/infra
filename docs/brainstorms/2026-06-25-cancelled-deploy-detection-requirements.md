---
title: Cancelled / incomplete deploy detection
date: 2026-06-25
status: ready-for-planning
type: requirements
---

# Cancelled / incomplete deploy detection

## Problem

A deploy run that is **cancelled** (not failed) can silently strand an app on an old version. The umami `3.2.0` pin landed on `main` (PR #670) but production ran `3.1.0` for ~3 weeks: its deploy run was *cancelled* at the approval gate by a later merge (root cause fixed in PR #682). Fro Bot autohealing category 5 only catches *failed* deploy runs — its per-app instruction is literally "Check the most recent Deploy workflow run … If it **failed**, diagnose." A cancelled run is not a failed run, so the strand slipped through with no signal for weeks.

The cause is fixed; this closes the **observability** gap so any residual stranded deploy surfaces in the next daily autohealing run instead of by accident.

## Why this shape (vs. broad pin-vs-live drift)

A prior plan proposed reconstructing committed-pin-vs-live-running-version across the 4 Docker apps. Document-review found two P0 flaws: the committed pin read from the operator's filesystem produces false `ok` on stale checkouts and permanent `unknown` for global CLI installs, and — more fundamentally — the broad drift design over-builds for an incident class whose *cause* is already fixed. The incident was specifically "a deploy was cancelled and never completed," which is directly observable from the deploy run history. This requirement targets that signal directly.

## Goal

Fro Bot autohealing flags, per app, when the latest deploy run is cancelled/incomplete **and** has not been superseded by a later successful deploy — so a stranded deploy is reported in the daily run, not discovered weeks later.

## Requirements

- R1. For each deployed app, autohealing category 5 evaluates the most recent deploy run at or after the latest `main` commit that changed that app, and treats a `cancelled` (or otherwise non-success, incomplete) conclusion as a finding — not only `failed`.
- R2. **Supersede-awareness:** a cancelled run that is followed by a later **successful** deploy for the same app is *not* flagged (it self-healed). Only a cancelled/incomplete run that remains the latest deploy for that app is a strand.
- R3. A flagged strand is reported as a finding in the daily autohealing report (the existing category-5 reporting path), with enough context to act (which app, which run, the committed change that wasn't deployed). Reporting only — no auto-deploy.
- R4. No new secrets, no new SSH surface, no per-app version probes. The signal comes from the GitHub Actions deploy-run history (`gh run list` / run conclusions), which autohealing already has access to.

## Scope Boundaries

- Not a per-app live-version probe; not comparing image pins to running containers (that was the superseded drift plan).
- Not changing the deploy pipeline or the concurrency fix (PR #682).
- Not auto-remediating — the operator approves any corrective redeploy.
- Not surfaced in `infra status` (the global-CLI source-of-truth problem makes that path low-value; the CI/autohealing path is authoritative).

### Deferred to Separate Tasks

- A deterministic CLI/CI assertion (e.g. `infra` helper or a post-merge step that asserts main's latest per-app deploy concluded `success`) — only if the prompt-based detector proves unreliable in practice.

## Success Criteria

- A cancelled deploy that strands an app (no later successful deploy for it) appears as a category-5 finding in the next daily autohealing report.
- A cancelled deploy that was superseded by a later successful deploy does **not** generate a finding (no false alarm during normal Renovate-burst supersede churn).
- No new secrets or SSH surface added to the Fro Bot job.

## Open Questions

### Resolved

- Detector shape? → Cancelled/incomplete with supersede-awareness (not "any cancelled run", which would false-alarm on superseded churn; not a per-app version probe).
- Where does it live? → Fro Bot autohealing category 5 `SCHEDULE_PROMPT` (the established deploy-health home).

### For Planning

- Exact `gh run list` query shape to map a `main` app-change commit → the relevant deploy run and detect supersede (a later successful deploy for the same app). The deploy router fans out per-app jobs, so the per-app conclusion is derivable from the deploy run's jobs.
- Whether to enrich the prompt with the precise "find latest app-touching commit" heuristic or keep it to "latest deploy run per app + conclusion + supersede check."

## Sources & References

- Superseded design record: `docs/plans/2026-06-25-003-feat-deploy-drift-detection-plan.md` (broad pin-vs-live drift, superseded; retains the reviewer findings).
- Incident: `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md`, infra PR #682 (cause fix), PR #670 (umami strand).
- `.github/workflows/fro-bot.yaml` category 5 "DEPLOY PIPELINE HEALTH" (the `if it failed` instruction that misses cancelled runs).
