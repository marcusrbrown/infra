---
'@marcusrbrown/infra': minor
---

Add `status snapshot --history <dir> [--bootstrap] [--now <iso>]`, a CLI-only command that takes one public-safe status sample (public probes, the GitHub Deployments state and the auth monitor probe, with no SSH) and merges it into a 90-day history directory, refusing to write if any history invariant fails, plus `status history-locate`, which finds the newest snapshot history artifact on `main`. Unified `status` now reads each app's Deploy state and cliproxy's End-to-end result from GitHub when `GITHUB_TOKEN` or `GH_TOKEN` is set.
