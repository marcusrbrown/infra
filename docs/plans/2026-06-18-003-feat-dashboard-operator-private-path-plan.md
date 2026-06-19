---
title: 'feat: Dashboard operator same-origin — private VPC path to the gateway operator listener'
type: feat
status: active
date: 2026-06-18
origin: docs/brainstorms/2026-06-18-dashboard-operator-private-path-requirements.md
---

# feat: Dashboard operator same-origin — private VPC path

## Overview

Make `https://dashboard.fro.bot/operator/*` the live, private browser path to the gateway operator
listener, over the **existing** DigitalOcean VPC. The gateway operator daemon stays bound to its
`gateway-net` address (`172.21.0.2:9300`); the deploy bridges it onto the gateway's VPC IP with a
firewall-restricted Docker port publish, and the dashboard Caddy proxies `/operator/*` to it. This
realizes the same-origin contract ratified in
`docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` now that its three prerequisites
are met: operator auth shipped (`#580`), the private path already exists (the shared VPC), and this plan
adds the dashboard Caddy route.

## Problem Frame

The operator listener is reachable only on the Docker `gateway-net` (`172.21.0.2:9300`, no host port),
so the dashboard droplet cannot reach it. Both droplets are already on the same DO VPC (`nyc1`, uuid
`d95c26cc-…`; gateway VPC IP `10.116.0.3`, dashboard VPC IP `10.116.0.5`), so the private path exists —
the gap is bridging the container listener onto the gateway's VPC IP securely and adding the dashboard
route. The daemon's forwarded-header guard requires `X-Forwarded-Host == dashboard.fro.bot` + `https`,
so the dashboard Caddy (which IS `dashboard.fro.bot`) is the correct proxy. (see origin:
docs/brainstorms/2026-06-18-dashboard-operator-private-path-requirements.md)

## Requirements Trace

- R1. Publish the operator listener on the gateway VPC IP only (`${GATEWAY_VPC_IP}:9300:9300`, never
  `0.0.0.0`); daemon stays on `172.21.0.2:9300`.
- R2. Load-bearing DOCKER-USER iptables rule restricting `:9300` to the dashboard VPC IP, reapplied
  idempotently every deploy (the daemon header guard is not authz; Docker DNAT bypasses ufw).
- R3. DigitalOcean Cloud Firewall rule (TCP 9300 ← dashboard only), reconciled idempotently by the
  gateway deploy.
- R4. Dashboard Caddy `/operator/*` route → gateway VPC IP, `handle` block before the catch-all,
  `flush_interval -1`, and `Host: dashboard.fro.bot` + `X-Forwarded-Proto: https` header shaping.
- R5. Both VPC IPs are named config (`GATEWAY_VPC_IP`, `DASHBOARD_VPC_IP`), all-or-none with the
  operator listener; not literals in code/Caddyfile.
- R6. Fail-closed verification of what the runner can actually check: same-origin health 200,
  public-internet `:9300` denied, and exact readback of both source-restriction controls (DOCKER-USER +
  DO firewall). A live foreign-VPC-source probe is impossible from the (non-VPC) runner; control
  correctness is proven structurally by readback.
- R7. Docs: rewrite the invariants that currently forbid this; document the bridge; update the
  ratification plan; add a verification runbook entry.

## Scope Boundaries

- The bridge is a host-side Docker port publish + firewall, NOT a daemon rebind (deploy.ts validation
  hard-requires `GATEWAY_OPERATOR_BIND_HOST` ∈ `172.21.x.x`).
- VPC-IP bind + DOCKER-USER + DO firewall is the access control. No mTLS/shared-secret.

### Deferred to Separate Tasks

- mTLS / shared-secret between dashboard and gateway: revisit only if untrusted droplets join the VPC,
  if high-impact mutating operator routes ship before app-level auth, or if firewall drift becomes a
  hard requirement.
- The dashboard UI operator client (browser console): separate `fro-bot/dashboard` app work.
- `iptables-persistent` for reboot-durable host rules: not in this plan — the DOCKER-USER rule is
  reapplied every deploy, and the DO Cloud Firewall (which survives reboot) is the load-bearing
  provider-level control covering the reboot window. This only holds because the DO firewall ALONE fully
  blocks non-dashboard TCP/9300; the firewall is therefore load-bearing, not mere hardening, and no
  deploy step may publish `:9300` before the firewall rule is confirmed present.

## Context & Research

### Relevant Code and Patterns

- `apps/gateway/src/deploy.ts` `buildComposeOverride` (~1066-1277): assembles the override YAML. The
  `caddy` service `ports:` block (~1219-1235) is the mirror for emitting `ports:` on the gateway
  service; `gatewayNetworksSection` (~1211-1217) is the mirror for a gated `portsSection`. Insert
  `${portsSection}` into the gateway service template (~1269).
- `apps/gateway/src/deploy.ts` Phase 5d rendered-config gate (~2285-2318): currently asserts
  `GW_PORTS == "0"` (~2301) — must be updated to allow the VPC-scoped publish and reject
  `0.0.0.0`/`[::]`/bare `9300:9300`.
- `apps/gateway/src/deploy.ts` `buildCaddyfile` (~1296-1347): the gateway operator `handle /operator/*`
  block (~1331-1339) shows the `handle` + `flush_interval -1` style. No `header_up` exists in the repo
  yet — net-new syntax.
- `apps/gateway/src/deploy.ts` operator gating: `getOperatorState` (~286-306), `operatorEnabled`
  derivation (~2181-2187), static gateway-net IP (~1211-1217). New VPC vars gate the same all-or-none
  way via a new `getOperatorVpcState` helper mirroring `getOperatorState`.
- `apps/gateway/src/deploy.ts` SSH helpers: `sshCommand` (~1536-1552, ControlMaster/ControlPersist),
  `runCommand` (~1567-1594), `writeRemoteFile` (~1601-1651). The DOCKER-USER apply uses
  `sshCommand`+`runCommand` with a shell-joined `-C || -I` idempotent rule.
- `apps/dashboard/config/Caddyfile`: STATIC committed file (`reverse_proxy dashboard:3000`), uploaded
  via scp by `apps/dashboard/src/deploy.ts` (~540, 549-554). The `/operator/*` block is added to this
  committed file; the dashboard deploy needs `GATEWAY_VPC_IP` to render the target. Because the file is
  static but the target is config, the dashboard Caddyfile likely moves to a small generated/templated
  form (mirror gateway's `writeRemoteFile`) OR uses a Caddy env placeholder — resolve in Unit 4.
- `apps/cliproxy/docker-compose.yaml` / `apps/umami` Caddy sidecar healthcheck: precedent that the
  Caddy image (`caddy:2.11.3-alpine`) has curl/wget for probes.
- `packages/shared/server/droplet-helpers.ts`: `run`/`runCapture`/`validateDoctl`/`dropletExists`
  (~106-174); mirror `doctl compute droplet create` (provision-droplet.ts ~172-187) for the firewall
  reconcile. Add a `getDropletId(name)` helper (none exists; `dropletExists` returns only boolean).

### Institutional Learnings

- `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md`: Caddy
  compiles directives in fixed order, not source order — a bare catch-all sorts ahead and self-404s a
  matched route. Use mutually-exclusive `handle` blocks; verify with `caddy adapt` (substring tests
  miss it). Directly governs R4.
- `docs/solutions/integration-issues/vpn-lightsail-wan-interface-masquerade-2026-06-12.md`: never
  hardcode interface names in iptables — detect at deploy (`ip route show default` / `ip -4 addr show`);
  fail closed if not found; verify the rule landed (`iptables -nvL DOCKER-USER`). Governs R1/R2 VPC
  interface/IP detection.
- `docs/solutions/workflow-issues/gateway-deploy-resourcing-thrash-2026-06-04.md`: never SSH-hammer a
  thrashing box; use external probes (`curl`, `doctl`, GitHub API); break-glass is
  `doctl compute droplet-action power-cycle <id>`. Governs R6 (external negative-control probe) +
  recovery notes.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`: first deploy of a new
  surface is the first end-to-end contract test; multiplex SSH (`ControlMaster`) to avoid ufw's
  6-new-conn/30s lockout across the multi-call iptables+compose+doctl flow; parse NDJSON correctly
  (`doctl ... list` + `docker compose ps` are shape-sensitive).
- `docs/solutions/integration-issues/ssh-agent-too-many-authentication-failures-2026-06-13.md` +
  `docs/solutions/integration-issues/docker-network-stale-subnet-cleanup-2026-06-18.md`: Bun-native
  `.env` (not shell `source`); preserve the stale-gateway-net cleanup sequence (never
  `docker compose down -v`); pull before disruptive cleanup.
- `docs/solutions/workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md`: touching
  `apps/gateway/src/deploy.ts` triggers the deploy paths-filter (already covers `apps/gateway/**`);
  keep `packages/cli/src/resources/known_hosts` byte-identical to `.github/known_hosts` (no host-key
  change expected here).

### External References

- DOCKER-USER chain semantics: the chain sees traffic after DNAT, so match on the post-DNAT
  destination (`-d 172.21.0.2 --dport 9300`) or conntrack original-dst (`--ctorigdst`/`--ctorigdstport`).
  Resolve the exact expression in Unit 2.

## Key Technical Decisions

- **Design A (Oracle-validated):** VPC-IP-scoped Docker publish + DOCKER-USER source restriction +
  dashboard Caddy proxy. Chosen decisively over a second Caddy-hop on the gateway (which still needs a
  published VPC port and adds an `X-Forwarded-Proto` overwrite footgun). (see origin)
- **Source restriction is the authorization boundary, not the header guard.** The daemon's
  forwarded-header guard is forgeable by anyone who can reach `:9300`; the VPC-IP bind blocks the public
  internet, the DOCKER-USER rule + DO firewall block non-dashboard VPC sources.
- **DOCKER-USER reapplied every deploy; DO firewall reconciled every deploy + survives reboot.** No
  iptables-persistent. The DO firewall is the reboot-durable provider-level control.
- **Detect the gateway VPC interface/IP at deploy; fail closed.** No hardcoded `eth1`/IP (VPN lesson).
- **VPC IPs are named all-or-none config** with the operator listener (`getOperatorVpcState`).

## Open Questions

### Resolved During Planning

- Does a private path need building? No — the shared VPC already exists (verified live).
- Where does the DO firewall live? Reconciled by the gateway deploy (origin decision).
- Persistence of the host rule? Reapply-per-deploy + DO firewall for reboot durability (user decision).

### Resolved During Planning (review decisions)

- Negative-control verification: reframed — the non-VPC runner cannot originate a foreign-VPC-source
  probe, so verify public-denied + same-origin-200 + exact control readback instead (Unit 5).
- DO firewall: additive reconcile of the EXISTING gateway firewall (preserve all ports); verify
  `DIGITALOCEAN_ACCESS_TOKEN` first; source = dashboard droplet-id (Unit 3).
- Dashboard Caddy target: Caddy native env expansion (`{$GATEWAY_VPC_IP}` via a new env var on the
  dashboard caddy service) (Unit 4).
- DOCKER-USER readback: assert the exact rule expression, not mere presence; apply after compose up
  (Unit 2).
- Cross-deploy ordering: documented first-deploy order (gateway bridge first, then dashboard route).

### Deferred to Implementation

- Exact DOCKER-USER rule expression (post-DNAT `-d`/`--dport` vs conntrack `--ctorigdst`) and idempotent
  `-C || -I` ordering — resolve against the live chain during implementation.
- Exact `doctl compute firewall add-rules` invocation + existing-firewall discovery shape — resolve
  against live doctl output (additive-only; never replace existing rules).

## Implementation Units

- [ ] **Unit 1: VPC-IP port publish in the gateway compose override (+ rewrite the no-port guard)**

**Goal:** The gateway service publishes the operator listener on the gateway VPC IP only, gated on the
operator listener being enabled.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (`ComposeOverrideOpts`, `buildComposeOverride`, `getOperatorVpcState`, Phase 5d gate, main() wiring)
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**
- Add `getOperatorVpcState(env)` mirroring `getOperatorState` — all-or-none over `GATEWAY_VPC_IP` +
  `DASHBOARD_VPC_IP`, only meaningful when the operator listener is enabled.
- Add `operatorVpcIp` to `ComposeOverrideOpts`; build a gated `portsSection`
  (`ports: ["${operatorVpcIp}:${operatorBindPort}:${operatorBindPort}"]`) emitted only when
  `operatorEnabled && operatorVpcIp`; insert into the gateway service template.
- Add a VPC-IPv4 format validator (no reusable one exists); reject malformed/`-`-prefixed values.
- Rewrite the Phase 5d rendered-config gate (~2301) and the test guard (~5396-5397) as an
  **allowlist, not a denylist**: reject EVERY published `9300` mapping whose host-bind is not exactly
  `${GATEWAY_VPC_IP}` — explicitly failing `0.0.0.0:9300`, `[::]:9300`, bare `9300:9300`, and any other
  host bind. The only accepted publish is `${GATEWAY_VPC_IP}:9300:9300`. A denylist of known-bad forms
  is insufficient (a future accidental public bind could slip through); the guard must fail-closed on
  anything that is not the exact VPC-scoped publish.

**Execution note:** Load `systematic:test-driven-development`. Write the failing override/guard tests
first (assert VPC-scoped publish present; assert 0.0.0.0/bare publish rejected), then implement.

**Patterns to follow:** Caddy `ports:` block (~1219-1235); `gatewayNetworksSection` (~1211-1217);
`getOperatorState` (~286-306).

**Test scenarios:**
- Happy path: operator enabled + `GATEWAY_VPC_IP=10.116.0.3` → override contains
  `10.116.0.3:9300:9300`; daemon still bound `172.21.0.2`.
- Edge: operator disabled → no `ports:` on gateway service.
- Edge: `getOperatorVpcState` returns invalid when one VPC var set without the other.
- Error path: malformed/`0.0.0.0`/`-`-prefixed `GATEWAY_VPC_IP` → validation throws.
- Guard: rewritten test rejects `0.0.0.0:9300:9300`, `[::]:9300:9300`, bare `9300:9300`; accepts the
  VPC-scoped publish.

**Verification:** Override emits the VPC-scoped publish only when enabled; the no-public-port guard now
enforces VPC-scoping rather than forbidding all publishes; `tsc`/lint/tests pass.

- [ ] **Unit 2: DOCKER-USER source restriction (reapplied every deploy)**

**Goal:** Only the dashboard VPC IP can reach the published operator port; all other sources dropped.

**Requirements:** R2, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (new DOCKER-USER reconcile phase in main(), gated on operator + VPC state)
- Test: `apps/gateway/src/deploy.test.ts`

**Approach:**
- Detect the gateway VPC interface/IP at deploy (`ip route` / `ip -4 addr show` for the `DASHBOARD_VPC_IP`-reachable iface); fail closed if not found (VPN lesson).
- Emit an idempotent DOCKER-USER rule over SSH: allow `--dport 9300` from `${DASHBOARD_VPC_IP}` (match post-DNAT dest or conntrack orig-dst), drop `--dport 9300` from all else; `-C || -I` so reruns are no-ops; insert before terminal RETURN.
- **Apply the rule AFTER `docker compose up`** — Docker recreates DOCKER-USER-adjacent chains on daemon restart / `compose up`, so the reapply must run last to avoid being wiped (adversarial finding).
- **Read back the EXACT rule, not mere presence.** `iptables -nvL DOCKER-USER --line-numbers` and assert the allow rule's source == `${DASHBOARD_VPC_IP}`, dport == 9300, jump, and that it sits before the drop-all rule. A non-empty-but-wrong rule (wrong source/dest/interface) must fail verification — presence alone is insufficient (adversarial finding).
- Multiplex over the existing ControlMaster connection to avoid ufw connection-rate lockout.

**Execution note:** Load `systematic:test-driven-development`. Assert the spawned SSH command body
contains the correct iptables flags (mirror `captureValidateScript` ~7156-7165).

**Patterns to follow:** `sshCommand`/`runCommand` (~1536-1594); VPN masquerade interface-detection
(don't hardcode); `captureValidateScript` test helper.

**Test scenarios:**
- Happy path: operator+VPC enabled → deploy spawns the DOCKER-USER apply with `--dport 9300 -s ${DASHBOARD_VPC_IP}` allow + drop-all-else; idempotent `-C || -I`.
- Edge: operator disabled → no iptables command spawned.
- Error path: VPC interface not detected → deploy fails closed (no partial publish without restriction).
- Integration: the apply runs AFTER `docker compose up` and reads back the chain.
- Verification rigor: readback asserts the EXACT source/dport/jump/ordering; a wrong-but-present rule
  (wrong source IP) → verification fails.

**Verification:** The rule is applied idempotently and exact-readback-confirmed; rerun is a no-op;
disabled state emits nothing; a wrong rule fails verification.

- [ ] **Unit 3: DigitalOcean Cloud Firewall reconcile**

**Goal:** Provider-level rule allows TCP 9300 to the gateway droplet only from the dashboard droplet,
reconciled every deploy.

**Requirements:** R3, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `apps/gateway/src/deploy.ts` (firewall reconcile phase, gated on operator + VPC state)
- Modify: `packages/shared/server/droplet-helpers.ts` (add `getDropletId(name)`)
- Test: `apps/gateway/src/deploy.test.ts`, `packages/shared/server/droplet-helpers.test.ts`

**Approach:**
- Add `getDropletId(name)` to shared helpers (mirror `dropletExists`/`getSshFingerprint` doctl wrapping).
- **Verify `DIGITALOCEAN_ACCESS_TOKEN` is available to the gateway deploy FIRST** — feasibility flagged
  it is not in the listed gateway env secrets and the gateway deploy is otherwise SSH-based. If absent,
  the firewall step fails closed with an actionable error; add the token to the gateway GitHub
  Environment + local `.env` as a prerequisite (operator-prereq).
- **Additive reconcile of the EXISTING firewall — never create/attach a fresh allowlist.** DO Cloud
  Firewalls are default-deny/allowlist; attaching a new firewall that only allows 9300 would lock out
  22/80/443/announce. The deploy finds the gateway droplet's existing firewall and `add-rules` the
  single inbound rule `protocol:tcp,ports:9300,source:droplet:<dashboard-droplet-id>` (idempotent:
  check-then-add). It must NOT remove or replace existing inbound rules. If the droplet has no firewall,
  fail closed with guidance (do not auto-create a restrictive one that drops existing ports).
- **Source = dashboard DROPLET-ID** (stable across rebuild), via `getDropletId('dashboard')` — not the
  private IP (rebuild-reassignable; security-lens finding). `DASHBOARD_VPC_IP` stays the Caddy/DOCKER-USER
  target only.
- Parse `doctl` NDJSON/table output carefully. Gate on `operatorEnabled && operatorVpcState === 'enabled'`.

**Execution note:** Load `systematic:test-driven-development`. Mock the doctl spawns; assert the
reconcile command shape + idempotent no-op on rerun.

**Patterns to follow:** `doctl compute droplet create` (provision-droplet.ts ~172-187); `run`/`runCapture`
(~106-132).

**Test scenarios:**
- Happy path: enabled → reconcile adds the 9300-from-dashboard-droplet-id rule to the EXISTING firewall.
- Edge: rule already present → no-op (idempotent check-then-add).
- Edge: operator disabled → no doctl firewall call.
- Error path: `DIGITALOCEAN_ACCESS_TOKEN` absent → fail closed with actionable error (no partial publish without firewall).
- Error path: dashboard droplet ID not found → fail closed.
- Error path: gateway droplet has no existing firewall → fail closed with guidance (never auto-create a restrictive allowlist that drops 22/80/443).
- Safety: reconcile never removes/replaces existing inbound rules (additive only).

**Verification:** Rule reconciled additively + idempotently against the existing firewall; existing ports
preserved; token absence fails closed; disabled state emits nothing; `getDropletId` covered.

- [ ] **Unit 4: Dashboard Caddy `/operator/*` route**

**Goal:** `dashboard.fro.bot/operator/*` proxies to the gateway VPC IP, satisfying the daemon guard.

**Requirements:** R4, R5

**Dependencies:** Units 1-3 (the target must be reachable + restricted before exposing the route)

**Files:**
- Modify: `apps/dashboard/config/Caddyfile` (add the `/operator/*` handle block using `{$GATEWAY_VPC_IP}`)
- Modify: `apps/dashboard/docker-compose.yaml` (pass `GATEWAY_VPC_IP` env to the caddy service)
- Modify: `apps/dashboard/src/deploy.ts` (read `GATEWAY_VPC_IP`; forward it to the caddy service env)
- Test: `apps/dashboard/src/deploy.test.ts`

**Approach:**
- Add a `handle /operator/*` block BEFORE the `reverse_proxy dashboard:3000` catch-all, with
  `flush_interval -1`, `header_up Host dashboard.fro.bot`, `header_up X-Forwarded-Proto https`,
  targeting `{$GATEWAY_VPC_IP}:9300`.
- **Target injection via Caddy native env expansion:** add `GATEWAY_VPC_IP` as an env var to the
  dashboard `caddy` service in `apps/dashboard/docker-compose.yaml` (it currently receives no env the
  Caddyfile could expand — feasibility finding), and have the committed Caddyfile reference
  `{$GATEWAY_VPC_IP}`. The deploy reads `GATEWAY_VPC_IP` from its env and passes it to the caddy
  service. Keeps the static-committed-Caddyfile pattern (no templated render in deploy.ts).
- **Deploy ordering (cross-workflow):** this dashboard route must go live only AFTER the gateway-side
  publish + DOCKER-USER + firewall (Units 1-3) are live, else the route points at an unreachable or
  unrestricted target (adversarial partial-state finding). Document the first-deploy order: deploy the
  gateway first, verify the bridge, THEN deploy the dashboard route. (No cross-repo gating mechanism is
  added; the order is an operator-documented prerequisite, like the other operator-prereqs.)
- Validate the rendered Caddyfile with `caddy adapt` (mutually-exclusive handle blocks; self-404 lesson)
  against `caddy:2.11.3-alpine`, with `GATEWAY_VPC_IP` set for the expansion.

**Execution note:** Load `systematic:test-driven-development`. Verify `caddy adapt` accepts the rendered
config and the `/operator/*` route resolves ahead of the catch-all.

**Patterns to follow:** gateway `buildCaddyfile` operator block (~1331-1339); the self-404 solution doc;
dashboard Caddyfile scp upload (~540, 549-554).

**Test scenarios:**
- Happy path: rendered Caddyfile contains the `/operator/*` handle block with `flush_interval -1` +
  both `header_up` directives + the gateway VPC target.
- Edge: `caddy adapt` succeeds (directive ordering valid; route ahead of catch-all).
- Edge: dashboard root route still proxies `dashboard:3000`.
- Integration: deploy reads `GATEWAY_VPC_IP` and injects it (no literal in the committed file).

**Verification:** `caddy adapt` passes; `/operator/*` sorts before catch-all; target is config-driven.

- [ ] **Unit 5: Post-deploy verification incl. fail-closed negative-control gate**

**Goal:** Prove the same-origin path is live and the access controls are correctly in place, using only
checks the deploy runner can actually execute, failing closed otherwise.

**Requirements:** R6

**Dependencies:** Units 1-4

**Files:**
- Modify: `apps/gateway/src/deploy.ts` and/or `apps/dashboard/src/deploy.ts` (verification phase)
- Test: corresponding `*.test.ts`

**Approach (reframed — the runner is NOT a VPC peer, so a live foreign-VPC-source probe is impossible;
verify what is actually checkable):**
- **Positive:** `GET https://dashboard.fro.bot/operator/health` → 200 through the dashboard Caddy proxy
  (the same-origin path works end to end). Runner can do this.
- **Public-denied (runner CAN test):** assert the public internet cannot reach `gateway.fro.bot:9300`
  (public `eth0`) — TCP connect refused/timed out. Runner originates from the public internet, so this
  is a real check.
- **Control-presence by readback (proves the negative structurally, not by a live foreign packet):**
  read back the DOCKER-USER rule (exact source/dport/jump/ordering per Unit 2) AND the DO firewall rule
  (inbound 9300 source == dashboard droplet-id, existing ports preserved) and assert both exactly
  restrict the source to the dashboard. The rule correctness — not a live non-dashboard packet — is the
  negative-control evidence.
- Fail closed if any check fails (public reachable, health != 200, or either control rule
  missing/wrong).

**Execution note:** Load `systematic:test-driven-development`. Mock probe + readback responses; assert
the deploy throws when public:9300 is reachable, when health != 200, or when a control rule is
missing/wrong-shaped.

**Patterns to follow:** existing operator health probe (~2496-2528); external-probe discipline
(resourcing-thrash doc — `curl`/`doctl`, never SSH-hammer); two-step readback (off-droplet-build doc).

**Test scenarios:**
- Happy path: same-origin 200 + public:9300 refused + both control rules exact → verification passes.
- Error path: public `gateway.fro.bot:9300` reachable → deploy fails closed.
- Error path: same-origin health != 200 → deploy fails.
- Error path: DOCKER-USER rule missing/wrong source → deploy fails.
- Error path: DO firewall 9300 rule missing/wrong source → deploy fails.
- Edge: operator disabled → verification phase skipped.

**Verification:** Deploy passes only when the same-origin path works, the public:9300 path is denied,
AND both source-restriction controls read back exactly correct.

- [ ] **Unit 6: Docs — rewrite invariants, document the bridge, update the ratification plan, runbook**

**Goal:** Docs reflect the live private-path bridge and no longer forbid it.

**Requirements:** R7

**Dependencies:** Units 1-5

**Files:**
- Modify: `apps/gateway/AGENTS.md` (rewrite the "no 9300 host port" invariant → "no 0.0.0.0 publish;
  VPC-scoped + DOCKER-USER + DO firewall only"; document the bridge + VPC vars)
- Modify: `apps/dashboard/AGENTS.md` (lift the `/operator/*` ban; document the live route + prerequisites
  now met)
- Modify: `docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md` (correct the stale
  "private path must be built" → the VPC already exists; mark the route live; flip status if all slices
  done)
- Create: `docs/runbooks/gateway-operator-private-path-verification.md` (positive + negative-control
  probes; break-glass `doctl power-cycle`)

**Approach:** Present-tense operator voice; no plan taxonomy; the droplet IPs are example values for
named config.

**Test scenarios:** Test expectation: none — docs. Verify via grep gates (no plan taxonomy; no remaining
"no 9300 host port" absolute ban; no remaining "/operator/* forbidden" in dashboard AGENTS.md).

**Verification:** Docs describe the live bridge; the two forbidding invariants are rewritten; runbook
exists and is cross-linked.

## System-Wide Impact

- **Interaction graph:** the new compose `ports:`, DOCKER-USER rule, and DO firewall are all gated on the
  operator-enabled + VPC-state all-or-none booleans — disabled deploys emit none of them.
- **API surface parity:** `gateway status` MCP reads `docker compose ps` — it will now show a VPC-scoped
  `9300` publish; confirm status parsing/tests tolerate it.
- **State lifecycle risks:** DOCKER-USER rule lost on reboot until next deploy — mitigated by the
  reboot-durable DO firewall (load-bearing) + reapply-per-deploy.
- **Unchanged invariants:** the daemon stays bound to `gateway-net 172.21.0.2:9300`; the stale-gateway-net
  cleanup sequence and announce ingress are untouched; `gateway.fro.bot/operator/*` stays 400-by-design.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Malformed/wrong-but-present DOCKER-USER rule silently allows traffic | Exact-readback (source/dport/jump/ordering, not mere presence) + DO firewall as independent second layer |
| DO firewall attach default-denies all other inbound (locks out 22/80/443/announce) | Additive reconcile of the EXISTING firewall only (`add-rules`); never create/attach a fresh allowlist; fail closed if no firewall exists |
| `DIGITALOCEAN_ACCESS_TOKEN` absent from gateway deploy env | Verify token first; fail closed with actionable error; seed in gateway env as operator-prereq |
| DO firewall source pinned to private IP drifts on dashboard rebuild | Source = dashboard droplet-id (stable), via `getDropletId` |
| Caddyfile has no env path for the VPC target | Pass `GATEWAY_VPC_IP` env to the dashboard caddy service; Caddyfile uses `{$GATEWAY_VPC_IP}` |
| Partial state: dashboard route live before gateway bridge (or vice versa) | Documented first-deploy order (gateway bridge first, verify, then dashboard route) |
| Negative-control unverifiable from non-VPC runner | Reframed R6: verify public-denied + same-origin-200 + exact control readback (not a live foreign-source packet) |
| DOCKER-USER rule wiped by `docker compose up` | Apply the rule AFTER compose up (last step) |
| Hardcoded VPC interface breaks on droplet rebuild | Detect interface/IP at deploy; fail closed if not found (VPN lesson) |
| DOCKER-USER lost on reboot | DO Cloud Firewall (survives reboot) is the load-bearing provider control; reapply every deploy |
| Caddy directive ordering self-404s `/operator/*` | `handle` block before catch-all; `caddy adapt` validation (self-404 doc) |
| First deploy is a multi-layer contract test (publish+iptables+doctl+route) | Budget for cascade; multiplex SSH (ControlMaster) to avoid ufw lockout; external probes for verification |
| DO firewall reconcile not idempotent → duplicate rules/drift | Ensure-exists/ensure-rule reconcile; idempotent no-op on rerun; deploy-owned single source of truth |
| Locked out of the listener by a bad rule | Break-glass `doctl compute droplet-action power-cycle <gateway-id>`; never SSH-hammer |

## Documentation / Operational Notes

- No changeset: this is `apps/gateway` + `apps/dashboard` deploy code + `packages/shared` helper + docs —
  not `packages/cli/src/` published runtime. Confirm during implementation no published CLI surface
  changed.
- New `gateway` + `dashboard` env: `GATEWAY_VPC_IP`, `DASHBOARD_VPC_IP` (gateway needs both; dashboard
  needs `GATEWAY_VPC_IP`). Seed in the respective GitHub Environments + local `.env` before first deploy
  (operator-prereq, like the listener trio).
- `DIGITALOCEAN_ACCESS_TOKEN` must be available to the gateway deploy (for the firewall reconcile) —
  verify it is in the gateway GitHub Environment; add it if missing. The firewall step fails closed if
  absent.
- **First-deploy order (operator-prereq):** deploy the GATEWAY first (publish + DOCKER-USER + firewall),
  verify the bridge, THEN deploy the DASHBOARD `/operator/*` route — the route must not go live before
  its target is reachable + restricted.
- First deploy: expect a multi-layer contract-test cascade; verify live over SSH + external probes (never
  SSH-hammer; break-glass `doctl compute droplet-action power-cycle <gateway-id>`).

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-18-dashboard-operator-private-path-requirements.md
- Ratification plan: docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md
- Operator auth (shipped): docs/plans/2026-06-18-002-feat-gateway-operator-auth-config-plan.md, #580
- Related issues: #579 (listener topology, closed), #581 (same-origin decision)
- Caddy self-404: docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md
- iptables interface detection: docs/solutions/integration-issues/vpn-lightsail-wan-interface-masquerade-2026-06-12.md
- Break-glass / external probes: docs/solutions/workflow-issues/gateway-deploy-resourcing-thrash-2026-06-04.md
- Code anchors: apps/gateway/src/deploy.ts (buildComposeOverride, buildCaddyfile, operator gating, SSH helpers), apps/dashboard/config/Caddyfile, packages/shared/server/droplet-helpers.ts
