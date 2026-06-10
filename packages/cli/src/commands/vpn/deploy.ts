import type {goke} from 'goke'

import {z} from 'zod'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const REPO = 'marcusrbrown/infra'
const WORKFLOW_NAME = 'Deploy VPN'
const WORKFLOW_URL = 'https://github.com/marcusrbrown/infra/actions/workflows/deploy-vpn.yaml'

type CliInstance = ReturnType<typeof goke>

// ─── Env helpers ─────────────────────────────────────────────────────────────

export function getVpnDeployEnv(): Record<string, string> {
  const path = process.env.PATH
  const home = process.env.HOME
  const sshAuthSock = process.env.SSH_AUTH_SOCK

  if (!path) {
    throw new Error('PATH is required for local deploy')
  }

  if (!home) {
    throw new Error('HOME is required for local deploy')
  }

  if (!sshAuthSock) {
    throw new Error('SSH_AUTH_SOCK is required for local deploy. Start ssh-agent and load your deploy key first.')
  }

  return {
    PATH: path,
    HOME: home,
    SSH_AUTH_SOCK: sshAuthSock,
    VPN_HOST: process.env.VPN_HOST ?? '',
  }
}

export function validateVpnRemotePreconditions(): void {
  if (!Bun.which('gh')) {
    throw new Error('gh CLI is required for remote deploy. Install gh and run `gh auth login`.')
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerVpnDeploy(cli: CliInstance): void {
  cli
    .command(
      'vpn deploy',
      'Deploy the VPN. Default mode triggers the GitHub Deploy VPN workflow, while --local runs apps/vpn deploy directly with Bun.',
    )
    .option(
      '--local',
      z
        .boolean()
        .default(false)
        .describe('Run local deployment with Bun using apps/vpn instead of triggering GitHub Actions.'),
    )
    .option(
      '--dry-run',
      z
        .boolean()
        .default(false)
        .describe(
          'Validate deploy prerequisites and print planned actions without executing local deploy or dispatching workflow.',
        ),
    )
    .option(
      '--force-server-key',
      z
        .boolean()
        .default(false)
        .describe(
          'Force regeneration of the server WireGuard keypair. WARNING: invalidates all existing client configs.',
        ),
    )
    .example('# Trigger remote GitHub Actions deploy (default mode)')
    .example('infra vpn deploy')
    .example('# Validate local deploy preconditions and planned command')
    .example('infra vpn deploy --local --dry-run')
    .example('# Run local deploy with explicit SSH agent context')
    .example('infra vpn deploy --local')
    .action(async options => {
      if (options.local) {
        const command = [
          'bun',
          'run',
          '--cwd',
          'apps/vpn',
          'deploy',
          ...(options.forceServerKey ? ['--force-server-key'] : []),
        ]

        if (options.dryRun) {
          console.log('Dry run: local vpn deploy')
          console.log(`- command: ${command.join(' ')}`)
          return
        }

        const env = getVpnDeployEnv()

        const child = Bun.spawn(command, {
          env,
          stdout: 'inherit',
          stderr: 'inherit',
        })

        const exitCode = await child.exited
        if (exitCode !== 0) {
          throw new Error(`Local deploy failed with exit code ${exitCode}`)
        }

        return
      }

      validateVpnRemotePreconditions()

      if (options.dryRun) {
        console.log('Dry run: remote vpn deploy')
        console.log(`- command: gh workflow run "${WORKFLOW_NAME}" --repo ${REPO}`)
        console.log(`- workflow URL: ${WORKFLOW_URL}`)
        return
      }

      const child = Bun.spawn(['gh', 'workflow', 'run', WORKFLOW_NAME, '--repo', REPO], {
        stdout: 'inherit',
        stderr: 'inherit',
      })

      const exitCode = await child.exited
      if (exitCode !== 0) {
        throw new Error(`Failed to trigger "${WORKFLOW_NAME}" workflow (exit code ${exitCode})`)
      }

      console.log(`Workflow triggered: ${WORKFLOW_URL}`)
      console.log('Approve the vpn environment deployment in GitHub Actions to continue.')
    })
}
