---
title: "fix: Neutralize cliproxy clear_thinking injection so older Anthropic models work with thinking off"
type: fix
status: active
date: 2026-08-04
deepened: 2026-08-04
---

# fix: Neutralize cliproxy clear_thinking injection so older Anthropic models work with thinking off

## Overview

CLIProxyAPI is currently deployed at `v7.2.118@sha256:488d6ba68e55fe26f204df18ed3cd5c7a58aa8f7eacc4bd2e858d7629ad8094f`. The failed incident/source proof below is tied to the prior `v7.2.117` image at tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`, which still injected a `context_management` directive — Anthropic's `clear_thinking_20251015` strategy — into outbound Claude request bodies. The regression originated in `v7.2.116` (PR #1031). For older Claude models (`claude-opus-4-8`, `claude-sonnet-4-6`) with extended thinking disabled, Anthropic rejects the request with HTTP `400` (`clear_thinking_20251015 strategy requires thinking to be enabled or adaptive`). `claude-sonnet-5` is unaffected. This makes the older models unreachable through `cliproxy.fro.bot` for any thinking-off client, which broke Fro Bot's required review check until `FRO_BOT_MODEL` was swapped to `claude-sonnet-5` as a stopgap. No v7.2.118 source equivalence is asserted here.

The tracked `config.yaml` retains a CLIProxyAPI `payload.override` rule, scoped to the affected Claude models, that sets `context_management` to `{edits: []}` — the bootstrap/template representation of the intended fix while thinking remains off. Production delivery is currently blocked: the failed PR #1042 approach attempted a raw `/v0/management/config.yaml` PUT and then failed opaque readback, violating the approved field-scoped management pattern. Automation must stop until CLIProxyAPI exposes a safe field-scoped/upstream mechanism. cliproxy stays pinned at `v7.2.118`.

## Problem Frame

- **Symptom:** `AI_APICallError: clear_thinking_20251015 strategy requires thinking to be enabled or adaptive`, `status=400`, first-stream, on the Anthropic path through `cliproxy.fro.bot/v1`.
- **Root cause (empirically confirmed 2026-08-04):** cliproxy injects a `context_management` field into the Claude request body. A live three-way probe reproduced it and proved the fix — see Context & Research.
- **Regression origin:** the `context_management` injection tracks cliproxy `v7.2.116` (PR #1031 bumped it; #1036 filed minutes later). `v7.2.104` did not exhibit it.
- **Not the cause:** OpenCode and the fro-bot harness are pass-through for Anthropic (confirmed in the issue).

## Requirements Trace

- R1. `claude-opus-4-8` and `claude-sonnet-4-6` return normal completions through `cliproxy.fro.bot/v1` with thinking **disabled** (no `clear_thinking` 400).
- R2. `claude-sonnet-5` remains healthy — no behavior or cost change for the currently-working model.
- R3. cliproxy stays pinned at `v7.2.118@sha256:488d6ba68e55fe26f204df18ed3cd5c7a58aa8f7eacc4bd2e858d7629ad8094f`; no downgrade, no Renovate hold. This current pin is not claimed equivalent to the historical v7.2.117 source proof.
- R4. Delivery preserves the droplet's runtime `config.yaml` `api-keys` (no `--force-config` overwrite, no key wipe).
- R5. Thinking stays **off** for the affected models — the fix neutralizes the strategy, it does not enable thinking (avoids cost/behavior change).
- R6. Change is verified live against the two proven failing models (`claude-opus-4-8`, `claude-sonnet-4-6`) plus the unaffected `claude-sonnet-5` control before #1036 is closed.
- R7. Full-config handling never exposes client API keys, the management secret, or raw config contents in logs, errors, tests, snapshots, or public evidence.
- R8. No unattended whole-document `/v0/management/config.yaml` replacement is allowed; if no field-scoped endpoint exists for the desired field, automation stops and escalates upstream.

## Scope Boundaries

- Not changing OpenCode or the fro-bot harness (pass-through; ruled out).
- Not modifying CLIProxyAPI source (third-party pinned image).
- Not downgrading cliproxy or pausing Renovate.
- Not enabling thinking on the affected models (rejected: changes cost/behavior; R5).
- Not expanding the incident fix to older Claude aliases that have not reproduced #1036.

### Deferred to Separate Tasks

- **Revert `FRO_BOT_MODEL=claude-sonnet-5` stopgap:** lives in `fro-bot/agent` (upstream repo); reverted there once this fix is verified live. Cross-repo, not an infra file change.
- **Optional upstream issue** in `router-for-me/CLIProxyAPI` (`eceasy/cli-proxy-api`): make the `context_management`/`clear_thinking` injection conditional on downstream thinking state. Only warranted if the override proves fragile across version bumps; the readback-verified apply (Unit 1) makes a future silent break loud.
- **Broader model compatibility sweep:** probe other historical Claude aliases after #1036 is restored; do not expand the production rule during incident closure without a separate reproduction.

## Context & Research

### Empirical probe (2026-08-04, live against `cliproxy.fro.bot`)

Reproduced the failure and proved the fix by testing caller-side request bodies to `claude-opus-4-8` (thinking off):

| Request shape | Result |
|---|---|
| baseline (no extra fields) | **400** `clear_thinking_20251015` |
| `context_management: {edits: []}` | **200**, `diagnostics: null` (cleanest) |
| `context_management: {}` | **200** |
| `thinking: {type: enabled}` | 200, but enables thinking (rejected — cost/behavior change) |
| `thinking: {type: disabled}` | **400** |

`claude-sonnet-5` returns **200** at baseline and its response echoes `"context_management": {"applied_edits": []}` — confirming `context_management` is a **request-body field** cliproxy injects (not merely a beta header). A caller-supplied `context_management` **overrides** cliproxy's injection. The fix moves that override from the caller into the proxy config so no client change is needed.

### Delivery mechanism (repo research)

- `apps/cliproxy/src/deploy.ts` applies only the supported `oauth-model-alias` field-scoped management change. The tracked `payload.override` remains bootstrap/template data; normal deploy preserves an existing runtime `config.yaml` and does not attempt a payload-specific mutation.
- Historical source authority for the failed approach: CLIProxyAPI `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`: `internal/api/server.go` registers `GET /v0/management/config`, `GET /v0/management/config.yaml`, and `PUT /v0/management/config.yaml`. `internal/api/handlers/management/config_basic.go` proves the YAML route returns the raw file bytes; PUT accepts raw YAML, validates it, writes the exact body as a **whole-document replacement**, and reloads it into memory. The JSON `/config` response omits fields tagged `json:"-"` and is not suitable for round-tripping. GitHub compare from `v7.2.116` (`a88197f...`) to `v7.2.117` shows `claude_executor_execute.go`, `claude_executor_cloaking.go`, `payload_helpers.go`, and `config_basic.go` unchanged. This evidence is historical; no v7.2.118 source equivalence is asserted.
- `payload.*` has **no dedicated field-scoped management route**. The raw-YAML endpoint is therefore evidence for escalation, not an approved delivery mechanism.
- Historical source-order evidence at `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`: `internal/runtime/executor/claude_executor_execute.go` calls `injectClaudeCodeContextManagement(body)` **before** `helps.ApplyPayloadConfigWithRequest(...)`; header application and send happen later. Therefore a matching `payload.override` is allowed to replace the injected `context_management` value. No v7.2.118 source equivalence is asserted.
- Historical payload-rule evidence at `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`: `internal/runtime/executor/helps/payload_helpers.go` applies `Default` then `DefaultRaw` (first write wins), `Override` then `OverrideRaw` (last write wins), and `Filter` last (path deletion). Matching model rules use the `*` wildcard and case-insensitive protocol comparison, with all configured conditions required to pass. A later unowned override, any matching override-raw write, or any matching filter deletion of `context_management` defeats the managed rule and must fail closed. No v7.2.118 source equivalence is asserted.
- YAML parsing already exists in `packages/shared/cliproxy/management.ts` (used by `readOAuthModelAliasFromConfig`), so an in-process merge needs no new dependency.
- `apps/cliproxy/src/deploy.test.ts` mocks `fetch` via `makeAliasFetch`, captures `requests[]`, branches on URL+method, and asserts bare-object bodies + `x-management-key`. Focused deploy coverage proves normal deploys never request `/v0/management/config.yaml`.

### Delivery hazard (institutional learnings + source authority)

The failed PR #1042 approach demonstrated why the raw endpoint is not an acceptable unattended delivery path:

- **Production run 30931128408:** PR #1042 issued `PUT /v0/management/config.yaml` and then failed opaque readback. The failure did not make whole-document replacement safe; it exposed the exact blast radius the learning was intended to prevent.
- **`docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md`:** the approved pattern is **field-scoped precisely to avoid touching `api-keys`**. The preservation-verified GET/merge/PUT exception introduced by #1042 violated that learning and is removed.
- **`docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`:** a `config.yaml` overwrite has historically wiped runtime `api-keys` here; no documented recovery runbook.
- **`docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`:** a full-config overwrite must preserve required fields (`auth-dir: /root/.cli-proxy-api`) or the server breaks on restart.
- **Consequence:** production application remains blocked. Keep the tracked rule for first-deploy/bootstrap templates, preserve existing runtime files, and escalate until an upstream or field-scoped endpoint exists. Do not synthesize keys, use `--force-config` as a payload mutation, or retry/rebase a raw whole-document write.

### `payload.override` shape (CLIProxyAPI `config.example.yaml` @ v7.2.117, tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`)

```yaml
payload:
  override:
    - models:
        - name: "claude-opus-4-8"
          protocol: "claude"
        - name: "claude-sonnet-4-6"
          protocol: "claude"
      params:
        "context_management": {"edits": []}
```

`override.params` is `map[string]any` and sets arbitrary body JSON paths; model matching supports `name` + `protocol`. Model-scoping keeps `claude-sonnet-5` untouched (R2).

### Institutional Learnings

- `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md` — field-scoped management apply (bare object, read back, fail closed); never blind-upload or whole-document PUT `config.yaml`. The failed #1042 path is explicitly not a pattern for this plan.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — probe the pinned image; verify contract behavior empirically (already done here).
- `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md` — Anthropic route auth is separate; confirm `cliproxy status` route-OK before attributing verification failures.

## Key Technical Decisions

- **Neutralize via `context_management: {edits: []}`, not enable thinking:** probe-proven to clear the 400 with the cleanest result (`diagnostics: null`) while keeping thinking off (R5). `{}` also works but `{edits: []}` is the more explicit "strategy applied, no edits" form Anthropic already echoes for healthy models.
- **Model-scoped `payload.override`:** targets only `claude-opus-4-8` and `claude-sonnet-4-6`, the two models proven by #1036. `claude-sonnet-5` and every unproven alias remain untouched (R2, R6).
- **No unattended full-config apply:** CLIProxyAPI has no field-scoped `payload` endpoint. The raw-YAML GET/PUT contract is not an approved fallback; automation stops and escalates rather than mutating the secret-bearing document.
- **Tracked config owns a bootstrap fragment, never the live document:** retain `apps/cliproxy/config/config.yaml`'s desired `payload.override` for first-deploy templates only. Normal deploy preserves the existing runtime file and never merges tracked root fields or payload rules into it.
- **Source ordering remains historical evidence:** the exact `v7.2.117` source proves the injection and payload ordering, but that proof does not authorize a whole-document mutation. A future field-scoped/upstream mechanism must revalidate the same ordering before production use.
- **Secret-bearing operations are silent by construction:** raw YAML, config diffs, API-key values, management secrets, and management response bodies are never logged. Errors report only bounded field names/counts and sanitized status.
- **Stay on `v7.2.118`:** preserves the current deployed pin while production application remains blocked pending a safe field-scoped/upstream mechanism (R3). No equivalence with the historical v7.2.117 source proof is claimed.
- **First/forced upload boundary:** first deploy may upload the tracked bootstrap template; normal deploy preserves an existing `config.yaml`. Neither path authorizes an unattended raw management PUT.
- **Failed rollback path removed:** no Unit 1 raw snapshot, restore helper, stale-hash gate, or automatic retry/rebase remains. Any future production mutation requires a separately reviewed field-scoped mechanism and rollback contract.

## Open Questions

### Resolved During Planning

- **What clears the 400?** A proxy-side `context_management: {edits: []}` override on the affected models (probe-proven).
- **Which cliproxy version regressed?** `v7.2.116`.
- **Why is `sonnet-5` fine?** Anthropic gates `clear_thinking` retention by model class; only older models 400 when thinking is off.
- **What was the historical management contract?** At exact `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`, `GET /v0/management/config.yaml` returns raw YAML; `PUT` accepts raw YAML, validates, replaces the complete file, and reloads it. `/v0/management/config` is JSON and omits non-JSON fields, so it is read-only observability, not a round-trip source. This raw whole-document route is forbidden for unattended deploys, not an approved payload-delivery path. No v7.2.118 source equivalence is asserted.

### Deferred to Implementation

- **Exact override ordering:** resolved in Unit 1 from the exact `v7.2.117` source at tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1` and isolated contract tests. GitHub compare confirms the relevant executor/cloaking/payload-helper files are unchanged from `v7.2.116`; production remains blocked for lack of a safe field-scoped payload mechanism, not because the ordering evidence is unresolved.

## High-Level Technical Design

Current safe data flow; no payload mutation is attempted:

```text
tracked config.yaml
  └─ retain infra-owned payload.override for first-deploy/bootstrap templates

normal deploy
  ├─ preserve existing server config.yaml
  ├─ apply only field-scoped oauth-model-alias changes
  └─ validate proxy health

payload.override production application
  └─ BLOCKED: no field-scoped endpoint; stop and escalate upstream
```

## Implementation Units

- [x] **Unit 1: Retain the bootstrap template and remove unsafe unattended payload apply**

**Goal:** Retain the model-scoped override as a bootstrap/template fragment and remove the unsafe unattended full-YAML apply path. Normal deploys preserve existing runtime configuration and stop rather than attempting an unsupported payload mutation.

**Requirements:** R3, R4, R5, R7, R8

**Dependencies:** None.

**Files:**
- Modify: `apps/cliproxy/config/config.yaml` — add the infra-owned `payload.override` rule and its purpose.
- Modify: `packages/shared/cliproxy/management.ts` — remove the unattended raw-config apply/restore surface while preserving alias/key/config helpers.
- Modify: `apps/cliproxy/src/deploy.ts` — remove payload mutation and payload-specific management-key preflight; preserve field-scoped alias apply and health validation.
- Test: `apps/cliproxy/src/deploy.test.ts` and the colocated shared-management tests.

**Approach:**
- Keep the exact two-model `payload.override` rule in the tracked template for bootstrap/first-deploy intent. It is not a live mutation contract.
- Remove raw whole-document GET/merge/PUT/restore helpers and their tests from the shared package; usage analysis must leave no dead unattended payload path.
- Remove `applyPayloadOverrideStep` and its invocation. A normal deploy with an existing server config must not request `/v0/management/config.yaml`, require a payload-specific management key, or bypass the field-scoped alias step and health gate.
- Record the failed PR #1042 approach and block Unit 2 until an upstream or field-scoped payload endpoint exists. Do not preserve a raw-config exception, snapshot/rollback workflow, stale-hash guard, or retry/rebase guidance as executable instructions.

**Test scenarios:**
- Tracked template retains the exact two-model rule and remains suitable for first-deploy/bootstrap upload.
- Normal deploy with an existing server config and a tracked payload rule performs no raw config GET/PUT, does not require a payload-specific mutation path, applies field-scoped aliases, and reaches health validation.
- Fresh/forced template upload behavior remains covered without a follow-up raw payload apply.
- Shared tests retain unrelated API-key, JSON, management-header, and OAuth alias coverage after raw payload helpers/tests are removed.

**Verification:**
- Focused tests prove the surviving template/deploy boundary and field-scoped alias behavior; no production write occurs in this unit. Unit 2 is blocked pending a safe field-scoped/upstream mechanism.

- [ ] **Unit 2: Apply the override through an operator-gated production rollout with rollback evidence**

**Goal:** Remain blocked. Do not mutate the live config until CLIProxyAPI provides a safe field-scoped payload endpoint or an upstream-reviewed mechanism that does not replace the secret-bearing document.

**Requirements:** R3, R4, R7, R8

**Dependencies:** Unit 1 merged; safe field-scoped/upstream mechanism documented and reviewed; explicit cliproxy environment approval before any write.

**Files:**
- Create: none until a safe field-scoped/upstream mechanism exists. No raw-config snapshot artifact is permitted for the blocked approach.

**Approach:**
- Do not run production probes or writes for this blocked unit.
- Keep the `claude-sonnet-5` stopgap active and record the failed production run `30931128408` / PR #1042 as the reason for the block.
- Request or implement only a field-scoped/upstream endpoint for `payload.override`; whole-document `/v0/management/config.yaml` PUT remains forbidden in unattended automation.
- If no safe mechanism is available, stop and escalate. Do not synthesize keys, use `--force-config` as a payload mutation, create a raw snapshot, or add automatic retry/rebase.

**Verification:**
- Verification is intentionally not available until the safe field-scoped/upstream mechanism is approved. Unit 3 remains blocked.

- [ ] **Unit 3: Verify affected and control models, monitor, then close #1036**

**Goal:** Remain blocked until Unit 2 has a safe field-scoped/upstream application mechanism; then prove the override clears the 400 with thinking off, preserves existing consumers, and remains healthy through immediate checks plus one automated-path reconciliation.

**Requirements:** R1, R2, R5, R6

**Dependencies:** Unit 2 applied successfully.

**Files:**
- Create: none (bounded non-secret evidence recorded on the issue/PR).

**Approach:**
- Send identical benign thinking-off requests to `claude-opus-4-8`, `claude-sonnet-4-6`, and `claude-sonnet-5`. Assert the requested model identity, normal non-fallback completion, `thinking_tokens: 0`, no thinking blocks/diagnostics, and absence of the `clear_thinking_20251015` 400. HTTP 200 alone is insufficient.
- Do not expand the incident rule to unproven aliases. Record broader compatibility probing as the deferred follow-up.
- Confirm `/healthz`, management auth, `/v1/models`, one known client key, `cliproxy status`, Anthropic route health, and a manually dispatched `cliproxy-auth-monitor` run immediately after apply. This bounded automated-path check replaces the 24-hour closure gate; normal scheduled monitoring continues afterward.
- If the proxy-side override loses to cliproxy's injection or the target 400 recurs, keep the stopgap and escalate upstream; do not close #1036.
- Close #1036 only with bounded evidence that affected models work with thinking off and `sonnet-5` is unchanged. Track the upstream stopgap revert separately.

**Verification:**
- Both proven failing models and the control satisfy the exact acceptance signature; existing client/auth surfaces and the manual auth-monitor path are healthy; the rollback artifact is deleted and confirmed absent; #1036 has evidence-backed closure.

## System-Wide Impact

- **Interaction graph:** Fix is at the proxy, so every Anthropic-routed consumer of `cliproxy.fro.bot` (Fro Bot review, other repos on `anthropic/*`) is restored without per-consumer change.
- **Error propagation:** A wrong/partial override could shift rather than remove the 400 — Unit 3 dispositions distinguish the target defect from unrelated model/provider failures before closure.
- **State lifecycle risks:** The failed PR #1042 full-YAML PUT replaced live runtime config and failed opaque readback. Normal deploy now preserves the existing file and performs no payload mutation; any future production path is blocked until it is field-scoped/upstream-reviewed.
- **Secret surfaces:** Raw YAML contains client API keys and management configuration. Unattended deploys do not read, write, snapshot, or log the raw management document.
- **API surface parity:** The incident override targets only the two models proven by #1036. Broader historical-alias compatibility is a separate follow-up; all unscoped models remain outside the rule.
- **Unchanged invariants:** cliproxy stays `v7.2.118@sha256:488d6ba68e55fe26f204df18ed3cd5c7a58aa8f7eacc4bd2e858d7629ad8094f`; `oauth-model-alias` remains field-scoped; existing runtime config is preserved; default `config.yaml` no-overwrite deploy behavior remains unchanged; thinking stays off. Historical injection/order evidence remains tied to v7.2.117 only.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| cliproxy applies `payload.override` before its own `context_management` injection (override loses on the proxy) | The exact v7.2.117 source ordering remains documented, but production is blocked until a safe field-scoped/upstream mechanism is available. Keep the `sonnet-5` stopgap and escalate upstream. |
| Full-YAML replacement drops or changes runtime API keys, `auth-dir`, aliases, YAML constructs, unknown fields, or unrelated rules | PR #1042 demonstrated this blast radius with failed opaque readback. Do not mitigate it with another raw merge/snapshot exception; require a field-scoped/upstream mechanism. |
| Raw full-config handling leaks API keys or management secrets through errors, logs, snapshots, temp files, or public evidence | Unattended automation no longer reads, writes, snapshots, or logs raw `/config.yaml`; future safe mechanisms must retain the learning's secret boundary. |
| The infra-owned rule collides with an existing payload rule | A unique `managed-by: infra/cliproxy-clear-thinking` comment identifies the rule. Duplicate markers or equivalent unmarked rules fail closed; unrelated rule order remains unchanged. |
| Another operator or automation changes config between GET and PUT | This is a residual risk of the rejected raw approach, not a fix target. No unattended raw GET→PUT path is allowed; do not add automatic retry/rebase. |
| Management key is absent and deploy reaches payload mutation/restart before failing | Payload mutation is removed. Only field-scoped OAuth alias work requires the management key; tracked payload template data does not create a payload-specific preflight requirement. |
| A future cliproxy bump changes injection or full-config semantics | Deploy-time owned-rule readback plus Unit 3 model probes make drift loud. Re-verify the exact-tag source contract on every cliproxy bump that touches management/config/payload behavior. |
| HTTP 200 masks fallback routing or adaptive thinking | Unit 3 asserts requested model identity, normal non-fallback completion, `thinking_tokens: 0`, no thinking blocks/diagnostics, and absence of the target error. |
| Additional older models reproduce the same 400 | Keep them out of the incident rule and track a broader compatibility sweep separately after #1036 closes. |
| Safe field-scoped/upstream payload apply cannot be provided | Stop without mutation and escalate upstream or write a separately reviewed recovery plan. Environment-synthesized key rosters, raw full-config PUTs, and automatic `--force-config` payload fallbacks are prohibited. |

## Documentation / Operational Notes

- Update `apps/cliproxy/AGENTS.md` with the `payload.override` purpose (clear_thinking 400 suppression for older Anthropic models), the affected model set, and its bootstrap/template-only status.
- Document the failed PR #1042 raw-config approach and the field-scoped-only rule in `apps/cliproxy/AGENTS.md`; never include example key values or raw config output.
- Changeset: only if `packages/cli` user-facing behavior changes; a droplet-config + deploy-internal change does not warrant one. `deploy.ts`/shared-helper changes are internal, but if the shared helper is user-observable via the CLI, add a patch changeset.
- After live verification, coordinate the `FRO_BOT_MODEL` stopgap revert in `fro-bot/agent`.

## Sources & References

- Issue: #1036; downstream impact fro-bot/agent#1314; failing runs 30842478774, 30860153753 vs 30860341225.
- Failed production approach: PR #1042, run 30931128408; raw `/v0/management/config.yaml` PUT followed by failed opaque readback and violation of the field-scoped management learning.
- Regression correlation: PR #1031 (cliproxy → `v7.2.116`).
- Live probe: 2026-08-04 three-way test against `cliproxy.fro.bot` (baseline 400 / `context_management:{edits:[]}` 200 / sonnet-5 200).
- Code: `apps/cliproxy/config/config.yaml`, `apps/cliproxy/src/deploy.ts`, `packages/shared/cliproxy/management.ts`, `apps/cliproxy/src/deploy.test.ts`, `apps/cliproxy/AGENTS.md`.
- Learnings: `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md`, `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md`, `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`.
- Historical upstream evidence: `router-for-me/CLIProxyAPI` `config.example.yaml` @ `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1` (`payload.override` schema); Anthropic `clear_thinking_20251015` context-editing docs. No v7.2.118 schema/source equivalence is asserted.
- Historical source-authority contract: CLIProxyAPI `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`; `internal/api/server.go` route registration; `internal/api/handlers/management/config_basic.go` raw-YAML GET/PUT whole-document replacement + reload; `internal/api/handlers/management/config.go` incomplete JSON config response. GitHub compare from `v7.2.116` (`a88197f...`) shows the relevant executor, cloaking, payload-helper, and config-basic files unchanged.
