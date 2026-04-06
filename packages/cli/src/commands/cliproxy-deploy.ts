import type {goke} from 'goke'

import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
import {z} from 'zod'

const REPO = 'marcusrbrown/infra'
const WORKFLOW_NAME = 'Deploy'
const WORKFLOW_URL = 'https://github.com/marcusrbrown/infra/actions/workflows/deploy.yaml'

type CliInstance = ReturnType<typeof goke>

export function resolveLocalDeployScriptPath(): string {
  const primary = resolve(import.meta.dir, '../../../../apps/cliproxy/src/deploy.ts')
  if (existsSync(primary)) {
    return primary
  }

  return resolve(import.meta.dir, '../../../apps/cliproxy/src/deploy.ts')
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
    CLIPROXY_DOMAIN: process.env.CLIPROXY_DOMAIN ?? '',
    CLIPROXY_MANAGEMENT_KEY: process.env.CLIPROXY_MANAGEMENT_KEY ?? '',
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

export function registerCliproxyDeploy(cli: CliInstance): void {
  cli
    .command(
      'cliproxy deploy',
      'Deploy CLIProxyAPI. Default mode triggers the GitHub Deploy workflow, while --local runs apps/cliproxy/src/deploy.ts directly with Bun.',
    )
    .option(
      '--local',
      z
        .boolean()
        .default(false)
        .describe(
          'Run local deployment with Bun using apps/cliproxy/src/deploy.ts instead of triggering GitHub Actions.',
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
    .example('infra cliproxy deploy')
    .example('# Validate local deploy preconditions and planned command')
    .example('infra cliproxy deploy --local --dry-run')
    .example('# Run local deploy with explicit SSH agent context')
    .example('infra cliproxy deploy --local')
    .action(async options => {
      if (options.local) {
        const {deployScriptPath} = validateLocalPreconditions()
        const env = getLocalDeployEnv()
        const command = ['bun', deployScriptPath]

        if (options.dryRun) {
          console.log('Dry run: local CLIProxyAPI deploy')
          console.log(`- deploy script: ${deployScriptPath}`)
          console.log(`- command: ${command.join(' ')}`)
          console.log(`- CLIPROXY_DOMAIN=${env.CLIPROXY_DOMAIN || '(unset)'}`)
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
        console.log('Dry run: remote CLIProxyAPI deploy')
        console.log(`- command: gh workflow run ${WORKFLOW_NAME} --repo ${REPO}`)
        console.log(`- workflow URL: ${WORKFLOW_URL}`)
        return
      }

      const child = Bun.spawn(['gh', 'workflow', 'run', WORKFLOW_NAME, '--repo', REPO], {
        stdout: 'inherit',
        stderr: 'inherit',
      })

      const exitCode = await child.exited
      if (exitCode !== 0) {
        throw new Error(`Failed to trigger ${WORKFLOW_NAME} workflow (exit code ${exitCode})`)
      }

      console.log(`Workflow triggered: ${WORKFLOW_URL}`)
      console.log('Approve the production environment deployment in GitHub Actions to continue.')
    })
}
