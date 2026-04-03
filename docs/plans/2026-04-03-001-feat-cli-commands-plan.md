---
title: "feat: Add CLI commands for KeeWeb operations and MCP bridge"
type: feat
status: completed
date: 2026-04-03
deepened: 2026-04-03
origin: docs/brainstorms/2026-04-03-cli-commands-requirements.md
---

# feat: Add CLI commands for KeeWeb operations and MCP bridge

## Overview

Replace the stub CLI at `packages/cli/` with a working `goke`-based CLI providing `keeweb status`, `keeweb deploy`, and an MCP server bridge. This gives Marcus a local control plane for infra operations and gives coding agents (Fro Bot, Copilot) programmatic access via MCP tools.

## Problem Frame

Operational tasks — checking deploy health, triggering deploys, verifying content — require navigating the GitHub Actions UI or running ad-hoc shell commands. The CLI stub has no real commands. (see origin: docs/brainstorms/2026-04-03-cli-commands-requirements.md)

## Requirements Trace

- R1. `infra keeweb status` — HTTP reachability, last deploy timestamp, content version check
  - R1a. HTTP reachability: GET `https://kw.igg.ms` and report status code + response time
  - R1b. Last deploy timestamp: query GitHub Actions API for most recent successful Deploy workflow run
  - R1c. Content version check: hash fetched index.html body vs local `dist/index.html` to detect drift
- R2. `infra keeweb deploy` — workflow_dispatch trigger (default) + local deploy via `--local` flag
  - R2a. Default: trigger Deploy workflow via `workflow_dispatch` API, report run URL
  - R2b. `--local` flag: run deploy.sh directly via SSH
  - R2c. `--nginx` flag (local only): pass `--nginx` to deploy.sh
  - R2d. `--dry-run` flag: validate preconditions and report what would happen
- R3. `infra mcp` — stdio MCP server exposing all commands as tools via `@goke/mcp`
- R4. Use `goke` framework with Zod schemas
- R5. Global `--verbose` flag
- R6. Version from `package.json`

## Scope Boundaries

- Keeweb-only commands. No global `infra status` / `infra deploy` until a second app exists.
- No interactive prompts. All inputs via flags.
- No TLS certificate checking in status.
- No workflow status (passing/failing) in status.
- MCP server runs locally over stdio — no OAuth flow needed.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/cli.ts` — current stub, plain arg parsing, `#!/usr/bin/env bun` shebang
- `packages/cli/package.json` — bin entry `"infra": "src/cli.ts"`, private, type: module
- `apps/keeweb/src/build.ts` — async `main()` with try/catch, `process.exit(1)` on error, ANSI color output
- `apps/keeweb/deploy.sh` — expects `HOST`, `REMOTE_USER`, `SITE_DIR` env vars with defaults, `--nginx` flag
- `.github/workflows/deploy.yaml` — workflow name `"Deploy"`, no dispatch inputs, post-deploy health check curls `https://kw.igg.ms/`
- `KEEWEB_VERSION = '1.18.7'` in `build.ts`

### External References

- goke v6.3.2: zero-dep CLI framework (only `picocolors`), Standard Schema support (Zod), space-separated subcommands, async actions via `cli.parse({ run: false })` + `await cli.runMatchedCommand()`
- @goke/mcp v0.0.9: `createMcpAction({ cli })` exposes all CLI commands as MCP tools, `mcp` command auto-excluded from tool list
- Zod must be installed separately (not bundled with goke)
- `string-dedent` is a separate package for multi-line descriptions
- goke SKILL.md available at `https://raw.githubusercontent.com/remorses/goke/refs/heads/main/goke/SKILL.md` — implementing agent should load this

## Key Technical Decisions

- **goke framework**: Type-safe, Zod schemas for option coercion, space-separated subcommands (`keeweb status`, `keeweb deploy`), auto-generated help, MCP bridge built-in. (see origin)
- **Dual deploy mode**: Default triggers GitHub Actions `workflow_dispatch` via `gh` CLI. `--local` flag runs `deploy.sh` directly. (see origin)
- **`gh` CLI for GitHub API**: Use `Bun.spawn` to shell out to `gh` rather than adding `octokit` as a dependency. The `gh` CLI handles auth, pagination, and is already available in dev environments. No `GITHUB_TOKEN` raw fetch fallback — require `gh` CLI for GitHub API operations (simpler, safer, avoids scope validation issues).
- **Content version check via index.html hash**: No version marker exists in the deployed site. Compare SHA-256 hash of fetched `https://kw.igg.ms/` response body against hash of local `dist/index.html`. Warn if `dist/` doesn't exist. Hash mismatch is a warning (not an error) since nginx content transformation could cause false positives. TLS verification uses Bun's default (do not disable).
- **Deploy trigger is fire-and-forget for v1**: `infra keeweb deploy` triggers the workflow and returns the run URL. The Deploy workflow requires `production` environment approval, so the run will be pending until approved — inform the user of this. No polling to completion.
- **`--dry-run` is CLI-level, not deploy.sh**: `deploy.sh` only accepts `--nginx` — it has no `--dry-run` flag. The CLI implements dry-run by validating preconditions and reporting what would happen, without spawning deploy.sh or triggering the workflow.
- **Explicit env for deploy.sh spawn**: When spawning deploy.sh, construct an explicit env object containing only required vars (`HOST`, `REMOTE_USER`, `SITE_DIR`, `SSH_AUTH_SOCK`, `PATH`, `HOME`) rather than inheriting the full parent environment. This prevents leaking unrelated secrets (e.g., `GITHUB_TOKEN`) to subprocesses.
- **Local deploy requires ssh-agent, not raw key**: `deploy.sh` uses `ssh`/`rsync` which require an SSH agent. For `--local` mode, check for `SSH_AUTH_SOCK` (agent running with key loaded) rather than `DEPLOY_SSH_KEY` env var. The raw PEM content in `.env` is for CI's `webfactory/ssh-agent` action, not direct use by `ssh`. Document the local SSH setup requirement in the command's help text.
- **File structure**: Split commands into separate modules under `packages/cli/src/commands/` for maintainability. Main `cli.ts` wires them together.

## Open Questions

### Resolved During Planning

- **Content drift marker**: Use SHA-256 hash of `index.html` body. No build manifest needed — KeeWeb is a stable v1.18.7 release, content only changes when config or deploy scripts change. Hash mismatch is a warning, not an error.
- **Deploy polling**: Fire-and-forget for v1. Return run URL immediately.
- **MCP tool exclusion**: Use goke default — `mcp` command auto-excluded from tool list.
- **`.env` loading for local deploy**: Use Bun's built-in `.env` support (`--env-file=.env` or `Bun.env`). No `dotenv` dependency needed.

### Deferred to Implementation

- Exact error messages and exit codes for each failure mode (gh not found, network timeout, deploy.sh missing, etc.)
- Whether `--verbose` should also pass through to `deploy.sh` output — ensure it does not expose secrets or auth tokens
- Verify `@goke/mcp` v0.0.9 exported API (`createMcpAction`) matches SKILL.md documentation after install
- Verify goke MCP tool naming for space-separated subcommands (e.g., does `keeweb status` become `keeweb-status` or `keeweb status` as a tool name?)
- Parse `gh` CLI JSON output through Zod schema validation before use — prevents issues from gh version changes or malformed output

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
cli = goke('infra')
  .option('--verbose')
  .version(pkg.version)

cli.command('keeweb status')     → fetch site, query gh api, hash comparison
cli.command('keeweb deploy')     → gh workflow run OR spawn deploy.sh --local
cli.command('mcp')               → createMcpAction({ cli })

cli.parse(process.argv, { run: false })
await cli.runMatchedCommand()
```

File layout:
```
packages/cli/
├── src/
│   ├── cli.ts                  # Entry point: goke setup, wire commands, parse
│   └── commands/
│       ├── keeweb-status.ts    # Status command: HTTP check, deploy timestamp, content hash
│       ├── keeweb-deploy.ts    # Deploy command: workflow_dispatch + local mode
│       └── mcp.ts              # MCP server command
└── package.json                # Add goke, zod, @goke/mcp, string-dedent deps
```

## Implementation Units

- [ ] **Unit 1: Install dependencies and scaffold goke CLI skeleton**

  **Goal:** Replace the plain arg-parsing stub with a goke-based CLI that parses commands and shows help/version.

  **Requirements:** R4, R5, R6

  **Dependencies:** None

  **Files:**
  - Modify: `packages/cli/package.json` (add dependencies)
  - Modify: `packages/cli/src/cli.ts` (rewrite with goke)
  - Create: `packages/cli/src/commands/` directory

  **Approach:**
  - Install `goke`, `zod`, `@goke/mcp`, `string-dedent` as runtime dependencies in the cli package (`bun add --cwd packages/cli goke zod @goke/mcp string-dedent`)
  - Commit updated `bun.lock` alongside `package.json` changes (CI uses `--frozen-lockfile`)
  - Rewrite `cli.ts` with goke: global `--verbose` flag, version from `package.json`, help, async parse pattern
  - Use `cli.parse(process.argv, { run: false })` + `await cli.runMatchedCommand()` wrapped in try/catch
  - Keep `#!/usr/bin/env bun` shebang
  - Register placeholder commands for `keeweb status`, `keeweb deploy`, `mcp` that will be filled in subsequent units

  **Patterns to follow:**
  - goke SKILL.md patterns (schema-based options, space-separated subcommands, detailed descriptions)
  - `apps/keeweb/src/build.ts` async main() with try/catch error handling

  **Test scenarios:**
  - `infra --help` shows all commands with descriptions
  - `infra --version` prints version from package.json
  - `infra keeweb --help` shows keeweb subcommands
  - Unknown command shows error + help

  **Verification:**
  - `bun run packages/cli/src/cli.ts --help` produces correct output
  - `bun run packages/cli/src/cli.ts --version` prints version
  - `bunx tsc --noEmit` passes
  - `bun run lint` passes

- [ ] **Unit 2: Implement `keeweb status` command**

  **Goal:** Show operational health of the KeeWeb deployment with HTTP reachability, last deploy timestamp, and content version check.

  **Requirements:** R1 (R1a, R1b, R1c)

  **Dependencies:** Unit 1

  **Files:**
  - Create: `packages/cli/src/commands/keeweb-status.ts`
  - Modify: `packages/cli/src/cli.ts` (import and register command)

  **Approach:**
  - HTTP reachability: `fetch('https://kw.igg.ms/')` with timeout, report status code + response time
  - Last deploy: shell out to `gh run list --workflow=Deploy --status=success --limit=1 --json createdAt,url --repo marcusrbrown/infra` and parse JSON output
  - Content version: hash fetched index.html body vs local `dist/index.html` (using `Bun.CryptoHasher`). Warn if `dist/` doesn't exist. Show match/mismatch.
  - Output as formatted text. If `--verbose`, show additional details (response headers, full gh output)
  - Handle errors gracefully: network timeout, gh not installed, dist/ missing — report each check independently

  **Patterns to follow:**
  - goke SKILL.md: Zod schemas for options, detailed descriptions
  - Deploy workflow health check pattern: `curl -sf https://kw.igg.ms/`

  **Test scenarios:**
  - Site reachable: shows HTTP 200, response time, green indicator
  - Site unreachable: shows error, continues to other checks
  - `gh` not available: shows warning, skips deploy timestamp
  - `dist/` missing: shows warning about content check being unavailable
  - Content matches: shows checkmark
  - Content drifted: shows warning with hash mismatch

  **Verification:**
  - `bun run packages/cli/src/cli.ts keeweb status` runs all three checks and produces readable output
  - Lint and typecheck pass

- [ ] **Unit 3: Implement `keeweb deploy` command**

  **Goal:** Trigger KeeWeb deployment via GitHub Actions or locally via deploy.sh.

  **Requirements:** R2 (R2a, R2b, R2c, R2d)

  **Dependencies:** Unit 1

  **Files:**
  - Create: `packages/cli/src/commands/keeweb-deploy.ts`
  - Modify: `packages/cli/src/cli.ts` (import and register command)

  **Approach:**
  - Default (remote): shell out to `gh workflow run Deploy --repo marcusrbrown/infra`. Since `gh workflow run` returns no URL, construct the workflow URL directly: `https://github.com/marcusrbrown/infra/actions/workflows/deploy.yaml`. Warn the user that `workflow_dispatch` triggers deploy **including nginx config** (per workflow `if` condition). Inform user the run requires production environment approval.
  - `--local` flag: spawn `bash apps/keeweb/deploy.sh` with explicit env (only `HOST`, `REMOTE_USER`, `SITE_DIR`, `SSH_AUTH_SOCK`, `PATH`, `HOME`). Requires `SSH_AUTH_SOCK` set (ssh-agent running with deploy key loaded). Validate `dist/index.html` exists before deploying.
  - `--nginx` flag (only with `--local`): pass `--nginx` to deploy.sh. Error if `--nginx` without `--local`.
  - `--dry-run` flag: CLI-level only (deploy.sh has no dry-run support). For remote: show what would be triggered without calling `gh workflow run`. For local: validate all preconditions (dist/ exists, `SSH_AUTH_SOCK` set, deploy.sh found) and report what would be executed, without spawning deploy.sh.
  - Resolve `deploy.sh` path relative to `import.meta.dir` with upward traversal to repo root (`../../apps/keeweb/deploy.sh`). Validate the resolved path exists before spawning. Document that `--local` requires running from within the repo tree.

  **Patterns to follow:**
  - `apps/keeweb/src/build.ts` `Bun.spawn` usage for process spawning
  - deploy.sh env vars: `HOST`, `REMOTE_USER`, `SITE_DIR` defaults

  **Test scenarios:**
  - Remote deploy: triggers workflow, reports run URL
  - `--local` deploy: spawns deploy.sh, streams output
  - `--local --nginx`: passes --nginx flag through
  - `--nginx` without `--local`: shows error
  - `--dry-run` remote: shows "would trigger Deploy workflow" without triggering
  - `--dry-run --local`: validates preconditions without deploying
  - `dist/` missing with `--local`: shows error before attempting deploy
  - `gh` not available for remote deploy: shows error with instructions

  **Verification:**
  - `bun run packages/cli/src/cli.ts keeweb deploy --dry-run` shows what would happen without side effects
  - `bun run packages/cli/src/cli.ts keeweb deploy --help` shows all options with descriptions
  - Lint and typecheck pass

- [ ] **Unit 4: Implement `mcp` command and wire up**

  **Goal:** Add MCP server command that exposes all CLI commands as MCP tools, and do final integration wiring.

  **Requirements:** R3

  **Dependencies:** Units 1, 2, 3

  **Files:**
  - Create: `packages/cli/src/commands/mcp.ts`
  - Modify: `packages/cli/src/cli.ts` (import and register mcp command)

  **Approach:**
  - Use `createMcpAction({ cli })` from `@goke/mcp` — this auto-discovers all registered commands and exposes them as MCP tools
  - The `mcp` command itself is auto-excluded from the tool list by goke default behavior
  - Keep it minimal — the bridge does the heavy lifting

  **Patterns to follow:**
  - goke SKILL.md MCP bridge pattern
  - @goke/mcp `createMcpAction` API

  **Test scenarios:**
  - `infra mcp` starts without error (stdio mode)
  - `infra mcp --help` shows the command description
  - MCP tool list includes `keeweb-status` and `keeweb-deploy` but not `mcp`

  **Verification:**
  - `bun run packages/cli/src/cli.ts mcp` starts and accepts MCP protocol messages on stdio
  - All commands accessible: `infra --help` shows keeweb status, keeweb deploy, mcp
  - `infra keeweb --help` shows status and deploy subcommands
  - Full lint and typecheck pass
  - `bun run --cwd apps/keeweb build` still works (no regressions)

## System-Wide Impact

- **New dependencies**: `goke`, `zod`, `@goke/mcp`, `string-dedent` added to `packages/cli/package.json`. No impact on root or `apps/keeweb/` packages (workspace isolation).
- **`bun.lock` update**: Lock file will change with new deps. CI uses `--frozen-lockfile` so the lock must be committed.
- **Bin entry unchanged**: `"infra": "src/cli.ts"` stays the same — goke replaces the internals, not the entry point.
- **No CI impact**: CLI is not part of any CI workflow. Build/deploy pipelines unaffected.
- **MCP exposure surface**: `infra mcp` gives agents access to deploy triggers. The `--local` deploy requires `DEPLOY_SSH_KEY` in env, which limits blast radius to environments with the key present.

## Risks & Dependencies

- **`gh` CLI availability**: Status and remote deploy depend on `gh` being installed and authenticated. Mitigated by graceful fallback messaging with install instructions.
- **goke stability**: v6.3.2, relatively young framework. Mitigated by zero-dep design (only `picocolors`) — easy to vendor or replace if abandoned.
- **@goke/mcp maturity**: v0.0.9, pre-1.0. MCP bridge is a convenience, not a critical path. If it breaks, the CLI commands work standalone.
- **Content hash comparison fragility**: Live site response may include dynamic headers or compression differences. Mitigate by comparing only the response body text, not headers.
- **Production environment approval gate**: The Deploy workflow requires `production` environment approval. When `infra keeweb deploy` triggers `workflow_dispatch`, `gh` returns the run URL immediately but the job queues pending approval. The CLI should inform the user that the run is pending approval and provide the URL to approve it.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-03-cli-commands-requirements.md](../brainstorms/2026-04-03-cli-commands-requirements.md)
- **goke SKILL.md:** https://raw.githubusercontent.com/remorses/goke/refs/heads/main/goke/SKILL.md
- Related code: `packages/cli/src/cli.ts`, `apps/keeweb/deploy.sh`, `.github/workflows/deploy.yaml`
- goke repo: https://github.com/remorses/goke
