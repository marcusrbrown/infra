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
  REMOTE_CALLER_WATCHDOG_SECONDS,
  REMOTE_PAYLOAD_FIELD_LIMITS,
  REMOTE_TRANSACTION_PROGRAM,
  REMOTE_TRANSACTION_TEST_PROGRAM,
  RemoteTransactionError,
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

class ManualTimers {
  private nextHandle = 1
  private readonly callbacks = new Map<number, () => void>()

  readonly set = (callback: () => void, _delayMs: number): number => {
    const handle = this.nextHandle++
    this.callbacks.set(handle, callback)
    return handle
  }

  readonly clear = (handle: unknown): void => {
    if (typeof handle === 'number') this.callbacks.delete(handle)
  }

  fireNext(): void {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined
    if (!next) throw new Error('No scheduled timer to fire')
    this.callbacks.delete(next[0])
    next[1]()
  }

  get size(): number {
    return this.callbacks.size
  }
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
  stubFlock?: boolean
  stubFlockExitCode?: number
  emitTestChildPid?: boolean
  runningDashboardRepoDigests?: readonly string[]
  runningDashboardRepoDigestsAfterConvergence?: readonly string[]
  imageRepoDigestsAfterPull?: Readonly<Record<string, readonly string[]>>
  imageRepoDigestsAfterConvergence?: Readonly<Record<string, readonly string[]>>
  postConvergenceFreeBytes?: number
  dashboardMounts?: readonly {type: string; source: string; destination: string; rw: boolean}[]
  runningCaddyContainers?: readonly {id: string; project: string; service: string}[]
  caddyMounts?: readonly {type: string; name: string; destination: string; rw: boolean}[]
  caddyVolumeLabels?: Readonly<Record<string, {project: string; composeVolume: string}>>
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`

const replaceRequired = (source: string, token: string, replacement: string): string => {
  if (!source.includes(token)) throw new Error(`Harness substitution token disappeared: ${token}`)
  return source.replaceAll(token, replacement)
}

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
  const darwinStat = process.platform === 'darwin'
  const expectedDirectoryType = darwinStat ? 'Directory' : 'directory'
  const expectedRegularFileType = darwinStat ? 'Regular File' : 'regular file'
  const hostFileStat = darwinStat
    ? '/usr/bin/stat -f "%u:%g:%Lp:%HT" "$1"'
    : String.raw`command stat -c "%u:%g:%a:%F" "$1"`
  const hostFileNumericStat = darwinStat
    ? '/usr/bin/stat -f "%u:%g:%Lp" "$1"'
    : String.raw`command stat -c "%u:%g:%a" "$1"`
  const hostFileSizeStat = darwinStat ? '/usr/bin/stat -f "%z" "$1"' : 'command stat -c "%s" "$1"'
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
  const defaultImageRepoDigests = Object.fromEntries(
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
  const imageRepoDigests = options.imageRepoDigests ?? defaultImageRepoDigests
  const imageRepoDigestsAfterPull = options.imageRepoDigestsAfterPull ?? defaultImageRepoDigests
  const imageRepoDigestsAfterConvergence = options.imageRepoDigestsAfterConvergence ?? imageRepoDigestsAfterPull
  const newline = String.fromCharCode(10)
  const dockerDfScript = dockerDf.map(line => String.raw`printf '%s\n' ${shellQuote(line)}`).join(newline)
  const containerImagesScript = containerImages.map(line => String.raw`printf '%s\n' ${shellQuote(line)}`).join(newline)
  const composeImagesScript = composeImages.map(line => String.raw`printf '%s\n' ${shellQuote(line)}`).join(newline)
  const imageInspectScriptFor = (repoDigestMap: Readonly<Record<string, readonly string[]>>): string =>
    Object.entries(repoDigestMap)
      .map(([image, repoDigests]) => {
        const output = repoDigests.map(repoDigest => String.raw`printf '%s\n' ${shellQuote(repoDigest)}`).join(newline)
        return String.raw`if [ "$5" = ${shellQuote(image)} ]; then ${output || ':'}; return 0; fi`
      })
      .join(newline)
  const imageInspectScript = imageInspectScriptFor(imageRepoDigests)
  const imageInspectAfterPullScript = imageInspectScriptFor(imageRepoDigestsAfterPull)
  const imageInspectAfterConvergenceScript = imageInspectScriptFor(imageRepoDigestsAfterConvergence)
  const runningDashboardServiceIdsScript = runningDashboardContainers
    .filter(container => container.service === 'dashboard')
    .map(container => String.raw`printf '%s\n' ${shellQuote(container.id)}`)
    .join(newline)
  const runningDashboardExactIdsScript = runningDashboardContainers
    .filter(container => container.project === 'dashboard' && container.service === 'dashboard')
    .map(container => String.raw`printf '%s\n' ${shellQuote(container.id)}`)
    .join(newline)
  const runningCaddyContainers = options.runningCaddyContainers ?? [
    {id: 'caddabcdef12', project: 'dashboard', service: 'caddy'},
  ]
  const runningCaddyProjectIdsScript = runningCaddyContainers
    .filter(container => container.project === 'dashboard' && container.service === 'caddy')
    .map(container => String.raw`printf '%s\n' ${shellQuote(container.id)}`)
    .join(newline)
  const pruneScript = String.raw`printf '%s\n' ${shellQuote(pruneOutput.replace(/\n$/, ''))}`
  const runningDashboardRepoDigests = options.runningDashboardRepoDigests ?? [
    `ghcr.io/fro-bot/dashboard@${runningDashboardImageDigest}`,
  ]
  const runningDashboardRepoDigestsAfterConvergence = options.runningDashboardRepoDigestsAfterConvergence ?? [
    `ghcr.io/fro-bot/dashboard@${fixture.expectedDashboardDigest}`,
  ]
  const runningDashboardRepoDigestScript = runningDashboardRepoDigests
    .map(repoDigest => String.raw`printf '%s\n' ${shellQuote(repoDigest)}`)
    .join(newline)
  const runningDashboardRepoDigestScriptAfterConvergence = runningDashboardRepoDigestsAfterConvergence
    .map(repoDigest => String.raw`printf '%s\n' ${shellQuote(repoDigest)}`)
    .join(newline)
  const runningDashboardRepoDigestJson = JSON.stringify(runningDashboardRepoDigests)
  const runningDashboardRepoDigestJsonAfterConvergence = JSON.stringify(runningDashboardRepoDigestsAfterConvergence)
  const dataMounts = options.dashboardMounts ?? [{type: 'bind', source: dataPath, destination: '/data', rw: true}]
  const dataMountsScript = dataMounts
    .map(
      mount =>
        String.raw`printf '%s\n' ${shellQuote(`${mount.type}|${mount.source}|${mount.destination}|${mount.rw ? 'true' : 'false'}`)}`,
    )
    .join(newline)
  const caddyMounts = options.caddyMounts ?? [
    {type: 'volume', name: 'dashboard_caddy_data', destination: '/data', rw: true},
    {type: 'volume', name: 'dashboard_caddy_config', destination: '/config', rw: true},
  ]
  const caddyMountsScript = caddyMounts
    .map(
      mount =>
        String.raw`printf '%s\n' ${shellQuote(`${mount.type}|${mount.name}|${mount.destination}|${mount.rw ? 'true' : 'false'}`)}`,
    )
    .join(newline)
  const caddyVolumeLabels = options.caddyVolumeLabels ?? {
    dashboard_caddy_data: {project: 'dashboard', composeVolume: 'caddy_data'},
    dashboard_caddy_config: {project: 'dashboard', composeVolume: 'caddy_config'},
  }
  const caddyVolumeLabelsScript = Object.entries(caddyVolumeLabels)
    .map(
      ([name, labels]) =>
        String.raw`if [ "$5" = ${shellQuote(name)} ]; then printf '%s\n' ${shellQuote(`${labels.project}|${labels.composeVolume}`)}; return 0; fi`,
    )
    .join(newline)
  const mountCaseScript = mounts
    .map(
      mount =>
        String.raw`if [ "$path" = ${shellQuote(mount.path)} ]; then printf '%s\n' ${shellQuote(`${mount.target} ${mount.source} ${mount.fstype}`)}; return 0; fi`,
    )
    .join(`${newline}  `)
  const statCaseScript = mounts
    .map(
      mount =>
        String.raw`if [ "$path" = ${shellQuote(mount.path)} ]; then if [ "$current_storage_phase" = post-acquisition ] && [ ${options.postAcquisitionFreeBytes === undefined ? '0' : '1'} -eq 1 ]; then printf '%s\n' ${shellQuote(`${options.postAcquisitionFreeBytes ?? mount.freeBytes}:1`)}; elif [ "$current_storage_phase" = post-convergence ] && [ ${options.postConvergenceFreeBytes === undefined ? '0' : '1'} -eq 1 ]; then printf '%s\n' ${shellQuote(`${options.postConvergenceFreeBytes ?? mount.freeBytes}:1`)}; else printf '%s\n' ${shellQuote(`${mount.freeBytes}:1`)}; fi; return 0; fi`,
    )
    .join(`${newline}    `)
  let program =
    options.stubFlock === false || options.stubFlockExitCode !== undefined
      ? REMOTE_TRANSACTION_PROGRAM
      : REMOTE_TRANSACTION_TEST_PROGRAM
  program = replaceRequired(program, '"/run/dashboard-deploy/lock"', JSON.stringify(`${runtimeRoot}/lock`))
  program = replaceRequired(program, '"/run/dashboard-deploy"', JSON.stringify(runtimeRoot))
  program = replaceRequired(program, '"/var/lib/containerd"', JSON.stringify(containerdRoot))
  program = replaceRequired(program, '"/opt/dashboard"', JSON.stringify(dashboardRoot))
  program = replaceRequired(program, '"/opt/dashboard/config"', JSON.stringify(`${dashboardRoot}/config`))
  program = replaceRequired(program, '"/opt/dashboard/data"', JSON.stringify(`${dashboardRoot}/data`))
  program = replaceRequired(program, '"/opt/dashboard/.env"', JSON.stringify(`${dashboardRoot}/.env`))
  program = replaceRequired(
    program,
    '"/opt/dashboard/docker-compose.yaml"',
    JSON.stringify(`${dashboardRoot}/docker-compose.yaml`),
  )
  program = replaceRequired(
    program,
    '"/opt/dashboard/config/Caddyfile"',
    JSON.stringify(`${dashboardRoot}/config/Caddyfile`),
  )
  program = replaceRequired(
    program,
    '"/opt/dashboard/config/github-app.pem"',
    JSON.stringify(`${dashboardRoot}/config/github-app.pem`),
  )
  program = replaceRequired(
    program,
    '"/opt/dashboard/docker-compose.override.yaml"',
    JSON.stringify(`${dashboardRoot}/docker-compose.override.yaml`),
  )
  program = replaceRequired(program, '0:0:700:directory', `${uid}:${gid}:700:${expectedDirectoryType}`)
  program = replaceRequired(
    program,
    'env) expected_stat="0:0:600:regular file"',
    `env) expected_stat="${uid}:${gid}:600:${expectedRegularFileType}"`,
  )
  program = replaceRequired(program, '0:0:644:regular file', `${uid}:${gid}:644:${expectedRegularFileType}`)
  program = replaceRequired(program, '1000:1000:600:regular file', `${uid}:${gid}:600:${expectedRegularFileType}`)
  program = replaceRequired(program, '1000:1000:700:directory', `${uid}:${gid}:700:${expectedDirectoryType}`)
  program = replaceRequired(program, 'readonly ROOT_OWNER="0:0"', `readonly ROOT_OWNER="${uid}:${gid}"`)
  program = replaceRequired(program, 'install -d -m 0700 -o 0 -g 0', `install -d -m 0700 -o ${uid} -g ${gid}`)
  program = replaceRequired(program, 'install -d -m 0700 -o 1000 -g 1000', `install -d -m 0700 -o ${uid} -g ${gid}`)
  program = replaceRequired(program, 'install -m 0600 -o 0 -g 0', `install -m 0600 -o ${uid} -g ${gid}`)
  program = replaceRequired(program, 'install -d -m 0755 -o 0 -g 0', `install -d -m 0755 -o ${uid} -g ${gid}`)
  program = replaceRequired(program, 'install -m 0644 -o 0 -g 0', `install -m 0644 -o ${uid} -g ${gid}`)
  program = replaceRequired(program, 'install -m 0600 -o 1000 -g 1000', `install -m 0600 -o ${uid} -g ${gid}`)
  program = replaceRequired(program, 'chown 0:0', `chown ${uid}:${gid}`)
  program = replaceRequired(program, 'chown -R 1000:1000', `chown -R ${uid}:${gid}`)
  program = replaceRequired(program, 'realpath -e --', 'realpath --')
  program = replaceRequired(program, 'realpath -e ', 'realpath ')
  if (options.emitTestChildPid) {
    program = replaceRequired(
      program,
      'mark_stage lock-acquired',
      'mark_stage lock-acquired\nprintf "%s\\n" "test-child-pid=$BASHPID"',
    )
  }
  return String.raw`
install() {
  if [ "${options.publicationFailureSource ?? ''}" != "" ] && [ "$7" = "$stage/${options.publicationFailureSource ?? ''}" ]; then return 1; fi
  if [ "${options.requireDataBeforeActivePublication ? '1' : '0'}" -eq 1 ] && { [ "$7" = "\$stage/env" ] || [ "$7" = "\$stage/caddyfile" ] || [ "$7" = "\$stage/github-app.pem" ] || [ "$7" = "\$stage/compose" ]; }; then
    data_stat="$(stat -c "%u:%g:%a:%F" -- ${shellQuote(dataPath)} 2>/dev/null)" || return 1
    [ "$data_stat" = ${shellQuote(`${uid}:${gid}:700:${expectedDirectoryType}`)} ] || return 1
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
      "%u:%g:%a") ${hostFileNumericStat} ;;
      "%u:%g:%a:%F") ${hostFileStat} ;;
      "%s") ${hostFileSizeStat} ;;
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
${options.stubFlock === false ? '' : options.stubFlockExitCode === undefined ? 'flock() { return 0; }' : `flock() { return ${options.stubFlockExitCode}; }`}
compose_pulled=0
current_storage_phase=''
dashboard_converged=0
convergence_completed=0
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
    if [[ "$*" == *"label=com.docker.compose.project=dashboard"* && "$*" == *"label=com.docker.compose.service=caddy"* ]]; then
      :
      ${runningCaddyProjectIdsScript}
    elif [[ "$*" == *"label=com.docker.compose.project=dashboard"* && "$*" == *"label=com.docker.compose.service=dashboard"* ]]; then
      :
      if [ "$dashboard_converged" -eq 1 ]; then printf '%s\n' ${shellQuote(composeDashboardIdsOutput)}; else ${runningDashboardExactIdsScript || ':'}; fi
    elif [[ "$*" == *"label=com.docker.compose.project=dashboard"* ]]; then
      :
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
    if [ "$convergence_completed" -eq 1 ]; then
      ${imageInspectAfterConvergenceScript || ':'}
    elif [ "$compose_pulled" -eq 1 ]; then
      ${imageInspectAfterPullScript || ':'}
    else
      ${imageInspectScript || ':'}
    fi
    return 1
  fi
  if [ "$1" = "compose" ]; then
    ${options.composeCommandLogPath ? String.raw`printf '%s\n' "$*" >> ${shellQuote(options.composeCommandLogPath)}` : ':'}
    if [[ "$*" == *" config --images"* ]]; then ${composeImagesScript}; return ${options.composeConfigExitCode ?? 0}; fi
    if [[ "$*" == *" pull"* ]]; then compose_pulled=1; return ${options.composePullExitCode ?? 0}; fi
    if [[ "$*" == *" up "* ]] && [ ${options.failComposeUpIfLegacyOverrideExists ? '1' : '0'} -eq 1 ] && { [ -e ${shellQuote(legacyOverridePath)} ] || [ -L ${shellQuote(legacyOverridePath)} ]; }; then return 1; fi
    if [[ "$*" == *" up "* && "$*" == *" dashboard"* ]]; then dashboard_converged=1; return 0; fi
    if [[ "$*" == *" up "* && "$*" == *" caddy"* ]]; then convergence_completed=1; return 0; fi
    if [ "$2" = "ps" ]; then printf '%s\n' ${shellQuote(composeDashboardIdsOutput)}; return 0; fi
  fi
  if [ "$1" = "inspect" ] && [ "$4" = "abcdef123456" ]; then
    case "$3" in
      "{{.Image}}") printf 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n' ;;
      "{{.State.Health.Status}}") if [ "$dashboard_converged" -eq 1 ]; then printf '%s\n' ${shellQuote(convergedDashboardHealth)}; else printf '%s\n' ${shellQuote(runningDashboardHealth)}; fi ;;
      "{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"com.docker.compose.service\"}}") printf '%s\n' 'dashboard|dashboard' ;;
      "{{range .Mounts}}{{printf \"%s|%s|%s|%t\n\" .Type .Source .Destination .RW}}{{end}}") ${dataMountsScript || ':'} ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if [ "$1" = "inspect" ] && [ "$4" = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" ]; then
    case "$3" in
      "{{json .RepoDigests}}") if [ "$dashboard_converged" -eq 1 ]; then printf '%s\n' ${shellQuote(runningDashboardRepoDigestJsonAfterConvergence)}; else printf '%s\n' ${shellQuote(runningDashboardRepoDigestJson)}; fi ;;
      "{{range .RepoDigests}}{{println .}}{{end}}") if [ "$dashboard_converged" -eq 1 ]; then ${runningDashboardRepoDigestScriptAfterConvergence}; else ${runningDashboardRepoDigestScript}; fi ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if [ "$1" = "inspect" ] && [ "$4" = "caddabcdef12" ]; then
    case "$3" in
      "{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"com.docker.compose.service\"}}") printf '%s\n' 'dashboard|caddy' ;;
      "{{range .Mounts}}{{printf \"%s|%s|%s|%t\n\" .Type .Name .Destination .RW}}{{end}}") ${caddyMountsScript || ':'} ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
    if [ "$3" = "--format" ]; then
      ${caddyVolumeLabelsScript || ':'}
    fi
    return 1
  fi
  return 1
}
export compose_pulled current_storage_phase dashboard_converged convergence_completed
export -f install stat findmnt docker
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

  it('places the fixed transaction deadline in the remote command argv', () => {
    const command = buildRemoteSshCommand({host: 'dashboard.example'})

    expect(command.at(-1)).toContain('/usr/bin/timeout --signal=TERM --kill-after=15s 900s ')
  })

  it('allows deadline values to be shortened only through the test seam', () => {
    const command = buildRemoteSshCommand({
      host: 'dashboard.example',
      remoteTimeoutSeconds: 3,
      remoteKillAfterSeconds: 2,
    })

    expect(command.at(-1)).toContain('/usr/bin/timeout --signal=TERM --kill-after=2s 3s ')
  })

  it('normalizes either GNU timeout escalation status to the reserved transaction timeout', () => {
    const command = buildRemoteSshCommand({host: 'dashboard.example'}).at(-1) ?? ''

    expect(command).toContain('timeout_exit=$?')
    expect(command).toContain('[ "$timeout_exit" -eq 124 ] || [ "$timeout_exit" -eq 137 ]')
    expect(command).toContain('failure=transaction-timeout')
    expect(command).toContain('exit 124')
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
  it('normalizes both GNU timeout expiry statuses without leaking timeout stderr', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-timeout-wrapper-'))
    const fakeTimeout = join(parent, 'timeout')
    writeFileSync(fakeTimeout, '#!/bin/sh\nexit "$FAKE_TIMEOUT_EXIT"\n')
    chmodSync(fakeTimeout, 0o755)

    try {
      for (const status of [124, 137]) {
        const command =
          buildRemoteSshCommand({host: 'dashboard.example'}).at(-1) ??
          (() => {
            throw new Error('missing remote command')
          })()
        const wrapper = replaceRequired(command, '/usr/bin/timeout', fakeTimeout)
        const child = Bun.spawn(['bash', '-c', wrapper], {
          env: {...globalThis.process.env, FAKE_TIMEOUT_EXIT: String(status)},
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])

        expect(exitCode).toBe(124)
        expect(stdout).toBe('failure=transaction-timeout\n')
        expect(stderr).toBe('')
      }
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

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
            kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
          }
        },
      }),
    ).resolves.toMatchObject({stage: 'complete'})

    expect(new TextDecoder().decode(chunks[0])).toBe(new TextDecoder().decode(encodeRemotePayload(fixture)))
    expect(closed).toBe(true)
    expect(spawnEnv).toBe(localEnv)
  })

  it('emits the transaction-start stage once and begins the locked body at lock acquisition', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-stage-boundary-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot),
        encodeRemotePayload(fixture),
      )
      const lines = result.stdout.trim().split('\n')
      const transactionStarts = lines.filter(line => line === 'stage=remote-transaction-started')
      const lockAcquiredIndex = lines.indexOf('stage=lock-acquired')

      expect(result.exitCode, result.stderr).toBe(0)
      expect(transactionStarts).toHaveLength(1)
      expect(lockAcquiredIndex).toBeGreaterThan(0)
      expect(lines[lockAcquiredIndex - 1]).toBe('stage=remote-transaction-started')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('maps remote exit 124 to a deterministic transaction timeout', async () => {
    const text = new TextEncoder()

    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=image-acquisition\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
          exited: Promise.resolve(124),
          kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
        }),
      }),
    ).rejects.toMatchObject({
      stage: 'image-acquisition',
      exitCode: 124,
      reason: expect.stringContaining('transaction timeout'),
    })
  })

  it('kills and returns when the caller watchdog sees a never-settling process', async () => {
    const signals: string[] = []
    const timers = new ManualTimers()
    const never = new Promise<number>(() => {})
    const outcomePromise = runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      callerWatchdogMs: REMOTE_CALLER_WATCHDOG_SECONDS * 1000 + 1,
      callerKillGraceMs: 10,
      callerReapGraceMs: 10,
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        stdin: {
          write: (_data: Uint8Array) => new Promise<void>(() => {}),
          end: () => new Promise<void>(() => {}),
        },
        exited: never,
        kill: (signal: 'SIGTERM' | 'SIGKILL') => signals.push(signal),
      }),
    }).then(
      () => 'resolved' as const,
      error => error,
    )

    await Bun.sleep(0)
    timers.fireNext()
    await Bun.sleep(0)
    timers.fireNext()
    await Bun.sleep(0)
    timers.fireNext()
    const outcome = await outcomePromise

    expect(outcome).not.toBe('timed out')
    expect(outcome).toBeInstanceOf(RemoteTransactionError)
    expect(outcome).toMatchObject({stage: 'starting', reason: expect.stringContaining('caller watchdog timeout')})
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('settles cancelled output readers before returning caller timeout', async () => {
    const timers = new ManualTimers()
    let stdoutCancelled = false
    let stderrCancelled = false
    const pendingStream = (onCancel: () => void): ReadableStream<Uint8Array> =>
      new ReadableStream({
        cancel() {
          onCancel()
        },
      })
    const outcomePromise = runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      callerWatchdogMs: REMOTE_CALLER_WATCHDOG_SECONDS * 1000 + 1,
      callerKillGraceMs: 5,
      callerReapGraceMs: 5,
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      spawn: () => ({
        stdout: pendingStream(() => {
          stdoutCancelled = true
        }),
        stderr: pendingStream(() => {
          stderrCancelled = true
        }),
        stdin: {
          write: (_data: Uint8Array) => new Promise<void>(() => {}),
          end: () => new Promise<void>(() => {}),
        },
        exited: new Promise<number>(() => {}),
        kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
      }),
    }).then(
      () => 'resolved' as const,
      error => error,
    )

    await Bun.sleep(0)
    timers.fireNext()
    await Bun.sleep(0)
    timers.fireNext()
    await Bun.sleep(0)
    timers.fireNext()
    const outcome = await outcomePromise

    expect(outcome).toBeInstanceOf(RemoteTransactionError)
    expect(stdoutCancelled).toBe(true)
    expect(stderrCancelled).toBe(true)
  })

  it('lets process exit win over a watchdog while output readers finish draining', async () => {
    const timers = new ManualTimers()
    let releaseStdout: (() => void) | undefined
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stage=complete\n'))
        releaseStdout = () => controller.close()
      },
    })

    const resultPromise = runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      callerWatchdogMs: REMOTE_CALLER_WATCHDOG_SECONDS * 1000 + 1,
      callerKillGraceMs: 10,
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      spawn: () => ({
        stdout,
        stderr: new ReadableStream<Uint8Array>({start: controller => controller.close()}),
        stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
        exited: Promise.resolve(0),
        kill: () => {
          throw new Error('watchdog must be cancelled after process exit')
        },
      }),
    })

    await Bun.sleep(0)
    expect(() => timers.fireNext()).toThrow('No scheduled timer')
    await Bun.sleep(25)
    releaseStdout?.()

    await expect(resultPromise).resolves.toMatchObject({stage: 'complete'})
    expect(timers.size).toBe(0)
  })

  it('waits for a post-KILL process reap before returning timeout', async () => {
    const signals: string[] = []
    const timers = new ManualTimers()
    let resolveExit: ((exitCode: number) => void) | undefined
    const exited = new Promise<number>(resolve => {
      resolveExit = resolve
    })

    const outcomePromise = runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      callerWatchdogMs: REMOTE_CALLER_WATCHDOG_SECONDS * 1000 + 1,
      callerKillGraceMs: 5,
      callerReapGraceMs: 5,
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        stdin: {
          write: (_data: Uint8Array) => new Promise<void>(() => {}),
          end: () => new Promise<void>(() => {}),
        },
        exited,
        kill: (signal: 'SIGTERM' | 'SIGKILL') => {
          signals.push(signal)
        },
      }),
    })
    let outcomeSettled = false
    outcomePromise.then(
      () => {
        outcomeSettled = true
      },
      () => {
        outcomeSettled = true
      },
    )

    await Bun.sleep(0)
    timers.fireNext()
    await Bun.sleep(0)
    timers.fireNext()
    await Bun.sleep(0)
    expect(outcomeSettled).toBe(false)
    resolveExit?.(137)
    const outcome = await outcomePromise.then(
      () => 'resolved' as const,
      error => error,
    )

    expect(outcome).toBeInstanceOf(RemoteTransactionError)
    expect(outcome).toMatchObject({failureCode: 'transaction-timeout'})
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('rejects invalid caller deadline ordering before spawning SSH', async () => {
    let spawned = false

    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        callerWatchdogMs: 100,
        spawn: () => {
          spawned = true
          throw new Error('spawned')
        },
      }),
    ).rejects.toThrow('caller watchdog')

    expect(spawned).toBe(false)
  })

  it('creates an absent runtime root before opening the lock', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-root-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode, result.stderr).toBe(0)
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
      expect(result.exitCode, result.stderr).toBe(0)
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

      expect(result.exitCode, result.stderr).toBe(0)
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

  it('emits post-convergence storage, active-state, persistent-mount, and prior-image evidence before completion', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-post-convergence-evidence-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const priorDigest = `sha256:${'b'.repeat(64)}`
    const priorRepoDigest = `ghcr.io/fro-bot/dashboard@${priorDigest}`
    const oldCompose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:previous@${priorDigest}\n`

    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(join(dashboardRoot, 'docker-compose.yaml'), oldCompose)

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          runningDashboardImageDigest: priorDigest,
          runningDashboardRepoDigests: [priorRepoDigest],
          runningDashboardRepoDigestsAfterConvergence: [DASHBOARD_REPO_DIGEST],
          imageRepoDigests: {
            [CADDY_REPO_DIGEST]: [CADDY_REPO_DIGEST],
            [DASHBOARD_REPO_DIGEST]: [DASHBOARD_REPO_DIGEST],
            [priorRepoDigest]: [priorRepoDigest],
          },
          imageRepoDigestsAfterConvergence: {
            [CADDY_REPO_DIGEST]: [CADDY_REPO_DIGEST],
            [DASHBOARD_REPO_DIGEST]: [DASHBOARD_REPO_DIGEST],
            [priorRepoDigest]: [priorRepoDigest],
          },
        }),
        encodeRemotePayload(fixture),
      )
      const lines = result.stdout.trim().split('\n')
      const convergedIndex = lines.indexOf('stage=runtime-converged')
      const evidenceIndex = lines.indexOf('stage=post-convergence-evidence')
      const completeIndex = lines.indexOf('stage=complete')

      expect(result.exitCode, result.stderr).toBe(0)
      expect(convergedIndex).toBeGreaterThan(-1)
      expect(evidenceIndex).toBeGreaterThan(convergedIndex)
      expect(completeIndex).toBeGreaterThan(evidenceIndex)
      expect(result.stdout).toContain('evidence=storage:post-convergence:')
      expect(result.stdout).toContain('evidence=capacity:post-convergence:free-bytes=8589934592')
      expect(result.stdout).toContain('evidence=docker-df:post-convergence:')
      expect(result.stdout).toContain('evidence=container-inventory:post-convergence:count=1')
      expect(result.stdout).toContain(
        `evidence=active-compose:post-convergence:ref=${DASHBOARD_IMAGE};digest=${fixture.expectedDashboardDigest}`,
      )
      expect(result.stdout).toContain(
        `evidence=running-dashboard:post-convergence:digest=${fixture.expectedDashboardDigest};health=healthy`,
      )
      expect(result.stdout).toContain(
        'evidence=persistent-state:dashboard-data=/data,bind,writable,canonical,uidgid=1000:1000,mode=0700;caddy-data=/data,volume,writable,labels=dashboard/caddy_data;caddy-config=/config,volume,writable,labels=dashboard/caddy_config',
      )
      expect(result.stdout).toContain(
        `evidence=prior-dashboard:post-convergence:digest=${priorDigest};local-inspectable=true`,
      )
      expect(result.stdout).not.toContain('abcdef123456')
      expect(result.stdout).not.toContain('dashboard_caddy_data')
      expect(result.stdout).not.toContain('dashboard_caddy_config')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('fails below the free-space floor after convergence and never completes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-post-convergence-low-space-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
          postConvergenceFreeBytes: 6 * 1024 ** 3 - 1,
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('stage=runtime-converged')
      expect(result.stdout).toContain('stage=post-convergence-evidence')
      expect(result.stdout).toContain('evidence=capacity:post-convergence:free-bytes=6442450943')
      expect(result.stdout).toContain('failure=low-headroom')
      expect(result.stdout).not.toContain('stage=complete')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('fails closed when persistent dashboard or Caddy mounts are missing, wrong, or read-only', async () => {
    const cases: readonly [string, (root: string, runtimeRoot: string) => ShellHarnessOptions][] = [
      ['missing dashboard data mount', () => ({dashboardMounts: []})],
      [
        'wrong dashboard data mount',
        (root, _runtimeRoot) => ({
          dashboardMounts: [{type: 'bind', source: join(root, 'wrong-data'), destination: '/data', rw: true}],
        }),
      ],
      [
        'read-only dashboard data mount',
        (_root, runtimeRoot) => ({
          dashboardMounts: [{type: 'bind', source: `${runtimeRoot}-dashboard/data`, destination: '/data', rw: false}],
        }),
      ],
      [
        'missing Caddy data mount',
        () => ({caddyMounts: [{type: 'volume', name: 'dashboard_caddy_config', destination: '/config', rw: true}]}),
      ],
      [
        'missing Caddy config mount',
        () => ({caddyMounts: [{type: 'volume', name: 'dashboard_caddy_data', destination: '/data', rw: true}]}),
      ],
      [
        'read-only Caddy data mount',
        () => ({
          caddyMounts: [
            {type: 'volume', name: 'dashboard_caddy_data', destination: '/data', rw: false},
            {type: 'volume', name: 'dashboard_caddy_config', destination: '/config', rw: true},
          ],
        }),
      ],
      [
        'read-only Caddy config mount',
        () => ({
          caddyMounts: [
            {type: 'volume', name: 'dashboard_caddy_data', destination: '/data', rw: true},
            {type: 'volume', name: 'dashboard_caddy_config', destination: '/config', rw: false},
          ],
        }),
      ],
    ]

    for (const [name, makeOptions] of cases) {
      const parent = mkdtempSync(join(tmpdir(), `dashboard-deploy-persistent-state-${name.replaceAll(' ', '-')}-`))
      const root = realpathSync(parent)
      const runtimeRoot = join(root, 'dashboard-deploy')
      try {
        const result = await runShellProgram(
          adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, makeOptions(root, runtimeRoot)),
          encodeRemotePayload(fixture),
        )

        expect(result.exitCode, name).not.toBe(0)
        expect(result.stdout, name).toContain('stage=post-convergence-evidence')
        expect(result.stdout, name).not.toContain('stage=complete')
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
    }
  })

  it('fails closed when Caddy volume project or Compose volume labels are wrong', async () => {
    const cases = [
      {
        name: 'wrong project label',
        labels: {
          dashboard_caddy_data: {project: 'other', composeVolume: 'caddy_data'},
          dashboard_caddy_config: {project: 'dashboard', composeVolume: 'caddy_config'},
        },
      },
      {
        name: 'wrong data volume label',
        labels: {
          dashboard_caddy_data: {project: 'dashboard', composeVolume: 'other_data'},
          dashboard_caddy_config: {project: 'dashboard', composeVolume: 'caddy_config'},
        },
      },
      {
        name: 'wrong config volume label',
        labels: {
          dashboard_caddy_data: {project: 'dashboard', composeVolume: 'caddy_data'},
          dashboard_caddy_config: {project: 'dashboard', composeVolume: 'other_config'},
        },
      },
    ] as const

    for (const testCase of cases) {
      const parent = mkdtempSync(
        join(tmpdir(), `dashboard-deploy-volume-labels-${testCase.name.replaceAll(' ', '-')}-`),
      )
      const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
      try {
        const result = await runShellProgram(
          adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
            caddyVolumeLabels: testCase.labels,
          }),
          encodeRemotePayload(fixture),
        )

        expect(result.exitCode, testCase.name).not.toBe(0)
        expect(result.stdout, testCase.name).toContain('stage=post-convergence-evidence')
        expect(result.stdout, testCase.name).not.toContain('stage=complete')
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
    }
  })

  it('fails closed when the prior dashboard digest is no longer locally inspectable after replacement', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-prior-image-missing-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const priorDigest = `sha256:${'b'.repeat(64)}`
    const priorRepoDigest = `ghcr.io/fro-bot/dashboard@${priorDigest}`

    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(
      join(dashboardRoot, 'docker-compose.yaml'),
      `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:previous@${priorDigest}\n`,
    )

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          runningDashboardImageDigest: priorDigest,
          runningDashboardRepoDigests: [priorRepoDigest],
          runningDashboardRepoDigestsAfterConvergence: [DASHBOARD_REPO_DIGEST],
          imageRepoDigests: {
            [CADDY_REPO_DIGEST]: [CADDY_REPO_DIGEST],
            [DASHBOARD_REPO_DIGEST]: [DASHBOARD_REPO_DIGEST],
            [priorRepoDigest]: [priorRepoDigest],
          },
          imageRepoDigestsAfterConvergence: {
            [CADDY_REPO_DIGEST]: [CADDY_REPO_DIGEST],
            [DASHBOARD_REPO_DIGEST]: [DASHBOARD_REPO_DIGEST],
          },
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('stage=post-convergence-evidence')
      expect(result.stdout).toContain('failure=convergence-failed')
      expect(result.stdout).not.toContain('stage=complete')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('allows the same-target prior dashboard image and proves it remains locally inspectable', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-same-target-image-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`

    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(
      join(dashboardRoot, 'docker-compose.yaml'),
      `services:\n  dashboard:\n    image: ${DASHBOARD_IMAGE}\n`,
    )

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          runningDashboardIds: ['abcdef123456'],
          runningDashboardRepoDigests: [DASHBOARD_REPO_DIGEST],
          runningDashboardRepoDigestsAfterConvergence: [DASHBOARD_REPO_DIGEST],
        }),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain(
        `evidence=prior-dashboard:post-convergence:digest=${fixture.expectedDashboardDigest};local-inspectable=true`,
      )
      expect(result.stdout).toContain('stage=complete')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('allowlists only exact post-convergence evidence shapes and filters malformed variants', async () => {
    const digest = `sha256:${'b'.repeat(64)}`
    const text = new TextEncoder()
    const validPersistentState =
      'evidence=persistent-state:dashboard-data=/data,bind,writable,canonical,uidgid=1000:1000,mode=0700;caddy-data=/data,volume,writable,labels=dashboard/caddy_data;caddy-config=/config,volume,writable,labels=dashboard/caddy_config'
    const validLines = [
      'stage=post-convergence-evidence',
      'evidence=storage:post-convergence:probe=/var/lib/docker;mount=/;source=/dev/vda1;fstype=ext4;free-bytes=6442450944',
      'evidence=docker-df:post-convergence:type=Images;count=2;active=1;size-bytes=1000;reclaimable-bytes=0',
      'evidence=container-inventory:post-convergence:count=1',
      `evidence=protected-image:post-convergence:ref=ghcr.io/fro-bot/dashboard@${digest};count=1`,
      `evidence=active-compose:post-convergence:ref=${DASHBOARD_IMAGE.replace(fixture.expectedDashboardDigest, digest)};digest=${digest}`,
      `evidence=running-dashboard:post-convergence:digest=${digest};health=healthy`,
      'evidence=capacity:post-convergence:free-bytes=6442450944',
      validPersistentState,
      `evidence=prior-dashboard:post-convergence:digest=${digest};local-inspectable=true`,
      'stage=complete',
    ]
    const malformedLines = [
      `${validPersistentState};raw-id=abcdef123456`,
      'evidence=capacity:post-convergence:free-bytes=not-a-number',
      `evidence=prior-dashboard:post-convergence:digest=${digest};local-inspectable=false;leak=secret`,
    ]

    const result = await runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(text.encode(`${validLines.join('\n')}\n${malformedLines.join('\n')}\n`))
            controller.close()
          },
        }),
        stderr: new ReadableStream<Uint8Array>({start: controller => controller.close()}),
        stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
        exited: Promise.resolve(0),
        kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
      }),
    })

    for (const line of validLines) expect(result.evidence).toContain(line)
    for (const line of malformedLines) expect(result.evidence).not.toContain(line)
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

  it('self-heals when Compose is present but no dashboard runtime exists and reports no replaced prior image', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-compose-without-runtime-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const dockerLogPath = join(root, 'docker.log')

    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(
      join(dashboardRoot, 'docker-compose.yaml'),
      `services:\n  dashboard:\n    image: ${DASHBOARD_IMAGE}\n`,
    )

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
          runningDashboardIds: [],
          runningDashboardContainers: [{id: 'abcdef654321', project: 'dashboard', service: 'worker'}],
          dockerCommandLogPath: dockerLogPath,
        }),
        encodeRemotePayload(fixture),
      )
      const dockerLog = readFileSync(dockerLogPath, 'utf8')

      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain(
        `evidence=active-compose:baseline:ref=${DASHBOARD_IMAGE};digest=${fixture.expectedDashboardDigest}`,
      )
      expect(result.stdout).toContain('evidence=running-dashboard:baseline:absent')
      expect(result.stdout).toContain(
        `evidence=active-compose:post-convergence:ref=${DASHBOARD_IMAGE};digest=${fixture.expectedDashboardDigest}`,
      )
      expect(result.stdout).toContain(
        `evidence=running-dashboard:post-convergence:digest=${fixture.expectedDashboardDigest};health=healthy`,
      )
      expect(result.stdout).toContain('evidence=prior-dashboard:post-convergence:absent')
      expect(result.stdout).toContain('stage=complete')
      expect(result.stdout).not.toContain('abcdef654321')
      expect(dockerLog).toContain(
        'ps --no-trunc --filter label=com.docker.compose.project=dashboard --filter label=com.docker.compose.service=dashboard',
      )
      expect(dockerLog).toContain(
        'ps --no-trunc --filter label=com.docker.compose.project=dashboard --filter label=com.docker.compose.service=caddy',
      )
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('requires exactly one expected dashboard RepoDigest while allowing valid aliases', async () => {
    const otherDigest = `sha256:${'e'.repeat(64)}`
    const cases = [
      {
        name: 'expected plus alias',
        expectedExitCode: 0,
        repoDigests: [DASHBOARD_REPO_DIGEST, `dashboard@${otherDigest}`],
      },
      {name: 'zero expected', expectedExitCode: 1, repoDigests: [`dashboard@${otherDigest}`]},
      {
        name: 'duplicate expected',
        expectedExitCode: 1,
        repoDigests: [DASHBOARD_REPO_DIGEST, DASHBOARD_REPO_DIGEST],
      },
      {name: 'malformed entry', expectedExitCode: 1, repoDigests: [DASHBOARD_REPO_DIGEST, 'not-a-repo-digest']},
    ] as const

    for (const testCase of cases) {
      const parent = mkdtempSync(
        join(tmpdir(), `dashboard-deploy-baseline-repodigests-${testCase.name.replaceAll(' ', '-')}-`),
      )
      const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
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
            runningDashboardIds: ['abcdef123456'],
            runningDashboardRepoDigests: testCase.repoDigests,
          }),
          encodeRemotePayload(fixture),
        )
        expect(result.exitCode, testCase.name).toBe(testCase.expectedExitCode)
        expect(result.stdout, testCase.name).toContain('stage=baseline-evidence')
        if (testCase.expectedExitCode !== 0)
          expect(result.stdout, testCase.name).not.toContain('stage=active-state-written')
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
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

  it('reports an interrupted stubbed transaction without stale-lock cleanup', async () => {
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
    const program = adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {stubFlockExitCode: 75})

    try {
      const result = await runShellProgram(program, encodeRemotePayload(fixture))

      expect(result.exitCode).toBe(75)
      expect(result.stdout).toBe('stage=remote-transaction-started\nstage=lock-contention\nfailure=lock-contention\n')
      expect(result.stdout).not.toContain('baseline-evidence')
      expect(result.stdout).not.toContain('prune')
      expect(existsSync(dashboardRoot)).toBe(false)
      expect(readdirSync(runtimeRoot).filter(name => name.startsWith('attempt.'))).toEqual([])
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('runs the harness transaction with the host platform stat conventions', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-harness-stat-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain('stage=complete')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  const flockAvailabilityCommand =
    "command -v flock >/dev/null && flock --help 2>&1 | grep -q -- '--conflict-exit-code'"
  const hasUtilLinuxFlock = Bun.spawnSync(['sh', '-c', flockAvailabilityCommand]).exitCode === 0

  it.skipIf(!hasUtilLinuxFlock)('uses the real kernel flock lifecycle and releases it on owner death', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-real-flock-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    const program = adaptProgramForUnprivilegedHarness(runtimeRoot, `${runtimeRoot}-dashboard`, {
      stubFlock: false,
      emitTestChildPid: true,
    })
    const shortenedProgram = replaceRequired(program, 'flock -w 180', 'flock -w 1')
    const first = Bun.spawn(['bash', '-c', shortenedProgram], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'})
    await first.stdin.write(new TextEncoder().encode('dashboard-deploy-payload v2\n'))
    const firstReader = first.stdout.getReader()
    const firstDecoder = new TextDecoder()
    const firstStderrPromise = new Response(first.stderr).text()
    let firstOutput = ''
    let ownerPid: number | undefined
    const signalOwner = (signal: 'TERM' | 'KILL' | '0', pid: number): number =>
      Bun.spawnSync(['sh', '-c', `kill -${signal} "$1"`, 'dashboard-flock-test', String(pid)]).exitCode

    try {
      while (!firstOutput.includes('stage=lock-acquired\n') || ownerPid === undefined) {
        const next = await firstReader.read()
        if (next.done)
          throw new Error(`lock owner exited before acquisition: ${firstOutput}\nstderr=${await firstStderrPromise}`)
        firstOutput += firstDecoder.decode(next.value, {stream: true})
        const pidMatch = /test-child-pid=(\d+)/.exec(firstOutput)
        if (pidMatch) ownerPid = Number(pidMatch[1])
      }

      const lockPath = join(runtimeRoot, 'lock')
      const lockInode = statSync(lockPath).ino
      const contention = await runShellProgram(shortenedProgram, encodeRemotePayload(fixture))
      expect(contention.exitCode).toBe(75)
      expect(contention.stdout).toContain('stage=lock-contention')
      expect(contention.stdout).not.toContain('payload-decoded')
      expect(contention.stdout).not.toContain('baseline-evidence')

      const acquiredPid = ownerPid
      expect(acquiredPid).toBeDefined()
      if (acquiredPid === undefined) throw new Error('lock owner PID marker was not captured')
      expect(signalOwner('TERM', acquiredPid)).toBe(0)
      expect(await first.exited).not.toBe(0)
      while (!(await firstReader.read()).done) {
        // Drain the wrapper after terminating its lock-owning child.
      }
      firstReader.releaseLock()

      const retry = await runShellProgram(shortenedProgram, encodeRemotePayload(fixture))
      expect(retry.exitCode).toBe(0)
      expect(retry.stdout).toContain('stage=complete')
      expect(statSync(lockPath).ino).toBe(lockInode)
      expect(existsSync(lockPath)).toBe(true)
      expect(readdirSync(runtimeRoot).filter(name => name.startsWith('attempt.'))).toEqual([])
    } finally {
      if (ownerPid !== undefined && signalOwner('0', ownerPid) === 0) {
        signalOwner('KILL', ownerPid)
      }
      if (first.exited) await first.exited
      try {
        firstReader.releaseLock()
      } catch {
        // The reader was already released after the wrapper drained.
      }
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
      expect(result.stdout).toBe('stage=remote-transaction-started\nfailure=unsafe-path\n')
      expect(result.stderr).toContain('runtime root ownership or mode is unsafe')
      expect(readdirSync(runtimeRoot)).toEqual([])
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('rejects malformed shell payloads before decode, baseline, or mutation and cleans staging', async () => {
    const cases: readonly [string, Uint8Array][] = [
      ['malformed header', new TextEncoder().encode('not-dashboard-payload\n')],
      ['truncated field body', new TextEncoder().encode(`dashboard-deploy-payload v2\nfield env 10\nshort\nend\n`)],
      ['trailing bytes', concatBytes(encodeRemotePayload(fixture), new TextEncoder().encode('trailing'))],
    ]

    for (const [name, payload] of cases) {
      const parent = mkdtempSync(join(tmpdir(), `dashboard-deploy-malformed-${name.replaceAll(' ', '-')}-`))
      const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
      const dashboardRoot = `${runtimeRoot}-dashboard`

      try {
        const result = await runShellProgram(adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot), payload)
        expect(result.exitCode, name).not.toBe(0)
        expect(result.stdout, name).not.toContain('stage=payload-decoded')
        expect(result.stdout, name).not.toContain('stage=baseline-evidence')
        expect(result.stdout, name).not.toContain('stage=prune-started')
        expect(result.stdout, name).not.toContain('stage=active-state-mutation')
        expect(existsSync(dashboardRoot), name).toBe(false)
        expect(
          readdirSync(runtimeRoot).filter(entry => entry.startsWith('attempt.')),
          name,
        ).toEqual([])
      } finally {
        rmSync(parent, {recursive: true, force: true})
      }
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
      kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
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
      kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
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
          kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
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
          kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
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
          kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
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
          kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
        }),
      }),
    ).rejects.toMatchObject({stage: 'lock-contention', exitCode: 75})
  })

  it('surfaces only strict allowlisted remote failure codes', async () => {
    const cases = [
      ['storage-evidence-malformed', 'baseline-evidence'],
      ['prune-failed', 'prune-started'],
      ['low-headroom', 'post-prune-capacity'],
      ['acquisition-mismatch', 'image-acquisition'],
      ['unsafe-path', 'active-state-mutation'],
      ['convergence-failed', 'runtime-converged'],
    ] as const

    for (const [failureCode, stage] of cases) {
      await expect(
        runRemoteTransaction({
          host: 'dashboard.example',
          payload: fixture,
          env: localEnv,
          spawn: () => ({
            stdout: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`stage=${stage}\nfailure=${failureCode}\n`))
                controller.close()
              },
            }),
            stderr: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('human-safe diagnostic'))
                controller.close()
              },
            }),
            stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
            exited: Promise.resolve(1),
            kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
          }),
        }),
      ).rejects.toMatchObject({stage, failureCode, reason: expect.stringContaining(failureCode)})
    }
  })

  it('drops unknown failure lines and never leaks secret-like stderr', async () => {
    const secret = 'oauth-secret\n-----BEGIN PRIVATE KEY-----'
    const outcome = await runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`stage=payload-decoded\nfailure=bad ${secret}\n`))
            controller.close()
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(secret))
            controller.close()
          },
        }),
        stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
        exited: Promise.resolve(1),
        kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
      }),
    }).then(
      () => 'resolved' as const,
      error => error,
    )

    expect(outcome).toBeInstanceOf(RemoteTransactionError)
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain('bad ')
    expect(serialized).not.toContain('oauth-secret')
    expect(serialized).not.toContain('BEGIN PRIVATE KEY')
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
          kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
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
          kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
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
        kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
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

describe('staged image acquisition and publication ordering', () => {
  it('pulls and exactly verifies every staged service image before publishing Compose last', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-staged-pull-'))
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
      const harnessProgram = adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {
        composeCommandLogPath: composeLogPath,
        pruneLogPath,
        imageRepoDigests: {},
      })
      const result = await runShellProgram(harnessProgram, encodeRemotePayload(fixture))

      expect(result.exitCode, result.stderr).toBe(0)
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

  it('skips registry pull when every staged canonical digest is already cached', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-cache-first-'))
    const root = realpathSync(parent)
    const runtimeRoot = join(root, 'dashboard-deploy')
    const dashboardRoot = `${runtimeRoot}-dashboard`
    const composeLogPath = join(root, 'compose.log')
    mkdirSync(join(dashboardRoot, 'config'), {recursive: true})
    mkdirSync(join(dashboardRoot, 'data'), {recursive: true})
    writeFileSync(
      join(dashboardRoot, 'docker-compose.yaml'),
      `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:old@${fixture.expectedDashboardDigest}\n`,
    )

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot, dashboardRoot, {composeCommandLogPath: composeLogPath}),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('evidence=acquisition:mode=cache')
      expect(result.stdout).not.toContain('evidence=acquisition:mode=pull')
      expect(readFileSync(composeLogPath, 'utf8')).not.toContain(' pull')
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('rejects a tag-only staged image before active-state mutation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-tag-only-'))
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
      const parent = mkdtempSync(join(tmpdir(), `dashboard-deploy-image-case-${testCase.name}-`))
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
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-cache-fallback-'))
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
          imageRepoDigests: {},
          imageRepoDigestsAfterPull: {
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
            imageRepoDigestsAfterPull: {
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
          imageRepoDigestsAfterPull: {
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
          imageRepoDigestsAfterPull: {
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
