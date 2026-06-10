# Architecture

System shape and invariants for this monorepo. For where things live, see [`STRUCTURE.md`](STRUCTURE.md). For per-app operational detail (deploy procedures, runbooks, secret contracts) see each `apps/<name>/AGENTS.md` and `packages/cli/AGENTS.md`. For the CLI surface and command help, see `packages/cli/AGENTS.md`.

## Bird's Eye Overview

This is a Bun-workspace monorepo that deploys and manages personal infrastructure: KeeWeb (`box.heatvision.co`), a CLIProxyAPI Claude proxy (`cliproxy.fro.bot`), the Fro Bot Discord gateway (`gateway.fro.bot`), Umami analytics (`metrics.fro.bot`), and a WireGuard VPN egress box on AWS Lightsail (`eu-west-1`). Each deployable lives under `apps/`; each is self-contained (its own Docker Compose stack or build, a TypeScript deploy script, and a provisioning script). DigitalOcean droplets host the Docker apps; KeeWeb deploys to a Mail-in-a-Box server over SSH/rsync; the VPN box runs native `wg-quick@wg0` + systemd on AWS Lightsail, provisioned via `@aws-sdk/client-lightsail`.

`packages/cli` is the unified operator surface — a goke CLI (`@marcusrbrown/infra`) with one command group per app plus a unified `status` dashboard. `packages/shared` holds cross-app provisioning helpers. The same CLI exposes a read-only subset of its commands over an MCP bridge so coding agents can query deployment state. GitHub Actions runs the deploy pipeline (one gated workflow per app behind a per-app GitHub Environment) and automation (Fro Bot review, Renovate, releases via Changesets).

## Codemap

Role → path. Reference symbols and files; no line numbers (they rot).

| Role | Path |
| --- | --- |
| CLI entry point (goke) | `packages/cli/src/cli.ts` (`registerKeewebCommands`, `registerCliproxyCommands`, `registerGatewayCommands`, `registerUmamiCommands`, `registerVpnCommands`, `registerStatus`, `registerMcp`) |
| Per-app CLI command groups | `packages/cli/src/commands/<app>/` (each `<action>.ts` + barrel `index.ts`) |
| Unified status dashboard | `packages/cli/src/commands/status.ts` |
| MCP bridge + allowlist | `packages/cli/src/commands/mcp.ts` (`MCP_ALLOWLIST`, `registerMcp`) |
| MCP-capturable action context | `packages/cli/src/lib/action-ctx.ts` (`ActionCtx`) |
| Executable conventions enforcement | `packages/cli/src/conventions.test.ts` |
| App deploy scripts | `apps/<name>/src/deploy.ts` (`main`/`deploy`) — except keeweb |
| KeeWeb build + deploy | `apps/keeweb/src/build.ts`, `apps/keeweb/deploy.sh` |
| Droplet provisioning | `apps/<name>/server/provision-droplet.ts` (cliproxy, gateway, umami) |
| VPN provisioning (Lightsail) | `apps/vpn/server/provision-droplet.ts` — `@aws-sdk/client-lightsail`; resolves blueprint/bundle live, set-exact firewall, imports Ed25519 key, installs WireGuard, pins IP host key |
| VPN peer model | `packages/shared/vpn/peers.ts` (`readPeers`, `writePeers`, `renderServerConfig`, `Peer`) |
| Shared SSH/SCP/DO helpers | `packages/shared/server/droplet-helpers.ts` (`ssh`, `scp`, `waitForSsh`, `getSshFingerprint`, `pinHostKeys`, `materializeIdentityFile`) |
| Gateway upstream daemon pin | `apps/gateway/upstream.json` |
| Per-app host validators | `apps/<name>/src/host.ts` and `packages/cli/src/commands/<app>/host.ts` |
| Deploy pipeline | `.github/workflows/deploy.yaml` (router) + `deploy-<app>.yaml` |
| Pinned SSH host keys | `.github/known_hosts` |

## Data Flow

**Operator / agent → deploy or status:**

```text
operator (CLI) or agent (MCP)
  → packages/cli/src/cli.ts (goke parse)
  → packages/cli/src/commands/<app>/<action>.ts (goke action, receives ctx)
  → packages/shared/server/droplet-helpers.ts (SSH/SCP) or app deploy.ts
  → droplet: docker compose / rsync over SSH
  → result captured via ctx (MCP) or printed (terminal)
```

**MCP bridge:** `registerMcp` exposes only the `MCP_ALLOWLIST` set — `gateway status`, `cliproxy status`, `keeweb status`, `umami status`, `vpn status`, and unified `status`. All mutating commands (keys, config, deploy, backup, logs, client management) are source-gated out of MCP. Allowlisted actions thread `ctx` (`packages/cli/src/lib/action-ctx.ts`) so captured output reaches the agent; global `console`/`process.stdout` bypass capture and must not be used in MCP-exposed bodies.

**Deploy pipeline:** a push to `main` triggers `.github/workflows/deploy.yaml`, which runs `dorny/paths-filter` (`predicate-quantifier: every`) and routes to the matching `deploy-<app>.yaml`. Each app deploy waits at its per-app GitHub Environment approval gate before touching the droplet.

## Invariants

Enforceable rules. Many are gated by `packages/cli/src/conventions.test.ts`, ESLint, or review; mirror the `(enforced)` anti-patterns in the root `AGENTS.md`.

1. **`apps/` are deployable units; `packages/` are reusable libraries.** `packages/` never imports from `apps/`.
2. **Only `apps/keeweb/deploy.sh` is Bash.** Every other script is TypeScript run via `bun run`.
3. **Never pass secret bytes via argv.** Secret material is piped through SSH stdin (`writeRemoteFile` pattern); `--body <value>` patterns are banned.
4. **Host validation before SSH.** Every SSH-spawning command validates the host (`host.ts`, rejecting `-`-prefixed and invalid values) before constructing the SSH command.
5. **GitHub Actions are SHA-pinned** with a `# vX.Y.Z` comment; workflow files use `.yaml` (not `.yml`).
6. **No `as any` / `@ts-ignore` / `@ts-expect-error`** — fix the types. No TS files excluded from type checking.
7. **Tracked files never contain secret values.** Secrets are injected at build/deploy time from environment or GitHub Environment secrets.
8. **Deploy workflows use `dorny/paths-filter` with `predicate-quantifier: every`** so `!` negations work and docs/tests do not trigger deploys.
9. **Never use `ssh-keyscan` in CI** — host keys are pinned in `.github/known_hosts`; provisioning scripts may use it locally via `pinHostKeys`.
10. **MCP exposes read commands only** (`MCP_ALLOWLIST`); mutating commands are source-gated out.

## Cross-Cutting Concerns

- **Secret materialization.** Deploy scripts write secrets to droplet files over SSH stdin (never argv), and CI loads GitHub Environment secrets into the deploy step. Local runs load the repo-root `.env` (Bun loads `.env` from CWD only — run via root `provision:<app>` / `deploy:<app>` wrappers).
- **Deploy gating.** Each app has a GitHub Environment (`keeweb`, `cliproxy`, `gateway`, `umami`, `vpn`) with a required reviewer and a main-only branch policy. Merging a deploy-triggering change holds at the approval gate.
- **Host-key pinning.** `.github/known_hosts` pins both domain (unhashed) and IP (hashed) entries; CI connects with strict host-key checking against only that file.
- **Upstream pinning + verify-at-tag.** The gateway daemon source is pinned in `apps/gateway/upstream.json`; bumping it requires diffing the daemon's required-secret contract against the compose wiring at the new tag before deploy. This is independent of the Fro Bot review Action SHA pinned in `.github/workflows/fro-bot.yaml` (see `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md`).
- **Executable conventions.** `packages/cli/src/conventions.test.ts` enforces several invariants above (SHA-pinned actions, `.yaml` extension, no stray Bash scripts, no `ssh-keyscan` in workflows, no `bundledDependencies`) as part of the test suite.
- **Releases.** Changesets version `@marcusrbrown/infra`; only `packages/cli/src/` user-facing changes warrant a changeset.

## Where to Add New Code

Integration-level patterns; for the mechanical file layout see [`STRUCTURE.md`](STRUCTURE.md).

- **New deployable app** → create `apps/<name>/` mirroring the closest existing app (`apps/cliproxy/` for a Docker-Compose droplet app, `apps/vpn/` for a native-systemd AWS Lightsail app): Compose config or deploy script, `src/deploy.ts`, `server/provision-droplet.ts` (using `packages/shared/server/droplet-helpers.ts` for SSH helpers, or `@aws-sdk/client-lightsail` for Lightsail), `src/host.ts`. Add it to `package.json` `workspaces`, add `provision:<name>` / `deploy:<name>` root scripts, add a CLI command group under `packages/cli/src/commands/<name>/`, add a gated `deploy-<name>.yaml` workflow wired into `deploy.yaml`'s paths-filter, create the `<name>` GitHub Environment, and add `apps/<name>/AGENTS.md`.
- **New CLI command group** → add `register<Name>Commands` and a `commands/<name>/` directory with per-action files and a barrel `index.ts`; register it in `packages/cli/src/cli.ts`. Expose a command over MCP only by adding it to `MCP_ALLOWLIST`, and only if it is read-only.
- **New shared provisioning helper** → add it to `packages/shared/server/droplet-helpers.ts` with a colocated test; consume it from each `provision-droplet.ts`.
- **New deploy workflow** → copy an existing `deploy-<app>.yaml`, keep the per-app Environment gate and `paths-filter` negations, and wire it into `deploy.yaml`.
