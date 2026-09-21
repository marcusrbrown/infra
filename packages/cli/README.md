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

### Agent

Configure model credentials for the Fro Bot agent and wire the optional S3 durable-storage handoff.

| Subcommand | Description |
| --- | --- |
| `agent setup` | Interactive wizard to configure generalized agent model-credential secrets/variables |
| `agent storage --repo OWNER/REPO --manifest FILE` | Verify the provisioned S3 handoff and wire non-secret GitHub storage variables |
| `agent storage teardown --repo OWNER/REPO --manifest FILE` | Unwire S3 variables and remove the repo-scoped storage resources |

```bash
bunx @marcusrbrown/infra agent setup
bunx @marcusrbrown/infra agent setup --repo owner/repo --harness opencode --key sk-existing --force
bunx @marcusrbrown/infra agent storage --repo owner/repo --manifest handoff.json
bunx @marcusrbrown/infra agent storage --repo owner/repo --manifest handoff.json --plan  # report without mutating
bunx @marcusrbrown/infra agent storage teardown --repo owner/repo --manifest handoff.json
```

### CLIProxyAPI

Manage the CLIProxyAPI proxy on `cliproxy.fro.bot`.

| Subcommand             | Description                                                              |
| ---------------------- | ------------------------------------------------------------------------ |
| `cliproxy status`      | HTTP reachability, usage stats, version                                  |
| `cliproxy models`      | List models served at /v1/models; optional `[provider]` filter           |
| `cliproxy deploy`      | Trigger deployment (GitHub Actions by default; `--local` for direct SSH) |
| `cliproxy config`      | Get or set proxy configuration via the management API                    |
| `cliproxy keys`        | List, add, or remove API keys via the management API                     |
| `cliproxy login`       | Authenticate a provider (claude or codex) via SSH                        |
| `cliproxy monitor`     | Probe Anthropic auth and send issue/Discord transition alerts            |
| `cliproxy open`        | Open an interactive TUI via SSH                                          |
| `cliproxy reset-quota` | Reset quota for a CLIProxyAPI auth record                                |
| `cliproxy setup`       | Interactive wizard to onboard a repo to CLIProxyAPI                      |

```bash
bunx @marcusrbrown/infra cliproxy status
bunx @marcusrbrown/infra cliproxy models
bunx @marcusrbrown/infra cliproxy models anthropic
bunx @marcusrbrown/infra cliproxy deploy
bunx @marcusrbrown/infra cliproxy config get
bunx @marcusrbrown/infra cliproxy config set
bunx @marcusrbrown/infra cliproxy keys list
bunx @marcusrbrown/infra cliproxy keys add
bunx @marcusrbrown/infra cliproxy keys remove
bunx @marcusrbrown/infra cliproxy login claude
bunx @marcusrbrown/infra cliproxy login codex
bunx @marcusrbrown/infra cliproxy monitor
bunx @marcusrbrown/infra cliproxy open
bunx @marcusrbrown/infra cliproxy reset-quota
bunx @marcusrbrown/infra cliproxy setup
bunx @marcusrbrown/infra cliproxy setup --repo OWNER/REPO --harness opencode
```

### Broker

Manage the OIDC credential broker on `broker.fro.bot`.

| Subcommand      | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `broker status` | HTTP reachability via `/healthz`                                         |
| `broker deploy` | Trigger deployment (GitHub Actions by default; `--local` for direct SSH) |
| `broker logs`   | Stream broker service logs (`--tail N` to limit lines)                   |

```bash
bunx @marcusrbrown/infra broker status
bunx @marcusrbrown/infra broker deploy
bunx @marcusrbrown/infra broker logs --tail 100
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

### Dashboard

Manage the Fro Bot operator dashboard.

| Subcommand         | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `dashboard status` | SSH health check, `docker compose ps` service states                     |
| `dashboard deploy` | Trigger deployment (GitHub Actions by default; `--local` for direct SSH) |
| `dashboard logs`   | Stream dashboard service logs (`--tail N` to limit lines)                |

```bash
bunx @marcusrbrown/infra dashboard status
bunx @marcusrbrown/infra dashboard deploy
bunx @marcusrbrown/infra dashboard deploy --image-version 2026.06.47  # pin a CalVer release
bunx @marcusrbrown/infra dashboard logs dashboard --tail 100
```

### VPN

Manage the WireGuard VPN egress box.

| Subcommand                 | Description                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `vpn status`               | SSH health check, `wg show wg0` interface state                          |
| `vpn deploy`               | Trigger deployment (GitHub Actions by default; `--local` for direct SSH) |
| `vpn logs`                 | Stream WireGuard logs (`--tail N` to limit lines)                        |
| `vpn client add <name>`    | Generate a keypair, assign a tunnel IP, write the client `.conf`         |
| `vpn client list`          | List peers (name, tunnel IP, public key)                                 |
| `vpn client remove <name>` | Remove a peer                                                            |

```bash
bunx @marcusrbrown/infra vpn status
bunx @marcusrbrown/infra vpn deploy
bunx @marcusrbrown/infra vpn deploy --force-server-key  # rotates the server key, invalidates all client configs
bunx @marcusrbrown/infra vpn logs --tail 100
bunx @marcusrbrown/infra vpn client add laptop
bunx @marcusrbrown/infra vpn client list
bunx @marcusrbrown/infra vpn client remove laptop
```

### Unified Status

```bash
bunx @marcusrbrown/infra status          # all deployments
bunx @marcusrbrown/infra status --json   # machine-readable output
```

### MCP Bridge

Starts a stdio MCP server exposing a read-only allowlist of exactly 9 status commands as tools: `gateway status`, `cliproxy status`, `cliproxy models`, `keeweb status`, `umami status`, `dashboard status`, `vpn status`, `broker status`, and unified `status`. Every mutating command is deliberately excluded from the allowlist.

```bash
bunx @marcusrbrown/infra mcp
```

See `packages/cli/AGENTS.md` for the MCP allowlist and tool-exposure rules.

## License

MIT
