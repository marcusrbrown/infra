---
"@marcusrbrown/infra": patch
---

Gateway deploy materializes GitHub App credentials (`github-app-id`, `github-app-private-key`) plus the optional `discord-privileged-intents` file, and `gateway deploy --local` forwards the corresponding env vars. Updates the gateway daemon pin to `fro-bot/agent` v0.46.1, enabling the `/fro-bot add-project` repository-onboarding command.
