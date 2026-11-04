---
title: "Diagram drift test: a node-keyed fact table, checked in every direction, failing on structure only"
date: 2026-11-04
problem_type: design_pattern
component: testing_framework
severity: medium
module: apps/docs
resolution_type: tooling_addition
symptoms:
  - "Published diagrams could disagree with the repo on compose services, volumes, egress hosts, deploy jobs, gates or runbook steps with nothing failing"
  - "Archify rejects extra properties on components and meta, so a spec cannot cite the fact a node stands for"
  - "Heading anchors computed in a test can differ from the anchors the docs site generates"
tags:
  - diagram-drift
  - archify
  - fact-table
  - docs-site
  - github-slugger
  - heading-anchors
  - test-design
---

# Diagram drift test: a node-keyed fact table, checked in every direction, failing on structure only

## Context

The docs site publishes hand-written Archify specs from `apps/docs/diagrams/`. A compose, workflow, egress or runbook change could leave a public diagram wrong without any check failing. Archify's schemas set `additionalProperties: false` on the spec, `meta` and components. Both `validate` and `deliver` reject a citation field, so the link from a node to its source can't live in the spec.

## Guidance

Keep the mapping in the test (`apps/docs/scripts/diagram-drift.test.ts`). The checker (`apps/docs/scripts/diagram-drift.ts`) compares three sets: spec nodes, table rows, and facts read from the repo.

- **Key facts by `(kind, file, id)`.** The kinds are app, service, volume, egress-host, job, environment and anchor. Putting the file in the key keeps a router job and a callee job with the same id apart. An environment also carries the job that declares it, so moving a gate from the deploy job to `notify` fails.
- **Each node either maps to facts or is illustrative with a reason.** `NodeMapping` is a union of the two shapes. It has no discriminant, so the type does not forbid a value carrying both properties, and the checker treats such a value as illustrative. Every spec that `discoverSpecs` renders needs a table entry. A diagram that is excluded gets an out-of-scope entry with a reason.
- **Not-drawn facts are a separate per-diagram list, each with a reason.** `NotDrawnKind` excludes egress hosts and anchors, so a well-typed table can't list either as not drawn. The checker reports any in-scope egress host that no node claims. The allowlist is the security property the gateway diagram exists to show.
- **Check every direction:**
  - A fact that is neither mapped nor listed as not drawn.
  - A mapped fact that no longer exists.
  - A spec node missing from the table.
  - A table row whose node is gone from the spec.
  - A fact claimed by two nodes, a fact both mapped and not drawn, a duplicate node id, or a not-drawn entry for a fact that vanished.
- **Only anchors may be shared.** Several runbook steps can map to one heading. Any other fact belongs to one node. When several nodes depict parts of one service, one claims it and the rest are illustrative.
- **Read gateway facts from both sources, tagged by origin.** They come from the upstream compose at the pinned ref plus `buildComposeOverride` run with the production configuration. A service declared only by the override is a separate override fact, so it must be mapped with its override source or listed as not drawn. After an upstream rename, the old name left in the override needs one of those, and can't pass silently. Egress hosts come from constants exported by `apps/gateway/src/deploy.ts`.
- **Fail closed per source.** Readers throw `SourceError`. `readRepoFacts` records it and keeps reading independent sources, and the checker reports the error for every diagram that depends on that source. A broken router workflow also hides its callee workflows. An empty parse or an `include:` fails rather than reading as zero facts.
- **Don't check what churns.** Labels, card text, image tags, digests and action pins are not facts, so digest bumps stay green. Network membership is out of scope.

## Heading anchors must match the site

A runbook map points at heading anchors, so `parseRunbookAnchors` slugs headings the same way the site does:

- Use `github-slugger`, declared as an `apps/docs` dependency. Bun's isolated linker can't import the copy Astro pulls in transitively.
- Create one slugger per document, so duplicate headings get the same `-1`, `-2` suffixes as on the site.
- Never anchor the first H1. `generate-content.ts` moves it into frontmatter as the page title.
- Skip frontmatter, fenced blocks (backtick and tilde fences, each closed only by a matching or longer fence) and `<!-- -->` blocks.
- Strip code spans, emphasis and link syntax before slugging.
- Mark a heading that contains `<` or `&` outside inline code as unmappable, because its slug on the site can differ. A node mapped to an unmappable heading fails.

## Why This Matters

Structural facts change rarely but mislead when they're wrong: an added egress host, a renamed service, a moved approval gate. With keyed facts and a node-keyed table, every finding names the diagram, the node or fact, and the direction, so the fix goes into the PR that caused the drift.

## When to Apply

- A published diagram or map depends on compose files, workflows, an allowlist or doc headings.
- The diagram format has a strict schema that can't carry references.
- A depicted fact is security-relevant and must be drawn, not just mentioned.

## Examples

A table entry mixes mapped and illustrative nodes (abbreviated):

```ts
nodes: {
  gateway: maps(gatewayFact.upstreamService('gateway')),
  state: illustrative('Object storage is set by environment values, not by the compose files.'),
}
```

Fixture tests prove the checker, but not the real table's coverage scopes. To pin those, inject one extra fact into the real repo facts and require exactly one finding. `the real table catches an undrawn fact` does this for:

- an extra egress host;
- an extra upstream gateway service;
- an extra umami compose service.

If any of those scopes is dropped from the table, its test fails.

## Related

- [Download one upstream data file instead of checking out upstream source](upstream-data-file-download-not-checkout-bun-test-discovery-2026-11-04.md)
- `apps/docs/AGENTS.md` (diagram drift check: updating the table)
- `docs/plans/2026-11-03-001-feat-diagram-drift-detection-plan.md`
- `docs/brainstorms/2026-11-03-diagram-drift-detection-requirements.md`
