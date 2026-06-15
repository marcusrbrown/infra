# @marcusrbrown/infra

Personal infrastructure management — deploy automation, operational CLI, and tooling.

<p align="center">
  <a href="https://www.npmjs.com/package/@marcusrbrown/infra"><img src="https://img.shields.io/npm/v/@marcusrbrown/infra?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/marcusrbrown/infra/actions/workflows/ci.yaml"><img src="https://github.com/marcusrbrown/infra/actions/workflows/ci.yaml/badge.svg" alt="CI"></a>
  <a href="https://github.com/marcusrbrown/infra/actions/workflows/codeql.yaml"><img src="https://github.com/marcusrbrown/infra/actions/workflows/codeql.yaml/badge.svg" alt="CodeQL"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/marcusrbrown/infra"><img src="https://api.scorecard.dev/projects/github.com/marcusrbrown/infra/badge?style=flat-square" alt="OpenSSF Scorecard"></a>
  <a href="https://github.com/marcusrbrown/infra/blob/main/LICENSE"><img src="https://img.shields.io/github/license/marcusrbrown/infra?style=flat-square" alt="License"></a>
</p>

## Overview

Bun workspace monorepo for managing personal infrastructure. Hosts KeeWeb deploy automation, the CLIProxyAPI proxy that routes Fro Bot agents to Claude via the Claude Code OAuth subscription, the Fro Bot gateway Discord client and workspace runner, a Fro Bot monitoring dashboard, a WireGuard VPN egress box on AWS Lightsail, and a CLI for operational health checks, deploy triggers, and MCP tool exposure.

| Package | Description |
| --- | --- |
| `apps/keeweb` | KeeWeb v1.18.7 static site deploy automation (`kw.igg.ms`) |
| `apps/cliproxy` | CLIProxyAPI Docker Compose stack behind Caddy (`cliproxy.fro.bot`) |
| `apps/gateway` | Fro Bot gateway Docker Compose stack (`gateway.fro.bot`) |
| `apps/umami` | Self-hosted Umami analytics Docker Compose stack (`metrics.fro.bot`) |
| `apps/dashboard` | Fro Bot monitoring dashboard Docker Compose stack (`dashboard.fro.bot`) |
| `apps/vpn` | WireGuard egress box on AWS Lightsail `eu-west-1` — native `wg-quick@wg0`, no Docker |
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

Each app is a self-contained deploy unit. See its README for build, deploy, provisioning, and configuration detail; see its `AGENTS.md` for operational runbooks.

- **[KeeWeb](apps/keeweb/README.md)** (`apps/keeweb`) — self-hosted [KeeWeb](https://keeweb.info) password manager at [kw.igg.ms](https://kw.igg.ms); static site deployed over SSH/rsync to a Mail-in-a-Box server.
- **[CLIProxyAPI](apps/cliproxy/README.md)** (`apps/cliproxy`) — [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) Claude proxy at [cliproxy.fro.bot](https://cliproxy.fro.bot); Docker Compose + Caddy on DigitalOcean, issuing per-repo API keys backed by one Claude subscription.
- **[Gateway](apps/gateway/README.md)** (`apps/gateway`) — Fro Bot Discord client and workspace runner at [gateway.fro.bot](https://gateway.fro.bot); a 3-service Docker Compose stack on DigitalOcean, pinned to `fro-bot/agent` via `apps/gateway/upstream.json`.
- **[Umami](apps/umami/README.md)** (`apps/umami`) — self-hosted [Umami](https://umami.is) privacy-respecting analytics at [metrics.fro.bot](https://metrics.fro.bot); Docker Compose (Umami + Postgres + Caddy) on DigitalOcean.
- **[Dashboard](apps/dashboard/README.md)** (`apps/dashboard`) — Fro Bot monitoring dashboard at [dashboard.fro.bot](https://dashboard.fro.bot); Docker Compose (dashboard + Caddy) on DigitalOcean; image built from `fro-bot/dashboard` (pinned in `apps/dashboard/upstream.json`) and pushed to GHCR by CI before deploy. See [`apps/dashboard/AGENTS.md`](apps/dashboard/AGENTS.md) for the operator runbook.
- **[VPN](apps/vpn/README.md)** (`apps/vpn`) — WireGuard egress box on AWS Lightsail (`eu-west-1`, Ireland); native `wg-quick@wg0` + systemd, no Docker; provisioned via `@aws-sdk/client-lightsail`, deployed over SSH.

## CLI

The [`@marcusrbrown/infra`](https://www.npmjs.com/package/@marcusrbrown/infra) CLI (`packages/cli`) is the unified operator surface — one command group per app, a unified `status` dashboard, and an MCP bridge. See [`packages/cli/README.md`](packages/cli/README.md) for the full command reference.

```bash
bunx @marcusrbrown/infra --help
bunx @marcusrbrown/infra status          # all deployments, human-readable
bunx @marcusrbrown/infra status --json   # machine-readable
bunx @marcusrbrown/infra mcp             # stdio MCP server for coding agents
```

## CI/CD

### Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| **CI** | PRs to `main` | Lint, type check, and test |
| **Deploy KeeWeb** | Push to `main`, `workflow_dispatch` | Build and deploy KeeWeb (path-filtered) |
| **Deploy CLIProxy** | Push to `main`, `workflow_dispatch` | Deploy CLIProxyAPI (path-filtered) |
| **Deploy Gateway** | Push to `main`, `workflow_dispatch` | Deploy gateway stack (path-filtered) |
| **Deploy Umami** | Push to `main`, `workflow_dispatch` | Deploy Umami analytics stack (path-filtered) |
| **Deploy Dashboard** | Push to `main`, `workflow_dispatch` | Build dashboard image to GHCR and deploy (path-filtered) |
| **Deploy VPN** | Push to `main`, `workflow_dispatch` | Deploy WireGuard VPN box (path-filtered) |
| **Deploy** | Push to `main`, `workflow_dispatch` | Router that path-filters changes and dispatches the per-app deploy workflows |
| **Release** | Push to `main` | Version and publish `@marcusrbrown/infra` via Changesets |
| **Renovate** | Schedule, issue/PR edits, post-deploy | Automated dependency updates |
| **Renovate Changesets** | Renovate PRs | Auto-create changeset files for dependency updates |
| **Fro Bot** | PRs, @mentions, daily schedule, `workflow_dispatch` | AI code review and autohealing |
| **Copilot Setup Steps** | `workflow_dispatch`, changes to workflow file | Prepare environment for Copilot coding agent |
| **Scorecard** | Weekly, push to `main` | OpenSSF security analysis |
| **Update Repo Settings** | Daily, push to `main` | Sync repo settings from `.github/settings.yml` |

### Deploy Pipeline

The `Deploy` router uses `dorny/paths-filter` (`predicate-quantifier: every`) to deploy only when an app's files change (docs, tests, fixtures, and snapshots are excluded from the filter). Each per-app deploy runs in its own GitHub Environment and requires approval.

- **Deploy KeeWeb** runs in the `keeweb` environment.
- **Deploy CLIProxy** runs in the `cliproxy` environment.
- **Deploy Gateway** runs in the `gateway` environment.
- **Deploy Umami** runs in the `umami` environment.
- **Deploy Dashboard** runs in the `dashboard` environment.
- **Deploy VPN** runs in the `vpn` environment.

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

| Secret | Required | Description |
| --- | --- | --- |
| `GATEWAY_SSH_KEY` | ✓ | Ed25519 private key for the `gateway.fro.bot` droplet |
| `DISCORD_TOKEN` | ✓ | Discord bot token |
| `DISCORD_APPLICATION_ID` | ✓ | Discord application ID |
| `DISCORD_GUILD_ID` | ✓ | Discord guild (server) ID |
| `AWS_ACCESS_KEY_ID` | ✓ | S3/R2 access key |
| `AWS_SECRET_ACCESS_KEY` | ✓ | S3/R2 secret key |
| `S3_BUCKET` | ✓ | Bucket name |
| `S3_REGION` | ✓ | Bucket region |
| `GATEWAY_HOST` | ✓ | FQDN of the droplet |
| `GH_APP_ID` | ✓ | GitHub App ID for `/fro-bot add-project` repo access |
| `GH_APP_PRIVATE_KEY` | ✓ | GitHub App private key PEM |
| `WORKSPACE_OPENCODE_TOKEN` | ✓ | Internal bearer token between gateway and workspace OpenCode proxy |
| `WORKSPACE_OPENCODE_AUTH` | ✓ | OpenCode provider `auth.json` for the workspace |
| `WORKSPACE_OPENCODE_MODEL` | ✓ | OpenCode model ID for the mention loop |
| `WORKSPACE_OPENCODE_CONFIG` | ✓ | OpenCode provider/baseURL config JSON |
| `GATEWAY_TRIGGER_ROLE_ID` | ✓ | Discord role ID allowed to trigger the `@fro-bot` mention loop |
| `S3_ENDPOINT` |  | Custom endpoint URL (R2, MinIO, etc.) |
| `OBJECT_STORE_HOSTS` |  | Comma-separated hostnames allowed through mitmproxy egress filter |
| `GATEWAY_WEBHOOK_SECRET` |  | HMAC key for the announce webhook (set with `GATEWAY_PRESENCE_CHANNEL_ID`) |
| `GATEWAY_PRESENCE_CHANNEL_ID` |  | Discord channel ID for presence embeds (set with `GATEWAY_WEBHOOK_SECRET`) |

See [`apps/gateway/README.md`](apps/gateway/README.md) for the complete contract including CI-injected image digests and OpenCode supervisor tuning.

**`umami` environment:**

| Secret                 | Required | Description                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------- |
| `UMAMI_SSH_KEY`        | ✓        | Ed25519 private key for the `metrics.fro.bot` droplet                         |
| `UMAMI_DOMAIN`         | ✓        | FQDN of the Umami instance                                                    |
| `UMAMI_APP_SECRET`     | ✓        | Umami app secret (session/JWT signing)                                        |
| `UMAMI_DB_PASSWORD`    | ✓        | Postgres password (volume-coupled — rotate only via the `ALTER USER` runbook) |
| `UMAMI_ADMIN_PASSWORD` | ✓        | Admin password set during deploy rotation                                     |

See [`apps/umami/README.md`](apps/umami/README.md) and [`apps/umami/AGENTS.md`](apps/umami/AGENTS.md) for the DB-password rotation runbook.

**`dashboard` environment:**

| Secret | Required | Description |
| --- | --- | --- |
| `DASHBOARD_SSH_KEY` | ✓ | Ed25519 private key for the `dashboard.fro.bot` droplet |
| `DASHBOARD_DOMAIN` | ✓ | FQDN of the dashboard instance |
| `DASHBOARD_GITHUB_APP_ID` | ✓ | GitHub App ID for dashboard repo access |
| `DASHBOARD_GITHUB_APP_KEY` | ✓ | GitHub App private key PEM (uploaded via SSH stdin; bind-mounted into container at `/run/secrets/github-app.pem`) |
| `DASHBOARD_OAUTH_CLIENT_ID` | ✓ | OAuth client ID for dashboard authentication |
| `DASHBOARD_OAUTH_CLIENT_SECRET` | ✓ | OAuth client secret for dashboard authentication |
| `DASHBOARD_OPERATOR_LOGIN` | ✓ | GitHub login of the operator allowed to access the dashboard |
| `DASHBOARD_COOKIE_KEY` | ✓ | Cookie signing key |

See [`apps/dashboard/AGENTS.md`](apps/dashboard/AGENTS.md) for the operator runbook.

**`vpn` environment:**

| Secret        | Required | Description                                                                      |
| ------------- | -------- | -------------------------------------------------------------------------------- |
| `VPN_SSH_KEY` | ✓        | Ed25519 private key for the VPN box (`wg-egress` keypair)                        |
| `VPN_HOST`    | ✓        | Static IP of the Lightsail instance (printed by provisioning)                    |
| `VPN_PEERS`   | —        | Peer roster JSON. Auto-synced by `vpn client add/remove`. Empty roster is valid. |

AWS provisioning credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are operator-local only — not in the `vpn` Environment and not used by deploy or status. See [`apps/vpn/README.md`](apps/vpn/README.md) and [`apps/vpn/AGENTS.md`](apps/vpn/AGENTS.md).

**Repository secrets:**

| Secret                      | Description                                                                |
| --------------------------- | -------------------------------------------------------------------------- |
| `APPLICATION_ID`            | GitHub App ID for Renovate and repo settings sync                          |
| `APPLICATION_PRIVATE_KEY`   | GitHub App private key                                                     |
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean API token (used by cliproxy, gateway, and umami provisioning) |
| `FRO_BOT_PAT`               | PAT for the `fro-bot` user (agent identity for `@fro-bot` mentions)        |
| `NPM_TOKEN`                 | npm publish token for `@marcusrbrown/infra` package                        |
| `OPENCODE_AUTH_JSON`        | LLM provider credentials JSON injected into Fro Bot runs                   |
| `OPENCODE_CONFIG`           | OpenCode provider config JSON (e.g. Anthropic `baseURL` override)          |

**Repository variables:**

| Variable        | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `FRO_BOT_MODEL` | LLM model ID for the Fro Bot agent (e.g. `claude-sonnet-4-6`) |

### Server Setup

The KeeWeb deploy target uses a dedicated `deploy-kw` user with scoped sudo for the nginx activation script. To provision or re-provision the user:

```bash
bun run apps/keeweb/server/setup-deploy-user.ts
```

Host keys for `box.heatvision.co`, `cliproxy.fro.bot`, `gateway.fro.bot`, `dashboard.fro.bot`, and the VPN static IP are pinned in `.github/known_hosts` — no runtime `ssh-keyscan`.

## Repository Structure

For the directory layout and where to put new code, see [`STRUCTURE.md`](STRUCTURE.md). For system shape, data flow, and invariants, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

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
