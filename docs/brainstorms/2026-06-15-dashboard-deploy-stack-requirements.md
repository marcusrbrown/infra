---
title: 'feat: Add fro-bot dashboard deploy stack (apps/dashboard)'
date: 2026-06-15
status: ready-for-planning
scope: standard
---

# feat: Add fro-bot dashboard deploy stack (apps/dashboard)

## Summary

Add `apps/dashboard` to the infra monorepo: a Docker Compose + Caddy deploy stack for the
[fro-bot/dashboard](https://github.com/fro-bot/dashboard) read-only monitoring app at
`dashboard.fro.bot`. The stack mirrors the `apps/umami` pattern — DigitalOcean droplet, Caddy
automatic TLS, gated CI workflow, CLI command group, unified status, MCP read access — with one
deliberate security delta: the GitHub App private key is materialized as a file on the droplet
(never as an env var), and the dashboard container runs hardened (`read_only`, `cap_drop: [ALL]`,
no-new-privileges, non-root user).

---

## Problem Frame

The fro-bot/dashboard app (a Hono-based read-only monitoring dashboard) needs a production home.
It is a GitHub App consumer that reads org/repo metadata and surfaces it as a lightweight status
UI. The app is built and published in the `fro-bot/dashboard` repo; this infra repo owns the
hosting contract: droplet provisioning, Docker Compose stack, Caddy TLS termination, deploy
automation, and the operator runbook.

The dashboard carries a GitHub App private key — a long-lived credential that must never appear
in environment variables (visible in `docker inspect`, process listings, and crash dumps). This
is the key difference from the `apps/umami` pattern, which has no long-lived key material beyond
session secrets. The deploy stack must materialize the private key as a file (0600, file-mounted
into the container) and the container must be hardened to minimize the blast radius if the app
process is compromised.

---

## Actors

- **A1. fro-bot/dashboard app** — Hono server, read-only GitHub App consumer, exposes `/healthz`
  and the monitoring UI. Built and published in a separate repo; consumed here as a Docker image.
- **A2. Caddy** — reverse proxy on `:80`/`:443`; automatic Let's Encrypt TLS; forwards to
  `dashboard:3000` on the internal compose network.
- **A3. Provisioning script** (`apps/dashboard/server/provision-droplet.ts`) — one-time
  DigitalOcean droplet creation + host-key pinning into `.github/known_hosts`.
- **A4. Deploy script** (`apps/dashboard/src/deploy.ts`) — validates env + host, materializes
  `.env` over SSH stdin, uploads compose + Caddyfile + the App private key file, brings up the
  app then Caddy, probes `/healthz`.
- **A5. Operator (Marcus)** — seeds secrets, provisions the droplet, approves gated deploys,
  maintains the runbook.

---

## Key Flows

- **F1. Provision the droplet (one-time)**
  - Trigger: `bun run provision:dashboard`.
  - Steps: `doctl droplet create` → wait for SSH → pin domain + IP host keys into
    `.github/known_hosts` (marker `# dashboard droplet (...)`).
  - Outcome: a reachable DigitalOcean droplet with Docker pre-installed; host keys committed for
    CI strict-host-key-checking.

- **F2. Deploy**
  - Trigger: `bun run --cwd apps/dashboard deploy` or the **Deploy Dashboard** GitHub workflow.
  - Steps: validate env + host → DNS preflight → ControlMaster SSH setup → remote `mkdir -p
    /opt/dashboard/config` → materialize `/opt/dashboard/.env` via SSH stdin (never argv) →
    upload `docker-compose.yaml` + `config/Caddyfile` → upload the GitHub App private key to
    `/opt/dashboard/config/github-app.pem` (0600, via SSH stdin) → `docker compose pull` →
    `docker compose up -d --wait dashboard` → `docker compose up -d --wait caddy` → probe
    `https://$DASHBOARD_DOMAIN/healthz`.
  - Outcome: the dashboard is live at `dashboard.fro.bot` with valid TLS; the App private key is
    file-mounted into the read-only container.

- **F3. Observe + manage (parity)**
  - Trigger: `infra dashboard status` / `infra dashboard logs`, or `infra status`.
  - Steps: `status` reports `docker compose ps` over SSH; `logs` streams container logs; unified
    `status` includes a `dashboard` row; MCP exposes `dashboard status` read-only.
  - Outcome: the dashboard has the same observability as every other infra app.

---

## Requirements

**Compose stack**

- R1. `apps/dashboard/docker-compose.yaml` defines two services: `caddy` (`:80`/`:443`, Caddy
  image digest-pinned, mounts `./config/Caddyfile`, `caddy_data`/`caddy_config` volumes) and
  `dashboard` (fro-bot/dashboard image digest-pinned, `env_file: .env` optional, `depends_on:
  caddy` is NOT the pattern — caddy depends_on dashboard; dashboard comes up first). Caddy
  depends on the dashboard service.
- R2. The `dashboard` service is hardened beyond the umami baseline: `read_only: true`,
  `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, non-root user. This is a
  deliberate delta from `apps/umami` (which has none of these), justified by the presence of the
  GitHub App private key. The hardening is documented as intentional in the compose file and
  AGENTS.md.
- R3. The GitHub App private key is mounted as a file into the container
  (`/run/secrets/github-app.pem` or equivalent read-only bind mount), never as an environment
  variable. The deploy script uploads it to `/opt/dashboard/config/github-app.pem` (0600) on the
  droplet via SSH stdin; the compose bind-mounts that path into the container read-only.
- R4. `apps/dashboard/config/Caddyfile` configures `{$DASHBOARD_DOMAIN} { reverse_proxy
  dashboard:3000 }` — automatic Let's Encrypt TLS, no manual cert management.
- R5. A `docker-compose.test.ts` validates the compose file (mirrors `apps/umami/docker-compose.test.ts`).

**Deploy script**

- R6. `apps/dashboard/src/deploy.ts` validates env (`DASHBOARD_DOMAIN`, `DASHBOARD_SSH_KEY` in
  CI, GitHub App secrets) and the host string before any SSH argv is built. Host validation uses
  `validateDashboardHost` (same `VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i` as umami/gateway).
- R7. The deploy materializes `/opt/dashboard/.env` via SSH stdin (never argv). Secret values are
  boundary-validated (no newlines/shell metacharacters).
- R8. The GitHub App private key (`DASHBOARD_GITHUB_APP_KEY`) is uploaded to
  `/opt/dashboard/config/github-app.pem` (0600) via SSH stdin — never written to a temp file on
  the CI runner, never passed as argv, never logged. This is the security-critical delta from
  umami's secret handling.
- R9. Deploy ordering: `docker compose up -d --wait dashboard` first (app health gate), then
  `docker compose up -d --wait caddy` (public exposure only after the app is healthy).
- R10. Post-deploy probe: `https://$DASHBOARD_DOMAIN/healthz` (the dashboard's health endpoint —
  NOT `/api/heartbeat` which is umami-specific). Bounded retry with ACME-lag tolerance on first
  deploy.
- R11. ControlMaster SSH multiplexing (shared socket) for all SSH steps in the deploy.

**Host validation**

- R12. `apps/dashboard/src/host.ts` exports `validateDashboardHost(host: string): string` with
  `VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i`. Rejects empty strings and `-`-prefixed values
  (SSH argv injection defense). Colocated `host.test.ts`.

**Provisioning**

- R13. `apps/dashboard/server/provision-droplet.ts` creates a DigitalOcean droplet via `doctl`
  (mirroring `apps/umami/server/provision-droplet.ts`): `s-1vcpu-1gb` size, `docker-20-04`
  image, SSH key by name (`DASHBOARD_SSH_KEY_NAME`, default `fro-bot-dashboard`), waits for SSH,
  pins domain + IP host keys into `.github/known_hosts` with marker `# dashboard droplet (...)`.
  Idempotent. Colocated `provision-droplet.test.ts`.

**GitHub Environment + secrets**

- R14. GitHub Environment: `dashboard`. Required secrets:
  - `DASHBOARD_SSH_KEY` — Ed25519 private key for the droplet
  - `DASHBOARD_DOMAIN` — FQDN (`dashboard.fro.bot`)
  - `DASHBOARD_GITHUB_APP_ID` — GitHub App ID
  - `DASHBOARD_GITHUB_APP_KEY` — GitHub App private key (PEM; file-mounted, never env)
  - `DASHBOARD_OAUTH_CLIENT_ID` — OAuth client ID
  - `DASHBOARD_OAUTH_CLIENT_SECRET` — OAuth client secret
  - `DASHBOARD_OPERATOR_LOGIN` — operator GitHub login (for access control)
  - `DASHBOARD_COOKIE_KEY` — session cookie signing key
  - Repo secret `DIGITALOCEAN_ACCESS_TOKEN` already exists (shared with other apps).

**Deploy workflow**

- R15. `.github/workflows/deploy-dashboard.yaml` mirrors `deploy-umami.yaml`: triggers on
  `workflow_dispatch` + `workflow_call`; all secrets listed in R14 declared `required: true`;
  `environment: dashboard`; steps: checkout, setup-bun, `bun install --frozen-lockfile
  --ignore-scripts`, validate secrets, configure known_hosts from `.github/known_hosts`, `bun run
  --cwd apps/dashboard deploy`.
- R16. `.github/workflows/deploy.yaml` gains:
  - A `dashboard` output in `detect-changes` using `dorny/paths-filter` matching
    `apps/dashboard/**` (with doc/test negations, `predicate-quantifier: every`).
  - A `deploy-dashboard` job (`needs: detect-changes`, `if: dispatch || dashboard==true`, `uses:
    ./.github/workflows/deploy-dashboard.yaml`, passes all R14 secrets).

**CLI command group**

- R17. `packages/cli/src/commands/dashboard/` command group: `index.ts` (exports
  `registerDashboardCommands(cli)`), `deploy.ts`, `status.ts`, `logs.ts`. Mirrors
  `packages/cli/src/commands/umami/`.
- R18. `packages/cli/src/cli.ts` imports and calls `registerDashboardCommands(cli)`.
- R19. `dashboard status` is MCP-exposed (read-only, added to `MCP_ALLOWLIST`). `dashboard
  deploy` and `dashboard logs` are CLI-only.
- R20. `dashboard status` integrates into the unified `status` dashboard
  (`packages/cli/src/commands/status.ts`) via a `getDashboardStatusSummary()` aggregator.

**Package + workspace**

- R21. `apps/dashboard/package.json`: name `@marcusrbrown/infra-dashboard`, private, scripts
  `deploy` / `provision` / `test` (bun). Depends on `@marcusrbrown/infra-shared`.
- R22. Root `package.json` gains `deploy:dashboard` and `provision:dashboard` wrapper scripts.
- R23. `bun install` is run and `bun.lock` is updated after adding the new workspace member.

**Docs**

- R24. `apps/dashboard/README.md` — deploy badge, stack summary, deploy/provision commands,
  configuration table, operations pointer to AGENTS.md, CLI commands.
- R25. `apps/dashboard/AGENTS.md` — full operator runbook: deploy flow, secret handling (esp.
  the file-mounted App key), container hardening rationale, provisioning, secret rotation,
  upgrade flow, anti-patterns.

---

## Scope Boundaries / Non-Goals

- **NG1. Not building the dashboard app.** The fro-bot/dashboard Hono app is built and published
  in its own repo. This infra stack consumes a published Docker image; it does not build, test,
  or own the app code.
- **NG2. No database.** The dashboard is read-only and stateless (no Postgres, no volumes beyond
  Caddy TLS data).
- **NG3. No multi-tenancy.** Single-operator, single-droplet, single domain.
- **NG4. No image build in CI.** The deploy pulls a pre-built, digest-pinned image from the
  registry. Image builds are the fro-bot/dashboard repo's responsibility.
- **NG5. No automated secret rotation.** Secret rotation is a documented manual runbook step.
- **NG6. No write-path or admin API.** The dashboard is read-only; no write endpoints, no admin
  password rotation step (unlike umami).

---

## Success Criteria

- SC1. `bun run provision:dashboard` creates a DigitalOcean droplet, waits for SSH, and pins
  host keys into `.github/known_hosts` — reproducibly and idempotently.
- SC2. `bun run --cwd apps/dashboard deploy` (or the **Deploy Dashboard** workflow) brings up
  the dashboard at `dashboard.fro.bot` with valid TLS; `/healthz` returns healthy.
- SC3. The GitHub App private key is never present in environment variables, process listings,
  SSH argv, or CI logs — only as a 0600 file on the droplet, bind-mounted read-only into the
  container.
- SC4. The dashboard container runs `read_only`, `cap_drop: [ALL]`, no-new-privileges, non-root.
- SC5. `infra dashboard status`, `infra dashboard logs`, `infra status`, and the `dashboard
  status` MCP tool all work with the same fidelity as the other apps.
- SC6. The app passes `conventions.test.ts`, `tsc`, lint, and the full test suite.
- SC7. `deploy-dashboard.yaml` and the `deploy.yaml` router are wired and the workflow triggers
  correctly on `apps/dashboard/**` path changes.

---

## Open Questions (for planning)

- OQ1. **Droplet size/region** — mirror umami defaults (`s-1vcpu-1gb`, `docker-20-04`, same
  region as umami)? The dashboard is stateless and low-traffic; `s-1vcpu-1gb` is almost
  certainly sufficient. Confirm at provisioning time.
- OQ2. **Compose validation test scope** — the `docker-compose.test.ts` should at minimum assert
  the pinned Caddy image digest (mirroring umami). Should it also assert the dashboard image
  digest and the presence of the `read_only`/`cap_drop` hardening fields? Yes — the hardening
  fields are security-critical and worth asserting in the test.
- OQ3. **File-mount path for the App key** — `/run/secrets/github-app.pem` (Docker secrets
  convention) vs `/etc/dashboard/github-app.pem` (explicit config path). Either works; the plan
  should pick one and document it consistently across compose, deploy, and AGENTS.md.
- OQ4. **Health probe retry budget** — how many retries / what timeout for the `/healthz` probe
  on first deploy (ACME cert issuance lag)? Mirror umami's bounded-retry + WARNING-on-lag
  pattern; the exact numbers are decided during deploy implementation.
- OQ5. **Image registry** — where is the fro-bot/dashboard Docker image published (GHCR, Docker
  Hub)? The compose file needs the correct registry path. Confirm with the fro-bot/dashboard
  repo's publish workflow before writing the compose file.
