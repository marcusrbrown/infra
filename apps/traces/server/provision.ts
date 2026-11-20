#!/usr/bin/env bun

/**
 * Provisions the traces droplet: a 16 GB droplet, a 100 GB attached volume that
 * holds every path that can carry trace content, and a cloud firewall.
 *
 * Every `doctl` and `ssh` call goes through an injected `Runner`, so tests assert
 * on the exact argv and stdin and nothing in a test reaches DigitalOcean or a host.
 *
 * Modes (mutually exclusive):
 *   (default)                     create or repair the droplet, volume, firewall and host
 *   --check-exists                print whether the droplet exists
 *   --restore-snapshot NAME       close 80/443, then swap the volume for one made from a snapshot
 *   --reopen-ports                reopen 80/443, refused while any sender token file is non-empty
 *
 * Image store decision: containerd's root is moved to the volume through
 * /etc/containerd/config.toml, and Docker's data root through daemon.json. The
 * containerd snapshotter is NOT disabled. Reason: on this droplet image Docker
 * keeps images in containerd's store (the cliproxy disk-full incident), and a
 * setting that turns the snapshotter off is a single flag that a Docker upgrade
 * can change, which would put images back on the root disk without a sound.
 * Relocating the root covers both image-store modes, and `checkTracesStorage`
 * fails closed when either root is not on the volume.
 */

import type {MaterializedIdentity, WaitForSshOptions} from '@marcusrbrown/infra-shared/server/droplet-helpers'

import {join, resolve} from 'node:path'
import {
  getSshFingerprint,
  materializeIdentityFile,
  pinHostKeys,
  sleep,
  ssh,
  validateDoctl,
  waitForSsh,
} from '@marcusrbrown/infra-shared/server/droplet-helpers'

import {
  TRACES_APP_DIR,
  TRACES_CONTAINERD_ROOT,
  TRACES_DOCKER_ROOT,
  TRACES_DROPLET_NAME,
  TRACES_SENTINEL_CONTENT,
  TRACES_SENTINEL_PATH,
  TRACES_TOKEN_ROOT,
  TRACES_VOLUME_MOUNT,
  TRACES_VOLUME_NAME,
  validateTracesHost,
} from '../src/host'

export const DROPLET_IMAGE = 'docker-20-04'
export const DROPLET_SIZE = 's-4vcpu-16gb-amd'
export const DROPLET_REGION = 'nyc1'
export const VOLUME_SIZE = '100GiB'
export const FIREWALL_NAME = 'traces-fw'
export const DEFAULT_SSH_KEY_NAME = 'fro-bot-traces'

// ---------------------------------------------------------------------------
// Runner seam
// ---------------------------------------------------------------------------

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Bytes written to the child's stdin. Secrets and file contents go here, never into argv. */
  stdin?: string
}

/** Runs one command. Never throws on a non-zero exit; the caller decides what that means. */
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>

export const spawnRunner: Runner = async (argv, options) => {
  const proc = Bun.spawn([...argv], {
    stdin: options?.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {exitCode, stdout, stderr}
}

/** Runs a remote command (one string, run by the remote shell) with an optional stdin payload. */
export type RemoteExec = (command: string, stdin?: string) => Promise<RunResult>

export function createRemoteExec(
  run: Runner,
  host: string,
  user: string,
  identityFile: string | undefined,
): RemoteExec {
  return async (command, stdin) => {
    const argv = ssh(host, command, user, identityFile ? {identityFile} : undefined)
    return stdin === undefined ? run(argv) : run(argv, {stdin})
  }
}

export interface ProvisionDeps {
  run: Runner
  getSshFingerprint: (keyName: string) => Promise<string>
  waitForSsh: (host: string, user: string, opts?: WaitForSshOptions) => Promise<void>
  pinHostKeys: typeof pinHostKeys
  materializeIdentity: (privateKey: string) => MaterializedIdentity
  sleep: (ms: number) => Promise<void>
  now: () => Date
  log: (message: string) => void
}

export function defaultDeps(): ProvisionDeps {
  return {
    run: spawnRunner,
    getSshFingerprint: keyName =>
      getSshFingerprint(keyName, {envVarName: 'TRACES_SSH_KEY_NAME', defaultKeyName: DEFAULT_SSH_KEY_NAME}),
    waitForSsh,
    pinHostKeys,
    materializeIdentity: materializeIdentityFile,
    sleep,
    now: () => new Date(),
    log: message => console.log(message),
  }
}

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

export type ProvisionMode =
  | {kind: 'provision'; force: boolean}
  | {kind: 'check-exists'}
  | {kind: 'restore'; snapshotName: string}
  | {kind: 'reopen-ports'}

const SNAPSHOT_NAME_RE = /^[a-z\d][\w.-]*$/i

const SUPPORTED_ARGS = '--force, --check-exists, --restore-snapshot NAME, --reopen-ports'

/**
 * Parses provisioning arguments. Unknown flags are rejected so automated callers
 * don't accidentally get a default mutating run after a typo. `--restore-snapshot`
 * and `--reopen-ports` change firewall exposure, so they accept no other flag.
 */
export function parseProvisionArgs(args: string[]): ProvisionMode {
  let force = false
  let checkExists = false
  let reopen = false
  let snapshotName: string | undefined
  const unknown: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--force') {
      force = true
    } else if (arg === '--check-exists') {
      checkExists = true
    } else if (arg === '--reopen-ports') {
      reopen = true
    } else if (arg === '--restore-snapshot' || arg.startsWith('--restore-snapshot=')) {
      const inline = arg.startsWith('--restore-snapshot=') ? arg.slice('--restore-snapshot='.length) : undefined
      const value = inline ?? args[index + 1]
      if (inline === undefined) index += 1
      if (value === undefined || !SNAPSHOT_NAME_RE.test(value)) {
        throw new Error(
          '--restore-snapshot needs a snapshot name made of letters, digits, dots, dashes and underscores, not starting with a dash',
        )
      }
      snapshotName = value
    } else {
      unknown.push(arg)
    }
  }

  if (unknown.length > 0) {
    throw new Error(`Unknown provision argument(s): ${unknown.join(', ')}. Supported: ${SUPPORTED_ARGS}`)
  }

  const exposureModes = Number(reopen) + Number(snapshotName !== undefined)
  if (exposureModes > 1) {
    throw new Error('--restore-snapshot and --reopen-ports cannot be combined')
  }
  if (exposureModes === 1 && (force || checkExists)) {
    throw new Error('--restore-snapshot and --reopen-ports accept no other flag')
  }

  if (snapshotName !== undefined) return {kind: 'restore', snapshotName}
  if (reopen) return {kind: 'reopen-ports'}
  if (checkExists) return {kind: 'check-exists'}
  return {kind: 'provision', force}
}

/**
 * Validates that all required environment variables are present.
 * Returns the list of missing variable names (empty = all present).
 */
export function validateRequiredEnv(env: Partial<Record<string, string>>): string[] {
  const required = ['DIGITALOCEAN_ACCESS_TOKEN', 'TRACES_HOST']
  return required.filter(key => !env[key])
}

// ---------------------------------------------------------------------------
// doctl helpers
// ---------------------------------------------------------------------------

function excerpt(text: string): string {
  return text.trim().slice(0, 300)
}

async function doctl(run: Runner, args: readonly string[]): Promise<string> {
  const result = await run(['doctl', ...args])
  if (result.exitCode !== 0) {
    throw new Error(
      `doctl ${args.slice(0, 3).join(' ')} failed (exit ${result.exitCode}): ${excerpt(result.stderr) || excerpt(result.stdout)}`,
    )
  }
  return result.stdout.trim()
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

export interface DropletExistenceState {
  name: string
  exists: boolean
}

/** Non-mutating state probe for agents/CI. Only lists droplets. */
export async function checkDropletExistence(run: Runner, name = TRACES_DROPLET_NAME): Promise<DropletExistenceState> {
  const names = nonEmptyLines(await doctl(run, ['compute', 'droplet', 'list', '--format', 'Name', '--no-header']))
  return {name, exists: names.includes(name)}
}

async function getDropletId(run: Runner): Promise<string> {
  const id = await doctl(run, ['compute', 'droplet', 'get', TRACES_DROPLET_NAME, '--format', 'ID', '--no-header'])
  if (!/^\d+$/.test(id)) {
    throw new Error(`Could not resolve the droplet ID for "${TRACES_DROPLET_NAME}"`)
  }
  return id
}

async function getDropletIp(run: Runner, deps: Pick<ProvisionDeps, 'sleep'>, attempts = 20): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ip = await doctl(run, [
      'compute',
      'droplet',
      'get',
      TRACES_DROPLET_NAME,
      '--format',
      'PublicIPv4',
      '--no-header',
    ])
    if (ip) return ip
    await deps.sleep(5000)
  }
  throw new Error('Timed out waiting for droplet IPv4 address')
}

export interface VolumeRow {
  id: string
  name: string
  dropletIds: string[]
}

export function parseVolumeRows(raw: string): VolumeRow[] {
  const rows: VolumeRow[] = []
  for (const line of nonEmptyLines(raw)) {
    const [id, name, ...rest] = line.split(/\s+/)
    if (!id || !name) continue
    rows.push({id, name, dropletIds: rest.join(' ').match(/\d+/g) ?? []})
  }
  return rows
}

async function listVolumes(run: Runner): Promise<VolumeRow[]> {
  return parseVolumeRows(
    await doctl(run, [
      'compute',
      'volume',
      'list',
      '--region',
      DROPLET_REGION,
      '--format',
      'ID,Name,DropletIDs',
      '--no-header',
    ]),
  )
}

/**
 * Attaches a volume and proves it from a fresh listing. A successful attach call
 * is not enough: provisioning must not reach any Docker change on a volume that
 * is not attached.
 */
async function attachVolume(run: Runner, volume: VolumeRow, dropletId: string): Promise<void> {
  await doctl(run, ['compute', 'volume-action', 'attach', volume.id, dropletId, '--wait'])
  const readback = (await listVolumes(run)).find(row => row.id === volume.id)
  if (!readback?.dropletIds.includes(dropletId)) {
    throw new Error(`Volume "${volume.name}" is not attached to droplet ${dropletId} after the attach call`)
  }
}

async function detachVolume(run: Runner, volume: VolumeRow, dropletId: string): Promise<void> {
  await doctl(run, ['compute', 'volume-action', 'detach', volume.id, dropletId, '--wait'])
  const readback = (await listVolumes(run)).find(row => row.id === volume.id)
  if (readback?.dropletIds.includes(dropletId)) {
    throw new Error(`Volume "${volume.name}" is still attached to droplet ${dropletId} after the detach call`)
  }
}

// ---------------------------------------------------------------------------
// Cloud firewall
// ---------------------------------------------------------------------------

const ANY_ADDRESS = 'address:0.0.0.0/0,address:::/0'

/** One rule per port with both address families, the same shape DigitalOcean prints back. */
export function inboundRule(port: number): string {
  return `protocol:tcp,ports:${port},${ANY_ADDRESS}`
}

export const SSH_PORT = 22
export const WEB_PORTS = [80, 443] as const

/** Inbound: 22, 80 and 443 and nothing else. DO firewalls are default-deny: dropping 22 locks out SSH. */
export const FIREWALL_INBOUND_RULES = [SSH_PORT, ...WEB_PORTS].map(port => inboundRule(port))

// Outbound is default-deny too, so allow it (image pulls, ACME, DNS).
export const FIREWALL_OUTBOUND_RULES = [
  'protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0',
  'protocol:udp,ports:all,address:0.0.0.0/0,address:::/0',
  'protocol:icmp,address:0.0.0.0/0,address:::/0',
]

export interface FirewallRule {
  protocol: string
  /** Empty for ICMP. */
  ports: string
}

/** Parses the `InboundRules` column. A token that is not a rule is an error: unknown means exposed. */
export function parseInboundRules(raw: string): FirewallRule[] {
  const rules: FirewallRule[] = []
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const fields = new Map<string, string>()
    for (const part of token.split(',')) {
      const separator = part.indexOf(':')
      if (separator > 0 && !fields.has(part.slice(0, separator))) {
        fields.set(part.slice(0, separator), part.slice(separator + 1))
      }
    }
    const protocol = fields.get('protocol')
    if (!protocol) {
      throw new Error(`Unrecognised firewall rule in the read-back: "${token.slice(0, 80)}"`)
    }
    rules.push({protocol, ports: fields.get('ports') ?? ''})
  }
  return rules
}

/** True when a rule's port field can admit the port. `all`, `0` and an empty field mean every port. */
export function rulePortsCover(rule: FirewallRule, port: number): boolean {
  if (rule.protocol === 'icmp') return false
  const {ports} = rule
  if (ports === '' || ports === 'all' || ports === '0') return true
  const range = /^(\d+)-(\d+)$/.exec(ports)
  if (range) return Number(range[1]) <= port && port <= Number(range[2])
  return Number(ports) === port
}

function coveredWebPorts(rules: FirewallRule[]): number[] {
  return WEB_PORTS.filter(port => rules.some(rule => rulePortsCover(rule, port)))
}

async function findFirewallId(run: Runner): Promise<string | undefined> {
  for (const line of nonEmptyLines(
    await doctl(run, ['compute', 'firewall', 'list', '--format', 'ID,Name', '--no-header']),
  )) {
    const [id, ...name] = line.split(/\s+/)
    if (id && name.join(' ') === FIREWALL_NAME) return id
  }
  return undefined
}

async function listAttachedFirewallIds(run: Runner, dropletId: string): Promise<string[]> {
  return nonEmptyLines(
    await doctl(run, ['compute', 'firewall', 'list-by-droplet', dropletId, '--format', 'ID', '--no-header']),
  )
}

async function readInboundRules(run: Runner, firewallId: string): Promise<FirewallRule[]> {
  return parseInboundRules(
    await doctl(run, ['compute', 'firewall', 'get', firewallId, '--format', 'InboundRules', '--no-header']),
  )
}

/**
 * Creates the firewall with base rules and attaches it, or attaches the existing one.
 * An existing firewall's rules are never touched: after a restore the web ports are
 * closed on purpose and an idempotent re-run must not reopen them.
 */
export async function ensureFirewall(
  run: Runner,
  dropletId: string,
  log: ProvisionDeps['log'] = () => {},
): Promise<string> {
  const existing = await findFirewallId(run)
  if (existing) {
    if (!(await listAttachedFirewallIds(run, dropletId)).includes(existing)) {
      await doctl(run, ['compute', 'firewall', 'add-droplets', existing, '--droplet-ids', dropletId])
    }
    log(`Cloud firewall ${FIREWALL_NAME} already exists; rules left as they are`)
    return existing
  }

  await doctl(run, [
    'compute',
    'firewall',
    'create',
    '--name',
    FIREWALL_NAME,
    '--inbound-rules',
    FIREWALL_INBOUND_RULES.join(' '),
    '--outbound-rules',
    FIREWALL_OUTBOUND_RULES.join(' '),
    '--droplet-ids',
    dropletId,
  ])
  const created = await findFirewallId(run)
  if (!created) throw new Error(`Firewall ${FIREWALL_NAME} not found after creation`)
  return created
}

/**
 * Removes 80 and 443 and proves it. The update call succeeding proves nothing:
 * the proof is that every firewall attached to the droplet reads back without a
 * rule that admits either port, and that SSH is still admitted.
 */
export async function closeWebPorts(run: Runner, dropletId: string, firewallId: string): Promise<void> {
  // A re-run after a partial restore finds the rules already gone; removing a rule that is not there
  // can be an API error, so the change is sent only while a rule still admits 80 or 443.
  if (coveredWebPorts(await readInboundRules(run, firewallId)).length > 0) {
    await doctl(run, [
      'compute',
      'firewall',
      'remove-rules',
      firewallId,
      '--inbound-rules',
      WEB_PORTS.map(port => inboundRule(port)).join(' '),
    ])
  }

  const attached = await listAttachedFirewallIds(run, dropletId)
  if (!attached.includes(firewallId)) {
    throw new Error(
      `Firewall ${firewallId} is not attached to droplet ${dropletId}; cannot confirm ports 80 and 443 are closed`,
    )
  }

  for (const id of attached) {
    const rules = await readInboundRules(run, id)
    const exposed = coveredWebPorts(rules)
    if (exposed.length > 0) {
      throw new Error(
        `Firewall ${id} still admits port(s) ${exposed.join(', ')} after the removal. Ports are not confirmed closed; nothing else was changed.`,
      )
    }
    if (id === firewallId && !rules.some(rule => rule.protocol === 'tcp' && rule.ports === String(SSH_PORT))) {
      throw new Error(`Firewall ${id} no longer shows an SSH rule in the read-back; refusing to continue`)
    }
  }
}

async function openWebPorts(run: Runner, dropletId: string, firewallId: string): Promise<void> {
  await doctl(run, [
    'compute',
    'firewall',
    'add-rules',
    firewallId,
    '--inbound-rules',
    WEB_PORTS.map(port => inboundRule(port)).join(' '),
  ])
  const rules = await readInboundRules(run, firewallId)
  const missing = WEB_PORTS.filter(port => !rules.some(rule => rulePortsCover(rule, port)))
  if (missing.length > 0) {
    throw new Error(`Firewall ${firewallId} does not show port(s) ${missing.join(', ')} after the add call`)
  }
  if (!(await listAttachedFirewallIds(run, dropletId)).includes(firewallId)) {
    throw new Error(`Firewall ${firewallId} is not attached to droplet ${dropletId}`)
  }
}

// ---------------------------------------------------------------------------
// Remote command building
// ---------------------------------------------------------------------------
//
// Remote steps are command strings run over SSH. The repo bans new shell script
// files. Rules every step follows:
//   - small, idempotent, and ends by printing a sentinel the caller must recognise
//   - the caller requires exit 0 AND a recognised last line
//   - no redirect to the null device (a past incident deleted a host's /dev/null)
//   - `rm` only inside /tmp (temp files) or the app directory

const SAFE_PATH_RE = /^\/[\w./-]+$/

function safePath(path: string): string {
  if (!SAFE_PATH_RE.test(path) || path.includes('..')) {
    throw new Error(`Unsafe remote path: ${path}`)
  }
  return path
}

/** Single-quotes a value for the remote shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

/** Wraps a script as one argument-safe command. `pipefail` makes a failing pipeline stage fail the step. */
export function bashCommand(script: string): string {
  return `bash -o pipefail -c ${shellQuote(script)}`
}

function lastLine(text: string): string | undefined {
  return nonEmptyLines(text).at(-1)
}

/** Requires exit 0 and a recognised sentinel as the last stdout line. Anything else fails closed. */
export function expectSentinel<T extends string>(result: RunResult, accepted: readonly T[], label: string): T {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}): ${excerpt(result.stderr) || excerpt(result.stdout) || 'no output'}`,
    )
  }
  const last = lastLine(result.stdout)
  const match = accepted.find(sentinel => sentinel === last)
  if (match === undefined) {
    throw new Error(`${label}: unrecognised answer from the host (expected one of ${accepted.join(', ')})`)
  }
  return match
}

async function runStep<T extends string>(
  exec: RemoteExec,
  label: string,
  script: string,
  accepted: readonly T[],
  stdin?: string,
): Promise<T> {
  return expectSentinel(await exec(bashCommand(script), stdin), accepted, label)
}

// ---------------------------------------------------------------------------
// Managed files
// ---------------------------------------------------------------------------

export interface ManagedFile {
  path: string
  mode: string
  content: string
  /**
   * When set, an existing file is replaced only if it equals the new content, carries
   * the marker, or its non-comment lines equal one of `stockActive`. Anything else is a
   * foreign configuration and the step fails instead of overwriting it.
   */
  guard?: {marker?: string; stockActive: readonly string[]}
  /** Shell run only when the file changed. */
  afterChange?: string
}

export const FILE_SENTINELS = ['TRACES_FILE_CHANGED', 'TRACES_FILE_UNCHANGED'] as const

export function managedFileScript(file: ManagedFile): string {
  const path = safePath(file.path)
  const guard = file.guard
    ? `
  active=$(grep -Ev '^[[:space:]]*(#|$)' ${path} || true)
  ok=0
  if [ -z "$active" ]; then ok=1; fi
${file.guard.stockActive.map(line => `  if [ "$active" = ${shellQuote(line)} ]; then ok=1; fi`).join('\n')}
${file.guard.marker ? `  if grep -qF -- ${shellQuote(file.guard.marker)} ${path}; then ok=1; fi` : ''}
  if [ "$ok" != 1 ]; then rm -f "$t"; echo TRACES_FILE_FOREIGN; exit 1; fi`
    : ''

  return `set -eu
# traces-step:file:${path}
t=$(mktemp /tmp/traces-prov.XXXXXX)
cat > "$t"
if [ -e ${path} ] && ! cmp -s "$t" ${path}; then
  :${guard}
fi
if [ -e ${path} ] && cmp -s "$t" ${path}; then
  rm -f "$t"
  echo TRACES_FILE_UNCHANGED
else
  install -D -m ${file.mode} "$t" ${path}
  rm -f "$t"
  ${file.afterChange ?? ':'}
  echo TRACES_FILE_CHANGED
fi`
}

async function applyManagedFile(exec: RemoteExec, file: ManagedFile): Promise<boolean> {
  const sentinel = await runStep(exec, `write ${file.path}`, managedFileScript(file), FILE_SENTINELS, file.content)
  return sentinel === 'TRACES_FILE_CHANGED'
}

const MANAGED_MARKER = 'managed by marcusrbrown/infra apps/traces/server/provision.ts'

const SYSCTL_PATH = '/etc/sysctl.d/60-traces-hardening.conf'
const LIMITS_PATH = '/etc/security/limits.d/60-traces-nocore.conf'
const COREDUMP_PATH = '/etc/systemd/coredump.conf.d/60-traces.conf'
// Sorts before 50-cloud-init.conf: the first value read wins in sshd_config.
const SSHD_PATH = '/etc/ssh/sshd_config.d/00-traces-hardening.conf'
const JOURNALD_PATH = '/etc/systemd/journald.conf.d/60-traces.conf'
const DAEMON_JSON_PATH = '/etc/docker/daemon.json'
const CONTAINERD_CONFIG_PATH = '/etc/containerd/config.toml'
const DOCKER_DROPIN_PATH = '/etc/systemd/system/docker.service.d/10-traces-volume.conf'
const CONTAINERD_DROPIN_PATH = '/etc/systemd/system/containerd.service.d/10-traces-volume.conf'

export const JOURNAL_MAX_USE = '200M'

export function hardeningFiles(): ManagedFile[] {
  return [
    {
      path: SYSCTL_PATH,
      mode: '0644',
      content: `# ${MANAGED_MARKER}\nkernel.core_pattern=|/bin/false\nfs.suid_dumpable=0\n`,
      afterChange: `sysctl -p ${SYSCTL_PATH}`,
    },
    {path: LIMITS_PATH, mode: '0644', content: `# ${MANAGED_MARKER}\n* hard core 0\nroot hard core 0\n`},
    {
      path: COREDUMP_PATH,
      mode: '0644',
      content: `# ${MANAGED_MARKER}\n[Coredump]\nStorage=none\nProcessSizeMax=0\n`,
    },
    {
      path: SSHD_PATH,
      mode: '0644',
      content: `# ${MANAGED_MARKER}\nPasswordAuthentication no\nChallengeResponseAuthentication no\n`,
      // A config that fails validation is moved aside (still not deleted) so a reboot cannot lock the host out.
      afterChange: `if sshd -t; then systemctl reload ssh; else mv -f ${SSHD_PATH} ${SSHD_PATH}.rejected; echo TRACES_SSHD_INVALID; exit 1; fi`,
    },
    {
      path: JOURNALD_PATH,
      mode: '0644',
      content: `# ${MANAGED_MARKER}\n[Journal]\nSystemMaxUse=${JOURNAL_MAX_USE}\nRuntimeMaxUse=64M\n`,
      afterChange: `systemctl restart systemd-journald; journalctl --vacuum-size=${JOURNAL_MAX_USE}`,
    },
  ]
}

const SWAP_SENTINELS = ['TRACES_SWAP_CHANGED', 'TRACES_SWAP_UNCHANGED'] as const

export const SWAP_SCRIPT = `set -eu
# traces-step:swap
changed=0
if [ -n "$(swapon --noheadings --show=NAME)" ]; then swapoff -a; changed=1; fi
if grep -Eq '^[^#].*[[:space:]]swap[[:space:]]' /etc/fstab; then
  sed -i -E '/^[^#].*[[:space:]]swap[[:space:]]/ s/^/#/' /etc/fstab
  changed=1
fi
if [ "$changed" = 1 ]; then echo TRACES_SWAP_CHANGED; else echo TRACES_SWAP_UNCHANGED; fi`

/** Returns the names of the steps that changed something. */
export async function applyHardening(exec: RemoteExec): Promise<string[]> {
  const changed: string[] = []
  if ((await runStep(exec, 'disable swap', SWAP_SCRIPT, SWAP_SENTINELS)) === 'TRACES_SWAP_CHANGED') {
    changed.push('swap')
  }
  for (const file of hardeningFiles()) {
    if (await applyManagedFile(exec, file)) changed.push(file.path)
  }
  return changed
}

// ---------------------------------------------------------------------------
// Volume: device, filesystem, mount, sentinel
// ---------------------------------------------------------------------------

/** DigitalOcean links an attached volume here, by volume name. */
export function volumeDevicePath(volumeName: string): string {
  if (!/^[a-z\d][a-z\d-]*$/.test(volumeName)) {
    throw new Error(`Unsafe volume name: ${volumeName}`)
  }
  return `/dev/disk/by-id/scsi-0DO_Volume_${volumeName}`
}

/**
 * Mounted by filesystem UUID. `nofail` and a short device timeout let the host
 * finish booting, and sshd come up, when the volume is missing.
 */
export const MOUNT_OPTIONS = 'defaults,nofail,noatime,x-systemd.device-timeout=15s'

const FS_PROBE_SENTINELS = ['TRACES_FS_NONE', 'TRACES_FS_EXT4'] as const

export function fsProbeScript(device: string): string {
  const dev = safePath(device)
  return `set -eu
# traces-step:fs-probe
dev=${dev}
for i in $(seq 1 30); do if [ -b "$dev" ]; then break; fi; sleep 2; done
if [ ! -b "$dev" ]; then echo TRACES_DEVICE_MISSING; exit 1; fi
fs=$(blkid -p -o value -s TYPE "$dev" || true)
if [ -z "$fs" ]; then echo TRACES_FS_NONE; elif [ "$fs" = ext4 ]; then echo TRACES_FS_EXT4; else echo TRACES_FS_OTHER; exit 1; fi`
}

/** Formats only a device with no filesystem signature at all; re-checks inside the same command. */
export function mkfsScript(device: string): string {
  const dev = safePath(device)
  return `set -eu
# traces-step:mkfs
dev=${dev}
fs=$(blkid -p -o value -s TYPE "$dev" || true)
if [ -n "$fs" ]; then echo TRACES_MKFS_REFUSED; exit 1; fi
mkfs.ext4 -q -L ${TRACES_VOLUME_NAME} "$dev"
echo TRACES_MKFS_DONE`
}

const MOUNT_SENTINELS = ['TRACES_MOUNT_PRESENT', 'TRACES_MOUNT_DONE'] as const

export function mountScript(device: string): string {
  const dev = safePath(device)
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  return String.raw`set -eu
# traces-step:mount
dev=${dev}
mnt=${mnt}
uuid=$(blkid -p -o value -s UUID "$dev")
if [ -z "$uuid" ]; then echo TRACES_NO_UUID; exit 1; fi
mkdir -p "$mnt"
line="UUID=$uuid $mnt ext4 ${MOUNT_OPTIONS} 0 2"
existing=$(grep -E "^[^#].*[[:space:]]$mnt[[:space:]]" /etc/fstab || true)
if [ -z "$existing" ]; then
  printf '%s\n' "$line" >> /etc/fstab
  systemctl daemon-reload
elif [ "$existing" != "$line" ]; then
  echo TRACES_FSTAB_CONFLICT
  exit 1
fi
state=TRACES_MOUNT_PRESENT
if ! mountpoint -q "$mnt"; then mount "$mnt"; state=TRACES_MOUNT_DONE; fi
if [ "$(findmnt -n -o UUID --mountpoint "$mnt")" != "$uuid" ]; then echo TRACES_MOUNT_WRONG_VOLUME; exit 1; fi
echo "$state"`
}

const SENTINEL_SENTINELS = ['TRACES_SENTINEL_PRESENT', 'TRACES_SENTINEL_CREATED'] as const

/** Writes the sentinel on a mounted volume, never over an unrecognised one. */
export function sentinelScript(): string {
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  const file = safePath(TRACES_SENTINEL_PATH)
  return String.raw`set -eu
# traces-step:sentinel
if ! mountpoint -q ${mnt}; then echo TRACES_NOT_MOUNTED; exit 1; fi
if [ -e ${file} ]; then
  if [ "$(cat ${file})" = ${TRACES_SENTINEL_CONTENT} ]; then echo TRACES_SENTINEL_PRESENT; else echo TRACES_SENTINEL_UNRECOGNISED; exit 1; fi
else
  printf '%s\n' ${TRACES_SENTINEL_CONTENT} > ${file}
  sync
  echo TRACES_SENTINEL_CREATED
fi`
}

/** Verify-only counterpart used after a restore: a restored volume without the sentinel is refused, not stamped. */
export function verifySentinelScript(): string {
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  const file = safePath(TRACES_SENTINEL_PATH)
  return `set -eu
# traces-step:verify-sentinel
if ! mountpoint -q ${mnt}; then echo TRACES_NOT_MOUNTED; exit 1; fi
if [ "$(cat ${file})" = ${TRACES_SENTINEL_CONTENT} ]; then echo TRACES_SENTINEL_PRESENT; else echo TRACES_SENTINEL_UNRECOGNISED; exit 1; fi`
}

export function dirsScript(): string {
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  const file = safePath(TRACES_SENTINEL_PATH)
  return `set -eu
# traces-step:dirs
if ! mountpoint -q ${mnt}; then echo TRACES_NOT_MOUNTED; exit 1; fi
grep -qx ${TRACES_SENTINEL_CONTENT} ${file}
install -d -m 0710 ${safePath(TRACES_DOCKER_ROOT)}
install -d -m 0711 ${safePath(TRACES_CONTAINERD_ROOT)}
install -d -m 0750 ${safePath(TRACES_APP_DIR)}
echo TRACES_DIRS_OK`
}

export interface VolumeSetupResult {
  formatted: boolean
  changed: string[]
}

/** Formats once, mounts by UUID, writes the sentinel and creates the directories. */
export async function setupVolume(exec: RemoteExec, volumeName: string): Promise<VolumeSetupResult> {
  const device = volumeDevicePath(volumeName)
  const changed: string[] = []
  let formatted = false

  const fs = await runStep(exec, 'probe volume filesystem', fsProbeScript(device), FS_PROBE_SENTINELS)
  if (fs === 'TRACES_FS_NONE') {
    await runStep(exec, 'format volume', mkfsScript(device), ['TRACES_MKFS_DONE'])
    formatted = true
    changed.push('mkfs')
  }

  if ((await runStep(exec, 'mount volume', mountScript(device), MOUNT_SENTINELS)) === 'TRACES_MOUNT_DONE') {
    changed.push('mount')
  }
  if ((await runStep(exec, 'write sentinel', sentinelScript(), SENTINEL_SENTINELS)) === 'TRACES_SENTINEL_CREATED') {
    changed.push('sentinel')
  }
  await runStep(exec, 'create volume directories', dirsScript(), ['TRACES_DIRS_OK'])

  return {formatted, changed}
}

// ---------------------------------------------------------------------------
// Docker and containerd on the volume
// ---------------------------------------------------------------------------

export function dockerConfigFiles(): ManagedFile[] {
  const dropIn = `# ${MANAGED_MARKER}
[Unit]
RequiresMountsFor=${TRACES_VOLUME_MOUNT}

[Service]
ExecStartPre=/bin/sh -c 'grep -qx ${TRACES_SENTINEL_CONTENT} ${TRACES_SENTINEL_PATH}'
`
  return [
    {
      path: DAEMON_JSON_PATH,
      mode: '0644',
      content: `${JSON.stringify({'data-root': TRACES_DOCKER_ROOT}, undefined, 2)}\n`,
      guard: {stockActive: ['{}']},
    },
    {
      path: CONTAINERD_CONFIG_PATH,
      mode: '0644',
      content: `# ${MANAGED_MARKER}\nversion = 2\nroot = "${TRACES_CONTAINERD_ROOT}"\ndisabled_plugins = ["cri"]\n`,
      guard: {marker: MANAGED_MARKER, stockActive: ['disabled_plugins = ["cri"]']},
    },
    {path: DOCKER_DROPIN_PATH, mode: '0644', content: dropIn},
    {path: CONTAINERD_DROPIN_PATH, mode: '0644', content: dropIn},
  ]
}

const DOCKER_RESTART_SENTINELS = ['TRACES_DOCKER_RESTARTED'] as const

/** Restarts only on a host with no running containers; refuses otherwise. Requires the volume and sentinel. */
export function dockerRestartScript(): string {
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  const file = safePath(TRACES_SENTINEL_PATH)
  return `set -eu
# traces-step:docker-restart
if ! mountpoint -q ${mnt}; then echo TRACES_NOT_MOUNTED; exit 1; fi
grep -qx ${TRACES_SENTINEL_CONTENT} ${file}
systemctl daemon-reload
if systemctl is-active --quiet docker; then
  running=$(docker ps -q | wc -l)
  if [ "$running" != 0 ]; then echo TRACES_DOCKER_BUSY; exit 1; fi
fi
systemctl stop docker.socket docker containerd
systemctl enable containerd docker
systemctl start containerd docker
echo TRACES_DOCKER_RESTARTED`
}

export async function setupDocker(exec: RemoteExec): Promise<{restarted: boolean; changed: string[]}> {
  const changed: string[] = []
  for (const file of dockerConfigFiles()) {
    if (await applyManagedFile(exec, file)) changed.push(file.path)
  }
  if (changed.length === 0) return {restarted: false, changed}
  await runStep(exec, 'restart Docker on the volume', dockerRestartScript(), DOCKER_RESTART_SENTINELS)
  return {restarted: true, changed}
}

// ---------------------------------------------------------------------------
// Storage check (used by provisioning and by deploy)
// ---------------------------------------------------------------------------

const STORAGE_SENTINEL = 'TRACES_STORAGE_PROBED'

// String.raw: the quoting below is shell, not TypeScript. containerd 2.x prints `root = '...'` with single
// quotes and 1.x with double quotes, so both are stripped.
export function storageProbeScript(): string {
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  const file = safePath(TRACES_SENTINEL_PATH)
  return String.raw`set -eu
# traces-step:storage-probe
mount_source=$(findmnt -n -o SOURCE --mountpoint ${mnt})
root_source=$(findmnt -n -o SOURCE --mountpoint /)
sentinel=$(head -n 1 ${file})
docker_root=$(docker info --format '{{.DockerRootDir}}')
cfg=$(containerd config dump)
containerd_root=$(printf '%s\n' "$cfg" | sed -n '/^root = /{p;q}' | tr -d "\"'" | sed 's/^root = //')
docker_source=$(findmnt -n -o SOURCE --target "$docker_root")
containerd_source=$(findmnt -n -o SOURCE --target "$containerd_root")
if [ ! -d "$containerd_root/io.containerd.content.v1.content" ]; then echo TRACES_NO_CONTAINERD_STORE; exit 1; fi
printf 'mount_source=%s\n' "$mount_source"
printf 'root_source=%s\n' "$root_source"
printf 'sentinel=%s\n' "$sentinel"
printf 'docker_root=%s\n' "$docker_root"
printf 'containerd_root=%s\n' "$containerd_root"
printf 'docker_source=%s\n' "$docker_source"
printf 'containerd_source=%s\n' "$containerd_source"
echo ${STORAGE_SENTINEL}`
}

function isStrictlyUnderMount(path: string): boolean {
  return path.startsWith(`${TRACES_VOLUME_MOUNT}/`) && !path.split('/').includes('..') && !path.includes('//')
}

export interface StorageProbe {
  mountSource: string
  rootSource: string
  sentinel: string
  dockerRoot: string
  containerdRoot: string
  dockerSource: string
  containerdSource: string
}

const STORAGE_FIELDS = {
  mount_source: 'mountSource',
  root_source: 'rootSource',
  sentinel: 'sentinel',
  docker_root: 'dockerRoot',
  containerd_root: 'containerdRoot',
  docker_source: 'dockerSource',
  containerd_source: 'containerdSource',
} as const satisfies Record<string, keyof StorageProbe>

/** Parses the probe output. Returns the problems found; an empty list means every check held. */
export function evaluateStorageProbe(result: RunResult): string[] {
  if (result.exitCode !== 0) {
    return [`the probe exited ${result.exitCode}: ${excerpt(result.stderr) || excerpt(result.stdout) || 'no output'}`]
  }
  if (lastLine(result.stdout) !== STORAGE_SENTINEL) {
    return ['the probe did not end with its sentinel']
  }

  const values: Partial<StorageProbe> = {}
  for (const line of nonEmptyLines(result.stdout)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator)
    if (key in STORAGE_FIELDS) {
      values[STORAGE_FIELDS[key as keyof typeof STORAGE_FIELDS]] = line.slice(separator + 1)
    }
  }

  const problems: string[] = []
  for (const [reported, field] of Object.entries(STORAGE_FIELDS)) {
    if (!values[field]) problems.push(`the probe did not report ${reported}`)
  }
  if (problems.length > 0) return problems

  const probe = values as StorageProbe
  if (probe.sentinel !== TRACES_SENTINEL_CONTENT) problems.push('the sentinel file content is not recognised')
  if (probe.mountSource === probe.rootSource) problems.push(`${TRACES_VOLUME_MOUNT} is on the root filesystem`)
  if (!isStrictlyUnderMount(probe.dockerRoot))
    problems.push(`Docker data root ${probe.dockerRoot} is not under ${TRACES_VOLUME_MOUNT}`)
  if (!isStrictlyUnderMount(probe.containerdRoot)) {
    problems.push(`containerd root ${probe.containerdRoot} is not under ${TRACES_VOLUME_MOUNT}`)
  }
  if (probe.dockerSource !== probe.mountSource) problems.push('Docker data root is not on the volume filesystem')
  if (probe.containerdSource !== probe.mountSource) problems.push('the containerd root is not on the volume filesystem')
  return problems
}

/**
 * Fails closed unless the volume is mounted as its own filesystem, carries the
 * recognised sentinel, and both Docker's data root and the containerd root (where
 * images live on this droplet image) are on that filesystem. Used by provisioning
 * and, before anything is written, by deploy.
 */
export async function checkTracesStorage(exec: RemoteExec): Promise<void> {
  const problems = evaluateStorageProbe(await exec(bashCommand(storageProbeScript())))
  if (problems.length > 0) {
    throw new Error(`Traces storage check failed: ${problems.join('; ')}`)
  }
}

// ---------------------------------------------------------------------------
// Token files (reopen guard)
// ---------------------------------------------------------------------------

const TOKEN_CHECK_SENTINELS = ['TRACES_TOKENS_EMPTY', 'TRACES_TOKENS_PRESENT'] as const

/** Needs the volume mounted and the sentinel present; a missing token root is an error, not "empty". */
export function tokenCheckScript(): string {
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  const file = safePath(TRACES_SENTINEL_PATH)
  const root = safePath(TRACES_TOKEN_ROOT)
  return `set -eu
# traces-step:token-check
src=$(findmnt -n -o SOURCE --mountpoint ${mnt})
if [ -z "$src" ]; then echo TRACES_NOT_MOUNTED; exit 1; fi
grep -qx ${TRACES_SENTINEL_CONTENT} ${file}
if [ ! -d ${root} ]; then echo TRACES_TOKEN_ROOT_MISSING; exit 1; fi
found=$(find -L ${root} -type f -size +0c -print -quit)
if [ -n "$found" ]; then echo TRACES_TOKENS_PRESENT; else echo TRACES_TOKENS_EMPTY; fi`
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ProvisionInput {
  tracesHost: string
  privateKey: string | undefined
  knownHostsPath: string
  sshKeyName: string
  remoteUser: string
}

async function withRemote<T>(
  deps: ProvisionDeps,
  input: Pick<ProvisionInput, 'privateKey' | 'remoteUser'>,
  host: string,
  fn: (exec: RemoteExec, identityFile: string | undefined) => Promise<T>,
): Promise<T> {
  const identity =
    input.privateKey && input.privateKey.trim().length > 0 ? deps.materializeIdentity(input.privateKey) : undefined
  try {
    return await fn(createRemoteExec(deps.run, host, input.remoteUser, identity?.path), identity?.path)
  } finally {
    identity?.cleanup()
  }
}

/**
 * Create or repair. Order: droplet, volume, attach (proved), firewall, SSH, hardening,
 * volume setup, Docker, storage check. A volume that fails to attach stops the run
 * before any SSH step, so before any Docker change.
 */
export async function runProvision(input: ProvisionInput, force: boolean, deps: ProvisionDeps): Promise<void> {
  const tracesHost = validateTracesHost(input.tracesHost)
  const {run, log} = deps

  const {exists} = await checkDropletExistence(run)
  if (exists && !force) {
    throw new Error(`Droplet "${TRACES_DROPLET_NAME}" already exists. Use --force to proceed anyway.`)
  }
  if (exists) log(`⚠️  --force: Proceeding despite existing droplet "${TRACES_DROPLET_NAME}"`)

  if (!exists) {
    const fingerprint = await deps.getSshFingerprint(input.sshKeyName)
    // No --enable-backups: the volume is snapshotted instead.
    await doctl(run, [
      'compute',
      'droplet',
      'create',
      TRACES_DROPLET_NAME,
      '--image',
      DROPLET_IMAGE,
      '--size',
      DROPLET_SIZE,
      '--region',
      DROPLET_REGION,
      '--ssh-keys',
      fingerprint,
      '--wait',
    ])
  }

  const dropletId = await getDropletId(run)

  let volume = (await listVolumes(run)).find(row => row.name === TRACES_VOLUME_NAME)
  if (!volume) {
    await doctl(run, [
      'compute',
      'volume',
      'create',
      TRACES_VOLUME_NAME,
      '--region',
      DROPLET_REGION,
      '--size',
      VOLUME_SIZE,
    ])
    volume = (await listVolumes(run)).find(row => row.name === TRACES_VOLUME_NAME)
    if (!volume) throw new Error(`Volume "${TRACES_VOLUME_NAME}" not found after creation`)
  }
  if (volume.dropletIds.length > 0 && !volume.dropletIds.includes(dropletId)) {
    throw new Error(`Volume "${TRACES_VOLUME_NAME}" is attached to another droplet (${volume.dropletIds.join(', ')})`)
  }
  if (!volume.dropletIds.includes(dropletId)) {
    await attachVolume(run, volume, dropletId)
  }

  const firewallId = await ensureFirewall(run, dropletId, log)

  const dropletIp = await getDropletIp(run, deps)
  await withRemote(deps, input, dropletIp, async (exec, identityFile) => {
    await deps.waitForSsh(dropletIp, input.remoteUser, {identityFile})

    await deps.pinHostKeys(tracesHost, dropletIp, input.knownHostsPath, {
      marker: `# traces droplet (${dropletIp} / ${tracesHost})`,
    })

    log('Hardening the host (swap, core dumps, SSH passwords, journal)')
    const hardened = await applyHardening(exec)

    log('Preparing the volume')
    const volumeResult = await setupVolume(exec, TRACES_VOLUME_NAME)

    log('Moving Docker and containerd onto the volume')
    const docker = await setupDocker(exec)

    await checkTracesStorage(exec)

    const changes = [...hardened, ...volumeResult.changed, ...docker.changed]
    log(changes.length === 0 ? 'Host already provisioned; nothing changed' : `Changed: ${changes.join(', ')}`)
  })

  printOperatorSetupMessage({dropletIp, tracesHost, firewallId, log})
}

export function printOperatorSetupMessage(args: {
  dropletIp: string
  tracesHost: string
  firewallId: string
  log: (message: string) => void
}): void {
  const {dropletIp, tracesHost, firewallId, log} = args
  log('\n\u001B[1;32m✓\u001B[0m Traces droplet provisioned\n')
  log(`Droplet IP: ${dropletIp}`)
  log(`Volume: ${TRACES_VOLUME_NAME} (${VOLUME_SIZE}, mounted at ${TRACES_VOLUME_MOUNT})`)
  log(`Cloud firewall: ${FIREWALL_NAME} (${firewallId}), inbound 22, 80 and 443`)
  log(`\nDNS is manual. Create an A record: ${tracesHost} -> ${dropletIp}`)
  log(`\nBefore triggering a CI deploy, set the following in the \u001B[1mtraces\u001B[0m GitHub Environment:\n`)
  log('  Required secrets:')
  log('    TRACES_SSH_KEY           — private key for SSH access to the droplet')
  log('  Required variables:')
  log(`    TRACES_HOST              — ${tracesHost}`)
  log('\nThe application secrets (Langfuse key pair, store passwords, Grafana admin password and the long-lived')
  log(
    'application secrets) are listed in apps/traces/AGENTS.md. No sender token is issued before the privacy page is live.',
  )
  log(
    '\nCommit the updated .github/known_hosts and packages/cli/src/resources/known_hosts (byte-identical) before a CI deploy.',
  )
  log(
    'Reboot once with the volume detached and once attached, and confirm Docker is stopped and SSH works when it is detached.',
  )
}

export interface RestoreInput {
  snapshotName: string
  privateKey: string | undefined
  remoteUser: string
}

export const QUIESCE_SENTINELS = ['TRACES_QUIESCED'] as const

export function quiesceScript(): string {
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  return `set -eu
# traces-step:restore-quiesce
systemctl stop docker.socket docker containerd
if mountpoint -q ${mnt}; then umount ${mnt}; fi
if mountpoint -q ${mnt}; then echo TRACES_STILL_MOUNTED; exit 1; fi
echo TRACES_QUIESCED`
}

export function restoreVolumeName(now: Date): string {
  const iso = now.toISOString()
  return `${TRACES_VOLUME_NAME}-restore-${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 16).replace(':', '')}`
}

async function findVolumeSnapshotId(run: Runner, snapshotName: string): Promise<string | undefined> {
  const raw = await doctl(run, [
    'compute',
    'snapshot',
    'list',
    '--resource',
    'volume',
    '--format',
    'ID,Name',
    '--no-header',
  ])
  for (const line of nonEmptyLines(raw)) {
    const [id, ...name] = line.split(/\s+/)
    if (id && name.join(' ') === snapshotName) return id
  }
  return undefined
}

/**
 * Restore mode. Order is the safety property:
 *   1. remove 80 and 443 from the cloud firewall and prove it from the read-back
 *   2. only then touch any volume: look up the snapshot, create a volume from it,
 *      stop Docker and unmount, detach the old volume, attach the new one, remount
 * and stop there, with Docker stopped and the web ports closed. The old volume is
 * kept, detached. A snapshot holds the sender token files as they were, so the
 * ports stay closed at the cloud firewall (not on the volume) until every token
 * file is emptied and `--reopen-ports` is run.
 */
export async function runRestore(input: RestoreInput, deps: ProvisionDeps): Promise<void> {
  const {run, log} = deps

  const {exists} = await checkDropletExistence(run)
  if (!exists) throw new Error(`Droplet "${TRACES_DROPLET_NAME}" does not exist; provision it before restoring`)
  const dropletId = await getDropletId(run)

  const firewallId = await findFirewallId(run)
  if (!firewallId) {
    throw new Error(
      `Firewall ${FIREWALL_NAME} does not exist, so ports 80 and 443 cannot be closed. Run a normal provision first. Nothing was changed.`,
    )
  }

  await closeWebPorts(run, dropletId, firewallId)
  log('Ports 80 and 443 are closed at the cloud firewall (confirmed from the read-back)')

  const snapshotId = await findVolumeSnapshotId(run, input.snapshotName)
  if (!snapshotId) {
    throw new Error(
      `No volume snapshot named "${input.snapshotName}". Ports 80 and 443 stay closed; no volume was changed.`,
    )
  }

  const attached = (await listVolumes(run)).filter(
    row => row.dropletIds.includes(dropletId) && row.name.startsWith(TRACES_VOLUME_NAME),
  )
  const [oldVolume] = attached
  if (attached.length !== 1 || !oldVolume) {
    throw new Error(
      `Expected exactly one ${TRACES_VOLUME_NAME}* volume attached to the droplet, found ${attached.length}. Ports stay closed; no volume was changed.`,
    )
  }

  const newName = restoreVolumeName(deps.now())
  const created = await doctl(run, [
    'compute',
    'volume',
    'create',
    newName,
    '--region',
    DROPLET_REGION,
    '--size',
    VOLUME_SIZE,
    '--snapshot',
    snapshotId,
    '--format',
    'ID',
    '--no-header',
  ])
  const newVolume = (await listVolumes(run)).find(row => row.name === newName)
  if (!newVolume || (created && created !== newVolume.id)) {
    throw new Error(`Volume "${newName}" not found after creation`)
  }

  const dropletIp = await getDropletIp(run, deps)
  await withRemote(deps, input, dropletIp, async (exec, identityFile) => {
    await deps.waitForSsh(dropletIp, input.remoteUser, {identityFile})
    await runStep(exec, 'stop Docker and unmount the volume', quiesceScript(), QUIESCE_SENTINELS)

    await detachVolume(run, oldVolume, dropletId)
    await attachVolume(run, newVolume, dropletId)

    const device = volumeDevicePath(newName)
    await runStep(exec, 'probe restored volume', fsProbeScript(device), ['TRACES_FS_EXT4'])
    await runStep(exec, 'mount restored volume', mountScript(device), MOUNT_SENTINELS)
    await runStep(exec, 'verify sentinel on restored volume', verifySentinelScript(), ['TRACES_SENTINEL_PRESENT'])
  })

  log(
    `\n\u001B[1;32m✓\u001B[0m Volume ${newName} is attached and mounted in place of ${oldVolume.name} (kept, detached).`,
  )
  log('Docker is stopped and ports 80 and 443 are closed at the cloud firewall.')
  log('Next: start Docker, empty every token file (traces sender revoke --all), run a normal deploy,')
  log('then run this script with --reopen-ports and reissue all three tokens.')
  log(`The old volume ${oldVolume.name} still exists; delete it after the restore is proven.`)
}

export interface ReopenInput {
  privateKey: string | undefined
  remoteUser: string
}

/** Reopens 80 and 443 only after the host reports every sender token file empty. Refuses on anything else. */
export async function runReopen(input: ReopenInput, deps: ProvisionDeps): Promise<void> {
  const {run, log} = deps

  const {exists} = await checkDropletExistence(run)
  if (!exists) throw new Error(`Droplet "${TRACES_DROPLET_NAME}" does not exist`)
  const dropletId = await getDropletId(run)
  const firewallId = await findFirewallId(run)
  if (!firewallId) throw new Error(`Firewall ${FIREWALL_NAME} does not exist; run a normal provision first`)

  const dropletIp = await getDropletIp(run, deps)
  const verdict = await withRemote(deps, input, dropletIp, async (exec, identityFile) => {
    await deps.waitForSsh(dropletIp, input.remoteUser, {identityFile})
    return runStep(exec, 'check sender token files', tokenCheckScript(), TOKEN_CHECK_SENTINELS)
  })

  if (verdict !== 'TRACES_TOKENS_EMPTY') {
    throw new Error(
      `Refusing to reopen ports 80 and 443: a sender token file under ${TRACES_TOKEN_ROOT} is not empty. Empty every token file first (traces sender revoke --all). Ports stay closed.`,
    )
  }

  await openWebPorts(run, dropletId, firewallId)
  log(
    'Ports 80 and 443 are open at the cloud firewall (confirmed from the read-back). Reissue all three sender tokens.',
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(
  argv = process.argv.slice(2),
  env: Partial<Record<string, string>> = process.env,
): Promise<void> {
  const mode = parseProvisionArgs(argv)
  const deps = defaultDeps()

  await validateDoctl({checkAuth: true})

  if (mode.kind === 'check-exists') {
    console.log(JSON.stringify(await checkDropletExistence(deps.run)))
    return
  }

  const missing = validateRequiredEnv(env)
  if (missing.length > 0) {
    console.error(`\u001B[1;31mError:\u001B[0m Missing required environment variables: ${missing.join(', ')}`)
    console.error('Set them before running this script.')
    process.exit(1)
  }

  const remoteUser = env.REMOTE_USER ?? 'root'
  const privateKey = env.TRACES_SSH_KEY

  switch (mode.kind) {
    case 'restore': {
      await runRestore({snapshotName: mode.snapshotName, privateKey, remoteUser}, deps)
      return
    }
    case 'reopen-ports': {
      await runReopen({privateKey, remoteUser}, deps)
      return
    }
    case 'provision': {
      await runProvision(
        {
          tracesHost: validateTracesHost(env.TRACES_HOST ?? ''),
          privateKey,
          knownHostsPath: resolve(join(import.meta.dir, '..', '..', '..', '.github', 'known_hosts')),
          sshKeyName: env.TRACES_SSH_KEY_NAME ?? DEFAULT_SSH_KEY_NAME,
          remoteUser,
        },
        mode.force,
        deps,
      )
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
