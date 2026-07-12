---
title: 'feat: Add cliproxy models subcommand'
type: feat
status: completed
date: 2026-06-13
origin: docs/brainstorms/2026-06-13-cliproxy-models-subcommand-requirements.md
---

# feat: Add cliproxy models subcommand

## Overview

Add `infra cliproxy models [provider]` — an HTTP read command that lists the models CLIProxyAPI serves at `/v1/models`, mirroring `opencode models` within the limits of what the proxy returns. Exposed over MCP as a read-only `cliproxy_models` tool.

## Problem Frame

There is no first-class way to query the live CLIProxyAPI model catalog; today it requires a hand-rolled `curl` with a bearer key. Operators and agents need a discoverable command (see origin: docs/brainstorms/2026-06-13-cliproxy-models-subcommand-requirements.md).

## Requirements Trace

- R1. `infra cliproxy models` lists every model ID the proxy serves (plain list).
- R2. `infra cliproxy models <provider>` filters to `anthropic` or `openai`, matching `owned_by` when present, falling back to id prefix/pattern.
- R3. `--verbose` adds `owned_by` and a formatted `created` date (the only metadata the endpoint provides).
- R4. Auth is a bearer api-key from `--key` or `CLIPROXY_API_KEY`; endpoint from `--url` / `CLIPROXY_URL` / default. No `--host`.
- R5. The ambient `CLIPROXY_API_KEY` is forwarded only to the trusted default/configured URL; an explicit off-trust `--url` does not carry it. An explicit `--key` is always honored.
- R6. Clear errors: missing/invalid key (401/403), non-2xx/network/timeout, malformed payload; invalid provider is a validation error; empty/zero-match prints a plain "no models" message, not an error.
- R7. `cliproxy_models` is added to `MCP_ALLOWLIST` and returns the same captured output via the `ctx` pattern.

## Scope Boundaries

- No `--pure` / `--refresh` (no plugin or models.dev cache layer).
- No `--print-logs` / `--log-level` (opencode-internal logging).
- No `--json` output mode (deferred).
- No cost/pricing/context-window metadata (not returned by the endpoint).
- No `--host` flag (HTTP-only command).

### Deferred to Separate Tasks

- `--json` machine-output mode: future iteration if scripting demand appears.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/cliproxy/setup/validation.ts` — `modelEntrySchema`, `modelsResponseSchema` (`{data:[{id,owned_by?}]}` with `.passthrough()`), `entryMatchesProvider`, `PROVIDER_ID_PATTERNS` (openai/anthropic bare-id patterns), `MODEL_ID_RE`. Reuse the provider-match + schema directly.
- `packages/cli/src/commands/cliproxy/shared.ts` — `requestJson` (throws on non-2xx with status+body, throws on malformed JSON, 10s timeout), `HTTP_TIMEOUT_MS`. Note: `managementHeaders` sets `x-management-key` — NOT reusable here (this command uses `Authorization: Bearer`).
- `packages/cli/src/commands/cliproxy/status.ts` — the goke action + `ActionCtx` capture pattern (`cliproxyStatusAction(options, ctx)`), `--url`/`CLIPROXY_URL`/`DEFAULT_CLIPROXY_URL` resolution, `stripTrailingSlash`, the trusted-URL key-forwarding guard (lines ~387-397), `levelLabel`/column formatting, `registerCliproxyStatus` shape, `ctx.process.exit(1)` on error.
- `packages/cli/src/commands/cliproxy/keys.ts` — bearer-key-as-api-key precedent and `resolveBaseUrl`.
- `packages/cli/src/commands/cliproxy/index.ts` — `registerCliproxyCommands` barrel; register the new command here.
- `packages/cli/src/commands/mcp.ts` — `MCP_ALLOWLIST`; add `cliproxy models`.
- `packages/cli/src/lib/action-ctx.ts` — `ActionCtx` type.

### Institutional Learnings

- `requestJson` must throw (never permissive-default) on malformed JSON — PR #312 data-loss class. Read paths can tolerate empty results, but parse failures still surface.
- The trusted-URL key-forwarding guard in `status.ts` exists to prevent ambient-secret exfiltration to an attacker-controlled `--url` (PR #375 / #376). The models command must replicate it for `CLIPROXY_API_KEY`.
- MCP-allowlisted actions must use `ctx.console`/`ctx.process`, never global `console`/`process.stdout`, or output isn't captured (memory: MCP fidelity).

### External References

- None. The codebase has direct local patterns (status/keys/validation are near-identical HTTP read commands). Live `/v1/models` shape verified: `{data:[{id,object,owned_by,created}],object}`, 19 entries.

## Key Technical Decisions

- **Bearer auth, not management headers.** `/v1/models` authenticates with `Authorization: Bearer <api-key>`. Do not reuse `managementHeaders` (x-management-key). Build a bearer Headers inline.
- **Pragmatic reuse.** Import `entryMatchesProvider`, `PROVIDER_ID_PATTERNS`, and the models schema from `setup/validation.ts` where clean; inline the `/v1/models` fetch in the new command via a small local fetch (or `requestJson` if the bearer header can be passed through `init`). Extract a shared helper only if it falls out naturally — no deliberate refactor of working setup code. (see origin: pragmatic reuse decision)
- **`--url` only.** HTTP command → mirror `status`/`keys` (`--url` + `CLIPROXY_URL` + `DEFAULT_CLIPROXY_URL`), not the SSH commands' `--host`.
- **Trusted-URL key guard.** Replicate `status.ts`: forward ambient `CLIPROXY_API_KEY` only when resolved URL equals the trusted default/configured URL; explicit `--key` always honored.
- **Output via `ctx.console`.** Plain list default; `--verbose` adds `owned_by` + formatted `created`. Use `ctx` so MCP captures it.
- **Provider validation before request.** Reject unknown provider (not `anthropic`/`openai`) as a validation error before the HTTP call, distinct from a zero-match filter (plain "no models").

## Open Questions

### Resolved During Planning

- Which auth? Bearer api-key (`--key`/`CLIPROXY_API_KEY`), confirmed in brainstorm.
- `--host` or `--url`? `--url` only — HTTP command, matches status/keys.
- Reuse vs rebuild provider-match? Pragmatic reuse from validation.ts.

### Deferred to Implementation

- Whether `requestJson` can carry the bearer header cleanly via `init.headers`, or whether a small dedicated fetch reads better — decide when wiring Unit 1. Either way, non-2xx and malformed-JSON must throw.
- Exact column widths / formatting helper for `--verbose` — mirror `status.ts` formatting at implementation time.

## Implementation Units

- [ ] **Unit 1: models fetch + provider filter + formatting (core action)**

**Goal:** A `cliproxyModelsAction(options, ctx)` that fetches `/v1/models` with bearer auth, filters by optional provider, and prints plain or verbose output through `ctx`.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** None

**Files:**
- Create: `packages/cli/src/commands/cliproxy/models.ts`
- Create: `packages/cli/src/commands/cliproxy/models.test.ts`
- Reference (import from): `packages/cli/src/commands/cliproxy/setup/validation.ts`, `packages/cli/src/commands/cliproxy/shared.ts`, `packages/cli/src/lib/action-ctx.ts`

**Approach:**
- `ModelsOptions { url?, key?, verbose?, provider? }` (provider is the positional). Action signature `(options, ctx: ActionCtx)`.
- Resolve base URL: `stripTrailingSlash(options.url ?? CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)`. Compute `trustedUrl` and `urlIsExplicitlyOverridden` exactly like `status.ts`.
- Resolve key: `options.key ?? (urlIsExplicitlyOverridden ? undefined : process.env.CLIPROXY_API_KEY)`. If no key → throw a clear "provide --key or set CLIPROXY_API_KEY" error.
- Validate provider (if given): must be `anthropic`|`openai`, else validation error before any request.
- Fetch `${baseUrl}/v1/models` with `Authorization: Bearer <key>`; parse with the models schema; on non-2xx (esp. 401/403) throw a clear auth/HTTP error; on malformed JSON throw.
- Filter entries via `entryMatchesProvider` when provider given.
- Empty `data` or zero-match → print plain "No models" line via `ctx.console.log` (not an error, no non-zero exit).
- Plain mode: one id per line. Verbose: id + `owned_by` + formatted `created` (unix→date), column-aligned like `status.ts`.
- Wrap in try/catch → `ctx.console.error(message); ctx.process.exit(1)` on failure (mirror status action).

**Patterns to follow:** `cliproxyStatusAction` (ctx, url/key resolution, trusted-URL guard, try/catch+exit), `entryMatchesProvider`, `requestJson` error semantics.

**Test scenarios:**
- Happy path: 200 with mixed entries → plain mode lists all ids.
- Happy path: provider=`openai` → only openai ids (owned_by match).
- Edge: provider match via id-prefix when `owned_by` absent (v7 shape).
- Happy path: `--verbose` → output includes owned_by + a formatted date for each.
- Edge: empty `data` → plain "no models" message, exit 0.
- Edge: provider filter matches zero → plain "no models" message, exit 0 (distinct from invalid provider).
- Error: invalid provider (`gemini`) → validation error, no HTTP call made.
- Error: missing key (no --key, no env) → clear "provide --key…" error, exit 1.
- Error: 401 → clear auth error, exit 1; error message does NOT contain the bearer key value.
- Error: explicit off-trust `--url` does NOT forward ambient `CLIPROXY_API_KEY` (assert no Authorization header / unauthenticated when only env key present).
- Error: malformed JSON body → throws, exit 1.

**Verification:** The action lists live models against the configured proxy; filters, verbose, empty, and error paths behave as enumerated; the bearer key never appears in error output.

- [ ] **Unit 2: register the command + barrel wiring**

**Goal:** `registerCliproxyModels` defines the goke command (positional + `--url`/`--key`/`--verbose`) and is wired into the cliproxy barrel.

**Requirements:** R1, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/models.ts` (add `registerCliproxyModels`)
- Modify: `packages/cli/src/commands/cliproxy/index.ts` (call it in `registerCliproxyCommands`)

**Approach:**
- `cli.command('cliproxy models', '…').option('--url …').option('--key …').option('--verbose', …)` plus the `[provider]` positional. Mirror `registerCliproxyStatus` option descriptions/wording (key falls back to `CLIPROXY_API_KEY`, url falls back to `CLIPROXY_URL`/default). Add `.example(...)` lines.
- Bind `.action(cliproxyModelsAction)`.

**Patterns to follow:** `registerCliproxyStatus`, the positional handling in `login.ts`/goke positional convention.

**Test scenarios:**
- Happy path: `cliproxy models --help` lists the positional, `--verbose`, `--key`, `--url`.
- Integration: command is discoverable in the registered cliproxy group (help/discovery test, mirroring existing CLI discovery tests).

**Verification:** `infra cliproxy models --help` shows the documented surface; the command runs end-to-end against the live proxy.

- [ ] **Unit 3: MCP exposure + drift guard**

**Goal:** Expose `cliproxy models` as the read-only `cliproxy_models` MCP tool.

**Requirements:** R7

**Dependencies:** Unit 2

**Files:**
- Modify: `packages/cli/src/commands/mcp.ts` (add `cliproxy models` to `MCP_ALLOWLIST`)
- Modify: `packages/cli/src/commands/mcp.test.ts` (the Tier-1 `InMemoryTransport` MCP test) to assert `cliproxy_models` is registered and to call it end-to-end

**Approach:**
- Add `'cliproxy models'` to `MCP_ALLOWLIST`. Confirm the action already uses `ctx.console`/`ctx.process` only (Unit 1), so MCP capture works.
- Update the Tier-1 MCP integration test / allowlist assertion to include `cliproxy_models` and assert it returns captured output (mirror the `cliproxy_status` MCP test).

**Patterns to follow:** how `cliproxy status` is allowlisted and tested in `mcp.ts` + its test; the InMemoryTransport MCP integration test pattern.

**Test scenarios:**
- Integration: in `mcp.test.ts`, register the CLI, connect via `InMemoryTransport`, `listTools()` includes `cliproxy_models`.
- Integration: call `cliproxy_models` through the MCP transport with a mocked `/v1/models` fetch and assert the returned text matches the captured model-list output (ctx-capture parity), mirroring the `cliproxy_status` MCP test.

**Verification:** The MCP server registers `cliproxy_models`; calling it returns the same formatted output as the CLI.

- [ ] **Unit 4: docs**

**Goal:** Document the new command where the other cliproxy commands are documented.

**Requirements:** R1-R7 (operator-facing surface)

**Dependencies:** Unit 2

**Files:** update whichever of these currently enumerate cliproxy commands; do not add docs elsewhere.
- Modify: root `AGENTS.md` (the cliproxy command table / "WHERE TO LOOK")
- Modify: `packages/cli/AGENTS.md` (CLI command surface + MCP allowlist list — add `cliproxy_models`)
- Modify: `packages/cli/README.md` (if it enumerates cliproxy commands)

**Approach:**
- Add `cliproxy models [provider]` rows mirroring the existing `cliproxy status` entries; note `--verbose`, `--key`/`CLIPROXY_API_KEY`, `--url`; note `cliproxy_models` is MCP-exposed (read-only).
- Present-tense, developer-facing voice; no plan taxonomy.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Docs list the command and its flags consistently with siblings; no stale `--host` references.

## System-Wide Impact

- **API surface parity:** mirrors `cliproxy status` flag conventions (`--url`/`--key`/`--verbose`); keep wording/behavior consistent.
- **Error propagation:** failures surface via `ctx.console.error` + `ctx.process.exit(1)`; never leak the bearer key in messages.
- **Integration coverage:** the MCP-capture parity test (Unit 3) proves ctx output reaches the bridge — not provable by the unit action test alone.
- **Unchanged invariants:** does not touch setup/validation behavior (only imports from it); does not change management-API auth; no SSH path.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Ambient `CLIPROXY_API_KEY` leaked to attacker-controlled `--url` | Replicate the trusted-URL key-forwarding guard from `status.ts`; test the off-trust case explicitly. |
| Bearer key echoed in error output | Build error messages without the key; add a test asserting the key is absent from 401/HTTP error messages. |
| Importing from `setup/validation.ts` creates a circular import | validation.ts already guards against setup↔validation cycles; import only leaf helpers (`entryMatchesProvider`, `PROVIDER_ID_PATTERNS`, schema). Verify no cycle at implementation. |
| `requestJson` sets management headers / wrong auth | Do not reuse `managementHeaders`; pass a bearer Authorization header (via `init` or a dedicated fetch). |

## Documentation / Operational Notes

- No changeset gating beyond the usual: this is `packages/cli/src/` user-facing new surface → **minor** changeset (new command).
- No deploy impact (CLI-only); paths-filter will skip deploys on merge.

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-13-cliproxy-models-subcommand-requirements.md
- Related code: `packages/cli/src/commands/cliproxy/{status,keys,shared,index}.ts`, `packages/cli/src/commands/cliproxy/setup/validation.ts`, `packages/cli/src/commands/mcp.ts`
- Live endpoint verified: `GET https://cliproxy.fro.bot/v1/models` → `{data:[{id,object,owned_by,created}],object}`
