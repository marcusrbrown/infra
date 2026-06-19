---
title: Dashboard operator same-origin — private VPC path to the gateway operator listener
date: 2026-06-18
status: requirements
related:
  - docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md
  - apps/gateway/src/deploy.ts
  - apps/dashboard/config/Caddyfile
  - apps/dashboard/src/deploy.ts
  - apps/gateway/AGENTS.md
  - apps/dashboard/AGENTS.md
issues:
  - 579 (gateway listener topology — closed)
  - 580 (operator auth/config secrets — closed, shipped)
  - 581 (same-origin hosting decision — ratified)
---

# Dashboard operator same-origin — private VPC path

## Problem

The same-origin ratification plan (`docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`)
established that `https://dashboard.fro.bot` is the browser-visible operator API origin, with the
dashboard Caddy owning `/operator/*` and proxying privately to the gateway operator listener. Three
prerequisites were listed before that route could go live: (1) operator auth/session/CSRF contract,
(2) a private dashboard→gateway path, (3) the dashboard Caddy `/operator/*` route itself.

Prerequisite (1) is now **met** — operator auth/config secrets are wired and live (`#580`, shipped).
This brainstorm resolves prerequisites (2) and (3): how the dashboard Caddy reaches the gateway
operator listener over a private path, and the route that exposes it.

## Key discovery: the private path already exists

The plan assumed a private network had to be **built** (DigitalOcean VPC / peering / WireGuard — an
open question). Verified live, it already exists:

- `gateway` and `dashboard` droplets are on the **same DigitalOcean VPC** (`nyc1`, uuid
  `d95c26cc-…`).
- Private VPC IPs: **gateway `10.116.0.3`** (eth1), **dashboard `10.116.0.5`**.
- The dashboard droplet can already reach the gateway droplet over `10.116.0.x`.

So there is no new network to build. The remaining gap is narrow: the gateway operator listener binds
the Docker `gateway-net` internal address **`172.21.0.2:9300` with no host-published port**, so it is
not reachable over the VPC yet. The work is to bridge that container listener onto the gateway's VPC
IP, securely, and add the dashboard Caddy route.

## Verified constraints

- **The daemon must stay bound to `gateway-net`.** `apps/gateway/src/deploy.ts` hard-validates that
  `GATEWAY_OPERATOR_BIND_HOST` is a `172.21.x.x` gateway-net address (rejecting loopback, sandbox-net,
  and non-gateway-net IPs). The daemon cannot be rebound to the host VPC IP; the bridge must be a
  Docker port-publish, not a daemon rebind.
- **The forwarded-header guard is NOT authorization.** The v0.69.0 operator endpoint returns 400
  unless the request has no forwarded headers OR `X-Forwarded-Host == dashboard.fro.bot` and
  `X-Forwarded-Proto: https`. Any host that can reach `:9300` can forge those headers — so network
  source restriction is the actual access control, not the guard.
- **Docker published ports bypass UFW's INPUT chain** (DNAT/FORWARD). Source restriction on a
  published port must live in the `DOCKER-USER` iptables chain (or a provider firewall), not plain
  `ufw` rules. This repo has hit this before (announce ingress).
- The dashboard is a `dashboard` + `caddy` Docker Compose stack; `apps/dashboard/config/Caddyfile`
  currently has only `reverse_proxy dashboard:3000` (no `/operator/*` route).

## Chosen approach: Design A (Oracle-validated)

Publish the gateway operator listener on the gateway's **VPC IP only**, restrict the source to the
dashboard droplet, and have the dashboard Caddy proxy `/operator/*` to it. Oracle compared this against
a second Caddy-hop design and recommended Design A decisively (smaller attack surface, one proxy hop,
no public/private Caddy multiplexing, fewer header footguns; the Caddy-hop design still needs a
published VPC port so it does not avoid the Docker/UFW problem and it adds an `X-Forwarded-Proto`
overwrite footgun).

## Scope

### R1 — Publish the operator listener on the gateway VPC IP only

The gateway compose override (`buildComposeOverride` in `apps/gateway/src/deploy.ts`) publishes the
operator port bound to the gateway's **VPC IP** (a named config value, e.g. `GATEWAY_VPC_IP`; current
value `10.116.0.3`): `ports: ["${GATEWAY_VPC_IP}:9300:9300"]` (never `0.0.0.0`). The daemon stays bound
to `172.21.0.2:9300` inside `gateway-net`. Binding to the VPC IP (not the public `eth0`) is the primary
control preventing public-internet exposure. This is net-new override behavior — the gateway override
does not emit a `ports:` mapping today.

### R2 — DOCKER-USER source restriction to the dashboard droplet (load-bearing)

A `DOCKER-USER` iptables rule restricts new TCP connections to the published operator port so only the
dashboard VPC IP (`10.116.0.5`) is allowed; all other sources are dropped. This is the actual
authorization boundary (the daemon header guard is not), and it must be in `DOCKER-USER` because Docker
DNAT bypasses UFW. The rule must:

- allow established/related,
- allow `eth1` + source `10.116.0.5` + tcp dport `9300` to the operator target,
- drop tcp dport `9300` to the operator target from all other sources/interfaces,
- be inserted before any terminal/default RETURN, and be re-applied by the deploy (survive Docker
  restart / reboot / firewall reload).

### R3 — DigitalOcean Cloud Firewall rule (provider-level hardening)

A DigitalOcean Cloud Firewall rule allows inbound TCP `9300` to the gateway droplet **only** from the
dashboard droplet (by droplet/tag/private-IP source). This runs before Docker and UFW and survives
Docker restarts, giving a provider-level control layered above the host `DOCKER-USER` rule.

**Owner:** `apps/gateway/src/deploy.ts` reconciles the Cloud Firewall rule **idempotently on every
gateway deploy** (ensure-exists/ensure-matches via doctl / DO API), gated all-or-none with the operator
listener — the same lifecycle as the compose publish (R1) and the DOCKER-USER rule (R2). Reconcile-on-
deploy is self-healing against drift, keeps a single source of truth, and survives droplet rebuilds via
redeploy.

### R4 — Dashboard Caddy `/operator/*` route

`apps/dashboard/config/Caddyfile` gains a `/operator/*` reverse_proxy block targeting the gateway VPC
IP (named config, e.g. `GATEWAY_VPC_IP`; current value `http://10.116.0.3:9300`), with:

- `flush_interval -1` (disable response buffering so future SSE streams are not silently buffered),
- header handling that presents `Host: dashboard.fro.bot` and `X-Forwarded-Proto: https` to the
  upstream so the daemon forwarded-header guard passes,
- mutually-exclusive `handle` blocks so `/operator/*` is ordered correctly relative to the existing
  `reverse_proxy dashboard:3000` catch-all (the repo's established Caddy directive-ordering lesson).

### R5 — Deploy wiring for the dashboard VPC target and gateway publish/firewall

The deploy path materializes the bridge consistently:

- gateway side: the operator publish (R1) + DOCKER-USER rule (R2) + DO firewall rule (R3) are emitted
  by `apps/gateway/src/deploy.ts` only when the operator listener is enabled (all-or-none with the
  existing operator gating), and account for the dashboard VPC IP as the allowed source.
- dashboard side: the Caddy `/operator/*` route (R4) targets the gateway VPC IP.
- both VPC IPs are named configuration values the deploy reads (e.g. `GATEWAY_VPC_IP=10.116.0.3`,
  `DASHBOARD_VPC_IP=10.116.0.5`) — not literals baked into code or the Caddyfile — so a droplet rebuild
  that changes a private IP is handled by updating that config, not editing source. The IPs shown
  throughout this doc are the current example values, not hardcoded constants.

### R6 — Post-deploy verification

After deploy, verify:

- `GET https://dashboard.fro.bot/operator/health` returns `200 {"ok":true}` through the dashboard Caddy
  proxy (the same-origin path is live).
- **Negative-control gate (fail-closed):** an explicit assertion that the operator port is **denied**
  from a non-dashboard source — at both TCP connect and HTTP levels — must pass before the route is
  considered live. If a non-dashboard source can reach the port, the verification fails. This guards
  against a malformed DOCKER-USER rule or firewall drift silently leaving the surface open. Also assert
  the port is **not** reachable from the public internet (`gateway.fro.bot:9300` / public `eth0`).
- `gateway.fro.bot/operator/*` (public gateway Caddy scaffolding) still returns 400 by design.
- The gateway operator listener still has no `0.0.0.0`-published port (`docker compose ps` shows the
  VPC-IP-scoped publish only).

### R7 — Docs

Update `apps/dashboard/AGENTS.md` (operator same-origin section: route now live, the VPC bridge, the
load-bearing source restriction), `apps/gateway/AGENTS.md` (the VPC publish + DOCKER-USER + DO firewall
for the operator port), and flip
`docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` to reflect that the private
path is the existing VPC (correcting the stale "must be built" assumption) and that the route is live.
Add an operator-path verification runbook entry (droplet-local + same-origin probes).

## Non-goals

- **mTLS / shared-secret between dashboard and gateway.** Deferred. Oracle: VPC bind + source
  restriction is sufficient for two trusted same-account droplets; revisit only if other untrusted
  droplets join the VPC, if high-impact mutating operator routes ship before app-level auth, or if
  provider firewall drift becomes a hard requirement.
- **Rebinding the daemon off `gateway-net`.** Not possible (deploy.ts validation) and not desired.
- **The dashboard UI operator client** (the browser-side operator console). Separate `fro-bot/dashboard`
  app work; this brainstorm only makes the API path reachable same-origin.
- **Using `gateway.fro.bot/operator/*` as the browser origin.** Explicitly rejected by the ratified
  same-origin plan.

## Open questions (for planning)

- Exact `DOCKER-USER` rule expression (post-DNAT `-d 172.21.0.2 --dport 9300` vs conntrack
  `--ctorigdst`/`--ctorigdstport`) and how the deploy re-applies it idempotently across Docker
  restarts/reboots.
- How the DO Cloud Firewall references the dashboard source (droplet ID/tag vs private IP) — resolved
  that the gateway *deploy* script owns and reconciles the rule idempotently (see R3).
- How the deploy reads the two VPC IPs (gateway `10.116.0.3`, dashboard `10.116.0.5`) — env/config
  values, with drift handled by updating config.

## Success criteria

- `https://dashboard.fro.bot/operator/health` → 200 through the dashboard Caddy proxy (same-origin path
  live).
- The operator port is reachable ONLY from the dashboard droplet over the VPC — blocked from the public
  internet and from all other sources (verified).
- The daemon stays bound to `172.21.0.2:9300`; no `0.0.0.0` publish.
- `gateway.fro.bot/operator/*` still 400-by-design; ratified same-origin posture intact.
