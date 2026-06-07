# @marcusrbrown/infra

[![npm version](https://img.shields.io/npm/v/@marcusrbrown/infra?style=flat-square)](https://www.npmjs.com/package/@marcusrbrown/infra) [![npm downloads](https://img.shields.io/npm/dm/@marcusrbrown/infra?style=flat-square)](https://www.npmjs.com/package/@marcusrbrown/infra)

Infrastructure management CLI — deploy automation, health checks, and MCP bridge.

> **Requires [Bun](https://bun.sh)** — this package ships TypeScript source with a `#!/usr/bin/env bun` shebang.

## Install

```bash
bun add -g @marcusrbrown/infra
```

Or run directly:

```bash
bunx @marcusrbrown/infra --help
```

## Commands

### KeeWeb

Manage the KeeWeb static-site deployment on `box.heatvision.co`.

| Subcommand      | Description                                                                     |
| --------------- | ------------------------------------------------------------------------------- |
| `keeweb status` | HTTP reachability, last deploy timestamp, SHA-256 content hash vs local `dist/` |
| `keeweb deploy` | Trigger deployment (GitHub Actions by default; `--local` for direct SSH)        |
| `keeweb open`   | Open the KeeWeb site in the default browser                                     |

```bash
bunx @marcusrbrown/infra keeweb status
bunx @marcusrbrown/infra keeweb deploy              # GitHub Actions workflow
bunx @marcusrbrown/infra keeweb deploy --local       # deploy directly via SSH
bunx @marcusrbrown/infra keeweb deploy --local --nginx  # include nginx config
bunx @marcusrbrown/infra keeweb open
```

### CLIProxyAPI

Manage the CLIProxyAPI proxy on `cliproxy.fro.bot`.

| Subcommand        | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `cliproxy status` | HTTP reachability, usage stats, version                                  |
| `cliproxy deploy` | Trigger deployment (GitHub Actions by default; `--local` for direct SSH) |
| `cliproxy config` | Get or set proxy configuration via the management API                    |
| `cliproxy keys`   | List, add, or remove API keys via the management API                     |
| `cliproxy login`  | Authenticate a provider (claude or codex) via SSH                        |
| `cliproxy open`   | Open an interactive TUI via SSH                                          |
| `cliproxy setup`  | Interactive wizard to onboard a repo to CLIProxyAPI                      |

```bash
bunx @marcusrbrown/infra cliproxy status
bunx @marcusrbrown/infra cliproxy deploy
bunx @marcusrbrown/infra cliproxy config get
bunx @marcusrbrown/infra cliproxy config set
bunx @marcusrbrown/infra cliproxy keys list
bunx @marcusrbrown/infra cliproxy keys add
bunx @marcusrbrown/infra cliproxy keys remove
bunx @marcusrbrown/infra cliproxy login claude
bunx @marcusrbrown/infra cliproxy login codex
bunx @marcusrbrown/infra cliproxy open
bunx @marcusrbrown/infra cliproxy setup
bunx @marcusrbrown/infra cliproxy setup --repo OWNER/REPO --harness opencode
```

### Gateway

Manage the Fro Bot gateway on `gateway.fro.bot`.

| Subcommand        | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `gateway status`  | SSH health check, `docker compose ps` service states                     |
| `gateway deploy`  | Trigger deployment (GitHub Actions by default; `--local` for direct SSH) |
| `gateway logs`    | Stream gateway service logs (`--tail N` to limit lines)                  |
| `gateway backup`  | Pull mitmproxy CA cert + key as a tarball (`--include-ca`)               |
| `gateway restore` | Restore CA from a tarball (`--include-ca --input FILE`)                  |

```bash
bunx @marcusrbrown/infra gateway status
bunx @marcusrbrown/infra gateway deploy
bunx @marcusrbrown/infra gateway logs gateway --tail 100
bunx @marcusrbrown/infra gateway backup --include-ca
bunx @marcusrbrown/infra gateway restore --include-ca --input backup.tar.gz
```

### Umami

Manage the Umami analytics deployment on `metrics.fro.bot`.

| Subcommand     | Description                                                              |
| -------------- | ------------------------------------------------------------------------ |
| `umami status` | SSH health check, `docker compose ps` service states                     |
| `umami deploy` | Trigger deployment (GitHub Actions by default; `--local` for direct SSH) |
| `umami logs`   | Stream umami service logs (`--tail N` to limit lines)                    |

```bash
bunx @marcusrbrown/infra umami status
bunx @marcusrbrown/infra umami deploy
bunx @marcusrbrown/infra umami logs --tail 50
```

### Unified Status

```bash
bunx @marcusrbrown/infra status          # all deployments
bunx @marcusrbrown/infra status --json   # machine-readable output
```

### MCP Bridge

Exposes read-only status commands as MCP tools over stdio.

```bash
bunx @marcusrbrown/infra mcp
```

See `packages/cli/AGENTS.md` for the MCP allowlist and tool-exposure rules.

## License

MIT
