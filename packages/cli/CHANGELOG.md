# @marcusrbrown/infra

## 0.3.0
### Minor Changes


- Add CLIProxyAPI deployment and management support ([#35](https://github.com/marcusrbrown/infra/pull/35))
  
  - New CLI commands: `cliproxy status`, `cliproxy deploy`, `cliproxy config get/set`, `cliproxy keys list/add/remove`, `cliproxy login`
  - Docker Compose deployment to DigitalOcean with Caddy TLS
  - Management API integration for config, API keys, and usage stats
  - GitHub Actions deploy workflow with `cliproxy` environment
  - MCP bridge auto-exposes all new commands as tools

## 0.2.0
### Minor Changes


- Add test infrastructure and fix --dry-run behavior ([#29](https://github.com/marcusrbrown/infra/pull/29))
  
  - First test suite: 35 tests across CLI commands, build pipeline, deploy contracts, and status checks
  - Wire Bun's built-in test runner into CI as a parallel job alongside lint and type-check
  - Fix `--dry-run` to print the deploy plan without requiring build artifacts or environment setup
  - Export internal functions with path-override parameters for testability
  - Add `import.meta.main` guard on `build.ts` for safe test imports

## 0.1.0
### Minor Changes


- First release of the infrastructure CLI with keeweb status, deploy, and MCP bridge commands ([#15](https://github.com/marcusrbrown/infra/pull/15))
