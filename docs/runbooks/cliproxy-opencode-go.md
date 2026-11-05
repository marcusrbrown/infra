# CLIProxyAPI OpenCode Go Upstream

CLIProxyAPI serves OpenCode Go models next to Claude and GPT. The cliproxy deploy owns one upstream entry, `opencode-go`, in the `openai-compatibility` section. A reviewed privacy snapshot decides which models the entry exposes. This runbook covers enablement, key rotation, emergency disable, re-enable, recovery from a failed deploy, snapshot PR review and limits. For the deploy flow, guards and monitor reasons, see [`apps/cliproxy/AGENTS.md`](../../apps/cliproxy/AGENTS.md#opencode-go-upstream).

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

3. Set `"enabled": false` in `packages/shared/opencode-go/settings.json` in a PR. Merge it and approve the gate. The deploy leaves the entry disabled and checks that no Go model is served.

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

The error reads `OpenCode Go entry APPLIED but UNVERIFIED (<stage>)`. The write reached the proxy and a later check failed. The entry is live and unproven. Do not assume Go routing works.

| Stage | What failed | Check |
| --- | --- | --- |
| `read-back` | The live entry differs from the tracked one. The error names the fields. | Read `GET /v0/management/openai-compatibility`. Compare the named fields. |
| `visibility` | An eligible id is missing or listed twice, or an ineligible id is served. The error names the ids. | `bunx @marcusrbrown/infra cliproxy models opencode-go` |
| `smoke request` | The proxy returned a non-2xx status, or the response was not billed to Go. | Check the status in the error. 401 or 403 means a bad key. 429 or 402 means the plan limit or balance. |
| `post-write check` | A network or parse error after the write. | Rerun the deploy and read the error. |

Then:

1. If `billing_source` was anything other than `go`, disable at once. Requests may be billing the pay-as-you-go balance. Follow [Emergency disable](#emergency-disable-without-a-deploy) (disable only), then check the OpenCode Console.
2. Otherwise fix the cause and rerun `bunx @marcusrbrown/infra cliproxy deploy`. The deploy writes the entry again and repeats every check.
3. If the entry cannot be fixed, disable it.

The monitor flags the same state with a Go issue.

---

## Snapshot refresh PR review

The `OpenCode Go Privacy` workflow runs daily and on dispatch. It opens or updates one PR on the branch `opencode-go-privacy` when a model's privacy terms change. A change to the source commit alone opens no PR.

Review the PR before you merge:

1. Open the compare link in the PR body. It spans the old and new source commits of the OpenCode docs repository.
2. Check each added, removed and changed model against the privacy table in that diff. The table and its footnotes are the authority, not the parsed JSON.
3. Check every new model for zero retention, no training, no region requirement and any agreement expiry.

Merge rules:

- Auto-merge stays off.
- Merging triggers the gated cliproxy deploy. Approve the gate.
- Between the merge and the approved deploy, a model that lost eligibility is still served. The monitor reports it as `privacy-noncompliant`. Approve the deploy promptly, or disable.

If upstream reverts the change, the PR goes stale and the workflow does not close it. Close it by hand.

A run that cannot parse the table fails and opens no PR. The deploy keeps the reviewed snapshot.

---

## Limitations

- **Expiry:** the deploy enforces agreement expiry. Between deploys, the monitor flags an expired model as `privacy-noncompliant`.
- **Region-gated models:** never exposed.
- **Plan limits:** a 429 or 402 alerts as dead with reason `quota-or-billing`. The Go issue closes on the next healthy probe.
- **Probe allowance:** each probe is one `max_tokens: 1` request. The monitor sends 96 a day. The deploy sends one per run, and `cliproxy status` sends one per run.
- **Management key:** anyone holding it can read the Go key in clear. It already reads the downstream api keys in clear.
