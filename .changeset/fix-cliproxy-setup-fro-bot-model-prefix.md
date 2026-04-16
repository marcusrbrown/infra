---
'@marcusrbrown/infra': patch
---

Fix `cliproxy setup` wizard to default `FRO_BOT_MODEL` to `anthropic/claude-sonnet-4-6`
instead of the unprefixed `claude-sonnet-4-6`. OpenCode requires provider-qualified model
identifiers. Added regression tests that lock in the provider prefix, the `OMO_PROVIDERS`
value, the `OPENCODE_CONFIG` baseURL `/v1` suffix, and the `OPENCODE_AUTH_JSON` shape so
the same default drift cannot recur silently.
