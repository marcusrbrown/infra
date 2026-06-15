---
title: dashboard deploy stack (apps/dashboard)
date: 2026-06-15
status: ready-for-planning
scope: standard
---

# dashboard deploy stack (apps/dashboard)

## Problem

The [fro-bot/dashboard](https://github.com/fro-bot/dashboard) app — a Hono-based, read-only
monitoring dashboard for Fro Bot's footprint — needs a production home. The app is built and
published in its own repo; this infra repo owns the hosting contract: droplet provisioning,
Docker Compose stack, Caddy TLS termination, deploy automation, observability, and the operator
runbook.

The dashboard differs from existing infra apps in one security-critical way: it carries a
**GitHub App private key** — a long-lived credential that must never appear in environment
variables (visible via `docker inspect`, process listings, crash dumps) or CI logs. This is the
key difference from `apps/umami`, whose only secrets are session/DB credentials. The deploy stack
must materialize the private key as a file (0600, bind-mounted read-only), and the container must
be hardened to minimize blast radius if the app process is compromised.

## Goal

Add `apps/dashboard` to the infra monorepo as a Docker Compose + Caddy deploy stack at
`dashboard.fro.bot`, mirroring the proven `apps/umami` pattern (DigitalOcean droplet, automatic
TLS, gated CI workflow, `goke` CLI command group, unified status, MCP read access) — with one
deliberate hardening delta for the App private key: file-mounted secret + `read_only` /
`cap_drop` / no-new-privileges / non-root container.

## Deploy & Hosting Behavior

- **Provision (one-time):** `bun run provision:dashboard` creates a DigitalOcean droplet via
  `doctl`, waits for SSH, and pins the domain + IP host keys into `.github/known_hosts` (marker
  `# dashboard droplet (...)`). Idempotent, mirroring `apps/umami/server/provision-droplet.ts`.
- **Deploy:** `bun run --cwd apps/dashboard deploy` (or the **Deploy Dashboard** workflow)
  validates env + host, materializes `/opt/dashboard/.env` over SSH stdin, uploads the compose
  file + Caddyfile + the App private key file, brings up the app first (health-gated) then Caddy
  (public exposure only after the app is healthy), and probes `https://$DASHBOARD_DOMAIN/healthz`.
- **Observe:** `infra dashboard status` / `logs`, a `dashboard` row in unified `infra status`, and
  an MCP-exposed read-only `dashboard status` — the same observability as every other infra app.

## Container & Secret Hardening (the delta from umami)

- The dashboard container runs **hardened beyond the umami baseline**: `read_only: true`,
  `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, non-root user — justified by the
  presence of the GitHub App private key. The hardening is documented as intentional.
- The GitHub App private key is **file-mounted, never an env var**: uploaded to a 0600 file on the
  droplet via SSH stdin (never argv, never a CI temp file, never logged) and bind-mounted
  read-only into the container.
- Host strings are validated with the same `VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i` SSH-argv
  injection defense used by `apps/umami` and the gateway.

## Parity with the umami pattern

The stack reuses umami's contract wholesale except where the App key forces a delta: a two-service
compose (Caddy + app), Caddy automatic Let's Encrypt TLS reverse-proxying `dashboard:3000`, a
`docker-compose.test.ts` validation test, SSH-stdin secret materialization, a `goke` CLI group
(`deploy`/`status`/`logs`) registered in `packages/cli/src/cli.ts`, a `deploy-dashboard.yaml`
workflow gated by the `deploy.yaml` umbrella router on `apps/dashboard/**`, and a `dashboard`
GitHub Environment for secrets.

## Non-Goals

- **Not building the dashboard app.** The Hono app is built, tested, and published (as a
  digest-pinned Docker image) in `fro-bot/dashboard`. This stack consumes the image; it does not
  own the app code or build it in CI.
- **No database / stateful storage** beyond Caddy's TLS data — the dashboard is read-only and
  stateless.
- **No multi-tenancy** — single-operator, single-droplet, single domain.
- **No automated secret rotation** — rotation is a documented manual runbook step.
- **No write-path or admin API** — read-only; no admin-password-rotation step (unlike umami).

## Success Criteria

- `bun run provision:dashboard` reproducibly and idempotently creates the droplet and pins host
  keys.
- `bun run --cwd apps/dashboard deploy` (or the workflow) brings the dashboard up at
  `dashboard.fro.bot` with valid TLS and a healthy `/healthz`.
- The GitHub App private key never appears in env vars, process listings, SSH argv, or CI logs —
  only as a 0600 file bind-mounted read-only into the container.
- The dashboard container runs `read_only`, `cap_drop: [ALL]`, no-new-privileges, non-root.
- `infra dashboard status` / `logs`, unified `infra status`, and the `dashboard status` MCP tool
  all work with the same fidelity as other apps.
- `deploy-dashboard.yaml` + the `deploy.yaml` router are wired and trigger correctly on
  `apps/dashboard/**` changes; the app passes the repo's standard gates (`bun check-types`, lint,
  `bun test`).

## Open Questions

- **Droplet size/region** — mirror umami defaults (`s-1vcpu-1gb`, `docker-20-04`, same region)?
  The dashboard is stateless and low-traffic, so the small size is almost certainly sufficient;
  confirm at provisioning time.
- **App-key mount path** — `/run/secrets/github-app.pem` (Docker-secrets convention) vs
  `/etc/dashboard/github-app.pem` (explicit config path). Pick one and use it consistently across
  compose, deploy, and the runbook.
- **Image registry** — where does `fro-bot/dashboard` publish its image (GHCR vs Docker Hub)? The
  compose file needs the correct digest-pinned registry path; confirm against that repo's publish
  workflow before writing the compose.
- **Health-probe retry budget** — retries/timeout for the first-deploy `/healthz` probe given ACME
  cert-issuance lag; mirror umami's bounded-retry + warning-on-lag pattern, exact numbers decided
  during implementation.

## Next step

Run `ce:plan` against this requirements doc to produce the implementation plan
(`docs/plans/2026-06-15-001-feat-dashboard-deploy-stack-plan.md`). The fro-bot/dashboard app's own
plan (`fro-bot/.github` `docs/plans/2026-06-15-001-feat-monitoring-dashboard-phase-1-plan.md`,
the deploy units) is the upstream context.
