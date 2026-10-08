---
date: 2026-10-07
topic: deploy-gate-discord-notification
---

# Deploy Gate Discord Notification

## Summary

Each deploy run that reaches an environment approval gate posts one message to a dedicated Discord deploy channel straight away, naming the app and the waiting change and linking to the run to approve it. The daily report keeps its stranded-deploy check as a report row only and stops opening issues.

---

## Problem Frame

Every app deploy waits at a required-reviewer environment gate. When nobody notices the gate, the change sits undeployed: one umami image bump ran the old version for about three weeks, and the dashboard recently fell five releases behind.

The only signal today comes from the daily Fro Bot report's stranded-deploy check. That check runs once a day and opens a GitHub issue per stuck app. Twelve such issues have been opened. Four are open now (#1412, #1436, #1437, #1440), and all four describe runs that later deployed or were superseded, so the issues have become noise rather than prompts to act. The signal arrives up to a day late, lands in a place that isn't watched, and outlives the condition it reports.

---

## Requirements

**Gate notification**
- R1. When a deploy run reaches an environment approval gate, one message is posted to the dedicated Discord deploy channel before the run waits for approval. The post comes from outside the gated job, ahead of it, because GitHub pauses a gated job before any of its steps run.
- R2. The message names the app, says what started the run, identifies the change waiting to deploy, and links to the run page where it is approved. For a push-triggered router run, the change is the commit subject and short SHA. For a dashboard dispatch, the change is the release version and digest being deployed. For any other manual dispatch, the change is the ref and short SHA.
- R3. Every gated app deploy is covered (keeweb, cliproxy, gateway, umami, dashboard, vpn, broker), whether the run came from the deploy router, a direct dispatch, or the dashboard image-pin dispatch.
- R4. Each gated run posts once. A bounded retry after an unclear failure (such as a timeout) may produce a rare duplicate; a missed alert is worse than a double one. The message is not edited afterwards and no reminder follows.

**Failure behavior**
- R5. A failed or skipped Discord post never blocks, delays past its own bounded attempt, or fails the deploy. It leaves a visible warning on the run.
- R6. The message carries no secrets, environment values, or log output, and never pings anyone: all mention parsing is disabled, and commit text is shown as plain text.

**Delivery channel**
- R7. Posts go through a Discord webhook used only for deploy notifications, independent of the gateway and of the cliproxy monitor's webhook.

**Daily report**
- R8. A deploy left waiting at, or cancelled at, its gate without a later successful deploy is reported only as a Deploy Pipeline Health row; the daily report no longer opens, updates, or comments on issues for it. Deploys that fail outright and apps that are down still get issues, because the gate post can see neither.

**Cleanup**
- R9. The four open deploy-wait issues (#1412, #1436, #1437, #1440) are closed, each with a short note citing the deploy that superseded it.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given a merge to main that changes the gateway, when the router's gateway deploy reaches the `gateway` approval gate, the deploy channel shows one message naming the gateway, the merged commit, and a link to that run.
- AE2. **Covers R2, R3.** Given an operator manually dispatches the dashboard deploy for a new release, when the run reaches the `dashboard` gate, one message is posted naming the release version and digest being deployed, not the workflow commit.
- AE3. **Covers R5.** Given the deploy webhook secret is missing or Discord returns an error, when a gated run starts, the deploy still reaches its gate and can be approved, and the run shows a warning that the notification was not sent.
- AE4. **Covers R4.** Given a run was approved and deployed, the original message stays as posted, and no follow-up or reminder message appears.
- AE6. **Covers R6.** Given a merged commit whose subject contains `@everyone`, when its deploy reaches the gate, the message shows the subject as text and notifies nobody.
- AE5. **Covers R8.** Given a deploy was cancelled at its gate and its change never deployed, the next daily report lists it as stranded in Deploy Pipeline Health, and no issue is opened.

---

## Success Criteria

- A deploy waiting at a gate is seen within minutes of reaching it, not at the next daily report. The first live post is confirmed as a push notification on the approver's phone.
- No new deploy-wait issues appear, and the issue tracker holds no stale deploy-wait issues.
- A planner can implement this without deciding which runs post, what the message contains, or what happens when Discord fails.

---

## Scope Boundaries

- No reminder messages for runs still waiting.
- No editing the message with the outcome (approved, deployed, failed, superseded).
- No use of the gateway's announce path or the Fro Bot persona for these posts.
- No consolidation of other alerts (cliproxy auth monitor, release alerts) into the deploy channel.
- The `fro-bot-storage` environment has no reviewer gate and is not covered.
- No change to which environments require approval or who approves.

---

## Key Decisions

- Notify at the gate, not in a daily digest: the failure mode is not noticing the gate, so the signal belongs at the moment the run starts waiting.
- Post once, with no follow-up: the channel won't show whether a deploy was approved, and the daily report is the backstop for anything left stranded.
- A dedicated webhook over Fro Bot's announce path: a broken or mid-deploy gateway must not be able to silence its own deploy alert.
- A notify step before each gate over a scheduled poller or webhook relay: it is instant and stateless and needs no new hosting, at the cost of touching every gated deploy workflow.
- Fail open: a notification is advisory, and a Discord outage must never hold up a deploy. GitHub's own review-requested notification for pending deployments is the backstop when the Discord post fails.
- Prefer a rare duplicate to a missed alert: Discord webhooks can't deduplicate a repeated request, so bounded retries accept that risk.
- Keep the stranded check in the daily report: the gate alert can't detect a run cancelled at the gate whose change never deployed.

---

## Dependencies / Assumptions

- A Discord channel and webhook dedicated to deploy notifications must be created. The webhook URL is stored as a secret in a dedicated environment limited to `main` with no reviewer, so code on other branches can never read it and branch dispatches never post.
- Each listed app environment requires a reviewer, per the deploy-gating description in `ARCHITECTURE.md`. Only the gateway environment was checked live during this brainstorm.
- The deploy channel has push notifications enabled for the approver and is not muted.
- GitHub's own pending-deployment notifications (GitHub Mobile, email) are enabled for the approver. Unverified today; confirming them is a rollout check, since they are the fallback when Discord fails.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R3][Technical] Whether the pre-gate notify job lives in each per-app deploy workflow or in one shared reusable workflow, and how much of the Discord posting and retry behavior in `packages/cli/src/commands/cliproxy/monitor.ts` it reuses without growing into a general notification framework.
- [Affects R4][Technical] How router runs that queue behind a deploy concurrency group behave: confirm a queued run posts only when it actually reaches its gate, not when it is queued or superseded.
- [Affects R4, R5][Technical] The retry count and timeout for the post, which failures are retried, and how the warning surfaces on the run.
- [Affects R7][Technical] How the webhook is revoked and rotated if it leaks, and that it is never logged or passed via argv.
- [Affects R7][Technical] Which secret scope (repository secret or a dedicated non-gated environment) makes the webhook available to the notify step without exposing it to unrelated workflows. Also whether reusable-workflow callers must pass it explicitly, given the caller/callee permission and secret-passing rules in `AGENTS.md`.
- [Affects R8][Technical] The exact prompt changes in the daily report's stranded-deploy and per-app deploy checks, which currently tell the agent to "open an issue".

---

## Sources / Research

- `.github/workflows/fro-bot.yaml`: the daily prompt's Deploy Pipeline Health section, including the stranded-deploy check and the per-app "open an issue" instructions.
- `.github/workflows/deploy.yaml`: router jobs that call each `deploy-<app>.yaml`.
- `.github/workflows/cliproxy-auth-monitor.yaml` and `packages/cli/src/commands/cliproxy/monitor.ts`: the existing deterministic Discord webhook sender with bounded retries and 429 handling.
- Issues #1412, #1436, #1437, #1440: currently open deploy-wait issues.
