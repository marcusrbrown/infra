# apps/dashboard — Dashboard deploy

Fro Bot operator dashboard for `dashboard.fro.bot`. A two-service Docker Compose stack (dashboard +
caddy) on a dedicated DigitalOcean droplet, fronted by Caddy for automatic HTTPS. The dashboard image
is built off-droplet from the pinned [fro-bot/dashboard](https://github.com/fro-bot/dashboard) ref
and pushed to GHCR; the deploy pulls the prebuilt digest — no on-droplet build.

## Stack

| Service     | Image                                                    | Role                                                    |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `dashboard` | `ghcr.io/marcusrbrown/infra-dashboard:<ref>` (from GHCR) | Hono app on `:3000`; GitHub App + OAuth; healthcheck at `/api/healthz` |
| `caddy`     | `caddy:2.11.3-alpine` (digest-pinned)                    | Auto-TLS reverse proxy `:443 → dashboard:3000`          |

The dashboard image tag is the fro-bot/dashboard commit SHA pinned in `apps/dashboard/upstream.json`.
Caddy depends on the `dashboard` service being healthy before starting.

## Deploy flow

`bun run --cwd apps/dashboard deploy` (or the **Deploy Dashboard** GitHub workflow). The deploy:

1. Validates env (`DASHBOARD_DOMAIN`, `DASHBOARD_GITHUB_APP_ID`, `DASHBOARD_GITHUB_APP_KEY`,
   `DASHBOARD_OAUTH_CLIENT_ID`, `DASHBOARD_OAUTH_CLIENT_SECRET`, `DASHBOARD_OPERATOR_LOGIN`,
   `DASHBOARD_COOKIE_KEY`, `DASHBOARD_IMAGE_DIGEST`, plus SSH context) and the host string before any
   SSH argv is built. Fails closed if `DASHBOARD_IMAGE_DIGEST` is missing — no fallback to on-droplet
   build.
2. DNS preflight — resolves `DASHBOARD_DOMAIN` and fails fast if it does not resolve.
3. ControlMaster SSH multiplexing setup — a shared socket is created; subsequent steps reuse it.
4. Remote prep: `mkdir -p /opt/dashboard/config` on the droplet.
5. Materializes `/opt/dashboard/.env` over SSH **stdin** (never argv). The `.env` includes
   `DASHBOARD_GITHUB_APP_KEY_FILE=/run/secrets/github-app.pem` (the file path only — the PEM content
   is never written to `.env`).
6. Uploads `docker-compose.yaml` and `config/Caddyfile` via `scp`.
7. **Uploads the GitHub App private key** to `/opt/dashboard/config/github-app.pem` (0600) via SSH
   stdin — never as an env var, never logged. PEM bytes flow through stdin only; `umask 077` plus an
   explicit `chmod 0600` ensure the file is readable only by root.
8. `docker compose pull` — pulls the digest-pinned GHCR image.
9. `docker compose up -d --no-build --wait dashboard` — starts the app only; Caddy is **NOT** started
   yet. `--no-build` enforces the prebuilt GHCR digest; `--wait` uses the container healthcheck
   (`/api/healthz` on `:3000`) as the authoritative success signal.
10. **RepoDigests verification** — resolves the running container's image SHA, then inspects the
    image's `RepoDigests` and asserts that `DASHBOARD_IMAGE_DIGEST` appears in at least one entry.
    Fails closed with an actionable message if the running image does not match the CI-pushed digest.
11. `docker compose up -d --no-build --wait caddy` — publicly exposes the service **only after** the
    app is healthy and the digest is verified.
12. **Bounded public HTTPS probe** — retries `https://$DASHBOARD_DOMAIN/api/healthz` up to 10 times
    (5 s interval). On first-deploy Caddy ACME issuance lag it emits a warning and still succeeds
    (containers are already healthy); re-running once the cert lands is safe.

In CI the SSH key is materialized from `DASHBOARD_SSH_KEY` to a temp file with a trailing newline
(GitHub strips trailing whitespace from secrets) and `chmod 600`; locally it uses the ssh-agent.

## Image build (GHCR)

The `build-images` CI job in the **Deploy Dashboard** workflow:

1. Reads the pinned commit SHA from `apps/dashboard/upstream.json` (field `ref`).
2. Checks out `fro-bot/dashboard` at that ref.
3. Builds `fro-bot/dashboard`'s `Dockerfile` and pushes the image to
   `ghcr.io/marcusrbrown/infra-dashboard:<ref>` with `docker/build-push-action`.
4. Outputs the pushed image digest (`sha256:…`) as `dashboard_digest`.

The `deploy-dashboard` job receives `DASHBOARD_IMAGE_DIGEST` from that output and passes it to
`bun run --cwd apps/dashboard deploy`. The deploy pulls the digest-pinned image with
`docker compose pull` and verifies RepoDigests after `up`.

**Renovate** tracks `apps/dashboard/upstream.json` (the `ref` field pointing to the fro-bot/dashboard
source ref). When Renovate opens a PR bumping the ref, merging it triggers the Deploy Dashboard
workflow, which builds and ships the new digest automatically.

## Container hardening

The `dashboard` service runs with a deliberate security hardening block — a delta from `apps/umami`:

```yaml
read_only: true
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
user: node
tmpfs:
  - /tmp
```

- **`read_only: true`** — the container filesystem is read-only; only `/tmp` (tmpfs) and the
  App-key mount are writable surfaces.
- **`cap_drop: [ALL]`** — drops all Linux capabilities; the Hono app needs none.
- **`no-new-privileges: true`** — prevents privilege escalation via setuid/setgid binaries.
- **`user: node`** — runs as the non-root `node` user baked into the upstream image.
- **`tmpfs: /tmp`** — provides a writable scratch space without touching the host filesystem.

**GitHub App private key mount:**

```yaml
volumes:
  - /opt/dashboard/config/github-app.pem:/run/secrets/github-app.pem:ro
```

The key is bind-mounted read-only into the container at `/run/secrets/github-app.pem`. The `.env`
sets `DASHBOARD_GITHUB_APP_KEY_FILE=/run/secrets/github-app.pem` so the app reads the key via file
path, never via an env-string fallback.

**Why a file mount instead of an env var for the App private key:**

- `docker inspect` exposes all env vars in plaintext to any process with Docker socket access.
- Process listings (`/proc/<pid>/environ`) expose env vars to other processes on the host.
- Crash dumps and OOM reports may capture the process environment.
- A PEM key is long-lived key material — the blast radius of an env-var leak is permanent until the
  key is revoked. File mounts with `0600` permissions and `read_only: true` containers minimize
  exposure to the app process only.

## Secret rotation

- **`DASHBOARD_SSH_KEY`.** Replace the secret and update the authorized key on the droplet. No
  redeploy required for the running stack; the new key takes effect on the next SSH connection.
- **`DASHBOARD_DOMAIN`.** Update the secret and DNS record, then redeploy.
- **`DASHBOARD_GITHUB_APP_ID`.** Update the secret and redeploy.
- **`DASHBOARD_GITHUB_APP_KEY`.** Generate a new private key in the GitHub App settings, update the
  `DASHBOARD_GITHUB_APP_KEY` secret, and redeploy. The deploy uploads the new PEM to
  `/opt/dashboard/config/github-app.pem` (0600) via SSH stdin. After confirming the new key works,
  revoke the old key in the GitHub App settings.
- **`DASHBOARD_OAUTH_CLIENT_ID` / `DASHBOARD_OAUTH_CLIENT_SECRET`.** Rotate in the GitHub OAuth App
  settings, update the secrets, and redeploy. Existing sessions are invalidated.
- **`DASHBOARD_OPERATOR_LOGIN`.** Update the secret and redeploy.
- **`DASHBOARD_COOKIE_KEY`.** Rotating invalidates all existing sessions (users re-authenticate).
  Update the secret and redeploy.

## Upgrade flow

Renovate opens PRs for `apps/dashboard/upstream.json` when a new commit is available on the
fro-bot/dashboard default branch. Merge the PR → the Deploy Dashboard workflow builds the new image
from the bumped ref, pushes it to GHCR, and ships the new digest to the droplet automatically.

## CLI

| Command                                    | Purpose                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `infra dashboard status`                   | SSH `docker compose ps` → service/state/health rows (MCP-exposed)          |
| `infra dashboard deploy`                   | Dispatch the Deploy Dashboard workflow (default) or `--local`              |
| `infra dashboard logs [service] [--tail N]`| Stream container logs via SSH (CI-guarded; emits a sensitive-data warning) |

`infra status` includes a `dashboard` row (and a `dashboard` key under `--json`).

Valid services for `dashboard logs`: `dashboard`, `caddy`.

## Provisioning

One-time: `bun run provision:dashboard` (root wrapper — loads the repo-root `.env`; `--cwd
apps/dashboard` would miss it) creates the `s-1vcpu-1gb` droplet (image `docker-20-04`, region
`nyc1`, name `dashboard`), selects the SSH key by name (`DASHBOARD_SSH_KEY_NAME`, default
`fro-bot-dashboard`), waits for SSH, and pins both the domain and droplet-IP host keys into
`.github/known_hosts` (commit the result before the first CI deploy).

SSH auth during provisioning: when `DASHBOARD_SSH_KEY` is set, the script materializes it to a `0600`
temp key file and pins it with `-i` + `IdentitiesOnly=yes` (no ssh-agent needed; cleaned up after).
When unset, it falls back to ssh-agent.

## Anti-patterns

- **Never put the GitHub App private key in an env var** — use the file mount
  (`/run/secrets/github-app.pem`) and `DASHBOARD_GITHUB_APP_KEY_FILE`. Env vars are visible via
  `docker inspect`, process listings, and crash dumps; long-lived key material must not travel that
  path.
- **Never `docker compose down -v`** — destroys the `caddy_data` volume (Caddy TLS certificates and
  ACME state). Use `docker compose down` (no `-v`) to stop services without losing TLS data.
- **Never add `--build` to the dashboard deploy** — the deploy pulls the prebuilt GHCR digest;
  on-droplet builds are not supported and `--no-build` is enforced in the deploy script.
- **Never put secret values in SSH argv** — the deploy pipes them via stdin (`writeRemoteFile`).
  Shell metacharacters in secret values are rejected before any SSH connection is opened.
- **Never skip `validateDashboardHost`** — it rejects `-`-prefixed values and characters outside the
  allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`).
