# Gateway Deploy Package

The gateway is the Fro Bot Discord client and workspace runner — a 3-service Docker Compose stack (gateway daemon, workspace executor, mitmproxy egress filter) deployed on a dedicated DigitalOcean droplet at `gateway.fro.bot`. The upstream source is `fro-bot/agent`, pinned to `v0.69.0` in `apps/gateway/upstream.json`. v0.69.0 adds the operator auth/session/config contract: GitHub OAuth client ID/secret, CSRF secret, and allowlist — all materialized as `_FILE` mounts — on top of the v0.66.0 listener topology. v0.66.0 adds the operator listener topology contract (`fro-bot/agent#931`): `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`, and `GATEWAY_OPERATOR_PUBLIC_ORIGIN` enable the operator listener when all three are set. The current operator route surface is `GET /operator/health`. v0.64.3 bumped the harness OpenCode build with no required-secret or topology change vs v0.63.0. v0.60.0 introduced a serial per-channel run queue (one active run per Discord channel at a time) and the `/fro-bot force-release-lock` slash command for operator-driven lock release. v0.59.0 added a live-status message + typing indicator for mention runs (`GATEWAY_STATUS_MODE`, defaults to `live-status`, no infra wiring needed). v0.57.0 added the `daily_digest` presence/announce event, reusing the existing `/v1/announce` HMAC webhook ingress (`GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` already configured). `WORKSPACE_EGRESS_HOSTS` is consumed by `deploy/mitmproxy/allowlist.py` (comma-separated exact hosts the sandboxed workspace may reach through the mitmproxy egress proxy; fail-closed if empty). The deploy emits `WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot,models.dev` so the workspace OpenCode can reach the cliproxy endpoint and fetch its model catalog from `models.dev` at startup. The workspace executor exposes `/healthz` + `/clone` on `:9100` and an OpenCode bearer proxy on `:9200`, all on the internal `sandbox-net` with no host ports, enabling both `/fro-bot add-project` repo cloning and the `@fro-bot` mention loop. `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` are `readOptionalSecret` (opt-in) in the upstream daemon — set both to enable the announce/presence webhook (see [Announce/presence webhook](#announcepresence-webhook) below), or leave both unset to keep the gateway outbound-only. The deploy materializes GitHub App credentials (`github-app-id`, `github-app-private-key`) from `GH_APP_ID` / `GH_APP_PRIVATE_KEY` environment secrets.

The deploy script materializes secrets as files on the droplet (never via argv), bootstraps the mitmproxy CA on first run, brings up the Compose stack, and gates completion on Discord command registration. A secrets checksum written only after a fully successful deploy prevents silent stale-credentials states across retries.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Upstream pin | `apps/gateway/upstream.json` | `fro-bot/agent` ref — update to upgrade |
| Deploy script | `apps/gateway/src/deploy.ts` | Secrets materialization, compose up, registration poll |
| Provision droplet | `apps/gateway/server/provision-droplet.ts` | One-time. Refuses re-run on existing droplet without `--force` |
| CLI commands | `packages/cli/src/commands/gateway/` | status, deploy, logs, backup, restore |

## DEPLOY FLOW

The deploy runs in two stages: a CI `build-images` job builds and pushes the `gateway` and `workspace` Docker images to GHCR, then the `deploy-gateway` job SSHes to the droplet to pull those images and bring up the stack. The droplet never builds images — it only pulls prebuilt artifacts.

### CI: build-images job

Runs on `ubuntu-latest` with `packages: write` permission (job-scoped only; the deploy job is package-read-only). Steps:

1. Reads the pinned `ref` from `apps/gateway/upstream.json`.
2. Checks out `fro-bot/agent` at that ref.
3. Logs in to `ghcr.io` with `GITHUB_TOKEN`.
4. Builds `deploy/gateway.Dockerfile` (context: upstream root) and pushes to `ghcr.io/marcusrbrown/infra-gateway:<ref>`. Captures the pushed digest from `build-push-action` outputs.
5. Builds `deploy/workspace.Dockerfile` (context: upstream root) and pushes to `ghcr.io/marcusrbrown/infra-workspace:<ref>`. Captures the pushed digest.
6. Exposes both digests as job outputs (`gateway_digest`, `workspace_digest`).

The `deploy-gateway` job declares `needs: build-images`. A build or push failure blocks the deploy entirely — the old stack stays live.

### Droplet: deploy-gateway job

1. **Validate host** — `validateGatewayHost` rejects `-`-prefixed values and characters outside the allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`); this check is mandatory before any SSH invocation.
2. **Checksum computation** — SHA-256 of all secret values (including the `compose.override.yaml` content) is computed locally. The result is compared against `/opt/gateway/.secrets-checksum` on the droplet. If the checksums differ, `--force-recreate` is added to `docker compose up` so containers pick up the new secret files. If they match, containers are still restarted by `docker compose up -d --wait` but without `--force-recreate` (faster). In both cases the deploy continues — there is no early exit. The checksum file lives outside the deploy clone so `git clean -xfd` on subsequent deploys doesn't wipe it.
3. **Source materialization** — SSH to the droplet; clone or fetch `fro-bot/agent` at the pinned ref from `upstream.json`, then `git reset --hard && git clean -xfd` to the pinned SHA. The upstream checkout is still needed for `compose.yaml`, `init-certs.sh`, and the Dockerfiles compose references — but the droplet does not build from them.
4. **Secret files** — 11 required files written atomically under `/opt/gateway/deploy/secrets/` (`discord-token`, `discord-application-id`, `discord-guild-id`, `aws-access-key-id`, `aws-secret-access-key`, `s3-bucket`, `s3-region`, `github-app-id`, `github-app-private-key`, `workspace-opencode-token`, `workspace-opencode-auth`) plus optional-shaped files (`s3-endpoint`, `aws-session-token`, `discord-privileged-intents`, `workspace-opencode-url`, and `gateway-trigger-role-id` — written as 0-byte placeholders when unset, though `GATEWAY_TRIGGER_ROLE_ID` is enforced non-empty via `REQUIRED_ENV_VARS`, so the mention-loop authz gate fails closed rather than opening to all guild members). The `/opt/gateway/deploy/.env` carries `OBJECT_STORE_HOSTS` (computed from `S3_BUCKET`/`S3_REGION`/`S3_ENDPOINT`), `WORKSPACE_OPENCODE_MODEL`, `WORKSPACE_OPENCODE_CONFIG` — the latter is JSON-validated (via `JSON.parse`, not the shell-metachar guard) and `$`→`$$`-escaped so docker-compose `${VAR}` interpolation passes the JSON through intact — `WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot,models.dev` (v0.52.1+ requirement; consumed by `deploy/mitmproxy/allowlist.py` to allow the sandboxed workspace to reach the cliproxy OpenCode proxy and the OpenCode model catalog through mitmproxy; fail-closed if unset), and optionally `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` (v0.53.1+; absent/empty uses the upstream default of 60000ms; non-numeric/zero/negative values are rejected before any SSH). Secret bytes enter via SSH stdin only — never via argv. Filenames on disk are kebab-case; the compose contract maps each to `/run/secrets/<snake_case>` and exposes via `${NAME}_FILE` env vars. The GitHub App credentials come from the `GH_APP_ID` / `GH_APP_PRIVATE_KEY` environment secrets (GitHub reserves the `GITHUB_` prefix for secret names) and materialize to the upstream-fixed `github-app-id` / `github-app-private-key` files. See `docs/runbooks/discord-token-lifecycle.md` for the full mapping table.
5. **Compose override** — `compose.override.yaml` is written on every deploy. It pins `gateway.image` to `ghcr.io/marcusrbrown/infra-gateway@<digest>` and `workspace.image` to `ghcr.io/marcusrbrown/infra-workspace@<digest>` using the exact digests from the `build-images` job. It mounts the `workspace-repos` named volume at `/workspace/repos` on the workspace service (persists cloned repo checkouts across container recreation and daemon upgrades) and sets `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` in the workspace container environment via Docker Compose interpolation from the `.env` file. Docker Compose deep-merges the override; the upstream `build:` stanzas remain present but are inert without `--build`. When announce is enabled, the override also adds the Caddy service and announce secret wiring (see [Announce/presence webhook](#announcepresence-webhook)).
6. **CA bootstrap** — `init-certs.sh` runs on the droplet (idempotent; skips if the CA already exists in the `mitmproxy-certs` named volume).
7. **Pull images** — `docker compose --project-directory /opt/gateway/deploy pull` fetches the pinned GHCR images by digest. A missing or unpullable image errors here and does not fall back to an on-droplet build. Pull happens **before** any container disruption so that if the pull fails, gateway/caddy containers are never removed.
8. **Stale gateway-net cleanup** — After pulling images, the deploy inspects the remote `fro-bot_gateway-net` Docker network. If it exists with the old `172.20.0.0/16` subnet (from a previous failed operator deploy), it is removed so Docker can recreate it with the correct `172.21.0.0/16` subnet. If the network is missing or already has `172.21.0.0/16`, this step is a no-op. If the first removal attempt fails because containers are still attached (active endpoints — gateway and caddy services), the deploy removes those two containers directly via `docker rm -f fro-bot-gateway-1` and `docker rm -f fro-bot-caddy-1` (tolerating missing containers so recovery works when caddy is absent from the current compose config) and retries the removal. Note: `docker compose stop` alone is not sufficient — stopped containers can still keep active endpoints; only removing the containers releases their network endpoints. If container removal or the second removal fails, the deploy fails closed before `docker compose up` with an error message stating that gateway/caddy containers were removed. This step runs after `docker compose pull` and before `docker compose up` — images are already cached before any container disruption.
9. **Compose up** — `docker compose --project-directory /opt/gateway/deploy up -d --no-build --wait --wait-timeout 120 --remove-orphans` (plus `--force-recreate` when the checksum changed or `--force-recreate` was passed). `mitmproxy` starts first, then the gateway daemon. `--no-build` is explicit — the droplet never builds images.
10. **Registration poll** — `GET /applications/{app_id}/guilds/{guild_id}/commands` on the Discord API. Polls Discord registration with ~90s default budget (10 attempts × (3s interval + 6s per-attempt timeout); defaults from `apps/gateway/src/deploy.ts:344-368`). 429 honors `Retry-After` and doesn't count against the attempt budget (each 429 retry adds up to 60s; pathological all-429 ceiling ~11 min). 401/403/404 abort immediately with token-sanitized errors. 5xx retries.
11. **Running image digest verification** — for each of `gateway` and `workspace`, the deploy reads the running container's `RepoDigests` and asserts they match the CI-pushed digest. This confirms the droplet is running the GHCR artifact, not a stale or locally-built image. Throws if the digest does not match — deploy fails loudly. Manual verification:
    ```bash
    docker inspect --format '{{json .RepoDigests}}' "$(docker inspect --format '{{.Image}}' "$(docker compose --project-directory /opt/gateway/deploy ps -q gateway)")"
    docker inspect --format '{{json .RepoDigests}}' "$(docker inspect --format '{{.Image}}' "$(docker compose --project-directory /opt/gateway/deploy ps -q workspace)")"
    ```
12. **Checksum write** — `/opt/gateway/.secrets-checksum` is written only after compose + registration + digest verification all succeed. If any step fails mid-rotation, the old checksum persists and the next deploy force-recreates again.

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
| `WORKSPACE_OPENCODE_MODEL` | ✓ | OpenCode model id for the mention loop (e.g. `openai/gpt-5.5`). MUST be a real cliproxy `/v1/models` catalog id — an unlisted id (e.g. `gpt-5.5-fast`) 502s and OpenCode retries silently, yielding an empty run. Written to `.env` |
| `WORKSPACE_OPENCODE_CONFIG` | ✓ | OpenCode provider/baseURL config JSON routing through `cliproxy.fro.bot/v1`; JSON-validated, `$`-escaped, written to `.env` |
| `GATEWAY_TRIGGER_ROLE_ID` | ✓ | Discord role ID allowed to trigger the `@fro-bot` mention loop — required (fail-closed); empty would open LLM execution to every guild member |
| `S3_ENDPOINT` | — | Custom endpoint URL (R2, MinIO, etc.) |
| `WORKSPACE_OPENCODE_URL` | — | Override the workspace OpenCode proxy URL (default `http://workspace:9200`) |
| `OBJECT_STORE_HOSTS` | — | Comma-separated hostnames the mitmproxy egress filter allows through to S3 |
| `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` | — | Workspace OpenCode supervisor ready timeout in ms (1–600000; default: 60000). Absent or empty uses the upstream default. Whitespace-only, non-numeric, zero, negative, non-integer, and above-max values are rejected before any SSH. Written to `.env` and wired into the workspace container environment via the compose override. |
| `DISCORD_PRIVILEGED_INTENTS` | — | Opt-in privileged intents (e.g. `MessageContent`); materializes to `discord-privileged-intents`, empty = baseline intents |
| `GATEWAY_WEBHOOK_SECRET` | opt-in† | HMAC signing key for the announce webhook — strong random value; materialized via SSH stdin, never argv. Set together with `GATEWAY_PRESENCE_CHANNEL_ID` to enable the announce endpoint; leave both unset to keep the gateway outbound-only. Setting exactly one fails the deploy before any SSH. |
| `GATEWAY_PRESENCE_CHANNEL_ID` | opt-in† | Discord channel ID where the daemon posts presence embeds as the Fro Bot user. Set together with `GATEWAY_WEBHOOK_SECRET`. |
| `GATEWAY_OPERATOR_BIND_HOST` | opt-in‡ | Gateway-net IPv4 address for the operator listener bind (e.g. `172.21.0.2`). Rejects `0.0.0.0`, loopback, sandbox-net (`10.*`), `172.20.*` (the known conflicted Docker subnet from the failed operator deploy), and IPv6. |
| `GATEWAY_OPERATOR_BIND_PORT` | opt-in‡ | Port for the operator listener (e.g. `9300`). Must be a positive integer in [1, 65535]. |
| `GATEWAY_OPERATOR_PUBLIC_ORIGIN` | opt-in‡ | HTTPS origin for the browser-visible operator API. The ratified value is `https://dashboard.fro.bot` — set this for production use. Must be a bare HTTPS origin (no path, query, hash, credentials, or non-default port). |
| `GATEWAY_IMAGE_DIGEST` | CI-injected | `sha256:<digest>` of the `ghcr.io/marcusrbrown/infra-gateway` image pushed by the `build-images` job. Threaded from `needs.build-images.outputs.gateway_digest`. Required for the deploy to pin and verify the running image. For a local/break-glass deploy, supply manually (see [Break-glass runbook](#break-glass-runbook)). |
| `WORKSPACE_IMAGE_DIGEST` | CI-injected | `sha256:<digest>` of the `ghcr.io/marcusrbrown/infra-workspace` image pushed by the `build-images` job. Threaded from `needs.build-images.outputs.workspace_digest`. Required for the deploy to pin and verify the running image. For a local/break-glass deploy, supply manually. |

†Both-or-neither: set both to enable the announce/presence webhook; set neither to disable. Setting exactly one is an error — the deploy fails fast with a message naming the missing input, before any SSH connection is made.

‡All-or-none: set all three to enable the operator listener; set none to disable. Setting one or two is an error — the deploy fails fast before any SSH. See [Operator Listener](#operator-listener) for bind host/port/origin constraints.

## GHCR IMAGES

The `gateway` and `workspace` images are published to:

- `ghcr.io/marcusrbrown/infra-gateway` — built from `fro-bot/agent` `deploy/gateway.Dockerfile`
- `ghcr.io/marcusrbrown/infra-workspace` — built from `fro-bot/agent` `deploy/workspace.Dockerfile`

Both packages are **public**. The upstream Dockerfiles were audited before first publish: all secrets are runtime bind-mounts into `/run/secrets/...` — no `ARG`/`ENV`/`COPY` of secret material is baked into the image layers. The source (`fro-bot/agent`) is itself public. Public visibility means the droplet pulls with no authentication required.

Tags (`:<ref>`) are pushed for human readability. The deploy pins and verifies by **digest** (`@sha256:<digest>`), not by tag — GHCR tags are mutable, so tag-based verification would be circular. Digest pull is immutable and makes the running-image check a true identity assertion.

The `build-images` CI job holds `packages: write` permission (job-scoped only). The `deploy-gateway` job is package-read-only.

## BREAK-GLASS RUNBOOK

The deploy depends on CI and GHCR availability. If CI or GHCR is unavailable during an incident and the droplet needs a redeploy:

1. **Build and push from a workstation** (which has ample RAM — this is the off-droplet build done by hand):
   ```bash
   # Check out fro-bot/agent at the pinned ref
   REF=$(jq -r .ref apps/gateway/upstream.json)
   git clone --depth 1 --branch "$REF" https://github.com/fro-bot/agent.git /tmp/fro-bot-agent

   # Log in to GHCR
   echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-github-username> --password-stdin

   # Build and push gateway image; capture the digest
   GATEWAY_DIGEST=$(docker buildx build \
     --platform linux/amd64 \
     --file /tmp/fro-bot-agent/deploy/gateway.Dockerfile \
     --push \
     --iidfile /tmp/gateway-iid.txt \
     --metadata-file /tmp/gateway-meta.json \
     /tmp/fro-bot-agent \
     && jq -r '."containerimage.digest"' /tmp/gateway-meta.json)

   # Build and push workspace image; capture the digest
   WORKSPACE_DIGEST=$(docker buildx build \
     --platform linux/amd64 \
     --file /tmp/fro-bot-agent/deploy/workspace.Dockerfile \
     --push \
     --metadata-file /tmp/workspace-meta.json \
     /tmp/fro-bot-agent \
     && jq -r '."containerimage.digest"' /tmp/workspace-meta.json)
   ```

2. **Run the local deploy** with the digests you just captured:
   ```bash
   GATEWAY_IMAGE_DIGEST="$GATEWAY_DIGEST" \
   WORKSPACE_IMAGE_DIGEST="$WORKSPACE_DIGEST" \
   bunx @marcusrbrown/infra gateway deploy --local
   ```

**Never run `docker compose up --build` on the droplet.** The `compose.override.yaml` image pins make GHCR the source of truth regardless, but building on the 1vCPU/2GB droplet exhausts RAM and thrashes swap — this is the failure mode the off-droplet build flow exists to prevent. The on-droplet build fallback is intentionally removed; the workstation build above is the correct emergency path.

The deploy depends on CI + GHCR availability + pull working. This is a deliberate trade: the on-droplet build is the hazard being removed, so keeping it as a fallback would keep the hazard.

### GitHub App (`/fro-bot add-project`)

The gateway authenticates to GitHub as a public App (owned by the `fro-bot` account, `contents: read` only) to clone repos for `/fro-bot add-project owner/repo`. Installation tokens are scoped per-installation, so the App must be installed on every account `add-project` targets — that is why it is public, not private. The App ID + PEM live only in the `gateway` GitHub Environment and on the droplet; they never enter the repo. **Naming:** the Environment secrets are `GH_APP_ID` / `GH_APP_PRIVATE_KEY` (GitHub rejects `GITHUB_`-prefixed names); they materialize to the upstream-fixed files `github-app-id` / `github-app-private-key`, which the daemon reads as its in-container `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`. **Rotation/revocation:** generate a new private key in the App settings, replace `GH_APP_PRIVATE_KEY` in the `gateway` Environment, re-run the deploy (re-materializes the file), then delete the old key. To contain a compromise, revoke the App installation on affected accounts (or suspend the App) and rotate the PEM. The App identity (name, logo, docs page, install-URL default) is owned by `fro-bot/agent`, not this repo.

### Mention loop (`@fro-bot` → OpenCode)

v0.51.0's workspace executor runs OpenCode against `cliproxy.fro.bot` when an authorized user `@`-mentions the bot. Trust model: the workspace runs on `sandbox-net` (`internal: true` — no direct external egress; all outbound forced through the mitmproxy allowlist), so a prompt-injection payload in a Discord message or cloned repo cannot reach an arbitrary destination. `GATEWAY_TRIGGER_ROLE_ID` bounds **who** can trigger a run (and thus spend); it is enforced non-empty at deploy time (`REQUIRED_ENV_VARS` in `deploy.ts`) even though the upstream daemon treats it as `readOptionalSecret` — this repo's deploy is stricter (fail-closed). `WORKSPACE_OPENCODE_AUTH` is a dedicated scoped cliproxy key so it can be revoked independently of CI's `OPENCODE_AUTH_JSON`. `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` are opt-in — set both in the `gateway` GitHub Environment to enable the announce/presence webhook (see [Announce/presence webhook](#announcepresence-webhook) below). **Honest limit:** an *authorized* role-holder is still an untrusted-content source — containment bounds blast radius, it does not prevent a determined authorized user from misusing the agent within the allowed surface. Verify post-deploy with a real authorized mention (Discord command registration alone does not prove the workspace works); if broken, revert `upstream.json` to the last known-good ref and redeploy.

The deploy emits `WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot,models.dev`. Both hosts are required: `cliproxy.fro.bot` is the LLM proxy the workspace routes all model traffic through; `models.dev` is the model catalog OpenCode fetches at startup to populate its provider list. Without `models.dev` in the allowlist, OpenCode cannot start and the `@`-mention loop fails entirely — the workspace container exits before accepting any request. The `/fro-bot add-project` clone path is unaffected (it does not invoke OpenCode).

### Post-cutover verification ritual

After deploying a new daemon version, run these checks in order — each gate must pass before the next:

1. `bunx @marcusrbrown/infra gateway status` — core services (`gateway`, `workspace`, `mitmproxy`) must show healthy/running; on announce-enabled stacks, `caddy` must also appear (running or healthy — Caddy has no healthcheck, so `running/n-a` is normal).
2. `bunx @marcusrbrown/infra gateway logs workspace --tail 100` — confirm the workspace container started without errors (look for the Hono server listening on `:9100` and `:9200`).
3. **`/fro-bot add-project` clone smoke** — run the slash command against a repo the GitHub App is installed on; confirm the clone completes without error. This exercises the GitHub App credentials and the workspace `/clone` endpoint end-to-end.
4. **Authorized `@fro-bot` mention round-trip** — send a mention from an account holding `GATEWAY_TRIGGER_ROLE_ID`; confirm a response arrives. This is the only proof the workspace OpenCode execution path is live. Discord command registration (step 7 of the deploy flow) does **not** prove the workspace works — it only proves the daemon registered slash commands.
5. **Approval-wait probe** — send a mention that triggers a tool requiring approval (e.g. a shell command). Confirm the gateway posts an Approve/Deny embed in the run thread. Click Deny; confirm the run fails cleanly with a rejection message rather than hanging silently. This verifies approval waits surface and fail cleanly instead of timing out without feedback.
6. **workspace-repos volume** — after the mention round-trip, run `bunx @marcusrbrown/infra gateway logs workspace --tail 50` and confirm the workspace did not re-clone the repo from scratch (it should use the existing checkout from the `workspace-repos` volume). On first deploy, the volume is auto-created and the repo is cloned fresh — subsequent mentions reuse it.

**@mention-loop behavior:**
- A mention from an authorized user (holding `GATEWAY_TRIGGER_ROLE_ID`) triggers an OpenCode run in the workspace.
- If the run needs a tool that requires approval, the gateway posts an Approve/Deny embed in the run thread. The run pauses until a button-click or the 13-minute deadline fires (fail-closed).
- Only authorized users can approve. Unauthorized approval attempts are silently ignored.
- If the gateway or workspace restarts while a prompt is open, the prompt is abandoned — the run does not resume.
- Cloned repos live in the `workspace-repos` named volume at `/workspace/repos`. The volume persists repo contents across container recreation and daemon upgrades. Missing repos are re-cloned automatically on the next mention. **Never run `docker compose down -v`** — it destroys all cloned repos. Do not put secrets in repo contents — authorized runs may access the active workspace/repo surface. To fully clear a cloned repo, delete the volume and let the next mention re-clone it.
- `WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot,models.dev` is required for the workspace to reach the LLM proxy and the OpenCode model catalog. Without `models.dev`, OpenCode cannot start and the mention loop fails entirely.

## ANNOUNCE/PRESENCE WEBHOOK

The daemon's `POST /v1/announce` endpoint is opt-in. When enabled, it accepts HMAC-signed requests and posts a Discord embed as the Fro Bot user to the configured presence channel. The intended caller is the `fro-bot/.github` control plane (separate work, not in this repo).

### Enabling

Set both `GATEWAY_WEBHOOK_SECRET` (a strong random HMAC key) and `GATEWAY_PRESENCE_CHANNEL_ID` (the target Discord channel ID) in the `gateway` GitHub Environment, then trigger a deploy. The deploy materializes both as secret files on the droplet and writes a `compose.override.yaml` that:

- Adds a Caddy reverse proxy service publishing `:80`/`:443` on `gateway-net`, terminating TLS for `gateway.fro.bot` via Let's Encrypt auto-cert.
- Path-scopes Caddy to `/v1/announce` and (when operator is enabled) `/operator/*` — all other paths return 404.
- Wires the daemon's announce `*_FILE` env entries and secret mounts via the override's `gateway` service block.

The override is a working-tree file re-materialized on every deploy when the inputs are present. The override contents are included in the secrets checksum, so toggling announce on or off forces `--force-recreate` on the next deploy.

### Security posture

- **Auth:** the daemon verifies the HMAC signature, enforces a replay cache, and applies a rate limiter. Caddy adds TLS termination.
- **No IP allowlist:** GitHub Actions egress ranges are too dynamic to pin reliably. HMAC + TLS is the full auth boundary.
- **Secret materialization:** `GATEWAY_WEBHOOK_SECRET` is written to the droplet via SSH stdin only — never via argv.
- **Path isolation:** Caddy uses a `handle /v1/announce { ... }` block with a catch-all `handle { respond 404 }`. The catch-all does not shadow ACME challenge paths (Caddy uses TLS-ALPN-01 on `:443` by default, which does not touch HTTP path routing).

### Rollback / disabling

Remove both `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` from the `gateway` GitHub Environment and redeploy. The `compose.override.yaml` is always rewritten on deploy — when announce is disabled, the override carries only the image digest pins (no Caddy/announce sections). `git clean -xfd` removes the `Caddyfile` (a working-tree file written only when announce is enabled); `--remove-orphans` retires the now-undeclared Caddy container; the checksum flip (override bytes changed, Caddyfile gone) triggers `--force-recreate`. After the deploy, verify with `docker compose config` on the droplet — the Caddy service must not appear.

### Caddy volume guardrail

Caddy stores TLS certs in a named Docker volume (`caddy_data`). Docker volumes are independent of the git working tree — `git clean -xfd` and normal deploys never touch them. The real cert-loss risk is an explicit `docker compose down -v` or `docker volume prune` on the gateway project, which would wipe the certs and force Let's Encrypt re-issuance (rate-limit risk). **Never run `docker compose down -v` or `docker volume prune` on the gateway stack.** See the ANTI-PATTERNS section.

### Rotation

If `GATEWAY_WEBHOOK_SECRET` leaks, the blast radius is Fro-Bot-user impersonation into the presence channel. Rotate by setting a new value in the `gateway` GitHub Environment and redeploying. Coordinate with the `fro-bot/.github` caller, which holds the matching secret on its side. The deploy re-materializes the secret file via SSH stdin; the checksum flip force-recreates the daemon container.

### Post-enable verification

After the first enabling deploy:

1. `bunx @marcusrbrown/infra gateway status` — confirm the `caddy` service appears alongside `gateway`, `workspace`, `mitmproxy` (running or healthy — Caddy has no healthcheck, so `running/n-a` is normal).
2. Send a correctly HMAC-signed test POST to `https://gateway.fro.bot/v1/announce` — confirm a Discord embed appears in the presence channel.
3. Send an unsigned or replayed POST — confirm a 401/403 response.
4. Send a request to any other path (e.g. `https://gateway.fro.bot/`) — confirm a 404 response.

For verifying a real control-plane go-live end-to-end (live log monitoring, success-field criteria, and distinguishing the real signed event from test probes), see [`docs/runbooks/gateway-announce-event-verification.md`](../../docs/runbooks/gateway-announce-event-verification.md).

### Implementation pointers

`buildSecretFileList`, `getAnnounceState`, `buildComposeOverride`, `buildCaddyfile` in `apps/gateway/src/deploy.ts`.

## OPERATOR AUTH

The operator auth gate is part of the operator listener feature. When the operator listener trio is enabled, all four auth/config secrets are required. The deploy fails before any SSH if the listener trio is set but any of the four auth/config secrets is missing or partially set.

### Required auth/config secrets

| GitHub Environment secret | `_FILE` env var in compose override | Description |
| --- | --- | --- |
| `GATEWAY_OPERATOR_GITHUB_CLIENT_ID` | `GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE` | GitHub OAuth App client ID |
| `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET` | `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET_FILE` | GitHub OAuth App client secret |
| `GATEWAY_OPERATOR_CSRF_SECRET` | `GATEWAY_OPERATOR_CSRF_SECRET_FILE` | Strict base64url, no padding/newlines, ≥32 decoded bytes |
| `GATEWAY_OPERATOR_ALLOWLIST` | `GATEWAY_OPERATOR_ALLOWLIST_FILE` | Newline-separated numeric GitHub user IDs; fail-closed if missing/empty/malformed |

All four are all-or-none with the operator listener trio. Setting one to three of the four fails the deploy before any SSH. Leaving all four unset when the listener trio is also unset is the disabled state.

### Optional OAuth tuning vars

These are plain env vars (not file-backed). Set them in the `gateway` GitHub Environment if needed; leave unset to use upstream defaults.

| GitHub Environment secret | Default | Description |
| --- | --- | --- |
| `GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS` | `/operator` | Comma-separated same-origin post-auth paths |
| `GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS` | `600000` | OAuth state TTL in milliseconds |
| `GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS` | `5` | Max concurrent outstanding OAuth attempts |

These are transported as optional secrets in the workflow (not `workflow_call.inputs`) for consistency with the gateway deploy pipeline.

### Callback URL

The GitHub OAuth App must be configured with:

```
https://dashboard.fro.bot/operator/auth/github/callback
```

This is a GitHub OAuth App (client ID/secret) — not the existing gateway GitHub App (`GH_APP_ID`). Register the callback URL in the GitHub Developer Portal before enabling operator auth. The deploy dry-run prints the expected callback URL for manual cross-check against the portal.

### Session semantics

Sessions are in-memory. A gateway restart (deploy, force-recreate, container crash) invalidates all active operator sessions. Operators must re-authenticate after each restart. No session-persistence deploy var exists at this version.

### Rollback path

To disable operator auth/config wiring after deployment:

1. Remove or clear **both** the listener trio **and** the four auth/config secrets from the `gateway` GitHub Environment:
   - Listener trio: `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`, `GATEWAY_OPERATOR_PUBLIC_ORIGIN`
   - Auth/config secrets: `GATEWAY_OPERATOR_GITHUB_CLIENT_ID`, `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`, `GATEWAY_OPERATOR_CSRF_SECRET`, `GATEWAY_OPERATOR_ALLOWLIST`
2. Trigger a gateway deploy: `bunx @marcusrbrown/infra gateway deploy`.
3. Approve the environment gate.
4. The deploy detects the operator listener is disabled, skips all operator auth/config wiring, and runs `docker compose up --remove-orphans`.
5. The gateway restarts with the operator listener disabled. All active operator sessions are invalidated (in-memory — no data rollback needed).
6. Verify: `bunx @marcusrbrown/infra gateway status` shows all services healthy.

**Note:** Listener trio present + auth/config secrets absent is not a valid state — the deploy fails before any SSH. The only supported rollback is to clear **both** the listener trio and the four auth/config secrets together.

### Post-enable verification

After the first deploy with operator auth/config wiring:

1. **Gateway-side liveness probe:** Probe the listener directly via the droplet-local gateway-net address:
   ```bash
   curl -sf http://172.21.0.2:9300/operator/health
   ```
   A `200 {"ok":true}` response confirms the operator listener is up.

   **⚠ Liveness probe warning:** Do **not** use `https://dashboard.fro.bot/operator/health` or any `https://dashboard.fro.bot/operator/*` URL as a liveness probe — the dashboard Caddy `/operator/*` reverse proxy and private dashboard→gateway path are out of scope and deferred to `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`. Do **not** use `https://gateway.fro.bot/operator/health` as a liveness probe — v0.69.0 adds a global forwarded-header guard that returns `400 {"error":"bad request"}` for any request where `X-Forwarded-Host` does not match the `PUBLIC_ORIGIN` host (`dashboard.fro.bot`); the public Caddy route forwards `Host: gateway.fro.bot`, so it returns 400 by design with no trusted-proxy config knob. The only valid gateway-side liveness probe is the droplet-local direct probe above. The OAuth callback URL registration uses the dashboard origin (`https://dashboard.fro.bot/operator/auth/github/callback`) — this is a GitHub OAuth App setting, not a live HTTP probe target.

2. **Auth gate coarse check:** `GET https://gateway.fro.bot/operator/` should return a non-5xx, non-404 response — likely a redirect to the GitHub OAuth flow or a structured auth-required response.

3. **Callback URL preflight:** Before triggering the OAuth flow, verify the expected callback URL string. The deploy dry-run output prints:
   ```
   Expected OAuth callback URL: https://dashboard.fro.bot/operator/auth/github/callback
   ```
   Cross-check this string against the **Authorization callback URL** field in the GitHub OAuth App settings (GitHub Developer Portal → OAuth Apps → your app). The portal check is manual and must be completed before enablement.

4. **Allowlist enforcement:** Attempt to complete the OAuth flow with a GitHub account that is NOT in the allowlist. Confirm the response is a coarse auth-failure (non-5xx, no route or allowlist detail leaked).

5. **Session invalidation on restart:** After a successful auth, trigger a gateway restart (`docker compose restart gateway` on the droplet). Confirm the session is invalidated and re-authentication is required.

6. **No host-published operator port:** `docker compose ps` on the gateway droplet must not show a `9300->9300` mapping.

For the full operator auth lifecycle runbook (OAuth App setup, CSRF secret generation, allowlist format, secret seeding, rotation, rollback), see [`docs/runbooks/gateway-operator-auth-lifecycle.md`](../../docs/runbooks/gateway-operator-auth-lifecycle.md).

## OPERATOR LISTENER

The gateway operator listener is opt-in. When enabled, it exposes `GET /operator/health` (and future privileged operator routes) on a `gateway-net`-only address. Caddy routes `/operator/*` traffic from the public HTTPS edge to the listener over `gateway-net` — the listener has no host-published port.

**Browser-visible operator origin:** The ratified target for the browser-visible operator API is `https://dashboard.fro.bot/operator/*`. `GATEWAY_OPERATOR_PUBLIC_ORIGIN` must be set to `https://dashboard.fro.bot` when the operator listener is enabled for production use. The gateway-side Caddy `/operator/*` route is topology scaffolding — it proves the gateway listener and Caddy wiring work, but `gateway.fro.bot/operator/*` is not the production browser origin and must not be used as such. See `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` for the full decision record.

**Current state:** The operator listener is **enabled in production**. `GATEWAY_OPERATOR_BIND_HOST=172.21.0.2`, `GATEWAY_OPERATOR_BIND_PORT=9300`, and `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot` are set in the `gateway` GitHub Environment. Deploy run [27740787921](https://github.com/marcusrbrown/infra/actions/runs/27740787921) succeeded; operator listener liveness is confirmed via the droplet-local direct probe (`curl -sf http://172.21.0.2:9300/operator/health` → `200 {"ok":true}`). The public `https://gateway.fro.bot/operator/health` route returns 400 by design (v0.69.0 forwarded-header guard — `X-Forwarded-Host: gateway.fro.bot` does not match `PUBLIC_ORIGIN` host `dashboard.fro.bot`). Operator auth is **live**: all four auth/config secrets (`GATEWAY_OPERATOR_GITHUB_CLIENT_ID`, `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`, `GATEWAY_OPERATOR_CSRF_SECRET`, `GATEWAY_OPERATOR_ALLOWLIST`) are seeded in the `gateway` GitHub Environment and materialized as `_FILE` mounts. The dashboard Caddy `/operator/*` route and the dashboard live client are not yet deployed and remain separate.

### Enabling

Set all three vars in the `gateway` GitHub Environment and trigger a deploy:

| Variable | Description |
| --- | --- |
| `GATEWAY_OPERATOR_BIND_HOST` | Gateway-net IPv4 address for the listener bind (e.g. `172.21.0.2`). Must be a static gateway-net address — not `0.0.0.0`, loopback (`127.*`), sandbox-net (`10.*`), `172.20.*` (the known conflicted Docker subnet from the failed operator deploy), or IPv6. |
| `GATEWAY_OPERATOR_BIND_PORT` | Port for the operator listener (e.g. `9300`). Must be a positive integer in [1, 65535]. |
| `GATEWAY_OPERATOR_PUBLIC_ORIGIN` | HTTPS origin for the browser-visible operator API. The ratified target is `https://dashboard.fro.bot`. Must be HTTPS. |

All three must be set together (all-or-none). Setting one or two fails the deploy before any SSH. Leaving all three unset disables the operator listener.

The deploy:
- Validates all three values before any SSH (rejects unsafe bind hosts, invalid ports, non-HTTPS origins).
- Writes `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`, and `GATEWAY_OPERATOR_PUBLIC_ORIGIN` into the gateway service environment in `compose.override.yaml`.
- Sets a static `ipv4_address` on `gateway-net` for the gateway service so the bind address is deterministic.
- Adds a `/operator/*` Caddy route with `flush_interval -1` (no response buffering, ready for future SSE).
- **Auto-cleans stale `fro-bot_gateway-net`** — after `docker compose pull` and before `docker compose up`, inspects the remote Docker network. If it exists with the old `172.20.0.0/16` subnet, removes it so Docker can recreate it with `172.21.0.0/16`. Missing or already-correct networks are skipped. Pull happens first so images are cached before any container disruption — if the pull fails, gateway/caddy containers are never removed. If the first removal fails due to active endpoints (gateway/caddy still attached), the deploy removes those two containers directly via `docker rm -f fro-bot-gateway-1` and `docker rm -f fro-bot-caddy-1` (tolerating missing containers so recovery works when caddy is absent from the current compose config) and retries the removal (`stop` alone is insufficient — stopped containers retain network endpoints). Any other removal failure, or failure of the container removal/retry, fails the deploy closed before `docker compose up`. `GATEWAY_OPERATOR_BIND_HOST` must be in the `172.21.x.x` range (e.g. `172.21.0.2`).
- Probes `GET https://${GATEWAY_HOST}/operator/health` (i.e. `https://gateway.fro.bot/operator/health`) after compose up (warning-only; connection errors do not fail the deploy). Against v0.69.0 with `PUBLIC_ORIGIN=https://dashboard.fro.bot`, this probe returns 400 by design (forwarded-header guard) rather than 200 — it does not confirm liveness. Use `curl -sf http://172.21.0.2:9300/operator/health` (droplet-local direct probe) for actual liveness confirmation.

### Security posture

- The operator listener has no host `ports:` entry — it is only reachable via Caddy over `gateway-net`.
- The workspace (`sandbox-net`) has no path to the operator listener.
- `/v1/announce` and `/operator/*` are separate Caddy `handle` blocks with distinct trust boundaries.
- Auth/session/CSRF/allowlist wiring for privileged operator routes is live; the four operator auth/config secrets must be seeded in the `gateway` GitHub Environment to activate the auth gate (see [Enabling](#enabling) and [`docs/runbooks/gateway-operator-auth-lifecycle.md`](../../docs/runbooks/gateway-operator-auth-lifecycle.md)).
- The gateway Caddy `/operator/*` route is topology scaffolding. The production browser operator path is `https://dashboard.fro.bot/operator/*` via the dashboard Caddy proxy — not `gateway.fro.bot/operator/*` directly.

### Post-enable verification

After the first enabling deploy:

1. `bunx @marcusrbrown/infra gateway status` — confirm `caddy` and `gateway` services appear healthy.
2. `curl -sf http://172.21.0.2:9300/operator/health` — confirm a `200 {"ok":true}` response (droplet-local direct probe). Note: `https://gateway.fro.bot/operator/health` returns 400 by design (v0.69.0 forwarded-header guard); use the direct probe for liveness confirmation.
3. Confirm no host port for the operator listener: `docker compose --project-directory /opt/gateway/deploy ps` — the `gateway` service must not show a `9300->9300` port mapping.
4. Confirm workspace is not on `gateway-net`: `docker network inspect gateway-net` — the `workspace` container must not appear.

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
- **Never run `docker compose up --build` on the droplet** — building the `gateway` or `workspace` images on the 1vCPU/2GB droplet exhausts RAM and thrashes swap while the live stack is running. The deploy uses `docker compose pull` + `up -d --no-build`; the `compose.override.yaml` image pins make GHCR the source of truth. For emergency rebuilds, build from a workstation and push to GHCR (see [Break-glass runbook](#break-glass-runbook)).
- **Never validate `WORKSPACE_OPENCODE_CONFIG` with the shell-metachar guard** — it is JSON (`"`, `$`, `\` are required) and `SHELL_METACHAR_RE` would reject every valid config. Validate it with `JSON.parse` + newline/size checks; `SHELL_METACHAR_RE` is only for simple values like `WORKSPACE_OPENCODE_MODEL`.
- **Never bind-mount config files outside `/opt/gateway/deploy/secrets/`** — `init-certs.sh` and `docker-compose.yaml` are upstream's; this repo materializes secrets only.
- **Never run `pollRegistration` with an unbounded per-attempt timeout** — each fetch is wrapped in an `AbortController` with `perAttemptTimeoutMs` (defaults to `max(6000, intervalMs * 2)`).
- **Never run `docker compose down -v` or `docker volume prune` on the gateway stack** — this wipes named Docker volumes including `caddy_data` (TLS certs), `mitmproxy-certs` (CA key), and `workspace-repos` (all cloned repo checkouts). Normal deploys and `git clean -xfd` do NOT touch Docker volumes. Losing `caddy_data` forces Let's Encrypt re-issuance (rate-limit risk); losing `mitmproxy-certs` breaks workspace egress trust (requires CA restore); losing `workspace-repos` destroys all cloned repos (they will be re-cloned automatically on the next mention, but the volume loss itself is irreversible).

## DECOMMISSIONING

1. `bunx @marcusrbrown/infra gateway backup --include-ca` — preserve the CA if you ever want to restore the gateway.
2. `doctl compute droplet delete <droplet-id>`
3. Remove the gateway entries from `.github/known_hosts`.
4. Delete the `gateway` GitHub Environment.
