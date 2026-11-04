---
'@marcusrbrown/infra': patch
---

`keeweb status` now reports the last successful deploy from the newest successful `main` deployment of the `keeweb` environment, so a successful workflow run whose deploy job was skipped no longer counts and router-driven deploys are found.
