# @marcusrbrown/infra CLI

Published to npm as [`@marcusrbrown/infra`](https://www.npmjs.com/package/@marcusrbrown/infra). Run via `bunx @marcusrbrown/infra`. Built with [goke](https://github.com/remorses/goke) + Zod. Exposes commands as MCP tools via `@goke/mcp` (see `.agents/skills/goke/SKILL.md`).

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add keeweb command | `src/commands/keeweb/<name>.ts` | Export `register<Name>(cli)`, add to keeweb/index.ts barrel |
| Add cliproxy command | `src/commands/cliproxy/<name>.ts` | Export `register<Name>(cli)`, add to cliproxy/index.ts barrel |
| Add standalone command | `src/commands/<name>.ts` | Export `register<Name>(cli)`, import directly in cli.ts |
| Modify CLI skeleton | `src/cli.ts` | Barrel imports + standalone commands, parse pattern |
| Onboard new repo | `bunx @marcusrbrown/infra cliproxy setup` | Interactive wizard or `--key --repo --harness` flags |
| CLI tests | `src/cli.test.ts` | Snapshots in `src/__snapshots__/` |
| Command tests | `src/commands/<app>/<name>.test.ts` | Colocated alongside each command |

## COMMAND PATTERN

Commands are organized by app in `src/commands/<app>/<action>.ts`. Each barrel (`index.ts`) exports a single `register<App>Commands(cli)` function. Standalone commands sit at `src/commands/` root.

```text
src/commands/
├── keeweb/
│   ├── index.ts      → registerKeewebCommands(cli)
│   ├── status.ts     → registerKeewebStatus(cli)
│   ├── deploy.ts     → registerKeewebDeploy(cli)
│   └── open.ts       → registerKeewebOpen(cli)
├── cliproxy/
│   ├── index.ts      → registerCliproxyCommands(cli)
│   ├── status.ts     → registerCliproxyStatus(cli)
│   ├── deploy.ts     → registerCliproxyDeploy(cli)
│   ├── config.ts     → registerCliproxyConfig(cli)
│   ├── keys.ts       → registerCliproxyKeys(cli)
│   ├── login.ts      → registerCliproxyLogin(cli)
│   ├── open.ts       → registerCliproxyOpen(cli)
│   └── setup.ts      → registerCliproxySetup(cli)  (uses @clack/prompts)
├── status.ts         → registerStatus(cli)  (top-level unified dashboard)
└── mcp.ts            → registerMcp(cli)
```

Space-separated subcommands: `cli.command('keeweb status', '...')`. Zod schemas for typed options. Global `--verbose` accessible in all command actions.

## CONVENTIONS

- `import type` for goke type imports — `import type {goke} from 'goke'`
- Async actions: `cli.parse(process.argv, {run: false})` + `await cli.runMatchedCommand()` with try/catch
- Shell out to `gh` CLI for GitHub API (not octokit) — `Bun.spawn(['gh', ...])`
- Parse `gh` JSON output through Zod schemas before use
- SHA-256 via `Bun.CryptoHasher('sha256')`, not crypto module
- Resolve paths with `import.meta.dir` + `path.resolve()` — validate existence before use
- **Management API**: Commands use local helpers for authenticated JSON requests. Auth header is `x-management-key` (not `Authorization: Bearer`). Helpers are per-file local (exception: `cliproxy/shared.ts` may consolidate common helpers if duplication across 4+ files becomes painful — but only within the cliproxy group, never cross-app).
- **`@clack/prompts`**: Scoped to `cliproxy setup` only. All other commands remain non-interactive for CI/script compatibility. Import `intro`, `outro`, `text`, `select`, `confirm`, `spinner`, `note`, `isCancel`, `cancel` from `@clack/prompts`. Every prompt result MUST be checked with `isCancel()` — `cancel()` + `process.exit(0)` on cancellation. Other commands needing operator-facing notices (e.g., `cliproxy login codex`'s anti-phishing reminder) emit plain `console.log` blocks — keeps the CI/script-safe surface uniform.
- **`cliproxy login codex`**: Supported providers are `claude` and `codex`, derived from a single `PROVIDER_FLAGS` constant. Codex uses the device-code flow (`--codex-device-login`); the browser-OAuth callback can't traverse SSH without port forwarding. Before establishing SSH for the codex provider, the action prints an anti-phishing notice instructing the operator to verify the device-code URL points to `openai.com`. Provider validation uses `Object.prototype.hasOwnProperty.call()` to reject prototype-chain keys (`__proto__`, `constructor`, `hasOwnProperty`). Login remains excluded from the MCP allowlist (interactive OAuth + TTY requirement).
- **Packaging**: Published package ships TypeScript source with `#!/usr/bin/env bun` shebang, requires `engines.bun >= 1.0.0`.
- **`--dry-run` semantics**: Prints the planned action without validating preconditions or executing side effects. Safe to run anywhere.
- **`--force-config` (cliproxy deploy)**: Override the safe default that skips uploading `config.yaml` when it exists on the server. Wipes runtime API keys — print a WARNING when set.
- **`--output <file>` (cliproxy config get)**: Write JSON to a file with `0600` perms instead of stdout. Wraps `Bun.write` + `chmod` in try/catch.
- **Fire-and-forget opens**: `keeweb open` and `cliproxy open` spawn the child process without awaiting `child.exited` — prevents blocking on Linux `xdg-open` or long-lived SSH sessions. Close stdin immediately after spawn.
- **Stdin piping for secrets**: When `cliproxy setup` passes an API key to `gh secret set`, use `Bun.spawn` stdin pipe instead of `--body` CLI arg. The key never appears in `ps` output.
- **Compensating delete**: `cliproxy setup` wraps key creation in try/catch. On failure after a key was created, best-effort `DELETE /v0/management/api-keys?value=<key>` to avoid phantom keys. Error messages scrub key material.
- **Tests**: colocated `*.test.ts`. Snapshots in `src/__snapshots__/`. Use `NO_COLOR=1` in subprocess env for deterministic output. Mock `fetch` and `Bun.spawn` at the boundary. Never spawn the real CLI for commands that launch browser (`keeweb open`) or SSH (`cliproxy open`) — test exported helpers and `--help` output only.

## MCP FIDELITY

The MCP server (`mcp.ts`) exposes a curated subset of commands as MCP tools via `@goke/mcp`. Two rules govern that surface and how actions must be written to participate in it.

**Allowlist authority (`src/commands/mcp.ts`).** The `MCP_ALLOWLIST` `Set` in `mcp.ts` is the **single source of truth** for which commands appear as MCP tools. Every excluded command has a one-line reason in the JSDoc block above the allowlist (subprocess streaming → deferred to MCP v2 #291, interactive TTY requirement, destructive policy → deferred to #292, host-machine side effect). Adding a new MCP-capturable command means adding its name to the `Set` and confirming the action threads `ctx`; adding a CLI-only command means leaving the allowlist alone and documenting the exclusion reason in the JSDoc.

**Ctx threading for capturable commands.** Each command in the allowlist receives goke's per-action execution context as the last positional argument and **must** route every byte of output through `ctx`:

- `console.log(...)` → `ctx.console.log(...)`
- `console.error(...)` → `ctx.console.error(...)`
- `process.stdout.write(...)` → `ctx.process.stdout.write(...)`
- `process.stderr.write(...)` → `ctx.process.stderr.write(...)`
- `process.exit(code)` → `ctx.process.exit(code)`

Use the shared `ActionCtx` type from `src/lib/action-ctx.ts` — a structural subtype of `GokeExecutionContext` that captures exactly the surface actions consume. `createCapturedCtx()`, `expectCapturedToInclude()`, and `MockProcessExit` remain in `src/__test__/mcp-ctx-fixture.ts` for test use only. Action bodies are exported as named functions (e.g., `gatewayStatusAction`, `cliproxyKeysListAction`) and the `.action(...)` callback delegates to them, so Tier-2 tests invoke actions directly with `createCapturedCtx()`.

**Mode C (structured-return commands).** Two commands return structured data alongside ctx-printed text so MCP consumers get both formatted output AND parseable JSON in the `CallToolResult`:

- `cliproxy keys list` returns the parsed API-key array
- `cliproxy config get` returns the parsed config object (the `--output` path still returns the object even when also writing to disk)

Return values are plain data (arrays, objects) — never `{content: [...]}` shapes. `@goke/mcp` stringifies them and emits one text block per data plus one per captured stream. Extending Mode C: a command qualifies only if it wraps a single management-API call returning structured data the agent will likely parse (mutations and complex orchestrations stay Mode A — text only). When in doubt, leave it Mode A; opening Mode C creates a contract MCP consumers may come to depend on.

**Failure-path parity for capturable actions.** Every allowlisted action must catch its expected operational failures (missing env vars, HTTP non-2xx, JSON parse errors, unsupported config fields) and write the reason to `ctx.console.error` before `ctx.process.exit(1)`. Do not rely on thrown exceptions for MCP-visible content — @goke/mcp may surface the exception text in the CallToolResult, but the format isn't guaranteed and operators looking at captured.stderr see nothing useful. Wrap the action body in try/catch when adding a new capturable command.

**Mode C eligibility is data-shape based, not transport-source based.** A command qualifies for Mode C when it produces bounded structured data the agent will parse, regardless of whether the data comes from a management API, an SSH command, a local file read, or a docker query. `cliproxy keys list` (management API) and `gateway status` (SSH + docker compose ps) are both candidates by this rule. The criterion that matters: would re-parsing the formatted text be lossy or fragile? If yes, return the structured form alongside the text.

**Mutating tools must verify the mutation.** When an MCP tool changes state (e.g., `cliproxy keys add`, `cliproxy keys remove`, `cliproxy config set`), the action must verify the mutation succeeded before reporting success via ctx. For `keys remove`, this means confirming the key existed before the DELETE; for `keys add`, confirming the management API echoed the new key in the response or in a follow-up list call. Returning the raw API response without verification means MCP can report success on a no-op deletion or a silently-failed add.

**Tier-1 + Tier-2 test bar.** Every MCP-capturable command has Tier-2 unit tests using `createCapturedCtx()` to verify output flows through ctx, plus one Tier-1 integration test in `commands/mcp.test.ts` that spins up the real `@goke/mcp` server via `InMemoryTransport` and asserts the tool surface matches `MCP_ALLOWLIST`. The Tier-1 test re-derives the expected tool names from a list of strings rather than importing `MCP_ALLOWLIST`, so allowlist drift surfaces as a test failure.

**`@goke/mcp` upgrade discipline.** This package is pre-1.0; semver does not apply. Bumping `@goke/mcp` is a **manual-review** change — never automerge. Confirm before merging:

1. `mcp.ts` still compiles against the new `createMcpAction` signature.
2. The Tier-1 integration test still spins up the in-process MCP server (no API breakage on `commandFilter`, `createTransport`, or the action ctx shape).
3. The full test suite passes (`bun test --recursive`).

A future `@goke/mcp` may rename `commandFilter`, change ctx's shape, or break `InMemoryTransport` injection — all three are observable failures the test suite catches, but only if the upgrade ran through CI before merge.

## ANTI-PATTERNS

- Never use `bundledDependencies` — Bun's `.bun/` symlinks create `../../` paths that npm rejects with E415.
- Never assume CLIProxyAPI body format — test empirically against the live API (e.g., `api-keys` PUT expects bare array, not wrapped object).
- Never use `BatchMode=yes` without `-tt` when stdin forwarding is needed (login command).
- Never inherit full parent env when spawning `deploy.sh` — use explicit env allowlist.
- Never check for `DEPLOY_SSH_KEY` env var for local deploy — check `SSH_AUTH_SOCK`.
- Never add `GITHUB_TOKEN` raw fetch fallback — require `gh` CLI.
- Never use `Authorization: Bearer` for cliproxy management endpoints — that header is for client API key auth, not management.
