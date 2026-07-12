---
title: 'feat: Upgrade gateway daemon to fro-bot/agent v0.50.0 with workspace mention loop'
type: feat
status: superseded
date: 2026-06-02
---

# feat: Upgrade gateway daemon to fro-bot/agent v0.50.0 with workspace mention loop

## Overview

Upgrade the self-hosted Fro Bot gateway daemon on `gateway.fro.bot` from `fro-bot/agent@v0.46.3` to `v0.50.0`, and wire the full workspace capability end-to-end: `/fro-bot add-project` repo cloning **and** the `@fro-bot` mention loop (Discord-message-triggered OpenCode execution). v0.50.0 is the first release where the upstream workspace agent is a real build (Hono server on `:9100` serving `/healthz` + `/clone`, OpenCode bearer proxy on `:9200`, OpenCode SDK on `:54321` loopback) rather than a `sleep infinity` placeholder.

This delivers a user-visible capability: a usable workspace agent that clones repos and acts on `@fro-bot` mentions, routed through `cliproxy.fro.bot` like the rest of our Fro Bot wiring.

## Problem Frame

The gateway has been pinned at `v0.46.3` with a Renovate ceiling `<0.47.0` since issue #373, because every release through v0.49.0 shipped an idle placeholder workspace container. At v0.50.0 the workspace agent ships for real (upstream PR #725, merge `805c58c`), so #373's resume-trigger is met.

This upgrade carries **two stacked risk classes**:
1. **Fresh-build fragility** — v0.50.0 was released 2026-06-02 (day-old at planning time); the daemon has crash-looped on fresh builds before (v0.46.1 `ERR_MODULE_NOT_FOUND`, v0.48.1 packaging hotfix #708), and our deploy runs `docker compose up -d --build` on the droplet.
2. **LLM execution surface** — the mention loop feeds Discord messages and cloned repo content into OpenCode execution. This introduces prompt-injection exposure, LLM spend, and an authorization question (who may trigger it). The mitmproxy egress allowlist is the existing containment boundary; an authorization gate (`gateway-trigger-role-id`) bounds who can spend.

Both are addressed: risk class 1 via an isolated droplet preflight that gates the pin bump; risk class 2 via a dedicated scoped cliproxy key (revocable, accountable), a required trigger-role authorization gate, and reliance on the upstream mitmproxy egress allowlist.

## Requirements Trace

- R1. Gateway daemon runs `fro-bot/agent@v0.50.0`, all three services healthy (gateway, workspace, mitmproxy).
- R2. `/fro-bot add-project` completes the clone step (workspace `/clone` reachable and functional).
- R3. `@fro-bot` mention loop works end-to-end: a mention from an authorized user triggers OpenCode execution routed through `cliproxy.fro.bot` and returns a result in Discord.
- R4. New required secrets materialized via the existing stdin-pipe path (never argv, never hand-created): `workspace-opencode-token` (internal shared bearer) and `workspace-opencode-auth` (provider auth.json from a dedicated scoped cliproxy key).
- R5. `WORKSPACE_OPENCODE_MODEL` + `WORKSPACE_OPENCODE_CONFIG` materialized into the droplet `.env` with strict single-line-JSON / shell-metachar validation (mirroring the umami `.env` precedent).
- R6. Authorization gate: `GATEWAY_TRIGGER_ROLE_ID` is in `REQUIRED_ENV_VARS` and enforced non-empty before deploy, so only a designated Discord role can trigger the mention loop (bounds LLM spend + abuse). Not an optional slot in this deployment.
- R7. Deploy fails closed before any SSH when any required input is unset (`WORKSPACE_OPENCODE_TOKEN`, `WORKSPACE_OPENCODE_AUTH`, `GATEWAY_TRIGGER_ROLE_ID`, `WORKSPACE_OPENCODE_MODEL`, `WORKSPACE_OPENCODE_CONFIG`). Since this deployment always enables the mention loop, the full set is unconditionally required — no partial-set activation predicate to misjudge.
- R8. Renovate ceiling raised to `<0.51.0` with dashboard approval retained; stale ceiling comment (false v0.47.0 webhook/ingress story) corrected.
- R9. `apps/gateway/AGENTS.md` reflects the v0.50.0 contract + mention-loop operation; issue #373's incorrect secret/ingress analysis corrected in first person.

## Scope Boundaries

- **Not** adding any public HTTP ingress — v0.50.0 has no `ports:` host mappings; surface stays Discord-outbound + S3 + cliproxy-egress (via mitmproxy) only.
- **Not** adding `GATEWAY_WEBHOOK_SECRET` or `GATEWAY_PRESENCE_CHANNEL_ID` — verified absent from every compose file v0.46.3→v0.50.0 (issue #373's claim was wrong; the webhook feature is outbound).
- **Not** changing the workflow Action SHA-pin (`fro-bot/agent@...` in `.github/workflows/fro-bot.yaml`) — separate Renovate-owned consumer from the daemon `upstream.json` pin.
- **Not** broadening the mitmproxy egress allowlist — the existing `OBJECT_STORE_HOSTS`-derived allowlist is the containment boundary; any new egress need is a separate reviewed change.

### Deferred to Separate Tasks

- **CI-built immutable images**: building fresh upstream images on the production droplet is brittle; moving toward CI-built digest-pinned images is future hardening, not this upgrade.
- **Secret-rotation runbook** for `workspace-opencode-token` / `workspace-opencode-auth`: a dedicated rotation procedure (the shared bearer + provider key both need documented rotation) — track as a follow-up runbook, not a blocker for this cutover.

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/upstream.json` — daemon pin (`v0.46.3`); the file the droplet git-clones.
- `apps/gateway/src/deploy.ts:89-123` — `REQUIRED_ENV_VARS` + `validateRequiredEnv()` (fail-closed gate before SSH).
- `apps/gateway/src/deploy.ts` `buildSecretFileList()` (~275-301) — the secret-file materialization list (required vs optional, kebab-case names, env sources). Exact pattern new secrets follow.
- `apps/gateway/src/deploy.ts:75-79` — `REMOTE_DIR`/`DEPLOY_DIR`/`SECRETS_DIR` + checksum-outside-deploy note; secret writes at `766/785/851` run **after** `git clean -xfd` (`738`), so the wipe-ordering risk is already handled.
- `apps/gateway/src/deploy.ts:785` — current `.env` write (only `OBJECT_STORE_HOSTS`); the insertion point for model/config.
- `apps/umami/src/deploy.ts:31,81-82,172-181` — `SHELL_METACHAR_RE`, `validateSecretValue()`, `buildEnvFileContents()` — the **precedent** for validated `.env` value materialization (R5).
- `packages/cli/src/commands/gateway/deploy.ts:18-54` — `getGatewayDeployEnv()` local-deploy env allowlist; new vars added here for `--local` parity.
- `.github/workflows/deploy-gateway.yaml:11-12` — explicit `workflow_call.secrets:` schema **and** the deploy-step env; `GH_APP_*` appear in BOTH and are the mirror pattern for new secrets.
- `.github/renovate.json5:53-91` — `fro-bot/agent` github-releases rule (`allowedVersions`, `dependencyDashboardApproval`, `automerge: false`) + `upstream.json` custom manager.
- `apps/gateway/server/provision-droplet.ts:80` — `fro-bot-gateway` key-naming precedent for a dedicated scoped key.

### Institutional Learnings

- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — probe the exact pinned image, trace breaks to code edits, verify reviewer claims against the pinned image, anchor cutover with backup + smoke test.
- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — deploy must `--build`; stale-image reuse hid the v0.46.1 packaging crash.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — `git clean -xfd` wiped untracked secret files (recovered); first-deploy cascade context.

### Verified Contract Delta (v0.46.3 → v0.50.0)

Source-verified by reading `deploy/compose.yaml` at tag `v0.50.0` directly:

| Secret file (host `./secrets/`) | Env (`*_FILE`) | This plan treats as | New at v0.50.0? |
|---|---|---|---|
| `workspace-opencode-token` | `WORKSPACE_OPENCODE_TOKEN_FILE` (gateway + workspace) | **Required** (gateway won't boot) | ✅ |
| `workspace-opencode-auth` | `WORKSPACE_OPENCODE_AUTH_FILE` (workspace) | **Required** (mention loop) | ✅ |
| `workspace-opencode-url` | `WORKSPACE_OPENCODE_URL_FILE` | Optional (default `http://workspace:9200`) | ✅ |
| `gateway-trigger-role-id` | `GATEWAY_TRIGGER_ROLE_ID_FILE` | **Required by this deployment** (in `REQUIRED_ENV_VARS`; fail-closed if empty) — authz gate, R6 | ✅ |

- `.env` (not secrets): `WORKSPACE_OPENCODE_MODEL`, `WORKSPACE_OPENCODE_CONFIG` — operator config, route the workspace provider/baseURL through `cliproxy.fro.bot/v1`.
- Workspace gains a real two-stage build + `/healthz` healthcheck (`start_period 45s`).
- No new `ports:` host mappings (no public ingress). Workspace `:9100`/`:9200` on internal `sandbox-net`, `:54321` loopback.
- `#713` (add-project first-use S3 `NoSuchKey` deadlock) already fixed at v0.49.0 → non-issue.

## Key Technical Decisions

- **Full mention loop in this cutover.** Clone-only was considered and rejected as a half-step (reviewers: proves cloneability, not a usable agent). Ship the user-visible capability end-to-end.
- **`WORKSPACE_OPENCODE_TOKEN` = generated GitHub Environment secret** — internal shared bearer between gateway and the workspace `:9200` proxy; random value, not derived, not regenerated per-deploy (avoids checksum churn / forced recreates).
- **`workspace-opencode-auth` = dedicated scoped cliproxy key**, NOT the repo's existing `OPENCODE_AUTH_JSON` — separate revocation path, cleaner accounting, lower blast radius if the droplet is compromised, and decouples CI Fro Bot runs from the production Discord daemon. Same `cliproxy.fro.bot/v1` baseURL pattern; gateway-specific bearer (auth.json shape `{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}` with the scoped key).
- **Authorization gate is required by this deployment, fail-closed.** Upstream's compose treats `gateway-trigger-role-id` as an optional slot (empty = open to all guild members), but THIS deployment makes it mandatory: `GATEWAY_TRIGGER_ROLE_ID` is added to `REQUIRED_ENV_VARS` and a non-empty value is enforced before any SSH/deploy. Without it, any guild member could trigger LLM execution (spend + prompt-injection exposure). It is NOT modeled as an optional slot anywhere in this plan.
- **`.env` config validation must NOT reuse umami's `SHELL_METACHAR_RE`.** `WORKSPACE_OPENCODE_CONFIG` is a JSON blob — and `SHELL_METACHAR_RE` rejects `"`, `$`, and `\`, which valid JSON requires, so inheriting umami's value validator would reject every valid config. Instead: validate `WORKSPACE_OPENCODE_CONFIG` by `JSON.parse` (structural validity) + reject embedded newlines + size cap, then write it to `.env` with a dotenv-safe strategy (single-quoted value or base64) so docker-compose interpolation does not mangle `$`/quotes. The umami `validateSecretValue`/`SHELL_METACHAR_RE` pattern still applies to `WORKSPACE_OPENCODE_MODEL` (a simple id like `anthropic/claude-sonnet-4-6`, no quotes).
- **Isolated droplet preflight gates the pin bump** — build + boot the workspace from `v0.50.0` (with real auth.json mounted) on a temp path disjoint from `/opt/gateway`, prove `/healthz` + `/clone`, and **measure build+boot time** against the deploy `--wait-timeout`. The full mention loop is validated at cutover (it needs the gateway+Discord, which the preflight deliberately does not start to avoid a duplicate Discord session).
- **Renovate ceiling `<0.51.0`, not removed** — for `0.x`, minors are effectively majors; keep dashboard approval + no automerge.

## Open Questions

### Resolved During Planning

- Does v0.47.0 add required `GATEWAY_WEBHOOK_SECRET`/`GATEWAY_PRESENCE_CHANNEL_ID` + public HTTP ingress? → **No** — verified absent from all compose files; #373 was wrong.
- Is the workspace agent real at v0.50.0? → **Yes** — two-stage build + Hono `/clone` + `/healthz`; v0.49.0 was still `sleep infinity`.
- Clone-only vs full mention loop? → **Full mention loop** (user decision; clone-only judged a half-step).
- Should the workspace reuse `OPENCODE_AUTH_JSON` or get its own key? → **Dedicated scoped cliproxy key** (Oracle: revocation/accounting/blast-radius).
- Is `gateway-trigger-role-id` optional? → **Required-to-set** for this plan (authz over LLM spend).

### Deferred to Implementation

- Whether `getGatewayComposeStatus` / `gateway status` surfaces the `workspace` health row or needs a label tweak now that it reports a real health state.
- Exact OpenCode model id for `WORKSPACE_OPENCODE_MODEL` — confirm against live `/v1/models` at implementation time (proxy rejects unknown ids); default candidate `anthropic/claude-sonnet-4-6` or an OpenAI id per current routing.

## Implementation Units

- [ ] **Unit 1: Materialize v0.50.0 workspace secrets + fail-closed gates in deploy.ts**

**Goal:** Teach `deploy.ts` to materialize the new secret files and refuse to deploy without the boot-required + mention-loop-required inputs.

**Requirements:** R4, R6, R7

**Dependencies:** Preflight passed; `WORKSPACE_OPENCODE_TOKEN`, `WORKSPACE_OPENCODE_AUTH`, `GATEWAY_TRIGGER_ROLE_ID` seeded in the `gateway` GitHub Environment + local `.env`.

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (`REQUIRED_ENV_VARS`; `buildSecretFileList`; cross-field validation; possibly raise `--wait-timeout` per preflight)
- Modify: `packages/cli/src/commands/gateway/deploy.ts` (`getGatewayDeployEnv` allowlist)
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**
- Add `WORKSPACE_OPENCODE_TOKEN` and `WORKSPACE_OPENCODE_AUTH` to `REQUIRED_ENV_VARS` (fail-closed before SSH).
- Add `WORKSPACE_OPENCODE_TOKEN`, `WORKSPACE_OPENCODE_AUTH`, and `GATEWAY_TRIGGER_ROLE_ID` to `REQUIRED_ENV_VARS` (fail-closed before SSH). `WORKSPACE_OPENCODE_MODEL` + `WORKSPACE_OPENCODE_CONFIG` are required via Unit 2's `.env` materialization (also fail-closed).
- `buildSecretFileList`: add `workspace-opencode-token` ← `WORKSPACE_OPENCODE_TOKEN` (required), `workspace-opencode-auth` ← `WORKSPACE_OPENCODE_AUTH` (required), `workspace-opencode-url` ← `WORKSPACE_OPENCODE_URL` (optional, empty-when-unset), `gateway-trigger-role-id` ← `GATEWAY_TRIGGER_ROLE_ID` (written as a secret file, but its env var is in `REQUIRED_ENV_VARS` so an empty value aborts the deploy).
- **No activation predicate.** This deployment always runs the mention loop, so the full input set is unconditionally required. This deliberately avoids the "is the mention loop enabled?" predicate ambiguity (a partial/fat-fingered set fails closed because every member is in `REQUIRED_ENV_VARS`, not because a heuristic guessed intent).
- All writes via existing `writeRemoteFile()` stdin-pipe path (after `git clean -xfd`, into `SECRETS_DIR`). Forward all new env vars in the CLI `--local` allowlist.
- If Phase 0 preflight shows build+boot near `--wait-timeout 120`, raise it here.

**Execution note:** Test-first — add failing validation/materialization assertions before editing `deploy.ts`.

**Patterns to follow:** existing `github-app-id` (required) and `s3-endpoint` (optional empty-when-unset) entries; umami `validateSecretValue` for value hygiene.

**Test scenarios:**
- Happy path: full mention-loop env set → secret list includes all four new files with correct required flags + values.
- Error path: any of `WORKSPACE_OPENCODE_TOKEN` / `WORKSPACE_OPENCODE_AUTH` / `GATEWAY_TRIGGER_ROLE_ID` unset or empty → `validateRequiredEnv` returns it (abort before SSH).
- Error path: `GATEWAY_TRIGGER_ROLE_ID` present but empty string → still rejected (fail-closed authz gate, not open-to-all).
- Edge case: `workspace-opencode-url` unset → empty-content file, `required: false`.
- Happy path (CLI): `getGatewayDeployEnv` forwards all new vars when present.

**Verification:** missing required inputs abort pre-SSH; partial mention-loop set rejected; secret list correct; CLI parity; `bun test`, `tsc`, lint clean.

- [ ] **Unit 2: Materialize WORKSPACE_OPENCODE_MODEL/CONFIG into droplet .env with validation**

**Goal:** Write the workspace model + provider-config into `.env` safely.

**Requirements:** R3, R5

**Dependencies:** Unit 1.

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (the `.env` materialization at ~785; add a `buildEnvFileContents`-style helper)
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**
- Extend the `.env` write to include `WORKSPACE_OPENCODE_MODEL=<value>` and `WORKSPACE_OPENCODE_CONFIG=<value>` alongside `OBJECT_STORE_HOSTS`.
- **`WORKSPACE_OPENCODE_CONFIG` (JSON):** validate with `JSON.parse` (structural validity) + reject embedded newlines + a size cap. Do NOT use `SHELL_METACHAR_RE` — it rejects `"`/`$`/`\` which valid JSON requires. Write it to `.env` with a dotenv-safe strategy: single-quote the value (docker-compose does not interpolate inside single quotes) or base64-encode if the workspace entrypoint supports decode. Confirm at implementation which the upstream entrypoint expects.
- **`WORKSPACE_OPENCODE_MODEL` (simple id):** the umami `validateSecretValue`/`SHELL_METACHAR_RE` guard is appropriate here (a model id has no quotes/`$`).
- Materialize via the same stdin-pipe path as the existing `OBJECT_STORE_HOSTS` write.

**Execution note:** Test-first.

**Patterns to follow:** `apps/umami/src/deploy.ts` `buildEnvFileContents` structure (for the multi-line `.env` assembly) and `validateSecretValue` (for the MODEL id only, not the JSON config).

**Test scenarios:**
- Happy path: valid JSON config (containing `"`, `:`, `{}`) + model id → both pass validation; `.env` contains both lines + `OBJECT_STORE_HOSTS`, config written in the dotenv-safe form.
- Error path: config that is NOT valid JSON → `JSON.parse` validation throws before any SSH write.
- Error path: config containing an embedded newline → rejected (would break the `.env` line).
- Error path: model id containing a shell metachar → rejected by the MODEL guard.
- Integration: the written config survives docker-compose `.env` interpolation intact (the `$` in any baseURL/token is not expanded) — prove the single-quote/base64 choice holds.

**Verification:** valid JSON config passes and round-trips through `.env` unmangled; invalid JSON / multiline rejected; `SHELL_METACHAR_RE` is NOT applied to the config; tests/tsc/lint clean.

- [ ] **Unit 3: Pass new secrets/vars through the deploy workflow (both call paths)**

**Goal:** Wire the new GitHub Environment inputs into the workflow's `deploy.ts` invocation.

**Requirements:** R4, R5, R6

**Dependencies:** Units 1-2; secrets/vars created in the `gateway` environment.

**Files:**
- Modify: `.github/workflows/deploy-gateway.yaml`

**Approach:**
- Add to the **deploy-step env**: `WORKSPACE_OPENCODE_TOKEN`, `WORKSPACE_OPENCODE_AUTH`, `WORKSPACE_OPENCODE_URL`, `GATEWAY_TRIGGER_ROLE_ID` (secrets) and `WORKSPACE_OPENCODE_MODEL`, `WORKSPACE_OPENCODE_CONFIG` (variables or secrets).
- **Also extend the `workflow_call.secrets:` schema block** (lines ~11-12, currently ending at `DISCORD_PRIVILEGED_INTENTS`) for the secret-typed inputs — otherwise a reusable-workflow caller cannot pass them. Mirror `GH_APP_*`, which appear in both the schema and the step.
- Keep within the `environment: gateway` approval gate.

**Test scenarios:** `Test expectation: none -- workflow YAML; validated by the conventions YAML-parse test + a real gated deploy run.`

**Verification:** YAML parses; new inputs present in BOTH `workflow_call.secrets` and the deploy step; approval gate intact.

- [ ] **Unit 4: Bump daemon pin to v0.50.0 + raise Renovate ceiling**

**Goal:** Move the committed pin and ceiling; correct stale rationale.

**Requirements:** R1, R8

**Dependencies:** Units 1-3 merged + preflight passed — the pin bump triggers the real build on next deploy.

**Files:**
- Modify: `apps/gateway/upstream.json` (`v0.46.3` → `v0.50.0`)
- Modify: `.github/renovate.json5` (`<0.47.0` → `<0.51.0`; correct the false v0.47.0 webhook/ingress comment)

**Approach:** single-line `ref` bump; ceiling `<0.51.0` (allow v0.50.x patch/hotfix); retain `dependencyDashboardApproval: true` + `automerge: false`; rewrite the comment to the verified contract.

**Test scenarios:** `Test expectation: none -- pin/config; validated by renovate-config-validator + conventions test.`

**Verification:** valid JSON `v0.50.0`; `npx renovate-config-validator` passes; comment accurate.

- [ ] **Unit 5: Docs + post-deploy verification + correct #373**

**Goal:** Update operator docs to the v0.50.0 + mention-loop contract; correct the public record.

**Requirements:** R2, R3, R9

**Dependencies:** Units 1-4.

**Files:**
- Modify: `apps/gateway/AGENTS.md` (secret contract table incl. new files + `.env` vars, mention-loop operation, authz gate, drop held-at-v0.46.3 note, workspace `/healthz` notes)
- Modify: root `AGENTS.md` if the gateway secret list there needs the new names

**Approach:** document the new secrets (required/optional), the `.env` model/config + validation, the trigger-role authz gate, and the verification ritual (status + workspace logs + real add-project + a real authorized `@fro-bot` mention). Correct #373 on GitHub (first-person comment: verified contract, false claims retracted, trigger met) — issue edit, not a file change.

**Test scenarios:** `Test expectation: none -- documentation.`

**Verification:** AGENTS.md matches the verified contract; no stale held-at/false-secret references; #373 corrected.

## System-Wide Impact

- **Interaction graph:** workspace becomes a real participant; gateway hard-depends on `workspace-opencode-token` (boot) and the workspace executes OpenCode against `cliproxy.fro.bot` using `workspace-opencode-auth`. Discord `@mention` (from an authorized role) → gateway → workspace `:9200` → cliproxy → model.
- **Error propagation:** missing required inputs → fail-closed in `validateRequiredEnv` before SSH; partial mention-loop set → cross-field abort; fresh-build failure → caught by preflight before pin moves.
- **State lifecycle risks:** `git clean -xfd` wipes untracked droplet files → all secrets flow through deploy materialization, never hand-created. Secret writes already ordered after the clean (deploy.ts:738 → 766/785/851).
- **API surface parity:** `gateway deploy --local` env forwarding (Unit 1) must match the CI workflow env + `workflow_call` schema (Unit 3) — both carry all new inputs.
- **Security boundary:** the workspace runs on `sandbox-net`, declared `internal: true` in the v0.50.0 compose — it has NO direct external egress; all outbound traffic is forced through mitmproxy, whose allowlist (`OBJECT_STORE_HOSTS`-derived + the cliproxy host) is the containment boundary. Not broadened here. The trigger-role gate bounds WHO can spend. **Honest limit:** prompt injection is contained, not eliminated — an *authorized* role-holder is still an untrusted-content source (Discord message + cloned repo content feed the LLM), so they can steer the model within whatever tool/network access the workspace has. The `internal: true` + egress allowlist bounds the blast radius (no arbitrary exfil destination); it does not prevent a determined authorized user from misusing the agent within the allowed surface. Accepted for v1; the trigger-role gate is the spend/abuse control.
- **Unchanged invariants:** no public HTTP ingress; workflow Action SHA-pin untouched; existing discord/s3/aws/github-app secrets unchanged.

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| v0.50.0 day-old + fresh-build fragility (v0.46.1/v0.48.1 crash-loops) | Med | High | Isolated workspace-only droplet preflight gates the pin bump; failure → wait for v0.50.1 |
| Missing `workspace-opencode-token`/`-auth` → gateway boot-crash | Med | High | Both in `REQUIRED_ENV_VARS`; fail closed before SSH (Unit 1, R7) |
| `--build` + 45s start_period exceeds `--wait-timeout 120` → false-fail cutover | Med | Med | Phase 0 preflight measures build+boot; raise timeout in Unit 1 if near |
| Prompt-injection / abuse via `@fro-bot` mention (untrusted Discord + repo content → LLM) | Med | High | Required trigger-role authz gate (R6); mitmproxy egress allowlist containment; dedicated revocable cliproxy key |
| Uncontrolled LLM spend | Med | Med | Trigger-role gate limits who triggers; dedicated scoped key enables per-key accounting + revocation |
| `WORKSPACE_OPENCODE_CONFIG` JSON breaks `.env`/compose parse | Med | Med | Single-line + shell-metachar validation before materialization (Unit 2, umami precedent) |
| `git clean -xfd` wipes new secret files | Low | High | All secrets materialized from GitHub Environment after the clean; documented in Unit 5 |
| Preflight on shared droplet perturbs live `/opt/gateway` | Low | Med | Temp path disjoint from `/opt/gateway`, separate compose project, workspace-only (never gateway service) |

## Phased Delivery

### Phase 0 — Preflight gate (operational prerequisite, no committed change)
- Seed `WORKSPACE_OPENCODE_TOKEN`, `WORKSPACE_OPENCODE_AUTH` (dedicated scoped cliproxy key), `WORKSPACE_OPENCODE_MODEL`, `WORKSPACE_OPENCODE_CONFIG`, `GATEWAY_TRIGGER_ROLE_ID` in the `gateway` GitHub Environment + local `.env`.
- On the droplet: clone `fro-bot/agent@v0.50.0` to a temp path **disjoint from `/opt/gateway`**, create temp `secrets/*` (random token, **real** auth.json), build + start **workspace only** under a separate compose project name, then validate:
  1. **Build+boot proof:** workspace reaches healthy `/healthz` with the real auth.json mounted; `/clone` reachable.
  2. **Build-time measurement:** time the from-scratch `--build` + boot-to-healthy; if it approaches `--wait-timeout 120`, raise the timeout in `deploy.ts` (Unit 1) before Phase 2.
  3. Capture `docker compose logs workspace` + disk delta; tear down the temp project + paths.
- **Gate:** pass → proceed; fail → stop (wait for v0.50.1, or adjust timeout). The full mention loop is NOT validated here (needs gateway+Discord → would duplicate the live Discord session); it is validated at cutover.

### Phase 1 — Contract ready (Units 1-3)
- deploy.ts secret + `.env` materialization, fail-closed + cross-field validation, CLI parity, workflow passthrough (both call paths). Lands without moving the pin (no behavior change until pin bumps).

### Phase 2 — Cutover (Units 4-5)
- Bump `upstream.json` → v0.50.0, raise Renovate ceiling, docs. Approve the gated deploy; verify all three services healthy, `/fro-bot add-project` clone succeeds, and a real **authorized** `@fro-bot` mention completes end-to-end through cliproxy.
- **Cutover IS the mention-loop validation** (the target is the operator's own guild, not a public service). No separate staging guild — the blast radius is the operator's guild and the revert path is proven.
- **Rollback (proven):** if the mention loop or any service is broken post-cutover, revert `apps/gateway/upstream.json` to `v0.46.3` and re-deploy via the deploy materializer (the same path used in the v0.46.1→v0.44.2 incident recovery). The v0.46.3 contract needs none of the new secrets, so rollback is clean. Capture `docker compose logs workspace` before reverting for diagnosis.

## Documentation / Operational Notes

- After cutover, verify in this order: `gateway status` (all three services) → `docker compose logs workspace --tail 100` → real `/fro-bot add-project` smoke → authorized `@fro-bot` mention round-trip. Discord command registration alone does NOT prove the workspace works.
- The gateway's stateful surface remains the mitmproxy CA (unchanged by this upgrade). The new `workspace-opencode-token`/`-auth` are stateless GitHub-Environment-sourced; rotation runbook is a deferred follow-up.

## Sources & References

- Issue: #373 (gateway hold — resume-trigger met; facts to be corrected)
- Upstream: `fro-bot/agent` #727 (workspace agent shipped via PR #725 `805c58c`, released v0.50.0), #713 (S3 deadlock fixed v0.49.0)
- Verified contract: `fro-bot/agent` `deploy/compose.yaml` @ tag `v0.50.0`
- Related code: `apps/gateway/src/deploy.ts`, `apps/umami/src/deploy.ts` (`.env` validation precedent), `packages/cli/src/commands/gateway/deploy.ts`, `.github/workflows/deploy-gateway.yaml`, `.github/renovate.json5`, `apps/gateway/upstream.json`
- Learnings: `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md`, `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md`
