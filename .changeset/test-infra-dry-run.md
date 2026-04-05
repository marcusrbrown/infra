---
'@marcusrbrown/infra': minor
---

Add test infrastructure and fix --dry-run behavior

- First test suite: 35 tests across CLI commands, build pipeline, deploy contracts, and status checks
- Wire Bun's built-in test runner into CI as a parallel job alongside lint and type-check
- Fix `--dry-run` to print the deploy plan without requiring build artifacts or environment setup
- Export internal functions with path-override parameters for testability
- Add `import.meta.main` guard on `build.ts` for safe test imports
