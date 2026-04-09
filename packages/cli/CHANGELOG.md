# @marcusrbrown/infra

## 0.3.6
### Patch Changes


- Harden CLIProxyAPI deployment stability: remove placeholder API key from config template, add Docker restart policies and healthcheck, guard provision script against destructive reruns, add pre-deploy management key validation, switch health gate to self-contained endpoint, add `--output` flag to `cliproxy config get`, and fix management API auth documentation. ([#62](https://github.com/marcusrbrown/infra/pull/62))

## 0.3.5
### Patch Changes


- Fix cliproxy deploy wiping API keys by skipping config.yaml upload when it already exists on server ([#56](https://github.com/marcusrbrown/infra/pull/56))

## 0.3.4
### Patch Changes


- Improve `cliproxy keys add` output with human-readable success message ([#51](https://github.com/marcusrbrown/infra/pull/51))

## 0.3.3
### Patch Changes


- Fix all CLIProxyAPI management API calls against source-verified endpoints ([#48](https://github.com/marcusrbrown/infra/pull/48))
  
  - keys add: send bare JSON array (not `{api_keys: [...]}`)
  - keys list: parse `api-keys` (hyphenated) response key
  - usage stats: read from nested `.usage` object, not top-level
  - config set: use per-field PUT endpoints (`/debug`, `/request-retry`, etc.) with `{"value": <val>}` body
  - version check: parse `latest-version` key from `/v0/management/latest-version`

## 0.3.2
### Patch Changes


- Fix cliproxy login hanging after pasting callback URL ([#45](https://github.com/marcusrbrown/infra/pull/45))
  
  - Allocate TTY with `-tt` so the paste prompt works interactively
  - Remove `BatchMode=yes` which blocks keyboard input
  - Explicitly inherit stdin for the SSH subprocess

## 0.3.1
### Patch Changes


- Fix cliproxy login command and bunx dependency resolution ([#42](https://github.com/marcusrbrown/infra/pull/42))
  
  - Fix `cliproxy login claude` failing with "no configuration file provided" by running docker compose from `/opt/cliproxy/` on the remote host
  - Fix `bunx @marcusrbrown/infra` failing with "Cannot find package 'zod'" by bundling all runtime dependencies in the published tarball

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
