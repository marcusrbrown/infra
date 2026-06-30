# apps/broker

OIDC-authenticated credential broker for the Fro Bot harness pipeline. Exchanges a GitHub Actions OIDC token for a short-lived cliproxy API key so the durable provider key never lands on the CI runner.

Deployed at `broker.fro.bot` on a DigitalOcean Droplet (Docker Compose: Caddy + Bun service).

For operational detail — deploy flow, day-2 operations, required secrets, and anti-patterns — see [`AGENTS.md`](AGENTS.md).

## Quick reference

```bash
bunx @marcusrbrown/infra broker status   # HTTP reachability via /healthz
bunx @marcusrbrown/infra broker deploy   # Trigger Deploy Broker workflow (GitHub Actions)
bunx @marcusrbrown/infra broker logs     # Stream service logs over SSH
bun run provision:broker                 # One-time droplet provisioning (loads root .env)
bun run deploy:broker                    # Local deploy (loads root .env)
```

## How it works

1. The `fro-bot/agent` integrate job requests a GitHub Actions OIDC token for the broker's audience.
2. The job POSTs the token to `https://broker.fro.bot/v1/mint`.
3. The broker verifies the token (RS256, GitHub issuer, replay check) and evaluates claims against the code-owned `BROKER_TRUST_POLICY`.
4. On pass, the broker mints a `ghact-<run_id>-<random>` key in cliproxy via the management API and returns an OpenCode `auth.json` payload.
5. At run end, the key is revoked. A TTL sweeper (60s tick) and reconcile sweep (5 min tick) are the mandatory backstop for crashed or cancelled runs.

The durable cliproxy key stays inside the broker boundary. The runner holds only a short-lived, revocable key for the duration of the run.
