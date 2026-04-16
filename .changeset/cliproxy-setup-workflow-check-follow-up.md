---
'@marcusrbrown/infra': patch
---

`cliproxy setup --harness opencode` workflow check now handles workflows
with multiple `fro-bot/agent` steps, reports per-step gaps with a step
ordinal, renders the paste snippet at the canonical 10-space indent
(drop-in under the `with:` key), and distinguishes four workflow states
via a discriminated union (`missing` / `unreachable` / `no-agent-step` /
`analyzed`) so the caller can't forget a case. A workflow that exists
but has no `fro-bot/agent` step now surfaces a dedicated warning
("exists but has no `fro-bot/agent` step") instead of the generic
missing-input list. Observation-only — the target repo workflow is
never modified. Addresses Fro Bot's non-blocking concerns from the
PR #125 follow-up review.
