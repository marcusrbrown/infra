# @marcusrbrown/infra

Personal infrastructure management — deploy automation, operational CLI, and tooling.

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/marcusrbrown/infra/badge?style=flat-square)](https://scorecard.dev/viewer/?uri=github.com/marcusrbrown/infra)

## Overview

Bun workspace monorepo for managing personal infrastructure. Hosts KeeWeb deploy automation with CI/CD, and a CLI for operational health checks, deploy triggers, and MCP tool exposure.

| Package         | Description                                  |
| --------------- | -------------------------------------------- |
| `apps/keeweb`   | KeeWeb v1.18.7 static site deploy automation |
| `apps/cliproxy` | CLIProxyAPI deployment (scaffolded)          |
| `packages/cli`  | `@marcusrbrown/infra` CLI                    |

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [GitHub CLI](https://cli.github.com) (`gh`) — required for `keeweb status` and `keeweb deploy`

## Quick Start

```bash
bun install
bun run lint
bunx tsc --noEmit
bun test --recursive
```

## Apps

### KeeWeb (`apps/keeweb`)

Self-hosted [KeeWeb](https://keeweb.info) v1.18.7 password manager at [kw.igg.ms](https://kw.igg.ms).

**Build** — downloads the KeeWeb release and produces a deploy-ready `dist/`:

```bash
bun run --cwd apps/keeweb build
```

To inject the Dropbox app secret during build:

```bash
DROPBOX_APP_SECRET=<value> bun run --cwd apps/keeweb build
```

**Deploy** — pushes `dist/` to the server via SSH/rsync:

```bash
bash apps/keeweb/deploy.sh          # content only
bash apps/keeweb/deploy.sh --nginx   # content + nginx config
```

## CLI

The [`@marcusrbrown/infra`](https://www.npmjs.com/package/@marcusrbrown/infra) CLI provides operational commands for managing infrastructure.

```bash
bunx @marcusrbrown/infra --help
```

Or install globally:

```bash
bun add -g @marcusrbrown/infra
infra --help
```

### Commands

**`infra keeweb status`** — operational health check:

- HTTP reachability of kw.igg.ms (status code + response time)
- Last successful deploy timestamp (via GitHub Actions API)
- Content hash comparison (SHA-256 of live site vs local `dist/`)

```bash
bunx @marcusrbrown/infra keeweb status
```

**`infra keeweb deploy`** — trigger a deployment:

```bash
bunx @marcusrbrown/infra keeweb deploy              # trigger GitHub Actions workflow
bunx @marcusrbrown/infra keeweb deploy --dry-run     # preview plan without validating preconditions
bunx @marcusrbrown/infra keeweb deploy --local       # deploy directly via SSH
bunx @marcusrbrown/infra keeweb deploy --local --nginx  # include nginx config
```

Local deploy requires `ssh-agent` running with the deploy key loaded (`SSH_AUTH_SOCK`).

**`infra mcp`** — start a stdio MCP server exposing all CLI commands as tools:

```bash
bunx @marcusrbrown/infra mcp
```

This lets coding agents (Fro Bot, Copilot) call `keeweb status` and `keeweb deploy` programmatically via the [Model Context Protocol](https://modelcontextprotocol.io).

## CI/CD

### Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| **CI** | PRs to `main` | Lint, type check, and test |
| **Deploy** | Push to `main` (keeweb changes), `workflow_dispatch` | Build and deploy KeeWeb |
| **Release** | Push to `main` | Version packages via Changesets |
| **Renovate** | Push, issue/PR edits, post-deploy | Automated dependency updates |
| **Renovate Changesets** | PRs from Renovate | Auto-create changeset files for dependency updates |
| **Fro Bot** | PRs, @mentions, daily schedule, `workflow_dispatch` | AI code review + autohealing |
| **Copilot Setup Steps** | `workflow_dispatch`, changes to workflow file | Prepare environment for Copilot coding agent |
| **Scorecard** | Weekly, push to `main` | OpenSSF security analysis |
| **Update Repo Settings** | Daily, push to `main` | Sync repo settings from `.github/settings.yml` |

### Deploy Pipeline

Pushes to `main` that touch `apps/keeweb/**` trigger an automated deploy via GitHub Actions. Manual deploys are available via `workflow_dispatch`.

Deploys require approval through the `production` GitHub Environment.

### Required Secrets

**Production environment** (`DEPLOY_SSH_KEY`, `DROPBOX_APP_SECRET`):

| Secret               | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `DEPLOY_SSH_KEY`     | Ed25519 private key for `deploy-kw@box.heatvision.co` |
| `DROPBOX_APP_SECRET` | Dropbox app client credential for KeeWeb config       |

**Repository secrets** (`APPLICATION_ID`, `APPLICATION_PRIVATE_KEY`, `FRO_BOT_PAT`, `OPENCODE_AUTH_JSON`, `OMO_PROVIDERS`):

| Secret                      | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `APPLICATION_ID`            | GitHub App ID for Renovate and repo settings sync                  |
| `APPLICATION_PRIVATE_KEY`   | GitHub App private key                                             |
| `FRO_BOT_PAT`               | PAT for the fro-bot user (AI agent identity for @fro-bot mentions) |
| `OPENCODE_AUTH_JSON`        | LLM provider auth JSON (e.g. `{"anthropic":{"apiKey":"..."}}}`)    |
| `NPM_TOKEN`                 | npm publish token for `@marcusrbrown/infra` package                |
| `OMO_PROVIDERS`             | Comma-separated oMo provider list (e.g. `claude`)                  |
| `OPENCODE_CONFIG`           | OpenCode provider config JSON (e.g. anthropic baseURL override)    |
| `DIGITALOCEAN_ACCESS_TOKEN` | API token for DigitalOcean management                              |

**Repository variables:**

| Variable        | Description                        |
| --------------- | ---------------------------------- |
| `FRO_BOT_MODEL` | LLM model ID for the Fro Bot agent |

### Server Setup

The deploy target uses a dedicated `deploy-kw` user with scoped permissions. To provision (or re-provision) the user:

```bash
bun run apps/keeweb/server/setup-deploy-user.ts
```

## Repository Structure

```text
├── apps/keeweb/             KeeWeb deploy package
│   ├── src/build.ts         Build script (download + config injection)
│   ├── config/              Config templates (nginx, app config)
│   ├── server/              Server provisioning scripts
│   └── deploy.sh            SSH/rsync deploy script
├── apps/cliproxy/           CLIProxyAPI deployment (scaffolded)
├── packages/cli/            @marcusrbrown/infra CLI
│   └── src/
│       ├── cli.ts           Entry point (goke framework)
│       ├── cli.test.ts      CLI snapshot + discovery tests
│       └── commands/        Command modules
│           ├── keeweb-status.ts
│           ├── keeweb-deploy.ts
│           └── mcp.ts
├── .agents/
│   └── skills/              Agent skill context packets
├── .github/
│   ├── copilot-instructions.md  Copilot coding agent instructions
│   ├── known_hosts          Pinned SSH host keys
│   ├── renovate.json5       Renovate configuration
│   ├── settings.yml         Repository settings definition
│   └── workflows/           CI/CD and automation workflows
├── docs/
│   ├── brainstorms/         Requirements and brainstorms
│   ├── plans/               Implementation plans
│   └── solutions/           Compound learning docs
└── .opencode/
    └── commands/            OpenCode slash commands
```

## Testing

```bash
bun test --recursive  # Run all tests from repo root
bun test              # Run tests in current package
```

Tests are colocated alongside source files (`*.test.ts`). Fixtures in `__fixtures__/`, snapshots in `__snapshots__/`. Tests mock at boundaries (fetch, Bun.spawn) and use `NO_COLOR=1` for deterministic subprocess output. CI runs tests as a parallel job alongside lint and type-check.

## Development

```bash
bun run lint          # ESLint
bun run fix           # ESLint --fix (includes Prettier)
bunx tsc --noEmit     # Type check
```

Pre-commit hook runs `lint-staged` → `eslint --fix` on staged files via `simple-git-hooks`.

### Tooling

| Tool       | Config                                          |
| ---------- | ----------------------------------------------- |
| ESLint     | `eslint.config.ts` via `@bfra.me/eslint-config` |
| Prettier   | `@bfra.me/prettier-config/120-proof`            |
| TypeScript | `tsconfig.json` via `@bfra.me/tsconfig`         |
| Git hooks  | `simple-git-hooks` + `lint-staged`              |
| CLI        | [goke](https://github.com/remorses/goke) + Zod  |
| Changesets | `@changesets/cli` for versioning                |

## License

MIT
