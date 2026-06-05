---
title: 'Gateway deploys never rebuilt the image: a moved pin that never took effect, masking a broken upstream image'
problem_type: workflow_issue
component: development_workflow
root_cause: missing_workflow_step
resolution_type: code_fix
severity: critical
date: 2026-05-31
tags: [gateway, docker-compose, build, stale-image, deploy, fro-bot, upstream, git-clean, secrets]
module: apps/gateway
related_issues: []
related_docs:
  - docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md
  - docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md
---

# Gateway Deploys Never Rebuilt the Image

## Problem

The gateway deploy moved the `apps/gateway/upstream.json` pin forward (e.g. v0.44.2 → v0.46.1) and every deploy reported success — but the running daemon never changed. For weeks the droplet kept executing a Docker image built on an earlier date, regardless of the pinned ref. The gap only became visible when a "cutover" to v0.46.1 left the daemon registering the old `/fro-bot ping` command set and **not** the new `/fro-bot add-project` subcommand that v0.46.1's source unconditionally registers.

Fixing the rebuild then surfaced a second, hidden failure: the freshly-built v0.46.1 image crash-loops on boot due to an upstream packaging bug.

## Symptoms

- A `/fro-bot add-project` slash command that exists and is unconditionally registered in the pinned source does not appear in Discord; the live guild command set shows only the previous version's commands.
- `git describe --tags` on the droplet shows the new pinned ref, but `docker image inspect` shows the running image was built weeks earlier (image `Created` timestamp far older than the container `Created` timestamp).
- After adding `--build`, the gateway container reports `unhealthy` and `docker compose up --wait` fails; logs show a crash loop: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/node_modules/@fro-bot/runtime/src/index.ts' imported from /app/packages/gateway/dist/main.mjs`.

## What Didn't Work

- **Assuming a green deploy meant the new version was live.** The deploy's `docker compose up -d --wait` passed and the Discord registration poll printed `✓ Registered commands` — but `--wait` only asserts container *health*, and registration ran against the stale image. Health and registration both passed while running old code. A passing deploy proved liveness, not freshness.
- **Treating the missing slash command as a Discord propagation/cache delay.** Guild-scoped commands propagate near-instantly, and the live Discord guild-commands API confirmed the command was genuinely absent from the registered set — so it was never a client cache issue. The daemon simply wasn't running the code that registers it.
- **Manual restore via `git reset --hard <good ref> && git clean -xfd && docker compose up`.** The `git clean -xfd` wiped the untracked `secrets/` directory, so compose then failed with `bind source path does not exist: /opt/gateway/deploy/secrets/discord-token`. (auto memory [claude])

## Solution

**Fix 1 — force a rebuild on every deploy (`code_fix`).** The gateway and workspace are `build:`-from-source Compose services. `docker compose up` only builds a `build:` service when its image is *absent*; it does not rebuild when the source changes. Add `--build` unconditionally so each deploy rebuilds from the freshly-reset source:

```ts
// apps/gateway/src/deploy.ts — composeArgs
const composeArgs = [
  'docker', 'compose', '--project-directory', DEPLOY_DIR,
  'up', '-d', '--build', '--wait', '--wait-timeout', '120',
]
if (forceRecreate || checksumChanged) {
  composeArgs.push('--force-recreate')
}
```

`--build` is independent of `--force-recreate`: recreate swaps the container from an existing image; build produces the image. Docker's layer cache keeps a no-change rebuild cheap.

**Fix 2 — hold the pin at the last version verified to boot.** With `--build` in place, the v0.46.1 image actually built and ran, and crash-looped: its compiled `dist/main.mjs` resolves the `@fro-bot/runtime` workspace package to `src/index.ts`, which the runtime image stage doesn't copy (only `dist/` is). This is an upstream `fro-bot/agent` packaging bug (filed as fro-bot/agent#707). Resolution: revert `upstream.json` to v0.44.2 (the only version empirically verified to boot) and set the Renovate ceiling to `<0.44.3` until a fixed image is verified. (auto memory [claude])

**Restore.** Because `git clean -xfd` had wiped the untracked secret files and only some gateway secrets live in the local `.env` (the rest are GitHub-Environment-only), recovery ran the real deploy materializer against v0.44.2 rather than hand-rolling secret files. On macOS this also required `TMPDIR=/tmp` because the default `/var/folders/...` path overflows SSH's 104-byte `ControlPath` socket limit.

## Why This Works

The deploy's job is to make the running daemon match the pinned source. With a `build:`-from-source service, that requires rebuilding the image — `git reset` only updates source on disk. Without `--build`, the only thing that ever changed the image was its *absence* (first deploy), so the very first build became a permanent fixture and the pin became cosmetic. Adding `--build` restores the invariant: pinned ref → rebuilt image → running daemon. As a bonus, it converts "silently runs stale code" into "fails loudly when the pinned source can't build or boot" — which is how the upstream v0.46.1 bug finally surfaced.

## Prevention

- **For an ON-HOST `build:`-from-source Compose deploy, the deploy must `docker compose up --build`.** Without it, source changes (including pin bumps) never reach the running container. (Scope: this applies when the host builds the image. The gateway deploy later moved the build off the droplet — CI builds and pushes to GHCR, the droplet pulls a digest-pinned image and runs `up -d --no-build`. Under that model the droplet must NOT use `--build`; freshness comes from the pinned digest, not a host rebuild. See `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`.) When the host does build, enforce `--build` with a test asserting it is present in the compose command on every path:

  ```ts
  const composeCall = calls.find(cmd => cmd.some(s => s.includes('docker compose')))
  expect(composeCall?.join(' ')).toContain('--build') // independent of --force-recreate
  ```

- **Verify freshness, not just health, after a version bump.** A green deploy with a passing health/registration gate can still be running old code. Confirm the running image's build time and the live behavior the new version is supposed to add (here: query the Discord guild-commands API for the new command), not just that the container is healthy.
- **Never `git clean -xfd` the droplet deploy directory during manual recovery.** It deletes the untracked `secrets/` files. Some secret values are GitHub-Environment-only and not in the local `.env`, so the correct restore path is a full pipeline (or local-with-materializer) deploy, not hand-editing. (auto memory [claude])
- **A pinned upstream ref does not guarantee a runnable image.** Probe a freshly-built image's boot before trusting a cutover, per the upstream-upgrade playbook. Hold the Renovate ceiling at the last version verified to boot.

## Related Issues

- `marcusrbrown/infra` #341 — gateway v0.46.x adoption tracker (blocked on the upstream image bug).
- `fro-bot/agent` #707 — upstream packaging bug: `@fro-bot/runtime` resolves to `src/index.ts`, absent from the runtime image.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — same app and deploy path, different failure class (secrets, SSH rate limits, NDJSON parsing). That cascade doc's "audit the upstream compose contract" prevention is necessary but not sufficient for build-from-source services, which also require a forced rebuild.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — probe-first, backup-anchored upgrade doctrine; the "verify the pinned image actually runs" practice this incident reinforces.
