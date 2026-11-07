# Shared Ops Helpers

Shared TypeScript utilities for DigitalOcean droplet provisioning, CLIProxyAPI management-API requests, OpenCode Go exposure policy, documentation validation, and public status history. Used by `apps/cliproxy`, `apps/gateway`, `apps/broker`, `apps/vpn`, `apps/umami`, `apps/dashboard`, `apps/docs`, and `packages/cli`.

## CONTENTS

| File | Description |
| --- | --- |
| `server/droplet-helpers.ts` | Shared helpers: `ssh`, `scp`, `run`, `runCapture`, `sleep`, `validateDoctl`, `dropletExists`, `getSshFingerprint`, `getDropletIpWithWait`, `waitForSsh`, `pinHostKeys` |
| `cliproxy/management.ts` | Management helpers and types: `OAuthModelAliasEntry`, `OAuthModelAlias`, `HTTP_TIMEOUT_MS`, `toStringArray`, `parseManagementKeyList`, `managementHeaders`, `requestJson`, `parseClaudeEntries`, `readOAuthModelAliasFromConfig`, `applyOAuthModelAlias`, `readBackOAuthModelAlias`, `setEqualOAuthModelAlias` |
| `opencode-go/eligibility.ts` | Fail-closed OpenCode Go exposure policy shared by the deploy, monitor, and privacy refresh script; validates the reviewed snapshot and settings |
| `opencode-go/parse-privacy-table.ts` | Upstream privacy-table parser; fixtures and colocated tests cover the source format |
| `opencode-go/privacy-snapshot.json`, `opencode-go/settings.json` | Reviewed model privacy terms and tracked enablement/probe settings; exported workspace assets |
| `docs/frontmatter.ts` | Docs frontmatter parser and validators (`parseFrontmatter`, `validateDoc`, `validateSolution`, `validatePlan`, `validateBrainstorm`); used by `packages/cli/src/docs-frontmatter.test.ts` and `apps/docs` |
| `status/history-schema.ts` | Public status history contract: `APP_IDS`, sample/meta/app-file Zod schemas, `OBSERVATION_KINDS_BY_ID`; written by `packages/cli/src/status/history.ts`, read by `apps/docs` |

## USAGE

Import directly from the workspace path:

```ts
import {ssh, run, validateDoctl} from '@marcusrbrown/infra-shared/server/droplet-helpers'
import {managementHeaders, requestJson} from '@marcusrbrown/infra-shared/cliproxy/management'
import {validateDoc} from '@marcusrbrown/infra-shared/docs/frontmatter'
```

## NOTES

- This package is `private: true` — it is never published to npm.
- Tests are colocated under `server/`, `cliproxy/`, and `opencode-go/`.
- `getSshFingerprint(name)` matches by key name (not first-key). Callers must pass the key name explicitly.
- `validateDoctl({checkAuth: true})` runs `doctl account get`; the no-arg form only checks PATH.
- `pinHostKeys` requires an explicit `opts.marker` for idempotency — callers control the marker string.
