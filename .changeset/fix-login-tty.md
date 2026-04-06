---
'@marcusrbrown/infra': patch
---

Fix cliproxy login hanging after pasting callback URL

- Allocate TTY with `-tt` so the paste prompt works interactively
- Remove `BatchMode=yes` which blocks keyboard input
- Explicitly inherit stdin for the SSH subprocess
