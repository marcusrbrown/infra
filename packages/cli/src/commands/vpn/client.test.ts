import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {readFile, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {vpnClientAdd, vpnClientList, vpnClientRemove, type KeypairGenFn, type SpawnFn} from './client'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeKeypairGen(privateKey: string, publicKey: string): KeypairGenFn {
  return async () => ({privateKey, publicKey})
}

function makePeersJson(peers: {name: string; publicKey: string; tunnelIp: string}[]): string {
  return `${JSON.stringify({peers}, null, 2)}\n`
}

/**
 * Inert spawn stub — never touches real processes.
 * Returns a mock proc: stdin {write, end}, exited resolves 0, empty stdout/stderr.
 * Inject this into every call that doesn't explicitly test sync behavior.
 */
function makeNoopSpawnFn(): SpawnFn {
  return (_cmd, _opts) => ({
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(''))
        c.close()
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(''))
        c.close()
      },
    }),
    stdin: {
      write: (_data: Uint8Array) => {},
      end: () => {},
    },
    exited: Promise.resolve(0),
  })
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
        spawnFn: makeNoopSpawnFn(),
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
      spawnFn: makeNoopSpawnFn(),
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
      spawnFn: makeNoopSpawnFn(),
    })

    const result2 = await vpnClientAdd('phone', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen: keypairGen2,
      spawnFn: makeNoopSpawnFn(),
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
      spawnFn: makeNoopSpawnFn(),
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
      spawnFn: makeNoopSpawnFn(),
    })

    await expect(
      vpnClientAdd('laptop', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
        spawnFn: makeNoopSpawnFn(),
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
        spawnFn: makeNoopSpawnFn(),
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
      spawnFn: makeNoopSpawnFn(),
    })

    // peers.json must NOT contain the private key
    const peersContent = await readFile(peersJsonPath, 'utf-8')
    expect(peersContent).not.toContain('SECRETPRIVATEKEY==')
    expect(peersContent).toContain('PUBLICKEY==')

    // client .conf must contain the private key
    const confContent = await readFile(result.confPath, 'utf-8')
    expect(confContent).toContain('SECRETPRIVATEKEY==')
  })

  // Fix #2: ENOENT bootstrap on fresh checkout
  it('succeeds on fresh checkout (no peers.json) — creates first peer', async () => {
    // Do NOT write peers.json — simulate fresh checkout
    const freshDir = mkdtempSync(join(tmpdir(), 'vpn-fresh-test-'))
    const freshPeersJsonPath = join(freshDir, 'peers.json')
    const freshClientsDir = join(freshDir, 'clients')
    mkdirSync(freshClientsDir, {recursive: true})

    try {
      const keypairGen = makeKeypairGen('PRIV==', 'PUB==')
      const result = await vpnClientAdd('firstpeer', {
        peersJsonPath: freshPeersJsonPath,
        clientsDir: freshClientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
        spawnFn: makeNoopSpawnFn(),
      })

      expect(result.tunnelIp).toBe('10.8.0.2')

      // peers.json must now exist with the new peer
      const peersContent = await readFile(freshPeersJsonPath, 'utf-8')
      const peersData = JSON.parse(peersContent) as {peers: {name: string}[]}
      expect(peersData.peers).toHaveLength(1)
      expect(peersData.peers[0]?.name).toBe('firstpeer')

      // client .conf must exist with private key
      const confContent = await readFile(result.confPath, 'utf-8')
      expect(confContent).toContain('PRIV==')
    } finally {
      rmSync(freshDir, {recursive: true, force: true})
    }
  })

  // Fix #4: write client .conf BEFORE gh sync
  it('client .conf exists even when spawnFn throws (conf written before sync)', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')
    const throwingSpawnFn: SpawnFn = () => {
      throw new Error('gh not found')
    }

    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
    }

    try {
      const result = await vpnClientAdd('laptop', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
        spawnFn: throwingSpawnFn,
      })

      // .conf must exist with the private key
      const confContent = await readFile(result.confPath, 'utf-8')
      expect(confContent).toContain('PRIV==')

      // A warning must have been printed (not a throw)
      const allWarnings = warnMessages.join('\n')
      expect(allWarnings).toMatch(/VPN_PEERS|stale|warning/i)
    } finally {
      console.warn = originalWarn
    }
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

  // Fix #2: list on fresh checkout (no peers.json) returns empty
  it('returns empty array when peers.json does not exist (fresh checkout)', async () => {
    // Do NOT write peers.json
    const peers = await vpnClientList(peersJsonPath)
    expect(peers).toHaveLength(0)
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

    await vpnClientRemove('laptop', peersJsonPath, {spawnFn: makeNoopSpawnFn()})

    const peersContent = await readFile(peersJsonPath, 'utf-8')
    const peersData = JSON.parse(peersContent) as {peers: {name: string}[]}
    expect(peersData.peers).toHaveLength(1)
    expect(peersData.peers[0]?.name).toBe('phone')
  })

  it('throws when removing a non-existent peer', async () => {
    writeFileSync(peersJsonPath, makePeersJson([]))

    await expect(vpnClientRemove('nonexistent', peersJsonPath, {spawnFn: makeNoopSpawnFn()})).rejects.toThrow(
      'not found',
    )
  })

  it('after remove, list reflects the removal', async () => {
    writeFileSync(
      peersJsonPath,
      makePeersJson([
        {name: 'laptop', publicKey: 'PUB1==', tunnelIp: '10.8.0.2'},
        {name: 'phone', publicKey: 'PUB2==', tunnelIp: '10.8.0.3'},
      ]),
    )

    await vpnClientRemove('laptop', peersJsonPath, {spawnFn: makeNoopSpawnFn()})
    const peers = await vpnClientList(peersJsonPath)

    expect(peers).toHaveLength(1)
    expect(peers[0]?.name).toBe('phone')
  })

  // Fix #2: remove of nonexistent peer on fresh checkout gives not-found error, not ENOENT
  it('throws not-found (not ENOENT) when removing from a nonexistent peers.json', async () => {
    // Do NOT write peers.json — simulate fresh checkout
    await expect(vpnClientRemove('nonexistent', peersJsonPath, {spawnFn: makeNoopSpawnFn()})).rejects.toThrow(
      'not found',
    )
  })
})

// ─── gh secret sync after vpnClientAdd ───────────────────────────────────────

describe('vpnClientAdd: gh secret sync', () => {
  let tmpDir: string
  let peersJsonPath: string
  let clientsDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpn-client-sync-test-'))
    peersJsonPath = join(tmpDir, 'peers.json')
    clientsDir = join(tmpDir, 'clients')
    mkdirSync(clientsDir, {recursive: true})
    writeFileSync(peersJsonPath, makePeersJson([]))
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('spawns gh secret set with roster on STDIN after successful add', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'NEWPUBKEY==')
    const spawnCalls: {cmd: string[]; stdin: string}[] = []

    const mockSpawnFn: SpawnFn = (cmd, _opts) => {
      let stdinContent = ''
      const stdinPipe = {
        write: (data: Uint8Array) => {
          stdinContent += new TextDecoder().decode(data)
        },
        end: () => {
          spawnCalls.push({cmd, stdin: stdinContent})
        },
      }
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(''))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(''))
            c.close()
          },
        }),
        stdin: stdinPipe,
        exited: Promise.resolve(0),
      }
    }

    await vpnClientAdd('newpeer', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen,
      spawnFn: mockSpawnFn,
    })

    // Must have spawned gh secret set
    const ghCall = spawnCalls.find(c => c.cmd.includes('gh') && c.cmd.includes('secret') && c.cmd.includes('set'))
    expect(ghCall).toBeDefined()

    // The new peer's public key must appear in STDIN, not in argv
    expect(ghCall?.stdin).toContain('NEWPUBKEY==')
    const argvContainsPubkey = ghCall?.cmd.some(arg => arg.includes('NEWPUBKEY=='))
    expect(argvContainsPubkey).toBe(false)

    // Must pass --env vpn and --repo marcusrbrown/infra
    expect(ghCall?.cmd).toContain('--env')
    expect(ghCall?.cmd).toContain('vpn')
    expect(ghCall?.cmd).toContain('--repo')
    expect(ghCall?.cmd).toContain('marcusrbrown/infra')
  })

  it('gh failure → command still succeeds, warning printed with remediation', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'NEWPUBKEY==')
    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
    }

    const mockSpawnFn: SpawnFn = (_cmd, _opts) => {
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(''))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('auth error'))
            c.close()
          },
        }),
        stdin: {
          write: (_data: Uint8Array) => {},
          end: () => {},
        },
        exited: Promise.resolve(1), // gh fails
      }
    }

    try {
      // Must NOT throw even though gh fails
      const result = await vpnClientAdd('newpeer', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
        spawnFn: mockSpawnFn,
      })

      // The add itself must succeed
      expect(result.tunnelIp).toBe('10.8.0.2')

      // A warning must have been printed with remediation
      const allWarnings = warnMessages.join('\n')
      expect(allWarnings).toMatch(/VPN_PEERS|stale|warning/i)
      expect(allWarnings).toMatch(/gh secret set/)
    } finally {
      console.warn = originalWarn
    }
  })

  // Fix #3: spawnFn throws synchronously → command still succeeds + warning printed
  it('spawnFn throws synchronously → command still succeeds, warning printed with remediation', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')
    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
    }

    const throwingSpawnFn: SpawnFn = () => {
      throw new Error('ENOENT: gh not found')
    }

    try {
      const result = await vpnClientAdd('newpeer', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
        spawnFn: throwingSpawnFn,
      })

      // Command must succeed
      expect(result.tunnelIp).toBe('10.8.0.2')

      // Warning must be printed with remediation
      const allWarnings = warnMessages.join('\n')
      expect(allWarnings).toMatch(/VPN_PEERS|stale|warning/i)
      expect(allWarnings).toMatch(/gh secret set/)
    } finally {
      console.warn = originalWarn
    }
  })

  // Fix #3: timeout — spawnFn whose exited never resolves → warning after timeout
  it('spawnFn whose exited never resolves → warning after timeout (injectable timeoutMs)', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')
    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
    }

    const hangingSpawnFn: SpawnFn = (_cmd, _opts) => ({
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(''))
          c.close()
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(''))
          c.close()
        },
      }),
      stdin: {
        write: (_data: Uint8Array) => {},
        end: () => {},
      },
      // Never resolves
      exited: new Promise<number>(() => {}),
    })

    try {
      // Use a very short timeout (50ms) so the test doesn't hang
      const result = await vpnClientAdd('newpeer', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
        spawnFn: hangingSpawnFn,
        syncTimeoutMs: 50,
      })

      // Command must succeed
      expect(result.tunnelIp).toBe('10.8.0.2')

      // Warning must be printed
      const allWarnings = warnMessages.join('\n')
      expect(allWarnings).toMatch(/VPN_PEERS|stale|warning|timeout/i)
    } finally {
      console.warn = originalWarn
    }
  })

  // Fix #5: remediation message must include --repo marcusrbrown/infra
  it('remediation message includes --repo marcusrbrown/infra', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')
    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
    }

    const failingSpawnFn: SpawnFn = (_cmd, _opts) => ({
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(''))
          c.close()
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('error'))
          c.close()
        },
      }),
      stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
      exited: Promise.resolve(1),
    })

    try {
      await vpnClientAdd('newpeer', {
        peersJsonPath,
        clientsDir,
        serverPublicKey: 'SERVERPUBKEY==',
        endpoint: '1.2.3.4',
        keypairGen,
        spawnFn: failingSpawnFn,
      })

      const allWarnings = warnMessages.join('\n')
      expect(allWarnings).toContain('--repo marcusrbrown/infra')
    } finally {
      console.warn = originalWarn
    }
  })
})

// ─── gh secret sync after vpnClientRemove ────────────────────────────────────

describe('vpnClientRemove: gh secret sync', () => {
  let tmpDir: string
  let peersJsonPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpn-client-remove-sync-test-'))
    peersJsonPath = join(tmpDir, 'peers.json')
    writeFileSync(
      peersJsonPath,
      makePeersJson([
        {name: 'laptop', publicKey: 'PUB1==', tunnelIp: '10.8.0.2'},
        {name: 'phone', publicKey: 'PUB2==', tunnelIp: '10.8.0.3'},
      ]),
    )
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('spawns gh secret set with updated roster on STDIN after successful remove', async () => {
    const spawnCalls: {cmd: string[]; stdin: string}[] = []

    const mockSpawnFn: SpawnFn = (cmd, _opts) => {
      let stdinContent = ''
      const stdinPipe = {
        write: (data: Uint8Array) => {
          stdinContent += new TextDecoder().decode(data)
        },
        end: () => {
          spawnCalls.push({cmd, stdin: stdinContent})
        },
      }
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(''))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(''))
            c.close()
          },
        }),
        stdin: stdinPipe,
        exited: Promise.resolve(0),
      }
    }

    await vpnClientRemove('laptop', peersJsonPath, {spawnFn: mockSpawnFn})

    // Must have spawned gh secret set
    const ghCall = spawnCalls.find(c => c.cmd.includes('gh') && c.cmd.includes('secret') && c.cmd.includes('set'))
    expect(ghCall).toBeDefined()

    // Removed peer must NOT appear in STDIN
    expect(ghCall?.stdin).not.toContain('PUB1==')
    // Remaining peer must appear in STDIN
    expect(ghCall?.stdin).toContain('PUB2==')

    // Roster bytes must not appear in argv
    const argvContainsRoster = ghCall?.cmd.some(arg => arg.includes('PUB1==') || arg.includes('PUB2=='))
    expect(argvContainsRoster).toBe(false)
  })

  it('gh failure on remove → command still succeeds, warning printed', async () => {
    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
    }

    const mockSpawnFn: SpawnFn = (_cmd, _opts) => {
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(''))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('network error'))
            c.close()
          },
        }),
        stdin: {
          write: (_data: Uint8Array) => {},
          end: () => {},
        },
        exited: Promise.resolve(1), // gh fails
      }
    }

    try {
      // Must NOT throw even though gh fails
      await vpnClientRemove('laptop', peersJsonPath, {spawnFn: mockSpawnFn})

      // A warning must have been printed with remediation
      const allWarnings = warnMessages.join('\n')
      expect(allWarnings).toMatch(/VPN_PEERS|stale|warning/i)
      expect(allWarnings).toMatch(/gh secret set/)
    } finally {
      console.warn = originalWarn
    }
  })

  // Fix #5: remediation message must include --repo marcusrbrown/infra
  it('remediation message on remove failure includes --repo marcusrbrown/infra', async () => {
    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
    }

    const failingSpawnFn: SpawnFn = (_cmd, _opts) => ({
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(''))
          c.close()
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('error'))
          c.close()
        },
      }),
      stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
      exited: Promise.resolve(1),
    })

    try {
      await vpnClientRemove('laptop', peersJsonPath, {spawnFn: failingSpawnFn})

      const allWarnings = warnMessages.join('\n')
      expect(allWarnings).toContain('--repo marcusrbrown/infra')
    } finally {
      console.warn = originalWarn
    }
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
      spawnFn: makeNoopSpawnFn(),
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
        spawnFn: makeNoopSpawnFn(),
      }),
    ).rejects.toThrow()
  })
})

// ─── client .conf file permissions ───────────────────────────────────────────

describe('vpnClientAdd: client .conf file permissions', () => {
  let tmpDir: string
  let peersJsonPath: string
  let clientsDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpn-client-perm-test-'))
    peersJsonPath = join(tmpDir, 'peers.json')
    clientsDir = join(tmpDir, 'clients')
    mkdirSync(clientsDir, {recursive: true})
    writeFileSync(peersJsonPath, makePeersJson([]))
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('writes client .conf with mode 0o600 (owner read/write only)', async () => {
    const keypairGen = makeKeypairGen('PRIV==', 'PUB==')

    const result = await vpnClientAdd('laptop', {
      peersJsonPath,
      clientsDir,
      serverPublicKey: 'SERVERPUBKEY==',
      endpoint: '1.2.3.4',
      keypairGen,
      spawnFn: makeNoopSpawnFn(),
    })

    const fileStat = await stat(result.confPath)
    const permBits = fileStat.mode & 0o777
    expect(permBits).toBe(0o600)
  })
})
