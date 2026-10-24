---
date: 2026-10-23
topic: gateway-workspace-memory-cap
---

# Gateway Workspace Memory Cap

## Summary

The gateway deploy gives the `workspace` container a hard memory limit, so a growing OpenCode process is killed inside its own container while the gateway, mitmproxy and Caddy keep answering. Every deploy checks the limit is in effect, and `gateway status` shows when it was hit. Two upstream issues cover the parts infra cannot fix.

---

## Problem Frame

The gateway droplet has 2 GB of RAM, no swap, and no container memory limits. On 2026-10-23 a single `Reply with only the word OK.` launch on `marcusrbrown/systematic` coincided with the workspace's long-lived `opencode serve` holding about 1.1 GiB after 2.7 days of uptime. Host memory fell to 5 MB available. `/operator/health` timed out for about 12 minutes until `docker compose restart workspace` freed the memory (#1652).

The host stalled rather than killing anything: no OOM kill was logged. Every service shares one memory pool, so one container's growth takes the operator surface down with it.

Two gaps stay open after recovery. The run that triggered the incident stayed `running` until it was cancelled by hand, because the gateway never reconciles a run whose workspace died. Why OpenCode grew is unconfirmed. An open upstream report (anomalyco/opencode#47727) describes `opencode serve` keeping one instance per directory it has served without releasing them, which fits a long-lived process that serves several repos. Loading the repo's own plugin next to the baked-in Systematic plugin is another hypothesis.

---

## Requirements

**Containment**

- R1. The gateway deploy sets a hard memory limit on the `workspace` container and on no other gateway service.
- R2. The swap limit is set now and equals the memory limit, so the workspace gets no swap even if swap is added to the droplet later.
- R3. The limit is sized for the whole workspace container: OpenCode, the Node supervisor (about 88 MB) and git child processes. It must fit a measured run peak, not only a steady-state reading.
- R4. With the workspace at its limit, the host keeps a stated floor of available memory for the gateway, mitmproxy, Caddy, Docker and the OS. Those use about 770 MB today, and the incident stalled at 5 MB available.

**Verification**

- R5. A regression test fails if the workspace memory or swap limit disappears from the deploy's compose configuration.
- R6. Every deploy reads back the running workspace container's memory and swap limits and fails if either is missing or differs from the configured value.

**Visibility**

- R7. `gateway status` shows how many times the kernel has killed a process at the workspace limit, read from the workspace cgroup's OOM-kill counter, so `status --json` and the MCP tools show it too. The daily report runs no status command and stays as it is. It also shows the supervisor's `degraded` state, which only covers rapid crash loops: the supervisor's retry budget resets after 60 seconds of uptime, so a slow leak never reaches `degraded`.

**Upstream and docs**

- R8. A fro-bot/agent issue asks for runs to reach a terminal state within a bounded time when the workspace's OpenCode dies or the workspace restarts.
- R9. A fro-bot/agent issue reports the long-lived `opencode serve` memory growth. It cites anomalyco/opencode#47727, includes the systematic-plugin hypothesis, and asks for idle recycling.
- R10. `apps/gateway/AGENTS.md` documents the limit, how to tell it was hit, how to recover a `degraded` workspace or a checkout left dirty by a kill, and that a run interrupted by an OOM kill must be cancelled by hand until R8 ships.

---

## Acceptance Examples

- AE1. **Covers R1, R4, R7.** Given the limit is deployed, when the workspace grows to its limit, the kernel kills a process in the workspace only and the kill count in `gateway status` goes up. The gateway, mitmproxy and Caddy keep their uptime, and `/operator/health` keeps answering.
- AE2. **Covers R6.** Given the deploy's compose configuration sets the limit, when the running workspace reports no limit or a different one, the deploy fails and names the expected and actual values.
- AE3. **Covers R7, R10.** Given OpenCode was killed at the limit and respawned, when the operator checks `gateway status`, the kill count has gone up even though the workspace is not `degraded`. If repeated kills within a minute have marked it `degraded`, the documented recovery restores launches.

---

## Success Criteria

- A future growth event like #1652 kills OpenCode inside the workspace instead of stalling the host, and `/operator/health` stays up.
- A run on a typical repo completes under the limit; the limit does not fire during normal use.
- `ce:plan` can pick the limit value, the host floor, the readback and the status signal from this doc without inventing behaviour.

---

## Scope Boundaries

- Resizing the droplet. The resize triggers in `docs/brainstorms/2026-05-17-gateway-deployment-requirements.md` still apply, and repeated kills in `gateway status` are one input to that review.
- A deliberate breach test on production. The deploy readback proves the limit is in place, and the first real kill is observed through the kill count.
- Adding swap to the droplet. It softens spikes but does not isolate one container from another.
- OOM-score priority or memory reservations for the other services. They do not prevent the stall that happened.
- Scheduled or idle OpenCode recycling run from infra. Recycling belongs in the upstream supervisor (R9).
- Reproducing the systematic-plugin growth on a disposable stack. The hypothesis goes into the upstream issue.
- Reconciling or failing stuck runs from infra. That belongs in the upstream gateway (R8).

---

## Key Decisions

- Limit the workspace, not the host: the workspace is the only service that grows with agent work, and an OOM kill there is survivable. The supervisor makes up to four launch attempts (the first launch plus three respawns), and its retry budget resets once OpenCode has been up 60 seconds.
- Stay on the 2 GB droplet: the limit costs nothing, and a resize can follow if a legitimate run needs more.
- Count kills from the cgroup, not the supervisor: the supervisor logs a kill as an exit with no code, the same as any other signal, and its `degraded` state misses slow leaks.

---

## Dependencies / Assumptions

- Upstream fro-bot/agent at the pinned tag sets no memory limits in its compose file or images, and its supervisor marks OpenCode `degraded` after exhausting retries rather than exiting the container.
- The droplet uses cgroup v2 with the systemd driver, so a container memory limit is enforced by the kernel.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3, R4][Needs research] The limit value and the host floor, from a measured peak during a run (the first launch after a restart, on a typical and a large repo) and a fresh host baseline.
- [Affects R7][Technical] How `gateway status` reads the workspace cgroup's OOM-kill counter and the supervisor's state over SSH.

---

## Sources / Research

- #1652 and Fro Bot's triage comment on it.
- `apps/gateway/src/deploy.ts` `buildComposeOverride`: emits no memory settings for any service today.
- `apps/gateway/server/provision-droplet.ts`: `s-1vcpu-2gb`, no swap setup.
- `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`: the earlier memory outage on this droplet, caused by on-droplet builds.
- `docs/brainstorms/2026-05-17-gateway-deployment-requirements.md`: the resize triggers (gateway memory headroom under 25%).
- fro-bot/agent `apps/workspace-agent/src/opencode-server.ts` at the pinned tag: supervisor respawn budget and `degraded` state.
- anomalyco/opencode#47727: `opencode serve` per-directory instance growth.
