# CLIProxyAPI OpenCode Go Upstream

CLIProxyAPI serves OpenCode Go models next to Claude and GPT. The cliproxy deploy owns one upstream entry, `opencode-go`, in the `openai-compatibility` section. A reviewed privacy snapshot decides which models the entry exposes. This runbook covers enablement, key rotation, emergency disable, re-enable, recovery from a failed deploy, snapshot PR review, a failing scheduled refresh and limits. For the deploy flow, guards and monitor reasons, see [`apps/cliproxy/AGENTS.md`](../../apps/cliproxy/AGENTS.md#opencode-go-upstream).

The tracked policy is in `packages/shared/opencode-go/`: `settings.json` (`enabled`, `defaultProbeModel`) and `privacy-snapshot.json`.

---

## Enablement order

1. Create the `CLIPROXY_OPENCODE_GO_KEY` repository secret from your OpenCode Console API key. Read the value from stdin. Never pass it as an argument:

   ```bash
   pbpaste | tr -d '\n' | gh secret set CLIPROXY_OPENCODE_GO_KEY --repo marcusrbrown/infra
   ```

   `CLIPROXY_API_KEY` must also exist as a repository secret. The monitor already uses it.

2. Merge the change.
3. Approve the cliproxy gate.
4. Verify:
   - The deploy log ends with `OpenCode Go applied and verified: <N> models visible, smoke request billed to Go`.
   - The Go ids are listed:

     ```bash
     bunx @marcusrbrown/infra cliproxy models opencode-go
     ```

   - A dispatched monitor run prints both probe lines, each with `probe=healthy reason=ok`:

     ```bash
     gh workflow run cliproxy-auth-monitor.yaml -f validation=live
     ```

     ```text
     CLIProxy auth monitor probe: probe=healthy reason=ok at <timestamp>
     CLIProxy Go monitor probe: probe=healthy reason=ok at <timestamp>
     ```

   - A real task with tool calls runs on a Go model through a scratch repo's proxy key. Wire the repo with `bunx @marcusrbrown/infra agent setup --providers anthropic,opencode-go --model opencode-go/<id>`, then run an agent task that edits a file.
   - A gateway workspace run on a Go model succeeds. See "OpenCode Go through the proxy" in [`apps/gateway/AGENTS.md`](../../apps/gateway/AGENTS.md).
   - A Claude request on the same scratch repo key still reaches Claude.

If the deploy ends with "APPLIED but UNVERIFIED", go to [Applied but unverified](#applied-but-unverified).

---

## Merge before deploy

The merge triggers the cliproxy deploy, which waits at the approval gate. Until you approve it, the live proxy has no Go entry. A monitor run in that window reports `provider-missing` and opens a Go issue. The issue closes on the first healthy probe after the deploy. No action is needed beyond approving the gate.

---

## Go key rotation

1. Create a new key at the OpenCode Console.
2. Update the repository secret:

   ```bash
   pbpaste | tr -d '\n' | gh secret set CLIPROXY_OPENCODE_GO_KEY --repo marcusrbrown/infra
   ```

3. Redeploy and approve the gate:

   ```bash
   bunx @marcusrbrown/infra cliproxy deploy
   ```

   The deploy writes the new key into the entry and sends a smoke request.

4. Revoke the old key at the Console after the deploy succeeds.

---

## Emergency disable without a deploy

Use this when Go must stop serving now.

1. Send the management PATCH. Load the management key into an environment variable, then give it to `curl` on stdin so it never appears in argv:

   ```bash
   read -rs CLIPROXY_MANAGEMENT_KEY && export CLIPROXY_MANAGEMENT_KEY
   printf 'x-management-key: %s\n' "$CLIPROXY_MANAGEMENT_KEY" | curl -sS -X PATCH \
     https://cliproxy.fro.bot/v0/management/openai-compatibility \
     -H @- -H 'Content-Type: application/json' \
     -d '{"name":"opencode-go","value":{"disabled":true}}'
   ```

2. Confirm the models left `/v1/models`. The list must be empty within seconds:

   ```bash
   bunx @marcusrbrown/infra cliproxy models opencode-go
   ```

3. Set `"enabled": false` in `packages/shared/opencode-go/settings.json` in a PR. Merge it and approve the gate. The deploy leaves the entry disabled and checks that no Go model is served. The published `cliproxy status` follows `settings.json` on `main`, so once the PR merges it reports `disabled by tracked settings (from main) — not probed` with no CLI release (the raw file read can be cached for about five minutes).

Merge step 3 promptly. A deploy that runs while the live entry is disabled and `enabled` is still `true` fails with the disabled-entry error.

The Go issue stays open as the record until the PR merges. After that the monitor skips Go, and you close the issue by hand.

Then take the extra step that matches the cause:

- **Suspected key leak:** disable, then rotate. Revoke the old key at the Console. Create a new key and update the repository secret ([Go key rotation](#go-key-rotation), steps 1 and 2). Skip the redeploy: the re-enable deploy writes the new key.
- **Privacy or billing problem:** disable only. Do not rotate. Fix the cause first, then re-enable.

---

## Re-enable

Use this after an emergency disable, or when the deploy fails with `The live "opencode-go" entry is disabled but settings.json says enabled`.

1. Fix the cause. For a leak, the new key must already be in the repository secret.
2. Set `"enabled": true` in `packages/shared/opencode-go/settings.json` in a PR. Merge it and leave the cliproxy gate pending.
3. Enable the live entry:

   ```bash
   read -rs CLIPROXY_MANAGEMENT_KEY && export CLIPROXY_MANAGEMENT_KEY
   printf 'x-management-key: %s\n' "$CLIPROXY_MANAGEMENT_KEY" | curl -sS -X PATCH \
     https://cliproxy.fro.bot/v0/management/openai-compatibility \
     -H @- -H 'Content-Type: application/json' \
     -d '{"name":"opencode-go","value":{"disabled":false}}'
   ```

4. Approve the gate at once. The deploy rewrites the entry with the current key and eligible models, then verifies it.

Until the deploy finishes, the entry serves its old model list. Do not wait between steps 3 and 4.

---

## Applied but unverified

The error reads `OpenCode Go entry APPLIED but UNVERIFIED (<stage>)`. The write reached the proxy, or may have, and the outcome is not proven. The entry is live and unproven. Do not assume Go routing works.

| Stage | What failed | Check |
| --- | --- | --- |
| `write` | The write request got no usable answer: a network error, a timeout, an HTTP 408 or a 5xx. The proxy may have applied it. A 4xx answer is a plain failure, not this stage. | Read `GET /v0/management/openai-compatibility`. If the entry is there, check it as for `read-back`. Then rerun the deploy. |
| `read-back` | The live entry differs from the tracked one. The error names the fields. | Read `GET /v0/management/openai-compatibility`. Compare the named fields. |
| `visibility` | An eligible id is missing or listed twice, or an ineligible id is served. The error names the ids. | `bunx @marcusrbrown/infra cliproxy models opencode-go` |
| `smoke request` | The proxy returned a non-2xx status, or a 2xx carried no `billing_source`. | Check the status in the error. 401 or 403 means a bad key. 429 or 402 means the plan limit or balance. |
| `post-write check` | A network or parse error after the write. | Rerun the deploy and read the error. |

Then:

1. A present `billing_source` other than `go` is not this error. It is the credits fallback: the Go usage window is exhausted and the account bills credits. The deploy warns and passes, and the monitor stays silent. It is not an outage. Check Console usage. Disable via [Emergency disable](#emergency-disable-without-a-deploy) (disable only) only if the value is unexpected and the Go window is not exhausted.
2. Otherwise fix the cause and rerun `bunx @marcusrbrown/infra cliproxy deploy`. The deploy writes the entry again and repeats every check.
3. If the entry cannot be fixed, disable it.

The monitor flags the same state with a Go issue.

---

## Session header dropped

The monitor reports `session-header-dropped` when the probe gets HTTP 400 `MissingSessionID`. The probe always sends `x-opencode-session`, so the proxy stopped forwarding it. Go rejects every request without it, so real traffic fails too.

1. Read `GET /v0/management/openai-compatibility`. The `opencode-go` entry must hold `headers: {"x-opencode-session": "$X-Opencode-Session"}`.
2. If the header mapping is missing or different, rerun `bunx @marcusrbrown/infra cliproxy deploy`. The deploy writes the tracked entry.
3. If the mapping is present, the proxy build no longer applies it. Roll back the CLIProxyAPI image or disable the entry ([Emergency disable](#emergency-disable-without-a-deploy)).

The Go issue closes on the next healthy probe.

---

## Snapshot refresh PR review

The `OpenCode Go Privacy` workflow runs daily and on dispatch. It opens or updates one PR on the branch `opencode-go-privacy` when a model's privacy terms change. A change to the source commit alone opens no PR.

A PR that restricts models is time-sensitive. The deploy applies the committed snapshot, so a model the new snapshot would drop stays served until you merge the PR and approve the gated cliproxy deploy. When a successful run opens or updates the PR and the new snapshot makes ineligible a model that the committed one made eligible, the `alert` job posts one Discord message to `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK` with the count and a link to the PR. Eligible-to-ineligible covers zero retention lost, training turned on, a new region requirement, an agreement that expires, and a model removed from the snapshot. The message carries no model names: open the PR for them. The refresh updates the same PR every day while it differs from `main`, and the message repeats each day until the PR merges or closes. Treat a repeat as a reminder, not a new event. A re-run of the workflow posts nothing. Review and merge the same day, then approve the deploy. If the new snapshot leaves no eligible Go model, approving the deploy does not apply it: the preflight fails with `no eligible OpenCode Go models` before it writes anything, and the old list stays live, so the models stay exposed. Use [Emergency disable](#emergency-disable-without-a-deploy) instead; the Discord message links it for that case. If the **Warning** line says upstream published no privacy fields, check that the live list is not degraded first.

Review the PR before you merge:

1. Open the compare link in the PR body. It spans the old and new source commits of the OpenCode docs repository.
2. Check each added, removed and changed model against the privacy table in that diff. The table and its footnotes are the authority, not the parsed JSON.
3. Check every new model for zero retention, no training, no region requirement and any agreement expiry.
4. Read the lists at the end of the PR body. The first two are models and facts on which the two sources differ, and the snapshot already holds the restrictive value; the third lists models that have no entry:
   - **Sources disagree**: the docs page and the live models list both state the fact and contradict each other (for example the page says `30 days` and the API says `zdr: true`, or a page footnote grants training use and the API says `training: false`). Treat the model as not cleared. Open the compare link and the live list, find out which source is stale or wrong, and merge only when you can say why the restrictive value is right or when the model stays excluded anyway. An unexplained retention or training conflict is a reason to hold the PR and ask upstream.
   - **API-only restrictions**: the API restricts the model (`training: true`, or `limited_regions: true`) and the page makes no statement about that fact. The restriction applies. Check that it is not new for a model you expected to be cleared.
   - **Left out of the snapshot**: a model that only one source knows has no entry, so it is not exposed (`not-in-snapshot`). A line containing `upstream published no privacy fields` means the API listed the model without its `go` object, which upstream says happens when its model data is unavailable. The model has no entry. If the previous snapshot made it eligible, the PR body leads with a **Warning** line and removes it; a model that was listed but already ineligible is removed without a warning: check that the live list is not degraded before merging. `live model <id>: no Privacy row` usually means the API got a model before the page did: nothing to do until the row appears, and the next run adds it. `footnote only, no Privacy row` is the same case where upstream also wrote a Privacy footnote for the model: the footnote is not read, and the model stays out until the table has its row. `Privacy row <name>: no live model` usually means the page got a row first, or a name changed on one side. If both lines name the same model, the names no longer join: check whether upstream renamed it, and add an alias to `DOCS_NAME_ALIASES` in `packages/shared/opencode-go/model-names.ts` only after confirming both names are the same model. If an entry here is a model you expect to be exposed, this PR removes it from the snapshot; check the Removed list, and merge only if dropping it is right. The same lines are in the workflow log of every run, including runs that open no PR.
   - Not listed by design: the workspace **Global** requirement and agreement expiry dates. Only the page states them; the API's `limited_regions` means "some countries are refused", a different fact. Check these against the page table and footnotes as before.

Merge rules:

- Auto-merge stays off.
- Merging triggers the gated cliproxy deploy. Approve the gate.
- The PR also carries one patch changeset for `@marcusrbrown/infra`, because the published CLI bundles the snapshot. Merging queues a CLI patch release: the next `Version Packages` PR on `main` includes it. Merge that PR when you want published CLIs to carry the new snapshot. The changeset adds no deploy of its own.
- Between the merge and the approved deploy, a model that lost eligibility is still served. The monitor reports it as `privacy-noncompliant`. Approve the deploy promptly, or disable.

If upstream reverts the change before you merge, the next daily run finds that the terms match `main` again. It closes the open PR with a comment, then deletes the `opencode-go-privacy` branch. A PR on that branch from a fork is left alone. Do not merge a PR that the workflow closed. A later change to the terms opens a new PR. If the run cannot reach the PR list or the close step fails, the run fails: close the PR by hand and delete the branch.

A run that cannot build the snapshot fails and opens no PR. The run fails on: a docs page that no longer parses (unknown column, row, footnote sentence, label or rule, or prose in the restricted-models section or before the Privacy table that names a model, or an availability sentence in the Usage limits section that is not the recognised `Not available in <places>.` form, or whose paragraph names no Privacy model or more than one: put each restriction in its own paragraph, or update the parser); a live models entry whose `go` object is present but lacks a boolean `training`, `zdr` or `limited_regions`; a live list in which no entry has a `go` object, or more than half of the entries lack one; and an ambiguous join (one Privacy row fits several live models, two rows resolve to one model, or two live names normalise alike). A model that only one source knows, or that the API lists with no `go` object, does not fail the run; it is left out and reported (see the PR review above). A model that a Privacy footnote names but the table has no row for does not fail the run either, when the footnote label is exactly the name of a live model: it is left out and reported as `footnote only, no Privacy row`, provided its text names no Privacy-table model (one that does fails the run with `prose names "<model>"`). A footnote label that names no live model (a typo for an existing row, say), or a list (`A / B`, `A and B`) in which any name is not a row, still fails with `does not name a model in the Privacy table`. Known limits: a restriction written as prose that names no model, or prose elsewhere on the page, is not detected, so read the page diff in the compare link for new sentences. Do not leave a failed run unread: see [The scheduled refresh is failing](#the-scheduled-refresh-is-failing). Add an alias to `DOCS_NAME_ALIASES` in `packages/shared/opencode-go/model-names.ts` only after confirming that the page name and the API name are the same model.

---

## The scheduled refresh is failing

A failed `OpenCode Go Privacy` run raises an alert. The `alert` job runs after the refresh whatever its result. A failed or cancelled refresh (a run that hits its 10-minute timeout reports as cancelled) opens one issue labelled `opencode-go-privacy-failure`, titled `OpenCode Go privacy refresh is failing`, and posts one message to the Discord webhook in the repository secret `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK`. Each later failing run adds a comment to that issue and posts nothing more. The next successful run comments, closes the issue and posts one recovery message. Do not put a closing keyword such as `Fixes #<issue>` for the alert issue in the PR that fixes the failure: merging it closes the issue before the next run, which then finds no open issue and posts no recovery message. A re-run ("Re-run jobs" or "Re-run all jobs") never updates the alert, because it replays an older result: after you fix a failure, dispatch the workflow or wait for the next scheduled run to close the issue. A Discord failure only logs a warning; the issue is the record. If the `alert` job itself fails, the issue API failed: read the run and check the Actions run list by hand. The alert cannot see a refresh that never starts, such as a disabled schedule: if no run appears for two days, check the run list.

A model that a Privacy footnote names with no table row is not a failure: if the label is exactly a live model's name, the run leaves that model out and reports it. If the failure line reads `"<label>" does not name a model in the Privacy table`, the label names no row, no reviewed group and no live model: check the page for a typo or a renamed model before you change the parser.

While runs fail, the deploy keeps applying the last committed `privacy-snapshot.json`. That snapshot can be wrong in the unsafe direction: a model upstream now restricts can still be exposed.

1. Read the failure line in the `Refresh privacy snapshot` step:

   ```bash
   gh run list --workflow opencode-go-privacy.yaml --limit 5
   gh run view <run-id> --log-failed
   ```

2. Compare both upstream sources in full with `privacy-snapshot.json`. A restriction can appear in any of these places:
   - The Privacy table on the docs page: a retention other than `0 days`, or `Not ZDR`.
   - The Privacy footnotes: retention periods, permission to train, `Availability is limited to regions permitted by …`, `Hosted in <place>.`, the Global-region rule, and agreement expiry dates (`The current agreement is valid through <date>.`).
   - The "Enable restricted models" bullets: the Global-region rule and the training opt-in.
   - The Usage limits notices: `Not available in <places>.` One model's region limit can appear only here.
   - The public Go model list: each model's `go` object (`training`, `zdr`, `limited_regions`). Fetch the URL in `GO_LIVE_MODELS_URL` in `packages/shared/opencode-go/live-models.ts`.

   The docs page is the file named by `source.repo` and `source.path` in `privacy-snapshot.json`, read at the head of its `dev` branch. List every model that either source restricts and the snapshot still clears (`zeroRetention: true`, `trainsOnData: false` or `regionGated: false`), and every model whose agreement date differs from `agreementExpiry`. If the current terms for a model cannot be determined with confidence, use [Emergency disable](#emergency-disable-without-a-deploy) instead of concluding there is no exposure.

3. Contain first. Open one PR that changes only `privacy-snapshot.json`, setting each affected boolean to its restrictive value (`zeroRetention: false`, `trainsOnData: true` or `regionGated: true`). It takes effect when the gated cliproxy deploy is approved and applied, not at merge. Merge it, approve the gate, then confirm the affected models are no longer listed:

   ```bash
   bunx @marcusrbrown/infra cliproxy models opencode-go
   ```

   Use [Emergency disable](#emergency-disable-without-a-deploy) instead of this PR in two cases:
   - The deploy cannot happen promptly.
   - The containment would leave no eligible model. The deploy preflight then fails with `no eligible OpenCode Go models` before it writes anything, so the old list stays live.

   An `agreementExpiry` date does not remove a model by itself. The expiry day still counts as valid, and a model is excluded only by a deploy that runs after that UTC day. To record an earlier date, change `agreementExpiry` in the same PR. To remove the model now, set `zeroRetention: false` as well.

4. Fix the parser or the alias map, add the failing case to the fixtures, and merge.
5. Dispatch the workflow from `main` and confirm the workflow run succeeds, not only one step:

   ```bash
   gh workflow run opencode-go-privacy.yaml --ref main
   ```

   If the run opens or updates a PR, follow [Snapshot refresh PR review](#snapshot-refresh-pr-review), then the deploy.

6. Review the next refresh PR against each manual containment from step 3. `refreshGoPrivacy` rebuilds every entry from upstream and proposes any difference from the committed snapshot, including a reversal of a hand-set restrictive value that the repaired parser or the inputs do not reproduce. Do not merge a relaxation unless the upstream evidence supports it. If the parser still misses the restriction, leave that PR unmerged, so the hand-set value stays in force, and fix the parser.

To rehearse the alert without a real failure, dispatch from `main` as the repository owner. Any other actor makes the `alert` job fail before it writes anything. A re-run of a rehearsal does nothing either. The refresh does not run during a rehearsal.

```bash
gh workflow run opencode-go-privacy.yaml --ref main -f rehearse-alert=fail
```

The run opens one issue titled `[Rehearsal] OpenCode Go privacy refresh alert`, with the label `opencode-go-privacy-failure`, and posts one Discord message that starts with `[REHEARSAL]`. The rehearsal issue has its own marker, so it never absorbs a real failure. Dispatching `fail` again adds a comment and posts nothing. Close the rehearsal with `-f rehearse-alert=clear` (one more Discord message). Only `clear` closes it; a real refresh never touches it.

To rehearse the restriction message alone, dispatch the same way with `-f rehearse-alert=restrict`. It posts one Discord message that starts with `[REHEARSAL]`, claims one restricted model, links the repository's PR list and says that nothing is restricted. It opens no issue and needs no clearing. It is owner-only like the others; each dispatch posts once. A real message links the PR and carries the count from the refresh. Only a real run can show the real count and link: the first real restriction is the proof.

---

## Limitations

- **Expiry:** the deploy enforces agreement expiry. Between deploys, the monitor flags an expired model as `privacy-noncompliant`.
- **Region-gated models:** never exposed. A model is gated when the live models list says `limited_regions: true`, or when the docs page states a hosting location (`Hosted in <place>.`), requires Global regions or limits availability to permitted regions, whether or not a restricted-models bullet also lists it.
- **Plan limits:** a 429 or 402 alerts as dead with reason `quota-or-billing`. The Go issue closes on the next healthy probe.
- **Credits fallback:** a 2xx with a present `billing_source` other than `go` is `unknown` / `billing-fallback`. The monitor prints `CLIProxy Go monitor billing: billing_source=<token>`, opens no issue and sends no alert. `cliproxy status` warns and exits 0. An open Go issue stays as it is until a healthy probe closes it.
- **Status and the privacy snapshot:** `cliproxy status` judges the exposed Go models against the current `privacy-snapshot.json` on `main`, read at run time with no token, so a published CLI needs no release after a refresh PR merges. The raw file read is cached for up to about five minutes, so a run just after a refresh merge can still show the previous snapshot: rerun after a few minutes. If the commit in `Privacy snapshot: <commit> (from main)` differs from `source.commit` in the snapshot on `main`, the reading is stale. A matching commit does not prove it is current: a snapshot's terms can change while its source commit stays the same. The monitor never reads it: it runs from source and uses the committed file. When the read fails, status uses the copy bundled in the CLI and prints `Privacy snapshot: bundled <commit> used (fetch failed: <reason>)`. A model the bundle records as restricted is still `privacy-noncompliant`. Otherwise the route line is a warning that says the current privacy policy was not checked, and it lists any exposed model the bundle cannot vouch for. If the network was down, run `cliproxy status` again. A warning that persists means the read keeps failing: check the reason, then upgrade the CLI or run it from source. `settings.json` is read from `main` the same way, first (4 KiB cap, same fixed reasons plus `invalid-settings`); a route that is off on `main` makes no snapshot request. The route line then carries `Go settings: from main`, or `Go settings: bundled (<reason>)` when that read fails and the bundled settings are used. A failed settings read changes the label only, never the level. The tracked settings describe the production proxy, and `cliproxy status --url <other proxy>` follows them too.
- **Probe allowance:** each probe is one `max_tokens: 1` request. The monitor sends 96 a day. The deploy sends one per run, and `cliproxy status` sends one per run.
- **Management key:** anyone holding it can read the Go key in clear. It already reads the downstream api keys in clear.
