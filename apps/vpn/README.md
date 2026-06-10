# VPN

[![Deploy VPN](https://github.com/marcusrbrown/infra/actions/workflows/deploy-vpn.yaml/badge.svg)](https://github.com/marcusrbrown/infra/actions/workflows/deploy-vpn.yaml)

WireGuard egress box on AWS Lightsail (`eu-west-1`, Ireland). The first AWS-backed deployable in this repo.

Native `wg-quick@wg0` + systemd (no Docker). Provisioned via `@aws-sdk/client-lightsail`; deployed over SSH. The static IP is the durable client-facing endpoint. Peer configs are tracked in `apps/vpn/config/peers.json` (public keys only); client `.conf` files are written to the gitignored `apps/vpn/clients/` directory.

## Deploy

Via the CLI (triggers GitHub Actions by default):

```bash
bunx @marcusrbrown/infra vpn deploy             # remote (GitHub Actions)
bunx @marcusrbrown/infra vpn deploy --local     # direct SSH (requires SSH_AUTH_SOCK)
bunx @marcusrbrown/infra vpn deploy --force-server-key  # rotate server key (invalidates all client configs)
```

Via the root wrapper (loads the repo-root `.env`):

```bash
bun run deploy:vpn
```

## Provisioning

One-time: creates the Lightsail instance, allocates a static IP, sets the exact firewall ruleset (SSH 22 + UDP 51820), installs WireGuard, and pins the IP host key. Refuses to re-run against an existing instance without `--force`.

**Prerequisites:**

- Dedicated least-privilege Lightsail IAM user created; `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` in the repo-root `.env`
- `wg-egress` Ed25519 keypair generated; `VPN_SSH_KEY` (private key) in `.env`
- `vpn` GitHub Environment created with required reviewer + main-only branch policy

Use the root wrapper (loads the repo-root `.env`):

```bash
bun run provision:vpn
```

Provisioning prints the allocated static IP. Seed it as `VPN_HOST` into `.env` and the `vpn` GitHub Environment before the first deploy. After provisioning, commit the updated `.github/known_hosts`.

## Configuration

GitHub Environment: **`vpn`**

### Required secrets

| Secret        | Required | Description                                                   |
| ------------- | -------- | ------------------------------------------------------------- |
| `VPN_SSH_KEY` | ✓        | Ed25519 private key for the VPN box (`wg-egress` keypair)     |
| `VPN_HOST`    | ✓        | Static IP of the Lightsail instance (printed by provisioning) |

AWS provisioning credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are operator-local only — not in the `vpn` Environment and not used by deploy or status.

## Operations

Full deploy flow, provisioning, reprovision recovery, peer management, and anti-patterns: [`apps/vpn/AGENTS.md`](AGENTS.md).

Key operational notes:

- Never pass secret bytes via argv — config bytes go through SSH stdin only.
- Never skip `validateVpnHost` — it rejects `-`-prefixed values that SSH treats as flags.
- Never read the server private key to the local machine — deploy reads back only `server.pub`.
- Reprovision (fresh disk) destroys the server key — all clients fail handshake. See `apps/vpn/AGENTS.md` for recovery paths.
- AWS credentials are provisioning-only — deploy and status are SSH-only, no AWS API calls.

## CLI

```bash
bunx @marcusrbrown/infra vpn status                              # SSH, wg show wg0, interface state + server pubkey + peer count
bunx @marcusrbrown/infra vpn deploy                              # trigger GitHub Actions workflow
bunx @marcusrbrown/infra vpn logs [--tail N]                     # stream journalctl -u wg-quick@wg0
bunx @marcusrbrown/infra vpn client add <name>                   # generate keypair, assign tunnel IP, write client .conf, redeploy
bunx @marcusrbrown/infra vpn client list                         # list peers (name, tunnel IP, public key)
bunx @marcusrbrown/infra vpn client remove <name>                # remove peer, trigger redeploy
```

`vpn status` is MCP-exposed (read-only). All other vpn commands are CLI-only.
