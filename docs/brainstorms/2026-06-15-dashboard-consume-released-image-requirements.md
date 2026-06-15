---
title: Dashboard — consume fro-bot/dashboard released image by digest
date: 2026-06-15
status: requirements
issue: 561
related:
  - apps/dashboard/docker-compose.yaml
  - apps/dashboard/upstream.json
  - .github/workflows/deploy-dashboard.yaml
  - apps/dashboard/src/deploy.ts
  - .github/renovate.json5
---

# Dashboard — consume the released image by digest

## Problem

`apps/dashboard` builds its own container image at deploy time: `deploy-dashboard.yaml`
checks out `fro-bot/dashboard` at the commit SHA in `apps/dashboard/upstream.json`
(`{repo, ref}`) and `docker build`s + pushes `ghcr.io/marcusrbrown/infra-dashboard:<sha>`.
Nothing builds or runs the container before the gated deploy. That is how the
loopback-only `127.0.0.1` bind regression reached production as a public 502 while the
container still reported healthy (fixed in `fro-bot/dashboard#14`).

`fro-bot/dashboard` now publishes a released, smoke-tested image to GHCR
(`fro-bot/dashboard#16`): build once → smoke-test the candidate by digest → promote the
same digest to `:<calver>` / `:latest` / `:sha-<short>` → cut a GitHub Release. The dashboard
should consume that pre-smoked image like every other upstream image this repo deploys.

## Goal

`apps/dashboard` consumes the upstream released image **by digest**, pinned directly in
`apps/dashboard/docker-compose.yaml` as `image: ghcr.io/fro-bot/dashboard:<tag>@sha256:<digest>`
— exactly the model `apps/cliproxy` (`eceasy/cli-proxy-api`) and `apps/umami`
(`umamisoftware/umami`, `postgres`) already use. This **removes** the infra-owned build path
and all the bespoke digest-plumbing the dashboard only had because it built its own image.

## Guiding insight: converge to the existing pull-based model

`apps/cliproxy` and `apps/umami` already deploy upstream images and are the template:

- **No `upstream.json`.** The image is pinned directly in `docker-compose.yaml` as
  `name:tag@sha256:digest`.
- **No build job, no `*_IMAGE_DIGEST` env, no compose override for the image.** `deploy.ts`
  just runs `docker compose pull` + `up` against the committed compose file.
- **Renovate's implicit `docker-compose` manager** auto-bumps the digest (it already does this
  for `eceasy/cli-proxy-api` and even for the dashboard's current image line — PRs #560, #563).

The dashboard's extra machinery (`upstream.json`, `build-images` job, `DASHBOARD_IMAGE_DIGEST`,
the image override in `buildComposeOverride`) exists **only** because it built the image. With
upstream publishing a real image, the dashboard converges to the cliproxy/umami model — the
work is mostly **deletion**.

## The release to pin (first published release)

- Release: `2026.06.15` (authored by `fro-bot[bot]`)
- Image: `ghcr.io/fro-bot/dashboard:2026.06.15`
- Digest: `sha256:d3dd509856430b7bf90119ed2aaff5c579c89f53605596e250494702a8fe5f2e`
- Source: `fro-bot/dashboard@0a0ecf08b531512e890745447e6850999481f0ba`

The image is public on GHCR (anonymous manifest pull returns 200), so the workflow's
`GITHUB_TOKEN` can pull it.

## Scope

### R1 — Pin the upstream image by tag+digest in `docker-compose.yaml`

`apps/dashboard/docker-compose.yaml` `dashboard` service image becomes
`ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd509856430b7bf90119ed2aaff5c579c89f53605596e250494702a8fe5f2e`
— the tag+digest convention used by `apps/cliproxy` and `apps/umami`. The tag gives Renovate's
implicit docker-compose manager an anchor for digest bumps; the digest is the deploy contract.

### R2 — Remove the build job from `deploy-dashboard.yaml`

Delete the `build-images` job (checkout upstream + `docker build`/push) and its
`packages: write`. The `deploy-dashboard` job no longer `needs` it and no longer passes
`DASHBOARD_IMAGE_DIGEST`. In the router `.github/workflows/deploy.yaml`, drop `packages: write`
from the `deploy-dashboard` caller (down to `contents: read`) — nothing in the workflow pushes
to GHCR anymore. The droplet pull happens during the existing deploy (Docker pulls the pinned
digest from public GHCR with no auth needed; if auth is ever needed, it is a deploy-side `docker
login`, not a CI build job).

### R3 — Simplify `deploy.ts` to the cliproxy/umami pull model

Remove the image-build-era machinery from `apps/dashboard/src/deploy.ts`:

- the `DASHBOARD_IMAGE_NAME` constant,
- the `DASHBOARD_IMAGE_DIGEST` env requirement and its validation,
- the image injection in `buildComposeOverride` (the override no longer needs to set the image
  — the committed `docker-compose.yaml` carries the pinned digest, like umami),
- the `buildComposeOverride` image injection + its override-upload step (the override only set
  the image; the committed compose carries the pin).

The deploy keeps `docker compose pull` + `up -d --no-build --wait`, matching umami.

**Verification decision (resolved):** KEEP `assertRunningImageDigest` + the two-step RepoDigest
inspect, re-sourcing the expected digest from the compose pin (not the deleted
`DASHBOARD_IMAGE_DIGEST` env). Plan review (adversarial P1 + security-lens) showed `docker compose
pull` + `up` does not prove the running container is the pinned digest — a stale/cached/partial
pull passes silently. The verifier is the only repo-owned runtime proof and is a cheap existing
helper, so it is retained even though cliproxy/umami lack it.

### R4 — Delete `apps/dashboard/upstream.json`

No longer needed — the compose file is the pin, exactly like cliproxy/umami (neither has an
`upstream.json`). Remove the file and any reference to it (the workflow `jq -r .ref` read goes
away with the build job in R2).

### R5 — Renovate tracks the digest via the implicit docker-compose manager

No custom manager is needed. Renovate's built-in docker-compose manager already tracks
`image:` lines (it has been bumping the dashboard's current image digest — PRs #560/#563). The
tag+digest pin (R1) gives it the anchor. Add a `packageRules` entry for
`ghcr.io/fro-bot/dashboard` mirroring the existing `eceasy/cli-proxy-api` / `umamisoftware/umami`
entries (changelog/source URL for richer PR context, `automerge: false`,
`dependencyDashboardApproval: true` so a digest bump is operator-reviewed before the gated
deploy). The existing `apps/*/upstream.json` `ref` custom manager is left for the gateway and is
untouched.

### R6 — Docs reflect consume-by-digest (pull model)

Update `apps/dashboard/AGENTS.md`, `apps/dashboard/README.md`, and root `ARCHITECTURE.md` so
they describe consuming the upstream released image by digest (the cliproxy/umami pull model),
not an infra-owned build or `{ref}` tracking. Note that `ghcr.io/marcusrbrown/infra-dashboard`
is retired and can be deleted from GHCR packages manually once nothing references it.

### R7 — Tests updated

Update `apps/dashboard/docker-compose.test.ts` (the image-ref assertion → the new
`ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd5098...`) and `apps/dashboard/src/deploy.test.ts`
(remove tests for the deleted machinery; keep/adjust the `--no-build` and pull/up assertions to
match the umami-shaped deploy).

### R8 — Rollback documented in a runbook

Document the rollback path in `docs/runbooks/` (operator day-2 procedures — not `AGENTS.md`,
which is agent context): if a pinned digest is bad after deploy, recovery is to `git revert` the
`docker-compose.yaml` pin commit (restoring the prior digest from git history) and redeploy. No
separate last-known-good state is retained; git history is the source of prior good digests.
Cross-link the runbook from `apps/dashboard/README.md`. (This matches how a bad cliproxy/umami
image bump would be rolled back — revert the compose pin.)

## Non-goals

- **Deleting the old GHCR package in code/CI.** `ghcr.io/marcusrbrown/infra-dashboard` is
  retired and noted for manual deletion; no automated/destructive cleanup in this change.
- **Changing the deploy secret contract, SSH, or host-key handling.** Untouched.
- **A bespoke CI provenance/pull-validation job.** Not needed in the pull model — the image is
  pinned by immutable digest in compose, the same trust model cliproxy/umami use. Renovate
  proposes digest bumps; the operator reviews and approves the gated deploy.
- **Changing upstream's release/smoke-test pipeline.** Out of scope; that is `fro-bot/dashboard`.

## Success criteria

- `apps/dashboard/docker-compose.yaml` pins
  `ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd5098...`; `docker compose config` resolves to
  that digest.
- `deploy-dashboard.yaml` has no `build-images` job; the deploy job has no `DASHBOARD_IMAGE_DIGEST`.
- `apps/dashboard/upstream.json` no longer exists.
- `deploy.ts` matches the umami pull shape (no image const, no digest env, no override) and
  keeps `assertRunningImageDigest` sourced from the compose pin.
- `bun test apps/dashboard/...` passes; conventions/taxonomy gates pass.
- A real Deploy Dashboard run **pulls (not builds)** and `https://dashboard.fro.bot/api/healthz`
  returns 200.

## Open questions

None — resolved in brainstorm:
- Approach: full converge to the cliproxy/umami pull model (delete the build machinery), not a
  digest-pinned-`upstream.json` + provenance job. The simpler model is correct because two
  existing apps already deploy upstream images this way.
- Verification machinery: KEEP `assertRunningImageDigest` (R3), re-sourced from the compose pin.
  Plan review (adversarial P1) showed `docker compose pull` alone doesn't prove the running
  container matches the pinned digest; the verifier is a cheap existing helper worth retaining.
- Renovate: implicit docker-compose manager + a changelog `packageRules` entry (R5); no custom
  manager.
- Old GHCR package: noted for manual deletion, not automated (Non-goals).
- Rollback: `git revert` the compose pin commit + redeploy, documented in a `docs/runbooks/`
  runbook (R8).

## Future bumps

Updating the dashboard later = Renovate proposes a digest bump on the `docker-compose.yaml`
image line (operator-reviewed, gated deploy), or hand-edit the tag+digest to a new release. No
infra build step, no `upstream.json`, no separate digest env.
