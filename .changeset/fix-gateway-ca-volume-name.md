---
'@marcusrbrown/infra': patch
---

Fix `gateway backup --include-ca` and `gateway restore --include-ca` targeting the wrong Docker volume: they now use the live `fro-bot_mitmproxy-certs` volume and fail instead of creating an empty one when it is missing.
