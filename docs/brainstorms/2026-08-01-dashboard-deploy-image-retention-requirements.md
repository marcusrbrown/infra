---
date: 2026-08-01
topic: dashboard-deploy-image-retention
---

# Dashboard Deploy Image Retention

## Summary

The dashboard deploy owns the production host's Docker image lifecycle. Every remote
deploy, whether started by GitHub Actions or a local entry point, must serialize on the
production host with a process-bound, crash-safe remote lock at a fixed,
host-controlled, root-owned path that is not derived from deploy inputs. Lock
acquisition is bounded, the lock releases on process death or SSH loss, and no manual
stale-lock deletion is required. While locked, the deploy must inspect the current
state, inventory all containers and image references including stopped containers,
identify and canonicalize the Docker/containerd backing filesystem, parse integer free
bytes deterministically, reclaim only safe unused images, re-report the evidence, and
prove sufficient real filesystem headroom. It must then acquire the exact immutable
target image and verify its expected digest before the remote Compose desired state is
written. A failed preflight or target-image acquisition/verification must leave the
current Compose file and runtime untouched. Only after that verification may the
deploy write Compose, run `up`, verify the running digest and public health, and use
the existing audit PR path.

After desired-state mutation, `up`, digest verification, and health failures must be
reported honestly; the old runtime is not guaranteed to survive every post-`up`
failure, and automated rollback remains out of scope. Because there is no post-success
prune, the immediately replaced image remains locally until the next deploy; older
unused eligible images are removed at the next pre-pull prune, while images still
referenced by containers may also remain. Registry-backed immutable digest rollback
remains authoritative.

---

## Problem Frame

On July 31, 2026, release `2026.07.43` failed in remote deploy run `30651636863`
while running `docker compose pull`. The host reported `/var/lib/containerd ... no
space left on device`. The 25 GB root filesystem was 100% full, with containerd using
approximately 19 GB and 60 local images for only 2 active images.

The deploy had already rewritten the remote Compose desired state to `2026.07.43`,
while the runtime remained on `2026.07.42` and became unhealthy. This created an
untracked desired/runtime mismatch precisely when the host could not complete the
image pull.

An approved `docker image prune -a --force` preserved active containers and volumes,
restored 19 GB of free space, and allowed the rerun to deploy `2026.07.43`
successfully. The incident shows that cleanup must be an explicit deploy-owned gate,
not an afterthought triggered by a failed pull.

---

## Actors

- A1. **Release/operator.** Reviews the release digest, starts or approves a deploy,
  observes the result, and uses the existing audit PR and digest rollback path.
- A2. **Deploy process.** The shared behavior used by GitHub Actions and local entry
  points. It owns serialization, baseline evidence, safe image cleanup, headroom
  gating, desired-state mutation, runtime verification, and reporting.
- A3. **Production host.** The dashboard droplet running Docker Compose, containerd,
  the `dashboard` and `caddy` services, and persistent dashboard data volumes.

---

## Key Flows

- F1. **Normal deploy.**
  - **Trigger:** A GitHub Actions or local deploy is started for the dashboard, using
    either a version/digest input or the committed Compose pin.
  - **Actors:** A1, A2, A3.
  - **Steps:** Acquire the process-bound, crash-safe remote lock at the fixed,
    host-controlled, root-owned path that is not derived from deploy inputs, with
    bounded acquisition; it releases on process death or SSH loss and never requires
    manual stale-lock deletion. While holding it, record the current Compose desired
    image, running image and digest, service health, all container/image references
    including stopped-container pins, the canonical filesystem backing Docker and
    containerd storage, real filesystem capacity with deterministically parsed integer
    free bytes, and Docker image-state advisory data; perform the unconditional
    unused-image prune; re-report all container/image inventory and canonical
    filesystem free bytes; prove the documented filesystem floor; acquire the exact
    immutable target image and verify its expected digest; only then write the new
    digest-pinned Compose state, run the existing `up`, verify the running digest and
    public health, and, in the versioned GitHub Actions path, complete the existing
    audit PR sequence.
  - **Outcome:** The deploy completes with auditable desired/runtime state. If target
    acquisition or digest verification fails, the old Compose state and runtime stay
    in place. If `up`, running-digest verification, or health verification fails after
    Compose mutation, the actual degraded state and any desired/runtime mismatch are
    reported without claiming success. There is no post-success prune: the immediately
    replaced image remains locally until the next deploy, older unused eligible images
    are removed at the next pre-pull prune, and images still referenced by containers
    may also remain.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14.

- F2. **Insufficient-headroom abort.**
  - **Trigger:** A preflight gate is unavailable, partial prune fails, measured
    post-prune free bytes are below the documented floor, or exact target-image
    acquisition/digest verification fails.
  - **Actors:** A2, A3.
  - **Steps:** Attempt bounded acquisition of the same process-bound, crash-safe remote
    lock at the fixed, host-controlled, root-owned path that is not derived from deploy
    inputs; it releases on process death or SSH loss and never requires manual
    stale-lock deletion. Once held, record the baseline, perform the unconditional
    safe pre-pull prune, re-report all container/image inventory and canonical
    filesystem free-byte evidence, and stop before target-image acquisition when
    cleanup, evidence, filesystem, or headroom gates fail. If those gates pass,
    acquire and verify the exact immutable target image, then stop before Compose
    desired-state mutation when acquisition or verification fails.
  - **Outcome:** The failed gate and measured evidence are reported; the current
    Compose desired state and runtime remain in place. A partial prune hard-stops before
    image acquisition and Compose mutation. Safe cleanup already completed is not
    rolled back, and no manual stale-lock or cleanup step is required.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R7, R10, R11, R13, R14.

- F3. **Rerun recovery.**
  - **Trigger:** A prior deploy stopped before mutation, after successful target-image
    acquisition/verification, or during `up`, running-digest verification, or health
    verification.
  - **Actors:** A1, A2, A3.
  - **Steps:** Reacquire the same process-bound, crash-safe remote lock at the fixed,
    host-controlled, root-owned path that is not derived from deploy inputs, using
    bounded acquisition; it releases on process death or SSH loss and never requires
    manual stale-lock deletion. Re-audit all required state, including stopped
    containers and every image reference, re-prune, re-report the canonical storage
    filesystem and deterministic integer free bytes, re-prove headroom, and acquire or
    re-verify the same exact target digest using an already-present matching image or a
    new acquisition. Only after that verification may the rerun write Compose desired
    state and run `up`; it then verifies the running digest and health.
  - **Outcome:** The rerun is safe and idempotent without contradictory Compose state,
    manual cleanup, or a post-success prune. A pre-mutation failure leaves the old
    Compose state and runtime unchanged; a prior post-`up` failure is reported and is
    not treated as proof that the old runtime survived.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R7, R8, R10, R11, R12, R13, R14.

---

## Requirements

### Serialization and order

- R1. **One remote critical section.** Every remote dashboard deploy and cleanup must
  acquire the same production-host exclusive lock, regardless of whether it entered
  through GitHub Actions or a local deploy entry point. The lock must be process-bound
  and crash-safe, use a fixed host-controlled root-owned path that is not derived from
  deploy inputs, release on process death or SSH loss, and have bounded acquisition
  with deterministic failure. It must never require manual stale-lock deletion. No
  remote inspection, prune, image acquisition, Compose write, or runtime change may
  occur outside the lock. The exact lock path and acquisition timeout are Deferred to
  Planning.

- R2. **Baseline state before cleanup.** After acquiring the lock and before cleanup
  or desired-state mutation, record the current remote Compose image reference and
  digest, running image and digest, service health, real filesystem total/free
  bytes, all containers including stopped containers, every container image reference
  that can pin an image, and Docker image-state data. Identify and canonicalize the
  filesystem backing Docker/containerd storage and parse its free bytes as a
  deterministic integer. Missing, malformed, or wrong-mount evidence fails the audit.
  The baseline must identify the current runtime independently of the requested
  release and must not trust requested image inputs as evidence.

- R3. **Safe unconditional pre-pull prune.** Every deploy must perform an unused
  image prune after the baseline audit and before changing the Compose desired state
  or acquiring the target image. The cleanup must preserve every image referenced by
  any running or stopped container and every volume. It must not delete stopped
  containers automatically. It must never delete containerd content directly, remove
  volumes, run `docker compose down -v`, or run `docker system prune --volumes`.

- R4. **Filesystem bytes are authoritative.** The headroom gate must use actual free
  bytes on the canonical filesystem containing Docker/containerd storage. The audit
  and post-prune report must inventory all containers, including stopped containers,
  and every container image reference that can pin an image; identify and canonicalize
  that backing filesystem; and parse free bytes as an integer deterministically.
  Missing, malformed, or wrong-mount evidence is a failure. Docker disk-usage output
  is advisory evidence and must not substitute for the filesystem measurement.

- R5. **Documented post-cleanup floor.** After cleanup and before Compose desired-state
  mutation or target-image acquisition, the deploy must re-report all containers,
  including stopped containers, every container image reference that can pin an image,
  the canonical storage filesystem, and its deterministically parsed integer free
  bytes, then prove that the bytes meet a documented minimum floor. The exact
  threshold must be validated during planning against the current 25 GB host and the
  extraction overhead of the dashboard image. Missing, stale, malformed, or
  wrong-mount evidence is a failed gate.

- R6. **Fail closed before desired-state mutation.** A lock, audit, prune, filesystem
  measurement, deterministic evidence parse, post-prune re-report, headroom-floor,
  target acquisition, or target-digest verification failure must stop the deploy
  before the remote Compose desired state is changed and before a runtime transition
  begins. Required evidence includes all containers and image references, including
  stopped-container pins, and the identified/canonicalized Docker/containerd backing
  filesystem with integer free bytes. Missing, malformed, or wrong-mount evidence is
  a failure. A partial prune failure must hard-stop before target-image acquisition
  and Compose mutation. The current Compose file and runtime remain untouched for
  these pre-mutation failures; safe cleanup of unused images already completed is not
  rolled back.

- R7. **Preserve the existing post-gate deploy contract.** Once all preflight gates
  pass, including the complete post-prune inventory and canonical integer free-byte
  report, the deploy acquires the exact immutable target image and verifies its
  expected digest. Only after that verification may it write the remote Compose
  desired state, run the existing `up` flow, verify the running image digest and
  public health, and, when a version input is supplied through GitHub Actions, use the
  existing dashboard pin audit PR path. Acquisition or verification failure remains a
  pre-mutation failure and must not change Compose or the runtime. The retention work
  must not weaken immutable digest verification or public health checks.

### Retention and rollback

- R8. **No post-success image prune.** A successful deploy must not immediately prune
  images. Because there is no post-success prune, the immediately replaced image
  remains locally until the next deploy. Older unused eligible images are removed at
  the next pre-pull prune, while images still referenced by containers may also remain.

- R9. **Registry digest rollback is authoritative.** Rollback authority remains the
  immutable digest retained in GHCR and the existing Compose-pin/audit history, not
  an unbounded set of local images. Older unused eligible local images are removed at
  the next pre-pull prune, while images still referenced by containers may remain.

### Evidence and failure behavior

- R10. **Record deploy evidence.** Logs must show the before-and-after disk and image
  state, all container and image-reference inventory including stopped-container
  pins, the canonical Docker/containerd backing filesystem, deterministically parsed
  integer free bytes, reclaimed space, target expected/actual digest, desired and
  running digests, the current failure stage, and any desired/runtime mismatch. The
  complete inventory and canonical filesystem/free-byte evidence must be re-reported
  after prune. Missing, malformed, or wrong-mount evidence must be recorded as a
  failure, and a partial prune failure must be recorded before target-image
  acquisition. Logs must keep evidence redacted, must not expose secrets or untrusted
  input, and must not imply success when a gate or verification failed.

- R11. **Report runtime failures honestly.** A target-image acquisition or digest
  verification failure before Compose mutation must preserve the old Compose desired
  state and running runtime; no audit PR path is used. Only after exact-image
  acquisition and expected-digest verification may Compose be written and `up` run.
  If `up`, a health check, or running-digest verification fails after desired-state
  mutation, the deploy must report the actual runtime/degraded state and any
  desired/runtime mismatch without claiming success. Automated rollback is out of
  scope, so the deploy must not guarantee that the old runtime survives every
  post-`up` failure.

- R12. **Make reruns idempotent.** Repeating a deploy after a preflight failure,
  partial prune, partial target-image acquisition, target-digest verification failure,
  or successful deployment must safely reacquire the same process-bound, crash-safe
  lock, re-audit all containers and image references including stopped containers,
  re-prune, re-report the canonical storage filesystem and deterministic integer free
  bytes, re-prove headroom, and acquire/verify the same exact desired digest before
  writing Compose. It must then reconcile that digest without accumulating
  contradictory Compose state or requiring manual stale-lock or cleanup intervention;
  it must report rather than conceal any degraded state left by an earlier post-`up`
  failure and must not claim that the old runtime survived it.

- R13. **Apply identical safety to local deploys.** The local dashboard deploy path
  must use the same remote lock, baseline audit, safe prune, filesystem headroom
  gate, exact target-image acquisition and verification before Compose mutation,
  fail-closed ordering, retention policy, digest verification, health checks, and
  evidence reporting as the GitHub Actions path. Local execution must not bypass the
  safety contract.

### Trust boundary

- R14. **Preserve validated immutable inputs and trusted remote commands.** The deploy
  must preserve the existing validation of immutable image inputs and trusted SSH and
  remote-command construction. Lock, prune, filesystem-probe, and health-probe
  commands must be fixed host-controlled commands and must never interpolate deploy
  inputs. Malformed, mutable, or otherwise untrusted image references must be
  rejected before remote cleanup or mutation. Evidence and failure reporting must
  remain redacted.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3, R4, R5, R7, R8, R10, R13, R14.** Given a versioned
  GitHub Actions deploy holding the process-bound, crash-safe lock at the fixed,
  host-controlled, root-owned path not derived from deploy inputs, when it records
  all containers and image references including stopped-container pins, identifies
  the canonical storage filesystem, prunes unused images, re-reports deterministic
  integer free bytes, proves the floor, acquires and verifies the exact target digest,
  writes the new digest-pinned Compose state, starts the release, verifies its digest
  and public health, and completes the audit PR path only afterward, then it leaves
  the immediately replaced image locally until the next deploy.

- AE2. **Covers R1, R6, R10, R13, R14.** Given a local deploy starts while a GitHub
  Actions deploy owns the process-bound, crash-safe lock at the fixed,
  host-controlled, root-owned path that is not derived from deploy inputs, when
  bounded acquisition expires, then it fails cleanly and performs no remote cleanup
  or mutation. If the lock owner dies or loses SSH, the lock is released without
  manual stale-lock deletion.

- AE3. **Covers R2, R3, R4, R8, R9, R10.** Given active and stopped containers,
  every container image reference, older unused images, persistent volumes, and a
  canonical Docker/containerd backing filesystem, when pre-pull cleanup runs, then it
  inventories all references, identifies the correct mount, parses integer free bytes
  deterministically, re-reports that evidence after prune, removes only eligible
  unused images, preserves container-referenced images and volumes, does not delete
  stopped containers, and does not run a post-success prune.

- AE4. **Covers R2, R4, R5, R6, R10, R11.** Given post-prune inventory, canonical
  filesystem, or deterministic integer free-byte evidence is missing, malformed,
  stale, below the documented floor, or for the wrong filesystem, when the deploy
  evaluates the headroom gate, then it reports the failure and re-reported evidence,
  does not acquire the target image or write the new Compose state, and leaves the old
  runtime running.

- AE5. **Covers R6, R7, R10, R11.** Given the old runtime is healthy and the exact
  target image cannot be acquired or its expected digest cannot be verified, when the
  failure occurs before Compose mutation, then the old Compose desired state and
  runtime remain in place, no audit PR path is used, and the deploy reports the
  expected and actual evidence rather than claiming the release deployed.

- AE6. **Covers R2, R3, R5, R7, R8, R12.** Given the July 31 failure was followed by
  approved safe image pruning, when the deploy is rerun for `2026.07.43`, then it
  re-audits all containers and image references including stopped-container pins,
  re-prunes, re-reports the canonical storage filesystem and deterministic integer
  free bytes, re-proves headroom, acquires/verifies the desired digest before Compose
  mutation, reconciles the desired digest, and performs no post-success prune.

- AE7. **Covers R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14.** Given
  a local deploy targets the production host, when it completes or fails, then it
  uses the same process-bound, crash-safe lock at the fixed host-controlled,
  root-owned path not derived from deploy inputs and produces equivalent complete
  inventory, canonical-storage, deterministic free-byte, cleanup, headroom,
  target-acquisition, digest, health, retention, and failure-stage evidence without
  claiming the workflow-only versioned audit PR path. A post-`up` failure reports the
  actual degraded state and does not promise that the old runtime survived.

- AE8. **Covers R6, R7, R10, R14.** Given a malformed, mutable, or otherwise untrusted
  image reference, when the existing validation checks its inputs, then it rejects the
  request before opening remote cleanup or mutation, preserves trusted SSH and
  remote-command construction, uses no deploy input in fixed host-controlled
  lock/prune/probe commands, and emits only redacted evidence.

---

## Success Criteria

- The incident sequence from July 31, 2026 would stop before Compose desired-state
  mutation and target-image acquisition when the host lacks the required headroom.
- GitHub Actions and local deploys cannot perform remote cleanup or deployment at the
  same time.
- The remote lock is process-bound and crash-safe at a fixed host-controlled root-owned
  path not derived from deploy inputs, releases on process death or SSH loss, has
  bounded acquisition, and never requires manual stale-lock deletion.
- Every deploy leaves an auditable before/after record of all container/image
  references including stopped-container pins, the identified and canonical storage
  filesystem, deterministically parsed integer filesystem bytes, image reclamation,
  target expected/actual digest, desired digest, running digest, health, and failure
  stage. Missing, malformed, or wrong-mount evidence fails, and the complete state is
  re-reported after prune.
- Safe cleanup removes eligible unused images while preserving container-referenced
  images and every volume, without automatically deleting stopped containers. A
  partial prune hard-stops before target-image acquisition and Compose mutation, while
  safe deletions already completed are not rolled back.
- A successful deploy has no post-success prune, so the immediately replaced image
  remains locally until the next deploy; older unused eligible images are removed at
  the next pre-pull prune, while images still referenced by containers may also remain.
  Rollback remains possible through the immutable GHCR digest path.
- Target-image acquisition or verification failures leave the old Compose desired state
  and runtime unchanged; post-`up` failures report actual degraded state and do not
  falsely report the desired release as running. Compose mutation, `up`, running
  digest/health verification, and the versioned audit PR path occur only after exact
  target acquisition and expected-digest verification.
- The existing validated immutable image inputs, trusted remote-command construction,
  digest verification, public health checks, and audit PR behavior remain intact after
  the retention gate is added.

---

## Scope Boundaries

- No scheduled cleanup or timer.
- No new alerting system.
- No droplet resize.
- No generalized all-application deployment framework.
- No automated rollback.
- No volume or application-data cleanup.

---

## Key Decisions

- Dashboard deploy owns disk lifecycle; cleanup is part of every deploy rather than a
  separate operator chore.
- The production-host lock is authoritative across both GitHub Actions and local
  entry points; it is process-bound and crash-safe at a fixed host-controlled
  root-owned path not derived from deploy inputs, releases on process death or SSH
  loss, and never requires manual stale-lock deletion. Entry-path coordination is not
  a substitute for host serialization; bounded acquisition is deterministic, while
  the exact path and timeout remain Deferred to Planning.
- Real filesystem free bytes on the identified and canonicalized Docker/containerd
  backing filesystem are the headroom authority, parsed as deterministic integers;
  all containers and image references, including stopped-container pins, are
  inventoried before and after prune. Docker disk-usage output is retained as advisory
  evidence, and malformed, missing, stale, or wrong-mount evidence fails closed.
- Safe image pruning occurs before target-image acquisition and Compose desired-state
  mutation, with a complete post-prune evidence report, and never as a post-success
  cleanup step. A partial prune hard-stops before acquisition/mutation, but completed
  safe deletions are not rolled back and stopped containers are never automatically
  deleted.
- The exact immutable target image must be acquired and verified before Compose desired
  state is written; only then may `up`, running-digest/health verification, and the
  versioned audit PR path proceed.
- There is no post-success image prune: the immediately replaced image remains locally
  until the next deploy, older unused eligible images are removed at the next pre-pull
  prune, and images still referenced by containers may also remain. Immutable GHCR
  digests and Compose/audit history remain the rollback authority.
- The existing validated immutable inputs, trusted host-controlled lock/prune/probe
  commands, running digest verification, public health, and audit PR path continue
  after the new preflight and target-acquisition gates pass; automated rollback stays
  out of scope.

---

## Dependencies / Assumptions

- The production host remains a Docker Compose host with the dashboard's Docker and
  containerd storage on a measurable filesystem whose backing mount can be identified
  and canonicalized, and it provides a fixed host-controlled root-owned lock path not
  derived from deploy inputs.
- Docker image-prune semantics continue to preserve images referenced by containers,
  including stopped containers, and volumes are managed independently from image
  cleanup; stopped containers are not automatically deleted.
- Both deployment entry paths can reach and use the same process-bound, crash-safe
  host-scoped lock, which releases on process death or SSH loss and does not require
  manual stale-lock deletion.
- GHCR retains the immutable digests required by the existing rollback and audit
  process.
- The existing dashboard deploy can expose the required baseline, post-cleanup, and
  post-deploy evidence—including all containers and image references, canonical mount,
  deterministic integer free bytes, and post-prune re-report—without logging secrets,
  and can preserve validated immutable image inputs plus trusted SSH/remote-command
  construction. Missing, malformed, or wrong-mount evidence fails closed. Fixed lock,
  prune, and probe commands are host-controlled rather than input-interpolated.
- The current 25 GB root filesystem and observed image extraction overhead are valid
  planning inputs for selecting the initial minimum free-space floor.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R5][Technical] What exact minimum free-space floor provides safe margin on
  the 25 GB host after accounting for dashboard image extraction overhead?
- [Affects R1][Technical] What production-host lock path and bounded acquisition
  timeout should be used?
- [Affects R1, R3, R10][Technical] Should the dashboard reuse the gateway cleanup seam,
  or keep the cleanup behavior dashboard-local?

---

## Sources / Research

- `apps/dashboard/src/deploy.ts` — current dashboard deploy ordering, digest-pinned
  pull/up, running-image digest verification, public health probe, and local compose
  audit write-back.
- `.github/workflows/deploy-dashboard.yaml` — GitHub Actions entry path, version and
  digest inputs, and existing dashboard pin audit PR path.
- `apps/gateway/src/deploy.ts` — existing pre-pull image-reclaim seam and explicit
  protections for volumes and container-referenced images.
- `docs/runbooks/dashboard-released-image-rollback.md` — existing rollback procedure
  based on restoring a known-good Compose tag and immutable digest.
- Infra deploy run `30651636863` on 2026-07-31 and PR `#994` — disk-exhaustion failure,
  approved image-prune remediation, and successful rerun evidence.
- Official Docker documentation for `docker image prune` and Docker disk-usage
  reporting — reference-preservation semantics and the distinction between Docker's
  advisory accounting and real filesystem capacity.
