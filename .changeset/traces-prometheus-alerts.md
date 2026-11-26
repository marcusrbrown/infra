---
'@marcusrbrown/infra': patch
---

`infra traces logs` accepts the new `prometheus` service, and `infra traces deploy --local` forwards `TRACES_DISCORD_WEBHOOK_URL`, the address the trace stack's Grafana alert rules post to.
