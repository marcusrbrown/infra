import type {goke} from 'goke'

import {z} from 'zod'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const REPO = 'marcusrbrown/infra'
const WORKFLOW_NAME = 'Deploy Dashboard'
const WORKFLOW_URL = 'https://github.com/marcusrbrown/infra/actions/workflows/deploy-dashboard.yaml'

// Mirrors the workflow's validate-inputs step regexes exactly.
const CALVER_RE = /^\d{4}\.\d{2}\.\d+$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

type CliInstance = ReturnType<typeof goke>

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateReleaseFlags(options: {imageVersion?: string; digest?: string; local: boolean}): void {
  const {imageVersion, digest, local} = options

  if (local && (imageVersion !== undefined || digest !== undefined)) {
    throw new Error(
      '--image-version and --digest are remote-only flags and cannot be used with --local. ' +
        'Remove --local to dispatch the GitHub Actions workflow with release flags.',
    )
  }

  if (imageVersion !== undefined && !CALVER_RE.test(imageVersion)) {
    throw new Error(
      `Invalid version ${JSON.stringify(imageVersion)}: must match YYYY.MM.N (e.g. 2026.06.47). ` +
        "Rejected: 'latest', semver, and injection strings are not accepted.",
    )
  }

  if (digest !== undefined && imageVersion === undefined) {
    throw new Error(
      '--digest requires --image-version. Either omit all release flags (no-version fallback) or provide --image-version (+ optional --digest).',
    )
  }

  if (digest !== undefined && !DIGEST_RE.test(digest)) {
    throw new Error(
      `Invalid digest ${JSON.stringify(digest)}: must match sha256:<64 hex chars> (e.g. sha256:abc...def). ` +
        'Rejected: malformed digests are not accepted.',
    )
  }
}

// ─── Remote argv builder ──────────────────────────────────────────────────────

function buildRemoteArgv(options: {imageVersion?: string; digest?: string}): string[] {
  const argv = ['gh', 'workflow', 'run', WORKFLOW_NAME, '--repo', REPO]
  if (options.imageVersion !== undefined) {
    argv.push('-f', `version=${options.imageVersion}`)
  }
  if (options.digest !== undefined) {
    argv.push('-f', `digest=${options.digest}`)
  }
  return argv
}

function formatArgv(argv: string[]): string {
  return argv.map(arg => (/^[\w./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ')
}

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

  // Spread all of process.env so DASHBOARD_* vars (GITHUB_APP_ID, OAUTH_CLIENT_ID, etc.)
  // are forwarded to the spawned deploy.ts process. validateEnv in deploy.ts requires
  // all DASHBOARD_* credential vars to be present — a selective subset would cause it to fail.
  // Filter out undefined values (Record<string, string> does not allow undefined).
  const fullEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      fullEnv[k] = v
    }
  }
  return fullEnv
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
    .option(
      '--image-version <version>',
      z
        .string()
        .optional()
        .describe(
          'CalVer version to deploy (e.g. 2026.06.47). Remote-only. Triggers the versioned release path and requires dashboard environment approval. Must match YYYY.MM.N. Forwarded as -f version=<value> to gh workflow run.',
        ),
    )
    .option(
      '--digest <digest>',
      z
        .string()
        .optional()
        .describe(
          'Expected sha256 digest (e.g. sha256:abc...def). Remote-only. Requires --image-version. When set, the workflow fails if GHCR resolves the tag to a different digest. Must match sha256:<64 hex chars>.',
        ),
    )
    .example('# Trigger remote GitHub Actions deploy (default mode)')
    .example('infra dashboard deploy')
    .example('# Deploy a specific CalVer release via GitHub Actions')
    .example('infra dashboard deploy --image-version 2026.06.47')
    .example('# Deploy a specific release with digest cross-check')
    .example('infra dashboard deploy --image-version 2026.06.47 --digest sha256:<64 hex>')
    .example('# Validate local deploy preconditions and planned command')
    .example('infra dashboard deploy --local --dry-run')
    .example('# Run local deploy with explicit SSH agent context')
    .example('infra dashboard deploy --local')
    .action(async options => {
      validateReleaseFlags({imageVersion: options.imageVersion, digest: options.digest, local: options.local})

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

      const remoteArgv = buildRemoteArgv({imageVersion: options.imageVersion, digest: options.digest})

      if (options.dryRun) {
        console.log('Dry run: remote dashboard deploy')
        console.log(`- command: ${formatArgv(remoteArgv)}`)
        console.log(`- workflow URL: ${WORKFLOW_URL}`)
        return
      }

      const child = Bun.spawn(remoteArgv, {
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
