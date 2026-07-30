---
title: "feat: Add operator push infra readiness"
type: feat
status: active
date: 2026-07-25
origin: docs/brainstorms/2026-07-21-gateway-operator-push-infra-readiness-requirements.md
deepened: 2026-07-25
---

# feat: Add operator push infra readiness

## Overview

Define the infra-side configuration contract for the gateway and dashboard Web Push paths as a
ready-but-off change. The gateway will accept a complete, structurally valid VAPID quartet through
the existing fail-closed preflight, SSH-stdin secret-file, `_FILE`, compose-override, and checksum
patterns. The dashboard will accept only its own explicit server-side feature flag.

Both push flags remain off in every deployed environment. This plan does not generate or seed real
VAPID keys, activate production push, run browser smoke tests, add a policy checker, or change the
upstream gateway pin (`fro-bot/agent@v0.93.1`) or the already-committed dashboard image
(`2026.07.37`). Production activation remains blocked by `fro-bot/dashboard#238`; coordination
remains tracked by `fro-bot/.github#3512`.

---

## Problem Frame

The pinned gateway already contains push sending and the authenticated `GET /operator/push/vapid-key`
route. The dashboard image already contains browser subscription code and an existing trusted
user-gesture consent flow. Infra currently supplies neither the gateway VAPID material nor the
dashboard flag, so the upstream capability is inert and has no documented readiness contract.

The gateway must distinguish exactly three states: all four inputs absent and disabled; all four
inputs present and valid and ready; or any partial/invalid state rejected before SSH, spawn, secret
materialization, or remote writes. The dashboard must remain independently disabled unless its exact
server-side flag value is explicitly `true`. Dashboard deploys must never carry VAPID material or an
endpoint pointer.

---

## Requirements Trace

| ID | Requirement preserved by this plan |
| --- | --- |
| R1 | Define `GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`, and `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION` as a named gateway contract. Materialize them with the existing SSH-stdin secret-file pattern and never through argv or logs. |
| R2 | With all four gateway inputs absent, preserve today’s behavior: no VAPID files, no derived enable signal, and inert gateway push. |
| R3 | With one, two, or three gateway inputs present, fail hard before any SSH, spawn, file materialization, or remote write, naming every missing input. |
| R4 | Only a complete quartet passing structural validation may materialize the four files and derive `GATEWAY_OPERATOR_PUSH_ENABLED=true`. |
| R5 | Keep the private key gateway-only. The dashboard receives no VAPID material; only the gateway’s authenticated `GET /operator/push/vapid-key` route exposes `publicKey` and string `keyVersion`. |
| R6 | Keep gateway push additive to the existing announce, operator-listener, and VPC gates; absent push configuration must not change them. |
| R7 | Define `DASHBOARD_OPERATOR_PUSH_ENABLED` as a separate dashboard-side flag, independently settable from the gateway state. |
| R8 | Keep the dashboard flag off by default; absent, false, or malformed input must produce the current disabled behavior. |
| R9 | Limit dashboard push configuration to the flag. Never pass, store, or materialize VAPID keys or an endpoint pointer in dashboard-bound config. |
| R10 | Document that the dashboard flag alone does not prompt or subscribe. Existing consent and trusted user-gesture flow owns runtime fetching of the public key; a disabled/guard-denied gateway route remains a disabled result. |
| R11 | Make future push activation a configuration-only operation, without new push deploy logic, assuming the existing `fro-bot/agent@v0.93.1` object-store baseline remains healthy. |
| R12 | Make gateway and dashboard activation independently actionable while documenting that real end-to-end push also requires both sides and the `fro-bot/dashboard#238` privacy-policy prerequisite. Do not add a policy URL checker. |
| R13 | Add tests for disabled, partial, malformed, valid, secret-boundary, checksum/recreate, dashboard flag, and existing-gate regression behavior using bounded non-production fixtures only. |
| R14 | Update `apps/gateway/AGENTS.md`, `apps/dashboard/AGENTS.md`, and root `AGENTS.md` with names, defaults, validation, route, blocker, and operational boundaries. |

---

## Scope Boundaries

In scope:

- Gateway preflight and all-or-none validation for the current VAPID quartet.
- Gateway secret-file materialization, `_FILE` compose wiring, derived enablement, and checksum
  sensitivity.
- Gateway workflow forwarding of three non-secret values as GitHub Environment variables and the
  private key as a GitHub Environment secret.
- Dashboard server-side flag wiring and workflow forwarding as a GitHub Environment variable.
- Test-first coverage, workflow contract synchronization, operator documentation, and disabled-state
  environment verification.
- Readiness against the existing gateway object-store baseline; this plan does not change required S3
  credentials, bucket/region inputs, `OBJECT_STORE_HOSTS`, or conditional-write/self-test behavior.

Out of scope:

- Real VAPID key generation, seeding, rotation, or production activation.
- Any change to `fro-bot/agent@v0.93.1` or the committed dashboard image `2026.07.37`.
- Browser permission, consent, subscribe, publish, delivery, or notification smoke tests.
- Dashboard UX or changes to the existing trusted user-gesture consent flow.
- Caddy changes; existing wildcard same-origin `/operator/*` routing is sufficient.
- A deploy-time policy checker or any implementation of `fro-bot/dashboard#238`.
- Optional previous-VAPID-key rotation and dedupe-window tuning.
- A new generic configuration abstraction.
- A changeset; the CLI user-facing surface is unchanged.

### Deferred to Separate Tasks

| Deferred item | Reason or tracking |
| --- | --- |
| Production activation and real key seeding | Requires explicit operator action, both flags, and `fro-bot/dashboard#238`. |
| Public privacy-policy route and consent-link prerequisite | `fro-bot/dashboard#238` remains OPEN. |
| Cross-repository rollout coordination | `fro-bot/.github#3512` remains OPEN. |
| Previous VAPID key rotation | Separate activation/rotation work. |
| Push dedupe-window tuning | Separate runtime tuning work. |
| Browser-visible push verification | Deferred until activation prerequisites are complete. |

---

## Context & Research

### Repository patterns

- `apps/gateway/src/deploy.ts` already has `getAnnounceState` and `getOperatorState` all-or-none
  gates, `buildSecretFileList`, `buildComposeOverride`, `computeSecretsChecksum`, `writeRemoteFile`,
  and pre-SSH validation in `main`.
- Gateway secret bytes already travel through SSH stdin only. Compose wiring uses infra-owned host
  file names, read-only bind mounts, and upstream-compatible `_FILE` variables.
- Existing gateway tests already cover announce, operator, VPC, compose, checksum, spawn ordering,
  and secret-boundary behavior in `apps/gateway/src/deploy.test.ts`.
- `apps/dashboard/src/deploy.ts` builds the remote environment file through
  `buildEnvFileContents`; `apps/dashboard/src/deploy.test.ts` already covers environment rendering,
  validation, spawn ordering, and secret boundaries.
- `.github/workflows/deploy-gateway.yaml` and `.github/workflows/deploy-dashboard.yaml` bind their
  respective GitHub Environments at deploy time. Existing repository convention assertions live in
  `packages/cli/src/conventions.test.ts`.

### Confirmed upstream contracts

- The current gateway quartet is exactly `GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`,
  `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`, and
  `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION`.
- The runtime supports generic `${NAME}_FILE`; infra owns concrete file names and compose mounts.
- `GATEWAY_OPERATOR_PUSH_ENABLED` accepts exact `true` or `false`, with unset meaning disabled. Infra
  derives and emits `true` only from a complete valid quartet, emits no independent operator-set flag,
  and leaves the disabled state unset.
- The public key must be strict unpadded base64url, decode to 65 bytes, and begin with `0x04`. The
  private key must be strict unpadded base64url and decode to 32 bytes.
- The subject must be nonblank and either a `mailto:` or `https:` URL. The key version must be a
  positive integer string; zero, negative, float, and nonnumeric values are invalid.
- `GET /operator/push/vapid-key` already exists behind the authenticated same-origin operator route.
  It is 404 when disabled or guard-denied and returns only `publicKey` and string `keyVersion` when
  enabled.
- `DASHBOARD_OPERATOR_PUSH_ENABLED` is server-side. Absent or malformed input is disabled; exact
  `true` enables the browser capability metadata and existing CTA without auto-prompting. The
  existing consent flow and trusted user gesture own subscription.

### Pin and environment baseline

- `apps/gateway/upstream.json` is already pinned to `v0.93.1`; implementation must not advance or
  downgrade it.
- `apps/dashboard/docker-compose.yaml` is already the source of truth for image `2026.07.37`. That
  monthly release serial is the current committed source-of-truth pin as of 2026-07-30;
  implementation must not bump, revert, or reinterpret it.
- All new gateway VAPID values and the dashboard flag are absent by default. The private VAPID key is
  a GitHub Environment secret; public key, subject, key version, and dashboard flag are GitHub
  Environment variables.

---

## Key Technical Decisions

1. Extend the existing gateway preflight, all-or-none validation, and SSH-stdin secret-file
   patterns. Do not introduce a generic configuration framework.
2. Validate push state before any SSH, spawn, file materialization, or remote write. Partial or
   malformed input must leave no partial remote state.
3. Keep `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY` as a GitHub Environment secret. Keep the public
   key, subject, key version, and dashboard flag as GitHub Environment variables, all absent by
   default. Do not add an independently operator-set `GATEWAY_OPERATOR_PUSH_ENABLED` input.
4. Use `_FILE` for all four VAPID values in the gateway compose override. Use concrete infra-owned
   kebab-case host files and matching run-secrets container targets. Do not introduce a push-specific
   checksum: adding the four files to the secret list and push lines to the rendered override feeds
   the existing checksum input path so key or wiring changes force recreation.
5. Write `DASHBOARD_OPERATOR_PUSH_ENABLED=true` only when the dashboard input is exactly `true`.
   Omit it for absent, false, or malformed input. Never forward VAPID material or an endpoint pointer
   to the dashboard.
6. Make no Caddy change. The browser-visible boundary remains
   `https://dashboard.fro.bot/operator/*`, which proxies over `GATEWAY_VPC_IP:9300`.
   `gateway.fro.bot/operator/*` is topology scaffolding, not the production browser origin.
7. Add no changeset because no CLI command, option, or published user-facing surface changes.
8. Every behavior-bearing implementation unit begins with failing tests or contract assertions
   before implementation edits.
9. Treat push activation as configuration-only while the existing `fro-bot/agent@v0.93.1`
   object-store baseline remains healthy: required S3 credentials, bucket, region,
   `OBJECT_STORE_HOSTS`, and conditional-write/self-test behavior remain prerequisites and are not
   changed here.

### Gateway file and compose naming

The four infra-owned host files are:

- `gateway-operator-push-vapid-public-key`
- `gateway-operator-push-vapid-private-key`
- `gateway-operator-push-vapid-subject`
- `gateway-operator-push-vapid-key-version`

The compose override maps the corresponding runtime variables to read-only file-backed targets
under the existing run-secrets convention. The override also derives
`GATEWAY_OPERATOR_PUSH_ENABLED=true` only in the valid enabled state.

### Config-mode decision matrix

| Mode | Gateway preflight | Gateway files / flag | Dashboard result |
| --- | --- | --- | --- |
| M1. Quartet absent | Disabled | No VAPID files; no derived enable line | Absent, false, or malformed dashboard flag remains omitted/disabled |
| M2. One to three quartet inputs | Hard fail; name all missing inputs before SSH/spawn | Nothing materialized; no flag | No dashboard work is implied |
| M3. Four inputs present but malformed | Hard fail with the specific format error before SSH/spawn | Nothing materialized; no flag | No dashboard work is implied |
| M4. Four inputs valid | Ready state | Four read-only files, four `_FILE` mappings, derived `true`; checksum changes with content or wiring | Dashboard remains independent |
| M5. Dashboard input exactly `true` | Independent dashboard mode | No gateway VAPID values involved | Only `DASHBOARD_OPERATOR_PUSH_ENABLED=true`; no prompt or subscription is triggered |

---

## Open Questions

### Resolved During Planning

- Which upstream VAPID names are authoritative? Resolved: the current four-name quartet listed above.
- Should gateway enablement be independently operator-set? Resolved: no; derive `true` only from a
  complete valid quartet and leave the disabled state unset.
- Should public key or endpoint configuration be carried by dashboard deploy? Resolved: no; the
  existing authenticated gateway route is the runtime source for public key data.
- Should Caddy or same-origin routing change? Resolved: no; the existing wildcard route is enough.
- Should the dashboard image pin change? Resolved: no; retain the already-committed `2026.07.37`
  source of truth.
- How is `DASHBOARD_OPERATOR_PUSH_ENABLED` resolved? Resolved: it is a dashboard Environment
  variable, forwarded only to the deploy step, rendered only for exact `true`, excluded from secrets
  and required-secret validation, and independent of VAPID and gateway state.
- Where do workflow contract assertions belong? Resolved: `packages/cli/src/conventions.test.ts`
  already parses these workflow contracts and owns the explicit assertions; no new workflow-specific
  test path is needed.

### Deferred to Implementation or Separate Activation Work

- Previous-key rotation, key-generation lifecycle, and dedupe-window tuning remain activation and
  rotation concerns.
- Runtime route, browser consent, subscription, and notification delivery verification remain
  deferred until `fro-bot/dashboard#238` is resolved and activation is explicitly approved.

---

## Implementation Units

The units are dependency-ordered. Each behavior-bearing unit is test-first: add the failing
behavioral assertions before changing implementation or workflow wiring.

- [ ] **Unit 1: Gateway preflight validation + secret-file/compose wiring**

  **Goal:** Add the gateway VAPID quartet state machine, structural validation, four secret files,
  `_FILE` compose wiring, derived gateway enablement, and checksum/recreate sensitivity without
  disturbing announce, operator-listener, or VPC gates.

  **Requirements:** R1, R2, R3, R4, R5, R6, R11, R13.

  **Dependencies:** Existing `fro-bot/agent@v0.93.1` contract and current gateway deploy patterns.

  **Files:**
  - `apps/gateway/src/deploy.ts`
  - `apps/gateway/src/deploy.test.ts`

  **Approach:**
  - **Test-first execution signal:** add the failing gateway state, validation, materialization, and
    checksum assertions before implementation edits.
  - Extend the existing explicit state-helper pattern for the four quartet inputs: all absent is
    disabled, all present is eligible for validation, and every partial cardinality is invalid.
  - Run quartet state and format validation in `main` before any spawn or SSH operation. Partial
    errors must list every missing variable; malformed errors must identify the offending contract.
  - Validate strict unpadded base64url and decoded lengths/prefixes for both keys, subject scheme and
    nonblank value, and positive-integer version syntax.
  - Add the four concrete file names to `buildSecretFileList` only after validation succeeds.
  - Extend `buildComposeOverride` with four read-only `_FILE` mappings and the derived true flag only
    in the valid enabled state. Do not emit a false or independently supplied gateway flag.
  - Keep the existing checksum input path authoritative; the quartet files and rendered override
    must participate so key, enablement, mount, or mapping changes force recreation. No push-specific
    checksum is introduced.
  - Define the enabled-to-absent transition explicitly: after preflight and before current secret
    materialization, run a bounded idempotent cleanup that deletes exactly the four known VAPID files
    under the infra-owned secrets directory (no wildcard cleanup), omit their `_FILE` and enabled
    lines from the new override, and let the existing checksum/recreate path restart the container
    disabled. The ordinary never-enabled all-absent deploy remains the current no-file,
    no-push-wiring path.
  - Preserve current announce/operator/VPC validation ordering and rendered-config gates.

  **Test file:** `apps/gateway/src/deploy.test.ts`.

  **Test scenarios:**
  - `Input:` all four quartet values absent. `Action:` call the gateway state/helper and validation
    path. `Expected:` preflight classifies push as disabled, adds no VAPID secret files or push
    override fields, and introduces no push-specific spawn/write; the ordinary existing deploy flow
    remains eligible.
  - `Input:` each non-empty proper subset of the four inputs, covering all 14 combinations (4
    one-input + 6 two-input + 4 three-input). `Action:` run preflight. `Expected:` hard failure
    before spawn or SSH, with every missing input named and no VAPID file materialized.
  - `Input:` malformed public key containing padding or invalid base64url, wrong decoded length, or
    a first byte other than `0x04`. `Action:` run validation. `Expected:` specific rejection before
    any remote action.
  - `Input:` malformed private key containing padding or invalid base64url, or a decoded length other
    than 32 bytes. `Action:` run validation. `Expected:` specific rejection before any remote action.
  - `Input:` blank, non-`mailto:`, or non-`https:` subject. `Action:` run validation. `Expected:`
    rejection before any remote action.
  - `Input:` version `0`, negative, floating-point, nonnumeric, or otherwise non-positive integer
    string. `Action:` run validation. `Expected:` rejection before any remote action.
  - `Input:` a complete structurally valid non-production quartet. `Action:` render secret list and
    compose override, then compare checksums after changing each value and the rendered wiring.
    `Expected:` four files, four `_FILE` mappings, derived `true`, and checksum changes that select
    the existing recreate path.
  - `Input:` valid private-key fixture. `Action:` inspect mocked spawn argv, captured logs, dashboard
    artifacts, and rendered config. `Expected:` the private value appears only in gateway secret-file
    stdin materialization and never in argv, logs, or dashboard-bound artifacts.
  - `Input:` a previously enabled deploy state followed by an absent quartet. `Action:` run the
    ordinary deploy transition and inspect the secret list, rendered override, checksum inputs, and
    spawn ordering. `Expected:` one bounded cleanup deletes exactly the four known stale VAPID paths
    before current secret materialization and compose-up, the override no longer references them or
    emits `_FILE`/enabled lines, the existing checksum changes, ordinary deploy recreates the gateway
    disabled, and the push route remains unmounted by upstream.
  - `Input:` existing announce, operator-listener, and VPC gate fixtures with push absent and with
    push valid. `Action:` run existing regression assertions. `Expected:` those gates retain their
    current behavior and push remains additive.

  **Verification:** Gateway tests cover every mode and boundary; checksum assertions prove recreate
  sensitivity; no implementation test uses production key material.

- [ ] **Unit 2: Gateway workflow forwarding and contract synchronization**

  **Goal:** Forward the three non-secret gateway values from GitHub Environment `vars`, the private
  VAPID key from GitHub Environment `secrets`, and preserve safe all-absent behavior in the existing
  deploy workflow contract.

  **Requirements:** R1, R2, R5, R11, R13.

  **Dependencies:** Unit 1’s env names and derived-state contract.

  **Files:**
  - `.github/workflows/deploy-gateway.yaml`
  - `.github/workflows/deploy.yaml`
  - `packages/cli/src/conventions.test.ts` for the explicit workflow contract assertions; this
    existing file already parses these contracts, so no new workflow-specific test path is needed.

  **Approach:**
  - **Test-first execution signal:** add the workflow contract assertions before changing workflow
    bindings.
  - Bind `GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`, and
    `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION` from the gateway Environment `vars` context.
  - Bind only `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY` from the gateway Environment `secrets`
    context. Keep it out of any required-secret validation output and out of non-deploy workflow
    steps.
  - Declare the private key optional in the reusable workflow contract and have the aggregate router
    pass that optional secret to `deploy-gateway.yaml`. The three non-secret values must not appear in
    `workflow_call.secrets` or required-secret validation; they come only from the gateway Environment
    `vars` context.
  - Do not add an independent gateway enabled input. The workflow must not forward or validate
    `GATEWAY_OPERATOR_PUSH_ENABLED` as an operator-owned setting.
  - Use `vars` for new non-secret push metadata deliberately, even though older optional gateway
    configuration still travels through `secrets`; this keeps ownership and exposure explicit without
    widening the older contract.
  - Preserve the current `environment: gateway` binding and optional-input convention so all absent
    values remain safe and the deploy derives disabled state from the quartet rather than a separate
    workflow flag.
  - Keep SHA-pinned action conventions and avoid adding a changeset or CLI command surface.

  **Test file:** `packages/cli/src/conventions.test.ts`.

  **Test scenarios:**
  - `Input:` all three gateway `vars` absent and private secret absent. `Action:` inspect the deploy
    step environment contract. `Expected:` empty/unset values reach the existing deploy path safely;
    Unit 1 derives disabled and performs no push materialization.
  - `Input:` the three non-secret values present and private key absent. `Action:` inspect workflow
    forwarding and execute preflight with the resulting environment. `Expected:` the missing private
    key is named and the deploy fails before spawn; no secret value is logged.
  - `Input:` complete values in the correct `vars`/`secrets` contexts. `Action:` inspect the workflow
    contract. `Expected:` public key, subject, and version come from `vars`; private key comes from
    `secrets`; no gateway enabled flag is independently forwarded.
  - `Input:` reusable and aggregate workflow definitions. `Action:` parse both workflow contracts.
    `Expected:` `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY` is optional in the reusable workflow and is
    forwarded by the aggregate router; the private key appears only in `secrets` bindings.
  - `Input:` gateway workflow definitions with the three non-secret values and the dashboard workflow
    definition with `DASHBOARD_OPERATOR_PUSH_ENABLED`. `Action:` inspect `workflow_call.secrets`,
    required-secret validation, and deploy-step bindings. `Expected:` public key, subject, and version
    are only from gateway `vars`; the dashboard flag is only from dashboard `vars`, optional, and
    absent from secrets and required-secret validation; no independent gateway enabled input exists.
  - `Input:` existing announce, operator, VPC, and image-digest workflow bindings. `Action:` run the
    existing convention assertions alongside the new contract assertions. `Expected:` prior
    forwarding remains unchanged and no required-secret validation step gains VAPID output.

  **Verification:** The explicit reusable-workflow, aggregate-router, `vars`/`secrets`, and
  no-independent-enable assertions pass in `packages/cli/src/conventions.test.ts`. The private key is
  never rendered in logs or non-deploy artifacts.

- [ ] **Unit 3: Dashboard flag deploy/workflow wiring**

  **Goal:** Add the independently controlled dashboard server-side flag while keeping the dashboard
  default-off behavior and ensuring no VAPID material or endpoint configuration crosses the service
  boundary.

  **Requirements:** R7, R8, R9, R10, R11, R13.

  **Dependencies:** Unit 1’s gateway contract is documented; no dashboard VAPID dependency exists.

  **Files:**
  - `apps/dashboard/src/deploy.ts`
  - `apps/dashboard/src/deploy.test.ts`
  - `.github/workflows/deploy-dashboard.yaml`

  **Approach:**
  - **Test-first execution signal:** add the failing dashboard env-rendering and boundary assertions
    before implementation edits.
  - Read `DASHBOARD_OPERATOR_PUSH_ENABLED` as an optional server-side input and write exactly one
    line, `DASHBOARD_OPERATOR_PUSH_ENABLED=true`, only for the exact enabled value.
  - Omit the line for absent, false, whitespace-variant, malformed, or any other non-exact value so
    the image’s existing disabled behavior remains the default.
  - Forward the flag from the dashboard Environment `vars` context in the existing deploy step; do
    not declare it as a secret and do not add VAPID values or an endpoint pointer.
  - Leave `apps/dashboard/docker-compose.yaml` pinned to `2026.07.37`; no image or Caddy change is
    part of this unit.
  - Preserve the existing consent and trusted user-gesture flow. The flag must not auto-prompt or
    auto-subscribe.

  **Test file:** `apps/dashboard/src/deploy.test.ts`.

  **Test scenarios:**
  - `Input:` dashboard flag absent. `Action:` build the remote environment file. `Expected:` no
    push flag line and no VAPID key or endpoint configuration.
  - `Input:` dashboard flag `false` or malformed, including whitespace-variant or non-boolean text.
    `Action:` build the remote environment file. `Expected:` flag omitted and dashboard remains
    disabled.
  - `Input:` dashboard flag exactly `true`. `Action:` build the remote environment file and inspect
    workflow forwarding. `Expected:` only `DASHBOARD_OPERATOR_PUSH_ENABLED=true` is added; no public
    key, private key, VAPID quartet, or endpoint pointer is present.
  - `Input:` gateway VAPID values present in a separate gateway environment. `Action:` deploy the
    dashboard path. `Expected:` dashboard output remains unchanged except for its own explicit flag;
    no VAPID value is read or forwarded.
  - `Input:` existing dashboard required secrets, VPC value, image digest, and health-flow fixtures.
    `Action:` run existing deploy tests. `Expected:` current SSH, digest, health, and same-origin
    route behavior remains unchanged.

  **Verification:** Dashboard tests prove absent/false/malformed disabled behavior, exact-true
  rendering, and the absence of VAPID material. Workflow inspection proves the flag comes from `vars`.

- [ ] **Unit 4: Operator docs and disabled-state integration verification**

  **Goal:** Document the ready-but-off contract and verify that configured production/repository
  Environment state remains absent or disabled without exposing secret values.

  **Requirements:** R2, R5, R6, R7, R8, R9, R10, R12, R14.

  **Dependencies:** Units 1–3 for final names, rendered behavior, workflow contexts, and test evidence.

  **Files:**
  - `apps/gateway/AGENTS.md`
  - `apps/dashboard/AGENTS.md`
  - `AGENTS.md`

  **Approach:**
  - Document the gateway quartet, concrete file names, `_FILE` contract, derived enablement, strict
    validation, hard-fail ordering, checksum/recreate behavior, private-key boundary, route response,
    existing announce/operator/VPC gates, and disabled rollback posture.
  - Document the dashboard flag’s exact-true semantics, default-off behavior, no-VAPID boundary,
    runtime public-key route, no-auto-prompt consent rule, and independent activation requirement.
  - Record that `fro-bot/dashboard#238` and `fro-bot/.github#3512` remain OPEN, that both flags stay
    off, that no real keys are generated or seeded, and that previous-key rotation and dedupe tuning
    are deferred.
  - Update root Environment tables with variable-versus-secret ownership while never recording actual
    values.
  - Verify state using names/status metadata only: gateway VAPID secret and variable names remain
    absent, no independently forwarded gateway enabled setting exists, and the dashboard push variable
    remains absent or false. There is no GitHub-stored derived gateway flag to inspect. Do not print,
    copy, or compare secret contents.
  - Before approving the first post-merge gateway or dashboard deploy, inspect Environment names and
    status only and verify every new value remains absent or off. After deployment, repeat the
    names-only audit and use rendered-config and automated-test evidence; do not retrieve or print
    secret values.

  **Verification references:** `apps/gateway/src/deploy.test.ts` and
  `apps/dashboard/src/deploy.test.ts` provide the automated disabled-state evidence; the Environment
  inspection is a value-redacted operational check, not a browser or production push test.

  **Test scenarios:**
  - `Input:` names-only gateway Environment metadata. `Action:` inspect configured secret/variable
    names without retrieving values. `Expected:` the VAPID quartet is absent and no independently
    forwarded gateway push enablement setting exists.
  - `Input:` names-only dashboard Environment metadata. `Action:` inspect the push variable state
    without retrieving values. `Expected:` `DASHBOARD_OPERATOR_PUSH_ENABLED` is absent or explicitly
    disabled.
  - `Input:` documentation and test evidence. `Action:` compare the three AGENTS documents with the
    Unit 1 and Unit 3 assertions. `Expected:` defaults, blocker, deferred rotation/tuning, route
    semantics, and no-secret boundary agree without exposing values.

  **Verification:** Documentation matches the implemented contract; production/repository Environment
  state remains off or absent; no browser smoke, activation, key generation, policy checker, or secret
  value inspection is performed.

---

## System-Wide Impact

- **Deploy preflight:** Gateway push validation runs before SSH, spawn, secret-file creation, compose
  rendering, or any remote write. A partial or malformed quartet cannot leave partial remote state.
- **Disabled rollback:** When a previously enabled gateway deploy is followed by an absent quartet, the
  deploy deletes exactly the four known stale VAPID files through a bounded idempotent cleanup before
  current secret materialization and compose-up, omits their `_FILE` and enabled lines, changes the
  existing checksum, and recreates the gateway disabled. A never-enabled all-absent deploy retains the
  ordinary no-file path.
- **Workflow Environment contracts:** Gateway public key, subject, and version are non-secret `vars`;
  gateway private key is a `secret`; dashboard push is a non-secret `var`. New non-secret push
  metadata intentionally uses `vars`, even though older optional gateway configuration still uses
  `secrets`. Absence remains the safe disabled state. No independently forwarded gateway enable flag
  exists.
- **Container recreation:** No push-specific checksum is introduced. Gateway quartet files and
  rendered compose wiring feed the existing checksum input path, so key, wiring, and enabled-to-absent
  transitions select the existing force-recreate path. Dashboard flag changes update only the
  dashboard `.env`; they do not change the image pin, GitHub App key file, Caddy topology, or gateway
  VAPID state.
- **Same-origin route:** The browser-visible boundary remains
  `https://dashboard.fro.bot/operator/*`, with dashboard Caddy proxying over `GATEWAY_VPC_IP:9300`.
  `gateway.fro.bot/operator/*` is not the production browser origin. Existing wildcard routing remains
  unchanged; no Caddy or DNS change is needed.
- **Object-store prerequisite:** Configuration-only push activation assumes the existing
  `fro-bot/agent@v0.93.1` object-store baseline remains healthy, including required S3 credentials,
  bucket/region, `OBJECT_STORE_HOSTS`, and conditional-write/self-test behavior. This plan does not
  change that baseline.
- **Runtime verification:** Route behavior, consent, subscription, delivery, and browser verification
  remain deferred. This plan verifies readiness code paths and disabled state only.
- **CLI and release surface:** No command, option, or published package behavior changes; no changeset
  is required.

---

## Risks & Dependencies

| Risk or dependency | Mitigation |
| --- | --- |
| Workflow/code drift between variable names, contexts, and deploy inputs | Keep the quartet and dashboard names explicit in code and workflow assertions; use existing convention coverage where it owns the assertion. |
| Accidental VAPID private-key leakage | Keep the private value in a GitHub Environment secret, materialize through SSH stdin, emit only `_FILE` paths, inspect argv/log/dashboard artifacts in tests, and never pass it to dashboard. |
| False activation assumptions | Derive gateway `true` only from a complete valid quartet, keep dashboard independently off, document that both flags plus the privacy-policy prerequisite are required, and verify Environment state without values. |
| Stale VAPID files survive a previously enabled deployment | Treat enabled-to-absent as an explicit rollback transition: delete exactly the four known VAPID files with a bounded idempotent cleanup before current secret materialization and compose-up, omit their override references, and prove the existing checksum/recreate path disables the container. |
| Future upstream contract drift | Keep the gateway pinned to `v0.93.1`, preserve exact current quartet/route assumptions in tests and docs, and require a new contract review before any pin change. |
| Dashboard image pin | Treat `2026.07.37` as the current already-committed image source of truth as of 2026-07-30; do not bump, revert, or reinterpret the pin in this work. |
| Existing object-store baseline is unhealthy when activation is attempted | Treat required S3 credentials, bucket/region, `OBJECT_STORE_HOSTS`, and conditional-write/self-test health as activation prerequisites; this plan does not alter or mask those gates. |
| Existing announce/operator/VPC behavior regresses | Extend existing gates rather than abstracting them; retain focused regression scenarios in `apps/gateway/src/deploy.test.ts`. |
| Dashboard flag is mistaken for a consent or delivery guarantee | Document server-side-only flag semantics, no auto-prompt behavior, trusted user gesture ownership, and deferred browser verification. |
| Activation starts before privacy-policy work lands | Keep `fro-bot/dashboard#238` as an explicit hard blocker in both operator docs and Environment verification notes. |

---

## Documentation / Operational Notes

- The default operational state after implementation is unchanged: gateway quartet absent, gateway
  push unset/disabled, dashboard push variable absent/disabled.
- Future gateway activation requires a complete current quartet with valid public/private key formats,
  valid subject, positive key version, and a healthy existing object-store baseline. The deploy derives
  the gateway enable flag; operators do not set it independently.
- Future dashboard-side enablement requires only its exact server-side flag. It does not accept VAPID
  values, an endpoint pointer, or a browser subscription instruction; end-to-end activation still
  requires the separate prerequisites below.
- The authenticated `GET /operator/push/vapid-key` route returns only the public key and string key
  version when enabled and is 404 when disabled or guard-denied.
- Do not generate, seed, print, rotate, or copy real VAPID values as part of this readiness work.
- Do not run browser push smoke, production activation, a policy checker, or runtime notification
  delivery verification. Those belong after `fro-bot/dashboard#238` and separate activation approval.
- Previous-key rotation and dedupe-window tuning are deliberately absent from this plan and require
  separate activation/rotation tasks.

### Activation prerequisites documented now, not executed

- `fro-bot/dashboard#238` ships and verifies a public unauthenticated privacy-policy route and consent
  link.
- `fro-bot/.github#3512` is updated with the readiness result and remaining activation status.
- The existing `fro-bot/agent@v0.93.1` object-store baseline is healthy: required S3 credentials,
  bucket/region, `OBJECT_STORE_HOSTS`, and conditional-write/self-test behavior remain sound.
- Approved VAPID material is generated outside this work; the gateway quartet is configured atomically,
  with the private key stored only as the gateway Environment secret.
- A healthy gateway ready-state deploy is completed before the dashboard Environment variable is set
  to exact `true`.
- Browser consent, subscription, delivery, and notification smoke remain activation-phase work.

### Approval sequencing

Before approving the first post-merge gateway or dashboard deploys, inspect Environment names and
status only and verify the new values remain absent or off. After deployment, repeat the names-only
audit and compare the rendered-config and automated-test evidence. Never retrieve or print secret
values, and do not treat a derived gateway flag as a GitHub-stored value.

### Rollback matrix

| Situation | Rollback action | Expected result |
| --- | --- | --- |
| Readiness code rollback before activation | Revert the readiness wiring and redeploy with all new inputs absent. | Existing gateway and dashboard disabled behavior remains; no push files or flags are active. |
| Accidental dashboard variable enablement | Clear `DASHBOARD_OPERATOR_PUSH_ENABLED` and redeploy the dashboard. | Dashboard `.env` omits the flag; no VAPID or gateway state changes. |
| Accidental gateway quartet enablement | Clear all four quartet inputs and redeploy the gateway. | Exactly the four known stale VAPID files are deleted before current secret materialization and compose-up, override references disappear, the existing checksum path recreates the gateway disabled, and the push route is not exposed. |
| Partial gateway configuration | Let preflight fail before SSH, then clear the bad partial configuration before retrying. | No remote state is written and no push flag or file is materialized. |

---

## Sources & References

- `docs/brainstorms/2026-07-21-gateway-operator-push-infra-readiness-requirements.md` — reviewed
  requirements and R1–R14 source of truth.
- `apps/gateway/upstream.json` — pinned `fro-bot/agent@v0.93.1`.
- `apps/gateway/src/deploy.ts` — gateway preflight, secret files, compose override, checksum, and
  SSH-stdin patterns.
- `apps/gateway/src/deploy.test.ts` — gateway behavior, spawn-order, compose, checksum, and gate
  regression patterns.
- `apps/dashboard/src/deploy.ts` — dashboard environment-file rendering and deploy ordering.
- `apps/dashboard/src/deploy.test.ts` — dashboard flag, validation, secret-boundary, and deploy tests.
- `apps/dashboard/docker-compose.yaml` — committed dashboard image source of truth `2026.07.37`.
- `.github/workflows/deploy-gateway.yaml` — gateway reusable workflow and Environment binding.
- `.github/workflows/deploy-dashboard.yaml` — dashboard reusable workflow and Environment binding.
- `packages/cli/src/conventions.test.ts` — existing workflow contract convention suites.
- `AGENTS.md` — repository Environment and operational contract tables.
- `apps/gateway/AGENTS.md` — gateway secret, compose, operator, and SSH safety conventions.
- `apps/dashboard/AGENTS.md` — dashboard deploy, image, same-origin, and secret safety conventions.
- `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` — same-origin decision
  record and route topology precedent.
- `docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md` — private path precedent.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — SSH-stdin secret
  handling precedent.
- `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` — required-versus-
  wired contract precedent.
- `fro-bot/dashboard#238` — OPEN privacy-policy blocker.
- `fro-bot/.github#3512` — OPEN cross-repository coordination tracker.
