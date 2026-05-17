---
title: "feat: Add CLIProxyAPI deployment and management"
type: feat
status: completed
date: 2026-04-03
deepened: 2026-04-03
completed: 2026-04-06
origin: docs/brainstorms/2026-04-03-cliproxy-deployment-requirements.md
---

# feat: Add CLIProxyAPI deployment and management

> **Status note (reconciled 2026-05-18):** All 8 units shipped through PR #23 (initial 8-unit implementation) followed by remediation PRs #37 (CLIPROXY_HOST → CLIPROXY_DOMAIN), #38 (pinned host keys), #39 (auth-dir config). First successful deploy on 2026-04-06; documented in `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`. Subsequent stability/feature work is tracked in `docs/plans/2026-04-07-001-fix-cliproxy-stability-hardening-plan.md` and the CLI zhuzh plan; do not extend this plan further.


## Overview

Deploy CLIProxyAPI to a Digital Ocean Droplet via Docker Compose, add CLI management commands, and integrate with Fro Bot agent instances so they can access Claude models via the proxy's API keys.

## Problem Frame

Fro Bot agent instances in GitHub Actions can't do Claude Code OAuth browser flows. Marcus's Claude Pro Max20 subscription is the upstream source but headless agents can't authenticate. CLIProxyAPI bridges this gap by holding OAuth tokens server-side and presenting standard API keys to clients. (see origin: docs/brainstorms/2026-04-03-cliproxy-deployment-requirements.md)

## Requirements Trace

- R1. Deploy CLIProxyAPI to a DO Droplet using Docker Compose with persistent volumes
- R2. TLS via Caddy reverse proxy with automatic Let's Encrypt certificates + management key for remote Management API
- R3. Claude Code OAuth authentication with persistent refresh tokens
- R4. Proxy API key management for Fro Bot instances
- R5. `apps/cliproxy/` app following existing monorepo conventions
- R6. CLI commands under `infra cliproxy` namespace:
  - R6a. `cliproxy status` — health check (HTTP reachability, usage stats, version) (Unit 4)
  - R6b. `cliproxy deploy` — provision or update the droplet + Docker Compose stack (Unit 5)
  - R6c. `cliproxy config` — get/set configuration via Management API (Unit 6)
  - R6d. `cliproxy keys` — CRUD proxy API keys via Management API (Unit 6)
  - R6e. `cliproxy login` — trigger Claude Code OAuth flow on server (Unit 6)
- R7. Management API accessible to external frontends (Quotio) via HTTPS
- R8. GitHub Actions workflow for cliproxy deployment
- R9. Org-level secrets distribution for Fro Bot integration

## Scope Boundaries

- Claude Code provider only (v1). Other providers addable via config later.
- Single droplet. No HA, no multi-region.
- Official Docker image `eceasy/cli-proxy-api:latest` — no source modifications.
- No Web UI or Desktop GUI deployment.
- No automated token refresh monitoring — manual re-login when needed.

## Context & Research

### Relevant Code and Patterns

- `apps/keeweb/package.json` — app package structure (name, private, scripts for build/deploy)
- `apps/keeweb/deploy.sh` — SSH/rsync deploy script with `--nginx` flag pattern (legacy Bash — new scripts must be TypeScript)
- `apps/keeweb/server/setup-deploy-user.ts` — TypeScript server provisioning over SSH
- `packages/cli/src/cli.ts` — goke CLI with `registerXxx(cli)` pattern for command registration
- `packages/cli/src/commands/keeweb-status.ts` — health check pattern (HTTP, gh CLI, SHA-256)
- `packages/cli/src/commands/keeweb-deploy.ts` — deploy with `--local`/`--dry-run` flags, env allowlist
- `.github/workflows/deploy.yaml` — dorny/paths-filter for per-app change detection

### Institutional Learnings

- `docs/solutions/workflow-issues/bun-deploy-user-permissions-ci-2026-04-02.md` — use `--ignore-scripts` in CI, `--no-times --no-perms` for rsync to non-root dirs, 775+setgid for group-writable dirs

### External References

- CLIProxyAPI docs: https://help.router-for.me/
- Management API: https://help.router-for.me/management/api.html — full REST at `/v0/management/*` with bearer token auth
- Docker Compose: https://help.router-for.me/docker/docker-compose.html — official image `eceasy/cli-proxy-api:latest`, port 8317
- Claude Code provider: `--claude-login` with `--no-browser` for headless environments, OAuth on port 54545

## Key Technical Decisions

- **Caddy over native TLS**: Brainstorm suggested native TLS on CLIProxyAPI. Planning overrides this — Caddy as reverse proxy in Docker Compose provides automatic Let's Encrypt cert provisioning and renewal with zero manual cert management. CLIProxyAPI stays on localhost:8317, Caddy terminates HTTPS on port 443. Alternatives considered:
  - *CLIProxyAPI native TLS* (`tls.enable: true` in config.yaml): requires manually provisioning certs and setting up renewal (certbot cron). More operational burden, no auto-renewal.
  - *nginx reverse proxy*: requires separate config, manual cert renewal via certbot. Caddy does the same with less config and auto-renewal built in.
  - *Caddy* (chosen): single Caddyfile, auto Let's Encrypt via HTTP-01 challenge, cert renewal handled internally. Standard Docker Compose pattern — `caddy:2-alpine` image, volumes for `/data` (certs) and `/config`. Upstream referenced by Docker Compose service name (`cli-proxy-api:8317`).
- **SSH-based deploy (like keeweb)**: Provision droplet once via `doctl compute droplet create` (DO Docker marketplace image, Docker pre-installed), then deploy/update via SSH + `docker compose up -d`. Matches existing infra pattern. Alternative: DO App Platform — rejected because it doesn't provide SSH access needed for `--claude-login` OAuth flow.
- **`--no-browser` OAuth login**: Run `docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --no-browser --claude-login` on the server via SSH. It prints a URL — complete the OAuth flow in a local browser. Tokens persist in a named Docker volume (`cliproxy-auth` → `/root/.cli-proxy-api`). Alternative: SSH tunnel to port 54545 — rejected as unnecessarily complex; `--no-browser` URL approach is simpler and officially supported.
- **`MANAGEMENT_PASSWORD` env var over config-file secret-key**: Use Docker Compose `environment:` to set `MANAGEMENT_PASSWORD`. This keeps the secret in memory only (never persisted to disk), forces remote management enabled, and works cleanly with Docker secret injection. The config.yaml `remote-management.secret-key` field stays empty in the tracked template.
- **Separate deploy job in existing workflow**: Add `deploy-cliproxy` job to `deploy.yaml` with its own paths-filter, mirroring the `deploy-keeweb` job pattern. Jobs are independent — no ordering dependency between keeweb and cliproxy deploys.
- **Management API as the CLI backend**: All `cliproxy config`, `cliproxy keys`, and `cliproxy status` commands use the Management API over HTTPS — no SSH required for day-to-day operations. Only `cliproxy login` requires SSH (for running the OAuth flow inside the container).
- **Domain**: Needs a subdomain (e.g., `proxy.heatvision.co` or similar) pointing to the DO Droplet's IP for Caddy's Let's Encrypt cert. DNS must be configured before first deploy — Caddy will fail to obtain certs if the domain doesn't resolve to the droplet.

## Open Questions

### Resolved During Planning

- **TLS approach**: Caddy reverse proxy in Docker Compose (see decision above)
- **OAuth login mechanism**: `--no-browser` + URL printout. No SSH tunnel needed.
- **Deploy mechanism**: SSH + docker compose, matching keeweb pattern
- **Workflow structure**: Separate job in existing `deploy.yaml`
- **Token lifecycle**: CLIProxyAPI handles refresh automatically. Re-login only when token is revoked or subscription lapses.

- **Management key approach**: Resolved — use `MANAGEMENT_PASSWORD` env var in Docker Compose `environment:` block. Memory-only (never persisted to disk), forces remote management enabled, works cleanly with Docker secret injection.

### Deferred to Implementation

- **Exact DO Droplet spec**: Size, region — depends on pricing check at implementation time. Start with `s-1vcpu-1gb` (~$6/mo). Verify current Docker marketplace image slug via `doctl compute droplet 1-click list`.
- **Domain/subdomain choice**: Needs DNS setup. Could use `proxy.heatvision.co`, `cliproxy.heatvision.co`, or a new domain. Must resolve to droplet IP before first Caddy deploy.
- **Firewall rules**: Whether to use DO's built-in firewall or `ufw` on the droplet. Either works — decide at implementation time. Must allow ports 80 (ACME), 443 (HTTPS), and 22 (SSH).

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
┌─────────────────────────────────────────────────┐
│                  DO Droplet                       │
│                                                   │
│  ┌──────────┐     ┌──────────────────────────┐   │
│  │  Caddy    │────▶│   CLIProxyAPI             │   │
│  │  :443     │     │   localhost:8317          │   │
│  │  (TLS)    │     │                          │   │
│  └──────────┘     │  Management API :8317     │   │
│       ▲            │  /v0/management/*         │   │
│       │            │                          │   │
│       │            │  Claude OAuth tokens      │   │
│       │            │  (Docker volume)          │   │
│       │            └──────────────────────────┘   │
│       │                                           │
└───────┼───────────────────────────────────────────┘
        │
        │ HTTPS
        │
┌───────┴────────┐     ┌────────────────┐
│ Fro Bot agents │     │ infra CLI      │
│ (GH Actions)   │     │ (local)        │
│ → API keys     │     │ → mgmt key     │
└────────────────┘     └────────────────┘
```

**Docker Compose stack:**
- `caddy` — reverse proxy, auto TLS, ports 80/443
- `cli-proxy-api` — official image, port 8317 (internal only)
- Volumes: `cliproxy-auth` (OAuth tokens), `cliproxy-config` (config.yaml), `caddy-data` (certs)

**CLI commands hit the Management API over HTTPS:**
- `status` → `GET /v0/management/usage` + HTTP health check
- `config` → `GET/PUT /v0/management/config`
- `keys` → `GET/PUT/PATCH/DELETE /v0/management/api-keys`
- `login` → SSH into droplet, `docker compose exec ... --claude-login`
- `deploy` → SSH into droplet, `docker compose pull && docker compose up -d`

## Implementation Units

- [ ] **Unit 1: App scaffolding and Docker Compose stack**

**Goal:** Create `apps/cliproxy/` with package structure, config templates, and Docker Compose definition.

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**
- Create: `apps/cliproxy/package.json`
- Create: `apps/cliproxy/config/config.yaml` (template with empty secrets)
- Create: `apps/cliproxy/config/Caddyfile`
- Create: `apps/cliproxy/docker-compose.yaml`
- Create: `apps/cliproxy/AGENTS.md`

**Approach:**
- `package.json` follows keeweb pattern: `@marcusrbrown/infra-cliproxy`, private, scripts for deploy/status
- `config.yaml` template with Claude provider enabled, empty API keys, `allow-remote: true`, empty `secret-key` (injected at deploy time)
- `Caddyfile` reverse-proxies `{$CLIPROXY_DOMAIN}` to `localhost:8317`
- `docker-compose.yaml` with `caddy` (caddy:2-alpine) and `cli-proxy-api` (eceasy/cli-proxy-api:latest) services, named volumes for auth/config/certs
- No real secrets in tracked files — all injected via env vars or deploy-time config

**Patterns to follow:**
- `apps/keeweb/package.json` for package structure
- `apps/keeweb/config/` for config template pattern

**Test scenarios:**
- `docker compose config` validates the compose file
- Config template parses as valid YAML
- Caddyfile syntax is valid

**Verification:**
- `docker compose config` exits 0
- All template files exist and parse correctly

- [ ] **Unit 2: Server provisioning script**

**Goal:** Create a TypeScript provisioning script that sets up a DO Droplet for CLIProxyAPI.

**Requirements:** R1, R3

**Dependencies:** Unit 1

**Files:**
- Create: `apps/cliproxy/server/provision-droplet.ts`

**Approach:**
- TypeScript Bun script (like `apps/keeweb/server/setup-deploy-user.ts`)
- Uses `doctl` CLI for droplet creation: `doctl compute droplet create cliproxy --image docker-20-04 --size s-1vcpu-1gb --region nyc1 --ssh-keys <fingerprint>` (verify slug via `doctl compute droplet 1-click list`)
- Idempotent: check `doctl compute droplet list --format Name` before creating
- SSH key: register via `doctl compute ssh-key list` or create new; pass fingerprint to `--ssh-keys`
- Optional cloud-init via `--user-data-file` for initial Docker Compose setup
- Copies Docker Compose files and config via SCP after droplet is ready
- Runs `docker compose up -d` via SSH
- Generates a strong management key (random hex), prints it, and sets as `MANAGEMENT_PASSWORD` in compose env

**Patterns to follow:**
- `apps/keeweb/server/setup-deploy-user.ts` for SSH-over-Bun.spawn pattern

**Test scenarios:**
- Script validates `doctl` is installed and authenticated
- Idempotent: running twice doesn't create duplicate droplets
- SSH connectivity verified before file transfer

**Verification:**
- Script runs without error on a fresh invocation
- Droplet is created and accessible via SSH
- Docker Compose stack is running

- [ ] **Unit 3: Deploy script**

**Goal:** Create a deploy script for updating the CLIProxyAPI stack on the droplet.

**Requirements:** R1, R5

**Dependencies:** Unit 1, Unit 2

**Files:**
- Create: `apps/cliproxy/src/deploy.ts`

**Approach:**
- TypeScript Bun script (all new scripts must be TypeScript — `apps/keeweb/deploy.sh` is legacy)
- SCPs updated config files (docker-compose.yaml, Caddyfile, config.yaml) to droplet via `Bun.spawn` + scp
- Runs `docker compose pull && docker compose up -d` via SSH (`Bun.spawn` + ssh)
- Post-deploy health check via `fetch()` to the HTTPS endpoint
- Takes `CLIPROXY_HOST` from environment, requires `SSH_AUTH_SOCK` (ssh-agent)
- Explicit env allowlist for subprocess (matching keeweb-deploy.ts security pattern)
- No `--nginx` equivalent needed — Caddy config is always deployed with the stack

**Patterns to follow:**
- `apps/keeweb/server/setup-deploy-user.ts` for SSH-over-Bun.spawn pattern
- `packages/cli/src/commands/keeweb-deploy.ts` for env allowlist and precondition validation

**Note:** `apps/keeweb/deploy.sh` is legacy Bash from the initial repo creation. All new scripts in the infra repo must be TypeScript run via `bun run`.

**Test scenarios:**
- `bash -n deploy.sh` validates syntax
- Deploy updates running containers without downtime (docker compose up -d is rolling)
- Health check catches failed deployments

**Verification:**
- `bash -n deploy.sh` exits 0
- Post-deploy health check returns 200

- [ ] **Unit 4: CLI `cliproxy status` command**

**Goal:** Add `infra cliproxy status` command that reports proxy health and usage stats.

**Requirements:** R6a

**Dependencies:** Unit 1 (for endpoint/config), existing CLI scaffolding

**Files:**
- Create: `packages/cli/src/commands/cliproxy-status.ts`
- Modify: `packages/cli/src/cli.ts` (add import + register call)

**Approach:**
- `registerCliproxyStatus(cli)` function following keeweb-status.ts pattern
- Three checks: HTTP reachability (HTTPS endpoint), usage stats (`GET /v0/management/usage`), version check (`GET /v0/management/latest-version`)
- Requires `CLIPROXY_URL` and `CLIPROXY_MANAGEMENT_KEY` env vars (or `--url` / `--key` options)
- Formatted output matching keeweb status style (OK/WARN/ERROR levels)

**Patterns to follow:**
- `packages/cli/src/commands/keeweb-status.ts` for check structure, output formatting
- goke command registration with Zod schemas

**Test scenarios:**
- Reachable endpoint: shows OK with usage stats
- Unreachable endpoint: shows ERROR with timeout
- Invalid management key: shows ERROR with 401/403

**Verification:**
- `infra cliproxy status --help` shows correct options
- tsc + lint clean

- [ ] **Unit 5: CLI `cliproxy deploy` command**

**Goal:** Add `infra cliproxy deploy` command for updating the proxy stack.

**Requirements:** R6b

**Dependencies:** Unit 3 (deploy.sh), existing CLI scaffolding

**Files:**
- Create: `packages/cli/src/commands/cliproxy-deploy.ts`
- Modify: `packages/cli/src/cli.ts` (add import + register call)

**Approach:**
- `registerCliproxyDeploy(cli)` following keeweb-deploy.ts pattern
- Default mode: trigger deploy workflow via `gh workflow run` (like keeweb remote deploy)
- `--local` flag: run deploy.sh directly via Bun.spawn with SSH_AUTH_SOCK check
- `--dry-run` flag: validate preconditions only
- Env allowlist for local deploy (matching keeweb security pattern)

**Patterns to follow:**
- `packages/cli/src/commands/keeweb-deploy.ts` for remote/local modes, env allowlist

**Test scenarios:**
- Remote deploy: triggers workflow via gh CLI
- Local deploy: validates SSH_AUTH_SOCK, runs deploy.sh
- Dry run: prints planned actions without executing

**Verification:**
- `infra cliproxy deploy --help` shows correct options
- tsc + lint clean

- [ ] **Unit 6: CLI management commands (config, keys, login)**

**Goal:** Add `infra cliproxy config`, `infra cliproxy keys`, and `infra cliproxy login` commands.

**Requirements:** R6c, R6d, R6e, R7

**Dependencies:** Unit 4 (shares URL/key config pattern)

**Files:**
- Create: `packages/cli/src/commands/cliproxy-config.ts`
- Create: `packages/cli/src/commands/cliproxy-keys.ts`
- Create: `packages/cli/src/commands/cliproxy-login.ts`
- Modify: `packages/cli/src/cli.ts` (add imports + register calls)

**Approach:**
- **config**: `cliproxy config get` → `GET /v0/management/config`, `cliproxy config set <key> <value>` → hit appropriate endpoint. Start with get/set for common fields (debug, request-retry, proxy-url).
- **keys**: `cliproxy keys list` → `GET /v0/management/api-keys`, `cliproxy keys add <key>` → `PUT`, `cliproxy keys remove <key>` → `DELETE`. Space-separated subcommands via goke.
- **login**: `cliproxy login claude` → SSH into droplet, exec `--no-browser --claude-login` in container, print OAuth URL for local browser completion. Requires `CLIPROXY_HOST` env var or `--host` option.
- All management commands share URL/key configuration pattern from Unit 4

**Patterns to follow:**
- goke space-separated subcommands (`cliproxy config get`, `cliproxy keys list`)
- Management API bearer token auth via `Authorization: Bearer <key>`

**Test scenarios:**
- `keys list` returns current API keys
- `keys add` creates a new key, `keys remove` deletes it
- `config get` returns full config JSON
- `login claude` prints OAuth URL when connected

**Verification:**
- All commands show correct `--help` output
- tsc + lint clean

- [ ] **Unit 7: GitHub Actions deploy workflow**

**Goal:** Add cliproxy deployment to the GitHub Actions deploy workflow.

**Requirements:** R8

**Dependencies:** Unit 1, Unit 3

**Files:**
- Modify: `.github/workflows/deploy.yaml`

**Approach:**
- Add `cliproxy` filter to `detect-changes` job: `'apps/cliproxy/**'`
- Add `deploy-cliproxy` job mirroring `deploy-keeweb` structure
- Uses `cliproxy` environment (new GitHub Environment with required reviewers)
- Steps: checkout → setup Bun → install → setup SSH → run deploy.sh → health check
- Secrets: `CLIPROXY_SSH_KEY`, `CLIPROXY_MANAGEMENT_KEY`, `CLIPROXY_DOMAIN`
- Trigger: `workflow_dispatch || cliproxy-changed`

**Patterns to follow:**
- `deploy-keeweb` job for structure, SSH setup, environment protection

**Test scenarios:**
- Changes to `apps/cliproxy/**` trigger the deploy job
- `workflow_dispatch` triggers deploy
- Health check validates deployment succeeded

**Verification:**
- YAML validates (`python -c "import yaml; yaml.safe_load(open(...))"`)
- Workflow structure matches existing patterns

- [ ] **Unit 8: Documentation and secrets distribution**

**Goal:** Update AGENTS.md, README, and document Fro Bot secret distribution.

**Requirements:** R9, R5

**Dependencies:** All other units

**Files:**
- Modify: `AGENTS.md` (add cliproxy to structure and where-to-look)
- Modify: `README.md` (add cliproxy section, new secrets, new workflow)
- Create: `apps/cliproxy/AGENTS.md`

**Approach:**
- Root AGENTS.md: add `apps/cliproxy/` to structure, add cliproxy commands to commands section
- README: add CLIProxyAPI section with deploy/manage instructions, add new secrets table entries
- cliproxy AGENTS.md: document Docker Compose stack, config template, deploy flow, Management API patterns
- Document Fro Bot integration: set `CLIPROXY_URL` and `CLIPROXY_API_KEY` as org-level secrets, configure in Fro Bot workflow env

**Patterns to follow:**
- Existing AGENTS.md hierarchy (root → app-specific)
- README structure (apps section, CI/CD secrets table)

**Test scenarios:**
- No broken links in docs
- All referenced paths exist

**Verification:**
- lint clean on all markdown files

## System-Wide Impact

- **New GitHub Environment**: `cliproxy` environment with required reviewers, separate from `production` (keeweb). New secrets: `CLIPROXY_SSH_KEY`, `CLIPROXY_MANAGEMENT_KEY`, `CLIPROXY_DOMAIN`.
- **Deploy workflow expansion**: `deploy.yaml` grows from 1 deploy job to 2. `detect-changes` outputs expand with new filter. No conflict — jobs are independent.
- **CLI package expansion**: 5 new command files added to `packages/cli/src/commands/`. All follow existing registration pattern. MCP bridge (`@goke/mcp`) automatically exposes new commands — no per-command wiring needed.
- **npm package**: New commands ship with next `@marcusrbrown/infra` release via Changesets.
- **Fro Bot**: Repos using the proxy need `CLIPROXY_URL` and `CLIPROXY_API_KEY` org secrets. Existing `OPENCODE_AUTH_JSON` secrets remain — proxy is additive, not a replacement.

## Risks & Dependencies

- **CLIProxyAPI stability**: Depends on `eceasy/cli-proxy-api:latest` being stable. Mitigation: pin to a specific tag (e.g., `eceasy/cli-proxy-api:v1.x.y`) after initial deployment. Use `GET /v0/management/latest-version` in `cliproxy status` to detect when updates are available.
- **OAuth token lifecycle**: CLIProxyAPI auto-refreshes access tokens via `RefreshTokensWithRetry` with exponential backoff (`internal/auth/claude/anthropic_auth.go`). However, non-retryable failures (token reuse, revocation, `refresh_token_reused` error) require manual re-login. Known issues: [#1999](https://github.com/router-for-me/CLIProxyAPI/issues/1999), [#2385](https://github.com/router-for-me/CLIProxyAPI/issues/2385). Mitigation: `cliproxy status` should check for recent failed requests in usage stats (`failure_count > 0`). If Claude requests start failing, run `infra cliproxy login claude`.
- **Subscription lapse**: If Claude Pro Max20 subscription lapses, OAuth tokens become invalid. All Fro Bot instances lose Claude access. Mitigation: agents fall back to OpenCode free models automatically. Re-subscribe + `cliproxy login claude` to restore.
- **DO Droplet availability**: Single point of failure. Acceptable for v1 — agents fall back to OpenCode free models. Mitigation: add Fro Bot autohealing check for cliproxy endpoint reachability (extend daily schedule prompt).
- **Docker networking**: Both services must share a Docker Compose network for Caddy to reach `cli-proxy-api:8317` by service name. The default `docker compose` network handles this — no custom network config needed. CLIProxyAPI must NOT expose port 8317 to the host (only Caddy's 80/443 are exposed).
- **DNS prerequisite**: Caddy's HTTP-01 ACME challenge requires the domain to resolve to the droplet's public IP. Let's Encrypt will reject cert requests if DNS isn't configured. This is a hard prerequisite before first deploy — document in the provisioning script output.
- **Management API rate limiting**: 5 consecutive auth failures from a remote IP trigger a ~30-minute ban. Mitigation: validate management key in `cliproxy status` before other management commands. Don't retry with bad keys.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-03-cliproxy-deployment-requirements.md](docs/brainstorms/2026-04-03-cliproxy-deployment-requirements.md)
- CLIProxyAPI repo: https://github.com/router-for-me/CLIProxyAPI
- CLIProxyAPI docs: https://help.router-for.me/
- Management API: https://help.router-for.me/management/api.html
- Docker Compose: https://help.router-for.me/docker/docker-compose.html
- Claude Code provider: https://help.router-for.me/configuration/provider/claude-code.html
- Existing deploy workflow: `.github/workflows/deploy.yaml`
- Existing CLI patterns: `packages/cli/src/commands/keeweb-*.ts`
