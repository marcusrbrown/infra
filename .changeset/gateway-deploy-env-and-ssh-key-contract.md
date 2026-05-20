---
'@marcusrbrown/infra': patch
---

Fix gateway deploy local mode to forward all required env vars (DISCORD_TOKEN, AWS_*, S3_*) plus the optional S3_ENDPOINT, OBJECT_STORE_HOSTS, and AWS_SESSION_TOKEN. The previous narrow allowlist made `gateway deploy --local` unusable on most configurations and silently produced wrong mitmproxy egress allowlists for R2/MinIO endpoints.
