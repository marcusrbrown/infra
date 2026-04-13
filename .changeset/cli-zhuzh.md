---
'@marcusrbrown/infra': minor
---

feat(cli): restructure commands, add status dashboard, setup wizard, and open commands

Restructured CLI from flat `<app>-<action>.ts` to `<app>/<action>.ts` with barrel
index files. Added 4 new commands: `keeweb open` (browser launcher with headless
fallback), `cliproxy open` (TUI via SSH), top-level `status` (unified parallel
health check dashboard with `--json`), and `cliproxy setup` (interactive onboarding
wizard using `@clack/prompts`). Polished management output: `keys list` defaults to
numbered list, `config get` to aligned key:value format, `status` appends usage summary.
