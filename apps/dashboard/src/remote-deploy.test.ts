import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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

const CADDY_DIGEST = `sha256:${'c'.repeat(64)}`
const CADDY_IMAGE = `caddy:2.11.4-alpine@${CADDY_DIGEST}`
const CADDY_REPO_DIGEST = `caddy@${CADDY_DIGEST}`
const DASHBOARD_IMAGE = `ghcr.io/fro-bot/dashboard:2026.08.01@sha256:${'a'.repeat(64)}`
const DASHBOARD_REPO_DIGEST = `ghcr.io/fro-bot/dashboard@sha256:${'a'.repeat(64)}`

const fixture: RemoteDeployPayload = {
  env: 'DASHBOARD_DOMAIN=dashboard.example\n',
  compose: `services:\n  caddy:\n    image: ${CADDY_IMAGE}\n  dashboard:\n    image: ${DASHBOARD_IMAGE}\n`,
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
  convergedDashboardHealth?: string
  pruneOutput?: string
  pruneExitCode?: number
  composeImages?: readonly string[]
  composeConfigExitCode?: number
  composePullExitCode?: number
  imageRepoDigests?: Readonly<Record<string, readonly string[]>>
  postAcquisitionFreeBytes?: number
  publicationFailureSource?: 'env' | 'caddyfile' | 'github-app.pem' | 'compose'
  composeCommandLogPath?: string
  dockerCommandLogPath?: string
  composeDashboardIdsOutput?: string
  requireDataBeforeActivePublication?: boolean
  failComposeUpIfLegacyOverrideExists?: boolean
  pruneLogPath?: string
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
  const dataPath = join(dashboardRoot, 'data')
  const legacyOverridePath = join(dashboardRoot, 'docker-compose.override.yaml')
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
  const convergedDashboardHealth = options.convergedDashboardHealth ?? 'healthy'
  const composeDashboardIdsOutput = options.composeDashboardIdsOutput ?? 'abcdef123456'
  const pruneOutput = options.pruneOutput ?? 'Deleted Images:\nTotal reclaimed space: 0B\n'
  const composeImages = options.composeImages ?? [CADDY_IMAGE, DASHBOARD_IMAGE]
  const imageRepoDigests =
    options.imageRepoDigests ??
    Object.fromEntries(
      composeImages.map(image => {
        const atIndex = image.indexOf('@')
        const imageName = atIndex === -1 ? image : image.slice(0, atIndex)
        const slashIndex = imageName.lastIndexOf('/')
        const colonIndex = imageName.lastIndexOf(':')
        const repository = colonIndex > slashIndex ? imageName.slice(0, colonIndex) : imageName
        const canonicalImage = `${repository}${image.slice(atIndex)}`
        return [canonicalImage, [canonicalImage]]
      }),
    )
  const newline = String.fromCharCode(10)
  const dockerDfScript = dockerDf.map(line => String.raw`printf '%s\n' ${shellQuote(line)}`).join(newline)
  const containerImagesScript = containerImages.map(line => String.raw`printf '%s\n' ${shellQuote(line)}`).join(newline)
  const composeImagesScript = composeImages.map(line => String.raw`printf '%s\n' ${shellQuote(line)}`).join(newline)
  const imageInspectScript = Object.entries(imageRepoDigests)
    .map(([image, repoDigests]) => {
      const output = repoDigests.map(repoDigest => String.raw`printf '%s\n' ${shellQuote(repoDigest)}`).join(newline)
      return String.raw`if [ "$5" = ${shellQuote(image)} ]; then ${output || ':'}; return 0; fi`
    })
    .join(newline)
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
        String.raw`if [ "$path" = ${shellQuote(mount.path)} ]; then if [ "$current_storage_phase" = post-acquisition ] && [ ${options.postAcquisitionFreeBytes === undefined ? '0' : '1'} -eq 1 ]; then printf '%s\n' ${shellQuote(`${options.postAcquisitionFreeBytes ?? mount.freeBytes}:1`)}; else printf '%s\n' ${shellQuote(`${mount.freeBytes}:1`)}; fi; return 0; fi`,
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
    .replaceAll('0:0:644:regular file', `${uid}:${gid}:644:Regular File`)
    .replaceAll('1000:1000:600:regular file', `${uid}:${gid}:600:Regular File`)
    .replaceAll('readonly ROOT_OWNER="0:0"', `readonly ROOT_OWNER="${uid}:${gid}"`)
    .replaceAll('install -d -m 0700 -o 0 -g 0', `install -d -m 0700 -o ${uid} -g ${gid}`)
    .replaceAll('install -m 0600 -o 0 -g 0', `install -m 0600 -o ${uid} -g ${gid}`)
    .replaceAll('install -d -m 0755 -o 0 -g 0', `install -d -m 0755 -o ${uid} -g ${gid}`)
    .replaceAll('install -m 0644 -o 0 -g 0', `install -m 0644 -o ${uid} -g ${gid}`)
    .replaceAll('install -m 0600 -o 1000 -g 1000', `install -m 0600 -o ${uid} -g ${gid}`)
    .replaceAll('chown 0:0', `chown ${uid}:${gid}`)
    .replaceAll('chown -R 1000:1000', `chown -R ${uid}:${gid}`)
    .replaceAll('chown 1000:1000', `chown ${uid}:${gid}`)
    .replaceAll('realpath -e --', 'realpath --')
    .replaceAll('realpath -e ', 'realpath ')
  return String.raw`
install() {
  if [ "${options.publicationFailureSource ?? ''}" != "" ] && [ "$7" = "$stage/${options.publicationFailureSource ?? ''}" ]; then return 1; fi
  if [ "${options.requireDataBeforeActivePublication ? '1' : '0'}" -eq 1 ] && { [ "$7" = "\$stage/env" ] || [ "$7" = "\$stage/caddyfile" ] || [ "$7" = "\$stage/github-app.pem" ] || [ "$7" = "\$stage/compose" ]; }; then
    data_stat="$(stat -c "%u:%g:%a:%F" -- ${shellQuote(dataPath)} 2>/dev/null)" || return 1
    [ "$data_stat" = ${shellQuote(`${uid}:${gid}:700:Directory`)} ] || return 1
  fi
  command install "$@"
}
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
current_storage_phase=''
dashboard_converged=0
docker() {
  ${options.dockerCommandLogPath ? String.raw`printf '%s\n' "$*" >> ${shellQuote(options.dockerCommandLogPath)}` : ':'}
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
    ${options.pruneLogPath ? String.raw`printf '%s\n' prune >> ${shellQuote(options.pruneLogPath)}` : ':'}
    ${pruneScript}
    return ${options.pruneExitCode ?? 0}
  fi
  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    ${imageInspectScript}
    return 1
  fi
  if [ "$1" = "compose" ]; then
    ${options.composeCommandLogPath ? String.raw`printf '%s\n' "$*" >> ${shellQuote(options.composeCommandLogPath)}` : ':'}
    if [[ "$*" == *" config --images"* ]]; then ${composeImagesScript}; return ${options.composeConfigExitCode ?? 0}; fi
    if [[ "$*" == *" pull"* ]]; then return ${options.composePullExitCode ?? 0}; fi
    if [[ "$*" == *" up "* ]] && [ ${options.failComposeUpIfLegacyOverrideExists ? '1' : '0'} -eq 1 ] && { [ -e ${shellQuote(legacyOverridePath)} ] || [ -L ${shellQuote(legacyOverridePath)} ]; }; then return 1; fi
    if [[ "$*" == *" up "* && "$*" == *" dashboard"* ]]; then dashboard_converged=1; return 0; fi
    if [[ "$*" == *" up "* && "$*" == *" caddy"* ]]; then return 0; fi
    if [ "$2" = "ps" ]; then printf '%s\n' ${shellQuote(composeDashboardIdsOutput)}; return 0; fi
  fi
  if [ "$1" = "inspect" ] && [ "$4" = "abcdef123456" ]; then
    case "$3" in
      "{{.Image}}") printf 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n' ;;
      "{{.State.Health.Status}}") if [ "$dashboard_converged" -eq 1 ]; then printf '%s\n' ${shellQuote(convergedDashboardHealth)}; else printf '%s\n' ${shellQuote(runningDashboardHealth)}; fi ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if [ "$1" = "inspect" ] && [ "$4" = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" ]; then
    case "$3" in
      "{{json .RepoDigests}}") printf '["ghcr.io/fro-bot/dashboard@${runningDashboardImageDigest}"]\n' ;;
      "{{range .RepoDigests}}{{println .}}{{end}}") printf 'ghcr.io/fro-bot/dashboard@${runningDashboardImageDigest}\n' ;;
      *) return 1 ;;
    esac
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
                `stage=post-acquisition-capacity\nevidence=free-bytes:6442450944\nevidence=storage:baseline:probe=/var/lib/docker;mount=/;source=/dev/vda1;fstype=ext4;free-bytes=6442450944\nevidence=storage:post-acquisition:probe=/var/lib/docker;mount=/;source=/dev/vda1;fstype=ext4;free-bytes=6442450944\nevidence=docker-df:baseline:type=Images;count=2;active=1;size-bytes=1000;reclaimable-bytes=0\nevidence=protected-image:baseline:ref=ghcr.io/fro-bot/dashboard@${digest};count=1\nevidence=capacity:post-prune:free-bytes=6442450944\nevidence=capacity:post-acquisition:free-bytes=6442450944\nevidence=acquisition:mode=pull\nevidence=image-verified:ghcr.io/fro-bot/dashboard@${digest}\nevidence=active-state:published=compose\nevidence=runtime-digest:${digest}\nevidence=health:healthy\nevidence=service:dashboard\nevidence=container:dashboard\nevidence=mount:/var/lib/docker\nevidence=image:ghcr.io/fro-bot/dashboard:2026.08.01@${digest}\nevidence=digest:${digest}\nevidence=secret:oauth-secret\nstage=complete\n`,
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

    expect(result.evidence).not.toContain('evidence=free-bytes:6442450944')
    expect(result.evidence).toContain(
      'evidence=storage:baseline:probe=/var/lib/docker;mount=/;source=/dev/vda1;fstype=ext4;free-bytes=6442450944',
    )
    expect(result.evidence).toContain('evidence=capacity:post-prune:free-bytes=6442450944')
    expect(result.evidence).toContain(
      'evidence=storage:post-acquisition:probe=/var/lib/docker;mount=/;source=/dev/vda1;fstype=ext4;free-bytes=6442450944',
    )
    expect(result.evidence).toContain('evidence=acquisition:mode=pull')
    expect(result.evidence).toContain(`evidence=image-verified:ghcr.io/fro-bot/dashboard@${digest}`)
    expect(result.evidence).toContain('evidence=active-state:published=compose')
    expect(result.evidence).toContain(`evidence=runtime-digest:${digest}`)
    expect(result.evidence).toContain('evidence=health:healthy')
    expect(result.evidence).not.toContain('evidence=service:dashboard')
    expect(result.evidence).not.toContain('evidence=container:dashboard')
    expect(result.evidence).not.toContain('evidence=mount:/var/lib/docker')
    expect(result.evidence).not.toContain(`evidence=image:ghcr.io/fro-bot/dashboard:2026.08.01@${digest}`)
    expect(result.evidence).not.toContain(`evidence=digest:${digest}`)
    expect(result.evidence.join('\n')).not.toContain('oauth-secret')
  })
})

describe('U4 staged image acquisition and publication ordering', () => {
  it('pulls and exactly verifies every staged service image before publishing Compose last', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-pull-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const composeLogPath = join(root, 'compose.log')
    const pruneLogPath = join(root, 'prune.log')
    const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`
    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          composeCommandLogPath: composeLogPath,
          pruneLogPath,
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('evidence=acquisition:mode=pull')
      expect(result.stdout).toContain(`evidence=image-verified:caddy@${CADDY_DIGEST}`)
      expect(result.stdout).toContain(
        `evidence=image-verified:ghcr.io/fro-bot/dashboard@${fixture.expectedDashboardDigest}`,
      )
      expect(result.stdout).toContain('stage=post-acquisition-capacity')
      expect(result.stdout).toContain('evidence=capacity:post-acquisition:free-bytes=8589934592')
      expect(result.stdout).toContain('evidence=active-state:published=compose')
      expect(readFileSync(join(dashboardRoot, 'docker-compose.yaml'), 'utf8')).toBe(fixture.compose)

      const composeCommands = readFileSync(composeLogPath, 'utf8').trim().split('\n')
      expect(composeCommands[0]).toContain('config --images')
      expect(composeCommands[0]).toContain(`${runtimeRoot}/attempt.`)
      expect(composeCommands[1]).toContain('pull')
      expect(composeCommands[1]).toContain(`${runtimeRoot}/attempt.`)
      expect(readFileSync(pruneLogPath, 'utf8').trim().split('\n')).toHaveLength(1)

      const publicationEvidence = result.stdout
        .split('\n')
        .filter(line => line.startsWith('evidence=active-state:published='))
      expect(publicationEvidence).toEqual([
        'evidence=active-state:published=env',
        'evidence=active-state:published=caddyfile',
        'evidence=active-state:published=pem',
        'evidence=active-state:published=compose',
      ])
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('rejects a tag-only staged image before active-state mutation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-tag-only-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`
    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)
    const tagOnly = 'ghcr.io/fro-bot/dashboard:latest'

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          composeImages: [tagOnly, CADDY_IMAGE],
        }),
        encodeRemotePayload({...fixture, compose: `services:\n  dashboard:\n    image: ${tagOnly}\n`}),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain('stage=active-state-written')
      expect(readFileSync(join(dashboardRoot, 'docker-compose.yaml'), 'utf8')).toBe(oldCompose)
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('rejects duplicate and unexpected staged image identities before acquisition', async () => {
    const cases = [
      {
        name: 'duplicate-canonical-identity',
        composeImages: [
          DASHBOARD_IMAGE,
          `ghcr.io/fro-bot/dashboard:stable@${fixture.expectedDashboardDigest}`,
          CADDY_IMAGE,
        ],
      },
      {
        name: 'unexpected-dashboard-digest',
        composeImages: [`ghcr.io/fro-bot/dashboard:2026.08.01@sha256:${'b'.repeat(64)}`, CADDY_IMAGE],
      },
    ] as const

    for (const testCase of cases) {
      const parent = mkdtempSync(join(tmpdir(), `dashboard-deploy-u4-${testCase.name}-`))
      const root = realpathSync(parent)
      const runtimeRoot = join(root, 'dashboard-deploy')
      const dashboardRoot = `${runtimeRoot}-dashboard`
      const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`
      mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
      mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
      writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)

      try {
        const result = await runShellProgram(
          adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {composeImages: testCase.composeImages}),
          encodeRemotePayload(fixture),
        )

        expect(result.exitCode, testCase.name).not.toBe(0)
        expect(result.stdout, testCase.name).not.toContain('stage=image-acquisition')
        expect(readFileSync(join(dashboardRoot, 'docker-compose.yaml'), 'utf8'), testCase.name).toBe(oldCompose)
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
    }
  })

  it('uses the exact cached image set when registry pull fails', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-cache-fallback-'))
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
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          composePullExitCode: 1,
          imageRepoDigests: {
            [CADDY_REPO_DIGEST]: [CADDY_REPO_DIGEST],
            [DASHBOARD_REPO_DIGEST]: [DASHBOARD_REPO_DIGEST],
          },
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('evidence=acquisition:mode=cache-fallback')
      expect(result.stdout).toContain(`evidence=image-verified:caddy@${CADDY_DIGEST}`)
      expect(result.stdout).toContain(
        `evidence=image-verified:ghcr.io/fro-bot/dashboard@${fixture.expectedDashboardDigest}`,
      )
      expect(result.stdout).toContain('stage=complete')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('accepts only one exact match among valid RepoDigests aliases', async () => {
    const otherCaddyDigest = `sha256:${'d'.repeat(64)}`
    const cases = [
      {
        name: 'expected-and-other-alias',
        expectedExitCode: 0,
        caddyRepoDigests: [CADDY_REPO_DIGEST, `caddy@${otherCaddyDigest}`],
        dashboardRepoDigests: [DASHBOARD_REPO_DIGEST, `ghcr.io/fro-bot/dashboard@${otherCaddyDigest}`],
      },
      {
        name: 'no-expected-alias',
        expectedExitCode: 1,
        caddyRepoDigests: [`caddy@${otherCaddyDigest}`],
        dashboardRepoDigests: [DASHBOARD_REPO_DIGEST],
      },
      {
        name: 'duplicate-expected-alias',
        expectedExitCode: 1,
        caddyRepoDigests: [CADDY_REPO_DIGEST, CADDY_REPO_DIGEST],
        dashboardRepoDigests: [DASHBOARD_REPO_DIGEST],
      },
      {
        name: 'malformed-alias',
        expectedExitCode: 1,
        caddyRepoDigests: [CADDY_REPO_DIGEST, 'not-a-repo-digest'],
        dashboardRepoDigests: [DASHBOARD_REPO_DIGEST],
      },
    ] as const

    for (const testCase of cases) {
      const parent = mkdtempSync(join(tmpdir(), `dashboard-deploy-u4-repodigests-${testCase.name}-`))
      const root = realpathSync(parent)
      const runtimeRoot = join(root, 'dashboard-deploy')
      const dashboardRoot = `${runtimeRoot}-dashboard`
      const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`
      mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
      mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
      writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)

      try {
        const result = await runShellProgram(
          adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
            composePullExitCode: 1,
            imageRepoDigests: {
              [CADDY_REPO_DIGEST]: testCase.caddyRepoDigests,
              [DASHBOARD_REPO_DIGEST]: testCase.dashboardRepoDigests,
            },
          }),
          encodeRemotePayload(fixture),
        )

        expect(result.exitCode, testCase.name).toBe(testCase.expectedExitCode)
        if (testCase.expectedExitCode !== 0) {
          expect(readFileSync(join(dashboardRoot, 'docker-compose.yaml'), 'utf8'), testCase.name).toBe(oldCompose)
        }
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
    }
  })

  it('stops on a missing or mismatched cached image without changing old Compose', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-cache-miss-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`
    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          composePullExitCode: 1,
          imageRepoDigests: {
            [CADDY_IMAGE]: [`caddy@sha256:${'d'.repeat(64)}`],
            [DASHBOARD_IMAGE]: [],
          },
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain('stage=active-state-written')
      expect(readFileSync(join(dashboardRoot, 'docker-compose.yaml'), 'utf8')).toBe(oldCompose)
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('stops when a successful pull does not yield an exact staged digest', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-pull-mismatch-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`
    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          imageRepoDigests: {
            [CADDY_IMAGE]: [`caddy@sha256:${'d'.repeat(64)}`],
            [DASHBOARD_IMAGE]: [`ghcr.io/fro-bot/dashboard@${fixture.expectedDashboardDigest}`],
          },
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain('stage=active-state-mutation')
      expect(readFileSync(join(dashboardRoot, 'docker-compose.yaml'), 'utf8')).toBe(oldCompose)
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('fails before creating active paths when acquisition drops below 6 GiB', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-acquisition-floor-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {postAcquisitionFreeBytes: 6442450943}),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('stage=post-acquisition-capacity')
      expect(result.stdout).toContain('evidence=capacity:post-acquisition:free-bytes=6442450943')
      expect(result.stdout).not.toContain('stage=active-state-mutation')
      expect(existsSync(dashboardRoot)).toBe(false)
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('rejects symlink and non-regular final paths before publishing any active file', async () => {
    const conflicts = [
      ['env-symlink', 'env', 'symlink'],
      ['caddyfile-directory', 'caddyfile', 'directory'],
      ['pem-symlink', 'pem', 'symlink'],
      ['compose-directory', 'compose', 'directory'],
    ] as const

    for (const [name, target, kind] of conflicts) {
      const parent = mkdtempSync(join(tmpdir(), `dashboard-deploy-u4-path-${name}-`))
      const root = realpathSync(parent)
      const runtimeRoot = join(root, 'dashboard-deploy')
      const dashboardRoot = `${runtimeRoot}-dashboard`
      const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`
      mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
      mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
      writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)
      const path = {
        env: join(dashboardRoot, '.env'),
        caddyfile: join(dashboardRoot, 'config', 'Caddyfile'),
        pem: join(dashboardRoot, 'config', 'github-app.pem'),
        compose: join(dashboardRoot, 'docker-compose.yaml'),
      }[target]

      try {
        if (target === 'compose') rmSync(path)
        if (kind === 'symlink') symlinkSync(join(parent, 'target'), path)
        else mkdirSync(path)

        const result = await runShellProgram(
          adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot),
          encodeRemotePayload(fixture),
        )

        expect(result.exitCode, name).not.toBe(0)
        expect(result.stdout, name).not.toContain('stage=active-state-written')
        if (target === 'compose') expect(existsSync(path) && statSync(path).isDirectory(), name).toBe(true)
        else expect(readFileSync(join(dashboardRoot, 'docker-compose.yaml'), 'utf8'), name).toBe(oldCompose)
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
    }
  })

  it('leaves old Compose byte-identical when support publication fails before Compose', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-publication-failure-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`
    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {publicationFailureSource: 'compose'}),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('evidence=active-state:published=pem')
      expect(result.stdout).not.toContain('evidence=active-state:published=compose')
      expect(result.stdout).not.toContain('stage=active-state-written')
      expect(readFileSync(join(dashboardRoot, 'docker-compose.yaml'), 'utf8')).toBe(oldCompose)
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('prepares listener data and publishes the App key contract before converging without a legacy override', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-active-contracts-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const dataPath = join(dashboardRoot, 'data')
    const appKeyPath = join(dashboardRoot, 'config', 'github-app.pem')
    const legacyOverridePath = join(dashboardRoot, 'docker-compose.override.yaml')
    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(dataPath, {recursive: true})
    writeFileSync(
      join(dashboardRoot, 'docker-compose.yaml'),
      `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`,
    )
    writeFileSync(legacyOverridePath, 'stale override\n')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          requireDataBeforeActivePublication: true,
          failComposeUpIfLegacyOverrideExists: true,
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(statSync(dataPath).mode & 0o7777).toBe(0o700)
      expect(statSync(appKeyPath).mode & 0o7777).toBe(0o600)
      expect(statSync(appKeyPath).uid).toBe(process.getuid?.() ?? statSync(appKeyPath).uid)
      expect(statSync(appKeyPath).gid).toBe(process.getgid?.() ?? statSync(appKeyPath).gid)
      expect(existsSync(legacyOverridePath)).toBe(false)
      expect(result.stdout).toContain('stage=complete')
      expect(REMOTE_TRANSACTION_PROGRAM).toContain('install -m 0600 -o 1000 -g 1000')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('rejects empty, multiple, and malformed running dashboard container identities', async () => {
    const identities = ['', 'abcdef123456\n0123456789abcdef', 'ABCDEF123456', 'abc123']

    for (const identity of identities) {
      const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-u4-runtime-container-id-'))
      const root = realpathSync(parent)
      const runtimeRoot = join(root, 'dashboard-deploy')
      const dashboardRoot = `${runtimeRoot}-dashboard`
      const dockerLogPath = join(root, 'docker.log')
      mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
      mkdirSync(join(dashboardRoot, 'data'), {recursive: true})

      try {
        const result = await runShellProgram(
          adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
            composeDashboardIdsOutput: identity,
            dockerCommandLogPath: dockerLogPath,
          }),
          encodeRemotePayload(fixture),
        )
        expect(result.exitCode, JSON.stringify(identity)).not.toBe(0)
        const inspectCommands = readFileSync(dockerLogPath, 'utf8')
          .split('\n')
          .filter(line => line.startsWith('inspect '))
        if (identity !== '') expect(inspectCommands, JSON.stringify(identity)).toEqual([])
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
    }
  })
})
