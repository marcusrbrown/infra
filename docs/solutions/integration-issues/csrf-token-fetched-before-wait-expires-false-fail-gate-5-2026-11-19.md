---
title: "A CSRF token fetched before a wait expired at the quarter-hour boundary and failed Gate 5"
date: 2026-11-19
problem_type: integration_issue
component: authentication
severity: medium
module: docs/runbooks/operator-surface-acceptance-automated.md
root_cause: async_timing
resolution_type: documentation_update
symptoms:
  - "A dashboard decision POST returns 400 with no state although the approval ask is still open"
  - "The gateway logs browser.guard.rejected with reason csrf_invalid"
  - "The run stays waiting_for_approval until the gateway's approval deadline rejects the ask"
  - "The same script passed on the previous release"
tags: [csrf, operator-api, release-gates, gate-5, token-lifetime, intermittent, false-failure, acceptance]
---

# A CSRF token fetched before a wait expired at the quarter-hour boundary and failed Gate 5

## Problem

Gate 5 of the gateway release gates scored a failure on agent v0.146.0 that the gateway did not cause. The control run's approval decision returned `400`, the run stayed at `waiting_for_approval`, and the gate scored G5.1 `fail` with G5.3 and G5.4 `blocked`. The cause was in the runbook's in-page decider: it fetched its CSRF token once at the start, then waited 60 seconds before it used the token.

## Symptoms

- The decision POST returned `400` and the response had no `state`.
- The gateway logged `browser guard: CSRF token invalid` and the audit event `browser.guard.rejected` with `reason: csrf_invalid`.
- The run stayed `waiting_for_approval` for 13 minutes. Then the gateway rejected the ask itself: `ApprovalRegistry: deadline expired on open entry — fail-closed`, followed by a forwarded `reject`. No operator decided it.
- While it waited, the run held the repo's queue. The idle check counts a waiting run as active, so it would have blocked a restart.
- The same decider had passed Gate 5 on the previous release.

## What Didn't Work

- **Reading the `400` as a product failure.** The runbook scores any decision other than `200` `claimed` as a fail, so the score was correct and said nothing about the cause.
- **Asking the log which token fault it was.** Every token fault logs the same `csrf_invalid`. The log does not say "expired".
- **Reading the forwarded `reject` as an operator's decision.** A reject from the approval deadline and a reject from a person produce the same `permission.replied forwarded` line. Only the deadline line before it, and the missing `approval.decision` audit line, tell them apart.

## Solution

Fetch the token right before each decision. The decider in [Gate 5](../../runbooks/operator-surface-acceptance-automated.md#gate-5-rejected-command-does-not-run) now does this:

<!-- prettier-ignore -->
```js
        const {csrfToken} = await fetch("/operator/session/csrf", {credentials: "same-origin"}).then(r => r.json())
        const decidedAt = new Date().toISOString()
```

The control and probe decisions then returned `200` `claimed`.

## Why This Works

A token's life follows the clock, not its age. In fro-bot/agent v0.146.0, `packages/gateway/src/web/auth/csrf.ts` binds a token to a 15-minute interval (`CSRF_TOKEN_INTERVAL_MS`). `verifyCsrfToken` accepts a token from the current interval, and a token from the previous interval for 30 seconds after the boundary (`CSRF_TOKEN_GRACE_MS`). So every token dies 30 seconds after the next :00, :15, :30 or :45, and a token fetched at :29:59 lives for 31 seconds.

The decider fetched its token when it started, 104 seconds before it sent the decision at 06:31:03. The decision came 63 seconds after the 06:30:00 boundary. A fetch right before the POST leaves a gap of milliseconds.

The fault needs a boundary to fall inside the wait, more than 30 seconds before the request. With a 104-second gap that window is about 74 seconds of every 15 minutes, so if start times are spread evenly, about one run in twelve fails. This is why the script passed before and why a pass does not clear it.

## Prevention

- A script that waits or polls fetches its CSRF token right before each request that changes state.
- Score the check by the runbook. Then, for a `400` with no `state`, look for `csrf_invalid` in the gateway log and check whether a quarter-hour boundary fell between the token fetch and the request.
- An approval that nobody decides does not stay open. The gateway rejects it when its approval deadline expires, and a rejected command does not run. In v0.146.0 the deadline is capped at 13 minutes and is shorter when the run has less time left (`computeApprovalDeadlineMs` in `packages/gateway/src/execute/run.ts`).

## Related

- [Gate 5: rejected command does not run](../../runbooks/operator-surface-acceptance-automated.md#gate-5-rejected-command-does-not-run)
- [Gate a human-only release check on a last-pass anchor and a diff trigger](../best-practices/anchor-gated-conditional-human-pass-for-release-gates-2026-11-10.md)
