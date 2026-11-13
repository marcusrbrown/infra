---
title: "Privacy terms that exist only as docs prose: a fail-closed snapshot, a review PR and fixture-pinned tests"
date: 2026-11-05
module: packages/shared/opencode-go
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "A security or privacy gate depends on human-written third-party terms such as retention, training or region rules"
  - "The only source of those terms is prose or tables in a docs page, with no API field"
  - "A parser of third-party markup decides what the deploy may expose"
  - "A committed data file is rewritten by an automated refresh and tests must not break when it changes"
tags: [opencode-go, privacy, fail-closed, parser, snapshot, refresh-pr, fixtures, codeql, redos]
related_components:
  - development_workflow
---

# Privacy terms that exist only as docs prose: a fail-closed snapshot, a review PR and fixture-pinned tests

## Context

The OpenCode Go model list endpoint carries no retention, training or region fields. The only source is a hand-written table in the upstream repository's `console/go.mdx`. The cliproxy deploy must expose only models that keep no data, never train on it and need no restricted region. That decision therefore rests on a reviewed snapshot parsed from the page, refreshed by a pull request, and applied by both the deploy and the monitor.

The policy lives in `packages/shared/opencode-go/`: `parse-privacy-table.ts`, `eligibility.ts`, `privacy-snapshot.json` and `settings.json`. It sits outside `packages/shared/cliproxy/**`, so a refresh triggers the cliproxy deploy filter in `.github/workflows/deploy.yaml` and not the broker's.

## Guidance

### Parse the prose, and fail closed on anything unmapped

The parser joins five places in the page: the Endpoints table (display name to model id), the Privacy table, the Privacy footnotes, the "Enable restricted models" bullets and the model list with its "limited regions" notes, a second input to region gating. Its contract, from the header comment of `parse-privacy-table.ts`:

> It fails closed. A row, marker, footnote sentence or rule it cannot map throws `PrivacyTableError`, so a format change upstream stops the refresh instead of marking a model safe by accident.

- `applyFootnotes` matches each footnote sentence against a fixed rule list. An unmatched sentence throws, and so does a footnote that contradicts the table.
- Three footnote sentences set `regionGated`: `Availability is limited to regions permitted by …`, `Hosted in <place>.` and `Requires **Global** regions in your workspace privacy settings.`; the restricted-models bullets and the `(limited regions)` notes gate independently.
- A `*` marker with no qualifying footnote throws in `parsePrivacyTable`.
- Bullets are parsed strictly. `bulletsOf` requires this exact shape for every list item it sees:

  <!-- prettier-ignore -->
  ```ts
  const match = /^- \*\*([^*]+):\*\* (.+)$/.exec(line)
  ```

  A list item that does not match throws. Moving the colon outside the bold text, as in `- **Label**: text`, still counts as a list item, so it throws instead of silently dropping a region gate. Footnotes use the `every-line` mode, where any stray line throws. The restricted-models section uses `list-items`, where plain prose lines between bullets are allowed.

- `parsePrivacyTable` ends with a self-check: its output must pass the same two-stage `parseSnapshot` the deploy applies.

### One pure eligibility function for the deploy, the monitor and the refresh

`computeEligibility` in `eligibility.ts` takes the parsed snapshot, the live model ids and today's UTC date. Every exclusion has a named reason:

<!-- prettier-ignore -->
```ts
export const EXCLUSION_REASONS = [
  'not-in-snapshot',
  'not-live',
  'trains-on-data',
  'not-zero-retention',
  'region-gated',
  'agreement-expired',
  'invalid-entry',
] as const
```

- `exclusionReason` returns the first reason that applies. Anything unknown, invalid, expired or not live is excluded, never assumed safe.
- Region-gated models are never exposed, and there is no override flag.
- An agreement that expires on `todayUtc` is still valid.
- A malformed entry excludes only that model. A malformed envelope throws. Error text carries field paths and issue codes, never values.
- `preflightOpenCodeGo` in `apps/cliproxy/src/deploy.ts` fetches the live list on each deploy and fails before any SSH when the eligible set is empty. The monitor probe in `packages/cli/src/commands/cliproxy/status.ts` recomputes eligibility on every run from the committed snapshot. It flags an exposed model that is no longer eligible, including one whose agreement has expired, as `privacy-noncompliant`.

### Refresh by pull request, never by deploy

- **Source.** `refreshGoPrivacy` in `apps/cliproxy/scripts/refresh-go-privacy.ts` resolves the upstream `dev` head SHA on each run, fetches `go.mdx` at exactly that SHA through GitHub's raw-content endpoint (`goMdxUrl`), parses it, and records the SHA in the snapshot. The SHA lookup on `api.github.com` carries the read-only workflow token to avoid the anonymous rate limit. The raw fetch is unauthenticated. The script does not scrape the website, because the docs site terms prohibit crawling.
- **Change test.** `diffSnapshots` compares model terms only. A new source commit alone is not a change, so unrelated upstream pushes open no PR. Fetch, parse and comparison failures throw before the snapshot is replaced. On a change the script writes the PR body, then atomically replaces the snapshot.
- **PR.** `.github/workflows/opencode-go-privacy.yaml` runs daily and opens or updates one stable branch, `opencode-go-privacy`. `renderPrBody` lists added, removed and changed models with their privacy fields and an upstream compare link. Auto-merge stays off. Merging triggers the gated cliproxy deploy, and a model the PR adds is exposed only after that deploy is approved.
- **Credentials.** Checkout persists none. The refresh step and the stale-PR lookup use only the read-only workflow token. A GitHub App token with `contents: write` and `pull-requests: write` is minted only after the parse succeeded and either the snapshot changed or a stale PR is open.
- **Stale PR.** When upstream terms match `main` again, the run closes the open same-repository PR with a comment and then deletes the branch. A PR on that branch from a fork is left alone.
- **Review rule.** The upstream table is the authority, not the parsed JSON (`docs/runbooks/cliproxy-opencode-go.md`, "Snapshot refresh PR review").

### Test against pinned fixtures, never against the file the refresh rewrites

- Parser tests compare the parse of a pinned `__fixtures__/go.mdx` with `__fixtures__/go.expected.json`. Failure cases are built by mutating the fixture. The `mutate` helper asserts the replaced text occurs exactly once, so a drifted fixture fails loudly instead of silently testing nothing.
- Eligibility tests use the pinned expected snapshot and a recorded live list (`__fixtures__/live-models.json`). `eligibility.test.ts` states the rule: a privacy refresh rewrites the committed snapshot, so nothing about individual models may be asserted against that file.
- Tests on the committed files assert invariants only. The settings test requires that `settings.json` parses whether Go is enabled or disabled, so an emergency-disable PR cannot fail CI by flipping `enabled`.
- The parser reads third-party text, so its regexes must run in linear time. CodeQL flagged three polynomial-backtracking patterns in `stripLinks`, `resolveLabel` and `bulletsOf`. They became linear patterns and plain string splits:

  <!-- prettier-ignore -->
  ```ts
  const stripLinks = (text: string): string => text.replaceAll(/\[([^[\]]*)\]\([^()]*\)/g, '$1')
  ```

## Why This Matters

- Prose has no schema. Without fail-closed parsing, a reworded sentence makes a model look safe by omission.
- Without pinned fixtures, every legitimate refresh breaks CI, or the tests quietly stop checking anything.
- Without a PR, a privacy change reaches production with no human reading the upstream table.
- An agreement that expires between deploys keeps the model served until the next deploy. The monitor's eligibility check is what tells the operator; it does not remove the model.

## When to Apply

- Any exposure decision that depends on human-written third-party terms: retention, training, regions, contract dates.
- Any parser of third-party markup that feeds a security or privacy gate.
- Any committed data file that an automated job rewrites and that tests also read.

## Examples

- Reviewing a refresh PR: open the compare link, check each Added, Removed and Changed model against the table in that diff, and check every new model for zero retention, no training, no region requirement and any agreement expiry.
- Stopping exposure before a PR can merge: send the field-scoped PATCH from "Emergency disable without a deploy" in `docs/runbooks/cliproxy-opencode-go.md`, then set `enabled` to false in a PR.

## Related

- `docs/runbooks/cliproxy-opencode-go.md` — "Snapshot refresh PR review" and "Limitations".
- `docs/solutions/integration-issues/opencode-go-through-cliproxy-session-header-billing-source-2026-11-05.md` — routing, billing signal and key scope for the same entry.
- `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md` — guards on the whole-section write that applies the eligible list.
- `docs/solutions/best-practices/upstream-data-file-download-not-checkout-bun-test-discovery-2026-11-04.md` — the same download-one-file-not-checkout approach.
- `apps/cliproxy/AGENTS.md` — "OPENCODE GO UPSTREAM".
