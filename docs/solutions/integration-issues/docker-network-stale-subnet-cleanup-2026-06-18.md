---
title: Docker network stale-subnet cleanup for explicit-IPAM compose networks
date: 2026-06-18
category: docs/solutions/integration-issues
module: apps/gateway
problem_type: integration_issue
component: tooling
symptoms:
  - 'docker compose up fails with an IPAM pool overlap after changing a Docker network subnet'
  - 'docker network rm fails with active endpoints because stopped containers still own network attachments'
  - 'docker compose rm can fail with no such service when an orphan container is attached but absent from the current compose config'
root_cause: config_error
resolution_type: code_fix
severity: high
related_components:
  - apps/gateway
  - apps/dashboard
tags: [gateway, docker-network, ipam, compose, caddy, deploy, operator, topology]
---

# Docker network stale-subnet cleanup for explicit-IPAM compose networks

## Problem

The Gateway operator listener rollout moved `fro-bot_gateway-net` to an explicit `172.21.0.0/16` subnet so the listener could bind to a deterministic `172.21.0.2` gateway-net address. A failed earlier operator deploy had already created `fro-bot_gateway-net` with a stale subnet, so the next `docker compose up` could validate the desired compose config but still fail against live Docker network state.

Docker Compose treats IPAM changes as desired config. Docker treats an already-created network's subnet as live immutable state. Updating YAML does not mutate the existing network.

## Symptoms

- `docker compose up` fails while creating or reconciling `fro-bot_gateway-net`, with Docker reporting an IPAM pool overlap or refusing the static address assignment.
- `docker network inspect fro-bot_gateway-net` shows a subnet different from the deploy's expected subnet (`172.21.0.0/16`).
- `docker network rm fro-bot_gateway-net` fails with `active endpoints: network fro-bot_gateway-net id ... has active endpoints` when `fro-bot-gateway-1` or `fro-bot-caddy-1` is still attached.
- `docker compose stop gateway caddy` can leave the endpoints in place because Docker network endpoints are tied to container lifetime/attachment, not run state. The container is stopped but still holds the network attachment.
- `docker compose rm ... caddy` can fail with `no such service: caddy` when Caddy is an orphan from a previous announce/operator deployment but is absent from the current compose config.

## What Didn't Work

- **Trusting `docker compose config` alone.** It validates the rendered desired stack, not the subnet of an existing Docker network on the droplet.
- **Relying on Compose to recreate the network.** Compose does not safely mutate an existing network's IPAM subnet in place.
- **Stopping containers before removing the network.** Stopped containers can still hold network endpoints.
- **Using compose-scoped container removal for optional services.** `docker compose rm -f -s gateway caddy` depends on `caddy` being declared in the current compose config. When Caddy is disabled but an old container remains attached, compose-scoped removal misses the exact orphan that blocks network deletion.
- **Disrupting containers before image pull.** If cleanup removes containers and then the image pull fails, the deploy strands the live stack before it has the artifacts needed to recover.

## Solution

Treat explicit-IPAM network migration as a live-state migration step, sequenced after image pull and before compose up.

The deploy now runs this shape:

1. Pull images first with `docker compose --project-directory /opt/gateway/deploy pull`.
2. Inspect the live `fro-bot_gateway-net` network.
3. Skip cleanup when the network is missing or already has `172.21.0.0/16`.
4. Remove the stale network directly with `docker network rm fro-bot_gateway-net`.
5. If Docker reports `active endpoints`, remove the endpoint-owning containers by known static names:
   - `docker rm -f fro-bot-gateway-1`
   - `docker rm -f fro-bot-caddy-1`
6. Treat `No such container` as already released; fail closed on any other container-removal error.
7. Retry `docker network rm fro-bot_gateway-net`. A second failure here is fatal — the deploy fails closed rather than proceeding into a partly migrated topology.
8. Only then run `docker compose up -d --no-build --wait --wait-timeout 120 --remove-orphans` so Compose recreates the network with the expected subnet.

The implementation lives in `apps/gateway/src/deploy.ts` as `removeStaleGatewayNet()`. It runs on every Gateway deploy, not only operator deploys, because stale network state can block any later compose reconciliation.

```ts
await runCommand(
  'Pulling prebuilt images from GHCR',
  sshCommand(host, `docker compose --project-directory ${DEPLOY_DIR} pull`, keyPath, controlPath),
  deployEnv,
  spawnFn,
)

await removeStaleGatewayNet(host, deployEnv, spawnFn, keyPath, controlPath)

await runCommand(
  'Starting Docker Compose stack',
  sshCommand(host, `docker compose --project-directory ${DEPLOY_DIR} up -d --no-build --wait --wait-timeout 120 --remove-orphans`, keyPath, controlPath),
  deployEnv,
  spawnFn,
)
```

The cleanup uses direct Docker container names instead of compose service names because `fro-bot-caddy-1` may be an orphan from an earlier topology where Caddy was enabled:

```ts
for (const containerName of [GATEWAY_CONTAINER_NAME, CADDY_CONTAINER_NAME]) {
  const rmProc = spawnFn(sshCommand(host, `docker rm -f ${containerName}`, keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const rmContainerStderr = await new Response(rmProc.stderr).text()
  const rmContainerExitCode = await rmProc.exited
  if (rmContainerExitCode !== 0 && !rmContainerStderr.includes('No such container')) {
    throw new Error(
      `Failed to remove container ${containerName} to release ${GATEWAY_NET_FULL_NAME} endpoints`,
    )
  }
}
```

## Why This Works

Docker network subnets are not ordinary compose-service settings. Once Docker creates a named network, its IPAM config is part of live daemon state. A later compose override that declares a different subnet tells Compose what should exist, but Docker cannot reconcile that with an already-created network that has endpoint attachments.

Pulling images before cleanup keeps the recovery path safe: a missing image fails before any live container is removed. Removing only `fro-bot-gateway-1` and `fro-bot-caddy-1` releases the endpoints that can attach to `gateway-net` without touching persistent named volumes like `workspace-repos`, `mitmproxy-certs`, or Caddy storage. Running compose up afterward recreates the removed containers and the network with the explicit `172.21.0.0/16` subnet.

The deploy fails closed between each step. If endpoint release or the second network removal fails, the error states whether gateway/caddy containers were removed and tells the operator to rerun deploy or bring the services back with compose up. It does not proceed into a partly migrated topology.

## Prevention

- **Pin explicit IPAM for any network that supplies a stable listener bind address.** The Gateway operator listener uses `172.21.0.0/16` with `GATEWAY_OPERATOR_BIND_HOST=172.21.0.2`.
- **Validate rendered compose and live Docker state.** `docker compose config` catches bad YAML; `docker network inspect` catches stale daemon state.
- **Pull before disruptive cleanup.** Never remove containers or networks before the images needed to recreate the stack are cached locally.
- **Remove endpoint-owning containers, not stopped services.** `docker compose stop` is not endpoint release. Direct `docker rm -f <known-container>` is the reliable primitive for stale-network cleanup.
- **Avoid compose-scoped removal for optional/orphan services.** Optional services like Caddy can be attached from a previous topology and absent from the current config.
- **Do not use `docker compose down -v` as cleanup.** It destroys named volumes that preserve repo checkouts, Caddy state, and proxy certificates.

## Related Issues

- [marcusrbrown/infra#579](https://github.com/marcusrbrown/infra/issues/579) — Gateway operator listener topology; closed after the deploy and docs reconciliation.
- [PR #589](https://github.com/marcusrbrown/infra/pull/589) — moved `gateway-net` to `172.21.0.0/16` and added stale-network cleanup.
- [PR #592](https://github.com/marcusrbrown/infra/pull/592) — hardened active-endpoint release with direct `docker rm -f fro-bot-gateway-1` / `fro-bot-caddy-1`.
- Deploy run [27740787921](https://github.com/marcusrbrown/infra/actions/runs/27740787921) — verified pull-before-cleanup, active endpoint release, stale network removal, compose up, operator health probe, and digest verification.
- `docs/plans/2026-06-17-001-feat-gateway-operator-listener-topology-plan.md` — completed #579 topology plan.
- `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md` — sibling Caddy lesson: verify route structure with mutually-exclusive `handle` blocks.
- `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md` — sibling deploy invariant: build off-droplet, pull exact images, verify running digests.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — related lesson: first deploy of a new topology is an end-to-end deploy-contract test.
