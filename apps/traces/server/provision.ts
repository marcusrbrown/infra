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
 *   --reopen-ports                reopen 80/443, refused while any group holds a real token (a deny-all file, one
 *                                 void line, is fine; a missing or empty token file is a fault)
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

import type {
  MaterializedIdentity,
  SshExecOptions,
  WaitForSshOptions,
} from '@marcusrbrown/infra-shared/server/droplet-helpers'

import {chmodSync, mkdtempSync, rmSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {
  getSshFingerprint,
  hostKeysPinned,
  materializeIdentityFile,
  pinHostKeys,
  sleep,
  ssh,
  SSH_CONTROL_PERSIST,
  SSH_SCAN_PAUSE_MS,
  validateDoctl,
  waitForSsh,
} from '@marcusrbrown/infra-shared/server/droplet-helpers'

import {
  isSenderGroup,
  SENDER_GROUPS,
  TRACES_APP_DIR,
  TRACES_CONTAINERD_ROOT,
  TRACES_DOCKER_ROOT,
  TRACES_DROPLET_NAME,
  TRACES_SENTINEL_CONTENT,
  TRACES_SENTINEL_PATH,
  TRACES_TEMPO_DATA_DIR,
  TRACES_TEMPO_QUARANTINE_ROOT,
  TRACES_TOKEN_ROOT,
  TRACES_VOID_TOKEN_PREFIX,
  TRACES_VOLUME_MOUNT,
  TRACES_VOLUME_NAME,
  validateTracesHost,
} from '../src/host'

export const DROPLET_IMAGE = 'docker-20-04'
export const DROPLET_SIZE = 's-4vcpu-16gb-amd'
export const DROPLET_REGION = 'nyc1'
export const VOLUME_SIZE = '100GiB'
/** A new volume can be missing from `volume list` for a few seconds after `volume create` returns. */
export const VOLUME_LIST_ATTEMPTS = 12
export const VOLUME_LIST_INTERVAL_MS = 5000
// The scan pause and control-master lifetime are the shared values in droplet-helpers.ts. Re-exported for tests.
export {SSH_CONTROL_PERSIST, SSH_SCAN_PAUSE_MS}
/** Where an operator reads what to do after a restore stops. Named in the errors that need it. */
const RESTORE_RUNBOOK = 'docs/runbooks/trace-collection.md'
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

/** Options for every remote step of one run: the identity (if any) and the one shared control socket. */
function remoteSshOptions(identityFile: string | undefined, controlPath: string): SshExecOptions {
  return {...(identityFile ? {identityFile} : {}), control: {path: controlPath, persist: SSH_CONTROL_PERSIST}}
}

/**
 * Every step goes through the control socket at `controlPath`, so the whole run is one SSH connection. The
 * image's UFW refuses a source after six connections in 30 seconds.
 */
export function createRemoteExec(
  run: Runner,
  host: string,
  user: string,
  identityFile: string | undefined,
  controlPath: string,
): RemoteExec {
  return async (command, stdin) => {
    const argv = ssh(host, command, user, remoteSshOptions(identityFile, controlPath))
    return stdin === undefined ? run(argv) : run(argv, {stdin})
  }
}

/** `ssh -O exit` through the same socket, with the same options as the steps; it opens no new connection. */
export function closeMasterArgv(host: string, user: string, identityFile: string | undefined, controlPath: string) {
  const argv = ssh(host, 'unused', user, remoteSshOptions(identityFile, controlPath))
  return [...argv.slice(0, -2), '-O', 'exit', `${user}@${host}`]
}

export interface ControlDir {
  path: string
  cleanup: () => void
}

/**
 * A private (0700) directory directly under /tmp, independent of `os.tmpdir()`: the macOS temp directory is
 * long, and a unix socket path is limited to about 104 bytes. The socket is `<path>/cm`.
 */
export function makeControlDir(): ControlDir {
  const path = mkdtempSync('/tmp/tr-cm-')
  chmodSync(path, 0o700)
  return {path, cleanup: () => rmSync(path, {recursive: true, force: true})}
}

export interface ProvisionDeps {
  run: Runner
  getSshFingerprint: (keyName: string) => Promise<string>
  waitForSsh: (host: string, user: string, opts?: WaitForSshOptions) => Promise<void>
  pinHostKeys: typeof pinHostKeys
  hostKeysPinned: typeof hostKeysPinned
  materializeIdentity: (privateKey: string) => MaterializedIdentity
  makeControlDir: () => ControlDir
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
    hostKeysPinned,
    materializeIdentity: materializeIdentityFile,
    makeControlDir,
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
  /** The volume's description; empty when it has none. A restore volume records its snapshot here. */
  description: string
  dropletIds: string[]
}

/**
 * Reads `doctl compute volume list --output json`: an array of the API's volume objects. JSON rather than the
 * whitespace-split text table, because a description is free text (the table would need a column and would split it),
 * and because the `description` and `droplet_ids` fields are the API's own names, not a column label to guess.
 * Anything that is not an array of volumes with a string `id` and `name` fails closed.
 */
export function parseVolumeRows(raw: string): VolumeRow[] {
  const text = raw.trim()
  if (text === '') return []
  const bad = (): Error => new Error('Unrecognised volume listing from doctl (expected a JSON array of volumes)')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw bad()
  }
  if (parsed === null) return []
  if (!Array.isArray(parsed)) throw bad()
  return parsed.map((entry: unknown): VolumeRow => {
    if (typeof entry !== 'object' || entry === null) throw bad()
    const {id, name, description, droplet_ids: dropletIds} = entry as Record<string, unknown>
    if (typeof id !== 'string' || typeof name !== 'string') throw bad()
    return {
      id,
      name,
      description: typeof description === 'string' ? description : '',
      dropletIds: Array.isArray(dropletIds) ? dropletIds.map(String) : [],
    }
  })
}

async function listVolumes(run: Runner): Promise<VolumeRow[]> {
  return parseVolumeRows(
    await doctl(run, ['compute', 'volume', 'list', '--region', DROPLET_REGION, '--output', 'json']),
  )
}

/**
 * Lists volumes until `settled` accepts the listing, or `VOLUME_LIST_ATTEMPTS` listings have not satisfied it, and
 * returns the last listing. DigitalOcean's listing can lag a change for a few seconds (a created volume is missing,
 * a completed attach or detach is not shown yet). The pause comes between listings only: none before the first,
 * none after the last. The caller decides what an unsettled last listing means.
 */
async function pollVolumeListing(
  run: Runner,
  deps: Pick<ProvisionDeps, 'sleep'>,
  settled: (rows: VolumeRow[]) => boolean,
): Promise<VolumeRow[]> {
  let rows: VolumeRow[] = []
  for (let attempt = 1; attempt <= VOLUME_LIST_ATTEMPTS; attempt++) {
    if (attempt > 1) await deps.sleep(VOLUME_LIST_INTERVAL_MS)
    rows = await listVolumes(run)
    if (settled(rows)) break
  }
  return rows
}

/** A volume just created can be missing from the listing for a few seconds. `undefined` means it never appeared. */
async function waitForListedVolume(run: Runner, deps: ProvisionDeps, name: string): Promise<VolumeRow | undefined> {
  const rows = await pollVolumeListing(run, deps, listing => listing.some(row => row.name === name))
  return rows.find(row => row.name === name)
}

/**
 * Any failure of an attach or detach: after the call was made, nothing proves whether the change happened.
 * `doctl ... --wait` submits the action and then polls, so a non-zero exit can follow a change DigitalOcean
 * accepted; a listing that fails, is not JSON, or never shows the result proves nothing either. The message tells
 * the operator to look before doing anything, and not to run provisioning or the restore again.
 */
export class VolumeStateUnknownError extends Error {
  override readonly name = 'VolumeStateUnknownError'
  constructor(volume: VolumeRow, change: 'attach' | 'detach', dropletId: string, cause: unknown) {
    super(
      `Could not confirm the ${change} of volume "${volume.name}" on droplet ${dropletId} (${causeOf(cause)}). Its state is unknown: the change may or may not have taken effect. Check doctl compute volume list and the droplet's attached volumes before doing anything else, and do not run provisioning or the restore again until you know. See ${RESTORE_RUNBOOK}, "Interrupted restore".`,
      {cause},
    )
  }
}

/**
 * Attaches or detaches a volume and proves it from the listing. A successful call is not enough: provisioning must
 * not reach any Docker change on a volume that is not attached. The listing can lag the completed action, so it is
 * read again (same budget as a created volume) before the change is called unconfirmed. Every failure from the call
 * onward throws `VolumeStateUnknownError`, and no branch claims the volume did or did not change.
 */
async function changeVolumeAttachment(
  run: Runner,
  deps: Pick<ProvisionDeps, 'sleep'>,
  volume: VolumeRow,
  dropletId: string,
  change: 'attach' | 'detach',
): Promise<void> {
  const settled = (rows: VolumeRow[]): boolean =>
    (rows.find(row => row.id === volume.id)?.dropletIds.includes(dropletId) === true) === (change === 'attach')
  try {
    await doctl(run, ['compute', 'volume-action', change, volume.id, dropletId, '--wait'])
    if (!settled(await pollVolumeListing(run, deps, settled))) {
      throw new Error(
        `the listing did not show it ${change === 'attach' ? 'attached' : 'detached'} after ${VOLUME_LIST_ATTEMPTS} reads`,
      )
    }
  } catch (error) {
    throw new VolumeStateUnknownError(volume, change, dropletId, error)
  }
}

const attachVolume = (run: Runner, deps: Pick<ProvisionDeps, 'sleep'>, volume: VolumeRow, dropletId: string) =>
  changeVolumeAttachment(run, deps, volume, dropletId, 'attach')

const detachVolume = (run: Runner, deps: Pick<ProvisionDeps, 'sleep'>, volume: VolumeRow, dropletId: string) =>
  changeVolumeAttachment(run, deps, volume, dropletId, 'detach')

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
      // A version 2 file must name a plugin by its full id: containerd 2.x refuses the short name `cri` there
      // (the stock file has no version line, which is why the short name works in it).
      content: `# ${MANAGED_MARKER}\nversion = 2\nroot = "${TRACES_CONTAINERD_ROOT}"\ndisabled_plugins = ["io.containerd.grpc.v1.cri"]\n`,
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

const TOKEN_CHECK_SENTINELS = ['TRACES_TOKENS_DENY_ALL', 'TRACES_TOKENS_REAL'] as const

const TOKEN_FILE_FAULT_RE = /^TRACES_TOKEN_FILE_(MISSING|EMPTY)=(\S+)$/m

/**
 * A token file is never empty (the collector's credential watcher rejects an empty file), so "no token" is a
 * deny-all file: void lines only. A real token is a non-blank line whose first field does not start with the void
 * prefix. The host counts lines by that prefix and prints nothing but a verdict, so no token text, void or real,
 * leaves it. A group whose file is missing, or has no non-blank line, is a fault and not "no token": it exits
 * non-zero with its own sentinel. Every group is checked before a verdict, so a fault is never hidden by a real
 * token in an earlier group. Needs the volume mounted and the sentinel present; a missing token root is an error too.
 */
export function tokenCheckScript(): string {
  const mnt = safePath(TRACES_VOLUME_MOUNT)
  const file = safePath(TRACES_SENTINEL_PATH)
  const root = safePath(TRACES_TOKEN_ROOT)
  if (!/^\w+$/.test(TRACES_VOID_TOKEN_PREFIX)) throw new Error('Unsafe void token prefix')
  return `set -eu
# traces-step:token-check
src=$(findmnt -n -o SOURCE --mountpoint ${mnt})
if [ -z "$src" ]; then echo TRACES_NOT_MOUNTED; exit 1; fi
grep -qx ${TRACES_SENTINEL_CONTENT} ${file}
if [ ! -d ${root} ]; then echo TRACES_TOKEN_ROOT_MISSING; exit 1; fi
real=0
for g in ${SENDER_GROUPS.join(' ')}; do
  f=${root}/$g/token
  if [ ! -f "$f" ]; then echo "TRACES_TOKEN_FILE_MISSING=$g"; exit 1; fi
  counts=$(awk -v p=${TRACES_VOID_TOKEN_PREFIX} 'NF > 0 { n++; if (index($1, p) != 1) r++ } END { print n + 0, r + 0 }' "$f")
  set -- $counts
  if [ "$1" -eq 0 ]; then echo "TRACES_TOKEN_FILE_EMPTY=$g"; exit 1; fi
  if [ "$2" -gt 0 ]; then real=1; fi
done
if [ "$real" = 1 ]; then echo TRACES_TOKENS_REAL; else echo TRACES_TOKENS_DENY_ALL; fi`
}

/**
 * Runs the token check. A missing or empty token file is thrown here, with its own message, before the generic
 * sentinel check: it must never read as "no token" and must not be mistaken for a real token either.
 */
export async function checkTokenFiles(exec: RemoteExec): Promise<(typeof TOKEN_CHECK_SENTINELS)[number]> {
  const result = await exec(bashCommand(tokenCheckScript()))
  const fault = result.exitCode === 0 ? undefined : TOKEN_FILE_FAULT_RE.exec(result.stdout)
  const group = fault?.[2]
  if (fault && group !== undefined && isSenderGroup(group)) {
    throw new Error(
      fault[1] === 'MISSING'
        ? `Refusing to reopen ports 80 and 443: the ${group} token file under ${TRACES_TOKEN_ROOT} is missing. A token file always exists and holds at least one line; a group with no file refuses nothing it should and may not start. Run a normal deploy (it creates a missing file as deny-all). Ports stay closed.`
        : `Refusing to reopen ports 80 and 443: the ${group} token file under ${TRACES_TOKEN_ROOT} is empty. The collector rejects an empty file, and a collector that started with one refuses that group until it is restarted. Run traces sender revoke --all to rewrite every file as deny-all, and restart the collector if it started with the empty file. Ports stay closed.`,
    )
  }
  return expectSentinel(result, TOKEN_CHECK_SENTINELS, 'check sender token files')
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
  const control = deps.makeControlDir()
  const controlPath = join(control.path, 'cm')
  let identity: MaterializedIdentity | undefined
  let started = false
  try {
    identity =
      input.privateKey && input.privateKey.trim().length > 0 ? deps.materializeIdentity(input.privateKey) : undefined
    started = true
    return await fn(createRemoteExec(deps.run, host, input.remoteUser, identity?.path, controlPath), identity?.path)
  } finally {
    if (started) {
      try {
        // Finds no master when no step got as far as connecting; that is fine, it opens no connection.
        await deps.run(closeMasterArgv(host, input.remoteUser, identity?.path, controlPath))
      } catch {
        // The master also exits on its own after ControlPersist.
      }
    }
    identity?.cleanup()
    control.cleanup()
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
    volume = await waitForListedVolume(run, deps, TRACES_VOLUME_NAME)
    if (!volume) throw new Error(`Volume "${TRACES_VOLUME_NAME}" not found after creation`)
  }
  if (volume.dropletIds.length > 0 && !volume.dropletIds.includes(dropletId)) {
    throw new Error(`Volume "${TRACES_VOLUME_NAME}" is attached to another droplet (${volume.dropletIds.join(', ')})`)
  }
  if (!volume.dropletIds.includes(dropletId)) {
    await attachVolume(run, deps, volume, dropletId)
  }

  const firewallId = await ensureFirewall(run, dropletId, log)

  const dropletIp = await getDropletIp(run, deps)
  await withRemote(deps, input, dropletIp, async (exec, identityFile) => {
    await deps.waitForSsh(dropletIp, input.remoteUser, {identityFile})

    const marker = `# traces droplet (${dropletIp} / ${tracesHost})`
    const willScan = !deps.hostKeysPinned(input.knownHostsPath, marker)
    await deps.pinHostKeys(tracesHost, dropletIp, input.knownHostsPath, {marker, pauseBeforeScanMs: SSH_SCAN_PAUSE_MS})
    // The scans just spent the connection budget; the control master must not open in the same window.
    if (willScan) await deps.sleep(SSH_SCAN_PAUSE_MS)

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
  return `${TRACES_VOLUME_NAME}-restore-${restoreStamp(now)}`
}

/** A snapshot name the label can carry whole: what `--restore-snapshot` accepts, and short enough to store. */
const LABELLABLE_SNAPSHOT_RE = /^[a-z\d][\w.-]{0,127}$/i

/**
 * The description a restore volume is created with: `restore-of:<snapshot name>`, no spaces. It is a label for a person
 * reading `doctl compute volume list` and nothing more: no code reads it back to decide anything. A name that cannot
 * be written whole is refused before any change, so the label is never truncated or reshaped.
 */
export function restoreDescription(snapshotName: string): string {
  if (!LABELLABLE_SNAPSHOT_RE.test(snapshotName)) {
    throw new Error(
      `Snapshot name "${snapshotName.slice(0, 40)}" cannot be written on the restore volume's description: use 1 to 128 letters, digits, dots, dashes and underscores, not starting with a dash or an underscore. Nothing was changed.`,
    )
  }
  return `restore-of:${snapshotName}`
}

/** `YYYYMMDD-HHMM` in UTC: the restore volume's name and the quarantine directory carry the same stamp. */
export function restoreStamp(now: Date): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 16).replace(':', '')}`
}

const BLOCK_UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
export const TEMPO_QUARANTINE_DONE_PREFIX = 'TRACES_TEMPO_QUARANTINE_DONE'
export const TEMPO_QUARANTINED_PREFIX = 'TRACES_TEMPO_QUARANTINED'

export interface TempoQuarantineOptions {
  /** Tempo's data directory (holds `blocks/`). The default is the Docker volume on the encrypted volume. */
  dataDir?: string
  quarantineRoot?: string
  /** `YYYYMMDD-HHMM` (UTC) of the restore. */
  stamp: string
}

/**
 * Moves every Tempo block with torn metadata out of `blocks/` so Tempo can build its tenant index.
 *
 * A volume snapshot is taken while Tempo runs, so it can catch a block directory whose files were created but whose
 * data had not reached the disk: every file zero bytes. One empty `meta.json` fails the tenant index, and Tempo then
 * serves nothing from stored blocks.
 *
 * Torn, narrowly: a block directory (its name is a UUID) that has a `meta.json`, or a `meta.compacted.json`, that is
 * empty or is not a JSON object. A directory with neither file is left alone: Tempo treats it as mid-write or cleared.
 * Plain files (`work.json`, `index.json.gz`, `index.pb.zst`), non-UUID entries and symlinks are never touched.
 *
 * "Not a JSON object" is the first and the last non-space byte being `{` and `}`, not a parse. No script in this repo
 * relies on `python3`, and the host image's coreutils are the only tools certain to be there. The check therefore
 * catches the real failure (empty, cut off, garbage) and not text that happens to be braced; a test pins that limit.
 *
 * A torn block is moved with `mv` to `<quarantineRoot>/<stamp>/<tenant>/<block>`, on the same filesystem (a rename:
 * the step refuses when it is not, and refuses to overwrite). It is never copied or deleted, and the step makes the
 * directories it creates mode 0700 (root, since the step runs as root). Idempotent: a second run finds nothing.
 * A missing data or `blocks` directory (a snapshot from before Tempo wrote) is nothing to do. Prints one
 * `TRACES_TEMPO_QUARANTINED <tenant>/<block>` line per move and ends with `TRACES_TEMPO_QUARANTINE_DONE <count>`.
 */
export function tempoQuarantineScript(options: TempoQuarantineOptions): string {
  if (!/^\d{8}-\d{4}$/.test(options.stamp)) throw new Error(`Unsafe quarantine stamp: ${options.stamp}`)
  const data = safePath(options.dataDir ?? TRACES_TEMPO_DATA_DIR)
  const quarantine = safePath(options.quarantineRoot ?? TRACES_TEMPO_QUARANTINE_ROOT)
  return String.raw`set -eu
# traces-step:tempo-quarantine
shopt -s nullglob
data=${data}
quarantine=${quarantine}
stamp=${options.stamp}
count=0
is_object() {
  [ -s "$1" ] || return 1
  first=$(tr -d '[:space:]' < "$1" | head -c 1 || true)
  last=$(tr -d '[:space:]' < "$1" | tail -c 1 || true)
  [ "$first" = '{' ] && [ "$last" = '}' ]
}
torn() {
  local f
  for f in "$1/meta.json" "$1/meta.compacted.json"; do
    if [ -e "$f" ] && ! is_object "$f"; then return 0; fi
  done
  return 1
}
dev_of() { stat -c %d "$1" || stat -f %d "$1"; }
if [ -d "$data/blocks" ] && [ ! -L "$data/blocks" ]; then
  for tenant_dir in "$data"/blocks/*; do
    if [ ! -d "$tenant_dir" ] || [ -L "$tenant_dir" ]; then continue; fi
    tenant=$(basename "$tenant_dir")
    for block_dir in "$tenant_dir"/*; do
      if [ ! -d "$block_dir" ] || [ -L "$block_dir" ]; then continue; fi
      block=$(basename "$block_dir")
      if ! [[ $block =~ ${BLOCK_UUID_PATTERN} ]]; then continue; fi
      if ! torn "$block_dir"; then continue; fi
      dest=$quarantine/$stamp/$tenant
      install -d -m 0700 "$quarantine" "$quarantine/$stamp" "$dest"
      if [ "$(dev_of "$block_dir")" != "$(dev_of "$dest")" ]; then echo TRACES_TEMPO_QUARANTINE_CROSS_DEVICE; exit 1; fi
      if [ -e "$dest/$block" ]; then echo TRACES_TEMPO_QUARANTINE_EXISTS; exit 1; fi
      mv -- "$block_dir" "$dest/$block"
      printf '%s %s/%s\n' ${TEMPO_QUARANTINED_PREFIX} "$tenant" "$block"
      count=$((count + 1))
    done
  done
fi
echo "${TEMPO_QUARANTINE_DONE_PREFIX} $count"`
}

const QUARANTINED_LINE = new RegExp(String.raw`^${TEMPO_QUARANTINED_PREFIX} ([\w.-]+)/([0-9a-fA-F-]{36})$`)
const QUARANTINE_DONE_LINE = new RegExp(String.raw`^${TEMPO_QUARANTINE_DONE_PREFIX} (\d+)$`)

/** The `<tenant>/<block>` entries the quarantine step moved. Exit 0, well-formed lines and a matching count, or it throws. */
export function parseTempoQuarantine(result: RunResult): string[] {
  const label = 'Tempo block quarantine'
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}): ${excerpt(result.stderr) || excerpt(result.stdout) || 'no output'}`,
    )
  }
  const lines = nonEmptyLines(result.stdout)
  const done = QUARANTINE_DONE_LINE.exec(lines.at(-1) ?? '')
  const moved = lines.slice(0, -1).map(line => QUARANTINED_LINE.exec(line))
  if (!done || moved.includes(null) || Number(done[1]) !== moved.length) {
    throw new Error(`${label}: unrecognised answer from the host (expected a count that matches the moved blocks)`)
  }
  return moved.flatMap(match => (match ? [`${match[1]}/${match[2]}`] : []))
}

function reportQuarantine(log: ProvisionDeps['log'], moved: readonly string[], stamp: string): void {
  if (moved.length === 0) {
    log('No torn Tempo blocks were found on the restored volume.')
    return
  }
  const noun = moved.length === 1 ? 'block' : 'blocks'
  log(`Quarantined ${moved.length} Tempo ${noun} with torn metadata (tenant/block): ${moved.join(', ')}.`)
  log(
    `They were moved, not deleted, to ${TRACES_TEMPO_QUARANTINE_ROOT}/${stamp}/<tenant>/<block>. The snapshot caught Tempo mid-write, so Tempo may be missing the traces of its most recent compaction for each quarantined block; Langfuse is the complete record. Nothing prunes the quarantine and it is not covered by retention: delete it once you have looked.`,
  )
}

/**
 * A volume by name and state: `name (detached)`, `name (attached to this droplet)` or `name (attached to droplet 9, not
 * this one)`, plus `, label "x"` when it has a description. Never by id. The description is text from the cloud, so it
 * is cut short and shown printable-ASCII only.
 */
function describeVolume(row: VolumeRow, dropletId: string): string {
  const state =
    row.dropletIds.length === 0
      ? 'detached'
      : row.dropletIds.includes(dropletId) && row.dropletIds.length === 1
        ? 'attached to this droplet'
        : row.dropletIds.includes(dropletId)
          ? `attached to this droplet and droplet ${row.dropletIds.filter(id => id !== dropletId).join(', ')}`
          : `attached to droplet ${row.dropletIds.join(', ')}, not this one`
  const label = row.description.replaceAll(/[^\u0020-\u007E]/g, '?').slice(0, 128)
  return `${row.name} (${state}${label === '' ? '' : `, label "${label}"`})`
}

/**
 * Why a restore stops when it does not find exactly one attached `traces-data*` volume: how many it found, that the
 * ports stay closed and nothing was changed, every `traces-data*` volume with its state and label, and the way
 * forward. The way forward never deletes anything: with none attached (the state an interrupted restore leaves) it is
 * to attach the previous volume by hand and run the restore again from the start.
 */
function volumeCountRefusal(family: VolumeRow[], attachedCount: number, dropletId: string): string {
  const found = family.length === 0 ? 'none' : family.map(row => describeVolume(row, dropletId)).join(', ')
  const head = `Expected exactly one ${TRACES_VOLUME_NAME}* volume attached to the droplet, found ${attachedCount}. Ports 80 and 443 stay closed; no volume was changed. ${TRACES_VOLUME_NAME}* volumes found: ${found}.`
  if (attachedCount > 1) {
    return `${head} This run replaces one attached volume and cannot tell which of these is the live one. Make exactly one ${TRACES_VOLUME_NAME}* volume attached to droplet ${dropletId} by hand (stop Docker and unmount a volume before detaching it), then run the same restore command again from the start.`
  }
  if (family.length === 0) {
    return `${head} There is nothing to replace. Check the region and the account with doctl compute volume list.`
  }
  return `${head} This is the state an interrupted restore leaves: this run cannot tell which detached volume held the live data, and it deletes nothing. To go on, identify the volume that was live before, attach it by hand with doctl compute volume-action attach <volume-id> ${dropletId} --wait, then run the same restore command again from the start. A leftover restore volume can be deleted only after a restore is proven.`
}

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
 *   2. only then touch any volume: look up the snapshot, require exactly one attached `traces-data*` volume (the one
 *      being replaced, whatever it is named), create a volume from the snapshot, stop Docker and unmount, detach the
 *      old volume, attach the new one, remount
 * The volume listing can lag a completed attach or detach, so each is read back
 * for a bounded time (the same budget as a created volume) before it is called failed.
 * There is no resume. A run that is not exactly one attached volume (an interrupted restore leaves none) stops after
 * closing the ports and before any volume change, with the volumes listed and the hand step to take; a detach or
 * attach that fails says the same. The operator attaches the previous volume by hand and runs the restore again from
 * the start.
 * Once the restored volume is mounted and its sentinel verified, with Docker still stopped, Tempo blocks whose
 * metadata is torn (a snapshot taken mid-write) are moved to a quarantine directory (`tempoQuarantineScript`) and
 * reported. The run stops there, with Docker stopped and the web ports closed. The old volume is
 * kept, detached. A snapshot holds the sender token files as they were, so the
 * ports stay closed at the cloud firewall (not on the volume) until every token
 * file is deny-all (`traces sender revoke --all`) and `--reopen-ports` is run.
 */
export async function runRestore(input: RestoreInput, deps: ProvisionDeps): Promise<void> {
  const {run, log} = deps
  // Refused before anything is touched: the label is written whole or not at all.
  const description = restoreDescription(input.snapshotName)
  // One clock read for the whole run: the restore volume's name, the quarantine directory it writes and the one the
  // report names all carry the same stamp, even if the run crosses a UTC minute.
  const startedAt = deps.now()
  const stamp = restoreStamp(startedAt)

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

  const volumes = await listVolumes(run)
  const family = volumes.filter(row => row.name.startsWith(TRACES_VOLUME_NAME))
  const attached = family.filter(row => row.dropletIds.includes(dropletId))
  // The attached volume is the one being replaced, whatever it is named: after a restore it is itself a
  // `traces-data-restore-*` volume. A detached volume beside it (a leftover restore volume) is not touched.
  const [previous, ...otherAttached] = attached
  if (!previous || otherAttached.length > 0) {
    throw new Error(volumeCountRefusal(family, attached.length, dropletId))
  }

  const newName = restoreVolumeName(startedAt)
  if (volumes.some(row => row.name === newName)) {
    throw new Error(
      `A volume named ${newName} already exists, so a restore started in this minute cannot create its volume. Ports 80 and 443 stay closed; no volume was changed. Wait a minute and run the same command again.`,
    )
  }
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
    '--desc',
    description,
    '--format',
    'ID',
    '--no-header',
  ])
  const newVolume = await waitForListedVolume(run, deps, newName)
  if (!newVolume || (created && created !== newVolume.id)) {
    // Reached after 80 and 443 were closed and before any volume was detached or any host step ran.
    throw new Error(
      `Volume "${newName}" not found after creation. Ports 80 and 443 stay closed; the old volume is still attached and Docker was not touched.`,
    )
  }

  // The one hand step after a swap stops part-way: get the previous volume attached to the droplet, then start over.
  const handStep = `doctl compute volume-action attach ${previous.id} ${dropletId} --wait`
  // A detach or attach that did not confirm leaves the volume's state unknown, so the restore stops here. The error
  // itself carries the check-first, do-not-rerun instruction; this adds where the swap had got to.
  const swapStopped = (error: unknown, state: string): Error =>
    new Error(
      `Restore interrupted: Docker is stopped. Ports 80 and 443 stay closed; ${state} ${causeOf(error)} Only if no ${TRACES_VOLUME_NAME}* volume is attached to droplet ${dropletId} once you know, attach ${previous.name} by hand with ${handStep}.`,
    )

  let quarantined: string[] = []
  const dropletIp = await getDropletIp(run, deps)
  await withRemote(deps, input, dropletIp, async (exec, identityFile) => {
    await deps.waitForSsh(dropletIp, input.remoteUser, {identityFile})
    await runStep(exec, 'stop Docker and unmount the volume', quiesceScript(), QUIESCE_SENTINELS)

    try {
      await detachVolume(run, deps, previous, dropletId)
    } catch (error) {
      throw swapStopped(error, `${newName} was created and this run did not attach it.`)
    }
    try {
      await attachVolume(run, deps, newVolume, dropletId)
    } catch (error) {
      throw swapStopped(error, `${previous.name} was detached and kept.`)
    }

    const device = volumeDevicePath(newName)
    await runStep(exec, 'probe restored volume', fsProbeScript(device), ['TRACES_FS_EXT4'])
    await runStep(exec, 'mount restored volume', mountScript(device), MOUNT_SENTINELS)
    await runStep(exec, 'verify sentinel on restored volume', verifySentinelScript(), ['TRACES_SENTINEL_PRESENT'])

    // Docker is still stopped, so Tempo is not writing. A torn block would stop it serving any stored block.
    try {
      quarantined = parseTempoQuarantine(await exec(bashCommand(tempoQuarantineScript({stamp}))))
    } catch (error) {
      throw new Error(
        `${causeOf(error)}. Restore interrupted: Docker is stopped. Ports 80 and 443 stay closed; ${newName} is attached and mounted and the Tempo block check did not finish. Look at ${TRACES_TEMPO_DATA_DIR}/blocks by hand and do not run the restore again: it would start another restore from this volume.`,
      )
    }
  })

  log(
    `\n\u001B[1;32m✓\u001B[0m Volume ${newName} is attached and mounted in place of ${previous.name} (kept, detached).`,
  )
  log('Docker is stopped and ports 80 and 443 are closed at the cloud firewall.')
  log('Next: start Docker, make every token file deny-all (traces sender revoke --all), run a normal deploy,')
  log('then run this script with --reopen-ports and reissue all three tokens.')
  log(`The old volume ${previous.name} still exists; delete it after the restore is proven.`)
  reportQuarantine(log, quarantined, stamp)
}

export interface ReopenInput {
  privateKey: string | undefined
  remoteUser: string
}

/**
 * Reopens 80 and 443 only after the host reports every sender token file deny-all (void lines only, no real token).
 * Refuses on a real token, and faults on a missing or empty token file. Refuses on anything else.
 */
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
    return checkTokenFiles(exec)
  })

  if (verdict !== 'TRACES_TOKENS_DENY_ALL') {
    throw new Error(
      `Refusing to reopen ports 80 and 443: a sender token file under ${TRACES_TOKEN_ROOT} still holds a real token. Make every token file deny-all first (traces sender revoke --all). Ports stay closed.`,
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
