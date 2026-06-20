---
title: CLIProxyAPI model aliasing for short-ID routing parity
date: 2026-06-20
status: draft
owner: marcusrbrown
related:
  - apps/cliproxy/config/config.yaml
  - apps/cliproxy/src/deploy.ts
  - packages/cli/src/commands/cliproxy/models.ts
---

# CLIProxyAPI model aliasing for short-ID routing parity

## Problem

Harnesses (OpenCode/Fro Bot) configured with opencode's short Anthropic model IDs — e.g. `claude-sonnet-4-5`, `claude-haiku-4-5` — cannot use those IDs through `cliproxy.fro.bot`, because the proxy only serves the **dated** upstream IDs (`claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001`). A request for the short ID returns an unknown-model error. This forces harness configs to hardcode dated IDs, which drift and diverge from `opencode models`.

CLIProxyAPI v7.2.22 added `oauth-model-alias` (per-provider global aliases) and per-auth `model-aliases`, which can map a client-facing model name to a real upstream model. This closes the gap.

## Goal

**Functional routing parity:** every opencode short Anthropic ID that maps to a real cliproxy upstream model resolves through the proxy. Listing parity (the short ID appears in `/v1/models` and `cliproxy models`) is a verified side effect of using `fork: true`.

## Decisions

### Alias set (initial)

Seven Anthropic short→dated mappings, each `fork: true` (keep both the short and dated IDs available):

| Client-facing alias (`alias`) | Upstream model (`name`) |
| --- | --- |
| `claude-3-5-haiku-latest` | `claude-3-5-haiku-20241022` |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` |
| `claude-opus-4-0` | `claude-opus-4-20250514` |
| `claude-opus-4-1` | `claude-opus-4-1-20250805` |
| `claude-opus-4-5` | `claude-opus-4-5-20251101` |
| `claude-sonnet-4-0` | `claude-sonnet-4-20250514` |
| `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` |

`name` = the real upstream model the proxy calls; `alias` = the client-facing name harnesses use. (Already-short IDs such as `claude-sonnet-4-6`, `claude-opus-4-6/4-7/4-8`, `claude-fable-5` need no alias — the proxy already serves them.)

### Source of truth

The `oauth-model-alias` block in the tracked `apps/cliproxy/config/config.yaml`. Version-controlled and code-reviewed.

### Apply mechanism

On deploy, read the `oauth-model-alias` block from the tracked template and PUT **only that field** to the management API endpoint `/v0/management/oauth-model-alias`. This:
- never touches the runtime `api-keys` (preserves the 24 live per-repo keys),
- requires no `--force-config`,
- hot-reloads and persists to the droplet's on-disk `config.yaml` (survives container restart).

The rest of `config.yaml` keeps its existing skip-unless-`--force-config` behavior.

## Constraints

- **Net-new deploy path.** The current `apps/cliproxy/src/deploy.ts` only uploads `config.yaml` on first deploy or `--force-config`, and never calls `/v0/management/oauth-model-alias`. This feature adds a new field-scoped management-API apply step; it does not reuse the existing whole-file upload or the `{value: ...}` management-PUT helper.
- **Apply runs after the stack is healthy.** The management endpoint does not exist until the proxy is up. The alias PUT must run *after* `docker compose up -d --wait` succeeds (post-start), not during the pre-deploy phase.
- **Bare-object PUT only.** `/v0/management/oauth-model-alias` accepts the bare object `{claude: [...]}`. The `{value: ...}` and `{oauth-model-alias: ...}` wrappers return `200 {"status":"ok"}` but silently store nothing. Any apply code must use the bare-object shape and read back to confirm.
- **Do not clobber runtime api-keys.** The tracked `config.yaml` has `api-keys: []`; uploading the whole file (via `--force-config`) wipes the live keys. The alias apply must be field-scoped, never a full-config upload.
- **`cliproxy models` is unaffected.** The OpenAI-compatible `/v1/models` shape (`{created: epoch, id, object, owned_by}`) is unchanged in v7.2.22; the existing command parses it correctly. Aliased IDs appear as normal entries.
- **Only alias models with a real upstream.** opencode-only variants (`-fast`, `-pro`, `mythos`, OpenAI `gpt-5.x` variants) have no distinct dated cliproxy upstream and must not be aliased (would 404 at the provider).

## Open questions for planning

These design decisions are deferred to `ce:plan`:

- **Missing/invalid management key.** The current deploy tolerates an absent `CLIPROXY_MANAGEMENT_KEY` and still succeeds. Decide whether the alias step hard-fails the deploy when the key is missing, or skips with a loud warning (and is therefore "incomplete"). A silent skip that reports success is not acceptable.
- **Read-back mismatch semantics.** After the PUT, read back `/v0/management/oauth-model-alias` and compare to the desired set. Decide the exact comparison (set vs ordered; tolerate server-added fields) and the failure behavior (retry once, then fail the deploy with a clear error).
- **Apply trigger.** Decide whether the alias PUT runs on *every* deploy (simple, but adds a per-deploy failure surface unrelated to the code change) or only when the tracked alias block changed (diff-gated). If every-deploy, it must be resilient to a briefly-unhealthy proxy.
- **`fork: true` verification.** Require a post-apply assertion that the proxy still serves *both* the short alias and the dated ID in `/v1/models` (guards against a future version interpreting `fork` differently or dropping the dated model).
- **`--force-config` interaction.** If `--force-config` uploads the tracked `config.yaml` (which now carries the alias block), the alias block lands but the runtime api-keys are still wiped — the existing footgun, unchanged. Document that the alias block being in the template does not make `--force-config` safe.

## Success criteria

1. After deploy, `/v0/management/oauth-model-alias` returns the 7-entry `claude` set.
2. `cliproxy models anthropic` (and `/v1/models`) lists all 7 short IDs **and** their dated counterparts.
3. A `/v1/chat/completions` request with each short ID returns 200 and the response `model` is the dated upstream.
4. The 24 runtime api-keys are intact after the deploy (no wipe).
5. A normal redeploy re-applies the alias set idempotently without `--force-config`.

## Out of scope

- A standalone `infra cliproxy alias` CLI command (the tracked-template + deploy-apply path is the chosen mechanism).
- OpenAI model aliasing (the `gpt-5.x-fast`/`-pro`/`-mini-fast` variants are opencode-only with no cliproxy upstream) — revisit separately if a real gap appears.
- Per-auth `model-aliases` (the global per-provider `oauth-model-alias` covers this use case).

## Risks

- **Hardcoded dated-ID drift.** The 7 mappings pin specific dated upstream IDs (e.g. `claude-sonnet-4-5-20250929`). When Anthropic/CLIProxyAPI retire or rename a dated model, the mapping goes stale and deploys keep reapplying a broken alias until someone updates the tracked block. Mitigation to consider in planning: a verification step (success criterion 3) that catches a broken mapping, and treating the alias block as a maintenance item reviewed when bumping the cliproxy image.
- **Undocumented management contract.** The bare-object PUT shape and `fork` semantics are v7.2.22 behavior not documented in upstream `config.example.yaml`. A future cliproxy upgrade could change the payload contract or `fork` handling. The post-apply read-back + `fork` verification (above) is the guard; cliproxy image bumps should re-verify the alias path.

## Notes

- A live prototype currently sets a single `claude-haiku-4-5` alias on the proxy (verified end-to-end). Implementation should reconcile this to the full managed 7-entry set so the live state matches the tracked source of truth.
- The `fork` field is real in the v7.2.22 source but undocumented in upstream `config.example.yaml`; `fork: true` is required to keep both IDs.
