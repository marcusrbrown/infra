# Trace Collection Operations

Day-2 procedures for the trace collection stack at `traces.fro.bot`: health checks, deploys, the ingest route, sender tokens, backups, restore and rebuild. Design, networks, deploy ordering, locks and the rules that must not be broken are in [`apps/traces/AGENTS.md`](../../apps/traces/AGENTS.md); this runbook does not repeat them.

Commands run from a checkout whose `bun install` is current. CLI commands reach the host as `root` over SSH with the host keys pinned in `.github/known_hosts`, using your SSH agent or `TRACES_SSH_KEY`. The host comes from `TRACES_HOST`, and defaults to `traces.fro.bot`.

---

## What the stack is and what is public

A collector on one DigitalOcean droplet accepts OTLP traces from three sender groups and writes each trace to Langfuse (whole) and to Tempo (structure only). The public surface is two things on one hostname:

| Route                                           | Answer                              |
| ----------------------------------------------- | ----------------------------------- |
| `https://traces.fro.bot/marcusrbrown/v1/traces` | ingest for the `marcusrbrown` group |
| `https://traces.fro.bot/fro-bot/v1/traces`      | ingest for the `fro-bot` group      |
| `https://traces.fro.bot/workstation/v1/traces`  | ingest for the `workstation` group  |
| `https://traces.fro.bot/healthz`                | `{ok, at}` and nothing else         |

Every other path answers 404. An ingest path answers 404 when the route is `off`, 503 when it is `held` (senders retry) and 401 to a request with no token when it is `open`. [Ingest](#ingest-hold-open-status) covers the states.

Langfuse and Grafana have no hostname. Both are reached through an SSH tunnel:

```bash
bunx @marcusrbrown/infra traces open
```

The command prints `http://localhost:3000` (Langfuse) and `http://localhost:3001` (Grafana) and holds the tunnel until Ctrl-C. Both local ports must stay as printed, because the two applications' configured URLs are loopback URLs on those ports. If the tunnel closes at once, a local port is in use or a host key does not match.

The host rate-limits new SSH connections: six within 30 seconds from one source and the next is refused for about 30 seconds. Multi-step CLI commands share one connection. Do not run several `infra traces` commands in parallel.

---

## Checking health

1. Read the stack's state over SSH:

   ```bash
   bunx @marcusrbrown/infra traces status
   ```

   Success: every service `running` (and `healthy` where it has a check), `Health verdict: PASSING`, and `Status: OK` with exit code 0. On failure it prints `Status: DEGRADED`, exits 1 and lists each check that keeps the verdict from passing as `not passing: <check>: <detail>`. `Health verdict: UNKNOWN` means the reporter could not be reached or answered something unreadable. `--json` prints one object, `{ok, services, health}`.

2. Read the public health path, which needs no SSH:

   ```bash
   curl -fsS https://traces.fro.bot/healthz
   ```

   Success: HTTP 200 and `{"ok": true, "at": "<timestamp>"}`. The reporter recomputes every five minutes, so `at` is recent.

3. Compare the route's configured state with what the outside world sees:

   ```bash
   bunx @marcusrbrown/infra traces ingest status
   ```

   It prints `Configured on the host`, `Seen from outside`, `Health verdict` and `Deploy` (`finished`, or `unfinished` after a failed or running deploy). It exits 1 when the configured and observed states disagree or one cannot be read.

4. Read a service's logs when a check names it:

   ```bash
   bunx @marcusrbrown/infra traces logs collector --tail 200
   ```

   Services: `caddy`, `collector`, `langfuse-web`, `langfuse-worker`, `clickhouse`, `minio`, `redis`, `postgres`, `tempo`, `grafana`, `health-reporter`. Logs can hold prompt text, tool output, private repository content and database passwords. Do not paste them into an issue, a chat or a shared log. The command refuses in CI without `--allow-ci`.

### What the monitor checks

`.github/workflows/traces-monitor.yaml` probes the stack every 15 minutes with no secret and no SSH. It makes three checks:

| Check | Healthy when |
| --- | --- |
| `/healthz` | 200 within 10 seconds, a JSON body with `ok: true`, and `at` no more than 10 minutes old (a frozen reporter reads as stale). A redirect is unhealthy |
| Certificate | the served certificate has at least 14 days left |
| Ingest path | an empty `POST` with no token to `/workstation/v1/traces` answers as the route should. The repository variable `TRACES_INGEST_OPEN` decides what that is: exactly `true` means 401; anything else (unset included) means 404 or 503 |

When the alert fires:

- An alert needs two unhealthy probe runs in a row. The first strike changes nothing. "The run before" is the workflow's own last completed run on `main`, read from its `probe` job; a previous run older than an hour is not consecutive.
- One case alerts at once: the ingest path answers 401 or any 2xx while `TRACES_INGEST_OPEN` is not `true`. The route is open when it should not be. Run `bunx @marcusrbrown/infra traces ingest hold` first, then decide whether ingest should be open.
- The alert is one issue labelled `traces-unhealthy`, titled "Trace collection stack is unhealthy", plus one Discord message. It names the failing checks only as `health`, `certificate` and `ingest`. A later run in the same outage adds nothing.
- The first healthy run comments on the issue, closes it and posts one recovery message. Nothing needs to be closed by hand.
- While `TRACES_DOMAIN` is unset, the probe exits green and the alert does nothing.
- A re-run of a workflow run never updates the alert. Wait for the next scheduled probe.

The alert text carries nothing the endpoint said. The exact reason is in the probe job's log (`Trace collection probe unhealthy: <codes>`) and its step summary:

| Reason | Meaning | Do |
| --- | --- | --- |
| `healthz-timeout`, `healthz-network`, `ingest-timeout`, `ingest-network` | no answer | check DNS, the droplet, and whether the cloud firewall has 80 and 443 open (a restore closes them); then `traces status` |
| `healthz-503`, `healthz-unhealthy` | the reporter's verdict is failing | `traces status` lists the failing checks |
| `healthz-stale` | the verdict is more than 10 minutes old | the reporter is not running: `traces logs health-reporter`, `traces status` |
| `healthz-status`, `healthz-body` | `/healthz` answered something that is not the reporter's verdict | `traces logs caddy`; deploy again |
| `cert-unreadable`, `cert-expiring` | no valid certificate, or fewer than 14 days left | `traces logs caddy`; confirm DNS points at the droplet and ports 80 and 443 are open at the cloud firewall |
| `ingest-unexpected-status` | the route's state does not match `TRACES_INGEST_OPEN` | `traces ingest status`, then either open it ([Ingest](#ingest-hold-open-status)) or set the variable to match |
| `ingest-open-unexpected` | the route is open and the variable is not `true` (alerts at once) | `traces ingest hold` |
| `invalid-domain` | `TRACES_DOMAIN` is not a lowercase DNS name | fix the repository variable |

---

## Deploying

1. Start a deploy. All three paths run the same workflow:

   - Merge to `main` a change under `apps/traces/` that is not Markdown, a test, a fixture or a snapshot. The `Deploy` router triggers `deploy-traces`.
   - Dispatch it directly: `bunx @marcusrbrown/infra traces deploy` runs `gh workflow run "Deploy Traces"`. `--dry-run` prints the plan.
   - Dispatching the `Deploy` router itself runs every app's deploy. Use the command above instead.

2. Wait for the run to reach the `traces` Environment gate. The `build-collector` job (`main` only) pushes the collector image to GHCR first, and the `notify` job posts one Discord message when the deploy reaches the gate (`DEPLOY_GATE_DISCORD_WEBHOOK`, see [Deploy-Gate Notifications](deploy-gate-notifications.md)). Approve the gate. A dispatch from another branch builds no image and runs no deploy.

3. Read the end of the deploy log. It prints one line per gate, `✓` passed, `✗` failed, `-` skipped, then the outcome.

### The gates

| Gate                  | Passes when                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `langfuse-key`        | the Application-role key pair is set                                                     |
| `ingest-variable`     | `TRACES_INGEST_OPEN` is exactly `true`                                                   |
| `retention`           | the 30-day TTLs and lifecycle rules were asserted and read back                          |
| `token-directories`   | every group has a non-empty token file (a deny-all file passes)                          |
| `reporter-verdict`    | a verdict produced after the reporter restarted is fresh and passing                     |
| `canary`              | the canary trace reached the collector, Langfuse and Tempo, and the Tempo keep-list held |
| `bootstrap-key`       | the bootstrap pair is not supplied and Langfuse answers 401 to it                        |
| `bootstrap-variables` | no `LANGFUSE_INIT_PROJECT_*KEY` value is in the host `.env` or in a running container    |

The route opens only when every gate passes. Gate design is in [Holding, gates and the route](../../apps/traces/AGENTS.md#holding-gates-and-the-route).

### Outcomes

| Log ends with | Meaning | Do |
| --- | --- | --- |
| `Ingest is open: every ingest path reached the collector and asked for a token` | every gate passed; 401 proven on all three paths from inside the host | nothing |
| `Ingest is OFF. Gates not met:` (or `HELD`) | the deploy completed, but a gate is not met and the route stays closed (an open route is held). `ingest-variable` and `langfuse-key` end here | meet the named gate and deploy again. `ingest-variable` fails while `TRACES_INGEST_OPEN` is unset or anything but exactly `true` |
| `Gates failed: <gate>: <detail>` | the key pair is set and a safety gate failed. An open route is held first | fix the named gate and deploy again |
| `Applied but unverified: the host was updated and the update did not verify.` | the host changed and a later step failed. The message says whether ingest is held, off, or "may be open" | if it says "may be open", run `bunx @marcusrbrown/infra traces ingest hold` now. Fix the cause named in the message and deploy again. Only a deploy that passes every gate reopens ingest |
| `The files could not be compared with the host` | nothing was written. The marker stays, so the next deploy holds an open route first | deploy again once the host answers |
| `Another deploy started on this host and took over` | a newer deploy owns the host; this one stopped and changed nothing further | follow the newer deploy |
| `DNS preflight failed` | `TRACES_DOMAIN` does not resolve to the droplet | point the A record at the droplet; Caddy cannot get a certificate otherwise |

A deploy never leaves an open route unverified. On any failure after it takes its deploy marker, it reads the route from the host and holds it (every ingest path answers 503, which senders retry) unless the host is already off or held. While the marker or a pending-restart record exists, `traces ingest open` refuses and only a completed deploy clears it.

### Deploying from a checkout

1. Use the root wrapper so the repo-root `.env` loads:

   ```bash
   bun run deploy:traces
   ```

2. The `.env` must hold the inputs listed in `TRACES_DEPLOY_SECRETS`, `TRACES_DEPLOY_VARS` and `TRACES_DEPLOY_BUILD_INPUTS` in `apps/traces/src/deploy.ts`, and either an SSH agent or `TRACES_SSH_KEY`. `TRACES_COLLECTOR_IMAGE` must be a GHCR reference pinned to a digest that a `build-collector` run pushed. No sender token, `TRACES_SNAPSHOT_DO_TOKEN` or `DIGITALOCEAN_ACCESS_TOKEN` is read.
3. `bunx @marcusrbrown/infra traces deploy --local --dry-run` validates the preconditions and prints the planned command and the input names that are set, never their values.
4. Never run a local deploy while the workflow's run is in flight. The second deploy waits up to 15 minutes for the first one's step, then takes the host, and the first stops at its next step.

---

## Ingest: hold, open, status

**Hold (emergency).** Closes the route at once. It does not wait for a deploy and does not read the health verdict.

```bash
bunx @marcusrbrown/infra traces ingest hold
```

Success: `Ingest is held: every ingest path answered 503 from outside the host`. If it prints `Ingest hold NOT confirmed`, run `bunx @marcusrbrown/infra traces logs caddy`. If it prints `Could not set the ingest state on the host`, ingest may still be open. Retry, and if the host is unreachable, close ports 80 and 443 at the DigitalOcean cloud firewall. A hold survives a concurrent deploy: a deploy re-reads the state under the lock and keeps the less open of the two.

**Open.** Refuses unless the health reporter's latest verdict is fresh and passing, and no deploy is running or unfinished.

```bash
bunx @marcusrbrown/infra traces ingest open
```

Success: `Ingest is open: every ingest path reached the collector and asked for a token`. On `Refusing to open ingest` it changes nothing and names the cause:

- The verdict is not passing: fix the checks it lists (`traces status`).
- A deploy is running or did not finish: run the deploy to completion (`traces deploy`). It opens ingest itself once every gate passes.
- The ingest lock was not free within 30 seconds: try again.

`ingest open` does not touch `TRACES_INGEST_OPEN`. With the variable not `true`, the monitor alerts at once on an open route and the next deploy holds it. With the variable `true` and a long hold, the monitor alerts after two runs (it expects 401 and sees 503). Set the variable to match the intended state.

**Status.** `bunx @marcusrbrown/infra traces ingest status` changes nothing. See [Checking health](#checking-health).

### Opening ingest for the first time

1. Confirm the privacy page is published and says what is true: <https://mrbro.dev/infra/trace-privacy/>. No sender token is issued before the page is live.
2. Confirm the Application-role Langfuse key pair is set and the bootstrap secrets are deleted ([Rebuild from nothing](#rebuild-from-nothing)).
3. Set the repository variable before the deploy, so the monitor expects 401 when the route opens:

   ```bash
   gh variable set TRACES_INGEST_OPEN --body true --repo marcusrbrown/infra
   ```

4. Deploy: `bunx @marcusrbrown/infra traces deploy`, and approve the `traces` gate.
5. Check that the deploy log ends `Ingest is open`, then that all three paths answer 401 without a token:

   ```bash
   bunx @marcusrbrown/infra traces ingest status
   ```

   Success: `Configured on the host: open`, `Seen from outside: open (marcusrbrown 401, fro-bot 401, workstation 401)`, `Health verdict: passing`, `Deploy: finished`.

6. Issue the sender tokens ([Sender tokens](#sender-tokens)).

---

## Sender tokens

A sender token is a bearer credential. It exists on the host in one file per group, and at the sender. It is never stored in this repository's GitHub, never passed as a command-line argument, and never copied off the host. Only its fingerprint (12 hex characters) is printed. No token is issued before the privacy page is published.

### Issue a token

1. For `marcusrbrown` or `fro-bot`, the token goes to a GitHub Actions secret on the sender side. Name every repository that sends under the group (there is no default target):

   ```bash
   bunx @marcusrbrown/infra traces sender add fro-bot --repo OWNER/REPO --repo OWNER/OTHER
   ```

   `--repo` repeats. `--org ORG --org-repo NAME` (repeatable) sets an organisation secret visible to the named repositories only. The secret is `TRACES_INGEST_TOKEN` unless `--secret-name` says otherwise. The command sets it through `gh secret set` on stdin and never prints the token. It needs a `gh` login that can write secrets on those repositories.

2. For `workstation`, the token is printed once to the terminal:

   ```bash
   bunx @marcusrbrown/infra traces sender add workstation
   ```

   Put it in the workstation's local OpenCode settings as the bearer token (`Authorization: Bearer <token>`) for `https://traces.fro.bot/workstation/v1/traces`. It is shown once and stored nowhere else. The command refuses when standard output is not a terminal unless `--print` is given, and refuses the GitHub options.

3. Success: `Token <fingerprint> written to the <group> token file`, then `Token <fingerprint> is live` (a 2xx answer for the token, through the public endpoint when it is open and over SSH otherwise), then the delivery line.

If the host did not confirm the write, the token may or may not be in the file and was delivered nowhere: run `bunx @marcusrbrown/infra traces sender list`, and if the fingerprint is there, revoke it. If the token is live but delivery failed, the token is not shown: revoke it and run `add` again.

### Rotate

A group that already has a token accepts both until the old one is revoked. Run `add`, switch the sender, then revoke each fingerprint the command printed.

### List

```bash
bunx @marcusrbrown/infra traces sender list
```

Prints each group with its fingerprints and creation dates, or `(no tokens)`. It never prints a token and hides void lines.

### Revoke

```bash
bunx @marcusrbrown/infra traces sender revoke <group> <fingerprint>
bunx @marcusrbrown/infra traces sender revoke --all
```

Revoking the last real token of a group writes a void line, so the group accepts nothing and the file is never empty. `--all` does that for every group and takes no group and no fingerprint.

Success proves a refusal, not just a deletion: `Token <fingerprint> revoked from <group>: ... answered 401 for it`. A single revoke checks through the public endpoint when it is open, and over SSH otherwise. `--all` checks over SSH only, against each group's private receiver, because after a restore the public ports are closed. If a removed token is still accepted, the command says so: run `bunx @marcusrbrown/infra traces ingest hold` and find out why the collector still accepts it.

Revocation does not touch GitHub. Delete or replace the matching Actions secrets yourself. `sender add` overwrites a secret it sets.

---

## Backups

`.github/workflows/traces-backup.yaml` snapshots the live data volume daily at 04:23 UTC.

- **What it snapshots.** The one volume named `traces-data` or `traces-data-*` that is attached to the droplet named `traces`. After a restore that is the `traces-data-restore-*` volume. Zero or several matches is a failure, never a guess.
- **Snapshot names.** `traces-<yyyymmdd>-<hhmm>` (UTC) with the tag `traces-backup`. A manual pre-upgrade snapshot is named `traces-pre-<label>`. Only a daily snapshot counts as "the newest", so a manual one cannot hide a broken daily job.
- **Retention.** Snapshots older than 8 days are deleted, oldest first, at most 10 per run, and only after the newest daily snapshot is no more than 36 hours old. A broken backup never erases history. A snapshot with any other name is never touched: delete it by hand.
- **The job.** It holds the repository secret `TRACES_SNAPSHOT_DO_TOKEN` (scoped to volume and snapshot actions) and declares no Environment, so it never waits for a reviewer. While `TRACES_DOMAIN` is unset it exits green; once the variable is set, a missing token fails the run.

### Dispatch a backup by hand

```bash
gh workflow run "Traces Backup" --repo marcusrbrown/infra
```

Success: the run's summary reads `snapshot created, <n> pruned, newest daily snapshot 0 h old`. Confirm with `doctl compute snapshot list --resource volume`. The workflow runs on `main` only.

### When the backup alert opens

One issue labelled `traces-backup-failure`, titled "Trace data backup is failing", opens on the first failed or cancelled run, with one Discord message. Each further failing day adds a comment. The next successful run comments, closes the issue and posts one recovery message. There is no flap control: one failed daily run alerts. The reason is in the backup job's log and summary:

| Reason | Do |
| --- | --- |
| `snapshot-token-missing` | set the repository secret `TRACES_SNAPSHOT_DO_TOKEN` |
| `do-api:<stage>:http-401` or `http-403` | the token is invalid or lacks a scope for that stage (`list-droplets`, `list-volumes`, `create-snapshot`, `list-snapshots`, `delete-snapshot`) |
| `do-api:<stage>:timeout`, `:network`, `:http-5xx`, `:malformed:*` | transient API trouble: dispatch a backup by hand |
| `droplet-not-found`, `droplet-ambiguous` | no droplet, or more than one, is named `traces` |
| `volume-not-found`, `volume-ambiguous` | no `traces-data*` volume, or more than one, is attached to the droplet: see [Interrupted restore](#interrupted-restore) |
| `created-snapshot-not-listed`, `created-snapshot-not-newest` | the listing did not show the new snapshot within about 30 seconds: dispatch a backup by hand |
| `newest-snapshot-too-old` | no daily snapshot in the last 36 hours, so nothing was pruned: dispatch a backup by hand |

A snapshot is taken while the stack runs. ClickHouse, PostgreSQL and the object store come back complete from one; see [What a restore brings back](#what-a-restore-brings-back) for Tempo.

---

## Restore

A restore replaces the data volume with a new one made from a snapshot. Ingest is down for the duration: the cloud firewall closes ports 80 and 443 first. The monitor opens a false `traces-unhealthy` issue during the window, and it closes itself ([Alerts and Discord](#alerts-and-discord)).

Design and the exact checks are in [Restore](../../apps/traces/AGENTS.md#restore).

1. Pick the snapshot:

   ```bash
   doctl compute snapshot list --resource volume
   ```

   Use the `Name` of a daily snapshot (`traces-<yyyymmdd>-<hhmm>`).

2. Run the restore from a checkout whose `bun install` is current. A stale install fails with a missing workspace module. The root `.env` needs `DIGITALOCEAN_ACCESS_TOKEN` and `TRACES_HOST`, and `doctl` must be logged in:

   ```bash
   bun install
   bun run provision:traces --restore-snapshot <name>
   ```

   The run closes ports 80 and 443 and proves it from the read-back, requires exactly one attached `traces-data*` volume, creates `traces-data-restore-<YYYYMMDD>-<HHMM>` from the snapshot, stops Docker, detaches the old volume, attaches the new one, mounts it, verifies the sentinel and moves torn Tempo blocks aside. Success ends with `Volume <new> is attached and mounted in place of <old> (kept, detached)`, with Docker stopped and the ports closed. A restore started in the same minute as an existing restore volume refuses: wait a minute. If it stops anywhere else, go to [Interrupted restore](#interrupted-restore).

3. Start Docker on the host. The containers restart with it:

   ```bash
   ssh -o UserKnownHostsFile=.github/known_hosts root@traces.fro.bot 'systemctl start containerd docker'
   bunx @marcusrbrown/infra traces status
   ```

   Wait until the services are `running`.

4. Make every token file deny-all. The snapshot holds the tokens as they were when it was taken, and the ports are still closed:

   ```bash
   bunx @marcusrbrown/infra traces sender revoke --all
   ```

   Success: `No real token remains in any group`.

5. Run a normal deploy: `bunx @marcusrbrown/infra traces deploy`, and approve the gate. The route's 401 is proven from inside the host, because the public ports are still closed.

6. Reopen the ports. The command refuses while any group still holds a real token:

   ```bash
   bun run provision:traces --reopen-ports
   ```

   Success: `Ports 80 and 443 are open at the cloud firewall (confirmed from the read-back)`.

7. Reissue all three tokens ([Issue a token](#issue-a-token)) and update the senders.

8. Prove the restore: `traces status` reads `Status: OK`; `traces ingest status` shows the configured and seen states `open`; a dispatched backup succeeds ([Dispatch a backup by hand](#dispatch-a-backup-by-hand)); the monitor issue has closed.

9. Delete the replaced volume only after step 8 passes. It still holds the traces and token files from before the restore, and deletion cannot be undone. Identify it by the name the restore printed:

   ```bash
   doctl compute volume list
   doctl compute volume delete <volume-id>
   ```

   A leftover restore volume from an interrupted attempt is deleted the same way, after a restore is proven.

### Interrupted restore

The command exits non-zero and leaves Docker stopped and ports 80 and 443 closed. The refusal message says which case this is:

- `Expected exactly one traces-data* volume attached to the droplet, found 0`: an earlier restore stopped between the detach and the attach. Nothing is attached, and the previous volume and the new restore volume are both detached. The run cannot tell which held the live data, and it deletes nothing.
- `found 2` or more: make exactly one `traces-data*` volume attached by hand (stop Docker and unmount a volume before detaching it).
- `Restore interrupted: Docker is stopped` after a detach or attach failure: the message says which volume is where as far as the run knows.
- `Tempo block check did not finish`: the restore volume is attached and mounted. **Do not run the restore again**: it would start another restore from this volume. Look at `/mnt/traces/docker/volumes/traces_tempo_data/_data/blocks` by hand. The same holds for a failure after the attach (probe, mount or sentinel).

Hand step for the first three cases:

1. **Check where each volume is before anything else.** If an attach or detach is reported as failed, run `doctl compute volume list` and check where each `traces-data*` volume actually is. DigitalOcean's listing lags a completed action, so a change that succeeded but was not confirmed in time reads as a failure. Re-running the restore without checking creates another volume and starts the swap again.
2. Identify the volume that was live before the restore started: the previous `traces-data*` volume. Names, attachment and the `restore-of:<snapshot>` label are in the listing.
3. Attach it to the droplet (the refusal message prints the droplet ID):

   ```bash
   doctl compute volume-action attach <volume-id> <droplet-id> --wait
   ```

4. Run the same `bun run provision:traces --restore-snapshot <name>` again from the start. It copes with Docker already stopped and nothing mounted, and creates a fresh restore volume.
5. Delete nothing. A leftover restore volume and the previous volume are deleted only after a restore is proven.

While nothing is attached, the backup job fails with `volume-not-found` and opens `traces-backup-failure`. It closes after the next successful run.

### What a restore brings back

- **Langfuse is complete.** ClickHouse, PostgreSQL and the object store come back whole from the snapshot.
- **Tempo can lack its most recent compaction window.** The snapshot is taken while Tempo runs and can catch a block mid-write. The restore moves each torn block (empty or non-object `meta.json` or `meta.compacted.json`) from `blocks/` to `/mnt/traces/tempo-quarantine/<YYYYMMDD-HHMM>/<tenant>/<block>`. It moves, never copies or deletes. A quarantined block replaced inputs the compactor had already retired, so Tempo can be missing whatever that compaction covered. Langfuse holds the complete record.
- **Quarantined blocks are deleted by hand.** Nothing prunes the quarantine and Tempo's 30-day retention does not reach it; [the privacy page](https://mrbro.dev/infra/trace-privacy/) says so. Look at it, then delete it:

  ```bash
  ssh -o UserKnownHostsFile=.github/known_hosts root@traces.fro.bot 'ls -la /mnt/traces/tempo-quarantine/'
  ```

  Remove a stamp directory with `rm -r /mnt/traces/tempo-quarantine/<YYYYMMDD-HHMM>` once you have looked.

---

## Alerts and Discord

| Label | Opened by | Closes when |
| --- | --- | --- |
| `traces-unhealthy` | the monitor: two unhealthy probes in a row, or one probe that finds the route open when it should not be | the first healthy probe |
| `traces-backup-failure` | the backup: any failed or cancelled run | the next successful backup |

Both labels are declared in `.github/settings.yml`. Each alert opens at most one issue per outage and posts one Discord message when it opens it and one when it closes it. Both workflows post with the repository secret `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK`, read in the Discord step only. The issue step holds the workflow token and no webhook. A missing or blank webhook skips the message and leaves the issue. The deploy-gate message uses `DEPLOY_GATE_DISCORD_WEBHOOK` ([Deploy-Gate Notifications](deploy-gate-notifications.md)).

During a restore the closed ports make the probe fail, and an interrupted restore makes the backup fail. Expect one `traces-unhealthy` issue (and, if nothing is attached, one `traces-backup-failure` issue) and let them close themselves after the restore is proven.

Exercise either alert without a real failure by dispatching the workflow with `rehearse-alert` set to `fail`. It opens a marked rehearsal issue and posts to Discord. Dispatch again with `clear` to close it. The probe or backup does not run.

---

## Rebuild from nothing

A rebuild creates a new droplet, volume and firewall. Every token file is new, so all three sender tokens are reissued. A rebuild onto a volume made from a snapshot is [Restore](#restore).

1. Provision. The repo-root `.env` needs `DIGITALOCEAN_ACCESS_TOKEN` and `TRACES_HOST` (`traces.fro.bot`); `TRACES_SSH_KEY_NAME` names the DigitalOcean SSH key (default `fro-bot-traces`). `doctl` must be logged in.

   ```bash
   bun run provision:traces
   ```

   It creates the droplet, the 100 GiB volume `traces-data` and the cloud firewall (inbound 22, 80 and 443), hardens the host, formats and mounts the volume, moves Docker and containerd onto it and checks the storage paths fail-closed. `--check-exists` prints whether the droplet exists; `--force` runs against an existing droplet.

2. Create the DNS A record for `traces.fro.bot` as soon as the droplet exists (`doctl compute droplet list` shows its address). It must resolve before provisioning reaches the host-key step, because the keys are pinned under both the address and the hostname. The provisioner opens one shared SSH connection and pauses between key scans: the host's SSH rate limit refuses six connections within 30 seconds. If the pin ran before the record resolved, the new block in `.github/known_hosts` lacks the hostname's keys: remove the block (its first line starts `# traces droplet`) and run the provisioner again with `--force`.

3. Commit the pinned keys. The two copies must be byte-identical:

   ```bash
   cp .github/known_hosts packages/cli/src/resources/known_hosts
   ```

   Commit both before any CI deploy.

4. Reboot the droplet once with the volume detached and once attached. With it detached, Docker must be stopped and SSH must work.

5. Prepare GitHub. Create the `traces` Environment with the same protections as the other app Environments (required reviewer, `main`-only deployment branches). Set these in it: `TRACES_SSH_KEY`, `TRACES_HOST`, the store and Grafana secrets, `TRACES_LANGFUSE_USER_EMAIL`, `TRACES_LANGFUSE_USER_PASSWORD`, and the bootstrap pair `TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY` and `TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY`. Leave `TRACES_LANGFUSE_PUBLIC_KEY` and `TRACES_LANGFUSE_SECRET_KEY` unset. Names, lengths and formats are in [Secrets and tokens](../../apps/traces/AGENTS.md#secrets-and-tokens). Set each secret with `gh secret set <NAME> --env traces --repo marcusrbrown/infra` and paste the value at the prompt; never pass it as an argument. Never regenerate `SALT`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET` or a store password for a volume that holds data.

   Then set the repository secret `TRACES_SNAPSHOT_DO_TOKEN`, and last the repository variable `TRACES_DOMAIN` (`traces.fro.bot`). Setting the variable starts the monitor and the backup. Leave `TRACES_INGEST_OPEN` unset. The monitor alerts if the host does not answer for two runs, so expect one issue if the first deploy takes longer than that. It closes itself.

6. First deploy: `bunx @marcusrbrown/infra traces deploy`, and approve the gate. Success: the stack is up, retention is asserted, and the log ends `Ingest is OFF. Gates not met:` with `langfuse-key` unmet. Langfuse has created its organisation, project, user and the bootstrap key.

7. Create the Application key through the tunnel:

   ```bash
   bunx @marcusrbrown/infra traces open
   ```

   In Langfuse at `http://localhost:3000`, sign in with the `TRACES_LANGFUSE_USER_*` credentials. In the project's settings, API keys, create a key with the Application role. Then delete the bootstrap key in the same list. Set `TRACES_LANGFUSE_PUBLIC_KEY` and `TRACES_LANGFUSE_SECRET_KEY` in the `traces` Environment, and delete the bootstrap secrets:

   ```bash
   gh secret delete TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY --env traces --repo marcusrbrown/infra
   gh secret delete TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY --env traces --repo marcusrbrown/infra
   ```

   Langfuse recreates a deleted key on its next boot while the bootstrap variables are present, so both deletions are required.

8. Publish the privacy page and set `TRACES_INGEST_OPEN` ([Opening ingest for the first time](#opening-ingest-for-the-first-time)), then deploy again. The deploy removes the bootstrap variables from the host `.env`, sets the old pair aside and probes Langfuse with it. A 401 means the key is dead, the record is removed and, if every other gate passes, the route opens. A 200 fails the deploy with ingest off and says to delete the key in the UI: delete it, then deploy again. Deploy this way until `bootstrap-key` and `bootstrap-variables` pass.

9. Issue all three sender tokens ([Sender tokens](#sender-tokens)), and dispatch a backup to confirm the job finds the new volume ([Dispatch a backup by hand](#dispatch-a-backup-by-hand)).
