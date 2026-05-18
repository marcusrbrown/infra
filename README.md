# @marcusrbrown/infra

Personal infrastructure management — deploy automation, operational CLI, and tooling.

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/marcusrbrown/infra/badge?style=flat-square)](https://scorecard.dev/viewer/?uri=github.com/marcusrbrown/infra)

## Overview

Bun workspace monorepo for managing personal infrastructure. Hosts KeeWeb deploy automation, the CLIProxyAPI proxy that routes Fro Bot agents to Claude via the Claude Code OAuth subscription, the Fro Bot gateway Discord client and workspace runner, and a CLI for operational health checks, deploy triggers, and MCP tool exposure.

| Package | Description |
| --- | --- |
| `apps/keeweb` | KeeWeb v1.18.7 static site deploy automation (`kw.igg.ms`) |
| `apps/cliproxy` | CLIProxyAPI Docker Compose stack behind Caddy (`cliproxy.fro.bot`) |
| `apps/gateway` | Fro Bot gateway Docker Compose stack (`gateway.fro.bot`) |
| `packages/cli` | [`@marcusrbrown/infra`](https://www.npmjs.com/package/@marcusrbrown/infra) CLI — health checks, deploy triggers, onboarding wizard, MCP bridge |

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [GitHub CLI](https://cli.github.com) (`gh`) — required for the remote `keeweb`/`cliproxy` deploy triggers and status commands

## Quick Start

```bash
bun install
bun run lint
bunx tsc --noEmit
bun test --recursive
```

## Apps

### KeeWeb (`apps/keeweb`)

Self-hosted [KeeWeb](https://keeweb.info) v1.18.7 password manager at [kw.igg.ms](https://kw.igg.ms). Static site built from the upstream release archive with Dropbox client-credential injection.

**Build** — downloads the KeeWeb release, verifies SHA-256, produces a deploy-ready `dist/`:

```bash
bun run --cwd apps/keeweb build
```

To inject the Dropbox app secret during build:

```bash
DROPBOX_APP_SECRET=<value> bun run --cwd apps/keeweb build
```

**Deploy** — pushes `dist/` to the server via SSH/rsync:

```bash
bash apps/keeweb/deploy.sh           # content only
bash apps/keeweb/deploy.sh --nginx   # content + nginx config
```

### CLIProxyAPI (`apps/cliproxy`)

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) Docker Compose stack fronted by Caddy at [cliproxy.fro.bot](https://cliproxy.fro.bot). Authenticates to Claude once via the Claude Code OAuth flow, then issues per-repo API keys so Fro Bot agents across multiple repositories can use Claude models through a single subscription.

**Provision** — creates the DigitalOcean droplet and bootstraps Docker + firewall (one-time, `--force` required to rerun against an existing droplet):

```bash
bun run --cwd apps/cliproxy provision
```

**Deploy** — uploads compose files and restarts the stack (idempotent, preserves runtime `config.yaml` unless `--force-config` is set):

```bash
bun run --cwd apps/cliproxy deploy
```

### Gateway (`apps/gateway`)

Fro Bot Discord client and workspace runner at [gateway.fro.bot](https://gateway.fro.bot). A 3-service Docker Compose stack (gateway daemon, workspace executor, mitmproxy egress filter) on a dedicated DigitalOcean droplet. Pinned to `fro-bot/agent v0.44.0` via `apps/gateway/upstream.json`. No public HTTP surface — the gateway connects outbound to Discord and S3 only.

**Prerequisites** — before provisioning:

- `DIGITALOCEAN_ACCESS_TOKEN` in `.env`; `doctl auth init` run locally
- Discord application created at <https://discord.com/developers/applications> with bot scope; token + application ID + guild ID captured
- S3 or R2 bucket created; access key, secret key, bucket name, and region captured

**Provision** — creates the DigitalOcean droplet and bootstraps Docker + firewall (one-time, `--force` required to rerun against an existing droplet):

```bash
bun run --cwd apps/gateway provision
```

After provisioning, commit the updated `.github/known_hosts` (the script appends the new droplet's host keys). See [`apps/gateway/AGENTS.md`](apps/gateway/AGENTS.md) for the full provisioning checklist.

**Deploy** — materializes secrets on the droplet, brings up the Compose stack, and gates on Discord command registration:

```bash
bun run --cwd apps/gateway deploy
```

## CLI

The [`@marcusrbrown/infra`](https://www.npmjs.com/package/@marcusrbrown/infra) CLI exposes operational commands for KeeWeb, CLIProxyAPI, and Gateway plus an MCP bridge.

```bash
bunx @marcusrbrown/infra --help
```

Or install globally:

```bash
bun add -g @marcusrbrown/infra
infra --help
```

### Unified status

**`infra status`** — parallel health checks for all active deployments:

```bash
bunx @marcusrbrown/infra status          # human-readable table
bunx @marcusrbrown/infra status --json   # machine-readable JSON
```

### KeeWeb commands

**`infra keeweb status`** — operational health check (HTTP reachability, last successful deploy timestamp via GitHub Actions API, SHA-256 content hash comparison vs local `dist/`).

```bash
bunx @marcusrbrown/infra keeweb status
```

**`infra keeweb deploy`** — trigger a deployment:

```bash
bunx @marcusrbrown/infra keeweb deploy                  # trigger GitHub Actions workflow (default)
bunx @marcusrbrown/infra keeweb deploy --dry-run        # validate preconditions without triggering
bunx @marcusrbrown/infra keeweb deploy --local          # deploy directly via SSH (content only)
bunx @marcusrbrown/infra keeweb deploy --local --nginx  # include nginx config deploy
```

Local deploy requires `ssh-agent` running with the deploy key loaded (`SSH_AUTH_SOCK`).

**`infra keeweb open`** — open KeeWeb in the default browser (fire-and-forget, won't block the terminal):

```bash
bunx @marcusrbrown/infra keeweb open
```

### CLIProxyAPI commands

**`infra cliproxy status`** — HTTP reachability, version, usage statistics.

```bash
bunx @marcusrbrown/infra cliproxy status
```

**`infra cliproxy deploy`** — trigger a deployment (remote by default, `--local` for direct SSH):

```bash
bunx @marcusrbrown/infra cliproxy deploy                       # trigger GitHub Actions workflow
bunx @marcusrbrown/infra cliproxy deploy --dry-run             # validate without triggering
bunx @marcusrbrown/infra cliproxy deploy --local               # deploy directly via SSH
bunx @marcusrbrown/infra cliproxy deploy --local --force-config  # overwrite server config.yaml
```

**`infra cliproxy config`** — read or update runtime configuration via the management API:

```bash
bunx @marcusrbrown/infra cliproxy config get
bunx @marcusrbrown/infra cliproxy config get --output /tmp/cliproxy.yaml  # write to file (chmod 600)
bunx @marcusrbrown/infra cliproxy config set debug true
bunx @marcusrbrown/infra cliproxy config set request-retry 3
bunx @marcusrbrown/infra cliproxy config set proxy-url https://proxy.example.com
```

**`infra cliproxy keys`** — manage proxy API keys (opaque bearer tokens distributed to Fro Bot repos):

```bash
bunx @marcusrbrown/infra cliproxy keys list
bunx @marcusrbrown/infra cliproxy keys add "fro-bot-<repo>"
bunx @marcusrbrown/infra cliproxy keys remove "fro-bot-<repo>"
```

**`infra cliproxy login`** — OAuth authentication with a Claude subscription (runs over SSH with TTY):

```bash
bunx @marcusrbrown/infra cliproxy login claude
```

**`infra cliproxy open`** — launch the CLIProxyAPI built-in terminal dashboard via SSH (requires TTY):

```bash
bunx @marcusrbrown/infra cliproxy open
```

**`infra cliproxy setup`** — interactive onboarding wizard for connecting a new repo to CLIProxyAPI:

```bash
bunx @marcusrbrown/infra cliproxy setup                                    # interactive wizard
bunx @marcusrbrown/infra cliproxy setup --key sk-... --repo owner/repo --harness opencode  # non-interactive
```

Generates an API key, sets `OPENCODE_AUTH_JSON` and `OPENCODE_CONFIG` secrets on the target repo, and verifies the connection.

### Gateway commands

**`infra gateway status`** — SSH to the droplet, run `docker compose ps`, show service states, ages, and healthchecks.

```bash
bunx @marcusrbrown/infra gateway status
```

**`infra gateway deploy`** — trigger a deployment (remote by default, `--local` for direct SSH):

```bash
bunx @marcusrbrown/infra gateway deploy             # trigger GitHub Actions workflow
bunx @marcusrbrown/infra gateway deploy --dry-run   # validate without triggering
bunx @marcusrbrown/infra gateway deploy --local     # deploy directly via SSH (requires SSH_AUTH_SOCK)
```

**`infra gateway logs`** — stream `docker compose logs` from the droplet:

```bash
bunx @marcusrbrown/infra gateway logs gateway        # gateway daemon logs
bunx @marcusrbrown/infra gateway logs mitmproxy      # egress filter logs
bunx @marcusrbrown/infra gateway logs gateway --tail 100
```

**`infra gateway backup`** — pull the mitmproxy CA cert + key as a tarball (mode 0600):

```bash
bunx @marcusrbrown/infra gateway backup --include-ca --output ./gateway-ca.tar
```

**`infra gateway restore`** — validate and restore a CA tarball to the droplet:

```bash
bunx @marcusrbrown/infra gateway restore --include-ca --input ./gateway-ca.tar
```

### MCP bridge

**`infra mcp`** — start a stdio MCP server exposing all CLI commands as tools:

```bash
bunx @marcusrbrown/infra mcp
```

Lets coding agents (Fro Bot, Copilot) call commands programmatically via the [Model Context Protocol](https://modelcontextprotocol.io).

## CI/CD

### Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| **CI** | PRs to `main` | Lint, type check, and test |
| **Deploy KeeWeb** | Push to `main`, `workflow_dispatch` | Build and deploy KeeWeb (path-filtered) |
| **Deploy CLIProxy** | Push to `main`, `workflow_dispatch` | Deploy CLIProxyAPI (path-filtered) |
| **Deploy Gateway** | Push to `main`, `workflow_dispatch` | Deploy gateway stack (path-filtered) |
| **Deploy** | `workflow_dispatch` | Manual umbrella dispatch that triggers all three deploy workflows |
| **Release** | Push to `main` | Version and publish `@marcusrbrown/infra` via Changesets |
| **Renovate** | Schedule, issue/PR edits, post-deploy | Automated dependency updates |
| **Renovate Changesets** | Renovate PRs | Auto-create changeset files for dependency updates |
| **Fro Bot** | PRs, @mentions, daily schedule, `workflow_dispatch` | AI code review and autohealing |
| **Copilot Setup Steps** | `workflow_dispatch`, changes to workflow file | Prepare environment for Copilot coding agent |
| **Scorecard** | Weekly, push to `main` | OpenSSF security analysis |
| **Update Repo Settings** | Daily, push to `main` | Sync repo settings from `.github/settings.yml` |

### Deploy Pipeline

`Deploy KeeWeb`, `Deploy CLIProxy`, and `Deploy Gateway` use `dorny/paths-filter` to deploy only when app files change (docs, tests, fixtures, and snapshots are excluded from the filter). Each deploy runs in its own GitHub Environment and requires approval.

- **Deploy KeeWeb** runs in the `keeweb` environment.
- **Deploy CLIProxy** runs in the `cliproxy` environment.
- **Deploy Gateway** runs in the `gateway` environment.

Manual deploys are available either per-app (`workflow_dispatch` on each dedicated workflow) or together via the umbrella `Deploy` workflow.

### Required Secrets

**`keeweb` environment:**

| Secret               | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `DEPLOY_SSH_KEY`     | Ed25519 private key for `deploy-kw@box.heatvision.co` |
| `DROPBOX_APP_SECRET` | Dropbox app client credential for KeeWeb config       |

**`cliproxy` environment:**

| Secret                    | Description                                                  |
| ------------------------- | ------------------------------------------------------------ |
| `CLIPROXY_SSH_KEY`        | Ed25519 private key for the `cliproxy.fro.bot` DO droplet    |
| `CLIPROXY_MANAGEMENT_KEY` | Management API bearer token for runtime config / key updates |
| `CLIPROXY_DOMAIN`         | FQDN of the CLIProxyAPI instance                             |

**`gateway` environment:**

| Secret                   | Required | Description                                                       |
| ------------------------ | -------- | ----------------------------------------------------------------- |
| `GATEWAY_SSH_KEY`        | ✓        | Ed25519 private key for the `gateway.fro.bot` droplet             |
| `DISCORD_TOKEN`          | ✓        | Discord bot token                                                 |
| `DISCORD_APPLICATION_ID` | ✓        | Discord application ID                                            |
| `DISCORD_GUILD_ID`       | ✓        | Discord guild (server) ID                                         |
| `AWS_ACCESS_KEY_ID`      | ✓        | S3/R2 access key                                                  |
| `AWS_SECRET_ACCESS_KEY`  | ✓        | S3/R2 secret key                                                  |
| `S3_BUCKET`              | ✓        | Bucket name                                                       |
| `S3_REGION`              | ✓        | Bucket region                                                     |
| `GATEWAY_HOST`           | ✓        | FQDN or IP of the droplet                                         |
| `S3_ENDPOINT`            |          | Custom endpoint URL (R2, MinIO, etc.)                             |
| `OBJECT_STORE_HOSTS`     |          | Comma-separated hostnames allowed through mitmproxy egress filter |

**Repository secrets:**

| Secret                      | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `APPLICATION_ID`            | GitHub App ID for Renovate and repo settings sync                   |
| `APPLICATION_PRIVATE_KEY`   | GitHub App private key                                              |
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean API token (used by `apps/cliproxy` provision scripts)  |
| `FRO_BOT_PAT`               | PAT for the `fro-bot` user (agent identity for `@fro-bot` mentions) |
| `NPM_TOKEN`                 | npm publish token for `@marcusrbrown/infra` package                 |
| `OMO_PROVIDERS`             | Comma-separated oMo provider list (e.g. `claude-max20`)             |
| `OPENCODE_AUTH_JSON`        | LLM provider credentials JSON injected into Fro Bot runs            |
| `OPENCODE_CONFIG`           | OpenCode provider config JSON (e.g. Anthropic `baseURL` override)   |

**Repository variables:**

| Variable        | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `FRO_BOT_MODEL` | LLM model ID for the Fro Bot agent (e.g. `claude-sonnet-4-6`) |

### Server Setup

The KeeWeb deploy target uses a dedicated `deploy-kw` user with scoped sudo for the nginx activation script. To provision or re-provision the user:

```bash
bun run apps/keeweb/server/setup-deploy-user.ts
```

Host keys for `box.heatvision.co`, `cliproxy.fro.bot`, and `gateway.fro.bot` are pinned in `.github/known_hosts` — no runtime `ssh-keyscan`.

## Repository Structure

```text
├── apps/
│   ├── keeweb/                  KeeWeb deploy package
│   │   ├── src/build.ts         Build script (download + SHA-256 verify + config injection)
│   │   ├── config/              Config templates (nginx, app config)
│   │   ├── server/              Deploy user provisioning script
│   │   └── deploy.sh            SSH/rsync deploy script
│   └── cliproxy/                CLIProxyAPI deployment package
│       ├── config/              docker-compose.yaml, Caddyfile, config.yaml template
│       ├── server/              Droplet provisioning script
│       └── src/deploy.ts        Deploy script
│   └── gateway/                 Fro Bot gateway deployment package
│       ├── server/              Droplet provisioning script
│       ├── src/deploy.ts        Deploy script (secrets materialization, compose up, registration poll)
│       └── upstream.json        Pinned fro-bot/agent ref
├── packages/cli/                @marcusrbrown/infra CLI
│   └── src/
│       ├── cli.ts               Entry point (goke framework)
│       ├── cli.test.ts          CLI snapshot + discovery tests
│       └── commands/            Command modules (subdirectory per app)
│           ├── keeweb/          status, deploy, open + barrel
│           ├── cliproxy/        status, deploy, config, keys, login, open, setup + barrel
│           ├── gateway/         status, deploy, logs, backup, restore + barrel
│           ├── status.ts        Unified cross-app status dashboard
│           └── mcp.ts           MCP bridge (stdio server)
├── .agents/
│   └── skills/                  Agent skill context packets (goke)
├── .github/
│   ├── copilot-instructions.md  Copilot coding agent instructions
│   ├── known_hosts              Pinned SSH host keys
│   ├── renovate.json5           Renovate configuration
│   ├── settings.yml             Repository settings definition
│   └── workflows/               CI/CD and automation workflows
├── docs/
│   ├── brainstorms/             Requirements and brainstorms
│   ├── plans/                   Implementation plans
│   └── solutions/               Compound learning docs
└── .opencode/
    └── commands/                OpenCode slash commands
```

## Testing

```bash
bun test --recursive  # Run all tests from repo root
bun test              # Run tests in current package
```

Tests are colocated alongside source files (`*.test.ts`). Fixtures live in `__fixtures__/`, snapshots in `__snapshots__/`. Tests mock at boundaries (`fetch`, `Bun.spawn`) and use `NO_COLOR=1` for deterministic subprocess output. CI runs tests as a parallel job alongside lint and type-check.

## Development

```bash
bun run lint          # ESLint
bun run fix           # ESLint --fix (includes Prettier)
bunx tsc --noEmit     # Type check
```

Pre-commit hook runs `lint-staged` → `eslint --fix` on staged files via `simple-git-hooks`.

### Tooling

| Tool       | Config                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------- |
| ESLint     | `eslint.config.ts` via `@bfra.me/eslint-config`                                                |
| Prettier   | `@bfra.me/prettier-config/120-proof`                                                           |
| TypeScript | `tsconfig.json` via `@bfra.me/tsconfig`                                                        |
| Git hooks  | `simple-git-hooks` + `lint-staged`                                                             |
| CLI        | [goke](https://github.com/remorses/goke) + Zod Standard Schemas                                |
| Prompts    | [`@clack/prompts`](https://github.com/bombshell-dev/clack) — scoped to `cliproxy setup` wizard |
| Changesets | `@changesets/cli` for versioning                                                               |

## License

MIT
