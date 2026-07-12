---
title: 'feat: cliproxy setup OpenAI provider opt-in'
type: feat
status: completed
date: 2026-05-25
origin: docs/brainstorms/2026-05-25-fro-bot-openai-routing-opt-in-requirements.md
---

# feat: cliproxy setup OpenAI provider opt-in

## Overview

Extend `cliproxy setup --harness opencode` to support per-repo opt-in for OpenAI model routing through the existing `cliproxy.fro.bot` proxy. The wizard gains a provider multiselect (interactive) plus `--providers`, `--model`, `--force`, `--dry-run`, and `--verify-smoke` flags (non-interactive). Anthropic-only behavior remains byte-identical to today. New `OPENCODE_CONFIG`, `OPENCODE_AUTH_JSON`, `OMO_PROVIDERS`, and `FRO_BOT_MODEL` values are deterministically composed from the selected provider set.

## Problem Frame

Marcus has a working ChatGPT Pro Codex OAuth token loaded on `cliproxy.fro.bot` (PR #303 R8 verification, 2026-05-24/25). The proxy exposes 8 OpenAI models. The current wizard wires Claude only — operators wanting OpenAI must hand-edit GitHub secrets. The requirements doc (origin) defines a per-repo opt-in that:

- Adds a multiselect for providers (anthropic pre-checked; openai opt-in)
- Adds a `--providers` flag for non-interactive callers
- Keeps the existing `opencode` harness mode; no new harness
- Uses a single proxy bearer key for both providers (the proxy's actual contract)
- Protects existing repos from accidental destructive overwrite

The plan stays scoped to client-side wizard changes. No proxy-side or workflow-template changes. No new top-level commands.

## Requirements Trace

- R1 → Unit 1, Unit 2 (interactive multiselect)
- R2 → Unit 1, Unit 5 (non-interactive `--providers` flag + validation)
- R3 → Unit 2, Unit 3 (model selection logic)
- R4 → all units (anthropic-only behavior preserved)
- R5 → Unit 3 (deterministic dual-provider templates)
- R6 → Unit 6 (smoke test runner with `--verify-smoke`)
- R7 → Unit 5 (G7: anthropic-only flow byte-identical)
- Threat model → Unit 9 (docs); enforced by existing `gh secret set` stdin pipe
- Setup-plan validation → Unit 4 (`/v1/models` predicate + provider/model cross-checks)
- Workflow analyzer changes → Unit 7 (structure-only, no `enable-omo` warning per librarian)
- Destructive overwrite UX → Unit 8 (`--force` + `--dry-run` + confirm prompt)

## Scope Boundaries

- No proxy-side code changes (`apps/cliproxy/` source untouched; Unit 9 updates `apps/cliproxy/AGENTS.md` docs only).
- No `fro-bot.yaml` workflow template edits in consumer repos (analyzer is read-only, prints snippets, never edits).
- No new harness modes; `opencode-codex` is explicitly excluded.
- No new top-level CLI commands.
- No automatic migration of existing 18 consumer-repo keys.
- No per-provider proxy keys.
- No `enable-omo: true` workflow warning — librarian confirmed this is unnecessary for proxy-routed OpenAI (origin R1 resolved).

### Deferred to Separate Tasks

- Daily autoheal category 5 extension to probe `/v1/models` for OpenAI models: separate brainstorm if real-world Codex token expiry becomes a repeated incident.
- `gpt-image-2` routing (image gen): explicitly out of scope per origin.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/cliproxy/setup.ts` — the file being modified:
  - `SetupOptions` interface at lines 26-30 (currently `key`, `repo`, `harness`)
  - `harnessSchema` at line 17 (`z.enum(['opencode', 'claude-code', 'generic'])`)
  - `validateSetupOptions` at lines 75-95
  - `getHarnessTemplate` at lines 97-150 (composes the 4 OpenCode secrets/vars)
  - `applyGhValue` at lines 569-590 (`gh secret set` via stdin pipe, `gh variable set` via `--body`)
  - `analyzeFroBotWorkflow` at lines 335-406 (regex-based, per-step)
  - Interactive entry `runSetupCommand` at lines 763-970
  - Non-interactive entry `buildNonInteractivePlan` at lines 722-733
  - TTY detection: `const interactive = Boolean(process.stdin.isTTY)` at line 765
- `packages/cli/src/commands/cliproxy/setup.test.ts` — 28 tests, inline fixture strings, `toEqual`/`toContain`/`toMatch` patterns, no snapshots
- `packages/cli/src/commands/keeweb/deploy.ts` and `packages/cli/src/commands/cliproxy/deploy.ts` — `--dry-run` pattern to mirror
- `packages/cli/src/commands/gateway/host.ts` and `packages/cli/src/commands/cliproxy/host.ts` — input-validation pattern for model identifier prefix/regex (defense-in-depth even though `--model` is parsed by goke)

### Institutional Learnings

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — keep canonical env/secret names; validate the actual on-disk shape, don't infer from convention.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — pipe bytes via stdin for `gh secret set`; validate at boundaries; don't retry around structural problems.

### External References

- `fro-bot/agent@v0.44.3+` source-verified shapes (librarian, 2026-05-25):
  - `src/services/setup/types.ts`: `{type: "api", key: string}` per provider
  - `src/services/setup/auth-json.ts:41-54`: writes verbatim
  - `action.yaml` lines 99-104: `omo-providers` accepts `claude-max20`, `openai`, etc. (comma-separated)
  - `omo-providers` requires `enable-omo: true` to take effect, BUT proxy-routed providers via `OPENCODE_CONFIG.provider.<name>.options.baseURL` work **without** `enable-omo`
- `sst/opencode` `packages/opencode/src/auth/index.ts:23-27`: schema requires `type: "api"` discriminator; entries without it are silently filtered
- Empirical R8 verification (2026-05-24/25): `POST /v1/chat/completions` model `gpt-5.5` returns `pong`. 8 OpenAI models on `/v1/models`. `openai/gpt-5.4-mini-fast` does NOT exist; default to `openai/gpt-5.4-mini`.

## Key Technical Decisions

- **Single proxy key per repo, used for both providers in auth.json**: matches proxy contract; documented in threat model. (origin)
- **`enable-omo` is NOT toggled**: librarian-verified; proxy baseURL override is sufficient for OpenAI routing. Workflow analyzer must NOT warn about this. (origin R1 resolved)
- **`OMO_PROVIDERS` token mapping**: `anthropic` → `claude-max20` (current); `openai` → `openai`; both → `claude-max20,openai` (comma-separated). Although `omo-providers` is ignored without `enable-omo`, the wizard writes it anyway for forward-compatibility with future `enable-omo: true` adoption. (librarian)
- **Provider validation at three layers**:
  1. CLI parse via Zod `z.enum(['anthropic', 'openai'])` on `--providers` values
  2. Setup-plan validation against `/v1/models` response (auth + model existence)
  3. Model-prefix vs providers cross-check at plan-build time
- **Destructive overwrite protection**: interactive `clack.confirm` (default No) + non-interactive `--force` flag + `--dry-run` preview that elides the proxy key value.
- **Smoke test is opt-in, non-blocking, bounded poll**: 5-minute total budget with exponential backoff (5s, 15s, 30s, 60s, 60s), gh approval-gate detection emits a non-blocking warning. Never gates setup completion.
- **Analyzer remains structure-only**: continues to check `with:` input presence on the `fro-bot/agent` step. Semantic provider/model cross-checks live in the setup-plan validator (Unit 4), NOT the analyzer (Unit 7).
- **Multiselect import is net-new**: `multiselect` added to the existing `@clack/prompts` import in `setup.ts`. The scoped-exception for `@clack/prompts` to `cliproxy setup` per `packages/cli/AGENTS.md` already covers this.

## Open Questions

### Resolved During Planning

- **Auth-json shape**: `{type: "api", key: "<proxy-key>"}` per provider, single proxy key for both. (librarian, source-verified)
- **OMO_PROVIDERS for OpenAI**: `openai` (comma-joined with `claude-max20` when both selected). (librarian, action.yaml verified)
- **`enable-omo` requirement**: NOT required for proxy-routed OpenAI via baseURL override. (librarian)
- **OPENCODE_CONFIG shape**: per-provider `baseURL` overrides under `provider.<name>.options.baseURL`. (librarian)
- **Default model for OpenAI**: `openai/gpt-5.4-mini` (proxy doesn't expose `-fast` variant). (R8 verification)

### Deferred to Implementation

- Exact error messages for validation failures (style consistent with existing setup errors).
- Whether to extract `pollWorkflowRun` as a shared helper (`packages/cli/src/utils/workflow-poll.ts`) or inline in setup.ts. Decision deferred until Unit 6 implementation surfaces complexity.
- Exact test fixture content for multi-provider analyzer cases (Unit 7).
- Whether to add a `--key-name` flag for explicit proxy-key naming or continue using the wizard's auto-generated name. Defer; current behavior is fine.

## Implementation Units

- [ ] **Unit 1: Extend `SetupOptions` + CLI flag surface**

**Goal:** Add the five new CLI flags (`--providers`, `--model`, `--force`, `--dry-run`, `--verify-smoke`) and extend the `SetupOptions` type. Wire goke Zod schemas. No behavior change yet.

**Requirements:** R1, R2, R3, R6

**Dependencies:** None

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- Define `providerIdSchema = z.enum(['anthropic', 'openai'])` and `ProviderId = z.infer<typeof providerIdSchema>` near `harnessSchema`.
- Extend `SetupOptions` with optional `providers?: ProviderId[]`, `model?: string`, `force?: boolean`, `dryRun?: boolean`, `verifySmoke?: boolean`.
- Add option registrations in `registerCliproxySetup()` (~line 740-759):
  - `--providers <list>`: parsed from comma-separated string. Implementer must cross-check goke's option coercion: try `z.string().transform(s => s.split(',').map(p => p.trim()).filter(Boolean)).pipe(z.array(providerIdSchema).min(1))` first; if goke rejects the transform+pipe shape, fall back to parsing the raw string in the action and validating with the array schema there. Reject duplicates explicitly. Help text lists `anthropic, openai`.
  - `--model <model-id>`: `z.string().regex(/^(anthropic|openai)\/[a-z0-9][a-z0-9.\-]*$/)`. Help text shows examples.
  - `--force`, `--dry-run`, `--verify-smoke`: `z.boolean().optional()`.
- Update help summary at the command level to mention the new flags.

**Patterns to follow:**
- Existing harness/repo flag pattern at `setup.ts:742-759`.
- `packages/cli/src/commands/cliproxy/host.ts` `validateCliproxyHost` regex shape for restrictive model-id parsing.

**Test scenarios:**
- Happy path: `--providers anthropic,openai` parses to `['anthropic', 'openai']`.
- Happy path: `--providers openai` parses to `['openai']`.
- Edge case: `--providers anthropic,anthropic` rejects with a "duplicate" error.
- Edge case: `--providers ` (empty) rejects with a clear message.
- Error path: `--providers claude` rejects with the enum error listing supported values.
- Happy path: `--model openai/gpt-5.4-mini` accepted.
- Error path: `--model gpt-5.4-mini` (no provider prefix) rejects.
- Error path: `--model openai/GPT-5.4-mini` (uppercase) rejects.
- Error path: `--model openai/gpt-5.4-mini; rm -rf /` rejects (regex anchors).
- Snapshot/regression: help text for the command mentions all five new flags.

**Verification:**
- `bun test packages/cli/src/commands/cliproxy/setup.test.ts` passes the new tests.
- `bun run --cwd packages/cli build && bunx @marcusrbrown/infra cliproxy setup --help` shows the new flags (manual check).

- [ ] **Unit 2: Interactive provider multiselect + multi-provider model prompt**

**Goal:** Add the interactive UX flow for selecting providers (multiselect with anthropic pre-checked) and choosing a default model when >1 provider selected.

**Requirements:** R1, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- Add `multiselect` to the existing `@clack/prompts` import in `setup.ts:6`.
- Create a `promptForProviders(): Promise<ProviderId[]>` helper between the existing `select` prompt and `buildApiKeyValue`. Anthropic pre-checked via `multiselect({initialValues: ['anthropic']})`, OpenAI opt-in. Wrap the prompt in an explicit `do-while` loop: if `selected.length === 0`, print a clack `note()` "Select at least one provider." and re-prompt. Verify `multiselect`'s native behavior empirically during implementation — if it natively rejects empty selection, the loop can be a no-op safety net.
- Create a `promptForModel(providers: ProviderId[]): Promise<string>` helper that returns immediately with the provider default when `providers.length === 1`, otherwise shows a `select` with options `openai/gpt-5.4-mini` (first), `anthropic/claude-sonnet-4-6`, and "enter custom...".
- Wire both helpers into `runSetupCommand` between repo-access checks and proxy-key creation.
- Handle `clack.isCancel` for both prompts; abort cleanly.

**Patterns to follow:**
- Existing `clack.select` usage at `setup.ts:678-685`.
- Existing `clack.confirm` cancellation handling at `setup.ts:178-180`.

**Test scenarios:**
- Happy path: anthropic-only selection returns `['anthropic']` with default `anthropic/claude-sonnet-4-6`.
- Happy path: both providers selected, operator picks `openai/gpt-5.4-mini` from the select.
- Happy path: both providers selected, operator picks "enter custom...", types `openai/gpt-5.4-mini`, accepted.
- Edge case: multiselect cancelled mid-flow → setup aborts via `clack.cancel`.
- Edge case: empty multiselect → re-prompt (verify by mocking sequential responses).
- Edge case: custom-model entry that fails the regex rejects with a clear error.

**Verification:**
- New tests pass.
- `setup.ts` lint clean (`bun run lint`) — multiselect import works under the scoped exception.

- [ ] **Unit 3: Extend `getHarnessTemplate` for multi-provider opencode**

**Goal:** Make `getHarnessTemplate` accept the selected provider set + model and emit the correct `OPENCODE_CONFIG`, `OPENCODE_AUTH_JSON`, `OMO_PROVIDERS`, and `FRO_BOT_MODEL` values.

**Requirements:** R5, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- Extend the `values` argument with `providers?: ProviderId[]` (defaults to `['anthropic']` for backward compatibility) and `model?: string` (defaults to provider default per Key Decisions).
- For `harness === 'opencode'`:
  - Build the `OPENCODE_AUTH_JSON` JSON dynamically: an object with one entry per selected provider, each `{type: "api", key: keyValue}`.
  - Build the `OPENCODE_CONFIG` JSON dynamically: one `provider.<name>.options.baseURL` block per selected provider.
  - Build `OMO_PROVIDERS` value: map `anthropic` → `claude-max20`, `openai` → `openai`. Join comma-separated. Preserve `anthropic`-first ordering for stable output.
  - Set `FRO_BOT_MODEL` to the resolved model.
- For `harness === 'claude-code'` and `'generic'`: unchanged (anthropic-only assumptions stay intact).
- Backward compatibility: `getHarnessTemplate('opencode', {keyValue})` with no `providers`/`model` must return BYTE-IDENTICAL output to today (G7).

**Patterns to follow:**
- Existing object-literal template at `setup.ts:108-130`.

**Test scenarios:**
- Happy path: `providers: ['anthropic']` produces today's exact JSON (regression test against existing fixture).
- Happy path: `providers: ['openai'], model: 'openai/gpt-5.4-mini'` produces:
  - `OPENCODE_AUTH_JSON` = `{"openai":{"type":"api","key":"..."}}` exactly
  - `OPENCODE_CONFIG` = `{"provider":{"openai":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}` exactly
  - `OMO_PROVIDERS` = `openai`
  - `FRO_BOT_MODEL` = `openai/gpt-5.4-mini`
- Happy path: `providers: ['anthropic', 'openai'], model: 'openai/gpt-5.4-mini'` produces dual-provider JSON with both entries; order is stable (`anthropic` first in both auth-json and config).
- Edge case: default `providers` omitted → behaves identically to `['anthropic']` (G7).
- Edge case: `model` omitted with single provider → uses provider default.
- Edge case: `model` omitted with multiple providers → throws (planning-time invariant).

**Verification:**
- New tests pass; existing `getHarnessTemplate` tests still pass unchanged.

- [ ] **Unit 4: Setup-plan validator (`/v1/models` probe + cross-checks)**

**Goal:** Add a pre-mutation validator that, when `--providers` includes `openai` OR the resolved providers differ from anthropic-only, makes an authenticated GET to `/v1/models`, parses the response, and asserts the resolved model is present and the OpenAI provider has at least one `owned_by: "openai"` entry.

**Requirements:** R5, setup-plan validation requirement from origin

**Dependencies:** Unit 1, Unit 3

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- **Phase ordering for the interactive flow (anti-orphan-key)**: (1) provider multiselect (Unit 2), (2) model resolution (Unit 2), (3) destructive-overwrite confirm gate (Unit 8) when applicable — fail FAST before creating any proxy key, (4) proxy-key materialization (existing `buildApiKeyValue`), (5) `verifyModelsAvailable` — on failure, call the existing key-cleanup path (which uses the management API) to remove the just-created key before throwing, (6) mutation block (Unit 8 mutation phase), (7) optional smoke test (Unit 6). For non-interactive flow: (1) `validateSetupOptions` (Unit 5), (2) `verifyModelsAvailable` against the operator-supplied `--key` (no cleanup needed; the key pre-existed), (3) confirm-or-`--force` gate (Unit 8), (4) mutation, (5) optional smoke test.
- New function `verifyModelsAvailable(baseUrl: string, key: string, providers: ProviderId[], model: string): Promise<void>` that:
  - Skips entirely when `providers` is `['anthropic']` (G7).
  - Otherwise: `fetch(baseUrl + '/v1/models', {headers: {Authorization: 'Bearer ' + key}})` with a 10s `AbortSignal.timeout(10_000)`.
  - On 401/403: throws "Proxy key rejected. Verify the key with `cliproxy keys list` or rerun setup to create a new one."
  - On non-2xx: throws with the status and a redacted body excerpt (first 200 chars, never including the Authorization header).
  - On 2xx: parses JSON, asserts `data` is an array. Asserts the resolved model id (model with `<provider>/` stripped) appears in `data[].id`. Throws otherwise with a list of available OpenAI model ids.
  - When `providers` includes `openai`: also asserts at least one `data[i].owned_by === 'openai'`. Throws "No OpenAI models on proxy — is the Codex token loaded? Try `cliproxy login codex`." otherwise.
- Wire into `runSetupCommand` after Unit 2's prompts resolve and after the proxy key is materialized (interactive) OR after `--key` is parsed (non-interactive), BEFORE any GitHub mutation.
- Anthropic-only path bypasses entirely — no behavior change for existing repos.

**Patterns to follow:**
- Existing fetch shape in `setup.ts:455-489` (proxy auth check).
- `Bun.spawn` timeout pattern elsewhere in the file.

**Test scenarios:**
- Happy path: `providers: ['anthropic']` returns immediately (no fetch made — verify with mock that asserts `fetch` was NOT called).
- Happy path: `providers: ['openai'], model: 'openai/gpt-5.4-mini'`, mocked `/v1/models` returns the actual R8 response shape; passes.
- Error path: 401 throws with the expected "Proxy key rejected" message; body content is not leaked.
- Error path: 200 with `data: []` throws with "No OpenAI models" hint.
- Error path: model not present in `data[].id` throws and lists available `owned_by: "openai"` ids.
- Error path: timeout (mock `AbortSignal.timeout`) throws clean error.
- Edge case: `providers: ['anthropic', 'openai'], model: 'anthropic/claude-sonnet-4-6'` — model lookup passes (claude model exists), openai check also passes (at least one `owned_by: "openai"`).

**Verification:**
- New tests pass with mocked `fetch`.

- [ ] **Unit 5: Non-interactive plan + validation matrix**

**Goal:** Extend `validateSetupOptions` and `buildNonInteractivePlan` to handle the new flags. Anthropic-only flow (current default) is byte-identical (G7).

**Requirements:** R2, R3, R7

**Dependencies:** Unit 1, Unit 3, Unit 4

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- In `validateSetupOptions` (`setup.ts:75-95`):
  - When `!interactive` and `options.providers` is set:
    - If `length > 1` and `!options.model`: throw "Pass `--model <provider/model-id>` when selecting multiple providers."
    - If `options.model` is set and `<provider>` prefix is not in `options.providers`: throw with valid prefixes list.
- When `!interactive` and `options.providers` is unset → default to `['anthropic']` for backward compatibility.
- In `buildNonInteractivePlan` (`setup.ts:722-733`):
  - Resolve providers → defaults to `['anthropic']`.
  - Resolve model → `options.model` or single-provider default.
  - Pass both to `getHarnessTemplate`.
  - When providers includes `openai`, call `verifyModelsAvailable` before constructing the plan.

**Patterns to follow:**
- Existing throw style in `validateSetupOptions`.

**Test scenarios:**
- Happy path: `validateSetupOptions({key, repo, harness: 'opencode'}, false)` (anthropic-only default) passes unchanged.
- Happy path: `{key, repo, harness: 'opencode', providers: ['anthropic']}` produces a plan byte-identical to today's anthropic-only template.
- Happy path: `{key, repo, harness: 'opencode', providers: ['openai'], model: 'openai/gpt-5.4-mini'}` produces an openai-only plan with the expected template.
- Happy path: `{key, repo, harness: 'opencode', providers: ['anthropic', 'openai'], model: 'openai/gpt-5.4-mini'}` produces a dual-provider plan.
- Error path: `{harness: 'opencode', providers: ['anthropic', 'openai']}` (no model) throws the multi-provider model-required error.
- Error path: `{harness: 'opencode', providers: ['anthropic'], model: 'openai/gpt-5.4-mini'}` throws the prefix-mismatch error.

**Verification:**
- New tests pass; existing `validateSetupOptions` and `buildNonInteractivePlan` tests still pass.

- [ ] **Unit 6: Smoke test runner (`--verify-smoke`)**

**Goal:** Add an optional post-mutation smoke test that triggers `gh workflow run fro-bot.yaml`, polls for completion with backoff, detects environment-approval gates, and reports as a non-blocking warning.

**Requirements:** R6

**Dependencies:** Unit 5, Unit 8 (wired AFTER the mutation block, so the smoke test exercises the secrets the wizard just wrote)

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- New function `runSmokeTest(repo: string, key: string, model: string): Promise<SmokeResult>` where `SmokeResult` = `{kind: 'pass' | 'fail' | 'unverified', message: string, runUrl?: string}`:
  - **Capture baseline run ID BEFORE triggering** to avoid race with other contributors: `gh run list --workflow=fro-bot.yaml --repo <repo> --limit 1 --json databaseId` and remember `baselineId` (or `null` if no prior runs exist).
  - Trigger via `Bun.spawn(['gh', 'workflow', 'run', 'fro-bot.yaml', '--repo', repo, '-f', "prompt=reply with exactly: ack"], ...)` with 10s timeout.
  - If trigger fails: return `{kind: 'unverified', message: 'gh workflow run failed: ' + redacted_stderr}`.
  - Poll with `gh run list --workflow=fro-bot.yaml --repo <repo> --limit 5 --json databaseId,status,conclusion,url,createdAt` and **select the first entry where `databaseId > baselineId`** (or first entry overall when `baselineId` was null). If no new run is visible yet within the first poll, treat as "trigger not registered" and retry on the next poll cycle.
  - Backoff schedule: 5s, 15s, 30s, 60s, 60s (5 min total budget).
  - If `status === 'completed'`:
    - `conclusion === 'success'`: fetch logs and grep for `ack` (best-effort — log-fetch failure does NOT downgrade the pass).
    - Otherwise: return `{kind: 'fail', message: 'Run completed with conclusion=<...>', runUrl}`.
  - If `status === 'waiting'` or `'pending'` with the keyword `approval` in any visible state field: return `{kind: 'unverified', message: 'Workflow requires environment approval at <runUrl>'}`.
  - If timeout: `{kind: 'unverified', message: 'Smoke test did not complete in 5 minutes; check <runUrl>'}`.
- Wire into `runSetupCommand` AFTER the mutation block (Unit 8), guarded by `options.verifySmoke`. ALWAYS print the result; never `throw` on failure.

**Patterns to follow:**
- Existing `gh workflow run` invocation in `packages/cli/src/commands/cliproxy/deploy.ts:137-155` for the trigger shape.
- Existing `withSpinner` pattern in `setup.ts:194-205` to show progress during poll.

**Test scenarios:**
- Happy path: pass — mocked spawn returns `{status: 'completed', conclusion: 'success'}` on second poll; log grep finds `ack`.
- Happy path: pass without log grep — log fetch errors, but the run conclusion is success; still returns `{kind: 'pass'}` with a note.
- Error path: fail — conclusion is `failure`; returns `{kind: 'fail', runUrl}`.
- Edge case: env approval — status stays `waiting` with `approval` keyword; returns `{kind: 'unverified', message: 'Workflow requires environment approval at <url>'}` after first poll.
- Edge case: timeout — all polls return `status: 'queued'`; returns `{kind: 'unverified', message: 'did not complete in 5 minutes'}`.
- Edge case: `gh workflow run` fails at trigger; returns `{kind: 'unverified'}` with redacted stderr.
- Edge case: bearer token is NOT included in any return-message field (security hygiene).
- Race condition: a concurrent run is triggered by another contributor between the trigger and the first poll. Test: baseline returns `id=100`, trigger succeeds, first poll returns 2 runs: `id=101` (other contributor) and `id=102` (ours). The function MUST select `id=102` (not `id=101`) by skipping any run with `createdAt` before the trigger timestamp OR by selecting the highest `databaseId` greater than `baselineId`.

**Verification:**
- All smoke tests pass with mocked spawn.

- [ ] **Unit 7: Workflow analyzer extension (structural only)**

**Goal:** Update `analyzeFroBotWorkflow` to recognize that `openai/` model prefixes require the existing `opencode-config` input — but NOT emit any `enable-omo: true` warning (librarian-verified unneeded for proxy routing).

**Requirements:** Setup-plan validation from origin

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- The current analyzer already checks for `opencode-config`, `auth-json`, `omo-providers`, and `model` (`setup.ts:347`). The set is sufficient for dual-provider — no new required inputs.
- However, today's analyzer reports gaps as "missing input X on step Y". Verify (no code change needed) that this remains correct when the operator's `FRO_BOT_MODEL` is `openai/...` and the workflow already has all four inputs.
- **No `enable-omo` warning emitted**. The analyzer remains structure-only.
- Add a small new helper-comment block in setup.ts documenting why `enable-omo` is intentionally not warned about (cross-reference: librarian source-verified `fro-bot/agent@v0.44.3+` `action.yaml:99-104` — `omo-providers` is independent of proxy-routed providers via `OPENCODE_CONFIG.provider.<name>.options.baseURL`).
- Update `setup.test.ts` with a new fixture: a workflow with `opencode-config`, `auth-json`, `omo-providers`, `model: openai/gpt-5.4-mini` — analyzer returns `{kind: 'analyzed', stepsWithGaps: []}`.

**Patterns to follow:**
- Existing fixture style at `setup.test.ts:19-95`.

**Test scenarios:**
- Happy path: well-formed workflow with `model: openai/gpt-5.4-mini` returns no gaps.
- Happy path: well-formed workflow with `model: anthropic/claude-sonnet-4-6` still returns no gaps (regression).
- Edge case: workflow missing `opencode-config` returns the existing gap shape (regression).
- Test expectation: no new warnings about `enable-omo` are emitted in ANY test case.

**Verification:**
- All analyzer tests pass.

- [ ] **Unit 8: Destructive overwrite UX (`--force`, `--dry-run`, confirm prompt)**

**Goal:** Add the confirm/force/dry-run protections around the secret-mutation block. Anthropic-only flow is unchanged (G7).

**Requirements:** Destructive overwrite from origin

**Dependencies:** Unit 5

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/setup.ts`
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- Introduce a `mustConfirmDestructive(providers: ProviderId[]): boolean` helper that returns `true` when `providers` includes anything besides `['anthropic']` (preserves G7).
- Before the existing `applyGhValue` loop (`setup.ts:874-885`):
  - If `mustConfirmDestructive` and interactive: `await clack.confirm({message: 'This will overwrite OPENCODE_AUTH_JSON, OPENCODE_CONFIG, OMO_PROVIDERS, and FRO_BOT_MODEL. Existing values are unrecoverable from GitHub. Continue?', initialValue: false})`. Cancel if No.
  - If `mustConfirmDestructive` and non-interactive: require `options.force === true`. Otherwise throw "Pass `--force` to confirm overwriting existing OPENCODE_AUTH_JSON/OPENCODE_CONFIG/OMO_PROVIDERS/FRO_BOT_MODEL. Run with `--dry-run` first to preview."
- For `options.dryRun === true`: skip the proxy-key materialization, `verifyModelsAvailable`, the mutation block, AND the smoke test entirely. Print the planned secret/var names + payload sizes + a redacted preview where the proxy key is rendered as `<proxy-key>`. Style mirrors `keeweb deploy --dry-run` (which skips all preconditions and network calls).
- Confirm prompt is NEVER shown when `providers === ['anthropic']` (G7).

**Patterns to follow:**
- Existing `clack.confirm` usage at `setup.ts:281-288, 817-823, 848-855`.
- Existing dry-run pattern in `packages/cli/src/commands/cliproxy/deploy.ts:89-141`.

**Test scenarios:**
- Happy path: `providers: ['anthropic']` + interactive — confirm prompt is NOT shown (G7).
- Happy path: `providers: ['anthropic', 'openai']` + interactive + operator confirms — mutation proceeds.
- Happy path: `providers: ['anthropic', 'openai']` + interactive + operator declines — mutation skipped, clean cancel message.
- Happy path: `providers: ['openai']` + non-interactive + `--force` — mutation proceeds.
- Error path: `providers: ['openai']` + non-interactive + no `--force` — throws with the expected message.
- Happy path: `--dry-run` prints the planned-actions block and exits without calling `gh secret set`.
- Edge case: `--dry-run` proxy-key value is rendered as `<proxy-key>` placeholder, NOT the real key.
- Edge case: `--dry-run` does not call `verifyModelsAvailable` either (mirrors the existing "skip preconditions on dry-run" pattern).

**Verification:**
- All overwrite-UX tests pass.

- [ ] **Unit 9: Docs (README, AGENTS.md, changeset)**

**Goal:** Document the new flags, the destructive-overwrite caveat, and the `enable-omo` non-requirement. Add a changeset for the published CLI.

**Requirements:** Origin Success Criteria

**Dependencies:** Units 1-8

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/AGENTS.md`
- Modify: `apps/cliproxy/AGENTS.md` (document the `enable-omo` decision + proxy-routed openai behavior)
- Create: `.changeset/cliproxy-setup-openai-provider-opt-in.md` (minor bump per existing convention for new CLI features)

**Approach:**
- README: add a short subsection under the cliproxy section showing the new flags + a representative invocation. Mention the destructive-overwrite warning + `--dry-run` preview.
- `packages/cli/AGENTS.md`: add entries for `--providers`, `--model`, `--force`, `--dry-run`, `--verify-smoke`. Cross-reference the destructive overwrite UX and the `multiselect` exception for `cliproxy setup`.
- `apps/cliproxy/AGENTS.md`: under management API / `OPENCODE_CONFIG` shape, document that the proxy routes OpenAI through the same bearer key, and that `enable-omo: true` is NOT required for proxy-routed providers (cite librarian source).
- Changeset: minor bump with a 2-3 line summary.

**Patterns to follow:**
- Existing README section for cliproxy commands.
- Existing changeset format (see prior cliproxy-setup-rate-limit-retry.md or similar).

**Test scenarios:**
- Test expectation: none — pure documentation.

**Verification:**
- `bun run lint` clean (markdown linting via prettier).
- Changeset format validates (`bunx changeset status`).

## System-Wide Impact

- **Interaction graph:**
  - `cliproxy setup --harness opencode` flow gains a multiselect step and conditional model select.
  - `getHarnessTemplate` is now polymorphic by provider set; its 5 callers (3 harnesses + 2 plan builders) need their signatures audited for safety.
  - The Fro Bot `fro-bot/agent` Action consumes the new dual-provider auth-json/config shapes — verified by librarian source-read.
- **Error propagation:**
  - Validator errors (Unit 4) MUST throw before secret mutation (Unit 8). Order is enforced by the wizard's linear flow.
  - Smoke test failures (Unit 6) MUST NOT throw — they print a warning. `runSetupCommand` returns success regardless.
- **State lifecycle risks:**
  - GitHub secrets are write-only. Existing operator-set values in `OPENCODE_AUTH_JSON` (e.g., custom Claude OAuth shapes) are destroyed by re-running setup with `openai` selected. Mitigated by the destructive-overwrite confirm/force gate (Unit 8) + `--dry-run` preview.
  - Proxy key created during setup persists on the proxy regardless of whether secret writing succeeds. If the operator declines the confirm prompt, the key remains. Acceptable — operator can `cliproxy keys remove` to clean up.
- **API surface parity:**
  - `cliproxy setup --harness claude-code` and `--harness generic` unchanged.
  - `cliproxy login codex` already exists (PR #303); a fresh codex token is a prerequisite for the new validator (Unit 4) but not part of this plan.
- **Integration coverage:**
  - Mocked `fetch` for `/v1/models` covers Unit 4.
  - Mocked `Bun.spawn` for `gh workflow run` and `gh secret set` covers Units 6 and 8.
  - End-to-end verification via `--verify-smoke` after merge against the test repo (`marcusrbrown/infra`) confirms the wiring works.
- **Unchanged invariants:**
  - `cliproxy setup --harness opencode` with NO `--providers` flag, OR `--providers anthropic`, MUST produce a byte-identical secret/var set to today. Regression test in Unit 3 + Unit 5.
  - `gh secret set` continues to use stdin pipe (no value in argv). The new auth-json (potentially larger JSON) is still piped — bytes-length unchanged in mechanism.
  - The existing `analyzeFroBotWorkflow` keeps its structural contract; no new warning classes added (Unit 7).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Secrets overwrite destroys custom Claude OAuth refresh tokens in operator's existing `OPENCODE_AUTH_JSON` | Confirm prompt (interactive) + `--force` requirement (non-interactive) + `--dry-run` preview (Unit 8). Documented in README + AGENTS.md (Unit 9). |
| `fro-bot/agent` upgrades and changes auth-json shape | Mitigated by source-level verification today; future upgrades would surface in autoheal scans. Out of scope for this plan to track. |
| Operator runs `--verify-smoke` against a repo with environment approval gate; smoke test never completes | Bounded 5-min poll + approval-gate detection emits non-blocking warning (Unit 6). Setup completion is never blocked. |
| `/v1/models` check fails transiently (proxy hiccup, network) | Validator throws with an actionable error. Operator can retry. The proxy key on the live proxy is still valid; no cleanup needed. |
| Codex token expires on the proxy after a successful smoke test | Daily autoheal already monitors proxy reachability. Surfacing this as an operational risk in `apps/cliproxy/AGENTS.md` (Unit 9). |
| Bun version drift breaks `AbortSignal.timeout` in Unit 4 fetch | Bun 1.3.x supports `AbortSignal.timeout` natively (verified). Pin not needed. |
| `multiselect` from `@clack/prompts` has a runtime bug under Bun | Verified by other repo uses (`@bfra.me/create`); low probability. Fallback: degrade to two sequential `confirm` prompts if encountered during implementation. |

## Documentation / Operational Notes

- Operators rerunning `cliproxy setup` against a repo with existing custom secrets MUST run `--dry-run` first or pass `--force` consciously. README and AGENTS.md (Unit 9) document this prominently.
- `apps/cliproxy/AGENTS.md` gets a new subsection explaining the proxy-routed-provider model: one bearer key authenticates all routes; OpenAI is routed via `OPENCODE_CONFIG.provider.openai.options.baseURL`, NOT via `enable-omo: true`.
- Memory ID 3845 (observed model identifiers) remains the source of truth for currently-available OpenAI models on the proxy. Future model rotations may need updates to the default — track via R8-style verification on any major model launch.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-25-fro-bot-openai-routing-opt-in-requirements.md](docs/brainstorms/2026-05-25-fro-bot-openai-routing-opt-in-requirements.md)
- Related code: `packages/cli/src/commands/cliproxy/setup.ts`, `packages/cli/src/commands/cliproxy/setup.test.ts`, `packages/cli/src/commands/cliproxy/host.ts`
- Related PRs/issues: PR #303 (codex login + host validation), memory ID 3845 (observed OpenAI model identifiers)
- External docs: `fro-bot/agent@v0.44.3+` `action.yaml` lines 99-104 (omo-providers spec), `fro-bot/agent` `src/services/setup/auth-json.ts:41-54` (verbatim write), `sst/opencode` `packages/opencode/src/auth/index.ts:23-27` (auth schema)
