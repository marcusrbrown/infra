---
'@marcusrbrown/infra': patch
---

`traces status` now prints the collector's ingest counts: spans accepted and refused per sender group and requests per HTTP status code, as totals since the collector started (two `Ingest` lines in text, `health.ingest` in `--json`). A reporter that does not send the counts prints nothing extra. The health verdict now fails on a 503 from ingest only; a 429 from the byte limiter no longer marks the stack unhealthy.
