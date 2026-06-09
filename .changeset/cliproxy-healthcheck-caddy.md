---
'@marcusrbrown/infra': patch
---

Fix cliproxy deploy healthcheck: probe the proxy backend from the Caddy container so deploys work on the upstream Debian-based image (v7.1.54+), and return the pin to v7.1.56.
