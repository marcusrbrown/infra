---
title: "Size the status-history gap threshold from measured run intervals, not cadence plus slack"
date: 2026-11-08
problem_type: best_practice
component: documentation
severity: low
module: apps/docs
applies_when:
  - "A threshold decides whether a scheduled GitHub Actions job missed a run"
  - "Two checks on one page measure different things but read the same constant"
tags: [status-history, github-actions, schedule, gap-threshold, thresholds]
---

# Size the status-history gap threshold from measured run intervals, not cadence plus slack

## Context

The status page marks a gap when two consecutive samples are further apart than `GAP_THRESHOLD_MS` in `apps/docs/src/lib/history-view.ts`. It started at 45 minutes: the 30-minute cadence of `.github/workflows/status-snapshot.yaml` (cron `11,41 * * * *`) plus 15 minutes of slack. GitHub scheduled runs start late, so the public page showed a gap on 6 of 7 days although no run was skipped. The end-to-end probe staleness check read the same constant, although the monitor it checks runs every 15 minutes.

## Guidance

Measure the spacing between samples in the history data and set the threshold above the observed maximum.

Over 2026-11-02 01:27Z to 2026-11-08 18:43Z every app held 324 samples, one per cron slot, so no run was missed:

| Minutes                         | p50  | p90  | p95  | p99  | max  |
| ------------------------------- | ---- | ---- | ---- | ---- | ---- |
| Interval between samples        | 29.5 | 36.6 | 38.6 | 51.9 | 56.4 |
| Sample time after the cron slot | 2.9  | 9.1  | —    | 24.1 | 28.3 |

All 7 intervals over 45 minutes were late runs. Six were the daily 00:11Z slot (51 to 56 minutes), one was 11-02 05:43Z to 06:32Z (49 minutes).

`GAP_THRESHOLD_MS` is now 75 minutes, above every interval measured without a missed run. A longer delay can still produce a false gap. Probe staleness has its own constant, `PROBE_STALE_MS`, at 45 minutes, and boundary tests in `apps/docs/src/lib/history-view.test.ts` pin both.

## Why This Matters

A gap threshold that late runs trip turns "gaps are shown, never interpolated" into daily noise, and a real skipped run looks like every other day. The coverage count cannot stand in for it: the expected count is `1 + round(elapsed / 30 min)`, so lateness can hide one missed slot. A shared constant couples unrelated checks: raising the gap threshold alone would have let a 75-minute-old probe read as fresh.

## When to Apply

- An alert or page state keyed on the spacing of GitHub scheduled runs.
- A constant read by two checks with different cadences.
- After a cron change, or when a late run approaches the threshold: the 00:11Z slot reached 56 of 75 minutes.

## Examples

Re-measure from the newest `status-history` artifact: the spacing between consecutive `t` values in `apps/<app>.json` (`docs/runbooks/docs-site.md`, "Gap threshold").

## Related

- `docs/runbooks/docs-site.md`, "Gap threshold".
- `docs/solutions/best-practices/status-history-actions-artifact-newest-eligible-lookup-2026-11-02.md`, the artifact layout and lookup.
