---
date: 2026-04-03
topic: cli-commands
---

# CLI Commands for Infrastructure Management

## Problem Frame

The `@marcusrbrown/infra` CLI (`packages/cli/src/cli.ts`) is a stub with no real commands. Operational tasks — checking deploy health, triggering deploys, verifying content — require navigating the GitHub Actions UI or running ad-hoc shell commands. A working CLI gives Marcus a local control plane for infra operations and, via the MCP bridge, gives coding agents (Fro Bot, Copilot) programmatic access to the same capabilities.

## Requirements

### Commands

- R1. **`infra keeweb status`** — Show operational health of the KeeWeb deployment:
  - R1a. HTTP reachability: GET `https://kw.igg.ms` and report status code + response time
  - R1b. Last deploy timestamp: query GitHub Actions API for the most recent successful run of the Deploy workflow
  - R1c. Content version check: fetch a known marker from the live site and compare against local `dist/` to detect drift

- R2. **`infra keeweb deploy`** — Trigger a KeeWeb deployment:
  - R2a. Default: trigger the Deploy workflow via GitHub Actions `workflow_dispatch` API (requires `gh` CLI or GitHub token)
  - R2b. `--local` flag: run `deploy.sh` directly using `DEPLOY_SSH_KEY` from `.env`, bypassing CI
  - R2c. `--nginx` flag (local only): pass `--nginx` to `deploy.sh` for config deployment
  - R2d. `--dry-run` flag: preview what would happen without executing

- R3. **`infra mcp`** — Start a stdio MCP server exposing all CLI commands as MCP tools via `@goke/mcp`. This lets coding agents call `keeweb status` and `keeweb deploy` programmatically.

### Framework

- R4. **Use `goke` as CLI framework** with Zod schemas for typed options, auto-generated help, and space-separated subcommands. A goke skill exists for implementing agents.

### Cross-cutting

- R5. **Global `--verbose` flag** for detailed output across all commands.
- R6. **Version from `package.json`** — `infra --version` reads version dynamically.

## Success Criteria

- `infra keeweb status` returns actionable health data in under 5 seconds
- `infra keeweb deploy` triggers the GitHub Actions workflow and reports the run URL
- `infra keeweb deploy --local` runs deploy.sh and succeeds against the live server
- `infra mcp` starts a stdio MCP server that exposes commands as callable tools
- `infra --help` and `infra keeweb --help` produce useful, complete help text
- All commands work with Bun (`bun run packages/cli/src/cli.ts`)

## Scope Boundaries

- Keeweb-only commands for now. Global `infra status` / `infra deploy` (across all apps) deferred until a second app exists.
- No interactive prompts needed for v1. All inputs via flags.
- No TLS certificate checking in v1 status (can add later).
- No workflow status check (passing/failing) in v1 status.
- The `@goke/mcp` OAuth flow is not needed — MCP server runs locally over stdio.

## Key Decisions

- **goke framework**: Zero-dependency, type-safe, Zod schemas, space-separated subcommands, MCP bridge built-in. Skill file available for implementing agents.
- **Dual deploy mode**: Default to GitHub Actions trigger (auditable, uses production approval gate). `--local` flag for direct SSH deploy (faster feedback loop, bypasses CI).
- **MCP exposure via `@goke/mcp`**: CLI doubles as an MCP server, giving coding agents programmatic access to infra operations without custom tool implementation.

## Dependencies / Assumptions

- `gh` CLI available for GitHub Actions API calls (deploy trigger, workflow run queries). Fall back to `GITHUB_TOKEN` env var if `gh` not available.
- `.env` contains `DEPLOY_SSH_KEY` for local deploys.
- `dist/` must exist locally for content version comparison (run `bun run --cwd apps/keeweb build` first).
- The "known marker" for content version check needs to be defined during planning (could be a hash of `dist/index.html`, a build timestamp, or the KeeWeb version string in the HTML).

## Outstanding Questions

### Deferred to Planning

- [Affects R1c][Needs research] What specific marker in the live site should be compared for content version drift? Options: hash of index.html body, KeeWeb version string in HTML, a generated build manifest.
- [Affects R2a][Technical] Should `infra keeweb deploy` poll the triggered workflow run to completion and report status, or just trigger and return the run URL?
- [Affects R3][Technical] Should the MCP command be auto-excluded from the MCP tool list (goke default), or should all commands including `mcp` be exposed?

## Next Steps

→ `/ce:plan` for structured implementation planning
