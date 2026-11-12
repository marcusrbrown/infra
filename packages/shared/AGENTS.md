# Shared Ops Helpers

Shared TypeScript utilities for DigitalOcean droplet provisioning, CLIProxyAPI management-API requests, OpenCode Go exposure policy, documentation validation, and public status history. Used by `apps/cliproxy`, `apps/gateway`, `apps/broker`, `apps/vpn`, `apps/umami`, `apps/dashboard`, `apps/docs`, and `packages/cli`.

## CONTENTS

| File | Description |
| --- | --- |
| `server/droplet-helpers.ts` | Shared helpers: `ssh`, `scp`, `run`, `runCapture`, `sleep`, `validateDoctl`, `dropletExists`, `getSshFingerprint`, `getDropletIpWithWait`, `waitForSsh`, `pinHostKeys` |
| `cliproxy/management.ts` | Management HTTP/auth helpers, OAuth model-alias parsing/apply/readback/equality, and OpenAI-compatibility types, normalization, readback, guarded PUT, disable PATCH, and equality helpers (`OpenAICompatEntry`, `ManagementHttpError`, `normalizeOpenAICompatEntry`, `readBackOpenAICompat`, `applyOpenAICompat`, `patchOpenAICompatDisabled`, `setEqualOpenAICompatEntry`, `setEqualOpenAICompat`) |
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
- OpenAI-compatibility helpers operate on `/v0/management/openai-compatibility`, never the whole config document. `readBackOpenAICompat` rejects a missing wrapper field; `applyOpenAICompat` rejects an empty list but replaces the entire section otherwise, so callers must enforce section ownership and verify readback. See [the management-API guard guidance](../../docs/solutions/best-practices/cliproxy-management-api-field-apply-2026-06-20.md).
