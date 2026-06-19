---
title: Provider firewall management belongs in provisioning, not the deploy hot path
date: 2026-06-19
category: docs/solutions/workflow-issues/
module: gateway
problem_type: architecture_pattern
component: tooling
severity: high
related_components:
  - development_workflow
applies_when:
  - "A gateway/app deploy needs to manage a cloud-provider resource (firewall, DNS, static IP)"
  - "The account has no existing DO Cloud Firewall to reconcile (droplets use on-host UFW)"
  - "A deploy-time provider API call can fail closed and block releases"
  - "Deciding whether logic belongs in the per-deploy path or in provisioning"
tags:
  - gateway
  - digitalocean
  - firewall
  - provisioning
  - deploy
  - doctl
  - operator-access
---

# Provider firewall management belongs in provisioning, not the deploy hot path

## Context

Shipping the gateway operator same-origin private path added a DigitalOcean Cloud Firewall "reconcile" step to the per-deploy hot path (`apps/gateway/src/deploy.ts`). The reconcile was designed to additively update the gateway droplet's *existing* firewall (to avoid the default-deny lockout a fresh allowlist firewall would cause).

It failed in production four consecutive times, each failure exposing a different one-time-setup assumption that does not hold on a repeated path:

1. `Executable not found in $PATH: "doctl"` — the GitHub Actions runner never installed `doctl`. Provisioning runs `doctl` locally on the operator machine, so no deploy workflow had ever needed it.
2. `Error: Droplet with the name "gateway.fro.bot" could not be found` — the code resolved the gateway droplet ID by passing `GATEWAY_HOST` (the FQDN) to `doctl compute droplet get`, which expects the droplet **name** (`gateway`).
3. **Root cause:** `No existing firewall found attached to the gateway droplet` — `doctl compute firewall list` returned **zero** DO Cloud Firewalls in the entire account. Every droplet uses on-host UFW. A reconcile of an *existing* firewall can never succeed because none exists.
4. Separately, the dashboard deploy had been coupled with `needs: deploy-gateway` to avoid a route-before-bridge race, which let a failing gateway deploy block the unrelated dashboard deploy.

## Guidance

Put provider-level resource **management** in provisioning, not in the per-deploy path.

| Concern | Home | Why |
| --- | --- | --- |
| Cloud firewall, DNS records, static IPs | **Provisioning** | Created once, reboot-durable, run locally with the provider CLI; should not be re-evaluated on every release |
| `DOCKER-USER` iptables rule, VPC-IP publish, runtime checks | **Deploy** | Must reapply every run because Docker/the host rewrites this state on each `compose up` |

The deciding question is lifecycle, not convenience: **does this need to happen once (provisioning) or every deploy (deploy)?** Docker wipes the `DOCKER-USER` chain on every `compose up`, so that rule genuinely belongs in the deploy. A cloud firewall persists across reboots and deploys, so it belongs in provisioning.

**DO Cloud Firewalls are allowlist / default-deny.** A new firewall created without base inbound rules locks out SSH and breaks the box. Provisioning creates it once with the mandatory base rules:

```bash
doctl compute firewall create \
  --name gateway-operator-fw \
  --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0 protocol:tcp,ports:22,address:::/0 \
protocol:tcp,ports:80,address:0.0.0.0/0 protocol:tcp,ports:80,address:::/0 \
protocol:tcp,ports:443,address:0.0.0.0/0 protocol:tcp,ports:443,address:::/0 \
protocol:tcp,ports:9300,droplet_id:<dashboard-id>" \
  --outbound-rules "<icmp/tcp/udp all, v4+v6>" \
  --droplet-ids <gateway-id>
```

Make it idempotent: create-if-absent, add the operator rule if missing (per-rule parse — a single rule must contain both `ports:9300` exact and `droplet_id:<dashboard-id>`), no-op if present. Gate it on the feature's config being set, and warn-and-skip (never hard-fail provisioning) when a prerequisite is missing (e.g. the dashboard droplet does not exist yet).

The provider CLI credential follows the work: `DIGITALOCEAN_ACCESS_TOKEN` is a provisioning-time / repo-level concern, not a per-app deploy-environment secret.

Finally: **do not couple independent app deploys.** A `needs: deploy-gateway` on the dashboard deploy makes one app's failure block another app's rollout. Prefer an advisory cross-service health check (warn, never throw) over a hard dependency.

## Why This Matters

Every layer added to the per-deploy hot path is a per-deploy failure surface. Here, four separate environment assumptions broke — `doctl` present, droplet resolvable by FQDN, a firewall already exists, provider state safe to reconcile mid-deploy — all because one-time setup was forced into a repeated path. Provisioning concerns gated release velocity for no benefit: the firewall only needs to exist, not be re-derived on every deploy.

The same reasoning applies to deploy coupling: making the dashboard deploy depend on the gateway deploy turned a transient, self-resolving condition (the operator route 502s until the gateway bridge is up) into a hard release blocker on an unrelated service.

## When to Apply

- Adding any cloud-provider resource management (firewall, DNS, static IP) to a gateway/app deploy — put it in provisioning instead.
- Deciding whether a step belongs in deploy or provisioning — ask "once, or every deploy?"
- Considering a cross-service deploy dependency — prefer an advisory check over `needs:`.

## Examples

**Before — firewall reconcile in the deploy (fails closed):**

```ts
// apps/gateway/src/deploy.ts — per-deploy hot path
await reconcileDigitalOceanFirewall() // needs doctl, an existing firewall, the right droplet name…
```

**After — firewall created once in provisioning; deploy keeps only runtime state:**

```ts
// apps/gateway/server/provision-droplet.ts — runs once, locally
await setupOperatorFirewall() // create-if-absent, base 22/80/443 + 9300-from-dashboard, idempotent

// apps/gateway/src/deploy.ts — per-deploy, no doctl
await publishOperatorPortOnVpcIp()     // ${GATEWAY_VPC_IP}:9300:9300
await applyAndVerifyDockerUserRule()   // Docker rewrites DOCKER-USER on every compose up
await verifyPublicPortDenied()         // TCP probe: public :9300 must be unreachable
```

**Before — dashboard deploy hard-depends on gateway:**

```yaml
deploy-dashboard:
  needs: [detect-changes, deploy-gateway]
  if: >-
    !cancelled() && needs.deploy-gateway.result != 'failure' &&
    (github.event_name == 'workflow_dispatch' || needs.detect-changes.outputs.dashboard == 'true')
```

**After — independent deploy, advisory cross-service check:**

```yaml
deploy-dashboard:
  needs: detect-changes
  if: >-
    github.event_name == 'workflow_dispatch' || needs.detect-changes.outputs.dashboard == 'true'
```

```ts
// dashboard deploy: same-origin /operator/health is advisory — warn, never throw
```

## Related

- `docs/solutions/workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md` — strongest precedent: provider-specific setup belongs in provisioning, and the first real provision/deploy of a new cloud path is a live contract test.
- `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` — same shape: a deploy fails because an assumption about the contract is wrong; verify the actual source of truth.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — the gateway first-deploy cascade family; first real deploy exposes hidden contract drift.
- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — same gateway deploy path, different failure (image freshness).
- `docs/solutions/integration-issues/docker-network-stale-subnet-cleanup-2026-06-18.md` — adjacent operator VPC bridge topology and deploy-time network assumptions.
