---
'@marcusrbrown/infra': patch
---

chore(lint): remove JSON5 prettier-compat workaround after upstream fix

`@bfra.me/eslint-config@0.50.3` ships the fix from
[bfra-me/works#3047](https://github.com/bfra-me/works/pull/3047) for
[bfra-me/works#3045](https://github.com/bfra-me/works/issues/3045):
the preset now uses try/catch imports instead of `isPackageExists` to
load eslint-plugin-jsonc's prettier-compat rules, so the detection works
regardless of the package manager's `node_modules` layout. The local
workaround block in `eslint.config.ts` that manually disabled eight
conflicting `jsonc/*` stylistic rules on `**/*.json5` is no longer
needed. Verified `.github/renovate.json5` lints cleanly with 0 errors.
