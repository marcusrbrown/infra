---
"@marcusrbrown/infra": patch
---

Use the repo-pinned SSH known_hosts file for infra status SSH checks so local and MCP status commands do not depend on user-level SSH known_hosts entries.
