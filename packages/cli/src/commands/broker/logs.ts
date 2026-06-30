import type {goke} from 'goke'

import {z} from 'zod'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {validateBrokerHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
  stderr: {write: (msg: string) => void}
}

const SENSITIVE_WARNING =
  'Warning: Logs may contain run identities, minted key prefixes, or other sensitive broker information. Treat output as sensitive; do not capture in shared logs or chat.'

// ─── Injectable spawn type ────────────────────────────────────────────────────

export type LogsSpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'inherit'; stderr: 'inherit'},
) => {
  exited: Promise<number>
}

export interface StreamBrokerLogsOpts {
  host: string
  tail: number
  service: string
  allowCi: boolean
}

export interface StreamBrokerLogsResult {
  refused: boolean
  exitCode?: number
}

function defaultLogsSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'inherit'; stderr: 'inherit'},
): {exited: Promise<number>} {
  return Bun.spawn(cmd, opts)
}

export async function streamBrokerLogs(
  opts: StreamBrokerLogsOpts,
  spawn: LogsSpawnFn = defaultLogsSpawn,
  printOut?: (msg: string) => void,
  printErr?: (msg: string) => void,
): Promise<StreamBrokerLogsResult> {
  const isCI = process.env.CI === 'true'

  if (isCI && !opts.allowCi) {
    const msg = 'Refusing to stream logs in CI without --allow-ci. Logs may contain sensitive broker data.'
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

  validateBrokerHost(opts.host)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...buildKnownHostsArgs(),
    `root@${opts.host}`,
    `docker compose -f /opt/broker/docker-compose.yaml logs ${opts.service} --no-log-prefix --tail ${opts.tail}`,
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

export function registerBrokerLogs(cli: ReturnType<typeof goke>): void {
  cli
    .command('broker logs', 'Stream credential broker service logs via SSH.')
    .option('--tail [n]', z.number().default(100).describe('Number of log lines to tail.'))
    .option(
      '--service [service]',
      z.string().default('broker').describe('Docker Compose service name to stream logs from.'),
    )
    .option(
      '--allow-ci',
      z
        .boolean()
        .default(false)
        .describe('Allow log streaming in CI environments. Logs may contain sensitive broker data.'),
    )
    .option(
      '--key [key]',
      z.string().describe('Environment variable name holding the SSH host. Falls back to BROKER_HOST when omitted.'),
    )
    .action(async options => {
      const hostEnvKey = options.key ?? 'BROKER_HOST'
      const host = process.env[hostEnvKey] ?? process.env.BROKER_DOMAIN

      if (!host) {
        console.error(`Broker host not set. Export ${hostEnvKey} or pass --key <env-name> pointing to a set variable.`)
        process.exitCode = 1
        return
      }

      const tail = typeof options.tail === 'number' ? options.tail : 100
      const service = typeof options.service === 'string' ? options.service : 'broker'
      const allowCi = options.allowCi === true

      const result = await streamBrokerLogs({host, tail, service, allowCi})

      if (result.refused) {
        process.exitCode = 1
        return
      }

      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode ?? 1
      }
    })
}
