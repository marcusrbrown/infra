# Operator Surface Acceptance

Browser acceptance checklist for the operator surface at `https://dashboard.fro.bot`. Run it after every paired gateway + dashboard operator-contract upgrade. The pair is `apps/gateway/upstream.json` plus the `image:` line in `apps/dashboard/docker-compose.yaml`; the contract version comes from `/operator/health`. Elsewhere in this runbook, `<expected>` means the contract version of the pair under test.

This runbook lists the complete steps for a full acceptance pass. Routine post-deploy acceptance is run by an agent with [`operator-surface-acceptance-automated.md`](operator-surface-acceptance-automated.md).

Each check lists how to trigger it, what you should see, and what failure looks like. Run the checks in order; [logout](#15-logout-and-csrf) is last because it ends your session.

This runbook does not repeat setup or rotation procedures:

- OAuth app, allowlist, and secrets: [`gateway-operator-auth-lifecycle.md`](gateway-operator-auth-lifecycle.md)
- Network path, firewall, and Caddy route probes: [`gateway-operator-private-path-verification.md`](gateway-operator-private-path-verification.md)
- Push enablement, subscription behavior, and delivery caveats: [`operator-push-enablement.md`](operator-push-enablement.md)

---

## Prerequisites

- A GitHub account on the operator allowlist (numeric user ID allowlist).
- `GET https://dashboard.fro.bot/operator/health` returns `200 {"ok":true,"contractVersion":"<expected>"}`.
- A test repo configured for the gateway, where harmless prompts are acceptable.
- Discord access to the channel the test repo's runs report to (needed for the question settlement check).
- For push checks: a browser with notification permission granted and the service worker registered. On iOS/iPadOS the dashboard must be installed as a standalone PWA. See [`operator-push-enablement.md`](operator-push-enablement.md#step-5-verify-end-to-end-in-the-browser).
- Browser DevTools open on the dashboard tab (Network and Console).

## Safety

- Use the test repo and non-destructive prompts only.
- Never deploy one side of the contract pair alone. Gateway and dashboard move together; see [Rollback](#rollback).
- Do not paste cookies, tokens, or CSRF values anywhere — not into chat, issues, or this runbook. DevTools snippets below keep them in the page.

---

## Paired rollout

1. Confirm the live pair first. `curl -s https://dashboard.fro.bot/operator/health` gives the live contract; the pins on main are the `ref` in `apps/gateway/upstream.json` and the `image:` line in `apps/dashboard/docker-compose.yaml`. If production runs a dashboard tag main does not pin, merge the open "pin image to" audit PR first so the rollback pair matches what runs. See [`dashboard-deploy-proof-replacement-audit-same-target-2026-08-03.md`](../solutions/workflow-issues/dashboard-deploy-proof-replacement-audit-same-target-2026-08-03.md).
2. Merge the gateway pin PR. The Deploy router detects the `apps/gateway/**` change, builds the images, and holds the gateway deploy at the `gateway` environment gate. Do not dispatch Deploy Gateway separately.
3. Each dashboard release dispatches its own Deploy Dashboard run. A waiting run holds the workflow's concurrency group, and a newer dispatch cancels any older pending run (it ends `cancelled` with no jobs). Reject superseded waiting runs through the pending-deployments API and use the run actually waiting at the `dashboard` gate whose release declares the target contract. See [`aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md`](../solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md) and [`approval-gated-run-cancellation-2026-09-02.md`](../solutions/workflow-issues/approval-gated-run-cancellation-2026-09-02.md).
4. With both runs waiting at their gates, approve the gateway, wait until `/operator/health` reports the new `contractVersion`, then approve the dashboard immediately. Expanded run streams fail closed between the two approvals.
5. Run the checks below.

---

## Checks

The run card does not show a run ID. To find one, open the browser devtools Network tab and read the `/operator/runs` response, or check the gateway log (`bunx @marcusrbrown/infra gateway logs gateway`), which records each launch with its run ID, owner, and repo. Gateway logs are lost when the container is recreated, so collect them before the next gateway deploy.

### 1. Health

1. Trigger: `curl -sf https://dashboard.fro.bot/operator/health`
2. Expect: `200 {"ok":true,"contractVersion":"<expected>"}`.
3. Failure: non-200, or a `contractVersion` other than `<expected>`. A wrong version means the pair is mismatched; stop and do not continue.

Record the full JSON.

### 2. Sign-in

1. Trigger: in a signed-out browser, open `https://dashboard.fro.bot/operator/auth/github/start`.
2. Expect: redirect to GitHub, then back to the dashboard's default landing page signed in. If you started from a captured return path, you land on that path instead.
3. Failure: identity JSON displayed in the browser (the default landing path is unavailable), a 5xx at any step, or landing signed out.

### 3. Non-allowlisted account

Skip if no second GitHub account is available; record it as skipped.

1. Trigger: in a private window, sign in via `/operator/auth/github/start` with a GitHub account that is **not** on the allowlist.
2. Expect: a coarse failure with no session created. No 5xx, and no allowlist contents or counts in the response.
3. Failure: a session is created, a 5xx is returned, or the response says anything about the allowlist.

### 4. Contract handshake

1. Trigger: open any run (launch one per check 5 if none exists). In DevTools → Network, select `/operator/runs/<runId>/stream` (type `eventsource`).
2. Expect: the first frame is `event: ready`, and its data carries `contractVersion` equal to the health value from check 1.
3. Failure: no `ready` frame, a different `contractVersion`, or the stream closing immediately. A version mismatch drops streams; treat it as a failed upgrade.

### 5. Launch and stream

1. Trigger: from the dashboard run form, launch a run against the test repo with a short harmless prompt.
2. Expect: the run card appears, output renders live as it streams, and the run reaches a terminal status.
3. Failure: the card stays on "Connecting…", output never renders, or the run never reaches a terminal status.
4. Failure: Launch lists no bound repos and Recent Runs is empty although repos are bound. The gateway's redaction policy did not load, and it denies every repo while the policy is missing. Look for `denylist: refresh failed — no valid last-known-good … denying all` in the gateway log, and check that fro-bot/.github still has its `data` branch. If the branch is missing, dispatch `update-metadata.yaml` on fro-bot/.github to reseed it. The next denylist refresh, within 5 minutes, logs `denylist: refresh succeeded`.

### 6. Single Cancel after completion

1. Trigger: let the run from check 5 finish, then look at the card.
2. Expect: a single Cancel control on the card, disabled or absent, with no duplicate. Pressing it does nothing.
3. Failure: two Cancel controls on one card, or a Cancel control that is still enabled on a finished run.

### 7. Cancel a running run

1. Trigger: launch the question trigger prompt from [check 10](#10-agent-question). While it waits for an answer, press Cancel, then press "Confirm cancel" ("Dismiss" keeps the run going). Never cancel a run whose prompt creates or edits files: the session can keep writing to the shared checkout after the cancel, and the leftovers make every later launch on that repo fail with "Checkout refused: uncommitted changes".
2. Expect: the run's wire status becomes `cancelled`, the card shows the label "Cancelled", and the Cancel control copy reads "Run stopped."
3. Failure: the run keeps streaming after Cancel, the status never becomes `cancelled`, or the label/copy differs.

### 8. Checkout details

1. Trigger: expand the card of a live run.
2. Expect: a region labelled "Checkout details" populated from the run's status frames (`checkoutProvenance` / `checkoutPreparation`).
3. Failure: the region is absent on a live run. That is a gateway projection failure, not a UI quirk; capture the run ID.

### 9. Tool approval

Trigger prompt: "Create the file /tmp/approval-test.txt, then delete it with `rm /tmp/approval-test.txt`." The deploy sets the workspace bash permission policy (`WORKSPACE_PERMISSION_POLICY` in `apps/gateway/src/deploy.ts`) to `ask` for `rm *` and a few other destructive commands, so the `rm` pauses for approval.

Steps 1–4 and the confirmation part of step 5 have been observed live. The gateway log records one `approval.decision` per request (`once`, `reject`, or `always`) but not the command pattern, so neither the card nor the log shows whether the command ran.

Run each of the following on a separate run:

1. Send the trigger prompt. Expect: the card shows a waiting-for-approval status with buttons "Once", "Always", and "Reject".
2. **Once:** press "Once". Expect: the request clears from the card and the run proceeds. Failure: the request stays pending or the run stalls.
3. **Reject:** on a new run, press "Reject". Expect: the request clears from the card and the run ends within about a second. Failure: the request stays pending or the run keeps going. Whether the rejected `rm` was skipped is not visible here.
4. **Collapsed status.** While a request is pending, collapse the card and let the run list refresh. Expect: the card's status badge reads "Waiting for approval". Failure: the collapsed card still reads "Running".
5. **Always:** on a new run, press "Always". Expect: a second control, "Confirm always", appears and nothing is applied until you press it. After confirming, matching requests for the rest of that run no longer prompt (not yet observed: the trigger raises only one request per run); a new run prompts again. Failure: "Always" applies without confirmation, or applies beyond that run.

### 10. Agent question

Trigger prompt (practical, not guaranteed): "Before doing anything, use the question tool to ask me whether to choose A or B."

1. **Render.** Expect: the card shows the question and a waiting-for-question status. Options render as radio buttons for single-choice questions and checkboxes for multiple-choice. Where free text is allowed, an input labelled "Your answer" appears. Buttons: "Submit answers" and "Skip". Failure: no question appears on the card while the run is stalled.
2. **Submit.** Choose an option and press "Submit answers". Expect: the question clears and the run continues.
3. **Skip.** On a separate run, press "Skip". Expect: the question clears and the run continues.
4. **Discord settlement.** On a separate run, answer the same question in Discord. Expect: the question clears from the web card without any action there. Failure: the card keeps showing an answered question.
5. **Run ends with question open.** Launch a run that raises a question, then cancel it or let it end without answering. Expect: the question clears from the card. Failure: a stale question remains on a finished run.
6. **Push.** With push subscribed, raise a question while the dashboard tab is in the background. Expect: a notification titled "Answer needed" with body "A run is waiting for your answer." and no question content. Failure: no notification, a different title/body, or any question text in the notification.
7. **Collapsed status.** While a question is open, collapse the card and let the run list refresh. Expect: the card's status badge reads "Waiting for answer". Failure: the collapsed card still reads "Running".

### 11. Expired output

The gateway keeps terminal replay snapshots in memory for 10 minutes (at most 500 entries or 8 MiB; the oldest are evicted first). A gateway restart discards them.

1. Trigger: open a run that finished more than 10 minutes ago, or any finished run after a gateway restart.
2. Expect: the card shows the run's final status and "Output no longer available."
3. Failure: the card sits on "Connecting…", or shows no status.

### 12. Push

Subscribe first if needed; see [`operator-push-enablement.md`](operator-push-enablement.md#step-5-verify-end-to-end-in-the-browser).

1. Question delivery: covered by [check 10, step 6](#10-agent-question); tapping the notification is covered by [check 13](#13-question-notification-deep-link).
2. Approval-pending and run-failed delivery: trigger one of each and expect a notification to arrive in the browser. These are regression spot checks.
3. Push health: while signed in, run `(await fetch('/operator/session', { credentials: 'same-origin' }).then(r => r.json())).push` in the DevTools Console. Expect: `{status: "ready"}` after the deliveries above. `degraded` or `unknown` is a failure to investigate; see [`operator-push-enablement.md`](operator-push-enablement.md#post-boot-push-health). An absent field means push is not configured.
4. Failure: no notification arrives. A `401` from the push routes proves only that they are mounted, not that delivery works; see the caveats in [`operator-push-enablement.md`](operator-push-enablement.md#critical-operational-caveats).

### 13. Question notification deep link

Push subscribed; raise a question with the trigger prompt from [check 10](#10-agent-question).

1. **Dashboard open.** Leave the dashboard open in a tab and tap or click the "Answer needed" notification. Expect: the browser focuses the dashboard window and the run that raised the question opens, with the run ID as the URL fragment. If the tab was loaded before the current service worker took control, a new window opens instead; reload the tab and repeat.
2. **Dashboard closed.** Close every dashboard tab or window, raise a question, and tap the notification. Expect: a new window opens at `/#<runId>` with that run open. Failure: the window opens at `/` with no run open.
3. **iOS/iPadOS.** Repeat steps 1 and 2 with the installed PWA, once with it backgrounded and once with it closed.
4. **Approval notification.** Raise an approval with the trigger prompt from [check 9](#9-tool-approval) and tap the approval notification. Expect: the run that is waiting opens with "Once", "Always", and "Reject" showing. Observed live with the dashboard open.
5. Failure for any step: the dashboard is not focused or opened, the wrong run opens, or the notice "That run isn't in your recent runs." appears for a run that is in the list.

### 14. Session durability

Operator sessions live in the gateway's object store and survive restarts. Run this after the first deploy that carries durable sessions, and again if the session-store grant changes. Steps 1 and 2 need shell access to the gateway droplet.

1. Trigger: read the gateway log right after the deploy (`bunx @marcusrbrown/infra gateway logs gateway`).

   - Expect: a `session restore finished` line, and an `auth.session.restore` audit event with `outcome: "ready"`.
   - Failure: no such line, or an outcome other than `ready`. Logins then return `503`. Fix the `operator-web/sessions/*` and `operator-web/_self-test/*` grants ([S3 State-Bucket IAM Actions](../../apps/gateway/AGENTS.md#s3-state-bucket-iam-actions)), then restart the gateway.

2. Trigger: while signed in, confirm the session works, restart the gateway on the droplet (`docker compose --project-directory /opt/gateway/deploy restart gateway`), wait for it to be healthy, then repeat the request in the same tab without signing in again.

   ```js
   ;(await fetch("/operator/session", {credentials: "same-origin"})).status
   ```

   Expect: `200` before and after the restart, with the same cookie. Failure: `401` after the restart, which means the session did not survive.

3. Trigger: in a tab that stayed open across the upgrade, perform a state-changing action (for example, launch a run). Each operator signs in once after the upgrade, and a CSRF token issued before the upgrade fails once.

   - Expect: the first request fails with `400` (`browser guard: CSRF token invalid` in the gateway log), the dashboard fetches a new token from `/operator/session/csrf`, and the retry succeeds.
   - Failure: the request keeps failing after a fresh token, or the dashboard never fetches a new one. This step applies only to the first deploy that carries durable sessions.

### 15. Logout and CSRF

Do this last. All snippets run in the DevTools Console on `https://dashboard.fro.bot`; the token stays in a page variable and is never printed.

1. Trigger: fetch the CSRF token.

   ```js
   const {csrfToken} = await fetch("/operator/session/csrf", {credentials: "same-origin"}).then(r => r.json())
   ```

   Expect: the request returns `{"csrfToken": "..."}`. Failure: 401 while signed in, or no `csrfToken` field.

2. Trigger: log out with the token in the `x-csrf-token` header.

   ```js
   const res = await fetch("/operator/auth/logout", {
     method: "POST",
     credentials: "same-origin",
     headers: {"x-csrf-token": csrfToken},
   })
   res.status
   ```

   Record the status code. Step 3 is the proof that logout worked. Failure: a 403 with a freshly fetched token, or a 5xx.

3. Trigger: check the old session.

   ```js
   ;(await fetch("/operator/session", {credentials: "same-origin"})).status
   ```

   Expect: `401`. Failure: any 2xx, which means the session survived logout.

Logout deletes only that session: a separate browser signed in earlier stays signed in, and a gateway restart ends none of them: sessions are durable and last a fixed seven days from sign-in. For what logout does to push subscriptions, see [`operator-push-enablement.md`](operator-push-enablement.md#critical-operational-caveats).

### 16. Launch prompt

The gateway accepts a launch prompt of up to 8,000 UTF-16 units, so an emoji counts as 2, and stores it exactly as typed. Generate test prompts that end in an emoji right at the limit, for example: `bun -e 'const s = "Reply with only the word OK. "; await Bun.write("/tmp/prompt-8000.txt", s + "x".repeat(8000 - s.length - 2) + "\u{1F680}")'`, and the same with `8001`. Copy one with `pbcopy < /tmp/prompt-8000.txt`.

1. **Rendering.** Launch with `Reply with only the word OK. <img src=x onerror=alert(1)> <b>bold tag</b> **markdown bold** [link](https://example.com)`. Expect: the collapsed card shows a one-line plain-text preview. The expanded card renders the prompt as Markdown: the `<img>` and `<b>` tags stay literal, nothing runs, and the link shows its host next to it. Failure: an image renders, an alert fires, or HTML is interpreted.
2. **At the limit.** Launch with an 8,000-unit prompt. Expect: the run starts, and its prompt ends in the emoji.
3. **Over the limit.** Paste an 8,001-unit prompt. Expect: the launch is refused, an inline status says the prompt is too long, and no run is created. The Launch button is disabled while the prompt is over the limit; an enabled button is a regression ([fro-bot/dashboard#676](https://github.com/fro-bot/dashboard/issues/676), closed).
4. **Provider failure reason.** A run that fails with `session-error` because of the model provider shows a label such as "Model provider unavailable", "Model not available", or "Model provider rejected the request", both live and after a run-list reload. No safe trigger exists, so record this only when such a failure occurs. Not yet observed.

---

## Outstanding acceptance

Not covered by the checks above. Tracked at [fro-bot/.github#3512](https://github.com/fro-bot/.github/issues/3512):

- Production-shaped redaction and denylist verification, with public and denylisted repos together.
- Post-merge dashboard and infrastructure security review.
- Privacy runtime confirmation.

---

## Rollback

Rollback is paired: revert gateway and dashboard together to the previous contract pair. Never revert only one side, and never revert only `apps/gateway/upstream.json`. See [Rollback is not pin reversal](../../apps/gateway/AGENTS.md#rollback-is-not-pin-reversal) and [`dashboard-released-image-rollback.md`](dashboard-released-image-rollback.md).

---

## Record results

Comment on [fro-bot/.github#3512](https://github.com/fro-bot/.github/issues/3512) with:

- The health JSON from check 1.
- The `contractVersion` from the `ready` frame in check 4.
- Pass, fail, or skipped for each numbered check.
- Run IDs for every failure, and for checks 7–11 and 13.

Do not include cookies, tokens, CSRF values, or notification endpoints.

---

## Related

- [`apps/gateway/AGENTS.md`](../../apps/gateway/AGENTS.md) — operator listener, contract pairing, rollback
- [`apps/dashboard/AGENTS.md`](../../apps/dashboard/AGENTS.md) — dashboard deploy and operator UI
- [`gateway-operator-auth-lifecycle.md`](gateway-operator-auth-lifecycle.md) — auth secrets and allowlist
- [`gateway-operator-private-path-verification.md`](gateway-operator-private-path-verification.md) — private path controls
- [`operator-push-enablement.md`](operator-push-enablement.md) — push enablement and caveats
