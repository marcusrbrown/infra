---
title: "Alert on counters absent until first increment"
date: 2026-11-26
category: best-practices
module: apps/traces
problem_type: design_pattern
component: tooling
severity: high
applies_when:
  - "An alert watches a counter that is not exported until its first increment"
  - "An alert query puts two counters, or a metric-name regex, inside increase() or rate()"
  - "Alert rules are provisioned in Grafana and Prometheus never loads them as rule files"
tags: [promql, prometheus, grafana-alerting, promtool, counters, absent-series, traces]
---

# Alert on counters absent until first increment

## Context

Loss counters such as the collector's export-failure counters and Tempo's discard counter are not exported until the first loss. The first loss is the one that matters, and `increase(x[30m]) > 0` misses it (#2101).

## Guidance

**Why `increase()` misses it.** A series that is absent, then appears at 1 and stays at 1, has the same first and last sample in the window. The increase is 0, so nothing alerts.

**Use two halves joined by `or`.** One half catches a series that rose. The other catches a series that exists now and did not 5 minutes ago, behind a guard that the target was up 5 minutes ago:

```promql
(sum by (exporter) (increase(x[30m])) > 0)
or
(sum by (exporter) (x unless x offset 5m) > 0
   and on() (up{job="otelcol"} offset 5m == 1))
```

The tradeoff: the new-series half fires for the 5 minutes after the series appears, and a series that first appears with less than 5 minutes of the target's history does not alert. Without the guard, a restart would page on an old count.

**Do not merge counters by name.** `increase()` drops the metric name. One `__name__` regex over two counters of the same exporter then yields two series with one labelset, and the query fails at evaluation time with a duplicate-labelset error. `promtool check rules` accepts such a query. `promtool test rules` catches it. Give each counter its own label with `label_replace`, join with `or`, then aggregate. A plain `+` is no fix: it drops every series missing from one side.

**Decide absence per rule.**

- A sparse counter, absent until its first event: no data means no event, so `noDataState: OK`.
- A series that must always exist, such as `up` or the reporter's last-run time: no data means the monitoring is blind, so `noDataState: Alerting`.
- Keep the last state when a query fails, so a Prometheus outage neither resolves firing alerts nor starts new ones.

**Test the deployed query.** Prometheus never loads Grafana-managed rules, so `promtool` cannot read them. Keep a mirror file, run `promtool test rules` against it, and add a test that the mirror equals the provisioned query. The mirror is [`loss-rules.yml`](../../../apps/traces/config/prometheus/loss-rules.yml) and the tests are in [`loss-rules.test.ts`](../../../apps/traces/config/prometheus/loss-rules.test.ts).

## Why This Matters

Without the second half the first loss is silent. Without a test that evaluates the query, a labelset collision passes every static check and fails when the rule first runs.

## When to Apply

- Any alert on a counter that appears only after an event.
- Any alert that combines counters or selects them by name inside `increase()` or `rate()`.

For a gauge, use the plain comparison.

## Prevention

CI skips both promtool cases. The bun test skips when Docker or the pinned Prometheus image is not local, and no workflow loads the image. Run the cases locally before changing a query: `docker run --rm --network none -v "$PWD/apps/traces/config/prometheus:/w:ro" -w /w --entrypoint promtool <the prom/prometheus image pinned in apps/traces/docker-compose.yaml> test rules loss-rules.test.yml`.

## Related

- [Keep monitoring failures out of ingest gates](monitoring-must-not-gate-the-ingest-it-monitors-2026-11-26.md)
