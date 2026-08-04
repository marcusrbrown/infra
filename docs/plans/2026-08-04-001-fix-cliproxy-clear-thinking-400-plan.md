---
title: "fix: Neutralize cliproxy clear_thinking injection so older Anthropic models work with thinking off"
type: fix
status: active
date: 2026-08-04
deepened: 2026-08-04
---

# fix: Neutralize cliproxy clear_thinking injection so older Anthropic models work with thinking off

## Overview

CLIProxyAPI (at the current deployed pin `v7.2.117`, tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`) still injects a `context_management` directive — Anthropic's `clear_thinking_20251015` strategy — into outbound Claude request bodies. The regression originated in `v7.2.116` (PR #1031). For older Claude models (`claude-opus-4-8`, `claude-sonnet-4-6`) with extended thinking disabled, Anthropic rejects the request with HTTP `400` (`clear_thinking_20251015 strategy requires thinking to be enabled or adaptive`). `claude-sonnet-5` is unaffected. This makes the older models unreachable through `cliproxy.fro.bot` for any thinking-off client, which broke Fro Bot's required review check until `FRO_BOT_MODEL` was swapped to `claude-sonnet-5` as a stopgap.

The fix applies a CLIProxyAPI `payload.override` rule, scoped to the affected Claude models, that sets `context_management` to `{edits: []}` — neutralizing the injected strategy while keeping thinking off. Delivery uses the full-fidelity config endpoint of the pinned `v7.2.117` image (tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`): read the raw live YAML, preserve an operator-only rollback snapshot, merge only the infra-owned override, replace the full YAML document, and read it back before reporting success. cliproxy stays pinned at `v7.2.117`.

## Problem Frame

- **Symptom:** `AI_APICallError: clear_thinking_20251015 strategy requires thinking to be enabled or adaptive`, `status=400`, first-stream, on the Anthropic path through `cliproxy.fro.bot/v1`.
- **Root cause (empirically confirmed 2026-08-04):** cliproxy injects a `context_management` field into the Claude request body. A live three-way probe reproduced it and proved the fix — see Context & Research.
- **Regression origin:** the `context_management` injection tracks cliproxy `v7.2.116` (PR #1031 bumped it; #1036 filed minutes later). `v7.2.104` did not exhibit it.
- **Not the cause:** OpenCode and the fro-bot harness are pass-through for Anthropic (confirmed in the issue).

## Requirements Trace

- R1. `claude-opus-4-8` and `claude-sonnet-4-6` return normal completions through `cliproxy.fro.bot/v1` with thinking **disabled** (no `clear_thinking` 400).
- R2. `claude-sonnet-5` remains healthy — no behavior or cost change for the currently-working model.
- R3. cliproxy stays pinned at `v7.2.117` (tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`); no downgrade, no Renovate hold.
- R4. Delivery preserves the droplet's runtime `config.yaml` `api-keys` (no `--force-config` overwrite, no key wipe).
- R5. Thinking stays **off** for the affected models — the fix neutralizes the strategy, it does not enable thinking (avoids cost/behavior change).
- R6. Change is verified live against the two proven failing models (`claude-opus-4-8`, `claude-sonnet-4-6`) plus the unaffected `claude-sonnet-5` control before #1036 is closed.
- R7. Full-config handling never exposes client API keys, the management secret, or raw config contents in logs, errors, tests, snapshots, or public evidence.
- R8. Full-config replacement aborts if the live raw YAML changes between the authoritative read and the write; no automatic rebase or retry may overwrite concurrent operator/automation changes.

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

- `apps/cliproxy/src/deploy.ts` applies managed config via the management API, not by uploading `config.yaml`. The `oauth-model-alias` step (`packages/shared/cliproxy/management.ts` → `applyOAuthModelAlias`/`readBackOAuthModelAlias`) is the pattern: `PUT` the bare object to a `/v0/management/...` endpoint, read back, retry-on-mismatch, fail closed. Auth is `x-management-key: <CLIPROXY_MANAGEMENT_KEY>`, base `https://${CLIPROXY_DOMAIN}`.
- Source authority at the current CLIProxyAPI `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`: `internal/api/server.go` registers `GET /v0/management/config`, `GET /v0/management/config.yaml`, and `PUT /v0/management/config.yaml`. `internal/api/handlers/management/config_basic.go` proves the YAML route returns the raw file bytes; PUT accepts raw YAML, validates it, writes the exact body as a **whole-document replacement**, and reloads it into memory. The JSON `/config` response omits fields tagged `json:"-"` and is not suitable for round-tripping. GitHub compare from `v7.2.116` (`a88197f...`) to `v7.2.117` shows `claude_executor_execute.go`, `claude_executor_cloaking.go`, `payload_helpers.go`, and `config_basic.go` unchanged, so the proven injection, payload ordering, schema, and management contract carry forward.
- `payload.*` has **no dedicated field-scoped management route** (unlike `oauth-model-alias`); the raw-YAML full-config endpoint is the only management API path for it.
- Exact source-order evidence at the current `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`: `internal/runtime/executor/claude_executor_execute.go` calls `injectClaudeCodeContextManagement(body)` **before** `helps.ApplyPayloadConfigWithRequest(...)`; header application and send happen later. Therefore a matching `payload.override` is allowed to replace the injected `context_management` value.
- Exact payload-rule evidence at the current `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`: `internal/runtime/executor/helps/payload_helpers.go` applies `Default` then `DefaultRaw` (first write wins), `Override` then `OverrideRaw` (last write wins), and `Filter` last (path deletion). Matching model rules use the `*` wildcard and case-insensitive protocol comparison, with all configured conditions required to pass. A later unowned override, any matching override-raw write, or any matching filter deletion of `context_management` defeats the managed rule and must fail closed.
- YAML parsing already exists in `packages/shared/cliproxy/management.ts` (used by `readOAuthModelAliasFromConfig`), so an in-process merge needs no new dependency.
- `apps/cliproxy/src/deploy.test.ts` mocks `fetch` via `makeAliasFetch`, captures `requests[]`, branches on URL+method, and asserts bare-object bodies + `x-management-key`. New apply-step tests mirror this.

### Delivery hazard (institutional learnings + source authority)

The endpoint contract is now source-verified, but the operation remains high blast-radius because PUT replaces the entire secret-bearing document:

- **`docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md`:** the approved pattern is **field-scoped precisely to avoid touching `api-keys`**. Source authority now proves the raw-YAML GET handler performs no redaction, but that does not make whole-document replacement low-risk: the actual live file must still contain the complete key roster and required fields before any PUT, and the replacement must preserve them exactly.
- **`docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`:** a `config.yaml` overwrite has historically wiped runtime `api-keys` here; no documented recovery runbook.
- **`docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`:** a full-config PUT must preserve required fields (`auth-dir: /root/.cli-proxy-api`) or the server breaks on restart.
- **Full-config bodies are secret material.** Raw YAML, diffs, response bodies, and mismatch errors must never enter logs or test output. The deploy reports only bounded field/count summaries.
- **Scope note:** Claude **OAuth** lives in the `auth-dir` volume, not `config.yaml`, so it is safe regardless. The wipe risk is specifically the client-facing **`api-keys`** array.

**Consequence:** implementation treats the tracked config as desired-state input for one owned rule only, while the raw live YAML remains authoritative for every other field. Production apply requires a full-fidelity pre-write readback, secret-safe invariant checks, an exact operator-only rollback snapshot, and explicit approval. If any invariant is ambiguous, the plan stops and escalates upstream; it does not synthesize a replacement from environment variables or invoke `--force-config`.

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

- `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md` — field-scoped management apply (bare object, read back, fail closed); never blind-upload `config.yaml`. Direct pattern for Unit 1.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — probe the pinned image; verify contract behavior empirically (already done here).
- `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md` — Anthropic route auth is separate; confirm `cliproxy status` route-OK before attributing verification failures.

## Key Technical Decisions

- **Neutralize via `context_management: {edits: []}`, not enable thinking:** probe-proven to clear the 400 with the cleanest result (`diagnostics: null`) while keeping thinking off (R5). `{}` also works but `{edits: []}` is the more explicit "strategy applied, no edits" form Anthropic already echoes for healthy models.
- **Model-scoped `payload.override`:** targets only `claude-opus-4-8` and `claude-sonnet-4-6`, the two models proven by #1036. `claude-sonnet-5` and every unproven alias remain untouched (R2, R6).
- **Full-config apply is contingent and operator-gated:** CLIProxyAPI has no field-scoped `payload` endpoint. Use raw-YAML GET/PUT only because source authority proves the exact `v7.2.117` contract at tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`, and only after pre-write invariants and a rollback snapshot pass. Any ambiguity stops the rollout; it does not trigger an automatic fallback.
- **Tracked config owns one fragment, never the live document:** parse `apps/cliproxy/config/config.yaml` only to obtain the desired infra-owned `payload.override` rule. Never merge tracked root fields (including intentionally empty `api-keys` or management settings) into the live YAML.
- **Stable rule identity:** mark the list item with the unique YAML comment `managed-by: infra/cliproxy-clear-thinking`. Exactly one marker identifies the owned rule. Zero markers permits first-time append only when no semantically equivalent unmarked rule exists; duplicate markers or an equivalent unmarked rule are ambiguous and fail closed.
- **Document-preserving YAML mutation:** use `yaml@2.9.0`'s document/CST API (`parseDocument`) to mutate only the marked node. Contract fixtures must preserve unrelated values, comments, tags, anchors, scalar types, unknown fields, and sequence order. Formatting may normalize; semantic equivalence for unrelated state is required. The exact pre-write bytes remain the rollback and concurrency source of truth.
- **Optimistic concurrency, no silent rebase:** hash the authoritative raw GET. Re-GET immediately before PUT and require the hash to match; abort on drift. Any retry starts a new explicitly approved read/validate/snapshot cycle (R8). The server has no ETag contract, so a tiny GET→PUT race remains; a PUT timeout can be commit-ambiguous, but the operation is idempotent and self-heals on the next explicitly approved apply. Do not add automatic retry/rebase.
- **Override ordering is a pre-write invariant:** Unit 1 is source-verified against `claude_executor_execute.go` and `payload_helpers.go`: the managed rule may follow earlier ordinary overrides, but later unowned `override` writes, any matching `override-raw` write, or any matching `filter` deletion of `context_management` is ambiguous and halts before PUT. Unit 2 cannot begin unless the marked rule's deterministic position is proven to win without affecting unscoped models.
- **Secret-bearing operations are silent by construction:** raw YAML, config diffs, API-key values, management secrets, and management response bodies are never logged. Errors report only bounded field names/counts and sanitized status.
- **Stay on `v7.2.117`:** keeps the current deployed pin's other fixes; the readback-verified apply surfaces a future upstream change that breaks the override rather than silently regressing (R3).
- **First/forced upload boundary:** when deploy has just uploaded tracked `config.yaml` (`!configExists` or `--force-config`), it skips the raw payload apply because the tracked file already contains the managed rule and may intentionally have empty template `api-keys`. Normal deploys preserve the server file and use only the preservation-verified raw GET/merge/PUT path.
- **Rollback snapshot lifecycle:** Unit 1 keeps raw bodies in memory only; the operator snapshot is created by the Unit 2 mutation workflow before its first PUT, retained through readback/health verification, and is the only disk copy eligible for the three-state rollback gate. Restore compares the current raw hash to the successful apply `afterHash`, halts on a third state, and verifies exact snapshot bytes after PUT.

## Open Questions

### Resolved During Planning

- **What clears the 400?** A proxy-side `context_management: {edits: []}` override on the affected models (probe-proven).
- **Which cliproxy version regressed?** `v7.2.116`.
- **Why is `sonnet-5` fine?** Anthropic gates `clear_thinking` retention by model class; only older models 400 when thinking is off.
- **What is the management contract?** At exact `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`, `GET /v0/management/config.yaml` returns raw YAML; `PUT` accepts raw YAML, validates, replaces the complete file, and reloads it. `/v0/management/config` is JSON and omits non-JSON fields, so it is read-only observability, not a round-trip source.

### Deferred to Implementation

- **Exact override ordering:** resolved in Unit 1 from the exact `v7.2.117` source at tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1` and isolated contract tests before any production write. GitHub compare confirms the relevant executor/cloaking/payload-helper files are unchanged from `v7.2.116`; if ordering cannot be proven, Unit 2 is blocked and the workaround is escalated upstream.

## High-Level Technical Design

Non-prescriptive data flow for the secret-bearing config update:

```text
tracked config.yaml
  └─ extract only infra-owned payload.override rule

management API GET /config.yaml
  └─ raw live YAML (authoritative opaque state)
      ├─ validate secret/runtime invariants without logging values
      ├─ hash exact bytes for optimistic concurrency
      ├─ save exact operator-only rollback snapshot (0600 temp file)
      └─ mutate only the uniquely marked rule through YAML Document/CST

immediate pre-PUT GET /config.yaml
  └─ require exact-byte hash match or abort without mutation

management API PUT /config.yaml
  └─ full-document validated replacement + live reload
      ├─ owned-rule + semantic unrelated-state readback matches
      ├─ runtime invariants unchanged
      └─ API/model health checks pass
```

## Implementation Units

- [x] **Unit 1: Implement the secret-safe desired-rule merger and apply contract**

**Goal:** Encode the model-scoped override and implement an idempotent full-YAML apply path that cannot source runtime fields from the tracked template, cannot log secrets, and fails before mutation when invariants are ambiguous.

**Requirements:** R3, R4, R5, R7, R8

**Dependencies:** None.

**Files:**
- Modify: `apps/cliproxy/config/config.yaml` — add the infra-owned `payload.override` rule and its purpose.
- Modify: `packages/shared/cliproxy/management.ts` — raw-YAML read/apply/readback helpers, exact-snapshot restore helper, desired-rule extraction, opaque merge, invariant summaries, and secret sanitization.
- Modify: `apps/cliproxy/src/deploy.ts` — preflight the management key whenever a non-empty tracked override exists; add the apply step after existing managed fields.
- Test: `apps/cliproxy/src/deploy.test.ts` and the colocated shared-management tests.

**Approach:**
- Extract only the owned override fragment from tracked config. Never use tracked root fields as replacement input. The rule carries the unique comment marker `managed-by: infra/cliproxy-clear-thinking`.
- Treat raw live YAML as authoritative opaque state. Require non-empty string `api-keys`, exact `auth-dir`, existing aliases/payload rules, and semantically preservable unknown fields before allowing mutation. The exact-tag handler proves the raw endpoint itself does not mask values; implementation still rejects placeholder/mask patterns and malformed entries defensively.
- Parse with `yaml@2.9.0` `parseDocument` and mutate only the marked list node. Preserve unrelated values, comments, tags, anchors, scalar types, unknown fields, and sequence order; semantic preservation is required even when formatting normalizes.
- Rule identity is fail-closed: exactly one marker updates in place; zero markers permits first-time append only when no semantically equivalent unmarked rule exists; duplicate markers or an equivalent unmarked rule halt before PUT.
- Resolve payload override/injection ordering against the exact `v7.2.117` source at tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1` and isolated contract tests before production. Unit 2 is blocked unless the deterministic marked-rule position is proven to win and leave unscoped models untouched.
- Extend the existing management-key preflight so a tracked override with no `CLIPROXY_MANAGEMENT_KEY` fails before any SSH, container restart, or management request.
- Keep both raw GET bodies and the candidate PUT body in memory only. The Unit 2 rollback artifact is the sole allowed disk copy. Sanitize fetch, parse, mutation, PUT, and readback errors: no raw YAML, diffs, response bodies, key values, management secrets, bearer tokens, or environment-secret values reach stdout/stderr, exceptions, snapshots, or assertions.
- Hash the exact authoritative GET body. Immediately before PUT, perform a second GET and require an exact hash match. Abort on drift; do not silently rebase or retry. A retry begins a new operator-approved read/validate/snapshot cycle.
- `PUT /v0/management/config.yaml` uses raw YAML and counts as success only after exact owned-rule readback plus unchanged runtime-invariant summaries. A response status alone is insufficient.

**Test scenarios:**
- Desired rule absent/present/drifted; unique marker add/update; duplicate-marker and equivalent-unmarked collisions halt.
- Golden fixtures preserve unrelated comments, tags, anchors, scalar forms/types, unknown fields, and sequence order through `parseDocument` mutation/stringification.
- Tracked template contains empty runtime fields; prove none can enter the PUT body.
- Missing, empty, masked, malformed, or ambiguous runtime fields abort before PUT.
- Missing management key with an override present fails during preflight.
- Second GET hash differs from the authoritative first GET → zero PUTs and a sanitized concurrent-drift error.
- PUT failure/readback mismatch errors expose no raw API keys, management secret, raw config, or bearer-token patterns.
- Restore helper state machine: current bytes already equal snapshot → no-op; current bytes equal the known intended post-write bytes → PUT the exact snapshot bytes; any third-state hash → halt without overwrite. Successful restore requires byte-identical GET readback.
- Idempotent state performs no PUT.

**Verification:**
- Focused tests prove exact fragment ownership, runtime-state preservation, secret-safe failure behavior, and fail-closed preflight; no production write occurs in this unit.

- [ ] **Unit 2: Apply the override through an operator-gated production rollout with rollback evidence**

**Goal:** Mutate the live config only after all pre-write Go/No-Go checks pass, with an exact restricted rollback snapshot and immediate rollback triggers.

**Requirements:** R3, R4, R7, R8

**Dependencies:** Unit 1 merged; explicit cliproxy environment approval before the write.

**Files:**
- Create: none tracked. The pre-write raw-YAML snapshot is operator-only temporary secret material under an OS temp directory, never the repo or a user backup/sync tree.

**Approach:**
- Establish pre-write baselines: management auth works; `/healthz`, `/v1/models`, and a benign `claude-sonnet-5` completion are healthy; raw YAML contains intact API-key roster, exact `auth-dir`, expected alias/payload state, and no ambiguous fields.
- Create a fresh `mktemp -d` under the operator OS temp directory (`0700`) and write the exact raw pre-write bytes to one `0600` file using stdin/in-process bytes only — never argv, shell expansion, stdout, attachments, or the repository. Record only its path privately for this rollout.
- Re-GET immediately before PUT and require the exact snapshot hash to match (R8). Approve and run the deploy apply step only after the concurrency gate passes.
- Confirm raw-YAML readback preserves opaque API-key values/count, `auth-dir`, aliases, unrelated payload rules, unknown fields, and the expected semantic document; the marked desired override is present exactly once and does not target `sonnet-5`.
- Roll back immediately with the exact snapshot if management auth, any known-valid client key, required config invariants, the control model, or readback convergence fails. The restore path calls the shared raw-config helper with the snapshot bytes: if the current GET already equals the snapshot it is a no-op; if it equals the known intended post-write hash, PUT the exact saved bytes to `/v0/management/config.yaml`; if it is any third state, halt rather than clobber concurrent drift. Rollback is complete only after byte-identical GET readback and baseline management/client/model checks recover. Keep the upstream `sonnet-5` stopgap active throughout.
- Delete the snapshot and its temp directory after either (a) successful rollback verification or (b) Unit 3's immediate checks plus one manually dispatched auth-monitor check pass. Verify the path is absent; do not claim secure erasure on SSD storage.
- If the safe full-config contract cannot be satisfied, stop. Do not synthesize keys from environment variables, use `--force-config`, or improvise another mutation; escalate upstream or create a separately reviewed recovery plan.

**Verification:**
- Apply/readback and existing-consumer health pass with no secret leakage; otherwise the exact snapshot is restored and verified before continuing.

- [ ] **Unit 3: Verify affected and control models, monitor, then close #1036**

**Goal:** Prove the override clears the 400 with thinking off, preserves existing consumers, and remains healthy through immediate checks plus one automated-path reconciliation.

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
- **State lifecycle risks:** Full-YAML PUT replaces live runtime config and reloads it immediately. Unit 1 makes unrelated state opaque/preserved; Unit 2 carries the exact rollback snapshot and validates client/management access on both apply and rollback.
- **Secret surfaces:** Raw YAML contains client API keys and management configuration. It exists only in process memory and a temporary restricted rollback artifact; public evidence contains bounded summaries only.
- **API surface parity:** The incident override targets only the two models proven by #1036. Broader historical-alias compatibility is a separate follow-up; all unscoped models remain outside the rule.
- **Unchanged invariants:** cliproxy stays `v7.2.117` at tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`; `oauth-model-alias` and existing managed fields unchanged; default `config.yaml` no-overwrite deploy behavior unchanged; thinking stays off.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| cliproxy applies `payload.override` before its own `context_management` injection (override loses on the proxy) | Unit 1 must prove exact-tag ordering before production and block Unit 2 if unresolved. Unit 3 confirms the live acceptance signature; keep the `sonnet-5` stopgap and escalate upstream on mismatch. |
| Full-YAML replacement drops or changes runtime API keys, `auth-dir`, aliases, YAML constructs, unknown fields, or unrelated rules | Unit 1 uses YAML Document/CST mutation plus golden fixtures and semantic readback; Unit 2 holds the exact-byte rollback snapshot and verifies restore byte-for-byte on failure. Any ambiguity is No-Go. |
| Raw full-config handling leaks API keys or management secrets through errors, logs, snapshots, temp files, or public evidence | Raw bodies are in-memory only except the single `0600` rollback file in an OS temp directory. Secret-aware tests cover every error boundary; the file is deleted and absence verified after rollback or bounded successful verification. |
| The infra-owned rule collides with an existing payload rule | A unique `managed-by: infra/cliproxy-clear-thinking` comment identifies the rule. Duplicate markers or equivalent unmarked rules fail closed; unrelated rule order remains unchanged. |
| Another operator or automation changes config between GET and PUT | Hash the exact raw GET and require an immediate pre-PUT GET hash match. Abort on drift; never silently rebase or retry. |
| Management key is absent and deploy reaches mutation/restart before failing | Extend the existing preflight to treat non-empty tracked `payload.override` as requiring `CLIPROXY_MANAGEMENT_KEY`; test fail-fast ordering. |
| A future cliproxy bump changes injection or full-config semantics | Deploy-time owned-rule readback plus Unit 3 model probes make drift loud. Re-verify the exact-tag source contract on every cliproxy bump that touches management/config/payload behavior. |
| HTTP 200 masks fallback routing or adaptive thinking | Unit 3 asserts requested model identity, normal non-fallback completion, `thinking_tokens: 0`, no thinking blocks/diagnostics, and absence of the target error. |
| Additional older models reproduce the same 400 | Keep them out of the incident rule and track a broader compatibility sweep separately after #1036 closes. |
| Safe full-config apply cannot be proven or rollback cannot be guaranteed | Stop without mutation and escalate upstream or write a separately reviewed recovery plan. Environment-synthesized key rosters and automatic `--force-config` are prohibited fallbacks. |

## Documentation / Operational Notes

- Update `apps/cliproxy/AGENTS.md` with the `payload.override` purpose (clear_thinking 400 suppression for older Anthropic models), the affected model set, and the management-API merge delivery path.
- Document the sensitive rollback artifact lifecycle and the Go/No-Go/rollback checks in `apps/cliproxy/AGENTS.md`; never include example key values or raw config output.
- Changeset: only if `packages/cli` user-facing behavior changes; a droplet-config + deploy-internal change does not warrant one. `deploy.ts`/shared-helper changes are internal, but if the shared helper is user-observable via the CLI, add a patch changeset.
- After live verification, coordinate the `FRO_BOT_MODEL` stopgap revert in `fro-bot/agent`.

## Sources & References

- Issue: #1036; downstream impact fro-bot/agent#1314; failing runs 30842478774, 30860153753 vs 30860341225.
- Regression correlation: PR #1031 (cliproxy → `v7.2.116`).
- Live probe: 2026-08-04 three-way test against `cliproxy.fro.bot` (baseline 400 / `context_management:{edits:[]}` 200 / sonnet-5 200).
- Code: `apps/cliproxy/config/config.yaml`, `apps/cliproxy/src/deploy.ts`, `packages/shared/cliproxy/management.ts`, `apps/cliproxy/src/deploy.test.ts`, `apps/cliproxy/AGENTS.md`.
- Learnings: `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md`, `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md`, `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`.
- Upstream: `router-for-me/CLIProxyAPI` `config.example.yaml` @ `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1` (`payload.override` schema); Anthropic `clear_thinking_20251015` context-editing docs.
- Source-authority contract: CLIProxyAPI `v7.2.117` tag SHA `82d6242098a707fcca8eaefa43aaf3a10ea760f1`; `internal/api/server.go` route registration; `internal/api/handlers/management/config_basic.go` raw-YAML GET/PUT whole-document replacement + reload; `internal/api/handlers/management/config.go` incomplete JSON config response. GitHub compare from `v7.2.116` (`a88197f...`) shows the relevant executor, cloaking, payload-helper, and config-basic files unchanged.
