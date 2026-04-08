---
'@marcusrbrown/infra': patch
---

Harden CLIProxyAPI deployment stability: remove placeholder API key from config template, add Docker restart policies and healthcheck, guard provision script against destructive reruns, add pre-deploy management key validation, switch health gate to self-contained endpoint, add `--output` flag to `cliproxy config get`, and fix management API auth documentation.
