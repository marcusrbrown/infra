---
title: AWS Lightsail VPN first-provision and first-deploy bug cascade
date: 2026-06-10
category: docs/solutions/workflow-issues/
module: apps/vpn
problem_type: workflow_issue
component: tooling
severity: high
symptoms:
  - "InvalidInputException: The format of this public key is not valid"
  - "InvalidInputException: Some names are already in use (NameExists) while GetInstance returns NotFound"
  - "InvalidInputException: bundle that doesn't support the attachStaticIp operation"
  - "Deploy VPN silently skipped in CI (Filter vpn = false)"
root_cause: wrong_api
resolution_type: code_fix
tags:
  - aws-lightsail
  - wireguard
  - provisioning
  - paths-filter
  - ssh
  - known-hosts
  - first-deploy
---

# AWS Lightsail VPN first-provision and first-deploy bug cascade

## Problem

Standing up the repo's first AWS app — a WireGuard egress box on Lightsail (`eu-west-1`) — cascaded through eight provider-specific contract mismatches across provisioning, the SSH/host model, and CI change detection. Each was small in isolation; together they made first bring-up brittle and required hitting live AWS to surface them.

## Symptoms

- `InvalidInputException: The format of this public key is not valid` (code `InvalidKey.Format`) on `ImportKeyPair`.
- `InvalidInputException: Some names are already in use: fro-bot-vpn` (`NameExists`) on `CreateInstances` — while `GetInstance` returned `NotFound` and `GetInstances` was empty.
- SSH/commands failing when run as `root`; `apt-get` permission-denied as `ubuntu`.
- `InvalidInputException: The instance wg-egress uses a bundle that doesn't support the attachStaticIp operation`.
- Re-running provisioning threw instead of idempotently skipping the existing key pair.
- Lightsail auth failures from the wrong AWS credentials.
- `known_hosts` drift test failing after pinning new host keys.
- `Deploy VPN` silently skipped on the app's own merge (`Filter vpn = false`).

## What Didn't Work

- `btoa(publicKey)` for Lightsail's `publicKeyBase64` parameter.
- Reusing the same name (`fro-bot-vpn`) for the instance and the key pair.
- Connecting as `root` over SSH (the DigitalOcean model).
- Picking the cheapest bundle without checking IPv4 support.
- Matching only `'already exists'` / `'duplicate'` for idempotency.
- Reading ambient `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (the gateway's S3 creds).
- Trusting the AWS docs that imply Lightsail `ImportKeyPair` is `ssh-rsa`-only.
- `predicate-quantifier: every` with multiple positive directory globs in `paths-filter`.

## Solution

**SSH key import** — Lightsail's `publicKeyBase64` wants the raw OpenSSH text (the key body is already base64); `btoa` double-encodes:

```ts
// before
publicKeyBase64: btoa(publicKey)
// after — raw OpenSSH text, trimmed (Lightsail accepts ed25519 despite docs implying rsa-only)
publicKeyBase64: publicKey.trim()
```

**Distinct resource names** — Lightsail enforces name uniqueness across *all* resource types in a region, so the instance and key pair cannot share a name: instance `wg-egress`, key pair `wg-egress-key`, static IP `wg-egress-ip`.

**SSH/sudo model** — Lightsail Ubuntu installs the imported key for `ubuntu` only, disables root SSH, and grants `ubuntu` passwordless sudo. Connect as `ubuntu` and escalate every privileged command (a bare `cat >` redirect runs unprivileged, so writes to root-owned paths use `sudo tee`):

```sh
# before
cat > /etc/wireguard/server.key
# after
umask 077; sudo tee /etc/wireguard/server.key > /dev/null
```

Likewise `sudo apt-get`, `sudo wg show`, `sudo sysctl`, `sudo systemctl`, and box-side key generation / awk config render under `sudo sh -c`.

**Bundle selection** — IPv6-only bundles (`nano_ipv6_3_0`, `publicIpv4AddressCount: 0`) can't attach a static IP. Filter to `publicIpv4AddressCount >= 1`, which selects `nano_3_0`.

**Idempotency** — match Lightsail's real phrasing in a shared helper used by the key-pair and static-IP paths:

```ts
isAlreadyExistsError(e) // matches 'already in use' | 'already exists' | 'duplicate' | 'nameexists'
```

**Credential isolation** — read dedicated `VPN_AWS_ACCESS_KEY_ID` / `VPN_AWS_SECRET_ACCESS_KEY` / `VPN_AWS_REGION` and pass them explicitly to `new LightsailClient({ credentials })` so the SDK never falls back to the ambient (gateway S3) AWS env vars. Provisioning-only — deploy/status are SSH-only.

**Packaged known_hosts** — keep `packages/cli/src/resources/known_hosts` byte-identical to `.github/known_hosts` (a drift-guard test enforces it); sync after pinning new host keys.

**CI paths-filter** — under `predicate-quantifier: every`, a changed file must match *all* patterns, so multiple positive directory globs form an impossible intersection (no file lives in all three dirs). Combine into one brace-expansion glob:

```yaml
# before — always false under `every`
vpn:
  - 'apps/vpn/**'
  - 'packages/cli/src/commands/vpn/**'
  - 'packages/shared/vpn/**'
# after
vpn:
  - '{apps/vpn,packages/cli/src/commands/vpn,packages/shared/vpn}/**'
  - '!**/*.md'
  - '!**/*.test.ts'
  - '!**/__fixtures__/**'
  - '!**/__snapshots__/**'
```

Verify the glob with `picomatch` (dorny/paths-filter's matcher): real source matches; docs, tests, fixtures, snapshots, and other apps are excluded.

## Why This Works

This was a provider-contract problem, not a generic infra bug. Lightsail's SDK parameter names mislead (`publicKeyBase64` wants raw text), its error phrasing differs from expectation (`NameExists` vs `already exists`), its name namespace is broader than instances alone (region-wide, cross-type), its bundle capabilities are non-obvious (IPv6-only can't take a static IP), and its host SSH/sudo model is provider-specific (`ubuntu`+sudo, not root). Each fix encodes the *actual live contract* instead of assuming the docs are complete or the phrasing is stable.

## Prevention

- Treat the first provision/deploy of a new cloud as a **contract test**, not a happy-path script — verify each SDK behavior against the live provider.
- Verify SDK parameter *semantics* live (the AWS docs said rsa-only; live Lightsail accepted ed25519 raw text).
- Give every billable/cloud resource type a distinct name; never share a name across types on Lightsail.
- Test `paths-filter` filters with `picomatch` whenever using `predicate-quantifier: every`, especially with more than one positive glob — use a single brace-expansion positive glob plus global negations.
- Keep the packaged `known_hosts` byte-identical to `.github/known_hosts`.
- Isolate per-app cloud credentials (`<APP>_AWS_*`); never rely on ambient shared AWS env vars, and pass credentials explicitly to the client.
- Pair a resource-creating provisioner with a cleanup path — a documented console-teardown runbook step or a scoped delete capability — so a failed run doesn't strand billable resources that least-privilege IAM can't remove.

## Related Issues

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — DigitalOcean first-deploy cascade (precedent; different cloud and failure set).
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — gateway first-deploy cascade (same "first deploy is a contract test" pattern).
- `docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md` — Umami first-deploy cascade (same cascade family).
