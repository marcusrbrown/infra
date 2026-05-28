---
'@marcusrbrown/infra': patch
---

`cliproxy setup --verify-smoke` tolerates malformed `gh run list` output.

The smoke test now validates the `gh run list` JSON payloads with a schema before reading them. A malformed or unexpected payload degrades to an `unverified` result instead of throwing or misreading run fields, keeping the wizard's smoke-test step on its existing pass/fail/unverified contract.
