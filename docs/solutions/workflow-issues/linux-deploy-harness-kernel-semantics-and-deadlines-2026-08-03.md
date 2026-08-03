---
title: Production deploy harnesses must preserve Linux kernel semantics and deadline behavior
date: 2026-08-03
category: workflow-issues
module: apps/dashboard
problem_type: workflow_issue
component: testing_framework
severity: high
applies_when:
  - A deploy test replaces Linux primitives such as `flock`, `timeout`, or `stat` with stubs
  - A shell harness runs on BSD/macOS while the production transaction runs on Linux
  - A generated remote transaction has both remote and caller-side deadlines
  - A contention test needs to prove lock ownership, release, and no mutation while waiting
  - A production deploy path has been hardened but its verification still runs only in a normalized harness
tags:
  - dashboard
  - deploy
  - linux
  - flock
  - shell-harness
  - deadlines
  - portability
  - testing
---

# Production deploy harnesses must preserve Linux kernel semantics and deadline behavior

## Context

The dashboard deploy is a generated Linux shell transaction, not just a TypeScript function. `apps/dashboard/src/remote-deploy.ts` validates a root-owned runtime directory, acquires `/run/dashboard-deploy/lock`, stages and verifies the payload, prunes images, checks storage, publishes active files, converges Compose, and records post-convergence evidence while the lock remains held. Both the GitHub Actions path and the local CLI path use this one remote transaction; the operational contract is documented in [`apps/dashboard/AGENTS.md`](../../../apps/dashboard/AGENTS.md) and [`apps/dashboard/README.md`](../../../apps/dashboard/README.md).

The test harness must therefore preserve the Linux behaviors that make the transaction safe. A green test on macOS is insufficient when it has replaced the kernel lock with a function, normalized GNU output into BSD output, or used sleeps instead of observing a transaction boundary. PR [#1005](https://github.com/marcusrbrown/infra/pull/1005) introduced the locked transaction, bounded deadlines, Linux harness, and storage gates. PR [#1007](https://github.com/marcusrbrown/infra/pull/1007) fixed a real GNU `stat` incompatibility that had already blocked a production deploy.

## Failure pattern

### Stubbed `flock` can be falsely green

`adaptProgramForUnprivilegedHarness` in `remote-deploy.test.ts` deliberately has a test-only path. Unless `stubFlock: false` or an explicit stub exit code is requested, it selects `REMOTE_TRANSACTION_TEST_PROGRAM` and replaces privileged operations for an unprivileged temporary directory. That path is useful for payload, ordering, storage, and failure tests, but it does not prove kernel mutual exclusion, owner-death release, or elapsed lock-wait behavior.

The production program wraps the complete locked child transaction:

```ts
`flock -w ${REMOTE_LOCK_WAIT_SECONDS} -E 75 "$LOCK_PATH" /bin/bash -c ${shellQuote(remoteLockedChildProgram)}`
```

The default harness must not be treated as evidence for that line. A test that makes `flock()` return success can pass while two transactions would actually run concurrently. A test that makes it return `75` proves only the caller's contention mapping and pre-mutation boundary, not the kernel lock itself.

### Platform normalization can hide the production contract

The harness adapts BSD and GNU `stat` separately:

```ts
const hostFileStat = darwinStat
  ? '/usr/bin/stat -f "%u:%g:%Lp:%HT" "$1"'
  : String.raw`command stat -c "%u:%g:%a:%F" "$1"`
```

That is appropriate for making an unprivileged local harness runnable, but it must not turn a Linux-only contract into a platform-neutral one. The production remote command uses GNU `stat`; the Linux path needs its own execution proof.

GNU `stat -c %F` also has a wording trap: an empty regular file is reported as `regular empty file`, not `regular file`. The original lock check compared the full human-readable type and failed before payload decode or mutation. PR #1007 changed the lock metadata check to numeric owner/group/mode while retaining the independent regular-file and no-symlink checks:

```bash
lock_stat="$(stat -c "%u:%g:%a" -- "$LOCK_PATH" 2>/dev/null)" || fail "unsafe-path" "lock path stat failed"
[ "$lock_stat" = "$ROOT_OWNER:600" ] || fail "unsafe-path" "lock path ownership or mode is unsafe"
```

Use numeric `%u:%g:%a` checks for identity and permissions. Use `[ -f ]` plus `[ ! -L ]` for file shape. Do not make a human-readable `%F` string the sole proof of a regular empty lock file. The harness must exercise both the BSD command form and the GNU command form without claiming that their output vocabulary is identical.

## Required verification shape

### 1. Keep the shell harness for deterministic ordering

The unprivileged harness remains valuable for proving that lock contention stops before `payload-decoded`, `baseline-evidence`, pruning, staging, or active publication. The existing contention test uses a stubbed `flock` exit `75` and expects exactly:

```text
stage=remote-transaction-started
stage=lock-contention
failure=lock-contention
```

It also asserts that no dashboard root or `attempt.*` staging directory exists. This is a deterministic pre-mutation test, not a kernel-lock test.

Stage output is the synchronization contract. The stage-boundary test requires one `stage=remote-transaction-started` marker immediately before `stage=lock-acquired`. The real-lock test waits for the owner output marker and child PID by reading stdout:

```ts
while (!firstOutput.includes('stage=lock-acquired\n') || ownerPid === undefined) {
  const next = await firstReader.read()
  if (next.done)
    throw new Error(`lock owner exited before acquisition: ${firstOutput}\nstderr=${await firstStderrPromise}`)
  firstOutput += firstDecoder.decode(next.value, {stream: true})
  const pidMatch = /test-child-pid=(\d+)/.exec(firstOutput)
  if (pidMatch) ownerPid = Number(pidMatch[1])
}
```

Do not replace this barrier with `sleep(10)`, polling a guessed elapsed time, or assuming that process creation means lock acquisition. A fixed sleep can race on a busy host and can make a contender test green without ever observing the owner holding the lock.

### 2. Run one real Linux kernel-flock lifecycle test

The `uses the real kernel flock lifecycle and releases it on owner death` test is skipped unless util-linux `flock` supports `--conflict-exit-code`. When available, it:

1. Runs the production transaction program with `stubFlock: false` and a shortened one-second wait only through the test seam.
2. Waits for `stage=lock-acquired` and the child PID, not a sleep.
3. Starts a contender and asserts exit `75`, `stage=lock-contention`, and no `payload-decoded` or `baseline-evidence`.
4. Terminates the lock-owning child and waits for the wrapper to exit.
5. Runs a retry and asserts successful completion, the same lock inode, and no leftover `attempt.*` directory.

This is the test that proves the kernel owns the lifecycle: contention is real, the lock is released when the owner dies, and no stale-lock cleanup is needed. A platform-normalized or stubbed substitute cannot establish those facts.

### 3. Test the deadline layers as a lifecycle

The current production values are:

| Boundary | Contract |
| --- | ---: |
| Kernel lock wait | 180 seconds, `flock` conflict exit `75` |
| Remote transaction | 900 seconds |
| Remote kill-after | 15 seconds after `TERM` |
| Caller watchdog | 960 seconds |

`buildRemoteSshCommand` wraps the remote program with GNU `timeout` using `TERM`, then `KILL` after 15 seconds. The caller-side `runRemoteTransaction` has a separate watchdog. When it fires, the caller must abort output readers, send `SIGTERM`, wait a bounded grace period, send `SIGKILL` if the SSH process is still alive, wait for the process to reap, and settle the output readers before returning the timeout error. The tests `kills and returns when the caller watchdog sees a never-settling process`, `settles cancelled output readers before returning caller timeout`, and `waits for a post-KILL process reap before returning timeout` pin those obligations.

The SSH command wrapper normalizes GNU `timeout` exits `124` and `137` to the reserved `transaction-timeout` result. GNU `timeout` cannot distinguish its own kill-after status `137` from a child that independently exits `137`, so the normalization is deliberately conservative.

The watchdog is not an arbitrary round number. The source requires it to exceed SSH connect timeout plus remote timeout, kill-after, and drain margin: `10 + 900 + 15 + 30 = 955` seconds, so the production default is 960 seconds. Keep that inequality when changing any deadline; otherwise the caller can kill the SSH process before the remote wrapper has completed its own escalation and output drain.

## Production proof

The production lock drill used a holder that retained the lock for 240 seconds and a real contender. The contender failed after **180.241 seconds** with exit **75**, reported lock contention, and stopped before payload decode or any mutation. The 240-second holder / 180.241-second contender drill is separate from GHA deployment runs [30785307051](https://github.com/marcusrbrown/infra/actions/runs/30785307051) and [30786511189](https://github.com/marcusrbrown/infra/actions/runs/30786511189); it is a production lock verification exercise, not a deployment run itself. That proves the bounded wait is enforced against the real kernel lock rather than merely asserted by a stub.

The design intentionally has **no stale-lock cleanup**. The lock file is a stable, root-owned `0600` regular file; the advisory lock is associated with the kernel-held file descriptor, and process death releases it. Deleting or replacing the file to “recover” would create a second race and could let two transactions operate against different inodes. Recovery is to wait for the owner to finish or die, then rerun after the bounded contention failure.

## Reusable guidance

- Separate harness claims: a stubbed shell harness proves ordering and failure boundaries; a real Linux run proves kernel and GNU semantics.
- Preserve stage markers as barriers. Synchronize on observed output and, where needed, a child PID; never on fixed sleeps.
- Test the exact generated remote program with `bash -n` and a Linux execution path before treating the TypeScript wrapper as verified.
- Prefer numeric `stat` fields for owner, group, mode, and size. Keep file-type and symlink checks independent of human-readable GNU wording.
- Keep the entire remote mutation inside one lock-owning transaction. Do not add a separate lock holder or stale-lock cleanup phase.
- Verify every deadline layer and the caller's `TERM` → bounded wait → `KILL` → reap sequence. A timeout test that only checks an error string is incomplete.
- Repeat the production contention drill after changing lock paths, timeout values, generated shell structure, or caller process handling.

For operator recovery after a bounded deploy failure, use [`dashboard-released-image-rollback.md`](../../runbooks/dashboard-released-image-rollback.md); it documents lock contention, transaction timeouts, the no-automatic-rollback posture, and the requirement to inspect state before rerunning.

## Related links

- [`apps/dashboard/AGENTS.md`](../../../apps/dashboard/AGENTS.md)
- [`apps/dashboard/README.md`](../../../apps/dashboard/README.md)
- [`dashboard-released-image-rollback.md`](../../runbooks/dashboard-released-image-rollback.md)
- [`dashboard-deploy-proof-replacement-audit-same-target-2026-08-03.md`](dashboard-deploy-proof-replacement-audit-same-target-2026-08-03.md)
