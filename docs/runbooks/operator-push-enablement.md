# Operator Push Enablement

Web Push notifications for the Fro Bot operator dashboard at `https://dashboard.fro.bot`. Currently default-off on both the gateway and dashboard sides. This runbook covers enabling it, verifying it actually took effect, rotation limits, and rollback. Enabling push is **config-only** — no code change, no image rebuild.

---

## The Five Values

Gateway GitHub Environment (`gateway`) — three **variables**:

- `GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY`
- `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT`
- `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION`

Gateway GitHub Environment (`gateway`) — one **secret**:

- `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY`

Dashboard GitHub Environment (`dashboard`) — one **variable**:

- `DASHBOARD_OPERATOR_PUSH_ENABLED`

**Never set `GATEWAY_OPERATOR_PUSH_ENABLED`.** There is no GitHub-stored derived flag by that name — the gateway deploy computes it from the quartet above and injects `GATEWAY_OPERATOR_PUSH_ENABLED: true` into the compose env itself.

---

## Quartet State Machine

The gateway deploy classifies the four `GATEWAY_OPERATOR_PUSH_VAPID_*` inputs before any SSH, spawn, secret materialization, or remote write:

- **All four present** → enabled.
- **All four absent** → disabled (the deploy also removes stale host secret files).
- **Anything partial** → the deploy throws `Operator push VAPID inputs must be set together (all-or-none)` and stops.

The dashboard side is **not** a quartet and does **not** fail closed: `DASHBOARD_OPERATOR_PUSH_ENABLED` only enables when it is the exact lowercase string `true`. `True`, `TRUE`, `1`, `yes`, whitespace-padded variants, and absence all silently disable — the dashboard deploy does not error on any of these. This asymmetry is the most likely way to end up half-enabled: gateway quartet valid, dashboard flag typo'd, and nothing tells you.

---

## Generating a VAPID Keypair

```bash
npx web-push generate-vapid-keys
```

If `fro-bot/agent` is checked out locally, the same tool is already a dependency there (`web-push@3.6.7`) and can be run from that checkout instead of `npx`. Either path produces output that satisfies every format gate below with no reformatting.

**Verify locally before seeding anything** — catching a bad value here is free; catching it in a deploy means a thrown error after you've already started the rollout:

```bash
node -e '
const pub = "<public-key-from-generate-vapid-keys>";
const priv = "<private-key-from-generate-vapid-keys>";
const pubBytes = Buffer.from(pub.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const privBytes = Buffer.from(priv.replaceAll("-", "+").replaceAll("_", "/"), "base64");
console.log("public bytes:", pubBytes.length, "expected 65");
console.log("public first byte:", pubBytes[0].toString(16), "expected 4");
console.log("private bytes:", privBytes.length, "expected 32");
'
```

Never paste real key material into a shell history, a log, a commit, or this runbook. Replace the placeholders above before running.

### Format gates (enforced by `validatePushVapidConfig` in `apps/gateway/src/deploy.ts`)

- **Public key**: strict unpadded base64url (`A-Z a-z 0-9 - _` only, no padding, no whitespace). Decodes to exactly 65 bytes. First byte must be `0x04` (uncompressed P-256 point) — a compressed point (`0x02`/`0x03` prefix) is rejected.
- **Private key**: strict unpadded base64url, decodes to exactly 32 bytes.
- **Subject**: non-blank, URL-parseable, scheme must be `mailto:` or `https:`. A `mailto:` subject must carry a non-empty address — `mailto:` with no address is rejected at this preflight (it used to pass and crash-loop the daemon after `compose up` had already replaced the container).
- **Key version**: positive integer string matching `^[1-9]\d*$`. Use `1` for a first enablement.

The validator round-trips the decoded bytes and compares — a padded value, a trailing newline, or a leading space fails validation rather than being silently normalized.

---

## Deploy Order

**Gateway first, then dashboard.** The gateway owns the push routes. Enabling the dashboard flag before the gateway quartet produces a dashboard calling routes that still 404.

### Step 1: Seed the gateway values

```bash
gh variable set GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY --env gateway --body '<public-key>'
gh variable set GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT --env gateway --body 'mailto:ops@example.invalid'
gh variable set GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION --env gateway --body '1'
```

Seed the private key from a file, never as a command argument. `--body` puts it in argv, which is visible in process listings; a `printf '<key>' | ...` pipe fixes argv but writes the key verbatim into your shell history instead.

```bash
umask 077
# paste the private key into the editor, save, exit
${EDITOR:-vi} vapid-private-key
gh secret set GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY --env gateway < vapid-private-key
rm -P vapid-private-key
```

`umask 077` makes the file `600` at creation rather than after the fact. `rm -P` overwrites before unlinking on macOS; use `shred -u` on Linux. If your shell records commands with a leading space excluded (`HISTCONTROL=ignorespace`), that is a convenience, not a substitute for keeping the value out of the command line entirely.

### Step 2: Deploy the gateway

```bash
bunx @marcusrbrown/infra gateway deploy
```

Approve the environment gate.

### Step 3: Verify the gateway side (mandatory — see [Critical Operational Caveats](#critical-operational-caveats))

The authenticated route probe is the primary check, because it is a positive signal rather than the absence of a failure:

```
GET /operator/push/vapid-key     → 200 {"publicKey":"<unpadded-base64url>","keyVersion":"1"}
GET /operator/push/subscriptions → 200
```

A 200 here proves the object-store CAS self-test passed. The routes mount only when the daemon threads through a push store and VAPID key info, and it only does that after the self-test succeeds — so the routes cannot exist on a process where push silently failed.

Must be authenticated. Unauthenticated requests return the same 404-style denial whether push is on or off, so a logged-out 404 proves nothing either way.

If the routes still 404 while authenticated, read the startup logs:

```bash
bunx @marcusrbrown/infra gateway logs gateway --tail 200
```

The healthy path logs **nothing** — there is no success marker to look for. A failure emits an audit event whose message is `audit: push.disabled`, carrying a structured `reason` field:

- `reason: "config_absent"` — the quartet was not present at container start. Check the deploy env, not just GitHub.
- `reason: "self_test_failed"` — the quartet validated, but the object-store CAS self-test failed. This case also logs `operator push disabled — object store failed CAS self-test`.

Grep for `audit: push.disabled` and read `reason`; the reason is a field, not part of the message string.

### Step 4: Seed and deploy the dashboard

```bash
gh variable set DASHBOARD_OPERATOR_PUSH_ENABLED --env dashboard --body 'true'
bunx @marcusrbrown/infra dashboard deploy
```

Approve the environment gate.

### Step 5: Verify end-to-end in the browser

Requirements: HTTPS (satisfied), a registered service worker (already shipped — `https://dashboard.fro.bot/sw.js` is a Workbox service worker with `push`, `notificationclick`, and `pushsubscriptionchange` handlers), granted notification permission, and — on iOS/iPadOS specifically — the dashboard installed as a standalone PWA (Web Push does not work in Safari's regular browser tab on iOS).

---

## Critical Operational Caveats

**A green deploy does not prove push is live.** If the object-store CAS self-test fails at gateway startup, push is disabled for that process and the gateway continues serving every other route normally — nothing fails, nothing restarts, no alert fires. Verifying with the authenticated `/operator/push/vapid-key` probe after every push-affecting deploy is mandatory, not a nice-to-have. Do not substitute a log check for it: the healthy path is silent, so "no error in the logs" is consistent with both a working deploy and one you have not looked at closely enough.

**Subscriptions are durable, not in-memory.** They live in the object store at `operator-push/subscriptions/by-endpoint/{sha256(endpoint)}.json`, with privacy tombstones at `operator-push/tombstones/{sha256(endpoint)}.json`. They survive container recreation. This is the opposite of operator browser sessions, which are in-memory and die on any restart.

**Logout is global.** Logging out of one session deactivates every push subscription for that GitHub operator, across every browser and device they've enabled push on. This is intentional but easy to be surprised by.

**Rotation is half-built.** Current + previous key dispatch works today: an optional previous-key quartet exists (all-four-or-none, and the previous key version must differ from the current one), so a single rotation step is supported. The full active/grace/revoked subscription lifecycle, bulk revocation, and dedupe-window tuning are **not** implemented. Setting `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION=1` for a first enablement is fine. Do not treat this section as a rotation procedure — none beyond the single current+previous swap is substantiated; write one when the lifecycle work lands.

---

## Rollback

**Gateway:** unset all four `GATEWAY_OPERATOR_PUSH_VAPID_*` values (three variables, one secret) from the `gateway` GitHub Environment and redeploy. `getPushState` returns `disabled`, and the deploy removes the stale host secret files.

**Dashboard:** set `DASHBOARD_OPERATOR_PUSH_ENABLED` to anything other than the exact string `true` (or remove it) and redeploy the dashboard.

**Durable subscription records are not removed by disabling either side.** They persist in the object store until explicitly deleted. Disabling push stops delivery; it does not clean up storage.

---

## Secret File Mapping

The private key is materialized as a file on the gateway droplet, same pattern as the other gateway secrets:

| Env var | Host file | Container path |
| --- | --- | --- |
| `GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY` | `gateway-operator-push-vapid-public-key` | `/run/secrets/gateway_operator_push_vapid_public_key` |
| `GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY` | `gateway-operator-push-vapid-private-key` | `/run/secrets/gateway_operator_push_vapid_private_key` |
| `GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT` | `gateway-operator-push-vapid-subject` | `/run/secrets/gateway_operator_push_vapid_subject` |
| `GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION` | `gateway-operator-push-vapid-key-version` | `/run/secrets/gateway_operator_push_vapid_key_version` |

Source of truth: `OPERATOR_PUSH_VAPID_SECRET_SPECS` in `apps/gateway/src/deploy.ts`. The daemon reads each via the corresponding `_FILE` env var.

**Never print, echo, log, or commit the private key.** Seed it from a file, as in [Step 1](#step-1-seed-the-gateway-values) — never as a `--body` argument, a here-string, or an inline `printf` pipe. The first two expose it in argv; all three write it into shell history.

---

## Related

- [`apps/gateway/AGENTS.md`](../../apps/gateway/AGENTS.md) — deploy flow, secret contract, anti-patterns
- [`apps/dashboard/AGENTS.md`](../../apps/dashboard/AGENTS.md) — deploy flow, operator UI
- [`docs/runbooks/gateway-operator-auth-lifecycle.md`](gateway-operator-auth-lifecycle.md) — sibling secret-seeding runbook for the operator auth/config quartet
