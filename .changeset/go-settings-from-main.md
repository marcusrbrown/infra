---
'@marcusrbrown/infra': patch
---

`cliproxy status` now reads the OpenCode Go `settings.json` from `main` at run time, as it already does for the privacy snapshot, so a published CLI follows an emergency disable or a re-enable without a release. The read is tokenless, bounded in time and size, and parsed strictly; when it fails the bundled settings are used and the route line says why (`Go settings: bundled (<reason>)`). `cliproxy monitor` and the status snapshot still use the committed file.
