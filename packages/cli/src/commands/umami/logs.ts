import type {goke} from 'goke'

import {z} from 'zod'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {validateUmamiHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
  stderr: {write: (msg: string) => void}
}

const COMPOSE_PROJECT_DIR = '/opt/umami'
const SENSITIVE_WARNING =
  'Warning: Logs may contain database passwords, app secrets, or user data. Treat output as sensitive; do not capture in shared logs or chat.'

export const VALID_SERVICES = ['umami', 'db', 'caddy'] as const

export type ValidService = (typeof VALID_SERVICES)[number]

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function validateService(service: string): asserts service is ValidService {
  if (!VALID_SERVICES.includes(service as ValidService)) {
    throw new Error(`Invalid service "${service}". Valid services: ${VALID_SERVICES.join(', ')}`)
  }
}

// ─── Injectable spawn type ────────────────────────────────────────────────────

export type LogsSpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'inherit'; stderr: 'inherit'},
) => {
  exited: Promise<number>
}

export interface StreamLogsOpts {
  host: string
  service: string
  tail: number
  allowCi: boolean
}

export interface StreamLogsResult {
  refused: boolean
  exitCode?: number
}

function defaultLogsSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'inherit'; stderr: 'inherit'},
): {exited: Promise<number>} {
  return Bun.spawn(cmd, opts)
}

export async function streamUmamiLogs(
  opts: StreamLogsOpts,
  spawn: LogsSpawnFn = defaultLogsSpawn,
  printOut?: (msg: string) => void,
  printErr?: (msg: string) => void,
): Promise<StreamLogsResult> {
  // Validate service at the top so direct callers cannot bypass the guard.
  validateService(opts.service)

  const isCI = process.env.CI === 'true'

  if (isCI && !opts.allowCi) {
    const msg = 'Refusing to stream logs in CI without --allow-ci. Logs may contain sensitive credentials or user data.'
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

  validateUmamiHost(opts.host)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...buildKnownHostsArgs(),
    `root@${opts.host}`,
    `docker compose --project-directory ${COMPOSE_PROJECT_DIR} logs --no-color --tail=${opts.tail} ${opts.service}`,
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

export function registerUmamiLogs(cli: ReturnType<typeof goke>): void {
  cli
    .command('umami logs [service]', 'Stream logs from an Umami service via SSH and docker compose.')
    .option('--tail [n]', z.number().default(100).describe('Number of log lines to tail from each service.'))
    .option(
      '--allow-ci',
      z
        .boolean()
        .default(false)
        .describe('Allow log streaming in CI environments. Logs may contain sensitive credentials.'),
    )
    .option(
      '--key [key]',
      z.string().describe('Environment variable name holding the SSH host. Falls back to UMAMI_DOMAIN when omitted.'),
    )
    .action(async (service, options) => {
      const targetService = (service as string | undefined) ?? 'umami'

      try {
        validateService(targetService)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
        return
      }

      const hostEnvKey = options.key ?? 'UMAMI_DOMAIN'
      const host = process.env[hostEnvKey]

      if (!host) {
        console.error('Umami host not set. Export UMAMI_DOMAIN or pass --key <env-name> pointing to a set variable.')
        process.exitCode = 1
        return
      }

      const tail = typeof options.tail === 'number' ? options.tail : 100
      const allowCi = options.allowCi === true

      const result = await streamUmamiLogs({host, service: targetService, tail, allowCi})

      if (result.refused) {
        process.exitCode = 1
        return
      }

      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode ?? 1
      }
    })
}
