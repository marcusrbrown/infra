---
'@marcusrbrown/infra': minor
---

`cliproxy setup` now verifies its GitHub writes landed and warns about concurrent runs.

After writing secrets and variables, setup re-lists the repo's secret and variable names and warns if a just-written name is not visible. An empty secret list from a successful `gh` call — a scope-limited token or replication lag — otherwise looks identical to a fresh repo and silently disables the ack-key-reuse and collision gates. The readback distinguishes a verified mismatch (the name is provably absent, so the token's list view is unreliable and the gates may have been bypassed) from a cannot-verify case (the readback call itself failed). It never throws and never rolls back a successfully created key.

The non-interactive `--force` overwrite warning now states that concurrent setup runs against the same repo resolve last-write-wins. `packages/cli/AGENTS.md` gains an Operational Limitations section covering the concurrency boundary and the transient-empty gate bypass.
