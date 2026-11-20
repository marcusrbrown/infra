---
'@marcusrbrown/infra': minor
---

Add the `traces` command group for the trace collection stack: `status`, `logs`, `open` (SSH tunnel to Langfuse and Grafana), `ingest hold|open|status`, `deploy`, and `sender add|list|revoke` for sender tokens. `infra status` gains a `traces` row. Only `traces status` is exposed as an MCP tool.
