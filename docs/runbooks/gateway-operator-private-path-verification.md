# Gateway Operator Private Path Verification

The dashboard→gateway operator private path routes `https://dashboard.fro.bot/operator/*` to the
gateway operator listener over the shared DigitalOcean VPC. The bridge consists of four controls:
a VPC-IP-scoped Docker port publish, a DOCKER-USER iptables source restriction, a DigitalOcean
Cloud Firewall rule, and the dashboard Caddy `/operator/*` route. This runbook covers verifying
that all four controls are in place and the path is healthy.

---

## Prerequisites

- The gateway operator listener is enabled: `GATEWAY_OPERATOR_BIND_HOST`, `GATEWAY_OPERATOR_BIND_PORT`,
  and `GATEWAY_OPERATOR_PUBLIC_ORIGIN` are set in the `gateway` GitHub Environment.
- The VPC bridge is enabled: `GATEWAY_VPC_IP`, `DASHBOARD_VPC_IP`, and `DIGITALOCEAN_ACCESS_TOKEN`
  are set in the `gateway` GitHub Environment; `GATEWAY_VPC_IP` is set in the `dashboard` GitHub
  Environment.
- SSH access to the gateway droplet via `GATEWAY_SSH_KEY` from the repo-root `.env`.
- `doctl` authenticated locally (`doctl auth init`).

---

## Positive probes

### Same-origin path (end-to-end)

```sh
curl -sf https://dashboard.fro.bot/operator/health
# expect: 200 {"ok":true}
```

A 200 response confirms the full path is live: dashboard Caddy → VPC → gateway daemon. This is the
primary health signal for the private path.

### Droplet-local listener liveness

SSH to the gateway droplet and probe the daemon directly on the gateway-net address:

```sh
ssh root@gateway.fro.bot \
  'curl -sf http://172.21.0.2:9300/operator/health'
# expect: 200 {"ok":true}
```

A 200 here confirms the operator listener is up on `gateway-net`, independent of the VPC bridge.
If this fails but the same-origin probe succeeds, something is wrong with the daemon — not the bridge.

---

## Negative-control probe

### Public internet must not reach the operator port

```sh
curl -sf --connect-timeout 5 http://gateway.fro.bot:9300/operator/health
# expect: connection refused or timeout (not 200)
```

The gateway's public `eth0` must not accept connections on `:9300`. A successful connection here
means the VPC-IP publish has leaked to the public interface — a security defect requiring immediate
remediation (see [Break-glass](#break-glass) below).

**Caveat:** A true "non-dashboard VPC source denied" packet test requires a VPC peer originating
from a non-dashboard VPC IP. The deploy verifies this structurally via control readback (see below),
not a live foreign-source packet — the runner is not a VPC peer.

---

## Control readback

### DOCKER-USER iptables rule

SSH to the gateway droplet and read the DOCKER-USER chain:

```sh
ssh root@gateway.fro.bot \
  'iptables -nvL DOCKER-USER --line-numbers'
```

Expected output (example IPs; substitute actual `GATEWAY_VPC_IP` and `DASHBOARD_VPC_IP`):

```
Chain DOCKER-USER (1 references)
num   pkts bytes target     prot opt in     out     source               destination
1        0     0 ACCEPT     tcp  --  *      *       10.116.0.5           172.21.0.2           tcp dpt:9300
2        0     0 DROP       tcp  --  *      *       0.0.0.0/0            172.21.0.2           tcp dpt:9300
3        0     0 RETURN     all  --  *      *       0.0.0.0/0            0.0.0.0/0
```

Verify:
- Rule 1: ACCEPT, source = dashboard VPC IP (`10.116.0.5`), destination = gateway-net IP
  (`172.21.0.2`), dport = 9300.
- Rule 2: DROP, source = any, destination = gateway-net IP, dport = 9300.
- Rule 1 appears **before** Rule 2 (ordering is load-bearing).

A wrong-but-present rule (wrong source IP, wrong dport, or wrong ordering) is a defect — presence
alone is not sufficient.

**Note:** The DOCKER-USER rule is reapplied every deploy and is lost on reboot until the next
deploy. The DigitalOcean Cloud Firewall (below) is the reboot-durable provider-level control that
covers the reboot window.

### DigitalOcean Cloud Firewall

Find the gateway droplet's firewall and verify the `:9300` inbound rule:

```sh
# List firewalls attached to the gateway droplet
doctl compute firewall list --format ID,Name,DropletIDs

# Inspect the firewall (substitute <firewall-id>)
doctl compute firewall get <firewall-id>
```

In the `InboundRules` output, verify a rule exists with:
- Protocol: `tcp`
- Ports: `9300`
- Sources: `droplet:<dashboard-droplet-id>` (the dashboard droplet-id, not a private IP)

The rule must be additive — all other inbound rules (`:22`, `:80`, `:443`, announce) must remain
present. A missing `:22` rule would indicate the firewall was replaced rather than additively
reconciled — a critical defect.

### VPC-scoped Docker port publish

SSH to the gateway droplet and confirm the publish is VPC-scoped:

```sh
ssh root@gateway.fro.bot \
  'docker compose --project-directory /opt/gateway/deploy ps'
```

The `gateway` service must show a `<GATEWAY_VPC_IP>:9300->9300` mapping (e.g.
`10.116.0.3:9300->9300`). A `0.0.0.0:9300`, `[::]:9300`, or bare `9300:9300` mapping is a defect.

---

## Failure modes

| Symptom | Likely cause | Remediation |
| ------- | ------------ | ----------- |
| `curl https://dashboard.fro.bot/operator/health` → non-200 | Dashboard Caddy route not live, or gateway bridge not reachable | Check dashboard deploy logs; verify `GATEWAY_VPC_IP` is set in the dashboard env; verify the gateway bridge is live |
| `curl http://172.21.0.2:9300/operator/health` → non-200 | Operator listener not running | Check gateway daemon logs: `bunx @marcusrbrown/infra gateway logs gateway --tail 100` |
| `curl http://gateway.fro.bot:9300` → 200 | VPC publish leaked to public interface | Immediate: redeploy the gateway to restore the VPC-scoped publish; verify the DOCKER-USER rule and DO firewall are in place |
| DOCKER-USER rule missing or wrong | Rule was wiped (reboot or `compose up` without reapply) | Redeploy the gateway — the deploy reapplies the rule after `compose up` |
| DO firewall `:9300` rule missing | Firewall reconcile failed or was manually removed | Redeploy the gateway; verify `DIGITALOCEAN_ACCESS_TOKEN` is set in the gateway env |
| DO firewall `:22` rule missing | Firewall was replaced (not additively reconciled) | **Critical** — restore the existing firewall rules immediately; SSH access may be lost |

---

## Break-glass

If a bad iptables rule or firewall configuration locks out the dashboard from the operator path:

1. **Do not SSH-hammer the gateway droplet** — ufw rate-limits new connections (6 new connections
   per 30 seconds). Use external probes (`curl`, `doctl`) to diagnose.
2. **Power-cycle the gateway droplet** to clear a bad iptables state (the DOCKER-USER rule is
   not persistent across reboots):
   ```sh
   doctl compute droplet-action power-cycle <gateway-droplet-id>
   ```
3. **Redeploy the gateway** — the deploy reapplies the DOCKER-USER rule and reconciles the DO
   firewall after `compose up`:
   ```sh
   bunx @marcusrbrown/infra gateway deploy
   ```
4. **Verify** using the probes above before declaring the path healthy.

If the DO Cloud Firewall is misconfigured and SSH access to the gateway is lost, use the
DigitalOcean console to restore the firewall rules before attempting SSH.

---

## Related

- [`apps/gateway/AGENTS.md`](../../apps/gateway/AGENTS.md) — gateway deploy flow, operator listener,
  VPC bridge topology, and security posture
- [`apps/dashboard/AGENTS.md`](../../apps/dashboard/AGENTS.md) — dashboard Caddy `/operator/*` route
  and `GATEWAY_VPC_IP` env var
- [`docs/plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md`](../plans/2026-06-18-003-feat-dashboard-operator-private-path-plan.md) — implementation plan for the VPC bridge
- [`docs/runbooks/gateway-operator-auth-lifecycle.md`](gateway-operator-auth-lifecycle.md) — operator
  auth setup, rotation, and rollback
