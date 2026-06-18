# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-13
**Commit:** 1331fda
**Branch:** main

## OVERVIEW

Bun workspace monorepo for personal infrastructure — KeeWeb deploy automation, CLIProxyAPI (Claude proxy) management, Fro Bot gateway deployment, Umami analytics, WireGuard VPN egress box, and operational CLI with MCP bridge. Deploys to `box.heatvision.co` (KeeWeb), `cliproxy.fro.bot` (CLIProxyAPI on DigitalOcean), `gateway.fro.bot` (Fro Bot gateway on DigitalOcean), `metrics.fro.bot` (Umami analytics on DigitalOcean), and a static IP on AWS Lightsail `eu-west-1` (WireGuard VPN).

## STRUCTURE

```text
├── apps/keeweb/        KeeWeb deploy package (see apps/keeweb/AGENTS.md)
├── apps/cliproxy/      CLIProxyAPI deploy package (see apps/cliproxy/AGENTS.md)
├── apps/gateway/       Fro Bot gateway deploy package (see apps/gateway/AGENTS.md)
├── apps/dashboard/     Fro Bot operator dashboard deploy package (see apps/dashboard/AGENTS.md)
├── apps/umami/         Umami analytics deploy package (see apps/umami/AGENTS.md)
├── apps/vpn/           WireGuard VPN egress box (see apps/vpn/AGENTS.md)
├── packages/cli/       @marcusrbrown/infra CLI (see packages/cli/AGENTS.md)
├── packages/shared/    Shared provisioning helpers (see packages/shared/AGENTS.md)
├── docs/               Brainstorms → plans → solutions (compound learning)
├── .changeset/         Changesets config for versioning
├── .agents/skills/     Agent skills (goke, etc.) — load before working with that domain
├── .github/            Workflows, pinned host keys, Renovate, Copilot instructions
└── .opencode/          OpenCode slash commands
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add new app | `apps/<name>/` | Copy keeweb structure, add to workspace |
| Add CLI command | `packages/cli/src/commands/` | goke command module, register in cli.ts |
| Check deploy health | `bunx @marcusrbrown/infra keeweb status` | HTTP, last deploy, content hash |
| Trigger deploy | `bunx @marcusrbrown/infra keeweb deploy` | Remote (default) or `--local` |
| Open KeeWeb | `bunx @marcusrbrown/infra keeweb open` | Opens in browser, fire-and-forget |
| Check proxy health | `bunx @marcusrbrown/infra cliproxy status` | HTTP, usage stats, version |
| List proxy models | `bunx @marcusrbrown/infra cliproxy models [provider]` | Models at /v1/models; filter to `anthropic` or `openai` |
| Manage proxy | `bunx @marcusrbrown/infra cliproxy config|keys|login` | Management API |
| Trigger proxy deploy | `bunx @marcusrbrown/infra cliproxy deploy` | Remote (default) or `--local` |
| Open proxy TUI | `bunx @marcusrbrown/infra cliproxy open` | SSH + interactive TUI |
| Onboard repo | `bunx @marcusrbrown/infra cliproxy setup` | Interactive wizard with @clack/prompts |
| Check gateway health | `bunx @marcusrbrown/infra gateway status` | SSH, docker compose ps, service states |
| Trigger gateway deploy | `bunx @marcusrbrown/infra gateway deploy` | Remote (default) or `--local` |
| Gateway operator docs | `apps/gateway/AGENTS.md` | Deploy flow, provisioning, CA restore, anti-patterns |
| Check dashboard health | `bunx @marcusrbrown/infra dashboard status` | SSH, docker compose ps, service states |
| Trigger dashboard deploy | `bunx @marcusrbrown/infra dashboard deploy` | Remote (default) or `--local` |
| Dashboard operator docs | `apps/dashboard/AGENTS.md` | Deploy flow, provisioning, image digest verification, anti-patterns |
| Check umami health | `bunx @marcusrbrown/infra umami status` | SSH, docker compose ps, service states |
| Trigger umami deploy | `bunx @marcusrbrown/infra umami deploy` | Remote (default) or `--local` |
| Umami operator docs | `apps/umami/AGENTS.md` | Deploy flow, admin rotation, DB-password runbook, privacy baseline |
| Check VPN health | `bunx @marcusrbrown/infra vpn status` | SSH, wg show wg0, interface state + server pubkey + peer count |
| Trigger VPN deploy | `bunx @marcusrbrown/infra vpn deploy` | Remote (default) or `--local`. `--force-server-key` rotates server key (invalidates all client configs). |
| Manage VPN peers | `bunx @marcusrbrown/infra vpn client add\|list\|remove` | CLI-only (mutating/sensitive) |
| VPN operator docs | `apps/vpn/AGENTS.md` | Deploy flow, provisioning, server-key invariants, anti-patterns |
| VPN runbook | `docs/runbooks/vpn-egress-box.md` | Bootstrap ordering, reprovision recovery, client onboarding, old-EC2 teardown |
| Unified status | `bunx @marcusrbrown/infra status` | All deployments, `--json` for machine output |
| Add workflow | `.github/workflows/` | Use `.yaml` extension, SHA-pin all actions |
| Configure ESLint | `eslint.config.ts` | Flat config via `@bfra.me/eslint-config` |
| Configure TypeScript | `tsconfig.json` | Extends `@bfra.me/tsconfig`, Bun types |
| Renovate config | `.github/renovate.json5` | Extends `marcusrbrown/renovate-config` |
| Repo settings | `.github/settings.yml` | Synced by `bfra-me/.github` reusable workflow |
| Copilot instructions | `.github/copilot-instructions.md` | References this file |
| OpenCode commands | `.opencode/commands/` | Markdown slash commands |
| Document solved problem | `docs/solutions/` | Compound learning with YAML frontmatter |
| Find operational runbook | `docs/runbooks/` | Operator-facing day-2 procedures (rotation, revocation, restore) |

## CONVENTIONS

- **Only bash script**: `apps/keeweb/deploy.sh`. All other scripts are TypeScript run via `bun run`. (enforced)
- **GitHub Actions**: `.yaml` extension (not `.yml`). SHA-pin all actions with `# vX.Y.Z` version comment. (enforced)
- **Shared configs**: `@bfra.me/eslint-config`, `@bfra.me/prettier-config/120-proof`, `@bfra.me/tsconfig`.
- **Git hooks**: `simple-git-hooks` + `lint-staged` → `eslint --fix` on commit.
- **CI install**: `bun install --frozen-lockfile --ignore-scripts` (skip simple-git-hooks postinstall).
- **Cross-org reusable workflows**: Pass secrets explicitly (never `secrets: inherit` with `bfra-me/.github`). (enforced)
- **Workspace commands**: Run app scripts with `bun run --cwd apps/<name> <script>`, not from root. Exception: `provision`/`deploy` need the repo-root `.env` (Bun loads `.env` from CWD only), so run them via the root wrappers `bun run provision:<app>` / `bun run deploy:<app>` (cliproxy, gateway, umami) instead of `--cwd`.
- **Changesets**: `@changesets/cli` for versioning. Renovate PRs get auto-generated changeset files.
- **Tests**: Colocated `*.test.ts` alongside source. Fixtures in `__fixtures__/`, snapshots in `__snapshots__/`. Use `NO_COLOR=1` in subprocess env for deterministic snapshots. Mock at boundaries (fetch, Bun.spawn), not internals. CI runs `bun test --recursive` as a parallel job alongside lint/type-check.
- **CI Node pin**: All workflows running `bun run lint` or `bunx tsc` must pin Node 24 via `actions/setup-node` — ESLint binary shebang uses system Node, which on ubuntu-latest is Node 20 (lacks ES2024 APIs like `Object.groupBy`).

## ANTI-PATTERNS (THIS PROJECT)

- **No `as any` / `@ts-ignore` / `@ts-expect-error`** — fix the types. (enforced)
- **No secret values in tracked files** — `config/config.json` template has empty `dropboxSecret`; real value injected at build time from env var. (enforced)
- **Never modify `config/config.json` in CI** — secret goes into `dist/config.json` only.
- **Never overwrite `config.yaml` on cliproxy server** — runtime API keys live there. Deploy skips upload when file exists; `--force-config` is the explicit override.
- **Never use `ssh-keyscan` in CI workflows** — host keys are pinned in `.github/known_hosts`. Provisioning scripts may use `ssh-keyscan` locally via the shared `pinHostKeys` helper in `packages/shared/server/droplet-helpers.ts`. (enforced)
- **Never `secrets: inherit`** with cross-org reusable workflows. (enforced)
- **Never use `bundledDependencies`** — Bun's `.bun/` symlink layout creates `../../` paths that npm rejects with E415. (enforced)
- **Never pass gateway secret bytes via argv** — `writeRemoteFile` pipes bytes through SSH stdin only; `--body <value>` patterns are banned.
- **Never skip `validateGatewayHost`** — it rejects `-`-prefixed values and characters outside the allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`).
- **Never restart the gateway in-place to rotate the CA** — workspaces lose trust in the egress proxy. Restore from backup instead.

## UNIQUE STYLES

- Download-based build: KeeWeb v1.18.7 release zip cached in `.cache/`, `dist/` rebuilt every run (source build infeasible — 2017-era tooling).
- Deploy separation: content-only by default, `--nginx` flag for config deploy (requires explicit flag + environment approval).
- Scoped deploy user: `deploy-kw` on server has write access to site dir only + sudo for single activation script.
- CLI framework: `goke` with Zod schemas, space-separated subcommands, `@goke/mcp` bridge for MCP tool exposure.
- `bun.lock` (text format) committed for reproducible CI; `bun.lockb` (binary) is not used.

## COMMANDS

```bash
bun install                                    # Install dependencies
bun run lint                                   # ESLint check
bun run fix                                    # ESLint --fix (includes Prettier)
bunx tsc --noEmit                              # Type check
bun test --recursive                           # Run all tests (from repo root)
bun test                                       # Run tests in current package
bun run --cwd apps/keeweb build                # Build KeeWeb dist
bash apps/keeweb/deploy.sh                     # Deploy content only
bash apps/keeweb/deploy.sh --nginx             # Deploy content + nginx config
bunx @marcusrbrown/infra keeweb status          # Check deploy health
bunx @marcusrbrown/infra keeweb deploy          # Trigger deploy (GitHub Actions)
bunx @marcusrbrown/infra keeweb open              # Open KeeWeb in browser
bunx @marcusrbrown/infra cliproxy status          # Check proxy health
bunx @marcusrbrown/infra cliproxy models          # List models at /v1/models
bunx @marcusrbrown/infra cliproxy models anthropic  # Filter to Anthropic models
bunx @marcusrbrown/infra cliproxy deploy          # Trigger proxy deploy (GitHub Actions)
bunx @marcusrbrown/infra cliproxy open            # Open proxy TUI via SSH
bunx @marcusrbrown/infra cliproxy setup           # Onboard repo to CLIProxyAPI
bunx @marcusrbrown/infra gateway status           # SSH, docker compose ps, service states
bunx @marcusrbrown/infra gateway deploy           # Trigger gateway deploy (GitHub Actions)
bunx @marcusrbrown/infra gateway logs gateway     # Stream gateway service logs (--tail N)
bunx @marcusrbrown/infra gateway backup --include-ca  # Pull mitmproxy CA cert + key as tarball
bunx @marcusrbrown/infra gateway restore --include-ca --input FILE  # Restore CA from tarball
bunx @marcusrbrown/infra dashboard status         # SSH, docker compose ps, service states
bunx @marcusrbrown/infra dashboard deploy         # Trigger dashboard deploy (GitHub Actions)
bunx @marcusrbrown/infra dashboard logs dashboard # Stream dashboard service logs (--tail N)
bunx @marcusrbrown/infra umami status             # SSH, docker compose ps, service states
bunx @marcusrbrown/infra umami deploy             # Trigger umami deploy (GitHub Actions)
bunx @marcusrbrown/infra umami logs               # Stream umami service logs (--tail N)
bunx @marcusrbrown/infra vpn status               # SSH, wg show wg0, interface state + server pubkey + peer count
bunx @marcusrbrown/infra vpn deploy               # Trigger VPN deploy (GitHub Actions)
bunx @marcusrbrown/infra vpn logs                 # Stream journalctl -u wg-quick@wg0 (--tail N)
bunx @marcusrbrown/infra vpn client add <name>    # Generate keypair, assign tunnel IP, write client .conf, redeploy
bunx @marcusrbrown/infra vpn client list          # List peers (name, tunnel IP, public key)
bunx @marcusrbrown/infra vpn client remove <name> # Remove peer, trigger redeploy
bunx @marcusrbrown/infra status                   # Unified status (all deployments)
bunx @marcusrbrown/infra status --json            # Machine-readable status
bunx @marcusrbrown/infra mcp                      # Start MCP server
bun run apps/keeweb/server/setup-deploy-user.ts # Provision deploy user on server
bun run provision:umami                         # Provision umami droplet (loads root .env; also :cliproxy, :gateway)
bun run deploy:umami                            # Local umami deploy (loads root .env; also :cliproxy, :gateway)
bun run provision:vpn                           # Provision VPN Lightsail instance (loads root .env; prints static IP)
bun run deploy:vpn                              # Local VPN deploy (loads root .env)
```

## NOTES

- `DROPBOX_APP_SECRET` and `DEPLOY_SSH_KEY` are GitHub Actions secrets scoped to `keeweb` environment.
- `CLIPROXY_SSH_KEY`, `CLIPROXY_MANAGEMENT_KEY`, and `CLIPROXY_DOMAIN` are scoped to `cliproxy` environment.
- `GATEWAY_SSH_KEY`, `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_REGION`, and `GATEWAY_HOST` are scoped to `gateway` environment. Optional: `S3_ENDPOINT`, `OBJECT_STORE_HOSTS`. Opt-in announce/presence webhook (both-or-neither): `GATEWAY_WEBHOOK_SECRET` (HMAC key, sensitive) and `GATEWAY_PRESENCE_CHANNEL_ID` (Discord channel ID) — set both to enable `POST /v1/announce` + Caddy ingress; leave both unset to keep the gateway outbound-only. Opt-in operator listener (all-or-none): `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`, `GATEWAY_OPERATOR_PUBLIC_ORIGIN` — set all three to enable the operator listener and route `/operator/*` through Caddy; leave all unset to disable. The ratified browser-visible operator origin is `https://dashboard.fro.bot`; set `GATEWAY_OPERATOR_PUBLIC_ORIGIN=https://dashboard.fro.bot` when enabling for production. The gateway Caddy `/operator/*` route is topology scaffolding — `gateway.fro.bot/operator/*` is not the production browser origin. See `apps/gateway/AGENTS.md` for constraints and `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` for the decision record. Operator auth/config (all-or-none with the listener trio): `GATEWAY_OPERATOR_GITHUB_CLIENT_ID`, `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET`, `GATEWAY_OPERATOR_CSRF_SECRET`, and `GATEWAY_OPERATOR_ALLOWLIST` — required when the operator listener is enabled; materialized as secret files via `_FILE` env vars. Optional OAuth tuning (leave unset for upstream defaults): `GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS`, `GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS`, `GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS`. See `apps/gateway/AGENTS.md` and `docs/runbooks/gateway-operator-auth-lifecycle.md` for setup and rotation.
- `DASHBOARD_SSH_KEY`, `DASHBOARD_DOMAIN`, `DASHBOARD_GITHUB_APP_ID`, `DASHBOARD_GITHUB_APP_KEY`, `DASHBOARD_OAUTH_CLIENT_ID`, `DASHBOARD_OAUTH_CLIENT_SECRET`, `DASHBOARD_OPERATOR_LOGIN`, and `DASHBOARD_COOKIE_KEY` are scoped to `dashboard` environment. Deploy reads the GitHub App private key from a file mount (`DASHBOARD_GITHUB_APP_KEY_FILE=/run/secrets/github-app.pem`), never an env-string fallback. The dashboard Caddy `/operator/*` same-origin route is planned but not active; do not enable it until the private dashboard→gateway path and auth/session prerequisites in `apps/dashboard/AGENTS.md` are met.
- `UMAMI_SSH_KEY`, `UMAMI_DOMAIN`, `UMAMI_APP_SECRET`, `UMAMI_DB_PASSWORD`, and `UMAMI_ADMIN_PASSWORD` are scoped to `umami` environment. `UMAMI_DB_PASSWORD` is volume-coupled — rotate only via the `ALTER USER` runbook in `apps/umami/AGENTS.md`.
- `VPN_SSH_KEY`, `VPN_HOST`, and `VPN_PEERS` are scoped to `vpn` environment. `VPN_PEERS` holds the peer roster JSON and is auto-synced by `vpn client add/remove`. AWS provisioning credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are operator-local only — not in the `vpn` Environment and not used by deploy or status.
- `OPENCODE_AUTH_JSON`, `OPENCODE_CONFIG`, `FRO_BOT_PAT` are repo-level secrets. `FRO_BOT_MODEL` is a repo variable.
- `OPENCODE_CONFIG` must set `baseURL` with `/v1` suffix: `{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}`.
- `APPLICATION_ID`, `APPLICATION_PRIVATE_KEY`, `DIGITALOCEAN_ACCESS_TOKEN`, `NPM_TOKEN` are repo-level secrets.
- Deploy target: `box.heatvision.co` (Mail-In-A-Box server). Site path: `/home/user-data/www/kw.igg.ms/`.
- Activation script on server (`/usr/local/bin/kw-deploy-activate`) sets permissions to 775 with setgid to preserve group-write for deploy user.
- `dorny/paths-filter` used for change detection because native `paths:` breaks `workflow_dispatch`. Deploy condition: `workflow_dispatch || keeweb-changed`.
