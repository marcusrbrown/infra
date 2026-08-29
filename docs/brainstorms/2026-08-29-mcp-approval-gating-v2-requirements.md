---
date: 2026-08-29
topic: mcp-approval-gating-v2
---

# MCP Approval Gating for Mutating Tools (v2) — Decision Record

## Summary

MCP stays read-only as a permanent design decision, not a deferral. The approval-token mechanism sketched in #292 (short-lived scoped tokens, issuance flow, wrapper verification) will not be built. Per-call approval already exists at stronger layers, and #292 closes with this record.

---

## Problem Frame

The v1 MCP surface (`docs/brainstorms/2026-05-23-mcp-fidelity-status-only-requirements.md`) originally scoped mutating key/config tools into the allowlist; the shipped surface was later tightened to nine read-only commands, with every mutating or secret-bearing command source-gated out by two enforced layers (`MCP_ALLOWLIST` exclusion in `packages/cli/src/commands/mcp.ts` plus `opencode.jsonc` permission deny, asserted by `packages/cli/src/conventions.test.ts`). Issue #292 parked the v2 question — whether an MCP-layer approval channel should ever re-admit mutations — behind two triggers: a real agent mutation need, or a third-party MCP client becoming a primary consumer. Neither trigger fired. Re-evaluated 2026-08-29 with the conclusion below.

---

## Key Decisions

- **MCP remains read-only permanently.** For any MCP client, the enforcement boundary is the surface itself: `MCP_ALLOWLIST` exposes no mutating tool, with the `opencode.jsonc` deny layer as a harness-side backstop. Approval for mutations lives in the layers that already exist:
  1. Harness permission layer (client-specific to opencode-based agents, not MCP-level enforcement) — an agent invoking a mutating CLI command through bash gets the harness's native per-call `ask` approval, which shows the operator the exact command. A token gate cannot match that fidelity.
  2. GitHub Environment gates — every deploy holds at a per-app required-reviewer approval.
  3. TTY-interactivity — destructive and credential-bearing flows (`cliproxy login`, `gateway restore`) require a terminal and explicit local invocation.
- **No approval-token mechanism.** A scoped, short-lived token would add real properties — narrower blast radius, expiry, an auditable approval trail — and they still do not justify building it: a token verified by `mcp.ts` wrappers would live in the same environment as `CLIPROXY_MANAGEMENT_KEY`, so for a headless consumer approval collapses into possession of that environment, and mutation audit already exists at the management-API and deploy-workflow layers. The carrying cost (issuance flow, rotation, expiry and scope tests) buys no gate those layers do not already provide.
- **Headless approval is the workflow-run approval.** For CI agent flows, the human who approved the workflow run or Environment gate is the approval. Documenting this replaces building a second, weaker gate that the issue itself predicted would become ceremony.
- **`gateway restore` stays permanently excluded from MCP.** CA replacement is a backup-file-in-hand operator action; no token scheme changes its risk profile.
- **#291 closes under this record.** Deploy-trigger MCP exposure (`gateway deploy`, `cliproxy deploy`, `keeweb deploy`) is governed by the same policy: deploys stay CLI-triggered behind their per-app Environment gates, which already provide the approval an MCP layer would duplicate.
- **Mutations-as-Git-artifacts is the sanctioned road.** When a future agent flow genuinely needs a state change, prefer expressing it as a reviewable tracked-file change flowing through existing approval machinery (the brokered-push and Environment-gate pattern) over a gated RPC.

---

## Scope Boundaries

- No new MCP tools; no wrapper machinery, token issuance CLI, or JWT dependencies.
- The CLI surface is unchanged — mutating commands remain CLI-only with their existing gates.
- Revisit if a mutation need emerges that cannot be expressed as either a harness-approved CLI invocation or a Git-artifact change, or if a non-harness MCP client (one without the `opencode.jsonc` permission layer) becomes a primary consumer needing mutations. A fresh brainstorm starts from that consumer's actual shape, not from this record's rejected sketch.

---

## Success Criteria

- `conventions.test.ts` continues to enforce the two-layer exclusion for every sensitive command; no carve-outs added.
- #292 is closed referencing this record.
- #291 is closed referencing this record.
- `mcp.ts`'s exclusion comment cites this decision rather than a pending prerequisite.
