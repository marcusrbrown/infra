---
date: 2026-07-21
topic: gateway-operator-push-infra-readiness
---

# Gateway Operator Push Infra Readiness

## Summary

Wire the infra-side configuration contract for Web Push notifications across the gateway (`fro-bot/agent` v0.93.1) and dashboard (image `2026.07.37`), both of which already ship push code with no infra support. This is a ready-but-off pass: define how the gateway's current VAPID quartet — `GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`, `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION` — would be materialized, how the `GATEWAY_OPERATOR_PUSH_ENABLED` flag stays fail-closed (hard-failing any partial input set before materializing anything, disabled only when all four are absent), and how the separate `DASHBOARD_OPERATOR_PUSH_ENABLED` flag stays off by default while later fetching only the public key from the gateway's authenticated `GET /operator/push/vapid-key` route. No keys are generated, no secrets are seeded, and no flags are flipped in this effort — production activation is blocked on `fro-bot/dashboard#238` (public privacy-policy route) and tracked externally at `fro-bot/.github#3512`.

---

## Problem Frame

The gateway daemon and dashboard image both contain Web Push functionality already, but the infra repo (`marcusrbrown/infra`) currently supplies zero supporting configuration: no VAPID key secrets, no gateway env wiring to enable push, and no dashboard flag to turn on its half of the feature. Without this infra work, the upstream push code is inert — there is no way to enable it even in a controlled test, and no documented contract for what "enabled" requires.

Two infra gaps exist independently:

1. **Gateway**: needs a configuration contract for the VAPID quartet (`GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`, `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION`) that is fail-closed — disabled by default when all four are absent, and hard-failing the deploy before materializing any VAPID state whenever the set is partial. There is no partially-enabled or silently-degraded state: all four present and valid, or all four absent. The private key must never leave the gateway (not to dashboard, not to browser, not to logs).
2. **Dashboard**: needs its own explicit, independently-off push feature flag (`DASHBOARD_OPERATOR_PUSH_ENABLED`, default false). When later enabled, the dashboard's browser-side code fetches only the public VAPID key from the gateway's existing authenticated same-origin route (`GET /operator/push/vapid-key`) at runtime — the dashboard deploy never receives or stores private key material.

Both flags must remain off after this work ships; this doc scopes the *readiness* infra (config contract, validation, fail-closed behavior, tests, docs) without generating real VAPID keys, seeding GitHub secrets/variables, enabling push, deploying activation, or exercising a real browser push/subscribe/notify flow. A further blocker exists at the product layer: production activation cannot proceed until `fro-bot/dashboard#238` ships a public, unauthenticated privacy-policy route and consent link — required before any real user push subscription. That work, and all activation steps, are explicitly deferred.

---

## Actors

- A1. Gateway daemon (`fro-bot/agent` v0.93.1): contains push-sending code and the authenticated `GET /operator/push/vapid-key` route; today has no VAPID config supplied by infra, so its push path is unreachable/unconfigured.
- A2. Dashboard image (`2026.07.37`): contains browser push subscription/registration code; today has no infra-level flag turning it on.
- A3. Infra deploy pipelines (`apps/gateway`, `apps/dashboard`): responsible for materializing gateway VAPID secrets and setting both push flags, fail-closed, at deploy time.
- A4. Operator (Marcus): will later generate real VAPID keys, seed secrets/variables, and flip both flags — none of that happens in this effort.
- A5. Browser client (dashboard operator UI, future): will use the existing consent UI and a trusted user gesture, then fetch the public VAPID key from the gateway's authenticated route only after activation — no interaction in this effort beyond defining the contract.

---

## Key Flows

- F1. Gateway deploy with push disabled (default, today and after this work)
  - **Trigger:** Any gateway deploy where no VAPID configuration is supplied.
  - **Actors:** A1, A3.
  - **Steps:** Deploy runs with all VAPID inputs absent → deploy materializes no VAPID secrets, sets no push-enable signal → daemon starts with push inert, matching current behavior.
  - **Outcome:** Byte-for-byte compatible with pre-existing deploys; no behavior change.
  - **Covered by:** R1, R2, R6

- F2. Gateway deploy with partial VAPID material (must fail closed)
  - **Trigger:** Operator or CI supplies some but not all four required VAPID inputs (e.g., public key set, private key or subject missing).
  - **Actors:** A1, A3.
  - **Steps:** Deploy validates the VAPID input set (`GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`, `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION`) → detects incompleteness → hard-fails the deploy with a message naming the missing input(s) before materializing any VAPID secret or setting `GATEWAY_OPERATOR_PUSH_ENABLED`.
  - **Outcome:** Push is never enabled with incomplete material, and no partial VAPID state is ever materialized — a partial set always stops the deploy, it never silently disables or degrades.
  - **Covered by:** R2, R3

- F3. Gateway deploy with complete VAPID material (ready state, not exercised live in this effort)
  - **Trigger:** A complete, valid VAPID quartet is supplied.
  - **Actors:** A1, A3.
  - **Steps:** Deploy validates all four inputs present and well-formed → materializes the private key via the existing SSH-stdin secret-file pattern (never argv, never dashboard-bound) → sets `GATEWAY_OPERATOR_PUSH_ENABLED=true` → daemon starts with push capability live, serving `GET /operator/push/vapid-key`.
  - **Outcome:** Gateway is capable of sending push; this flow is defined and testable but not run against production secrets in this effort.
  - **Covered by:** R1, R3, R4, R5

- F4. Dashboard deploy with push flag off (default, today and after this work)
  - **Trigger:** Any dashboard deploy where `DASHBOARD_OPERATOR_PUSH_ENABLED` is unset/false.
  - **Actors:** A2, A3.
  - **Steps:** Deploy sets no push-related dashboard config → dashboard image's push UI/subscription code stays inert.
  - **Outcome:** No behavior change from current dashboard deploys.
  - **Covered by:** R7, R8

- F5. Dashboard deploy with push flag on (later; contract only, no live browser verification here)
  - **Trigger:** Operator sets `DASHBOARD_OPERATOR_PUSH_ENABLED=true` in a future deploy.
  - **Actors:** A2, A3, A5.
  - **Steps:** Deploy sets the dashboard push-enable flag → the flag alone does not trigger any native permission prompt or automatic subscription → a future operator uses the existing consent UI and a trusted user gesture → as part of that flow, the dashboard's browser code fetches the public VAPID key from the gateway's authenticated `GET /operator/push/vapid-key` route (a 404 is treated as push disabled; no key baked into the dashboard deploy/image/secrets) → browser subscribes using the fetched public key.
  - **Outcome:** Dashboard never holds or receives the private key at deploy time or runtime; the public key path is the only cross-service key transfer; no subscription happens without an explicit user gesture through existing consent UI. This doc still owns no dashboard UX implementation.
  - **Covered by:** R7, R9, R10

---

## Requirements

**Gateway VAPID configuration contract**
- R1. The gateway deploy defines four VAPID inputs — `GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT` (contact URI/email required by the Web Push protocol), and `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION` (a positive integer identifying the current key generation) — as a named, documented configuration set, materialized via the existing SSH-stdin secret-file pattern used for other gateway secrets (never via argv, never logged).
- R2. When all four VAPID inputs are absent, the deploy behaves identically to today: no VAPID secrets materialized, `GATEWAY_OPERATOR_PUSH_ENABLED` is not set to true, daemon push path inert. This is the default and remains the default after this work ships.
- R3. When one, two, or three (but not all four) VAPID inputs are present, the deploy treats the configuration as invalid and hard-fails before materializing any VAPID state: it must not enable push, must not materialize any VAPID secret (partial or otherwise) that leaves the daemon in an ambiguous state, and must surface a clear error naming the missing input(s) — mirroring the gateway's existing both-or-neither secret patterns (e.g., announce/presence). There is no fallback to a degraded or silently-disabled state for a partial input set; disabled behavior is preserved only when all four inputs are absent.
- R4. Only when all four VAPID inputs are present and pass basic structural validation (correct key format/length, subject is a well-formed URI or mailto, key version is a positive integer) does the deploy materialize the full VAPID secret set and set `GATEWAY_OPERATOR_PUSH_ENABLED=true`.
- R5. The VAPID private key is gateway-only: it is never passed to the dashboard deploy, never included in any artifact the dashboard consumes, never logged, and never transmitted to a browser client. Only the public key is ever exposed outside the gateway process, and only via the gateway's own authenticated same-origin route, `GET /operator/push/vapid-key`, which returns `{publicKey, keyVersion}` and nothing else (not baked into deploy-time config for other services, and not exposed via any public/unauthenticated route).
- R6. `GATEWAY_OPERATOR_PUSH_ENABLED` is independent of and additive to existing gateway feature gates (announce/presence, operator listener) — it does not alter their behavior, and its absence must not affect any other existing gateway capability.

**Dashboard push flag**
- R7. The dashboard deploy defines its own explicit push feature flag, `DASHBOARD_OPERATOR_PUSH_ENABLED`, distinct from and independently settable from `GATEWAY_OPERATOR_PUSH_ENABLED` — enabling one does not imply or require enabling the other for infra purposes (though real end-to-end push requires both).
- R8. `DASHBOARD_OPERATOR_PUSH_ENABLED` defaults to off/false; a dashboard deploy with no explicit value behaves identically to today's deploys (no push-related config surfaced, no behavior change).
- R9. The dashboard deploy never receives, stores, or materializes VAPID private key material under any flag state. Its configuration surface for push is limited to the on/off flag itself — the dashboard already knows to call the gateway's existing `GET /operator/push/vapid-key` route at runtime, so no key value or endpoint pointer is carried in dashboard-bound config.
- R10. When `DASHBOARD_OPERATOR_PUSH_ENABLED` is set (later), the documented contract is: the flag alone must not trigger a native permission prompt or automatic subscription; a future operator uses the existing consent UI and a trusted user gesture, and as part of that flow the dashboard's browser-side code fetches the public VAPID key from the gateway's authenticated `GET /operator/push/vapid-key` route at runtime (treating a 404 as push disabled). The dashboard deploy pipeline does not need to know or carry the actual public key value.

**Deploy/workflow support for future atomic activation**
- R11. The deploy tooling for both gateway and dashboard supports enabling push in a future deploy by supplying the appropriate inputs (VAPID quartet for gateway, flag for dashboard) without requiring code changes beyond what this effort ships — i.e., "ready but off" means changing approved config only, not writing new deploy logic, when activation happens.
- R12. Enabling gateway push and enabling dashboard push are independently actionable (per R7) but the deploy tooling and docs make explicit that real end-to-end push requires both, plus the `fro-bot/dashboard#238` privacy-policy prerequisite — preventing an operator from believing dashboard-flag-only is sufficient for a live feature. Production activation stays blocked on `fro-bot/dashboard#238`; this effort does not add a deploy-time policy URL checker or any other scope beyond the existing blocker.
- R13. Tests cover: gateway deploy with no VAPID inputs (unchanged/disabled), gateway deploy with partial VAPID inputs (hard-fails before materializing any VAPID state, clear error), gateway deploy with a complete valid VAPID quartet (enables, materializes correctly, private key never leaves gateway-bound artifacts), dashboard deploy with flag off (unchanged), and dashboard deploy with flag on (flag set, no private key material anywhere in dashboard-bound config). Automated tests may use non-production fixture values for structural validation only — production key generation and seeding stay out of scope, and no fixture is ever described as real/production VAPID material.
- R14. Documentation (`apps/gateway/AGENTS.md`, `apps/dashboard/AGENTS.md`, and this repo's root `AGENTS.md` environment/secrets tables) is updated to describe the VAPID quartet, `GATEWAY_OPERATOR_PUSH_ENABLED`, `DASHBOARD_OPERATOR_PUSH_ENABLED`, their default-off states, the hard-fail-on-partial-input behavior, the `GET /operator/push/vapid-key` route, and the `fro-bot/dashboard#238` production-activation blocker — so a future operator has a complete reference without re-deriving the contract.

---

## Acceptance Examples

- AE1. **Covers R2.** Given none of the four `GATEWAY_OPERATOR_PUSH_VAPID_*` inputs are set in the `gateway` environment, when the gateway deploys, then no VAPID secrets are materialized, `GATEWAY_OPERATOR_PUSH_ENABLED` is not set to true, and the daemon starts exactly as it does today.
- AE2. **Covers R3.** Given only `GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`, and `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION` are set (private key absent), when the gateway deploys, then the deploy hard-fails before materializing any VAPID state, with a message naming the missing private key input.
- AE3. **Covers R3.** Given only `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY` is set (public key, subject, and key version absent), when the gateway deploys, then the deploy hard-fails naming all three missing inputs, and push remains disabled.
- AE4. **Covers R4, R5.** Given a complete, structurally valid VAPID quartet is set in the `gateway` environment, when the gateway deploys, then all four are materialized via the SSH-stdin secret-file pattern, `GATEWAY_OPERATOR_PUSH_ENABLED` is set to true, and no VAPID private key value appears in any dashboard-bound artifact, log line, or CI output. `GET /operator/push/vapid-key` returns only `{publicKey, keyVersion}`.
- AE5. **Covers R8, R9.** Given `DASHBOARD_OPERATOR_PUSH_ENABLED` is unset, when the dashboard deploys, then no push-related configuration is surfaced and the deploy is behaviorally identical to a pre-existing deploy with no VAPID/private-key material present anywhere in dashboard config.
- AE6. **Covers R7, R10.** Given `DASHBOARD_OPERATOR_PUSH_ENABLED` is set true (test/staging context, not production activation), when the dashboard deploys, then only the flag itself is present in dashboard-bound config — no public or private VAPID key value is included — and setting the flag alone does not trigger a native permission prompt or automatic subscription; a browser subscription only proceeds through the existing consent UI and a trusted user gesture, which then calls `GET /operator/push/vapid-key`.
- AE7. **Covers R12.** Given only `DASHBOARD_OPERATOR_PUSH_ENABLED` is enabled while `GATEWAY_OPERATOR_PUSH_ENABLED` remains unset, when documentation or tooling is consulted, then it explicitly states this combination does not produce working end-to-end push and names the gateway-side and `fro-bot/dashboard#238` prerequisites.

---

## Success Criteria

- Both push flags (`GATEWAY_OPERATOR_PUSH_ENABLED`, `DASHBOARD_OPERATOR_PUSH_ENABLED`) remain off in every environment after this work ships — verified by inspecting deploy configuration/secrets state post-merge.
- The gateway's VAPID configuration contract is fail-closed: automated tests demonstrate that any combination of fewer than all four VAPID inputs always hard-fails the deploy before materializing any VAPID state, and never enables push.
- No real/production VAPID private key material ever appears in any dashboard-bound artifact, log, or CI output — verified by test assertions and a manual review of the config/secret materialization code paths touched by this work. Test fixtures may use bounded non-production values only to exercise structural validation, and none is described as real/production VAPID material.
- A future operator can enable push end-to-end (gateway + dashboard) by changing approved config alone, per the documented contract, without needing new deploy code — validated by the "ready but off" framing of R11 and reviewed against the docs updated under R14.
- Docs (`apps/gateway/AGENTS.md`, `apps/dashboard/AGENTS.md`, root `AGENTS.md`) accurately describe the new contract, its defaults, the `GET /operator/push/vapid-key` route, and the `fro-bot/dashboard#238` production blocker.

---

## Scope Boundaries

- No real/production VAPID key generation — this effort defines the contract and validation, not the keys themselves. Bounded non-production test-only fixture values are permitted solely to exercise structural validation (per R13) and must never be described as real/production VAPID material.
- No seeding of real GitHub Environment secrets or variables for VAPID material.
- No flipping either push flag to true in any deployed environment as a result of this work.
- No deploy activation of push in gateway or dashboard.
- No browser-side verification of subscribe/consent/notification delivery — that requires `fro-bot/dashboard#238` (privacy-policy route) and is explicitly deferred along with all other production-activation steps.
- No changes to the upstream `fro-bot/agent` or `fro-bot/dashboard` push implementation code — this is infra-side configuration plumbing only.
- No design or UX work for any consent UI, notification permission prompt, or dashboard push settings surface — the future operator reuses the existing consent UI.
- No new deploy-time policy URL checker or other expansion of the `fro-bot/dashboard#238` blocker's scope.

---

## Key Decisions

- Fail-closed all-or-none across the four VAPID inputs for gateway material, mirroring the existing announce/presence and operator-listener patterns already established in this repo — a partial set always hard-fails the deploy before materializing any VAPID state; there is no silent-disable fallback for partial input, consistent operator mental model, no new failure mode to learn.
- Two independent flags (`GATEWAY_OPERATOR_PUSH_ENABLED`, `DASHBOARD_OPERATOR_PUSH_ENABLED`) rather than one shared toggle — the two services have genuinely different responsibilities (gateway sends, dashboard subscribes) and different blast radii if misconfigured (gateway holds the private key; dashboard never should).
- Public key transfer happens at runtime via the gateway's existing authenticated `GET /operator/push/vapid-key` route, not baked into dashboard deploy-time config — keeps the dashboard deploy pipeline free of any key material and avoids stale-key redeploy churn if keys rotate. A future operator still gates the browser subscription behind the existing consent UI and a trusted user gesture, so enabling the flag alone never triggers a permission prompt.
- Production activation is explicitly gated on `fro-bot/dashboard#238` (privacy-policy route) as a hard dependency, not a soft recommendation — shipping push subscription prompts without a public privacy policy is a compliance/trust gap this repo's data-minimization posture does not accept.

---

## Dependencies / Assumptions

- Gateway daemon `fro-bot/agent` v0.93.1 already contains Web Push sending code, gated on the VAPID quartet (`GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY`, `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`, `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION`) being present, plus the `GATEWAY_OPERATOR_PUSH_ENABLED` flag and the authenticated `GET /operator/push/vapid-key` route (verified via upstream source at the pinned ref).
- Dashboard image `2026.07.37` already contains browser-side push subscription code, gated on `DASHBOARD_OPERATOR_PUSH_ENABLED` (verified via upstream source at the pinned digest).
- Production activation is blocked on `fro-bot/dashboard#238` shipping a public, unauthenticated privacy-policy route and consent link — tracked upstream, not owned by this infra repo.
- Cross-repo tracking issue `fro-bot/.github#3512` is the umbrella/coordination ticket for this initiative; this doc scopes only the infra-readiness slice of it.
- Existing gateway secret-materialization pattern (SSH-stdin, `_FILE` env pointers, never argv) is assumed reusable for VAPID private key delivery without modification.

---

## Sources / Research

- `apps/gateway/AGENTS.md` — gateway deploy flow, secret materialization pattern (SSH-stdin, `_FILE` pointers), existing both-or-neither examples (announce/presence, operator listener).
- `apps/dashboard/AGENTS.md` — dashboard deploy flow, existing feature-flag and secret-file conventions.
- Root `AGENTS.md` — environment/secrets tables for `gateway` and `dashboard` GitHub Environments.
- `docs/brainstorms/2026-06-03-gateway-announce-presence-ingress-requirements.md` — precedent for fail-closed both-or-neither infra gating on this gateway.
- `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` — precedent for dashboard/gateway cross-service contract documentation.
- Upstream tracker: <https://github.com/fro-bot/.github/issues/3512>
- Upstream blocker (privacy-policy route): <https://github.com/fro-bot/dashboard/issues/238>
