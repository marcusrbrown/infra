---
'@marcusrbrown/infra': patch
---

Fix pinned `known_hosts` resolution in the published CLI. The bundled host-key file resolved against the current working directory instead of the bundle location, so `infra status` and other SSH-based commands failed closed with "Pinned SSH known_hosts file not found" whenever run outside a repo checkout. The asset is now resolved relative to the bundle, keeping strict host-key checking intact.
