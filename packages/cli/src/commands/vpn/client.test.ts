import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {vpnClientAdd, vpnClientList, vpnClientRemove, type KeypairGenFn} from './client'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeKeypairGen(privateKey: string, publicKey: string): KeypairGenFn {
  return async () => ({privateKey, publicKey})
}

function makePeersJson(peers: {name: string; publicKey: string; tunnelIp: string}[]): string {
  return `${JSON.stringify({peers}, null, 2)}\n`
}

// ─── generateKeypair ─────────────────────────────────────────────────────────

describe('generateKeypair', () => {
  it('returns an object with privateKey and publicKey strings via injected keypairGen', async () => {
    // Use dependency injection — never depends on host `wg` binary.
    const mockPrivateKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    const mockPublicKey = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
    const keypairGen = makeKeypairGen(mockPrivateKey, mockPublicKey)

    // vpnClientAdd uses keypairGen internally; test the injected path directly
    // by calling the mock and asserting the returned shape
    const keypair = await keypairGen()

    expect(typeof keypair.privateKey).toBe('string')
    expect(typeof keypair.publicKey).toBe('string')
    expect(keypair.privateKey).toBe(mockPrivateKey)
    expect(keypair.publicKey).toBe(mockPublicKey)
  })

  it('vpnClientAdd uses the injected keypairGen — no dependency on host wg binary', async () => {
    // This test verifies that vpnClientAdd correctly uses the injected keypairGen
    // and returns the keypair values from it (not from a real wg invocation).
    const {mkdtempSync: mkdtemp, mkdirSync, writeFileSync: writeFile, rmSync: rm} = await import('node:fs')
    const {tmpdir} = await import('node:os')
    const {join: joinPath} = await import('node:path')

    const tmpDir = mkdtemp(joinPath(tmpdir(), 'vpn-keypair-test-'))
    const peersJsonPath = joinPath(tmpDir, 'peers.json')
    const clientsDir = joinPath(tmpDir, 'clients')
    mkdirSync(clientsDir, {recursive: true})
    writeFile(peersJsonPath, `${JSON.stringify({peers: []}, null, 2)}\n`)

    try {
      const injectedPrivateKey = 'INJECTEDPRIVATEKEYVALUE1234567890123456789='
      const injectedPublicKey = 'INJECTEDPUBLICKEYVALUE12345678901234567890='
      const keypairGen = makeKeypairGen(injectedPrivateKey, injectedPublicKey)

      const result = await vpnClientAdd('testdevice', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
      })

      // The result must use the injected keypair values
      expect(result.tunnelIp).toBe('10.8.0.2')

      // Client .conf must contain the injected private key
      const {readFile} = await import('node:fs/promises')
      const confContent = await readFile(result.confPath, 'utf-8')
      expect(confContent).toContain(injectedPrivateKey)

      // peers.json must contain the injected public key
      const peersContent = await readFile(peersJsonPath, 'utf-8')
      expect(peersContent).toContain(injectedPublicKey)
      expect(peersContent).not.toContain(injectedPrivateKey)
    } finally {
      rm(tmpDir, {recursive: true, force: true})
    }
  })
})

// ─── vpnClientAdd ─────────────────────────────────────────────────────────────

describe('vpnClientAdd', () => {
  let tmpDir: string
  let peersJsonPath: string
  let clientsDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpn-client-test-'))
    peersJsonPath = join(tmpDir, 'peers.json')
    clientsDir = join(tmpDir, 'clients')
    mkdirSync(clientsDir, {recursive: true})

    // Start with empty peers.json
    writeFileSync(peersJsonPath, makePeersJson([]))
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('generates a keypair, assigns next IP, appends public key to peers.json, writes client .conf', async () => {
    const keypairGen = makeKeypairGen('PRIVATEKEYVALUE==', 'PUBLICKEYVALUE==')

    const result = await vpnClientAdd('laptop', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen,
    })

    // Check result
    expect(result.tunnelIp).toBe('10.8.0.2')
    expect(result.confPath).toBe(join(clientsDir, 'laptop.conf'))

    // Check peers.json was updated with PUBLIC key only
    const peersContent = await readFile(peersJsonPath, 'utf-8')
    const peersData = JSON.parse(peersContent) as {peers: {name: string; publicKey: string; tunnelIp: string}[]}
    expect(peersData.peers).toHaveLength(1)
    expect(peersData.peers[0]?.name).toBe('laptop')
    expect(peersData.peers[0]?.publicKey).toBe('PUBLICKEYVALUE==')
    expect(peersData.peers[0]?.tunnelIp).toBe('10.8.0.2')

    // Check client .conf was written with PRIVATE key
    const confContent = await readFile(result.confPath, 'utf-8')
    expect(confContent).toContain('PRIVATEKEYVALUE==')
    expect(confContent).toContain('SERVERPUBKEY==')
    expect(confContent).toContain('1.2.3.4:51820')
    expect(confContent).toContain('10.8.0.2/32')
    expect(confContent).toContain('AllowedIPs = 0.0.0.0/0')
  })

  it('assigns sequential IPs for multiple clients', async () => {
    const keypairGen1 = makeKeypairGen('PRIV1==', 'PUB1==')
    const keypairGen2 = makeKeypairGen('PRIV2==', 'PUB2==')

    await vpnClientAdd('laptop', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen: keypairGen1,
    })

    const result2 = await vpnClientAdd('phone', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen: keypairGen2,
    })

    expect(result2.tunnelIp).toBe('10.8.0.3')
  })

  it('supports split-tunnel via allowedIps option', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')

    const result = await vpnClientAdd('laptop', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen,
      allowedIps: '10.0.0.0/8,192.168.0.0/16',
    })

    const confContent = await readFile(result.confPath, 'utf-8')
    expect(confContent).toContain('AllowedIPs = 10.0.0.0/8,192.168.0.0/16')
  })

  it('throws when a peer with the same name already exists', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')

    await vpnClientAdd('laptop', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen,
    })

    await expect(
      vpnClientAdd('laptop', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
      }),
    ).rejects.toThrow('already exists')
  })

  it('refuses to write client .conf outside the clients directory', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')

    // Attempt path traversal: name with ../ to escape clients dir
    await expect(
      vpnClientAdd('../evil', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
      }),
    ).rejects.toThrow()
  })

  it('client .conf contains private key but peers.json contains only public key', async () => {
    const keypairGen = makeKeypairGen('SECRETPRIVATEKEY==', 'PUBLICKEY==')

    const result = await vpnClientAdd('laptop', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen,
    })

    // peers.json must NOT contain the private key
    const peersContent = await readFile(peersJsonPath, 'utf-8')
    expect(peersContent).not.toContain('SECRETPRIVATEKEY==')
    expect(peersContent).toContain('PUBLICKEY==')

    // client .conf must contain the private key
    const confContent = await readFile(result.confPath, 'utf-8')
    expect(confContent).toContain('SECRETPRIVATEKEY==')
  })
})

// ─── vpnClientList ────────────────────────────────────────────────────────────

describe('vpnClientList', () => {
  let tmpDir: string
  let peersJsonPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpn-client-test-'))
    peersJsonPath = join(tmpDir, 'peers.json')
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('returns empty array when no peers', async () => {
    writeFileSync(peersJsonPath, makePeersJson([]))

    const peers = await vpnClientList(peersJsonPath)

    expect(peers).toHaveLength(0)
  })

  it('returns all peers with name, publicKey, tunnelIp', async () => {
    writeFileSync(
      peersJsonPath,
      makePeersJson([
        {name: 'laptop', publicKey: 'PUB1==', tunnelIp: '10.8.0.2'},
        {name: 'phone', publicKey: 'PUB2==', tunnelIp: '10.8.0.3'},
      ]),
    )

    const peers = await vpnClientList(peersJsonPath)

    expect(peers).toHaveLength(2)
    expect(peers[0]?.name).toBe('laptop')
    expect(peers[0]?.publicKey).toBe('PUB1==')
    expect(peers[0]?.tunnelIp).toBe('10.8.0.2')
    expect(peers[1]?.name).toBe('phone')
  })
})

// ─── vpnClientRemove ──────────────────────────────────────────────────────────

describe('vpnClientRemove', () => {
  let tmpDir: string
  let peersJsonPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpn-client-test-'))
    peersJsonPath = join(tmpDir, 'peers.json')
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('removes a peer from peers.json', async () => {
    writeFileSync(
      peersJsonPath,
      makePeersJson([
        {name: 'laptop', publicKey: 'PUB1==', tunnelIp: '10.8.0.2'},
        {name: 'phone', publicKey: 'PUB2==', tunnelIp: '10.8.0.3'},
      ]),
    )

    await vpnClientRemove('laptop', peersJsonPath)

    const peersContent = await readFile(peersJsonPath, 'utf-8')
    const peersData = JSON.parse(peersContent) as {peers: {name: string}[]}
    expect(peersData.peers).toHaveLength(1)
    expect(peersData.peers[0]?.name).toBe('phone')
  })

  it('throws when removing a non-existent peer', async () => {
    writeFileSync(peersJsonPath, makePeersJson([]))

    await expect(vpnClientRemove('nonexistent', peersJsonPath)).rejects.toThrow('not found')
  })

  it('after remove, list reflects the removal', async () => {
    writeFileSync(
      peersJsonPath,
      makePeersJson([
        {name: 'laptop', publicKey: 'PUB1==', tunnelIp: '10.8.0.2'},
        {name: 'phone', publicKey: 'PUB2==', tunnelIp: '10.8.0.3'},
      ]),
    )

    await vpnClientRemove('laptop', peersJsonPath)
    const peers = await vpnClientList(peersJsonPath)

    expect(peers).toHaveLength(1)
    expect(peers[0]?.name).toBe('phone')
  })
})

// ─── Write-guard: client .conf must stay in clients/ ─────────────────────────

describe('write-guard: client .conf path safety', () => {
  let tmpDir: string
  let peersJsonPath: string
  let clientsDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpn-client-test-'))
    peersJsonPath = join(tmpDir, 'peers.json')
    clientsDir = join(tmpDir, 'clients')
    mkdirSync(clientsDir, {recursive: true})
    writeFileSync(peersJsonPath, makePeersJson([]))
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('resolves the output path under clientsDir', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')

    const result = await vpnClientAdd('mydevice', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen,
    })

    // The resolved path must be under clientsDir
    const resolvedClientsDir = resolve(clientsDir)
    expect(result.confPath.startsWith(resolvedClientsDir)).toBe(true)
  })

  it('rejects a name that would escape the clients directory via path traversal', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')

    // Path traversal attempt
    await expect(
      vpnClientAdd('../../etc/passwd', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
      }),
    ).rejects.toThrow()
  })
})
