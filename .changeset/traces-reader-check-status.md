---
'@marcusrbrown/infra': patch
---

`traces reader backend` now accepts a reader-gate check failure that names the HTTP status Langfuse answered (`read-failed:404`), so a failed key check is diagnosable without host logs.
