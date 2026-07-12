---
title: 'feat: CLIProxyAPI v6 → v7 upgrade (minimal compatibility)'
type: feat
status: completed
date: 2026-05-29
origin: docs/brainstorms/2026-05-29-cliproxy-v7-upgrade-requirements.md
---

# feat: CLIProxyAPI v6 → v7 upgrade (minimal compatibility)

## Overview

Upgrade the production CLIProxyAPI deployment at `cliproxy.fro.bot` from v6.10.9 to v7.1.31. Make our CLI + deploy tooling v7-compatible, migrate the removed management usage endpoint, harden management calls against v7's new IP-ban, defensively fix the `owned_by` setup hard-fail, then roll out behind a token-volume backup with a smoke window. Scope is **minimal compatibility** — make v7 work and fix what breaks; no adoption of v7's new management surface.

The code changes land in one PR (Units 1–4). The production rollout (Unit 5) is operator execution after merge.

## Problem Frame

`cliproxy.fro.bot` proxies Claude + OpenAI/Codex OAuth-subscription traffic for every Fro Bot instance, including this repo's CI. It's pinned to a v6.10.9-era image; issue #232 has flagged the v6→v7 gap for weeks. v7 (GA, v7.1.31) carries reliability fixes that matter for tool-heavy agent traffic — corrected tool-name reverse-mapping, extended/interleaved thinking translation, current Claude models. Oracle verified against live v6.10.9 + v7.1.31 containers that the code blast radius is small but the operational risk is real: the usage endpoint is removed (and already 404 on our v6), v7 bans the IP after 5 bad management-key attempts, and OAuth tokens live in a persistent volume. See origin: `docs/brainstorms/2026-05-29-cliproxy-v7-upgrade-requirements.md`.

## Requirements Trace

- R1. Pin `eceasy/cli-proxy-api:v7.1.31` by digest (Renovate-tracked). → Unit 3
- R2. Verify the `wget`→`/healthz` healthcheck passes on v7.1.31. → Unit 3 (+ Unit 5 live)
- R3. Preserve the server's runtime `config.yaml`; confirm no removed `ClaudeCodeSessionAffinity` field. → Unit 3 / Unit 5
- R4. Migrate the `status.ts` usage check from removed `/v0/management/usage` to `/usage-queue?count=N` as a recent-activity summary; empty=OK, malformed=warn-not-fail. → Unit 2
- R5. Make management checks IP-ban-aware: single auth probe before parallel calls; recognize 403+ban-body. → Unit 2 (status.ts implementation); Unit 3 verifies the deploy side is already single-attempt-compliant (no code change expected).
- R6. Regression-guard the unchanged-in-v7 management paths (api-keys, config GET, per-field PUT, latest-version). → Unit 2
- R7. Defensively fix the `owned_by` hard-fail in setup validation (infer provider from prefix). → Unit 1
- R8. Token-volume-backed staged rollout with smoke + documented rollback. → Unit 5
- R9. Update `apps/cliproxy/AGENTS.md` to v7 reality (usage-queue, IP-ban, corrected preflight endpoint, image pin). → Unit 4
- R10. Management key never in logs/history/argv; `x-management-key` only, redacted on verbose/error. → Unit 2 + Unit 4

## Scope Boundaries

- No adoption of new v7 management endpoints (`/auth-files`, `/{provider}-auth-url`, `/config.yaml` PUT, `/vertex/import`) — they stay unused and unwired; no CLI surface targets them.
- No management-API-client refactor while touching `status.ts` — no shared-abstraction extraction, no endpoint unification, no retry/polling framework beyond R5's single-probe change.
- No usage persistence (Redis RESP / external dashboard); no `redis-usage-queue-retention-seconds` tuning.
- No separate staging droplet — local-container smoke + prod backup/smoke window.
- No new providers (xAI/Grok, Gemini, Antigravity, Vertex); Claude + OpenAI only.
- No SDK work (we don't embed the Go SDK; `/v6`→`/v7` module path is N/A).
- `/v1/messages` and `/v1/chat/completions` client contracts unchanged — consumers unaffected.

### Deferred to Separate Tasks

- v7 capability adoption (auth-files CRUD, usage persistence): separate brainstorm if ever wanted.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/cliproxy/status.ts` — `checkUsageStats` (line 97, calls `/v0/management/usage` at line 98 — the removed endpoint); `checkVersion` (154); `formatUsageSummaryLine` (214); `getCliproxyStatusSummary` (229, `Promise.all` management block at 233); `cliproxyStatusAction` (260, second `Promise.all` at 270). Two parallel-call sites to make ban-aware.
- `packages/cli/src/commands/cliproxy/setup/validation.ts` — `owned_by: z.string()` in the model Zod schema (line 11, fails parse when absent); provider detection `e.owned_by === 'openai'` (line 125). Both need the defensive change; `parseProviders`/prefix logic already exists (lines 36-48, 131-134) to infer from the model id.
- `apps/cliproxy/docker-compose.yaml` — image pin (line 17, currently `v6.10.9@sha256:e36bfc…`); healthcheck `wget --spider -q http://localhost:8317/healthz` (line 25); `cliproxy_auth:/root/.cli-proxy-api` volume (line 31).
- `apps/cliproxy/src/deploy.ts` — preflight + health gate hit `/v0/management/config` (NOT `/api-keys` as AGENTS.md claims); skips uploading `config.yaml` when present (R3 is already deploy behavior).
- `.github/renovate.json5` — `eceasy/cli-proxy-api` packageRule (line 15) already carries `sourceUrl`/`changelogUrl`; the digest bump rides existing tracking.
- `apps/cliproxy/config/config.yaml` — `auth-dir: /root/.cli-proxy-api` set explicitly (v7 empty-default change is N/A).

### Institutional Learnings

- Memory 4151: `/v0/management/usage` is 404 on BOTH v6.10.9 and v7.1.31 (Oracle, live containers) — our usage check is already broken; v7's `/usage-queue?count=N` returns per-request records, in-memory, 60s default retention.
- Memory 4152: v7 IP-bans after 5 bad management-key attempts (~30 min, then even the correct key 403s); our `status.ts` fires 2 parallel attempts/run with a bad key.
- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — the never-overwrite-config.yaml lesson (reinforces R3).

### External References

- v7 endpoint behavior verified empirically by Oracle (local v6.10.9 + v7.1.31 containers, 2026-05-29). Librarian release-notes pass + https://github.com/router-for-me/CLIProxyAPI/releases. v7.1.31 index digest observed: `sha256:258adde463035ade7a69d1dd722a8bbdec554930efc72415224a852e5ea3d49a` (re-resolve at implementation time).

## Key Technical Decisions

- **One status.ts unit for R4+R5+R6:** the usage migration and the ban-aware probe-first restructure touch the same `Promise.all` blocks in the same two functions; splitting them would have the two units stomping the same lines. One coherent management-flow rewrite.
- **`owned_by` fix = schema optional + infer-from-prefix:** make the Zod field optional so a missing `owned_by` doesn't fail parse, and replace `e.owned_by === 'openai'` detection with the existing model-prefix inference. Display/validation-only — never an authz signal.
- **Usage line = recent-activity summary, warn-not-error:** v7's queue is a 60s window, not an aggregate. Re-label honestly; idle=OK.
- **Image pin is a 2-line digest bump:** Renovate already tracks the package; no new config.
- **Rollout is a phased operator step (Unit 5), not part of the code PR:** the code merges first; production cutover happens after, behind a volume backup.

## Open Questions

### Resolved During Planning

- Should R4 + R5 be one unit or two? One — same file, same functions, interrelated `Promise.all` blocks.
- Does R7 touch one place or two? Two — Zod schema (line 11) + provider detection (line 125).
- Is R1 more than a digest bump? No — the Renovate packageRule already exists.
- Is R3 new deploy work? No — `deploy.ts` already preserves `config.yaml`; R3 is a pre-cutover verification step.

### Deferred to Implementation

- [Needs research] Exact `/usage-queue` record shape (status/error field names, token counts) — confirm against a local v7 container with traffic during Unit 2 before finalizing the aggregation. Oracle saw empty `[]`.
- [Needs research] Whether v7's loaded-token `/v1/models` actually omits `owned_by` for OpenAI entries — confirm against a v7 container with a real Codex token during Unit 1; the defensive fix lands regardless.

### Resolve at Execution (Unit 5 rollout)

- Read live `/opt/cliproxy/config/config.yaml` for removed `ClaudeCodeSessionAffinity` before the image bump.
- Resolve the exact `cliproxy_auth` Docker volume name on the droplet (likely `cliproxy_cliproxy_auth`) + backup command (volume tar vs `cp`).

## Implementation Units

- [ ] **Unit 1: Defensive `owned_by` fix in setup validation**

**Goal:** `cliproxy setup` no longer hard-fails when `/v1/models` entries omit `owned_by`; provider is inferred from the model id/prefix.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup/validation.ts`
- Test: `packages/cli/src/commands/cliproxy/setup/validation.test.ts` (extend the existing colocated test)

**Approach:**
- Make `owned_by` optional in the model Zod schema (line 11) so a missing field parses instead of throwing.
- Replace the `e.owned_by === 'openai'` provider detection (line 125). NOTE: the existing prefix logic (lines 36-48, 131-134) operates on the *requested model string*, not on `/v1/models` response entries — so this is a small NEW code change, not a pure reuse. Add a deterministic fallback that infers an entry's provider from its model `id` (e.g. an `openai/`-prefixed or known-OpenAI bare id), used only when `owned_by` is absent; prefer `owned_by` when present.
- Keep it display/validation-only; do not use the inferred provider for any auth/trust decision.
- No other refactor of the validation module.

**Execution note:** Test-first. Write a failing test with a `/v1/models` payload whose OpenAI entries omit `owned_by`, prove setup validation currently throws, then make it pass.

**Patterns to follow:** the existing prefix-matching logic in the same file (`parseProviders`, the slash-index split at line 131-134).

**Test scenarios:**
- Happy path: models payload WITH `owned_by` still validates and detects providers as before (regression guard).
- Error→fixed: payload with OpenAI entries missing `owned_by` no longer throws; provider inferred from prefix.
- Edge case: mixed payload (some entries with, some without `owned_by`) resolves correctly.
- Edge case: a model id with no resolvable prefix is handled without a crash (surfaces the existing "model not found"-style path, not a Zod parse throw).

**Verification:** `cliproxy setup` model validation passes against an `owned_by`-less payload; existing setup-validation tests still green.

- [ ] **Unit 2: v7-compatible, ban-aware management checks in status.ts**

**Goal:** `cliproxy status` works against v7 — usage check uses `/usage-queue`, management checks are single-probe-before-parallel (IP-ban-safe), unchanged endpoints still verified.

**Requirements:** R4, R5, R6, R10

**Dependencies:** None (independent of Unit 1)

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/status.ts`
- Test: `packages/cli/src/commands/cliproxy/status.test.ts`

**Approach:**
- **R4 usage migration:** change `checkUsageStats` to GET `/v0/management/usage-queue?count=N` (pick a sensible N, e.g. 50). Aggregate the returned array as a recent-activity summary (total = length; errors = records with a status≥400 / error marker — confirm field names against a v7 container first). Empty `[]` → OK/"(idle)". Unknown/malformed shape → warn-not-fail (return a warn-level CheckResult, never throw, never fail-closed). Update `formatUsageSummaryLine` wording to "recent" semantics, not historical total.
- **R5 ban-awareness:** restructure both `Promise.all` management blocks (`getCliproxyStatusSummary` line 233, `cliproxyStatusAction` line 270) so a single management auth probe runs first (cheapest authenticated call — GET `/v0/management/config`); only if it succeeds do version + usage run (may stay parallel after the probe). On 401/403, skip the rest. Detect a v7 IP-ban response (403 + ban body) and surface a distinct "IP banned — stop retrying ~30 min" message. No retries. There is no existing `fetchWithTimeout` helper in this module — implement the probe inline with `fetch(..., {signal: AbortSignal.timeout(...)})` (or a tiny local helper) as part of the status.ts edit; keep the `CheckResult` shape unchanged.
- **R6 regression guard:** keep `checkVersion` (`/latest-version`) and `checkHttpReachability` (`/config`) working; assert in tests.
- **R10:** ensure the management key is never interpolated into a logged string / error body; `x-management-key` header only.
- Stay within status.ts — no management-client abstraction extraction (scope fence).

**Execution note:** Test-first. The deferred `/usage-queue` shape question must be answered (local v7 container) before finalizing the aggregation; write the test against the confirmed shape.

**Patterns to follow:** existing `CheckResult` warn/error levels + `fetchWithTimeout` pattern already in status.ts; the snapshot/version-normalization test conventions in `status.test.ts`.

**Test scenarios:**
- Happy path: populated `/usage-queue` → recent-activity summary with correct total/error counts.
- Edge case: empty `[]` queue → OK/idle, not ERROR.
- Error path: malformed/unexpected usage-queue shape → warn-level result, status still renders (no fail-closed, no throw).
- R5: bad management key → exactly ONE failed management auth attempt per run (assert the probe gates the parallel calls; not 2 attempts).
- R5: 403 + ban body → distinct "IP banned" message surfaced.
- R6 regression: `checkVersion` + `checkHttpReachability` still parse the unchanged v7 responses.
- R10: a forced error path does not include the management key value in the surfaced message.

**Verification:** `infra cliproxy status` + `infra status --json` render correctly against a v7 container; bad-key run makes a single attempt; usage line honest about recent-window semantics.

- [ ] **Unit 3: Image pin + compatibility verification**

**Goal:** the stack runs v7.1.31 by pinned digest; healthcheck, config preservation, and deploy single-attempt management property confirmed compatible.

**Requirements:** R1, R2, R3, R5 (deploy side)

**Dependencies:** No code dependency on other units. Ships in the same PR as Units 1-2 (same-PR sequencing, not a code dependency) so CI runs against the full change.

**Files:**
- Modify: `apps/cliproxy/docker-compose.yaml` (image line 17 → `eceasy/cli-proxy-api:v7.1.31@sha256:<re-resolve>`)
- Verify-only (no change expected): `apps/cliproxy/src/deploy.ts` (preflight/health hit `/v0/management/config`, single attempt, abort on first 401/403 — confirm it satisfies R5 without edits), `apps/cliproxy/config/config.yaml` (auth-dir explicit)

**Approach:**
- Bump the image tag+digest to v7.1.31 (re-resolve the digest at implementation time; the observed index digest is in Context).
- Confirm the healthcheck command + path (`wget --spider /healthz`) is unchanged and valid on v7 (Oracle confirmed locally; this is a no-edit verification).
- Verify `deploy.ts` already makes a single management call in preflight + a single one in the health gate (both GET `/v0/management/config`), aborting on first 401/403 — confirming it is already R5-compliant on the deploy side. This unit expects NO deploy edit; if verification somehow shows a retry/parallel management call, that becomes a separate minimal fix (no broadening) — but the plan's premise (verified by Oracle) is that no edit is needed.
- Do not force-upload `config.yaml` (existing behavior).

**Execution note:** Mostly a config bump + verification. No new tests beyond confirming the existing deploy tests still pass; the image digest isn't unit-testable. `docker compose config` should still validate.

**Patterns to follow:** the existing digest-pin format on the caddy + image lines; prior cli-proxy-api digest bumps (Renovate PRs).

**Test scenarios:** Test expectation: none for the digest bump (no behavioral code change). Confirm `docker compose config` parses and existing `deploy.ts` tests stay green.

**Verification:** `docker compose config` valid with the v7 image; deploy test suite green; manual confirmation deferred to Unit 5 (live healthcheck + smoke).

- [ ] **Unit 4: Docs — AGENTS.md to v7 reality**

**Goal:** `apps/cliproxy/AGENTS.md` reflects v7: usage-queue replaces usage, the IP-ban behavior, the corrected deploy preflight/health endpoint, the v7 image pin, and the key-redaction rule.

**Requirements:** R9, R10

**Dependencies:** Same-PR sequencing after Units 1-3 (document the behavior as actually implemented) — not a code dependency.

**Files:**
- Modify: `apps/cliproxy/AGENTS.md`

**Approach:**
- Management API table: replace `/v0/management/usage` row with `/v0/management/usage-queue?count=N` (recent-window, in-memory) and note it superseded the removed aggregate endpoint.
- Add an anti-pattern / operational note: v7 IP-bans after 5 bad `x-management-key` attempts (~30 min); never run wrong-key tests against prod; management checks are single-attempt.
- Correct the stale claim that deploy preflight/health hits `/api-keys` → it hits `/v0/management/config`.
- Update the image reference to v7.1.31.
- Note the management-key redaction rule (R10).
- No plan-taxonomy strings in the doc.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** AGENTS.md management API section matches the shipped status.ts behavior; no stale `/usage` or `/api-keys`-preflight references remain.

## Phased Delivery

### Phase 1 — Code PR (Units 1-4)

Land Units 1-4 in one branch/PR. Verify: full test suite, tsc, lint, taxonomy gate; `docker compose config` valid. The two deferred empirical unknowns (usage-queue shape, owned_by presence) are resolved during Units 1-2 against a local v7 container before finalizing those tests. ce:review (security + cli-readiness + reliability among others) before push, given management-auth + IP-ban surface. No changeset for the apps/* + AGENTS.md parts; the `status.ts`/`validation.ts` changes ARE published `packages/cli/src/` runtime → **patch changeset required**.

### Phase 2 — Production rollout (Unit 5, operator execution after merge)

- [ ] **Unit 5: Staged production rollout**

**Goal:** `cliproxy.fro.bot` runs v7.1.31 with all OAuth tokens intact and no consumer-visible regression.

**Requirements:** R8 (+ live R2/R3)

**Dependencies:** Phase 1 merged + published.

**Approach (runbook, operator-driven):**
1. **Pre-flight on the droplet:** read live `/opt/cliproxy/config/config.yaml` — confirm no `ClaudeCodeSessionAffinity` (R3). Resolve the exact `cliproxy_auth` volume name.
2. **Backup (treat as secret):** tar the `cliproxy_auth` volume + copy `config.yaml` to a local-only, short-retention location; never log the contents; delete after a successful cutover. (Tokens for all consumers live here.)
3. **Cutover:** bump is already on the droplet via the merged deploy (or trigger the cliproxy deploy workflow); `docker compose pull && docker compose up -d --wait` — brief downtime acceptable.
4. **Smoke:** `/healthz` 200; `/v0/management/config` (single auth call); one live Claude `/v1/messages`; one OpenAI `/v1/models` with the production key. Use the prod management key sparingly — never fat-finger it (5 bad attempts → 30-min IP ban).
5. **Verify consumers:** trigger one Fro Bot run in this repo (Claude + OpenAI) — confirm no regression.
6. **Rollback (if smoke fails):** revert the image to the v6.10.9 digest, `docker compose up -d --wait`; if v6 can't read v7-mutated token files, restore the `cliproxy_auth` volume from the backup. Re-login (`cliproxy login claude` / `codex`) only if restore fails.

**Verification:** all smoke checks pass; a downstream Fro Bot run succeeds; backup artifact deleted post-cutover.

## System-Wide Impact

- **Interaction graph:** `status.ts` changes affect `infra cliproxy status` AND the unified `infra status` (which calls `getCliproxyStatusSummary`). Both call sites covered in Unit 2.
- **Error propagation:** usage check must degrade to warn (not fail the whole status); management-auth failure must short-circuit remaining checks (ban safety).
- **State lifecycle risks:** the `cliproxy_auth` volume is persistent production credential state — backup-before, restore-on-rollback (Unit 5). Token format v6↔v7 compatibility is likely (only adds a `disabled` flag) but not guaranteed → the backup covers it.
- **API surface parity:** `infra status --json` umami/gateway/keeweb rows unaffected; only the cliproxy row's usage cell changes semantics.
- **Unchanged invariants:** `/v1/messages` + `/v1/chat/completions` client contracts; api-keys/config/login management paths; deploy's config-preservation; the healthcheck command.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| v7 token format incompatible with v6 on rollback | Treat `cliproxy_auth` as persistent data; backup before cutover, restore on rollback (Unit 5). |
| `/usage-queue` record shape differs from assumption | Confirm against a local v7 container before finalizing Unit 2 aggregation; warn-not-fail on unknown shape. |
| `owned_by` still omitted by v7 `/v1/models` | Unit 1 defensive fix lands regardless; container check just confirms it's exercised. |
| Operator IP-ban during smoke (fat-fingered key) | R5 single-attempt + Unit 5 "use prod key sparingly, never wrong-key-test prod"; 30-min pause if banned. |
| Live config.yaml has a removed v6 field | Unit 5 pre-flight reads it before the image bump. |
| Consumer regression (tool-name/system-role behavior changed in v7) | Unit 5 step 5 triggers a real Fro Bot run to confirm before declaring success. |

## Documentation / Operational Notes

- Patch changeset for the `packages/cli/src/` runtime changes (status.ts usage migration + ban-awareness, validation.ts owned_by fix).
- AGENTS.md updated in Unit 4.
- Issue #232 (Upstream Modernization Watch) action item resolved by this upgrade — note it in the PR.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-29-cliproxy-v7-upgrade-requirements.md](../brainstorms/2026-05-29-cliproxy-v7-upgrade-requirements.md)
- Related code: `packages/cli/src/commands/cliproxy/status.ts`, `.../setup/validation.ts`, `apps/cliproxy/docker-compose.yaml`, `apps/cliproxy/src/deploy.ts`
- Related issue: #232
- Empirical source: Oracle live-container analysis (v6.10.9 + v7.1.31), 2026-05-29; memories 4151, 4152.
- Upstream: https://github.com/router-for-me/CLIProxyAPI/releases
