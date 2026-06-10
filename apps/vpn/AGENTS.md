# VPN Deploy Package

The VPN box is a single-user WireGuard egress box on AWS Lightsail (`eu-west-1`, Ireland) — the first AWS-backed deployable in this repo. Native `wg-quick@wg0` + systemd (no Docker). Provisioned via `@aws-sdk/client-lightsail`; deployed over SSH. The static IP is the durable client-facing endpoint; no domain in v1.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Deploy script | `apps/vpn/src/deploy.ts` | Server-key preservation, wg0.conf render, health gate |
| Provision script | `apps/vpn/server/provision.ts` | Lightsail SDK; one-time. Refuses re-run without `--force` |
| Peer model | `apps/vpn/src/peers.ts` (shared: `packages/shared/vpn/peers.ts`) | peers.json read/write, next-IP allocation, config rendering |
| CLI commands | `packages/cli/src/commands/vpn/` | status, deploy, logs, client add\|list\|remove |
| Peer config | `apps/vpn/config/peers.json` | Public keys + tunnel IPs only — no private material |
| Client output | `apps/vpn/clients/` | Gitignored — client `.conf` files with private keys |
| Config template | `apps/vpn/config/wg0.conf.template` | Documents the server stanza shape (no secrets) |
| IP forwarding | `apps/vpn/config/wg-forwarding.conf` | `sysctl.d` snippet shipped to the box on deploy |

## DEPLOY FLOW

Deploy is SSH-only. No Docker, no Compose. The box runs native `wg-quick@wg0` under systemd.

1. **Validate env + host** — `VPN_HOST` and SSH context (`SSH_AUTH_SOCK` local or `VPN_SSH_KEY` in CI) are required. `validateVpnHost` rejects `-`-prefixed values and characters outside the allowed alphabet before any SSH argv is constructed.
2. **Materialize SSH key** (CI only) — `VPN_SSH_KEY` is written to a `0600` temp file via `materializeIdentityFile`; cleaned up after.
3. **Ensure server key** — `ssh "umask 077; test -f /etc/wireguard/server.key || (wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub)"`. Atomic; preserved on redeploy unless `--force-server-key`. The server PRIVATE key never leaves the box.
4. **Read back server.pub** — only the public key is read back for status/diagnosis. The private key is never transmitted.
5. **Render wg0.conf server-side** — `peers.json` is shipped over SSH stdin; the box assembles `/etc/wireguard/wg0.conf` referencing its local `/etc/wireguard/server.key`. Config bytes go through SSH stdin, never argv.
6. **Write ip_forward snippet** — `wg-forwarding.conf` is written to `/etc/sysctl.d/`; `sysctl --system` applies it.
7. **Control wg-quick@wg0** — `systemctl enable --now wg-quick@wg0` then `systemctl restart wg-quick@wg0` to pick up the new config.
8. **Health gate** — `wg show wg0` confirms the interface is up and the expected peer count is present. Freshness, not just liveness.

### Server-key preservation invariant

The server private key is generated once on the box and persisted at `/etc/wireguard/server.key` (mode `0600`). Deploy preserves it on every redeploy. `--force-server-key` rotates it (warned). Rotating the server key invalidates all existing client configs — every peer must receive a new client config after rotation.

### Server-side config render

`wg0.conf` is rendered declaratively on the box from `peers.json` + the persisted server private key. A removed peer is genuinely revoked on the next deploy. Emergency manual edits to `/etc/wireguard/wg0.conf` are overwritten by the next deploy.

## ONE-TIME PROVISIONING

**Prerequisites:**

- Dedicated least-privilege Lightsail IAM user created (see [IAM note](#iam-note) below); `VPN_AWS_ACCESS_KEY_ID` + `VPN_AWS_SECRET_ACCESS_KEY` in the repo-root `.env`. These are distinct from the gateway's `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (S3-scoped, lacks Lightsail permissions).
- `wg-egress` Ed25519 keypair generated; public key available; `VPN_SSH_KEY` (private key) in `.env`
- `vpn` GitHub Environment created with required reviewer + main-only branch policy (pre-create before merge — auto-create is ungated)

**Run:**

```bash
bun run provision:vpn
```

(Root wrapper — loads the repo-root `.env`; `--cwd apps/vpn` would miss it.)

The script will:

1. Validate `VPN_AWS_ACCESS_KEY_ID` and `VPN_AWS_SECRET_ACCESS_KEY` are present
2. Reject if the `wg-egress` instance already exists (aborts; `--force` to override)
3. Import the `wg-egress` Ed25519 public key into Lightsail (idempotent — skips if already present)
4. Resolve the current Ubuntu LTS blueprint ID and smallest IPv4 bundle ID live via `GetBlueprintsCommand`/`GetBundlesCommand` (never hardcoded)
5. Create the instance in `eu-west-1a`, poll until `state.name === 'running'`
6. Allocate + attach the `wg-egress-ip` static IP
7. Set the exact firewall ruleset: SSH 22 (tcp) + UDP 51820 — closes Lightsail's default 80/443 (`PutInstancePublicPortsCommand` replaces the whole set; SSH 22 is always included to prevent lockout)
8. Wait for SSH (`waitForSsh` shared helper)
9. Install WireGuard: `sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard`
10. Pin the IP host key into `.github/known_hosts` (IP-only in v1; fail closed if pinning fails)
11. **Print the allocated static IP** — operator seeds this as `VPN_HOST` into `.env` + the `vpn` GitHub Environment before the first deploy

After provisioning: commit the updated `.github/known_hosts` before the first CI deploy.

### Bootstrap ordering

The `VPN_HOST` cycle: the static IP is unknown until provisioning runs. Sequence:

1. Seed `VPN_AWS_ACCESS_KEY_ID`, `VPN_AWS_SECRET_ACCESS_KEY`, `VPN_SSH_KEY` into `.env`
2. `bun run provision:vpn` — allocates the static IP and prints it
3. Seed the printed IP as `VPN_HOST` into `.env` + the `vpn` GitHub Environment
4. Commit the updated `.github/known_hosts`
5. First deploy: `bunx @marcusrbrown/infra vpn deploy`

`VPN_AWS_*` credentials are used only during provisioning. They are not required for deploy or status — those reach the box over SSH only. Optionally set `VPN_AWS_REGION` to override the default `eu-west-1` (note: the availability zone is hardcoded to `eu-west-1a` — only `eu-west-1` is supported).

### IAM note

Lightsail IAM is action-scoped, not ARN-scoped — many Lightsail actions require `Resource: *`. The provisioning IAM user holds the minimal Lightsail action set needed for provisioning only (instance create/get, static IP allocate/attach/get, firewall set, key pair import, blueprint/bundle list). It is a dedicated user separate from the gateway's S3 keys. AWS credentials are bounded to the provisioning path — deploy and status never need them.

Ed25519 key import: `ImportKeyPairCommand` is called with the Ed25519 public key encoded as base64. Lightsail historically documented RSA keys; Ed25519 import is attempted. If Lightsail rejects Ed25519 at runtime, fall back to an RSA key for this box only and record the outcome here.

## REQUIRED SECRETS

| Secret | Required | Description |
| --- | --- | --- |
| `VPN_SSH_KEY` | ✓ | Ed25519 private key for the VPN box (`wg-egress` keypair) |
| `VPN_HOST` | ✓ | Static IP of the Lightsail instance (printed by provisioning) |

Both secrets are scoped to the `vpn` GitHub Environment. AWS provisioning credentials (`VPN_AWS_ACCESS_KEY_ID`, `VPN_AWS_SECRET_ACCESS_KEY`, and optional `VPN_AWS_REGION`) are operator-local only — they are NOT in the `vpn` Environment and are never used by the deploy or status paths.

## CLI COMMANDS

| Command | Purpose |
| --- | --- |
| `bunx @marcusrbrown/infra vpn status` | SSH to box, run `wg show wg0`, show interface state + server public key + peer count |
| `bunx @marcusrbrown/infra vpn deploy` | Trigger the deploy workflow via `gh workflow run` (remote, default). `--local` runs the deploy script directly (requires `SSH_AUTH_SOCK`). `--force-server-key` rotates the server key (invalidates all client configs). |
| `bunx @marcusrbrown/infra vpn logs [--tail N]` | Stream `journalctl -u wg-quick@wg0` from the box. Logs may reveal peer IPs; operator-only via SSH boundary. |
| `bunx @marcusrbrown/infra vpn client add <name>` | Generate a client keypair locally, assign the next tunnel IP, append the public key to `peers.json`, write the client `.conf` to `apps/vpn/clients/`, trigger redeploy. |
| `bunx @marcusrbrown/infra vpn client list` | List peers from `peers.json` (name, tunnel IP, public key). |
| `bunx @marcusrbrown/infra vpn client remove <name>` | Remove a peer from `peers.json` and trigger redeploy (peer is revoked on next deploy). |

`vpn status` is MCP-exposed (read-only). All other vpn commands are CLI-only (mutating or sensitive).

## PEER MODEL

Peers are tracked in `apps/vpn/config/peers.json` — public keys and tunnel IPs only, never private material. The schema: `{peers: [{name, publicKey, tunnelIp}]}` (Zod-validated).

Tunnel IPs are sequential `10.8.0.N/32` starting at `.2` (`.1` is reserved for the server). `client remove` frees the slot; `client add` reuses freed slots.

Client `.conf` files (containing the client private key) are written only to `apps/vpn/clients/` — a gitignored directory. The deploy refuses to write a client config to a git-tracked path.

## DAY-2 OPERATIONS

- **Monitoring** — `vpn status` for live interface state; `vpn logs` to stream journalctl output.
- **Roll back a bad deploy** — the deploy is idempotent and preserves the server key. Fix the underlying issue and retry.
- **Add a peer** — `vpn client add <name>`. The client `.conf` is written to `apps/vpn/clients/<name>.conf`.
- **Remove a peer** — `vpn client remove <name>`. The peer is revoked on the next deploy.
- **Rotate the server key** — `vpn deploy --force-server-key`. All existing client configs become invalid; reissue every client config after rotation.
- **Reprovision (fresh disk)** — see [Reprovision recovery](#reprovision-recovery) below.

## REPROVISION RECOVERY

Reprovisioning creates a fresh disk, which destroys the server private key at `/etc/wireguard/server.key`. The static IP is re-attached (endpoint unchanged), but all clients fail the cryptographic handshake — a silent break. `vpn status` surfaces the server public key so a key mismatch is diagnosable.

Two recovery paths:

1. **Backup/restore for continuity** — before reprovisioning, back up `/etc/wireguard/server.key` from the old box (operator-manual, `scp` or `ssh cat`). After reprovisioning and first deploy, restore the key to `/etc/wireguard/server.key` (mode `0600`) and restart `wg-quick@wg0`. Existing client configs continue to work.

2. **Regenerate and reissue** — let the new box generate a fresh server key on first deploy. Run `vpn client add` for every peer to generate new client configs. Distribute the new configs to each peer.

The runbook in `docs/runbooks/vpn-egress-box.md` covers the full reprovision sequence.

## ANTI-PATTERNS

- **Never `ssh-keyscan` in CI** — host keys are pinned in `.github/known_hosts` at provision time and committed. Provisioning scripts may use `ssh-keyscan` locally.
- **Never pass secret bytes via argv** — config bytes and peer data go through SSH stdin only. `--body <value>` patterns are banned.
- **Never skip `validateVpnHost`** — it rejects `-`-prefixed values and characters outside the allowed alphabet. SSH treats `-`-prefixed hostnames as flags (including `-oProxyCommand=`).
- **Never read the server private key to the local machine or CI runner** — deploy reads back only `server.pub`. The private key stays on the box.
- **Never hardcode `blueprintId` or `bundleId`** — resolve live via `GetBlueprintsCommand`/`GetBundlesCommand`. Hardcoded IDs risk a non-existent-ID failure.
- **Never omit SSH 22 from `PutInstancePublicPortsCommand`** — the command replaces the entire ruleset; omitting SSH 22 locks out the operator. The firewall ruleset always includes both SSH 22 (tcp) and UDP 51820.
- **Never use Docker for the VPN runtime** — native `wg-quick@wg0` + systemd is the correct pattern for a single-box WireGuard setup.
- **Never use AWS credentials in the deploy or status paths** — AWS creds are provisioning-only. Deploy and status reach the box over SSH; the MCP runtime needs no AWS credentials.

## PRIVACY POSTURE

The box is an egress relay for a single user. WireGuard logs no traffic by default. `journalctl` output (peer IPs, connection events) is accessible only via `vpn logs` (CLI-only, SSH-gated, never MCP). The operator controls what is logged and for how long via standard systemd journal retention on the box.

## DECOMMISSIONING

1. `vpn client remove <name>` for each peer (or skip if decommissioning entirely).
2. Delete the `wg-egress` instance and `wg-egress-ip` static IP in the AWS Lightsail console.
3. Remove the VPN IP entry from `.github/known_hosts`.
4. Delete the `vpn` GitHub Environment.
5. Terminate the old `us-west-2` OpenVPN EC2 instance (manual AWS console step — see `docs/runbooks/vpn-egress-box.md`).
