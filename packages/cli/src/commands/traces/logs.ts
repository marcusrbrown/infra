import type {goke} from 'goke'
import type {SpawnFn} from './remote'

import {z} from 'zod'

import {resolveTracesHost, TRACES_SERVICES, type TracesService} from './host'
import {buildRemoteArgv, REMOTE_COMMANDS, runAttached} from './remote'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const SENSITIVE_WARNING =
  'Warning: These logs can contain prompt text, tool output, private repository content, database passwords and sender metadata. Treat the output as sensitive; do not capture it in shared logs, chat or an issue.'

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function validateService(service: string): asserts service is TracesService {
  if (!(TRACES_SERVICES as readonly string[]).includes(service)) {
    throw new Error(`Invalid service "${service}". Valid services: ${TRACES_SERVICES.join(', ')}`)
  }
}

/** A tail count is a whole number from 1 to 10,000; it goes into a remote command, so nothing else may. */
export function validateTail(tail: number): number {
  if (!Number.isInteger(tail) || tail < 1 || tail > 10_000) {
    throw new Error('Invalid --tail: must be a whole number from 1 to 10000')
  }
  return tail
}

// ─── Streaming ────────────────────────────────────────────────────────────────

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

export async function streamTracesLogs(
  opts: StreamLogsOpts,
  spawn?: SpawnFn,
  printOut: (message: string) => void = message => console.log(message),
  printErr: (message: string) => void = message => console.error(message),
): Promise<StreamLogsResult> {
  // Validate at the top so a direct caller cannot bypass the guards.
  validateService(opts.service)
  validateTail(opts.tail)

  if (process.env.CI === 'true' && !opts.allowCi) {
    printOut('Refusing to stream logs in CI without --allow-ci. Logs can contain trace content and credentials.')
    return {refused: true}
  }

  // Warn on every run: logs are sensitive in any context.
  printErr(SENSITIVE_WARNING)

  const argv = buildRemoteArgv(opts.host, REMOTE_COMMANDS.logs(opts.service, opts.tail))
  const exitCode = await runAttached(argv, spawn)
  return {refused: false, exitCode}
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerTracesLogs(cli: ReturnType<typeof goke>): void {
  cli
    .command('traces logs [service]', 'Stream logs from a trace-stack service via SSH and docker compose.')
    .option('--tail [n]', z.number().default(100).describe('Number of log lines to tail from the service.'))
    .option(
      '--allow-ci',
      z.boolean().default(false).describe('Allow log streaming in CI environments. Logs can contain trace content.'),
    )
    .option(
      '--key [key]',
      z
        .string()
        .optional()
        .describe('Environment variable name holding the SSH host. Falls back to TRACES_HOST, then traces.fro.bot.'),
    )
    .action(async (service, options) => {
      const targetService = (service as string | undefined) ?? 'collector'

      try {
        validateService(targetService)
        const host = resolveTracesHost(process.env, options.key)
        const tail = typeof options.tail === 'number' ? options.tail : 100
        const result = await streamTracesLogs({host, service: targetService, tail, allowCi: options.allowCi === true})

        if (result.refused) {
          process.exitCode = 1
          return
        }
        if (result.exitCode !== 0) {
          process.exitCode = result.exitCode ?? 1
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })
}
