# @marcusrbrown/infra CLI

Published to npm as [`@marcusrbrown/infra`](https://www.npmjs.com/package/@marcusrbrown/infra). Run via `bunx @marcusrbrown/infra`. Built with [goke](https://github.com/remorses/goke) + Zod. Exposes commands as MCP tools via `@goke/mcp`.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add new command | `src/commands/<name>.ts` | Export `register<Name>(cli)`, import in cli.ts |
| Modify CLI skeleton | `src/cli.ts` | Global options, parse pattern, command registration |
| Change goke patterns | goke SKILL.md | `https://raw.githubusercontent.com/remorses/goke/refs/heads/main/goke/SKILL.md` |
| CLI tests | `src/cli.test.ts` | Snapshots in `src/__snapshots__/` |
| Command tests | `src/commands/<name>.test.ts` | Colocated alongside each command |

## COMMAND PATTERN

Each command lives in `src/commands/` and exports a registration function:

```text
src/commands/keeweb-status.ts  →  registerKeewebStatus(cli)
src/commands/keeweb-deploy.ts  →  registerKeewebDeploy(cli)
src/commands/cliproxy-status.ts → registerCliproxyStatus(cli)
src/commands/cliproxy-config.ts → registerCliproxyConfig(cli)
src/commands/cliproxy-keys.ts   → registerCliproxyKeys(cli)
src/commands/cliproxy-login.ts  → registerCliproxyLogin(cli)
src/commands/cliproxy-deploy.ts → registerCliproxyDeploy(cli)
src/commands/mcp.ts            →  registerMcp(cli)
```

Space-separated subcommands: `cli.command('keeweb status', '...')`. Zod schemas for typed options. Global `--verbose` accessible in all command actions.

## CONVENTIONS

- `import type` for goke type imports — `import type {goke} from 'goke'`
- Async actions: `cli.parse(process.argv, {run: false})` + `await cli.runMatchedCommand()` with try/catch
- Shell out to `gh` CLI for GitHub API (not octokit) — `Bun.spawn(['gh', ...])`
- Parse `gh` JSON output through Zod schemas before use
- SHA-256 via `Bun.CryptoHasher('sha256')`, not crypto module
- Resolve paths with `import.meta.dir` + `path.resolve()` — validate existence before use
- **`--dry-run` semantics**: prints the plan/action that would be taken without executing it. Does NOT validate preconditions (e.g., build artifacts, env vars, ssh-agent). Safe to run anywhere.
- **Tests**: colocated `*.test.ts` files. Snapshots in `src/__snapshots__/`. Use `NO_COLOR=1` in subprocess env when spawning the CLI to get deterministic output. Mock `fetch` and `Bun.spawn` at the boundary, not internals.

## ANTI-PATTERNS

- Never inherit full parent env when spawning deploy.sh — use explicit env allowlist (`HOST`, `REMOTE_USER`, `SITE_DIR`, `SSH_AUTH_SOCK`, `PATH`, `HOME`).
- Never check for `DEPLOY_SSH_KEY` env var for local deploy — check `SSH_AUTH_SOCK` (deploy.sh needs ssh-agent, not raw key).
- Never add `GITHUB_TOKEN` raw fetch fallback — require `gh` CLI.
- The `mcp` command is auto-excluded from MCP tool list by `@goke/mcp` default. Don't manually filter it.
