import type {goke} from 'goke'
import type {SpawnFn} from './remote'

import {z} from 'zod'

import {resolveTracesHost, TUNNEL_PORTS} from './host'
import {buildTunnelArgv, runAttached} from './remote'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

/**
 * The two local URLs the tunnel serves. The local ports must equal the host's: Langfuse's configured URL is
 * `http://localhost:3000` and Grafana's root URL is `http://localhost:3001`, so a different local port breaks
 * sign-in redirects.
 */
export const TUNNEL_URLS = {
  langfuse: `http://localhost:${TUNNEL_PORTS.langfuse}`,
  grafana: `http://localhost:${TUNNEL_PORTS.grafana}`,
} as const

export interface OpenResult {
  exitCode: number
}

/**
 * Open the SSH tunnel to Langfuse and Grafana and keep it open until it is closed (Ctrl-C). Only the two
 * loopback ports are forwarded; no command runs on the host. Langfuse and Grafana have no public hostname.
 */
export async function openTracesTunnel(
  host: string,
  spawn?: SpawnFn,
  print: (line: string) => void = line => console.log(line),
): Promise<OpenResult> {
  // Validates the host before anything is printed or spawned.
  const argv = buildTunnelArgv(host, TUNNEL_PORTS)

  print(`Langfuse: ${TUNNEL_URLS.langfuse}`)
  print(`Grafana:  ${TUNNEL_URLS.grafana}`)
  print('Tunnel open. Press Ctrl-C to close it.')

  const exitCode = await runAttached(argv, spawn)
  return {exitCode}
}

export function registerTracesOpen(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'traces open',
      'Open an SSH tunnel to Langfuse (localhost:3000) and Grafana (localhost:3001). Neither has a public hostname.',
    )
    .option(
      '--key [key]',
      z
        .string()
        .optional()
        .describe('Environment variable name holding the SSH host. Falls back to TRACES_HOST, then traces.fro.bot.'),
    )
    .example('# Forward Langfuse and Grafana to localhost until Ctrl-C')
    .example('infra traces open')
    .action(async options => {
      try {
        const host = resolveTracesHost(process.env, options.key)
        const result = await openTracesTunnel(host)
        if (result.exitCode !== 0) {
          console.error(
            `The tunnel closed with exit code ${result.exitCode}. A local port in use, or a host key mismatch, are the usual causes.`,
          )
          process.exitCode = result.exitCode
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })
}
