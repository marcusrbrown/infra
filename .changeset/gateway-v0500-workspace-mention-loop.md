---
'@marcusrbrown/infra': patch
---

Gateway deploy provisions the fro-bot/agent v0.50.0 workspace executor: `gateway deploy` now forwards the workspace OpenCode token, provider auth, model, config, and the Discord trigger-role authorization gate so the `@fro-bot` mention loop and `/fro-bot add-project` cloning work end-to-end. The trigger-role gate is enforced non-empty (fail-closed) and the provider config is JSON-validated before deploy.
