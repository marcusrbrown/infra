---
title: "feat: Broker mints scoped GitHub App installation token for fro-bot/agent harness-integrate"
type: feat
status: superseded
date: 2026-07-04
origin: marcusrbrown/infra#771 (requirements) + Fro Bot triage comment; cross-repo design fro-bot/agent#1123
---

> **SUPERSEDED — not shipping.** Document-review + an independent Oracle pass established that broker-side App-key custody (this plan, "Design A") is unnecessary. The lighter alternative — mint the scoped `contents:write` token in a **trusted inline `run:` step** inside `harness-integrate.yaml`'s single job, key mapped only to that step's env, only the scoped token passed to the injectable merge step ("Design B-prime") — keeps the App private key out of the injectable step's reach without a broker change, a breaking `/v1/mint` envelope, or making the broker a higher-value target. The key finding that killed the naive job-split (and thus validated B-prime specifically): `actions/create-github-app-token` declares a `post:` hook that re-reads `INPUT_PRIVATE-KEY` at cleanup, and a prompt-injected same-job step can tamper the on-disk post script (SHA-pin doesn't cover post-download filesystem integrity) to exfiltrate the key — so B-prime must use a **no-post** inline mint, not that action. Implementation moved to `fro-bot/agent` (see infra#771 resolution + the linked fro-bot/agent issue). This document is retained as the decision record and for the verified post-action-tamper finding.

# feat: Broker mints scoped GitHub App installation token for fro-bot/agent harness-integrate

## Overview

Extend the broker's existing OIDC-gated `POST /v1/mint` so that — on the same allowlisted OIDC exchange that already mints the cliproxy model credential — it also mints a short-lived, single-repo, `contents: write`-only **GitHub App installation token** for `fro-bot/agent`, and returns both in one response envelope. This lets the `fro-bot/agent` harness-integrate path stop handing a durable broad classic PAT (`FRO_BOT_PAT`) to its prompt-injectable merge agent: the durable App private key lives only in the broker (as the durable cliproxy key already does), and CI only ever holds a ~1h scoped token.

This is the broker (infra) half of the deeper token-capability hardening tracked in `fro-bot/agent#1107`. It ships **first**; the consuming half (mint-script + workflow wiring) is tracked at `fro-bot/agent#1124` and is out of scope here.

## Problem Frame

The integrate merge agent runs untrusted-influenced code (it merges upstream OpenCode refs) and needs a `contents: write` token to `git push` the integration result to `refs/harness-integrate/<version>` on `fro-bot/agent`. Minting that token *inside* the workflow would require putting the fro-bot App private key into the prompt-injectable job — and that key mints the App's full installation scope. Keeping the key in the broker (the same trust boundary the broker already establishes for the model credential) means CI holds only a scoped, ~1h token. The OIDC allowlist that already gates the model-credential mint is the same gate that authorizes this new mint — the integrate identity is already pinned in `apps/broker/src/policy.ts` (verified this session), so **no allowlist change is needed**.

**What this does and does NOT achieve (honest bound).** This plan shrinks the *durability and scope* of the GitHub credential on the runner: a broad durable PAT becomes a single-repo, `contents:write`-only, ~1h token, and the App private key never touches CI. It does **not** stop *in-run abuse*: a prompt-injected agent inside the live integrate job can still use the minted token (and the minted model credential) for the job's duration — push to `fro-bot/agent`, or spend the model key — because the token is legitimately present in the job. Closing the in-run window is the egress-containment half, deferred to `marcusrbrown/infra#751`. The two are complementary; neither alone is sufficient.

## Requirements Trace

- R1. On a valid, allowlisted OIDC exchange from the integrate workflow, the broker mints a GitHub App installation token scoped to a single repo (`fro-bot/agent`) with only `contents: write`. (origin: #771 "The change")
- R2. The App-token mint applies the **same** `evaluateClaims` allowlist gate as the model-credential mint, before minting; any non-allowlisted caller fails closed 403. (origin: #771 Requirements)
- R3. The broker holds the fro-bot App `app-id` + private key as broker-side secrets; they are never exposed as CI secrets on the integrate path. (origin: #771 Requirements / Inputs)
- R4. Any failure to mint the App token → non-2xx → the whole `/v1/mint` fails closed with no durable fallback, exactly as the model-credential mint does. (origin: #771 Requirements)
- R5. Token scope is `contents: write` only — verified sufficient in-repo (checkout ⊂ write + push to `refs/harness-integrate/*` + no posting). (origin: #771)
- R6. The broker resolves the installation id at mint time from the App JWT (not a stored config value). (decision, this session)
- R7. The `/v1/mint` response becomes an explicit envelope `{ auth_json, github_token }`; each field is extracted by the consumer. (decision, this session)
- R8. The **intermediate secrets** — App private key, App JWT, and the caller's OIDC bearer — never appear in any response body, log line, or audit event. The two **deliverables** (the cliproxy key inside `auth_json`, and the installation token inside `github_token`) appear ONLY in the `/v1/mint` response body to the authenticated caller — never in logs or audit events. (origin: Fro Bot triage step 5)

## Scope Boundaries

- Does **not** change `BROKER_TRUST_POLICY` / the allowlist — the integrate identity is already pinned. The plan confirms the App-token path is gated identically; it adds no new allowlist entry.
- Does **not** touch the consuming `fro-bot/agent` workflow or mint script — that is the response-envelope consumer change.
- Does **not** broaden the token beyond `contents: write` on the single `fro-bot/agent` repo.
- Does **not** add per-token TTL sweeping/reconcile for the App token (see Key Technical Decisions — the App token is GitHub-TTL-bound, fire-and-forget).

### Deferred to Separate Tasks

- Consuming-side integration (parse the envelope, write `auth_json` to `$OPENCODE_AUTH_JSON`, use `github_token` for the push, drop `FRO_BOT_PAT` from the injectable step): `fro-bot/agent#1124`.
- The network-egress-guard half of the isolation story (harden-runner): `marcusrbrown/infra#751`.
- End-to-end verification against a live integrate dispatch: blocked on `fro-bot/agent#1124`; the broker is verifiable in isolation here.

## Context & Research

### Relevant Code and Patterns

- `apps/broker/src/server.ts` — `handleMint` / `createServer`. Order today: `isReady` → `extractBearer` → `verifyOidcToken` → `rateLimiter.check` → `evaluateClaims` → compute `expiresAt` once → `mintKey` → `recordMint` → `auditMint` → `jsonResponse(200, buildAuthJson(mintedKey))`. The App-token mint slots in **after `evaluateClaims`** (same gate) and the response builder becomes an envelope.
- `apps/broker/src/mint.ts` — the client to mirror: injected `FetchFn` (`type FetchFn = (url, init?) => Promise<Response>` — avoids Bun's `preconnect`), `AbortSignal.timeout(10_000)`, `if (!res.ok) throw` with **no retry** and **no secret bytes in error messages**, single-flight `withLock`. The GitHub-App client mirrors the dep-injection + no-retry + no-leak shape (but needs **no** single-flight lock — GitHub mints are independent POSTs, not a shared-array read-modify-write).
- `apps/broker/src/oidc.ts` — jose v6 usage (`createRemoteJWKSet`, `jwtVerify`, `CryptoKey`), `algorithms: ['RS256']` hard-pin. There is **no existing JWT-signing** primitive; the new client introduces signing.
- `apps/dashboard/src/deploy.ts` — `writeRemoteFile` (`umask 077; cat > <path>` over SSH stdin, then `chmod 0600`), `buildEnvFileContents` (writes `*_KEY_FILE=/run/secrets/github-app.pem` — path only, never the PEM), and PEM trailing-newline normalization. This is the canonical multi-line-PEM materialization pattern to mirror. Broker container runs `oven/bun` as root → no `chown 1000:1000` needed.
- `apps/broker/src/deploy.ts` `writeRemoteEnvFile` + `apps/broker/server/provision-droplet.ts` `writeRemoteEnvFile` — **both** hardcode the `.env` key list with a full `cat > .env` overwrite. Adding a var to one but not the other silently drops it.
- `apps/broker/src/audit.ts` — `AuditEvent` discriminated union, `defaultAuditLogger`, `redactSensitiveFields` (field-name net), no-secret-bytes invariant + tests in `audit.test.ts`.
- `apps/broker/src/main.ts` — boot env reads with fail-closed `process.exit(1)` on missing required config; `mintDeps` / `serverDeps` injection point.

### Institutional Learnings

- `docs/solutions/integration-issues/broker-credential-lifecycle-restart-races-2026-07-02.md` — the model credential is restart-safe because its **key name carries its expiry** and reconcile is time-based. The App token needs no equivalent: it is GitHub-server-side state with a fixed TTL, not broker-tracked. Deploy still must `--force-recreate` so the new bundle actually runs (bind-mounted `dist/main.js`).
- `docs/solutions/workflow-issues/broker-first-deploy-cascade-2026-06-30.md` — bundle is shipped by *deploy*, not provision; `--force-recreate`; the full-overwrite `.env` trap.
- `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` — `normalizePemPrivateKey`: accept real newlines *and* literal `\n`, always write one trailing newline (GitHub Actions strips trailing whitespace from single-line secrets).
- `ARCHITECTURE.md` — "only `packages/cli/src/` user-facing changes warrant a changeset"; this is an `apps/broker/**` change → **no changeset**.
- GitHub reserves the `GITHUB_` prefix for Actions secret/env names → the broker's GitHub Environment secrets must be `BROKER_GH_APP_*`, not `BROKER_GITHUB_APP_*`.

### External References

- GitHub App auth (verified against docs.github.com, 2026): App JWT is RS256, `iat` backdated 60s, `exp` ≤10 min, `iss` = App client_id or app-id (both accepted). GitHub downloads **PKCS#1** PEMs; `jose.importPKCS8` rejects PKCS#1 → use `node:crypto.createPrivateKey(pem)` → `KeyObject`, which jose v6 `SignJWT.sign()` accepts natively (no conversion). Resolve installation: `GET /repos/{owner}/{repo}/installation` (App-JWT auth) → `.id`. Mint: `POST /app/installations/{id}/access_tokens` (App-JWT auth) body `{ repository_ids: [1126485011], permissions: { contents: "write" } }` → `{ token, expires_at, permissions, repositories }` (echoes scope — verify before returning). TTL fixed at 1h, not configurable. Early revoke: `DELETE /installation/token` (204; 404 idempotent). Treat `token` as opaque (April 2026 `ghs_APPID_JWT` format change). Every non-2xx → fail closed, no retry (401 may re-sign once).

## Key Technical Decisions

- **Response envelope `{ auth_json, github_token }`** (R7): self-describing; the consumer writes `auth_json` to disk and uses `github_token.token` for the push. This is a breaking change to the `/v1/mint` contract — today the whole body IS the auth.json — so it must land with the `fro-bot/agent#1124` consumer change. Broker ships first but the envelope shape is the agreed contract (`github_token: { token, expires_at }`).
- **Resolve installation id at mint time** (R6) via `GET /repos/fro-bot/agent/installation` with a short in-process cache (≤5 min, consistent with the JWKS cache) — "not a stored config value" means no deploy-configured id, an in-memory cache is fine. Owner/repo come from the already-verified `repository` claim.
- **PKCS#1 handling via `node:crypto.createPrivateKey` → `KeyObject`** (not `importPKCS8`), pinned `alg: 'RS256'`. Cache the signed App JWT in-process for its ≤10-min validity; reuse it across the resolve + mint calls in one cycle.
- **Scope via immutable `repository_ids: [1126485011]`** (not the mutable `repositories: ["agent"]` name), matching the `repository_id` the policy already pins. Verify the response echoes `permissions.contents === "write"` and the repo before returning — fail closed otherwise.
- **No single-flight lock and no sweeper for the App token.** GitHub mints are independent POSTs with no lost-update hazard, and the token is GitHub-server-side state with a fixed 1h TTL that the broker cannot reconcile (no list-and-revoke against a broker-owned array, and no run-end signal reaches the broker). The 1h TTL is the leaked-token ceiling; this is an honest limitation, weaker than the model credential's 30-min sweeper-backed lifetime. Early `DELETE /installation/token` is deferred (needs a run-end callback the broker doesn't have).
- **App private key as a file mount, not an env var** (R3): `.env` carries `BROKER_GH_APP_ID` + `GH_APP_KEY_FILE=/run/secrets/github-app.pem`; the PEM is bind-mounted 0600, materialized via SSH stdin only (never argv). Avoids `docker inspect` / `/proc/<pid>/environ` plaintext exposure.
- **Fail-closed everywhere** (R4): missing App config at boot → `process.exit(1)`; any GitHub non-2xx during mint → 5xx/403 to the caller with no fallback token, mirroring the model-credential path.
- **Mint the App token FIRST, before the cliproxy key** (avoids orphaning): the App-token mint creates zero broker-side state (no live-set entry, no lock). Ordering it before the stateful cliproxy mint means a failed App mint returns 5xx having touched nothing. If the *cliproxy* mint then fails, the already-issued App token is left to its GitHub TTL — the same fire-and-forget backstop already accepted for it (and it is scoped `contents:write`/1h). `recordMint` (live-set) happens only after BOTH mints succeed, so a partial failure never records a cliproxy key the caller never received.
- **No-store on `/v1/mint` responses**: set `Cache-Control: no-store` so the envelope carrying the live `github_token` is not cached by any intermediary.

## Open Questions

### Resolved During Planning

- Which App holds `contents: write` on `fro-bot/agent`? **Verified**: `fro-bot/agent`'s `harness-release.yaml` mints a token from `secrets.APPLICATION_ID` / `APPLICATION_PRIVATE_KEY` and uses it for checkout + version-bump push — so that App's installation grants `contents: write`. That app-id + private key is what the broker holds. (This corrects a research note that referenced a different, cloning-only App.)
- Does the App grant depend on the *caller* being harness-release vs harness-integrate? **No** — the broker mints from **its own** held app-id + private key against the App's installation on `fro-bot/agent`; the grant is a property of the App's installation, not of which workflow triggered the OIDC exchange. harness-release only serves as *evidence* the installation grants `contents:write`; the integrate caller's own secrets (`FRO_BOT_PAT` etc.) are irrelevant to what the broker can mint. The mint response's `permissions`/`repositories` echo is asserted before returning, so a wrong/insufficient installation fails closed regardless.
- Envelope vs sibling field for the response? **Envelope** `{ auth_json, github_token }` (this session).
- Installation id: stored vs resolved? **Resolved at mint time** (this session).

### Deferred to Implementation

- The exact `iss` value (App client_id vs numeric app-id): both are accepted by GitHub; pin to whichever the broker's stored credential was created with and document it in a code comment. Resolve when the real credential is in hand.
- Whether to add an `X-GitHub-Api-Version` pin of `2026-03-10` vs `2022-11-28`: both accepted; pin the newer at implementation.

## Output Structure

    apps/broker/src/
    ├── github-app.ts          # NEW — App JWT sign + installation resolve + token mint client
    ├── github-app.test.ts     # NEW — colocated tests (fetch/clock injected, no-leak, fail-closed)
    ├── server.ts              # MODIFIED — App-token mint after evaluateClaims; envelope response
    ├── main.ts                # MODIFIED — read GH_APP_ID + key file at boot; wire appTokenDeps
    ├── audit.ts               # MODIFIED — App-token audit fields/decision, no-leak
    └── deploy.ts              # MODIFIED — shared .env list; writeRemoteFile PEM upload; preflight
    apps/broker/server/
    └── provision-droplet.ts   # MODIFIED — same shared .env list (avoid drop-var trap)
    apps/broker/
    ├── docker-compose.yaml    # MODIFIED — bind-mount PEM as /run/secrets/github-app.pem:ro
    └── AGENTS.md              # MODIFIED — deploy flow, required secrets, anti-patterns
    .github/workflows/
    └── deploy-broker.yaml     # MODIFIED — validate + pass BROKER_GH_APP_ID/KEY

## Implementation Units

- [ ] **Unit 1: GitHub App installation-token client**

**Goal:** A standalone, dependency-injected client that signs an App JWT, resolves the `fro-bot/agent` installation, and mints a `contents: write`-scoped installation token — fail-closed, no secret leakage.

**Requirements:** R1, R5, R6, R8

**Dependencies:** None

**Files:**
- Create: `apps/broker/src/github-app.ts`
- Create: `apps/broker/src/github-app.test.ts`
- Create (optional): `apps/broker/src/__fixtures__/test-app-key.pem` (a throwaway generated PKCS#1 PEM for signing tests)

**Approach:**
- `signAppJwt({ appId, privateKey, now })`: `createPrivateKey(pem)` → `KeyObject`; `new SignJWT({}).setProtectedHeader({alg:'RS256',typ:'JWT'}).setIssuer(appId).setIssuedAt(now-60).setExpirationTime(now+9*60+30).sign(keyObject)`. In-process cache keyed on validity (`exp > now+60`).
- `resolveInstallation({ appJwt, owner, repo, fetch })`: `GET /repos/{owner}/{repo}/installation`, `Authorization: Bearer <appJwt>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version`. Return `.id`. 404 → fail closed. Short in-process cache.
- `mintInstallationToken({ appJwt, installationId, repositoryId, fetch })`: `POST /app/installations/{id}/access_tokens` body `{ repository_ids: [repositoryId], permissions: { contents: 'write' } }`. Assert `res.permissions.contents === 'write'` and the repo echoes back before returning `{ token, expiresAt }`; otherwise fail closed.
- Injected `FetchFn` (mirror `mint.ts`), `AbortSignal.timeout(10_000)`, `if(!res.ok) throw` with **no** key/JWT/token bytes in the message, no retry (one re-sign on 401 permitted). Handle the full failure matrix for BOTH GitHub calls (resolve + mint) — map each fail-closed, no fallback token: 401 (re-sign App JWT once, then give up), 403 (fail closed, no retry — IP-ban avoidance), 404 (installation not found → fail closed), 422 (permission/repo not grantable → fail closed, never retry with escalated scope), 5xx (fail closed), timeout/network error (fail closed). On any auth/scoping failure, invalidate the cached App JWT and installation-id.

**Execution note:** Implement test-first — this is the security boundary. Start with a failing test that a valid signed JWT + stubbed GitHub fetch yields a `contents: write` token, then the fail-closed and no-leak cases.

**Patterns to follow:** `apps/broker/src/mint.ts` (FetchFn, timeout, no-retry, no-leak errors); `apps/broker/src/oidc.test.ts` (RS256 keypair + signed-JWT test setup).

**Test scenarios:**
- Happy path: stubbed `GET installation` returns id; stubbed `POST access_tokens` echoes `{ permissions:{contents:'write'}, repositories:[{id:1126485011}] }` → client returns `{ token, expiresAt }`.
- Happy path: App JWT is cached and reused across resolve+mint within one cycle (assert `createPrivateKey`/sign invoked once).
- Edge: PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`) loads and signs (proves `createPrivateKey`, not `importPKCS8`).
- Error path: `GET installation` → 404 → throws fail-closed, message contains no PEM/JWT bytes.
- Error path: `POST access_tokens` → 422 (permission not grantable) → throws fail-closed, no retry.
- Error path: response echoes `permissions.contents === 'read'` (scope downgrade) → throws (defense-in-depth), token not returned.
- Error path: 401 → re-signs once then gives up → throws.
- Security: for every throw, assert the error string does not contain the private key, the App JWT, or a token value.

**Verification:** `bun test apps/broker/src/github-app.test.ts` green; tsc clean; no `as any`.

- [ ] **Unit 2: Wire App-token mint into `/v1/mint` + envelope response**

**Goal:** After the existing allowlist gate passes, mint the App token and return `{ auth_json, github_token }`; a mint failure fails the whole request closed.

**Requirements:** R1, R2, R4, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `apps/broker/src/server.ts`
- Modify: `apps/broker/src/server.test.ts`

**Approach:**
- `ServerDeps` gains `mintAppToken` (the Unit 1 client, injected). In `handleMint`, after `evaluateClaims` succeeds: parse `owner/repo` + `repository_id` from the verified claims, call `mintAppToken` **first** (it creates no broker state), then `mintKey` (cliproxy), then `recordMint` only after both succeed, then build the envelope. A throw from either mint maps to the same generic 5xx/`error` audit — no token in the body. This ordering means a failed App mint leaves no orphaned, recorded cliproxy key (see Key Technical Decisions — mint-App-first).
- `buildAuthJson` is wrapped: `{ auth_json: <existing anthropic/openai shape>, github_token: { token, expires_at } }`. Set `Cache-Control: no-store` on the response.

**Patterns to follow:** existing `handleMint` ordering + the `mintKey` failure branch in `server.ts`; the "Security: no secret material" block in `server.test.ts`.

**Test scenarios:**
- Happy path: valid allowlisted OIDC → body has `auth_json.anthropic.key` AND `github_token.token`, status 200.
- Error path: `mintAppToken` throws → 5xx, body has no `github_token` and no token bytes, audit `error`.
- Error path: allowlist deny → 403 before any App-token mint (assert `mintAppToken` not called).
- Integration: the App-token mint runs only after `evaluateClaims` (assert call order — gate before mint).
- Security: response body + audit events contain no App JWT, PEM, or installation-token bytes.

**Verification:** `bun test apps/broker/src/server.test.ts` green; the full envelope shape asserted.

- [ ] **Unit 3: Boot-time config + fail-closed wiring**

**Goal:** Read the App id + key-file path at boot, fail closed if missing, and inject the client into `serverDeps`.

**Requirements:** R3, R4

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `apps/broker/src/main.ts`
- Modify: `apps/broker/src/main.test.ts` (if present; else assert via server wiring)

**Approach:**
- Read `GH_APP_ID` and `GH_APP_KEY_FILE` from env. Missing either → `console.error(...) ; process.exit(1)` (mirror the `CLIPROXY_MANAGEMENT_KEY` / `BROKER_AUD` gate). **Decision (was a fork): validate the PEM file is readable AND parses via `createPrivateKey` at boot, and `process.exit(1)` if not** — a broker that can't mint the App token must not accept traffic (fail-closed at the earliest point, consistent with the other required-config gates; the startup-reconcile gate already blocks traffic until ready). Cache the parsed `KeyObject` from that boot load for reuse. Construct `appTokenDeps` and pass into `serverDeps.mintAppToken`.

**Patterns to follow:** `main.ts` env-gate + `mintDeps`/`serverDeps` construction.

**Test scenarios:**
- Error path: missing `GH_APP_ID` → process exits non-zero (or the boot function throws, if refactored for testability).
- Happy path: with both set, `serverDeps.mintAppToken` is wired and callable.
- Test expectation: keep light — most coverage lives in Units 1–2; this is wiring.

**Verification:** broker boots with the new required env; missing config fails closed.

- [ ] **Unit 4: Audit event extension (no-leak)**

**Goal:** Emit an audit record for the App-token mint without any secret bytes.

**Requirements:** R8

**Dependencies:** Unit 2

**Files:**
- Modify: `apps/broker/src/audit.ts`
- Modify: `apps/broker/src/audit.test.ts`

**Approach:**
- Keep this **minimal** (scope-guardian flag): the existing `mint` audit event already records the run. Add only the two optional fields that carry real operator/debug value — `appInstallationId?` and `appTokenExpiresAt?` — to the existing `mint` decision; do **not** introduce a new decision variant or a parallel emitter. Keep the sweeper's `revoke` events untouched. No `token`/`key`/`jwt` field. `redactSensitiveFields` remains the defense-in-depth net. If even those two fields turn out to carry no debugging value at implementation time, drop them and rely on the unchanged `mint` event — the no-leak assertions are the actual requirement (R8), not the new fields.

**Patterns to follow:** existing optional-field `AuditEvent` shape + `audit.test.ts` no-leak assertions.

**Test scenarios:**
- Happy path: a successful App-token mint emits an audit event carrying `appInstallationId` + `appTokenExpiresAt`, no token bytes.
- Security: serialized audit event does not contain the installation token, App JWT, or PEM.
- Edge: existing cliproxy `mint`/`revoke`/`deny` events are unchanged (regression).

**Verification:** `bun test apps/broker/src/audit.test.ts` green.

- [ ] **Unit 5: Deploy path — PEM materialization + shared `.env` list**

**Goal:** Ship the App id + PEM to the droplet safely (stdin only, 0600 file mount), and eliminate the full-overwrite drop-var trap by sharing the `.env` key list between deploy and provision.

**Requirements:** R3

**Dependencies:** Unit 3 (env-var contract must be settled)

**Files:**
- Modify: `apps/broker/src/deploy.ts`
- Modify: `apps/broker/server/provision-droplet.ts`
- Modify: `apps/broker/docker-compose.yaml`
- Modify: `apps/broker/src/deploy.test.ts`

**Approach:**
- Add a `writeRemoteFile(label, host, remotePath, content, ...)` primitive (mirror `apps/dashboard/src/deploy.ts`): `umask 077; cat > '<path>'` over SSH stdin, then `chmod 0600`. Upload the PEM to `/opt/broker/config/github-app.pem`. Normalize the PEM to a single trailing newline; accept literal `\n`.
- Extend the `.env` builder to add `BROKER_GH_APP_ID` (renamed in-container to `GH_APP_ID`) and `GH_APP_KEY_FILE=/run/secrets/github-app.pem` (path only, never the PEM). **Extract the `.env` key list to one shared builder** used by both `deploy.ts` and `provision-droplet.ts` so a var can't be added to one and dropped by the other. `getDeployEnv` accepts `BROKER_GH_APP_KEY` as an optional raw string routed to `writeRemoteFile` (never into the `.env` array, never argv). `preflightChecks` fails before any remote mutation if the App id/key are missing.
- `docker-compose.yaml`: add `- /opt/broker/config/github-app.pem:/run/secrets/github-app.pem:ro` to the `broker` service. Bundle-only deploy still needs `--force-recreate` (already in place).

**Execution note:** Add a captured-stdin test asserting the PEM bytes flow through stdin and NOT through argv, before wiring the upload (characterize the no-argv-secrets invariant).

**Patterns to follow:** `apps/dashboard/src/deploy.ts` `writeRemoteFile` + `buildEnvFileContents` + PEM normalization; `deploy.test.ts` captured-stdin mock.

**Test scenarios:**
- Security: PEM content appears in captured stdin payload; the SSH argv string does NOT contain the PEM bytes.
- Happy path: `.env` payload includes `GH_APP_ID` and `GH_APP_KEY_FILE`, and does NOT include the raw PEM.
- Edge: PEM without trailing newline is normalized to exactly one; literal `\n` form is accepted.
- Regression: the shared `.env` builder emits every prior key (`BROKER_HOST`, `CLIPROXY_MANAGEMENT_URL`, `CLIPROXY_MANAGEMENT_KEY`, `BROKER_AUD`) plus the two new ones — proves no drop.
- Error path: `preflightChecks` throws when App id/key missing, before any remote spawn.

**Verification:** `bun test apps/broker/src/deploy.test.ts` green; compose has the read-only mount.

- [ ] **Unit 6: Workflow secrets + operator docs**

**Goal:** Validate and pass the new environment secrets in CI, and document the secret contract + anti-patterns.

**Requirements:** R3

**Dependencies:** Unit 5

**Files:**
- Modify: `.github/workflows/deploy-broker.yaml`
- Modify: `apps/broker/AGENTS.md`
- Modify: `AGENTS.md` (root NOTES — broker secret list)

**Approach:**
- Add `BROKER_GH_APP_ID` and `BROKER_GH_APP_KEY` to the `workflow_call` secrets, the "Validate required secrets" gate, and the `Deploy broker` env block. Use the `BROKER_GH_APP_*` names (not `GITHUB_`-prefixed — reserved by Actions). Keep per-app concurrency; no `secrets: inherit`.
- `apps/broker/AGENTS.md`: update DEPLOY FLOW, REQUIRED SECRETS, STARTUP GATE, ANTI-PATTERNS (add: never embed the PEM in `.env`; never log the App JWT/token/PEM; App token is fire-and-forget, not swept). Root `AGENTS.md` NOTES: add the two secrets + the file-mount note.

**Patterns to follow:** existing `deploy-broker.yaml` validation step; `apps/dashboard/AGENTS.md` App-key file-mount documentation.

**Test scenarios:** Test expectation: none — workflow/docs. `conventions.test.ts` enforces the invariants that DO apply to the workflow edit (SHA-pinned actions, `.yaml` extension, no `secrets: inherit`); it does not test broker secret names.

**Verification:** the "Validate required secrets" gate in `deploy-broker.yaml` lists `BROKER_GH_APP_KEY`; `conventions.test.ts` stays green (no regression on the workflow invariants); the two AGENTS.md files enumerate the new secrets — confirmed by review, not an automated broker-secret test (none exists).

## System-Wide Impact

- **Interaction graph:** `/v1/mint` is the only endpoint touched; the new client is called after `evaluateClaims`. No change to `oidc.ts`, `policy.ts`, `rate-limit.ts`, `sweeper.ts`, or `live-set.ts`.
- **Error propagation:** App-token mint failure propagates as the existing generic 5xx/`error` path — no new leak surface, no fallback token.
- **State lifecycle risks:** the App token is NOT added to the live-set and NOT swept — it is GitHub-server-side state, fixed 1h TTL. The model credential's lifecycle is unchanged.
- **API surface parity:** the `/v1/mint` response contract changes shape (bare auth.json → envelope). This is the one breaking change; it MUST land with `fro-bot/agent#1124`. Until both land, the integrate path is not end-to-end.
- **Unchanged invariants:** OIDC verification, the allowlist policy, the cliproxy mint/revoke/reconcile lifecycle, single-flight lock, rate limiting — none change.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Response-shape change breaks the current consumer | Coordinate rollout with `fro-bot/agent#1124`; broker ships first but the envelope is the agreed contract; do not claim end-to-end until the consumer lands. |
| Full-overwrite `.env` drops the new (or existing) vars | Extract one shared `.env` key-list builder used by both deploy and provision (Unit 5); regression test asserts all keys present. |
| PEM leaks via argv / logs / `docker inspect` | SSH-stdin only, file mount 0600, `.env` holds the path not the PEM, no-leak error/audit tests. |
| App token's 1h TTL is a weaker bound than the 30-min swept model credential | Documented honest limitation; the integrate job runs in minutes; early `DELETE` revoke deferred (needs a run-end callback the broker lacks). |
| Bundle-only deploy runs stale code | `--force-recreate` already in the deploy; verify running-container `CreatedAt` + a behavior probe post-deploy, not a `grep` of the bundle. |
| Wrong App / missing `contents: write` grant | Verified `harness-release.yaml` already mints+uses a `contents: write` token from `APPLICATION_ID`; the mint response echo is asserted before returning. |
| Broker becomes a higher-value target (now holds a `contents:write` App key for `fro-bot/agent`, not just model keys) | Accepted, explicitly: the broker is already a durable-credential custodian on a hardened, OIDC-gated, single-purpose droplet (memory: gated env, no-argv-secrets, 0600 file mount). Concentrating custody there is the *point* — it's a smaller, more defensible attack surface than a broad PAT living in every integrate run. The App key is single-repo-scoped at the App-installation level, and the broker can only ever mint what the installation grants. Rotation = new key in App settings → update `broker` env secret → redeploy. |
| Per-mint `GET installation` adds GitHub as a request-path dependency (latency / failure amplification) | The integrate mint path is low-frequency (one per release run); the ≤5-min installation-id cache bounds repeat lookups; the App JWT is cached for its validity. A GitHub outage fails the mint closed (acceptable — the run can't proceed without the token anyway). No change to the existing rate limiter needed at this volume. |

## Alternative Approaches Considered

- **Job-level split — mint in a trusted step, not the broker.** The consumer workflow could mint the App token itself via `actions/create-github-app-token` in a *separate, non-injectable* job/step, passing only the resulting scoped token to the injectable merge step (never the App key). This is simpler (no broker change, no envelope break) and is exactly how `harness-release.yaml` already works. **Why not chosen as the sole approach:** it puts the App private key into the integrate *workflow's* secret scope. GitHub Actions secrets are available to every step of the job unless split across jobs, and even across jobs the key sits in the repo's Actions secret store — a broader exposure than the broker's single-purpose gated droplet. #771 explicitly chose broker custody so the durable key lives in exactly one hardened place, consistent with the model-credential trust boundary already established. **This is a genuine tradeoff, not a settled truth** — if the operator later judges the job-split's simplicity worth the wider key scope, the consumer-side `#1124` work could take that path instead and this plan would not ship. Flagged for the handoff decision.
- **Store the installation id as config** (vs resolve-at-mint). Rejected in dialogue: resolve-at-mint needs no extra deploy secret and reflects current install state; the ≤5-min cache bounds the cost.

## Documentation / Operational Notes

- No changeset (`apps/broker/**` only; no `packages/cli/src/` surface).
- New `broker` GitHub Environment secrets `BROKER_GH_APP_ID` + `BROKER_GH_APP_KEY` must be added to the (already-gated) `broker` environment before the workflow referencing them merges.
- Deploy is human-gated; end-to-end verification blocked on `fro-bot/agent#1124`. Broker-only acceptance: unit tests + a live `/v1/mint` with a real integrate OIDC token returns a working `contents: write` token (the consumer verifies the push).

## Sources & References

- Origin: `marcusrbrown/infra#771` + its Fro Bot triage comment; cross-repo design `fro-bot/agent#1123`.
- Deeper-half tracker: `fro-bot/agent#1107`; consuming half: `fro-bot/agent#1124`; egress half: `marcusrbrown/infra#751`.
- Related code: `apps/broker/src/{server,mint,oidc,audit,main,deploy}.ts`, `apps/broker/server/provision-droplet.ts`, `apps/dashboard/src/deploy.ts`.
- Learnings: `docs/solutions/integration-issues/broker-credential-lifecycle-restart-races-2026-07-02.md`, `docs/solutions/workflow-issues/broker-first-deploy-cascade-2026-06-30.md`, `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md`.
- External: GitHub REST — App JWT, `GET /repos/{owner}/{repo}/installation`, `POST /app/installations/{id}/access_tokens`, `DELETE /installation/token`.
