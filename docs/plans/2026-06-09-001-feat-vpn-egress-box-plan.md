---
title: 'feat: Add WireGuard VPN egress box (apps/vpn)'
type: feat
status: active
date: 2026-06-09
origin: docs/brainstorms/2026-06-09-vpn-egress-box-requirements.md
---

# feat: Add WireGuard VPN egress box (apps/vpn)

## Overview

Add `apps/vpn`, the first AWS-backed deployable in the monorepo: a single-user WireGuard egress box on AWS Lightsail in Ireland (`eu-west-1`), managed with full parity to the DigitalOcean apps (provisioning, deploy, CLI command group, unified status, MCP read access, gated CI, operator docs). The box is a general-purpose personal VPN whose egress exits Ireland; it is provider-agnostic and contains no Polymarket-specific configuration.

This is the first time the repo provisions on AWS. Provisioning shifts from `doctl` to `@aws-sdk/client-lightsail`, but all SSH-side plumbing (key materialization, host-key pinning, ControlMaster, `waitForSsh`) is reused from `packages/shared/server/droplet-helpers.ts` unchanged — those helpers are cloud-agnostic and already encode the hard-won first-deploy cascade lessons.

## Problem Frame

A decade-old OpenVPN EC2 instance in `us-west-2` is unused, holds nothing worth keeping, and is no longer free-tier. The operator wants a modern WireGuard egress box exiting Ireland (Polymarket's "closest non-georestricted region"), managed with the same first-class tooling as every other infra service rather than hand-configured. Standing up the first AWS app is a deliberate, accepted second-cloud commitment: it adds a provider, an IAM credential surface, and an SDK dependency, but produces both the managed VPN and a reusable AWS-app provisioning pattern future AWS apps can mirror. (see origin: docs/brainstorms/2026-06-09-vpn-egress-box-requirements.md)

The compliance question (Polymarket ToS 2.1.4 prohibits VPN geo-circumvention) is the operator's accepted decision and is deliberately kept out of the artifact — the box is a general VPN, and usage policy lives with the operator, not the code.

## Requirements Trace

- R1. Lightsail provisioning in TypeScript via `@aws-sdk/client-lightsail` — no `aws` CLI binary, no new Bash. Idempotent; refuses re-create without `--force`. Reads a dedicated, least-privilege, region-scoped IAM credential (distinct from the gateway's S3 keys). Repairs partial state (missing static IP / firewall rule).
- R2. Provisioning allocates + attaches a persistent named static IP, sets the box's inbound firewall to **exactly** UDP 51820 + SSH 22 (closing Lightsail's default 80/443), waits for SSH, and pins the box's IP host key (IP-only in v1 — no domain per NG4) into `.github/known_hosts`. Fails closed if the host key cannot be pinned. Static IP is the durable client-facing endpoint; reprovision re-attaches the same static IP (see R5a for the server-key continuity caveat).
- R2a. The box exposes exactly two inbound surfaces: UDP 51820 (WireGuard) + SSH. NAT forwards only authenticated WireGuard peers (not an open relay).
- R3. The box's SSH key is a dedicated `fro-bot-vpn` Ed25519 keypair; the PUBLIC key is registered into Lightsail at instance create via `ImportKeyPairCommand`; the private key is `VPN_SSH_KEY` (root `.env` locally + `vpn` GitHub Environment secret in CI).
- R4. Native WireGuard runtime: `wg-quick@wg0` + systemd, no Docker. Deploy materializes `/etc/wireguard/wg0.conf` over SSH stdin, enables IP forwarding via `sysctl.d`, and sets NAT masquerade via `PostUp`/`PostDown`.
- R5. Server keypair generated once on the box, persisted at a stable path (`/etc/wireguard/server.key`, mode 0600) separate from the rendered `wg0.conf`. The server PRIVATE key never leaves the box: deploy reads back only the server PUBLIC key; `wg0.conf` is rendered **server-side** (the deploy ships peer data + a render command over SSH stdin, and the box assembles the final config referencing its local private key). Never rotated on redeploy unless `--force-server-key`. Generation is atomic (key written before config references it).
- R5a. Reprovision (fresh disk) re-attaches the same static IP (endpoint unchanged) but destroys the server private key, so clients reach the box yet fail the cryptographic handshake — a silent break. This is the explicit reprovision contract: same endpoint, new server identity. The runbook documents it as a server-identity-changing event requiring either `server.key` backup/restore (continuity) or regenerate-and-reissue-clients; `vpn status` surfaces the server public key so a key mismatch is diagnosable.
- R6. `wg0.conf` is rendered declaratively (server-side) from `peers.json` (shipped over SSH stdin) + the box's persisted server private key on every deploy — a removed peer is genuinely revoked on next deploy; emergency manual edits are overwritten by deploy.
- R7. `vpn client add <name>` generates a client keypair locally, assigns the next tunnel IP, appends the PUBLIC key + tunnel IP to `apps/vpn/config/peers.json` (public keys only — never private material), and redeploys. `vpn client list` / `vpn client remove <name>` round out management.
- R8. The peer command writes the client `.conf` (with client private key) only into a committed-gitignored local dir (`apps/vpn/clients/`), guarded by a runtime check that refuses to write if the target path is git-tracked / not ignored (not gitignore-only), and prints the path. Full-tunnel (`0.0.0.0/0`) default; `--split-tunnel <cidrs>` flag for specific routes. All config/peer bytes go via SSH stdin, never argv.
- R9. CLI command group `packages/cli/src/commands/vpn/` (`status`, `deploy`, `logs`, `client add|list|remove`), a CLI-side host validator (`vpn/host.ts`), registered in `cli.ts`.
- R10. `vpn status` integrated into the unified `status` dashboard via a `getVpnStatusSummary()` aggregator (per-app aggregator pattern, no helper-name collisions with other apps).
- R11. `vpn status` exposed over MCP (read-only, added to `MCP_ALLOWLIST`, threaded `ctx`). `vpn status` is **SSH + `wg show` only** — it never calls the Lightsail/AWS API, so the MCP runtime never needs AWS credentials. `vpn deploy`/`logs`/`client *` stay CLI-only (mutating / sensitive). AWS credentials are scoped to the provisioning path only — never the deploy or status paths.
- R12. `deploy-vpn.yaml` gated workflow wired into the `deploy.yaml` router with `dorny/paths-filter` + `predicate-quantifier: every`; the `vpn` GitHub Environment with required reviewer + main-only branch policy.
- R13. Root `provision:vpn` / `deploy:vpn` wrapper scripts (load root `.env`); `apps/vpn/AGENTS.md` + `apps/vpn/README.md`; `.github/known_hosts` entry; conventions coverage; old-EC2-teardown runbook step.

## Scope Boundaries

- No Polymarket-specific config (no `clob.polymarket.com` allowlists, no geo-circumvention language in source).
- No Docker for the VPN runtime — native WireGuard only.
- No automated destructive teardown of the old EC2 (manual operator runbook step).
- No multi-region, HA, or multi-tenant-at-scale design.
- No domain/DNS for the endpoint in v1 — static IP is the endpoint (see OQ3).

### Deferred to Separate Tasks

- Old `us-west-2` OpenVPN EC2 termination: documented runbook step; operator performs in the AWS console.
- Optional endpoint domain (DNS A record): future iteration if static IP proves insufficient.
- Server-key backup/restore-for-continuity tooling: documented manual procedure in v1 (OQ5); a `vpn backup`-style command is future work only if reprovision-continuity becomes routine.

## Context & Research

### Relevant Code and Patterns

- **`apps/cliproxy/`** — closest precedent for provisioning + deploy + config-preservation. The `config.yaml`-preservation invariant (skip upload when file exists, `--force-config` override) is the direct analog for `wg0.conf`/server-key preservation.
- **`apps/gateway/src/deploy.ts`** — SSH-stdin secret materialization (`writeRemoteFile`), `normalizePemPrivateKey` trailing-newline handling, ControlMaster usage, host validation before SSH argv. The VPN deploy mirrors this shape minus Docker.
- **`apps/gateway/server/provision-droplet.ts`** + **`apps/cliproxy/server/provision-droplet.ts`** — provisioner structure (idempotency guard, `--force`, SSH key by name, host-key pinning, `import.meta.main` guard). The VPN provisioner mirrors the control flow but swaps `doctl` for the Lightsail SDK.
- **`packages/shared/server/droplet-helpers.ts`** — reuse `ssh`, `scp`, `materializeIdentityFile`, `waitForSsh`, `pinHostKeys`, `sleep`, `run`, `runCapture` **unchanged** (cloud-agnostic SSH plumbing). `validateDoctl`, `getSshFingerprint`, `dropletExists`, `getDropletIpWithWait` are DO-specific and are NOT reused — the VPN provisioner gets Lightsail-native equivalents.
- **`packages/cli/src/commands/gateway/`** — command-group barrel (`registerGatewayCommands`), host validator (`gateway/host.ts` rejecting `-`-prefixed values), `getGatewayStatusSummary()` aggregator, `SpawnFn` injection for testable SSH actions.
- **`packages/cli/src/commands/mcp.ts`** — `MCP_ALLOWLIST` (ReadonlySet) + `ctx`-threading; `vpn status` joins the allowlist, mutating commands stay out.
- **`packages/cli/src/commands/status.ts`** — unified dashboard composing per-app `get<App>StatusSummary()` aggregators.
- **`.github/workflows/deploy.yaml`** + **`deploy-gateway.yaml`** — router + gated per-app deploy with paths-filter negations and `predicate-quantifier: every`.
- **`packages/cli/src/conventions.test.ts`** — executable convention gate; verify it already covers the new app's workflow/extension/no-Bash rules.

### Institutional Learnings

- **`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`** — SSH key trailing-`\n` (GH Actions strips it; OpenSSH PEM needs it; `materializeIdentityFile` already handles this); ControlMaster for SSH rate-limits (already in `droplet-helpers.ts`); test fixtures must mirror real tool output.
- **`docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md`** — pin **unhashed domain** entries for CI (connects by domain), hashed IP separately; one canonical host env name (here the static IP / `VPN_HOST` is the single identity); `bun.lock` must be regenerated for the new workspace member.
- **`docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`** — GitHub Environment auto-creates **ungated** on first workflow reference; pre-create with reviewer + branch policy (watch the readonly `UID` bash builtin); `ssh -i <key> -o IdentitiesOnly=yes` for file-backed keys (already in helpers); fail-closed on credential operations.
- **`docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md`** — never `git clean -xfd` a droplet deploy dir holding untracked secrets; `--wait`/active asserts liveness not freshness — verify the WG interface is actually up + a peer handshake works, not just `systemctl is-active`.
- **`docs/solutions/workflow-issues/bun-deploy-user-permissions-ci-2026-04-02.md`** — CI uses `bun install --frozen-lockfile --ignore-scripts`; run `bun install` + commit `bun.lock` after adding `apps/vpn/package.json`.

### External References

- AWS SDK for JS v3 `@aws-sdk/client-lightsail@3.1065.0` (verified current). Commands: `CreateInstancesCommand`, `GetInstanceCommand`/`GetInstancesCommand` (poll `state.name === 'running'`), `AllocateStaticIpCommand`/`AttachStaticIpCommand`/`GetStaticIpCommand`, `PutInstancePublicPortsCommand` (set-exact ruleset = `[{SSH 22 tcp}, {51820 udp}]`; replaces the whole set, so SSH 22 MUST be included or the box locks out; chosen over additive `OpenInstancePublicPorts` so the default 80/443 are closed), `ImportKeyPairCommand` (base64 public key), `GetBlueprintsCommand`/`GetBundlesCommand` (resolve `blueprintId`/`bundleId` **live** — do not hardcode `ubuntu_24_04`/`nano_3_0` from assumptions). WireGuard is installed on the fresh instance via `apt-get install -y wireguard` during provisioning (not present on a vanilla Ubuntu LTS image).
- WireGuard: native `wg-quick@wg0` + systemd is the canonical single-box pattern; server key generated once and persisted; NAT via `PostUp`/`PostDown` iptables masquerade; `net.ipv4.ip_forward=1` via `sysctl.d`; client `AllowedIPs` is purely a client-side full-vs-split decision.

## Key Technical Decisions

- **Lightsail over EC2/DO**: Lightsail Ireland is the cheapest reliable Polymarket-permitted-region option (~$5/mo flat); DO has no permitted near-US region; EC2 free tier no longer applies to the operator's account. (see origin)
- **Reuse SSH-side helpers, fork only provisioning**: `droplet-helpers.ts` SSH functions are cloud-agnostic and already encode cascade lessons — reusing them avoids reintroducing the trailing-newline / ControlMaster / IdentitiesOnly bugs. Lightsail-specific provisioning lives entirely in `apps/vpn/server/provision-droplet.ts`; no premature shared AWS abstraction at N=1.
- **`PutInstancePublicPortsCommand` (set-exact ruleset)** including SSH 22 + UDP 51820 in the same call: this closes Lightsail's default 80/443 (unused attack surface) and achieves the R2a "exactly two inbound surfaces" goal. The lockout risk (`Put` replaces the whole set) is mitigated by always including SSH 22 explicitly in the ruleset — a tested invariant. (`OpenInstancePublicPorts` was considered but is additive-only and cannot close the default ports.)
- **Resolve `blueprintId`/`bundleId` live** via `GetBlueprints`/`GetBundles`: AWS docs do not pin these to guessable constants; hardcoding risks a non-existent-ID failure. The provisioner queries for the current Ubuntu LTS blueprint + the smallest IPv4 bundle.
- **Ed25519 import** (`ImportKeyPairCommand`): one key-materialization path across all apps. Risk: Lightsail `ImportKeyPair` historically documents `ssh-rsa` base64 — Unit 2 verifies Ed25519 acceptance at implementation and falls back to an RSA key for this box only if rejected.
- **Server-key/`wg0.conf` preservation mirrors cliproxy `config.yaml`**: declarative render from `peers.json` + persisted server key; never rotate the server key on redeploy without `--force-server-key`. This makes redeploy safe for existing peers.
- **IAM least-privilege is action-scoped, not ARN-scoped**: Lightsail IAM is coarse (many actions are `Resource: *`); the runbook documents the minimal action set (OQ4) and region scoping rather than promising tight ARN scoping the service doesn't support. AWS credentials are bounded to the **provisioning path only** — deploy and status reach the box over SSH and never need AWS creds, keeping the credential blast radius off the CI deploy/status surface and the MCP runtime.
- **Privacy posture (egress box)**: the box is an egress relay for a privacy-minded single user; the deploy disables/minimizes connection logging where practical (WireGuard logs no traffic by default; `journalctl` is operator-only and CLI-only, never MCP). The runbook documents what is logged, where, and retention so the privacy boundary is explicit.

## Open Questions

### Resolved During Planning

- SSH key model: import our own `fro-bot-vpn` Ed25519 key (user decision) — not Lightsail-generated.
- Firewall command: `PutInstancePublicPorts` (set-exact ruleset including SSH 22 + UDP 51820; closes default 80/443), resolved via SDK + security review.
- Blueprint/bundle IDs: resolved at runtime via `GetBlueprints`/`GetBundles`, not hardcoded.
- Runtime: native `wg-quick@wg0` + systemd (no Docker), resolved via research.

### Deferred to Implementation

- OQ1. Peer tunnel-IP allocation scheme (sequential `10.8.0.N/32` in `peers.json`) and IP reclamation on `client remove` — exact next-IP logic decided when writing the peer module.
- OQ2. `vpn status` reachability depth: SSH + `wg show` is the baseline; whether to add a client-side UDP handshake probe is decided during status implementation.
- OQ3. Whether a domain (DNS A record) is worth adding for the endpoint later, or the static IP is sufficient (v1 ships IP-only); revisited if IP-only proves limiting.
- OQ4. Minimal IAM action set + which actions accept resource ARNs — finalized against the live SDK calls during provisioner implementation; documented in AGENTS.md.
- OQ5. Reprovision-recovery procedure (back up/restore `/etc/wireguard/server.key` vs regenerate-and-reissue) — documented in the runbook during Unit 8; no code in v1.
- Ed25519-vs-RSA import compatibility — confirmed empirically in Unit 2.

## Output Structure

    apps/vpn/
    ├── package.json
    ├── AGENTS.md
    ├── README.md
    ├── config/
    │   ├── wg0.conf.template          # rendered server config template (no secrets)
    │   ├── peers.json                 # tracked: public keys + tunnel IPs only
    │   └── wg-forwarding.conf         # sysctl.d ip_forward snippet
    ├── clients/                       # gitignored — client .conf output (private keys)
    │   └── .gitkeep
    ├── server/
    │   ├── provision-droplet.ts       # Lightsail SDK provisioning
    │   └── provision-droplet.test.ts
    └── src/
        ├── deploy.ts                  # materialize wg0.conf + control wg-quick@wg0
        ├── deploy.test.ts
        ├── host.ts                    # deploy-side host validator
        ├── host.test.ts
        ├── peers.ts                   # peers.json read/render/next-IP + wg0.conf rendering
        └── peers.test.ts

    packages/cli/src/commands/vpn/
    ├── index.ts                       # registerVpnCommands barrel
    ├── status.ts + status.test.ts
    ├── deploy.ts + deploy.test.ts
    ├── logs.ts + logs.test.ts
    ├── client.ts + client.test.ts     # add|list|remove subcommands
    ├── host.ts + host.test.ts         # CLI-side host validator
    └── shared.ts                      # getVpnStatusSummary() + vpn HTTP/ssh helpers

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Provisioning flow (Lightsail SDK):

```text
provision-droplet.ts
  validate AWS creds present (env credential chain)
  guard: instance "fro-bot-vpn" exists? --> abort unless --force (repair partial state otherwise)
  ImportKeyPairCommand(fro-bot-vpn, base64(public key))     # idempotent: skip if present
  GetBlueprintsCommand --> pick current Ubuntu LTS blueprintId
  GetBundlesCommand    --> pick smallest IPv4 bundle (~$5/mo)
  CreateInstancesCommand(eu-west-1a, blueprint, bundle, keyPairName=fro-bot-vpn)
  poll GetInstanceCommand until state.name === "running"
  AllocateStaticIpCommand(fro-bot-vpn-ip) + AttachStaticIpCommand --> GetStaticIp --> IP
  PutInstancePublicPortsCommand([SSH 22, UDP 51820])        # set exact ruleset: closes default 80/443
  waitForSsh(ip, identityFile)                              # shared helper
  install wireguard: ssh "apt-get update && apt-get install -y wireguard"   # fresh-image bootstrap
  pin IP host key into .github/known_hosts (IP-only, v1 has no domain); fail closed
  print allocated static IP --> operator seeds VPN_HOST into .env + vpn GitHub Environment
```

Deploy flow (native WireGuard, no Docker):

```text
deploy.ts
  validateEnv (VPN_HOST, VPN_SSH_KEY in CI) + validateVpnHost(host)   # before any SSH argv
  materializeIdentityFile(VPN_SSH_KEY) if CI                          # shared helper
  ensure server key: ssh "umask 077; test -f /etc/wireguard/server.key || (wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub)"  (atomic, 0600)
  read back ONLY server.pub (public key) for status/diagnosis
  ship peers.json over SSH stdin; box renders /etc/wireguard/wg0.conf SERVER-SIDE referencing its local /etc/wireguard/server.key (private key never leaves the box)
  write sysctl.d ip_forward snippet; sysctl --system
  systemctl enable --now wg-quick@wg0 ; systemctl restart wg-quick@wg0
  verify: wg show (interface up, expected peers) --> health gate
```

## Implementation Units

- [ ] **Unit 1: Scaffold apps/vpn workspace + config**

**Goal:** Create the `apps/vpn` workspace skeleton, config files, gitignore for client output, and register it in the Bun workspace.

**Requirements:** R13 (partial), R8 (gitignore)

**Dependencies:** None

**Files:**
- Create: `apps/vpn/package.json`, `apps/vpn/config/peers.json` (empty `{"peers": []}`), `apps/vpn/config/wg0.conf.template`, `apps/vpn/config/wg-forwarding.conf`, `apps/vpn/clients/.gitkeep`, `apps/vpn/AGENTS.md` (placeholder)
- Modify: `package.json` (workspaces already glob `apps/*`; add `provision:vpn`/`deploy:vpn` scripts), `.gitignore` (add `apps/vpn/clients/*` keeping `.gitkeep`)
- Create: `apps/vpn/package.json` must add `@aws-sdk/client-lightsail` dependency

**Approach:**
- Mirror `apps/gateway/package.json` name pattern: `@marcusrbrown/infra-vpn`, private.
- `peers.json` starts empty; `wg0.conf.template` documents the server stanza shape (no secrets).
- Run `bun install` to update `bun.lock` (CI `--frozen-lockfile` requires it).

**Test expectation:** none — pure scaffolding/config. (`docker compose config`-equivalent validation is N/A; verify `bun install` succeeds and lockfile updates.)

**Verification:** `bun install` clean, `apps/vpn` resolves as a workspace member, `@aws-sdk/client-lightsail` present in lockfile, `apps/vpn/clients/` gitignored except `.gitkeep`.

- [ ] **Unit 2: Lightsail provisioning script**

**Goal:** TypeScript Lightsail provisioner: import key, resolve blueprint/bundle live, create instance, allocate+attach static IP, set the exact firewall ruleset (SSH 22 + UDP 51820, closing default 80/443), install WireGuard, wait for SSH, pin the IP host key, print the static IP. Idempotent + `--force` + partial-state repair.

**Requirements:** R1, R2, R2a, R3

**Dependencies:** Unit 1

**Files:**
- Create: `apps/vpn/server/provision-droplet.ts`, `apps/vpn/server/provision-droplet.test.ts`

**Approach:**
- `new LightsailClient({region: 'eu-west-1'})` (env credential chain).
- Idempotency guard via `GetInstancesCommand` (Lightsail-native; do NOT reuse DO `dropletExists`). Existing instance → abort unless `--force`; if instance exists but static IP/firewall missing → repair.
- `ImportKeyPairCommand(keyPairName: 'fro-bot-vpn', publicKeyBase64: base64(VPN public key))` — idempotent (skip/catch "already exists"). **Verify Ed25519 acceptance here**; fall back to RSA for this box only if rejected (record outcome in AGENTS.md).
- `GetBlueprintsCommand` → newest Ubuntu LTS `blueprintId`; `GetBundlesCommand` → smallest IPv4 `bundleId`.
- `CreateInstancesCommand` (availabilityZone `eu-west-1a`), poll `GetInstanceCommand` until `state.name === 'running'`.
- `AllocateStaticIpCommand('fro-bot-vpn-ip')` + `AttachStaticIpCommand`; `GetStaticIpCommand` for the IP.
- `PutInstancePublicPortsCommand({portInfos: [{fromPort:22,toPort:22,protocol:'tcp'}, {fromPort:51820,toPort:51820,protocol:'udp'}]})` — set-exact ruleset; SSH 22 MUST be included (Put replaces the whole set); closes default 80/443.
- Install WireGuard on the fresh box: `ssh "apt-get update && apt-get install -y wireguard"` (not present on a vanilla Ubuntu LTS image) — before any `wg` use.
- Reuse shared `materializeIdentityFile`, `waitForSsh`. For host-key pinning, pin the **IP only** in v1 (no domain per NG4) into `.github/known_hosts`; fail closed if pinning fails. (The shared `pinHostKeys` takes a domain + IP; v1 needs an IP-only path — either pass the IP for both args or add an IP-only variant. Decide at implementation; the requirement is an unhashed-for-CI / IP entry that strict-host-key-checking CI can match.)
- After provisioning, **print the allocated static IP** so the operator seeds it into `.env` + the `vpn` GitHub Environment as `VPN_HOST` before the first deploy (bootstrap ordering).
- `if (import.meta.main)` guard so tests never make live AWS calls.

**Execution note:** Implement test-first — load `systematic:test-driven-development` and follow RED-GREEN-REFACTOR. Inject the Lightsail client (or a thin command-runner seam) so tests assert command construction without real AWS calls.

**Patterns to follow:** `apps/gateway/server/provision-droplet.ts` (control flow, `--force` guard, `import.meta.main`), `apps/cliproxy/server/provision-droplet.ts`.

**Test scenarios:**
- Happy path: fresh provision constructs ImportKeyPair → GetBlueprints → GetBundles → CreateInstances → poll → Allocate/Attach static IP → PutInstancePublicPorts in order, with the ruleset exactly `[{fromPort:22,toPort:22,protocol:'tcp'},{fromPort:51820,toPort:51820,protocol:'udp'}]`.
- Edge: instance already exists, no `--force` → aborts without creating.
- Edge: instance exists but static IP not attached → repairs (attaches) without re-creating the instance.
- Edge: instance exists but the firewall ruleset isn't exactly {SSH 22, UDP 51820} → repairs it.
- Happy path: firewall PutInstancePublicPorts call includes BOTH SSH 22 (tcp) AND UDP 51820 (udp) — asserted, so the set-exact call never locks out SSH.
- Edge: ImportKeyPair "already exists" error → swallowed (idempotent), provisioning continues.
- Happy path: WireGuard install step runs before any `wg`/key generation.
- Error: blueprint/bundle resolution returns empty → throws actionable error (no CreateInstances call).
- Error: host-key pinning fails → provisioning fails closed (does not report success).
- Happy path: poll transitions pending→running before proceeding to static IP.
- Happy path: allocated static IP is printed for the operator to seed `VPN_HOST`.

**Verification:** Unit tests green; no live AWS calls during `bun test`; the firewall ruleset is asserted to contain SSH 22 + UDP 51820 exactly (no lockout, default ports closed).

- [ ] **Unit 3: Peer model + wg0.conf rendering**

**Goal:** `peers.ts` — read/write `peers.json`, allocate next tunnel IP, render full `wg0.conf` declaratively from peers + persisted server key, generate client `.conf`.

**Requirements:** R6, R7 (model), R8 (client conf shape)

**Dependencies:** Unit 1

**Files:**
- Create: `apps/vpn/src/peers.ts`, `apps/vpn/src/peers.test.ts`

**Approach:**
- `peers.json` schema: `{peers: [{name, publicKey, tunnelIp}]}` (Zod-validated, public keys only).
- Next-IP allocation: sequential `10.8.0.N/32` starting at `.2` (`.1` reserved for server); `remove` frees the slot.
- `renderServerConfig(serverPrivateKey, peers)` → full `[Interface]` + one `[Peer]` per entry. NAT `PostUp`/`PostDown` masquerade + `Address 10.8.0.1/24` + `ListenPort 51820`.
- `renderClientConfig({clientPrivateKey, serverPublicKey, endpoint, allowedIps})` → client `.conf`; `allowedIps` defaults `0.0.0.0/0`, split-tunnel overrides.
- Pure functions (no IO for rendering) so tests are deterministic; file read/write is a thin separate layer.

**Execution note:** Test-first — load `systematic:test-driven-development`. Rendering is pure and highly testable.

**Patterns to follow:** Zod validation as in `packages/cli/src/commands/cliproxy/` `/v1/models` parsing; declarative-render-from-source-of-truth like cliproxy config handling.

**Test scenarios:**
- Happy path: render server config with 0 / 1 / 3 peers → exact `[Peer]` count, correct PublicKey + AllowedIPs (`10.8.0.N/32`) per peer.
- Happy path: next-IP allocation is sequential, skips `.1`, reuses freed slots after remove.
- Edge: duplicate peer name rejected.
- Edge: `peers.json` malformed/wrong-shape → Zod throws (fail-closed, no silent empty render).
- Happy path: client config full-tunnel default `AllowedIPs = 0.0.0.0/0`; `--split-tunnel 10.0.0.0/8,192.168.0.0/16` produces those routes.
- Edge: removing a non-existent peer → clear error, no mutation.

**Verification:** Rendering is deterministic and declarative; a removed peer does not appear in rendered config.

- [ ] **Unit 4: Deploy script (native WireGuard)**

**Goal:** `deploy.ts` — validate env + host, materialize SSH key (CI), ensure persisted server key (atomic, preserved), render + write `wg0.conf` via SSH stdin, set ip_forward, control `wg-quick@wg0`, health-gate on `wg show`.

**Requirements:** R4, R5, R5a (surface key), R6, R8 (stdin not argv)

**Dependencies:** Units 2, 3

**Files:**
- Create: `apps/vpn/src/deploy.ts`, `apps/vpn/src/deploy.test.ts`
- Create: `apps/vpn/src/host.ts`, `apps/vpn/src/host.test.ts`

**Approach:**
- `validateEnv`: require `VPN_HOST` (the static IP/endpoint), SSH context (`SSH_AUTH_SOCK` local or `VPN_SSH_KEY` in CI), `--force-server-key` opt-in.
- `validateVpnHost(host)` before any SSH argv (rejects `-`-prefixed / invalid — mirror `gateway/src/host.ts`).
- Server key: `ssh "umask 077; test -f /etc/wireguard/server.key || (wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub)"` then read back **only** `server.pub`. Atomic; preserved on redeploy unless `--force-server-key`. The private key never leaves the box.
- Render `wg0.conf` **server-side**: ship `peers.json` over SSH stdin and have the box assemble `/etc/wireguard/wg0.conf` referencing its local `/etc/wireguard/server.key`. The server private key is never transmitted to the local machine / CI runner.
- Write `wg-forwarding.conf` to `/etc/sysctl.d/`, `sysctl --system`.
- `systemctl enable --now wg-quick@wg0` then `systemctl restart wg-quick@wg0` to pick up config.
- Health gate: `wg show wg0` → interface present + expected peer count; freshness not just liveness.
- Injectable `SpawnFn` for testability (gateway/umami pattern); ControlMaster via shared `ssh` helper.

**Execution note:** Test-first — load `systematic:test-driven-development`. Mock `SpawnFn`; assert command construction + ordering, never spawn real SSH.

**Patterns to follow:** `apps/gateway/src/deploy.ts` (SSH-stdin writes, host validation, `SpawnFn`, ControlMaster), `apps/cliproxy/src/deploy.ts` (config preservation: skip overwrite unless forced).

**Test scenarios:**
- Happy path: deploy validates env+host, materializes key (CI branch), ensures server key, writes wg0.conf via stdin, sets ip_forward, restarts service, health-gates — in order.
- Edge: server key already present → not regenerated (no `wg genkey`), only `server.pub` read back.
- Edge: `--force-server-key` → regenerates (warned).
- Error: missing `VPN_HOST` / SSH context → throws before any SSH call.
- Error: `validateVpnHost` rejects `-oProxyCommand=...` style host → throws before SSH argv built.
- Integration: server PRIVATE key is never read to the local process — assert deploy only reads `server.pub`, and `peers.json` (not the private key) is what crosses SSH stdin.
- Integration: peers/config bytes go through SSH stdin, never appear in argv (assert spawn args contain no peer/config bytes).
- Error: `wg show` shows interface down / wrong peer count → deploy fails (health gate).
- Edge (host.ts): valid IP / valid hostname pass; `-`-prefixed, empty, metacharacter hosts rejected (mirror gateway host tests).

**Verification:** Deploy is idempotent on redeploy (server key preserved, peers reconciled); health gate proves the interface is actually up.

- [ ] **Unit 5: CLI command group (status/deploy/logs/client) + host validator**

**Goal:** `packages/cli/src/commands/vpn/` command group with `status`, `deploy`, `logs`, `client add|list|remove`, a CLI-side host validator, and `getVpnStatusSummary()`; registered in `cli.ts`.

**Requirements:** R7, R8, R9, R10 (aggregator)

**Dependencies:** Units 3, 4

**Files:**
- Create: `packages/cli/src/commands/vpn/index.ts`, `status.ts`, `deploy.ts`, `logs.ts`, `client.ts`, `host.ts`, `shared.ts` + colocated `*.test.ts` for each behavior-bearing file
- Modify: `packages/cli/src/cli.ts` (`registerVpnCommands`)

**Approach:**
- `status`: SSH + `wg show` summary (+ server public key per R5a), via `getVpnStatusSummary()` returning a structured summary; Mode A/Mode C per MCP needs (Unit 6).
- `deploy`: thin wrapper invoking `apps/vpn/src/deploy.ts` (remote `workflow_dispatch` default, `--local` parity like other apps); `--force-server-key` surfaced.
- `logs`: `journalctl -u wg-quick@wg0` stream (CLI-only; not MCP — may reveal IPs/peer data).
- `client add|list|remove`: call `peers.ts`; `add` generates keypair locally, writes client `.conf` to `apps/vpn/clients/`, updates `peers.json`, triggers redeploy.
- `host.ts`: `validateVpnHost` (CLI-side mirror), used by every SSH-spawning command. `SpawnFn` injection for tests.

**Execution note:** Test-first for `client` (peer mutation) and `host` — load `systematic:test-driven-development`.

**Patterns to follow:** `packages/cli/src/commands/gateway/` (barrel, host.ts, `SpawnFn`, aggregator), `packages/cli/src/commands/cliproxy/` (multi-subcommand `client`-like grouping).

**Test scenarios:**
- Happy path: `vpn client add laptop` → generates keypair, assigns next IP, appends public key to peers.json, writes `apps/vpn/clients/laptop.conf`, conf contains client private key + correct endpoint/AllowedIPs.
- Edge: client private key never written to a tracked path — the write path refuses (throws) if the target is git-tracked / not ignored (a runtime guard, not gitignore-only), with a test that fails if `clients/` stops being ignored.
- Happy path: `vpn client remove laptop` removes from peers.json; `client list` reflects it.
- Happy path: `status` aggregator returns structured summary including server public key.
- Error: SSH-spawning commands call `validateVpnHost` before constructing argv (host injection rejected).
- Help: `vpn --help` / `vpn client --help` snapshot (NO_COLOR=1, version normalized).

**Verification:** `vpn` group registered; help renders; client private keys only reach gitignored output.

- [ ] **Unit 6: Unified status + MCP integration**

**Goal:** Wire `vpn` into the unified `status` dashboard and expose `vpn status` over MCP (read-only); keep `deploy`/`logs`/`client` CLI-only.

**Requirements:** R10, R11

**Dependencies:** Unit 5

**Files:**
- Modify: `packages/cli/src/commands/status.ts` (compose `getVpnStatusSummary()`), `packages/cli/src/commands/mcp.ts` (add `vpn status` to `MCP_ALLOWLIST`; ensure action threads `ctx`)
- Modify/verify: `packages/cli/src/commands/vpn/status.ts` uses `ctx.console`/`ctx.process` (MCP-capturable), not global console
- Test: `packages/cli/src/commands/mcp.test.ts` (allowlist includes `vpn status`, mutating vpn commands excluded), `status.test.ts`

**Approach:**
- `getVpnStatusSummary()` joins the unified dashboard alongside the other apps (no helper-name collisions).
- `vpn status` Mode A (void + `ctx.process.exit(1)` on degraded) unless structured data is needed; mutating/sensitive commands source-gated out of `MCP_ALLOWLIST` AND denied in `opencode.jsonc` (defense-in-depth, per repo MCP rules).
- `vpn status` reaches the box over SSH + `wg show` only (no Lightsail/AWS API call), so the MCP runtime needs no AWS credentials — asserted in tests.
- Update the `opencode.jsonc` drift-guard test to assert `vpn` mutating/log commands are gated.

**Execution note:** Test-first for the allowlist drift guard.

**Patterns to follow:** `packages/cli/src/commands/mcp.ts` `MCP_ALLOWLIST`, `gateway status` Mode A, the inverted drift-guard test (PR #374 pattern).

**Test scenarios:**
- Happy path: unified `status` includes a VPN row from `getVpnStatusSummary()`.
- Happy path: `MCP_ALLOWLIST` contains `vpn status`.
- Edge: `vpn deploy`/`vpn logs`/`vpn client *` are NOT in `MCP_ALLOWLIST` (excluded) and are denied in `opencode.jsonc`.
- Integration: `vpn status` MCP action output is captured via `ctx.console` (Tier-1 InMemoryTransport test if mirroring existing MCP integration tests).
- Edge: `vpn status` does not import/construct a Lightsail/AWS client (assert the status path is SSH-only, so MCP needs no AWS creds).

**Verification:** `vpn status` is MCP-exposed; all mutating/log vpn commands are CLI-only by both source-gate and config-deny.

- [ ] **Unit 7: Gated deploy workflow + router wiring**

**Goal:** `deploy-vpn.yaml` gated workflow + wire into `deploy.yaml` router with paths-filter negations and `predicate-quantifier: every`.

**Requirements:** R12

**Dependencies:** Units 2, 4

**Files:**
- Create: `.github/workflows/deploy-vpn.yaml`
- Modify: `.github/workflows/deploy.yaml` (router: add `vpn` filter + dispatch)

**Approach:**
- Mirror `deploy-gateway.yaml`: `environment: vpn`, required-secret preflight (`VPN_SSH_KEY`, `VPN_HOST`, AWS creds for status-only?), SHA-pinned actions, `.yaml` extension, Node 24 pin where lint/tsc run, host keys from committed `.github/known_hosts`, ControlMaster-aware deploy.
- `deploy.yaml` paths-filter: add `vpn` predicate matching `apps/vpn/**` + `packages/cli/src/commands/vpn/**`, with doc/test negations and `predicate-quantifier: every`.
- Workflow forwards `VPN_SSH_KEY` to the deploy step's env (not just ssh-agent) — the gateway lesson.

**Test expectation:** none in this unit beyond conventions — `packages/cli/src/conventions.test.ts` already asserts `.yaml`, SHA-pin+comment, no `ssh-keyscan`, no stray `.sh`. Verify it scans the new workflow.

**Patterns to follow:** `.github/workflows/deploy-gateway.yaml`, `deploy.yaml` router, `packages/cli/src/conventions.test.ts`.

**Test scenarios:**
- Convention gate: `deploy-vpn.yaml` passes the existing conventions test (SHA-pinned w/ version comment, `.yaml`, no `ssh-keyscan`, no `secrets: inherit`).
- (Manual/CI verification at deploy time, not unit-test): paths-filter triggers `vpn` only for `apps/vpn/**` changes, not docs/tests.

**Verification:** Workflow YAML parses; conventions test green; router has a `vpn` branch.

- [ ] **Unit 8: Docs, conventions, runbook, changeset**

**Goal:** `apps/vpn/AGENTS.md` + `README.md`, root `AGENTS.md`/`README.md`/`ARCHITECTURE.md`/`STRUCTURE.md` updates, old-EC2-teardown + reprovision-recovery runbook, conventions coverage check, changeset for the CLI surface.

**Requirements:** R5a, R13

**Dependencies:** Units 1-7

**Files:**
- Create: `apps/vpn/AGENTS.md`, `apps/vpn/README.md`, `docs/runbooks/vpn-egress-box.md`
- Modify: root `AGENTS.md` (secrets table, where-to-look, commands), `README.md` (via `/generate-readme` rules — apps badge + summary), `ARCHITECTURE.md`/`STRUCTURE.md` (new app), `.changeset/` (minor — new published CLI command group)

**Approach:**
- `apps/vpn/AGENTS.md`: deploy flow, server-key preservation invariant (private key never leaves the box; server-side render), reprovision = server-identity change (R5a), IAM action set + provisioning-only credential scope (OQ4), Ed25519-vs-RSA outcome, no-Docker rationale, privacy/logging posture.
- Runbook: **why Ireland** (durable region rationale so a future maintainer understands the endpoint choice without the compliance context being in source), old `us-west-2` EC2 termination (manual console), reprovision-recovery (server.key backup/restore vs reissue — OQ5), `VPN_HOST` bootstrap (provision → capture printed static IP → seed secret → first deploy), client onboarding.
- Use the project doc-generation skill conventions; root README per `/generate-readme` `<badges>` rules (vpn deploy-status badge for the new app).
- Changeset: minor — adds the `vpn` published command group to `@marcusrbrown/infra`.

**Test expectation:** none — docs/changeset. Conventions test already covers structural rules; verify it stays green.

**Patterns to follow:** `apps/gateway/AGENTS.md`, `apps/gateway/README.md`, `docs/runbooks/gateway-announce-event-verification.md`, `.opencode/commands/generate-readme.md`, `.agents/skills/generating-project-docs/SKILL.md`.

**Verification:** Docs accurate to shipped behavior; changeset present; conventions + taxonomy gates green.

## System-Wide Impact

- **Interaction graph:** new `registerVpnCommands` in `cli.ts`; new branch in `deploy.yaml` router; new entry in unified `status`; new `MCP_ALLOWLIST` member. No existing app code paths change.
- **Error propagation:** provisioning fails closed on host-key pinning + blueprint/bundle resolution; deploy fails closed on missing env/host and on `wg show` health gate.
- **State lifecycle risks:** server key + `peers.json` are the persistent state; redeploy must preserve the server key (R5) and reconcile peers declaratively (R6). Reprovision destroys server identity (R5a) — runbook-documented.
- **API surface parity:** `vpn status` follows the same Mode A + `ctx`-threading + aggregator contract as gateway/umami status; host validation mirrors `gateway/host.ts`.
- **Integration coverage:** SSH-stdin-not-argv for config bytes; MCP allowlist drift guard; conventions test for the new workflow.
- **Unchanged invariants:** no change to DO provisioning, existing deploy workflows, existing MCP-exposed commands, or `droplet-helpers.ts` SSH functions (reused, not modified). `packages/` still never imports from `apps/`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Lightsail `ImportKeyPair` rejects Ed25519 (docs emphasize ssh-rsa) | Unit 2 verifies empirically; fall back to an RSA key for this box only; record outcome in AGENTS.md |
| `blueprintId`/`bundleId` hardcoded to non-existent values | Resolve live via `GetBlueprints`/`GetBundles` — never hardcode |
| `PutInstancePublicPorts` (set-exact) closes SSH 22 → lockout | Always include SSH 22 in the ruleset alongside UDP 51820; test asserts both present (set-exact is chosen so default 80/443 are closed) |
| `wireguard-tools` absent on fresh Ubuntu image → first deploy fails | Provisioning installs `wireguard` via apt before any `wg` use |
| `VPN_HOST` bootstrap cycle (IP unknown until provisioned) | Provisioning prints the static IP; operator seeds `VPN_HOST` before first deploy; runbook documents the exact sequence |
| Server private key exposed to local/CI by client-side render | Render `wg0.conf` server-side; private key never leaves the box (only `server.pub` read back) |
| GitHub `vpn` Environment auto-creates ungated on first workflow reference | Pre-create with reviewer + main-only branch policy before merge (umami lesson); watch readonly `UID` |
| First deploy cascade (5-10 attempts expected) | Reuse battle-tested `droplet-helpers.ts`; budget the cascade; write a compound doc after |
| Reprovision silently breaks all clients (lost server key) | R5a documents it; `vpn status` surfaces server public key; runbook covers backup/restore vs reissue |
| AWS IAM credential leakage / over-broad scope | Dedicated least-privilege Lightsail user (separate from gateway S3 keys); action-scoped; documented |
| Stale `bun.lock` breaks `--frozen-lockfile` CI | Run `bun install` + commit lockfile in Unit 1 |

## Documentation / Operational Notes

- Operator prerequisites (pre-merge): create dedicated least-privilege Lightsail IAM user; generate `fro-bot-vpn` Ed25519 key (`VPN_SSH_KEY`); create the `vpn` GitHub Environment with reviewer + main-only branch policy.
- Bootstrap ordering (resolves the `VPN_HOST` cycle): (1) seed AWS provisioning creds + `VPN_SSH_KEY` into `.env`; (2) `bun run provision:vpn` (loads root `.env`) — it allocates the static IP and **prints it**; (3) seed that IP as `VPN_HOST` into `.env` + the `vpn` GitHub Environment; (4) pin the IP host key, commit `.github/known_hosts`; (5) first deploy. AWS creds go only into provisioning context, never the deploy/status `vpn` Environment secrets.
- First Deploy Gateway-style cascade expected — budget attempts, verify live with `wg show` + a real client handshake (not just `systemctl is-active`).
- Post-cutover: terminate the old `us-west-2` OpenVPN EC2 (manual console step).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-09-vpn-egress-box-requirements.md](docs/brainstorms/2026-06-09-vpn-egress-box-requirements.md)
- Related code: `apps/gateway/src/deploy.ts`, `apps/cliproxy/src/deploy.ts`, `apps/gateway/server/provision-droplet.ts`, `packages/shared/server/droplet-helpers.ts`, `packages/cli/src/commands/gateway/`, `packages/cli/src/commands/mcp.ts`, `packages/cli/src/commands/status.ts`, `packages/cli/src/conventions.test.ts`
- Related learnings: `docs/solutions/workflow-issues/{gateway,cliproxy,umami}-first-deploy-cascade-*.md`, `gateway-deploy-stale-image-2026-05-31.md`, `bun-deploy-user-permissions-ci-2026-04-02.md`
- External: AWS SDK for JS v3 `@aws-sdk/client-lightsail@3.1065.0`; WireGuard `wg-quick`/systemd
