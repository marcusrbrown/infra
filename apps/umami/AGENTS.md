# apps/umami — Umami analytics deploy

Privacy-respecting, self-hosted [Umami](https://umami.is) web analytics for `metrics.fro.bot`. A three-service Docker Compose stack (umami + postgres + caddy) on a dedicated DigitalOcean droplet, fronted by Caddy for automatic HTTPS. No public surface other than `:80`/`:443`; Postgres is reachable only on the internal compose network.

## Stack

| Service | Image | Role |
| --- | --- | --- |
| `umami` | `umamisoftware/umami:3.2.0@sha256:d8111e1d6d94be54a54514cd4e1264fbfe905e5ea0d0691804b1d71e627a6fca` | App + tracker API on `:3000` |
| `db` | `postgres:15-alpine@sha256:cd17e2ac98240fce1541ad2a803b34009b4eea5aec8a832363cdc7eca62e722e` | Postgres; named volume `umami-db-data` |
| `caddy` | `caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648` | Auto-TLS reverse proxy `:443 → umami:3000` |

Images are pinned to numbered tags by digest and tracked by Renovate (changelog-linked, standalone PRs). Postgres port `5432` is never published to the host.

## Deploy flow

`bun run --cwd apps/umami deploy` (or the **Deploy Umami** GitHub workflow, default path-filtered on `apps/umami/**`). The deploy:

1. Validates env (`UMAMI_DOMAIN`, `UMAMI_APP_SECRET`, `UMAMI_DB_PASSWORD`, `UMAMI_ADMIN_PASSWORD`, plus SSH context) and the host string before any SSH argv is built.
2. DNS preflight — resolves `UMAMI_DOMAIN` and fails fast if it does not resolve.
3. ControlMaster SSH multiplexing setup — a shared socket is created; subsequent steps reuse it.
4. Remote prep: `mkdir -p /opt/umami/config` on the droplet.
5. **DB-password fingerprint guard** — reads the sentinel from the remote (aborts on read/transport error), compares to the current password hash; aborts on mismatch to prevent volume-bricking password changes.
6. Materializes `/opt/umami/.env` over SSH **stdin** (never argv); secret values are boundary-validated (no newlines/shell metacharacters).
7. Uploads `docker-compose.yaml` + `config/Caddyfile`.
8. `docker compose pull` (all images).
9. `docker compose up -d --wait --wait-timeout 180 db umami` — Caddy is **NOT** started yet; container health (`pg_isready` + umami `/api/heartbeat`) via `--wait` is the authoritative success signal; 180s covers first-boot DB migrations.
10. **Automated admin-password rotation** (fail-closed; runs before Caddy to prevent any public default-credential window).
11. `docker compose up -d --wait --wait-timeout 180 caddy` — publicly exposes the service **only after** rotation is complete.
12. Writes the DB-password fingerprint sentinel (hash only, never the password itself) after a healthy `up`.
13. Content-addressed retention install and validation:
    - uploads `retention.sh`, `retention-check.sql`, and `retention.sql` to `/opt/umami/retention/staging/<hash>`;
    - uploads the service and timer units to `/opt/umami/retention/systemd-staging/<hash>`;
    - validates shell syntax, ownership/modes, and both units with `systemd-analyze verify`;
    - atomically promotes the runtime to `/opt/umami/retention/releases/<hash>` and updates the `/opt/umami/retention/current` symlink;
    - atomically installs `/etc/systemd/system/umami-retention.service` and `/etc/systemd/system/umami-retention.timer`, then runs `systemctl daemon-reload`. The hash covers all five runtime/unit files. A staged validation failure restores the prior `current` target. Deploy never runs `retention.sh --check` or `retention.sh --apply`.
14. Refreshes only an existing active/enabled timer: an active timer is restarted; an enabled but inactive timer is started; a disabled/inactive timer is left disabled/inactive. First install therefore remains unarmed.
15. **Bounded public-HTTPS probe** — retries `https://$UMAMI_DOMAIN/api/heartbeat` for `{"ok":true}`. On first-deploy Caddy ACME issuance lag it emits a WARNING and still succeeds (containers are already healthy); `compose up` is idempotent, so re-running once the cert lands is safe.

In CI the SSH key is materialized from `UMAMI_SSH_KEY` to a temp file with a trailing newline (GitHub strips trailing whitespace from secrets) and `chmod 600`; locally it uses the ssh-agent.

## Automated admin-password rotation

Umami first-boot creates a default `admin` / `umami` account. After the stack is healthy, the deploy logs in to `http://localhost:3000` **on the droplet** (never the public host) with the defaults; if that succeeds it sets the admin password to `UMAMI_ADMIN_PASSWORD` via the authenticated password-update endpoint. If the default login fails, the password is already rotated and the step is skipped (idempotent). After the first deploy, log in at `https://metrics.fro.bot` with `admin` / `UMAMI_ADMIN_PASSWORD`. The admin password travels via SSH stdin / request body, never argv.

> The exact v3.2.0 auth endpoints (`/api/auth/login`, `/api/me/password`) are pinned as constants in `src/deploy.ts`; the password-change endpoint uses body `{currentPassword, newPassword}` (Bearer auth). Re-verify them against the running image on a major Umami bump.

## Privacy baseline

This deployment exists to keep analytics private. The compose layer sets:

- `DISABLE_TELEMETRY=1` — disables Umami's own anonymous phone-home.
- `PRIVATE_MODE=1` — blocks outbound external calls (e.g. favicon/location lookups).

Umami is cookie-free and respects Do-Not-Track by default. The downstream tracker `<script>` tag should also carry the privacy attributes. Drop this into the consuming site, filling in the website ID captured from the Umami dashboard:

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

All analytics data lives in the `umami-db-data` Postgres volume. The deploy only ever runs `up -d` — **never `down -v`** — so the volume survives every deploy and image bump.

**Retention policy:** rows strictly older than `CURRENT_TIMESTAMP - INTERVAL '13 months'` are eligible. This is a calendar-month boundary, not a fixed day count. The policy covers pageview/custom-interaction rows and child/time-series rows in `event_data`, `website_event`, `session_data`, `revenue`, `session_replay`, `session_replay_saved`, and `heatmap_event`. Monthly `website_event` and `session` parents are deleted only after their supporting children are gone; dependency-protected parent rows remain only while they support retained children. Normal monthly session lifecycle data therefore keeps session parents below 14 months when no retained dependency requires them.

`retention.sh --check` is read-only. `retention.sh --apply` runs one unbatched transaction: children are deleted before parents, then counts are recomputed. Both modes use a transaction-scoped advisory lock, a 5-second lock timeout, and a 15-minute statement timeout. The systemd service adds a 30-minute outer timeout. The daily timer is persistent and lands between 00:30 and 01:00 UTC.

Every run reports `before`, `deleted`, `protected`, and `remaining` per table, plus orphan `before`/`after`/`delta` counts. `protected` is an expired parent count retained because a child still supports it; it is not a deletion failure. `remaining` is the eligible expired count left after the pass and must be zero after `--apply`. A positive orphan delta, any nonzero eligible remaining count, null `created_at` timestamps, advisory-lock contention, lock/statement/outer timeout, compose or psql failure, or any other command/SQL error fails closed. Failed apply transactions do not commit.

There is **no automated daily backup**. The verified backup taken before the first supervised apply is the approved recovery point. Ongoing safe operation relies on bounded daily deltas and the transactional guards above; do not claim a daily backup exists.

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

## Retention operator runbook

The first backlog apply is supervised and unbatched. A verified backup and reviewed `--check` counts are mandatory before the first `--apply` and before timer enablement. Deploy installs the runtime and units but does not run retention. On first install, the timer stays disabled/inactive until this runbook reaches the explicit enable gate.

Set the host once in a shell. This contains no secret:

```bash
set -Eeuo pipefail
HOST="${UMAMI_DOMAIN:?Set UMAMI_DOMAIN to the exact deployed host}"
REMOTE="root@${HOST}"
```

### 1. Verify the deployed stack and retention release

Run this before taking the recovery backup and again before enabling the timer. It checks the exact current Umami/Postgres image references, container state, content-addressed `current` target, the five file hashes, and the deploy hash algorithm:

```bash
ssh "$REMOTE" 'set -Eeuo pipefail
docker compose -f /opt/umami/docker-compose.yaml config --images | grep -Fx "umamisoftware/umami:3.2.0@sha256:d8111e1d6d94be54a54514cd4e1264fbfe905e5ea0d0691804b1d71e627a6fca"
docker compose -f /opt/umami/docker-compose.yaml config --images | grep -Fx "postgres:15-alpine@sha256:cd17e2ac98240fce1541ad2a803b34009b4eea5aec8a832363cdc7eca62e722e"
docker compose -f /opt/umami/docker-compose.yaml ps --all
current_target="$(readlink -e /opt/umami/retention/current)"
case "$current_target" in
  /opt/umami/retention/releases/*) ;;
  *) printf "invalid retention current target: %s\n" "$current_target" >&2; exit 1 ;;
esac
printf "retention_current=%s\n" "$current_target"
sha256sum "$current_target/retention.sh" "$current_target/retention-check.sql" "$current_target/retention.sql" \
  /etc/systemd/system/umami-retention.service /etc/systemd/system/umami-retention.timer
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path

files = (
    ("retention.sh", Path("/opt/umami/retention/current/retention.sh")),
    ("retention-check.sql", Path("/opt/umami/retention/current/retention-check.sql")),
    ("retention.sql", Path("/opt/umami/retention/current/retention.sql")),
    ("umami-retention.service", Path("/etc/systemd/system/umami-retention.service")),
    ("umami-retention.timer", Path("/etc/systemd/system/umami-retention.timer")),
)
hasher = sha256()
for name, path in files:
    hasher.update(name.encode() + b"\0")
    hasher.update(path.read_bytes())
    hasher.update(b"\0")
target = Path("/opt/umami/retention/current").resolve()
computed = hasher.hexdigest()
if target.parent != Path("/opt/umami/retention/releases") or target.name != computed:
    raise SystemExit(f"retention release hash mismatch: target={target} computed={computed}")
print(f"retention_release_hash={computed}")
PY
'
```

The content address is SHA-256 over, in order, each filename, a NUL byte, the file bytes, and a NUL byte for `retention.sh`, `retention-check.sql`, `retention.sql`, `umami-retention.service`, and `umami-retention.timer`. Keep the `readlink -e` result and all five SHA-256 values for the evidence record.

### 2. Create and verify the approved recovery point

This is the approved recovery point for the first apply. There is no automated daily backup. Run from the workstation, not inside the database container:

```bash
BACKUP="umami-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
ssh "$REMOTE" 'docker compose -f /opt/umami/docker-compose.yaml exec -T db pg_dump -U umami umami' \
  | gzip > "$BACKUP"
test -s "$BACKUP"
printf 'backup_timestamp=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'backup_file=%s\n' "$BACKUP"
printf 'backup_size_bytes=%s\n' "$(wc -c < "$BACKUP")"
shasum -a 256 "$BACKUP"
gzip -t "$BACKUP"
```

Record the filename, byte size, SHA-256, successful `gzip -t`, and UTC timestamp. Do not put database passwords or other secrets in the filename, command line, evidence, or logs.

### 3. Review the read-only pre-check

Capture the complete output as a local artifact and hash it. Review every table before proceeding. `before` is the expired-row census, `protected` is the dependency-protected parent count, and `eligible` is the output's `remaining` count (`before - protected` in check mode):

```bash
CHECK_ARTIFACT="umami-retention-check-$(date -u +%Y%m%dT%H%M%SZ).log"
if ssh "$REMOTE" \
  'bash /opt/umami/retention/current/retention.sh --check --compose-file /opt/umami/docker-compose.yaml' \
  | tee "$CHECK_ARTIFACT"; then
  :
else
  status=$?
  shasum -a 256 "$CHECK_ARTIFACT"
  printf 'pre-check failed with exit %s; do not apply or enable the timer\n' "$status" >&2
  exit "$status"
fi
shasum -a 256 "$CHECK_ARTIFACT"
```

The check must have zero null timestamps and a stable orphan baseline. Review the backlog size and dependency-protected rows against the approved plan before applying. A nonzero pre-check backlog is expected for the first run; a nonzero post-check eligible/remaining count is not.

### 4. Supervise the single full apply

Do not run this block until the backup receipt is verified and the pre-check output has been reviewed. The prompt is an intentional second gate; typing anything else exits without applying. Stay present for the complete output. Do not batch, parallelize, or retry a failed apply without investigation:

```bash
read -r -p 'Verified backup and reviewed pre-check; type APPLY UMAMI RETENTION to continue: ' APPROVAL
if [[ "$APPROVAL" != 'APPLY UMAMI RETENTION' ]]; then
  printf 'apply not authorized; timer remains unchanged\n' >&2
  exit 1
fi

APPLY_ARTIFACT="umami-retention-apply-$(date -u +%Y%m%dT%H%M%SZ).log"
if ssh "$REMOTE" \
  'bash /opt/umami/retention/current/retention.sh --apply --compose-file /opt/umami/docker-compose.yaml' \
  | tee "$APPLY_ARTIFACT"; then
  :
else
  status=$?
  shasum -a 256 "$APPLY_ARTIFACT"
  printf 'supervised apply failed with exit %s; do not enable the timer\n' "$status" >&2
  exit "$status"
fi
shasum -a 256 "$APPLY_ARTIFACT"
```

Successful apply output must contain `before`, `deleted`, `protected`, and `remaining` for every table, plus orphan `before`/`after`/`delta` records. The transaction fails closed if any null timestamp exists, the advisory lock is held, a lock/statement timeout occurs, an eligible row remains, or the orphan delta increases. A failed transaction is not a successful rollout.

### 5. Post-check and service/dashboard verification

Run the same read-only check after the apply and hash its output. Every table must report `remaining=0`; protected parent rows may still be nonzero when retained children require them. Orphan deltas must not be positive and null timestamp counts must remain zero:

```bash
POSTCHECK_ARTIFACT="umami-retention-postcheck-$(date -u +%Y%m%dT%H%M%SZ).log"
if ssh "$REMOTE" \
  'bash /opt/umami/retention/current/retention.sh --check --compose-file /opt/umami/docker-compose.yaml' \
  | tee "$POSTCHECK_ARTIFACT"; then
  :
else
  status=$?
  shasum -a 256 "$POSTCHECK_ARTIFACT"
  printf 'post-check failed with exit %s; do not enable the timer\n' "$status" >&2
  exit "$status"
fi
shasum -a 256 "$POSTCHECK_ARTIFACT"
```

Verify the service and containers without exposing visitor data:

```bash
curl -fsS "https://${HOST}/api/heartbeat"
ssh "$REMOTE" 'set -Eeuo pipefail
docker compose -f /opt/umami/docker-compose.yaml ps --all
docker compose -f /opt/umami/docker-compose.yaml exec -T db pg_isready -U umami -d umami
'
SYSTEMATIC_URL="${SYSTEMATIC_URL:-https://fro.bot/systematic}"
DEV_LIKE_URL="${DEV_LIKE_URL:?Set DEV_LIKE_URL to the existing dev-like dashboard URL}"
for url in "$SYSTEMATIC_URL" "$DEV_LIKE_URL"; do
  curl -fsS -o /dev/null -w '%{http_code} %{url_effective}\n' "$url"
done
```

Make one controlled visit to the existing Systematic and dev-like dashboard surfaces, then verify the corresponding website in `https://metrics.fro.bot`. Record counts and event categories only: do not copy visitor payloads, URLs, query strings, identifiers, or log bodies into evidence.

### 6. Explicitly enable and inspect the timer

Only after the supervised apply and post-check are successful, type the approval phrase and enable the timer. `systemctl enable --now` enables and starts the timer; it does not invoke the retention service immediately:

```bash
read -r -p 'Supervised apply and post-check passed; type ENABLE UMAMI RETENTION to continue: ' APPROVAL
if [[ "$APPROVAL" != 'ENABLE UMAMI RETENTION' ]]; then
  printf 'timer remains disabled\n' >&2
  exit 1
fi
ssh "$REMOTE" 'systemctl enable --now umami-retention.timer'
```

Capture enabled/active state, next run, and journal evidence:

```bash
ssh "$REMOTE" 'set -Eeuo pipefail
systemctl is-enabled umami-retention.timer
systemctl is-active umami-retention.timer
systemctl list-timers --all --no-pager umami-retention.timer
systemctl status umami-retention.timer --no-pager
journalctl -u umami-retention.timer -u umami-retention.service --since "24 hours ago" --no-pager
'
```

The timer is `Persistent=true`, scheduled at `00:30:00 UTC` with up to `30m` randomized delay and `AccuracySec=1min`. The service is a root oneshot with `TimeoutStartSec=30min` and runs `/opt/umami/retention/current/retention.sh --apply --compose-file /opt/umami/docker-compose.yaml`.

### 7. Disable or emergency-rollback

Disable the timer before investigation or rollback. This does not delete data or releases:

```bash
ssh "$REMOTE" 'systemctl disable --now umami-retention.timer && systemctl stop umami-retention.service'
```

For an emergency rollback, use the previously approved release hash from the evidence record. The deploy keeps runtime releases under `/opt/umami/retention/releases/<hash>` and the corresponding staged units under `/opt/umami/retention/systemd-staging/<hash>`. This block checks all rollback inputs before switching `current`, disables the timer, atomically restores the runtime and units, and leaves the timer disabled/inactive:

```bash
GOOD_HASH="${GOOD_HASH:?Set GOOD_HASH to a previously approved retention release hash}"
ssh "$REMOTE" bash -s -- "$GOOD_HASH" <<'REMOTE'
set -Eeuo pipefail
good_hash="$1"
release="/opt/umami/retention/releases/$good_hash"
units="/opt/umami/retention/systemd-staging/$good_hash"
current='/opt/umami/retention/current'
service='/etc/systemd/system/umami-retention.service'
timer='/etc/systemd/system/umami-retention.timer'
test -d "$release"
test -f "$release/retention.sh"
test -f "$release/retention-check.sql"
test -f "$release/retention.sql"
test -f "$units/umami-retention.service"
test -f "$units/umami-retention.timer"
systemctl disable --now umami-retention.timer
systemctl stop umami-retention.service
candidate="${current}.rollback-${good_hash}"
test ! -e "$candidate" && test ! -L "$candidate"
ln -s "$release" "$candidate"
mv -Tf "$candidate" "$current"
install -o root -g root -m 0644 "$units/umami-retention.service" "${service}.rollback-${good_hash}"
mv -Tf "${service}.rollback-${good_hash}" "$service"
install -o root -g root -m 0644 "$units/umami-retention.timer" "${timer}.rollback-${good_hash}"
mv -Tf "${timer}.rollback-${good_hash}" "$timer"
timeout 60s systemctl daemon-reload
test "$(readlink -e "$current")" = "$release"
if systemctl is-enabled umami-retention.timer; then
  printf 'rollback failed: timer is enabled\n' >&2
  exit 1
fi
test "$(systemctl is-active umami-retention.timer)" = inactive
printf 'rolled_back_to=%s\n' "$release"
REMOTE
```

After rollback, leave the timer disabled. Run a fresh `--check`, review the schema/version match, and repeat the supervised apply gate before rearming. A major Umami upgrade invalidates all prior retention evidence; schema revalidation is mandatory before rearming, even if the old release hash is restored.

## Secret rotation

- **`UMAMI_DB_PASSWORD` (DANGER — volume-coupled).** Postgres records the password when the volume is first initialized. Naively changing the secret breaks DB auth, so `deploy.ts` keeps a salted-hash sentinel at `/opt/umami/.db-password-fingerprint` and **refuses to deploy** when the secret no longer matches. To rotate:
  1. Deploy is still running on the old secret. SSH in and rotate the role in place: `docker compose -f /opt/umami/docker-compose.yaml exec -T db psql -U umami -c "ALTER USER umami WITH PASSWORD '<new>';"`
  2. Update the `UMAMI_DB_PASSWORD` secret (GitHub environment + local `.env`).
  3. Remove the stale sentinel so the next deploy re-initializes it: `ssh root@metrics.fro.bot rm -f /opt/umami/.db-password-fingerprint`
  4. Redeploy — it writes the new fingerprint after a healthy `up`.
- **`UMAMI_APP_SECRET`.** Rotating invalidates all existing sessions (users re-authenticate). Update the secret and redeploy.
- **`UMAMI_ADMIN_PASSWORD`.** Change it in-app, or update the secret and redeploy (the rotation step is idempotent and will not re-apply once the default login no longer works — to force a reset, change it from the Umami account settings).

## Upgrade flow

Renovate opens standalone, changelog-linked PRs for the `umamisoftware/umami` and `postgres` images. Merge → the Deploy Umami workflow ships the new digest. On any schema-affecting change, revalidate the retention table/dependency contract and capture a new evidence record. A **major Umami upgrade invalidates all prior retention evidence**: revalidate the schema, retention SQL, output contract, and image/version match before rearming the timer. Also re-verify the admin auth-endpoint constants in `src/deploy.ts` against the new image. Retention evidence procedures and the fillable attestation are in [`evidence/retention/README.md`](evidence/retention/README.md) and [`evidence/retention/TEMPLATE.md`](evidence/retention/TEMPLATE.md).

## CLI

| Command              | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `infra umami status` | SSH `docker compose ps` → service/state/health rows (MCP-exposed)  |
| `infra umami deploy` | Dispatch the Deploy Umami workflow (default) or `--local`          |
| `infra umami logs`   | Stream container logs (CI-guarded; emits a sensitive-data warning) |

`infra status` includes a `umami` row (and a `umami` key under `--json`).

## Provisioning

One-time: `bun run provision:umami` (root wrapper — loads the repo-root `.env`; `--cwd apps/umami` would miss it) creates the `s-1vcpu-1gb` droplet (image `docker-20-04`), selects the SSH key by name (`UMAMI_SSH_KEY_NAME`, default `fro-bot-umami`), waits for SSH, and pins both the domain and droplet-IP host keys into `.github/known_hosts` (commit the result before the first CI deploy). Resize to `s-1vcpu-2gb` if Postgres memory pressure appears.

SSH auth during provisioning: when `UMAMI_SSH_KEY` is set, the script materializes it to a `0600` temp key file and pins it with `-i` + `IdentitiesOnly=yes` (no ssh-agent needed; cleaned up after). When unset, it falls back to ssh-agent.

## Anti-patterns

- **Never `docker compose down -v`** — destroys the `umami-db-data` Postgres volume (all analytics).
- **Never rotate `UMAMI_DB_PASSWORD` by just changing the secret** — use the `ALTER USER` runbook; the fingerprint guard will otherwise refuse the deploy.
- **Never publish Postgres `5432`** to the host — it stays on the internal compose network.
- **Never put secret values in SSH argv** — the deploy pipes them via stdin.
- **Never remove `DISABLE_TELEMETRY` / `PRIVATE_MODE`** — they are the reason this is self-hosted.
