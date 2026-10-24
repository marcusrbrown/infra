---
title: Off-droplet Docker image build for a single-droplet deploy (CI build → GHCR push → droplet pull)
date: 2026-06-04
last_updated: 2026-10-24
category: docs/solutions/best-practices
module: apps/gateway
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - A single-droplet deploy currently runs `docker compose up --build` on the target host
  - The host is too small (e.g. 1vCPU/2GB) to build a memory-heavy image while the old stack is still running
  - You want reproducible, digest-pinned deploy artifacts built from a pinned source ref
  - You need the running host to only pull prebuilt images, never build
  - You need to verify the running image's identity (not just its tag) after a registry pull
related_components:
  - cliproxy
  - umami
tags:
  - gateway
  - ghcr
  - docker
  - off-droplet-build
  - digest-pinning
  - deploy
  - reusable-workflow
  - pull-not-build
---

# Off-droplet Docker image build for a single-droplet deploy (CI build → GHCR push → droplet pull)

## Context

A single-droplet deploy that builds its image on the target host has a latent resourcing
bomb: `docker compose up --build` builds the new image *while the old stack is still running*,
so peak memory is roughly old-stack + build. On a small droplet (the gateway runs on
`s-1vcpu-2gb`) building a memory-heavy image (a Node/OpenCode workspace image) blows past
available RAM and thrashes swap. A daemon-bump cutover did exactly this and took the gateway
down for ~50 minutes. A cold build cache (fresh upstream ref) makes it worse than a patch bump.

The durable fix is to move the build off the droplet entirely:

```text
CI runner:  checkout pinned ref → build → push to GHCR → capture digest
Droplet:    pull digest-pinned image → up -d --no-build → verify running digest
```

This playbook captures the reusable mechanics so other single-droplet deploys
(`apps/cliproxy`, `apps/umami`) can adopt the same model.

## Guidance

### 1. Build off-droplet; the droplet only pulls

The CI runner builds and pushes; the droplet pulls and recreates without building.

```bash
docker compose --project-directory "$DEPLOY_DIR" pull
docker compose --project-directory "$DEPLOY_DIR" up -d --no-build --wait --wait-timeout <seconds> --remove-orphans
```

`--no-build` is belt-and-suspenders: even an accidental future code path cannot trigger a
host build. The wait timeout is a single named constant in `deploy.ts`; size it to outlast the
slowest service healthcheck start period.

### 2. Materialize the image pins unconditionally

Write the `image:` digest pins on **every** deploy. Do not gate them behind an optional
feature flag (the gateway's Caddy/announce/operator sections are conditional _layers_ merged
into the same file — the image pins are not). If the default path can omit the override,
Compose can drift back toward `build:` semantics and the host builds again.

```ts
// buildComposeOverride(): image pins always present; Caddy/announce/operator are conditional layers
gateway:
  image: ${GATEWAY_IMAGE_NAME}@${gatewayDigest}
workspace:
  image: ${WORKSPACE_IMAGE_NAME}@${workspaceDigest}
```

### 3. Pin by digest, not tag — and validate the shape

GHCR tags are mutable; digests are identity. Capture the pushed digest from
`docker/build-push-action` (`outputs.digest`), pin `image: ...@sha256:<digest>`, and validate
both digests (required, and matching `^sha256:[0-9a-f]{64}$`) before any SSH:

```ts
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
if (!gatewayDigest) throw new Error("GATEWAY_IMAGE_DIGEST is required but not set. ...")
if (!DIGEST_RE.test(gatewayDigest)) throw new Error("GATEWAY_IMAGE_DIGEST has an invalid format ...")
// same two checks for WORKSPACE_IMAGE_DIGEST
```

Failing up front keeps a missing or malformed digest from silently falling through to a host
build, materializing a bad image reference, or reaching an interpolated remote command.

### 4. Compose `build:` + `image:` coexistence — PROVEN, not assumed

The load-bearing assumption is that a service with BOTH an upstream `build:` and an override
`image:` pin, run with `pull` + `up --no-build`, uses the pulled image and never host-builds.
Prove it on the target's actual Compose version before relying on it, and re-check after a
Compose upgrade. Disjoint-project proof:

```bash
# A Dockerfile that, IF built, writes an obvious marker the pulled image lacks:
cat > Dockerfile <<'DF'
FROM alpine:3.20
RUN echo "BUILT-ON-HOST" > /marker
CMD ["cat","/marker"]
DF
# Service has BOTH build: and image: (image is a plain alpine, NOT the built one):
cat > compose.yaml <<'CY'
services:
  probe:
    build: .
    image: alpine:3.20
    command: ["sh","-c","test -f /marker && echo USED-BUILD || echo USED-IMAGE"]
CY
docker compose -p semtest pull
docker compose -p semtest up --no-build   # → "USED-IMAGE" (never built)
```

Results that must hold:
- `pull` + `up --no-build` → **USED-IMAGE** (the pulled image runs; no build).
- A missing/unpullable `image:` → the pull/up **errors** (it does NOT fall back to a host build).
- Even a plain `up` (no `--build`) on a `build:`+`image:` service uses the image.

If any of these don't hold on your Compose version, add an explicit guard before adopting.

### 5. Verify the running image by digest — in two steps

The deploy's post-`up` digest readback (Phase 9c in `deploy.ts`, asserted by
`assertRunningImageDigest`) runs for both `gateway` and `workspace`. A mismatch throws, the
deploy fails loudly, and the secrets checksum is not persisted, so the next deploy recreates
the containers.

A **container** has no `.RepoDigests` field; the **image** does. Inspecting the container
directly returns a template error and empty output, which silently fails verification.

**Correct (two-step):**

```bash
IMAGE_SHA=$(docker inspect --format '{{.Image}}' "$(docker compose --project-directory "$DEPLOY_DIR" ps -q gateway)")
docker inspect --format '{{json .RepoDigests}}' "$IMAGE_SHA"
# → ["ghcr.io/marcusrbrown/infra-gateway@sha256:<digest>"]  — compare to the CI-pushed digest
```

**Anti-pattern (always fails):**

```bash
docker inspect --format '{{json .RepoDigests}}' "$(docker compose ps -q gateway)"
# container has no .RepoDigests → template error → empty → verification always throws
```

Narrow the parsed JSON to `string[]` (reject `null`/object/non-string array) so a malformed
inspect result surfaces an actionable mismatch error rather than a `TypeError`.

### 6. Reusable-workflow permissions are capped by the caller

A called reusable workflow's `GITHUB_TOKEN` permissions cannot exceed what the caller grants.
Declaring `packages: write` on the build job inside the reusable workflow is necessary but
**insufficient** — the caller job in the parent workflow must grant it too. Scope it to the
single job, not workflow-wide and not on sibling deploy jobs.

```yaml
# Parent (.github/workflows/deploy.yaml) — caller job:
deploy-gateway:
  permissions:
    contents: read
    packages: write
  uses: ./.github/workflows/deploy-gateway.yaml

# Reusable (.github/workflows/deploy-gateway.yaml) — build job:
build-images:
  permissions:
    contents: read
    packages: write
```

Symptom when the caller grant is missing: the GHCR push 403s even though the build job's own
`permissions:` block looks correct.

### 7. Public GHCR packages — verify pullability anonymously

Packages with no baked secrets can be public (the droplet then pulls with no auth). On first
push the package may already be public (org/repo default) — verify rather than assume, via the
anonymous registry token + manifest endpoint:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:marcusrbrown/infra-gateway:pull" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  "https://ghcr.io/v2/marcusrbrown/infra-gateway/manifests/<tag>"
# 200 → public and pullable; 401/403 → private (flip to public or add a read-only pull token)
```

Before going public, audit the Dockerfiles/build context: no secret `ARG`/`ENV`, no `COPY` of
a secrets directory. All runtime secrets should be bind-mounts into `/run/secrets/...`, never
baked into a layer.

### 8. Safe failure is deliberate

The deploy job depends on the build job (and the non-blocking `scan-images` job and the
`notify` job), so a failed build/push never touches the live stack:

```yaml
deploy-gateway:
  needs: [build-images, scan-images, notify]
  if: ${{ !cancelled() && needs.build-images.result == 'success' && needs.scan-images.result == 'success' }}
```

`scan-images` is `continue-on-error` and exits 0 on findings, so it informs the approval gate
rather than blocking the deploy. On the droplet, the `pull` runs before `up`, so an
unavailable image errors before any recreate — the old stack stays live. Break-glass when
CI/GHCR is unavailable: build + push the pinned ref from a workstation (ample RAM — the
off-droplet build done by hand), then deploy locally with the digests supplied manually:

```bash
GATEWAY_IMAGE_DIGEST="sha256:..." \
WORKSPACE_IMAGE_DIGEST="sha256:..." \
bunx @marcusrbrown/infra gateway deploy --local
```

## Recognizing a host build or swap thrash

If someone reintroduces a host build (or an image pin silently drops), the failure has a
distinctive signature. **Do not** "fix" it with `--build` on the droplet; fix the pin path.

- A deploy step runs far past the normal few minutes and stays `in_progress`.
- Load average is tens on a 1-vCPU box (e.g. ~31 and still climbing across 1/5/15-min), with
  almost no free RAM and deep swap.
- `docker ps` itself times out on the droplet; SSH probes hang from CPU starvation.
- The public endpoint returns `000` (down) while the old stack is starved.

Responding:

- **Use external probes only** — the public endpoint, the GitHub run API, `doctl`. They add
  zero droplet load. Never SSH-hammer a thrashing droplet: it can't run `docker ps`, and UFW
  rate-limits new connections (6 per 30s), so piling on SSH risks a lockout and worsens the
  thrash.
- **Restore** with a DigitalOcean power-cycle (`doctl compute droplet-action power-cycle`) and
  cancel the stuck run (`gh run cancel`; SSH is severed anyway). In the original incident the
  stack was back in ~90 s.
- **Recover through the pipeline**, not by hand on the droplet: redeploy with CI-built digests
  (or the break-glass workstation build above). What not to do: `docker compose build` or
  `up --build` on the droplet, with or without stopping the old stack first.

The workspace container also carries a fixed memory limit with swap capped equal to it
(`mem_limit`/`memswap_limit` in the override), and the deploy reads both back from the running
container (Phase 9d) — so a runaway workspace is OOM-killed instead of dragging the whole host
into swap. See `apps/gateway/AGENTS.md` for sizing and the memory-limit anti-patterns.

## A green deploy is not a fresh deploy

`docker compose up --wait` asserts container _health_, and slash-command registration asserts
the daemon registered _something_; neither proves the running image is the one just built. A
historical failure let a moved upstream pin update source on disk for weeks while the running
container kept executing an old image — health and registration both passed. The digest
readback in section 5 is what closes this gap now: it compares the running image's identity to
the pushed digest, so a stale or locally built image fails the deploy.

Detection signals when digest verification is unavailable or you're triaging by hand:

- The running image's `Created` timestamp is far older than the container's `Created`.
- `RepoDigests` on the running image doesn't contain the pin from `compose.override.yaml`.
- The new behavior the bump should add is absent. Grep for a behavior string inside the
  running container's bundle, e.g.
  `docker exec "$CID" grep -rl "<new-behavior-string>" /app/packages/gateway/dist/main.mjs`,
  or query the live Discord guild-commands API for a new command.

Related gotchas:

- **Source ref ≠ running image.** The deploy still `git reset --hard`s the droplet's source
  directory early, so it shows the new ref immediately, but the running image only changes
  after `up` recreates containers. A failure (or power-cycle) mid-deploy leaves the **old
  image** with a **new source dir**. Verify the image digest, never the git checkout.
- **Two independent `fro-bot/agent` version surfaces.** The CI PR-reviewer Action is pinned in
  `.github/workflows/fro-bot.yaml`; the deployed Discord daemon is pinned in
  `apps/gateway/upstream.json`, which `build-images` reads to pick the ref it checks out and
  builds. A daemon behavior fix ships only via an `upstream.json` bump plus a gated redeploy;
  bumping the Action SHA changes how PRs are reviewed, not the live daemon.
- **Never `git clean -xfd` the droplet deploy directory during manual recovery.** It deletes
  the untracked `secrets/` files, and some secret values exist only in the GitHub Environment,
  not in a local `.env`. Restore by running the real deploy pipeline (or `--local` with the
  materializer), not by hand-editing. On macOS, a local deploy needs a short `TMPDIR` (the
  deploy roots its SSH `ControlPath` under `/tmp` to stay under the socket path-length limit).
- **A pinned upstream ref doesn't guarantee a runnable image.** Probe a freshly built image's
  boot before trusting a cutover; see the upgrade playbook below.

## Why This Matters

- Eliminates swap-thrash outages on small droplets — the build moves to a CI runner with ample RAM.
- Deploys become reproducible and immutable: the droplet runs exactly the digest CI pushed.
- Verification answers "are we really running the pushed image?" as a hard digest check, not a tag.
- Safety is preserved: a failed build or unavailable image leaves the old stack running.
- The build → push → deploy trust chain stays explicit, including across reusable workflows.

## When to Apply

Any single-droplet deploy where the host is too small to build safely, the image is built in
CI, the runtime host should only pull, and you want rollback-safe, digest-verified deploys.
Directly reusable for `apps/cliproxy` and `apps/umami`, which currently pull upstream registry
images but build no custom image — if either grows a custom build, adopt this model rather than
building on its droplet.

## Examples

The shipped implementation lives in `apps/gateway/src/deploy.ts`,
`.github/workflows/deploy-gateway.yaml` (the `build-images` and `scan-images` jobs + digest
outputs), and `.github/workflows/deploy.yaml` (the `deploy-gateway` caller permission grant).
`apps/gateway/AGENTS.md` documents the operator flow + the break-glass runbook.

## Related

- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — complementary image-swap discipline: probe the pinned image, verify the real contract, keep cutover rollback-safe.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — earlier gateway deploy-pipeline cascade (different failure class).
- `../integration-issues/docker-network-stale-subnet-cleanup-2026-06-18.md` — deploy-sequencing companion: pull images before any disruptive cleanup; stale Docker network IPAM state requires a live-state migration step between pull and compose up.
