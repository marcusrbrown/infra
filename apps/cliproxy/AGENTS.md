# CLIProxyAPI Deploy Package

OAuth-authenticated Claude proxy at `cliproxy.fro.bot`. Docker Compose stack (Caddy + cli-proxy-api) on a DigitalOcean Droplet. CLI clients authenticate to the proxy with bearer API keys; the proxy forwards to Claude using stored OAuth tokens.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Config templates | `config/config.yaml`, `config/Caddyfile` | Server template — runtime keys live on the droplet |
| Docker stack | `docker-compose.yaml` | Caddy + cli-proxy-api, restart: unless-stopped, healthcheck on `/healthz` |
| Provision droplet | `server/provision-droplet.ts` | One-time. Refuses re-run on existing droplet without `--force` |
| Deploy updates | `src/deploy.ts` | Preserves `config.yaml`, preflight management key check |
| CLI commands | `packages/cli/src/commands/cliproxy/` | See packages/cli/AGENTS.md for command pattern |

## DEPLOY FLOW

1. **Preflight** (`preflightManagementKeyCheck`): GET `/v0/management/api-keys` with the local `CLIPROXY_MANAGEMENT_KEY`. Aborts on 401 (key drift), skips on missing key, fails on server errors. 10s fetch timeout.
2. **Upload**: `Caddyfile`, `docker-compose.yaml`, and `config.yaml` (only if it does not exist on the server). `--force-config` overrides the skip.
3. **Restart**: `docker compose pull && docker compose up -d` from `/opt/cliproxy/`.
4. **Health gate**: GET `/v0/management/api-keys` again to confirm the proxy is up and the key still works.

**Critical**: `config.yaml` on the server holds runtime API keys added via the management API. The deploy must not overwrite it. The compound learning doc at `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` captures the original incident.

## DOCKER STACK

- **Caddy**: HTTPS termination, auto Let's Encrypt. `restart: unless-stopped`.
- **cli-proxy-api**: `eceasy/cli-proxy-api` (pinned digest, Renovate-managed). Alpine 3.22 base. `restart: unless-stopped`. Healthcheck: `wget --spider -q http://localhost:8317/healthz` (purpose-built liveness endpoint, available since v6.9.31; `wget` is in the base, `curl` is not).
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
- **Never use `curl` in healthchecks** — only `wget` is in the Alpine base.

## NOTES

- **Secrets**: `CLIPROXY_SSH_KEY`, `CLIPROXY_MANAGEMENT_KEY`, `CLIPROXY_DOMAIN` scoped to GitHub environment `cliproxy`. `DIGITALOCEAN_ACCESS_TOKEN` is repo-level.
- **Local `.env`**: `CLIPROXY_MANAGEMENT_KEY` must match the droplet's `MANAGEMENT_PASSWORD` (set during provisioning, printed once).
- **Provisioning SSH key**: `provision-droplet.ts` looks up the DigitalOcean SSH key by name. Default is `fro-bot-cliproxy`; override with `CLIPROXY_SSH_KEY_NAME` env var. Shared helper lives in `packages/shared/server/droplet-helpers.ts`.
- **Provisioning SSH auth**: when `CLIPROXY_SSH_KEY` is set, `provision-droplet.ts` materializes it to a `0600` temp key file and pins it with `-i` + `IdentitiesOnly=yes` (no ssh-agent needed; cleaned up after); when unset, it falls back to ssh-agent.
- **Run provisioning via the root wrapper**: `bun run provision:cliproxy` (loads the repo-root `.env`; `bun run --cwd apps/cliproxy provision` would miss it).
- **OAuth refresh**: Claude OAuth tokens auto-refresh in `cliproxy_auth` volume. Manual refresh: `bunx @marcusrbrown/infra cliproxy login claude`.
- **API key recovery**: There is no recovery tooling. If keys are wiped, regenerate via `cliproxy keys add` and redistribute. `cliproxy config get --output backup.json` (with `0600` perms) is the safest backup mechanism.
