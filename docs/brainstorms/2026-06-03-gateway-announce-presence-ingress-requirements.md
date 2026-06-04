---
date: 2026-06-03
topic: gateway-announce-presence-ingress
---

# Gateway Announce / Presence Ingress

## Summary

Enable the gateway's opt-in announce/presence webhook by giving it its first public HTTPS surface: a Caddy reverse proxy fronting the daemon's `POST /v1/announce` endpoint at `https://gateway.fro.bot/v1/announce`, plus deploy-side wiring to materialize the two announce secrets and turn the endpoint on. Scope is the gateway-side receiving end only; the external caller that signs and posts announces lives in `fro-bot/.github` and is tracked separately.

---

## Problem Frame

The gateway daemon (`fro-bot/agent` v0.52.1) ships an opt-in announce feature: a signed `POST /v1/announce` webhook that turns an HMAC-verified request into a rich Discord embed posted **as the Fro Bot user** to a fixed channel. The intended use is control-plane presence — `fro-bot/.github` GitHub Actions posting a message when notable autonomous activity happens (surveys completing, collaboration invitations accepted). Discord's own webhooks post as a webhook bot, not as the user; the gateway already holds `DISCORD_TOKEN` and a live discord.js client, so it is the natural place to turn a signed POST into a user-posted embed.

Today this feature is deliberately off. The gateway was deployed with no public HTTP surface — it connects outbound to Discord, S3, and (via the mitmproxy egress allowlist) cliproxy only. The two announce secrets are unset, so the daemon never starts its HTTP server, and the upstream compose leaves the announce env pointers and secret mounts commented out. The control plane therefore has no way to surface Fro Bot presence in Discord, even though the daemon-side capability is built, tested, and shipping. The gap is purely the receiving infrastructure: a TLS ingress and the deploy wiring to enable the endpoint.

---

## Actors

- A1. Gateway daemon (`fro-bot/agent`): runs the announce HTTP server on container-internal `:3000` when both announce secrets are present; verifies HMAC + replay + rate limit; posts the embed to the presence channel as the Fro Bot user.
- A2. Caddy reverse proxy (new gateway-side service): terminates public TLS on `:443` for `gateway.fro.bot`, forwards plain HTTP to the daemon's `:3000`.
- A3. Control-plane caller (`fro-bot/.github` GitHub Actions): signs a payload with the shared webhook secret and POSTs it to the public announce URL. **Out of scope for this effort** — listed for context; wired separately in that repo.
- A4. Operator (Marcus): seeds the two announce secrets, picks the presence channel, approves the gated deploy.

---

## Key Flows

- F1. Presence announce (end-to-end, target state)
  - **Trigger:** Notable autonomous activity in the control plane.
  - **Actors:** A3 (caller, out of scope), A2 (Caddy), A1 (daemon).
  - **Steps:** Caller signs payload with the shared secret → `POST https://gateway.fro.bot/v1/announce` → Caddy terminates TLS, forwards to daemon `:3000` → daemon verifies HMAC + timestamp + replay → posts embed to the presence channel as Fro Bot.
  - **Outcome:** A presence embed appears in the Discord presence channel; duplicate/replayed/unsigned requests are rejected.
  - **Covered by:** R1, R2, R3, R5, R6

- F2. Deploy with announce enabled
  - **Trigger:** Operator triggers the gateway deploy after the two announce secrets are set in the `gateway` environment.
  - **Actors:** A4 (operator), deploy script.
  - **Steps:** Deploy materializes the two announce secret files + a `compose.override.yaml` (post-`git clean`) that adds the Caddy service and un-comments the announce env pointers + secret mounts → `docker compose up` auto-merges the override → daemon boots with the announce server on; Caddy obtains/serves the TLS cert.
  - **Outcome:** `https://gateway.fro.bot/v1/announce` is reachable over TLS and the daemon's announce server is live; with the secrets unset, none of this is materialized and the gateway stays private (both-or-neither preserved).
  - **Covered by:** R2, R3, R4, R7, R8

---

## Requirements

**Ingress (TLS termination)**
- R1. A Caddy reverse proxy runs as a gateway-side service, publishing `:80` and `:443`, terminating HTTPS for `gateway.fro.bot` (Let's Encrypt auto-cert, mirroring the cliproxy/umami pattern), and forwarding to the daemon's announce HTTP port over plain HTTP inside the stack.
- R2. The Caddy service and its config are introduced without modifying upstream's `compose.yaml` — they are added via a `compose.override.yaml` that `docker compose up` auto-merges, materialized on the droplet after `git clean` so it survives the upstream reset.

**Announce enablement (daemon)**
- R3. The deploy materializes the two announce inputs — `GATEWAY_WEBHOOK_SECRET` (the sensitive HMAC key) and `GATEWAY_PRESENCE_CHANNEL_ID` (a non-sensitive Discord channel ID, flowing through the same secret-file materialization for uniformity) — and wires the daemon to read them (env `*_FILE` pointers + secret mounts, supplied via the override), so the daemon starts its announce HTTP server.
- R4. The feature is strictly both-or-neither, and the gate is **atomic across both the Caddy ingress and the daemon wiring**: only when both announce inputs are present does the deploy materialize the Caddy service, the published ports, AND the daemon announce wiring together; if either is absent it materializes none of them and the gateway retains its no-public-surface posture. The deploy must never reach a state where Caddy publishes `:443` to a daemon with no announce server running (a live public port to nothing). The deploy fails fast with a clear message naming the missing input if exactly one is set.

**Security posture**
- R5. Authentication is the daemon's existing HMAC signature verification (constant-time) plus its replay cache and rate limiter; Caddy provides TLS. No IP allowlist or additional network gate is added.
- R6. The shared `GATEWAY_WEBHOOK_SECRET` is a strong random value, materialized via SSH stdin like all other gateway secrets (never via argv), and stored in the `gateway` GitHub Environment + repo `.env`.
- R9. Caddy proxies only the announce path: it forwards `POST /v1/announce` (and the ACME challenge paths Caddy needs for auto-cert) to the daemon and returns 404/405 for everything else — it does not blanket-proxy the daemon's `:3000`. This bounds the public surface to the one intended route even if the daemon exposes other internal HTTP routes now or later.

**Operational**
- R7. The announce endpoint is reachable at the stable public URL `https://gateway.fro.bot/v1/announce` (the host already resolves; no new DNS record required for SSH — but see the Resolve-Before-Planning preflight on public-IP resolution + inbound :80/:443 for Let's Encrypt).
- R8. The gated-deploy posture is unchanged: enabling/redeploying still goes through the `gateway` environment approval. Rollback is a single canonical sequence: remove both announce inputs from the `gateway` environment, then redeploy — and the deploy must actively **delete** any previously-generated `compose.override.yaml` (and announce secret files) when the inputs are absent, not merely stop rewriting them, so no stale override keeps Caddy or the published ports alive. Post-rollback, `docker compose config` shows no Caddy service and no published ports (gateway is byte-for-byte private again).

---

## Acceptance Examples

- AE1. **Covers R4.** Given both announce secrets are set in the `gateway` environment, when the gateway deploys, then the Caddy service + announce wiring are materialized and `https://gateway.fro.bot/v1/announce` responds over TLS.
- AE2. **Covers R4.** Given neither announce secret is set, when the gateway deploys, then no Caddy service, no published ports, and no announce server exist — the gateway stays outbound-only.
- AE3. **Covers R4.** Given exactly one announce input is set, when the gateway deploys, then the deploy fails fast with a message naming the missing input (mirrors the daemon's own both-or-neither contract) — and never materializes a Caddy service publishing `:443` to a daemon without the announce server running.
- AE6. **Covers R8.** Given a prior deploy enabled announce (the override + secret files exist on the droplet), when both inputs are removed and the gateway redeploys, then the deploy deletes the generated override + announce secret files and `docker compose config` shows no Caddy service and no published ports.
- AE4. **Covers R5.** Given the endpoint is live, when a request arrives with a missing or invalid HMAC signature, then the daemon rejects it (401) and posts nothing.
- AE5. **Covers R5.** Given a valid signed request was already processed, when an exact replay arrives within the window, then it is rejected and no duplicate embed is posted.
- AE7. **Covers R9.** Given the endpoint is live, when a request hits any path other than `POST /v1/announce` (or the ACME challenge paths), then Caddy returns 404/405 and does not reach the daemon.

---

## Success Criteria

- A signed test request to `https://gateway.fro.bot/v1/announce` posts an embed to the presence channel as the Fro Bot user; an unsigned/replayed one is rejected.
- With the announce secrets unset, the gateway is byte-for-byte its current private self (no Caddy, no published ports, no HTTP server) — proving the opt-in is clean and reversible.
- The change adds no edits to upstream's `compose.yaml`; the override is the only ingress mechanism, and a future upstream bump still `git reset --hard`s cleanly.
- A downstream planner can implement without re-deciding the exposure model, the security posture, or the both-or-neither contract.

---

## Scope Boundaries

- The control-plane caller in `fro-bot/.github` (the GitHub Action that signs + POSTs announces) is out of scope — tracked as separate work in that repo. This effort ships only the receiving end.
- No IP allowlist, WAF, or network-level gate beyond TLS + the daemon's HMAC/replay/rate-limit.
- No new DNS records (host already resolves); no changes to the gateway's outbound egress model (mitmproxy/workspace unaffected).
- No multi-channel routing or payload-driven channel selection (single presence channel via `GATEWAY_PRESENCE_CHANNEL_ID`, per the daemon's v1).
- Not coupled to the mention-loop work blocked on `fro-bot/agent#749`; announce/presence is an independent daemon capability.
- **Identity ceiling (hard non-goal):** this ingress exists solely to expose the announce/presence webhook. It must never evolve into a general-purpose gateway API. Adding any new public route, reusing the Caddy ingress for unrelated control-plane calls, or broadening what the daemon exposes publicly requires a new requirements doc — not an incremental override edit. The gateway stays outbound-only-plus-announce, not "a service with an API."

---

## Key Decisions

- Public HTTPS ingress via Caddy (not a private tunnel): matches upstream's explicit "TLS terminates at the ingress in `marcusrbrown/infra`" design and reuses the proven cliproxy/umami Caddy pattern.
- HMAC + TLS only, no IP allowlist: GitHub Actions egress ranges are large, churny, and brittle to pin; a stale list silently breaks presence. HMAC with a strong secret is the real auth boundary; replay + rate-limit are already enforced daemon-side.
- `compose.override.yaml` (not a fork of upstream compose): the deploy runs `docker compose up` with no `-f`, so an override in the deploy dir auto-merges. This is the sanctioned non-fork way to add the Caddy service + announce mounts without violating the "never edit upstream compose" rule.
- Gateway-side ingress only: the caller is separate cross-repo work; shipping the receiving end first is the clean separation.

---

## Dependencies / Assumptions

- `fro-bot/agent` v0.52.1 is live on the droplet (verified); announce is `readOptionalSecret` both-or-neither with a `POST /v1/announce` server on `GATEWAY_HTTP_PORT` (default 3000), no published port in upstream compose.
- Caddy port-publishing (`80:80`, `443:443`) is sufficient for public exposure — droplet provisioning opens no ufw rules today; cliproxy/umami expose publicly purely via Docker port publishing (verified).
- `gateway.fro.bot` DNS resolves to the droplet (the deploy/SSH host).
- The deploy's `git reset --hard` + `git clean -xfd` runs before secret/override materialization, so a post-clean override survives to `compose up` (verified ordering).

---

## Outstanding Questions

### Resolved (preflight, 2026-06-03)

Both load-bearing assumptions were verified empirically before planning:

- **Override auto-merge — CONFIRMED.** `docker compose --project-directory <dir> config` auto-merges `compose.override.yaml` from that directory: a test base+override showed the merged service env AND the override-only `caddy` service with `published: "443"`. The `--project-directory` flag does not disable override auto-loading. (Affects R2.)
- **Public DNS — CONFIRMED.** `gateway.fro.bot` resolves to the droplet's public IP `162.243.163.59` on both public resolvers (8.8.8.8 and 1.1.1.1). SSH-reachable and publicly-resolvable-to-public-IP are both true here. (Affects R1, R7.)
- **Inbound :80/:443 — CONFIRMED reachable once published, with a gotcha to encode in the plan.** The droplet runs ufw active, default-deny incoming, with only 22/2375/2376 allowed and `iptables INPUT policy DROP` — yet Docker-published ports are still publicly reachable because published-port traffic traverses `nat PREROUTING DNAT → FORWARD → DOCKER-USER → DOCKER-FORWARD`, **bypassing the INPUT chain ufw governs**. `DOCKER-USER` is empty (allow-all). So publishing `80:80`/`443:443` on the Caddy service works **despite** ufw, with no ufw rule change — matching the live cliproxy/umami precedent on identical DO droplets. **Plan implication:** do not add a ufw allow rule (unnecessary and misleading); the exposure comes from Docker publishing. If a future hardening pass adds a `DOCKER-USER` filter, it would gate this — note that as the real control point, not ufw INPUT. (Affects R1, R7.)

### Deferred to Planning

- [Affects R3][Technical] Exact override shape for wiring the announce inputs — whether to mirror upstream's commented `_FILE` env pointers + bind mounts verbatim in the override, vs supplying the values through the existing `.env` env-interpolation path. Resolve by reading the daemon's `readSecret`/`readOptionalSecret` precedence (env var vs `_FILE`) against what the override can cleanly provide.
- [Affects R1][Technical] Which internal hostname/port the Caddy `reverse_proxy` targets for the daemon's `:3000` (the daemon's compose service name on the shared network), and whether Caddy joins `gateway-net` (the external-capable network) so it can both serve public TLS and reach the daemon.
- [Affects R8, R9][Technical] Caddy data/config volume persistence across the upstream `git clean -xfd` — the override must define **named** volumes (not working-tree paths) so cert material survives every deploy; otherwise each deploy re-requests certs and risks Let's Encrypt rate limits. Pin exact volume names to avoid project-name collisions.
- [Affects R6][Technical] `GATEWAY_WEBHOOK_SECRET` rotation procedure — blast radius if it leaks is full Fro-Bot-user impersonation into the presence channel. Define whether the daemon supports a dual-accept window or requires a coordinated cutover, and the steps to invalidate the old secret. (Caller-side coordination lives in `fro-bot/.github`.)
