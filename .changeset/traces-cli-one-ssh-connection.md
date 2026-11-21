---
'@marcusrbrown/infra': patch
---

The `traces` commands that make several calls to the host (`status`, `ingest` and `sender`) now use one SSH connection each, so the host's limit on new SSH connections no longer locks the operator out partway through a command.
