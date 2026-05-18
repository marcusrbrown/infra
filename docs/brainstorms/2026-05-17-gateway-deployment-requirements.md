# Gateway Deployment Requirements

**Date:** 2026-05-17
**Status:** brainstorm

## Problem Statement

The Fro-Bot gateway shipped v1 in `fro-bot/agent` over the past day. It's a
Discord bot that runs as a three-service Docker Compose stack (gateway,
workspace, mitmproxy with egress allowlist) and currently lives in
`fro-bot/agent/deploy/` as an operator-runnable but unhosted workflow.

To use it in practice I need:

- One-command deploys from this repo without juggling SSH manually
- Operational visibility next to `keeweb` and `cliproxy` (unified
  `infra status` already wants a third row)
- A durable home for the gateway's secrets and host config that survives
  rewrites in the upstream gateway repo
- Eventually, the ability to host the gateway on hardware separate from
  the repo that defines it

This brainstorm scopes the minimum-viable infrastructure app to host one
gateway against a pinned `fro-bot/agent` release tag
(`v0.44.0` is the v1 baseline; future bumps tracked per R10).

## Goals

- **G1** — One gateway running, reachable from my Discord server, with all
  three Compose services (gateway, workspace, mitmproxy) running. Health
  is reported where defined — gateway and mitmproxy have healthchecks in
  upstream v1; workspace ships without one and gains a healthcheck when
  Unit 7 lands a real image.
- **G2** — `bunx @marcusrbrown/infra gateway deploy` ships a new revision
  end-to-end without manual SSH.
- **G3** — `bunx @marcusrbrown/infra gateway status` shows the same kind
  of at-a-glance health that `keeweb` and `cliproxy` do.
- **G4** — `bunx @marcusrbrown/infra status` includes the gateway as a
  third row.
- **G5** — Secrets live in a single GitHub Environment and reach the
  droplet only at deploy time. None of them touch tracked files in this
  repo.
- **G6** — Operators can debug a failing gateway without memorizing
  manual SSH incantations. (Supports the `gateway logs` and
  `gateway backup` commands as first-class debugging surfaces.)
- **G7** — The mitmproxy trust anchor is recoverable after droplet
  loss without rebuilding the entire stack from scratch. (Supports
  the `gateway backup --include-ca` flow.)

## Non-Goals (explicit)

- **NG1** — Not redesigning the upstream gateway. The fro-bot/agent v1
  plan sequences Units 5–8 (channel↔repo binding, message routing, real
  workspace image, e2e tests). This app consumes those as they land; it
  does not reorder or fork them.
- **NG2** — No public HTTP surface, no DNS A record for HTTP traffic, no
  TLS termination, no Caddy. The gateway connects outbound to Discord,
  GitHub, S3, and LLM providers. mitmproxy listens on the internal Docker
  network only. The droplet gets a hostname for SSH operations, but
  nothing serves HTTP from it.
- **NG3** — No multi-gateway control plane, no cross-Discord-server
  routing, no fleet management. Single gateway, single Discord server.
- **NG4** — No co-tenancy with cliproxy on the same droplet. Separate
  blast radius; the workspace container under load could otherwise crowd
  cliproxy's request handling.
- **NG5** — No pre-built workspace image pushed to a registry. The
  droplet builds the workspace image locally via `docker compose build`.
  Revisit when Unit 7 lands and the image gets heavy enough that
  droplet builds hurt deploy time.
- **NG6** — No secret rotation automation, no log shipping, no
  observability stack, no S3 lifecycle cost monitoring. Operators rotate
  by editing GitHub Environment secrets and redeploying.
- **NG7** — No Docker Swarm secrets, no sops/age encrypted blobs, no
  Vault/1Password integration. Bind-mounted secret files written by the
  deploy script. Matches upstream's accepted-risk decision for v1.
- **NG8** — No `gateway setup` interactive wizard for v1. Per-droplet
  setup is one-time-per-droplet and rare enough that a documented
  procedure beats a wizard for now.
- **NG9** — No `gateway open` command. There's no UI surface unless
  mitmproxy's dev web UI is enabled via compose override, which isn't
  part of the production stack.

## Requirements

### R1 — App scaffolding

- `apps/gateway/` mirrors `apps/cliproxy/` shape: `package.json`,
  `src/`, `server/`, `AGENTS.md`.
- `apps/gateway/upstream.json` pins the fro-bot/agent source:
  `{ "repo": "fro-bot/agent", "ref": "v0.44.0" }` as v1 baseline. Future
  bumps land Renovate-driven (R10). Refs are SemVer release tags from
  fro-bot/agent's active auto-release workflow.
- Added to the Bun workspace via root `package.json`.
- `apps/gateway/package.json` exposes `deploy` script that invokes
  `bun run src/deploy.ts`.

### R2 — Host

- One dedicated DigitalOcean droplet. Initial size for v1:
  `s-1vcpu-2gb` (the workspace placeholder uses negligible resources,
  but the gateway daemon + Node.js + mitmproxy together need >1GB; the
  cliproxy `s-1vcpu-1gb` baseline is too tight for this stack).
- Resize triggers (any of):
  - Deploy duration exceeds 4 minutes (workspace image rebuild
    starting to dominate)
  - Container memory headroom under 25% on the gateway service
  - Sustained CPU saturation under normal Discord traffic
  Document the trigger that prompts a resize alongside the resize
  PR. Unit 7's real workspace image is the most likely trigger; we
  reassess sizing then with empirical evidence rather than guessing.
- Cliproxy mirror caveat: cliproxy runs `s-1vcpu-1gb`; gateway needs
  more because of the multi-service Compose stack. Sizing parity is
  not a goal.
- Hostname `gateway.fro.bot` (or similar) with an A record. Hostname is
  used for SSH operations only; nothing serves HTTP from it.
- SSH host keys pinned in `.github/known_hosts` after first
  provision (same pattern as cliproxy: provision script runs once
  locally with `ssh-keyscan`, commits the result; CI never uses
  `ssh-keyscan`).
- Droplet runs Docker and `docker compose` (Ubuntu LTS or DO's
  Docker-preinstalled image).

### R3 — Source materialization on droplet

- Deploy script SSHes into the droplet and clones `fro-bot/agent` to
  `/opt/gateway/` if absent, fetches + checks out the pinned ref from
  `apps/gateway/upstream.json` otherwise. The upstream repo becomes the
  droplet's working tree at `/opt/gateway/`.
- The compose project root is `/opt/gateway/deploy/` — matching the
  upstream layout, so `./secrets/...` paths in `compose.yaml` resolve
  correctly. Deploy invocations run with that directory as cwd, or with
  `docker compose --project-directory /opt/gateway/deploy ...`.
- Upgrading the gateway = bump SHA in `upstream.json`, commit,
  redeploy. Idempotent.

### R4 — Secret materialization

- Sensitive secrets in GitHub Environment `gateway`:
  - `GATEWAY_SSH_KEY` — private key for droplet SSH access
  - `DISCORD_TOKEN` — Discord bot token
  - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — S3/R2 credentials
- Configuration values in the same environment:
  - `DISCORD_APPLICATION_ID`
  - `DISCORD_GUILD_ID` (always set; see R7)
  - `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT` (for R2)
  - `GATEWAY_HOST` — droplet domain (e.g. `gateway.fro.bot`)
- Deploy script reads these from `process.env`, writes bind-mount
  files via SSH to `/opt/gateway/deploy/secrets/<name>` with
  `chmod 600`. (The path matches the compose project root from R3 so
  Compose's relative `./secrets/...` references resolve.)
- Secret file lifecycle:
  - **Owner / group**: `root:root` on the droplet (the deploy SSH user
    is root; document narrowing to a dedicated `gateway` user with
    Docker group membership as a deferred hardening step in
    `apps/gateway/AGENTS.md`).
  - **Rotation**: re-running deploy overwrites the secret files in
    place. The deploy script does not currently shred or zero the old
    contents; documented limitation. After rotation, restart the
    affected services (`docker compose restart gateway workspace`) so
    the new values get re-read.
  - **Decommission**: deprovisioning the droplet is the cleanup
    boundary. `apps/gateway/AGENTS.md` documents `rm -rf /opt/gateway`
    + droplet destroy as the procedure. No need for in-place wipe
    helpers in v1.
- `OBJECT_STORE_HOSTS` env var written to `/opt/gateway/deploy/.env`
  is computed by the deploy script from `S3_BUCKET` + optional
  `S3_ENDPOINT`:
  - `S3_ENDPOINT` set → `<bucket>.<endpoint-host>` (R2 pattern)
  - `S3_ENDPOINT` unset → `<bucket>.s3.<region>.amazonaws.com` (AWS
    pattern)
  - An operator may also set an explicit `OBJECT_STORE_HOSTS` value in
    the GitHub Environment to override the computation entirely — used
    when the S3 endpoint shape doesn't fit the AWS/R2 templates (custom
    MinIO endpoints with paths or ports, multi-bucket allowlists, etc.).
- Secret values never appear in tracked files. CI's secret-handling
  rules from the rest of the repo apply (no `secrets: inherit` across
  orgs, no echoing into logs).

### R5 — CLI surface

Four commands under `bunx @marcusrbrown/infra gateway ...`, mirroring
the cliproxy command pattern under `packages/cli/src/commands/gateway/`:

- **`gateway status`** — SSHes into the droplet, runs
  `docker compose ps --format json` against the compose file, parses
  container states for all three services and healthcheck results
  where defined (gateway and mitmproxy in v1; workspace once Unit 7
  lands a healthcheck). Output mirrors the cliproxy status table.
- **`gateway deploy`** — Default `--remote` triggers the GitHub Actions
  Deploy Gateway workflow via `gh workflow run`; `--local` runs
  `src/deploy.ts` directly from the developer machine (same toggle
  shape as cliproxy).
- **`gateway logs [service] [--tail N]`** — SSHes in and runs
  `docker compose logs --tail=N` against one of the three services
  (defaults to `gateway`). Operator-only via SSH boundary. Upstream
  gateway is responsible for not logging raw Discord tokens, S3
  credentials, user message bodies, or other PII; this app surfaces
  whatever upstream writes and does no client-side redaction. Any
  observed secret-in-logs leak is filed upstream against fro-bot/agent.
- **`gateway backup [--output <file>] [--include-ca] [--include=<a,b>]`** —
  Extensible backup surface. With `--include-ca` (or `--include=ca`)
  dumps the mitmproxy CA cert from the `mitmproxy-certs` named volume
  via `docker run --rm -v mitmproxy-certs:/src:ro alpine cat
  /src/mitmproxy-ca-cert.pem` and writes to a local file (default
  `apps/gateway/.local/mitmproxy-ca.pem`). The `--include=` flag is the
  forward-extensible mechanism for backing up additional state
  (workspace volumes, config snapshots, etc.) as they appear; v1 ships
  with `ca` as the only supported include. Restore procedure is
  documented in `apps/gateway/AGENTS.md`.

All four commands appear in `bunx @marcusrbrown/infra status` only via
the existing aggregator (`getStatusSummary()`-style per-app function).
The gateway entry surfaces droplet reachability + the three
container-health bits.

### R6 — Deploy workflow

- New `.github/workflows/deploy-gateway.yaml`, modeled on
  `deploy-cliproxy.yaml`:
  - Triggers: `push` to main, `workflow_dispatch`, `workflow_call`
  - Path filter via `dorny/paths-filter@v4.0.1` with
    `predicate-quantifier: every` (see conventions test) and
    negation patterns for `*.md`, `*.test.ts`, fixtures, snapshots
  - Job runs in `gateway` GitHub Environment
  - Node 24 pinned via `actions/setup-node`
  - SSH known_hosts seeded from `.github/known_hosts`
  - `webfactory/ssh-agent` for the SSH key
  - Calls `bun run --cwd apps/gateway deploy`
- Required secrets / variables validated at workflow start with a
  `Validate required secrets` step; missing secrets fail fast with a
  clear message.

### R7 — Discord slash command registration & authorization

- Slash commands register guild-scoped via `DISCORD_GUILD_ID`. Single
  Discord server, fast propagation, single-tenant gateway.
- Global commands are a v2 concern; deferred until a second consumer
  exists.
- Authorization tier (v1): commands split into two tiers:
  - **Public**: `/fro-bot ping` (and any future read-only / no-side-effect
    informational commands). Any guild member may invoke.
  - **Operator-only**: any command that triggers gateway state changes,
    workspace work, or accesses S3 / GitHub on behalf of the operator.
    Gated on the invoker holding the Discord role identified by env
    `DISCORD_OPERATOR_ROLE_ID` (or being the application owner if the
    env is unset, which is the fail-safe default for the single-tenant
    case). Configured as a non-secret GitHub Environment variable.
- Tier enforcement lives in the upstream gateway. This app's
  contribution is wiring `DISCORD_OPERATOR_ROLE_ID` through deploy as
  another bind-mount or env var, mirroring how `DISCORD_GUILD_ID` is
  handled.
- Until the upstream gateway implements operator-only command tiers,
  this requirement reduces to: only deploy a gateway image / pinned
  upstream ref that has the authorization model wired. If the pinned
  ref pre-dates operator-tier support, deploy is gated on the gateway
  having only the `ping` command registered. This is enforced via the
  pinned ref review at upgrade time, not via automated check.

### R8 — Provisioning

- `apps/gateway/server/provision-droplet.ts` provisions a fresh DO
  droplet, idempotent against an existing droplet (refuses to re-run
  without `--force`, same safety as the cliproxy provisioner).
- After droplet creation, the script appends host keys (domain
  unhashed + IP hashed) to `.github/known_hosts` so CI deploys work
  without `ssh-keyscan`.
- Installs Docker + Docker Compose plugin via DO's preinstalled
  Docker image where possible; documents any manual install steps in
  `apps/gateway/AGENTS.md`.
- Documents the one-time setup steps: create gateway GitHub
  Environment, add secrets/variables listed in R4, register the
  Discord bot, configure S3/R2 bucket.

### R9 — mitmproxy CA durability

- v1 accepts that a droplet-loss event means a fresh CA. The deploy
  recreates the entire stack from upstream HEAD; workspace and gateway
  trust the new CA via the shared named volume on first start. No
  persistent state outside that volume depends on the CA.
- `gateway ca-backup` exists as a defensive measure (R5), not as part
  of any automated backup loop.

### R10 — Upstream cadence

- fro-bot/agent has an active SemVer release cadence via
  `auto-release.yaml` + `prepare-release-pr.yaml`, with proper
  changelogs and conventional-commit-grouped release notes. Latest
  v0.44.0 (2026-05-17) ships gateway v1; the `v0.4x.y` line has been
  cutting near-daily releases through May.
- Renovate watches fro-bot/agent releases via a custom data source
  pointed at the GitHub releases endpoint, opens PRs that bump
  `apps/gateway/upstream.json` to the latest tag. Renovate is
  configured to group fro-bot/agent updates separately from Docker
  image updates so the release-note contribution is reviewable.
- Initial upgrade flow until the Renovate config lands: manual
  `upstream.json` edits with a PR per bump.
- `apps/gateway/upstream.json` is the only file that needs to change
  to pick up a new gateway revision; the deploy workflow does
  everything else.

### R11 — Documentation

- `apps/gateway/AGENTS.md` documents:
  - The deploy flow (R3 source materialization, R4 secrets)
  - The 4 CLI commands and when to use each
  - One-time provisioning procedure (R8)
  - mitmproxy CA backup/restore procedure (R5, R9)
  - Pinning + upgrade workflow (R10)
  - The `OBJECT_STORE_HOSTS` computation rule (R4)
  - The Discord authorization tiers and `DISCORD_OPERATOR_ROLE_ID`
    wiring (R7)
  - Secret file lifecycle: rotation procedure, decommission cleanup,
    deferred hardening to a dedicated `gateway` user (R4)
  - Anti-patterns inherited from cliproxy: no `ssh-keyscan` in CI, no
    `secrets: inherit` cross-org, no overwriting on-disk state files
- Root `AGENTS.md` "WHERE TO LOOK" table gets a row per command.
- Root `README.md` adds a gateway section in the same shape as the
  cliproxy section after the brainstorm becomes a plan and the plan
  becomes shipped code.

### R12 — Testing

- Colocated `*.test.ts` files for each CLI command and for
  `src/deploy.ts`, mirroring the cliproxy test layout.
- Conventions test (`packages/cli/src/conventions.test.ts`) catches
  the obvious structural mistakes (workflow path filter quantifier,
  `.yaml` extension, SHA-pinned actions, no `secrets: inherit`); no
  new conventions are needed for this app.
- No live Discord or S3 tests in CI. Mock `Bun.spawn` and `fetch`
  boundaries.

## Open Questions (resolved during brainstorm)

| Question | Resolution |
| --- | --- |
| App shape: thin Compose wrapper, cliproxy-pattern app, or thick ops layer? | cliproxy-pattern at minimum scope |
| Where does the gateway run? | Dedicated DO droplet, `gateway.fro.bot` style hostname |
| How do secrets get to the bind-mount paths? | Deploy script writes files via SSH from GitHub Environment vars |
| Which CLI commands belong in v1? | status, deploy, logs, ca-backup |
| How is fro-bot/agent source materialized on the droplet? | Git-clone on droplet, pin SHA via `apps/gateway/upstream.json` |
| Is the mitmproxy CA backed up? | Yes, manual via `gateway ca-backup`; no automated backup |
| How is `OBJECT_STORE_HOSTS` computed? | By deploy script from `S3_BUCKET` + optional `S3_ENDPOINT` |
| Discord command scope? | Guild-scoped (`DISCORD_GUILD_ID` always set) |
| Who updates the upstream pin? | Renovate watches fro-bot/agent releases (active since v0.42.x); manual bumps until the Renovate rule lands |
| How does the gateway evolve as Units 5–8 land? | Bump the upstream pin and redeploy; no GHCR pre-build until heavy images make it pay |

## Success Criteria

- `bunx @marcusrbrown/infra gateway deploy` from main produces a
  running gateway whose `/fro-bot ping` slash command responds with
  "pong" in the bound Discord server.
- `bunx @marcusrbrown/infra gateway status` reports all three
  containers running, with gateway and mitmproxy reporting `healthy`
  per their upstream healthchecks.
- The deployed gateway has its slash commands registered against the
  bound `DISCORD_GUILD_ID` (verifiable via Discord API or by typing
  `/fro-bot` in the bound server and seeing autocomplete).
- The gateway container has `NODE_EXTRA_CA_CERTS` pointing at the
  mitmproxy CA, and the CA file exists in the shared volume
  (verifiable via `docker compose exec gateway test -s
  $NODE_EXTRA_CA_CERTS`). This confirms the egress allowlist is
  actually engaged.
- `bunx @marcusrbrown/infra status` includes gateway as a third row
  alongside keeweb and cliproxy, with the same kind of at-a-glance
  health.
- `bunx @marcusrbrown/infra gateway backup --include-ca` writes a
  non-empty PEM file to disk, confirming the trust-anchor recovery
  path works.
- `bunx @marcusrbrown/infra gateway logs gateway --tail 10` returns
  recent gateway logs over SSH.
- Zero secret values appear in tracked files. `git grep` for any of
  the R4 sensitive secret names returns no matches outside doc
  references.
- `apps/gateway/upstream.json` ref bump + redeploy is the entire
  upgrade procedure when a new fro-bot/agent release is wanted.

## Risks

| Risk | Mitigation |
| --- | --- |
| fro-bot/agent's `deploy/compose.yaml` references `context: ..` for the gateway image build, so the entire repo must be cloned to the droplet (not just `deploy/`). Disk footprint grows. | Already factored into R3. Single shallow clone of a tagged release; acceptable. |
| Unit 7 (real workspace image) lands and the workspace build dominates deploy time on a 1 vCPU droplet. | Watch deploy times; flip to GHCR pre-build (deferred per NG5) when it stops being tolerable. Resize triggers defined in R2. |
| Discord bot token leak. | GitHub Environment secret + `chmod 600` on droplet + rotation procedure in `AGENTS.md`. Operator-tier auth (R7) limits blast radius if a guild member tries to invoke privileged commands. |
| Discord guild member abuses operator-only commands. | R7's operator role gate. Until upstream enforces it, only deploy refs that limit registered commands to ping. |
| Droplet loss with mitmproxy CA in named volume only. | Accepted (R9): full stack rebuild regenerates trust chain on first start. `gateway backup --include-ca` exists as a defensive measure. |
| Upstream gateway makes a breaking change to `deploy/compose.yaml` or its environment contract between our pin and the next bump. | Pinned release tag in `upstream.json` insulates us until we choose to bump. Renovate PRs surface the release notes for review. |
| Container logs surface secrets or PII. | Upstream gateway's responsibility (R5). Any observed leak filed upstream; this app surfaces logs unredacted. |
| Secret file lifecycle gaps (stale on rotation, accessible to droplet root). | R4 lifecycle policy: rotation overwrites + restart, decommission destroys droplet. Narrowing to a dedicated `gateway` user is a deferred hardening step. |

## Out of Scope (cross-reference)

This brainstorm explicitly leaves the following to later cycles:

- All fro-bot/agent gateway features beyond v1 (Units 5–8). Consumed as
  they land; not redesigned here.
- Multi-host or HA gateway. Single droplet, single Discord server.
- Anything involving the workspace agent's *behavior* (OpenCode + oMo +
  Systematic plugin tuning, prompt engineering, agent capabilities).
  This is a deployment app, not an agent app.
- Cost monitoring, log aggregation, alerting beyond what `infra
  status` shows.
- Image registry workflow (GHCR pre-build).
- Secret rotation automation.
- Backup of the entire droplet (DO snapshots cover that need without
  app involvement).
