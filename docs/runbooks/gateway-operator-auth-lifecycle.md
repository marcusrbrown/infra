# Gateway Operator Auth Lifecycle

The gateway operator auth gate uses GitHub OAuth to authenticate operators accessing the browser-visible operator surface at `https://dashboard.fro.bot/operator/*`. This runbook covers initial setup, secret seeding, rotation, and rollback for the four operator auth/config secrets.

---

## Prerequisites

- The operator listener trio (`GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`, `GATEWAY_OPERATOR_PUBLIC_ORIGIN`) is set in the `gateway` GitHub Environment.
- The `gateway` GitHub Environment exists with a required reviewer set.
- You have admin access to the GitHub account that owns the OAuth App.

---

## GitHub OAuth App Setup

Create a **GitHub OAuth App** (not a GitHub App) in the GitHub Developer Portal. This is a separate credential from the existing gateway GitHub App (`GH_APP_ID`); do not conflate them.

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps** → **New OAuth App**.
2. Fill in the fields:
   - **Application name:** `fro-bot operator` (or similar)
   - **Homepage URL:** `https://dashboard.fro.bot`
   - **Authorization callback URL:** `https://dashboard.fro.bot/operator/auth/github/callback`
3. Click **Register application**.
4. Copy the **Client ID** — this is `GATEWAY_OPERATOR_GITHUB_CLIENT_ID`.
5. Click **Generate a new client secret** — copy the secret immediately. This is `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`. GitHub shows it only once.

---

## CSRF Secret Generation

The CSRF secret must be strict base64url: no padding (`=`), no whitespace, no newlines. The decoded byte length must be at least 32 bytes. A 32-byte random value encoded as base64url (no padding) produces a 43-character string.

Generic generation example (verify against upstream docs before use):

```bash
# Generic example — verify against upstream docs before use
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Never commit or log the output. Seed directly via stdin pipe (see [Secret Seeding](#secret-seeding) below).

---

## Allowlist Format

The allowlist is a newline-separated list of numeric GitHub user IDs. Obtain user IDs via the GitHub API:

```bash
curl -s https://api.github.com/users/<username> | jq .id
```

Format:

```
12345678
87654321
# This is a comment — ignored
```

Blank lines and full-line `#` comments (after optional leading whitespace) are ignored. At least one numeric user ID must remain after filtering. Non-numeric, non-comment lines are rejected. The upstream loader is fail-closed: a missing, empty, or malformed allowlist prevents the operator web surface from starting.

---

## Secret Seeding

All four auth/config secrets must be seeded via stdin pipe — never via `--body` substitution or shell here-strings. See `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` for the corruption risk.

```bash
printf '%s' '<client-id>' | gh secret set --env gateway GATEWAY_OPERATOR_GITHUB_CLIENT_ID
printf '%s' '<client-secret>' | gh secret set --env gateway GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET
printf '%s' '<csrf-secret>' | gh secret set --env gateway GATEWAY_OPERATOR_CSRF_SECRET
printf '%s' '<allowlist>' | gh secret set --env gateway GATEWAY_OPERATOR_ALLOWLIST
```

Replace `<client-id>`, `<client-secret>`, `<csrf-secret>`, and `<allowlist>` with the actual values. For the allowlist, use `$'...'` quoting or a heredoc to include newlines:

```bash
printf '%s\n%s\n' '12345678' '87654321' | gh secret set --env gateway GATEWAY_OPERATOR_ALLOWLIST
```

### Optional tuning vars

If you need to override the OAuth tuning defaults, seed them as secrets via the same stdin pipe pattern (they are transported as optional secrets in the workflow):

```bash
printf '%s' '/operator,/operator/runs' | gh secret set --env gateway GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS
printf '%s' '300000' | gh secret set --env gateway GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS
printf '%s' '10' | gh secret set --env gateway GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS
```

Leave these unset to use upstream defaults (`/operator`, `600000`, `5`).

---

## Deploy and Verify

1. **Trigger a deploy:**
   ```bash
   bunx @marcusrbrown/infra gateway deploy
   ```
2. **Approve the environment gate** in GitHub Actions.
3. **Verify gateway-side liveness** using the droplet-local direct probe (run on the droplet or via SSH):
   ```bash
   curl -sf http://172.21.0.2:9300/operator/health
   ```
   This should return `200 {"ok":true}`.

   **⚠ Liveness probe warning:** Do **not** use `https://dashboard.fro.bot/operator/health` or any `https://dashboard.fro.bot/operator/*` URL as a liveness probe. The dashboard Caddy `/operator/*` reverse proxy and private dashboard→gateway path are deferred to `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`. Do **not** use `https://gateway.fro.bot/operator/health` as a liveness probe either — through Caddy, the v0.69.0 operator endpoint validates forwarded headers and requires `X-Forwarded-Host` to equal the `PUBLIC_ORIGIN` host (`dashboard.fro.bot`); because Caddy forwards `Host: gateway.fro.bot`, the forwarded-host mismatches and the endpoint returns `400 {"error":"bad request"}` by design. There is no trusted-proxy config knob in v0.69.0. The only valid gateway-side liveness probe is the droplet-local direct probe: `curl -sf http://172.21.0.2:9300/operator/health` → `200 {"ok":true}`. The OAuth callback URL registration uses the dashboard origin — this is a GitHub OAuth App setting, not a live HTTP probe target.

4. **Callback URL preflight:** The deploy dry-run output prints the expected callback URL:
   ```
   Expected OAuth callback URL: https://dashboard.fro.bot/operator/auth/github/callback
   ```
   Cross-check this string against the **Authorization callback URL** field in the GitHub OAuth App settings (GitHub Developer Portal → OAuth Apps → your app). This portal check is manual and must be completed before enablement. Infra cannot read or validate the OAuth App callback registration via API — no public GitHub API surface exposes this field.

5. **Auth gate coarse check:** `GET https://gateway.fro.bot/operator/` returns `400 {"error":"bad request"}` by design — the forwarded-header guard rejects it because the forwarded host (`gateway.fro.bot`) does not match the `PUBLIC_ORIGIN` host (`dashboard.fro.bot`). The auth-gate / OAuth-redirect coarse check is only meaningful through the real same-origin path (`https://dashboard.fro.bot/operator/*`, once the dashboard same-origin plan lands) or via the direct listener with appropriate forwarded headers. Via `gateway.fro.bot/operator/` the 400 is expected and correct.

6. **Allowlist enforcement check:** Attempt to complete the OAuth flow with a GitHub account that is NOT in the allowlist. Confirm the response is a coarse auth-failure (non-5xx, no route or allowlist detail leaked).

7. **Session invalidation on restart:** After a successful auth, trigger a gateway restart (`docker compose restart gateway` on the droplet). Confirm the session is invalidated and re-authentication is required. Sessions are in-memory — a restart always invalidates all active sessions.

8. **No host-published operator port:** `docker compose ps` on the gateway droplet must not show a `9300->9300` mapping.

---

## Rotation

### Rotating the GitHub OAuth client secret

1. Go to the GitHub OAuth App settings → **Generate a new client secret**.
2. Copy the new secret.
3. Seed the new value:
   ```bash
   printf '%s' '<new-client-secret>' | gh secret set --env gateway GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET
   ```
4. Trigger a deploy: `bunx @marcusrbrown/infra gateway deploy`.
5. Approve the environment gate.
6. Verify: `curl -sf http://172.21.0.2:9300/operator/health` (run on the droplet or via SSH) returns `200 {"ok":true}`.
7. Delete the old client secret in the GitHub OAuth App settings.

Sessions are in-memory — the restart triggered by the checksum change invalidates all active operator sessions. Operators must re-authenticate after the deploy.

### Rotating the CSRF secret

1. Generate a new CSRF secret (see [CSRF Secret Generation](#csrf-secret-generation)).
2. Seed the new value:
   ```bash
   printf '%s' '<new-csrf-secret>' | gh secret set --env gateway GATEWAY_OPERATOR_CSRF_SECRET
   ```
3. Trigger a deploy: `bunx @marcusrbrown/infra gateway deploy`.
4. Approve the environment gate.
5. Verify: `curl -sf http://172.21.0.2:9300/operator/health` (run on the droplet or via SSH) returns `200 {"ok":true}`.

### Updating the allowlist

1. Prepare the new allowlist (one numeric GitHub user ID per line).
2. Seed the new value:
   ```bash
   printf '%s\n%s\n' '12345678' '87654321' | gh secret set --env gateway GATEWAY_OPERATOR_ALLOWLIST
   ```
3. Trigger a deploy: `bunx @marcusrbrown/infra gateway deploy`.
4. Approve the environment gate.
5. Verify: attempt the OAuth flow with a removed user — confirm auth failure.

---

## Rollback

To disable operator auth/config wiring entirely:

1. Remove or clear **both** the listener trio **and** the four auth/config secrets from the `gateway` GitHub Environment:
   - Listener trio: `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`, `GATEWAY_OPERATOR_PUBLIC_ORIGIN`
   - Auth/config secrets: `GATEWAY_OPERATOR_GITHUB_CLIENT_ID`, `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`, `GATEWAY_OPERATOR_CSRF_SECRET`, `GATEWAY_OPERATOR_ALLOWLIST`
2. Trigger a deploy: `bunx @marcusrbrown/infra gateway deploy`.
3. Approve the environment gate.
4. The deploy detects the operator listener is disabled, skips all operator auth/config wiring, and runs `docker compose up --remove-orphans`.
5. The gateway restarts with the operator listener disabled. All active operator sessions are invalidated (in-memory — no data rollback needed).
6. Verify: `bunx @marcusrbrown/infra gateway status` shows all services healthy.

**Note:** Listener trio present + auth/config secrets absent is not a valid state — the deploy fails before any SSH. The only supported rollback is to clear **both** the listener trio and the four auth/config secrets together. This disables the operator listener entirely; the gateway continues to serve all other routes normally.

---

## Secret File Mapping

The four auth/config secrets are materialized as files on the droplet under `/opt/gateway/deploy/secrets/`. Each file is owned `root:root` with mode `0600`. Secret bytes enter via SSH stdin only — never via argv.

| Host file (kebab-case) | Compose mount (snake_case) | Container env var (`_FILE`) |
| --- | --- | --- |
| `gateway-operator-github-client-id` | `/run/secrets/gateway_operator_github_client_id` | `GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE` |
| `gateway-operator-github-client-secret` | `/run/secrets/gateway_operator_github_client_secret` | `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET_FILE` |
| `gateway-operator-csrf-secret` | `/run/secrets/gateway_operator_csrf_secret` | `GATEWAY_OPERATOR_CSRF_SECRET_FILE` |
| `gateway-operator-allowlist` | `/run/secrets/gateway_operator_allowlist` | `GATEWAY_OPERATOR_ALLOWLIST_FILE` |

The secrets checksum at `/opt/gateway/.secrets-checksum` includes these files when operator auth is enabled. Rotation of any auth/config secret changes the checksum, triggering `--force-recreate` on the next deploy.
