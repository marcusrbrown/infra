---
title: Major-version upstream upgrade playbook (probe-first, backup-anchored)
date: 2026-05-29
category: docs/solutions/best-practices
module: apps/cliproxy
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - Upgrading a pinned third-party container image across a major version
  - A management/API endpoint contract may have changed between versions
  - A reviewer (human or AI) raises a contract claim you can check against the pinned image
  - The live deploy carries persistent data (named volumes) that an image swap puts at risk
related_components:
  - tooling
tags:
  - cliproxy
  - upstream-upgrade
  - breaking-changes
  - docker-pin
  - oauth-volume
  - empirical-verification
  - major-version
  - rollback
---

# Major-version upstream upgrade playbook (probe-first, backup-anchored)

## Context

CLIProxyAPI on the `cliproxy.fro.bot` droplet — the proxy every Fro Bot and OpenCode
CI run routes through — needed to move from `v6.10.9` to `v7.1.31` (a major version with
a removed management endpoint, a new IP-ban behavior, and changed `/v1/models` output).

A major-version bump of a *live* dependency is deceptive: the code diff can be small while
the operational blast radius is real. The risk is trusting release notes or memory for the
new contract, and treating an irreversible image swap as routine. This playbook is the
method that made the upgrade boring: **probe the pinned image first, verify every breaking
change against real output, and anchor the cutover with a volume backup.** Shipped via
PR #331 (`@marcusrbrown/infra@0.9.1`) and cut over with zero data loss.

## Guidance

### 1. Probe the actual pinned image before writing any code

Spin up the **exact tag you intend to pin** and capture endpoint shapes empirically. Do not
infer them from release notes, changelogs, or memory — confirm them.

```bash
# macOS gotchas learned the hard way:
#  - bind-mounting a single FILE from /tmp silently creates an empty DIR at the
#    mount point (/tmp isn't in Docker's shared paths). Use `docker create` + `docker cp`.
#  - v7 reads config from /CLIProxyAPI/config.yaml (not /root/...).
#  - pin `port: 8317` in config.yaml so the bind is deterministic, and publish it
#    with -p so host curl can reach it (an unset port binds a RANDOM internal port).
PORT=8317
docker create --name probe -p "$PORT:$PORT" eceasy/cli-proxy-api:v7.1.31
docker cp ./config.yaml probe:/CLIProxyAPI/config.yaml   # config.yaml sets `port: 8317`
docker start probe
# poll the liveness endpoint instead of a brittle sleep (reinforces the /healthz lesson)
until curl -sf "http://localhost:$PORT/healthz" >/dev/null; do sleep 1; done
curl -s "http://localhost:$PORT/healthz"                       # liveness shape
curl -s "http://localhost:$PORT/v0/management/usage-queue?count=5" -H "x-management-key: <MANAGEMENT_KEY>"
curl -s "http://localhost:$PORT/v1/models" -H "Authorization: Bearer <BEARER_TOKEN>"
docker rm -f probe
```

This converted three v7 unknowns into verified facts: `/healthz` → `{"status":"ok"}`;
`/usage-queue` returns a **bare JSON array** (not wrapped); `/v1/models` lists **bare model
ids** (`claude-sonnet-4-6`, not `anthropic/claude-sonnet-4-6`) and may omit `owned_by`.

### 2. Trace each breaking change to a specific code edit

- **Removed `/v0/management/usage`** → migrate `cliproxy status` to `/v0/management/usage-queue`;
  compute `total = array.length`, and **warn-not-fail** on an unknown record shape.
- **New IP-ban** (~5 bad management-key attempts → ~30 min ban) → run a **single auth probe**
  before any parallel management calls, so a wrong key can't trip the ban.
- **Bare model ids + optional `owned_by`** → match `entry.id === bareId || entry.id === model`,
  and infer the provider from the id prefix when `owned_by` is absent/blank.
- **`/healthz`** → point the reachability probe at the documented liveness endpoint.

### 3. Verify reviewer contract claims against the pinned image, not prose

A reviewer flagged a "blocker": bare-`/` reachability would supposedly regress on v7. Probing
the pinned `v7.1.31` image showed bare `/` still returns `200` — the blocker was false. The
right move is *both*: disprove the claim with evidence, **and** adopt the better practice
(`/healthz`) on its own merits. Evidence ends the debate; merit drives the change.

### 4. Anchor the cutover with a volume backup, then smoke-test

The OAuth tokens live in a named volume (`cliproxy_cliproxy_auth`). Back it up **before** the
image swap — that backup is the rollback anchor — and store it outside the repo.

```bash
# rollback anchor — contains LIVE OAuth credentials, so treat the artifact as a secret:
# root-only staging on the droplet, integrity-checked, 0600 everywhere, remote copy removed after pull.
ssh root@host 'set -euo pipefail; umask 077
  docker volume inspect cliproxy_cliproxy_auth >/dev/null            # fail fast if the volume name is wrong
  d=$(mktemp -d); trap "rm -rf \"$d\"" EXIT                          # root-only (umask 077), auto-cleaned
  docker run --rm -v cliproxy_cliproxy_auth:/v:ro -v "$d":/b alpine \
    tar czf /b/auth.tgz -C /v .
  tar -tzf "$d/auth.tgz" >/dev/null                                 # integrity check before we trust it
  install -m600 "$d/auth.tgz" /root/auth.tgz                         # persistent 0600 staging for scp
  echo "remote backup OK ($(stat -c%s /root/auth.tgz) bytes)" >&2'  # diagnostics to stderr, never stdout
B=~/backups/cliproxy_auth_$(date +%Y%m%d-%H%M%S).tgz
scp root@host:/root/auth.tgz "$B" && chmod 600 "$B" && ssh root@host 'rm -f /root/auth.tgz'
tar -tzf "$B" >/dev/null && echo "local copy verified before cutover: $B"
```

Then cut over via the gated deploy and smoke-test against the live result — never trust the
green run alone: `/healthz`, a **real** `/v1/chat/completions` (proves tokens carried across),
dogfood the **new** `cliproxy status` code, and confirm a consumer (a Fro Bot run) still routes.

## Why This Matters

A major-version upgrade of a production dependency is where "it should be compatible" quietly
becomes an outage. Probing the pinned image turns guesswork into facts before a single line
changes, so the code edits are precise and the review defends real behavior. Backing up the
state volume first makes the one irreversible step (the image cutover) reversible. The result:
the v7 upgrade shipped, cut over, and verified live with zero data loss and zero consumer
disruption — 20 API keys and both OAuth tokens carried across untouched.

## When to Apply

- Bumping a pinned container image across a major version (especially API/management surfaces).
- Any time a deploy swaps an image while a named volume holds credentials or state.
- When a reviewer asserts a version-specific contract change — confirm it against the image.

## Examples

**Usage-stats migration (v6 `/usage` removed → v7 `/usage-queue` bare array):**

```ts
// before, on v6: GET /v0/management/usage → aggregate object (already 404 on our v6)
// after, on v7:  GET /v0/management/usage-queue?count=N → bare array of recent records
const recent = Array.isArray(body) ? body.length : 0   // total = array length
// warn-not-fail: an unknown shape degrades the status line, never throws
```

**`owned_by` tolerance (v7 may omit it on `/v1/models` entries):**

```ts
// prefer owned_by when present and non-blank; else infer provider from the id prefix
function entryMatchesProvider(entry: {id: string; owned_by?: string}, provider: string) {
  const owned = entry.owned_by?.trim()
  if (owned) return owned === provider
  return entry.id.startsWith(`${provider}/`) || PROVIDER_ID_PATTERNS[provider]?.test(entry.id)
}
```

**Disproving the reachability "blocker" empirically:**

```bash
# claim: bare / regresses on v7. reality, against the pinned image
# (reuse the probe container from step 1 — PORT=8317, published with -p):
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$PORT/"
# → 200. Blocker false. Switched the probe to /healthz anyway (documented liveness contract).
```

## Related

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — the original cliproxy operational precedent (first-deploy cascade).
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — "audit the upstream contract before acting," applied to a new app.
- `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md` — "verify the pinned upstream image/source, not memory."
- Issue #232 (Upstream Modernization Watch) — tracked the v6→v7 action item this upgrade closed.
- PR #331 — the v7 upgrade (released as `@marcusrbrown/infra@0.9.1`).
