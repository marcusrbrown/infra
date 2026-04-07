# @marcusrbrown/infra CLI

Published to npm as [`@marcusrbrown/infra`](https://www.npmjs.com/package/@marcusrbrown/infra). Run via `bunx @marcusrbrown/infra`. Built with [goke](https://github.com/remorses/goke) + Zod. Exposes commands as MCP tools via `@goke/mcp`.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add new command | `src/commands/<name>.ts` | Export `register<Name>(cli)`, import in cli.ts |
| Modify CLI skeleton | `src/cli.ts` | Global options, parse pattern, command registration |
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
- **Management API**: `requestJson()` for authenticated requests, `resolveManagementKey()` for key resolution.
- **Packaging**: `bundledDependencies` does NOT work with Bun's .bun/ symlink layout. Published package ships TypeScript source with `#!/usr/bin/env bun` shebang, requires `engines.bun >= 1.0.0`.
- **Tests**: colocated `*.test.ts`. Snapshots in `src/__snapshots__/`. Use `NO_COLOR=1` in subprocess env for deterministic output. Mock `fetch` and `Bun.spawn` at the boundary.

## ANTI-PATTERNS

- Never use `bundledDependencies` — Bun's .bun/ symlinks create `../../` paths that npm rejects.
- Never assume CLI proxy API body format — test empirically against live API (e.g., api-keys PUT expects bare array, not wrapped object).
- Never use `BatchMode=yes` without `-tt` when stdin forwarding is needed (login command).
- Never inherit full parent env when spawning deploy.sh — use explicit env allowlist.
- Never check for `DEPLOY_SSH_KEY` env var for local deploy — check `SSH_AUTH_SOCK`.
- Never add `GITHUB_TOKEN` raw fetch fallback — require `gh` CLI.
