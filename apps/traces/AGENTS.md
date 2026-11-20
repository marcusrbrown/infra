# apps/traces — trace collection stack

Collector, Langfuse, Tempo and Grafana for agent-run traces, on a dedicated DigitalOcean droplet at `traces.fro.bot`. A collector accepts OTLP over HTTP on that one public hostname, tells three sender groups apart by bearer token, limits each group by bytes, and sends every trace two ways: whole to Langfuse, and reduced to a named list of attributes to Tempo. Langfuse and Grafana have no public hostname; both are reached through an SSH tunnel. Ingest and a health path are the only public routes.

The decision record is `docs/plans/2026-11-20-001-feat-trace-collection-stack-plan.md`. This file covers the stack definition, the gated deploy and the health reporter. Provisioning is `server/provision.ts` (`docs/runbooks/trace-collection.md` is the operator runbook once it lands); the CLI group (`traces status|logs|open|ingest|sender`) is in `packages/cli/src/commands/traces/`.

## Structure

```text
├── docker-compose.yaml       Stack: Caddy, collector, Langfuse web + worker, ClickHouse, PostgreSQL, Redis, MinIO, Tempo, Grafana, health reporter
├── config/
│   ├── Caddyfile             One site; /healthz; 404 for everything else; imports one ingest state file
│   ├── ingest/               off.caddy, held.caddy, open.caddy: the three ingest states
│   ├── otelcol.yaml          Receivers, byte limiter, group stamp, Langfuse exporters, keep-list, Tempo exporter
│   ├── tempo.yaml            Monolithic, local disk, 720 h retention, 20 MB trace limit
│   ├── clickhouse/           System-log TTLs (config.d). No memory settings
│   ├── clickhouse-users/     The read-only `traces_reader` user for the health reporter
│   └── grafana/datasources/  Provisioned Tempo data source
├── collector/                Builder manifest and Dockerfile for the collector image
├── server/provision.ts       Droplet, volume, firewall; exports `checkTracesStorage`, `createRemoteExec`, `Runner`, `RemoteExec`
└── src/
    ├── deploy.ts             Gated deploy (below). Exports the input lists TRACES_DEPLOY_SECRETS / _VARS / _BUILD_INPUTS
    ├── retention.ts          30-day TTL on the ClickHouse trace tables, 30-day expiry on the object store, with read-back
    ├── host.ts               Host layout constants and host validation (shared by provisioning and deploy)
    ├── health-report.ts      Health reporter (a Bun script; deploy uploads it to `health-reporter/`)
    └── deploy.fixture.ts     A simulated host for the deploy tests (not a test file)
```

## Networks and exposure

| Network   | Members                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| `edge`    | Caddy, collector, Langfuse web, Tempo, health reporter                                         |
| `backend` | Grafana, ClickHouse, PostgreSQL, Redis, MinIO, Langfuse web and worker, Tempo, health reporter |

Only Caddy publishes `80` and `443`. Langfuse web (`127.0.0.1:3000`) and Grafana (`127.0.0.1:3001`) publish to loopback for the SSH tunnel; keep the tunnel's local ports equal to these (Langfuse's `NEXTAUTH_URL` and Grafana's root URL are loopback URLs). No store port is ever published: Docker publishing bypasses the host firewall.

## Ingest

`https://traces.fro.bot/<group>/v1/traces` with `<group>` one of `marcusrbrown`, `fro-bot`, `workstation`. Each path reaches that group's collector receiver (ports 4411, 4412, 4413), which checks a token from `/etc/otelcol/tokens/<group>/token`. Caddy caps the body at 4.5 MiB; the collector caps the decompressed body at 8 MiB. A fourth receiver (4414) serves the health canary; Caddy never routes to it.

The ingest route has three states, chosen by `TRACES_INGEST_STATE` (unset means `off`) and read once when Caddy starts, so changing it recreates the Caddy container:

| State  | Ingest paths               | When                                             |
| ------ | -------------------------- | ------------------------------------------------ |
| `off`  | no route (404)             | first bring-up, or gates not yet passed          |
| `held` | 503, which senders retry   | a gated change is in progress, or `ingest hold`  |
| `open` | proxied to their receivers | every gate passed and ingest is meant to be open |

Timeouts: Caddy answers within 5 s (`read_header`), cuts a slow upload at 15 s, and gives a collector that does not acknowledge in 5 s a 504, because the sender abandons a request at 10 s.

## Collector

One receiver, one token file and one intake pipeline per group. The intake pipeline runs the byte limiter (`ratelimit`, bytes, 1 GiB allowance, 32 KiB/s refill; a full bucket answers 429), then stamps `sender.group` (upsert), then feeds two branches:

- **Langfuse**: the whole trace, no further processor, one persistent byte queue per group (1 GiB).
- **Tempo**: one shared pipeline through the `redaction` keep-list (structural keys only), one persistent queue (256 MiB).

The keep-list covers resource, scope, span and span-event attributes. It does **not** cover span link attributes, and span names, status messages and event names are not attributes, so they are kept. A new structural attribute is invisible in Grafana until it is added to `allowed_keys` in `config/otelcol.yaml`.

A 200 from the collector means queued, not stored by both backends. Delivery is at-least-once and the two backends can differ.

## Health reporter

`src/health-report.ts` runs in the `health-reporter` service (`oven/bun`, no install step, read-only root, UID 10010, no Docker socket) and produces one verdict every five minutes: the collector, Tempo, both Langfuse services, disk, the age of the oldest data in each store, and a canary trace sent through the collector's private receiver and read back from both backends. In Langfuse the canary is checked two ways: the markers Langfuse stores as fields must be in its ClickHouse row, and all nine must be in the raw batch that row names in the object store (Langfuse does not copy span links, generic span events or exception events into the row; `LANGFUSE_MARKER_LOCATIONS` is the one table to re-check on a Langfuse upgrade). In Tempo only the span name, status message, exception message and link attribute may survive, which is the keep-list check. Every probe has a timeout and each run a deadline, so one stuck dependency cannot stop later runs. It has two listeners:

- `0.0.0.0:8080` `GET /healthz`: `{ok, at}` and nothing else. Caddy routes this path publicly.
- `127.0.0.1:8081` (the container's own loopback; nothing publishes it) `GET /detail` and `/live`. `traces status`, `traces ingest open` and the deploy read `/detail` with `docker compose exec -T health-reporter wget -q -O - http://127.0.0.1:8081/detail`, followed by a sentinel line.

A verdict older than two intervals reads as failing. Two files carry the reporter's passwords, read on every run (so a change needs no restart): `secrets/reporter/clickhouse-password` (the read-only `traces_reader` user) and `secrets/reporter/minio-password`, both owned by UID 10010, mode 0400.

## Deploy

`bun run deploy:traces` (root wrapper; loads the root `.env`) or the `deploy-traces` workflow. The inputs are exactly `TRACES_DEPLOY_SECRETS`, `TRACES_DEPLOY_VARS` (`TRACES_DOMAIN`, `TRACES_INGEST_OPEN`) and `TRACES_DEPLOY_BUILD_INPUTS` (`TRACES_COLLECTOR_IMAGE`, from the workflow's build job) in `src/deploy.ts`; a conventions test compares them with the workflow. A sender token, the snapshot token and the DigitalOcean token are never read.

Order: validate every input; DNS preflight; verify the volume mount, sentinel and storage paths (`checkTracesStorage`, fail closed); under the ingest lock, read the host's state and write the deploy marker in one script; compare every file with the host and, on an open route, compare the running services with the files; hold the route if it is open and a gated service is about to change or is not running what the files say; write directories, deny-all token files where none exists, secret files, configs and the reporter source; prune images, check free space, pull; create the collector container and fix its queue volume's owner; start the stores and Langfuse; assert and read back retention; start Tempo, Grafana and the collector; restart the reporter; verify the collector's running image digest; start Caddy; run the gates; set the route; remove the deploy marker.

Everything goes over one multiplexed SSH connection with pinned host keys (`StrictHostKeyChecking=yes`). The ssh child's environment is `PATH`, `HOME` and `SSH_AUTH_SOCK` and nothing else; a secret reaches the host on stdin only, written to a temporary file in the destination directory with its owner and mode set first, then renamed over the target.

| File | Owner and mode | Written when |
| --- | --- | --- |
| `.env` | root, 0600 | content (without the ingest-state line) differs; the state line is appended on the host |
| `secrets/collector/langfuse-basic` | root:65532, 0440 | differs. `base64(public:secret)`, no trailing newline; a placeholder the collector can start with and Langfuse refuses when the key pair is unset |
| `secrets/grafana/{admin-password,secret-key}` | 472:472, 0400 | differs |
| `secrets/reporter/{clickhouse-password,minio-password}` | 10010:10010, 0400 | differs |
| `config/**`, `docker-compose.yaml` | root, 0644 | differs |
| `health-reporter/health-report.ts` | root, 0644 | differs. Mounted read-only at `/app` |
| `tokens/<group>/token` | root:65532, 0640 | **never**, once it exists. Created with one void line only when absent (a temporary file hard-linked into place, which fails if the target exists) |

A changed config file recreates only the service that mounts it; compose recreates what a changed image or environment touches. The collector's queue volume is root-owned when Docker creates it, so deploy creates the container, sets the volume directory's owner to 65532 (only a path under Docker's data root on the volume) and reads it back, instead of relying on Docker copying ownership from the image (the host keeps images in the containerd store, where that copy is the least-tested path).

### The deploy marker and the locks

`/mnt/traces/app/.deploy-in-progress` (`TRACES_DEPLOY_MARKER` in `src/host.ts`) is a regular file with one UTC timestamp. Deploy writes it in its first host script, under the ingest lock and together with the read of the route state, so a manual open has either finished before that read or is refused after it. Deploy removes it as the very last step of a deploy that evaluated every gate and left the route in its final state, including the legitimate "completed with ingest off because the key pair is unset" outcome. Any throw leaves it, and the next deploy overwrites it. While it, or `.pending-restarts`, exists, `traces ingest open` refuses; holding never is refused. A leftover marker on an open route makes the next deploy hold first.

Every ingest state change deploy makes runs inside `flock -w 30` on `/mnt/traces/app/.ingest.lock` (`TRACES_INGEST_LOCK`), taken before the state is read and held through the Caddy recreate. A lock not taken in 30 s prints `LOCK_BUSY` and fails; it is never skipped. When deploy replaces `.env` it re-reads the state line under the same lock and writes the less open of that and its own plan, so a manual `traces ingest hold` made during a deploy survives; only the gated open step opens. The token files have their own lock (`TRACES_TOKENS_LOCK`), used by the sender-token commands only.

### Holding, gates and the route

A gated service is the collector, a backend (Langfuse, ClickHouse, MinIO, Redis, PostgreSQL, Tempo) or Caddy, and the compose file or `.env` count as changes to them. A file comparison alone cannot see that `compose up` would start a stopped gated service or recreate one whose container no longer matches the files, so on an open route whose files are all unchanged the deploy also compares each gated service's running container with the files: it must exist, be running, and carry a `com.docker.compose.config-hash` label equal to `docker compose config --hash <service>`. When the files are unchanged, the files on disk are the ones `up` will read, so this comparison needs no staging. Any difference, and any answer that cannot be trusted (failed command, missing service, unknown word), counts as a change. On an open route, a deploy that is about to change a gated service holds the route first (the same on-host command as `traces ingest hold`: the state line in `.env`, then `up -d --force-recreate --no-deps caddy`) and proves 503 on all three paths from inside the host before anything else changes. A deploy that changes nothing gated does not hold. If the hold cannot be proven, the deploy stops with nothing changed. Restarts a failed deploy left undone are recorded in `.pending-restarts` before any file is written, so the next deploy acts on them even though every file now matches, and treats them as a change.

After any failure past the marker, the deploy does not trust what it last wrote. It reads the route from the host (`.env`'s state line, and one probe of what Caddy actually answers) and accepts it only if it is positively off or held with Caddy answering as that state does (a host with no `.env` runs nothing and counts as off). Anything else, including a state change whose reply was lost after the host acted and a route another operator opened meanwhile, is held and proven 503. If that cannot be done the error says plainly that ingest may be open and names `traces ingest hold`.

After the stack is up the deploy evaluates the gates (`evaluateGates`; every gate has a failing test):

| Gate | Passes when |
| --- | --- |
| `langfuse-key` (config) | the Application-role key pair is set |
| `ingest-variable` (config) | `TRACES_INGEST_OPEN` is exactly `true` |
| `retention` | the TTLs and the lifecycle rules were asserted and read back |
| `token-directories` | every group has a token file that is not empty (a deny-all file passes; a missing or empty one fails) |
| `reporter-verdict` | a verdict produced after the reporter restart is fresh and passing |
| `canary` | `canary-send`, `canary-langfuse` and `canary-tempo` each pass |
| `bootstrap-key` | the bootstrap pair is not supplied, and Langfuse answers 401 to it (or no pair is on record) |
| `bootstrap-variables` | no `LANGFUSE_INIT_PROJECT_*KEY` has a value in the host `.env` or in any running container |

The route opens only if every gate passes. With no key pair, everything that needs a delivering stack is skipped, the route stays `off` (or is held if it was open) and the deploy completes saying which gates are missing. With the key pair set, any failing safety gate fails the deploy: an open route is held first, and the error is `AppliedButUnverifiedError`, which says the host was updated and not verified, and whether ingest is held, off, or could not be confirmed closed. After opening, the deploy proves 401 on all three paths from inside the host (`curl --resolve`, the real certificate and route) and holds again if it cannot.

### Retention

`src/retention.ts` asserts on every deploy: a 30-day TTL (`toDateTime(start_time) + INTERVAL 30 DAY`) on `events_full` and `events_core` (required; Langfuse creates them, so missing is "not ready" and retried, then a failure that names them), and on `traces`, `observations`, `observations_pid_tid_sorting` and `scores` where they exist; and 30-day lifecycle rules on the object store's `events/` (every OTLP batch, kept until something deletes it) and `media/` (attachments Langfuse extracts from trace content, so content can sit there) prefixes. A rule already on a prefix that is not a 30-day expiry is a conflict, not something the deploy edits. Everything is read back; no `ALTER` runs when a TTL already matches.

### The first deploys

1. **Deploy 1**: store and Langfuse-user secrets, the bootstrap pair, no key pair, `TRACES_INGEST_OPEN` unset. Stack up, retention asserted, `ingest off`, a message that the key pair is not set. Langfuse creates the organisation, project, user and the full-access bootstrap key from `LANGFUSE_INIT_*`.
2. Operator: open the tunnel, create the Application-role key in the Langfuse UI, delete the bootstrap key there, set `TRACES_LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`, delete the `TRACES_LANGFUSE_BOOTSTRAP_*` secrets, publish the privacy page, set `TRACES_INGEST_OPEN=true`.
3. **Deploy 2**: `.env` is rewritten without the bootstrap key variables and Langfuse web is recreated; the pair that was in the old `.env` is set aside in `secrets/bootstrap-pending` (root, 0400, mounted nowhere) and used to probe Langfuse. 401: the key is dead, the record is removed, and if every other gate passes the route opens. 200: the deploy fails with ingest off and says to delete the key in the UI; **deploy 3** (any run, same inputs) probes the record again.
4. Sender tokens are issued afterwards, with `traces sender add`.

### Langfuse `LANGFUSE_INIT_*` at v4.83.0

`web/src/initialize.ts` at the `v4.83.0` tag: the organisation and the project are `upsert`s with `update: {}`; the user is created only when no user with that email exists, so a later boot never resets the password and rotating `TRACES_LANGFUSE_USER_PASSWORD` changes nothing after the first boot; the organisation membership is re-asserted as `OWNER`. The API key is created only when `LANGFUSE_INIT_PROJECT_ID`, `..._PUBLIC_KEY` and `..._SECRET_KEY` are all set and no key with that public key exists, so **a key deleted in the UI comes back on the next boot while the key variables are present**, as a `LEGACY_PROJECT_API_KEY` with full access. With the two key variables absent and the organisation, project and user variables still set, a boot creates no key and changes no password. That is the design: the key variables are written only when the bootstrap pair is supplied, never otherwise.

## Secrets and tokens

Nothing secret is in a tracked file. The stack reads `.env` from the app directory (`POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_READER_PASSWORD`, `MINIO_ROOT_PASSWORD`, `REDIS_AUTH`, `SALT`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `TRACES_DOMAIN`, `TRACES_COLLECTOR_IMAGE`, `TRACES_INGEST_STATE`, and the `LANGFUSE_INIT_*` bootstrap values), and files from directories mounted read-only, owned as the table under "Deploy" says. Passwords go inside connection URLs, so each is URL-safe (letters, digits, `. _ ~ -`) and at least 24 characters; the encryption key is 64 hex.

The collector runs as UID 65532. Its token directories must be readable and its queue volume writable by that user. Sender tokens belong to the operator command (`traces sender`); a token file it replaces keeps `root:65532` and mode 0640.

### Token files

A token file is never empty. Measured against the pinned collector image: replacing a live token file with an empty one left the old token accepted; replacing it with a different line revoked the old token in about a tenth of a second; and a collector started with an empty or missing token file starts, answers 401 to everything, and does not notice a token added later until it is restarted (the credential watcher in `extension/internal/credentialsfile/filewatcher.go` at v0.165.0 rejects an empty file and is not registered when the first read fails).

So "no tokens" is one **void line**: `trc_void_<43 base64url characters> void <timestamp>` (`TRACES_VOID_TOKEN_PREFIX` in `src/host.ts`), a token generated on the operator's machine, sent on stdin and kept nowhere. A real token is any line whose first field does not start with that prefix. Deploy creates a missing file as one void line. `traces sender revoke` of a group's last real token and `revoke --all` write a fresh void line. `list` hides void lines. Provisioning's `--reopen-ports` refuses while any group has a real token and faults on a missing or empty file. If a file is ever found empty, write a void line (`traces sender revoke --all` does) and restart the collector.

## Anti-patterns

- **Never publish a store port.** ClickHouse, PostgreSQL, Redis, MinIO and Tempo stay off the host. Only Caddy, Langfuse web (loopback) and Grafana (loopback) have a `ports` entry; a test enforces it.
- **Never add a processor to the Langfuse branch.** Langfuse gets the whole trace. A processor there (`batch`, `transform`, anything) changes what is stored. No `batch` or `transform` processor anywhere.
- **Never put a content key in the keep-list.** The six `gen_ai` content keys stay out; a test enforces it.
- **Never copy a token off the host, and never let deploy touch one.** Sender tokens live in `tokens/` on the encrypted volume and at the senders; `list` shows fingerprints only. Deploy creates a file with one void line when none exists and never writes, replaces, truncates or removes an existing one.
- **Never pass a secret on a command line.** Secret bytes go over SSH stdin; the SSH argv and the SSH child's environment carry none, and the remote scripts read passwords from the container's own environment.
- **Never write the `LANGFUSE_INIT_PROJECT_*KEY` variables unless the bootstrap pair is being supplied.** Langfuse recreates a deleted key from them on the next boot.
- **Never open the route without every gate.** Open means all gates pass and `TRACES_INGEST_OPEN` is exactly `true`; `mayOpen` is the only decision and a skipped gate is not a pass.
- **Never change a gated service on an open route without holding it first.** The hold comes before the first write to the stack, and a service that is stopped or drifted from its files counts as a change.
- **Never trust the deploy's own record of the route after a failure.** Read it from the host; a lost reply and a concurrent `traces ingest open` both leave it different from what the deploy wrote.
- **Never remove the deploy marker on any path but a completed deploy.** A failed or interrupted deploy leaves it; that is what keeps `traces ingest open` refused.
- **Never `docker compose down -v`.** The volumes hold the traces. Deploy only ever runs `up -d` (and `create --no-recreate` for the collector container).
- **Never cap ClickHouse memory.** Capping it near 7 GB made the Langfuse worker drop rows after the sender got 200.
- **Never add a compose healthcheck to the collector or Tempo.** Both are distroless images with no shell; the health reporter probes them.
- **Never leave `TRACES_INGEST_STATE=open` unless every gate has passed.**
- **Never empty a token file.** The collector keeps the old tokens, and a file that is empty at start is never watched. Write a void line.
- **Never read the route state or write the deploy marker outside the ingest lock.**
- **Never regenerate a long-lived secret** (`SALT`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, store passwords). A volume holds data keyed to them; deploy never generates one.
- **No remote command redirects to the null device or deletes outside the app directory and `/tmp`**, and every probe prints a sentinel and needs exit 0 plus a recognised sentinel; a test checks every script.

## Known outbound calls

Telemetry is off wherever a setting exists. Langfuse web contacts `langfuse.com` for an update check when the UI loads (no setting), and the browser fetches two badge and asset hosts. Grafana makes no outbound call with the plugin pre-installer, update checks, Gravatar and the news feed off.

## Proven only on the real host

The deploy tests run the generated scripts through a simulated host and parse every one with `bash -n`; the token script also runs for real against a scratch directory. These behaviours can only be proven on the host, so the first deploy is where they are checked: the `mc ilm rule export|add` spellings and output shape inside the Chainguard MinIO image, `clickhouse-client` with `CLICKHOUSE_PASSWORD` from the container's environment, the TTL read-back text ClickHouse prints (`toIntervalDay(30)`), the bootstrap probe (a `node -e` fetch inside the Langfuse web container), `curl --resolve` to Caddy on the host's own loopback with a real certificate, `docker compose create --no-recreate` and the queue-volume owner, the repo-digest read-back under the containerd image store, and compose's recreate decisions for the forced and native restarts, that `docker compose config --hash <service>` prints the value stored in a container's `com.docker.compose.config-hash` label (if not, the deploy only ever holds more, never less), `flock` and descriptor 9 behaving as written over ssh, the single probe the failure handler makes, `ln`, `mktemp`, `awk` and `date -u` in the token and state scripts on the host's coreutils, and the reporter's read of a real Langfuse row and raw batch (the `blob_storage_file_path` column, and where the status message and scope attributes land).

The runbook (`docs/runbooks/trace-collection.md`) is written when the stack is first deployed.
