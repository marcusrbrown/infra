---
title: Warning-only gateway operator health probe failed on every deploy through an untrusted forwarded-header peer
date: 2026-10-14
category: integration-issues
module: apps/gateway
problem_type: integration_issue
component: tooling
symptoms:
  - "Deploy log: [warn] Operator health probe did not succeed — service may still be starting."
  - "Gateway log, once per probe attempt: operator request rejected (forwarded headers from untrusted peer)"
  - "Gateway deploys passed; the warning was the only signal"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - development_workflow
tags: [gateway, operator-health, trusted-proxies, forwarded-headers, deploy-probe, warning-only, caddy]
---

# Warning-only gateway operator health probe failed on every deploy through an untrusted forwarded-header peer

## Problem

The gateway deploy's post-deploy operator health probe (`apps/gateway/src/deploy.ts`, Phase 9b2) requested `https://<GATEWAY_HOST>/operator/health` through the gateway-side Caddy. The daemon only accepts forwarded headers from the peers in `GATEWAY_OPERATOR_TRUSTED_PROXIES`, which is the dashboard VPC address. It rejected every attempt with `400`. The probe only warns, so every deploy passed, and the check never confirmed anything.

## Symptoms

- Deploy log: `==> Probing operator health endpoint`, then about 12 seconds later `[warn] Operator health probe did not succeed — service may still be starting.` This was seen on run 38332178434 (2026-10-13) and run 38655337153 (2026-10-14).
- The gateway logged `operator request rejected (forwarded headers from untrusted peer)` once per attempt, five times about 3 seconds apart. The times matched the probe's start and its warning in the deploy log.
- The real operator path worked the whole time. `https://dashboard.fro.bot/operator/health` returned `200` with the new `contractVersion` during the same deploy.

## What Didn't Work

- **Suspecting the trusted-proxy setting.** `GATEWAY_OPERATOR_TRUSTED_PROXIES` in the running container was the dashboard VPC address, as `deriveOperatorTrustedProxies` intends. The trust list was right. The probe used the wrong hop.
- **Attributing the rejections from the gateway log alone.** The rejection line carries no peer address or request path. It was tied to the probe only by lining up its timestamps with the deploy log's probe start and warning.
- **Trusting the probe's comments.** They said the dashboard→gateway private path was not active yet and that the gateway-side Caddy was the right liveness origin. Both stopped being true when the private path went live and trusted proxies became required. Nothing flagged the drift.
- **Reading the boot-time `412`s as the failure.** Four `PreconditionFailed` responses on object-store conditional writes, all within 7 seconds of gateway start, are the boot CAS self-test. They did not recur.

## Solution

Probe the dashboard origin, which is the trusted path: dashboard Caddy → VPC → gateway operator listener. Require a `contractVersion` in the body. The probe still only warns. Fixed in #1537.

Before:

```ts
const operatorHealthUrl = `https://${host}/operator/health`
// ...
if (status === 200) {
  operatorProbeOk = true
  break
}
```

After:

```ts
const operatorHealthUrl = new URL("/operator/health", env.GATEWAY_OPERATOR_PUBLIC_ORIGIN ?? "").toString()
// ...
if (response.status === 200) {
  operatorContractVersion = parseOperatorContractVersion(await response.text())
  if (operatorContractVersion !== undefined) {
    clearTimeout(timer)
    break
  }
}
```

`parseOperatorContractVersion` returns the non-empty string `contractVersion`. It returns `undefined` for a non-JSON body, non-object JSON, or a missing, empty, or non-string field. The success line logs the version. It is never compared to an expected value, because the dashboard deploys separately. The operator listener settings are all-or-none, so `GATEWAY_OPERATOR_PUBLIC_ORIGIN` is always set when the probe runs.

## Why This Works

The daemon honors forwarded headers only when the socket peer is a trusted proxy. The only trusted proxy is the dashboard's Caddy, which reaches the gateway over the VPC. The gateway-side Caddy is on the gateway's Docker network and is deliberately untrusted, so anything it forwards gets `400`. The new probe takes the same route a browser does, so a `200` proves that hop works. Requiring `contractVersion` means a `200` from some other responder, such as an SPA fallback, does not count.

## Prevention

- A warning-only check that never succeeds is invisible. After adding or changing a deploy probe, confirm its success line appears in the log of a known-good deploy, and treat a missing success line as a failed check.
- When a trust boundary is added or tightened, audit every internal caller that crosses the newly untrusted hop. Self-checks, monitors, and deploy probes are the easy ones to miss.
- When a rejection log line names neither peer nor path, correlate its timestamps with the deploy log before blaming configuration.
- Tests pin the probe to the public origin: `deploy.test.ts` asserts the URL is `https://dashboard.fro.bot/operator/health` and never the gateway host.

## Related Issues

- `docs/runbooks/gateway-operator-auth-lifecycle.md`: the warning that `gateway.fro.bot/operator/health` returns `400` by design.
- `docs/runbooks/gateway-operator-private-path-verification.md`: the dashboard Caddy → VPC → listener path the probe now uses.
- `docs/solutions/workflow-issues/gateway-do-firewall-in-deploy-path-2026-06-19.md`: why cross-service deploy checks stay advisory.
- `apps/gateway/AGENTS.md`: operator listener, trusted proxies, and the deploy probe description (updated in #1537).
