---
'@marcusrbrown/infra': patch
---

`gateway status` shows the workspace memory limit and usage, its out-of-memory kill count, restart count, and the OpenCode supervisor state. `gateway status --json` prints `{ok, services, workspace}`, and `status --json` adds a structured `gateway.workspace` field.
