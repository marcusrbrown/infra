import {describe, expect, it} from 'bun:test'

const composeText = await Bun.file(new URL('docker-compose.yaml', import.meta.url)).text()
const configText = await Bun.file(new URL('config/config.yaml', import.meta.url)).text()

/** Narrow a parsed YAML value to a plain object. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a mapping`)
  }
  return value as Record<string, unknown>
}

const compose = asRecord(Bun.YAML.parse(composeText), 'compose file')
const services = asRecord(compose.services, 'services')
const caddy = asRecord(services.caddy, 'services.caddy')
const proxy = asRecord(services['cli-proxy-api'], 'services.cli-proxy-api')
const config = asRecord(Bun.YAML.parse(configText), 'config.yaml')

const caddyNetworks = asRecord(caddy.networks, 'caddy.networks')
const caddyAddress = asRecord(caddyNetworks.cliproxy, 'caddy.networks.cliproxy').ipv4_address
const ipamEntries = (
  asRecord(asRecord(asRecord(compose.networks, 'networks').cliproxy, 'networks.cliproxy').ipam, 'ipam')
    .config as unknown[]
).map(entry => asRecord(entry, 'ipam.config entry'))
const declaredSubnets = ipamEntries.map(entry => entry.subnet)
const declaredRanges = ipamEntries.map(entry => entry.ip_range)

/** IPv4 dotted quad → unsigned 32-bit integer. */
function ipv4ToInt(address: string): number {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new Error(`not an IPv4 address: ${address}`)
  }
  return octets.reduce((acc, octet) => acc * 256 + octet, 0)
}

/** First and last address of an IPv4 CIDR, as integers. */
function cidrBounds(cidr: string): {first: number; last: number} {
  const [base, prefix] = cidr.split('/')
  if (base === undefined || prefix === undefined) throw new Error(`not a CIDR: ${cidr}`)
  const size = 2 ** (32 - Number(prefix))
  const first = Math.floor(ipv4ToInt(base) / size) * size
  return {first, last: first + size - 1}
}

function inSubnet(address: string, cidr: string): boolean {
  const {first, last} = cidrBounds(cidr)
  const target = ipv4ToInt(address)
  return target >= first && target <= last
}

function cidrWithin(inner: string, outer: string): boolean {
  const a = cidrBounds(inner)
  const b = cidrBounds(outer)
  return a.first >= b.first && a.last <= b.last
}

describe('cliproxy docker compose', () => {
  it('bounds the caddy json-file logs', () => {
    expect(composeText).toMatch(
      /caddy:[\s\S]*?logging:\s+driver: json-file\s+options:\s+max-size: 10m\s+max-file: '3'[\s\S]*?cli-proxy-api:/,
    )
  })

  it('uses the last known linux/amd64-compatible Caddy image', () => {
    expect(composeText).toContain(
      'image: caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
    )
  })
})

describe('cliproxy trusted proxy network', () => {
  it('attaches both services to the cliproxy network so Caddy can resolve cli-proxy-api', () => {
    expect(Object.keys(caddyNetworks)).toEqual(['cliproxy'])
    expect(proxy.networks).toEqual(['cliproxy'])
  })

  it("pins Caddy's address inside the declared cliproxy subnet", () => {
    expect(declaredSubnets).toHaveLength(1)
    expect(typeof caddyAddress).toBe('string')
    expect(inSubnet(String(caddyAddress), String(declaredSubnets[0]))).toBe(true)
  })

  // Docker hands the first free subnet address to the first container started. cli-proxy-api starts
  // before Caddy (depends_on), so without a dynamic range it would take Caddy's pinned address.
  it("keeps dynamic allocation out of Caddy's pinned address with an ip_range inside the subnet", () => {
    expect(declaredRanges).toHaveLength(1)
    const range = declaredRanges[0]
    expect(typeof range).toBe('string')
    expect(cidrWithin(String(range), String(declaredSubnets[0]))).toBe(true)
    expect(inSubnet(String(caddyAddress), String(range))).toBe(false)
  })

  it("trusts exactly Caddy's pinned address in the config template", () => {
    expect(config['trusted-proxies']).toEqual([caddyAddress])
  })
})
