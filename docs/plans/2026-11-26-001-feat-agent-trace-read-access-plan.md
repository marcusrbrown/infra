---
title: "feat: Agent read access to traces and metrics"
type: feat
status: active
date: 2026-11-26
origin: docs/brainstorms/2026-11-26-agent-trace-access-requirements.md
---

# feat: Agent read access to traces and metrics

## Overview

The trace stack gets two read-only agent routes on traces.fro.bot, both served by a new gate service:

- `/agent/langfuse/` reaches the Langfuse MCP server and its GET read API.
- `/agent/grafana/` reaches a Grafana MCP server that queries Tempo and Prometheus.

Each consumer holds a reader token. The gate checks the token and limits each consumer. It forwards only allowlisted paths and headers, and it adds the host-held Viewer credentials itself.

The operator manages tokens with `traces reader add|list|revoke`, and manages the two backend credentials with `traces reader backend`. Two Tempo keys, a privacy update and a consumer contract complete the work (see origin: docs/brainstorms/2026-11-26-agent-trace-access-requirements.md).

## Problem Frame

Only the operator can read traces, and only through an SSH tunnel. The Systematic learner, the Fro Bot audit and local sessions cannot query Langfuse or Grafana. The collector's Langfuse key can only write. Both UIs are bound to loopback, and the Grafana container is not on the network that Caddy reaches.

## Requirements Trace

- R1. Full-content Langfuse reads: traces, observations, sessions, scores, metrics. Delivered by U2 and U3.
- R2. Tempo and Prometheus queries through a Grafana MCP server. Delivered by U3.
- R3. Two token-gated routes on traces.fro.bot, the same for CI and local, with no tunnel. Delivered by U2 and U3.
- R4. An exact path and method allowlist, with the UIs left on the tunnel. Delivered by U2 and U3.
- R5–R6. Consumers hold only reader tokens. Caller credentials are never forwarded, and host credentials are added at the gate. Delivered by U2.
- R7. Viewer-only roles, and Grafana MCP with write tools disabled. Delivered by U3 and U6, proven in U9.
- R8. Reader and sender tokens are separate. Delivered by U2 and U5.
- R9. A documented create, store and rotate step for both host credentials, with a check that the old credential is refused. Delivered by U6.
- R10–R11. Per-consumer tokens managed with `traces reader add|list|revoke`, and CI delivery by stdin. Delivered by U2 (revoke takes effect within about a second) and U5.
- R12–R13. Per-token request and concurrency limits. Reader services start after the route, and their failures never hold ingest. The rollout may hold ingest once. Delivered by U2 and U4.
- R14. The privacy page is updated before the first reader token. Delivered by U8 and enforced by rollout order.
- R15. Two Tempo keys, applied going forward. Delivered by U1.
- R16. A consumer contract. Delivered by U8.

## Scope Boundaries

These are out of scope, carried over from the origin:

- How the learner and the audit behave.
- Writing scores back to Langfuse.
- Reader tokens minted from GitHub OIDC by the broker.
- Public UIs.
- Content in Tempo.
- Scoping a token to a repository, environment or sender group.
- Reader tokens for repositories other than the three named consumers.

### Deferred to Separate Tasks

- **Hold-free deploys for reader-only changes.** Deploy treats any compose change as gated (`gatedChange` in `apps/traces/src/deploy.ts`). After this rollout, a later change that touches only reader services still holds ingest once. A follow-up PR could make the decision per service.
- **Consumer wiring in other repos.** Each consumer repository takes the contract from U8 and adds its own workflow and MCP configuration: marcusrbrown/systematic and fro-bot/.github. The origin's second success criterion (a scheduled run in marcusrbrown/systematic reads its own traces) is verified by that repo's first dispatched run reading through both routes. It is tracked as a follow-up after Unit 9, not proven inside this plan.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/traces/sender.ts` holds the token lifecycle to generalise:
  - `generateToken`, `fingerprintOf` and void lines;
  - flock-locked write-then-rename remote scripts;
  - delivery through `gh secret set` over stdin;
  - the live and refused proofs;
  - `scrub` and `guarded`.
- `packages/cli/src/commands/traces/remote.ts`: `withRemoteSession` (one ControlMaster per command), `runRemote` and `hasSentinel`.
- `apps/traces/src/health-report.ts` and its compose service: a Bun service run from a read-only mounted source with hardening flags. It also has check scopes, with `MONITORING_CHECKS` and `checkScope`, where anything unlisted counts as ingest.
- `apps/broker/src/server.ts`: a `createServer(deps)` handler with injected collaborators. `apps/broker/src/rate-limit.ts` is the limiter to copy (add eviction). `apps/broker/src/audit.ts` redacts the Authorization header.
- `apps/traces/src/deploy.ts`:
  - the `POST_ROUTE_SERVICES` group and the `startPostRouteService` gate;
  - `writeFileScript` (umask, mktemp, chown, chmod, mv);
  - `tokenFileScript`, which creates a file only when absent and never overwrites it;
  - `ownershipPrelude` and `guardedStep`;
  - the `operator` gate kind.
- `apps/traces/server/provision.ts`: `runRestore` purges tokens, and the `--reopen-ports` guard refuses to reopen while any sender group holds a real token.
- `apps/traces/config/Caddyfile` sets the global timeouts and imports the ingest state. `apps/dashboard/config/Caddyfile` is the precedent for `header_up Host`.
- `apps/cliproxy/config/Caddyfile`: a log filter that deletes credential headers.

### Institutional Learnings

- `docs/solutions/best-practices/monitoring-must-not-gate-the-ingest-it-monitors-2026-11-26.md`: start services after the route decision, and keep their failures out of ingest gates.
- `docs/solutions/workflow-issues/traces-first-deploy-cascade-2026-11-22.md`: multiplex SSH. Prove that a service uses its secret. Never probe Grafana with a wrong password, because failed sign-ins count toward its lockout.
- `docs/solutions/integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md`: poll read-backs.
- Project memories:
  - Never pass secrets in argv. Make every remote probe fail closed with a sentinel.
  - Brief every lane to use `bun --env-file=/dev/null`.
  - Never redirect a remote command to `/dev/*`.
  - Monitoring must never hold ingest.

### External References

- Langfuse v4.86.0:
  - `web/src/features/mcp/server/mcpServer.ts:118-204`: `assertToolAuthorized` checks a key's role on every tool call when `API_AUTH_MIGRATION=enforce`. Compose already sets that (`apps/traces/docker-compose.yaml:51`).
  - `security.ts`: a Host and Origin guard governed by `LANGFUSE_MCP_ALLOWED_HOSTS`.
  - `transport.ts`: the server is stateless and replies with JSON to POST.
  - The project API key dialog offers a Viewer role, and `API_KEY_PROJECT_ROLES_ENABLE` is already `true`.
- `grafana/mcp-grafana` v2.4.0 (`docker.io/grafana/mcp-grafana:2.4.0`, multi-arch):
  - Flags: `-t streamable-http`, `--address`, `--allowed-hosts`, `--enabled-tools`, `--disable-write`, `--usage-stats=disabled`.
  - Usage stats go to stats.grafana.org unless disabled.
  - It is stateless with JSON responses. `GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE` is re-read on every request.
  - It honours per-request `X-Grafana-*` overrides, so the gate must never forward them.
  - `/healthz` does not check Grafana.
- Grafana 13 service-account API:
  - `GET /api/serviceaccounts/search`, with exact-name comparison.
  - `POST /api/serviceaccounts` and `POST /api/serviceaccounts/:id/tokens`. The key is returned once.
  - `DELETE /api/serviceaccounts/:id/tokens/:tokenId`.
  - There is no file provisioning for service accounts.
- Bun 1.4: streaming bodies pass through when you forward `upstream.body`. Disable the 10 s idle timeout for each request. Known 1.4.x streaming bugs (delayed headers, lost last chunk) matter little here because both upstreams reply with JSON.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "marcusrbrown/infra: apps/traces (edge, collector tokens, health-reporter, deploy, provision), packages/cli traces and cliproxy commands, token, proxy and limiter patterns in apps/broker, apps/cliproxy, apps/dashboard and apps/gateway",
  "freshness": {
    "vcs_reference": "c6e5c62320d416d54d3ccb35eb835206ae0301be"
  },
  "budget": {
    "max_search_passes": 12,
    "max_candidate_inspections": 20,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/cli/src/commands/traces/sender.ts",
      "description": "Sender-token lifecycle: generation, fingerprints, flock-locked file edits with void lines, liveness and refusal proofs, delivery to a GitHub secret or the workstation",
      "disposition": "extend",
      "insufficiency_reason": "Keyed to fixed sender groups and the collector receivers; the reader store needs consumer names and a probe against the agent routes"
    },
    {
      "path_or_symbol": "packages/cli/src/commands/traces/remote.ts",
      "description": "One multiplexed SSH session per command, fixed remote scripts, stdin for variable data, sentinel checks",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "apps/traces/src/deploy.ts",
      "description": "Gated deploy with ownership guard, step lock, post-route service gates, create-if-absent token files and secret file writes",
      "disposition": "extend",
      "insufficiency_reason": "Needs the reader services, placeholder credential files, the gate source upload and an agent-route proof"
    },
    {
      "path_or_symbol": "apps/traces/config/Caddyfile",
      "description": "Single public site with ingest-state import, health route and 404 default",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "apps/traces/config/otelcol.yaml bearertokenauth and ratelimit",
      "description": "OTLP receiver authenticators and byte-bucket limiter inside the collector",
      "disposition": "insufficient",
      "insufficiency_reason": "Cannot forward arbitrary HTTP to a private backend, strip headers, add a credential or limit requests"
    },
    {
      "path_or_symbol": "apps/traces/src/health-report.ts",
      "description": "Bun service run from a mounted source with hardening; check scopes and verdicts",
      "disposition": "extend",
      "insufficiency_reason": "The service shape is copied for a separate gate; the reporter only gains a monitoring-scope check"
    },
    {
      "path_or_symbol": "apps/broker/src/server.ts and apps/broker/src/rate-limit.ts",
      "description": "Injected-dependency Bun handler and fixed-window per-key limiter",
      "disposition": "extend",
      "insufficiency_reason": "Broker-local and mint-specific; the limiter lacks eviction and a concurrency cap"
    },
    {
      "path_or_symbol": "apps/broker/src/audit.ts",
      "description": "Structured audit events with Authorization redaction",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/cli/src/commands/cliproxy/keys.ts",
      "description": "Plaintext whole-list key management through a management API",
      "disposition": "insufficient",
      "insufficiency_reason": "No fingerprints, refusal proof, consumer names or secret delivery"
    },
    {
      "path_or_symbol": "apps/dashboard/config/Caddyfile",
      "description": "Header-rewriting reverse proxy to a private listener",
      "disposition": "insufficient",
      "insufficiency_reason": "Fixed headers only; no auth, limits or credential injection"
    }
  ]
}
```

## Key Technical Decisions

- **The gate is a separate Bun service, `reader-gate`, not Caddy `forward_auth`.** Stock Caddy has no per-key limiter. A `forward_auth` subrequest cannot see when a request ends, so it cannot hold a concurrency slot. The gate is also kept separate from the health reporter. The reporter is an input to the ingest verdict and runs as Tempo's user, so keeping it apart keeps its blast radius small.
- **A reader token is accepted as a Bearer token or as the Basic password.** MCP clients send `Authorization: Bearer <token>`. The stock Langfuse CLI and its skill send Basic `pk:sk`, so a consumer puts any fixed username and the reader token as the secret. The gate replaces either form with the host credential.
- **Path canonicalisation.** The gate strips the `/agent/<route>` prefix. It answers `404` to any path that has a dot segment, an encoded `/` or `\\`, a NUL, an empty segment or a `;` parameter. Templated `{id}` segments must match a strict id charset. The gate forwards the canonical path it matched, never the raw one.
- **Header allowlists in both directions.**
  - **Requests:** the gate forwards only content type, accept, the MCP protocol and session headers, and user agent. Cookies, `Authorization`, every `X-Grafana-*` header and identity headers never reach an upstream.
  - **Responses:** the gate returns only content type, content length, `Retry-After` and the MCP protocol and session headers.
  - **Redirects and cookies:** an upstream 3xx or `Set-Cookie` becomes a gate `502`. Upstream destinations are fixed, and the gate follows no redirects.
- **Token store.** The tokens live in `readers/token` in the app directory. That is outside the `tokens/` root that the collector mounts, and only the gate mounts it. Each line is `<token> <fp12> <consumer> <iso-date>`, which is the sender format plus a consumer column. A void line means no tokens. The CLI replaces the file by write-then-rename. The gate mounts the containing directory read-only and re-reads the file by path about every second.
  - **Fail closed.** If the file is missing, empty, unreadable or malformed, the gate denies every request, both at start and after a reload. A malformed reload removes every token. This differs on purpose from the collector, which keeps its last good token list.
- **One token per consumer.** `add` refuses a consumer that already has a token unless `--replace` is given. `revoke <consumer>` removes every line for that consumer and proves each one refused. `list` flags any consumer that has more than one line.
  - **Uncertain delivery.** For a fresh `add`, a failed `gh secret set` revokes the new token. The consumer held nothing, so the operator re-runs. With `--replace`, a failed or uncertain delivery revokes neither token. The command prints both fingerprints and the follow-up command. The old token is removed only after delivery succeeds.
- **Revoke takes effect on the next request and needs no extra switch.** Once the gate re-reads the file, about a second later, new requests with a removed token get `401`. A request already in flight ends within the gate deadline. `revoke --all` is the reader kill switch: it writes a void line. There is no separate route hold, and ingest state does not affect reads.
- **Limits are per consumer and span both routes.** Each consumer gets a fixed-window request budget and a concurrency cap, and a global concurrency cap sits on top. A slot is held until the response body ends or the request is cancelled. Each request has a deadline, and an over-limit answer carries `Retry-After`. The values are named constants with starting values, finalised during implementation.
- **Error answers come from the gate:**
  - `401`: missing, invalid or revoked token.
  - `404`: path not on the allowlist, or a path that fails canonicalisation.
  - `405`: method not on the allowlist.
  - `429` with `Retry-After`: over the request or concurrency limit.
  - `502`: upstream unavailable; the host credential is missing, a placeholder or refused; or the upstream answered with a redirect or a cookie.
  - `504`: the deadline passed before the response headers arrived.

  Other upstream statuses pass through unchanged. The contract tells consumers never to retry a 4xx other than `429`, and to bound their retries on `429`, `502` and `504`.

- **Timeouts.** The Caddy server write timeout and the agent routes' response-header timeout must both stay above the gate deadline. The starting values are a 60 s deadline, a 70 s response-header timeout and a 110 s write timeout, and only the dial timeout stays short. Caddy's server timeouts apply to every route. Ingest bodies are capped at 4.5 MiB, so the looser write timeout costs ingest little. A test pins the rule, not just the numbers.
- **The agent routes sit outside the ingest-state imports.** They stay up while ingest is held or off. `Caddyfile.test.ts` gains a separate contract for them. The bans on naming Langfuse or Grafana upstreams still apply to every other route.
- **Networks.**
  - `reader-gate` joins `edge` (Caddy, langfuse-web) and `backend` (grafana-mcp).
  - `grafana-mcp` joins `backend` only.
  - Grafana itself stays backend-only.
  - `docker-compose.test.ts` changes its pinned bridge set on purpose.
  - The gate's only extra listener is a health endpoint that carries no secrets, so other containers on `edge` may reach it.
- **Langfuse Host handling.** The gate sends a fixed Host header for the internal name, and `LANGFUSE_MCP_ALLOWED_HOSTS` names that host. Wildcards are not allowed. A routed MCP call proves the exact value.
- **Backend credentials are checked privately before they go live.** Each `traces reader backend` command runs its check inside the gate container with `docker compose exec`. The check goes straight to the upstream with the staged credential and needs no reader token, which removes the bootstrap cycle with `reader add`. After the switch, `reader add` proves the routed path.
- **The Grafana service account and its tokens are created on the host.**
  - A CLI remote script reads the host-held Grafana admin password and calls the service-account API on loopback, signing in once per run to stay under Grafana's lockout limit.
  - It finds or creates the Viewer service account by exact name, creates a new token and writes it to a staging file.
  - It checks the staged token against Grafana, switches the file, and checks a Grafana MCP read from inside the gate.
  - **The commit point is that MCP read.** If the read fails, the script restores the previous file and deletes the new token by id, and the previous token keeps serving. Any failure before the read does the same.
  - Once the read passes, the new token stays live and is never rolled back. The script then deletes every other token on the account and proves each one is refused. That also clears tokens a snapshot restore brought back. A failed cleanup step is retried on the next run, so a rerun always converges.
  - Key material never crosses SSH or reaches the operator's terminal. Only non-secret ids are printed.
- **The Langfuse Viewer key is the only manual creation step.** The operator creates the key in the UI over the tunnel, choosing the Viewer role explicitly. They paste it at a hidden CLI prompt, and the CLI pipes it over SSH stdin to a staging file. The CLI checks the staged key privately, then switches it into `secrets/reader-gate/langfuse-basic`. The old pair stays as `.previous` until the operator deletes it in the UI and `--confirm-old-revoked` proves Langfuse refuses it. That deletion is the second manual step. The key never travels through argv, the clipboard, a GitHub secret or a deploy input, and the deploy-input conventions test enforces the last of these.
- **Deploy creates the reader file and the credential files only when they are absent, and never overwrites them,** the same way it treats token files. A new reader file holds a void line, and new credential files hold placeholders. If a credential is still a placeholder, its route answers `502` with a fixed reason. That is expected during setup and is not treated as an outage.
- **Restore purges reader tokens.** `runRestore` writes the reader void line along with the sender ones. The `--reopen-ports` guard also refuses while the reader file holds a real token. A snapshot can bring back backend credentials that were revoked since, so the restore runbook rotates both before any token is reissued.
- **Health.** A monitoring-scope check, `reader-health`, probes the gate's health endpoint, which reports Langfuse and Grafana MCP reachability separately. A down gate therefore fails `/healthz` and `traces status`, but never `ok`. A `ReaderGateDown` rule reads the reporter's existing `traces_probe_up` gauge and follows the `EmbedderDown` template. The gate has no metrics port. Per-request logs carry the consumer, route, status and fingerprint, never the token.
- **Tempo keys.** Add `gen_ai.usage.cache_write.input_tokens` and `fro_bot.subagent.session_id`, which the pinned sender emits (`genai-attributes.ts:111` and `:211` at fro-bot/agent `f6a28af`). Keep the existing `cache_creation` key. The sender omits both attributes when the value is zero or unknown, so their absence means "not recorded", not zero.

## Open Questions

### Resolved During Planning

- **Which header carries the reader token:** Bearer, or the Basic password. See the decisions above.
- **Grafana MCP placement and credential custody:** a backend-only container, with its service-account token created on the host.
- **Hold switch:** `revoke --all`.
- **Reads while ingest is held:** they stay open.
- **REST surface:** GET on traces, traces/{id}, sessions, sessions/{id}, observations (v2 and the legacy {id}), scores (v2/v3), metrics (v1/v2), and health. The Langfuse MCP endpoint also allows POST, plus GET and DELETE only if its transport answers them. Exact paths are pinned in the gate's allowlist test. **Superseded by the first rollout:** Langfuse v4.86.0 runs in events-only mode, where `traces`, `traces/{id}`, `sessions`, `sessions/{id}`, `observations/{id}`, `v2/scores` and `metrics` answer 404 before auth. The allowlist now holds `v2/observations`, `v3/scores`, `v2/metrics`, `projects` and `health`; see `docs/runbooks/trace-collection.md`.
- **Per-consumer use visibility:** gate logs (`traces logs reader-gate`). There are no counters.

### Deferred to Implementation

- Limit values and the exact deadline. Size them from one representative weekly query against the live stack.
- The exact `LANGFUSE_MCP_ALLOWED_HOSTS` value and the Host header the gate sends. Prove them with a routed MCP `initialize`.
- Whether the stock Langfuse CLI keeps a base-URL path prefix (`/agent/langfuse`) and calls only allowlisted paths. Pin the CLI version in the contract once proven.
- The exact `--enabled-tools` categories for mcp-grafana (for example, whether `search` and `datasource` are needed), and the resulting tool list, pinned in a test.
- Bun streaming behaviour on the deployed patch version. Test delayed first byte, a client disconnect and a cancelled upstream.

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

```mermaid
sequenceDiagram
  participant C as Consumer (CI or workstation)
  participant K as Caddy
  participant G as reader-gate
  participant L as langfuse-web
  participant M as grafana-mcp
  participant F as Grafana
  C->>K: /agent/langfuse/... or /agent/grafana/mcp (Bearer or Basic token)
  K->>G: proxy (outside ingest-state imports)
  G->>G: token lookup (deny-all if file bad), limits, path+method allowlist
  G->>G: drop all headers except allowlist
  alt langfuse
    G->>L: fixed Host, Basic Viewer pk:sk from host file
  else grafana
    G->>M: no credential (server reads SA token file)
    M->>F: Viewer service-account token
  end
  G-->>C: upstream response, or 401/404/405/429/502/504
```

Gate request handling, as pseudo-code:

```text
handle(req):
  token = bearer(req) ?? basicPassword(req) ; consumer = store.lookup(token)  # store is deny-all when invalid
  if !consumer -> 401
  route = allowlist.match(canonical(req.path), req.method) ; if !route -> 404/405
  if !limits.acquire(consumer) -> 429 + Retry-After
  try: res = forward(route, allowedRequestHeaders(req) + route.credential(), deadline)
       if res is 3xx or sets a cookie -> 502 ; else return allowedResponseHeaders(res) + body
  finally: limits.release(consumer) when body ends or is cancelled
```

## Implementation Units

- [ ] **Unit 1: Tempo keeps cache-write tokens and the subagent session id**

**Goal:** Two more structural keys reach Tempo.

**Requirements:** R15

**Dependencies:** None. This unit can ship on its own.

**Files:**

- Modify: `apps/traces/config/otelcol.yaml`
- Modify: `apps/traces/config/otelcol.test.ts`
- Modify: `apps/docs/src/content/docs/trace-privacy.md` (Tempo bullet)

**Approach:**

- Add both keys to the keep-list and to the test's approved copy.
- Keep the existing `cache_creation` key.
- Content keys stay banned.

**Patterns to follow:**

- The `fro_bot.*` additions from #2052.

**Test scenarios:**

- Happy path: the keep-list contains exactly the approved set, including the two new keys.
- Edge case: content keys (`gen_ai.input.messages` and the others) are still rejected.

**Verification:**

- After deploy, a TraceQL query for a new span that carries both attributes returns them.
- An older span lacks them.

- [ ] **Unit 2: reader-gate service**

**Goal:** A tested Bun service that authenticates reader tokens, enforces limits and allowlists, adds host credentials, and forwards to the two upstreams.

**Requirements:** R1, R3, R4, R5, R6, R8, R10 (revoke takes effect on the next request), R12

**Dependencies:** None.

**Files:**

- Create: `apps/traces/reader-gate/` (gate source, uploaded and mounted the way the health reporter is)
- Test: a colocated `*.test.ts` for each module: token store, auth parsing, allowlist, header filter, limits and the handler

**Approach:**

- A `createServer(deps)` handler takes an injected clock, a fetch, a store reader and a credential reader. The entrypoint wires the real ones.
- The store parses the token file and denies every request if the file is invalid. It re-reads the file by path about every second, so it picks up a rename-replace, and swaps the token set atomically.
- Credentials are read from files when they change. A missing credential or a placeholder value gives a fixed `502` reason.
- The gate canonicalises the path before matching it against the allowlist, and filters headers in both directions.
- A private check entrypoint, run through `docker compose exec`, calls one upstream directly with a credential file named on stdin and prints a sentinel. `traces reader backend` uses it, and it never listens on a port.
- Copy the broker limiter and add eviction and a concurrency cap. Release a slot when the body ends or the request is cancelled.
- Logs and audit records carry the consumer, the route, the status and the fingerprint, never the token.
- One health endpoint reports upstream reachability. It carries no secrets, and there is no metrics port.

**Execution note:** Implement test-first. Exercise the handler only through injected fetch and timers, and never run the entrypoint against real upstreams.

**Patterns to follow:**

- `apps/broker/src/server.ts`, `apps/broker/src/rate-limit.ts` and `apps/broker/src/audit.ts`.
- The `health-report.ts` listener layout.

**Test scenarios:**

- Happy path: a valid Bearer token forwards `POST /agent/langfuse/api/public/mcp` with the Viewer Basic header added and the caller's Authorization removed.
- Happy path: a token supplied as the Basic password forwards `GET /agent/langfuse/api/public/traces`.
- Happy path: a valid token forwards `/agent/grafana/mcp` with no credential and none of the `X-Grafana-*` headers.
- Error path: no token, an unknown token or a sender token gives `401`, and upstream fetch is never called.
- Error path: a token file that is missing, empty, unreadable, malformed or void-only gives `401` for every token, both at start and after a reload.
- Error path: `DELETE` or `POST` to a Langfuse REST path gives `405`, and a UI path or an unknown path gives `404`. Neither request reaches upstream.
- Error path: an over-budget consumer gets `429` with `Retry-After`, while another consumer's requests still pass.
- Error path: at the concurrency cap, the next request gets `429`, and the slot is released after the body ends and after a client cancel.
- Error path: a placeholder or missing credential gives `502` with the fixed reason, and upstream fetch is never called.
- Error path: when the upstream takes longer than the deadline before sending headers, the answer is `504`.
- Integration: a rename-replace of the token file that removes a token makes its next request `401` within the reload interval.
- Integration: a reload that leaves the file malformed denies every token.
- Edge case: `..`, `%2e%2e`, `%2f`, `%5c`, `//`, a `;` parameter and an id outside the charset each give `404`, and none of them reaches upstream.
- Edge case: the forwarded request carries only allowlisted headers. Cookies, identity headers and `X-Grafana-URL` are dropped.
- Edge case: the response carries only allowlisted headers.
- Edge case: an upstream 3xx or `Set-Cookie` becomes `502`, and the redirect is never followed.
- Edge case: log lines never contain token text.
- Happy path: the private check entrypoint reports a valid staged credential as working and a refused one as refused, and prints the sentinel in both cases.
- Happy path: the private check entrypoint's write probe reports a backend role denial for a REST write and for an MCP write tool call. Any other answer, such as a success, a network error or a missing denial, is reported as a failure.

**Verification:**

- Every listed scenario passes.
- The gate listens only on its proxy port and its health port.

- [ ] **Unit 3: Stack wiring: compose, Caddy, Langfuse host allow-list, image pins**

**Goal:** The gate and the Grafana MCP server run in the stack, behind two new Caddy routes.

**Requirements:** R2, R3, R4, R7, R13

**Dependencies:** Unit 2

**Files:**

- Modify: `apps/traces/docker-compose.yaml` (add `reader-gate` and `grafana-mcp`; set `LANGFUSE_MCP_ALLOWED_HOSTS` on `langfuse-web`)
- Modify: `apps/traces/config/Caddyfile` (agent routes, the `write` timeout, the agent-route response-header timeout, and a log filter that deletes credential headers)
- Modify: `apps/traces/src/host.ts` and `packages/cli/src/commands/traces/host.ts`, with their tests (reader token and credential paths, gate uid, service lists)
- Modify: `.github/renovate.json5` (the mcp-grafana image)
- Modify: `apps/docs/diagrams/apps/traces.architecture.json` and `apps/docs/scripts/diagram-drift.test.ts`
- Test: `apps/traces/docker-compose.test.ts` and `apps/traces/config/Caddyfile.test.ts`

**Approach:**

- `grafana-mcp` runs from `grafana/mcp-grafana`, pinned by digest, with these flags: streamable-http, an explicit address, `--allowed-hosts` set to its internal name, the enabled tool categories, `--disable-write` and `--usage-stats=disabled`. It reads its token from a file.
- The hardening matches the reporter's: read-only, no capabilities, `no-new-privileges`. Neither service publishes a port, nothing declares a `depends_on` on either one, and neither is in `INGEST_SERVICES`.
- `reader-gate` mounts `readers/` and `secrets/reader-gate/` read-only, and nothing else of the host's secrets. The collector does not mount `readers/`.
- The Caddy agent routes live in the main Caddyfile, not in the ingest-state files. Each one proxies to `reader-gate` with a short dial timeout and a response-header timeout above the gate deadline.

**Patterns to follow:**

- The `embedder` compose block and its tests.
- The dashboard `header_up` usage.
- The cliproxy log filter.

**Test scenarios:**

- Happy path: in every ingest state (off, held, open), the rendered Caddy config proxies `/agent/langfuse/*` and `/agent/grafana/*` to `reader-gate` and nowhere else.
- Edge case: every other path still answers 404, and nothing names a Langfuse, Grafana, Tempo or Prometheus upstream outside the agent routes.
- Happy path: both new images are pinned by tag and digest. mcp-grafana has `--disable-write` and `--usage-stats=disabled`.
- Edge case: the bridge set changes only by `reader-gate`. `grafana-mcp` and Grafana are not on `edge`.
- Edge case: the published ports are unchanged.
- Edge case: the new services are in no ingest list and no service depends on them.
- Edge case: `API_AUTH_MIGRATION` is `enforce`, and `LANGFUSE_MCP_ALLOWED_HOSTS` holds no wildcard.
- Edge case: the collector mounts nothing under `readers/`, and the gate mounts nothing under `tokens/`.
- Edge case: the Caddy write timeout and the agent-route response-header timeout are both greater than the gate deadline constant.

**Verification:**

- Compose, Caddy, host-constant and diagram-drift tests pass.

- [ ] **Unit 4: Deploy and health**

**Goal:** Deploy uploads the gate, creates placeholder files, and starts the reader services after the route decision. It proves the agent routes are mounted, and the reporter watches them.

**Requirements:** R9 (placeholders), R13

**Dependencies:** Units 2 and 3

**Files:**

- Modify: `apps/traces/src/deploy.ts`
- Modify: `apps/traces/src/health-report.ts`
- Modify: `apps/traces/config/grafana/alerting/rules.yaml` (`ReaderGateDown` on `traces_probe_up`)
- Test: `apps/traces/src/deploy.test.ts`, `apps/traces/src/health-report.test.ts` and the alert-rule tests

**Approach:**

- Upload the gate source as one directory.
- Create `readers/token` (void line) and both credential files (placeholders) only when they are absent, with the gate or mcp-grafana uid and mode 0400 or 0440. Never compare or overwrite them.
- Add a `READER_SERVICES` group to `POST_ROUTE_SERVICES`, with a `reader-ready` operator gate.
- After the route decision, add an operator gate that proves `/agent/langfuse/` and `/agent/grafana/` answer `401` without a token.
- Add the `reader-health` monitoring check and a `ReaderGateDown` rule.

**Patterns to follow:**

- `startPostRouteService` and `embedder-ready`.
- `tokenFileScript`.
- The `operator` gate kind.
- `MONITORING_CHECKS`.

**Test scenarios:**

- Happy path: a deploy with no reader files creates the void token file and both placeholders, with the expected owner and mode.
- Edge case: a deploy where the files already exist leaves their content untouched.
- Error path: if `reader-gate` fails to start, the run fails through `reader-ready`, ingest stays open, and the ingest verdict is unchanged.
- Integration: every new host-changing script is classified in the ownership-prelude enumeration test.
- Happy path: the agent-route proof passes on `401` and fails on any other status, including `502` or a timeout.
- Happy path: `reader-health` is in `MONITORING_CHECKS`. A failure makes `healthy` false while `ok` stays true.
- Edge case: the alert-rule count and the message-template rules pass.

**Verification:**

- Deploy and reporter tests pass.
- The conventions test for deploy inputs is unchanged: no new deploy input exists.

- [ ] **Unit 5: `traces reader add|list|revoke`**

**Goal:** The operator CLI for reader tokens.

**Requirements:** R8, R10, R11

**Dependencies:** Units 2 and 4

**Files:**

- Create: `packages/cli/src/commands/traces/reader.ts`
- Create: `packages/cli/src/commands/traces/reader.test.ts`
- Modify: `packages/cli/src/commands/traces/sender.ts` (export or extract the shared token helpers; sender behaviour unchanged)
- Modify: `packages/cli/src/commands/traces/index.ts`
- Modify: `packages/cli/src/commands/mcp.ts`
- Modify: `packages/cli/src/conventions.test.ts` (`SENSITIVE_MCP_COMMANDS`)
- Modify: `opencode.jsonc` (deny entries)

**Approach:**

- Consumer names match a short kebab pattern.
- `add <consumer>` plans the delivery first. It refuses an existing consumer unless `--replace` is given.
- `add` appends the token under the tokens lock, proves a real authenticated read through both routes, then delivers.
- CI delivery runs `gh secret set` with the token on stdin, using `--repo` and a secret name that defaults to `TRACES_READER_TOKEN`.
- Workstation delivery writes an exclusive `0600` file outside the checkout by default. `--print` is allowed on a TTY only.
- If the proof fails, revoke the new token and report its fingerprint.
- If delivery fails on a fresh `add`, revoke the new token and say to re-run.
- If delivery fails or is uncertain with `--replace`, revoke neither token. Print both fingerprints and the follow-up `revoke <consumer> <fingerprint>` command.
- `list` shows consumer, fingerprint and date only, never void lines or token text. It flags any consumer that has more than one line.
- `revoke <consumer>` removes every line for that consumer. `revoke <consumer> <fingerprint>` removes one line. Both rewrite the file, as does `revoke --all`, using a void line when it becomes empty. They prove `401` for each removed token on both routes, publicly, or over SSH when the public route is unreachable.
- `--all` reports that consumer copies still exist.
- Every command uses one SSH session.

**Patterns to follow:**

- `sender.ts` end to end, its `createWorld` test harness, and `scrub` and `guarded`.

**Test scenarios:**

- Happy path: `add systematic --repo marcusrbrown/systematic` appends one line, proves `200` on both routes, and pipes the token to `gh` on stdin. The token appears nowhere in stdout or argv.
- Error path: `add` for an existing consumer without `--replace` refuses before it generates a token.
- Happy path: `add --replace` installs and proves the new token, delivers it, then removes the old token and proves it is refused.
- Error path: on a fresh `add`, if the proof fails or `gh` fails, the new token is removed, its refusal is proven, and the output names the fingerprint and the next step.
- Error path: with `--replace`, if `gh` fails, both tokens stay, both fingerprints are printed and so is the follow-up command. `list` then flags the consumer.
- Happy path: `revoke <consumer>` with two lines removes both and proves `401` for each.
- Happy path: `add workstation` writes a 0600 file. `--print` without a TTY is refused.
- Happy path: `list` prints names, fingerprints and dates and never token text.
- Happy path: `revoke fro-bot-audit` proves `401` on both routes, and the other consumers still read.
- Edge case: `revoke --all` leaves exactly one void line and reports that the copies remain.
- Integration: one ControlMaster connection per command.
- Integration: the MCP bridge exposes no `traces reader` command, and the conventions test passes.

**Verification:**

- CLI and conventions tests pass.
- A patch changeset is added for the published CLI.

- [ ] **Unit 6: `traces reader backend` (host credentials)**

**Goal:** Install, rotate and verify the Langfuse Viewer key and the Grafana service-account token without either leaving the host improperly.

**Requirements:** R7, R9

**Dependencies:** Units 2 and 4. The private check entrypoint is in Unit 2.

**Files:**

- Create: `packages/cli/src/commands/traces/reader-backend.ts`
- Create: `packages/cli/src/commands/traces/reader-backend.test.ts`
- Modify: `packages/cli/src/commands/traces/index.ts`, `packages/cli/src/commands/mcp.ts`, `packages/cli/src/conventions.test.ts` and `opencode.jsonc`

**Approach:**

- **`backend langfuse`:**
  - Prompt for the key pair without echo.
  - Pipe it over SSH stdin to a staging file.
  - Check the staged pair privately with the gate's check entrypoint, then switch the file atomically. No reader token is needed. The check proves a read succeeds, and proves Langfuse refuses both a REST write and an MCP write tool call by role.
  - Keep the old pair in a `.previous` file until `backend langfuse --confirm-old-revoked` proves Langfuse refuses it, then delete that file.
- **`backend grafana`:**
  - A remote script signs in once with the host admin password.
  - It finds or creates the service account, matching the exact name with the Viewer role.
  - It creates a new token in a staging file and checks it against Grafana. It then switches the live file and checks a Grafana MCP read through the gate's check entrypoint.
  - It lists the account's tokens and deletes every one except the new id. The previous live token's value is still on the host as `.previous`, and the script proves Grafana refuses it. A token whose value the host never held cannot be tested by authentication, so it is deleted and a read-back by id confirms it is gone.
  - The commit point is the MCP read after the switch. Any failure up to and including that read restores the previous file, deletes the new token by id, and leaves the previous token serving. After the read passes, the new token is never rolled back. A failed cleanup step leaves it live, reports the token ids still to delete, and is retried on the next run. A rerun always converges.
  - Key material never reaches stdout. Only non-secret ids are printed.
- **`backend status`:** reports each credential as placeholder, installed, or pending old-key revocation. It never prints a value.

**Patterns to follow:**

- The `remote.ts` stdin scripts.
- The Grafana `-K -` curl config in `deploy.ts`, which keeps the admin password out of argv.
- `writeFileScript`.

**Test scenarios:**

- Happy path: on a host with no reader token, `backend langfuse` with a valid pair stages it, passes the private check, switches and keeps `.previous`.
- Error path: if the private check fails, the switch is not made and the live file is unchanged.
- Happy path: `--confirm-old-revoked` deletes `.previous` only after Langfuse answers `401` to the old pair.
- Happy path: `backend grafana` on a fresh host creates the service account and a token, proves a routed read, and prints only ids.
- Edge case: on a second run, the service account is reused (exact name match). Every other token on it, including one restored from a snapshot, is deleted after the new one is proven.
- Error path: if Grafana returns an error after the new token was created but before the switch, the new token is deleted by id and the live file is unchanged. The output names the step.
- Error path: the new token passes the direct Grafana check but fails the MCP read after the switch. The previous file is restored and the new token is deleted. The previous token still serves reads.
- Error path: if the previous token is deleted and a later deletion or check fails, the new token still serves reads and the live file is not rolled back. The output lists the remaining ids. A rerun deletes them and converges.
- Edge case: a rerun after an interrupted run converges to one live token, with the file pointing to it.
- Integration: one admin sign-in per run, the admin password and keys never in argv, and one SSH session.

**Verification:**

- Tests pass, and no secret value appears in the output of any test fixture.

- [ ] **Unit 7: Restore purges reader tokens**

**Goal:** A snapshot restore cannot bring back reader access.

**Requirements:** R10. This is a safeguard the plan adds, approved at the scope check: a restored reader file must not bring back revoked tokens.

**Dependencies:** Unit 4

**Files:**

- Modify: `apps/traces/server/provision.ts`
- Test: the provision tests

**Approach:**

- `runRestore` writes the reader void line along with the sender purge.
- The `--reopen-ports` guard refuses while the reader file holds a real token, and faults if the file is missing.
- If a pre-reader snapshot has no reader file, a void file is created.

**Patterns to follow:**

- The existing sender purge and the reopen guard.

**Test scenarios:**

- Happy path: after a restore, the reader file is void and `--reopen-ports` succeeds.
- Error path: with a real reader token present, `--reopen-ports` refuses and names the reader file.
- Edge case: a snapshot taken before reader tokens existed gets a void file, and a missing file is never read as purged.

**Verification:**

- Provision tests pass.

- [ ] **Unit 8: Privacy page, contract and docs**

**Goal:** Disclosure before issuance, a consumer contract, and operator docs.

**Requirements:** R14, R16

**Dependencies:** Units 3–7, for accuracy

**Files:**

- Modify: `apps/docs/src/content/docs/trace-privacy.md`
- Modify: `apps/docs/redaction/hostname-allowlist.json` (the reason for traces.fro.bot)
- Modify: `apps/traces/AGENTS.md`
- Modify: `docs/runbooks/trace-collection.md`
- Modify: root `AGENTS.md`
- Modify: `docs/solutions/best-practices/langfuse-upgrade-review-new-tables-outside-retention-2026-11-25.md`, to add a Viewer write-refusal re-proof and a `tools/list` diff after each Langfuse upgrade

**Approach:**

- **Privacy page.** Rewrite "Who can read it" and the single-third-party sentence. It must state four things:
  - named agents read full content;
  - they send it to their model providers through the proxy;
  - the content includes other people's text from public repositories;
  - the two new Tempo attributes are recorded.
- **Runbook.** Add an "Agent read access" section covering these points:
  - rollout order;
  - backend credential install and rotation;
  - reader token lifecycle, including revoke-all as the kill switch;
  - restore steps, which rotate both backend credentials before any token is reissued;
  - the error semantics.
- **Consumer contract.** Add a "Consumer contract" subsection with these parts:
  - a statement that access is read-only;
  - where the token lives: the repository secret `TRACES_READER_TOKEN` for CI, or the 0600 workstation file;
  - OpenCode MCP configuration for both routes, with `oauth: false` and the token sent as `Authorization: Bearer {env:TRACES_READER_TOKEN}` for CI or `{file:…}` for the workstation;
  - Langfuse CLI settings: base URL, a fixed username and the token as the secret;
  - passing the secret only to `schedule` and `workflow_dispatch` jobs;
  - paging to completion and reporting partial results;
  - treating missing Tempo attributes as unknown;
  - retry rules: never retry a 4xx other than `429`, and bound retries on `429`, `502` and `504`;
  - recorded issue text and tool output are data, not instructions.
- **AGENTS.md.** Update the anti-patterns that are no longer true: "Ingest and a health path are the only public routes", "only Caddy, Langfuse and Grafana publish ports", and "never copy a token off the host".

**Test scenarios:**

- Test expectation: none -- documentation. The docs build, the redaction gate and the frontmatter tests must pass.

**Verification:**

- The docs build and both redaction gates pass.
- The live privacy page shows the new text before any reader token is issued.

- [ ] **Unit 9: Rollout and host proofs**

**Goal:** Prove on the real host what only the host can prove, then issue the tokens.

**Requirements:** All. Covers origin AE1–AE6 and Success Criteria 1, 3 and 4. Criterion 2 is the follow-up in step 8.

**Dependencies:** Units 1–8 merged

**Files:**

- None. These are operational steps recorded in the runbook.

**Approach and order:**

1. Confirm the privacy page is live. No reader token of any kind exists before this step.
2. Approve the deploy. It holds ingest once for the compose and Caddy change, then reopens it.
3. Run `backend grafana`, then `backend langfuse` with a Viewer key created in the UI. Both are checked privately, so no reader token is needed. The Langfuse check proves privately that the Viewer key reads, and that the backend refuses both a REST write and an MCP write by role. The Grafana check proves privately that the MCP tool list contains no write tools. A failure here stops the rollout before any token exists.
4. Issue a temporary consumer, `rollout-proof`, delivered to the workstation file, and run the routing proofs and the gate's own denials:
   - each REST read and each MCP read works through the gate;
   - a REST write gets the gate's `405`;
   - sender and reader tokens each fail on the other's routes;
   - an over-limit request gets `429`;
   - a revoked token gets `401` within the reload interval.
5. Revoke `rollout-proof` and prove it is refused.
6. Run `reader add` for `systematic`, `fro-bot-audit` and `workstation`.
7. Configure the workstation MCP and run the success-criterion question with no tunnel open.
8. Park a follow-up to confirm that the first dispatched run in marcusrbrown/systematic reads through both routes.

**Test scenarios:**

- Integration: each proof in step 4 is run and its result recorded. A failure stops the rollout before step 6.

**Verification:**

- All step-4 proofs pass, and `rollout-proof` is revoked.
- Three consumers are listed.
- The workstation answers the weekly tools, errors and cache question from both stores.

## System-Wide Impact

- **Interaction graph:**
  - Caddy gains routes that do not depend on the ingest state.
  - `langfuse-web` gains an env var and one more caller.
  - Grafana gains a service account.
  - The reporter gains one check, and Grafana gains one alert rule.
- **Error propagation:**
  - Reader failures stay in reader answers (`502`/`504`) and in the monitoring verdict.
  - They never affect `ok`, the ingest route or deploy gates beyond `reader-ready`.
- **State lifecycle risks:**
  - A partial `add` or a partial rotation leaves a proven state or rolls back, as each unit describes.
  - A restore purges reader tokens and needs both backend credentials rotated.
- **API surface parity:**
  - Reader and sender CLIs share helpers. Sender behaviour and tests are unchanged.
- **Integration coverage:**
  - Viewer write refusal, routed reads and revoke cut-off are proven on the host in Unit 9. Unit tests cannot prove them. The Langfuse upgrade review re-proves write refusal after each Langfuse bump.
- **Unchanged invariants:**
  - Ingest paths, sender tokens and the ingest states are unchanged.
  - The UIs stay on the tunnel, and the tunnel ports stay the same.
  - The collector's custody of its Application key is unchanged.
  - No new deploy input or GitHub secret is added on the traces side.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Langfuse MCP does not enforce Viewer per tool in practice, now or after an upgrade | Unit 9 proof before any consumer token is issued. `API_AUTH_MIGRATION=enforce` is pinned by a test. The Langfuse upgrade review re-proves refusal and diffs `tools/list`. |
| A reader-only change later holds ingest | Accepted for now. A per-service gating decision is deferred. |
| A `workflow_dispatch` on an unreviewed branch of a consumer repo gets the reader token, because a repository secret is not bound to a ref | Accepted by the operator. One operator controls who can push to both consumer repos. A main-only Environment is the fallback if that changes. |
| A heavy agent query slows ingest | Per-consumer and global concurrency caps plus a deadline. The existing ingest-loss and 503 alerts catch harm. |
| A Bun 1.4.x streaming bug truncates responses | Both upstreams answer with JSON. Integration tests cover delayed-first-byte and cancel cases, and the Bun patch is pinned. |
| Grafana lockout from the CLI's admin sign-in | One sign-in per run, never a probe with a wrong password. |
| The raised Caddy write timeout weakens slow-response protection for ingest | 110 s is still bounded. Ingest bodies stay capped at 4.5 MiB. |
| Other backend containers can reach `grafana-mcp` without the gate | Accepted. Only trusted stack services share `backend`. |
| The rollout deploy holds ingest | Accepted in the origin (R13). Senders retry `503`. |

## Documentation / Operational Notes

- Merging Units 1–7 triggers a gated traces deploy. Each deploy that touches compose, Caddy or the collector config holds ingest once. To keep it to a single hold, ship Unit 1 in the same deploy as Units 3 and 4.
- Publish the privacy page before Unit 9 step 1, ahead of any reader token, including `rollout-proof`.
- The CLI changes need a patch changeset, so the Version Packages PR follows the merge.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-11-26-agent-trace-access-requirements.md](../brainstorms/2026-11-26-agent-trace-access-requirements.md)
- Related plan: `docs/plans/2026-11-20-001-feat-trace-collection-stack-plan.md`, recorded as active. This plan adds read routes that the earlier plan kept tunnel-only.
- Related PRs: #2052 (keep-list additions), #2094 (canary per deploy), #2101 (alerting), #2105 (Topics).
- External docs: [Langfuse MCP server](https://langfuse.com/docs/api-and-data-platform/features/mcp-server), [Langfuse RBAC](https://langfuse.com/docs/administration/rbac), [mcp-grafana v2.4.0](https://github.com/grafana/mcp-grafana/releases/tag/v2.4.0), [Grafana MCP flags](https://grafana.com/docs/grafana/latest/ai-tools/mcp/configure/command-line-flags/), [Grafana service account API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/serviceaccount/), [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
