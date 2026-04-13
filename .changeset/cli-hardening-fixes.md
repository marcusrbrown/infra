---
'@marcusrbrown/infra': patch
---

fix(cli): hardening fixes for setup wizard, build, and browser launch

- CI build now throws when DROPBOX_APP_SECRET is unset (closes #95)
- `keeweb open` uses fire-and-forget to avoid hanging on Linux xdg-open
- Setup wizard validates management key early (before prompts, not step 8/10)
- `gh secret set` pipes values via stdin instead of --body CLI argument
- Setup wizard rolls back newly created proxy keys on partial failure
