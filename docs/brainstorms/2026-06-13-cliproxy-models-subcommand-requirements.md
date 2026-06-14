---
title: cliproxy models subcommand
date: 2026-06-13
status: ready-for-planning
scope: standard
---

# cliproxy models subcommand

## Problem

There is no way to query which models the live CLIProxyAPI instance serves without hand-rolling a `curl` against `/v1/models` with a bearer key. Operators (and agents) need a first-class `infra cliproxy models` command that mirrors `opencode models` so the available model catalog is discoverable from the CLI.

## Goal

Add `infra cliproxy models [provider]` that lists the models CLIProxyAPI exposes at `/v1/models`, mirroring the `opencode models` subcommand within the limits of what the proxy actually returns.

## User-Facing Behavior

- `infra cliproxy models` — lists every model ID the proxy serves (plain list, like `opencode models`).
- `infra cliproxy models <provider>` — optional positional filters to a single provider (`anthropic` or `openai`), matching on `owned_by` when present and falling back to the model-ID prefix/pattern when absent.
- `--verbose` — adds the metadata the endpoint provides: `owned_by` (provider) and `created` (formatted date). There is no cost or context-window data to show.
- `--key <api-key>` / `CLIPROXY_API_KEY` — the bearer api-key used to call `/v1/models`.
- `--url <url>` / `CLIPROXY_URL` — endpoint base URL, falling back to the default `https://cliproxy.fro.bot`. This is an HTTP-only command, so it uses `--url` (matching `cliproxy status` and `cliproxy keys`), not `--host` (which is for the SSH commands `open`/`login`). There is no `--host` flag.
- `-h`/`--help` and `-v`/`--version` come from goke automatically.

## Endpoint and Key Resolution

`--url` resolves the base URL (falling back to `CLIPROXY_URL`, then the default), trailing-slash-normalized. Following the `cliproxy status` precedent, the ambient `CLIPROXY_API_KEY` is only forwarded when the resolved URL is the trusted configured/default host — an explicit `--url` override that points elsewhere must not carry the ambient key, to prevent leaking it to an attacker-controlled endpoint. An explicit `--key` is always honored.

## Error and Empty-Result Behavior

- **No/invalid key (401/403)** — a clear, actionable auth error ("provide --key or set CLIPROXY_API_KEY").
- **Non-2xx / network failure / timeout** — surfaced as a command failure with the status and endpoint (the shared `requestJson` helper already throws on non-2xx with status+body, and on malformed JSON).
- **Invalid provider argument** — validated before the request; an unknown provider (anything other than `anthropic`/`openai`) produces a validation error rather than a silent empty list.
- **Empty result** — when the proxy returns an empty `data` array, or a valid provider filter matches nothing, print a plain "no models" message (not an error). A provider filter matching zero models is distinct from an invalid provider.

## Authentication

`/v1/models` requires a caller **api-key** sent as `Authorization: Bearer <key>` — not the management key. The command reads the key from `--key` or the `CLIPROXY_API_KEY` environment variable. A missing or invalid key surfaces a clear error (the endpoint returns 401 without a valid bearer key).

## Output

- **Default**: one model ID per line (or a simple list), matching `opencode models`' plain output.
- **`--verbose`**: a column layout adding `owned_by` and a human-readable `created` date alongside the ID.

The verified live response shape is `{ data: [ { id, object, owned_by, created } ], object }` — `created` is a unix timestamp; `owned_by` is the provider. No other fields exist.

## MCP Exposure

`cliproxy_models` is added to `MCP_ALLOWLIST` as a read-only tool, mirroring `cliproxy_status`: the action threads the capture `ctx` so the MCP bridge returns the same formatted output a terminal user sees. It reads `CLIPROXY_API_KEY` from the MCP subprocess environment; no secret is echoed in output.

## Reuse

- Models response schema, provider matching (`entryMatchesProvider`, `PROVIDER_ID_PATTERNS`), and `MODEL_ID_RE` already exist in `packages/cli/src/commands/cliproxy/setup/validation.ts`.
- `requestJson`, `managementHeaders`, and base-URL resolution exist in `packages/cli/src/commands/cliproxy/shared.ts`.
- The goke action + capture-`ctx` pattern, `--url`/`CLIPROXY_URL`/`DEFAULT_CLIPROXY_URL` resolution with the trusted-URL key guard, and column formatting all exist in `packages/cli/src/commands/cliproxy/status.ts`.

## Non-Goals

- No `--pure` or `--refresh` — there is no plugin or models.dev cache layer here.
- No `--print-logs` or `--log-level` — those are opencode-internal logging concerns, not relevant to a single HTTP query.
- No `--json` output mode (deferred; can be added later if scripting demand appears).
- No cost, pricing, or context-window metadata — CLIProxyAPI does not return it.
- No models.dev integration.

## Success Criteria

- `infra cliproxy models` lists all models the live proxy serves.
- `infra cliproxy models openai` filters to OpenAI models; `infra cliproxy models anthropic` to Anthropic.
- `--verbose` shows `owned_by` and a formatted `created` date.
- The `cliproxy_models` MCP tool returns the same captured output as the terminal command.
- A missing or invalid api-key produces a clear, actionable error.
- An empty `data` array or a zero-match provider filter prints a plain "no models" message, not an error; an invalid provider is a validation error.
- Help output documents the positional, `--verbose`, `--key`, and `--url`.
