---
title: Gateway operator /operator/repos returns 404 — unmounted route plus keyless legacy bindings
date: 2026-06-24
category: docs/solutions/integration-issues/
module: gateway
problem_type: integration_issue
component: tooling
symptoms:
  - Authenticated operator load of /operator/repos returns 404 {"error":"not-found"}
  - Two repos are bound in the S3 bindings store, but none surface in the operator response
root_cause: missing_workflow_step
resolution_type: code_fix
severity: high
related_components:
  - development_workflow
tags:
  - gateway
  - operator
  - repos
  - s3
  - bindings
  - github-api
  - redaction-gate
  - route-mount
---

# Gateway operator /operator/repos returns 404 — unmounted route plus keyless legacy bindings

## Problem

The Fro Bot gateway operator surface `GET /operator/repos` returns `404 {"error":"not-found"}` for an authenticated operator, and would return an empty list even if it were reachable — despite two repos being actively bound.

## Symptoms

- An authenticated browser load of `/operator/repos` returns `404 {"error":"not-found"}`.
- Two repos are bound in the S3 bindings store, yet none appear in the operator response.

## What Didn't Work / Investigation

- **Treating it as an authz/allowlist problem (per-repo authz, the last gate)** — wrong. The bindings never reach the authz stage.
- **Following the documented `backfill-deny-keys` remediation** — it has no runnable entrypoint in the shipped gateway image: `main.ts` has no argv/subcommand dispatch and there is no built CLI artifact, so the backfill function exists in source but cannot be executed against a live install.
- **Patching the bindings alone** — necessary but not sufficient. Even perfectly keyed bindings cannot surface through a route that is never mounted.

## Solution

The operator repo pipeline is an ordered fail-closed sequence: **enumerate bindings → denylist filter → per-repo authz.** An empty/absent result can come from any stage, and they have very different fixes. Two distinct bugs were in play here.

### Diagnostic: 404 vs 401 is the decisive mount signal

Probe each operator route directly (unauthenticated) and read the **status code**. A mounted privileged route returns `401` (auth gate rejects the request); an unmounted route falls through to the app catch-all and returns `404 {"error":"not-found"}`.

Probing the operator listener from the Caddy container to `gateway:9300`:

```
GET /operator/health         -> 200   (always mounted)
GET /operator/session        -> 401   (mounted, auth-gated)
GET /operator/runs/x/stream  -> 401   (mounted, auth-gated)
GET /operator/repos          -> 404   (NOT mounted -> notFound catch-all)
```

`/operator/repos` is the only privileged route returning `404` instead of `401` — proof it is not registered, independent of authentication or binding state.

### Bug 1 — keyless legacy bindings dropped at the denylist gate

Inspect the S3 bindings at `s3://<gateway-bucket>/fro-bot-state/discord-gateway/<owner>/<repo>/bindings/repo.json`. Bindings created before the redaction gate landed lack deny keys:

```
fields: owner, repo, channelId, channelName, workspacePath, createdAt, createdByDiscordId
databaseId=NULL  nodeId=NULL
```

The redaction denylist gate is fail-closed: `surface-gate.ts` `bindingToRepoKey` reads top-level `binding.databaseId` (number) and `binding.nodeId` (string), and `denylist.ts` denies a binding when **both** are null/empty. Keyless bindings are silently dropped before authz ever runs.

**Fix (data):** add the two top-level deny-key fields, mirroring exactly what `add-project` writes — `databaseId` = GitHub REST repo `.id`, `nodeId` = REST `.node_id`. The patch is additive (preserves all existing fields) and idempotent (skip if already keyed):

```jsonc
// merge into each repo.json, preserving all existing fields
{
  "databaseId": 1200110668,        // GitHub REST GET /repos/{owner}/{repo} .id
  "nodeId": "R_kgDOR4g8TA"         // ...                                .node_id
}
```

The documented `backfill-deny-keys` operation is the intended remediation, but it has no runnable entrypoint in the shipped image — so a one-off direct S3 patch is the interim path until the upstream backfill CLI ships.

### Bug 2 — the /operator/repos route is never mounted

`web/server.ts` gates the repos-route mount on all of: `browserGuardDeps`, `sessionStore`, `denylistCache`, `listBindings`, `allowlist`, `auditLogger`. But the operator-server startup call in `program.ts` never passes `listBindings` — it passes `bindingsLookup: bindingsStore` instead. `bindingsStore` is constructed unconditionally and already exposes a `listBindings()` method; the wiring simply omits the separately-named dep, so `buildReposRoute` is silently skipped and the route falls through to the `404` catch-all. The sibling `/operator/runs/:runId/stream` route mounts because it depends on `bindingsLookup`, not the `listBindings` dep that only the repos route requires.

**Fix (upstream, one line):**

```ts
listBindings: bindingsStore.listBindings.bind(bindingsStore),
```

(or align the repos-route mount condition and `buildReposRoute` to consume `bindingsLookup`, so there is a single bindings dep instead of two).

Both are upstream code bugs, tracked as `fro-bot/agent#1000` (keyless bindings + no runnable backfill entrypoint) and `fro-bot/agent#1001` (route never mounted).

## Why This Works

The redaction gate is fail-closed by design: a binding with missing deny keys is treated as unsafe and suppressed, so bindings created before the gate landed must be backfilled with the keys the gate expects. The status code is the decisive mount signal because a mounted-but-rejected route and an unmounted route are produced by entirely different code paths — `401` from the route's own auth check, `404` from the application catch-all. Separating those two instantly splits a dependency-injection/wiring failure from a data or authorization failure. Both conditions must hold for a repo to surface: the binding must be keyed enough to survive the enumerate → denylist → authz pipeline, **and** the route must actually be mounted.

## Prevention

- When an operator/admin HTTP surface returns an empty or `404` result, probe each route's **unauthenticated** status code first. `404` means unmounted (a wiring/dependency gap); `401` means mounted (look at data/authz). This single check separates "code gap" from "data/config" before any deeper investigation.
- For fail-closed redaction/denylist designs, any data created **before** the gate landed needs a backfill — and the migration tool must actually ship as a runnable entrypoint in the deployed artifact, not merely exist in source. Verify the migration is invocable in the running image.
- Inspect the actual persisted data shape (here, the S3 binding JSON) rather than assuming a feature's enable flag implies its data is well-formed.

## Related

- [gateway-mention-loop-permission-and-empty-workspace-2026-06-05.md](./gateway-mention-loop-permission-and-empty-workspace-2026-06-05.md) — `/fro-bot add-project` binding persistence and empty-workspace state (shared binding-store area, different failure mode).
- [gateway-caddy-announce-ingress-self-404-2026-06-04.md](./gateway-caddy-announce-ingress-self-404-2026-06-04.md) — a different `404` route-resolution class (Caddy directive ordering), same "route returns 404 by construction" debugging instinct.
- [dashboard-operator-session-container-hairpin-2026-06-21.md](./dashboard-operator-session-container-hairpin-2026-06-21.md) — adjacent operator surface (session validation hairpin), same topology area.
- Upstream: `fro-bot/agent#1000` (keyless bindings / no runnable backfill entrypoint), `fro-bot/agent#1001` (operator repos route never mounted).
