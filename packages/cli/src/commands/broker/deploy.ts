import type {goke} from 'goke'

import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'
import {findRepoRoot} from '../../lib/repo-root'

const REPO = 'marcusrbrown/infra'
const WORKFLOW_NAME = 'Deploy Broker'
const WORKFLOW_URL = 'https://github.com/marcusrbrown/infra/actions/workflows/deploy-broker.yaml'

type CliInstance = ReturnType<typeof goke>

export function resolveLocalDeployScriptPath(): string {
  return join(findRepoRoot(), 'apps', 'broker', 'src', 'deploy.ts')
}

export function getLocalDeployEnv(): Record<string, string> {
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
    BROKER_DOMAIN: process.env.BROKER_DOMAIN ?? '',
    BROKER_HOST: process.env.BROKER_HOST ?? '',
    CLIPROXY_MANAGEMENT_KEY: process.env.CLIPROXY_MANAGEMENT_KEY ?? '',
    BROKER_AUD: process.env.BROKER_AUD ?? '',
  }
}

export function validateLocalPreconditions(): {deployScriptPath: string} {
  const deployScriptPath = resolveLocalDeployScriptPath()
  if (!existsSync(deployScriptPath)) {
    throw new Error(`Local deploy script not found at expected path: ${deployScriptPath}`)
  }

  getLocalDeployEnv()

  return {deployScriptPath}
}

export function validateRemotePreconditions(): void {
  if (!Bun.which('gh')) {
    throw new Error('gh CLI is required for remote deploy. Install gh and run `gh auth login`.')
  }
}

export function registerBrokerDeploy(cli: CliInstance): void {
  cli
    .command(
      'broker deploy',
      'Deploy the credential broker. Default mode triggers the GitHub Deploy Broker workflow, while --local runs apps/broker/src/deploy.ts directly with Bun.',
    )
    .option(
      '--local',
      z
        .boolean()
        .default(false)
        .describe(
          'Run local deployment with Bun using apps/broker/src/deploy.ts instead of triggering GitHub Actions.',
        ),
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
    .example('infra broker deploy')
    .example('# Validate local deploy preconditions and planned command')
    .example('infra broker deploy --local --dry-run')
    .example('# Run local deploy with explicit SSH agent context')
    .example('infra broker deploy --local')
    .action(async options => {
      if (options.local) {
        const {deployScriptPath} = validateLocalPreconditions()
        const env = getLocalDeployEnv()
        const command = ['bun', deployScriptPath]

        if (options.dryRun) {
          console.log('Dry run: local broker deploy')
          console.log(`- deploy script: ${deployScriptPath}`)
          console.log(`- command: ${command.join(' ')}`)
          console.log(`- BROKER_DOMAIN=${env.BROKER_DOMAIN || '(unset)'}`)
          return
        }

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

      validateRemotePreconditions()

      if (options.dryRun) {
        console.log('Dry run: remote broker deploy')
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
      console.log('Approve the broker environment deployment in GitHub Actions to continue.')
    })
}
