---
'@marcusrbrown/infra': minor
---

Add CLIProxyAPI deployment and management support

- New CLI commands: `cliproxy status`, `cliproxy deploy`, `cliproxy config get/set`, `cliproxy keys list/add/remove`, `cliproxy login`
- Docker Compose deployment to DigitalOcean with Caddy TLS
- Management API integration for config, API keys, and usage stats
- GitHub Actions deploy workflow with `cliproxy` environment
- MCP bridge auto-exposes all new commands as tools
