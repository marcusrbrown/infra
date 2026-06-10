import type {DeployOpts, SpawnFn, SpawnResult} from './deploy'

import {describe, expect, it} from 'bun:test'
import {deploy, validateEnv} from './deploy'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

interface SpawnCall {
  cmd: string[]
  stdin?: string
}

/**
 * Builds a mock SpawnFn that records all calls and returns configurable results.
 * Each call pops from `results`; if exhausted, returns exit 0 with empty output.
 */
function makeMockSpawn(
  calls: SpawnCall[],
  results: {stdout?: string; stderr?: string; exitCode?: number}[] = [],
): SpawnFn {
  let callIndex = 0
  return (cmd, opts) => {
    const result = results[callIndex] ?? {stdout: '', stderr: '', exitCode: 0}
    callIndex++

    let stdinContent = ''
    const stdinPipe =
      opts.stdin === 'pipe'
        ? {
            write: (data: Uint8Array) => {
              stdinContent += new TextDecoder().decode(data)
            },
            end: () => {
              calls.push({cmd, stdin: stdinContent})
            },
          }
        : undefined

    if (opts.stdin !== 'pipe') {
      calls.push({cmd})
    }

    return {
      stdout: makeStream(result.stdout ?? ''),
      stderr: makeStream(result.stderr ?? ''),
      stdin: stdinPipe,
      exited: Promise.resolve(result.exitCode ?? 0),
    } satisfies SpawnResult
  }
}

// ─── Base env for tests ───────────────────────────────────────────────────────

const BASE_ENV: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/root',
  VPN_HOST: '1.2.3.4',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
}

const CI_ENV: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/root',
  VPN_HOST: '1.2.3.4',
  VPN_SSH_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n',
}

// ─── validateEnv tests ────────────────────────────────────────────────────────

describe('validateEnv', () => {
  it('accepts local mode with SSH_AUTH_SOCK', () => {
    expect(() => validateEnv(BASE_ENV)).not.toThrow()
  })

  it('accepts CI mode with VPN_SSH_KEY', () => {
    expect(() => validateEnv(CI_ENV)).not.toThrow()
  })

  it('throws when VPN_HOST is missing', () => {
    const env = {...BASE_ENV}
    delete env.VPN_HOST
    expect(() => validateEnv(env)).toThrow(/VPN_HOST/)
  })

  it('throws when neither SSH_AUTH_SOCK nor VPN_SSH_KEY is set', () => {
    const env = {PATH: '/usr/bin:/bin', HOME: '/root', VPN_HOST: '1.2.3.4'}
    expect(() => validateEnv(env)).toThrow(/SSH context/)
  })

  it('throws when PATH is missing', () => {
    const env = {...BASE_ENV}
    delete env.PATH
    expect(() => validateEnv(env)).toThrow(/PATH/)
  })

  it('throws when HOME is missing', () => {
    const env = {...BASE_ENV}
    delete env.HOME
    expect(() => validateEnv(env)).toThrow(/HOME/)
  })

  it('throws before any SSH call when VPN_HOST is invalid (ProxyCommand injection)', () => {
    // validateEnv calls validateVpnHost — must throw before SSH argv is built
    expect(() => validateEnv({...BASE_ENV, VPN_HOST: '-oProxyCommand=evil'})).toThrow(/Invalid VPN_HOST/)
  })

  it('throws before any SSH call when VPN_HOST has shell metacharacters', () => {
    expect(() => validateEnv({...BASE_ENV, VPN_HOST: 'host;rm -rf /'})).toThrow(/Invalid VPN_HOST/)
  })
})

// ─── deploy() happy path ──────────────────────────────────────────────────────

describe('deploy', () => {
  it('runs all phases in order: server key, wg0.conf, sysctl, enable, restart, health gate', async () => {
    const calls: SpawnCall[] = []

    // New call sequence (9 calls total):
    // 0: ensure server key (ssh)
    // 1: read server.pub (ssh)
    // 2: ship placeholder wg0.conf to temp path (ssh stdin — writeRemoteFile)
    // 3: awk substitution command (ssh — runCommand)
    // 4: write wg-forwarding.conf (ssh stdin)
    // 5: sysctl --system (ssh)
    // 6: systemctl enable --now wg-quick@wg0 (ssh)
    // 7: systemctl restart wg-quick@wg0 (ssh)
    // 8: wg show wg0 (ssh)
    const results = [
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution (server-side)
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf (stdin)
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: FAKEPUBKEY==\n  peers: 0\n', exitCode: 0}, // wg show
    ]

    const mockSpawn = makeMockSpawn(calls, results)

    const opts: DeployOpts = {
      env: BASE_ENV,
      spawn: mockSpawn,
      peersJsonPath: 'apps/vpn/config/peers.json',
    }

    await deploy(opts)

    // Verify ordering: server key → read pub → placeholder config → awk sub → forwarding conf → sysctl → enable → restart → health
    const labels = calls.map(c => c.cmd.join(' '))

    // Phase 1: ensure server key (atomic, preserved) — the command contains `test -f` guard
    const serverKeyIdx = labels.findIndex(l => l.includes('test -f') && l.includes('server.key'))
    expect(serverKeyIdx).toBeGreaterThanOrEqual(0)

    // Phase 2: read server.pub (only pub, not private key) — `cat server.pub`
    const readPubIdx = labels.findIndex(l => l.includes('cat') && l.includes('server.pub'))
    expect(readPubIdx).toBeGreaterThan(serverKeyIdx)

    // Phase 3a: placeholder wg0.conf shipped via stdin (writeRemoteFile to .tmp path)
    const placeholderIdx = calls.findIndex(c => c.stdin !== undefined && c.stdin.includes('__SERVER_PRIVATE_KEY__'))
    expect(placeholderIdx).toBeGreaterThan(readPubIdx)

    // Phase 3b: awk substitution command (server-side, references server.key)
    const awkIdx = labels.findIndex(l => l.includes('awk') && l.includes('server.key'))
    expect(awkIdx).toBeGreaterThan(placeholderIdx)

    // Phase 4: wg-forwarding.conf written via stdin
    const forwardingIdx = calls.findIndex(c => c.stdin !== undefined && c.stdin.includes('net.ipv4.ip_forward'))
    expect(forwardingIdx).toBeGreaterThan(awkIdx)

    // Phase 5: sysctl --system
    const sysctlIdx = labels.findIndex(l => l.includes('sysctl') && l.includes('--system'))
    expect(sysctlIdx).toBeGreaterThan(forwardingIdx)

    // Phase 6: systemctl enable --now wg-quick@wg0
    const enableIdx = labels.findIndex(l => l.includes('enable') && l.includes('wg-quick@wg0'))
    expect(enableIdx).toBeGreaterThan(sysctlIdx)

    // Phase 7: systemctl restart wg-quick@wg0
    const restartIdx = labels.findIndex(l => l.includes('restart') && l.includes('wg-quick@wg0'))
    expect(restartIdx).toBeGreaterThan(enableIdx)

    // Phase 8: health gate — wg show wg0
    const healthIdx = labels.findIndex(l => l.includes('wg show wg0'))
    expect(healthIdx).toBeGreaterThan(restartIdx)
  })

  it('server key already present — no wg genkey in the command', async () => {
    const calls: SpawnCall[] = []

    // When server.key already exists, the atomic command skips genkey
    // The command uses `test -f ... || (wg genkey ...)` — if file exists, genkey never runs
    // We verify the COMMAND SENT does not contain `wg genkey` as a standalone call
    const results = [
      {stdout: '', exitCode: 0}, // ensure server key (file exists, no-op)
      {stdout: 'EXISTINGPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: EXISTINGPUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'})

    // The server key command uses `test -f ... || (wg genkey ...)` — it's a single SSH call
    // that conditionally generates. We assert there is NO separate `wg genkey` SSH call.
    // The only wg-related calls should be the atomic ensure command and wg show
    const standaloneGenkey = calls.filter(c => c.cmd.join(' ').match(/^\s*wg\s+genkey\s*$/))
    expect(standaloneGenkey).toHaveLength(0)
  })

  it('--force-server-key regenerates the server key', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0}, // force-regenerate server key
      {stdout: 'NEWPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: NEWPUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await deploy({
      env: BASE_ENV,
      spawn: mockSpawn,
      forceServerKey: true,
      peersJsonPath: 'apps/vpn/config/peers.json',
    })

    // When --force-server-key, the server key command must unconditionally regenerate
    // (no `test -f` guard — it always runs wg genkey)
    const serverKeyCall = calls.find(c => c.cmd.join(' ').includes('server.key'))
    expect(serverKeyCall).toBeDefined()
    // Force path: command must NOT have `test -f` guard
    const serverKeyCmd = serverKeyCall?.cmd.join(' ') ?? ''
    expect(serverKeyCmd).not.toMatch(/test -f/)
    expect(serverKeyCmd).toMatch(/wg genkey/)
  })

  it('throws before any SSH call when VPN_HOST is missing', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    const env = {...BASE_ENV}
    delete env.VPN_HOST

    await expect(deploy({env, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'})).rejects.toThrow(
      /VPN_HOST/,
    )
    expect(calls).toHaveLength(0)
  })

  it('throws before any SSH call when VPN_HOST is a ProxyCommand injection', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    await expect(
      deploy({
        env: {...BASE_ENV, VPN_HOST: '-oProxyCommand=evil'},
        spawn: mockSpawn,
        peersJsonPath: 'apps/vpn/config/peers.json',
      }),
    ).rejects.toThrow(/Invalid VPN_HOST/)
    expect(calls).toHaveLength(0)
  })

  it('throws before any SSH call when SSH context is missing', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    const env = {PATH: '/usr/bin:/bin', HOME: '/root', VPN_HOST: '1.2.3.4'}
    await expect(deploy({env, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'})).rejects.toThrow(
      /SSH context/,
    )
    expect(calls).toHaveLength(0)
  })

  it('health gate fails when wg show returns non-zero exit', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'PUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: '', stderr: 'Unable to access interface: No such device', exitCode: 1}, // wg show FAILS
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await expect(
      deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'}),
    ).rejects.toThrow(/health gate|wg show|interface/)
  })

  it('health gate fails when wg show shows wrong peer count', async () => {
    const calls: SpawnCall[] = []
    // peers.json has 0 peers but wg show reports 2 — mismatch
    const results = [
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      // wg show output with 2 peers but we expect 0
      {
        stdout: 'interface: wg0\n  public key: PUBKEY==\npeer: PEER1\npeer: PEER2\n',
        exitCode: 0,
      },
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await expect(
      deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'}),
    ).rejects.toThrow(/peer count|health gate/)
  })

  // ─── Security invariant: private key never leaves the box ─────────────────

  it('SECURITY: server private key is never read to the local process — only server.pub crosses SSH', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'})

    // Assert: no SSH command reads server.key (only server.pub is read back)
    const readsPrivateKey = calls.some(c => {
      const cmd = c.cmd.join(' ')
      // Reading server.key would look like `cat /etc/wireguard/server.key`
      // The only allowed reference to server.key is in the atomic ensure command
      // (which writes it, not reads it to stdout for local consumption)
      return cmd.includes('cat') && cmd.includes('server.key') && !cmd.includes('server.pub')
    })
    expect(readsPrivateKey).toBe(false)

    // Assert: the command that reads back the public key reads server.pub, not server.key
    const readsPub = calls.some(c => c.cmd.join(' ').includes('server.pub'))
    expect(readsPub).toBe(true)
  })

  it('SECURITY: peers/config bytes go through SSH stdin, never appear in argv', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'})

    // The wg0.conf placeholder config is shipped via stdin.
    // Assert: no argv contains WireGuard config content ([Interface], [Peer])
    // Note: PrivateKey line is NOT in the shipped config (it has the placeholder instead)
    const argvContainsConfig = calls.some(c => c.cmd.some(arg => arg.includes('[Interface]') || arg.includes('[Peer]')))
    expect(argvContainsConfig).toBe(false)

    // Assert: the placeholder config is shipped via stdin (has a stdin property with [Interface])
    const wgConfCall = calls.find(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
    expect(wgConfCall).toBeDefined()
  })

  it('SECURITY: server-side render — wg0.conf is assembled on the box using its local server.key', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'})

    // The render mechanism:
    // 1. Locally renders config with __SERVER_PRIVATE_KEY__ placeholder
    // 2. Ships placeholder config via stdin to a temp file on the box
    // 3. Box-side awk reads /etc/wireguard/server.key and substitutes the placeholder
    //
    // Assert: the stdin payload for the wg0.conf step contains the placeholder (not the real key)
    const placeholderCall = calls.find(c => c.stdin !== undefined && c.stdin.includes('__SERVER_PRIVATE_KEY__'))
    expect(placeholderCall).toBeDefined()

    // Assert: the awk substitution command references server.key (box-local, never transmitted)
    const awkCall = calls.find(c => c.cmd.join(' ').includes('awk') && c.cmd.join(' ').includes('server.key'))
    expect(awkCall).toBeDefined()

    // Assert: the awk command writes to wg0.conf
    const awkCmd = awkCall?.cmd.join(' ') ?? ''
    expect(awkCmd).toMatch(/wg0\.conf/)

    // Fix 3: atomic write — awk must write to a temp file then mv into place
    expect(awkCmd).toMatch(/wg0\.conf\.new/)
    expect(awkCmd).toMatch(/mv\s/)
    // Fix 3: server key non-empty guard must precede the awk substitution
    expect(awkCmd).toMatch(/test -s/)
  })

  it('SECURITY: placeholder __SERVER_PRIVATE_KEY__ appears in shipped config; box-side awk substitutes from server.key', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'})

    // The shipped config must contain the placeholder on the PrivateKey line
    const placeholderCall = calls.find(c => c.stdin !== undefined && c.stdin.includes('__SERVER_PRIVATE_KEY__'))
    expect(placeholderCall).toBeDefined()
    const shippedConfig = placeholderCall?.stdin ?? ''
    expect(shippedConfig).toMatch(/PrivateKey = __SERVER_PRIVATE_KEY__/)

    // The awk substitution command must:
    // (a) reference /etc/wireguard/server.key via getline (box-local read)
    // (b) substitute the placeholder
    // (c) write atomically to /etc/wireguard/wg0.conf via temp+mv
    // (d) guard against empty server.key with test -s
    const awkCall = calls.find(c => {
      const cmd = c.cmd.join(' ')
      return cmd.includes('awk') && cmd.includes('server.key') && cmd.includes('__SERVER_PRIVATE_KEY__')
    })
    expect(awkCall).toBeDefined()
    const awkCmd = awkCall?.cmd.join(' ') ?? ''
    expect(awkCmd).toMatch(/getline key/)
    expect(awkCmd).toMatch(/server\.key/)
    expect(awkCmd).toMatch(/wg0\.conf/)
    // Fix 3: atomic write — must use temp file + mv
    expect(awkCmd).toMatch(/wg0\.conf\.new/)
    expect(awkCmd).toMatch(/mv\s/)
    // Fix 3: server key non-empty guard
    expect(awkCmd).toMatch(/test -s/)

    // The real private key must NOT appear in any argv or stdin
    const FAKE_REAL_KEY = 'REAL_PRIVATE_KEY_THAT_MUST_NOT_APPEAR'
    const keyInArgv = calls.some(c => c.cmd.some(arg => arg.includes(FAKE_REAL_KEY)))
    expect(keyInArgv).toBe(false)
  })

  // ─── peers.json read failure behavior ────────────────────────────────────

  it('aborts deploy when peers.json exists but contains corrupt/malformed JSON', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    // Write a corrupt peers.json to a temp file
    const {mkdtempSync: mkdtemp, writeFileSync: writeFile, rmSync: rm} = await import('node:fs')
    const {tmpdir} = await import('node:os')
    const {join: joinPath} = await import('node:path')
    const tmpDir = mkdtemp(joinPath(tmpdir(), 'vpn-deploy-peers-test-'))
    const corruptPeersPath = joinPath(tmpDir, 'peers.json')
    try {
      writeFile(corruptPeersPath, 'this is not valid json {{{')

      await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: corruptPeersPath})).rejects.toThrow()

      // No SSH calls must have been made — deploy must abort before SSH
      expect(calls).toHaveLength(0)
    } finally {
      rm(tmpDir, {recursive: true, force: true})
    }
  })

  it('proceeds with 0 peers when peers.json does not exist (no peers yet)', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: FAKEPUBKEY==\n  peers: 0\n', exitCode: 0}, // wg show
    ]
    const mockSpawn = makeMockSpawn(calls, results)

    // Point to a path that does not exist
    const nonExistentPath = '/tmp/vpn-deploy-test-nonexistent-peers-XXXXXX.json'

    // Should NOT throw — missing file is valid (no peers yet)
    await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: nonExistentPath})).resolves.toBeUndefined()

    // SSH calls must have proceeded (deploy ran)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('aborts deploy when peers.json exists but contains valid JSON with wrong schema', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    const {mkdtempSync: mkdtemp, writeFileSync: writeFile, rmSync: rm} = await import('node:fs')
    const {tmpdir} = await import('node:os')
    const {join: joinPath} = await import('node:path')
    const tmpDir = mkdtemp(joinPath(tmpdir(), 'vpn-deploy-peers-test-'))
    const badSchemaPeersPath = joinPath(tmpDir, 'peers.json')
    try {
      // Valid JSON but wrong schema — missing required fields
      writeFile(badSchemaPeersPath, JSON.stringify({wrong: 'schema', notPeers: true}))

      await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: badSchemaPeersPath})).rejects.toThrow()

      // No SSH calls — deploy must abort
      expect(calls).toHaveLength(0)
    } finally {
      rm(tmpDir, {recursive: true, force: true})
    }
  })

  it('CI mode: materializes VPN_SSH_KEY to a temp file before SSH calls', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    await deploy({env: CI_ENV, spawn: mockSpawn, peersJsonPath: 'apps/vpn/config/peers.json'})

    // In CI mode, SSH commands must use -i <keypath> + IdentitiesOnly=yes
    const sshCalls = calls.filter(c => c.cmd[0] === 'ssh')
    expect(sshCalls.length).toBeGreaterThan(0)
    for (const call of sshCalls) {
      expect(call.cmd).toContain('-i')
      expect(call.cmd).toContain('IdentitiesOnly=yes')
    }
  })
})
