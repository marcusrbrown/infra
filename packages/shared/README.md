# @marcusrbrown/infra-shared

Cross-app SSH/SCP/DigitalOcean provisioning helpers for the `marcusrbrown/infra` monorepo.

Imported by each `apps/*/server/provision-droplet.ts` script. Not consumed by the published `@marcusrbrown/infra` CLI at runtime.

## Helpers

All helpers are exported from `packages/shared/server/droplet-helpers.ts`.

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

## Private Package

`@marcusrbrown/infra-shared` is `private: true` — it is never published to npm. Consume it via the workspace import path:

```ts
import {run, ssh, validateDoctl} from '@marcusrbrown/infra-shared/server/droplet-helpers'
```

## See Also

`packages/shared/AGENTS.md` — conventions, usage notes, and anti-patterns for this package.
