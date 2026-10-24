---
title: 'feat: Umami Postgres 15→18 major-version migration'
type: feat
status: active
date: 2026-06-01
deepened: 2026-10-24
---

# Umami Postgres 15→18 major-version migration

## Overview

The self-hosted Umami analytics stack on `metrics.fro.bot` runs **PostgreSQL 15** (`postgres:15-alpine`, digest-pinned). Renovate's dependency dashboard offers a major bump to Postgres 18. A Postgres major upgrade cannot be applied by swapping the image tag: PG18 binaries refuse to start against a PG15 on-disk data directory, and the PG18 image changes the data-directory layout (`PGDATA` and the declared volume path), so a naive bump + deploy either bricks the `db` container (`up -d --wait` times out, stack down) or — worse — initializes an empty cluster on a stray volume and looks healthy.

This plan defines a deliberate, runbook-driven migration via **logical dump/restore** into a fresh PG18 cluster on a new named volume, with the old PG15 volume preserved as the rollback anchor until Caddy starts, and a throwaway staging restore on the operator workstation to prove compatibility before any production downtime.

**Live state (preflight, read-only, 2026-10-24):** PG `15.19` on `postgres:15-alpine`; umami image `3.4.1`; database `umami` is **14 MB across 27 public base tables**. Exact row counts: `website` 3, `session` 1431, `website_event` 2694, `user` 1, `_prisma_migrations` 26. `password_encryption=scram-sha-256` and the `umami` role verifier is SCRAM. `pg_hba`: `local` and loopback `trust`, `host all all all scram-sha-256`. Collation `en_US.utf8`, libc provider. Droplet `s-1vcpu-1gb`: 957 MB RAM with about **245 MB available and no swap** (RSS: umami 271 MiB, db 45 MiB, caddy 16 MiB), 7.9 GB disk free. The data volume `umami_umami-db-data` is mounted at `/var/lib/postgresql/data`. The fingerprint sentinel is present (64 bytes, mode 600) at `/opt/umami/.db-password-fingerprint`, outside the volume.

The dataset is tiny, so dump/restore takes seconds and `pg_upgrade` is unnecessary (and impractical — the alpine image ships only one major's binaries, so the two-major-co-resident requirement of `pg_upgrade` can't be met without a custom image). The binding constraint is **host memory, not disk**: a second Node + Postgres stack on the droplet would OOM production, so staging runs on the operator workstation.

**Status and decision:** Unit 1 (the Renovate guard) shipped. Units 2–3 are now being executed by operator decision. PostgreSQL 15 is community-supported until **November 2027**, so this is deliberate modernization, not urgency. What stays unacceptable is an unattended major bump reaching the deploy path; Unit 1 closes that regardless of when the migration runs.

**Recommended path:** Unit 1 (shipped) → Unit 2 runbook, including the workstation staging gate → write the pin PR from the staging-validated digests and get it review-approved but unmerged → Unit 3 cutover in a window outside 00:00–02:00 UTC.

## Problem Frame

A major Postgres version bump is a data-directory format change, not a drop-in image swap. The umami deploy (`apps/umami/src/deploy.ts`) brings the stack up with `docker compose up -d --wait --wait-timeout 180 db umami` against the existing named volume `umami-db-data` (mounted at `/var/lib/postgresql/data`, the PG15 image's `PGDATA` location). If the pinned image's major changes, that command starts the new binary against the old cluster and fails. Five properties make this delicate:

1. **No automated backup/restore exists** — only the manual `pg_dump`/`psql` procedures in `apps/umami/AGENTS.md` (the "Backup & restore" runbook and the quiesced recovery-point block in the retention runbook). There is no `umami backup` CLI command.
2. **The DB password is volume-coupled** — `POSTGRES_PASSWORD` is baked into the cluster at first init. A fresh PG18 volume re-initializes the `umami` role's password from `${POSTGRES_PASSWORD}` in `/opt/umami/.env`. The deploy enforces a fingerprint sentinel (`/opt/umami/.db-password-fingerprint`) and aborts on mismatch. The sentinel lives outside the volume, so init does not touch it, and the password does not change.
3. **Renovate already watches `postgres`** (`.github/renovate.json5` has a docker packageRule producing standalone PRs), so without a guard a major bump can flow to a gated deploy.
4. **The PG18 image moves the data directory.** The official PG18 image sets `PGDATA=/var/lib/postgresql/18/docker` and declares `VOLUME /var/lib/postgresql`; mounts must target `/var/lib/postgresql`. With the mount left at the PG15 path, initdb writes to an anonymous volume, `pg_isready` passes on an **empty cluster**, and `deploy.ts` then succeeds against default admin credentials, rotates them, and looks healthy with zero data. This failure is silent, so it needs explicit gates, not reliance on health checks.
5. **Other automation acts during the window.** `deploy.ts` overwrites the droplet's `docker-compose.yaml` with `main`'s copy on every deploy and restarts an active retention timer. The retention timer (`apps/umami/systemd/umami-retention.timer`) is armed and fires daily at about 00:30–01:00 UTC; its service runs up to 30 minutes and can race a restore.

## Requirements Trace

- R1. A Postgres major bump can never auto-flow to a destructive deploy — major versions require explicit, deliberate migration.
- R2. The migration preserves all Umami application data with zero loss: the source manifest (table names plus exact row counts, captured from the quiesced source) equals the restored manifest before umami starts.
- R3. The migration preserves DB-auth coherence: the `umami` role password on the new cluster equals the current `UMAMI_DB_PASSWORD`, and the `.db-password-fingerprint` sentinel is untouched and verified (present, matches the computed hash, never printed) so the next normal deploy is a sentinel no-op. After init on PG18, `password_encryption` is `scram-sha-256` and the role verifier starts with `SCRAM-SHA-256$`.
- R4. Until Caddy starts, rollback to the untouched PG15 volume is zero-loss and tested. After Caddy starts, rollback discards PG18 writes since then and requires an explicit data-loss decision. Caddy start is the point of no return.
- R5. The pinned umami image boots against a restored PG18 cluster, Prisma migrations are no-ops, and retention check/apply pass on PG18, proven in staging before production downtime.
- R6. The procedure is captured as a durable operator runbook in `docs/runbooks/`, consistent with the existing `discord-token-lifecycle.md`.
- R7. The PG18 `db` mounts exactly one named volume at `/var/lib/postgresql` with the image-default `PGDATA` (no override), asserted before restore. Image pin, volume key, and mount destination change together or not at all.
- R8. Through the cutover window the retention timer is disabled and asserted inactive, and no `umami` deploy runs. The timer is re-armed only through the existing ENABLE gate, once cutover verification passes on PG18.

## Scope Boundaries

- **Not** migrating to any target other than the latest `postgres:18-alpine` (e.g., not stopping at 16 or 17 — logical dump/restore crosses multiple majors in one step, so an intermediate hop adds risk without benefit).
- **Not** codifying dump/restore/`pg_upgrade` logic into `apps/umami/src/deploy.ts`. This is a one-time operational event; embedding migration machinery into the recurring deploy path is unjustified complexity (YAGNI). The deploy path's only required property — never recreate the volume on its own — already holds.
- **Not** changing the Umami application version, the Caddy version, droplet size, or region.
- **Not** rotating `UMAMI_DB_PASSWORD`, `UMAMI_APP_SECRET`, or the admin password as part of this work (the fresh cluster re-bakes the existing DB password unchanged; admin/app state is restored from the dump).
- **Not** changing retention policy, SQL, or timer units. The timer is only disabled for the window and re-armed through its existing gate.
- **Not** introducing a recurring backup system. A standing backup cadence is worth considering but is its own task.

### Deferred to Separate Tasks

- Recurring/scheduled Umami DB backups (cron or volume snapshot): future task, separate from this one-time migration.
- A general `umami backup` / `umami restore` CLI command: future task if a backup cadence is adopted.

## Context & Research

### Relevant Code and Patterns

- `apps/umami/docker-compose.yaml` — `db` service pins `postgres:15-alpine@sha256:...` (line 45), mounts `umami-db-data:/var/lib/postgresql/data` (line 55), declares the top-level `umami-db-data` volume (line 65), env `POSTGRES_DB=umami` / `POSTGRES_USER=umami` / `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-}`. `db` healthcheck is `pg_isready -U umami -d umami` — it passes on an empty cluster, so it proves nothing about data.
- `apps/umami/src/deploy.ts` — reads the fingerprint sentinel and aborts on mismatch (Phase 4), uploads `docker-compose.yaml` from `main` on **every** deploy (Phase 6), brings up `db umami` with `up -d --wait --wait-timeout 180`, rotates admin, starts `caddy`, then rewrites the sentinel unconditionally with the computed value (Phase 11; identical content when the password is unchanged). `computeDbPasswordFingerprint` is `sha256` over `"umami-db-pw-v1:" + password`. Phase 12 restarts an **active** retention timer, starts an enabled-but-inactive one, and leaves a disabled one disabled. Never runs `down`/`down -v`; builds `DATABASE_URL=postgresql://umami:${encodeURIComponent(pw)}@db:5432/umami`.
- `apps/umami/AGENTS.md` — the operator runbooks this plan builds on: "Backup & restore (manual runbook)" (custom-format `pg_dump -Fc --create`; emergency restore via forced `DROP DATABASE … WITH (FORCE)` then `pg_restore --exit-on-error --create --no-owner`, restart-on-exit trap); the retention runbook §2 recovery point (quiesce `caddy`/`umami`, source manifest, dump, disposable restore, exact manifest diff); §6 ENABLE gate; §7 timer disable; the `ALTER USER` rotation runbook; the deploy success-gate sequence (DB+app healthy → admin rotated → Caddy public). The disposable restore isolates with `--tmpfs /var/lib/postgresql/data` (line 319) and removes the container with `docker rm -f` (line 248); both are PG15-layout assumptions.
- `apps/umami/systemd/umami-retention.timer` — `OnCalendar=*-*-* 00:30:00 UTC`, `RandomizedDelaySec=30m`, `Persistent=true`; the service has a 30-minute outer timeout (AGENTS.md retention §6).
- `.github/renovate.json5` — the `postgres` docker packageRule (lines 62–78) already carries `allowedVersions: '<16'`, `automerge: false`, and `dependencyDashboardApproval: true`, mirroring the `fro-bot/agent` **ceiling + manual-gate pattern**.
- Tests that pin the Postgres image or compose layout: `apps/umami/docker-compose.test.ts` (asserts only the Caddy image today), `apps/umami/retention.integration.test.ts` (image constant at line 15; titles at lines 162 and 165). `apps/umami/retention.test.ts` line 45 only embeds a `postgres:15-alpine` string in a fixture compose file; it needs no change.
- `docs/runbooks/discord-token-lifecycle.md` — the structural template for an operator runbook in this repo.

### Institutional Learnings

- `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md` — `POSTGRES_PASSWORD` is baked into the volume at first init; changing it later bricks auth (Wave 6). Admin rotation must run over the internal compose network, not `localhost:3000` on the host (Wave 2). Start Caddy only after admin rotation; fail closed (Wave 5).
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — for any major image swap touching persistent state: probe the exact pinned image first, back up the named volume before cutover, treat the backup as the rollback anchor, and verify live behavior after cutover (not just deploy success).
- `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md` — container recreation (`--force-recreate`) swaps containers but does not transform data or rebuild images; recreate ≠ migrate. Reinforces that a Postgres major bump needs an explicit data migration, never just a container recreate.

### External References

Primary sources (see Sources & References):

- The official PG18 image sets `PGDATA=/var/lib/postgresql/18/docker` and `VOLUME /var/lib/postgresql`; mounts must target `/var/lib/postgresql` (docker-library/postgres PR #1259, image README).
- Umami's install docs give a PostgreSQL minimum (12.14) and no maximum. That is not a compatibility proof for the pinned umami image's Prisma migrations, so compatibility is still established empirically by the staging step (R5).
- PG18 deprecates MD5 password authentication. The live role is already SCRAM and a fresh init defaults to `scram-sha-256`; check the PG18 release notes for the exact wording and any effect on the Prisma/`pg` client path. Prisma's SCRAM support is proven by the staging boot, not assumed.
- Logical `pg_dump -Fc` / `pg_restore` is the documented cross-major path.

## Key Technical Decisions

- **Logical dump/restore, not `pg_upgrade`:** 14 MB DB, multi-major jump, single-binary alpine image. Custom-format dump → `pg_restore` is simpler, crosses 15→18 in one step, and needs no custom image.
- **Preserve the old PG15 volume by migrating to a NEW named volume, and change three things together:** the compose `db` service currently maps the single volume `umami-db-data` at `/var/lib/postgresql/data`. The migration creates a distinct volume — `umami-db-data-pg18` (project-prefixed on the host) — mounted at **`/var/lib/postgresql`** with **no `PGDATA` override**, and leaves `umami-db-data` (PG15) byte-untouched. Unit 3's pin-bump PR therefore changes the image pin, the volume key, **and** the mount destination as one unit. Rollback = one compose revert of image, volume key, and mount destination together. Mixed combinations (PG18 image on the old mount path, PG15 image on the new key, new key on the old destination) are the silent-empty-init case and are never valid intermediate states. Reusing `umami-db-data` for PG18 would require destroying the anchor — rejected. The off-droplet **encrypted** dump is a second, independent rollback source: a PG15 dump restores into PG15 or PG18 only. **Never `docker volume rm umami-db-data` until finalize.**
- **Mount at `/var/lib/postgresql`; reject "keep `/data` + `PGDATA` override":** the PG18 image declares `VOLUME /var/lib/postgresql`, so any mount elsewhere leaves that declared path on an anonymous volume that survives `docker compose down` and is invisible to the volume-based anchor/rollback story. The override alternative would also make this deployment diverge from the image's documented layout.
- **Layout gates, not health checks:** `pg_isready` and the container healthcheck pass on an empty cluster, so health is not evidence of data. Before restore, assert (a) `PGDATA` is the image default under `/var/lib/postgresql`, (b) the `db` container has exactly one mount: the named PG18 volume at `/var/lib/postgresql`, with no anonymous volume, and (c) the fresh cluster has no application tables. After restore and before starting umami, assert the restored manifest equals the source manifest.
- **Staging runs on the operator workstation, never the droplet:** about 245 MB is available with no swap; a second Node + Postgres stack would OOM production. Staging uses the same image digests as production, a unique project name, an internal-only network, and no published ports. The existing AGENTS.md disposable-restore pattern already runs locally. The encrypted off-droplet dump from the backup step is the input. Staging is its own gated step and finishes **before** the pin PR is written, so the pre-approved PR carries staging-validated digests.
- **Digest policy:** target the latest `postgres:18-alpine`. Resolve its digest once when staging starts and carry that exact digest through the PR and the cutover. If a newer digest appears before cutover, ship the staged one and let Renovate propose the update afterward; re-run staging only if the operator chooses to move the pin.
- **Adopt the AGENTS.md dump/restore procedure and fix the flags before staging:** custom-format `pg_dump -Fc --create` taken from a write-quiesced source (caddy and umami stopped) with a source manifest; restore via forced drop of the pre-created `umami` database then `pg_restore --exit-on-error --create --no-owner` connected to the `postgres` database; restart-on-exit trap; exact manifest diff. Staging validates these flags and the same flags go to production — nothing is decided during the cutover. The cutover restores a **fresh quiesced dump** taken after caddy/umami stop, not the earlier backup, so writes between the backup and the cutover are not lost.
- **Password coherence is automatic; the sentinel is verified, never written by hand:** the sentinel lives at `/opt/umami/.db-password-fingerprint`, outside the volume, so init does not touch it, and the password value never changes. The runbook only verifies: the sentinel is present, its content equals the hash computed per `computeDbPasswordFingerprint` (compared without printing either value), and the next `umami deploy` passes the guard and rewrites identical content. A mismatch is a stop, not something to fix by hand. The migration must not alter the password.
- **Retention timer is disabled before the freeze:** use the existing disable procedure in `apps/umami/AGENTS.md` (retention §7; the `disable_retention_timer` pattern in the emergency-restore block), assert disabled + inactive and no running retention service, schedule the cutover outside 00:00–02:00 UTC, and re-arm only through the existing ENABLE gate (retention §6, after a fresh `--check` on PG18) once cutover verification passes. Re-arming after Caddy start costs nothing in rollback terms: rollback past that point is already lossy. `deploy.ts` leaves a disabled timer disabled, so a stray deploy does not re-arm it.
- **Deploy freeze is the only compose protection:** `deploy.ts` overwrites the droplet compose with `main`'s on every deploy, so during the window the only protection is operational — hold the `umami` environment approval gate and hold Renovate umami PRs.
- **Renovate ceiling + manual gate on `postgres` (R1, shipped):** `allowedVersions: '<16'` plus `automerge: false` + `dependencyDashboardApproval: true`. The ceiling is lifted to `<19` only as part of the executed cutover (Unit 3); the approval gate stays so the next major still requires a runbook.
- **Runbook artifact, not deploy-code change:** the procedure lives in `docs/runbooks/umami-postgres-major-upgrade.md`. The recurring deploy path is unchanged.

## Open Questions

### Resolved During Planning

- *In-place `pg_upgrade` vs dump/restore?* → dump/restore (size + single-binary image + multi-major).
- *Target 16/17 first, or 18 directly?* → 18 directly; logical restore crosses majors; intermediate hops add steps and risk.
- *Does the password need rotating during migration?* → No. Fresh volume re-bakes the existing password unchanged; the sentinel is outside the volume and unaffected.
- *Codify in deploy.ts or runbook?* → Runbook (one-time event; YAGNI on deploy machinery).
- *How to keep the old volume as rollback anchor while running PG18?* → Migrate to a NEW named volume `umami-db-data-pg18`; image pin, volume key, and mount destination change together in Unit 3's PR. Reusing `umami-db-data` for PG18 would require destroying the anchor — rejected.
- *Mount destination and `PGDATA`?* → mount at `/var/lib/postgresql`, no `PGDATA` override; the `/data` + override alternative is rejected (anonymous-volume leak).
- *Where does staging run?* → operator workstation, not the droplet (memory).
- *Do it now or defer?* → Execute. Unit 1 shipped; Units 2–3 proceed by operator decision (PG15 support runs to Nov 2027; deliberate modernization, not urgency).
- *Which dump/restore flags?* → the AGENTS.md procedure's, fixed before staging and validated there.

### Deferred to Implementation

- *Exact `postgres:18-alpine` digest* — resolved once when staging starts, from the registry, and frozen through the PR and cutover.
- *Whether the workstation's CPU architecture differs from the droplet's `linux/amd64`* — if so, staging proves PG18 behavior, schema, and Prisma boot with the same manifest-list digests but does not exercise the amd64 binary; the runbook states which it did, and the production layout/restore gates still run on the droplet.
- *Exact downtime window* — restore duration is measured in staging; production downtime (quiesce → Caddy start) is expected in seconds to low minutes and confirmed before scheduling.

## Implementation Units

- [x] **Unit 1: Renovate major-bump guard for `postgres`**

**Goal:** Make it impossible for a Postgres major bump to auto-PR, auto-merge, or auto-flow to a deploy ahead of the migration runbook. Satisfies R1 independently of when the migration runs.

**Requirements:** R1

**Dependencies:** None. Shipped.

**Files:**
- Modify: `.github/renovate.json5`

**Approach:**
- Extend (or add) the `postgres` docker packageRule with `allowedVersions: '<16'` to hold at the 15.x line, plus `automerge: false` and `dependencyDashboardApproval: true`, mirroring the `fro-bot/agent` rule already in the file. Add a comment explaining the ceiling exists because a Postgres major is a data-directory migration governed by `docs/runbooks/umami-postgres-major-upgrade.md`, not an image swap.
- In-range PG15 minor/patch updates are not automatic: `dependencyDashboardApproval: true` gates them too, so each needs a dashboard approval before Renovate opens the PR, and `automerge: false` means a manual merge. The ceiling only blocks ≥16.
- Shipped as a standalone safety change ahead of, and independent of, the migration.

**Patterns to follow:**
- The `fro-bot/agent` packageRule in `.github/renovate.json5` (ceiling + `automerge: false` + `dependencyDashboardApproval: true` + explanatory comment).

**Test scenarios:**
- Happy path: `renovate-config-validator` (current Renovate version) reports the config valid.
- Edge case: confirm the existing `postgres` changelog/sourceUrl packageRule (if separate) is not contradicted — the ceiling and the metadata rule must coexist without one overriding the other.

**Verification:**
- Renovate config validates. A subsequent Renovate run will not open a PG≥16 PR at all while the `<16` ceiling holds — `allowedVersions` excludes those versions outright. (`dependencyDashboardApproval: true` gates the *allowed* in-range updates and remains in force after the ceiling is later lifted, so the *next* major still requires explicit approval; it is not what blocks PG16+ today — the ceiling is.)

- [ ] **Unit 2: Migration runbook**

**Goal:** A durable, operator-followable runbook capturing the full dump/restore migration with workstation staging validation, preserve-old-volume rollback, password/fingerprint verification, layout gates, and verification. Satisfies R2–R8 as written procedure.

**Requirements:** R2, R3, R4, R5, R6, R7, R8

**Dependencies:** None (can be authored alongside Unit 1). Must be complete and reviewed before Unit 3 is executed. Step 3 (staging) must be complete before the Unit 3 pin PR is written.

**Files:**
- Create: `docs/runbooks/umami-postgres-major-upgrade.md`

**Approach:** The runbook documents this sequence (commands belong in the runbook itself; the plan specifies the required shape, ordering, and gates). It reuses `apps/umami/AGENTS.md` procedures by reference rather than restating them, and supplies only the PG18-specific deltas:
1. **Pre-flight (read-only)** — record live `server_version`, the public table list WITH exact row counts, and DB size; `datcollate`, `datctype`, `datlocprovider` for the `umami` database; `password_encryption` and the role verifier prefix; confirm `UMAMI_DB_PASSWORD` matches the live role (a successful `psql -U umami` over the compose network); host memory and disk headroom; the retention timer's state; the sentinel's presence, size, and mode; capture `docker volume ls` so the PG15 anchor `umami_umami-db-data` is provably identifiable; resolve and freeze the target `postgres:18-alpine` digest; save a copy of the current droplet compose as the rollback artifact.
2. **Backup (irreversibility gate)** — follow the `apps/umami/AGENTS.md` recovery-point procedure (write-quiesced source manifest + `pg_dump -Fc --create`, restart-on-exit trap, disposable restore, exact manifest diff). The dump lands on the operator workstation; **encrypt it at rest with a concrete named mechanism** (e.g. `age` or `gpg --symmetric` with a key the operator controls, not an ad-hoc choice at execution time); then **verify the stored artifact** by checksum AND a test decrypt + `pg_restore --list`. Record an explicit **deletion deadline** (destroy 7 days after successful finalize). The dump contains analytics data AND the admin credential hash — treat as a secret. **No destructive or volume-touching step may run until the encrypted dump is verified present, checksum-matched, and decrypt-tested.** This backup feeds staging; the cutover takes its own fresh quiesced dump (step 4).
3. **Staging validation (R5) — separate gate, on the operator workstation, complete before the pin PR is written** — never on the droplet. Restore the decrypted dump into a throwaway PG18 + the pinned umami image (same digests production will use) using a **unique temp compose project name, an internal-only Docker network, and NO published host ports** (no Caddy). Reproduce the production layout exactly: named volume mounted at `/var/lib/postgresql`, no `PGDATA` override. Staging must:
   - run the layout gates from step 4 (`PGDATA`, single named mount with no anonymous volume, fresh cluster has no application tables);
   - confirm after init `password_encryption=scram-sha-256` and the role verifier starts with `SCRAM-SHA-256$`, and that the pinned umami image authenticates over SCRAM (the boot below is the proof of Prisma's SCRAM support);
   - compare `datcollate`, `datctype`, `datlocprovider` against the pre-flight values;
   - restore with the exact flags production will use (forced drop of the pre-created database, then `pg_restore --exit-on-error --create --no-owner` via the `postgres` database) and require the restored manifest to equal the source manifest;
   - start the pinned umami image **after** restore verification, **capture its Prisma migration output** on first boot, and confirm it is an idempotent no-op (no pending migrations applied, no schema drift), then `/api/heartbeat` healthy;
   - run retention check and apply paths against the staged PG18 cluster (`retention.sh` accepts a compose file), and run `apps/umami/retention.integration.test.ts` against the PG18 digest as non-skipped evidence (a skip is not evidence);
   - rehearse the R4 rollback path: bring up the pinned PG15 image from the reverted compose layout against a PG15 volume restored from the same dump and confirm its manifest equals the source manifest;
   - measure restore duration;
   - **tear down rigorously**: remove temp containers (with their volumes), temp volumes, network, and project; verify nothing remains (`docker ps -a`, `docker volume ls`, `docker network ls`) and the plaintext dump copy is removed, so no production data lingers in a stray volume or image layer. Record the digests, gate outputs, and Prisma output as the staging evidence the Unit 3 PR cites. If the workstation architecture differs from the droplet's, state which platform staging exercised.
4. **Cutover (R2, R3, R4, R7, R8)** — preconditions: staging evidence complete; pin PR review-approved and unmerged; verified encrypted backup; window outside 00:00–02:00 UTC; **deploy freeze on** (hold the `umami` environment approval gate, hold Renovate umami PRs, confirm no in-flight deploy run).
   1. **Disable the retention timer** via the existing AGENTS.md procedure and assert the timer is disabled and inactive and no retention service is running.
   2. **Quiesce and final dump:** stop `caddy` and `umami`; take the source manifest and a fresh `-Fc --create` dump from that quiesced PG15 state per the AGENTS.md procedure; verify `pg_restore --list`; copy it off-droplet, encrypt, and checksum it. This is the dump that gets restored.
   3. **Stop PG15 `db`** and leave `umami-db-data` untouched. Never run both majors at once on this host (memory).
   4. **Switch the droplet compose by hand** to the PR's compose (image pin, volume key, mount destination together) — `deploy.ts` is frozen. Start ONLY the PG18 `db` against the NEW empty volume `umami-db-data-pg18`, so it re-bakes the `umami` role password from `/opt/umami/.env`.
   5. **Layout gates (hard stop before restore):** `PGDATA` is the image default under `/var/lib/postgresql` and not overridden in compose; the `db` container has exactly one mount, the named PG18 volume at `/var/lib/postgresql`, and no anonymous volume; the fresh cluster has no application tables; `password_encryption` is `scram-sha-256` and the role verifier starts with `SCRAM-SHA-256$`; `datcollate`, `datctype`, `datlocprovider` equal the pre-flight values.
   6. **Restore** with the staging-validated flags and verify restore completion. **Row-count parity gate:** the restored manifest (table names plus exact counts) must equal the quiesced source manifest before umami starts.
   7. **Start `umami`** (internal only) and confirm Prisma migrations are idempotent no-ops and the internal heartbeat is healthy. Do not run admin rotation or `deploy.ts`; admin state comes from the dump.
   8. **Start `caddy` — the point of no return.** Confirm the public heartbeat.
5. **Sentinel verification (R3, read-only)** — the cutover is manual and the sentinel is not touched. Verify only: the sentinel is present (64 bytes, mode 600), its content equals the hash computed per `computeDbPasswordFingerprint` for the unchanged password (compare without printing either value), and — after the PR merges — the first approved `umami deploy` passes the guard and rewrites identical content. On mismatch, stop and investigate; do not edit the sentinel by hand.
6. **Verification (R2)** — `/api/heartbeat` healthy; source manifest equals live manifest; authenticated login succeeds; public `https://metrics.fro.bot` serves; the `systematic` website + its `data-website-id` intact; **privacy invariants confirmed** (`PRIVATE_MODE=1`, `DISABLE_TELEMETRY=1` still in effect; no visitor-hash/app-secret state reset); live `server_version` is the PG18 target; a fresh retention `--check` on PG18 passes. Then re-arm retention through the existing ENABLE gate (retention §6; stay present for a possible catch-up run).
7. **Rollback (R4)** — a matrix, with the point of no return explicit:
   - *Before Caddy starts:* restore the saved pre-cutover compose (PG15 image, `umami-db-data`, `/var/lib/postgresql/data` mount — all three together), start PG15 `db` on the untouched volume, and confirm its manifest equals the quiesced source manifest. Zero loss: the PG15 volume saw no writes after quiesce.
   - *After Caddy starts:* rollback discards PG18 writes since Caddy start, because PG18 dumps cannot load into PG15. It requires an explicit, recorded data-loss decision; roll forward is the default.
   - *Off-droplet dump:* the PG15 dump restores into PG15 or PG18 only.
   - *Repo state:* if the pin PR already merged, revert it as one change (image, key, destination) and keep the deploy freeze until `main` and the droplet agree. Authority when they conflict: the droplet's running volume identity; `main` is brought to match before any deploy is approved. Never run a mixed combination.
8. **Finalize** — **final confirmation = 7 days of healthy production operation** (heartbeat green plus at least one clean no-op `umami deploy`). Then remove the preserved `umami-db-data` PG15 volume and the on-droplet dump, and destroy the off-droplet dump per its deletion deadline.

**Patterns to follow:**
- `docs/runbooks/discord-token-lifecycle.md` for structure (containment-first ordering, explicit commands, audit/verification sections).
- The `apps/umami/AGENTS.md` "Backup & restore" and retention recovery-point procedures, the retention §6/§7 timer procedures, the `ALTER USER` rotation runbook, and the admin-rotation-over-compose-network lesson (don't use host `localhost:3000`).

**Test scenarios:**
- Test expectation: none — this unit is operator documentation. Its correctness is validated by the staging dry-run it prescribes (step 3) and by the Unit 3 execution, not by automated tests.

**Verification:**
- The runbook is self-contained: an operator can execute it end-to-end without external context, every destructive step has a stated rollback, staging gates the production cutover, and the layout gates make a silent empty init impossible to miss.

- [ ] **Unit 3: Execute cutover + land the pin bump**

**Goal:** Perform the migration on `metrics.fro.bot` following Unit 2, and land the accompanying repo changes (compose image pin, volume key and mount destination, tests, docs, lifted Renovate ceiling) once the live stack is verified healthy on PG18.

**Requirements:** R2, R3, R5 (executed), R7, R8, and lifts the R1 ceiling deliberately.

**Dependencies:** Unit 1 (guard in place), Unit 2 (runbook reviewed, staging gate complete). Operator-gated — requires explicit approval before the production cutover, per deploy-approval discipline.

**Files:**
- Modify: `apps/umami/docker-compose.yaml` — pin `postgres:15-alpine@sha256:...` → `postgres:18-alpine@sha256:<staging-validated digest>`; rename the `db` volume key `umami-db-data` → `umami-db-data-pg18` (line 55 mount and line 65 declaration); change the `db` mount destination from `/var/lib/postgresql/data` to `/var/lib/postgresql`; add no `PGDATA`. These three change together.
- Modify: `apps/umami/docker-compose.test.ts` — add db assertions: the pinned PG18 image digest, the exact `umami-db-data-pg18:/var/lib/postgresql` mount, and no `/var/lib/postgresql/data` path or `PGDATA` entry.
- Modify: `apps/umami/AGENTS.md` — volume name in the services table (line 10), "Data persistence" (line 74), and the anti-patterns (line 599); disposable restore isolation `--tmpfs /var/lib/postgresql/data` (line 319) → `--tmpfs /var/lib/postgresql` (on PG18 the old path is not `PGDATA`, so isolation breaks), the isolation label (line 326), and cleanup `docker rm -f` (line 248) → `docker rm -f -v`; note the migration is complete and point to the runbook. No line names the PG major number; the image is resolved from compose.
- Modify: `apps/umami/README.md` — line 7 (stack description names "Umami 3.2.0 + PostgreSQL 15"; describe versions as the pinned images, since compose is the source of truth) and line 68 (volume name).
- Modify: `apps/umami/evidence/retention/TEMPLATE.md` — lines 17–18 (umami and Postgres image strings) and lines 33–34 (disposable restore image and `tmpfs /var/lib/postgresql/data` isolation text). Leave the dated evidence record `evidence/retention/2026-07-31T2012Z-mrb-go.md` as written; it documents what was true then.
- Modify: `apps/umami/retention.integration.test.ts` — the `postgres:15-alpine` image constant (line 15) and the "PostgreSQL 15" titles (lines 162, 165). Run it against the PG18 digest during staging with a local edit as R5 evidence, then land the constant change in the PR.
- Modify: `.github/renovate.json5` — lift the postgres ceiling `<16` → `<19` and update the comment (lines 69–74, which say the ceiling holds "at the current major" and "Minor/patch PG15 updates still flow"); keep `automerge: false` + `dependencyDashboardApproval: true` so the *next* major still requires a runbook.

**Approach:**
- **Write the repo PR only after the staging gate (Unit 2 step 3) is complete, using the staging-validated digests; get it review-approved but UNMERGED *before* starting the cutover.** Post-cutover convergence is then a single immediate merge of an already-reviewed change, not authoring under time pressure.
- **Impose an explicit deploy freeze for the cutover window** — no `umami deploy` (manual or Renovate-triggered) may run between the start of the cutover and the repo PR landing. `deploy.ts` overwrites the droplet compose with `main`'s on every deploy, so the freeze is the only protection: hold the `umami` environment approval gate (it requires `marcusrbrown` approval) and hold any in-flight Renovate umami PR. **Without this freeze, an unrelated deploy in the window uploads the still-PG15 `main` compose and reattaches the preserved `umami-db-data` (PG15) volume — silently rolling back to stale data after PG18 has accepted writes.**
- **Disable the retention timer before the freeze starts** and keep it disabled through finalize (Unit 2 steps 4 and 8). Schedule the cutover outside 00:00–02:00 UTC so a catch-up or scheduled run cannot overlap.
- Execute the Unit 2 runbook against the live droplet (cutover → verify). The deploy script never recreates the volume, so the cutover's volume handling is done by the runbook directly on the droplet.
- **Immediately after live verification**, merge the pre-approved repo PR so `main` matches the droplet (PG18 image, `umami-db-data-pg18`, `/var/lib/postgresql` mount), then approve the first deploy and lift the freeze. The image, volume name, and mount destination in the PR must exactly match what the runbook ran on the droplet; `apps/umami/AGENTS.md` retention §1 (deployed compose pins the same images as the repo) is the confirming check.
- **Ordering invariant:** `main` must never be deployed while its compose disagrees with the droplet's volume identity or mount layout. The pre-approved PR + deploy freeze guarantee that disagreement window is short *and* contains no deploys.

**Patterns to follow:**
- The gateway/cliproxy convention of bumping a pinned version in the repo *after* verifying the live deploy, with AGENTS.md updated to match.

**Test scenarios:**
- Happy path: post-cutover, `bunx @marcusrbrown/infra umami status` reports all services healthy and the live `server_version` is the PG18 target.
- Happy path: `apps/umami/docker-compose.test.ts` fails if the db image, volume key, or mount destination regresses to the PG15 layout.
- Integration: the `systematic` website row and its `data-website-id` survive the migration (query the live DB post-restore).
- Integration: `retention.integration.test.ts` passes (not skipped) against the PG18 image.
- Edge case: a subsequent normal `umami deploy` (no migration) does not abort on the fingerprint sentinel and rewrites identical content — confirming password coherence held.
- Window safety: confirm no `umami deploy` ran between cutover start and PR merge (check the deploy-workflow run history for the freeze window); the first post-merge deploy is a clean no-op against the already-running PG18 stack and leaves the disabled timer disabled.
- Retention: after cutover verification, a fresh `--check` on PG18 passes and the timer is re-armed through the ENABLE gate.

**Verification:**
- Live droplet on PG18, all services healthy, `/api/heartbeat` OK, public HTTPS serving, website data intact; `main`'s compose (image, volume key, mount destination) matches the running stack; Renovate ceiling lifted to `<19` with the major-gate retained; retention timer re-armed through the ENABLE gate after cutover verification.

## System-Wide Impact

- **Interaction graph:** the `db` service is the dependency root — `umami` `depends_on: db service_healthy`, `caddy` fronts `umami`, and the retention service reads and deletes through `docker compose exec db`. The migration touches `db`'s image, volume, and mount; the umami/caddy services and their config are unchanged. `deploy.ts` re-uploads compose on every deploy, which is why the freeze matters.
- **Error propagation:** if the new PG18 `db` fails to start, `up -d --wait` times out and `umami` never starts — a *loud* failure. The silent failure is the mount-layout mismatch: the cluster initializes empty on a stray volume and passes health. The layout and row-count gates exist for that case. The preserve-old-volume design makes either failure fully reversible until Caddy starts.
- **State lifecycle risks:** the central risk is the volume. Mitigated by (a) preserving the old PG15 volume untouched, (b) an encrypted off-droplet dump, (c) workstation staging before prod, (d) layout and manifest gates. The `.db-password-fingerprint` sentinel is the second state artifact — it lives outside the volume and stays valid because the password does not change. Writes after Caddy starts exist only in PG18.
- **API surface parity:** none — no CLI flags, env contracts, or workflow inputs change in Units 1–2. Unit 3 changes only the pinned `db` image digest, volume key and mount destination, tests, docs, and the Renovate ceiling.
- **Integration coverage:** the staging dry-run is the integration test that unit tests cannot provide — it proves the real umami image speaks to a real PG18 cluster restored from the real dump, and that retention check/apply work there.
- **Unchanged invariants:** `UMAMI_DB_PASSWORD`, `UMAMI_APP_SECRET`, admin credentials, droplet size/region, the deploy success-gate sequence (DB+app healthy → admin rotated → Caddy public), retention policy and units, and `DATABASE_URL` shape all remain exactly as today.

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Renovate auto-applies a major PG bump destructively before migration | Low (Unit 1 shipped) | High | Unit 1 ceiling + `automerge: false` + `dependencyDashboardApproval: true`; ceiling lifted only in Unit 3 and the approval gate stays |
| The pinned umami image incompatible with PG18 | Low | High | Workstation staging (R5) proves compatibility, including Prisma no-op migrations and retention check/apply, before any production downtime; if it fails, abort with zero prod impact |
| PG18 mount/layout mismatch: initdb writes to an anonymous volume and health passes on an EMPTY cluster; `deploy.ts` then rotates default admin creds and looks healthy with zero data | Medium (if the mount is left at the PG15 path) | High | Mount at `/var/lib/postgresql` with no `PGDATA` override; image pin, volume key, and mount destination change together; pre-restore gates assert `PGDATA`, the single named mount and destination, and an empty fresh cluster; row-count parity with the source manifest before umami starts; staging reproduces the production layout; compose test pins the layout |
| Retention timer fires mid-restore (armed, ~00:30–01:00 UTC, service up to 30 min; `deploy.ts` restarts an active timer) | Medium (if unaddressed) | High | Disable the timer before the freeze and assert inactive (AGENTS.md procedure); schedule outside 00:00–02:00 UTC; re-arm only via the ENABLE gate after cutover verification |
| Staging OOMs the 1 GB droplet (~245 MB available, no swap) | High (if staged on the droplet) | High | Stage on the operator workstation with the same digests, internal network, no published ports; never run PG15 and PG18 concurrently on the droplet |
| SCRAM/MD5 authentication surprise on PG18 | Low | Medium | Live role is already SCRAM (`password_encryption=scram-sha-256`); gate after PG18 init asserts the setting and a `SCRAM-SHA-256$` verifier; Prisma's SCRAM support proven by the staging boot; check the PG18 release notes for the MD5 deprecation wording |
| Rollback after Caddy starts is not zero-loss (PG18 dumps cannot load into PG15) | Medium (if a post-Caddy failure occurs) | Medium | Caddy start is the documented point of no return; pre-Caddy rollback is zero-loss and rehearsed; post-Caddy rollback requires an explicit recorded data-loss decision, roll forward is the default |
| Writes between the backup and the cutover are lost | Medium (if the backup dump is restored) | High | The cutover restores a fresh dump taken after caddy/umami stop, with its own source manifest; the earlier backup feeds staging only |
| Collation/locale drift changes index ordering | Low | Medium | Compare `datcollate`, `datctype`, `datlocprovider` before and after; both images are alpine, and the dump/restore rebuilds indexes |
| Data loss during cutover | Very low | High | New volume `umami-db-data-pg18`; old PG15 `umami-db-data` left untouched + encrypted off-droplet dump; backup-verified gate before any destructive step |
| Volume-identity drift (PG18 image reattaches stale PG15 dir, or anchor destroyed) | Medium (if unaddressed) | High | Migrate to a distinct volume name; Unit 3 PR changes key and mount destination with the image; never `volume rm umami-db-data` until finalize |
| Operator fat-finger destroys the anchor mid-cutover | Low | High | Irreversible commands gated behind a confirmation checkpoint AFTER off-droplet dump verification; "prepare new volume" separated from any "touch old volume" step |
| Umami app boots before restore completes → migrates against empty/half-restored DB | Medium (if ordered wrong) | High | Hard gate: restore + manifest parity BEFORE starting the umami service; staging exercises the same restore-then-boot ordering |
| Password/fingerprint incoherence bricks next deploy | Low | Medium | Password unchanged; the sentinel is outside the volume and untouched; read-only verification that it is present and matches the computed hash; post-cutover check that a normal deploy is a sentinel no-op |
| Off-droplet dump leaks (admin hash + visitor data) | Low | Medium | Encrypted-at-rest off-droplet; explicit deletion deadline (destroy 7 days post-finalize); treated as a secret |
| Staging leaves production-data remnants on the workstation | Low | Low | Unique temp project, internal-only network, no published ports; verified teardown of containers, volumes, and network; plaintext dump removed; the retained dump stays encrypted |
| Dump is corrupt/incomplete | Very low | High | `pg_restore --list` verifies the dump; staging restore and manifest diff exercise it end-to-end before prod |
| Extended downtime | Very low | Low | 14 MB DB → seconds to restore; duration measured in staging before scheduling |
| `main` pin claims PG18 before droplet is migrated | Low | Medium | Unit 3 lands the repo pin only *after* live verification; image, volume name, and mount destination in the PR match the droplet |
| Unrelated deploy in the cutover window reattaches the PG15 volume (post-cutover data regression); `deploy.ts` overwrites the droplet compose with `main` on every deploy | Medium (if window unmanaged) | High | Pre-approve the pin PR *before* cutover; deploy freeze (env-gated approval held, Renovate umami PRs held) is the only protection for the window; merge immediately after verification; first post-merge deploy must be a clean no-op |

## Documentation / Operational Notes

- New runbook `docs/runbooks/umami-postgres-major-upgrade.md` is the primary deliverable of Unit 2; cross-link it from `apps/umami/AGENTS.md`.
- After the migration, `apps/umami/AGENTS.md`, `apps/umami/README.md`, and `apps/umami/evidence/retention/TEMPLATE.md` reflect the PG18 layout (volume name, disposable-restore `tmpfs` path), and the runbook is noted as reusable for the next major (the procedure is version-agnostic; the mount path is the image's documented path for the target major).
- Consider (separately) whether the proven dump step motivates a standing backup cadence — deferred.

## Sources & References

- Live preflight (read-only, 2026-10-24): PG `15.19`, DB 14 MB / 27 public base tables, SCRAM role, `en_US.utf8` libc collation, ~245 MB host memory available with no swap, 7.9 GB disk free, sentinel present.
- Related code: `apps/umami/docker-compose.yaml`, `apps/umami/docker-compose.test.ts`, `apps/umami/src/deploy.ts`, `apps/umami/AGENTS.md`, `apps/umami/README.md`, `apps/umami/systemd/umami-retention.timer`, `apps/umami/retention.integration.test.ts`, `apps/umami/evidence/retention/TEMPLATE.md`, `.github/renovate.json5`.
- PG18 image layout: docker-library/postgres PR #1259 (`https://github.com/docker-library/postgres/pull/1259`) and the Docker Official Image README for `postgres` (`PGDATA` and `VOLUME /var/lib/postgresql`).
- Umami install docs (PostgreSQL minimum, no maximum): `https://docs.umami.is/docs/install`.
- PostgreSQL docs: upgrading a cluster (`https://www.postgresql.org/docs/18/upgrading.html`), `pg_dump` and `pg_restore` (`https://www.postgresql.org/docs/18/app-pgdump.html`, `https://www.postgresql.org/docs/18/app-pgrestore.html`), and the PG18 release notes (`https://www.postgresql.org/docs/18/release-18.html`) — check the MD5 password deprecation wording there.
- Institutional learnings: `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`, `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md`, `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`.
- Runbook template: `docs/runbooks/discord-token-lifecycle.md`.
