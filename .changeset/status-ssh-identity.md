---
'@marcusrbrown/infra': patch
---

`gateway status`, `umami status`, and `vpn status` now materialize the app's SSH key (`GATEWAY_SSH_KEY`/`UMAMI_SSH_KEY`/`VPN_SSH_KEY`) to a temporary 0600 file and connect with `-i <key> -o IdentitiesOnly=yes`. This makes status checks deterministic instead of failing with "Too many authentication failures" when the local ssh-agent holds many keys. When the key env var is unset, the commands fall back to the ssh-agent as before.
