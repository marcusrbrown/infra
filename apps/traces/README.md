# Traces

Self-hosted collection of agent-run traces at `traces.fro.bot`.

A collector accepts OTLP over HTTP, tells three sender groups apart by bearer token, limits each group by bytes, and forwards every trace to Langfuse (whole) and Tempo (structural attributes only). Langfuse and Grafana are reached through an SSH tunnel and have no public hostname. The stack is a Docker Compose project on a dedicated DigitalOcean droplet, with its data on an attached encrypted volume.

| Service | Role |
| --- | --- |
| Caddy | TLS, request body cap, `/<group>/v1/traces` and `/healthz` |
| collector | Token auth, byte limiter, fan-out, persistent queues |
| Langfuse | Where runs are read (web + worker; ClickHouse, PostgreSQL, Redis, MinIO) |
| Tempo | Trace store for the keep-listed attributes |
| Grafana | Queries Tempo and Prometheus; owns the alert rules, which post to a Discord webhook |
| Prometheus | Scrapes the collector, Tempo, the reporter and itself every 30 s; keeps 15 days; no rules |
| health reporter | One verdict for the stack and the gauges Prometheus scrapes; the deploy runs it once more to send a canary trace and read it back |

See [`AGENTS.md`](AGENTS.md) for the layout, the three ingest states, the deploy gates, limits and the rules that must not be broken, and `docs/plans/2026-11-20-001-feat-trace-collection-stack-plan.md` for the decisions behind them.

## Deploy

```bash
bun run deploy:traces        # loads the root .env; the deploy-traces workflow runs the same script
```

The deploy brings the stack up privately, checks each gate, and opens the public ingest route only when every gate passes and `TRACES_INGEST_OPEN` is exactly `true`. A first deploy ends with ingest off and a message naming the gates that are not met. On a host that already serves traffic, a deploy that changes the collector, a backend or their configuration holds the route (503) first, and a deploy that fails a gate leaves it held. Retention (30 days in ClickHouse and in the object store) is asserted and read back on every deploy.

Alerts: Grafana-managed rules over Prometheus metrics (`config/grafana/alerting/`) post to a Discord webhook (`TRACES_DISCORD_WEBHOOK_URL`, required). No Alertmanager. The deploy checks that Grafana loaded the contact point and the rule groups; it sends no test message. The rules and how to silence one are in `docs/runbooks/trace-collection.md`.

Inputs are the names exported by `src/deploy.ts` (`TRACES_DEPLOY_SECRETS`, `TRACES_DEPLOY_VARS`, `TRACES_DEPLOY_BUILD_INPUTS`). Secrets reach the host over SSH stdin only; no sender token is ever read.

## Checks

Check the compose file with dummy values (nothing is pulled):

```bash
docker compose --env-file <throwaway-env> -f apps/traces/docker-compose.yaml config -q
```

Tests (every one runs against injected fakes; nothing reaches a host):

```bash
bun --env-file=/dev/null test apps/traces
```
