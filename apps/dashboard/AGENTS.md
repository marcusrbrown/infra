# apps/dashboard — Dashboard deploy

Fro Bot operator dashboard for `dashboard.fro.bot`. A two-service Docker Compose stack (dashboard +
caddy) on a dedicated DigitalOcean droplet, fronted by Caddy for automatic HTTPS. The dashboard image
is the upstream released image from `ghcr.io/fro-bot/dashboard`, pinned by digest in
`apps/dashboard/docker-compose.yaml`. The deploy pulls the digest-pinned image — no on-droplet build.

## Stack

| Service     | Image                                                    | Role                                                    |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `dashboard` | `ghcr.io/fro-bot/dashboard:<tag>@sha256:<digest>` (digest-pinned in compose) | Hono app on `:3000`; GitHub App + OAuth; healthcheck at `/api/healthz` |
| `caddy`     | `caddy:2.11.3-alpine` (digest-pinned)                    | Auto-TLS reverse proxy `:443 → dashboard:3000`          |

The dashboard image tag and digest are pinned directly in `apps/dashboard/docker-compose.yaml`.
Renovate tracks the `ghcr.io/fro-bot/dashboard` image and opens PRs to bump the pin when a new
release is published. Caddy depends on the `dashboard` service being healthy before starting.

## Deploy flow

`bun run --cwd apps/dashboard deploy` (or the **Deploy Dashboard** GitHub workflow). Both entry paths use the same deploy engine. The deploy:

1. Validates env (`DASHBOARD_DOMAIN`, `DASHBOARD_GITHUB_APP_ID`, `DASHBOARD_GITHUB_APP_KEY`,
   `DASHBOARD_OAUTH_CLIENT_ID`, `DASHBOARD_OAUTH_CLIENT_SECRET`, `DASHBOARD_OPERATOR_LOGIN`,
   `DASHBOARD_COOKIE_KEY`, plus SSH context) and the host string before any SSH argv is built.
2. DNS preflight — resolves `DASHBOARD_DOMAIN` and fails fast if it does not resolve.
3. Generates the target digest and Compose content locally. Versioned deploys resolve the GHCR
   digest and cross-check any dispatched digest; local/no-version deploys use the committed Compose
   pin. The `.env`, Caddyfile, and PEM payload are also assembled locally before SSH.
4. Starts one SSH process whose remote transaction validates `/run/dashboard-deploy` as a canonical,
   root-owned `0700` directory and acquires `/run/dashboard-deploy/lock` with a 180-second bounded
   wait. The kernel lock is held by the process doing the work and releases on process death; there
   is no stale-lock cleanup or separate lock-holder. The remote Bash transaction is wrapped in a fixed
   900-second `timeout` (`TERM`, then `KILL` after 15 seconds), and the local caller has a 960-second
   watchdog that escalates the SSH process if its lifecycle does not settle.
5. After the lock, validates `/opt/dashboard`, `/opt/dashboard/config`, and `/opt/dashboard/data`
   without accepting symlinks or unsafe types, then records baseline storage, Docker disk, container,
   active Compose, and running dashboard evidence.
6. Always runs `docker image prune -af`. A prune failure stops the deploy. Docker may reclaim image
   data through this command, but the deployment never directly deletes containerd storage or files;
   it never prunes containers or volumes or uses Compose teardown. The first 6 GiB free-space gate is
   checked after post-prune evidence.
7. Enumerates the staged Compose image set and verifies every exact `repository@digest` locally first.
   If all are cached, it skips the pull and records `acquisition:mode=cache`. Otherwise it runs the
   staged Compose pull, verifies the complete exact set, and records `pull`; a failed pull is allowed
   only when the complete exact cache is present afterward, recorded as `cache-fallback`. Tags are
   never trusted. The second 6 GiB gate is checked after acquisition and before active mutation.
8. Converges `/opt/dashboard/data` to a real directory owned by `1000:1000` with mode `0700`, then
   publishes `.env`, `Caddyfile`, the GitHub App PEM, and Compose one file at a time, with Compose
   last. The PEM is a regular file owned by `1000:1000`, mode `0600`; `.env` is root-owned mode
   `0600`; Caddyfile and Compose are root-owned mode `0644`.
9. Runs `docker compose up -d --no-build --wait dashboard`, verifies the running dashboard digest
   against the expected digest and its health, then force-recreates and waits for Caddy. The lock
   remains held through this convergence and releases when the SSH transaction exits.
10. After unlock, runs the same-origin operator-health and public HTTPS probes as advisory checks.
    Versioned deploys write the local Compose pin for the audit PR only after the remote transaction
    succeeds and both advisory probe attempts finish; probe warnings or failures do not block the
    write-back.

In CI the SSH key is materialized from `DASHBOARD_SSH_KEY` to a temp file with a trailing newline
(GitHub strips trailing whitespace from secrets) and `chmod 600`; locally it uses the ssh-agent.

### Supersede (stale-run cancellation)

- The `supersede` job in `deploy-dashboard.yaml` cancels older `waiting` runs of the same workflow
  when a new `workflow_dispatch` fires, so a stale unapproved run can't hold the queue slot ahead of
  a newer release. It only cancels runs older than the current one, scoped to `deploy-dashboard.yaml`.
- It runs on `workflow_dispatch` only and is skipped when the workflow is invoked via `workflow_call`
  from the deploy router (`deploy.yaml`).
- `supersede` needs `actions: write`, so the router's `deploy-dashboard` caller job grants both
  `contents: read` and `actions: write` — a job inside a reusable workflow can't request a scope its
  caller lacks, and omitting it fails the entire router run at startup validation with zero jobs
  created. `packages/cli/src/conventions.test.ts` enforces this parity.

### Retention and failure handling

Pruning is pre-deploy only. The replaced image is left locally as one temporary rollback generation
after a successful replacement, but the next deployment attempt may prune it. This is not an
automatic rollback guarantee. Stopped containers pin their images just like running containers. If
those pins keep free space below 6 GiB, inspect the stopped containers, remove only specifically
obsolete ones manually, and rerun; no automatic override flag exists.

The operator must resolve the reported condition before rerunning. Every remote failure returns a
stable lowercase-hyphen code plus the last completed stage; remote stderr is intentionally not surfaced.
Deterministic failure classes are:

- **Lock contention:** wait for the other transaction to finish, then rerun.
- **Prune failure:** resolve the Docker cleanup error; do not bypass pruning.
- **Post-prune low headroom:** inspect storage and stopped-container pins; remove only specifically
  obsolete stopped containers manually, then rerun.
- **Acquisition/cache mismatch:** restore registry access or make every staged exact digest available;
  a tag-only or wrong-digest cache entry does not qualify.
- **Post-acquisition low headroom:** resolve capacity before allowing active publication.
- **Active publication/runtime failure:** inspect the reported stage and actual Compose/runtime state;
   do not assume automatic rollback, then correct the condition and rerun.
- **Transaction timeout:** inspect the reported stage and host state after the fixed remote deadline;
  retry only after confirming the previous process is gone. The caller watchdog also terminates a
  hung local SSH process. GNU `timeout` statuses 124 and 137 are conservatively normalized to the
  reserved transaction-timeout code because the utility cannot distinguish a child’s independent
  exit 137 from kill-after escalation.

## Image source

The dashboard image is the upstream released image from `ghcr.io/fro-bot/dashboard`, pinned by tag
and digest in `apps/dashboard/docker-compose.yaml`. Renovate tracks this image and opens PRs to bump
the pin when a new release is published. Merging a Renovate PR triggers the Deploy Dashboard workflow,
which pulls the new digest and ships it to the droplet automatically.

The former `ghcr.io/marcusrbrown/infra-dashboard` image (built by this repo's CI) is retired. It can
be deleted manually from the GitHub Container Registry once no references remain.

## Container hardening

The `dashboard` service runs with a deliberate security hardening block — a delta from `apps/umami`:

```yaml
read_only: true
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
user: node
tmpfs:
  - /tmp
```

- **`read_only: true`** — the container filesystem is read-only; `/tmp` (tmpfs) and the listener data
  mount are the writable surfaces. The App-key mount remains read-only.
- **`cap_drop: [ALL]`** — drops all Linux capabilities; the Hono app needs none.
- **`no-new-privileges: true`** — prevents privilege escalation via setuid/setgid binaries.
- **`user: node`** — runs as the non-root `node` user baked into the upstream image.
- **`tmpfs: /tmp`** — provides a writable scratch space without touching the host filesystem.

**Persistent listener storage:**

```yaml
volumes:
  - type: bind
    source: /opt/dashboard/data
    target: /data
    bind:
      create_host_path: false
```

The `/data` bind mount is the writable surface for the dashboard's listener SQLite state. The host
directory is converged at deploy time to mode `0700`, owner `1000:1000`, and persists across container
recreation. `bind.create_host_path: false` prevents Compose from silently creating a missing or
mis-typed host path; deploy must establish the validated directory first.

**GitHub App private key mount:**

```yaml
volumes:
  - /opt/dashboard/config/github-app.pem:/run/secrets/github-app.pem:ro
```

The key is bind-mounted read-only into the container at `/run/secrets/github-app.pem`. The `.env`
sets `DASHBOARD_GITHUB_APP_KEY_FILE=/run/secrets/github-app.pem` so the app reads the key via file
path, never via an env-string fallback.

**Why a file mount instead of an env var for the App private key:**

- `docker inspect` exposes all env vars in plaintext to any process with Docker socket access.
- Process listings (`/proc/<pid>/environ`) expose env vars to other processes on the host.
- Crash dumps and OOM reports may capture the process environment.
- A PEM key is long-lived key material — the blast radius of an env-var leak is permanent until the
  key is revoked. File mounts with `0600` permissions and `read_only: true` containers minimize
  exposure to the app process only.

## Secret rotation

- **`DASHBOARD_SSH_KEY`.** Replace the secret and update the authorized key on the droplet. No
  redeploy required for the running stack; the new key takes effect on the next SSH connection.
- **`DASHBOARD_DOMAIN`.** Update the secret and DNS record, then redeploy.
- **`DASHBOARD_GITHUB_APP_ID`.** Update the secret and redeploy.
- **`DASHBOARD_GITHUB_APP_KEY`.** Generate a new private key in the GitHub App settings, update the
  `DASHBOARD_GITHUB_APP_KEY` secret, and redeploy. The deploy uploads the new PEM to
  `/opt/dashboard/config/github-app.pem` (0600) via SSH stdin. After confirming the new key works,
  revoke the old key in the GitHub App settings.
- **`DASHBOARD_OAUTH_CLIENT_ID` / `DASHBOARD_OAUTH_CLIENT_SECRET`.** Rotate in the GitHub OAuth App
  settings, update the secrets, and redeploy. Existing sessions are invalidated.
- **`DASHBOARD_OPERATOR_LOGIN`.** Update the secret and redeploy.
- **`DASHBOARD_COOKIE_KEY`.** Rotating invalidates all existing sessions (users re-authenticate).
  Update the secret and redeploy.

## Upgrade flow

Renovate opens PRs when a new `ghcr.io/fro-bot/dashboard` release is published. Merge the PR → the
Deploy Dashboard workflow pulls the new digest-pinned image and ships it to the droplet automatically.

For rollback procedures, see [`docs/runbooks/dashboard-released-image-rollback.md`](../../docs/runbooks/dashboard-released-image-rollback.md).

## CLI

| Command                                    | Purpose                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `infra dashboard status`                   | SSH `docker compose ps` → service/state/health rows (MCP-exposed)          |
| `infra dashboard deploy [--image-version <calver>] [--digest <sha256>]` | Dispatch the Deploy Dashboard workflow (default), optionally with explicit image inputs, or `--local`; image flags are remote-only and `--digest` requires `--image-version` |
| `infra dashboard logs [service] [--tail N]`| Stream container logs via SSH (CI-guarded; emits a sensitive-data warning) |

`infra status` includes a `dashboard` row (and a `dashboard` key under `--json`).

Valid services for `dashboard logs`: `dashboard`, `caddy`.

## Provisioning

One-time: `bun run provision:dashboard` (root wrapper — loads the repo-root `.env`; `--cwd
apps/dashboard` would miss it) creates the `s-1vcpu-1gb` droplet (image `docker-20-04`, region
`nyc1`, name `dashboard`), selects the SSH key by name (`DASHBOARD_SSH_KEY_NAME`, default
`fro-bot-dashboard`), waits for SSH, and pins both the domain and droplet-IP host keys into
`.github/known_hosts` (commit the result before the first CI deploy).

SSH auth during provisioning: when `DASHBOARD_SSH_KEY` is set, the script materializes it to a `0600`
temp key file and pins it with `-i` + `IdentitiesOnly=yes` (no ssh-agent needed; cleaned up after).
When unset, it falls back to ssh-agent.

## Operator UI (same-origin)

The operator UI is **enabled same-origin**. The deploy sets `DASHBOARD_OPERATOR_UI_ENABLED=true`
and `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true` as static constants in the `.env` written by
`buildEnvFileContents` — no new secrets required. The SSE run-stream UI is reachable at
`https://dashboard.fro.bot/operator/*` behind the operator auth boundary. The gateway operator
session is the single auth authority; `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` defaults to
`https://dashboard.fro.bot` and is not set explicitly.

The ratified browser-visible operator API origin is `https://dashboard.fro.bot/operator/*`. The
dashboard Caddy instance owns the `/operator/*` route and proxies it to the gateway operator
listener over the shared DigitalOcean VPC. This makes the operator API same-origin with the
dashboard UI.

**Current state:** The dashboard Caddy `/operator/*` route is **live**. The route is a `handle`
block before the `dashboard:3000` catch-all in `apps/dashboard/config/Caddyfile`, targeting
`{$GATEWAY_VPC_IP}:9300` over the VPC. The gateway operator listener is reachable from the
dashboard droplet via the shared DigitalOcean VPC (`nyc1`; gateway VPC IP `10.116.0.3`, dashboard
VPC IP `10.116.0.5` — example values; actual IPs are set via `GATEWAY_VPC_IP`).

**Docker network alias:** The `caddy` service declares a Docker network alias `dashboard.fro.bot`
on the shared `default` network. The dashboard server validates every request by calling
`https://dashboard.fro.bot/operator/session` server-side. Without the alias, that call hairpins to
the droplet's public IP — DigitalOcean has no NAT loopback, so it times out. The alias routes the
call to Caddy via Docker DNS; Caddy's `/operator/*` handle block proxies it to the gateway VPC.
Both services are explicitly attached to the `default` network so existing DNS (`dashboard:3000`)
remains intact. The alias is in the committed `docker-compose.yaml` base file — not an override —
because the deploy removes any `docker-compose.override.yaml` on every run.

**Route configuration:**

```
handle /operator/* {
    flush_interval -1
    header_up Host dashboard.fro.bot
    header_up X-Forwarded-Proto https
    reverse_proxy {$GATEWAY_VPC_IP}:9300
}
```

- `flush_interval -1` — disables response buffering for future SSE streams.
- `header_up Host dashboard.fro.bot` + `header_up X-Forwarded-Proto https` — satisfies the gateway
  daemon's forwarded-header guard (`X-Forwarded-Host` must match `PUBLIC_ORIGIN` host).
- `{$GATEWAY_VPC_IP}` — Caddy native env expansion; the dashboard `caddy` service receives
  `GATEWAY_VPC_IP` from the deploy `.env`. Never use a literal IP in the Caddyfile.
- The `handle` block must appear **before** the `reverse_proxy dashboard:3000` catch-all — Caddy
  compiles directives in fixed order, not source order; a bare catch-all sorts ahead and self-404s
  a matched route.

**Required env var:**

| Variable | Where set | Description |
| --- | --- | --- |
| `GATEWAY_VPC_IP` | `dashboard` GitHub Environment + local `.env` | Gateway droplet's DigitalOcean VPC IP (e.g. `10.116.0.3`). The dashboard `caddy` service expands `{$GATEWAY_VPC_IP}` from `.env`. Caddy fails to start if the var is set but unresolved. |

Seed `GATEWAY_VPC_IP` in the `dashboard` GitHub Environment before deploying the route. The
same-origin path only works after the gateway VPC bridge is live (see
`apps/gateway/AGENTS.md` [Operator private path](#operator-private-path-dashboard-same-origin) and
`docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md`).

See `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` for the full decision
record.

## OPERATOR PUSH

`DASHBOARD_OPERATOR_PUSH_ENABLED` is an independent, server-side dashboard flag. Only the exact
string `true` is rendered as `DASHBOARD_OPERATOR_PUSH_ENABLED=true`; absent, false, whitespace-variant,
or malformed input is omitted and remains default-off.

The dashboard deploy accepts no VAPID material and no endpoint pointer. At runtime, the existing
consent flow and a trusted user gesture own subscription; the flag alone never auto-prompts or
auto-subscribes. That flow fetches the public key from the gateway's authenticated
`GET /operator/push/vapid-key` route. A disabled or guard-denied gateway route is a disabled result.
Dashboard and gateway activation are independently actionable, but real end-to-end push requires both
sides and the `fro-bot/dashboard#238` privacy-policy prerequisite.

## Anti-patterns

- **Never put the GitHub App private key in an env var** — use the file mount
  (`/run/secrets/github-app.pem`) and `DASHBOARD_GITHUB_APP_KEY_FILE`. Env vars are visible via
  `docker inspect`, process listings, and crash dumps; long-lived key material must not travel that
  path.
- **Never `docker compose down -v`** — destroys the `caddy_data` volume (Caddy TLS certificates and
  ACME state). Do not use Compose teardown to recover a failed deploy.
- **Never remove `/opt/dashboard/data` casually** — it contains persistent listener SQLite state and
  removing it destroys Inbox data across container recreation. Treat deletion as an explicit destructive
  storage reset.
- **Never add `--build` to the dashboard deploy** — the deploy pulls the digest-pinned image from
  `ghcr.io/fro-bot/dashboard`; on-droplet builds are not supported and `--no-build` is enforced in
  the deploy script.
- **Never put secret values in SSH argv** — the deploy sends them in the framed SSH stdin payload.
  Shell metacharacters in secret values are rejected before any SSH connection is opened.
- **Never skip `validateDashboardHost`** — it rejects `-`-prefixed values and characters outside the
  allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`).
- **Never wire `apps/dashboard/config/Caddyfile` to proxy `/operator/*` to `gateway.fro.bot`** —
  that would route browser operator calls to the public gateway edge, not through the private VPC
  path. The dashboard→gateway path must use `{$GATEWAY_VPC_IP}` (config), never a literal IP or
  the public gateway hostname. See the operator same-origin target section above.
- **Never put the `/operator/*` handle block after the `dashboard:3000` catch-all** — Caddy
  compiles directives in fixed order; a bare `reverse_proxy` catch-all sorts ahead and self-404s
  any route that follows it. The `/operator/*` block must be a `handle` block before the catch-all.
- **Never set `GATEWAY_VPC_IP` to a literal IP in the Caddyfile** — use `{$GATEWAY_VPC_IP}` and
  inject the value via the `caddy` service env. Hardcoded IPs break on droplet rebuild and make
  the config non-auditable.
- **Never move the `dashboard.fro.bot` alias to a `docker-compose.override.yaml`** — the deploy
  removes `/opt/dashboard/docker-compose.override.yaml` on every deploy. The alias must live in the
  committed base `docker-compose.yaml`.
- **Never set `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=false`** — the gateway operator session
  is the single auth authority. Setting it false disables session validation and breaks the operator
  UI auth boundary.
