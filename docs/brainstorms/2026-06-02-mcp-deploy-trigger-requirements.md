# MCP deploy-trigger tools — Requirements

**Status:** Draft
**Date:** 2026-06-02
**Supersedes framing of:** issue #291 (originally "MCP v2: subprocess streaming for deploys and logs")

## Problem

Issue #291 was filed to expose deploys and `gateway logs` through MCP, framed as a "subprocess streaming" problem (the deploy/logs commands use `Bun.spawn({stdout: 'inherit'})`, which `@goke/mcp` cannot capture). Research against the actual harness invalidated that framing:

- **OpenCode does not surface MCP progress mid-call.** Verified in `anomalyco/opencode@1.15.13` + `@modelcontextprotocol/sdk@1.27.1`: OpenCode passes no `onprogress` callback and no `progressToken`, so the model is blocked until the final one-shot `CallToolResult`. Streaming progress to the agent is impossible in this client; `resetTimeoutOnProgress` is inert, and the default `tools/call` timeout is 60s.
- **`gateway logs` is secret-laden.** `packages/cli/src/commands/gateway/logs.ts` warns its output "may contain Discord tokens, S3 credentials, or user data" — the same exposure rationale that keeps `umami logs` CLI-only. It must not go on MCP.
- **The deploys' default path needs no streaming.** Remote (non-`--local`) deploy is a `gh workflow run` dispatch that returns in seconds — far under the 60s MCP timeout. Only `--local` deploys are long-running, and those require operator SSH keys absent from an agent context.

So the only coherent capability left is a **deploy-trigger**: let an agent *request* a deploy (dispatch the workflow); the deploy itself still requires human approval at the GitHub Environment gate.

## Goal

Expose `gateway deploy`, `cliproxy deploy`, and `keeweb deploy` as MCP tools that **trigger the remote deploy workflow only** (`gh workflow run`), returning the dispatch result. Every triggered deploy remains gated by its existing GitHub Environment required-reviewer approval — the agent proposes, the operator approves.

## Non-goals

- **No subprocess streaming / progress channel.** Impossible in OpenCode today; buffer-then-emit of the fast dispatch result is the only shape and is sufficient.
- **No `--local` deploys via MCP.** Local mode needs operator SSH keys, runs long, and bypasses the environment gate. Not exposed.
- **No destructive flags via MCP.** `--force-config` (wipes cliproxy API keys), `--force-recreate`, and `--nginx` are not passed by the MCP tools. **Caveat (verified):** `deploy-keeweb.yaml` runs the nginx step on *any* `workflow_dispatch` (line 98-102: `github.event_name == 'workflow_dispatch'`), with no input gate — so `gh workflow run "Deploy KeeWeb"` deploys nginx regardless of the CLI flag. keeweb cannot be a content-only trigger tool until that workflow is changed to gate nginx behind a `workflow_call`-style input the MCP path never sets (see R7). cliproxy/gateway `workflow_dispatch` accept no inputs, so they have no equivalent hole.
- **No logs on MCP.** `gateway logs` and `umami logs` stay CLI-only (secret exposure). `umami deploy` likewise stays CLI-only — it already is, by existing policy.
- **No new approval/token machinery.** The GitHub Environment gate is the approval mechanism; this is the recalibrated concern of the paired issue #292.

## Requirements

- **R1 — Trigger-only surface.** The MCP-exposed deploy tools invoke the remote `gh workflow run` path exclusively. The `--local`, `--force-config`, `--force-recreate`, and `--nginx` flags must not be invokable through MCP.
- **R2 — Environment gate preserved.** A triggered deploy must still land on its GitHub Environment (`gateway`/`cliproxy`/`keeweb`) required-reviewer gate. The tool returns the dispatched workflow URL and a clear "awaiting environment approval" signal; it does not and cannot complete the deploy autonomously.
- **R3 — Result capture.** The dispatch result (success/failure of `gh workflow run` and the workflow URL) is returned in the final `CallToolResult` via the existing `ctx`-capture path (Mode A/C), not `Bun.spawn({stdout: 'inherit'})`.
- **R4 — `umami deploy` parity decision.** Either include `umami deploy` as a fourth trigger tool (same gate applies) or document why it stays excluded. Resolve during planning; default leaning is to include it for symmetry since the safety model is identical.
- **R5 — Allowlist + drift guard.** The included deploy tools move into `MCP_ALLOWLIST`; the existing conventions drift-guard test is updated so the allowlist and `opencode.jsonc` stay consistent. **These are mutating tools, not read-safe** — they request a state change (a deploy) even though the change doesn't complete until the operator approves the environment gate. The drift-guard must classify them as mutating-but-environment-gated, a distinct category from both the denied mutating tools (keys/config/backup) and the read-only status tools. The environment gate is an *external* approval control, not a property of the tool contract (see R8).
- **R6 — Logs stay off.** `gateway logs` remains excluded with its secret-exposure rationale intact.
- **R7 — keeweb nginx gate (prerequisite).** Before keeweb is exposed as a trigger tool, `deploy-keeweb.yaml` must gate the nginx step so a plain `workflow_dispatch` is content-only (move nginx behind an explicit input that the MCP path never passes). Until then, keeweb is excluded from the trigger set.
- **R8 — Fail-closed environment binding.** Because the safety model rests on the GitHub Environment gate (an external control that a workflow edit or a future looser environment could remove), the trigger tools should verify the target workflow is still bound to its named required-reviewer environment before dispatch, and fail closed if that binding is absent. At minimum, a test asserts each deploy workflow carries its `environment:` line.

## Success criteria

- An agent can call e.g. `gateway_deploy` via MCP and receive the dispatched workflow URL plus an "awaiting approval" result, without any deploy executing until the operator approves the environment.
- No MCP-reachable path can run a `--local` or force/nginx deploy, or read logs.
- `umami deploy` disposition is explicitly decided and documented.
- Tier-1/Tier-2 MCP tests cover the trigger tools; the drift-guard test passes.

## Open questions (for planning)

1. **Enforcement of trigger-only (R1).** `ActionCtx` carries no "am I in MCP?" signal (verified). So remote-only can't be enforced by context-detection. Options for planning: (a) the MCP tools point at thin trigger-only action variants that have no `--local`/force flags at all; (b) keep one command but make the dangerous flags no-ops/errors when the env indicates a non-TTY/stdio-MCP context; (c) accept that `--local` from an agent fails for lack of SSH keys and gate only the genuinely destructive `--force-config`. Decide in the plan; (a) is the cleanest and most defensible.
2. **`umami deploy` inclusion (R4).**
3. **Operator timeout note.** Even though dispatch is fast, document whether any `mcp.infra.timeout` guidance is warranted (likely not, since no long call occurs).

## References

- Issue: #291 (to be retitled/reframed)
- Paired issue: #292 (mutating-tool approval — recalibrated; deploy-trigger is gated by Environment approval, not new token machinery)
- v1 plan: `docs/plans/2026-05-23-001-feat-mcp-fidelity-status-only-plan.md`
- v1 requirements: `docs/brainstorms/2026-05-23-mcp-fidelity-status-only-requirements.md`
- Deploy commands: `packages/cli/src/commands/{gateway,cliproxy,keeweb}/deploy.ts`
- Logs (stays off MCP): `packages/cli/src/commands/gateway/logs.ts`
- Allowlist + drift guard: `packages/cli/src/commands/mcp.ts`, `packages/cli/src/conventions.test.ts`
- Harness MCP client behavior (verified): `anomalyco/opencode@1.15.13`, `@modelcontextprotocol/sdk@1.27.1` — no mid-call progress; 60s default tool-call timeout
