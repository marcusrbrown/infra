---
date: 2026-11-04
topic: opencode-go-behind-cliproxy
---

# OpenCode Go Behind CLIProxyAPI

## Summary

The CLIProxyAPI key each repo already holds will also serve OpenCode Go models, under an `opencode-go/` prefix. Repos select them through `agent setup`, the gateway workspace and broker-minted keys. Go route health goes into status, and the monitor alerts on it separately from Claude. A second phase waits for a billing probe. It adds a direct Go route for repos that skip the proxy, plus an OpenCode Console CLI area for usage reports and service-account keys.

---

## Problem Frame

Each consumer repo holds one CLIProxyAPI key, which routes to Claude and GPT through OAuth subscriptions. An OpenCode Go subscription is a flat-rate plan with a different model lineup: GLM, Kimi, DeepSeek, Qwen and others. Nothing in the infra can reach it today. That leaves three gaps:

- Agent runs can't be moved onto cheaper models.
- If the proxy loses a provider credential, every repo whose default model uses that provider stops. On 2026-10-31 a full disk truncated the Claude credential on cliproxy, and every Claude request failed until a manual re-login.
- No repo can choose those models alongside Claude and GPT.

The provider set is hard-coded to Anthropic and OpenAI in setup, model listing, the provider probe and the broker. The OpenCode Console documents an inference API but exposes little for management. No API creates personal keys, reports plan status or shows Go limits remaining.

---

## Actors

- A1. Operator (Marcus): configures repos, holds the Go subscription, receives alerts.
- A2. Consumer repo agents: fro-bot workflow runs, Discord and dashboard runs in the gateway workspace, and runs using broker-minted short-lived keys.
- A3. CLIProxyAPI: the shared proxy that routes each model id to an upstream.
- A4. OpenCode Console: Go inference and its management APIs.

---

## Requirements

### Phase 1: proxy route

**Proxy upstream**

- R1. CLIProxyAPI serves OpenCode Go models as an OpenAI-compatible upstream on the stock image. No plugin, custom binary or on-droplet build is involved.
- R2. A Go model id can never collide with a Claude or GPT model id. OpenCode sends the bare upstream id (`glm-5.3`), and the proxy routes it without forcing the prefix. The deploy fails if any exposed Go id equals a model id served by another upstream.
- R3. The deploy owns the Go upstream entry. It refuses to write if the live upstream section holds any entry it doesn't track. Otherwise it applies the tracked entry with the Go key from a repository secret passed explicitly to the cliproxy deploy. It then reads the entry back, compares it, and retries briefly before failing closed. Key values never appear in its output.
- R4. After applying, the deploy sends one minimal request to a Go model through the proxy. It fails unless that request succeeds and is billed to the Go plan.
- R5. The exposed models are the Go text models that a tracked privacy snapshot marks as zero-retention and not training on submitted data. The deploy decides exposure from the snapshot, the tracked Go settings and the live Go model list, never from the docs page.
- R6. A script builds the snapshot from OpenCode's published Go privacy table and records the source commit it read. For each model it records training, retention, any region requirement and any agreement expiry. A scheduled workflow re-runs the script and opens a PR when the table changes, so new and removed models arrive for review without hand-editing.
- R7. The model list fails closed. A model is exposed only when the snapshot shows it as zero-retention. The deploy denies a model if any of these hold:
  - It appears in the live Go model list but not in the snapshot.
  - It is zero-retention only under a non-default region.
  - Its zero-retention agreement has expired.
  - Any snapshot field for it is missing or invalid. If the filtered set is empty, the deploy fails and the previously applied list stays.
- R8. OpenCode Go rejects requests that lack the `x-opencode-session` header. The proxy passes the client's session header through to Go. The deploy check, status probe and monitor each send their own.

**Consumers**

- R9. `agent setup` offers OpenCode Go as a provider next to Anthropic and OpenAI. A repo can choose proxy-routed Go with the proxy key it already has.
- R10. The gateway workspace accepts proxy-routed Go models. Its guard checks only that the selected model's provider points at the proxy. The workspace egress allowlist keeps blocking direct Go, and it must not gain the OpenCode inference host.
- R11. Broker-minted credentials add the Go provider only together with a proxy base URL for it, so a minted key can never reach OpenCode directly. Every policy-matched run can then spend the Go plan, and that is accepted. The mint response today is a bare `auth.json` map with no place for a base URL, so R11 is deferred until fro-bot/agent agrees a mint contract that carries one. Until then, broker responses stay Anthropic and OpenAI.
- R12. `cliproxy models` can filter to Go models.

**Status and alerting**

- R13. The proxy Go route appears in `cliproxy status` and in unified status and history as its own observation, separate from the Claude route. Public output carries only the route state and a reason class. It never carries cost, usage or limit values.
- R14. The scheduled monitor probes one Go model through the proxy. It keeps its own issue and Discord state, so a Go failure never opens, closes or changes the Claude alert.
- R15. Plan-limit exhaustion is its own reason, distinct from dead or missing auth. Each response reports which balance it was billed to. A Go-route response billed to anything other than the Go plan is also its own reason, so spend that leaks to pay-as-you-go balance raises an alert.

### Phase 2: direct route and Console CLI (gated on R16)

- R16. A live probe runs before Phase 2 is planned. It uses a throwaway service-account key read from stdin, then revokes the key. It answers three questions:
  - Does service-account traffic bill the single-member Go plan or pay-as-you-go balance?
  - Do the usage-export and key-lifecycle endpoints behave as documented?
  - What response does a Go plan limit produce through the proxy?
- R17. `agent setup` offers a direct Go route for repos that skip the proxy. The repo's credentials then point at OpenCode with a per-repo Go key. The route is chosen at setup and never switches at run time. The key source is service-account keys (R19) or operator-pasted personal keys, as the probe decides.
- R18. Go key material enters `agent setup` without appearing in argv, logs, prompts or command history.
- R19. A service-account key lifecycle command lists, mints and revokes keys for the CLI's own service account. It is CLI-only. The credential that authorizes minting stays in local secrets. A minted key is printed once and never stored, and each mint or revoke logs an audit line with no key material. It is built only if the probe shows service-account traffic bills the Go plan.
- R20. A usage report command shows Go spend over 24 hours, 7 days or 30 days, by model, as the cost check for moving runs onto Go. It is CLI-only and never enters public status, history or the docs site.
- R21. A read-only Go status command lists the Go models and reports each configured route, direct and proxied. It reuses the status probe rather than adding a second one, and it is exposed over MCP.

---

## Acceptance Examples

- AE1. **Covers R2, R8, R9.** A repo set up for proxy-routed Go runs a Go model. The proxy routes it to OpenCode Go with the client's session header attached. A Claude request from the same key still reaches Claude.
- AE2. **Covers R3.** The live upstream section holds an entry the deploy doesn't track. The deploy stops before writing and names the entry. It does not print the key.
- AE3. **Covers R4.** The tracked entry reads back correctly, but the Go request through the proxy fails. The deploy fails.
- AE4. **Covers R5, R6, R7.** OpenCode adds a model to its privacy table as zero-retention.
  - The scheduled refresh opens a snapshot PR.
  - Until that PR merges, the live model is denied.
  - After merge, the next deploy exposes it.
  - A model marked as training on submitted data is never exposed.
- AE5. **Covers R7.** An exposed model's zero-retention agreement passes its recorded expiry. The next deploy stops exposing it, even though the snapshot has not changed. Between deploys, the monitor alerts on the exposed ineligible model.
- AE6. **Covers R14, R15.** The Go plan hits its 5-hour limit.
  - The monitor opens a Go alert with a quota reason.
  - The Claude alert stays as it was.
  - When the limit resets, the Go alert closes.
- AE7. **Covers R15.** A Go-route response reports billing to the pay-as-you-go balance. The monitor alerts with a billing reason.
- AE8. **Covers R16, R17, R19.** The probe shows service-account traffic bills the pay-as-you-go balance. The direct route then uses operator-pasted personal keys, and R19 is not built.

---

## Success Criteria

- A repo runs a real agent task, tool calls included, on a Go model through its existing proxy key. A proxy-routed run in the gateway workspace does the same.
- When the proxy loses its Claude credential, the operator can move a repo's default model to Go and that repo keeps running.
- A Go outage, plan exhaustion or balance billing shows up as its own alert and status observation on the next monitor run. Claude alerting does not change.
- Planning can take Phase 1 from this doc as written. Phase 2 needs only the probe result added.

---

## Scope Boundaries

- Automatic failover between routes or providers at run time.
- Creating or revoking personal keys, plan status, Go limits remaining, credits and plan changes. The Console has no API for these.
- Budget management.
- Serving Go through this proxy to anyone other than the operator's own repos and agents.
- Anthropic-protocol Go models under the Claude surface, and custom executors or plugins.
- Direct Go in the gateway workspace.

---

## Key Decisions

- **Config-only upstream over a plugin or custom build.** `examples/custom-provider` is an SDK demo that needs a custom binary. A runtime plugin is only worth it for custom logic, and this work needs none.
- **The upstream section is written as a whole, guarded.** CLIProxyAPI can edit an existing upstream entry by name but has no way to create one, so the deploy writes the upstream section. This is a section-level endpoint, so the whole-document `config.yaml` ban is untouched. The refuse-on-untracked-entry rule (R3) keeps that write from deleting anything infra doesn't own. `apps/cliproxy/AGENTS.md` records the rule in the same change.
- **A deploy proves routing, not just config.** Config readback alone passed during the 2026-10-31 V2 rollout while every model call failed. R4 adds a real request.
- **The zero-retention list comes from a vendored snapshot that a scheduled PR refreshes.**
  - No API carries the privacy data. The models endpoint and models.dev have no retention or training fields.
  - The only source is the hand-written Go privacy table in OpenCode's public docs source.
  - The terms ban automated scraping of the Services, which rules out fetching the docs page on each deploy. Reading the public source file at a pinned commit stays outside that ban.
  - Region rules and agreement expiries are prose footnotes in that table. The snapshot turns them into reviewed fields.
  - A refresh changes what gets exposed only after review.
- **What "fallback" means.** The route is chosen at setup, and there is no failover at run time, which keeps the 2026-05-25 decision. Proxy-routed Go covers loss of a provider credential on the proxy, by a manual switch of the repo's model. It does not cover the proxy itself going down. A direct route covers that only for repos that skip the proxy.
- **Phasing.** Phase 1 delivers all three stated gaps. Phase 2 depends on the billing probe and has real costs:
  - A direct-route key sits in a repo secret that runners can read, and any run in that repo can spend the plan with it.
  - Setup today writes one key and one base URL for every provider.
- **Broker keys get Go, once the mint contract carries a base URL.** The spend exposure is accepted. The proxy base URL requirement (R11) closes the misrouting risk. Phase 1 defers the broker change until that contract exists upstream.
- **Prior work.**
  - Per-repo provider opt-in with one proxy key is recorded as completed in `docs/brainstorms/2026-05-25-fro-bot-openai-routing-opt-in-requirements.md`. That work excluded per-provider keys and usage dashboards. Phase 2's direct-route key and usage report are deliberate extensions of it.
  - `agent setup` as the owner of model credentials is recorded as completed in `docs/plans/2026-08-01-001-feat-agent-s3-durable-storage-plan.md`.

---

## Dependencies / Assumptions

- The Go subscription is a single-member plan. OpenCode's terms limit use to the account holder's own use. This work treats the operator's own repos and agents as within that limit.
- Extra Usage is off on the Go plan, so a plan limit blocks requests instead of spending balance. R15 alerts if it isn't off.
- The pinned CLIProxyAPI release supports OpenAI-compatible upstreams with a prefix, edits by entry name, and hot reload. This was verified against source at the pinned tag, not against the running server.
- Two changes in this work are security-boundary changes and need operator sign-off: any change to the fro-bot workflow egress allowlist, and any change to the gateway workspace model guard.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R6][Technical] How the refresh script parses the privacy table and its footnotes. The table has no region or expiry columns.
- [Affects R8][Needs research] Whether the pinned CLIProxyAPI copies a downstream header onto an OpenAI-compatible upstream request. Its upstream `headers` config documents a copy-from-request form, but that path is untraced. One request through a staged entry confirms it.
- [Affects R14, R15][Needs research] The status and body a Go plan limit returns through the proxy. Phase 1 can't wait for R16, so this needs its own check.
- [Affects R14][Technical] The monitor and status probe send one tiny request per run. OpenCode clients may send a second title-generation request on the same Go model. Neither should matter for allowance, but planning should count requests per run.
- [Affects R9, R17][Technical] Setup writes one key and one base URL for every provider. Phase 2 needs per-provider values.
- [Affects R3][Technical] A management read returns the Go key in clear. The broker holds the management key, so its reach now extends to the Go credential.

---

## Sources / Research

- OpenCode Console docs, read 2026-11-04:
  - Inference API: https://opencode.ai/v2/docs/console/api/inference/
  - Go plan (models, limits, privacy, client rules): https://opencode.ai/v2/docs/console/go/
  - API keys and scopes: https://opencode.ai/v2/docs/console/api/
  - Terms of service: https://opencode.ai/legal/terms-of-service
- CLIProxyAPI at the pinned tag:
  - Upstream config types: `internal/config/config_types.go`
  - Management handlers: `internal/api/handlers/management/config_lists.go`
  - Model prefixing: `sdk/cliproxy/service_models.go`
  - SDK demo: `examples/custom-provider/main.go`
- Repo:
  - cliproxy config ownership and field-apply rules: `apps/cliproxy/AGENTS.md`, `docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md`
  - Setup provider set: `packages/cli/src/commands/agent/setup-core/`
  - Gateway model guard: `buildGatewayEnvFileContents` in `apps/gateway/src/deploy.ts`
  - Broker credentials: `apps/broker/src/server.ts`
  - Provider probe and monitor: `packages/cli/src/commands/cliproxy/status.ts`, `monitor.ts`
- 2026-10-31 credential loss on cliproxy: `docs/solutions/integration-issues/cliproxy-unpruned-image-store-disk-full-truncated-oauth-2026-10-31.md`
- Deploy checks don't prove routing: `docs/solutions/workflow-issues/opencode-v2-gateway-rollout-deploy-checks-do-not-prove-provider-routing-2026-10-31.md`
- Probes run 2026-11-04:
  - **Request shape:** OpenCode sends the bare model id to `/v1/chat/completions`. It adds `x-opencode-session` automatically for providers whose id starts with `opencode`. Captured with a local echo server.
  - **Session header:** Go returns 400 `MissingSessionID` when the request has no session header.
  - **Billing:** each response reports `usage.opencode.billing_source` (`go` for plan traffic).
  - **Models endpoint:** 28 models, with no privacy, retention or region fields.
  - **Privacy source:** the privacy table lives in `services/www/src/docs/content/console/go.mdx` in anomalyco/opencode. DeepSeek's zero-retention agreement runs through 2026-11-30.
