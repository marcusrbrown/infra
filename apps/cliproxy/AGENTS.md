# CLIProxyAPI Deploy Package

OAuth-authenticated Claude proxy at `cliproxy.fro.bot`. Docker Compose stack (Caddy + cli-proxy-api) on a DigitalOcean Droplet. CLI clients authenticate to the proxy with bearer API keys; the proxy forwards to Claude using stored OAuth tokens.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Config templates | `config/config.yaml`, `config/Caddyfile` | Server template — runtime keys live on the droplet |
| Docker stack | `docker-compose.yaml` | Caddy + cli-proxy-api, restart: unless-stopped, healthcheck on root |
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
- **cli-proxy-api**: `eceasy/cli-proxy-api` (pinned digest, Renovate-managed). Alpine 3.22 base. `restart: unless-stopped`. Healthcheck: `wget --spider -q http://localhost:8317/` (root `/` returns 200; `wget` is available, `curl` is not).
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
| `/v0/management/usage` | GET | — | Stats nested under `.usage` |
| `/v0/management/latest-version` | GET | — | Returns `{"latest-version": "vX.Y.Z"}` |
| `/` | GET | — | Health endpoint, no auth |

## ANTI-PATTERNS

- **Never overwrite `config.yaml` on the server** without `--force-config` — it wipes runtime API keys (incident: 2026-04-06).
- **Never re-run `provision-droplet.ts` against an existing droplet** without `--force` — it overwrites the management key.
- **Never use `Authorization: Bearer` for management endpoints** — use `x-management-key`.
- **Never assume management API body shapes** — empirically verified, not guessed (incident: 2026-04-07).
- **Never commit `MANAGEMENT_PASSWORD`** — it lives in the droplet's `.env` and the local `CLIPROXY_MANAGEMENT_KEY` secret.
- **Never use `curl` in healthchecks** — only `wget` is in the Alpine base.

## NOTES

- **Secrets**: `CLIPROXY_SSH_KEY`, `CLIPROXY_MANAGEMENT_KEY`, `CLIPROXY_DOMAIN` scoped to GitHub environment `cliproxy`. `DIGITALOCEAN_ACCESS_TOKEN` is repo-level.
- **Local `.env`**: `CLIPROXY_MANAGEMENT_KEY` must match the droplet's `MANAGEMENT_PASSWORD` (set during provisioning, printed once).
- **OAuth refresh**: Claude OAuth tokens auto-refresh in `cliproxy_auth` volume. Manual refresh: `bunx @marcusrbrown/infra cliproxy login claude`.
- **API key recovery**: There is no recovery tooling. If keys are wiped, regenerate via `cliproxy keys add` and redistribute. `cliproxy config get --output backup.json` (with `0600` perms) is the safest backup mechanism.
