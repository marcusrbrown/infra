# Operator Surface Acceptance

Browser acceptance checklist for the operator surface at `https://dashboard.fro.bot`. Run it after every paired gateway + dashboard operator-contract upgrade. Current pair: gateway `fro-bot/agent` v0.119.2 + dashboard 2026.10.20, operator contract 1.9.0. Elsewhere in this runbook, `<expected>` means the contract version of the pair under test.

Each check lists how to trigger it, what you should see, and what failure looks like. Run the checks in order; [logout](#13-logout-and-csrf) is last because it ends your session.

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

## Checks

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

### 6. Single Cancel after completion

1. Trigger: let the run from check 5 finish, then look at the card.
2. Expect: a single Cancel control on the card, disabled or absent, with no duplicate. Pressing it does nothing.
3. Failure: two Cancel controls on one card, or a Cancel control that is still enabled on a finished run.

### 7. Cancel a running run

1. Trigger: launch a longer harmless task, such as "Summarize each file in the repo, one by one." While it is running, press Cancel.
2. Expect: the run's wire status becomes `cancelled`, the card shows the label "Cancelled", and the Cancel control copy reads "Run stopped."
3. Failure: the run keeps streaming after Cancel, the status never becomes `cancelled`, or the label/copy differs.

### 8. Checkout details

1. Trigger: expand the card of a live run.
2. Expect: a region labelled "Checkout details" populated from the run's status frames (`checkoutProvenance` / `checkoutPreparation`).
3. Failure: the region is absent on a live run. That is a gateway projection failure, not a UI quirk; capture the run ID.

### 9. Tool approval

> **TODO:** the trigger is not established. The managed workspace OpenCode config sets no permissions, so which tool prompts for approval is not known. Trigger: a prompt that causes a permission request — not yet established; record the prompt that works here once found.

The button labels below come from the dashboard source. The outcomes after each press are expected behavior that has not been observed live yet; correct them here after the first run.

Run each of the following on a separate run:

1. Trigger a permission request (see TODO). Expect: the card shows a waiting-for-approval status with buttons "Once", "Always", and "Reject".
2. **Once:** press "Once". Expect: the request clears from the card and the run proceeds. Failure: the request stays pending or the run stalls.
3. **Reject:** on a new run, press "Reject". Expect: the request clears from the card. Failure: the request stays pending or the tool still executes.
4. **Always:** on a new run, press "Always". Expect: a second control, "Confirm always", appears and nothing is applied until you press it. After confirming, matching requests for the rest of that run no longer prompt; a new run prompts again. Failure: "Always" applies without confirmation, or applies beyond that run.

### 10. Agent question

Contract 1.9.0.

Trigger prompt (practical, not guaranteed): "Before doing anything, use the question tool to ask me whether to choose A or B."

1. **Render.** Expect: the card shows the question and a waiting-for-question status. Options render as radio buttons for single-choice questions and checkboxes for multiple-choice. Where free text is allowed, an input labelled "Your answer" appears. Buttons: "Submit answers" and "Skip". Failure: no question appears on the card while the run is stalled.
2. **Submit.** Choose an option and press "Submit answers". Expect: the question clears and the run continues.
3. **Skip.** On a separate run, press "Skip". Expect: the question clears and the run continues.
4. **Discord settlement.** On a separate run, answer the same question in Discord. Expect: the question clears from the web card without any action there. Failure: the card keeps showing an answered question.
5. **Run ends with question open.** Launch a run that raises a question, then cancel it or let it end without answering. Expect: the question clears from the card. Failure: a stale question remains on a finished run.
6. **Push.** With push subscribed, raise a question while the dashboard tab is in the background. Expect: a notification titled "Answer needed" with body "A run is waiting for your answer." and no question content. Failure: no notification, a different title/body, or any question text in the notification.

### 11. Expired output

The gateway keeps terminal replay snapshots in memory for 10 minutes (at most 500 entries or 8 MiB; the oldest are evicted first). A gateway restart discards them.

1. Trigger: open a run that finished more than 10 minutes ago, or any finished run after a gateway restart.
2. Expect: the card shows the run's final status and "Output no longer available."
3. Failure: the card sits on "Connecting…", or shows no status.

### 12. Push

Subscribe first if needed; see [`operator-push-enablement.md`](operator-push-enablement.md#step-5-verify-end-to-end-in-the-browser).

1. Question delivery: covered by [check 10, step 6](#10-agent-question). This is the check specific to contract 1.9.0.
2. Approval-pending and run-failed delivery: trigger one of each and expect a notification to arrive in the browser. These are regression spot checks.
3. Failure: no notification arrives. A `401` from the push routes proves only that they are mounted, not that delivery works; see the caveats in [`operator-push-enablement.md`](operator-push-enablement.md#critical-operational-caveats).

### 13. Logout and CSRF

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

Logout deletes only that session: a separate browser signed in earlier stays signed in, and a gateway restart clears every session. For what logout does to push subscriptions, see [`operator-push-enablement.md`](operator-push-enablement.md#critical-operational-caveats).

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
- Run IDs for every failure, and for checks 7–11.
- The working approval prompt, once found (check 9).

Do not include cookies, tokens, CSRF values, or notification endpoints.

---

## Related

- [`apps/gateway/AGENTS.md`](../../apps/gateway/AGENTS.md) — operator listener, contract pairing, rollback
- [`apps/dashboard/AGENTS.md`](../../apps/dashboard/AGENTS.md) — dashboard deploy and operator UI
- [`gateway-operator-auth-lifecycle.md`](gateway-operator-auth-lifecycle.md) — auth secrets and allowlist
- [`gateway-operator-private-path-verification.md`](gateway-operator-private-path-verification.md) — private path controls
- [`operator-push-enablement.md`](operator-push-enablement.md) — push enablement and caveats
