---
date: 2026-06-09
topic: vpn-egress-box
---

# VPN Egress Box (`apps/vpn`)

## Summary

Add the first AWS-backed deployable to the infra monorepo: a single-user WireGuard egress box on AWS Lightsail (Ireland, `eu-west-1`, ~$5/mo), managed with full parity to the existing infra services. It is a general-purpose personal VPN the operator owns; a local machine connects to it and routes traffic out through the box's Irish IP. The box runs native WireGuard (`wg-quick@wg0` + systemd), not Docker. Provisioning uses the AWS SDK for JS (replacing the DigitalOcean `doctl` pattern); deploy materializes WireGuard config over SSH and controls the systemd service, mirroring the secret-materialization pattern of the gateway/umami deploys. A `vpn client add` CLI command manages peers, tracking public keys only.

---

## Problem Frame

Every existing infra app (`cliproxy`, `gateway`, `umami`) is a DigitalOcean droplet using the shared `doctl`-based provisioning helpers and Docker Compose. The operator wants a VPN box managed with the same level of support — status, deploy, logs, unified status, MCP, GitHub Actions deploy, AGENTS/runbook docs.

The driving constraint is region, not provider. The VPN's purpose is permitted-region egress, and research established that DigitalOcean has **no** datacenter in a region that is both close to the US and outside a VPN-relevant block list — its near-US datacenters (Amsterdam, London, Frankfurt, Toronto) are all in restricted countries for the intended downstream use. AWS Lightsail offers Ireland (`eu-west-1`), which is the clean low-latency option. This makes the VPN genuinely the first AWS app: there is no DigitalOcean shortcut, and provisioning must move from `doctl` to the AWS SDK.

A decade-old OpenVPN EC2 instance in `us-west-2` exists on the operator's free-tier AWS account but is unused and holds nothing worth keeping. AWS free tier no longer applies to that account (the 12-month window closed years ago), so the box was never going to stay free. The new box replaces it; the old instance is retired as a documented operator step.

This is a deliberate, accepted second-cloud commitment, not an incidental implementation detail. Standing up the first AWS app permanently adds a second provider, a second credential/IAM surface, an SDK dependency, and provider-specific provisioning logic that diverges from the repo's DigitalOcean conventions. The operator accepts that ongoing carrying cost. The compounding value is twofold: the immediate managed VPN, and a reusable AWS-app provisioning pattern that future AWS-backed infra apps can mirror — so the cost is owned once here rather than re-paid per app.

The downstream consumer is the operator's `marcusrbrown/poly` repo (a Python maker-bot needing non-US egress to Polymarket APIs), but the VPN box itself is built provider/destination-agnostic — no Polymarket-specific allowlists or geo-circumvention language in the artifact. Usage decisions, including any third-party terms-of-service considerations, stay with the operator at usage time and out of the infra code.

---

## Actors

- A1. WireGuard server (the Lightsail box): runs `wg-quick@wg0`, NATs/masquerades peer traffic out its public interface, listens on UDP 51820. Holds the server keypair (generated once, persisted).
- A2. VPN client (operator's machine): a WireGuard peer that connects to the box and routes traffic (full-tunnel or split-tunnel) through the Irish IP.
- A3. Provisioning script (`apps/vpn/server/provision-instance.ts`): one-time AWS Lightsail instance creation, static IP attach, firewall (UDP 51820) open, SSH wait, host-key pin.
- A4. Deploy script (`apps/vpn/src/deploy.ts`): materializes `/etc/wireguard/wg0.conf` over SSH from the tracked peers list + persisted server key, controls the systemd service.
- A5. Operator (Marcus): creates the Lightsail-scoped IAM credential, seeds the `vpn` environment, approves the gated deploy, runs `vpn client add`, retires the old EC2 box.

---

## Key Flows

- F1. Provision the box (one-time)
  - **Trigger:** Operator runs `bun run provision:vpn`.
  - **Actors:** A3 (provisioning), A5 (operator).
  - **Steps:** SDK creates the Lightsail instance in `eu-west-1` (Ubuntu) if absent → allocates + attaches a static IP → opens UDP 51820 in the Lightsail firewall → waits for SSH → pins the box's host key into `.github/known_hosts`.
  - **Outcome:** A reachable Lightsail box with a static Irish IP and the WireGuard port open; host key committed for CI.
  - **Covered by:** R1, R2, R9

- F2. Deploy WireGuard config
  - **Trigger:** Operator triggers `vpn deploy` (or merge-triggered gated CI deploy).
  - **Actors:** A4 (deploy), A1 (server).
  - **Steps:** Deploy ensures WireGuard is installed → generates the server keypair on the box once if absent (never rotated on redeploy) → materializes `/etc/wireguard/wg0.conf` over SSH (server key + all peer public keys from `apps/vpn/config/peers.json` + NAT PostUp/PostDown) → writes `ip_forward` sysctl → enables/restarts `wg-quick@wg0`.
  - **Outcome:** The box serves WireGuard with all tracked peers; existing peer connections survive because the server key is preserved.
  - **Covered by:** R3, R4, R5, R6, R10

- F3. Add a client/peer
  - **Trigger:** Operator runs `vpn client add <name>` (optionally `--split-tunnel <cidrs>`).
  - **Actors:** A5 (operator), A4 (deploy), A2 (client).
  - **Steps:** CLI generates a client keypair locally → appends the peer's public key + assigned tunnel IP to `apps/vpn/config/peers.json` (public keys only, tracked) → redeploys so the server learns the peer → writes the client `.conf` (with the private key, server public key, endpoint, AllowedIPs) to a gitignored local file for import into the WireGuard app.
  - **Outcome:** A new device can connect; no secret material is committed.
  - **Covered by:** R7, R8

- F4. Observe + manage (parity)
  - **Trigger:** Operator runs `vpn status` / `vpn logs`, or `infra status`.
  - **Actors:** A5 (operator).
  - **Steps:** `vpn status` reports instance reachability + `wg show` peer/handshake state over SSH; `vpn logs` streams the WireGuard/systemd journal; unified `status` includes the VPN summary; MCP exposes `vpn status` read-only.
  - **Outcome:** The VPN box has the same observability as every other infra app.
  - **Covered by:** R11, R12, R13

- F5. Retire the legacy EC2 box
  - **Trigger:** Operator follows the runbook after the new box is verified.
  - **Actors:** A5 (operator).
  - **Steps:** In the AWS console: terminate the `us-west-2` OpenVPN instance, release its Elastic IP, delete the orphaned security group.
  - **Outcome:** The decade-old box is gone; no automated destructive code in infra.
  - **Covered by:** R14

---

## Requirements

**Provisioning (AWS Lightsail)**
- R1. Provisioning uses the AWS SDK for JS (`@aws-sdk/client-lightsail`) in TypeScript — no `aws` CLI binary, no new Bash. It creates a Lightsail Ubuntu instance in `eu-west-1` if absent, is idempotent/refuses re-create without an explicit force flag (mirroring the droplet provisioners), and reads credentials from a dedicated, least-privilege IAM user scoped to Lightsail in `eu-west-1` only (a distinct credential from the gateway's S3-scoped keys; the minimal action set is resolved in planning per OQ4). Provisioning is also idempotent against partial state: an instance that exists but is missing its static-IP attachment or firewall rule is repaired rather than treated as fully provisioned.
- R2. Provisioning allocates and attaches a Lightsail static IP, opens UDP 51820 in the Lightsail instance firewall via the SDK, waits for SSH, and pins the box's host key (domain/IP) into `.github/known_hosts` using the shared pinning helper. The static IP is the box's durable client-facing identity (client configs bake in `static-ip:51820`); it is allocated as a named, persistent Lightsail static IP so that stop/start does not change it, and reprovisioning re-attaches the same static IP to the new instance where possible (a changed endpoint breaks all clients, so endpoint continuity is an explicit provisioning goal).
- R2a. The box exposes exactly two inbound services: UDP 51820 (WireGuard) and SSH (operator/CI management). No other inbound ports are opened. The egress NAT only forwards traffic from authenticated WireGuard peers — WireGuard drops packets from any source whose public key is not a registered peer, so the box is not an open relay. Provisioning fails closed if the host key cannot be pinned (it does not proceed with an unpinned SSH target), mirroring the strict-host-key-checking posture of the other apps' CI deploys.

**WireGuard runtime (native)**
- R3. The box runs WireGuard natively via `wg-quick@wg0` + systemd (`apt`-installed) — no Docker. The server config lives at `/etc/wireguard/wg0.conf`.
- R4. The server config enables egress NAT: `PostUp/PostDown` iptables MASQUERADE on the public interface + FORWARD accepts, with `net.ipv4.ip_forward=1` persisted via `/etc/sysctl.d/`.
- R5. The server keypair is generated once on the box and persisted at a stable remote path (e.g. `/etc/wireguard/server.key`, mode 0600) **separate from** the rendered `wg0.conf`. Deploy reads the persisted key back and renders it into `wg0.conf`; it generates the key only when that file is absent, and never rotates it on redeploy (so existing peers keep working), mirroring the cliproxy `config.yaml` preservation invariant. An explicit force flag is the only way to regenerate. Generation must be atomic (write to the persisted path before rendering config) so a partial/interrupted deploy cannot leave the box with a config referencing a key that was never saved.
- R5a. Reprovisioning the instance (fresh disk) destroys the persisted server key, which silently invalidates every client config (clients fail to handshake). The runbook must document this: reprovisioning is a server-identity-changing event that requires regenerating the server key and re-issuing client configs (or, if continuity is needed, backing up `/etc/wireguard/server.key` before teardown and restoring it onto the new box). `vpn status` should surface the server public key so a key mismatch is diagnosable.

**Deploy**
- R6. `apps/vpn/src/deploy.ts` materializes `/etc/wireguard/wg0.conf` over SSH (secret/config bytes via SSH stdin, never argv — the repo's secret-materialization invariant), renders all peers from the tracked peers list plus the persisted server key, and enables/restarts `wg-quick@wg0`. Deploy supports both local (`<APP>_SSH_KEY` / ssh-agent) and CI modes like the other apps.

**Peer management**
- R7. A `vpn client add <name>` CLI command generates a client keypair locally, assigns the next tunnel IP, appends the peer's PUBLIC key + tunnel IP to `apps/vpn/config/peers.json` (public keys only — no private material is ever tracked), and redeploys so the server learns the peer. A complementary `vpn client list` / `vpn client remove <name>` round out management. `peers.json` plus the persisted server key are the single source of truth: every deploy renders the full `wg0.conf` from them (declarative, not incremental), so `vpn client remove` followed by a deploy genuinely revokes access rather than leaving a stale peer. `vpn status` reports the live `wg show` peer set so drift between `peers.json` and the running config is observable; an emergency manual edit to the box is expected to be overwritten by the next deploy.
- R8. The command writes the generated client `.conf` (client private key, server public key, endpoint `static-ip:51820`, AllowedIPs) to a gitignored local file and prints its path. Full-tunnel (`0.0.0.0/0`) is the default; a `--split-tunnel <cidrs>` flag sets specific routes. AllowedIPs is purely a client-side decision. The client-config output directory is covered by a committed `.gitignore` entry (e.g. `apps/vpn/clients/`), and the command writes only into that gitignored location so client private keys cannot reach a tracked path. All config/secret bytes — server config on deploy and any remote writes in the peer flow — go via SSH stdin, never argv (the repo's secret-materialization invariant).

**Host validation**
- R9. A `validateVpnHost` validator (deploy-side `apps/vpn/src/host.ts` + CLI-side `packages/cli/src/commands/vpn/host.ts`) rejects `-`-prefixed and invalid hostnames before any SSH argv construction, mirroring the gateway/cliproxy/umami host validators.

**CLI + observability parity**
- R10. A `vpn` command group under `packages/cli/src/commands/vpn/` (`status`, `deploy`, `logs`, `client`, barrel `index.ts` exporting `registerVpnCommands`, `host.ts`), registered in `packages/cli/src/cli.ts`.
- R11. `vpn status` reports instance reachability and WireGuard peer/handshake state (`wg show`) over SSH, redacting the resolved host on error like the gateway/umami status commands.
- R12. `vpn logs` streams the WireGuard/systemd journal over SSH (operator-only; stays off MCP because logs can reveal peer IPs/handshake metadata), consistent with `gateway logs`/`umami logs`.
- R13. The VPN integrates into unified `status` (`packages/cli/src/commands/status.ts`) and exposes only `vpn status` via the MCP allowlist (`MCP_ALLOWLIST`) — read-only, status-only, matching the other apps. All MCP-exposed bodies thread `ctx` for capture.

**Lifecycle + docs**
- R14. The old `us-west-2` OpenVPN EC2 box is retired as a documented operator runbook step (terminate instance, release Elastic IP, delete security group) — no automated destructive AWS code in infra.
- R15. Full doc parity: `apps/vpn/AGENTS.md` (operator runbook incl. provisioning, deploy flow, key-preservation invariant, peer add, legacy teardown), `apps/vpn/README.md`, root `AGENTS.md` updates (new app, `vpn` environment secrets, anti-patterns), and a `docs/runbooks/` entry if day-2 procedures warrant it.

**Infra wiring + conventions**
- R16. Root `package.json` gains `provision:vpn` / `deploy:vpn` wrapper scripts (run from repo root for `.env` loading) and the app joins the `apps/*` workspace; `bun install` refreshes `bun.lock`.
- R17. A gated `deploy-vpn.yaml` workflow (SHA-pinned actions, `.yaml`, environment `vpn` with required reviewer + main-only policy, required-secret validation, committed `known_hosts`, no `ssh-keyscan` in CI) wired into `deploy.yaml`'s paths-filter with `predicate-quantifier: every`. The app satisfies all existing `conventions.test.ts` rules.

---

## Non-Goals

- NG1. No Polymarket-specific configuration in the artifact — no `clob.polymarket.com`/`gamma-api.polymarket.com` allowlists, no geo-circumvention language in source. The box is a general-purpose Ireland-egress VPN; downstream usage and any third-party ToS considerations are the operator's at usage time.
- NG2. No automated/destructive teardown of the legacy EC2 instance — runbook-documented manual operator action only.
- NG3. No multi-region, HA, or multi-tenant scaling. Single box, single region, single operator with a small set of personal devices.
- NG4. No DNS/domain requirement — the box is reached by its static IP. (A domain + `known_hosts` domain entry can be added later if desired but is not required.)
- NG5. No OpenVPN — WireGuard only. OpenVPN-over-TCP-443 is noted in the runbook as a documented fallback strategy if UDP egress is ever blocked, but is not built.

---

## Success Criteria

- SC1. `bun run provision:vpn` creates a Lightsail box in `eu-west-1` with a static IP, UDP 51820 open, host key pinned — reproducibly and idempotently.
- SC2. `vpn deploy` brings up `wg-quick@wg0` with the tracked peers; a redeploy preserves the server key and does not drop existing peers.
- SC3. `vpn client add <name>` produces an importable client `.conf` (gitignored), and after deploy the operator's machine connects and egresses from the Irish static IP (verifiable: external IP geolocates to Ireland).
- SC4. `vpn status`, `vpn logs`, `infra status`, and the `vpn status` MCP tool all work with the same fidelity as the other apps.
- SC5. The app passes `conventions.test.ts`, `tsc`, lint, and the full test suite; no secret material is tracked (`peers.json` holds public keys only; client `.conf` files are gitignored).
- SC6. The legacy `us-west-2` EC2 box is retired per the runbook.

---

## Open Questions (for planning)

- OQ1. Exact peer tunnel-IP assignment scheme (sequential `10.8.0.N/32` allocation in `peers.json`) and how `vpn client remove` reclaims IPs.
- OQ2. Whether `vpn status` reachability uses a UDP handshake probe vs SSH + `wg show` only (SSH + `wg show` is the baseline; a client-side handshake check is operator-side).
- OQ3. Whether a domain (e.g. via the operator's DNS) is worth adding for the endpoint, or static IP is sufficient (NG4 says IP is sufficient for v1).
- OQ4. Minimal IAM action set + resource ARNs for the dedicated Lightsail user (region-scoped to `eu-west-1`) — the concrete least-privilege policy is resolved in planning; R1 fixes the requirement (dedicated, region-scoped, least-privilege).
- OQ5. Exact reprovision-recovery procedure: whether to back up/restore `/etc/wireguard/server.key` for endpoint+identity continuity, or accept regenerate-and-reissue as the documented recovery path (R5a frames the requirement; planning picks the procedure).
