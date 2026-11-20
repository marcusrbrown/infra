---
'@marcusrbrown/infra': patch
---

`status snapshot` no longer probes or records an app whose host is not deployed yet (`traces` today), so a missing host is not reported as an outage in the public status history.
