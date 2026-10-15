---
'@marcusrbrown/infra': patch
---

`agent storage` now accepts any full-SHA `fro-bot/agent` pin in the storage job instead of one verified SHA, so a routine Action bump no longer needs a CLI change. Tag and branch pins are still rejected. Handoff manifests label the S3 key layout as `fro-bot-agent-s3-layout/1`; manifests carrying the earlier `fro-bot/agent@v0.118.2` or `@v0.119.2` label are still accepted.
