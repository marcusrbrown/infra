#!/usr/bin/env bun

import {chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {readPeers, renderServerConfig, type Peer} from '@marcusrbrown/infra-shared/vpn/peers'
import {validateVpnHost} from './host'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeployEnv {
  readonly [key: string]: string
  PATH: string
  HOME: string
  VPN_HOST: string
}

/** Minimal subset of Bun.Subprocess used by this script. */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin?: {write: (data: Uint8Array) => void; end: () => void}
  exited: Promise<number>
}

export interface SpawnOpts {
  env: DeployEnv
  stdout: 'pipe'
  stderr: 'pipe'
  stdin?: 'pipe'
}

/** Injectable spawn function — defaults to Bun.spawn. */
export type SpawnFn = (cmd: string[], opts: SpawnOpts) => SpawnResult

export interface ValidatedEnv {
  PATH: string
  HOME: string
  VPN_HOST: string
  SSH_AUTH_SOCK?: string
  VPN_SSH_KEY?: string
}

export interface DeployOpts {
  env?: Record<string, string>
  spawn?: SpawnFn
  /** Override the path to peers.json (for testing). */
  peersJsonPath?: string
  /** When true, regenerate the server key even if it already exists. */
  forceServerKey?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_REMOTE_USER = 'ubuntu'
const WG_CONFIG_PATH = '/etc/wireguard/wg0.conf'
const SERVER_KEY_PATH = '/etc/wireguard/server.key'
const SERVER_PUB_PATH = '/etc/wireguard/server.pub'
const SYSCTL_CONF_PATH = '/etc/sysctl.d/99-wg-forwarding.conf'

// ─── Env validation ───────────────────────────────────────────────────────────

/**
 * Validates all required environment variables are present and well-formed.
 * Calls validateVpnHost on VPN_HOST before any SSH argv is constructed.
 *
 * @throws {Error} with a specific message naming the missing/invalid variable.
 * @returns A typed ValidatedEnv with all required fields guaranteed non-empty.
 */
export function validateEnv(env: Record<string, string>): ValidatedEnv {
  const path = env.PATH
  if (!path) {
    throw new Error('PATH is required for deploy')
  }

  const home = env.HOME
  if (!home) {
    throw new Error('HOME is required for deploy')
  }

  // SSH context: local mode needs SSH_AUTH_SOCK; CI mode needs VPN_SSH_KEY
  if (!env.SSH_AUTH_SOCK && !env.VPN_SSH_KEY) {
    throw new Error('SSH context is required: set SSH_AUTH_SOCK (local mode) or VPN_SSH_KEY (CI mode)')
  }

  const host = env.VPN_HOST
  if (!host) {
    throw new Error('VPN_HOST is required for deploy')
  }

  // Validate host before any SSH argv construction — rejects `-`-prefixed and
  // shell-metacharacter values that SSH would interpret as flags or injection vectors.
  validateVpnHost(host)

  return {
    PATH: path,
    HOME: home,
    VPN_HOST: host,
    ...(env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: env.SSH_AUTH_SOCK} : {}),
    ...(env.VPN_SSH_KEY ? {VPN_SSH_KEY: env.VPN_SSH_KEY} : {}),
  }
}

// ─── SSH helpers ──────────────────────────────────────────────────────────────

function sshIdentityOptions(keyPath: string | undefined): string[] {
  if (keyPath) {
    return ['-i', keyPath, '-o', 'IdentitiesOnly=yes']
  }
  return []
}

function sshCommand(host: string, command: string, keyPath?: string, controlPath?: string): string[] {
  return [
    'ssh',
    ...sshIdentityOptions(keyPath),
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    ...(controlPath
      ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=300']
      : []),
    `${DEFAULT_REMOTE_USER}@${host}`,
    command,
  ]
}

function buildDeployEnv(env: Record<string, string>): DeployEnv {
  return {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: env.HOME ?? '/home/ubuntu',
    VPN_HOST: env.VPN_HOST ?? '',
    ...(env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: env.SSH_AUTH_SOCK} : {}),
  }
}

function defaultSpawn(cmd: string[], opts: SpawnOpts): SpawnResult {
  return Bun.spawn(cmd, opts)
}

async function runCommand(
  label: string,
  command: string[],
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
): Promise<{stdout: string; stderr: string}> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

  const proc = spawnFn(command, {env: deployEnv, stdout: 'pipe', stderr: 'pipe'})

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (stdout.trim()) {
    console.warn(stdout.trim())
  }

  if (exitCode !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    if (stderr.trim()) {
      console.error(stderr.trim())
    }
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`)
  }

  return {stdout, stderr}
}

/**
 * Writes content to a remote path via SSH stdin pipe.
 * Content is NEVER placed in the shell command argv — it flows through stdin only.
 */
async function writeRemoteFile(
  label: string,
  host: string,
  remotePath: string,
  content: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

  // umask 077 ensures the file is created with 600 permissions.
  // sudo tee writes with root privileges; output is discarded (> /dev/null).
  // Content arrives via stdin — never in the shell command string.
  const proc = spawnFn(sshCommand(host, `umask 077; sudo tee '${remotePath}' > /dev/null`, keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })

  if (!proc.stdin) {
    throw new Error(`Spawn did not provide stdin pipe for: ${label}`)
  }

  proc.stdin.write(new TextEncoder().encode(content))
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    if (stderr.trim()) {
      console.error(stderr.trim())
    }
    throw new Error(`Command failed with exit code ${exitCode}: ${label}`)
  }

  if (stdout.trim()) {
    console.warn(stdout.trim())
  }
}

/**
 * Reads the server public key from the remote box.
 * Only server.pub is read back — the private key never leaves the box.
 */
async function readRemoteServerPub(
  host: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<string> {
  const {stdout} = await runCommand(
    'Reading server public key (server.pub)',
    sshCommand(host, `sudo cat '${SERVER_PUB_PATH}'`, keyPath, controlPath),
    deployEnv,
    spawnFn,
  )
  return stdout.trim()
}

/**
 * Ensures the server WireGuard keypair exists on the box.
 *
 * Mechanism (atomic, preserved):
 *   ssh "umask 077; test -f /etc/wireguard/server.key || (wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub)"
 *
 * The `test -f ... || (...)` guard means:
 *   - If server.key already exists: the genkey pipeline is skipped entirely.
 *   - If server.key is absent: genkey runs atomically, writing both key files.
 *
 * The server PRIVATE key is NEVER read back to the local process.
 * Only server.pub is subsequently read (see readRemoteServerPub).
 */
async function ensureServerKey(
  host: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  const cmd =
    `sudo sh -c 'umask 077; test -f ${SERVER_KEY_PATH} || ` +
    `(wg genkey | tee ${SERVER_KEY_PATH} | wg pubkey > ${SERVER_PUB_PATH})'`

  await runCommand(
    'Ensuring server keypair (atomic, preserved)',
    sshCommand(host, cmd, keyPath, controlPath),
    deployEnv,
    spawnFn,
  )
}

/**
 * Force-regenerates the server WireGuard keypair on the box.
 * Used only when --force-server-key is passed.
 *
 * WARNING: Regenerating the server key invalidates all existing client configs.
 * All clients must receive a new server public key and reconnect.
 */
async function forceRegenerateServerKey(
  host: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  console.warn(
    '\u001B[1;33m[warn]\u001B[0m --force-server-key: regenerating server keypair — all clients will need to reconnect',
  )

  // No `test -f` guard — unconditionally regenerate.
  // The private key is written to the box only; never transmitted locally.
  const cmd = `sudo sh -c 'umask 077; wg genkey | tee ${SERVER_KEY_PATH} | wg pubkey > ${SERVER_PUB_PATH}'`

  await runCommand('Force-regenerating server keypair', sshCommand(host, cmd, keyPath, controlPath), deployEnv, spawnFn)
}

/**
 * Renders wg0.conf SERVER-SIDE via SSH stdin.
 *
 * Security mechanism (the private key never leaves the box):
 *
 *   1. Locally: call renderServerConfig('__SERVER_PRIVATE_KEY__', peers, {wanInterface})
 *      to produce the full wg0.conf text with a literal placeholder for the private key.
 *   2. Ship the rendered config (with placeholder) via SSH stdin to a temp file on the box.
 *   3. Box-side: awk reads /etc/wireguard/server.key locally, substitutes the placeholder,
 *      and writes the result atomically to /etc/wireguard/wg0.conf with mode 0600.
 *
 *   The server PRIVATE key is NEVER transmitted to the local process.
 *   Only the placeholder config crosses SSH stdin — never argv.
 *   The substitution happens entirely server-side.
 *
 * Box-side substitution command (awk — safe for base64 keys containing `/` and `+`):
 *   awk 'BEGIN{getline key < "/etc/wireguard/server.key"} \
 *        {gsub("__SERVER_PRIVATE_KEY__", key); print}' \
 *        /tmp/wg0.conf.tmp > /etc/wireguard/wg0.conf \
 *   && chmod 600 /etc/wireguard/wg0.conf \
 *   && rm -f /tmp/wg0.conf.tmp
 *
 * @param host - The remote VPN box hostname or IP.
 * @param peers - The parsed peer list (public keys + tunnel IPs — non-secret).
 * @param wanInterface - WAN interface for NAT masquerade (default: eth0).
 * @param deployEnv - The deploy environment variables.
 * @param spawnFn - Injectable spawn function.
 * @param keyPath - Optional path to the SSH identity file (CI mode).
 * @param controlPath - Optional SSH ControlPath for multiplexing.
 */
async function renderWgConfServerSide(
  host: string,
  peers: Peer[],
  wanInterface = 'eth0',
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  console.warn(`\u001B[1;34m==>\u001B[0m Rendering wg0.conf server-side (private key stays on box)`)

  // Render the config locally with a placeholder for the server private key.
  // The real key NEVER leaves the box — only the placeholder config is shipped.
  const PLACEHOLDER = '__SERVER_PRIVATE_KEY__'
  const configWithPlaceholder = renderServerConfig(PLACEHOLDER, peers, {wanInterface})

  // Temp path on the box for the placeholder config.
  const tmpConfPath = `${WG_CONFIG_PATH}.tmp`

  // Step 1: Ship the placeholder config to a temp file on the box via stdin.
  await writeRemoteFile(
    'Shipping placeholder wg0.conf to box (private key placeholder — not the real key)',
    host,
    tmpConfPath,
    configWithPlaceholder,
    deployEnv,
    spawnFn,
    keyPath,
    controlPath,
  )

  // Step 2: Box-side substitution — awk reads server.key locally and replaces the placeholder.
  // awk is safe for base64 keys (which contain `/` and `+`) because gsub() does not use
  // regex delimiters for the replacement string. The key is read via getline from the
  // box's local filesystem — it never appears in argv or crosses SSH.
  //
  // Atomic write: awk writes to a temp file, then mv replaces wg0.conf atomically.
  // mv is atomic on the same filesystem — prevents a partial write if SSH drops mid-command.
  // Guard: test -s verifies server.key is non-empty before substitution (fail closed).
  const newConfPath = `${WG_CONFIG_PATH}.new`
  // Wrap the entire substitution pipeline under sudo sh -c so awk can read
  // the root-owned server.key and mv into /etc/wireguard (root-owned dir).
  const substituteCmd =
    `sudo sh -c 'test -s ${SERVER_KEY_PATH} && ` +
    `awk '"'"'BEGIN{getline key < "${SERVER_KEY_PATH}"} ` +
    `{gsub("${PLACEHOLDER}", key); print}'"'"' ` +
    `${tmpConfPath} > ${newConfPath} ` +
    `&& chmod 600 ${newConfPath} ` +
    `&& mv ${newConfPath} ${WG_CONFIG_PATH} ` +
    `&& rm -f ${tmpConfPath}'`

  await runCommand(
    'Substituting server key placeholder in wg0.conf (server-side, key never leaves box)',
    sshCommand(host, substituteCmd, keyPath, controlPath),
    deployEnv,
    spawnFn,
  )
}

/**
 * Parses `wg show wg0` output and returns the peer count.
 * Counts lines starting with "peer:" in the output.
 */
function parseWgShowPeerCount(output: string): number {
  return output.split('\n').filter(line => line.trim().startsWith('peer:')).length
}

/**
 * Health gate: verifies the WireGuard interface is up and has the expected peer count.
 * Uses `wg show wg0` — freshness check, not just `systemctl is-active`.
 */
async function healthGate(
  host: string,
  expectedPeerCount: number,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  const proc = spawnFn(sshCommand(host, 'sudo wg show wg0', keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || 'no output'
    throw new Error(
      `health gate failed: wg show wg0 exited ${exitCode} — WireGuard interface may be down. Detail: ${detail}`,
    )
  }

  if (!stdout.includes('interface:')) {
    throw new Error(
      `health gate failed: wg show wg0 output does not contain "interface:" — interface may not be up.\n${stdout}`,
    )
  }

  const actualPeerCount = parseWgShowPeerCount(stdout)
  if (actualPeerCount !== expectedPeerCount) {
    throw new Error(
      `health gate failed: peer count mismatch — expected ${expectedPeerCount}, got ${actualPeerCount}.\n${stdout}`,
    )
  }

  console.warn(`\u001B[1;32m✓\u001B[0m health gate passed: wg0 up, ${actualPeerCount} peer(s)`)
}

// ─── Main deploy orchestrator ─────────────────────────────────────────────────

/**
 * Deploys the WireGuard VPN configuration to the remote box.
 *
 * Security invariant: the server PRIVATE key never leaves the box.
 *   - The atomic ensure command writes server.key on the box only.
 *   - Only server.pub is read back to the local process.
 *   - wg0.conf is rendered SERVER-SIDE: a shell script (shipped via SSH stdin)
 *     reads /etc/wireguard/server.key locally on the box and assembles the config.
 *   - peers.json (non-secret: public keys + tunnel IPs only) is the only data
 *     that crosses SSH stdin. The server private key is never transmitted.
 *
 * Order of operations:
 *   1. Validate env (throws before any SSH on failure)
 *   2. Materialize SSH key (CI mode only)
 *   3. Ensure server keypair (atomic, preserved unless --force-server-key)
 *   4. Read back server.pub (public key only)
 *   5. Render wg0.conf server-side (peers via stdin, key stays on box)
 *   6. Write wg-forwarding.conf to /etc/sysctl.d/ via stdin
 *   7. sysctl --system (apply ip_forward)
 *   8. systemctl enable --now wg-quick@wg0
 *   9. systemctl restart wg-quick@wg0 (pick up new config)
 *  10. Health gate: wg show wg0 (interface up + expected peer count)
 */
export async function deploy(opts: DeployOpts = {}): Promise<void> {
  const env = opts.env ?? (process.env as Record<string, string>)
  const spawnFn = opts.spawn ?? defaultSpawn
  const forceServerKey = opts.forceServerKey ?? false
  const peersJsonPath = opts.peersJsonPath ?? resolve(import.meta.dir, '..', 'config', 'peers.json')

  // Phase 1: Validate env — throws before any SSH on failure
  // validateEnv also calls validateVpnHost, so invalid hosts are caught here.
  const validated = validateEnv(env)
  const host = validated.VPN_HOST

  // Read and validate peers.json — used for wg0.conf rendering and health gate peer count.
  // Missing file is the ONLY acceptable empty case (no peers yet).
  // Corrupt/malformed JSON or schema errors → re-throw (abort the deploy).
  let peers: Peer[]
  let peerCount: number
  if (existsSync(peersJsonPath)) {
    // File exists: parse and validate — any error is fatal (corrupt data must not deploy 0 peers)
    const peersFile = await readPeers(peersJsonPath)
    peers = peersFile.peers
    peerCount = peers.length
  } else {
    // File absent: valid initial state — no peers yet
    peers = []
    peerCount = 0
  }

  const deployEnv = buildDeployEnv(env)

  // Phase 2: Materialize SSH key (CI mode only)
  let keyPath: string | undefined
  let tmpDir: string | undefined

  try {
    // Always create a tmpdir — used for ControlPath socket in both CI and local mode.
    tmpDir = mkdtempSync(join(tmpdir(), 'vpn-deploy-'))

    if (validated.VPN_SSH_KEY) {
      // Materialize the SSH key to a 0600 temp file.
      // Ensures trailing newline — GitHub Actions strips trailing whitespace from secrets;
      // OpenSSH rejects PEM keys without a trailing newline.
      keyPath = join(tmpDir, 'id')
      const keyContent = validated.VPN_SSH_KEY.endsWith('\n') ? validated.VPN_SSH_KEY : `${validated.VPN_SSH_KEY}\n`
      writeFileSync(keyPath, keyContent, {mode: 0o600})
      chmodSync(keyPath, 0o600)
    }

    // ControlPath socket lives inside tmpDir
    const controlPath = join(tmpDir, 'cm-%r@%h:%p')

    // Phase 3: Ensure server keypair (atomic, preserved)
    if (forceServerKey) {
      await forceRegenerateServerKey(host, deployEnv, spawnFn, keyPath, controlPath)
    } else {
      await ensureServerKey(host, deployEnv, spawnFn, keyPath, controlPath)
    }

    // Phase 4: Read back ONLY server.pub (private key stays on box)
    const serverPubKey = await readRemoteServerPub(host, deployEnv, spawnFn, keyPath, controlPath)
    console.warn(`\u001B[1;32m✓\u001B[0m Server public key: ${serverPubKey}`)

    // Phase 5: Render wg0.conf server-side
    // renderServerConfig is called locally with a placeholder key — the real key stays on the box.
    // The placeholder config is shipped via stdin; box-side awk substitutes the real key.
    await renderWgConfServerSide(host, peers, 'eth0', deployEnv, spawnFn, keyPath, controlPath)

    // Phase 6: Write ip_forward sysctl config via stdin
    const forwardingConf = 'net.ipv4.ip_forward = 1\n'
    await writeRemoteFile(
      'Writing /etc/sysctl.d/99-wg-forwarding.conf',
      host,
      SYSCTL_CONF_PATH,
      forwardingConf,
      deployEnv,
      spawnFn,
      keyPath,
      controlPath,
    )

    // Phase 7: Apply sysctl settings
    await runCommand(
      'Applying sysctl settings (ip_forward)',
      sshCommand(host, 'sudo sysctl --system', keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 8: Enable and start wg-quick@wg0
    await runCommand(
      'Enabling wg-quick@wg0',
      sshCommand(host, 'sudo systemctl enable --now wg-quick@wg0', keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 9: Restart to pick up new config
    await runCommand(
      'Restarting wg-quick@wg0 (pick up new config)',
      sshCommand(host, 'sudo systemctl restart wg-quick@wg0', keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 10: Health gate — wg show wg0 (freshness, not just systemctl is-active)
    await healthGate(host, peerCount, deployEnv, spawnFn, keyPath, controlPath)

    console.warn('\u001B[1;32m✓\u001B[0m Deploy complete.')
  } finally {
    // Clean up the tmp dir regardless of success or failure
    if (tmpDir) {
      try {
        rmSync(tmpDir, {recursive: true, force: true})
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const forceServerKey = process.argv.includes('--force-server-key')
  deploy({forceServerKey}).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
