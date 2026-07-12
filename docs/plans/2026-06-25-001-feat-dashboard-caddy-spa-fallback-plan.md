---
title: "feat: Dashboard Caddy SPA fallback for client-side deep links"
type: feat
status: completed
date: 2026-06-25
---

# feat: Dashboard Caddy SPA fallback for client-side deep links

## Overview

The `fro-bot/dashboard` frontend was rebuilt as a Vite + React SPA (PWA) for the `/` monitoring view; the Hono backend stays as the same-origin BFF on `dashboard.fro.bot`. The dashboard container serves `web/dist/index.html` at `/`, hashed assets at `/assets/*`, plus `/manifest.webmanifest` and `/icon-*`, and keeps `/api/*` and `/auth/*` on the backend. The infra-side Caddy config must serve `index.html` for SPA client-side routes the backend does not own, so future deep-linkable client routes resolve to the app instead of 404ing through the backend.

This is a config-only routing change to `apps/dashboard/config/Caddyfile` plus its structure tests. No new credentials, no operator-session origin change.

## Problem Frame

The committed `apps/dashboard/config/Caddyfile` has two `handle` blocks: `/operator/*` → `{$GATEWAY_VPC_IP}:9300`, and a catch-all → `dashboard:3000`. Every non-operator path reaches the backend as that exact path. A future client route (`/runs`, `/settings`, etc.) would hit the backend, which only serves the SPA document at `/` — so the deep link returns a backend redirect/404 instead of `index.html`. Confirmed live by Fro Bot triage: `HEAD https://dashboard.fro.bot/__fro_bot_spa_probe_669` returns `302 → /operator/auth/github/start?return_to=/operator` (a non-owned path falls through to the backend auth surface, not the SPA).

Not yet load-bearing — `/` is the only SPA route today — but it must land before any deep-linkable client route is added.

## Requirements Trace

- R1. Backend-owned paths (`/api/*`, `/auth/*`, `/assets/*`, `/manifest.webmanifest`, `/icon-*`) continue to proxy to `dashboard:3000` unchanged.
- R2. `/operator/*` continues to proxy to `{$GATEWAY_VPC_IP}:9300` first, with existing headers and `flush_interval -1`, unchanged.
- R3. Unknown non-backend client routes resolve to the SPA entrypoint (`index.html`) rather than 404ing/redirecting through the backend.
- R4. Caddyfile structure tests assert owned paths are matched before the fallback, and the fallback rewrites to `/` before proxying to `dashboard:3000`.
- R5. The rendered Caddyfile is valid Caddy config (directive ordering correct; `caddy adapt` accepts it).

## Scope Boundaries

- No new credentials, environment variables, or operator-session origin changes.
- No change to the `/operator/*` route target, headers, or the operator private-path topology.
- No dashboard image bump — the image is consumed by digest (#561); this change is edge routing only.
- Not changing the backend itself — the dashboard container already serves `index.html` at `/`.

### Deferred to Separate Tasks

- The operator-page fixture→live migration (`/operator` SSR still serves `#26`-era fixtures) — tracked dashboard-side, unrelated to SPA edge routing.
- Any actual client-side router / deep-linkable routes — this plan only makes the edge ready for them.

## Context & Research

### Relevant Code and Patterns

- `apps/dashboard/config/Caddyfile` — static file, two `handle` blocks today (`/operator/*`, catch-all). `scp`'d to the droplet at deploy Phase 6 (`apps/dashboard/src/deploy.ts`, `REMOTE_CADDYFILE_PATH`); there is no `buildCaddyfile()` generator — edit the static file directly.
- `apps/dashboard/src/deploy.test.ts` (~lines 980-1023) — existing Caddyfile structure `describe` block: `readFileSync(caddyfilePath)` then asserts `handle /operator/*` present, catch-all `reverse_proxy dashboard:3000` in its own handle, and `/operator/*` ordered before the catch-all. Extend this block.

### Institutional Learnings

- `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md` — Caddy directive ordering trap: a bare `respond`/catch-all can sort ahead of a more specific route and self-404. Durable fix is mutually-exclusive `handle` blocks verified with `caddy adapt`.
- `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md` — established the `caddy adapt` validation precedent for this exact Caddyfile (mutually-exclusive handle blocks; verify ordering empirically).

### External References

- None needed — strong local pattern, Fro Bot triage supplied the fix shape, `caddy adapt` precedent exists.

## Key Technical Decisions

- **Explicit owned-paths matcher, not `try_files`/`file_server`.** The SPA assets and `index.html` live inside the dashboard container, not on the Caddy filesystem, so Caddy cannot `file_server` them. The SPA fallback must `rewrite * /` and re-proxy to `dashboard:3000` (which returns `index.html` at `/`). Backend-owned paths get an explicit matcher that proxies their original path unchanged.
- **`handle` blocks for mutual exclusion + ordering.** Keep `/operator/*` first, then a named-matcher `handle` for owned paths (proxy unchanged), then the catch-all `handle` that rewrites to `/`. `handle` blocks are evaluated in written order and are mutually exclusive — this avoids the self-404 directive-ordering trap.
- **Validate with `caddy adapt`.** Per the self-404 lesson, assert the rendered Caddyfile adapts cleanly and the route ordering holds, rather than trusting substring tests alone.

## Open Questions

### Resolved During Planning

- Is the Caddyfile generated or static? → Static (`apps/dashboard/config/Caddyfile`), `scp`'d at deploy. Edit the file directly.
- Should the fallback serve files from disk? → No; assets are in the container. Fallback rewrites to `/` and re-proxies to `dashboard:3000`.

### Deferred to Implementation

- Exact Caddy matcher syntax for the owned-paths group (named matcher vs. inline path list on `handle`). Resolve against `caddy adapt` during implementation — both are valid; pick the form that adapts cleanly and reads clearly.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
{$DASHBOARD_DOMAIN} {
    handle /operator/* {            # FIRST — unchanged: gateway VPC, headers, flush_interval -1
        reverse_proxy {$GATEWAY_VPC_IP}:9300 { ... }
    }
    handle <owned-paths> {          # /api/*, /auth/*, /assets/*, /manifest.webmanifest, /icon-*
        reverse_proxy dashboard:3000   # original path, unchanged
    }
    handle {                        # catch-all — SPA fallback
        rewrite * /                 # any unknown client route -> /
        reverse_proxy dashboard:3000   # backend returns index.html at /
    }
}
```

## Implementation Units

- [ ] **Unit 1: Add SPA fallback + owned-paths matcher to the Caddyfile**

**Goal:** Distinguish backend-owned paths from client-side routes so deep links resolve to the SPA while backend/asset paths proxy unchanged.

**Requirements:** R1, R2, R3, R5

**Dependencies:** None

**Files:**
- Modify: `apps/dashboard/config/Caddyfile`

**Approach:**
- Keep `handle /operator/*` first, byte-identical (target, `flush_interval -1`, `header_up Host`, `header_up X-Forwarded-Proto`).
- Add a middle `handle` matching owned paths `/api/*`, `/auth/*`, `/assets/*`, `/manifest.webmanifest`, `/icon-*` → `reverse_proxy dashboard:3000` (original path).
- Change the final catch-all `handle` to `rewrite * /` before `reverse_proxy dashboard:3000`.

**Execution note:** Load `systematic:test-driven-development`. Add/extend the Caddyfile structure tests RED first (Unit 2), then make this config change GREEN. Verify ordering with `caddy adapt` before considering it done.

**Patterns to follow:**
- Existing `/operator/*` handle block in the same file (mutually-exclusive `handle` ordering).
- `caddy adapt` validation precedent from `docs/plans/2026-06-18-003-...private-path-plan.md`.

**Test scenarios:** covered by Unit 2 (config + tests land together).

**Verification:**
- `caddy adapt` (against the same Caddy image used in compose) accepts the rendered Caddyfile with no errors.
- `/operator/*` block is unchanged and still first.

- [ ] **Unit 2: Extend Caddyfile structure tests**

**Goal:** Pin the owned-paths-before-fallback ordering and the SPA rewrite so the routing contract can't silently regress.

**Requirements:** R4

**Dependencies:** Unit 1 (same change set; write tests first per execution note)

**Files:**
- Modify: `apps/dashboard/src/deploy.test.ts` (the existing Caddyfile structure `describe` block, ~lines 980-1023)

**Approach:**
- Reuse the existing `readFileSync(caddyfilePath)` pattern in that describe block.
- Assert the owned-paths matcher contains all five paths (`/api/*`, `/auth/*`, `/assets/*`, `/manifest.webmanifest`, `/icon-*`).
- Assert the owned-paths `handle` is ordered after `/operator/*` and before the catch-all.
- Assert the catch-all `handle` contains `rewrite * /` before `reverse_proxy dashboard:3000`.
- Keep the existing `/operator/*`-before-catch-all ordering assertion.

**Test scenarios:**
- Happy path: Caddyfile contains a `handle /operator/*` block (existing, keep).
- Happy path: owned-paths handle includes each of `/api/*`, `/auth/*`, `/assets/*`, `/manifest.webmanifest`, `/icon-*`.
- Edge (ordering): `/operator/*` index < owned-paths handle index < catch-all handle index.
- Happy path: catch-all handle contains `rewrite * /` positioned before `reverse_proxy dashboard:3000`.

**Verification:**
- `bun test apps/dashboard/src/deploy.test.ts` passes with the new assertions.

## System-Wide Impact

- **Interaction graph:** Edge routing only. `/operator/*` (operator private path) untouched; `/api/*`+`/auth/*` (BFF) untouched; only previously-catch-all client routes change behavior (now rewritten to `/`).
- **API surface parity:** None — single Caddyfile, single origin.
- **Unchanged invariants:** `/operator/*` → gateway VPC with existing headers/`flush_interval -1`; `/api/healthz` and `/operator/health` behavior; asset proxying; the operator-session origin model.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Caddy directive ordering causes the catch-all to sort ahead of owned paths (self-404 class) | Use mutually-exclusive `handle` blocks in written order; verify with `caddy adapt`; structure test pins ordering. |
| An owned path is missed and gets rewritten to `/` (e.g., a future asset prefix) | Enumerate the five documented owned paths from the dashboard contract; if the backend adds a served prefix later, the matcher must be updated (note in deploy verification). |
| `rewrite * /` accidentally applied to `/api`/`/auth` | Owned-paths `handle` precedes the catch-all and is mutually exclusive, so owned paths never reach the rewrite. |

## Documentation / Operational Notes

- No changeset — `apps/` deploy config only, not published `packages/cli/src` runtime.
- Post-deploy verification (after the gated dashboard deploy): `/api/healthz` returns 200; `/operator/health` behavior unchanged; an asset path still proxies unchanged; a synthetic unknown client route (e.g. `/__spa_probe`) returns the SPA document (200 + `index.html`) rather than a backend `302`/`404`.

## Sources & References

- Issue: marcusrbrown/infra#669 (+ Fro Bot triage comment)
- Related code: `apps/dashboard/config/Caddyfile`, `apps/dashboard/src/deploy.ts` (`REMOTE_CADDYFILE_PATH`), `apps/dashboard/src/deploy.test.ts` (Caddyfile structure tests)
- Related learnings: `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md`, `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md`
