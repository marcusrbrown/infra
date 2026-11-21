import type {PinHostKeysOptions} from '../../../packages/shared/server/droplet-helpers'
import type {ProvisionDeps, ProvisionInput, Runner, RunResult} from './provision'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'
import {
  SENDER_GROUPS,
  TRACES_CONTAINERD_ROOT,
  TRACES_DOCKER_ROOT,
  TRACES_SENTINEL_CONTENT,
  TRACES_SENTINEL_PATH,
  TRACES_TOKEN_ROOT,
  TRACES_VOID_TOKEN_PREFIX,
  TRACES_VOLUME_MOUNT,
  TRACES_VOLUME_NAME,
} from '../src/host'
import {
  bashCommand,
  checkDropletExistence,
  checkTracesStorage,
  defaultDeps,
  dockerConfigFiles,
  evaluateStorageProbe,
  FIREWALL_INBOUND_RULES,
  FIREWALL_NAME,
  fsProbeScript,
  hardeningFiles,
  inboundRule,
  managedFileScript,
  mkfsScript,
  mountScript,
  parseInboundRules,
  parseProvisionArgs,
  parseVolumeRows,
  restoreVolumeName,
  rulePortsCover,
  runProvision,
  runReopen,
  runRestore,
  shellQuote,
  SSH_CONTROL_PERSIST,
  SSH_SCAN_PAUSE_MS,
  tokenCheckScript,
  validateRequiredEnv,
  VOLUME_LIST_ATTEMPTS,
  VOLUME_LIST_INTERVAL_MS,
  volumeDevicePath,
} from './provision'

// ---------------------------------------------------------------------------
// Fakes: a recording runner over a tiny DigitalOcean and host simulation.
// Nothing here spawns a process or touches the network.
// ---------------------------------------------------------------------------

const ok = (stdout = ''): RunResult => ({exitCode: 0, stdout, stderr: ''})
const fail = (stderr: string, exitCode = 1): RunResult => ({exitCode, stdout: '', stderr})

const DROPLET_ID = '1001'
const DROPLET_HOST = 'droplet-ip.invalid'
const WEB_RULE_80 = inboundRule(80)
const WEB_RULE_443 = inboundRule(443)

interface SimVolume {
  id: string
  name: string
  dropletIds: string[]
}

interface SimFirewall {
  id: string
  name: string
  inbound: string[]
  droplets: string[]
}

interface CloudOptions {
  droplet?: boolean
  volumes?: SimVolume[]
  firewalls?: SimFirewall[]
  snapshots?: {id: string; name: string}[]
  /** Returns a reply to short-circuit a doctl call. */
  override?: (args: readonly string[]) => RunResult | undefined
  /** `remove-rules` answers success but changes nothing. */
  removeRulesIgnored?: boolean
  /** `attach` answers success but changes nothing. */
  attachIgnored?: boolean
  /** A volume created by `volume create` is absent from the next N `volume list` calls. */
  newVolumeHiddenForLists?: number
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

class Cloud {
  droplet: boolean
  volumes: SimVolume[]
  firewalls: SimFirewall[]
  snapshots: {id: string; name: string}[]
  private nextId = 1
  private hiddenListsLeft = 0
  private readonly hiddenVolumeIds = new Set<string>()
  constructor(private readonly options: CloudOptions = {}) {
    this.droplet = options.droplet ?? false
    this.volumes = options.volumes ?? []
    this.firewalls = options.firewalls ?? []
    this.snapshots = options.snapshots ?? []
  }

  handle(args: readonly string[]): RunResult {
    const overridden = this.options.override?.(args)
    if (overridden) return overridden
    const key = args.slice(0, 3).join(' ')
    switch (key) {
      case 'compute droplet list': {
        return ok(this.droplet ? 'traces\n' : '')
      }
      case 'compute droplet create': {
        this.droplet = true
        return ok()
      }
      case 'compute droplet get': {
        if (!this.droplet) return fail('not found')
        return ok(flag(args, '--format') === 'ID' ? DROPLET_ID : DROPLET_HOST)
      }
      case 'compute volume list': {
        const hide = this.hiddenListsLeft > 0
        if (hide) this.hiddenListsLeft -= 1
        const visible = this.volumes.filter(v => !(hide && this.hiddenVolumeIds.has(v.id)))
        return ok(visible.map(v => `${v.id}   ${v.name}   [${v.dropletIds.join(' ')}]`).join('\n'))
      }
      case 'compute volume create': {
        const volume = {id: `vol-${this.nextId++}`, name: args[3] ?? '', dropletIds: []}
        this.volumes.push(volume)
        if (this.options.newVolumeHiddenForLists) {
          this.hiddenVolumeIds.add(volume.id)
          this.hiddenListsLeft = this.options.newVolumeHiddenForLists
        }
        return ok(flag(args, '--format') === 'ID' ? volume.id : '')
      }
      case 'compute volume-action attach': {
        if (!this.options.attachIgnored) this.volumes.find(v => v.id === args[3])?.dropletIds.push(args[4] ?? '')
        return ok()
      }
      case 'compute volume-action detach': {
        const volume = this.volumes.find(v => v.id === args[3])
        if (volume) volume.dropletIds = volume.dropletIds.filter(id => id !== args[4])
        return ok()
      }
      case 'compute firewall list': {
        return ok(this.firewalls.map(f => `${f.id}   ${f.name}`).join('\n'))
      }
      case 'compute firewall create': {
        this.firewalls.push({
          id: `fw-${this.nextId++}`,
          name: flag(args, '--name') ?? '',
          inbound: (flag(args, '--inbound-rules') ?? '').split(' '),
          droplets: (flag(args, '--droplet-ids') ?? '').split(','),
        })
        return ok()
      }
      case 'compute firewall list-by-droplet': {
        return ok(
          this.firewalls
            .filter(f => f.droplets.includes(args[3] ?? ''))
            .map(f => f.id)
            .join('\n'),
        )
      }
      case 'compute firewall get': {
        const firewall = this.firewalls.find(f => f.id === args[3])
        return firewall ? ok(firewall.inbound.join(' ')) : fail('firewall not found')
      }
      case 'compute firewall add-droplets': {
        this.firewalls.find(f => f.id === args[3])?.droplets.push(flag(args, '--droplet-ids') ?? '')
        return ok()
      }
      case 'compute firewall add-rules': {
        this.firewalls.find(f => f.id === args[3])?.inbound.push(...(flag(args, '--inbound-rules') ?? '').split(' '))
        return ok()
      }
      case 'compute firewall remove-rules': {
        const firewall = this.firewalls.find(f => f.id === args[3])
        const removed = new Set((flag(args, '--inbound-rules') ?? '').split(' '))
        if (firewall && !this.options.removeRulesIgnored) {
          firewall.inbound = firewall.inbound.filter(rule => !removed.has(rule))
        }
        return ok()
      }
      case 'compute snapshot list': {
        return ok(this.snapshots.map(s => `${s.id}   ${s.name}`).join('\n'))
      }
      default: {
        throw new Error(`unexpected doctl call: ${args.join(' ')}`)
      }
    }
  }
}

const GOOD_STORAGE_OUTPUT = [
  'mount_source=/dev/sda',
  'root_source=/dev/vda1',
  `sentinel=${TRACES_SENTINEL_CONTENT}`,
  `docker_root=${TRACES_DOCKER_ROOT}`,
  `containerd_root=${TRACES_CONTAINERD_ROOT}`,
  'docker_source=/dev/sda',
  'containerd_source=/dev/sda',
  'TRACES_STORAGE_PROBED',
].join('\n')

function storageOutput(overrides: Record<string, string> = {}): string {
  return GOOD_STORAGE_OUTPUT.split('\n')
    .map(line => {
      const key = line.split('=')[0] ?? ''
      return key in overrides ? `${key}=${overrides[key]}` : line
    })
    .join('\n')
}

interface HostOptions {
  /** A host that has already been provisioned. */
  provisioned?: boolean
  fs?: 'none' | 'ext4' | 'other'
  dockerBusy?: boolean
  tokens?: 'deny-all' | 'real' | 'missing-root' | 'file-missing' | 'file-empty'
  storage?: RunResult
}

class Host {
  swapOn: boolean
  files = new Map<string, string>()
  fs: 'none' | 'ext4' | 'other'
  mounted: boolean
  sentinel: boolean
  mkfsCount = 0
  dockerRestarts = 0
  steps: string[] = []
  constructor(private readonly options: HostOptions = {}) {
    const provisioned = options.provisioned ?? false
    this.swapOn = !provisioned
    this.fs = options.fs ?? (provisioned ? 'ext4' : 'none')
    this.mounted = provisioned
    this.sentinel = provisioned
    if (provisioned) {
      for (const file of [...hardeningFiles(), ...dockerConfigFiles()]) this.files.set(file.path, file.content)
    }
  }

  handle(command: string, stdin: string | undefined): RunResult {
    const step = /# traces-step:(\S+)/.exec(command)?.[1] ?? 'unknown'
    this.steps.push(step)
    if (step.startsWith('file:')) {
      const path = step.slice('file:'.length)
      if (this.files.get(path) === stdin) return ok('TRACES_FILE_UNCHANGED')
      this.files.set(path, stdin ?? '')
      return ok('TRACES_FILE_CHANGED')
    }
    switch (step) {
      case 'swap': {
        const changed = this.swapOn
        this.swapOn = false
        return ok(changed ? 'TRACES_SWAP_CHANGED' : 'TRACES_SWAP_UNCHANGED')
      }
      case 'fs-probe': {
        if (this.fs === 'other') return {exitCode: 1, stdout: 'TRACES_FS_OTHER\n', stderr: ''}
        return ok(this.fs === 'none' ? 'TRACES_FS_NONE' : 'TRACES_FS_EXT4')
      }
      case 'mkfs': {
        if (this.fs !== 'none') return {exitCode: 1, stdout: 'TRACES_MKFS_REFUSED\n', stderr: ''}
        this.mkfsCount += 1
        this.fs = 'ext4'
        return ok('TRACES_MKFS_DONE')
      }
      case 'mount': {
        const was = this.mounted
        this.mounted = true
        return ok(was ? 'TRACES_MOUNT_PRESENT' : 'TRACES_MOUNT_DONE')
      }
      case 'sentinel': {
        const was = this.sentinel
        this.sentinel = true
        return ok(was ? 'TRACES_SENTINEL_PRESENT' : 'TRACES_SENTINEL_CREATED')
      }
      case 'verify-sentinel': {
        return this.sentinel ? ok('TRACES_SENTINEL_PRESENT') : fail('TRACES_SENTINEL_UNRECOGNISED')
      }
      case 'dirs': {
        return ok('TRACES_DIRS_OK')
      }
      case 'docker-restart': {
        if (this.options.dockerBusy) return {exitCode: 1, stdout: 'TRACES_DOCKER_BUSY\n', stderr: ''}
        this.dockerRestarts += 1
        return ok('TRACES_DOCKER_RESTARTED')
      }
      case 'storage-probe': {
        return this.options.storage ?? ok(GOOD_STORAGE_OUTPUT)
      }
      case 'restore-quiesce': {
        this.mounted = false
        return ok('TRACES_QUIESCED')
      }
      case 'token-check': {
        const tokens = this.options.tokens ?? 'deny-all'
        if (tokens === 'missing-root') return {exitCode: 1, stdout: 'TRACES_TOKEN_ROOT_MISSING\n', stderr: ''}
        if (tokens === 'file-missing') return {exitCode: 1, stdout: 'TRACES_TOKEN_FILE_MISSING=fro-bot\n', stderr: ''}
        if (tokens === 'file-empty') return {exitCode: 1, stdout: 'TRACES_TOKEN_FILE_EMPTY=workstation\n', stderr: ''}
        return ok(tokens === 'real' ? 'TRACES_TOKENS_REAL' : 'TRACES_TOKENS_DENY_ALL')
      }
      default: {
        throw new Error(`unexpected remote step: ${step}`)
      }
    }
  }
}

interface Call {
  argv: string[]
  stdin: string | undefined
}

/** What `ssh -O exit` does in the simulation: closes the master, finds none, or the runner itself throws. */
type MasterClose = 'closes' | 'no-master' | 'throws'

function isMasterClose(argv: readonly string[]): boolean {
  return argv[0] === 'ssh' && argv.includes('-O')
}

function makeWorld(
  cloudOptions: CloudOptions = {},
  hostOptions: HostOptions = {},
  masterClose: MasterClose = 'closes',
) {
  const cloud = new Cloud(cloudOptions)
  const host = new Host(hostOptions)
  const calls: Call[] = []
  const runner: Runner = async (argv, options) => {
    calls.push({argv: [...argv], stdin: options?.stdin})
    if (argv[0] === 'doctl') return cloud.handle(argv.slice(1))
    if (isMasterClose(argv)) {
      if (masterClose === 'throws') throw new Error('spawn failed')
      return masterClose === 'no-master'
        ? fail('Control socket connect(/tmp/x/cm): No such file or directory', 255)
        : ok()
    }
    if (argv[0] === 'ssh') return host.handle(argv.at(-1) ?? '', options?.stdin)
    throw new Error(`unexpected command: ${argv[0]}`)
  }
  const doctlCalls = () => calls.filter(call => call.argv[0] === 'doctl').map(call => call.argv.slice(1).join(' '))
  const sshCalls = () => calls.filter(call => call.argv[0] === 'ssh' && !isMasterClose(call.argv))
  const sshCommands = () => sshCalls().map(call => call.argv.at(-1) ?? '')
  const closeCalls = () => calls.filter(call => isMasterClose(call.argv))
  return {cloud, host, calls, runner, doctlCalls, sshCalls, sshCommands, closeCalls}
}

function makeDeps(runner: Runner, {keysAlreadyPinned = false}: {keysAlreadyPinned?: boolean} = {}) {
  const logs: string[] = []
  const pins: string[][] = []
  const pinOptions: PinHostKeysOptions[] = []
  const sleeps: number[] = []
  const waits: string[] = []
  const controlDirs: string[] = []
  const removedControlDirs: string[] = []
  const deps: ProvisionDeps = {
    run: runner,
    getSshFingerprint: async keyName => `fingerprint-of-${keyName}`,
    waitForSsh: async host => {
      waits.push(host)
    },
    hostKeysPinned: () => keysAlreadyPinned,
    pinHostKeys: async (domain, ip, path, opts) => {
      pins.push([domain, ip, path, opts.marker])
      pinOptions.push(opts)
    },
    materializeIdentity: () => ({path: '/tmp/fake-identity', cleanup: () => {}}),
    makeControlDir: () => {
      const path = `/tmp/fake-control-${controlDirs.length + 1}`
      controlDirs.push(path)
      return {path, cleanup: () => removedControlDirs.push(path)}
    },
    sleep: async ms => {
      sleeps.push(ms)
    },
    now: () => new Date('2026-11-20T15:30:00Z'),
    log: message => logs.push(message),
  }
  return {deps, logs, pins, pinOptions, sleeps, waits, controlDirs, removedControlDirs}
}

const PROVISION_INPUT: ProvisionInput = {
  tracesHost: 'traces.fro.bot',
  privateKey: 'placeholder-private-key',
  knownHostsPath: '/tmp/known_hosts-placeholder',
  sshKeyName: 'fro-bot-traces',
  remoteUser: 'root',
}

function provisionedCloud(extra: CloudOptions = {}): CloudOptions {
  return {
    droplet: true,
    volumes: [{id: 'vol-old', name: TRACES_VOLUME_NAME, dropletIds: [DROPLET_ID]}],
    firewalls: [{id: 'fw-old', name: FIREWALL_NAME, inbound: [...FIREWALL_INBOUND_RULES], droplets: [DROPLET_ID]}],
    snapshots: [{id: 'snap-1', name: 'traces-data-snap'}],
    ...extra,
  }
}

const DOCKER_CONFIG_PATHS = dockerConfigFiles().map(file => file.path)

function indexOfCall(calls: string[], predicate: (call: string) => boolean): number {
  return calls.findIndex(predicate)
}

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

describe('parseProvisionArgs', () => {
  it('defaults to a plain provision', () => {
    expect(parseProvisionArgs([])).toEqual({kind: 'provision', force: false})
    expect(parseProvisionArgs(['--force'])).toEqual({kind: 'provision', force: true})
  })

  it('parses --check-exists, with or without --force', () => {
    expect(parseProvisionArgs(['--check-exists'])).toEqual({kind: 'check-exists'})
    expect(parseProvisionArgs(['--force', '--check-exists'])).toEqual({kind: 'check-exists'})
  })

  it('rejects unknown arguments instead of silently ignoring them', () => {
    expect(() => parseProvisionArgs(['--unknown'])).toThrow(/Unknown provision argument/)
    expect(() => parseProvisionArgs(['--reopen-port'])).toThrow(/Unknown provision argument/)
  })

  it('parses restore mode in both flag forms', () => {
    expect(parseProvisionArgs(['--restore-snapshot', 'traces-data-snap'])).toEqual({
      kind: 'restore',
      snapshotName: 'traces-data-snap',
    })
    expect(parseProvisionArgs(['--restore-snapshot=traces-data-snap'])).toEqual({
      kind: 'restore',
      snapshotName: 'traces-data-snap',
    })
  })

  it('rejects a missing or unsafe snapshot name', () => {
    expect(() => parseProvisionArgs(['--restore-snapshot'])).toThrow(/snapshot name/)
    expect(() => parseProvisionArgs(['--restore-snapshot', '--force'])).toThrow(/snapshot name/)
    expect(() => parseProvisionArgs(['--restore-snapshot', 'a b'])).toThrow(/snapshot name/)
    expect(() => parseProvisionArgs(['--restore-snapshot=;rm'])).toThrow(/snapshot name/)
  })

  it('parses --reopen-ports', () => {
    expect(parseProvisionArgs(['--reopen-ports'])).toEqual({kind: 'reopen-ports'})
  })

  it('does not let the firewall-changing modes combine with each other or with other flags', () => {
    expect(() => parseProvisionArgs(['--reopen-ports', '--restore-snapshot', 'x'])).toThrow(/cannot be combined/)
    expect(() => parseProvisionArgs(['--reopen-ports', '--force'])).toThrow(/no other flag/)
    expect(() => parseProvisionArgs(['--restore-snapshot', 'x', '--check-exists'])).toThrow(/no other flag/)
  })
})

describe('validateRequiredEnv', () => {
  it('reports what is missing', () => {
    expect(validateRequiredEnv({DIGITALOCEAN_ACCESS_TOKEN: 'placeholder', TRACES_HOST: 'traces.fro.bot'})).toEqual([])
    expect(validateRequiredEnv({})).toEqual(['DIGITALOCEAN_ACCESS_TOKEN', 'TRACES_HOST'])
    expect(validateRequiredEnv({DIGITALOCEAN_ACCESS_TOKEN: 'placeholder'})).toEqual(['TRACES_HOST'])
  })
})

describe('checkDropletExistence', () => {
  it('lists droplets only', async () => {
    const world = makeWorld({droplet: true})
    expect(await checkDropletExistence(world.runner)).toEqual({name: 'traces', exists: true})
    expect(world.doctlCalls()).toEqual(['compute droplet list --format Name --no-header'])
  })
})

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('firewall rule parsing', () => {
  it('reads the combined-address form DigitalOcean prints', () => {
    expect(parseInboundRules(`${inboundRule(22)} ${WEB_RULE_80}`)).toEqual([
      {protocol: 'tcp', ports: '22'},
      {protocol: 'tcp', ports: '80'},
    ])
  })

  it('treats `all`, an empty field and a covering range as admitting the port', () => {
    expect(rulePortsCover({protocol: 'tcp', ports: 'all'}, 443)).toBe(true)
    expect(rulePortsCover({protocol: 'tcp', ports: '0'}, 443)).toBe(true)
    expect(rulePortsCover({protocol: 'tcp', ports: ''}, 443)).toBe(true)
    expect(rulePortsCover({protocol: 'tcp', ports: '400-500'}, 443)).toBe(true)
    expect(rulePortsCover({protocol: 'tcp', ports: '8000-9000'}, 443)).toBe(false)
    expect(rulePortsCover({protocol: 'tcp', ports: '22'}, 443)).toBe(false)
    expect(rulePortsCover({protocol: 'icmp', ports: ''}, 443)).toBe(false)
  })

  it('fails closed on a token that is not a rule', () => {
    expect(() => parseInboundRules('garbage')).toThrow(/Unrecognised firewall rule/)
  })
})

describe('parseVolumeRows', () => {
  it('reads id, name and attached droplet ids', () => {
    expect(parseVolumeRows('vol-1   traces-data   [1001]\nvol-2   other   []')).toEqual([
      {id: 'vol-1', name: 'traces-data', dropletIds: ['1001']},
      {id: 'vol-2', name: 'other', dropletIds: []},
    ])
  })
})

// ---------------------------------------------------------------------------
// First provision
// ---------------------------------------------------------------------------

async function runFirstProvision() {
  const world = makeWorld({}, {})
  const harness = makeDeps(world.runner)
  await runProvision(PROVISION_INPUT, false, harness.deps)
  return {world, ...harness}
}

describe('runProvision on an empty account', () => {
  it('creates the droplet with the planned size, region and image, with backups off', async () => {
    const {world} = await runFirstProvision()
    const create = world.calls.find(c => c.argv.slice(1, 4).join(' ') === 'compute droplet create')
    expect(create?.argv).toEqual([
      'doctl',
      'compute',
      'droplet',
      'create',
      'traces',
      '--image',
      'docker-20-04',
      '--size',
      's-4vcpu-16gb-amd',
      '--region',
      'nyc1',
      '--ssh-keys',
      'fingerprint-of-fro-bot-traces',
      '--wait',
    ])
    expect(create?.argv.join(' ')).not.toMatch(/backups/)
  })

  it('creates a 100 GiB volume in the droplet region and attaches it before any SSH step', async () => {
    const {world} = await runFirstProvision()
    const doctl = world.doctlCalls()
    expect(doctl).toContain('compute volume create traces-data --region nyc1 --size 100GiB')
    const attachIndex = indexOfCall(doctl, call => call.startsWith('compute volume-action attach'))
    expect(attachIndex).toBeGreaterThan(-1)
    const firstSsh = world.calls.findIndex(c => c.argv[0] === 'ssh')
    const attachCall = world.calls.findIndex(c => c.argv.slice(1, 3).join(' ') === 'compute volume-action')
    expect(attachCall).toBeLessThan(firstSsh)
    expect(world.cloud.volumes[0]?.dropletIds).toEqual([DROPLET_ID])
  })

  it('creates a firewall with inbound 22, 80 and 443 and nothing else, attached to the droplet', async () => {
    const {world} = await runFirstProvision()
    const create = world.calls.find(c => c.argv.slice(1, 4).join(' ') === 'compute firewall create')?.argv ?? []
    const inbound = create[create.indexOf('--inbound-rules') + 1]?.split(' ') ?? []
    const parsed = parseInboundRules(inbound.join(' '))
    expect(parsed.map(rule => `${rule.protocol}/${rule.ports}`).toSorted()).toEqual(['tcp/22', 'tcp/443', 'tcp/80'])
    expect(inbound).toHaveLength(3)
    for (const rule of inbound) expect(rule).toContain('address:0.0.0.0/0,address:::/0')
    expect(create[create.indexOf('--droplet-ids') + 1]).toBe(DROPLET_ID)
    expect(create[create.indexOf('--name') + 1]).toBe('traces-fw')
    // Outbound stays open: DO firewalls are default-deny in both directions.
    expect(create.indexOf('--outbound-rules')).toBeGreaterThan(-1)
  })

  it('runs the host steps in order: format once, mount, sentinel, Docker config, restart, storage check', async () => {
    const {world} = await runFirstProvision()
    const steps = world.host.steps
    const at = (name: string) => steps.indexOf(name)
    expect(at('fs-probe')).toBeLessThan(at('mkfs'))
    expect(at('mkfs')).toBeLessThan(at('mount'))
    expect(at('mount')).toBeLessThan(at('sentinel'))
    expect(at('sentinel')).toBeLessThan(at('dirs'))
    expect(at('dirs')).toBeLessThan(at(`file:${DOCKER_CONFIG_PATHS[0]}`))
    expect(at(`file:${DOCKER_CONFIG_PATHS[3]}`)).toBeLessThan(at('docker-restart'))
    expect(at('docker-restart')).toBeLessThan(at('storage-probe'))
    expect(steps.at(-1)).toBe('storage-probe')
    expect(world.host.mkfsCount).toBe(1)
    expect(world.host.dockerRestarts).toBe(1)
  })

  it('applies the host hardening before touching the volume', async () => {
    const {world} = await runFirstProvision()
    const steps = world.host.steps
    expect(steps.indexOf('swap')).toBeLessThan(steps.indexOf('fs-probe'))
    for (const file of hardeningFiles()) {
      expect(world.host.files.get(file.path)).toBe(file.content)
      expect(steps.indexOf(`file:${file.path}`)).toBeLessThan(steps.indexOf('fs-probe'))
    }
  })

  it('pins host keys for the hostname and the droplet address, then prints the operator steps', async () => {
    const {pins, waits, logs} = await runFirstProvision()
    expect(waits).toEqual([DROPLET_HOST])
    expect(pins).toEqual([
      [
        'traces.fro.bot',
        DROPLET_HOST,
        '/tmp/known_hosts-placeholder',
        `# traces droplet (${DROPLET_HOST} / traces.fro.bot)`,
      ],
    ])
    const output = logs.join('\n')
    expect(output).toContain('TRACES_SSH_KEY')
    expect(output).toContain('known_hosts')
    expect(output).toContain('A record')
  })

  it('asks the host-key pin to pause 35 seconds before each scan, for the image SSH rate limit', async () => {
    const {pinOptions} = await runFirstProvision()
    expect(SSH_SCAN_PAUSE_MS).toBe(35_000)
    expect(pinOptions).toHaveLength(1)
    expect(pinOptions[0]?.pauseBeforeScanMs).toBe(SSH_SCAN_PAUSE_MS)
  })

  it('waits again after a scan, before the first remote step, so the control master opens in a fresh window', async () => {
    const world = makeWorld()
    const order: string[] = []
    const {deps} = makeDeps(async (argv, options) => {
      if (argv[0] === 'ssh' && !isMasterClose(argv)) order.push('ssh')
      return world.runner(argv, options)
    })
    deps.waitForSsh = async () => {
      order.push('waitForSsh')
    }
    deps.pinHostKeys = async () => {
      order.push('pin')
    }
    deps.sleep = async ms => {
      if (ms === SSH_SCAN_PAUSE_MS) order.push(`sleep:${ms}`)
    }
    await runProvision(PROVISION_INPUT, false, deps)
    expect(order.slice(0, 4)).toEqual(['waitForSsh', 'pin', `sleep:${SSH_SCAN_PAUSE_MS}`, 'ssh'])
    expect(order.filter(entry => entry.startsWith('sleep:'))).toHaveLength(1)
  })

  it('does not wait after pinning when the keys were already pinned, so a re-run stays fast', async () => {
    const world = makeWorld()
    const {deps, sleeps} = makeDeps(world.runner, {keysAlreadyPinned: true})
    await runProvision(PROVISION_INPUT, false, deps)
    expect(sleeps.filter(ms => ms === SSH_SCAN_PAUSE_MS)).toEqual([])
    expect(world.sshCalls().length).toBeGreaterThan(0)
  })

  it('lists TRACES_HOST under the secrets, not under variables', async () => {
    const {logs} = await runFirstProvision()
    const output = logs.join('\n')
    expect(output).not.toContain('Required variables')
    expect(output.indexOf('Required secrets:')).toBeGreaterThan(-1)
    expect(output.indexOf('Required secrets:')).toBeLessThan(output.indexOf('TRACES_HOST '))
  })

  it('refuses a host value that could be read as an ssh option', async () => {
    const world = makeWorld()
    const {deps} = makeDeps(world.runner)
    await expect(runProvision({...PROVISION_INPUT, tracesHost: '-oProxyCommand=evil'}, false, deps)).rejects.toThrow(
      /Invalid TRACES_HOST/,
    )
    expect(world.calls).toHaveLength(0)
  })
})

describe('a new volume that is slow to appear in the listing', () => {
  it('waits and lists again until the volume shows up, sleeping between listings only', async () => {
    const world = makeWorld({newVolumeHiddenForLists: 3})
    const {deps, sleeps} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)
    const volumeSleeps = sleeps.filter(ms => ms === VOLUME_LIST_INTERVAL_MS)
    expect(volumeSleeps).toHaveLength(3)
    expect(world.cloud.volumes[0]?.dropletIds).toEqual([DROPLET_ID])
  })

  it('does not sleep when the first listing already shows the volume', async () => {
    const world = makeWorld()
    const {deps, sleeps} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)
    expect(sleeps.filter(ms => ms === VOLUME_LIST_INTERVAL_MS)).toEqual([])
  })

  it('succeeds when the volume appears on the last allowed attempt', async () => {
    const world = makeWorld({newVolumeHiddenForLists: VOLUME_LIST_ATTEMPTS - 1})
    const {deps, sleeps} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)
    expect(sleeps.filter(ms => ms === VOLUME_LIST_INTERVAL_MS)).toHaveLength(VOLUME_LIST_ATTEMPTS - 1)
  })

  it('fails with "not found after creation" when it never appears, before any attach or SSH step', async () => {
    const world = makeWorld({newVolumeHiddenForLists: 1000})
    const {deps, sleeps, waits} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, false, deps)).rejects.toThrow(
      `Volume "${TRACES_VOLUME_NAME}" not found after creation`,
    )
    expect(sleeps.filter(ms => ms === VOLUME_LIST_INTERVAL_MS)).toHaveLength(VOLUME_LIST_ATTEMPTS - 1)
    expect(world.doctlCalls().some(call => call.startsWith('compute volume-action attach'))).toBe(false)
    expect(world.sshCommands()).toEqual([])
    expect(waits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// One multiplexed SSH connection per run (the image's UFW limit is six connections per 30 seconds)
// ---------------------------------------------------------------------------

function controlPathsOf(calls: readonly Call[]): string[] {
  return calls.map(call => call.argv.find(arg => arg.startsWith('ControlPath=')) ?? '')
}

describe('SSH connection multiplexing', () => {
  const RESTORE_RUN = {snapshotName: 'traces-data-snap', privateKey: 'placeholder', remoteUser: 'root'}
  const REOPEN_RUN = {privateKey: 'placeholder', remoteUser: 'root'}
  const closedCloud = () =>
    provisionedCloud({
      firewalls: [{id: 'fw-old', name: FIREWALL_NAME, inbound: [inboundRule(22)], droplets: [DROPLET_ID]}],
    })

  it('sends every remote step through the same ControlPath, and no step without one', async () => {
    const world = makeWorld()
    const {deps, controlDirs} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)

    expect(controlDirs).toHaveLength(1)
    const calls = world.sshCalls()
    expect(calls.length).toBeGreaterThan(10)
    const expected = `ControlPath=${controlDirs[0]}/cm`
    expect(controlPathsOf(calls).every(path => path === expected)).toBe(true)
    for (const call of calls) {
      expect(call.argv).toContain('ControlMaster=auto')
      expect(call.argv).toContain(`ControlPersist=${SSH_CONTROL_PERSIST}`)
    }
  })

  it('keeps the host-key and batch options exactly as before', async () => {
    const world = makeWorld()
    const {deps} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)

    for (const call of [...world.sshCalls(), ...world.closeCalls()]) {
      expect(call.argv).toContain('StrictHostKeyChecking=accept-new')
      expect(call.argv).toContain('BatchMode=yes')
      expect(call.argv).toContain('ConnectTimeout=10')
      expect(call.argv).toContain('IdentitiesOnly=yes')
      expect(call.argv).toContain('/tmp/fake-identity')
      expect(call.argv.join(' ')).not.toMatch(/StrictHostKeyChecking=(no|off)|UserKnownHostsFile/)
    }
  })

  it('closes the master once, last, through the same socket and target, and removes the directory', async () => {
    const world = makeWorld()
    const {deps, controlDirs, removedControlDirs} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)

    const closes = world.closeCalls()
    expect(closes).toHaveLength(1)
    expect(world.calls.at(-1)).toBe(closes[0])
    const argv = closes[0]?.argv ?? []
    expect(argv).toContain(`ControlPath=${controlDirs[0]}/cm`)
    expect(argv.slice(-3)).toEqual(['-O', 'exit', `root@${DROPLET_HOST}`])
    expect(removedControlDirs).toEqual(controlDirs)
  })

  it('closes the master once and removes the directory when a remote step fails', async () => {
    const world = makeWorld({}, {fs: 'other'})
    const {deps, controlDirs, removedControlDirs} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, false, deps)).rejects.toThrow()

    expect(world.sshCalls().length).toBeGreaterThan(0)
    expect(world.closeCalls()).toHaveLength(1)
    expect(removedControlDirs).toEqual(controlDirs)
  })

  it.each(['no-master', 'throws'] as const)('tolerates a close that finds no master or fails (%s)', async mode => {
    const world = makeWorld({}, {}, mode)
    const {deps, controlDirs, removedControlDirs} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)
    expect(world.closeCalls()).toHaveLength(1)
    expect(removedControlDirs).toEqual(controlDirs)
  })

  it('does not hide a remote failure behind a failing close', async () => {
    const world = makeWorld({}, {fs: 'other'}, 'throws')
    const {deps} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, false, deps)).rejects.toThrow(/ext4|filesystem|refus/i)
  })

  it('uses a new socket for each run, never a shared one', async () => {
    const first = makeWorld()
    const second = makeWorld()
    const one = makeDeps(first.runner)
    const two = makeDeps(second.runner)
    await runProvision(PROVISION_INPUT, false, one.deps)
    await runProvision(PROVISION_INPUT, false, two.deps)
    for (const world of [first, second]) {
      const paths = new Set(controlPathsOf(world.sshCalls()))
      expect(paths.size).toBe(1)
      expect([...paths][0]).toMatch(/^ControlPath=\/tmp\/fake-control-\d+\/cm$/)
    }
  })

  it('removes the directory even when the identity cannot be materialized', async () => {
    const world = makeWorld()
    const {deps, controlDirs, removedControlDirs} = makeDeps(world.runner)
    deps.materializeIdentity = () => {
      throw new Error('identity refused')
    }
    await expect(runProvision(PROVISION_INPUT, false, deps)).rejects.toThrow(/identity refused/)
    expect(removedControlDirs).toEqual(controlDirs)
    expect(world.sshCalls()).toEqual([])
    expect(world.closeCalls()).toEqual([])
  })

  it('does the same in restore: one socket for every remote step, one close', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true})
    const {deps, controlDirs, removedControlDirs} = makeDeps(world.runner)
    await runRestore(RESTORE_RUN, deps)
    expect(controlDirs).toHaveLength(1)
    expect(new Set(controlPathsOf(world.sshCalls()))).toEqual(new Set([`ControlPath=${controlDirs[0]}/cm`]))
    expect(world.sshCalls()).toHaveLength(4)
    expect(world.closeCalls()).toHaveLength(1)
    expect(removedControlDirs).toEqual(controlDirs)
  })

  it('does the same in reopen-ports: one socket, one close, also when the guard refuses', async () => {
    const allowed = makeWorld(closedCloud(), {provisioned: true, tokens: 'deny-all'})
    const one = makeDeps(allowed.runner)
    await runReopen(REOPEN_RUN, one.deps)
    expect(new Set(controlPathsOf(allowed.sshCalls()))).toEqual(new Set([`ControlPath=${one.controlDirs[0]}/cm`]))
    expect(allowed.closeCalls()).toHaveLength(1)
    expect(one.removedControlDirs).toEqual(one.controlDirs)

    const refused = makeWorld(closedCloud(), {provisioned: true, tokens: 'real'})
    const two = makeDeps(refused.runner)
    await expect(runReopen(REOPEN_RUN, two.deps)).rejects.toThrow(/Refusing to reopen/)
    expect(refused.closeCalls()).toHaveLength(1)
    expect(two.removedControlDirs).toEqual(two.controlDirs)
  })

  it('names a short socket path, well under the macOS limit', async () => {
    const world = makeWorld()
    const {deps, controlDirs} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)
    expect(`${controlDirs[0]}/cm`.length).toBeLessThan(60)
  })
})

describe('defaultDeps control directory', () => {
  it('is a private directory under /tmp with a short socket path, and cleanup removes it', () => {
    const dir = defaultDeps().makeControlDir()
    try {
      expect(dir.path.startsWith('/tmp/')).toBe(true)
      expect(statSync(dir.path).mode & 0o777).toBe(0o700)
      expect(`${dir.path}/cm`.length).toBeLessThan(60)
    } finally {
      dir.cleanup()
    }
    expect(existsSync(dir.path)).toBe(false)
  })
})

describe('volume attach failure', () => {
  it('stops before any SSH step and any Docker change when the attach call fails', async () => {
    const world = makeWorld({
      override: args =>
        args.slice(0, 3).join(' ') === 'compute volume-action attach' ? fail('attach refused') : undefined,
    })
    const {deps, pins, waits} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, false, deps)).rejects.toThrow(/attach refused/)
    expect(world.sshCommands()).toEqual([])
    expect(waits).toEqual([])
    expect(pins).toEqual([])
  })

  it('stops when the attach call succeeds but the volume does not read back as attached', async () => {
    const world = makeWorld({attachIgnored: true})
    const {deps, waits} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, false, deps)).rejects.toThrow(/not attached/)
    expect(world.sshCommands()).toEqual([])
    expect(waits).toEqual([])
  })

  it('refuses a volume that is attached to a different droplet', async () => {
    const world = makeWorld(
      provisionedCloud({volumes: [{id: 'vol-old', name: TRACES_VOLUME_NAME, dropletIds: ['9999']}]}),
      {provisioned: true},
    )
    const {deps} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, true, deps)).rejects.toThrow(/another droplet/)
    expect(world.sshCommands()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Second run
// ---------------------------------------------------------------------------

describe('runProvision on a provisioned host', () => {
  it('refuses without --force and creates nothing', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true})
    const {deps} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, false, deps)).rejects.toThrow(/already exists/)
    expect(world.doctlCalls()).toEqual(['compute droplet list --format Name --no-header'])
    expect(world.sshCommands()).toEqual([])
  })

  it('changes nothing and never reformats the volume', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true})
    const {deps, logs} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, true, deps)

    const doctl = world.doctlCalls()
    for (const call of doctl) {
      expect(call).not.toMatch(/ create| attach| detach| add-rules| remove-rules| add-droplets| delete/)
    }
    const remote = world.sshCommands().join('\n')
    expect(remote).not.toContain('mkfs')
    // Only the Docker restart step stops services; the journald restart sits in a branch that runs on change.
    expect(remote).not.toContain('systemctl stop')
    expect(world.host.mkfsCount).toBe(0)
    expect(world.host.dockerRestarts).toBe(0)
    expect(world.host.steps).not.toContain('mkfs')
    expect(world.host.steps).not.toContain('docker-restart')
    expect(logs.join('\n')).toContain('nothing changed')
  })

  it('does not reformat even if the probe wrongly reports an empty device on a second run', async () => {
    // The format command carries its own guard: it re-reads the filesystem signature and refuses.
    const script = mkfsScript(volumeDevicePath(TRACES_VOLUME_NAME))
    expect(script.indexOf('blkid')).toBeGreaterThan(-1)
    expect(script.indexOf('blkid')).toBeLessThan(script.indexOf('mkfs.ext4'))
    expect(script).toContain('TRACES_MKFS_REFUSED')
  })

  it('refuses a device that carries a filesystem other than ext4', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true, fs: 'other'})
    const {deps} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, true, deps)).rejects.toThrow(/volume filesystem failed/)
    expect(world.host.mkfsCount).toBe(0)
  })

  it('does not touch the firewall rules, so a closed state survives a re-run', async () => {
    const closed = [inboundRule(22)]
    const world = makeWorld(
      provisionedCloud({
        firewalls: [{id: 'fw-old', name: FIREWALL_NAME, inbound: closed, droplets: [DROPLET_ID]}],
      }),
      {provisioned: true},
    )
    const {deps} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, true, deps)
    expect(world.cloud.firewalls[0]?.inbound).toEqual(closed)
  })

  it('refuses to restart Docker over running containers when its configuration changes', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true, dockerBusy: true})
    world.host.files.delete(DOCKER_CONFIG_PATHS[0] ?? '')
    const {deps} = makeDeps(world.runner)
    await expect(runProvision(PROVISION_INPUT, true, deps)).rejects.toThrow(/restart Docker on the volume failed/)
  })
})

// ---------------------------------------------------------------------------
// Remote command hygiene
// ---------------------------------------------------------------------------

async function provisionFreshHost() {
  const world = makeWorld({}, {})
  const {deps} = makeDeps(world.runner)
  await runProvision(PROVISION_INPUT, false, deps)
  return world
}

describe('remote commands', () => {
  it('never redirect to the null device and only rm inside /tmp', async () => {
    const world = await provisionFreshHost()
    const scripts = [
      ...world.sshCommands(),
      mkfsScript('/dev/disk/by-id/x'),
      tokenCheckScript(),
      mountScript('/dev/disk/by-id/x'),
    ]
    for (const script of scripts) {
      expect(script).not.toContain('/dev/null')
      for (const match of script.matchAll(/\brm\b[^\n;]*/g)) {
        expect(match[0]).toMatch(/^rm -f "\$t"$/)
      }
    }
    expect(world.sshCommands().some(command => /\brm\b/.test(command))).toBe(true)
  })

  it('sends file contents on stdin, never in argv', async () => {
    const world = await provisionFreshHost()
    const daemon = dockerConfigFiles()[0]
    const write = world.calls.find(c => c.argv.at(-1)?.includes(`traces-step:file:${daemon?.path}`))
    expect(write?.stdin).toBe(daemon?.content)
    for (const call of world.calls.filter(c => c.argv[0] === 'ssh')) {
      expect(call.argv.join(' ')).not.toContain('"data-root"')
    }
  })

  it('wraps each step as one bash command and every step ends by printing a sentinel', async () => {
    const world = await provisionFreshHost()
    for (const command of world.sshCommands()) {
      expect(command.startsWith('bash -o pipefail -c ')).toBe(true)
    }
    expect(bashCommand("echo 'x'")).toBe(`bash -o pipefail -c ${shellQuote("echo 'x'")}`)
    expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`)
  })

  it('uses the shared ssh builder, so the host is user@address with BatchMode', async () => {
    const world = await provisionFreshHost()
    const first = world.calls.find(c => c.argv[0] === 'ssh')?.argv ?? []
    expect(first).toContain('BatchMode=yes')
    expect(first).toContain(`root@${DROPLET_HOST}`)
    expect(first).toContain('/tmp/fake-identity')
  })
})

// ---------------------------------------------------------------------------
// Configuration content
// ---------------------------------------------------------------------------

describe('host configuration', () => {
  it('mounts by filesystem UUID with options that let the host boot without the volume', () => {
    const script = mountScript(volumeDevicePath(TRACES_VOLUME_NAME))
    expect(script).toContain('UUID=$uuid')
    expect(script).toContain('nofail')
    expect(script).toContain('x-systemd.device-timeout=')
    expect(script).not.toMatch(/\/dev\/sd[a-z]/)
    expect(script).toContain(`mnt=${TRACES_VOLUME_MOUNT}`)
    // An fstab entry for the mount point that differs is a conflict, never rewritten.
    expect(script).toContain('TRACES_FSTAB_CONFLICT')
  })

  it('addresses the attached volume by its DigitalOcean by-id link', () => {
    expect(volumeDevicePath('traces-data')).toBe('/dev/disk/by-id/scsi-0DO_Volume_traces-data')
    expect(() => volumeDevicePath('bad name; rm')).toThrow(/Unsafe volume name/)
  })

  it('moves Docker data and the containerd root onto the volume', () => {
    const [daemon, containerd] = dockerConfigFiles()
    expect(JSON.parse(daemon?.content ?? '{}')).toEqual({'data-root': TRACES_DOCKER_ROOT})
    expect(containerd?.content).toContain(`root = "${TRACES_CONTAINERD_ROOT}"`)
    expect(containerd?.content).toContain('disabled_plugins = ["io.containerd.grpc.v1.cri"]')
    expect(containerd?.content).not.toContain('disabled_plugins = ["cri"]')
    expect(TRACES_DOCKER_ROOT.startsWith(`${TRACES_VOLUME_MOUNT}/`)).toBe(true)
    expect(TRACES_CONTAINERD_ROOT.startsWith(`${TRACES_VOLUME_MOUNT}/`)).toBe(true)
  })

  it('makes Docker and containerd require the mount and the sentinel, with the same drop-in', () => {
    const files = dockerConfigFiles()
    const dockerDropIn = files.find(f => f.path.includes('docker.service.d'))
    const containerdDropIn = files.find(f => f.path.includes('containerd.service.d'))
    expect(dockerDropIn?.content).toBe(containerdDropIn?.content)
    expect(dockerDropIn?.content).toContain(`RequiresMountsFor=${TRACES_VOLUME_MOUNT}`)
    expect(dockerDropIn?.content).toContain(`grep -qx ${TRACES_SENTINEL_CONTENT} ${TRACES_SENTINEL_PATH}`)
    expect(dockerDropIn?.content).toContain('ExecStartPre=')
  })

  it('never replaces a foreign daemon.json or containerd config', () => {
    const [daemon, containerd] = dockerConfigFiles()
    expect(daemon?.guard?.stockActive).toEqual(['{}'])
    // The image's stock containerd file (short plugin name, no version line) is the one we may replace.
    expect(containerd?.guard?.stockActive).toEqual(['disabled_plugins = ["cri"]'])
    expect(containerd?.guard?.marker).toContain('managed by')
    expect(daemon ? managedFileScript(daemon) : '').toContain('TRACES_FILE_FOREIGN')
  })

  it('turns off password sign-in, caps the journal and disables core dumps', () => {
    const byPath = new Map(hardeningFiles().map(file => [file.path, file]))
    const sshd = byPath.get('/etc/ssh/sshd_config.d/00-traces-hardening.conf')
    expect(sshd?.content).toContain('PasswordAuthentication no')
    expect(sshd?.afterChange).toContain('sshd -t')
    const journald = [...byPath.values()].find(file => file.path.includes('journald'))
    expect(journald?.content).toContain('SystemMaxUse=200M')
    const sysctl = [...byPath.values()].find(file => file.path.includes('sysctl'))
    expect(sysctl?.content).toContain('kernel.core_pattern=|/bin/false')
    expect([...byPath.values()].some(file => file.content.includes('hard core 0'))).toBe(true)
  })

  it('disables swap now and in fstab', async () => {
    const world = makeWorld({}, {})
    const {deps} = makeDeps(world.runner)
    await runProvision(PROVISION_INPUT, false, deps)
    const swap = world.sshCommands().find(c => c.includes('traces-step:swap')) ?? ''
    expect(swap).toContain('swapoff -a')
    expect(swap).toContain('/etc/fstab')
    expect(world.host.swapOn).toBe(false)
  })
})

async function runLocal(script: string, stdin: string) {
  const proc = Bun.spawn(['bash', '-o', 'pipefail', '-c', script], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return {stdout: stdout.trim(), exitCode}
}

describe('managed file script, run against real files in a temp directory', () => {
  it('reports an identical file as unchanged and a foreign file as an error, leaving it alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-test-'))
    try {
      const path = join(dir, 'daemon.json')
      const ours = '{"data-root": "/mnt/traces/docker"}\n'

      writeFileSync(path, ours)
      const same = await runLocal(managedFileScript({path, mode: '0644', content: ours}), ours)
      expect(same).toEqual({stdout: 'TRACES_FILE_UNCHANGED', exitCode: 0})

      const foreign = '{"log-driver": "syslog"}\n'
      writeFileSync(path, foreign)
      const refused = await runLocal(
        managedFileScript({path, mode: '0644', content: ours, guard: {stockActive: ['{}']}}),
        ours,
      )
      expect(refused.exitCode).toBe(1)
      expect(refused.stdout).toBe('TRACES_FILE_FOREIGN')
      expect(readFileSync(path, 'utf8')).toBe(foreign)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})

describe('containerd config guard, run against real files in a temp directory', () => {
  it('accepts the stock file and a file we wrote earlier, and refuses a foreign one', async () => {
    const containerd = dockerConfigFiles()[1]
    if (!containerd) throw new Error('missing containerd config')
    const dir = mkdtempSync(join(tmpdir(), 'traces-test-'))
    try {
      const path = join(dir, 'config.toml')
      const script = managedFileScript({...containerd, path})

      // The replace step itself uses GNU `install -D`, so only the guard's verdict is asserted: it must not
      // call these two files foreign (on macOS the step then stops at `install`, on the host it replaces them).
      writeFileSync(path, '# stock\n\ndisabled_plugins = ["cri"]\n')
      expect((await runLocal(script, containerd.content)).stdout).not.toBe('TRACES_FILE_FOREIGN')

      writeFileSync(path, containerd.content.replace('io.containerd.grpc.v1.cri', 'cri'))
      expect((await runLocal(script, containerd.content)).stdout).not.toBe('TRACES_FILE_FOREIGN')

      const foreign = 'version = 2\n[plugins."io.containerd.grpc.v1.cri"]\n  sandbox_image = "x"\n'
      writeFileSync(path, foreign)
      const refused = await runLocal(script, containerd.content)
      expect(refused).toEqual({stdout: 'TRACES_FILE_FOREIGN', exitCode: 1})
      expect(readFileSync(path, 'utf8')).toBe(foreign)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})

// ---------------------------------------------------------------------------
// Storage check
// ---------------------------------------------------------------------------

describe('checkTracesStorage', () => {
  const exec = (result: RunResult) => async () => result

  it('passes when the mount, sentinel, Docker root and containerd root are all on the volume', async () => {
    await expect(checkTracesStorage(exec(ok(GOOD_STORAGE_OUTPUT)))).resolves.toBeUndefined()
  })

  it('asks for the sentinel, the mount source, Docker info and the containerd root, as one bash step', async () => {
    let command = ''
    await checkTracesStorage(async c => {
      command = c
      return ok(GOOD_STORAGE_OUTPUT)
    })
    expect(command.startsWith('bash -o pipefail -c ')).toBe(true)
    expect(command).toContain(TRACES_SENTINEL_PATH)
    expect(command).toContain('docker info')
    expect(command).toContain('containerd config dump')
    expect(command).toContain('findmnt')
    expect(command).not.toContain('/dev/null')
  })

  it('fails when the mount point exists but the sentinel is absent', async () => {
    // The probe reads the sentinel with `head`, which exits non-zero when the file is missing.
    await expect(
      checkTracesStorage(exec(fail('head: cannot open /mnt/traces/.traces-volume for reading: No such file'))),
    ).rejects.toThrow(/storage check failed/)
  })

  it('fails when the sentinel file has other content', async () => {
    await expect(checkTracesStorage(exec(ok(storageOutput({sentinel: 'something-else'}))))).rejects.toThrow(
      /sentinel file content is not recognised/,
    )
    await expect(checkTracesStorage(exec(ok(storageOutput({sentinel: ''}))))).rejects.toThrow(/did not report sentinel/)
  })

  it('fails when Docker reports a data root outside the volume', async () => {
    await expect(checkTracesStorage(exec(ok(storageOutput({docker_root: '/var/lib/docker'}))))).rejects.toThrow(
      /Docker data root \/var\/lib\/docker is not under/,
    )
  })

  it('fails when the image store (containerd root) is outside the volume', async () => {
    await expect(checkTracesStorage(exec(ok(storageOutput({containerd_root: '/var/lib/containerd'}))))).rejects.toThrow(
      /containerd root \/var\/lib\/containerd is not under/,
    )
  })

  it('fails when a root only looks like it is under the volume', async () => {
    await expect(checkTracesStorage(exec(ok(storageOutput({docker_root: '/mnt/traces-evil/docker'}))))).rejects.toThrow(
      /not under/,
    )
    await expect(
      checkTracesStorage(exec(ok(storageOutput({docker_root: '/mnt/traces/../../var/lib/docker'})))),
    ).rejects.toThrow(/not under/)
    await expect(checkTracesStorage(exec(ok(storageOutput({docker_root: 'docker'}))))).rejects.toThrow(/not under/)
    await expect(checkTracesStorage(exec(ok(storageOutput({docker_root: TRACES_VOLUME_MOUNT}))))).rejects.toThrow(
      /not under/,
    )
  })

  it('fails when a root is under the path but on a different filesystem (a bind mount or symlink)', async () => {
    await expect(checkTracesStorage(exec(ok(storageOutput({docker_source: '/dev/vda1'}))))).rejects.toThrow(
      /Docker data root is not on the volume filesystem/,
    )
    await expect(checkTracesStorage(exec(ok(storageOutput({containerd_source: '/dev/vda1'}))))).rejects.toThrow(
      /containerd root is not on the volume filesystem/,
    )
  })

  it('fails when the mount point is just the root filesystem', async () => {
    await expect(checkTracesStorage(exec(ok(storageOutput({mount_source: '/dev/vda1'}))))).rejects.toThrow(
      /on the root filesystem/,
    )
  })

  it('requires exit 0: a non-zero exit with good-looking output still fails', async () => {
    await expect(checkTracesStorage(exec({exitCode: 1, stdout: GOOD_STORAGE_OUTPUT, stderr: ''}))).rejects.toThrow(
      /exited 1/,
    )
  })

  it('requires the final sentinel: good fields without it are an unrecognised answer', async () => {
    const withoutSentinel = GOOD_STORAGE_OUTPUT.replace('TRACES_STORAGE_PROBED', '')
    await expect(checkTracesStorage(exec(ok(withoutSentinel)))).rejects.toThrow(/did not end with its sentinel/)
    await expect(checkTracesStorage(exec(ok('')))).rejects.toThrow(/did not end with its sentinel/)
  })

  it('reports every missing field', () => {
    expect(evaluateStorageProbe(ok('TRACES_STORAGE_PROBED'))).toHaveLength(7)
  })
})

// ---------------------------------------------------------------------------
// Restore mode
// ---------------------------------------------------------------------------

function touchesVolumes(call: string): boolean {
  return /volume/.test(call) || call.startsWith('compute snapshot')
}

describe('runRestore', () => {
  const RESTORE_INPUT = {snapshotName: 'traces-data-snap', privateKey: 'placeholder', remoteUser: 'root'}

  it('removes 80 and 443 and reads the result back before any volume or snapshot call', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true})
    const {deps} = makeDeps(world.runner)
    await runRestore(RESTORE_INPUT, deps)

    const doctl = world.doctlCalls()
    const removal = indexOfCall(doctl, call => call.startsWith('compute firewall remove-rules'))
    const firstVolume = indexOfCall(doctl, touchesVolumes)
    expect(removal).toBeGreaterThan(-1)
    // Every volume-listing call comes after the removal AND the read-back that follows it.
    const readBack = doctl.findIndex((call, index) => index > removal && call.startsWith('compute firewall get'))
    expect(readBack).toBeGreaterThan(removal)
    expect(firstVolume).toBeGreaterThan(readBack)
    expect(doctl[removal]).toContain(WEB_RULE_80)
    expect(doctl[removal]).toContain(WEB_RULE_443)
    expect(doctl[removal]).not.toContain(inboundRule(22))
    // Nothing on the host happens before the ports are confirmed closed either.
    const firstSsh = world.calls.findIndex(c => c.argv[0] === 'ssh')
    expect(firstSsh).toBeGreaterThan(readBack)
  })

  it('leaves only SSH open in the cloud firewall', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true})
    const {deps} = makeDeps(world.runner)
    await runRestore(RESTORE_INPUT, deps)
    expect(world.cloud.firewalls[0]?.inbound).toEqual([inboundRule(22)])
  })

  it('stops before any volume call when the firewall change fails', async () => {
    const world = makeWorld(
      provisionedCloud({
        override: args =>
          args.slice(0, 3).join(' ') === 'compute firewall remove-rules' ? fail('api error') : undefined,
      }),
      {provisioned: true},
    )
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/api error/)
    expect(world.doctlCalls().some(touchesVolumes)).toBe(false)
    expect(world.sshCommands()).toEqual([])
    expect(world.cloud.volumes).toHaveLength(1)
  })

  it('stops when the firewall change succeeds but the read-back still shows 443', async () => {
    const world = makeWorld(provisionedCloud({removeRulesIgnored: true}), {provisioned: true})
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/still admits port\(s\) 80, 443/)
    expect(world.doctlCalls().some(touchesVolumes)).toBe(false)
    expect(world.sshCommands()).toEqual([])
  })

  it('stops when a second firewall on the droplet still admits a web port', async () => {
    const world = makeWorld(
      provisionedCloud({
        firewalls: [
          {id: 'fw-old', name: FIREWALL_NAME, inbound: [...FIREWALL_INBOUND_RULES], droplets: [DROPLET_ID]},
          {
            id: 'fw-other',
            name: 'other',
            inbound: ['protocol:tcp,ports:all,address:0.0.0.0/0'],
            droplets: [DROPLET_ID],
          },
        ],
      }),
      {provisioned: true},
    )
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/Firewall fw-other still admits/)
    expect(world.doctlCalls().some(touchesVolumes)).toBe(false)
  })

  it('stops when the read-back no longer shows an SSH rule', async () => {
    const world = makeWorld(
      provisionedCloud({
        firewalls: [{id: 'fw-old', name: FIREWALL_NAME, inbound: [WEB_RULE_80, WEB_RULE_443], droplets: [DROPLET_ID]}],
      }),
      {provisioned: true},
    )
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/no longer shows an SSH rule/)
    expect(world.doctlCalls().some(touchesVolumes)).toBe(false)
  })

  it('refuses when the firewall is not attached to the droplet, since closure cannot be confirmed', async () => {
    const world = makeWorld(
      provisionedCloud({
        firewalls: [{id: 'fw-old', name: FIREWALL_NAME, inbound: [...FIREWALL_INBOUND_RULES], droplets: []}],
      }),
      {provisioned: true},
    )
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/not attached/)
    expect(world.doctlCalls().some(touchesVolumes)).toBe(false)
  })

  it('does nothing when the firewall does not exist', async () => {
    const world = makeWorld(provisionedCloud({firewalls: []}), {provisioned: true})
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/does not exist/)
    expect(world.doctlCalls().every(call => !touchesVolumes(call))).toBe(true)
  })

  it('does not resend the removal when the ports are already closed, but still reads back', async () => {
    const world = makeWorld(
      provisionedCloud({
        firewalls: [{id: 'fw-old', name: FIREWALL_NAME, inbound: [inboundRule(22)], droplets: [DROPLET_ID]}],
      }),
      {provisioned: true},
    )
    const {deps} = makeDeps(world.runner)
    await runRestore(RESTORE_INPUT, deps)
    expect(world.doctlCalls().some(call => call.startsWith('compute firewall remove-rules'))).toBe(false)
  })

  it('keeps the ports closed when the snapshot does not exist', async () => {
    const world = makeWorld(provisionedCloud({snapshots: []}), {provisioned: true})
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/No volume snapshot named "traces-data-snap"/)
    expect(world.cloud.volumes).toHaveLength(1)
    expect(world.cloud.firewalls[0]?.inbound).toEqual([inboundRule(22)])
  })

  it('creates a volume from the snapshot, swaps it in place of the old one, remounts it and stops', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true})
    const {deps, logs} = makeDeps(world.runner)
    await runRestore(RESTORE_INPUT, deps)

    const newName = 'traces-data-restore-20261120-1530'
    expect(restoreVolumeName(new Date('2026-11-20T15:30:00Z'))).toBe(newName)
    const doctl = world.doctlCalls()
    expect(doctl).toContain(
      `compute volume create ${newName} --region nyc1 --size 100GiB --snapshot snap-1 --format ID --no-header`,
    )
    const detach = indexOfCall(doctl, call => call.startsWith('compute volume-action detach vol-old'))
    const attach = indexOfCall(doctl, call => call.startsWith('compute volume-action attach'))
    expect(detach).toBeGreaterThan(-1)
    expect(attach).toBeGreaterThan(detach)

    expect(world.host.steps).toEqual(['restore-quiesce', 'fs-probe', 'mount', 'verify-sentinel'])
    const quiesceCall = world.calls.findIndex(c => c.argv.at(-1)?.includes('restore-quiesce'))
    const detachCall = world.calls.findIndex(c => c.argv.slice(1, 4).join(' ') === 'compute volume-action detach')
    expect(quiesceCall).toBeLessThan(detachCall)

    const probe = world.sshCommands().find(c => c.includes('traces-step:fs-probe')) ?? ''
    expect(probe).toContain(volumeDevicePath(newName))

    // The old volume is kept, detached; nothing is deleted, no port reopened, Docker not restarted.
    expect(world.cloud.volumes.find(v => v.id === 'vol-old')?.dropletIds).toEqual([])
    expect(world.cloud.volumes.find(v => v.name === newName)?.dropletIds).toEqual([DROPLET_ID])
    expect(doctl.some(call => call.includes('delete'))).toBe(false)
    expect(doctl.some(call => call.startsWith('compute firewall add-rules'))).toBe(false)
    expect(world.host.dockerRestarts).toBe(0)
    expect(world.cloud.firewalls[0]?.inbound).toEqual([inboundRule(22)])
    expect(logs.join('\n')).toContain('--reopen-ports')
  })

  it('stops before detaching anything when the host cannot be quiesced', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true})
    const originalHandle = world.host.handle.bind(world.host)
    world.host.handle = (command, stdin) =>
      command.includes('restore-quiesce') ? fail('umount: target is busy') : originalHandle(command, stdin)
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/stop Docker and unmount the volume failed/)
    expect(world.doctlCalls().some(call => call.includes('volume-action'))).toBe(false)
    expect(world.cloud.volumes.find(v => v.id === 'vol-old')?.dropletIds).toEqual([DROPLET_ID])
  })

  it('refuses a restored volume that does not carry the sentinel', async () => {
    const world = makeWorld(provisionedCloud(), {provisioned: true})
    const originalHandle = world.host.handle.bind(world.host)
    world.host.handle = (command, stdin) =>
      command.includes('verify-sentinel') ? fail('TRACES_SENTINEL_UNRECOGNISED') : originalHandle(command, stdin)
    const {deps} = makeDeps(world.runner)
    await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(/verify sentinel on restored volume failed/)
  })

  describe('when the new volume is slow to appear in the listing', () => {
    const NEW_NAME = 'traces-data-restore-20261120-1530'

    it('lists again, sleeping between listings only, and completes the restore', async () => {
      const world = makeWorld(provisionedCloud({newVolumeHiddenForLists: 3}), {provisioned: true})
      const {deps, sleeps} = makeDeps(world.runner)
      await runRestore(RESTORE_INPUT, deps)
      expect(sleeps.filter(ms => ms === VOLUME_LIST_INTERVAL_MS)).toHaveLength(3)
      expect(world.cloud.volumes.find(v => v.name === NEW_NAME)?.dropletIds).toEqual([DROPLET_ID])
      expect(world.cloud.volumes.find(v => v.id === 'vol-old')?.dropletIds).toEqual([])
      expect(world.host.steps).toEqual(['restore-quiesce', 'fs-probe', 'mount', 'verify-sentinel'])
    })

    it('does not sleep when the first listing already shows the volume', async () => {
      const world = makeWorld(provisionedCloud(), {provisioned: true})
      const {deps, sleeps} = makeDeps(world.runner)
      await runRestore(RESTORE_INPUT, deps)
      expect(sleeps.filter(ms => ms === VOLUME_LIST_INTERVAL_MS)).toEqual([])
    })

    it('succeeds when the volume appears on the last allowed attempt', async () => {
      const world = makeWorld(provisionedCloud({newVolumeHiddenForLists: VOLUME_LIST_ATTEMPTS - 1}), {
        provisioned: true,
      })
      const {deps, sleeps} = makeDeps(world.runner)
      await runRestore(RESTORE_INPUT, deps)
      expect(sleeps.filter(ms => ms === VOLUME_LIST_INTERVAL_MS)).toHaveLength(VOLUME_LIST_ATTEMPTS - 1)
    })

    it('fails with a clear error when it never appears: ports stay closed, the old volume stays attached, the host is untouched', async () => {
      const world = makeWorld(provisionedCloud({newVolumeHiddenForLists: 1000}), {provisioned: true})
      const {deps, sleeps, waits} = makeDeps(world.runner)
      await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(
        `Volume "${NEW_NAME}" not found after creation. Ports 80 and 443 stay closed; the old volume is still attached and Docker was not touched.`,
      )
      expect(sleeps.filter(ms => ms === VOLUME_LIST_INTERVAL_MS)).toHaveLength(VOLUME_LIST_ATTEMPTS - 1)
      // State left behind: web ports closed at the cloud firewall (closed before the volume was created)...
      expect(world.cloud.firewalls[0]?.inbound).toEqual([inboundRule(22)])
      // ...the old volume still attached, nothing detached or attached, Docker never stopped, no SSH at all...
      expect(world.cloud.volumes.find(v => v.id === 'vol-old')?.dropletIds).toEqual([DROPLET_ID])
      expect(world.doctlCalls().some(call => call.startsWith('compute volume-action'))).toBe(false)
      expect(world.sshCommands()).toEqual([])
      expect(waits).toEqual([])
      // ...and the new volume exists at DigitalOcean, unattached, for the operator to delete or reuse.
      expect(world.cloud.volumes.find(v => v.name === NEW_NAME)?.dropletIds).toEqual([])
    })

    it('still refuses a listed volume whose id is not the one the create call returned', async () => {
      const world = makeWorld(provisionedCloud(), {provisioned: true})
      const {deps} = makeDeps(async (argv, options) => {
        const result = await world.runner(argv, options)
        return argv.slice(1, 4).join(' ') === 'compute volume create' ? ok('vol-someone-else') : result
      })
      await expect(runRestore(RESTORE_INPUT, deps)).rejects.toThrow(`Volume "${NEW_NAME}" not found after creation`)
      expect(world.doctlCalls().some(call => call.startsWith('compute volume-action'))).toBe(false)
      expect(world.sshCommands()).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Reopen mode
// ---------------------------------------------------------------------------

describe('runReopen', () => {
  const REOPEN_INPUT = {privateKey: 'placeholder', remoteUser: 'root'}
  const closedCloud = () =>
    provisionedCloud({
      firewalls: [{id: 'fw-old', name: FIREWALL_NAME, inbound: [inboundRule(22)], droplets: [DROPLET_ID]}],
    })

  it('reopens 80 and 443 after the host reports every token file deny-all, and reads them back', async () => {
    const world = makeWorld(closedCloud(), {provisioned: true, tokens: 'deny-all'})
    const {deps} = makeDeps(world.runner)
    await runReopen(REOPEN_INPUT, deps)

    const doctl = world.doctlCalls()
    const add = doctl.find(call => call.startsWith('compute firewall add-rules'))
    expect(add).toContain(WEB_RULE_80)
    expect(add).toContain(WEB_RULE_443)
    expect(world.cloud.firewalls[0]?.inbound).toEqual([inboundRule(22), WEB_RULE_80, WEB_RULE_443])
    // The token check runs on the host before the firewall is touched.
    const checkIndex = world.calls.findIndex(c => c.argv.at(-1)?.includes('token-check'))
    const addIndex = world.calls.findIndex(c => c.argv.slice(1, 4).join(' ') === 'compute firewall add-rules')
    expect(checkIndex).toBeGreaterThan(-1)
    expect(checkIndex).toBeLessThan(addIndex)
  })

  it('refuses while any group still has a real token, and the ports stay closed', async () => {
    const world = makeWorld(closedCloud(), {provisioned: true, tokens: 'real'})
    const {deps} = makeDeps(world.runner)
    await expect(runReopen(REOPEN_INPUT, deps)).rejects.toThrow(/Refusing to reopen ports 80 and 443.*real token/)
    expect(world.doctlCalls().some(call => call.startsWith('compute firewall add-rules'))).toBe(false)
    expect(world.cloud.firewalls[0]?.inbound).toEqual([inboundRule(22)])
  })

  it.each([
    ['file-missing', /the fro-bot token file under \S+ is missing/],
    ['file-empty', /the workstation token file under \S+ is empty/],
  ] as const)(
    'a token file that is %s is a fault with its own message, not "no token", and the ports stay closed',
    async (tokens, message) => {
      const world = makeWorld(closedCloud(), {provisioned: true, tokens})
      const {deps} = makeDeps(world.runner)
      const failure = await runReopen(REOPEN_INPUT, deps).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      expect(failure).toMatch(message)
      // Its own message: not the refusal for a real token, and not the generic step failure.
      expect(failure).not.toMatch(/real token/)
      expect(failure).not.toMatch(/check sender token files failed/)
      expect(world.doctlCalls().some(call => call.startsWith('compute firewall add-rules'))).toBe(false)
      expect(world.cloud.firewalls[0]?.inbound).toEqual([inboundRule(22)])
    },
  )

  it('refuses when the token root cannot be read (a missing directory is not "empty")', async () => {
    const world = makeWorld(closedCloud(), {provisioned: true, tokens: 'missing-root'})
    const {deps} = makeDeps(world.runner)
    await expect(runReopen(REOPEN_INPUT, deps)).rejects.toThrow(/check sender token files failed/)
    expect(world.doctlCalls().some(call => call.startsWith('compute firewall add-rules'))).toBe(false)
  })

  it('refuses on an unrecognised answer even with exit 0', async () => {
    const world = makeWorld(closedCloud(), {provisioned: true})
    const originalHandle = world.host.handle.bind(world.host)
    world.host.handle = (command, stdin) =>
      command.includes('token-check') ? ok('all good') : originalHandle(command, stdin)
    const {deps} = makeDeps(world.runner)
    await expect(runReopen(REOPEN_INPUT, deps)).rejects.toThrow(/unrecognised answer/)
    expect(world.doctlCalls().some(call => call.startsWith('compute firewall add-rules'))).toBe(false)
  })

  it('fails when the read-back does not show the reopened ports', async () => {
    const world = makeWorld(
      {
        ...closedCloud(),
        override: args => {
          if (args.slice(0, 3).join(' ') === 'compute firewall add-rules') return ok()
          return undefined
        },
      },
      {provisioned: true, tokens: 'deny-all'},
    )
    // The override swallows the add call, so the read-back still shows SSH only.
    const {deps} = makeDeps(world.runner)
    await expect(runReopen(REOPEN_INPUT, deps)).rejects.toThrow(/does not show port\(s\) 80, 443/)
  })

  it('checks token files without printing a token: it counts lines by prefix on the host and prints counts only', () => {
    const script = tokenCheckScript()
    expect(script).toContain(`${TRACES_TOKEN_ROOT}`)
    expect(script).toContain(`index($1, p)`)
    expect(script).toContain(`-v p=${TRACES_VOID_TOKEN_PREFIX}`)
    for (const group of SENDER_GROUPS) expect(script).toContain(group)
    expect(script).not.toMatch(/\bcat\b/)
    expect(script).not.toMatch(/\bprint\b[^}]*\$[01]/)
    expect(script).not.toContain('/dev/null')
    expect(script).toContain('TRACES_TOKEN_ROOT_MISSING')
    expect(script).toContain('TRACES_TOKEN_FILE_MISSING')
    expect(script).toContain('TRACES_TOKEN_FILE_EMPTY')
    // Needs the volume: the check refuses on a root filesystem that merely has the path.
    expect(script).toContain('findmnt')
    expect(script).toContain(TRACES_SENTINEL_PATH)
  })
})

// ---------------------------------------------------------------------------
// The reopen guard, run under a real shell against real token files
// ---------------------------------------------------------------------------
//
// The guard's one job is to tell a deny-all file (one void line) from a file with a real token, and a fault (missing
// or empty file) from both. It is shell, so it is proven by running it: the paths are moved into a temp directory and
// `findmnt`, which a development machine may not have, is a shim that reports a mounted volume.

const REAL = 'trc_PLACEHOLDERrealtoken00000000000000000000000'
const REAL_LINE = `${REAL} 0123456789ab 2026-11-20T00:00:00.000Z\n`
const voidLineFor = (fill: string): string =>
  `${TRACES_VOID_TOKEN_PREFIX}${fill.repeat(43)} void 2026-11-20T00:00:00.000Z\n`

type TokenFiles = Partial<Record<(typeof SENDER_GROUPS)[number], string | null>>

/** Every group deny-all unless the scenario says otherwise. `null` leaves the file out. */
async function runTokenCheck(files: TokenFiles, options: {rootMissing?: boolean} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'traces-guard-'))
  try {
    const root = join(dir, 'tokens')
    const sentinel = join(dir, '.traces-volume')
    writeFileSync(sentinel, `${TRACES_SENTINEL_CONTENT}\n`)
    if (options.rootMissing !== true) {
      for (const [index, group] of SENDER_GROUPS.entries()) {
        mkdirSync(join(root, group), {recursive: true})
        const content = group in files ? files[group] : voidLineFor('ABC'[index] ?? 'A')
        if (content !== null && content !== undefined) writeFileSync(join(root, group, 'token'), content)
      }
    }
    const shim = join(dir, 'shim')
    mkdirSync(shim)
    writeFileSync(join(shim, 'findmnt'), '#!/bin/sh\necho /dev/sda\n')
    chmodSync(join(shim, 'findmnt'), 0o755)

    // Longest paths first: the mount point is a prefix of the others.
    const script = tokenCheckScript()
      .replaceAll(TRACES_TOKEN_ROOT, root)
      .replaceAll(TRACES_SENTINEL_PATH, sentinel)
      .replaceAll(TRACES_VOLUME_MOUNT, dir)
    const proc = Bun.spawn(['bash', '-o', 'pipefail', '-c', script], {
      env: {PATH: `${shim}:${process.env.PATH ?? ''}`},
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return {stdout: stdout.trim(), stderr, exitCode}
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

describe('the reopen guard, run against real token files', () => {
  it('passes, and says deny-all, when every group holds only a void line', async () => {
    expect(await runTokenCheck({})).toEqual({stdout: 'TRACES_TOKENS_DENY_ALL', stderr: '', exitCode: 0})
  })

  it('passes for a group with several void lines and no real one', async () => {
    const result = await runTokenCheck({workstation: voidLineFor('x') + voidLineFor('y')})
    expect(result.stdout).toBe('TRACES_TOKENS_DENY_ALL')
  })

  it.each(SENDER_GROUPS)('refuses with %s holding a real token beside a void line', async group => {
    const result = await runTokenCheck({[group]: voidLineFor('x') + REAL_LINE})
    expect(result).toEqual({stdout: 'TRACES_TOKENS_REAL', stderr: '', exitCode: 0})
  })

  it('refuses for a real token alone, and for a last line with no newline', async () => {
    expect((await runTokenCheck({'fro-bot': REAL_LINE})).stdout).toBe('TRACES_TOKENS_REAL')
    expect((await runTokenCheck({'fro-bot': REAL_LINE.trimEnd()})).stdout).toBe('TRACES_TOKENS_REAL')
  })

  it('counts a token that only resembles the void prefix as real', async () => {
    const lookalike = `trc_voidish${'x'.repeat(40)} 0123456789ab 2026-11-20\n`
    expect((await runTokenCheck({marcusrbrown: lookalike})).stdout).toBe('TRACES_TOKENS_REAL')
  })

  it('never prints a token, a void token or a fingerprint', async () => {
    const result = await runTokenCheck({'fro-bot': voidLineFor('x') + REAL_LINE})
    for (const text of [REAL, '0123456789ab', TRACES_VOID_TOKEN_PREFIX]) {
      expect(result.stdout).not.toContain(text)
      expect(result.stderr).not.toContain(text)
    }
  })

  it.each(SENDER_GROUPS)('faults, naming the group, when the %s file is empty', async group => {
    const result = await runTokenCheck({[group]: ''})
    expect(result).toEqual({stdout: `TRACES_TOKEN_FILE_EMPTY=${group}`, stderr: '', exitCode: 1})
  })

  it('faults on a file with only blank lines, which the collector reads as empty', async () => {
    const result = await runTokenCheck({workstation: '\n  \n\t\n'})
    expect(result).toEqual({stdout: 'TRACES_TOKEN_FILE_EMPTY=workstation', stderr: '', exitCode: 1})
  })

  it.each(SENDER_GROUPS)('faults, naming the group, when the %s file is missing', async group => {
    const result = await runTokenCheck({[group]: null})
    expect(result).toEqual({stdout: `TRACES_TOKEN_FILE_MISSING=${group}`, stderr: '', exitCode: 1})
  })

  it('a fault in a later group wins over a real token in an earlier one: a real token is not the whole answer', async () => {
    const result = await runTokenCheck({marcusrbrown: REAL_LINE, workstation: ''})
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('TRACES_TOKEN_FILE_EMPTY=workstation')
  })

  it('faults when the token root is missing, not "no tokens"', async () => {
    const result = await runTokenCheck({}, {rootMissing: true})
    expect(result).toEqual({stdout: 'TRACES_TOKEN_ROOT_MISSING', stderr: '', exitCode: 1})
  })
})

describe('probe script quoting', () => {
  it('uses the FS probe device path in a safe, unquoted-metacharacter form', () => {
    expect(fsProbeScript('/dev/disk/by-id/scsi-0DO_Volume_traces-data')).toContain(
      'dev=/dev/disk/by-id/scsi-0DO_Volume_traces-data',
    )
    expect(() => fsProbeScript('/dev/x; rm -rf /')).toThrow(/Unsafe remote path/)
    expect(() => fsProbeScript('/dev/../x')).toThrow(/Unsafe remote path/)
  })
})
