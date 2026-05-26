---
"@marcusrbrown/infra": minor
---

Add per-repo OpenAI provider opt-in to `cliproxy setup --harness opencode`.

The wizard now supports a provider multiselect (anthropic pre-checked; openai opt-in) interactively, and a `--providers anthropic,openai` flag plus `--model openai/gpt-5.4-mini` non-interactively. Selected providers determine the entries in OPENCODE_CONFIG and OPENCODE_AUTH_JSON. Anthropic-only flows are byte-identical to today (no opt-in needed). Adds `--force` (required for destructive overwrite in non-interactive mode), `--dry-run` (preview planned secrets without mutating), and `--verify-smoke` (post-mutation smoke test with bounded poll + env-gate detection).

Auth-json shape source-verified against `fro-bot/agent@v0.44.3+`: `{type: "api", key: "<proxy-key>"}` per provider, same proxy key for both providers, no `enable-omo: true` required for proxy-routed OpenAI.
