import type {goke} from 'goke'

import {z} from 'zod'

import {validateCliproxyHost} from './host'

const DEFAULT_HOST = 'cliproxy.fro.bot'
const DEFAULT_REMOTE_USER = 'root'

export function resolveHost(input?: string): string {
  const host = input ?? process.env.CLIPROXY_DOMAIN ?? DEFAULT_HOST

  if (!host) {
    throw new Error('CLIPROXY_DOMAIN is required. Pass --host or set CLIPROXY_DOMAIN.')
  }

  return host
}

export function registerCliproxyOpen(cli: ReturnType<typeof goke>): void {
  cli
    .command('cliproxy open', 'Launch CLIProxyAPI TUI dashboard via SSH.')
    .option(
      '--host [host]',
      z.string().describe('SSH host for CLIProxyAPI server. Falls back to CLIPROXY_DOMAIN or cliproxy.fro.bot.'),
    )
    .example('# Open the TUI dashboard on the remote CLIProxyAPI instance')
    .example('infra cliproxy open')
    .example('# Open on a custom host')
    .example('infra cliproxy open --host custom.example.com')
    .action(async options => {
      const host = validateCliproxyHost(resolveHost(options.host))

      if (!process.stdin.isTTY) {
        throw new Error('cliproxy open requires an interactive terminal. Run from a shell with TTY attached.')
      }

      const path = process.env.PATH
      const home = process.env.HOME

      if (!path) {
        throw new Error('PATH is required to invoke ssh')
      }

      if (!home) {
        throw new Error('HOME is required to invoke ssh')
      }

      const remoteCommand = 'cd /opt/cliproxy && docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --tui'

      const child = Bun.spawn(
        [
          'ssh',
          '-tt',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          `${DEFAULT_REMOTE_USER}@${host}`,
          remoteCommand,
        ],
        {
          env: {
            PATH: path,
            HOME: home,
          },
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      )

      const exitCode = await child.exited
      if (exitCode !== 0) {
        throw new Error(`Remote TUI command failed with exit code ${exitCode}`)
      }
    })
}
