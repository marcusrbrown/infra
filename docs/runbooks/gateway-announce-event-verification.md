# Gateway Announce Event Verification

The Fro Bot gateway exposes a path-scoped, HMAC-gated `POST /v1/announce` ingress on `gateway.fro.bot`. External control planes (e.g. `fro-bot/.github`) sign payloads with the shared `GATEWAY_WEBHOOK_SECRET` and POST presence events — such as the `daily_digest` overview — which the daemon validates, renders, and posts to the configured Discord presence channel. This runbook covers verifying a presence-event go-live end-to-end from the infra side: confirming a real signed event is accepted and delivered, and distinguishing it from unsigned test probes.

This is a read-only verification procedure. Enabling or triggering the event is a control-plane concern owned by the calling repository; the gateway side only receives, validates, and posts.

---

## Prerequisites

- Gateway daemon pinned to a version that supports the event variant (e.g. `daily_digest` requires `fro-bot/agent` ≥ v0.57.0 — check `apps/gateway/upstream.json`).
- The optional announce ingress is enabled: both `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID` are set in the `gateway` GitHub environment (both-or-neither pair). When set, the deploy generates the Caddy override that path-scopes `/v1/announce`.
- SSH access via `GATEWAY_SSH_KEY` from the repo-root `.env` (materialize to a temp `0600` key; the live droplet uses the repo-pinned `.github/known_hosts`).

---

## Baseline (before the go-live fires)

Confirm the gateway is ready and the ingress is live:

```sh
# services healthy + daemon version
ssh root@gateway.fro.bot 'cd /opt/gateway/deploy && docker compose ps --format "{{.Name}} {{.Status}}"'
ssh root@gateway.fro.bot 'cat /opt/gateway/.upstream-ref'   # expect the event-supporting version

# unsigned probe MUST be rejected (proves the HMAC gate is active)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://gateway.fro.bot/v1/announce -d '{}'
# expect: 400  (bad_request — no signature)
```

A `400` here is the **correct** baseline: the endpoint is reachable and the HMAC gate rejects unsigned bodies. A `404` instead means the announce ingress is not enabled (the Caddy override is absent because one of the two announce env vars is unset).

---

## Live monitoring

Stream the gateway and caddy logs and watch for the event. Run as a bounded background tail and register a pattern watch so the real event surfaces in real time:

```sh
# bounded stream (re-arm if the window lapses before the trigger)
timeout 1200 ssh root@gateway.fro.bot \
  'cd /opt/gateway/deploy && docker compose logs -f --since 1s gateway caddy'
# watch pattern: announce|digest|presence|posted|embed
```

When the control plane fires the signed POST, the daemon logs a single structured line:

```json
{"level":"info","event_type":"daily_digest","fired_at":"<ISO8601>","discordStatus":"ok","msg":"announce accepted"}
```

### Success criteria

| Field | Success value | Meaning |
|---|---|---|
| `msg` | `announce accepted` | HMAC validated (not `announce rejected`) |
| `event_type` | the expected variant (e.g. `daily_digest`) | the daemon recognized and rendered the variant |
| `discordStatus` | `ok` | the embed posted to the presence channel |

Then confirm no follow-on failure after the accept:

```sh
ssh root@gateway.fro.bot 'cd /opt/gateway/deploy && docker compose logs --since 3m gateway | grep -iE "error|fail|reject|panic"'
# expect: no output
```

---

## Attribution: real event vs test probe

The same `/v1/announce` path receives both your baseline probe and the real signed event, so attribute each log line precisely before declaring success or failure. Do not assume a lone rejection is the go-live — it is usually your own probe.

| Signal | Unsigned test probe | Real signed event |
|---|---|---|
| `msg` | `announce rejected` | `announce accepted` |
| `reason` | `bad_request` | (absent) |
| `discordStatus` | (absent) | `ok` |
| timestamp | matches when you ran `curl` | matches the control-plane trigger |

Pull timestamps with `docker compose logs -t` and match the announce line's time against your own probe time. A `bad_request` at the minute you curled is your probe; an `announce accepted` at the control-plane trigger time is the real event.

---

## Failure modes

| Symptom | Likely cause | Where to fix |
|---|---|---|
| `announce rejected` / `reason: bad_request` on the real event | signature mismatch — control-plane signing secret ≠ gateway `GATEWAY_WEBHOOK_SECRET` | re-seed both sides from one source of truth; the secret is write-only, so rotate both |
| No log line at all after the trigger | POST never reached the gateway — wrong URL, control-plane HTTP error, or the event flag not enabled | diagnose the control-plane repo (workflow ran? correct `gateway.fro.bot/v1/announce`?) |
| `404` on the unsigned baseline probe | announce ingress not enabled (Caddy override absent) | set both `GATEWAY_WEBHOOK_SECRET` and `GATEWAY_PRESENCE_CHANNEL_ID`, redeploy |
| `announce accepted` but `discordStatus` not `ok` | render or Discord delivery failed (bad channel id, missing perms, template error) | check channel id + bot perms; template issues are upstream `fro-bot/agent` |
| Event accepted but the embed looks wrong in Discord | render template field issue (logs can't show visual layout) | verify visually in the channel; template fixes are upstream `fro-bot/agent` |

---

## Related

- [`apps/gateway/AGENTS.md`](../../apps/gateway/AGENTS.md) — gateway deploy flow, secret contract, announce ingress wiring
- [`docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md`](../solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md) — the Caddy directive-ordering trap that can self-404 `/v1/announce`
- [`docs/runbooks/discord-token-lifecycle.md`](discord-token-lifecycle.md) — Discord credential rotation affecting the gateway
