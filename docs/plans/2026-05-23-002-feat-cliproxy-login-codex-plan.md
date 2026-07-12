---
title: 'feat: cliproxy login codex'
type: feat
status: completed
date: 2026-05-23
origin: docs/brainstorms/2026-05-23-cliproxy-login-codex-and-providers-requirements.md
---

# feat: cliproxy login codex

## Overview

Add `infra cliproxy login codex` so a ChatGPT Pro account can be onboarded onto the CLIProxyAPI droplet via the existing SSH+TTY flow, then verify GPT model routing through the proxy's API-key surface. The change is scoped to one new provider keyword (`codex` → `--codex-device-login`) plus a one-paragraph anti-phishing pre-flight notice; no broader provider-agnostic refactor lands in this PR.

## Problem Frame

The existing `packages/cli/src/commands/cliproxy/login.ts` accepts a `<provider>` positional argument but rejects anything other than `"claude"` with a hardcoded error. CLIProxyAPI's pinned `v6.10.9` binary on `cliproxy.fro.bot` exposes `--codex-device-login` and 4 other provider flags via `--help`, but the local CLI has no path to invoke them. Onboarding a ChatGPT Pro token today means SSH'ing to the droplet manually — losing the TTY guard, the `SSH_AUTH_SOCK` check, and the wizard-style ergonomics that `cliproxy login claude` already provides.

The brainstorm (see origin) settled scope at codex-only after document-review surfaced three independent reviewers flagging the original "provider-agnostic refactor" framing as scope creep. The map abstraction extracts when a second provider need actually arises; today's PR delivers exactly what the operator asked for.

## Requirements Trace

- **R1.** Extend the existing `claude` branch in `login.ts` to accept `codex`, mapped to `--codex-device-login`.
- **R2.** Unknown providers fail with `Unsupported provider "<name>". Supported: claude, codex.` — no SSH spawn attempted.
- **R3.** `codex` uses device-code flow (`--codex-device-login`), not browser OAuth (`--codex-login`).
- **R4.** Every provider invocation passes `--no-browser` (existing behavior, preserved).
- **R5.** Existing safeguards preserved (TTY guard, `SSH_AUTH_SOCK` check, host resolution, `BatchMode=yes`, `ConnectTimeout=10`, `-tt`, inherited stdio).
- **R6.** Codex login prints an anti-phishing pre-flight notice via `@clack/prompts` `note()` before establishing SSH.
- **R7.** Tests convert from real-subprocess (`Bun.spawn(['bun', 'src/cli.ts', ...])`) to mocked `spyOn(Bun, 'spawn')` pattern matching the rest of the cliproxy test suite. Coverage: claude regression, codex new path, unknown provider, malformed provider names, pre-flight notice emission. Existing TTY/SSH_AUTH_SOCK/host/exit tests stay as regression coverage.
- **R8.** Operator-driven end-to-end verification after merge: log in via codex, issue an API key, `POST /v1/chat/completions` with an observed GPT model identifier, record the identifier in implementation notes for future doc updates.

## Scope Boundaries

- Provider-agnostic refactor / Gemini / Kimi / Antigravity provider support
- CI/Fro Bot harness wiring for GPT models (`OPENCODE_CONFIG`, `OMO_PROVIDERS`, `FRO_BOT_MODEL` updates)
- `cliproxy setup --harness opencode-codex` wizard extension
- Browser-OAuth fallback via SSH port forwarding (`--codex-login` + `-L 1455:localhost:1455`)
- Codex token rotation / revocation runbook
- Per-provider API key scoping

### Deferred to Separate Tasks

- **GPT routing CI wiring**: separate brainstorm + plan once R8's verification step observes the actual model identifier returned by the proxy.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/cliproxy/login.ts` — current single-provider implementation (line 42 has the hardcoded `claude` check that R1 extends)
- `packages/cli/src/commands/cliproxy/login.test.ts` — current real-subprocess test pattern at lines 40-100; R7 converts this to mocked-`Bun.spawn`
- `packages/cli/src/commands/gateway/status.test.ts` — exemplar mocked-`Bun.spawn` pattern from the MCP fidelity refactor (uses `spyOn(Bun, 'spawn').mockImplementation(...)` with `mockSpawnResult` helper)
- `packages/cli/src/commands/cliproxy/setup.ts` — exemplar `@clack/prompts` `note()` usage for operator-facing notices (R6 follows this pattern)
- `apps/cliproxy/docker-compose.yaml` line 17 — pinned `eceasy/cli-proxy-api:v6.10.9` image with `--codex-device-login` flag confirmed via live `--help` output

### Institutional Learnings

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — CLIProxyAPI auth tokens persist in `cliproxy_auth` Docker volume; tokens for all providers land in the same volume.
- `docs/runbooks/discord-token-lifecycle.md` — exemplar token-lifecycle runbook structure; not in scope here but referenced for the deferred rotation work.

### External References

Already settled during brainstorm research. The librarian confirmed:
- `--codex-device-login` exists in `cmd/server/main.go` of CLIProxyAPI
- ChatGPT Pro subscription metadata persists in the JWT (`chatgpt_plan_type` field)
- Token storage filename pattern: `codex-<email>[-<plan>].json` in `/root/.cli-proxy-api/`

## Key Technical Decisions

- **Codex-only scope** (see origin): Document-review's three-reviewer agreement was decisive; ship the minimum that satisfies the user's literal ask.
- **Device-code flow as Codex default** (see origin): Browser-OAuth callback can't traverse SSH without port forwarding; device-code uses a public OpenAI URL.
- **Anti-phishing notice as pre-flight, not validation** (see origin): Operator-facing notice via `@clack/prompts` `note()`. Programmatic URL validation would require parsing the upstream binary's stdout stream — high carrying cost for an implausible threat model.
- **Test pattern conversion in the same PR**: Required because the existing real-subprocess tests can't validate provider-flag mapping without a live droplet. Converting establishes the mock seam R7 needs.
- **Help-text update inline**: `command()` description grows from `'Run provider login on the remote CLIProxyAPI host and print OAuth URL output.'` to `'Run provider login on the remote CLIProxyAPI host. Supported providers: claude, codex.'` — one sentence, no separate help block, error message in R2 covers the rest.

## Open Questions

### Resolved During Planning

- **Anti-phishing notice wording**: Use a `@clack/prompts` `note()` with body: `Codex login uses OpenAI's device-code flow. The droplet will print a code and a URL. Before entering the code, verify the URL points to openai.com — only complete the flow on the official OpenAI domain.` Title: `Verify the URL`.
- **Test file split**: Stay inline in `login.test.ts`. ~6 new tests on top of ~12 existing brings the file to ~18 — still small enough.
- **Help-text update**: Inline in the `command()` description, no separate `Supported providers:` block. R2's error message handles operators who pass an unsupported name.
- **Mocked-`Bun.spawn` migration approach**: Convert ALL existing real-subprocess tests in `login.test.ts` to `spyOn(Bun, 'spawn').mockImplementation(...)` pattern from `gateway/status.test.ts`. Same migration shape as the MCP fidelity refactor's Wave 3.

### Deferred to Implementation

- **Observed GPT model identifier from `/v1/models`**: R8's end-to-end verification step records the identifier. Cannot specify before login works.
- **`makeSpawnOk` / `makeSpawnError` helper location**: Either copy from `gateway/status.test.ts` directly into `login.test.ts` or extract to a shared test helper. Decide during Unit 1 based on whether other cliproxy tests would benefit (probably not — the cliproxy commands moved to ctx-capture fixtures during the MCP fidelity refactor, so this is the only cliproxy file still using subprocess testing). Default to copying directly into `login.test.ts` to keep the seam local until a second consumer arises.

## Implementation Units

- [ ] **Unit 1: Extract `cliproxyLoginAction` and convert tests to dependency-injected spawn pattern**

**Goal:** Refactor `login.ts` to expose a directly-callable named-export action function with the SSH-spawn function as an injectable dependency, then convert `login.test.ts` from real-CLI-subprocess invocations to direct action calls with an injected mock spawn. This establishes the seam every new test in Unit 2 will use, matching the dependency-injection pattern used in `packages/cli/src/commands/gateway/status.test.ts`.

**Requirements:** R7

**Dependencies:** None — this unit owns both the export refactor AND the test conversion. Unit 2 depends on this unit; this unit does not depend on Unit 2.

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/login.ts`
- Modify: `packages/cli/src/commands/cliproxy/login.test.ts`

**Approach:**
- Read `packages/cli/src/commands/gateway/status.test.ts` (lines 102-122) to understand the canonical dependency-injection pattern. The gateway test defines `type SpawnFn = (cmd: string[], opts: SpawnOptions) => SpawnedProcess`, and `makeSpawnOk(jsonOutput)` / `makeSpawnError(message)` factories return `SpawnFn` instances. The production helper signature accepts that `SpawnFn` as a parameter and tests pass mocks directly.
- In `login.ts`:
  - Extract the existing inline `.action(async (provider, options) => { ... })` body into `export async function cliproxyLoginAction(provider: string, options: LoginOptions, spawnFn: SpawnFn = Bun.spawn): Promise<void>`. The `spawnFn` parameter defaults to the real `Bun.spawn` so production callers (goke's `.action()` wiring) are unchanged.
  - Define and export `type SpawnFn` near the top of `login.ts` so tests can import it for type safety.
  - Register with goke via `.action((provider, options) => cliproxyLoginAction(provider, options))` — drops the inline closure; production code path is byte-identical.
  - All existing `Bun.spawn(...)` calls inside the action body now invoke `spawnFn(...)` instead.
- In `login.test.ts`:
  - Replace each real-CLI-subprocess test (currently `Bun.spawn(['bun', 'src/cli.ts', 'cliproxy', 'login', ...args], {...})`) with: import `cliproxyLoginAction` from `./login`, define a `makeSpawnOk(exitCode: number)` factory matching gateway's shape, and invoke `cliproxyLoginAction(provider, options, makeSpawnOk(0))` directly.
  - Each converted test asserts on:
    - The args passed to `spawnFn` (i.e., the SSH command + remote command construction)
    - The exit behavior when `spawnFn` returns a non-zero exit code
  - Preserve every existing assertion's intent — the migration is mechanical: same contract, different invocation seam.
  - Existing `resolveHost` and `requireSshAuthSock` unit tests stay as-is (they don't spawn anything).
- Tests now run as in-process calls rather than child-process invocations — substantially faster.

**Execution note:** Run the converted tests after each test migration to catch regressions early. Don't migrate all tests then run once — incremental cycles surface mistakes faster.

**Patterns to follow:**
- `packages/cli/src/commands/gateway/status.test.ts` (lines 91-140) — `SpawnFn` type, `makeSpawnOk` / `makeSpawnError` factories, direct action invocation with injected spawn function. This is the canonical pattern for SSH-spawning commands.
- `packages/cli/src/commands/cliproxy/status.ts` — exemplar named-action-export pattern (`export async function cliproxyStatusAction(...)` registered via `.action(cliproxyStatusAction)`)

**Test scenarios:**
- Test expectation: regression coverage only — every existing test from the pre-conversion `login.test.ts` must continue to pass with the same intent. New scenarios land in Unit 2.

**Verification:**
- `bun test packages/cli/src/commands/cliproxy/login.test.ts` passes with the same number of tests as before the conversion
- No real-CLI-subprocess invocations of `Bun.spawn(['bun', 'src/cli.ts', ...])` remain in the file (grep proves it)
- `bunx tsc --noEmit` clean

---

- [ ] **Unit 2: Add codex provider mapping + anti-phishing notice + new tests**

**Goal:** Extend the provider check from `claude`-only to `claude` and `codex`, emit the anti-phishing pre-flight notice when `codex` is selected, and add Tier-2 tests for the new behavior.

**Requirements:** R1, R2, R3, R4, R5, R6, R7

**Dependencies:** Unit 1 (mock seam must exist before new tests can use it)

**Files:**
- Modify: `packages/cli/src/commands/cliproxy/login.ts`
- Modify: `packages/cli/src/commands/cliproxy/login.test.ts`

**Approach:**
- In `login.ts` (action function was already extracted in Unit 1):
  - Add a `PROVIDER_FLAGS` constant inside the file (not exported, not over-abstracted): `const PROVIDER_FLAGS: Record<string, string> = { claude: '--claude-login', codex: '--codex-device-login' }`. This is the minimal mapping; it's a map because R1 maps name → flag.
  - Replace the hardcoded `if (provider !== 'claude') throw ...` check with: `const providerFlag = PROVIDER_FLAGS[provider]; if (!providerFlag) throw new Error(\`Unsupported provider "${provider}". Supported: claude, codex.\`)`.
  - Replace the literal `--claude-login` in the remote command with `${providerFlag}`.
  - Update the `command()` description to: `'Run provider login on the remote CLIProxyAPI host. Supported providers: claude, codex.'`
  - Update the `.example()` calls to include a codex example: `.example('# Start ChatGPT Pro login flow via device-code')`, `.example('infra cliproxy login codex')`.
  - Add the `@clack/prompts` `note()` call after the TTY/SSH_AUTH_SOCK checks but BEFORE the SSH spawn, conditional on `provider === 'codex'`. Notice title `'Verify the URL'`; body `Codex login uses OpenAI's device-code flow. The droplet will print a code and a URL. Before entering the code, verify the URL points to openai.com — only complete the flow on the official OpenAI domain.`
- In `login.test.ts`:
  - Add a happy-path test for codex asserting the SSH command contains `--codex-device-login --no-browser` (NOT `--codex-login`)
  - Add a happy-path test for claude (regression) asserting the SSH command contains `--claude-login --no-browser`
  - Add an unknown-provider test asserting `Unsupported provider "chatgpt". Supported: claude, codex.` is thrown and no `Bun.spawn` is called
  - Add two malformed-provider tests: empty string `''` and a string containing path traversal `'../../../etc/passwd'` — both rejected before SSH spawn
  - Add a pre-flight notice test for codex asserting the notice text appears in captured stdout BEFORE the spawn call. Capture mechanism: `spyOn(console, 'log')` to record `@clack/prompts.note()` output (since `note()` writes via `console.log`), assert order via comparing `consoleLogSpy.mock.invocationCallOrder[0]` with the `spawnFn` spy's invocation order. Restore the spy in `afterEach`.
  - Pre-flight notice does NOT appear for claude (regression test asserting no `Verify the URL` text in `consoleLogSpy.mock.calls`)

**Execution note:** TEST-FIRST per the brainstorm's Key Decisions. Write the failing test for codex first, prove RED, implement the codex branch, prove GREEN. Same cycle for the pre-flight notice. Don't bundle all tests + impl together.

**Patterns to follow:**
- `packages/cli/src/commands/cliproxy/setup.ts` — `@clack/prompts` `note()` usage example (search for `note(` to find the call pattern). Note that `note()` writes via global `console.log`, so capturing it in tests requires `spyOn(console, 'log')`.
- Unit 1's `SpawnFn` injection pattern — Unit 2's new tests follow the same pattern, just with new scenarios.

**Test scenarios:**
- Happy path: `provider='codex'` invokes Bun.spawn with `--codex-device-login --no-browser` in the SSH command args
- Happy path: `provider='claude'` invokes Bun.spawn with `--no-browser --claude-login` in the SSH command args (regression)
- Error path: `provider='chatgpt'` throws `Unsupported provider "chatgpt". Supported: claude, codex.` and `Bun.spawn` is never called
- Error path: `provider=''` (empty) throws the same shape error
- Error path: `provider='../../../etc/passwd'` (path-traversal-looking) throws the same shape error
- Integration: when `provider='codex'`, the pre-flight notice text appears in captured stdout before `Bun.spawn` is invoked (assert spy call order)
- Regression: when `provider='claude'`, the pre-flight notice text does NOT appear in captured stdout

**Verification:**
- `bun test packages/cli/src/commands/cliproxy/login.test.ts` shows 6+ new tests passing on top of the existing converted set
- `bunx @marcusrbrown/infra cliproxy login codex` from a fresh terminal (with `SSH_AUTH_SOCK` set, `cliproxy.fro.bot` reachable) prints the anti-phishing notice, then opens the device-code flow
- The operator's manual end-to-end verification (R8) succeeds: a Codex token lands in `cliproxy_auth` volume, `cliproxy keys add` issues a key, `POST /v1/chat/completions` with the observed model identifier returns a non-empty response
- `bunx tsc --noEmit` clean, `bun run lint` no new errors

## System-Wide Impact

- **Interaction graph:** `login.ts` is the only file with a behavior change. The named-action-export adds a new import path that tests use; the goke `.action()` registration uses the function reference (no wrapper). No callbacks, middleware, or observers downstream.
- **Error propagation:** Provider-name errors surface via thrown `Error` at the action body (existing pattern). `Bun.spawn` exit-code propagation unchanged.
- **State lifecycle risks:** None new. Tokens land in `cliproxy_auth` volume (existing volume contract).
- **API surface parity:** `cliproxy login` is operator-only and not in the MCP allowlist (`packages/cli/src/commands/mcp.ts`). Confirmed — login is excluded with reason "interactive (OAuth callback URL paste, requires TTY)". Adding codex doesn't change MCP exposure.
- **Integration coverage:** R8's operator verification step is the integration test. Unit tests prove the SSH command construction and notice emission; only a live droplet can prove the OAuth flow + token persistence + model routing.
- **Unchanged invariants:** Existing `cliproxy login claude` behavior is byte-identical to before. AE3 in the origin doc commits to this.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| OpenAI deprecates the device-code flow | Origin doc's Dependencies / Assumptions section acknowledges this; fallback is documented manual SSH + port forward (`-L 1455:localhost:1455` + `--codex-login`). No code-level mitigation in scope. |
| `cliproxy_auth` Docker volume is destroyed (e.g., `docker compose down -v`) | All tokens lost (Claude AND Codex). Recovery: re-login both providers. Acknowledged in origin's Dependencies; rotation runbook deferred. |
| Cross-provider blast radius if volume is compromised | Documented in origin's Dependencies section. No new mitigation added; same risk model as the current Claude-only state. |
| Mocked-`Bun.spawn` migration breaks an existing test assertion | Unit 1 converts incrementally with verification between each test migration. If a test breaks, the conversion is wrong, not the behavior. |
| Anti-phishing notice spammy if operator runs `codex` repeatedly | Notice prints once per invocation. Operator doing rapid retries sees it each time, but that's acceptable — the trust message lands on every attempt. Not adding a "skip notice" flag. |

## Documentation / Operational Notes

- No AGENTS.md updates required. The change is operator-facing (one new provider name); the existing `cliproxy login` documentation in `packages/cli/AGENTS.md` describes the command without enumerating providers.
- After R8's verification step observes the GPT model identifier, the implementation report records it inline so future docs (CI harness wiring brainstorm, README updates) reflect the real value.
- No README change in scope. README mentions `cliproxy login claude` as an example; adding `cliproxy login codex` is a 1-line update that can land alongside this PR or in a follow-up depending on how much README churn fits cleanly.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-23-cliproxy-login-codex-and-providers-requirements.md](../brainstorms/2026-05-23-cliproxy-login-codex-and-providers-requirements.md)
- **Existing command:** `packages/cli/src/commands/cliproxy/login.ts`
- **Existing tests:** `packages/cli/src/commands/cliproxy/login.test.ts`
- **Mocked-spawn exemplar:** `packages/cli/src/commands/gateway/status.test.ts`
- **`@clack/prompts` `note()` exemplar:** `packages/cli/src/commands/cliproxy/setup.ts`
- **CLIProxyAPI upstream:** [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (v6.10.9 currently deployed)
- **Related code:** `packages/cli/src/commands/mcp.ts` (login is in the cli-only exclusion list — no MCP surface change needed)
