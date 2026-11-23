---
'@marcusrbrown/infra': minor
---

`status` and `status snapshot` now check that the VPN box is reachable: a plain TCP connect to its SSH port, with nothing sent or read. A failure is recorded as one of the fixed reasons `timeout`, `refused`, `unreachable`, `dns`, `error` or `invalid-config`; the box address is never printed or recorded. The snapshot reads the address from `VPN_PROBE_HOST` (and `status` also from `VPN_HOST`); without it the check is "not measured", never a failure. The check uses the existing `public-reachability` observation, with a new `tcp` value for its `source` in `status --json`. When the newest `main` deployment is waiting at its approval gate, the deploy state now reports the newest deployment that finished, marked `newer_at_gate`, so a failure before a parked gate stays visible.
