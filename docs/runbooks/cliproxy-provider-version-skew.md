# CLIProxyAPI Provider Version Skew

When a provider flag introduced in a newer CLIProxyAPI release is passed to a droplet running an older image, the remote binary exits non-zero with an "unknown flag" error on stderr. The CLI surfaces a descriptive error pointing here.

---

## Symptom

`bunx @marcusrbrown/infra cliproxy login codex` fails with:

```
Remote login command failed with exit code 1. The most likely cause is that the droplet's
CLIProxyAPI binary predates --codex-device-login support (requires v6.10.9+). See
docs/runbooks/cliproxy-provider-version-skew.md for diagnosis and remediation steps.
```

The remote stderr (visible in the terminal because SSH inherits stdio) typically contains something like:

```
unknown flag: --codex-device-login
```

---

## Cause

The `cliproxy login codex` flow passes `--codex-device-login` to the CLIProxyAPI binary running inside the `cli-proxy-api` Docker container on the droplet. This flag was introduced in **CLIProxyAPI v6.10.9**. If the droplet's `eceasy/cli-proxy-api` image is pinned to an earlier version, the binary does not recognize the flag and exits with a non-zero code.

The production droplet (`cliproxy.fro.bot`) is on a current v7.x image and is not affected. This skew only arises on older or custom pins.

---

## Diagnosis

Check the live version reported by the status command:

```bash
bunx @marcusrbrown/infra cliproxy status
```

The output includes the CLIProxyAPI version. Alternatively, SSH directly and inspect the binary:

```bash
ssh root@cliproxy.fro.bot \
  'cd /opt/cliproxy && docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --version'
```

Or check the current image pin:

```bash
grep 'cli-proxy-api' apps/cliproxy/docker-compose.yaml
```

If the pinned tag is below `v6.10.9`, that is the cause.

---

## Remediation

1. **Bump the image pin** in `apps/cliproxy/docker-compose.yaml`. Find the `cli-proxy-api` service image line and update the tag to a version ≥ v6.10.9 (Renovate normally proposes this automatically; it can also be done manually):

   ```yaml
   image: eceasy/cli-proxy-api:v7.x.y  # bump from the old tag to ≥ v6.10.9
   ```

2. **Deploy** via the standard cliproxy deploy flow:

   ```bash
   bunx @marcusrbrown/infra cliproxy deploy
   ```

   Or trigger the GitHub Actions workflow manually.

3. **Re-run the login**:

   ```bash
   bunx @marcusrbrown/infra cliproxy login codex
   ```

---

## Related

- [`apps/cliproxy/AGENTS.md`](../../apps/cliproxy/AGENTS.md) — deploy flow, provisioning, anti-patterns
- [`packages/cli/src/commands/cliproxy/login.ts`](../../packages/cli/src/commands/cliproxy/login.ts) — where the enriched error is thrown
- `PROVIDER_FLAGS` in `login.ts` — maps each provider name to its CLI flag; update here when upstream adds new flags

---

_Last verified: 2026-06-01_
