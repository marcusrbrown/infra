# Gateway Deploy Package

The gateway is the Fro Bot Discord client and workspace runner — a 3-service Docker Compose stack (gateway daemon, workspace executor, mitmproxy egress filter) deployed on a dedicated DigitalOcean droplet at `gateway.fro.bot`. The upstream source is `fro-bot/agent`, pinned to `v0.44.0` in `apps/gateway/upstream.json`. There is no public HTTP surface; the gateway connects outbound to Discord and S3 only. Management happens via SSH and the `bunx @marcusrbrown/infra gateway *` CLI commands.

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
4. **Secret files** — 5 required files written atomically under `/opt/gateway/deploy/secrets/` (`discord_token`, `aws_access_key_id`, `aws_secret_access_key`, `discord_application_id`, `discord_guild_id`) plus 1 optional file (`discord_operator_role_id`, written as empty if unset) and 1 env var in `/opt/gateway/deploy/.env` (`OBJECT_STORE_HOSTS`, computed from `S3_BUCKET`/`S3_REGION`/`S3_ENDPOINT`). Secret bytes enter via SSH stdin only — never via argv.
5. **CA bootstrap** — `init-certs.sh` runs on the droplet (idempotent; skips if the CA already exists in the `mitmproxy-certs` named volume).
6. **Compose up** — `docker compose up -d --wait --wait-timeout 120`. mitmproxy starts first, then the gateway daemon.
7. **Registration poll** — `GET /applications/{app_id}/guilds/{guild_id}/commands` on the Discord API. 30-second hard gate per attempt via `AbortController` (defaults to `max(6000, intervalMs * 2)`). 10 attempts. 429 honors `Retry-After`. 401/403/404 abort immediately with token-sanitized errors. 5xx retries.
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
bun run --cwd apps/gateway provision
```

The script will:

1. Confirm `doctl` is authenticated
2. Reject if a `gateway` droplet already exists (aborts; `--force` to override)
3. Create an `s-1vcpu-2gb` droplet in `nyc1`, tagged `gateway`
4. Append unhashed domain host keys and hashed IP host keys to `.github/known_hosts` (`ssh-keyscan <domain>` + `ssh-keyscan -H <ip>`)
5. Print operator setup steps for finalizing the GitHub Environment

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
| `S3_ENDPOINT` | — | Custom endpoint URL (R2, MinIO, etc.) |
| `OBJECT_STORE_HOSTS` | — | Comma-separated hostnames the mitmproxy egress filter allows through to S3 |

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

1. Set `GATEWAY_HOST` locally and run `bun run --cwd apps/gateway provision` to create a replacement droplet.
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

## ANTI-PATTERNS

- **Never `ssh-keyscan` in CI** — host keys are pinned in `.github/known_hosts` at provision time and committed. Provisioning scripts may use `ssh-keyscan` locally.
- **Never pass secret bytes via argv** — `writeRemoteFile` pipes bytes through SSH stdin only. `--body <value>` patterns are banned.
- **Never skip `validateGatewayHost`** — it rejects `-`-prefixed values and characters outside the allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`).
- **Never restart the gateway in-place to rotate the CA** — workspaces lose trust in the egress proxy. Restore from backup instead.
- **Never bind-mount config files outside `/opt/gateway/deploy/secrets/`** — `init-certs.sh` and `docker-compose.yaml` are upstream's; this repo materializes secrets only.
- **Never run `pollRegistration` with an unbounded per-attempt timeout** — each fetch is wrapped in an `AbortController` with `perAttemptTimeoutMs` (defaults to `max(6000, intervalMs * 2)`).

## DECOMMISSIONING

1. `bunx @marcusrbrown/infra gateway backup --include-ca` — preserve the CA if you ever want to restore the gateway.
2. `doctl compute droplet delete <droplet-id>`
3. Remove the gateway entries from `.github/known_hosts`.
4. Delete the `gateway` GitHub Environment.
