---
'@marcusrbrown/infra': minor
---

Add `vpn` command group: `vpn status` (SSH + `wg show wg0`, MCP-exposed), `vpn deploy` (GitHub Actions or `--local` SSH, `--force-server-key` to rotate), `vpn logs` (journalctl stream), and `vpn client add|list|remove` (peer lifecycle with local keypair generation and gitignored client `.conf` output). The VPN box is a WireGuard egress box on AWS Lightsail (`eu-west-1`) running native `wg-quick@wg0` + systemd; provisioned via `@aws-sdk/client-lightsail`. The server private key is generated and persisted on the box — it never leaves the box. Peer configs are tracked in `apps/vpn/config/peers.json` (public keys only); `wg0.conf` is rendered server-side on every deploy.
