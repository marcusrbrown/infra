# Dashboard Released Image Rollback

The dashboard image is pinned by tag and digest in `apps/dashboard/docker-compose.yaml`. Renovate
opens PRs to bump the pin when a new `ghcr.io/fro-bot/dashboard` release is published; merging
triggers the Deploy Dashboard workflow, which pulls the new digest and ships it to the droplet.

This runbook covers rolling back to a prior image digest when a release is bad. For the deploy flow
and anti-patterns, see [`apps/dashboard/AGENTS.md`](../../apps/dashboard/AGENTS.md).

---

## Why This Exists

The compose pin is the single source of truth for which image version runs on the droplet. Rolling
back means reverting the compose pin commit to restore the prior digest, then deploying. There is no
separate override file or runtime flag — the compose file is the contract.

---

## When to Use

- A newly deployed image causes errors, crashes, or health-check failures on `dashboard.fro.bot`.
- `https://dashboard.fro.bot/api/healthz` returns non-200 after a Renovate bump deploy.
- `infra dashboard status` shows the `dashboard` container unhealthy or restarting.
- `infra dashboard logs dashboard` reveals a regression introduced by the new release.

---

## Procedure

### Step 1: Identify the prior digest

Find the commit that last changed the image pin in `apps/dashboard/docker-compose.yaml`:

```bash
git log --oneline -- apps/dashboard/docker-compose.yaml
```

Identify the commit immediately before the bad bump. Inspect it to confirm the prior digest:

```bash
git show <prior-commit>:apps/dashboard/docker-compose.yaml | grep 'image:.*dashboard'
```

Note the full image reference, e.g.:
`ghcr.io/fro-bot/dashboard:2026.06.14@sha256:abc123…`

### Step 2: Revert the compose pin commit

Create a revert commit targeting the bad bump:

```bash
git revert <bad-bump-commit> --no-edit
```

Verify the compose file now contains the prior digest:

```bash
grep 'image:.*dashboard' apps/dashboard/docker-compose.yaml
```

Confirm it matches the digest from Step 1.

### Step 3: Push and open a PR

```bash
git push origin HEAD
```

Open a PR against `main`. Title it clearly, e.g.:
`revert: roll back dashboard image to <prior-tag> (regression in <bad-tag>)`

### Step 4: Merge and deploy

Merge the PR. The Deploy Dashboard workflow triggers automatically on merge to `main`.

Approve the `dashboard` environment gate in the GitHub Actions UI. The deploy pulls the reverted
digest and ships it to the droplet.

### Step 5: Verify

```bash
bunx @marcusrbrown/infra dashboard status
```

Confirm both `dashboard` and `caddy` services are healthy.

Probe the public endpoint:

```bash
curl -sf https://dashboard.fro.bot/api/healthz
```

Expect HTTP 200. If Caddy ACME renewal is in progress, retry after 60 seconds.

Check logs for errors:

```bash
bunx @marcusrbrown/infra dashboard logs dashboard --tail 50
```

---

## Edge Cases

### The bad release is the first known digest

If the bad release is the first time the dashboard was deployed (no prior digest in git history),
there is no compose pin to revert to. Options:

1. **Pin a specific prior tag manually.** Browse `ghcr.io/fro-bot/dashboard` releases (GitHub
   Packages UI or `gh api /orgs/fro-bot/packages/container/dashboard/versions`) to find a known-good
   release. Update the `image:` line in `apps/dashboard/docker-compose.yaml` with the tag and digest
   of that release, commit, PR, merge, and deploy.

2. **Wait for a fixed upstream release.** If the upstream `fro-bot/dashboard` repo is actively
   fixing the regression, wait for a new release and let Renovate open the bump PR normally.

### The revert conflicts

If the compose file has been modified since the bad bump (e.g., a config tweak landed on top of it),
`git revert <bad-bump-commit> --no-edit` will stop with a merge conflict. Two options:

**Option A — staged revert, resolve manually:**

```bash
git revert <bad-bump-commit> --no-commit
```

This stages the revert but leaves conflicts in the working tree. Open
`apps/dashboard/docker-compose.yaml`, resolve the conflict markers so the `image:` line contains the
prior digest (from Step 1), then:

```bash
git add apps/dashboard/docker-compose.yaml
git revert --continue
```

**Option B — direct edit (faster during an active incident):**

If resolving the conflict is slower than the situation allows, edit the `image:` line directly:

```bash
# Set the image line to the known-good tag@digest identified in Step 1
$EDITOR apps/dashboard/docker-compose.yaml
```

Commit with a clear message:

```bash
git add apps/dashboard/docker-compose.yaml
git commit -m "fix: roll back dashboard image to <prior-tag> (regression in <bad-tag>)"
```

Then continue from Step 3. This is acceptable when it is clearer or faster than resolving the revert
conflict — the compose file is the contract; how the commit is authored is secondary.

### A newer release exists and is known-good

If a newer release has already shipped and is known-good, prefer bumping forward to that release
rather than reverting backward. Update the compose pin to the newer digest, commit, PR, merge, and
deploy. This avoids re-introducing the regression window.

---

## Related

- [`apps/dashboard/AGENTS.md`](../../apps/dashboard/AGENTS.md) — deploy flow, secret rotation, container hardening, anti-patterns
- [`apps/dashboard/README.md`](../../apps/dashboard/README.md) — quick-start, secrets table, CLI reference
- [`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`](../solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md) — SSH key trailing-newline and ControlMaster lessons (apply to dashboard deploy)
