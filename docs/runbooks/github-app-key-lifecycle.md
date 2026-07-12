# GitHub App Key Lifecycle

The GitHub App private key is the credential the Fro Bot gateway uses to clone repos for `/fro-bot add-project owner/repo`. The App (owned by the `fro-bot` account, public, `contents: read` only) mints short-lived installation tokens from this key at request time — the key itself never leaves the droplet or the GitHub Environment. This runbook covers storage, routine rotation, and emergency revocation for `GH_APP_ID` / `GH_APP_PRIVATE_KEY`.

---

## Storage

**Mapping:**

| Location | Value |
|---|---|
| CI (deploy pipeline) | `GH_APP_ID` / `GH_APP_PRIVATE_KEY` secrets in the `gateway` GitHub Environment |
| Local deploys | `GH_APP_ID` / `GH_APP_PRIVATE_KEY` in the repo-root `.env` (read by `bun run deploy:gateway`) |
| Droplet | `/opt/gateway/deploy/secrets/github-app-id` and `/opt/gateway/deploy/secrets/github-app-private-key` |

GitHub rejects secret names prefixed `GITHUB_`, which is why the Environment secrets are named `GH_APP_ID` / `GH_APP_PRIVATE_KEY` rather than matching the upstream container env vars (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`) directly. Both are validated as required in `REQUIRED_ENV_VARS` (`apps/gateway/src/deploy.ts` line 176) — the deploy aborts before any SSH if either is missing or empty.

Secret bytes enter via SSH stdin only, never argv. `writeRemoteFile()` (`apps/gateway/src/deploy.ts` lines 1778–1800) runs `umask 077; cat > '<remotePath>'` over SSH with the content piped to stdin, so each file lands `root:root` mode `0600`.

**Filename mapping (kebab-case host file → snake_case compose mount → container `_FILE` env var):**

| Host file (kebab) | Compose mount (snake) | Container env var |
|---|---|---|
| `github-app-id` | `/run/secrets/github_app_id` | `GITHUB_APP_ID_FILE` |
| `github-app-private-key` | `/run/secrets/github_app_private_key` | `GITHUB_APP_PRIVATE_KEY_FILE` |

`buildSecretFileList()` (`apps/gateway/src/deploy.ts` lines 1090–1103) maps `GH_APP_ID` → `github-app-id` and `GH_APP_PRIVATE_KEY` → `github-app-private-key`, with the latter run through `normalizePemPrivateKey()` (`apps/gateway/src/deploy.ts` lines 1069–1079) before being written.

**PEM newline normalization:** `normalizePemPrivateKey()` accepts either a real multi-line PEM (the natural shape of a GitHub Environment secret) or a single-line value with literal `\n` escape sequences (the convenient shape for a `.env` file). If the value contains a literal `\n`, it unescapes `\r\n` and `\n` into real newlines; either way it ensures the result ends with a trailing newline (repairing GitHub Actions' habit of stripping trailing whitespace from secret values). A valid PEM body is never itself a literal backslash-n, so this is a no-op when the input already has real newlines. Both `.env`-local and GitHub-Environment-sourced keys converge on the same on-disk format.

The secrets checksum change from a key rotation triggers `--force-recreate` on the next deploy, same as any other secret file (see `docs/runbooks/discord-token-lifecycle.md` for the checksum mechanism shared across all gateway secrets).

---

## Routine rotation

GitHub Apps support multiple simultaneously active private keys — this is what makes zero-downtime rotation possible. Generating a new key does not invalidate the old one; you control when the old key stops working by deleting it explicitly, after the new one is confirmed live.

1. **Generate a new private key** in the App settings portal: [github.com/settings/apps/`<app-slug>`](https://github.com/settings/apps) (owned by the `fro-bot` account — check the App settings page for the exact slug). Settings → **Private keys** → **Generate a private key**. GitHub downloads the PEM once; it is not retrievable again.

2. **Seed the new value via stdin pipe** — never shell substitution (`--body "$(cat ...)"`), which corrupts secrets with trailing newlines and exposes the value in process argv (see `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`):

   ```bash
   printf '%s' "$(cat new-private-key.pem)" | gh secret set --env gateway GH_APP_PRIVATE_KEY
   ```

   Update the local `.env` copy the same way if you deploy locally. Delete the downloaded PEM file (`rm -f new-private-key.pem`) once seeded.

3. **Deploy:**

   ```bash
   bunx @marcusrbrown/infra gateway deploy
   # or: bun run deploy:gateway (local)
   ```

4. **Approve the environment gate** in the GitHub Actions UI (the `gateway` environment requires a reviewer).

5. **Verify:**

   ```bash
   bunx @marcusrbrown/infra gateway status
   ```

   Then run the `/fro-bot add-project` clone smoke against a repo the App is installed on — confirm the clone completes without error. This is the only proof the new key actually works end-to-end (see the post-cutover verification ritual in `apps/gateway/AGENTS.md`).

6. **Delete the old key** in the App settings portal only after step 5 passes. Deleting a key invalidates all installation tokens minted from it and rejects any new JWT signed with it.

7. **Scrub shell history** if the PEM ever touched a command line:

   ```bash
   grep -n 'BEGIN.*PRIVATE KEY' ~/.bash_history ~/.zsh_history
   ```

---

## Emergency revocation (suspected or confirmed leak)

**Triage first:**

- **Suspected leak** — anomalous clone activity on unfamiliar repos, unfamiliar entries in the App's audit page, a PEM accidentally pasted into a chat, log, or public artifact.
- **Confirmed leak** — positive evidence: the App's audit log shows installation tokens minted or used from an unrecognized source, or the PEM is verified publicly exposed (e.g. committed to a public repo).
- **Default under uncertainty: treat as confirmed.** The cost of a false positive is a brief `/fro-bot add-project` outage and a rotation. The cost of a false negative is an attacker minting installation tokens against every account the App is installed on.

**Containment sequence — for a confirmed leak, delete first, replace second (inverted from routine rotation):**

1. **Delete the compromised key in the App settings portal immediately.** This is the fastest containment step — it invalidates every JWT signed with that key going forward, before you've done anything else. If the leak is severe enough that key deletion alone isn't enough containment (e.g. the App's client secret or webhook secret is also suspected compromised), **suspend the App installation** on affected accounts instead — the bigger hammer, since it blocks all API access regardless of which key signed the request.

2. **Audit the surfaces below.** Record findings with timestamps before generating a replacement key — the audit window closes once a new key is live and normal clone traffic resumes.

3. **Generate and deploy a replacement key** following the [Routine rotation](#routine-rotation) procedure above, steps 1–5. There is no "old key" deletion step this time — you already deleted it in step 1.

**Audit surfaces:**

- **Gateway container logs** — look for `/clone` endpoint activity and any errors around the leak window:

  ```bash
  # --allow-ci required: this command is intentionally headless during incident audit
  bunx @marcusrbrown/infra gateway logs gateway --tail 500 --allow-ci
  ```

- **Mitmproxy logs** — look for unfamiliar egress destinations or unexpected volume from the workspace/gateway containers during the leak window:

  ```bash
  bunx @marcusrbrown/infra gateway logs mitmproxy --tail 500 --allow-ci
  ```

- **S3 object-store access** — check for objects written outside your known workload during the leak window (the gateway's S3 credentials are a separate credential, but cross-reference timing against any unusual clone activity).

- **GitHub App audit surfaces** — the App settings page's advanced/audit section (check the App settings page for the exact path — GitHub's UI for this has moved in the past) shows recent deliveries and installation activity; cross-reference against the user account's security log at [github.com/settings/security-log](https://github.com/settings/security-log) for key-generation and App-management events.

- **Operator workstation shell history** — if the PEM was ever echoed or catted to a terminal:

  ```bash
  grep -n 'BEGIN.*PRIVATE KEY' ~/.bash_history ~/.zsh_history
  ```

---

## In-flight request handling

Installation tokens minted by the GitHub App are short-lived — GitHub caps them at 1 hour. Deleting the private key does **not** retroactively invalidate tokens already minted from it: any installation token issued before deletion continues to work until its own expiry (≤1h from mint time), even after the signing key is gone. What deletion blocks is **new** minting — any attempt to mint a fresh installation token using a JWT signed with the deleted key fails immediately with an authentication error.

Practical implication for incident response: after deleting a compromised key, a narrow window (up to 1 hour) exists where a token minted just before deletion is still valid. There is no operator-side way to force-expire an already-minted installation token short of suspending the App installation entirely (step 1's "bigger hammer" option) — suspension blocks all API calls immediately regardless of token validity.

---

## Blast radius notes

The GitHub App key is scoped narrowly: installation tokens are per-installation and grant `contents: read` only, used exclusively for `/fro-bot add-project` clones. It does not share a credential volume with any other gateway secret.

Contrast with two related-but-separate credentials on the gateway:

- **`cliproxy_auth`** — the CLIProxyAPI OAuth token volume on the `cliproxy` droplet, shared across all proxy consumers (Claude, Codex, and any other provider). A compromise there has cross-provider blast radius; it is an entirely different credential store from the GitHub App key and has no bearing on `/fro-bot add-project`.
- **`WORKSPACE_OPENCODE_AUTH`** — a dedicated, scoped cliproxy key used by the gateway's workspace executor for the `@fro-bot` mention loop. It is deliberately separate from the repo's CI-wide `OPENCODE_AUTH_JSON` so it can be revoked independently (see `apps/gateway/AGENTS.md`'s Mention loop section). It is also unrelated to the GitHub App key — the two credentials cover different features (clone vs. mention-triggered OpenCode runs) and rotating one has no effect on the other.

If you're responding to an incident that might touch more than one of these, treat each as an independent revocation — don't assume rotating the GitHub App key does anything for `cliproxy_auth` or `WORKSPACE_OPENCODE_AUTH` exposure, or vice versa.

---

## Related

- [`apps/gateway/AGENTS.md`](../apps/gateway/AGENTS.md) — `### GitHub App` section, deploy flow, provisioning, anti-patterns
- [`docs/runbooks/discord-token-lifecycle.md`](discord-token-lifecycle.md) — secret file mapping mechanism, checksum-gated `--force-recreate`, stdin-pipe seeding pattern
- [`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`](../solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md) — `gh secret set` shell-substitution corruption warning; PEM newline gotcha
- `apps/gateway/src/deploy.ts` line references:
  - Lines 176–190: `REQUIRED_ENV_VARS` — `GH_APP_ID` / `GH_APP_PRIVATE_KEY` required, fail-closed
  - Lines 1069–1079: `normalizePemPrivateKey()` — single-line `\n`-escaped or real multi-line PEM, trailing newline repair
  - Lines 1090–1103: `buildSecretFileList()` — `github-app-id` / `github-app-private-key` mapping
  - Lines 1778–1800: `writeRemoteFile()` — SSH stdin pipe with `umask 077`

---

_Last verified against: `apps/gateway/src/deploy.ts` on 2026-07-12_
