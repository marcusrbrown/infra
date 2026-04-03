# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-02
**Commit:** c342666
**Branch:** main

## OVERVIEW

Bun workspace monorepo for personal infrastructure — currently KeeWeb deploy automation + CLI scaffold. Deploys static sites to `box.heatvision.co` via SSH/rsync.

## STRUCTURE

```text
├── apps/keeweb/        KeeWeb deploy package (see apps/keeweb/AGENTS.md)
├── packages/cli/       @marcusrbrown/infra CLI stub (single file, no framework yet)
├── docs/               Brainstorms → plans → solutions (compound learning)
├── .github/            Workflows, pinned host keys, Renovate config, repo settings
└── .opencode/          OpenCode slash commands (generate-readme)
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add new app | `apps/<name>/` | Copy keeweb structure, add to workspace |
| Add CLI command | `packages/cli/src/cli.ts` | Plain arg parsing, no framework |
| Add workflow | `.github/workflows/` | Use `.yaml` extension, SHA-pin all actions |
| Configure ESLint | `eslint.config.ts` | Flat config via `@bfra.me/eslint-config` |
| Configure TypeScript | `tsconfig.json` | Extends `@bfra.me/tsconfig`, Bun types |
| Renovate config | `.github/renovate.json5` | Extends `marcusrbrown/renovate-config` |
| Repo settings | `.github/settings.yml` | Synced by `bfra-me/.github` reusable workflow |
| OpenCode commands | `.opencode/commands/` | Markdown slash commands |
| Document solved problem | `docs/solutions/` | Compound learning with YAML frontmatter |

## CONVENTIONS

- **Only bash script**: `apps/keeweb/deploy.sh`. All other scripts are TypeScript run via `bun run`.
- **GitHub Actions**: `.yaml` extension (not `.yml`). SHA-pin all actions with `# vX.Y.Z` version comment.
- **Shared configs**: `@bfra.me/eslint-config`, `@bfra.me/prettier-config/120-proof`, `@bfra.me/tsconfig`.
- **Git hooks**: `simple-git-hooks` + `lint-staged` → `eslint --fix` on commit.
- **CI install**: `bun install --frozen-lockfile --ignore-scripts` (skip simple-git-hooks postinstall).
- **Cross-org reusable workflows**: Pass secrets explicitly (never `secrets: inherit` with `bfra-me/.github`).
- **Workspace commands**: Run app scripts with `bun run --cwd apps/<name> <script>`, not from root.
- **No tests yet**: CI checks lint + typecheck only.

## ANTI-PATTERNS (THIS PROJECT)

- **No `as any` / `@ts-ignore` / `@ts-expect-error`** — fix the types.
- **No secret values in tracked files** — `config/config.json` template has empty `dropboxSecret`; real value injected at build time from env var.
- **Never modify `config/config.json` in CI** — secret goes into `dist/config.json` only.
- **Never use `ssh-keyscan`** — host keys pinned in `.github/known_hosts`.
- **Never `secrets: inherit`** with cross-org reusable workflows.

## UNIQUE STYLES

- Download-based build: KeeWeb v1.18.7 release zip cached in `.cache/`, `dist/` rebuilt every run (source build infeasible — 2017-era tooling).
- Deploy separation: content-only by default, `--nginx` flag for config deploy (requires explicit flag + environment approval).
- Scoped deploy user: `deploy-kw` on server has write access to site dir only + sudo for single activation script.
- `bun.lock` (text format) committed for reproducible CI; `bun.lockb` (binary) is not used.

## COMMANDS

```bash
bun install                                    # Install dependencies
bun run lint                                   # ESLint check
bun run fix                                    # ESLint --fix (includes Prettier)
bunx tsc --noEmit                              # Type check
bun run --cwd apps/keeweb build                # Build KeeWeb dist
bash apps/keeweb/deploy.sh                     # Deploy content only
bash apps/keeweb/deploy.sh --nginx             # Deploy content + nginx config
bun run apps/keeweb/server/setup-deploy-user.ts # Provision deploy user on server
bun run packages/cli/src/cli.ts --help         # CLI usage
```

## NOTES

- `DROPBOX_APP_SECRET` and `DEPLOY_SSH_KEY` are GitHub Actions secrets scoped to `production` environment. `APPLICATION_ID` and `APPLICATION_PRIVATE_KEY` are repo-level secrets.
- Deploy target: `box.heatvision.co` (Mail-In-A-Box server). Site path: `/home/user-data/www/kw.igg.ms/`.
- Activation script on server (`/usr/local/bin/kw-deploy-activate`) sets permissions to 775 with setgid to preserve group-write for deploy user.
- `dorny/paths-filter@v3` used for change detection because native `paths:` breaks `workflow_dispatch`. Deploy condition: `workflow_dispatch || keeweb-changed`.
