---
'@marcusrbrown/infra': patch
---

Harden MCP-exposed status tools against parameter-driven secret redirection.

Three independent vectors were addressed:

- **cliproxy status**: ambient `CLIPROXY_MANAGEMENT_KEY` no longer follows an
  agent-supplied `--url` to a non-trusted host. The ambient key is only forwarded
  when the resolved base URL matches the configured/default trusted URL. Explicit
  `--key` is always honored regardless of URL.

- **gateway status / umami status**: SSH error messages now redact the resolved
  host value before returning. An agent passing `--key=SOME_SECRET` would cause
  the secret value to be the SSH target; if SSH failed, the raw value previously
  appeared in the error string. It is now replaced with `<host>`.

- **gateway/host.ts and umami/host.ts**: validation error messages no longer echo
  any portion of the rejected value, preventing partial secret disclosure through
  error propagation.

All fixes are universal — behavior is identical for CLI operator use and MCP/agent
invocation.
