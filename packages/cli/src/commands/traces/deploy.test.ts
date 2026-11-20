import type {DeployDeps} from './deploy'

import {describe, expect, it} from 'bun:test'

import {
  getLocalDeployEnv,
  resolveLocalDeployScriptPath,
  TRACES_LOCAL_DEPLOY_ENV,
  tracesDeployAction,
  validateRemotePreconditions,
} from './deploy'

const ROOT = '/work/infra'
const SCRIPT = `${ROOT}/apps/traces/src/deploy.ts`
const IMAGE = `ghcr.io/example/infra/traces-collector@sha256:${'a'.repeat(64)}`

interface Recorded {
  command: string[]
  env: Record<string, string> | undefined
}

function makeDeps(
  overrides: Partial<DeployDeps> = {},
  exitCode = 0,
): {deps: DeployDeps; spawned: Recorded[]; lines: string[]} {
  const spawned: Recorded[] = []
  const lines: string[] = []
  const deps: DeployDeps = {
    env: {PATH: '/usr/bin', HOME: '/home/op', SSH_AUTH_SOCK: '/tmp/agent.sock', TRACES_COLLECTOR_IMAGE: IMAGE},
    which: command => `/usr/bin/${command}`,
    spawn: (command, options) => {
      spawned.push({command, env: options.env})
      return {exited: Promise.resolve(exitCode)}
    },
    exists: path => path === SCRIPT,
    repoRoot: () => ROOT,
    log: line => {
      lines.push(line)
    },
    ...overrides,
  }
  return {deps, spawned, lines}
}

describe('the list of local deploy inputs', () => {
  it('is the exported secrets and variables of apps/traces/src/deploy.ts plus the collector image', async () => {
    const deploy: {
      TRACES_DEPLOY_SECRETS: readonly string[]
      TRACES_DEPLOY_VARS: readonly string[]
      TRACES_DEPLOY_BUILD_INPUTS: readonly string[]
    } = await import('../../../../../apps/traces/src/deploy')

    const local: string[] = [...TRACES_LOCAL_DEPLOY_ENV]

    expect(local.toSorted()).toEqual(
      [...deploy.TRACES_DEPLOY_SECRETS, ...deploy.TRACES_DEPLOY_VARS, ...deploy.TRACES_DEPLOY_BUILD_INPUTS].toSorted(),
    )
  })

  it('never carries a sender token, the snapshot token or the account-wide DigitalOcean token', () => {
    for (const name of TRACES_LOCAL_DEPLOY_ENV) {
      expect(name).not.toMatch(/SENDER|_TOKEN$|DIGITALOCEAN/)
    }
  })
})

describe('resolveLocalDeployScriptPath', () => {
  it('points at the deploy script under the repository root', () => {
    expect(resolveLocalDeployScriptPath(ROOT)).toBe(SCRIPT)
  })
})

describe('getLocalDeployEnv', () => {
  const base = {PATH: '/usr/bin', HOME: '/home/op', SSH_AUTH_SOCK: '/tmp/agent.sock', TRACES_COLLECTOR_IMAGE: IMAGE}

  it('forwards the process basics, the ssh agent and every deploy input that is set', () => {
    const env = getLocalDeployEnv({
      ...base,
      TRACES_HOST: 'traces.example.test',
      TRACES_DOMAIN: 'traces.example.test',
      TRACES_INGEST_OPEN: 'true',
    })

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/op',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      TRACES_HOST: 'traces.example.test',
      TRACES_DOMAIN: 'traces.example.test',
      TRACES_INGEST_OPEN: 'true',
      TRACES_COLLECTOR_IMAGE: IMAGE,
    })
  })

  it('does not forward a variable that is unset, so the script sees the same thing as a first deploy', () => {
    const env = getLocalDeployEnv(base)

    expect('TRACES_LANGFUSE_PUBLIC_KEY' in env).toBe(false)
    expect('TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY' in env).toBe(false)
  })

  it('forwards nothing outside the list: no snapshot token, no account token, no sender token', () => {
    const env = getLocalDeployEnv({
      ...base,
      TRACES_SNAPSHOT_DO_TOKEN: 'placeholder-snapshot',
      DIGITALOCEAN_ACCESS_TOKEN: 'placeholder-account',
      TRACES_SENDER_TOKEN: 'placeholder-sender',
      GH_TOKEN: 'placeholder-gh',
    })

    expect(Object.keys(env).toSorted()).toEqual(['HOME', 'PATH', 'SSH_AUTH_SOCK', 'TRACES_COLLECTOR_IMAGE'])
  })

  it('accepts TRACES_SSH_KEY instead of an ssh agent', () => {
    const env = getLocalDeployEnv({
      PATH: '/usr/bin',
      HOME: '/home/op',
      TRACES_SSH_KEY: 'placeholder-key',
      TRACES_COLLECTOR_IMAGE: IMAGE,
    })

    expect(env.TRACES_SSH_KEY).toBe('placeholder-key')
    expect('SSH_AUTH_SOCK' in env).toBe(false)
  })

  it.each([
    [{...base, PATH: undefined}, 'PATH is required'],
    [{...base, HOME: undefined}, 'HOME is required'],
    [{...base, SSH_AUTH_SOCK: undefined}, 'Local deploy needs an SSH context'],
    [{...base, TRACES_COLLECTOR_IMAGE: undefined}, 'TRACES_COLLECTOR_IMAGE is required'],
    [{...base, TRACES_COLLECTOR_IMAGE: ''}, 'TRACES_COLLECTOR_IMAGE is required'],
  ])('refuses an environment that cannot deploy (%#)', (source, message) => {
    expect(() => getLocalDeployEnv(source)).toThrow(message)
  })
})

describe('validateRemotePreconditions', () => {
  it('requires the gh CLI', () => {
    expect(() => validateRemotePreconditions(() => null)).toThrow('gh CLI is required')
    expect(() => validateRemotePreconditions(() => '/usr/bin/gh')).not.toThrow()
  })
})

describe('tracesDeployAction: remote (default)', () => {
  it('dispatches the Deploy Traces workflow with gh and says to approve the environment', async () => {
    const {deps, spawned, lines} = makeDeps()

    await tracesDeployAction({local: false, dryRun: false}, deps)

    expect(spawned).toEqual([
      {command: ['gh', 'workflow', 'run', 'Deploy Traces', '--repo', 'marcusrbrown/infra'], env: undefined},
    ])
    expect(lines.join('\n')).toContain('deploy-traces.yaml')
    expect(lines.join('\n')).toContain('Approve the traces environment')
  })

  it('does not run the local script', async () => {
    const {deps, spawned} = makeDeps()

    await tracesDeployAction({local: false, dryRun: false}, deps)

    expect(spawned.flatMap(call => call.command)).not.toContain(SCRIPT)
  })

  it('prints the planned dispatch and spawns nothing on a dry run', async () => {
    const {deps, spawned, lines} = makeDeps()

    await tracesDeployAction({local: false, dryRun: true}, deps)

    expect(spawned).toEqual([])
    expect(lines.join('\n')).toContain('Dry run: remote traces deploy')
    expect(lines.join('\n')).toContain('gh workflow run "Deploy Traces"')
  })

  it('fails before dispatching when gh is missing', async () => {
    const {deps, spawned} = makeDeps({which: () => null})

    await expect(tracesDeployAction({local: false, dryRun: false}, deps)).rejects.toThrow('gh CLI is required')
    expect(spawned).toEqual([])
  })

  it('fails when the dispatch exits non-zero', async () => {
    const {deps} = makeDeps({}, 1)

    await expect(tracesDeployAction({local: false, dryRun: false}, deps)).rejects.toThrow('Failed to trigger')
  })
})

describe('tracesDeployAction: --local', () => {
  it('runs the deploy script with bun and exactly the filtered environment', async () => {
    const {deps, spawned} = makeDeps({
      env: {
        PATH: '/usr/bin',
        HOME: '/home/op',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        TRACES_COLLECTOR_IMAGE: IMAGE,
        TRACES_HOST: 'traces.example.test',
        TRACES_SNAPSHOT_DO_TOKEN: 'placeholder-snapshot',
      },
    })

    await tracesDeployAction({local: true, dryRun: false}, deps)

    expect(spawned).toEqual([
      {
        command: ['bun', SCRIPT],
        env: {
          PATH: '/usr/bin',
          HOME: '/home/op',
          SSH_AUTH_SOCK: '/tmp/agent.sock',
          TRACES_COLLECTOR_IMAGE: IMAGE,
          TRACES_HOST: 'traces.example.test',
        },
      },
    ])
  })

  it('does not dispatch the workflow', async () => {
    const {deps, spawned} = makeDeps()

    await tracesDeployAction({local: true, dryRun: false}, deps)

    expect(spawned.flatMap(call => call.command)).not.toContain('gh')
  })

  it('prints names but never values on a dry run, and spawns nothing', async () => {
    const {deps, spawned, lines} = makeDeps({
      env: {
        PATH: '/usr/bin',
        HOME: '/home/op',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        TRACES_COLLECTOR_IMAGE: IMAGE,
        TRACES_POSTGRES_PASSWORD: 'placeholder-password-value',
      },
    })

    await tracesDeployAction({local: true, dryRun: true}, deps)

    const output = lines.join('\n')
    expect(spawned).toEqual([])
    expect(output).toContain(`- command: bun ${SCRIPT}`)
    expect(output).toContain('TRACES_POSTGRES_PASSWORD')
    expect(output).not.toContain('placeholder-password-value')
    expect(output).not.toContain(IMAGE)
  })

  it('fails when the deploy script is not where the repository says', async () => {
    const {deps, spawned} = makeDeps({exists: () => false})

    await expect(tracesDeployAction({local: true, dryRun: false}, deps)).rejects.toThrow(
      'Local deploy script not found',
    )
    expect(spawned).toEqual([])
  })

  it('fails before spawning when there is no SSH context', async () => {
    const {deps, spawned} = makeDeps({env: {PATH: '/usr/bin', HOME: '/home/op', TRACES_COLLECTOR_IMAGE: IMAGE}})

    await expect(tracesDeployAction({local: true, dryRun: false}, deps)).rejects.toThrow('SSH context')
    expect(spawned).toEqual([])
  })

  it('fails when the script exits non-zero', async () => {
    const {deps} = makeDeps({}, 3)

    await expect(tracesDeployAction({local: true, dryRun: false}, deps)).rejects.toThrow('exit code 3')
  })
})
