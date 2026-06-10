/// <reference types="bun" />

import {describe, expect, it} from 'bun:test'

import {
  addPeer,
  nextTunnelIp,
  parsePeersJson,
  removePeer,
  renderClientConfig,
  renderServerConfig,
  type Peer,
  type PeersFile,
} from './peers'

// ── renderServerConfig ────────────────────────────────────────────────────────

describe('renderServerConfig', () => {
  const SERVER_PRIVATE_KEY = 'sErVeRpRiVaTeKeY1234567890abcdefghijklmnopqrstuvwxyz='

  it('renders [Interface] block with Address 10.8.0.1/24, ListenPort 51820, and PrivateKey', () => {
    const config = renderServerConfig(SERVER_PRIVATE_KEY, [])

    expect(config).toContain('[Interface]')
    expect(config).toContain('Address = 10.8.0.1/24')
    expect(config).toContain('ListenPort = 51820')
    expect(config).toContain(`PrivateKey = ${SERVER_PRIVATE_KEY}`)
  })

  it('renders PostUp and PostDown iptables MASQUERADE rules', () => {
    const config = renderServerConfig(SERVER_PRIVATE_KEY, [])

    expect(config).toContain('PostUp')
    expect(config).toContain('PostDown')
    expect(config).toContain('MASQUERADE')
    expect(config).toContain('FORWARD')
  })

  it('renders 0 [Peer] blocks when peers list is empty', () => {
    const config = renderServerConfig(SERVER_PRIVATE_KEY, [])

    const peerMatches = config.match(/^\[Peer\]/gm)
    expect(peerMatches).toBeNull()
  })

  it('renders exactly 1 [Peer] block for 1 peer with correct PublicKey and AllowedIPs', () => {
    const peers: Peer[] = [{name: 'laptop', publicKey: 'pUbLiCkEy1==', tunnelIp: '10.8.0.2'}]
    const config = renderServerConfig(SERVER_PRIVATE_KEY, peers)

    const peerMatches = config.match(/^\[Peer\]/gm)
    expect(peerMatches).toHaveLength(1)
    expect(config).toContain('PublicKey = pUbLiCkEy1==')
    expect(config).toContain('AllowedIPs = 10.8.0.2/32')
  })

  it('renders exactly 3 [Peer] blocks for 3 peers with correct PublicKey and AllowedIPs per peer', () => {
    const peers: Peer[] = [
      {name: 'laptop', publicKey: 'pubkey-laptop==', tunnelIp: '10.8.0.2'},
      {name: 'phone', publicKey: 'pubkey-phone==', tunnelIp: '10.8.0.3'},
      {name: 'tablet', publicKey: 'pubkey-tablet==', tunnelIp: '10.8.0.4'},
    ]
    const config = renderServerConfig(SERVER_PRIVATE_KEY, peers)

    const peerMatches = config.match(/^\[Peer\]/gm)
    expect(peerMatches).toHaveLength(3)
    expect(config).toContain('PublicKey = pubkey-laptop==')
    expect(config).toContain('AllowedIPs = 10.8.0.2/32')
    expect(config).toContain('PublicKey = pubkey-phone==')
    expect(config).toContain('AllowedIPs = 10.8.0.3/32')
    expect(config).toContain('PublicKey = pubkey-tablet==')
    expect(config).toContain('AllowedIPs = 10.8.0.4/32')
  })

  it('uses default WAN interface eth0 in PostUp/PostDown when no opts provided', () => {
    const config = renderServerConfig(SERVER_PRIVATE_KEY, [])

    expect(config).toContain('eth0')
  })

  it('uses custom WAN interface when wanInterface opt is provided', () => {
    const config = renderServerConfig(SERVER_PRIVATE_KEY, [], {wanInterface: 'ens5'})

    expect(config).toContain('ens5')
    expect(config).not.toContain('eth0')
  })

  it('rendering is deterministic — same inputs produce identical output', () => {
    const peers: Peer[] = [{name: 'laptop', publicKey: 'pubkey-laptop==', tunnelIp: '10.8.0.2'}]
    const first = renderServerConfig(SERVER_PRIVATE_KEY, peers)
    const second = renderServerConfig(SERVER_PRIVATE_KEY, peers)

    expect(first).toBe(second)
  })

  it('a removed peer does not appear in rendered config', () => {
    const peers: Peer[] = [{name: 'laptop', publicKey: 'pubkey-laptop==', tunnelIp: '10.8.0.2'}]
    const {peers: updatedPeers} = removePeer(peers, 'laptop')
    const config = renderServerConfig(SERVER_PRIVATE_KEY, updatedPeers)

    expect(config).not.toContain('pubkey-laptop==')
    expect(config).not.toContain('10.8.0.2')
    const peerMatches = config.match(/^\[Peer\]/gm)
    expect(peerMatches).toBeNull()
  })
})

// ── renderClientConfig ────────────────────────────────────────────────────────

describe('renderClientConfig', () => {
  const CLIENT_PRIVATE_KEY = 'cLiEnTpRiVaTeKeY1234567890abcdefghijklmnopqrstuvwxyz='
  const SERVER_PUBLIC_KEY = 'sErVeRpUbLiCkEy1234567890abcdefghijklmnopqrstuvwxyz='
  const ENDPOINT = '1.2.3.4'
  const TUNNEL_IP = '10.8.0.2'

  it('renders [Interface] block with PrivateKey and Address tunnelIp/32', () => {
    const config = renderClientConfig({
      clientPrivateKey: CLIENT_PRIVATE_KEY,
      serverPublicKey: SERVER_PUBLIC_KEY,
      endpoint: ENDPOINT,
      tunnelIp: TUNNEL_IP,
    })

    expect(config).toContain('[Interface]')
    expect(config).toContain(`PrivateKey = ${CLIENT_PRIVATE_KEY}`)
    expect(config).toContain(`Address = ${TUNNEL_IP}/32`)
  })

  it('renders [Peer] block with server PublicKey and Endpoint host:51820', () => {
    const config = renderClientConfig({
      clientPrivateKey: CLIENT_PRIVATE_KEY,
      serverPublicKey: SERVER_PUBLIC_KEY,
      endpoint: ENDPOINT,
      tunnelIp: TUNNEL_IP,
    })

    expect(config).toContain('[Peer]')
    expect(config).toContain(`PublicKey = ${SERVER_PUBLIC_KEY}`)
    expect(config).toContain(`Endpoint = ${ENDPOINT}:51820`)
  })

  it('defaults AllowedIPs to 0.0.0.0/0 for full-tunnel when not specified', () => {
    const config = renderClientConfig({
      clientPrivateKey: CLIENT_PRIVATE_KEY,
      serverPublicKey: SERVER_PUBLIC_KEY,
      endpoint: ENDPOINT,
      tunnelIp: TUNNEL_IP,
    })

    expect(config).toContain('AllowedIPs = 0.0.0.0/0')
  })

  it('uses provided allowedIps for split-tunnel configuration', () => {
    const config = renderClientConfig({
      clientPrivateKey: CLIENT_PRIVATE_KEY,
      serverPublicKey: SERVER_PUBLIC_KEY,
      endpoint: ENDPOINT,
      tunnelIp: TUNNEL_IP,
      allowedIps: '10.0.0.0/8,192.168.0.0/16',
    })

    expect(config).toContain('AllowedIPs = 10.0.0.0/8,192.168.0.0/16')
    expect(config).not.toContain('0.0.0.0/0')
  })

  it('rendering is deterministic — same inputs produce identical output', () => {
    const opts = {
      clientPrivateKey: CLIENT_PRIVATE_KEY,
      serverPublicKey: SERVER_PUBLIC_KEY,
      endpoint: ENDPOINT,
      tunnelIp: TUNNEL_IP,
    }
    const first = renderClientConfig(opts)
    const second = renderClientConfig(opts)

    expect(first).toBe(second)
  })
})

// ── nextTunnelIp ──────────────────────────────────────────────────────────────

describe('nextTunnelIp', () => {
  it('returns 10.8.0.2 when peers list is empty (skips .1 reserved for server)', () => {
    expect(nextTunnelIp([])).toBe('10.8.0.2')
  })

  it('returns 10.8.0.3 when .2 is already allocated', () => {
    const peers: Peer[] = [{name: 'laptop', publicKey: 'pk1==', tunnelIp: '10.8.0.2'}]
    expect(nextTunnelIp(peers)).toBe('10.8.0.3')
  })

  it('allocates sequentially for multiple peers', () => {
    const peers: Peer[] = [
      {name: 'laptop', publicKey: 'pk1==', tunnelIp: '10.8.0.2'},
      {name: 'phone', publicKey: 'pk2==', tunnelIp: '10.8.0.3'},
    ]
    expect(nextTunnelIp(peers)).toBe('10.8.0.4')
  })

  it('reuses freed slot after remove — lowest free N >= 2', () => {
    const peers: Peer[] = [
      {name: 'laptop', publicKey: 'pk1==', tunnelIp: '10.8.0.2'},
      {name: 'phone', publicKey: 'pk2==', tunnelIp: '10.8.0.3'},
      {name: 'tablet', publicKey: 'pk3==', tunnelIp: '10.8.0.4'},
    ]
    // Remove the middle peer (.3), next should reuse .3 (lowest free >= 2)
    const {peers: afterRemove} = removePeer(peers, 'phone')
    expect(nextTunnelIp(afterRemove)).toBe('10.8.0.3')
  })

  it('reuses lowest freed slot when first peer is removed', () => {
    const peers: Peer[] = [
      {name: 'laptop', publicKey: 'pk1==', tunnelIp: '10.8.0.2'},
      {name: 'phone', publicKey: 'pk2==', tunnelIp: '10.8.0.3'},
    ]
    const {peers: afterRemove} = removePeer(peers, 'laptop')
    expect(nextTunnelIp(afterRemove)).toBe('10.8.0.2')
  })
})

// ── addPeer ───────────────────────────────────────────────────────────────────

describe('addPeer', () => {
  it('adds a peer with the next available tunnel IP', () => {
    const {peers, tunnelIp} = addPeer([], {name: 'laptop', publicKey: 'pk-laptop=='})

    expect(peers).toHaveLength(1)
    expect(peers[0]).toEqual({name: 'laptop', publicKey: 'pk-laptop==', tunnelIp: '10.8.0.2'})
    expect(tunnelIp).toBe('10.8.0.2')
  })

  it('assigns sequential IPs for multiple adds', () => {
    const {peers: peers1} = addPeer([], {name: 'laptop', publicKey: 'pk1=='})
    const {peers: peers2, tunnelIp} = addPeer(peers1, {name: 'phone', publicKey: 'pk2=='})

    expect(peers2).toHaveLength(2)
    expect(tunnelIp).toBe('10.8.0.3')
  })

  it('throws when adding a peer with a duplicate name', () => {
    const {peers} = addPeer([], {name: 'laptop', publicKey: 'pk1=='})

    expect(() => addPeer(peers, {name: 'laptop', publicKey: 'pk2=='})).toThrow(/duplicate|already exists/i)
  })

  it('does not mutate the original peers array', () => {
    const original: Peer[] = [{name: 'laptop', publicKey: 'pk1==', tunnelIp: '10.8.0.2'}]
    const originalLength = original.length

    addPeer(original, {name: 'phone', publicKey: 'pk2=='})

    expect(original).toHaveLength(originalLength)
  })
})

// ── removePeer ────────────────────────────────────────────────────────────────

describe('removePeer', () => {
  it('removes a peer by name and returns updated peers', () => {
    const peers: Peer[] = [
      {name: 'laptop', publicKey: 'pk1==', tunnelIp: '10.8.0.2'},
      {name: 'phone', publicKey: 'pk2==', tunnelIp: '10.8.0.3'},
    ]
    const {peers: updated} = removePeer(peers, 'laptop')

    expect(updated).toHaveLength(1)
    expect(updated[0]?.name).toBe('phone')
  })

  it('throws a clear error when removing a non-existent peer', () => {
    const peers: Peer[] = [{name: 'laptop', publicKey: 'pk1==', tunnelIp: '10.8.0.2'}]

    expect(() => removePeer(peers, 'nonexistent')).toThrow(/not found|does not exist/i)
  })

  it('does not mutate the original peers array', () => {
    const original: Peer[] = [
      {name: 'laptop', publicKey: 'pk1==', tunnelIp: '10.8.0.2'},
      {name: 'phone', publicKey: 'pk2==', tunnelIp: '10.8.0.3'},
    ]
    const originalLength = original.length

    removePeer(original, 'laptop')

    expect(original).toHaveLength(originalLength)
  })
})

// ── Zod schema validation (readPeers-equivalent) ─────────────────────────────

describe('parsePeersJson', () => {
  it('throws on malformed JSON shape — wrong top-level type', () => {
    expect(() => parsePeersJson([])).toThrow()
  })

  it('throws when peers array contains an entry missing publicKey', () => {
    expect(() =>
      parsePeersJson({
        peers: [{name: 'laptop', tunnelIp: '10.8.0.2'}],
      }),
    ).toThrow()
  })

  it('throws when peers array contains an entry missing tunnelIp', () => {
    expect(() =>
      parsePeersJson({
        peers: [{name: 'laptop', publicKey: 'pk=='}],
      }),
    ).toThrow()
  })

  it('accepts a valid peers file with empty peers array', () => {
    const result: PeersFile = parsePeersJson({peers: []})
    expect(result.peers).toHaveLength(0)
  })

  it('accepts a valid peers file with one peer', () => {
    const result: PeersFile = parsePeersJson({
      peers: [{name: 'laptop', publicKey: 'pk==', tunnelIp: '10.8.0.2'}],
    })
    expect(result.peers).toHaveLength(1)
    expect(result.peers[0]?.name).toBe('laptop')
  })
})
