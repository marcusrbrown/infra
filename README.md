# @marcusrbrown/infra

Personal infrastructure management — deploy automation, configuration, and tooling.

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

## CI/CD

Pushes to `main` that touch `apps/keeweb/**` trigger an automated deploy via GitHub Actions. Manual deploys are available via `workflow_dispatch`.

Deploys require approval through the `production` GitHub Environment.

### Required Secrets

Set these in the `production` GitHub Environment:

| Secret               | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `DEPLOY_SSH_KEY`     | Ed25519 private key for `deploy-kw@box.heatvision.co` |
| `DROPBOX_APP_SECRET` | Dropbox app client credential for KeeWeb config       |

### Server Setup

The deploy target uses a dedicated `deploy-kw` user with scoped permissions. To provision (or re-provision) the user:

```bash
bun run apps/keeweb/server/setup-deploy-user.ts
```

## Repository Structure

```text
├── apps/keeweb/          KeeWeb deploy package
│   ├── src/build.ts      Build script (download + config injection)
│   ├── config/           Config templates (nginx, app config)
│   ├── server/           Server provisioning scripts
│   └── deploy.sh         SSH/rsync deploy script
├── packages/cli/         @marcusrbrown/infra CLI (stub)
├── .github/
│   ├── known_hosts       Pinned SSH host keys
│   └── workflows/        CI/CD workflows
└── docs/                 Brainstorms and plans
```

## License

MIT
