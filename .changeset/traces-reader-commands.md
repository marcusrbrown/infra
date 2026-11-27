---
'@marcusrbrown/infra': patch
---

`infra traces reader add|list|revoke` manages reader tokens for the agent read routes on the trace host. `add <consumer>` writes a token for a named consumer, proves it on both routes, then delivers it once: to a GitHub Actions secret on stdin (`--repo`), or to a 0600 file on this machine. `--replace` installs a new token beside the old one and removes the old one only after delivery. `revoke` removes a consumer's tokens, or one by fingerprint, and proves 401 on both routes. `revoke --all` is the kill switch. `infra traces reader backend langfuse|grafana|status` installs, rotates and checks the Langfuse Viewer key and the Grafana service-account token the gate reads with. Neither credential is ever printed or sent as an argument. None of these commands is exposed over MCP.
