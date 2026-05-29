---
date: 2026-05-29
topic: cliproxy-v7-upgrade
---

# CLIProxyAPI v6 → v7 Upgrade

## Summary

Upgrade the production CLIProxyAPI deployment at `cliproxy.fro.bot` from v6.10.9 to v7.1.31, making our CLI and deploy tooling v7-compatible, fixing the breaking change to the management usage endpoint, hardening management calls against v7's new IP-ban, and rolling out behind a token-volume backup with a smoke window. Scope is **minimal compatibility** — make v7 work and fix what breaks; no adoption of v7's new management surface.

---

## Problem Frame

`cliproxy.fro.bot` is central production infrastructure: every Fro Bot instance (including this repo's CI) routes Claude and OpenAI/Codex traffic through it. The deployment is pinned to a v6.10.9-era image. Issue #232 (Upstream Modernization Watch) has flagged the v6→v7 major-version gap as a standing action item for several weeks, with each weekly scan surfacing more Claude-relevant fixes landing in v7.

The v7 line is GA and fast-moving (v7.1.31, 31 patches in ~2 weeks). The concrete pressure: v7 carries reliability fixes that matter for our tool-heavy agent traffic — corrected tool-name reverse-mapping, extended/interleaved thinking translation with reasoning-signature handling, and current Claude model support (Opus 4.8 / Sonnet 4.5). Staying on v6 keeps us drifting from a moving upstream and, per empirical testing, leaves a latent bug in place: the `/v0/management/usage` endpoint our `cliproxy status` depends on already returns 404 on v6.10.9, so our usage check is already broken — the upgrade is the natural moment to fix it.

The cost shape of getting this wrong is high: a botched upgrade degrades Claude/OpenAI routing for all consumers at once, and v7 introduces an IP-ban that can lock out the operator's own management access after a few bad-key attempts.

---

## Actors

- A1. **Operator (Marcus):** runs the upgrade, performs the prod backup + smoke window, holds the rollback decision.
- A2. **CLI / deploy tooling:** `infra cliproxy *` commands + `apps/cliproxy/src/deploy.ts` that call the management API and must stay v7-compatible.
- A3. **Downstream consumers:** Fro Bot / OpenCode instances (incl. this repo's CI) routing Claude + OpenAI traffic through the proxy — must see no routing regression.

---

## Requirements

**Image & config compatibility**
- R1. Pin the proxy image to `eceasy/cli-proxy-api:v7.1.31` by digest in `apps/cliproxy/docker-compose.yaml` (Renovate-tracked, numbered tag + digest per repo convention).
- R2. Verify the Docker healthcheck (`wget` → `/healthz`) still passes on v7.1.31 — confirmed in Oracle's local container test; re-confirm on the live droplet post-deploy.
- R3. Preserve the server's runtime `config.yaml` on the droplet (no force-upload). Before upgrade, confirm the live config contains no removed `ClaudeCodeSessionAffinity` named strategy. Our `auth-dir: /root/.cli-proxy-api` is set explicitly, so the v7 empty-`auth-dir` default change does not affect us.

**Management API compatibility (CLI tooling)**
- R4. Migrate the usage check in `packages/cli/src/commands/cliproxy/status.ts` from the removed `/v0/management/usage` to `GET /v0/management/usage-queue?count=N`. Present it as a recent-activity summary over the queue window (e.g. "recent requests: N, errors: M"), not a historical aggregate. An empty queue reports OK/idle, never ERROR. Unknown/malformed response shape warns rather than fails closed.
- R5. Make management checks IP-ban-aware across **every** management-keyed flow (not just `status.ts` — also `deploy.ts` preflight + post-deploy health gate, and the R8 smoke step): perform a single management auth probe before any parallel management calls; if auth fails (401/403), skip the remaining checks; recognize a v7 IP-ban response (403 + ban body) as a distinct "stop retrying for ~30 minutes" warning, and require a 30-minute pause before any further management-keyed attempt after a ban. Never issue parallel or retried management calls before key validity is established. (deploy already aborts on the first 401/403 — preserve that single-attempt property.)
- R6. Confirm the unchanged-in-v7 management paths our tooling already uses stay working: `api-keys` GET / PUT (bare array) / DELETE (`?value=`), `config` GET, per-field PUT `{value}`, `latest-version`. (Oracle verified these on v7.1.31; treat as regression-guard, not new work.)

**Setup validation hardening**
- R7. Defensively fix the `owned_by` hard-fail in `packages/cli/src/commands/cliproxy/setup/validation.ts`: when `/v1/models` entries omit `owned_by`, infer the provider from the selected provider/model prefix instead of hard-failing setup. (v7 does not document a fix for this; our known issue may persist.) This is a deliberate **opportunistic fix** (a pre-existing bug, not caused by v7) bundled because the upgrade touches this validation area — keep it to the minimal infer-from-prefix change with no extra refactor surface and no verification beyond the existing setup flow. The inference is **display/validation-only — never an authorization or token-trust signal**.

**Secret handling**
- R10. The production management key must never appear in logs, stack traces, shell history, or artifacts during status/deploy/smoke; management requests use the `x-management-key` header only (never `Authorization: Bearer`, never secret bytes in argv), with redaction enforced on verbose/error output.

**Rollout & verification**
- R8. Roll out via: back up the `cliproxy_auth` Docker volume (exact on-droplet volume name resolved at execution time) + live `/opt/cliproxy/config/config.yaml` on the droplet → bump the image digest → `docker compose up -d --wait` (brief downtime acceptable) → smoke `/healthz`, `/v0/management/config`, one live Claude `/v1/messages`, and one OpenAI `/v1/models` with the production key → documented rollback to the v6.10.9 digest with volume restore if the smoke fails. The volume backup contains live OAuth tokens for all proxy consumers — **handle it as a secret**: local-only transfer, encrypted if it ever leaves the host, minimum retention, explicit deletion after a successful cutover, never logged or attached to shared artifacts.

**Documentation**
- R9. Update `apps/cliproxy/AGENTS.md` to reflect v7 reality: the management API surface (usage-queue replaces usage; note the IP-ban behavior), the corrected deploy preflight/health endpoint (docs currently say `/api-keys`; code uses `/config`), and the v7 image pin.

---

## Acceptance Examples

- AE1. **Covers R4.** Given the proxy is idle (empty usage-queue), when `infra cliproxy status` runs, the usage line reports OK/idle (e.g. "recent requests: 0") — not an ERROR.
- AE2. **Covers R4.** Given the usage-queue returns an unexpected shape, when `cliproxy status` parses it, the usage line surfaces a warning and the rest of the status still renders — it does not fail closed.
- AE3. **Covers R5.** Given an invalid management key, when `infra cliproxy status` runs, it makes at most one failed management auth attempt (not the current two-via-parallel), so repeated runs cannot trip the 5-attempt IP ban as quickly.
- AE4. **Covers R5.** Given the operator IP is already banned (403 + ban body), when `cliproxy status` runs, it reports a distinct "IP banned, stop retrying ~30 min" message rather than a generic auth error.
- AE5. **Covers R7.** Given `/v1/models` returns OpenAI entries with no `owned_by` field, when `cliproxy setup` validates models, it infers the provider from the model id/prefix and does not hard-fail.

---

## Success Criteria

- `cliproxy.fro.bot` runs v7.1.31 with all OAuth tokens intact; one live Claude `/v1/messages` and one OpenAI `/v1/models` call succeed with the production key after cutover.
- `infra cliproxy status` and `infra status --json` render correctly against v7 (usage line honest about the recent-window semantics, no false ERROR).
- A downstream Fro Bot run (this repo) routing Claude + OpenAI through the proxy succeeds post-upgrade with no consumer-visible regression.
- The plan/implementer can execute without re-deriving the v7 breaking changes — they are captured here with the empirical verification source.
- Rollback path is documented and known-good before the production image bump.

---

## Scope Boundaries

- **No adoption of new v7 management endpoints** — `/auth-files` CRUD, `/{provider}-auth-url` OAuth initiation, `/config.yaml` GET/PUT, `/vertex/import` are out of scope (YAGNI for a single-droplet, single-operator deployment). They must remain **unused and unwired** in prod for this upgrade — no CLI surface targets them.
- **No management-API-client refactor** — while touching `status.ts` for R4/R5, do not extract shared abstractions, unify endpoints, or add a retry/polling framework beyond the minimal single-probe change R5 requires.
- **No usage persistence** — not wiring up the Redis RESP interface or an external usage dashboard (CPA Usage Keeper, etc.); the recent-window summary is sufficient. Retention tuning (`redis-usage-queue-retention-seconds`) is out of scope (per-field PUT for it 404'd in Oracle's local test; would need a live config.yaml patch path).
- **No separate staging droplet** — Oracle's local-container validation + a prod backup/smoke window is the chosen rollout; no throwaway droplet provisioned.
- **No new providers** — xAI/Grok, Gemini, Antigravity, Vertex routing is not being added; we proxy Claude + OpenAI only.
- **No SDK work** — we don't embed the CLIProxyAPI Go SDK, so the `/v6`→`/v7` module path change is N/A.
- **Not changing `/v1/messages` or `/v1/chat/completions` client contracts** — these are unchanged in v7; consumers are unaffected at the request-shape level.

---

## Key Decisions

- **Minimal-compatibility scope (not capability adoption, not defer):** the Claude tool-name + reasoning-translation reliability fixes justify upgrading now; Codex wins alone would not. New v7 management surface is deferred as YAGNI.
- **Usage status = recent-activity summary, warn-not-error:** v7's usage-queue is a 60s in-memory window, not v6's aggregate. Re-label honestly; idle proxy = healthy, not broken. Also fixes the already-404 `/usage` check on our current v6.
- **IP-ban awareness is in-scope, not deferred:** v7's 5-bad-attempt → 30-min IP ban can lock out the operator; our `status.ts` fires concurrent management calls (2 failed attempts/run with a bad key). Single-probe-first is a required hardening, not a nice-to-have.
- **Local-smoke + prod-backup + smoke-window rollout:** matches our existing single-droplet deploy model; no staging-droplet cost. Token volume treated as persistent data (backup before, restore on rollback).
- **`owned_by` fixed defensively regardless of v7:** the hard-fail is our bug; v7 doesn't document a fix, so infer-provider-from-prefix is the durable fix.

---

## Dependencies / Assumptions

- v7.1.31 reads the existing v6 OAuth token format in `cliproxy_auth` (Oracle: likely compatible — v7 only adds a `disabled` metadata flag — but not upstream-guaranteed; the backup/restore path covers the risk).
- `doctl` access + the `cliproxy_auth` volume name on the droplet (likely `cliproxy_cliproxy_auth`) for the backup step.
- Production management key available for the post-cutover smoke (used sparingly — never run the wrong-key/ban test against prod).
- Renovate continues to track the numbered v7 tag + digest after the pin (existing packageRule for `eceasy/cli-proxy-api`).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Needs research] Exact shape of a `/usage-queue` record (field names for status/error, token counts) — confirm against a v7 container with real traffic so the recent-activity summary aggregates the right fields. Oracle saw an empty `[]` locally; the populated shape is unverified.
- [Affects R7][Needs research] Whether v7's loaded-token `/v1/models` actually omits `owned_by` for OpenAI/Codex entries — Oracle couldn't load a Codex token locally. Confirm empirically; the defensive fix lands regardless, but the test confirms whether it's actually exercised.

### Resolve at Execution (rollout prerequisites, not planning blockers)

- [Affects R3] Read the live `/opt/cliproxy/config/config.yaml` on the droplet before the image bump to confirm no removed/renamed v6 fields (`ClaudeCodeSessionAffinity`) are present. Folded into R3's pre-upgrade step.
- [Affects R8] Resolve the exact `cliproxy_auth` Docker volume name on the droplet + the backup/restore command (volume tar vs `cp`) at rollout time. Folded into R8's backup step; does not block planning.
