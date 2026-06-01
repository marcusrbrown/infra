---
'@marcusrbrown/infra': patch
---

`cliproxy setup --harness opencode` no longer writes the `OMO_PROVIDERS` secret. Proxy routing is driven entirely by the `OPENCODE_CONFIG` provider `baseURL`, so `OMO_PROVIDERS` was vestigial; the workflow analyzer also no longer flags repos that omit `omo-providers` from their Fro Bot workflow.
