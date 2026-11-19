# VPN Egress Box

The VPN box is a WireGuard egress box on AWS Lightsail (`eu-west-1`, Ireland), managed as a first-class deployable in this repo. This runbook covers operator bootstrap, reprovision recovery, client onboarding, and old-EC2 teardown. For the deploy flow and anti-patterns, see [`apps/vpn/AGENTS.md`](../../apps/vpn/AGENTS.md).

---

## Why Ireland (`eu-west-1`)

Ireland is the closest AWS region that provides a non-georestricted egress point for the operator's use cases. It is the lowest-latency option that satisfies the operator's routing requirements without relying on a US-based exit. The region choice is durable: the static IP is the client-facing endpoint, and changing regions requires reprovisioning (new static IP, new client configs). Lightsail Ireland is also the cheapest reliable option (~$5/mo flat rate for the smallest IPv4 bundle).

---

## Prerequisites

Before running provisioning:

1. **Create a dedicated least-privilege Lightsail IAM user** in the AWS console. Attach a policy granting only the Lightsail actions needed for provisioning (instance create/get, static IP allocate/attach/get, firewall set, key pair import, blueprint/bundle list). This user is separate from the gateway's S3 keys. Lightsail IAM is action-scoped — many actions require `Resource: *`; scope by action, not ARN.

2. **Generate the `wg-egress` Ed25519 keypair** locally:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/wg-egress -C wg-egress -N ''
   ```

   The public key (`~/.ssh/wg-egress.pub`) is imported into Lightsail by the provisioner. The private key is `VPN_SSH_KEY`.

3. **Create the `vpn` GitHub Environment** in the repo settings with:
   - Required reviewer set
   - Main-only branch policy (deployment branches: `main` only)

   Pre-create before merging the VPN feature branch — GitHub auto-creates environments ungated on first workflow reference.

4. **Seed the repo-root `.env`** with:

   ```bash
   VPN_AWS_ACCESS_KEY_ID=<provisioning-iam-access-key>
   VPN_AWS_SECRET_ACCESS_KEY=<provisioning-iam-secret-key>
   # VPN_AWS_REGION=eu-west-1  # optional; defaults to eu-west-1
   VPN_SSH_KEY=<contents of ~/.ssh/wg-egress>
   ```

   `VPN_AWS_*` credentials are provisioning-only and distinct from the gateway's `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (S3-scoped). They are not seeded into the `vpn` GitHub Environment.

---

## Operator Bootstrap

The `VPN_HOST` cycle: the static IP is unknown until provisioning runs. Follow this sequence exactly.

### Step 1: Provision the box

```bash
bun run provision:vpn
```

The script:
- Imports the `wg-egress` Ed25519 public key into Lightsail
- Resolves the current Ubuntu LTS blueprint and smallest IPv4 bundle live
- Creates the instance in `eu-west-1a`
- Allocates + attaches the `wg-egress-ip` static IP
- Sets the exact firewall: SSH 22 (tcp) + UDP 51820 (udp) — closes Lightsail's default 80/443
- Waits for SSH
- Installs WireGuard (`apt-get install -y wireguard`)
- Pins the IP host key into `.github/known_hosts`
- **Prints the allocated static IP**

### Step 2: Seed `VPN_HOST`

Take the printed static IP and seed it:

```bash
# In the repo-root .env:
VPN_HOST=<printed-static-ip>

# In the vpn GitHub Environment (via gh CLI or the GitHub UI):
printf '%s' '<printed-static-ip>' | gh secret set --env vpn VPN_HOST
printf '%s' "$(cat ~/.ssh/wg-egress)" | gh secret set --env vpn VPN_SSH_KEY
```

### Step 3: Commit `.github/known_hosts`

```bash
git add .github/known_hosts
git commit -m "chore: pin VPN box IP host key"
git push
```

### Step 4: First deploy

```bash
bunx @marcusrbrown/infra vpn deploy
```

Approve the `vpn` environment gate in the GitHub Actions UI. The first deploy:
- Generates the server keypair on the box (atomic, `0600`)
- Renders and writes `/etc/wireguard/wg0.conf` server-side
- Enables and starts `wg-quick@wg0`
- Health-gates on `wg show wg0`

### Step 5: Verify

```bash
bunx @marcusrbrown/infra vpn status
```

Confirm the interface is up and the server public key is displayed.

---

## Client Onboarding

Add a new WireGuard peer:

```bash
bunx @marcusrbrown/infra vpn client add <name>
```

This:
1. Generates a client keypair locally
2. Assigns the next available tunnel IP (`10.8.0.N/32`, sequential from `.2`)
3. Appends the client public key + tunnel IP to the local `apps/vpn/config/peers.json` (gitignored)
4. Syncs the updated roster to the `VPN_PEERS` GitHub Environment secret via `gh secret set VPN_PEERS --env vpn`
5. Writes the client `.conf` (with client private key) to `apps/vpn/clients/<name>.conf`

If the `gh` sync fails (missing binary, auth, or network), the command still succeeds and prints a warning with the exact remediation command:

```bash
gh secret set VPN_PEERS --env vpn --repo marcusrbrown/infra < apps/vpn/config/peers.json
```

**Stale-secret hazard:** if the sync fails and CI runs a deploy before the secret is re-synced, the stale roster in `VPN_PEERS` is applied to the box. The wipe guard (see below) blocks an empty-roster deploy, but a stale non-empty roster deploys silently. Re-sync with the command above.

The client `.conf` path is printed. Distribute it to the peer device securely (never via unencrypted channels). The `apps/vpn/clients/` directory is gitignored — client private keys never enter the repo.

To list current peers:

```bash
bunx @marcusrbrown/infra vpn client list
```

To remove a peer:

```bash
bunx @marcusrbrown/infra vpn client remove <name>
```

The peer is removed from the local `peers.json` and the `VPN_PEERS` secret is synced. Run `vpn deploy` explicitly to revoke the peer on the box. The client config on the peer device becomes invalid after the next deploy completes.

---

## Wipe Guard

The deploy includes a wipe guard that prevents silently disconnecting all clients when the incoming peer roster is empty. If `VPN_PEERS` is unset or empty in CI and the live box has peers, the deploy aborts with:

```
Wipe guard: the incoming roster is empty (0 peers) but the live box has N peer(s).
Deploying an empty roster would disconnect all clients.
To fix: re-sync the roster secret with:
  gh secret set VPN_PEERS --env vpn --repo marcusrbrown/infra < apps/vpn/config/peers.json
To intentionally remove all peers, set VPN_ALLOW_EMPTY_ROSTER=1.
```

**What it protects against:** an empty or missing `VPN_PEERS` secret in CI would deploy a 0-peer config to a box with live peers, silently disconnecting every client. The health gate would pass (expected 0 == actual 0), making the failure invisible.

**When to override:** set `VPN_ALLOW_EMPTY_ROSTER=1` in the deploy environment only when intentionally removing all peers. First-boot bootstrap (live=0, incoming=0) proceeds normally without the override.

**Remediation for a blocked deploy:**

```bash
# Re-sync the local roster to the VPN_PEERS secret:
gh secret set VPN_PEERS --env vpn --repo marcusrbrown/infra < apps/vpn/config/peers.json
# Then re-trigger the deploy.
```

---

## Box Unreachable: Memory Pressure

The box is a Lightsail nano (~412 MB RAM). Under memory pressure `systemd-networkd` can lose the interface and the box stays off the network while still "running".

**Recognise it:**

1. From outside, before touching anything:
   - `vpn status` and `vpn deploy` fail with SSH connect timeouts, while the Lightsail console shows the instance as running and the static IP still attached.
   - A later deploy can wait at its `vpn` approval gate and never run. The public status page then shows the VPN's deploy state as `unknown`: it reads only the newest `main` deployment, so one waiting at its gate hides the earlier failure, and it does not measure reachability.
   - An SSH-timeout deploy failure or report for this box warrants a Lightsail console check the same day.
2. Reboot the instance from the Lightsail console. The provisioning credentials hold a minimal action set (see the [IAM note](../../apps/vpn/AGENTS.md#iam-note)): in the 2026-11 operator session a reboot attempted with them was denied and they could not read instance metrics or state. The cause can be confirmed only after the reboot.
3. SSH in and check the previous boot:

   ```bash
   journalctl -b -1 | grep -E 'Under memory pressure|Could not set route|ens5: Failed|Out of memory'
   ```

   "Under memory pressure" followed by `ens5: Could not set route: Connection timed out` and `ens5: Failed` is this failure. `journalctl -b -1 -k | grep -i 'killed process'` shows the OOM kills.

**Recover:** the reboot restores networking. Run `vpn deploy` — it masks `fwupd-refresh.timer`/`fwupd.service` and creates a 1 GiB swap file if no swap is active, so the trigger does not return. Do not run `vpn deploy --local` while a CI VPN deploy is running: the two are not serialized.

Verify over SSH after the first deploy on a rebooted or new box:

- `swapon --show` lists active swap.
- If the deploy created `/swapfile`, `grep swapfile /etc/fstab` shows its line. Activation is not persistence. When other swap was already active the deploy creates no `/swapfile`.
- `systemctl is-enabled fwupd-refresh.timer` prints `masked`. In the 2026-11 session the timer read `failed` (`Unit to trigger vanished`) after masking and had no next run; that state is expected.

**A hardening failure stops the deploy.** It shows in one of two ways:

- An inconclusive probe throws an error beginning `Memory hardening:` that carries the probe command, its output and stderr. A mask result other than the expected one throws `Memory hardening: masking fwupd was not confirmed`.
- A failed mask or swap command prints `FAILED: <step>` with that step's output and stderr, then throws `Command failed with exit code <n>: <command>`.

Either way the deploy stops before any WireGuard change, including a deploy that only removes a peer. There is no override. Fix the box state the output describes, then run `vpn deploy` again.

**Cause and fix (2026-11-12):** the stock daily `fwupd-refresh` job pushed the box into memory pressure; the kernel had OOM-killed `fwupd` repeatedly before that. The deploy now runs a memory-hardening step on every run (see [`apps/vpn/AGENTS.md`](../../apps/vpn/AGENTS.md#memory-hardening)). If the box goes unreachable again with those in place, something else is consuming memory — check `journalctl -b -1 -k` for the process the OOM killer named.

---

## Reprovision Recovery

Reprovisioning creates a fresh disk, which destroys the server private key at `/etc/wireguard/server.key`. The static IP is re-attached (endpoint unchanged), but all clients fail the cryptographic handshake — a silent break. `vpn status` surfaces the server public key so a key mismatch is diagnosable (the new public key differs from what clients have).

### Option A: Backup/restore for continuity

Before reprovisioning, back up the server private key from the old box:

```bash
ssh root@<VPN_HOST> 'cat /etc/wireguard/server.key' > /tmp/server.key.bak
chmod 600 /tmp/server.key.bak
```

Store the backup securely (1Password, encrypted storage). After reprovisioning and the first deploy:

```bash
# Restore the server key
cat /tmp/server.key.bak | ssh root@<VPN_HOST> 'cat > /etc/wireguard/server.key && chmod 600 /etc/wireguard/server.key'
# Regenerate server.pub from the restored key
ssh root@<VPN_HOST> 'wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub'
# Restart the service
ssh root@<VPN_HOST> 'systemctl restart wg-quick@wg0'
```

Verify with `vpn status` — the server public key must match the pre-reprovision value. Existing client configs continue to work.

### Option B: Regenerate and reissue

Let the new box generate a fresh server key on first deploy. Then reissue every client config:

```bash
# For each peer:
bunx @marcusrbrown/infra vpn client remove <name>
bunx @marcusrbrown/infra vpn client add <name>
```

Distribute the new client configs to each peer device. The old configs are permanently invalid.

---

## Secret Rotation

### Rotate `VPN_SSH_KEY`

1. Generate a new `wg-egress` Ed25519 keypair.
2. Add the new public key to the box's `~/.ssh/authorized_keys` (while the old key still works).
3. Update `VPN_SSH_KEY` in the `vpn` GitHub Environment.
4. Trigger a deploy to verify the new key works.
5. Remove the old public key from the box's `authorized_keys`.

### Rotate the WireGuard server key

```bash
bunx @marcusrbrown/infra vpn deploy --force-server-key
```

This regenerates the server keypair on the box. All existing client configs become invalid — reissue every client config after rotation (see [Client Onboarding](#client-onboarding)).

---

## Old `us-west-2` OpenVPN EC2 Teardown

The old OpenVPN EC2 instance in `us-west-2` is unused and no longer free-tier. Terminate it manually in the AWS console:

1. Open the [EC2 console](https://us-west-2.console.aws.amazon.com/ec2/home?region=us-west-2#Instances) in `us-west-2`.
2. Locate the old OpenVPN instance.
3. Select it → **Instance state** → **Terminate instance**.
4. Confirm termination.

If the instance has an associated Elastic IP, release it after termination (Elastic IPs incur charges when unattached).

This is a manual, irreversible step. Verify no active clients depend on the old instance before terminating.

---

## Related

- [`apps/vpn/AGENTS.md`](../../apps/vpn/AGENTS.md) — deploy flow, server-key invariants, provisioning, anti-patterns
- [`apps/vpn/README.md`](../../apps/vpn/README.md) — quick-start, secrets table, CLI reference
- [`docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md`](../solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md) — SSH key trailing-newline and ControlMaster lessons (apply to VPN deploy)
- [`docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md`](../solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md) — GitHub Environment pre-create lesson (applies to `vpn` environment)
