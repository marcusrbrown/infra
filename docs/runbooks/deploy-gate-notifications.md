# Deploy-Gate Notifications

Each app deploy waits at a required-reviewer GitHub Environment gate. Every `deploy-<app>.yaml` workflow runs an ungated `notify` job just before that gate; it posts one message to a dedicated Discord channel so a waiting deploy is seen within minutes. This runbook covers one-time setup, reading the notify job's output, rotation and revocation, and known behaviors. For the daily report's handling of waiting deploys, see the Deploy Pipeline Health category in `.github/workflows/fro-bot.yaml`.

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

The webhook URL is a bearer credential: anyone holding it can post to the channel. `DEPLOY_GATE_DISCORD_WEBHOOK` is the only secret in the `deploy-notify` GitHub Environment. The environment is limited to `main` by deployment-branch policy and has no required reviewer, so the notify job runs unattended. Code on other branches cannot read the secret, and the router (`deploy.yaml`) passes no secret to the callees. The workflow binds the webhook through `env:` only — never into a `run:` body or argv.

---

## One-time setup

The order is significant. GitHub auto-creates an environment **without** a branch policy when a workflow first references it, so `deploy-notify` must exist with its policy before any workflow that uses it runs.

### 1. Create the Discord channel and webhook

1. Create a dedicated text channel for deploy notifications.
2. Channel settings → Integrations → Webhooks → New Webhook. Copy the URL to the clipboard only; do not paste it into a file, chat, or issue.

### 2. Create the `deploy-notify` environment first

Create it with a custom deployment-branch policy of exactly `main` and no reviewers:

```bash
gh api -X PUT repos/marcusrbrown/infra/environments/deploy-notify \
  --input - <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON

gh api -X POST repos/marcusrbrown/infra/environments/deploy-notify/deployment-branch-policies \
  -f name=main -f type=branch
```

Verify before continuing:

```bash
gh api repos/marcusrbrown/infra/environments/deploy-notify
gh api repos/marcusrbrown/infra/environments/deploy-notify/deployment-branch-policies
```

Expect `custom_branch_policies: true`, `protected_branches: false`, exactly one `branch` policy named `main`, and no `required_reviewers` protection rule.

### 3. Store the webhook as an environment secret

Read the value from stdin. Never pass it as an argument or via `--body "$(…)"`:

```bash
pbpaste | tr -d '\n' | gh secret set --env deploy-notify DEPLOY_GATE_DISCORD_WEBHOOK
```

On Linux, substitute `xclip -o -selection clipboard` for `pbpaste`. Clear the clipboard afterwards and scrub shell history if the value was ever typed.

### 4. Enable notifications

- **Phone push:** enable push for the Discord channel (Discord mobile → channel → notification settings → all messages) and confirm a test webhook post arrives within minutes.
- **Fallback:** enable GitHub pending-deployment notifications (GitHub Mobile and/or email, Settings → Notifications → Actions). If Discord is down or the channel is muted, GitHub's own review request is the backup signal.

### 5. Verify

Dispatch `deploy.yaml` on a branch. Expect every app's jobs to be created (no startup failure), each `notify` job rejected by the `deploy-notify` branch policy with nothing posted, and each gated job still attempted. After the next merge to `main` that triggers a deploy, confirm the message content, the run link, a phone push, and GitHub's pending-deployment notification.

---

## Reading the notify job

The script always exits 0. It reports through:

- a `::warning::` annotation on the run when the post was skipped or failed;
- a one-line step summary; and
- a body-free JSON summary line in the step log (outcome only; never the webhook or message body).

| Outcome | Meaning | Action |
| --- | --- | --- |
| `sent` | Message accepted by Discord | None |
| `skipped` | Webhook secret unset or empty | Check that `DEPLOY_GATE_DISCORD_WEBHOOK` exists in `deploy-notify` |
| `failed` | Discord rejected or never answered after 3 attempts | A 404 means the webhook was deleted or revoked — [rotate](#rotation). 429/5xx/timeouts are transient; the gate is still reachable in GitHub |

If the `notify` job itself fails or is rejected before its first step (runner failure, environment policy), there is no script output. The deploy job still runs; look at the job's status and reason in the run view.

---

## Branch dispatches

The `deploy-notify` environment accepts only `main`. A `workflow_dispatch` of a deploy workflow (or the router) from any other branch has its `notify` job rejected by the branch policy: nothing posts and no secret is exposed. The deploy job is still attempted and waits at its own environment gate as usual. This is expected, and it is how the branch verification in setup step 5 exercises notify-failure tolerance.

---

## Rotation

Rotate on a schedule you choose, and immediately on suspected exposure.

1. In Discord, delete the old webhook (Channel settings → Integrations → Webhooks). The old URL stops working immediately; any in-flight notify posts fail with a warning and do not affect deploys.
2. Create a new webhook in the same channel; copy the URL to the clipboard.
3. Replace the secret:

   ```bash
   pbpaste | tr -d '\n' | gh secret set --env deploy-notify DEPLOY_GATE_DISCORD_WEBHOOK
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
- **Deployment records.** Each notify run records a deployment in the `deploy-notify` environment.
- **No coverage for `fro-bot-storage`.** That environment has no reviewer gate.
- **Daily report.** A deploy whose job never ran a step (waiting at its gate, or cancelled before its first step) appears as a Deploy Pipeline Health table row only. A deploy that ran and then failed, and any down-app check, still opens an issue.

---

## Related

- [`AGENTS.md`](../../AGENTS.md) — NOTES entry for `DEPLOY_GATE_DISCORD_WEBHOOK`
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — deploy gating concern
- [`discord-token-lifecycle.md`](discord-token-lifecycle.md) — gateway bot-token handling (separate credential)
- [`agent-s3-durable-storage.md`](agent-s3-durable-storage.md) — main-only environment without reviewer precedent
- [`docs/solutions/workflow-issues/approval-gated-run-cancellation-2026-09-02.md`](../solutions/workflow-issues/approval-gated-run-cancellation-2026-09-02.md) — why a gated job runs no step before approval
