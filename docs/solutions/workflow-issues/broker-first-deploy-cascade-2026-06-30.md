---
title: 'Broker first deploy: 6-hit cascade, all from prior solution docs'
problem_type: workflow_issue
component: development_workflow
root_cause: incomplete_setup
resolution_type: environment_setup
severity: high
date: 2026-06-30
tags: [broker, digitalocean, docker-compose, caddy, ssh, ssh-keyscan, ufw, dns, github-environment, bun-build]
module: apps/broker
related_issues:
  - https://github.com/marcusrbrown/infra/pull/733
  - https://github.com/marcusrbrown/infra/pull/735
  - https://github.com/fro-bot/agent/issues/1060
related_docs:
  - docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md
  - docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md
  - docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md
  - docs/solutions/workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md
  - docs/solutions/integration-issues/ssh-agent-too-many-authentication-failures-2026-06-13.md
---

# Broker First Deploy: 6-Hit Cascade

## Problem

The first bring-up of `apps/broker` (the OIDC credential broker) to `broker.fro.bot` — a new public-HTTPS DigitalOcean droplet app — surfaced six deploy-path failures. Unlike the earlier cascades where each wave was a *novel* discovery, **every hit here already had a solution doc**: the failures were re-encounters, and each was resolved by applying the documented fix rather than re-diagnosing. The lesson this time is about the operator, not the code: the recovery was fast only after switching from ad-hoc retry to reading `docs/solutions/`.

One hit was a genuine ordering bug specific to the bundle-deploy model (`dist/main.js` auto-created as a directory). The other five were the known SSH/DNS/environment gauntlet every new droplet app runs.

The broker app shipped in [PR #733](https://github.com/marcusrbrown/infra/pull/733); the host-key pin in [PR #735](https://github.com/marcusrbrown/infra/pull/735). The consuming-side integration is tracked in [fro-bot/agent#1060](https://github.com/fro-bot/agent/issues/1060).

## Symptoms

Each hit blocked a different phase of provision/deploy:

1. **Deploy-on-merge failed with `Missing required secret(s): BROKER_SSH_KEY BROKER_HOST`.** Merging the app PR fired `deploy-broker` (paths-filter matched `apps/broker/**`) before any infra existed. Expected consequence of merging before bring-up — not a code defect. Side effect: the referenced `environment: broker` auto-created **ungated** (`protection_rules: []`).

2. **`provision:broker` aborted at `pinHostKeys`: `getaddrinfo broker.fro.bot: nodename nor servname provided`.** DNS for the new FQDN did not exist yet; the host-key pin resolves the domain, so DNS must precede it.

3. **After the A record was added, provision *still* failed `getaddrinfo ENOTFOUND` while `dig` succeeded.** macOS `mDNSResponder` had negatively cached the earlier NXDOMAIN for the SOA negative-TTL window. `dig` queries the NS directly and bypassed the cache; `ssh-keyscan` uses `getaddrinfo` and saw the stale negative.

4. **`ssh-keyscan -H <ip>` returned empty / exit 141 (SIGPIPE) on the second of two back-to-back scans.** UFW's default `limit ssh` (6 new connections / 30s / source) throttled the burst. Repeated provision retries kept re-saturating the window, so naive retry made it worse.

5. **`bun run deploy:broker` failed in three successive ways** — `Host key verification failed` (local `~/.ssh/known_hosts` lacked the domain), then `Too many authentication failures` (crowded ssh-agent exceeded `MaxAuthTries`), then `unix_listener: path "…" too long for Unix domain socket` (ControlPath under macOS `$TMPDIR` exceeded the ~104-char socket limit).

6. **After provision, `https://broker.fro.bot/healthz` returned 502 and the broker container crash-looped.** `docker compose ps` showed `/opt/broker/dist/main.js` as a **directory**: provisioning ships `docker-compose.yaml` + `Caddyfile` but **not** the bundle (that is the deploy step's job), so `compose up` ran before `dist/main.js` existed and Docker auto-created the bind-mount source as an empty directory. `bun main.js` on a directory crash-loops.

## What Didn't Work

- **Retry-with-backoff on the `ssh-keyscan` failures.** This is explicitly rejected in [`gateway-first-deploy-cascade`](./gateway-first-deploy-cascade-2026-05-20.md) Wave 4: each retry needs ≥30s to clear the rate-limit window, and repeated attempts re-saturate it. Several sleep-and-retry rounds were burned before switching to the documented fix. **This was the operator error of the session.**
- **Assuming the CodeQL failure on the app PR was a default-vs-advanced setup collision.** It was 2 real `js/incomplete-url-substring-sanitization` alerts (`url.includes('broker.example.com')` in a fetch mock). Fixed by matching hostname exactly (`new URL(url).hostname === …`), not suppressing.
- **Provisioning to "just deploy" the stack.** Provision does not ship the bundle, so the stack it starts can never serve. The stack only becomes healthy after a real `deploy:broker`.

## Solution

Resolve each hit with its documented fix, in order:

1. **Pre-create the `broker` GitHub Environment gated before merge** ([umami cascade](./umami-first-deploy-cascade-2026-05-29.md) Wave: ungated auto-create). Recovery when already merged: `gh api -X PUT repos/<owner>/<repo>/environments/broker --input -` with a typed JSON body (`reviewers`, `deployment_branch_policy` — `-f` string fields 422 here), then add a `main` deployment-branch-policy. Mirror an existing gated env (`cliproxy`).

2. **Add the `broker.fro.bot` A record → droplet IP** in the DNS provider (`fro.bot` is served by the Mail-in-a-Box box `ns1/ns2.box.heatvision.co`, via MiaB admin → Custom DNS) before resuming provision.

3. **Flush the macOS negative DNS cache** after adding the record:
   ```bash
   sudo dscacheutil -flushcache
   sudo killall -HUP mDNSResponder
   ```
   Confirm at the `getaddrinfo` level (not just `dig`): `bun -e 'import {lookup} from "node:dns/promises"; lookup("broker.fro.bot").then(console.log)'`.

4. **Manually pin the host keys** so `pinHostKeys` sees its marker and skips both keyscans (removing them from the connection burst) — the same marker-skip idempotency the script relies on:
   ```bash
   # spaced ≥15s apart to stay under UFW limit ssh (6/30s)
   ssh-keyscan broker.fro.bot > /tmp/domain-keys      # unhashed domain entry
   ssh-keyscan -H <ip>        > /tmp/ip-keys          # hashed IP entry
   # append under the exact marker pinHostKeys uses:
   printf '\n# broker droplet (<ip> / broker.fro.bot)\n%s\n%s\n' \
     "$(cat /tmp/domain-keys)" "$(cat /tmp/ip-keys)" >> .github/known_hosts
   cp .github/known_hosts packages/cli/src/resources/known_hosts   # byte-identical drift-guard
   ```
   Then re-run `provision:broker --force` — it logs `Host keys already pinned` and skips the scans.

5. **Run the local deploy the way CI does** ([ssh-agent MaxAuthTries doc](../integration-issues/ssh-agent-too-many-authentication-failures-2026-06-13.md)): a single-key ssh-agent plus a short `TMPDIR`:
   ```bash
   eval "$(ssh-agent -s)"; ssh-add ~/.ssh/fro-bot-broker    # only the broker key
   TMPDIR=/tmp bun run deploy:broker                        # short ControlPath socket
   ```
   Also add the pinned domain keys to `~/.ssh/known_hosts` locally (CI does `cp .github/known_hosts ~/.ssh/known_hosts`).

6. **Remove the auto-created directory before the real deploy**, then deploy (which builds + ships the bundle):
   ```bash
   ssh … 'cd /opt/broker && docker compose down && rm -rf dist'
   TMPDIR=/tmp bun run deploy:broker    # bun build → scp dist/main.js → compose up
   ```

## Why This Works

- **Bundle vs bind-mount ordering:** the broker is the only Docker app that ships a `bun build` bundle instead of a pre-built image. Provisioning (which predates the bundle) must not `compose up` a service whose bind-mount source doesn't exist yet, or Docker materializes the path as a directory. The deploy step owns bundle creation and upload, so the stack is only ever brought up healthy by `deploy:broker`, not by provision.
- **UFW + keyscan:** `pinHostKeys` makes exactly 2 keyscan connections; on a fresh droplet with `limit ssh`, those plus `waitForSsh` polling can cross 6/30s. Pre-pinning removes the 2 scans from the burst. The provision/deploy SSH paths otherwise pool through one ControlMaster socket, staying under the limit.
- **The macOS-specific hits** (negative DNS cache, single-key agent, `TMPDIR` socket length) do not appear in CI because GitHub runners start with a clean resolver, `webfactory/ssh-agent` loads only the one key, and `/tmp` is short. They are operator-local and must be handled when deploying from a workstation.

## Prevention

- **Read `docs/solutions/` first when a new-app deploy fails.** Every hit here was already documented. The cascade docs are a checklist, not just a history — the fast path is applying the known fix, not re-diagnosing. Naive retry against UFW rate-limiting is the specific anti-pattern to avoid.
- **New droplet-app bring-up order (canonical):** (1) gate the GitHub Environment before merge; (2) generate + upload the SSH keypair, seed `.env`; (3) add DNS A record; (4) `provision:<app>`; (5) commit the pinned `known_hosts` (both copies); (6) `deploy:<app>`.
- **For bundle-deploy apps specifically:** never treat `provision` as sufficient to serve — it ships config only. Always follow with a real deploy that builds and uploads the bundle. Consider having provision create an empty-file placeholder (`: > dist/main.js`) or skip `compose up` until the bundle exists, so Docker never auto-creates the directory.
- **From a workstation:** deploy under a single-key ssh-agent with `TMPDIR=/tmp`; keep `~/.ssh/known_hosts` in sync with the pinned entries.

## Related Issues

- [`cliproxy-first-deploy-cascade`](./cliproxy-first-deploy-cascade-2026-04-06.md) — host-key domain-vs-IP hashing (the `ssh-keyscan -H` domain trap).
- [`gateway-first-deploy-cascade`](./gateway-first-deploy-cascade-2026-05-20.md) — UFW `limit ssh` + ControlMaster; the retry-with-backoff rejection.
- [`umami-first-deploy-cascade`](./umami-first-deploy-cascade-2026-05-29.md) — ungated environment auto-create.
- [`vpn-lightsail-first-provision-cascade`](./vpn-lightsail-first-provision-cascade-2026-06-10.md) — packaged `known_hosts` byte-identical drift-guard.
- [`ssh-agent-too-many-authentication-failures`](../integration-issues/ssh-agent-too-many-authentication-failures-2026-06-13.md) — single-key `-i` + `IdentitiesOnly` / `MaxAuthTries`.
