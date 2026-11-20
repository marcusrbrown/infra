---
'@marcusrbrown/infra': patch
---

`cliproxy status` now checks the OpenCode Go models against the current privacy snapshot on `main`, not the copy bundled when the CLI was released. If it cannot read that snapshot, it falls back to the bundled copy and warns that the current policy was not checked.
