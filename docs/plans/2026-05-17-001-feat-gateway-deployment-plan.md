---
title: Gateway Deployment App (v1)
type: feat
status: completed
date: 2026-05-17
origin: docs/brainstorms/2026-05-17-gateway-deployment-requirements.md
---

# Gateway Deployment App (v1)

## Overview

Add a new `apps/gateway/` package to this infra monorepo that deploys
the Fro-Bot Gateway — a Discord bot Docker Compose stack (gateway,
workspace, mitmproxy) from `fro-bot/agent` at pinned release tag
`v0.44.0` — to a dedicated DigitalOcean droplet, and exposes
`bunx @marcusrbrown/infra gateway ...` commands for status, deploy,
logs, backup, and restore. The app mirrors `apps/cliproxy/` shape with
the differences imposed by the gateway being outbound-only (no public
HTTP surface, no Caddy, no TLS termination) and multi-secret
(Discord token, S3 credentials, optional guild ID, etc.).

## Problem Frame

The Fro-Bot Gateway v1 is operator-runnable but unhosted. Putting it
behind one-command deploys (`gateway deploy`), giving it unified
observability with `keeweb` and `cliproxy` (`infra status`'s third
row), and giving its secrets a durable home outside the upstream repo
are the v1 outcomes. The brainstorm at the origin path settles all
product-level decisions; this plan describes the technical shape and
sequencing.

## Requirements Trace

- **R1 — App scaffolding** (origin R1) — `apps/gateway/` Bun-workspace
  package; `apps/gateway/upstream.json` carries the pinned ref.
  Addressed in Unit 1.
- **R2 — Host** (origin R2) — single dedicated DO droplet at
  `s-1vcpu-2gb` (oversized cliproxy baseline because of the
  multi-service Compose stack), hostname `gateway.fro.bot`, SSH host
  keys pinned in `.github/known_hosts`. Addressed in Unit 2.
- **R3 — Source materialization** (origin R3) — `fro-bot/agent`
  cloned to `/opt/gateway/` on the droplet, compose project root at
  `/opt/gateway/deploy/`. Addressed in Unit 3.
- **R4 — Secret materialization & lifecycle** (origin R4) — deploy
  script writes secret files via SSH from GitHub Environment vars,
  computes `OBJECT_STORE_HOSTS`, defines rotation + decommission
  policy. Addressed in Unit 3.
- **R5 — CLI surface** (origin R5) — five subcommands under
  `bunx @marcusrbrown/infra gateway`: `status`, `deploy`, `logs`,
  `backup`, `restore`. (Origin R5 listed four; `restore` was added
  during planning to make `backup --include-ca` testable end-to-end —
  see Open Questions resolved.) Addressed in Units 4 and 5.
- **R6 — Deploy workflow** (origin R6) — `.github/workflows/
  deploy-gateway.yaml`, modeled on `deploy-cliproxy.yaml`. Addressed
  in Unit 6.
- **R7 — Discord slash commands & authorization** (origin R7) — guild-
  scoped registration via `DISCORD_GUILD_ID`; operator-tier
  authorization deferred to upstream (v0.44.0 has no role-gating
  code), deploy warns when non-ping commands are registered.
  Addressed in Units 3 and 4.
- **R8 — Provisioning** (origin R8) — `apps/gateway/server/
  provision-droplet.ts` mirrors cliproxy's safety: aborts without
  `--force` if droplet exists, pins host keys post-provision.
  Addressed in Unit 2.
- **R9 — mitmproxy CA durability** (origin R9) — accepts fresh CA on
  droplet loss; `gateway backup --include-ca` + `gateway restore
  --include-ca` provide a defensive path. Addressed in Unit 5.
- **R10 — Upstream cadence** (origin R10) — Renovate watches
  `fro-bot/agent` GitHub releases; manual bumps until the Renovate
  rule lands. Addressed in Unit 7.
- **R11 — Documentation** (origin R11) — `apps/gateway/AGENTS.md`,
  root `AGENTS.md`, `README.md`. Addressed in Unit 8.
- **R12 — Testing** (origin R12) — colocated `*.test.ts`; no live
  Discord or S3 tests in CI. Addressed throughout Units 3–6.

## Scope Boundaries

All Non-Goals from the origin doc apply unchanged:

- No public HTTP surface, no Caddy, no TLS termination
- No co-tenancy with cliproxy
- No multi-gateway control plane
- No GHCR pre-build of the workspace image
- No secret rotation automation, log shipping, observability stack
- No Docker Swarm secrets / sops / Vault for v1
- No `gateway setup` interactive wizard for v1
- No `gateway open` command (no UI surface)

### Deferred to Separate Tasks

- **Renovate watch rule for `fro-bot/agent` releases**: Unit 7 ships
  the v1 baseline pin (`v0.44.0`); the actual Renovate `packageRules`
  entry is a follow-up PR once the deployment workflow itself is
  validated against at least one real upgrade. Avoids tangling
  Renovate config debugging with first-deploy debugging.
- **`apps/gateway/server/setup-deploy-user.ts`**: deferred. v1 uses
  root SSH on the droplet (matches cliproxy). Narrowing to a
  dedicated `gateway` user is a hardening follow-up.
- **Operator-tier authorization wiring**: when fro-bot/agent ships
  role-gating in a future Unit, this app adds `DISCORD_OPERATOR_
  ROLE_ID` plumbing. Until then, R7's gate is a warning only.
- **GHCR pre-build**: revisit when Unit 7 lands a real workspace
  image and droplet build time becomes a deploy bottleneck.

## Context & Research

### Relevant Code and Patterns

Mirror the cliproxy app shape throughout:

- `apps/cliproxy/package.json` — workspace package layout
- `apps/cliproxy/server/provision-droplet.ts` — doctl-driven droplet
  provisioning, idempotency guard, post-create host-key pinning
- `apps/cliproxy/src/deploy.ts` — SSH/SCP via `Bun.spawn`,
  preflight checks (`remoteFileExists`, management probe),
  `--force-config` style override flags, `--dry-run` short-circuit
- `apps/cliproxy/docker-compose.yaml` — `restart: unless-stopped`,
  healthcheck patterns, named volumes
- `packages/cli/src/commands/cliproxy/*.ts` — goke command modules,
  Zod schemas, `--key` (env source) discipline, helper extraction
  for testability
- `packages/cli/src/commands/cliproxy/index.ts` — barrel pattern
- `.github/workflows/deploy-cliproxy.yaml` — `dorny/paths-filter`
  with `predicate-quantifier: every` + negation patterns, GitHub
  Environment gate, validate-secrets step, SSH agent + known_hosts,
  post-deploy health probe
- `packages/cli/src/conventions.test.ts` — pre-merge YAML/structural
  enforcement (no `ssh-keyscan` in CI, `predicate-quantifier: every`
  whenever `!` negation, SHA-pinned actions, `.yaml` extension)
- `.github/renovate.json5` — packageRules entries for digest
  versioning and changelog URL enrichment

### Institutional Learnings

From `docs/solutions/workflow-issues/`:

- **`cliproxy-first-deploy-cascade-2026-04-06.md`** — Lockfile
  freshness, single canonical env-var naming, domain-based SSH host
  pinning (not IP-hashed), and explicit storage paths in app config
  are first-deploy gotchas. Apply: commit `bun.lock` after adding
  the new workspace package; use only `GATEWAY_HOST` (not multiple
  aliases); pin both unhashed-domain and hashed-IP host keys in
  `.github/known_hosts`.
- **`bun-deploy-user-permissions-ci-2026-04-02.md`** — CI install
  uses `--frozen-lockfile --ignore-scripts` to skip
  `simple-git-hooks` postinstall. Apply directly in
  `.github/workflows/deploy-gateway.yaml`.
- **`renovate-changesets-monorepo-targeting-2026-04-15.md`** —
  Renovate's `renovate-changesets` action needs `exclude-patterns`
  and `target-package` to keep changesets scoped to
  `packages/cli/`. Apply: `apps/gateway/upstream.json` is excluded
  from changeset generation (deploy infra, not published-package
  behavior); the existing pattern in
  `.github/workflows/renovate-changesets.yaml` already covers this.

### External References

Skipped — strong local pattern in cliproxy + upstream source readable
at `/Users/mrbrown/src/github.com/fro-bot/agent/`. (Origin: brainstorm
review found upstream uses semantic-release with daily SemVer tags;
no doc research needed beyond confirming the release shape.)

## Key Technical Decisions

- **Source materialization via git clone at deploy time, not vendoring.**
  Clone `fro-bot/agent` to `/opt/gateway/` on the droplet; check out
  the pinned ref from `apps/gateway/upstream.json`. The compose
  project root is `/opt/gateway/deploy/` so `./secrets/...` paths
  resolve against the upstream layout. Single source of truth, no
  vendor-drift risk.
- **Secrets written by deploy script via SSH from GitHub Environment.**
  `Bun.spawn` invokes `ssh ... 'cat > /opt/gateway/deploy/secrets/
  <name>'` with `chmod 600` for each secret. Secrets never touch
  CI disk except as the workflow env that fed `process.env`.
- **`OBJECT_STORE_HOSTS` computed by deploy script with explicit-
  override allowed.** Default: `<bucket>.s3.<region>.amazonaws.com`
  (AWS) or `<bucket>.<endpoint-host>` (R2). Operator may override
  via explicit `OBJECT_STORE_HOSTS` GitHub Environment var when the
  endpoint shape doesn't fit either template.
- **`init-certs.sh` invoked on every deploy as a no-op-after-first.**
  Idempotent per upstream design. Avoids gating "is this the first
  deploy" logic in our code.
- **Post-deploy slash-command registration probe gates deploy success.**
  After `docker compose up -d --wait`, poll
  `GET /applications/{app_id}/guilds/{guild_id}/commands` using the
  bot token until the gateway's commands appear (timeout ~30 s).
  Catches startup-without-registration failures that the container
  healthcheck (CA file existence) doesn't surface.
- **Always restart affected services on deploy.** `docker compose
  up -d --wait` already does this for image/config changes;
  `--force-recreate` is added when secret files have been touched
  so containers re-read them.
- **`gateway backup --include-ca` + `gateway restore --include-ca`
  symmetric pair.** Both extract/inject the CA in the
  `mitmproxy-certs` named volume via `docker run --rm` with the
  volume mounted. Restore restarts gateway and mitmproxy services
  so the new CA is reloaded.
- **`backup --include=<a,b,...>` pattern reserved for future state.**
  v1 only supports `ca`; Zod schema rejects other values with a
  clear error listing supported includes.
- **`gateway status` reports workspace as `running (no healthcheck)`
  honestly.** Doesn't fabricate health; reflects what
  `docker compose ps` returns. Upgrades automatically when Unit 7
  adds a workspace healthcheck.
- **R7 operator-tier auth gate is a warning in v1.** Deploy reads
  the list of registered slash commands from upstream source
  (`packages/gateway/src/discord/commands/index.ts` in the cloned
  tree); if commands beyond `ping` are present and
  `DISCORD_OPERATOR_ROLE_ID` is unset, deploy prints a warning. Not
  a hard gate — v0.44.0 has only `ping`, so the warning never fires
  for v1 baseline. The plumbing for `DISCORD_OPERATOR_ROLE_ID` is
  not added in v1; it's a deferred follow-up.

## Open Questions

### Resolved During Planning

- **First-deploy CA bootstrap sequence**: `init-certs.sh` is
  idempotent (upstream confirmed); deploy script invokes it
  unconditionally after the upstream clone/checkout step. No
  first-deploy-detection logic needed.
- **`--force` semantics on `provision-droplet.ts`**: matches
  cliproxy — `--force` permits droplet creation when one already
  exists in DO, but does NOT wipe `/opt/gateway/` state on the
  existing droplet. Operator destroys the droplet manually first
  if a clean rebuild is needed. Same boundary as cliproxy.
- **CA backup restore mechanic**: `gateway restore --include-ca`
  command, symmetric with backup. SCPs PEM to a temp path on the
  droplet, runs `docker run --rm -v mitmproxy-certs:/dst -v
  <tmp>:/src/ca.pem alpine cp /src/ca.pem
  /dst/mitmproxy-ca-cert.pem`, then `docker compose restart
  mitmproxy gateway`. Validates the PEM is non-empty before
  invoking docker.
- **Auth fallback in v0.44.0**: deploy proceeds with warning when
  non-ping commands are registered without operator auth. Warning
  is informational; v1 baseline has only ping, so this is dormant.
  R7 reduces to "deferred to upstream" with a forward-looking
  comment in the deploy script.
- **Slash command registration readiness**: deploy script polls
  Discord API after `docker compose up -d --wait` until commands
  appear (timeout ~30 s, ~10 attempts at 3 s intervals). Fails
  deploy on timeout — intentional hard gate. A deploy that
  didn't register slash commands is a broken deploy (the bot
  is up but operators can't invoke it), and surfacing that
  failure at deploy time is preferable to silently shipping a
  non-working bot and discovering it later via Discord UI. If
  the Discord API is transiently slow, the operator re-runs
  deploy; the cost of retry is low relative to the cost of a
  silent broken release.
- **Secret rotation auto-restart**: deploy always restarts affected
  services. `docker compose up -d --wait` already handles
  image/config changes; deploy adds `--force-recreate` when secret
  files changed (compared against a content-hash recorded in
  `/opt/gateway/deploy/.secrets-checksum`).
- **Renovate deploy gating**: deploys fire on push-to-main only.
  Renovate PRs don't deploy until merged. Same as cliproxy.
- **Workspace state in `gateway status`**: reported honestly as
  `running (no healthcheck)`. Will change to a real health bit
  when Unit 7 adds a workspace healthcheck upstream.
- **SSH/Docker failure states**: each probe in `getStatusSummary`
  returns `{ ok: false, reason }` on failure (droplet unreachable,
  Docker not installed, `docker compose ps` error). Status
  presents per-probe state without short-circuiting.
- **`gateway deploy --local` preconditions**: mirror cliproxy.
  `SSH_AUTH_SOCK` check, env-var validation at start, `--dry-run`
  short-circuit before preconditions.
- **`backup --include` invalid value handling**: Zod enum rejects
  unknown values with an error listing the supported set
  (`ca` in v1).

### Deferred to Implementation

- The exact poll interval/timeout values for the post-deploy
  slash-command probe (~30 s sketch; tune empirically in Unit 6).
- The exact secret file content-hash mechanism for "detect
  rotation" — `sha256sum` against concatenated secret files is
  the obvious shape; choose the exact format during Unit 3.
- The exact droplet image slug from DO that ships Docker
  preinstalled — pick during Unit 2 with `doctl compute image
  list-distribution`. Same posture as cliproxy.

## Output Structure

The plan creates the following new files:

```text
apps/gateway/
├── AGENTS.md
├── package.json
├── upstream.json
├── server/
│   └── provision-droplet.ts
└── src/
    ├── deploy.ts
    └── deploy.test.ts

packages/cli/src/commands/gateway/
├── index.ts
├── status.ts
├── status.test.ts
├── deploy.ts
├── deploy.test.ts
├── logs.ts
├── logs.test.ts
├── backup.ts
├── backup.test.ts
├── restore.ts
└── restore.test.ts

.github/workflows/
└── deploy-gateway.yaml
```

Modified files: root `package.json` (add `apps/gateway` to
workspaces), `bun.lock`, `packages/cli/src/cli.ts` (register
gateway commands), `packages/cli/src/commands/status.ts` (add
gateway row to unified status), `packages/cli/src/__snapshots__/
cli.test.ts.snap` (CLI help), root `AGENTS.md`, root `README.md`,
`.github/known_hosts` (pin gateway droplet keys).

## Implementation Units

- [x] **Unit 1: Workspace scaffolding & upstream pin**

**Goal:** Bring up the `apps/gateway/` package skeleton and pin the
`fro-bot/agent` baseline ref to `v0.44.0`.

**Requirements:** R1, R10.

**Dependencies:** None.

**Files:**
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/upstream.json`
- Create: `apps/gateway/AGENTS.md` (skeleton; filled in Unit 8)
- Modify: `package.json` (add `apps/gateway` to `workspaces`)
- Modify: `bun.lock` (regenerated)

**Approach:**
- `apps/gateway/package.json`: `@marcusrbrown/infra-gateway`,
  `private: true`, scripts `deploy` (invokes
  `bun run src/deploy.ts`), `test` (`bun test`).
- `apps/gateway/upstream.json` initial contents:
  `{ "repo": "fro-bot/agent", "ref": "v0.44.0" }`.
- After adding the workspace member, run `bun install` to update
  `bun.lock`; commit the lockfile change in the same unit.

**Patterns to follow:**
- `apps/cliproxy/package.json` (private workspace member shape)

**Test scenarios:**
- Test expectation: none — pure scaffolding, no behavioral surface.
  Coverage starts in Unit 2.

**Verification:**
- `bun install --frozen-lockfile --ignore-scripts` succeeds.
- `bun --filter @marcusrbrown/infra-gateway run --help` (or
  equivalent workspace-aware command) recognizes the new package.

---

- [x] **Unit 2: Droplet provisioning script**

**Goal:** A TypeScript provisioning script that creates the gateway
DO droplet, pins host keys, and refuses to re-run against an
existing droplet without `--force`.

**Requirements:** R2, R8.

**Dependencies:** Unit 1.

**Files:**
- Create: `apps/gateway/server/provision-droplet.ts`
- Create: `apps/gateway/server/provision-droplet.test.ts`
- Modify: `.github/known_hosts` (after running provision locally
  the first time — documented in `apps/gateway/AGENTS.md`, not
  shipped pre-populated in this unit's PR)

**Approach:**
- Mirror `apps/cliproxy/server/provision-droplet.ts` closely:
  validate `doctl` available + authed, check `DIGITALOCEAN_
  ACCESS_TOKEN`, check `GATEWAY_HOST` env, run
  `doctl compute droplet get` to detect existing droplet, abort if
  found without `--force`.
- Droplet size: `s-1vcpu-2gb` (rationale in plan Key Technical
  Decisions; cliproxy's `s-1vcpu-1gb` is too tight).
- Region: `nyc1` (cliproxy parity).
- Image: pick from `doctl compute image list-distribution` —
  Ubuntu LTS with Docker preinstalled if available. Document the
  exact slug used in the provision output for reproducibility.
- After droplet creation: wait for SSH reachability with
  `StrictHostKeyChecking=accept-new`, then call `pinHostKeys()`
  (mirror cliproxy's helper) to append both unhashed-domain and
  hashed-IP entries to `.github/known_hosts`. Print a reminder to
  commit the file before CI deploy.
- Print the GitHub Environment secrets/variables operator must set
  before first deploy (R4: `GATEWAY_SSH_KEY`, `DISCORD_TOKEN`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `S3_BUCKET`,
  `S3_REGION`, optional `S3_ENDPOINT`, optional
  `OBJECT_STORE_HOSTS`, `GATEWAY_HOST`).
- Unit 3's deploy script handles the empty-file placeholder logic
  for optional secrets when their env vars are unset.

**Execution note:** Test-first for the pure-logic pieces
(droplet-exists check, host-key-pin computation, env validation).
The droplet-create step is mocked at the `Bun.spawn` boundary.

**Patterns to follow:**
- `apps/cliproxy/server/provision-droplet.ts`
- Cliproxy's `pinHostKeys()` and `dropletExists()` functions

**Test scenarios:**
- *Happy path:* No droplet exists → provision creates one → returns
  droplet metadata.
- *Edge case (idempotency):* Droplet already exists, `--force` not
  passed → abort with clear message naming the droplet.
- *Edge case (idempotency with --force):* Droplet exists, `--force`
  passed → script proceeds past the existence check.
- *Error path (missing doctl):* `Bun.which('doctl')` returns null →
  exits non-zero with an install-instructions message.
- *Error path (missing env):* `DIGITALOCEAN_ACCESS_TOKEN` unset →
  exits with a clear "set this env" message.
- *Error path (host-key pinning):* `ssh-keyscan` fails → script
  exits, doesn't continue to print operator setup steps.
- *Edge case (host-key idempotency):* `pinHostKeys()` invoked
  twice → second call detects existing entry, skips append.

**Verification:**
- Dry-run from a clean machine + valid `doctl` auth produces
  expected output without modifying anything outside
  `.github/known_hosts`.
- Re-running aborts with the existence message.

---

- [x] **Unit 3: Deploy script (`apps/gateway/src/deploy.ts`)**

**Goal:** A TypeScript deploy script that runs locally or in CI, SSHs
into the droplet, clones/checks-out the pinned ref, materializes
secrets, runs `init-certs.sh`, brings up the stack, and verifies
slash-command registration.

**Requirements:** R3, R4, R7, R12.

**Dependencies:** Unit 1.

**Files:**
- Create: `apps/gateway/src/deploy.ts`
- Create: `apps/gateway/src/deploy.test.ts`

**Approach:**
- Phases of deploy (each a separately-exported function so it's
  unit-testable):
  1. **Validate env**: required secrets and config vars present;
     fail fast with the missing list.
  2. **Resolve upstream pin**: read `apps/gateway/upstream.json`;
     extract `repo` + `ref`.
  3. **Ensure droplet workspace**: SSH in, ensure
     `/opt/gateway/` exists (`mkdir -p`). If `.git/` exists, run
     `git fetch && git checkout <ref>`; else clone shallow.
  4. **Compute `OBJECT_STORE_HOSTS`**: use explicit env override
     if present; else derive from `S3_BUCKET` + `S3_ENDPOINT`
     (R2 pattern when endpoint set) or `S3_REGION` (AWS pattern).
  5. **Materialize secrets**: write each secret file under
     `/opt/gateway/deploy/secrets/<name>` with `chmod 600`. Stream
     via `ssh ... 'umask 077; cat > /path/<name>'`. Compute and
     persist a content checksum to `/opt/gateway/deploy/.secrets-
     checksum` for the restart-detection step.
  6. **Materialize `.env`**: write `OBJECT_STORE_HOSTS=...` to
     `/opt/gateway/deploy/.env`.
  7. **Run `init-certs.sh`**: invoke remotely (idempotent;
     no-op after first deploy).
  8. **Compose up**: `docker compose --project-directory
     /opt/gateway/deploy up -d --wait --wait-timeout 120`. If the
     secrets-checksum changed from prior deploy, add
     `--force-recreate` so gateway/workspace re-read mounted
     secrets.
  9. **Post-deploy probe**: poll
     `GET https://discord.com/api/v10/applications/
     {DISCORD_APPLICATION_ID}/guilds/{DISCORD_GUILD_ID}/commands`
     with `Authorization: Bot {DISCORD_TOKEN}` until commands
     appear (max ~10 attempts, ~3 s interval). Fail deploy on
     timeout. (Discord rate-limit-friendly: 5 requests, 3 s apart,
     well under public rate limit.)
  10. **Auth-tier warning**: scan command list; if anything beyond
      `ping` is registered and `DISCORD_OPERATOR_ROLE_ID` is not
      set, print a warning (R7 forward-looking gate).
- `--local` (default when not in GitHub Actions) reads env from
  process env (`.env` auto-loaded by Bun); `--remote` triggers
  via `gh workflow run` and is owned by the CLI deploy command
  (Unit 4), not by this script.
- `--dry-run` short-circuits before phase 3 (no remote side
  effects); prints the planned actions.
- `--force-recreate` flag (mirroring cliproxy's `--force-config`)
  forces step 8's `--force-recreate` regardless of the secrets-
  checksum comparison.
- All command invocations use `Bun.spawn` with an explicit env
  allowlist (mirror cliproxy `DeployEnv` shape); never inherit
  arbitrary process env.

**Execution note:** Test-first for the pure helpers (env
validation, `OBJECT_STORE_HOSTS` computation, registration-probe
loop logic). Phases that shell out are tested with
`Bun.spawn`-mocked at the boundary.

**Patterns to follow:**
- `apps/cliproxy/src/deploy.ts` for phase structure, `DeployEnv`
  shape, `--dry-run` and `--force-*` flag handling, and the
  `remoteFileExists()` helper pattern.

**Test scenarios:**
- *Happy path:* All env present, droplet reachable, mocks
  return success → exits 0 with summary.
- *Edge case (first deploy):* `.git/` absent on droplet → clone
  step invoked once; subsequent invocation skips clone.
- *Edge case (ref bump):* `upstream.json` ref changes between
  runs → `git fetch && checkout <new-ref>` invoked; image
  build follows.
- *Edge case (OBJECT_STORE_HOSTS):* `S3_ENDPOINT` set → R2
  pattern; unset → AWS pattern; explicit env override → uses
  override verbatim.
- *Edge case (secrets unchanged):* Checksum matches prior →
  `--force-recreate` NOT added.
- *Edge case (secrets changed):* Checksum differs → `--force-
  recreate` IS added.
- *Error path (missing env):* Required env unset → fails fast,
  lists missing vars, no SSH invoked.
- *Error path (SSH unreachable):* `ssh` exits with connection
  error → deploy fails with the underlying error.
- *Error path (compose up fails):* `docker compose` exits
  non-zero → deploy fails with stderr captured.
- *Error path (registration timeout):* Discord API never returns
  commands → fails after timeout with a clear message naming
  the application/guild IDs (NOT the bot token).
- *Edge case (auth-tier warning):* Non-ping command present
  without `DISCORD_OPERATOR_ROLE_ID` → warning printed; deploy
  still succeeds.
- *Happy path (--dry-run):* `--dry-run` set → script prints
  planned actions, no SSH/spawn invocations occur.

**Verification:**
- `bun test apps/gateway/src/deploy.test.ts` passes.
- A local dry-run shows the expected sequence without side
  effects.

---

- [x] **Unit 4: CLI commands — status, deploy, logs**

**Goal:** Three core CLI commands under
`packages/cli/src/commands/gateway/`.

**Requirements:** R5 (status, deploy, logs).

**Dependencies:** Unit 3 (deploy.ts exists for `deploy --local`).

**Files:**
- Create: `packages/cli/src/commands/gateway/index.ts` (barrel)
- Create: `packages/cli/src/commands/gateway/status.ts`
- Create: `packages/cli/src/commands/gateway/status.test.ts`
- Create: `packages/cli/src/commands/gateway/deploy.ts`
- Create: `packages/cli/src/commands/gateway/deploy.test.ts`
- Create: `packages/cli/src/commands/gateway/logs.ts`
- Create: `packages/cli/src/commands/gateway/logs.test.ts`
- Modify: `packages/cli/src/cli.ts` (register gateway commands)
- Modify: `packages/cli/src/commands/status.ts` (unified status —
  add gateway row via `getGatewayStatusSummary()`)
- Modify: `packages/cli/src/__snapshots__/cli.test.ts.snap` (root
  help + gateway subcommand help; normalize version per the
  established `infra/x.x.x` regex pattern)

**Approach:**
- `status.ts`: SSHes in, runs
  `docker compose --project-directory /opt/gateway/deploy ps
  --format json`, parses to a 3-row report. Each service shows
  `running/exited/...` from `docker compose ps`'s `State` plus
  `healthy/unhealthy/starting/n-a` from `Health`. Workspace
  shows `n-a` for Health in v1; comment in code that this
  upgrades automatically when upstream adds a workspace
  healthcheck. Returns `{ ok, services: [...], error? }` so the
  unified status aggregator can consume it.
- `deploy.ts`: `--remote` (default in CI/dispatch contexts)
  triggers `gh workflow run Deploy Gateway` and tails the run via
  `gh run watch`; `--local` invokes
  `bun run --cwd apps/gateway deploy` and proxies output.
  `--dry-run` is forwarded only in local mode (per cliproxy
  pattern). Validates `gh` available for remote mode.
- `logs.ts`: SSHes in, runs `docker compose --project-directory
  /opt/gateway/deploy logs --no-color --tail=<N> <service>`.
  Defaults to `gateway` service, `--tail 100`. Streams stdout
  through to terminal. Service name validated against the
  3-service set.
  - **CI-detection guard**: if `process.env.CI === 'true'`,
    refuse to stream without `--allow-ci` and print a clear
    message: "Refusing to stream logs in CI without
    --allow-ci. Logs may contain sensitive tokens or user
    data."
  - **Stderr warning** on every run (interactive or CI-allowed):
    "Logs may contain Discord tokens, S3 credentials, or user
    data. Treat output as sensitive; do not capture in shared
    logs or chat."
- Snapshot regen: include the normalized version string per the
  established pattern.

**Execution note:** Test-first for the parse helpers (`docker
compose ps` JSON output → 3-row report) and flag-validation
logic. Subprocess invocations mocked via `Bun.spawn`.

**Patterns to follow:**
- `packages/cli/src/commands/cliproxy/status.ts` (status
  structure, `getCliproxyStatusSummary()` exported for unified
  aggregator)
- `packages/cli/src/commands/cliproxy/deploy.ts` (remote/local
  toggle, `SSH_AUTH_SOCK` check, dry-run short-circuit)
- Cliproxy `logs`-style commands don't yet exist; the simplest
  shape is to mirror `cliproxy/deploy.ts`'s `Bun.spawn` patterns

**Test scenarios:**
- *Happy path (status):* Mocked `docker compose ps` returns all 3
  services running with gateway+mitmproxy healthy and workspace
  n/a → output matches expected snapshot.
- *Edge case (status, container exited):* Mocked output shows
  gateway exited → status shows the exited state and surfaces a
  non-ok flag.
- *Error path (status, SSH unreachable):* `ssh` errors →
  status returns `{ ok: false, reason }` per probe.
- *Happy path (deploy --remote):* `gh workflow run` succeeds →
  command returns 0; URL printed.
- *Happy path (deploy --local):* `bun run` succeeds → command
  returns 0; output streams.
- *Error path (deploy --remote, no gh):* `Bun.which('gh')` null
  → command fails with install instructions.
- *Happy path (deploy --local --dry-run):* Short-circuits before
  preconditions; prints planned actions.
- *Happy path (logs):* Default invocation streams gateway
  logs with stderr warning printed first.
- *Edge case (logs --tail N):* `--tail 25` is forwarded to
  `docker compose logs`.
- *Error path (logs, invalid service):* `logs frobnicator` →
  rejects with valid-services message.
- *Error path (logs in CI without --allow-ci):* Mocked
  `process.env.CI = 'true'`, no flag → refused with clear
  message; no SSH invoked.
- *Happy path (logs in CI with --allow-ci):* Mocked `CI=true`
  + `--allow-ci` → streams normally with stderr warning.

**Verification:**
- `bunx @marcusrbrown/infra gateway status --help` shows the
  expected help text.
- `bun test packages/cli/src/commands/gateway/` passes.
- `bun test packages/cli/src/cli.test.ts` snapshot updates as
  expected.

---

- [x] **Unit 5: CLI commands — backup, restore**

**Goal:** Symmetric `backup` and `restore` commands with
`--include-ca` (or `--include=ca`), establishing the include-list
extensibility pattern for future state types.

**Requirements:** R5 (backup, restore), R9.

**Dependencies:** Unit 4 (barrel registers commands).

**Files:**
- Create: `packages/cli/src/commands/gateway/backup.ts`
- Create: `packages/cli/src/commands/gateway/backup.test.ts`
- Create: `packages/cli/src/commands/gateway/restore.ts`
- Create: `packages/cli/src/commands/gateway/restore.test.ts`
- Modify: `packages/cli/src/commands/gateway/index.ts` (register)
- Modify: `packages/cli/src/__snapshots__/cli.test.ts.snap`

**Approach:**
- `backup.ts`:
  - Args: `--output <file>` (default
    `apps/gateway/.local/mitmproxy-ca.tar`), `--include-ca`
    (boolean flag; defaults to true since v1 has no other
    backup targets).
  - Tars the cert + key pair (`mitmproxy-ca-cert.pem` plus
    `mitmproxy-ca.pem`) out of the `mitmproxy-certs` named
    volume via `docker run --rm -v mitmproxy-certs:/src:ro
    alpine tar -cf - -C /src mitmproxy-ca-cert.pem
    mitmproxy-ca.pem` over SSH; pipe stdout to `--output` path
    locally with `chmod 600`.
  - Writes a stderr warning when output contains sensitive
    material ("Output contains the mitmproxy CA private trust
    anchor; treat as sensitive.").
  - No `--include=<list>` long form in v1 — collapsed per
    YAGNI (see Key Technical Decisions). Reintroduce if a
    second backup target appears.
- `restore.ts`:
  - Args: `--input <file>` (required), `--include-ca` (boolean,
    defaults to true; v1 only supports CA restore).
  - Validates the input archive is non-empty before SSHing.
  - SCPs the tarball to a tmp path on the droplet wrapped in a
    try/finally so the tmp file is removed on both success and
    failure paths. Inside the try block, runs `docker run
    --rm -v mitmproxy-certs:/dst -v <tmp>:/src.tar:ro alpine
    sh -c 'tar -xf /src.tar -C /dst'`. Then runs `docker
    compose --project-directory /opt/gateway/deploy restart
    mitmproxy gateway`. (Restart, not full up — restart is
    sufficient to re-read the CA volume.)
  - Confirms by reading both cert and key from inside the
    gateway container and comparing to the input tarball
    byte-equal.

**Patterns to follow:**
- `packages/cli/src/commands/cliproxy/config.ts` for the
  `--output` flag + file-write error handling pattern; for the
  stderr-warn-on-sensitive-content pattern.
- Cliproxy `keys.ts` for the multi-mutation pattern with
  compensating cleanup if part of the operation fails mid-flight.

**Test scenarios:**
- *Happy path (backup):* SSH + docker run mocked → cert + key
  tarball written to default path with 0600 perms; warning on
  stderr.
- *Happy path (backup --output):* Custom `--output` path used.
- *Edge case (backup default behavior):* No `--include-ca` flag
  → CA backup performed (default true).
- *Happy path (restore):* Mocked input valid → SCP + docker
  copy + restart → confirms cert + key byte-equal.
- *Edge case (restore tmp cleanup on success):* All steps
  succeed → SCP'd tmp file deleted from droplet.
- *Edge case (restore tmp cleanup on failure):* `docker run`
  exits non-zero → SCP'd tmp file still deleted; restore exits
  non-zero with the failure surfaced.
- *Error path (restore empty input):* `--input` points at
  empty file → exits before SSH with a clear error.
- *Error path (restore confirmation mismatch):* Mocked
  container cert/key differ from input → exits non-zero with
  mismatch diagnostic.

**Verification:**
- `bun test packages/cli/src/commands/gateway/{backup,restore}.test.ts`
  passes.
- `--help` output for both commands is clear about flag
  semantics.

---

- [x] **Unit 6: Deploy workflow**

**Goal:** `.github/workflows/deploy-gateway.yaml`, modeled on
`deploy-cliproxy.yaml`.

**Requirements:** R6.

**Dependencies:** Units 1, 3.

**Files:**
- Create: `.github/workflows/deploy-gateway.yaml`

**Approach:**
- Triggers: `push: branches: [main]`, `workflow_dispatch`,
  `workflow_call`.
- `detect-changes` job: `dorny/paths-filter@v4.0.1` with
  `predicate-quantifier: every`, negation patterns for `*.md`,
  `*.test.ts`, fixtures, snapshots. Filter:
  `apps/gateway/**` plus negations. The conventions test
  enforces the quantifier.
- `deploy-gateway` job: depends on `detect-changes`; `if:
  workflow_dispatch || workflow_call || gateway-changed`.
  Environment: `gateway`. `runs-on: ubuntu-latest`.
- Job steps (in order):
  1. `actions/checkout@v6.0.2` (SHA-pinned, version-commented)
  2. `actions/setup-node@v6.3.0` with Node 24 (required because
     `bun run lint` is NOT used in deploy; included for parity
     with cliproxy deploy)
  3. `oven-sh/setup-bun@v2.2.0`
  4. `bun install --frozen-lockfile --ignore-scripts`
  5. **Validate required secrets**: `GATEWAY_SSH_KEY`,
     `DISCORD_TOKEN`, `AWS_ACCESS_KEY_ID`,
     `AWS_SECRET_ACCESS_KEY`, `DISCORD_APPLICATION_ID`,
     `DISCORD_GUILD_ID`, `S3_BUCKET`, `S3_REGION`,
     `GATEWAY_HOST`. (Optional: `S3_ENDPOINT`,
     `OBJECT_STORE_HOSTS`, `DISCORD_OPERATOR_ROLE_ID`.)
  6. Configure SSH known_hosts: `cp .github/known_hosts
     ~/.ssh/known_hosts` (no `ssh-keyscan`).
  7. `webfactory/ssh-agent@v0.10.0` with `GATEWAY_SSH_KEY`.
  8. `bun run --cwd apps/gateway deploy` — env wiring exposes
     all R4 secrets + config to the deploy script process.
  9. Post-deploy probe step (echo-only confirmation; the deploy
     script already gates on registration). Logs the gateway
     IP/host for traceability.
- `permissions: contents: read` at top level.

**Patterns to follow:**
- `.github/workflows/deploy-cliproxy.yaml` for the full shape,
  step order, and SHA-pin/version-comment discipline.

**Test scenarios:**
- Test expectation: convention-test coverage already enforces
  the structural pieces. No new unit tests for the YAML itself.
- Manual: trigger `workflow_dispatch` once after Unit 6 lands,
  observe the run completes and the deploy script's post-deploy
  probe succeeds.

**Verification:**
- `packages/cli/src/conventions.test.ts` continues to pass with
  the new workflow file present (path-filter quantifier,
  SHA-pin comments, `.yaml` extension, no `ssh-keyscan`).
- A manual `workflow_dispatch` succeeds end-to-end against a
  provisioned droplet.

---

- [x] **Unit 7: Pre-merge gates & conventions coverage**

**Goal:** Confirm the new app is covered by existing pre-merge
gates; add coverage where it isn't.

**Requirements:** R12.

**Dependencies:** Units 1, 2, 3, 4, 5, 6.

**Files:**
- Modify (if needed): `packages/cli/src/conventions.test.ts`

**Approach:**
- Audit `conventions.test.ts` against `apps/gateway/`'s files:
  - `package.json`: no `bundledDependencies` (existing test
    catches automatically).
  - Workflow file: `.yaml` extension, `predicate-quantifier:
    every`, SHA-pinned actions with version comments, no
    `ssh-keyscan`, no `secrets: inherit` cross-org. (Existing
    tests catch automatically via globs.)
  - No `.sh` files outside `apps/keeweb/deploy.sh` (existing
    test catches).
- If any pre-existing assertion has a hardcoded app list (e.g.,
  "no `.sh` outside `apps/keeweb/`"), confirm the gateway
  doesn't add one. The current shape doesn't, but verify.
- Run the full test suite (`bun test --recursive`) and confirm
  175 → 181+ tests with no regressions.

**Test scenarios:**
- Test expectation: none beyond the existing conventions test
  re-running cleanly. This unit is an audit, not a new feature.

**Verification:**
- `bun test --recursive` passes; new file counts increase by
  the unit-test additions from prior units.
- `bun run lint` and `bunx tsc --noEmit` clean.

---

- [x] **Unit 8: Documentation**

**Goal:** Operator and contributor documentation reflecting the
shipped surface.

**Requirements:** R11.

**Dependencies:** Units 1–7.

**Files:**
- Modify: `apps/gateway/AGENTS.md` (skeleton from Unit 1 filled
  with deploy flow, CLI commands, provisioning, secret
  lifecycle, restore procedure, anti-patterns)
- Modify: `AGENTS.md` (root) — add gateway row to the
  WHERE-TO-LOOK table; mention `apps/gateway/AGENTS.md`
- Modify: `README.md` (root) — gateway section mirroring the
  cliproxy section (overview, prerequisites, CLI commands,
  workflow)
- Modify: `bunx @marcusrbrown/infra status --json` example
  output in README (now shows 3 rows)

**Approach:**
- `apps/gateway/AGENTS.md` outline (~60–80 lines):
  - **Overview**: 3-service Compose stack, dedicated droplet,
    pinned to `fro-bot/agent v0.44.0`
  - **CLI commands**: 5 commands with one-line summary each
  - **Deploy flow**: source materialization via clone,
    secrets via SSH, init-certs.sh idempotency, registration
    probe gate
  - **One-time provisioning**: doctl creds, secrets to set in
    GitHub Environment, `provision-droplet.ts` run,
    `.github/known_hosts` commit
  - **CA restore procedure**: `gateway backup --include-ca` →
    safe store → `gateway restore --include-ca --input
    <pem>` → byte-equal confirmation
  - **Secret rotation**: edit GitHub Environment value;
    redeploy automatically restarts services with new values
  - **Anti-patterns**: no `ssh-keyscan` in CI, no
    `secrets: inherit` cross-org, no overwriting `config.yaml`
    pattern doesn't apply (no config.yaml here — each secret
    is its own file)
  - **Decommissioning**: destroy droplet via doctl, clean
    `.github/known_hosts` entries
- Root `README.md` gateway section: mirror the existing
  `cliproxy` section structure; document prerequisites
  (Discord bot creation, S3 bucket creation, `doctl` auth),
  link to `apps/gateway/AGENTS.md` for the operator depth.

**Test scenarios:**
- Test expectation: none — documentation. Visual review by
  reading the rendered Markdown.

**Verification:**
- `bun run fix` produces no Markdown lint changes against
  the new docs.
- A reader unfamiliar with the gateway can follow the README
  + AGENTS.md to provision a new droplet and ship a deploy.

## System-Wide Impact

- **Interaction graph:** New deploy workflow shares CI infra with
  cliproxy (SHA-pinned actions, `bfra-me/.github` reusable
  workflow patterns). Conventions test now exercises an
  additional workflow file.
- **Error propagation:** Deploy failures should fail-fast at the
  validate-env step in `apps/gateway/src/deploy.ts`. Post-deploy
  probe failure should surface in the workflow run log clearly
  enough that a maintainer can identify whether the issue is
  registration timing, Discord API rate-limit, or genuine
  registration failure.
- **State lifecycle risks:** Droplet's `/opt/gateway/` is the
  authoritative state location. `apps/gateway/.local/` (gitignored)
  holds backup PEMs locally. Secret file rotation overwrites in
  place — old contents not shredded; documented limitation in R4.
- **API surface parity:** Unified `infra status` aggregates 3
  rows now (keeweb, cliproxy, gateway). The `getStatusSummary`
  contract used by the unified aggregator stays consistent.
- **Integration coverage:** A genuine deploy against a real
  droplet is the only way to validate the full flow end-to-end;
  unit tests cover the boundaries (`Bun.spawn`-mocked) but not
  the cross-tool integration. The first `workflow_dispatch`
  after Unit 6 lands is the integration gate.
- **Unchanged invariants:** keeweb and cliproxy behavior, the
  existing CLI command list, the existing GitHub Environments
  for `keeweb` and `cliproxy`, the conventions test's existing
  assertions — all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| First-deploy cascade (mirror cliproxy class of failures: lockfile, env naming, host keys, missing storage paths). | Apply learnings from `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` directly: commit lockfile change in Unit 1; single `GATEWAY_HOST` env var; pin both unhashed-domain and hashed-IP host keys; explicit `OBJECT_STORE_HOSTS` computation; `init-certs.sh` invoked unconditionally. |
| `init-certs.sh` not idempotent in a future upstream version. | Pin to `v0.44.0`; future Renovate PR is the review boundary — verify init-certs.sh behavior didn't change in the upgrade diff. |
| Slash-command registration probe flakes (Discord API rate-limit, network blip). | Bounded retry (~10 attempts, 3 s interval). Failure fails the deploy explicitly so the operator knows to retry rather than discovering a half-broken bot in Discord. False-fail on a healthy deploy means an operator re-run; cheaper than a silent broken release. |
| Workspace image rebuild on droplet dominates deploy time once Unit 7 upstream lands. | Watch deploy times; flip to GHCR pre-build (deferred — see Scope Boundaries) when it stops being tolerable. Droplet sizing trigger thresholds in R2 (origin doc). |
| Discord bot token leak via logs, ps, or bind-mount fs. | GitHub Environment secret + `chmod 600` on droplet + never echo full secrets in deploy output. Operator-only via SSH boundary; upstream owns log content. |
| Secret rotation leaves stale containers if restart fails. | Deploy fails fast on `docker compose up -d --wait` non-zero exit; doesn't return success on partial rotation. Operator re-runs deploy. |
| Renovate ref bump introduces breaking upstream changes (compose contract, env contract). | Pinned release tag insulates until merge. Renovate PR description carries release notes (via `changelogUrl` to fro-bot/agent's releases). Review the diff before merging. |
| `apps/gateway/server/provision-droplet.ts` accidentally rerun against live droplet. | `--force` guard exactly mirrors cliproxy; aborts with droplet-name-in-error message by default. |
| CA restore command corrupts the named volume. | Restore validates input PEM is non-empty before SSH; confirms byte-equal CA in gateway container after restart; documented restore is a manual operator action, not automated. |
| Auth-tier gap goes unnoticed when upstream eventually ships role-gating. | Deploy script's warning logs the registered command list every deploy; an audit trail exists. When upstream Unit lands operator tier, this app's Unit (future, deferred) wires `DISCORD_OPERATOR_ROLE_ID`. |

## Documentation / Operational Notes

- Operator must create the Discord bot, S3/R2 bucket, and DO API
  token before first deploy. Documented in `apps/gateway/
  AGENTS.md` under "One-time provisioning".
- The `gateway` GitHub Environment is created manually (matches
  cliproxy/keeweb pattern); add it to repo settings before
  setting secrets.
- First-deploy run: provision droplet (Unit 2) → commit
  `.github/known_hosts` change → set all R4 secrets in GitHub
  Environment → trigger `workflow_dispatch` of Deploy Gateway.
- Plan-leakage check: before opening the PR for any unit,
  `grep -rn -E "\bR[0-9]+|Unit [0-9]+|\(v[0-9]+\)"
  apps/gateway/ packages/cli/src/commands/gateway/
  .github/workflows/deploy-gateway.yaml` should return zero
  matches.

## Sources & References

- **Origin document:**
  `docs/brainstorms/2026-05-17-gateway-deployment-requirements.md`
- Cliproxy precedent (the pattern being mirrored):
  - `apps/cliproxy/package.json`
  - `apps/cliproxy/server/provision-droplet.ts`
  - `apps/cliproxy/src/deploy.ts`
  - `apps/cliproxy/docker-compose.yaml`
  - `apps/cliproxy/AGENTS.md`
  - `.github/workflows/deploy-cliproxy.yaml`
  - `packages/cli/src/commands/cliproxy/`
- Upstream gateway source (deployed target):
  - `fro-bot/agent` at tag `v0.44.0`
  - `deploy/compose.yaml`, `deploy/gateway.Dockerfile`,
    `deploy/workspace.Dockerfile`, `deploy/init-certs.sh`,
    `deploy/validate-stack.sh`, `deploy/Caddyfile` (n/a here),
    `deploy/mitmproxy/allowlist.py`
- Institutional learnings:
  - `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`
  - `docs/solutions/workflow-issues/bun-deploy-user-permissions-ci-2026-04-02.md`
  - `docs/solutions/workflow-issues/renovate-changesets-monorepo-targeting-2026-04-15.md`
- Conventions enforcement: `packages/cli/src/conventions.test.ts`
