---
'@marcusrbrown/infra': minor
---

`status --json` now prints a schema-versioned envelope (`{schemaVersion, generatedAt, apps}`) of typed observations and facts per app instead of one flat summary object per app, and the `status` table has the columns App, Reachability, Container, Deploy, End-to-end and Resource; the command's own `--verbose` option was removed because it no longer changes the output.
