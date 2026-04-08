---
date: 2026-04-07
topic: cli-zhuzh
---

# CLI "Zhuzh" — Structure, Interactivity, and Management Polish

## Problem Frame

The `@marcusrbrown/infra` CLI has grown to 8 commands across 2 apps but uses a flat file layout (`<app>-<action>.ts`), outputs raw JSON in several places, has no interactive flows, and lacks a unified status view. Onboarding a new repo to CLIProxyAPI requires manually running 4+ commands and copy-pasting secrets. The CLI works but doesn't feel polished.

## Requirements

### File Restructure

- R1. Reorganize `src/commands/` from flat `<app>-<action>.ts` to `<app>/<action>.ts` with barrel `index.ts` per group
- R2. Each barrel exports a single `register<App>Commands(cli)` function that registers all subcommands for that app
- R3. `cli.ts` imports only barrel registrations + standalone commands (`status`, `mcp`)
- R4. Test files colocate with their source (move into subdirectories alongside commands)
- R5. goke space-separated subcommands unchanged (`keeweb status`, `cliproxy deploy`) — restructure is organizational only

### Unified Status Dashboard

- R6. Top-level `status` command runs all app health checks in parallel
- R7. Displays unified table: app name, HTTP status, last deploy timestamp/actor, version (cliproxy), content hash drift (keeweb), usage stats (cliproxy requests/failures)
- R8. Graceful degradation — if one app check fails, show error for that row and continue
- R9. `--json` flag for machine-readable output

### `cliproxy setup` — Interactive Onboarding Wizard

- R10. New `cliproxy setup` command using `@clack/prompts` for interactive flows
- R11. Wizard steps: verify proxy reachable → generate/add API key → select harness (OpenCode, Claude Code, or generic) → select target GitHub repo → set secrets via `gh secret set` → verify connection
- R12. Each step shows clear success/failure with `@clack/prompts` spinner and styled output
- R13. Support `--key` flag to skip key generation (use existing key)
- R14. Support `--repo` flag to skip repo selection (target a specific repo)
- R15. Non-interactive fallback: if stdin is not a TTY, require all options via flags and skip prompts

### `keeweb open`

- R16. `keeweb open` opens `https://kw.igg.ms/` in the default browser via `open` (macOS) / `xdg-open` (Linux)

### `cliproxy open`

- R17. `cliproxy open` SSHes into the server and launches CLIProxyAPI's built-in TUI dashboard
- R18. Requires TTY (same guard as `cliproxy login`)
- R19. Command: `ssh -tt root@<host> 'cd /opt/cliproxy && docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --tui'`

### Management Polish

- R20. `cliproxy keys list` outputs formatted table (not raw JSON) by default; `--json` for raw
- R21. `cliproxy config get` outputs human-readable key-value format by default; `--json` for raw
- R22. `cliproxy status` includes usage summary (total requests, failure rate) inline

## Success Criteria

- File restructure does not change CLI behavior — help output, MCP bridge, and all existing commands work identically
- `cliproxy setup` can onboard a new repo from zero to working Fro Bot in one command
- `status` command completes in <5s with both apps checked in parallel
- All new commands have colocated tests
- `@clack/prompts` only used in explicitly interactive commands (`setup`); other commands remain non-interactive

## Scope Boundaries

- No goke API changes — space-separated subcommands stay
- No web dashboard deployment — TUI via SSH is sufficient
- No new apps added — only `keeweb` and `cliproxy`
- `@clack/prompts` does not replace goke for arg parsing — it layers on top for interactive flows only
- `keys add` stays simple — onboarding logic lives in `cliproxy setup`

## Key Decisions

- **File restructure over framework change**: goke doesn't support nested command groups. Modularization is by directory convention, not API.
- **`@clack/prompts` for wizard only**: Interactive prompts scoped to `cliproxy setup`. All other commands stay non-interactive for CI/script compatibility.
- **TUI over web dashboard**: CLIProxyAPI has a built-in Go TUI. External Next.js dashboard exists but requires PostgreSQL and separate hosting — not worth the complexity.
- **Top-level `status` is additive**: Individual `keeweb status` and `cliproxy status` remain. The top-level command aggregates them.

## Dependencies / Assumptions

- `@clack/prompts` added as a dependency to `packages/cli/`
- `gh` CLI available for `cliproxy setup` secret-setting step
- CLIProxyAPI TUI works via `docker compose exec` (needs verification)
- `open` command available on macOS; `xdg-open` on Linux

## Outstanding Questions

### Deferred to Planning

- [Affects R11][Needs research] Which harness-specific secrets does each target need? (OpenCode needs `OPENCODE_AUTH_JSON` + `OPENCODE_CONFIG` + `OMO_PROVIDERS`; Claude Code TBD; generic TBD)
- [Affects R19][Needs research] Verify CLIProxyAPI TUI launches correctly via `docker compose exec` with `--tui` flag
- [Affects R7][Technical] Table formatting library choice — `@clack/prompts` table vs `string-width` + manual padding vs `cli-table3`
- [Affects R1][Technical] Snapshot test updates after file moves — regenerate all `__snapshots__/` files

## Next Steps

→ `/ce:plan` for structured implementation planning
