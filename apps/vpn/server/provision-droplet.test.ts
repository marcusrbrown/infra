import {existsSync} from 'node:fs'

import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {
  findSmallestIpv4Bundle,
  findUbuntuBlueprint,
  importKeyPairIdempotent,
  instanceExists,
  parseProvisionArgs,
  performProvisioning,
  pinIpHostKey,
  pollUntilRunning,
  resolveProvisionIdentity,
  validateRequiredEnv,
  type LightsailSendFn,
  type ProvisionDeps,
} from './provision-droplet'

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const managedEnvKeys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'VPN_SSH_KEY'] as const
type ManagedEnvKey = (typeof managedEnvKeys)[number]

let savedEnv: Partial<Record<ManagedEnvKey, string | undefined>>

function saveEnv(): void {
  savedEnv = Object.fromEntries(managedEnvKeys.map(k => [k, process.env[k]])) as Partial<
    Record<ManagedEnvKey, string | undefined>
  >
}

function restoreEnv(): void {
  for (const key of managedEnvKeys) {
    const value = savedEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

// A fake private key for testing — not a real key, just realistic shape
const FAKE_PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakebase64content\n-----END OPENSSH PRIVATE KEY-----'

// ---------------------------------------------------------------------------
// Fake Lightsail send function builder
// ---------------------------------------------------------------------------

type CommandName =
  | 'GetInstancesCommand'
  | 'ImportKeyPairCommand'
  | 'GetBlueprintsCommand'
  | 'GetBundlesCommand'
  | 'CreateInstancesCommand'
  | 'GetInstanceCommand'
  | 'AllocateStaticIpCommand'
  | 'AttachStaticIpCommand'
  | 'GetStaticIpCommand'
  | 'PutInstancePublicPortsCommand'

interface FakeCall {
  commandName: CommandName
  input: Record<string, unknown>
}

// In tests we use a looser send type to avoid coupling to the full SDK overload set.
// The production code uses LightsailSendFn (= LightsailClient['send']); tests inject
// a compatible fake via the same exported type.
type TestSendFn = (command: {constructor: {name: string}; input: Record<string, unknown>}) => Promise<unknown>

function makeFakeSend(responses: Partial<Record<CommandName, unknown>>): {
  send: LightsailSendFn
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const testSend: TestSendFn = async command => {
    const name = command.constructor.name as CommandName
    calls.push({commandName: name, input: command.input})
    if (name in responses) {
      return responses[name]
    }
    throw new Error(`Unexpected command: ${name}`)
  }
  // Cast to LightsailSendFn — safe because the production code only passes real SDK
  // command instances (which have constructor.name and input), and the test fake
  // handles all commands used in the provisioner.
  return {send: testSend as unknown as LightsailSendFn, calls}
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FAKE_BLUEPRINTS = [
  {
    blueprintId: 'ubuntu_20_04',
    name: 'Ubuntu 20.04 LTS',
    group: 'ubuntu',
    isActive: true,
    platform: 'LINUX_UNIX',
    version: '20.04',
  },
  {
    blueprintId: 'ubuntu_22_04',
    name: 'Ubuntu 22.04 LTS',
    group: 'ubuntu',
    isActive: true,
    platform: 'LINUX_UNIX',
    version: '22.04',
  },
  {
    blueprintId: 'ubuntu_24_04',
    name: 'Ubuntu 24.04 LTS',
    group: 'ubuntu',
    isActive: true,
    platform: 'LINUX_UNIX',
    version: '24.04',
  },
  {blueprintId: 'debian_12', name: 'Debian 12', group: 'debian', isActive: true, platform: 'LINUX_UNIX', version: '12'},
]

const FAKE_BUNDLES = [
  {bundleId: 'nano_3_0', price: 3.5, isActive: true, supportedPlatforms: ['LINUX_UNIX'], cpuCount: 2, ramSizeInGb: 0.5},
  {
    bundleId: 'micro_3_0',
    price: 5,
    isActive: true,
    supportedPlatforms: ['LINUX_UNIX'],
    cpuCount: 2,
    ramSizeInGb: 1,
  },
  {
    bundleId: 'small_3_0',
    price: 10,
    isActive: true,
    supportedPlatforms: ['LINUX_UNIX'],
    cpuCount: 2,
    ramSizeInGb: 2,
  },
  {
    bundleId: 'windows_nano',
    price: 8,
    isActive: true,
    supportedPlatforms: ['WINDOWS'],
    cpuCount: 2,
    ramSizeInGb: 0.5,
  },
]

const FAKE_STATIC_IP = {
  staticIp: {
    name: 'fro-bot-vpn-ip',
    ipAddress: '1.2.3.4',
    isAttached: true,
    attachedTo: 'fro-bot-vpn',
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provision-droplet', () => {
  beforeEach(() => {
    saveEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  // -------------------------------------------------------------------------
  // validateRequiredEnv
  // -------------------------------------------------------------------------

  describe('validateRequiredEnv', () => {
    it('returns empty array when all required vars are present', () => {
      const missing = validateRequiredEnv({
        AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      })
      expect(missing).toEqual([])
    })

    it('returns AWS_ACCESS_KEY_ID when it is missing', () => {
      const missing = validateRequiredEnv({
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      })
      expect(missing).toContain('AWS_ACCESS_KEY_ID')
    })

    it('returns AWS_SECRET_ACCESS_KEY when it is missing', () => {
      const missing = validateRequiredEnv({
        AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      })
      expect(missing).toContain('AWS_SECRET_ACCESS_KEY')
    })

    it('returns both vars when both are missing', () => {
      const missing = validateRequiredEnv({})
      expect(missing).toContain('AWS_ACCESS_KEY_ID')
      expect(missing).toContain('AWS_SECRET_ACCESS_KEY')
    })
  })

  // -------------------------------------------------------------------------
  // parseProvisionArgs
  // -------------------------------------------------------------------------

  describe('parseProvisionArgs', () => {
    it('parses --force flag', () => {
      expect(parseProvisionArgs(['--force'])).toEqual({force: true})
    })

    it('returns defaults when no args given', () => {
      expect(parseProvisionArgs([])).toEqual({force: false})
    })

    it('rejects unknown arguments', () => {
      expect(() => parseProvisionArgs(['--unknown'])).toThrow(/Unknown provision argument/)
    })
  })

  // -------------------------------------------------------------------------
  // findUbuntuBlueprint
  // -------------------------------------------------------------------------

  describe('findUbuntuBlueprint', () => {
    it('picks the newest Ubuntu LTS blueprint by version', () => {
      const id = findUbuntuBlueprint(FAKE_BLUEPRINTS)
      expect(id).toBe('ubuntu_24_04')
    })

    it('ignores non-ubuntu blueprints', () => {
      const onlyDebian = [
        {
          blueprintId: 'debian_12',
          name: 'Debian 12',
          group: 'debian',
          isActive: true,
          platform: 'LINUX_UNIX',
          version: '12',
        },
      ]
      expect(() => findUbuntuBlueprint(onlyDebian)).toThrow(/No active Ubuntu blueprint/)
    })

    it('ignores inactive blueprints', () => {
      const inactive = [
        {
          blueprintId: 'ubuntu_24_04',
          name: 'Ubuntu 24.04 LTS',
          group: 'ubuntu',
          isActive: false,
          platform: 'LINUX_UNIX',
          version: '24.04',
        },
      ]
      expect(() => findUbuntuBlueprint(inactive)).toThrow(/No active Ubuntu blueprint/)
    })

    it('throws actionable error when blueprint list is empty', () => {
      expect(() => findUbuntuBlueprint([])).toThrow(/No active Ubuntu blueprint/)
    })
  })

  // -------------------------------------------------------------------------
  // findSmallestIpv4Bundle
  // -------------------------------------------------------------------------

  describe('findSmallestIpv4Bundle', () => {
    it('picks the cheapest active LINUX_UNIX bundle', () => {
      const id = findSmallestIpv4Bundle(FAKE_BUNDLES)
      expect(id).toBe('nano_3_0')
    })

    it('ignores Windows-only bundles', () => {
      const windowsOnly = [
        {
          bundleId: 'windows_nano',
          price: 8,
          isActive: true,
          supportedPlatforms: ['WINDOWS'],
          cpuCount: 2,
          ramSizeInGb: 0.5,
        },
      ]
      expect(() => findSmallestIpv4Bundle(windowsOnly)).toThrow(/No active LINUX_UNIX bundle/)
    })

    it('ignores inactive bundles', () => {
      const inactive = [
        {
          bundleId: 'nano_3_0',
          price: 3.5,
          isActive: false,
          supportedPlatforms: ['LINUX_UNIX'],
          cpuCount: 2,
          ramSizeInGb: 0.5,
        },
      ]
      expect(() => findSmallestIpv4Bundle(inactive)).toThrow(/No active LINUX_UNIX bundle/)
    })

    it('throws actionable error when bundle list is empty', () => {
      expect(() => findSmallestIpv4Bundle([])).toThrow(/No active LINUX_UNIX bundle/)
    })
  })

  // -------------------------------------------------------------------------
  // instanceExists
  // -------------------------------------------------------------------------

  describe('instanceExists', () => {
    it('returns true when the named instance is in the list', async () => {
      const {send} = makeFakeSend({
        GetInstancesCommand: {instances: [{name: 'fro-bot-vpn', state: {name: 'running'}}]},
      })
      const result = await instanceExists('fro-bot-vpn', send)
      expect(result).toBe(true)
    })

    it('returns false when the named instance is not in the list', async () => {
      const {send} = makeFakeSend({
        GetInstancesCommand: {instances: [{name: 'other-instance', state: {name: 'running'}}]},
      })
      const result = await instanceExists('fro-bot-vpn', send)
      expect(result).toBe(false)
    })

    it('returns false when instance list is empty', async () => {
      const {send} = makeFakeSend({
        GetInstancesCommand: {instances: []},
      })
      const result = await instanceExists('fro-bot-vpn', send)
      expect(result).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // importKeyPairIdempotent
  // -------------------------------------------------------------------------

  describe('importKeyPairIdempotent', () => {
    it('calls ImportKeyPairCommand with the correct key pair name and base64 public key', async () => {
      const {send, calls} = makeFakeSend({
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
      })
      const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com'
      await importKeyPairIdempotent('fro-bot-vpn', publicKey, send)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.commandName).toBe('ImportKeyPairCommand')
      expect(calls[0]?.input.keyPairName).toBe('fro-bot-vpn')
      // publicKeyBase64 should be the base64-encoded public key
      const decoded = atob(calls[0]?.input.publicKeyBase64 as string)
      expect(decoded).toBe(publicKey)
    })

    it('swallows "already exists" error and continues (idempotent)', async () => {
      const alreadyExistsError = Object.assign(new Error('Key pair already exists'), {
        name: 'InvalidInputException',
        message: 'Key pair already exists',
      })
      // Override send to throw the already-exists error
      const throwingSend = (async () => {
        throw alreadyExistsError
      }) as unknown as LightsailSendFn
      // Should not throw
      await expect(
        importKeyPairIdempotent('fro-bot-vpn', 'ssh-ed25519 AAAA test', throwingSend),
      ).resolves.toBeUndefined()
    })

    it('re-throws errors that are not "already exists"', async () => {
      const otherError = Object.assign(new Error('Access denied'), {name: 'AccessDeniedException'})
      const throwingSend = (async () => {
        throw otherError
      }) as unknown as LightsailSendFn
      await expect(importKeyPairIdempotent('fro-bot-vpn', 'ssh-ed25519 AAAA test', throwingSend)).rejects.toThrow(
        'Access denied',
      )
    })
  })

  // -------------------------------------------------------------------------
  // pollUntilRunning
  // -------------------------------------------------------------------------

  describe('pollUntilRunning', () => {
    it('returns immediately when instance is already running', async () => {
      const {send, calls} = makeFakeSend({
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
      })
      await pollUntilRunning('fro-bot-vpn', send, {intervalMs: 0})
      expect(calls).toHaveLength(1)
    })

    it('polls until state transitions from pending to running', async () => {
      let callCount = 0
      const pollSend = (async (command: {constructor: {name: string}}) => {
        const name = command.constructor.name
        if (name === 'GetInstanceCommand') {
          callCount++
          const state = callCount < 3 ? 'pending' : 'running'
          return {instance: {name: 'fro-bot-vpn', state: {name: state}}}
        }
        throw new Error(`Unexpected: ${name}`)
      }) as unknown as LightsailSendFn
      await pollUntilRunning('fro-bot-vpn', pollSend, {intervalMs: 0})
      expect(callCount).toBe(3)
    })

    it('throws when max attempts exceeded without reaching running state', async () => {
      const {send} = makeFakeSend({
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'pending'}}},
      })
      await expect(pollUntilRunning('fro-bot-vpn', send, {intervalMs: 0, maxAttempts: 2})).rejects.toThrow(/Timed out/)
    })
  })

  // -------------------------------------------------------------------------
  // resolveProvisionIdentity
  // -------------------------------------------------------------------------

  describe('resolveProvisionIdentity', () => {
    it('returns a temp file path when key material is provided', () => {
      const {identityFile, cleanup} = resolveProvisionIdentity(FAKE_PRIVATE_KEY)
      try {
        expect(identityFile).toBeTruthy()
        expect(existsSync(identityFile ?? '')).toBe(true)
      } finally {
        cleanup()
      }
    })

    it('cleanup removes the temp file', () => {
      const {identityFile, cleanup} = resolveProvisionIdentity(FAKE_PRIVATE_KEY)
      expect(existsSync(identityFile ?? '')).toBe(true)
      cleanup()
      expect(existsSync(identityFile ?? '')).toBe(false)
    })

    it('returns no identityFile and a no-op cleanup when key material is absent', () => {
      const {identityFile, cleanup} = resolveProvisionIdentity(undefined)
      expect(identityFile).toBeUndefined()
      expect(() => cleanup()).not.toThrow()
    })

    it('treats a whitespace-only key as absent', () => {
      const {identityFile, cleanup} = resolveProvisionIdentity('   \n  ')
      expect(identityFile).toBeUndefined()
      expect(() => cleanup()).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // pinIpHostKey
  // -------------------------------------------------------------------------

  describe('pinIpHostKey', () => {
    it('calls pinHostKeys with the IP as both domain and ip args (IP-only pinning)', async () => {
      const calls: {domain: string; ip: string; marker: string}[] = []
      const fakePinHostKeys = async (domain: string, ip: string, _path: string, opts: {marker: string}) => {
        calls.push({domain, ip, marker: opts.marker})
      }
      await pinIpHostKey('1.2.3.4', '/fake/known_hosts', fakePinHostKeys)
      expect(calls).toHaveLength(1)
      // IP-only: both domain and ip args are the IP address
      expect(calls[0]?.domain).toBe('1.2.3.4')
      expect(calls[0]?.ip).toBe('1.2.3.4')
    })

    it('fails closed when pinHostKeys throws', async () => {
      const failingPinHostKeys = async () => {
        throw new Error('ssh-keyscan failed')
      }
      await expect(pinIpHostKey('1.2.3.4', '/fake/known_hosts', failingPinHostKeys)).rejects.toThrow(
        'ssh-keyscan failed',
      )
    })
  })

  // -------------------------------------------------------------------------
  // performProvisioning — full orchestration seam
  // -------------------------------------------------------------------------

  describe('performProvisioning', () => {
    it('happy path: runs full provisioning sequence in order', async () => {
      // Fresh instance: GetStaticIpCommand throws "not found" on first call (existence check),
      // then AllocateStaticIpCommand allocates, then GetStaticIpCommand returns the IP.
      const calls: FakeCall[] = []
      let getStaticIpCallCount = 0
      const customSend = (async (command: {constructor: {name: string}; input: Record<string, unknown>}) => {
        const name = command.constructor.name as CommandName
        calls.push({commandName: name, input: command.input})
        if (name === 'GetStaticIpCommand') {
          getStaticIpCallCount++
          if (getStaticIpCallCount === 1) {
            // First call: existence check — IP does not exist yet
            throw new Error('Static IP not found')
          }
          // Second call: after allocation — return the IP
          return FAKE_STATIC_IP
        }
        const fakeResponses: Partial<Record<CommandName, unknown>> = {
          GetInstancesCommand: {instances: []},
          ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
          GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
          GetBundlesCommand: {bundles: FAKE_BUNDLES},
          CreateInstancesCommand: {operations: [{status: 'Succeeded'}]},
          GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
          AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
          AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
          PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
        }
        if (name in fakeResponses) return fakeResponses[name]
        throw new Error(`Unexpected command: ${name}`)
      }) as unknown as LightsailSendFn

      const callOrder: string[] = []
      const deps: ProvisionDeps = {
        send: customSend,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {
          callOrder.push('waitForSsh')
        },
        runSsh: async (cmd: string) => {
          callOrder.push(`runSsh:${cmd.includes('wireguard') ? 'wireguard' : cmd}`)
        },
        pinHostKeys: async () => {
          callOrder.push('pinHostKeys')
        },
        printIp: () => {
          callOrder.push('printIp')
        },
      }

      await performProvisioning(deps)

      // Verify command sequence — new order includes GetStaticIpCommand (existence check) before AllocateStaticIpCommand
      const commandNames = calls.map(c => c.commandName)
      expect(commandNames[0]).toBe('GetInstancesCommand')
      expect(commandNames[1]).toBe('ImportKeyPairCommand')
      expect(commandNames[2]).toBe('GetBlueprintsCommand')
      expect(commandNames[3]).toBe('GetBundlesCommand')
      expect(commandNames[4]).toBe('CreateInstancesCommand')
      expect(commandNames[5]).toBe('GetInstanceCommand') // poll
      expect(commandNames[6]).toBe('GetStaticIpCommand') // existence check (throws not-found)
      expect(commandNames[7]).toBe('AllocateStaticIpCommand') // allocate fresh
      expect(commandNames[8]).toBe('AttachStaticIpCommand')
      expect(commandNames[9]).toBe('GetStaticIpCommand') // get IP after allocation
      expect(commandNames[10]).toBe('PutInstancePublicPortsCommand')

      // WireGuard install runs before pinHostKeys
      const wgIdx = callOrder.findIndex(c => c.includes('wireguard'))
      const pinIdx = callOrder.indexOf('pinHostKeys')
      expect(wgIdx).toBeGreaterThanOrEqual(0)
      expect(pinIdx).toBeGreaterThan(wgIdx)

      // printIp is called
      expect(callOrder).toContain('printIp')
    })

    it('firewall ruleset contains exactly SSH 22 (tcp) AND UDP 51820 (udp)', async () => {
      const {send, calls} = makeFakeSend({
        GetInstancesCommand: {instances: []},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
        CreateInstancesCommand: {operations: [{status: 'Succeeded'}]},
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
        AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        GetStaticIpCommand: FAKE_STATIC_IP,
        PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
      })

      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await performProvisioning(deps)

      const putCall = calls.find(c => c.commandName === 'PutInstancePublicPortsCommand')
      expect(putCall).toBeDefined()
      const portInfos = putCall?.input.portInfos as {fromPort: number; toPort: number; protocol: string}[]
      expect(portInfos).toHaveLength(2)

      const sshRule = portInfos.find(p => p.fromPort === 22 && p.toPort === 22 && p.protocol === 'tcp')
      const wgRule = portInfos.find(p => p.fromPort === 51820 && p.toPort === 51820 && p.protocol === 'udp')

      expect(sshRule).toBeDefined()
      expect(wgRule).toBeDefined()
    })

    it('aborts without creating when instance already exists and no --force', async () => {
      const {send, calls} = makeFakeSend({
        GetInstancesCommand: {instances: [{name: 'fro-bot-vpn', state: {name: 'running'}}]},
      })

      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await expect(performProvisioning(deps)).rejects.toThrow(/already exists/)

      // Only GetInstancesCommand should have been called — no CreateInstances
      const commandNames = calls.map(c => c.commandName)
      expect(commandNames).not.toContain('CreateInstancesCommand')
    })

    it('proceeds with repair when instance already exists with --force (skips re-create, repairs static IP + firewall)', async () => {
      // Plan: "Existing instance → abort unless --force; if instance exists but static IP/firewall missing → repair."
      // --force allows proceeding with repair; it does NOT re-create the instance.
      // Static IP already exists in this scenario — GetStaticIpCommand returns it, so AllocateStaticIpCommand is skipped.
      const {send, calls} = makeFakeSend({
        GetInstancesCommand: {instances: [{name: 'fro-bot-vpn', state: {name: 'running'}}]},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
        // Static IP already exists — GetStaticIpCommand returns it (idempotent: no AllocateStaticIpCommand)
        GetStaticIpCommand: FAKE_STATIC_IP,
        AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
      })

      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        force: true,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await performProvisioning(deps)

      const commandNames = calls.map(c => c.commandName)
      // Instance already exists → skip re-create (repair path)
      expect(commandNames).not.toContain('CreateInstancesCommand')
      // Static IP already exists → AllocateStaticIpCommand is NOT called (idempotent)
      expect(commandNames).not.toContain('AllocateStaticIpCommand')
      // Attach and firewall are still applied
      expect(commandNames).toContain('AttachStaticIpCommand')
      expect(commandNames).toContain('PutInstancePublicPortsCommand')
    })

    it('--force repair: skips AllocateStaticIpCommand when static IP already exists (idempotent)', async () => {
      // Static IP already exists — GetStaticIpCommand returns it without throwing.
      // AllocateStaticIpCommand must NOT be called; AttachStaticIpCommand is safe to call.
      const {send, calls} = makeFakeSend({
        GetInstancesCommand: {instances: [{name: 'fro-bot-vpn', state: {name: 'running'}}]},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
        // GetStaticIpCommand returns the existing IP — no allocation needed
        GetStaticIpCommand: FAKE_STATIC_IP,
        AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
      })

      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        force: true,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await performProvisioning(deps)

      const commandNames = calls.map(c => c.commandName)
      // Static IP already exists → must NOT allocate again
      expect(commandNames).not.toContain('AllocateStaticIpCommand')
      // Attach is idempotent — still called
      expect(commandNames).toContain('AttachStaticIpCommand')
      // Provisioning must have succeeded (printIp would have been called)
    })

    it('repairs missing static IP without re-creating the instance', async () => {
      // Instance exists but static IP is missing — GetStaticIpCommand throws not-found on first call,
      // so AllocateStaticIpCommand is called, then GetStaticIpCommand returns the IP after allocation.
      const calls: FakeCall[] = []
      let getStaticIpCallCount = 0
      const customSend = (async (command: {constructor: {name: string}; input: Record<string, unknown>}) => {
        const name = command.constructor.name as CommandName
        calls.push({commandName: name, input: command.input})
        if (name === 'GetStaticIpCommand') {
          getStaticIpCallCount++
          if (getStaticIpCallCount === 1) {
            // First call: existence check — IP does not exist
            throw new Error('Static IP not found')
          }
          // Second call: after allocation
          return FAKE_STATIC_IP
        }
        const fakeResponses: Partial<Record<CommandName, unknown>> = {
          GetInstancesCommand: {instances: [{name: 'fro-bot-vpn', state: {name: 'running'}, isStaticIp: false}]},
          ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
          GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
          GetBundlesCommand: {bundles: FAKE_BUNDLES},
          GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
          AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
          AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
          PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
        }
        if (name in fakeResponses) return fakeResponses[name]
        throw new Error(`Unexpected command: ${name}`)
      }) as unknown as LightsailSendFn

      const deps: ProvisionDeps = {
        send: customSend,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        force: true, // force to allow repair
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await performProvisioning(deps)

      const commandNames = calls.map(c => c.commandName)
      // Should NOT re-create the instance
      expect(commandNames).not.toContain('CreateInstancesCommand')
      // Static IP was missing → AllocateStaticIpCommand must be called
      expect(commandNames).toContain('AllocateStaticIpCommand')
      expect(commandNames).toContain('AttachStaticIpCommand')
    })

    it('ImportKeyPair "already exists" error is swallowed and provisioning continues', async () => {
      let importCalled = false
      const alreadyExistsError = Object.assign(new Error('Key pair already exists'), {
        name: 'InvalidInputException',
        message: 'Key pair already exists',
      })

      const customSend = (async (command: {constructor: {name: string}}) => {
        const name = command.constructor.name
        if (name === 'ImportKeyPairCommand') {
          importCalled = true
          throw alreadyExistsError
        }
        const fakeResponses: Record<string, unknown> = {
          GetInstancesCommand: {instances: []},
          GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
          GetBundlesCommand: {bundles: FAKE_BUNDLES},
          CreateInstancesCommand: {operations: [{status: 'Succeeded'}]},
          GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
          AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
          AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
          GetStaticIpCommand: FAKE_STATIC_IP,
          PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
        }
        if (name in fakeResponses) return fakeResponses[name]
        throw new Error(`Unexpected: ${name}`)
      }) as unknown as LightsailSendFn

      const deps: ProvisionDeps = {
        send: customSend,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      // Should not throw despite ImportKeyPair "already exists" error
      await expect(performProvisioning(deps)).resolves.toBeUndefined()
      expect(importCalled).toBe(true)
    })

    it('WireGuard install command uses sudo apt-get and DEBIAN_FRONTEND=noninteractive', async () => {
      const {send} = makeFakeSend({
        GetInstancesCommand: {instances: []},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
        CreateInstancesCommand: {operations: [{status: 'Succeeded'}]},
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
        AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        GetStaticIpCommand: FAKE_STATIC_IP,
        PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
      })

      const sshCalls: string[] = []
      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async (cmd: string) => {
          sshCalls.push(cmd)
        },
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await performProvisioning(deps)

      expect(sshCalls.length).toBeGreaterThan(0)
      const installCmd = sshCalls.find(c => c.includes('wireguard'))
      expect(installCmd).toBeDefined()
      // Must use sudo for privileged apt-get
      expect(installCmd).toMatch(/sudo apt-get/)
      // Must be non-interactive to avoid hanging in CI
      expect(installCmd).toMatch(/DEBIAN_FRONTEND=noninteractive/)
    })

    it('WireGuard install step runs before any wg/key generation', async () => {
      const {send} = makeFakeSend({
        GetInstancesCommand: {instances: []},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
        CreateInstancesCommand: {operations: [{status: 'Succeeded'}]},
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
        AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        GetStaticIpCommand: FAKE_STATIC_IP,
        PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
      })

      const sshCalls: string[] = []
      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async (cmd: string) => {
          sshCalls.push(cmd)
        },
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await performProvisioning(deps)

      // WireGuard install must be the first SSH call
      expect(sshCalls.length).toBeGreaterThan(0)
      expect(sshCalls[0]).toContain('wireguard')
      expect(sshCalls[0]).toContain('apt-get')
    })

    it('throws actionable error when blueprint list is empty (no CreateInstances call)', async () => {
      const {send, calls} = makeFakeSend({
        GetInstancesCommand: {instances: []},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: []}, // empty!
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
      })

      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await expect(performProvisioning(deps)).rejects.toThrow(/No active Ubuntu blueprint/)
      const commandNames = calls.map(c => c.commandName)
      expect(commandNames).not.toContain('CreateInstancesCommand')
    })

    it('throws actionable error when bundle list is empty (no CreateInstances call)', async () => {
      const {send, calls} = makeFakeSend({
        GetInstancesCommand: {instances: []},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: []}, // empty!
      })

      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await expect(performProvisioning(deps)).rejects.toThrow(/No active LINUX_UNIX bundle/)
      const commandNames = calls.map(c => c.commandName)
      expect(commandNames).not.toContain('CreateInstancesCommand')
    })

    it('host-key pinning failure causes provisioning to fail closed', async () => {
      const {send} = makeFakeSend({
        GetInstancesCommand: {instances: []},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
        CreateInstancesCommand: {operations: [{status: 'Succeeded'}]},
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
        AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        GetStaticIpCommand: FAKE_STATIC_IP,
        PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
      })

      let printIpCalled = false
      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {
          throw new Error('ssh-keyscan failed: connection refused')
        },
        printIp: () => {
          printIpCalled = true
        },
      }

      await expect(performProvisioning(deps)).rejects.toThrow(/ssh-keyscan failed/)
      // printIp must NOT have been called (fail closed — do not report success)
      expect(printIpCalled).toBe(false)
    })

    it('allocated static IP is printed for the operator', async () => {
      const {send} = makeFakeSend({
        GetInstancesCommand: {instances: []},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
        CreateInstancesCommand: {operations: [{status: 'Succeeded'}]},
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
        AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        GetStaticIpCommand: FAKE_STATIC_IP,
        PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
      })

      let printedIp: string | undefined
      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: (ip: string) => {
          printedIp = ip
        },
      }

      await performProvisioning(deps)
      expect(printedIp).toBe('1.2.3.4')
    })

    it('CreateInstancesCommand uses correct availability zone, blueprint, bundle, and key pair', async () => {
      const {send, calls} = makeFakeSend({
        GetInstancesCommand: {instances: []},
        ImportKeyPairCommand: {operation: {status: 'Succeeded'}},
        GetBlueprintsCommand: {blueprints: FAKE_BLUEPRINTS},
        GetBundlesCommand: {bundles: FAKE_BUNDLES},
        CreateInstancesCommand: {operations: [{status: 'Succeeded'}]},
        GetInstanceCommand: {instance: {name: 'fro-bot-vpn', state: {name: 'running'}}},
        AllocateStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        AttachStaticIpCommand: {operations: [{status: 'Succeeded'}]},
        GetStaticIpCommand: FAKE_STATIC_IP,
        PutInstancePublicPortsCommand: {operation: {status: 'Succeeded'}},
      })

      const deps: ProvisionDeps = {
        send,
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com',
        privateKey: FAKE_PRIVATE_KEY,
        knownHostsPath: '/fake/.github/known_hosts',
        pollIntervalMs: 0,
        waitForSsh: async () => {},
        runSsh: async () => {},
        pinHostKeys: async () => {},
        printIp: () => {},
      }

      await performProvisioning(deps)

      const createCall = calls.find(c => c.commandName === 'CreateInstancesCommand')
      expect(createCall).toBeDefined()
      expect(createCall?.input.availabilityZone).toBe('eu-west-1a')
      expect(createCall?.input.blueprintId).toBe('ubuntu_24_04')
      expect(createCall?.input.bundleId).toBe('nano_3_0')
      expect(createCall?.input.keyPairName).toBe('fro-bot-vpn')
      expect(createCall?.input.instanceNames).toEqual(['fro-bot-vpn'])
    })
  })
})
