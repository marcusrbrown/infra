# CLIProxyAPI

[![Deploy CLIProxy](https://github.com/marcusrbrown/infra/actions/workflows/deploy-cliproxy.yaml/badge.svg)](https://github.com/marcusrbrown/infra/actions/workflows/deploy-cliproxy.yaml)

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

### Anthropic auth monitoring

`infra cliproxy monitor` probes the Anthropic route and reconciles one canonical GitHub issue with transition-only alerts to a dedicated Discord webhook, using a `gh api` subprocess (parsed with Zod) rather than a direct REST client. The repository workflow at `.github/workflows/cliproxy-auth-monitor.yaml` runs at a nominal 15-minute cadence (`7,22,37,52` minutes past the hour); GitHub schedule delivery is best-effort. Manual validation supports `live`, `synthetic-dead`, and `synthetic-healthy`; synthetic Discord alerts are prefixed `[synthetic test]`. Synthetic modes are owner-only, use an isolated test identity, and never probe Anthropic or mutate production monitor state. Running the command directly (outside the workflow) requires `gh` locally; the scheduled workflow already provides it and is the preferred entrypoint. See [`apps/cliproxy/AGENTS.md`](AGENTS.md) for the label-trust-anchor issue-adoption policy.

Configure repository secrets `CLIPROXY_API_KEY` and `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK`. The latter must be a dedicated outbound Discord webhook, not the gateway inbound webhook. Do not log its URL. The monitor uses the canonical non-secret proxy default and emits fixed safe summaries; raw provider errors are not sent to public issue or Discord surfaces.

Recovery: run `bunx @marcusrbrown/infra cliproxy login claude`; when the browser reaches the localhost connection-refused page, paste the full callback URL into the login prompt. Verify with `bunx @marcusrbrown/infra cliproxy status`, then trigger an immediate manual live monitor run. To roll back, disable or revert the monitor workflow or rotate/remove its Discord secret; issue history remains intact.

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
bunx @marcusrbrown/infra cliproxy monitor                   # Anthropic auth monitor
```

`cliproxy setup` generates an API key, sets `OPENCODE_AUTH_JSON` and `OPENCODE_CONFIG` secrets on the target repo, and verifies the connection. Non-interactive flags: `--key`, `--repo`, `--harness`, `--providers`, `--model`, `--force`, `--dry-run`, `--verify-smoke`.
