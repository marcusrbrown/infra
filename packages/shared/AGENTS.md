# Shared Ops Helpers

Shared TypeScript utilities for DigitalOcean droplet provisioning. Used by `apps/cliproxy` and `apps/gateway` provision scripts. Not consumed by the published `@marcusrbrown/infra` runtime CLI.

## CONTENTS

| File | Description |
| --- | --- |
| `server/droplet-helpers.ts` | Shared helpers: `ssh`, `scp`, `run`, `runCapture`, `sleep`, `validateDoctl`, `dropletExists`, `getSshFingerprint`, `getDropletIpWithWait`, `waitForSsh`, `pinHostKeys` |

## USAGE

Import directly from the workspace path:

```ts
import {ssh, run, validateDoctl} from '@marcusrbrown/infra-shared/server/droplet-helpers'
```

## NOTES

- This package is `private: true` — it is never published to npm.
- Tests are colocated: `server/droplet-helpers.test.ts`.
- `getSshFingerprint(name)` matches by key name (not first-key). Callers must pass the key name explicitly.
- `validateDoctl({checkAuth: true})` runs `doctl account get`; the no-arg form only checks PATH.
- `pinHostKeys` requires an explicit `opts.marker` for idempotency — callers control the marker string.
