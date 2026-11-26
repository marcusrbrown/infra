---
'@marcusrbrown/infra': patch
---

`infra traces logs` accepts the new `embedder` service, the local embedding server that Langfuse Topics uses. `infra traces status` shows its `embedder-health` check with the monitoring checks, so a dead embedder fails the health path and never refuses `infra traces ingest open`.
