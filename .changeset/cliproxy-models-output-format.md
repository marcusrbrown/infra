---
"@marcusrbrown/infra": patch
---

`cliproxy models` now prints `provider/id` (e.g. `anthropic/claude-opus-4-8`), grouped by provider and sorted by model date ascending, matching `opencode models`. `--verbose` emits a single JSON array (`id`, `provider`, `raw_id`, `created`) instead of aligned columns, so it can be piped to `jq`.
