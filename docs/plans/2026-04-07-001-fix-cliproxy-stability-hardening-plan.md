---
title: "fix: CLIProxyAPI stability hardening"
type: fix
status: completed
date: 2026-04-07
deepened: 2026-04-07
origin: Oracle E2E audit (session 2026-04-07) + incident: deploy wiped API keys
---

# fix: CLIProxyAPI Stability Hardening

## Overview

After the first cliproxy deploy-triggered outage (Renovate digest update wiped runtime API keys), two Oracle audits identified 9 gaps across deploy, provisioning, Docker config, CLI commands, and documentation. This plan addresses all P0–P3 items in a single PR.

## Problem Frame

The cliproxy stack has several reliability gaps discovered through an E2E audit after a production incident. The config template contains a predictable placeholder API key that becomes active on deploy. Docker services lack restart policies. The provision script can be rerun destructively. Deploy has no pre-flight validation of the management key. Documentation incorrectly describes auth headers.

## Requirements Trace

- P0a. Config template must not contain predictable placeholder keys
- P0b. Docker services must auto-restart after crashes or host reboots
- P1a. Provision script must refuse to overwrite a live droplet without explicit flag
- P1b. Deploy must validate management key before restarting containers
- P1c. AGENTS.md must accurately document management API auth headers
- P2a. CLI must support exporting live config for backup
- P2b. Docker Compose should define health checks for the proxy service
- P2c. Logs volume should be mountable for persistence
- P3a. Deploy health gate should use a self-contained endpoint, not one with external deps

## Scope Boundaries

- No changes to the CLI command structure (that's the zhuzh plan)
- No blue/green deployment — single-instance with brief restart window is acceptable
- No automatic management key rotation or sync
- No changes to the Fro Bot workflow or CI pipeline beyond what's in PR #56 and the health gate endpoint change in Unit 4
  - No API key recovery tooling — keys wiped by incidents must be re-added manually via `cliproxy keys add`

## Key Technical Decisions

- **Empty api-keys over placeholder**: `api-keys: []` is safer than `your-api-key-here` which becomes an active auth key if deployed. CLIProxyAPI starts fine with no keys — agents just can't auth until keys are added.
- **Health gate endpoint**: `/v0/management/config` is self-contained (no GitHub API call) vs `/latest-version` which depends on external API. Both require management key auth.
- **Provision guard**: Check `dropletExists()` and abort with clear message. Add `--force` flag for intentional reprovisioning.
- **Config backup via management API**: GET `/v0/management/config` returns full live config as JSON. No SSH needed — works from any authenticated client.

## Context & Research

### Relevant Code and Patterns

- `apps/cliproxy/config/config.yaml` — template with placeholders, mounted into container
- `apps/cliproxy/docker-compose.yaml` — Caddy + cli-proxy-api, named volumes, env_file
- `apps/cliproxy/src/deploy.ts` — deploy script with config preservation (PR #56)
- `apps/cliproxy/server/provision-droplet.ts` — one-time droplet provisioning
- `packages/cli/src/commands/cliproxy-config.ts` — config get/set commands
- `packages/cli/src/commands/cliproxy-status.ts` — status command with health checks
- `apps/cliproxy/AGENTS.md` — app-level knowledge base
- `.github/workflows/deploy.yaml` — CI deploy workflow (Unit 4 modifies health check step)

### Institutional Learnings

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — documents the deploy cascade that led to this audit

## Implementation Units

- [ ] **Unit 1: Remove placeholder API key and harden Docker Compose**

  **Goal:** Eliminate predictable auth key from template and add restart/health policies.

  **Requirements:** P0a, P0b, P2b, P2c

  **Dependencies:** None

  **Files:**
  - Modify: `apps/cliproxy/config/config.yaml`
  - Modify: `apps/cliproxy/docker-compose.yaml`

  **Approach:**
  - Replace `api-keys: ["your-api-key-here"]` with `api-keys: []`
  - Add `restart: unless-stopped` to both `caddy` and `cli-proxy-api` services
  - Add healthcheck to `cli-proxy-api` service using the root health endpoint (verified: `curl https://cliproxy.fro.bot/` returns 200 with `{"message":"CLI Proxy API Server"}`). Use `test: ["CMD", "wget", "--spider", "-q", "http://localhost:8317/"]` with interval 30s, timeout 5s, retries 3, start_period 10s (verified: `wget` available in Alpine 3.22 base image, `curl` is not; root `/` returns 200)
  - Add optional `cliproxy_logs` volume with comment showing how to enable if `logging-to-file` is turned on

  **Patterns to follow:**
  - KeeWeb uses explicit health check in deploy workflow; Docker-native healthcheck is the equivalent for Compose

  **Test scenarios:**
  - `docker compose config` validates the updated compose file
  - Template contains no non-empty api-keys entries

  **Verification:**
  - `grep -c 'your-api-key-here' apps/cliproxy/config/config.yaml` returns 0
  - `docker compose -f apps/cliproxy/docker-compose.yaml config` exits 0

- [ ] **Unit 2: Guard provision script against destructive reruns**

  **Goal:** Prevent accidental overwrite of a live droplet's config and secrets.

  **Requirements:** P1a

  **Dependencies:** None

  **Files:**
  - Modify: `apps/cliproxy/server/provision-droplet.ts`

  **Approach:**
  - After `dropletExists()` returns true, abort with clear message unless `--force` is in `process.argv`
  - Current behavior: logs "already exists — skipping creation" but **continues** to `copyComposeFiles` and `writeRemoteEnvFile`, which overwrites config and regenerates the management key
  - Fixed behavior: if droplet exists and no `--force`, exit after the skip message
  - With `--force`: warn that this will overwrite remote config/env, then proceed
  - After printing the generated management key, also print a reminder: "Save this key — it cannot be recovered. Set it as CLIPROXY_MANAGEMENT_KEY in GitHub secrets and local .env"

  **Patterns to follow:**
  - `deploy.ts` `--force-config` pattern for destructive override flags

  **Test scenarios:**
  - Rerun without `--force` when droplet exists → exits with message, no SSH commands
  - Rerun with `--force` → proceeds through full provisioning flow

  **Verification:**
  - Script exits 0 with informational message when droplet exists (no `--force`)
  - Script does not SSH, SCP, or write .env when droplet exists (no `--force`)

- [ ] **Unit 3: Pre-deploy management key validation**

  **Goal:** Fail fast before container restart if the management key is wrong or missing.

  **Requirements:** P1b

  **Dependencies:** None (the `/v0/management/config` management API endpoint exists independently of the Docker healthcheck added in Unit 1)

  **Files:**
  - Modify: `apps/cliproxy/src/deploy.ts`

  **Approach:**
  - After `mkdir -p` but before any file uploads, run an authenticated GET to `/v0/management/config` using `x-management-key` header
  - If `CLIPROXY_MANAGEMENT_KEY` env var is empty/unset → skip validation entirely with warning (first deploy has no key yet)
  - If key is present, send authenticated GET to `/v0/management/config`:
    - If 200 → proceed with deploy
    - If 401/403 → abort with "Management key is invalid. Verify CLIPROXY_MANAGEMENT_KEY matches MANAGEMENT_PASSWORD in the server's /opt/cliproxy/.env"
    - If other HTTP error (500, 502, 503) → abort with "Proxy is unhealthy, resolve before deploying"
    - If connection refused or fetch throws (ECONNREFUSED, DNS failure) → skip validation with warning (server not yet running)
  - Use a 10s timeout on the preflight fetch to avoid hanging on unresponsive servers
  - Error messages must never echo the management key value

  **Patterns to follow:**
  - `healthCheck()` in deploy.ts already does an authenticated GET; this is a pre-deploy version of the same pattern
  - Four branches: empty key (skip), network error (skip), auth error (abort), server error (abort)

  **Test scenarios:**
  - Valid key + healthy server → deploy proceeds
  - Invalid key → deploy aborts before any file upload or container restart
  - No container running (first deploy, ECONNREFUSED) → validation skipped with warning, deploy proceeds
  - Empty/unset CLIPROXY_MANAGEMENT_KEY → validation skipped entirely with warning
  - Set key but container reachable returning 401 → abort (key mismatch, not first deploy)
  - Server returns 500/502/503 → deploy aborts with "proxy unhealthy" message
  - Fetch times out after 10s → treated as network error, skip with warning

  **Verification:**
  - Deploy with wrong key aborts cleanly before `docker compose up`
  - Deploy with correct key proceeds normally

- [ ] **Unit 4: Improve deploy health gate endpoint**

  **Goal:** Use a self-contained health endpoint instead of one with external dependencies.

  **Requirements:** P3a

  **Dependencies:** None

  **Files:**
  - Modify: `apps/cliproxy/src/deploy.ts`
  - Modify: `.github/workflows/deploy.yaml`

  **Approach:**
  - Change health check from `/v0/management/latest-version` to `/v0/management/config`
  - `/latest-version` calls GitHub API externally; `/config` is local state only
  - Both require management key auth, both return 200 on success
  - Update both `deploy.ts` `healthCheck()` and `deploy.yaml` post-deploy curl step

  **Patterns to follow:**
  - Same pattern as existing health check, just different endpoint

  **Test scenarios:**
  - Health check passes when proxy is healthy
  - Health check fails when proxy is down or key is wrong

  **Verification:**
  - `curl -s -H "x-management-key: $KEY" https://cliproxy.fro.bot/v0/management/config | jq .debug` returns a value

- [ ] **Unit 5: Add `cliproxy config backup` CLI command**

  **Goal:** Enable exporting the full live config before risky operations.

  **Requirements:** P2a

  **Dependencies:** None

  **Files:**
  - Modify: `packages/cli/src/commands/cliproxy-config.ts`
  - Test: `packages/cli/src/commands/cliproxy-config.test.ts`

  **Approach:**
  - Add `--output <file>` option to existing `cliproxy config get` command instead of a separate `backup` subcommand (same functionality, smaller command surface)
  - When `--output` is specified, write JSON to file with 0600 permissions (owner-read-only) since output may contain API keys
  - When writing to stdout, print a warning: "Output may contain API keys — avoid logging or storing in shared locations"
  - Uses existing `requestJson()` pattern from `cliproxy-config.ts` (same module, no export needed)

  **Patterns to follow:**
  - `cliproxy config get` already fetches and prints the full config; `--output` adds file export

  **Test scenarios:**
  - `config get` to stdout outputs valid JSON with warning
  - `config get --output <file>` writes to file with 0600 permissions
  - `config get --output` with no management key throws helpful error

  **Verification:**
  - `bunx @marcusrbrown/infra cliproxy config get --key $KEY` outputs valid JSON
  - `bunx @marcusrbrown/infra cliproxy config get --key $KEY --output /tmp/backup.json` creates file with restricted permissions

- [ ] **Unit 6: Fix AGENTS.md auth documentation**

  **Goal:** Accurately document management API auth headers.

  **Requirements:** P1c

  **Dependencies:** None

  **Files:**
  - Modify: `apps/cliproxy/AGENTS.md`

  **Approach:**
  - Change "Auth: Bearer token or `x-management-key` header" to "Auth: `x-management-key` header (management key). `Authorization: Bearer` is for API key auth (client requests), not management endpoints."
  - This matches empirical testing: Bearer with management key → 401, x-management-key → success
  - Also remove vestigial `Authorization: Bearer` line from `managementHeaders()` in `cliproxy-config.ts` — management endpoints only accept `x-management-key`
  - Grep all CLI source files for Bearer usage on management endpoints to confirm no other instances

  **Files:**
  - Modify: `apps/cliproxy/AGENTS.md`
  - Modify: `packages/cli/src/commands/cliproxy-config.ts` (remove Bearer from `managementHeaders()`)

  **Patterns to follow:**
  - Root AGENTS.md convention of being precise about auth scopes

  **Test scenarios:**
  - Management requests send only `x-management-key`, not `Authorization: Bearer`

  **Verification:**
  - No mention of "Bearer token" as equivalent to management key auth in cliproxy docs
  - `grep -r 'authorization.*Bearer' packages/cli/src/commands/cliproxy-*.ts` returns no management-endpoint hits

- [ ] **Unit 7: Changeset and snapshot updates**

  **Goal:** Version bump and test snapshot regeneration.

  **Requirements:** All

  **Dependencies:** Units 1–6

  **Files:**
  - Create: `.changeset/cliproxy-stability-hardening.md`
  - Modify: `packages/cli/src/__snapshots__/cli.test.ts.snap` (if help text changes)

  **Approach:**
  - Patch changeset describing the stability hardening
  - Regenerate snapshots if `config backup` subcommand changes help output
  - Run full test suite: `bun test --recursive`

  **Verification:**
  - `bun run lint` → 0 errors
  - `bunx tsc --noEmit` → clean
  - `bun test --recursive` → all pass

## System-Wide Impact

- **Config template change**: First deploy to a new server will start with empty API keys. Operator must add keys via `cliproxy keys add` after initial deploy. Agents cannot auth until keys are added — this is intentional (no predictable placeholder to exploit).
- **Restart policy**: Services will auto-restart after droplet reboot. Previously required manual `docker compose up -d`. Docker daemon auto-starts on boot (DigitalOcean Docker image default).
- **Provision guard**: Anyone rerunning `bun run provision` against the live droplet will get a clear stop instead of silent overwrite. This changes the current behavior where provision continues past droplet creation into config upload and env file rewrite.
- **Health gate change**: If GitHub API is down, deploys will no longer falsely fail the health check.
- **In-flight requests during restart**: `docker compose up -d` recreates the container. During the ~2-5s window between old container stop and new container ready, Caddy returns 502 to upstream requests. This is acceptable for a single-instance personal proxy. No mitigation needed unless traffic patterns change.
- **Pre-deploy validation adds a new failure mode**: If the management key secret drifts from the server's MANAGEMENT_PASSWORD, deploys will now fail fast (before restart) instead of succeeding-then-failing-health-check. This is strictly better — the operator gets a clear error before any state changes.

## Risks & Dependencies

- **Empty api-keys on first deploy**: Agents can't auth until keys are added. This is intentional — better than a predictable placeholder being active. Mitigation: `cliproxy setup` wizard (planned in CLI zhuzh) will prompt for key creation post-deploy.
- **Healthcheck `wget`**: Verified available in Alpine 3.22 base image. Risk eliminated.
- **Config backup is read-only**: It exports current state but doesn't provide a restore path. Restore requires `cliproxy config set` per field or `--force-config` deploy with a manually edited template. A future `cliproxy config restore` command could close this gap but is out of scope.
- **Management key drift**: The provision script generates a random key and prints it once. If the operator doesn't save it or sets the wrong value as the GitHub secret, CI deploys will now fail at pre-flight validation (Unit 3) instead of silently deploying and failing the post-deploy health check. Mitigation: the pre-flight error message must include instructions to verify the key matches the server's `.env`. Note: `CLIPROXY_MANAGEMENT_KEY` (GitHub Actions secret / local env) must match `MANAGEMENT_PASSWORD` in the server's `/opt/cliproxy/.env` (the env var name used by CLIProxyAPI's Docker Compose).
- **Provision script `ssh-keyscan`**: The provision script uses `ssh-keyscan` and `StrictHostKeyChecking=accept-new` for initial host key pinning (Trust On First Use). This is acceptable for manual bootstrap from a trusted network but should not be used in CI. The pinned keys are committed to `.github/known_hosts` after provisioning, and all subsequent connections use those pinned keys.

## Sources & References

- **Incident**: Deploy wiped API keys via config.yaml overwrite (2026-04-07)
- **Compound learning**: `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`
- **Oracle audit**: Session 2026-04-07 (two consultations covering deploy, provision, CLI, Docker)
- Related PRs: #56 (config preservation fix), #48 (management API audit)
