---
title: "feat: CLI zhuzh — structure, interactivity, and management polish"
type: feat
status: completed
date: 2026-04-12
origin: docs/brainstorms/2026-04-07-cli-zhuzh-requirements.md
deepened: 2026-04-12
---

# feat: CLI zhuzh — structure, interactivity, and management polish

## Overview

Restructure the CLI from flat `<app>-<action>.ts` to `<app>/<action>.ts` directory convention, add interactive onboarding wizard via `@clack/prompts`, unified status dashboard, browser/TUI launchers, and polished management output. No goke API changes — all commands remain space-separated.

## Problem Frame

The `@marcusrbrown/infra` CLI grew to 8 commands across 2 apps but uses a flat file layout, outputs raw JSON in several places, has no interactive flows, and lacks a unified health view. Onboarding a new repo to CLIProxyAPI requires 4+ manual commands with copy-paste. The CLI works but doesn't feel polished or self-documenting. (see origin: docs/brainstorms/2026-04-07-cli-zhuzh-requirements.md)

## Requirements Trace

- R1. Reorganize `src/commands/` from flat `<app>-<action>.ts` to `<app>/<action>.ts` with barrel `index.ts`
- R2. Each barrel exports `register<App>Commands(cli)` function
- R3. `cli.ts` imports only barrels + standalone commands (`status`, `mcp`)
- R4. Test files colocate with source (move into subdirectories)
- R5. goke space-separated subcommands unchanged — restructure is organizational only
- R6. Top-level `status` runs all app health checks in parallel
- R7. Unified table: app, HTTP status, last deploy, version, content hash, usage stats
- R8. Graceful degradation — failed check shows error for that row, continues
- R9. `--json` flag for machine-readable output
- R10. `cliproxy setup` using `@clack/prompts` for interactive onboarding
- R11. Wizard: verify proxy → add key → select harness → select repo → set secrets → verify
- R12. `@clack/prompts` spinner and styled output per step
- R13. `--key` flag to supply an existing API key value (skips key creation)
- R14. `--repo` flag to skip repo selection
- R15. Non-interactive fallback: require all flags when stdin is not TTY
- R16. `keeweb open` opens `https://kw.igg.ms/` in default browser
- R17. `cliproxy open` launches CLIProxyAPI TUI via SSH
- R18. TTY guard for `cliproxy open` (same pattern as `cliproxy login`)
- R19. SSH command: `ssh -tt -o BatchMode=yes root@<host> 'cd /opt/cliproxy && docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --tui'` (BatchMode=yes matches existing SSH convention; `-tt` forces TTY allocation for interactive passthrough)
- R20. `cliproxy keys list` outputs human-readable numbered list by default; `--json` for raw
- R21. `cliproxy config get` outputs human-readable key-value format by default; `--json` for raw
- R22. `cliproxy status` includes usage summary inline

## Scope Boundaries

- No goke API changes — space-separated subcommands stay (see origin)
- No web dashboard deployment — TUI via SSH is sufficient (see origin)
- No new apps — only keeweb and cliproxy
- `@clack/prompts` does not replace goke arg parsing — layers on top for interactive flows only
- `keys add` stays simple — onboarding logic lives in `cliproxy setup`
- No key rotation mechanism (deferred)
- No config backup/restore commands beyond existing `config get --output`

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/cli.ts` — entry point, imports 8 `register*` functions, `createMcpAction({cli})` for MCP bridge
- `packages/cli/src/commands/cliproxy-config.ts` — `resolveManagementKey()`, `requestJson()`, `managementHeaders()`, `buildSetRequest()`, `parseBoolean()`, `parseNumber()`
- `packages/cli/src/commands/cliproxy-login.ts` — `resolveHost()`, `requireSshAuthSock()`, `process.stdin.isTTY` guard pattern
- `packages/cli/src/commands/cliproxy-keys.ts` — `toStringArray()`, duplicated `requestJson`/`managementHeaders`
- `packages/cli/src/commands/keeweb-status.ts` — `hashSha256()`, `checkHttpReachability()`, `checkLastDeploy()`, `checkContentHash()`
- `packages/cli/src/commands/cliproxy-status.ts` — `checkHttpReachability()`, `checkUsageStats()`, `checkVersion()`
- `packages/cli/src/commands/mcp.ts` — `createMcpAction` wraps entire CLI for MCP tool exposure
- `packages/cli/src/cli.test.ts` — snapshot test for help output; `__snapshots__/cli.test.ts.snap`
- `/Users/mrbrown/src/github.com/bfra-me/works/packages/create/` — reference `@clack/prompts` wizard implementation with `withSpinner`, cancellation patterns, non-TTY guard

### Institutional Learnings

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — never guess management API body formats; use `x-management-key` header (not Bearer) for management endpoints
- `docs/solutions/workflow-issues/bun-deploy-user-permissions-ci-2026-04-02.md` — CI install: `--frozen-lockfile --ignore-scripts`
- `packages/cli/AGENTS.md` — `--dry-run` is CLI-level precondition check only; management endpoints use `x-management-key`; helpers are per-file local, not shared module
- `.agents/skills/goke/SKILL.md` — `parse(false)` + `runMatchedCommand()` pattern; test via `Bun.spawn` with `NO_COLOR=1`; MCP via `createMcpAction`

### External References

- `@clack/prompts` v1.2.0 API — `intro`, `outro`, `text`, `select`, `confirm`, `spinner`, `note`, `log`, `isCancel`, `cancel`, `isTTY`, `isCI`. Bun compat: all stdin issues fixed in Bun 1.3.3+ (bun#24615, bun#4835, bun#3099, clack#170)
- `@bfra-me/create` — multi-step wizard with `withSpinner` helper, `isCancel` guards, confirmation via `note()` + `confirm()`. Runs under Bun (ESM, `bunx` supported)
- `gh secret set` / `gh variable set` — require `repo` scope token + collaborator (push) access. `--repo` flag works for non-owned repos. No admin required for repo-level secrets/variables.

## Key Technical Decisions

- **Cliproxy-local shared utility module only**: Per `packages/cli/AGENTS.md` convention, helpers are per-file local. Exception: `requestJson`/`managementHeaders`/`resolveManagementKey`/`resolveHost` are duplicated across 4+ cliproxy command files and will consolidate into `cliproxy/shared.ts` as a cliproxy-internal leaf module (no cross-app sharing, no circular imports). `resolveHost` stays with SSH/TUI commands if it's only used there. Update `packages/cli/AGENTS.md` to document this exception.
- **Manual table formatting**: No `cli-table3` or similar. `console.log` with fixed-width padding for 2-app × 6-column status table (App, HTTP, Last Deploy, Version, Content Hash, Usage Stats). Avoids dependency sprawl for trivial layout.
- **`@clack/prompts` scoped to `cliproxy setup` only**: All other commands remain non-interactive. `@clack/prompts` is a direct dependency of `packages/cli/`, not the workspace root.
- **Platform-aware browser open**: `open` on macOS, `xdg-open` on Linux. No Windows support (user runs macOS; CI is Linux).
- **Harness secret templates**: Hardcoded per-harness secret maps in the setup command. OpenCode, Claude Code, and generic harnesses each have known secret names. Adding new harnesses is a code change, not config.
- **Snapshot regeneration**: Help text snapshot (`cli.test.ts.snap`) regenerated in each unit that changes the help output (adds/removes/renames commands). Unit 1 (restructure) likely doesn't change help text. Units 2, 3, 4, 6 each add commands and must regenerate. Individual command tests don't have snapshots — they test exported functions directly.

## Open Questions

### Resolved During Planning

- **Table formatting library**: No library needed. Manual `console.log` + padding. Existing status commands already use this pattern.
- **TUI launch command**: Verified — `ssh -tt root@<host> 'cd /opt/cliproxy && docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --tui'`. Same TTY guard as login.
- **Snapshot migration**: Snapshot captures CLI help text, not file paths. Moving files doesn't change help output. Regenerate only if new commands change help text.
- **Harness secrets**: OpenCode needs `OPENCODE_AUTH_JSON`, `OPENCODE_CONFIG`, `OMO_PROVIDERS` (secrets) + `FRO_BOT_MODEL` (variable). Claude Code needs `ANTHROPIC_API_KEY` (env var or secret). Generic: key + base URL as user-specified env vars.
- **Non-TTY `@clack/prompts` behavior**: Prompts return cancel symbol immediately when stdin is not a TTY. Guard with `isTTY(process.stdout)` or `process.stdin.isTTY` before entering wizard flow.

### Deferred to Implementation

- **Exact `withSpinner` helper shape**: Pattern clear from `@bfra-me/create`; exact error message wording depends on implementation.
- **`gh secret set` vs `gh variable set`**: OpenCode uses `FRO_BOT_MODEL` as a variable, rest as secrets. Implementation needs `gh secret set` for secrets and `gh variable set` for variables.
- **`cliproxy setup` step ordering refinement**: Steps are defined; exact prompt wording and validation logic emerge during implementation.

## Implementation Units

### Phase 1: Structure (must complete before Phase 2)

- [ ] **Unit 1: File restructure + shared cliproxy utilities**

**Goal:** Move flat `<app>-<action>.ts` layout to `<app>/<action>.ts` with barrels. Extract duplicated cliproxy helpers to a cliproxy-local leaf module. Audit and update all `import.meta.dir` relative paths that change depth after the move.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:**
- Create: `packages/cli/src/commands/keeweb/index.ts` (barrel)
- Create: `packages/cli/src/commands/cliproxy/index.ts` (barrel)
- Create: `packages/cli/src/commands/cliproxy/shared.ts` (consolidated `requestJson`, `managementHeaders`, `resolveManagementKey`, `resolveHost`)
- Move: `keeweb-status.ts` → `keeweb/status.ts`, `keeweb-deploy.ts` → `keeweb/deploy.ts`
- Move: `cliproxy-status.ts` → `cliproxy/status.ts`, `cliproxy-deploy.ts` → `cliproxy/deploy.ts`, `cliproxy-config.ts` → `cliproxy/config.ts`, `cliproxy-keys.ts` → `cliproxy/keys.ts`, `cliproxy-login.ts` → `cliproxy/login.ts`
- Move: All colocated test files alongside their new source locations
- Modify: `packages/cli/src/cli.ts` — replace 8 individual imports with 2 barrel imports + standalone `status` and `mcp`
- Test: All existing test files in their new locations

**Approach:**
- Each barrel (`keeweb/index.ts`, `cliproxy/index.ts`) exports a single `register<App>Commands(cli)` that calls individual register functions
- `requestJson`, `managementHeaders`, `resolveManagementKey`, `resolveHost` move to `cliproxy/shared.ts` with named exports. Update all cliproxy command imports.
- Audit all 5 `import.meta.dir` relative path constants that change depth:
  - `cliproxy-deploy.ts`: 2 paths (`../../../../apps/cliproxy/src/deploy.ts` and `../../../apps/cliproxy/src/deploy.ts`)
  - `keeweb-deploy.ts`: 3 paths (`../../../apps/keeweb/deploy.sh`, `../../../../apps/keeweb/deploy.sh`, `../../../../apps/keeweb/dist/index.html`)
  - Each gains one `../` level when moving from `commands/` to `commands/<app>/`
  - Verify all paths resolve correctly in unit tests after the move
- `mcp.ts` stays at `commands/mcp.ts` (standalone, not app-grouped)
- Delete old flat files after moves

**Patterns to follow:**
- goke skill: `parse(false)` + `runMatchedCommand()` in register functions
- Existing import pattern in `cli.ts`

**Test scenarios:**
- `bun test --recursive` passes with zero changes to test logic (only import paths change)
- `infra --help` output identical before and after (snapshot comparison)
- `infra mcp` still starts MCP server (createMcpAction wraps restructured CLI)
- Each command's `--help` output unchanged
- Shared utility exports resolve correctly from new paths

**Verification:**
- All 104+ existing tests pass
- CLI help snapshot matches (or regenerate if new commands added simultaneously)
- `infra mcp` starts and exposes all tools
- No `cliproxy-*.ts` or `keeweb-*.ts` files remain in `commands/` root (all moved to subdirectories)

---

### Phase 2: Features (mostly independent; Unit 6 depends on Unit 1 only)

- [ ] **Unit 2: `keeweb open` command**

**Goal:** Add `keeweb open` to launch `https://kw.igg.ms/` in the default browser.

**Requirements:** R16

**Dependencies:** Unit 1

**Files:**
- Create: `packages/cli/src/commands/keeweb/open.ts`
- Modify: `packages/cli/src/commands/keeweb/index.ts` (add registration)
- Test: `packages/cli/src/commands/keeweb/open.test.ts`

**Approach:**
- Use `Bun.spawn` with `open` (macOS, detected via `process.platform === 'darwin'`) or `xdg-open` (Linux)
- Print URL to stdout before opening (useful in headless/CI where browser won't open)
- Non-zero exit if spawn fails
- If `open`/`xdg-open` is not found (`Bun.which` returns null): print URL, explain no browser launcher available, instruct user to open manually. Do not error — printing the URL is the primary purpose.

**Patterns to follow:**
- `keeweb/deploy.ts` for `Bun.spawn` usage

**Test scenarios:**
- Correct platform command selected (`open` vs `xdg-open`)
- URL printed to stdout before launch
- Spawn failure produces non-zero exit

**Verification:**
- `infra keeweb open --help` shows command
- `infra keeweb open` opens browser on macOS

---

- [ ] **Unit 3: `cliproxy open` TUI command**

**Goal:** Launch CLIProxyAPI's built-in TUI dashboard via SSH.

**Requirements:** R17, R18, R19

**Dependencies:** Unit 1

**Files:**
- Create: `packages/cli/src/commands/cliproxy/open.ts`
- Modify: `packages/cli/src/commands/cliproxy/index.ts` (add registration)
- Test: `packages/cli/src/commands/cliproxy/open.test.ts`

**Approach:**
- TTY guard: `process.stdin.isTTY` check before SSH spawn (same pattern as `login.ts`)
- SSH command: `ssh -tt root@<host> 'cd /opt/cliproxy && docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --tui'`
- Reuse `resolveHost()` from `cliproxy/shared.ts`
- `--host` flag for custom host, falls back to `CLIPROXY_DOMAIN` → `cliproxy.fro.bot`
- `Bun.spawn` with `stdin: 'inherit'`, `stdout: 'inherit'`, `stderr: 'inherit'` for interactive passthrough

**Patterns to follow:**
- `cliproxy/login.ts` — TTY guard, SSH spawn, `resolveHost`, `-tt` flag, `BatchMode=yes`, `stdin: 'inherit'`

**Test scenarios:**
- TTY check: throws when `process.stdin.isTTY` is falsy
- Host resolution: explicit `--host` > `CLIPROXY_DOMAIN` env > default
- SSH command construction: correct flags (`-tt`, `BatchMode=yes`), correct docker compose exec path

**Verification:**
- `infra cliproxy open --help` shows command
- `infra cliproxy open` launches TUI on macOS with SSH agent running

---

- [ ] **Unit 4: Top-level `status` dashboard**

**Goal:** Unified health check across all apps with parallel execution.

**Requirements:** R6, R7, R8, R9

**Dependencies:** Unit 1

**Files:**
- Create: `packages/cli/src/commands/status.ts`
- Modify: `packages/cli/src/cli.ts` (register standalone status command)
- Test: `packages/cli/src/commands/status.test.ts`

**Approach:**
- Each app exports a single `getStatusSummary()` aggregator function from its status module. This avoids name collisions (`checkHttpReachability` and `formatDurationMs` exist in both files with incompatible signatures) and keeps the `CheckResult` type internal (it's a non-exported interface in both files).
- `status.ts` imports `getKeewebStatusSummary()` and `getCliproxyStatusSummary()`, runs both via `Promise.allSettled` — parallel execution, graceful degradation per R8
- Each aggregator returns a typed summary object (`{app, http, lastDeploy, version, contentHash, usageStats}`) with `null` for inapplicable fields
- If management key is missing for cliproxy, management-backed fields (`version`, `usageStats`) show `— (no key)` while HTTP check still runs
- Format as a summary table with explicit R7 columns: `| App | HTTP | Last Deploy | Version | Content Hash | Usage Stats |` — use `—` for fields that don't apply to an app
- `--json` flag outputs structured JSON object with both apps' data
- If one app's checks throw, show `❌ <error message>` in that row and continue
- Target: <5s total (per success criterion)

**Patterns to follow:**
- `keeweb/status.ts` — `checkHttpReachability`, `checkLastDeploy`, `checkContentHash`
- `cliproxy/status.ts` — `checkHttpReachability`, `checkUsageStats`, `checkVersion`

**Test scenarios:**
- Both apps healthy → full table with all fields
- One app unreachable → error row for that app, other app shows normal
- Both apps unreachable → two error rows, still exits 0
- `--json` flag → JSON object with `keeweb` and `cliproxy` keys
- Parallel execution (both checks fire simultaneously, not sequentially)

**Verification:**
- `infra status` completes in <5s
- `infra status --json` outputs valid JSON
- Failed app doesn't crash the command

---

- [ ] **Unit 5: Management output polish**

**Goal:** Human-readable default output for keys list, config get, and status usage stats.

**Requirements:** R20, R21, R22

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/keys.ts`
- Modify: `packages/cli/src/commands/cliproxy/config.ts`
- Modify: `packages/cli/src/commands/cliproxy/status.ts`
- Test: existing test files in `cliproxy/` directory

**Approach:**
- `keys list`: Default output as numbered list (`1. fro-bot-bfra-me-works`). Add `--json` flag for raw JSON array. (R20 reworded from "formatted table" to "numbered list" to match this intent.)
- `config get`: Default output as `key: value` pairs with aligned columns. Existing `--json` for raw. Existing `--output` for file write.
- `status`: Append usage summary line after existing output (`Requests: 1234 total, 5 failed (0.4% failure rate)`).
- All use `console.log` — no table library.

**Patterns to follow:**
- Existing `console.log` formatting in status commands

**Test scenarios:**
- `keys list` default format: numbered list, one per line
- `keys list --json`: raw JSON array
- `config get` default format: `key: value` aligned columns
- `status` includes usage summary line

**Verification:**
- All existing tests still pass
- New output formats verified manually and via test assertions on formatted strings

---

- [ ] **Unit 6: Install `@clack/prompts` + `cliproxy setup` wizard**

**Goal:** Interactive onboarding wizard that takes a new repo from zero to working CLIProxyAPI in one command.

**Requirements:** R10, R11, R12, R13, R14, R15

**Dependencies:** Unit 1

**Files:**
- Create: `packages/cli/src/commands/cliproxy/setup.ts`
- Modify: `packages/cli/src/commands/cliproxy/index.ts` (add registration)
- Modify: `packages/cli/package.json` (add `@clack/prompts` dependency)
- Test: `packages/cli/src/commands/cliproxy/setup.test.ts`

**Approach:**
- Non-TTY guard first: if `!process.stdin.isTTY`, require `--key`, `--repo`, and `--harness` flags, skip prompts entirely. Generic harness is interactive-only (requires prompting for custom secret names).
- Preflight (before any mutation):
  1. Check `gh` is installed (`Bun.which('gh')`) and authenticated (`gh auth status`) — fail fast if missing or unauthenticated
  2. Verify target repo is accessible (`gh repo view --json name`) — fail fast if no write access
- TTY flow (6 functional steps + intro/outro wrappers):
  1. `intro()` → welcome message
  2. Verify proxy reachable: `spinner` + HTTP check to proxy URL. **On failure: abort with actionable error (URL, HTTP status, "is the proxy running?"). No retry in v1.**
  3. API key: If `--key` provided, use that value directly (existing key). Otherwise, `text()` prompt for a new key name → add via management API → return the key value. **Key creation is deferred until after final confirmation (step 6) to avoid orphaned keys on cancel.**
  4. Harness selection: `select()` with OpenCode / Claude Code / Generic options
  5. Target repo: `text()` prompt for `owner/repo`. If `--repo` provided, skip prompt.
  6. Confirmation: `note()` summary of what will be set + `confirm()`. On confirm: create key (if new), then `spinner` + `gh secret set` / `gh variable set` per harness template.
  7. Verify: `spinner` + test request through proxy with the key. **On existing secret collision: warn which names already exist, require confirm before overwriting.**
  8. `outro()` → success message with next-steps hint

- Harness secret templates (hardcoded maps):
  - **OpenCode**: `OPENCODE_AUTH_JSON` (secret, JSON with key), `OPENCODE_CONFIG` (secret, JSON with baseURL), `OMO_PROVIDERS` (secret, provider name), `FRO_BOT_MODEL` (variable, model name)
  - **Claude Code**: `ANTHROPIC_API_KEY` (secret, the CLIProxyAPI key)
  - **Generic**: Prompt for secret name + value pairs

- `isCancel()` check after every prompt — `cancel()` + `process.exit(0)` on cancellation
- `withSpinner` helper for try/catch around async operations

**Patterns to follow:**
- `/Users/mrbrown/src/github.com/bfra-me/works/packages/create/` — multi-step wizard, `isCancel` guards, `note()` for summaries
- `cliproxy/login.ts` — TTY guard pattern
- `cliproxy/keys.ts` — management API key operations

**Test scenarios:**
- Non-TTY mode: missing `--key` throws; missing `--repo` throws; missing `--harness` throws; all three provided → proceeds without prompts
- Non-TTY mode with `--harness generic`: error (generic requires interactive prompts for custom secret names)
- Wizard cancel at each step: `isCancel` triggers clean exit
- Harness secret map: OpenCode produces 3 secrets + 1 variable; Claude Code produces 1 secret; Generic prompts for custom
- `gh secret set` failure: spinner shows error, command exits non-zero
- Proxy verification: key works → success; key rejected → error message
- `--key` flag supplies existing key value, skips creation step
- `--repo` flag skips repo selection step

**Verification:**
- `infra cliproxy setup --help` shows command with `--key`, `--repo`, `--harness` flags
- Interactive: wizard completes all 6 steps, secrets set on target repo
- Non-interactive: `--key sk-test --repo owner/repo --harness opencode` sets secrets without prompts
- Ctrl+C at any prompt exits cleanly (no stack trace)

---

- [ ] **Unit 7: Changeset + snapshot + AGENTS.md**

**Goal:** Ship the release with proper versioning and documentation.

**Requirements:** All

**Dependencies:** All previous units

**Files:**
- Create: `.changeset/<name>.md` (minor bump for `@marcusrbrown/infra`)
- Modify: `packages/cli/src/__snapshots__/cli.test.ts.snap` (regenerated with new commands)
- Modify: `packages/cli/AGENTS.md` (update file structure, add `@clack/prompts` convention, document `cliproxy setup` flow)
- Modify: `packages/cli/README.md` (add `cliproxy setup` as recommended onboarding flow)
- Modify: `AGENTS.md` (root — update WHERE TO LOOK table with `cliproxy setup` entry)

**Approach:**
- Minor version bump (new commands = new features)
- Regenerate snapshot after all commands are registered
- AGENTS.md: update directory layout, add `@clack/prompts` scoping rule, document harness secret templates

**Verification:**
- `changeset status` shows pending minor bump
- Snapshot matches current CLI output
- AGENTS.md accurately reflects new structure

## System-Wide Impact

- **MCP bridge**: `createMcpAction({cli})` wraps the entire CLI. After restructure, all commands — including new ones — are automatically exposed as MCP tools. No MCP-specific work needed.
- **Published package**: `packages/cli/package.json` `files: ["src/"]` captures the new subdirectory structure automatically. No changes to publish config.
- **Import paths**: All imports are package-internal (`./commands/keeweb/index.ts`). No external consumers are affected.
- **Test runner**: `bun test --recursive` finds test files regardless of directory depth. No runner config changes.
- **CI**: No workflow changes needed. Lint, tsc, and test jobs work unchanged.

## Risks & Dependencies

- **`@clack/prompts` adds a new runtime dependency**: Acceptable — well-maintained (18K+ stars). **Bun compatibility verified**: stdin issues (bun#24615, bun#4835, bun#3099, clack#170) all fixed in Bun 1.3.3+. `@bfra-me/create` already uses `@clack/prompts@1.2.0` under Bun successfully. Minimum tested Bun: 1.3.3 (project currently on 1.3.11). No known remaining issues.
- **`gh` CLI availability in `cliproxy setup`**: The wizard calls `gh secret set` and `gh variable set`. **Permission requirement: collaborator (push) access, NOT admin** — `repo` scope token is sufficient for repo-level secrets/variables. `--repo` flag works for repos you have push access to but don't own. Mitigation: preflight checks `Bun.which('gh')` + `gh auth status` + `gh repo view --json name` before any mutation.
- **File move breakage**: Moving 8 source files + 7 test files is the riskiest operation. Mitigation: do it as Unit 1 before any new code, verify all tests pass, and regenerate snapshot immediately.
- **Help text snapshot drift**: If new commands are added in Phase 2 before the snapshot is regenerated, intermediate commits will have failing snapshot tests. Mitigation: regenerate snapshot at the end of each unit that adds a new command.
- **`bundledDependencies` trap**: Adding `@clack/prompts` as a dependency. Do NOT add it to `bundledDependencies` — Bun's `.bun/` symlink layout creates broken tarballs (PR #44 lesson). Just list it in `dependencies`.

## Documentation / Operational Notes

- `packages/cli/AGENTS.md` updated in Unit 7 to reflect new structure
- `packages/cli/README.md` should list `cliproxy setup` as the recommended onboarding flow
- Root `AGENTS.md` WHERE TO LOOK table gets a `cliproxy setup` entry

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-07-cli-zhuzh-requirements.md](docs/brainstorms/2026-04-07-cli-zhuzh-requirements.md)
- Related code: `packages/cli/src/cli.ts`, `packages/cli/src/commands/`
- External pattern: `/Users/mrbrown/src/github.com/bfra-me/works/packages/create/` (@clack/prompts wizard)
- `@clack/prompts` docs: https://github.com/bombshell-dev/clack
- goke skill: `.agents/skills/goke/SKILL.md`
- Prior CLI plan: `docs/plans/2026-04-03-001-feat-cli-commands-plan.md` (original command scaffold)
