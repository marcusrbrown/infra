# Umami

Privacy-respecting, self-hosted web analytics at [metrics.fro.bot](https://metrics.fro.bot).

Three-service Docker Compose stack (umami + postgres + caddy) on a dedicated DigitalOcean droplet. Caddy handles automatic HTTPS. Postgres is reachable only on the internal compose network — port 5432 is never published to the host. Images are digest-pinned and tracked by Renovate. `DISABLE_TELEMETRY=1` and `PRIVATE_MODE=1` are set in the compose layer; Umami is cookie-free and respects Do-Not-Track by default.

## Deploy

Validates env and host, runs a DNS preflight, materializes `/opt/umami/.env` via SSH stdin (never argv), uploads `docker-compose.yaml` and `Caddyfile`, pulls images, brings up `db` and `umami` (health-gated), rotates the admin password before Caddy starts, then brings up `caddy`. A DB-password fingerprint guard prevents volume-bricking password changes.

```bash
bun run --cwd apps/umami deploy
```

Via the root wrapper (loads the repo-root `.env`):

```bash
bun run deploy:umami
```

Via the CLI (triggers GitHub Actions by default):

```bash
bunx @marcusrbrown/infra umami deploy           # remote (GitHub Actions)
bunx @marcusrbrown/infra umami deploy --local   # direct SSH
```

## Provisioning

One-time: creates the `s-1vcpu-1gb` DigitalOcean droplet (image `docker-20-04`), selects the SSH key by name (`UMAMI_SSH_KEY_NAME`, default `fro-bot-umami`), waits for SSH, and pins domain and droplet-IP host keys into `.github/known_hosts`.

Use the root wrapper (loads the repo-root `.env`):

```bash
bun run provision:umami
```

After provisioning, commit the updated `.github/known_hosts` before the first CI deploy.

## Configuration

GitHub Environment: **`umami`**

| Secret                 | Description                                                                  |
| ---------------------- | ---------------------------------------------------------------------------- |
| `UMAMI_SSH_KEY`        | Ed25519 private key for the `metrics.fro.bot` droplet                        |
| `UMAMI_DOMAIN`         | FQDN of the Umami instance                                                   |
| `UMAMI_APP_SECRET`     | Umami app secret (invalidates all sessions on rotation)                      |
| `UMAMI_DB_PASSWORD`    | Postgres password — volume-coupled; rotate only via the `ALTER USER` runbook |
| `UMAMI_ADMIN_PASSWORD` | Admin account password set on first deploy and on each redeploy (idempotent) |

Repository secret: `DIGITALOCEAN_ACCESS_TOKEN` (used by the provision script).

`UMAMI_DB_PASSWORD` is volume-coupled: Postgres records the password when the volume is first initialized. The deploy refuses to proceed if the secret no longer matches the stored fingerprint. Rotate only via the `ALTER USER` runbook in [`apps/umami/AGENTS.md`](AGENTS.md).

## Operations

Full deploy flow, secret rotation runbooks, backup/restore procedure, upgrade flow, and anti-patterns: [`apps/umami/AGENTS.md`](AGENTS.md).

Key operational notes:

- Never run `docker compose down -v` — destroys the `umami-db-data` Postgres volume (all analytics data).
- Never rotate `UMAMI_DB_PASSWORD` by just changing the secret — use the `ALTER USER` runbook.
- Never publish Postgres port 5432 to the host.
- Never remove `DISABLE_TELEMETRY` or `PRIVATE_MODE` — they are the reason this is self-hosted.

To embed the tracker in a consuming site (fill in the website ID from the Umami dashboard):

```html
<script
  defer
  src="https://metrics.fro.bot/script.js"
  data-website-id="REPLACE_WITH_WEBSITE_ID"
  data-do-not-track="true"
  data-exclude-search="true"
  data-exclude-hash="true"
></script>
```

## CLI

```bash
bunx @marcusrbrown/infra umami status           # SSH, docker compose ps, service states
bunx @marcusrbrown/infra umami deploy           # trigger GitHub Actions workflow (default)
bunx @marcusrbrown/infra umami logs [--tail N]  # stream container logs
```

`umami status` is MCP-exposed. `infra status` includes a `umami` row (and a `umami` key under `--json`).
