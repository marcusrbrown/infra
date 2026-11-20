import type {ProvisionDeps, ProvisionInput, Runner, RunResult} from './provision'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'
import {
  TRACES_CONTAINERD_ROOT,
  TRACES_DOCKER_ROOT,
  TRACES_SENTINEL_CONTENT,
  TRACES_SENTINEL_PATH,
  TRACES_TOKEN_ROOT,
  TRACES_VOLUME_MOUNT,
  TRACES_VOLUME_NAME,
} from '../src/host'
import {
  bashCommand,
  checkDropletExistence,
  checkTracesStorage,
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
  tokenCheckScript,
  validateRequiredEnv,
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
        return ok(this.volumes.map(v => `${v.id}   ${v.name}   [${v.dropletIds.join(' ')}]`).join('\n'))
      }
      case 'compute volume create': {
        const volume = {id: `vol-${this.nextId++}`, name: args[3] ?? '', dropletIds: []}
        this.volumes.push(volume)
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
  tokens?: 'empty' | 'present' | 'missing-root'
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
        const tokens = this.options.tokens ?? 'empty'
        if (tokens === 'missing-root') return {exitCode: 1, stdout: 'TRACES_TOKEN_ROOT_MISSING\n', stderr: ''}
        return ok(tokens === 'present' ? 'TRACES_TOKENS_PRESENT' : 'TRACES_TOKENS_EMPTY')
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

function makeWorld(cloudOptions: CloudOptions = {}, hostOptions: HostOptions = {}) {
  const cloud = new Cloud(cloudOptions)
  const host = new Host(hostOptions)
  const calls: Call[] = []
  const runner: Runner = async (argv, options) => {
    calls.push({argv: [...argv], stdin: options?.stdin})
    if (argv[0] === 'doctl') return cloud.handle(argv.slice(1))
    if (argv[0] === 'ssh') return host.handle(argv.at(-1) ?? '', options?.stdin)
    throw new Error(`unexpected command: ${argv[0]}`)
  }
  const doctlCalls = () => calls.filter(call => call.argv[0] === 'doctl').map(call => call.argv.slice(1).join(' '))
  const sshCommands = () => calls.filter(call => call.argv[0] === 'ssh').map(call => call.argv.at(-1) ?? '')
  return {cloud, host, calls, runner, doctlCalls, sshCommands}
}

function makeDeps(runner: Runner) {
  const logs: string[] = []
  const pins: string[][] = []
  const waits: string[] = []
  const deps: ProvisionDeps = {
    run: runner,
    getSshFingerprint: async keyName => `fingerprint-of-${keyName}`,
    waitForSsh: async host => {
      waits.push(host)
    },
    pinHostKeys: async (domain, ip, path, opts) => {
      pins.push([domain, ip, path, opts.marker])
    },
    materializeIdentity: () => ({path: '/tmp/fake-identity', cleanup: () => {}}),
    sleep: async () => {},
    now: () => new Date('2026-11-20T15:30:00Z'),
    log: message => logs.push(message),
  }
  return {deps, logs, pins, waits}
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

  it('refuses a host value that could be read as an ssh option', async () => {
    const world = makeWorld()
    const {deps} = makeDeps(world.runner)
    await expect(runProvision({...PROVISION_INPUT, tracesHost: '-oProxyCommand=evil'}, false, deps)).rejects.toThrow(
      /Invalid TRACES_HOST/,
    )
    expect(world.calls).toHaveLength(0)
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
    expect(containerd?.content).toContain('disabled_plugins = ["cri"]')
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

  it('reopens 80 and 443 after the host reports every token file empty, and reads them back', async () => {
    const world = makeWorld(closedCloud(), {provisioned: true, tokens: 'empty'})
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

  it('refuses while a token file is non-empty, and the ports stay closed', async () => {
    const world = makeWorld(closedCloud(), {provisioned: true, tokens: 'present'})
    const {deps} = makeDeps(world.runner)
    await expect(runReopen(REOPEN_INPUT, deps)).rejects.toThrow(/Refusing to reopen ports 80 and 443/)
    expect(world.doctlCalls().some(call => call.startsWith('compute firewall add-rules'))).toBe(false)
    expect(world.cloud.firewalls[0]?.inbound).toEqual([inboundRule(22)])
  })

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
      {provisioned: true, tokens: 'empty'},
    )
    // The override swallows the add call, so the read-back still shows SSH only.
    const {deps} = makeDeps(world.runner)
    await expect(runReopen(REOPEN_INPUT, deps)).rejects.toThrow(/does not show port\(s\) 80, 443/)
  })

  it('checks token files without printing a token and never reads their contents', () => {
    const script = tokenCheckScript()
    expect(script).toContain('find -L')
    expect(script).toContain(`${TRACES_TOKEN_ROOT}`)
    expect(script).toContain('-size +0c')
    expect(script).not.toMatch(/\bcat\b.+tokens/)
    expect(script).toContain('TRACES_TOKEN_ROOT_MISSING')
    // Needs the volume: the check refuses on a root filesystem that merely has the path.
    expect(script).toContain('findmnt')
    expect(script).toContain(TRACES_SENTINEL_PATH)
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
