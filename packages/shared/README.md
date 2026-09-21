# @marcusrbrown/infra-shared

Cross-app SSH/SCP/DigitalOcean provisioning helpers and CLIProxyAPI management-API primitives for the `marcusrbrown/infra` monorepo.

Imported by each app's provisioning script (`server/provision-droplet.ts` for broker/cliproxy/dashboard/gateway/umami, `server/provision.ts` for vpn), by `apps/cliproxy/src/deploy.ts`, by `apps/broker/src/mint.ts`, and by `packages/cli/src/commands/cliproxy/*.ts`. `packages/cli` consumes it only as a `devDependency` — `bun build` inlines it into `dist/cli.js` at publish time, so the published npm package does not declare it as a runtime dependency. `packages/` never imports from `apps/`.

## Helpers

### `server/droplet-helpers.ts`

| Helper | Description |
| --- | --- |
| `ssh(host, command, user, opts?)` | Builds an SSH command array with `BatchMode`, `StrictHostKeyChecking=accept-new`, and `ConnectTimeout` flags; pins identity file when `opts.identityFile` is set |
| `scp(host, source, target, user, opts?)` | Builds an SCP command array with the same standard flags and optional identity pinning |
| `materializeIdentityFile(privateKey)` | Writes a private key to a `0600` temp file and returns its path plus a best-effort cleanup callback |
| `sleep(ms)` | Sleeps for the given number of milliseconds |
| `run(label, command)` | Runs a command, streams stdout, exits the process on non-zero exit code |
| `runCapture(command)` | Runs a command and returns trimmed stdout; throws on non-zero exit |
| `validateDoctl(opts?)` | Checks that `doctl` is on `PATH`; when `opts.checkAuth` is true, also runs `doctl account get` |
| `dropletExists(name)` | Returns whether a droplet with the given name exists in the DigitalOcean account |
| `getSshFingerprint(name, opts?)` | Finds the SSH key fingerprint for the named key in the DigitalOcean account; throws with a helpful error if not found |
| `getDropletIpWithWait(dropletName, opts?)` | Polls `doctl` for the droplet's public IPv4 address until it appears (default: 20 attempts × 5 s) |
| `waitForSsh(host, user, opts?)` | Polls for SSH connectivity to the given host (default: 24 attempts × 5 s) |
| `pinHostKeys(domain, ip, knownHostsPath, opts)` | Appends domain and IP host key entries to a `known_hosts` file; idempotent via `opts.marker` |

### `cliproxy/management.ts`

| Helper | Description |
| --- | --- |
| `HTTP_TIMEOUT_MS` | Default request timeout constant used by management-API calls |
| `managementHeaders(key)` | Builds the `x-management-key` header for authenticated management-API requests |
| `requestJson(endpoint, init)` | Sends an authenticated JSON request against `/v0/management/*` |
| `parseManagementKeyList(payload)` | Parses the management API's key-list response into a string array |
| `toStringArray(payload)` | Coerces an unknown payload into a string array |
| `parseClaudeEntries(raw, onDrop?)` | Parses raw Claude OAuth entries into `OAuthModelAliasEntry[]`, dropping malformed entries |
| `readOAuthModelAliasFromConfig(configPath)` | Reads the current OAuth model alias from a CLIProxyAPI config file |
| `applyOAuthModelAlias(...)` | Applies an OAuth model alias change via the management API |
| `readBackOAuthModelAlias(...)` | Reads back an applied OAuth model alias to verify the change took effect |
| `setEqualOAuthModelAlias(desired, actual)` | Compares two `OAuthModelAlias` values for equality |

## Private Package

`@marcusrbrown/infra-shared` is `private: true` — it is never published to npm. Consume it via the workspace import path:

```ts
import {managementHeaders, requestJson} from '@marcusrbrown/infra-shared/cliproxy/management'
import {run, ssh, validateDoctl} from '@marcusrbrown/infra-shared/server/droplet-helpers'
```

## See Also

`packages/shared/AGENTS.md` — conventions, usage notes, and anti-patterns for this package.
