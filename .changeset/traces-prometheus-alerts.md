---
'@marcusrbrown/infra': patch
---

`infra traces logs` accepts the new `prometheus` service, and `infra traces deploy --local` forwards `TRACES_DISCORD_WEBHOOK_URL`, the address the trace stack's Grafana alert rules post to. `infra traces status` now shows the ingest verdict and the monitoring verdict (Grafana and Prometheus) apart, and `infra traces ingest open` reads the ingest verdict only, so a failing monitoring check no longer refuses an open.
