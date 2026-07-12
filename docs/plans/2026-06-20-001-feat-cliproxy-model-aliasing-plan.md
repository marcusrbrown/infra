---
title: "feat: CLIProxyAPI model aliasing for short-ID routing parity"
type: feat
status: completed
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-cliproxy-model-aliasing-requirements.md
---

# feat: CLIProxyAPI model aliasing for short-ID routing parity

## Overview

Add a managed `oauth-model-alias` block to the tracked `apps/cliproxy/config/config.yaml` (7 Anthropic short→dated mappings, `fork: true`) and apply it on every deploy by PUTting **only** the `oauth-model-alias` field to the CLIProxyAPI management API after the stack is healthy. This lets harnesses use opencode's short Anthropic model IDs (e.g. `claude-sonnet-4-5`) and have them resolve to the proxy's dated upstream models, without uploading the whole `config.yaml` (which would wipe runtime api-keys).

## Problem Frame

Harnesses configured with opencode short Anthropic IDs cannot use them through `cliproxy.fro.bot` — the proxy only serves dated upstream IDs, so a short ID returns an unknown-model error. CLIProxyAPI v7.2.22's `oauth-model-alias` maps a client-facing name to a real upstream model; `fork: true` keeps both IDs and surfaces the alias in `/v1/models`, giving `opencode models` parity. (see origin: docs/brainstorms/2026-06-20-cliproxy-model-aliasing-requirements.md)

## Requirements Trace

- R1. After deploy, `/v0/management/oauth-model-alias` returns the 7-entry `claude` set.
- R2. `cliproxy models anthropic` and `/v1/models` list all 7 short IDs **and** their dated counterparts.
- R3. A `/v1/chat/completions` request with each short ID returns 200 with the dated upstream as the response `model`.
- R4. The runtime api-keys are intact after deploy (no wipe).
- R5. A normal redeploy re-applies the alias set idempotently without `--force-config`.

## Scope Boundaries

- No standalone `infra cliproxy alias` CLI command — the tracked-template + deploy-apply path is the mechanism.
- No OpenAI aliasing (opencode-only `gpt-5.x` variants have no distinct cliproxy upstream).
- No per-auth `model-aliases` — the global per-provider `oauth-model-alias` covers this.
- No change to the `config.yaml` skip-unless-`--force-config` upload behavior.

### Deferred to Separate Tasks

- OpenAI model aliasing: revisit only if a real short-ID gap appears for OpenAI consumers.

## Context & Research

### Relevant Code and Patterns

- `apps/cliproxy/src/deploy.ts` — `deploy()` flow: mkdir → `preflightManagementKeyCheck` → scp compose/Caddyfile → scp `config.yaml` (skip unless absent/`--force-config`) → `docker compose up -d --wait --wait-timeout 90` → `healthCheck`. `CLIPROXY_MANAGEMENT_KEY` is optional in `getDeployEnv` (defaults to `''`); `preflightManagementKeyCheck` skips when empty.
- `apps/cliproxy/config/config.yaml` — tracked template, uploaded as-is (mounted at `/CLIProxyAPI/config.yaml`); has `api-keys: []`. No `oauth-model-alias` block today.
- `apps/gateway/src/deploy.ts` + `deploy.test.ts` — reference pattern for an **injectable, testable** deploy: `SpawnFn`/`fetch` injection via an opts object, mock helpers in the test.
- `packages/cli/src/commands/cliproxy/shared.ts` — `managementHeaders` (x-management-key + content-type), `HTTP_TIMEOUT_MS = 10_000`, `requestJson` (timeout + strict non-2xx + strict-JSON), `parseManagementKeyList`, `toStringArray`. These now move to `packages/shared` (see Key Technical Decisions — the `packages/cli ↛ packages/shared` boundary was removed in v0.13.2 / `bun build` publish step; both `apps/cliproxy` and `packages/cli` can import `@marcusrbrown/infra-shared`).
- `packages/shared/server/droplet-helpers.ts` — existing shared lib (SSH/SCP/DO helpers), exported as `@marcusrbrown/infra-shared/server/droplet-helpers`. The new cliproxy management helpers get a sibling export `@marcusrbrown/infra-shared/cliproxy/management`.
- `apps/cliproxy/package.json` already depends on `@marcusrbrown/infra-shared` (`workspace:*`); `packages/cli` adds it (inlined at build per the v0.13.2 model).
- `packages/cli/src/commands/cliproxy/status.ts` — `probeManagementAuth` single-probe-before-parallel + IP-ban-on-403 pattern; key-redaction-in-output convention.

### Institutional Learnings

- `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md` — full-array GET-modify-PUT on management arrays is a destructive footgun (can drop runtime api-keys). **This plan avoids it: the `oauth-model-alias` field is its own endpoint, PUT as a self-contained bare object — it never reads/writes the `api-keys` array.**
- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` + root `AGENTS.md` — `config.yaml` skip-upload is load-bearing for `api-keys` and `auth-dir`; do not weaken it. The alias step is the safe alternative to `--force-config`.
- `docs/solutions/workflow-issues/cliproxy-healthcheck-tooling-migration-2026-06-09.md` — `docker compose up -d --wait` (Caddy sidecar healthcheck) already proves the management API is reachable; the alias step slots in after `--wait`.
- `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md` — fail-closed on state mutation: pre-write snapshot → write → read-back diff → only declare success on match.
- `docs/solutions/workflow-issues/gateway-do-firewall-in-deploy-path-2026-06-19.md` — idempotent create-if-absent/no-op-if-present; the alias step must not fail a code-only release for unrelated reasons.

## Key Technical Decisions

- **Field-scoped bare-object PUT, never whole-config.** Apply via `PUT /v0/management/oauth-model-alias` with the bare object `{claude: [...]}`. The `{value: ...}` and `{oauth-model-alias: ...}` wrappers return `200 {"status":"ok"}` but store nothing (verified live). This never touches the `api-keys` array (R4).
- **Apply trigger: every deploy, idempotent.** The endpoint is idempotent (reapplying the same set is a proxy no-op), so no diff-gating/snapshot machinery. Simpler and matches the create-if-absent/no-op doctrine.
- **Missing-key policy: hard-fail when the tracked config has a non-empty alias block.** If `config.yaml` carries an `oauth-model-alias` block, the operator intends it to apply, so an absent/invalid `CLIPROXY_MANAGEMENT_KEY` fails the deploy with a clear error. If the block is empty/absent, skip silently (nothing to apply).
- **Read-back fail-closed.** After the PUT, GET `/v0/management/oauth-model-alias` and compare to the desired set with strict set-equality on the `claude` array (order-insensitive; entries compared on `name`/`alias`/`fork`). Mismatch fails the deploy with a diff in the error (catches the silent-no-op PUT shape).
- **`fork: true` verification.** After read-back passes, GET `/v1/models` and assert each short alias **and** its dated counterpart appear (guards against a future version dropping the dated model or changing `fork`).
- **Helper location: `packages/shared/cliproxy/management.ts` (new shared module), consumed by BOTH `apps/cliproxy` deploy AND `packages/cli` cliproxy commands.** The `packages/cli ↛ packages/shared` boundary was removed in v0.13.2 (the `bun build` publish step inlines `infra-shared`), so the management HTTP primitives no longer need duplicating. Move `managementHeaders`, `requestJson`, `HTTP_TIMEOUT_MS`, `parseManagementKeyList`, `toStringArray` from `packages/cli/src/commands/cliproxy/shared.ts` into the shared module, add the new alias functions (`OAuthModelAlias` type, `readOAuthModelAliasFromConfig`, `applyOAuthModelAlias`, `readBackOAuthModelAlias`, `setEqualOAuthModelAlias`) there, export via `@marcusrbrown/infra-shared/cliproxy/management`. `packages/cli/src/commands/cliproxy/shared.ts` re-exports from the shared module (keeps existing cli imports working) OR the cli commands import directly — implementer's call, whichever is cleaner. `apps/cliproxy/src/deploy.ts` imports the alias functions from the shared module.
- **Scope guard on the consolidation.** Moving the shared HTTP primitives touches the cli's existing cliproxy commands (status/keys/config/models import them). Keep this a pure move + re-export so those commands are unaffected (no behavior change); their tests must stay green. If the move balloons, fall back to: put ONLY the new alias functions in `packages/shared/cliproxy/management.ts` (importing the HTTP primitives it needs, which also move), and leave the cli's `shared.ts` re-exporting — do not rewrite every cli command's import in this plan.
- **Injectable `fetch` for testability.** The shared alias functions take a `{fetch?: typeof globalThis.fetch}` seam so both the cli and the deploy path can unit-test without live network.
- **Changeset: patch.** The shared management helpers are inlined into the published `@marcusrbrown/infra` bin at build time, so consolidating them IS a published-runtime change (the bundle content changes). Add a patch changeset. (This differs from the original no-changeset call, which assumed the helper stayed apps-only.)

## Open Questions

### Resolved During Planning

- Apply trigger (every-deploy vs diff-gated): **every deploy, idempotent**.
- Missing/invalid management key: **hard-fail when alias block is non-empty**, reusing the existing preflight gate.
- Read-back comparison + failure: **strict set-equality on the `claude` array, fail-closed with a diff**.
- `fork: true` verification: **post-apply `/v1/models` assertion of both IDs**.
- Sequencing: **after `docker compose up -d --wait`, before/around `healthCheck`**.
- Helper location: **`apps/cliproxy/src/management.ts`**.

### Deferred to Implementation

- Exact equality helper shape (normalize entries then set-compare vs sorted-stringify) — implementer's choice as long as it is order-insensitive and compares `name`/`alias`/`fork`.
- Whether to tolerate server-added entries not in the desired set (e.g. a future default) — start strict; relax only if a real upstream behavior requires it.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
deploy() in apps/cliproxy/src/deploy.ts
  ... mkdir, preflightManagementKeyCheck, scp compose/Caddyfile, scp config.yaml (skip logic) ...
  docker compose up -d --wait --wait-timeout 90        # proxy + mgmt API now reachable
  ── NEW: applyOAuthModelAlias step ──────────────────────────────
    aliasBody = readOAuthModelAliasFromConfig(files.config)   # parse tracked config.yaml
    if aliasBody has entries:
        require CLIPROXY_MANAGEMENT_KEY  → else FAIL (alias block present, no key)
        PUT /v0/management/oauth-model-alias   body = aliasBody (bare object)
        actual = GET /v0/management/oauth-model-alias
        setEqual(aliasBody, actual)            → else FAIL (read-back mismatch + diff)
        models = GET /v1/models                # requires a downstream api-key (see Unit 3 note)
        assert each short alias + its dated name present → else FAIL (fork regression)
    else: skip (nothing to apply)
  ────────────────────────────────────────────────────────────────
  healthCheck(env)                                     # existing GET /v0/management/config
```

## Implementation Units

- [ ] **Unit 1: Add the `oauth-model-alias` block to the tracked config template**

**Goal:** Make the 7 Anthropic short→dated mappings the version-controlled source of truth.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `apps/cliproxy/config/config.yaml`

**Approach:**
- Add a top-level `oauth-model-alias:` block with a `claude:` list of 7 entries, each `{name: <dated>, alias: <short>, fork: true}`:
  - `claude-3-5-haiku-20241022` ← `claude-3-5-haiku-latest`
  - `claude-haiku-4-5-20251001` ← `claude-haiku-4-5`
  - `claude-opus-4-20250514` ← `claude-opus-4-0`
  - `claude-opus-4-1-20250805` ← `claude-opus-4-1`
  - `claude-opus-4-5-20251101` ← `claude-opus-4-5`
  - `claude-sonnet-4-20250514` ← `claude-sonnet-4-0`
  - `claude-sonnet-4-5-20250929` ← `claude-sonnet-4-5`
- Add a one-line comment header noting: this block is applied by deploy via the management API; it does **not** make `--force-config` safe (that still wipes runtime api-keys).

**Patterns to follow:**
- Existing `config.yaml` comment/structure style.

**Test expectation:** none — pure config; covered by Unit 2's parser test (fixture) and Unit 4's e2e verification.

**Verification:**
- `docker compose config` / YAML parse still valid; the block matches the brainstorm's 7-entry table.

- [ ] **Unit 2: Shared cliproxy management module — consolidate HTTP helpers + add alias functions**

**Goal:** A single shared module that both `apps/cliproxy` deploy and the `packages/cli` cliproxy commands import: the management HTTP primitives (moved from the cli) plus the new alias parse/PUT/read-back/compare functions.

**Requirements:** R1, R3, R4, R5

**Dependencies:** Unit 1 (for the fixture shape)

**Files:**
- Create: `packages/shared/cliproxy/management.ts`
- Create: `packages/shared/cliproxy/management.test.ts`
- Modify: `packages/shared/package.json` (add `"./cliproxy/management"` export)
- Modify: `packages/cli/src/commands/cliproxy/shared.ts` (re-export the moved primitives from the shared module so existing cli command imports keep working — pure move, no behavior change)
- Modify: `packages/cli/package.json` (add `@marcusrbrown/infra-shared` — inlined at build per v0.13.2)

**Approach:**
- **Move** `HTTP_TIMEOUT_MS`, `managementHeaders`, `requestJson`, `parseManagementKeyList`, `toStringArray` from `packages/cli/src/commands/cliproxy/shared.ts` into `packages/shared/cliproxy/management.ts`. Have `shared.ts` re-export them so the existing cli commands (status/keys/config/models) are untouched (pure move + re-export).
- **Add** the alias functions in the shared module:
  - `OAuthModelAlias` type: `{claude: Array<{name: string; alias: string; fork: boolean}>}` (extensible; only `claude` used now).
  - `readOAuthModelAliasFromConfig(configPath): OAuthModelAlias` — read the tracked `config.yaml`, extract top-level `oauth-model-alias`; return empty when absent.
  - `applyOAuthModelAlias({baseUrl, key, body, fetch?})` — `PUT /v0/management/oauth-model-alias` with `managementHeaders(key)` and **bare-object** body; `AbortSignal.timeout(HTTP_TIMEOUT_MS)`; throw on non-2xx with status + body (never echo the key).
  - `readBackOAuthModelAlias({baseUrl, key, fetch?})` — `GET` the same endpoint, return the parsed value.
  - `setEqualOAuthModelAlias(desired, actual)` — order-insensitive comparison on `name`/`alias`/`fork`.

**Patterns to follow:**
- `packages/shared/server/droplet-helpers.ts` for the shared-module/export style; `apps/gateway/src/deploy.test.ts` injectable-fetch mock style.

**Scope guard:** keep the primitive move a pure move + re-export; the cli commands' tests must stay green with no behavior change. If the move balloons, fall back to: the alias functions live in the shared module and import the primitives (which also move there), and `shared.ts` re-exports — do not rewrite every cli command's import site.

**Test scenarios:**
- Happy path: `readOAuthModelAliasFromConfig` parses a fixture config with the 7-entry block → returns the expected object.
- Edge case: config with no `oauth-model-alias` key → returns empty.
- Happy path: `applyOAuthModelAlias` issues a PUT with the **bare object** body (assert no `value`/`oauth-model-alias` wrapper) and `x-management-key` header; management key never appears in thrown errors.
- Error path: PUT returns non-2xx → throws with status + body.
- Happy path: `readBackOAuthModelAlias` parses the GET response's `oauth-model-alias` field.
- Happy path/edge: `setEqualOAuthModelAlias` true for same set in different order; false when an entry's `name`/`alias`/`fork` differs or count differs.
- Regression: the moved primitives still behave identically (the existing cli `shared.test.ts` / command tests pass via the re-export).

**Verification:**
- `bun test packages/shared/cliproxy/management.test.ts` passes; `bun test packages/cli/src/commands/cliproxy/` passes (re-export regression); `tsc` clean; no `as any`.

- [ ] **Unit 3: Wire the apply step into deploy with fail-closed + fork verification**

**Goal:** Run the alias apply after the stack is healthy, with hard-fail-on-missing-key, read-back fail-closed, and `/v1/models` fork verification.

**Requirements:** R1, R3, R4, R5

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `apps/cliproxy/src/deploy.ts`
- Modify/Create: `apps/cliproxy/src/deploy.test.ts` (new test file if absent)

**Approach:**
- Import the alias functions from `@marcusrbrown/infra-shared/cliproxy/management` (Unit 2). `apps/cliproxy` already depends on `infra-shared`.
- Add an `applyAliasStep` invoked between `docker compose up -d --wait` and `healthCheck(env)`.
- Read the alias block from the tracked `files.config`. If empty → skip. If non-empty and `CLIPROXY_MANAGEMENT_KEY` is empty → **throw** ("alias block present but CLIPROXY_MANAGEMENT_KEY not set").
- PUT → read-back → `setEqual`; on mismatch throw with the diff.
- `fork` verification: GET `/v1/models` and assert each of the 7 short aliases + its dated name are present. **Note:** `/v1/models` is bearer-auth (needs a downstream api-key, not the management key). The deploy env has the management key but not a downstream key. Resolve in implementation: prefer reusing the existing management-config readiness (already proven by `healthCheck`) for R1/R5, and make the `/v1/models` fork assertion **best-effort/warn** if no downstream key is available in the deploy env, OR thread an optional `CLIPROXY_API_KEY` from env when present and only assert when it is. Do not hard-fail the deploy solely because `/v1/models` could not be probed for lack of a downstream key — the management read-back already proves the alias was stored.
- Add a minimal injectable `fetch` seam to `deploy()` (opts object) so the step is testable.

**Patterns to follow:**
- `preflightManagementKeyCheck` for the key-presence gate and error style.
- `apps/gateway/src/deploy.test.ts` for opts/fetch injection.

**Test scenarios:**
- Happy path: non-empty alias block + valid key → PUT issued, read-back matches → no throw; deploy proceeds to healthCheck.
- Error path: non-empty alias block + empty management key → throws before any network call.
- Error path: read-back set differs from desired → throws with a diff message.
- Edge case: empty/absent alias block → step is a no-op (no PUT), deploy proceeds.
- Edge case: `/v1/models` not probeable (no downstream key) → warns, does not fail (management read-back already succeeded).
- Integration: the apply step runs **after** the compose-up command and **before** healthCheck (assert ordering via the mock call sequence).

**Verification:**
- `bun test apps/cliproxy/` passes; `tsc` clean; `bunx eslint --max-warnings=0` on changed files clean.

- [ ] **Unit 4: Docs + live verification + reconcile prototype**

**Goal:** Document the new deploy step and the bare-object gotcha; verify live; reconcile the live prototype to the full 7-entry set.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** Unit 1-3 merged + deployed

**Files:**
- Modify: `apps/cliproxy/AGENTS.md`
- Create: `.changeset/*.md` (patch — the shared management helpers are inlined into the published bin, so the bundle content changes)

**Approach:**
- Document the new post-`--wait` apply step in the DEPLOY FLOW section (4 steps → 5).
- Add an `oauth-model-alias` row to the management API endpoint table noting the **bare-object** body (no `{value: ...}` wrapper).
- Note the `--force-config` interaction: the alias block in the template does not make `--force-config` safe.
- Add a patch changeset for `@marcusrbrown/infra` (present-tense, first-person, no plan-taxonomy).
- After deploy: confirm `cliproxy models anthropic` and `/v1/models` list all 7 short IDs + dated counterparts; run a `/v1/chat/completions` with one short ID and confirm 200 + dated upstream in the response. Confirm the runtime api-keys are intact (count unchanged).

**Test expectation:** none — docs + operational verification.

**Verification:**
- The live proxy returns the 7-entry alias set; both short and dated IDs listed; a short-ID completion routes to the dated upstream; api-key count unchanged from before.

## System-Wide Impact

- **Interaction graph:** new deploy step calls the management API after compose-up; no change to compose/Caddy/provision paths.
- **Error propagation:** alias step throws → deploy fails before `healthCheck`; consistent with the existing fail-fast deploy.
- **State lifecycle risks:** none to `api-keys` (field-scoped PUT, never the array). The alias block persists to on-disk `config.yaml` on the droplet (survives restart).
- **API surface parity:** `cliproxy models` parsing unaffected (the OpenAI-compatible `/v1/models` shape is unchanged in v7.2.22; aliases are normal entries).
- **Unchanged invariants:** the `config.yaml` skip-unless-`--force-config` upload behavior; the `api-keys`/`auth-dir` protection; `--force-config` remains the dangerous full-upload path.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Hardcoded dated upstream IDs drift when Anthropic retires/renames a model | Read-back + (best-effort) `/v1/models` fork check catches a broken mapping; treat the alias block as a maintenance item reviewed on cliproxy image bumps |
| Undocumented bare-object PUT / `fork` contract changes in a future cliproxy version | Read-back fail-closed + fork verification; re-verify the alias path when bumping the cliproxy image |
| Alias step adds a failure surface to every deploy | Step is idempotent and only fails on genuine apply/read-back failure; empty block = no-op; `/v1/models` probe is best-effort |
| `--force-config` still wipes runtime api-keys | Unchanged behavior; documented in the config template comment + AGENTS.md (out of scope to fix here) |

## Documentation / Operational Notes

- Update `apps/cliproxy/AGENTS.md` DEPLOY FLOW + management endpoint table (Unit 4).
- Live prototype: a single `claude-haiku-4-5` alias is currently set on the proxy; the first real deploy reconciles it to the full 7-entry set (idempotent overwrite of the field).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-20-cliproxy-model-aliasing-requirements.md](docs/brainstorms/2026-06-20-cliproxy-model-aliasing-requirements.md)
- Related code: `apps/cliproxy/src/deploy.ts`, `apps/cliproxy/config/config.yaml`, `apps/gateway/src/deploy.ts` (injection pattern), `packages/cli/src/commands/cliproxy/shared.ts`
- Related learnings: `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`, `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`, `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`
