---
date: 2026-07-21
topic: cliproxy-anthropic-auth-monitoring
---

# CLIProxyAPI Anthropic Auth Monitoring

## Summary

Add a scheduled health probe that detects a dead upstream Anthropic OAuth credential on the CLIProxyAPI proxy within ~15 minutes and alerts the operator through a deduplicated GitHub issue and an immediate Discord notification, so the manual re-auth happens fast instead of after a red CI run.

---

## Problem Frame

The proxy authenticates upstream to Anthropic with a stored OAuth credential and auto-refreshes it every 15 minutes. When the refresh token expires, the refresh fails and the proxy silently writes back a dead credential with no alert. From that point every Anthropic-routed request returns `503 auth_unavailable (providers=claude)`, and every consumer repo running Claude in CI fails — or hangs to its timeout ceiling — until a human notices.

This has now happened twice: 2026-06-20 and 2026-07-21, roughly 31 days apart. Both outages were discovered only when a red or hung CI run was spotted by hand, after hours of silent failure. The single shared upstream credential is a point of failure for every Anthropic-routed repo at once, so the cost multiplies across every such repo and every CI run inside the outage window. The re-auth itself is a ~2-minute operator action — the expensive part is not knowing the credential is dead.

---

## Actors

- A1. Operator (Marcus): receives the alert and performs the manual re-auth (`cliproxy login claude`).
- A2. Scheduled probe: runs on a cadence, evaluates upstream Anthropic auth, and drives alert transitions.
- A3. Consumer repos: downstream repositories whose CI routes Claude requests through the proxy; the silent victims of a dead credential.

---

## Requirements

**Scheduled detection**
- R1. Reuse the existing `checkProviderAuth` detection logic (the end-to-end 1-token completion probe that flags `401` and `503 auth_unavailable`) rather than reimplementing route-dead semantics — one source of truth shared with `cliproxy status`.
- R2. Run the probe on a fixed 15-minute cadence.
- R3. The probe needs a downstream API key and the proxy URL available to the scheduled runner, scoped as secrets to a protected scheduled workflow — no pull-request trigger, and no secret-bearing value echoed to logs.
- R4. Classify only a definitive auth-dead result (`401`, or `503` with `auth_unavailable` markers) as `dead`. A transient or transport failure (network error, timeout, unrelated non-2xx — the cases `checkProviderAuth` returns as a warning) is not a `dead` state and must not drive a transition on its own.

**Transition-based alerting**
- R5. Alert only on a state change. `healthy→dead` fires a failure alert; `dead→healthy` fires a recovery alert. Between transitions the probe is silent.
- R6. Persist the prior probe result across runs so transitions can be detected, since scheduled runs are otherwise stateless.
- R7. Bootstrap the state on first run or missing/unreadable prior state: record the current result as the baseline, and if that first observed result is already `dead`, fire the failure alert (never let a missing baseline swallow an active outage).
- R8. On `healthy→dead`: open or reopen a single deduplicated tracking issue recording the outage, and send a Discord notification.
- R9. On `dead→healthy`: auto-close the tracking issue and send a Discord recovery notification.

**Alert content and safety**
- R10. Alerts carry the actionable remediation (`cliproxy login claude`) and never include secret material (downstream API key, management key, OAuth tokens).
- R11. Emit only fixed status text plus the remediation in alerts and the tracking issue — do not echo raw upstream HTTP response bodies, error strings, or composed URLs, which can carry credentials or proxy internals.

---

## Acceptance Examples

- AE1. **Covers R5, R8.** Given the route was healthy on the previous run, when the probe detects `503 auth_unavailable`, then one tracking issue is opened (or reopened) and one Discord failure notification is sent.
- AE2. **Covers R5.** Given the route was already dead on the previous run, when the probe again detects it dead, then no new issue is opened and no Discord notification is sent.
- AE3. **Covers R5, R9.** Given the route was dead on the previous run, when the probe detects it healthy, then the tracking issue is closed and a Discord recovery notification is sent.
- AE4. **Covers R4.** Given the route was healthy on the previous run, when the probe run hits a network timeout (not an auth failure), then the state stays healthy and no alert fires.
- AE5. **Covers R7.** Given no prior state exists (first run), when the probe detects the route is already dead, then the baseline is recorded and a failure alert fires immediately.
- AE6. **Covers R10, R11.** Given any alert fires, when its message is composed, then it contains no API key or management key, includes the `cliproxy login claude` remediation, and echoes no raw upstream response body.

---

## Success Criteria

- A dead Anthropic route is surfaced to the operator within ~15 minutes of going dead — via a durable issue and an immediate Discord ping — instead of whenever a CI run is noticed red.
- No alert noise while a known outage persists; a positive recovery signal confirms the re-auth worked.
- Detection semantics stay single-sourced: the scheduled probe and `cliproxy status` cannot drift on what "route dead" means.
- A downstream planner can implement without inventing where detection lives, what "dead" means, or how transitions are tracked.

---

## Scope Boundaries

- No automated re-auth. CLIProxyAPI has no headless login path (the OAuth flow redirects to `localhost:54545` with a manual paste fallback), so the browser-based re-auth stays a human action.
- No pre-emptive expiry reminder. Getting ahead of the credential expiry is deferred until the ~30-day refresh-token TTL is confirmed rather than hypothesized.
- No route redundancy or provider failover. Degrading instead of hard-failing consumer CI is a larger change to routing behavior, out of scope here.
- Anthropic-focused. The probe targets the Anthropic route (the credential class that has expired); generalizing to other providers is not in scope unless it falls out for free.

---

## Key Decisions

- Detect-and-alert, not auto-fix: no headless re-auth path exists in CLIProxyAPI (confirmed from source), so the durable win is fast, legible detection.
- Both alert channels: a GitHub issue for the durable, deduplicated record and a Discord notification for real-time immediacy — rather than choosing one.
- Transition-only with auto-recovery: at 15-minute cadence this yields one clean signal per outage plus a recovery confirmation, instead of ~96 alerts/day.
- Reuse `checkProviderAuth`: the detection primitive already exists and is surfaced via `cliproxy status` and the MCP bridge; the gap is that nothing runs it on a schedule.
- Only definitive auth-dead (`401` / `503 auth_unavailable`) drives a transition; transient/transport failures are treated as non-events, so a network blip cannot fire a false outage or spuriously auto-close a real one.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R6][Needs research] Where prior probe state lives so transitions survive stateless scheduled runs — the tracking issue's own open/closed state could double as the persisted state (dedup + state in one), versus a committed state file or run artifact.
- [Affects R8, R9][Technical] Discord delivery mechanism — reuse the existing gateway webhook surface or provision a dedicated Discord webhook secret for the scheduled job.
- [Affects R2][Needs research] Whether GitHub Actions `schedule:` is reliable enough at 15-minute granularity, given documented cron delay/skips under load, or whether the cadence needs a tolerance margin.
- [Affects R2][Technical] Dead-man's-switch for the monitor itself: if the scheduled workflow is disabled, cron silently skips, or a run errors before probing, the detector fails silent — the exact blind spot being solved. Decide whether GitHub's native workflow-failure notifications suffice or an external heartbeat is warranted.
- [Affects R8, R9][Technical] Partial alert delivery: if one channel fails (Discord down, or issue API errors) while the other succeeds, decide whether to retry, degrade gracefully, or surface the delivery failure itself.

---

## Sources / Research

- `packages/cli/src/commands/cliproxy/status.ts` — `checkProviderAuth`: the existing detection primitive (`401` / `503 auth_unavailable` → error with `run: cliproxy login claude`), already surfaced via `cliproxy status` and MCP `cliproxy_status`.
- `docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md` — first occurrence; its Prevention section already names a scheduled Anthropic probe as the candidate guardrail.
- Incident 2026-07-21 — second occurrence, ~31 days after the first; recurrence is the core signal and the source of the hypothesized ~30-day refresh-token TTL (n=2, unconfirmed).
- CLIProxyAPI login flow (`router-for-me/CLIProxyAPI`): fixed `localhost:54545` OAuth callback with a manual paste fallback and no headless path — the basis for detect-and-alert over auto-fix.
- `.github/workflows/` — no existing scheduled cliproxy or auth-probe workflow (verified); this capability is net-new.
