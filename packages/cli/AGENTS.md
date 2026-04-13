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
- **`@clack/prompts`**: Scoped to `cliproxy setup` only. All other commands remain non-interactive for CI/script compatibility. Import `intro`, `outro`, `text`, `select`, `confirm`, `spinner`, `note`, `isCancel`, `cancel` from `@clack/prompts`. Every prompt result MUST be checked with `isCancel()` — `cancel()` + `process.exit(0)` on cancellation.
- **Packaging**: Published package ships TypeScript source with `#!/usr/bin/env bun` shebang, requires `engines.bun >= 1.0.0`.
- **`--dry-run` semantics**: Prints the planned action without validating preconditions or executing side effects. Safe to run anywhere.
- **`--force-config` (cliproxy deploy)**: Override the safe default that skips uploading `config.yaml` when it exists on the server. Wipes runtime API keys — print a WARNING when set.
- **`--output <file>` (cliproxy config get)**: Write JSON to a file with `0600` perms instead of stdout. Wraps `Bun.write` + `chmod` in try/catch.
- **Tests**: colocated `*.test.ts`. Snapshots in `src/__snapshots__/`. Use `NO_COLOR=1` in subprocess env for deterministic output. Mock `fetch` and `Bun.spawn` at the boundary. Never spawn the real CLI for commands that launch browser (`keeweb open`) or SSH (`cliproxy open`) — test exported helpers and `--help` output only.

## ANTI-PATTERNS

- Never use `bundledDependencies` — Bun's `.bun/` symlinks create `../../` paths that npm rejects with E415.
- Never assume CLIProxyAPI body format — test empirically against the live API (e.g., `api-keys` PUT expects bare array, not wrapped object).
- Never use `BatchMode=yes` without `-tt` when stdin forwarding is needed (login command).
- Never inherit full parent env when spawning `deploy.sh` — use explicit env allowlist.
- Never check for `DEPLOY_SSH_KEY` env var for local deploy — check `SSH_AUTH_SOCK`.
- Never add `GITHUB_TOKEN` raw fetch fallback — require `gh` CLI.
- Never use `Authorization: Bearer` for cliproxy management endpoints — that header is for client API key auth, not management.
