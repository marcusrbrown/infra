---
title: Autoheal single-report reconciliation deadlocked on an unseeded trust-anchor label
date: 2026-08-03
category: workflow-issues
module: fro-bot
problem_type: workflow_issue
component: development_workflow
severity: medium
symptoms:
  - "13 open 'Daily Autohealing Report — <date>' issues (#897..#1012) accumulated instead of converging to one"
  - "Every report had author fro-bot and the body marker but no autoheal-report label"
  - "The autoheal-report label did not exist in the repository at all"
  - "Each daily run punted all older reports to 'Needs Human Attention' and closed nothing"
root_cause: incomplete_setup
resolution_type: workflow_improvement
related_components:
  - autoheal
  - github-issues
tags:
  - fro-bot
  - autoheal
  - reconciliation
  - trust-anchor
  - label
  - workflow-migration
  - daily-report
---

# Autoheal single-report reconciliation deadlocked on an unseeded trust-anchor label

## Problem

The daily-autoheal prompt in `.github/workflows/fro-bot.yaml` enforces a single-report reconciliation contract: exactly one open "Daily Autohealing Report — `<date>`" issue should remain, and older ones are closed as superseded. Trust is gated on a label that was never seeded into the repository, so no report was ever eligible for reconciliation and the reports piled up.

## Symptoms

- 13 daily-report issues (#897 → #1012, 2026-07-21 → 2026-08-02) were simultaneously open.
- Every one had author `fro-bot` and the body marker `<!-- fro-bot:autoheal-report:v1 -->`, but **none** carried the `autoheal-report` label — the label did not exist in the repo.
- Each run correctly logged all older reports under "Needs Human Attention" and closed nothing (the contract forbids touching untrusted issues).

## What Didn't Work

**Concluding "PAT permission gap."** A first investigation pass blamed the `FRO_BOT_PAT` for being unable to create/apply labels. That was wrong:

- The PAT applies labels fine — other `fro-bot`-authored issues carry labels (`#933`/`#934` → `bug`, `#925` → `technical-debt`/`code-quality`).
- The PAT *created* the `autoheal-report` label on the 2026-08-03 run.
- The `gh label list` that showed no autoheal label was run minutes **before** that day's scheduled run created it — a timing artifact, not proof of a permission failure.

The real cause is a contract/migration gap, not permissions.

## Solution

The reconciliation contract makes the label a load-bearing trust anchor:

```
b. Managed-report trust boundary: ... An issue can become managed only when
   `author.login` is exactly `fro-bot`, label `autoheal-report` is present, AND
   its body contains `<!-- fro-bot:autoheal-report:v1 -->`. A matching title
   alone is untrusted. Never ... close ... it; link it under "Needs Human
   Attention" instead.
c. Ensure label `autoheal-report` exists, then retrieve open issue metadata ...
e. Close every OTHER trusted managed report ...
```

But the label's creation was only `gh label create autoheal-report ... 2>/dev/null || true` — errors swallowed, no guarantee it persisted, and no step to adopt reports created before the label existed. With zero trusted reports, the "close every OTHER trusted report" loop had nothing to reconcile.

The forward mechanism self-healed once the 2026-08-03 run created the label and applied it to its report (#1028). The 13 legacy unlabeled reports were then closed in a **one-time manual cleanup**, each with a supersession comment and `--reason "not planned"`:

```bash
gh issue comment "$n" --body "Superseded by #1028 — current daily autohealing report. ... <!-- fro-bot:autoheal-superseded:v1 canonical=#1028 -->"
gh issue close "$n" --reason "not planned"
```

## Why This Works

The reconciliation loop only closes reports **after** trusted classification. Once the label exists and is applied, each run produces exactly one trusted canonical report and supersedes the rest. Legacy reports created before the label existed can never enter the trusted set, so they required an explicit one-time adoption/close outside the automated flow.

## Prevention

- **Seed a contract's trust-anchor resource idempotently and up front.** When a workflow makes a label (or any resource) the load-bearing trust boundary, create it deterministically before it is depended on — do not rely on best-effort creation inside the agent prompt.
- **Never swallow trust-anchor creation errors.** `2>/dev/null || true` on the label-create hid a contract-breaking failure; a failed create should be visible.
- **Migrations that add a new trust requirement must adopt pre-existing artifacts.** Reports created before the label existed became permanently orphaned; a migration step should backfill the label onto them (or the contract must expect a one-time manual cleanup).
- **Surface the deadlock as an anomaly.** "Trusted report count == 0 while N untrusted title collisions exist" is exactly the failure signature — reporting it makes the deadlock visible on day one instead of after a two-week pile-up.

## Related Issues

- [`workflow-issues/fro-bot-schedule-session-bloat-no-op-2026-06-14.md`](fro-bot-schedule-session-bloat-no-op-2026-06-14.md) — same `fro-bot.yaml` daily-autoheal surface, different failure mode (session bloat / silent no-op).
- [`integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`](../integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md) — durable canonical-issue/marker state as health signal (closed/absent == healthy).
- [`integration-issues/agent-s3-key-layout-diverged-from-pinned-action-2026-08-03.md`](../integration-issues/agent-s3-key-layout-diverged-from-pinned-action-2026-08-03.md) — sibling "a contract's assumed authority was never actually verified/seeded."
- Issues: #1028 (canonical), #905 (introduced the label contract), #897–#1012 (the orphaned reports).
