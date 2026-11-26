---
title: "Keep monitoring failures out of ingest gates"
date: 2026-11-26
category: best-practices
module: apps/traces
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "A deploy or open/close gate reads a health verdict that includes monitoring services"
  - "A deploy pulls or starts monitoring services before it decides whether the public route opens"
  - "A synthetic probe writes data into the system it checks"
tags: [monitoring, deploy-gate, ingest, health-reporter, canary, prometheus, grafana, traces]
---

# Keep monitoring failures out of ingest gates

## Context

Prometheus and Grafana joined the trace stack in #2101. A failure in either must not hold or refuse healthy ingest, but two designs let it: a reporter verdict that required Grafana, and a route-critical `compose pull` and `up --wait` that included both.

## Guidance

- **Keep two verdicts.** `ok` covers the ingest checks and is what the deploy gate and `traces ingest open` read. `monitoringOk` covers Grafana, Prometheus and the embedder. `/healthz` answers both, so the external monitor still sees monitoring failures. A check nobody has classified counts as ingest, so a new check fails closed ([`health-report.ts`](../../../apps/traces/src/health-report.ts)).
- **Pull and start monitoring after the route is decided.** The route-critical pull and start cover ingest services only. Monitoring and the embedder follow as operator gates. Ordinary pull or startup failures become gate results: they fail the run and never reach the failure handler that holds the route. Ownership loss (`DeployOvertakenError`) and step-lock refusals (`DeployStepBusyError`) are rethrown and end the deploy (`apps/traces/src/deploy.ts:2583-2585`; the service lists are at `:314-328`).
- **Gate readiness on the endpoint the monitor probes.** Prometheus uses `/-/ready`. `/-/healthy` can pass before it answers queries.
- **Use metrics for ongoing alerting.** Where end-to-end proof has to write data, run a guarded canary once at deploy time instead of a periodic probe. The old five-minute canary sent about 288 synthetic traces a day that Tempo cannot filter (#2094).

## Why This Matters

A monitor that can block what it watches turns a broken alarm into an outage.

## When to Apply

- Adding a check to a verdict that a gate reads: classify it as ingest or monitoring first.
- Adding a service to a deploy: ask whether the route depends on it.

## Related

- [Alert on counters absent until first increment](promql-alert-on-counters-absent-until-first-increment-2026-11-26.md)
