import type {goke} from 'goke'

import {closeSync, constants as fsConstants, openSync, renameSync, unlinkSync, writeSync} from 'node:fs'

import {z} from 'zod'

import {validateGatewayHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
  stderr: {write: (msg: string) => void}
}

const MITMPROXY_CERTS_VOLUME = 'mitmproxy-certs'
const CA_CERT_FILE = 'mitmproxy-ca-cert.pem'
const CA_KEY_FILE = 'mitmproxy-ca.pem'
const DEFAULT_OUTPUT = 'apps/gateway/.local/mitmproxy-ca.tar'
const SENSITIVE_WARNING = 'Warning: Output contains the mitmproxy CA private trust anchor; treat as sensitive.'

// ─── Types ────────────────────────────────────────────────────────────────────

export type BackupSpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

export interface BackupOpts {
  host: string
  output: string
  includeCa: boolean
}

export type BackupResult = {ok: true; output: string; bytesWritten: number} | {ok: false; error: string}

// ─── Core logic ───────────────────────────────────────────────────────────────

function defaultSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
): ReturnType<BackupSpawnFn> {
  return Bun.spawn(cmd, opts) as ReturnType<BackupSpawnFn>
}

export async function backupGatewayCa(
  opts: BackupOpts,
  spawn: BackupSpawnFn = defaultSpawn,
  printErr?: (msg: string) => void,
): Promise<BackupResult> {
  if (!opts.includeCa) {
    return {ok: false, error: 'Only CA backup is currently supported; --no-include-ca is not accepted'}
  }

  // Validate host before any SSH invocation
  validateGatewayHost(opts.host)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    opts.host,
    `docker run --rm -v ${MITMPROXY_CERTS_VOLUME}:/src:ro alpine tar -cf - -C /src ${CA_CERT_FILE} ${CA_KEY_FILE}`,
  ]

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }

  const child = spawn(sshCmd, {env, stdout: 'pipe', stderr: 'pipe'})

  const [tarBytes, stderrText, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (exitCode !== 0) {
    return {
      ok: false,
      error: `SSH/docker command failed (exit ${exitCode}): ${stderrText.trim() || 'unknown error'}`,
    }
  }

  // Atomic write: open with O_CREAT|O_EXCL|0o600 (file born with correct mode, no chmod race),
  // write bytes, close, then rename to final path.
  const writeTmpSecure = (path: string, bytes: ArrayBuffer): void => {
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    try {
      writeSync(fd, new Uint8Array(bytes))
    } finally {
      closeSync(fd)
    }
  }

  let tmpPath = `${opts.output}.tmp.${Date.now()}`
  try {
    try {
      writeTmpSecure(tmpPath, tarBytes)
    } catch (error) {
      // O_EXCL collision (EEXIST) — retry once with a fresh suffix
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        tmpPath = `${opts.output}.tmp.${Date.now()}-${Math.random().toString(36).slice(2)}`
        writeTmpSecure(tmpPath, tarBytes)
      } else {
        throw error
      }
    }

    renameSync(tmpPath, opts.output)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore ENOENT or other cleanup errors
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  // Warn about sensitive content
  const warn = printErr ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  warn(SENSITIVE_WARNING)

  return {ok: true, output: opts.output, bytesWritten: tarBytes.byteLength}
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerGatewayBackup(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'gateway backup',
      'Back up the mitmproxy CA certificate and private key from the gateway Docker volume to a local tarball. The output contains the CA private trust anchor — treat it as sensitive material.',
    )
    .option(
      '--output [file]',
      z
        .string()
        .default(DEFAULT_OUTPUT)
        .describe('Local path to write the CA tarball. File permissions are set to 0600 after writing.'),
    )
    .option(
      '--include-ca',
      z
        .boolean()
        .default(true)
        .describe(
          'Include the mitmproxy CA certificate and private key in the backup. Currently the only supported backup target.',
        ),
    )
    .example('# Back up the CA to the default path')
    .example('infra gateway backup --include-ca')
    .example('# Back up the CA to a custom path')
    .example('infra gateway backup --output /secure/backup/mitmproxy-ca.tar')
    .action(async options => {
      const hostEnvKey = 'GATEWAY_HOST'
      const host = process.env[hostEnvKey]

      if (!host) {
        console.error(`Gateway host not set. Export ${hostEnvKey} before running backup.`)
        process.exitCode = 1
        return
      }

      const output = typeof options.output === 'string' ? options.output : DEFAULT_OUTPUT
      const includeCa = options.includeCa !== false

      const result = await backupGatewayCa({host, output, includeCa})

      if (!result.ok) {
        console.error(`Backup failed: ${result.error}`)
        process.exitCode = 1
        return
      }

      console.log(`CA backup written to: ${output}`)
    })
}
