---
title: "feat: Gateway announce/presence ingress (Caddy + announce secrets)"
type: feat
status: active
date: 2026-06-03
origin: docs/brainstorms/2026-06-03-gateway-announce-presence-ingress-requirements.md
deepened: 2026-06-03
---

# feat: Gateway announce/presence ingress (Caddy + announce secrets)

## Overview

Enable the gateway daemon's opt-in announce/presence webhook (`POST /v1/announce`) by giving the gateway its first public HTTPS surface. Two coupled changes, both gated strictly both-or-neither on the presence inputs: (1) materialize two new announce inputs as secret files the daemon reads, and (2) materialize a `compose.override.yaml` on the droplet that adds a Caddy reverse proxy publishing `:80`/`:443`, terminating TLS for `gateway.fro.bot`, path-scoped to `/v1/announce`, and un-commenting the daemon's announce secret wiring. When the inputs are absent, none of this materializes and the gateway stays outbound-only — preserved automatically by the deploy's existing `git clean -xfd`.

Scope is the gateway-side receiving end only; the signing caller lives in `fro-bot/.github` (separate work).

## Problem Frame

The `fro-bot/agent` v0.52.1 daemon ships an announce feature that turns an HMAC-signed `POST /v1/announce` into a Discord embed posted as the Fro Bot user to a fixed channel — control-plane presence (survey completions, invitation acceptances). It is off today: the two announce inputs are unset, the daemon never starts its HTTP server, and upstream compose leaves the announce env pointers + secret mounts commented out. The gateway also has no public ingress (outbound-only to Discord/S3/cliproxy). The gap is purely receiving infrastructure: a TLS ingress + the deploy wiring to enable the endpoint. See origin: `docs/brainstorms/2026-06-03-gateway-announce-presence-ingress-requirements.md`.

## Requirements Trace

- R1. Caddy reverse proxy as a gateway-side service, publishing `:80`/`:443`, auto-TLS for `gateway.fro.bot`, forwarding to the daemon's announce port over plain HTTP in-stack. (origin R1)
- R2. Introduced via `compose.override.yaml` (auto-merged), without editing upstream `compose.yaml`. (origin R2)
- R3. Materialize the two announce inputs (`GATEWAY_WEBHOOK_SECRET`, `GATEWAY_PRESENCE_CHANNEL_ID`) and wire the daemon to read them via the override. (origin R3)
- R4. Atomic both-or-neither across Caddy + daemon wiring; fail fast if exactly one is set; never publish `:443` to a daemon with no announce server. (origin R4)
- R5. Auth = daemon HMAC + replay + rate-limit; Caddy = TLS; no IP allowlist. (origin R5)
- R6. `GATEWAY_WEBHOOK_SECRET` materialized via SSH stdin (never argv), stored in `gateway` env + `.env`. (origin R6)
- R7. Reachable at `https://gateway.fro.bot/v1/announce`. (origin R7)
- R8. Gated-deploy posture unchanged; rollback = remove both inputs + redeploy, leaving no stale public surface. (origin R8)
- R9. Caddy proxies only `/v1/announce` (+ ACME), 404/405 otherwise. (origin R9)

## Scope Boundaries

- No IP allowlist, WAF, or network gate beyond TLS + daemon HMAC/replay/rate-limit. (origin)
- No new DNS records (verified: `gateway.fro.bot` → `162.243.163.59` on public resolvers). (origin)
- No ufw rule changes — Docker port-publishing bypasses ufw INPUT via DNAT/FORWARD (verified on droplet); exposure comes from Docker publishing. (origin, preflight-resolved)
- No multi-channel routing; single presence channel via `GATEWAY_PRESENCE_CHANNEL_ID`. (origin)
- **Identity ceiling (hard non-goal):** this ingress exposes the announce webhook only; never a general gateway API. New public routes require a new requirements doc. (origin)

### Deferred to Separate Tasks

- The signing caller (the `fro-bot/.github` GitHub Action that builds the HMAC + POSTs): separate work in that repo.
- `GATEWAY_WEBHOOK_SECRET` rotation runbook: documented as an operational note here; the caller-side coordination lives in `fro-bot/.github`.

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/src/deploy.ts`:
  - `buildSecretFileList(env)` (`:445-493`) — returns `SecretFile[] {name, content, required}`; required + optional entries (optional pattern: `S3_ENDPOINT`, `AWS_SESSION_TOKEN`, `gateway-trigger-role-id` push `required:false`, `content: env[KEY] ?? ''`). **Extension point for the two announce secret files.**
  - `writeRemoteFile(...)` (`:725-780`) — `umask 077; cat > '<path>'`, content via SSH stdin only, redacts secret bytes from stderr. **Reuse for the override write.**
  - `computeSecretsChecksum(secrets)` (`:495-505`) — SHA-256 over `name:content\n`, order-sensitive; drives `--force-recreate` when changed.
  - `getMissingWorkspaceEnvVars(env)` — existing both-present-or-absent presence check pattern for `WORKSPACE_OPENCODE_MODEL`/`CONFIG`. **Mirror for the announce both-or-neither gate.**
  - `main()` (`:821-1091`) phases: validate → resolve pin → validate hosts → ensure droplet (`git fetch/reset --hard/clean -xfd` OR clone) → materialize secrets (`mkdir SECRETS_DIR`, write files, checksum) → write `.env` → `init-certs.sh` → `docker compose up -d --build --wait --wait-timeout 120` → poll registration → persist checksum.
  - **No compose file is uploaded today** — deploy relies on the upstream git-cloned `compose.yaml`. The override is a net-new materialization, written after `git clean` (phase 4), before compose up (phase 8).
- `packages/cli/src/commands/gateway/deploy.ts` `getGatewayDeployEnv()` (`:18-60`) — local-mode env passthrough; **add the two announce vars.**
- `apps/cliproxy/config/Caddyfile`, `apps/umami/config/Caddyfile` — the proven pattern: `{$DOMAIN} { reverse_proxy upstream:port }`, Caddy service publishes `80:80`/`443:443` with `caddy_data`/`caddy_config` named volumes.
- `apps/gateway/src/deploy.test.ts` — test patterns: `makeEnv(overrides)`, `makeSpawnMock`, `makeSpawnResult({captureStdin:true})`, lazy `await import('./deploy')`; existing sections for `buildSecretFileList` (`:230-368`), `computeSecretsChecksum` (`:372-400`), `buildGatewayEnvFileContents` (`:2171-2321`), validation-only `main()` (`:2571-2669`).

### Institutional Learnings

- `gateway-v0500-undeployable-upstream-2026-06-02.md`: the daemon's config loader (not compose) is authoritative for required secrets. **Verify the daemon reads `GATEWAY_WEBHOOK_SECRET`/`GATEWAY_PRESENCE_CHANNEL_ID` via env `*_FILE` and that the override supplies exactly that shape.**
- `gateway-deploy-stale-image-2026-05-31.md`: `docker compose up` needs `--build` to rebuild (already present); compose changes need `--force-recreate` to take effect — the checksum already triggers it, but adding the override to the checksum input ensures a Caddy change recreates.
- `cliproxy-first-deploy-cascade-2026-04-06.md`: volume mounts do nothing unless config points at them — Caddy `caddy_data` must be a **named** volume so certs survive `git clean -xfd`.
- `umami-first-deploy-cascade-2026-05-29.md`: rotate/seed credentials before exposing publicly; fail closed on credential/persistent state.
- `gateway-first-deploy-cascade-2026-05-20.md`: `git clean -xfd` recovery is dangerous if it nukes untracked secrets — but here it is the *intended* rollback mechanism for the override (working-tree file, re-materialized only when inputs present).

### External References

- None needed — the Caddy + secret-materialization patterns are well-established locally (cliproxy/umami). Preflights already verified the two keystone assumptions empirically.

## Key Technical Decisions

- **Override + secret files both gated on `announceEnabled = both inputs present & non-empty`.** A single computed boolean drives secret-file inclusion, override materialization, AND a fail-fast on exactly-one-set — one source of truth for the atomic gate (R4).
- **Rollback is automatic via `git clean -xfd`.** The override is a working-tree file; `git clean` (phase 4) wipes it every deploy, and it is only re-written when `announceEnabled`. No explicit delete logic needed for the *file*. (R8)
- **`--remove-orphans` on `docker compose up`.** Because disabling removes the override (so Caddy is no longer a declared service), compose must remove the now-orphaned Caddy container or it lingers publishing `:443`. This is the one piece R8 does NOT get for free from `git clean`. (R8, new from research)
- **Override participates in the secrets checksum.** Add the override contents to `computeSecretsChecksum` input so toggling announce on/off forces `--force-recreate`, guaranteeing Caddy is created/destroyed on the toggling deploy. (R4)
- **Caddy path-scoping** via a named matcher, written so it cannot shadow ACME: define `@announce path /v1/announce`, `reverse_proxy @announce gateway:3000`, and a default `respond 404`. **ACME footgun guard:** a catch-all `handle { respond 404 }` CAN shadow `/.well-known/acme-challenge/*` and break HTTP-01 cert issuance — so the implementer must EITHER (a) rely on TLS-ALPN-01 (Caddy's default on :443, which never touches HTTP paths) and verify the catch-all only affects :443 request routing, OR (b) explicitly exempt `/.well-known/acme-challenge/*` from the 404. Verify cert issuance succeeds on the first enabling deploy before declaring done. (R9)
- **Caddy domain = `GATEWAY_HOST`** (already `gateway.fro.bot`, an existing required env var) — the Caddyfile interpolates the existing gateway host, NOT a new `GATEWAY_ANNOUNCE_DOMAIN` var. No new domain input to materialize; `buildCaddyfile()` takes the host as a parameter sourced from the validated env. (resolves review: domain-not-in-materialization-contract)
- **Caddy joins `gateway-net`** (the external-capable network the daemon is on) so it can both serve public TLS and reach the daemon container by service name. The daemon service name + announce port (`gateway:3000` expected) MUST be asserted against the v0.52.1 compose at implementation time before writing the override — do not assume. (resolves origin deferred Q on network + review)
- **Channel ID flows through the same secret-file path** as the HMAC secret for uniformity (it is not sensitive, but the both-or-neither + materialization machinery is identical). (origin R3)

## Open Questions

### Resolved During Planning

- Override auto-merge under `--project-directory`: **CONFIRMED** via preflight (`docker compose --project-directory <dir> config` merged base+override). (origin keystone)
- Public DNS + inbound :80/:443 for Let's Encrypt: **CONFIRMED** — public resolvers return the droplet IP; Docker publishing bypasses ufw INPUT (DNAT→FORWARD, `DOCKER-USER` empty). (origin keystone)
- Rollback of the override file: **CONFIRMED** automatic via `git clean -xfd` before re-materialization. Container orphan handled by `--remove-orphans`.

### Deferred to Implementation

- Exact override stanza for the announce secret wiring — whether to add `*_FILE` env entries + bind mounts mirroring upstream's commented block, vs env interpolation. Resolve by reading the daemon's `readSecret`/`readOptionalSecret` precedence against the v0.52.1 compose's commented announce block during implementation (the upstream compose shows the exact `_FILE` paths to mirror: `/run/secrets/gateway_webhook_secret`, `/run/secrets/gateway_presence_channel_id`).
- Exact daemon service name on `gateway-net` for the Caddy `reverse_proxy` target — read from the v0.52.1 compose at implementation time (expected `gateway`).
- Caddyfile materialization location — whether the override embeds the Caddyfile inline or mounts a separate generated file. Decide during Unit 2 based on what survives `git clean` cleanly (both are working-tree files; a single override is simpler).

## Implementation Units

- [ ] **Unit 1: Announce secret files + both-or-neither gate**

**Goal:** Materialize `GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` as secret files when both are present; fail fast when exactly one is set; expose a single `announceEnabled` signal for Unit 2.

**Requirements:** R3, R4, R6

**Dependencies:** None

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (`buildSecretFileList`, a new `getAnnounceState(env)`/`announceEnabled` helper mirroring `getMissingWorkspaceEnvVars`, and the `main()` validation point)
- Modify: `packages/cli/src/commands/gateway/deploy.ts` (`getGatewayDeployEnv` passthrough +2 vars)
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**
- Add a helper that returns whether announce is enabled (both present, non-empty), disabled (both absent), or invalid (exactly one) — reuse the empty/whitespace semantics from `validateRequiredEnv`.
- In `main()`, when invalid, throw a clear error naming the missing input *before any spawn* (mirror the existing validation-only fail-fast at `:2571-2669`).
- When enabled, push two secret files (`gateway-webhook-secret` ← `GATEWAY_WEBHOOK_SECRET`, `gateway-presence-channel-id` ← `GATEWAY_PRESENCE_CHANNEL_ID`) into `buildSecretFileList`'s output; when disabled, push neither.
- Add both vars to `getGatewayDeployEnv` for `--local` parity.

**Execution note:** Implement test-first — the both-or-neither gate is a security-relevant branch; write the failing tests for all three states before the helper.

**Patterns to follow:** `getMissingWorkspaceEnvVars` (both-or-absent presence), the optional-secret push pattern in `buildSecretFileList`, the validation-only `main()` tests.

**Test scenarios:**
- Happy path: both inputs set → `buildSecretFileList` includes both announce secret files with correct kebab names + content; checksum differs from the no-announce baseline.
- Edge case: neither input set → neither announce secret file present; output equals current baseline.
- Error path: only `GATEWAY_WEBHOOK_SECRET` set → `main()` rejects before any spawn with a message naming the missing `GATEWAY_PRESENCE_CHANNEL_ID`.
- Error path: only `GATEWAY_PRESENCE_CHANNEL_ID` set → symmetric rejection naming `GATEWAY_WEBHOOK_SECRET`.
- Edge case: one input present but whitespace-only → treated as absent (invalid pair → reject).
- Happy path: `getGatewayDeployEnv` includes both new vars (empty-string default when unset).

**Verification:** All three announce states behave correctly; exactly-one-set fails before any SSH; tests green, tsc + lint clean.

- [ ] **Unit 2: compose.override.yaml + Caddyfile materialization (gated)**

**Goal:** When `announceEnabled`, materialize a `compose.override.yaml` (adding a path-scoped Caddy service publishing :80/:443 on `gateway-net` with named cert volumes, plus the daemon announce `*_FILE` env + secret mounts); when disabled, materialize nothing (so `git clean` leaves the gateway private). Wire `--remove-orphans` so a toggled-off Caddy container is removed.

**Requirements:** R1, R2, R4, R7, R8, R9

**Dependencies:** Unit 1 (`announceEnabled` signal + the two secret files must exist for the mounts to resolve)

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (a `buildComposeOverride()` builder + a `buildCaddyfile()` builder; a new phase between droplet-sync and compose-up that writes them via `writeRemoteFile` when enabled; add override contents to the checksum input; add `--remove-orphans` to the compose-up args)
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**
- `buildComposeOverride()` returns YAML adding: a `caddy` service (`caddy:<pinned>@sha256`, `ports: ['80:80','443:443']`, `volumes: caddy_data/caddy_config + the generated Caddyfile`, `networks: [gateway-net]`, `restart: unless-stopped`, `depends_on: gateway`); top-level named volumes; and the `gateway` service's announce `*_FILE` env entries + the two secret mounts mirroring upstream's commented block (exact `/run/secrets/...` paths read from the v0.52.1 compose at implementation time).
- `buildCaddyfile()` returns the path-scoped config: `{$GATEWAY_ANNOUNCE_DOMAIN} { handle /v1/announce { reverse_proxy gateway:3000 } handle { respond 404 } }` (domain via env interpolation, mirroring cliproxy/umami `{$DOMAIN}`).
- New `main()` phase (after droplet sync, before/with secret materialization, before compose up): if `announceEnabled`, `writeRemoteFile` the override + Caddyfile into `DEPLOY_DIR`; else skip (git clean already removed any prior copy).
- Fold the override + Caddyfile bytes into `computeSecretsChecksum` input so toggling forces `--force-recreate`.
- Add `--remove-orphans` to the `docker compose up` args unconditionally (safe when no orphans; required to retire Caddy on disable). **Disable-path note:** the toggle-off works because the prior (enabled) checksum included the override bytes, so the disabled deploy's checksum differs → `--force-recreate` fires AND `--remove-orphans` removes the now-undeclared Caddy. The recreate+remove-orphans combination is what retires Caddy, not `git clean` alone (which only removes the override *file*). The post-deploy registration poll already proves the gateway booted; no separate Caddy-gone assertion is added in code, but the operator rollback step verifies via `docker compose config`.
- **Failed-enable recovery:** the checksum is persisted only on deploy success (phase 10). If a first enabling deploy writes the override + secret files then `docker compose up` fails (e.g., ACME rate-limit), the next deploy re-materializes the same files idempotently (same content → same checksum) and retries compose up — no stuck state, no manual cleanup. `writeRemoteFile` overwrites, so re-running is safe.
- Pin the Caddy image to the same `caddy:<numbered>-alpine@sha256` digest cliproxy/umami use (consistency; Renovate already tracks it there).

**Technical design:** *(directional — not implementation spec)*

    # compose.override.yaml (materialized only when announceEnabled)
    # Note: docker compose merges top-level `secrets:` and per-service `environment:`
    # as maps (key-merge), so these ADD to the upstream compose's blocks, not replace.
    services:
      gateway:
        environment:
          GATEWAY_WEBHOOK_SECRET_FILE: /run/secrets/gateway_webhook_secret
          GATEWAY_PRESENCE_CHANNEL_ID_FILE: /run/secrets/gateway_presence_channel_id
        secrets: [gateway_webhook_secret, gateway_presence_channel_id]
      caddy:
        image: caddy:<pinned>@sha256:...
        ports: ['80:80','443:443']
        networks: [gateway-net]
        volumes: [caddy_data:/data, caddy_config:/config, ./Caddyfile:/etc/caddy/Caddyfile:ro]
        depends_on: [gateway]
        restart: unless-stopped
    volumes: { caddy_data: , caddy_config: }
    secrets:
      gateway_webhook_secret: { file: ./secrets/gateway-webhook-secret }
      gateway_presence_channel_id: { file: ./secrets/gateway-presence-channel-id }

    # Caddyfile (ACME-safe path scoping)
    {$gateway_host} {
      @announce path /v1/announce
      reverse_proxy @announce gateway:3000
      respond 404
    }

**Patterns to follow:** `apps/cliproxy/config/Caddyfile` + cliproxy/umami compose Caddy service blocks (named volumes, port publishing); `writeRemoteFile` for the materialization; `buildGatewayEnvFileContents` test style.

**Implementation preflight (before writing the override):** read the v0.52.1 upstream `deploy/compose.yaml` on the droplet (or from the pinned tag) and assert the daemon's actual service name, its network name (`gateway-net` expected), and the announce HTTP port (`3000` expected, `GATEWAY_HTTP_PORT` default). Use the asserted values — do not hardcode assumptions. The commented announce block in that compose gives the exact `/run/secrets/...` mount paths to mirror.

**Test scenarios:**
- Happy path: `announceEnabled` → `buildComposeOverride()` includes the Caddy service with `80:80`/`443:443`, named `caddy_data`/`caddy_config` volumes, `gateway-net`, the two secret mounts, and the announce `*_FILE` env entries.
- Happy path: `buildCaddyfile(host)` interpolates the passed `GATEWAY_HOST` (no `GATEWAY_ANNOUNCE_DOMAIN`), uses a named `@announce` matcher, and does not wrap the catch-all in `handle { }` (ACME-safe).
- Happy path: `buildCaddyfile()` scopes to `/v1/announce` → `reverse_proxy gateway:3000` and returns 404 for other paths.
- Edge case: announce disabled → no override/Caddyfile write call is issued (assert `writeRemoteFile` not invoked for those paths).
- Integration: override contents change the computed checksum (toggling announce on flips `--force-recreate`).
- Edge case: compose-up args always include `--remove-orphans` and `--build`.
- Error path: override is never materialized when the pair is invalid (covered by Unit 1's pre-spawn throw — assert no override write on exactly-one-set).

**Verification:** With both inputs, the override + Caddyfile materialize with correct shape; without, nothing materializes; checksum reflects the override; compose up carries `--remove-orphans`. Tests green, tsc + lint clean.

- [ ] **Unit 3: Docs + operator wiring**

**Goal:** Document the announce inputs, the both-or-neither contract, the public-surface security posture, the rotation note, and the operator enable/rollback steps in `apps/gateway/AGENTS.md`; update the env/secret inventory.

**Requirements:** R5, R6, R8 (operational)

**Dependencies:** Units 1-2

**Files:**
- Modify: `apps/gateway/AGENTS.md`
- Modify: root `AGENTS.md` NOTES (the gateway secrets line — add the two announce inputs as opt-in)

**Approach:**
- Document: the two announce inputs (one sensitive HMAC key, one channel ID), opt-in both-or-neither, the public `https://gateway.fro.bot/v1/announce` surface, HMAC+TLS-only posture (no IP allowlist + why), Caddy path-scoping, automatic `git clean` rollback + `--remove-orphans`, and the rotation note (blast radius = Fro-Bot-user impersonation; coordinate the new secret with the `fro-bot/.github` caller).
- Operator prose only — no session/plan taxonomy.

**Test scenarios:** Test expectation: none — documentation only. (Conventions test in `packages/cli/src/conventions.test.ts` already guards taxonomy/format; verify it still passes.)

**Verification:** AGENTS.md accurately describes the opt-in contract + security posture; conventions test green; no taxonomy leakage.

## System-Wide Impact

- **Interaction graph:** New Caddy service on `gateway-net`; the daemon's announce HTTP server (already built) starts when the secrets are present. mitmproxy/workspace egress paths are unaffected (announce is inbound, separate from the outbound egress model).
- **Error propagation:** Invalid pair → fail fast in `main()` before any droplet mutation. Caddy ACME failure → Caddy unhealthy, but the daemon + core gateway stay up (announce is additive; `depends_on: gateway` not the reverse).
- **State lifecycle risks:** Caddy cert material lives in a **named Docker volume** (`caddy_data`). Correct mental model: Docker volumes are independent of the git working tree — `git clean -xfd` (a working-tree operation) never touches them, so certs survive every deploy regardless. The real cert-loss risk is an explicit `docker compose down -v` or `docker volume prune` on the gateway project (NOT part of any deploy path here) — that would wipe certs and force re-issuance (Let's Encrypt rate-limit risk). Operator guardrail: never run `down -v`/`volume prune` on the gateway stack. Toggling announce off must retire the Caddy container via `--force-recreate` (checksum flip) + `--remove-orphans`, or it lingers on :443.
- **API surface parity:** None — this is the gateway's only public route, deliberately path-scoped; no other interface gains it.
- **Integration coverage:** The override-auto-merge + ACME-reachability were verified by preflight (not unit-testable in CI); the both-or-neither gate + override shape + checksum coupling are unit-tested.
- **Unchanged invariants:** The gateway's outbound-only egress model, the existing 13 required env vars, the workspace/mitmproxy stack, and the upstream `compose.yaml` (never edited) are all unchanged. With announce inputs unset, the deployed stack is byte-for-byte the current private gateway.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Disabling leaves an orphaned Caddy container on :443 | Disabled deploy's checksum differs from the enabled one (override bytes gone) → `--force-recreate` + `--remove-orphans` retires Caddy; operator verifies via `docker compose config` post-rollback |
| Caddy re-requests certs every deploy → Let's Encrypt rate limit | Named `caddy_data` Docker volume — independent of the git working tree, survives `git clean -xfd` and every deploy; only lost via explicit `docker compose down -v`/`volume prune` (operator guardrail: never run those on the gateway stack) |
| ACME HTTP-01 challenge shadowed by the catch-all 404 → cert issuance bricked | Caddyfile uses a named `@announce path` matcher + default `respond 404` (not `handle { 404 }`); rely on TLS-ALPN-01 on :443 or explicitly exempt `/.well-known/acme-challenge/*`; verify cert issuance on first enabling deploy |
| First enabling deploy fails after writing override/secrets (e.g. ACME rate-limit) | Checksum persisted only on success; next deploy re-materializes idempotently (same content) and retries — no stuck state |
| Override secret-mount paths don't match the daemon's `_FILE` contract | Read the exact `/run/secrets/...` paths from the v0.52.1 commented compose block at implementation time; learnings doc #2 (loader is authoritative) |
| Override not picked up by compose | Preflight-CONFIRMED `--project-directory` auto-merges `compose.override.yaml` |
| Public endpoint abuse | Daemon HMAC + replay + rate-limit (existing); Caddy path-scoped to `/v1/announce` only (R9); TLS via Caddy |
| HMAC secret leak → Fro-Bot impersonation | SSH-stdin materialization (never argv); rotation note in AGENTS.md; gated-deploy approval |

## Documentation / Operational Notes

- Operator enable: set `GATEWAY_WEBHOOK_SECRET` (strong random) + `GATEWAY_PRESENCE_CHANNEL_ID` in the `gateway` GitHub Environment + `.env`, then trigger the gated deploy.
- Operator rollback: remove both from the `gateway` environment, redeploy — `git clean` removes the override, `--remove-orphans` retires Caddy, gateway returns to private. Verify with `docker compose config` showing no Caddy service.
- Post-enable verification: a signed test POST to `https://gateway.fro.bot/v1/announce` posts an embed; an unsigned/replayed one is rejected; a non-`/v1/announce` path returns 404.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-03-gateway-announce-presence-ingress-requirements.md`
- Related code: `apps/gateway/src/deploy.ts` (`buildSecretFileList`, `writeRemoteFile`, `computeSecretsChecksum`, `getMissingWorkspaceEnvVars`, `main`), `packages/cli/src/commands/gateway/deploy.ts` (`getGatewayDeployEnv`), `apps/cliproxy/config/Caddyfile`, `apps/umami/config/Caddyfile`
- Related learnings: `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md`, `gateway-deploy-stale-image-2026-05-31.md`, `cliproxy-first-deploy-cascade-2026-04-06.md`, `umami-first-deploy-cascade-2026-05-29.md`
- Upstream: `fro-bot/agent` v0.52.1 announce feature (`packages/gateway/src/http/announce-handler.ts`, `discord/presence.ts`, config `:368-400`)
