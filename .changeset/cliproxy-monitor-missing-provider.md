---
'@marcusrbrown/infra': patch
---

`cliproxy monitor` and `cliproxy status` now treat an unregistered Anthropic provider (HTTP 400 `model_not_found`) as a dead provider, so a lost Claude credential opens the outage issue and sends the Discord alert.
