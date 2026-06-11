import {readFile, writeFile} from 'node:fs/promises'

import {z} from 'zod'

// ── Schema ────────────────────────────────────────────────────────────────────

const peerSchema = z.object({
  name: z.string(),
  publicKey: z.string(),
  tunnelIp: z.string(),
})

const peersFileSchema = z
  .object({
    peers: z.array(peerSchema),
  })
  .superRefine((data, ctx) => {
    // Reject duplicate tunnelIp values — duplicated tunnel IPs break WireGuard routing silently
    const seenIps = new Set<string>()
    for (const peer of data.peers) {
      if (seenIps.has(peer.tunnelIp)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate tunnel IP "${peer.tunnelIp}" — each peer must have a unique tunnel IP.`,
          path: ['peers'],
        })
        return
      }
      seenIps.add(peer.tunnelIp)
    }

    // Reject duplicate name values
    const seenNames = new Set<string>()
    for (const peer of data.peers) {
      if (seenNames.has(peer.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate name "${peer.name}" — each peer must have a unique name.`,
          path: ['peers'],
        })
        return
      }
      seenNames.add(peer.name)
    }
  })

export type Peer = z.infer<typeof peerSchema>
export type PeersFile = z.infer<typeof peersFileSchema>

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Parse and validate a raw value as a PeersFile.
 * Throws a ZodError on invalid shape — fail-closed, no silent empty.
 */
export function parsePeersJson(raw: unknown): PeersFile {
  return peersFileSchema.parse(raw)
}

// ── File I/O (thin layer — only these functions touch the filesystem) ─────────

export async function readPeers(filePath: string): Promise<PeersFile> {
  const content = await readFile(filePath, 'utf-8')
  const raw: unknown = JSON.parse(content)
  return parsePeersJson(raw)
}

/**
 * Read peers from filePath, returning {peers: []} when the file is absent (ENOENT).
 *
 * ENOENT is the only error that is silently treated as an empty roster — this
 * supports fresh checkouts where peers.json is gitignored and does not exist yet.
 *
 * All other errors (corrupt JSON, schema violations, permission errors) still throw
 * so that a corrupt file is never silently treated as an empty roster.
 */
export async function readPeersOrEmpty(filePath: string): Promise<PeersFile> {
  try {
    return await readPeers(filePath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {peers: []}
    }
    throw error
  }
}

export async function writePeers(filePath: string, peersFile: PeersFile): Promise<void> {
  const content = `${JSON.stringify(peersFile, null, 2)}\n`
  await writeFile(filePath, content, {mode: 0o600})
}

// ── IP allocation ─────────────────────────────────────────────────────────────

const TUNNEL_SUBNET_PREFIX = '10.8.0.'
const SERVER_OCTET = 1
const FIRST_CLIENT_OCTET = 2

/**
 * Extract the last octet from a tunnel IP like '10.8.0.N'.
 * Returns null if the IP doesn't match the expected subnet.
 */
function extractOctet(tunnelIp: string): number | null {
  if (!tunnelIp.startsWith(TUNNEL_SUBNET_PREFIX)) {
    return null
  }
  const octetStr = tunnelIp.slice(TUNNEL_SUBNET_PREFIX.length)
  const octet = Number.parseInt(octetStr, 10)
  return Number.isFinite(octet) && octet >= FIRST_CLIENT_OCTET ? octet : null
}

// Last valid client octet: .254 (.1 is server, .255 is broadcast)
const LAST_CLIENT_OCTET = 254

/**
 * Compute the next available tunnel IP.
 * Sequential 10.8.0.N/32 starting at .2 (.1 is reserved for the server).
 * Reuses freed slots — returns the lowest free N >= 2.
 * Throws when all 253 client slots (.2–.254) are exhausted.
 */
export function nextTunnelIp(peers: Peer[]): string {
  const allocated = new Set<number>()
  for (const peer of peers) {
    const octet = extractOctet(peer.tunnelIp)
    if (octet !== null) {
      allocated.add(octet)
    }
  }

  let n = FIRST_CLIENT_OCTET
  while (allocated.has(n) || n === SERVER_OCTET) {
    n++
  }

  if (n > LAST_CLIENT_OCTET) {
    throw new Error(`Tunnel subnet 10.8.0.0/24 exhausted (max 253 peers).`)
  }

  return `${TUNNEL_SUBNET_PREFIX}${n}`
}

// ── Peer mutations (pure — return new arrays, never mutate) ───────────────────

/**
 * Add a peer with the next available tunnel IP.
 * Throws if a peer with the same name already exists.
 */
export function addPeer(
  peers: Peer[],
  {name, publicKey}: {name: string; publicKey: string},
): {peers: Peer[]; tunnelIp: string} {
  const duplicate = peers.find(p => p.name === name)
  if (duplicate !== undefined) {
    throw new Error(`Peer "${name}" already exists (duplicate name).`)
  }

  const tunnelIp = nextTunnelIp(peers)
  const newPeer: Peer = {name, publicKey, tunnelIp}
  return {peers: [...peers, newPeer], tunnelIp}
}

/**
 * Remove a peer by name.
 * Throws a clear error if the peer does not exist — no silent no-op.
 */
export function removePeer(peers: Peer[], name: string): {peers: Peer[]} {
  const index = peers.findIndex(p => p.name === name)
  if (index === -1) {
    throw new Error(`Peer "${name}" not found. Cannot remove a peer that does not exist.`)
  }

  const updated = [...peers.slice(0, index), ...peers.slice(index + 1)]
  return {peers: updated}
}

// ── Config rendering (pure — string in → string out, no IO) ──────────────────

export interface ServerConfigOpts {
  wanInterface?: string
}

/**
 * Render a full wg0.conf server configuration.
 *
 * Pure function: takes keys and peers as inputs, returns a config string.
 * The server private key is passed in (it lives on the box; this function
 * is used server-side where the key is available locally).
 */
export function renderServerConfig(serverPrivateKey: string, peers: Peer[], opts?: ServerConfigOpts): string {
  const wanInterface = opts?.wanInterface ?? 'eth0'

  const lines: string[] = [
    '[Interface]',
    `Address = 10.8.0.1/24`,
    `ListenPort = 51820`,
    `PrivateKey = ${serverPrivateKey}`,
    `PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o ${wanInterface} -j MASQUERADE`,
    `PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o ${wanInterface} -j MASQUERADE`,
  ]

  for (const peer of peers) {
    lines.push('')
    lines.push('[Peer]')
    lines.push(`PublicKey = ${peer.publicKey}`)
    lines.push(`AllowedIPs = ${peer.tunnelIp}/32`)
  }

  return `${lines.join('\n')}\n`
}

export interface ClientConfigOpts {
  clientPrivateKey: string
  serverPublicKey: string
  endpoint: string
  tunnelIp: string
  allowedIps?: string
  dns?: string
}

/**
 * Render a WireGuard client .conf file.
 *
 * Pure function: takes all config as inputs, returns a config string.
 * allowedIps defaults to '0.0.0.0/0' (full tunnel).
 * Pass specific CIDRs for split-tunnel.
 */
export function renderClientConfig(opts: ClientConfigOpts): string {
  const {clientPrivateKey, serverPublicKey, endpoint, tunnelIp, allowedIps = '0.0.0.0/0', dns} = opts

  const lines: string[] = ['[Interface]', `PrivateKey = ${clientPrivateKey}`, `Address = ${tunnelIp}/32`]

  if (dns !== undefined) {
    lines.push(`DNS = ${dns}`)
  }

  lines.push('')
  lines.push('[Peer]')
  lines.push(`PublicKey = ${serverPublicKey}`)
  lines.push(`Endpoint = ${endpoint}:51820`)
  lines.push(`AllowedIPs = ${allowedIps}`)

  return `${lines.join('\n')}\n`
}
