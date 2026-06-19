import {existsSync} from 'node:fs'

import {dropletExists} from '@marcusrbrown/infra-shared/server/droplet-helpers'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {validateGatewayHost} from '../src/host'
import {
  checkDropletExistence,
  establishSshAccess,
  getFirewallVpcState,
  getGatewaySshFingerprint,
  parseProvisionArgs,
  ruleHas9300FromDroplet,
  setupOperatorFirewall,
  validateRequiredEnv,
} from './provision-droplet'

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const managedEnvKeys = ['DIGITALOCEAN_ACCESS_TOKEN', 'GATEWAY_HOST', 'GATEWAY_SSH_KEY', 'GATEWAY_SSH_KEY_NAME'] as const
type ManagedEnvKey = (typeof managedEnvKeys)[number]

let savedEnv: Partial<Record<ManagedEnvKey, string | undefined>>

function saveEnv(): void {
  savedEnv = Object.fromEntries(managedEnvKeys.map(k => [k, process.env[k]]))
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

// ---------------------------------------------------------------------------
// Spawn mock helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

function makeSpawnResult(stdout: string, exitCode: number): SpawnResult {
  const enc = new TextEncoder()
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(stdout))
        controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
    exited: Promise.resolve(exitCode),
  }
}

// A fake private key for testing — not a real key, just realistic shape
const FAKE_PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakebase64content\n-----END OPENSSH PRIVATE KEY-----'

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
        DIGITALOCEAN_ACCESS_TOKEN: 'tok_abc',
        GATEWAY_HOST: 'gateway.example.com',
      })

      expect(missing).toEqual([])
    })

    it('returns DIGITALOCEAN_ACCESS_TOKEN when it is missing', () => {
      const missing = validateRequiredEnv({
        GATEWAY_HOST: 'gateway.example.com',
      })

      expect(missing).toContain('DIGITALOCEAN_ACCESS_TOKEN')
    })

    it('returns GATEWAY_HOST when it is missing', () => {
      const missing = validateRequiredEnv({
        DIGITALOCEAN_ACCESS_TOKEN: 'tok_abc',
      })

      expect(missing).toContain('GATEWAY_HOST')
    })

    it('returns both vars when both are missing', () => {
      const missing = validateRequiredEnv({})

      expect(missing).toContain('DIGITALOCEAN_ACCESS_TOKEN')
      expect(missing).toContain('GATEWAY_HOST')
    })
  })

  // -------------------------------------------------------------------------
  // dropletExists (gateway-specific usage)
  // -------------------------------------------------------------------------

  describe('dropletExists', () => {
    it('returns true when the gateway droplet is listed', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('gateway\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const result = await dropletExists('gateway')

      expect(result).toBe(true)
      spawnSpy.mockRestore()
    })

    it('returns false when the gateway droplet is not listed', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('other-droplet\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const result = await dropletExists('gateway')

      expect(result).toBe(false)
      spawnSpy.mockRestore()
    })

    it('returns false when the droplet list is empty', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(makeSpawnResult('', 0) as ReturnType<typeof Bun.spawn>)

      const result = await dropletExists('gateway')

      expect(result).toBe(false)
      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // checkDropletExistence
  // -------------------------------------------------------------------------

  describe('checkDropletExistence', () => {
    it('returns machine-readable existence state without provisioning side effects', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('gateway\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const state = await checkDropletExistence('gateway')

      expect(state).toEqual({name: 'gateway', exists: true})
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      expect(spawnSpy.mock.calls[0]?.[0]).toEqual([
        'doctl',
        'compute',
        'droplet',
        'list',
        '--format',
        'Name',
        '--no-header',
      ])

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // parseProvisionArgs
  // -------------------------------------------------------------------------

  describe('parseProvisionArgs', () => {
    it('parses supported flags', () => {
      expect(parseProvisionArgs(['--force', '--check-exists'])).toEqual({force: true, checkExists: true})
      expect(parseProvisionArgs([])).toEqual({force: false, checkExists: false})
    })

    it('rejects unknown arguments instead of silently ignoring them', () => {
      expect(() => parseProvisionArgs(['--check'])).toThrow(/Unknown provision argument/)
    })
  })

  // -------------------------------------------------------------------------
  // getGatewaySshFingerprint (gateway-specific wrapper)
  // -------------------------------------------------------------------------

  const MULTI_KEY_OUTPUT = [
    'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
    'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
    'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
    'fro-bot-gateway                                       e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
  ].join('\n')

  describe('getGatewaySshFingerprint', () => {
    it('uses fro-bot-gateway as the default key name when no argument is provided', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getGatewaySshFingerprint()

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')

      spawnSpy.mockRestore()
    })

    it('uses GATEWAY_SSH_KEY_NAME env var when no argument is passed', async () => {
      process.env.GATEWAY_SSH_KEY_NAME = 'custom-key-name'

      const customKeyOutput = [
        'fro-bot-gateway                                       e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
        'custom-key-name                                       aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
      ].join('\n')

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(customKeyOutput, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getGatewaySshFingerprint()

      expect(fp).toBe('aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99')
      expect(fp).not.toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')

      spawnSpy.mockRestore()
    })

    it('matches the named key when explicitly passed', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getGatewaySshFingerprint('fro-bot-gateway')

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')
      expect(fp).not.toBe('91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9')

      spawnSpy.mockRestore()
    })

    it('throws when the named key is not found', async () => {
      const threeOtherKeys = [
        'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
        'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
        'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
      ].join('\n')

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValueOnce(
        makeSpawnResult(threeOtherKeys, 0) as ReturnType<typeof Bun.spawn>,
      )

      await expect(getGatewaySshFingerprint('fro-bot-gateway')).rejects.toThrow(/not found/)

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // validateGatewayHost — provision script must call this before pinHostKeys
  // -------------------------------------------------------------------------

  describe('validateGatewayHost (provision security invariant)', () => {
    it('accepts a valid hostname', () => {
      expect(validateGatewayHost('gateway.example.com')).toBe('gateway.example.com')
    })

    it('throws on empty string', () => {
      expect(() => validateGatewayHost('')).toThrow(/empty/)
    })

    it('throws on a value starting with a dash (ssh flag injection)', () => {
      expect(() => validateGatewayHost('-oProxyCommand=evil')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('throws on a value containing shell metacharacters (semicolon)', () => {
      expect(() => validateGatewayHost('host;rm -rf /')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('throws on a value containing a space', () => {
      expect(() => validateGatewayHost('host name')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('throws on a value containing backtick command substitution', () => {
      expect(() => validateGatewayHost('host`id`')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('throws on a value containing a newline', () => {
      expect(() => validateGatewayHost('host\nENVFILE\nevil')).toThrow(/Invalid GATEWAY_HOST/)
    })
  })

  // -------------------------------------------------------------------------
  // Integration-level: idempotency guard (no --force)
  // -------------------------------------------------------------------------

  describe('idempotency guard', () => {
    it('dropletExists returns true → caller can detect and abort without --force', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('gateway\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const exists = await dropletExists('gateway')
      expect(exists).toBe(true)

      // Simulate the abort logic: exists && !force → would exit
      const force = false
      const wouldAbort = exists && !force
      expect(wouldAbort).toBe(true)

      spawnSpy.mockRestore()
    })

    it('dropletExists returns true but --force bypasses the guard', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('gateway\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const exists = await dropletExists('gateway')
      expect(exists).toBe(true)

      const force = true
      const wouldAbort = exists && !force
      expect(wouldAbort).toBe(false)

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // establishSshAccess — SSH identity seam
  // -------------------------------------------------------------------------

  describe('SSH access establishment', () => {
    it('passes identity file to waitForSsh when key material is provided', async () => {
      let capturedPath: string | undefined
      let fileExistedDuringCall = false

      const fakeWaitForSsh = async (host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedPath = opts?.identityFile
        // Assert the file actually exists at call time (before finally cleanup)
        fileExistedDuringCall = capturedPath !== undefined && existsSync(capturedPath)
        expect(host).toBe('1.2.3.4')
      }

      await establishSshAccess('1.2.3.4', FAKE_PRIVATE_KEY, {waitForSsh: fakeWaitForSsh})

      // Path must have been a non-empty string
      expect(capturedPath).toBeTruthy()
      expect(capturedPath).not.toBe('')
      // The file must have existed at the moment waitForSsh was called
      expect(fileExistedDuringCall).toBe(true)
      // After the call, the finally block must have cleaned it up
      expect(existsSync(capturedPath ?? '')).toBe(false)
    })

    it('does not pass identity file to waitForSsh when no key material is given', async () => {
      const capturedOpts: ({identityFile?: string} | undefined)[] = []
      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedOpts.push(opts)
      }

      await establishSshAccess('1.2.3.4', undefined, {waitForSsh: fakeWaitForSsh})

      expect(capturedOpts).toHaveLength(1)
      expect(capturedOpts[0]?.identityFile).toBeUndefined()
    })

    it('cleans up the temp key file even when waitForSsh throws', async () => {
      let capturedPath: string | undefined
      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedPath = opts?.identityFile
        throw new Error('SSH connection failed')
      }

      await expect(establishSshAccess('1.2.3.4', FAKE_PRIVATE_KEY, {waitForSsh: fakeWaitForSsh})).rejects.toThrow(
        'SSH connection failed',
      )

      // File must be cleaned up even though waitForSsh threw
      expect(capturedPath).toBeTruthy()
      expect(existsSync(capturedPath ?? '')).toBe(false)
    })

    it('does not create a temp file when no key material is provided', async () => {
      let capturedPath: string | undefined
      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedPath = opts?.identityFile
      }

      await establishSshAccess('1.2.3.4', undefined, {waitForSsh: fakeWaitForSsh})

      expect(capturedPath).toBeUndefined()
    })

    it('treats a whitespace-only key as absent — no temp file, no SSH -i flag', async () => {
      let capturedOpts: {identityFile?: string} | undefined
      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedOpts = opts
      }

      await establishSshAccess('1.2.3.4', '   \n  ', {waitForSsh: fakeWaitForSsh})

      expect(capturedOpts?.identityFile).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// getFirewallVpcState
// ---------------------------------------------------------------------------

describe('getFirewallVpcState', () => {
  it('returns enabled when both VPC IPs are set', () => {
    expect(getFirewallVpcState({GATEWAY_VPC_IP: '10.116.0.3', DASHBOARD_VPC_IP: '10.116.0.5'})).toBe('enabled')
  })

  it('returns disabled when both VPC IPs are absent', () => {
    expect(getFirewallVpcState({})).toBe('disabled')
  })

  it('returns disabled when both VPC IPs are whitespace-only', () => {
    expect(getFirewallVpcState({GATEWAY_VPC_IP: '   ', DASHBOARD_VPC_IP: ''})).toBe('disabled')
  })

  it('returns misconfigured when only GATEWAY_VPC_IP is set', () => {
    expect(getFirewallVpcState({GATEWAY_VPC_IP: '10.116.0.3'})).toBe('misconfigured')
  })

  it('returns misconfigured when only DASHBOARD_VPC_IP is set', () => {
    expect(getFirewallVpcState({DASHBOARD_VPC_IP: '10.116.0.5'})).toBe('misconfigured')
  })
})

// ---------------------------------------------------------------------------
// ruleHas9300FromDroplet
// ---------------------------------------------------------------------------

describe('ruleHas9300FromDroplet', () => {
  it('matches a rule with exact ports:9300 and the correct droplet_id', () => {
    expect(ruleHas9300FromDroplet('protocol:tcp,ports:9300,droplet_id:222222222', '222222222')).toBe(true)
  })

  it('does not match ports:93000 (prefix false-match guard)', () => {
    expect(ruleHas9300FromDroplet('protocol:tcp,ports:93000,droplet_id:222222222', '222222222')).toBe(false)
  })

  it('does not match when droplet_id is wrong', () => {
    expect(ruleHas9300FromDroplet('protocol:tcp,ports:9300,droplet_id:999999999', '222222222')).toBe(false)
  })

  it('does not match when only ports:9300 is present (no droplet_id)', () => {
    expect(ruleHas9300FromDroplet('protocol:tcp,ports:9300,address:0.0.0.0/0', '222222222')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// setupOperatorFirewall
// ---------------------------------------------------------------------------

describe('setupOperatorFirewall', () => {
  const GATEWAY_DROPLET_ID = '111111111'
  const DASHBOARD_DROPLET_ID = '222222222'
  const FIREWALL_ID = 'fw-test-id'

  it('skips silently when both VPC IPs are absent', async () => {
    const runCaptureCalls: string[][] = []
    const runCalls: string[][] = []

    await setupOperatorFirewall(
      GATEWAY_DROPLET_ID,
      {},
      {
        runCaptureFn: async cmd => {
          runCaptureCalls.push(cmd)
          return ''
        },
        runFn: async (_label, cmd) => {
          runCalls.push(cmd)
        },
      },
    )

    // No doctl firewall calls when VPC is disabled
    expect(runCaptureCalls.some(c => c.join(' ').includes('firewall'))).toBe(false)
    expect(runCalls.some(c => c.join(' ').includes('firewall'))).toBe(false)
  })

  it('warns and skips when only one VPC IP is set (misconfiguration)', async () => {
    const runCaptureCalls: string[][] = []
    const runCalls: string[][] = []

    await setupOperatorFirewall(
      GATEWAY_DROPLET_ID,
      {GATEWAY_VPC_IP: '10.116.0.3'},
      {
        runCaptureFn: async cmd => {
          runCaptureCalls.push(cmd)
          return ''
        },
        runFn: async (_label, cmd) => {
          runCalls.push(cmd)
        },
      },
    )

    // No doctl firewall calls on misconfiguration
    expect(runCaptureCalls.some(c => c.join(' ').includes('firewall'))).toBe(false)
    expect(runCalls.some(c => c.join(' ').includes('firewall'))).toBe(false)
  })

  it('warns and skips when dashboard droplet is not found', async () => {
    const runCalls: string[][] = []

    await setupOperatorFirewall(
      GATEWAY_DROPLET_ID,
      {GATEWAY_VPC_IP: '10.116.0.3', DASHBOARD_VPC_IP: '10.116.0.5'},
      {
        runCaptureFn: async cmd => {
          // dashboard droplet get → not found
          if (
            cmd.join(' ').includes('droplet') &&
            cmd.join(' ').includes('get') &&
            cmd.join(' ').includes('dashboard')
          ) {
            return ''
          }
          return ''
        },
        runFn: async (_label, cmd) => {
          runCalls.push(cmd)
        },
      },
    )

    // No firewall create or add-rules when dashboard not found
    expect(runCalls.some(c => c.join(' ').includes('firewall'))).toBe(false)
  })

  it('creates firewall with base rules (22/80/443) + 9300-from-dashboard when no firewall exists', async () => {
    const runCalls: {label: string; cmd: string[]}[] = []

    await setupOperatorFirewall(
      GATEWAY_DROPLET_ID,
      {GATEWAY_VPC_IP: '10.116.0.3', DASHBOARD_VPC_IP: '10.116.0.5'},
      {
        runCaptureFn: async cmd => {
          const cmdStr = cmd.join(' ')
          // dashboard droplet get → returns ID
          if (cmdStr.includes('droplet') && cmdStr.includes('get') && cmdStr.includes('dashboard')) {
            return DASHBOARD_DROPLET_ID
          }
          // list-by-droplet → no existing firewall
          if (cmdStr.includes('firewall') && cmdStr.includes('list-by-droplet')) {
            return ''
          }
          return ''
        },
        runFn: async (label, cmd) => {
          runCalls.push({label, cmd})
        },
      },
    )

    // Must have called firewall create
    const createCall = runCalls.find(c => c.cmd.join(' ').includes('firewall') && c.cmd.join(' ').includes('create'))
    expect(createCall).toBeDefined()

    const createCmdStr = createCall?.cmd.join(' ') ?? ''

    // Must include base rules: 22, 80, 443
    expect(createCmdStr).toContain('ports:22')
    expect(createCmdStr).toContain('ports:80')
    expect(createCmdStr).toContain('ports:443')

    // Must include 9300 from dashboard droplet-id
    expect(createCmdStr).toContain(`ports:9300,droplet_id:${DASHBOARD_DROPLET_ID}`)

    // Must attach to gateway droplet
    expect(createCmdStr).toContain(GATEWAY_DROPLET_ID)

    // Must include outbound rules (gateway needs to reach Discord/S3/cliproxy)
    expect(createCmdStr).toContain('--outbound-rules')
  })

  it('adds only the 9300 rule when firewall exists but rule is missing', async () => {
    const runCalls: {label: string; cmd: string[]}[] = []

    await setupOperatorFirewall(
      GATEWAY_DROPLET_ID,
      {GATEWAY_VPC_IP: '10.116.0.3', DASHBOARD_VPC_IP: '10.116.0.5'},
      {
        runCaptureFn: async cmd => {
          const cmdStr = cmd.join(' ')
          if (cmdStr.includes('droplet') && cmdStr.includes('get') && cmdStr.includes('dashboard')) {
            return DASHBOARD_DROPLET_ID
          }
          if (cmdStr.includes('firewall') && cmdStr.includes('list-by-droplet')) {
            return FIREWALL_ID
          }
          // Existing firewall has 22/80/443 but NOT 9300
          if (cmdStr.includes('firewall') && cmdStr.includes('get') && cmdStr.includes('InboundRules')) {
            return 'protocol:tcp,ports:22,address:0.0.0.0/0 protocol:tcp,ports:80,address:0.0.0.0/0 protocol:tcp,ports:443,address:0.0.0.0/0'
          }
          return ''
        },
        runFn: async (label, cmd) => {
          runCalls.push({label, cmd})
        },
      },
    )

    // Must have called add-rules (not create)
    const addRulesCall = runCalls.find(c => c.cmd.join(' ').includes('add-rules'))
    expect(addRulesCall).toBeDefined()
    expect(addRulesCall?.cmd.join(' ')).toContain(`droplet_id:${DASHBOARD_DROPLET_ID}`)
    expect(addRulesCall?.cmd.join(' ')).toContain('ports:9300')

    // Must NOT have called create
    expect(runCalls.some(c => c.cmd.join(' ').includes('firewall') && c.cmd.join(' ').includes('create'))).toBe(false)
  })

  it('is a no-op when the 9300 rule is already present', async () => {
    const runCalls: string[][] = []

    await setupOperatorFirewall(
      GATEWAY_DROPLET_ID,
      {GATEWAY_VPC_IP: '10.116.0.3', DASHBOARD_VPC_IP: '10.116.0.5'},
      {
        runCaptureFn: async cmd => {
          const cmdStr = cmd.join(' ')
          if (cmdStr.includes('droplet') && cmdStr.includes('get') && cmdStr.includes('dashboard')) {
            return DASHBOARD_DROPLET_ID
          }
          if (cmdStr.includes('firewall') && cmdStr.includes('list-by-droplet')) {
            return FIREWALL_ID
          }
          // Rule already present
          if (cmdStr.includes('firewall') && cmdStr.includes('get') && cmdStr.includes('InboundRules')) {
            return `protocol:tcp,ports:22,address:0.0.0.0/0 protocol:tcp,ports:9300,droplet_id:${DASHBOARD_DROPLET_ID}`
          }
          return ''
        },
        runFn: async (_label, cmd) => {
          runCalls.push(cmd)
        },
      },
    )

    // No mutating calls (no create, no add-rules)
    expect(runCalls.some(c => c.join(' ').includes('firewall'))).toBe(false)
  })
})
