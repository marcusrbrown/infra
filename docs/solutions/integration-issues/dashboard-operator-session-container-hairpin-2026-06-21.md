---
title: Dashboard operator-session cutover redirect loop — container cannot hairpin to its own public hostname
date: 2026-06-21
category: integration-issues
module: apps/dashboard
problem_type: integration_issue
component: authentication
symptoms:
  - Dashboard monitoring page (dashboard.fro.bot/) redirect-loops after enabling DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true
  - Container logs spam "gateway-auth: session validation failed {path:/}" + "operator-client: network error {route:/operator/session}"
  - OAuth callback succeeds ("OAuth callback: session issued") but the very next request to / re-redirects to /auth/login
  - From inside the dashboard container, fetch to https://dashboard.fro.bot/operator/session returns UND_ERR_CONNECT_TIMEOUT
root_cause: config_error
resolution_type: config_change
severity: high
related_components: [caddy, gateway, docker-compose, digitalocean]
tags: [dashboard, operator-session, caddy, docker-network-alias, hairpin-nat, same-origin, server-side-auth, digitalocean]
---

# Dashboard operator-session cutover redirect loop — container cannot hairpin to its own public hostname

## Problem

Enabling the dashboard's gateway operator-session auth cutover (`DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true`) broke the monitoring page with a post-authentication redirect loop: after a successful GitHub OAuth login, every request to `/` immediately redirected back to `/auth/login`. The dashboard was unreachable even though the gateway session endpoint itself was healthy.

## Symptoms

- `https://dashboard.fro.bot/` loops; the operator cannot reach the monitoring page after logging in.
- Container logs (`docker logs dashboard-dashboard-1`) repeat:
  - `[warning] gateway-auth: session validation failed {"path":"/"}`
  - `[error] operator-client: network error {"route":"/operator/session"}`
  - interleaved with successful `[info] OAuth callback: session issued {"login":"marcusrbrown"}`
- From inside the container, `fetch("https://dashboard.fro.bot/operator/session")` → `UND_ERR_CONNECT_TIMEOUT`.
- From inside the container, `fetch("http://10.116.0.3:9300/operator/session")` (gateway VPC IP) → `401` (works — reaches the real endpoint).
- The same `/operator/session` probed from a browser (or via Caddy) → `401` unauth / `200` authed. The endpoint exists and works; only the dashboard server's call fails.

## What Didn't Work

- **Setting `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=false`** stops the loop (falls back to the dashboard's own Arctic GitHub-OAuth session), but it abandons the single-auth gateway-session cutover that v0.72.0 was deployed to enable. It is a stopgap, not the fix.
- **Assuming the gateway lacked a `/operator/session` endpoint.** It exists and returns 401/200 correctly — the failure was a *network error* from the dashboard server, not a 404.
- **`extra_hosts: dashboard.fro.bot:host-gateway`** (pointing at the Docker host's published `:443`) → `ECONNRESET`/timeout. The droplet's published port isn't cleanly reachable from the container's bridge that way.
- **Reaching Caddy by compose service name** (`https://caddy/operator/session`) → `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR`. Caddy's cert is for `dashboard.fro.bot`, so SNI on `caddy` fails — and the forwarded cookie is scoped to `dashboard.fro.bot` anyway.
- **Monitoring the logs for a gateway-auth success line** to confirm a working login — there is none (see Prevention: silent-success trap).

## Solution

Add a Docker **network alias `dashboard.fro.bot`** to the `caddy` service in the committed base `apps/dashboard/docker-compose.yaml`. The dashboard container then resolves `dashboard.fro.bot` to the Caddy container via Docker DNS, and Caddy's existing `/operator/*` route proxies the server-side validation call to the gateway VPC. `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED` stays `true`.

```yaml
services:
  caddy:
    # The dashboard server validates every request by calling
    # https://dashboard.fro.bot/operator/session server-side. Without this alias
    # that call hairpins to the droplet's public IP — DigitalOcean has no NAT
    # loopback, so it times out. The alias routes the call to Caddy via Docker DNS;
    # Caddy's /operator/* handle proxies it to the gateway VPC.
    networks:
      default:
        aliases:
          - dashboard.fro.bot
  dashboard:
    networks:
      default:        # explicit attachment so existing DNS (dashboard:3000) stays intact

networks:
  default:
    name: dashboard_default
```

**Critical placement constraint:** the alias must live in the base `docker-compose.yaml`, **not** a `docker-compose.override.yaml`. The dashboard deploy's Phase 7.5 runs `rm -f /opt/dashboard/docker-compose.override.yaml` on every deploy (legacy image-pin cleanup), so an override would be silently deleted on the next deploy and the loop would return.

Verified after the alias (from inside the container): `fetch("https://dashboard.fro.bot/operator/session")` → real `401` instead of a timeout; `session validation failed` and `network error` counts dropped to `0`; the authenticated monitoring page loads.

## Why This Works

When `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true`, the dashboard's global `app.use('*')` auth middleware (`src/server.ts`) switches the **entire app** (including the root monitoring page `/`) to the gateway branch: it authorizes each non-public request by calling `GET /operator/session` **server-side**, forwarding the end-user's cookie, with **no fallback to Arctic**. The request URL is resolved against the single configured `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` (default `https://dashboard.fro.bot`), and `createOperatorServerFetch` enforces a hard invariant that the fetch origin must equal that configured origin — there is no separate internal-URL knob.

So the dashboard *server* must reach `https://dashboard.fro.bot` from inside its own container. On a DigitalOcean droplet that fails: the public hostname resolves to the droplet's own public IP (`206.189.198.47`), and DigitalOcean does not NAT-loopback a droplet's public IP back to itself, so the connection times out. The validation fetch throws → `!isOk(result)` → redirect to `/auth/login`. The browser never hits this (it's not behind the hairpin); only the server-side validation call does — which is why `/operator/*` worked in the browser but `/` looped.

The network alias makes `dashboard.fro.bot` resolve, *inside the container only*, to the Caddy container instead of the public IP. Docker's embedded DNS returns Caddy's container address, TLS SNI still matches (`dashboard.fro.bot`), and Caddy's `/operator/*` `handle` block (`reverse_proxy {$GATEWAY_VPC_IP}:9300`, `header_up Host dashboard.fro.bot`) forwards the call to the gateway operator listener over the VPC — the same path the browser uses, just reached internally.

## Prevention

- **Network alias on Caddy lives in the base compose file**, never an override — the deploy deletes overrides. A `docker-compose.test.ts` assertion locks the alias and the shared `default` network in place.
- **Keep `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true`** in `buildEnvFileContents` — it is the intended single-auth cutover, not an optional toggle. A repo anti-pattern note forbids setting it false.
- **Silent-success observability trap:** the gateway-auth middleware logs **only failures** (`session validation failed`). A valid session does `c.set('gatewaySession', ...)` then `next()` with no log line. Do **not** monitor for a success log that doesn't exist — the success signal is the *absence* of `session validation failed` / `operator-client: network error` over the window, combined with the page rendering. Confirm with `docker logs ... | grep -c 'session validation failed'` returning `0`.
- **Diagnose server-side reachability from inside the container, not from the host or a browser.** `docker exec <container> node -e 'fetch(...)'` exposed the hairpin timeout that host-level / browser probes could not. A 401 from the VPC IP vs a connect-timeout from the public hostname is the decisive split.
- **Single-origin server-side auth assumes the app server can reach the gateway at the same public URL the browser uses.** Behind a VPC/Caddy hairpin topology that assumption breaks; the network alias bridges it without an upstream change. (If upstream ever adds a separate internal-gateway-URL option, prefer that.)

## Related Issues

- `#581` — Decide same-origin hosting path for dashboard operator UI (CLOSED; this completes the server-side leg).
- `docs/solutions/integration-issues/docker-network-stale-subnet-cleanup-2026-06-18.md` — adjacent Docker-network/topology work on the operator rollout (different failure mode: stale IPAM subnet, not server-side hairpin).
- `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md` — Caddy `/operator`-adjacent route ordering trap (different layer: Caddy directive ordering).
- `docs/solutions/workflow-issues/gateway-do-firewall-in-deploy-path-2026-06-19.md` — operator VPC access hardening (provisioning vs deploy layering).
