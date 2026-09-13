---
title: Verify delegated findings against primary source, not against their reasoning
date: 2026-09-12
category: docs/solutions/workflow-issues
module: infra
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - 'A report claims a contradiction, root cause, or verified fact you did not check yourself'
  - 'A claim depends on release history, issue text, tag state, or upstream source'
  - 'A refactor extracted a helper that call sites previously guarded inline'
  - 'A conclusion will be written into docs or a pinned dependency'
tags:
  - verification
  - primary-source
  - supply-chain
  - pinning
  - code-review
  - refactor-regression
  - github-actions
---

# Verify delegated findings against primary source, not against their reasoning

## Context

Over one session, six confidently-stated findings turned out to be wrong. Their reasoning was mostly sound — the conclusions still failed. Every one was caught the same way: by opening the authoritative artifact instead of evaluating the argument.

Two would have shipped regressions. One was a scanner pinned to a commit inside the supply-chain compromise window it was chosen to avoid.

The habit that catches this is cheap. The failure mode is that a well-argued wrong answer reads exactly like a well-argued right one.

## Guidance

**Check the conclusion, not the argument.** Re-read the file, issue, tag, or commit that decides the claim. A plausible chain of steps is not evidence.

**A valid signature proves authorship, not safety.** Signature verification cannot tell you the upstream project was compromised when the commit was made.

**Place security artifacts on the incident timeline.** "Older, therefore predates the hijack" is backwards reasoning when the initial compromise predates the version you picked. Get the commit date and compare it to the disclosed window.

**Prefer exclusion over verification.** If a digest-pinned equivalent exists, remove the component from the trust path instead of auditing it.

**Require per-claim verdicts from research.** Every sub-claim resolves to `confirmed`, `rejected`, or `no evidence found`. Unsupported claims blend into a mostly-correct report unless the format forces them out.

**Scope searches to the whole decision surface.** "No code depends on this" is not "nothing depends on this." Documentation, runbooks, and workflow files encode the same contracts.

**After extracting a helper, diff the guards.** Call sites that previously checked an error condition inline will silently stop checking it if the new return value is partially destructured.

**Evaluate escapes and interpolation at runtime.** Reading a template literal does not tell you what string it produces.

## Why This Matters

The cost is asymmetric. Most wrong findings waste a few minutes. A wrong pin in a job that holds registry push credentials is a supply-chain regression, and a dropped guard in a credential-rotation path silently restores the failure the change existed to remove.

Documentation drift compounds the same way: a stale operational claim is acted on during an incident, when nobody is re-deriving it from source.

## When to Apply

- Acting on a reported contradiction, drift claim, or root cause you have not personally checked
- Pinning or bumping any third-party action, image, or dependency with a disclosed incident history
- Reviewing a refactor that introduced a shared helper
- Building shell commands from template literals
- Accepting a search result as proof that nothing references something

## Examples

### Confirm the artifact actually says what the report claims

```bash
gh issue view 238 --repo fro-bot/dashboard
# → feat(push): publish public operator push privacy policy
```

A reported "wrong blocker reference" was correct; the cited line described push readiness, not the feature the report assumed.

### Dereference tags before trusting a version-to-commit mapping

Annotated tags resolve to a tag object, not a commit. Skipping the check returns a confusing `422`:

```bash
gh api repos/OWNER/REPO/git/ref/tags/v0.36.0 --jq '"\(.object.type) \(.object.sha)"'
# → tag a9c7b0f0...        (NOT a commit sha)

gh api repos/OWNER/REPO/commits/a9c7b0f0... 
# → HTTP 422: No commit found for SHA

gh api repos/OWNER/REPO/git/tags/a9c7b0f0... --jq '.object.sha'
# → ed142fd0...            (the real commit)
```

### Compare the commit date against the disclosed incident window

```bash
gh api repos/OWNER/REPO/commits/<sha> \
  --jq '"date=\(.commit.author.date) verified=\(.commit.verification.verified)"'
```

For `aquasecurity/trivy-action` (GHSA-69fq-xp46-6x23):

| Date | Event |
| --- | --- |
| 2026-02-28 | Initial compromise |
| 2026-03-04 | `v0.35.0` — **inside the window** |
| 2026-03-19/20 | 76 of 77 tags force-pushed to credential-stealing malware |
| 2026-04-22 | `v0.36.0` — post-remediation |

Both commits return `verified: true`. Signature checking does not separate them; the timeline does. A secondary signal: the pre-incident tag was lightweight while the post-remediation tag was annotated, consistent with tag restoration.

### Resolve the digest yourself rather than accepting a supplied one

```bash
IMG=aquasecurity/trivy; TAG=0.74.0
TOKEN=$(curl -sS "https://ghcr.io/token?scope=repository:${IMG}:pull&service=ghcr.io" \
  | bun -e 'const d=await Bun.stdin.json();console.log(d.token)')
curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://ghcr.io/v2/${IMG}/manifests/${TAG}" \
  | tr -d '\r' | awk -F': ' '/^[Dd]ocker-[Cc]ontent-[Dd]igest/{print $2}'
```

The fix was to drop the action entirely and run the scanner as a digest-pinned container — which also matches this repo's existing convention for every other image.

### Diff the guards after a helper extraction

A shared probe returning `{exitCode, status, body}` was consumed at three call sites. Two destructured only `{status, body}`, dropping a pre-existing transport check:

```ts
// Lost in the refactor — restored after review
if (exitCode !== 0 && exitCode !== 22) {
  throw new Error(`Cannot reach service to verify rotation (exit ${exitCode}).`)
}
```

It still failed closed by accident, because empty stdout parsed as an unknown status. Accidental correctness in a credential-verification path is not correctness.

### Evaluate the string, do not read it

```bash
bun -e "const cmd = \`curl -w '\n%{http_code}' ...\`; \
  console.log('raw LF:', cmd.includes(String.fromCharCode(10)))"
# → raw LF: true    ← template literal ate the escape
```

Fix, plus a test asserting command shape — nothing had asserted it before:

```ts
const cmd = String.raw`curl -w '\n%{http_code}' ...`
```

### Scope the search past code

A repo-wide search concluded nothing depended on a changed image tag. It had checked code only; `apps/gateway/AGENTS.md` documented both the tag shape and the job graph, and went stale the moment the workflow changed.

## Related

- [Major-version upstream upgrade playbook](../best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md) — probe the pinned artifact before trusting claims about it
- [Agent S3 key layout diverged from the pinned action's contract](../integration-issues/agent-s3-key-layout-diverged-from-pinned-action-2026-08-03.md) — a version pin is not verification; read the pinned source
- [Off-droplet Docker image build](../best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md) — digest-addressed identity over tags
- [Gateway deploys never rebuilt the image](gateway-deploy-stale-image-2026-05-31.md) — a green deploy can still be stale
- [Reusable workflow permission parity](reusable-workflow-permission-parity-startup-failure-2026-09-01.md) — validate the caller/callee contract at the boundary
- [Brokered push silent bypass](../best-practices/fro-bot-brokered-push-issue-comment-2026-08-28.md) — absence of action is not evidence of absent capability
