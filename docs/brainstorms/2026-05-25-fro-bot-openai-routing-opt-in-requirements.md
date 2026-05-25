# Fro Bot OpenAI Routing — Per-Repo Opt-In

**Status**: brainstorm
**Created**: 2026-05-25
**Reviewed**: 2026-05-25 (oracle + librarian + document-review)
**Related**: PR #303 (codex login), memory 3845 (observed model identifiers), `apps/cliproxy/` (proxy at `cliproxy.fro.bot/v1`)

## Goal

Let any Fro Bot consumer repo opt into OpenAI model routing through the existing `cliproxy.fro.bot` proxy, alongside (or instead of) the existing Anthropic routing. Decision happens at `cliproxy setup` time, per-repo, with no automatic rollout to existing consumers.

## Users + Motivation

| User | Need |
|---|---|
| Marcus | Use `openai/gpt-5.4-mini` (cheap, fast) for routine Fro Bot tasks in a chosen subset of repos — code review, autoheal, PR triage — while keeping Claude available where it's worth the cost. |
| Other consumer repos | Stay on Claude unchanged unless their operator explicitly re-runs setup with `openai` selected. |

## Verified Context (empirical + source-level)

PR #303 R8 verification (2026-05-24/25) established:

- Proxy at `https://cliproxy.fro.bot/v1` exposes **8 OpenAI models** once a Codex Pro token is loaded via `cliproxy login codex`: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `codex-auto-review`, `gpt-image-2`.
- `openai/gpt-5.4-mini-fast` does **not** exist on the proxy (returns `unknown provider for model`). Default falls back to `openai/gpt-5.4-mini`.
- `POST /v1/chat/completions` with `model: gpt-5.5` returned a clean assistant response — routing works end-to-end.

Librarian source-level verification (`fro-bot/agent@v0.44.3` + `sst/opencode`) established:

- `auth-json` is **written verbatim** to `~/.local/share/opencode/auth.json` (no transformation). Source: `src/services/setup/auth-json.ts` in `fro-bot/agent`.
- OpenCode validates each provider entry against schema `{type: "api", key: string}`. Entries missing `type` are silently filtered. Source: `packages/opencode/src/auth/index.ts`.
- `enable-omo: true` is **not required** for auth.json to be honored. Auth-json is parsed before oMo initialization.
- Verified single-key-multi-provider shape:

```json
{
  "anthropic": {"type": "api", "key": "<proxy-key>"},
  "openai":    {"type": "api", "key": "<proxy-key>"}
}
```

Both providers route through the same proxy bearer token. No separate OpenAI credential needed.

- Existing Anthropic routing remains untouched.

## Goals

- G1: A consumer repo's operator can run `cliproxy setup --harness opencode` and select Anthropic, OpenAI, or both via a multiselect prompt. Selected providers determine which entries appear in `OPENCODE_CONFIG` and `OPENCODE_AUTH_JSON`.
- G2: Non-interactive callers can pass `--providers anthropic,openai` (comma-separated) and skip the multiselect. Single-provider non-interactive runs infer that provider's default model unless `--model` is supplied; multi-provider non-interactive runs require `--model`.
- G3: When exactly one provider is selected, the wizard proposes that provider's default model (`anthropic/claude-sonnet-4-6` or `openai/gpt-5.4-mini`). When multiple providers are selected interactively, the wizard prompts the operator to pick the runtime default. Operator-supplied `--model` always wins.
- G4: Existing repos already wired to Claude continue working without any change. No automatic migration.
- G5: The setup wizard writes deterministic dual-provider `OPENCODE_CONFIG` and `OPENCODE_AUTH_JSON` values based on the selected providers + the proxy key it just created. Both use the same proxy key. The wizard does **not** attempt to merge with any existing GitHub secret value — secrets are write-only via the GitHub API.
- G6: The wizard offers a `--verify-smoke` opt-in that triggers `gh workflow run fro-bot.yaml` against the test repo, polls for up to 5 minutes with backoff, detects environment-approval gates, and reports as a non-blocking warning if unverified (rather than failing). Implementation details under Open Questions R3.
- G7: `cliproxy setup --harness opencode --providers anthropic` (single provider, anthropic-only) produces output identical to today's behavior — no observed change for existing flows.

## Non-Goals (explicit)

- Automatic provider failover, multi-model A/B routing, or per-task model selection. Single `FRO_BOT_MODEL` per repo.
- Updating consumer repos' secrets automatically. Each repo opts in by running setup.
- New harness modes (e.g., `opencode-codex`). Reuse the existing `opencode` mode.
- New top-level CLI commands. All new surface lives inside `cliproxy setup`.
- Changes to `apps/cliproxy/` deployment or the proxy's own config. Wiring is purely client-side.
- Per-provider proxy keys (i.e., one key for Anthropic, a different key for OpenAI). The proxy uses a single bearer token for all routes; one key per consumer repo, unchanged from current model. See Threat Model below.
- Cost monitoring, rate-limit telemetry, or per-provider usage dashboards. Out of scope.
- Merging with pre-existing `OPENCODE_AUTH_JSON`. Per G5, the wizard overwrites; rerunning setup is destructive to that secret. See "Destructive overwrite" below for the operator-protection mechanism.

## Threat Model

- **Single proxy key authenticates both providers per repo.** This is a deliberate simplification of the proxy contract — the proxy issues one bearer token per consumer repo and routes by model prefix in the request. If a repo's key leaks (committed to a public file, exfiltrated from CI logs, etc.), the leaker gains call-budget access to BOTH Anthropic and OpenAI through Marcus's accounts.
- **Mitigations**: keys are kept in GitHub Environment secrets (env-scoped + audit-logged). Existing `cliproxy keys remove <name>` revokes the key instantly. The proxy doesn't expose customer-side rate limit telemetry today; per-repo budgets rely on upstream provider rate limits hitting fast.
- **Per-provider keys remain a non-goal** because the proxy doesn't support them and the marginal blast-radius reduction doesn't justify the proxy-side complexity. Operators can revoke + reissue any single repo's key in one CLI call if compromise is suspected.

## Product Behavior

### Interactive flow (`cliproxy setup --harness opencode`)

After the existing repo-access checks but before the proxy-key creation step, add a new prompt:

```
?  Which providers should the proxy route?
   (Space to toggle, Enter to confirm)
   [x] anthropic   (default)
   [ ] openai      (requires Codex Pro token on proxy)
```

- Anthropic is pre-checked (matches existing behavior).
- OpenAI is opt-in.
- At least one must be selected — empty selection is rejected with a re-prompt.

When the multiselect resolves to >1 provider, a follow-up prompt (preselection is illustrative; operator picks):

```
?  Which model should Fro Bot use by default?
   (Both selected providers will still be configured.)
   ❯ openai/gpt-5.4-mini
     anthropic/claude-sonnet-4-6
     enter custom...
```

### Non-interactive flow (`cliproxy setup --harness opencode --providers ... --model ...`)

```
cliproxy setup --harness opencode --providers anthropic,openai --model openai/gpt-5.4-mini
cliproxy setup --harness opencode --providers openai
cliproxy setup --harness opencode --providers anthropic       # equivalent to current default
```

- `--providers` accepts a comma-separated list of `anthropic` and/or `openai`. Invalid values reject with a clear error listing the supported providers. Empty list rejects. Order doesn't matter; deduplicated.
- `--model` is **new CLI surface** today and must be added. Format: `<provider>/<model-id>` where `<provider>` is from a fixed allowlist (`anthropic` | `openai`) and `<model-id>` matches `^[a-z0-9][a-z0-9.\-]*$` (lowercase ASCII + digits + `.` and `-`). The full value never reaches a shell or `gh` argv — pass via structured args/stdin only.
- Validated against `--providers`: if `--model openai/...` but `--providers anthropic`, reject with a clear error listing valid model prefixes for the selected providers.
- When multiple providers are selected, `--model` is **required** in non-interactive mode. Omitting it rejects with an error pointing at `--model`. Single-provider non-interactive runs may omit `--model` (provider default used).

### CLI surface migration

The current `SetupOptions` (`packages/cli/src/commands/cliproxy/setup.ts`) carries only `key`, `repo`, `harness`. Adding multi-provider support requires extending:

- `SetupOptions` type: add optional `providers: ProviderId[]` and `model: string`
- `validateSetupOptions()`: new validation matrix for `providers` × `model` × `harness` combinations
- `buildNonInteractivePlan()`: produce different secret/var sets based on `providers`
- `getHarnessTemplate()`: accept the resolved provider set and emit conditional JSON
- CLI option registration: register `--providers` and `--model` with appropriate Zod schemas
- Help text and `packages/cli/AGENTS.md`: document the new flags + destructive-overwrite caveat

Existing call sites for the three current options remain unchanged.

### `FRO_BOT_MODEL` selection

The operator-supplied `--model` flag always wins. Otherwise:

- **Exactly one provider selected** — wizard proposes that provider's default (`anthropic/claude-sonnet-4-6` or `openai/gpt-5.4-mini`).
- **Multiple providers selected interactively** — wizard prompts; no inferred default.
- **Multiple providers selected non-interactively** — `--model` is required (validation rejects otherwise).

### Resulting secret shapes

`OPENCODE_CONFIG` (dual-provider, when both selected):

```json
{
  "provider": {
    "anthropic": { "options": { "baseURL": "https://cliproxy.fro.bot/v1" } },
    "openai":    { "options": { "baseURL": "https://cliproxy.fro.bot/v1" } }
  }
}
```

Single-provider config drops the unselected provider block.

`OPENCODE_AUTH_JSON` (dual-provider, when both selected):

```json
{
  "anthropic": { "type": "api", "key": "<proxy-key created by this setup run>" },
  "openai":    { "type": "api", "key": "<same proxy-key>" }
}
```

Single-provider auth-json drops the unselected provider entry. The proxy key value is the one the wizard just created — both providers use the same key.

`OMO_PROVIDERS` — the wizard writes this deterministically from `--providers`:

- `--providers anthropic` → `claude-max20` (current value, unchanged)
- `--providers openai` or `--providers anthropic,openai` → empirically determined during implementation. Open question R4 below — until resolved, the wizard writes the documented anthropic-only value plus a TBD openai value (planning will determine the exact token by reading `fro-bot/agent`'s oMo provider map or via probe).

`FRO_BOT_MODEL` — writes the resolved model string from G3.

### Setup-plan validation (wizard-side, before any mutation)

These checks run during the wizard execution against in-memory plan state:

- `FRO_BOT_MODEL` provider prefix matches one of `--providers`.
- Each requested model identifier exists on `/v1/models` (predicate: GET with the proxy bearer token, parse JSON, assert `data[].id` includes every requested id. 401/403 → auth error. Empty `data` → "proxy not ready" error.).
- `--providers openai` requires a successful authenticated probe of `/v1/models` returning at least one `owned_by: openai` entry (proves a Codex token is loaded).

### Workflow analyzer (repo-side, file-based)

The existing analyzer scans `.github/workflows/fro-bot.yaml` for required `with:` inputs on the `fro-bot/agent` step. Extend it for the OpenAI path:

- Warn (non-blocking) if `--providers openai` is being written but the workflow file's `with:` block doesn't pass `opencode-config` or `omo-providers` (already-checked inputs; this validates compatibility).
- Print a paste-ready snippet if a required input is missing.

The analyzer remains structure-only (file presence + key presence). Semantic provider/model checks live in the setup-plan validator above, not here.

### Mutation order

| `--providers` shape | Order |
|---|---|
| anthropic-only | Current behavior unchanged: write secrets/vars → verify proxy key |
| openai-only OR multi-provider | (1) create/reuse proxy key, (2) setup-plan validation against `/v1/models`, (3) optional smoke test (G6 / `--verify-smoke`), (4) destructive-overwrite confirmation gate (interactive: `clack.confirm`; non-interactive: `--force` required), (5) write secrets/vars |

G7 guarantees no observed change for anthropic-only flows.

### Destructive overwrite

`OPENCODE_AUTH_JSON` may already carry custom shapes (e.g., Claude OAuth refresh tokens). Since GitHub secrets are write-only, the wizard cannot detect this. Protections:

- **Interactive**: A `clack.confirm` prompt before mutation: "This will overwrite OPENCODE_AUTH_JSON, OPENCODE_CONFIG, OMO_PROVIDERS, and FRO_BOT_MODEL. Existing values are unrecoverable from GitHub. Continue?" Default = No.
- **Non-interactive**: `--force` flag required. Without it, abort with the same warning text as the interactive prompt.
- **Dry-run**: A `--dry-run` flag prints the would-write secret payloads (with the proxy key elided as `<proxy-key>` placeholder) without mutating. Operators can inspect before committing.

### Smoke test (G6, `--verify-smoke` opt-in)

When `--verify-smoke` is passed (or interactive operator opts in), after secret mutation:

- Trigger `gh workflow run fro-bot.yaml -f prompt='reply with exactly: ack'` on the target repo.
- Poll the resulting run with exponential backoff (5s, 15s, 30s, 60s, 60s) up to 5 minutes total.
- If the run is gated by environment approval, detect this and emit a non-blocking warning: "Smoke test triggered but requires approval at <url> — verification deferred."
- On run completion: PASS if the run conclusion is `success` AND the assistant output contains `ack`. Otherwise WARN with the run URL.
- Smoke test never blocks setup completion. It's an informational verification, not a gate.

Hygiene: minimal prompt only, 10s `gh` timeout per call, no body/header logging in any error path, bearer token redacted (`Bearer <redacted>`) in any console output, response captured as success/failure metadata only — never the full content.

## Open Questions (for planning)

- **R1 — Does the OpenAI path require `enable-omo: true` on the `fro-bot/agent` step?** Library source (librarian, 2026-05-25) confirmed auth.json is honored regardless of oMo. Whether `OMO_PROVIDERS` containing `openai` requires `enable-omo: true` is a separate question. **Decision**: defer to planning; treat as documentation note in `apps/cliproxy/AGENTS.md` until resolved via reading `fro-bot/agent`'s oMo provider map. Do NOT emit analyzer warnings about this until resolved.
- **R2 — OMO_PROVIDERS value for openai or multi-provider**: the right `OMO_PROVIDERS` token for OpenAI is unknown today. Resolve during planning. Until resolved, `--providers openai` and `--providers anthropic,openai` paths cannot complete a successful smoke test — implementation gates this via TODO with explicit guidance to the operator.
- **R3 — Smoke test execution context**: `gh workflow run` needs a non-default GitHub token (the operator's `gh` auth or `FRO_BOT_PAT`?). If the operator's `gh` lacks `repo` scope on the test repo, the workflow trigger fails with 403. Decide during planning whether `--verify-smoke` requires explicit `--gh-token` or just inherits the operator's `gh auth status`.
- **R4 — `OMO_PROVIDERS` empirical resolution**: see R2 — needs `fro-bot/agent` source reading or a known-working probe in another repo.

## Success Criteria

- `marcusrbrown/infra` itself (as the test bed) can opt into OpenAI by running `cliproxy setup --harness opencode --providers anthropic,openai --model openai/gpt-5.4-mini --force --verify-smoke` and have a subsequent `workflow_dispatch` of `fro-bot.yaml` route through the proxy successfully on OpenAI.
- The existing Anthropic-only consumers (current 18 keys in the proxy) continue working with no observed behavior change.
- The wizard's help text and `packages/cli/AGENTS.md` explain `--providers`, `--model`, `--force`, `--dry-run`, `--verify-smoke`, and the destructive-rerun caveat for `OPENCODE_AUTH_JSON`.
- Test surface expands to cover: single-provider anthropic (no change), single-provider openai, multi-provider with `--model`, validation rejects (missing `--model` when multi-provider non-interactive, invalid model prefix, invalid provider, missing `--force` for destructive non-interactive rerun), and `--dry-run` output shape. Existing exact-shape assertions in `setup.test.ts` need updates for the new option surface.
- No new top-level commands.

## Out of Scope (now and probably forever)

- Routing image-generation requests (`gpt-image-2`).
- Cross-provider call chaining within a single Fro Bot run.
- `cliproxy setup --harness claude-code` extension (Claude Code doesn't have an OpenAI provider model).
- `cliproxy setup --harness generic` changes (generic stays fully operator-driven).

## Risks

- **`fro-bot/agent` Action might not handle multi-provider auth-json gracefully**. Mitigated by: G6 smoke test against the test repo. Auth-json shape is source-verified (librarian, 2026-05-25) — both providers as `{type: "api", key: "<proxy-key>"}` entries.
- **A repo opts into OpenAI, then the proxy's Codex token expires** (Codex tokens are stored on the droplet at `/root/.cli-proxy-api/codex-openai@...-prolite.json`). Workflow surfaces 401 errors. Mitigated by: existing daily autoheal includes proxy-reachability checks; could be extended to category 5 to also probe a known OpenAI model (deferred to a separate brainstorm if needed).
- **Adding a multiselect adds wizard latency for callers who never want OpenAI**. Mitigated by: anthropic is pre-checked; pressing Enter accepts the existing behavior; non-interactive callers bypass entirely via `--providers anthropic`.
- **Destructive `OPENCODE_AUTH_JSON` overwrite**. Mitigated by: confirm prompt (interactive) + `--force` requirement (non-interactive) + `--dry-run` preview + clear summary at end of run.
- **`cliproxy setup` mutation surface grows materially**. Today: `--key`, `--repo`, `--harness`. New: `--providers`, `--model`, `--force`, `--dry-run`, `--verify-smoke`. The harness `opencode` path becomes the most-flagged path. Mitigated by: keeping `claude-code` and `generic` harnesses unchanged, and keeping anthropic-only opencode mode (`--providers anthropic` or default) behaviorally identical to today.
- **Smoke test deadlocks on env approval gate**. Mitigated by: bounded poll (5 min), gate detection, non-blocking warning. Smoke test never gates setup completion.
