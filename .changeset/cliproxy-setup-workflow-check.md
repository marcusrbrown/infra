---
'@marcusrbrown/infra': patch
---

Add post-setup check that warns when the target repository's
`.github/workflows/fro-bot.yaml` is missing required Fro Bot inputs. After
`cliproxy setup --harness opencode` completes, the wizard fetches the
target repo's workflow file and verifies all four required inputs
(`auth-json`, `opencode-config`, `omo-providers`, `model`) are wired to
the `fro-bot/agent` step. Missing inputs produce a warning with the
exact snippet to add under the `with:` block. If the workflow file
doesn't exist, the user is pointed at `marcusrbrown/infra` as a
reference. Without `opencode-config` the baseURL override is ignored
and Fro Bot hits `api.anthropic.com` with the proxy key, which fails
with 401 — this check catches the gap before the user discovers it in
a failed run. Observation-only: the workflow in the target repo is
never modified.
