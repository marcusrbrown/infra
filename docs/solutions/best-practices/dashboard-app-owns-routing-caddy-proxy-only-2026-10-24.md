---
title: The dashboard app owns routing; Caddy only splits /operator/* from everything else
date: 2026-10-24
category: docs/solutions/best-practices/
module: apps/dashboard
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Considering a Caddy `rewrite`, `try_files`, or path allowlist in front of the dashboard
  - An unknown dashboard path returns the app's 404 and a Caddy-side fix looks tempting
  - Path-routed (non-hash) SPA deep links are being introduced
symptoms:
  - "An unknown dashboard path returns 404"
  - "Considering a Caddy rewrite so SPA deep links load the shell"
  - "Operator assets or public pages served as text/html after a Caddy routing change"
tags: [dashboard, caddy, spa, reverse-proxy, routing, deep-linking, allowlist]
---

# The dashboard app owns routing; Caddy only splits /operator/* from everything else

## Context

An earlier Caddyfile fronted the dashboard with `/api/*` and `/auth/*` handles, an extension matcher, and a catch-all `rewrite * /` so that path deep links such as `/runs` would load the SPA shell. Those links never shipped. The SPA has no path routing: it keeps view state in React and addresses a run with a `/#<runId>` hash, which the server never sees. The rewrite also duplicated the app's public-path policy in a second place, and the two copies drifted: operator root-level assets missing from the Caddy allowlist were rewritten to `/` and served as `text/html`. [#1564](https://github.com/marcusrbrown/infra/pull/1564) ([`50ff7e4`](https://github.com/marcusrbrown/infra/commit/50ff7e4)) deleted the rewrite and the redundant handles.

## Guidance

`apps/dashboard/config/Caddyfile` has exactly two `handle` blocks, in this order:

```caddyfile
{$DASHBOARD_DOMAIN} {
	handle /operator/* {
		reverse_proxy {$GATEWAY_VPC_IP}:9300 { ... }   # gateway over the VPC
	}
	handle {
		reverse_proxy dashboard:3000                   # everything else, path unchanged
	}
}
```

- `/operator/*` goes to the gateway (`apps/dashboard/config/Caddyfile:3`).
- Everything else goes to the dashboard app with the original path (`apps/dashboard/config/Caddyfile:10-12`, the matcherless `handle`).
- The app decides what is public. Its `isPublicPath` allowlist in [fro-bot/dashboard](https://github.com/fro-bot/dashboard) is the only such list; an unknown path gets the app's own 404.
- Bare `/operator` (no trailing slash) does not match `/operator/*`. It reaches the app, which redirects an unauthenticated visitor to login with a 302 and returns 404 to an authenticated one.

## Why This Matters

Two allowlists that can disagree fail silently, and the failure mode is a wrong-MIME HTML shell for a script or service worker rather than a clear error. One owner means a new public path or asset needs a change in one repo, with no infra deploy. A Caddy rewrite also masks real 404s: an unknown path would return the shell with status 200.

## When to Apply

- Before adding any `rewrite`, `try_files`, `@matcher`, or per-path `handle` to the dashboard Caddyfile: don't.
- If path-routed deep links ever ship, make the app serve the shell for those routes. Add the route to the app, not to Caddy.
- A new Caddy handle is justified only for a different upstream (as `/operator/*` is), never to shape responses for the app.

## Examples

Symptom: `https://dashboard.fro.bot/some-unknown-path` returns 404. This is correct; the 404 comes from the app. Probing `/` and `/some-unknown-path` unauthenticated should not return identical responses.

Regression guard, all in the repo:

- `apps/dashboard/config/Caddyfile.test.ts:124`, the test `has exactly two handles: /operator/* first, then a matcherless catch-all`, pins the handle list.
- `apps/dashboard/config/Caddyfile.test.ts:139`, `proxies the catch-all to the app with no extra directives`, requires the catch-all body to be only `reverse_proxy dashboard:3000`.
- `apps/dashboard/config/Caddyfile.test.ts:153`, `has no rewrite directive anywhere; the app owns path handling`, fails on any `rewrite`.
- The routing table in the `dashboard Caddyfile routing` suite (`apps/dashboard/config/Caddyfile.test.ts`) sends `/operator` and `/operatorx` to the app, `/operator/*` to the gateway, and every other path to the app. The model throws on named matchers, so adding one fails loudly.
- `committed Caddyfile structure` (`apps/dashboard/src/deploy.test.ts:1156`) pins the operator block's headers and `flush_interval -1`, the operator-before-catch-all order, and no site-level `reverse_proxy`.

A Caddyfile-only change applies on the next dashboard deploy with no manual reload: the deploy force-recreates Caddy every time (`apps/dashboard/src/remote-deploy.ts:544`). See [dashboard-caddy-bind-mount-stale-reload-2026-07-26.md](../integration-issues/dashboard-caddy-bind-mount-stale-reload-2026-07-26.md).

## Related

- [#1564](https://github.com/marcusrbrown/infra/pull/1564) — removed the rewrite, the extension matcher, and the `/api/*` and `/auth/*` handles.
- [#953](https://github.com/marcusrbrown/infra/pull/953) — the earlier allowlist-to-extension-matcher change, since removed.
- [gateway-caddy-announce-ingress-self-404-2026-06-04.md](../integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md) — directive-ordering trap; the `handle` + `caddy adapt` discipline still applies.
- [dashboard-operator-session-container-hairpin-2026-06-21.md](../integration-issues/dashboard-operator-session-container-hairpin-2026-06-21.md) — the `/operator/*` route context.
