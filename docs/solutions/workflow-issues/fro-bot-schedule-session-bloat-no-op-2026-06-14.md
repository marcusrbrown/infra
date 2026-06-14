---
title: Scheduled Fro Bot runs no-op when the per-cron session grows unbounded
date: 2026-06-14
category: workflow-issues
module: fro-bot
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - A scheduled GitHub Actions run invokes the fro-bot/agent action on a cron
  - A report-style or idempotent scheduled agent run should not inherit prior session state
  - Scheduled runs report success but produce no expected output
tags:
  - fro-bot
  - github-actions
  - scheduled-workflow
  - session-continuity
  - autohealing
  - skip-cache
  - opencode
  - ci
---

# Scheduled Fro Bot runs no-op when the per-cron session grows unbounded

## Context

The daily `schedule`-triggered Fro Bot autohealing run in `.github/workflows/fro-bot.yaml` is supposed to create or update a `Daily Autohealing Report — <date>` issue every day. It silently stopped: every scheduled run finished with `conclusion: success`, but no report issue was produced for roughly two weeks. Nothing errored — the run just finished fast and created nothing, so monitoring job status alone never surfaced the failure.

## Guidance

`fro-bot/agent` derives a `schedule` run's OpenCode session key from the cron expression, so every daily run resumes the *same* logical thread. That thread accumulates conversation history without bound; once it is large, the agent resumes it, concludes from the bloated context that the work is already done, and exits after a single model step without taking any tools.

When a scheduled agent run should be stateless (report-style or otherwise idempotent), force it to start a fresh session. With the current action that means scoping `skip-cache` to the schedule event so the daily run restores no session cache and the harness finds no prior per-cron session to continue:

```yaml
- name: Run Fro Bot
  uses: fro-bot/agent@<sha> # v0.64.0
  with:
    github-token: ${{ secrets.FRO_BOT_PAT }}
    # ... other inputs ...
    skip-cache: ${{ github.event_name == 'schedule' }}
```

Scope it to `schedule` only — non-schedule triggers (issue/PR threads) legitimately benefit from session continuity, so they keep the cache.

## Why This Matters

This is a silent failure: the workflow stays green while the scheduled task produces nothing, so it can drift undetected for days or weeks. The only tells are indirect — a fast run, a missing expected artifact, and a resumed large session in the run's log artifact. Anyone watching only the workflow's pass/fail badge sees a healthy pipeline producing no work.

It also illustrates a general trap with stateful CI agent harnesses: a deterministic per-trigger session key is great for *conversational* triggers (resume the same issue/PR thread) but wrong for *recurring stateless* triggers, where it pins every run to one ever-growing thread.

## When to Apply

- A scheduled agent run reports success but produces no output, and the run is suspiciously fast (seconds, not minutes).
- The run's logs show it resumed a large prior session and exited after one step with zero tool calls.
- You are wiring a report-style or idempotent scheduled agent run that should not carry forward prior session state.

Diagnose by downloading the run's log artifact and reading what the agent actually did:

```bash
gh run download <run-id> -n opencode-logs-<run-id>-1
```

In the artifact, the no-op signature is:

- The delivered prompt shows `Thread Identity: ... Status: Continuing previous conversation thread` with a large message count (observed: 678 messages).
- `opencode.log` ends with `loop step=0` → one model turn → `loop step=1` → `exiting loop`, all within seconds, with zero tool calls.

## Examples

Before (no `skip-cache`; scheduled runs resume the bloated per-cron thread and no-op):

```yaml
- name: Run Fro Bot
  uses: fro-bot/agent@<sha> # v0.64.0
  with:
    github-token: ${{ secrets.FRO_BOT_PAT }}
    prompt: ${{ env.PROMPT }}
    timeout: 0
```

After (scheduled runs start fresh; other triggers keep continuity):

```yaml
- name: Run Fro Bot
  uses: fro-bot/agent@<sha> # v0.64.0
  with:
    github-token: ${{ secrets.FRO_BOT_PAT }}
    prompt: ${{ env.PROMPT }}
    timeout: 0
    skip-cache: ${{ github.event_name == 'schedule' }}
```

### Approaches that were considered and rejected

- **Self-dispatch** (a separate `dispatch-daily` job, or a folded dispatch step, that calls `gh workflow run` so the real run fires on `workflow_dispatch` — which the harness keys to a fresh `dispatch-<runId>` session). This worked in a manual test, but it is the wrong shape for a general-purpose single-job workflow: it adds an extra run and requires `actions: write` for `github.token`. Fro Bot authenticates with `secrets.FRO_BOT_PAT`, never `github.token`, and this workflow runs exactly one `fro-bot/agent` job — so no dispatch job and no `github.token` permissions belong in it.
- **`session-retention`** input. It can't help: retention keeps any session within `maxAgeDays` *or* the most-recent `maxSessions`, and the daily schedule session is always the most-recently-updated one, so it is never pruned.

`skip-cache` is a stopgap. The durable fix belongs upstream: date-scope the schedule logical key (e.g. `schedule-<hash>-YYYY-MM-DD`, fresh per day, resumable within a day) or add a fresh-session input. Tracked at `fro-bot/agent#898`.

## Related

- `fro-bot/agent#898` — upstream issue: scheduled runs resume one ever-growing per-cron session.
- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — separate Fro Bot workflow lesson about distinguishing independent `fro-bot/agent` surfaces (the CI Action SHA vs the gateway daemon pin); same file (`fro-bot.yaml`), different failure class.
