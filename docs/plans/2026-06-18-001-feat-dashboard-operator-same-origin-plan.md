---
title: "feat: Dashboard operator same-origin — ratify dashboard.fro.bot as the browser-visible operator API origin"
type: feat
status: active
date: 2026-06-18
---

# feat: Dashboard operator same-origin — ratify dashboard.fro.bot as the browser-visible operator API origin

## Overview

The gateway operator listener topology landed in `marcusrbrown/infra#579`. This plan ratifies which
public origin owns the browser-visible operator API, documents the rejected alternatives, records the
current production state, and specifies the implementation slices required before the operator API is
live for browser clients.

**Ratified contract:** The browser-visible operator API origin is `https://dashboard.fro.bot`. The
dashboard Caddy instance owns the `/operator/*` route and proxies it to the gateway operator listener
over a private dashboard→gateway path. This makes the operator API same-origin with the dashboard UI,
eliminating cross-origin credentialed browser calls.

Related tracking: `fro-bot/.github#3512`.

---

## Problem Frame

`marcusrbrown/infra#581` raised the question: which public origin should own the browser-visible
operator API? Three candidates were evaluated:

1. `https://gateway.fro.bot/operator/*` — the gateway Caddy route already exists as topology
   scaffolding.
2. `https://dashboard.fro.bot/operator/*` — same-origin with the dashboard UI.
3. A third public origin (e.g. `https://operator.fro.bot`).

The core constraint is that browser clients (the dashboard UI at `dashboard.fro.bot`) must be able to
make credentialed requests to the operator API without cross-origin complications. Picking any origin
other than `dashboard.fro.bot` forces cross-origin credentialed requests, which requires permissive
CORS on the operator listener and exposes the operator surface to any origin that can obtain a valid
session.

---

## Requirements Trace

| ID | Requirement |
| -- | ----------- |
| R1 | The browser-visible operator API origin must be same-origin with the dashboard UI (`dashboard.fro.bot`). |
| R2 | Cross-origin credentialed browser calls from `dashboard.fro.bot` to `gateway.fro.bot` must not be required. |
| R3 | The gateway operator listener must not be reachable from the public internet directly; the dashboard Caddy proxy is the only intended browser ingress. |
| R4 | The gateway Caddy `/operator/*` route is topology scaffolding only — it must not be treated as the production browser origin. |
| R5 | `GATEWAY_OPERATOR_PUBLIC_ORIGIN` must be set to `https://dashboard.fro.bot` when the operator listener is enabled for production. |
| R6 | The dashboard Caddy `/operator/*` route must include `flush_interval -1` to avoid silently buffering future SSE streams. |
| R7 | The dashboard `/operator/*` proxy must not be wired before the upstream auth/session/CSRF contract is defined (`marcusrbrown/infra#580`). |

---

## Scope Boundaries

**In scope (this plan):**

- Ratify `https://dashboard.fro.bot` as the browser-visible operator API origin.
- Document rejected alternatives and the reasoning.
- Record current production state (operator routing disabled).
- Specify the implementation slices required before the operator API is live.
- Update AGENTS.md files to reference this plan.

### Deferred to Separate Tasks

| Deferred item | Tracking |
| ------------- | -------- |
| Private network path from dashboard droplet to gateway operator listener (DigitalOcean VPC or private network peering) | Future infra task |
| Upstream auth/session/CSRF contract for privileged operator routes | `marcusrbrown/infra#580` (blocked on `fro-bot/agent`) |
| Dashboard Caddy `/operator/*` reverse proxy block with `flush_interval -1` | Future dashboard deploy task |
| Post-deploy probes for the live operator path | Follows dashboard Caddy route deployment |
| Operator auth/session wiring in the dashboard app | Follows `infra#580` |

---

## Context & Research

### Gateway operator listener topology (`infra#579`)

`marcusrbrown/infra#579` wired the gateway-side operator listener topology:

- `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`, `GATEWAY_OPERATOR_PUBLIC_ORIGIN` enable
  the operator listener when all three are set (all-or-none).
- The listener binds to a `gateway-net`-only address — no host-published port.
- The gateway Caddy `/operator/*` route proxies from the public HTTPS edge to the listener over
  `gateway-net`.
- The current operator route surface is `GET /operator/health`.

The gateway Caddy `/operator/*` route is topology scaffolding — it proves the gateway listener and
Caddy wiring work. It is not the production browser origin.

### Dashboard app (`apps/dashboard/`)

The dashboard is a two-service Docker Compose stack (`dashboard` + `caddy`) on a dedicated
DigitalOcean droplet at `dashboard.fro.bot`. The Caddy instance handles automatic HTTPS and reverse
proxies to the dashboard app on `:3000`. The dashboard Caddy `/operator/*` route is not yet deployed.

### Cross-repo operator feature tracker

`fro-bot/.github#3512` tracks the cross-repo operator feature. The auth/session/CSRF contract for
privileged operator routes is tracked in `marcusrbrown/infra#580`, blocked on upstream work in
`fro-bot/agent`.

---

## Key Technical Decisions

### Decision: `https://dashboard.fro.bot` is the browser-visible operator API origin

The dashboard Caddy instance (on the `dashboard.fro.bot` droplet) owns the `/operator/*` route and
proxies it to the gateway operator listener over a private dashboard→gateway path.

**Why:** Browser clients (the dashboard UI) make credentialed requests to the operator API. Same-origin
means no CORS preflight, no `Access-Control-Allow-Credentials` surface, and no risk of the operator
API being reachable from arbitrary origins that can obtain a valid session.

### Rejected: `https://gateway.fro.bot/operator/*` as the production browser origin

The gateway Caddy `/operator/*` route is topology scaffolding. It exists to prove the gateway-side
listener and Caddy wiring work. Routing browser operator calls directly to `gateway.fro.bot` would
require cross-origin credentialed requests from the dashboard UI — the problem this decision exists to
avoid. `gateway.fro.bot/operator/*` must not be used as the production browser origin.

### Rejected: Cross-origin credentialed browser calls from `dashboard.fro.bot` to `gateway.fro.bot`

This would require permissive CORS on the gateway operator listener and expose the operator surface to
any origin that can obtain a valid session. Rejected on security posture grounds.

### Rejected: A third public origin (e.g. `https://operator.fro.bot`)

Adds a third TLS edge, a third DNS record, and a third trust boundary to manage with no benefit over
the dashboard-origin approach. Rejected as unnecessary complexity.

---

## Open Questions

| Question | Status |
| -------- | ------ |
| What private network topology connects the dashboard droplet to the gateway operator listener? (DigitalOcean VPC, private network peering, or WireGuard tunnel?) | Open — deferred to the private-path implementation task |
| What is the auth/session/CSRF contract for privileged operator routes? | Blocked on `fro-bot/agent` upstream work (`infra#580`) |
| Should the gateway operator listener bind address be configurable per-environment or fixed? | Open — current topology uses `GATEWAY_OPERATOR_BIND_HOST` per-deploy |

---

## Implementation Units

This is a docs-only ratification plan. The implementation units are documentation updates only — no
deploy code, Caddyfiles, routing changes, or tests are introduced here.

- [ ] **Unit 1: Write same-origin plan**

  **Goal:** Author this ratification plan document, establishing `https://dashboard.fro.bot` as the
  browser-visible operator API origin, documenting rejected alternatives, recording current production
  state, and specifying the implementation slices required before the operator API is live.

  **Requirements:**
  - R1 — same-origin contract ratified in writing.
  - R2 — cross-origin credentialed calls explicitly rejected.
  - R3 — gateway listener public-internet exposure rejected.
  - R4 — gateway Caddy `/operator/*` route documented as topology scaffolding only.
  - R5 — `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot` convention documented.
  - R6 — `flush_interval -1` requirement documented as a prerequisite.
  - R7 — dashboard proxy gated on auth/session/CSRF contract (`infra#580`).

  **Dependencies:** None — this is the first unit.

  **Files:**
  - Create `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`

  **Approach:** Write the plan with frontmatter, Overview, Problem Frame, Requirements Trace, Scope
  Boundaries, Context & Research, Key Technical Decisions, Open Questions, Implementation Units,
  System-Wide Impact, Risks & Dependencies, Documentation / Operational Notes, and Sources &
  References sections. Keep all content docs-only; no shell recipes or deploy code.

  **Patterns to follow:** Standard ce:plan structure. Frontmatter fields: `title`, `type`, `status`,
  `date`. Requirements table with `ID` / `Requirement` columns. Deferred items table. Key Technical
  Decisions with explicit rejected-alternative subsections.

  **Test scenarios:**
  Test expectation: none — docs-only ratification; verification is documentation review and grep gates.

  **Verification:**
  - File exists at the expected path with correct frontmatter.
  - All seven requirements (R1–R7) appear in the Requirements Trace table.
  - Rejected alternatives (`gateway.fro.bot`, cross-origin credentialed calls, third origin) each have
    a dedicated Key Technical Decisions subsection.
  - Current production state (operator disabled) is documented in Documentation / Operational Notes.

---

- [ ] **Unit 2: Update root operator note**

  **Goal:** Update the root `AGENTS.md` to reference this plan in the gateway operator listener note,
  so agents and operators reading the root knowledge base are directed to the full rationale and the
  ratified `GATEWAY_OPERATOR_PUBLIC_ORIGIN` convention.

  **Requirements:**
  - R4 — gateway Caddy `/operator/*` route documented as topology scaffolding only.
  - R5 — `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot` convention referenced.

  **Dependencies:** Unit 1 (plan document must exist before it can be referenced).

  **Files:**
  - Modify `AGENTS.md`

  **Approach:** Locate the existing gateway operator listener note in the NOTES section of `AGENTS.md`
  (the sentence beginning "The gateway Caddy `/operator/*` route is topology scaffolding"). Append a
  reference to this plan document so the note reads: "See `apps/gateway/AGENTS.md` for constraints and
  `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` for the decision record."
  Do not introduce plan-taxonomy strings (R-IDs, Unit labels, version tags) into `AGENTS.md`.

  **Patterns to follow:** Existing `AGENTS.md` note style — prose sentences, no structured taxonomy.
  Keep the note self-contained; do not duplicate the full rationale.

  **Test scenarios:**
  Test expectation: none — docs-only ratification; verification is documentation review and grep gates.

  **Verification:**
  - `AGENTS.md` contains a reference to `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`.
  - No plan-taxonomy strings (`R[0-9]+`, `Unit [0-9]+`, `(v[0-9]+)`) appear in `AGENTS.md`.

---

- [ ] **Unit 3: Update gateway operator docs**

  **Goal:** Update `apps/gateway/AGENTS.md` to reference this plan in the OPERATOR LISTENER section,
  reinforcing that `gateway.fro.bot/operator/*` is topology scaffolding and directing agents to the
  full rationale for the rejected-gateway-origin decision.

  **Requirements:**
  - R4 — gateway Caddy `/operator/*` route documented as topology scaffolding only.
  - R5 — `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot` convention referenced.

  **Dependencies:** Unit 1 (plan document must exist before it can be referenced).

  **Files:**
  - Modify `apps/gateway/AGENTS.md`

  **Approach:** Locate the OPERATOR LISTENER section in `apps/gateway/AGENTS.md`. Add or update a
  sentence that directs agents to this plan for the full same-origin rationale and the rejected
  `gateway.fro.bot` alternative. Do not introduce plan-taxonomy strings into the AGENTS file.

  **Patterns to follow:** Existing `apps/gateway/AGENTS.md` section style — prose or short bullet
  notes. Keep the reference concise; the plan document holds the full rationale.

  **Test scenarios:**
  Test expectation: none — docs-only ratification; verification is documentation review and grep gates.

  **Verification:**
  - `apps/gateway/AGENTS.md` contains a reference to `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`.
  - No plan-taxonomy strings (`R[0-9]+`, `Unit [0-9]+`, `(v[0-9]+)`) appear in `apps/gateway/AGENTS.md`.

---

- [ ] **Unit 4: Update dashboard operator docs**

  **Goal:** Update `apps/dashboard/AGENTS.md` to document the operator same-origin contract, the
  current disabled state, the prerequisites that must land before the dashboard Caddy `/operator/*`
  route is deployed, and a reference to this plan.

  **Requirements:**
  - R1 — same-origin contract (`dashboard.fro.bot`) documented.
  - R3 — gateway listener must not be publicly reachable; dashboard Caddy is the only browser ingress.
  - R6 — `flush_interval -1` documented as a prerequisite for the dashboard Caddy route.
  - R7 — dashboard proxy gated on auth/session/CSRF contract (`infra#580`).

  **Dependencies:** Unit 1 (plan document must exist before it can be referenced).

  **Files:**
  - Modify `apps/dashboard/AGENTS.md`

  **Approach:** Add or update an OPERATOR SAME-ORIGIN section in `apps/dashboard/AGENTS.md` that
  states: (a) the ratified origin is `https://dashboard.fro.bot`; (b) the dashboard Caddy
  `/operator/*` route is not yet deployed; (c) prerequisites — private dashboard→gateway path,
  auth/session/CSRF contract (`infra#580`), and `flush_interval -1` in the Caddy block — must all
  land first; (d) reference to this plan for the full rationale. Do not introduce plan-taxonomy
  strings into the AGENTS file.

  **Patterns to follow:** Existing `apps/dashboard/AGENTS.md` section style. Anti-patterns block
  should note that the dashboard Caddy `/operator/*` route must not be added before prerequisites are
  met. Keep the section concise; the plan document holds the full rationale.

  **Test scenarios:**
  Test expectation: none — docs-only ratification; verification is documentation review and grep gates.

  **Verification:**
  - `apps/dashboard/AGENTS.md` contains a reference to `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`.
  - The section documents the current disabled state and the three prerequisites.
  - No plan-taxonomy strings (`R[0-9]+`, `Unit [0-9]+`, `(v[0-9]+)`) appear in `apps/dashboard/AGENTS.md`.

---

## System-Wide Impact

- No deploy code changes. No Caddyfile changes. No test changes.
- `GATEWAY_OPERATOR_PUBLIC_ORIGIN` must be set to `https://dashboard.fro.bot` (not
  `https://gateway.fro.bot`) when the operator listener is enabled for production. This is enforced
  by documentation and operator convention; the deploy script accepts any HTTPS origin.
- The gateway Caddy `/operator/*` route remains topology scaffolding. Agents and operators reading
  `apps/gateway/AGENTS.md` are directed to this plan for the full rationale.
- The dashboard Caddy `/operator/*` route is not deployed. Agents and operators reading
  `apps/dashboard/AGENTS.md` are directed to this plan for prerequisites and implementation slices.

---

## Risks & Dependencies

| Risk | Mitigation |
| ---- | ---------- |
| Operator wired before private path exists | Prerequisites documented in `apps/dashboard/AGENTS.md`; dashboard Caddy route must not be added until private path is established |
| Operator wired before auth/session/CSRF contract | `infra#580` must land first; documented as a hard prerequisite |
| `gateway.fro.bot/operator/*` mistakenly used as production browser origin | Explicitly rejected in this plan and in `apps/gateway/AGENTS.md` OPERATOR LISTENER section |
| SSE streams silently buffered | `flush_interval -1` required in the dashboard Caddy `/operator/*` block; documented as a prerequisite |

---

## Documentation / Operational Notes

### Current production state

Operator live routing is **disabled**. No `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`,
or `GATEWAY_OPERATOR_PUBLIC_ORIGIN` values are set in the `gateway` GitHub Environment. No dashboard
Caddy `/operator/*` route is deployed. The gateway-side Caddy `/operator/*` route is topology
scaffolding only — it is not the production browser origin.

### Required implementation slices before operator API is live

The following work must land before the operator API is live for browser clients:

1. **Private dashboard→gateway path and trust boundary.** A private network path from the dashboard
   droplet to the gateway operator listener must be established (e.g. a DigitalOcean VPC or private
   network peering). The gateway operator listener must not be reachable from the public internet
   directly; the dashboard Caddy proxy is the only intended ingress for browser operator calls.

2. **Upstream auth/session/CSRF readiness.** `fro-bot/agent` must ship the auth/session/CSRF contract
   for privileged operator routes (tracked in `marcusrbrown/infra#580`). The dashboard `/operator/*`
   proxy must not be wired before the upstream auth surface is defined.

3. **Dashboard Caddy `/operator/*` route with SSE buffering disabled.** `apps/dashboard/config/Caddyfile`
   must add a `/operator/*` reverse proxy block targeting the gateway operator listener over the
   private path. The route must include `flush_interval -1` to disable response buffering so future
   SSE streams are not silently buffered.

4. **Post-deploy probes.** After the dashboard Caddy route lands, verify:
   - `GET https://dashboard.fro.bot/operator/health` returns 200 through the dashboard Caddy proxy.
   - The gateway operator listener has no host-published port (`docker compose ps` on the gateway
     droplet must not show a `9300->9300` mapping).
   - The workspace container is not on `gateway-net`.
   - Cross-origin requests from `dashboard.fro.bot` to `gateway.fro.bot/operator/*` are rejected
     (the gateway Caddy route is scaffolding, not a production path).

### Operator env var convention

When enabling the operator listener for production:

- Set `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot` in the `gateway` GitHub Environment.
- Do **not** set `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://gateway.fro.bot` — that would declare the
  gateway Caddy scaffolding route as the production browser origin, which is explicitly rejected.

---

## Sources & References

| Source | Role |
| ------ | ---- |
| `marcusrbrown/infra#579` | Gateway operator listener topology (bind host, port, Caddy route) — landed |
| `marcusrbrown/infra#580` | Operator auth/session/CSRF secret wiring — blocked on upstream |
| `marcusrbrown/infra#581` | Same-origin operator hosting decision — ratified by this plan |
| `fro-bot/.github#3512` | Cross-repo operator feature tracker |
| `apps/gateway/AGENTS.md` | Gateway deploy operator listener section — constraints and current state |
| `apps/dashboard/AGENTS.md` | Dashboard deploy operator same-origin section — prerequisites and anti-patterns |
| `apps/gateway/src/deploy.ts` | `buildComposeOverride`, `buildCaddyfile` — operator listener wiring |
| `apps/dashboard/config/Caddyfile` | Dashboard Caddy config — `/operator/*` route not yet present |
