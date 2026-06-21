# Dashboard

[![Deploy Dashboard](https://github.com/marcusrbrown/infra/actions/workflows/deploy-dashboard.yaml/badge.svg)](https://github.com/marcusrbrown/infra/actions/workflows/deploy-dashboard.yaml)

Fro Bot operator dashboard at [dashboard.fro.bot](https://dashboard.fro.bot).

Two-service Docker Compose stack (dashboard + caddy) on a dedicated DigitalOcean droplet. The dashboard image is the upstream released image from `ghcr.io/fro-bot/dashboard`, pinned by tag and digest in `apps/dashboard/docker-compose.yaml`. The deploy pulls the digest-pinned image — no on-droplet build. Caddy handles automatic HTTPS. The GitHub App private key is file-mounted into the container (never an env var).

## Deploy

Validates env and host, runs a DNS preflight, materializes `/opt/dashboard/.env` via SSH stdin (never argv), uploads `docker-compose.yaml` and `Caddyfile`, uploads the GitHub App private key to `/opt/dashboard/config/github-app.pem` (0600) via SSH stdin, pulls the digest-pinned image from `ghcr.io/fro-bot/dashboard`, brings up `dashboard` (health-gated), verifies the running image's RepoDigests against the compose-pinned digest, then brings up `caddy`. A public HTTPS probe to `/api/healthz` confirms end-to-end reachability.

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

## Operator UI

The operator UI is enabled same-origin. The deploy sets `DASHBOARD_OPERATOR_UI_ENABLED=true` and `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true` as static constants in the `.env` — no new secrets required. The gateway operator session is the single auth authority. The SSE run-stream UI is reachable at `https://dashboard.fro.bot/operator/*` behind the operator auth boundary. `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` defaults to `https://dashboard.fro.bot` and is not set explicitly.

The `caddy` service has a Docker network alias `dashboard.fro.bot` on the shared default network. The dashboard server validates sessions by calling `https://dashboard.fro.bot/operator/session` server-side; the alias routes that call to Caddy via Docker DNS (Caddy proxies `/operator/*` to the gateway VPC) instead of hairpinning to the droplet's public IP, which DigitalOcean does not NAT-loopback. The alias is in the committed `docker-compose.yaml` base file — not an override — because the deploy removes any override file on every run.

## Operations

Full deploy flow, secret rotation runbooks, upgrade flow, container hardening details, and anti-patterns: [`apps/dashboard/AGENTS.md`](AGENTS.md).

For rollback procedures (reverting to a prior image digest): [`docs/runbooks/dashboard-released-image-rollback.md`](../../docs/runbooks/dashboard-released-image-rollback.md).

Key operational notes:

- Never put the GitHub App private key in an env var — it is file-mounted at `/run/secrets/github-app.pem` and the app reads it via `DASHBOARD_GITHUB_APP_KEY_FILE`.
- Never run `docker compose down -v` — destroys the `caddy_data` volume (Caddy TLS certificates).
- Never add `--build` to the deploy — the deploy pulls the digest-pinned image from `ghcr.io/fro-bot/dashboard`; on-droplet builds are not supported.
- Never pass secret bytes via SSH argv — the deploy pipes them through stdin only.

## GitHub App key revocation

The dashboard authenticates to GitHub as the **Fro Bot Agent** app (App ID 3918015) using a private key file-mounted at `/run/secrets/github-app.pem`. The gateway uses the same GitHub App but holds a **separate** private key. Revoking the dashboard's key invalidates only that key — the gateway's key is unaffected and the gateway keeps working.

### When to revoke

- The dashboard's GitHub App private key is suspected leaked or compromised.
- Routine key rotation.

### Procedure

Order matters: add and verify the new key **before** deleting the old one to avoid downtime.

1. **Generate a new key.** In the GitHub App settings for Fro Bot Agent → _Private keys_ → _Generate a private key_. GitHub downloads a new PEM. This does not invalidate any existing key.

2. **Update the secret.** Set `DASHBOARD_GITHUB_APP_KEY` in the `dashboard` GitHub Environment to the new PEM content. Update your local `.env` to match.

3. **Redeploy.**

   ```bash
   bunx @marcusrbrown/infra dashboard deploy           # remote (GitHub Actions)
   bunx @marcusrbrown/infra dashboard deploy --local   # direct SSH
   ```

   The deploy uploads the new PEM to `/opt/dashboard/config/github-app.pem` (0600, via SSH stdin) and restarts the container.

4. **Verify.** Confirm `https://dashboard.fro.bot/api/healthz` returns 200. Check dashboard logs for successful installation-token minting or `metadata/repos.yaml loaded` — no auth errors should appear.

   ```bash
   bunx @marcusrbrown/infra dashboard logs dashboard --tail 50
   ```

5. **Delete the old key.** Only after the new key is confirmed working, go to GitHub App settings → _Private keys_ → delete the old/compromised key.

6. **Confirm gateway is unaffected.** The gateway never used the dashboard's key. Optionally verify:

   ```bash
   bunx @marcusrbrown/infra gateway status
   ```

## CLI

```bash
bunx @marcusrbrown/infra dashboard status           # SSH, docker compose ps, service states
bunx @marcusrbrown/infra dashboard deploy           # trigger GitHub Actions workflow (default)
bunx @marcusrbrown/infra dashboard logs [service] [--tail N]  # stream container logs
```

`dashboard status` is MCP-exposed. `infra status` includes a `dashboard` row (and a `dashboard` key under `--json`).
