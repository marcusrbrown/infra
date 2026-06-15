---
title: 'feat: Add fro-bot dashboard deploy stack (apps/dashboard)'
type: feat
status: active
date: 2026-06-15
origin: docs/brainstorms/2026-06-15-dashboard-deploy-stack-requirements.md
---

# feat: Add fro-bot dashboard deploy stack (apps/dashboard)

## Overview

Add `apps/dashboard` to the infra monorepo: a Docker Compose + Caddy deploy stack for the
fro-bot/dashboard read-only monitoring app at `dashboard.fro.bot`. The stack mirrors
`apps/umami` — DigitalOcean droplet, Caddy automatic TLS, gated CI workflow, CLI command group,
unified status, MCP read access — with one deliberate security delta: the GitHub App private key
is materialized as a file on the droplet (never as an env var), and the dashboard container runs
hardened (`read_only`, `cap_drop: [ALL]`, no-new-privileges, non-root user).

This plan covers the infra-repo side of the dashboard deployment. The fro-bot/dashboard app
itself (Hono server, GitHub App integration, OAuth, monitoring UI) is built and published in the
`fro-bot/dashboard` repo; this plan consumes a published Docker image and owns the hosting
contract only.

## Problem Frame

The fro-bot/dashboard app needs a production home. Infra owns hosting: droplet provisioning,
Docker Compose stack, Caddy TLS termination, deploy automation, and the operator runbook. The
dashboard carries a GitHub App private key — a long-lived credential that must never appear in
environment variables. This is the key difference from `apps/umami` and drives the container
hardening requirements. (See origin: docs/brainstorms/2026-06-15-dashboard-deploy-stack-requirements.md)

## Requirements Trace

- R1–R5: Compose stack (two services: `dashboard` + `caddy`; hardening; file-mounted App key;
  Caddyfile; compose validation test).
- R6–R11: Deploy script (env + host validation; `.env` via SSH stdin; App key via SSH stdin as
  file; deploy ordering app-then-caddy; `/healthz` probe; ControlMaster).
- R12: Host validation (`validateDashboardHost`, `VALID_HOST_RE`).
- R13: Provisioning script (doctl, host-key pinning, `# dashboard droplet (...)` marker).
- R14: GitHub Environment `dashboard` + secret names.
- R15–R16: Deploy workflow (`deploy-dashboard.yaml`) + umbrella router (`deploy.yaml`).
- R17–R20: CLI command group (`dashboard/`) + `cli.ts` registration + MCP + unified status.
- R21–R23: Package + workspace + lockfile.
- R24–R25: README + AGENTS.md runbook.

## Scope Boundaries

- Not building the fro-bot/dashboard app — consumes a published Docker image only.
- No database (dashboard is stateless).
- No multi-tenancy, no image build in CI, no automated secret rotation, no write-path.

### Deferred to Separate Tasks

- Renovate tracking for the dashboard image (add after the first deploy confirms the image
  registry path and tag convention).
- Any future `dashboard backup` or data-export tooling (N/A for a stateless app).

## Context & Research

### Relevant Code and Patterns

- **`apps/umami/`** — primary pattern to mirror: `docker-compose.yaml`, `config/Caddyfile`,
  `docker-compose.test.ts`, `src/deploy.ts`, `src/host.ts`, `server/provision-droplet.ts`,
  `package.json`, `README.md`, `AGENTS.md`. The dashboard stack replicates this structure with
  the hardening delta.
- **`apps/umami/src/host.ts`** — `VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i`,
  `validateUmamiHost` — mirror exactly as `validateDashboardHost`.
- **`apps/umami/docker-compose.yaml`** — two-service pattern (app + caddy); `env_file: .env
  required: false`; `caddy_data`/`caddy_config` volumes; `./config/Caddyfile` bind mount. The
  dashboard compose extends this with `read_only`, `cap_drop`, `security_opt`, non-root user,
  and a bind mount for the App key file.
- **`apps/umami/config/Caddyfile`** — `{$UMAMI_DOMAIN} { reverse_proxy umami:3000 }` → mirror
  as `{$DASHBOARD_DOMAIN} { reverse_proxy dashboard:3000 }`.
- **`apps/umami/docker-compose.test.ts`** — single-file Bun test asserting the pinned Caddy
  image digest. Mirror and extend to assert hardening fields.
- **`apps/umami/src/deploy.ts`** — SSH-stdin secret materialization, ControlMaster, DNS
  preflight, deploy ordering (app then caddy), bounded HTTPS probe. The dashboard deploy mirrors
  this shape and adds the App key file upload step.
- **`apps/umami/server/provision-droplet.ts`** — `doctl droplet create`, SSH wait, host-key
  pinning. Mirror with `# dashboard droplet (...)` marker.
- **`.github/workflows/deploy-umami.yaml`** — gated workflow shape to mirror.
- **`.github/workflows/deploy.yaml`** — router: `detect-changes` + per-app job pattern.
- **`packages/cli/src/commands/umami/`** — CLI command group to mirror for `dashboard/`.
- **`packages/cli/src/commands/mcp.ts`** — `MCP_ALLOWLIST` + `ctx`-threading.
- **`packages/cli/src/commands/status.ts`** — unified dashboard aggregator pattern.

### Institutional Learnings

- **`docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`** — GitHub
  Environment auto-creates ungated on first workflow reference; pre-create with reviewer + branch
  policy before merge. SSH key trailing-`\n` handling. `IdentitiesOnly=yes` for file-backed keys.
- **`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`** — ControlMaster
  for SSH rate-limits; `materializeIdentityFile` trailing-newline handling; test fixtures must
  mirror real tool output.
- **`docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`** — pin
  unhashed domain entries for CI; one canonical host env name; `bun.lock` must be regenerated
  for the new workspace member.
- **`docs/solutions/workflow-issues/bun-deploy-user-permissions-ci-2026-04-02.md`** — CI uses
  `bun install --frozen-lockfile --ignore-scripts`; run `bun install` + commit `bun.lock` after
  adding `apps/dashboard/package.json`.

## Key Technical Decisions

- **File-mounted App key (not env var):** The GitHub App private key is the security-critical
  delta from umami. It must never appear in `docker inspect` output, process listings, or crash
  dumps. The deploy uploads it to `/opt/dashboard/config/github-app.pem` (0600) via SSH stdin
  and the compose bind-mounts it read-only into the container. This is a deliberate, documented
  departure from umami's env-var-only secret handling.
- **Container hardening (`read_only`, `cap_drop: [ALL]`, no-new-privileges, non-root):** The
  presence of a long-lived private key in the container justifies hardening beyond the umami
  baseline. These flags minimize blast radius if the Hono process is compromised. Documented as
  intentional in the compose file and AGENTS.md.
- **Deploy ordering (app-then-caddy):** Mirror umami — bring up `dashboard` first (health gate),
  then `caddy` (public exposure). This prevents a public TLS endpoint from existing before the
  app is healthy.
- **`/healthz` probe (not `/api/heartbeat`):** The dashboard's health endpoint is `/healthz`.
  The umami-specific `/api/heartbeat` must not be used here. This is a named constant in
  `deploy.ts`.
- **DigitalOcean droplet (not AWS):** The dashboard is stateless and low-traffic; the existing
  DO provisioning pattern (`doctl`, `droplet-helpers.ts`) is the right fit. No new cloud
  provider.
- **No DB volume guard:** Umami has a DB-password fingerprint guard to prevent volume-bricking
  password changes. The dashboard has no database, so this guard is not needed.

## Open Questions

### Resolved During Planning

- Droplet size: `s-1vcpu-1gb` (mirror umami defaults) — sufficient for a stateless read-only
  dashboard.
- Compose validation test scope: assert pinned Caddy image digest + presence of `read_only` and
  `cap_drop` hardening fields (security-critical, worth asserting).
- File-mount path for the App key: `/opt/dashboard/config/github-app.pem` on the droplet,
  bind-mounted read-only into the container at `/run/secrets/github-app.pem` (Docker secrets
  convention path).

### Deferred to Implementation

- OQ4. Health probe retry budget — exact retry count + timeout for `/healthz` on first deploy
  (ACME lag). Mirror umami's bounded-retry + WARNING-on-lag pattern; exact numbers decided during
  `deploy.ts` implementation.
- OQ5. Image registry path — where is the fro-bot/dashboard image published (GHCR vs Docker
  Hub)? Confirm with the fro-bot/dashboard repo before writing the compose file. The compose
  image field is a placeholder until confirmed.

## Output Structure

```
apps/dashboard/
├── package.json
├── AGENTS.md
├── README.md
├── config/
│   └── Caddyfile
├── docker-compose.yaml
├── docker-compose.test.ts
├── server/
│   ├── provision-droplet.ts
│   └── provision-droplet.test.ts
└── src/
    ├── deploy.ts
    ├── deploy.test.ts
    ├── host.ts
    └── host.test.ts

packages/cli/src/commands/dashboard/
├── index.ts          # registerDashboardCommands barrel
├── deploy.ts
├── deploy.test.ts
├── status.ts
├── status.test.ts
├── logs.ts
└── logs.test.ts

.github/workflows/
├── deploy-dashboard.yaml   # new gated workflow
└── deploy.yaml             # modified: add dashboard filter + job
```

## High-Level Technical Design

> *Directional guidance for the implementing agent — not final code.*

**Compose stack (hardening delta from umami):**

```yaml
# apps/dashboard/docker-compose.yaml (directional)
services:
  caddy:
    image: caddy:<version>@sha256:<digest>
    restart: unless-stopped
    ports: ['80:80', '443:443']
    env_file: [{path: .env, required: false}]
    volumes:
      - caddy_data:/data
      - caddy_config:/config
      - ./config/Caddyfile:/etc/caddy/Caddyfile
    depends_on: [dashboard]

  dashboard:
    image: <registry>/fro-bot/dashboard:<version>@sha256:<digest>
    restart: unless-stopped
    env_file: [{path: .env, required: false}]
    # Security hardening — deliberate delta from apps/umami:
    # The GitHub App private key is file-mounted (not env); these flags
    # minimize blast radius if the app process is compromised.
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    user: '<non-root-uid>:<gid>'
    volumes:
      # host path (uploaded by deploy.ts, 0600) : container path : read-only
      - /opt/dashboard/config/github-app.pem:/run/secrets/github-app.pem:ro
    healthcheck:
      test: [CMD-SHELL, 'curl -f http://localhost:3000/healthz || exit 1']
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

volumes:
  caddy_data:
  caddy_config:
```

**Deploy flow (key steps):**

```text
deploy.ts
  validateEnv (DASHBOARD_DOMAIN, DASHBOARD_SSH_KEY in CI, App secrets)
  validateDashboardHost(host)                    # before any SSH argv
  materializeIdentityFile(DASHBOARD_SSH_KEY)     # CI: temp file, 0600
  DNS preflight: resolve DASHBOARD_DOMAIN
  ControlMaster SSH setup (shared socket)
  ssh: mkdir -p /opt/dashboard/config
  materialize /opt/dashboard/.env via SSH stdin  # never argv
  upload docker-compose.yaml + config/Caddyfile
  upload DASHBOARD_GITHUB_APP_KEY to /opt/dashboard/config/github-app.pem (0600) via SSH stdin
    # SECURITY: never written to a temp file on the CI runner
    # never passed as argv, never logged
  docker compose pull
  docker compose up -d --wait dashboard          # app health gate first
  docker compose up -d --wait caddy             # public exposure only after app is healthy
  probe https://$DASHBOARD_DOMAIN/healthz        # bounded retry; ACME-lag tolerant
```

**Provisioning flow:**

```text
provision-droplet.ts
  doctl droplet create fro-bot-dashboard \
    --size s-1vcpu-1gb --image docker-20-04 \
    --ssh-keys <DASHBOARD_SSH_KEY_NAME>
  waitForSsh(host)
  pinHostKeys(domain, ip, '.github/known_hosts', '# dashboard droplet (...)')
  print droplet IP → operator seeds DASHBOARD_DOMAIN into .env + dashboard Environment
```

## Implementation Units

- [ ] **Unit 1: apps/dashboard Compose stack + Caddy + hardening + compose test**

**Goal:** Create the `apps/dashboard` workspace with `docker-compose.yaml`, `config/Caddyfile`,
`docker-compose.test.ts`, and `package.json`. Establish the container hardening delta from umami
as a documented, tested baseline.

**Requirements:** R1, R2, R3, R4, R5, R21, R22

**Dependencies:** None

**Files:**
- Create: `apps/dashboard/package.json`
- Create: `apps/dashboard/docker-compose.yaml`
- Create: `apps/dashboard/config/Caddyfile`
- Create: `apps/dashboard/docker-compose.test.ts`
- Modify: root `package.json` (add `deploy:dashboard`, `provision:dashboard` scripts)

**Approach:**
- Mirror `apps/umami/package.json` name pattern: `@marcusrbrown/infra-dashboard`, private,
  scripts `deploy`/`provision`/`test`.
- `docker-compose.yaml`: two services (`dashboard` + `caddy`). The `dashboard` service adds
  `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, non-root
  `user`, and a bind mount for the App key file. Comment the hardening block as a deliberate
  delta from `apps/umami`. Caddy service mirrors umami exactly.
- `config/Caddyfile`: `{$DASHBOARD_DOMAIN} { reverse_proxy dashboard:3000 }`.
- `docker-compose.test.ts`: assert pinned Caddy image digest (mirror umami test) + assert
  `read_only: true` and `cap_drop` present in the compose text (security-critical fields).
- Run `bun install` to update `bun.lock` (CI `--frozen-lockfile` requires it).

**Patterns to follow:** `apps/umami/docker-compose.yaml`, `apps/umami/config/Caddyfile`,
`apps/umami/docker-compose.test.ts`, `apps/umami/package.json`.

**Security note:** The `read_only`/`cap_drop`/`no-new-privileges`/non-root block is the
security-critical delta from umami. It must be present in the compose file and asserted in the
test before any other unit proceeds.

**Test scenarios:**
- Compose test asserts the pinned Caddy image digest.
- Compose test asserts `read_only: true` is present in the compose text.
- Compose test asserts `cap_drop` contains `ALL`.
- Compose test asserts the App key bind mount path is present.

**Verification:** `bun test` green in `apps/dashboard/`; `bun install` clean; `apps/dashboard`
resolves as a workspace member.

---

- [ ] **Unit 2: src/deploy.ts + src/host.ts + tests (SSH secret materialization, App key file, deploy ordering, /healthz probe)**

**Goal:** `deploy.ts` — validate env + host, materialize `.env` via SSH stdin, upload compose +
Caddyfile, upload the GitHub App private key as a file (0600) via SSH stdin, bring up app then
Caddy, probe `/healthz`. `host.ts` — `validateDashboardHost` with SSH argv injection defense.

**Requirements:** R6, R7, R8, R9, R10, R11, R12

**Dependencies:** Unit 1

**Files:**
- Create: `apps/dashboard/src/deploy.ts`
- Create: `apps/dashboard/src/deploy.test.ts`
- Create: `apps/dashboard/src/host.ts`
- Create: `apps/dashboard/src/host.test.ts`

**Approach:**
- `host.ts`: `VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i`, `validateDashboardHost(host: string):
  string`. Mirror `apps/umami/src/host.ts` exactly (rename function + error message prefix).
- `deploy.ts`:
  - `validateEnv`: require `DASHBOARD_DOMAIN`, `DASHBOARD_GITHUB_APP_ID`,
    `DASHBOARD_GITHUB_APP_KEY`, `DASHBOARD_OAUTH_CLIENT_ID`, `DASHBOARD_OAUTH_CLIENT_SECRET`,
    `DASHBOARD_OPERATOR_LOGIN`, `DASHBOARD_COOKIE_KEY`, SSH context.
  - `validateDashboardHost(host)` before any SSH argv.
  - `materializeIdentityFile(DASHBOARD_SSH_KEY)` in CI (shared helper).
  - DNS preflight: resolve `DASHBOARD_DOMAIN`.
  - ControlMaster SSH setup.
  - `ssh: mkdir -p /opt/dashboard/config`.
  - Materialize `/opt/dashboard/.env` via SSH stdin (boundary-validate secret values).
  - Upload `docker-compose.yaml` + `config/Caddyfile`.
  - **Upload App key:** pipe `DASHBOARD_GITHUB_APP_KEY` via SSH stdin to
    `/opt/dashboard/config/github-app.pem`; set `chmod 0600`. Never write to a temp file on the
    runner, never pass as argv, never log. This is the security-critical step.
  - `docker compose pull`.
  - `docker compose up -d --wait dashboard` (app health gate).
  - `docker compose up -d --wait caddy` (public exposure after app is healthy).
  - Probe `https://$DASHBOARD_DOMAIN/healthz` — bounded retry; emit WARNING on ACME lag (first
    deploy); still succeeds if containers are healthy (idempotent re-run once cert lands).
- Injectable `SpawnFn` for testability (gateway/umami pattern).

**Patterns to follow:** `apps/umami/src/deploy.ts` (SSH-stdin materialization, ControlMaster,
DNS preflight, deploy ordering, bounded HTTPS probe), `apps/umami/src/host.ts` (host validator).

**Security note:** The App key upload step (R8) is the security-critical delta. Tests must assert
the key bytes go via SSH stdin, never appear in spawn argv, and are never written to a local temp
file. The health probe endpoint is `/healthz` (not `/api/heartbeat`).

**Test scenarios:**
- `host.ts`: valid hostname/FQDN/IP passes; empty string throws; `-`-prefixed value throws;
  value with shell metacharacters throws.
- `deploy.ts` happy path: validates env + host, materializes `.env` via stdin, uploads compose +
  Caddyfile, uploads App key via stdin (not argv), brings up `dashboard` then `caddy` in order,
  probes `/healthz`.
- `deploy.ts` edge: missing `DASHBOARD_DOMAIN` → throws before any SSH call.
- `deploy.ts` edge: `validateDashboardHost` rejects `-oProxyCommand=...` style host → throws
  before SSH argv built.
- `deploy.ts` security: App key bytes appear in SSH stdin, not in spawn argv (assert spawn args
  contain no PEM content).
- `deploy.ts` edge: `/healthz` returns non-200 after retries → deploy fails with clear error.

**Verification:** `bun test` green; App key never in argv; health probe endpoint is `/healthz`.

---

- [ ] **Unit 3: server/provision-droplet.ts + test (droplet + host-key pinning)**

**Goal:** `provision-droplet.ts` — `doctl droplet create`, wait for SSH, pin domain + IP host
keys into `.github/known_hosts` with marker `# dashboard droplet (...)`. Idempotent.

**Requirements:** R13

**Dependencies:** Unit 1

**Files:**
- Create: `apps/dashboard/server/provision-droplet.ts`
- Create: `apps/dashboard/server/provision-droplet.test.ts`

**Approach:**
- Mirror `apps/umami/server/provision-droplet.ts` exactly: `doctl droplet create fro-bot-dashboard
  --size s-1vcpu-1gb --image docker-20-04 --ssh-keys <DASHBOARD_SSH_KEY_NAME>`, idempotency
  guard, `waitForSsh`, `pinHostKeys` with marker `# dashboard droplet (...)`.
- `DASHBOARD_SSH_KEY_NAME` env var, default `fro-bot-dashboard`.
- `if (import.meta.main)` guard so tests never make live doctl calls.
- SSH key materialization: when `DASHBOARD_SSH_KEY` is set, materialize to a 0600 temp file with
  `-i` + `IdentitiesOnly=yes`; otherwise fall back to ssh-agent.

**Patterns to follow:** `apps/umami/server/provision-droplet.ts`.

**Test scenarios:**
- Happy path: constructs correct `doctl droplet create` command with expected flags.
- Edge: droplet already exists → aborts without re-creating (idempotency guard).
- Happy path: `pinHostKeys` called with `# dashboard droplet (...)` marker.
- Edge: host-key pinning fails → provisioning fails closed.

**Verification:** `bun test` green; no live doctl calls during `bun test`.

---

- [ ] **Unit 4: deploy-dashboard.yaml + umbrella deploy.yaml routing**

**Goal:** `deploy-dashboard.yaml` gated workflow + wire into `deploy.yaml` router with
`dorny/paths-filter` and `predicate-quantifier: every`.

**Requirements:** R15, R16

**Dependencies:** Units 2, 3

**Files:**
- Create: `.github/workflows/deploy-dashboard.yaml`
- Modify: `.github/workflows/deploy.yaml`

**Approach:**
- `deploy-dashboard.yaml`: mirror `deploy-umami.yaml` exactly. Triggers: `workflow_dispatch` +
  `workflow_call`. Secrets: all R14 secrets declared `required: true`. `environment: dashboard`.
  Steps: checkout (SHA-pinned), setup-bun (SHA-pinned), `bun install --frozen-lockfile
  --ignore-scripts`, validate secrets (bash array check), configure known_hosts from
  `.github/known_hosts`, `bun run --cwd apps/dashboard deploy` with all secrets in env.
- `deploy.yaml` changes:
  - Add `dashboard: ${{ steps.filter.outputs.dashboard }}` to `detect-changes` outputs.
  - Add `dashboard` filter in `dorny/paths-filter`: `apps/dashboard/**` with negations for
    `*.md`, `*.test.ts`, `__fixtures__/**`, `__snapshots__/**`; `predicate-quantifier: every`.
  - Add `deploy-dashboard` job: `needs: detect-changes`, `if: github.event_name ==
    'workflow_dispatch' || needs.detect-changes.outputs.dashboard == 'true'`, `uses:
    ./.github/workflows/deploy-dashboard.yaml`, `secrets:` all R14 secrets.
- All action `uses:` references must be SHA-pinned with a version comment (conventions gate).
- `.yaml` extension (not `.yml`).
- No `ssh-keyscan` in CI (host keys come from committed `.github/known_hosts`).
- No `secrets: inherit`.

**Patterns to follow:** `.github/workflows/deploy-umami.yaml`, `.github/workflows/deploy.yaml`
(existing router structure).

**Test scenarios:**
- Convention gate: `deploy-dashboard.yaml` passes `packages/cli/src/conventions.test.ts` (SHA-
  pinned with version comment, `.yaml`, no `ssh-keyscan`, no `secrets: inherit`).
- `deploy.yaml` router: `dashboard` filter matches `apps/dashboard/**` changes; negations exclude
  docs/tests.

**Verification:** YAML parses; conventions test green; router has a `dashboard` branch.

---

- [ ] **Unit 5: goke CLI commands/dashboard/* + cli.ts registration**

**Goal:** `packages/cli/src/commands/dashboard/` command group (`index.ts`, `deploy.ts`,
`status.ts`, `logs.ts`) + registration in `cli.ts`. Wire `dashboard status` into MCP allowlist
and unified status.

**Requirements:** R17, R18, R19, R20

**Dependencies:** Units 2, 3

**Files:**
- Create: `packages/cli/src/commands/dashboard/index.ts`
- Create: `packages/cli/src/commands/dashboard/deploy.ts`
- Create: `packages/cli/src/commands/dashboard/deploy.test.ts`
- Create: `packages/cli/src/commands/dashboard/status.ts`
- Create: `packages/cli/src/commands/dashboard/status.test.ts`
- Create: `packages/cli/src/commands/dashboard/logs.ts`
- Create: `packages/cli/src/commands/dashboard/logs.test.ts`
- Modify: `packages/cli/src/cli.ts` (import + call `registerDashboardCommands(cli)`)
- Modify: `packages/cli/src/commands/mcp.ts` (add `dashboard status` to `MCP_ALLOWLIST`)
- Modify: `packages/cli/src/commands/status.ts` (compose `getDashboardStatusSummary()`)

**Approach:**
- Mirror `packages/cli/src/commands/umami/` exactly: `index.ts` exports
  `registerDashboardCommands(cli)` calling `registerDashboardStatus/Deploy/Logs`.
- `status.ts`: SSH `docker compose ps` summary → `getDashboardStatusSummary()` returning a
  structured summary; uses `ctx.console`/`ctx.process` (MCP-capturable, not global console).
- `deploy.ts`: thin wrapper — triggers `workflow_dispatch` for the Deploy Dashboard workflow by
  default; `--local` flag for direct SSH deploy (mirrors umami deploy command).
- `logs.ts`: stream container logs over SSH (CLI-only; not MCP — may contain sensitive data).
- `index.ts`: barrel exporting `registerDashboardCommands`.
- `cli.ts`: add `import {registerDashboardCommands} from './commands/dashboard/index.ts'` and
  call `registerDashboardCommands(cli)`.
- `mcp.ts`: add `'dashboard status'` to `MCP_ALLOWLIST`. `dashboard deploy` and `dashboard logs`
  must NOT be in the allowlist.
- `status.ts` (unified): add `getDashboardStatusSummary()` alongside other app aggregators.
- `SpawnFn` injection for testability in all SSH-spawning commands.

**Patterns to follow:** `packages/cli/src/commands/umami/` (all files), `packages/cli/src/cli.ts`
(registration pattern), `packages/cli/src/commands/mcp.ts` (allowlist), `packages/cli/src/commands/status.ts`
(aggregator).

**Test scenarios:**
- `status.ts`: aggregator returns structured summary; uses `ctx.console` not global console.
- `deploy.ts`: triggers workflow dispatch by default; `--local` invokes deploy script.
- `logs.ts`: streams logs over SSH; not in MCP allowlist.
- `mcp.ts`: `MCP_ALLOWLIST` contains `dashboard status`; does NOT contain `dashboard deploy` or
  `dashboard logs`.
- Unified `status`: includes a `dashboard` row from `getDashboardStatusSummary()`.
- Help: `infra dashboard --help` renders correctly (NO_COLOR=1, version normalized).

**Verification:** `bun test` green; `dashboard status` MCP-exposed; `dashboard deploy`/`logs`
CLI-only; `infra dashboard --help` renders.

---

- [ ] **Unit 6: apps/dashboard/README.md + AGENTS.md runbook**

**Goal:** `apps/dashboard/README.md` (deploy badge, stack summary, commands, configuration table)
and `apps/dashboard/AGENTS.md` (full operator runbook: deploy flow, file-mounted App key
security, container hardening rationale, provisioning, secret rotation, upgrade flow,
anti-patterns).

**Requirements:** R24, R25

**Dependencies:** Units 1–5

**Files:**
- Create: `apps/dashboard/README.md`
- Create: `apps/dashboard/AGENTS.md`

**Approach:**
- `README.md`: mirror `apps/umami/README.md` structure. Deploy badge for the Deploy Dashboard
  workflow. Stack summary (two services: dashboard + caddy). Deploy + provisioning commands
  (`bun run --cwd apps/dashboard deploy`, `bun run provision:dashboard`, CLI equivalents).
  Configuration table (GitHub Environment `dashboard`, all R14 secrets with descriptions).
  Operations pointer to AGENTS.md. CLI commands table.
- `AGENTS.md`: mirror `apps/umami/AGENTS.md` structure. Key sections:
  - **Stack** — service table (dashboard image, caddy image, roles).
  - **Deploy flow** — numbered steps matching `deploy.ts` implementation; call out the App key
    file upload step explicitly (step N: "Uploads the GitHub App private key to
    `/opt/dashboard/config/github-app.pem` (0600) via SSH stdin — never as an env var, never
    logged").
  - **Container hardening** — explain `read_only`/`cap_drop`/`no-new-privileges`/non-root as a
    deliberate delta from `apps/umami`; document the file-mount path for the App key; explain
    why env vars are insufficient for long-lived key material.
  - **Secret rotation** — how to rotate each secret; note that `DASHBOARD_GITHUB_APP_KEY`
    rotation requires re-uploading the key file (redeploy) and revoking the old key in the
    GitHub App settings.
  - **Upgrade flow** — Renovate opens PRs for the dashboard image; merge → Deploy Dashboard
    workflow ships the new digest.
  - **Provisioning** — one-time `bun run provision:dashboard`; commit `.github/known_hosts`
    before first CI deploy.
  - **Anti-patterns** — never put the App private key in an env var; never `docker compose down
    -v` (destroys Caddy TLS data); never put secret values in SSH argv.

**Patterns to follow:** `apps/umami/README.md`, `apps/umami/AGENTS.md`.

**Verification:** Docs accurate to shipped behavior; no secret values in docs; anti-patterns
section explicitly calls out the file-mounted-key requirement.

---

## System-Wide Impact

- **Interaction graph:** new `registerDashboardCommands` in `cli.ts`; new branch in `deploy.yaml`
  router; new entry in unified `status`; new `MCP_ALLOWLIST` member. No existing app code paths
  change.
- **Error propagation:** provisioning fails closed on host-key pinning; deploy fails closed on
  missing env/host, on App key upload failure, and on `/healthz` probe failure.
- **State lifecycle risks:** Caddy TLS data lives in the `caddy_data` volume — never run `docker
  compose down -v`. No DB volume; no fingerprint guard needed.
- **API surface parity:** `dashboard status` follows the same Mode A + `ctx`-threading +
  aggregator contract as umami/gateway status; host validation mirrors `umami/src/host.ts`.
- **Integration coverage:** SSH-stdin-not-argv for all secret bytes (`.env` + App key); MCP
  allowlist drift guard; conventions test for the new workflow.
- **Unchanged invariants:** no change to existing app code paths, deploy workflows, or
  `droplet-helpers.ts`. `packages/` still never imports from `apps/`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| fro-bot/dashboard image registry path unknown | Confirm with fro-bot/dashboard repo before writing compose; use a placeholder until confirmed (OQ5) |
| `read_only: true` breaks the Hono app (needs writable paths) | Verify with the fro-bot/dashboard team; add `tmpfs` mounts for any required writable paths (e.g. `/tmp`) if needed |
| GitHub Environment `dashboard` auto-creates ungated on first workflow reference | Pre-create with reviewer + branch policy before merge (umami lesson) |
| First deploy cascade (ACME cert lag, SSH key trailing-`\n`) | Reuse battle-tested `droplet-helpers.ts`; budget the cascade; `materializeIdentityFile` already handles trailing-newline |
| App key accidentally logged or written to runner disk | Deploy test asserts key bytes never in spawn argv; no temp file write; CI log masking via GitHub secret redaction |
| Stale `bun.lock` breaks `--frozen-lockfile` CI | Run `bun install` + commit lockfile in Unit 1 |
| `cap_drop: [ALL]` breaks network access (dashboard needs outbound GitHub API calls) | `cap_drop: [ALL]` does not affect network namespaces; verify with a test deploy; add `cap_add: [NET_BIND_SERVICE]` only if needed |

## Documentation / Operational Notes

- **Operator prerequisites (pre-merge):** generate `fro-bot-dashboard` Ed25519 key
  (`DASHBOARD_SSH_KEY`); create the `dashboard` GitHub Environment with reviewer + branch policy;
  seed all R14 secrets.
- **Bootstrap ordering:** (1) seed secrets into `.env` + `dashboard` Environment; (2) `bun run
  provision:dashboard` — creates droplet, pins host keys; (3) commit `.github/known_hosts`; (4)
  first deploy via `bun run --cwd apps/dashboard deploy` or the workflow.
- **First deploy cascade expected** — budget attempts; verify with `/healthz` probe (not just
  `docker compose ps`).
- **App key file on the droplet** — `/opt/dashboard/config/github-app.pem` (0600, owned by root
  or the deploy user). The compose bind-mounts it read-only into the container at
  `/run/secrets/github-app.pem`. Never copy this file off the droplet; rotate by redeploying
  with a new `DASHBOARD_GITHUB_APP_KEY` secret.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-15-dashboard-deploy-stack-requirements.md](docs/brainstorms/2026-06-15-dashboard-deploy-stack-requirements.md)
- **Related app plan (fro-bot/.github):** `docs/plans/2026-06-15-001-feat-monitoring-dashboard-phase-1-plan.md` (Units 7–8 cover the infra deploy contract from the app's perspective; this plan is the infra-repo-owned counterpart)
- Related code: `apps/umami/` (all files — primary pattern), `packages/cli/src/commands/umami/`,
  `packages/cli/src/commands/mcp.ts`, `packages/cli/src/commands/status.ts`,
  `packages/cli/src/conventions.test.ts`, `packages/shared/server/droplet-helpers.ts`
- Related learnings: `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`,
  `gateway-first-deploy-cascade-2026-05-20.md`, `cliproxy-first-deploy-cascade-2026-04-06.md`,
  `bun-deploy-user-permissions-ci-2026-04-02.md`
