---
title: 'feat: Discord token-lifecycle runbook'
type: feat
status: active
date: 2026-05-20
origin: https://github.com/marcusrbrown/infra/issues/269
---

# Discord token-lifecycle runbook

## Overview

Create `docs/runbooks/discord-token-lifecycle.md` — the canonical operator runbook for the Discord bot token used by both the `apps/gateway` daemon (long-running, file-backed on the droplet) and the `marcusrbrown/.dotfiles` admin-agent (ephemeral, Keychain-backed per OpenCode session). The runbook is a handoff target from the dotfiles Unit 11, which declared "the canonical token-lifecycle doc lives in infra, not dotfiles." This plan also fixes three documentation-drift issues in `apps/gateway/AGENTS.md` that surfaced during research and would otherwise contradict the runbook immediately after it lands.

## Problem Frame

The dotfiles Discord server-revival plan ([dotfiles Unit 11](https://github.com/marcusrbrown/.dotfiles/blob/main/docs/plans/2026-05-18-001-feat-discord-server-revival-plan.md)) declared four ownership areas for this repo: storage, rotation procedure, emergency revocation, and in-flight interaction handling. The dotfiles-side admin-agent runbook currently carries a 📌 TODO marker pointing here. Until the runbook exists, operators have to reverse-engineer the lifecycle from `apps/gateway/src/deploy.ts` and `apps/gateway/AGENTS.md` — both of which document fragments but not the full rotate/revoke story end-to-end, and both of which carry drift (snake_case vs kebab-case secret names, stale `discord_operator_role_id`, 30s-vs-6s registration gate).

An operator paged at 2am during a token leak should be able to:
1. Read one document with concrete commands and paths.
2. Execute revocation steps in order without consulting source code.
3. Understand that rotating the gateway token also invalidates the admin-agent Keychain copy.

## Requirements Trace

- R1. Document **storage**: file path on droplet, ownership/mode, the writer (`apps/gateway/src/deploy.ts:writeRemoteFile`), and the upstream `${NAME}_FILE` precedence (`readOptionalSecret` in `fro-bot/agent@v0.44.2/packages/gateway/src/config.ts`). (origin: issue #269 section 1)
- R2. Document **rotation procedure**: portal action, deploy pipeline path (`gateway` GitHub Environment → `gh workflow run deploy-gateway.yaml` → checksum-gated force-recreate → registration gate), local Keychain update for dotfiles admin-agent. (origin: issue #269 section 2)
- R3. Document **emergency revocation**: portal Reset Token, container stop, audit, re-rotation. (origin: issue #269 section 3)
- R4. Document **in-flight interaction handling**: WebSocket RESUMED denial, the absence of a workspace-execution graceful drain (executions are cut at restart), client-side slash-command timeout. (origin: issue #269 section 4 — frames the design state, not a wishful contract)
- R5. Document **dual-consumer coupling**: dotfiles admin-agent (Keychain) and gateway daemon (file-backed) share one token; rotation invalidates both simultaneously. (origin: issue #269 "Coordination" section)
- R6. Cross-link from `apps/gateway/AGENTS.md` so an agent landing there can find the runbook. (origin: Fro Bot triage comment, step 2)
- R7. **Acceptance criteria**: new file exists, all four ownership areas have concrete commands/paths (not prose-only), coordination is called out, dotfiles follow-up PR is opened separately. (origin: issue #269 "Acceptance criteria")
- R8. **Fix drift in `apps/gateway/AGENTS.md`** uncovered during research: (a) snake_case secret filenames in prose; (b) stale `discord_operator_role_id` optional file reference; (c) "30-second hard gate" claim vs 6s code default. Fixing these in the same PR prevents an immediate doc-vs-doc contradiction.

## Scope Boundaries

- The runbook will reference but **not duplicate** upstream behavior. The `${NAME}_FILE` precedence is upstream's contract (`fro-bot/agent`); the runbook will link to the pinned upstream config and summarize the contract, not re-explain it.
- The runbook is **operator-facing**, not developer-facing. It should answer "what do I run during an incident" and "what side-effects should I expect", not "how does the code work internally."
- The runbook does NOT cover slash-command development, Discord guild administration, or anything outside token lifecycle.

### Deferred to Separate Tasks

- **Dotfiles PR** replacing the TODO marker with the direct URL to the new runbook: separate PR in `marcusrbrown/.dotfiles`, opened after this PR merges. Tracked by issue #269 (issue stays open until that follow-up lands).
- **Code fix for the 30s-vs-6s registration gate discrepancy**: separate decision — either bump the code default to 30s (matching AGENTS.md's documented behavior) or update AGENTS.md to match the 6s code default. Out of scope here; this plan only updates AGENTS.md prose to match what the runbook documents about the operator-observable behavior.

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/src/deploy.ts`:
  - `REMOTE_DIR=/opt/gateway`, `DEPLOY_DIR=/opt/gateway/deploy`, `SECRETS_DIR=/opt/gateway/deploy/secrets`, checksum at `/opt/gateway/.secrets-checksum` (lines 75-80)
  - `buildSecretFileList()` returns 9 entries: 7 required + 2 optional (`s3-endpoint`, `aws-session-token`) — both written as 0-byte files when env var unset (lines 268-294)
  - `writeRemoteFile()` writes via SSH stdin pipe with `umask 077` → mode 0600 (lines 527-547)
  - Checksum gating: read prior checksum → write new secret files → if checksum changed OR `--force-recreate`, add `--force-recreate` to `docker compose up` → after compose+registration succeed, write new checksum to `/opt/gateway/.secrets-checksum` (lines 768-849)
- `apps/gateway/AGENTS.md`: existing "Deploy Flow" (lines 16-25), "Day-2 Operations" (27-33), "Required Secrets" (71-85), "Anti-Patterns" (116-130) sections
- `packages/cli/src/commands/gateway/`: 5 subcommands — `status`, `deploy`, `logs`, `backup`, `restore`. Operator-relevant flags documented in research output.
- Upstream pinned at `apps/gateway/upstream.json`: `fro-bot/agent@v0.44.2`. The `readOptionalSecret(name)` helper in `packages/gateway/src/config.ts` reads `${NAME}_FILE` first (file path), falls back to bare `process.env[name]`, returns `null` for empty/missing. Empty file == absent (`trimEnd` then `.trim() === ''` check).

### Institutional Learnings

- [`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`](../solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md): Tonight's compound learning. Wave 3 (PEM newline) and Wave 2 (secret corruption from `gh secret set` shell substitution) are directly relevant — the runbook should warn against the shell-substitution pattern and document the clean stdin-pipe approach.
- [`docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`](../solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md): Same shape of cascade on cliproxy, useful prior-art reference for the dual-consumer note pattern.
- Memory ID 3417 (commit-flow reuse) and 3580 (no session-time framing) apply to PR posture.

### External References

- [Discord Developer Portal — Application 1505811646956830781](https://discord.com/developers/applications/1505811646956830781/bot): the operator-facing console for "Reset Token" actions
- [Discord Gateway protocol: RESUMED](https://discord.com/developers/docs/topics/gateway#resuming): documents the re-auth flow when a token rotation invalidates a session
- [Docker Compose secrets file mount](https://docs.docker.com/reference/compose-file/services/#secrets): the contract the gateway compose.yaml uses

## Key Technical Decisions

- **Runbook location**: `docs/runbooks/discord-token-lifecycle.md` matches the issue's suggestion and establishes the `docs/runbooks/` directory for future operational docs (none exist yet in this repo — keeweb and cliproxy lifecycle docs would naturally follow this pattern).
- **Document the kebab-case ↔ snake_case dance explicitly**: on the droplet, secret files are kebab-case (`discord-token`); compose mounts them as snake_case (`/run/secrets/discord_token`); upstream env vars are uppercase snake_case with `_FILE` suffix (`DISCORD_TOKEN_FILE`). An operator running `ls /opt/gateway/deploy/secrets/` and then reading the compose.yaml will get confused without this mapping table.
- **Inline the dual-consumer coupling table** rather than linking to dotfiles: the table is small, sufficient context can stand on its own, and the runbook is the canonical doc by design.
- **Don't pre-write the dotfiles PR**: per issue acceptance criteria, the dotfiles follow-up is a separate PR opened after this one merges. The runbook itself only contains the upstream link and the dual-consumer note.
- **Fix the AGENTS.md drift in the same PR** (not a separate PR): the drift is the kind of thing the new runbook would immediately contradict; fixing it once keeps history clean. Three small edits, all docs-only.
- **Registration poll cadence — commit to a concrete operator-facing number**: the runbook will state, as one observable fact: "During rotation, the deploy waits up to ~3 minutes total for the gateway to register slash commands with Discord, polling every 3 seconds with a 6-second per-attempt timeout (defaults from `apps/gateway/src/deploy.ts:344-368`). If the poll exceeds this budget the deploy aborts and the old checksum stays in place — safe to retry." An operator under pressure gets a clear expectation without source-code archaeology. (Document-review feedback: deferring to "see deploy.ts" failed the 2am-operator framing.) The separate decision of whether to align AGENTS.md's old "30-second hard gate" claim with code is deferred per Scope Boundaries — for this PR, AGENTS.md gets the same operator-observable description as the runbook.
- **Containment-first rotation order**: rotation must be a single linear sequence with no hidden timing branches. Operator updates local Keychain FIRST (treats the old workstation copy as already revoked once rotation starts), then seeds the GitHub secret, then triggers deploy. No "come back later to update Keychain" step. (Document-review: product-lens + security-lens both flagged the Keychain-after-deploy timing window.)
- **Audit checklist is enumerated, not gestured at**: Section 3 lists the specific surfaces to inspect and what to look for at each — Discord audit log (token reset events, suspicious admin actions, bot DMs), gateway logs (`4004 Authentication failed` + last 500 lines of normal traffic), mitmproxy logs (egress destinations, request volume anomalies), workspace logs (any execution during the leak window), S3 access logs (objects written by the gateway), shell history on the operator workstation (any earlier echo of the leaked token).
- **Secret-handling hygiene during rotation**: the runbook explicitly covers temp-file cleanup, shell-history avoidance, and stdin-pipe-vs-echo. Steps include `unset HISTFILE` or use `printf` piped directly to `gh secret set` (no intermediate file), and explicit `rm -f` for any unavoidable temp file. Cross-references the gateway first-deploy cascade learning for the `gh secret set --body "$(cat ...)"` warning.
- **Suspected-vs-confirmed triage**: Section 3 opens with a short triage paragraph — what signals constitute suspected vs confirmed leak, and the default-action rule ("under uncertainty, revoke first"). Removes guesswork at 2am.
- **No code, no tests, no changeset**: documentation-only PR. `docs/runbooks/` and `apps/gateway/AGENTS.md` changes don't ship via npm.

## Open Questions

### Resolved During Planning

- Q: Does AGENTS.md already cover any of the four areas? — Yes, partially. Storage and rotation are covered (with drift); revocation is NOT explicitly covered; in-flight is partially covered via the registration poll docs. Runbook covers all four; AGENTS.md gets minor drift fixes.
- Q: Should the runbook duplicate the dotfiles Keychain command or link out? — Inline. The dual-consumer table needs the operator to see both sides at once.
- Q: Is the `${NAME}_FILE` precedence actually upstream behavior, not this repo's? — Confirmed: `readOptionalSecret` is in `fro-bot/agent@v0.44.2/packages/gateway/src/config.ts`. This repo writes the kebab-case files; upstream's compose.yaml maps them to `/run/secrets/snake_case_name` and reads via `${NAME}_FILE`.
- Q: Application ID — hardcode in runbook or reference env var? — Hardcode the portal URL (which embeds the ID). The ID is public per the Developer Portal URL structure; the secret value is the token, not the ID.

### Deferred to Implementation

- Exact wording of the dual-consumer table — the implementer can match the issue body's wording or refine for the runbook's flow. The structure is locked; phrasing is editorial.
- Whether to include screenshots of the Developer Portal — the runbook should be text-only for review/diff hygiene; screenshots can be added later if specific UI elements drift.

## Implementation Units

- [ ] **Unit 1: Create `docs/runbooks/` directory with the token-lifecycle runbook**

**Goal:** Write the canonical operator runbook covering all four ownership areas with concrete commands and paths.

**Requirements:** R1, R2, R3, R4, R5, R7

**Dependencies:** None

**Files:**
- Create: `docs/runbooks/discord-token-lifecycle.md`

**Approach:**
- Open with one-paragraph context: which token, which consumers, where it lives. Link to dotfiles admin-agent runbook for the other half of the story.
- Section 1 — **Storage**: droplet path table (`/opt/gateway/deploy/secrets/discord-token`), ownership (`root:root` mode `0600`), how the file gets there (link to `apps/gateway/src/deploy.ts:writeRemoteFile` with line refs to the SSH stdin pipe with `umask 077`), the compose mount mapping (`/opt/gateway/deploy/secrets/discord-token` → `/run/secrets/discord_token` inside container → `DISCORD_TOKEN_FILE` env var → upstream's `readOptionalSecret`), and the kebab↔snake mapping table for all 9 secrets.
- Section 2 — **Rotation procedure (planned)**: linear, containment-first numbered steps. No branches. (1) Reset Token in Developer Portal (link) — the previous token is invalidated immediately; the gateway will start failing on the next WebSocket reconnect. (2) Update local Keychain BEFORE seeding GitHub: `security add-generic-password -s discord-bot-fro-bot-token -w <new-token> -U`. Treat the old Keychain copy as revoked from this step forward. (3) Seed the new token via stdin pipe, NEVER via `--body "$(cat ...)"` shell substitution: `printf '%s' '<new-token>' | gh secret set --env gateway DISCORD_TOKEN` (no intermediate file — if a file is unavoidable, `chmod 600` it and `rm -f` immediately after). Cross-reference the gateway first-deploy cascade learning for why shell substitution corrupts secrets. (4) Trigger deploy: `bunx @marcusrbrown/infra gateway deploy` or `gh workflow run deploy-gateway.yaml`. (5) Approve the environment gate. (6) Observe the deploy: writes new file → checksum changes → force-recreate fires → registration poll (~3 min ceiling). (7) Verify: `bunx @marcusrbrown/infra gateway status` shows all 3 services healthy; `bunx @marcusrbrown/infra gateway logs gateway --tail 50` shows `discord shard ready` and `gateway ready` lines. (8) `unset HISTFILE` or check `~/.bash_history` / `~/.zsh_history` and scrub any line containing the new token.
- Section 3 — **Emergency revocation (suspected or confirmed leak)**: Open with a 3-line triage rule. Suspected = anomalous log entries, unfamiliar audit-log activity, accidental token paste, leaked CI artifact. Confirmed = positive evidence (logs showing the leaked token used, public exposure verified). **Default under uncertainty: treat as confirmed. Revoke first.** Then numbered containment sequence: (1) Reset Token in Developer Portal — invalidates immediately. (2) Stop the gateway container in the same minute (don't wait for portal action to propagate): `ssh root@gateway.fro.bot 'cd /opt/gateway && docker compose -f deploy/compose.yaml stop gateway'`. (3) Audit the surfaces below; record findings. (4) Issue new token and follow Section 2 rotation procedure. **Audit surfaces** (enumerated, not gestured at):
  - **Discord audit log** (Server Settings → Audit Log): look for `BOT_RESET`/token reset events, suspicious admin actions taken by the bot account, channel-modify events, bot-DM activity. Compare timestamps against your suspected leak window.
  - **Gateway logs** (`bunx @marcusrbrown/infra gateway logs gateway --tail 500 --allow-ci`): look for `4004 Authentication failed` (token already revoked = expected); look for the last 500 lines of normal traffic to see what actions ran with the leaked token before revocation.
  - **Mitmproxy logs** (the egress proxy): look for unfamiliar destinations or request-volume spikes from the gateway container.
  - **Workspace execution logs**: look for any workspace executions during the leak window — admin-agent uses the same token, so an unrecognized workspace command is a strong signal.
  - **S3 access logs**: look for objects written by the gateway during the leak window (compare against your known workload).
  - **Operator workstation shell history**: `grep -E '<new-or-old-token-snippet>' ~/.bash_history ~/.zsh_history`. If the leaked token ever echoed, this is where it lives.
- Section 4 — **In-flight interaction handling**: three sub-sections.
  - (a) WebSocket — old token's RESUMED is denied; daemon enters reconnect loop with backoff; will not succeed until new token is deployed. Operator-observable symptom in `gateway logs`: repeated `4004 Authentication failed` close codes.
  - (b) Workspace executions — upstream compose has no graceful drain (no documented grace period). Docker stop sends SIGTERM and any in-flight workspace execution is cut. Plan rotations during low-traffic windows when possible. (Future upstream work could add a drain.)
  - (c) Slash commands during the rotation window — client sees a 3s interaction timeout; user-facing message is "Application did not respond."
- Section 5 — **Coordination with dotfiles admin-agent**: dual-consumer table inline (Consumer | Channel | Lifecycle | Owner repo), explicit "rotation invalidates both simultaneously" note, an explicit ownership-boundary line ("infra owns the gateway daemon side; dotfiles owns the admin-agent side; rotation owner is whoever initiates — typically the operator at the GitHub Environment"), link to `marcusrbrown/.dotfiles/docs/runbooks/discord-admin-agent.md`.
- Section 6 — **Secondary credential note**: short callout — "The Discord bot token is the only credential the gateway holds today. If upstream adds derived OAuth grants, webhook credentials, or other downstream secrets, this section needs to be revisited."
- Section 7 — **Related**: cross-references to `apps/gateway/AGENTS.md`, the gateway first-deploy cascade compound doc, upstream pin location, deploy.ts line refs.

**Patterns to follow:**
- The cliproxy and gateway first-deploy cascade docs in `docs/solutions/workflow-issues/` for tone and code-block-with-line-refs formatting
- Existing `apps/gateway/AGENTS.md` "DAY-2 OPERATIONS" prose for how the project talks about operator-facing concerns

**Test scenarios:**
- Test expectation: none — pure documentation. Verification is a manual read-through by Marcus and Fro Bot review.

**Verification:**
- File exists at `docs/runbooks/discord-token-lifecycle.md`
- All four ownership areas (storage, rotation, revocation, in-flight) have concrete commands/paths (no prose-only sections)
- Dual-consumer table is present with both rows
- Cross-links to dotfiles runbook, AGENTS.md, and compound learnings doc are present and resolve (file exists / URL valid)
- A reader unfamiliar with the codebase could execute a rotation following only the runbook

- [ ] **Unit 2: Fix `apps/gateway/AGENTS.md` drift + add root AGENTS.md cross-reference**

**Goal:** Update three drift points in `apps/gateway/AGENTS.md` so it doesn't contradict the new runbook on merge, and add a one-line pointer to `docs/runbooks/` in the root `AGENTS.md` "Where to look" table so future agents and humans can find the runbook from the root navigation.

**Requirements:** R6, R8

**Dependencies:** Unit 1 (sequence: write runbook first, then update AGENTS.md files to point at it)

**Files:**
- Modify: `apps/gateway/AGENTS.md` (three drift fixes + cross-reference to the new runbook)
- Modify: `AGENTS.md` (one new row in the "Where to look" table for `docs/runbooks/`)

**Approach:**
- (a) Line 21 prose lists secret filenames in snake_case (`discord_token`, `aws_access_key_id`, etc.) but tests at `apps/gateway/src/deploy.test.ts:245-254` explicitly assert kebab-case. Rewrite the prose to use kebab-case and add a one-line note: "Filenames on disk are kebab-case; the compose contract maps each to `/run/secrets/<snake_case>` and exposes via `${NAME}_FILE` env vars. See `docs/runbooks/discord-token-lifecycle.md` for the full mapping table."
- (b) Line 21 mentions `discord_operator_role_id` as an optional file. This file no longer exists in `buildSecretFileList`. Replace with the actual current optional files: `s3-endpoint` and `aws-session-token` (both touched as empty when env unset).
- (c) Line 24 documents a "30-second hard gate per attempt" for the registration poll. The code default in `apps/gateway/src/deploy.ts:365-368` is `max(6000, intervalMs * 2)` which is 6s with default `intervalMs=3000`. Either: (i) rewrite to "polls Discord registration with per-attempt timeout (see `perAttemptTimeoutMs` in `apps/gateway/src/deploy.ts`)" — the cautious option that doesn't pin a number; or (ii) leave the 30s claim and file a separate code-fix note. Go with (i) for this PR; (ii) is the deferred separate-task per Scope Boundaries.

**Patterns to follow:**
- Existing AGENTS.md voice and tense
- The "Documented Solutions" pointer at the root AGENTS.md line 50 is a good shape for the new runbook cross-reference

**Test scenarios:**
- Test expectation: none — pure documentation.

**Verification:** Use this exact command sequence and confirm the expected outputs:

```
# Snake_case secret names must only survive where they describe the
# upstream env-var contract (e.g., DISCORD_TOKEN_FILE) — not as host
# filenames. The grep below should return only matches inside the explicit
# kebab↔snake mapping line, not freestanding prose.
grep -nE 'discord_token|aws_access_key_id|aws_secret_access_key|s3_bucket|s3_region|s3_endpoint|discord_application_id|discord_guild_id|aws_session_token|discord_operator_role_id' apps/gateway/AGENTS.md
```

Expected: zero matches OR matches limited to the kebab↔snake mapping sentence that explicitly explains the two-name dance. Human review confirms which.

```
# The runbook cross-reference must be present.
grep -n 'discord-token-lifecycle' apps/gateway/AGENTS.md AGENTS.md
```

Expected: at least one match in each file.

```
# `discord_operator_role_id` must not appear (no longer a valid optional file).
grep -n 'discord_operator_role_id' apps/gateway/AGENTS.md
```

Expected: zero matches.

```
# Verify the 30s claim was reworded to operator-observable language.
grep -nE '30-second hard gate|30 second hard gate|30s hard gate' apps/gateway/AGENTS.md
```

Expected: zero matches.

Additional manual checks:
- AGENTS.md `apps/gateway/AGENTS.md` includes the same operator-observable description of the registration poll cadence as the runbook (~3 minutes ceiling, 3s interval, 6s per-attempt timeout).
- Root `AGENTS.md` "Where to look" table has a new row for `docs/runbooks/` matching the existing `docs/solutions/` row's shape.
- No code change accompanies this unit — verification is read-only.

## System-Wide Impact

- **Interaction graph:** The runbook references the deploy pipeline (`apps/gateway/src/deploy.ts`), the CLI commands (`packages/cli/src/commands/gateway/`), upstream config (`fro-bot/agent@v0.44.2`), and the dotfiles admin-agent runbook. None are modified by this plan beyond the AGENTS.md drift fixes.
- **Error propagation:** N/A — docs only.
- **State lifecycle risks:** N/A — docs only. The runbook documents the existing checksum-gated rotation lifecycle but does not alter it.
- **API surface parity:** N/A.
- **Integration coverage:** N/A — no behavior changes.
- **Unchanged invariants:** The deploy pipeline, the checksum gating, the 9-secret file list, the SSH stdin pipe + `umask 077` mode, and the upstream `readOptionalSecret` precedence are all unchanged. The runbook documents them; the AGENTS.md update aligns prose to reality.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Runbook accurate today, drifts tomorrow when deploy.ts or compose contract changes | The runbook's "Last verified" line points at the upstream pin (`v0.44.2`). The pin move IS the refresh trigger — when the implementer bumps `apps/gateway/upstream.json`, they must re-verify the runbook's mapping table and registration cadence against the new compose.yaml. No separate refresh process needed; cross-references and pin-bump cadence are the trigger |
| Operator follows the runbook but Discord Developer Portal UI has changed | Link to the portal page directly; describe action by name ("Reset Token") rather than UI position |
| The dual-consumer table goes stale if dotfiles admin-agent moves to a different secret store | The runbook's Section 5 dual-consumer table cites the dotfiles runbook as source-of-truth for the admin-agent half. Pre-merge implementer check: fetch the dotfiles runbook URL and confirm the Keychain mechanism is still described there. If dotfiles changes its mechanism, the dotfiles-side PR triggers an update on both sides |
| AGENTS.md drift fix lands but misses a snake_case reference elsewhere | Unit 2 verification grep covers all 10 names. If any other doc file has the same drift it's out of scope for this PR but worth a follow-up `rg --hidden` sweep post-merge |
| Pre-merge: dotfiles admin-agent runbook content has shifted since the issue was filed | Implementer fetches `https://github.com/marcusrbrown/.dotfiles/blob/main/docs/runbooks/discord-admin-agent.md` before writing Section 5 and aligns the dual-consumer table to whatever the dotfiles runbook actually currently documents |

- **Discoverability:** Root `AGENTS.md` line 50 surfaces `docs/solutions/` but not `docs/runbooks/`. The runbook is operator-facing rather than agent-facing, but discovery still benefits from the root pointer. Unit 2 adds the row.
- **Pre-merge verification:** Before opening the PR, the implementer must (a) fetch the current `marcusrbrown/.dotfiles/docs/runbooks/discord-admin-agent.md` and confirm the Keychain mechanism still matches the dual-consumer table; (b) re-verify against the live droplet that the 9-secret file list and ownership/mode haven't changed since 2026-05-20; (c) confirm `apps/gateway/upstream.json` is still pinned at `v0.44.2` (if bumped, the runbook's "Last verified against" line needs the new value).
- **Cross-repo follow-up:** Per acceptance criteria, the dotfiles PR that replaces the TODO marker is a separate PR. Open it as soon as this PR's runbook URL is stable (post-merge, against main). Track via issue #269 (close after the dotfiles PR merges).
- **No release** — docs-only PR, no changeset, no version bump.

## Sources & References

- **Origin document:** [Issue #269](https://github.com/marcusrbrown/infra/issues/269) — "Add canonical Discord token-lifecycle runbook (handoff from dotfiles plan Unit 11)"
- **Dotfiles plan that triggered this:** [`marcusrbrown/.dotfiles/docs/plans/2026-05-18-001-feat-discord-server-revival-plan.md`](https://github.com/marcusrbrown/.dotfiles/blob/main/docs/plans/2026-05-18-001-feat-discord-server-revival-plan.md) Unit 11
- **Dotfiles target for the follow-up PR:** [`marcusrbrown/.dotfiles/docs/runbooks/discord-admin-agent.md`](https://github.com/marcusrbrown/.dotfiles/blob/main/docs/runbooks/discord-admin-agent.md#token-handoff-pointer-to-marcusrbrowninfra)
- **Live droplet state (verified 2026-05-20)**:
  - `/opt/gateway/deploy/secrets/` — 9 kebab-case files, `root:root` mode `0600`, optional files (`aws-session-token`, `s3-endpoint`) are 0-byte placeholders
  - `/opt/gateway/.secrets-checksum` — 64-byte SHA-256 hex, `0600`
  - Compose env block maps kebab-case host files → `/run/secrets/snake_case` container paths via `${NAME}_FILE` env vars
- **Upstream pin:** `apps/gateway/upstream.json` → `fro-bot/agent@v0.44.2`. `readOptionalSecret` helper at [`packages/gateway/src/config.ts`](https://github.com/fro-bot/agent/blob/v0.44.2/packages/gateway/src/config.ts) handles `${NAME}_FILE` precedence and treats empty file as absent.
- **Code references:**
  - `apps/gateway/src/deploy.ts:75-80` — REMOTE_DIR / DEPLOY_DIR / SECRETS_DIR / checksum path constants
  - `apps/gateway/src/deploy.ts:263-307` — `buildSecretFileList()` (9 entries, 7 required + 2 optional)
  - `apps/gateway/src/deploy.ts:527-582` — `writeRemoteFile()` (SSH stdin + `umask 077`)
  - `apps/gateway/src/deploy.ts:768-849` — checksum-gated force-recreate + 30s registration gate + checksum write-after-success
  - `apps/gateway/src/deploy.ts:365-368` — registration poll `perAttemptTimeoutMs` default
  - `apps/gateway/AGENTS.md:16-25, 27-33, 71-85, 116-130` — existing deploy-flow, day-2, secrets, anti-pattern sections
- **CLI commands referenced by the runbook:** `gateway status`, `gateway logs <service>`, `gateway deploy`, `gateway backup --include-ca`, `gateway restore --include-ca --input <file>`. All documented in `packages/cli/src/commands/gateway/`.
- **Related learnings:**
  - [`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`](../solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md) — `gh secret set` shell-substitution corruption warning; PEM newline gotcha is relevant to anyone re-seeding `GATEWAY_SSH_KEY` during a host rebuild
  - [`docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`](../solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md) — precedent for documenting deploy lifecycle
