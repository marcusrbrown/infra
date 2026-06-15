import type {goke} from 'goke'

import {z} from 'zod'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const REPO = 'marcusrbrown/infra'
const WORKFLOW_NAME = 'Deploy Dashboard'
const WORKFLOW_URL = 'https://github.com/marcusrbrown/infra/actions/workflows/deploy-dashboard.yaml'

type CliInstance = ReturnType<typeof goke>

// ─── Env helpers ─────────────────────────────────────────────────────────────

export function getDashboardDeployEnv(): Record<string, string> {
  const path = process.env.PATH
  const home = process.env.HOME
  const sshAuthSock = process.env.SSH_AUTH_SOCK
  const sshKey = process.env.DASHBOARD_SSH_KEY

  if (!path) {
    throw new Error('PATH is required for local deploy')
  }

  if (!home) {
    throw new Error('HOME is required for local deploy')
  }

  if (!sshAuthSock && !sshKey) {
    throw new Error(
      'Local deploy needs an SSH context: set SSH_AUTH_SOCK (ssh-agent) or DASHBOARD_SSH_KEY (key from env).',
    )
  }

  return {
    PATH: path,
    HOME: home,
    ...(sshAuthSock ? {SSH_AUTH_SOCK: sshAuthSock} : {}),
    DASHBOARD_DOMAIN: process.env.DASHBOARD_DOMAIN ?? '',
    ...(sshKey ? {DASHBOARD_SSH_KEY: sshKey} : {}),
  }
}

export function validateDashboardRemotePreconditions(): void {
  if (!Bun.which('gh')) {
    throw new Error('gh CLI is required for remote deploy. Install gh and run `gh auth login`.')
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerDashboardDeploy(cli: CliInstance): void {
  cli
    .command(
      'dashboard deploy',
      'Deploy the dashboard. Default mode triggers the GitHub Deploy Dashboard workflow, while --local runs apps/dashboard deploy directly with Bun.',
    )
    .option(
      '--local',
      z
        .boolean()
        .default(false)
        .describe('Run local deployment with Bun using apps/dashboard instead of triggering GitHub Actions.'),
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
    .example('# Trigger remote GitHub Actions deploy (default mode)')
    .example('infra dashboard deploy')
    .example('# Validate local deploy preconditions and planned command')
    .example('infra dashboard deploy --local --dry-run')
    .example('# Run local deploy with explicit SSH agent context')
    .example('infra dashboard deploy --local')
    .action(async options => {
      if (options.local) {
        const command = ['bun', 'run', '--cwd', 'apps/dashboard', 'deploy']

        if (options.dryRun) {
          console.log('Dry run: local dashboard deploy')
          console.log(`- command: ${command.join(' ')}`)
          return
        }

        const env = getDashboardDeployEnv()

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

      validateDashboardRemotePreconditions()

      if (options.dryRun) {
        console.log('Dry run: remote dashboard deploy')
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
      console.log('Approve the dashboard environment deployment in GitHub Actions to continue.')
    })
}
