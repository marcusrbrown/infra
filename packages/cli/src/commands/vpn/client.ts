import type {goke} from 'goke'

import {mkdir, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {z} from 'zod'
import {addPeer, readPeers, removePeer, renderClientConfig, writePeers, type Peer} from './peers'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Keypair {
  privateKey: string
  publicKey: string
}

export type KeypairGenFn = () => Promise<Keypair>

/** Minimal subset of Bun.Subprocess used for gh secret sync. */
export interface SyncSpawnResult {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin?: {write: (data: Uint8Array) => void; end: () => void}
  exited: Promise<number>
}

export interface SyncSpawnOpts {
  stdout: 'pipe'
  stderr: 'pipe'
  stdin: 'pipe'
}

/** Injectable spawn function for gh secret sync — defaults to Bun.spawn. */
export type SpawnFn = (cmd: string[], opts: SyncSpawnOpts) => SyncSpawnResult

export interface VpnClientAddOpts {
  peersJsonPath: string
  clientsDir: string
  serverPublicKey: string
  endpoint: string
  keypairGen?: KeypairGenFn
  spawnFn?: SpawnFn
  allowedIps?: string
  dns?: string
}

export interface VpnClientAddResult {
  tunnelIp: string
  confPath: string
}

// ─── WireGuard keypair generation ─────────────────────────────────────────────

/**
 * Generate a WireGuard keypair using the local `wg` binary.
 *
 * Assumption: `wg` is installed locally (wireguard-tools package).
 * The private key is generated locally and written ONLY to the gitignored
 * clients/ directory — it never leaves the local machine.
 */
export async function generateKeypair(): Promise<Keypair> {
  // Step 1: generate private key
  const genkeyProc = Bun.spawn(['wg', 'genkey'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [privateKeyRaw, genkeyStderr, genkeyExit] = await Promise.all([
    new Response(genkeyProc.stdout).text(),
    new Response(genkeyProc.stderr).text(),
    genkeyProc.exited,
  ])

  if (genkeyExit !== 0) {
    throw new Error(`wg genkey failed (exit ${genkeyExit}): ${genkeyStderr.trim()}`)
  }

  const privateKey = privateKeyRaw.trim()

  // Step 2: derive public key from private key
  const encoder = new TextEncoder()
  const pubkeyProc = Bun.spawn(['wg', 'pubkey'], {
    stdin: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${privateKey}\n`))
        controller.close()
      },
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [publicKeyRaw, pubkeyStderr, pubkeyExit] = await Promise.all([
    new Response(pubkeyProc.stdout).text(),
    new Response(pubkeyProc.stderr).text(),
    pubkeyProc.exited,
  ])

  if (pubkeyExit !== 0) {
    throw new Error(`wg pubkey failed (exit ${pubkeyExit}): ${pubkeyStderr.trim()}`)
  }

  return {
    privateKey,
    publicKey: publicKeyRaw.trim(),
  }
}

// ─── gh secret sync ───────────────────────────────────────────────────────────

const GH_SYNC_REPO = 'marcusrbrown/infra'
const GH_SYNC_ENV = 'vpn'
const GH_SYNC_SECRET = 'VPN_PEERS'

function defaultSpawnFn(cmd: string[], opts: SyncSpawnOpts): SyncSpawnResult {
  return Bun.spawn(cmd, opts)
}

/**
 * Sync the updated peer roster to the VPN_PEERS GitHub Environment secret.
 *
 * Pipes the JSON via stdin to `gh secret set VPN_PEERS --env vpn --repo marcusrbrown/infra`.
 * The roster bytes NEVER appear in argv — stdin only.
 *
 * On failure: prints a warning with the exact remediation command. Does NOT throw.
 * The local peers.json write has already succeeded; the secret being stale is recoverable.
 */
async function syncPeersSecret(peersJsonPath: string, peersJson: string, spawnFn: SpawnFn): Promise<void> {
  const cmd = ['gh', 'secret', 'set', GH_SYNC_SECRET, '--env', GH_SYNC_ENV, '--repo', GH_SYNC_REPO]

  const proc = spawnFn(cmd, {stdout: 'pipe', stderr: 'pipe', stdin: 'pipe'})

  if (!proc.stdin) {
    console.warn(
      `[warn] VPN_PEERS secret sync skipped: spawn did not provide stdin pipe. ` +
        `Remediation: gh secret set ${GH_SYNC_SECRET} --env ${GH_SYNC_ENV} < ${peersJsonPath}`,
    )
    return
  }

  proc.stdin.write(new TextEncoder().encode(peersJson))
  proc.stdin.end()

  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    console.warn(
      `[warn] VPN_PEERS secret sync failed (gh exited ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}). ` +
        `The local peers.json was updated but the VPN_PEERS secret is stale. ` +
        `Remediation: gh secret set ${GH_SYNC_SECRET} --env ${GH_SYNC_ENV} < ${peersJsonPath}`,
    )
  }
}

// ─── Write-guard ──────────────────────────────────────────────────────────────

/**
 * Validate that the resolved output path is under the expected clients directory.
 *
 * This is a runtime guard (not gitignore-only) that refuses to write client
 * .conf files (which contain private keys) outside the gitignored clients/ dir.
 *
 * @throws {Error} if the resolved path escapes the clients directory.
 */
function assertPathUnderClientsDir(confPath: string, clientsDir: string): void {
  const resolvedClientsDir = resolve(clientsDir)
  const resolvedConfPath = resolve(confPath)

  if (!resolvedConfPath.startsWith(`${resolvedClientsDir}/`) && resolvedConfPath !== resolvedClientsDir) {
    throw new Error(
      `Security: refusing to write client .conf outside the clients directory. ` +
        `Resolved path "${resolvedConfPath}" is not under "${resolvedClientsDir}". ` +
        `Client private keys must only be written to the gitignored clients/ directory.`,
    )
  }
}

// ─── Core operations ──────────────────────────────────────────────────────────

/**
 * Add a new VPN client peer.
 *
 * 1. Generates a WireGuard keypair locally (via `wg genkey` / `wg pubkey`).
 * 2. Assigns the next available tunnel IP via addPeer.
 * 3. Appends the PUBLIC key + tunnel IP to peers.json.
 * 4. Writes the client .conf (with PRIVATE key) to clients/<name>.conf.
 *
 * Security invariants:
 * - The client PRIVATE key is written ONLY to the gitignored clients/ directory.
 * - peers.json contains ONLY the public key — never the private key.
 * - The output path is validated before writing (runtime guard, not gitignore-only).
 */
export async function vpnClientAdd(name: string, opts: VpnClientAddOpts): Promise<VpnClientAddResult> {
  const {peersJsonPath, clientsDir, serverPublicKey, endpoint, allowedIps, dns} = opts
  const keypairGen = opts.keypairGen ?? generateKeypair
  const spawnFn = opts.spawnFn ?? defaultSpawnFn

  // Validate the output path before doing any work
  const confPath = resolve(clientsDir, `${name}.conf`)
  assertPathUnderClientsDir(confPath, clientsDir)

  // Generate keypair
  const keypair = await keypairGen()

  // Read current peers
  const peersFile = await readPeers(peersJsonPath)

  // Add peer (throws if duplicate name)
  const {peers: updatedPeers, tunnelIp} = addPeer(peersFile.peers, {
    name,
    publicKey: keypair.publicKey,
  })

  // Write updated peers.json (PUBLIC key only — never private key)
  const updatedPeersFile = {peers: updatedPeers}
  await writePeers(peersJsonPath, updatedPeersFile)

  // Sync updated roster to VPN_PEERS GitHub secret (best-effort — failure is a warning, not fatal)
  const peersJson = `${JSON.stringify(updatedPeersFile, null, 2)}\n`
  await syncPeersSecret(peersJsonPath, peersJson, spawnFn)

  // Render client .conf (contains PRIVATE key)
  const confContent = renderClientConfig({
    clientPrivateKey: keypair.privateKey,
    serverPublicKey,
    endpoint,
    tunnelIp,
    allowedIps,
    dns,
  })

  // Ensure clients directory exists
  await mkdir(clientsDir, {recursive: true})

  // Write client .conf to the gitignored clients/ directory
  await writeFile(confPath, confContent, {mode: 0o600})

  return {tunnelIp, confPath}
}

/**
 * List all VPN client peers from peers.json.
 */
export async function vpnClientList(peersJsonPath: string): Promise<Peer[]> {
  const peersFile = await readPeers(peersJsonPath)
  return peersFile.peers
}

export interface VpnClientRemoveOpts {
  spawnFn?: SpawnFn
}

/**
 * Remove a VPN client peer from peers.json.
 *
 * Note: The client .conf file in clients/ is NOT deleted — the operator
 * should delete it manually. The peer is removed from peers.json so the
 * next deploy will revoke access.
 *
 * After a successful local write, syncs the updated roster to the VPN_PEERS
 * GitHub Environment secret (best-effort — failure is a warning, not fatal).
 */
export async function vpnClientRemove(
  name: string,
  peersJsonPath: string,
  opts: VpnClientRemoveOpts = {},
): Promise<void> {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn
  const peersFile = await readPeers(peersJsonPath)
  const {peers: updatedPeers} = removePeer(peersFile.peers, name)
  const updatedPeersFile = {peers: updatedPeers}
  await writePeers(peersJsonPath, updatedPeersFile)

  // Sync updated roster to VPN_PEERS GitHub secret (best-effort — failure is a warning, not fatal)
  const peersJson = `${JSON.stringify(updatedPeersFile, null, 2)}\n`
  await syncPeersSecret(peersJsonPath, peersJson, spawnFn)
}

// ─── Default paths ────────────────────────────────────────────────────────────

function resolveDefaultPeersJsonPath(): string {
  // packages/cli/src/commands/vpn/ → repo root → apps/vpn/config/peers.json
  return resolve(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'vpn', 'config', 'peers.json')
}

function resolveDefaultClientsDir(): string {
  // packages/cli/src/commands/vpn/ → repo root → apps/vpn/clients/
  return resolve(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'vpn', 'clients')
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerVpnClient(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'vpn client add <name>',
      'Add a new VPN client peer. Generates a keypair, assigns a tunnel IP, and writes the client .conf to apps/vpn/clients/.',
    )
    .option(
      '--split-tunnel [cidrs]',
      z.string().describe('Comma-separated CIDRs for split-tunnel routing. Defaults to 0.0.0.0/0 (full tunnel).'),
    )
    .option('--dns [dns]', z.string().describe('DNS server for the client config.'))
    .option('--server-pubkey [key]', z.string().describe('Server public key. Falls back to VPN_SERVER_PUBKEY env var.'))
    .option(
      '--endpoint [host]',
      z.string().describe('VPN server endpoint (IP or hostname). Falls back to VPN_HOST env var.'),
    )
    .example('# Add a new client named "laptop"')
    .example('infra vpn client add laptop')
    .example('# Add a split-tunnel client')
    .example('infra vpn client add laptop --split-tunnel 10.0.0.0/8,192.168.0.0/16')
    .action(async (name, options) => {
      const serverPublicKey = options.serverPubkey ?? process.env.VPN_SERVER_PUBKEY
      const endpoint = options.endpoint ?? process.env.VPN_HOST

      if (!serverPublicKey) {
        console.error('Server public key is required. Pass --server-pubkey or set VPN_SERVER_PUBKEY.')
        process.exitCode = 1
        return
      }

      if (!endpoint) {
        console.error('VPN endpoint is required. Pass --endpoint or set VPN_HOST.')
        process.exitCode = 1
        return
      }

      try {
        const result = await vpnClientAdd(name as string, {
          peersJsonPath: resolveDefaultPeersJsonPath(),
          clientsDir: resolveDefaultClientsDir(),
          serverPublicKey,
          endpoint,
          allowedIps: options.splitTunnel ?? undefined,
          dns: options.dns ?? undefined,
        })

        console.log(`Client "${name as string}" added.`)
        console.log(`  Tunnel IP: ${result.tunnelIp}`)
        console.log(`  Config:    ${result.confPath}`)
        console.log('')
        console.log('Next step: run `infra vpn deploy` to apply the new peer to the VPN box.')
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })

  cli.command('vpn client list', 'List all VPN client peers from peers.json.').action(async () => {
    try {
      const peers = await vpnClientList(resolveDefaultPeersJsonPath())

      if (peers.length === 0) {
        console.log('No peers configured.')
        return
      }

      console.log('Name             Tunnel IP       Public Key')
      console.log('─────────────────────────────────────────────────────────')
      for (const peer of peers) {
        const name = peer.name.padEnd(16)
        const ip = peer.tunnelIp.padEnd(15)
        console.log(`${name} ${ip} ${peer.publicKey}`)
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })

  cli
    .command(
      'vpn client remove <name>',
      'Remove a VPN client peer from peers.json. Run `infra vpn deploy` to revoke access.',
    )
    .example('# Remove a client named "laptop"')
    .example('infra vpn client remove laptop')
    .action(async name => {
      try {
        await vpnClientRemove(name as string, resolveDefaultPeersJsonPath())
        console.log(`Peer "${name as string}" removed from peers.json.`)
        console.log('Next step: run `infra vpn deploy` to revoke access on the VPN box.')
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })
}
