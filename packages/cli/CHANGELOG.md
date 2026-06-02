# @marcusrbrown/infra

## 0.9.8
### Patch Changes


- Stop exposing mutating and secret-disclosing commands through the MCP server. `gateway backup`, `cliproxy keys list`, `cliproxy keys add`, `cliproxy keys remove`, `cliproxy config get`, and `cliproxy config set` are no longer registered as MCP tools — they remain available via the direct CLI. This keeps key and secret operations out of reach of autonomous agents while the read-only status tools stay exposed. ([#374](https://github.com/marcusrbrown/infra/pull/374))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `7.1.38` to `7.1.39` ([#370](https://github.com/marcusrbrown/infra/pull/370))

## 0.9.7
### Patch Changes


- `cliproxy login codex` now surfaces a clear error when the remote CLIProxyAPI binary predates `--codex-device-login` support (requires v6.10.9+), pointing to a new provider-version-skew runbook instead of a cryptic SSH exit code. ([#369](https://github.com/marcusrbrown/infra/pull/369))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `7.1.37` to `7.1.38` ([#367](https://github.com/marcusrbrown/infra/pull/367))

## 0.9.6
### Patch Changes


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `7.1.36` to `7.1.37` ([#364](https://github.com/marcusrbrown/infra/pull/364))

## 0.9.5
### Patch Changes


- `cliproxy setup --harness opencode` no longer writes the `OMO_PROVIDERS` secret. Proxy routing is driven entirely by the `OPENCODE_CONFIG` provider `baseURL`, so `OMO_PROVIDERS` was vestigial; the workflow analyzer also no longer flags repos that omit `omo-providers` from their Fro Bot workflow. ([#359](https://github.com/marcusrbrown/infra/pull/359))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `7.1.33` to `7.1.34` ([#357](https://github.com/marcusrbrown/infra/pull/357))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `7.1.34` to `7.1.36` ([#358](https://github.com/marcusrbrown/infra/pull/358))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `7.1.32` to `7.1.33` ([#353](https://github.com/marcusrbrown/infra/pull/353))

## 0.9.4
### Patch Changes


- Gateway deploy materializes GitHub App credentials (`github-app-id`, `github-app-private-key`) plus the optional `discord-privileged-intents` file, and `gateway deploy --local` forwards the corresponding env vars. Updates the gateway daemon pin to `fro-bot/agent` v0.46.1, enabling the `/fro-bot add-project` repository-onboarding command. ([#346](https://github.com/marcusrbrown/infra/pull/346))

## 0.9.3
### Patch Changes


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `7.1.31` to `7.1.32` ([#343](https://github.com/marcusrbrown/infra/pull/343))

## 0.9.2
### Patch Changes


- ⚠️ Update dependency `fro-bot/agent` from `0.44.2` to `0.46.1` ([#337](https://github.com/marcusrbrown/infra/pull/337))
  
  ⚠️ **Breaking Changes**: This update includes breaking changes that may require code modifications.

## 0.9.1
### Patch Changes


- Make `cliproxy status` and `cliproxy setup` compatible with CLIProxyAPI v7. The status command reads recent activity from the new `usage-queue` endpoint (the old `usage` endpoint was removed) and probes the management API once before issuing parallel calls so a wrong key no longer risks the v7 IP-ban. `setup` tolerates `/v1/models` entries that omit `owned_by`, inferring the provider from the model id instead. The deployed proxy image is pinned to v7.1.31. ([#331](https://github.com/marcusrbrown/infra/pull/331))

## 0.9.0
### Minor Changes


- Add `umami` commands for the self-hosted Umami analytics deployment at `metrics.fro.bot`. ([#321](https://github.com/marcusrbrown/infra/pull/321))
  
  `infra umami status` reports the Docker Compose service health over SSH, `infra umami deploy` triggers the deploy (remote workflow by default, or `--local`), and `infra umami logs` streams container logs. The unified `infra status` now includes a `umami` row and a `umami` key under `--json`.

## 0.8.1
### Patch Changes


- `cliproxy setup` verifies its GitHub writes landed and warns about concurrent runs. ([#316](https://github.com/marcusrbrown/infra/pull/316))
  
  After writing secrets and variables, setup re-lists the repo's secret and variable names and warns if a just-written name is not visible. An empty secret list from a successful `gh` call — a scope-limited token or replication lag — otherwise looks identical to a fresh repo and silently disables the ack-key-reuse and collision gates. The readback distinguishes a verified mismatch (the name is provably absent, so the token's list view is unreliable and the gates may have been bypassed) from a cannot-verify case (the readback call itself failed). It never throws and never rolls back a successfully created key.
  
  The non-interactive `--force` overwrite warning states that concurrent setup runs against the same repo resolve last-write-wins. `packages/cli/AGENTS.md` gains an Operational Limitations section covering the concurrency boundary and the transient-empty gate bypass.

- `cliproxy setup --verify-smoke` tolerates malformed `gh run list` output. ([#319](https://github.com/marcusrbrown/infra/pull/319))
  
  The smoke test now validates the `gh run list` JSON payloads with a schema before reading them. A malformed or unexpected payload degrades to an `unverified` result instead of throwing or misreading run fields, keeping the wizard's smoke-test step on its existing pass/fail/unverified contract.

## 0.8.0
### Minor Changes


- `cliproxy setup` is now structured for testability. The action handler is exposed as a named `runSetupCommand` export with a dependency-injectable `RunSetupDeps` shape, and the file was split into focused submodules (`setup/providers.ts`, `setup/prompts.ts`, `setup/templates.ts`, `setup/validation.ts`, `setup/gh.ts`, `setup/workflow-analyzer.ts`, `setup/smoke-test.ts`, `setup/preview.ts`). ([#312](https://github.com/marcusrbrown/infra/pull/312))
  
  New CLI surface:
  
  - `--ack-key-reuse` — required in non-interactive mode when `--key` is supplied for a repo that already has `OPENCODE_AUTH_JSON` set. GitHub's secrets API is write-only, so the CLI cannot verify the supplied bearer token matches the one inside the existing secret; the flag is the operator's explicit acknowledgment. Interactive mode prompts for the same confirmation.
  - `--verify-smoke` runs now emit a single `[smoke-test] kind=<kind>` line on stdout so MCP and agent harness consumers can parse the result without log-scraping.
  
  Behavior clarifications:
  
  - `--force` now reads as "overwrite existing GitHub secret values" instead of implying proxy-key rotation. The pre-gate (`confirmDestructiveProviderChange`, renamed from `mustConfirmDestructive`) and the collision-gate throw text both call out that `--force` does NOT rotate the underlying CLIProxyAPI proxy bearer token — that's preserved byte-for-byte when `--key` is supplied.
  - `--providers` help text now surfaces the `anthropic` default. `--model` help text now states it's required when multiple providers are selected.
  - `/v1/models` response parsing now uses a Zod schema with `passthrough()`; malformed responses surface clearer error messages with the affected JSON paths.
  
  The `packages/cli/AGENTS.md` documentation gains a Migration Recipe section describing the canonical anthropic-only → dual-provider invocation, plus a `shared.ts` convention note for the cliproxy-local management API helpers (`managementHeaders`, `requestJson`) that are now consolidated.

## 0.7.0
### Minor Changes


- Add per-repo OpenAI provider opt-in to `cliproxy setup --harness opencode`. ([#307](https://github.com/marcusrbrown/infra/pull/307))
  
  The wizard now supports a provider multiselect (anthropic pre-checked; openai opt-in) interactively, and a `--providers anthropic,openai` flag plus `--model openai/gpt-5.4-mini` non-interactively. Selected providers determine the entries in OPENCODE_CONFIG and OPENCODE_AUTH_JSON. Anthropic-only flows are byte-identical to today (no opt-in needed). Adds `--force` (required for destructive overwrite in non-interactive mode), `--dry-run` (preview planned secrets without mutating), and `--verify-smoke` (post-mutation smoke test with bounded poll + env-gate detection).
  
  Auth-json shape source-verified against `fro-bot/agent@v0.44.3+`: `{type: "api", key: "<proxy-key>"}` per provider, same proxy key for both providers, no `enable-omo: true` required for proxy-routed OpenAI.

## 0.6.0
### Minor Changes


- Add `cliproxy login codex` for onboarding ChatGPT Pro accounts via the device-code OAuth flow. Extends the existing `cliproxy login <provider>` command to accept `codex` alongside `claude`, mapped to the upstream CLIProxyAPI `--codex-device-login` flag. Before establishing SSH, the command emits an anti-phishing notice instructing the operator to verify the device-code URL points to `openai.com`. ([#303](https://github.com/marcusrbrown/infra/pull/303))
  
  The login action now exports a named `cliproxyLoginAction` function with an injectable SSH-spawn dependency, replacing the prior inline closure. Production callers are unchanged; tests invoke the action directly with mocked spawn. Provider validation uses `Object.prototype.hasOwnProperty.call()` to reject prototype-chain keys (`__proto__`, `constructor`, `hasOwnProperty`).

### Patch Changes


- 📦 Update npm dependency `@modelcontextprotocol/sdk` from `^1.29.0` to `1.29.0` ([#299](https://github.com/marcusrbrown/infra/pull/299))

## 0.5.0
### Minor Changes


- MCP server now returns the same formatted output operators see at the terminal, instead of empty content. The change refactors the 10 read-style commands (`gateway status`, `gateway backup`, `cliproxy status`, `cliproxy keys list/add/remove`, `cliproxy config get/set`, `keeweb status`, and the unified `status` dashboard) to route output through goke's per-action execution context, so `@goke/mcp` captures it into the `CallToolResult`. ([#296](https://github.com/marcusrbrown/infra/pull/296))
  
  Two commands (`cliproxy keys list` and `cliproxy config get`) additionally return parseable structured data alongside the formatted text — MCP consumers receive both blocks, so agents can act on the data without re-parsing the formatted output.
  
  The 9 CLI-only commands (deploys, gateway logs, gateway restore, cliproxy login/open/setup, keeweb open) are deliberately excluded from MCP via an explicit `commandFilter` allowlist in `mcp.ts`. Each exclusion has a one-line reason in the source — subprocess streaming deferred to MCP v2 (#291), TTY requirements, destructive policy (#292), and host-machine side effects.
  
  `packages/cli/AGENTS.md` documents the full MCP fidelity contract: allowlist authority, ctx threading rules, Mode C eligibility criteria, the Tier-1+Tier-2 test bar, and `@goke/mcp` upgrade discipline (pre-1.0 means manual review).

## 0.4.11
### Patch Changes


- Fix `gateway status` crash on NDJSON output from docker compose ps v2.21+ ([#278](https://github.com/marcusrbrown/infra/pull/278))

## 0.4.10
### Patch Changes


- Fix gateway deploy local mode to forward all required env vars (DISCORD_TOKEN, AWS_*, S3_*) plus the optional S3_ENDPOINT, OBJECT_STORE_HOSTS, and AWS_SESSION_TOKEN. The previous narrow allowlist made `gateway deploy --local` unusable on most configurations and silently produced wrong mitmproxy egress allowlists for R2/MinIO endpoints. ([#273](https://github.com/marcusrbrown/infra/pull/273))


- 📦 Group update for 11 npm dependencies ([#261](https://github.com/marcusrbrown/infra/pull/261))

## 0.4.9
### Patch Changes


- 🐳 Update Docker image `caddy` from `2.11.2-alpine` to `2.11.3-alpine` ([#236](https://github.com/marcusrbrown/infra/pull/236))


- ⚠️ Update Docker image `caddy` to v86 ([#244](https://github.com/marcusrbrown/infra/pull/244))

## 0.4.8
### Patch Changes


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.10.2` to `6.10.4` ([#216](https://github.com/marcusrbrown/infra/pull/216))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.10.1` to `6.10.2` ([#215](https://github.com/marcusrbrown/infra/pull/215))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.45` to `6.9.47` ([#204](https://github.com/marcusrbrown/infra/pull/204))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.49` to `6.10.0` ([#208](https://github.com/marcusrbrown/infra/pull/208))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.10.0` to `6.10.1` ([#211](https://github.com/marcusrbrown/infra/pull/211))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.47` to `6.9.49` ([#207](https://github.com/marcusrbrown/infra/pull/207))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.10.4` to `6.10.6` ([#219](https://github.com/marcusrbrown/infra/pull/219))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.10.8` to `6.10.9` ([#225](https://github.com/marcusrbrown/infra/pull/225))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.10.6` to `6.10.8` ([#220](https://github.com/marcusrbrown/infra/pull/220))

## 0.4.7
### Patch Changes


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.43` to `6.9.45` ([#199](https://github.com/marcusrbrown/infra/pull/199))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.41` to `6.9.42` ([#195](https://github.com/marcusrbrown/infra/pull/195))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.39` to `6.9.40` ([#190](https://github.com/marcusrbrown/infra/pull/190))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.40` to `6.9.41` ([#193](https://github.com/marcusrbrown/infra/pull/193))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.38` to `6.9.39` ([#186](https://github.com/marcusrbrown/infra/pull/186))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.42` to `6.9.43` ([#196](https://github.com/marcusrbrown/infra/pull/196))

## 0.4.6
### Patch Changes


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.35` to `6.9.38` ([#179](https://github.com/marcusrbrown/infra/pull/179))

## 0.4.5
### Patch Changes


- Handle GitHub API rate limit errors in `cliproxy setup` wizard — all `gh` CLI calls now retry with a user-confirm prompt (interactive) or re-throw with reset time (non-interactive) instead of failing immediately. ([#176](https://github.com/marcusrbrown/infra/pull/176))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.34` to `6.9.35` ([#175](https://github.com/marcusrbrown/infra/pull/175))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.31` to `6.9.34` ([#172](https://github.com/marcusrbrown/infra/pull/172))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.30` to `6.9.31` ([#169](https://github.com/marcusrbrown/infra/pull/169))

## 0.4.4
### Patch Changes


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.29` to `6.9.30` ([#159](https://github.com/marcusrbrown/infra/pull/159))

## 0.4.3
### Patch Changes


- `cliproxy setup --harness opencode` workflow check now handles workflows ([#133](https://github.com/marcusrbrown/infra/pull/133))
  with multiple `fro-bot/agent` steps, reports per-step gaps with a step
  ordinal, renders the paste snippet at the canonical 10-space indent
  (drop-in under the `with:` key), and distinguishes four workflow states
  via a discriminated union (`missing` / `unreachable` / `no-agent-step` /
  `analyzed`) so the caller can't forget a case. A workflow that exists
  but has no `fro-bot/agent` step now surfaces a dedicated warning
  ("exists but has no `fro-bot/agent` step") instead of the generic
  missing-input list. Observation-only — the target repo workflow is
  never modified. Addresses Fro Bot's non-blocking concerns from the
  PR #125 follow-up review.

- Add post-setup check that warns when the target repository's ([#125](https://github.com/marcusrbrown/infra/pull/125))
  `.github/workflows/fro-bot.yaml` is missing required Fro Bot inputs. After
  `cliproxy setup --harness opencode` completes, the wizard fetches the
  target repo's workflow file, locates the `fro-bot/agent` step, and
  verifies the four required inputs (`auth-json`, `opencode-config`,
  `omo-providers`, `model`) are wired to that specific step. Missing
  inputs produce a warning with the exact snippet to add under the `with:`
  block. The scan is step-scoped (not whole-file), so a same-named input
  in a sibling step (e.g. `strategy.matrix.model:` or a custom action
  with `model:`) cannot mask a genuine gap in `fro-bot/agent`'s wiring.
  
  If the workflow file is missing the check distinguishes 404 from other
  `gh api` failures (auth, rate limit, 5xx, network): a 404 points the
  user at `marcusrbrown/infra` as a reference template, while a non-404
  surfaces the stderr so the user can diagnose transport issues instead
  of chasing a missing-file red herring. Non-fatal in both cases —
  setup itself still completes.
  
  Without `opencode-config` the baseURL override is ignored and Fro Bot
  hits `api.anthropic.com` with the proxy key, which fails with 401 —
  this check catches the gap before the user discovers it in a failed
  run. Observation-only: the target repo's workflow is never modified.

- Fix `cliproxy setup` wizard to default `FRO_BOT_MODEL` to `anthropic/claude-sonnet-4-6` ([#124](https://github.com/marcusrbrown/infra/pull/124))
  instead of the unprefixed `claude-sonnet-4-6`. OpenCode requires provider-qualified model
  identifiers. Added regression tests that lock in the provider prefix, the `OMO_PROVIDERS`
  value, the `OPENCODE_CONFIG` baseURL `/v1` suffix, and the `OPENCODE_AUTH_JSON` shape so
  the same default drift cannot recur silently.

## 0.4.2
### Patch Changes


- 📦 Update GitHub Actions workflow dependencies: `fro-bot/agent`, `github/codeql-action`, `github/codeql-action/upload-sarif` ([#117](https://github.com/marcusrbrown/infra/pull/117))

## 0.4.1
### Patch Changes


- fix(cli): hardening fixes for setup wizard, build, and browser launch ([#104](https://github.com/marcusrbrown/infra/pull/104))
  
  - CI build now throws when DROPBOX_APP_SECRET is unset (closes #95)
  - `keeweb open` uses fire-and-forget to avoid hanging on Linux xdg-open
  - Setup wizard validates management key early (before prompts, not step 8/10)
  - `gh secret set` pipes values via stdin instead of --body CLI argument
  - Setup wizard rolls back newly created proxy keys on partial failure

- ⚙️ Update GitHub Actions workflow dependency `fro-bot/agent` from `v0.39.0` to `v0.39.1` ([#109](https://github.com/marcusrbrown/infra/pull/109))

## 0.4.0
### Minor Changes


- feat(cli): restructure commands, add status dashboard, setup wizard, and open commands ([#98](https://github.com/marcusrbrown/infra/pull/98))
  
  Restructured CLI from flat `<app>-<action>.ts` to `<app>/<action>.ts` with barrel
  index files. Added 4 new commands: `keeweb open` (browser launcher with headless
  fallback), `cliproxy open` (TUI via SSH), top-level `status` (unified parallel
  health check dashboard with `--json`), and `cliproxy setup` (interactive onboarding
  wizard using `@clack/prompts`). Polished management output: `keys list` defaults to
  numbered list, `config get` to aligned key:value format, `status` appends usage summary.

### Patch Changes


- ⚠️ Update GitHub Actions workflow dependency `fro-bot/agent` from `v0.38.0` to `v0.39.0` ([#100](https://github.com/marcusrbrown/infra/pull/100))

## 0.3.8
### Patch Changes


- ⚠️ Update Docker image `eceasy/cli-proxy-api` to v6 (6) ([#91](https://github.com/marcusrbrown/infra/pull/91))


- 🐳 Update Docker image `eceasy/cli-proxy-api` from `6.9.23` to `6.9.24` ([#97](https://github.com/marcusrbrown/infra/pull/97))


- ⚙️ Update GitHub Actions workflow dependency `bfra-me/.github` from `4.16.3` to `4.16.4` ([#90](https://github.com/marcusrbrown/infra/pull/90))

## 0.3.7
### Patch Changes


- Fix cliproxy deploy race condition where the post-deploy health check fired before the `cli-proxy-api` container finished booting (~3-5s startup). The `docker compose up -d` now uses `--wait --wait-timeout 90` to block until the container's Docker-level healthcheck reports `healthy` before continuing. The existing app-level HTTP health check remains as the second verification layer. ([#82](https://github.com/marcusrbrown/infra/pull/82))


- Exclude docs, tests, and fixtures from deploy workflow filter so AGENTS.md and test-only changes under `apps/keeweb/` and `apps/cliproxy/` no longer trigger unnecessary production/cliproxy deployments. Adds `predicate-quantifier: every` to make dorny/paths-filter negation patterns actually take effect (default `some` uses OR logic and silently ignores negations). ([#81](https://github.com/marcusrbrown/infra/pull/81))


- ⚙️ Update GitHub Actions workflow dependency `actions/create-github-app-token` from `v3.1.0` to `v3.1.1` ([#87](https://github.com/marcusrbrown/infra/pull/87))


- ⚙️ Update GitHub Actions workflow dependency `bfra-me/.github` from `4.16.2` to `4.16.3` ([#85](https://github.com/marcusrbrown/infra/pull/85))

## 0.3.6
### Patch Changes


- Harden CLIProxyAPI deployment stability: remove placeholder API key from config template, add Docker restart policies and healthcheck, guard provision script against destructive reruns, add pre-deploy management key validation, switch health gate to self-contained endpoint, add `--output` flag to `cliproxy config get`, and fix management API auth documentation. ([#62](https://github.com/marcusrbrown/infra/pull/62))

## 0.3.5
### Patch Changes


- Fix cliproxy deploy wiping API keys by skipping config.yaml upload when it already exists on server ([#56](https://github.com/marcusrbrown/infra/pull/56))

## 0.3.4
### Patch Changes


- Improve `cliproxy keys add` output with human-readable success message ([#51](https://github.com/marcusrbrown/infra/pull/51))

## 0.3.3
### Patch Changes


- Fix all CLIProxyAPI management API calls against source-verified endpoints ([#48](https://github.com/marcusrbrown/infra/pull/48))
  
  - keys add: send bare JSON array (not `{api_keys: [...]}`)
  - keys list: parse `api-keys` (hyphenated) response key
  - usage stats: read from nested `.usage` object, not top-level
  - config set: use per-field PUT endpoints (`/debug`, `/request-retry`, etc.) with `{"value": <val>}` body
  - version check: parse `latest-version` key from `/v0/management/latest-version`

## 0.3.2
### Patch Changes


- Fix cliproxy login hanging after pasting callback URL ([#45](https://github.com/marcusrbrown/infra/pull/45))
  
  - Allocate TTY with `-tt` so the paste prompt works interactively
  - Remove `BatchMode=yes` which blocks keyboard input
  - Explicitly inherit stdin for the SSH subprocess

## 0.3.1
### Patch Changes


- Fix cliproxy login command and bunx dependency resolution ([#42](https://github.com/marcusrbrown/infra/pull/42))
  
  - Fix `cliproxy login claude` failing with "no configuration file provided" by running docker compose from `/opt/cliproxy/` on the remote host
  - Fix `bunx @marcusrbrown/infra` failing with "Cannot find package 'zod'" by bundling all runtime dependencies in the published tarball

## 0.3.0
### Minor Changes


- Add CLIProxyAPI deployment and management support ([#35](https://github.com/marcusrbrown/infra/pull/35))
  
  - New CLI commands: `cliproxy status`, `cliproxy deploy`, `cliproxy config get/set`, `cliproxy keys list/add/remove`, `cliproxy login`
  - Docker Compose deployment to DigitalOcean with Caddy TLS
  - Management API integration for config, API keys, and usage stats
  - GitHub Actions deploy workflow with `cliproxy` environment
  - MCP bridge auto-exposes all new commands as tools

## 0.2.0
### Minor Changes


- Add test infrastructure and fix --dry-run behavior ([#29](https://github.com/marcusrbrown/infra/pull/29))
  
  - First test suite: 35 tests across CLI commands, build pipeline, deploy contracts, and status checks
  - Wire Bun's built-in test runner into CI as a parallel job alongside lint and type-check
  - Fix `--dry-run` to print the deploy plan without requiring build artifacts or environment setup
  - Export internal functions with path-override parameters for testability
  - Add `import.meta.main` guard on `build.ts` for safe test imports

## 0.1.0
### Minor Changes


- First release of the infrastructure CLI with keeweb status, deploy, and MCP bridge commands ([#15](https://github.com/marcusrbrown/infra/pull/15))
