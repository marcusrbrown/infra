---
'@marcusrbrown/infra': patch
---

Exclude docs, tests, and fixtures from deploy workflow filter so AGENTS.md and test-only changes under `apps/keeweb/` and `apps/cliproxy/` no longer trigger unnecessary production/cliproxy deployments. Adds `predicate-quantifier: every` to make dorny/paths-filter negation patterns actually take effect (default `some` uses OR logic and silently ignores negations).
