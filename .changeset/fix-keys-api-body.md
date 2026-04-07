---
'@marcusrbrown/infra': patch
---

Fix all CLIProxyAPI management API calls against source-verified endpoints

- keys add: send bare JSON array (not `{api_keys: [...]}`)
- keys list: parse `api-keys` (hyphenated) response key
- usage stats: read from nested `.usage` object, not top-level
- config set: use per-field PUT endpoints (`/debug`, `/request-retry`, etc.) with `{"value": <val>}` body
- version check: parse `latest-version` key from `/v0/management/latest-version`
