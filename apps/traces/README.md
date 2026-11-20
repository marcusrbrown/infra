# Traces

Self-hosted collection of agent-run traces at `traces.fro.bot`.

A collector accepts OTLP over HTTP, tells three sender groups apart by bearer token, limits each group by bytes, and forwards every trace to Langfuse (whole) and Tempo (structural attributes only). Langfuse and Grafana are reached through an SSH tunnel and have no public hostname. The stack is a Docker Compose project on a dedicated DigitalOcean droplet, with its data on an attached encrypted volume.

| Service   | Role                                                                     |
| --------- | ------------------------------------------------------------------------ |
| Caddy     | TLS, request body cap, `/<group>/v1/traces` and `/healthz`               |
| collector | Token auth, byte limiter, fan-out, persistent queues                     |
| Langfuse  | Where runs are read (web + worker; ClickHouse, PostgreSQL, Redis, MinIO) |
| Tempo     | Trace store for the keep-listed attributes                               |
| Grafana   | Queries Tempo                                                            |

See [`AGENTS.md`](AGENTS.md) for the layout, the three ingest states, limits and the rules that must not be broken, and `docs/plans/2026-11-20-001-feat-trace-collection-stack-plan.md` for the decisions behind them.

## Status

The stack definition is in place (`docker-compose.yaml` and `config/`). Provisioning, deploy, the CLI commands, the health reporter, monitoring and the runbook arrive in later units; until then the directory is not deployable.

Check the compose file with dummy values (nothing is pulled):

```bash
docker compose --env-file <throwaway-env> -f apps/traces/docker-compose.yaml config -q
```

Tests:

```bash
bun test apps/traces
```
