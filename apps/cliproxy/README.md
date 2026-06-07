# CLIProxyAPI

OAuth-authenticated Claude proxy at [cliproxy.fro.bot](https://cliproxy.fro.bot).

Docker Compose stack (Caddy + `cli-proxy-api`) on a DigitalOcean droplet. CLI clients authenticate with bearer API keys; the proxy forwards requests to Claude using stored OAuth tokens. Caddy handles HTTPS termination with automatic Let's Encrypt certificates. OAuth tokens persist in the `cliproxy_auth` named volume across container recreates.

## Deploy

Uploads `Caddyfile`, `docker-compose.yaml`, and `config.yaml` (skipped if it already exists on the server — preserves runtime API keys), then pulls images and restarts the stack. A preflight management-key check runs before any upload; a health gate confirms the proxy is up after restart.

```bash
bun run --cwd apps/cliproxy deploy
```

Via the root wrapper (loads the repo-root `.env`):

```bash
bun run deploy:cliproxy
```

Via the CLI (triggers GitHub Actions by default):

```bash
bunx @marcusrbrown/infra cliproxy deploy                        # remote (GitHub Actions)
bunx @marcusrbrown/infra cliproxy deploy --local                # direct SSH
bunx @marcusrbrown/infra cliproxy deploy --local --force-config # overwrite server config.yaml
bunx @marcusrbrown/infra cliproxy deploy --dry-run              # validate without triggering
```

`--force-config` is the only safe way to overwrite `config.yaml` on the server — it wipes runtime API keys if used carelessly (see [`apps/cliproxy/AGENTS.md`](AGENTS.md)).

## Provisioning

One-time: creates the DigitalOcean droplet, bootstraps Docker and firewall, and sets the management password. Refuses to re-run against an existing droplet without `--force`.

Use the root wrapper (loads the repo-root `.env`):

```bash
bun run provision:cliproxy
```

`DIGITALOCEAN_ACCESS_TOKEN` must be set in the repo-root `.env`. The SSH key used for provisioning is looked up by name in DigitalOcean (`CLIPROXY_SSH_KEY_NAME`, default `fro-bot-cliproxy`).

After provisioning, commit the updated `.github/known_hosts`.

## Configuration

GitHub Environment: **`cliproxy`**

| Secret                    | Description                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| `CLIPROXY_SSH_KEY`        | Ed25519 private key for the `cliproxy.fro.bot` droplet                       |
| `CLIPROXY_MANAGEMENT_KEY` | Management API bearer token — must match the droplet's `MANAGEMENT_PASSWORD` |
| `CLIPROXY_DOMAIN`         | FQDN of the CLIProxyAPI instance                                             |

Repository secret: `DIGITALOCEAN_ACCESS_TOKEN` (used by the provision script).

Local `.env`: `CLIPROXY_MANAGEMENT_KEY` must match the `MANAGEMENT_PASSWORD` set during provisioning (printed once at provision time).

## Operations

Runbooks, management API surface, anti-patterns, and incident history: [`apps/cliproxy/AGENTS.md`](AGENTS.md).

Key operational notes:

- Never overwrite `config.yaml` on the server without `--force-config` — it wipes runtime API keys.
- Never re-run `provision-droplet.ts` against an existing droplet without `--force`.
- OAuth tokens auto-refresh in the `cliproxy_auth` volume. Manual refresh: `cliproxy login claude`.
- API key backup: `cliproxy config get --output backup.json` (creates file with mode 0600).

## CLI

```bash
bunx @marcusrbrown/infra cliproxy status                    # HTTP check, version, usage stats
bunx @marcusrbrown/infra cliproxy deploy                    # trigger GitHub Actions workflow
bunx @marcusrbrown/infra cliproxy config get                # read runtime config
bunx @marcusrbrown/infra cliproxy config set <field> <val>  # update a config field
bunx @marcusrbrown/infra cliproxy keys list                 # list API keys
bunx @marcusrbrown/infra cliproxy keys add <name>           # add an API key
bunx @marcusrbrown/infra cliproxy keys remove <name>        # remove an API key
bunx @marcusrbrown/infra cliproxy login claude              # OAuth login (SSH + TTY)
bunx @marcusrbrown/infra cliproxy open                      # open built-in TUI via SSH
bunx @marcusrbrown/infra cliproxy setup                     # interactive onboarding wizard
```

`cliproxy setup` generates an API key, sets `OPENCODE_AUTH_JSON` and `OPENCODE_CONFIG` secrets on the target repo, and verifies the connection. Non-interactive flags: `--key`, `--repo`, `--harness`, `--providers`, `--model`, `--force`, `--dry-run`, `--verify-smoke`.
