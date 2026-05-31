---
title: "feat: Adopt fro-bot/agent v0.46.x — GitHub App secret materialization + cutover"
type: feat
status: active
date: 2026-05-30
---

# feat: Adopt fro-bot/agent v0.46.x — GitHub App secret materialization + cutover

## Overview

The gateway daemon is held at `fro-bot/agent` v0.44.2 because v0.45.0+ requires two new bind-mounted secret files (`github-app-id`, `github-app-private-key`) that `apps/gateway/src/deploy.ts` does not materialize, plus an optional `discord-privileged-intents` file. v0.46.x ships the `/fro-bot add-project` capability (clone a repo via a GitHub App → create a Discord channel → persist a channel↔repo binding to S3).

This plan does the deploy-side work to adopt v0.46.x: materialize the new secret files, thread the new secrets through the workflow and CLI local-deploy paths, bump the pin, lift the Renovate ceiling, and cut over. The GitHub App's *identity* (registration, name "Fro Bot Agent", public docs page, logo, install-URL default) is owned by `fro-bot/agent` and tracked separately — this repo only consumes the App ID + private key.

## Problem Frame

Issue #341. The live gateway runs v0.44.2; the repo pin is held at v0.44.2 with a Renovate `allowedVersions: '<0.44.3'` ceiling (PR #342). v0.46.1's `deploy/compose.yaml` bind-mounts `github-app-id` + `github-app-private-key` (both `create_host_path: false`, so a missing source file fails `docker compose up`), read in the daemon as required secrets (`readSecret`/`readMultilineSecret` — throw on missing/empty → boot crash). The App is created and owned externally (the `fro-bot` account); this repo's job is to deliver the App ID + PEM to the droplet via the existing secret-file materialization pattern, then move the pin.

## Requirements Trace

- R1. `deploy.ts` materializes `github-app-id` and `github-app-private-key` (required) from `GH_APP_ID` / `GH_APP_PRIVATE_KEY` env, plus `discord-privileged-intents` (optional, empty-when-unset). (GitHub reserves the `GITHUB_` prefix for secret/variable/env names, so our Environment-secret and env-var names use `GH_APP_*`; the droplet file names remain `github-app-id` / `github-app-private-key`.)
- R2. `GH_APP_PRIVATE_KEY` (PEM, multiline) is written via the existing SSH-stdin byte-pipe path with a trailing newline, never via argv, and never enters tracked files.
- R3. `deploy-gateway.yaml` passes the two required new secrets through the reusable-workflow `secrets:` block, the `Validate required secrets` step, and the deploy step env.
- R4. `gateway deploy --local` (CLI) forwards the new env vars (`getGatewayDeployEnv`).
- R5. The `upstream.json` pin moves to v0.46.x and the Renovate `allowedVersions` ceiling is lifted so future releases surface again.
- R6. `apps/gateway/AGENTS.md` documents the new required secrets, the optional privileged-intents file, and the GitHub App consumption boundary.
- R7. The functional cutover does not crash on boot: required secrets exist in the `gateway` Environment before the triggered deploy is approved.

## Scope Boundaries

- Not creating or branding the GitHub App (registration, name, logo, public docs page, install-URL default constant) — that is human-created + owned by `fro-bot/agent`.
- Not changing the daemon's GitHub App code (token minting, installation discovery, `/add-project`) — shipped upstream in v0.45.0/v0.46.x.
- Not editing the upstream `deploy/compose.yaml` — it is materialized on the droplet via `git reset --hard <ref>`; this repo cannot modify it.

### Deferred to Separate Tasks

- GitHub App identity (runbook, logo, docs page, install-URL default): `fro-bot/agent` issue [#703](https://github.com/fro-bot/agent/issues/703).
- `GATEWAY_GITHUB_APP_INSTALL_URL` override: deferred — see Open Questions. The functional cutover relies on the upstream default; the correct-slug fix flows from the `fro-bot/agent` issue via a later pin bump.

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/src/deploy.ts`: `REQUIRED_ENV_VARS` (line 89), `ValidatedDeployEnv` (127) + `narrowValidatedEnv` (138), `buildSecretFileList` (268) with `required`/`optional` arrays (269/279) appending `{name, content, required}` to a `SecretFile[]` (interface line 18), `SECRETS_DIR` (77). Secret bytes are piped via SSH stdin in `writeRemoteFile` (trailing-newline handling already used for `GATEWAY_SSH_KEY`).
- `packages/cli/src/commands/gateway/deploy.ts`: `getGatewayDeployEnv()` builds the local-deploy env allowlist (already forwards DISCORD_*, AWS_*, S3_*, AWS_SESSION_TOKEN).
- `.github/workflows/deploy-gateway.yaml`: reusable-workflow `secrets:` block (line 12+), `Validate required secrets` step (80+), deploy-step env.
- `apps/gateway/upstream.json`: `{repo, ref}` (held at v0.44.2).
- `.github/renovate.json5`: `fro-bot/agent` packageRule with `allowedVersions: '<0.44.3'`.

### Institutional Learnings

- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`: the GATEWAY_SSH_KEY trailing-newline + `create_host_path: false` hard-fail class.
- Optional secret files written empty when unset; upstream treats empty files as absent (verified in v0.46.1 `readOptionalSecret`: whitespace-only file → null).

### External References

- Verified against `fro-bot/agent` v0.46.1 source: `packages/gateway/src/config.ts` reads `GITHUB_APP_ID` (`readSecret`, required), `GITHUB_APP_PRIVATE_KEY` (`readMultilineSecret`, required), `GATEWAY_GITHUB_APP_INSTALL_URL` (`readOptionalSecret`, default `https://github.com/apps/fro-bot/installations/new`). NOTE: those `GITHUB_APP_*` names are the daemon's **in-container** env (set by upstream compose from the bind-mounted files `github-app-id` / `github-app-private-key`) — they are upstream-owned and unaffected by GitHub's secret-name rule. Our side (Environment secret → workflow env → deploy.ts → file) uses `GH_APP_ID` / `GH_APP_PRIVATE_KEY` and writes the upstream-fixed file names; the prefix rename never crosses into the container. Required App permission: `contents: read`. Token flow: `@octokit/auth-app` JWT → `GET /repos/{owner}/{repo}/installation` → installation token → workspace `/clone` (token in request body, never argv).
- GitHub docs: a public ("any account") App is required for cross-account installation; installation tokens are per-installation scoped.

## Key Technical Decisions

- **Two required + one optional secret file.** `github-app-id` + `github-app-private-key` go in `buildSecretFileList`'s `required` array (boot-critical); `discord-privileged-intents` goes in `optional` (empty-when-unset = baseline intents). Rationale: matches the daemon's `readSecret` vs `readOptionalSecret` semantics exactly.
- **PEM via existing stdin byte-pipe.** Reuse `writeRemoteFile`'s SSH-stdin path with trailing newline (the GATEWAY_SSH_KEY lesson) — multiline PEM must not go through argv, and GitHub Actions strips trailing whitespace from secret env.
- **Single PR, gated by the approval queue.** Land deploy.ts + workflow + CLI + AGENTS + the `upstream.json` bump + ceiling lift together. The merge triggers a gated Deploy Gateway run; the operator seeds `GH_APP_ID`/`GH_APP_PRIVATE_KEY` into the `gateway` Environment *before approving* that run, so `Validate required secrets` (which runs post-approval) passes and the daemon boots. Rationale: one Fro Bot review (cost-aware), and the environment approval gate is the natural enforcement point for R7.
- **Defer the install-URL override (a choice, not a technical limit).** v0.46.1's compose has no `env_file` and does not bind `GATEWAY_GITHUB_APP_INSTALL_URL`. An override *is* achievable — `deploy.ts`'s existing `writeRemoteFile` runs after `git reset --hard` / `git clean -xfd`, so a `compose.override.yaml` could be materialized without touching upstream — but we deliberately skip it: the default only surfaces in the "App not installed" Discord message (rare for single-operator Fronomenal use), and the correct-slug fix arrives upstream via the `fro-bot/agent` identity issue + a later pin bump. Adding an override mechanism now is unjustified scope.
- **Patch changeset.** The pin bump is the release-note-bearing change (apps/** daemon update policy), same class as the prior `fro-bot/agent` bumps (#337 → 0.9.2 patch).

## Open Questions

### Resolved During Planning

- Required vs optional split: verified against v0.46.1 `config.ts` — github-app pair required, privileged-intents optional.
- Can we edit upstream compose to inject the install URL? No — materialized via `git reset --hard`; would need `compose.override.yaml`. Deferred.
- One PR or two? One, gated by the deploy approval queue (see Decisions).

### Deferred to Implementation

- Exact `GH_APP_PRIVATE_KEY` empty/whitespace validation parity with the daemon — confirm the materialized empty file for privileged-intents is treated as absent (expected per `readOptionalSecret`).
- Whether a `compose.override.yaml` install-URL mechanism is ever needed — only if the App slug differs from `fro-bot` AND the upstream default isn't corrected before cutover. Document as a known cosmetic gap if so.

## Implementation Units

- [ ] **Unit 1: Materialize the GitHub App secret files in deploy.ts**

**Goal:** `deploy.ts` writes `github-app-id` + `github-app-private-key` (required) and `discord-privileged-intents` (optional) to the droplet secrets dir.

**Requirements:** R1, R2

**Dependencies:** None (code is dormant on v0.44.2 — extra unused secret files are harmless; only *missing required* files fail compose).

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (`REQUIRED_ENV_VARS`, `ValidatedDeployEnv`, `narrowValidatedEnv`, `buildSecretFileList` required/optional arrays)
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**
- Add `GH_APP_ID` + `GH_APP_PRIVATE_KEY` to `REQUIRED_ENV_VARS` and the validated-env type/narrowing.
- Add `{name: 'github-app-id', envKey: 'GH_APP_ID'}` and `{name: 'github-app-private-key', envKey: 'GH_APP_PRIVATE_KEY'}` to the `required` array; `{name: 'discord-privileged-intents', envKey: 'DISCORD_PRIVILEGED_INTENTS'}` to `optional`. (File names stay upstream-fixed; only the `envKey` carries the `GH_APP_*` rename.)
- PEM materialization reuses the existing trailing-newline stdin path (no new write mechanism).

**Execution note:** Test-first — extend the existing `buildSecretFileList`/`narrowValidatedEnv` tests.

**Patterns to follow:** the existing DISCORD_TOKEN / AWS_SECRET_ACCESS_KEY entries and the GATEWAY_SSH_KEY trailing-newline handling.

**Test scenarios:**
- Happy path: with all env set, `buildSecretFileList` includes `github-app-id`/`github-app-private-key` as `required: true` and `discord-privileged-intents` as `required: false`.
- Edge case: `DISCORD_PRIVILEGED_INTENTS` unset → file present with empty content, `required: false`.
- Error path: missing `GH_APP_ID` or `GH_APP_PRIVATE_KEY` → `narrowValidatedEnv`/validation reports the missing required var (mirrors existing required-var test).
- Edge case: multiline PEM content is preserved verbatim (no newline mangling) in the produced `SecretFile.content`.

**Verification:** unit tests green; a dry-run/local materialization writes all three files with correct required flags.

- [ ] **Unit 2: Forward the new env vars in CLI local deploy**

**Goal:** `gateway deploy --local` carries `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `DISCORD_PRIVILEGED_INTENTS` into the deploy subprocess env.

**Requirements:** R4

**Dependencies:** None (independent of Unit 1; same release).

**Files:**
- Modify: `packages/cli/src/commands/gateway/deploy.ts` (`getGatewayDeployEnv`)
- Test: `packages/cli/src/commands/gateway/deploy.test.ts`

**Approach:** add the three vars to the local-deploy env allowlist (github-app pair forwarded; privileged-intents optional/empty-ok), mirroring the existing AWS/S3 passthrough.

**Execution note:** Test-first.

**Patterns to follow:** existing `getGatewayDeployEnv` AWS_SESSION_TOKEN / S3_ENDPOINT optional forwarding.

**Test scenarios:**
- Happy path: env set → returned env object includes all three keys.
- Edge case: optional `DISCORD_PRIVILEGED_INTENTS` unset → forwarded as empty string (consistent with existing optional pattern).

**Verification:** unit tests green.

- [ ] **Unit 3: Wire the new secrets through deploy-gateway.yaml**

**Goal:** the deploy workflow passes the two required GitHub App secrets through the reusable-workflow contract, validation, and deploy env.

**Requirements:** R3

**Dependencies:** None.

**Files:**
- Modify: `.github/workflows/deploy-gateway.yaml` (`secrets:` block, `Validate required secrets` step, deploy-step env)

**Approach:** add `GH_APP_ID` + `GH_APP_PRIVATE_KEY` alongside the existing DISCORD/AWS/S3 secrets in all three places. `DISCORD_PRIVILEGED_INTENTS` is optional — only add if we choose to support setting it via Environment (default: omit; empty file materialized regardless).

**Test scenarios:** Test expectation: none — workflow YAML; covered by the conventions test (SHA-pins, `secrets: inherit` ban, paths-filter quantifier) which parses every workflow.

**Verification:** conventions test green; `Validate required secrets` lists the two new vars.

- [ ] **Unit 4: Bump the pin to v0.46.1 and raise the Renovate ceiling to `<0.47.0`**

**Goal:** move `upstream.json` to v0.46.1 (the latest tag whose secret contract matches what this plan materializes) and raise the `allowedVersions` hold from `<0.44.3` to `<0.47.0` so Renovate tracks v0.46.x but does not auto-bump to the breaking v0.47.0.

**v0.47.0 hold rationale (verified against source):** v0.47.0's `loadConfig` adds two *unconditional* `readSecret` calls — `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` — plus a new `GATEWAY_HTTP_PORT` HTTP ingress (announce-webhook + presence feature). Adopting it requires provisioning two new secrets AND an HTTP-surface/UFW decision that contradicts the gateway's current no-public-HTTP posture. That is a separate feature-adoption task, tracked apart from this GitHub App work.

**Requirements:** R5

**Dependencies:** Units 1–3 (the daemon will require the new secrets once this lands). **Hard gate:** the `GH_APP_ID`/`GH_APP_PRIVATE_KEY` Environment secrets must exist before the triggered deploy is approved (R7).

**Files:**
- Modify: `apps/gateway/upstream.json` (ref → v0.46.1)
- Modify: `.github/renovate.json5` (change `allowedVersions: '<0.44.3'` → `'<0.47.0'` on the `fro-bot/agent` rule; keep `groupName: null`)
- Create: `.changeset/<name>.md` (patch — "update fro-bot/agent to v0.46.1")

**Approach:** pin v0.46.1 (verified: its compose secret-file set + `loadConfig` required reads exactly match this plan's materialized files — `github-app-id`, `github-app-private-key`, `discord-privileged-intents`). Raise the ceiling to `<0.47.0` so v0.46.x patches still surface as standalone PRs while v0.47.0 stays held until its announce-webhook/presence feature is separately planned.

**Test scenarios:** Test expectation: none — config/pin bump; validated by `renovate-config-validator` + the custom-manager regex extraction.

**Verification:** renovate validator passes; the regex extracts the new ref; changeset present.

- [ ] **Unit 5: Document the GitHub App consumption in AGENTS.md**

**Goal:** `apps/gateway/AGENTS.md` reflects the new required secrets, the optional privileged-intents file, and the App-ownership boundary.

**Requirements:** R6

**Dependencies:** Units 1–4 (document the shipped behavior).

**Files:**
- Modify: `apps/gateway/AGENTS.md` (Required Secrets table + a short "GitHub App (add-project)" note + the install-URL deferral + the `fro-bot/agent`-owns-identity boundary)

**Approach:** present-tense description of current behavior; no plan taxonomy; note that the App ID + PEM come from the `gateway` Environment and never enter the repo.

**Test scenarios:** Test expectation: none — docs.

**Verification:** lint clean; content matches the shipped deploy.ts secret set.

## System-Wide Impact

- **Interaction graph:** merging the PR triggers a gated Deploy Gateway run (upstream.json + deploy.ts under `apps/gateway/**`). The environment approval gate is the enforcement point for the secrets-before-boot ordering.
- **Error propagation:** missing required secrets → `Validate required secrets` fails fast post-approval (before SSH), or the daemon throws at `loadConfig` if somehow materialized empty. Both are loud, not silent.
- **State lifecycle risks:** the cutover is `git reset --hard v0.46.x` + `docker compose up` on the droplet; the `cliproxy_auth`-equivalent volumes (mitmproxy CA, S3 bindings) persist. No data migration.
- **API surface parity:** none — internal deploy plumbing.
- **Unchanged invariants:** the existing 9 secret files and their materialization are untouched; only additive.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Pin bumped before secrets seeded → daemon boot crash | Single-PR + approval-gate ordering (R7): seed Environment secrets before approving the triggered deploy. Documented as the hard gate on Unit 4. |
| PEM newline corruption → `libcrypto` boot failure | Reuse the GATEWAY_SSH_KEY trailing-newline stdin path; add a test asserting multiline content is preserved. |
| App slug ≠ `fro-bot` → wrong install URL in "app not installed" message | Cosmetic, low-frequency for single-operator use; fixed upstream via the fro-bot/agent issue (install-URL default) and a later pin bump. Documented as a known gap, not a blocker. |
| Human prerequisite (App creation) not done | Phased delivery makes app creation + secret seeding an explicit Phase 1 human step before the cutover PR merges. |

## Phased Delivery

### Phase 1 — External prerequisites to verify before cutover (not this plan's work)

These are operator/`fro-bot/agent`-owned preconditions, not implementation units. The cutover (Phase 3) must not proceed until they are confirmed:
- The public "Fro Bot Agent" App exists under the `fro-bot` account (`contents: read`, no webhook), is installed on the accounts `add-project` will target, and its App ID + PEM are in hand. (Registration is human-only via the GitHub UI; documented in the `fro-bot/agent` identity issue — see Scope Boundaries.)
- `GH_APP_ID` + `GH_APP_PRIVATE_KEY` are seeded into the `gateway` GitHub Environment (GitHub rejects `GITHUB_`-prefixed secret names — these map to the `github-app-id` / `github-app-private-key` files on the droplet).

### Phase 2 — Infra PR (this plan)
- Units 1–5 in one PR. May merge anytime (code is additive/dormant on v0.44.2), but **do not approve the triggered Deploy Gateway run until Phase 1 secrets are confirmed**.

### Phase 3 — Cutover + verify
- Approve the gated deploy → `git reset --hard v0.46.x` + compose up → verify all services healthy, then `/fro-bot ping` and `/fro-bot add-project <a test repo>` end-to-end.

## Documentation / Operational Notes

- The `fro-bot/agent` identity issue (runbook + logo + docs page + install-URL default) runs in parallel and does not block the cutover.
- Rollback: `upstream.json` → v0.44.2 + restore the ceiling (the v0.44.2 daemon ignores the extra github-app secret files).
- **PEM rotation / revocation** (long-lived cross-installation credential): to rotate, generate a new private key in the App settings, replace `GH_APP_PRIVATE_KEY` in the `gateway` Environment, re-run the deploy (re-materializes the file), then delete the old key in the App settings. To contain a suspected compromise: revoke the App installation on affected accounts (or disable/suspend the App) in its settings, and rotate the PEM. The App ID is not secret; the PEM is the only sensitive credential and lives only in the `gateway` Environment + on the droplet. AGENTS.md (Unit 5) should cross-reference this note.

## Sources & References

- Issue: #341 (this plan); `fro-bot/agent`#703 (App identity, parallel track)
- Related: PR #342 (the v0.44.2 hold + ceiling this plan lifts), `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`
- Upstream: `fro-bot/agent` v0.46.1 `packages/gateway/src/config.ts`, `deploy/compose.yaml`, `deploy/README.md`
