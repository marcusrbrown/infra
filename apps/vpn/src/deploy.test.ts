import type {DeployOpts, SpawnFn, SpawnResult} from './deploy'

import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

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

interface MockResult {
  stdout?: string
  stderr?: string
  exitCode?: number
}

/** Answers memory-hardening commands by their text; return undefined to fall through to the result queue. */
type HardeningResponder = (command: string) => MockResult | undefined

/** Commands owned by the memory-hardening step. They never consume the positional `results` queue. */
const HARDENING_COMMAND = /swapon|swapfile|mkswap|fwupd|fstab/

/** A box with our swap active and persisted, fwupd masked — the steady state on every deploy after the first. */
const settledBox: HardeningResponder = command => {
  if (command.includes('swapon --noheadings')) return {stdout: 'SWAP_OURS\n'}
  if (command.includes('grep') && command.includes('/etc/fstab')) return {stdout: 'FSTAB_PRESENT\n'}
  if (command.includes('systemctl mask')) return {stdout: 'FWUPD_MASKED\n'}
  return {stdout: ''}
}

/**
 * Builds a mock SpawnFn that records all calls and returns configurable results.
 * Each non-hardening call pops from `results`; if exhausted, returns exit 0 with empty output.
 * Hardening commands are answered by `hardening` so the positional queues of the
 * wipe-guard / key / config tests stay independent of the hardening step.
 */
function makeMockSpawn(
  calls: SpawnCall[],
  results: MockResult[] = [],
  hardening: HardeningResponder = settledBox,
): SpawnFn {
  let callIndex = 0
  return (cmd, opts) => {
    const hardeningResult = HARDENING_COMMAND.test(cmd.join(' ')) ? hardening(cmd.join(' ')) : undefined
    const result = hardeningResult ?? results[callIndex++] ?? {stdout: '', stderr: '', exitCode: 0}

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

// ─── Temp peers.json fixture helpers ─────────────────────────────────────────

/**
 * Creates a temp dir with a peers.json containing 0 peers.
 * Returns { dir, peersJsonPath } — caller must rmSync(dir) in finally.
 */
function makeTempPeersDir(peers: {name: string; publicKey: string; tunnelIp: string}[] = []): {
  dir: string
  peersJsonPath: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'vpn-deploy-test-'))
  const peersJsonPath = join(dir, 'peers.json')
  writeFileSync(peersJsonPath, JSON.stringify({peers}))
  return {dir, peersJsonPath}
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

    // New call sequence (11 calls total, 0-peer roster triggers wipe guard):
    // 0: wipe guard: wg show wg0 dump (0 live peers → proceed)
    // 1: ensure server key (ssh)
    // 2: read server.pub (ssh)
    // 3: ip route show default (WAN interface detection)
    // 4: ship placeholder wg0.conf to temp path (ssh stdin — writeRemoteFile)
    // 5: awk substitution command (ssh — runCommand)
    // 6: write wg-forwarding.conf (ssh stdin)
    // 7: sysctl --system (ssh)
    // 8: systemctl enable --now wg-quick@wg0 (ssh)
    // 9: systemctl restart wg-quick@wg0 (ssh)
    // 10: wg show wg0 (ssh)
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (1 line = server only = 0 peers)
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution (server-side)
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf (stdin)
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: FAKEPUBKEY==\n  peers: 0\n', exitCode: 0}, // wg show
    ]

    const mockSpawn = makeMockSpawn(calls, results)

    // Use a temp peers.json with 0 peers — isolated from the real working file
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      const opts: DeployOpts = {
        env: BASE_ENV,
        spawn: mockSpawn,
        peersJsonPath,
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

      // Phase 8: health gate — wg show wg0 (not the wipe guard dump which uses `wg show wg0 dump`)
      const healthIdx = labels.findIndex(l => l.includes('wg show wg0') && !l.includes('wg show wg0 dump'))
      expect(healthIdx).toBeGreaterThan(restartIdx)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('server key already present — no wg genkey in the command', async () => {
    const calls: SpawnCall[] = []

    // When server.key already exists, the atomic command skips genkey
    // The command uses `test -f ... || (wg genkey ...)` — if file exists, genkey never runs
    // We verify the COMMAND SENT does not contain `wg genkey` as a standalone call
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0}, // ensure server key (file exists, no-op)
      {stdout: 'EXISTINGPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: EXISTINGPUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      // The server key command uses `test -f ... || (wg genkey ...)` — it's a single SSH call
      // that conditionally generates. We assert there is NO separate `wg genkey` SSH call.
      // The only wg-related calls should be the atomic ensure command and wg show
      const standaloneGenkey = calls.filter(c => c.cmd.join(' ').match(/^\s*wg\s+genkey\s*$/))
      expect(standaloneGenkey).toHaveLength(0)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('--force-server-key regenerates the server key', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0}, // force-regenerate server key
      {stdout: 'NEWPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: NEWPUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({
        env: BASE_ENV,
        spawn: mockSpawn,
        forceServerKey: true,
        peersJsonPath,
      })

      // When --force-server-key, the server key command must unconditionally regenerate
      // (no `test -f` guard — it always runs wg genkey)
      const serverKeyCall = calls.find(c => c.cmd.join(' ').includes('server.key'))
      expect(serverKeyCall).toBeDefined()
      // Force path: command must NOT have `test -f` guard
      const serverKeyCmd = serverKeyCall?.cmd.join(' ') ?? ''
      expect(serverKeyCmd).not.toMatch(/test -f/)
      expect(serverKeyCmd).toMatch(/wg genkey/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('throws before any SSH call when VPN_HOST is missing', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    const env = {...BASE_ENV}
    delete env.VPN_HOST

    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await expect(deploy({env, spawn: mockSpawn, peersJsonPath})).rejects.toThrow(/VPN_HOST/)
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('throws before any SSH call when VPN_HOST is a ProxyCommand injection', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await expect(
        deploy({
          env: {...BASE_ENV, VPN_HOST: '-oProxyCommand=evil'},
          spawn: mockSpawn,
          peersJsonPath,
        }),
      ).rejects.toThrow(/Invalid VPN_HOST/)
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('throws before any SSH call when SSH context is missing', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    const env = {PATH: '/usr/bin:/bin', HOME: '/root', VPN_HOST: '1.2.3.4'}
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await expect(deploy({env, spawn: mockSpawn, peersJsonPath})).rejects.toThrow(/SSH context/)
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('health gate fails when wg show returns non-zero exit', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'PUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: '', stderr: 'Unable to access interface: No such device', exitCode: 1}, // wg show FAILS
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})).rejects.toThrow(
        /health gate|wg show|interface/,
      )
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('health gate fails when wg show shows wrong peer count', async () => {
    const calls: SpawnCall[] = []
    // peers.json has 0 peers but wg show reports 2 — mismatch
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
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
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})).rejects.toThrow(/peer count|health gate/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  // ─── Security invariant: private key never leaves the box ─────────────────

  it('SECURITY: server private key is never read to the local process — only server.pub crosses SSH', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

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
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('SECURITY: peers/config bytes go through SSH stdin, never appear in argv', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      // The wg0.conf placeholder config is shipped via stdin.
      // Assert: no argv contains WireGuard config content ([Interface], [Peer])
      // Note: PrivateKey line is NOT in the shipped config (it has the placeholder instead)
      const argvContainsConfig = calls.some(c =>
        c.cmd.some(arg => arg.includes('[Interface]') || arg.includes('[Peer]')),
      )
      expect(argvContainsConfig).toBe(false)

      // Assert: the placeholder config is shipped via stdin (has a stdin property with [Interface])
      const wgConfCall = calls.find(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
      expect(wgConfCall).toBeDefined()
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('SECURITY: server-side render — wg0.conf is assembled on the box using its local server.key', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

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
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('SECURITY: placeholder __SERVER_PRIVATE_KEY__ appears in shipped config; box-side awk substitutes from server.key', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

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
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  // ─── peers.json read failure behavior ────────────────────────────────────

  it('aborts deploy when peers.json exists but contains corrupt/malformed JSON', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    // Write a corrupt peers.json to a temp file
    const tmpDir = mkdtempSync(join(tmpdir(), 'vpn-deploy-peers-test-'))
    const corruptPeersPath = join(tmpDir, 'peers.json')
    try {
      writeFileSync(corruptPeersPath, 'this is not valid json {{{')

      await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: corruptPeersPath})).rejects.toThrow()

      // No SSH calls must have been made — deploy must abort before SSH
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('proceeds with 0 peers when peers.json does not exist (no peers yet)', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
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

    const tmpDir = mkdtempSync(join(tmpdir(), 'vpn-deploy-peers-test-'))
    const badSchemaPeersPath = join(tmpDir, 'peers.json')
    try {
      // Valid JSON but wrong schema — missing required fields
      writeFileSync(badSchemaPeersPath, JSON.stringify({wrong: 'schema', notPeers: true}))

      await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: badSchemaPeersPath})).rejects.toThrow()

      // No SSH calls — deploy must abort
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  // ─── SSH user + privilege contract ───────────────────────────────────────

  it('SSH user contract: all SSH connections use ubuntu@host, never root@host', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      const sshCalls = calls.filter(c => c.cmd[0] === 'ssh')
      expect(sshCalls.length).toBeGreaterThan(0)

      for (const call of sshCalls) {
        // The destination is the arg matching user@host (not a ControlPath option value)
        // ControlPath contains %r@%h:%p — filter those out by requiring no % or :
        const destination = call.cmd.find(arg => /^[a-z]+@[^%:]+$/.test(arg))
        expect(destination).toBeDefined()
        expect(destination).toMatch(/^ubuntu@/)
        expect(destination).not.toMatch(/^root@/)
      }
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('privilege contract: wg show wg0 is prefixed with sudo', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      const wgShowCall = calls.find(c => c.cmd.join(' ').includes('wg show wg0'))
      expect(wgShowCall).toBeDefined()
      const wgShowCmd = wgShowCall?.cmd.join(' ') ?? ''
      expect(wgShowCmd).toMatch(/sudo wg show wg0/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('privilege contract: systemctl enable uses sudo', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      const enableCall = calls.find(c => c.cmd.join(' ').includes('enable') && c.cmd.join(' ').includes('wg-quick@wg0'))
      expect(enableCall).toBeDefined()
      const enableCmd = enableCall?.cmd.join(' ') ?? ''
      expect(enableCmd).toMatch(/sudo systemctl enable/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('privilege contract: systemctl restart uses sudo', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      const restartCall = calls.find(
        c => c.cmd.join(' ').includes('restart') && c.cmd.join(' ').includes('wg-quick@wg0'),
      )
      expect(restartCall).toBeDefined()
      const restartCmd = restartCall?.cmd.join(' ') ?? ''
      expect(restartCmd).toMatch(/sudo systemctl restart/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('privilege contract: sysctl --system uses sudo', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      const sysctlCall = calls.find(c => c.cmd.join(' ').includes('sysctl') && c.cmd.join(' ').includes('--system'))
      expect(sysctlCall).toBeDefined()
      const sysctlCmd = sysctlCall?.cmd.join(' ') ?? ''
      expect(sysctlCmd).toMatch(/sudo sysctl --system/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('privilege contract: writeRemoteFile uses sudo tee for privileged paths', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      // The placeholder wg0.conf write (stdin) must use sudo tee
      const wgConfWrite = calls.find(c => c.stdin !== undefined && c.stdin.includes('__SERVER_PRIVATE_KEY__'))
      expect(wgConfWrite).toBeDefined()
      const wgConfCmd = wgConfWrite?.cmd.join(' ') ?? ''
      expect(wgConfCmd).toMatch(/sudo tee/)

      // The sysctl forwarding conf write (stdin) must use sudo tee
      const sysctlWrite = calls.find(c => c.stdin !== undefined && c.stdin.includes('net.ipv4.ip_forward'))
      expect(sysctlWrite).toBeDefined()
      const sysctlWriteCmd = sysctlWrite?.cmd.join(' ') ?? ''
      expect(sysctlWriteCmd).toMatch(/sudo tee/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('privilege contract: server key generation uses sudo sh -c for privileged writes', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      // The server key ensure command must use sudo (writes to /etc/wireguard/)
      const serverKeyCall = calls.find(
        c => c.cmd.join(' ').includes('server.key') && c.cmd.join(' ').includes('test -f'),
      )
      expect(serverKeyCall).toBeDefined()
      const serverKeyCmd = serverKeyCall?.cmd.join(' ') ?? ''
      expect(serverKeyCmd).toMatch(/sudo/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('privilege contract: read server.pub uses sudo cat', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      const readPubCall = calls.find(c => c.cmd.join(' ').includes('cat') && c.cmd.join(' ').includes('server.pub'))
      expect(readPubCall).toBeDefined()
      const readPubCmd = readPubCall?.cmd.join(' ') ?? ''
      expect(readPubCmd).toMatch(/sudo cat/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('privilege contract: awk substitution uses sudo sh -c for privileged writes', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      const awkCall = calls.find(c => c.cmd.join(' ').includes('awk') && c.cmd.join(' ').includes('server.key'))
      expect(awkCall).toBeDefined()
      const awkCmd = awkCall?.cmd.join(' ') ?? ''
      expect(awkCmd).toMatch(/sudo/)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('HOME env defaults to /home/ubuntu, not /root', async () => {
    // buildDeployEnv uses HOME ?? '/home/ubuntu' — verify the default is ubuntu's home
    // We test this by capturing the env passed to spawn
    const calls: SpawnCall[] = []
    const capturedEnvs: Record<string, string>[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    let callIndex = 0
    const capturingSpawn: SpawnFn = (cmd, opts) => {
      capturedEnvs.push(opts.env)
      const hardeningResult = HARDENING_COMMAND.test(cmd.join(' ')) ? settledBox(cmd.join(' ')) : undefined
      const result = hardeningResult ?? results[callIndex++] ?? {stdout: '', stderr: '', exitCode: 0}

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
        stderr: makeStream('stderr' in result ? (result.stderr ?? '') : ''),
        stdin: stdinPipe,
        exited: Promise.resolve(result.exitCode ?? 0),
      } satisfies SpawnResult
    }

    // Use BASE_ENV which has HOME=/root — the deploy should still work
    // but the DEFAULT fallback (when HOME is absent) must be /home/ubuntu
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: capturingSpawn, peersJsonPath})

      // All SSH calls must use ubuntu@ destinations
      const sshCalls = calls.filter(c => c.cmd[0] === 'ssh')
      expect(sshCalls.length).toBeGreaterThan(0)
      for (const call of sshCalls) {
        // Filter out ControlPath args (contain % or :) to find the real destination
        const destination = call.cmd.find(arg => /^[a-z]+@[^%:]+$/.test(arg))
        expect(destination).toMatch(/^ubuntu@/)
      }
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  // ─── VPN_PEERS env var behavior ──────────────────────────────────────────

  it('VPN_PEERS env set + valid → peers come from env, file is not read', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      // wg show reports 1 peer — must match the 1 peer in VPN_PEERS
      {stdout: 'interface: wg0\n  public key: FAKEPUBKEY==\npeer: ENVPEER\n', exitCode: 0},
    ]
    const mockSpawn = makeMockSpawn(calls, results)

    const envPeers = JSON.stringify({
      peers: [{name: 'envpeer', publicKey: 'ENVPEERPUBKEY==', tunnelIp: '10.8.0.2'}],
    })

    // Point peersJsonPath to a non-existent file — if the env var is used, it won't be read
    await deploy({
      env: {...BASE_ENV, VPN_PEERS: envPeers},
      spawn: mockSpawn,
      peersJsonPath: '/tmp/vpn-deploy-test-NONEXISTENT-peers.json',
    })

    // The wg0.conf shipped via stdin must contain the env peer's public key
    const wgConfCall = calls.find(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
    expect(wgConfCall).toBeDefined()
    expect(wgConfCall?.stdin).toContain('ENVPEERPUBKEY==')
  })

  it('VPN_PEERS set + malformed → deploy fails with clear error, no file fallback', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    // Write a valid peers.json to a temp file — if the env var is set but invalid,
    // the deploy must NOT fall back to the file
    const tmpDir = mkdtempSync(join(tmpdir(), 'vpn-deploy-peers-env-test-'))
    const validPeersPath = join(tmpDir, 'peers.json')
    try {
      writeFileSync(
        validPeersPath,
        JSON.stringify({peers: [{name: 'filepeer', publicKey: 'FILEPUBKEY==', tunnelIp: '10.8.0.2'}]}),
      )

      await expect(
        deploy({
          env: {...BASE_ENV, VPN_PEERS: 'this is not valid json {{{'},
          spawn: mockSpawn,
          peersJsonPath: validPeersPath,
        }),
      ).rejects.toThrow()

      // No SSH calls — deploy must abort before SSH
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('CI mode: materializes VPN_SSH_KEY to a temp file before SSH calls', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump (0 live peers → proceed)
      {stdout: '', exitCode: 0},
      {stdout: 'PUBKEY==\n', exitCode: 0},
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: '', exitCode: 0},
      {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: CI_ENV, spawn: mockSpawn, peersJsonPath})

      // In CI mode, SSH commands must use -i <keypath> + IdentitiesOnly=yes
      const sshCalls = calls.filter(c => c.cmd[0] === 'ssh')
      expect(sshCalls.length).toBeGreaterThan(0)
      for (const call of sshCalls) {
        expect(call.cmd).toContain('-i')
        expect(call.cmd).toContain('IdentitiesOnly=yes')
      }
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  // ─── Wipe guard (Fix 2) ───────────────────────────────────────────────────

  it('wipe guard: aborts when incoming roster is 0 peers but live box has peers', async () => {
    const calls: SpawnCall[] = []
    // The wipe guard queries live peer count before applying config.
    // wg show wg0 dump: first line is server, subsequent lines are peers.
    // With 1 live peer, dump has 2 lines (server + 1 peer).
    const results = [
      // wipe guard query: wg show wg0 dump
      {stdout: 'server-line\npeer-line\n', exitCode: 0},
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    // Empty roster (0 peers) — no peers.json
    const nonExistentPath = '/tmp/vpn-deploy-test-wipe-guard-nonexistent.json'

    await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: nonExistentPath})).rejects.toThrow(
      /empty roster|VPN_ALLOW_EMPTY_ROSTER|wipe guard/i,
    )

    // Must abort before writing any config
    const configWrites = calls.filter(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
    expect(configWrites).toHaveLength(0)
  })

  it('wipe guard: VPN_ALLOW_EMPTY_ROSTER=1 bypasses the guard and proceeds with 0 peers', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: FAKEPUBKEY==\n  peers: 0\n', exitCode: 0}, // wg show
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const nonExistentPath = '/tmp/vpn-deploy-test-wipe-guard-override-nonexistent.json'

    // With VPN_ALLOW_EMPTY_ROSTER=1, deploy must proceed even with 0 peers
    await expect(
      deploy({
        env: {...BASE_ENV, VPN_ALLOW_EMPTY_ROSTER: '1'},
        spawn: mockSpawn,
        peersJsonPath: nonExistentPath,
      }),
    ).resolves.toBeUndefined()

    // Deploy must have proceeded (SSH calls made)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('wipe guard: first-boot (live=0, incoming=0) proceeds normally without override', async () => {
    const calls: SpawnCall[] = []
    const results = [
      // wipe guard query: wg show wg0 dump — only server line (0 peers)
      {stdout: 'server-line\n', exitCode: 0},
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: FAKEPUBKEY==\n  peers: 0\n', exitCode: 0}, // wg show
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const nonExistentPath = '/tmp/vpn-deploy-test-wipe-guard-firstboot-nonexistent.json'

    // First boot: live=0, incoming=0 — must proceed without override
    await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: nonExistentPath})).resolves.toBeUndefined()

    expect(calls.length).toBeGreaterThan(0)
  })

  it('wipe guard: incoming > 0 peers — guard not triggered, no pre-check SSH call', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n', exitCode: 0}, // ip route show default
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: FAKEPUBKEY==\npeer: PEER1\n', exitCode: 0}, // wg show (1 peer)
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    // 1 peer in roster — guard must not trigger
    const {dir, peersJsonPath} = makeTempPeersDir([{name: 'peer1', publicKey: 'PEER1PUBKEY==', tunnelIp: '10.8.0.2'}])
    try {
      await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})).resolves.toBeUndefined()

      // No wg show dump call before the main deploy sequence
      // (the wipe guard dump call only happens when incoming=0)
      const dumpCalls = calls.filter(c => c.cmd.join(' ').includes('wg show wg0 dump'))
      expect(dumpCalls).toHaveLength(0)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('wipe guard: probe SSH failure (exit 255, empty stdout) aborts — undetermined peer count, no config applied', async () => {
    const calls: SpawnCall[] = []
    // SSH connection dropped: wg show wg0 dump exits 255 with no stdout.
    const results = [{stdout: '', stderr: 'ssh: connect to host 1.2.3.4 port 22: Connection refused\n', exitCode: 255}]

    const mockSpawn = makeMockSpawn(calls, results)
    const nonExistentPath = '/tmp/vpn-deploy-test-wipe-guard-probe-ssh-fail-nonexistent.json'

    let caughtError: unknown
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: nonExistentPath})
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBeInstanceOf(Error)
    expect((caughtError as Error).message).toMatch(/could not determine the live peer count/i)
    // Must not report a wipe-guard trip (that implies a known, positive live peer count)
    expect((caughtError as Error).message).not.toMatch(/the live box has \d+ peer/i)

    // Must abort before writing any config
    const configWrites = calls.filter(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
    expect(configWrites).toHaveLength(0)
  })

  it('wipe guard: probe `wg` failure (exit 1, empty stdout) aborts — undetermined peer count, no config applied', async () => {
    const calls: SpawnCall[] = []
    // wg not installed / interface missing: wg show wg0 dump exits 1 with no stdout.
    const results = [{stdout: '', stderr: 'wg: command not found\n', exitCode: 1}]

    const mockSpawn = makeMockSpawn(calls, results)
    const nonExistentPath = '/tmp/vpn-deploy-test-wipe-guard-probe-wg-fail-nonexistent.json'

    await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: nonExistentPath})).rejects.toThrow(
      /could not determine the live peer count/i,
    )

    const configWrites = calls.filter(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
    expect(configWrites).toHaveLength(0)
  })

  it('wipe guard: probe exits 0 with completely empty stdout aborts with the distinct no-output message', async () => {
    const calls: SpawnCall[] = []
    // Probe "succeeds" (exit 0) but produced no output at all — not even the server line.
    const results = [{stdout: '', exitCode: 0}]

    const mockSpawn = makeMockSpawn(calls, results)
    const nonExistentPath = '/tmp/vpn-deploy-test-wipe-guard-probe-no-output-nonexistent.json'

    await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: nonExistentPath})).rejects.toThrow(
      /produced no output/i,
    )

    const configWrites = calls.filter(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
    expect(configWrites).toHaveLength(0)
  })

  it('wipe guard: live box has 2 peers — aborts naming the exact count', async () => {
    const calls: SpawnCall[] = []
    const results = [{stdout: 'server-line\npeer-line-1\npeer-line-2\n', exitCode: 0}]

    const mockSpawn = makeMockSpawn(calls, results)
    const nonExistentPath = '/tmp/vpn-deploy-test-wipe-guard-two-peers-nonexistent.json'

    await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath: nonExistentPath})).rejects.toThrow(
      /the live box has 2 peer\(s\)/,
    )

    const configWrites = calls.filter(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
    expect(configWrites).toHaveLength(0)
  })

  // ─── WAN interface detection ──────────────────────────────────────────────

  it('detects WAN interface from ip route show default output and uses it in wg0.conf', async () => {
    const calls: SpawnCall[] = []

    // New call sequence (11 calls total, 0-peer roster triggers wipe guard):
    // 0: wipe guard: wg show wg0 dump (0 live peers → proceed)
    // 1: ensure server key
    // 2: read server.pub
    // 3: ip route show default (WAN interface detection → ens5)
    // 4: ship placeholder wg0.conf to temp path (stdin)
    // 5: awk substitution
    // 6: write wg-forwarding.conf (stdin)
    // 7: sysctl --system
    // 8: systemctl enable --now
    // 9: systemctl restart
    // 10: wg show wg0
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp src 172.26.14.2 metric 100\n', exitCode: 0}, // ip route
      {stdout: '', exitCode: 0}, // ship placeholder wg0.conf (stdin)
      {stdout: '', exitCode: 0}, // awk substitution
      {stdout: '', exitCode: 0}, // write wg-forwarding.conf
      {stdout: '', exitCode: 0}, // sysctl --system
      {stdout: '', exitCode: 0}, // systemctl enable --now
      {stdout: '', exitCode: 0}, // systemctl restart
      {stdout: 'interface: wg0\n  public key: FAKEPUBKEY==\n  peers: 0\n', exitCode: 0}, // wg show
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})

      // The ip route show default command must have been called
      const routeCall = calls.find(c => c.cmd.join(' ').includes('ip route show default'))
      expect(routeCall).toBeDefined()

      // The shipped wg0.conf must use ens5 (detected), NOT eth0 (hardcoded)
      const wgConfCall = calls.find(c => c.stdin !== undefined && c.stdin.includes('[Interface]'))
      expect(wgConfCall).toBeDefined()
      expect(wgConfCall?.stdin).toContain('ens5')
      expect(wgConfCall?.stdin).not.toContain('eth0')
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('throws a clear error when ip route show default returns empty output', async () => {
    const calls: SpawnCall[] = []
    const results = [
      {stdout: 'server-line\n', exitCode: 0}, // wipe guard dump
      {stdout: '', exitCode: 0}, // ensure server key
      {stdout: 'FAKEPUBKEY==\n', exitCode: 0}, // read server.pub
      {stdout: '', exitCode: 0}, // ip route show default — empty output (detection fails)
    ]

    const mockSpawn = makeMockSpawn(calls, results)
    const {dir, peersJsonPath} = makeTempPeersDir([])
    try {
      await expect(deploy({env: BASE_ENV, spawn: mockSpawn, peersJsonPath})).rejects.toThrow(
        /WAN interface|ip route|default route/i,
      )
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  // ─── VPN_PEERS ZodError wrap (Fix 3) ─────────────────────────────────────

  it('VPN_PEERS set + valid JSON but wrong schema → fails with clear error, no file fallback', async () => {
    const calls: SpawnCall[] = []
    const mockSpawn = makeMockSpawn(calls, [])

    // Write a valid peers.json to a temp file — must NOT be used as fallback
    const {dir, peersJsonPath} = makeTempPeersDir([{name: 'filepeer', publicKey: 'FILEPUBKEY==', tunnelIp: '10.8.0.2'}])
    try {
      await expect(
        deploy({
          env: {...BASE_ENV, VPN_PEERS: '{"foo":"bar"}'},
          spawn: mockSpawn,
          peersJsonPath,
        }),
      ).rejects.toThrow()

      // No SSH calls — deploy must abort before SSH
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})

// ─── Memory hardening ─────────────────────────────────────────────────────────

interface BoxState {
  swap?: MockResult
  fstab?: MockResult
  mask?: MockResult
  /** The `>> /etc/fstab` append. */
  persist?: MockResult
}

/** Scripts the box's answers to the hardening probes; every other hardening command succeeds silently. */
function box(state: BoxState = {}): HardeningResponder {
  return command => {
    if (command.includes('swapon --noheadings')) return state.swap ?? {stdout: 'SWAP_OTHER\n'}
    if (command.includes('grep') && command.includes('/etc/fstab')) return state.fstab ?? {stdout: 'FSTAB_ABSENT\n'}
    if (command.includes('systemctl mask')) return state.mask ?? {stdout: 'FWUPD_MASKED\n'}
    if (command.includes('>> /etc/fstab')) return state.persist ?? {stdout: ''}
    return {stdout: ''}
  }
}

/** Results for a full 0-peer deploy, excluding hardening commands (those use the responder). */
function zeroPeerResults(): MockResult[] {
  return [
    {stdout: 'server-line\n'}, // wipe guard dump
    {stdout: ''}, // ensure server key
    {stdout: 'PUBKEY==\n'}, // read server.pub
    {stdout: 'default via 172.26.0.1 dev ens5 proto dhcp\n'}, // ip route show default
    {stdout: ''}, // ship placeholder wg0.conf
    {stdout: ''}, // awk substitution
    {stdout: ''}, // write wg-forwarding.conf
    {stdout: ''}, // sysctl --system
    {stdout: ''}, // enable --now
    {stdout: ''}, // restart
    {stdout: 'interface: wg0\n  public key: PUBKEY==\n  peers: 0\n'}, // wg show
  ]
}

async function runWithBox(
  state: BoxState,
  options: {results?: MockResult[]; forceServerKey?: boolean} = {},
): Promise<{calls: SpawnCall[]; error: unknown}> {
  const calls: SpawnCall[] = []
  const {dir, peersJsonPath} = makeTempPeersDir([])
  try {
    await deploy({
      env: BASE_ENV,
      spawn: makeMockSpawn(calls, options.results ?? zeroPeerResults(), box(state)),
      peersJsonPath,
      forceServerKey: options.forceServerKey ?? false,
    })
    return {calls, error: undefined}
  } catch (error) {
    return {calls, error}
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

/** The remote command string of each recorded call (last argv element for ssh). */
function remoteCommands(calls: SpawnCall[]): string[] {
  return calls.map(c => c.cmd.at(-1) ?? '')
}

function indexOfCommand(calls: SpawnCall[], pattern: RegExp): number {
  return remoteCommands(calls).findIndex(command => pattern.test(command))
}

function commandMatching(calls: SpawnCall[], pattern: RegExp): string {
  const command = remoteCommands(calls).find(candidate => pattern.test(candidate))
  if (command === undefined) {
    throw new Error(`no recorded command matches ${pattern}`)
  }
  return command
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

const SWAP_PROBE = /swapon --noheadings/
const FSTAB_PROBE = /grep.*\/etc\/fstab/
const MASK_FWUPD = /systemctl mask/
const SWAP_STEPS = {
  allocate: /fallocate/,
  permissions: /chmod 600 \/swapfile/,
  format: /mkswap/,
  activate: /swapon \/swapfile/,
  persist: />>\s*\/etc\/fstab/,
} as const
const ANY_SWAP_STEP = new RegExp(
  Object.values(SWAP_STEPS)
    .map(pattern => pattern.source)
    .join('|'),
)
// Anything that reads or changes WireGuard state; the read-only wipe-guard probe (`wg show wg0 dump`) is not one.
const WIREGUARD_CONTROL =
  /\/etc\/wireguard|server\.key|server\.pub|__SERVER_PRIVATE_KEY__|wg-quick|wg0\.conf|ip_forward/

// The mocked spawn cannot tell whether the shell inside a command does the right thing,
// so the decision-bearing commands are executed under `sh` with stubbed binaries.
function runRemote(command: string, stubs: Record<string, string>): {exitCode: number; stdout: string} {
  const dir = mkdtempSync(join(tmpdir(), 'vpn-deploy-stub-'))
  try {
    for (const [name, body] of Object.entries({sudo: 'exec "$@"', ...stubs})) {
      const path = join(dir, name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`)
      chmodSync(path, 0o755)
    }
    const proc = Bun.spawnSync(['sh', '-c', command], {
      env: {PATH: `${dir}:/usr/bin:/bin`},
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {exitCode: proc.exitCode, stdout: proc.stdout.toString().trim()}
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

async function probeCommand(pattern: RegExp, state: BoxState): Promise<string> {
  const {calls} = await runWithBox(state)
  return commandMatching(calls, pattern)
}

function systemctlStub(options: {mask?: number; stop?: number; enabled?: string} = {}): string {
  const {mask = 0, stop = 0, enabled = 'masked'} = options
  return [
    'case "$1" in',
    `  mask) exit ${mask};;`,
    `  stop) exit ${stop};;`,
    `  is-enabled) echo ${enabled}; exit 1;;`,
    'esac',
    'exit 99',
  ].join('\n')
}

describe('deploy: memory hardening', () => {
  describe('swap', () => {
    it('only unrelated swap active → left alone: no create step, no fstab read or write', async () => {
      const {calls, error} = await runWithBox({swap: {stdout: 'SWAP_OTHER\n'}})

      expect(error).toBeUndefined()
      expect(indexOfCommand(calls, SWAP_PROBE)).toBeGreaterThanOrEqual(0)
      expect(remoteCommands(calls).filter(command => ANY_SWAP_STEP.test(command))).toEqual([])
      expect(indexOfCommand(calls, FSTAB_PROBE)).toBe(-1)
    })

    it('our /swapfile active with the fstab entry present → nothing beyond the probes and the mask', async () => {
      const {calls, error} = await runWithBox({swap: {stdout: 'SWAP_OURS\n'}, fstab: {stdout: 'FSTAB_PRESENT\n'}})

      expect(error).toBeUndefined()
      expect(indexOfCommand(calls, FSTAB_PROBE)).toBeGreaterThanOrEqual(0)
      expect(remoteCommands(calls).filter(command => HARDENING_COMMAND.test(command))).toHaveLength(3)
      expect(remoteCommands(calls).filter(command => ANY_SWAP_STEP.test(command))).toEqual([])
    })

    it('our /swapfile active but not in fstab → appends exactly one entry and never reallocates, reformats or re-activates', async () => {
      const {calls, error} = await runWithBox({swap: {stdout: 'SWAP_OURS\n'}, fstab: {stdout: 'FSTAB_ABSENT\n'}})

      expect(error).toBeUndefined()
      expect(remoteCommands(calls).filter(command => SWAP_STEPS.persist.test(command))).toHaveLength(1)
      expect(commandMatching(calls, SWAP_STEPS.persist)).toContain('/swapfile none swap sw 0 0')
      for (const step of [SWAP_STEPS.allocate, SWAP_STEPS.permissions, SWAP_STEPS.format, SWAP_STEPS.activate]) {
        expect(indexOfCommand(calls, step)).toBe(-1)
      }
    })

    it('activation succeeded but the fstab write failed → the next deploy persists exactly one entry and sends no create step', async () => {
      const first = await runWithBox({
        swap: {stdout: 'SWAP_NONE\n'},
        fstab: {stdout: 'FSTAB_ABSENT\n'},
        persist: {stdout: '', stderr: 'tee: /etc/fstab: Read-only file system\n', exitCode: 1},
      })

      expect(errorMessage(first.error)).toMatch(/fstab/)
      expect(indexOfCommand(first.calls, SWAP_STEPS.activate)).toBeGreaterThanOrEqual(0)

      // Retry: the swap file is now active, the entry is still missing.
      const retry = await runWithBox({swap: {stdout: 'SWAP_OURS\n'}, fstab: {stdout: 'FSTAB_ABSENT\n'}})

      expect(retry.error).toBeUndefined()
      expect(remoteCommands(retry.calls).filter(command => SWAP_STEPS.persist.test(command))).toHaveLength(1)
      for (const step of [SWAP_STEPS.allocate, SWAP_STEPS.permissions, SWAP_STEPS.format, SWAP_STEPS.activate]) {
        expect(indexOfCommand(retry.calls, step)).toBe(-1)
      }
    })

    it('no swap active → allocates, locks down permissions, formats, activates, then persists — in that order', async () => {
      const {calls, error} = await runWithBox({swap: {stdout: 'SWAP_NONE\n'}, fstab: {stdout: 'FSTAB_ABSENT\n'}})

      expect(error).toBeUndefined()
      const order = [
        indexOfCommand(calls, SWAP_STEPS.allocate),
        indexOfCommand(calls, SWAP_STEPS.permissions),
        indexOfCommand(calls, SWAP_STEPS.format),
        indexOfCommand(calls, SWAP_STEPS.activate),
        indexOfCommand(calls, SWAP_STEPS.persist),
      ]
      expect(order.every(index => index >= 0)).toBe(true)
      expect(order).toEqual([...order].sort((a, b) => a - b))

      // every create step runs privileged, and the persisted line is the one fstab expects
      for (const step of Object.values(SWAP_STEPS)) {
        expect(commandMatching(calls, step)).toMatch(/sudo/)
      }
      expect(commandMatching(calls, SWAP_STEPS.persist)).toContain('/swapfile none swap sw 0 0')
    })

    it('swap file is root-owned with mode 0600 before it is formatted', async () => {
      const {calls} = await runWithBox({swap: {stdout: 'SWAP_NONE\n'}})

      const permissions = commandMatching(calls, SWAP_STEPS.permissions)
      expect(permissions).toMatch(/chown root:root \/swapfile/)
      expect(indexOfCommand(calls, SWAP_STEPS.permissions)).toBeLessThan(indexOfCommand(calls, SWAP_STEPS.format))
    })

    it('fstab entry already present → still creates swap but never appends a second fstab line', async () => {
      const {calls, error} = await runWithBox({swap: {stdout: 'SWAP_NONE\n'}, fstab: {stdout: 'FSTAB_PRESENT\n'}})

      expect(error).toBeUndefined()
      expect(indexOfCommand(calls, FSTAB_PROBE)).toBeGreaterThanOrEqual(0)
      expect(indexOfCommand(calls, SWAP_STEPS.activate)).toBeGreaterThanOrEqual(0)
      expect(indexOfCommand(calls, SWAP_STEPS.persist)).toBe(-1)
    })

    it('probes both swap and fstab before the first change to the box', async () => {
      const {calls} = await runWithBox({swap: {stdout: 'SWAP_NONE\n'}})

      const firstChange = Math.min(indexOfCommand(calls, MASK_FWUPD), indexOfCommand(calls, SWAP_STEPS.allocate))
      expect(indexOfCommand(calls, SWAP_PROBE)).toBeLessThan(firstChange)
      expect(indexOfCommand(calls, FSTAB_PROBE)).toBeLessThan(firstChange)
    })
  })

  describe('fails closed on an inconclusive probe', () => {
    const inconclusiveSwapProbes: [string, MockResult][] = [
      ['non-zero exit with stderr', {stdout: '', stderr: 'swapon: permission denied\n', exitCode: 1}],
      ['non-zero exit that still printed a sentinel', {stdout: 'SWAP_NONE\n', stderr: 'boom\n', exitCode: 2}],
      ['exit 0 with empty output', {stdout: '', exitCode: 0}],
      ['exit 0 with an unrecognised answer', {stdout: 'SWAP_MAYBE\n', exitCode: 0}],
      ['exit 0 with the retired SWAP_ACTIVE answer', {stdout: 'SWAP_ACTIVE\n', exitCode: 0}],
    ]

    for (const [name, swap] of inconclusiveSwapProbes) {
      it(`swap probe: ${name} → throws naming the probe, before any change`, async () => {
        const {calls, error} = await runWithBox({swap})

        expect(error).toBeInstanceOf(Error)
        expect(errorMessage(error)).toMatch(/whether swap is active/)
        expect(errorMessage(error)).toContain(`exited ${swap.exitCode ?? 0}`)
        if (swap.stderr) {
          expect(errorMessage(error)).toContain(swap.stderr.trim())
        }
        expect(indexOfCommand(calls, MASK_FWUPD)).toBe(-1)
        expect(remoteCommands(calls).filter(command => ANY_SWAP_STEP.test(command))).toEqual([])
        expect(calls.some(c => WIREGUARD_CONTROL.test(c.cmd.at(-1) ?? ''))).toBe(false)
      })
    }

    const inconclusiveFstabProbes: [string, MockResult][] = [
      ['non-zero exit with stderr', {stdout: '', stderr: 'grep: /etc/fstab: No such file\n', exitCode: 2}],
      ['non-zero exit that still printed a sentinel', {stdout: 'FSTAB_ABSENT\n', exitCode: 2}],
      ['exit 0 with empty output', {stdout: '', exitCode: 0}],
      ['exit 0 with an unrecognised answer', {stdout: 'FSTAB_UNKNOWN\n', exitCode: 0}],
    ]

    for (const [name, fstab] of inconclusiveFstabProbes) {
      it(`fstab probe: ${name} → throws naming /etc/fstab, before any change`, async () => {
        const {calls, error} = await runWithBox({swap: {stdout: 'SWAP_NONE\n'}, fstab})

        expect(error).toBeInstanceOf(Error)
        expect(errorMessage(error)).toMatch(/\/etc\/fstab/)
        expect(errorMessage(error)).toContain(`exited ${fstab.exitCode ?? 0}`)
        expect(indexOfCommand(calls, MASK_FWUPD)).toBe(-1)
        expect(remoteCommands(calls).filter(command => ANY_SWAP_STEP.test(command))).toEqual([])
      })
    }

    it('a failing create step stops the sequence — later steps are never sent', async () => {
      const calls: SpawnCall[] = []
      const failingFormat: HardeningResponder = command => {
        if (/mkswap/.test(command)) return {stdout: '', stderr: 'mkswap: failed\n', exitCode: 1}
        return box({swap: {stdout: 'SWAP_NONE\n'}})(command)
      }
      const {dir, peersJsonPath} = makeTempPeersDir([])
      try {
        await expect(
          deploy({env: BASE_ENV, spawn: makeMockSpawn(calls, zeroPeerResults(), failingFormat), peersJsonPath}),
        ).rejects.toThrow(/mkswap/)
      } finally {
        rmSync(dir, {recursive: true, force: true})
      }

      expect(indexOfCommand(calls, SWAP_STEPS.activate)).toBe(-1)
      expect(indexOfCommand(calls, SWAP_STEPS.persist)).toBe(-1)
    })
  })

  describe('fwupd', () => {
    it('masks the refresh timer and fwupd services on every run, even when only unrelated swap is active', async () => {
      const {calls, error} = await runWithBox({swap: {stdout: 'SWAP_OTHER\n'}})

      expect(error).toBeUndefined()
      const mask = commandMatching(calls, MASK_FWUPD)
      expect(mask).toMatch(/^sudo systemctl mask /)
      for (const unit of ['fwupd-refresh.timer', 'fwupd-refresh.service', 'fwupd.service']) {
        expect(mask).toContain(unit)
      }
      expect(mask).toMatch(/systemctl stop/)
      expect(remoteCommands(calls).filter(command => MASK_FWUPD.test(command))).toHaveLength(1)
    })

    it('masking fails → deploy throws and WireGuard is never touched', async () => {
      const {calls, error} = await runWithBox({mask: {stdout: '', stderr: 'Failed to mask\n', exitCode: 1}})

      expect(errorMessage(error)).toMatch(/fwupd/)
      expect(calls.some(c => WIREGUARD_CONTROL.test(c.cmd.at(-1) ?? ''))).toBe(false)
    })

    it('masking exits 0 without confirming the units are masked → deploy throws', async () => {
      const {error} = await runWithBox({mask: {stdout: '', exitCode: 0}})

      expect(errorMessage(error)).toMatch(/fwupd/)
    })
  })

  describe('placement', () => {
    it('runs after the wipe guard and before the server key, config apply and restart', async () => {
      const {calls, error} = await runWithBox({swap: {stdout: 'SWAP_NONE\n'}})

      expect(error).toBeUndefined()
      const wipeGuard = indexOfCommand(calls, /wg show wg0 dump/)
      const hardening = [
        indexOfCommand(calls, SWAP_PROBE),
        indexOfCommand(calls, FSTAB_PROBE),
        indexOfCommand(calls, MASK_FWUPD),
        indexOfCommand(calls, SWAP_STEPS.persist),
      ]
      const serverKey = indexOfCommand(calls, /test -f .*server\.key/)
      const configShip = calls.findIndex(c => c.stdin?.includes('__SERVER_PRIVATE_KEY__') === true)
      const restart = indexOfCommand(calls, /restart wg-quick@wg0/)

      expect(wipeGuard).toBeGreaterThanOrEqual(0)
      for (const index of hardening) {
        expect(index).toBeGreaterThan(wipeGuard)
        expect(index).toBeLessThan(serverKey)
        expect(index).toBeLessThan(configShip)
        expect(index).toBeLessThan(restart)
      }
    })

    it('with --force-server-key it still runs before the key is regenerated', async () => {
      const {calls, error} = await runWithBox({}, {forceServerKey: true})

      expect(error).toBeUndefined()
      const mask = indexOfCommand(calls, MASK_FWUPD)
      expect(mask).toBeGreaterThanOrEqual(0)
      expect(mask).toBeLessThan(indexOfCommand(calls, /wg genkey/))
    })

    it('a tripped wipe guard aborts before the box is changed', async () => {
      const {calls, error} = await runWithBox({}, {results: [{stdout: 'server-line\npeer-line\n'}]})

      expect(errorMessage(error)).toMatch(/Wipe guard/)
      expect(indexOfCommand(calls, MASK_FWUPD)).toBe(-1)
      expect(indexOfCommand(calls, SWAP_PROBE)).toBe(-1)
    })

    it('never touches WireGuard, the roster, networking, packages or power state', async () => {
      const {calls} = await runWithBox({swap: {stdout: 'SWAP_NONE\n'}})

      const hardeningCommands = remoteCommands(calls).filter(command => HARDENING_COMMAND.test(command))
      expect(hardeningCommands.length).toBeGreaterThanOrEqual(7)
      for (const command of hardeningCommands) {
        expect(command).not.toMatch(WIREGUARD_CONTROL)
        expect(command).not.toMatch(/\bwg\b|sysctl|ip route|\bapt(-get)?\b|dpkg|reboot|shutdown|networkctl/)
      }
    })

    it('hardening commands carry no stdin payload', async () => {
      const {calls} = await runWithBox({swap: {stdout: 'SWAP_NONE\n'}})

      const hardeningCalls = calls.filter(c => HARDENING_COMMAND.test(c.cmd.at(-1) ?? ''))
      expect(hardeningCalls.length).toBeGreaterThan(0)
      expect(hardeningCalls.every(c => c.stdin === undefined)).toBe(true)
    })
  })

  // The mocked spawn cannot tell whether the shell inside a command does the right thing,
  // so the decision-bearing commands are executed here under `sh` with stubbed binaries.
  describe('remote command semantics (executed under sh with stubbed binaries)', () => {
    it('swap probe: nothing active → SWAP_NONE', async () => {
      const command = await probeCommand(SWAP_PROBE, {swap: {stdout: 'SWAP_NONE\n'}})

      expect(runRemote(command, {swapon: 'exit 0'})).toEqual({exitCode: 0, stdout: 'SWAP_NONE'})
    })

    it('swap probe: /swapfile active → SWAP_OURS, including when another swap device is active too', async () => {
      const command = await probeCommand(SWAP_PROBE, {swap: {stdout: 'SWAP_NONE\n'}})

      expect(runRemote(command, {swapon: 'echo /swapfile'})).toEqual({exitCode: 0, stdout: 'SWAP_OURS'})
      expect(runRemote(command, {swapon: String.raw`printf '%s\n' /dev/zram0 /swapfile`})).toEqual({
        exitCode: 0,
        stdout: 'SWAP_OURS',
      })
    })

    it('swap probe: only other swap active → SWAP_OTHER, even for look-alike names', async () => {
      const command = await probeCommand(SWAP_PROBE, {swap: {stdout: 'SWAP_NONE\n'}})

      for (const names of ['/swap.img', '/dev/zram0', '/swapfile2', '/mnt/swapfile']) {
        expect(runRemote(command, {swapon: `echo ${names}`})).toEqual({exitCode: 0, stdout: 'SWAP_OTHER'})
      }
    })

    it('swap probe: a failing swapon is a failed probe, never "no swap"', async () => {
      const command = await probeCommand(SWAP_PROBE, {swap: {stdout: 'SWAP_NONE\n'}})

      const result = runRemote(command, {swapon: 'exit 2'})
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toMatch(/SWAP_/)

      const printedThenFailed = runRemote(command, {swapon: 'echo /swapfile; exit 2'})
      expect(printedThenFailed.exitCode).not.toBe(0)
      expect(printedThenFailed.stdout).not.toMatch(/SWAP_/)
    })

    it('fstab probe: grep 0 → FSTAB_PRESENT, 1 → FSTAB_ABSENT, anything else is a failed probe', async () => {
      const command = await probeCommand(FSTAB_PROBE, {swap: {stdout: 'SWAP_NONE\n'}})

      expect(runRemote(command, {grep: 'exit 0'})).toEqual({exitCode: 0, stdout: 'FSTAB_PRESENT'})
      expect(runRemote(command, {grep: 'exit 1'})).toEqual({exitCode: 0, stdout: 'FSTAB_ABSENT'})
      for (const rc of [2, 127]) {
        const result = runRemote(command, {grep: `exit ${rc}`})
        expect(result.exitCode).toBe(rc)
        expect(result.stdout).not.toMatch(/FSTAB_/)
      }
    })

    it('mask command: succeeds and confirms when units are masked', async () => {
      const command = await probeCommand(MASK_FWUPD, {})

      expect(runRemote(command, {systemctl: systemctlStub()})).toEqual({exitCode: 0, stdout: 'FWUPD_MASKED'})
    })

    it('mask command: units that are absent or not loaded (stop fails) do not fail the run', async () => {
      const command = await probeCommand(MASK_FWUPD, {})

      expect(runRemote(command, {systemctl: systemctlStub({stop: 5})})).toEqual({exitCode: 0, stdout: 'FWUPD_MASKED'})
    })

    it('mask command: a failed mask, or units that do not report masked, never confirm', async () => {
      const command = await probeCommand(MASK_FWUPD, {})

      for (const stub of [systemctlStub({mask: 1}), systemctlStub({enabled: 'enabled'})]) {
        const result = runRemote(command, {systemctl: stub})
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain('FWUPD_MASKED')
      }
    })
  })
})
