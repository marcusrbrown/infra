---
date: 2026-10-31
topic: infra-docs-platform
---

# Infra Docs Platform

## Summary

A public Astro Starlight site at `mrbro.dev/infra` will render the operator docs and a set of Archify diagrams. It will also show 90 days of public status history for the 7 apps, with each observation labeled by what it proves. A scheduled job records public-safe observations every 30 minutes and keeps the history as a GitHub Actions artifact. The CLI's `status --json` moves to the same typed contract first. A build gate blocks public IPs, unlisted hostnames and secret-shaped strings from being published.

---

## Problem Frame

Status for the infra deployments is split across five places:

- the CLI
- the daily autohealing report issue
- the operator dashboard
- workflow runs
- Discord

None of them keeps history.

Every status check also reports a flat string and never says what it proved. On 10-30 the OpenCode V2 rollout passed every deploy and health check while every model call failed. The cliproxy disk filled over about 2.5 months and nothing reported it.

The architecture exists only as prose. Topology, the deploy pipeline and the operator request path have no diagrams. Docs drift, and fixing that has needed periodic refresh sweeps, the most recent on 10-23.

The rule against publishing public host IPs and named third-party services is enforced only in review.

---

## Requirements

**Status contract (CLI)**

- R1. `status --json` reports typed observations per app, under a schema version field. Each observation carries:
  - its kind: reachability, container health, deploy state, end-to-end behavior, or resource such as disk
  - its result
  - when it was observed
  - its source
- R2. A check that did not run reports "not measured", never a pass. A check that ran but couldn't conclude reports "unknown".
- R3. A partial failure within one app shows on each affected observation and is never collapsed into a single app-level failure.
- R4. The human-readable `status` table and the MCP status tools keep working after the migration. The documented `status --json` usage in `README.md`, `AGENTS.md` and `packages/cli/README.md` is updated in the same change.
- R5. The contract migration ships first as its own phase. It is released as a minor version, which marks a breaking change on 0.x, with a CLI changeset.

**Public snapshot**

- R6. Every 30 minutes a scheduled run records public-safe observations:
  - Reachability: external HTTPS probes of keeweb, cliproxy, umami, broker and the dashboard, and of the gateway through the dashboard's public operator health route, including its contract version.
  - Deploy state: for each app, from the GitHub Actions API, the latest deploy job, its conclusion and time, and whether it is waiting at its gate.
  - End-to-end: the probe result (`healthy`, `dead` or `unknown`) and probe time from the latest scheduled, live cliproxy auth monitor run, which exercises the Claude route through a real model call. Synthetic validation runs are ignored, and the run's workflow conclusion is never treated as the result, since the monitor succeeds for every probe outcome.
- R7. The snapshot uses no deploy Environment secrets and no SSH.
- R8. The daily report gains one row: the age of the last successful snapshot. That row is flagged once the snapshot is more than 2 runs late.
- R9. The VPN has no external probe. It shows deploy state only, and its live health reads "not measured".
- R10. History is the artifact of the latest successful snapshot run. Every site build, whether snapshot or docs, downloads it and validates it. All builds run in one concurrency group. Samples older than 90 days are trimmed.
- R11. If the latest history artifact can't be found or parsed, the build fails and publishes nothing. A build never publishes shorter or empty history. A one-time bootstrap creates the first artifact.
- R12. Every sample shows when it was taken. When no sample arrives for more than 45 minutes, the page shows a gap. The page shows observed availability with its sample count and never shows an uptime percentage.

**Site**

- R13. An Astro Starlight site is published to GitHub Pages at `mrbro.dev/infra`. It rebuilds on each snapshot run and when a rendered source changes on `main`.
- R14. The build job has read-only permissions. A separate deploy job runs only on `main` and holds the Pages and OIDC permissions. No pull-request trigger reaches the deploy job. Dependencies install from the frozen lockfile with install scripts disabled.
- R15. The site renders `ARCHITECTURE.md`, `STRUCTURE.md`, each app's `AGENTS.md` as a service guide, `docs/runbooks/`, and an index of `docs/solutions/` built from validated frontmatter. Plans, brainstorms and ideation docs link to GitHub instead of being rendered.
- R16. Each app has a service page that shows:
  - its current observations and 90-day history
  - its diagrams
  - links to the dashboard, its CLI commands and its runbooks

  Operator controls appear only as links. The site never offers a button that changes anything.

- R17. Archify diagrams are rendered at build time from committed specs. Each diagram is labeled "spec last changed in" its last-changing commit. The v1 set:
  - system topology for all 7 apps
  - the deploy pipeline: router, per-app workflow, notify, gate, droplet, verify
  - the operator request path: browser, dashboard Caddy, VPC, gateway, workspace, cliproxy
  - the status snapshot dataflow
  - one architecture diagram per app
  - runbook maps for the umami Postgres major upgrade, VPN server-key rotation and dashboard image rollback, with STOP points and irreversible steps marked

**Redaction gate**

- R18. The build fails if any built page, diagram or history file contains one of these. The error names the file and location. An address or hostname match also prints the value. A secret match prints only the pattern identifier, never the matched text, so a blocked build can't leak it into public Actions logs.
  - A globally routable IP literal, IPv4 or IPv6, including defanged forms such as `203.0.113[.]5`. Private ranges (RFC1918), loopback, `0.0.0.0/8`, link-local and CGNAT addresses are allowed.
  - A hostname outside a committed allowlist.
  - A string that matches a committed set of secret patterns.
- R19. Publishing a new hostname requires an allowlist change in the same PR. Named third-party services that aren't hostnames stay a review-only rule.

---

## Acceptance Examples

- AE1. **Covers R2, R9.** Given a snapshot run, when the VPN service page renders, live health reads "not measured" and the latest `deploy-vpn` job's conclusion and time appear beside it.
- AE2. **Covers R8.** Given scheduled runs have stopped for 90 minutes, when the next daily report runs, its snapshot-age row is flagged with the time of the last successful snapshot.
- AE3. **Covers R10, R11.** Given the latest history artifact is missing or invalid, when any site build runs, the build fails visibly, publishes nothing, and the published site keeps its previous history.
- AE4. **Covers R10.** Given a docs-only merge to `main`, when the site rebuilds, it carries the full history forward from the latest artifact, and no samples are lost.
- AE5. **Covers R18, R19.** Given a runbook edit adds a public host IP, an unlisted host or a token-shaped string, when the site builds, the build fails and names the file and location. It shows the offending IP or host, but for the token only the pattern that matched, never the token itself. An allowlist change in the same PR can clear a hostname. Nothing clears a public IP or a secret match.
- AE6. **Covers R1, R6.** Given the gateway's operator health returns 200 with contract `1.14.0` while model calls fail:
  - The gateway's reachability observation passes.
  - Its end-to-end observation reads "not measured".
  - The cliproxy end-to-end observation reflects the latest auth monitor result.
  - The site never shows the gateway as fully healthy.

---

## Success Criteria

- Marcus can open `mrbro.dev/infra` on a phone and see each app's current observations, labeled by what they prove, plus 90 days of observed history with gaps visible. The page states that public history covers reachability, deploy state and the cliproxy model route, but not gateway model calls or host resources.
- The topology, the deploy pipeline and the three irreversible runbooks have diagrams that are reviewed in PRs like code.
- No public IP, unlisted hostname or secret-shaped string can reach the published site.
- If the snapshot stops, the daily report says so within a day.
- `ce:plan` can sequence three independently shippable phases (contract, snapshot, site) without inventing behavior, data sources or scope.

---

## Scope Boundaries

- No private view or private hosting. Deep signals stay in the CLI, MCP and the daily report: disk, memory, container health and VPN peers.
- No operator controls on the site. It links to the dashboard and the CLI.
- No new SSH or secret path for status, and no new resident service on any droplet.
- The daily report's health table is not ingested.
- No analytics on the site.
- No new alerting channel. The only change to the daily report is the snapshot-age row.
- No automatic diagram drift detection (ideation #3), no rollout passport (#5), and no detector coverage map (#7). These are the next brainstorms and build on this one.
- Plans, brainstorms and ideation docs are not rendered.

---

## Key Decisions

- **Public site, with private views staying in the dashboard.** The repo is public and on the Pro plan, so Pages can only be public. A public site needs no OAuth and can be shared. The dashboard is a separate codebase with its own release gate. Operator controls stay behind the dashboard's GitHub OAuth, as decided in `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md` (recorded as completed).
- **External probes, deploy state and the auth monitor, with no SSH.** Every deploy Environment requires a reviewer, so a cron job can't read their SSH secrets. An ungated secret path would change the security posture.
- **No daily-report table ingest.** Its rows duplicate the probes and deploy state. It carries Env secrets and Host keys posture that shouldn't be public, and its verdicts are written by an LLM (`.github/workflows/fro-bot.yaml:776-805`). The only row it has that the snapshot lacks is the auth monitor's, which the snapshot reads directly.
- **History as an Actions artifact, not on Pages or in git.** Every Pages deploy replaces the whole site, so a docs build would wipe history kept there, and CDN-cached reads go stale. The artifact survives site redeploys and doesn't grow the public repo. Its 90-day retention matches the history window.
- **30-minute samples, kept 90 days.** The 10-builds-per-hour Pages limit doesn't apply to custom Actions workflows. The page shows observed availability, never uptime.
- **Migrate `status --json` now.** One versioned contract serves the CLI, MCP and the site. The breaking change ships alone and first.
- **One plan, three independently shippable phases.** The phases are the contract, the snapshot, and the site with its diagrams and gate. Each phase can ship or roll back on its own.
- **Astro Starlight.** It's already used in systematic, dev-like, sparkle and bfra-me/works, so this adds no new generator.
- **`mrbro.dev/infra`.** GitHub documents that a user site's custom domain serves project sites at `<domain>/<repo>`, so no DNS change is needed.
- **The redaction gate enforces addresses, hostnames and secrets on build output.** Private and non-routable addresses are already public in the repo and stay allowed. Named services stay review-only because a pattern can't reliably detect them.
- **Runbook maps ship in v1.** The umami Postgres upgrade, VPN key rotation and dashboard rollback are rare and irreversible, which is where a map helps most.

---

## Dependencies / Assumptions

- PR #1744, which adds the Archify skill to the repo, must merge before the site phase can render diagrams in CI.
- Rendering Archify needs Node in CI. Node 26 is already set up in the workflows.
- Astro and Starlight are new dependencies, and the new workflow adds Pages deploy permissions. Both get the usual review.
- GitHub disables scheduled workflows in a public repo after 60 days without repository activity. R8 surfaces that in the daily report.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1–R4][Technical] The exact observation schema and schema-version semantics.
- [Affects R6, R7][Technical] Whether the snapshot is a new CLI subcommand or a mode of `status`, and how it shares probe code with the per-app checks.
- [Affects R10, R11][Technical] How builds locate the latest history artifact, and the one-time bootstrap step.
- [Affects R12, R16][Technical] Whether history is stored as one file per app, so each service page loads only its own app.
- [Affects R15–R17][Technical] Where the site source lives in the workspace, and how Archify HTML embeds in Starlight.
- [Affects R17][Technical] Whether the build runs Archify `finalize`, which needs a Chrome on the runner, or `deliver`. The checkout depth needed for per-spec commit labels.

---

## Sources

- `docs/ideation/2026-10-31-infra-docs-platform-ideation.md`. Survivors #1, #2, #4 and #6 are the seed. #3 is partly in v1: the diagrams, but not drift detection. #5 and #7 are deferred.
- `packages/cli/src/commands/status.ts`: the current `StatusSummary` and `unifiedStatusAction`.
- `.github/workflows/fro-bot.yaml`: the daily report's Deploy Pipeline Health table.
- `.github/workflows/cliproxy-auth-monitor.yaml`: the scheduled end-to-end probe of the Claude route.
- `docs/solutions/workflow-issues/opencode-v2-gateway-rollout-deploy-checks-do-not-prove-provider-routing-2026-10-31.md`: the lesson behind the proof levels.
- The systematic repo's `docs/astro.config.mjs`: the Starlight precedent.
