---
title: 'Umami first deploy: 7-wave cascade caught mostly pre-merge'
problem_type: workflow_issue
component: development_workflow
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
date: 2026-05-29
tags: [umami, digitalocean, docker-compose, caddy, postgres, ssh, github-environment, auth-rotation]
module: apps/umami
related_issues:
  - https://github.com/marcusrbrown/infra/issues/315
related_docs:
  - docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md
  - docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md
---

# Umami First Deploy: 7-Wave Cascade

## Problem

The first end-to-end deploy of `apps/umami` (self-hosted privacy-respecting analytics) to `metrics.fro.bot` surfaced the same class of latent deploy-contract failures as the [cliproxy](./cliproxy-first-deploy-cascade-2026-04-06.md) (4-wave) and [gateway](./gateway-first-deploy-cascade-2026-05-20.md) (5-wave) cascades before it — a new public-HTTPS app, a persistent Postgres volume, default admin credentials on first boot, and a privacy posture that had to be enforced at the deploy layer.

The distinction this time: **five of the seven waves were caught pre-merge by the review pipeline** (plan `document-review`, `ce:review mode:autofix`, and Fro Bot's PR review), not in live production deploy attempts. Only the ungated-environment and SSH-provisioning waves were post-merge operational surprises. The two precedent cascades trained the review gates to look for exactly these assumptions — knowledge compounding in practice. Shipped in [PR #321](https://github.com/marcusrbrown/infra/pull/321) (+ host-key [PR #323](https://github.com/marcusrbrown/infra/pull/323)), released as [`@marcusrbrown/infra@0.9.0`](https://www.npmjs.com/package/@marcusrbrown/infra/v/0.9.0).

## Symptoms

Each wave was a distinct assumption failing at a different layer:

1. **Wave 1 — Image tag red herring** (implementation): every guessed versioned Postgres tag (`postgresql-v3.1.0`, 6 other forms) returned `manifest unknown`. Only `postgresql-latest` resolved — which the "never pin `latest`" rule forbids as a version substitute.
2. **Wave 2 — Admin-rotation reachability** (caught by `ce:review` autofix): rotation curled `http://localhost:3000` on the droplet **host** shell, but the compose stack never publishes `:3000` to the host — so the curl always connection-refused, producing "no token → already rotated → skip." Rotation could **never** have run.
3. **Wave 3 — v3.1.0 password endpoint** (caught by Fro Bot review): the rotation targeted `POST /api/users/me/password` with `{password}` — a route that **does not exist** in Umami v3.1.0. With fail-closed rotation (Wave 5), every first deploy would have aborted.
4. **Wave 4 — Auto-created ungated environment** (post-merge): merging PR #321 made GitHub auto-create the `umami` environment with **zero protection rules**, and the merge push fired the deploy with no approval gate (it failed benignly at "Validate required secrets", pre-SSH).
5. **Wave 5 — Public default-cred window** (caught by `ce:review` autofix): default `admin`/`umami` was reachable on the public endpoint because Caddy (`:443`) came up before admin rotation.
6. **Wave 6 — DB-password ↔ volume coupling** (caught in `document-review` + `ce:review`): regenerating `POSTGRES_PASSWORD` on any later deploy would brick auth against the existing Postgres volume (password is set only at volume init).
7. **Wave 7 — SSH provisioning gotchas** (live provisioning): `provision-droplet.ts` `waitForSsh` timed out (the droplet *was* created); manual SSH hit `Too many authentication failures`.

## What Didn't Work

- Trusting Umami's docs prefix `postgresql-*` as a variant selector — it's a red herring; the image is PostgreSQL-only and the real numbered tag is bare `3.1.0` (Wave 1).
- Assuming `localhost:3000` was reachable from the droplet host because the app "runs on 3000" — it runs on 3000 *inside the compose network*, never published to the host (Wave 2).
- Encoding an admin-rotation endpoint from memory instead of the pinned image's source (Wave 3).
- Assuming a referenced GitHub Environment inherits protection from sibling envs — auto-created envs have none (Wave 4).
- A first rotation implementation that reported success on `curl` exit 0 even when the HTTP status was 500, and treated a transient login *connection* failure as "already rotated" — both fail *open*, leaving default creds live (Waves 2+5).
- `UID=$(gh api …)` in the env-protection fix — `UID` is a readonly bash builtin (=501 on macOS), so the assignment silently no-op'd and sent the wrong reviewer id (Wave 4).

## Solution

Waves 1, 2, 5, 6 were fixed before push (during implementation + `ce:review mode:autofix`); Wave 3 during Fro Bot review-response; Waves 4 and 7 during the post-merge operator-prerequisites pass.

### Wave 1 — Resolve the real numbered image tag

`umamisoftware/umami:3.1.0` is the immutable numbered tag (`postgresql-latest` is a rolling alias to the same PostgreSQL-only image). Pinned digest + numbered tag in `apps/umami/docker-compose.yaml`, Renovate-tracked like `cli-proxy-api`/`caddy`:

```yaml
image: umamisoftware/umami:3.1.0@sha256:81119aa498f910fe1bf590c0974dfd00afd3f3563dd55528bb3bd002f06f3dfb
# ...
image: postgres:15-alpine@sha256:df7bca0066e6f60cc3dd32faa70caddec20e2c22b58932f79498e5704b23854a
```

When the tag list was ambiguous, a librarian dispatch pulled the authoritative published tags rather than guessing further.

### Wave 2 — Rotate over the internal compose network, not the host

`docker-compose.yaml` publishes only Caddy `80/443`; Umami `:3000` and Postgres `5432` are internal. The rotation runs **inside** the umami container (which ships `curl` — it's its own healthcheck), reaching the service where it actually listens:

```ts
// BAD — host shell; :3000 is never published, always connection-refused
sshCommand(host, `curl -s http://localhost:3000/api/auth/login ...`)

// GOOD — internal compose network
sshCommand(host, `cd /opt/umami && docker compose exec -T umami curl -s --fail-with-body http://localhost:3000/api/auth/login ...`)
```

### Wave 3 — Pin to the v3.1.0 auth contract

Verified against `umami-software/umami@v3.1.0` source (Fro Bot's review blocker, confirmed by librarian):

```ts
// apps/umami/src/deploy.ts
const UMAMI_PASSWORD_PATH = '/api/me/password' // not /api/users/me/password
// login:    POST /api/auth/login    {username, password} -> {token}
// rotate:   POST /api/me/password    {currentPassword: 'umami', newPassword} (min 8)
```

### Wave 4 — Add environment protection immediately

GitHub auto-creates a referenced environment with no rules. Matched the cliproxy/gateway/keeweb pattern — reviewer + main-only branch policy — via the API (note the `UID`-builtin trap):

```bash
# REVIEWER_ID literal (not $UID — that's a readonly bash builtin = 501)
gh api -X PUT repos/marcusrbrown/infra/environments/umami \
  -F 'reviewers[][type]=User' -F 'reviewers[][id]=831617' \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
# + a custom branch policy naming `main`
```

The auto-triggered ungated run failed benignly (secret-validation step, pre-SSH) — but the *next* push would have deployed ungated. Fixing the env closed that.

### Wave 5 — Fail-closed rotation + Caddy staged after rotation

The deploy brings up `db` + `umami` internal-only, rotates admin over the internal network, **then** starts `caddy` — so there's never a public window with default creds. Rotation fails closed: a connection failure (curl exit 7/255) aborts; a clean auth rejection (exit 22) is the only "skip"; success requires the new password logging in **and** the default being rejected. The bearer token is passed via a stdin curl-config file, never argv (not `ps`-visible).

### Wave 6 — DB-password fingerprint guard

`POSTGRES_PASSWORD` is fixed at volume init; changing it later bricks auth. `deploy.ts` writes a fingerprint sentinel and refuses a bricking rotation structurally — and the sentinel read checks the exit code so an *unreadable* sentinel fails closed instead of masquerading as first-deploy (empty):

```ts
const SENTINEL = '/opt/umami/.db-password-fingerprint'
// read fails closed: distinguish "no such file" (first deploy) from a transport/read error
// DATABASE_URL password is encodeURIComponent-encoded (@ : / ? # % aren't caught by the shell-metachar validator)
```

### Wave 7 — Explicit SSH identity

`provision-droplet.ts` `waitForSsh` uses ssh-agent/BatchMode, but the key lives in a file — so first contact times out even though the droplet is up (the gateway precedent). Manual ops must pin the identity or SSH sprays every agent key and trips the server's `MaxAuthTries`:

```bash
ssh -i ~/.ssh/fro-bot-umami -o IdentitiesOnly=yes root@metrics.fro.bot
```

## Why This Works

The waves share one root-cause class — **deploy-contract assumptions never exercised end-to-end until first deploy** — identical to the cliproxy and gateway cascades. What changed is *where they were caught*:

- Waves 1, 2, 5, 6 never reached production: implementation diligence + `ce:review mode:autofix` (11 reviewers) traced the rotation control flow and the image pin to ground truth. The reachability bug (Wave 2) in particular was invisible to all 11 reviewers' first pass — it surfaced only when verifying that the compose file actually published `:3000`, which it didn't.
- Wave 3 was Fro Bot tracing the rotation endpoint against the pinned image's source — the exact "verify upstream contract against the pinned version" lesson from the gateway cascade.
- Waves 4 and 7 are environmental, not code: they only exist once real infra is created, so no amount of pre-merge review surfaces them. They're operator-prerequisite checks, not diff review.

Each fix is structural at its layer: rotate on the network where the service listens (Wave 2), pin to the real contract (Waves 1, 3), gate the environment (Wave 4), order service startup so defaults are never public (Wave 5), refuse destructive password drift (Wave 6), pin the SSH identity (Wave 7). No retries, no workarounds.

## Prevention

### Wave-specific guardrails

- **Wave 1 / image tags**: resolve a third-party image's real numbered tag from the registry tag list (delegate to librarian when docs are ambiguous); never treat a docs tag *prefix* as a variant selector. Pin `tag@sha256:` + Renovate.
- **Wave 2 / rotation reachability**: run any admin/setup HTTP call over the internal compose network (`docker compose exec -T <svc> curl …`), never the droplet host — internal-only ports are the default, publishing is the exception.
- **Wave 3 / API contract**: verify auth/admin endpoints against the *pinned image version's* source, not memory or current docs. Re-check on major bumps.
- **Wave 4 / ungated env**: the moment a workflow references a new `environment:`, the merge auto-creates it ungated. Add reviewer + branch policy in the same operator pass, before any secrets are set. Watch for `UID` and other readonly builtins when scripting the API call.
- **Wave 5 / public default creds**: stage the reverse proxy *after* credential rotation; make rotation fail closed (verify the new credential works AND the default is rejected) so a silent failure can't leave defaults live.
- **Wave 6 / volume-coupled secrets**: treat a DB password as init-only state, not config. Fingerprint it on the droplet and refuse a bricking change; fail closed on sentinel read errors.
- **Wave 7 / SSH identity**: use `-i <key> -o IdentitiesOnly=yes` for file-backed keys everywhere; expect provision `waitForSsh` to time out when the key isn't in the agent (the droplet is still created — verify by IP before re-running).

### Cross-wave guardrails

- **First deploy of any new app is a deploy-contract test.** The pattern is now consistent across three apps: cliproxy (4 waves), gateway (5), umami (7). Budget for it.
- **The review pipeline compounds.** Each cascade doc trains the next review pass. Umami caught 5/7 waves pre-merge specifically because `document-review`, `ce:review`, and Fro Bot were primed by the cliproxy/gateway precedents to interrogate image pins, rotation control flow, upstream API contracts, and fail-open auth. Keep writing these docs — they're the training signal.
- **Some waves are unreachable by diff review.** Ungated environments (Wave 4) and SSH-agent-vs-keyfile provisioning (Wave 7) only exist once real infra is created. Keep an operator-prerequisites checklist distinct from code review.
- **Fail closed on anything touching credentials or persistent state.** Rotation (Wave 5) and the DB fingerprint guard (Wave 6) both encode "refuse and abort" over "try and hope."

## Related Issues

- [cliproxy-first-deploy-cascade-2026-04-06.md](./cliproxy-first-deploy-cascade-2026-04-06.md) — 4-wave precedent (lockfile → env var → host keys → auth-dir)
- [gateway-first-deploy-cascade-2026-05-20.md](./gateway-first-deploy-cascade-2026-05-20.md) — 5-wave precedent (contract drift → secrets → PEM newline → UFW rate limit → NDJSON)
- Origin: [#315](https://github.com/marcusrbrown/infra/issues/315) — self-hosted privacy-respecting analytics requirement
- PRs: [#321](https://github.com/marcusrbrown/infra/pull/321) (app + waves 1-3, 5, 6), [#323](https://github.com/marcusrbrown/infra/pull/323) (host-key pin)
- Release: [`@marcusrbrown/infra@0.9.0`](https://www.npmjs.com/package/@marcusrbrown/infra/v/0.9.0)
