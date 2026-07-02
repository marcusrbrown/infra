---
title: 'Broker credential-lifecycle races: stale bind-mounted bundle + reconcile deleting in-flight keys on restart'
problem_type: integration_issue
component: tooling
root_cause: logic_error
resolution_type: code_fix
severity: high
date: 2026-07-02
tags: [broker, cliproxy, deploy, docker-compose, oidc, credential-lifecycle, reconcile, force-recreate, bind-mount]
module: apps/broker
related_issues:
  - https://github.com/marcusrbrown/infra/pull/739
  - https://github.com/marcusrbrown/infra/pull/740
  - https://github.com/marcusrbrown/infra/pull/744
  - https://github.com/fro-bot/agent/issues/1081
related_docs:
  - docs/solutions/integration-issues/gateway-bash-approval-default-allow-2026-06-28.md
  - docs/solutions/workflow-issues/broker-first-deploy-cascade-2026-06-30.md
  - docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md
---

# Broker Credential-Lifecycle Races

## Problem

After the broker's trust allowlist was set to the real `fro-bot/agent` values ([#739](https://github.com/marcusrbrown/infra/pull/739)), the first real harness mint still failed — and fixing that surfaced a second, deeper failure. Both were the same class: **the running broker behaved differently than the deployed code and on-disk state implied.** A green deploy and a correct-looking codebase are not proof that the live process is doing what you think.

## Symptoms

**Race 1 — stale bundle.** A legitimate harness OIDC mint returned `403`. The broker audit log showed the token was correct (`repositoryId: 1126485011`) but the deny reason was `expected PLACEHOLDER_REPOSITORY_ID` — the placeholder the allowlist had *already been changed away from* and redeployed.

**Race 2 — reconcile deletes in-flight key.** After Race 1 was fixed, a mint succeeded (`200`), but the merge agent's next model call failed with `401 Invalid API key` at `cliproxy.fro.bot/v1/messages` — the key it had just been handed was already gone.

## What Didn't Work

- **Trusting a green deploy + an on-disk grep.** After the allowlist PR merged and the gated `deploy-broker` ran green, `grep` of the droplet's `/opt/broker/dist/main.js` confirmed the real value `1126485011`. That verified the *file*, not the *running process* — and the running process was the miss. The user's 403 exposed the gap.
- **Assuming the 403 was a broker↔cliproxy contract bug (Race 2's 401).** The 401 came from cliproxy rejecting the minted key, which looked like a mint/format problem. The audit log + container timestamps proved it was a *timing* problem — the key had been valid and was deleted mid-run.
- **"Just don't deploy during a run" as the fix for Race 2.** Considered and rejected: crashes, OOMs, and host restarts recreate the container regardless. The broker has to be restart-safe; deploy-orchestration discipline is not sufficient.

## Solution

### Race 1 — force-recreate on deploy ([#740](https://github.com/marcusrbrown/infra/pull/740))

The broker bind-mounts its bundle (`./dist/main.js:/app/main.js:ro`) and runs `bun main.js`, which loads the file into memory at container start. When a deploy changes *only* the bundle content, `docker compose up -d` sees an identical compose spec and does **not** recreate the container — the process keeps running the previously-loaded code. Fix:

```
docker compose pull && docker compose up -d --force-recreate --wait --wait-timeout 90
```

Force-recreate on the whole stack covers a bundle change (broker restarts) and a Caddyfile change (caddy reloads). Named volumes (`caddy_data`, `caddy_config`) persist across recreation, so Let's Encrypt certs are unaffected — only `down -v` removes them, and that stays banned.

### Race 2 — self-describing keys + time-based reconcile ([#744](https://github.com/marcusrbrown/infra/pull/744), design reviewed by Oracle)

The broker tracked each minted key's expiry only in an **in-memory** live-set, and `reconcile()` revoked any `ghact-` key *not in that set*. On restart the live-set starts empty, so the startup reconcile treated every outstanding key — including in-flight keys of active runs — as an orphan and deleted it. `reconcile` was using "absent from the in-memory live-set" as revocation evidence, which is false after any restart: it cannot tell an orphan from a dead previous instance apart from an in-flight key of a currently-running job.

The fix makes the key name carry the one restart-stable fact and makes the lifecycle decision time-based:

- **Key format:** `ghact-<runId>-<expiresAtEpochMs>-<hexrand>`. Expiry is computed once at mint, embedded in the key, and recorded in the live-set.
- **`reconcile(now, deps)` is time-based:** parse the embedded expiry; revoke only if `expiry <= now`; keep a valid key regardless of live-set membership.
- **Legacy/malformed `ghact-` keys** (no embedded expiry) are skipped with a warning, never auto-revoked — so the first deploy of the fix cannot wipe a pre-existing in-flight key.
- **`sweepExpired`** derives authoritative expiry from the key name. The in-memory live-set is demoted to a cache / audit aid, never the liveness authority.

```ts
const KEY_EXPIRY_PATTERN = /^ghact-.+-(\d+)-[0-9a-f]+$/
export function parseKeyExpiry(key: string): number | null {
  if (!key.startsWith(KEY_PREFIX)) return null
  const match = KEY_EXPIRY_PATTERN.exec(key)
  if (!match) return null
  const expiry = Number(match[1])
  return Number.isSafeInteger(expiry) ? expiry : null
}
```

## Why This Works

- **Race 1:** `--force-recreate` forces the process to re-exec and reload the freshly-uploaded bundle, so the running code always matches what the deploy shipped.
- **Race 2:** the key's own name is the restart-stable evidence of its expiry. A restart wipes the in-memory cache but not the key names in cliproxy, so a time-based reconcile keeps a still-valid in-flight key and revokes only truly-expired ones. The root cause — reconcile inferring "stale" from a volatile in-memory fact — is eliminated, not worked around.

Note: cliproxy itself does not enforce the embedded expiry. If a hard server-side max lifetime is ever required, that belongs in cliproxy's request authorization, not broker-side cleanup.

## Prevention

- **Verify the running process, not just the file/deploy status.** A green deploy and a correct on-disk bundle do not prove the live process runs that code. For a bind-mounted interpreted bundle, confirm the container was recreated (check its `CreatedAt` against the deploy time) or probe a behavior that only the new code exhibits.
- **Never derive a destructive decision from volatile in-memory state that a restart erases.** If a reconcile/cleanup step revokes/deletes based on "not in my in-memory set," a restart makes that set empty and the step destroys live resources. Encode the decision-critical fact durably — here, in the resource's own name.
- **A bind-mounted bundle needs `--force-recreate`** (or an image rebuild): content-only changes to a mounted file don't trigger `docker compose` recreation.
- **Diagnose from the audit log / timestamps, not hypotheses.** Both root causes came straight from the broker audit log (the deny reason naming the stale placeholder; the mint-then-401 timeline against the container `CreatedAt`). The evidence named the bug in each case.

## Related Issues

- [#739](https://github.com/marcusrbrown/infra/pull/739) — set the real trust allowlist (the change Race 1's stale bundle failed to actually run).
- [#740](https://github.com/marcusrbrown/infra/pull/740) — deploy `--force-recreate` (Race 1 fix).
- [#744](https://github.com/marcusrbrown/infra/pull/744) — self-describing keys + time-based reconcile (Race 2 fix).
- [`broker-first-deploy-cascade-2026-06-30`](../workflow-issues/broker-first-deploy-cascade-2026-06-30.md) — the broker's provisioning/first-deploy gauntlet; this doc is the runtime-lifecycle successor.
- [`cliproxy-management-api-field-apply-2026-06-20`](../best-practices/cliproxy-management-api-field-apply-2026-06-20.md) — the "a green management API does not prove downstream state" precedent that both races echo.
- `fro-bot/agent#1081` — the consuming-side harness integration these fixes unblocked.
