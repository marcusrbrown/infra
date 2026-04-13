import type {goke} from 'goke'
import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
import {z} from 'zod'

const REPO = 'marcusrbrown/infra'
const WORKFLOW_NAME = 'Deploy'
const WORKFLOW_URL = 'https://github.com/marcusrbrown/infra/actions/workflows/deploy.yaml'

const DEFAULT_HOST = 'box.heatvision.co'
const DEFAULT_REMOTE_USER = 'deploy-kw'
const DEFAULT_SITE_DIR = '/home/user-data/www/kw.igg.ms'

type CliInstance = ReturnType<typeof goke>

export function resolveDeployScriptPath(): string {
  const primary = resolve(import.meta.dir, '../../../../../apps/keeweb/deploy.sh')

  if (existsSync(primary)) {
    return primary
  }

  return resolve(import.meta.dir, '../../../../apps/keeweb/deploy.sh')
}

export function resolveDistIndexPath(): string {
  return resolve(import.meta.dir, '../../../../../apps/keeweb/dist/index.html')
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
    HOST: process.env.HOST ?? DEFAULT_HOST,
    REMOTE_USER: process.env.REMOTE_USER ?? DEFAULT_REMOTE_USER,
    SITE_DIR: process.env.SITE_DIR ?? DEFAULT_SITE_DIR,
    SSH_AUTH_SOCK: sshAuthSock,
    PATH: path,
    HOME: home,
  }
}

export function validateLocalPreconditions(options: {nginx?: boolean}): {
  deployScriptPath: string
  distIndexPath: string
} {
  const deployScriptPath = resolveDeployScriptPath()
  if (!existsSync(deployScriptPath)) {
    throw new Error(`deploy.sh not found at expected path: ${deployScriptPath}`)
  }

  const distIndexPath = resolveDistIndexPath()
  if (!existsSync(distIndexPath)) {
    throw new Error(`Local deploy requires built assets. Missing: ${distIndexPath}`)
  }

  getLocalDeployEnv()

  if (options.nginx) {
    // no-op placeholder to keep validation branch explicit
  }

  return {deployScriptPath, distIndexPath}
}

export function validateRemotePreconditions(): void {
  if (!Bun.which('gh')) {
    throw new Error('gh CLI is required for remote deploy. Install gh and run `gh auth login`.')
  }
}

export function registerKeewebDeploy(cli: CliInstance): void {
  cli
    .command(
      'keeweb deploy',
      'Trigger KeeWeb deployment. Default mode dispatches the GitHub Deploy workflow. Use --local to run apps/keeweb/deploy.sh directly from this repo.',
    )
    .option(
      '--local',
      z
        .boolean()
        .default(false)
        .describe('Run local deployment using apps/keeweb/deploy.sh instead of triggering GitHub Actions.'),
    )
    .option(
      '--nginx',
      z
        .boolean()
        .default(false)
        .describe(
          'Include nginx config deployment. Valid only with --local and passed through to deploy.sh as --nginx.',
        ),
    )
    .option(
      '--dry-run',
      z
        .boolean()
        .default(false)
        .describe(
          'Print planned actions without validating preconditions, executing deploy.sh, or triggering GitHub Actions.',
        ),
    )
    .example('# Trigger GitHub Deploy workflow (default mode)')
    .example('infra keeweb deploy')
    .example('# Preview local deploy plan without side effects')
    .example('infra keeweb deploy --local --dry-run')
    .example('# Run local deploy including nginx config update')
    .example('infra keeweb deploy --local --nginx')
    .action(async options => {
      if (options.nginx && !options.local) {
        throw new Error('--nginx is only valid with --local')
      }

      if (options.local) {
        if (options.dryRun) {
          const deployScriptPath = resolveDeployScriptPath()
          const args = ['bash', deployScriptPath]
          if (options.nginx) {
            args.push('--nginx')
          }
          console.log('Dry run: local KeeWeb deploy')
          console.log(`- deploy script: ${deployScriptPath}`)
          console.log(`- dist check: ${resolveDistIndexPath()}`)
          console.log(`- command: ${args.join(' ')}`)
          return
        }

        const {deployScriptPath} = validateLocalPreconditions({nginx: options.nginx})
        const env = getLocalDeployEnv()
        const args = ['bash', deployScriptPath]

        if (options.nginx) {
          args.push('--nginx')
        }

        const child = Bun.spawn(args, {
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

      if (options.dryRun) {
        console.log('Dry run: remote KeeWeb deploy')
        console.log(`- command: gh workflow run ${WORKFLOW_NAME} --repo ${REPO}`)
        console.log(`- workflow URL: ${WORKFLOW_URL}`)
        return
      }

      validateRemotePreconditions()

      console.warn('Warning: the Deploy workflow includes nginx config deployment as part of workflow_dispatch logic.')
      console.warn('Warning: the workflow requires keeweb environment approval before jobs execute.')

      const child = Bun.spawn(['gh', 'workflow', 'run', WORKFLOW_NAME, '--repo', REPO], {
        stdout: 'inherit',
        stderr: 'inherit',
      })

      const exitCode = await child.exited
      if (exitCode !== 0) {
        throw new Error(`Failed to trigger Deploy workflow (exit code ${exitCode})`)
      }

      console.log(`Workflow triggered: ${WORKFLOW_URL}`)
      console.log('Approve the keeweb environment deployment in GitHub Actions to continue.')
    })
}
