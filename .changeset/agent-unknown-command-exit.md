---
'@marcusrbrown/infra': patch
---

An unknown CLI command now exits non-zero and prints `Unknown command: <name>` on stderr, instead of silently falling back to root help with a success exit code. A mistyped command is now a detectable error in scripts and CI.
