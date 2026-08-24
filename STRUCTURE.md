# Structure

Where things live and where to put new code. For system shape, data flow, and invariants, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For per-app operational detail, see each `apps/<name>/AGENTS.md` and `packages/cli/AGENTS.md`.

## Directory Layout

```text
├── apps/                       Deployable units (one self-contained deploy each; apps/agent is provisioning-only, no deploy)
│   ├── keeweb/                 KeeWeb static-site deploy (SSH/rsync to Mail-in-a-Box)
│   ├── cliproxy/               CLIProxyAPI Claude proxy (DigitalOcean + Docker Compose)
│   ├── gateway/                Fro Bot Discord gateway (DigitalOcean + Docker Compose)
│   ├── umami/                  Umami analytics (DigitalOcean + Docker Compose)
│   ├── dashboard/              Fro Bot monitoring dashboard (DigitalOcean + Docker Compose)
│   ├── vpn/                    WireGuard egress box (AWS Lightsail eu-west-1, native wg-quick@wg0)
│   ├── broker/                 OIDC credential broker (DigitalOcean + Docker Compose)
│   └── agent/                  Operator-run AWS provisioner for fro-bot/agent S3 durable storage (no deploy step)
├── packages/                   Reusable libraries (never import from apps/)
│   ├── cli/                    @marcusrbrown/infra goke CLI + MCP bridge + VPN peer model
│   └── shared/                 Cross-app SSH/SCP/provisioning helpers
├── docs/                       Brainstorms → plans → solutions (compound learning)
├── .agents/skills/             Agent skill context packets (load before working in a domain)
├── .github/                    Workflows, pinned host keys, Renovate, Copilot, repo settings
└── .opencode/commands/         OpenCode slash commands
```

## Directory Purposes

### `apps/`

One subdirectory per deployable. Each app owns its Compose/build config (or native systemd config for VPN), a TypeScript deploy script (`src/deploy.ts`; KeeWeb uses `src/build.ts` + `deploy.sh`), a provisioning script (except keeweb — `server/provision-droplet.ts` for the DigitalOcean Docker apps including dashboard and broker, `server/provision.ts` for the `@aws-sdk/client-lightsail` VPN box), a deploy-side host validator (`src/host.ts` where the deploy spawns SSH), and an `AGENTS.md` runbook. Apps never share code by importing each other — shared logic lives in `packages/shared`, and the VPN peer model is published from `packages/cli`. `apps/agent` is the non-deployable exception: a `private: true` operator-run AWS provisioner with no `src/deploy.ts`, no `src/host.ts`, and no deploy workflow — just `server/provision.ts` (IAM + S3 convergence) and `src/key-layout.ts` (pinned S3 key layout).

### `packages/`

Reusable libraries. `packages/cli` is the operator surface (goke command groups, unified status, MCP bridge) and also owns the VPN peer model (`packages/cli/src/commands/vpn/peers.ts`, published as `@marcusrbrown/infra/vpn/peers` and imported by `apps/vpn`). `packages/shared` is the provisioning helper library consumed by every app's provision script. `packages/` never imports from `apps/`; the published `@marcusrbrown/infra` (cli) stays self-contained and must not depend on the private `packages/shared`.

### `.github/`

CI/CD and automation: `workflows/*.yaml` (deploy router + per-app deploys, CI, release, Fro Bot, Renovate, Scorecard, settings sync), `known_hosts` (pinned SSH host keys), `renovate.json5`, `settings.yml`, `copilot-instructions.md`.

### `docs/`

Compound-learning chain: `brainstorms/` (requirements), `plans/` (implementation plans), `solutions/` (documented fixes/best-practices with YAML frontmatter). Plan-taxonomy lives here and only here — never in shipped source or public docs.

### `.agents/skills/`

Per-domain agent context packets (`<name>/SKILL.md`). Load the relevant skill before working in that domain.

### `.opencode/commands/`

OpenCode slash commands (Markdown). The `generating-project-docs` skill (`.agents/skills/generating-project-docs/SKILL.md`) owns all generated docs — `ARCHITECTURE.md`, `STRUCTURE.md`, the root `README.md`, and per-package READMEs. Slash commands here are for other OpenCode workflows.

## Key File Locations

**Entry Points**

| File                        | Role                                                     |
| --------------------------- | -------------------------------------------------------- |
| `packages/cli/src/cli.ts`   | goke CLI entry; registers all command groups             |
| `apps/<name>/src/deploy.ts` | App deploy script (`main`/`deploy`)                      |
| `apps/keeweb/src/build.ts`  | KeeWeb build (download + SHA-256 verify + config inject) |
| `apps/keeweb/deploy.sh`     | Only Bash script in the repo (SSH/rsync deploy)          |

**Per-App Deploy / Provision**

| File | Role |
| --- | --- |
| `apps/<name>/server/provision-droplet.ts` | DigitalOcean droplet provisioning (cliproxy, gateway, umami, dashboard, broker) |
| `apps/vpn/server/provision.ts` | Lightsail provisioning (`@aws-sdk/client-lightsail`) |
| `apps/agent/server/provision.ts` | Operator-run AWS IAM + S3 convergence for `fro-bot/agent` durable storage; no deploy step |
| `apps/agent/src/key-layout.ts` | Version-pinned S3 session/coordination-lock key layout; unknown layouts fail closed |
| `apps/<name>/src/host.ts` | Deploy-side host validator (rejects `-`-prefixed / invalid hosts) |
| `apps/gateway/upstream.json` | Pinned `fro-bot/agent` daemon ref |
| `apps/dashboard/docker-compose.yaml` | Digest-pinned `ghcr.io/fro-bot/dashboard` image (tag@sha256 in the `image:` line; Renovate tracks bumps) |
| `packages/cli/src/commands/vpn/peers.ts` | VPN peer model: `readPeers`, `writePeers`, `parsePeersJson`, `renderServerConfig`, `Peer` (exported as `@marcusrbrown/infra/vpn/peers`) |

**CLI Commands**

| File                                          | Role                                                          |
| --------------------------------------------- | ------------------------------------------------------------- |
| `packages/cli/src/commands/<app>/<action>.ts` | Per-app subcommand (status, deploy, …)                        |
| `packages/cli/src/commands/<app>/index.ts`    | Command-group barrel (`register<App>Commands`)                |
| `packages/cli/src/commands/status.ts`         | Unified cross-app status dashboard                            |
| `packages/cli/src/commands/mcp.ts`            | MCP stdio bridge + `MCP_ALLOWLIST`                            |
| `packages/cli/src/lib/action-ctx.ts`          | `ActionCtx` — MCP-capturable action context                   |
| `packages/shared/server/droplet-helpers.ts`   | Shared SSH/SCP/DigitalOcean helpers (also used by VPN deploy) |

**Config**

| File                     | Role                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| `package.json`           | Workspaces, root `provision:*` / `deploy:*` / `test` / `lint` scripts |
| `eslint.config.ts`       | ESLint via `@bfra.me/eslint-config`                                   |
| `tsconfig.json`          | TypeScript via `@bfra.me/tsconfig`                                    |
| `.github/renovate.json5` | Renovate config (incl. `apps/*/upstream.json` custom manager)         |

**Tests / CI**

| File                                   | Role                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| `**/*.test.ts`                         | Colocated tests (mock at boundaries: `fetch`, `Bun.spawn`) |
| `packages/cli/src/conventions.test.ts` | Executable convention enforcement                          |
| `.github/workflows/deploy.yaml`        | Deploy router (paths-filter → per-app deploy)              |
| `.github/workflows/deploy-<app>.yaml`  | Gated per-app deploy                                       |

## Naming Conventions

- **Scripts**: TypeScript run via `bun run`. Only `apps/keeweb/deploy.sh` is Bash.
- **Tests**: colocated `*.test.ts` beside source. Fixtures in `__fixtures__/`, snapshots in `__snapshots__/`. Use `NO_COLOR=1` for deterministic subprocess snapshots.
- **CLI command modules**: `packages/cli/src/commands/<app>/<action>.ts` (e.g. `status.ts`, `deploy.ts`) + a barrel `index.ts` exporting `register<App>Commands`.
- **Host validators**: `host.ts` (deploy-side under `apps/<name>/src/`, CLI-side under `packages/cli/src/commands/<app>/`).
- **Workflows**: `.yaml` extension (not `.yml`); deploy workflows `deploy-<app>.yaml`.
- **Bun script guards**: scripts exporting functions for tests gate top-level execution with `if (import.meta.main)`.

## Where to Add New Code

Mechanical layout; for the integration rationale see [`ARCHITECTURE.md`](ARCHITECTURE.md).

- **New app** → `apps/<name>/` mirroring `apps/cliproxy/` (Docker Compose on DigitalOcean) or `apps/vpn/` (native systemd on AWS Lightsail): Compose config or deploy script, `src/deploy.ts`, `server/provision.ts` (new apps use `provision.ts`; existing DigitalOcean apps keep `provision-droplet.ts`), `src/host.ts`, `AGENTS.md`. Add to `package.json` `workspaces` + `provision:<name>`/`deploy:<name>` scripts; run `bun install` to refresh `bun.lock`.
- **New operator-only tool (no deploy)** → mirror `apps/agent/`: `private: true`, `server/provision.ts` only — no `src/deploy.ts`, `src/host.ts`, deploy workflow, or GitHub Environment. Add `provision:<name>` to root `package.json` scripts.
- **New CLI command** → `packages/cli/src/commands/<app>/<action>.ts` + colocated test; export it from the group's `index.ts` barrel.
- **New shared helper** → `packages/shared/server/droplet-helpers.ts` + colocated test.
- **New test** → colocate `*.test.ts` beside the source; fixtures/snapshots in `__fixtures__/`/`__snapshots__/`.
- **New workflow** → `.github/workflows/<name>.yaml`, SHA-pinned actions with `# vX.Y.Z`; for a deploy, copy a `deploy-<app>.yaml` and wire it into `deploy.yaml`'s paths-filter.
- **New docs page** → `docs/<brainstorms|plans|solutions>/`; solutions carry YAML frontmatter.
