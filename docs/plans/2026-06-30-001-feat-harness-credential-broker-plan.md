---
title: 'feat: Harness merge-agent credential broker'
type: feat
status: active
date: 2026-06-30
origin: docs/brainstorms/2026-06-30-harness-credential-broker-requirements.md
---

# feat: Harness merge-agent credential broker

## Overview

Build `apps/broker/` — a new isolated DigitalOcean droplet running a Bun HTTP service that exchanges a GitHub Actions OIDC token for a short-lived, run-scoped cliproxy credential, so the durable provider key never lands on the harness runner. The broker verifies the OIDC token against a tight allowlist, mints a real cliproxy api-key via the management API (Pattern A), returns it as an OpenCode `auth.json` payload, and revokes it at run end with a TTL backstop and a sweeper.

## Problem Frame

The `fro-bot/agent` harness release pipeline runs an autonomous, prompt-injectable LLM merge agent on a bare `ubuntu-latest` runner with the durable provider credential written to disk as the same user the agent's `bash` tool runs as. Read and exfiltration of that durable key are both open for the merge duration (see origin: docs/brainstorms/2026-06-30-harness-credential-broker-requirements.md). The fix is to put only a short-lived, revocable, low-value token on the runner and keep the durable key inside a controlled boundary cliproxy already anchors. This addresses durable-key *theft*; it does not by itself stop a prompt-injected agent from *using* a freshly-minted token during its own run (see Success Criteria non-goal and the Pattern A decision).

## Requirements Trace

Carried from the origin requirements doc (R-IDs there → addressed here):

- R1/R2/R14. Durable key never on the runner; runner holds only a short-lived cliproxy-only token; broker holds the durable material — Units 2, 3, 5.
- R3. Broker returns an OpenCode `auth.json` payload the harness consumes directly — Unit 3.
- R4/R5/R6/R7. OIDC-authenticated mint; full token verification (iss/aud/sig/exp); replay rejection; tight allowlist (repo + workflow + ref/environment) on verified claims — Units 1, 3.
- R8. Minted token grants only model access through cliproxy — **see Key Technical Decisions: under Pattern A this is lifetime-bound, not capability-bound** — Units 2, 3.
- R9/R10/R11. Short TTL after which cliproxy rejects; revocable; TTL-mandatory backstop + sweeper for crashed/cancelled runs — Units 2, 3.
- R12/R13. No token material in logs; structured audit events (mint/deny/revoke) with run identity + decision metadata only — Units 3, 4.

## Scope Boundaries

- Egress containment for the integrate job is out of scope (origin defers it). The broker makes a stolen token low-value; network containment is additive defense tracked separately.
- The consuming-side workflow change in `fro-bot/agent` (requesting the OIDC token, calling the broker, injecting the returned `auth.json`) is out of scope — tracked in `fro-bot/agent#1060` and picked up there via a `@fro-bot` mention once this broker ships.
- Replacing the static cliproxy bearer-key model for other consumers is out of scope; this is a new per-run path alongside the existing keys.
- Capability-scoping a minted key (model/rate/content bounds) is out of scope — cliproxy has no per-key capability surface (see Key Technical Decisions).

### Deferred to Separate Tasks

- Pattern B (inline-validating gate where the agent never holds the durable key): the durable upgrade path for true capability bounding. Deferred; documented in Key Technical Decisions so a later iteration can adopt it without rework. Where: future iteration / separate plan.
- A `docs/solutions/` compound doc capturing the first-deploy cascade and any mint/revoke surprise bugs: authored after the first real deploy, per repo convention. Where: follow-up alongside first deploy.

## Context & Research

### Relevant Code and Patterns

- `apps/cliproxy/` — closest peer. `server/provision-droplet.ts` (droplet create, `validateCliproxyDomain`, `writeRemoteEnvFile` SSH-stdin secret materialization, `pinHostKeys`, management-key file write), `src/deploy.ts` (`preflightManagementKeyCheck`, `applyOAuthModelAliasStep` read-back-with-retry, `deploy()`), `config/Caddyfile` (3-line reverse_proxy), `docker-compose.yaml` (Caddy + backend, digest-pinned, Caddy-side healthcheck).
- `packages/shared/cliproxy/management.ts` — `managementHeaders` (`x-management-key`), `requestJson` (fail-closed on non-2xx, malformed-JSON throws), `parseManagementKeyList`. The broker's mint/revoke client extends this.
- `packages/shared/server/droplet-helpers.ts` — `ssh`/`scp` (`IdentitiesOnly=yes`), `materializeIdentityFile`, `waitForSsh`, `getSshFingerprint`, `pinHostKeys` (marker-idempotent), `getDropletIpWithWait`.
- `packages/cli/src/lib/ssh-identity.ts` `buildIdentityArgs` — single-identity SSH (avoids `Too many authentication failures`); ControlPath socket under `/tmp`.
- `apps/vpn/src/host.ts` `validateVpnHost` — the strict host-validator shape (`apps/broker/src/host.ts` mirrors it; reject `-`-prefixed / out-of-alphabet).
- `packages/cli/src/commands/cliproxy/keys.ts` + `index.ts` barrel — the `register<App>Commands` + per-action exported-function CLI pattern. `packages/cli/src/lib/action-ctx.ts` `ActionCtx` for MCP-capturable output.
- `packages/cli/src/commands/mcp.ts` `MCP_ALLOWLIST` + `apps/gateway/src/deploy.ts` `WORKSPACE_PERMISSION_POLICY` — code-owned policy in a reviewed constant, not a secret (the broker's allowlist policy follows this).
- `.github/workflows/deploy.yaml` router + `deploy-vpn.yaml` (simplest per-app deploy template) — paths-filter `predicate-quantifier: every`, per-app `concurrency: deploy-<app>-${{ github.ref_name }}`, explicit `secrets:` (never `inherit`), GitHub Environment gate.
- `packages/cli/src/conventions.test.ts` — `ENFORCED_MANIFEST` (new `(enforced)` rules register here), the MCP sensitive-tool gate (`SENSITIVE_MCP_COMMANDS` absent from `MCP_ALLOWLIST` + denied in `opencode.jsonc`), no-aggregate-concurrency.
- `packages/cli/src/resources/known_hosts` — byte-identical to `.github/known_hosts` (drift-guard test); broker FQDN host keys added to both.

### Institutional Learnings

- `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md` — never upload `config.yaml`; field-scoped management calls only; wrapper-shaped PUTs return 200 and store nothing → **always GET-back and compare**; fail-closed preflight before any mutation.
- `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md` — key name-slugs are NOT identity; never full-array GET-modify-PUT (lost-update wipes keys); a green management API does not prove downstream model reachability (dual-model probe).
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — probe the pinned `eceasy/cli-proxy-api` image's actual mint/delete contract before writing client code; the management API IP-bans after ~5 bad-key attempts (~30 min) → serialize a single auth probe, never parallel/retry bad-key calls.
- `docs/solutions/workflow-issues/{cliproxy,gateway,umami}-first-deploy-cascade-*.md`, `vpn-lightsail-first-provision-cascade-2026-06-10.md` — the first deploy of a new app is a live contract test (budget 5–10 structural fixes): lockfile, env-var naming, host-key pinning (pin by **domain, unhashed**; `ssh-keyscan -H <ip>` only matches IP), ungated-environment auto-create, SSH identity vs ssh-agent, paths-filter brace-expansion under `every`, SSH ControlMaster (UFW `limit ssh` = 6/30s).
- `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md` (Wave 4) — a referenced `environment:` auto-creates **ungated**; pre-create `broker` env with reviewer + main-only policy BEFORE the first deploy workflow runs.
- `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md` — never put the broker under aggregate concurrency; per-app group only, or a gated deploy gets cancelled.
- `docs/solutions/integration-issues/dashboard-operator-session-container-hairpin-2026-06-21.md` — DO droplets don't NAT-loopback; from inside a container reach cliproxy by internal service name, not the public FQDN.
- `docs/solutions/integration-issues/gateway-bash-approval-default-allow-2026-06-28.md` — own security policy in reviewed code, not an opaque secret.

### External References

- GitHub OIDC: issuer `https://token.actions.githubusercontent.com`; JWKS `…/.well-known/jwks` (RS256 only); claims include `iss aud sub exp iat nbf jti repository repository_id repository_owner_id workflow_ref job_workflow_ref ref ref_type ref_protected environment event_name runner_environment repository_visibility`. Token lifetime ~5–15 min. (docs.github.com/en/actions/reference/security/oidc)
- Allowlist guidance: pin `workflow_ref` (or `job_workflow_ref` for reusable) — **never `workflow`** (name is forgeable within the repo); pin `repository_id`+`repository_owner_id` (survive rename); require a broker-minted secret `aud`; reject the `pull_request` `sub` form / pin `event_name`; pin `repository_visibility: private` and `runner_environment: github-hosted`. `jti` exists for replay rejection; GitHub gives no native single-use.
- Verification: `jose` (`createRemoteJWKSet` + `jwtVerify` with `issuer`/`audience`) — Bun-compatible, the one new dependency. JWKS cache ≤10 min with `RefreshUnknownKID` + ≥5-min refresh rate-limit; algorithm allowlist `['RS256']`; 30–60s clock leeway; replay denylist keyed `(jti, iss)` not a raw-token hash (JWT malleability).
- Pattern A vs B and revocation: RFC 8693 token exchange, AWS STS `AssumeRoleWithWebIdentity`, Vault JWT auth, IETF CB4A draft — TTL-mandatory-backstop + reaper + best-effort explicit revoke is the converged pattern; Pattern A's minted key is fungible with the durable key (no native capability bound).

## Key Technical Decisions

- **Pattern A (mint-real-key, revoke-at-run-end), not Pattern B (inline gate).** The broker PUTs a fresh short-lived key into cliproxy's `api-keys`, returns it, and DELETEs it at run end (plus sweeper). Rationale: no inline hop, no broker-on-every-model-call latency/availability coupling, matches the origin's "broker holds durable key + TTL backstop + sweeper" shape. **Consequence for R8:** cliproxy has no per-key capability surface, so a minted key is *fungible with the durable key* for its TTL — the security property delivered is **short-lived + revocable + off-runner**, NOT capability-restricted. The plan states this honestly rather than overclaiming R8; true capability bounding requires Pattern B (deferred).
- **The OIDC `aud` is a cross-context replay defense, not a same-job barrier.** Any step in the integrate job with `id-token: write` can call `getIDToken(<broker aud>)`, so a prompt-injected agent in that job can obtain a token for the broker's audience. Pinning `aud` stops a *different* relying party's token from being replayed at the broker; it does not stop the trusted job itself (or an injected agent within it) from minting. This is consistent with the Pattern A non-goal: the broker authorizes the *job*, and trusts in-job execution only as far as the deferred egress/Pattern-B work later constrains it. The plan does not treat `aud` as secret from the job.
- **Single-writer concurrency against cliproxy `api-keys`.** The broker is the only writer to its minted keys, but GET-modify-write on the shared array is not atomic, so two parallel harness runs could lost-update each other (and other consumers' keys). The broker serializes all management-API mutations through an in-process single-flight lock (mint and revoke take the same lock); no parallel PUT/DELETE against the management API. This holds because there is exactly one broker instance (single droplet, no horizontal scaling); if the broker is ever scaled out, this assumption breaks and needs a distributed lock or a CAS-capable management API. Stated as a hard invariant, with a test.
- **Immediate reconcile on startup before serving `/v1/mint`.** On boot the in-memory live set is empty, so the broker runs the reconcile sweep (list `api-keys`, delete `ghact-`-prefixed keys it cannot account for) *before* accepting mint requests, bounding the stale-key window after a restart to the startup reconcile rather than the next periodic tick. `/healthz` may serve during startup; `/v1/mint` returns 503 until the first reconcile completes.
- **New isolated droplet `apps/broker/`, not co-located in the cliproxy stack.** The broker is the durable-key custodian and a network-reachable high-value target; the origin demands a hardened, isolated boundary with its own rotation/incident path. Mirrors the gateway/umami/dashboard one-droplet-per-app pattern. Cost: a 5th first-deploy cascade + a small droplet.
- **`jose` for OIDC verification.** One new dependency, Bun-compatible, the audited standard; hand-rolling JWKS/JWT verification on a security boundary is rejected.
- **Allowlist policy lives in a reviewed code constant** (`apps/broker/src/policy.ts`), not a secret. Only long-lived material (the broker→cliproxy management key, and the broker's own client-auth material if any) is a secret. The trust policy shows up in diffs, tests, and review.
- **Sweeper state is in-memory `Map<jti|key, {runId, expiresAt}>` + TTL as the mandatory backstop.** A broker restart loses the live set but TTL still expires keys and a reconcile-against-cliproxy sweep (list `api-keys`, delete broker-prefixed keys past TTL) recovers. Durable SQLite is deferred unless the in-memory floor proves insufficient. Minted keys carry a greppable `ghact-<run_id>-` prefix so the sweeper can identify broker-owned keys without trusting slug identity.
- **Mint/revoke are field-scoped, read-back-verified, never full-array PUT.** Per the cliproxy management learnings: GET → append the single key → PUT, then GET-back and assert presence; DELETE by `?value=`; never touch `config.yaml`; a single serialized management auth probe (never parallel/retried bad-key calls — IP-ban risk).

## Open Questions

### Resolved During Planning

- Enforcement pattern (A vs B): **Pattern A** (operator decision).
- Deployment home: **new isolated droplet** (operator decision).
- OIDC library: **`jose`** (research-confirmed standard).
- Sweeper durability: **in-memory + TTL backstop** (research: TTL is the mandatory floor; durable store deferred).
- Which OIDC claims to pin: `iss`, broker-minted `aud`, `repository_id` + `repository_owner_id`, `workflow_ref` (exact file@ref), `ref`/`ref_type`/`ref_protected`, `event_name` (reject `pull_request`), `runner_environment: github-hosted`, `repository_visibility: private`; `exp`/`nbf` time checks; `jti` replay denylist. Exact `fro-bot/agent` numeric IDs + workflow path are filled from that repo at integration time (cross-repo, tracked in #1060).

### Deferred to Implementation

- The exact OpenCode `auth.json` field layout the harness injects — confirmed against the harness action contract during #1060 integration; the broker emits the same shape `apps/cliproxy/AGENTS.md` documents.
- Probe the pinned `eceasy/cli-proxy-api` image's exact mint/delete request/response shapes before finalizing the management client (per the upgrade-playbook learning).
- Exact TTL value (research suggests 15–30 min ≈ run duration + grace; ≤1h ceiling) — tuned against real harness run durations during integration.
- Whether the broker needs its own client-auth on the mint endpoint beyond OIDC (e.g. mTLS / a shared header) — decided during the security-review unit; OIDC + allowlist is the primary control.

## Output Structure

    apps/broker/
    ├── AGENTS.md                       operator runbook
    ├── README.md
    ├── package.json                    adds `jose`
    ├── docker-compose.yaml             Caddy + broker (digest-pinned)
    ├── docker-compose.test.ts          asserts pinned digests
    ├── config/
    │   └── Caddyfile                   handle blocks: /v1/mint, /healthz
    ├── server/
    │   ├── provision-droplet.ts        droplet create, host-key pin, env materialization
    │   └── provision-droplet.test.ts
    └── src/
        ├── server.ts                   Bun.serve: POST /v1/mint, GET /healthz
        ├── server.test.ts
        ├── oidc.ts                     jose verify + claim allowlist
        ├── oidc.test.ts
        ├── policy.ts                   code-owned allowlist constant
        ├── policy.test.ts
        ├── mint.ts                     cliproxy mint/revoke + read-back
        ├── mint.test.ts
        ├── sweeper.ts                  TTL backstop + reconcile sweep
        ├── sweeper.test.ts
        ├── audit.ts                    structured mint/deny/revoke events
        ├── deploy.ts                   deploy script
        ├── deploy.test.ts
        ├── host.ts                     validateBrokerHost
        └── host.test.ts

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
fro-bot/agent integrate job (tracked in #1060, out of scope here)
  │  core.getIDToken(<broker aud>)  → OIDC JWT
  ▼
POST https://broker.fro.bot/v1/mint   (Authorization: Bearer <oidc-jwt>)
  ▼  apps/broker/src/server.ts
oidc.ts:  jose.jwtVerify(jwt, JWKS{token.actions.githubusercontent.com}, {issuer, audience})
          → reject bad sig/iss/aud/exp/nbf/alg
policy.ts: assert claims ∈ allowlist (repository_id, workflow_ref, ref, event_name≠pull_request,
          runner_environment=github-hosted, repository_visibility=private)
          → jti replay check (in-memory denylist, (jti,iss) key)
  ▼ on pass
mint.ts:  GET cliproxy /v0/management/api-keys → append `ghact-<run_id>-<rand>` → PUT
          → GET-back, assert present (bounded retry on mismatch only)
          record {key, runId, jti, expiresAt} in live set
audit.ts: log {ts, src, run_id, jti, repository_id, workflow_ref, decision, reason}  (NO token bytes)
  ▼
return 200 { auth.json payload carrying the minted key }   →  runner

sweeper.ts (setInterval): for each live entry past expiresAt → DELETE ?value=<key>;
          periodic reconcile: list api-keys, DELETE broker-prefixed keys not in live set
run end (success/fail/cancel): best-effort revoke; TTL+sweeper is the backstop
```

## Implementation Units

- [ ] **Unit 1: OIDC verification + allowlist policy**

**Goal:** Verify a GitHub Actions OIDC JWT and decide whether its claims satisfy the trust allowlist.

**Requirements:** R4, R5, R6, R7

**Dependencies:** None

**Files:**
- Create: `apps/broker/src/oidc.ts`, `apps/broker/src/policy.ts`, `apps/broker/package.json`
- Test: `apps/broker/src/oidc.test.ts`, `apps/broker/src/policy.test.ts`

**Approach:**
- `oidc.ts`: `jose.createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'))` with bounded cache + `RefreshUnknownKID` + ≥5-min refresh rate-limit; `jwtVerify(token, JWKS, { issuer, audience, algorithms: ['RS256'], clockTolerance: '30s' })`. Audience is the broker-minted value from policy.
- `policy.ts`: exported `BROKER_TRUST_POLICY` constant — pins `repository_id`, `repository_owner_id`, `workflow_ref`, `ref`/`ref_type`/`ref_protected`, `event_name` allowset (excludes `pull_request`/`pull_request_target`), `runner_environment: github-hosted`, `repository_visibility: private`. A pure `evaluate(claims): {ok} | {deny, reason}` function. Reject the `pull_request` `sub` form explicitly.
- In-memory `(jti, iss)` replay denylist with eviction at `exp + leeway`.

**Execution note:** Implement test-first — this is the security boundary; write failing verification/allowlist tests before the implementation.

**Patterns to follow:** `apps/gateway/src/deploy.ts` `WORKSPACE_PERMISSION_POLICY` (code-owned policy constant + test); `packages/shared/cliproxy/management.ts` (fail-closed, throw on malformed).

**Test scenarios:**
- Happy path: a JWT with valid sig + all allowlisted claims → verify passes, policy `ok`.
- Error path: bad signature / wrong `iss` / wrong `aud` / expired `exp` / `nbf` in future / `alg: none` or `HS256` → reject, mints nothing.
- Edge: `workflow` name matches but `workflow_ref` path differs → deny (the forgeable-name trap).
- Edge: `event_name: pull_request` (or `pull_request` `sub` form) from the allowlisted repo+workflow → deny.
- Edge: `repository` name matches but `repository_id` differs (rename/typosquat) → deny.
- Edge: same `jti` presented twice within `exp` window → second is rejected (replay).
- Edge: claim missing entirely (e.g. no `environment` when required) → deny.

**Verification:** Verification + allowlist behave per scenarios with no network calls in tests (JWKS + tokens are fixtures generated against a test keypair).

---

- [ ] **Unit 2: cliproxy mint/revoke client**

**Goal:** Add a short-lived key to cliproxy and remove it, safely, against the management API.

**Requirements:** R2, R8 (lifetime-bound), R9, R10

**Dependencies:** None (parallel with Unit 1)

**Files:**
- Create: `apps/broker/src/mint.ts`
- Modify: `packages/shared/cliproxy/management.ts` (extend if a shared mint/delete helper is warranted)
- Test: `apps/broker/src/mint.test.ts`

**Approach:**
- `mintKey(runId)`: generate `ghact-<run_id>-<rand>`; GET `/v0/management/api-keys` → append the single key → PUT the full array back; GET-back and assert the key is present (bounded retry **only** on mismatch, never on HTTP error). Return the key string.
- `revokeKey(key)`: DELETE `/v0/management/api-keys?value=<key>`; idempotent (already-gone is success).
- Never upload `config.yaml`; never replace the array wholesale beyond the read-modify-write that preserves existing keys; a single serialized management-auth probe up front (IP-ban avoidance).
- **Single-flight lock:** all management-API mutations (mint + revoke) acquire one in-process lock so no two GET-modify-write cycles interleave against the shared `api-keys` array (the lost-update race). Valid because there is exactly one broker instance; documented as a hard single-instance invariant.
- Auth via `x-management-key` (reuse `managementHeaders`).

**Execution note:** Test-first against mocked `fetch` at the management-API boundary; add a real-image probe task (deferred) before trusting the contract.

**Patterns to follow:** `apps/cliproxy/src/deploy.ts` `applyOAuthModelAliasStep` (GET-back-with-retry), `packages/shared/cliproxy/management.ts` (`requestJson` fail-closed), the never-full-array-PUT learning.

**Test scenarios:**
- Happy path: mint → GET shows existing keys → PUT appends → GET-back confirms → returns key.
- Edge: existing `api-keys` already has N keys → mint preserves all N + adds 1 (no lost-update).
- Error path: PUT returns 200 but GET-back doesn't show the key (silent no-op trap) → bounded retry, then throw.
- Error path: management API 401/403 → throw immediately, no retry (IP-ban avoidance).
- Happy path: revoke deletes the key; revoke of an absent key is a no-op success.
- Edge: mint generates a unique greppable prefix per run.
- Integration (concurrency): two mints invoked concurrently serialize through the single-flight lock — both keys end up present, neither lost-updates the other or existing keys.

**Verification:** Mint/revoke round-trips against a mocked management API with read-back; never issues a full-array-replacing PUT that drops existing keys.

---

- [ ] **Unit 3: HTTP service (mint endpoint + audit)**

**Goal:** Wire OIDC verification + minting behind `POST /v1/mint`, returning an `auth.json` payload, with structured audit and a health endpoint.

**Requirements:** R1, R3, R11, R12, R13

**Dependencies:** Units 1, 2

**Files:**
- Create: `apps/broker/src/server.ts`, `apps/broker/src/audit.ts`
- Test: `apps/broker/src/server.test.ts`

**Approach:**
- `Bun.serve` with `handle`-style routing: `POST /v1/mint` (extract bearer OIDC token → `oidc.verify` → `policy.evaluate` → `mint.mintKey` → record live entry → return `auth.json`), `GET /healthz` (`{status:'ok'}`, no auth).
- On every outcome, `audit.ts` emits a structured event `{ts, src_ip, run_id, jti, repository_id, workflow_ref, decision, reason}` — **never** token bytes, the minted key, the OIDC bearer, or the management key (R12/R13). Authorization-header redaction is enforced at every layer: the Bun handler never logs the raw request, Caddy access logs strip the `Authorization` header, and error paths emit no claim payloads or token fragments.
- **Mint rate-limiting:** per-`repository_id` and global token-bucket limits on `/v1/mint` (sized above realistic max-parallel-CI but bounding abuse/DoS), returning 429 when exceeded. The broker is the durable-key custodian, so an unthrottled mint endpoint is an abuse/DoS surface.
- `/v1/mint` returns 503 until the startup reconcile (Unit 4) has completed; `/healthz` may serve during startup.
- The returned body is the OpenCode `auth.json` payload carrying the minted key (shape per `apps/cliproxy/AGENTS.md`).
- Binds only on the internal docker-network port; Caddy terminates TLS.

**Execution note:** Test-first on the request/response contract and the deny paths.

**Patterns to follow:** `apps/cliproxy/config/Caddyfile` reverse-proxy; the `ActionCtx` no-global-console discipline (audit writes go through an injected logger, not bare `console`).

**Test scenarios:**
- Happy path: valid OIDC bearer → 200 with an `auth.json` body carrying a `ghact-` key; audit logs a `mint` decision.
- Error path: missing/garbage bearer → 401, audit `deny`, nothing minted.
- Error path: valid sig but allowlist deny → 403, audit `deny` with reason; nothing minted.
- Error path: mint client throws (cliproxy unreachable) → 5xx with **no** token/claim bytes in the response body; audit `error`.
- Integration: a denied request never calls `mint.mintKey`; an allowed request records a live entry the sweeper can see.
- Edge: `GET /healthz` → 200 `{status:'ok'}` without auth.
- Security: assert no audit event, access log, or response body contains the OIDC token, the minted key, or the management key (Authorization-header redaction).
- Error path: mint requests over the rate limit → 429, nothing minted, no secret leak.
- Edge: `POST /v1/mint` before startup reconcile completes → 503; succeeds after.
- Adversarial (accepted limitation): a request bearing a *valid* allowlisted OIDC token mints successfully — this is the documented Pattern A non-goal (the broker authorizes the job, not the in-job agent), asserted as expected behavior, not a bug.

**Verification:** End-to-end (mocked cliproxy) mint succeeds and denies correctly; no secret material appears in any log or error body.

---

- [ ] **Unit 4: Sweeper (TTL backstop + reconcile)**

**Goal:** Guarantee minted keys are revoked even when a run crashes or cancels without signalling.

**Requirements:** R11

**Dependencies:** Unit 2 (revoke), Unit 3 (live set)

**Files:**
- Create: `apps/broker/src/sweeper.ts`
- Test: `apps/broker/src/sweeper.test.ts`

**Approach:**
- Periodic tick (e.g. 60s): for each live entry past `expiresAt` → `revokeKey` and drop from the live set.
- **Startup reconcile:** run the reconcile once on boot, before the HTTP service accepts `/v1/mint` (which returns 503 until it completes). This bounds the post-restart stale-key window to the startup reconcile rather than the first periodic tick.
- Periodic reconcile (e.g. 5 min): list cliproxy `api-keys`, DELETE any `ghact-`-prefixed key not in the live set (recovers from broker restart, where the live set is empty but stale keys may remain).
- TTL is the mandatory backstop independent of any run-end callback.

**Execution note:** Test-first on the crashed-run path — the reason this unit exists.

**Patterns to follow:** the TTL-backstop-plus-reaper pattern (research); `mint.ts` revoke.

**Test scenarios:**
- Happy path: an entry past TTL → swept (revoked + removed from live set).
- Edge: an entry within TTL → left alone.
- Integration (crashed run): a minted key whose run never signalled end → swept at TTL.
- Integration (restart recovery): live set empty but cliproxy still lists a `ghact-` key → reconcile deletes it.
- Integration (startup gate): startup reconcile runs before `/v1/mint` serves — a stale `ghact-` key present at boot is gone before the first mint is accepted.
- Edge: reconcile never deletes a non-`ghact-` key (leaves durable + other consumers' keys untouched).

**Verification:** No minted key outlives its TTL by more than one sweep interval; reconcile only ever removes broker-owned (`ghact-`-prefixed) keys.

---

- [ ] **Unit 5: Provisioning + deploy + host validation**

**Goal:** Provision the broker droplet and deploy the stack following the repo's droplet conventions, with secrets materialized over SSH stdin.

**Requirements:** R12, R14 (durable key stays in the broker boundary)

**Dependencies:** Units 1–4 (service exists to deploy)

**Files:**
- Create: `apps/broker/server/provision-droplet.ts`, `apps/broker/src/deploy.ts`, `apps/broker/src/host.ts`, `apps/broker/docker-compose.yaml`, `apps/broker/config/Caddyfile`, `apps/broker/package.json`
- Modify: `.github/known_hosts`, `packages/cli/src/resources/known_hosts` (byte-identical), root `package.json` (`provision:broker` / `deploy:broker`), root `AGENTS.md`
- Test: `apps/broker/server/provision-droplet.test.ts`, `apps/broker/src/deploy.test.ts`, `apps/broker/src/host.test.ts`, `apps/broker/docker-compose.test.ts`

**Approach:**
- `host.ts`: `validateBrokerHost` mirroring `apps/vpn/src/host.ts` (reject `-`-prefixed / out-of-alphabet) — used before any SSH argv.
- `provision-droplet.ts`: create droplet (idempotent, `--force` to recreate), `pinHostKeys` with `marker: '# broker droplet (<ip> / broker.fro.bot)'`, materialize `.env` (broker→cliproxy management key + `BROKER_HOST` + the broker-minted `aud` value) via SSH stdin (never argv), reuse shared helpers. DO Cloud Firewall (if any) is provisioning-time, not deploy-time.
- `deploy.ts`: preflight (durable management key present + cliproxy management reachable + `api-keys` readable) before `compose up`; thread a single SSH `controlPath`; `scp` compose + Caddyfile; materialize secrets; `docker compose pull && up -d --wait`; post-deploy `GET /healthz` probe. Reach cliproxy by internal route where containerized (hairpin learning).
- `docker-compose.yaml`: Caddy + broker, digest-pinned; Caddy-side healthcheck; `docker-compose.test.ts` asserts pinned digests.
- `Caddyfile`: `handle` blocks for `/v1/mint` and `/healthz`; validate with `caddy adapt`.

**Execution note:** Characterization-light — mirror `apps/cliproxy` provisioning/deploy structure; budget the first real deploy as a contract cascade (separate from code review).

**Patterns to follow:** `apps/cliproxy/server/provision-droplet.ts` (`writeRemoteEnvFile` SSH-stdin, management-key file, `pinHostKeys`), `apps/cliproxy/src/deploy.ts` (`preflightManagementKeyCheck`), `apps/vpn/src/host.ts`, `packages/cli/src/lib/ssh-identity.ts` (`buildIdentityArgs`), `docs/solutions/.../cli-bun-build-publish-model-2026-06-20.md` (known_hosts drift-guard).

**Test scenarios:**
- Happy path: `validateBrokerHost` accepts a normal FQDN; rejects `-oProxyCommand=...`, empty, and metachar inputs (sanitized 30-char echo on failure).
- Edge: provision is idempotent — existing droplet without `--force` is not recreated.
- Error path: deploy preflight aborts (no `compose up`) when the management key is missing or cliproxy is unreachable.
- Security: no secret bytes appear in any SSH argv (assert stdin-pipe path; mirror `umami` argv-redaction test).
- Edge: `docker-compose.test.ts` fails on a tag-only (un-digest-pinned) image.
- Edge: `.github/known_hosts` and `packages/cli/src/resources/known_hosts` are byte-identical (drift guard).

**Verification:** Provision is idempotent and pins host keys; deploy fails closed on missing prerequisites; no secret bytes in argv; compose images digest-pinned.

---

- [ ] **Unit 6: CLI command group + MCP gating**

**Goal:** Operator CLI surface for the broker, correctly gated out of MCP where sensitive.

**Requirements:** R13 (audit visibility)

**Dependencies:** Unit 5

**Files:**
- Create: `packages/cli/src/commands/broker/{index.ts,status.ts,deploy.ts,logs.ts,host.ts}` + colocated tests
- Modify: `packages/cli/src/cli.ts` (`registerBrokerCommands`), `packages/cli/src/commands/mcp.ts` (`MCP_ALLOWLIST` + exclusion reasons), `opencode.jsonc` (deny sensitive broker tools), root `AGENTS.md` + status table, `packages/cli/src/commands/status.ts` (unified status), `packages/cli/src/conventions.test.ts` (`SENSITIVE_MCP_COMMANDS`, `ENFORCED_MANIFEST` if a new enforced rule lands)
- Test: `packages/cli/src/commands/broker/*.test.ts`, update `packages/cli/src/commands/mcp.test.ts`

**Approach:**
- `broker status` — read-only (HTTP `/healthz` + droplet reachability), **MCP-safe** (in `MCP_ALLOWLIST`, threads `ctx`).
- `broker deploy` — `gh workflow run` + `--local`, mutating → **CLI-only**, denied in `opencode.jsonc`.
- `broker logs` — streams service logs over SSH (may reveal run identities) → **CLI-only**.
- `broker host.ts` — CLI-side `validateBrokerHost`.
- Add the broker to unified `status`; expose only `broker status` over MCP.

**Patterns to follow:** `packages/cli/src/commands/cliproxy/` group + barrel, `packages/cli/src/commands/mcp.ts` `MCP_ALLOWLIST` + exclusion JSDoc, `packages/cli/src/lib/action-ctx.ts`, the `conventions.test.ts` MCP sensitive-tool gate.

**Test scenarios:**
- Happy path: `broker status` returns health; runs through `ctx` (capturable), no bare `console`.
- Edge: `broker status` is in `MCP_ALLOWLIST`; `broker deploy`/`broker logs` are NOT, and are denied in `opencode.jsonc` (conventions test asserts both layers).
- Edge: unified `status` includes a broker row; graceful-degrades if the broker is unreachable.
- Edge: CLI host validation rejects `-`-prefixed values before SSH.

**Verification:** `bun test packages/cli/src/conventions.test.ts` passes (MCP gate + no-aggregate-concurrency); MCP exposes only `broker status`.

---

- [ ] **Unit 7: Deploy workflow + environment gate**

**Goal:** A gated per-app deploy workflow wired into the router, with the `broker` GitHub Environment pre-created and protected.

**Requirements:** R12, R14 (deploy never exposes the durable key; gated)

**Dependencies:** Unit 5 (deploy script), Unit 6 (no broken CLI surface)

**Files:**
- Create: `.github/workflows/deploy-broker.yaml`
- Modify: `.github/workflows/deploy.yaml` (paths-filter `broker` entry, `detect-changes` output, `deploy-broker` job with explicit `secrets:`)
- Test: any fixtures test asserting paths-filter shape / no-aggregate-concurrency in `conventions.test.ts`

**Approach:**
- Copy `deploy-vpn.yaml` (simplest template): `permissions: contents: read`, `environment: broker`, `concurrency: deploy-broker-${{ github.ref_name }}` (`cancel-in-progress: false`), SHA-pinned actions, `bun install --frozen-lockfile --ignore-scripts`, secret-presence check, `cp .github/known_hosts ~/.ssh/known_hosts`, ssh-agent, `bun run --cwd apps/broker deploy`, post-deploy healthcheck.
- Router: add a `broker` filter (single brace-expansion positive glob + global negations under `predicate-quantifier: every`), a `detect-changes` output, and a `deploy-broker` job forwarding required secrets explicitly (never `inherit`).
- **Operator prerequisite (pre-first-run):** create the `broker` GitHub Environment via `gh api` with Marcus as required reviewer + main-only branch policy, BEFORE merging the workflow (ungated-auto-create learning); add `broker`-scoped secrets after the env is gated.

**Patterns to follow:** `.github/workflows/deploy-vpn.yaml`, `deploy.yaml` router, the umami environment pre-create snippet, the aggregate-concurrency learning.

**Test scenarios:**
- Test expectation: workflow-shape assertions only — paths-filter uses a single brace-expansion glob (not multiple positive globs under `every`); `deploy-broker` carries its own per-app concurrency and is not under any aggregate group; secrets passed explicitly. (No runtime behavior unit beyond conventions tests.)

**Verification:** `conventions.test.ts` passes; deploy router routes `apps/broker/**` changes to `deploy-broker` only; the environment gate holds (verified operationally on first deploy).

---

- [ ] **Unit 8: Operator docs**

**Goal:** Operator runbook + repo doc updates for the new app.

**Requirements:** R12, R13 (operational visibility), overall handoff

**Dependencies:** Units 1–7

**Files:**
- Create: `apps/broker/AGENTS.md`, `apps/broker/README.md`
- Modify: root `AGENTS.md` (new app, `broker` environment secrets, anti-patterns, status table, commands), `ARCHITECTURE.md` + `STRUCTURE.md` (new app row)

**Approach:**
- `apps/broker/AGENTS.md` in the fixed app shape: Overview, Where to look, Deploy flow, Day-2 ops (mint/revoke lifecycle, sweeper, how to read audit, key-rotation recovery path), CLI commands, Required secrets, Anti-patterns (never log token material; never full-array PUT; Pattern-A capability caveat; rotate the management key via a documented recovery path, never in-place), Notes.
- Root `AGENTS.md`: new `broker` rows; `(enforced)` entry + `ENFORCED_MANIFEST` registration only if a new hard rule is introduced.
- Document the cross-repo handoff: update `fro-bot/agent#1060` with a `@fro-bot` mention once the broker ships.

**Patterns to follow:** `apps/cliproxy/AGENTS.md`, `apps/vpn/AGENTS.md`, the `generating-project-docs` skill convention (it owns ARCHITECTURE/STRUCTURE/READMEs).

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Docs follow the per-app AGENTS.md shape; root docs reference the new app; the cross-repo handoff step is recorded.

## System-Wide Impact

- **Interaction graph:** New inbound surface (`broker.fro.bot/v1/mint`) consumed by `fro-bot/agent` (cross-repo, #1060). New outbound: broker → cliproxy management API (mint/revoke) and an end-to-end model probe. No change to existing cliproxy client paths; the broker only *adds and removes* keys.
- **Error propagation:** Mint failures fail closed (no key issued, audit `error`, 5xx with no secret bytes). Management-API auth failures must not retry (IP-ban). Sweeper/reconcile failures are logged and retried next tick; TTL remains the backstop.
- **State lifecycle risks:** In-memory live set is lost on restart → reconcile sweep is the recovery (delete broker-prefixed keys not in the live set). The full-array PUT lost-update is the primary data-integrity risk against cliproxy's shared `api-keys` — mitigated by GET-modify-write + read-back and the `ghact-` prefix.
- **API surface parity:** The broker reuses `packages/shared/cliproxy/management.ts`; any extension there must not change existing cliproxy deploy behavior.
- **Integration coverage:** Cross-layer scenarios unit tests can't prove — real OIDC token verification (recorded fixture against a test JWKS), real management-API mint/delete shape (image probe), real `auth.json` injection on the harness side (#1060). **Acceptance splits in two:** (1) *broker-only* — provision, deploy, `/healthz`, OIDC verify/deny against recorded tokens, mint/revoke against the real management API, sweeper — fully verifiable in this repo; (2) *end-to-end* — the live OIDC-bearing mint from a real harness run and the `auth.json` injection — **blocked on `fro-bot/agent#1060`** and verified there. The broker must not be claimed end-to-end-verified until #1060 lands; shipping the broker on broker-only acceptance is expected.
- **Unchanged invariants:** cliproxy's existing `api-keys`, `config.yaml` preservation, and other consumers' keys are never touched beyond single-key add/remove. The durable provider/OAuth credentials in `cliproxy_auth` are not involved.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Minted key is fungible with the durable key during its TTL (no cliproxy capability bound) | Short TTL (≈run duration), aggressive revoke + sweeper, greppable prefix; honestly scoped as lifetime-bound (R8); Pattern B deferred for true capability bounding |
| Allowlist pins a forgeable claim (`workflow`) → impersonation by a sibling workflow | Pin `workflow_ref` + `repository_id` + broker-minted `aud`; reject `pull_request`; research-confirmed claim set |
| Full-array PUT lost-update wipes other consumers' keys | GET-modify-write single-key append + read-back; never wholesale replace; conventions/learning enforced |
| cliproxy management IP-ban after ~5 bad-key attempts | Single serialized auth probe; never parallel/retried bad-key calls |
| First deploy of a 5th app = live contract cascade | Pre-empt known waves (host-key domain pin, ungated-env pre-create, SSH identity, paths-filter glob, ControlMaster); operator-prerequisites checklist separate from code review |
| Crashed/cancelled run leaves a live key | TTL mandatory backstop + 60s sweeper + reconcile-on-restart |
| Broker is a new high-value target (holds durable key) | Isolated droplet, no public SSH beyond deploy, HTTPS-only, no token bytes in logs, rate-limit mint, code-owned policy |
| Cross-repo dependency on `fro-bot/agent` claim shape | Exact IDs/workflow path filled at integration time (#1060); broker ships allowlist after those are known |

## Documentation / Operational Notes

- Pre-first-deploy operator checklist: create `broker` GitHub Environment (reviewer + main-only) before merge; add `broker`-scoped secrets after gating; pin broker FQDN host keys in both known_hosts files.
- Back up cliproxy's `api-keys` list + `cliproxy_auth` volume before the first broker rollout (a revoke-path bug must not cascade into wiping consumer keys).
- After the first deploy, author a `docs/solutions/` compound doc (cascade waves + any mint/revoke surprises).
- Ship handoff: update `fro-bot/agent#1060` with a `@fro-bot` mention so the consuming-side integration is picked up there.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-30-harness-credential-broker-requirements.md](docs/brainstorms/2026-06-30-harness-credential-broker-requirements.md)
- Related code: `apps/cliproxy/`, `packages/shared/cliproxy/management.ts`, `packages/shared/server/droplet-helpers.ts`, `apps/vpn/src/host.ts`, `packages/cli/src/commands/mcp.ts`, `apps/gateway/src/deploy.ts` (`WORKSPACE_PERMISSION_POLICY`)
- Related issues: this repo #725 (originating request + triage); `fro-bot/agent#1060` (root-cause + consuming-side integration)
- Institutional learnings: `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md`, `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`, `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md`, the four first-deploy-cascade docs, `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md`, `docs/solutions/integration-issues/dashboard-operator-session-container-hairpin-2026-06-21.md`
- External: GitHub OIDC reference (docs.github.com/en/actions/reference/security/oidc), `jose` (JWKS/JWT verify), RFC 8725 (JWT BCP), RFC 8693 (token exchange), IETF CB4A draft, AWS STS AssumeRoleWithWebIdentity, HashiCorp Vault JWT auth
