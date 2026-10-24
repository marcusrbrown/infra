# Umami Postgres Major Upgrade (PG15 → PG18 target)

Plan: [`docs/plans/2026-06-01-001-feat-umami-postgres-major-upgrade-plan.md`](../plans/2026-06-01-001-feat-umami-postgres-major-upgrade-plan.md) (Unit 2). One-time logical dump/restore into a fresh PG18 cluster on a new named volume. The PG15 volume stays untouched as the rollback anchor until finalize. Procedures in [`apps/umami/AGENTS.md`](../../apps/umami/AGENTS.md) are reused by reference; this runbook gives only the PG18 deltas and the full command wherever a delta changes an AGENTS.md command.

---

## Conventions

- **Evidence hygiene.** Evidence files, notes and chat hold digests, counts, checksums, pass/fail and the `SCRAM-SHA-256$` prefix only. Never `rolpassword`, sentinel content, `.env` values, passwords, or rows.
- **Gates.** Each hard gate is a command, then `Expect:`, then `STOP:`. A STOP means do not continue; take the `Rollback:` line next to the last destructive step, or investigate. Gates are never relaxed.
- **Shell.** Use `bash` from a repo checkout. Strict blocks are subshells `( set -Eeuo pipefail … )`, so a failure returns non-zero without killing the terminal. Every multi-stage pipe runs under `pipefail`. Bash ignores errexit everywhere inside a command used as the left side of `&&`/`||`, in an `if`/`while` condition or after `!`, so a strict subshell is never used that way: run it as a standalone statement, then branch on `$?`. Likewise, a pass/fail check never depends on a command's failure being swallowed in a test: capture the value first (a standalone assignment fails the block), then compare.
- **SSH.** Operator pattern from AGENTS.md (`root@${HOST}`, `HOST` from `UMAMI_DOMAIN`, deploy key in ssh-agent) with `StrictHostKeyChecking=yes` against the pinned `.github/known_hosts`. Never `ssh-keyscan`; a host-key error is a STOP.
- **Dumps.** SSH stdout streams straight into `age -r "$AGE_RECIPIENT"` on the workstation. The droplet holds no dump. Plaintext exists only in `mktemp -d` directories under `umask 077` (decrypt tests, staging input) and is deleted right after use.
- **AGENTS.md references** (all in `apps/umami/AGENTS.md`):
  - **Backup & restore** = "Backup & restore (manual runbook)"
  - **Retention §N** = "Retention operator runbook", subsection N (§1 verify stack, §2 recovery point, §3 check, §4 apply, §5 post-check, §6 ENABLE gate, §7 disable)
  - **Secret rotation** = the `UMAMI_DB_PASSWORD` `ALTER USER` runbook

## Sequence

0. Session setup (once per shell)
1. Pre-flight (read-only)
2. Backup (feeds staging)
3. Staging validation (workstation, before the pin PR is written)
4. Cutover (substeps 1–10; step 4.10 is the point of no return)
5. Sentinel verification
6. Cutover verification, then supervised PG18 retention
7. Rollback matrix
8. Finalize

---

## 0. Session setup

Prerequisites on the workstation: `bash`, `docker` with compose and buildx, a running Docker-compatible runtime with linux/amd64 emulation, `age`, `gh` (authenticated), `openssl`, `shasum`, `git`, `bun`, and the deploy key loaded in ssh-agent (`ssh-add -l`).

The migration uses a throwaway age key, generated once and destroyed at finalize. Its identity (`AGE-SECRET-KEY-…`) lives only in the macOS login keychain (service `umami-pg18-age`, account `umami-pg18-migration`), so it is never on disk, never on the droplet, and never in the repo. It is read through process substitution. To create it once, generate the key under `umask 077`, store the `AGE-SECRET-KEY-` line with `security add-generic-password` (feed the command through `security -i` on stdin, never argv), keep only the public recipient, and delete the key file. Set the recipient once per shell:

```bash
export AGE_RECIPIENT='age1…your-public-recipient'
export UMAMI_DOMAIN="${UMAMI_DOMAIN:?Set UMAMI_DOMAIN to the exact deployed host}"
```

**Setup block.** Re-run in every new shell, from the checkout the current step names. No secrets.

```bash
HOST="${UMAMI_DOMAIN:?Set UMAMI_DOMAIN to the exact deployed host}"
AGE_RECIPIENT="${AGE_RECIPIENT:?Set AGE_RECIPIENT to the age public recipient}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
export GH_REPO="${GH_REPO:-marcusrbrown/infra}"
umask 077
RUN_DIR="${RUN_DIR:-$HOME/umami-pg18-migration}"
mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
  -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$REPO_ROOT/.github/known_hosts")
SSH=(ssh "${SSH_OPTS[@]}" "root@${HOST}")
# AGENTS.md blocks call bare `ssh "$REMOTE" …`. This wrapper forces the pinned host-key options on them too.
REMOTE="root@${HOST}"
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
DC='docker compose -f /opt/umami/docker-compose.yaml'

MANIFEST_SQL="$RUN_DIR/manifest.sql"
IDENTITY_SQL="$RUN_DIR/identity.sql"
LAYOUT_GATE="$RUN_DIR/layout-gate.sh"
BACKUP_AGE="$RUN_DIR/backup.dump.age"
BACKUP_MANIFEST="$RUN_DIR/backup.source.manifest"
BACKUP_RESTORED="$RUN_DIR/backup.restored.manifest"
CUTOVER_AGE="$RUN_DIR/cutover.dump.age"
CUTOVER_MANIFEST="$RUN_DIR/cutover.source.manifest"
CUTOVER_RESTORED="$RUN_DIR/cutover.restored.manifest"
# Empty until P4 (pg15, umami) and S1 (pg18) write the files. Those steps re-assign them in the parent shell,
# and every consumer is guarded with ${VAR:?}.
PG15_IMAGE="$(cat "$RUN_DIR/pg15.image" 2>/dev/null || true)"
PG18_IMAGE="$(cat "$RUN_DIR/pg18.image" 2>/dev/null || true)"
UMAMI_IMAGE="$(cat "$RUN_DIR/umami.image" 2>/dev/null || true)"

# Prints the age identity on stdout from the macOS login keychain.
age_identity() { security find-generic-password -a umami-pg18-migration -s umami-pg18-age -w; }
```

**Shared functions.** Run after the setup block, again in every new shell:

```bash
# verify_age_artifact FILE.age IMAGE: checksum, decrypt to a 0700 temp dir, pg_restore --list with no network, delete plaintext.
verify_age_artifact() (
  set -Eeuo pipefail
  umask 077
  f="${1:?FILE.age required}"; image="${2:?IMAGE required (is PG15_IMAGE/PG18_IMAGE set?)}"
  ( cd "$(dirname "$f")" && shasum -a 256 -c "$(basename "$f").sha256" )
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  age -d -i <(age_identity) "$f" > "$tmp/umami.dump"
  test -s "$tmp/umami.dump"
  docker run --rm --platform linux/amd64 --network none -i "$image" pg_restore --list < "$tmp/umami.dump" > "$tmp/umami.list"
  test -s "$tmp/umami.list"
  printf 'list_entries=%s\n' "$(wc -l < "$tmp/umami.list" | tr -d ' ')"
  rm -rf "$tmp"
  test ! -e "$tmp"
  printf 'plaintext_removed=PASS\n'
)

# restart_stack: bring the production stack back and require pg_isready plus the public heartbeat.
restart_stack() {
  "${SSH[@]}" "$DC up -d --wait --wait-timeout 180 db umami caddy && $DC exec -T db pg_isready -U umami -d umami" > /dev/null \
    && curl -fsS -o /dev/null "https://${HOST}/api/heartbeat"
}
```

```bash
# disposable_restore IMAGE TMPFS_PATH FILE.age OUT_MANIFEST
# AGENTS.md disposable restore with the PG18 deltas: tmpfs path is a parameter (PG18: /var/lib/postgresql,
# PG15: /var/lib/postgresql/data), cleanup is `docker rm -f -v`, the dump streams from age (no plaintext file).
disposable_restore() (
  set -Eeuo pipefail
  image="${1:?IMAGE required (is PG15_IMAGE/PG18_IMAGE set?)}"; tmpfs_path="${2:?TMPFS_PATH required}"
  age_file="${3:?FILE.age required}"; out="${4:?OUT_MANIFEST required}"
  name="umami-pg18-dispose-$$-$(date +%s)"
  cleanup() {
    s=$?; trap - EXIT
    docker rm -f -v "$name" > /dev/null 2>&1 || true
    if docker container inspect "$name" > /dev/null 2>&1; then
      printf 'disposable_container_removal=FAIL\n' >&2; s=1
    else
      printf 'disposable_container_removal=PASS\n'
    fi
    exit "$s"
  }
  trap cleanup EXIT
  docker run -d --name "$name" --platform linux/amd64 --network none --tmpfs "$tmpfs_path" \
    -e POSTGRES_USER=umami -e POSTGRES_DB=umami -e POSTGRES_HOST_AUTH_METHOD=trust "$image" > /dev/null
  printf 'disposable_restore_isolation=network-none,tmpfs=%s,no-published-ports,trust-auth-in-container-only\n' "$tmpfs_path"
  ready=0
  for _ in $(seq 1 90); do
    if docker exec "$name" pg_isready -U umami -d postgres > /dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  test "$ready" -eq 1
  docker exec "$name" psql -X -v ON_ERROR_STOP=1 -U umami -d postgres \
    -c 'DROP DATABASE IF EXISTS umami WITH (FORCE);' < /dev/null
  age -d -i <(age_identity) "$age_file" \
    | docker exec -i "$name" pg_restore --exit-on-error --create --no-owner -U umami -d postgres
  docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami < "$MANIFEST_SQL" \
    | LC_ALL=C sort > "$out"
  test -s "$out"
)

# sentinel_check: read-only; prints size/mode and MATCH or MISMATCH only.
sentinel_check() {
  "${SSH[@]}" bash -s <<'REMOTE'
set -Eeuo pipefail
f=/opt/umami/.db-password-fingerprint
printf 'sentinel_size_mode=%s\n' "$(stat -c '%s %a' "$f")"
pw="$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/umami/.env)"
test -n "$pw"
calc="$(printf 'umami-db-pw-v1:%s' "$pw" | sha256sum | cut -d' ' -f1)"
stored="$(cat "$f")"
if [ "$calc" = "$stored" ]; then echo MATCH; else echo MISMATCH; exit 1; fi
REMOTE
}
```

`sentinel_check` computes the `computeDbPasswordFingerprint` value (`sha256` over `umami-db-pw-v1:` + the password) from `/opt/umami/.env` on the droplet and compares it to the sentinel. Neither value is printed.

**Freeze and retention helpers.** Run after the blocks above, again in every new shell. Every `gh` listing failure propagates (`|| return 1`, no command substitution around the listing), so a failed listing can never read as zero remaining runs:

```bash
# freeze_list FILE: append the ids of every waiting/queued/requested/pending/in-progress run of the umami
# deploy workflow and of the router (deploy.yaml) to FILE. Non-zero if any listing fails.
freeze_list() {
  local wf st
  : > "$1" || return 1
  for wf in deploy-umami.yaml deploy.yaml; do
    for st in waiting queued requested pending in_progress; do
      gh run list --workflow "$wf" --status "$st" --limit 100 --json databaseId --jq '.[].databaseId' >> "$1" || return 1
    done
  done
}
freeze_cancel() {
  local f id
  f="$(mktemp)" || return 1
  freeze_list "$f" || { rm -f "$f"; return 1; }
  while read -r id; do
    gh run cancel "$id" < /dev/null || { rm -f "$f"; return 1; }
  done < "$f"
  rm -f "$f"
}
freeze_assert() {
  local f n
  f="$(mktemp)" || return 1
  for _ in $(seq 1 12); do
    freeze_list "$f" || { rm -f "$f"; echo 'freeze_listing=FAIL' >&2; return 1; }
    n="$(grep -c . "$f" || true)"
    if [ "$n" = 0 ]; then rm -f "$f"; echo 'freeze_runs_remaining=0'; return 0; fi
    sleep 5
  done
  rm -f "$f"
  echo "freeze_runs_remaining=$n" >&2
  return 1
}

# retention_disable_assert: disable and stop the retention timer and service, then assert disabled/inactive/inactive.
retention_disable_assert() {
  "${SSH[@]}" bash -s <<'REMOTE'
set -Eeuo pipefail
systemctl disable --now umami-retention.timer
systemctl stop umami-retention.service
test "$(systemctl is-enabled umami-retention.timer || true)" = disabled
test "$(systemctl is-active umami-retention.timer || true)" = inactive
test "$(systemctl is-active umami-retention.service || true)" = inactive
echo 'timer_disabled_inactive=PASS'
REMOTE
}
```

**Manifest SQL.** Defined once. Prints `table|count|md5` per public table, with no hardcoded table list. Session settings are pinned so row text is comparable across majors. Run once; the file persists in `$RUN_DIR`:

```bash
cat > "$MANIFEST_SQL" <<'SQL'
SET TimeZone='UTC';
SET DateStyle='ISO, MDY';
SET extra_float_digits=1;
SET IntervalStyle='postgres';
SELECT format(
  'SELECT %L, count(*), md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM %I.%I AS t',
  c.relname, n.nspname, c.relname)
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname
\gexec
SQL
```

Do not add a `;` before `\gexec`: a terminated query runs once on its own and again under `\gexec`, which pollutes the output. `-q` suppresses the `SET` command tags.

Usage everywhere: `psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami < "$MANIFEST_SQL" | LC_ALL=C sort > FILE`, then an exact `diff -u` of the two files. A checksum mismatch with equal counts is a STOP: investigate type-output differences or corruption; never relax the gate.

**Identity probe SQL.** Run once; reused in pre-flight, staging, cutover and verification. Output is `key=value` lines, non-secret:

```bash
cat > "$IDENTITY_SQL" <<'SQL'
SELECT 'server_version=' || current_setting('server_version');
SELECT 'password_encryption=' || current_setting('password_encryption');
SELECT 'data_directory=' || current_setting('data_directory');
SELECT 'role_verifier_prefix=' || left(rolpassword, 14) FROM pg_authid WHERE rolname = 'umami';
SELECT 'db_collation=' || datcollate || '|' || datctype || '|' || datlocprovider::text FROM pg_database WHERE datname = 'umami';
SELECT 'public_tables=' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
SELECT 'db_size=' || pg_size_pretty(pg_database_size('umami'));
SQL
```

**Layout gate script.** Run once. It asserts the PG18 `db` layout and is executed locally (staging) or on the droplet over SSH (cutover) with `DC_CMD`, `EXPECT_VOLUME` and `PG18_IMAGE` in the environment. `pg_isready` and the container healthcheck pass on an empty cluster, so health is never evidence of data.

```bash
cat > "$LAYOUT_GATE" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
: "${DC_CMD:?}" "${EXPECT_VOLUME:?}" "${PG18_IMAGE:?}"
dc() { $DC_CMD "$@"; }
psql_q() { dc exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami -c "$1" < /dev/null; }
cid="$(dc ps -q db)"
test -n "$cid"
[ "$(docker inspect -f '{{.Config.Image}}' "$cid")" = "$PG18_IMAGE" ] || { echo 'layout_image=FAIL' >&2; exit 1; }
mounts="$(docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} {{.Destination}}{{"\n"}}{{end}}' "$cid" | sed '/^$/d')"
printf 'mounts=%s\n' "$mounts"
[ "$mounts" = "volume ${EXPECT_VOLUME} /var/lib/postgresql" ] || { echo 'layout_mount=FAIL' >&2; exit 1; }
echo 'layout_mount=PASS'
cfg="$(dc config)"
if grep -q 'PGDATA' <<< "$cfg"; then echo 'layout_pgdata_override=FAIL' >&2; exit 1; fi
img_id="$(docker inspect -f '{{.Image}}' "$cid")"
img_pgdata="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$img_id" | sed -n 's/^PGDATA=//p')"
ctr_pgdata="$(dc exec -T db printenv PGDATA < /dev/null)"
sql_dd="$(psql_q 'SHOW data_directory')"
printf 'PGDATA=%s\ndata_directory=%s\n' "$ctr_pgdata" "$sql_dd"
case "$ctr_pgdata" in /var/lib/postgresql/data | /var/lib/postgresql/data/*) echo 'layout_pgdata=FAIL' >&2; exit 1 ;; /var/lib/postgresql/*) ;; *) echo 'layout_pgdata=FAIL' >&2; exit 1 ;; esac
[ "$ctr_pgdata" = "$img_pgdata" ] && [ "$ctr_pgdata" = "$sql_dd" ] || { echo 'layout_pgdata=FAIL' >&2; exit 1; }
echo 'layout_pgdata=PASS'
tables="$(psql_q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')")"
[ "$tables" = "0" ] || { echo "layout_fresh_cluster=FAIL tables=$tables" >&2; exit 1; }
echo 'layout_fresh_cluster=PASS'
enc="$(psql_q 'SHOW password_encryption')"
prefix="$(psql_q "SELECT left(rolpassword, 14) FROM pg_authid WHERE rolname = 'umami'")"
[ "$enc" = "scram-sha-256" ] && [ "$prefix" = 'SCRAM-SHA-256$' ] || { echo 'layout_scram=FAIL' >&2; exit 1; }
printf 'password_encryption=%s\nrole_verifier_prefix=%s\nlayout_scram=PASS\n' "$enc" "$prefix"
psql_q "SELECT 'db_collation=' || datcollate || '|' || datctype || '|' || datlocprovider::text FROM pg_database WHERE datname = 'umami'"
probe="$(dc exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -At -q -h db -U umami -d umami -c "select 1"' < /dev/null)"
[ "$probe" = "1" ] || { echo 'layout_tcp_probe=FAIL' >&2; exit 1; }
echo 'layout_tcp_probe=PASS'
SCRIPT
chmod 700 "$LAYOUT_GATE"
```

The TCP probe runs inside the `db` container with `-h db`. The service name resolves to the container's network IP, so the `host … scram-sha-256` `pg_hba` rule applies instead of loopback/socket `trust`. `PGPASSWORD` comes from the container's own `POSTGRES_PASSWORD` via `sh -c` and is never printed.

---

## 1. Pre-flight (read-only)

Nothing here changes the droplet. Outputs are saved under `$RUN_DIR` (non-secret).

**P1. Trust, tooling, age round-trip.**

```bash
( set -Eeuo pipefail
  "${SSH[@]}" true
  echo 'ssh_pinned_hostkey=PASS'
  docker info --format 'server={{.ServerVersion}} ctx_ok'
  docker run --rm --platform linux/amd64 --entrypoint uname alpine:latest -m
  gh auth status > /dev/null
  echo 'gh_auth=PASS'
  age --version
  rt="$(printf 'roundtrip' | age -r "$AGE_RECIPIENT" | age -d -i <(age_identity))"
  test "$rt" = roundtrip
  echo 'age_roundtrip=PASS'
)
```

Expect: `ssh_pinned_hostkey=PASS`, `x86_64` from the emulation probe, `age_roundtrip=PASS`. STOP: any host-key error (do not bypass; re-pin per AGENTS.md Provisioning), no amd64 emulation, or an identity that cannot decrypt.

**P2. Database identity, manifest, TCP password probe.**

```bash
( set -Eeuo pipefail
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$IDENTITY_SQL" | tee "$RUN_DIR/preflight.identity"
  grep '^db_collation=' "$RUN_DIR/preflight.identity" > "$RUN_DIR/preflight.collation"
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$MANIFEST_SQL" \
    | LC_ALL=C sort > "$RUN_DIR/preflight.manifest"
  cut -d'|' -f1,2 "$RUN_DIR/preflight.manifest"
  "${SSH[@]}" bash -s <<'REMOTE'
set -Eeuo pipefail
cd /opt/umami
docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -At -q -h db -U umami -d umami -c "select 1"' < /dev/null
REMOTE
)
```

Expect: `password_encryption=scram-sha-256`, `role_verifier_prefix=SCRAM-SHA-256$`, a `db_collation=` line, the public table list with exact counts, and `1` from the TCP probe. Record `server_version` and `db_size` in your notes. STOP: any other encryption or prefix, or a failing probe (`FATAL: password authentication failed`). Do not edit anything; the fix path is AGENTS.md Secret rotation, and the migration waits.

**P3. Window, resources, retention timer, sentinel.**

```bash
( set -Eeuo pipefail
  "${SSH[@]}" bash -s <<'REMOTE'
set -Eeuo pipefail
free -m
df -h /
test "$(df --output=avail -BM / | tail -1 | tr -dc 0-9)" -ge 1024
for u in umami-retention.timer umami-retention.service; do
  printf '%s enabled=%s active=%s\n' "$u" "$(systemctl is-enabled "$u" 2>&1 || true)" "$(systemctl is-active "$u" 2>&1 || true)"
done
systemctl list-timers --all --no-pager umami-retention.timer
stat -c 'env_mtime=%Y' /opt/umami/.env
REMOTE
  sentinel_check
) > "$RUN_DIR/preflight.host"
rc=$?
cat "$RUN_DIR/preflight.host"
if [ "$rc" -ne 0 ]; then echo "P3=STOP (rc=$rc)" >&2; false; fi
```

Expect: at least 1 GiB free on `/`, the timer `enabled=enabled active=active` and the service `inactive`. That is the normal armed state since the retention ENABLE gate (daily around 00:30–01:00 UTC), not a STOP; step 4.1 disables it. Sentinel `64 600` and `MATCH`. The `env_mtime` is compared again in step 6. STOP: a retention service that is `active` or `activating` (wait for it to finish), `MISMATCH`, sentinel missing or wrong size/mode, or low disk. Never fix a sentinel by hand.

**P4. Images, volumes, rollback artifact, anchor identity.** Run AGENTS.md Retention §1 first (deployed compose pins the same images as the repo). Its bare `ssh "$REMOTE"` calls go through the pinned-options `ssh` wrapper from session setup (`REMOTE` is set there). Then:

```bash
( set -Eeuo pipefail
  imgs="$("${SSH[@]}" "$DC config --images")"
  printf '%s\n' "$imgs" | grep '^postgres:' > "$RUN_DIR/pg15.image"
  printf '%s\n' "$imgs" | grep '^umamisoftware/umami:' > "$RUN_DIR/umami.image"
  cat "$RUN_DIR/pg15.image" "$RUN_DIR/umami.image"
  "${SSH[@]}" 'docker volume ls --format "{{.Name}}"' | grep -E '^umami_' | tee "$RUN_DIR/preflight.volumes"
  grep -Fx 'umami_umami-db-data' "$RUN_DIR/preflight.volumes" || { echo 'anchor_volume=FAIL (umami_umami-db-data missing)' >&2; exit 1; }
  if grep -Fx 'umami_umami-db-data-pg18' "$RUN_DIR/preflight.volumes"; then echo 'pg18_volume_preexisting=FAIL' >&2; exit 1; fi
  "${SSH[@]}" 'cat /opt/umami/docker-compose.yaml' > "$RUN_DIR/compose.pg15.yaml"
  grep -Fq 'umami-db-data:/var/lib/postgresql/data' "$RUN_DIR/compose.pg15.yaml" || { echo 'compose_pg15_layout=FAIL' >&2; exit 1; }
  ( cd "$RUN_DIR" && shasum -a 256 compose.pg15.yaml | tee compose.pg15.yaml.sha256 )
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami -c \"SELECT count(*) FROM website WHERE name = 'systematic'\"" | tee "$RUN_DIR/preflight.systematic"
  [ "$(cat "$RUN_DIR/preflight.systematic")" = 1 ] || { echo 'systematic_row_count=FAIL' >&2; exit 1; }
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami -c \"SELECT md5(string_agg(website_id::text, ',' ORDER BY website_id::text)) FROM website WHERE name = 'systematic'\"" > "$RUN_DIR/preflight.systematic.id"
  printf 'destroy_by=finalize_date+7d\n' > "$RUN_DIR/DELETION_DEADLINE"
)
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "P4=STOP (rc=$rc); PG15_IMAGE/UMAMI_IMAGE not assigned" >&2; false
else
  PG15_IMAGE="$(cat "$RUN_DIR/pg15.image")"; UMAMI_IMAGE="$(cat "$RUN_DIR/umami.image")"
  : "${PG15_IMAGE:?pg15.image empty}" "${UMAMI_IMAGE:?umami.image empty}"
fi
```

The strict block runs as a standalone statement and the next line branches on its `$?`. A `( set -e … ) && next` form would switch errexit off inside the subshell. The assignments run in the parent shell (a subshell cannot) and only after the block succeeded; later steps fail fast if they are empty.

Expect: the PG15 and umami image references printed, the anchor `umami_umami-db-data` listed, the new `umami_umami-db-data-pg18` absent, the saved compose containing the PG15 mount path, and `1` for the `systematic` website count. `compose.pg15.yaml` plus its checksum is the rollback artifact for step 7. STOP: a pre-existing `umami_umami-db-data-pg18` volume (a prior attempt; investigate, do not reuse), a count other than `1` (the plan's identification of the website row is wrong; fix the query before continuing), or a droplet compose that does not match the PG15 layout.

---

## 2. Backup (feeds staging)

Follows AGENTS.md Retention §2 with these deltas: the manifest carries per-table checksums (MANIFEST_SQL); the dump streams over SSH into `age` on the workstation; the droplet holds no dump or temp directory; the stack restarts on any exit. This is an early independent recovery source; the cutover takes its own fresh quiesced dump (step 4.3).

The block briefly stops `caddy` and `umami` (analytics downtime). Run the step-1 checks first.

```bash
( set -Eeuo pipefail
  cleanup() {
    s=$?; trap - EXIT
    rm -f "$BACKUP_AGE.partial"
    if restart_stack; then echo 'production_restart_heartbeat=PASS'; else echo 'production_restart_heartbeat=FAIL' >&2; s=1; fi
    exit "$s"
  }
  trap cleanup EXIT
  "${SSH[@]}" "$DC stop caddy umami" >&2
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$MANIFEST_SQL" \
    | LC_ALL=C sort > "$BACKUP_MANIFEST"
  "${SSH[@]}" "$DC exec -T db pg_dump -Fc --create -U umami -d umami" \
    | age -r "$AGE_RECIPIENT" > "$BACKUP_AGE.partial"
  mv "$BACKUP_AGE.partial" "$BACKUP_AGE"
  test -s "$BACKUP_MANIFEST"; test -s "$BACKUP_AGE"
  ( cd "$RUN_DIR" && shasum -a 256 backup.dump.age | tee backup.dump.age.sha256 && shasum -a 256 backup.source.manifest )
  wc -c < "$BACKUP_AGE" | tr -d ' ' | sed 's/^/backup_age_bytes=/'
)
```

Expect: the stack restart/heartbeat `PASS` line, a non-empty `.age` and manifest, and a recorded sha256 of the `.age` file. Rollback: the trap restarts the stack on every exit. If it prints `FAIL`, run `restart_stack` until it passes before doing anything else.

**Verify the stored artifact (hard gate).** Checksum, test decrypt with the identity, `pg_restore --list` in the pinned PG15 image with no network, plaintext deleted. Then a disposable restore and the exact manifest diff. PG15 isolation uses its own `PGDATA` path; the PG18 tmpfs delta applies to PG18 runs only.

```bash
( set -Eeuo pipefail
  verify_age_artifact "$BACKUP_AGE" "$PG15_IMAGE"
  disposable_restore "$PG15_IMAGE" /var/lib/postgresql/data "$BACKUP_AGE" "$BACKUP_RESTORED"
  if ! diff -u "$BACKUP_MANIFEST" "$BACKUP_RESTORED"; then echo 'exact_manifest_diff=FAIL' >&2; exit 1; fi
  echo 'exact_manifest_diff=PASS'
  ( cd "$RUN_DIR" && shasum -a 256 backup.restored.manifest )
)
```

Expect: `list_entries=` greater than 0, `plaintext_removed=PASS`, `disposable_container_removal=PASS`, an empty diff and `exact_manifest_diff=PASS`. STOP: any checksum, decrypt, list, restore or diff failure. A counts-equal checksum mismatch means investigate; do not proceed to staging or cutover on this artifact. Take the backup again.

Record in your notes: `.age` size and sha256, manifest sha256, UTC timestamp, `list_entries`, diff result. The dump holds analytics data and the admin credential hash: treat it as a secret. `$RUN_DIR/DELETION_DEADLINE` holds the deletion rule (destroy 7 days after successful finalize).

---

## 3. Staging validation (workstation only, before the pin PR is written)

Never on the droplet: memory is the binding constraint there. Staging uses the same image digests production will use, `--platform linux/amd64` (emulated on non-amd64 hosts, so measured restore time overstates production), a unique project name, an internal-only network, no published ports, no Caddy, and throwaway secrets. Production secrets never reach the workstation. Run from a checkout of `main` (before the PR exists).

**S1. Resolve and freeze the PG18 digest, pull images.** Resolved once. A newer digest later does not change the pin; Renovate proposes it afterward.

```bash
( set -Eeuo pipefail
  test ! -s "$RUN_DIR/pg18.image" || { echo "pg18.image already frozen: $(cat "$RUN_DIR/pg18.image")"; exit 0; }
  digest="$(docker buildx imagetools inspect postgres:18-alpine --format '{{.Manifest.Digest}}')"
  case "$digest" in sha256:????????????????????????????????????????????????????????????????) ;; *) echo 'digest_format=FAIL' >&2; exit 1 ;; esac
  printf 'postgres:18-alpine@%s\n' "$digest" > "$RUN_DIR/pg18.image"
  cat "$RUN_DIR/pg18.image"
)
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "S1=STOP (rc=$rc); PG18_IMAGE not assigned" >&2; false
else
  PG18_IMAGE="$(cat "$RUN_DIR/pg18.image")"
  : "${PG18_IMAGE:?pg18.image empty}" "${PG15_IMAGE:?run P4 first}" "${UMAMI_IMAGE:?run P4 first}" \
    && docker pull --platform linux/amd64 "$PG18_IMAGE" > /dev/null \
    && docker pull --platform linux/amd64 "$PG15_IMAGE" > /dev/null \
    && docker pull --platform linux/amd64 "$UMAMI_IMAGE" > /dev/null \
    && docker run --rm --platform linux/amd64 --entrypoint uname "$PG18_IMAGE" -m
fi
```

The digest block runs standalone and the next lines branch on its `$?`; `PG18_IMAGE` is assigned in the parent shell only after it succeeded (it is also the already-frozen path when `pg18.image` exists). The pull chain stops at the first failure.

Expect: one `postgres:18-alpine@sha256:…` line saved to `pg18.image` and `x86_64`. STOP: digest not resolvable or emulation missing.

**S2. Decrypt the staging input and re-verify the artifact.** The plaintext stays under a 0700 directory until teardown (S10).

```bash
STAGE="$(cat "$RUN_DIR/stage.name" 2>/dev/null || echo "umami-pg18-stage-$(date +%s)")"
printf '%s\n' "$STAGE" > "$RUN_DIR/stage.name"
STAGE_DIR="$RUN_DIR/$STAGE"
( set -Eeuo pipefail
  umask 077
  mkdir -p "$STAGE_DIR"
  verify_age_artifact "$BACKUP_AGE" "$PG18_IMAGE"
  age -d -i <(age_identity) "$BACKUP_AGE" > "$STAGE_DIR/input.dump"
  test -s "$STAGE_DIR/input.dump"
  stat -f '%Sp %N' "$STAGE_DIR/input.dump" 2> /dev/null || stat -c '%A %n' "$STAGE_DIR/input.dump"
)
```

Expect: `list_entries=` greater than 0 from the PG18 `pg_restore --list`, `-rw-------` on `input.dump`. STOP: PG18 `pg_restore` cannot read the archive.

**S3. PG18 disposable restore (AGENTS.md block with the PG18 deltas).** `--tmpfs /var/lib/postgresql` (the PG18 data directory is not `/var/lib/postgresql/data`, so the old path would not isolate) and `docker rm -f -v` cleanup. This is the full adjusted command, packaged as `disposable_restore`:

```bash
( set -Eeuo pipefail
  disposable_restore "$PG18_IMAGE" /var/lib/postgresql "$BACKUP_AGE" "$RUN_DIR/stage.disposable.manifest"
  if ! diff -u "$BACKUP_MANIFEST" "$RUN_DIR/stage.disposable.manifest"; then echo 'staging_disposable_manifest_diff=FAIL' >&2; exit 1; fi
  echo 'staging_disposable_manifest_diff=PASS'
)
```

Expect: `disposable_container_removal=PASS`, empty diff. STOP: any difference.

**S4. Start the staged stack (production layout: named volume at `/var/lib/postgresql`, no `PGDATA`).**

```bash
( set -Eeuo pipefail
  umask 077
  : "${PG18_IMAGE:?run S1 first}" "${UMAMI_IMAGE:?run P4 first}"
  mkdir -p "$STAGE_DIR"
  pw="$(openssl rand -hex 24)"; secret="$(openssl rand -hex 32)"
  {
    printf 'POSTGRES_PASSWORD=%s\nAPP_SECRET=%s\n' "$pw" "$secret"
    printf 'DATABASE_URL=postgresql://umami:%s@db:5432/umami\n' "$pw"
    printf 'PG18_IMAGE=%s\nUMAMI_IMAGE=%s\n' "$PG18_IMAGE" "$UMAMI_IMAGE"
  } > "$STAGE_DIR/.env"
  cat > "$STAGE_DIR/compose.yaml" <<YAML
name: ${STAGE}
services:
  db:
    image: \${PG18_IMAGE}
    platform: linux/amd64
    environment:
      POSTGRES_DB: umami
      POSTGRES_USER: umami
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - umami-db-data-pg18:/var/lib/postgresql
    networks: [internal]
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U \$\${POSTGRES_USER} -d \$\${POSTGRES_DB}']
      interval: 5s
      timeout: 5s
      retries: 20
  umami:
    image: \${UMAMI_IMAGE}
    platform: linux/amd64
    environment:
      DATABASE_URL: \${DATABASE_URL}
      DATABASE_TYPE: postgresql
      APP_SECRET: \${APP_SECRET}
      DISABLE_TELEMETRY: '1'
      PRIVATE_MODE: '1'
    depends_on:
      db:
        condition: service_healthy
    networks: [internal]
    healthcheck:
      test: [CMD-SHELL, 'curl -f http://localhost:3000/api/heartbeat || exit 1']
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
networks:
  internal:
    internal: true
volumes:
  umami-db-data-pg18:
YAML
  docker compose -f "$STAGE_DIR/compose.yaml" up -d --wait --wait-timeout 300 db
)
```

Expect: `db` healthy. Only `db` starts; `umami` waits until S7. No `ports:` key exists anywhere in the file. The `umami` healthcheck is copied verbatim from `apps/umami/docker-compose.yaml`, so `up --wait` in S7 waits for real readiness (heartbeat) before logs are captured.

**S5. Layout, SCRAM and collation gates on the fresh staged cluster.**

```bash
( set -Eeuo pipefail
  DC_CMD="docker compose -f $STAGE_DIR/compose.yaml" EXPECT_VOLUME="${STAGE}_umami-db-data-pg18" \
    PG18_IMAGE="$PG18_IMAGE" "$LAYOUT_GATE" | tee "$RUN_DIR/stage.layout"
  grep '^db_collation=' "$RUN_DIR/stage.layout" > "$RUN_DIR/stage.init.collation"
  if ! diff -u "$RUN_DIR/preflight.collation" "$RUN_DIR/stage.init.collation"; then echo 'stage_collation_after_init=FAIL' >&2; exit 1; fi
  echo 'stage_collation_after_init=MATCH'
)
```

Expect: `layout_mount=PASS`, `layout_pgdata=PASS`, `layout_fresh_cluster=PASS`, `layout_scram=PASS`, `layout_tcp_probe=PASS`, `stage_collation_after_init=MATCH`. STOP: any FAIL line. A mismatched collation after init means the restored database's locale would differ; investigate before restoring.

**S6. Restore with the production flags; manifest gate; collation after restore; duration.** Forced drop of the pre-created database, then `pg_restore --exit-on-error --create --no-owner` connected to `postgres`.

```bash
( set -Eeuo pipefail
  sdc() { docker compose -f "$STAGE_DIR/compose.yaml" "$@"; }
  start=$(date +%s)
  sdc exec -T db psql -X -v ON_ERROR_STOP=1 -U umami -d postgres -c 'DROP DATABASE IF EXISTS umami WITH (FORCE);' < /dev/null
  sdc exec -T db pg_restore --exit-on-error --create --no-owner -U umami -d postgres < "$STAGE_DIR/input.dump"
  printf 'restore_seconds=%s\n' "$(( $(date +%s) - start ))"
  sdc exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami < "$MANIFEST_SQL" | LC_ALL=C sort > "$RUN_DIR/stage.restored.manifest"
  if ! diff -u "$BACKUP_MANIFEST" "$RUN_DIR/stage.restored.manifest"; then echo 'staging_manifest_diff=FAIL' >&2; exit 1; fi
  echo 'staging_manifest_diff=PASS'
  sdc exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami < "$IDENTITY_SQL" | grep '^db_collation=' > "$RUN_DIR/stage.restored.collation"
  if ! diff -u "$RUN_DIR/preflight.collation" "$RUN_DIR/stage.restored.collation"; then echo 'stage_collation_after_restore=FAIL' >&2; exit 1; fi
  echo 'stage_collation_after_restore=MATCH'
)
```

Expect: `staging_manifest_diff=PASS` (names, exact counts and checksums equal) and `stage_collation_after_restore=MATCH`. `restore_seconds` is an upper bound for production. STOP: any diff. Counts equal with a checksum mismatch means investigate; do not relax.

**S7. Boot the pinned umami image; Prisma must be a no-op.** The AGENTS.md lesson on the compose network applies: probe from inside the compose network, never a host port.

```bash
( set -Eeuo pipefail
  sdc() { docker compose -f "$STAGE_DIR/compose.yaml" "$@"; }
  sdc up -d --wait --wait-timeout 300 umami
  sdc logs --no-color umami > "$RUN_DIR/stage.umami.log" 2>&1
  grep -Ei 'migration|prisma|datasource' "$RUN_DIR/stage.umami.log" | tee "$RUN_DIR/stage.prisma.out" || true
  if grep -Eq 'Applying migration|migrations? (have been|was) applied' "$RUN_DIR/stage.prisma.out"; then echo 'prisma_noop=FAIL (migration applied)' >&2; exit 1; fi
  if ! grep -Eq 'No pending migrations to apply|already in sync' "$RUN_DIR/stage.prisma.out"; then echo 'prisma_noop=FAIL (no no-op marker in output)' >&2; exit 1; fi
  echo 'prisma_noop=PASS'
  sdc exec -T umami curl -fsS http://localhost:3000/api/heartbeat
)
```

Expect: `prisma_noop=PASS` (no pending migrations, no schema drift), heartbeat `{"ok":true}`. The boot also proves the image authenticates over SCRAM against PG18. STOP: any migration applied, drift message, or an unhealthy `umami`. Keep `stage.prisma.out` as evidence.

**S8. Retention check, apply and post-check on the staged cluster; integration test against the PG18 digest.** `retention.sh` takes `--compose-file`; its `docker compose --file` resolves the same project through the compose file's `name:`.

```bash
( set -Eeuo pipefail
  cd "$REPO_ROOT"
  C="$STAGE_DIR/compose.yaml"
  bash apps/umami/retention.sh --check --compose-file "$C" > "$RUN_DIR/stage.retention.check"
  bash apps/umami/retention.sh --apply --compose-file "$C" > "$RUN_DIR/stage.retention.apply"
  bash apps/umami/retention.sh --check --compose-file "$C" > "$RUN_DIR/stage.retention.post"
  if grep -Eq 'remaining=[1-9]|null_created_at=[1-9]' "$RUN_DIR/stage.retention.post"; then echo 'staging_postcheck=FAIL' >&2; exit 1; fi
  echo 'staging_retention=PASS'
)
```

Expect: all three exit 0 and `staging_retention=PASS`. STOP: any non-zero exit or nonzero remaining.

Integration test with a **local, uncommitted edit** of the image constant (Unit 3 lands the real change). Run from the `main` checkout:

```bash
( set -Eeuo pipefail
  cd "$REPO_ROOT"
  sed -i.pg15 "s|^const postgresImage = .*|const postgresImage = '${PG18_IMAGE}'|" apps/umami/retention.integration.test.ts
  trap 'mv -f apps/umami/retention.integration.test.ts.pg15 apps/umami/retention.integration.test.ts' EXIT
  NO_COLOR=1 DOCKER_DEFAULT_PLATFORM=linux/amd64 bun test apps/umami/retention.integration.test.ts 2>&1 | tee "$RUN_DIR/stage.integration.out"
  pass="$(sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' "$RUN_DIR/stage.integration.out")"
  fail="$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$RUN_DIR/stage.integration.out")"
  skip="$(sed -n 's/^ *\([0-9][0-9]*\) skip$/\1/p' "$RUN_DIR/stage.integration.out")"
  if [ "${pass:-0}" -ge 1 ] && [ "${fail:-1}" -eq 0 ] && [ "${skip:-0}" -eq 0 ]; then
    echo "integration_test=PASS pass=$pass fail=$fail skip=${skip:-0}"
  else
    echo "integration_test=FAIL pass=${pass:-?} fail=${fail:-?} skip=${skip:-?}" >&2; exit 1
  fi
)
git -C "$REPO_ROOT" status --short apps/umami/retention.integration.test.ts
```

Expect: a zero `bun test` exit (pipefail carries it through `tee`) and `integration_test=PASS`: `N pass` with N≥1, `0 fail`, and no `skip` line (Bun prints a `skip` line only when something was skipped, so absence means zero); the `git status` line is empty (edit reverted). STOP: any nonzero exit, a nonzero skip count (a skip is not evidence; fix Docker access and re-run), or a missing summary.

**S9. Rehearse the R4 revert on a restored copy.** Uses the real rollback artifact (`compose.pg15.yaml`: PG15 image, `umami-db-data`, `/var/lib/postgresql/data` mount) in its own project, with an override that makes the network internal. Only `db` starts, so nothing is published. The production revert itself is not run in advance.

```bash
( set -Eeuo pipefail
  umask 077
  R4="${STAGE}-r4"; R4_DIR="$STAGE_DIR/r4"
  mkdir -p "$R4_DIR"
  cp "$RUN_DIR/compose.pg15.yaml" "$R4_DIR/docker-compose.yaml"
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$R4_DIR/.env"
  printf 'networks:\n  default:\n    internal: true\n' > "$R4_DIR/override.yaml"
  rdc() { DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose -p "$R4" -f "$R4_DIR/docker-compose.yaml" -f "$R4_DIR/override.yaml" "$@"; }
  rdc up -d --wait --wait-timeout 300 db
  rdc exec -T db psql -X -v ON_ERROR_STOP=1 -U umami -d postgres -c 'DROP DATABASE IF EXISTS umami WITH (FORCE);' < /dev/null
  rdc exec -T db pg_restore --exit-on-error --create --no-owner -U umami -d postgres < "$STAGE_DIR/input.dump"
  rdc exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami < "$MANIFEST_SQL" | LC_ALL=C sort > "$RUN_DIR/stage.r4.manifest"
  if ! diff -u "$BACKUP_MANIFEST" "$RUN_DIR/stage.r4.manifest"; then echo 'r4_rehearsal_manifest_diff=FAIL' >&2; exit 1; fi
  echo 'r4_rehearsal_manifest_diff=PASS'
  rdc exec -T db psql -X -At -q -U umami -d umami -c 'SHOW data_directory' < /dev/null
  rdc down -v --remove-orphans
)
```

Expect: `r4_rehearsal_manifest_diff=PASS` and a `/var/lib/postgresql/data` data directory. STOP: any diff; the revert path is unproven and the cutover does not start.

**S10. Teardown (rigorous) and staging evidence.** Removes containers with their volumes, temp volumes, networks, the `.env`, the decrypted input and the whole staging directory. Then verifies nothing remains.

```bash
( set -Eeuo pipefail
  for p in "$STAGE" "${STAGE}-r4"; do
    docker ps -aq --filter "label=com.docker.compose.project=$p" | xargs -r docker rm -f -v
    docker volume ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker volume rm
    docker network ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker network rm
  done
  cp "$STAGE_DIR/compose.yaml" "$RUN_DIR/stage.compose.evidence.yaml"
  rm -rf "$STAGE_DIR"
  echo "left_containers=$(docker ps -aq --filter "name=$STAGE" | wc -l | tr -d ' ')"
  echo "left_volumes=$(docker volume ls -q | grep -c "$STAGE" || true)"
  echo "left_networks=$(docker network ls --format '{{.Name}}' | grep -c "$STAGE" || true)"
  test ! -e "$STAGE_DIR"
  echo 'plaintext_and_env_removed=PASS'
)
docker ps -a; docker volume ls; docker network ls
```

Expect: all three `left_*` counts `0` and `plaintext_and_env_removed=PASS`. No production secret copy exists on the workstation (none was ever created; `.env` values were throwaway). STOP: anything left; remove it by name before continuing.

Staging evidence for the Unit 3 PR, from `$RUN_DIR`: the frozen `pg18.image` digest, `stage.layout` (gate lines), `stage.prisma.out`, `stage.retention.*`, `stage.integration.out`, the two `PASS` manifest diffs, collation `MATCH` lines, `restore_seconds`, and `stage.compose.evidence.yaml`. Review for secrets before it leaves `$RUN_DIR` (hygiene rule at the top). **The pin PR is written only now**, from the frozen digest, and left review-approved and unmerged before step 4.

---

## 4. Cutover

Preconditions (all must hold):

- Staging evidence complete and reviewed (step 3), including S9.
- The pin PR is review-approved and **unmerged**. `PR_COMPOSE` points to its `apps/umami/docker-compose.yaml` in a PR-branch checkout.
- `AGE_RECIPIENT` and the identity (keychain) are available; the backup `.age` and `compose.pg15.yaml` exist.
- The window is outside 00:00–02:00 UTC.

**No step that stops PG15 `db` or touches the PG15 volume runs until the cutover dump (4.3) is encrypted, checksum-recorded and decrypt-tested (4.4).** Never run both majors at once on this host (memory). Never `docker compose down` and never remove `umami_umami-db-data` before finalize.

```bash
if [ "$(date -u +%H)" -ge 2 ]; then echo 'window_ok=PASS'; else echo 'window_ok=FAIL (inside 00:00-02:00 UTC)' >&2; false; fi
```

### 4.1 Disable the retention timer

Same as AGENTS.md Retention §7 (`systemctl disable --now umami-retention.timer && systemctl stop umami-retention.service`), then assert disabled/inactive/inactive. `retention_disable_assert` (shared helpers) does both:

```bash
retention_disable_assert
```

Expect: `timer_disabled_inactive=PASS`. STOP: any assertion fails (a running retention service can race the restore). Rollback: none needed. The timer stays disabled; it is re-armed only by the ENABLE gate in step 6. `deploy.ts` leaves a disabled timer disabled.

### 4.2 Deploy freeze

Only after 4.1. Holding environment approvals is not enough: the deploy-gate Discord notification invites approval. Cancel every waiting, queued, requested, pending or in-progress run of the umami deploy workflow and of the router (`deploy.yaml`, whose path filter can deploy umami). Cancelling a router run also cancels its other apps; re-dispatch those after the freeze clears. If an `in_progress` run was mid-deploy, the 4.3 state checks catch a half-applied stack. The helpers are defined in session setup; any `gh` listing failure makes the step fail, never read as zero runs.

```bash
freeze_cancel && freeze_assert
```

Expect: `freeze_runs_remaining=0`. STOP: any run remains, or any `freeze_listing=FAIL` / non-zero exit (fix `gh` auth or connectivity and repeat). Also: keep the hold on Renovate umami PRs and merge nothing to `main` that touches `apps/umami/**` (outside the path filter's doc/test exclusions). The freeze clears only after the pin PR merges and its deploy is approved. Re-run `freeze_cancel && freeze_assert` immediately before 4.6. Rollback: none; the freeze is lifted by the operator (step 6 and Unit 3).

### 4.3 Quiesce and final dump

Source manifest and `-Fc --create` dump from one write-quiesced PG15 state. This is the AGENTS.md Retention §2 dump **without its restart-on-exit trap**, so the stack stays quiesced on exit. If you abort before 4.5, run `restart_stack` deliberately. The dump streams over SSH into `age`; the droplet holds no dump.

```bash
( set -Eeuo pipefail
  "${SSH[@]}" "$DC stop caddy umami" >&2
  "${SSH[@]}" "$DC ps --status running --services" | tee "$RUN_DIR/cutover.running"
  if grep -Eq '^(umami|caddy)$' "$RUN_DIR/cutover.running"; then echo 'quiesce=FAIL' >&2; exit 1; fi
  sessions="$("${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami -c \"SELECT count(*) FROM pg_stat_activity WHERE datname = 'umami' AND backend_type = 'client backend' AND pid <> pg_backend_pid()\"")"
  [ "$sessions" = 0 ] || { echo "quiesce=FAIL sessions=$sessions" >&2; exit 1; }
  echo 'quiesce=PASS'
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$MANIFEST_SQL" \
    | LC_ALL=C sort > "$CUTOVER_MANIFEST"
  "${SSH[@]}" "$DC exec -T db pg_dump -Fc --create -U umami -d umami" \
    | age -r "$AGE_RECIPIENT" > "$CUTOVER_AGE.partial"
  mv "$CUTOVER_AGE.partial" "$CUTOVER_AGE"
  test -s "$CUTOVER_MANIFEST"; test -s "$CUTOVER_AGE"
  ( cd "$RUN_DIR" && shasum -a 256 cutover.dump.age | tee cutover.dump.age.sha256 && shasum -a 256 cutover.source.manifest )
)
```

Expect: `quiesce=PASS`, a non-empty `.age` and manifest, a recorded sha256. STOP: any non-zero exit. Rollback: `restart_stack` (PG15 compose still active). Delete a leftover `$CUTOVER_AGE.partial`.

### 4.4 Verify the cutover dump (hard gate)

Re-verify the recorded checksum, decrypt to a 0700 temp directory, run `pg_restore --list` in the pinned **PG18** image with no network (the binary that will restore it), delete the plaintext:

```bash
verify_age_artifact "$CUTOVER_AGE" "$PG18_IMAGE"
```

Expect: `cutover.dump.age: OK`, `list_entries=` greater than 0, `plaintext_removed=PASS`. STOP: anything else. Do not continue to 4.5. Run `restart_stack`, then redo 4.3.

### 4.5 Stop PG15 `db`; leave `umami_umami-db-data` untouched

Pre-pull the PG18 image on the droplet first (no state change), then stop the PG15 `db`:

```bash
( set -Eeuo pipefail
  : "${PG18_IMAGE:?run S1 first}"
  "${SSH[@]}" "docker pull '$PG18_IMAGE'" > /dev/null
  "${SSH[@]}" "$DC stop db"
  "${SSH[@]}" "$DC ps --status running --services" | tee "$RUN_DIR/cutover.running2"
  if grep -Fx 'db' "$RUN_DIR/cutover.running2"; then echo 'pg15_stopped=FAIL' >&2; exit 1; fi
  "${SSH[@]}" 'docker volume inspect umami_umami-db-data --format "{{.Name}}"'
  echo 'pg15_stopped=PASS'
)
```

Expect: `pg15_stopped=PASS`, the anchor volume still present. Rollback: `"${SSH[@]}" "$DC start db"` on the unchanged PG15 compose, then `restart_stack`.

### 4.6 Switch the droplet compose by hand; start only PG18 `db`

`deploy.ts` is frozen. Image pin, volume key and mount destination change together or not at all; a mixed combination is the silent empty-init case. The PG18 `db` starts against the NEW empty volume and re-bakes the `umami` role password from the unchanged `/opt/umami/.env`.

```bash
PR_COMPOSE="${PR_COMPOSE:?Set PR_COMPOSE to apps/umami/docker-compose.yaml from the PR branch checkout}"
( set -Eeuo pipefail
  : "${PG18_IMAGE:?run S1 first}"
  freeze_assert
  now="$("${SSH[@]}" 'cat /opt/umami/docker-compose.yaml' | shasum -a 256 | cut -d' ' -f1)"
  want="$(cut -d' ' -f1 "$RUN_DIR/compose.pg15.yaml.sha256")"
  [ "$now" = "$want" ] || { echo 'droplet_compose_drift=FAIL (a deploy ran?)' >&2; exit 1; }
  for line in "    image: ${PG18_IMAGE}" '      - umami-db-data-pg18:/var/lib/postgresql' '  umami-db-data-pg18:'; do
    grep -Fxq -- "$line" "$PR_COMPOSE" || { echo "pr_compose_layout=FAIL (missing line: $line)" >&2; exit 1; }
  done
  if grep -Eq '/var/lib/postgresql/data|PGDATA' "$PR_COMPOSE"; then echo 'pr_compose_layout=FAIL' >&2; exit 1; fi
  echo 'pr_compose_layout=PASS'
  "${SSH[@]}" 'cat > /opt/umami/docker-compose.yaml.new && mv -f /opt/umami/docker-compose.yaml.new /opt/umami/docker-compose.yaml' < "$PR_COMPOSE"
  remote="$("${SSH[@]}" 'sha256sum /opt/umami/docker-compose.yaml' | cut -d' ' -f1)"
  [ "$remote" = "$(shasum -a 256 "$PR_COMPOSE" | cut -d' ' -f1)" ] || { echo 'droplet_compose_matches_pr=FAIL' >&2; exit 1; }
  echo 'droplet_compose_matches_pr=PASS'
  "${SSH[@]}" "$DC config --quiet"
  "${SSH[@]}" "$DC up -d --wait --wait-timeout 180 db"
)
```

Expect: `pr_compose_layout=PASS`, `droplet_compose_matches_pr=PASS`, `db` healthy. Healthy proves nothing about data; 4.7 does. STOP: any FAIL line, especially `droplet_compose_drift` (a deploy ran in the freeze). A PG18 `db` that exits at start with a message about data in `/var/lib/postgresql/data` means the mount destination is wrong (observed with the PG18 image when a volume is mounted there). Rollback (pre-Caddy revert): the explicit sequence in section 7.1. Do not start `umami`.

### 4.7 Layout gates (hard stop before restore)

```bash
( set -Eeuo pipefail
  "${SSH[@]}" "DC_CMD='$DC' EXPECT_VOLUME=umami_umami-db-data-pg18 PG18_IMAGE='$PG18_IMAGE' bash -s" < "$LAYOUT_GATE" | tee "$RUN_DIR/cutover.layout"
  grep '^db_collation=' "$RUN_DIR/cutover.layout" > "$RUN_DIR/cutover.init.collation"
  if ! diff -u "$RUN_DIR/preflight.collation" "$RUN_DIR/cutover.init.collation"; then echo 'cutover_collation_after_init=FAIL' >&2; exit 1; fi
  echo 'cutover_collation_after_init=MATCH'
  "${SSH[@]}" 'docker volume ls --format "{{.Name}}"' | grep -E '^umami_' | tee "$RUN_DIR/cutover.volumes"
)
```

Expect: exactly `layout_mount=PASS`, `layout_pgdata=PASS`, `layout_fresh_cluster=PASS`, `layout_scram=PASS`, `layout_tcp_probe=PASS`, `cutover_collation_after_init=MATCH`; the mount line is `volume umami_umami-db-data-pg18 /var/lib/postgresql`; the volume list shows the anchor and the new volume and no anonymous (hash-named) volume. STOP: any FAIL or MISMATCH, or a non-empty cluster. Revert per 7.1. Never restore into a cluster that failed a layout gate.

### 4.8 Restore with the staging-validated flags; manifest gate before umami

Forced drop of the pre-created database on the fresh PG18 cluster, then `pg_restore --exit-on-error --create --no-owner` through the `postgres` database. The decrypt streams straight into the SSH session; no plaintext touches either disk.

```bash
( set -Eeuo pipefail
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -U umami -d postgres -c 'DROP DATABASE IF EXISTS umami WITH (FORCE);'" < /dev/null
  age -d -i <(age_identity) "$CUTOVER_AGE" \
    | "${SSH[@]}" "$DC exec -T db pg_restore --exit-on-error --create --no-owner -U umami -d postgres"
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$MANIFEST_SQL" \
    | LC_ALL=C sort > "$CUTOVER_RESTORED"
  if ! diff -u "$CUTOVER_MANIFEST" "$CUTOVER_RESTORED"; then echo 'cutover_manifest_diff=FAIL' >&2; exit 1; fi
  echo 'cutover_manifest_diff=PASS'
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$IDENTITY_SQL" | tee "$RUN_DIR/cutover.restored.identity"
  grep '^db_collation=' "$RUN_DIR/cutover.restored.identity" > "$RUN_DIR/cutover.restored.collation"
  if ! diff -u "$RUN_DIR/preflight.collation" "$RUN_DIR/cutover.restored.collation"; then echo 'cutover_collation_after_restore=FAIL' >&2; exit 1; fi
  echo 'cutover_collation_after_restore=MATCH'
  ( cd "$RUN_DIR" && shasum -a 256 cutover.restored.manifest )
)
```

Expect: `cutover_manifest_diff=PASS` (names, exact counts, checksums equal to the quiesced source) and `cutover_collation_after_restore=MATCH`. STOP: any diff (counts equal with a checksum mismatch included) or restore error. Do not start `umami`. Rollback: a failed restore on the fresh cluster is idempotent (the drop above clears it), so retry once after the cause is understood; otherwise revert per 7.1.

### 4.9 Start `umami` (internal only)

Do not run admin rotation or `deploy.ts`: admin state comes from the dump. Probes run inside the compose network (the AGENTS.md lesson: never a host `localhost:3000`).

```bash
( set -Eeuo pipefail
  since="$("${SSH[@]}" 'date -u +%Y-%m-%dT%H:%M:%SZ')"
  "${SSH[@]}" "$DC up -d --wait --wait-timeout 180 umami"
  "${SSH[@]}" "$DC logs --no-color --since '$since' umami" > "$RUN_DIR/cutover.umami.log" 2>&1
  grep -Ei 'migration|prisma|datasource' "$RUN_DIR/cutover.umami.log" | tee "$RUN_DIR/cutover.prisma.out" || true
  if grep -Eq 'Applying migration|migrations? (have been|was) applied' "$RUN_DIR/cutover.prisma.out"; then echo 'prisma_noop=FAIL (migration applied)' >&2; exit 1; fi
  if ! grep -Eq 'No pending migrations to apply|already in sync' "$RUN_DIR/cutover.prisma.out"; then echo 'prisma_noop=FAIL (no no-op marker in output)' >&2; exit 1; fi
  echo 'prisma_noop=PASS'
  "${SSH[@]}" "$DC exec -T umami curl -fsS http://localhost:3000/api/heartbeat"
)
```

Expect: `prisma_noop=PASS` and `{"ok":true}`. STOP: any applied migration, drift message, or unhealthy `umami`. Rollback: `"${SSH[@]}" "$DC stop umami"`, then 7.1 (still pre-Caddy).

### 4.10 Start `caddy`: the point of no return

Re-assert the freeze first. After Caddy starts, writes land only in PG18; rollback is lossy (7.2).

```bash
( set -Eeuo pipefail
  freeze_assert
  "${SSH[@]}" "$DC up -d --wait --wait-timeout 180 caddy"
  date -u +'caddy_started_utc=%Y-%m-%dT%H:%M:%SZ' | tee "$RUN_DIR/caddy.started"
  curl -fsS "https://${HOST}/api/heartbeat"
)
```

Expect: `{"ok":true}` on the public heartbeat. STOP: no heartbeat. Do not revert reflexively; diagnose (`$DC logs caddy umami`), because 7.1 no longer applies.

---

## 5. Sentinel verification (R3, read-only)

The cutover is manual and the sentinel is never touched: it lives outside the volume and the password did not change. Verify only.

```bash
sentinel_check
```

Expect: `sentinel_size_mode=64 600` and `MATCH`. STOP: `MISMATCH`; do not edit the sentinel by hand. Investigate the password and `.env` provenance (AGENTS.md Secret rotation explains the coupling).

After the pin PR merges and the first `umami deploy` is approved, confirm the guard passed and rewrote identical content, and the re-armed timer survived. Capture the hash-of-sentinel in a shell variable only (never printed):

```bash
before="$("${SSH[@]}" 'sha256sum < /opt/umami/.db-password-fingerprint')"   # run BEFORE approving the deploy
# ...approve and let the deploy finish, then:
after="$("${SSH[@]}" 'sha256sum < /opt/umami/.db-password-fingerprint')"
if [ "$before" = "$after" ]; then echo 'sentinel_rewrite=UNCHANGED'; else echo 'sentinel_rewrite=CHANGED' >&2; false; fi \
  && sentinel_check \
  && "${SSH[@]}" 'systemctl is-active umami-retention.timer'
```

Expect: `UNCHANGED`, `MATCH`, `active`. STOP: a deploy that aborts on the fingerprint guard or leaves the timer inactive; keep the freeze and investigate.

---

## 6. Cutover verification, then supervised PG18 retention (R2, R8)

### 6.1 Verify the live stack

The pre-umami manifest gate result is the `cutover_manifest_diff=PASS` from 4.8 (restored equals quiesced source). After Caddy, only assert nothing shrank:

```bash
( set -Eeuo pipefail
  curl -fsS "https://${HOST}/api/heartbeat"; echo
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$IDENTITY_SQL" | tee "$RUN_DIR/live.identity"
  grep -Eq '^server_version=18\.' "$RUN_DIR/live.identity" || { echo 'server_version_is_pg18_target=FAIL' >&2; exit 1; }
  echo 'server_version_is_pg18_target=PASS'
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$MANIFEST_SQL" | LC_ALL=C sort > "$RUN_DIR/live.manifest"
  if ! diff <(cut -d'|' -f1 "$CUTOVER_MANIFEST") <(cut -d'|' -f1 "$RUN_DIR/live.manifest"); then echo 'table_set=FAIL' >&2; exit 1; fi
  echo 'table_set=EQUAL'
  if ! paste -d'|' <(cut -d'|' -f1,2 "$CUTOVER_MANIFEST") <(cut -d'|' -f2 "$RUN_DIR/live.manifest") \
    | awk -F'|' '$3 < $2 { print "BELOW:" $1; bad = 1 } END { exit bad }'; then echo 'counts_not_below_source=FAIL' >&2; exit 1; fi
  echo 'counts_not_below_source=PASS'
  sys="$("${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami -c \"SELECT count(*) || '|' || md5(string_agg(website_id::text, ',' ORDER BY website_id::text)) FROM website WHERE name = 'systematic'\"")"
  [ "$sys" = "$(cat "$RUN_DIR/preflight.systematic")|$(cat "$RUN_DIR/preflight.systematic.id")" ] || { echo 'systematic_website_id=FAIL' >&2; exit 1; }
  echo 'systematic_website_id=PRESERVED'
  priv="$("${SSH[@]}" "$DC exec -T umami printenv PRIVATE_MODE DISABLE_TELEMETRY" | paste -sd, -)"
  [ "$priv" = '1,1' ] || { echo 'privacy_invariants=FAIL' >&2; exit 1; }
  echo 'privacy_invariants=PASS'
  now="$("${SSH[@]}" 'stat -c env_mtime=%Y /opt/umami/.env')"
  grep -Fx "$now" "$RUN_DIR/preflight.host" > /dev/null || { echo 'env_untouched=FAIL' >&2; exit 1; }
  echo 'env_untouched=PASS'
)
```

Expect: every line above prints its `PASS`, `EQUAL` or `PRESERVED` token. STOP: any missing token or `BELOW:` row.

Manual (record pass/fail only): authenticated login at the public host with the existing admin credential succeeds (do not rotate or change it); the public surfaces in AGENTS.md Retention §5 serve; `https://${HOST}` renders. Heartbeat green is not enough on its own.

### 6.2 Recovery-point evidence for PG18

The recovery point for the supervised apply is the decrypt-tested cutover dump. No new dump is taken; it predates any writes since Caddy started, and that is acceptable because rollback past this point is already lossy. Run the PG18 disposable restore (the delta command) on it so the evidence record has the same fields as before:

```bash
( set -Eeuo pipefail
  verify_age_artifact "$CUTOVER_AGE" "$PG18_IMAGE"
  disposable_restore "$PG18_IMAGE" /var/lib/postgresql "$CUTOVER_AGE" "$RUN_DIR/cutover.disposable.manifest"
  if ! diff -u "$CUTOVER_MANIFEST" "$RUN_DIR/cutover.disposable.manifest"; then echo 'cutover_disposable_diff=FAIL' >&2; exit 1; fi
  echo 'cutover_disposable_diff=PASS'
)
```

Expect: `cutover.dump.age: OK`, `plaintext_removed=PASS`, `disposable_container_removal=PASS`, `cutover_disposable_diff=PASS`. STOP: any failure; `--apply` does not run.

### 6.3 Supervised retention on PG18

A Postgres major invalidates the PG15 retention evidence. Run, in order, from `apps/umami/AGENTS.md`:

1. **Retention §1** from the **PR branch checkout** (re-run the setup block there so `REPO_ROOT` and the pinned `.github/known_hosts` come from that checkout; the expected images are then the PG18 pins, and this is the confirming check that the droplet compose and the PR compose agree). Its bare `ssh "$REMOTE"` calls run through the pinned-options `ssh` wrapper from session setup. The same applies to §3 to §7.
2. **Retention §3** `--check` with exact counts. Zero null timestamps, a stable orphan baseline.
3. **Retention §4** supervised `--apply`, behind its typed `APPLY UMAMI RETENTION` prompt. Backup receipt = the decrypt-tested `cutover.dump.age` checksum from 4.3/6.2. Do not batch or retry a failed apply without investigation.
4. **Retention §5** post-check (every table `remaining=0`, no positive orphan delta, zero nulls) and the service checks.
5. Fill the PG18 evidence record from `apps/umami/evidence/retention/TEMPLATE.md`, named per `apps/umami/evidence/retention/README.md`. Set the Umami and Postgres image strings to the PG18 pins and the disposable restore image and isolation to `--network none; tmpfs /var/lib/postgresql`. Hygiene: digests, counts, checksums, pass/fail only.
6. **Retention §6** ENABLE gate: `ENABLE UMAMI RETENTION`, stay present for a possible catch-up run. The supervised apply and post-check are not overridable.

Expect: each step passes in order. STOP: any failure keeps the timer disabled; fix forward and repeat the failed gate. Rollback: Retention §7 disables the timer again. The data state is covered by section 7.2.

---

## 7. Rollback matrix (R4)

Caddy start (4.10) is the point of no return.

| Situation | Action | Data |
| --- | --- | --- |
| Before Caddy starts | 7.1 explicit revert | none lost: the PG15 volume saw no writes after quiesce |
| After Caddy starts | roll forward by default; 7.2 only on a recorded data-loss decision | PG18 writes since Caddy start are discarded |
| Off-droplet dump | restores into PG15 or PG18 only (7.3) | as of the dump |
| Pin PR already merged | revert it as one change (7.4) | n/a |

### 7.1 Pre-Caddy revert (explicit sequence)

Uses the compose artifact saved in pre-flight. Image, volume key and mount destination revert together. Never `down`, never touch `umami_umami-db-data`. The first step disables and stops the retention timer and service and asserts disabled/inactive/inactive **before any database switch**, so the timer can never fire against the reverted PG15. After a post-cutover re-arm (step 6) this step is what disarms it; before the cutover's own 4.1 it is a harmless repeat. A failed comparison exits before `restart_stack`, so the stack stays quiesced.

```bash
( set -Eeuo pipefail
  retention_disable_assert
  freeze_assert
  "${SSH[@]}" "$DC stop umami caddy db"
  "${SSH[@]}" 'cat > /opt/umami/docker-compose.yaml.new && mv -f /opt/umami/docker-compose.yaml.new /opt/umami/docker-compose.yaml' < "$RUN_DIR/compose.pg15.yaml"
  remote="$("${SSH[@]}" 'sha256sum /opt/umami/docker-compose.yaml' | cut -d' ' -f1)"
  [ "$remote" = "$(cut -d' ' -f1 "$RUN_DIR/compose.pg15.yaml.sha256")" ] || { echo 'compose_reverted=FAIL' >&2; exit 1; }
  echo 'compose_reverted=PASS'
  "${SSH[@]}" "$DC up -d --wait --wait-timeout 180 db"
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$MANIFEST_SQL" \
    | LC_ALL=C sort > "$RUN_DIR/revert.manifest"
  if ! diff -u "$CUTOVER_MANIFEST" "$RUN_DIR/revert.manifest"; then echo 'revert_manifest_diff=FAIL (stack left quiesced)' >&2; exit 1; fi
  echo 'revert_manifest_diff=PASS'
  "${SSH[@]}" "$DC exec -T db psql -X -At -q -U umami -d umami -c 'SHOW data_directory'" < /dev/null
  restart_stack
)
```

Expect: `timer_disabled_inactive=PASS`, `freeze_runs_remaining=0`, `compose_reverted=PASS`, `revert_manifest_diff=PASS` (PG15 manifest equals the quiesced source), data directory `/var/lib/postgresql/data`, heartbeat green. The timer stays disabled; re-arm only through Retention §6 after the migration is retried or abandoned. STOP: a manifest diff on the PG15 volume. Do not start `umami`; the off-droplet `.age` dumps are the next recovery source (7.3).

Before retrying the cutover, remove the abandoned PG18 volume only after confirming no container uses it:

```bash
( set -Eeuo pipefail
  users="$("${SSH[@]}" 'docker ps -aq --filter volume=umami_umami-db-data-pg18')"
  [ -z "$users" ] || { echo 'pg18_volume_in_use=FAIL' >&2; exit 1; }
  "${SSH[@]}" 'docker volume rm umami_umami-db-data-pg18'
)
```

### 7.2 After Caddy starts (lossy, explicit decision)

PG18 dumps cannot load into PG15, so rolling back discards PG18 writes since Caddy start. Roll forward is the default. To roll back, record the decision (who, when, why), and keep a PG18 forensic dump (it restores into PG18 only):

```bash
( set -Eeuo pipefail
  read -r -p 'Type ROLL BACK UMAMI TO PG15 AND DISCARD PG18 WRITES to continue: ' ok
  [ "$ok" = 'ROLL BACK UMAMI TO PG15 AND DISCARD PG18 WRITES' ]
  retention_disable_assert
  "${SSH[@]}" "$DC exec -T db pg_dump -Fc --create -U umami -d umami" | age -r "$AGE_RECIPIENT" > "$RUN_DIR/pg18-forensic.dump.age"
  ( cd "$RUN_DIR" && shasum -a 256 pg18-forensic.dump.age | tee pg18-forensic.dump.age.sha256 )
)
```

The timer is disabled and asserted inactive here, before the dump, and again as the first step of 7.1. Then run 7.1. Its final `diff` compares against the cutover source manifest, so it also states exactly what was discarded.

### 7.3 Off-droplet dump restore

The PG15 dump restores into PG15 or PG18 only, and only into a stack whose running compose matches the target. This is the AGENTS.md Backup & restore emergency-restore block adjusted for an encrypted archive and the pinned SSH array: no `$BACKUP` plaintext file, the archive is checksum-validated first, and `age` streams into the remote `pg_restore` under `pipefail`, so an `age` failure fails the step. Deviation from AGENTS.md: on any failure the stack is left quiesced (not restarted) and the retention timer stays disabled; restart only after the cause is understood. Never replay into a non-empty `umami` database; the forced drop below is the only reset.

```bash
( set -Eeuo pipefail
  ( cd "$RUN_DIR" && shasum -a 256 -c cutover.dump.age.sha256 )
  on_exit() {
    s=$?; trap - EXIT
    if [ "$s" -ne 0 ]; then echo 'emergency restore FAILED: NO-GO; stack left quiesced, timer disabled' >&2; fi
    exit "$s"
  }
  trap on_exit EXIT
  retention_disable_assert
  "${SSH[@]}" "$DC stop caddy umami"
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -U umami -d postgres -c 'DROP DATABASE IF EXISTS umami WITH (FORCE);'" < /dev/null
  age -d -i <(age_identity) "$CUTOVER_AGE" \
    | "${SSH[@]}" "$DC exec -T db pg_restore --exit-on-error --create --no-owner -U umami -d postgres"
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$MANIFEST_SQL" \
    | LC_ALL=C sort > "$RUN_DIR/emergency.restored.manifest"
  if ! diff -u "$CUTOVER_MANIFEST" "$RUN_DIR/emergency.restored.manifest"; then echo 'emergency_manifest_diff=FAIL' >&2; exit 1; fi
  echo 'emergency_manifest_diff=PASS'
  restart_stack
)
```

Expect: `shasum` `OK`, `timer_disabled_inactive=PASS`, `emergency_manifest_diff=PASS`, then a green restart/heartbeat. STOP: any failure; the dump is the recovery source, not a reason to improvise.

### 7.4 Repo state

If the pin PR already merged, revert it as one change (image, key, mount destination) and keep the deploy freeze until `main` and the droplet agree. The authority when they conflict is the droplet's running volume identity (`docker inspect` on the `db` mount); bring `main` to match before any deploy is approved. Never run a mixed combination (PG18 image on the old path, PG15 image on the new key, new key on the old path). Also keep Renovate umami PRs on hold.

---

## 8. Finalize

**Final confirmation = 7 days of healthy production operation**: heartbeat green plus at least one clean no-op `umami deploy` (sentinel guard passed, timer still active, per section 5). Only then:

```bash
( set -Eeuo pipefail
  curl -fsS "https://${HOST}/api/heartbeat"; echo
  "${SSH[@]}" "$DC exec -T db psql -X -v ON_ERROR_STOP=1 -At -q -U umami -d umami" < "$IDENTITY_SQL" | grep -E '^server_version=18\.'
  users="$("${SSH[@]}" 'docker ps -aq --filter volume=umami_umami-db-data')"
  [ -z "$users" ] || { echo 'anchor_unreferenced=FAIL' >&2; exit 1; }
  echo 'anchor_unreferenced=PASS'
  refs="$("${SSH[@]}" "grep -cF 'umami-db-data:' /opt/umami/docker-compose.yaml || true")"
  [ "$refs" = 0 ] || { echo 'compose_references_anchor=FAIL' >&2; exit 1; }
  read -r -p 'Type REMOVE UMAMI PG15 VOLUME to destroy the rollback anchor: ' ok
  [ "$ok" = 'REMOVE UMAMI PG15 VOLUME' ]
  "${SSH[@]}" 'docker volume rm umami_umami-db-data'
  "${SSH[@]}" 'docker volume ls --format "{{.Name}}"' | grep -E '^umami_'
)
```

Expect: PG18 target version, `anchor_unreferenced=PASS`, and the volume list showing only `umami_umami-db-data-pg18` (plus the caddy volumes). Rollback: none; this is irreversible. The off-droplet `.age` dumps are the only fallback, which is why they outlive finalize.

Then set the dump deletion date and destroy the encrypted dumps on the workstation at that date, including `backup.dump.age`, `cutover.dump.age`, any `pg18-forensic.dump.age`, and their manifests:

```bash
destroy_by="$(date -u -v+7d +%F 2>/dev/null || date -u -d '+7 days' +%F)"
printf 'destroy_by=%s\n' "$destroy_by" > "$RUN_DIR/DELETION_DEADLINE"
cat "$RUN_DIR/DELETION_DEADLINE"
```

At that date, after the dumps are destroyed, delete the migration identity: `security delete-generic-password -a umami-pg18-migration -s umami-pg18-age`.

## Related

- Plan: [`docs/plans/2026-06-01-001-feat-umami-postgres-major-upgrade-plan.md`](../plans/2026-06-01-001-feat-umami-postgres-major-upgrade-plan.md)
- [`apps/umami/AGENTS.md`](../../apps/umami/AGENTS.md): Backup & restore, Retention operator runbook, Secret rotation
- [`docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`](../solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md): volume-coupled password, admin rotation over the compose network
- [`docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md`](../solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md)
- [`docs/runbooks/deploy-gate-notifications.md`](deploy-gate-notifications.md)
