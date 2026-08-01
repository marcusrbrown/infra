import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {
  buildRemoteSshCommand,
  decodeRemotePayload,
  encodeRemotePayload,
  REMOTE_PAYLOAD_FIELD_LIMITS,
  REMOTE_TRANSACTION_PROGRAM,
  runRemoteTransaction,
  type RemoteDeployPayload,
} from './remote-deploy'

const fixture: RemoteDeployPayload = {
  env: 'DASHBOARD_DOMAIN=dashboard.example\n',
  compose: `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard@sha256:${'a'.repeat(64)}\n`,
  caddyfile: 'dashboard.example {\n  reverse_proxy dashboard:3000\n}\n',
  githubAppKey: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
  expectedDashboardDigest: `sha256:${'a'.repeat(64)}`,
}

const localEnv = {
  PATH: '/custom/bin:/usr/bin',
  HOME: '/Users/operator',
  SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
  DASHBOARD_DOMAIN: 'dashboard.example',
}

const requiredWireFields = (): readonly [string, string][] => [
  ['env', fixture.env],
  ['compose', fixture.compose],
  ['caddyfile', fixture.caddyfile],
  ['github_app_key', fixture.githubAppKey],
  ['expected_dashboard_digest', fixture.expectedDashboardDigest],
]

const makeFramedPayload = (fields: readonly [string, string][], version = 2, trailing = ''): Uint8Array => {
  const encoder = new TextEncoder()
  const body = fields.map(([name, value]) => `field ${name} ${encoder.encode(value).byteLength}\n${value}`).join('')
  return encoder.encode(`dashboard-deploy-payload v${version}\n${body}end\n${trailing}`)
}

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

const runShellProgram = async (program: string, payload: Uint8Array) => {
  const process = Bun.spawn(['bash', '-c', program], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'})
  process.stdin.write(payload)
  process.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return {stdout, stderr, exitCode}
}

interface ShellHarnessOptions {
  dockerRoot?: string
  dockerInfoOutput?: string
  containerdRoot?: string
  mounts?: readonly {path: string; target: string; source: string; fstype: string; freeBytes: number}[]
  dockerDf?: readonly string[]
  containerImages?: readonly string[]
  runningDashboardIds?: readonly string[]
  runningDashboardContainers?: readonly {id: string; project: string; service: string}[]
  runningDashboardImageDigest?: string
  runningDashboardHealth?: string
  pruneOutput?: string
  pruneExitCode?: number
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`

const adaptProgramForUnprivilegedHarness = (
  runtimeRoot: string,
  dashboardRoot = `${runtimeRoot}-dashboard`,
  options: ShellHarnessOptions = {},
): string => {
  const uid = process.getuid?.() ?? 501
  const gid = process.getgid?.() ?? 20
  const dockerRoot = options.dockerRoot ?? `${runtimeRoot}-docker`
  const dockerInfoOutput = options.dockerInfoOutput ?? dockerRoot
  const containerdRoot = options.containerdRoot ?? `${runtimeRoot}-containerd-absent`
  mkdirSync(dockerRoot, {recursive: true})
  if (options.containerdRoot) mkdirSync(options.containerdRoot, {recursive: true})
  const mounts = options.mounts ?? [
    {path: dockerRoot, target: '/', source: '/dev/test-root', fstype: 'ext4', freeBytes: 8 * 1024 * 1024 * 1024},
  ]
  const dockerDf = options.dockerDf ?? ['Images|2|1|1GB|0B', 'Containers|1|1|100MB|0B', 'Local Volumes|0|0|0B|0B']
  const containerImages = options.containerImages ?? [`ghcr.io/fro-bot/dashboard@${fixture.expectedDashboardDigest}`]
  const runningDashboardIds =
    options.runningDashboardIds ?? (existsSync(join(dashboardRoot, 'docker-compose.yaml')) ? ['abcdef123456'] : [])
  const runningDashboardContainers =
    options.runningDashboardContainers ??
    runningDashboardIds.map(id => ({id, project: 'dashboard', service: 'dashboard'}))
  const runningDashboardImageDigest = options.runningDashboardImageDigest ?? fixture.expectedDashboardDigest
  const runningDashboardHealth = options.runningDashboardHealth ?? 'unknown'
  const pruneOutput = options.pruneOutput ?? 'Deleted Images:\nTotal reclaimed space: 0B\n'
  const newline = String.fromCharCode(10)
  const dockerDfScript = dockerDf.map(line => String.raw`printf '%s\n' ${shellQuote(line)}`).join(newline)
  const containerImagesScript = containerImages.map(line => String.raw`printf '%s\n' ${shellQuote(line)}`).join(newline)
  const runningDashboardServiceIdsScript = runningDashboardContainers
    .filter(container => container.service === 'dashboard')
    .map(container => String.raw`printf '%s\n' ${shellQuote(container.id)}`)
    .join(newline)
  const runningDashboardProjectIdsScript = runningDashboardContainers
    .filter(container => container.project === 'dashboard' && container.service === 'dashboard')
    .map(container => String.raw`printf '%s\n' ${shellQuote(container.id)}`)
    .join(newline)
  const pruneScript = String.raw`printf '%s\n' ${shellQuote(pruneOutput.replace(/\n$/, ''))}`
  const mountCaseScript = mounts
    .map(
      mount =>
        String.raw`if [ "$path" = ${shellQuote(mount.path)} ]; then printf '%s\n' ${shellQuote(`${mount.target} ${mount.source} ${mount.fstype}`)}; return 0; fi`,
    )
    .join(`${newline}  `)
  const statCaseScript = mounts
    .map(
      mount =>
        String.raw`if [ "$path" = ${shellQuote(mount.path)} ]; then printf '%s\n' ${shellQuote(`${mount.freeBytes}:1`)}; return 0; fi`,
    )
    .join(`${newline}    `)
  const program = REMOTE_TRANSACTION_PROGRAM.replaceAll(
    '"/run/dashboard-deploy/lock"',
    JSON.stringify(`${runtimeRoot}/lock`),
  )
    .replaceAll('"/run/dashboard-deploy"', JSON.stringify(runtimeRoot))
    .replaceAll('"/var/lib/containerd"', JSON.stringify(containerdRoot))
    .replaceAll('"/opt/dashboard"', JSON.stringify(dashboardRoot))
    .replaceAll('"/opt/dashboard/config"', JSON.stringify(`${dashboardRoot}/config`))
    .replaceAll('"/opt/dashboard/data"', JSON.stringify(`${dashboardRoot}/data`))
    .replaceAll('"/opt/dashboard/.env"', JSON.stringify(`${dashboardRoot}/.env`))
    .replaceAll('"/opt/dashboard/docker-compose.yaml"', JSON.stringify(`${dashboardRoot}/docker-compose.yaml`))
    .replaceAll('"/opt/dashboard/config/Caddyfile"', JSON.stringify(`${dashboardRoot}/config/Caddyfile`))
    .replaceAll('"/opt/dashboard/config/github-app.pem"', JSON.stringify(`${dashboardRoot}/config/github-app.pem`))
    .replaceAll(
      '"/opt/dashboard/docker-compose.override.yaml"',
      JSON.stringify(`${dashboardRoot}/docker-compose.override.yaml`),
    )
    .replaceAll('0:0:700:directory', `${uid}:${gid}:700:Directory`)
    .replaceAll('0:0:600:regular file', `${uid}:${gid}:600:Regular File`)
    .replaceAll('install -d -m 0700 -o 0 -g 0', `install -d -m 0700 -o ${uid} -g ${gid}`)
    .replaceAll('install -m 0600 -o 0 -g 0', `install -m 0600 -o ${uid} -g ${gid}`)
    .replaceAll('install -d -m 0755 -o 0 -g 0', `install -d -m 0755 -o ${uid} -g ${gid}`)
    .replaceAll('install -m 0644 -o 0 -g 0', `install -m 0644 -o ${uid} -g ${gid}`)
    .replaceAll('chown 0:0', `chown ${uid}:${gid}`)
    .replaceAll('chown -R 1000:1000', `chown -R ${uid}:${gid}`)
    .replaceAll('chown 1000:1000', `chown ${uid}:${gid}`)
    .replaceAll('realpath -e --', 'realpath --')
    .replaceAll('realpath -e ', 'realpath ')
  return String.raw`
stat() {
  if [ "$1" = "-f" ] && [ "$2" = "-c" ]; then
    format="$3"
    path="$5"
    case "$format" in
      "%a:%S")
        ${statCaseScript}
        ;;
      *) return 1 ;;
    esac
  elif [ "$1" = "-c" ]; then
    format="$2"
    shift 2
    [ "$1" = "--" ] && shift
    case "$format" in
      "%u:%g:%a:%F") /usr/bin/stat -f "%u:%g:%Lp:%HT" "$1" ;;
      "%s") /usr/bin/stat -f "%z" "$1" ;;
      *) return 1 ;;
    esac
  else
    command stat "$@"
  fi
}
findmnt() {
  path="$4"
  ${mountCaseScript}
  return 1
}
flock() { return 0; }
docker() {
  if [ "$1" = "info" ]; then printf '%s\n' ${shellQuote(dockerInfoOutput)}; return 0; fi
  if [ "$1" = "system" ] && [ "$2" = "df" ]; then
    ${dockerDfScript}
    return 0
  fi
  if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
    ${containerImagesScript}
    return 0
  fi
  if [ "$1" = "ps" ]; then
    if [[ "$*" == *"label=com.docker.compose.project=dashboard"* ]]; then
      :
      ${runningDashboardProjectIdsScript}
    else
      :
      ${runningDashboardServiceIdsScript}
    fi
    return 0
  fi
  if [ "$1" = "image" ] && [ "$2" = "prune" ]; then
    ${pruneScript}
    return ${options.pruneExitCode ?? 0}
  fi
  if [ "$1" = "compose" ] && [ "$2" = "pull" ]; then return 0; fi
  if [ "$1" = "compose" ] && [ "$2" = "up" ]; then return 0; fi
  if [ "$1" = "compose" ] && { [ "$2" = "ps" ] || [ "$4" = "ps" ]; }; then printf 'abcdef123456\n'; return 0; fi
  if [ "$1" = "inspect" ] && [ "$4" = "abcdef123456" ]; then
    case "$3" in
      "{{.Image}}") printf 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n' ;;
      "{{.State.Health.Status}}") printf '%s\n' ${shellQuote(runningDashboardHealth)} ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if [ "$1" = "inspect" ] && [ "$4" = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" ]; then
    printf '["ghcr.io/fro-bot/dashboard@${runningDashboardImageDigest}"]\n'
    return 0
  fi
  return 1
}
${program}`
}

describe('remote deploy payload protocol', () => {
  it('round-trips a valid data-only payload', () => {
    const encoded = encodeRemotePayload(fixture)

    expect(decodeRemotePayload(encoded)).toEqual(fixture)
  })

  it('keeps metacharacter payload values out of the fixed SSH command', () => {
    const secretFixture = {
      ...fixture,
      env: 'DASHBOARD_DOMAIN=dashboard.example\nOAUTH=$(touch /tmp/pwned); echo "quoted"\n',
      githubAppKey: '-----BEGIN PRIVATE KEY-----\nline\n-----END PRIVATE KEY-----\n',
    }
    const command = buildRemoteSshCommand({host: 'dashboard.example'})

    expect(command.join(' ')).not.toContain(secretFixture.env)
    expect(command.join(' ')).not.toContain(secretFixture.githubAppKey)
    expect(command.join(' ')).toContain('dashboard-deploy-payload v2')
    expect(command.join(' ')).toContain('DOCKER_CONTEXT=default')
    expect(command.join(' ')).toContain('DOCKER_HOST=unix:///var/run/docker.sock')
    expect(command.join(' ')).toContain('/usr/bin/env -i')
    expect(command.join(' ')).not.toContain('BASH_ENV=')
    expect(command.join(' ')).not.toContain('ENV=')
    expect(command.join(' ')).not.toContain('COMPOSE_FILE=')
    expect(command.join(' ')).not.toContain('COMPOSE_PROJECT_NAME=')
  })
})

describe('remote deploy payload negative cases', () => {
  const oversizedPayload: RemoteDeployPayload = {
    env: 'e'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.env),
    compose: 'c'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.compose),
    caddyfile: 'c'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.caddyfile),
    githubAppKey: 'k'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.github_app_key),
    expectedDashboardDigest: fixture.expectedDashboardDigest,
  }

  const cases: readonly [string, () => void][] = [
    ['unknown field', () => decodeRemotePayload(makeFramedPayload([['unknown', 'value'], ...requiredWireFields()]))],
    [
      'duplicate field',
      () =>
        decodeRemotePayload(
          makeFramedPayload([['env', fixture.env], ['env', fixture.env], ...requiredWireFields().slice(1)]),
        ),
    ],
    ['missing field', () => decodeRemotePayload(makeFramedPayload(requiredWireFields().slice(0, 3)))],
    ['trailing bytes', () => decodeRemotePayload(concatBytes(encodeRemotePayload(fixture), new Uint8Array([0x58])))],
    [
      'per-field oversized value',
      () => encodeRemotePayload({...fixture, env: 'x'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.env + 1)}),
    ],
    ['total-size overflow', () => encodeRemotePayload(oversizedPayload)],
    ['empty field', () => encodeRemotePayload({...fixture, env: ''})],
    ['NUL byte', () => encodeRemotePayload({...fixture, env: 'safe\0unsafe'})],
    ['unsupported version', () => decodeRemotePayload(makeFramedPayload(requiredWireFields(), 1))],
  ]

  for (const [name, action] of cases) {
    it(`rejects ${name}`, () => {
      expect(action).toThrow()
    })
  }
})

describe('remote transaction process boundary', () => {
  it('writes the framed payload only to stdin and closes it before success', async () => {
    const chunks: Uint8Array[] = []
    let closed = false
    let spawnEnv: Readonly<Record<string, string>> | undefined
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stage=complete\n'))
        controller.close()
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })

    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: (_command, options) => {
          spawnEnv = options.env
          return {
            stdout,
            stderr,
            stdin: {
              write: (data: Uint8Array) => {
                chunks.push(data)
              },
              end: () => {
                closed = true
              },
            },
            exited: Promise.resolve(0),
          }
        },
      }),
    ).resolves.toMatchObject({stage: 'complete'})

    expect(new TextDecoder().decode(chunks[0])).toBe(new TextDecoder().decode(encodeRemotePayload(fixture)))
    expect(closed).toBe(true)
    expect(spawnEnv).toBe(localEnv)
  })

  it('contains fixed runtime validation, lock, and cleanup structure', () => {
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('/run/dashboard-deploy')
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('/run/dashboard-deploy/lock')
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('flock')
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('mktemp')
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('trap')
  })

  it('creates an absent runtime root before opening the lock', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-root-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout.split('\n')[0]).toBe('stage=remote-transaction-started')
      expect(result.stdout).toContain('stage=complete')
      expect(statSync(runtimeRoot).isDirectory()).toBe(true)
      expect(statSync(runtimeRoot).mode & 0o777).toBe(0o700)
      expect(statSync(join(runtimeRoot, 'lock')).mode & 0o777).toBe(0o600)
      expect(readdirSync(runtimeRoot).filter(name => name.startsWith('attempt.'))).toEqual([])
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('audits, prunes, and proves the capacity floor before the first dashboard mutation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-gate-order-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot),
        encodeRemotePayload(fixture),
      )
      expect(result.exitCode).toBe(0)
      const lines = result.stdout.trim().split('\n')
      const baselineIndex = lines.indexOf('stage=baseline-evidence')
      const pruneIndex = lines.indexOf('stage=prune-complete')
      const floorIndex = lines.indexOf('stage=post-prune-capacity')
      const mutationIndex = lines.indexOf('stage=active-state-mutation')

      expect(baselineIndex).toBeGreaterThan(-1)
      expect(pruneIndex).toBeGreaterThan(baselineIndex)
      expect(floorIndex).toBeGreaterThan(pruneIndex)
      expect(mutationIndex).toBeGreaterThan(floorIndex)
      expect(result.stdout).toContain('evidence=capacity:post-prune:free-bytes=8589934592')
      expect(result.stdout).toContain('evidence=active-compose:baseline:absent')
      expect(result.stdout).toContain('evidence=running-dashboard:baseline:absent')
      expect(existsSync(dashboardRoot)).toBe(true)
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('deduplicates Docker and containerd probes that share one mount', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-shared-mount-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dockerRoot = join(root, 'docker')
    const containerdRoot = join(root, 'containerd')
    const sharedMount = {
      path: dockerRoot,
      target: '/',
      source: '/dev/test-root',
      fstype: 'ext4',
      freeBytes: 7 * 1024 ** 3,
    }
    mkdirSync(dockerRoot, {recursive: true})
    mkdirSync(containerdRoot, {recursive: true})

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
          dockerRoot,
          containerdRoot,
          mounts: [sharedMount, {...sharedMount, path: containerdRoot}],
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      const baselineStorage = result.stdout.split('\n').filter(line => line.startsWith('evidence=storage:baseline:'))
      const postPruneStorage = result.stdout.split('\n').filter(line => line.startsWith('evidence=storage:post-prune:'))
      expect(baselineStorage).toHaveLength(1)
      expect(postPruneStorage).toHaveLength(1)
      expect(baselineStorage[0]).toContain(`probe=${dockerRoot},${containerdRoot}`)
      expect(result.stdout).toContain('evidence=capacity:post-prune:free-bytes=7516192768')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('gates on the minimum free bytes across distinct Docker and containerd mounts', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-multi-mount-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dockerRoot = join(root, 'docker')
    const containerdRoot = join(root, 'containerd')
    mkdirSync(dockerRoot, {recursive: true})
    mkdirSync(containerdRoot, {recursive: true})

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
          dockerRoot,
          containerdRoot,
          mounts: [
            {path: dockerRoot, target: '/', source: '/dev/docker', fstype: 'ext4', freeBytes: 8 * 1024 ** 3},
            {
              path: containerdRoot,
              target: '/var/lib/containerd',
              source: '/dev/containerd',
              fstype: 'ext4',
              freeBytes: 7 * 1024 ** 3,
            },
          ],
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout.split('\n').filter(line => line.startsWith('evidence=storage:baseline:'))).toHaveLength(2)
      expect(result.stdout).toContain('evidence=capacity:post-prune:free-bytes=7516192768')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('keeps stopped-container image references in the protected inventory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-protected-images-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    const stoppedDigest = `sha256:${'b'.repeat(64)}`

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
          containerImages: [
            `ghcr.io/fro-bot/dashboard@${stoppedDigest}`,
            `ghcr.io/fro-bot/dashboard@${stoppedDigest}`,
            `ghcr.io/fro-bot/dashboard@${fixture.expectedDashboardDigest}`,
          ],
          pruneOutput: 'Deleted Images:\ndeleted: sha256:cccc\nTotal reclaimed space: 1GB\n',
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        `evidence=protected-image:baseline:ref=ghcr.io/fro-bot/dashboard@${stoppedDigest};count=2`,
      )
      expect(result.stdout).toContain(
        'evidence=prune:reclaimed-bytes=1000000000;eligible-images=1;protected-containers=3',
      )
      expect(result.stdout).toContain(
        `evidence=protected-image:post-prune:ref=ghcr.io/fro-bot/dashboard@${stoppedDigest};count=2`,
      )
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('hard-stops on prune failure even when baseline space is high', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-prune-error-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {pruneExitCode: 1}),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('stage=baseline-evidence')
      expect(result.stdout).toContain('stage=prune-started')
      expect(result.stdout).not.toContain('stage=prune-complete')
      expect(result.stdout).not.toContain('stage=post-prune-capacity')
      expect(result.stdout).not.toContain('stage=active-state-written')
      expect(existsSync(dashboardRoot)).toBe(false)
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('stops below the post-prune floor before creating dashboard paths', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-low-space-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          mounts: [
            {
              path: `${runtimeRoot}-docker`,
              target: '/',
              source: '/dev/test-root',
              fstype: 'ext4',
              freeBytes: 6442450943,
            },
          ],
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('stage=post-prune-capacity')
      expect(result.stdout).toContain('evidence=storage:post-prune:')
      expect(result.stdout).not.toContain('stage=active-state-written')
      expect(existsSync(dashboardRoot)).toBe(false)
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('accepts exactly the 6 GiB post-prune floor', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-floor-boundary-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
          mounts: [
            {
              path: `${runtimeRoot}-docker`,
              target: '/',
              source: '/dev/test-root',
              fstype: 'ext4',
              freeBytes: 6442450944,
            },
          ],
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('evidence=capacity:post-prune:free-bytes=6442450944')
      expect(result.stdout).toContain('stage=active-state-written')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('fails closed on missing, malformed, or contradictory storage evidence', async () => {
    const cases: readonly [string, (root: string, runtimeRoot: string) => ShellHarnessOptions][] = [
      ['missing Docker root', () => ({dockerInfoOutput: ''})],
      ['malformed Docker root', () => ({dockerInfoOutput: 'relative/docker-root'})],
      ['unresolved mount', () => ({mounts: []})],
      [
        'missing containerd mount evidence',
        (root, _runtimeRoot) => ({
          dockerRoot: join(root, 'docker'),
          containerdRoot: join(root, 'containerd'),
          mounts: [
            {
              path: join(root, 'docker'),
              target: '/',
              source: '/dev/test-root',
              fstype: 'ext4',
              freeBytes: 8 * 1024 ** 3,
            },
          ],
        }),
      ],
      [
        'malformed free bytes',
        (_root, runtimeRoot) => ({
          mounts: [
            {path: `${runtimeRoot}-docker`, target: '/', source: '/dev/test-root', fstype: 'ext4', freeBytes: -1},
          ],
        }),
      ],
      ['malformed Docker disk summary', (_root, _runtimeRoot) => ({dockerDf: ['Images|2|1|not-bytes|0B']})],
      [
        'contradictory shared mount identity',
        (root, _runtimeRoot) => ({
          dockerRoot: join(root, 'docker'),
          containerdRoot: join(root, 'containerd'),
          mounts: [
            {path: join(root, 'docker'), target: '/', source: '/dev/one', fstype: 'ext4', freeBytes: 8 * 1024 ** 3},
            {path: join(root, 'containerd'), target: '/', source: '/dev/two', fstype: 'ext4', freeBytes: 8 * 1024 ** 3},
          ],
        }),
      ],
    ]

    for (const [name, makeOptions] of cases) {
      const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-evidence-error-'))
      const root = realpathSync(parent)
      const runtimeRoot = join(root, 'dashboard-deploy')
      try {
        const result = await runShellProgram(
          adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, makeOptions(root, runtimeRoot)),
          encodeRemotePayload(fixture),
        )

        expect(result.exitCode, name).not.toBe(0)
        expect(result.stdout, name).not.toContain('stage=active-state-written')
        expect(existsSync(`${runtimeRoot}-dashboard`), name).toBe(false)
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
    }
  })

  it('records active Compose and running dashboard state when present', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-active-state-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(
      join(dashboardRoot, 'docker-compose.yaml'),
      `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`,
    )

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        `evidence=active-compose:baseline:ref=ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest};digest=${fixture.expectedDashboardDigest}`,
      )
      expect(result.stdout).toContain(
        `evidence=running-dashboard:baseline:digest=${fixture.expectedDashboardDigest};health=unknown`,
      )
      expect(result.stdout).toContain(
        `evidence=active-compose:post-prune:ref=ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest};digest=${fixture.expectedDashboardDigest}`,
      )
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('audits running dashboard independently when Compose is absent', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-runtime-without-compose-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
          runningDashboardIds: ['abcdef123456'],
          runningDashboardHealth: 'healthy',
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('evidence=active-compose:baseline:absent')
      expect(result.stdout).toContain(
        `evidence=running-dashboard:baseline:digest=${fixture.expectedDashboardDigest};health=healthy`,
      )
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('ignores a dashboard service from another Compose project', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-project-labels-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
          runningDashboardContainers: [
            {id: 'abcdef123456', project: 'dashboard', service: 'dashboard'},
            {id: 'abcdef654321', project: 'other', service: 'dashboard'},
          ],
          runningDashboardHealth: 'healthy',
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        `evidence=running-dashboard:baseline:digest=${fixture.expectedDashboardDigest};health=healthy`,
      )
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('reports no running dashboard when the fixed service label has no matches', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-no-running-dashboard-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {runningDashboardIds: []}),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('evidence=running-dashboard:baseline:absent')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('fails closed on multiple or malformed running dashboard matches', async () => {
    const cases = [
      ['multiple matches', {runningDashboardIds: ['abcdef123456', 'abcdef654321']}],
      ['malformed container identity', {runningDashboardIds: ['not-a-container-id']}],
      [
        'malformed image digest',
        {runningDashboardIds: ['abcdef123456'], runningDashboardImageDigest: 'sha256:not-a-digest'},
      ],
    ] as const

    for (const [name, options] of cases) {
      const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-ambiguous-runtime-'))
      const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
      const dashboardRoot = `${runtimeRoot}-dashboard`

      try {
        const result = await runShellProgram(
          adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, options),
          encodeRemotePayload(fixture),
        )

        expect(result.exitCode, name).not.toBe(0)
        expect(result.stdout, name).toContain('stage=baseline-evidence')
        expect(result.stdout, name).not.toContain('stage=prune-started')
        expect(existsSync(dashboardRoot), name).toBe(false)
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
    }
  })

  it('releases the process-bound lock after interruption without stale-lock cleanup', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-interrupted-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    const program = adaptProgramForUnprivilegedHarness(runtimeRoot)
    const interrupted = Bun.spawn(['bash', '-c', program], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'})

    try {
      interrupted.stdin.write(new TextEncoder().encode('dashboard-deploy-payload v2\n'))
      await Bun.sleep(10)
      interrupted.kill('SIGTERM')
      const interruptedExitCode = await interrupted.exited
      expect(interruptedExitCode).not.toBe(0)

      const retry = await runShellProgram(program, encodeRemotePayload(fixture))
      expect(retry.exitCode).toBe(0)
      expect(retry.stdout).toContain('stage=complete')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('stops at lock contention before payload decode or application mutation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-contention-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const program = adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot).replace(
      'flock() { return 0; }',
      'flock() { return 1; }',
    )

    try {
      const result = await runShellProgram(program, encodeRemotePayload(fixture))

      expect(result.exitCode).toBe(75)
      expect(result.stdout).toBe('stage=remote-transaction-started\nstage=lock-contention\n')
      expect(result.stdout).not.toContain('baseline-evidence')
      expect(result.stdout).not.toContain('prune')
      expect(existsSync(dashboardRoot)).toBe(false)
      expect(readdirSync(runtimeRoot).filter(name => name.startsWith('attempt.'))).toEqual([])
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('rejects an existing runtime root with unsafe mode before lock creation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-unsafe-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    mkdirSync(runtimeRoot, {mode: 0o755})
    chmodSync(runtimeRoot, 0o755)

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('stage=remote-transaction-started\n')
      expect(result.stderr).toContain('runtime root ownership or mode is unsafe')
      expect(readdirSync(runtimeRoot)).toEqual([])
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('keeps secret-like output out of returned evidence', async () => {
    const secret = 'oauth-secret\n-----BEGIN PRIVATE KEY-----'
    const text = new TextEncoder()
    const process = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text.encode(`stage=complete\nstage=complete ${secret}\n`))
          controller.close()
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text.encode(secret))
          controller.close()
        },
      }),
      stdin: {
        write: (_data: Uint8Array) => {},
        end: () => {},
      },
      exited: Promise.resolve(0),
    }

    const result = await runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      spawn: () => process,
    })

    expect(JSON.stringify(result)).not.toContain('oauth-secret')
    expect(JSON.stringify(result)).not.toContain('BEGIN PRIVATE KEY')
  })

  it('reports an early remote exit instead of waiting forever on stdin', async () => {
    const text = new TextEncoder()
    const process = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text.encode('stage=remote-transaction-started\n'))
          controller.close()
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }),
      stdin: {
        write: (_data: Uint8Array) => new Promise<void>(() => {}),
        end: () => {},
      },
      exited: Promise.resolve(75),
    }

    const outcome = await Promise.race([
      runRemoteTransaction({host: 'dashboard.example', payload: fixture, env: localEnv, spawn: () => process}).then(
        () => 'resolved' as const,
        error => error,
      ),
      new Promise<'timed out'>(resolve => setTimeout(() => resolve('timed out'), 100)),
    ])

    expect(outcome).not.toBe('timed out')
    expect(outcome).toMatchObject({stage: 'remote-transaction-started'})
  })

  it('does not treat a zero exit without a completion marker as success', async () => {
    const emptyStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })

    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: emptyStream(),
          stderr: emptyStream(),
          stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
          exited: Promise.resolve(0),
        }),
      }),
    ).rejects.toMatchObject({stage: 'starting'})
  })

  it('reports the last allowlisted remote stage on a nonzero exit', async () => {
    const text = new TextEncoder()
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=payload-decoded\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
          exited: Promise.resolve(1),
        }),
      }),
    ).rejects.toMatchObject({stage: 'payload-decoded', exitCode: 1})
  })

  it('preserves the bounded lock-contention stage', async () => {
    const text = new TextEncoder()
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=lock-contention\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
          exited: Promise.resolve(75),
        }),
      }),
    ).rejects.toMatchObject({stage: 'lock-contention', exitCode: 75})
  })

  it('preserves a nonzero remote contention result over an EPIPE write failure', async () => {
    const text = new TextEncoder()
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=lock-contention\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {
            write: (_data: Uint8Array) => {
              throw new Error('EPIPE')
            },
            end: () => {},
          },
          exited: Promise.resolve(75),
        }),
      }),
    ).rejects.toMatchObject({stage: 'lock-contention', exitCode: 75})
  })

  it('keeps stdin close failures authoritative when the remote exits cleanly', async () => {
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('stage=payload-decoded\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {
            write: (_data: Uint8Array) => {},
            end: () => {
              throw new Error('EPIPE')
            },
          },
          exited: Promise.resolve(0),
        }),
      }),
    ).rejects.toMatchObject({stage: 'payload-decoded'})
  })

  it('preserves a nonzero remote stage over an EPIPE close failure', async () => {
    const text = new TextEncoder()
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=lock-contention\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {
            write: (_data: Uint8Array) => {},
            end: () => {
              throw new Error('EPIPE')
            },
          },
          exited: Promise.resolve(75),
        }),
      }),
    ).rejects.toMatchObject({stage: 'lock-contention', exitCode: 75})
  })

  it('returns only allowlisted operational evidence records', async () => {
    const digest = `sha256:${'b'.repeat(64)}`
    const text = new TextEncoder()
    const result = await runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              text.encode(
                `stage=complete\nevidence=free-bytes:6442450944\nevidence=storage:baseline:probe=/var/lib/docker;mount=/;source=/dev/vda1;fstype=ext4;free-bytes=6442450944\nevidence=docker-df:baseline:type=Images;count=2;active=1;size-bytes=1000;reclaimable-bytes=0\nevidence=protected-image:baseline:ref=ghcr.io/fro-bot/dashboard@${digest};count=1\nevidence=capacity:post-prune:free-bytes=6442450944\nevidence=service:dashboard\nevidence=image:ghcr.io/fro-bot/dashboard:2026.08.01@${digest}\nevidence=secret:oauth-secret\n`,
              ),
            )
            controller.close()
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
        stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
        exited: Promise.resolve(0),
      }),
    })

    expect(result.evidence).toContain('evidence=free-bytes:6442450944')
    expect(result.evidence).toContain(
      'evidence=storage:baseline:probe=/var/lib/docker;mount=/;source=/dev/vda1;fstype=ext4;free-bytes=6442450944',
    )
    expect(result.evidence).toContain('evidence=capacity:post-prune:free-bytes=6442450944')
    expect(result.evidence).toContain('evidence=service:dashboard')
    expect(result.evidence).toContain(`evidence=image:ghcr.io/fro-bot/dashboard:2026.08.01@${digest}`)
    expect(result.evidence.join('\n')).not.toContain('oauth-secret')
  })
})
