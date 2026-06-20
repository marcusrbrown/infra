---
title: Applying CLIProxyAPI config fields at deploy time via the management API
date: 2026-06-20
category: best-practices
module: apps/cliproxy
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "Setting a CLIProxyAPI config field at deploy time without overwriting config.yaml"
  - "Applying oauth-model-alias (or any management field) that must not wipe runtime api-keys"
  - "Reading back a management mutation to confirm it took effect"
tags: [cliproxy, management-api, oauth-model-alias, config-yaml, model-aliasing, deploy, fail-closed]
---

# Applying CLIProxyAPI config fields at deploy time via the management API

## Context

The cliproxy deploy must **not** upload `config.yaml` (it holds runtime `api-keys` added via the management API — overwriting it wipes them, the recurring cliproxy-first-deploy incident). So when a config field is genuinely version-controlled — here, an `oauth-model-alias` block mapping short Anthropic model ids to their dated upstream models — it has to be applied a different way: a field-scoped PUT to the management API after the stack is healthy, leaving the rest of `config.yaml` untouched.

This is the safe alternative to `--force-config` for managed config fields. Getting it right surfaced one trap that returns HTTP 200 while silently doing nothing.

## Guidance

**PUT the bare object — wrapper shapes silently no-op.** `PUT /v0/management/oauth-model-alias` stores the value only when the body is the **bare object** `{claude: [...]}`. The `{value: ...}` and `{oauth-model-alias: ...}` wrappers return `200 {"status":"ok"}` but store **nothing** (verified live). A wrapper looks successful and isn't.

```ts
// applyOAuthModelAlias — body IS the field value, no wrapper
await fetch(`${baseUrl}/v0/management/oauth-model-alias`, {
  method: 'PUT',
  headers: managementHeaders(key),          // x-management-key, NOT Authorization: Bearer
  body: JSON.stringify({claude: [...]}),     // bare object — no {value} / {oauth-model-alias} wrapper
  signal: AbortSignal.timeout(10_000),
})
```

**Read back and fail closed.** Because a 200 doesn't prove the write landed, GET the field, compare with order-insensitive set-equality, and fail the deploy on mismatch with a diff. This catches the silent-no-op PUT and any future contract change. Add a **bounded retry** (e.g. 0/500/1000ms) on mismatch only — the daemon may hot-reload config asynchronously after the PUT, so the immediate GET can race a stale read. Retry on mismatch; let real HTTP errors propagate.

**Tolerate server-side type variance on read-back.** The management API may return a boolean field (`fork`) as a JSON string (`"true"`). Normalize during parse (accept `true`/`false`/`"true"`/`"false"`) so a legitimate-but-unexpected serialization doesn't fail every deploy with a false mismatch.

**Never touch the api-keys array.** A field-scoped PUT to `oauth-model-alias` is inherently safe — it reads and writes only that field, never the `api-keys` array. This is the property that makes it the right tool instead of `--force-config`.

**Fail early on missing credentials.** If the managed field is present in the tracked config but `CLIPROXY_MANAGEMENT_KEY` is unset, fail in the pre-deploy check **before** the container restart — not ~90s later after `docker compose up --wait`. Reading the tracked config in the preflight makes the failure cheap and obvious.

**`fork: true` for listing parity.** For model aliasing specifically, `fork: true` keeps both the short alias and the dated upstream id in `/v1/models`, so harnesses that enumerate models (like `opencode models`) see the short id as a real, usable entry — not just a routing rewrite.

## Why This Matters

The bare-object trap is the dangerous one: a deploy that PUTs a wrapper shape gets a 200, reports success, and applies nothing — the aliases silently never exist. Only the read-back-and-compare step turns that into a loud deploy failure. The pattern (bare-object field PUT → read-back → fail-closed → bounded retry → never touch api-keys) generalizes to any CLIProxyAPI management field that must be applied without uploading `config.yaml`.

## When to Apply

- Applying any version-controlled CLIProxyAPI management field at deploy time without overwriting `config.yaml`.
- Any management-API mutation where a 200 does not prove the value persisted (read-back is mandatory).
- Model aliasing to close a harness short-id gap (use `fork: true`).

## Examples

**Live verification of the shipped pattern:** after deploy, `/v0/management/oauth-model-alias` returned the 7-entry `claude` set; `/v1/models` listed both `claude-haiku-4-5` and `claude-haiku-4-5-20251001`; a `/v1/chat/completions` with the short id `claude-haiku-4-5` returned 200 with response `model: claude-haiku-4-5-20251001` (routed to the dated upstream); the api-key count was unchanged (24).

**Helper location:** the management HTTP primitives (`managementHeaders`, `requestJson`, `HTTP_TIMEOUT_MS`, `parseManagementKeyList`) plus the alias functions live in `packages/shared/cliproxy/management.ts`, consumed by both `apps/cliproxy` deploy and the `packages/cli` commands — possible now that the published CLI inlines `infra-shared` at build time (see the bun-build publish-model doc).

## Related

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — why `config.yaml` upload is skipped (runtime api-keys); this pattern is the safe alternative for managed fields.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — verifying CLIProxyAPI management-endpoint contracts at a tag (the bare-object shape is exactly the kind of contract to re-verify on upgrades).
- `docs/solutions/best-practices/cli-bun-build-publish-model-2026-06-20.md` — the boundary removal that let the management helpers move to `packages/shared`.
- Shipped in PR #626 / `@marcusrbrown/infra@0.13.3`.
