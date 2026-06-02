---
"@marcusrbrown/infra": patch
---

Stop exposing mutating and secret-disclosing commands through the MCP server. `gateway backup`, `cliproxy keys list`, `cliproxy keys add`, `cliproxy keys remove`, `cliproxy config get`, and `cliproxy config set` are no longer registered as MCP tools — they remain available via the direct CLI. This keeps key and secret operations out of reach of autonomous agents while the read-only status tools stay exposed.
