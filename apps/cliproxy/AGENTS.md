# CLIProxyAPI Deploy Package

OAuth-authenticated Claude proxy at `cliproxy.fro.bot`. Docker Compose stack (Caddy + cli-proxy-api) on a DigitalOcean Droplet. CLI clients authenticate to the proxy with bearer API keys; the proxy forwards to Claude using stored OAuth tokens.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Config templates | `config/config.yaml`, `config/Caddyfile` | Server template — runtime keys live on the droplet |
| Docker stack | `docker-compose.yaml` | Caddy + cli-proxy-api, restart: unless-stopped, healthcheck on caddy probing `/healthz` |
| Provision droplet | `server/provision-droplet.ts` | One-time. Refuses re-run on existing droplet without `--force` |
| Deploy updates | `src/deploy.ts` | Preserves `config.yaml`, preflight management key check |
| CLI commands | `packages/cli/src/commands/cliproxy/` | See packages/cli/AGENTS.md for command pattern |

## DEPLOY FLOW

1. **Preflight** (`preflightManagementKeyCheck`): GET `/v0/management/config` with the local `CLIPROXY_MANAGEMENT_KEY`. Aborts on 401 (key drift), skips on missing key, fails on server errors. 10s fetch timeout.
2. **Upload**: `Caddyfile`, `docker-compose.yaml`, and `config.yaml` (only if it does not exist on the server). `--force-config` overrides the skip.
3. **Restart**: `docker compose pull && docker compose up -d` from `/opt/cliproxy/`.
4. **Model aliases** (`applyOAuthModelAliasStep`): read the `oauth-model-alias` block from the tracked `config.yaml` and PUT it to `/v0/management/oauth-model-alias` (bare object), then read back and fail-closed on mismatch. Skips when the block is empty; throws when the block is present but `CLIPROXY_MANAGEMENT_KEY` is unset. Fork verification via `/v1/models` is best-effort (only when `CLIPROXY_API_KEY` is set) and never fails the deploy. This never touches the runtime `api-keys`, so `--force-config` is not required.
5. **Health gate**: GET `/v0/management/config` again to confirm the proxy is up and the key still works.

**Critical**: `config.yaml` on the server holds runtime API keys added via the management API. The deploy must not overwrite it. The compound learning doc at `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` captures the original incident.

**Model aliasing**: the `oauth-model-alias` block in the tracked `config.yaml` maps client-facing short Anthropic model ids to their dated upstream models with `fork: true` (both ids stay available). It is applied via the management API (step 4), not by uploading `config.yaml` — the block does **not** make `--force-config` safe.

## DOCKER STACK

- **Caddy**: HTTPS termination, auto Let's Encrypt. `restart: unless-stopped`.
- **cli-proxy-api**: `eceasy/cli-proxy-api` v7.2.93 (pinned digest, Renovate-managed). Debian bookworm base (v7.1.54+, no wget/curl). `restart: unless-stopped`. No container healthcheck — the upstream Debian image ships no probe tools; Caddy probes the backend instead (see below).
- **Healthcheck**: lives on the `caddy` service, not `cli-proxy-api`. Caddy (alpine, has wget) runs `wget --spider -q http://cli-proxy-api:8317/healthz` across the compose network. `docker compose up -d --wait` gates on Caddy-healthy, which transitively proves the proxy is serving.
- **Volumes**: `caddy_data`, `caddy_config`, `cliproxy_auth` (OAuth tokens persist here across container recreates).
- **Env file**: `MANAGEMENT_PASSWORD` injected from host `.env` into the container.

## MANAGEMENT API

Verified endpoint surface (see `apps/cliproxy/src/deploy.ts` and `packages/cli/src/commands/cliproxy/`). Auth: `x-management-key` header **only**. The `Authorization: Bearer` header is for client API key auth (proxied requests to Claude), not management endpoints.

| Endpoint | Method | Body | Notes |
| --- | --- | --- | --- |
| `/v0/management/api-keys` | GET | — | Returns `{"api-keys": [...]}` (hyphenated) |
| `/v0/management/api-keys` | PUT | bare array `[...]` | NOT wrapped in `{api_keys: ...}` |
| `/v0/management/api-keys?value=x` | DELETE | — | |
| `/v0/management/config` | GET | — | Read-only via HTTP |
| `/v0/management/{field}` | PUT | `{"value": <val>}` | Per-field updates: `debug`, `request-retry`, `proxy-url`, etc. |
| `/v0/management/oauth-model-alias` | PUT | **bare object** `{claude: [...]}` | NOT wrapped in `{value: ...}` or `{oauth-model-alias: ...}` — those return 200 but store nothing. GET returns `{"oauth-model-alias": {...}}` |
| `/v0/management/usage-queue?count=N` | GET | — | v7: returns a **bare JSON array** of recent requests (not wrapped); `/v0/management/usage` was removed in v7 |
| `/v0/management/latest-version` | GET | — | Returns `{"latest-version": "vX.Y.Z"}` |
| `/healthz` | GET | — | Liveness endpoint, no auth; returns `{"status":"ok"}` |

## OPENCODE_CONFIG AND OPENCODE_AUTH_JSON SHAPES

The proxy uses a **single bearer key per consumer repo**. The same key authenticates both `anthropic` and `openai` provider routes for that repo — there are no per-provider keys.

For proxy-routed providers configured via `OPENCODE_CONFIG.provider.<name>.options.baseURL`, the `fro-bot/agent` action does **NOT** require `enable-omo: true` to honor the auth.json. Source: `fro-bot/agent@v0.44.3+` `action.yaml:99-104`. Librarian-verified 2026-05-25.

**Dual-provider `OPENCODE_CONFIG`:**

```json
{
  "provider": {
    "anthropic": {"options": {"baseURL": "https://cliproxy.fro.bot/v1"}},
    "openai":    {"options": {"baseURL": "https://cliproxy.fro.bot/v1"}}
  }
}
```

**Dual-provider `OPENCODE_AUTH_JSON`** (same proxy key for both providers):

```json
{
  "anthropic": {"type": "api", "key": "<proxy-key>"},
  "openai":    {"type": "api", "key": "<proxy-key>"}
}
```

Anthropic-only repos use the single-provider subset of these shapes (unchanged from pre-opt-in behavior).

## ANTI-PATTERNS

- **Never overwrite `config.yaml` on the server** without `--force-config` — it wipes runtime API keys (incident: 2026-04-06).
- **Never re-run `provision-droplet.ts` against an existing droplet** without `--force` — it overwrites the management key.
- **Never use `Authorization: Bearer` for management endpoints** — use `x-management-key`.
- **Never assume management API body shapes** — empirically verified, not guessed (incident: 2026-04-07).
- **v7 IP-bans the caller after 5 consecutive bad management-key attempts (~30 min).** Management flows probe `/v0/management/config` once before issuing parallel calls so a wrong key costs a single failed attempt, never an escalating burst.
- **Never commit `MANAGEMENT_PASSWORD`** — it lives in the droplet's `.env` and the local `CLIPROXY_MANAGEMENT_KEY` secret.
- **Never use `curl` in healthchecks** — only `wget` is in the Alpine base (Caddy image). The cli-proxy-api image (Debian bookworm, v7.1.54+) has no probe tools; healthcheck belongs on the caddy service.

## NOTES

- **Secrets**: `CLIPROXY_SSH_KEY`, `CLIPROXY_MANAGEMENT_KEY`, `CLIPROXY_DOMAIN` scoped to GitHub environment `cliproxy`. `DIGITALOCEAN_ACCESS_TOKEN` is repo-level.
- **Local `.env`**: `CLIPROXY_MANAGEMENT_KEY` must match the droplet's `MANAGEMENT_PASSWORD` (set during provisioning, printed once).
- **Provisioning SSH key**: `provision-droplet.ts` looks up the DigitalOcean SSH key by name. Default is `fro-bot-cliproxy`; override with `CLIPROXY_SSH_KEY_NAME` env var. Shared helper lives in `packages/shared/server/droplet-helpers.ts`.
- **Provisioning SSH auth**: when `CLIPROXY_SSH_KEY` is set, `provision-droplet.ts` materializes it to a `0600` temp key file and pins it with `-i` + `IdentitiesOnly=yes` (no ssh-agent needed; cleaned up after); when unset, it falls back to ssh-agent.
- **Run provisioning via the root wrapper**: `bun run provision:cliproxy` (loads the repo-root `.env`; `bun run --cwd apps/cliproxy provision` would miss it).
- **OAuth refresh**: Claude OAuth tokens auto-refresh in `cliproxy_auth` volume. Manual refresh: `bunx @marcusrbrown/infra cliproxy login claude`.
- **API key recovery**: There is no recovery tooling. If keys are wiped, regenerate via `cliproxy keys add` and redistribute. `cliproxy config get --output backup.json` (with `0600` perms) is the safest backup mechanism.

## ANTHROPIC AUTH MONITOR

The repository includes the CLI-only `infra cliproxy monitor` command and the scheduled workflow at `.github/workflows/cliproxy-auth-monitor.yaml`. The workflow runs at nominal 15-minute intervals (`7,22,37,52` minutes past each hour); GitHub schedule delivery is best-effort. Manual dispatch accepts `live`, `synthetic-dead`, or `synthetic-healthy` validation. Scheduled runs always use `live`.

The monitor probes the Anthropic route with `CLIPROXY_API_KEY`, then reconciles one canonical GitHub issue and a dedicated outbound Discord webhook. GitHub calls go through a `gh api` subprocess parsed with Zod — never a direct REST `fetch` — and the GitHub token is passed only through the child process's allowlisted environment, never argv, request body, or logs. An open issue represents dead provider auth; a closed or absent issue represents healthy auth. Discord messages are sent only on state transitions, with safe bounded summaries and a last-check heartbeat while an outage remains open. Public issue and Discord text is fixed and sanitized; raw provider responses and exception text never cross that boundary. Synthetic-mode Discord alerts are prefixed `[synthetic test]` so they are never mistaken for a real outage.

The dedicated label (`cliproxy-auth-monitor` / `cliproxy-auth-monitor-test`), not the hidden identity marker, is the trust anchor for issue adoption. An issue carrying the marker but not the label is ignored — the monitor never adopts it or restores the label onto it. An issue carrying the label but not the marker fails the run closed rather than being silently adopted. If a race produces more than one labeled+marked issue, resolution deterministically picks the lowest issue number so every later run converges on one canonical issue. GitHub's Issues API has no atomic create-if-absent primitive, so a rare simultaneous first-create can still send a duplicate initial alert; deterministic selection prevents that race from causing persistent reconciliation failure, but it does not eliminate the one-time duplicate.

`gh` is a prerequisite only when running `cliproxy monitor` directly on a local machine (it must be installed and authenticated, or `GITHUB_TOKEN` must be set). The scheduled workflow already provides `gh` in its runner image and remains the preferred entrypoint for both live and synthetic validation.

### Setup and validation

1. Create a dedicated Discord incoming webhook for monitor alerts. Do not reuse the gateway's inbound HMAC webhook. Test it with a fixed message, then store its URL as the repository secret `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK` without logging or copying the URL into a command argument.
2. Confirm the existing repository secret `CLIPROXY_API_KEY` is available. The canonical proxy URL is non-secret and defaults to `https://cliproxy.fro.bot`.
3. Run manual validation as the repository owner:

   ```bash
   gh workflow run cliproxy-auth-monitor.yaml -f validation=live
   gh workflow run cliproxy-auth-monitor.yaml -f validation=synthetic-dead
   gh workflow run cliproxy-auth-monitor.yaml -f validation=synthetic-healthy
   ```

   Confirm the live monitor summary proves the provider probe ran without creating an outage transition while auth is healthy. Synthetic validation uses the isolated test issue identity, never probes Anthropic, and never mutates production monitor state.

Go/no-go: enable unattended monitoring only when the workflow is on the default branch, `issues: write` is available, both repository secrets are present, the production canonical issue has at most one identity match, live validation is healthy, both synthetic transitions complete without touching production state, and GitHub workflow-failure notifications reach an operator.

### Recovery and rollback

When the provider is dead, run `bunx @marcusrbrown/infra cliproxy login claude`. After the browser reaches the localhost connection-refused page, copy the full callback URL and paste it into the login prompt. Verify with `bunx @marcusrbrown/infra cliproxy status`, then trigger an immediate manual live monitor run rather than waiting for the next scheduled invocation:

```bash
gh workflow run cliproxy-auth-monitor.yaml -f validation=live
```

Recovery is complete when the provider is healthy, the canonical issue is closed, the recovery notification is delivered when required, and the healthy marker is persisted.

To roll back monitoring, disable or revert `.github/workflows/cliproxy-auth-monitor.yaml`, or rotate/remove `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK` if the destination is wrong or exposed. Preserve the canonical issue history. Rollback stops monitor activity; it does not restore Claude authentication.
