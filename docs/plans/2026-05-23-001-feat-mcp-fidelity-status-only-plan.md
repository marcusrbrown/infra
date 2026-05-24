---
title: MCP Fidelity for Read-Style CLI Commands
type: feat
status: active
date: 2026-05-23
origin: docs/brainstorms/2026-05-23-mcp-fidelity-status-only-requirements.md
---

# MCP Fidelity for Read-Style CLI Commands

## Overview

`infra mcp` exposes 19 CLI tools via `@goke/mcp@0.0.10`'s `createMcpAction`. Every tool returns empty `content` because the actions write to global `console.log` and `process.stdout`, which the `@goke/mcp` capture flow does not see. This plan wires the 10 read-style commands through goke's per-action execution context (`ctx`) so each tool returns the same formatted output operators see at the terminal, with a structured-return escape hatch for the two commands that naturally produce JSON (`cliproxy keys list`, `cliproxy config get`). The 9 remaining commands stay out of MCP via an explicit `commandFilter` allowlist.

The refactor is mechanical: replace `console.log`/`console.error`/`process.exit` calls in 10 action callbacks with `ctx.console.log`/`ctx.console.error`/`ctx.process.exit`. No helper signatures change. The new pieces are a shared test fixture for `ctx` capture, a Tier-1 in-process integration test that exercises `@goke/mcp` over `InMemoryTransport`, and Tier-2 per-action unit tests asserting captured-output contract markers.

## Problem Frame

`@goke/mcp@0.0.10` reads from a `ctx` object it constructs per tool call. `ctx.console.log` writes hit a `TextCaptureStream` that lands in `CallToolResult.content` as a text block; global `console.log` writes do not get captured (worse: under `StdioServerTransport`, global writes to `process.stdout` corrupt the JSON-RPC channel). The four lines of `packages/cli/src/commands/mcp.ts` use the default `createMcpAction({cli})`, which exposes every registered command as a tool, but every action callback currently routes through globals.

Fro Bot autohealing (`.github/workflows/fro-bot.yaml`, category 5) already calls these tools via MCP and gets back empty content, so the autohealing report has to fall back to running `gh` queries directly. Every new app added to autohealing inherits the same gap until this is fixed.

See origin: `docs/brainstorms/2026-05-23-mcp-fidelity-status-only-requirements.md`.

## Requirements Trace

- R1. 10 read-style commands' actions accept `ctx` as last positional arg and route output through `ctx.console`/`ctx.process` instead of globals. Helpers stay unchanged; actions inline-build captured output.
- R2. Failures call `ctx.process.exit(code)` (not global `process.exit` or `process.exitCode`).
- R3. Structured-return Mode C exception: `cliproxy_keys_list` and `cliproxy_config_get` return raw structured data alongside captured text.
- R4. `mcp.ts` passes an explicit `commandFilter` as a `Set<string>` allowlist of the 10 in-scope commands, with each excluded command annotated by reason in a JSDoc-adjacent comment block.
- R5. Tier-1 integration test exercises `tools/list` in-process against `@goke/mcp` over `InMemoryTransport` from `@modelcontextprotocol/sdk`, asserts the 10 expected tool names and presence of `inputSchema` per command. (The earlier requirements doc framing of "spawns `bunx infra mcp` and pipes JSON-RPC" is superseded — in-process is verified-feasible via `createTransport` hook and avoids subprocess overhead.)
- R6. Tier-2 unit tests per action use a shared `ctx` fixture; assert (a) non-empty captured output on success, (b) contract markers per command, (c) failure paths throw via `ctx.process.exit` with captured stderr.
- R7. The existing 451-test baseline passes; `packages/cli/src/commands/status.test.ts` (global `console` spies) is migrated to the new fixture.
- R8. `bunx infra mcp` lists exactly 10 tools; the 9 cli-only commands MUST NOT appear in `tools/list` output.

## Scope Boundaries

- **No subprocess streaming refactor.** Deploys + gateway logs stay cli-only. `Bun.spawn({stdout: 'inherit'})` capture deserves its own brainstorm.
- **No interactive commands in MCP.** `cliproxy login`, `cliproxy open`, `cliproxy setup` require TTY and stdin.
- **No destructive commands in MCP.** `gateway restore` stays cli-only by policy.
- **No new discovery resource.** `createMcpAction` exposes no Server hook; the lower-level `addCliToolsToMcp` path costs ~50 LOC and is deferred to v2.
- **No `@goke/mcp` contract changes.** Integration uses the published `0.0.10` shape; upstream changes renegotiate this plan.
- **No new MCP authentication or per-tool capability gating.** v1 ships stdio transport, default capabilities.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/mcp.ts` — 7-line MCP registration. Currently `cli.command('mcp', '...').action(createMcpAction({cli}))`. Will receive an explicit `commandFilter` arg.
- `packages/cli/src/cli.ts` — goke CLI instance + command registration via per-app barrels (`keeweb`, `cliproxy`, `gateway`).
- `packages/cli/src/commands/{keeweb,cliproxy,gateway}/*.ts` — 17 source files, 10 of which need refactoring.
- `packages/cli/src/commands/status.ts` — unified top-level status; aggregates per-app `getStatusSummary` helpers.
- `packages/cli/src/__test__/` — does NOT exist yet. New test fixture lands here.
- `packages/cli/src/commands/status.test.ts` — uses `spyOn(console, 'log')` today; needs migration to the shared `ctx` fixture.
- Goke skill at `.agents/skills/goke/SKILL.md`, sections "MCP server" and "Injectable I/O".
- `@goke/mcp@0.0.10` source confirms the action receives `ctx` as the last arg (`cli-to-mcp.ts:458`); `buildCallToolResult` concatenates captured stdout, captured stderr, and stringified return value when present (`cli-to-mcp.ts:336-365`); `GokeProcessExit` converts to an `isError: true` CallToolResult on exit (`cli-to-mcp.ts:347-365`).

### Institutional Learnings

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — cliproxy patterns
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — gateway patterns
- Memory #3191: `@goke/mcp` does not capture global `console`/`process.stdout` writes. Root cause behind this plan.
- Memory #3618: design work paused until `@goke/mcp` capture contract verified. Gate cleared.
- Memory #3766: `import.meta.main` guard is required for any module that exports symbols for testing. Already in effect across the codebase; planning here only.
- Memory #399: `goke@6.8.0` does not merge global CLI options into subcommand action types. Each command declares its own options.

### External References

None needed — `@goke/mcp` source and the `@modelcontextprotocol/sdk@1.29.0` `InMemoryTransport` were inspected directly during the brainstorm. No external best-practice research beyond that.

## Key Technical Decisions

- **`ctx.console` capture (Mode A) as default, Mode C exception for `cliproxy_keys_list` and `cliproxy_config_get`.** Mode A preserves human readability; Mode C lets agents avoid regex-parsing tables. `@goke/mcp`'s `buildCallToolResult` already concatenates text capture + structured return value, so the exception costs zero framework changes.
- **`ctx` flows via callback parameter (Pattern A).** Per memory #3766 and repo discipline of explicit-over-clever. No global console shim, no HOF wrapper.
- **Inline `ctx.console` calls in actions; helpers unchanged.** Three reviewers flagged a helper-output-parameter pattern as ceremony for a one-time refactor. Helpers continue to return strings or structured objects; actions are the print site.
- **`commandFilter` allowlist as a `Set<string>` in `mcp.ts` with per-command exclusion rationale in a JSDoc comment.** `Set<string>` is one allocation, one lookup per command, and trivially extensible. Adding a future capturable command is one entry. Listing each excluded command's reason inline turns the allowlist from a magic incantation into self-documenting filter.
- **Tier-1 test uses `InMemoryTransport` from `@modelcontextprotocol/sdk@1.29.0` via `createTransport` hook.** `createMcpAction` exposes `createTransport: () => Transport | Promise<Transport>` (see `@goke/mcp@0.0.10/cli-to-mcp.ts:622-633`). The test builds a linked transport pair, runs `createMcpAction` with the server side, connects a client to the other side, and exercises `tools/list` without spawning a subprocess. Faster, deterministic, no JSON-RPC string parsing.
- **Tier-2 shared fixture at `packages/cli/src/__test__/mcp-ctx-fixture.ts`.** Approximates `@goke/mcp`'s `createCallToolExecutionContext` shape sufficiently for action-level testing: `ctx.console.log/error` push to arrays, `ctx.process.stdout.write`/`stderr.write` push to arrays, `ctx.process.exit(code)` throws a tagged error. Returns `{ctx, captured: {stdout, stderr, exit}}` per test invocation. The fixture is an approximation, not a contract-equivalent re-implementation — Unit 7's Tier-1 test covers the real `@goke/mcp` path. If a test needs precise contract behavior it should use the Tier-1 harness.
- **v1 is deliberately an observability surface.** Path to full agent autonomy goes through subprocess streaming + auth/approval gating. Both are explicit v2.
- **`@goke/mcp` upgrade policy: manual review only, no version constraint change.** For pre-1.0 packages, npm/Bun semver treats `~0.0.10` and `^0.0.10` IDENTICALLY (both lock at patch-only resolution). Tightening the constraint operator is a no-op. The real lever is a Renovate-level policy: `@goke/mcp` bumps are flagged for manual review and must pass Tier-1 + Tier-2 tests before merge. Documented in `packages/cli/AGENTS.md` per Unit 8.

## Open Questions

### Resolved During Planning

- **Allowlist shape (R4):** `Set<string>` with inline JSDoc rationale for each excluded command.
- **Tier-1 test transport (R5):** `InMemoryTransport` via `createTransport` hook. Verified hook exists in `@goke/mcp@0.0.10` source (`cli-to-mcp.ts:622-633`).
- **Shared `ctx` fixture location (R6):** `packages/cli/src/__test__/mcp-ctx-fixture.ts` — single source for all 10 Tier-2 callers.
- **`status` command tool-name collision (R8):** Default `@goke/mcp` `sanitizeToolName` replaces spaces with underscores. `gateway status` → `gateway_status`, `cliproxy status` → `cliproxy_status`, `keeweb status` → `keeweb_status`, top-level `status` → `status`. No collision. AE1's expected name list stands.
- **Mode C extension criterion (R3):** Stricter gate — a command qualifies for Mode C ONLY when ALL of the following hold: (a) it wraps a single management-API GET call returning structured data, (b) the structured payload is a single object (not a paginated stream or large blob), (c) an agent consuming the tool plausibly needs to parse the structure programmatically (not just display it). Currently `cliproxy_keys_list` and `cliproxy_config_get` qualify. `cliproxy_keys_add`/`remove` and `cliproxy_config_set` do NOT qualify because they return success/failure status (Mode A). Future additions require re-evaluating against this 3-clause gate.

### Deferred to Implementation

- Exact `Bun.spawn` mock shape per action's Tier-2 test (varies by what the action calls: `fetch`, `Bun.spawn`, etc.). Each test author resolves by reading the action's surface.
- Whether to add a brief inline comment in each refactored action signature explaining the `ctx` param, or rely on the goke skill documentation as the contract reference. Implementer call.
- Final wording of each command's contract markers in Tier-2 tests (e.g., is `version line` literally the regex `/v\d+\.\d+\.\d+/` or just "contains the word 'version'"?). Resolved when writing each test.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

**MCP request lifecycle, after refactor:**

```text
Agent: tools/list                              Agent: tools/call cliproxy_status
        │                                              │
        ▼                                              ▼
@goke/mcp ListToolsRequestSchema           @goke/mcp CallToolRequestSchema
  filters via cmd commandFilter Set            creates ctx with capture streams
  returns 10 tools                             invokes action(options, ctx)
                                                  │
                                                  ▼
                                          action body:
                                            const summary = formatSummary(...)
                                            ctx.console.log(summary)
                                            // OR for Mode C commands:
                                            ctx.console.log(formatTable(data))
                                            return data
                                                  │
                                                  ▼
                                          buildCallToolResult(
                                            returnValue,
                                            capturedStdout,
                                            capturedStderr
                                          )
                                            ├─ Mode A: content = [{type:'text', text: stdout}]
                                            └─ Mode C: content = [
                                                {type:'text', text: stdout},
                                                {type:'text', text: stringify(data)}
                                              ]
```

**Per-action diff shape (illustrative, not literal):**

```ts
// before
cli.command('cliproxy status', '...')
  .action(async (options) => {
    const summary = await getCliproxyStatusSummary(...)
    console.log(formatSummary(summary))
    if (summary.error) process.exit(1)
  })

// after
cli.command('cliproxy status', '...')
  .action(async (options, ctx) => {
    const summary = await getCliproxyStatusSummary(...)
    ctx.console.log(formatSummary(summary))
    if (summary.error) ctx.process.exit(1)
  })

// after, Mode C exception (cliproxy keys list)
cli.command('cliproxy keys list', '...')
  .action(async (options, ctx) => {
    const data = await fetchKeys(...)
    ctx.console.log(formatKeysTable(data))
    return data
  })
```

## Implementation Units

- [ ] **Unit 1: Shared MCP test fixture**

**Goal:** Build the shared `ctx` capture fixture that all Tier-2 tests will use. This unit blocks Units 4–6 (per-app refactors).

**Requirements:** R6

**Dependencies:** None.

**Files:**
- Create: `packages/cli/src/__test__/mcp-ctx-fixture.ts`
- Test: `packages/cli/src/__test__/mcp-ctx-fixture.test.ts`

**Approach:**
- Export `createCapturedCtx()` that returns `{ctx, captured}`.
- `ctx` matches `@goke/mcp`'s `GokeExecutionContext` shape:
  - `ctx.console.log(...args)` pushes the formatted string to `captured.stdout`
  - `ctx.console.error(...args)` pushes to `captured.stderr`
  - `ctx.process.stdout.write(chunk)` pushes to `captured.stdout` (string or Buffer/Uint8Array)
  - `ctx.process.stderr.write(chunk)` pushes to `captured.stderr`
  - `ctx.process.exit(code)` throws a tagged error `MockProcessExit(code)` so the test can assert exit semantics without killing the runner
- `captured` is `{stdout: string[], stderr: string[], exit: {code: number} | null}` where `exit` is populated when `ctx.process.exit` is caught.
- Provide a small helper `expectCapturedToInclude(captured, marker: string | RegExp)` that searches concatenated stdout for a match — keeps assertions terse.

**Execution note:** Test-first. Write the fixture's own tests against `createCapturedCtx()` before exporting it.

**Patterns to follow:**
- `packages/shared/server/droplet-helpers.test.ts` for `spyOn` and afterEach restore patterns
- `node_modules/.bun/@goke+mcp@0.0.10+a6b6ab9123cdf578/node_modules/@goke/mcp/src/cli-to-mcp.ts` lines 304-324 for the real construction the fixture mirrors

**Test scenarios:**
- Happy path: `ctx.console.log('hello')` populates `captured.stdout` with `['hello']`.
- Happy path: `ctx.process.stdout.write('chunk')` populates `captured.stdout` (string variant).
- Happy path: `ctx.process.stdout.write(Buffer.from('chunk'))` populates `captured.stdout` (buffer variant decoded as utf-8).
- Error path: `ctx.process.exit(1)` throws `MockProcessExit`, and after the throw `captured.exit.code === 1`.
- Edge case: calling `ctx.process.exit(0)` still throws (exit 0 is still an exit in tool-call semantics).
- Integration: the fixture's behavior matches what `@goke/mcp` would produce — write a sanity test that wraps a no-op action in `createMcpAction`'s real flow via `InMemoryTransport` (or skip if too coupled — note "Cross-check verified manually" in the fixture comment).

**Verification:**
- `bun test packages/cli/src/__test__/mcp-ctx-fixture.test.ts` passes.
- Other Tier-2 unit tests (Units 4–6) can import the fixture and use it without modification.

---

- [ ] **Unit 2: Refactor `mcp.ts` to use `commandFilter` allowlist**

**Goal:** Replace the unconditional `createMcpAction({cli})` with an explicit `commandFilter` Set that admits only the 10 in-scope commands. Annotate every excluded command's reason in the same file so the allowlist self-documents.

Landing Units 2 and 7 together (allowlist + Tier-1 test) before Units 3-6 sharpens early feedback: implementers see the empty-content failure at the contract layer before refactoring each action, which prevents "the test went green for the wrong reason".

**Requirements:** R4, R8

**Dependencies:** None.

**Files:**
- Modify: `packages/cli/src/commands/mcp.ts`
- Test: `packages/cli/src/commands/mcp.test.ts` (new — Tier-1 integration test lands here in Unit 7)

**Approach:**
- Add a `const MCP_ALLOWLIST = new Set<string>([...10 names])` constant at module scope. The 10 names match `@goke/mcp`'s `command.name` exactly:
  - `gateway status`, `gateway backup`
  - `cliproxy status`, `cliproxy keys list`, `cliproxy keys add`, `cliproxy keys remove`, `cliproxy config get`, `cliproxy config set`
  - `keeweb status`
  - `status` (the top-level unified status)
- Add a JSDoc-style comment block above the allowlist listing each EXCLUDED command and its one-line reason — verbatim from R4.
- Update `registerMcp(cli)` to call `createMcpAction({cli, commandFilter: (name) => MCP_ALLOWLIST.has(name)})`.
- Do NOT export the allowlist from `mcp.ts` yet (R4 specifies "single source-of-truth in the same module"). If Unit 7's Tier-1 test needs the allowlist, it can re-derive from the same names — keeps the production surface tight.

**Patterns to follow:**
- `packages/cli/src/commands/mcp.ts` current 7-line shape
- `@goke/mcp@0.0.10` `commandFilter` signature: `(commandName: string) => boolean`

**Test scenarios:**
- Test expectation: none for this unit's own behavior beyond what Unit 7's Tier-1 integration covers — the allowlist's correctness is observable via `tools/list`. No standalone unit test for the Set.

**Verification:**
- `bunx infra mcp` (run interactively or via the Tier-1 test in Unit 7) lists exactly 10 tools.
- Manual check via `mcp inspector` or the Tier-1 test passes AE1.

---

- [ ] **Unit 3: Refactor gateway commands (status, backup)**

**Goal:** Migrate `gateway/status.ts` and `gateway/backup.ts` actions to use `ctx.console`/`ctx.process` per R1 and R2. No helper signature changes.

**Requirements:** R1, R2

**Dependencies:** Unit 1 (fixture).

**Files:**
- Modify: `packages/cli/src/commands/gateway/status.ts`
- Modify: `packages/cli/src/commands/gateway/backup.ts`
- Test: `packages/cli/src/commands/gateway/status.test.ts` (extend with Tier-2 fixture-based tests)
- Test: `packages/cli/src/commands/gateway/backup.test.ts` (extend)

**Approach:**
- For each action, change signature from `(options) => ...` to `(options, ctx) => ...`.
- Replace `console.log` → `ctx.console.log`, `console.error` → `ctx.console.error`, `process.exit(code)` → `ctx.process.exit(code)`.
- **Helper exception for `gateway/backup.ts`:** the existing `backupGatewayCa(..., printErr?: (msg: string) => void)` helper writes a sensitive-data warning to stderr via `process.stderr.write` when `printErr` is not provided. After the refactor, the action MUST pass `printErr: (msg) => ctx.process.stderr.write(`${msg}\n`)` (or equivalent) so the warning lands in MCP capture instead of leaking to the host stderr. The helper signature already accepts the injection point; this is a call-site change, not a signature change. Other helpers in these two files (`formatGatewayStatusSummary`, etc.) return strings only and stay unchanged.
- Audit Unit 3 acceptance: grep `process.std(out|err).write` and `console\.` in both files post-refactor. Both should return zero hits.

**Execution note:** Add a fixture-based Tier-2 test BEFORE modifying the action signature — the test exercises the captured-output contract, then implementing the refactor turns it green.

**Patterns to follow:**
- `@goke/mcp@0.0.10` `cli-to-mcp.ts:458` — action signature `(...positionalValues, optionsObject, ctx)`.
- The goke skill ".agents/skills/goke/SKILL.md" — `cli.createExecutionContext` shape.

**Test scenarios:**
- Happy path (`gateway_status`): Given a mocked reachable droplet, when the action runs with the fixture's `ctx`, `captured.stdout` contains the service-state table AND a line mentioning "healthy" (or "degraded" if any service is in that state).
- Edge case (`gateway_status`): Given a mocked unreachable droplet (SSH connection refused), the action calls `ctx.process.exit(1)`, `captured.exit.code === 1`, and `captured.stderr` contains the SSH error message.
- Happy path (`gateway_backup`): Given a mocked successful tarball write of 1234 bytes to `/tmp/out.tar.gz`, `captured.stdout` contains both `/tmp/out.tar.gz` and `1234`.
- Error path (`gateway_backup`): Given a mocked file-write error, the action calls `ctx.process.exit(1)` and `captured.stderr` contains the write-error reason.
- Integration: When invoked via `@goke/mcp` (i.e., real `createCallToolExecutionContext`) — covered by Unit 7's Tier-1 + an E2E `tools/call` smoke test if time permits, otherwise deferred to v2 polish.

**Verification:**
- All Tier-2 tests in these two files pass.
- `bun test packages/cli/src/commands/gateway/` passes.

---

- [ ] **Unit 4: Refactor cliproxy commands (status, keys list/add/remove, config get/set) including Mode C exception**

**Positional-argument note:** Several actions in this unit take positional args, not options-only. Per `@goke/mcp@0.0.10` (`cli-to-mcp.ts:458`), `ctx` is ALWAYS the last argument regardless of how many positional args precede it. So the migration shapes are:
- `(apiKeyToAdd, options) => ...` becomes `(apiKeyToAdd, options, ctx) => ...`
- `(apiKeyToRemove, options) => ...` becomes `(apiKeyToRemove, options, ctx) => ...`
- `(field, value, options) => ...` becomes `(field, value, options, ctx) => ...`
- `(options) => ...` (status, keys list, config get) becomes `(options, ctx) => ...`

**Goal:** Migrate the 6 cliproxy commands (status, 3 keys, 2 config) per R1 + R2. For `cliproxy keys list` and `cliproxy config get`, additionally return the structured data per R3 (Mode C).

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1 (fixture).

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/status.ts`
- Modify: `packages/cli/src/commands/cliproxy/keys.ts`
- Modify: `packages/cli/src/commands/cliproxy/config.ts`
- Test: `packages/cli/src/commands/cliproxy/status.test.ts` (extend)
- Test: `packages/cli/src/commands/cliproxy/keys.test.ts` (extend)
- Test: `packages/cli/src/commands/cliproxy/config.test.ts` (extend)

**Approach:**
- Same migration pattern as Unit 3.
- For `cliproxy keys list` action: AFTER `ctx.console.log(formatKeysTable(data))`, add `return data` (where `data` is the raw `{api-keys: string[]}` from the management API). `@goke/mcp` will emit two text blocks per AE4.
- For `cliproxy config get` action: same shape — `ctx.console.log(formatConfig(config))` then `return config`.
- For `cliproxy keys add`, `cliproxy keys remove`, `cliproxy config set`: text-only Mode A. Do not return structured data; these are mutations whose success/failure is conveyed through the captured text.
- Add an inline code comment above each Mode C `return` statement explaining the criterion: "Mode C exception per docs/plans/2026-05-23-001 — wraps a single management-API call returning structured data".

**Execution note:** Test-first. The Mode C test asserts that `captured.stdout` AND the action's return value are both non-empty.

**Patterns to follow:**
- Unit 3's gateway migration
- `@goke/mcp@0.0.10` `cli-to-mcp.ts:336-365` for the `buildCallToolResult` precedence rules

**Test scenarios:**
- Happy path (`cliproxy_status`): Given mocked HTTP 200 from the proxy with usage stats, `captured.stdout` contains the version line, the HTTP status line, and the usage stats line.
- Error path (`cliproxy_status`): Given mocked HTTP 503, the action calls `ctx.process.exit(1)`, `captured.exit.code === 1`, `captured.stderr` contains the HTTP error.
- Happy path / Mode C (`cliproxy_keys_list`): Given a mocked management API response with 3 keys, `captured.stdout` contains all 3 key fingerprints/names in the formatted table AND the action's return value is the raw `{api-keys: [...]}` object.
- Happy path (`cliproxy_keys_add`): Given a mocked successful add, `captured.stdout` contains the added key value or a confirmation message; action does NOT return structured data (Mode A).
- Error path (`cliproxy_keys_remove`): Given a value that doesn't match any registered key, the action calls `ctx.process.exit(1)` per AE3.
- Happy path / Mode C (`cliproxy_config_get`): Given a mocked config response, `captured.stdout` contains the formatted config display AND the action returns the raw config object.
- Happy path (`cliproxy_config_set`): Given a mocked PUT success, `captured.stdout` contains a confirmation.
- Edge case (Mode A/C boundary): Verify that `cliproxy_keys_add`'s action returns `undefined` (not a structured value), so `buildCallToolResult` does not produce a stray second text block.

**Verification:**
- All Tier-2 tests in these three files pass.
- `bun test packages/cli/src/commands/cliproxy/` passes.

---

- [ ] **Unit 5: Refactor keeweb command (status)**

**Goal:** Migrate `keeweb/status.ts` per R1 + R2.

**Requirements:** R1, R2

**Dependencies:** Unit 1 (fixture).

**Files:**
- Modify: `packages/cli/src/commands/keeweb/status.ts`
- Test: `packages/cli/src/commands/keeweb/status.test.ts` (extend)

**Approach:**
- Same migration pattern as Unit 3.

**Execution note:** Test-first.

**Patterns to follow:**
- Unit 3's gateway migration

**Test scenarios:**
- Happy path (`keeweb_status`): Given mocked HTTP 200, content-hash match, and last-deploy success, `captured.stdout` contains "OK" markers for each of the 3 checks.
- Error path (`keeweb_status`): Given mocked HTTP 503, the action calls `ctx.process.exit(1)` and `captured.stderr` contains the error.
- Edge case (`keeweb_status`): Given a content-hash drift between local dist and remote, `captured.stdout` flags the drift but does NOT exit non-zero (drift is a warning, not an error).

**Verification:**
- All Tier-2 tests pass.
- `bun test packages/cli/src/commands/keeweb/` passes.

---

- [ ] **Unit 6: Refactor unified top-level `status` command + migrate existing tests**

**Goal:** Migrate `packages/cli/src/commands/status.ts` (the unified aggregator) per R1 + R2, AND migrate the existing `status.test.ts` from `spyOn(console, 'log')` to the shared fixture per R7.

**Requirements:** R1, R2, R7

**Dependencies:** Unit 1 (fixture), Units 3-5 (per-app status helpers).

**Files:**
- Modify: `packages/cli/src/commands/status.ts`
- Modify: `packages/cli/src/commands/status.test.ts`

**Approach:**
- Same migration pattern as Unit 3 for the action.
- For the test file migration: replace every `spyOn(console, 'log')` block with a `createCapturedCtx()` call. The test asserts on `captured.stdout.join('\n')` instead of the spy's call arguments. Where the test used `spyOn(process, 'exit')`, replace with assertions on `captured.exit.code`. Where the test passed args via `process.argv` shimming, pass `ctx` and `options` directly — the test is exercising the action callback, not the goke parse layer.
- Audit: are there any OTHER test files in the repo using `spyOn(console, ...)` for the 10 refactored commands? If yes, migrate them in this unit too. If they're for cli-only commands (not refactored here), leave them.

**Execution note:** Migrate the tests in place — keep the existing test cases' intent; just swap the harness.

**Patterns to follow:**
- Unit 1's `createCapturedCtx()` API
- The replaced tests' assertion patterns (e.g., the JSON output test asserts on the structured shape of `captured.stdout[0]` parsed as JSON)

**Test scenarios:**
- Happy path (unified `status`): Given all 3 per-app status helpers return OK, `captured.stdout` contains all 3 app names and "OK" markers.
- Error path (unified `status`): Given any per-app helper returns ERROR, `captured.stdout` contains the failing app and `captured.exit.code === 1`.
- Edge case (`--json` flag): Given `options.json === true`, `captured.stdout[0]` parsed as JSON contains the structured summary for all 3 apps.
- Edge case (test migration): At least one test that previously used `spyOn(console, 'log')` now uses the fixture and produces the same assertion intent.

**Verification:**
- `bun test packages/cli/src/commands/status.test.ts` passes with all original test cases still intact.
- No `spyOn(console, ...)` or `spyOn(process, ...)` calls remain in `packages/cli/src/commands/status.test.ts`.
- Full `bun test --recursive` baseline holds: tests increase by ≥ N (the Tier-2 additions) and do not decrease.

---

- [ ] **Unit 7: Tier-1 integration test via `InMemoryTransport`**

**Goal:** Write the Tier-1 integration test that exercises `@goke/mcp` end-to-end without spawning a subprocess. The test spawns the goke CLI in-process, connects an MCP client via `InMemoryTransport`, and asserts `tools/list` returns exactly the 10 expected names.

**Requirements:** R5, R8

**Dependencies:** Unit 2 (allowlist registered).

**Files:**
- Create: `packages/cli/src/commands/mcp.test.ts`

**Approach:**
- Build the test as follows (illustrative shape only — not literal code):
  1. Import `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js` and `Client` from `@modelcontextprotocol/sdk/client/index.js`.
  2. Create a linked transport pair: `const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()`.
  3. Build a goke CLI instance matching the production registration (call the same `register*` functions from `packages/cli/src/cli.ts` so the test exercises the real command tree — DO NOT duplicate the registration list, that's a test smell).
  4. Construct the action via `createMcpAction({cli, commandFilter: ..., createTransport: () => serverTransport})` — the `createTransport` hook is the entry point.
  5. Invoke the MCP-command action (it returns a Promise that resolves when the server is connected).
  6. Connect a client to `clientTransport`, send `tools/list`, assert the result.
- The test asserts:
  - `result.tools.length === 10`
  - The set of tool names matches AE1 exactly (use a sorted-array equality check).
  - Each tool has a non-null `inputSchema` (does not assert exact schema shape).
- Tear down: close client + server cleanly after the test.

**Execution note:** Implement test-first against the post-Unit-2 allowlist.

**Fallback path if `InMemoryTransport` fails to work under Bun:** If the SDK's stream implementation is incompatible with Bun's event loop or the linked-pair lifecycle hangs in cleanup:
1. Replace step 2 (linked transports) with a subprocess spawn: `Bun.spawn(['bunx', '@marcusrbrown/infra', 'mcp'], {stdin: 'pipe', stdout: 'pipe'})`.
2. Write a `tools/list` JSON-RPC request directly to `subprocess.stdin` (one line of newline-delimited JSON-RPC 2.0).
3. Read response lines from `subprocess.stdout` until a matching `id` arrives.
4. Assert the same 10-tool name set and `inputSchema` presence.
5. Tear down with `subprocess.kill()`.

The subprocess path is more expensive but it's the canonical MCP transport behavior, so the contract assertions remain equivalent. If both paths are unblocked, prefer in-process for speed. If the in-process path is blocked, ship the subprocess form — do NOT skip the test entirely.

**Patterns to follow:**
- `node_modules/.bun/@goke+mcp@0.0.10+a6b6ab9123cdf578/node_modules/@goke/mcp/src/__test__/create-mcp-action.test.ts` — `@goke/mcp`'s own tests show how to wire `createMcpAction` for testing.
- `@modelcontextprotocol/sdk@1.29.0`'s `InMemoryTransport.createLinkedPair()` example in the SDK docs.

**Test scenarios:**
- Happy path: `tools/list` returns exactly the 10 expected tool names per AE1.
- Edge case: All 10 tools have non-null `inputSchema`. (Note: `inputSchema` for option-less commands is `{type: 'object', properties: {}}` — still non-null, just empty. The unified `status` command has options, so this is uniform.)
- Defensive assertion: None of the 9 cli-only command names appear in the response (explicit list check, not just a count).
- **Mode C contract assertion (covers R3, AE4):** Issue a `tools/call` with name `cliproxy_keys_list` against a mocked proxy (use a fixture that returns `{"api-keys": ["k1", "k2", "k3"]}`). Assert the returned `CallToolResult.content` is exactly 2 text blocks: the first matches the human-formatted keys table, the second parses as JSON and matches `{"api-keys": ["k1", "k2", "k3"]}`. This proves the Mode C path works end-to-end through `@goke/mcp`'s `buildCallToolResult`, not just through our fixture.

**Verification:**
- `bun test packages/cli/src/commands/mcp.test.ts` passes with the 3 scenarios above.
- A future regression where someone removes a tool from the allowlist OR adds a tool without registering it would fail this test.

---

- [ ] **Unit 8: Documentation**

**Goal:** Update `packages/cli/AGENTS.md` to reflect the new MCP behavior, the allowlist as single-source-of-truth, the Mode C exception's stricter gate, and the manual-review policy for `@goke/mcp` bumps.

**Requirements:** R3 (criterion documentation), R4 (allowlist documentation), upgrade policy from Key Technical Decisions.

**Dependencies:** Units 2, 3, 4, 5, 6, 7 (the refactor must be in place before documenting it).

**Files:**
- Modify: `packages/cli/AGENTS.md`

**Approach:**
- Add a brief "MCP fidelity" subsection under the existing CLI patterns, explaining:
  - Actions thread `ctx` as the last positional arg per the goke skill
  - `packages/cli/src/commands/mcp.ts` allowlist is the single source of truth for MCP-exposed tools
  - Mode C structured-return exception applies only to commands meeting the 3-clause gate in Key Technical Decisions; future additions require re-evaluation
  - `@goke/mcp` upgrades flagged for manual review — bumps must pass Tier-1 + Tier-2 tests before merge
- Renovate config changes are intentionally omitted from this unit. Existing Renovate behavior already opens PRs for `@goke/mcp` bumps; the manual-review discipline is an ops practice documented in AGENTS.md, not a config-level enforcement. If the manual policy proves insufficient in practice, add a `packageRules` entry in a follow-up.

**Test scenarios:**
- Test expectation: none — pure documentation.

**Verification:**
- The AGENTS.md addition is reachable from the existing structure (linked from the relevant section).
- The 4 documented points (ctx threading, allowlist authority, Mode C gate, upgrade policy) are individually distinguishable in the section text.

## System-Wide Impact

- **Interaction graph:** Fro Bot autohealing (`.github/workflows/fro-bot.yaml` category 5) currently calls these 10 tools via MCP and gets empty content. After this refactor, Fro Bot gets real responses. Autohealing logic may need a one-line tweak to actually use the captured text instead of falling back to `gh` — but that change is in `fro-bot.yaml`, not this repo's runtime. Capture as a follow-up smart note after this lands.
- **Error propagation:** `ctx.process.exit(code)` throws `GokeProcessExit`, which `@goke/mcp`'s `runCliTool` catches and converts to a `CallToolResult` with `isError: true`. In CLI mode (when running outside MCP), goke's default `ctx.process.exit` is the real `process.exit`, so error behavior is unchanged for terminal users.
- **State lifecycle risks:** None new. The 10 commands are read-style; the only mutation is `gateway backup` writing to a local path the caller specified, which already happens today.
- **API surface parity:** The CLI behavior (human-facing) does not change. The MCP behavior changes from empty to populated. Operators running `bunx infra cliproxy status` see identical output before and after.
- **Integration coverage:** The Tier-1 `InMemoryTransport` test covers the `mcp.ts` ↔ `@goke/mcp` ↔ `@modelcontextprotocol/sdk` integration seam. Tier-2 tests cover the action ↔ `ctx` capture seam per command. Cross-layer not covered: live calls through `bunx infra mcp` against a real MCP client (Claude Desktop, Cursor, etc.) — manual smoke verification only.
- **Unchanged invariants:** Helper signatures (`formatSummary`, `formatKeysTable`, etc.) remain unchanged. The published `@marcusrbrown/infra` CLI interface (commands, options, help text) is unchanged for terminal users. The 9 cli-only commands continue to work via the terminal and continue to NOT appear in MCP. The MCP transport remains stdio in production.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `@goke/mcp@0.0.10` upstream releases a breaking 0.0.11 patch that changes `ctx` shape or `commandFilter` semantics | Manual-review policy documented in AGENTS.md (per Unit 8). Renovate PRs for `@goke/mcp` bumps must pass Tier-1 + Tier-2 tests before merge. Version-constraint tightening is intentionally NOT used because npm/Bun treat `~0.0.x` identically to `^0.0.x` for pre-1.0 packages. |
| `InMemoryTransport` API in `@modelcontextprotocol/sdk@1.29.0` doesn't behave as expected (lifecycle/cleanup quirks) | Unit 7 starts with a smoke test; if blocked, fall back to subprocess + JSON-RPC pipe. Document the fallback in the test file. |
| Existing `status.test.ts` console-spy tests reveal assertions that the fixture-based form can't replicate cleanly | Migration in Unit 6 keeps the test cases' intent — if a specific assertion can't translate, replace with a stronger Tier-2 assertion against the captured-output contract. Do NOT delete tests to make migration green. |
| A future contributor adds an 11th capturable command but forgets to add it to the allowlist | Unit 7's Tier-1 test asserts exact-set equality. Adding a new command without registering would make the set `≠ 10` and fail the test. |
| Mode C structured return for `cliproxy_keys_list` produces too-large output blocks for some agents | Output is text in both cases; the structured block is a stringified JSON object usually < 1 KB. Not a concern at v1 scale. Revisit if usage data ever needs streaming. |
| Manual-review discipline for `@goke/mcp` bumps drifts over time | Renovate PRs already require a passing CI run; the Tier-1 test asserts the contract is intact. If a bump merges with broken behavior, the post-merge CI run on `main` will fail and Fro Bot autohealing will surface the regression in its daily report. Acceptable risk for a single dep used in one module. |

## Documentation / Operational Notes

- **Fro Bot autohealing follow-up.** After this lands, Fro Bot autohealing (`.github/workflows/fro-bot.yaml` category 5) needs a one-line update to actually consume the captured MCP output instead of falling back to `gh`. Concrete next step: write a smart note triggered on this plan's PR merge that opens a follow-up PR updating category 5's prompt to query via MCP first, then fall back to `gh`. Without that follow-up, the autohealing value driver named in the Problem Frame doesn't materialize.
- **Mode C criterion re-examination.** The 3-clause gate is documented in Key Technical Decisions and AGENTS.md (Unit 8). The first time a new command becomes a candidate for Mode C, walk through all 3 clauses against the candidate. If any clause feels mushy or arbitrary in practice, surface that as a re-brainstorm trigger — the gate is meant to constrain, not be reinterpreted on each addition.
- **v2 momentum.** Subprocess streaming refactor and authentication/approval gating are explicit v2. Follow-up issues filed:
  - [#291](https://github.com/marcusrbrown/infra/issues/291) — MCP v2: subprocess streaming for deploys and logs
  - [#292](https://github.com/marcusrbrown/infra/issues/292) — MCP v2: authentication and approval gating for mutating tools

  Both issues capture trigger conditions, constraint inputs, and design questions so they remain actionable when the time comes.
- **Changelog.** No entry for the refactor's CLI behavior (unchanged). DO add a changelog entry for the MCP fidelity improvement — operators using `bunx infra mcp` see meaningful content for the first time.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-23-mcp-fidelity-status-only-requirements.md](./docs/brainstorms/2026-05-23-mcp-fidelity-status-only-requirements.md)
- `.local/mcp-fidelity-survey.md` — per-command survey (action shape, helper shape, capturable verdict)
- `.agents/skills/goke/SKILL.md` — goke + `@goke/mcp` reference
- `node_modules/.bun/@goke+mcp@0.0.10+a6b6ab9123cdf578/node_modules/@goke/mcp/src/cli-to-mcp.ts` lines 245-365 (capture flow), 458 (action signature), 622-686 (createMcpAction)
- `node_modules/.bun/@modelcontextprotocol+sdk@1.29.0/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.d.ts` — `InMemoryTransport` API
- Related PRs: #290 (refactor pattern + lessons applied here)
- Related memories: #3191 (capture root cause), #3618 (design gate), #3766 (import.meta.main rule), #399 (goke 6.8.0 type behavior)
