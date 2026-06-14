---
"@marcusrbrown/infra": minor
---

Add `cliproxy models [provider]` to list the models CLIProxyAPI serves at `/v1/models`, with an optional provider filter (`anthropic`/`openai`), a `--verbose` mode showing `owned_by` and the model date, and bearer-key auth via `--key`/`CLIPROXY_API_KEY`. Also exposed over MCP as the read-only `cliproxy_models` tool.
