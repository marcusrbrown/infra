---
title: 'Gateway first deploy: 5-wave cascade from contract drift to NDJSON parsing'
problem_type: workflow_issue
component: development_workflow
root_cause: incomplete_setup
resolution_type: code_fix
severity: critical
date: 2026-05-20
last_refreshed: 2026-05-31
tags: [gateway, docker-compose, digitalocean, deploy, ssh, ufw, controlmaster, secrets, ndjson]
module: apps/gateway
related_issues: []
related_docs:
  - docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md
  - docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md
  - docs/solutions/workflow-issues/bun-deploy-user-permissions-ci-2026-04-02.md
---

# Gateway First Deploy: 5-Wave Cascade

## Problem

The first end-to-end deploy of `apps/gateway` to `gateway.fro.bot` required 7 attempts and 4 follow-up PRs (#273, #276, #277, #278) before the Docker Compose stack came up healthy and `/fro-bot ping` returned `pong` in Discord. Each fix only unblocked the next latent failure, exposing a chain of unverified assumptions along the deploy path: upstream compose contract drift, corrupted GitHub Actions secrets, OpenSSH PEM newline requirements, UFW SSH rate-limiting, and a Docker Compose NDJSON output format that the status parser didn't handle.

Same shape as the [cliproxy first-deploy cascade](./cliproxy-first-deploy-cascade-2026-04-06.md) a month earlier, on a different app. Both incidents reinforce one lesson: the **first deploy of a new app is the first real test of the deploy contract end-to-end**.

## Symptoms

Each wave presented a distinct error at a different layer:

1. **Wave 1 — Upstream contract drift** (pre-deploy, caught by audit): `OBJECT_STORE_HOSTS` for path-style S3 endpoints would have produced an empty allowlist; secret bind-mounts would have created directories instead of files because filenames didn't match the upstream compose contract.
2. **Wave 2 — Corrupted GH Actions secrets** (deploy attempts 3, 4): `Invalid OBJECT_STORE_HOSTS: "***.s3.***.amazonaws.com" — label starts with a hyphen` and `Invalid GATEWAY_HOST: "***" — must match [A-Za-z0-9][A-Za-z0-9.\-]*`. Local `.env` values were clean; remote-stored values were not.
3. **Wave 3 — SSH key trailing newline** (deploy attempt 5): `Load key "/tmp/gateway-deploy-key-*/id": error in libcrypto` followed by `root@***: Permission denied (publickey)`.
4. **Wave 4 — UFW SSH rate limit** (deploy attempts 5 + 6): `ssh: connect to host *** port 22: Connection timed out` at deploy phase "Creating secrets directory" — the 6th SSH connection in ~7s. UFW counter on the droplet showed 163 packets blocked.
5. **Wave 5 — NDJSON parsing** (after v0.4.10 release): `bunx @marcusrbrown/infra gateway status` → `Error: Failed to parse docker compose ps output: {"Command":"\"docker-entrypoint.s…\"...`. Error preview showed a single JSON object, not an array.

## What Didn't Work

- Treating each failure as transient before two consecutive identical errors proved otherwise (Wave 4).
- Re-seeding GitHub Actions secrets one at a time when validators complained (Wave 2) — eventually swept all 8 at once after the second false start.
- For Wave 4, considering and rejecting weaker fixes before settling on the right one: dropping the UFW rule (loses defense-in-depth), whitelisting GitHub Actions IP ranges (fragile, requires periodic refresh), retry-with-backoff (each retry needs ≥30s to clear the rate-limit window — deploys explode to 5+ minutes).
- Unit tests that mocked downstream of the boundary that broke (Wave 5): `parseComposePs` was tested with pre-parsed `ComposePsEntry[]` arrays, never with real `docker compose ps --format json` stdout.
- Trusting that `.env` values matching what we wanted meant the GitHub Actions secrets storing the same values were structurally correct (Wave 2).

## Solution

Each wave required a distinct, narrow fix. Resolved across 4 follow-up PRs.

### Wave 1 — Upstream compose contract drift

**[PR #273](https://github.com/marcusrbrown/infra/pull/273)**: align `apps/gateway/src/deploy.ts` with upstream `fro-bot/agent@v0.44.2` compose contract. Seven coordinated fixes:

| ID | Fix |
|---|---|
| F1 | Rename secret files from `snake_case` to `kebab-case` (`discord_token` → `discord-token`, etc.) — 8 total |
| F5 | `computeObjectStoreHosts()` returns `url.hostname` (path-style) not `bucket.hostname` for custom S3 endpoints |
| F6 | `gateway deploy --local` CLI command passes full required env (S3_ENDPOINT, OBJECT_STORE_HOSTS, AWS_SESSION_TOKEN, …) instead of stripping to 4 keys |
| F7 | Drop `webfactory/ssh-agent` in CI; write `GATEWAY_SSH_KEY` to mktemp file with mode 0o600, use `ssh -i <file> -o IdentitiesOnly=yes` |
| F9 | Tighten `OBJECT_STORE_HOSTS` regex to RFC1123-strict hostname chars |
| F10 | `readRemoteChecksum()` throws on non-zero SSH exit instead of silently returning empty (which masked auth failures as "first deploy") |
| extra | Add `aws-session-token` as optional secret (empty file when unset), required by v0.44.2's `create_host_path: false` compose mounts |

### Wave 2 — Corrupted GitHub Actions secrets

Procedural fix only, no code change. Re-seeded all 8 gateway secrets via clean stdin pipe, no shell command substitution:

```bash
bun -e 'process.stdout.write(process.env.GATEWAY_SSH_KEY ?? ""); console.log()' | gh secret set --env gateway GATEWAY_SSH_KEY
```

The pattern that caused corruption was using shell here-strings with command substitution:

```bash
# BAD — values may include stray whitespace, encoding artifacts, or trailing chars
gh secret set GATEWAY_HOST --body "$(cat <<'EOF'
gateway.fro.bot
EOF
)"
```

### Wave 3 — `GATEWAY_SSH_KEY` trailing newline

**[PR #276](https://github.com/marcusrbrown/infra/pull/276)**: append `\n` when the materialized key file is missing it. GitHub Actions strips trailing whitespace from secret env-var injection; OpenSSH PEM keys REQUIRE `\n` after `-----END OPENSSH PRIVATE KEY-----`. Two-line change in `apps/gateway/src/deploy.ts`:

```ts
const keyContent = env.GATEWAY_SSH_KEY.endsWith('\n')
  ? env.GATEWAY_SSH_KEY
  : `${env.GATEWAY_SSH_KEY}\n`
writeFileSync(keyPath, keyContent, {mode: 0o600})
```

The `endsWith('\n')` check makes the fix idempotent — locally-supplied keys with their own trailing newline aren't double-newlined.

### Wave 4 — UFW SSH rate limit + ControlMaster

**[PR #277](https://github.com/marcusrbrown/infra/pull/277)**: multiplex all deploy SSH connections through one TCP connection via OpenSSH ControlMaster. Eliminates the 6-connections-in-7s burst that triggered UFW's default `limit ssh` (6/30s/source) rule.

```ts
function sshCommand(host: string, command: string, keyPath?: string, controlPath?: string): string[] {
  return [
    'ssh',
    ...sshIdentityOptions(keyPath),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
    ...(controlPath
      ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=300']
      : []),
    `${DEFAULT_REMOTE_USER}@${host}`,
    command,
  ]
}
```

Threaded `controlPath` through `sshCommand()`, `writeRemoteFile()`, `remoteGitExists()`, `readRemoteChecksum()`, plus scp invocations. The deploy entry point always creates a tmpdir (CI and local mode) and derives `controlPath = <tmpdir>/cm-%C`. Existing `finally { rmSync(keyTmpDir, recursive: true) }` cleans up the socket along with the key.

**Empirical proof the fix works**: UFW counter on droplet was at `163 packets / 9180 bytes` blocked before. After a successful deploy ran end-to-end with this fix, the counter remained at exactly `163 / 9180` — zero new blocked packets. The entire deploy ran through one TCP connection.

### Wave 5 — NDJSON parsing in `gateway status`

**[PR #278](https://github.com/marcusrbrown/infra/pull/278)**: parse `docker compose ps --format json` as NDJSON (one JSON object per line, the format since Compose v2.21+). The existing parser called bare `JSON.parse(stdoutText)` expecting a single array.

```ts
export function parseComposePsOutput(stdoutText: string): ComposePsEntry[] {
  const trimmed = stdoutText.trim()
  if (trimmed.length === 0) return []

  // Legacy compose may emit a single JSON array; current versions emit NDJSON.
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as ComposePsEntry[]) : []
  }

  return trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as ComposePsEntry)
}
```

Tests added: 7 unit tests + 2 integration tests with realistic NDJSON fixtures mirroring live droplet output. End-to-end verified against the live gateway droplet — `bun packages/cli/src/cli.ts gateway status` correctly reports all 3 services with their health.

## Why This Works

The waves share one root cause class: **assumptions about the deploy contract that were never exercised end-to-end until first deploy**.

- Wave 1: upstream compose contract evolved through 5+ PRs in `fro-bot/agent`; the local `apps/gateway` deploy script was written against an earlier snapshot. Audited via Oracle dispatch before deploy ran — that's the only wave caught pre-deploy.
- Wave 2: shell command substitution silently transformed secret values. The corruption was invisible until validators in production rejected the stored bytes.
- Wave 3: GitHub Actions documents secret-value transformation behavior (`trim` on injection) but the deploy path didn't account for it. Locally-loaded keys via `bun -e` worked fine; the CI-injected version didn't.
- Wave 4: deploy.ts was written for "make N SSH calls" without thinking about TCP connection rate. Droplet's stock UFW config was equally unaware. They met under load on the 6th call.
- Wave 5: tests mocked at `parseComposePs(raw: ComposePsEntry[])` — the wrong boundary. The JSON-parse step in `getGatewayComposeStatus` had zero coverage against real stdout shape.

Each fix is structural at the layer it addresses: append `\n` when materializing the key (Wave 3), multiplex SSH connections (Wave 4), parse NDJSON correctly (Wave 5). No retries, no whitelists, no workarounds.

## Prevention

### Wave-specific guardrails

- **Wave 1 / contract drift**: pin upstream by SemVer tag (not `latest`), audit the upstream compose contract before each major bump, treat compose `environment` / `volumes` / `secrets` as a versioned API. Note: auditing the contract is necessary but **not sufficient** for `build:`-from-source compose services — the deploy must also force a rebuild (`docker compose up --build`), or a moved pin updates source on disk while the running container keeps a stale image. See [gateway-deploy-stale-image-2026-05-31.md](./gateway-deploy-stale-image-2026-05-31.md).
- **Wave 2 / secret corruption**: never use `gh secret set --body "$(cat <<'EOF' ... EOF)"`. Pipe via stdin (`bun -e 'process.stdout.write(...)' | gh secret set --env <env> <name>`) or use `gh secret set --env <env> <name> < file`. Audit all secrets via single sweep when one looks corrupt, not one at a time.
- **Wave 3 / PEM newline**: test the actual file contents written to disk in CI key tests, not just the mode bits. Specifically cover both branches (trailing newline missing → appended; existing → not doubled).
- **Wave 4 / SSH rate limit**: keep deploys connection-pooled by default (ControlMaster=auto + ControlPersist). Watch UFW counters during first deploys of new apps. Don't blame "transient network" without demanding evidence from counters or logs.
- **Wave 5 / parser boundary**: when testing a CLI-output parser, include at least one fixture mirroring the actual upstream tool's output shape. Mock at the spawn boundary (real `stdout` bytes), not at the parsed-array boundary.

### Cross-wave guardrails

- **First deploy of any new app is a deploy-contract test, not a feature smoke test.** Budget for 5-10 deploy attempts before the first one succeeds. The cliproxy precedent ([cliproxy-first-deploy-cascade-2026-04-06.md](./cliproxy-first-deploy-cascade-2026-04-06.md)) was 4 waves; gateway was 5; the pattern is consistent.
- **Test at the boundary where data crosses a process or format change**: secret bytes (`gh secret set` → GH Actions injection), SSH key files (env var → file on disk), CLI stdout (real tool → parser). Unit tests on the helper downstream of that boundary catch nothing.
- **Demand evidence from counters and logs before broadening blast radius.** Tonight's UFW diagnosis took ~5 minutes once Oracle was dispatched with the symptom log. Earlier "transient network" reasoning would have wasted hours.
- **When a fix is structural at the right layer, don't accept retries or workarounds.** ControlMaster (Wave 4) was the structural answer; retry-with-backoff would have shipped a 5x slower deploy.

## Related Issues

- [gateway-deploy-stale-image-2026-05-31.md](./gateway-deploy-stale-image-2026-05-31.md) — same app and deploy path; the missing `docker compose up --build` that let a moved pin run a stale image (and masked a broken upstream image)
- [cliproxy-first-deploy-cascade-2026-04-06.md](./cliproxy-first-deploy-cascade-2026-04-06.md) — same shape of cascade for the cliproxy app, 4 waves
- [bun-deploy-user-permissions-ci-2026-04-02.md](./bun-deploy-user-permissions-ci-2026-04-02.md) — earlier deploy-cascade precedent (3 waves of permission failures during keeweb deploy bootstrap)
- PRs: [#273](https://github.com/marcusrbrown/infra/pull/273), [#276](https://github.com/marcusrbrown/infra/pull/276), [#277](https://github.com/marcusrbrown/infra/pull/277), [#278](https://github.com/marcusrbrown/infra/pull/278)
- Release: [`@marcusrbrown/infra@0.4.11`](https://www.npmjs.com/package/@marcusrbrown/infra/v/0.4.11) ships the Wave 5 fix
- [../integration-issues/docker-network-stale-subnet-cleanup-2026-06-18.md](../integration-issues/docker-network-stale-subnet-cleanup-2026-06-18.md) — same deploy path; stale Docker network IPAM state blocks compose up after an explicit-subnet topology change, requiring a pull-before-cleanup migration step.
