---
title: "feat: Migrate KeeWeb deploy to infra repo with CI/CD"
type: feat
status: active
date: 2026-04-02
origin: docs/brainstorms/2026-04-02-infra-repo-requirements.md
deepened: 2026-04-02
reviewed: 2026-04-02
---

# feat: Migrate KeeWeb deploy to infra repo with CI/CD

## Overview

Scaffold the `marcusrbrown/infra` Bun workspace monorepo, create a KeeWeb app package that downloads and customizes the v1.18.7 release from GitHub, harden the deploy target with a dedicated user and pinned host key, scaffold a CLI package structure for future infrastructure management, and create a GitHub Actions pipeline with environment protection that deploys to `kw.igg.ms` on push to main.

## Problem Frame

KeeWeb deploy scripts and artifacts live in a separate checkout with no version control, no CI/CD, and a hardcoded Dropbox secret in `config.json`. The `infra` repo consolidates infrastructure management into a public, auditable, CI-automated workspace with publish-ready package structure for future reuse. (see origin: docs/brainstorms/2026-04-02-infra-repo-requirements.md)

## Requirements Trace

- R1. **Bun workspace monorepo** — TypeScript-based, Bun-managed workspace at `marcusrbrown/infra`. Public repo. Package prefix `@marcusrbrown/infra`.
- R2. **KeeWeb deployment as first app** — Download KeeWeb v1.18.7 web release from GitHub, customize config, deploy. Package: `@marcusrbrown/infra-keeweb`.
- R3. **GitHub Actions CI/CD** — Auto-deploy on push (R3a), manual dispatch (R3b), config.json constructed from secrets at build time (R3c), SSH/rsync deploy via webfactory/ssh-agent (R3d), nginx -t + reload (R3e).
- R4. **Security through secrets only** — Only Dropbox app secret + SSH key as GitHub secrets. Deploy secrets scoped to a protected GitHub Environment.
- R5. **Bash deploy scripts initially** — Keep the working `deploy.sh` as the deploy entry point. (Preserved from origin R5.)
- R5a. **Bun build/download script** — TypeScript script to download release asset, extract, customize config with secret injection, produce deploy-ready `dist/` output. (Derived from R2, extends scope beyond origin R5's bash-first constraint.)
- R6. **Reusable workflow structure** — Supports adding more apps without restructuring.
- R7. **CLI package scaffold** — `@marcusrbrown/infra` as a minimal CLI entry point for future infrastructure management.
- R8. **Publish-ready package structure** — Package naming, directory layout, and `package.json` fields structured so packages *can* be published to npm when ready. Does NOT include first-pass publishing. (Amended from origin: reworded to mean structure, not capability.)

## Scope Boundaries

- **In scope**: KeeWeb deploy automation, repo scaffolding, GitHub Actions CI/CD, server-side deploy hardening, minimal CLI scaffold, minimal documentation
- **Not in scope (yet)**: SOPS/age encryption, Docker-based KeeWeb source build, monitoring, additional services
- **Not in scope (explicitly fenced)**:
  - Real CLI commands beyond stub help text
  - CLI framework adoption (Boune, Commander, Citty) — deferred to when real commands are needed
  - npm publishing, versioning, or release automation
  - Registry credentials, tokens, or `publishConfig` setup
  - Docker/container orchestration, Kubernetes, Ansible
  - Building KeeWeb from source (uses release asset)

## Context & Research

### Relevant Code and Patterns

**KeeWeb GitHub Release** (`v1.18.7`, July 2021):
- `KeeWeb-1.18.7.html.zip` (7.1MB) — pre-built web/static SPA with icons, OAuth callbacks, manifests
- Contents match the current deployed files 1:1 (verified by extracting and comparing)
- Release includes `Verify.sha256` for integrity checking
- Download URL: `https://github.com/keeweb/keeweb/releases/download/v1.18.7/KeeWeb-1.18.7.html.zip`

**Why not build from source**: KeeWeb v1.18.7 uses 2017-era tooling (Babel 6, node-sass requiring Python 2.7, Grunt, Webpack 2). Building on modern systems/CI is extremely fragile. The release asset is the exact same output, deterministic and reliable.

**Source deploy.sh** (`~/src/github.com/keeweb/keeweb/deploy.sh`):
- SSH/rsync deploy to box.heatvision.co with backup, nginx -t, reload
- Uses `set -euo pipefail`, validates required files exist
- Expects `deploy/` directory relative to script location

**Bun CLI ecosystem (researched)**:
- **Boune** (boune.dev) — Bun-native CLI framework, batteries-included. Newest option.
- **Commander** — Battle-tested, works with Bun. Most common.
- **Citty** (unjs) — Lightweight, subcommand support.
- Bun supports `bin` field with `#!/usr/bin/env bun` shebang for direct TS execution.

**Server details**:
- Host: `box.heatvision.co` (Mail-In-A-Box, Ubuntu)
- SSH as `deploy-kw` (dedicated deploy user, provisioned — see Unit 5)
- Site at `/home/user-data/www/kw.igg.ms/`
- Nginx config at `/home/user-data/www/kw.igg.ms.conf`

### External References

- KeeWeb v1.18.7 release: https://github.com/keeweb/keeweb/releases/tag/v1.18.7
- webfactory/ssh-agent v0.9.0: https://github.com/webfactory/ssh-agent
- dorny/paths-filter v3: https://github.com/dorny/paths-filter
- Bun workspaces: https://bun.sh/docs/install/workspaces
- Boune CLI framework: https://boune.dev/

## Key Technical Decisions

- **Download release asset, not build from source**: KeeWeb v1.18.7's build tooling (Python 2.7, node-sass, Grunt) is too fragile for modern CI. The release asset IS the build output. If source-level customization is ever needed, add a Docker-based build container later.

- **Package prefix `@marcusrbrown/infra`**: All packages use `@marcusrbrown/infra-*` naming. The CLI package is `@marcusrbrown/infra`. This enables future `bunx @marcusrbrown/infra` and scoped npm publishing.

- **Standalone config (no @bfra.me shared configs)**: This repo has different needs. Re-evaluate when TS complexity warrants it. (see origin)

- **dorny/paths-filter for change detection**: Native `paths:` doesn't work with `workflow_dispatch`. **Critical**: paths-filter returns `false` for all filters on `workflow_dispatch` — the deploy condition must be `github.event_name == 'workflow_dispatch'`. (see origin)

- **Single workflow, no app input for v1**: With only one app, a workflow_dispatch app selector does nothing useful. Remove it. Add app selection when a second app exists.

- **Secret injection directly into dist/, never mutate tracked files**: The build script reads `DROPBOX_APP_SECRET` from environment and writes it directly into `dist/config.json`. The tracked `config/config.json` always has an empty secret and is never modified by CI. This prevents accidental exposure in the workspace.

- **Cache the downloaded zip, always rebuild dist/**: The downloaded `KeeWeb-1.18.7.html.zip` is cached in `.cache/` to avoid repeated downloads. But `dist/` is rebuilt from scratch every run to ensure config changes and secret rotations are always reflected.

- **Dropbox "secret" is technically public**: KeeWeb serves `config.json` as a static file fetched by the browser. This is by design: KeeWeb uses Dropbox PKCE OAuth. We still inject at CI time to keep the credential out of git history and enable rotation.

- **Nginx config deployed separately from content**: deploy.sh handles content-only deploys by default. Nginx config changes require an explicit `--nginx` flag or separate trigger. This prevents routine content deploys from risking nginx breakage on the shared MIAB server. When nginx config IS deployed, deploy.sh backs up the existing config and auto-restores if `nginx -t` fails.

- **Pinned host key, not ssh-keyscan TOFU**: The host key for `box.heatvision.co` is stored in a file committed to the repo (or as a GitHub secret). The workflow uses this pinned key instead of runtime `ssh-keyscan`, eliminating the TOFU attack vector.

- **Dedicated deploy user with scoped sudo**: A `deploy-kw` user on the server can write only to the KeeWeb site directory and run a narrowly-scoped sudo wrapper for nginx validation/reload. This replaces root SSH access and limits blast radius.

- **GitHub Environment with required reviewers**: Deploy secrets (`DEPLOY_SSH_KEY`, `DROPBOX_APP_SECRET`) are scoped to a protected `production` GitHub Environment that requires manual approval. This adds an approval boundary between code push and production deploy.

- **CLI framework deferred**: Scaffolded with a minimal entry point. Framework choice deferred to implementation of real commands. (Explicitly fenced in Scope Boundaries.)

## Open Questions

### Resolved During Planning

- **@bfra.me shared configs?** → No. Standalone.
- **Static file storage?** → Downloaded from GitHub Releases at build time.
- **Path detection strategy?** → dorny/paths-filter@v3.
- **Reusable workflow structure?** → Single workflow, not workflow_call.
- **config.json templating approach?** → Build script injects secret from env var directly into dist/config.json.
- **Build from source vs release asset?** → Release asset.
- **CLI framework?** → Deferred. Scaffolded with plain TypeScript.
- **Root vs deploy user?** → Dedicated deploy user. Root SSH eliminated.
- **ssh-keyscan vs pinned key?** → Pinned host key in repo.
- **Nginx deploy strategy?** → Separated from content deploy. Explicit flag or trigger required.
- **App input on workflow_dispatch?** → Removed for v1. Add when second app exists.
- **GitHub Environment protection?** → Yes. Required reviewers on production environment.

### Deferred to Implementation

- **Exact CLI framework choice** — Boune, Commander, or Citty. Depends on actual CLI requirements.
- **Package publishing config** — `publishConfig`, `exports` field, npm access tokens. Needed when first package is ready.
- **SHA256 verification of release asset** — The build script should verify integrity, but exact implementation deferred.
- ~~**MIAB deploy user feasibility**~~ — **Resolved.** deploy-kw user created and verified on box.heatvision.co. All tests passed: site writes, activation script, nginx reload, security isolation.

## Implementation Units

- [ ] **Unit 1: Repository Scaffolding**

  **Goal:** Initialize git repo with Bun workspace config, pinned host key, gitignore, and license.

  **Requirements:** R1, R8

  **Dependencies:** None

  **Files:**
  - Create: `package.json` (root workspace, private)
  - Create: `.gitignore`
  - Create: `LICENSE`
  - Create: `README.md` (stub — fleshed out in Unit 7)
  - Existing: `.github/known_hosts` (pinned host keys — already committed)

  **Approach:**
  - `git init` the repo
  - Root `package.json`: `"name": "@marcusrbrown/infra-workspace"`, `"private": true`, `"workspaces": ["apps/*", "packages/*"]`
  - `.gitignore` covers: `node_modules/`, `.DS_Store`, `dist/`, `.cache/`, `*.local`, OS/IDE artifacts
  - MIT license
  - `.github/known_hosts` already exists with pinned ed25519, ecdsa, and rsa keys — do NOT regenerate via ssh-keyscan

  **Test scenarios:**
  - `bun install` succeeds from repo root

  **Verification:**
  - `bun install` exits 0
  - `.github/known_hosts` contains a valid host key entry

- [ ] **Unit 2: KeeWeb App Package — Structure and Config**

  **Goal:** Create the `@marcusrbrown/infra-keeweb` workspace package with config template, nginx config, and deploy script with content/nginx split.

  **Requirements:** R2, R4, R5

  **Dependencies:** Unit 1

  **Files:**
  - Create: `apps/keeweb/package.json`
  - Create: `apps/keeweb/config/config.json` (template with empty secret)
  - Create: `apps/keeweb/config/kw.igg.ms.conf` (nginx config)
  - Create: `apps/keeweb/deploy.sh` (adapted from source)

  **Approach:**
  - `apps/keeweb/package.json`: `"name": "@marcusrbrown/infra-keeweb"`, `"private": true`, scripts: `"build"`, `"deploy"`, `"deploy:nginx"`
  - `config/config.json`: exact structure from source but `dropboxSecret` set to `""` — never commit the real secret
  - `config/kw.igg.ms.conf`: copied from source deploy artifacts (public)
  - `deploy.sh` adapted from source with these changes:
    - `DEPLOY_DIR` resolves to `dist/` (build output)
    - **Content-only by default**: rsync site files, set permissions. Does NOT touch nginx config unless `--nginx` flag is passed.
    - **When `--nginx` is passed**: backup existing remote nginx config, scp new config, run `nginx -t`, auto-restore on failure, reload nginx only after successful test.
    - Uses `REMOTE_USER` env var (defaults to `deploy-kw`, not `root`)
    - Validates `dist/index.html` and `dist/config.json` exist before deploying

  **Test scenarios:**
  - `config/config.json` does NOT contain the real Dropbox secret
  - `deploy.sh` validates with `bash -n apps/keeweb/deploy.sh`
  - `deploy.sh` without `--nginx` does NOT touch nginx config
  - `deploy.sh --nginx` includes nginx backup/test/restore logic

  **Verification:**
  - `grep -rP 'dropboxSecret.*[^\"]{2,}' apps/` confirms no real secret values present
  - `bash -n apps/keeweb/deploy.sh` exits 0
  - Package recognized in workspace

- [ ] **Unit 3: KeeWeb Build Script (Bun/TypeScript)**

  **Goal:** Create a Bun/TypeScript script that downloads the KeeWeb v1.18.7 release, extracts it, and produces a deploy-ready `dist/` with injected config.

  **Requirements:** R2, R5a

  **Dependencies:** Unit 2

  **Files:**
  - Create: `apps/keeweb/src/build.ts`

  **Approach:**
  - TypeScript script using Bun APIs (`Bun.spawn`, `Bun.file`, `Bun.write`)
  - **Download step**: Fetch `KeeWeb-1.18.7.html.zip` from GitHub Releases via `fetch`. Cache to `.cache/keeweb-1.18.7.html.zip` — skip download if cached zip exists with matching filename.
  - **Extract step**: Clear and recreate `dist/` every run (ensures fresh output). Extract zip contents into `dist/`.
  - **Config step**: Read `config/config.json`, inject `DROPBOX_APP_SECRET` from `process.env` into `.settings.dropboxSecret` (empty string if env var not set), write result to `dist/config.json`. The tracked `config/config.json` is NEVER modified.
  - **Nginx config step**: Copy `config/kw.igg.ms.conf` to `dist/kw.igg.ms.conf`
  - KeeWeb version as a constant at top of file — easy to change for upgrades
  - The `build` script in package.json: `"build": "bun run src/build.ts"`

  **Patterns to follow:**
  - Bun's native `fetch` for downloads
  - Structured error handling with clear error messages
  - Idempotent: running build twice produces same result

  **Test scenarios:**
  - `bun run build` produces a `dist/` directory with all expected files
  - `dist/config.json` has `dropboxSecret: ""` when env var not set
  - `DROPBOX_APP_SECRET=test123 bun run build` produces `dist/config.json` with `dropboxSecret: "test123"`
  - Running build again is fast (cached zip, dist/ rebuilt from cache)
  - `config/config.json` is NEVER modified by the build

  **Verification:**
  - `bun run build` exits 0
  - `dist/` contains all expected files
  - `cat config/config.json | jq .settings.dropboxSecret` returns `""`
  - After build with secret: `cat dist/config.json | jq .settings.dropboxSecret` returns the injected value

- [ ] **Unit 4: CLI Package Scaffold**

  **Goal:** Create the `@marcusrbrown/infra` package with minimal CLI entry point and `bin` field.

  **Requirements:** R7, R8

  **Dependencies:** Unit 1

  **Files:**
  - Create: `packages/cli/package.json`
  - Create: `packages/cli/src/cli.ts`

  **Approach:**
  - `packages/cli/package.json`: `"name": "@marcusrbrown/infra"`, `"bin": { "infra": "src/cli.ts" }`, `"type": "module"`, `"private": true`
  - `src/cli.ts`: minimal entry point with `#!/usr/bin/env bun` shebang, parses first arg as subcommand, outputs help text
  - Stub only: `infra --help` shows available commands, `infra keeweb` shows placeholder
  - No CLI framework — plain arg parsing

  **Test scenarios:**
  - `bun run packages/cli/src/cli.ts --help` shows usage info
  - Package appears in `bun pm ls`

  **Verification:**
  - CLI entry point executes without errors

- [ ] **Unit 5: Server-Side Deploy Hardening**

  **Goal:** ~~Create a dedicated deploy user on box.heatvision.co with scoped access, replacing root SSH for CI deploys.~~ **SERVER-SIDE COMPLETE.** Remaining: store private key as GitHub secret in `production` environment.

  **Requirements:** R4

  **Dependencies:** None (server-side, independent of repo work)

  **Status:** ✅ Server provisioning done. deploy-kw user verified. All tests passed.

  **Files:**
  - Existing: `apps/keeweb/server/setup-deploy-user.ts` (Bun provisioning script — already created)

  **Approach:**
  - Create `deploy-kw` user on box.heatvision.co
  - Grant write access to `/home/user-data/www/kw.igg.ms/` only
  - Create a root-owned activation script (e.g., `/usr/local/bin/kw-deploy-activate`) that:
    - Copies candidate nginx config to live path
    - Runs `nginx -t`
    - Restores backup on failure
    - Reloads nginx on success
  - Add sudoers entry: `deploy-kw ALL=(root) NOPASSWD: /usr/local/bin/kw-deploy-activate`
  - Generate SSH key pair for `deploy-kw`, add public key to `~deploy-kw/.ssh/authorized_keys`
  - Store private key as `DEPLOY_SSH_KEY` GitHub secret (scoped to `production` environment)
  - **Fallback**: If MIAB's environment makes a non-root deploy user impractical, use root but restrict the key in `authorized_keys` with `command=` and `from=` options

  **Patterns to follow:**
  - Principle of least privilege
  - sudoers with NOPASSWD for specific command only
  - SSH forced command as fallback

  **Test scenarios:**
  - `deploy-kw` user can write to site directory
  - `deploy-kw` user CANNOT write to other MIAB paths
  - `sudo /usr/local/bin/kw-deploy-activate` works from `deploy-kw`
  - `deploy-kw` user cannot run arbitrary commands via SSH

  **Verification:**
  - SSH as deploy-kw + rsync to site dir succeeds
  - SSH as deploy-kw + attempt to read /etc/shadow fails
  - nginx activation script validates, reloads, and rolls back correctly

- [ ] **Unit 6: GitHub Actions Deploy Workflow**

  **Goal:** Create CI/CD pipeline with environment protection that builds and deploys KeeWeb on push to main, with manual dispatch support.

  **Requirements:** R3 (R3a–R3e), R4, R6

  **Dependencies:** Units 2, 3, 5

  **Files:**
  - Create: `.github/workflows/deploy.yaml`

  **Approach:**
  - **Triggers**: `push` to `main` branch + `workflow_dispatch` (no app input for v1)
  - **Path detection**: `dorny/paths-filter@v3` for push events. On `workflow_dispatch`, always deploy: `if: github.event_name == 'workflow_dispatch' || needs.detect-changes.outputs.keeweb == 'true'`
  - **Environment protection**: Deploy job runs in `production` GitHub Environment with required reviewers. Secrets scoped to this environment.
  - **Workflow permissions**: `permissions: contents: read` — minimal
  - **Job structure**:
    1. `detect-changes` job: runs paths-filter, outputs which apps changed
    2. `deploy-keeweb` job: conditional on changes OR manual dispatch, runs in `production` environment
  - **deploy-keeweb job steps**:
    1. Checkout repo via `actions/checkout@v4`
    2. Setup Bun via `oven-sh/setup-bun@v2`
    3. `bun install`
    4. `bun run build` in apps/keeweb/ with `DROPBOX_APP_SECRET` env var (downloads release, extracts, injects secret into dist/)
    5. Configure SSH using pinned host key from `.github/known_hosts` (NOT ssh-keyscan)
    6. Setup SSH agent via `webfactory/ssh-agent@v0.9.0` with `${{ secrets.DEPLOY_SSH_KEY }}`
    7. Run `bash apps/keeweb/deploy.sh` (content-only)
    8. **Conditionally** run `bash apps/keeweb/deploy.sh --nginx` only when `config/kw.igg.ms.conf` changed (detected by paths-filter sub-filter or separate check)
  - **Secrets** (scoped to `production` environment): `DEPLOY_SSH_KEY`, `DROPBOX_APP_SECRET`
  - **Host is public**: `box.heatvision.co` used directly in workflow.

  **Patterns to follow:**
  - `dorny/paths-filter@v3` with sub-filters for content vs nginx config
  - `webfactory/ssh-agent@v0.9.0` with pre-configured known_hosts
  - `actions/checkout@v4`, `oven-sh/setup-bun@v2`
  - GitHub Environment for deployment protection

  **Test scenarios:**
  - Workflow YAML is valid
  - Push with `apps/keeweb/` changes triggers deploy after environment approval
  - Push with only `docs/` changes does NOT trigger deploy
  - Manual dispatch always triggers deploy after environment approval
  - Content-only push does NOT trigger nginx config deploy
  - Change to `config/kw.igg.ms.conf` triggers nginx deploy step
  - Secret is injected by build script, not by modifying tracked files

  **Verification:**
  - Workflow parses as valid YAML
  - Path filter covers `apps/keeweb/**` with sub-filter for nginx config
  - Environment protection configured in GitHub repo settings
  - Build and deploy steps in correct order

- [ ] **Unit 7: Documentation**

  **Goal:** Write minimal README covering setup, build, deploy, and secrets.

  **Requirements:** R1

  **Dependencies:** Units 1–6

  **Files:**
  - Modify: `README.md`

  **Approach:**
  - Keep it minimal per origin scope ("basic documentation"):
    - Purpose (1-2 sentences)
    - Prerequisites (Bun)
    - Local Development: `bun install`, `bun run build`, `bash deploy.sh`
    - Required GitHub Actions Secrets and Environment setup
    - Repository structure (brief, not exhaustive tree)
  - Defer until second app or first publish: "Adding a New App", CLI usage, ADR links, package naming convention detail
  - Do NOT document real secret values

  **Test scenarios:**
  - README covers build and deploy flow
  - No secrets or sensitive values present

  **Verification:**
  - All referenced paths exist in the repo

## System-Wide Impact

- **Interaction graph:** The deploy workflow modifies files on `box.heatvision.co` via SSH. With the deploy user, blast radius is limited to the KeeWeb site directory. nginx changes require explicit approval (both the `--nginx` flag AND environment reviewers).
- **nginx config separated from content**: Routine content deploys cannot break nginx. Config changes go through a separate path with backup/test/restore. Even syntactically valid but wrong configs are risk-mitigated by requiring manual approval via GitHub Environment reviewers.
- **Error propagation:** deploy.sh uses `set -euo pipefail`. The remote site backup provides manual rollback. The nginx activation script handles its own rollback automatically.
- **State lifecycle risks:** Partial rsync failure could leave the site inconsistent. For a static SPA, worst case is broken UI until next deploy. Pre-deploy backup enables restoration.
- **MIAB regeneration interaction:** Verify `kw.igg.ms` is a MIAB-managed domain before first deploy. The `kw.igg.ms.conf` is included via MIAB's `local.conf` mechanism.
- **Build dependency on GitHub**: Download from GitHub Releases. If GitHub is unavailable, build fails. The cached zip in `.cache/` provides local resilience.

## Risks & Dependencies

- ~~**Deploy user feasibility on MIAB**~~: **Resolved.** deploy-kw user successfully created and tested on MIAB. No fallback needed.
- **nginx config as attack surface**: Even with separation, a targeted attack could modify the nginx config via the `--nginx` path. **Mitigation**: Environment approval required + backup/restore + separation from content deploys.
- **MIAB auto-regeneration**: MIAB regenerates nginx configs during updates. **Mitigation**: Verify domain ownership. Post-deploy health check: `curl -sI https://kw.igg.ms/ | grep -q 200`.
- **GitHub Release availability**: Build depends on downloading release asset. **Mitigation**: Cached zip in `.cache/`, low risk for stable 2021 release.
- **npm scope availability**: `@marcusrbrown` scope must be owned on npm. **Mitigation**: Verify before first publish. All packages `private: true` initially.
- **paths-filter base resolution**: Multi-commit pushes may miss changes. **Mitigation**: Set `base` to `github.event.before` if needed.

## Documentation / Operational Notes

- Before first CI deploy: verify `kw.igg.ms` is in MIAB's managed domains, set up deploy user (Unit 5), configure GitHub Environment.
- After first CI deploy: manually verify site loads, Dropbox OAuth works, .kdbx opens from Dropbox.
- Document required GitHub Actions secrets and Environment setup in README.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-02-infra-repo-requirements.md](docs/brainstorms/2026-04-02-infra-repo-requirements.md)
- Source deploy artifacts: `~/src/github.com/keeweb/keeweb/deploy/` and `deploy.sh`
- KeeWeb v1.18.7 release: https://github.com/keeweb/keeweb/releases/tag/v1.18.7
- webfactory/ssh-agent v0.9.0: https://github.com/webfactory/ssh-agent
- dorny/paths-filter v3: https://github.com/dorny/paths-filter
- Bun workspaces: https://bun.sh/docs/install/workspaces

## Target Repository Structure

```
marcusrbrown/infra/
├── .github/
│   ├── known_hosts                  ← pinned host key for box.heatvision.co
│   └── workflows/
│       └── deploy.yaml               ← protected by production Environment
├── apps/
│   └── keeweb/
│       ├── package.json             ← @marcusrbrown/infra-keeweb
│       ├── deploy.sh                ← bash deploy (content-only default, --nginx flag)
│       ├── src/
│       │   └── build.ts             ← Bun: download, extract, inject secret → dist/
│       ├── config/
│       │   ├── config.json          ← template (dropboxSecret: "", NEVER modified by CI)
│       │   └── kw.igg.ms.conf       ← nginx config (deployed only on explicit trigger)
│       ├── server/
│       │   └── setup-deploy-user.ts ← Bun: provisions deploy-kw user via SSH
│       ├── .cache/                  ← GITIGNORED — cached release zip
│       └── dist/                    ← GITIGNORED — built at CI time
├── packages/
│   └── cli/
│       ├── package.json             ← @marcusrbrown/infra (CLI stub)
│       └── src/
│           └── cli.ts               ← #!/usr/bin/env bun
├── docs/
│   ├── brainstorms/
│   │   └── 2026-04-02-infra-repo-requirements.md
│   └── plans/
│       └── 2026-04-02-001-feat-keeweb-deploy-migration-plan.md
├── package.json                     ← root workspace (private)
├── .gitignore
├── LICENSE                          ← MIT
└── README.md
```
