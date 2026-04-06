---
'@marcusrbrown/infra': patch
---

Fix cliproxy login command and bunx dependency resolution

- Fix `cliproxy login claude` failing with "no configuration file provided" by running docker compose from `/opt/cliproxy/` on the remote host
- Fix `bunx @marcusrbrown/infra` failing with "Cannot find package 'zod'" by bundling all runtime dependencies in the published tarball
