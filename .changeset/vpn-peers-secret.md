---
'@marcusrbrown/infra': patch
---

`vpn client add` and `vpn client remove` now sync the peer roster to the `VPN_PEERS` GitHub Environment secret after each successful local write. The roster is piped via stdin to `gh secret set VPN_PEERS --env vpn --repo marcusrbrown/infra` — roster bytes never appear in argv. If the `gh` sync fails, the command still succeeds and prints a warning with the exact remediation command. The deploy reads the roster from `VPN_PEERS` in CI and falls back to the local `apps/vpn/config/peers.json` for local deploys.
