---
title: "fix: Cap gateway workspace memory and surface OOM kills"
type: fix
status: completed
date: 2026-10-23
origin: docs/brainstorms/2026-10-23-gateway-workspace-memory-cap-requirements.md
---

# fix: Cap gateway workspace memory and surface OOM kills

## Overview

The gateway deploy gives the `workspace` service a hard memory limit with an equal swap limit. Every deploy reads the limit back from the running container. `gateway status` shows the limit, current usage, how often the kernel killed a process at the limit, and the OpenCode supervisor state. Docs cover the limit and recovery. Two upstream issues cover stuck runs and the memory growth itself.

## Problem Frame

On 2026-10-23 the workspace's long-lived `opencode serve` reached about 1.1 GiB on the 2 GB no-swap gateway droplet. Host memory fell to 5 MB available and `/operator/health` timed out for about 12 minutes, with no OOM kill logged. No gateway service has a memory limit, so one container's growth stalls the whole host (see origin: `docs/brainstorms/2026-10-23-gateway-workspace-memory-cap-requirements.md`, #1652).

## Requirements Trace

- R1. Hard memory limit on `workspace` only.
- R2. Swap limit set now, equal to the memory limit.
- R3. Limit sized for the whole container from a measured run peak.
- R4. A stated host available-memory floor holds with the workspace at its limit.
- R5. Regression test fails if the memory or swap limit disappears.
- R6. Every deploy reads back the running limits and fails on mismatch.
- R7. `gateway status` (and so `status --json` and MCP) shows the workspace OOM-kill count and the supervisor's `degraded` state.
- R8. Upstream issue: bounded terminal state for runs whose workspace died.
- R9. Upstream issue: long-lived `opencode serve` growth, with recycling.
- R10. `apps/gateway/AGENTS.md` documents the limit, detection, and recovery.

## Scope Boundaries

- No droplet resize, no host swap, no OOM-score or reservation tuning on other services.
- No infra-side OpenCode recycling and no infra-side reconciliation of stuck runs.
- No production breach test. The first real kill is observed through the counter.
- The daily Fro Bot report is unchanged; it runs no status command.
- No alerting threshold on the kill count. Status displays it; it does not page.

### Deferred to Separate Tasks

- The stale "gateway has NO public HTTP surface" paragraph in `.github/workflows/fro-bot.yaml` `SCHEDULE_PROMPT`: separate docs fix.
- The stale "no persistent volume for `/workspace/repos`" claim in `docs/solutions/integration-issues/gateway-mention-loop-stalls-2026-06-03.md`: `ce:compound-refresh` later.

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/src/deploy.ts` `buildComposeOverride`: the workspace block is a fixed literal holding `image:`, `environment:` and `volumes:`. Other services come from conditional sections, so keys added to the workspace block cannot leak.
- `apps/gateway/src/deploy.ts` `COMPOSE_WAIT_TIMEOUT_SECONDS`: an exported numeric constant with sizing rationale in its doc comment. The limit constant follows this shape.
- `apps/gateway/src/deploy.ts` Phase 9c and `assertRunningImageDigest`: post-`up` `docker inspect` of `$(docker compose ps -q <service>)` with a fail-closed parse and an Expected/Actual error. The new readback copies this structure.
- `apps/gateway/src/deploy.test.ts` `makeSpawnMock`: per-command default responders. A new readback needs a default branch, or every `main()` test receives empty output.
- `packages/cli/src/commands/gateway/status.ts` `getGatewayComposeStatus`: one SSH call with an explicit identity and redacted errors. `gatewayStatusAction` exits 1 only when a service isn't running. `getGatewayStatusSummary` flattens rows into the `http` string consumed by `packages/cli/src/commands/status.ts`.
- `packages/cli/src/commands/gateway/status.test.ts`: `makeSpawnOk` returns one stdout for every command. Multi-probe tests need per-command responders, or a single combined command with delimiters.
- `packages/cli/src/commands/mcp.ts` `MCP_ALLOWLIST` already lists `gateway status` and `status`. Output-only changes need no allowlist or conventions change.

### Institutional Learnings

- `docs/solutions/workflow-issues/primary-source-verification-for-delegated-findings-2026-09-12.md`: remote probes fail closed. Require a recognized value, never infer state from an exit code.
- `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`: verify the running container, not the rendered config alone.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`: test status parsing against realistic remote stdout, not pre-parsed objects.
- `docs/solutions/integration-issues/ssh-agent-too-many-authentication-failures-2026-06-13.md`: status keeps `-i` with `IdentitiesOnly=yes`. CLI helpers stay inside `packages/cli`.
- `docs/solutions/integration-issues/gateway-operator-health-probe-untrusted-peer-2026-10-14.md`: a check that never logs success is not a check. The readback logs a success line.
- `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`: the earlier memory outage on this droplet, from on-host builds. Off-droplet builds stay.

### External References

- fro-bot/agent `apps/workspace-agent/src/main.ts` and `src/opencode-server.ts` at `v0.124.1`. The supervisor writes `starting | ready | down | degraded`, `/healthz` and `/readyz` on `0.0.0.0:9100` read it without auth, and `/readyz` returns `{ready, opencode}` with 503 unless `opencode` is `ready`. PID 1 is tini. Four launch attempts, with the retry budget reset after 60 s of uptime. Upstream compose sets `restart: unless-stopped` on workspace.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "apps/gateway, packages/cli/src/commands/gateway, .github/workflows/fro-bot.yaml",
  "freshness": {
    "scope_baseline": "branch fix/gateway-workspace-memory-cap at origin/main, 2026-10-23"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "apps/gateway/src/deploy.ts: Phase 9c assertRunningImageDigest",
      "description": "post-up docker inspect of running containers with fail-closed parse",
      "disposition": "insufficient",
      "insufficiency_reason": "reads image digests only; the memory readback copies its structure as new code"
    },
    {
      "path_or_symbol": "packages/cli/src/commands/gateway/status.ts: getGatewayComposeStatus",
      "description": "single SSH docker compose ps with ServiceRow state and health",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "apps/dashboard/src/remote-deploy.ts docker inspect checks",
      "description": "fail-closed shell evidence checks for the dashboard",
      "disposition": "insufficient",
      "insufficiency_reason": "dashboard-specific and reads no memory or cgroup data"
    }
  ]
}
```

## Key Technical Decisions

- **One exported limit constant, 1024 MiB.** All figures are in MiB, as `free -m` reports them. The limit was chosen from the sampled host floor: with the workspace using 848 MiB under the live 896 MiB limit, host available memory bottomed at 490 MiB, so a 1024 MiB limit leaves about 314 MiB available, above the 256 MiB floor. Across three launches on three different repos, `opencode serve` anonymous memory grew from about 360 to about 618 MiB and stayed there, so the limit acts as a recycling point rather than a per-run ceiling. The override, the readback, the status display and the tests all read this constant (see origin: R3, R4).
- **Use the compose keys `mem_limit` and `memswap_limit`, not `deploy.resources`.** Non-swarm compose maps them to `HostConfig.Memory` and `HostConfig.MemorySwap`. `deploy.resources` has no swap field.
- **The post-`up` readback is the only runtime check.** It compares the running container with the constant, so it also catches an upstream compose that sets its own limit. No separate merged-config gate runs before `up`.
- **The readback is strict, fail-closed, and makes a single read.**
  - Resolve the container with `docker compose ps -q workspace`.
  - Zero or more than one container ID throws.
  - `Memory` and `MemorySwap` must both equal the constant in bytes. An empty value, `0`, `-1`, or a non-integer throws with expected and actual values.
  - Success logs one line that names the limit.
  - A throw leaves the stack running and keeps the old secrets checksum, so the next deploy recreates the containers. Status shows the missing or mismatched limit in the meantime.
- **`gateway status` runs one extra SSH call with one timeout of about 10 s.** That call resolves the workspace ID with `docker compose ps -q workspace` and then reads:
  - `docker inspect`: `HostConfig.Memory`, `State.OOMKilled`, `RestartCount` and `StartedAt`;
  - `docker exec <id>`: `/sys/fs/cgroup/memory.current` and `/sys/fs/cgroup/memory.events` (`max`, `oom_kill`). Docker's private cgroup namespace on cgroup v2 makes these the container's own files.
  - `docker exec <id>` with Node: `GET http://127.0.0.1:9100/readyz`. The state comes from the JSON `opencode` field whatever the HTTP status, because 503 covers `starting`, `degraded` and `down`. The endpoint needs no bearer token. The probe is skipped when `memory.current` is within 64 MiB of the limit, so it can't push the container into an OOM kill.

  If the call fails, times out, or any section fails to parse, that block reports `unknown`. The existing compose call and its output are unchanged.

- **Status display rules.**
  - The supervisor state and memory figures are display-only, and the exit code and `OK`/`DEGRADED` keep following compose state.
  - The unified summary keeps its prefix and appends a tagged suffix with no `|`, for example `workspace mem=412/896MiB oom_kills=0 opencode=ready`.
  - A missing limit shows as `limit=none`.
  - Kill counts are labelled as counted since the container last started, because the counter resets on every recreate and whenever tini exits after its child dies.
- **Apply the limit live before merge.** One `docker update --memory 896m --memory-swap 896m` on the running workspace container, read back from `memory.max`. It protects production now, and the pre-merge samples are taken under the real limit. The first deploy then replaces it with the compose-managed limit.
- **The first deploy recreates every gateway service.** The override is part of the secrets checksum, so the first deploy runs `up` with `--force-recreate`. Gateway, mitmproxy, Caddy and workspace all restart. In-flight runs are interrupted and must be cancelled by hand. Checkouts survive on the `fro-bot_workspace-repos` volume. This is a documented warning, not a blocking check.

## Open Questions

### Resolved During Planning

- **Daily report:** unchanged. R7 now covers only `gateway status`, `status --json` and MCP (origin doc updated).
- **Readback mismatch:** the stack keeps running and status shows the limit gap. The workspace is not stopped.
- **Sampling exposure:** the limit is applied live first, so sampling runs under it.
- **`/readyz`** at `v0.124.1` returns `{ready, opencode}`. It is 200 only when `opencode` is `ready` and 503 otherwise. It is bound to `0.0.0.0:9100` and needs no auth.
- **PID 1 is tini.** When the Node child dies, tini exits and `restart: unless-stopped` restarts the container. Status shows the new `StartedAt`, `RestartCount` and `OOMKilled`.

### Deferred to Implementation

- The exact `docker inspect` format string and the section delimiters in the status SSH call.
- Whether the merge-fixture integration test can assert limits without Docker present. A Docker-free assertion on the `buildComposeOverride` output is required either way.

## Implementation Units

- [ ] **Unit 1: Limit constant and override**

**Goal:** Every deploy renders `mem_limit` and `memswap_limit` on `workspace` from one constant.

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**

- Modify: `apps/gateway/src/deploy.ts`
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**

- Export the constant beside `COMPOSE_WAIT_TIMEOUT_SECONDS`. Its doc comment states the MiB arithmetic and carries no version numbers.
- Add both keys to the workspace block of `buildComposeOverride`.

**Execution note:** Write the tests first.

**Patterns to follow:** `COMPOSE_WAIT_TIMEOUT_SECONDS`; the existing `buildComposeOverride` suites.

**Test scenarios:**

- Happy path: the workspace block contains both keys, equal to the constant.
- Edge case: no other service block contains either key, in every announce/operator/VPC combination the existing suites enumerate.
- Integration: the merge fixture gains a `workspace` stub, and the merged config carries both limits on it. This sits alongside the Docker-free assertion.

**Verification:** Removing either key, or using a different value in the override, fails a test.

- [ ] **Unit 2: Post-up running-limit readback**

**Goal:** After `up`, the deploy proves the running workspace carries the configured limits, or fails.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**

- Modify: `apps/gateway/src/deploy.ts`
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**

- Add a phase after Phase 9c and before the checksum write, following the readback decision.
- Add a default responder in `makeSpawnMock` so existing `main()` tests see matching limits.

**Patterns to follow:** Phase 9c and `assertRunningImageDigest`: Expected/Actual errors and a redacted host.

**Test scenarios:**

- Happy path: both values equal the constant in bytes. The deploy proceeds and logs the success line.
- Error path: either value is `0`, `-1`, empty, non-numeric or different. The deploy throws with the expected and actual values.
- Error path: zero or two container IDs. The deploy throws.
- Integration: a readback failure leaves the previous secrets checksum unwritten.

**Verification:** Every new branch has a test, and the full gateway suite passes.

- [ ] **Unit 3: Workspace memory and supervisor state in `gateway status`**

**Goal:** `gateway status`, `status --json` and the MCP tools show the workspace limit, usage, kill evidence and supervisor state, and the probe can never hide compose output.

**Requirements:** R7

**Dependencies:** None (runs in parallel with Units 1–2)

**Files:**

- Modify: `packages/cli/src/commands/gateway/status.ts`
- Test: `packages/cli/src/commands/gateway/status.test.ts`
- Modify: `packages/cli/src/commands/status.test.ts` (unified summary strings)
- Create: `.changeset/<name>.md` (patch, CLI)

**Approach:**

- Add the extra SSH call described in the status decision. It keeps the explicit SSH identity and the host validation, and the limit value it compares against is a CLI-local constant that equals the deploy constant.
- Human output gains a workspace memory section.
- The unified summary gains the tagged suffix.
- Exit codes are unchanged.

**Patterns to follow:**

- `getGatewayComposeStatus` host validation and error redaction.
- `createCapturedCtx` / `expectCapturedToInclude`.
- Per-command spawn responders in place of `makeSpawnOk`.

**Test scenarios:**

- Happy path: realistic delimited stdout parses to the limit, usage, `max`, `oom_kill`, restart evidence and `opencode=ready`. Status is OK and exits 0.
- Happy path: non-zero `oom_kill` with `ready` is shown, and status stays OK.
- Edge case: `starting`, `degraded` and `down` each come from a 503 JSON body, are shown, and leave the exit code unchanged.
- Edge case: usage within 64 MiB of the limit skips the `/readyz` probe and shows `opencode=unknown`.
- Edge case: a container with no limit shows `limit=none`.
- Error path: a timeout, an SSH failure on the extra call, a missing section or unparsable JSON each give `unknown` for the probe block. Compose rows still render, and the summary keeps its prefix.
- Edge case: the unified summary contains no `|`.

**Verification:** The CLI tests pass, `conventions.test.ts` passes unchanged, and a changeset is present.

- [ ] **Unit 4: Gateway docs**

**Goal:** An operator can find the limit, see that it was hit, and recover.

**Requirements:** R10

**Dependencies:** Units 1–3

**Files:**

- Modify: `apps/gateway/AGENTS.md`
- Modify: `AGENTS.md` (the `gateway status` row, only if its description changes)

**Approach:**

- **Deploy flow:** state the limit and the floor reasoning, and the readback. Warn that the first deploy with the limit recreates every gateway service and interrupts in-flight runs.
- **Day-2 operations:**
  - Read the workspace section of `gateway status`.
  - Recover a `degraded` workspace with `docker compose restart workspace`.
  - Check a checkout left dirty by a kill read-only with `git status --porcelain`, and remove files only with approval.
  - Cancel an interrupted run by hand until the upstream fix ships.
- **Anti-patterns:** never raise the limit without re-measuring the host floor, and never drop `memswap_limit`.

**Test expectation:** none. This unit is docs only, and lint and prettier cover formatting.

**Verification:** Each recovery path named in the origin doc's R10 has a matching instruction.

## System-Wide Impact

- **Interaction graph:** the gateway deploy (`up`, then the readback) and the gateway status CLI. The CLI feeds unified `status` and the MCP tools.
- **Error propagation:** a readback failure aborts the deploy before the checksum write. A status probe failure degrades to `unknown` and never masks compose state.
- **State lifecycle risks:** the first deploy recreates every gateway service and interrupts runs, while checkouts persist. Later recreates reset the cgroup counters, and status labels the counts accordingly.
- **API surface parity:** `status --json` keeps its shape. Only the gateway `http` string gains a suffix. Exit codes are unchanged.
- **Unchanged invariants:** off-droplet image builds, digest pins, trusted proxies, DOCKER-USER rules, and the operator topology.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| The limit kills a legitimate heavy run | Pre-merge sampling under the live limit with a numeric pass rule. The kill count shows recurrences, and the 2026-05-17 resize triggers apply |
| The 770 MiB figure for the other services is an estimate | Sampling records host available memory with the workspace near its limit |
| A status probe hangs or pushes the workspace into OOM | One bounded timeout, and the `/readyz` probe is skipped near the limit |
| A kill mid-git-operation leaves a dirty checkout | The documented read-only check and operator-approved cleanup |

## Documentation / Operational Notes

**Before merge, in order:**

1. **Pre-checks.** Check the cgroup setup once inside the workspace container. `/proc/self/cgroup` should show the root path `0::/`, and `/sys/fs/cgroup/memory.events` should be readable.
2. **Apply the limit live.** With per-action approval, run `docker update --memory 896m --memory-swap 896m` on the workspace container, then read back `memory.max`.
3. **Sample.** A read-only lane records a fresh idle baseline. It then samples the workspace cgroup's `memory.current` and the host's `MemAvailable` every few seconds while the operator runs three launches: the first launch after a workspace restart, a typical repo, and a large repo.
4. **Pass rule.** The workspace peak must be at most 80% of the limit, and host available memory must stay at or above 256 MiB. If either fails, merge is blocked. Then raise the limit only within the floor, or flag a resize review against the 2026-05-17 triggers.
5. **Record.** Put the peak, the floor minimum and the baseline in the PR body.

**After merge:** the router holds the gateway deploy at the `gateway` gate. After approval, check the readback success line and the workspace section of `gateway status`.

**Upstream issues:**

- **fro-bot/agent:** a bounded terminal state for runs whose workspace OpenCode died or restarted, citing the #1652 timeline.
- **fro-bot/agent:** long-lived `opencode serve` growth, citing anomalyco/opencode#47727 and the systematic double-plugin hypothesis, and asking for idle or drained recycling in the supervisor.

Check for duplicates first. Each issue needs per-action approval, and #1652 should link them.

**Release:** the CLI change ships in the next `@marcusrbrown/infra` release through the changeset.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-10-23-gateway-workspace-memory-cap-requirements.md`
- Related issue: #1652
- Upstream:
  - fro-bot/agent `v0.124.1`: `apps/workspace-agent/src/main.ts`, `apps/workspace-agent/src/opencode-server.ts`, `deploy/compose.yaml`, `deploy/workspace.Dockerfile`
  - anomalyco/opencode#47727
