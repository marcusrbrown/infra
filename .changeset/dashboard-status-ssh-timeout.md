---
"@marcusrbrown/infra": patch
---

Dashboard SSH-backed `status` and `logs` commands now fail fast when SSH cannot establish a connection to an unreachable or stale-DNS host. `status` preserves the SSH error detail in its output.
