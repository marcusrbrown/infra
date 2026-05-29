# apps/umami — Umami analytics deploy

Privacy-respecting, self-hosted [Umami](https://umami.is) web analytics for `metrics.fro.bot`. A
three-service Docker Compose stack (umami + postgres + caddy) on a dedicated DigitalOcean droplet,
fronted by Caddy for automatic HTTPS. No public surface other than `:80`/`:443`; Postgres is
reachable only on the internal compose network.

## Stack

| Service | Image | Role |
| --- | --- | --- |
| `umami` | `umamisoftware/umami:3.1.0` (digest-pinned) | App + tracker API on `:3000` |
| `db` | `postgres:15-alpine` (digest-pinned) | Postgres; named volume `umami-db-data` |
| `caddy` | `caddy:2.11.3-alpine` (digest-pinned) | Auto-TLS reverse proxy `:443 → umami:3000` |

Images are pinned to numbered tags by digest and tracked by Renovate (changelog-linked, standalone
PRs). Postgres port `5432` is never published to the host.

## Deploy flow

`bun run --cwd apps/umami deploy` (or the **Deploy Umami** GitHub workflow, default path-filtered on
`apps/umami/**`). The deploy:

1. Validates env (`UMAMI_DOMAIN`, `UMAMI_APP_SECRET`, `UMAMI_DB_PASSWORD`, `UMAMI_ADMIN_PASSWORD`,
   plus SSH context) and the host string before any SSH argv is built.
2. Opens a multiplexed SSH connection (ControlMaster) reused across all calls.
3. Resolves `UMAMI_DOMAIN` DNS and fails fast if it does not resolve.
4. Materializes `/opt/umami/.env` over SSH **stdin** (never argv); secret values are
   boundary-validated (no newlines/shell metacharacters).
5. Uploads `docker-compose.yaml` + `config/Caddyfile`.
6. **DB-password fingerprint guard** (see below) — refuses a volume-bricking password change.
7. `docker compose pull && docker compose up -d --wait --wait-timeout 180`. Container health
   (`pg_isready` + the umami `/api/heartbeat` localhost healthcheck) via `--wait` is the
   authoritative success signal; 180s covers first-boot DB migrations.
8. Writes the DB-password fingerprint sentinel after a healthy `up`.
9. **Bounded public-HTTPS probe** — retries `https://$UMAMI_DOMAIN/api/heartbeat` for `{"ok":true}`.
   On first-deploy Caddy ACME issuance lag it emits a WARNING and still succeeds (containers are
   already healthy); `compose up` is idempotent, so re-running once the cert lands is safe.
10. **Automated admin-password rotation** (see below).

In CI the SSH key is materialized from `UMAMI_SSH_KEY` to a temp file with a trailing newline
(GitHub strips trailing whitespace from secrets) and `chmod 600`; locally it uses the ssh-agent.

## Automated admin-password rotation

Umami first-boot creates a default `admin` / `umami` account. After the stack is healthy, the deploy
logs in to `http://localhost:3000` **on the droplet** (never the public host) with the defaults; if
that succeeds it sets the admin password to `UMAMI_ADMIN_PASSWORD` via the authenticated
password-update endpoint. If the default login fails, the password is already rotated and the step is
skipped (idempotent). After the first deploy, log in at `https://metrics.fro.bot` with `admin` /
`UMAMI_ADMIN_PASSWORD`. The admin password travels via SSH stdin / request body, never argv.

> The exact v3.1.0 auth endpoints (`/api/auth/login`, `/api/me/password`) are pinned as
> constants in `src/deploy.ts`; the password-change endpoint uses body `{currentPassword, newPassword}` (Bearer auth).
> Re-verify them against the running image on a major Umami bump.

## Privacy baseline

This deployment exists to keep analytics private. The compose layer sets:

- `DISABLE_TELEMETRY=1` — disables Umami's own anonymous phone-home.
- `PRIVATE_MODE=1` — blocks outbound external calls (e.g. favicon/location lookups).

Umami is cookie-free and respects Do-Not-Track by default. The downstream tracker `<script>` tag
should also carry the privacy attributes. Drop this into the consuming site, filling in the website
ID captured from the Umami dashboard:

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

- `data-do-not-track` — honor the browser DNT signal.
- `data-exclude-search` — strip query strings from recorded URLs.
- `data-exclude-hash` — strip URL fragments.

## Data persistence & retention

All analytics data lives in the `umami-db-data` Postgres volume. The deploy only ever runs `up -d` —
**never `down -v`** — so the volume survives every deploy and image bump.

**Retention policy:** data is retained indefinitely by deliberate choice — this is low-volume,
already-minimized (privacy flags on, cookie-free, no PII collected by design) first-party analytics,
so there is no automatic expiry. To prune on demand, delete a website's events from the Umami
dashboard, or run a dated `DELETE` against the `website_event` table over SSH.

## Backup & restore (manual runbook)

Backup (over SSH, from a workstation with the deploy key):

```bash
ssh root@metrics.fro.bot \
  "docker compose -f /opt/umami/docker-compose.yaml exec -T db pg_dump -U umami umami" \
  | gzip > umami-$(date +%Y%m%d).sql.gz
```

Restore into a running stack:

```bash
gunzip -c umami-YYYYMMDD.sql.gz \
  | ssh root@metrics.fro.bot \
    "docker compose -f /opt/umami/docker-compose.yaml exec -T db psql -U umami umami"
```

## Secret rotation

- **`UMAMI_DB_PASSWORD` (DANGER — volume-coupled).** Postgres records the password when the volume is
  first initialized. Naively changing the secret breaks DB auth, so `deploy.ts` keeps a salted-hash
  sentinel at `/opt/umami/.db-password-fingerprint` and **refuses to deploy** when the secret no
  longer matches. To rotate:
  1. Deploy is still running on the old secret. SSH in and rotate the role in place:
     `docker compose -f /opt/umami/docker-compose.yaml exec -T db psql -U umami -c "ALTER USER umami WITH PASSWORD '<new>';"`
  2. Update the `UMAMI_DB_PASSWORD` secret (GitHub environment + local `.env`).
  3. Remove the stale sentinel so the next deploy re-initializes it:
     `ssh root@metrics.fro.bot rm -f /opt/umami/.db-password-fingerprint`
  4. Redeploy — it writes the new fingerprint after a healthy `up`.
- **`UMAMI_APP_SECRET`.** Rotating invalidates all existing sessions (users re-authenticate). Update
  the secret and redeploy.
- **`UMAMI_ADMIN_PASSWORD`.** Change it in-app, or update the secret and redeploy (the rotation step
  is idempotent and will not re-apply once the default login no longer works — to force a reset,
  change it from the Umami account settings).

## Upgrade flow

Renovate opens standalone, changelog-linked PRs for the `umamisoftware/umami` and `postgres` images.
Merge → the Deploy Umami workflow ships the new digest. On a **major** Umami bump, re-verify the
admin auth-endpoint constants in `src/deploy.ts` against the new image.

## CLI

| Command | Purpose |
| --- | --- |
| `infra umami status` | SSH `docker compose ps` → service/state/health rows (MCP-exposed) |
| `infra umami deploy` | Dispatch the Deploy Umami workflow (default) or `--local` |
| `infra umami logs` | Stream container logs (CI-guarded; emits a sensitive-data warning) |

`infra status` includes a `umami` row (and a `umami` key under `--json`).

## Provisioning

One-time: `bun run --cwd apps/umami provision` creates the `s-1vcpu-1gb` droplet (image
`docker-20-04`), selects the SSH key by name (`UMAMI_SSH_KEY_NAME`, default `fro-bot-umami`), waits
for SSH, and pins both the domain and droplet-IP host keys into `.github/known_hosts` (commit the
result before the first CI deploy). Resize to `s-1vcpu-2gb` if Postgres memory pressure appears.

## Anti-patterns

- **Never `docker compose down -v`** — destroys the `umami-db-data` Postgres volume (all analytics).
- **Never rotate `UMAMI_DB_PASSWORD` by just changing the secret** — use the `ALTER USER` runbook; the
  fingerprint guard will otherwise refuse the deploy.
- **Never publish Postgres `5432`** to the host — it stays on the internal compose network.
- **Never put secret values in SSH argv** — the deploy pipes them via stdin.
- **Never remove `DISABLE_TELEMETRY` / `PRIVATE_MODE`** — they are the reason this is self-hosted.
