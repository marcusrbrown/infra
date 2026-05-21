# Discord Token Lifecycle

The Discord bot token is the primary credential for the Fro Bot gateway — a long-running daemon deployed on `gateway.fro.bot` that connects to Discord and runs workspace executions. The same token is also consumed by the `marcusrbrown/.dotfiles` admin-agent (ephemeral, Keychain-backed per OpenCode session). Because both consumers share one token, rotation and revocation affect both simultaneously. This runbook covers the gateway daemon side. For the admin-agent side, see [`marcusrbrown/.dotfiles/docs/runbooks/discord-admin-agent.md`](https://github.com/marcusrbrown/.dotfiles/blob/main/docs/runbooks/discord-admin-agent.md).

---

## Storage

Secret files live on the droplet under `/opt/gateway/deploy/secrets/`. Each file is owned `root:root` with mode `0600`. The deploy script writes them via SSH stdin pipe with `umask 077` — content never appears in shell argv. See [`apps/gateway/src/deploy.ts` lines 527–547](../apps/gateway/src/deploy.ts) for the `writeRemoteFile` implementation.

**Droplet paths:**

| Host file (kebab-case) | Droplet path |
|---|---|
| `discord-token` | `/opt/gateway/deploy/secrets/discord-token` |
| `discord-application-id` | `/opt/gateway/deploy/secrets/discord-application-id` |
| `discord-guild-id` | `/opt/gateway/deploy/secrets/discord-guild-id` |
| `aws-access-key-id` | `/opt/gateway/deploy/secrets/aws-access-key-id` |
| `aws-secret-access-key` | `/opt/gateway/deploy/secrets/aws-secret-access-key` |
| `s3-bucket` | `/opt/gateway/deploy/secrets/s3-bucket` |
| `s3-region` | `/opt/gateway/deploy/secrets/s3-region` |
| `s3-endpoint` | `/opt/gateway/deploy/secrets/s3-endpoint` |
| `aws-session-token` | `/opt/gateway/deploy/secrets/aws-session-token` |

**Kebab-case ↔ snake_case ↔ env var mapping:**

The upstream compose contract maps kebab-case host files to snake_case container paths and exposes them via `${NAME}_FILE` env vars. The upstream `readOptionalSecret` helper (in `fro-bot/agent@v0.44.2/packages/gateway/src/config.ts`) reads `${NAME}_FILE` first (file path), falls back to the bare env var, and treats an empty file as absent.

| Host file (kebab) | Compose mount (snake) | Container env var (`_FILE`) | Bare env var fallback | Required? |
|---|---|---|---|---|
| `discord-token` | `/run/secrets/discord_token` | `DISCORD_TOKEN_FILE` | `DISCORD_TOKEN` | Yes |
| `discord-application-id` | `/run/secrets/discord_application_id` | `DISCORD_APPLICATION_ID_FILE` | `DISCORD_APPLICATION_ID` | Yes |
| `discord-guild-id` | `/run/secrets/discord_guild_id` | `DISCORD_GUILD_ID_FILE` | `DISCORD_GUILD_ID` | Yes |
| `aws-access-key-id` | `/run/secrets/aws_access_key_id` | `AWS_ACCESS_KEY_ID_FILE` | `AWS_ACCESS_KEY_ID` | Yes |
| `aws-secret-access-key` | `/run/secrets/aws_secret_access_key` | `AWS_SECRET_ACCESS_KEY_FILE` | `AWS_SECRET_ACCESS_KEY` | Yes |
| `s3-bucket` | `/run/secrets/s3_bucket` | `S3_BUCKET_FILE` | `S3_BUCKET` | Yes |
| `s3-region` | `/run/secrets/s3_region` | `S3_REGION_FILE` | `S3_REGION` | Yes |
| `s3-endpoint` | `/run/secrets/s3_endpoint` | `S3_ENDPOINT_FILE` | `S3_ENDPOINT` | No (empty file when unset) |
| `aws-session-token` | `/run/secrets/aws_session_token` | `AWS_SESSION_TOKEN_FILE` | `AWS_SESSION_TOKEN` | No (empty file when unset) |

The secrets checksum lives at `/opt/gateway/.secrets-checksum` (outside `deploy/` so `git clean -xfd` doesn't wipe it). See [`apps/gateway/src/deploy.ts` lines 75–80](../apps/gateway/src/deploy.ts) for the path constants and [`apps/gateway/src/deploy.ts` lines 263–307](../apps/gateway/src/deploy.ts) for `buildSecretFileList()`.

---

## Rotation procedure

Rotation is a linear, containment-first sequence. Do not skip steps or reorder them. The old token is invalidated the moment you click "Reset Token" — treat everything after that as a race to get the new token deployed before the gateway's next WebSocket reconnect attempt.

**Total operator time: ~90s for the deploy poll alone by default** — the deploy makes 10 attempts to register slash commands with Discord at 3s interval and 6s per-attempt timeout (defaults from [`apps/gateway/src/deploy.ts` lines 344–368](../apps/gateway/src/deploy.ts)). If Discord returns 429 rate-limits, each retry adds up to 60s and doesn't count against the attempt budget, stretching the wall-clock to as much as ~11 minutes in the pathological all-429 case. Budget 10–15 min end-to-end including portal steps and verification.

1. **Reset Token in the Developer Portal.** Go to [discord.com/developers/applications/1505811646956830781/bot](https://discord.com/developers/applications/1505811646956830781/bot) → Bot → Reset Token → confirm. The previous token is invalidated immediately. The gateway will start failing on its next WebSocket reconnect.

2. **Update local Keychain BEFORE seeding GitHub.** Treat the old Keychain copy as revoked from this step forward:

   ```bash
   security add-generic-password -s discord-bot-fro-bot-token -w '<new-token>' -U
   ```

   This keeps the admin-agent's Keychain copy in sync. If you seed GitHub first and the deploy succeeds before you update Keychain, the admin-agent will use a stale token until you fix it manually.

3. **Seed the new token via stdin pipe.** Never use shell substitution (`--body "$(cat ...)"`) — it corrupts secrets with trailing newlines and exposes the value in process argv. See [`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`](../solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md) for why.

   ```bash
   printf '%s' '<new-token>' | gh secret set --env gateway DISCORD_TOKEN
   ```

   If an intermediate file is unavoidable: `chmod 600` it immediately and `rm -f` it as soon as the command completes.

4. **Trigger the deploy:**

   ```bash
   bunx @marcusrbrown/infra gateway deploy
   # or: gh workflow run deploy-gateway.yaml
   ```

5. **Approve the environment gate** in the GitHub Actions UI (the `gateway` environment requires a reviewer).

6. **Observe the deploy.** The deploy script:
   - Writes new secret files to the droplet
   - Detects the checksum change → adds `--force-recreate` to `docker compose up`
   - Polls Discord slash command registration (~90s default; up to ~11 min if Discord returns 429 rate-limits; 3s interval, 6s per-attempt timeout, 10 attempts)
   - Writes the new checksum to `/opt/gateway/.secrets-checksum` only after compose + registration both succeed

   If the poll exceeds the budget the deploy aborts and the old checksum stays in place — safe to retry from step 4.

7. **Verify:**

   ```bash
   bunx @marcusrbrown/infra gateway status
   bunx @marcusrbrown/infra gateway logs gateway --tail 50
   ```

   Look for all 3 services healthy in `status` output, and `discord shard ready` + `gateway ready` lines in the logs.

8. **Scrub shell history.** Run `unset HISTFILE` before this step if you haven't already, or manually remove any line containing the new token from `~/.bash_history` / `~/.zsh_history`:

   ```bash
   grep -n '<new-token-snippet>' ~/.bash_history ~/.zsh_history
   ```

---

## Emergency revocation (suspected or confirmed leak)

**Triage first (30 seconds):**

- **Suspected leak** — anomalous log entries, unfamiliar audit-log activity, accidental token paste in a chat or terminal, leaked CI artifact.
- **Confirmed leak** — positive evidence: logs showing the leaked token used by an unrecognized client, public exposure verified (e.g., token visible in a public repo or paste).
- **Default under uncertainty: treat as confirmed. Revoke first.** The cost of a false positive is a brief outage and a rotation. The cost of a false negative is an attacker with a live bot token.

**Containment sequence:**

1. **Reset Token in the Developer Portal** — invalidates immediately. Same URL as rotation step 1: [discord.com/developers/applications/1505811646956830781/bot](https://discord.com/developers/applications/1505811646956830781/bot).

2. **Stop the gateway container in the same minute** — don't wait for the portal action to propagate through the gateway's reconnect backoff:

   ```bash
   ssh root@gateway.fro.bot 'cd /opt/gateway && docker compose -f deploy/compose.yaml stop gateway'
   ```

3. **Audit the surfaces below.** Record findings with timestamps before proceeding to re-rotation — the audit window closes as soon as you deploy a new token and the gateway resumes normal operation.

4. **Issue a new token and follow the [Rotation procedure](#rotation-procedure) above** from step 2 (Keychain update) onward. Step 1 (Reset Token) is already done.

**Audit surfaces:**

- **Discord audit log** (Server Settings → Audit Log): look for `BOT_RESET` / token reset events, suspicious admin actions taken by the bot account, channel-modify events, bot-DM activity. Compare timestamps against your suspected leak window.

- **Gateway logs** — last 500 lines of normal traffic to see what actions ran with the leaked token before revocation; look for `4004 Authentication failed` (expected after revocation):

  ```bash
  # --allow-ci required: this command is intentionally headless during incident audit
  bunx @marcusrbrown/infra gateway logs gateway --tail 500 --allow-ci
  ```

- **Mitmproxy logs** — look for unfamiliar egress destinations or request-volume spikes from the gateway container:

  ```bash
  bunx @marcusrbrown/infra gateway logs mitmproxy --tail 500 --allow-ci
  ```

- **Workspace execution logs** — look for any workspace executions during the leak window. The admin-agent uses the same token; an unrecognized workspace command is a strong signal:

  ```bash
  bunx @marcusrbrown/infra gateway logs workspace --tail 500 --allow-ci
  ```

- **S3 access logs** — look for objects written by the gateway during the leak window. Compare against your known workload.

- **Operator workstation shell history** — if the leaked token was ever echoed, this is where it lives:

  ```bash
  grep -E '<leaked-token-snippet>' ~/.bash_history ~/.zsh_history
  ```

---

## In-flight interaction handling

### WebSocket reconnect denial

When the token is reset, the gateway's active WebSocket session is invalidated. On the next reconnect attempt, Discord returns close code `4004 Authentication failed` — the RESUMED flow is denied. The daemon enters a reconnect loop with backoff and will not succeed until the new token is deployed. Operator-observable symptom in `gateway logs`: repeated `4004 Authentication failed` close codes.

### Workspace executions

The upstream compose stack has no graceful drain. Docker stop sends SIGTERM and any in-flight workspace execution is cut immediately — there is no documented grace period for in-progress work. This is the current design state, not a contract claim. Plan rotations during low-traffic windows when possible.

### Slash commands during the rotation window

Discord enforces a 3-second interaction response timeout. During the rotation window (from token reset until the new token is deployed and the gateway reconnects), any slash command invocation will time out. The user-facing message is "Application did not respond." No data is lost; the command can be retried after the gateway is back online.

---

## Coordination with dotfiles admin-agent

Both consumers share one token. Rotation invalidates both simultaneously.

| Consumer | Channel | Lifecycle | Owner repo |
|---|---|---|---|
| Gateway daemon | Secret file at `/opt/gateway/deploy/secrets/discord-token`, mounted via Docker Compose | Long-running; updated by deploy pipeline | `marcusrbrown/infra` |
| Admin-agent | macOS Keychain (`discord-bot-fro-bot-token`), read per OpenCode session | Ephemeral; updated manually by operator | `marcusrbrown/.dotfiles` |

Rotation invalidates both simultaneously. The rotation procedure above (step 2) updates Keychain before seeding GitHub to avoid a timing window where the gateway has the new token but the admin-agent still holds the old one.

Ownership boundary: infra owns the gateway daemon side; dotfiles owns the admin-agent side; rotation owner is whoever initiates — typically the operator at the GitHub Environment approval step.

For the admin-agent half of the story, see [`marcusrbrown/.dotfiles/docs/runbooks/discord-admin-agent.md`](https://github.com/marcusrbrown/.dotfiles/blob/main/docs/runbooks/discord-admin-agent.md).

---

## Secondary credential note

The Discord bot token is the only credential the gateway holds today. If upstream adds derived OAuth grants, webhook credentials, or other downstream secrets, this section needs to be revisited.

---

## Related

- [`apps/gateway/AGENTS.md`](../apps/gateway/AGENTS.md) — deploy flow, provisioning, CA restore, anti-patterns
- [`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`](../solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md) — `gh secret set` shell-substitution corruption warning; PEM newline gotcha
- [`apps/gateway/upstream.json`](../apps/gateway/upstream.json) — upstream pin file; bump triggers runbook re-verification
- `apps/gateway/src/deploy.ts` line references:
  - Lines 75–80: `REMOTE_DIR`, `DEPLOY_DIR`, `SECRETS_DIR`, `CHECKSUM_PATH` constants
  - Lines 263–307: `buildSecretFileList()` — 7 required + 2 optional secrets
  - Lines 344–368: `pollRegistration()` defaults — `maxAttempts=10`, `intervalMs=3000`, `perAttemptTimeoutMs=max(6000, intervalMs*2)`
  - Lines 527–547: `writeRemoteFile()` — SSH stdin pipe with `umask 077`
  - Lines 768–849: checksum-gated force-recreate + registration poll + checksum write-after-success

---

_Last verified against: `fro-bot/agent@v0.44.2` (the current `apps/gateway/upstream.json` pin) on 2026-05-20_
