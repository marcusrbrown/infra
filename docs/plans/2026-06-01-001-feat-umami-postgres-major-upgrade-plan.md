---
title: 'feat: Umami Postgres 15→18 major-version migration'
type: feat
status: active
date: 2026-06-01
---

# Umami Postgres 15→18 major-version migration

## Overview

The self-hosted Umami analytics stack on `metrics.fro.bot` runs **PostgreSQL 15.18** (`postgres:15-alpine`, digest-pinned). Renovate's dependency dashboard offers a major bump to Postgres 18. A Postgres major upgrade cannot be applied by swapping the image tag: PG18 binaries refuse to start against a PG15 on-disk data directory, so a naive Renovate bump + deploy would brick the `db` container (`up -d --wait` times out, stack down).

This plan defines a deliberate, runbook-driven migration via **logical dump/restore** into a fresh PG18 cluster, with the old PG15 volume preserved as an instant rollback anchor and a throwaway staging restore to de-risk the compatibility unknown before any production cutover.

**Live state (probed 2026-06-01):** server version `15.18`; database `umami` is **9 MB across 18 tables**; droplet `s-1vcpu-1gb` with **19 GB free of 25 GB**. The dataset is tiny and disk headroom is enormous, so dump/restore is fast (seconds of downtime) and `pg_upgrade` is unnecessary (and impractical — the alpine image ships only one major's binaries, so the two-major-co-resident requirement of `pg_upgrade` can't be met without a custom image).

**Urgency framing (honest):** PostgreSQL 15 is community-supported until **November 2027**. This migration is *not* time-critical — it is low-urgency modernization triggered by Renovate offering the major. The recommended posture is to do it deliberately with the runbook below, or defer; either is defensible. What is *not* acceptable is letting Renovate auto-open and auto-merge a major Postgres bump that the deploy path would then apply destructively (Unit 1 closes that hole regardless of when the migration itself happens).

**Recommended path (post-review):** land **Unit 1 (the Renovate guard) now as a standalone safety change** — it eliminates the only real risk (an unattended destructive auto-bump) and is fully independent of the migration. **Defer Units 2–3 (runbook + cutover) until a real forcing function appears** — PG15 nearing EOL, a security fix only in a newer major, or a needed PG16+ feature. The runbook is authored here so the procedure is ready and the design is reviewed, but executing the migration today spends operator attention on low-leverage modernization, and the version/digest specifics will drift before execution. Units 2–3 below are written to be correct-and-ready, not do-now.

## Problem Frame

A major Postgres version bump is a data-directory format change, not a drop-in image swap. The umami deploy (`apps/umami/src/deploy.ts`) brings the stack up with `docker compose up -d --wait --wait-timeout 180 db umami` against the existing named volume `umami-db-data` (mounted at `/var/lib/postgresql/data`). If the pinned image's major changes, that command starts the new binary against the old cluster and fails. Three properties make this delicate:

1. **No automated backup/restore exists** — only a manual `pg_dump`/`psql` runbook in `apps/umami/AGENTS.md`. There is no `umami backup` CLI command.
2. **The DB password is volume-coupled** — `POSTGRES_PASSWORD` is baked into the cluster at first init. A fresh PG18 volume re-initializes the `umami` role's password from `${POSTGRES_PASSWORD}` in `/opt/umami/.env`. The deploy enforces a fingerprint sentinel (`/opt/umami/.db-password-fingerprint`) and aborts on mismatch.
3. **Renovate already watches `postgres`** (`.github/renovate.json5` has a docker packageRule producing standalone PRs), so without a guard a major bump can flow to a gated deploy.

## Requirements Trace

- R1. A Postgres major bump can never auto-flow to a destructive deploy — major versions require explicit, deliberate migration.
- R2. The migration preserves all Umami application data (18 tables, all events/sessions/websites) with zero loss.
- R3. The migration preserves DB-auth coherence: the `umami` role password on the new cluster equals the current `UMAMI_DB_PASSWORD`, and the `.db-password-fingerprint` sentinel stays valid so the next normal deploy does not abort.
- R4. The migration is reversible at every step until final confirmation, with a verified rollback to the PG15 baseline that loses no data.
- R5. PG18 compatibility with `umamisoftware/umami:3.1.0` is proven before production cutover, not assumed.
- R6. The procedure is captured as a durable operator runbook in `docs/runbooks/`, consistent with the existing `discord-token-lifecycle.md`.

## Scope Boundaries

- **Not** migrating to any target other than the latest Postgres 18 alpine release (e.g., not stopping at 16 or 17 — logical dump/restore crosses multiple majors in one step, so an intermediate hop adds risk without benefit).
- **Not** codifying dump/restore/`pg_upgrade` logic into `apps/umami/src/deploy.ts`. This is a one-time operational event; embedding migration machinery into the recurring deploy path is unjustified complexity (YAGNI). The deploy path's only required property — never recreate the volume on its own — already holds.
- **Not** changing the Umami application version, the Caddy version, droplet size, or region.
- **Not** rotating `UMAMI_DB_PASSWORD`, `UMAMI_APP_SECRET`, or the admin password as part of this work (the fresh cluster re-bakes the existing DB password unchanged; admin/app state is restored from the dump).
- **Not** introducing a recurring backup system. A standing backup cadence is worth considering but is its own task.

### Deferred to Separate Tasks

- Recurring/scheduled Umami DB backups (cron or volume snapshot): future task, separate from this one-time migration.
- A general `umami backup` / `umami restore` CLI command: future task if a backup cadence is adopted.

## Context & Research

### Relevant Code and Patterns

- `apps/umami/docker-compose.yaml` — `db` service pins `postgres:15-alpine@sha256:df7bca...`, volume `umami-db-data:/var/lib/postgresql/data`, env `POSTGRES_DB=umami` / `POSTGRES_USER=umami` / `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-}`. `db` healthcheck is `pg_isready -U umami -d umami`.
- `apps/umami/src/deploy.ts` — brings up `db umami` with `up -d --wait --wait-timeout 180`, then rotates admin, then starts `caddy`; writes `/opt/umami/.env` via SSH stdin; enforces the DB-password fingerprint sentinel; never runs `down`/`down -v` and never touches the volume. Builds `DATABASE_URL=postgresql://umami:${encodeURIComponent(pw)}@db:5432/umami`.
- `apps/umami/AGENTS.md` — operator runbook: the `ALTER USER` password-rotation procedure, the "volume-coupled / DANGER" warning, the manual `pg_dump`/`psql` backup path, and the deploy success-gate sequence (DB+app healthy → admin rotated → Caddy public).
- `.github/renovate.json5` — existing `postgres` docker packageRule (standalone PRs). The `fro-bot/agent` rule (`allowedVersions: '<0.47.0'` + `automerge: false` + `dependencyDashboardApproval: true`) is the established **ceiling + manual-gate pattern** to mirror for `postgres`.
- `docs/runbooks/discord-token-lifecycle.md` — the structural template for an operator runbook in this repo.

### Institutional Learnings

- `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md` — `POSTGRES_PASSWORD` is baked into the volume at first init; changing it later bricks auth (Wave 6). Admin rotation must run over the internal compose network, not `localhost:3000` on the host (Wave 2). Start Caddy only after admin rotation; fail closed (Wave 5).
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — for any major image swap touching persistent state: probe the exact pinned image first, back up the named volume before cutover, treat the backup as the rollback anchor, and verify live behavior after cutover (not just deploy success).
- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — container recreation (`--force-recreate`) swaps containers but does not transform data or rebuild images; recreate ≠ migrate. Reinforces that a Postgres major bump needs an explicit data migration, never just a container recreate.

### External References

External research intentionally skipped: logical `pg_dump`/`pg_restore` across majors is well-trodden, the dataset is 9 MB, and the upgrade-playbook learning already encodes the high-risk-migration discipline. The one genuine unknown — `umami:3.1.0` ↔ PG18 compatibility — is resolved empirically by the staging-validation step (Unit 2 / R5) rather than by documentation claims.

## Key Technical Decisions

- **Logical dump/restore, not `pg_upgrade`:** 9 MB DB, multi-major jump, single-binary alpine image. `pg_dump -Fc` → `pg_restore` is simpler, crosses 15→18 in one step, and needs no custom image. Rationale beats `pg_upgrade` on every axis here.
- **Preserve the old PG15 volume by migrating to a NEW named volume:** the compose `db` service currently maps the single volume `umami-db-data`. The migration creates a distinct volume — `umami-db-data-pg18` — for the fresh PG18 cluster and leaves `umami-db-data` (PG15) byte-untouched. This **requires Unit 3's pin-bump PR to also rename the compose volume key** `umami-db-data` → `umami-db-data-pg18`; without that rename a later deploy would reattach PG18's image to the stale PG15 data dir (or force a destructive `volume rm`). Rollback = revert BOTH the image pin AND the volume name in compose (one PR revert) + redeploy — the old volume is still addressable and unmutated, so the PG15 baseline returns with zero loss. The off-droplet **encrypted** dump is a second, independent rollback source. **Never `docker volume rm umami-db-data` until finalize.**
- **Staging dry-run before production cutover (R5):** restore the dump into a throwaway `postgres:18-alpine` + temp `umami:3.1.0` using the SAME `pg_restore` flags and the SAME restore-then-app-boot ordering the production cutover will use (so it exercises the real path, including umami's Prisma migrations against the restored schema — not a happy-path-only probe). Internal-only network, no published ports. Confirm `/api/heartbeat` + table/row parity, then tear down with verified remnant removal. This converts the PG18-compatibility assumption into evidence before any production downtime.
- **Password coherence is automatic — but the sentinel is written by hand:** the fresh PG18 volume bakes the `umami` role password from `${POSTGRES_PASSWORD}` in `/opt/umami/.env`, which already equals `UMAMI_DB_PASSWORD`; the password value never changes. However, because the cutover runs manually outside `deploy.ts`, the runbook MUST explicitly write/refresh `/opt/umami/.db-password-fingerprint` to the value `deploy.ts` expects and confirm the next `umami deploy` is a clean sentinel no-op. "Same password" is not a proxy for "sentinel present and correct." The migration must not alter the password.
- **Renovate ceiling + manual gate on `postgres` (R1):** add `allowedVersions: '<16'` (or the equivalent hold) plus `automerge: false` + `dependencyDashboardApproval: true` to the postgres packageRule, mirroring the `fro-bot/agent` pattern, so a major bump cannot auto-PR/auto-merge/auto-deploy ahead of this runbook. The ceiling is lifted to `<19` only as part of the executed cutover (Unit 3).
- **Runbook artifact, not deploy-code change:** the procedure lives in `docs/runbooks/umami-postgres-major-upgrade.md`. The recurring deploy path is unchanged.

## Open Questions

### Resolved During Planning

- *In-place `pg_upgrade` vs dump/restore?* → dump/restore (size + single-binary image + multi-major).
- *Target 16/17 first, or 18 directly?* → 18 directly; logical restore crosses majors; intermediate hops add steps and risk.
- *Does the password need rotating during migration?* → No. Fresh volume re-bakes the existing password unchanged; fingerprint stays coherent.
- *Codify in deploy.ts or runbook?* → Runbook (one-time event; YAGNI on deploy machinery).
- *How to keep the old volume as rollback anchor while running PG18?* → Migrate to a NEW named volume `umami-db-data-pg18`; rename the compose volume key in Unit 3's PR. Reusing `umami-db-data` for PG18 would require destroying the anchor — rejected.
- *Do it now or defer?* → Land Unit 1 (guard) now; defer Units 2–3 (migration execution) until a real forcing function. The runbook is authored now for readiness; execution is not urgent (PG15 → Nov 2027).

### Deferred to Implementation

- *Exact latest `postgres:18-alpine` digest to pin* — resolve at cutover time from the Renovate PR / registry, not now (a digest pinned today may be stale by execution).
- *Whether `pg_restore --no-owner --no-privileges` or a plain-SQL restore yields the cleanest result against the fresh role* — determined during the staging dry-run, where both are cheap to try against the 9 MB dump.
- *Exact downtime window* — measured during the staging dry-run; expected to be seconds, but confirmed empirically before scheduling the production cutover.

## Implementation Units

- [ ] **Unit 1: Renovate major-bump guard for `postgres`**

**Goal:** Make it impossible for a Postgres major bump to auto-PR, auto-merge, or auto-flow to a deploy ahead of the migration runbook. Satisfies R1 independently of when the migration runs.

**Requirements:** R1

**Dependencies:** None. Can land immediately, before any migration work.

**Files:**
- Modify: `.github/renovate.json5`

**Approach:**
- Extend (or add) the `postgres` docker packageRule with `allowedVersions: '<16'` to hold at the 15.x line, plus `automerge: false` and `dependencyDashboardApproval: true`, mirroring the `fro-bot/agent` rule already in the file. Add a comment explaining the ceiling exists because a Postgres major is a data-directory migration governed by `docs/runbooks/umami-postgres-major-upgrade.md`, not an image swap.
- Minor/patch PG15 updates continue to flow normally (the ceiling only blocks ≥16).
- Ship this as a **standalone safety change ahead of (and independent of) the migration** — it is the do-now part; Units 2–3 are deferred-ready.

**Patterns to follow:**
- The `fro-bot/agent` packageRule in `.github/renovate.json5` (ceiling + `automerge: false` + `dependencyDashboardApproval: true` + explanatory comment).

**Test scenarios:**
- Happy path: `renovate-config-validator` (current Renovate version) reports the config valid.
- Edge case: confirm the existing `postgres` changelog/sourceUrl packageRule (if separate) is not contradicted — the ceiling and the metadata rule must coexist without one overriding the other.

**Verification:**
- Renovate config validates. A subsequent Renovate run will not open a PG≥16 PR at all while the `<16` ceiling holds — `allowedVersions` excludes those versions outright. (`dependencyDashboardApproval: true` gates the *allowed* in-range updates and remains in force after the ceiling is later lifted, so the *next* major still requires explicit approval; it is not what blocks PG16+ today — the ceiling is.)

- [ ] **Unit 2: Migration runbook**

**Goal:** A durable, operator-followable runbook capturing the full dump/restore migration with staging validation, preserve-old-volume rollback, password/fingerprint coherence, and verification. Satisfies R2–R6 as written procedure.

**Requirements:** R2, R3, R4, R5, R6

**Dependencies:** None (can be authored alongside Unit 1). Must be complete and reviewed before Unit 3 is executed.

**Files:**
- Create: `docs/runbooks/umami-postgres-major-upgrade.md`

**Approach:** The runbook documents this sequence (commands belong in the runbook itself; the plan specifies the required shape, ordering, and gates):
1. **Pre-flight** — record live `server_version`, the table list WITH row counts, and DB size; confirm `UMAMI_DB_PASSWORD` matches the live role (a successful `psql -U umami` over the compose network); confirm disk headroom; resolve the target `postgres:18-alpine` digest; capture `docker volume ls` so the PG15 anchor `umami-db-data` is provably identifiable.
2. **Backup (irreversibility gate)** — `pg_dump -U umami -d umami -Fc` over the compose network to a droplet file; verify it (`pg_restore --list`). Copy it off-droplet over the existing SSH channel and **encrypt with a concrete named mechanism** (e.g. `age` or `gpg --symmetric` with a key the operator controls, not an ad-hoc choice at execution time) so storage is encrypted-at-rest; then **verify the copied artifact** by checksum (`sha256sum` matches source) AND a test decrypt + `pg_restore --list` of the off-droplet copy. Record an explicit **deletion deadline** (destroy 7 days after successful finalize). The dump contains analytics data AND the admin credential hash — treat as a secret. **No destructive or volume-touching step may run until the off-droplet encrypted dump is verified present, checksum-matched, and decrypt-tested.**
3. **Staging validation (R5)** — restore the dump into a throwaway `postgres:18-alpine` + temp `umami:3.1.0` using a **unique temp compose project name, an internal-only Docker network, and NO published host ports** (never publicly reachable, no Caddy in front). Use the SAME `pg_restore` flags and the SAME db-then-app startup ordering the production cutover will use, so staging exercises the real boot path. **Capture the umami container's Prisma migration output on first boot against the restored schema and confirm it is an idempotent no-op (no pending migrations applied, no schema drift)** — the production cutover relies on this, so it must be evidence from staging, not an assumption. Confirm `/api/heartbeat` healthy, table count = 18, row counts match pre-flight. Then **tear down rigorously**: remove the temp containers, temp volume, and temp project, and verify nothing remains (`docker volume ls` / `docker ps -a`) so no production data (admin hash, visitor data) lingers in a stray volume or image layer.
4. **Cutover (R2, R3, R4)** — stop `caddy`, `umami`, then `db` (traffic quiesced). Leave `umami-db-data` (PG15) untouched. Start ONLY the PG18 `db` against the NEW empty volume `umami-db-data-pg18` so it re-bakes the `umami` role password from `/opt/umami/.env` (unchanged → fingerprint stays valid). **Restore the dump and verify restore completion BEFORE starting the umami app** — the empty PG18 init already created a `umami` db owned by `umami`, so restore with explicit, reproducible flags (default `--no-owner --no-privileges` into the pre-created role; finalize exact flags from the staging run). Only after restore is verified, start `umami` (it runs Prisma migrations against the fully-restored schema — confirm they are idempotent no-ops), then `caddy`.
5. **Fingerprint coherence (R3)** — the cutover is manual (outside `deploy.ts`), so the runbook MUST write/refresh `/opt/umami/.db-password-fingerprint` to the value `deploy.ts` expects for the unchanged password, then confirm a subsequent `umami deploy` is a clean no-op on the sentinel. State the exact sentinel content/derivation; do not rely on "same password" as a proxy for "same sentinel state."
6. **Verification (R2)** — `/api/heartbeat` healthy; table count = 18; spot-check row counts vs pre-flight; authenticated login succeeds; public `https://metrics.fro.bot` serves; the `systematic` website + its `data-website-id` intact; **privacy invariants confirmed** (`PRIVATE_MODE=1`, `DISABLE_TELEMETRY=1` still in effect; no visitor-hash/app-secret state reset).
7. **Rollback (R4)** — at any failure before final confirmation: redeploy the reverted compose (PG15 image + `umami-db-data` volume name); the preserved volume returns the PG15 baseline with zero loss; independently, the off-droplet dump can rebuild either major. The runbook gives an explicit rollback matrix: (a) droplet-only steps, (b) repo-revert steps if the pin PR already landed, (c) which is authoritative if they conflict.
8. **Finalize** — **final confirmation = 7 days of healthy production operation** (heartbeat green plus at least one clean no-op `umami deploy`). Only then remove the preserved `umami-db-data` PG15 volume and the on-droplet dump, and destroy the off-droplet dump per its deletion deadline.

**Patterns to follow:**
- `docs/runbooks/discord-token-lifecycle.md` for structure (containment-first ordering, explicit commands, audit/verification sections).
- The `apps/umami/AGENTS.md` `ALTER USER` rotation runbook and the admin-rotation-over-compose-network lesson (don't use host `localhost:3000`).

**Test scenarios:**
- Test expectation: none — this unit is operator documentation. Its correctness is validated by the staging dry-run it prescribes (step 3) and by the Unit 3 execution, not by automated tests.

**Verification:**
- The runbook is self-contained: an operator can execute it end-to-end without external context, every destructive step has a stated rollback, and the staging-validation step gates the production cutover.

- [ ] **Unit 3: Execute cutover + land the pin bump**

**Goal:** Perform the migration on `metrics.fro.bot` following Unit 2, and land the accompanying repo changes (compose pin 15→18, AGENTS.md, lifted Renovate ceiling) once the live stack is verified healthy on PG18.

**Requirements:** R2, R3, R5 (executed), and lifts the R1 ceiling deliberately.

**Dependencies:** Unit 1 (guard in place), Unit 2 (runbook reviewed). Operator-gated — requires explicit approval before the production cutover, per deploy-approval discipline.

**Files:**
- Modify: `apps/umami/docker-compose.yaml` (pin `postgres:15-alpine@sha256:...` → `postgres:18-alpine@sha256:<resolved digest>` AND rename the `db` volume key `umami-db-data` → `umami-db-data-pg18` to match the migrated cluster — without this rename a later deploy reattaches PG18 to the stale PG15 data dir)
- Modify: `apps/umami/AGENTS.md` (Postgres version reference; note the migration is complete and point to the runbook)
- Modify: `.github/renovate.json5` (lift the postgres ceiling from `<16` to `<19` so future PG18 patch/minor updates flow normally; keep `automerge: false` + `dependencyDashboardApproval: true` so the *next* major still requires a runbook)

**Approach:**
- **Prepare the repo PR (compose pin 15→18 + volume key rename + AGENTS.md + ceiling lift) and get it review-approved but UNMERGED *before* starting the cutover.** Post-cutover convergence is then a single immediate merge of an already-reviewed change, not authoring under time pressure.
- **Impose an explicit deploy freeze for the cutover window** — no `umami deploy` (manual or Renovate-triggered) may run between the start of the cutover and the repo PR landing. This is enforceable precisely because the `umami` deploy workflow is environment-gated (requires `marcusrbrown` approval): the operator approves no umami deploy during the window and holds any in-flight Renovate umami PR. **Without this freeze, an unrelated deploy in the window uploads the still-PG15 `main` compose and reattaches the preserved `umami-db-data` (PG15) volume — silently rolling back to stale data after PG18 has accepted writes.** This is the failure mode the review flagged and the reason the window must be both short and deploy-free.
- Execute the Unit 2 runbook against the live droplet (staging validation → cutover → verify). The deploy script never recreates the volume, so the cutover's volume handling is done by the runbook directly on the droplet.
- **Immediately after live verification**, merge the pre-approved repo PR so `main` matches the droplet (PG18 image + `umami-db-data-pg18` volume name), then lift the freeze. The volume name in the PR must exactly match the volume the runbook created on the droplet.
- **Ordering invariant:** `main` must never be deployed while its compose disagrees with the droplet's volume identity. The pre-approved PR + deploy freeze guarantee that disagreement window is short *and* contains no deploys. This documents an already-executed, already-verified migration — analogous to how upstream pin bumps land after live confirmation elsewhere in this repo.

**Patterns to follow:**
- The gateway/cliproxy convention of bumping a pinned version in the repo *after* verifying the live deploy, with AGENTS.md updated to match.

**Test scenarios:**
- Happy path: post-cutover, `bunx @marcusrbrown/infra umami status` reports all services healthy and the live `server_version` is 18.x.
- Integration: the `systematic` website row and its `data-website-id` survive the migration (query the live DB post-restore).
- Edge case: a subsequent normal `umami deploy` (no migration) does not abort on the fingerprint sentinel — confirming password coherence held.
- Window safety: confirm no `umami deploy` ran between cutover start and PR merge (check the deploy-workflow run history for the freeze window); the first post-merge deploy is a clean no-op against the already-running PG18 stack.

**Verification:**
- Live droplet on PG18.x, all services healthy, `/api/heartbeat` OK, public HTTPS serving, website data intact; `main`'s compose pin matches the running image; Renovate ceiling lifted to `<19` with the major-gate retained.

## System-Wide Impact

- **Interaction graph:** the `db` service is the dependency root — `umami` `depends_on: db service_healthy`, and `caddy` fronts `umami`. The migration touches only `db`'s image + volume; the umami/caddy services and their config are unchanged.
- **Error propagation:** if the new PG18 `db` fails health, `up -d --wait` times out and `umami` never starts — a *loud* failure, not silent corruption. The preserve-old-volume design means this failure is fully reversible.
- **State lifecycle risks:** the central risk is the volume. Mitigated by (a) preserving the old PG15 volume untouched, (b) an off-droplet dump, (c) staging validation before prod. The `.db-password-fingerprint` sentinel is the second state artifact — kept coherent by not changing the password.
- **API surface parity:** none — no CLI flags, env contracts, or workflow inputs change in Units 1–2. Unit 3 changes only a pinned image digest and docs.
- **Integration coverage:** the staging dry-run is the integration test that unit tests cannot provide — it proves the real umami binary speaks to a real PG18 cluster restored from the real dump.
- **Unchanged invariants:** `UMAMI_DB_PASSWORD`, `UMAMI_APP_SECRET`, admin credentials, droplet size/region, the deploy success-gate sequence (DB+app healthy → admin rotated → Caddy public), and `DATABASE_URL` shape all remain exactly as today.

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Renovate auto-applies a major PG bump destructively before migration | Low (after Unit 1) | High | Unit 1 ceiling + `automerge: false` + `dependencyDashboardApproval: true`; lands first, independent of migration timing |
| `umami:3.1.0` incompatible with PG18 | Low | High | Staging dry-run (R5) proves compatibility before any production downtime; if it fails, abort with zero prod impact |
| Data loss during cutover | Very low | High | New volume `umami-db-data-pg18`; old PG15 `umami-db-data` left untouched + off-droplet encrypted dump; backup-verified gate before any destructive step |
| Volume-identity drift (PG18 image reattaches stale PG15 dir, or anchor destroyed) | Medium (if unaddressed) | High | Migrate to a distinct volume name; Unit 3 PR renames the compose volume key to match; never `volume rm umami-db-data` until finalize |
| Operator fat-finger destroys the anchor mid-cutover | Low | High | Irreversible commands gated behind a confirmation checkpoint AFTER off-droplet dump verification; "prepare new volume" separated from any "touch old volume" step |
| Umami app boots before restore completes → migrates against empty/half-restored DB | Medium (if ordered wrong) | High | Hard gate: restore + verify completion BEFORE starting the umami service; staging exercises the same restore-then-boot ordering |
| Password/fingerprint incoherence bricks next deploy | Low | Medium | Password unchanged AND runbook explicitly writes `/opt/umami/.db-password-fingerprint`; post-cutover check that a normal deploy is a sentinel no-op |
| Off-droplet dump leaks (admin hash + visitor data) | Low | Medium | Encrypted-at-rest off-droplet; explicit deletion deadline (destroy 7 days post-finalize); treated as a secret |
| Staging leaves production-data remnants on the droplet | Low | Low | Unique temp project, internal-only network, no published ports; verified teardown of temp containers + volume |
| Dump is corrupt/incomplete | Very low | High | `pg_restore --list` verifies the dump; staging restore exercises it end-to-end before prod |
| Extended downtime | Very low | Low | 9 MB DB → seconds; window measured in staging before scheduling |
| `main` pin claims PG18 before droplet is migrated | Low | Medium | Unit 3 lands the repo pin only *after* live verification; volume name in PR matches the droplet |
| Unrelated deploy in the cutover window reattaches the PG15 volume (post-cutover data regression) | Medium (if window unmanaged) | High | Pre-approve the pin/volume-rename PR *before* cutover; impose an explicit deploy freeze (env-gated approval held) for the window; merge immediately after verification; first post-merge deploy must be a clean no-op |

## Documentation / Operational Notes

- New runbook `docs/runbooks/umami-postgres-major-upgrade.md` is the primary deliverable of Unit 2; cross-link it from `apps/umami/AGENTS.md`.
- After the migration, `apps/umami/AGENTS.md` should reflect PG18 and note the runbook is reusable for the next major (the procedure is version-agnostic).
- Consider (separately) whether the proven dump step motivates a standing backup cadence — deferred.

## Sources & References

- Live probe (2026-06-01): `server_version 15.18`, DB 9 MB / 18 tables, droplet 19 GB free.
- Related code: `apps/umami/docker-compose.yaml`, `apps/umami/src/deploy.ts`, `apps/umami/AGENTS.md`, `.github/renovate.json5`.
- Institutional learnings: `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`, `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md`, `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md`.
- Runbook template: `docs/runbooks/discord-token-lifecycle.md`.
