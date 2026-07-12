---
title: 'feat: Cut the gateway daemon over to fro-bot/agent v0.51.0 (workspace mention loop)'
type: feat
status: completed
date: 2026-06-03
---

# feat: Cut the gateway daemon over to fro-bot/agent v0.51.0 (workspace mention loop)

## Overview

Move the self-hosted Fro Bot gateway daemon on `gateway.fro.bot` from `fro-bot/agent@v0.46.3` to `v0.51.0`, enabling the workspace mention loop (`/fro-bot add-project` repo cloning + `@fro-bot` mention → OpenCode execution routed through `cliproxy.fro.bot`). v0.51.0 is the release that fixes the v0.50.0 undeployable defect (upstream #738, closed 2026-06-03) **and** ships the real workspace agent.

The deploy-side secret materialization for this loop already shipped in PR #387 (it was built against v0.50.0 and is dormant on `main`). This plan is the **cutover tail**: a daemon-level preflight, the pin bump, the Renovate ceiling lift, docs, and the gated production cutover with a proven rollback.

## Problem Frame

The daemon has been held at `v0.46.3` (Renovate ceiling `<0.47.0`) since issue #373, because the workspace agent was a `sleep infinity` placeholder through v0.49.0 and the v0.50.0 attempt crash-looped in production. The v0.50.0 cutover (deploy run `26853064449`) failed because the daemon hard-required `GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` via the throwing `readSecret`, while its own `deploy/compose.yaml` wired neither — undeployable as shipped (documented in `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md`, escalated as upstream #738).

**v0.51.0 resolves both hold conditions, verified at the tag this session:**
1. **The #738 defect is fixed.** `packages/gateway/src/config.ts` at `v0.51.0` reads `GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` via `readOptionalSecret` (no longer throwing), and `deploy/compose.yaml` documents them commented-out as an opt-in pair. The release is deployable as shipped.
2. **The workspace agent ships for real.** `apps/workspace-agent/` exists with real `src`, and `deploy/workspace.Dockerfile` builds it ("clone API + OpenCode SDK server + bearer proxy") — no placeholder.

Residual risk class carried over from the v0.50.0 plan: **LLM execution surface** — the mention loop feeds Discord messages + cloned repo content into OpenCode, introducing prompt-injection exposure and LLM spend. Containment is unchanged: the mitmproxy egress allowlist + the required `GATEWAY_TRIGGER_ROLE_ID` authorization gate (already enforced fail-closed in `deploy.ts` from #387).

## Requirements Trace

- R1. Gateway daemon runs `fro-bot/agent@v0.51.0`; all three services (gateway, workspace, mitmproxy) healthy.
- R2. `/fro-bot add-project` completes the clone step (workspace `/clone` reachable and functional).
- R3. `@fro-bot` mention loop works end-to-end: a mention from an authorized role triggers OpenCode execution through `cliproxy.fro.bot` and returns a result in Discord.
- R4. Daemon-level preflight (not workspace-only) proves the **gateway** service passes `loadGatewayConfig` (no `Missing required secret`) and builds/starts on v0.51.0 with the real materialized secrets, before the production pin moves. This catches the exact v0.50.0 failure class (which was a config-load throw); full live-operation proof is deferred to the gated cutover, which is the real production deploy with rollback ready.
- R5. Daemon pin bumped `v0.46.3` → `v0.51.0`; Renovate ceiling raised `<0.47.0` → `<0.52.0` with dashboard approval + `automerge: false` retained; stale ceiling comment corrected.
- R6. `apps/gateway/AGENTS.md` (and root `AGENTS.md` if needed) reflect the v0.51.0 contract + mention-loop operation; issue #373 closed in first person citing the verified resolution.

## Scope Boundaries

- **Not** re-implementing the deploy-side secret materialization — `WORKSPACE_OPENCODE_TOKEN`, `WORKSPACE_OPENCODE_AUTH`, `WORKSPACE_OPENCODE_URL`, `GATEWAY_TRIGGER_ROLE_ID`, `WORKSPACE_OPENCODE_MODEL`, `WORKSPACE_OPENCODE_CONFIG` already materialize via `deploy.ts` (#387) and pass through the workflow (both call paths). This plan does not touch that wiring except to verify it.
- **Not** enabling the opt-in presence/announce webhook — `GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` stay unset (optional in v0.51.0). No `POST /v1/announce` presence feature in this cutover.
- **Not** adding public HTTP ingress — the `:3000` announce server is container-internal (no published host port, verified at v0.51.0). Surface stays Discord-outbound + S3 + cliproxy-egress (via mitmproxy).
- **Not** changing the workflow Action SHA-pin (`fro-bot/agent@...` in `.github/workflows/fro-bot.yaml`) — a separate Renovate-owned consumer from the daemon `upstream.json` pin.
- **Not** broadening the mitmproxy egress allowlist.

### Deferred to Separate Tasks

- **CI-built immutable images**: building fresh upstream images on the production droplet remains brittle; moving to CI-built digest-pinned images is future hardening.
- **Secret-rotation runbook** for `workspace-opencode-token` / `workspace-opencode-auth`: a dedicated rotation procedure — follow-up runbook, not a cutover blocker.

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/upstream.json` — daemon pin (`v0.46.3`); the file the droplet git-clones and builds.
- `apps/gateway/src/deploy.ts:90-104` — `REQUIRED_ENV_VARS` (already includes `WORKSPACE_OPENCODE_TOKEN`, `WORKSPACE_OPENCODE_AUTH`, `GATEWAY_TRIGGER_ROLE_ID`); `buildSecretFileList` (~452) already materializes the workspace secret files. Shipped in #387 — verify, don't re-implement.
- `apps/gateway/src/deploy.ts` — `validateWorkspaceConfig` (JSON-parse + newline/size + cliproxy-baseURL guard) and the macOS-safe ControlPath + PEM `\n` handling (PRs #391/#389) are all on `main`.
- `.github/workflows/deploy-gateway.yaml` — `workflow_call.secrets:` schema + deploy-step env already carry the workspace inputs (#387).
- `.github/renovate.json5` — `fro-bot/agent` github-releases rule (`allowedVersions` ceiling `<0.47.0`, `dependencyDashboardApproval`, `automerge: false`) + `upstream.json` custom manager.
- `apps/gateway/src/deploy.ts` materializer is also the **rollback tool** — reverting `upstream.json` to `v0.46.3` and redeploying is the proven recovery path (used in the v0.50.0 incident).

### Institutional Learnings

- `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` — **the** lesson driving this plan: the daemon's config loader (`readSecret`) is authoritative for boot-required secrets, NOT compose. Invariant: REQUIRED (loader) ⊆ WIRED (compose). An isolated single-service preflight does not validate the daemon's contract.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — probe the exact pinned image; verify reviewer/release claims against the pinned tag; anchor cutover with backup + smoke test.
- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — deploy must `--build` (already in `deploy.ts`); a moved pin that never rebuilt hid a broken image.

### Verified Contract (at tag v0.51.0, this session)

`config.ts` required secrets (`readSecret`, throwing): `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `S3_BUCKET`, `S3_REGION`, `GITHUB_APP_ID`, `WORKSPACE_OPENCODE_TOKEN` — **all wired** in `deploy/compose.yaml` via `_FILE` env + bind-mount. `GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` are now `readOptionalSecret` (opt-in, commented-out in compose). `GATEWAY_TRIGGER_ROLE_ID` is `readOptionalSecret` upstream but our deploy enforces it fail-closed (stricter, safe). The invariant REQUIRED ⊆ WIRED **holds** at v0.51.0 — the release is deployable as shipped.

## Key Technical Decisions

- **Daemon-level preflight, not workspace-only.** The v0.50.0 incident's root lesson: a workspace-only preflight gave false-green while the gateway daemon's secret contract was never exercised. This preflight builds + boots the **gateway** service (the one whose contract changed) on an isolated droplet compose project with real materialized secrets, and proves it reaches healthy — before the production pin moves.
- **Verify the shipped #387 wiring rather than re-implement.** Units 1-3 of the v0.50.0 plan already landed. This plan verifies `deploy.ts` materializes exactly v0.51.0's required set (confirmed: it's a compatible superset) instead of redoing the work.
- **Renovate ceiling `<0.52.0`, not removed.** For `0.x`, minors are effectively majors; keep dashboard approval + no automerge so the next minor still gets a source-contract verification pass before landing.
- **Cutover IS the mention-loop validation.** The target is the operator's own guild, not a public service; no separate staging guild. The rollback path (revert pin → redeploy) is proven, so the blast radius is bounded and reversible.
- **Webhook/presence stay opt-in-off.** v0.51.0 makes them optional; this deployment does not need the presence webhook, so they remain unset. Enabling them is a separate reviewed change (both-or-neither, per upstream's compose note).

## Open Questions

### Resolved During Planning

- Does v0.51.0 fix the v0.50.0 undeployable defect (#738)? → **Yes** — `readOptionalSecret` for webhook/presence, opt-in in compose; verified at the tag.
- Does the workspace agent ship for real at v0.51.0? → **Yes** — `apps/workspace-agent/` + a real `workspace.Dockerfile` build.
- Does our shipped `deploy.ts` (#387) already materialize v0.51.0's required set? → **Yes** — a compatible superset; no re-implementation needed.
- Is the `:3000` announce server a public ingress? → **No** — container-internal, no published host port.
- Are the workspace secrets already seeded in the `gateway` GitHub Environment? → Seeded for the v0.50.0 attempt (`WORKSPACE_OPENCODE_TOKEN/AUTH/MODEL/CONFIG`, `GATEWAY_TRIGGER_ROLE_ID`); **verify presence at preflight time** before relying on them.

### Deferred to Implementation

- Exact from-scratch `--build` + boot-to-healthy time for the **gateway** service vs the deploy `--wait-timeout` — measure at preflight; raise the timeout only if it approaches the limit (the v0.50.0 workspace build was ~203s but the timeout applies to the wait phase, not the build).
- Whether `gateway status` needs a label tweak now that `workspace` reports a real health state (cosmetic; confirm against live output post-cutover).

## Implementation Units

- [ ] **Unit 1: Daemon-level preflight on the droplet (operational gate, no committed change)**

**Goal:** Prove the v0.51.0 **gateway** service boots healthy with real materialized secrets, on an isolated compose project disjoint from `/opt/gateway`, before the production pin moves.

**Requirements:** R4

**Dependencies:** Workspace secrets present in the `gateway` GitHub Environment + local `.env` (verify first). v0.51.0 contract verified (done).

**Files:** None committed — this is an SSH-driven operational preflight. (The orchestrator runs it on the droplet, materializing temp secrets the same way `deploy.ts` does — never hand-created, never argv.)

**Approach:**
- On the droplet, clone `fro-bot/agent@v0.51.0` to a temp path **disjoint from `/opt/gateway`**, materialize a temp `secrets/*` set (real values for the required `readSecret` list, including a real `workspace-opencode-token` and `workspace-opencode-auth`), under a **separate compose project name**.
- Build + start the **gateway** service (and its deps as compose requires) — the service whose contract changed — and prove it reaches healthy without `Missing required secret`. This is the explicit correction of the v0.50.0 workspace-only preflight.
- Measure from-scratch `--build` + boot-to-healthy; note against `--wait-timeout`.
- Capture `docker compose logs gateway` + disk delta; tear down the temp project + paths.
- **Discord-session handling (no live duplicate on the production token).** The gateway service opens a Discord session, and there is no disposable bot token available. So the preflight gate is deliberately **config-load + build/start**, NOT sustained live operation: prove the gateway container builds and boots far enough that `loadGatewayConfig` passes (the secret contract is satisfied — no `Missing required secret`), which is the *exact* phase that failed at v0.50.0. Stop before allowing a sustained second Discord connection on the production token (tear down immediately once config-load is proven, or run with the Discord connect step neutralized). The full live mention-loop proof is the gated cutover itself (single daemon, production token, rollback ready) — not the preflight. Do **not** accept a "brief duplicate-session window" on the production token as a substitute.
- **Secret scrub (required).** The temp `secrets/*` contain real material (`workspace-opencode-token`, real `workspace-opencode-auth`). Securely delete the temp secrets dir and the temp clone on teardown and **verify they are gone** (`ls` returns nothing) — do not rely on a bare `rm -rf` without confirmation. No real secret material may persist on the droplet outside `/opt/gateway`'s normal deploy-managed paths.

**Execution note:** Operational verification, not code. No repo change lands from this unit.

**Test scenarios:** `Test expectation: none -- operational preflight; the gate is "gateway service passes loadGatewayConfig (no Missing required secret) and builds/starts on v0.51.0 with real secrets".`

**Verification:** gateway service builds and boots past `loadGatewayConfig` (no `Missing required secret`) on v0.51.0; no sustained duplicate Discord session left on the production token; build+boot time recorded; temp secrets securely deleted and **verified absent**; temp project + paths removed; `/opt/gateway` untouched.

- [ ] **Unit 2: Bump daemon pin to v0.51.0 + raise Renovate ceiling**

**Goal:** Move the committed pin and ceiling; correct stale rationale.

**Requirements:** R1, R5

**Dependencies:** Unit 1 passed.

**Files:**
- Modify: `apps/gateway/upstream.json` (`v0.46.3` → `v0.51.0`)
- Modify: `.github/renovate.json5` (`<0.47.0` → `<0.52.0`; correct the held-at-v0.46.3 / v0.50.0-undeployable comment to the verified v0.51.0 reality)

**Approach:** single-line `ref` bump; ceiling `<0.52.0` (allow v0.51.x patch/hotfix); retain `dependencyDashboardApproval: true` + `automerge: false`; rewrite the comment to cite #738-fixed-in-v0.51.0.

**Test scenarios:** `Test expectation: none -- pin/config; validated by renovate-config-validator + the conventions test.`

**Verification:** valid JSON `v0.51.0`; `npx renovate-config-validator` passes; comment accurate.

- [ ] **Unit 3: Docs + correct #373**

**Goal:** Update operator docs to the v0.51.0 + mention-loop contract; close the public record.

**Requirements:** R2, R3, R6

**Dependencies:** Unit 2.

**Files:**
- Modify: `apps/gateway/AGENTS.md` (daemon version → v0.51.0; mention-loop operation; the workspace secret contract; drop any held-at-v0.46.3 note; webhook/presence documented as opt-in-off; verification ritual)
- Modify: root `AGENTS.md` only if the gateway version/secret list there needs it

**Approach:** document the v0.51.0 contract, the mention-loop operation + authz gate, the opt-in-off presence webhook, and the post-cutover verification ritual (status → workspace logs → real `add-project` → authorized `@fro-bot` mention round-trip). Close #373 on GitHub in first person citing the verified v0.51.0 resolution + the compound doc — issue action, not a file change.

**Test scenarios:** `Test expectation: none -- documentation.`

**Verification:** AGENTS.md matches the verified v0.51.0 contract; no stale held-at/undeployable references; #373 closed with the resolution recorded.

## System-Wide Impact

- **Interaction graph:** workspace becomes a real participant; gateway hard-depends on `workspace-opencode-token` (boot) and the workspace executes OpenCode against `cliproxy.fro.bot` using `workspace-opencode-auth`. Discord `@mention` (authorized role) → gateway → workspace `:9200` → cliproxy → model.
- **Error propagation:** missing required inputs → fail-closed in `validateRequiredEnv` before SSH (already shipped, #387); fresh-build failure → caught by the daemon-level preflight (Unit 1) before the pin moves.
- **State lifecycle risks:** `git clean -xfd` wipes untracked droplet files → all secrets flow through deploy materialization, never hand-created (ordering already correct in `deploy.ts`).
- **API surface parity:** no change — `gateway deploy --local` env forwarding and the workflow `workflow_call` schema already carry all inputs (#387). Verified, not modified.
- **Security boundary:** the workspace runs on `sandbox-net` (`internal: true`) — no direct external egress; all outbound forced through mitmproxy, whose allowlist is the containment boundary (not broadened). The trigger-role gate bounds WHO can spend. **Honest limit:** prompt injection is contained, not eliminated — an *authorized* role-holder is still an untrusted-content source (Discord message + cloned repo content feed the LLM). `internal: true` + the egress allowlist bound the blast radius; they do not stop a determined authorized user from misusing the agent within the allowed surface. Accepted for v1; the trigger-role gate is the spend/abuse control.
- **Unchanged invariants:** no public HTTP ingress; workflow Action SHA-pin untouched; existing discord/s3/aws/github-app secrets unchanged; the deploy-side secret wiring from #387 is unchanged (verified only).

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Fresh-build fragility on the production droplet (`--build`) | Med | High | Daemon-level isolated preflight (Unit 1) gates the pin bump; failure → wait for v0.51.x |
| Preflight Discord session collides with the production daemon | Med | Med | Use a disposable token, or stop at config-load proof and defer full live proof to the gated cutover; tear down promptly |
| `--build` + boot exceeds `--wait-timeout` → false-fail cutover | Low | Med | Unit 1 measures build+boot; raise timeout only if near (timeout applies to wait phase, not build) |
| Prompt-injection / abuse via `@fro-bot` mention (untrusted Discord + repo content → LLM) | Med | High | Required trigger-role authz gate (shipped); mitmproxy egress allowlist containment; dedicated revocable cliproxy key |
| Uncontrolled LLM spend | Med | Med | Trigger-role gate limits who triggers; dedicated scoped key enables per-key accounting + revocation |
| Preflight on shared droplet perturbs live `/opt/gateway` | Low | Med | Temp path disjoint from `/opt/gateway`, separate compose project, torn down after |
| v0.51.0 has an as-yet-undiscovered fresh defect (day-old release) | Low | High | Preflight + gated cutover + proven `v0.46.3` rollback (revert pin → redeploy; v0.46.3 needs none of the new secrets) |

## Phased Delivery

### Phase 0 — Preflight gate (Unit 1, no committed change)
- Verify the workspace secrets are still present in the `gateway` GitHub Environment + `.env`.
- Daemon-level preflight on the droplet (above). **Gate:** gateway service reaches healthy / config-load passes on v0.51.0 → proceed; fail → stop.

### Phase 1 — Cutover (Units 2-3)
- Bump `upstream.json` → v0.51.0, raise Renovate ceiling, docs. Open the PR; on merge, approve the gated deploy.
- **Post-cutover verification (in order):** `gateway status` (all three services healthy) → `docker compose logs workspace --tail 100` → real `/fro-bot add-project` clone smoke → authorized `@fro-bot` mention round-trip through cliproxy. Discord command registration alone does NOT prove the workspace works (the v0.46.1 lesson).
- **Rollback (proven):** if any service or the mention loop is broken post-cutover, revert `apps/gateway/upstream.json` to `v0.46.3` and redeploy via the materializer (same path as the v0.50.0 incident recovery). v0.46.3 needs none of the new secrets, so rollback is clean. Capture `docker compose logs` before reverting.

## Documentation / Operational Notes

- After cutover, verify in this order: `gateway status` → `docker compose logs workspace --tail 100` → real `/fro-bot add-project` smoke → authorized `@fro-bot` mention round-trip. Registration ≠ working daemon.
- The gateway's stateful surface remains the mitmproxy CA (unchanged). The new `workspace-opencode-token`/`-auth` are stateless GitHub-Environment-sourced; rotation runbook is a deferred follow-up.
- On a successful cutover, the queued `0.9.10` release note (corrected in PR #393 to "staged, not yet live") can be updated again in a future release to reflect the loop going live — or noted in the cutover's own changeset.

## Sources & References

- Issue: #373 (gateway hold — resume-trigger now met; to be closed with the verified resolution)
- Upstream: `fro-bot/agent` #738 (v0.50.0 undeployable defect — CLOSED, fixed in v0.51.0); v0.51.0 release (2026-06-03)
- Prior plan: `docs/plans/2026-06-02-001-feat-gateway-v0500-workspace-agent-upgrade-plan.md` (v0.50.0 attempt — historical; its Units 1-3 shipped via PR #387)
- Compound doc: `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` (the undeployable-upstream incident + the daemon-loader-vs-compose lesson)
- Verified contract: `fro-bot/agent` `packages/gateway/src/config.ts` + `deploy/compose.yaml` @ tag `v0.51.0`
- Related code: `apps/gateway/src/deploy.ts`, `apps/gateway/upstream.json`, `.github/workflows/deploy-gateway.yaml`, `.github/renovate.json5`
- Learnings: `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md`, `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md`
