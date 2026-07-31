# Umami retention attestation — `YYYY-MM-DDTHHMMZ`

Fill every `[fill]` field. Use UTC. Record counts, categories, hashes, and statuses only; never paste secrets, raw visitor data, identifiers, query strings, or raw log payloads.

## Attestation

- Date/time (UTC): `[fill]`
- Operator: `[fill]`
- Status: `GO` / `NO-GO` — `[fill]`
- Scope: `first supervised apply` / `routine evidence refresh` / `rollback` — `[fill]`

## Version and release identity

- Infra commit: `[fill exact commit]`
- Retention release hash: `[fill 64-hex hash]`
- `/opt/umami/retention/current` readlink: `[fill exact target]`
- Umami image/version: `umamisoftware/umami:3.2.0` — digest `[fill exact digest]`
- Postgres image/version: `postgres:15-alpine` — digest `[fill exact digest]`
- `/etc/systemd/system/umami-retention.service` SHA-256: `[fill]`
- `/etc/systemd/system/umami-retention.timer` SHA-256: `[fill]`
- `mrbro.dev` requirements/plan revision: `[fill path, revision, or approved reference]`

## Approved recovery point

- Backup filename: `[fill]`
- Backup size (bytes): `[fill]`
- Backup SHA-256: `[fill]`
- `gzip -t` result: `PASS` / `FAIL` — `[fill]`
- Backup timestamp (UTC): `[fill]`
- Daily automated backup present: `NO` — `[fill any exception or concern]`

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
- Existing Systematic dashboard health: `PASS / FAIL` — `[fill URL/status, no payload]`
- Existing dev-like dashboard health: `PASS / FAIL` — `[fill URL/status, no payload]`
- Fresh-record arrival proof: `[fill count/category delta only; no visitor payload]`

## Timer evidence

- Timer enabled: `yes / no` — `[fill]`
- Timer active: `yes / no` — `[fill]`
- Next run evidence: `[fill exact list-timers/status result]`
- Timer journal evidence: `[fill artifact/path or concise status]`
- Schedule observed: `00:30–01:00 UTC, Persistent=true` — `[fill]`

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
