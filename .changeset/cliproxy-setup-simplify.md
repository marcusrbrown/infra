---
'@marcusrbrown/infra': minor
---

`cliproxy setup` is now structured for testability. The action handler is exposed as a named `runSetupCommand` export with a dependency-injectable `RunSetupDeps` shape, and the file was split into focused submodules (`setup/providers.ts`, `setup/prompts.ts`, `setup/templates.ts`, `setup/validation.ts`, `setup/gh.ts`, `setup/workflow-analyzer.ts`, `setup/smoke-test.ts`, `setup/preview.ts`).

New CLI surface:

- `--ack-key-reuse` — required in non-interactive mode when `--key` is supplied for a repo that already has `OPENCODE_AUTH_JSON` set. GitHub's secrets API is write-only, so the CLI cannot verify the supplied bearer token matches the one inside the existing secret; the flag is the operator's explicit acknowledgment. Interactive mode prompts for the same confirmation.
- `--verify-smoke` runs now emit a single `[smoke-test] kind=<kind>` line on stdout so MCP and agent harness consumers can parse the result without log-scraping.

Behavior clarifications:

- `--force` now reads as "overwrite existing GitHub secret values" instead of implying proxy-key rotation. The pre-gate (`confirmDestructiveProviderChange`, renamed from `mustConfirmDestructive`) and the collision-gate throw text both call out that `--force` does NOT rotate the underlying CLIProxyAPI proxy bearer token — that's preserved byte-for-byte when `--key` is supplied.
- `--providers` help text now surfaces the `anthropic` default. `--model` help text now states it's required when multiple providers are selected.
- `/v1/models` response parsing now uses a Zod schema with `passthrough()`; malformed responses surface clearer error messages with the affected JSON paths.

The `packages/cli/AGENTS.md` documentation gains a Migration Recipe section describing the canonical anthropic-only → dual-provider invocation, plus a `shared.ts` convention note for the cliproxy-local management API helpers (`managementHeaders`, `requestJson`) that are now consolidated.
