---
date: 2026-05-23
topic: mcp-fidelity-status-only
---

# MCP Fidelity for Read-Style CLI Commands

## Summary

`infra mcp` exposes 19 CLI tools today; every one returns empty `content` because actions write to global `console.log` and the `Bun.spawn({stdout: 'inherit'})` subprocess flow that `@goke/mcp@0.0.10` cannot capture. This brainstorm scopes a refactor that wires the 10 read-style commands through the goke execution context so MCP returns the same human-readable output that operators see at a terminal, plus an explicit structured-return escape hatch for the two commands that already produce parseable data (`cliproxy_keys_list`, `cliproxy_config_get`). The 9 commands that depend on real-tty I/O, interactive prompts, or destructive policy stay out of MCP by an explicit `commandFilter` allowlist.

---

## Problem Frame

`@goke/mcp@0.0.10` provides a per-action `ctx` argument with capture streams: `ctx.console.log` and `ctx.process.stdout.write` get hoisted into the `CallToolResult.content`, but global `console.log` writes go nowhere (or worse, corrupt the JSON-RPC channel that shares `process.stdout`). Today every action in `packages/cli/src/commands/` writes via the globals, so every MCP tool returns `{"content":[{"type":"text","text":""}]}`.

Two pains compound:

1. **Empty tool responses train agents that the tool surface is broken.** An agent that tries `cliproxy_status` and gets nothing back has no way to know whether the proxy is healthy, whether the call failed silently, or whether the tool is mis-implemented. Either it stops calling these tools (lost capability) or it learns to ignore null responses (lost signal).
2. **9 of the 19 commands cannot be safely captured** (`gateway deploy`, `gateway logs`, `gateway restore`, `cliproxy deploy`, `cliproxy login`, `cliproxy open`, `cliproxy setup`, `keeweb deploy`, `keeweb open`). They spawn subprocesses with `stdout: 'inherit'`, use `@clack/prompts`, wait on TTY input, or perform destructive mutations that should require explicit operator approval. Exposing them as MCP tools — even working tools — is misleading because agents can't invoke them safely or shouldn't be allowed to.

**Why now:** Fro Bot already calls into this CLI via MCP during autohealing (category 5 deploy-pipeline-health checks, see `.github/workflows/fro-bot.yaml`). Each of those `cliproxy_status` / `gateway_status` invocations gets back empty content, so the autohealing report has to fall back to running `gh` queries directly instead of using the proxy/gateway's own health surface. The cost compounds: every new app added to the autohealing surface inherits the same empty-content limitation until this is fixed.

Memory #3191 captured the root cause when this surfaced as a smoke-test gap in `ce:review` run `20260517-225635-143624c4`. Memory #3618 set the gate "design work stays paused until `@goke/mcp` capture behavior is verified" — that gate cleared in this session when the contract was confirmed empirically from `node_modules/.bun/@goke+mcp@0.0.10+a6b6ab9123cdf578/node_modules/@goke/mcp/src/cli-to-mcp.ts`.

---

## Requirements

**Action refactor**

- R1. The 10 read-style commands' action callbacks accept the goke execution context as their last positional argument (`(options, ctx) => ...`) and route all user-facing output directly through `ctx.console.log` / `ctx.console.error` / `ctx.process.stdout.write` / `ctx.process.stderr.write` instead of the global `console` / `process.stdout` / `process.stderr`. Helper signatures (e.g., `formatSummary`, the table-printers, the `OK`/`WARN`/`ERROR` line builders) stay unchanged; actions inline-build captured text via `ctx.console` directly, since helpers return strings or structured objects today and the action already does the print step.
- R2. Process exits driven by failures continue to surface — actions call `ctx.process.exit(code)` (which `@goke/mcp` converts to `GokeProcessExit` and then to an error `CallToolResult`) rather than mutating `process.exitCode` or calling global `process.exit`.
- R3. **Structured-return escape hatch (Mode C exception).** Two commands MAY additionally return raw structured data alongside their captured text output: `cliproxy_keys_list` (returns `{api-keys: string[]}`) and `cliproxy_config_get` (returns the full config object). `@goke/mcp`'s `buildCallToolResult` will emit both blocks — captured human-readable text first, stringified structured value second — when an action both writes to `ctx.console` and returns a non-empty value. The other 8 commands stay text-only.

**Tool surface and filtering**

- R4. `createMcpAction` in `packages/cli/src/commands/mcp.ts` receives an explicit `commandFilter` that admits only the 10 in-scope commands. The filter is a single source-of-truth `Set<string>` in the same module, sized small enough that adding a future capturable command requires one edit. Each cli-only command stays excluded for a stated reason: `gateway deploy` / `cliproxy deploy` / `keeweb deploy` / `gateway logs` use `Bun.spawn({stdout: 'inherit'})` (subprocess streaming, deferred); `cliproxy login` / `cliproxy open` / `cliproxy setup` require a TTY and stdin (interactive, no agent surface); `gateway restore` mutates the live gateway by replacing the mitmproxy CA (destructive policy); `keeweb open` spawns a local browser (host-machine side effect that an agent should not trigger without user intent).

**Test contracts**

- R5. A Tier-1 integration test spawns `bunx infra mcp`, sends a `tools/list` JSON-RPC request, and asserts the returned tool names match the 10-command allowlist exactly (no missing, no extra). The test asserts the `inputSchema` shape for each tool is present (does not assert exact field-by-field shape — that's `@goke/mcp`'s contract).
- R6. Tier-2 unit tests cover each of the 10 refactored actions individually via a **shared `ctx` fixture** that mirrors `@goke/mcp`'s real construction:
  - `ctx.console.log` / `ctx.console.error` capture into arrays
  - `ctx.process.stdout.write` / `ctx.process.stderr.write` capture into arrays
  - `ctx.process.exit(code)` throws an `Error` tagged with the exit code (so tests can assert exit behavior without killing the test runner)
  - Each action is invoked with a stubbed system surface (mocked `fetch` for HTTP, spied `Bun.spawn` for SSH, etc.) and tested for: (a) **captured output is non-empty** on success path, (b) **captured output references contract markers** for the command — e.g., `cliproxy_status` captured text contains the version field, `gateway_backup` captured text contains the output path and byte count, `cliproxy_keys_list` captured text contains every key from the mocked API response, (c) **failures throw via `ctx.process.exit`** with the correct exit code and the captured error stream contains the failure reason.
- R7. The existing 451-test baseline continues to pass after the refactor with no test deletions. Existing action-level tests that use `spyOn(console, 'log')` (e.g., `packages/cli/src/commands/status.test.ts`) MUST be migrated to use the new shared `ctx` fixture rather than global `console` spies — otherwise they will silently no-op once actions route through `ctx.console`. Any test that cannot be migrated must be replaced by a stronger assertion in the `droplet-helpers.test.ts` style, not deleted to bypass a failure.

**Out-of-scope guarantees**

- R8. `bunx infra mcp` lists exactly 10 tools. When an agent calls `tools/list` on the running MCP server, the cli-only commands MUST NOT appear in the result.

---

## Acceptance Examples

- AE1. **Covers R4, R8.** Given `infra mcp` is running, when an agent sends `{"method": "tools/list"}`, the response `tools` array contains exactly 10 entries whose names are: `gateway_status`, `gateway_backup`, `cliproxy_status`, `keeweb_status`, `status`, `cliproxy_keys_list`, `cliproxy_keys_add`, `cliproxy_keys_remove`, `cliproxy_config_get`, `cliproxy_config_set`. None of `gateway_deploy`, `gateway_logs`, `gateway_restore`, `cliproxy_deploy`, `cliproxy_login`, `cliproxy_open`, `cliproxy_setup`, `keeweb_deploy`, `keeweb_open` appear.
- AE2. **Covers R1, R6.** Given an agent calls `tools/call` with name `cliproxy_status` against the running MCP server and a reachable proxy, the response is a non-error `CallToolResult` whose `content[0].text` contains the same formatted summary string a human sees at `bunx infra cliproxy status` (HTTP status line, usage stats line, version line).
- AE3. **Covers R2.** Given an agent calls `tools/call` with name `cliproxy_keys_remove` and a value that doesn't match any registered key, the action calls `ctx.process.exit(1)` and `@goke/mcp` returns a `CallToolResult` with `isError: true` and `content` containing the captured error text.
- AE4. **Covers R3.** Given an agent calls `tools/call` with name `cliproxy_keys_list` against the running MCP server with a reachable proxy that has 3 registered keys, the response `content` array contains two text blocks: the first is the formatted table operators see at `bunx infra cliproxy keys list`, the second is the stringified raw response `{"api-keys": ["key1", "key2", "key3"]}` parsable as JSON by the agent.
- AE5. **Covers R2, R6.** Given an agent calls `tools/call` with name `gateway_status` against a running MCP server but the gateway droplet is unreachable (SSH connection refused), the action calls `ctx.process.exit(1)` with the SSH failure reason in the captured stderr stream, and `@goke/mcp` returns `CallToolResult` with `isError: true` containing the captured failure text.

---

## Success Criteria

- After the refactor, an agent invoking `tools/list` followed by `tools/call gateway_status` sees the same actionable output (service states, healthy/degraded summary, footer) that an operator sees at the terminal — verified by hand against a live droplet at least once and by AE2 in CI on every change.
- The 9 cli-only commands stay out of the MCP tool list permanently. Adding a new command that uses `Bun.spawn({stdout: 'inherit'})` does not silently leak into MCP — the explicit allowlist forces a deliberate registration step (per R4).
- An agent calling `cliproxy_keys_list` or `cliproxy_config_get` gets BOTH a formatted human-readable rendering AND a parseable JSON block in the same response, removing the need to re-parse formatted tables (per R3).
- A downstream planner reading this doc and the existing `apps/*/AGENTS.md` files can implement the refactor without needing to invent product behavior. The only judgment calls left for planning are: which file path holds the allowlist, what stub shape the shared Tier-2 ctx fixture uses, whether the Mode C structured-return exception applies anywhere beyond the two commands listed in R3.

---

## Scope Boundaries

- **Subprocess streaming refactor is out of scope.** `gateway deploy`, `cliproxy deploy`, `keeweb deploy`, and `gateway logs` use `Bun.spawn({stdout: 'inherit'})` to give operators live progress. Capturing their output for MCP would require buffering subprocess streams and emitting them after completion, which loses live progress at the human CLI unless we also implement a dual-mode write-fanout. That tradeoff deserves its own brainstorm.
- **Interactive commands are out of scope.** `cliproxy login` (OAuth callback URL paste), `cliproxy open` (SSH TUI), `cliproxy setup` (`@clack/prompts` wizard) all require a TTY and stdin input. Exposing them via MCP would mislead agents into trying to call them.
- **Destructive commands are out of scope.** `gateway restore` mutates the live gateway by replacing the mitmproxy CA; an MCP-callable restore would let an agent corrupt production without operator approval. Stays cli-only by policy, not just by capture-incompatibility.
- **The `gateway backup` write-to-disk side effect is in scope.** It writes a tarball to a local path the caller provided. An agent invoking it must pass `--output`; the action validates the path and returns a structured success/failure. This is the lone "filesystem write" tool in v1 — including it tests the contract for write-tools in v2.
- **No new MCP discovery resource for the cli-only commands.** Considered ("Hybrid: exclude + emit a discovery resource") and rejected because `createMcpAction` doesn't expose hooks to register additional request handlers. Dropping `createMcpAction` to own the lower-level Server construction is ~50 LOC and forward-compat cost not worth paying for v1. Discovery stays in `bunx infra --help` and the per-app `AGENTS.md` files.
- **No fundamental contract changes to `@goke/mcp`.** The integration uses the published `0.0.10` shape: `createMcpAction({cli, commandFilter})`. If upstream evolves the contract, this brainstorm's design is renegotiated, not extended.
- **No MCP authentication or capability negotiation.** v1 is stdio transport, default capabilities. Adding HTTP transport, OAuth, or per-tool permission gating is a separate brainstorm.

---

## Key Decisions

- **Mode A (`ctx.console` capture) as the default, with Mode C (mixed text + structured return) as an explicit exception for `cliproxy_keys_list` and `cliproxy_config_get`.** Default text-only keeps the per-command diff small and uniform; the two-command Mode C exception unblocks agents from regex-parsing formatted tables when they could read raw JSON instead. `@goke/mcp`'s `buildCallToolResult` already concatenates captured streams with a stringified return when both are present, so the exception costs zero new framework code.
- **Pattern A (`ctx` flows via callback parameter) over Pattern B (global console shim middleware) or Pattern C (`withCtx` HOF wrapper).** Per memory #3766 ("no module-load side effects") and the general repo discipline of explicit-over-clever, threading `ctx` as a callback argument is testable, traceable, and impossible to accidentally short-circuit.
- **Inline `ctx.console` calls in actions, no helper API change.** Earlier draft proposed an optional `output` parameter on every formatter helper for dual CLI/MCP routing. Three reviewers flagged that as ceremony for a one-time mechanical refactor. Helpers stay unchanged; actions inline their `ctx.console.log(formatSummary(result))` calls directly. If a future deploy-streaming refactor needs the helper indirection, add it then.
- **`commandFilter` Set with stated exclusion rationale, no discovery resource.** `createMcpAction` has no Server hook; the cli-only-but-listed alternative needs ~50 LOC of MCP server boilerplate. Defer until v2 if agents demonstrably need it. R4 captures the rationale for each excluded command inline so the allowlist isn't a magic incantation.
- **v1 is deliberately a read-only diagnostic surface.** Three reviewers (product-lens, adversarial × 2) challenged the read-only framing as a strategic limitation. Confirmed deliberate: the path to full agent autonomy goes through (a) subprocess-streaming refactor for deploys, (b) authentication/approval gating for mutating tools. Both are explicit v2 work. v1 ships the observability cut because Fro Bot autohealing already calls these tools and is currently getting empty content.
- **Tier 1 + Tier 2 test bar with a shared `ctx` fixture.** Tier 1 catches "allowlist drift". Tier 2 catches "silent regression" AND "output correctness" via contract markers (e.g., `cliproxy_status` captured text must contain the version line). The shared fixture mirrors `@goke/mcp`'s real `createCallToolExecutionContext` shape so tests don't drift from production capture behavior.

---

## Dependencies / Assumptions

- **`@goke/mcp@0.0.10` capture contract verified.** Action receives `ctx` as last arg; `ctx.console.log` / `ctx.process.stdout.write` get captured into a text block; return-value `{content: [...]}` is honored as a manual escape hatch; non-`{content}` return values get stringified and appended as a trailing text block; `ctx.process.exit(code)` produces an error `CallToolResult` via `GokeProcessExit`. Source: `node_modules/.bun/@goke+mcp@0.0.10+a6b6ab9123cdf578/node_modules/@goke/mcp/src/cli-to-mcp.ts` lines 245-365, 458, 649-686.
- **Version pinned to `@goke/mcp@0.0.10`.** Any bump (including a 0.0.11 patch) requires re-validation of the capture contract before merging. The action signature, `ctx` shape, `buildCallToolResult` precedence rules, and `GokeProcessExit` translation are all upstream contracts that the design depends on; a quiet contract change would silently break R3, R6, and AE2-AE5. The package.json range MUST be tightened to `~0.0.10` (patch-only) rather than the current `^0.0.10` (minor-permissive), and the Tier-1 integration test must run before any goke/mcp bump lands on main.
- `goke@6.8.0` does not merge global CLI options into subcommand action types (memory #399). Each refactored action declares its own options via `.option()`. No change to that contract here.
- The 5 always-on conventions in repo: TypeScript-only (no new bash), no `as any` / `@ts-ignore`, no `bundledDependencies`, ESLint clean, tsc clean.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] Should the allowlist be a typed `readonly tuple` of command names exported from `mcp.ts`, or a `Set<string>` literal? Type-level guarantees vs runtime flexibility. R4 specifies `Set<string>` but the readonly-tuple form would give TypeScript checking when a new command name is added.
- [Affects R5][Technical] Can the Tier-1 integration test invoke `tools/list` via the `@modelcontextprotocol/sdk` client directly inside Bun (in-process transport), or does it need to spawn a subprocess and pipe JSON-RPC manually? The in-process form is faster + easier to maintain if Bun supports the SDK's transport abstraction.
- [Affects R6][Needs research] Where should the shared `ctx` fixture live? Two candidates: (a) `packages/cli/src/__test__/mcp-ctx-fixture.ts` exported as a shared helper, (b) inside each command's test file but factored as a local helper module. The former is DRYer if more than 3 command tests use it; the latter avoids a new module if only a few use it.
- [Affects R8][Technical] Naming of the unified `status` command in MCP — does `@goke/mcp`'s default `sanitizeToolName` translate `status` (single word, no subcommand prefix) to a tool name that doesn't collide with the per-app statuses (`gateway_status`, `cliproxy_status`, `keeweb_status`)? Verify against the empirical `tools/list` output before locking AE1's exact name list — if collisions exist, supply a custom `sanitizeToolName` in `mcp.ts`.
- [Affects R3][Technical] How to extend the Mode C exception cleanly if a third command needs the structured-return shape later? R3 lists two commands by name; a future command would need a documented criterion for inclusion. Capture criterion in the implementation comment so future maintainers don't have to re-derive it.
