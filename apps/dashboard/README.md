# Dashboard

[![Deploy Dashboard](https://github.com/marcusrbrown/infra/actions/workflows/deploy-dashboard.yaml/badge.svg)](https://github.com/marcusrbrown/infra/actions/workflows/deploy-dashboard.yaml)

Fro Bot operator dashboard at [dashboard.fro.bot](https://dashboard.fro.bot).

Two-service Docker Compose stack (dashboard + caddy) on a dedicated DigitalOcean droplet. The dashboard image is the upstream released image from `ghcr.io/fro-bot/dashboard`, pinned by tag and digest in `apps/dashboard/docker-compose.yaml`. The deploy pulls the digest-pinned image — no on-droplet build. Caddy handles automatic HTTPS. The GitHub App private key is file-mounted into the container (never an env var).

## Deploy

The deploy validates inputs and host access, resolves DNS, and generates the exact digest-pinned Compose payload locally. One SSH transaction then owns the remote work under a kernel lock at `/run/dashboard-deploy/lock` in a root-owned `0700` runtime directory. It waits up to 180 seconds for the lock; the lock is released when the owning process dies, so there is no stale-lock cleanup step.

The transaction records baseline evidence, always runs `docker image prune -af`, requires at least 6 GiB of free space, stages the exact Compose image set, and verifies every `repository@digest` after pulling or from the local cache. It requires the same 6 GiB floor again before publishing `/opt/dashboard/.env`, `Caddyfile`, the GitHub App key, and Compose (last). It then verifies dashboard health and digest, converges Caddy, and unlocks. Same-origin and public probes are advisory post-deploy checks; versioned audit pin write-back happens only after the transaction succeeds.

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
- The key is published at `/opt/dashboard/config/github-app.pem` as a regular file owned by UID/GID `1000:1000`, mode `0600`; `.env` is root-owned mode `0600`.
- `/opt/dashboard/data` is persistent listener state and is converged to UID/GID `1000:1000`, mode `0700`. Never remove it casually.
- Never run `docker compose down -v` — it destroys the `caddy_data` volume containing Caddy TLS certificates. Do not use Compose teardown to recover a failed deploy.
- Never add `--build` to the deploy — the deploy pulls the digest-pinned image from `ghcr.io/fro-bot/dashboard`; on-droplet builds are not supported.
- Never pass secret bytes via SSH argv — the deploy pipes them through stdin only.

Image cleanup is intentionally narrow: `docker image prune -af` removes only images unused by all containers. Docker may reclaim image data through this command, but the deployment never directly deletes containerd storage or files. It never prunes containers or volumes or tears down Compose. Running and stopped containers keep their image references. If stopped containers leave less than 6 GiB free after pruning, inspect them and remove only specifically obsolete stopped containers manually; then rerun the deploy. There is no automatic cleanup override.

If the registry pull fails, the deploy proceeds only when every staged `repository@digest` is already cached and verifies exactly. Tags alone are never trusted. Pruning happens only before acquisition, so the replaced image remains locally as one temporary rollback generation after a successful replacement; the next deployment attempt may prune it. The deploy does not promise or perform automatic rollback.

Resolve the reported condition before rerunning. The deterministic failure classes are lock contention, prune failure, post-prune low headroom, acquisition/cache mismatch, post-acquisition low headroom, and active publication/runtime failure. A runtime or publication failure reports the stage reached; it does not silently restore the previous Compose or service state.

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
