---
title: 'fix: SSH identity-file support for droplet provisioning'
type: fix
status: completed
date: 2026-05-28
---

# fix: SSH identity-file support for droplet provisioning

## Overview

The shared SSH helpers in `packages/shared/server/droplet-helpers.ts` build `ssh`/`scp`/`waitForSsh` command arrays with `BatchMode=yes` but no identity-file flag, so they depend entirely on a loaded ssh-agent. When a provisioning key lives only in a file or in the `<APP>_SSH_KEY` environment variable (not the agent), provisioning fails. This plan adds optional identity-file support so the three provisioners can authenticate from the key material already present in the repo-root `.env`, without requiring the operator to pre-load ssh-agent.

## Problem Frame

Provisioning a droplet runs `provision-droplet.ts`, which calls the shared `waitForSsh` / `ssh` / `scp` helpers. Those helpers offer no way to pin a specific identity file, so SSH falls back to ssh-agent identities. Two concrete failures hit this session and previously:

- **umami (this session):** `waitForSsh` timed out — the `fro-bot-umami` key was only in the key file and `.env`, never loaded into the agent. Provisioning only completed after manual `ssh -i` verification outside the script.
- **gateway (precedent):** with many agent keys loaded, SSH offered them all and hit the server's `MaxAuthTries` → `Too many authentication failures` before reaching the right key; the workaround was `-o IdentitiesOnly=yes`.

The `<APP>_SSH_KEY` env var (e.g. `UMAMI_SSH_KEY`, `GATEWAY_SSH_KEY`, `CLIPROXY_SSH_KEY`) already holds the private key and is already consumed by each app's `deploy.ts` in CI. Provisioning should use the same source.

## Requirements Trace

- R1. `ssh`, `scp`, and `waitForSsh` accept an optional identity-file path; when provided, the built command includes `-i <path>` and `-o IdentitiesOnly=yes`.
- R2. When no identity file is provided, the helpers behave exactly as today (ssh-agent path) — no breaking change to existing callers or tests.
- R3. A shared helper materializes a private key from an environment variable into a temp file with `0600` permissions and a trailing newline, and supports cleanup.
- R4. The three provisioners (`cliproxy`, `gateway`, `umami`) materialize their `<APP>_SSH_KEY` when set, thread the identity file through `waitForSsh`/`ssh`/`scp`, and remove the temp file in a `finally`.
- R5. When `<APP>_SSH_KEY` is unset, provisioning falls back to the current ssh-agent behavior (operators relying on agent keys are unaffected).
- R6. Host values continue to pass through `validate<App>Host`/`validate<App>Domain` before any SSH argv construction (no regression in the host-injection guard).

## Scope Boundaries

- Not changing CI deploy behavior: each app's `deploy.ts` has its own SSH key materialization and does not use these shared helpers. This plan does not touch `deploy.ts`.
- Not changing `getDropletIpWithWait` (uses `doctl`, no SSH) or `pinHostKeys` (uses `ssh-keyscan`, no auth).
- Not introducing ssh-agent auto-loading or modifying how keys are registered with DigitalOcean.
- Not altering `StrictHostKeyChecking=accept-new` semantics for provisioning (first-contact provisioning legitimately accepts new host keys; host-key *pinning* for CI remains `pinHostKeys` + committed `known_hosts`).

## Context & Research

### Relevant Code and Patterns

- `packages/shared/server/droplet-helpers.ts` — `ssh()` (lines 10-22), `scp()` (lines 27-39), `waitForSsh()` (line 202) are the modification targets. All build arg arrays with `BatchMode=yes`, `StrictHostKeyChecking=accept-new`, `ConnectTimeout=10`.
- `packages/shared/server/droplet-helpers.test.ts` — existing `describe('ssh')`/`describe('scp')`/`describe('waitForSsh')` blocks assert exact arg arrays (e.g. `expect(result).toEqual([...])`) and use `spyOn` for spawn-based helpers. New scenarios extend these.
- `apps/umami/src/deploy.ts` (lines 3-4) — the key-materialization pattern to mirror: `mkdtempSync(tmpdir())` + `writeFileSync` + `chmodSync(path, 0o600)` + trailing newline + `rmSync` in `finally`. The trailing-newline detail is the gateway `libcrypto` lesson (GitHub Actions strips trailing whitespace; an OpenSSH key file needs the final newline).
- `apps/{cliproxy,gateway,umami}/server/provision-droplet.ts` — the three provisioners. Each already resolves its key *name* for DigitalOcean fingerprint lookup (`getSshFingerprint`) and documents `<APP>_SSH_KEY` in its prereq banner; none currently materializes the key for SSH.
- `validateCliproxyDomain` / `validateGatewayHost` / `validateUmamiHost` — host guards already run before SSH construction in each provisioner; this plan preserves that ordering.

### Institutional Learnings

- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` and `umami-first-deploy-cascade-2026-05-29.md` — both record the ssh-agent-vs-key-file provisioning gap and the trailing-newline `libcrypto` failure mode.
- Memory: SSH key files written from env/secret values must append a trailing newline; never pass key bytes via argv (we pass a *file path* via `-i`, never the key bytes).

### External References

- None needed. `-i <identity_file>` and `-o IdentitiesOnly=yes` are stable, standard OpenSSH options.

## Key Technical Decisions

- **Identity source = `<APP>_SSH_KEY` env var.** Symmetric with each app's `deploy.ts`, and the value already lives in repo-root `.env`. Removes the implicit ssh-agent dependency for provisioning.
- **Optional `opts` parameter, not a new required arg.** `ssh`/`scp`/`waitForSsh` gain an optional trailing options object (`{identityFile?: string}`). Existing callers and their exact-array assertions stay valid — additive only. When `identityFile` is set, the helper prepends `-i <path>` and `-o IdentitiesOnly=yes` so only that key is offered (fixes the `MaxAuthTries` variant).
- **Shared materialization helper.** A single `materializeIdentityFile(privateKey: string)` (or env-name variant) in the shared package, returning `{path, cleanup}`. DRY across all three provisioners and matches the goal of consolidating provisioning helpers in `packages/shared`.
- **`0600` + trailing newline + temp dir.** Mirror `deploy.ts` exactly; OpenSSH rejects group/world-readable key files, and the trailing newline avoids the `libcrypto` parse failure.
- **Cleanup in `finally`.** The temp key file is removed whether provisioning succeeds or throws. Best-effort unlink (ignore ENOENT).
- **No identity file → unchanged path.** When `<APP>_SSH_KEY` is unset, the provisioner calls the helpers with no `identityFile`, preserving today's ssh-agent behavior for operators who rely on it.
- **Path-only in argv.** The `-i` value is a temp-file path we generate via `mkdtempSync` — never user input and never key bytes — so there is no new argv-injection surface. Host values still pass the existing validators first.

## Open Questions

### Resolved During Planning

- Which helpers need the identity flag? Only `ssh`, `scp`, `waitForSsh` (`waitForSsh` builds an `ssh` invocation internally). `getDropletIpWithWait` and `pinHostKeys` do not authenticate over SSH.
- Materialize per-provisioner or shared? Shared helper — identical across all three, belongs in `packages/shared`.
- Breaking change risk to existing tests? None — the new parameter is optional and appended; existing exact-array assertions for the no-opts case remain true.

### Deferred to Implementation

- Exact helper name/signature (`materializeIdentityFile` vs `writeIdentityFile`; returning a `cleanup` closure vs a path plus a separate unlink helper) — settle when writing the test.
- Whether the materialization helper takes the raw key string or the env-var name — decide based on which keeps the provisioner call sites cleanest and most testable.

## Implementation Units

- [ ] **Unit 1: Optional identity-file support in `ssh`/`scp`/`waitForSsh`**

**Goal:** The shared SSH arg builders and `waitForSsh` accept an optional identity file and, when provided, emit `-i <path>` + `-o IdentitiesOnly=yes`.

**Requirements:** R1, R2, R6

**Dependencies:** None

**Files:**
- Modify: `packages/shared/server/droplet-helpers.ts`
- Test: `packages/shared/server/droplet-helpers.test.ts`

**Approach:**
- Add an optional trailing options object to `ssh(host, command, user, opts?)` and `scp(host, source, target, user, opts?)`; when `opts.identityFile` is set, insert `-i`, the path, and `-o IdentitiesOnly=yes` into the arg array (alongside the existing `BatchMode`/`StrictHostKeyChecking`/`ConnectTimeout` flags).
- Thread the same `opts` through `waitForSsh(host, user, opts?)` so its internal `ssh(...)` call forwards `identityFile`. Keep the existing `RetryOptions` (`maxAttempts`/`intervalMs`) — fold identity into the same options object or a separate param, whichever keeps the signature clean (decide at implementation).

**Execution note:** Test-first. Write failing arg-array assertions for the `identityFile`-set case before modifying the builders; prove the no-opts case is byte-identical to today.

**Technical design:** *(directional guidance, not implementation specification)*

    ssh('1.2.3.4', 'echo ready', 'root', { identityFile: '/tmp/x/key' })
    -> ['ssh', '-i', '/tmp/x/key',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        'root@1.2.3.4', 'echo ready']
    ssh('1.2.3.4', 'echo ready', 'root')   // no opts -> unchanged from today

**Patterns to follow:**
- Existing `ssh`/`scp` arg-array shape and the `describe('ssh')`/`describe('scp')` exact-array assertions in `droplet-helpers.test.ts`.

**Test scenarios:**
- Happy path: `ssh(...)` with `identityFile` set includes `-i <path>` and `-o IdentitiesOnly=yes` in the expected positions.
- Happy path: `scp(...)` with `identityFile` set includes the same flags.
- Edge case: `ssh(...)` / `scp(...)` with no opts (and with `opts` omitting `identityFile`) produces the exact array it produces today — regression guard for R2.
- Happy path: `waitForSsh(host, user, {identityFile})` forwards the flag into the spawned `ssh` argv (assert via `spyOn(Bun, 'spawn')` capturing the command array).
- Edge case: `waitForSsh` retry/timeout behavior unchanged when identity options are present (reuse existing maxAttempts/intervalMs assertions).

**Verification:**
- Identity-set and identity-unset arg arrays both match expectations; existing helper tests still pass unchanged.

- [ ] **Unit 2: Shared identity-file materialization helper**

**Goal:** A shared helper writes a private key into a `0600` temp file with a trailing newline and provides cleanup, for reuse by all three provisioners.

**Requirements:** R3

**Dependencies:** None (can land alongside Unit 1)

**Files:**
- Modify: `packages/shared/server/droplet-helpers.ts`
- Test: `packages/shared/server/droplet-helpers.test.ts`

**Approach:**
- Add `materializeIdentityFile(privateKey)` that creates a temp dir via `mkdtempSync(join(tmpdir(), ...))`, writes the key with a guaranteed single trailing newline, `chmodSync(path, 0o600)`, and returns the path plus a `cleanup()` that best-effort removes the temp dir (ignore ENOENT).
- Normalize the trailing newline (append one if absent) to defend against env injection stripping it — the gateway `libcrypto` lesson.

**Execution note:** Test-first.

**Patterns to follow:**
- `apps/umami/src/deploy.ts` key materialization (`mkdtempSync` + `writeFileSync` + `chmodSync(0o600)` + trailing newline + `rmSync`).

**Test scenarios:**
- Happy path: given a key string, the file exists, contains the key, ends with exactly one newline, and has mode `0600` (assert via `statSync(path).mode & 0o777`).
- Edge case: a key string already ending in `\n` does not gain a second trailing newline.
- Happy path: `cleanup()` removes the temp file/dir; calling it twice does not throw (idempotent / ignore ENOENT).

**Verification:**
- File mode is `0600`, content round-trips with a single trailing newline, cleanup is idempotent.

- [ ] **Unit 3: Wire identity materialization into the three provisioners**

**Goal:** Each provisioner materializes `<APP>_SSH_KEY` when set, passes the identity file to `waitForSsh`/`ssh`/`scp`, and cleans up in `finally`; falls back to ssh-agent when unset.

**Requirements:** R4, R5, R6

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `apps/cliproxy/server/provision-droplet.ts`
- Modify: `apps/gateway/server/provision-droplet.ts`
- Modify: `apps/umami/server/provision-droplet.ts`
- Test: `apps/cliproxy/server/provision-droplet.test.ts`
- Test: `apps/gateway/server/provision-droplet.test.ts`
- Test: `apps/umami/server/provision-droplet.test.ts`

**Approach:**
- **Seam first (required):** the SSH-using logic currently lives inside each provisioner's `main()`, which the existing tests never invoke (they only exercise exported pure helpers like `validateRequiredEnv`, `parseProvisionArgs`, `getSshFingerprint`, plus `dropletExists` via `spyOn(Bun, 'spawn')`). Before wiring identity support, extract the SSH-orchestration portion of `main()` (the `waitForSsh`/`ssh`/`scp` region, post-IP-resolution) into an exported, testable function that accepts injectable dependencies — at minimum the SSH helpers (`waitForSsh`/`ssh`/`scp` or a `SpawnFn`) and the materializer — defaulting to the real implementations. This is what makes the argv assertions below possible.
- After host validation and before the first SSH/SCP call, read `process.env.<APP>_SSH_KEY`. If present, call `materializeIdentityFile`, capture `{path, cleanup}`, and pass `identityFile: path` through every `waitForSsh`/`ssh`/`scp` invocation; wrap the SSH-using region in `try { ... } finally { cleanup() }`.
- If absent, call the helpers with no identity file (today's behavior) — no temp file, no cleanup.
- Preserve the existing `validate<App>Host`/`validate<App>Domain` call ahead of any SSH argv construction.
- Keep each provisioner's `import.meta.main` guard; the extracted function is imported by tests while `main()` stays guarded so importing does not execute live `doctl`/SSH (existing repo rule).

**Execution note:** Test-first per provisioner. The injectable seam must be created as part of this unit — the current tests cannot assert SSH argv because `main()` is never called. Mirror the dependency-injection style already used by `gateway/status.ts` (injectable `SpawnFn` defaulting to `Bun.spawn`) rather than inventing a new mocking approach.

**Patterns to follow:**
- `packages/cli/src/commands/gateway/status.ts` — `SpawnFn` dependency injection with a real default, asserted in `gateway/status.test.ts`.
- The repo's "export testable functions, guard `main()` with `import.meta.main`" convention (build.ts, the provisioners' existing exported helpers).
- `apps/umami/src/deploy.ts` `finally`-cleanup of the temp key file.

**Test scenarios:**
- Happy path (key set): provisioner materializes a temp key and the `waitForSsh`/`ssh`/`scp` argv includes `-i <path>` + `-o IdentitiesOnly=yes`.
- Happy path (key unset): provisioner invokes the helpers with no identity file; argv matches today's agent-based shape; no temp file created.
- Error path: when a provisioning step throws after the key is materialized, `cleanup()` still runs (assert the temp path is removed in `finally`).
- Edge case (R6 regression): a `-`-prefixed or out-of-alphabet host is rejected by the validator before any SSH argv is built (one per provisioner, mirroring existing host-guard tests).
- Integration: the materialized key file is the one referenced by `-i` (path threaded end-to-end, not a second/blank file) — asserted through the extracted orchestration function with injected helpers, not via `main()`.

**Verification:**
- With `<APP>_SSH_KEY` set, provisioning builds identity-pinned SSH commands and cleans up the temp key; with it unset, behavior is unchanged; host validation still gates argv construction; all three provisioner test suites pass.

## System-Wide Impact

- **Interaction graph:** Only the three `provision-droplet.ts` entry points and the shared helpers are affected. `deploy.ts` files are untouched (separate SSH path), so CI deploy flows do not change.
- **Error propagation:** Materialization failures (bad key) surface before SSH attempts; cleanup is best-effort and must not mask the primary error (unlink errors swallowed in `finally`).
- **State lifecycle risks:** Temp key file is the only new on-disk state; `finally` cleanup prevents leaving `0600` key material in `tmpdir`. Idempotent cleanup avoids double-unlink throws.
- **API surface parity:** All three provisioners get the identical change — no provisioner left on the old agent-only path inconsistently.
- **Integration coverage:** Provisioner tests assert the identity file is threaded end-to-end (materialized path === `-i` path), which unit-level arg tests alone would not prove.
- **Unchanged invariants:** `ssh`/`scp`/`waitForSsh` no-opts behavior, `StrictHostKeyChecking=accept-new` for provisioning, `getDropletIpWithWait`, `pinHostKeys`, and all `deploy.ts` SSH paths are explicitly unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Optional-param change accidentally alters existing arg arrays | Regression test asserts the no-opts arrays are byte-identical to today (R2). |
| Key file missing trailing newline → `libcrypto` parse failure | Materialization helper normalizes to exactly one trailing newline; covered by a test. |
| `0600` not enforced → OpenSSH refuses the key | `chmodSync(0o600)` plus a mode assertion in the helper test. |
| Temp key left on disk after a failed provision | `finally` cleanup with idempotent best-effort unlink; error-path test verifies removal. |
| Operators relying on ssh-agent break | Key-unset path preserved unchanged (R5); explicit test for the no-identity case. |
| Host-injection guard regressed by reordering | R6 scenario keeps validator ahead of argv construction in each provisioner. |
| Unit 3 argv assertions not testable as-is — SSH logic lives in untested `main()` | Unit 3 extracts an injectable SSH-orchestration function first (mirroring `gateway/status.ts` `SpawnFn`); the seam is in-scope for the unit, not a separate prerequisite PR. |
| Abrupt termination (SIGKILL/crash) leaves a `0600` key in `tmpdir` | Accepted residual: provision is a short-lived interactive operation; `finally` covers normal + thrown exits. Signal-handler cleanup is out of scope for v1; documented as an operational note rather than engineered around. |

## Documentation / Operational Notes

- Update each app's `AGENTS.md` provisioning note (and root `AGENTS.md` if it documents provisioning) to state that `bun run provision:<app>` now authenticates from `<APP>_SSH_KEY` when set, with ssh-agent as fallback — removing the manual `ssh -i` / `IdentitiesOnly` workaround called out for umami/gateway.
- No changeset: `packages/shared` and `apps/*/server` are not part of the published `@marcusrbrown/infra` runtime (`packages/cli/src/` only). Confirm at PR time.

## Sources & References

- Related code: `packages/shared/server/droplet-helpers.ts`, `apps/{cliproxy,gateway,umami}/server/provision-droplet.ts`, `apps/umami/src/deploy.ts`
- Institutional learnings: `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`, `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`
