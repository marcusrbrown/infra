---
'@marcusrbrown/infra': minor
---

Add `opencode-go` as a provider for `agent setup` and `cliproxy setup`, and as a filter for `cliproxy models`. A repo opts in with `--providers anthropic,opencode-go --model opencode-go/<id>`: setup writes the `opencode-go` proxy base URL and an `opencode-go` auth entry that reuses the repo's proxy key, and verifies the model is exposed under `owned_by: opencode-go` (the bare or `opencode-go/`-prefixed id both count), pointing at the cliproxy deploy when it is not. `cliproxy models opencode-go` lists the Go models once each.
