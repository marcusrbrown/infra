---
title: 'CLIProxyAPI first deploy: 4-failure cascade from lockfile to auth-dir'
problem_type: workflow_issue
component: development_workflow
root_cause: incomplete_setup
resolution_type: config_change
severity: high
date: 2026-04-06
tags: [cliproxy, docker, digitalocean, deploy, ssh, host-keys, env-vars, lockfile, auth-dir]
module: apps/cliproxy
related_issues: []
related_docs:
  - docs/solutions/workflow-issues/bun-deploy-user-permissions-ci-2026-04-02.md
---

# CLIProxyAPI First Deploy: 4-Failure Cascade

## Problem

CLIProxyAPI's first deployment required 4 sequential fixes across 5 PRs before the Docker Compose stack (Caddy reverse proxy + cli-proxy-api container) became operational on a DigitalOcean droplet. Each fix unblocked the next failure, creating a cascade.

## Symptoms

Each failure presented a distinct error at a different layer:

1. **CI install** (PR #23): `bun.lock had changes, but lockfile is frozen`
2. **Deploy script** (post-merge): `CLIPROXY_HOST is required for deploy`
3. **SSH** (post-merge): `Host key verification failed`
4. **HTTP** (post-merge): `502 Bad Gateway` — container log: `failed to create auth directory : mkdir : no such file or directory`

## What Didn't Work

- Initial plan assumed all config would work on first deploy — no dry-run or smoke test caught the cascade before CI
- Provisioning script used `ssh-keyscan -H` (hashed mode) keyed to the droplet IP, but CI connects by domain name — hashed entries only match the exact string they were hashed against
- `CLIPROXY_HOST` env var was unnecessary indirection — the domain IS the host for a single-droplet deployment
- Docker volume mount (`cliproxy_auth:/root/.cli-proxy-api`) alone is insufficient — CLIProxyAPI requires an explicit `auth-dir` field in `config.yaml` to know where to store OAuth tokens

## Solution

### Fix 1: Stale lockfile

Run `bun install` after adding the new `apps/cliproxy` workspace member, then commit the updated `bun.lock`. CI uses `--frozen-lockfile` which correctly rejects stale lockfiles.

### Fix 2: Wrong env var name (PR #37)

Eliminated `CLIPROXY_HOST` entirely. Consolidated to `CLIPROXY_DOMAIN` in:
- `apps/cliproxy/src/deploy.ts` (env interface + validation)
- `.github/workflows/deploy.yaml` (env block)
- `packages/cli/src/commands/cliproxy-deploy.ts` (CLI env allowlist)
- `packages/cli/src/commands/cliproxy-login.ts` (fallback env var)
- All test files and snapshots

One name, one secret, zero confusion.

### Fix 3: Hashed host keys (PR #38)

Added unhashed domain-name entries to `.github/known_hosts`:

```
cliproxy.fro.bot ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
cliproxy.fro.bot ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTI...
cliproxy.fro.bot ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB...
```

Fixed `provision-droplet.ts` to pin both domain-name keys (for CI) and hashed IP keys (for local use):

```typescript
// Pin unhashed domain-name keys (for CI, which connects by domain)
const domainKeys = await runCapture(local(['ssh-keyscan', CLIPROXY_DOMAIN]))
// Pin hashed IP keys (for local provisioning)
const ipKeys = await runCapture(local(['ssh-keyscan', '-H', dropletIp]))
```

### Fix 4: Missing auth-dir (PR #39)

Added one line to `apps/cliproxy/config/config.yaml`:

```yaml
auth-dir: /root/.cli-proxy-api
```

This matches the Docker volume mount path in `docker-compose.yaml`:

```yaml
volumes:
  - cliproxy_auth:/root/.cli-proxy-api
```

## Why This Works

Each fix addressed a specific gap between the plan and reality:

- **Lockfile**: CI's `--frozen-lockfile` is a correctness guard — it correctly rejected the stale lockfile. The fix is to always update the lockfile when workspace membership changes.
- **Env var**: Single source of truth eliminates naming confusion between plan, code, and GitHub secrets. The conceptual separation of "host" vs "domain" was premature abstraction for a single-droplet deployment.
- **Host keys**: SSH matches `known_hosts` entries by the exact hostname string used in the connection. `ssh-keyscan -H` hashes against the argument given (the IP), so entries only match connections to that IP — not the domain that resolves to it.
- **Auth-dir**: CLIProxyAPI's Go code calls `os.MkdirAll(config.AuthDir, 0700)`. When `auth-dir` is missing from config, the path is empty string → `mkdir ""` → `ENOENT`.

## Prevention

### For new workspace members

Always run `bun install` and commit `bun.lock` after adding a `package.json` to a Bun workspace. CI's `--frozen-lockfile` will catch this, but it's faster to catch it locally.

### For environment variables

Use one canonical name for each secret. Don't create aliases (`CLIPROXY_HOST` vs `CLIPROXY_DOMAIN`). If the domain IS the SSH target, use one name. Add a second only when there's a real use case for them to differ.

### For SSH host key pinning

Always pin keys by domain name (unhashed) when CI connects by domain:

```bash
# For CI (connects by domain name)
ssh-keyscan cliproxy.fro.bot >> .github/known_hosts

# For local scripts (may connect by IP)
ssh-keyscan -H 147.182.133.210 >> .github/known_hosts
```

Never use `ssh-keyscan -H domain.com` — the hashed entry will match `domain.com` but that defeats the purpose of hashing (which is to hide the hostname). Use unhashed for domain entries, hashed for IP entries.

### For Docker app configuration

Volume mounts provide storage. The app must be configured to USE that storage path. Read the app's config reference or check startup logs before assuming a volume mount is sufficient.

### First deploy checklist for new apps

- [ ] `bun install` run and `bun.lock` committed
- [ ] Env var names in workflow match GitHub secret names exactly
- [ ] Host keys pinned by domain name (unhashed) in `.github/known_hosts`
- [ ] App config references all volume mount paths explicitly
- [ ] Health check in deploy script validates end-to-end (not just SSH success)
- [ ] GitHub Environment created with required reviewers + branch policy

## Related

- [KeeWeb deploy cascade](bun-deploy-user-permissions-ci-2026-04-02.md) — similar pattern of sequential deploy failures during first deployment of a different app in the same monorepo
