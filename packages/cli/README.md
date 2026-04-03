# @marcusrbrown/infra

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

### `infra keeweb status`

Operational health check for the KeeWeb deployment:

- HTTP reachability (status code + response time)
- Last successful deploy timestamp via GitHub Actions
- SHA-256 content hash comparison (live site vs local `dist/`)

```bash
bunx @marcusrbrown/infra keeweb status
```

### `infra keeweb deploy`

Trigger a KeeWeb deployment:

```bash
bunx @marcusrbrown/infra keeweb deploy              # GitHub Actions workflow
bunx @marcusrbrown/infra keeweb deploy --dry-run     # preview without executing
bunx @marcusrbrown/infra keeweb deploy --local       # deploy directly via SSH
bunx @marcusrbrown/infra keeweb deploy --local --nginx  # include nginx config
```

Local deploy requires `ssh-agent` running with the deploy key loaded.

### `infra mcp`

Start a stdio MCP server exposing all commands as tools:

```bash
bunx @marcusrbrown/infra mcp
```

## License

MIT
