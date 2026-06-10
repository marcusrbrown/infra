---
"@marcusrbrown/infra": patch
---

Fix a failed install caused by an unresolvable `@marcusrbrown/infra-shared@workspace:*` dependency. The VPN peer model now ships with the package, so `bun add`/`npm install @marcusrbrown/infra` resolves cleanly.
