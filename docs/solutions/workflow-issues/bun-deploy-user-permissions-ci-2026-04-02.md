---
title: "Bun CI deploy with non-root user: permission fixes for rsync, backups, and postinstall"
date: 2026-04-02
problem_type: workflow_issue
component: development_workflow
root_cause: incomplete_setup
resolution_type: config_change
severity: high
tags: [bun, ci, deploy, rsync, permissions, simple-git-hooks, github-actions, mail-in-a-box]
module: apps/keeweb
files_changed:
  - .github/workflows/deploy.yaml
  - apps/keeweb/deploy.sh
  - apps/keeweb/server/setup-deploy-user.ts
commits: [5d470d7, 77fbcbc, 05acf87]
---

# Bun CI deploy with non-root user: permission fixes

## Problem

First CI deploy of KeeWeb from GitHub Actions to a Mail-In-A-Box server failed 3 times due to permission issues with a dedicated `deploy-kw` user replacing root SSH access.

## Symptoms

1. **`bun install` fails in CI**: `ENOENT: no such file or directory, stat 'node_modules/.bun/simple-git-hooks@2.13.1/package.json'`
2. **Backup step fails**: `cp: cannot create directory '/home/user-data/www/kw.igg.ms.bak.20260403': Permission denied`
3. **rsync fails on subdirectories**: `rsync: [receiver] mkstemp "icons/.android-chrome-192x192.png.wiZzEa" failed: Permission denied (13)` and `rsync: [generator] failed to set times on ".": Operation not permitted (1)`

## What Didn't Work

- `bun install` without flags — triggers simple-git-hooks postinstall which can't find its own package.json in Bun's `.bun/` cache structure
- Backing up to `/home/user-data/www/` — owned by `user-data:root` (755), deploy user can't write there
- `chmod -R 755` in the activation script — strips group-write bit that the deploy user (member of `www-data` group) needs for rsync
- `rsync -avz` — the `-a` flag (archive) tries to preserve timestamps and permissions, which requires ownership the deploy user doesn't have

## Solution

### Fix 1: Skip postinstall in CI

```yaml
# Before
- name: Install dependencies
  run: bun install

# After
- name: Install dependencies
  run: bun install --frozen-lockfile --ignore-scripts
```

Git hooks are irrelevant on CI runners. `--ignore-scripts` skips simple-git-hooks' postinstall entirely. `--frozen-lockfile` enforces reproducibility.

### Fix 2: Backup to deploy user's home

```bash
# Before — writes to parent dir deploy-kw can't access
cp -a "$SITE_DIR" "${SITE_DIR}.bak.$(date +%Y%m%d)"

# After — writes to deploy-kw's own directory
BACKUP_DIR="/home/${REMOTE_USER}/backups"
mkdir -p "$BACKUP_DIR"
rsync -a "$SITE_DIR/" "$BACKUP_DIR/kw.igg.ms.$(date +%Y%m%d%H%M)/"
```

### Fix 3: Group-writable permissions + safe rsync flags

**Activation script** (runs as root via sudo):

```bash
# Before — strips group-write
chmod -R 755 "$SITE_DIR"
chmod g+ws "$SITE_DIR"

# After — preserves group-write on all files and dirs
chmod -R 775 "$SITE_DIR"
find "$SITE_DIR" -type d -exec chmod g+s {} +
```

**rsync in deploy.sh**:

```bash
# Before — tries to set times/perms (requires ownership)
rsync -avz --delete ...

# After — skip timestamp and permission operations
rsync -rlvz --delete --no-times --no-perms ...
```

## Why This Works

- **Bun's `.bun/` cache** uses a different module structure than Node's `node_modules/`. simple-git-hooks' postinstall walks up the directory tree looking for its own `package.json` and fails on the non-standard path. Skipping scripts avoids this entirely — hooks serve no purpose in CI.
- **775 permissions** (rwxrwxr-x) keep the group-write bit so any user in the `www-data` group can create and modify files. The `g+s` (setgid) flag on directories ensures new files and subdirectories inherit the `www-data` group, not the creating user's primary group.
- **`--no-times --no-perms`** tells rsync to skip operations that require file ownership. The activation script (running as root via sudo) handles final ownership and permissions after rsync completes.

## Prevention

- **Test CI with dedicated deploy users before going live.** Permission issues only surface when running as non-root — local testing as root masks them.
- **Never use `chmod -R 755` on shared directories** where multiple users need write access. Use 775 + setgid instead.
- **Always use `--ignore-scripts` in CI installs** for Bun projects with simple-git-hooks (or husky). Git hooks are a local-development concern.
- **Audit rsync flags when deploying as non-root.** The `-a` (archive) flag implies `-rlptgoD` which includes `-t` (times) and `-p` (perms) — both require ownership. Use explicit flags instead: `-rlvz --no-times --no-perms`.
- **Separate ownership concerns**: let rsync handle file content delivery, let a root-owned activation script handle ownership/permissions.
