# Trace Collection Operations

Day-2 procedures for the trace collection stack at `traces.fro.bot`: health checks, deploys, the ingest route, sender tokens, backups, restore and rebuild. Design, networks, deploy ordering, locks and the rules that must not be broken are in [`apps/traces/AGENTS.md`](../../apps/traces/AGENTS.md); this runbook does not repeat them.

Commands run from a checkout whose `bun install` is current. CLI commands reach the host as `root` over SSH with the host keys pinned in `.github/known_hosts`, using your SSH agent or `TRACES_SSH_KEY`. The host comes from `TRACES_HOST`, and defaults to `traces.fro.bot`.

A few steps use plain `ssh`. Raw `ssh` does not read `TRACES_SSH_KEY` from the environment as the CLI does. Save the private key that `TRACES_SSH_KEY` holds to a local file with mode 0600 (for example `~/.ssh/traces`), then define this helper in the shell, from the repository root:

```bash
traces_ssh() {
  ssh -i ~/.ssh/traces -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=.github/known_hosts root@traces.fro.bot "$@"
}
```

`IdentitiesOnly=yes` offers only the key given with `-i`. `StrictHostKeyChecking=yes` with the pinned file refuses an unknown or changed host key. Later steps call `traces_ssh '<command>'`.

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

Success: `Ingest is held: every ingest path answered 503 from outside the host`. If it prints `Ingest hold NOT confirmed`, run `bunx @marcusrbrown/infra traces logs caddy`. If it prints `Could not set the ingest state on the host`, ingest may still be open: retry, and if the host is unreachable, go to step 4 below.

A hold does not stop a deploy that is running or waiting at its gate, and a deploy can undo it:

- A deploy's locked `.env` rewrite keeps the less open of its planned state and the state on the host, so a hold taken during the file-writing step survives that step.
- A deploy's final step opens the route when every gate passes, and it reads `TRACES_INGEST_OPEN` once, when it starts. When the deploy believes the route is not open (the route was off or held when it started, or the deploy held it itself for an update, which any change to a gated service causes), that step writes `open` and the hold is gone. When it believes the route is already open, it only checks for 401, finds 503, fails and leaves the route held.

So a hold lasts only if no deploy can reach its final step. In an emergency, in order:

1. Hold the route: `bunx @marcusrbrown/infra traces ingest hold`.
2. Keep future deploys held. A deploy that starts after this does not open the route; one that already started has read the old value:

   ```bash
   gh variable set TRACES_INGEST_OPEN --body false --repo marcusrbrown/infra
   ```

3. Find and stop any traces deploy. The router run `deploy.yaml` calls the same workflow, so list both:

   ```bash
   gh run list --workflow deploy-traces.yaml --repo marcusrbrown/infra --limit 5
   gh run list --workflow deploy.yaml --repo marcusrbrown/infra --limit 5
   ```

   A run that is `queued`, `waiting` (at the `traces` gate) or `in_progress` is live. Reject a waiting run at its gate in the Actions UI, or cancel it: `gh run cancel <run-id> --repo marcusrbrown/infra`. If any traces deploy is already past its gate, go to step 4 first and close the ports before cancelling it: until it reaches a terminal state it can still write `open`. Cancelling a run that is past its gate stops it mid-step and may leave services half-updated; its deploy marker stays, so `ingest open` refuses and the next deploy holds an open route first, until a deploy completes.

4. If a deploy is past its gate, close ports 80 and 443 at the cloud firewall until it ends. Find the firewall (`traces-fw`), remove the two web rules, and read the rules back. Only the SSH rule (port 22) may remain:

   ```bash
   doctl compute firewall list --format ID,Name
   doctl compute firewall remove-rules <firewall-id> --inbound-rules "protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0"
   doctl compute firewall get <firewall-id> --format InboundRules
   ```

   Cancel the run or let it finish, and wait until it is in a terminal state (`gh run watch <run-id> --repo marcusrbrown/infra`), then hold again: `bunx @marcusrbrown/infra traces ingest hold`. With the firewall closed it prints `Ingest hold NOT confirmed`, because the public check cannot reach the host. The state is still written on the host.

5. Verify, whether or not the ports were closed. Without a firewall block, run only check 3 below, after every traces deploy found in step 3 is in a terminal state. With a block, do all three before lifting it:

   1. `bunx @marcusrbrown/infra traces ingest status` prints `Configured on the host: held`. While the block is in place it also prints `unreachable` for each path under `Seen from outside` and exits 1; that is expected.
   2. Restore the rules:

      ```bash
      doctl compute firewall add-rules <firewall-id> --inbound-rules "protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0"
      doctl compute firewall get <firewall-id> --format InboundRules
      ```

   3. `bunx @marcusrbrown/infra traces ingest status` prints `Seen from outside: held (marcusrbrown 503, fro-bot 503, workstation 503)`. Any other answer: close the ports (step 4) and hold again.

A firewall block also takes `/healthz` down, so the probe fails with a no-answer reason and the monitor opens `traces-unhealthy` after two runs. It closes itself on the first healthy run after step 5. To reopen ingest afterwards, set `TRACES_INGEST_OPEN` back to `true` and deploy, or run `traces ingest open` as described below.

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

1. Pick the snapshot and note when it was taken:

   ```bash
   doctl compute snapshot list --resource volume --format Name,CreatedAt
   ```

   Use the `Name` of a daily snapshot (`traces-<yyyymmdd>-<hhmm>`).

2. Record a reference from the live stack, before the restore replaces it. The restore is proven by reading history back, and that needs something to compare with. The query runs inside the ClickHouse container as the stack's `clickhouse` user, read-only, with the password expanded from the container's own `CLICKHOUSE_PASSWORD`, so no secret is typed or printed. Replace `<snapshot-time-utc>` with the snapshot's creation time (for example `2026-11-21 04:23:00`):

   ```bash
   traces_ssh "docker compose --project-directory /mnt/traces/app exec -T clickhouse sh -c 'exec clickhouse-client --user clickhouse --password \"\$CLICKHOUSE_PASSWORD\" --readonly=1 --multiquery'" <<'SQL'
   SELECT trace_id, max(start_time) AS last_span FROM default.events_full WHERE start_time < toDateTime('<snapshot-time-utc>', 'UTC') - INTERVAL 1 HOUR GROUP BY trace_id ORDER BY last_span DESC LIMIT 5 FORMAT TSV;
   SELECT count() AS spans, max(start_time) AS newest FROM default.events_core WHERE start_time <= toDateTime('<snapshot-time-utc>', 'UTC') FORMAT TSV;
   SQL
   ```

   Write down the five trace IDs (each started at least an hour before the snapshot, which keeps them clear of Tempo's compaction gap) and the `spans` and `newest` values. Both are limited to spans that started by the snapshot time, so spans that arrive later do not change them. Trace IDs are not secret, but do not paste trace content anywhere. If the live stack cannot answer, there is no reference: continue only if the restore cannot wait, and keep the replaced volume at step 10.

3. Run the restore from a checkout whose `bun install` is current. A stale install fails with a missing workspace module. The root `.env` needs `DIGITALOCEAN_ACCESS_TOKEN` and `TRACES_HOST`, and `doctl` must be logged in:

   ```bash
   bun install
   bun run provision:traces --restore-snapshot <name>
   ```

   The run closes ports 80 and 443 and proves it from the read-back, requires exactly one attached `traces-data*` volume, creates `traces-data-restore-<YYYYMMDD>-<HHMM>` from the snapshot, stops Docker, detaches the old volume, attaches the new one, mounts it, verifies the sentinel and moves torn Tempo blocks aside. Success ends with `Volume <new> is attached and mounted in place of <old> (kept, detached)`, with Docker stopped and the ports closed. A restore started in the same minute as an existing restore volume refuses: wait a minute. If it stops anywhere else, go to [Interrupted restore](#interrupted-restore).

4. Start Docker on the host. The containers restart with it. `traces_ssh` is the raw SSH helper from the top of this runbook (it needs the private key from `TRACES_SSH_KEY` in a local file, passed with `-i`, with `StrictHostKeyChecking=yes` and `IdentitiesOnly=yes`):

   ```bash
   traces_ssh 'systemctl start containerd docker'
   bunx @marcusrbrown/infra traces status
   ```

   Wait until the services are `running`.

5. Make every token file deny-all. The snapshot holds the tokens as they were when it was taken, and the ports are still closed:

   ```bash
   bunx @marcusrbrown/infra traces sender revoke --all
   ```

   Success: `No real token remains in any group`.

6. Run a normal deploy: `bunx @marcusrbrown/infra traces deploy`, and approve the gate. The route's 401 is proven from inside the host, because the public ports are still closed.

7. Reopen the ports. The command refuses while any group still holds a real token:

   ```bash
   bun run provision:traces --reopen-ports
   ```

   Success: `Ports 80 and 443 are open at the cloud firewall (confirmed from the read-back)`.

8. Reissue all three tokens ([Issue a token](#issue-a-token)) and update the senders.

9. Prove the restore. Every part must pass:

   1. `traces status` reads `Status: OK`; `traces ingest status` shows the configured and seen states `open`; a dispatched backup succeeds ([Dispatch a backup by hand](#dispatch-a-backup-by-hand)); the monitor issue has closed.
   2. Langfuse holds the history. Run the same ClickHouse command as step 2 with this SQL, listing the five recorded IDs and the same snapshot time. Every recorded ID must come back. `spans` and `newest` must match the values recorded at step 2, or fall slightly short if spans that started just before the snapshot reached the stack after it was taken. Values far below the recorded ones mean data is missing. New spans from reissued senders and the health reporter's canaries are excluded by the time limit:

      ```sql
      SELECT trace_id FROM default.events_full WHERE trace_id IN ('<id-1>', '<id-2>', '<id-3>', '<id-4>', '<id-5>') GROUP BY trace_id FORMAT TSV;
      SELECT count() AS spans, max(start_time) AS newest FROM default.events_core WHERE start_time <= toDateTime('<snapshot-time-utc>', 'UTC') FORMAT TSV;
      ```

   3. Tempo serves traces from before the snapshot. For each recorded ID, query Tempo from inside the `health-reporter` container:

      ```bash
      traces_ssh 'docker compose --project-directory /mnt/traces/app exec -T health-reporter wget -q -O - http://tempo:3200/api/traces/<trace-id>' | wc -c
      ```

      A count above 0 means Tempo served the trace; 0 means it answered 404 (`wget` exits non-zero). Tempo can lack the traces of its most recent compaction window ([What a restore brings back](#what-a-restore-brings-back)), and the recorded IDs started at least an hour before the snapshot. A miss for a recorded ID is a failure. A miss for a trace from the hour before the snapshot is the documented gap and is not.

   If any part fails or cannot be completed, keep the detached volume and do not go on to step 10.

10. Delete the replaced volume only after step 9 passes. It still holds the traces and token files from before the restore, and deletion cannot be undone. Identify it by the name the restore printed:

    ```bash
    doctl compute volume list
    doctl compute volume delete <volume-id>
    ```

    A leftover restore volume from an interrupted attempt is deleted the same way, after a restore is proven.

### Interrupted restore

The command exits non-zero, or the connection drops. What is known depends on where it stopped. Match the message to a stage below, run the four checks, then follow that stage. Nothing is deleted in any stage.

**The four checks.** Run all four before any manual volume change:

1. Firewall: `doctl compute firewall get <firewall-id> --format InboundRules`. The ID is in `doctl compute firewall list --format ID,Name` (the name is `traces-fw`). A rule for port 80 or 443 means the ports are open. The SSH rule (port 22) must remain.
2. Docker: `traces_ssh 'systemctl is-active docker containerd'` prints `active` or `inactive` for each unit.
3. Mount: `traces_ssh 'findmnt /mnt/traces'` prints the mounted device, or exits 1 when nothing is mounted there.
4. Volumes: `doctl compute volume list` shows each `traces-data*` volume and the droplet it is attached to. A restore volume carries the label `restore-of:<snapshot>`.

DigitalOcean's listing lags a completed action, so a change that succeeded but was not confirmed in time reads as a failure. Read check 4 again before acting on it. Re-running the restore without checking creates another volume and starts the swap again.

**Stage 1: before the ports are closed, or while closing them.** Messages: `Droplet "traces" does not exist`, `Firewall traces-fw does not exist`, `still admits port(s)`, `no longer shows an SSH rule`, `is not attached to droplet`, a snapshot-name or argument refusal, or a `doctl` error.

- Known: only the firewall can have changed. Ports 80 and 443 may be open or closed. Docker runs, `/mnt/traces` is mounted, and no volume was created or changed.
- Do: run check 1. Fix the cause and run the restore again from the start; it sends the closing change only while a rule still admits 80 or 443. If the SSH rule is missing, put it back first: `doctl compute firewall add-rules <firewall-id> --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0,address:::/0"`. If the restore is abandoned, nothing needs undoing.

**Stage 2: ports closed, no volume changed.** Messages: `No volume snapshot named`, `A volume named ... already exists`, `Volume ... not found after creation`.

- Known: ports closed and proved from the read-back. Docker runs. The previous volume is attached and mounted. No existing volume changed. After `not found after creation` a new restore volume may exist, detached: leave it.
- Do: fix the cause (check the snapshot name; wait a minute for a same-minute volume name; read check 4 for a missing volume) and run again from the start. To abandon, the stack on the previous volume is intact: reopen the ports with the `add-rules` command in [Ingest](#ingest-hold-open-status), step 5 of the emergency procedure. `--reopen-ports` refuses here because the token files hold real tokens.

**Stage 3: volume-count refusal.** Message: `Expected exactly one traces-data* volume attached to the droplet, found <n>`. Ports are closed and this run changed no volume. The rest is whatever an earlier run left.

- `found 0`: an earlier restore stopped after the detach. Nothing is attached, Docker is stopped, `/mnt/traces` is unmounted, and the previous and restore volumes are both detached. Go to stage 5, case "nothing attached".
- `found 2` or more: more than one volume is attached and the run cannot tell which is live. Run checks 2 and 4. Normally the previous volume stays. Stop Docker and unmount before detaching the other: `traces_ssh 'systemctl stop docker.socket docker containerd'`, `traces_ssh 'umount /mnt/traces'`, then `doctl compute volume-action detach <volume-id> <droplet-id> --wait`. Read check 4 until exactly one `traces-data*` volume is attached, then run the restore again from the start.

**Stage 4: after the restore volume exists, before the detach.** Messages: `stop Docker and unmount the volume failed`, `TRACES_STILL_MOUNTED`, or an SSH failure before the Docker stop.

- Known: ports closed. The restore volume exists and is detached. The previous volume is still attached. Docker is running (SSH failed) or stopped, and `/mnt/traces` may still be mounted.
- Do: run checks 2, 3 and 4. If Docker runs or the volume is mounted, stop and unmount by hand as in stage 3. Then run the restore again from the start; the leftover restore volume stays.

**Stage 5: during the detach or attach.** Messages: `Restore interrupted: Docker is stopped. Ports 80 and 443 stay closed; ...` after `is still attached to droplet ... after the detach call`, `is not attached to droplet ... after the attach call`, or a `doctl` failure.

- Known: Docker is stopped, ports are closed and `/mnt/traces` is unmounted. The message says where the volumes are as far as the run knows; check 4 says where they are.
- Do, by what check 4 shows. Attach the previous volume only when it is not already attached:
  - Previous volume attached, restore volume detached: nothing to attach. Run the restore again from the start.
  - Nothing attached: attach the previous volume with `doctl compute volume-action attach <previous-volume-id> <droplet-id> --wait` (the message names it and prints the droplet ID). Read check 4 until exactly one `traces-data*` volume is attached, then run the restore again from the start.
  - Restore volume attached, previous volume detached: the swap completed. Do not run the restore again: it would take the restore volume as the old one and start another restore. Go to stage 6.
  - Both attached: Docker is stopped and nothing is mounted, so detach the restore volume with `doctl compute volume-action detach <restore-volume-id> <droplet-id> --wait`. Read check 4 until exactly one is attached, then run the restore again from the start.

**Stage 6: during the probe, mount or sentinel check.** Messages: `probe restored volume failed`, `mount restored volume failed`, `verify sentinel on restored volume failed`.

- Known: the restore volume is attached (read back), the previous volume is detached and kept, Docker is stopped and ports are closed. `/mnt/traces` is unmounted after a probe or mount failure. After a sentinel failure the restore volume is mounted and its sentinel is missing or wrong.
- **Do not run the restore again.** It would take the restore volume as the old one and start another restore. Run check 3, then `traces_ssh 'head -n 1 /mnt/traces/.traces-volume'`, which prints `traces-volume-v1` when the sentinel is right.
- A volume that is mounted at `/mnt/traces` with the right sentinel is sound: do the Tempo block scan by hand (stage 7), then continue at step 4 of the restore. A volume that cannot be mounted with the right sentinel is unusable: unmount it if mounted, detach it (`doctl compute volume-action detach <restore-volume-id> <droplet-id> --wait`), attach the previous volume, read check 4 until exactly one `traces-data*` volume is attached, then run the restore again from the start.

**Stage 7: during the Tempo block scan.** Message: `Tempo block check did not finish`.

- Known: the restore volume is attached, mounted and its sentinel verified. The previous volume is detached and kept. Docker is stopped and ports are closed. Blocks already moved are renames and stay moved.
- **Do not run the restore again.** List blocks whose metadata is empty or not a JSON object, the same test the provisioning scan uses (the first and last non-space characters must be `{` and `}`):

  ```bash
  traces_ssh 'cd /mnt/traces/docker/volumes/traces_tempo_data/_data/blocks && n=0; for f in */*/meta.json */*/meta.compacted.json; do [ -e "$f" ] || continue; n=$((n+1)); c=$(tr -d "[:space:]" < "$f"); case "$c" in "{"*"}") ;; *) echo "torn: $f";; esac; done; echo "checked $n"'
  ```

  It ends with `checked <n>`. If it does not, stop: do not start Docker until the metadata can be checked. Move each block directory it names (`<tenant>/<block-uuid>`) to `/mnt/traces/tempo-quarantine/<YYYYMMDD-HHMM>/<tenant>/` with `mv`, never `cp` or `rm`. Then continue at step 4 of the restore.

Delete nothing at any stage. A leftover restore volume and the previous volume are deleted only after a restore is proven (restore step 10). While nothing is attached, the backup job fails with `volume-not-found` and opens `traces-backup-failure`. It closes after the next successful run.

### What a restore brings back

- **Langfuse is complete.** ClickHouse, PostgreSQL and the object store come back whole from the snapshot.
- **Tempo can lack its most recent compaction window.** The snapshot is taken while Tempo runs and can catch a block mid-write. The restore moves each torn block (empty or non-object `meta.json` or `meta.compacted.json`) from `blocks/` to `/mnt/traces/tempo-quarantine/<YYYYMMDD-HHMM>/<tenant>/<block>`. It moves, never copies or deletes. A quarantined block replaced inputs the compactor had already retired, so Tempo can be missing whatever that compaction covered. Langfuse holds the complete record.
- **Quarantined blocks are deleted by hand.** Nothing prunes the quarantine and Tempo's 30-day retention does not reach it; [the privacy page](https://mrbro.dev/infra/trace-privacy/) says so. Look at it, then delete it:

  ```bash
  traces_ssh 'ls -la /mnt/traces/tempo-quarantine/'
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
