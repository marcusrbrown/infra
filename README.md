# @marcusrbrown/infra

Personal infrastructure management — deploy automation, configuration, and tooling.

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/marcusrbrown/infra/badge?style=flat-square)](https://scorecard.dev/viewer/?uri=github.com/marcusrbrown/infra)

## Overview

Bun workspace monorepo for managing personal infrastructure. Currently hosts KeeWeb deploy automation with CI/CD, with a CLI scaffold for future tooling.

| Package        | Description                                  |
| -------------- | -------------------------------------------- |
| `apps/keeweb`  | KeeWeb v1.18.7 static site deploy automation |
| `packages/cli` | `@marcusrbrown/infra` CLI (stub)             |

## Prerequisites

- [Bun](https://bun.sh) v1.0+

## Quick Start

```bash
bun install
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

The `@marcusrbrown/infra` CLI (`packages/cli`) is a stub scaffold for future infrastructure commands.

```bash
bun run packages/cli/src/cli.ts --help
```

## CI/CD

### Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| **CI** | PRs to `main` | Lint + type check |
| **Deploy** | Push to `main` (keeweb changes), `workflow_dispatch` | Build and deploy KeeWeb |
| **Renovate** | Push, issue/PR edits, post-deploy | Automated dependency updates |
| **Fro Bot** | PRs, @mentions, daily schedule, `workflow_dispatch` | AI code review + autohealing |
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

| Secret                    | Description                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `APPLICATION_ID`          | GitHub App ID for Renovate and repo settings sync                  |
| `APPLICATION_PRIVATE_KEY` | GitHub App private key                                             |
| `FRO_BOT_PAT`             | PAT for the fro-bot user (AI agent identity for @fro-bot mentions) |
| `OPENCODE_AUTH_JSON`      | LLM provider auth JSON (e.g. `{"anthropic":{"apiKey":"..."}}}`)    |
| `OMO_PROVIDERS`           | OhMyOpenCode provider configuration                                |

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
├── packages/cli/            @marcusrbrown/infra CLI (stub)
│   └── src/cli.ts           Entry point
├── .github/
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

## License

MIT
