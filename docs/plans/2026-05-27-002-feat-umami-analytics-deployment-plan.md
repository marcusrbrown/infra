---
title: 'feat: self-hosted Umami analytics deployment (apps/umami)'
type: feat
status: active
date: 2026-05-27
origin: 'GitHub issue #315 + Fro Bot triage (comment 4560738565)'
deepened: 2026-05-27
---

# feat: self-hosted Umami analytics deployment (apps/umami)

## Overview

Add a self-hosted [Umami](https://umami.is) analytics deployment as a new `apps/umami/`
package, deployed to a dedicated DigitalOcean droplet via Docker Compose (Umami v3.1.0 +
PostgreSQL 15) behind Caddy for auto-TLS at `metrics.fro.bot`. This gives projects
privacy-respecting, cookie-free web analytics with no third-party data processor. The first
consumer is the Systematic docs site (`https://fro.bot/systematic`), which needs visitor
measurement that preserves its "nothing phones home / no third-party tracking" posture.

The app follows the repo's established droplet+compose model: it borrows `apps/cliproxy/`'s
public-HTTPS-behind-Caddy shape and `apps/gateway/`'s SSH hygiene, secret-file
materialization, host validation, provision scaffolding, and CLI command module. Its one
genuinely new concern is **relational persistence** — a PostgreSQL data volume that must
survive redeploys and whose credentials are baked into the volume on first init.

## Problem Frame

Origin: GitHub issue #315, with a detailed Fro Bot triage comment that validated the repo
patterns and recommended the droplet+compose path. The deployment-target fork (Cloudflare
Workers vs droplet) is **resolved: droplet + Docker Compose** (operator decision, 2026-05-27).

The Systematic docs analytics work is blocked until this instance is live with a website ID.
No work is blocked on the Systematic side until the instance exists; once live, that side
needs only a cookie-free `<script>` tag plus two custom events.

Why self-hosted Umami: strongest defensible privacy claim (no third-party processor, no
cross-border transfer, no consent banner), cookie-free and DNT-respecting by default, and
reusable across any number of sites via per-site tracking IDs against one instance.

## Requirements Trace

- R1. Umami instance reachable over HTTPS at a stable subdomain (`metrics.fro.bot`), TLS via
  Caddy auto-cert.
- R2. Privacy baseline enforced: cookie-free, DNT-respected, no PII; `DISABLE_TELEMETRY=1`
  (no Umami phone-home) and `PRIVATE_MODE=1` (no external calls) set on the instance.
- R3. Deploy is idempotent and follows repo deploy-flow conventions: secrets via SSH
  stdin/files never argv, host validated before SSH argv, container-health + app-level HTTP
  health-gated completion.
- R4. PostgreSQL data persists across redeploys in a named volume; the deploy never wipes it.
- R5. CLI commands `umami status`, `umami deploy` (remote default + `--local`), and
  `umami logs` wired and registered, with `umami status` in the unified `status` rollup.
- R6. A tracking website/ID provisioned in Umami for the Systematic docs site, captured for
  the downstream docs instrumentation (the script-tag attributes documented for that
  consumer). Ownership: this is satisfied by an operator-prerequisite step (Umami website
  creation is a manual admin-UI action after first deploy — see Documentation / Operational
  Notes step 7) plus Unit 8 documenting the exact tag; it is intentionally not a code unit.
- R7. Operator docs (`apps/umami/AGENTS.md`) cover deploy flow, first-login admin-password
  rotation, the privacy-config baseline, Postgres backup/restore, retention policy, secret
  rotation (including the DB-password constraint), and upgrade flow.
- R8. Deploy automated via `.github/workflows/deploy-umami.yaml` in an `umami` GitHub
  environment, SHA-pinned actions, path-filtered with `predicate-quantifier: every`, pinned
  host keys, explicit secrets.

## Scope Boundaries

- No Cloudflare Workers / D1 path — droplet + compose only (operator decision).
- No shared-droplet placement for v1 — a dedicated `s-1vcpu-1gb` droplet (resize triggers
  documented). A shared-droplet decision can be made deliberately later.
- No automated/scheduled backups for v1 — the manual `pg_dump` runbook in AGENTS.md is the v1
  backup story.
- No MySQL variant — PostgreSQL only.
- No adblock-evasion proxy rewrites (`TRACKER_SCRIPT_NAME` / `COLLECT_API_ENDPOINT`) for v1 —
  documented as an available option, not configured.
- The plan provisions the deployment; it does NOT modify the Systematic repo. The downstream
  `docs/astro.config.mjs` script-tag wiring is a separate task in that repo (R6 only captures
  the website ID and documents the exact tag).

### Deferred to Separate Tasks

- `umami backup` / `umami restore` CLI commands (gateway CA backup/restore pattern adapted to
  `pg_dump` tarballs): separate follow-up once the manual runbook proves the shape. Tracked as
  a future enhancement.
- Systematic docs `<script>` tag + `view_quick_start` / `click_install_cta` custom events:
  downstream task in the Systematic repo, unblocked once R6 yields a website ID.
- Scheduled off-droplet backup to S3/R2: future iteration if retention/DR requirements grow.

## Context & Research

### Relevant Code and Patterns

- **Public-HTTPS + Caddy shape** — `apps/cliproxy/docker-compose.yaml` (Caddy service with
  `80:80`/`443:443`, `caddy_data`/`caddy_config` named volumes, mounts `./config/Caddyfile`;
  app service with a `wget --spider` healthcheck) and `apps/cliproxy/config/Caddyfile`
  (`{$DOMAIN} { reverse_proxy <service>:<port> }`). Mirror this for `umami:3000`.
- **deploy.ts contract** — `apps/cliproxy/src/deploy.ts` (env validation, `docker compose pull
  && up -d --wait --wait-timeout 90`, post-deploy HTTPS health check) and
  `apps/gateway/src/deploy.ts` (secret-file materialization via SSH stdin never argv,
  `validateGatewayHost` before SSH argv, ControlMaster/ControlPersist SSH multiplexing from
  PR #277, CI temp-key-file from `*_SSH_KEY` with trailing-newline handling, env validation
  before any SSH).
- **provision-droplet.ts** — `apps/gateway/server/provision-droplet.ts`: `doctl`,
  `docker-20-04` image slug (the corrected slug from PR #271 — NOT `docker-24-04`),
  `s-1vcpu-1gb` size, key-by-name selection via `GATEWAY_SSH_KEY_NAME` (PR #268), `pinHostKeys`
  into `.github/known_hosts`, shared helpers from `@marcusrbrown/infra-shared`, and the
  `if (import.meta.main)` guard so test imports don't trigger live `doctl`.
- **Shared helpers** — `packages/shared/server/droplet-helpers.ts` exports `ssh`, `scp`,
  `run`, `runCapture`, `sleep`, `validateDoctl`, `dropletExists`, `getSshFingerprint`,
  `getDropletIpWithWait`, `waitForSsh`, `pinHostKeys`. Umami's provision reuses all except
  possibly `runCapture`.
- **Host validation** — `apps/gateway/src/host.ts` `validateGatewayHost` and
  `packages/cli/src/commands/gateway/host.ts`: reject `-`-prefixed values and characters
  outside `[A-Za-z0-9.-]` before any SSH argv construction. Clone as `validateUmamiHost`.
- **CLI command module** — `packages/cli/src/commands/gateway/` (`index.ts` barrel →
  `registerGatewayCommands`, `status.ts` with SSH `docker compose ps --format json` + NDJSON
  parsing from PR #278 + `ActionCtx` threading, `deploy.ts` remote `gh workflow run` default +
  `--local`, `logs.ts` with CI-refusal/`--allow-ci` + sensitive-data warning, `host.ts`).
- **Unified status** — `packages/cli/src/commands/status.ts`: `StatusSummary['app']` union,
  per-app `getXStatusSummary` aggregator, `StatusDependencies`, `Promise.allSettled` array,
  `appNames` array, `toJsonPayload`.
- **Deploy workflow** — `.github/workflows/deploy-cliproxy.yaml` and `deploy-gateway.yaml`:
  SHA-pinned actions, `dorny/paths-filter` with `predicate-quantifier: every` (the bug fixed
  in PR #191 — required), `environment: <app>`, committed `.github/known_hosts`,
  `bun install --frozen-lockfile --ignore-scripts`, explicit secrets (never `inherit`),
  change-detection filter excluding `**/*.md` / `**/*.test.ts`.
- **MCP fidelity** — `packages/cli/src/commands/mcp.ts` `MCP_ALLOWLIST` and
  `packages/cli/src/lib/action-ctx.ts` `ActionCtx`: `gateway status` is MCP-capturable (SSH +
  docker compose ps → structured); `umami status` follows the same Tier-1/Tier-2 test bar.
- **Renovate image pinning** — `.github/renovate.json5` packageRules for
  `eceasy/cli-proxy-api` and `caddy` (sourceUrl + changelogUrl + standalone PRs). Add an
  equivalent entry for the Umami image.
- **cli.ts registration** — `packages/cli/src/cli.ts` registers app barrels in order; add
  `registerUmamiCommands(cli)`.

### Institutional Learnings

- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — first deploy
  is an end-to-end **deploy-contract** validation, not a feature smoke test. Failure waves to
  pre-empt: SSH key newline/`libcrypto` (GH Actions strips trailing whitespace — append `\n`
  when writing the key file), corrupted secret re-seeding, UFW SSH rate-limiting (use
  ControlMaster multiplexing, don't weaken the firewall), `docker compose ps` NDJSON parsing,
  docker image slug. Verify stored secret values structurally, don't "just retry."
- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — stale
  lockfile after adding a workspace member, wrong/aliased env var, hashed-only host keys
  (CI connects by domain, so pin unhashed domain entries), an app that needs its storage path
  explicitly configured (here: Postgres `DATABASE_URL` + the data volume mount).
- Project memory: `docker compose up -d --wait --wait-timeout` still needs an app-level HTTP
  readiness check after (PR #82 race); deploy workflows use `predicate-quantifier: every`
  (PR #81/#165/#191); cross-org reusable workflows pass secrets explicitly; CI lint/tsc jobs
  pin Node 24 (deploy workflows do not need it — no lint/tsc step).

### External References

- Umami v3.1.0 — https://github.com/umami-software/umami/releases/tag/v3.1.0
- Official install + first-login rotation — https://docs.umami.is/docs/install
- Environment variables (`DISABLE_TELEMETRY`, `PRIVATE_MODE`, `DATABASE_URL`, `APP_SECRET`) —
  https://docs.umami.is/docs/environment-variables
- Official `docker-compose.yml` (service shape, healthchecks, volume) —
  https://raw.githubusercontent.com/umami-software/umami/master/docker-compose.yml
- Health endpoint `/api/heartbeat` → `{"ok":true}` —
  https://raw.githubusercontent.com/umami-software/umami/master/src/app/api/heartbeat/route.ts
- Tracker configuration (`data-website-id`, `data-do-not-track`, `data-exclude-search`,
  `data-exclude-hash`, `/script.js`) — https://docs.umami.is/docs/tracker-configuration
- FAQ (cookie-free, indefinite retention) — https://docs.umami.is/docs/faq

## Key Technical Decisions

- **Image: pin `docker.umami.is/umami-software/umami:postgresql-v3.1.0`** (the PostgreSQL
  prebuilt variant at the current release), not `:postgresql-latest`. Rationale: versioned,
  reviewable, Renovate-trackable updates — matches the repo's `eceasy/cli-proxy-api:vX.Y.Z`
  and `caddy:2.11.x` pinning practice. Postgres image: `postgres:15-alpine` (official compose
  uses 15-alpine). Verify the exact `postgresql-v3.1.0` tag exists at implementation time. If
  the versioned tag is absent, resolve and pin the specific **digest of the v3.1.0 release
  image** — never `latest@digest`, which is a moving target and not equivalent to v3.1.0.
  Document the exact digest used.
- **DB secret naming:** the GitHub environment secret is `UMAMI_DB_PASSWORD`; deploy.ts writes
  it into the droplet `.env` as `POSTGRES_PASSWORD` (consumed by the postgres container) and
  composes it into `DATABASE_URL`. One secret, two on-disk names — stated once here, used
  consistently everywhere.
- **No `upstream.json`.** Unlike gateway (which clones+builds the `fro-bot/agent` repo on the
  droplet), Umami ships as a prebuilt image. The version pin lives in `docker-compose.yaml`
  and is Renovate-managed. This makes Umami structurally a **cliproxy clone, not a gateway
  clone**, for the image-versioning dimension.
- **Secret materialization: write `.env` on the droplet every deploy via SSH stdin** (gateway
  pattern), containing `APP_SECRET`, `POSTGRES_PASSWORD`, and the constructed
  `DATABASE_URL=postgresql://umami:<POSTGRES_PASSWORD>@db:5432/umami`. Compose reads the
  `.env`. Secrets never appear in argv. `APP_SECRET` rotation only invalidates active login
  sessions (re-login), so it's lower-risk but still discouraged casually.
- **DB-password fingerprint guard (root-cause prevention, not just docs).** `POSTGRES_PASSWORD`
  is baked into the Postgres data volume on first init; regenerating `.env` with a different
  password on a later deploy would break DB auth and take the public site down. deploy.ts
  prevents this structurally: on the first successful deploy it writes a **fingerprint** (a
  salted SHA-256 hash of `POSTGRES_PASSWORD`, never the password itself) to a droplet sentinel
  file (e.g. `/opt/umami/.db-password-fingerprint`). Every subsequent deploy compares the
  current secret's fingerprint against the sentinel; on mismatch it **refuses to deploy** with
  a clear message pointing at the `ALTER USER` rotation runbook (Unit 8). This makes a silent
  brick impossible — a rotation must go through the documented in-DB migration, which updates
  both the live role password and the sentinel. The fingerprint is a hash so the sentinel file
  holds no secret material.
- **Persistence over preservation.** cliproxy preserves a mutable `config.yaml` (skip-upload
  unless `--force-config`). Umami has no such mutable file on disk — all runtime state lives
  in the Postgres volume `umami-db-data`. So the deploy does NOT need a config-preservation
  branch; it needs the **volume to persist** (named volume, never `docker compose down -v`).
  The `.env` is regenerated every deploy from the stable secrets.
- **Health-gate: container-health is the success signal; public HTTPS is a bounded-retry
  warning.** `docker compose up -d --wait --wait-timeout 180` blocks on the compose
  healthchecks (postgres `pg_isready`, umami `curl http://localhost:3000/api/heartbeat`,
  `depends_on: condition: service_healthy`) — this is the authoritative deploy-success signal
  (container is healthy on its localhost interface). deploy.ts then probes the **public**
  `GET https://${UMAMI_HOST}/api/heartbeat` as a **bounded retry** (e.g. ~6 attempts over
  ~60s). On the first deploy Caddy must still complete a Let's Encrypt ACME challenge (depends
  on DNS + LE timing), so if the public probe doesn't return `{"ok":true}` within the retry
  window deploy.ts emits a WARNING — `containers healthy; TLS cert still issuing — verify at
  https://${UMAMI_HOST}/api/heartbeat` — and **succeeds**, rather than false-failing a healthy
  deploy. `compose up` is idempotent, so a re-run is always safe. Timeout raised from 120s to
  180s for first-boot DB migrations. (Refines the PR #82 readiness lesson: container-health is
  the contract; public TLS lag on first deploy is a warning, not a failure.)
- **Automated admin-password rotation (close the default-creds window).** Umami boots with
  `admin`/`umami`; the public endpoint must not sit reachable with known defaults waiting on a
  manual rotation. After containers are healthy, deploy.ts logs into Umami over the droplet's
  **localhost interface via SSH** (never the public endpoint) using the default creds and sets
  the admin password from a new `UMAMI_ADMIN_PASSWORD` GitHub secret (Umami's auth API:
  `POST /api/auth/login` → token → `POST /api/users/<id>/password` or equivalent for the
  running version — confirm the exact endpoints at implementation). This is idempotent: once
  rotated, the default-cred login fails, so deploy.ts treats a failed default-login as
  "already rotated" and continues. Closes the takeover window entirely. Cost: one extra secret
  (`UMAMI_ADMIN_PASSWORD`) and a coupling to Umami's auth API shape (pin to the v3.1.0 API;
  re-verify on image bumps).
- **Privacy baseline baked into compose env:** `DISABLE_TELEMETRY=1` (no Umami phone-home) and
  `PRIVATE_MODE=1` (blocks all external calls incl. DuckDuckGo favicon lookups). Cookie-free
  and DNT are Umami defaults; the downstream tracker tag adds `data-do-not-track="true"`.
- **Droplet `s-1vcpu-1gb` dedicated.** Umami + a small Postgres is light. Resize trigger
  documented: bump to `s-1vcpu-2gb` if Postgres memory pressure or sustained query latency
  appears as traffic grows.
- **ControlMaster SSH multiplexing** in deploy.ts from the outset (gateway PR #277) — the
  deploy makes several SSH/scp calls (mkdir, write `.env`, scp compose + Caddyfile, compose
  up, health check), enough to trip UFW's default 6-new-connections/30s `limit ssh` rule.

## Open Questions

### Resolved During Planning

- Deployment target (Workers vs droplet)? **Droplet + Docker Compose** (operator decision).
- Hostname? **`metrics.fro.bot`** (Fro Bot recommendation; product-neutral, privacy-aligned).
- Pin the image or track `latest`? **Pin the versioned PostgreSQL tag**, Renovate-managed.
- `upstream.json`? **No** — prebuilt image, version pinned in compose.
- Config preservation like cliproxy? **No** — state is in the Postgres volume; regenerate
  `.env` each deploy from stable secrets, never remove the volume.
- Backup in v1 scope? **Manual `pg_dump` runbook in AGENTS.md**; backup/restore CLI deferred.
- CLI surface? **`status` / `deploy` / `logs`** (issue's stated surface).
- DB-password rotation safety? **Deploy-time fingerprint guard** — deploy.ts refuses when the
  secret changed against the volume's initialized password; rotation must go through the
  `ALTER USER` runbook (root-cause prevention, not docs-only).
- First-deploy Caddy ACME race on the health check? **Container-health is the success signal;
  the public-HTTPS probe is a bounded retry that warns (not fails) on cert-issuance lag.**
  Timeout raised to 180s for first-boot migrations.
- Default-creds (`admin`/`umami`) exposure window? **Automated post-deploy rotation over the
  droplet localhost interface** using a new `UMAMI_ADMIN_PASSWORD` secret; idempotent (skips
  if already rotated). Closes the window without manual action.

### Deferred to Implementation

- Exact `postgresql-v3.1.0` tag existence — confirm against the registry when writing
  `docker-compose.yaml`; if absent, pin the v3.1.0 release digest (never `latest@digest`).
- Exact Umami v3.1.0 auth API endpoints for the automated admin rotation (`POST /api/auth/login`
  → token; the password-update route/shape) — confirm against the running image at
  implementation; the rotation step is localhost-only and idempotent.
- Whether `DATABASE_TYPE` must be set explicitly (official compose omits it; env docs mention
  it as Docker-only) — set it to `postgresql` defensively if the image needs it, decide when
  testing the first boot.
- Exact Caddyfile health/timeout tuning and whether Umami needs any proxy-header passthrough
  beyond Caddy's defaults — confirm on first deploy.
- Final public-probe retry count/window and `wait-timeout` (start at 180s) — tune from observed
  first-boot migration duration.

## Output Structure

    apps/umami/
    ├── package.json                      # @marcusrbrown/infra-umami
    ├── AGENTS.md                         # operator docs (Unit 8)
    ├── docker-compose.yaml               # umami + postgres + caddy, pinned, healthchecks
    ├── config/
    │   └── Caddyfile                     # metrics.fro.bot reverse_proxy umami:3000
    ├── src/
    │   ├── deploy.ts                     # env validation, .env materialization, compose, health-gate
    │   ├── deploy.test.ts
    │   ├── host.ts                       # validateUmamiHost
    │   └── host.test.ts
    └── server/
        ├── provision-droplet.ts          # doctl, key-by-name, pinHostKeys, import.meta.main guard
        └── provision-droplet.test.ts

    packages/cli/src/commands/umami/
    ├── index.ts                          # registerUmamiCommands + getUmamiStatusSummary
    ├── status.ts                         # SSH docker compose ps (NDJSON), ActionCtx, MCP-capturable
    ├── status.test.ts
    ├── deploy.ts                         # gh workflow run default + --local
    ├── deploy.test.ts
    ├── logs.ts                           # stream container logs, CI-refusal + sensitive warning
    ├── logs.test.ts
    ├── host.ts                           # validateUmamiHost (CLI copy mirroring gateway)
    └── host.test.ts

    .github/workflows/deploy-umami.yaml   # SHA-pinned, paths-filter quantifier, environment: umami

## Implementation Units

- [ ] **Unit 1: App scaffolding — package, compose stack, Caddy, Renovate pin**

**Goal:** Create the `apps/umami/` package with the Docker Compose stack (Umami + Postgres +
Caddy), Caddy reverse-proxy config, and the Renovate image-pin entry. `docker compose config`
validates; `bun install` refreshes the lockfile for the new workspace member.

**Requirements:** R1, R2, R4

**Dependencies:** None.

**Files:**
- Create: `apps/umami/package.json` (`@marcusrbrown/infra-umami`, private; scripts
  `deploy`/`provision`/`test`; dep `@marcusrbrown/infra-shared`)
- Create: `apps/umami/docker-compose.yaml`
- Create: `apps/umami/config/Caddyfile`
- Create: `apps/umami/AGENTS.md` (placeholder; fleshed out in Unit 8)
- Modify: `.github/renovate.json5` (packageRules entry for the Umami image: sourceUrl
  `https://github.com/umami-software/umami`, changelogUrl, standalone PR group)
- Modify: `bun.lock` (commit after `bun install`)

**Approach:**
- Compose: three services. `umami` (image
  `docker.umami.is/umami-software/umami:postgresql-v3.1.0`, `init: true`, `restart:
  unless-stopped`, env from `.env` — `DATABASE_URL`, `APP_SECRET`, `DISABLE_TELEMETRY=1`,
  `PRIVATE_MODE=1`, optionally `DATABASE_TYPE=postgresql`; healthcheck `curl -f
  http://localhost:3000/api/heartbeat`; `depends_on: db: condition: service_healthy`).
  `db` (`postgres:15-alpine`, `restart: unless-stopped`, env `POSTGRES_DB=umami`/
  `POSTGRES_USER=umami`/`POSTGRES_PASSWORD` from `.env`; healthcheck `pg_isready -U umami -d
  umami`; named volume `umami-db-data:/var/lib/postgresql/data`). The `db` service publishes
  NO host port — no `ports:` mapping, never expose `5432` — reachable only on the internal
  compose network. `caddy` (`caddy:2.11-alpine`
  digest-pinned, `80:80`/`443:443`, `caddy_data`+`caddy_config` named volumes, mounts
  `./config/Caddyfile`, `reverse_proxy umami:3000`).
- Caddyfile: `{$UMAMI_HOST} { reverse_proxy umami:3000 }` (Caddy auto-TLS).
- Privacy env set at the compose layer so it's tracked and reviewable, not just on the droplet.
- Do NOT put real secret values in any tracked file — `APP_SECRET`/`POSTGRES_PASSWORD` come
  from the droplet `.env` written by deploy.ts (Unit 3). Tracked compose references them via
  `${VAR}` interpolation from the `.env`.

**Patterns to follow:** `apps/cliproxy/docker-compose.yaml`, `apps/cliproxy/config/Caddyfile`,
the `caddy`/`eceasy` packageRules in `.github/renovate.json5`.

**Test scenarios:**
- Test expectation: none for the YAML/config files themselves (no behavioral code) — validate
  via `docker compose config` exit 0 in the Unit's verification, and the executable conventions
  test (`packages/cli/src/conventions.test.ts`) already enforces `.yaml` extension / no
  bundledDependencies repo-wide.

**Verification:**
- `docker compose -f apps/umami/docker-compose.yaml config` exits 0.
- `bun install` produces a clean `bun.lock` diff (new workspace member only).
- No secret values in any tracked file (grep clean).

- [ ] **Unit 2: Host validation**

**Goal:** `validateUmamiHost` rejects `-`-prefixed hostnames and characters outside
`[A-Za-z0-9.-]` before any value reaches SSH argv.

**Requirements:** R3

**Dependencies:** None.

**Files:**
- Create: `apps/umami/src/host.ts`
- Create: `apps/umami/src/host.test.ts`

**Approach:** Clone `apps/gateway/src/host.ts` exactly (same regex, same throw message shape,
renamed `validateUmamiHost`). This is a security-critical guard — SSH treats `-`-prefixed
hostnames as flags (e.g. `-oProxyCommand=`).

**Execution note:** Test-first — write the rejection cases before the implementation; this is
a security boundary with a known contract.

**Patterns to follow:** `apps/gateway/src/host.ts`, `apps/gateway/src/host.test.ts`.

**Test scenarios:**
- Happy path: `metrics.fro.bot`, `1.2.3.4` → accepted.
- Error path: `-oProxyCommand=evil` → throws.
- Error path: hostnames with spaces, `;`, `|`, `$`, backticks, quotes → throws.
- Edge case: empty string → throws.

**Verification:** All rejection cases throw; valid hosts pass; tests green.

- [ ] **Unit 3: deploy.ts — env validation, `.env` materialization, compose, health-gate**

**Goal:** `apps/umami/src/deploy.ts` validates env, materializes the droplet `.env` via SSH
stdin (never argv), uploads compose + Caddyfile, runs `docker compose pull && up -d --wait`,
guards against a DB-password change that would brick the volume, gates on container health
with a bounded public-HTTPS retry, and rotates the default admin password over localhost.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1 (compose stack), Unit 2 (host validation).

**Files:**
- Create: `apps/umami/src/deploy.ts`
- Create: `apps/umami/src/deploy.test.ts`

**Approach:**
- Validate env before any SSH: `PATH`, `HOME`, SSH context (`SSH_AUTH_SOCK` for local, or
  `UMAMI_SSH_KEY` temp-key-file for CI with trailing-`\n` append), `UMAMI_HOST`,
  `UMAMI_APP_SECRET`, `UMAMI_DB_PASSWORD`, `UMAMI_ADMIN_PASSWORD`. Call
  `validateUmamiHost(UMAMI_HOST)` before constructing any SSH argv.
- ControlMaster/ControlPersist SSH multiplexing (gateway PR #277) with a temp socket dir,
  reused across all SSH/scp calls; clean up the socket on exit.
- Remote: `mkdir -p /opt/umami/config`. Write `/opt/umami/.env` via
  `Bun.spawn(ssh(...), {stdin: 'pipe'})` then `proc.stdin.write(contents); proc.stdin.end()` —
  contents = `APP_SECRET=...\nPOSTGRES_PASSWORD=...\nDATABASE_URL=postgresql://umami:<pw>@db:5432/umami\nUMAMI_HOST=...\n`.
  Apply defensive validation at the boundary (reject `\n`, `\r`, backtick, `$`, `|`, `;`, `&`,
  quotes, backslash in the secret values used in remote shell context). No deploy error path
  ever echoes secret contents; tests assert the `.env` is written only via stdin and never
  logged.
- Preflight: resolve `UMAMI_HOST` DNS before attempting SSH/deploy and fail fast with a clear
  message if it does not resolve — prevents a late, opaque Caddy ACME failure when DNS isn't
  configured yet.
- `scp` `docker-compose.yaml` → `/opt/umami/docker-compose.yaml` and `config/Caddyfile` →
  `/opt/umami/config/Caddyfile`.
- **DB-password fingerprint guard (before compose up):** compute a salted SHA-256 of
  `POSTGRES_PASSWORD`. Read the droplet sentinel `/opt/umami/.db-password-fingerprint` (if it
  exists). If present and it does NOT match the current fingerprint, **refuse to deploy** with
  a message naming the `ALTER USER` runbook (Unit 8) — the volume was initialized with a
  different password and proceeding would break DB auth. If absent (first deploy), proceed and
  write the sentinel after a successful `up`. The sentinel holds only the hash, never the
  password.
- `cd /opt/umami && docker compose pull && docker compose up -d --wait --wait-timeout 180`.
  Container health (`pg_isready` + umami localhost `/api/heartbeat`) via `--wait` is the
  authoritative success signal. After success, write the DB-password fingerprint sentinel.
- **Bounded public-HTTPS probe (warning, not gate):** retry `GET https://${UMAMI_HOST}/api/heartbeat`
  (~6 attempts over ~60s) expecting `{"ok":true}`. On success, done. On lingering failure
  (first-deploy Caddy ACME lag), emit a WARNING (`containers healthy; TLS cert still issuing —
  verify at https://${UMAMI_HOST}/api/heartbeat`) and **succeed** — do not throw. `compose up`
  is idempotent so a re-run is always safe.
- **Automated admin-password rotation (over localhost, after health):** via SSH on the
  droplet, hit Umami's auth API on `http://localhost:3000` (never the public host): log in with
  default `admin`/`umami`, and if that succeeds set the admin password to
  `UMAMI_ADMIN_PASSWORD`. If the default login FAILS, treat it as already-rotated and continue
  (idempotent). Confirm the exact v3.1.0 auth endpoints at implementation (`POST /api/auth/login`
  → token; password-update route). The admin password value travels via SSH stdin / request
  body, never argv.
- Never `docker compose down -v` (would destroy the Postgres volume). The deploy only does
  `up -d`.

**Execution note:** Test-first for the env-validation, host-validation, and command-construction
paths (mock `Bun.spawn` at the boundary; assert no secret bytes in argv).

**Patterns to follow:** `apps/gateway/src/deploy.ts` (secret-file stdin, ControlMaster, CI
key-file + trailing newline, env validation), `apps/cliproxy/src/deploy.ts` (compose
pull/up/--wait + post-deploy HTTPS health check).

**Test scenarios:**
- Happy path: all env present → builds the expected SSH/scp/compose command sequence; the
  `.env` contents are piped via stdin, not argv.
- Error path: missing `UMAMI_HOST` / `UMAMI_APP_SECRET` / `UMAMI_DB_PASSWORD` /
  `UMAMI_ADMIN_PASSWORD` / SSH context → throws a specific message, no SSH attempted.
- Error path (security): `UMAMI_HOST='-oProxyCommand=x'` → `validateUmamiHost` throws before
  any argv construction.
- Error path (security): a secret value containing `\n`/`\r` or shell metacharacters → rejected
  at the boundary, never written.
- Error path (DB-password guard): sentinel exists with a non-matching fingerprint → deploy
  refuses before `compose up`, message names the rotation runbook, no compose invoked.
- Happy path (first deploy): no sentinel → proceeds, writes the sentinel after a healthy `up`;
  fingerprint is a hash, the password never appears in the sentinel contents.
- Edge case (fingerprint match): sentinel matches current secret → deploy proceeds normally.
- Edge case (Caddy ACME lag): public-HTTPS probe never returns `{"ok":true}` within the retry
  window but containers are healthy → deploy SUCCEEDS with a warning (does NOT throw).
- Integration (public health success): public probe returns `{"ok":true}` → no warning.
- Edge case (admin rotation idempotency): default `admin`/`umami` login fails (already rotated)
  → rotation step is skipped, deploy continues; login succeeds → password is set to
  `UMAMI_ADMIN_PASSWORD` and the admin password value never appears in argv.
- Edge case: CI mode (`UMAMI_SSH_KEY` set, no `SSH_AUTH_SOCK`) → writes a temp key file with a
  trailing newline, `chmod 600`, cleans it up.
- Edge case: no secret bytes (DB password, app secret, admin password) appear in any
  constructed argv array (assert across the whole command sequence).

**Verification:** Tests green; manual first deploy reaches `{"ok":true}` over HTTPS (or warns
on cert lag and a follow-up `umami status` confirms); the default admin login no longer works
post-deploy; the Postgres volume persists across a second deploy (data not wiped); a deploy
with a changed `UMAMI_DB_PASSWORD` is refused by the fingerprint guard.

- [ ] **Unit 4: provision-droplet.ts**

**Goal:** One-time droplet provisioning for `metrics.fro.bot`: create the droplet, select the
SSH key by name, wait for SSH, pin host keys into `.github/known_hosts`.

**Requirements:** R1, R8

**Dependencies:** Unit 2 (host validation reused for any host arg).

**Files:**
- Create: `apps/umami/server/provision-droplet.ts`
- Create: `apps/umami/server/provision-droplet.test.ts`

**Approach:**
- Import shared helpers from `@marcusrbrown/infra-shared`: `validateDoctl({checkAuth: true})`,
  `dropletExists` (abort if exists unless `--force`), `getSshFingerprint`,
  `getDropletIpWithWait`, `waitForSsh`, `pinHostKeys`, `run`.
- Create `s-1vcpu-1gb` droplet, image slug `docker-20-04` (the corrected slug — NOT
  `docker-24-04`), region matching the other droplets.
- Key selection by name: `UMAMI_SSH_KEY_NAME` env override, default `fro-bot-umami`
  (`getSshFingerprint` matches by name, never by position — the PR #268 lesson).
- After SSH connectivity, `pinHostKeys` appends both the `metrics.fro.bot` domain (unhashed)
  and the droplet IP entries to `.github/known_hosts`; print a reminder to commit it.
- Gate all top-level execution behind `if (import.meta.main)` so test imports don't trigger
  live `doctl`/`ssh`/network calls.

**Execution note:** Test-first for the guard behavior and key-selection logic (mock the shared
helpers / `Bun.spawn`).

**Patterns to follow:** `apps/gateway/server/provision-droplet.ts`,
`apps/cliproxy/server/provision-droplet.ts`, `packages/shared/server/droplet-helpers.ts`.

**Test scenarios:**
- Happy path: provisions, selects key `fro-bot-umami` by name, pins both host-key forms.
- Edge case: `UMAMI_SSH_KEY_NAME` override → that key name is used.
- Error path: droplet already exists, no `--force` → aborts with a clear message, no creation.
- Error path: `doctl` not authenticated → aborts.
- Integration: importing the module in a test does NOT trigger `doctl`/network (the
  `import.meta.main` guard holds).

**Verification:** Tests green; live run creates the droplet and appends host keys; re-run
without `--force` refuses.

- [ ] **Unit 5: CLI command module (`umami status` / `deploy` / `logs` / host)**

**Goal:** `packages/cli/src/commands/umami/` with `status`, `deploy`, `logs`, a CLI-side
`host.ts`, and the `index.ts` barrel; registered in `cli.ts`.

**Requirements:** R5

**Dependencies:** Unit 3 (deploy.ts target for `--local`), Unit 4.

**Files:**
- Create: `packages/cli/src/commands/umami/index.ts` (`registerUmamiCommands` +
  `getUmamiStatusSummary` export)
- Create: `packages/cli/src/commands/umami/status.ts` + `status.test.ts`
- Create: `packages/cli/src/commands/umami/deploy.ts` + `deploy.test.ts`
- Create: `packages/cli/src/commands/umami/logs.ts` + `logs.test.ts`
- Create: `packages/cli/src/commands/umami/host.ts` + `host.test.ts`
- Modify: `packages/cli/src/cli.ts` (register the barrel)
- Modify: `packages/cli/src/commands/mcp.ts` (add `umami status` to `MCP_ALLOWLIST`)
- Modify: `packages/cli/src/__snapshots__/cli.test.ts.snap` (help output)

**Approach:**
- `status.ts`: SSH `docker compose --project-directory /opt/umami ps --format json`, parse
  both JSON-array and NDJSON (PR #278), render service/state/health rows; thread `ActionCtx`
  for MCP capture; export `getUmamiStatusSummary(host)` for the unified rollup; an HTTP
  `/api/heartbeat` check may augment the summary. Action body is a named export delegating
  from `.action()`; try/catch routes failures to `ctx.console.error` with `ctx.process.exit(1)`
  outside the try (the MCP double-catch lesson).
- `deploy.ts`: default `gh workflow run "Deploy Umami" --repo marcusrbrown/infra` (requires
  `gh`); `--local` runs `bun run --cwd apps/umami deploy`; `--dry-run` prints the plan.
- `logs.ts`: SSH tail `docker compose logs`; refuse streaming under CI unless `--allow-ci`;
  always emit a sensitive-data stderr warning (mirror gateway `logs.ts`).
- `host.ts`: `validateUmamiHost` (CLI copy mirroring `packages/cli/src/commands/gateway/host.ts`),
  called in `status`/`logs` before SSH argv.
- Snapshot test normalizes the version string (`stdout.replace(/infra\/\d+\.\d+\.\d+/,
  'infra/x.x.x')`) and uses `NO_COLOR=1`.

**Execution note:** Test-first per command; mock `Bun.spawn`/`fetch` at the boundary.

**Patterns to follow:** `packages/cli/src/commands/gateway/` (all four files + barrel),
`packages/cli/src/commands/mcp.ts`, `packages/cli/src/lib/action-ctx.ts`.

**Test scenarios:**
- `status`: NDJSON output parsed → service rows; JSON-array output parsed; SSH failure →
  `ctx.console.error` + exit 1 (no throw); host validation rejects bad host before SSH;
  output flows through `ctx` (Tier-2 MCP capture).
- `deploy`: remote mode constructs `gh workflow run "Deploy Umami"`; `--local` constructs
  `bun run --cwd apps/umami deploy`; `--dry-run` prints without side effects; missing `gh` →
  clear error.
- `logs`: CI without `--allow-ci` → refuses; `--allow-ci` → proceeds; sensitive-data warning
  always emitted; host validated before SSH.
- `host`: same rejection/acceptance matrix as Unit 2.
- Help snapshot: includes `umami status`/`deploy`/`logs`; version normalized.

**Verification:** All command help responds; tests green; `umami status` appears as an MCP
tool when the allowlist is asserted.

- [ ] **Unit 6: Unified status rollup wiring**

**Goal:** `umami` appears in `bunx @marcusrbrown/infra status` (table + `--json`).

**Requirements:** R5

**Dependencies:** Unit 5 (`getUmamiStatusSummary`).

**Files:**
- Modify: `packages/cli/src/commands/status.ts`
- Modify: `packages/cli/src/commands/status.test.ts`
- Modify: `packages/cli/src/__snapshots__/` if the table snapshot changes

**Approach:** Extend `StatusSummary['app']` union with `'umami'`; add the
`getUmamiStatusSummary` import + `StatusDependencies` entry; add to the `Promise.allSettled`
array and the `appNames` array (order matters — append after gateway); extend `toJsonPayload`
with the `umami` key. Use `UMAMI_HOST` from env (mirroring `GATEWAY_HOST`).

**Patterns to follow:** the `gateway` wiring already present in `status.ts`.

**Test scenarios:**
- Happy path: all four apps resolve → table has a `umami` row; `--json` payload has a `umami`
  key.
- Error path: `umami` aggregator rejects → `errorSummary('umami', ...)` cell, other apps
  unaffected (graceful degradation).
- Edge case: `UMAMI_HOST` unset → umami row shows the not-configured error, not a crash.

**Verification:** `status` table + `--json` include `umami`; tests green.

- [ ] **Unit 7: Deploy workflow**

**Goal:** `.github/workflows/deploy-umami.yaml` deploys on push (path-filtered) or
`workflow_dispatch`, in the `umami` environment, with pinned host keys and explicit secrets.

**Requirements:** R8

**Dependencies:** Unit 3 (deploy target).

**Files:**
- Create: `.github/workflows/deploy-umami.yaml`
- Modify: `.github/known_hosts` (host-key block added at provision time, Unit 4 — committed
  before first CI deploy)

**Approach:** Mirror `.github/workflows/deploy-cliproxy.yaml`: SHA-pinned actions with
`# vX.Y.Z` comments; `dorny/paths-filter` with `predicate-quantifier: every` and a filter
matching `apps/umami/**` while excluding `apps/umami/**/*.md`, `**/*.test.ts`, `__fixtures__`,
`__snapshots__`; `environment: umami`; `cp .github/known_hosts ~/.ssh/known_hosts` (never
`ssh-keyscan`); `bun install --frozen-lockfile --ignore-scripts`; explicit secrets
(`UMAMI_SSH_KEY`, `UMAMI_HOST`, `UMAMI_APP_SECRET`, `UMAMI_DB_PASSWORD`, `UMAMI_ADMIN_PASSWORD`,
`DIGITALOCEAN_ACCESS_TOKEN` if needed); deploy condition `workflow_dispatch || umami-changed`.
No Node-24 pin (no lint/tsc step in a deploy workflow).

**Test scenarios:**
- Test expectation: none (workflow YAML) — validated by YAML parse + the executable
  conventions test (`.yaml` extension, SHA-pin, no `secrets: inherit`, no `ssh-keyscan` in CI,
  paths-filter quantifier guard all already enforced in `packages/cli/src/conventions.test.ts`).

**Verification:** `conventions.test.ts` passes (it scans all workflows); YAML parses; the
paths-filter quantifier guard is satisfied; a workflow-only change does not trigger the deploy
(quantifier correct).

- [ ] **Unit 8: Operator docs (`apps/umami/AGENTS.md`) + root AGENTS.md cross-reference**

**Goal:** Complete operator documentation for deploy, day-2 ops, privacy baseline, persistence,
and lifecycle.

**Requirements:** R2, R6, R7

**Dependencies:** Units 1–7 (documents their behavior).

**Files:**
- Modify: `apps/umami/AGENTS.md` (flesh out the Unit 1 placeholder)
- Modify: `AGENTS.md` (root — add umami to structure/where-to-look/commands/secrets)
- Modify: `packages/cli/AGENTS.md` if umami CLI conventions need a note

**Approach:** Cover: deploy flow (remote default + `--local`, the container-health gate +
bounded public-HTTPS warning), the automated admin-password rotation (deploy.ts rotates
`admin`/`umami` → `UMAMI_ADMIN_PASSWORD` over localhost; document that operators no longer log
in with defaults, and how to recover/re-rotate if needed), the privacy baseline
(`DISABLE_TELEMETRY=1`, `PRIVATE_MODE=1`, cookie-free + DNT defaults, the downstream tracker
tag with `data-do-not-track`/`data-exclude-search`/`data-exclude-hash`), Postgres
backup/restore runbook (`pg_dump` over SSH; named volume `umami-db-data`), **retention
policy** — state a concrete policy: either a defined retention window with a deletion
procedure, or an explicit, justified decision to retain indefinitely (not merely "indefinite
by default"), **secret rotation** — the **`ALTER USER` DB-password rotation runbook** (the
fingerprint guard refuses a naive rotation; the runbook is: deploy still on old secret → SSH
`ALTER USER umami WITH PASSWORD '<new>'` against the live DB → update the `UMAMI_DB_PASSWORD`
secret AND the droplet sentinel → redeploy), plus `APP_SECRET` rotation (invalidates
sessions) and `UMAMI_ADMIN_PASSWORD` rotation (re-run deploy or rotate in-app), and the
upgrade flow (bump the pinned image tag via Renovate → deploy; re-verify the auth-rotation API
shape on major bumps). Anti-patterns: never `docker compose down -v` (destroys the DB volume);
never rotate `UMAMI_DB_PASSWORD` outside the `ALTER USER` runbook; never put secrets in argv.
R6: document the exact Systematic docs `<script>` tag with the captured `data-website-id`
placeholder so the downstream task can drop it in.

**Test scenarios:**
- Test expectation: none (documentation) — but the plan-taxonomy grep gate and the
  no-secret-values rule apply: no `R[0-9]`/`Unit N` in shipped AGENTS.md prose, no real secret
  values.

**Verification:** Docs cover all R7 topics; `metrics.fro.bot` privacy defaults documented;
the script tag for the downstream consumer is present; grep-clean of secrets and plan
taxonomy.

## System-Wide Impact

- **Interaction graph:** New deploy workflow + new CLI command group + a new row in the unified
  `status` rollup. No change to keeweb/cliproxy/gateway behavior. `cli.ts` gains one more
  `register*Commands` call.
- **Error propagation:** deploy.ts must throw (fail the deploy) on health-gate failure, never
  report success on a booting/unreachable instance. CLI actions route operational failures
  through `ctx.console.error` + `ctx.process.exit(1)` (outside try) for MCP-visible content.
- **State lifecycle risks:** The Postgres volume `umami-db-data` is user data — the deploy must
  never `down -v`. The `UMAMI_DB_PASSWORD`↔volume coupling is the highest-risk footgun;
  documented as an anti-pattern with a migration runbook. First boot runs DB migrations
  (longer than cliproxy's boot — hence the 180s wait-timeout). The `UMAMI_DB_PASSWORD`↔volume
  coupling is guarded structurally by deploy.ts's fingerprint check (refuses a bricking
  rotation), not just documented.
- **API surface parity:** `umami status` joins `gateway status` as an MCP-capturable,
  ActionCtx-threaded, NDJSON-parsing command — same Tier-1/Tier-2 test bar.
- **Integration coverage:** First deploy is the real contract test (per both cascade docs) —
  expect multiple attempts; the health-gate + the conventions test + the boundary tests are the
  safety net.
- **Unchanged invariants:** No change to the published CLI runtime contracts of existing apps;
  the new commands are additive. `packages/shared/` helpers are reused, not modified. The
  unified `status` JSON gains a `umami` key (additive — existing consumers ignoring unknown
  keys are unaffected).

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| First-deploy cascade (lockfile, host keys, SSH key newline, readiness race) | High | Med | Bake every documented prevention into the units; treat first deploy as contract validation, expect 2-3 attempts (both cascade docs). |
| `UMAMI_DB_PASSWORD` rotated → Postgres volume auth break | Med | High | **Deploy-time fingerprint guard** in deploy.ts refuses the deploy when the secret no longer matches the volume's initialized password (hash sentinel on the droplet); rotation must go through the `ALTER USER` runbook (Unit 8) which updates both the role and the sentinel. Root-cause prevention, not docs-only. |
| `postgresql-v3.1.0` tag may not exist (docs show `postgresql-latest`) | Med | Low | Confirm at implementation; if absent, pin the specific digest of the v3.1.0 release image (never `latest@digest` — not equivalent to v3.1.0); document the exact digest. |
| UFW SSH rate-limit on multi-call deploy | Med | Med | ControlMaster multiplexing in deploy.ts from the start (gateway PR #277). |
| First-deploy public-HTTPS health check false-fails on Caddy ACME cert lag | Med | Med | Container-health (`compose --wait`) is the authoritative success signal; the public-HTTPS probe is a bounded retry that emits a WARNING (not a failure) on cert-issuance lag. `compose up` is idempotent. |
| First-boot DB migration exceeds wait-timeout | Med | Low | 180s timeout; container-health is the gate, not a fixed time; re-run is idempotent. |
| Public analytics endpoint exposed with default `admin`/`umami` creds | Med | High | **Automated post-deploy rotation** over the droplet localhost interface using `UMAMI_ADMIN_PASSWORD`; idempotent (skips if already rotated). Closes the takeover window without manual action. |
| Indefinite data retention drifts into a privacy liability | Low | Med | AGENTS.md states the retention policy explicitly; `PRIVATE_MODE`+`DISABLE_TELEMETRY` minimize collection; cookie-free + DNT by default. |

## Documentation / Operational Notes

- **No changeset** for most units — `apps/umami/`, workflows, and AGENTS.md don't affect the
  published `@marcusrbrown/infra` runtime. **Unit 5 (CLI commands) DOES ship in
  `packages/cli/src/` and is user-facing → it warrants a `minor` changeset** (new `umami`
  command surface). Unit 6 (status rollup) ships in the same changeset.
- **Operator prerequisites (Marcus owns, before first CI deploy):**
  1. Register an SSH key named `fro-bot-umami` with DigitalOcean.
  2. Run `apps/umami/server/provision-droplet.ts` (loads `.env` from CWD — run from repo root)
     → creates the droplet, pins host keys → commit `.github/known_hosts`.
  3. Configure DNS: `metrics.fro.bot` A record → droplet IP.
  4. Create the `umami` GitHub environment (reviewer `marcusrbrown`, `main` branch only).
  5. Set environment secrets: `UMAMI_SSH_KEY` (private key, trailing newline handled by
     deploy.ts), `UMAMI_HOST=metrics.fro.bot`, `UMAMI_APP_SECRET` (random hex),
     `UMAMI_DB_PASSWORD` (random — rotate only via the `ALTER USER` runbook), and
     `UMAMI_ADMIN_PASSWORD` (random — deploy.ts sets the Umami admin password to this over
     localhost). Add to `.env` locally too.
  6. First deploy → deploy.ts auto-rotates the default admin password to `UMAMI_ADMIN_PASSWORD`
     (no manual rotation needed). Log in with `admin` / `UMAMI_ADMIN_PASSWORD` to verify.
  7. Create the Systematic docs website in Umami → capture the `data-website-id` (R6).
- The `umami` environment secrets and the prerequisite list should land in root `AGENTS.md`
  notes alongside the existing keeweb/cliproxy/gateway secret documentation.

## Sources & References

- **Origin:** GitHub issue #315 + Fro Bot triage comment (4560738565).
- Repo patterns: `apps/cliproxy/` (Caddy+public-HTTP), `apps/gateway/` (provision/secret-file/
  CLI/ControlMaster), `packages/shared/server/droplet-helpers.ts`,
  `packages/cli/src/commands/gateway/`, `packages/cli/src/commands/status.ts`,
  `.github/workflows/deploy-cliproxy.yaml`.
- Learnings: `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`,
  `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`.
- Umami: v3.1.0 release, docs.umami.is (install, environment-variables, tracker-configuration,
  faq), official docker-compose.yml, `/api/heartbeat` route.
