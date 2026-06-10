import type {goke} from 'goke'

import {z} from 'zod'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {validateVpnHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
  stderr: {write: (msg: string) => void}
}

const SENSITIVE_WARNING =
  'Warning: Logs may contain peer IP addresses, handshake data, or other sensitive VPN information. Treat output as sensitive; do not capture in shared logs or chat.'

// ─── Injectable spawn type ────────────────────────────────────────────────────

export type LogsSpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'inherit'; stderr: 'inherit'},
) => {
  exited: Promise<number>
}

export interface StreamVpnLogsOpts {
  host: string
  tail: number
  allowCi: boolean
}

export interface StreamVpnLogsResult {
  refused: boolean
  exitCode?: number
}

function defaultLogsSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'inherit'; stderr: 'inherit'},
): {exited: Promise<number>} {
  return Bun.spawn(cmd, opts)
}

export async function streamVpnLogs(
  opts: StreamVpnLogsOpts,
  spawn: LogsSpawnFn = defaultLogsSpawn,
  printOut?: (msg: string) => void,
  printErr?: (msg: string) => void,
): Promise<StreamVpnLogsResult> {
  const isCI = process.env.CI === 'true'

  if (isCI && !opts.allowCi) {
    const msg = 'Refusing to stream logs in CI without --allow-ci. Logs may contain sensitive VPN data.'
    if (printOut) {
      printOut(msg)
    } else {
      console.log(msg)
    }

    return {refused: true}
  }

  // Warn on every run — logs are sensitive regardless of context
  if (printErr) {
    printErr(SENSITIVE_WARNING)
  } else {
    console.error(SENSITIVE_WARNING)
  }

  validateVpnHost(opts.host)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...buildKnownHostsArgs(),
    `root@${opts.host}`,
    `journalctl -u wg-quick@wg0 --no-pager -n ${opts.tail}`,
  ]

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }

  const child = spawn(sshCmd, {env, stdout: 'inherit', stderr: 'inherit'})
  const exitCode = await child.exited

  return {refused: false, exitCode}
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerVpnLogs(cli: ReturnType<typeof goke>): void {
  cli
    .command('vpn logs', 'Stream WireGuard VPN logs via SSH and journalctl.')
    .option('--tail [n]', z.number().default(100).describe('Number of log lines to tail.'))
    .option(
      '--allow-ci',
      z
        .boolean()
        .default(false)
        .describe('Allow log streaming in CI environments. Logs may contain sensitive VPN data.'),
    )
    .option(
      '--key [key]',
      z.string().describe('Environment variable name holding the SSH host. Falls back to VPN_HOST when omitted.'),
    )
    .action(async options => {
      const hostEnvKey = options.key ?? 'VPN_HOST'
      const host = process.env[hostEnvKey]

      if (!host) {
        console.error(`VPN host not set. Export ${hostEnvKey} or pass --key <env-name> pointing to a set variable.`)
        process.exitCode = 1
        return
      }

      const tail = typeof options.tail === 'number' ? options.tail : 100
      const allowCi = options.allowCi === true

      const result = await streamVpnLogs({host, tail, allowCi})

      if (result.refused) {
        process.exitCode = 1
        return
      }

      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode ?? 1
      }
    })
}
