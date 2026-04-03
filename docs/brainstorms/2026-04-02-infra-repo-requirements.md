---
date: 2026-04-02
topic: infra-repo
---

# Personal Infrastructure Repository

## Problem Frame

Marcus manages personal infrastructure (self-hosted sites, cloud services, deploy configs) across multiple servers with manual scripts scattered in various repos. Deploy scripts, configs, and operational knowledge lack a single source of truth. Changes are manual and unauditable — the KeeWeb deploy hadn't been updated since Dec 2018.

The `marcusrbrown/infra` repo consolidates infrastructure management into a public, version-controlled, CI-automated workspace.

## Requirements

- R1. **Bun workspace monorepo** — TypeScript-based, Bun-managed workspace at `marcusrbrown/infra`. Public repo.
- R2. **KeeWeb deployment as first app** — Migrate the existing KeeWeb v1.18.7 deploy artifacts (deploy.sh, config template, nginx config, static files) into the repo as the initial `apps/keeweb/` package.
- R3. **GitHub Actions CI/CD** — Automated deployment pipeline that:
  - R3a. Triggers on push to main (auto-deploy changed apps)
  - R3b. Supports manual `workflow_dispatch` with app selection
  - R3c. Constructs `config.json` from GitHub Actions secrets at CI time using `jq`
  - R3d. Deploys to `box.heatvision.co` via SSH/rsync using `webfactory/ssh-agent`
  - R3e. Runs `nginx -t` and reloads nginx after config changes
- R4. **Security through secrets only** — All configs, hostnames, server paths, and domain names are public. Only actual secrets (Dropbox app secret, SSH private key) stored as GitHub Actions secrets. No SOPS/age for initial version.
- R5. **Bash deploy scripts initially** — Keep the working `deploy.sh` as-is. TypeScript wrappers added incrementally as complexity justifies.
- R6. **Reusable workflow structure** — The deploy workflow should be structured to support adding more apps/services later without duplicating CI config.

## Success Criteria

- Push to main with a change in `apps/keeweb/` triggers an automated deploy to `kw.igg.ms` that matches the current manual deploy behavior
- Manual workflow dispatch can deploy KeeWeb on demand
- `config.json` is never committed with the real Dropbox secret — constructed from secrets at CI time
- The repo structure clearly supports adding a second app without restructuring

## Scope Boundaries

- **In scope**: KeeWeb deploy automation, repo scaffolding, GitHub Actions CI/CD, basic documentation
- **Not in scope (yet)**: SOPS/age encryption, Bun Shell migration of deploy scripts, Pulumi/Terraform, monitoring, additional services beyond KeeWeb
- **Not in scope (ever for v1)**: Docker/container orchestration, Kubernetes, Ansible

## Key Decisions

- **Package manager: Bun** — Diverges from Marcus's pnpm convention, but this repo has different needs (infra scripts, not publishable packages). Bun's speed and Shell API are advantages here.
- **Public repo, secrets-only security** — Hostnames, paths, nginx configs are not secrets. Actual secrets stay in GitHub Actions. Simple, auditable.
- **Bash first, TS later** — YAGNI. The deploy.sh works. Convert when a second service makes the bash approach painful.
- **GitHub secrets over SOPS** — One secret (Dropbox app secret) doesn't justify encrypted-secrets-in-git tooling. Re-evaluate when adding more services.
- **Auto-deploy + manual dispatch** — Push to main for normal flow. Manual dispatch for emergency or selective deploys.

## Dependencies / Assumptions

- SSH access to `box.heatvision.co` as root (or configured deploy user)
- Mail-In-A-Box serves static sites from `/home/user-data/www/<domain>/` and includes `/home/user-data/www/<domain>.conf` inside its auto-generated server blocks
- GitHub Actions runner has access to SSH the server (no IP allowlist blocking)
- Existing KeeWeb deploy artifacts in `~/src/github.com/keeweb/keeweb/deploy/` are the source of truth

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] Should `@bfra.me` shared configs (eslint, tsconfig, prettier) be used, or is this repo lightweight enough for standalone config?
- [Affects R2][Technical] How should the KeeWeb static files (1.6MB index.html, icons, splash screens) be stored — committed to git, downloaded at CI from KeeWeb releases, or git LFS?
- [Affects R3][Technical] What's the right path detection strategy for auto-deploy — `dorny/paths-filter` action, native GitHub `paths:` filter, or custom script?
- [Affects R6][Needs research] Should the reusable workflow use `workflow_call` (called by per-app workflows) or a matrix strategy with app detection?

## Next Steps

→ `/ce:plan` for structured implementation planning
