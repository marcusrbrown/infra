---
title: Caddy path-scoped reverse proxy 404s its own route via directive ordering
date: 2026-06-04
category: docs/solutions/integration-issues
module: apps/gateway
problem_type: integration_issue
component: tooling
symptoms:
  - 'POST /v1/announce returned 404 even though the reverse_proxy route was configured'
  - 'caddy adapt showed the bare respond 404 compiled ahead of the matched reverse_proxy'
  - 'substring-only unit tests passed while the endpoint was broken'
  - 'the announce feature was enableable via local deploy but not through CI'
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - apps/gateway
tags:
  - gateway
  - caddy
  - reverse-proxy
  - ingress
  - acme
  - deploy-secrets
  - config-ordering
---

# Caddy path-scoped reverse proxy 404s its own route via directive ordering

## Problem

A path-scoped Caddy reverse proxy fronting the gateway daemon's `POST /v1/announce`
endpoint returned **404 for `/v1/announce` itself** — the endpoint 404'd the very
path it was meant to serve — because Caddy reorders directives at adapt time and a
bare `respond 404` fall-through was compiled ahead of the matched `reverse_proxy`.

## Symptoms

- `POST https://gateway.fro.bot/v1/announce` returned `404` from the Caddy ingress
  (instead of reaching the daemon, which would answer `400` on an unsigned request).
- `caddy adapt` on the generated config showed the compiled subroute list as:
  `[0] match=None -> static_response(404)`, `[1] match=path /v1/announce -> reverse_proxy`.
- Substring-based unit tests passed — they asserted the Caddyfile string *contained*
  `reverse_proxy` and `respond 404`, which says nothing about compiled route order.
- The bug was invisible until a live (or `caddy adapt`) check; `caddy validate` even
  reported "Valid configuration" on the broken form.

## What Didn't Work

- **Reasoning from Caddyfile source order.** The directives appear in the intuitive
  order in the source file (`reverse_proxy` first, `respond 404` last), but Caddy
  compiles directives in its built-in *directive order*, not source order. A bare
  `respond` with no matcher is a terminal handler that applies to all requests and
  sorts ahead of `reverse_proxy`.
- **Substring-only tests.** Asserting the generated string contains the right tokens
  cannot catch a route-ordering defect. Only adapting the config exposes it.
- **Framing the catch-all as an ACME concern only.** Earlier review reasoning checked
  whether `respond 404` would shadow `/.well-known/acme-challenge` (it doesn't — see
  Why This Works) but missed that it shadows the *proxied path itself*.

## Solution

Use mutually-exclusive `handle` blocks instead of a bare `respond` fall-through.

Before (broken — `/v1/announce` returns 404):

```caddyfile
gateway.fro.bot {
  @announce path /v1/announce
  reverse_proxy @announce gateway:3000
  respond 404
}
```

After (correct — verified via `caddy adapt` + `caddy validate`):

```caddyfile
gateway.fro.bot {
  handle /v1/announce {
    reverse_proxy gateway:3000
  }
  handle {
    respond 404
  }
}
```

Adapting the corrected form (on the pinned `caddy:2.11.3-alpine`) compiles to:

- `[0] match=path /v1/announce -> reverse_proxy`
- `[1] match=None -> static_response(404)`

`/v1/announce` is matched first and proxied; every other path falls through to 404.

## Why This Works

Caddy applies a fixed [directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order)
when adapting a Caddyfile, independent of how you wrote the source. A standalone
`respond` (no matcher) becomes an unconditional terminal handler that sorts *before*
`reverse_proxy`, so it wins for every request.

`handle` blocks are **mutually exclusive** — a request enters exactly one — and Caddy
orders them by match specificity, so the `/v1/announce` handler is evaluated before
the catch-all `handle { respond 404 }`. Intent is preserved regardless of Caddy's
internal directive order. (`route` blocks are the alternative when you need strict
source-order semantics within a single matched scope.)

ACME is unaffected: the catch-all 404 lives inside the `:443` host block. Caddy serves
HTTP-01 challenges on `:80` via an auto-injected route ahead of user routes, and
TLS-ALPN-01 on `:443` operates below HTTP path routing — so the 404 never shadows cert
issuance. Confirmed in practice: Let's Encrypt issued a cert for `gateway.fro.bot` on
the first public deploy.

## Prevention

- **Use `handle` (or `route`) blocks for any path-scoped proxy.** Never rely on a bare
  `respond`/`reverse_proxy` ordering in a Caddyfile — the compiled order is not the
  source order.
- **Verify generated proxy configs with `caddy adapt` + `caddy validate`, not substring
  assertions.** A test that inspects the *adapted route order* (e.g. asserts the
  matched proxy route precedes the catch-all) would have caught this. At minimum, assert
  the `handle`-block structure rather than the presence of `reverse_proxy` + `respond`.
  Quick check against the pinned image:

  ```sh
  docker run --rm caddy:2.11.3-alpine sh -c \
    'printf "%s" "$CADDYFILE" > /tmp/Cf && caddy adapt --adapter caddyfile --config /tmp/Cf'
  ```

- **Wire a new deploy secret through *every* entry point.** The same feature's two
  secrets (`GATEWAY_WEBHOOK_SECRET`, `GATEWAY_PRESENCE_CHANNEL_ID`) were forwarded to
  local deploy but missing from the CI path — both the reusable workflow's
  `workflow_call.secrets` *and* the fan-out workflow's `secrets:` mapping. When a deploy
  reads a new secret, add it to the local env passthrough and each `workflow_call` layer,
  not just one.

## Related Issues

- PR #409 — gateway opt-in announce/presence webhook + public Caddy ingress (introduced and fixed this).
- Issue #410 — announce ingress hardening follow-up (post-deploy HTTPS probe, test robustness).
- `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` — sibling lesson: required runtime inputs must be wired through every layer, not just the preflight/local path.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — the first public deploy is an end-to-end contract test; verify the whole path, not assumptions.
- `docs/solutions/integration-issues/gateway-mention-loop-supervisor-timeout-2026-06-03.md` — sibling meta-lesson: verify against ground-truth behavior, not inferred behavior.
