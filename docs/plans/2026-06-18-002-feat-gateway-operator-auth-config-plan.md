---
title: "feat: Gateway operator auth/config secrets — wire GitHub OAuth, CSRF, and allowlist into deploy"
type: feat
status: active
date: 2026-06-18
---

# feat: Gateway operator auth/config secrets — wire GitHub OAuth, CSRF, and allowlist into deploy

## Overview

`fro-bot/agent v0.69.0` (released 2026-06-18T20:10:15Z) ships the operator browser auth gate
(PR #944) and session foundation (PR #939). The upstream `packages/gateway/src/config.ts` now
defines a complete set of auth/config environment variables that the operator web surface requires
when the operator listener is enabled. This plan specifies how to wire those variables into the
infra deploy pipeline as secret files, compose override entries, workflow secrets, and CLI
passthrough — without implementing any of those changes here.

**This is a design and readiness artifact.** Implementation is not performed in this plan. The
upstream v0.69.0 contract is now stable; this plan exists so implementation can proceed against a
verified spec rather than against guessed names.

Related tracking: `marcusrbrown/infra#580`, `fro-bot/.github#3512`.

---

## Requirements Trace

| ID | Requirement |
| -- | ----------- |
| R1 | `GATEWAY_OPERATOR_GITHUB_CLIENT_ID` and `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET` must be materialized as secret files on the droplet and exposed via `_FILE` env vars in the compose override when operator web is enabled. |
| R2 | `GATEWAY_OPERATOR_CSRF_SECRET` must be materialized as a secret file and exposed via `_FILE` env var in the compose override when operator web is enabled. The value must be strict base64url (no padding, no newlines) and decode to at least 32 bytes. |
| R3 | `GATEWAY_OPERATOR_ALLOWLIST` must be materialized as a secret file and exposed via `_FILE` env var in the compose override when operator web is enabled. The value must be a newline-separated list of numeric GitHub user IDs; the gate is fail-closed if the file is missing, empty, or malformed. |
| R4 | All four auth/config secrets (R1–R3) must be omitted entirely from the compose override and secret file list when the operator listener trio (`GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`, `GATEWAY_OPERATOR_PUBLIC_ORIGIN`) is absent. When operator web is disabled, no new auth secret files or env vars are emitted and the non-auth deploy path remains the path. |
| R5 | Secret values must never appear in shell argv, `.env`, compose output, logs, public docs, or PR text. Only `_FILE` env vars appear in the compose override, pointing to `/run/secrets/…` bind mounts sourced from `/opt/gateway/deploy/secrets/*`. |
| R6 | The secrets checksum must include the new secret file contents and the updated compose override so that rotation of any auth/config secret triggers a force-recreate/restart of the gateway container. |
| R7 | Optional OAuth tuning vars (`GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS`, `GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS`, `GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS`) must be emitted as plain env vars in the compose override when operator web is enabled and the values are present. They are not secret and do not require file-backed materialization. |
| R8 | The `deploy-gateway.yaml` `workflow_call` secret schema and the fan-out `deploy.yaml` pass-through must be extended with the four new secret names. The three optional tuning vars must be wired through the same GitHub Environment/workflow pass-through mechanism as the other optional gateway values, using `required: false` optional secrets (not `workflow_call.inputs`), and passed into the deploy step env via `${{ secrets.* }}`. The CLI local deploy passthrough must also be extended for all seven vars. |
| R9 | A required≡wired invariant test must verify the complete enabled operator contract as one set: the existing listener trio, all four required auth/config `_FILE` env vars, all four bind mounts, and any optional tuning vars when present. The test must assert the generated compose override contains all of these elements together — do not split this invariant across separate assumptions or test cases. |
| R10 | The GitHub OAuth App callback URL registered in the GitHub OAuth App settings must be `{GATEWAY_OPERATOR_PUBLIC_ORIGIN}/operator/auth/github/callback`. For the production value `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot`, the callback URL is `https://dashboard.fro.bot/operator/auth/github/callback`. Note: this is a GitHub OAuth App (client ID/secret), not the existing gateway GitHub App (`GH_APP_ID`). |
| R11 | Sessions are v1 in-memory in `fro-bot/agent v0.69.0`; a gateway restart invalidates all active sessions. No session-persistence deploy var exists at this version. |

---

## Scope Boundaries

**In scope (this plan):**

- Design and specification for wiring the v0.69.0 operator auth/config contract into infra deploy.
- Upstream contract documentation: exact env var names, file-backed vs plain, required vs optional.
- Implementation unit breakdown with files, approach, test scenarios, and verification criteria.
- Rollback path and post-enable manual verification guidance.
- Workflow, CLI, and runbook extension requirements.

### Deferred to Separate Tasks

| Deferred item | Tracking |
| ------------- | -------- |
| Dashboard Caddy `/operator/*` reverse proxy and private dashboard→gateway path | `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` |
| Dashboard app operator auth/session wiring | Future dashboard task |
| Upstream pin bump from `v0.66.0` to `v0.69.0` in `apps/gateway/upstream.json` | Prerequisite gate in Unit 1; implementation may include the bump if the target ref is confirmed ready |
| Broader privileged operator work (runs/approvals/repo APIs, dashboard live client, private path) | Future upstream units |

---

## Context & Research

### Upstream v0.69.0 Contract

`fro-bot/agent v0.69.0` (released 2026-06-18T20:10:15Z) includes:

- PR #944: operator browser auth gate (GitHub OAuth, CSRF, allowlist).
- PR #939: session foundation (v1 in-memory sessions).

The authoritative source is `packages/gateway/src/config.ts` in the v0.69.0 release. The
complete operator auth/config env var contract is:

**Existing listener trio (all-or-none, already wired by `infra#579`):**

| Env var | Required when operator enabled | Notes |
| ------- | ------------------------------ | ----- |
| `GATEWAY_OPERATOR_BIND_HOST` | Yes | gateway-net IPv4 address |
| `GATEWAY_OPERATOR_BIND_PORT` | Yes | positive integer |
| `GATEWAY_OPERATOR_PUBLIC_ORIGIN` | Yes | bare HTTPS origin |

**New auth/config vars (all required when operator web enabled):**

| Env var | `_FILE` variant | Required | Notes |
| ------- | --------------- | -------- | ----- |
| `GATEWAY_OPERATOR_GITHUB_CLIENT_ID` | `GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE` | Yes | GitHub OAuth App client ID |
| `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET` | `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET_FILE` | Yes | GitHub OAuth App client secret |
| `GATEWAY_OPERATOR_CSRF_SECRET` | `GATEWAY_OPERATOR_CSRF_SECRET_FILE` | Yes | strict base64url, no padding/newlines, ≥32 decoded bytes |
| `GATEWAY_OPERATOR_ALLOWLIST` | `GATEWAY_OPERATOR_ALLOWLIST_FILE` | Yes | newline-separated numeric GitHub user IDs; fail-closed if missing/empty/malformed |

**Optional OAuth tuning vars (plain env, not file-backed):**

| Env var | Default | Notes |
| ------- | ------- | ----- |
| `GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS` | `/operator` | comma-separated same-origin post-auth paths |
| `GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS` | `600000` | positive integer ms |
| `GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS` | `5` | positive integer |

**Session secret:** No deploy var in v0.69.0. Sessions are v1 in-memory; a gateway restart
invalidates all active sessions. No session-persistence wiring is needed at this version.

**Callback URL:** The GitHub OAuth App must be configured with:
```
{GATEWAY_OPERATOR_PUBLIC_ORIGIN}/operator/auth/github/callback
```
For production: `https://dashboard.fro.bot/operator/auth/github/callback`.

### Current Infra Deploy Patterns

The following patterns from `apps/gateway/src/deploy.ts` apply directly to this work:

- **`getAnnounceState()`** — both-or-neither opt-in gate; returns `'enabled' | 'disabled' | 'invalid'`. The new `getOperatorAuthState()` mirrors this pattern for the four auth/config secrets.
- **`validateOperatorConfig()`** — validates the listener trio values. The new `validateOperatorAuthConfig()` validates the four auth/config values.
- **`buildSecretFileList()`** — builds the list of `SecretFile` objects to materialize on the droplet. Auth/config secret files are appended conditionally when operator web is enabled.
- **`computeSecretsChecksum()`** — SHA-256 over all secret file contents. Must include the new files when present.
- **`buildComposeOverride()`** — generates `compose.override.yaml`. Must emit `_FILE` env vars and bind mounts for the four auth/config secrets, and optional tuning vars, when operator web is enabled.
- **`writeRemoteFile()`** — SSH stdin pipe with `umask 077`; secret bytes never appear in argv.
- **`main()`** — orchestrates validation, secret materialization, checksum, compose up, and post-deploy probes.

### Relevant Lessons from Prior Work

- **Required≡wired invariant** (`docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md`): the daemon config loader's required-secret list must equal the compose wiring. Infra must add a test gate that verifies every upstream-required var is present in the generated compose override when operator web is enabled.
- **SSH stdin for secrets** (`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`): never use `gh secret set --body <value>` or shell substitution. Pipe via stdin only. `writeRemoteFile` already enforces this for droplet-side materialization.
- **Caddy `handle` blocks** (`docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md`): the existing `/operator/*` Caddy route already uses mutually-exclusive `handle` blocks. No Caddy changes are needed for auth wiring.
- **Deploy sequencing** (`docs/solutions/integration-issues/docker-network-stale-subnet-cleanup-2026-06-18.md`): pull images before disruptive cleanup; the existing `removeStaleGatewayNet()` step is already in place.
- **Rotation runbook precedent** (`docs/runbooks/discord-token-lifecycle.md`): secret rotation follows a containment-first sequence; the operator auth secrets need a similar runbook section.

### Existing Operator Listener State

The operator listener trio is enabled in production:
- `GATEWAY_OPERATOR_BIND_HOST=172.21.0.2`
- `GATEWAY_OPERATOR_BIND_PORT=9300`
- `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot`

The current public operator surface is `GET /operator/health` only. The v0.69.0 upstream release
also ships browser-auth and session routes (`/operator/auth/github/start`,
`/operator/auth/github/callback`, `/operator/session/csrf`, `/operator/auth/logout`); these
become reachable once the auth/config wiring in this plan lands. Broader privileged operator work
(runs/approvals/repo APIs, dashboard live client, private path) remains deferred to future
upstream units.

---

## Key Technical Decisions

### Decision: All four auth/config secrets are file-backed via `_FILE` env vars

The upstream config loader supports both bare env vars and `_FILE` variants. Infra uses `_FILE`
exclusively for secret values — the secret content lives in a bind-mounted file at
`/run/secrets/…`, and the compose override emits only the `_FILE` env var pointing to that path.
This keeps secret bytes out of the compose override YAML, the `.env` file, and any process
environment that might be logged.

### Decision: Auth/config secrets are all-or-none with the operator listener trio

When the operator listener trio is absent, the four auth/config secrets are omitted entirely from
`buildSecretFileList()` and `buildComposeOverride()`. No new auth secret files or env vars are
emitted and the non-auth deploy path remains the path. When the trio is present, all four
auth/config secrets are required; a partial set fails before any SSH/spawn.

### Decision: Optional tuning vars are plain env vars in the compose override

`GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS`, `GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS`, and
`GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS` are not secret. They are emitted as plain
`environment:` entries in the compose override when operator web is enabled and the values are
present. They are not materialized as secret files and do not affect the secrets checksum.

### Decision: Checksum includes auth/config secret file contents

The secrets checksum (`computeSecretsChecksum`) covers all materialized secret files. Adding the
four auth/config files to `buildSecretFileList()` automatically includes them in the checksum.
Rotation of any auth/config secret changes the checksum, triggering `--force-recreate` on the
next deploy.

### Decision: No session-persistence wiring at v0.69.0

Sessions are v1 in-memory. A gateway restart invalidates all active sessions. No
`GATEWAY_OPERATOR_SESSION_SECRET` or equivalent deploy var exists in v0.69.0. This is documented
as a known limitation; session persistence is a future upstream concern.

### Decision: Callback URL is documented with computed preflight; portal registration is manual

The callback URL `{GATEWAY_OPERATOR_PUBLIC_ORIGIN}/operator/auth/github/callback` is a GitHub
OAuth App registration requirement (registered in the GitHub OAuth App settings — not the existing
gateway GitHub App identified by `GH_APP_ID`). Infra cannot read or validate the GitHub OAuth App
callback registration via API — no public GitHub API surface exposes OAuth App callback settings.
The operator must register the callback URL manually in the GitHub Developer Portal before
enablement.

As a machine-checkable preflight aid, implementation should compute the expected callback string
from `GATEWAY_OPERATOR_PUBLIC_ORIGIN` at deploy time and surface it in dry-run output or a
validation helper (e.g. `gateway deploy --dry-run` prints `Expected OAuth callback URL:
{origin}/operator/auth/github/callback`). This gives the operator a concrete string to verify
against the portal registration without requiring infra to call a GitHub API. The correct URL for
production is `https://dashboard.fro.bot/operator/auth/github/callback`. This is documented in
the runbook and in the GitHub Environment setup notes.

---

## Open Questions

| Question | Status |
| -------- | ------ |
| Should `GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS` be validated (e.g. path-only, no scheme/host)? | Open — defer to implementation; upstream validates at runtime. |
| Should the CSRF secret generation example reference the upstream docs command or a generic openssl invocation? | Open — use a generic example in the runbook; never output real secret bytes. |
| Does the operator allowlist need a minimum-entry guard in infra (e.g. reject empty list)? | Open — upstream is fail-closed on empty/malformed; infra may add a pre-deploy guard for operator ergonomics. |

## Resolved During Planning

| Question | Resolution |
| -------- | ---------- |
| Does v0.69.0 add any additional required vars beyond the four auth/config vars listed above? | Resolved: `packages/gateway/src/config.ts` at the v0.69.0 tag confirms the four auth/config vars (`GATEWAY_OPERATOR_GITHUB_CLIENT_ID`, `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`, `GATEWAY_OPERATOR_CSRF_SECRET`, `GATEWAY_OPERATOR_ALLOWLIST`) are the complete required set when operator web is enabled. No additional required vars were added. |

---

## Implementation Units

> Each unit is independent enough to be reviewed and merged separately, but must be sequenced as
> listed because later units depend on earlier ones.

- [x] **Unit 1: Target-ref readiness gate and contract guard**

  **Goal:** Confirm `fro-bot/agent v0.69.0` is the correct target ref for the operator auth/config
  contract and add a test guard that enforces the minimum required ref. Advancing
  `apps/gateway/upstream.json` from `v0.66.0` to `v0.69.0` is included in this unit if the
  target ref is confirmed ready; it is not a design-plan obligation.

  **Requirements:** R9 (prerequisite: pin must be at a ref that includes the auth/config vars)

  **Dependencies:** `fro-bot/agent v0.69.0` remains available and deployable.

  **Files:**
  - `apps/gateway/src/deploy.test.ts`
  - `apps/gateway/upstream.json` (if pin bump is included)

  **Approach:**
  - Diff the v0.69.0 `packages/gateway/src/config.ts` required-secret list against the current
    infra compose wiring to confirm no additional required vars were added beyond the four
    auth/config vars documented in this plan. This diff is the readiness gate.
  - Add a test that reads `upstream.json` and asserts the ref is `v0.69.0` or later (semver
    range check). This is a lightweight contract guard, not a live upstream fetch.
  - If the readiness gate passes, update `ref` from `v0.66.0` to `v0.69.0` in `upstream.json`.
    If a later tag is chosen at implementation time, re-run the diff against that tag first.

  **Patterns to follow:** Existing `resolveUpstreamPin()` tests in `apps/gateway/src/deploy.test.ts`.

  **Test scenarios:**
  - Happy path: `upstream.json` ref is `v0.69.0` or later; contract guard test passes.
  - Error path: if the ref is at `v0.66.0` or earlier, the contract guard test fails with a clear
    message indicating the auth/config contract is not present at that ref.

  **Verification:** Contract guard test passes; if pin was bumped, `upstream.json` points to
  `v0.69.0`; `bun test --cwd apps/gateway` passes.

- [x] **Unit 2: Add `getOperatorAuthState` and `validateOperatorAuthConfig` helpers**

  **Goal:** Add state detection and validation helpers for the four operator auth/config secrets,
  mirroring the `getOperatorState` / `validateOperatorConfig` pattern for the listener trio.

  **Requirements:** R1, R2, R3, R4

  **Dependencies:** Unit 1 (pin must be at v0.69.0 before auth/config names are used).

  **Files:**
  - `apps/gateway/src/deploy.ts`
  - `apps/gateway/src/deploy.test.ts`

  **Approach:**

  Add `getOperatorAuthState(env)`:
  - Returns `'enabled'` when all four auth/config vars are present and non-empty.
  - Returns `'disabled'` when all four are absent (unset or whitespace-only).
  - Returns `'invalid'` when one to three are present — the all-or-none gate is violated.
  - Mirrors the empty/whitespace-only = absent semantics of `validateRequiredEnv`.

  Add `validateOperatorAuthConfig(opts)`:
  - Validates `githubClientId`: non-empty string.
  - Validates `githubClientSecret`: non-empty string (no structural constraint beyond non-empty; the
    value is opaque to infra).
  - Validates `csrfSecret`: non-empty, strict base64url characters only (no padding `=`, no
    whitespace, no newlines), decoded byte length ≥ 32. Reject values that fail the base64url
    character set or decode to fewer than 32 bytes.
  - Validates `allowlist`: non-empty; blank/whitespace-only lines and full-line `#` comments (after
    optional leading whitespace) are ignored; at least one numeric GitHub user ID must remain after
    filtering; non-numeric non-comment lines are rejected. Mirrors upstream `fro-bot/agent v0.69.0`
    allowlist parser semantics.
  - Throws with a descriptive message on any validation failure.

  **Execution note:** Implement test-first. The CSRF and allowlist validation cases are
  security-relevant; cover both happy and error paths before wiring into `main()`.

  **Patterns to follow:** `getAnnounceState()`, `getOperatorState()`, `validateOperatorConfig()` in
  `apps/gateway/src/deploy.ts`.

  **Test scenarios:**
  - `getOperatorAuthState`: all four present → `'enabled'`; all four absent → `'disabled'`; one
    present → `'invalid'`; two present → `'invalid'`; three present → `'invalid'`.
  - `validateOperatorAuthConfig` happy path: valid client ID, client secret, CSRF secret (≥32 decoded
    bytes, base64url), allowlist (one or more numeric IDs).
  - `validateOperatorAuthConfig` CSRF error: padding characters (`=`) → throws; whitespace → throws;
    newline → throws; decoded length < 32 bytes → throws.
  - `validateOperatorAuthConfig` allowlist error: empty string → throws; non-numeric non-comment
    line → throws; allowlist containing only blank lines and/or `#` comments → throws (empty
    effective allowlist). Blank/whitespace-only lines and full-line `#` comments are ignored (not
    rejected) — aligning with upstream `fro-bot/agent v0.69.0` allowlist parser semantics.
  - `validateOperatorAuthConfig` client ID/secret error: empty string → throws.

  **Verification:** All new tests pass; `bunx tsc --noEmit` clean.

- [x] **Unit 3: Materialize operator auth secret files via `buildSecretFileList` and checksum** *(auth gate semantics corrected: `operatorState === 'enabled'` + `operatorAuthState === 'disabled'` now fails before SSH/spawn)*

  **Goal:** Extend `buildSecretFileList()` to append the four operator auth/config secret files when
  operator web is enabled, and verify the checksum covers them.

  **Requirements:** R1, R2, R3, R4, R5, R6

  **Dependencies:** Unit 2.

  **Files:**
  - `apps/gateway/src/deploy.ts`
  - `apps/gateway/src/deploy.test.ts`

  **Approach:**

  In `buildSecretFileList(env)`:
  - After the existing announce secret block, add an operator auth block:
    ```
    if (getOperatorState(env) === 'enabled') {
      // getOperatorAuthState is checked here; main() throws before reaching this
      // if the state is 'invalid', so only 'enabled' or 'disabled' is possible.
      if (getOperatorAuthState(env) === 'enabled') {
        secrets.push({ name: 'gateway-operator-github-client-id', content: env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID, required: false })
        secrets.push({ name: 'gateway-operator-github-client-secret', content: env.GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET, required: false })
        secrets.push({ name: 'gateway-operator-csrf-secret', content: env.GATEWAY_OPERATOR_CSRF_SECRET, required: false })
        secrets.push({ name: 'gateway-operator-allowlist', content: env.GATEWAY_OPERATOR_ALLOWLIST, required: false })
      }
    }
    ```
  - Secret file names use kebab-case matching the upstream compose contract convention.
  - `computeSecretsChecksum()` requires no changes — it hashes whatever `buildSecretFileList()`
    returns, so the new files are automatically included.

  **Execution note:** The `required: false` shape is used for conditional secrets (same as announce
  secrets). `main()` enforces the all-or-none gate before calling `buildSecretFileList()`.

  **Patterns to follow:** Announce secret block at the end of `buildSecretFileList()` in
  `apps/gateway/src/deploy.ts`.

  **Test scenarios:**
  - Happy path: operator listener enabled + all four auth/config vars present → four new
    `SecretFile` entries appended; checksum changes when any auth/config value changes.
  - Happy path: operator listener disabled → no auth/config `SecretFile` entries; checksum
    unchanged from baseline.
  - Happy path: operator listener enabled + auth/config absent → `main()` throws before
    `buildSecretFileList()` is called (listener enabled + auth disabled is invalid per v0.69.0
    contract; `buildSecretFileList()` is still safe when called directly without auth vars).
  - Error path: operator listener enabled + partial auth/config → `main()` throws before
    `buildSecretFileList()` is called (covered by Unit 2 tests; verify the call order in `main()`).

  **Verification:** `buildSecretFileList` tests pass; checksum tests confirm rotation sensitivity.

- [x] **Unit 4: Emit `_FILE` compose env, bind mounts, and optional tuning vars**

  **Goal:** Extend `buildComposeOverride()` to emit `_FILE` env vars and bind mounts for the four
  auth/config secrets, and optional tuning vars, when operator web is enabled. Add the
  required≡wired invariant test.

  **Requirements:** R1, R2, R3, R4, R5, R7, R9

  **Dependencies:** Unit 3.

  **Files:**
  - `apps/gateway/src/deploy.ts`
  - `apps/gateway/src/deploy.test.ts`

  **Approach:**

  Extend `ComposeOverrideOpts`:
  ```ts
  operatorAuthEnabled?: boolean
  operatorGithubClientIdFile?: string    // kebab-case secret file name
  operatorGithubClientSecretFile?: string
  operatorCsrfSecretFile?: string
  operatorAllowlistFile?: string
  operatorOauthAllowedReturnPaths?: string  // optional tuning
  operatorOauthStateTtlMs?: string          // optional tuning
  operatorOauthMaxOutstandingAttempts?: string  // optional tuning
  ```

  In `buildComposeOverride()`:
  - When `operatorAuthEnabled` is true, append to the gateway service `environment:` section:
    ```yaml
    GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE: /run/secrets/gateway_operator_github_client_id
    GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET_FILE: /run/secrets/gateway_operator_github_client_secret
    GATEWAY_OPERATOR_CSRF_SECRET_FILE: /run/secrets/gateway_operator_csrf_secret
    GATEWAY_OPERATOR_ALLOWLIST_FILE: /run/secrets/gateway_operator_allowlist
    ```
    (Container paths use snake_case per upstream compose convention.)
  - Append bind mounts for each of the four secret files to the gateway service `volumes:` section,
    with `read_only: true` and `create_host_path: false`.
  - When optional tuning vars are present, append them as plain `environment:` entries (no `_FILE`).
  - When `operatorAuthEnabled` is false, emit no auth/config env vars or bind mounts.

  **Required≡wired invariant test:**
  - Add a single test that asserts the complete enabled operator contract as one set: the existing
    listener trio env vars, all four `_FILE` env vars (`GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE`,
    `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET_FILE`, `GATEWAY_OPERATOR_CSRF_SECRET_FILE`,
    `GATEWAY_OPERATOR_ALLOWLIST_FILE`), all four bind mounts, and any optional tuning vars when
    provided. Do not split this invariant across separate assumptions.
  - This test is the infra-side guard against the class of failure documented in
    `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md`.

  **Patterns to follow:** Existing `announceEnvLines` / `announceVolumes` blocks in
  `buildComposeOverride()`; the `_FILE` env var pattern from the Discord token runbook table.

  **Test scenarios:**
  - Required≡wired gate (single combined assertion): `operatorAuthEnabled=true` with all four
    auth/config file names and all three optional tuning vars provided → generated override
    contains the listener trio env vars, all four `_FILE` env vars, all four bind mounts, and all
    three optional tuning vars as plain env entries; no bare secret values in override YAML.
  - Happy path: `operatorAuthEnabled=false` → no auth/config env vars or bind mounts in override.
  - Happy path: optional tuning vars absent → not emitted in override.
  - Error path: `operatorAuthEnabled=true` with missing file names → implementation should guard
    against emitting empty `_FILE` values.

  **Verification:** Override shape tests pass; required≡wired gate test passes; `bunx tsc --noEmit`
  clean.

- [x] **Unit 5: Wire CLI local deploy passthrough and GitHub workflow secrets/inputs**

  **Goal:** Extend the CLI local deploy command and both GitHub workflow files to pass through the
  four new secret names and three optional tuning vars, so the full deploy path (local and CI) has
  access to all auth/config vars.

  **Requirements:** R8

  **Dependencies:** Unit 4.

  **Files:**
  - `packages/cli/src/commands/gateway/deploy.ts`
  - `.github/workflows/deploy-gateway.yaml`
  - `.github/workflows/deploy.yaml`
  - `apps/gateway/src/deploy.test.ts` (convention tests)

  **Approach:**

  In `packages/cli/src/commands/gateway/deploy.ts`:
  - Add the four new secret env var names to the local deploy env passthrough list:
    `GATEWAY_OPERATOR_GITHUB_CLIENT_ID`, `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`,
    `GATEWAY_OPERATOR_CSRF_SECRET`, `GATEWAY_OPERATOR_ALLOWLIST`.
  - Add the three optional tuning vars to the passthrough list as well:
    `GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS`, `GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS`,
    `GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS`.

  In `.github/workflows/deploy-gateway.yaml`:
  - Add four new optional secrets to `workflow_call.secrets`:
    - `GATEWAY_OPERATOR_GITHUB_CLIENT_ID` (`required: false`)
    - `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET` (`required: false`)
    - `GATEWAY_OPERATOR_CSRF_SECRET` (`required: false`)
    - `GATEWAY_OPERATOR_ALLOWLIST` (`required: false`)
  - Add three optional tuning vars to `workflow_call.secrets` (optional secret pass-through,
    consistent with other optional gateway environment values):
    - `GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS` (`required: false`)
    - `GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS` (`required: false`)
    - `GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS` (`required: false`)
  - Pass all four secrets and all three tuning vars into the deploy step env via `${{ secrets.* }}`,
    mirroring the existing pattern for `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID`.
  - Note: tuning vars are non-secret operational config, but are transported via optional GitHub
    Environment secret pass-through for consistency with the gateway deploy pipeline; no
    `workflow_call.inputs` are used.

  In `.github/workflows/deploy.yaml`:
  - Add the four new secrets to the `secrets:` mapping in the gateway deploy job, mirroring the
    existing pattern for `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID`.
  - Add the three optional tuning vars to the `secrets:` mapping in the gateway deploy job (not
    `with:`); the deploy router job does not own the gateway Environment, so `with:` must not
    source secret-context Environment values.

  **Patterns to follow:** Existing `GATEWAY_WEBHOOK_SECRET` / `GATEWAY_PRESENCE_CHANNEL_ID` entries
  in both workflow files; existing local deploy passthrough in
  `packages/cli/src/commands/gateway/deploy.ts`.

  **Test scenarios:**
  - Convention test: `deploy-gateway.yaml` contains all four new secret names in `workflow_call.secrets`
    and all three tuning var names in `workflow_call.secrets` (not `workflow_call.inputs`).
  - Convention test: `deploy.yaml` passes all four new secrets and all three tuning vars to the
    gateway deploy job via `secrets:` mapping (not `with:`).
  - Happy path: local deploy with all four auth/config vars and optional tuning vars in `.env` →
    all vars reach `main()`.
  - Happy path: local deploy without auth/config vars → operator auth disabled; deploy proceeds
    without auth/config wiring.

  **Verification:** Convention tests pass; `bun run lint` clean; `bunx tsc --noEmit` clean.

- [x] **Unit 6: Update docs, runbook, and operator rotation/rollback guidance**

  **Goal:** Document the operator auth/config secret lifecycle, rotation procedure, rollback path,
  and post-enable manual verification in `apps/gateway/AGENTS.md` and a new runbook section.

  **Requirements:** R10, R11

  **Dependencies:** Units 1–5 for final code-linked wording; this unit can be drafted in parallel
  with implementation.

  **Files:**
  - `apps/gateway/AGENTS.md`
  - `docs/runbooks/gateway-operator-auth-lifecycle.md` (new)
  - `AGENTS.md` (gateway environment secrets list in NOTES section)

  **Approach:**

  In `apps/gateway/AGENTS.md`:
  - Add an OPERATOR AUTH section documenting:
    - The four required auth/config secrets and their `_FILE` env var names.
    - The callback URL: `https://dashboard.fro.bot/operator/auth/github/callback`.
    - The session v1 in-memory limitation (restart invalidates sessions).
    - The rollback path (see below).
    - Post-enable manual verification steps (see below).

  In the runbook (new `docs/runbooks/gateway-operator-auth-lifecycle.md`):
  - Document the GitHub OAuth App setup: create an OAuth App in the GitHub Developer Portal,
    set the callback URL to `https://dashboard.fro.bot/operator/auth/github/callback`, copy the
    client ID and generate a client secret.
  - Document CSRF secret generation (generic example only — never output real secret bytes):
    ```bash
    # Example: generate a 32-byte base64url secret (no padding, no newlines)
    # Replace with the actual command from upstream docs or a trusted source
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
    ```
  - Document allowlist setup: obtain numeric GitHub user IDs for authorized operators; format as
    one ID per line.
  - Document secret seeding via stdin pipe (never `--body` substitution):
    ```bash
    printf '%s' '<client-id>' | gh secret set --env gateway GATEWAY_OPERATOR_GITHUB_CLIENT_ID
    printf '%s' '<client-secret>' | gh secret set --env gateway GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET
    printf '%s' '<csrf-secret>' | gh secret set --env gateway GATEWAY_OPERATOR_CSRF_SECRET
    printf '%s' '<allowlist>' | gh secret set --env gateway GATEWAY_OPERATOR_ALLOWLIST
    ```
  - Document rotation: update the GitHub Environment secret, trigger deploy, approve environment
    gate, verify. Sessions are invalidated on restart (v1 in-memory).
  - Document rollback: see Rollback Path section below.

  In root `AGENTS.md`:
  - Add `GATEWAY_OPERATOR_GITHUB_CLIENT_ID`, `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`,
    `GATEWAY_OPERATOR_CSRF_SECRET`, and `GATEWAY_OPERATOR_ALLOWLIST` to the `gateway` environment
    secrets list in the NOTES section.

  **Test scenarios:** None — documentation only. Verify links and grep for forbidden phrasing.

  **Verification:**
  - `apps/gateway/AGENTS.md` contains the callback URL string
    `https://dashboard.fro.bot/operator/auth/github/callback`.
  - Root `AGENTS.md` contains all four new secret names.
  - No real secret values appear in any tracked file.

---

## System-Wide Impact

- **Interaction graph:** When operator web is enabled, the gateway container receives four
  additional bind-mounted secret files and four `_FILE` env vars. The upstream config loader reads
  these at startup. No other services are affected.
- **Error propagation:** Partial auth/config (one to three of the four vars present) fails before
  any SSH/spawn in `main()`. Missing auth/config when operator listener is enabled fails before
  compose up. The upstream loader is fail-closed on missing/empty/malformed allowlist.
- **State lifecycle risks:** Sessions are v1 in-memory. Any gateway restart (deploy, force-recreate,
  container crash) invalidates all active operator sessions. Operators must re-authenticate after
  each restart. This is a known limitation at v0.69.0.
- **Checksum-driven recreate:** Adding auth/config secrets to `buildSecretFileList()` means the
  first deploy after wiring will always trigger `--force-recreate` (checksum changes). This is
  expected and correct.
- **API surface parity:** The CLI local deploy passthrough and workflow secrets schema must be
  extended together. A secret wired in `deploy.ts` but missing from the workflow schema causes a
  silent CI-path failure (the class of failure documented in the Caddy announce ingress solution).
- **No dashboard changes:** The dashboard Caddy `/operator/*` reverse proxy and private
  dashboard→gateway path are out of scope for this plan and remain blocked until the private path
  task (`docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`) prerequisites are
  met. The upstream auth contract being released does not unblock that path.

---

## Rollback Path

If operator auth/config wiring needs to be disabled after deployment:

1. Remove or clear **both** the listener trio **and** the four auth/config secrets from the
   `gateway` GitHub Environment:
   - Listener trio: `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`,
     `GATEWAY_OPERATOR_PUBLIC_ORIGIN`
   - Auth/config secrets: `GATEWAY_OPERATOR_GITHUB_CLIENT_ID`,
     `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`, `GATEWAY_OPERATOR_CSRF_SECRET`,
     `GATEWAY_OPERATOR_ALLOWLIST`
2. Trigger a gateway deploy: `bunx @marcusrbrown/infra gateway deploy`.
3. Approve the environment gate.
4. The deploy detects `getOperatorState` returns `'disabled'` (listener trio absent), skips all
   operator auth/config wiring, and runs `docker compose up --remove-orphans`.
5. The gateway restarts with the operator listener disabled. All active operator sessions are
   invalidated (v1 in-memory — no data rollback needed).
6. Verify: `bunx @marcusrbrown/infra gateway status` shows all services healthy.

**Note:** Listener trio present + auth/config secrets absent is not a valid state — `main()` will
fail with an `'invalid'` auth state error. The only supported rollback is to clear **both** the
listener trio and the four auth/config secrets together. This disables the operator listener
entirely; the gateway continues to serve all other routes normally.

---

## Post-Enable Manual Verification

After the first deploy with operator auth/config wiring:

1. **Gateway-side health probe:** Verify the operator listener is up using the currently deployed
   gateway Caddy route:
   ```
   GET https://gateway.fro.bot/operator/health
   ```
   This route is already live from `infra#579`; confirm it returns 200 after the auth-wired
   restart. Alternatively, probe the listener directly from the droplet:
   ```bash
   curl -sf http://172.21.0.2:9300/operator/health
   ```
   (The `172.21.0.2:9300` address is the gateway-net-internal operator listener; use this if the
   public gateway Caddy route is intentionally not exposed for this probe.)

    **⚠ Liveness probe warning:** Do **not** use `https://dashboard.fro.bot/operator/health` or
    any `https://dashboard.fro.bot/operator/*` URL as a liveness probe at this stage. The
    dashboard Caddy `/operator/*` reverse proxy and private dashboard→gateway path are out of scope
    for this plan and remain deferred to
    `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`. Use
    `https://gateway.fro.bot/operator/health` (public gateway Caddy route) or
    `http://172.21.0.2:9300/operator/health` (droplet-local gateway-net probe) for gateway-side
    liveness verification. The OAuth callback URL registration uses the dashboard origin
    (`https://dashboard.fro.bot/operator/auth/github/callback`) — this is a GitHub OAuth App
    setting, not a live HTTP probe target. Do not use dashboard-origin URLs as liveness probes
    until the private path task lands.

2. **Auth gate coarse check:** `GET https://gateway.fro.bot/operator/` (or any non-health
   operator path via the gateway Caddy route) should return a non-5xx, non-404 response — likely
   a redirect to the GitHub OAuth flow or a structured auth-required response. The exact response
   shape depends on upstream routing; the goal is to confirm the auth gate is active and not
   crashing the gateway.

3. **Callback URL preflight:** Before triggering the OAuth flow, verify the expected callback URL
   string. The deploy dry-run output (or validation helper) prints:
   ```
   Expected OAuth callback URL: https://dashboard.fro.bot/operator/auth/github/callback
   ```
   Cross-check this string against the **Authorization callback URL** field in the GitHub OAuth
   App settings (GitHub Developer Portal → OAuth Apps → your app). Infra cannot read or validate
   the OAuth App callback registration via API — no public GitHub API surface exposes this field.
   The portal check is manual and must be completed before enablement. Once confirmed, navigate to
   the GitHub OAuth authorization URL for the configured OAuth App and confirm the redirect returns
   to `https://dashboard.fro.bot/operator/auth/github/callback` with the expected `code` and
   `state` parameters. Do not automate the full OAuth flow in CI; this is a manual browser
   verification.

4. **Allowlist enforcement:** Attempt to complete the OAuth flow with a GitHub account that is
   NOT in the allowlist. Confirm the response is a coarse auth-failure (non-5xx, no route or
   allowlist detail leaked). Do not overpromise automation of this check.

5. **Session invalidation on restart:** After a successful auth, trigger a gateway restart
   (`docker compose restart gateway` on the droplet). Confirm the session is invalidated and
   re-authentication is required.

6. **No host-published operator port:** `docker compose ps` on the gateway droplet must not show
   a `9300->9300` mapping. The operator listener remains on `gateway-net` only.

---

## Risks & Dependencies

| Risk | Mitigation |
| ---- | ---------- |
| Implementation-time drift if the target tag advances beyond v0.69.0 | Unit 1 re-diffs `packages/gateway/src/config.ts` at the chosen target ref before implementation; required≡wired gate test catches any gap introduced by a later tag |
| Auth/config secret partially set in GitHub Environment | `getOperatorAuthState` returns `'invalid'`; `main()` throws before SSH/spawn; deploy fails closed |
| CSRF secret fails base64url validation at runtime | `validateOperatorAuthConfig` catches this pre-deploy; upstream loader also validates at startup |
| Allowlist empty or malformed | `validateOperatorAuthConfig` catches this pre-deploy; upstream loader is fail-closed |
| Session invalidated by routine deploy | Known v0.69.0 limitation; documented in runbook; operators must re-authenticate after each deploy |
| Callback URL misconfigured in GitHub OAuth App settings | Deploy dry-run prints expected callback URL for manual cross-check against portal; infra cannot read OAuth App callback settings via API — portal check is required before enablement |
| Auth/config secret wired in deploy.ts but missing from workflow schema | Convention test in Unit 5 catches this; mirrors the Caddy announce ingress lesson |
| Dashboard Caddy `/operator/*` route deployed before auth wiring lands | Gated by `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` prerequisites |

---

## Documentation / Operational Notes

### GitHub OAuth App Setup

Before enabling operator auth, create a GitHub OAuth App (not a GitHub App) in the GitHub
Developer Portal. This is a separate credential from the existing gateway GitHub App
(`GH_APP_ID`); do not conflate them.

- **Application name:** `fro-bot operator` (or similar)
- **Homepage URL:** `https://dashboard.fro.bot`
- **Authorization callback URL:** `https://dashboard.fro.bot/operator/auth/github/callback`

Copy the client ID. Generate a client secret. Seed both into the `gateway` GitHub Environment
as described in the runbook.

### Secret Seeding Convention

All four auth/config secrets must be seeded via stdin pipe — never via `--body` substitution or
shell here-strings. See `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`
for the corruption risk. Example pattern:

```bash
printf '%s' '<value>' | gh secret set --env gateway GATEWAY_OPERATOR_GITHUB_CLIENT_ID
```

### CSRF Secret Format

The upstream loader requires a strict base64url value: no padding (`=`), no whitespace, no
newlines, and the decoded byte length must be at least 32 bytes. A 32-byte random value encoded
as base64url (no padding) produces a 43-character string. Generation example (replace with the
command from upstream docs if one is provided):

```bash
# Generic example — verify against upstream docs before use
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Never commit or log the output. Seed directly via stdin pipe.

### Allowlist Format

The allowlist is a newline-separated list of numeric GitHub user IDs. Obtain user IDs via the
GitHub API (`GET /users/{username}` → `.id` field). Example format:

```
12345678
87654321
```

The upstream loader is fail-closed: a missing, empty, or malformed allowlist prevents the
operator web surface from starting.

### Current Production State

The operator listener trio is enabled in production (`GATEWAY_OPERATOR_BIND_HOST=172.21.0.2`,
`GATEWAY_OPERATOR_BIND_PORT=9300`, `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot`).
The current public operator surface is `GET /operator/health` only. The v0.69.0 upstream release
ships browser-auth and session routes (`/operator/auth/github/start`,
`/operator/auth/github/callback`, `/operator/session/csrf`, `/operator/auth/logout`); these routes
exist in the upstream image but infra auth/config wiring (the subject of this plan) is not yet
implemented. The dashboard Caddy `/operator/*` same-origin route remains out of scope for this plan
and is deferred per `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md`.

---

## Sources & References

| Source | Role |
| ------ | ---- |
| `marcusrbrown/infra#580` | Issue: wire gateway operator auth/config secrets into deploy |
| `fro-bot/.github#3512` | Cross-repo operator feature tracker (source of truth) |
| `fro-bot/agent v0.69.0` | Upstream release containing PR #944 (auth gate) + PR #939 (session foundation) |
| `fro-bot/agent#944` | Operator browser auth gate (GitHub OAuth, CSRF, allowlist) |
| `fro-bot/agent#939` | Session foundation (v1 in-memory sessions) |
| `marcusrbrown/infra#579` | Gateway operator listener topology — completed |
| `docs/plans/2026-06-17-001-feat-gateway-operator-listener-topology-plan.md` | Listener topology plan (completed) |
| `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` | Same-origin ratification plan; dashboard Caddy route prerequisites |
| `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` | Required≡wired invariant; daemon loader vs compose wiring |
| `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` | SSH stdin secret seeding; no `--body` substitution |
| `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md` | Caddy `handle` blocks; wire secrets through every entry point |
| `docs/solutions/integration-issues/docker-network-stale-subnet-cleanup-2026-06-18.md` | Deploy sequencing; pull before cleanup |
| `docs/runbooks/discord-token-lifecycle.md` | Rotation/runbook precedent; secret file storage pattern |
| `apps/gateway/src/deploy.ts` | `buildSecretFileList`, `buildComposeOverride`, `getOperatorState`, `validateOperatorConfig`, `computeSecretsChecksum`, `writeRemoteFile`, `main` |
| `apps/gateway/src/deploy.test.ts` | Existing test patterns for override shape, Caddy routes, secret file list |
| `apps/gateway/upstream.json` | Current upstream pin (`v0.66.0`); bump to `v0.69.0` in Unit 1 if readiness gate passes |
| `.github/workflows/deploy-gateway.yaml` | `workflow_call` secret schema — extend in Unit 5 |
| `.github/workflows/deploy.yaml` | Fan-out workflow secrets pass-through — extend in Unit 5 |
| `packages/cli/src/commands/gateway/deploy.ts` | Local deploy env passthrough — extend in Unit 5 |
