---
title: Applying CLIProxyAPI config fields at deploy time via the management API
date: 2026-06-20
last_updated: 2026-11-05
category: best-practices
module: apps/cliproxy
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "Setting a CLIProxyAPI config field at deploy time without overwriting config.yaml"
  - "Applying oauth-model-alias (or any management field) that must not wipe runtime api-keys"
  - "Reading back a management mutation to confirm it took effect"
  - "Writing a management section that has no create-one-entry endpoint, so only a whole-section replace exists"
tags:
  [cliproxy, management-api, oauth-model-alias, openai-compatibility, config-yaml, model-aliasing, deploy, fail-closed]
---

# Applying CLIProxyAPI config fields at deploy time via the management API

## Context

The cliproxy deploy must **not** upload `config.yaml` (it holds runtime `api-keys` added via the management API — overwriting it wipes them, the recurring cliproxy-first-deploy incident). So when a config field is genuinely version-controlled — here, an `oauth-model-alias` block mapping short Anthropic model ids to their dated upstream models — it has to be applied a different way: a field-scoped PUT to the management API after the stack is healthy, leaving the rest of `config.yaml` untouched.

This is the safe alternative to `--force-config` for managed config fields. Getting it right surfaced one trap that returns HTTP 200 while silently doing nothing.

## Guidance

**PUT the bare object — wrapper shapes silently no-op.** `PUT /v0/management/oauth-model-alias` stores the value only when the body is the **bare object** `{claude: [...]}`. The `{value: ...}` and `{oauth-model-alias: ...}` wrappers return `200 {"status":"ok"}` but store **nothing** (verified live). A wrapper looks successful and isn't.

<!-- prettier-ignore -->
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

## The `openai-compatibility` section

This section has no create-one-entry endpoint. PATCH edits an existing entry by name, and only PUT replaces the whole list. The deploy owns the section outright and writes the whole list with `PUT /v0/management/openai-compatibility`, behind guards. This is the one recorded exception to the field-scoped rule: a whole-section replace is acceptable only for a section infra owns end to end, and only behind every guard below.

- **A bare `[]` PUT clears the section.** The server accepts it. Only `{items: []}` is rejected. The client refuses to send an empty list.
- **Refuse foreign entries.** The PUT replaces the whole list, so the deploy stops if the live section holds any entry other than the one infra owns.
- **PATCH `{name, value: {disabled: true}}` disables one entry.** Its models leave `/v1/models` within a second in a local probe, while the management GET still lists the entry. Use it for an emergency disable without a deploy. Disable never uses PUT.
- **Normalize the readback.** GET adds `auth-index` to each entry and always returns `disabled`. Drop `auth-index`, default `disabled` to false and compare models as a set. The GET returns upstream api keys in clear: shape-validation errors name fields, never values, and HTTP errors carry a bounded body excerpt with the management key scrubbed.

### Guards that treat "unknown" as "unsafe"

Three more guards close the gaps between "the read looked fine" and "the write is safe".

**A GET without the wrapper field is an error, not an empty section.** The foreign-entry guard passes on an empty list, so a parser that returned `[]` for an object missing the `openai-compatibility` field would let a whole-section PUT through. `readBackOpenAICompat` in `packages/shared/cliproxy/management.ts` treats only an explicit `null` or array as the section's content:

<!-- prettier-ignore -->
```ts
if (!('openai-compatibility' in payload)) {
  throw new TypeError(
    `GET ${OPENAI_COMPAT_ENDPOINT} returned an unexpected shape: missing the openai-compatibility field`,
  )
}
```

**A write that may have landed is "unknown", not "failed".** A timeout, a dropped connection or a 5xx can follow a write the proxy already applied. The deploy treats a 4xx other than 408 as a rejection; every other write error is reported as an unknown outcome. `sendGoWrite` in `apps/cliproxy/src/deploy.ts` wraps both the PUT and the disable PATCH:

<!-- prettier-ignore -->
```ts
const rejected =
  error instanceof ManagementHttpError && error.status >= 400 && error.status < 500 && error.status !== 408
if (rejected) throw error
throw new OpenCodeGoUnverifiedError(
  'write',
  `the request was sent and its outcome is unknown: ${redact(describeError(error), env)}`,
)
```

`ManagementHttpError` is raised only when an HTTP response arrived, so a transport failure never looks like a rejection. After an accepted PUT, failures in readback, visibility or the smoke request are also `OpenCodeGoUnverifiedError`: the write may have landed, and the live state is unproven.

**Refuse before writing when the live state disagrees with the tracked policy.** `applyOpenCodeGoStep` in `apps/cliproxy/src/deploy.ts` fails, with the live proxy untouched, when:

- `assertOwnedSection` finds an entry other than `opencode-go`;
- the live entry is disabled while `settings.json` says `enabled: true` (re-enable deliberately first);
- `findCollisions` finds an eligible bare or prefixed id already served under another `owned_by`.

Step order in `deploy`: management-key preflight, `preflightOpenCodeGo` (before any SSH), SSH and `docker compose up`, `applyOAuthModelAliasStep`, `applyOpenCodeGoStep`, `healthCheck`. Inside `applyOpenCodeGoStep`, enabled mode runs read, foreign-entry guard, disabled-entry guard, collision check, PUT, readback poll, visibility poll, smoke request. Disabled mode instead PATCHes an existing entry to disabled and checks visibility when a downstream key is available; without a management key it warns and returns.

Residual risk: the live read and the PUT are separate calls, so an entry added between them would be replaced. Deploys are gated and serialized, so the window is accepted.

### Probe the server; do not trust the plan's account of it

The original plan said the server rejects an empty list. A probe showed that a bare `[]` is accepted and clears the section, and that only the wrapped `{items: []}` is rejected. Before writing a client for a replace-everything endpoint, probe three things against the real server: the empty body, a response missing the wrapper field, and the response to a write that never gets an answer. Then write each result into a guard.

See `apps/cliproxy/AGENTS.md` (OpenCode Go upstream), `docs/runbooks/cliproxy-opencode-go.md`, and `docs/solutions/integration-issues/opencode-go-through-cliproxy-session-header-billing-source-2026-11-05.md`.

## Why This Matters

The bare-object trap is the dangerous one: a deploy that PUTs a wrapper shape gets a 200, reports success, and applies nothing — the aliases silently never exist. Only the read-back-and-compare step turns that into a loud deploy failure. The field-scoped pattern (bare-object field PUT → read-back → fail-closed → bounded retry → never touch api-keys) generalizes to any CLIProxyAPI management field that has its own endpoint and must be applied without uploading `config.yaml`. A whole-section replace does not generalize: it is allowed only for a section infra owns outright, behind the guards in the `openai-compatibility` section above.

## When to Apply

- Applying any version-controlled CLIProxyAPI management field at deploy time without overwriting `config.yaml`.
- Any management-API mutation where a 200 does not prove the value persisted (read-back is mandatory).
- Model aliasing to close a harness short-id gap (use `fork: true`).
- Replacing a whole management section that infra owns and that has no field-scoped create endpoint (the `openai-compatibility` guards above).

## Examples

**Live verification of the shipped pattern:** after deploy, `/v0/management/oauth-model-alias` returned the 7-entry `claude` set; `/v1/models` listed both `claude-haiku-4-5` and `claude-haiku-4-5-20251001`; a `/v1/chat/completions` with the short id `claude-haiku-4-5` returned 200 with response `model: claude-haiku-4-5-20251001` (routed to the dated upstream); the api-key count was unchanged (24).

**Helper location:** the management HTTP primitives (`managementHeaders`, `requestJson`, `HTTP_TIMEOUT_MS`, `parseManagementKeyList`) plus the alias functions live in `packages/shared/cliproxy/management.ts`, consumed by both `apps/cliproxy` deploy and the `packages/cli` commands — possible now that the published CLI inlines `infra-shared` at build time (see the bun-build publish-model doc).

## Related

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — why `config.yaml` upload is skipped (runtime api-keys); this pattern is the safe alternative for managed fields.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — verifying CLIProxyAPI management-endpoint contracts at a tag (the bare-object shape is exactly the kind of contract to re-verify on upgrades).
- `docs/solutions/best-practices/cli-bun-build-publish-model-2026-06-20.md` — the boundary removal that let the management helpers move to `packages/shared`.
- `docs/solutions/integration-issues/opencode-go-through-cliproxy-session-header-billing-source-2026-11-05.md` — routing, billing signal and key scope for the one entry this section manages.
- `docs/solutions/best-practices/opencode-go-privacy-terms-fail-closed-snapshot-from-docs-prose-2026-11-05.md` — how the entry's eligible model list is decided.
- `docs/runbooks/cliproxy-opencode-go.md` — enablement, emergency disable, and recovery from "applied but unverified".
- Shipped in PR #626 / `@marcusrbrown/infra@0.13.3`.
