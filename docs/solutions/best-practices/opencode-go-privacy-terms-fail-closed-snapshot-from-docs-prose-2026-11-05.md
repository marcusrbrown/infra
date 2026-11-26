---
title: "OpenCode Go privacy terms: a fail-closed snapshot built from two sources, a review PR and fixture-pinned tests"
date: 2026-11-05
last_updated: 2026-11-26
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

The cliproxy deploy must expose only OpenCode Go models that keep no data, never train on it and are not region-gated. A model is region-gated when either source says its availability depends on region: countries refused, availability limited to permitted regions, a stated hosting location, or a workspace Global-region requirement. Two upstream sources carry these terms, and neither carries all of them:

- **The public Go model list** (`GO_LIVE_MODELS_URL` in `packages/shared/opencode-go/live-models.ts`): per model, a `go` object with three booleans: `training`, `zdr` (zero data retention) and `limited_regions` (some countries are refused).
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
- **Page only:** retention days, the agreement expiry date and the Global-region rule. The list's `limited_regions` is a different fact. A fact only one source can state is not a disagreement; where both state a fact and differ, the PR body lists the model and fact.
- **Check the page before calling a fact API-only.** Beam Free's region limit was first treated as API-only, but the page states it in a usage notice. With the list flipped to `limited_regions: false`, the builder wrote `regionGated: false` and reported nothing. The parser now reads the notice.
- **Join by normalized name** (case, whitespace, hyphens) plus the reviewed `DOCS_NAME_ALIASES` map in `model-names.ts`, never by prefix: `Hy4` is a prefix of `Hy4 preview` and `Hy4 flash Free`.

### Fail closed on anything unrecognised in the page

A row, column, marker, footnote sentence, label or rule the parser cannot map throws `PrivacyTableError`. A format change upstream stops the refresh instead of marking a model safe by accident.

- **Whole sentences and names.** A footnote sentence must match one known form from its first character to its last. A "starts with" or "contains" branch discards the rest of the sentence: `Requests are retained for 0 days, and permission to use your prompts … is granted.` read as plain retention. A label resolves by exact normalized name or a reviewed group, never by prefix or suffix. The one exception is a footnote whose whole label is a single name that is no row and no reviewed group. The parser returns it unread as an orphan footnote, and `buildSnapshot` accepts it only when the label exactly names a live model (the join's own name match, including its reviewed aliases) that no Privacy row claims. The footnote's text must also name no Privacy-table model, family label or alias, by the same check as unstructured prose, because the orphan text is never read as a rule and a restriction on a row would otherwise be dropped. That model is left out and reported as `footnote only, no Privacy row`; a footnote never adds a model, and never relaxes one. Any other such label throws the same `does not name a model` error: a name that is no live model, a label for a model that has a row, or a list (`A / B`, `A and B`) in which any name fails. The restricted-models bullets and usage notices have no such exception.
- **Unstructured prose.** Prose that names a Privacy-table model, in the restricted-models section or before the table, throws. Prose that restricts a model without naming it cannot be detected.
- **Bullets are strict.** `bulletsOf` requires this exact shape for every list item it sees:

  <!-- prettier-ignore -->
  ```ts
  const match = /^- \*\*([^*]+):\*\* (.+)$/.exec(line)
  ```

  An item that does not match throws. `- **Label**: text` (colon outside the bold) is still a list item, so it throws instead of silently dropping a region gate.

- **Linear time.** CodeQL flagged three polynomial-backtracking patterns over page text. They were rewritten as linear patterns and plain string splits, and any new pattern over page text must be linear.

### A failed refresh is itself a failure mode

A refresh that throws leaves the committed snapshot in place, and the deploy keeps applying it. If the same upstream change tightened a term, the snapshot is wrong in the unsafe direction until the parser is fixed. Throw only when the input as a whole is wrong: an unrecognised page structure, a changed response shape, an ambiguous join, a join that pairs nothing, a model list in which no entry has a `go` object, or more than half of the entries lack one. Missing evidence for one model excludes that model (`not-in-snapshot`) and is reported in the workflow log and the PR body. That covers a model only one source knows and a model the list returns with no `go` object. A missing `go` object is never read as three permissive values.

A first version threw when only one source knew a model. A new list model with no page row, arriving with a new restriction on an exposed model, blocked the refresh and left the restricted model eligible.

A Privacy footnote with no table row is the same failure in another form. A row alias or reviewed group cannot absorb it, because both need a row to point at. The footnote is accepted only when its label names exactly one live model that no row claims; otherwise the refresh throws (`buildSnapshot`, `packages/shared/opencode-go/build-snapshot.ts:185-190`). That model is left out and reported. The footnote's text still goes through the prose check (`packages/shared/opencode-go/parse-privacy-table.ts:392`), so it cannot silently change another model's terms.

### Attribute by content when markup rules keep multiplying

The Usage limits section holds pricing sentences that change weekly, so it is the one place where unrecognised sentences are tolerated. The rule: recognise availability statements (`Not available in <places>.`), fail on any other availability sentence, and attribute each statement to exactly one recognised name in its paragraph. A name is a Privacy row or a reviewed family label, which limits every row it maps to. A mention strictly inside a longer one is dropped (`Hy4 preview` is not also `Hy4`); overlapping or tied mentions each count, so unclear text fails. `applyUsageNotices` holds the exact paragraph and sentence boundaries.

The rule replaced parsing the `**Model:**` label. Three review rounds each found Markdown that defeated it (the wrong section; `**Beam Free**:` with the colon outside the bold; a hard line break that glued an unreadable label line onto a `**GLM-5.3:**` paragraph, so the restriction landed on GLM-5.3 and Beam was cleared), and each fix added another markup rule. Attribution by the names in the text depends on no markup.

### Resolve reviewed family mappings only where the page uses the label

A reviewed mapping such as `DeepSeek` to several Privacy rows is resolved only when text uses its label. Resolved eagerly, a mapping that named a retired family member blocked the refresh although no page text used the label: the fail-stale failure again, fixed before the redesign merged. Building the name index now resolves nothing, so a retired member throws only when some text uses the label.

### One eligibility function for the deploy, the monitor and the refresh

`computeEligibility` in `eligibility.ts` is the single function all three share. Every exclusion has a named reason, and anything unknown, invalid, expired or not live is excluded, never assumed safe. Region-gated models are never exposed and there is no override. The monitor detects an exposed model that has become ineligible between deploys, including one whose agreement has expired, and flags it `privacy-noncompliant`; it does not remove the model. The next deploy does.

### Refresh by pull request, never by deploy

- **Pin the source by commit.** The refresh resolves the upstream `dev` head, reads the page at exactly that commit and records it, so a change is reviewable through a compare link.
- **Read the repository file, not the site.** The page comes from GitHub's raw-content endpoint, because the docs site terms prohibit crawling.
- **A person reviews term changes.** The workflow opens or updates one PR and auto-merge stays off. The two upstream sources are the evidence, not the parsed JSON, and the more restrictive value wins.
- **Production stays behind the deploy gate.** Merging triggers the gated cliproxy deploy, and a model the PR adds is exposed only after that deploy is approved. The refresh never deploys.

Mechanics: [`.github/workflows/opencode-go-privacy.yaml`](../../../.github/workflows/opencode-go-privacy.yaml) and [Snapshot refresh PR review](../../runbooks/cliproxy-opencode-go.md#snapshot-refresh-pr-review).

### An open restricting PR is an exposure window

A restricting PR does not change the served model list until merge and deploy approval. Notify on restrictions while the PR is open; if no model remains eligible, use the [emergency disable](../../runbooks/cliproxy-opencode-go.md#emergency-disable-without-a-deploy). On 2026-11-25 #2085 restricted two models and sat unnoticed for about 16 hours before it merged; the notice came with #2099.

When the notice links the PR, look it up by same-repository head. `gh pr list --head <branch>` matches the branch name across forks, so filter on `isCrossRepository` as the stale-PR lookup does (`.github/workflows/opencode-go-privacy.yaml:208`).

### Test against pinned fixtures, never against the file the refresh rewrites

- Per-model terms are asserted against pinned fixtures: `__fixtures__/go.mdx`, `__fixtures__/live-models.json` and the snapshot they build, `__fixtures__/go.expected.json`. A privacy refresh rewrites the committed snapshot, so nothing about an individual model may be asserted against that file. The per-model pin that contained Gemini 4 Argon (#1976) became a fixture test.
- Parser failure cases are built by mutating the fixture. The `mutate` helper asserts the replaced text occurs exactly once, so a drifted fixture fails loudly instead of silently testing nothing.
- Tests on the committed files assert invariants only: the snapshot passes the schema, records a 40-hex source commit and leaves at least one model eligible, and re-serializes to identical bytes. The settings test requires that `settings.json` parses whether Go is enabled or disabled, so an emergency-disable PR cannot fail CI by flipping `enabled`.

## Evidence: the snapshot went stale twice in ten days

- **2026-11-10 to 11-12:** the scheduled refresh failed on an unmapped footnote (fixed by #1901).
- **2026-11-17 to 11-19:** on 11-17 upstream removed the page's Endpoints table and its training column, then changed Gemini 4 Argon from 0 to 55 days retention. The scheduled refresh failed from 11-17 to 11-19 (`Endpoints: no table found`, #1973), so the committed snapshot still marked Argon zero-retention and the proxy kept offering it.
- **Exposure:** the proxy offered Argon for about 41 hours after the upstream page said 55 days. #1976 marked Argon not zero-retention; containment took effect at the gated deploy that followed, not at the merge.
- **Not established:** whether any request used Argon in that window. The proxy's container log does not record model names, and the container was recreated later that day. The authoritative record is the provider's usage view for the account.

## Known limits

- Prose that restricts a model without naming it is not detected, and prose outside the sections the parser reads is not inspected. Read the page diff in the PR's compare link for new sentences.
- The two sources are read at different moments: the page at a pinned commit, the live list at refresh time. The snapshot records only the page commit.
- A reworded informational sentence fails the refresh.
- A list or table of usage notices with no blank lines between items is one paragraph. It names several models, so it fails the refresh.
- A paragraph that names one model but carries a restriction meant for another, unnamed one, is attributed to the named model.

## Why This Matters

- Prose has no schema. Without fail-closed parsing, a reworded sentence makes a model look safe by omission.
- Without pinned fixtures, every legitimate refresh breaks CI, or the tests quietly stop checking anything.
- Without a PR, a privacy change reaches production with no human reading the upstream table.

## When to Apply

- Any exposure decision that depends on third-party terms: retention, training, regions, contract dates.
- Any parser of third-party markup that feeds a security or privacy gate.
- Any committed data file that an automated job rewrites and that tests also read.

## Examples

- Reviewing a refresh PR: [Snapshot refresh PR review](../../runbooks/cliproxy-opencode-go.md#snapshot-refresh-pr-review).
- A failing scheduled refresh: [The scheduled refresh is failing](../../runbooks/cliproxy-opencode-go.md#the-scheduled-refresh-is-failing).

## Related

- `docs/runbooks/cliproxy-opencode-go.md` — emergency disable and "Limitations".
- `docs/solutions/integration-issues/opencode-go-through-cliproxy-session-header-billing-source-2026-11-05.md` — routing, billing signal and key scope for the same entry.
- `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md` — guards on the whole-section write that applies the eligible list.
- `docs/solutions/best-practices/upstream-data-file-download-not-checkout-bun-test-discovery-2026-11-04.md` — the same download-one-file-not-checkout approach.
- `apps/cliproxy/AGENTS.md` — "OPENCODE GO UPSTREAM".
- #2085 — the refresh PR that restricted two models and sat unnoticed. #2099 — the restriction notice.
