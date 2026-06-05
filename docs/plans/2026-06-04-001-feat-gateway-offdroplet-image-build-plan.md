---
title: 'feat: Off-droplet gateway image build (CI → GHCR → droplet pull)'
type: feat
status: completed
date: 2026-06-04
origin: docs/solutions/workflow-issues/gateway-deploy-resourcing-thrash-2026-06-04.md
---

# feat: Off-droplet gateway image build (CI → GHCR → droplet pull)

## Overview

Move the gateway + workspace Docker image builds off the production droplet. Today
`apps/gateway/src/deploy.ts` runs `docker compose up -d --build` on the droplet, which rebuilds
the memory-heavy `gateway` and `workspace` images **while the old stack is still running** — on the
`s-1vcpu-2gb` box this exhausts RAM and thrashes swap (a v0.54.1 cutover caused a ~50 min outage).

This plan builds both images in GitHub Actions, pushes them to GHCR, and changes the droplet deploy
to `docker compose pull` + recreate (no `--build`). The prod box never builds again; it only pulls a
prebuilt artifact. This eliminates the root cause with no recurring infrastructure cost.

## Problem Frame

The gateway deploy is the only deploy in the repo that **builds images on the target host**
(`apps/cliproxy` and `apps/umami` pull prebuilt registry images). The two gateway services that build
from source — `gateway` and `workspace` — are exactly the memory-heavy ones, and the build runs
concurrently with the live stack. On a 2 GB droplet the combined footprint exceeds available RAM,
and a fresh upstream ref (cold build cache) makes it worse. See origin:
`docs/solutions/workflow-issues/gateway-deploy-resourcing-thrash-2026-06-04.md`.

## Requirements Trace

- R1. The gateway droplet must never build images during deploy — it only pulls prebuilt images.
- R2. CI must build `gateway` + `workspace` images from the pinned `apps/gateway/upstream.json` ref and push them to GHCR before the droplet deploy runs.
- R3. The deploy must preserve the **safe-failure property**: if the new image is unavailable/bad, the old stack stays live (no teardown-before-ready).
- R4. The deploy must preserve the **secrets-checksum recreate gate** and all existing secret-materialization safety (stdin-only, `0600`, no argv).
- R5. Post-deploy verification must confirm the **running image digest** matches the CI-pushed GHCR digest (not a tag, not the git source ref — tag comparison is circular against a mutable label).
- R6. No new recurring **compute** cost (GHCR storage/retention for a small image set is negligible; no droplet build CPU).

## Scope Boundaries

- Not resizing the droplet (this plan removes the need to).
- Not changing `mitmproxy` or `caddy` — they already use pullable upstream `image:` refs.
- Not changing the upstream `fro-bot/agent` Dockerfiles or compose `build:` definitions (we build *with* them in CI, unchanged).
- Not migrating `cliproxy`/`umami` deploys (they already pull).
- Not enforcing GHCR tag immutability at the registry level (we pin + verify by **digest** instead, which is stronger than tag immutability).

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/src/deploy.ts:1208-1223` — compose command builder: `docker compose --project-directory /opt/gateway/deploy up -d --build --wait --wait-timeout 120 --remove-orphans` (+ `--force-recreate` when `forceRecreate || checksumChanged`). **This is where `--build` is removed and a `pull` step is added.**
- `apps/gateway/src/deploy.ts:553-603` — `buildComposeOverride()` already injects an `image:`-based `caddy` service into `compose.override.yaml`. **Same mechanism adds `image:` to `gateway` + `workspace`.**
- `apps/gateway/src/deploy.ts:1076-1109` — upstream checkout on droplet (`git clone/fetch/reset` at the pinned ref). Still needed for `compose.yaml` + `init-certs.sh` + Dockerfiles, but the droplet no longer *builds* from it.
- `apps/gateway/src/deploy.ts:178-211` — `resolveUpstreamPin()` reads `apps/gateway/upstream.json` (`repo`, `ref`). CI build job reads the same file for the ref.
- Upstream `fro-bot/agent` `deploy/compose.yaml`: `gateway` → `build: {context: .., dockerfile: deploy/gateway.Dockerfile}`; `workspace` → `build: {context: .., dockerfile: deploy/workspace.Dockerfile}`; both build from repo root `..`. `mitmproxy`/`caddy` are pullable `image:`.
- `.github/workflows/deploy-gateway.yaml:66-144` — reusable deploy job: runner checks out infra, `bun install`, validates secrets, copies known_hosts, runs `bun run --cwd apps/gateway deploy` (script SSHes). **New build-and-push job goes here, before deploy.**
- `.github/workflows/deploy.yaml:87-115` — parent passes the gateway secret set into the reusable workflow.

### Institutional Learnings

- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — `--build` was *added* because `up` on a `build:` service won't rebuild on source change. Off-droplet build must guarantee the **pulled image actually reflects the pinned ref**, and verification must check the running image, not the source tree.
- `docs/solutions/workflow-issues/gateway-deploy-resourcing-thrash-2026-06-04.md` (origin) — explicitly recommends "build off-droplet (GHCR) and pull" as the no-recurring-cost fix; preserve "old stack stays live until the new artifact is ready."
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — `readRemoteChecksum()` must fail on SSH errors (not act like first-deploy); secret bytes via stdin + `0600`, never argv. The checksum/sentinel gate must remain authoritative after the artifact source changes.
- `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` — a valid image tag is not proof of a valid boot contract; keep pre-cutover/post-deploy verification against the actual running container.

## Key Technical Decisions

- **Build location:** GitHub Actions runner (16 GB RAM, no swap pressure) builds both images via the upstream Dockerfiles using `docker/build-push-action`. Workspace build was ~200s in a prior preflight; runner has ample headroom.
- **Compose override, always materialized:** `buildComposeOverride()` adds `image: ghcr.io/marcusrbrown/infra-gateway@<digest>` and `image: ghcr.io/marcusrbrown/infra-workspace@<digest>` to the respective services. **Critical fix from review:** the override file must be written on **every** deploy, not only when announce is enabled (today it is announce-gated) — otherwise the default announce-disabled path has no `image:` pin and silently falls back to `build:` semantics. Compose deep-merges; the upstream `build:` stays present but is **inert without `--build`**. Deploy does `docker compose pull` then `docker compose up -d --wait` (no `--build`).
- **Digest-pinned images, not tags:** CI captures the **pushed digest** of each image and threads it into the override as `image: ...@sha256:<digest>`. Tags (`:<ref>`) are still pushed for human readability, but the deploy pulls + verifies by **digest** — GHCR tags are mutable, so tag-based pull/verify would be non-deterministic and the verify would be circular (comparing a tag to itself). Digest pull is immutable and makes verification a true identity check (R5).
- **GHCR package visibility — PUBLIC, gated on a secret-safety check:** the built images should contain **no secrets** (all secrets are runtime bind-mounts into `/run/secrets/...`, never baked), and the source is public `fro-bot/agent`, so public packages let the droplet pull with **no auth** (simplest, boring). But "no secrets in image" is an assumption, not a fact — so public visibility is **conditional** on an explicit pre-publish secret-safety audit (Unit 1): inspect the upstream Dockerfiles for `ARG`/`ENV`/`COPY` of secret material and confirm the build context carries none. *Alternative (privacy-max / if the audit is inconclusive):* keep packages private and `docker login ghcr.io` on the droplet with a read-only token materialized like other secrets (stdin, `0600`, no argv). Decision: **public after the audit passes**; fall back to private+token if it doesn't. Marcus confirms at work time.
- **CI permission scoping:** `packages: write` is granted **only to the `build-images` job**, never workflow-wide; the `deploy` job stays package-read-only. Least privilege.
- **Sequencing:** the `build-images` job runs first; the `deploy` job declares `needs: build-images`. If the build/push fails, the deploy never runs and the old stack stays live (R3).
- **Verification by digest:** post-deploy, compare the running container's `RepoDigests` to the CI-pushed digest, not a tag or the git checkout (R5).

## Resolve Before Implementation

- **PROVE the compose `build:`+`image:` semantics empirically before writing Unit 2.** The entire plan rests on: a service that has BOTH an upstream `build:` and an override `image:@digest`, run with `docker compose pull` then `up -d` (no `--build`), pulls and runs the GHCR image and **cannot** trigger a host-side build — including the failure case where the image is missing/unpullable (must error, never fall back to building). Verify against the **droplet's actual Compose version** in a disjoint compose project (same preflight discipline used for daemon upgrades). If Compose can fall back to a host build for a `build:`-bearing service, the no-build guarantee is not real and Unit 2 must add an explicit guard (e.g. `--pull always` semantics, or strip `build:` in the override) before proceeding. This is the load-bearing assumption flagged by every technical reviewer.

## Open Questions

### Resolved During Planning

- *How does `image:` coexist with upstream `build:`?* — Expected: Compose merges both; without `--build`, `up` uses the local (pulled) image and ignores `build:`. **Must be proven by the Resolve-Before-Implementation preflight above, not assumed.**
- *Does the droplet still need the upstream checkout?* — Yes, for `compose.yaml`, `init-certs.sh`, and the Dockerfiles compose references — but it no longer builds from them.
- *First-deploy / image-missing?* — CI always builds+pushes before the deploy job (`needs: build-images`), so the digest exists when CI deploys. Local `bun run --cwd apps/gateway deploy --local` pulls the CI-built image; if the ref was never built by CI it fails clearly.
- *Emergency path regression (honest tradeoff):* this change **removes the on-droplet local-build fallback** — today's exact incident was recovered by an on-droplet rebuild, which will no longer be possible. The deploy now depends on CI + GHCR availability + pull working. This is a deliberate trade: the on-droplet build is precisely what causes the outage this plan fixes, so keeping it as a fallback would keep the hazard. **Mitigation (Unit 3 runbook):** document the break-glass path — build+push the pinned ref from a workstation to GHCR, then `deploy --local` (pull). A workstation has ample RAM; this is the off-droplet build done by hand. Operators must never `docker compose up --build` on the droplet (it reintroduces the thrash); the override `image:` pins make the GHCR image the source of truth regardless.

### Deferred to Implementation

- Exact GHCR image name suffixes (`infra-gateway`/`infra-workspace` vs other) and `docker/build-push-action` cache config — finalize against the upstream Dockerfile build contexts at implementation time.
- Whether to compare RepoDigests vs image-ID in verification — pick the most reliable signal once testing the real pulled image.

## Implementation Units

- [x] **Unit 1: CI build-and-push job (GHCR)**

**Goal:** Build `gateway` + `workspace` images from the pinned upstream ref in CI and push to GHCR, before any droplet deploy.

**Requirements:** R2, R3, R6

**Dependencies:** None

**Files:**
- Modify: `.github/workflows/deploy-gateway.yaml` (add a `build-images` job; `deploy` job gains `needs: build-images`; add `permissions: packages: write`)
- Modify: `.github/workflows/deploy.yaml` (ensure the parent grants `packages: write` to the reusable gateway job if required)

**Approach:**
- New `build-images` job on `ubuntu-latest` with **job-scoped** `permissions: { contents: read, packages: write }` (never workflow-wide): read `ref` from `apps/gateway/upstream.json`; `actions/checkout` infra, then check out `fro-bot/agent` at that ref; `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN`; two `docker/build-push-action` steps (gateway: `deploy/gateway.Dockerfile`, workspace: `deploy/workspace.Dockerfile`, both `context: <upstream-root>`), tagged `:<ref>` for readability and pushed to `ghcr.io/marcusrbrown/infra-gateway` + `infra-workspace`.
- **Capture each pushed digest** (`build-push-action` exposes `outputs.digest`) and pass both digests to the `deploy` job as job outputs — the deploy pins + verifies by digest, not tag.
- `deploy` job declares `needs: build-images` and keeps default read-only package perms; a failed build blocks the deploy (preserves R3).
- **Pre-publish secret-safety audit** (gates the public-visibility decision): inspect the upstream `deploy/gateway.Dockerfile` + `deploy/workspace.Dockerfile` + build context for `ARG`/`ENV`/`COPY` of secret material. If clean, packages go public (no droplet auth). If not, fall back to private + a read-only GHCR pull token.
- SHA-pin all new actions with `# vX.Y.Z` comments (repo convention).

**Patterns to follow:**
- Existing reusable-job + secret-passthrough shape in `.github/workflows/deploy-gateway.yaml`; SHA-pinning convention across `.github/workflows/`.

**Test scenarios:**
- Test expectation: none — CI workflow change, validated by the conventions test (SHA-pin + `.yaml` + action-comment) and a real dispatch. No unit-testable logic.

**Verification:**
- A gateway deploy dispatch builds both images and pushes `:<ref>` tags to GHCR; the `deploy` job only starts after `build-images` succeeds.

- [x] **Unit 2: Droplet deploy pulls instead of builds**

**Goal:** Change `deploy.ts` so the droplet pulls the GHCR images and recreates, never building.

**Requirements:** R1, R3, R4, R5

**Dependencies:** Unit 1 (images must exist in GHCR)

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (override `image:` refs for `gateway`/`workspace`; remove `--build`; add `docker compose pull`; update running-image verification)
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**
- **Always materialize the override** with `image:` digest pins for `gateway` + `workspace` (the digests come from the deploy job's env, sourced from `build-images` outputs). Decouple this from announce gating — today `buildComposeOverride()` only writes when announce is enabled; the image pins must write unconditionally (announce/Caddy stays a conditional layer within the same file).
- Replace the `up -d --build ...` invocation: first `docker compose --project-directory <dir> pull`, then `docker compose --project-directory <dir> up -d --wait --wait-timeout 120 --remove-orphans` (keep conditional `--force-recreate` on `forceRecreate || checksumChanged`). Apply whatever guard the Resolve-Before-Implementation preflight proved necessary so a missing image errors rather than host-builds.
- Keep upstream checkout (compose/init-certs/Dockerfiles) and the checksum gate unchanged (R4).
- Update post-deploy verification to read the running container's `RepoDigests` and assert it matches the CI-pushed digest (R5) — not a tag.
- Public path → no droplet auth; private path → guarded `docker login ghcr.io` via stdin (no argv), token materialized like other secrets.

**Execution note:** Test-first — add failing tests for the new override `image:` entries and the `pull`-then-`up`-without-`--build` command shape before changing the builder.

**Patterns to follow:**
- The existing `caddy` `image:` injection in `buildComposeOverride()`; the existing compose-arg-building tests in `deploy.test.ts`.

**Test scenarios:**
- Happy path: the override is materialized on the default (announce-disabled) path and contains `image:` digest pins for both `gateway` and `workspace`.
- Happy path: the compose command sequence includes a `pull` invocation and an `up -d --wait` invocation that does **not** contain `--build`.
- Edge case: `--force-recreate` still appended when `forceRecreate` is true or the checksum changed; absent otherwise.
- Edge case: override image pins use the exact digests supplied by the build job (not tags).
- Error path: verification fails (throws) when the running container's `RepoDigests` does not match the CI-pushed digest.
- Error path (from preflight): a missing/unpullable image errors out and does **not** trigger a host-side build.

**Verification:**
- A deploy pulls both images, recreates, all services healthy, and the running gateway/workspace images are the GHCR `:<ref>` artifacts (verified by image ref, not git source).

- [x] **Unit 3: Docs + AGENTS.md for the new flow**

**Goal:** Document the build→push→pull deploy flow, GHCR packages, local/emergency deploy path, and running-image verification.

**Requirements:** R1, R5

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `apps/gateway/AGENTS.md` (deploy flow now: CI builds+pushes → droplet pulls; GHCR package names + visibility; local-deploy/emergency path; image verification)
- Modify: root `AGENTS.md` if it documents the gateway deploy mechanism
- Modify: `README.md` only if it describes the gateway deploy build step

**Approach:**
- Replace any "droplet builds images" wording with the CI-build → GHCR-push → droplet-pull flow.
- Document the **break-glass runbook**: build+push the pinned ref from a workstation to GHCR, then `deploy --local` (pull). Explicitly warn operators never to `docker compose up --build` on the droplet (reintroduces the swap-thrash). State the new dependency on CI/GHCR availability honestly.
- Document the digest-based running-image verification command.
- Note the GHCR package visibility decision (public after secret-safety audit, else private+token) and the pull-auth secret if private.

**Patterns to follow:**
- Existing `apps/gateway/AGENTS.md` deploy-flow + anti-pattern structure.

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- AGENTS.md describes the off-droplet flow accurately; no stale "on-droplet build" references remain (grep clean).

## System-Wide Impact

- **Interaction graph:** CI `build-images` → GHCR → droplet `pull`. The `deploy.ts` checkout + secret-materialization + checksum + Discord-registration flow are otherwise unchanged.
- **Error propagation:** Build/push failure → `deploy` job blocked (old stack untouched). Pull failure on the droplet → `up` does not recreate from a missing image; old stack stays up; deploy errors clearly.
- **State lifecycle risks:** The secrets-checksum sentinel must remain authoritative; recreate still gated on checksum change + `--force-recreate`. The manual emergency rebuild changes from "build on droplet" to "pull a CI-built tag."
- **API surface parity:** `cliproxy`/`umami` already pull prebuilt images; this brings gateway in line. No CLI flag changes (the `--force-recreate`/dry-run surfaces are preserved).
- **Unchanged invariants:** secret materialization (stdin/`0600`/no-argv), `validateGatewayHost`, host-key pinning, `init-certs.sh` CA bootstrap, `--wait`/`--wait-timeout 120`, Discord registration polling — all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Compose host-builds a `build:` service despite the `image:` pin (the outage comes back via the back door) | Resolve-Before-Implementation preflight PROVES the no-build semantics on the droplet's Compose version; Unit 2 adds a guard if needed; test asserts a missing image errors instead of building. |
| Mutable tag pull/verify is non-deterministic | Pin + pull + verify by **digest**, not tag; tags are readability-only. |
| Secret accidentally baked into a public image | Pre-publish secret-safety audit of Dockerfiles/build context gates the public decision; fall back to private + read-only token if inconclusive. |
| GHCR/CI unavailable during an incident (no on-droplet build fallback) | Documented break-glass: workstation build+push → `deploy --local` pull. Honest tradeoff — the on-droplet build is the hazard being removed. |
| Two images (gateway/workspace) drift or one push fails | Both built+pushed in the same `build-images` job; `deploy` gated on `needs: build-images`; both digests threaded together or the deploy doesn't run. |
| `packages: write` over-broad | Scoped to the `build-images` job only; deploy job stays package-read-only. |

## Documentation / Operational Notes

- One-time: set the GHCR packages public (if public path) after first publish, or seed a read-only GHCR token secret (if private path).
- The next `fro-bot/agent` bump exercises the new path end-to-end; verify the running image is the GHCR artifact, not a droplet build.
- No changeset — this changes `apps/gateway/` deploy infra + CI, not `packages/cli/src` (the published package).

## Sources & References

- **Origin document:** `docs/solutions/workflow-issues/gateway-deploy-resourcing-thrash-2026-06-04.md`
- Related code: `apps/gateway/src/deploy.ts` (`buildComposeOverride`, compose-arg builder, `resolveUpstreamPin`), `.github/workflows/deploy-gateway.yaml`, `.github/workflows/deploy.yaml`
- Related learnings: `gateway-deploy-stale-image-2026-05-31.md`, `gateway-first-deploy-cascade-2026-05-20.md`, `gateway-v0500-undeployable-upstream-2026-06-02.md`
- Upstream: `fro-bot/agent` `deploy/compose.yaml`, `deploy/gateway.Dockerfile`, `deploy/workspace.Dockerfile`
