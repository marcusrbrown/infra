import type {goke} from 'goke'

import {z} from 'zod'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const REPO = 'marcusrbrown/infra'
const WORKFLOW_NAME = 'Deploy Gateway'
const WORKFLOW_URL = 'https://github.com/marcusrbrown/infra/actions/workflows/deploy-gateway.yaml'

type CliInstance = ReturnType<typeof goke>

// ─── Env helpers ─────────────────────────────────────────────────────────────

export function getGatewayDeployEnv(): Record<string, string> {
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
    GATEWAY_HOST: process.env.GATEWAY_HOST ?? '',
  }
}

export function validateGatewayRemotePreconditions(): void {
  if (!Bun.which('gh')) {
    throw new Error('gh CLI is required for remote deploy. Install gh and run `gh auth login`.')
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerGatewayDeploy(cli: CliInstance): void {
  cli
    .command(
      'gateway deploy',
      'Deploy the gateway. Default mode triggers the GitHub Deploy Gateway workflow, while --local runs apps/gateway deploy directly with Bun.',
    )
    .option(
      '--local',
      z
        .boolean()
        .default(false)
        .describe('Run local deployment with Bun using apps/gateway instead of triggering GitHub Actions.'),
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
      '--force-recreate',
      z.boolean().default(false).describe('Force recreate containers. Forwarded only in local mode.'),
    )
    .example('# Trigger remote GitHub Actions deploy (default mode)')
    .example('infra gateway deploy')
    .example('# Validate local deploy preconditions and planned command')
    .example('infra gateway deploy --local --dry-run')
    .example('# Run local deploy with explicit SSH agent context')
    .example('infra gateway deploy --local')
    .action(async options => {
      if (options.local) {
        const command = [
          'bun',
          'run',
          '--cwd',
          'apps/gateway',
          'deploy',
          ...(options.forceRecreate ? ['--force-recreate'] : []),
        ]

        if (options.dryRun) {
          console.log('Dry run: local gateway deploy')
          console.log(`- command: ${command.join(' ')}`)
          return
        }

        const env = getGatewayDeployEnv()

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

      validateGatewayRemotePreconditions()

      if (options.dryRun) {
        console.log('Dry run: remote gateway deploy')
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
      console.log('Approve the gateway environment deployment in GitHub Actions to continue.')
    })
}
