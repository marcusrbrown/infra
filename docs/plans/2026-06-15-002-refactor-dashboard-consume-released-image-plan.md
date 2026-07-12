---
title: 'refactor: Dashboard consumes the released image by digest'
type: refactor
status: completed
date: 2026-06-15
origin: docs/brainstorms/2026-06-15-dashboard-consume-released-image-requirements.md
---

# refactor: Dashboard consumes the released image by digest

## Overview

`apps/dashboard` currently builds its own container image in CI (checkout `fro-bot/dashboard`
at a commit SHA, `docker build` + push `ghcr.io/marcusrbrown/infra-dashboard:<sha>`). Now that
`fro-bot/dashboard` publishes a released, smoke-tested image to GHCR, the dashboard converges to
the model `apps/cliproxy` and `apps/umami` already use: pin the upstream image by `tag@digest`
directly in `docker-compose.yaml`, pull it at deploy time, and let Renovate's implicit
docker-compose manager bump the digest. This is a deletion-heavy refactor — the build job,
`upstream.json`, `DASHBOARD_IMAGE_DIGEST`, the image override, and the bespoke digest
verification all go away.

## Problem Frame

Building the image at deploy time means nothing runs the container before the gated deploy —
how the `127.0.0.1` loopback-bind 502 reached production healthy-but-unreachable
(`fro-bot/dashboard#14`). Upstream now smoke-tests each release by digest and publishes it. The
dashboard is the only app in this repo that builds rather than pulls; the extra machinery exists
solely because of that build. Removing it makes the dashboard consistent with the two existing
pull-based apps. (see origin: docs/brainstorms/2026-06-15-dashboard-consume-released-image-requirements.md)

## Requirements Trace

- R1. Pin `ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd5098...` in `docker-compose.yaml`.
- R2. Remove the `build-images` job; drop `packages: write` from the caller.
- R3. Simplify `deploy.ts` to the umami pull shape (drop image const, digest env, override);
  keep `assertRunningImageDigest` sourced from the compose pin.
- R4. Delete `apps/dashboard/upstream.json`.
- R5. Renovate tracks the digest via the implicit docker-compose manager + a changelog packageRule.
- R6. Docs reflect consume-by-digest.
- R7. Tests updated.
- R8. Rollback runbook in `docs/runbooks/`.

## Scope Boundaries

- No bespoke CI provenance/pull-validation job — the immutable digest pin in compose is the
  contract, same trust model as cliproxy/umami.
- No change to the deploy secret contract, SSH, or host-key handling.
- No change to upstream's release/smoke-test pipeline.

### Deferred to Separate Tasks

- Deleting the `ghcr.io/marcusrbrown/infra-dashboard` GHCR package: manual, operator-performed
  via the GitHub UI once nothing references it. Noted in docs (R6), not automated here.

## Context & Research

### Relevant Code and Patterns

- `apps/umami/src/deploy.ts` — the target shape: `docker compose pull` then
  `up -d --wait --wait-timeout 180 <services>`, image pinned in the committed compose file, no
  image/digest machinery in the deploy script. Mirror this.
- `apps/cliproxy/docker-compose.yaml` / `apps/umami/docker-compose.yaml` — the
  `image: name:tag@sha256:digest` pin convention (e.g.
  `eceasy/cli-proxy-api:v7.2.6@sha256:...`, `umamisoftware/umami:3.1.0@sha256:...`). Neither app
  has an `upstream.json`.
- `.github/renovate.json5` `packageRules` — existing docker-datasource entries for
  `eceasy/cli-proxy-api`, `caddy`, `umamisoftware/umami`, `postgres` (changelog/source URL,
  `automerge: false`, `dependencyDashboardApproval: true`). Mirror one for
  `ghcr.io/fro-bot/dashboard`. The implicit docker-compose manager already tracks the dashboard
  image (PRs #560, #563) — no custom manager needed.
- `apps/dashboard/src/deploy.ts` — build-era machinery to remove: `DASHBOARD_IMAGE_NAME` const,
  `DASHBOARD_IMAGE_DIGEST` requirement + `^sha256:...$` validation, `buildComposeOverride` +
  its override-upload step. KEEP `assertRunningImageDigest` + the two-step `docker inspect`
  RepoDigest verify, re-sourcing the expected digest from the compose pin.
- `apps/dashboard/docker-compose.test.ts` — single image-ref assertion to flip.
- `apps/dashboard/src/deploy.test.ts` — `SpawnFn`-injection mock; `makeHappyPathResponses`
  ordered-response array (the override-upload entry disappears; the RepoDigest-inspect entries
  stay).

### Institutional Learnings

- `docs/solutions/workflow-issues/renovate-changesets-monorepo-targeting-2026-04-15.md` — the
  renovate-changesets action's `exclude-patterns` + `target-package: @marcusrbrown/infra` fallback
  already produces a CLI `patch` changeset for docker-digest bumps under `apps/**` (PRs #560,
  #563). Behavior is preserved by this refactor; verify the first post-change digest PR still
  produces a correctly-scoped changeset.
- `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md` and
  `cliproxy-healthcheck-tooling-migration-2026-06-09.md` — confirm the `name:tag@sha256:digest`
  compose syntax works in this repo and is the Renovate-tracked pattern.

## Key Technical Decisions

- **Converge to cliproxy/umami, don't refine the build machinery.** The simplest correct model
  is the one two apps already use: pin in compose, pull at deploy, Renovate implicit manager. The
  issue/triage framing (digest-pinned `upstream.json` + a provenance job) would add machinery; the
  right move deletes it.
- **Keep `assertRunningImageDigest`, sourcing the expected digest from the compose pin.** Plan
  review (adversarial P1 + security-lens) flagged that `docker compose pull` + `up` does not prove
  the running container is the pinned digest — a stale/cached/partial-pull image passes silently.
  The verifier is the only repo-owned runtime proof and is a pure helper that already exists, so
  retaining it costs ~nothing. cliproxy/umami lacking it is under-verification, not a model to
  copy here. The expected digest comes from the compose pin (not the deleted
  `DASHBOARD_IMAGE_DIGEST` env).
- **Tag + digest, not digest alone.** The tag (`2026.06.15`) gives Renovate's implicit manager an
  anchor; the digest is the immutable contract. Matches cliproxy/umami. Operational rule: Docker
  treats the `@sha256` digest as authoritative — the tag is metadata for Renovate only, never a
  pull target or fallback. Compose resolves to the digest regardless of the tag.
- **No custom Renovate manager.** The implicit docker-compose manager already tracks the image.
  Only a `packageRules` changelog entry is added.

## Open Questions

### Resolved During Planning

- How do cliproxy/umami pin upstream images? Directly in `docker-compose.yaml` as
  `tag@digest`, no `upstream.json`, no digest env, deploy just pulls + ups. This is the template.
- Does removing the tag break Renovate tracking? Keeping `tag@digest` (not digest-only) preserves
  the implicit manager's anchor, so digest bumps continue automatically.

### Deferred to Implementation

- Exact line removals in `deploy.ts` and which `makeHappyPathResponses` entries drop — knowable
  once editing against the real file; mirror `apps/umami/src/deploy.ts` phase ordering.

## Implementation Units

- [ ] **Unit 1: Pin the released image in `docker-compose.yaml` + delete `upstream.json`**

**Goal:** Pin `ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd5098...` and remove the now-unused
upstream pin file.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `apps/dashboard/docker-compose.yaml`
- Delete: `apps/dashboard/upstream.json`
- Test: `apps/dashboard/docker-compose.test.ts`

**Approach:**
- Replace the `dashboard` service `image:` line with
  `ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd509856430b7bf90119ed2aaff5c579c89f53605596e250494702a8fe5f2e`
  (tag+digest, matching cliproxy/umami).
- Delete `apps/dashboard/upstream.json`.

**Patterns to follow:**
- `apps/umami/docker-compose.yaml` / `apps/cliproxy/docker-compose.yaml` image pin format.

**Test scenarios:**
- Happy path: `docker-compose.test.ts` asserts the image line equals the new
  `ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd5098...` (full literal, so a regression to a
  tag-only or wrong-repo form fails).

**Verification:**
- `docker compose -f apps/dashboard/docker-compose.yaml config` resolves the dashboard service to
  the pinned digest; `apps/dashboard/upstream.json` no longer exists.

- [ ] **Unit 2: Simplify `deploy.ts` to the pull model**

**Goal:** Remove the image-build-era machinery so the deploy just pulls + ups the compose-pinned
image, like umami.

**Requirements:** R3

**Dependencies:** Unit 1

**Files:**
- Modify: `apps/dashboard/src/deploy.ts`
- Test: `apps/dashboard/src/deploy.test.ts`

**Approach:**
- Remove `DASHBOARD_IMAGE_NAME` const and the `DASHBOARD_IMAGE_DIGEST` env requirement + its
  `^sha256:...$` validation.
- **Delete `buildComposeOverride` and its override-upload step entirely.** Verified: the function
  emits only `services: dashboard: image: <name>@<digest>` and nothing else, so with the image
  pinned in the committed `docker-compose.yaml` (Unit 1) there is no remaining override content.
  The committed compose file is the sole image source (umami model).
- **Keep `assertRunningImageDigest` and the two-step `docker inspect` RepoDigest verify (Phase
  9a/9b)** — the one repo-owned runtime proof that the running container is the pinned digest
  (a stale/cached/partial-pull image would otherwise pass silently). Source the expected digest
  from the compose pin instead of `DASHBOARD_IMAGE_DIGEST`: parse the `@sha256:...` digest from
  `apps/dashboard/docker-compose.yaml` (or a single module constant kept in sync with the pin),
  and pass it to `assertRunningImageDigest`. `assertRunningImageDigest` stays unchanged
  (repo-agnostic substring match).
- Keep `docker compose pull` then `up -d --no-build --wait`, mirroring `apps/umami/src/deploy.ts`.

**Execution note:** Load `systematic:test-driven-development`. Adjust the failing tests first
(remove expectations for deleted behavior, assert the umami-shaped pull/up), then delete the
production code to match.

**Patterns to follow:**
- `apps/umami/src/deploy.ts` pull→up phase ordering and `--no-build --wait` usage.

**Test scenarios:**
- Happy path: deploy issues `docker compose pull` then `docker compose up -d --no-build --wait`;
  the spawned compose-up command contains `--no-build` (mirror the gateway `--build` assertion,
  inverted).
- Edge: `validateEnv` no longer requires/validates `DASHBOARD_IMAGE_DIGEST` (removed assertion);
  remaining required secrets still validated.
- Happy path: the expected digest is read from the compose pin and `assertRunningImageDigest`
  passes against a RepoDigest containing `ghcr.io/fro-bot/dashboard@sha256:d3dd5098...`.
- Error path: `assertRunningImageDigest` still throws when the running image's RepoDigests do not
  include the pinned digest (fail-closed retained).
- Removed: tests for the `buildComposeOverride` output and the override-upload step are deleted
  (not skipped). The `assertRunningImageDigest` and RepoDigest-inspect tests are KEPT (updated to
  the new repo digest + compose-sourced expected digest).

**Verification:**
- `deploy.test.ts` passes with the umami-shaped expectations; no reference to
  `DASHBOARD_IMAGE_DIGEST`, `buildComposeOverride`, or `ghcr.io/marcusrbrown/infra-dashboard`
  remains in `deploy.ts`. `assertRunningImageDigest` remains and verifies against the
  compose-pinned digest.

- [ ] **Unit 3: Remove the build job from the workflow + drop caller `packages: write`**

**Goal:** Delete the CI image build; the deploy job no longer needs a digest handoff.

**Requirements:** R2

**Dependencies:** Unit 2

**Files:**
- Modify: `.github/workflows/deploy-dashboard.yaml`
- Modify: `.github/workflows/deploy.yaml`

**Approach:**
- Delete the `build-images` job (checkout upstream, GHCR login, `docker/build-push-action`) and
  its `packages: write`.
- Remove `needs: build-images` and the `DASHBOARD_IMAGE_DIGEST` env from the `deploy-dashboard`
  job. The deploy step (`bun run --cwd apps/dashboard deploy`) stays.
- In `.github/workflows/deploy.yaml`, drop `packages: write` from the `deploy-dashboard` caller
  (down to `contents: read`) — nothing pushes to GHCR anymore.

**Patterns to follow:**
- `.github/workflows/deploy-umami.yaml` — a pull-based deploy workflow with no build job.

**Test scenarios:**
- Test expectation: none (workflow YAML). Verified structurally below + by conventions tests
  (SHA-pin comments, `.yaml` extension, paths-filter quantifier — all unaffected).

**Verification:**
- `deploy-dashboard.yaml` has no `build-images` job, no `packages: write`, no
  `DASHBOARD_IMAGE_DIGEST`; YAML parses; `bun test packages/cli/src/conventions.test.ts` passes;
  the `dashboard` paths-filter in `deploy.yaml` still fires on `apps/dashboard/**`.

- [ ] **Unit 4: Add the Renovate changelog packageRule for the dashboard image**

**Goal:** Give the implicit docker-compose manager's digest-bump PRs richer context + operator
gating, matching the other upstream-image rules.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `.github/renovate.json5`

**Approach:**
- Add a `packageRules` entry matching `ghcr.io/fro-bot/dashboard` (docker datasource) with a
  `description` audit comment, `automerge: false`, `dependencyDashboardApproval: true`, and
  source/changelog URLs — mirroring the `eceasy/cli-proxy-api` / `umamisoftware/umami` entries.
- Do not add a custom manager; the implicit docker-compose manager already tracks the image.
- Leave the existing `apps/*/upstream.json` `ref` custom manager untouched (gateway still uses it).

**Patterns to follow:**
- The existing `matchDatasources: ['docker']` packageRules in `.github/renovate.json5`.

**Test scenarios:**
- Test expectation: none (Renovate config). Verify config validity below.

**Verification:**
- Renovate config parses (JSON5 intact); the new entry mirrors the existing docker rules; the
  generic `ref` custom manager is unchanged.

- [ ] **Unit 5: Update docs to the pull model**

**Goal:** Docs describe consuming the released image by digest, not building it.

**Requirements:** R6

**Dependencies:** Units 1-3

**Files:**
- Modify: `apps/dashboard/AGENTS.md`
- Modify: `apps/dashboard/README.md`
- Modify: `ARCHITECTURE.md`

**Approach:**
- `AGENTS.md`: replace the "Image build (GHCR)" section with an "Image pin (digest)" section
  (upstream publishes a release; the digest in `docker-compose.yaml` is the contract; Renovate
  proposes bumps; deploy pulls). Fix the "Upgrade flow" section (no more default-branch `ref`).
  Keep the "no `--build`" anti-pattern.
- `README.md`: flip the opening "built off-droplet … pushed to infra-dashboard" sentence to
  "consumed from `ghcr.io/fro-bot/dashboard` by digest, pinned in `docker-compose.yaml`". Add a
  rollback pointer to the new runbook (R8).
- `ARCHITECTURE.md`: update the codemap `upstream.json` row (now: image pinned in compose, no
  build) and the "Upstream pinning" cross-cutting bullet (gateway builds; dashboard consumes by
  digest). Note `infra-dashboard` is retired/manually deletable.

**Patterns to follow:**
- `apps/umami/AGENTS.md` / `apps/umami/README.md` image-pin wording.

**Test scenarios:**
- Test expectation: none (docs). No `(enforced)` markers added (no manifest change).

**Verification:**
- No doc references an infra-owned dashboard build or `apps/dashboard/upstream.json`; the
  `infra-dashboard` retirement note is present.

- [ ] **Unit 6: Rollback runbook**

**Goal:** Document the operator rollback path for a bad pinned digest.

**Requirements:** R8

**Dependencies:** Unit 1

**Files:**
- Create: `docs/runbooks/dashboard-released-image-rollback.md`
- Modify: `apps/dashboard/README.md` (cross-link)

**Approach:**
- Follow the `docs/runbooks/` convention (H1 title, "why this exists", "when to use",
  step-numbered "Procedure", "Related" footer — mirror `vpn-egress-box.md`).
- Procedure: `git revert` the `docker-compose.yaml` digest-pin commit (git history holds prior
  good digests; no retained last-known-good state) → re-trigger Deploy Dashboard → verify
  `https://dashboard.fro.bot/api/healthz` returns 200.
- Edge cases: bad release is the only known digest; a newer release published since the revert.
- Cross-link from `apps/dashboard/README.md` (Operations).

**Patterns to follow:**
- `docs/runbooks/vpn-egress-box.md` structure.

**Test scenarios:**
- Test expectation: none (runbook doc).

**Verification:**
- Runbook exists, follows the convention, and is linked from `README.md`.

## System-Wide Impact

- **API surface parity:** none — `dashboard status` MCP exposure reads `docker compose ps`, not
  the image ref; unaffected.
- **Interaction graph:** Renovate's implicit docker-compose manager continues bumping the digest;
  the renovate-changesets fallback continues producing a `@marcusrbrown/infra` patch changeset for
  the bump (verify on the first post-change digest PR).
- **Unchanged invariants:** the gateway's `apps/gateway/upstream.json` + build-images pattern and
  the generic `ref` Renovate custom manager are untouched — this change is dashboard-only.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing the tag would stop Renovate's implicit manager; pinning `tag@digest` (not digest-only) keeps the anchor. | R1 uses `tag@digest`, matching cliproxy/umami. |
| First digest bump after the change produces a malformed/mis-scoped changeset. | Verify the first post-change digest PR yields a correctly-scoped `@marcusrbrown/infra` patch changeset (renovate-changesets fallback already handles `apps/**` docker bumps — PRs #560/#563). |
| `docker compose pull` + `up` doesn't prove the running container is the pinned digest (stale/cached/partial-pull passes silently). | Keep `assertRunningImageDigest` (Unit 2), sourcing the expected digest from the compose pin — the repo-owned fail-closed runtime proof. |
| Image accidentally private on GHCR → no-login droplet `docker compose pull` fails. | The image is public (anonymous manifest 200, per requirements). If it ever goes private, add a deploy-side `docker login` (not a CI build job). Documented in the rollback runbook. |

## Documentation / Operational Notes

- Changeset: this touches `apps/dashboard` deploy config + `packages/cli`-adjacent? No — it does
  not touch `packages/cli/src/`. Per repo convention, **no changeset** is required (apps/ deploy
  config + workflow + docs). Confirm during implementation that no `packages/cli/src/` runtime
  surface changed.
- The retired `ghcr.io/marcusrbrown/infra-dashboard` GHCR package is deleted manually later.

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-15-dashboard-consume-released-image-requirements.md
- Related issue: #561 (+ Fro Bot triage)
- Upstream: fro-bot/dashboard#16 (release pipeline), #14 (bind fix), release `2026.06.15`
- Pattern apps: apps/umami/src/deploy.ts, apps/cliproxy/docker-compose.yaml
