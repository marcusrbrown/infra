// Strict IPv4/IPv6 parsing and a "globally reachable?" classifier for the docs redaction gate.
//
// The special-purpose tables below are vendored data, not logic. Sources and retrieval date:
//   IPv4: https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml (last updated 2025-10-09)
//   IPv6: https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml (last updated 2025-10-09)
//   IPv6 address space: https://www.iana.org/assignments/ipv6-address-space/ipv6-address-space.xhtml
// Retrieved 2026-11-01. Refresh the tables from those pages; do not special-case addresses in code.
//
// Reading the tables:
//   - Only the registry's "Globally Reachable" column is recorded. Longest prefix wins, so a more specific
//     `true` entry carves a hole in a covering `false` entry (for example 192.0.0.9/32 inside 192.0.0.0/24).
//   - Blocks the registry marks "N/A" or "Deprecated" (6to4, Teredo, 192.88.99.0/24) are treated as globally
//     reachable. A redaction gate should over-report rather than wave an embedded public IPv4 through.
//   - Multicast (224.0.0.0/4, ff00::/8) is not in the special-purpose registries, but it is never a host
//     address, so the tables list it as not globally reachable.
//   - IPv6 outside 2000::/3 is unallocated or reserved by IETF (IPv6 address space registry), so it is not
//     globally reachable unless a table entry says otherwise.

interface SpecialRange {
  cidr: string
  globallyReachable: boolean
  name: string
}

const IPV4_SPECIAL: readonly SpecialRange[] = [
  {cidr: '0.0.0.0/8', globallyReachable: false, name: '"This network"'},
  {cidr: '0.0.0.0/32', globallyReachable: false, name: '"This host on this network"'},
  {cidr: '10.0.0.0/8', globallyReachable: false, name: 'Private-Use'},
  {cidr: '100.64.0.0/10', globallyReachable: false, name: 'Shared Address Space'},
  {cidr: '127.0.0.0/8', globallyReachable: false, name: 'Loopback'},
  {cidr: '169.254.0.0/16', globallyReachable: false, name: 'Link Local'},
  {cidr: '172.16.0.0/12', globallyReachable: false, name: 'Private-Use'},
  {cidr: '192.0.0.0/24', globallyReachable: false, name: 'IETF Protocol Assignments'},
  {cidr: '192.0.0.0/29', globallyReachable: false, name: 'IPv4 Service Continuity Prefix'},
  {cidr: '192.0.0.8/32', globallyReachable: false, name: 'IPv4 dummy address'},
  {cidr: '192.0.0.9/32', globallyReachable: true, name: 'Port Control Protocol Anycast'},
  {cidr: '192.0.0.10/32', globallyReachable: true, name: 'Traversal Using Relays around NAT Anycast'},
  {cidr: '192.0.0.170/32', globallyReachable: false, name: 'NAT64/DNS64 Discovery'},
  {cidr: '192.0.0.171/32', globallyReachable: false, name: 'NAT64/DNS64 Discovery'},
  {cidr: '192.0.2.0/24', globallyReachable: false, name: 'Documentation (TEST-NET-1)'},
  {cidr: '192.31.196.0/24', globallyReachable: true, name: 'AS112-v4'},
  {cidr: '192.52.193.0/24', globallyReachable: true, name: 'AMT'},
  {cidr: '192.88.99.2/32', globallyReachable: false, name: '6a44-relay anycast address'},
  {cidr: '192.168.0.0/16', globallyReachable: false, name: 'Private-Use'},
  {cidr: '192.175.48.0/24', globallyReachable: true, name: 'Direct Delegation AS112 Service'},
  {cidr: '198.18.0.0/15', globallyReachable: false, name: 'Benchmarking'},
  {cidr: '198.51.100.0/24', globallyReachable: false, name: 'Documentation (TEST-NET-2)'},
  {cidr: '203.0.113.0/24', globallyReachable: false, name: 'Documentation (TEST-NET-3)'},
  {cidr: '224.0.0.0/4', globallyReachable: false, name: 'Multicast (not in the registry)'},
  {cidr: '240.0.0.0/4', globallyReachable: false, name: 'Reserved'},
  {cidr: '255.255.255.255/32', globallyReachable: false, name: 'Limited Broadcast'},
]

const IPV6_SPECIAL: readonly SpecialRange[] = [
  {cidr: '::1/128', globallyReachable: false, name: 'Loopback Address'},
  {cidr: '::/128', globallyReachable: false, name: 'Unspecified Address'},
  {cidr: '::ffff:0:0/96', globallyReachable: false, name: 'IPv4-mapped Address (unwrapped before lookup)'},
  {cidr: '64:ff9b::/96', globallyReachable: true, name: 'IPv4-IPv6 Translat.'},
  {cidr: '64:ff9b:1::/48', globallyReachable: false, name: 'IPv4-IPv6 Translat.'},
  {cidr: '100::/64', globallyReachable: false, name: 'Discard-Only Address Block'},
  {cidr: '100:0:0:1::/64', globallyReachable: false, name: 'Dummy IPv6 Prefix'},
  {cidr: '2001::/23', globallyReachable: false, name: 'IETF Protocol Assignments'},
  {cidr: '2001::/32', globallyReachable: true, name: 'TEREDO (N/A in the registry)'},
  {cidr: '2001:1::1/128', globallyReachable: true, name: 'Port Control Protocol Anycast'},
  {cidr: '2001:1::2/128', globallyReachable: true, name: 'Traversal Using Relays around NAT Anycast'},
  {cidr: '2001:1::3/128', globallyReachable: true, name: 'DNS-SD Service Registration Protocol Anycast'},
  {cidr: '2001:2::/48', globallyReachable: false, name: 'Benchmarking'},
  {cidr: '2001:3::/32', globallyReachable: true, name: 'AMT'},
  {cidr: '2001:4:112::/48', globallyReachable: true, name: 'AS112-v6'},
  {cidr: '2001:20::/28', globallyReachable: true, name: 'ORCHIDv2'},
  {cidr: '2001:30::/28', globallyReachable: true, name: 'Drone Remote ID Protocol Entity Tags (DETs) Prefix'},
  {cidr: '2001:db8::/32', globallyReachable: false, name: 'Documentation'},
  {cidr: '2002::/16', globallyReachable: true, name: '6to4 (N/A in the registry)'},
  {cidr: '2620:4f:8000::/48', globallyReachable: true, name: 'Direct Delegation AS112 Service'},
  {cidr: '3fff::/20', globallyReachable: false, name: 'Documentation'},
  {cidr: '5f00::/16', globallyReachable: false, name: 'Segment Routing (SRv6) SIDs'},
  {cidr: 'fc00::/7', globallyReachable: false, name: 'Unique-Local'},
  {cidr: 'fe80::/10', globallyReachable: false, name: 'Link-Local Unicast'},
  {cidr: 'ff00::/8', globallyReachable: false, name: 'Multicast (not in the registry)'},
]

/** `::ffff:0:0/96`: everything above the low 32 bits is 0xffff. */
const IPV4_MAPPED_HIGH_BITS = 0xff_ffn
const GLOBAL_UNICAST_V6 = {prefix: 0x2000n << 112n, length: 3}

export type ParsedIp = {version: 4; value: bigint} | {version: 6; value: bigint}

const DECIMAL_OCTET_RE = /^(?:0|[1-9]\d{0,2})$/
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i

export function parseIpv4(text: string): bigint | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let value = 0n
  for (const part of parts) {
    if (!DECIMAL_OCTET_RE.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

export function parseIpv6(text: string): bigint | undefined {
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(':')) return undefined

  // An embedded IPv4 tail (`::ffff:1.2.3.4`) stands for the last two groups.
  let head = text
  let tail: string[] = []
  if (text.includes('.')) {
    const split = text.lastIndexOf(':')
    const v4 = parseIpv4(text.slice(split + 1))
    if (v4 === undefined) return undefined
    tail = [((v4 >> 16n) & 0xff_ffn).toString(16), (v4 & 0xff_ffn).toString(16)]
    // Drop the colon that preceded the IPv4 text, but keep a `::` so `::1.2.3.4` still reads as `::`.
    head = text.slice(0, split + 1)
    if (!head.endsWith('::')) head = head.slice(0, -1)
  }

  const halves = head.split('::')
  if (halves.length > 2) return undefined
  const toGroups = (half: string): string[] | undefined => {
    if (half === '') return []
    const groups = half.split(':')
    return groups.every(group => HEX_GROUP_RE.test(group)) ? groups : undefined
  }
  const left = toGroups(halves[0] ?? '')
  const right = halves.length === 2 ? toGroups(halves[1] ?? '') : []
  if (left === undefined || right === undefined) return undefined

  let groups: string[]
  if (halves.length === 2) {
    const missing = 8 - (left.length + right.length + tail.length)
    if (missing < 1) return undefined
    groups = [...left, ...Array.from({length: missing}, () => '0'), ...right, ...tail]
  } else {
    groups = [...left, ...tail]
    if (groups.length !== 8) return undefined
  }
  let value = 0n
  for (const group of groups) value = (value << 16n) | BigInt(Number.parseInt(group, 16))
  return value
}

export function parseIp(text: string): ParsedIp | undefined {
  const v4 = parseIpv4(text)
  if (v4 !== undefined) return {version: 4, value: v4}
  const v6 = parseIpv6(text)
  return v6 === undefined ? undefined : {version: 6, value: v6}
}

interface CompiledRange {
  prefix: bigint
  length: number
  globallyReachable: boolean
}

function compile(ranges: readonly SpecialRange[], version: 4 | 6): CompiledRange[] {
  const width = version === 4 ? 32 : 128
  return ranges.map(({cidr, globallyReachable}) => {
    const [address = '', lengthText = ''] = cidr.split('/')
    const parsed = version === 4 ? parseIpv4(address) : parseIpv6(address)
    const length = Number(lengthText)
    if (parsed === undefined || !Number.isInteger(length) || length < 0 || length > width) {
      throw new Error(`invalid special-purpose range ${cidr}`)
    }
    return {prefix: parsed, length, globallyReachable}
  })
}

const COMPILED_V4 = compile(IPV4_SPECIAL, 4)
const COMPILED_V6 = compile(IPV6_SPECIAL, 6)

function contains(range: {prefix: bigint; length: number}, value: bigint, width: number): boolean {
  const shift = BigInt(width - range.length)
  return value >> shift === range.prefix >> shift
}

function lookup(ranges: readonly CompiledRange[], value: bigint, width: number): CompiledRange | undefined {
  let best: CompiledRange | undefined
  for (const range of ranges) {
    if (contains(range, value, width) && (best === undefined || range.length > best.length)) best = range
  }
  return best
}

export function isGloballyReachableIp(ip: ParsedIp): boolean {
  if (ip.version === 4) return lookup(COMPILED_V4, ip.value, 32)?.globallyReachable ?? true
  if (ip.value >> 32n === IPV4_MAPPED_HIGH_BITS) {
    return isGloballyReachableIp({version: 4, value: ip.value & 0xff_ff_ff_ffn})
  }
  const special = lookup(COMPILED_V6, ip.value, 128)
  if (special !== undefined) return special.globallyReachable
  return contains(GLOBAL_UNICAST_V6, ip.value, 128)
}

/** `undefined` when `text` is not an IP address; otherwise whether it is globally reachable. */
export function isGloballyReachable(text: string): boolean | undefined {
  const ip = parseIp(text)
  return ip === undefined ? undefined : isGloballyReachableIp(ip)
}
