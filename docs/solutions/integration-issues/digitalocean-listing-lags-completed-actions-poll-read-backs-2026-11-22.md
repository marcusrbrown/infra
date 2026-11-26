---
title: DigitalOcean listings lag completed actions, so read-backs after a change must poll
date: 2026-11-22
module: apps/traces
problem_type: integration_issue
component: tooling
symptoms:
  - 'Volume "traces-data" not found after creation, right after doctl compute volume create returned'
  - 'Volume "traces-data" is still attached to droplet <id> after the detach call, right after volume-action detach --wait returned'
  - "Trace snapshot backup failed: do-api:list-snapshots:malformed, one second after the snapshot was created"
  - "Trace snapshot backup failed: created-snapshot-not-listed, although the snapshot existed (the listing parsed but did not contain it)"
  - "A restore stopped half-way: ports closed, Docker stopped, both volumes detached"
root_cause: async_timing
resolution_type: code_fix
severity: medium
last_updated: 2026-11-26
tags: [digitalocean, doctl, eventual-consistency, volume, snapshot, restore, backup, read-back]
related_issues:
  - https://github.com/marcusrbrown/infra/pull/2012
  - https://github.com/marcusrbrown/infra/pull/2019
  - https://github.com/marcusrbrown/infra/issues/2017
  - https://github.com/marcusrbrown/infra/issues/2083
  - https://github.com/marcusrbrown/infra/pull/2108
related_docs:
  - docs/solutions/database-issues/tempo-volume-snapshot-torn-block-restore-quarantine-2026-11-22.md
  - docs/solutions/best-practices/remove-interrupted-restore-resume-path-instead-of-patching-2026-11-22.md
  - docs/solutions/workflow-issues/traces-first-deploy-cascade-2026-11-22.md
  - docs/solutions/workflow-issues/primary-source-verification-for-delegated-findings-2026-09-12.md
---

# DigitalOcean listings lag completed actions, so read-backs after a change must poll

## Problem

DigitalOcean's volume list and snapshot list can trail a completed change by seconds. A single read taken right after the change can omit a new object, still show the old attachment state, or answer in an unexpected shape. Code that treats that one read as proof of the change fails on a change that succeeded. The traces rollout hit this three times: provisioning (volume create), restore (volume detach) and the daily backup (snapshot create, in two forms: a malformed listing, then a clean listing that lacked the new snapshot). Both `doctl` (provisioning, restore) and the REST API (the backup script) showed it.

## Symptoms

- Volume create and detach succeeded, but the immediate listings respectively omitted the volume and showed its old attachment.
- Snapshot creation succeeded, but the immediate read-back was malformed.
- Snapshot creation succeeded, but a later read-back parsed cleanly and did not list the new snapshot. The 2026-11-25 scheduled backup failed with `created-snapshot-not-listed` and opened #2083, although the snapshot existed. The 25 s window of six reads was too short.
- In this probe, a volume created with `--desc` appeared in the list about 15 seconds after creation, while `volume get` returned it immediately.

## What Didn't Work

- **`--wait` on the action.** It waits for the action, not for the listing to reflect it.
- **Fixing only the create read.** [PR #2012](https://github.com/marcusrbrown/infra/pull/2012) polled the list after `volume create`. The attach and detach reads and the backup's snapshot read-back stayed single reads. Review of #2012 had flagged the restore's single listing as non-blocking.
- **A resume path for the interrupted restore.** It was removed because it could not establish which volume was which ([restore resume removal](../best-practices/remove-interrupted-restore-resume-path-instead-of-patching-2026-11-22.md)).

## Solution

`pollVolumeListing` in `apps/traces/server/provision.ts:381-393` makes at most 12 reads, five seconds apart, for create, attach and detach; the caller fails if the expected state remains absent.

The backup read-back (`readBackSnapshots` and the `READBACK_*` constants in [`packages/cli/scripts/traces-backup.ts`](../../../packages/cli/scripts/traces-backup.ts)) retries malformed listings and listings that lack the new id. It fails network, timeout and HTTP errors at once, and it keeps the age and prune guards. Its window is its own, not the restore poll's.

## Prevention

- **Rule, scoped to what was observed.** After `volume create`, `volume-action attach`, `volume-action detach` and a snapshot create, read the result back through a bounded poll on the expected state. Do not treat one list read as proof.
- **A retry window is a measurement, not a constant.** Size it from the observed lag, record the basis, and revisit it after a not-listed failure. The first snapshot window came from a probe of the volume listing (about 15 seconds). The 2026-11-25 backup then needed longer (#2083, #2108). A run that passes under the old window shows only that the lag is intermittent.
- **Known limit of the detach poll.** `detachVolume` accepts a listing that shows the volume without the droplet, and also a listing that omits the volume (`apps/traces/server/provision.ts:427-431`). In the second case it does not prove the detach.
- **Audited read-after-write pairs left as single reads, on purpose:**
  - Firewall create then find, `ensureFirewall` at `apps/traces/server/provision.ts:553`. A miss throws before anything depends on the firewall.
  - `closeWebPorts` read-backs at `apps/traces/server/provision.ts:566` and `apps/traces/server/provision.ts:584-595`. A stale read fails closed: it throws that ports are not confirmed closed, and nothing else was changed.
  - `openWebPorts` read-back at `apps/traces/server/provision.ts:607`. A stale read throws after the add call; rerunning the reopen is harmless.
  - Droplet create uses `--wait`, and the next reads are by name (`getDropletId`, `getDropletIp` at `apps/traces/server/provision.ts:313-328`, which already retries for the address). Not observed to lag.
- **Test a new read-after-write with an injected `sleep`.** A stale listing followed by a settled one passes, a never-settled listing throws the specific message, and no sleep precedes the first read.
- **After an attach or detach failure, check actual volume state before acting; do not rerun blindly.** Follow [Interrupted restore](../../runbooks/trace-collection.md#interrupted-restore).

## Related Issues

- [Tempo torn block on restore](../database-issues/tempo-volume-snapshot-torn-block-restore-quarantine-2026-11-22.md) — the restore rehearsal that followed the first backup and restore runs.
- [Remove the interrupted-restore resume path](../best-practices/remove-interrupted-restore-resume-path-instead-of-patching-2026-11-22.md) — why the resume path was removed.
- [Traces first deploy cascade](../workflow-issues/traces-first-deploy-cascade-2026-11-22.md) — the other host-only defects from the same rollout.
- [Verify against primary state, not a report](../workflow-issues/primary-source-verification-for-delegated-findings-2026-09-12.md) — a success reply from a change call is not proof; read the state.
- [PR #2012](https://github.com/marcusrbrown/infra/pull/2012), [PR #2019](https://github.com/marcusrbrown/infra/pull/2019).
- Operator procedures: `docs/runbooks/trace-collection.md` (backups, restore) and `apps/traces/AGENTS.md` (Restore).
