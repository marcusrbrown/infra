---
title: "OpenCode Go privacy terms: a fail-closed snapshot built from two sources, a review PR and fixture-pinned tests"
date: 2026-11-05
last_updated: 2026-11-19
module: packages/shared/opencode-go
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "A security or privacy gate depends on third-party terms such as retention, training or region rules"
  - "Some of those terms exist only as prose or tables in a docs page, and any machine-readable source covers only part of them"
  - "A parser of third-party markup decides what the deploy may expose"
  - "A committed data file is rewritten by an automated refresh and tests must not break when it changes"
tags: [opencode-go, privacy, fail-closed, parser, snapshot, refresh-pr, fixtures, codeql, redos]
related_components:
  - development_workflow
---

# OpenCode Go privacy terms: a fail-closed snapshot built from two sources, a review PR and fixture-pinned tests

## Context

The cliproxy deploy must expose only OpenCode Go models that keep no data, never train on it and need no restricted region. Two upstream sources carry those terms, and neither carries all of them:

- **The public Go model list** (`GO_LIVE_MODELS_URL` in `packages/shared/opencode-go/live-models.ts`): per model, a `go` object with three booleans, `training`, `zdr` and `limited_regions`. `limited_regions` means some countries are refused.
- **The docs page** `console/go.mdx` in the upstream repository: a Privacy table, footnotes, "Enable restricted models" bullets and Usage limits notices. It has no model ids.

A reviewed snapshot built from both decides what the deploy exposes. A pull request refreshes it, and both the deploy and the monitor apply it.

The policy lives in `packages/shared/opencode-go/`: `live-models.ts`, `parse-privacy-table.ts`, `build-snapshot.ts`, `model-names.ts`, `eligibility.ts`, `privacy-snapshot.json` and `settings.json`. It sits outside `packages/shared/cliproxy/**`, so a refresh triggers the cliproxy deploy filter in `.github/workflows/deploy.yaml` and not the broker's.

## Guidance

### Build from two sources and take the more restrictive value

A model both sources know gets this entry, from `buildSnapshot` in `build-snapshot.ts`:

<!-- prettier-ignore -->
```ts
const entry = {
  // Both sources must say so: a retention period on either side is a retention period.
  zeroRetention: model.zdr && docsZeroRetention,
  // Either source granting training use is enough.
  trainsOnData: model.training || row.trainingGranted,
  // Either source restricting the model's regions is enough.
  regionGated: model.limitedRegions || row.availabilityLimited || row.regionRequirement,
  agreementExpiry: row.agreementExpiry,
}
```

- **Retention:** `zeroRetention` needs the list's `zdr: true` and a `0 days` row on the page.
- **Region:** the page supplies two signals. `availabilityLimited` comes from the footnote `Availability is limited to regions permitted by …` and from the usage-limits notice `Not available in <places>.`. `regionRequirement` comes from the workspace Global-region rule and from `Hosted in <place>.`.
- **Page only:** retention days, the agreement expiry date and the Global-region rule. The list's `limited_regions` is a different fact (countries refused). A fact only one source can state is not a disagreement; where both state a fact and differ, the PR body lists the model and fact.
- **Check the page before calling a fact API-only.** Beam Free's region limit was first treated as API-only, but the page states it in a usage notice. With the list flipped to `limited_regions: false`, the builder wrote `regionGated: false` and reported nothing. The parser now reads the notice.
- **Join by normalized name** (case, whitespace, hyphens) plus the reviewed `DOCS_NAME_ALIASES` map in `model-names.ts`, never by prefix: `Hy4` is a prefix of `Hy4 preview` and `Hy4 flash Free`. A join that pairs nothing throws.
- **Reports sanitise upstream names** (collapsed whitespace, no backticks, one code span, length cap).

### Fail closed on anything unrecognised in the page

A row, column, marker, footnote sentence, label or rule the parser cannot map throws `PrivacyTableError`. A format change upstream stops the refresh instead of marking a model safe by accident.

- **Whole sentences and names.** A footnote sentence must match one known form from its first character to its last. A "starts with" or "contains" branch discards the rest of the sentence: `Requests are retained for 0 days, and permission to use your prompts … is granted.` read as plain retention. A label resolves by exact normalized name or a reviewed group, never by prefix or suffix.
- **Prose is not read as a restriction.** Prose that names a Privacy model, in the restricted-models section or before the Privacy table, throws.
- **Bullets are strict.** `bulletsOf` requires this exact shape for every list item it sees:

  <!-- prettier-ignore -->
  ```ts
  const match = /^- \*\*([^*]+):\*\* (.+)$/.exec(line)
  ```

  An item that does not match throws. `- **Label**: text` (colon outside the bold) is still a list item, so it throws instead of silently dropping a region gate. In the footnotes any stray line throws.

- **A `*` marker** with no agreement-expiry footnote throws.
- **Self-check.** The built snapshot must pass the same two-stage `parseSnapshot` the deploy applies.
- **Linear time.** Every regex is anchored with no nested or overlapping quantifier, because it runs over third-party text. CodeQL flagged three polynomial-backtracking patterns (`stripLinks`, `resolveLabel`, `bulletsOf`); they became linear patterns and plain string splits.

### A failed refresh is itself a failure mode

A refresh that throws leaves the committed snapshot in place, and the deploy keeps applying it. If the same upstream change tightened a term, the snapshot is wrong in the unsafe direction until the parser is fixed. Throw only when the input as a whole is wrong: an unrecognised page structure, a changed response shape, an ambiguous join, a join that pairs nothing. Missing evidence for one model excludes that model (`not-in-snapshot`) and is reported in the workflow log and a PR-body section.

A first version threw when only one source knew a model. A new list model with no page row, arriving with a new restriction on an exposed model, blocked the refresh and left the restricted model eligible.

The refresh workflow has no failure notification of its own. The daily report surfaced infra#1973.

### Attribute by content when markup rules keep multiplying

The Usage limits section holds pricing sentences that change weekly, so it is the one place where unrecognised sentences are tolerated. The usage-notice rule, per paragraph:

1. Paragraphs are split on blank lines and headings only, outside code fences. Hard line breaks, list markers, emphasis and colons are not boundaries.
2. A paragraph with no availability word is ignored.
3. Every availability sentence in the others must be the recognised form `Not available in <places>.`, or the refresh throws.
4. The paragraph must name exactly one Privacy model, as a whole word, longest name winning (`Hy4 preview` is not also `Hy4`). That model is region-limited. No model named, or several, throws.

The rule replaced parsing the `**Model:**` label. Three review rounds each found Markdown that defeated it (the wrong section; `**Beam Free**:` with the colon outside the bold; a hard line break that glued an unreadable label line onto a `**GLM-5.3:**` paragraph, so the restriction landed on GLM-5.3 and Beam was cleared), and each fix added another markup rule. Attribution by the names in the text depends on no markup.

### Resolve reviewed family mappings only where the page uses the label

`LABEL_GROUPS` maps a family label such as `DeepSeek` to several Privacy rows. Resolved eagerly, a mapping naming a retired family member blocked the refresh although no page text used the label: the fail-stale failure again, fixed before the redesign merged. `nameIndex` now indexes names only, and `resolveEntry` resolves a mapping when text matched it. A mapping that names a retired row throws only then.

### One pure eligibility function for the deploy, the monitor and the refresh

`computeEligibility` in `eligibility.ts` takes the parsed snapshot, the live model ids and today's UTC date. Every exclusion has a named reason, from `EXCLUSION_REASONS`: `not-in-snapshot`, `not-live`, `trains-on-data`, `not-zero-retention`, `region-gated`, `agreement-expired`, `invalid-entry`.

- `exclusionReason` returns the first reason that applies. Anything unknown, invalid, expired or not live is excluded, never assumed safe.
- Region-gated models are never exposed; there is no override flag. An agreement that expires on `todayUtc` is still valid.
- A malformed entry excludes only that model; a malformed envelope throws. Error text carries field paths and issue codes, never values.
- `preflightOpenCodeGo` in `apps/cliproxy/src/deploy.ts` fetches the live list on each deploy and fails before any SSH when the eligible set is empty. The monitor probe in `packages/cli/src/commands/cliproxy/status.ts` recomputes eligibility on every run from the committed snapshot. It flags an exposed model that is no longer eligible, including one whose agreement has expired, as `privacy-noncompliant`.

### Refresh by pull request, never by deploy

- **Source.** `refreshGoPrivacy` in `apps/cliproxy/scripts/refresh-go-privacy.ts` resolves the upstream `dev` head SHA on each run, fetches `go.mdx` at exactly that SHA through GitHub's raw-content endpoint (`goMdxUrl`), fetches the live model list, builds the snapshot and records the SHA. The SHA lookup on `api.github.com` carries the read-only workflow token to avoid the anonymous rate limit. The raw fetch is unauthenticated. The script does not scrape the website, because the docs site terms prohibit crawling.
- **Change test.** `diffSnapshots` compares model terms only, so a new source commit alone opens no PR. Fetch, parse and comparison failures throw before the snapshot is replaced. On a change the script writes the PR body, then atomically replaces the snapshot.
- **PR.** `.github/workflows/opencode-go-privacy.yaml` runs daily and opens or updates one stable branch, `opencode-go-privacy`. `renderPrBody` lists added, removed and changed models with their privacy fields, the disagreements, the models left out and an upstream compare link. Auto-merge stays off. Merging triggers the gated cliproxy deploy, and a model the PR adds is exposed only after that deploy is approved.
- **Credentials.** Checkout persists none. The refresh step and the stale-PR lookup use only the read-only workflow token. A GitHub App token with `contents: write` and `pull-requests: write` is minted only after the parse succeeded and either the snapshot changed or a stale PR is open.
- **Stale PR.** When upstream terms match `main` again, the run closes the open same-repository PR with a comment and then deletes the branch. A PR on that branch from a fork is left alone.
- **Review rule.** The upstream page is the authority, not the parsed JSON (`docs/runbooks/cliproxy-opencode-go.md`, "Snapshot refresh PR review").

### Test against pinned fixtures, never against the file the refresh rewrites

- Per-model terms are asserted against pinned fixtures: `__fixtures__/go.mdx`, `__fixtures__/live-models.json` and the snapshot they build, `__fixtures__/go.expected.json`. A privacy refresh rewrites the committed snapshot, so nothing about an individual model may be asserted against that file. The per-model pin that contained Gemini 4 Argon (#1976) became a fixture test.
- Parser failure cases are built by mutating the fixture. The `mutate` helper asserts the replaced text occurs exactly once, so a drifted fixture fails loudly instead of silently testing nothing.
- Tests on the committed files assert invariants only: the snapshot passes the schema, records a 40-hex source commit and leaves at least one model eligible, and re-serializes to identical bytes. The settings test requires that `settings.json` parses whether Go is enabled or disabled, so an emergency-disable PR cannot fail CI by flipping `enabled`.

## Evidence: the snapshot went stale twice in ten days

- **2026-11-10 to 11-12:** the scheduled refresh failed on an unmapped footnote (fixed by #1901).
- **2026-11-17:** upstream removed the page's Endpoints table (00:30Z) and restored the Privacy table without its training column (00:34Z). At 13:13Z it changed Gemini 4 Argon from 0 to 55 days retention. The scheduled refreshes failed on 11-17, 11-18 and 11-19 (#1973), so the committed snapshot still marked Argon zero-retention.
- **2026-11-19:** the cliproxy deploy at 00:50Z applied 20 eligible models, Argon among them. #1976 marked Argon not zero-retention. The deploy that followed (06:16Z) applied 19. The proxy offered Argon for about 41 hours after the upstream page said 55 days. Containment took effect at the gated deploy, not at the merge of #1976.
- **Not established:** whether any request used Argon in that window. The proxy's container log does not record model names, and the container was recreated later that day. The authoritative record is the provider's usage view for the account.

## Known limits

- Prose that restricts a model without naming it is not detected, and prose outside the sections the parser reads is not inspected. Read the page diff in the PR's compare link for new sentences.
- The two sources are read at different moments: the page at a pinned commit, the live list at refresh time. The snapshot records only the page commit.
- A reworded informational sentence fails the refresh.
- A list or table of usage notices with no blank lines between items is one paragraph. It names several models, so it fails the refresh.
- A paragraph that names one model but carries a restriction meant for another, unnamed one, is attributed to the named model.

## Why This Matters

- Prose has no schema. Without fail-closed parsing, a reworded sentence makes a model look safe by omission.
- A failed refresh keeps serving the last reviewed snapshot, which is wrong exactly when upstream has tightened a term.
- Without pinned fixtures, every legitimate refresh breaks CI, or the tests quietly stop checking anything.
- Without a PR, a privacy change reaches production with no human reading the upstream table.
- An agreement that expires between deploys keeps the model served until the next deploy. The monitor's eligibility check is what tells the operator; it does not remove the model.

## When to Apply

- Any exposure decision that depends on third-party terms: retention, training, regions, contract dates.
- Any parser of third-party markup that feeds a security or privacy gate.
- Any committed data file that an automated job rewrites and that tests also read.

## Examples

- Reviewing a refresh PR: open the compare link, check each Added, Removed and Changed model against the table in that diff, and check every new model for zero retention, no training, no region requirement and any agreement expiry.
- Stopping exposure before a PR can merge: send the field-scoped PATCH from "Emergency disable without a deploy" in `docs/runbooks/cliproxy-opencode-go.md`, then set `enabled` to false in a PR.

## Related

- `docs/runbooks/cliproxy-opencode-go.md` — "Snapshot refresh PR review", "The scheduled refresh is failing" and "Limitations".
- `docs/solutions/integration-issues/opencode-go-through-cliproxy-session-header-billing-source-2026-11-05.md` — routing, billing signal and key scope for the same entry.
- `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md` — guards on the whole-section write that applies the eligible list.
- `docs/solutions/best-practices/upstream-data-file-download-not-checkout-bun-test-discovery-2026-11-04.md` — the same download-one-file-not-checkout approach.
- `apps/cliproxy/AGENTS.md` — "OPENCODE GO UPSTREAM".
