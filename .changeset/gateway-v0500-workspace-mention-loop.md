---
'@marcusrbrown/infra': patch
---

Gateway deploy materializes the fro-bot/agent v0.50.0 workspace executor secrets: `gateway deploy` now forwards the workspace OpenCode token, provider auth, model, config, and the Discord trigger-role authorization gate. The trigger-role gate is enforced non-empty (fail-closed) and the provider config is JSON-validated before deploy. The gateway daemon remains pinned at v0.46.3 pending upstream fro-bot/agent#738, so the v0.50.0 mention loop and `/fro-bot add-project` cloning are staged but not yet live in production.
