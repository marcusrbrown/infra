---
'@marcusrbrown/infra': patch
---

Fix all CLIProxyAPI management API calls against empirically verified endpoints

- keys add: send bare JSON array (not `{api_keys: [...]}`)
- keys list: parse `api-keys` (hyphenated) response key
- usage stats: read from nested `.usage` object, not top-level
- config set: removed (API is read-only; no PUT/POST/PATCH endpoint exists)
- version check: removed (no `/v0/management/latest-version` endpoint exists)
