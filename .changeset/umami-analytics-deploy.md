---
'@marcusrbrown/infra': minor
---

Add `umami` commands for the self-hosted Umami analytics deployment at `metrics.fro.bot`.

`infra umami status` reports the Docker Compose service health over SSH, `infra umami deploy` triggers the deploy (remote workflow by default, or `--local`), and `infra umami logs` streams container logs. The unified `infra status` now includes a `umami` row and a `umami` key under `--json`.
