---
date: 2026-10-31
topic: infra-docs-platform
focus: operator docs platform for marcusrbrown/infra — uptime, live status, admin controls, topology and deployment diagrams built with Archify
mode: repo-grounded
---

# Ideation: Infra operator docs platform

## Codebase Context

- **Shape:** a Bun/TypeScript workspace monorepo for one operator's personal infrastructure, with 7 deployments: keeweb, cliproxy, gateway, dashboard, umami, broker and vpn. The `@marcusrbrown/infra` CLI provides per-app `status`, `deploy` and `logs`, a unified `status --json`, and a read-only MCP bridge.
- **Deploys:** they go through a router workflow to per-app workflows. Each one waits at a manual environment gate, and a Discord notification fires when a deploy reaches its gate.
- **Fro Bot:** it reviews PRs and writes a daily autohealing report issue.
- **Status is scattered** across the CLI, that issue, the dashboard, workflow runs and Discord. No uptime history is stored. `StatusSummary` (`packages/cli/src/commands/status.ts`) is mostly flat strings per app, and only the gateway adds a structured workspace memory field.
- **Existing docs:**
  - root `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md`
  - an `AGENTS.md` for each app
  - 14 runbooks
  - about 45 solution docs, plus plans and brainstorms whose frontmatter is validated by `docs-frontmatter.test.ts`
- **Archify:** the skill is at `.agents/skills/archify` (PR #1744). It renders validated JSON or Mermaid specs into standalone HTML diagrams in 10 types, plus one-page explainers. It also has a repository-evidence mode and an architecture delta tool. Archify's own description says it is not for dashboards, so live status has to come from somewhere else.
- **Hosting:** there is no GitHub Pages workflow yet, and the repo is public. The dashboard sits behind GitHub OAuth with an allowlist of one operator, and it lives in a separate codebase.

**Lessons from past work:**

- A green deploy or health check did not prove user-facing behavior; see `docs/solutions/workflow-issues/opencode-v2-gateway-rollout-deploy-checks-do-not-prove-provider-routing-2026-10-31.md`.
- Docs drift, which forced the 10-23 refresh sweep.

**Constraints:**

- Operator controls stay behind the authenticated dashboard.
- Never publish host IPs, named third-party services, secrets or sensitive logs.
- Analytics must be self-hosted and privacy-preserving.
- Droplets are small, so there's no RAM headroom for new resident services.
- Prefer boring designs that are easy to delete, and avoid ceremony.

## Ranked Ideas

### 1. A status contract that says what each check proves

**Description:** Replace the flat per-app `http` string with typed observations: reachable, container healthy, deploy state, end-to-end, plus host disk and container-store usage. Each observation carries a timestamp, a freshness value and an explicit "not measured". The CLI, MCP, the daily report and the site all read this one record. **Warrant:** `direct:`

- The OpenCode V2 rollout passed every deploy check while every model call failed.
- The cliproxy disk-full outage built up over about 2.5 months and nothing watched it.
- `status.ts:19-28` reports one `http: string` per app.

**Rationale:** Every other status surface inherits this record's honesty or its vagueness. **Downsides:** The `--json` shape changes, so it needs a minor CLI release, and the MCP and daily-report consumers must update. **Confidence:** 85% **Complexity:** Medium **Status:** Explored

### 2. Status history from scheduled snapshots, with no new service

**Description:** A cron workflow saves secret-free observations from #1 to a data branch or artifact. The site renders 30 to 90 days per app as Archify timelines. A gap shows as a gap, never as uptime. **Warrant:** `direct:`

- No uptime history is stored today.
- The daily report computes a 7-app health table and then discards it (`.github/workflows/fro-bot.yaml:776-805`).
- `cliproxy-auth-monitor.yaml` is the precedent for a scheduled probe.

**Rationale:** It gives history without spending RAM on any droplet and without another service to maintain. **Downsides:** The data comes from sampling at Actions cron intervals, so it shows observed availability, not true uptime. **Confidence:** 80% **Complexity:** Medium **Status:** Explored

### 3. Topology and pipeline diagrams that cite their sources and flag their own drift

**Description:** Generate Archify repository-evidence diagrams for the topology, the deploy router → gate → droplet pipeline, the dashboard → VPC → gateway operator path, and egress. Each node cites its source line. Fro Bot's PR review flags affected diagrams, or attaches an Archify delta, when a PR touches compose files, Caddyfiles, `deploy.ts` or egress hosts. **Warrant:** `direct:` the 10-23 drift sweep. Archify supports revision-pinned evidence and architecture comparison. **Rationale:** Diagrams become checked artifacts instead of illustrations that rot. **Downsides:** Without a conventions test pinning the key relationships, drift detection depends on Fro Bot noticing. **Confidence:** 75% **Complexity:** Medium–High **Status:** Unexplored

### 4. Public and private projections, with machine-enforced redaction

**Description:** One build produces a redacted public view and a full private view. A test in the style of `docs-frontmatter.test.ts` fails the build if public HTML contains private IP ranges, VPC addresses, or hostnames not on an allowlist. Operator controls appear only as links to the dashboard, the CLI or a runbook, never as buttons. **Warrant:** `direct:` the redaction rule is a writing rule, not a check. Root `AGENTS.md` contains a VPC address that an evidence-mode diagram would pick up. **Rationale:** New status fields and diagram detail can enrich the private view without quietly widening what's public. **Downsides:** Where the private view is hosted is still open. Pages from a public repo is public, the dashboard is a separate codebase, and Caddy can't reuse the dashboard's OAuth. **Confidence:** 75% **Complexity:** Medium **Status:** Explored

### 5. A rollout passport opened at the deploy gate

**Description:** The `notify` job opens a record for each rollout with the pin, digests, what changed, the relevant runbooks and anti-patterns, and the checks required afterwards. Automated acceptance then fills it in, recording results such as "not demonstrable on V2" explicitly. **Warrant:** `direct:`

- Acceptance evidence lives in `/tmp` and is lost.
- "Was 1.14.0 ever fully accepted?" can only be answered from memory.
- Gate approvals are made from a bare Discord post.

**Rationale:** Each rollout leaves an evidence packet behind, which makes the next upgrade and the next incident cheaper. **Downsides:** It needs a private home (see #4), and the acceptance runner must emit a structured record. **Confidence:** 70% **Complexity:** Medium–High **Status:** Unexplored

### 6. Maps of the irreversible runbooks

**Description:** Archify workflow diagrams for the umami Postgres major upgrade, VPN server-key rotation and dashboard image rollback. Each STOP condition and irreversible step is marked, and each node links to its runbook section. **Warrant:** `direct:` these procedures are rare and irreversible. The umami Postgres upgrade runbook is about 1,100 lines, and the PG15 finalize needed 3 attempts. **Rationale:** It's the cheapest first use of Archify, and a single operator is less likely to lose his place during a rare procedure. **Downsides:** Each map is another artifact that can drift. It should come with #3's drift check. **Confidence:** 65% **Complexity:** Low **Status:** Unexplored

### 7. A map of which detector catches which failure mode

**Description:** Cross the `symptoms` and `root_cause` frontmatter from `docs/solutions/` with the detectors: auth monitor, deploy probe, daily report, gate notify, operator acceptance. An empty cell is a failure nothing would catch. **Warrant:** `direct:` the auth monitor missed `provider-missing`, and that gap was found by an outage (`cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`). **Rationale:** It shows monitoring gaps before they cause an outage, and it records why each detector exists. **Downsides:** `symptoms` is free text, so the first mapping is partly manual. **Confidence:** 60% **Complexity:** Medium **Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
| --- | --- | --- |
| 1 | The daily report issue as the home page | Issue bodies can't hold Archify HTML. The report should link to the site instead. |
| 2 | Offline outage-kit bundle | A git checkout already holds the runbooks and docs. |
| 3 | Fro Bot "operator edition" that drafts doc patches | Duplicates the daily report and Fro Bot's PR review. |
| 4 | Portable operator-dossier format for other repos | Premature abstraction, since there's no second consumer. |
| 5 | Secrets inventory with blast radius and rotation dates | Rotation is rare and the metadata adds disclosure risk. It fits better as a runbook index inside #4's private view. |
| 6 | Runbooks as resumable operator sessions | Too much machinery for how rarely these procedures run. #6 covers the navigation need. |
| 7 | Deepen MCP as the agent docs surface | Folded into #1, since one contract feeds MCP too. |
| 8 | Status as a committed build artifact | Folded into #2. |
| 9 | "What would break?" pages from the dependency graph | Folded into #3 as a diagram view. |
| 10 | Docs claims that carry provenance and expire | Folded into #3 and #1, through freshness and evidence pins. |
| 11 | Generated service catalog replacing hand-written inventories | Folded into #3. |
| 12 | Deploy pipeline lifecycle diagram generated from workflow YAML | Folded into #3's starting diagram set. |
| 13 | Disk and memory pressure trend | Folded into #1 as a check and #2 as history. |
| 14 | Gate briefing explainer linked from Discord | Merged into #5. |
| 15 | Acceptance ledger per contract version | Merged into #5. |
| 16 | Deploy receipts written by every deploy job | Merged into #5. |
| 17 | Symptom-to-solution search index | Merged into #7. |
| 18 | Topology diagrams as failing CI tests | Merged into #3. |
