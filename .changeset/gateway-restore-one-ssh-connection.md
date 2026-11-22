---
'@marcusrbrown/infra': patch
---

`gateway restore` now uses one SSH connection for its nine remote calls instead of one each, so the host's limit on new SSH connections no longer locks the operator out partway through a CA restore. Host-key pinning is unchanged.
