---
'@marcusrbrown/infra': patch
---

Make `cliproxy status` and `cliproxy setup` compatible with CLIProxyAPI v7. The status command reads recent activity from the new `usage-queue` endpoint (the old `usage` endpoint was removed) and probes the management API once before issuing parallel calls so a wrong key no longer risks the v7 IP-ban. `setup` tolerates `/v1/models` entries that omit `owned_by`, inferring the provider from the model id instead. The deployed proxy image is pinned to v7.1.31.
