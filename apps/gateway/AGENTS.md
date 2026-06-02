# Gateway Deploy Package

The gateway is the Fro Bot Discord client and workspace runner — a 3-service Docker Compose stack (gateway daemon, workspace executor, mitmproxy egress filter) deployed on a dedicated DigitalOcean droplet at `gateway.fro.bot`. The upstream source is `fro-bot/agent`, pinned to `v0.50.0` in `apps/gateway/upstream.json` — the first release that ships the real workspace executor (a Hono service exposing `/healthz` + `/clone` on `:9100` and an OpenCode bearer proxy on `:9200`, all on the internal `sandbox-net` with no host ports), replacing the prior idle placeholder. This enables both `/fro-bot add-project` repo cloning and the `@fro-bot` mention loop (Discord-message-triggered OpenCode execution routed through `cliproxy.fro.bot`). The Renovate ceiling is `<0.51.0` (allow v0.50.x patch/hotfix; v0.51.0+ needs a deliberate source-contract pass). The deploy materializes GitHub App credentials (`github-app-id`, `github-app-private-key`) so `/fro-bot add-project` can clone target repos via the App token, plus the workspace OpenCode credentials and a required Discord trigger-role authz gate for the mention loop. There is no public HTTP surface; the gateway connects outbound to Discord, S3, and (via the mitmproxy egress allowlist) the cliproxy endpoint only. Management happens via SSH and the `bunx @marcusrbrown/infra gateway *` CLI commands.

The deploy script materializes secrets as files on the droplet (never via argv), bootstraps the mitmproxy CA on first run, brings up the Compose stack, and gates completion on Discord command registration. A secrets checksum written only after a fully successful deploy prevents silent stale-credentials states across retries.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Upstream pin | `apps/gateway/upstream.json` | `fro-bot/agent` ref — update to upgrade |
| Deploy script | `apps/gateway/src/deploy.ts` | Secrets materialization, compose up, registration poll |
| Provision droplet | `apps/gateway/server/provision-droplet.ts` | One-time. Refuses re-run on existing droplet without `--force` |
| CLI commands | `packages/cli/src/commands/gateway/` | status, deploy, logs, backup, restore |

## DEPLOY FLOW

1. **Validate host** — `validateGatewayHost` rejects `-`-prefixed values and characters outside the allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`); this check is mandatory before any SSH invocation.
2. **Checksum computation** — SHA-256 of all secret values is computed locally. The result is compared against `/opt/gateway/.secrets-checksum` on the droplet. If the checksums differ, `--force-recreate` is added to `docker compose up` so containers pick up the new secret files. If they match, containers are still restarted by `docker compose up -d --wait` but without `--force-recreate` (faster). In both cases the deploy continues — there is no early exit. The checksum file lives outside the deploy clone so `git clean -xfd` on subsequent deploys doesn't wipe it.
3. **Source materialization** — SSH to the droplet; clone or fetch `fro-bot/agent` at the pinned ref from `upstream.json`, then `git reset --hard && git clean -xfd` to the pinned SHA.
4. **Secret files** — 11 required files written atomically under `/opt/gateway/deploy/secrets/` (`discord-token`, `discord-application-id`, `discord-guild-id`, `aws-access-key-id`, `aws-secret-access-key`, `s3-bucket`, `s3-region`, `github-app-id`, `github-app-private-key`, `workspace-opencode-token`, `workspace-opencode-auth`) plus optional-shaped files (`s3-endpoint`, `aws-session-token`, `discord-privileged-intents`, `workspace-opencode-url`, and `gateway-trigger-role-id` — written as 0-byte placeholders when unset, though `GATEWAY_TRIGGER_ROLE_ID` is enforced non-empty via `REQUIRED_ENV_VARS`, so the mention-loop authz gate fails closed rather than opening to all guild members). The `/opt/gateway/deploy/.env` carries `OBJECT_STORE_HOSTS` (computed from `S3_BUCKET`/`S3_REGION`/`S3_ENDPOINT`) plus `WORKSPACE_OPENCODE_MODEL` and `WORKSPACE_OPENCODE_CONFIG` — the latter is JSON-validated (via `JSON.parse`, not the shell-metachar guard) and `$`→`$$`-escaped so docker-compose `${VAR}` interpolation passes the JSON through intact. Secret bytes enter via SSH stdin only — never via argv. Filenames on disk are kebab-case; the compose contract maps each to `/run/secrets/<snake_case>` and exposes via `${NAME}_FILE` env vars. The GitHub App credentials come from the `GH_APP_ID` / `GH_APP_PRIVATE_KEY` environment secrets (GitHub reserves the `GITHUB_` prefix for secret names) and materialize to the upstream-fixed `github-app-id` / `github-app-private-key` files. See `docs/runbooks/discord-token-lifecycle.md` for the full mapping table.
5. **CA bootstrap** — `init-certs.sh` runs on the droplet (idempotent; skips if the CA already exists in the `mitmproxy-certs` named volume).
6. **Compose up** — `docker compose up -d --wait --wait-timeout 120`. mitmproxy starts first, then the gateway daemon.
7. **Registration poll** — `GET /applications/{app_id}/guilds/{guild_id}/commands` on the Discord API. Polls Discord registration with ~90s default budget (10 attempts × (3s interval + 6s per-attempt timeout); defaults from `apps/gateway/src/deploy.ts:344-368`). 429 honors `Retry-After` and doesn't count against the attempt budget (each 429 retry adds up to 60s; pathological all-429 ceiling ~11 min). 401/403/404 abort immediately with token-sanitized errors. 5xx retries.
8. **Checksum write** — `/opt/gateway/.secrets-checksum` is written only after compose + registration both succeed. If either fails mid-rotation, the old checksum persists and the next deploy force-recreates again.

## DAY-2 OPERATIONS

- **Monitoring** — GitHub Actions deploy logs for the deploy run; `gateway status` for live service states; `gateway logs <service>` to stream container output.
- **Roll back a bad upstream pin or repo change** — revert the commit (or revert `apps/gateway/upstream.json` to a known-good ref) and dispatch `Deploy Gateway`. The deploy is idempotent; containers either updated or didn't.
- **Roll back a bad secret rotation** — restore the previous value in the `gateway` GitHub Environment and redeploy. The checksum-after-success invariant means a failed rotation leaves the old checksum in place, so the next deploy will force-recreate — but the credential value must be rolled back manually first.
- **A failed deploy does not destroy the live droplet** — containers either updated or didn't. Fix the underlying issue and retry; the deploy is safe to re-run.
- **Scaling or region change** — provision a new droplet, update `GATEWAY_HOST` in the GitHub Environment, commit the updated `.github/known_hosts`, and trigger a deploy. Decommission the old droplet after verifying the new one is healthy.

## CLI COMMANDS

| Command | Purpose |
| --- | --- |
| `bunx @marcusrbrown/infra gateway status` | SSH to droplet, run `docker compose ps`, show service states + ages + healthchecks |
| `bunx @marcusrbrown/infra gateway deploy` | Trigger the deploy workflow via `gh workflow run` (remote, default). `--local` runs the deploy script directly (requires `SSH_AUTH_SOCK`). `--dry-run` prints the plan without side effects. |
| `bunx @marcusrbrown/infra gateway logs <service> [--tail N]` | Stream `docker compose logs` from the droplet. Services: `gateway`, `workspace`, `mitmproxy`. `--tail` defaults to 50. Logs surface unredacted; operator-only via SSH boundary. CI/headless contexts require explicit `--allow-ci` to discourage scripted log capture. |
| `bunx @marcusrbrown/infra gateway backup [--output FILE] [--include-ca]` | Pull the mitmproxy CA cert + key from the `mitmproxy-certs` named volume as a tarball. Local file created with mode 0600 via `O_EXCL\|O_CREAT` (no chmod race). `--include-ca` is required (only CA backup is currently implemented). |
| `bunx @marcusrbrown/infra gateway restore --input FILE [--include-ca]` | Validate the tarball locally (must contain exactly `mitmproxy-ca-cert.pem` + `mitmproxy-ca.pem`; otherwise rejected before any remote mutation), upload to an unguessable `mktemp` path, extract into the named volume, restart mitmproxy + gateway, byte-equal confirm restored cert + key match the input archive. |

## ONE-TIME PROVISIONING

**Prerequisites:**

- `DIGITALOCEAN_ACCESS_TOKEN` and `GATEWAY_HOST` in `.env`; `doctl auth init` run locally. `GATEWAY_HOST` is the FQDN used for host-key pinning (e.g. `gateway.fro.bot`) — DNS does not need to point at the new droplet yet.
- Discord application created at <https://discord.com/developers/applications> with bot scope; token + application ID + guild ID captured
- S3 or R2 bucket created; `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_REGION` captured (add `S3_ENDPOINT` for R2/MinIO)
- `gateway` GitHub Environment created with required reviewer set
- All required secrets seeded in the `gateway` GitHub Environment (see [Required Secrets](#required-secrets) below)

**Run:**

```bash
bun run provision:gateway
```

(Root wrapper — loads the repo-root `.env`; `--cwd apps/gateway` would miss it.)

The script will:

1. Confirm `doctl` is authenticated
2. Reject if a `gateway` droplet already exists (aborts; `--force` to override)
3. Create an `s-1vcpu-2gb` droplet in `nyc1`, tagged `gateway`
4. Append unhashed domain host keys and hashed IP host keys to `.github/known_hosts` (`ssh-keyscan <domain>` + `ssh-keyscan -H <ip>`)
5. Print operator setup steps for finalizing the GitHub Environment

SSH auth during provisioning: when `GATEWAY_SSH_KEY` is set, the script materializes it to a `0600`
temp key file and pins it with `-i` + `IdentitiesOnly=yes` (no ssh-agent needed; cleaned up after).
When unset, it falls back to ssh-agent.

After provisioning: commit the updated `.github/known_hosts`.

## REQUIRED SECRETS

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
| `GATEWAY_HOST` | ✓ | FQDN or IP of the droplet |
| `GH_APP_ID` | ✓ | GitHub App ID for `/fro-bot add-project` repo access (materializes to `github-app-id`) |
| `GH_APP_PRIVATE_KEY` | ✓ | GitHub App private key PEM (materializes to `github-app-private-key`) |
| `WORKSPACE_OPENCODE_TOKEN` | ✓ | Internal shared bearer between the gateway and the workspace `:9200` OpenCode proxy (random value; fail-closed if empty) |
| `WORKSPACE_OPENCODE_AUTH` | ✓ | OpenCode provider `auth.json` for the workspace — a **dedicated scoped cliproxy key**, not the repo's `OPENCODE_AUTH_JSON` (separate revocation + blast radius) |
| `WORKSPACE_OPENCODE_MODEL` | ✓ | OpenCode model id for the mention loop (e.g. `openai/gpt-5.5-fast`); an OpenCode harness string, not a `/v1/models` catalog id. Written to `.env` |
| `WORKSPACE_OPENCODE_CONFIG` | ✓ | OpenCode provider/baseURL config JSON routing through `cliproxy.fro.bot/v1`; JSON-validated, `$`-escaped, written to `.env` |
| `GATEWAY_TRIGGER_ROLE_ID` | ✓ | Discord role ID allowed to trigger the `@fro-bot` mention loop — required (fail-closed); empty would open LLM execution to every guild member |
| `S3_ENDPOINT` | — | Custom endpoint URL (R2, MinIO, etc.) |
| `WORKSPACE_OPENCODE_URL` | — | Override the workspace OpenCode proxy URL (default `http://workspace:9200`) |
| `OBJECT_STORE_HOSTS` | — | Comma-separated hostnames the mitmproxy egress filter allows through to S3 |
| `DISCORD_PRIVILEGED_INTENTS` | — | Opt-in privileged intents (e.g. `MessageContent`); materializes to `discord-privileged-intents`, empty = baseline intents |

### GitHub App (`/fro-bot add-project`)

The gateway authenticates to GitHub as a public App (owned by the `fro-bot` account, `contents: read` only) to clone repos for `/fro-bot add-project owner/repo`. Installation tokens are scoped per-installation, so the App must be installed on every account `add-project` targets — that is why it is public, not private. The App ID + PEM live only in the `gateway` GitHub Environment and on the droplet; they never enter the repo. **Naming:** the Environment secrets are `GH_APP_ID` / `GH_APP_PRIVATE_KEY` (GitHub rejects `GITHUB_`-prefixed names); they materialize to the upstream-fixed files `github-app-id` / `github-app-private-key`, which the daemon reads as its in-container `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`. **Rotation/revocation:** generate a new private key in the App settings, replace `GH_APP_PRIVATE_KEY` in the `gateway` Environment, re-run the deploy (re-materializes the file), then delete the old key. To contain a compromise, revoke the App installation on affected accounts (or suspend the App) and rotate the PEM. The App identity (name, logo, docs page, install-URL default) is owned by `fro-bot/agent`, not this repo.

### Mention loop (`@fro-bot` → OpenCode)

v0.50.0's workspace executor runs OpenCode against `cliproxy.fro.bot` when an authorized user `@`-mentions the bot. Trust model: the workspace runs on `sandbox-net` (`internal: true` — no direct external egress; all outbound forced through the mitmproxy allowlist), so a prompt-injection payload in a Discord message or cloned repo cannot reach an arbitrary destination. `GATEWAY_TRIGGER_ROLE_ID` bounds **who** can trigger a run (and thus spend); it is enforced non-empty at deploy time. `WORKSPACE_OPENCODE_AUTH` is a dedicated scoped cliproxy key so it can be revoked independently of CI's `OPENCODE_AUTH_JSON`. **Honest limit:** an *authorized* role-holder is still an untrusted-content source — containment bounds blast radius, it does not prevent a determined authorized user from misusing the agent within the allowed surface. Verify post-deploy with a real authorized mention (Discord command registration alone does not prove the workspace works); if broken, roll back the `upstream.json` pin to `v0.46.3` (its contract needs none of these secrets) and redeploy.

## CA RESTORE PROCEDURE

The mitmproxy CA cert and private key live in the Docker named volume `mitmproxy-certs`. If the droplet is destroyed or the volume is lost, all currently-running workspaces lose trust in the gateway's egress proxy.

**Backup (operator-driven, periodic):**

```bash
bunx @marcusrbrown/infra gateway backup --include-ca --output ./gateway-ca.tar
```

Move the file to a safe store (1Password, encrypted backup, etc.). The tar contains both `mitmproxy-ca-cert.pem` (public) and `mitmproxy-ca.pem` (private key). Treat the file as a secret.

**Restore — droplet intact (volume lost or cert corrupted):**

```bash
bunx @marcusrbrown/infra gateway restore --include-ca --input ./gateway-ca.tar
```

The CLI validates the archive locally first — it must contain exactly the two expected files, otherwise it is rejected before any remote mutation. It then uploads to an unguessable remote path, extracts into the named volume, restarts mitmproxy + gateway, and byte-equal compares the restored cert + key against the input archive. Mismatch aborts with a clear error.

**Restore — full disaster recovery (droplet destroyed):**

1. Set `GATEWAY_HOST` locally and run `bun run provision:gateway` to create a replacement droplet.
2. Commit and push the updated `.github/known_hosts`.
3. If the host or IP changed, update `GATEWAY_HOST` (and `GATEWAY_SSH_KEY` if re-keyed) in the `gateway` GitHub Environment.
4. Trigger a deploy (`bunx @marcusrbrown/infra gateway deploy`) and approve the environment gate. This creates `/opt/gateway/deploy/` on the new droplet.
5. `bunx @marcusrbrown/infra gateway restore --include-ca --input ./gateway-ca.tar` — restores the CA into the named volume.
6. Verify: `bunx @marcusrbrown/infra gateway status` and `bunx @marcusrbrown/infra gateway logs gateway --tail 100`.

## SECRET ROTATION

1. Update the value in the `gateway` GitHub Environment.
2. Trigger `gateway deploy` (or wait for the next push-to-main run).
3. The deploy script writes the new value to the droplet, recomputes the secrets checksum, force-recreates affected containers via `docker compose up -d --force-recreate <service>`, polls Discord for command registration, and writes the new checksum on success.

The checksum-after-success invariant means: if compose or polling fail mid-rotation, the old checksum persists and the next deploy will force-recreate again — no silent stale-credentials state.

For the full operator-facing rotation and emergency revocation procedure (including Keychain sync, shell-history hygiene, and audit surfaces), see [`docs/runbooks/discord-token-lifecycle.md`](../../docs/runbooks/discord-token-lifecycle.md).

## ANTI-PATTERNS

- **Never `ssh-keyscan` in CI** — host keys are pinned in `.github/known_hosts` at provision time and committed. Provisioning scripts may use `ssh-keyscan` locally.
- **Never pass secret bytes via argv** — `writeRemoteFile` pipes bytes through SSH stdin only. `--body <value>` patterns are banned.
- **Never skip `validateGatewayHost`** — it rejects `-`-prefixed values and characters outside the allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`).
- **Never restart the gateway in-place to rotate the CA** — workspaces lose trust in the egress proxy. Restore from backup instead.
- **Never validate `WORKSPACE_OPENCODE_CONFIG` with the shell-metachar guard** — it is JSON (`"`, `$`, `\` are required) and `SHELL_METACHAR_RE` would reject every valid config. Validate it with `JSON.parse` + newline/size checks; `SHELL_METACHAR_RE` is only for simple values like `WORKSPACE_OPENCODE_MODEL`.
- **Never bind-mount config files outside `/opt/gateway/deploy/secrets/`** — `init-certs.sh` and `docker-compose.yaml` are upstream's; this repo materializes secrets only.
- **Never run `pollRegistration` with an unbounded per-attempt timeout** — each fetch is wrapped in an `AbortController` with `perAttemptTimeoutMs` (defaults to `max(6000, intervalMs * 2)`).

## DECOMMISSIONING

1. `bunx @marcusrbrown/infra gateway backup --include-ca` — preserve the CA if you ever want to restore the gateway.
2. `doctl compute droplet delete <droplet-id>`
3. Remove the gateway entries from `.github/known_hosts`.
4. Delete the `gateway` GitHub Environment.
