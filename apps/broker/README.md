# Broker

[![Deploy Broker](https://github.com/marcusrbrown/infra/actions/workflows/deploy-broker.yaml/badge.svg)](https://github.com/marcusrbrown/infra/actions/workflows/deploy-broker.yaml)

OIDC-authenticated credential broker at [broker.fro.bot](https://broker.fro.bot).

Docker Compose stack (Caddy + Bun service) on a DigitalOcean droplet. Exchanges a GitHub Actions OIDC token for a short-lived cliproxy API key so the durable provider key never lands on a CI runner. A `POST /v1/mint` request verifies the OIDC JWT (RS256, GitHub issuer, replay check via `(jti, iss)` denylist), evaluates claims against the code-owned `BROKER_TRUST_POLICY` allowlist, mints a `ghact-<runId>-<expiresAtEpochMs>-<hexrand>` key via the cliproxy management API, and returns an OpenCode `auth.json` payload. A TTL sweeper (60s tick) and reconcile sweep (5 min tick) are the mandatory backstop that revokes expired keys — there is no run-end revoke endpoint.

## Deploy

Preflights the cliproxy management key, builds a self-contained bundle (`bun build src/main.ts --target bun --outfile dist/main.js`), uploads `docker-compose.yaml`, `config/Caddyfile`, and `dist/main.js`, writes the broker `.env` via SSH stdin, then `docker compose pull && docker compose up -d --force-recreate --wait` and health-gates on `/healthz`.

```bash
bun run --cwd apps/broker deploy
```

Via the root wrapper (loads the repo-root `.env`):

```bash
bun run deploy:broker
```

Via the CLI (triggers GitHub Actions by default):

```bash
bunx @marcusrbrown/infra broker deploy           # remote (GitHub Actions)
bunx @marcusrbrown/infra broker deploy --local   # direct SSH
```

## Provisioning

One-time: creates the DigitalOcean droplet (`docker-20-04`, `s-1vcpu-1gb`, `nyc1`), pins the broker FQDN and IP host keys, uploads the Compose stack, and writes the initial `.env`. Refuses to re-run against an existing droplet without `--force`.

Use the root wrapper (loads the repo-root `.env`):

```bash
bun run provision:broker
```

After provisioning, commit the updated `.github/known_hosts` before the first CI deploy.

## Configuration

GitHub Environment: **`broker`**

| Name | Kind | Description |
| --- | --- | --- |
| `BROKER_SSH_KEY` | secret | Ed25519 private key for the broker droplet (`fro-bot-broker` keypair) |
| `BROKER_HOST` | secret | FQDN of the broker droplet |
| `CLIPROXY_MANAGEMENT_KEY` | secret | cliproxy management key — the broker uses this to mint/revoke `api-keys` via the cliproxy management API |
| `BROKER_AUD` | variable | OIDC audience value for the broker (not a secret — a cross-context replay defense). Flows at both provision time and deploy time |

Repository secret: `DIGITALOCEAN_ACCESS_TOKEN` (used by the provision script).

## Operations

Deploy flow internals, mint/revoke lifecycle, sweeper/reconcile detail, key rotation, trust policy, and anti-patterns: [`apps/broker/AGENTS.md`](AGENTS.md).

Key operational notes:

- Never log token or key material — the OIDC bearer, minted key, management key, and raw claims never appear in logs or audit events.
- Never full-array `PUT` against cliproxy `api-keys` — always GET → append → PUT → read-back verify. A single-flight lock serializes all mint/revoke calls.
- Never scale the broker horizontally — the single-flight lock is only valid for exactly one broker instance.
- Never skip `validateBrokerHost` — it rejects `-`-prefixed values that SSH treats as flags.
- Never pass secret bytes via argv — the broker `.env` is written via SSH stdin only.

## CLI

```bash
bunx @marcusrbrown/infra broker status                       # HTTP reachability via /healthz
bunx @marcusrbrown/infra broker deploy                       # trigger GitHub Actions workflow
bunx @marcusrbrown/infra broker logs [--tail N] [--service broker]  # stream service logs over SSH
```

`broker status` is MCP-exposed (read-only). `broker deploy` and `broker logs` are CLI-only.
