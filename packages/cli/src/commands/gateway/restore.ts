import type {goke} from 'goke'

import {z} from 'zod'

import {validateGatewayHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const MITMPROXY_CERTS_VOLUME = 'mitmproxy-certs'
const CA_CERT_FILE = 'mitmproxy-ca-cert.pem'
const CA_KEY_FILE = 'mitmproxy-ca.pem'
const COMPOSE_PROJECT_DIR = '/opt/gateway/deploy'
const EXPECTED_ARCHIVE_FILES = new Set([CA_CERT_FILE, CA_KEY_FILE])

// ─── Types ────────────────────────────────────────────────────────────────────

export type RestoreSpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

export interface RestoreOpts {
  host: string
  input: string
  includeCa: boolean
}

export type RestoreResult = {ok: true; confirmed: true} | {ok: false; error: string}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the argv array for an SSH command to the given host. */
function sshCommand(host: string, remote: string): string[] {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', `root@${host}`, remote]
}

async function spawnText(
  spawn: RestoreSpawnFn,
  cmd: string[],
  env: Record<string, string>,
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const child = spawn(cmd, {env, stdout: 'pipe', stderr: 'pipe'})
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {stdout, stderr, exitCode}
}

/**
 * Validates that the local tarball contains exactly the two expected CA files
 * and nothing else. Uses `tar -tf` to list contents without extracting.
 * Returns an error string if invalid, or undefined if valid.
 */
export function validateBackupArchive(
  inputPath: string,
  spawn: RestoreSpawnFn,
  env: Record<string, string>,
): Promise<string | undefined> {
  return spawnText(spawn, ['tar', '-tf', inputPath], env).then(result => {
    if (result.exitCode !== 0) {
      return `Cannot read archive (tar -tf exit ${result.exitCode}): ${result.stderr.trim() || 'unknown error'}`
    }
    const listed = result.stdout
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean)
    const listedSet = new Set(listed)
    const missing = [...EXPECTED_ARCHIVE_FILES].filter(f => !listedSet.has(f))
    const extra = listed.filter(f => !EXPECTED_ARCHIVE_FILES.has(f))
    if (missing.length > 0 || extra.length > 0) {
      const parts: string[] = []
      if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
      if (extra.length > 0) parts.push(`unexpected: ${extra.join(', ')}`)
      return `Backup archive is malformed — ${parts.join('; ')}`
    }
    return undefined
  })
}

// ─── Core logic ───────────────────────────────────────────────────────────────

function defaultSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
): ReturnType<RestoreSpawnFn> {
  return Bun.spawn(cmd, opts) as ReturnType<RestoreSpawnFn>
}

export async function restoreGatewayCa(
  opts: RestoreOpts,
  spawn: RestoreSpawnFn = defaultSpawn,
): Promise<RestoreResult> {
  if (!opts.includeCa) {
    return {ok: false, error: 'Only CA restore is currently supported; --no-include-ca is not accepted'}
  }

  // Validate input file is non-empty before SSHing
  const inputFile = Bun.file(opts.input)
  const inputSize = inputFile.size

  if (inputSize === 0) {
    return {ok: false, error: `Input file is empty: ${opts.input}`}
  }

  // Validate host before any SSH invocation
  validateGatewayHost(opts.host)

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }

  // COR1: Validate archive contents before touching the remote — fail fast before SCP
  const archiveError = await validateBackupArchive(opts.input, spawn, env)
  if (archiveError !== undefined) {
    return {ok: false, error: archiveError}
  }

  // SEC2: Generate an unguessable remote tmp path via mktemp on the droplet
  const mktempResult = await spawnText(spawn, sshCommand(opts.host, 'mktemp -t gateway-ca-restore-XXXXXX.tar'), env)
  if (mktempResult.exitCode !== 0) {
    return {
      ok: false,
      error: `mktemp failed on remote (exit ${mktempResult.exitCode}): ${mktempResult.stderr.trim() || 'unknown error'}`,
    }
  }
  const tmpRemote = mktempResult.stdout.trim()

  // SCP the tarball to the unguessable remote path
  const scpCmd = [
    'scp',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    opts.input,
    `root@${opts.host}:${tmpRemote}`,
  ]

  let primaryError: RestoreResult | undefined

  try {
    const scpResult = await spawnText(spawn, scpCmd, env)
    if (scpResult.exitCode !== 0) {
      primaryError = {
        ok: false,
        error: `SCP failed (exit ${scpResult.exitCode}): ${scpResult.stderr.trim() || 'unknown error'}`,
      }
      return primaryError
    }

    // Defense-in-depth: chmod 600 the SCP'd file on the remote before docker run
    const chmodResult = await spawnText(spawn, sshCommand(opts.host, `chmod 600 ${tmpRemote}`), env)
    if (chmodResult.exitCode !== 0) {
      primaryError = {
        ok: false,
        error: `chmod 600 on remote failed (exit ${chmodResult.exitCode}): ${chmodResult.stderr.trim() || 'unknown error'}`,
      }
      return primaryError
    }

    // Extract the tarball into the mitmproxy-certs volume
    const extractResult = await spawnText(
      spawn,
      sshCommand(
        opts.host,
        `docker run --rm -v ${MITMPROXY_CERTS_VOLUME}:/dst -v ${tmpRemote}:/src.tar:ro alpine sh -c 'tar -xf /src.tar -C /dst'`,
      ),
      env,
    )
    if (extractResult.exitCode !== 0) {
      primaryError = {
        ok: false,
        error: `docker run extract failed (exit ${extractResult.exitCode}): ${extractResult.stderr.trim() || 'unknown error'}`,
      }
      return primaryError
    }

    // Restart mitmproxy and gateway services
    const restartResult = await spawnText(
      spawn,
      sshCommand(opts.host, `docker compose --project-directory ${COMPOSE_PROJECT_DIR} restart mitmproxy gateway`),
      env,
    )
    if (restartResult.exitCode !== 0) {
      primaryError = {
        ok: false,
        error: `docker compose restart failed (exit ${restartResult.exitCode}): ${restartResult.stderr.trim() || 'unknown error'}`,
      }
      return primaryError
    }

    // Byte-equal confirmation: read cert and key from inside the volume
    const [certResult, keyResult] = await Promise.all([
      spawnText(
        spawn,
        sshCommand(opts.host, `docker run --rm -v ${MITMPROXY_CERTS_VOLUME}:/src:ro alpine cat /src/${CA_CERT_FILE}`),
        env,
      ),
      spawnText(
        spawn,
        sshCommand(opts.host, `docker run --rm -v ${MITMPROXY_CERTS_VOLUME}:/src:ro alpine cat /src/${CA_KEY_FILE}`),
        env,
      ),
    ])

    if (certResult.exitCode !== 0 || keyResult.exitCode !== 0) {
      primaryError = {
        ok: false,
        error: `Confirmation read failed — cert exit ${certResult.exitCode}, key exit ${keyResult.exitCode}`,
      }
      return primaryError
    }

    // Extract cert and key from the local tarball for comparison
    const localCertProc = Bun.spawnSync(['tar', '-xOf', opts.input, CA_CERT_FILE])
    const localKeyProc = Bun.spawnSync(['tar', '-xOf', opts.input, CA_KEY_FILE])

    const localCert = new TextDecoder().decode(localCertProc.stdout)
    const localKey = new TextDecoder().decode(localKeyProc.stdout)

    if (certResult.stdout !== localCert || keyResult.stdout !== localKey) {
      primaryError = {
        ok: false,
        error: `Confirmation mismatch: restored CA content does not match input tarball. The volume may be in an inconsistent state.`,
      }
      return primaryError
    }

    return {ok: true, confirmed: true}
  } finally {
    // Always clean up the tmp file from the droplet; never let cleanup mask the primary failure
    try {
      await spawnText(spawn, sshCommand(opts.host, `rm -f ${tmpRemote}`), env)
    } catch (error) {
      console.error(`Cleanup also failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerGatewayRestore(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'gateway restore',
      'Restore the mitmproxy CA certificate and private key from a local tarball into the gateway Docker volume. Restarts mitmproxy and gateway services after restore and confirms byte-equal content before reporting success.',
    )
    .option(
      '--input <file>',
      z.string().describe('Path to the tarball produced by `gateway backup --include-ca`. Required.'),
    )
    .option(
      '--include-ca',
      z
        .boolean()
        .default(true)
        .describe('Restore the mitmproxy CA certificate and private key. Currently the only supported restore target.'),
    )
    .example('# Restore CA from a backup tarball')
    .example('infra gateway restore --input apps/gateway/.local/mitmproxy-ca.tar')
    .example('# Restore CA from a custom path')
    .example('infra gateway restore --input /secure/backup/mitmproxy-ca.tar --include-ca')
    .action(async options => {
      const hostEnvKey = 'GATEWAY_HOST'
      const host = process.env[hostEnvKey]

      if (!host) {
        console.error(`Gateway host not set. Export ${hostEnvKey} before running restore.`)
        process.exitCode = 1
        return
      }

      const input = options.input
      const includeCa = options.includeCa !== false

      const result = await restoreGatewayCa({host, input, includeCa})

      if (!result.ok) {
        console.error(`Restore failed: ${result.error}`)
        process.exitCode = 1
        return
      }

      console.log('CA restore complete. Byte-equal confirmation passed.')
    })
}
