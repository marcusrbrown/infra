---
date: 2026-05-23
topic: cliproxy-login-codex
---

# CLIProxy Login: Codex Support

## Summary

Add `infra cliproxy login codex` so a ChatGPT Pro account can be onboarded onto the CLIProxyAPI droplet, then verify that the resulting OAuth token unlocks GPT model routing through the existing API-key surface. The change is scoped to the single new provider — Codex's device-code flow — with no broader provider-agnostic refactor.

---

## Problem Frame

The CLIProxyAPI droplet has shipped `--codex-login` and `--codex-device-login` support since well before the currently-pinned `v6.10.9` release. The bottleneck is on the local CLI side: `packages/cli/src/commands/cliproxy/login.ts` accepts a `<provider>` positional argument but rejects anything other than `"claude"` with a hardcoded error. Onboarding a ChatGPT Pro subscription today means SSH'ing to the droplet manually and running the upstream binary directly — losing the TTY guard, the SSH-agent check, and the wizard-style ergonomics that `cliproxy login claude` already provides.

---

## Requirements

- **R1.** `infra cliproxy login <provider>` extends the existing `claude` branch to accept `codex`. `codex` maps to the upstream `--codex-device-login` flag.
- **R2.** Unknown providers fail fast with an error message listing the supported set (`claude`, `codex`), so the operator sees the canonical name without consulting the README. No new provider name is exposed beyond `codex` in this PR.
- **R3.** `codex` uses the device-code flow (`--codex-device-login`), not the browser-OAuth flow (`--codex-login`). The browser flow's callback binds to localhost on the droplet (port 1455) and cannot reach a local browser without SSH port forwarding; the device-code flow uses a public OpenAI URL that works from the operator's local browser regardless of where the upstream binary runs.
- **R4.** Every provider invocation passes `--no-browser` to the upstream binary, matching the existing Claude flow. No login path attempts to open a browser on the droplet.
- **R5.** All existing safeguards stay in place: TTY required (`process.stdin.isTTY`), `SSH_AUTH_SOCK` required, host resolves from `--host` → `CLIPROXY_DOMAIN` env → `cliproxy.fro.bot` default, `BatchMode=yes`, `ConnectTimeout=10`, `-tt` for PTY allocation, `stdin`/`stdout`/`stderr` inherited from the parent shell.
- **R6.** When `codex` is selected, the command prints a short pre-flight notice before establishing SSH: an instruction line telling the operator the device-code flow will print a code + a URL, and a directive to verify the URL belongs to `openai.com` before entering the code (anti-phishing guardrail). This is operator-facing text, not a programmatic check on the URL itself — the upstream binary owns URL emission.
- **R7.** Tests introduce a `Bun.spawn` mock at the SSH boundary (the existing tests in `packages/cli/src/commands/cliproxy/login.test.ts` invoke the real subprocess; this PR converts the relevant assertions to mock-based unit tests). Coverage:
  - Provider-to-flag mapping for `claude` (regression) and `codex` (new) — 2 cases
  - Unknown provider error path listing both supported names — 1 case
  - Codex pre-flight notice text appears in stdout before the SSH spawn — 1 case
  - Malformed provider names rejected without spawning ssh (e.g., empty string, `../../../etc/passwd`, strings containing `-` or whitespace) — 2 cases
  - Existing TTY-missing, `SSH_AUTH_SOCK`-missing, host-resolution, and non-zero-exit propagation tests remain — preserve, do not re-list
- **R8.** End-to-end verification step (operator-driven, not test-automated): after a successful login, the operator runs `bunx @marcusrbrown/infra cliproxy keys add <name>` to issue an API key, then issues a `POST /v1/chat/completions` request with a GPT model identifier (e.g., `gpt-4o`) and confirms the response is non-empty and not an auth error. The exact model identifier comes from the proxy's `/v1/models` endpoint once a Codex token is loaded; planning records the observed identifier inline so future docs reflect reality.

---

## Acceptance Examples

**AE1 — Codex login spawns the device-code flag with anti-phishing notice.** `Covers: R1, R3, R4, R6`

When the operator runs `infra cliproxy login codex` from an interactive terminal with `SSH_AUTH_SOCK` set, the command first prints a one-paragraph notice instructing the operator to verify the device-code URL points to `openai.com`. The resulting mocked SSH invocation includes the literal arguments `--codex-device-login --no-browser` (NOT `--codex-login`). The mock test asserts on both the printed pre-flight text and the spawn args — no real OAuth round-trip is exercised in tests.

**AE2 — Unknown provider lists supported names without spawning SSH.** `Covers: R2, R5`

When the operator runs `infra cliproxy login chatgpt`, the command fails immediately with `Unsupported provider "chatgpt". Supported: claude, codex.` No SSH connection is attempted and no upstream binary is invoked.

**AE3 — Claude flow is unchanged.** `Covers: R1, R5`

When the operator runs `infra cliproxy login claude` (the existing flow), the SSH invocation is byte-identical to today's behavior (`--no-browser --claude-login`). Every existing test against the current command keeps passing without modification beyond the test-pattern conversion from real-subprocess to mocked-`Bun.spawn`.

---

## Success Criteria

- `bunx @marcusrbrown/infra cliproxy login codex` produces a device code the operator can use in their local browser to complete ChatGPT Pro authorization, and the resulting OAuth token persists across deploys via the `cliproxy_auth` Docker volume.
- After a successful login, `bunx @marcusrbrown/infra cliproxy keys add <name>` issues an API key, and that key can route a GPT-model request through the proxy — verified by hitting `POST /v1/chat/completions` with a `model` identifier from the proxy's `/v1/models` response and receiving a non-empty assistant message. The observed model identifier is recorded in the implementation plan so docs can be updated with the real value.
- All existing `cliproxy login` test cases continue to pass after the mock-pattern conversion. Test count grows only through the new mapping, unknown-provider, pre-flight, and malformed-input cases — no existing assertion regresses.
- `bunx tsc --noEmit`, `bun test --recursive`, and `bun run lint` all pass on the branch before PR.

---

## Scope Boundaries

**Out of scope for this brainstorm (separate work):**

- **Provider-agnostic refactor / additional providers.** The upstream binary exposes Gemini, Kimi, and Antigravity OAuth flags. Adding them is deferred until a second concrete operator need arises. The hardcoded if/elseif shape stays for now; the abstraction extracts when the second provider is actually being onboarded.
- **CI/Fro Bot harness wiring for GPT models.** Extending `OPENCODE_CONFIG`, `OMO_PROVIDERS`, and `FRO_BOT_MODEL` to route through the proxy for OpenAI models is a separate brainstorm that depends on the empirical model-identifier observation in R8 / Success Criteria. Cannot specify those values without first having a working Codex token and an observed model list.
- **`cliproxy setup` harness extensions.** The interactive wizard currently supports `--harness opencode` for Claude routing. A Codex-aware harness mode is its own brainstorm with its own design questions about how the wizard mutates target-repo secrets and variables.
- **Browser-OAuth fallback (`--codex-login` + SSH port forwarding).** Considered and excluded. If the device-code flow ever breaks upstream, the operator can SSH manually with `-L 1455:localhost:1455` and run `--codex-login` directly until a CLI fallback path is needed.
- **Codex token rotation / revocation runbook.** Token rotation, revocation, and incident response for ChatGPT Pro tokens are deferred to the same shape of work as `docs/runbooks/discord-token-lifecycle.md`. The shared `cliproxy_auth` Docker volume holds tokens for both Claude and Codex; if either is compromised, the safe response is to nuke the volume and re-login both providers — but writing that runbook needs a real rotation event to drive the specifics.
- **Provider-scoped API keys.** `cliproxy keys add` currently issues keys that route any provider's traffic on the proxy. Per-provider key scoping is a future possibility; the current docs frame keys as proxy-wide, and this PR doesn't change that.

---

## Key Decisions

- **Codex-only scope.** Three independent reviewers (product-lens, scope-guardian, adversarial) flagged the original "provider-agnostic refactor" framing as scope creep over the user's literal codex ask. The provider→flag map remains the obvious next step when a second provider is actually being onboarded, but committing to public CLI surface for `gemini` / `kimi` / `antigravity` today buys nothing while creating a maintenance commitment for upstream flag drift across providers nobody currently uses.
- **Device-code flow as Codex default.** The browser-OAuth callback binds to localhost on the droplet and can't traverse SSH to a local browser without explicit port forwarding. The device-code flow exists upstream for exactly this remote-binary case. No `--device` / `--no-device` flag — the operator who needs the browser fallback can SSH manually.
- **Anti-phishing notice as pre-flight, not validation.** The CLI prints a notice telling the operator the URL should be on `openai.com`. We don't programmatically validate the URL because the upstream binary owns URL emission and we'd need to parse the binary's output stream — high carrying cost for an attacker model (compromised CLIProxyAPI binary) that isn't credible. Operator vigilance plus the public URL contract is the trust model.
- **Tests convert to mocked `Bun.spawn`.** Existing `login.test.ts` spawns real subprocesses, which means provider-mapping assertions aren't really testable without a real droplet. Converting to mocked `Bun.spawn` (matching the pattern from `gateway/status.test.ts` and the cliproxy `status.test.ts` after the MCP fidelity refactor) gives provider-mapping coverage with no live droplet dependency.

---

## Dependencies / Assumptions

- **CLIProxyAPI version**: pinned `v6.10.9` (current droplet) exposes both `--codex-login` and `--codex-device-login` per the binary's `--help` output captured during brainstorm research. No version bump needed for this work to land.
- **`cliproxy_auth` Docker volume**: tokens for ALL providers persist here. Adding Codex doesn't change the volume contract; it adds another file (`codex-<email>[-plan].json`) alongside the existing `claude-*.json`. Cross-provider blast radius (a compromise of the volume exposes both Claude and Codex tokens) is acknowledged; the recovery path is volume reset + re-login of both providers, deferred to the rotation runbook scope above.
- **`/v1/chat/completions` model identifier for GPT**: the proxy provides "OpenAI/Gemini/Claude/Codex/Grok compatible API interfaces" per the upstream README, and Codex login persists subscription metadata (Plus/Pro/Team plan type) in the token JWT. The specific model identifier (e.g., `gpt-4o`, `codex-gpt-4o`, or namespace-prefixed) is observed at the Success Criteria verification step, not assumed.
- **Device-code flow continued upstream support**: OpenAI could theoretically deprecate device-code OAuth for Codex. If that happens, this command's `codex` mapping breaks. The fallback is documented in Scope Boundaries (manual SSH + port forwarding); no programmatic version detection is in scope.

---

## Outstanding Questions

**Deferred to planning:**

- **Anti-phishing notice wording.** R6 specifies the notice exists; the exact text (length, formatting, whether it uses color or a `note()` from `@clack/prompts`) is a planning-time call.
- **Test file split decision.** Existing `login.test.ts` is small (~10 tests). Adding 6 new tests inline is fine; only split into a separate file if the conversion to mocked-`Bun.spawn` makes the file noisy.
- **Help-text update.** `cliproxy login --help` currently shows the `<provider>` positional. Planning decides whether to enumerate supported providers in the help description, add a `Supported providers:` block, or rely on the error message from R2 to convey the supported set.
