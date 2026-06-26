---
title: "feat: Deploy drift detection (committed pin vs live version)"
type: feat
status: superseded
date: 2026-06-25
deepened: 2026-06-25
---

> **Superseded (2026-06-25):** Document-review surfaced two P0 premise flaws — the committed-pin-from-CWD source-of-truth (false-OK on stale checkouts; permanent `unknown` for global installs) and, more fundamentally, that #682 already fixed the *cause* of stranded deploys. The work was re-scoped to a narrower **cancelled/incomplete-deploy detector** that targets the actual incident class directly. See the replacement brainstorm/plan. This document is retained as the design record and the source of the reusable findings (TagResult verdict, per-app probe research).


# feat: Deploy drift detection (committed pin vs live version)

## Overview

Detect when an app's committed image pin on `main` differs from the version actually running in production, so a stranded/undeployed pin is caught in minutes instead of weeks. Surface drift in `infra status` (and the unified MCP status), and extend Fro Bot autohealing category 5 to flag drift explicitly. Scoped to the 4 Docker apps (cliproxy, gateway, umami, dashboard); keeweb (static KeeWeb build) and vpn (WireGuard, no image) report `n/a`.

## Problem Frame

The umami `3.2.0` pin landed on `main` (PR #670) but production ran `3.1.0` for ~3 weeks because the deploy run was cancelled at its approval gate (fixed separately in PR #682). Nothing surfaced the gap: the status surface shows service health, not whether the running version matches the committed pin, and autohealing category 5 checks *deploy-run success* — a cancelled run isn't a failed run, so it slips through. Drift detection is the defense-in-depth that makes "committed but not deployed" observable.

## Requirements Trace

- R1. For each Docker app, determine the committed pin (compose `image:` tag for cliproxy/umami/dashboard; `upstream.json` ref for gateway) and the live deployed version, and report whether they match.
- R2. `infra status` shows a per-app drift indicator (OK / DRIFT / n/a); `--json` includes a structured drift field. The unified MCP `status`/`<app> status` surface inherits it (read-only, no new mutating tool).
- R3. Drift detection degrades gracefully: an unreachable host or unparseable version reports `unknown`, never a false "OK".
- R4. Fro Bot autohealing category 5 explicitly checks committed-pin-vs-live-version drift for the 4 Docker apps and reports any drift in the daily report.
- R5. No secret leakage: live-version probes reuse the existing redacted SSH/host plumbing; no secret bytes in argv or logs.

## Scope Boundaries

- keeweb and vpn: report `n/a (no image pin)` — no drift concept.
- Not auto-remediating drift (no auto-deploy) — detection and reporting only; a human approves the corrective deploy.
- Not comparing the full sha256 digest as the primary signal — the human-readable version (tag / ref) is the drift signal; digest is a secondary confirmation where cheap.
- Not changing the deploy pipeline (that's PR #682's concurrency fix).

### Deferred to Separate Tasks

- A standalone scheduled GitHub Actions drift workflow (separate from Fro Bot): only if autohealing category 5 proves insufficient.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/status.ts` — `StatusSummary` (`{app, http, lastDeploy, version, contentHash, usageStats}`), `TABLE_COLUMNS`, `formatRow`, `unifiedStatusAction` (parallel `Promise.allSettled` over `get<App>StatusSummary`). Add a `drift` field + column; populate per app.
- Per-app status today reads only `docker compose ps --format json` service state (gateway/umami/dashboard) — they do **not** read the running image. cliproxy reads `/v0/management/latest-version` (the *available upstream* version, not the running one). Drift needs a live-running-version probe added per app.
- `apps/gateway/src/deploy.ts` `resolveUpstreamPin(jsonPath?)` → `{repo, ref}` — committed pin source for gateway. Live: `git -C /opt/gateway describe --tags`.
- `apps/<app>/docker-compose.yaml` `image:` line — committed pin for cliproxy/umami/dashboard (tag@sha256). No existing parser helper.
- SSH plumbing to reuse: `packages/cli/src/lib/known-hosts.ts` `buildKnownHostsArgs`, `packages/cli/src/lib/ssh-identity.ts` `buildIdentityArgs`, `packages/cli/src/lib/redact.ts` `redactHost`, per-app `validate<App>Host`.
- `packages/cli/src/commands/mcp.ts` `MCP_ALLOWLIST` — drift rides on the existing `status` surface; no new allowlist entry.
- `.github/workflows/fro-bot.yaml` category 5 "DEPLOY PIPELINE HEALTH" — checks the most recent Deploy run per app (success), not pin-vs-live drift. Extend its prompt.

### Institutional Learnings

- `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md` — the incident this guards against; its prevention section explicitly calls for drift detection.

## Key Technical Decisions

- **Version (tag/ref) is the drift signal, not service health.** Drift = committed human-readable version != live running version.
- **Fail-safe verdict via a tagged union, not sentinel strings (the linchpin).** Parsing returns `type TagResult = {ok: true; tag: string} | {ok: false}`. The verdict is a pure function: `committed.ok && live.ok ? (committed.tag === live.tag ? 'ok' : 'drift') : 'unknown'`. This makes "any failure → `unknown`, never a false `ok`" mathematically provable — two silent parser failures cannot collapse into a matching sentinel. Decision matrix:

  | Committed pin | Live version | Verdict |
  |---|---|---|
  | parsed | parsed, equal | `ok` |
  | parsed | parsed, not equal | `drift` |
  | parsed | unreachable / SSH failure | `unknown` |
  | parsed | parse failure | `unknown` |
  | parse failure | anything | `unknown` |
  | keeweb / vpn | n/a | `n/a` |

- **Per-app live-version probe (locked):**
  - **umami / dashboard → piggyback on the existing `docker compose ps --format json` call (NO new SSH hop).** That JSON already carries an `Image` field per service; extend the existing `ComposePsEntry` (currently `{Name, State, Health}`) to read `Image`, then `parseComposeImageTag` it. Zero extra round-trip.
  - **gateway → a second SSH call `git -C /opt/gateway describe --tags`** (compare to `upstream.json` ref via `resolveUpstreamPin`). Cannot piggyback: the gateway compose `Image` is a locally-built name (`fro-bot-gateway`), not a version tag; the upstream git ref is the canonical live version (per `docs/runbooks/gateway-announce-event-verification.md`). This adds one SSH hop to the gateway status path.
  - **cliproxy → new SSH infrastructure (architecture change).** cliproxy status is HTTP-only today (no SSH, no `validateCliproxyHost`, no `CLIPROXY_SSH_KEY` plumbing in the CLI). Drift requires adding all of it: a `validateCliproxyHost` (port the gateway/umami/dashboard validator), `CLIPROXY_SSH_KEY` identity args, known-hosts args, and an SSH `docker inspect --format '{{.Config.Image}}' $(docker compose --project-directory /opt/cliproxy ps -q cli-proxy-api)`. Use the running image tag, NOT `/v0/management/latest-version` (that's the *available upstream* version, not what's running).
- **Read the live image with `docker inspect --format '{{.Config.Image}}'`** for the three image apps — one read returns `name:tag@sha256:digest`, giving the tag (primary drift signal) and digest (secondary, free) in a single SSH call. Avoids the existing two-step `RepoDigests` pattern. Target the *app* service (`cli-proxy-api` / `umami` / `dashboard`), never the shared `caddy` sidecar. (umami/dashboard get this from the piggybacked `Image` field; only cliproxy and gateway need a dedicated probe call.)
- **Tag is the v1 drift grain; digest is a free secondary check.** Tag mismatch catches the cancelled-deploy / rolled-forward-main case (the target failure). When the tag matches but the digest diverges (rare tag re-push), surface `drift`, not `ok`. The existing deploy-time `assertRunningImageDigest` gate is unchanged.
- **Committed-pin source — see Open Question (the central correctness fork).** The CLI locates the repo via the existing `findRepoRoot()` (`packages/cli/src/lib/repo-root.ts`), so it works from any CWD *given a checkout*. Two unresolved questions the review surfaced: (a) for a **global install with no checkout reachable**, the committed pin is unreadable → `unknown` (which makes the status surface low-value for that path); (b) even with a checkout, the **working tree may be behind `main`** — comparing against the local working-tree pin can report a false `ok` when `main` already moved. The authoritative committed pin is `main`'s pin (e.g. `git show origin/main:apps/<app>/docker-compose.yaml`), not the working-tree file. Resolution pending — see Open Questions.
- **`drift` is a verdict-only enum on `StatusSummary`** (`'ok'|'drift'|'unknown'|'n/a'`) — never error text or hostnames. SSH/parse failures are logged to stderr by the per-app action (redacted via `redactHost`), not injected into the drift value.
- **CI home is autohealing category 5**, not a new workflow — see Unit 3 for the DRY-vs-duplication decision.

## Open Questions

### Resolved During Planning

- Which apps? → 4 Docker apps; keeweb/vpn `n/a`.
- Use `latest-version` for cliproxy live? → No; that's available-upstream, not running. Use the running image tag.
- New MCP tool? → No; drift rides the existing read-only `status` surface.

### Blocking — Resolve Before Implementation (surfaced by document-review)

- **Committed-pin source-of-truth (P0).** Should "committed pin" mean `main`'s pin (`git show origin/main:…`, with a fetch) or the local working-tree file? Working-tree comparison can report a false `ok` when the local checkout is behind `main` — defeating the feature's promise. And for a global install with no checkout, drift is permanently `unknown`. This determines whether the `infra status` surface (Unit 2) is load-bearing or whether the CI/autohealing path (Unit 3, always has a fresh checkout) is the real home.
- **Is broad drift-detection the right shape post-#682? (P0/scope).** #682 fixed the *cause* (cancelled gated deploys). Reviewers (product-lens, scope-guardian) ask whether a narrower **cancelled/incomplete-deploy detector** (autohealing checks for cancelled deploy runs at the merge SHA, or a post-merge "did main's pin reach prod" assertion) catches the same incident class more directly than reconstructing pin-vs-live across 4 heterogeneous apps — avoiding the cliproxy SSH-expansion and the status-surface complexity entirely.

### Deferred to Implementation

- Confirming the live `Image` field shape in `docker compose ps --format json` on the umami/dashboard droplets (proven to exist in gateway test fixtures; verify the exact `repo:tag@sha256:digest` form live before relying on the piggyback).
- Gateway ref-vs-ref limitation (P1): `git describe --tags` proves the checkout ref, not that the running image was built from it — the stale-image failure class can slip through. Decide whether to also compare the running image digest (the existing `assertRunningImageDigest` provenance) for gateway, or accept ref-only as a known limitation.
- cliproxy `Config.Image` reflects the container's create-time image spec — a recreate from a `:latest` override could mislead. Decide whether to additionally compare the image ID/digest, or accept compose-pin-vs-Config.Image as sufficient.

## Implementation Units

- [ ] **Unit 1a: cliproxy status SSH plumbing**

**Goal:** Give the cliproxy CLI status path the SSH wiring it lacks today, so the cliproxy live-version probe can run. (cliproxy status is HTTP-only; gateway/umami/dashboard already have SSH.) `validateCliproxyHost` **already exists** (`packages/cli/src/commands/cliproxy/host.ts`, used by `login.ts`/`open.ts`) — reuse it; do not recreate it.

**Requirements:** R3, R5

**Dependencies:** None

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/status.ts` (import the existing `validateCliproxyHost`; thread `CLIPROXY_SSH_KEY` + host through `buildIdentityArgs`/`buildKnownHostsArgs`; `getCliproxyStatusSummary` gains the host needed for SSH)
- Test: extend `packages/cli/src/commands/cliproxy/status.test.ts` (host-validation-before-SSH + no-argv-leak assertions; `host.ts` itself is already covered by `host.test.ts`)

**Approach:**
- Reuse `validateCliproxyHost` (rejects `-`-prefixed and out-of-alphabet hosts) before any SSH argv.
- cliproxy SSH stays additive: HTTP management checks remain primary; SSH is only for the drift probe and degrades to `unknown` if SSH fails even when HTTP is healthy. Use a status-only read-only command surface; the SSH key must not double as a deploy/admin credential.

**Test scenarios:**
- Error path: a `-`-prefixed host is rejected before SSH argv is built (ProxyCommand injection vector).
- Edge (no leak): a secret-shaped host value is redacted in any surfaced error; no secret bytes in argv.

**Verification:**
- cliproxy status constructs its SSH command via the existing validator with no secret leakage in argv; SSH failure degrades the drift verdict to `unknown` while HTTP checks still report.

- [ ] **Unit 1: Drift module + per-app live-version probes**

**Goal:** A single shared drift module returning `{committed, live, drift}` per Docker app, with per-app live-version probes wired into each `get<App>StatusSummary`.

**Requirements:** R1, R3, R5

**Dependencies:** Unit 1a (cliproxy SSH)

**Files:**
- Create: `packages/cli/src/lib/deploy-drift.ts` (the `TagResult` union, `parseComposeImageTag`, `resolveCommittedPin(app)`, `compareTags(committed, live)` verdict fn, `DriftResult` type — all drift logic centralized here)
- Modify: `packages/cli/src/commands/{cliproxy,gateway,umami,dashboard}/status.ts` (thin per-app live-probe stub feeding into the shared `compareTags`)
- Test: `packages/cli/src/lib/deploy-drift.test.ts`

**Approach:**
- `parseComposeImageTag`: regex `image: [^@]+:([^@\s]+)@sha256:` capturing the tag; `{ok:false}` when no match (incl. a no-digest `image:` line). Must accept v-prefixed (`v7.2.41`), semver (`3.2.0`), date-like (`2026.06.41`) tags uniformly. (The only existing helper, `parseComposeImageDigest` in `apps/dashboard/src/deploy.ts`, parses the *digest*; the tag parser is new.)
- `compareTags` is the pure verdict function from the KTD matrix — the single source of the `ok/drift/unknown` decision.
- **gateway probe:** `resolveUpstreamPin().ref` (committed) vs a *second* SSH `git -C /opt/gateway describe --tags` (live).
- **umami/dashboard probe:** committed compose tag vs the `Image` field already present in the existing `docker compose ps --format json` output (extend `ComposePsEntry` with `Image?`); no new SSH.
- **cliproxy probe:** committed compose tag vs SSH `docker inspect --format '{{.Config.Image}}' $(docker compose --project-directory /opt/cliproxy ps -q cli-proxy-api)`; parse the tag (and digest) from `name:tag@sha256:digest`. Uses Unit 1a's SSH.
- Every probe targets the *app* service, never the shared `caddy`. Reuse `buildKnownHostsArgs`/`buildIdentityArgs`/`redactHost`/`validate<App>Host`. Any failure → `{ok:false}` → `unknown`.

**Execution note:** Load `systematic:test-driven-development`. Mock the SSH/HTTP boundary (Bun.spawn / fetch) — match existing status.test.ts mocking; do not hit live droplets in tests.

**Patterns to follow:**
- `apps/gateway/src/deploy.ts` `resolveUpstreamPin` + `assertRunningImageDigest` (live-image read shape); `apps/dashboard/src/deploy.ts` `parseComposeImageDigest` (parser style); existing `get<App>StatusSummary` SSH construction.

**Test scenarios:**
- Happy path: committed `v7.2.41`, live `v7.2.41` → `ok`.
- Edge: committed `3.2.0`, live `3.1.0` → `drift`.
- Edge (parser): tags `v7.2.41`, `3.2.0`, `2026.06.41` all parse to the expected tag; a no-digest `image: repo/name:tag` line → `{ok:false}`.
- Edge (false-OK guard): both committed and live parse-fail → `unknown`, NOT `ok` (proves the tagged union prevents the sentinel collapse).
- Error path: SSH/host unreachable → `unknown`.
- Error path: empty `git describe --tags` / unexpected `docker inspect` output → `unknown`.
- Edge (security): host validation rejects a `-`-prefixed host before any SSH; a secret-shaped host value is redacted in any surfaced error.
- Edge (digest secondary): tag matches but digest differs → `drift`.

**Verification:**
- `compareTags` matches the decision matrix for every row; each Docker app resolves `{committed, live, drift}`; umami/dashboard add no second SSH call.

- [ ] **Unit 2: Surface drift in `infra status` (+ JSON + MCP)**

**Goal:** Add a per-app drift indicator to the unified status table and JSON; keeweb/vpn show `n/a`.

**Requirements:** R2, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/cli/src/commands/status.ts` (`StatusSummary` + `TABLE_COLUMNS` + `formatRow` + `unifiedStatusAction`)
- Modify: `packages/cli/src/commands/{cliproxy,gateway,umami,dashboard}/status.ts` (populate the drift field in `get<App>StatusSummary`)
- Test: `packages/cli/src/commands/status.test.ts` (+ per-app status tests as needed)

**Approach:**
- Add a `drift` field to `StatusSummary` (`'ok'|'drift'|'unknown'|'n/a'`) and a `Drift` column; render OK/DRIFT/n-a in text, structured value in `--json`.
- keeweb/vpn populate `n/a`. The MCP `status`/`<app> status` tools inherit the field automatically (read-only; no allowlist change).
- Update the unified-status help snapshot if the table header changes.

**Test scenarios:**
- Happy path: one app `drift`, others `ok`/`n/a` → row + JSON reflect each correctly.
- Edge: an app summary rejected in `Promise.allSettled` → drift shows `unknown`, not a crash.
- Happy path (JSON): `--json` payload includes the `drift` field per app.
- Snapshot: unified status help/table snapshot updated for the new column.

**Verification:**
- `infra status` and `infra status --json` show per-app drift; `bun test` green; snapshot updated.

- [ ] **Unit 3: Extend Fro Bot autohealing category 5 with drift check**

**Goal:** Make the daily autohealing report flag committed-pin-vs-live-version drift for the 4 Docker apps, reusing the CLI's drift verdict rather than re-deriving it.

**Requirements:** R4

**Dependencies:** Unit 2 (the `infra status --json` drift field is the single source of truth)

**Files:**
- Modify: `.github/workflows/fro-bot.yaml` (category 5 "DEPLOY PIPELINE HEALTH" prompt in `SCHEDULE_PROMPT`; possibly the `fro-bot` job env to expose drift-probe secrets — see decision below)

**Approach (DRY-vs-duplication decision — resolve before implementing):**
- **Preferred (DRY):** the category 5 prompt runs `bunx @marcusrbrown/infra status --json` and reads the per-app `drift` field — same code, guaranteed-consistent verdicts, minimal prompt. This requires the `fro-bot` job to have the drift-probe secrets (`GATEWAY_HOST`/`GATEWAY_SSH_KEY`, `UMAMI_DOMAIN`/`UMAMI_SSH_KEY`, `DASHBOARD_DOMAIN`/`DASHBOARD_SSH_KEY`, `CLIPROXY_DOMAIN`/`CLIPROXY_SSH_KEY`) — secrets the workflow does NOT have today. Widening the Fro Bot credential surface is the cost.
  - To bound that cost: prefer a dedicated minimal-scope source for just these read-only SSH keys rather than handing Fro Bot the full per-app deploy environments.
- **Fallback (intentional duplication):** if widening Fro Bot's secret surface is rejected, the prompt re-implements the pin-vs-live comparison (read compose/`upstream.json` on `main`, SSH each host). The plan must then state "Intentional duplication — Fro Bot re-derives drift to avoid widening its secret surface" and add an AGENTS.md note that the prompt must stay in sync with the CLI verdict semantics.
- Either way: report drift explicitly and note that a *cancelled* deploy run does NOT show as a failed run, so pin-vs-live is the authoritative signal. Reporting only (no auto-deploy). `SCHEDULE_PROMPT` only — leave `PR_REVIEW_PROMPT` untouched.

**Open question for this unit:** DRY (expose scoped drift secrets to Fro Bot) vs duplication (re-derive in prompt). Default to DRY with a minimal secret scope; confirm with the operator before adding secrets to the Fro Bot job.

**Test expectation:** none — workflow-prompt copy change (+ possible job-env secret additions). Covered by existing YAML-validity / `.yaml`-extension conventions gates.

**Verification:**
- `.github/workflows/fro-bot.yaml` is valid YAML; category 5 names the pin-vs-live drift check for all 4 Docker apps via the chosen mechanism; `PR_REVIEW_PROMPT` unchanged.

## System-Wide Impact

- **Interaction graph (per app, sharpened):**
  - umami / dashboard: no change to the call graph — drift reads the `Image` field from the *existing* `docker compose ps` call. No new SSH hop.
  - gateway: adds a *second* serial SSH call (`git describe --tags`) after the existing `docker compose ps`. Still read-only, but gateway status now does two SSH hops — the slowest app to resolve.
  - cliproxy: first-order change — status goes from **HTTP-only to HTTP+SSH** (new host validation, key materialization, known-hosts). New failure mode: SSH down while HTTP healthy → drift `unknown`, HTTP checks still report.
- **Error propagation:** Probe failures degrade to `unknown` (via the `TagResult` union) and never block the rest of the status table (`Promise.allSettled`); each per-app `try/catch` sets `drift: 'unknown'` on any throw, never `'ok'`.
- **API surface parity:** `infra status`, `infra <app> status`, and the MCP equivalents all gain the drift field consistently.
- **Unchanged invariants:** no new mutating MCP tool; the `drift` field carries only the verdict enum (never error text/hostnames); SSH secret handling (redacted host, identity-file materialization, no argv secrets) preserved; the deploy-time `assertRunningImageDigest` gate and the deploy pipeline are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **False `ok` from a silent parser fallback** (the exact failure this guards against) | `TagResult` tagged union, not sentinel strings; `compareTags` is a 3-line pure fn auditable against the decision matrix — two failures can't collapse into a match. |
| cliproxy SSH expansion introduces a new failure surface | Additive: HTTP checks stay primary; SSH only feeds drift and degrades to `unknown`. Unit 1a adds `validateCliproxyHost` with the same `-`-prefix rejection invariant; tested. |
| Gateway second SSH hop adds status latency | Acknowledged: gateway is the slowest app under drift. Bounded by the existing SSH `ConnectTimeout`; if `git describe` proves slow, make the drift probe lazy. |
| Fro Bot duplication drifts from CLI verdict semantics (if duplication fallback chosen) | Prefer the DRY `infra status --json` path; if duplicating, AGENTS.md note ties the prompt to the CLI verdict and a review reminder. |
| Secret leakage via new SSH calls | Reuse `redactHost` + identity-file plumbing; host validation runs before argv; `drift` field never carries error text; tests assert no secret-shaped value in errors. |
| cliproxy `latest-version` mistaken for running version | Explicitly use the running image tag from `docker inspect '{{.Config.Image}}'`, not `/v0/management/latest-version`. |

## Documentation / Operational Notes

- Changeset: **yes** — `packages/cli/src/` runtime surface changes (new `status` drift field is user-facing CLI behavior). Minor.
- Update `packages/cli/AGENTS.md` / per-app AGENTS notes describing the drift indicator and that `unknown` ≠ `ok`.
- Pairs with the merged concurrency fix (PR #682): #682 removes the *cause* of strands, drift detection makes any residual strand *observable*.

## Sources & References

- Related: `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md`, infra PR #682 (concurrency fix), PR #670 (umami strand).
- Related code: `packages/cli/src/commands/status.ts`, `packages/cli/src/commands/{cliproxy,gateway,umami,dashboard}/status.ts`, `apps/gateway/src/deploy.ts` (`resolveUpstreamPin`), `apps/<app>/docker-compose.yaml`, `.github/workflows/fro-bot.yaml` (category 5).
