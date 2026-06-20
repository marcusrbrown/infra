---
title: "feat: gateway v0.72.0 + dashboard 2026.06.34 operator UI go-live"
type: feat
status: active
date: 2026-06-20
---

# feat: gateway v0.72.0 + dashboard 2026.06.34 operator UI go-live

## Overview

Bump the gateway daemon to `fro-bot/agent v0.72.0` (authenticated SSE run-stream producer, server-side operator token, `repos.yaml` redaction on operator surfaces) and the dashboard image to `2026.06.34` (SSE run-stream consumer + operator UI), then enable the operator UI same-origin so the operator run-stream surface goes live at `dashboard.fro.bot/operator/*`. Both releases are source-verified to add no new required secrets and no compose/topology drift. This completes the operator same-origin rollout that infra #579/#580/#581 set up.

## Problem Frame

The operator listener topology (#579), operator auth/config secrets (#580), and same-origin hosting (#581) are all live from earlier work — `dashboard.fro.bot/operator/auth/github/start` already authenticates end-to-end. The missing piece is the actual operator UI: gateway v0.72.0 ships the SSE run-stream producer, and dashboard 2026.06.34 ships the consumer + UI, but the dashboard UI is flag-gated OFF by default. The fro-bot/.github#3512 rollout tracker treats production rollout as incomplete until this is verified live.

## Requirements Trace

- R1. Gateway daemon runs v0.72.0 (SSE run-stream producer) — verified live.
- R2. Dashboard runs the 2026.06.34 image (digest-pinned) — verified live.
- R3. The operator UI is enabled same-origin: `DASHBOARD_OPERATOR_UI_ENABLED=true` + `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true`, origin defaulting to `https://dashboard.fro.bot`.
- R4. The operator run-stream UI is reachable and authenticated at `dashboard.fro.bot/operator/*` live.
- R5. No regression: existing four gateway services healthy, dashboard `/api/healthz` 200, no new required secrets introduced.

## Scope Boundaries

- Operator UI flags are wired as deploy-script defaults (always-on once shipped), not toggleable GitHub Environment secrets.
- `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` is left unset (defaults correctly to `https://dashboard.fro.bot`).

### Deferred to Separate Tasks

- Gateway Phase B units 3–8 (OAuth/session config, run snapshot/SSE internals, web launch/approvals, binding reads, smoke readiness): upstream `fro-bot/agent` work, not infra.

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/upstream.json` — daemon pin (currently `v0.69.0` → `v0.72.0`).
- `.github/renovate.json5` — `fro-bot/agent` ceiling (currently stale `<0.65.0` vs live `v0.69.0`; move to `<0.73.0`).
- `apps/gateway/AGENTS.md` — version lineage + contract notes.
- `apps/dashboard/docker-compose.yaml` — `ghcr.io/fro-bot/dashboard` image pin (`2026.06.30@sha256:bca84c93...` → `2026.06.34@sha256:2d779f7e807bce8eab7c3726d3aee83587ff8a71913631ddacba28cea7902e7e`).
- `apps/dashboard/src/deploy.ts` `buildEnvFileContents` (~line 274) — where `GATEWAY_VPC_IP` is conditionally written into the remote `.env`; the two boolean flags follow the same pattern as unconditional defaults.
- `apps/dashboard/AGENTS.md` / `apps/dashboard/README.md` — operator UI documentation.

### Source Verification (already performed)

- Gateway `packages/gateway/src/config.ts` required-secret set is byte-identical v0.69.0 → v0.72.0; SSE/operator-token/redaction is behavioral on existing `GATEWAY_OPERATOR_*` config. `deploy/compose.yaml` unchanged (no new services/ports/networks/volumes). No v0.70/v0.71 boot-secret additions.
- Dashboard 2026.06.34 (`src/gateway/operator-config.ts`, `src/server.ts`): the three flags are `DASHBOARD_OPERATOR_UI_ENABLED` (default OFF, fail-closed, only `'true'` enables), `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED` (default OFF, independent), `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` (default `https://dashboard.fro.bot`, security-critical, consumed only when SESSION enabled). UI route mounts `buildOperatorRouter(gatewayOperatorSessionEnabled)`; UI-on/SESSION-off renders a degraded separate-domains page, so same-origin needs BOTH true. SSE consumer uses the existing same-origin `/operator/*` path (relative fetch), no new base-URL env. No Dockerfile/port/healthcheck drift. Matched pair: 2026.06.34 SSE consumer targets v0.72.0 producer.

## Key Technical Decisions

- **Deploy gateway first, then dashboard.** The dashboard SSE consumer needs the gateway SSE producer; ordering avoids a window where the UI calls a non-existent endpoint.
- **Flags as deploy-script defaults, not secrets.** The two enablement flags are non-secret booleans and the operator UI is the intended permanent end state, so they are hardcoded `true` in `buildEnvFileContents` rather than seeded as toggleable secrets.
- **Origin left to default.** `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` unset → `https://dashboard.fro.bot`, which is correct; no need to wire it.
- **Two separate PRs** (gateway bump, dashboard bump+enable) to keep deploy gating and rollback clean, gateway landing/deploying first.

## Open Questions

### Resolved During Planning

- Do either release add required secrets? No (source-verified both).
- Does the SSE consumer need a new gateway URL env? No — same-origin `/operator/*`.
- Does enabling the UI need SESSION mode too? Yes — UI-on/SESSION-off is a degraded separate-domains page; same-origin needs both flags true.

### Deferred to Implementation

- Exact `buildEnvFileContents` insertion point and whether the flags belong before/after the `GATEWAY_VPC_IP` conditional — resolve when editing.

## Implementation Units

- [ ] **Unit 1: Bump gateway daemon to v0.72.0**

**Goal:** Move the gateway daemon pin and Renovate ceiling to v0.72.0 (R1).

**Dependencies:** None.

**Files:**
- Modify: `apps/gateway/upstream.json` (`v0.69.0` → `v0.72.0`)
- Modify: `.github/renovate.json5` (ceiling `<0.65.0` → `<0.73.0`; refresh the stale comment that references v0.46.1)
- Modify: `apps/gateway/AGENTS.md` (version lineage + note the v0.72.0 SSE/operator-token/redaction behavioral changes, no new secrets)
- Add: `.changeset/*.md` (patch — daemon bump rebuilds the deployed gateway)

**Approach:** Straight pin bump; the contract is source-verified unchanged. Refresh the Renovate ceiling comment so it stops citing the stale v0.46.1 rationale and reflects the current ">v0.72.0 needs a source-contract pass" gate.

**Test scenarios:** Test expectation: none — config/pin bump, no behavioral code. Conventions/taxonomy gates apply.

**Verification:** `upstream.json` valid; Renovate config validates; conventions + taxonomy gates pass; changeset present.

- [ ] **Unit 2: Enable operator UI in the dashboard deploy + bump image**

**Goal:** Wire the two enablement flags into the remote `.env` and bump the dashboard image pin to 2026.06.34 (R2, R3).

**Dependencies:** None (can develop in parallel; deploys after Unit 1).

**Files:**
- Modify: `apps/dashboard/src/deploy.ts` (`buildEnvFileContents`: always write `DASHBOARD_OPERATOR_UI_ENABLED=true` and `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true`)
- Modify: `apps/dashboard/src/deploy.test.ts` (assert both flags present in the built env contents)
- Modify: `apps/dashboard/docker-compose.yaml` (image pin → `ghcr.io/fro-bot/dashboard:2026.06.34@sha256:2d779f7e807bce8eab7c3726d3aee83587ff8a71913631ddacba28cea7902e7e`)
- Modify: `apps/dashboard/AGENTS.md` + `apps/dashboard/README.md` (document operator UI now enabled same-origin; the flag contract + origin default)

**Approach:** Add the two boolean flags as unconditional lines in `buildEnvFileContents`, mirroring the existing static `DASHBOARD_*` lines. Leave `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` unset (correct default). The container reads them via `env_file: .env`. The image digest pin is the standard pull-model bump.

**Execution note:** Add the env-contents assertion test first (the behavior-bearing change is the flag wiring).

**Test scenarios:**
- Happy path: `buildEnvFileContents(...)` output contains `DASHBOARD_OPERATOR_UI_ENABLED=true` and `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true`.
- Regression: existing required lines (`DASHBOARD_DOMAIN=`, `DASHBOARD_GITHUB_APP_KEY_FILE=`, the conditional `GATEWAY_VPC_IP=`) still present and unchanged.

**Verification:** dashboard tests pass; `docker compose config` parses with the new digest; image-pin test (digest-shape) passes; tsc/lint/taxonomy clean.

## System-Wide Impact

- **Interaction graph:** dashboard `/operator/*` route (Caddy → gateway VPC `10.116.0.3:9300`) is already live; enabling the UI mounts the operator router + `/static/*` + SSE consumer behind the existing auth boundary.
- **Error propagation:** UI flag fail-closed (only `'true'` enables); origin reader fails closed on invalid value (defaults correctly here).
- **API surface parity:** none — no CLI/published surface change. No changeset for the dashboard PR (deploy-config + app image, not `packages/cli/src`); the gateway PR gets a patch changeset (daemon rebuild).
- **Unchanged invariants:** operator auth (#580 secrets), same-origin path (#581), the four gateway services, dashboard `/api/healthz` public health, no public exposure of `:9300` (VPC-only + DOCKER-USER + DO firewall).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Deploy order wrong (dashboard UI before gateway SSE producer) | Land + deploy gateway (Unit 1) first; dashboard (Unit 2) second. Both gated. |
| Same-origin needs both flags (UI-on/SESSION-off = degraded page) | Set both flags true; verified in source. |
| Operator origin misconfig | Leave unset → secure default `https://dashboard.fro.bot`. |
| Image digest drift | Pin exact digest `sha256:2d779f7e...`; verify running image post-deploy. |

## Sources & References

- Rollout tracker: fro-bot/.github#3512
- Gateway release: fro-bot/agent v0.72.0
- Dashboard release: fro-bot/dashboard 2026.06.34 (`sha256:2d779f7e807bce8eab7c3726d3aee83587ff8a71913631ddacba28cea7902e7e`)
- Operator same-origin path: docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md
