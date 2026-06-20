---
"@marcusrbrown/infra": patch
---

Apply CLIProxyAPI model aliases on deploy so harnesses can use short Anthropic model ids (e.g. `claude-sonnet-4-5`) that resolve to the dated upstream models, and consolidate the cliproxy management helpers into the shared package.
