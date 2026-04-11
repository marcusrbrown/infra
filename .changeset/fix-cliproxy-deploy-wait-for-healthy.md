---
'@marcusrbrown/infra': patch
---

Fix cliproxy deploy race condition where the post-deploy health check fired before the `cli-proxy-api` container finished booting (~3-5s startup). The `docker compose up -d` now uses `--wait --wait-timeout 90` to block until the container's Docker-level healthcheck reports `healthy` before continuing. The existing app-level HTTP health check remains as the second verification layer.
