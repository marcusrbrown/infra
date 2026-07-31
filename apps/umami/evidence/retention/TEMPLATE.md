# Umami retention attestation — `YYYY-MM-DDTHHMMZ`

Fill every `[fill]` field. Use UTC. Record counts, categories, hashes, and statuses only; never paste secrets, raw visitor data, identifiers, query strings, or raw log payloads.

## Attestation

- Date/time (UTC): `[fill]`
- Operator: `[fill]`
- Status: `GO (timer-driven/catch-up)` / `GO (operator override)` / `NO-GO` — `[fill]`
- Scope: `first supervised apply` / `routine evidence refresh` / `rollback` — `[fill]`

## Version and release identity

- Infra commit: `[fill exact commit]`
- Retention release hash: `[fill 64-hex hash]`
- `/opt/umami/retention/current` readlink: `[fill exact target]`
- Umami image/version: `umamisoftware/umami:3.2.0@sha256:d8111e1d6d94be54a54514cd4e1264fbfe905e5ea0d0691804b1d71e627a6fca` — `[fill confirmation]`
- Postgres image/version: `postgres:15-alpine@sha256:cd17e2ac98240fce1541ad2a803b34009b4eea5aec8a832363cdc7eca62e722e` — `[fill confirmation]`
- `/etc/systemd/system/umami-retention.service` SHA-256: `[fill]`
- `/etc/systemd/system/umami-retention.timer` SHA-256: `[fill]`
- `mrbro.dev` requirements/plan revision: `[fill path, revision, or approved reference]`

## Approved recovery point

- Backup filename: `[fill]`
- Backup size (bytes): `[fill]`
- Backup SHA-256: `[fill]`
- Archive format: `PostgreSQL custom (-Fc)` — `[fill]`
- Archive-list validation in pinned disposable container: `PASS` / `FAIL` — `[fill command/result; no local pg_restore]`
- Source capture state: `caddy+umami stopped, db up; brief analytics downtime acknowledged` — `[fill]`
- Source manifest path: `[fill local path]`
- Source manifest SHA-256: `[fill]`
- Disposable restore image: `postgres:15-alpine@sha256:cd17e2ac98240fce1541ad2a803b34009b4eea5aec8a832363cdc7eca62e722e` — `[fill confirmation]`
- Disposable restore isolation: `--network none; tmpfs /var/lib/postgresql/data; no published ports; trust auth only inside disposable container` — `[fill]`
- Restored DB manifest query: `PASS` / `FAIL` — `[fill]`
- Restored manifest path: `[fill local path]`
- Restored manifest SHA-256: `[fill]`
- Exact source/restored manifest `diff`: `PASS` / `FAIL` — `[fill]`
- Disposable restore container removal: `PASS` / `FAIL` — `[fill]`
- Production restart and `/api/heartbeat`: `PASS` / `FAIL` — `[fill status only]`
- Backup timestamp (UTC): `[fill]`
- Daily automated backup present: `NO` — `[fill any exception or concern]`

GO is impossible if any recovery-point field is missing or failing.

## Pre-check (`--check`)

- Command: `[fill exact command]`
- Output artifact path: `[fill local path]`
- Output artifact SHA-256: `[fill]`
- Null `created_at` status: `0 / FAIL` — `[fill]`
- Orphan baseline status: `STABLE / FAIL` — `[fill before counts and result]`

| Table                  |   Before | Protected | Eligible/remaining |
| ---------------------- | -------: | --------: | -----------------: |
| `event_data`           | `[fill]` |  `[fill]` |           `[fill]` |
| `website_event`        | `[fill]` |  `[fill]` |           `[fill]` |
| `session_data`         | `[fill]` |  `[fill]` |           `[fill]` |
| `revenue`              | `[fill]` |  `[fill]` |           `[fill]` |
| `session_replay`       | `[fill]` |  `[fill]` |           `[fill]` |
| `session_replay_saved` | `[fill]` |  `[fill]` |           `[fill]` |
| `heatmap_event`        | `[fill]` |  `[fill]` |           `[fill]` |
| `session`              | `[fill]` |  `[fill]` |           `[fill]` |

## Supervised apply (`--apply`)

- Approval gate/operator: `[fill]`
- Command: `[fill exact command]`
- Output artifact path: `[fill local path]`
- Output artifact SHA-256: `[fill]`
- Apply status: `PASS / FAIL / NOT RUN` — `[fill]`
- Transaction/rollback result: `[fill]`

| Table                  |   Before |  Deleted | Protected | Remaining |
| ---------------------- | -------: | -------: | --------: | --------: |
| `event_data`           | `[fill]` | `[fill]` |  `[fill]` |  `[fill]` |
| `website_event`        | `[fill]` | `[fill]` |  `[fill]` |  `[fill]` |
| `session_data`         | `[fill]` | `[fill]` |  `[fill]` |  `[fill]` |
| `revenue`              | `[fill]` | `[fill]` |  `[fill]` |  `[fill]` |
| `session_replay`       | `[fill]` | `[fill]` |  `[fill]` |  `[fill]` |
| `session_replay_saved` | `[fill]` | `[fill]` |  `[fill]` |  `[fill]` |
| `heatmap_event`        | `[fill]` | `[fill]` |  `[fill]` |  `[fill]` |
| `session`              | `[fill]` | `[fill]` |  `[fill]` |  `[fill]` |

| Orphan table     |   Before |    After |    Delta |
| ---------------- | -------: | -------: | -------: |
| `event_data`     | `[fill]` | `[fill]` | `[fill]` |
| `website_event`  | `[fill]` | `[fill]` | `[fill]` |
| `session_data`   | `[fill]` | `[fill]` | `[fill]` |
| `revenue`        | `[fill]` | `[fill]` | `[fill]` |
| `session_replay` | `[fill]` | `[fill]` | `[fill]` |
| `heatmap_event`  | `[fill]` | `[fill]` | `[fill]` |

## Post-check and health evidence

- Post-check command: `[fill exact command]`
- Post-check output artifact path: `[fill local path]`
- Post-check output artifact SHA-256: `[fill]`
- Post-check eligible/remaining rows: `0 / FAIL` — `[fill]`
- Post-check null `created_at`: `0 / FAIL` — `[fill]`
- Post-check orphan deltas: `non-positive / FAIL` — `[fill]`
- Umami heartbeat (`/api/heartbeat`): `PASS / FAIL` — `[fill status only]`
- DB health (`pg_isready`) and container health: `PASS / FAIL` — `[fill status only]`
- `https://fro.bot/systematic` health: `PASS / FAIL` — `[fill status, no payload]`
- `https://mrbro.dev/dev-like` health: `PASS / FAIL` — `[fill status, no payload]`
- Fresh-record UTC window: `[fill start/end]`
- Fresh-record before count/category: `[fill count/category]`
- Controlled matching interaction: `exactly one` — `[fill action/category only]`
- Fresh-record after count/category: `[fill count/category]`
- Fresh-record delta: `+1 / documented exact expected delta / FAIL` — `[fill counts/categories only]`

## Timer evidence

- Timer enabled: `yes / no` — `[fill]`
- Timer active: `yes / no` — `[fill]`
- Enable timestamp (UTC): `[fill]`
- Catch-up/scheduled service execution timestamp (UTC): `[fill exact ExecMainStartTimestamp or NOT OBSERVED]`
- Service `Result`: `[fill exact value]`
- Service `ExecMainStatus`: `[fill exact value]`
- Service execution exit timestamp (UTC): `[fill exact ExecMainExitTimestamp or NOT OBSERVED]`
- Timer journal artifact: `[fill local path and SHA-256]`
- Successful timer-driven/catch-up service execution after enable: `YES / NO` — `[fill; required for the timer-driven/catch-up path; `NO` is allowed only for a documented operator override]`
- Next run evidence: `[fill exact list-timers/status result]`
- Timer journal evidence: `[fill artifact/path or concise status]`
- Schedule observed: `00:30–01:00 UTC, Persistent=true` — `[fill]`
- First-enable semantics: `Persistent=true` does not guarantee a catch-up on first-ever enable because no prior timer stamp exists; the next scheduled run may be the first timer edge — `[fill]`
- GO path: `timer-driven/catch-up` / `operator override` — `[fill]`
- Exact gate overridden: `observed timer edge before activation` / `not applicable` — `[fill]`
- Accepted residual risk: `[fill; required for operator override]`
- Mandatory post-activation confirmation of the first scheduled timer run: `[fill required follow-up evidence and owner]`

GO is allowed either with a successful timer-driven or catch-up service execution after enable, or through an explicit operator override. For the override path, the timer edge may remain `NOT OBSERVED`, but the record must include accepted residual risk, `systemd-analyze verify` success, service `Result=success` and `ExecMainStatus=0`, timer enabled/active state, the bound service and next scheduled run, plus mandatory post-activation confirmation of the first scheduled timer run. Never claim a calendar or catch-up timer run occurred when it remains unobserved.

## Rollback and disable verification

- Disable command/result: `[fill]`
- Rollback release hash, if used: `[fill or not used]`
- Rollback `current` readlink: `[fill or not used]`
- Service/timer unit restore result: `[fill or not used]`
- Post-rollback timer state: `disabled/inactive / FAIL / not applicable` — `[fill]`

## Decision and signoff

- GO/NO-GO: `[fill]`
- Fail-closed reasons observed or ruled out: lock contention `[fill]`; timeout `[fill]`; null timestamps `[fill]`; nonzero eligible remaining `[fill]`; positive orphan delta `[fill]`; other command/SQL error `[fill]`.
- Operator signoff: `[fill name/handle and UTC timestamp]`
- Review/signoff reference: `[fill]`

After this file is complete and reviewed, compute its final SHA-256 externally and provide the file path plus digest to the `mrbro.dev` activation review. **Do not add a self-referential hash field here.**
