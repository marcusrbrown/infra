---
title: 'Bind-mounted Caddyfile changes not loaded on dashboard deploy (missing --force-recreate)'
problem_type: integration_issue
component: tooling
root_cause: missing_workflow_step
resolution_type: code_fix
severity: high
date: 2026-07-26
tags: [dashboard, caddy, docker-compose, bind-mount, stale-config, deploy, force-recreate]
module: apps/dashboard
related_issues:
  - https://github.com/marcusrbrown/infra/pull/953
  - https://github.com/marcusrbrown/infra/pull/954
  - https://github.com/marcusrbrown/infra/pull/948
  - https://github.com/marcusrbrown/infra/pull/740
related_docs:
  - docs/solutions/integration-issues/broker-credential-lifecycle-restart-races-2026-07-02.md
  - docs/solutions/integration-issues/dashboard-spa-caddy-catchall-deep-link-404-2026-06-25.md
  - docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md
---

# Bind-mounted Caddyfile changes not loaded on dashboard deploy

## Problem

The dashboard Caddyfile is bind-mounted into the caddy container (`./config/Caddyfile:/etc/caddy/Caddyfile` in `apps/dashboard/docker-compose.yaml`). `docker compose up -d` does **not** recreate a service solely because the *content* of a bind-mounted file changed — it recreates only on image, service-definition, or environment changes. So a deploy can `scp` a new Caddyfile to the droplet, report success, and leave the running Caddy process serving the previous routing. **A green deploy and a correct on-disk config are not proof that the live process loaded them** — the same class as the broker stale-bundle trap ([#740](https://github.com/marcusrbrown/infra/pull/740)).

## Symptoms

- After extension-based asset routing merged in [#953](https://github.com/marcusrbrown/infra/pull/953) and the dashboard deploy reported success, `https://dashboard.fro.bot/sw.js` and `/static/operator-stream.js` still returned stale `302`/`text/html` instead of `200 text/javascript`.
- The operator **Runs** view showed "Service unavailable" because its module script (`operator-stream.js`) and the service worker (`sw.js`) failed browser MIME checks (`Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"`).
- The caddy container's `.State.StartedAt` was ~`2026-07-13` with `RestartCount: 0` — ~13 days before the deploy, proving the container was never recreated.
- Reading the Caddyfile on disk showed the correct new content, which masked the real gap: the *running* Caddy still held its old startup config.

## What Didn't Work

- Chasing operator auth: the `401` on `/operator/session` from unauthenticated probes was expected noise, not the cause.
- Chasing the SSE run-stream path: downstream symptom of the asset failure, not the root cause.
- Verifying the uploaded Caddyfile on disk: necessary but not sufficient — it does not prove the running container reloaded it. The decisive signal was the browser console MIME error plus the pre-deploy `.State.StartedAt`.

## Solution

**Immediate recovery** (restore production without touching certs):

```sh
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 caddy
```

Never use `docker compose down -v` for this — `-v` removes the named `caddy_data` volume holding ACME/TLS state, and re-issuance can hit Let's Encrypt rate limits.

**Durable fix** ([#954](https://github.com/marcusrbrown/infra/pull/954)) — add `--force-recreate` to the Phase 11 caddy bring-up in `apps/dashboard/src/deploy.ts`:

```diff
- cd ${REMOTE_DIR} && docker compose up -d --no-build --wait --wait-timeout 120 caddy
+ cd ${REMOTE_DIR} && docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 caddy
```

The dashboard **app** bring-up (Phase 9) intentionally keeps no `--force-recreate` — it is digest-gated and must not be needlessly recreated.

## Why This Works

`--force-recreate` forces the caddy container to be replaced, so it re-reads the bind-mounted Caddyfile on start. The `caddy_data` named volume stays attached across recreation, preserving ACME certificates — only volume deletion (`down -v`) removes that state. Scoping the flag to the caddy service (no `--always-recreate-deps`) leaves the already-health-gated app container untouched.

## Prevention

- **Treat any bind-mounted config or artifact as needing explicit recreation/reload after upload.** `docker compose up -d` silently no-ops on mounted-file *content* changes (Caddyfile here; broker `dist/main.js` in [#740](https://github.com/marcusrbrown/infra/pull/740)).
- **Deploy-green ≠ config-live.** Verify both: the container `.State.StartedAt` advanced into the deploy window, and the live endpoint returns the expected status/content-type (`/sw.js` → `200 text/javascript`; `/operator/*` still gateway-routed).
- **Never `down -v`** for a config reload — scope `--force-recreate` to the service consuming the changed mount, preserving the ACME cert volume.
- **Pin the contract in a deploy test** so the recreate step can't silently regress (`apps/dashboard/src/deploy.test.ts`):

```ts
expect(dashboardUpCall?.cmd.join(' ')).not.toContain('--force-recreate')
expect(caddyUpCall?.cmd.join(' ')).toContain('--force-recreate')
```

## Related Issues

- [#953](https://github.com/marcusrbrown/infra/pull/953) — extension-based Caddy asset routing (the change that exposed the stale-reload trap).
- [#954](https://github.com/marcusrbrown/infra/pull/954) — the durable `--force-recreate` fix documented here.
- [#948](https://github.com/marcusrbrown/infra/pull/948) — dashboard listener-state persistence (same incident window, different root cause).
- [broker-credential-lifecycle-restart-races-2026-07-02.md](./broker-credential-lifecycle-restart-races-2026-07-02.md) — strongest precedent: the same bind-mounted-content-vs-container-recreation trap for the broker's `dist/main.js`, fixed with `--force-recreate` in [#740](https://github.com/marcusrbrown/infra/pull/740).
- [dashboard-spa-caddy-catchall-deep-link-404-2026-06-25.md](./dashboard-spa-caddy-catchall-deep-link-404-2026-06-25.md) — same `apps/dashboard/config/Caddyfile`; its `@owned` asset allowlist drifted and served operator assets as `text/html`, superseded by the extension matcher in [#953](https://github.com/marcusrbrown/infra/pull/953).
- [gateway-deploy-stale-image-2026-05-31.md](../workflow-issues/gateway-deploy-stale-image-2026-05-31.md) — same "green deploy does not prove freshness" lesson for stale Docker images.
