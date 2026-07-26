---
title: Dashboard SPA deep links 404 without a Caddy catch-all rewrite
date: 2026-06-25
last_updated: 2026-07-26
category: docs/solutions/integration-issues/
module: apps/dashboard
problem_type: integration_issue
component: tooling
symptoms:
  - Client-side dashboard deep links would reach the backend as that exact path instead of loading the SPA
  - An arbitrary non-owned path was handled by the backend auth/operator surface (302) rather than resolving to the SPA document
  - Inline multi-path handle syntax is rejected by Caddy 2.11.3
  - file_server / try_files cannot serve the SPA fallback because assets live in the container, not on Caddy's filesystem
root_cause: missing_workflow_step
resolution_type: config_change
severity: medium
related_components:
  - frontend
  - caddy
  - reverse-proxy
tags:
  - dashboard
  - caddy
  - spa
  - pwa
  - reverse-proxy
  - handle
  - rewrite
  - deep-linking
---

# Dashboard SPA deep links 404 without a Caddy catch-all rewrite

## Problem

The dashboard `/` view was rebuilt as a Vite + React SPA served from the container, while the Hono backend stays as the same-origin BFF. The infra-side Caddy catch-all sent every non-`/operator/*` request to the backend at that exact path, so future client-side deep links (`/runs`, `/settings`, …) would 404 or bounce through backend routing instead of loading `index.html`.

## Symptoms

- Before the fix, an arbitrary non-owned path was handled by the backend auth/operator surface and redirected (`302 → /operator/auth/github/start`) rather than resolving to the SPA document — there was no SPA fallback for client routes.
- The committed `apps/dashboard/config/Caddyfile` had only two `handle` blocks: `/operator/*` → gateway VPC, and a catch-all → `dashboard:3000` proxying the original path unchanged.

## What Didn't Work

- **`file_server` / `try_files`** — does not work here: the SPA assets and `index.html` live inside the dashboard container, not on Caddy's filesystem, so Caddy cannot serve them from disk.
- **Inline multi-path `handle`** — `handle /api/* /auth/* ... { }` is rejected by Caddy 2.11.3; a `handle` directive accepts only a single path argument. A named matcher is required to group multiple owned paths.

## Solution

`apps/dashboard/config/Caddyfile` is a static file `scp`'d to the droplet at deploy (there is no generator function), so the fix edits it directly. Use three mutually-exclusive `handle` blocks in order:

```caddyfile
{$DASHBOARD_DOMAIN} {
    handle /operator/* {              # unchanged: gateway VPC, headers, flush_interval -1
        reverse_proxy {$GATEWAY_VPC_IP}:9300 {
            flush_interval -1
            header_up Host dashboard.fro.bot
            header_up X-Forwarded-Proto https
        }
    }
    handle /api/* {                   # backend routes, original path unchanged
        reverse_proxy dashboard:3000
    }
    handle /auth/* {
        reverse_proxy dashboard:3000
    }
    @assets path_regexp \.[A-Za-z0-9]+$   # any file-with-extension -> app, original path
    handle @assets {
        reverse_proxy dashboard:3000
    }
    handle {
        rewrite * /                    # unknown (extensionless) client route -> /
        reverse_proxy dashboard:3000   # backend serves index.html at /
    }
}
```

> **Update (2026-07-26, [#953](https://github.com/marcusrbrown/infra/pull/953)):** the original fix used a hand-maintained `@owned path /api/* /auth/* /assets/* /manifest.webmanifest /icon-*` allowlist. That allowlist **drifted**: the operator UI shipped root-level assets (`operator-stream.js`, `sw.js`, `static/operator-*.js`) that were never added to it, so the catch-all rewrote them to `/` and served the SPA HTML shell — the browser rejected the module script and service worker for MIME `text/html` and the operator Runs view went "Service unavailable". The block above shows the current, drift-proof shape: route any path **with a file extension** to the app at its real path (subsuming `/assets/*`, `/manifest.webmanifest`, `/icon-*`), and rewrite only extensionless client routes to the SPA entrypoint. See [dashboard-caddy-bind-mount-stale-reload-2026-07-26.md](./dashboard-caddy-bind-mount-stale-reload-2026-07-26.md) for the follow-on deploy trap where this Caddyfile change did not load until the caddy container was force-recreated.

Validate the rendered config with `caddy adapt` against the pinned image:

```bash
docker run --rm -i caddy:2.11.3-alpine caddy adapt --adapter caddyfile - < apps/dashboard/config/Caddyfile
```

## Why This Works

`handle` blocks are mutually exclusive and evaluated in written order, so `/operator/*` and the explicit owned paths are matched before the catch-all ever runs. The catch-all rewrites any unmatched (client-route) path to `/` and re-proxies to the backend, which serves the SPA `index.html` at `/`. Backend-owned and asset paths keep their original URI, so the API, auth, and hashed assets are unaffected. This is the same mutually-exclusive-`handle` + `caddy adapt` discipline that avoids the directive-ordering self-404 trap.

## Prevention

- **Verification method — compare the unknown route to `/`, not to the SPA document.** An unknown client route must return the *same* response as `/`. Here both return `302 → /operator/auth/github/start?return_to=/operator` because `/` is auth-gated in SESSION mode. The `302`-equals-`/` result (not a backend `404` for the deep-link path) proves `rewrite * /` reached the backend at `/`. An unauthenticated probe correctly gets the auth redirect rather than the SPA doc; an authenticated browser gets `index.html`. Expecting the SPA document from an unauthenticated probe on an auth-gated root is a false-negative trap.
- Also confirm the unchanged paths after deploy: `/api/healthz` still `200`, `/operator/health` unchanged, asset paths still proxy unchanged.
- Use this pattern whenever a reverse proxy fronts a container-served SPA plus same-origin backend: route file-with-extension paths to the app at their real path, then fall back extensionless client routes to the SPA entrypoint via `rewrite * /` (not `file_server`, since assets are in the container). Prefer this over a hand-maintained asset allowlist — an allowlist silently drifts as the app adds root-level assets ([#953](https://github.com/marcusrbrown/infra/pull/953)).
- Prefer named matchers for multi-path groups in Caddy — inline multi-path `handle` is rejected.
- Always `caddy adapt`-validate edge config against the pinned image to catch directive-ordering and syntax mistakes before deploy.
- A Caddyfile structure test (in `apps/dashboard/src/deploy.test.ts`) pins owned-paths-before-fallback ordering and the `rewrite * /`-before-`reverse_proxy` shape so the routing contract can't silently regress.

## Related Issues

- infra#669 (closed via PR #676) — the issue this resolves.
- [#953](https://github.com/marcusrbrown/infra/pull/953) — replaced this doc's `@owned` allowlist with extension-based routing after the allowlist drifted and served operator assets as `text/html`.
- [dashboard-caddy-bind-mount-stale-reload-2026-07-26.md](./dashboard-caddy-bind-mount-stale-reload-2026-07-26.md) — the follow-on trap: the [#953](https://github.com/marcusrbrown/infra/pull/953) Caddyfile change did not load until the caddy container was force-recreated on deploy ([#954](https://github.com/marcusrbrown/infra/pull/954)).
- [gateway-caddy-announce-ingress-self-404-2026-06-04.md](./gateway-caddy-announce-ingress-self-404-2026-06-04.md) — direct Caddy lineage: directive-ordering self-404 trap, same `caddy adapt` + mutually-exclusive `handle` discipline (different failure class).
- [dashboard-operator-session-container-hairpin-2026-06-21.md](./dashboard-operator-session-container-hairpin-2026-06-21.md) — broader dashboard/operator Caddy routing context (container hairpin, not SPA fallback).
- `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md` — established the dashboard `/operator/*` Caddy route and the `caddy adapt` validation precedent.
