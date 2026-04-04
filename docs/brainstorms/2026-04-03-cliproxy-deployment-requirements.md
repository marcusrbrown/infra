---
date: 2026-04-03
topic: cliproxy-deployment
---

# CLIProxyAPI Deployment and Management

## Problem Frame

Fro Bot agent instances running in GitHub Actions across multiple orgs (bfra-me, marcusrbrown, fro-bot) cannot access Claude models directly — Claude Code uses OAuth browser flows incompatible with CI. Marcus subscribes to Claude Pro Max20 but has no way to share that capacity with headless agents.

CLIProxyAPI (GitHub: `router-for-me/CLIProxyAPI`) solves this by proxying OAuth-authenticated Claude Code sessions as standard API endpoints with static API keys. It needs to be deployed, managed, and integrated into the existing infra tooling.

## Requirements

- R1. Deploy CLIProxyAPI to a Digital Ocean Droplet using Docker Compose, with persistent volumes for auth tokens and config
- R2. Enable TLS directly on CLIProxyAPI with valid certificates, plus a strong management key for remote Management API access
- R3. Authenticate with Claude Code via OAuth (`--claude-login`) and persist refresh tokens across container restarts
- R4. Create and manage proxy API keys that Fro Bot instances use to access Claude models
- R5. Add `apps/cliproxy/` to the infra monorepo following existing app conventions (package.json, config templates, deploy scripts, server provisioning)
- R6. Add CLI commands under `infra cliproxy` namespace: `status`, `deploy`, `config`, `keys`, `login`
  - R6a. `status` — health check (HTTP reachability, usage stats via Management API, service uptime)
  - R6b. `deploy` — provision or update the droplet + Docker Compose stack (remote via SSH, or trigger a deploy workflow)
  - R6c. `config` — get/set CLIProxyAPI configuration via the Management API
  - R6d. `keys` — CRUD proxy API keys via the Management API
  - R6e. `login` — trigger Claude Code OAuth flow on the server (SSH tunnel or token sync — approach TBD in planning)
- R7. Expose the Management API URL and key so other frontends (e.g., Quotio) can interact with the same instance
- R8. Add a GitHub Actions workflow for deploying cliproxy (parallel to the existing keeweb deploy workflow)
- R9. Distribute proxy endpoint URL and API key as org-level secrets (`CLIPROXY_URL`, `CLIPROXY_API_KEY`) to bfra-me, marcusrbrown, and fro-bot orgs

## Success Criteria

- CLIProxyAPI is running on a DO Droplet, reachable via HTTPS, with Claude Code OAuth tokens active
- `bunx @marcusrbrown/infra cliproxy status` returns health info including Claude model availability
- Fro Bot in any configured repo can use Claude models by pointing at the proxy URL with the distributed API key
- Management API is accessible to CLI and external frontends via HTTPS + management key
- Container persists auth tokens and config across restarts and redeployments

## Scope Boundaries

- **In scope**: Deployment, CLI management commands, Management API integration, Fro Bot secret distribution guidance
- **Not in scope**: Gemini CLI / Codex / Qwen / iFlow provider setup (Claude Code only for v1)
- **Not in scope**: CLIProxyAPI Web UI or Desktop GUI deployment (use Management API directly)
- **Not in scope**: High availability, load balancing, or multi-region (single droplet)
- **Not in scope**: Automated OAuth token refresh monitoring/alerting (manual login when tokens expire)
- **Not in scope**: Modifying CLIProxyAPI source code — deploy the official Docker image as-is

## Key Decisions

- **App name**: `cliproxy` — `apps/cliproxy/`, `infra cliproxy ...`
- **Deployment target**: DO Droplet with Docker Compose (not App Platform — need SSH for OAuth login)
- **TLS**: Native TLS on CLIProxyAPI (not reverse proxy) — fewer moving parts
- **CLI scope**: Core ops (status, deploy, config, keys, login) — not full Management API wrapper
- **Fro Bot secrets**: Org-level secrets for endpoint URL and API key
- **Claude only for v1**: Other providers (Gemini, Codex, etc.) can be added later via config

## Dependencies / Assumptions

- Marcus has a Digital Ocean account with API access (or will create one)
- DO API token will be stored as a repo/org secret for automated provisioning
- Claude Pro Max20 subscription is active and OAuth login will succeed
- CLIProxyAPI Docker image `eceasy/cli-proxy-api:latest` is stable for production use
- The Management API at `/v0/management/*` is the stable interface for programmatic management

## Outstanding Questions

### Resolve Before Planning

*None — all blocking questions resolved.*

- ~~[Affects R1] DO account exists; API token to be generated before implementation.~~

### Deferred to Planning

- [Affects R2][Needs research] What's the best approach for TLS certs on a DO Droplet? Let's Encrypt via certbot, Caddy as TLS terminator, or CLIProxyAPI's native TLS with manually provisioned certs?
- [Affects R3][Needs research] OAuth token refresh lifecycle — how long do Claude Code refresh tokens last? Do we need a cron job or health check to detect expiration?
- [Affects R6e][Technical] SSH tunnel vs local-login-then-sync for OAuth flow — prototype both during planning
- [Affects R6b][Technical] Deploy mechanism — SSH + docker compose commands (like keeweb) vs DO API for droplet provisioning + SSH for compose management
- [Affects R8][Technical] Whether cliproxy deploy should be a separate workflow or a job in the existing deploy.yaml

## Next Steps

→ `/ce:plan` for structured implementation planning
