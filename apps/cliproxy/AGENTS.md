# CLIPROXY AGENTS

## OVERVIEW
CLIProxyAPI (OAuth-authenticated Claude proxy) deployed to DigitalOcean Droplet via Docker Compose (Caddy + cli-proxy-api).

## WHERE TO LOOK
| Task | Location |
| --- | --- |
| Config templates | `apps/cliproxy/config/` |
| Docker setup | `apps/cliproxy/docker-compose.yaml` |
| Provisioning | `apps/cliproxy/server/provision-droplet.ts` |
| Deploy script | `apps/cliproxy/src/deploy.ts` |
| CLI commands | `packages/cli/src/commands/cliproxy-*.ts` |

## DEPLOY FLOW
- **Provision** (one-time): Creates Droplet, installs Docker, uploads configs, generates management key, starts stack.
- **Deploy** (updates): Uploads configs, docker compose pull + up -d, and performs health check.

## DOCKER STACK
- **Caddy**: HTTPS termination, auto Let's Encrypt.
- **CLIProxyAPI**: `eceasy/cli-proxy-api` (pinned tags).
- **Volumes**: `caddy_data`, `caddy_config`, `cliproxy_auth`. Env file for secrets.

## MANAGEMENT API
Verified endpoint surface. Auth: `x-management-key` header (management key). `Authorization: Bearer` is for API key auth (client requests to the proxy), not management endpoints.
- `GET/PUT /v0/management/api-keys`: PUT expects bare JSON array of keys.
- `GET /v0/management/config`: Read-only via HTTP.
- `PUT /v0/management/{field}`: Per-field updates with `{"value": <val>}` body.
- `GET /v0/management/usage`: Usage data nested under `.usage`.
- `GET /v0/management/latest-version`: Returns `{"latest-version": "vX.Y.Z"}`.

## CLI COMMANDS
- `cliproxy status`, `cliproxy deploy`
- `cliproxy config get/set`, `cliproxy keys list/add/remove`
- `cliproxy login <provider>`

## ANTI-PATTERNS
- No bash deploy scripts for this app (TypeScript only).
- Never commit management key or API keys.
- Config write is per-field PUT, not full config replacement.
- API keys PUT expects bare array, not wrapped object.
- `baseURL` for OpenCode must include `/v1` suffix.

## NOTES
- **Secrets**: `CLIPROXY_SSH_KEY`, `CLIPROXY_MANAGEMENT_KEY`, `CLIPROXY_DOMAIN` in GitHub Environment `cliproxy`.
- **Global**: `DIGITALOCEAN_ACCESS_TOKEN` is repo-level.
- **Domain**: `cliproxy.fro.bot`. Docker images must use specific pinned tags.
