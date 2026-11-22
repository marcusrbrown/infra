---
title: Remove a restore resume path that cannot establish resource identity, instead of patching it
date: 2026-11-22
module: apps/traces
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "A resume or heal path would have to infer which resource held the live data or where a resource came from"
  - "Review keeps finding identity holes in the same recovery path round after round"
tags: [restore, recovery, code-review, remove-code, identity, digitalocean, volumes]
related_issues:
  - https://github.com/marcusrbrown/infra/pull/2019
related_docs:
  - docs/solutions/integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md
  - docs/solutions/database-issues/tempo-volume-snapshot-torn-block-restore-quarantine-2026-11-22.md
  - docs/runbooks/trace-collection.md
---

# Remove a restore resume path that cannot establish resource identity, instead of patching it

## Context

The traces restore swaps the attached `traces-data*` volume for one created from a snapshot. The first real restore stopped half-way because DigitalOcean's volume list lagged the detach ([listing lag](../integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md)). A resume path was built so a second run could pick up the one detached `traces-data-restore-*` volume when nothing was attached.

[PR #2019](https://github.com/marcusrbrown/infra/pull/2019) review requested changes twice on that path, then approved after the path was removed. Polling the listing reduces the observed failure but does not rule out other interruptions, such as a dropped SSH session or an API error. The reason for the removal is different: the tool could not establish resource identity. Nothing recorded which detached volume held the live data, or which snapshot a restore volume came from.

## Guidance

1. **When review keeps finding identity holes in a recovery path, ask whether the path can know what it needs to know.** If it cannot, delete the path. Do not add state to it.
2. **If resource identity cannot be established, refuse without assigning roles or deleting anything.** List candidates and give a manual procedure that leaves the command runnable.
3. **Treat human-readable labels as labels, not identity records.**
4. **State which recovery path was actually tested.**

## Why This Matters

- **Round 1:** A detached restore volume was not tied to the requested snapshot, and the live volume could itself be a restore volume. A snapshot-name label did not establish the previous volume's identity.
- **Round 2:** The refusal advised deleting the leftover volume, but the command then refused again; a snapshot name could also refer to a replacement snapshot.
- **Resolution:** Remove automatic resume. Keep the description as a human-readable label only.

## Examples

`volumeCountRefusal` at `apps/traces/server/provision.ts:1506-1516` refuses unless exactly one `traces-data*` volume is attached; it lists candidates without assigning their roles. For recovery, follow [Interrupted restore](../../runbooks/trace-collection.md#interrupted-restore).

**Evidence limit:** The host rehearsal completed through the removed resume path. Individual current-path steps ran on the host, but the current first-run path has not completed a real restore end to end.

## Related

- [DigitalOcean listing lag](../integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md) — the failure the resume path was built for.
- [Tempo torn block on restore](../database-issues/tempo-volume-snapshot-torn-block-restore-quarantine-2026-11-22.md) — the rest of the restore rehearsal.
- [PR #2019](https://github.com/marcusrbrown/infra/pull/2019).
