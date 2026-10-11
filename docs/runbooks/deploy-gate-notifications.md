# Deploy-Gate Notifications

Each app deploy waits at a required-reviewer GitHub Environment gate. Every `deploy-<app>.yaml` workflow runs an ungated, main-only `notify` job just before that gate; it posts one message to a dedicated Discord channel so a waiting deploy is seen within minutes. This runbook covers one-time setup, reading the notify job's output, rotation and revocation, and known behaviors. For the daily report's handling of waiting deploys, see the Deploy Pipeline Health category in `.github/workflows/fro-bot.yaml`.

---

## What posts and when

- **One message per gated run**, posted by the `notify` job of `deploy-keeweb`, `deploy-cliproxy`, `deploy-gateway`, `deploy-umami`, `deploy-vpn`, `deploy-dashboard`, and `deploy-broker`. It runs before the gated deploy job pauses for approval.
- **Content:** app, trigger, the change waiting to deploy, and the run link.
  - Push: commit subject and short SHA.
  - Dashboard dispatch with a version: version and short digest.
  - Other manual dispatch: ref, short SHA, and the dispatching actor.
- **Plain text only.** Mentions are disabled and commit text is escaped. No secrets, environment values, or logs are included.
- **Never blocks the deploy.** The gated job depends on `notify` but ignores its result. `notify` has a 3-minute timeout, the most it can delay the gate.
- **Gateway** posts only after `build-images` succeeds; **dashboard** only after `validate-inputs` succeeds. A run that cannot reach its gate posts nothing.
- **Branch dispatches never post.** See [Branch dispatches](#branch-dispatches).

There are no reminders, outcome edits, or follow-up messages.

---

## Security model

The webhook URL is a bearer credential: anyone holding it can post to the channel. `DEPLOY_GATE_DISCORD_WEBHOOK` is a repository secret. The router (`deploy.yaml`) passes it explicitly to each callee, and every callee declares it under `workflow_call.secrets` with `required: false`. A GitHub Environment secret is not readable by a job in a workflow called through `uses:` (actions/runner#4453), so the webhook is not an environment secret. The `notify` job runs only when `github.ref == 'refs/heads/main'`, so branch runs never post. The workflow binds the webhook through `env:` on the notify script step only — never into a `run:` body or argv. The main-only condition limits what the shipped workflows do; any collaborator who can push a workflow to a branch of this repository can still read repository secrets, so treat the webhook as exposed to repository writers and rotate it if write access changes.

---

## One-time setup

### 1. Create the Discord channel and webhook

1. Create a dedicated text channel for deploy notifications.
2. Channel settings → Integrations → Webhooks → New Webhook. Copy the URL to the clipboard only; do not paste it into a file, chat, or issue.

### 2. Store the webhook as a repository secret

Read the value from stdin. Never pass it as an argument or via `--body "$(…)"`:

```bash
pbpaste | tr -d '\n' | gh secret set DEPLOY_GATE_DISCORD_WEBHOOK --repo marcusrbrown/infra
```

On Linux, substitute `xclip -o -selection clipboard` for `pbpaste`. Clear the clipboard afterwards and scrub shell history if the value was ever typed.

### 3. Enable notifications

- **Phone push:** enable push for the Discord channel (Discord mobile → channel → notification settings → all messages) and confirm a test webhook post arrives within minutes.
- **Fallback:** enable GitHub pending-deployment notifications (GitHub Mobile and/or email, Settings → Notifications → Actions). If Discord is down or the channel is muted, GitHub's own review request is the backup signal.

### 4. Verify

Dispatch `deploy.yaml` on a branch. Expect every app's jobs to be created (no startup failure), each `notify` job skipped by its main-only condition with nothing posted, and each gated job still attempted. After the next merge to `main` that triggers a deploy, confirm the message content, the run link, a phone push, and GitHub's pending-deployment notification.

---

## Reading the notify job

The script always exits 0. It reports through:

- a `::warning::` annotation on the run when the post was skipped or failed;
- a one-line step summary; and
- a body-free JSON summary line in the step log (outcome only; never the webhook or message body).

| Outcome | Meaning | Action |
| --- | --- | --- |
| `sent` | Message accepted by Discord | None |
| `skipped` | Webhook secret unset or empty | Check that the `DEPLOY_GATE_DISCORD_WEBHOOK` repository secret exists and that `deploy.yaml` passes it to the callee |
| `failed` | Discord rejected or never answered after 3 attempts | A 404 means the webhook was deleted or revoked — [rotate](#rotation). 429/5xx/timeouts are transient; the gate is still reachable in GitHub |

If the `notify` job itself fails before its first step (runner failure) or is skipped, there is no script output. The deploy job still runs; look at the job's status and reason in the run view.

---

## Branch dispatches

The `notify` job runs only on the `main` ref (under `workflow_call`, `github.ref` is the caller's ref). A `workflow_dispatch` of a deploy workflow (or the router) from any other branch skips `notify`: nothing posts and the secret is never bound to a branch run. The deploy job is still attempted and waits at its own environment gate as usual. This is expected, and it is how the branch verification in setup step 4 exercises notify-skip tolerance.

---

## Rotation

Rotate on a schedule you choose, and immediately on suspected exposure.

1. In Discord, delete the old webhook (Channel settings → Integrations → Webhooks). The old URL stops working immediately; any in-flight notify posts fail with a warning and do not affect deploys.
2. Create a new webhook in the same channel; copy the URL to the clipboard.
3. Replace the secret:

   ```bash
   pbpaste | tr -d '\n' | gh secret set DEPLOY_GATE_DISCORD_WEBHOOK --repo marcusrbrown/infra
   ```

4. Verify with the next gated run, or by dispatching a deploy from `main` and confirming the message arrives.

## Revocation (suspected leak)

Delete the webhook in Discord first — this contains the leak at once. Then check the channel for unexpected posts, rotate as above, and delete the old secret value from any place it was pasted. Treat uncertainty as confirmed.

To disable notifications without removing the feature, delete the webhook and the `DEPLOY_GATE_DISCORD_WEBHOOK` secret. Every notify job then reports `skipped` with a warning and deploys proceed unchanged.

---

## Known behaviors

- **Manual router dispatch posts seven messages.** `deploy.yaml` with `workflow_dispatch` fans out to every app, and each run reaches a real gate.
- **Rare duplicate message.** The sender retries up to 3 times on 429, 5xx, network errors, and timeouts. An ambiguous failure (Discord accepted the post but the response was lost) can produce two messages for one run.
- **Queued runs post when next in line.** All seven deploy workflows hold their concurrency group at workflow level with `cancel-in-progress: false`. A run queued behind a deploy waiting for approval starts no jobs, so its message posts only once the earlier run clears. For gateway, a queued run builds its images only after the previous gateway deploy clears.
- **No coverage for `fro-bot-storage`.** That environment has no reviewer gate.
- **Daily report.** A deploy whose job never ran a step (waiting at its gate, or cancelled before its first step) appears as a Deploy Pipeline Health table row only. A deploy that ran and then failed, and any down-app check, still opens an issue.
- **Un-notified gates.** For each at-gate deploy the daily report reads the run's `notify` job summary line. If the outcome is not `sent`, the summary is missing, or the notify job did not succeed, the row reads `⏸ At gate — not notified (<outcome>)` (`no summary` when there is no outcome). It is still a table row only, never an issue.

---

## Related

- [`AGENTS.md`](../../AGENTS.md) — NOTES entry for `DEPLOY_GATE_DISCORD_WEBHOOK`
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — deploy gating concern
- [`discord-token-lifecycle.md`](discord-token-lifecycle.md) — gateway bot-token handling (separate credential)
- [`agent-s3-durable-storage.md`](agent-s3-durable-storage.md) — main-only environment without reviewer precedent
- [`docs/solutions/workflow-issues/approval-gated-run-cancellation-2026-09-02.md`](../solutions/workflow-issues/approval-gated-run-cancellation-2026-09-02.md) — why a gated job runs no step before approval
