# apps/traces — trace collection stack

Collector, Langfuse, Tempo and Grafana for agent-run traces, on a dedicated DigitalOcean droplet at `traces.fro.bot`. A collector accepts OTLP over HTTP on that one public hostname, tells three sender groups apart by bearer token, limits each group by bytes, and sends every trace two ways: whole to Langfuse, and reduced to a named list of attributes to Tempo. Langfuse and Grafana have no public hostname; both are reached through an SSH tunnel. Ingest and a health path are the only public routes.

The decision record is `docs/plans/2026-11-20-001-feat-trace-collection-stack-plan.md`. This file covers what is built so far: the stack definition. Deploy, provisioning, the sender-token commands, the health reporter, the CI image build and the monitors arrive in later units and are marked below.

## Structure

```text
├── docker-compose.yaml       Stack: Caddy, collector, Langfuse web + worker, ClickHouse, PostgreSQL, Redis, MinIO, Tempo, Grafana
├── config/
│   ├── Caddyfile             One site; /healthz; 404 for everything else; imports one ingest state file
│   ├── ingest/               off.caddy, held.caddy, open.caddy: the three ingest states
│   ├── otelcol.yaml          Receivers, byte limiter, group stamp, Langfuse exporters, keep-list, Tempo exporter
│   ├── tempo.yaml            Monolithic, local disk, 720 h retention, 20 MB trace limit
│   ├── clickhouse/           System-log TTLs (config.d). No memory settings
│   └── grafana/datasources/  Provisioned Tempo data source
├── collector/                Builder manifest and Dockerfile for the collector image
├── server/provision.ts       (later unit) Droplet, volume, firewall
├── src/deploy.ts, host.ts    (later units) Gated deploy and host checks
└── src/health-report.ts      (later unit) Health reporter service
```

## Networks and exposure

| Network   | Members                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `edge`    | Caddy, collector, Langfuse web, Tempo (and the health reporter)               |
| `backend` | Grafana, ClickHouse, PostgreSQL, Redis, MinIO, Langfuse web and worker, Tempo |

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

## Secrets and tokens

Nothing secret is in a tracked file. The stack reads `.env` from the app directory (`POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`, `MINIO_ROOT_PASSWORD`, `REDIS_AUTH`, `SALT`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `TRACES_DOMAIN`, `TRACES_COLLECTOR_IMAGE`, and the optional `LANGFUSE_INIT_*` bootstrap values), and files from two directories mounted read-only:

| Path | Holds |
| --- | --- |
| `tokens/<group>/token` | One sender token per line, extra columns ignored. Owned by the operator command, not deploy |
| `secrets/collector/langfuse-basic` | `base64(public:secret)` of the Langfuse key, no trailing newline |
| `secrets/grafana/` | `admin-password`, `secret-key` |

The collector runs as UID 65532. Its token directories must be readable and its queue volume writable by that user.

## Anti-patterns

- **Never publish a store port.** ClickHouse, PostgreSQL, Redis, MinIO and Tempo stay off the host. Only Caddy, Langfuse web (loopback) and Grafana (loopback) have a `ports` entry; a test enforces it.
- **Never add a processor to the Langfuse branch.** Langfuse gets the whole trace. A processor there (`batch`, `transform`, anything) changes what is stored. No `batch` or `transform` processor anywhere.
- **Never put a content key in the keep-list.** The six `gen_ai` content keys stay out; a test enforces it.
- **Never copy a token off the host.** Sender tokens live in `tokens/` on the encrypted volume and at the senders; `list` shows fingerprints only.
- **Never `docker compose down -v`.** The volumes hold the traces. Deploy only ever runs `up -d`.
- **Never cap ClickHouse memory.** Capping it near 7 GB made the Langfuse worker drop rows after the sender got 200.
- **Never add a compose healthcheck to the collector or Tempo.** Both are distroless images with no shell; the health reporter probes them.
- **Never leave `TRACES_INGEST_STATE=open` unless every gate has passed.**
- **Never regenerate a long-lived secret** (`SALT`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, store passwords). A volume holds data keyed to them.

## Known outbound calls

Telemetry is off wherever a setting exists. Langfuse web contacts `langfuse.com` for an update check when the UI loads (no setting), and the browser fetches two badge and asset hosts. Grafana makes no outbound call with the plugin pre-installer, update checks, Gravatar and the news feed off.

## Not built yet

Deploy (`src/deploy.ts`), provisioning (`server/provision.ts`), the CLI group (`traces deploy|status|open|logs|ingest|sender`), the health reporter, the monitor and backup workflows, and the runbook (`docs/runbooks/trace-collection.md`) arrive in later units of the plan. Until then this directory is not deployable.
