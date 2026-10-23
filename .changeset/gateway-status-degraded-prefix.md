---
'@marcusrbrown/infra': patch
---

`status` now reports a gateway with a stopped service as `DEGRADED` with its service states, matching the other apps, instead of `ERROR: No services reported`.
