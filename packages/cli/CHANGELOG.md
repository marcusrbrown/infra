# @marcusrbrown/infra

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
