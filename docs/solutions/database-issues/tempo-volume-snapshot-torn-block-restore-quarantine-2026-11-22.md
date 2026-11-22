---
title: A volume snapshot of a running Tempo can capture a torn block, and the restore quarantines it
date: 2026-11-22
module: apps/traces
problem_type: database_issue
component: database
symptoms:
  - "After a restore, Langfuse (ClickHouse) returned 40 of 40 canary traces and Tempo returned 0 of 40"
  - "tempodb_blocklist_tenant_index_errors_total rose (4) and Tempo served nothing from stored blocks"
  - "One block directory held four zero-byte files: bloom-0, data.parquet, index and meta.json"
  - "After that one directory was moved aside by hand, Tempo served 31 of 40; the nine missing were the inputs of the torn block's compaction"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [tempo, snapshot, restore, quarantine, compaction, crash-consistency, digitalocean]
related_issues:
  - https://github.com/marcusrbrown/infra/pull/2019
related_docs:
  - docs/solutions/integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md
  - docs/solutions/best-practices/remove-interrupted-restore-resume-path-instead-of-patching-2026-11-22.md
  - docs/runbooks/trace-collection.md
  - apps/traces/AGENTS.md
---

# A volume snapshot of a running Tempo can capture a torn block, and the restore quarantines it

## Problem

The daily volume snapshot is taken while the stack runs, so it is crash-consistent only. ClickHouse, PostgreSQL and the object store came back whole from a restore. Tempo's data did not: the snapshot caught a block directory whose files had been created but whose data had not reached the disk. On the restored volume every file in that directory was zero bytes. One empty `meta.json` makes Tempo's tenant index fail, and Tempo then serves nothing from stored blocks, including the healthy ones.

## Symptoms

The rehearsal returned 40/40 canary traces from Langfuse but 0/40 from Tempo; `tempodb_blocklist_tenant_index_errors_total` rose. The affected block's four files were empty. Moving it aside restored 31/40 Tempo traces; the nine missing were inputs already retired by compaction.

## What Didn't Work

- **Waiting for Tempo to recover.** The tenant index does not build while an empty `meta.json` is in the blocklist.
- **Two other options, considered and not taken.** The operator was offered both and declined them:
  - Marking the replaced compaction inputs current again would recover the nine traces, but depends on Tempo internals.
  - A periodic disk flush timer on the host narrows the window in which a snapshot can catch a torn block but does not remove it.

## Solution

The restore moves torn blocks aside and deletes nothing. It runs after the restored volume is mounted and its sentinel verified, while Docker is still stopped, so Tempo is not writing. `apps/traces/server/provision.ts:1665` (in `runRestore`) runs `tempoQuarantineScript` and parses its answer with `parseTempoQuarantine`.

`tempoQuarantineScript` at `apps/traces/server/provision.ts:1403-1448` scans `blocks/<tenant>/<block-uuid>/`. Torn is narrow, defined by `torn` at `apps/traces/server/provision.ts:1420-1426` and `is_object` at `apps/traces/server/provision.ts:1414-1419`:

- The directory name is a UUID, and it has a `meta.json` or a `meta.compacted.json` that is empty or not a JSON object. "Not a JSON object" is the first and last non-space byte being `{` and `}`, not a parse: no script here relies on `python3`.
- A directory with neither file, plain files (`work.json`, `index.json.gz`, `index.pb.zst`), non-UUID entries and symlinks are left alone.

The move is a rename on the same filesystem (`apps/traces/server/provision.ts:1441`, `mv -- "$block_dir" "$dest/$block"`), to `<TRACES_TEMPO_QUARANTINE_ROOT>/<YYYYMMDD-HHMM>/<tenant>/<block>` (`TRACES_TEMPO_QUARANTINE_ROOT` at `apps/traces/src/host.ts:83`). It refuses a cross-device move and an existing destination, creates its directories mode 0700, and is idempotent. `reportQuarantine` at `apps/traces/server/provision.ts:1476-1478` logs each move and says the quarantine is outside retention and must be deleted by hand.

A scan that fails stops the restore with Docker stopped, the volume mounted and ports closed. The message says not to run the restore again, because that would start another restore from the restored volume.

## Why This Works

Quarantine lets Tempo index the remaining blocks without deleting evidence. It does not revive retired compaction inputs, so Tempo can still lack the most recent compaction window.

## Prevention

- **Verify history before deleting the old volume:** follow [Restore](../../runbooks/trace-collection.md#restore); keep the old volume if any check fails or cannot run.
- **Preserve the scan's limit:** it checks braces, not JSON validity; the real-files tests in `apps/traces/server/provision.test.ts:1296` (`tempoQuarantineScript` suite) pin that behavior.
- **Evidence limit:** The host rehearsal moved the torn block manually. The finished scan ran on the host with nothing to move; the current restore path has not completed end to end.
- Quarantine sits outside retention; [the privacy page](https://mrbro.dev/infra/trace-privacy/) discloses it.

## Related Issues

- [PR #2019](https://github.com/marcusrbrown/infra/pull/2019) — restore and backup fixes, including the quarantine.
- [DigitalOcean listing lag](../integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md) — the lag that interrupted the same restore rehearsal.
- [Remove the interrupted-restore resume path](../best-practices/remove-interrupted-restore-resume-path-instead-of-patching-2026-11-22.md).
- `docs/runbooks/trace-collection.md` and `apps/traces/AGENTS.md` — operator procedure and the stack's restore contract.
