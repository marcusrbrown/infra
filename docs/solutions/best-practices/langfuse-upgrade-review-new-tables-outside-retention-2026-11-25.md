---
title: "Before a Langfuse upgrade, read its ClickHouse migrations for tables outside the retention gate"
date: 2026-11-25
module: apps/traces
problem_type: best_practice
component: database
severity: medium
applies_when:
  - "A Langfuse bump crosses one or more ClickHouse migration numbers"
  - "The trace privacy page, the retention gate or the age alert names which tables hold data and for how long"
  - "Any Langfuse bump, because the agent read routes rely on the Viewer role refusing writes"
tags:
  [langfuse, clickhouse, migrations, retention, privacy-page, upgrade, snapshot, traces, reader-gate, viewer-key, mcp]
---

# Before a Langfuse upgrade, read its ClickHouse migrations for tables outside the retention gate

## Context

Langfuse 4.84.0 added a usage ledger, `billable_events`. It has no TTL and no setting that turns it off, and it sits outside the deploy's fixed retention-table list. The upgrade is what starts writing it, so the review belongs before the deploy gate. The trace privacy page documents the ledger's contents and retention.

The same review missed a second case. Tags checked on 2026-11-26: v4.84.0 is the first to carry ClickHouse migration `0057` (the ledger, `billable_events`) and `0059` (it drops and recreates the Topics tables: `topics`, `topic_facet_summaries`, `topic_assignments`, `topic_assignments_by_trace`). v4.85.0 is the first to carry `0060` (naming costs on `topics`) and `0061` (a materialised view that feeds the ledger from `topic_facet_summaries`). `topic_facet_summaries` holds an LLM-written summary of each trace's content, and the retention comment excluded it as a table "no sender can write into", which stopped being true once Topics could run on this stack. It is now in `RETENTION_TABLES` as a required table, with the two assignment tables as optional ones; `topics` stays out on purpose (later runs reuse a definition by id).

## Guidance

1. **Diff the ClickHouse migrations between the pinned and target tags.** For each new table, note its columns, whether it has a TTL, and what fills it.
2. **Decide each new table's retention, by who can write into it and what.** A table an operator feature fills with model output about trace content is content, even though no sender writes it. The retention gate lists its tables in `RETENTION_TABLES` (`apps/traces/src/retention.ts:43-70`), with deliberate exclusions in the comment above it. Either add the table to the gate, or document why it is excluded.
3. **Check the age alert.** The data-age check reads only `TRACE_TABLES` (`apps/traces/src/health-report.ts:105-109`). Decide whether a new table belongs there.
4. **Disclose before the upgrade.** Check the migration SQL against `apps/docs/src/content/docs/trace-privacy.md`. Then confirm that the Site run succeeded and the updated page is live before you merge the upgrade.
5. **Take a snapshot before approving the gate.** Dispatch the Traces Backup workflow (`docs/runbooks/trace-collection.md`, "Dispatch a backup by hand") and confirm the new snapshot is listed. Do not assume a down migration restores the earlier state: the ledger's down migration drops its views but keeps the table and its rows.
6. **After each Langfuse upgrade, re-prove that the Viewer key still cannot write, and diff the MCP tools.** The agent read routes depend on Langfuse refusing writes for the Viewer role, and a new release can add a write path or a tool that skips the role check. Once the upgrade is deployed:
   1. Create a fresh Viewer key in the Langfuse UI and run `bunx @marcusrbrown/infra traces reader backend langfuse` with it. Then delete the old key and run `bunx @marcusrbrown/infra traces reader backend langfuse --confirm-old-revoked`. The gate's own check must print that the pair reads Langfuse and that Langfuse refuses both a REST write and an MCP write by role. A `rest-write-not-denied` or `mcp-write-not-denied` result means the role no longer protects the store: run `bunx @marcusrbrown/infra traces reader revoke --all` at once, and do not reissue tokens until the cause is known.
   2. Diff the MCP `tools/list` against the last reviewed list for new write tools. Send a JSON-RPC `tools/list` to `https://traces.fro.bot/agent/langfuse/api/public/mcp` with a reader token (the workstation token works), and compare tool names and annotations. A new tool that can create, update or delete anything is a write tool: check that its call is refused for the Viewer role, and extend the gate's check to cover it before the next issuance.
   3. Check the REST allowlist in `apps/traces/reader-gate/paths.ts` against the release notes: a path the gate allows for `GET` must still only read. The same applies to an `mcp-grafana` image bump for the Grafana route: `traces reader backend grafana` proves that the tool list holds only read tools.

## Why This Matters

A new table can outlive the retention story the privacy page tells, and the upgrade is the moment the page becomes wrong. A new write path can outlive the read-only story the same way: the Viewer role is Langfuse's promise, not this stack's, so each upgrade has to prove it again.

## When to Apply

- Any Langfuse bump that crosses a migration number.
- Every Langfuse bump, for step 6, and every `mcp-grafana` bump.
- Any other trace-stack image whose upgrade migrates stored data.

## Related

- #2073, #2075
- `docs/solutions/workflow-issues/traces-first-deploy-cascade-2026-11-22.md`
