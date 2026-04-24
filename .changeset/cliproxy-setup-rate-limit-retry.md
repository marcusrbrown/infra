---
'@marcusrbrown/infra': patch
---

Handle GitHub API rate limit errors in `cliproxy setup` wizard — all `gh` CLI calls now retry with a user-confirm prompt (interactive) or re-throw with reset time (non-interactive) instead of failing immediately.
