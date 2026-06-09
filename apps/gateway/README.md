# Gateway

[![Deploy Gateway](https://github.com/marcusrbrown/infra/actions/workflows/deploy-gateway.yaml/badge.svg)](https://github.com/marcusrbrown/infra/actions/workflows/deploy-gateway.yaml)

Fro Bot Discord client and workspace runner at [gateway.fro.bot](https://gateway.fro.bot).

Three-service Docker Compose stack (gateway daemon, workspace executor, mitmproxy egress filter) on a dedicated DigitalOcean droplet. The upstream source is `fro-bot/agent`, pinned to the ref in [`apps/gateway/upstream.json`](upstream.json). The deploy builds Docker images in CI and pushes them to GHCR; the droplet only pulls prebuilt artifacts — it never builds images. Secrets are materialized as files on the droplet via SSH stdin, never via argv.

## Deploy

The deploy runs in two CI stages: `build-images` builds and pushes the `gateway` and `workspace` images to GHCR, then `deploy-gateway` SSHes to the droplet to pull those images and bring up the stack. Completion is gated on Discord command registration.

Via the CLI (triggers GitHub Actions by default):

```bash
bunx @marcusrbrown/infra gateway deploy             # remote (GitHub Actions)
bunx @marcusrbrown/infra gateway deploy --local     # direct SSH (requires SSH_AUTH_SOCK)
bunx @marcusrbrown/infra gateway deploy --dry-run   # validate without triggering
```

Via the root wrapper (loads the repo-root `.env`):

```bash
bun run deploy:gateway
```

To upgrade the upstream daemon, update the `ref` in `apps/gateway/upstream.json` and trigger a deploy.

## Provisioning

One-time: creates the DigitalOcean droplet, bootstraps Docker and firewall, and pins host keys. Refuses to re-run against an existing droplet without `--force`.

**Prerequisites:**

- `DIGITALOCEAN_ACCESS_TOKEN` and `GATEWAY_HOST` in the repo-root `.env`; `doctl auth init` run locally
- Discord application created with bot scope; token, application ID, and guild ID captured
- S3 or R2 bucket created; access key, secret key, bucket name, and region captured
- `gateway` GitHub Environment created with required reviewer set and all required secrets seeded

Use the root wrapper (loads the repo-root `.env`):

```bash
bun run provision:gateway
```

After provisioning, commit the updated `.github/known_hosts` before the first CI deploy.

## Configuration

GitHub Environment: **`gateway`**

Upstream pin: `apps/gateway/upstream.json` — update the `ref` field to upgrade the daemon.

### Required secrets

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
| `WORKSPACE_OPENCODE_AUTH` | ✓ | OpenCode provider `auth.json` for the workspace (dedicated scoped cliproxy key) |
| `WORKSPACE_OPENCODE_MODEL` | ✓ | OpenCode model ID for the mention loop |
| `WORKSPACE_OPENCODE_CONFIG` | ✓ | OpenCode provider/baseURL config JSON (JSON-validated, `$`-escaped) |
| `GATEWAY_TRIGGER_ROLE_ID` | ✓ | Discord role ID allowed to trigger the `@fro-bot` mention loop (fail-closed; required) |
| `S3_ENDPOINT` | — | Custom endpoint URL (R2, MinIO, etc.) |
| `WORKSPACE_OPENCODE_URL` | — | Override workspace OpenCode proxy URL |
| `OBJECT_STORE_HOSTS` | — | Comma-separated hostnames allowed through mitmproxy egress |
| `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` | — | Workspace OpenCode supervisor ready timeout in ms (default: 60000) |
| `DISCORD_PRIVILEGED_INTENTS` | — | Opt-in privileged intents (e.g. `MessageContent`) |
| `GATEWAY_WEBHOOK_SECRET` | opt-in† | HMAC key for the announce webhook — set with `GATEWAY_PRESENCE_CHANNEL_ID` |
| `GATEWAY_PRESENCE_CHANNEL_ID` | opt-in† | Discord channel ID for presence embeds — set with `GATEWAY_WEBHOOK_SECRET` |
| `GATEWAY_IMAGE_DIGEST` | CI-injected | `sha256:<digest>` of the gateway image from `build-images` job |
| `WORKSPACE_IMAGE_DIGEST` | CI-injected | `sha256:<digest>` of the workspace image from `build-images` job |

†Both-or-neither: set both to enable the announce/presence webhook; leave both unset to keep the gateway outbound-only. Setting exactly one fails the deploy before any SSH.

Repository secret: `DIGITALOCEAN_ACCESS_TOKEN` (used by the provision script).

## Operations

Full deploy flow, day-2 operations, CA restore procedure, secret rotation, break-glass runbook, and anti-patterns: [`apps/gateway/AGENTS.md`](AGENTS.md).

Key operational notes:

- Never pass secret bytes via argv — `writeRemoteFile` pipes via SSH stdin only.
- Never skip `validateGatewayHost` — it rejects `-`-prefixed values that SSH treats as flags.
- Never restart the gateway in-place to rotate the CA — restore from backup instead.
- Never run `docker compose up --build` on the droplet — build from a workstation and push to GHCR.
- Never run `docker compose down -v` — destroys `caddy_data`, `mitmproxy-certs`, and `workspace-repos` volumes.
- Post-deploy verification ritual is in `apps/gateway/AGENTS.md` (status → logs → clone smoke → mention round-trip).

## CLI

```bash
bunx @marcusrbrown/infra gateway status                              # SSH, docker compose ps, service states
bunx @marcusrbrown/infra gateway deploy                              # trigger GitHub Actions workflow
bunx @marcusrbrown/infra gateway logs <service> [--tail N]           # stream container logs (gateway/workspace/mitmproxy)
bunx @marcusrbrown/infra gateway backup --include-ca [--output FILE] # pull mitmproxy CA as tarball (mode 0600)
bunx @marcusrbrown/infra gateway restore --include-ca --input FILE   # validate and restore CA tarball
```

`gateway logs` requires `--allow-ci` in CI/headless contexts (discourages scripted log capture of unredacted output). `--tail` defaults to 50.
