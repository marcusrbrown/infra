# KeeWeb

[![Deploy KeeWeb](https://github.com/marcusrbrown/infra/actions/workflows/deploy-keeweb.yaml/badge.svg)](https://github.com/marcusrbrown/infra/actions/workflows/deploy-keeweb.yaml)

Self-hosted KeeWeb v1.18.7 password manager at [kw.igg.ms](https://kw.igg.ms).

Download-based build: `src/build.ts` fetches the upstream release archive from GitHub Releases, verifies its SHA-256, and produces a deploy-ready `dist/`. The Dropbox app secret is injected into `dist/config.json` at build time. The only Bash script in the repo is `apps/keeweb/deploy.sh`; all other scripts are TypeScript run via `bun run`.

## Build

Downloads the KeeWeb release zip (cached in `.cache/`), verifies SHA-256, clears and rebuilds `dist/`, and injects `DROPBOX_APP_SECRET` into `dist/config.json`:

```bash
bun run --cwd apps/keeweb build
```

With the Dropbox secret (required in CI; tolerated as empty locally):

```bash
DROPBOX_APP_SECRET=<value> bun run --cwd apps/keeweb build
```

`config/config.json` is the template and is never modified. The secret goes only into `dist/config.json`.

## Deploy

Pushes `dist/` to the server via SSH/rsync and runs the activation script. Build must complete before deploying — `deploy.sh` validates that `dist/index.html` and `dist/config.json` exist.

```bash
bash apps/keeweb/deploy.sh           # content only (safe default)
bash apps/keeweb/deploy.sh --nginx   # content + nginx config
```

The `--nginx` flag backs up the existing config, uploads the new one, runs `nginx -t`, and reloads. On failure it auto-restores the backup. Nginx config deploy requires the explicit flag — content-only is the default.

Via the CLI (triggers GitHub Actions by default):

```bash
bunx @marcusrbrown/infra keeweb deploy                  # remote (GitHub Actions)
bunx @marcusrbrown/infra keeweb deploy --local          # direct SSH (content only)
bunx @marcusrbrown/infra keeweb deploy --local --nginx  # direct SSH + nginx config
bunx @marcusrbrown/infra keeweb deploy --dry-run        # validate without triggering
```

Local deploy requires `ssh-agent` running with the deploy key loaded (`SSH_AUTH_SOCK`).

## Provisioning

One-time server setup — creates the `deploy-kw` user, sets up scoped sudo for the activation script, and configures the site directory:

```bash
bun run apps/keeweb/server/setup-deploy-user.ts
```

Run locally via `bun run` (not `--cwd`); SSHes into the server directly.

## Configuration

GitHub Environment: **`keeweb`**

| Secret               | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `DEPLOY_SSH_KEY`     | Ed25519 private key for `deploy-kw@box.heatvision.co`          |
| `DROPBOX_APP_SECRET` | Dropbox app client credential injected into `dist/config.json` |

`DROPBOX_APP_SECRET` must be set and non-empty in CI — `build.ts` throws if it is absent. Locally, an empty value is tolerated (Dropbox storage disabled).

## Operations

Runbooks, anti-patterns, and server layout: [`apps/keeweb/AGENTS.md`](AGENTS.md).

Key operational notes:

- Never commit a real `dropboxSecret` — the template stays empty; CI injects from env.
- Never run `deploy.sh` without building first.
- Never deploy nginx config without `--nginx`.

## CLI

```bash
bunx @marcusrbrown/infra keeweb status   # HTTP check, last deploy, content hash
bunx @marcusrbrown/infra keeweb deploy   # trigger GitHub Actions workflow (default)
bunx @marcusrbrown/infra keeweb open     # open https://kw.igg.ms in default browser
```
