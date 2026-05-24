import type {goke} from 'goke'

import {note} from '@clack/prompts'
import {z} from 'zod'

const DEFAULT_HOST = 'cliproxy.fro.bot'
const DEFAULT_REMOTE_USER = 'root'

const PROVIDER_FLAGS: Record<string, string> = {
  claude: '--claude-login',
  codex: '--codex-device-login',
}

export type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdin: 'inherit'; stdout: 'inherit'; stderr: 'inherit'},
) => {exited: Promise<number>}

export interface LoginOptions {
  host?: string
}

export function resolveHost(input?: string): string {
  const host = input ?? process.env.CLIPROXY_DOMAIN ?? DEFAULT_HOST

  if (!host) {
    throw new Error('CLIPROXY_DOMAIN is required. Pass --host or set CLIPROXY_DOMAIN.')
  }

  return host
}

export function requireSshAuthSock(): string {
  const sshAuthSock = process.env.SSH_AUTH_SOCK
  if (!sshAuthSock) {
    throw new Error('SSH_AUTH_SOCK is required. Start ssh-agent and load your SSH key before running cliproxy login.')
  }

  return sshAuthSock
}

export async function cliproxyLoginAction(
  provider: string,
  options: LoginOptions,
  spawnFn: SpawnFn = Bun.spawn,
): Promise<void> {
  const providerFlag = PROVIDER_FLAGS[provider]
  if (!providerFlag) {
    throw new Error(`Unsupported provider "${provider}". Supported: claude, codex.`)
  }

  if (!process.stdin.isTTY) {
    throw new Error('cliproxy login requires an interactive terminal. Run from a shell with TTY attached.')
  }

  const host = resolveHost(options.host)
  const sshAuthSock = requireSshAuthSock()
  const path = process.env.PATH
  const home = process.env.HOME

  if (!path) {
    throw new Error('PATH is required to invoke ssh')
  }

  if (!home) {
    throw new Error('HOME is required to invoke ssh')
  }

  if (provider === 'codex') {
    note(
      "Codex login uses OpenAI's device-code flow. The droplet will print a code and a URL. Before entering the code, verify the URL points to openai.com — only complete the flow on the official OpenAI domain.",
      'Verify the URL',
    )
  }

  const remoteCommand = `cd /opt/cliproxy && docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --no-browser ${providerFlag}`

  const child = spawnFn(
    ['ssh', '-tt', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${DEFAULT_REMOTE_USER}@${host}`, remoteCommand],
    {
      env: {
        PATH: path,
        HOME: home,
        SSH_AUTH_SOCK: sshAuthSock,
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )

  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`Remote login command failed with exit code ${exitCode}`)
  }

  console.log('If an OAuth URL was printed above, open it in your browser to complete login.')
}

export function registerCliproxyLogin(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'cliproxy login <provider>',
      'Run provider login on the remote CLIProxyAPI host. Supported providers: claude, codex.',
    )
    .option(
      '--host [host]',
      z
        .string()
        .describe('CLIProxyAPI droplet host for SSH execution. Falls back to CLIPROXY_DOMAIN or cliproxy.fro.bot.'),
    )
    .example('# Start Claude login flow on remote CLIProxyAPI instance')
    .example('infra cliproxy login claude')
    .example('# Start ChatGPT Pro login flow via device-code')
    .example('infra cliproxy login codex')
    .action((provider, options) => cliproxyLoginAction(provider, options))
}
