---
'@marcusrbrown/infra': patch
---

Add post-setup check that warns when the target repository's
`.github/workflows/fro-bot.yaml` is missing required Fro Bot inputs. After
`cliproxy setup --harness opencode` completes, the wizard fetches the
target repo's workflow file, locates the `fro-bot/agent` step, and
verifies the four required inputs (`auth-json`, `opencode-config`,
`omo-providers`, `model`) are wired to that specific step. Missing
inputs produce a warning with the exact snippet to add under the `with:`
block. The scan is step-scoped (not whole-file), so a same-named input
in a sibling step (e.g. `strategy.matrix.model:` or a custom action
with `model:`) cannot mask a genuine gap in `fro-bot/agent`'s wiring.

If the workflow file is missing the check distinguishes 404 from other
`gh api` failures (auth, rate limit, 5xx, network): a 404 points the
user at `marcusrbrown/infra` as a reference template, while a non-404
surfaces the stderr so the user can diagnose transport issues instead
of chasing a missing-file red herring. Non-fatal in both cases —
setup itself still completes.

Without `opencode-config` the baseURL override is ignored and Fro Bot
hits `api.anthropic.com` with the proxy key, which fails with 401 —
this check catches the gap before the user discovers it in a failed
run. Observation-only: the target repo's workflow is never modified.
