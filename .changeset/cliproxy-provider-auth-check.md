---
"@marcusrbrown/infra": minor
---

Add an upstream provider-auth probe to `cliproxy status`. The new check sends a minimal Anthropic completion through the proxy (via `--api-key` or `CLIPROXY_API_KEY`) and reports an error with a `cliproxy login claude` remediation when the proxy's upstream Claude auth is unavailable — catching expired-OAuth failures that the `/healthz` and management checks miss. Skips gracefully when no downstream API key is configured.
