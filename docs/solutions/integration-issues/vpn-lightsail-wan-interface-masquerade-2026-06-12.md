---
title: WireGuard split-tunnel blackholes when NAT masquerade hardcodes the wrong WAN interface
date: 2026-06-12
category: docs/solutions/integration-issues
module: apps/vpn
problem_type: integration_issue
component: tooling
symptoms:
  - 'WireGuard handshake succeeded but all tunnel traffic timed out (curl exit 28)'
  - 'transfer counters were lopsided: ~6KB sent into the tunnel, ~376B returned'
  - 'ping to the server tunnel IP 10.8.0.1 had 100% packet loss'
  - 'tcpdump on the box wg0 showed client SYNs arriving with retransmits but no SYN-ACK'
  - 'the box could curl the destination itself, but forwarded client packets got no reply'
root_cause: config_error
resolution_type: code_fix
severity: high
related_components:
  - apps/vpn
  - packages/cli/src/commands/vpn/peers.ts
tags:
  - vpn
  - wireguard
  - lightsail
  - masquerade
  - nat
  - wan-interface
  - split-tunnel
---

# WireGuard split-tunnel blackholes when NAT masquerade hardcodes the wrong WAN interface

## Problem

The WireGuard egress box (AWS Lightsail eu-west-1, `wg-egress`) deployed cleanly and a split-tunnel client peer registered with a fresh handshake, but every request routed through the tunnel timed out. The box could reach the destination directly; only forwarded client traffic blackholed.

## Symptoms

- `curl https://<target-host>` through the tunnel timed out with `exit 28`
- Lopsided WireGuard transfer: ~6 KB sent into the tunnel, ~376 B returned
- `ping 10.8.0.1` (server's own tunnel IP) had 100% packet loss
- `tcpdump -i wg0` on the box showed client SYNs **arriving** and retransmitting, with no SYN-ACK and no ICMP replies
- `curl https://<target-host>` **from the box itself** returned HTTP 200 in ~60ms — box egress was healthy

## What Didn't Work

- **MTU blackhole theory.** `wg0` on the box inherited the AWS jumbo `mtu 8921`, which looked like a classic WireGuard MTU blackhole. Setting it to 1420 live changed nothing — and crucially, even tiny ICMP packets failed, which rules MTU out (MTU issues let small packets through and drop large ones).
- **Trusting the surface-correct NAT config.** `ip_forward=1`, FORWARD ACCEPT rules both directions, and a MASQUERADE rule were all present. The config *looked* right. The trap was that the MASQUERADE rule hardcoded `-o eth0`, which matched no traffic on this box.

## Solution

The server `wg0.conf` renderer (`renderServerConfig` in `packages/cli/src/commands/vpn/peers.ts`) defaulted its `wanInterface` to `eth0`, and the deploy script (`apps/vpn/src/deploy.ts`) passed `eth0` explicitly. The Lightsail box's actual WAN interface is `ens5`.

Deploy now detects the WAN interface on the box and threads it into the renderer:

```ts
// Before — hardcoded:
const wanInterface = 'eth0'

// After — detected at deploy time, fail-closed:
const route = await sshCapture(host, 'ip route show default')
const match = route.match(/\bdev\s+(\S+)/)
if (!match) throw new Error('No default route with a dev interface found on the box')
const wanInterface = match[1] // e.g. "ens5"
```

The rendered `PostUp`/`PostDown` then masquerade on the detected interface:

```
PostUp = ...; iptables -t nat -A POSTROUTING -o ens5 -j MASQUERADE
PostDown = ...; iptables -t nat -D POSTROUTING -o ens5 -j MASQUERADE
```

Verified live: the split-tunnel target hosts return HTTP 200 through the tunnel, while non-listed hosts keep the client's real IP (split-tunnel intact). The rule is baked into the deployed `wg0.conf`, so it survives reboots and `wg-quick` cycles.

## Why This Works

`iptables ... -j MASQUERADE -o <iface>` only rewrites the source address of packets **egressing the named interface**. When the name is wrong, the rule matches nothing: forwarded client packets leave the box still carrying their private tunnel source (`10.8.0.2`), so the destination's reply is addressed to an unroutable private IP and never comes back. The tunnel looks alive (handshake fine, packets counted inbound) while every forwarded flow blackholes.

The diagnostic that nails this class of bug: **the box can reach the destination itself, but forwarded traffic can't.** That asymmetry isolates the problem to NAT/forwarding rather than egress, routing, or MTU. `ip route show default` then reveals the real WAN interface name.

## Prevention

- **Never hardcode WAN interface names.** Cloud images vary — `eth0` (older), `ens5` (AWS Nitro/Lightsail), `enp0s5`, etc. Detect at deploy/render time from `ip route show default` and fail closed if no default route is found.
- **One-way tunnel diagnostic checklist:** healthy handshake + lopsided transfer (out >> back) + box-can-reach-but-forwarded-can't ⇒ NAT interface/rule mismatch, not MTU or routing. Confirm with `tcpdump -i wg0` (SYN in, no SYN-ACK) and `ip route show default`.
- **Don't let a jumbo MTU red-herring you.** If small packets (ICMP) also fail, it isn't MTU.
- Tests cover both the `ens5` override and the `eth0` default in `packages/cli/src/commands/vpn/peers.test.ts`, and `apps/vpn/src/deploy.test.ts` asserts the deployed config uses the detected interface.

## Related Issues

- PR #498 — `fix(vpn): detect WAN interface at deploy time instead of hardcoding eth0` (merged `5ae06ce`)
- `docs/solutions/workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md` — precedent: the first-provision/deploy cascade for this same box (distinct failure mode; provider-contract mismatches rather than WAN-interface NAT)
