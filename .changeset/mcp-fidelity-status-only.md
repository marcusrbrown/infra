---
"@marcusrbrown/infra": minor
---

MCP server now returns the same formatted output operators see at the terminal, instead of empty content. The change refactors the 10 read-style commands (`gateway status`, `gateway backup`, `cliproxy status`, `cliproxy keys list/add/remove`, `cliproxy config get/set`, `keeweb status`, and the unified `status` dashboard) to route output through goke's per-action execution context, so `@goke/mcp` captures it into the `CallToolResult`.

Two commands (`cliproxy keys list` and `cliproxy config get`) additionally return parseable structured data alongside the formatted text — MCP consumers receive both blocks, so agents can act on the data without re-parsing the formatted output.

The 9 CLI-only commands (deploys, gateway logs, gateway restore, cliproxy login/open/setup, keeweb open) are deliberately excluded from MCP via an explicit `commandFilter` allowlist in `mcp.ts`. Each exclusion has a one-line reason in the source — subprocess streaming deferred to MCP v2 (#291), TTY requirements, destructive policy (#292), and host-machine side effects.

`packages/cli/AGENTS.md` documents the full MCP fidelity contract: allowlist authority, ctx threading rules, Mode C eligibility criteria, the Tier-1+Tier-2 test bar, and `@goke/mcp` upgrade discipline (pre-1.0 means manual review).
