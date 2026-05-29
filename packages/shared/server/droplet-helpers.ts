import {appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

// ---------------------------------------------------------------------------
// Pure-logic helpers
// ---------------------------------------------------------------------------

/** Options shared by the SSH/SCP command builders. */
export interface SshCommandOptions {
  /** Path to a private-key file. When set, the command pins it with `-i` + `IdentitiesOnly=yes`. */
  identityFile?: string
}

// When an identity file is provided, pin it and stop SSH from offering agent keys
// (avoids MaxAuthTries lockout when many keys are loaded). Empty otherwise.
function identityFlags(opts?: SshCommandOptions): string[] {
  return opts?.identityFile ? ['-i', opts.identityFile, '-o', 'IdentitiesOnly=yes'] : []
}

/**
 * Builds an SSH command array with standard BatchMode/StrictHostKeyChecking/ConnectTimeout flags.
 * When opts.identityFile is set, prepends `-i <path>` and `-o IdentitiesOnly=yes`.
 */
export function ssh(host: string, command: string, user: string, opts?: SshCommandOptions): string[] {
  return [
    'ssh',
    ...identityFlags(opts),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    `${user}@${host}`,
    command,
  ]
}

/**
 * Builds an SCP command array with standard BatchMode/StrictHostKeyChecking/ConnectTimeout flags.
 * When opts.identityFile is set, prepends `-i <path>` and `-o IdentitiesOnly=yes`.
 */
export function scp(host: string, source: string, target: string, user: string, opts?: SshCommandOptions): string[] {
  return [
    'scp',
    ...identityFlags(opts),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    source,
    `${user}@${host}:${target}`,
  ]
}

/** A materialized private-key file plus a best-effort cleanup callback. */
export interface MaterializedIdentity {
  path: string
  cleanup: () => void
}

/**
 * Writes a private key to a 0600 temp file (with a guaranteed single trailing newline)
 * and returns its path plus an idempotent best-effort cleanup callback. The trailing
 * newline guards against env/secret injection stripping it (OpenSSH rejects keys without it).
 */
export function materializeIdentityFile(privateKey: string): MaterializedIdentity {
  const dir = mkdtempSync(join(tmpdir(), 'infra-ssh-key-'))
  const path = join(dir, 'id')
  const contents = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`
  writeFileSync(path, contents, {mode: 0o600})
  chmodSync(path, 0o600)
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, {recursive: true, force: true})
      } catch {
        // Best-effort: a missing temp dir (already cleaned) is fine.
      }
    },
  }
}

/**
 * Sleeps for the given number of milliseconds.
 */
export async function sleep(ms: number): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

// ---------------------------------------------------------------------------
// Spawn-based helpers
// ---------------------------------------------------------------------------

/**
 * Runs a command, streams stdout, exits process on non-zero exit code.
 */
export async function run(label: string, command: string[]): Promise<void> {
  console.log(`\u001B[1;34m==>\u001B[0m ${label}`)
  const proc = Bun.spawn(command, {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (stdout.trim()) console.log(stdout.trim())
  if (code !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    if (stderr.trim()) console.error(stderr.trim())
    process.exit(1)
  }
}

/**
 * Runs a command and returns trimmed stdout. Throws on non-zero exit with stderr message.
 */
export async function runCapture(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(stderr.trim() || `Command failed: ${command.join(' ')}`)
  }
  return stdout.trim()
}

export interface ValidateDoctlOptions {
  /** When true, also runs `doctl account get` to verify authentication. */
  checkAuth?: boolean
}

/**
 * Checks that doctl is available on PATH. Throws with install instructions if not.
 * When opts.checkAuth is true, also runs `doctl account get`.
 */
export async function validateDoctl(opts?: ValidateDoctlOptions): Promise<void> {
  if (!Bun.which('doctl')) {
    throw new Error(
      'doctl is required. Install it first: https://docs.digitalocean.com/reference/doctl/how-to/install/',
    )
  }

  if (opts?.checkAuth) {
    await runCapture(['doctl', 'account', 'get'])
  }
}

/**
 * Checks whether a droplet with the given name exists in the DigitalOcean account.
 */
export async function dropletExists(name: string): Promise<boolean> {
  const proc = Bun.spawn(['doctl', 'compute', 'droplet', 'list', '--format', 'Name', '--no-header'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(stderr.trim() || 'Failed to list droplets')
  }
  const names = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return names.includes(name)
}

/**
 * Finds the SSH key fingerprint for the named key in the DigitalOcean account.
 * Matches by name (supports names with internal whitespace).
 * Throws a helpful error if the key is not found.
 */
export interface GetSshFingerprintOptions {
  /** Env var name to mention in the not-found error message, e.g. 'CLIPROXY_SSH_KEY_NAME'. */
  envVarName?: string
  /** Default key name to mention in the not-found error message, e.g. 'fro-bot-cliproxy'. */
  defaultKeyName?: string
}

export async function getSshFingerprint(name: string, opts?: GetSshFingerprintOptions): Promise<string> {
  const raw = await runCapture(['doctl', 'compute', 'ssh-key', 'list', '--format', 'Name,FingerPrint', '--no-header'])

  // Each row: "<Name padded with spaces>  <FingerPrint>"
  // The Name column can contain spaces, @, and dots, so we treat the last
  // whitespace-delimited token as the fingerprint and everything before it as the name.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const lastSpace = trimmed.lastIndexOf(' ')
    if (lastSpace === -1) continue
    const rowName = trimmed.slice(0, lastSpace).trim()
    const fingerprint = trimmed.slice(lastSpace + 1).trim()
    if (rowName === name) {
      return fingerprint
    }
  }

  const remediation =
    opts?.envVarName && opts?.defaultKeyName
      ? ` or set ${opts.envVarName} to override the default ("${opts.defaultKeyName}")`
      : ''
  throw new Error(
    `SSH key named "${name}" not found in DigitalOcean account. ` +
      `Run \`doctl compute ssh-key list\` to see available keys${remediation}.`,
  )
}

export interface RetryOptions {
  maxAttempts?: number
  intervalMs?: number
}

/**
 * Polls doctl for the droplet's public IPv4 address until it appears.
 * Defaults: 20 attempts × 5000ms.
 */
export async function getDropletIpWithWait(dropletName: string, opts?: RetryOptions): Promise<string> {
  const maxAttempts = opts?.maxAttempts ?? 20
  const intervalMs = opts?.intervalMs ?? 5_000

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ip = await runCapture([
      'doctl',
      'compute',
      'droplet',
      'get',
      dropletName,
      '--format',
      'PublicIPv4',
      '--no-header',
    ])
    if (ip) {
      return ip
    }
    await sleep(intervalMs)
  }

  throw new Error('Timed out waiting for droplet IPv4 address')
}

/**
 * Waits for SSH connectivity to the given host.
 * Defaults: 24 attempts × 5000ms.
 */
export async function waitForSsh(host: string, user: string, opts?: RetryOptions & SshCommandOptions): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 24
  const intervalMs = opts?.intervalMs ?? 5_000
  const sshOpts: SshCommandOptions = {identityFile: opts?.identityFile}

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const proc = Bun.spawn(ssh(host, 'echo ready', user, sshOpts), {stdout: 'pipe', stderr: 'pipe'})
    const code = await proc.exited
    if (code === 0) {
      return
    }
    await sleep(intervalMs)
  }

  throw new Error('Timed out waiting for SSH connectivity to droplet')
}

export interface PinHostKeysOptions {
  /** Marker line written before the key block, used for idempotency detection. */
  marker: string
}

/**
 * Appends domain (unhashed) and IP (hashed) host key entries to the given known_hosts file.
 * Idempotent: if the marker is already present, skips the append.
 */
export async function pinHostKeys(
  domain: string,
  ip: string,
  knownHostsPath: string,
  opts: PinHostKeysOptions,
): Promise<void> {
  const existing = readFileSync(knownHostsPath, 'utf-8')
  const {marker} = opts

  if (existing.includes(marker)) {
    console.log(`\u001B[1;34m==>\u001B[0m Host keys already pinned for ${ip}`)
    return
  }

  const domainKeys = await runCapture(['ssh-keyscan', domain])
  const ipKeys = await runCapture(['ssh-keyscan', '-H', ip])

  if (!domainKeys.trim() && !ipKeys.trim()) {
    console.warn(
      `Both ssh-keyscan calls returned empty output for domain=${domain} ip=${ip}. Skipping known_hosts pin.`,
    )
    return
  }

  const newBlock = `\n${marker}\n${domainKeys}\n${ipKeys}\n`
  appendFileSync(knownHostsPath, newBlock)
  console.log(`\u001B[1;32m✓\u001B[0m Pinned host keys for ${ip} / ${domain} in .github/known_hosts`)
  console.log('  Commit the updated .github/known_hosts before running CI deploy.')
}
