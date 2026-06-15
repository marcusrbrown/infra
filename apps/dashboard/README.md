# Dashboard

[![Deploy Dashboard](https://github.com/marcusrbrown/infra/actions/workflows/deploy-dashboard.yaml/badge.svg)](https://github.com/marcusrbrown/infra/actions/workflows/deploy-dashboard.yaml)

Fro Bot operator dashboard at [dashboard.fro.bot](https://dashboard.fro.bot).

Two-service Docker Compose stack (dashboard + caddy) on a dedicated DigitalOcean droplet. The dashboard image is built off-droplet from the pinned [fro-bot/dashboard](https://github.com/fro-bot/dashboard) ref in `apps/dashboard/upstream.json` and pushed to `ghcr.io/marcusrbrown/infra-dashboard` by the CI `build-images` job. The deploy pulls the prebuilt digest — no on-droplet build. Caddy handles automatic HTTPS. The GitHub App private key is file-mounted into the container (never an env var).

## Deploy

Validates env and host, runs a DNS preflight, materializes `/opt/dashboard/.env` via SSH stdin (never argv), uploads `docker-compose.yaml` and `Caddyfile`, uploads the GitHub App private key to `/opt/dashboard/config/github-app.pem` (0600) via SSH stdin, pulls the digest-pinned GHCR image, brings up `dashboard` (health-gated), verifies the running image's RepoDigests against the expected CI digest, then brings up `caddy`. A public HTTPS probe to `/api/healthz` confirms end-to-end reachability.

```bash
bun run --cwd apps/dashboard deploy
```

Via the CLI (triggers GitHub Actions by default):

```bash
bunx @marcusrbrown/infra dashboard deploy           # remote (GitHub Actions)
bunx @marcusrbrown/infra dashboard deploy --local   # direct SSH
```

## Provisioning

One-time: creates the `s-1vcpu-1gb` DigitalOcean droplet (image `docker-20-04`), selects the SSH key by name (`DASHBOARD_SSH_KEY_NAME`, default `fro-bot-dashboard`), waits for SSH, and pins domain and droplet-IP host keys into `.github/known_hosts`.

Use the root wrapper (loads the repo-root `.env`):

```bash
bun run provision:dashboard
```

After provisioning, commit the updated `.github/known_hosts` before the first CI deploy.

## Configuration

GitHub Environment: **`dashboard`**

| Secret | Description |
| --- | --- |
| `DASHBOARD_SSH_KEY` | Ed25519 private key for SSH access to the droplet |
| `DASHBOARD_DOMAIN` | FQDN of the dashboard instance |
| `DASHBOARD_GITHUB_APP_ID` | GitHub App ID used by the dashboard for API authentication |
| `DASHBOARD_GITHUB_APP_KEY` | GitHub App RSA private key (PEM); uploaded to the droplet as a file, never set as an env var |
| `DASHBOARD_OAUTH_CLIENT_ID` | GitHub OAuth App client ID for user login |
| `DASHBOARD_OAUTH_CLIENT_SECRET` | GitHub OAuth App client secret |
| `DASHBOARD_OPERATOR_LOGIN` | GitHub login of the operator account granted dashboard access |
| `DASHBOARD_COOKIE_KEY` | Secret key used to sign session cookies |

Repository secret: `DIGITALOCEAN_ACCESS_TOKEN` (used by the provision script).

## Operations

Full deploy flow, secret rotation runbooks, upgrade flow, container hardening details, and anti-patterns: [`apps/dashboard/AGENTS.md`](AGENTS.md).

Key operational notes:

- Never put the GitHub App private key in an env var — it is file-mounted at `/run/secrets/github-app.pem` and the app reads it via `DASHBOARD_GITHUB_APP_KEY_FILE`.
- Never run `docker compose down -v` — destroys the `caddy_data` volume (Caddy TLS certificates).
- Never add `--build` to the deploy — the deploy pulls the prebuilt GHCR digest; on-droplet builds are not supported.
- Never pass secret bytes via SSH argv — the deploy pipes them through stdin only.

## CLI

```bash
bunx @marcusrbrown/infra dashboard status           # SSH, docker compose ps, service states
bunx @marcusrbrown/infra dashboard deploy           # trigger GitHub Actions workflow (default)
bunx @marcusrbrown/infra dashboard logs [service] [--tail N]  # stream container logs
```

`dashboard status` is MCP-exposed. `infra status` includes a `dashboard` row (and a `dashboard` key under `--json`).
