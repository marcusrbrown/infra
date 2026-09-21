# Gateway Access

How to inspect, log into, and restart the gateway droplet. The CLI covers most needs; direct SSH
is for the gaps, chiefly restarting a single service. Every trap below cost real time to find, so
read the traps before improvising a command.

---

## Prerequisites

- `GATEWAY_HOST` in the repo-root `.env`.
- An SSH key in your agent that the droplet accepts. The CLI relies on `SSH_AUTH_SOCK` in local
  mode — it passes no `-i` flag (`apps/gateway/src/deploy.ts:1854-1859`).
- Commands below are run from the repo root so Bun loads `.env` automatically.

---

## Prefer the CLI

```sh
bunx @marcusrbrown/infra gateway status              # docker compose ps, service states
bunx @marcusrbrown/infra gateway logs gateway --tail 200
bunx @marcusrbrown/infra gateway deploy              # triggers the Deploy Gateway workflow
```

`gateway logs <service>` takes `gateway`, `caddy`, `mitmproxy`, or `workspace`.

**There is no `gateway restart` subcommand.** The full list is `status`, `deploy`, `logs`,
`backup`, `restore`. Restarting a single service requires SSH — see below.

`gateway deploy` runs the workflow in CI with the real credentials and stops at the `gateway`
environment approval gate. It recreates the container, so it also clears in-memory state.

---

## Direct SSH

```sh
GATEWAY_HOST=$(grep -m1 '^GATEWAY_HOST=' .env | cut -d= -f2-)
ssh -o BatchMode=yes -o ConnectTimeout=10 root@"$GATEWAY_HOST" \
  "cd /opt/gateway/deploy && docker compose ps"
```

Two details do all the work here, and both are easy to get wrong:

- **The remote user is `root`**, not your local username
  (`DEFAULT_REMOTE_USER` — `apps/gateway/src/deploy.ts:192`).
- **Compose lives in `/opt/gateway/deploy`**, not `/opt/gateway`
  (`DEPLOY_DIR` — `apps/gateway/src/deploy.ts:187`). `/opt/gateway` is the full repo checkout.

Layout on the droplet:

| Path | Contents |
| --- | --- |
| `/opt/gateway` | repo checkout, root-owned |
| `/opt/gateway/deploy` | `compose.yaml`, `.env` |
| `/opt/gateway/deploy/secrets` | mounted secret files |
| `/opt/gateway/.secrets-checksum` | secret drift detection |

---

## Restart a single service

```sh
ssh root@"$GATEWAY_HOST" "cd /opt/gateway/deploy && docker compose restart gateway"
bunx @marcusrbrown/infra gateway status
```

Restarting `gateway` drops everything it holds in memory — operator browser sessions and the OAuth
state store. That is sometimes the point: a saturated OAuth attempt cap clears instantly this way,
where otherwise it waits out a 10-minute TTL. It also means every operator must sign in again.

Do not restart `mitmproxy` casually, and **never restart in place to rotate the CA** — workspaces
lose trust in the egress proxy. Restore from backup instead (`AGENTS.md`).

---

## Traps

**Wrong remote user.** `ssh "$GATEWAY_HOST"` uses your local username and fails as
`Permission denied (publickey)` — or, with several keys in your agent, as
`Received disconnect … Too many authentication failures`, because the server cuts off before
reaching a usable key. The second message hides the first. Always specify `root@`.

**Stop after two failed auth attempts.** Repeated failures risk tripping fail2ban and locking
everyone out, which is worse than whatever you were debugging.

**Never `source` the repo-root `.env`.** It contains multiline SSH keys; `set -a; . ./.env` throws
parse errors and corrupts the environment. Extract single values with `grep`/`cut`, or let Bun load
it for you.

**`GATEWAY_SSH_KEY` from `.env` will not authenticate you interactively.** It is materialized to a
temp file and used with `-i` only in CI (`CI=true`). Locally the CLI uses your agent
(`apps/gateway/src/deploy.ts:2537`).

**Wrong compose directory.** Running compose from `/opt/gateway` gives
`no configuration file provided: not found`. Use `/opt/gateway/deploy`.

**Logs are sensitive.** `gateway logs` prints a warning for a reason — output can carry Discord
tokens, S3 credentials, and user data. Do not paste it into shared channels or issues. Extract the
fields you need (`"msg"`, `"errorCode"`) rather than quoting lines wholesale.

---

## Reading logs effectively

Log lines are JSON with a `msg` field. Counting message shapes is usually faster than reading
sequentially:

```sh
bunx @marcusrbrown/infra gateway logs gateway --tail 300 > /tmp/gw.log
grep -oE '"msg":"[^"]{0,80}"' /tmp/gw.log | sort | uniq -c | sort -rn | head -20
```

Audit events appear as `audit: <kind>` — `auth.start`, `auth.callback.success`,
`auth.callback.failure`, `push.subscribed`, `push.dispatch`, `push.disabled`.

Useful pairing: a `start` event with **neither** a matching success nor failure means the handler
never ran, so the cause is upstream of it. A `start` with a failure means it ran and rejected —
look inside it.

Delete the capture when you are done; it is sensitive.
