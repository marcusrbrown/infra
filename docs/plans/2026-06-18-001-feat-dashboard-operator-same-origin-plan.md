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
current production state, and specifies the implementation slices required before the privileged/dashboard
operator API is live for browser clients.

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
| R3 | Privileged operator routes and dashboard browser operator calls must not be reachable from the public internet directly without the private dashboard→gateway path and auth/session prerequisites in place; the dashboard Caddy proxy is the only intended browser ingress for privileged/dashboard operator calls. The public Caddy health/topology route (`GET /operator/health`) is intentionally reachable. |
| R4 | The gateway Caddy `/operator/*` route is topology scaffolding only — it must not be treated as the production browser origin. |
| R5 | `GATEWAY_OPERATOR_PUBLIC_ORIGIN` must be set to `https://dashboard.fro.bot` when the operator listener is enabled for production. |
| R6 | The dashboard Caddy `/operator/*` route must include `flush_interval -1` to avoid silently buffering future SSE streams. |
| R7 | The dashboard `/operator/*` proxy must not be wired before the upstream auth/session/CSRF contract is defined (`marcusrbrown/infra#580`). |

---

## Scope Boundaries

**In scope (this plan):**

- Ratify `https://dashboard.fro.bot` as the browser-visible operator API origin.
- Document rejected alternatives and the reasoning.
- Record current production state (gateway operator listener enabled; `GET /operator/health` live; dashboard same-origin `/operator/*` route not yet deployed).
- Specify the implementation slices required before the privileged/dashboard operator API is live.
- Update AGENTS.md files to reference this plan.

### Deferred to Separate Tasks

| Deferred item | Status |
| ------------- | ------ |
| Private network path from dashboard droplet to gateway operator listener | **Implemented** — the shared DigitalOcean VPC is the private path; bridge implemented in `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md`. |
| Upstream auth/session/CSRF contract for privileged operator routes | **Implemented** — `marcusrbrown/infra#580` shipped; all four auth/config secrets are live. |
| Dashboard Caddy `/operator/*` reverse proxy block with `flush_interval -1` | **Implemented** — live in `apps/dashboard/config/Caddyfile` (see plan #003). |
| Post-deploy probes for the live operator path | **Implemented** — `GET https://dashboard.fro.bot/operator/health` returns 200; see `docs/runbooks/gateway-operator-private-path-verification.md`. |
| Operator auth/session wiring in the dashboard app (browser UI client) | Open — separate `fro-bot/dashboard` app work. |

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
| What private network topology connects the dashboard droplet to the gateway operator listener? (DigitalOcean VPC, private network peering, or WireGuard tunnel?) | **Resolved** — the shared DigitalOcean VPC (`nyc1`) already exists; both droplets are on it. The private path is a VPC-IP-scoped Docker port publish + DOCKER-USER iptables rule + DO Cloud Firewall, implemented in `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md`. |
| What is the auth/session/CSRF contract for privileged operator routes? | **Resolved** — operator auth shipped in `marcusrbrown/infra#580`; all four auth/config secrets are live in the `gateway` GitHub Environment. |
| Should the gateway operator listener bind address be configurable per-environment or fixed? | **Resolved** — `GATEWAY_OPERATOR_BIND_HOST` per-deploy (current topology). |

---

## Implementation Units

This is a docs-only ratification plan. The implementation units are documentation updates only — no
deploy code, Caddyfiles, routing changes, or tests are introduced here.

- [x] **Write same-origin plan** — this document. Ratifies `https://dashboard.fro.bot` as the
  browser-visible operator API origin, documents rejected alternatives, records current production
  state, and specifies the implementation slices required before the privileged/dashboard operator
  API is live.

- [x] **Update root operator note** — root `AGENTS.md` references this plan in the gateway operator
  listener note.

- [x] **Update gateway operator docs** — `apps/gateway/AGENTS.md` OPERATOR LISTENER section
  references this plan and reinforces that `gateway.fro.bot/operator/*` is topology scaffolding.

- [x] **Update dashboard operator docs** — `apps/dashboard/AGENTS.md` documents the operator
  same-origin contract, current state, and prerequisites.

- [x] **Private dashboard→gateway path** — implemented in
  `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md`. The shared
  DigitalOcean VPC is the private path; the bridge (VPC-IP publish + DOCKER-USER + DO Cloud
  Firewall + dashboard Caddy route) is live.

- [ ] **Dashboard UI operator client** — browser-side operator client in `fro-bot/dashboard`.
  Deferred; separate `fro-bot/dashboard` app work.

---

## System-Wide Impact

- No deploy code changes. No Caddyfile changes. No test changes.
- `GATEWAY_OPERATOR_PUBLIC_ORIGIN` must be set to `https://dashboard.fro.bot` (not
  `https://gateway.fro.bot`) when the operator listener is enabled for production. This is enforced
  by documentation and operator convention; the deploy script accepts any valid HTTPS origin.
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

The gateway operator listener is **enabled in production**. `GATEWAY_OPERATOR_BIND_HOST=172.21.0.2`,
`GATEWAY_OPERATOR_BIND_PORT=9300`, and `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot`
are set in the `gateway` GitHub Environment. Deploy run
[27740787921](https://github.com/marcusrbrown/infra/actions/runs/27740787921) succeeded.

The dashboard Caddy `/operator/*` route is **live**. The private path (VPC-IP-scoped Docker port
publish + DOCKER-USER iptables rule + DigitalOcean Cloud Firewall + dashboard Caddy route) was
implemented in `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md`. The
shared DigitalOcean VPC (`nyc1`) is the private path — no new VPC or peering was required.
`GET https://dashboard.fro.bot/operator/health` returns 200 through the dashboard Caddy proxy.

The gateway-side Caddy `/operator/*` route remains topology scaffolding — it is not the production
browser origin. The production browser operator path is `https://dashboard.fro.bot/operator/*`.

The remaining open slice is the dashboard UI operator client (browser-side, in `fro-bot/dashboard`).

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
