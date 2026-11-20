import type {goke} from 'goke'

import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'
import {findRepoRoot} from '../../lib/repo-root'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const REPO = 'marcusrbrown/infra'
const WORKFLOW_NAME = 'Deploy Traces'
const WORKFLOW_URL = 'https://github.com/marcusrbrown/infra/actions/workflows/deploy-traces.yaml'

/**
 * The names a local deploy forwards to `apps/traces/src/deploy.ts`: the `traces` Environment secrets and variables, plus
 * the collector image. This is the CLI-side copy of the lists `apps/traces/src/deploy.ts` exports as
 * `TRACES_DEPLOY_SECRETS` and `TRACES_DEPLOY_VARS` (`packages/` never imports `apps/`); `deploy.test.ts` pins the two
 * together. Deliberately absent: any sender token, `TRACES_SNAPSHOT_DO_TOKEN` and `DIGITALOCEAN_ACCESS_TOKEN`.
 */
export const TRACES_LOCAL_DEPLOY_ENV = [
  'TRACES_SSH_KEY',
  'TRACES_HOST',
  'TRACES_POSTGRES_PASSWORD',
  'TRACES_CLICKHOUSE_PASSWORD',
  'TRACES_CLICKHOUSE_READER_PASSWORD',
  'TRACES_REDIS_PASSWORD',
  'TRACES_MINIO_PASSWORD',
  'TRACES_NEXTAUTH_SECRET',
  'TRACES_SALT',
  'TRACES_ENCRYPTION_KEY',
  'TRACES_GRAFANA_ADMIN_PASSWORD',
  'TRACES_GRAFANA_SECRET_KEY',
  'TRACES_LANGFUSE_USER_EMAIL',
  'TRACES_LANGFUSE_USER_PASSWORD',
  'TRACES_LANGFUSE_PUBLIC_KEY',
  'TRACES_LANGFUSE_SECRET_KEY',
  'TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY',
  'TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY',
  'TRACES_DOMAIN',
  'TRACES_INGEST_OPEN',
  'TRACES_COLLECTOR_IMAGE',
] as const

export interface SpawnedDeploy {
  exited: Promise<number>
}

export interface DeployDeps {
  env: Record<string, string | undefined>
  which: (command: string) => string | null
  spawn: (command: string[], options: {env?: Record<string, string>}) => SpawnedDeploy
  exists: (path: string) => boolean
  repoRoot: () => string
  log: (line: string) => void
}

export interface DeployOptions {
  local: boolean
  dryRun: boolean
}

export function defaultDeployDeps(): DeployDeps {
  return {
    env: process.env,
    which: command => Bun.which(command),
    spawn: (command, options) =>
      Bun.spawn(command, {
        ...(options.env === undefined ? {} : {env: options.env}),
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    exists: existsSync,
    repoRoot: () => findRepoRoot(),
    log: line => {
      console.log(line)
    },
  }
}

export function resolveLocalDeployScriptPath(repoRoot: string): string {
  return join(repoRoot, 'apps', 'traces', 'src', 'deploy.ts')
}

/**
 * The environment a local deploy runs with: the process basics, an SSH context, and every deploy input that is set.
 * Nothing else crosses: no sender token, no snapshot token, no account-wide DigitalOcean token.
 */
export function getLocalDeployEnv(source: Record<string, string | undefined>): Record<string, string> {
  const path = source.PATH
  const home = source.HOME
  const sshAuthSock = source.SSH_AUTH_SOCK
  const sshKey = source.TRACES_SSH_KEY

  if (!path) {
    throw new Error('PATH is required for local deploy')
  }

  if (!home) {
    throw new Error('HOME is required for local deploy')
  }

  if (!sshAuthSock && !sshKey) {
    throw new Error(
      'Local deploy needs an SSH context: set SSH_AUTH_SOCK (ssh-agent) or TRACES_SSH_KEY (key from env).',
    )
  }

  if (!source.TRACES_COLLECTOR_IMAGE) {
    throw new Error(
      'TRACES_COLLECTOR_IMAGE is required for local deploy. Build and push the collector image to GHCR first, then set it to ghcr.io/<owner>/<repo>/traces-collector@sha256:<digest>.',
    )
  }

  const forwarded: Record<string, string> = {}
  for (const name of TRACES_LOCAL_DEPLOY_ENV) {
    const value = source[name]
    if (value !== undefined) forwarded[name] = value
  }

  return {
    PATH: path,
    HOME: home,
    ...(sshAuthSock ? {SSH_AUTH_SOCK: sshAuthSock} : {}),
    ...forwarded,
  }
}

export function validateRemotePreconditions(which: DeployDeps['which']): void {
  if (!which('gh')) {
    throw new Error('gh CLI is required for remote deploy. Install gh and run `gh auth login`.')
  }
}

/** Remote (default): dispatch the workflow. Local: run the deploy script with the operator's own SSH context. */
export async function tracesDeployAction(options: DeployOptions, deps: DeployDeps): Promise<void> {
  if (options.local) {
    const deployScriptPath = resolveLocalDeployScriptPath(deps.repoRoot())
    if (!deps.exists(deployScriptPath)) {
      throw new Error(`Local deploy script not found at expected path: ${deployScriptPath}`)
    }

    const env = getLocalDeployEnv(deps.env)
    const command = ['bun', deployScriptPath]

    if (options.dryRun) {
      deps.log('Dry run: local traces deploy')
      deps.log(`- deploy script: ${deployScriptPath}`)
      deps.log(`- command: ${command.join(' ')}`)
      // Names only: a value is never printed.
      deps.log(`- inputs set: ${TRACES_LOCAL_DEPLOY_ENV.filter(name => name in env).join(', ')}`)
      return
    }

    const exitCode = await deps.spawn(command, {env}).exited
    if (exitCode !== 0) {
      throw new Error(`Local deploy failed with exit code ${exitCode}`)
    }

    return
  }

  validateRemotePreconditions(deps.which)

  if (options.dryRun) {
    deps.log('Dry run: remote traces deploy')
    deps.log(`- command: gh workflow run "${WORKFLOW_NAME}" --repo ${REPO}`)
    deps.log(`- workflow URL: ${WORKFLOW_URL}`)
    return
  }

  const exitCode = await deps.spawn(['gh', 'workflow', 'run', WORKFLOW_NAME, '--repo', REPO], {}).exited
  if (exitCode !== 0) {
    throw new Error(`Failed to trigger "${WORKFLOW_NAME}" workflow (exit code ${exitCode})`)
  }

  deps.log(`Workflow triggered: ${WORKFLOW_URL}`)
  deps.log('Approve the traces environment deployment in GitHub Actions to continue.')
}

export function registerTracesDeploy(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'traces deploy',
      'Deploy the trace collection stack. Default mode triggers the GitHub Deploy Traces workflow, while --local runs apps/traces/src/deploy.ts directly with Bun.',
    )
    .option(
      '--local',
      z
        .boolean()
        .default(false)
        .describe(
          'Run local deployment with Bun using apps/traces/src/deploy.ts instead of triggering GitHub Actions.',
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
    .example('infra traces deploy')
    .example('# Validate local deploy preconditions and planned command')
    .example('infra traces deploy --local --dry-run')
    .example('# Run local deploy with the SSH agent and deploy inputs in the environment')
    .example('infra traces deploy --local')
    .action(async options => {
      try {
        await tracesDeployAction({local: options.local, dryRun: options.dryRun}, defaultDeployDeps())
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })
}
