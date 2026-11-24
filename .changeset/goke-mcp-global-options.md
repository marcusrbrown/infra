---
'@marcusrbrown/infra': patch
---

The MCP server now exposes the global `--verbose` option on every tool, coerces tool arguments the way the CLI parses flags, and rejects invalid values with an `InvalidParams` error.
