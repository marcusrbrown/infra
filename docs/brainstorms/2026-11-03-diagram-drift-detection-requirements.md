---
date: 2026-11-03
topic: diagram-drift-detection
---

# Diagram Drift Detection

## Summary

A test fails CI when a published diagram disagrees with the repo on a structural fact: the apps in the topology, compose services and volumes, gateway egress hosts, deploy pipeline jobs and gates, or the steps on a runbook map. The test holds an explicit table that maps each diagram node to the fact it represents and checks it in every direction. No mapping data goes into the diagram specs.

---

## Problem Frame

The docs site publishes 14 Archify diagrams from hand-written specs in `apps/docs/diagrams/`. Nothing ties those specs to the code, compose files, workflows and runbooks they describe. The only freshness signal is the "spec last changed in <commit>" label, and it records when a spec was edited, not whether the spec is still true. A PR that adds a compose service, renames a deploy job, adds an egress host or restructures a runbook can leave the matching diagram silently wrong on a public page.

The docs-platform plan accepted this risk for v1 and deferred detection here. The original idea (#3 in the docs-platform ideation) warned that without a test pinning the key relationships, drift gets caught only if someone notices.

---

## Requirements

**Mapping**

- R1. One table in the drift test records, for each checked diagram, which nodes stand for which repo facts. A node may stand for several facts of one kind. For example, a single `deploy` node can stand for the seven per-app deploy jobs.
- R2. A node with no checkable source, such as an external service, a person or an env-derived host, is listed as illustrative and must carry a non-empty reason.
- R3. A repo fact that a diagram deliberately omits is listed as not drawn and must carry a non-empty reason. Egress hosts can't be listed as not drawn (R8).
- R4. The test doesn't check free-text labels, sublabels, card text, image tags, digests or action pins.

**Checks**

- R5. Topology: the topology's app nodes match the deployable `apps/*` directories. The test excludes non-deployable `apps/*` directories by name.
- R6. Compose: the diagrams for broker, cliproxy, dashboard and umami match their app's `docker-compose.yaml` services and volumes. KeeWeb and VPN are declared to have no compose file. An app's compose file may be missing only if the table declares that.
- R7. Gateway compose: the gateway diagram is checked against the services and volumes in two sources combined. One is the upstream `deploy/compose.yaml` at the ref pinned in `apps/gateway/upstream.json`. The other is the infra compose override as production configures it, with announce and the operator listener both enabled.
- R8. Egress: every host in the workspace egress allowlist that the gateway deploy writes is drawn as a node on the gateway diagram.
- R9. Pipeline: the deploy-pipeline diagram's nodes map to jobs identified by workflow file and job ID, across the deploy router and its callee workflows. The approval gate maps to the environment on the callee deploy job.
- R10. Runbook maps: these are the workflow diagrams under `apps/docs/diagrams/runbooks/`, and each one draws a procedure from a single runbook. Each step maps to a heading anchor that exists in that runbook.

**Behaviour**

- R11. Every check runs in all directions:
  - a repo fact that is neither drawn nor listed as not drawn fails
  - a mapped fact that no longer exists fails
  - a spec node that is neither mapped nor listed as illustrative fails
  - a table row whose node isn't in the spec fails
- R12. A failure names the diagram, the node or fact, and which direction failed.
- R13. The test runs in the existing CI test job. A PR that causes drift fails until the PR fixes the diagram spec, the table, or both.
- R14. The test never passes when a source it reads is missing or unreadable. If the pinned upstream compose isn't present, the test fails and says how to fetch it. It never skips the gateway checks.

---

## Acceptance Examples

- AE1. **Covers R6, R11, R12.** A PR adds a `redis` service to `apps/umami/docker-compose.yaml`, and the umami diagram doesn't draw it. CI fails: "apps-umami: compose service `redis` is neither drawn nor listed as not drawn."
- AE2. **Covers R9, R11.** A PR renames the router job `detect-changes`. CI fails: "deploy-pipeline: node `detect` maps to `deploy.yaml` job `detect-changes`, which no longer exists."
- AE3. **Covers R7, R13.** A Renovate PR bumps `apps/gateway/upstream.json` to a release whose compose adds a service. CI reads the compose at the new ref and fails until the PR updates the gateway diagram and the table. A bump that adds no service or volume stays green.
- AE4. **Covers R8.** A PR adds a host to the workspace egress allowlist. CI fails until the PR draws the host on the gateway diagram. A not-drawn entry for the host doesn't clear the failure.
- AE5. **Covers R11.** A PR deletes the `certs` node from the gateway spec and leaves its table row. CI fails: "apps-gateway: table row `certs` has no node in the spec."
- AE6. **Covers R4.** A Renovate PR changes only a compose image digest. The drift test passes.

---

## Success Criteria

- The PR that adds the test brings every in-scope diagram to a passing state. The first run is expected to flag current gaps: the Caddy volumes, the two model-catalog egress hosts, and the build and scan jobs. That PR fixes each gap in the spec or the table.
- AE1 through AE6 are each covered by a mutation test.
- A Renovate digest or version bump that changes no structure stays green.

---

## Scope Boundaries

- Free-text labels, connection labels, card text and layout.
- Network membership on the gateway diagram. Upstream and the deploy readbacks verify network isolation, not a docs diagram.
- `status-snapshot.dataflow` and `operator-path.sequence`. Neither has a single repo source of structural facts, so v1 doesn't check them.
- Per-node source-line citations, and a "may be stale" flag when a cited file changes.
- Fro Bot PR review nudges, and Archify deltas on PRs.
- Generating diagram content from code.
- Counting or gating growth of the illustrative and not-drawn lists. Reviewing the test diff in the PR is the check.

---

## Key Decisions

- **Fail CI, not warn.** A warning lets a diagram stay wrong indefinitely. A failure puts the fix in the PR that caused the drift, the same way the compose and workflow pin tests work.
- **The mapping lives in the test, not in the specs.** Archify's schema rejects extra properties on components and on `meta`, and both `validate` and `deliver` fail on them.
- **Structure only.** Matching free text causes false failures. Structural facts cover the drift that misleads a reader. Runbook steps match heading anchors, not heading text. A rename that changes an anchor fails, because it also breaks links to that section.
- **Egress hosts must be drawn.** The allowlist is the security property the gateway diagram shows, so the not-drawn escape hatch doesn't apply to it.
- **Upstream compose is downloaded at the pinned ref.** CI downloads only fro-bot/agent's `deploy/compose.yaml` at the `upstream.json` ref, into a ref-keyed path under the gitignored `.cache`. No copy is vendored, so a Renovate pin bump is checked against the compose it actually brings in. A vendored copy would need a manual refresh on every bump. A checkout of upstream's `deploy/` directory was rejected because it ships `*.test.mjs` files that `bun test --recursive` would run.
- **The override is checked as production runs it.** The gateway has the operator listener and announce enabled, so the Caddy service and its volumes are facts the diagram must account for.
- **Prior work.** `docs/ideation/2026-10-31-infra-docs-platform-ideation.md` (#3) records this idea as unexplored, and the docs-platform requirements and plan deferred it. This scope keeps that idea's conventions-test half and drops the citation and PR-nudge halves.

---

## Dependencies / Assumptions

- R7 needs the CI test job and the scheduled autoheal run to download fro-bot/agent's `deploy/compose.yaml` at the pinned ref. Both workflow changes were approved.
- Only the deploy router and its callee workflows count as the pipeline (R9). The diagram doesn't draw other workflows, such as `site.yaml` and `status-snapshot.yaml`.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7][Technical] How the test calls the override builder and the egress writer in `apps/gateway/src/deploy.ts`, and which of their inputs need exporting.
- [Affects R14][Technical] The local-run path when the upstream checkout is missing: the exact fetch command named in the failure message.
- [Affects R5][Technical] Whether the non-deployable `apps/*` list (`docs`, `agent`) is kept by name or derived from the presence of a deploy workflow.

---

## Sources / Research

- Specs live under `apps/docs/diagrams/**/*.json`. Spec discovery and rendering are in `apps/docs/scripts/render-diagrams.ts`.
- Compose files exist for broker, cliproxy, dashboard and umami. The gateway's compose file comes from upstream `deploy/compose.yaml`. `buildComposeOverride` and the env writer in `apps/gateway/src/deploy.ts` add the infra override and the egress allowlist.
- `deploy-gateway.yaml` already checks out fro-bot/agent at the `upstream.json` ref.
- Follow the style of the structural tests in `packages/cli/src/conventions.test.ts` and `apps/*/docker-compose.test.ts`.
