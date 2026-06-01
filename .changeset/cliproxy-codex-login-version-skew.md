---
"@marcusrbrown/infra": patch
---

`cliproxy login codex` now surfaces a clear error when the remote CLIProxyAPI binary predates `--codex-device-login` support (requires v6.10.9+), pointing to a new provider-version-skew runbook instead of a cryptic SSH exit code.
