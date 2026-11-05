---
title: "OpenCode Go through CLIProxyAPI: the session header, double listing, the billing_source signal and key scope"
date: 2026-11-05
module: apps/cliproxy
problem_type: integration_issue
component: tooling
severity: medium
symptoms:
  - "Go inference answers HTTP 400 MissingSessionID to any request without x-opencode-session, and CLIProxyAPI forwards no client headers on an openai-compatibility upstream unless mapped"
  - "A 200 from Go does not say which plan paid; only usage.opencode.billing_source (go or balance) does"
  - "/v1/models lists every Go model twice, as glm-5.3 and opencode-go/glm-5.3, both with owned_by opencode-go"
  - "A cliproxy Environment secret is unreadable by the router's deploy-cliproxy caller job, which has no environment"
  - "Merging the change put the monitor's Go probe on main before the gated deploy created the live entry, which opened the Go provider-missing issue #1807"
root_cause: config_error
resolution_type: config_change
tags:
  [cliproxy, opencode-go, openai-compatibility, session-header, billing-source, monitor, github-secrets, deploy-gate]
related_components:
  - development_workflow
---

# OpenCode Go through CLIProxyAPI: the session header, double listing, the billing_source signal and key scope

## Problem

OpenCode Go is served to consumer repos and the gateway workspace as one `openai-compatibility` upstream, `opencode-go`, on the CLIProxyAPI deployment. A plain OpenAI-compatible route is not enough. Go enforces a session header that the proxy does not forward on its own. Every model is listed under two ids. Whether a request was billed to the Go plan or to the pay-as-you-go balance is visible only in the response body. The upstream key has to live where the router's deploy job can read it. Each of these fails in a way the usual deploy checks do not catch.

## Symptoms

Only the last item happened in production. The others were found by probes against Go and a disposable CLIProxyAPI, from CLIProxyAPI source, or in review, before the first deploy.

- Go answers HTTP 400 `MissingSessionID` to any request that lacks `x-opencode-session`. The OpenCode client adds the header only for providers whose id starts with `opencode`, so any other client or probe sends none.
- A request can return 200 and be billed to either the Go plan or the balance. `/v1/models` and a bare status check look healthy either way.
- `/v1/models` lists each model bare (`glm-5.3`) and prefixed (`opencode-go/glm-5.3`). A duplicate or a collision with another provider is invisible unless something checks both forms.
- An upstream key stored as a `cliproxy` Environment secret would be empty in the router's deploy job. Environment secrets are unreadable through a called workflow (actions/runner#4453).
- Merging the change put the monitor's Go probe on `main` while the live proxy still had no Go entry. The monitor reported `provider-missing` and opened issue #1807. The first healthy probe after the gated deploy closed it.

## What Didn't Work

- **Relying on the client to send the header.** OpenCode adds `x-opencode-session` for providers whose id starts with `opencode`, as observed with a local echo server (`docs/brainstorms/2026-11-04-opencode-go-behind-cliproxy-requirements.md`). The deploy smoke request, the monitor probe and `cliproxy status` are not that client, so each has to send its own value.
- **Expecting the proxy to pass headers through.** CLIProxyAPI does not forward arbitrary client headers on an `openai-compatibility` upstream. Without an explicit mapping, Go never sees the header.
- **Treating a listed model or a 2xx as proof of routing.** A model in `/v1/models` proves registration only. A 2xx proves a response only. Neither says which plan was billed.
- **Using the Console for plan status.** The OpenCode Console has no API for plan status or remaining limits. The response body is the only signal.
- **Storing the upstream key as an Environment secret.** The router's caller job has no environment, so it cannot read one.
- **Minting the Go credential with the broker.** The broker builds its auth payload for two providers only. `buildAuthJson` in `apps/broker/src/server.ts` returns a bare provider map keyed `anthropic` and `openai`, each `{type, key}`, with no base URL and no `opencode-go` entry. Tracked upstream in [fro-bot/agent#2078](https://github.com/fro-bot/agent/issues/2078). A Go repo gets its key from `agent setup`.

## Solution

### Map the session header, and send it from every probe

`buildGoEntry` in `apps/cliproxy/src/deploy.ts` copies the client's header onto the upstream request:

<!-- prettier-ignore -->
```ts
// Maps the client's own header onto the upstream request; the proxy never forwards headers wholesale.
headers: {[GO_SESSION_HEADER]: '$X-Opencode-Session'},
```

The header is omitted upstream when the client sent none. The deploy smoke request (`runGoSmokeRequest`) and the monitor probe (`runGoRouteProbe` in `packages/cli/src/commands/cliproxy/status.ts`) each send a fresh `x-opencode-session`. Because the probes always send it, a `MissingSessionID` answer to a probe points at the proxy mapping first. It is classified as the dead reason `session-header-dropped`.

### Check both ids, and refuse collisions

The entry sets `prefix` and maps each model name to itself, so the proxy lists both forms, owned by `opencode-go`. Both route, and the response `model` is always the bare id.

- `visibilityProblems` requires every eligible id, bare and prefixed, to appear exactly once under `owned_by: opencode-go`. It also reports any Go-owned id that is not eligible.
- `findCollisions` fails the deploy when an eligible id is already served by another provider:

  <!-- prettier-ignore -->
  ```ts
  const wanted = new Set(eligible.flatMap(id => [id, `${GO_ENTRY_NAME}/${id}`]))
  return served.filter(model => wanted.has(model.id) && model.ownedBy !== GO_ENTRY_NAME)
  ```

- `listedGoIds` in `status.ts` strips the prefix and de-duplicates, so the monitor works with bare ids.
- Clients use `opencode-go/<bare id>` as the model id. The gateway deploy guard checks the base URL of the provider named by that prefix (`apps/gateway/AGENTS.md`, "OpenCode Go through the proxy").

### Make `billing_source` the pass condition

2xx responses carry `usage.opencode.billing_source`: `go` for plan traffic, `balance` for pay-as-you-go. The proxy preserves it. Both the deploy and the monitor require `go`.

`runGoSmokeRequest` (one non-streaming request at `max_tokens: 1`, billed to Go) raises `OpenCodeGoUnverifiedError` otherwise:

<!-- prettier-ignore -->
```ts
if (billing !== 'go') {
  const seen = typeof billing === 'string' ? JSON.stringify(billing.slice(0, 32)) : 'missing'
  throw new OpenCodeGoUnverifiedError('smoke request', `billing_source was ${seen}, expected "go"`)
}
```

`runGoRouteProbe` returns `ok` only when `billingSourceOf(bodyText) === 'go'`. Any other 2xx is `billing-not-go`. The runbook's first response to an unexpected value is to disable the entry and then check the Console (`docs/runbooks/cliproxy-opencode-go.md`, "Applied but unverified").

### Classify the monitor reasons separately from Claude's

`GoRouteReason` in `status.ts` is its own union. `GO_PROBE_REASON_STATE` in `packages/cli/src/status/monitor-state.ts` maps every member to a state, so adding a reason fails type-check until it is classified. A Claude probe line can never carry a Go-only reason. The reason table lives in `apps/cliproxy/AGENTS.md`, "OpenCode Go route" under "ANTHROPIC AUTH MONITOR". A 429 or 402 counts as `quota-or-billing` (dead) only on the chat-completion request; the same statuses on `/v1/models` are `unrelated-http` (unknown).

The monitor reads the committed `settings.json` and skips Go entirely when `enabled` is false: no probe, no line, no issue, no alert. Only `live` validation probes Go. Reconciliation is transition-based and separate from the Claude route: a dead transition opens or reopens the Go issue and sends an outage message, a healthy transition closes it and sends recovery, repeated states send nothing new, and an unknown result changes nothing.

### Place the keys where the router can read them

- `CLIPROXY_OPENCODE_GO_KEY` (the upstream key) and `CLIPROXY_API_KEY` (the downstream key the deploy and monitor use) are repository secrets, not `cliproxy` Environment secrets. The router's caller job has no environment. `.github/workflows/deploy.yaml` passes both explicitly to `deploy-cliproxy.yaml`, which declares both as optional.
- A personal Console key on the Go workspace was verified to bill `go`; whether service-account keys draw on the Go plan is untested.
- Only the deploy's own HTTP calls use these keys. `childProcessEnv` removes both from the `ssh` and `scp` environment, via `HTTP_ONLY_ENV_KEYS`.
- Disabled mode needs neither key. `preflightOpenCodeGo` requires the Go key, the downstream key and the management key only when `enabled` is true, and fails before any SSH when one is missing.
- Anyone holding the management key can read the Go key in clear, as they already can the downstream keys.
- Consumer repos reuse their one proxy key for the `opencode-go` provider. `apps/cliproxy/AGENTS.md` shows the three-provider `OPENCODE_CONFIG` and `OPENCODE_AUTH_JSON`.

## Why This Works

- The explicit header mapping is the only path by which the client's session id reaches Go, and every probe supplies its own, so the monitor classifies that failure with one specific reason instead of scattered client errors.
- `billing_source` is the one field that distinguishes plan traffic from balance traffic. Requiring it in both the deploy and the monitor turns a silent cost leak into a failed deploy or a dead route.
- Checking both ids once each, owned by the right provider, makes the double listing a verified contract instead of an accident.
- Passing the secrets explicitly from the router moves them out of the one place the caller job cannot read, and stripping them from the SSH child environment keeps them out of remote commands.

## Prevention

- Treat any new OpenAI-compatible upstream as three questions: which headers does it require, how are its models listed, and what in the response proves what was billed. Probe the real endpoint before writing the entry.
- Keep deploy-time proof and monitor-time proof on the same signals. The smoke request and the monitor probe both require `billing_source: go`, so a regression is caught by whichever runs first.
- Store secrets read by the router's caller job as repository secrets, and pass them explicitly to the called workflow. Never use `secrets: inherit` with a cross-org reusable workflow.
- Never pass the upstream key or the downstream key through `ssh` or `scp` environment or argv.

### Merge-to-deploy window

The monitor reads the committed `settings.json` and probes the live proxy. Merging a change that enables the Go route therefore starts the Go probe on `main` while the cliproxy deploy that creates the live entry still waits at its approval gate. In that gap the probe reports `provider-missing` and opens the Go issue. Issue #1807 is the observed instance. The first healthy probe after the deploy closes the issue and sends the recovery message. No action is needed beyond approving the gate (`docs/runbooks/cliproxy-opencode-go.md`, "Merge before deploy").

Known limits, not fixed:

- Setting `enabled: false` stops Go monitoring when the PR merges, before the deploy disables the live entry. The Go issue stays open until it is closed by hand (runbook, "Emergency disable without a deploy").
- Any single 429 or 402 on the completion request is classified `quota-or-billing`, which is dead. `monitor.ts` and `monitor-state.ts` apply no consecutive-failure threshold, so one transient limit response can open and then close an issue.
- A model that lost eligibility in a merged snapshot PR stays served until the deploy is approved. The monitor reports `privacy-noncompliant` meanwhile.

## Related

- `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md` — the whole-section PUT guards for the `openai-compatibility` entry.
- `docs/solutions/best-practices/opencode-go-privacy-terms-fail-closed-snapshot-from-docs-prose-2026-11-05.md` — how the eligible model list is decided.
- `docs/solutions/workflow-issues/opencode-v2-gateway-rollout-deploy-checks-do-not-prove-provider-routing-2026-10-31.md` — why checks must exercise the real route.
- `docs/runbooks/cliproxy-opencode-go.md` — enablement, key rotation, emergency disable, "Session header dropped" and "Applied but unverified".
- `apps/cliproxy/AGENTS.md` — "OPENCODE GO UPSTREAM" and "ANTHROPIC AUTH MONITOR".
