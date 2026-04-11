---
'@marcusrbrown/infra': patch
---

chore(lint): remove JSON5 prettier-compat workaround after upstream fix

`@bfra.me/eslint-config@0.50.3` (via bfra-me/works#3045) fixes the
`isPackageExists` gate that prevented jsonc's prettier-compat rules from
loading under Bun's `.bun/` symlink layout. The local workaround block in
`eslint.config.ts` that manually disabled eight conflicting `jsonc/*`
stylistic rules on `**/*.json5` is no longer needed — the upstream preset
now handles JSON5 formatting correctly in Bun workspaces. Verified
`.github/renovate.json5` lints cleanly with 0 errors.
