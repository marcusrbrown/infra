# Shared Ops Helpers

Shared TypeScript utilities for DigitalOcean droplet provisioning and CLIProxyAPI management-API requests. Used by `apps/cliproxy`, `apps/gateway`, `apps/broker`, `apps/vpn`, `apps/umami`, `apps/dashboard`, and `packages/cli`.

## CONTENTS

| File | Description |
| --- | --- |
| `server/droplet-helpers.ts` | Shared helpers: `ssh`, `scp`, `run`, `runCapture`, `sleep`, `validateDoctl`, `dropletExists`, `getSshFingerprint`, `getDropletIpWithWait`, `waitForSsh`, `pinHostKeys` |
| `cliproxy/management.ts` | Management helpers and types: `OAuthModelAliasEntry`, `OAuthModelAlias`, `HTTP_TIMEOUT_MS`, `toStringArray`, `parseManagementKeyList`, `managementHeaders`, `requestJson`, `parseClaudeEntries`, `readOAuthModelAliasFromConfig`, `applyOAuthModelAlias`, `readBackOAuthModelAlias`, `setEqualOAuthModelAlias` |

## USAGE

Import directly from the workspace path:

```ts
import {ssh, run, validateDoctl} from '@marcusrbrown/infra-shared/server/droplet-helpers'
import {managementHeaders, requestJson} from '@marcusrbrown/infra-shared/cliproxy/management'
```

## NOTES

- This package is `private: true` — it is never published to npm.
- Tests are colocated: `server/droplet-helpers.test.ts` and `cliproxy/management.test.ts`.
- `getSshFingerprint(name)` matches by key name (not first-key). Callers must pass the key name explicitly.
- `validateDoctl({checkAuth: true})` runs `doctl account get`; the no-arg form only checks PATH.
- `pinHostKeys` requires an explicit `opts.marker` for idempotency — callers control the marker string.
