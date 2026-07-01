# Credential Broker Deploy Package

OIDC-authenticated credential broker at `broker.fro.bot`. Docker Compose stack (Caddy + Bun service) on a DigitalOcean Droplet. Exchanges a GitHub Actions OIDC token for a short-lived cliproxy API key so the durable provider key never lands on the CI runner.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Docker stack | `docker-compose.yaml` | Caddy + broker (Bun), digest-pinned, Caddy-side healthcheck |
| Caddy config | `config/Caddyfile` | Exposes `/v1/mint` and `/healthz` only; all other paths → 404 |
| Provision droplet | `server/provision-droplet.ts` | One-time. Refuses re-run on existing droplet without `--force` |
| Deploy script | `src/deploy.ts` | Preflight → upload → secrets via stdin → compose up → healthcheck |
| OIDC verification | `src/oidc.ts` | `jose` JWKS verify (RS256 only), replay denylist keyed `(jti, iss)` |
| Trust policy | `src/policy.ts` | `BROKER_TRUST_POLICY` code-owned allowlist constant; `evaluateClaims` |
| Mint/revoke client | `src/mint.ts` | GET-modify-write + read-back, single-flight lock, `ghact-` prefix |
| Sweeper | `src/sweeper.ts` | TTL backstop (60s tick) + reconcile (5 min tick); startup reconcile |
| Audit events | `src/audit.ts` | Structured JSON lines: `mint`, `deny`, `deny-ratelimit`, `revoke`, `error` |
| Host validator | `src/host.ts` | `validateBrokerHost` — rejects `-`-prefixed / out-of-alphabet values |
| CLI commands | `packages/cli/src/commands/broker/` | `status` (MCP-safe), `deploy`, `logs` (CLI-only) |

## DEPLOY FLOW

1. **Preflight** (`preflightChecks`): verifies `CLIPROXY_MANAGEMENT_KEY` is set, then GETs cliproxy `/v0/management/api-keys` with the cliproxy management key. Aborts on 401/403 (key drift) or network failure. No compose change happens until this passes.
2. **Build** (`buildBundle`): runs `bun build src/main.ts --target bun --outfile dist/main.js` (cwd `apps/broker/`). Produces a self-contained ~300KB bundle with `jose` inlined via Web Crypto. Aborts on non-zero exit — no remote mutation happens if the build fails.
3. **Upload**: `docker-compose.yaml`, `config/Caddyfile`, and `dist/main.js` are SCP'd to `/opt/broker/` on the droplet (`dist/main.js` → `/opt/broker/dist/main.js`).
4. **Secrets**: the broker `.env` file (`BROKER_HOST`, `CLIPROXY_MANAGEMENT_URL`, `CLIPROXY_MANAGEMENT_KEY`, `BROKER_AUD`) is written via SSH stdin — never in argv.
5. **Restart**: `docker compose pull && docker compose up -d --force-recreate --wait --wait-timeout 90` from `/opt/broker/`. `--force-recreate` is required because `dist/main.js` is bind-mounted (`ro`) into the broker container and loaded into memory at process start — a bundle-only change leaves the compose spec, image, and env byte-identical, so without `--force-recreate` compose would see no config change and skip recreating the container, leaving the old process running the stale bundle. Named volumes (`caddy_data`, `caddy_config`) persist across recreation, so Let's Encrypt certs are unaffected.
6. **Health gate**: GET `https://<BROKER_HOST>/healthz` confirms the stack is serving.

All SSH calls in a single deploy share one ControlPath socket (avoids UFW rate-limit at 6 connections/30s).

**Critical**: the broker `.env` on the droplet holds the cliproxy management key. The deploy always overwrites it via stdin. Never embed secret bytes in SSH argv.

`dist/main.js` is a deploy-time build artifact — it is gitignored and never committed.

## STARTUP GATE

On boot, the broker runs a reconcile sweep (list cliproxy `api-keys`, delete any `ghact-`-prefixed key not in the in-memory live set) **before** accepting `/v1/mint` requests. `/healthz` serves during startup; `/v1/mint` returns 503 until the startup reconcile completes. This bounds the stale-key window after a restart to the startup reconcile rather than the first periodic tick.

## DOCKER STACK

- **Caddy**: HTTPS termination, auto Let's Encrypt. `restart: unless-stopped`. Healthcheck probes `http://broker:3000/healthz` across the compose network.
- **broker**: `oven/bun` (pinned digest, Renovate-managed). Runs `bun main.js` against the pre-built bundle mounted at `/app/main.js:ro`. No source bind-mount; no node_modules on the droplet. Bun HTTP service on port 3000 (internal only). `restart: unless-stopped`.
- **Volumes**: `caddy_data`, `caddy_config`, `./dist/main.js:/app/main.js:ro` (bundle, read-only).
- **Env file**: `BROKER_HOST`, `BROKER_AUD`, `CLIPROXY_MANAGEMENT_URL`, `CLIPROXY_MANAGEMENT_KEY` injected from host `.env`.

## ONE-TIME PROVISIONING

**Prerequisites:**

- `broker` GitHub Environment created with required reviewer + main-only branch policy (pre-create before merge — auto-create is ungated)
- `fro-bot-broker` Ed25519 keypair generated; public key uploaded to DigitalOcean; `BROKER_SSH_KEY` (private key) in `.env`
- `CLIPROXY_MANAGEMENT_KEY` (the broker→cliproxy management key) in `.env`
- `BROKER_AUD` (the broker-minted OIDC audience value) in `.env`

**Run:**

```bash
bun run provision:broker
```

(Root wrapper — loads the repo-root `.env`; `--cwd apps/broker` would miss it.)

The script will:

1. Validate `doctl` auth
2. Validate `BROKER_HOST` via `validateBrokerHost` before any SSH argv
3. Reject if the `broker` droplet already exists (aborts; `--force` to override)
4. Create the droplet (`docker-20-04`, `s-1vcpu-1gb`, `nyc1`), wait for running state
5. Wait for SSH (`waitForSsh`)
6. Pin the broker FQDN + IP host keys into `.github/known_hosts` (marker-idempotent)
7. Upload `docker-compose.yaml` and `config/Caddyfile`
8. Write the `.env` file via SSH stdin (never argv)
9. Verify Docker is installed
10. Start the compose stack

After provisioning: commit the updated `.github/known_hosts` before the first CI deploy.

### Bootstrap ordering

1. Seed `BROKER_SSH_KEY`, `CLIPROXY_MANAGEMENT_KEY`, `BROKER_AUD` into `.env`
2. `bun run provision:broker` — provisions the droplet and pins host keys
3. Seed `BROKER_HOST` (the broker FQDN, e.g. `broker.fro.bot`) into `.env` + the `broker` GitHub Environment
4. Commit the updated `.github/known_hosts`
5. First deploy: `bunx @marcusrbrown/infra broker deploy`

## REQUIRED SECRETS AND VARIABLES

| Name | Kind | Required | Description |
| --- | --- | --- | --- |
| `BROKER_SSH_KEY` | secret | ✓ | Ed25519 private key for the broker droplet (`fro-bot-broker` keypair) |
| `BROKER_HOST` | secret | ✓ | FQDN of the broker droplet (e.g. `broker.fro.bot`) |
| `CLIPROXY_MANAGEMENT_KEY` | secret | ✓ | cliproxy management key — broker uses this to mint/revoke `api-keys` via the cliproxy management API |
| `BROKER_AUD` | variable | ✓ | OIDC audience value for the broker. Not a secret — it is a cross-context replay defense. Set as a `broker` GitHub Environment **variable** (not a secret). Also required in the local `.env` for provisioning. |

Secrets and the `BROKER_AUD` variable are scoped to the `broker` GitHub Environment. `BROKER_AUD` flows at both provision time (written to the droplet `.env` by `provision-droplet.ts`) and deploy time (passed as `vars.BROKER_AUD` from the `deploy-broker.yaml` workflow).

## CLI COMMANDS

| Command | Purpose |
| --- | --- |
| `bunx @marcusrbrown/infra broker status` | GET `/healthz` on the broker; reports HTTP reachability |
| `bunx @marcusrbrown/infra broker deploy` | Trigger the Deploy Broker workflow via `gh workflow run` (remote, default). `--local` runs `apps/broker/src/deploy.ts` directly. |
| `bunx @marcusrbrown/infra broker logs [--tail N] [--service broker]` | Stream broker service logs over SSH. Logs may contain run identities; operator-only. |

`broker status` is MCP-exposed (read-only). `broker deploy` and `broker logs` are CLI-only (mutating or sensitive).

## DAY-2 OPERATIONS

### Mint/revoke lifecycle

Each `POST /v1/mint` request:
1. Verifies the OIDC JWT (RS256, GitHub issuer, broker-minted audience, `exp`/`nbf`/`jti` replay check).
2. Evaluates claims against `BROKER_TRUST_POLICY` (`repository_id`, `repository_owner_id`, `job_workflow_ref`, `ref`, `ref_type`, `ref_protected`, `event_name`, `runner_environment`, `repository_visibility`).
3. Mints a `ghact-<run_id>-<random>` key via cliproxy management API (GET-modify-write + read-back, single-flight lock).
4. Records the entry in the in-memory live set with a 30-minute TTL.
5. Returns the OpenCode `auth.json` payload (same shape as `apps/cliproxy/AGENTS.md`).

At run end (success/fail/cancel), revocation is handled exclusively by the TTL sweeper and reconcile — there is no run-end revoke endpoint. The sweeper is the mandatory backstop.

### TTL sweeper and reconcile

- **Sweep tick** (every 60s): for each live entry past `expiresAt`, revokes the key via cliproxy DELETE and removes it from the live set. A single revoke failure is logged and does not block the rest of the sweep.
- **Reconcile tick** (every 5 min): lists cliproxy `api-keys`, deletes any `ghact-`-prefixed key not in the live set. Recovers from a broker restart where the live set is empty but stale keys remain. **Safety invariant**: reconcile never deletes a non-`ghact-` key.
- **Startup reconcile**: runs once on boot before `/v1/mint` is unblocked (see Startup Gate above).

### Reading audit events

Audit events are JSON lines written to stdout by the broker container. Each event carries:

```json
{
  "type": "broker-audit",
  "ts": "<ISO-8601>",
  "srcIp": "<ip>",
  "runId": "<run_id>",
  "jti": "<jti>",
  "repositoryId": "<repo_id>",
  "workflowRef": "<workflow_ref>",
  "decision": "mint|deny|deny-ratelimit|revoke|error",
  "reason": "<human-readable>"
}
```

**Never** contains token bytes, the minted key value, the OIDC bearer, or the management key. Stream with `bunx @marcusrbrown/infra broker logs`.

Decision values:
- `mint` — key successfully minted
- `deny` — OIDC verification or policy check failed
- `deny-ratelimit` — per-repo or global rate limit exceeded
- `revoke` — key revoked (sweeper or run-end)
- `error` — unexpected error during mint (cliproxy unreachable, etc.)

### Management key rotation

If `CLIPROXY_MANAGEMENT_KEY` must be rotated:

1. Update the key in the `broker` GitHub Environment secret.
2. Update the key in the local `.env`.
3. Run `bunx @marcusrbrown/infra broker deploy` — the deploy writes the new key to the droplet `.env` via SSH stdin.
4. Verify with `bunx @marcusrbrown/infra broker status`.

Do not edit the `.env` on the droplet directly — the next deploy overwrites it. Do not rotate the key in-place without updating the GitHub Environment secret first (the next CI deploy would revert to the old value).

### Monitoring

- `bunx @marcusrbrown/infra broker status` — HTTP reachability via `/healthz`.
- `bunx @marcusrbrown/infra broker logs` — stream audit events and service output.
- Unified `bunx @marcusrbrown/infra status` — includes a broker row.

## ANTI-PATTERNS

- **Never log token or key material** — the OIDC bearer, the minted key, the management key, and raw claim payloads must never appear in logs, error responses, or audit events. The `Authorization` header is always redacted before any logging.
- **Never full-array PUT against cliproxy `api-keys`** — always GET → append single key → PUT → GET-back and assert presence. A wholesale replace drops other consumers' keys. The single-flight lock serializes all mint and revoke operations; never issue parallel management-API mutations.
- **Never retry on HTTP error from the management API** — cliproxy IP-bans the caller after ~5 consecutive bad-key attempts (~30 min). Throw immediately on 401/403; bounded retry only on read-back mismatch.
- **Never touch non-`ghact-` keys** — the sweeper and reconcile only delete keys starting with `ghact-`. Durable keys and other consumers' keys are never touched.
- **Never skip `validateBrokerHost`** — it rejects `-`-prefixed values and characters outside the allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`).
- **Never pass secret bytes via argv** — the broker `.env` (management keys, `BROKER_AUD`) is written via SSH stdin only. `--body <value>` patterns are banned.
- **Never use `ssh-keyscan` in CI** — host keys are pinned in `.github/known_hosts` at provision time and committed. Provisioning scripts may use `ssh-keyscan` locally.
- **Never scale the broker horizontally** — the single-flight lock is valid only because there is exactly one broker instance (single droplet). Scaling out breaks the lock invariant and requires a distributed lock or CAS-capable management API.
- **Pattern A capability caveat** — a minted key is fungible with the durable cliproxy key for its TTL. cliproxy has no per-key capability surface, so the security property delivered is **short-lived + revocable + off-runner**, not capability-restricted. In-run abuse during the TTL window is a documented non-goal (requires Pattern B / egress containment, deferred).

## NOTES

- **Trust policy**: `BROKER_TRUST_POLICY` in `apps/broker/src/policy.ts` pins the `fro-bot/agent` harness integrate identity — `repository_id` `1126485011`, `repository_owner_id` `80104189`, and `job_workflow_ref` `fro-bot/agent/.github/workflows/harness-integrate.yaml@refs/heads/main`. The broker pins `job_workflow_ref` (the reusable integrate file that requests the token), not `workflow_ref` (which is the `harness-release` caller). `repository_visibility` is `public` (fro-bot/agent is a public repo). Values sourced from `fro-bot/agent#1081` and verified against the live GitHub API. If the integrate workflow file, ref, or repo identity changes, update the policy and redeploy.
- **Cross-repo integration**: the consuming side (OIDC token request at audience `https://broker.fro.bot`, broker call, `auth.json` injection) lands in `fro-bot/agent` via `harness-integrate.yaml` — see `fro-bot/agent#1081`. The mint fails closed until this policy matches the integrate workflow's OIDC claims.
- **Broker→cliproxy reachability**: the broker runs on its own separate DigitalOcean droplet (not co-located with cliproxy). It reaches cliproxy over the public internet via `https://cliproxy.fro.bot`. The hairpin concern (DO droplets don't NAT-loopback) does not apply here — that only affects same-host container-to-container calls.
- **Pre-first-deploy checklist**: create the `broker` GitHub Environment (reviewer + main-only) before merging the deploy workflow; add `broker`-scoped secrets after the environment is gated; pin broker FQDN host keys in both `.github/known_hosts` and `packages/cli/src/resources/known_hosts` (byte-identical).
- **First deploy**: budget for a live contract cascade (host-key domain pin, SSH identity, paths-filter glob, ControlMaster). After the first deploy, author a `docs/solutions/` compound doc capturing cascade waves and any mint/revoke surprises.
- **Secrets**: `BROKER_SSH_KEY`, `BROKER_HOST`, and `CLIPROXY_MANAGEMENT_KEY` are scoped to the `broker` GitHub Environment. `DIGITALOCEAN_ACCESS_TOKEN` is repo-level.
- **Run provisioning via the root wrapper**: `bun run provision:broker` (loads the repo-root `.env`; `bun run --cwd apps/broker provision` would miss it).
