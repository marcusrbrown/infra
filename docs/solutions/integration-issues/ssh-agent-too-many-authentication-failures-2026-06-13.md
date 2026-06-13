---
title: SSH status checks fail with "Too many authentication failures" when ssh-agent key order exceeds MaxAuthTries
date: 2026-06-13
category: docs/solutions/integration-issues
module: packages/cli
problem_type: integration_issue
component: tooling
symptoms:
  - 'gateway status, umami status, and vpn status intermittently failed with "Received disconnect from <host> port 22: Too many authentication failures"'
  - 'the unified infra status dashboard showed gateway/cliproxy/keeweb passing while umami and vpn rows failed'
  - 'failures were non-deterministic and varied with ssh-agent key order'
root_cause: config_error
resolution_type: code_fix
severity: high
related_components:
  - packages/cli/src/lib/ssh-identity.ts
  - packages/cli/src/commands/gateway/status.ts
  - packages/cli/src/commands/umami/status.ts
  - packages/cli/src/commands/vpn/shared.ts
tags:
  - ssh
  - ssh-agent
  - maxauthtries
  - status
  - authentication
  - infra-status
---

# SSH status checks fail with "Too many authentication failures" when ssh-agent key order exceeds MaxAuthTries

## Problem

`gateway status`, `umami status`, and `vpn status` (and the unified `infra status` dashboard plus the MCP status tools) intermittently failed over SSH with `Received disconnect from <host> port 22: Too many authentication failures`. The status commands relied entirely on the ssh-agent, so OpenSSH offered agent keys one-by-one and hit the server's `MaxAuthTries` limit before reaching the right key.

## Symptoms

- `Received disconnect from <host> port 22: Too many authentication failures` on the umami and vpn status rows, while gateway/cliproxy/keeweb passed in the same run
- Non-deterministic — which hosts failed depended on the order of keys in the ssh-agent
- Reproduced through both `infra status` and the MCP `umami_status`/`vpn_status` tools

## What Didn't Work

- **Relying on the ssh-agent alone.** This was the root cause, not a fix: with many keys loaded, OpenSSH offers them sequentially and the server cuts the connection after ~6 attempts (`MaxAuthTries`). Whichever host's accepted key sat past the 6th offer failed.
- **Testing via `set -a; source .env; set +a`.** This produced a misleading `Load key "...": invalid format` because POSIX shell `source` mangles the multi-line PEM stored in `.env` (`UMAMI_SSH_KEY`/`VPN_SSH_KEY`/`GATEWAY_SSH_KEY`). The real runtime uses Bun's native `.env` autoload, which parses multi-line values correctly — so the "invalid format" was a test-harness artifact, not a code defect.
- **Importing the shared `materializeIdentityFile`.** A near-identical helper exists in `packages/shared/server/droplet-helpers.ts`, but `packages/cli` must not depend on the private `@marcusrbrown/infra-shared` package or the published npm install breaks. The helper had to be CLI-local.

## Solution

Make the status SSH deterministic by using the app's own key via `-i <key> -o IdentitiesOnly=yes` so OpenSSH offers exactly one identity and never cycles agent keys.

A CLI-local helper `packages/cli/src/lib/ssh-identity.ts`:

```ts
// materializeIdentityFile: write the key to a temp 0600 file (trailing newline
// ensured), with idempotent cleanup and cleanup-on-write-failure.
// buildIdentityArgs: turn an optional key into ssh args + a cleanup handle.
export function buildIdentityArgs(privateKey: string | undefined): {
  args: string[]
  cleanup: () => void
} {
  if (!privateKey || !privateKey.trim()) return {args: [], cleanup: () => {}}
  const {path, cleanup} = materializeIdentityFile(privateKey)
  return {args: ['-i', path, '-o', 'IdentitiesOnly=yes'], cleanup}
}
```

Each status command (`gateway/status.ts`, `umami/status.ts`, `vpn/shared.ts`):

```ts
const {args: identityArgs, cleanup} = buildIdentityArgs(process.env.GATEWAY_SSH_KEY)
try {
  const sshArgs = [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    ...buildKnownHostsArgs(),   // built BEFORE the key is materialized
    ...identityArgs,            // -i <tempkey> -o IdentitiesOnly=yes
    `root@${host}`,             // vpn uses ubuntu@ + sudo; preserve per-app user
    /* remote command */
  ]
  // spawn …
} finally {
  cleanup()
}
```

When `<APP>_SSH_KEY` is unset, `buildIdentityArgs` returns no args and a no-op cleanup, so local dev with an ssh-agent works exactly as before.

## Why This Works

`IdentitiesOnly=yes` combined with a single explicit `-i <key>` tells OpenSSH to offer only that one identity instead of iterating every key in the agent. The connection therefore never accumulates failed attempts toward `MaxAuthTries`, so the disconnect can't happen regardless of how many keys the operator's agent holds. The fix is purely additive on the trusted path (the app already owns `<APP>_SSH_KEY`) and preserves the ssh-agent fallback when no key is configured.

## Prevention

- Any SSH-spawning CLI or MCP command that must survive a many-key ssh-agent should authenticate with the app's own key via `-i <key> -o IdentitiesOnly=yes`, not bare ssh-agent reliance.
- Build known-hosts args **before** materializing the temp key, so an early throw during arg construction can't leak the 0600 key file (clean up in a `finally` regardless).
- Keep the materialization helper CLI-local in `packages/cli` — do not import from `@marcusrbrown/infra-shared`, which would re-break the published npm install (the published CLI must be self-contained).
- When verifying `.env`-driven SSH behavior, run through Bun's native `.env` autoload, not shell `source` — `source` corrupts multi-line PEM values and yields a false `invalid format`.

## Related Issues

- PR #512 — `fix(cli): use the app SSH key for status to avoid agent auth failures` (merged, `@marcusrbrown/infra@0.10.4`)
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — the deploy path's temp-key + `-i` + `IdentitiesOnly` precedent (deploy, not status)
- `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md` — adjacent first-provision SSH brittleness
- `docs/solutions/workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md` — VPN SSH/known_hosts/provisioning precedent
