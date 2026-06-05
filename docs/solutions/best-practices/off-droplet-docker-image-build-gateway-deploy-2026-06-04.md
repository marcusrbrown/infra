---
title: Off-droplet Docker image build for a single-droplet deploy (CI build → GHCR push → droplet pull)
date: 2026-06-04
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
available RAM and thrashes swap — a `fro-bot/agent` v0.54.1 cutover did exactly this and took
the gateway down for ~50 minutes (see `docs/solutions/workflow-issues/gateway-deploy-resourcing-thrash-2026-06-04.md`).

The durable fix is to move the build off the droplet entirely:

```text
CI runner (16 GB):  checkout pinned ref → build → push to GHCR → capture digest
Droplet (2 GB):     pull digest-pinned image → up -d --no-build → verify running digest
```

This playbook captures the reusable mechanics so other single-droplet deploys
(`apps/cliproxy`, `apps/umami`) can adopt the same model.

## Guidance

### 1. Build off-droplet; the droplet only pulls

The CI runner builds and pushes; the droplet pulls and recreates without building.

```bash
docker compose --project-directory "$DEPLOY_DIR" pull
docker compose --project-directory "$DEPLOY_DIR" up -d --no-build --wait --wait-timeout 120 --remove-orphans
```

`--no-build` is belt-and-suspenders: even an accidental future code path cannot trigger a
host build.

### 2. Materialize the image pins unconditionally

Write the `image:` digest pins on **every** deploy. Do not gate them behind an optional
feature flag (the gateway's announce/Caddy override is a conditional *layer* merged into the
same file — the image pins are not). If the default path can omit the override, Compose can
drift back toward `build:` semantics and the host builds again.

```ts
// buildComposeOverride(): image pins always present; announce/Caddy is a conditional layer
return `services:
  gateway:
    image: ${GATEWAY_IMAGE_NAME}@${gatewayDigest}${announceGatewaySection}
  workspace:
    image: ${WORKSPACE_IMAGE_NAME}@${workspaceDigest}
${caddySection}${volumesSection}`
```

### 3. Pin by digest, not tag — and validate the shape

GHCR tags are mutable; digests are identity. Capture the pushed digest from
`docker/build-push-action` (`outputs.digest`), pin `image: ...@sha256:<digest>`, and validate
the shape before it reaches a compose file or a remote command:

```ts
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
if (!DIGEST_RE.test(gatewayDigest)) {
  throw new Error('GATEWAY_IMAGE_DIGEST is not a valid sha256 digest')
}
```

Validating up front (before any SSH) keeps a malformed digest from materializing a bad image
reference or reaching an interpolated remote command.

### 4. Compose `build:` + `image:` coexistence — PROVEN, not assumed

The load-bearing assumption is that a service with BOTH an upstream `build:` and an override
`image:` pin, run with `pull` + `up --no-build`, uses the pulled image and never host-builds.
Prove it on the target's actual Compose version before relying on it. Disjoint-project proof
(verified on Docker Compose v5.1.3):

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

The deploy job depends on the build job, so a failed build/push never touches the live stack:

```yaml
deploy-gateway:
  needs: build-images
```

On the droplet, the `pull` runs before `up`, so an unavailable image errors before any
recreate — the old stack stays live. Break-glass when CI/GHCR is unavailable: build + push the
pinned ref from a workstation (ample RAM — the off-droplet build done by hand), then deploy
locally with the digests supplied manually:

```bash
GATEWAY_IMAGE_DIGEST="sha256:..." \
WORKSPACE_IMAGE_DIGEST="sha256:..." \
bunx @marcusrbrown/infra gateway deploy --local
```

Never run `docker compose up --build` on the droplet — that reintroduces the swap-thrash.

## Why This Matters

- Eliminates swap-thrash outages on small droplets — the build moves to a 16 GB runner.
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
`.github/workflows/deploy-gateway.yaml` (the `build-images` job + digest outputs), and
`.github/workflows/deploy.yaml` (the `deploy-gateway` caller permission grant). `apps/gateway/AGENTS.md`
documents the operator flow + the break-glass runbook.

## Related

- `docs/solutions/workflow-issues/gateway-deploy-resourcing-thrash-2026-06-04.md` — the outage that motivated this. Its "build off-droplet (GHCR) and pull" prevention option is what this playbook operationalizes; that option is now the implemented path.
- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — added `--build` to defeat stale-image reuse for an **on-host** build. That guidance applies to host-built `build:` services; under this off-droplet model the droplet pulls a digest-pinned image and must not use `--build`.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — complementary image-swap discipline: probe the pinned image, verify the real contract, keep cutover rollback-safe.
