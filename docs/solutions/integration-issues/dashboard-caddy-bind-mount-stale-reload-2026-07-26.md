---
title: "Bind-mounted Caddyfile and PEM key changes not loaded on dashboard deploy (missing --force-recreate)"
problem_type: integration_issue
component: tooling
root_cause: missing_workflow_step
resolution_type: code_fix
severity: high
date: 2026-07-26
last_updated: 2026-10-22
symptoms:
  - "Caddy kept serving old routes after a green deploy uploaded a new Caddyfile"
  - "Operator assets returned text/html instead of text/javascript, so the Runs view showed 'Service unavailable'"
  - "A key-only PEM change would deploy green while the dashboard container kept reading the old key (found in review)"
tags: [dashboard, caddy, docker-compose, bind-mount, force-recreate, pem-key, atomic-replace, deploy]
module: apps/dashboard
related_issues:
  - https://github.com/marcusrbrown/infra/pull/953
  - https://github.com/marcusrbrown/infra/pull/954
  - https://github.com/marcusrbrown/infra/pull/948
  - https://github.com/marcusrbrown/infra/pull/740
  - https://github.com/marcusrbrown/infra/pull/1638
related_docs:
  - docs/solutions/integration-issues/broker-credential-lifecycle-restart-races-2026-07-02.md
  - docs/solutions/integration-issues/dashboard-spa-caddy-catchall-deep-link-404-2026-06-25.md
  - docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md
---

# Bind-mounted Caddyfile and PEM key changes not loaded on dashboard deploy

## Problem

The dashboard Caddyfile is bind-mounted into the caddy container (`./config/Caddyfile:/etc/caddy/Caddyfile` in `apps/dashboard/docker-compose.yaml`). `docker compose up -d` does **not** recreate a service solely because the _content_ of a bind-mounted file changed — it recreates only on image, service-definition, or environment changes. So a deploy can `scp` a new Caddyfile to the droplet, report success, and leave the running Caddy process serving the previous routing. **A green deploy and a correct on-disk config are not proof that the live process loaded them** — the same class as the broker stale-bundle trap ([#740](https://github.com/marcusrbrown/infra/pull/740)).

The same trap was latent for the dashboard **app** container's private keys, and was found in review of [#1638](https://github.com/marcusrbrown/infra/pull/1638) before any rotation. The GitHub App and Fro Bot App keys are single-file bind mounts (`apps/dashboard/docker-compose.yaml:57` and `:59`) that the deploy replaces atomically. A deploy that changed only a key left the image and env identical, so the plain `up` kept the container and reported success while it still read the old key. Revoking the old key would then have broken the app. The existing `github-app.pem` had the same gap.

## Symptoms

- After extension-based asset routing merged in [#953](https://github.com/marcusrbrown/infra/pull/953) and the dashboard deploy reported success, `https://dashboard.fro.bot/sw.js` and `/static/operator-stream.js` still returned stale `302`/`text/html` instead of `200 text/javascript`.
- The operator **Runs** view showed "Service unavailable" because its module script (`operator-stream.js`) and the service worker (`sw.js`) failed browser MIME checks (`Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"`).
- The caddy container's `.State.StartedAt` was ~`2026-07-13` with `RestartCount: 0` — ~13 days before the deploy, proving the container was never recreated.
- Reading the Caddyfile on disk showed the correct new content, which masked the real gap: the _running_ Caddy still held its old startup config.

## What Didn't Work

- Chasing operator auth: the `401` on `/operator/session` from unauthenticated probes was expected noise, not the cause.
- Chasing the SSE run-stream path: downstream symptom of the asset failure, not the root cause.
- Verifying the uploaded Caddyfile on disk: necessary but not sufficient — it does not prove the running container reloaded it. The decisive signal was the browser console MIME error plus the pre-deploy `.State.StartedAt`.
- **Recreating only when a key changed.** Comparing each staged key with the host file (`cmp -s`) misses a retry. If a deploy publishes the new key and then fails before the recreate, the host already holds the new key on retry, the comparison reports no change, and the container keeps the old one. A pending-recreate marker or a key hash read from inside the container would close that gap, but each adds on-host state or depends on tools in the image.

## Solution

**Immediate recovery** (restore production without touching certs):

```sh
cd /opt/dashboard && docker compose up -d --no-build --no-deps --force-recreate --wait --wait-timeout 120 caddy
```

Never use `docker compose down -v` for this — `-v` removes the named `caddy_data` volume holding ACME/TLS state, and re-issuance can hit Let's Encrypt rate limits.

**Durable fix** ([#954](https://github.com/marcusrbrown/infra/pull/954)): add `--force-recreate` to the caddy bring-up, then in `apps/dashboard/src/deploy.ts`. The remote deploy program carries the flagged line at `apps/dashboard/src/remote-deploy.ts:544`.

```diff
- docker compose up -d --no-build --wait --wait-timeout 120 caddy
+ docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 caddy
```

**Dashboard app** ([#1638](https://github.com/marcusrbrown/infra/pull/1638)): force-recreate the dashboard container on every deploy too, after both keys are published (`apps/dashboard/src/remote-deploy.ts:533`):

```diff
- docker compose up -d --no-build --wait --wait-timeout 120 dashboard
+ docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 dashboard
```

The digest, health, and readback checks after it are unchanged. Most deploys change the image anyway. A config-only deploy now also restarts the dashboard, bounded by its `--wait` health gate.

## Why This Works

`--force-recreate` forces the caddy container to be replaced, so it re-reads the bind-mounted Caddyfile on start. The `caddy_data` named volume stays attached across recreation, preserving ACME certificates — only volume deletion (`down -v`) removes that state. Scoping the flag to the caddy service (no `--always-recreate-deps`) leaves the already-health-gated app container untouched.

For the dashboard app, `publish_active_file` (`apps/dashboard/src/remote-deploy.ts:410`) replaces each key with `mv -f` (`apps/dashboard/src/remote-deploy.ts:424`), which puts a new inode at the path. A single-file bind mount binds the inode that exists when the container is created, so a running container keeps the old key. A new container binds the current inodes, so it always reads the keys the deploy just published. Recreating unconditionally does not depend on comparing files, so a retry after a partial failure converges too.

## Prevention

- **Recreate or reload after any upload that changes a bind-mounted file.** Caddyfile here; broker `dist/main.js` in [#740](https://github.com/marcusrbrown/infra/pull/740).
- **An atomic replace (`mv`) under a single-file bind mount needs one of three things:** recreate the container after the replace, write the file in place (same inode), or mount the parent directory instead of the file. Choose one per mount and keep the reason in the deploy code. `apps/cliproxy/AGENTS.md` forbids `sed -i` and `mv` on `config.yaml` for the same reason.
- **Deploy-green ≠ config-live.** Verify both: the container `.State.StartedAt` advanced into the deploy window, and the live endpoint returns the expected status/content-type (`/sw.js` → `200 text/javascript`; `/operator/*` still gateway-routed). For keys, check that the new container started after the publish and that the app reports the credential usable (for the wiki writer, the dashboard's `GET /api/wiki/pages` returns `canWrite: true`).
- **Pin the contract in tests** so the recreate step can't silently regress. In `apps/dashboard/src/deploy.test.ts:729-730`, both `up` calls carry the flag:

```ts
expect(command).toContain("docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 dashboard")
expect(command).toContain("docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 caddy")
```

The `dashboard is always force-recreated after the keys are published` suite in `apps/dashboard/src/remote-deploy.test.ts:3224` adds two checks. One asserts the single dashboard `up` runs after both key publishes. The other runs the real remote program against a stubbed `docker` with unchanged keys and asserts the logged `up` still carries `--force-recreate`, which covers the retry case.

## Related Issues

- [#953](https://github.com/marcusrbrown/infra/pull/953) — extension-based Caddy asset routing (the change that exposed the stale-reload trap).
- [#954](https://github.com/marcusrbrown/infra/pull/954) — the durable caddy `--force-recreate` fix.
- [#1638](https://github.com/marcusrbrown/infra/pull/1638) — Fro Bot App key mount and the unconditional dashboard recreate.
- [#948](https://github.com/marcusrbrown/infra/pull/948) — dashboard listener-state persistence (same incident window, different root cause).
- [broker-credential-lifecycle-restart-races-2026-07-02.md](./broker-credential-lifecycle-restart-races-2026-07-02.md) — strongest precedent: the same bind-mounted-content-vs-container-recreation trap for the broker's `dist/main.js`, fixed with `--force-recreate` in [#740](https://github.com/marcusrbrown/infra/pull/740).
- [dashboard-spa-caddy-catchall-deep-link-404-2026-06-25.md](./dashboard-spa-caddy-catchall-deep-link-404-2026-06-25.md) — same `apps/dashboard/config/Caddyfile`; its `@owned` asset allowlist drifted and served operator assets as `text/html`, superseded by the extension matcher in [#953](https://github.com/marcusrbrown/infra/pull/953).
- [gateway-deploy-stale-image-2026-05-31.md](../workflow-issues/gateway-deploy-stale-image-2026-05-31.md) — same "green deploy does not prove freshness" lesson for stale Docker images.
