const textEncoder = new TextEncoder()

const PAYLOAD_HEADER = 'dashboard-deploy-payload v2\n'
const PAYLOAD_END = 'end\n'

export const REMOTE_RUNTIME_ROOT = '/run/dashboard-deploy' as const
export const REMOTE_LOCK_PATH = `${REMOTE_RUNTIME_ROOT}/lock` as const
export const REMOTE_LOCK_WAIT_SECONDS = 180 as const
export const REMOTE_MIN_FREE_BYTES = 6 * 1024 * 1024 * 1024
export const REMOTE_COMMAND_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' as const

export const REMOTE_TRANSACTION_PROGRAM = [
  'set -euo pipefail',
  'umask 077',
  'readonly RUNTIME_ROOT="/run/dashboard-deploy"',
  'readonly LOCK_PATH="/run/dashboard-deploy/lock"',
  'readonly DASHBOARD_ROOT="/opt/dashboard"',
  'readonly DASHBOARD_CONFIG_DIR="/opt/dashboard/config"',
  'readonly DASHBOARD_DATA_DIR="/opt/dashboard/data"',
  'readonly DASHBOARD_ENV_PATH="/opt/dashboard/.env"',
  'readonly DASHBOARD_COMPOSE_PATH="/opt/dashboard/docker-compose.yaml"',
  'readonly DASHBOARD_CADDYFILE_PATH="/opt/dashboard/config/Caddyfile"',
  'readonly DASHBOARD_APP_KEY_PATH="/opt/dashboard/config/github-app.pem"',
  'readonly DASHBOARD_LEGACY_OVERRIDE_PATH="/opt/dashboard/docker-compose.override.yaml"',
  'readonly MAX_TOTAL_BYTES=786432',
  'readonly MAX_ENV_BYTES=65536',
  'readonly MAX_COMPOSE_BYTES=524288',
  'readonly MAX_CADDYFILE_BYTES=65536',
  'readonly MAX_GITHUB_APP_KEY_BYTES=131072',
  'readonly MAX_EXPECTED_DASHBOARD_DIGEST_BYTES=71',
  'stage=""',
  String.raw`fail() { printf "%s\n" "$1" >&2; exit 1; }`,
  'cleanup() { if [ -n "$stage" ] && [ -d "$stage" ] && [ ! -L "$stage" ]; then rm -rf -- "$stage" >/dev/null 2>&1 || :; fi; }',
  'trap cleanup EXIT',
  'trap "exit 129" HUP',
  'trap "exit 130" INT',
  'trap "exit 143" TERM',
  String.raw`printf "%s\n" "stage=remote-transaction-started"`,
  'if [ -L "$RUNTIME_ROOT" ] || { [ -e "$RUNTIME_ROOT" ] && [ ! -d "$RUNTIME_ROOT" ]; }; then fail "runtime root is unsafe"; fi',
  'if [ ! -e "$RUNTIME_ROOT" ]; then install -d -m 0700 -o 0 -g 0 "$RUNTIME_ROOT" >/dev/null 2>&1 || fail "runtime root creation failed"; fi',
  '[ -d "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ] || fail "runtime root is not a directory"',
  '[ "$(realpath -e -- "$RUNTIME_ROOT" 2>/dev/null)" = "$RUNTIME_ROOT" ] || fail "runtime root is not canonical"',
  'root_stat="$(stat -c "%u:%g:%a:%F" -- "$RUNTIME_ROOT" 2>/dev/null)" || fail "runtime root stat failed"',
  '[ "$root_stat" = "0:0:700:directory" ] || fail "runtime root ownership or mode is unsafe"',
  'if [ -L "$LOCK_PATH" ] || { [ -e "$LOCK_PATH" ] && [ ! -f "$LOCK_PATH" ]; }; then fail "lock path is not a regular file"; fi',
  'if [ ! -e "$LOCK_PATH" ]; then install -m 0600 -o 0 -g 0 /dev/null "$LOCK_PATH" >/dev/null 2>&1 || fail "lock path creation failed"; fi',
  '[ -f "$LOCK_PATH" ] && [ ! -L "$LOCK_PATH" ] || fail "lock path is not a regular file"',
  'lock_stat="$(stat -c "%u:%g:%a:%F" -- "$LOCK_PATH" 2>/dev/null)" || fail "lock path stat failed"',
  '[ "$lock_stat" = "0:0:600:regular file" ] || fail "lock path ownership or mode is unsafe"',
  'exec 9>"$LOCK_PATH" 2>/dev/null || fail "lock descriptor failed"',
  String.raw`if ! flock -w 180 9 >/dev/null 2>&1; then printf "%s\n" "stage=lock-contention"; exit 75; fi`,
  String.raw`printf "%s\n" "stage=lock-acquired"`,
  'stage="$(mktemp -d -- "$RUNTIME_ROOT/attempt.XXXXXX" 2>/dev/null)" || fail "staging directory creation failed"',
  'chown 0:0 "$stage" >/dev/null 2>&1 || fail "staging directory ownership failed"',
  'chmod 0700 "$stage" >/dev/null 2>&1 || fail "staging directory mode failed"',
  '[ "$(realpath -e -- "$stage" 2>/dev/null)" = "$stage" ] || fail "staging directory is not canonical"',
  'read_line() { IFS= read -r line || fail "malformed payload"; }',
  'read_line',
  '[ "$line" = "dashboard-deploy-payload v2" ] || fail "unsupported payload protocol"',
  'payload_bytes=0',
  'seen_env=0; seen_compose=0; seen_caddyfile=0; seen_github_app_key=0; seen_expected_dashboard_digest=0',
  'for field_number in 1 2 3 4 5; do',
  '  read_line',
  '  [ "$line" != "end" ] || fail "missing payload field"',
  '  [[ "$line" =~ ^field[[:space:]]([a-z_]+)[[:space:]]([0-9]+)$ ]] || fail "malformed payload field header"',
  `  field_name="$(printf '%s' "$line" | cut -d' ' -f2)"; field_length="$(printf '%s' "$line" | cut -d' ' -f3)"`,
  '  case "$field_length" in 0|[1-9]*) ;; *) fail "malformed payload field length" ;; esac',
  '  case "$field_name" in',
  '    env) [ "$seen_env" -eq 0 ] || fail "duplicate payload field"; seen_env=1; target="$stage/env"; field_limit="$MAX_ENV_BYTES" ;;',
  '    compose) [ "$seen_compose" -eq 0 ] || fail "duplicate payload field"; seen_compose=1; target="$stage/compose"; field_limit="$MAX_COMPOSE_BYTES" ;;',
  '    caddyfile) [ "$seen_caddyfile" -eq 0 ] || fail "duplicate payload field"; seen_caddyfile=1; target="$stage/caddyfile"; field_limit="$MAX_CADDYFILE_BYTES" ;;',
  '    github_app_key) [ "$seen_github_app_key" -eq 0 ] || fail "duplicate payload field"; seen_github_app_key=1; target="$stage/github-app.pem"; field_limit="$MAX_GITHUB_APP_KEY_BYTES" ;;',
  '    expected_dashboard_digest) [ "$seen_expected_dashboard_digest" -eq 0 ] || fail "duplicate payload field"; seen_expected_dashboard_digest=1; target="$stage/expected-dashboard-digest"; field_limit="$MAX_EXPECTED_DASHBOARD_DIGEST_BYTES" ;;',
  '    *) fail "unknown payload field" ;;',
  '  esac',
  '  [ "$field_length" -le "$field_limit" ] || fail "payload field exceeds size limit"',
  '  [ "$field_length" -gt 0 ] || fail "empty payload field"',
  '  payload_bytes=$((payload_bytes + field_length))',
  '  [ "$payload_bytes" -le "$MAX_TOTAL_BYTES" ] || fail "payload exceeds total size limit"',
  '  dd of="$target" bs=1 count="$field_length" status=none 2>/dev/null || fail "payload field read failed"',
  '  actual_size="$(stat -c "%s" -- "$target" 2>/dev/null)" || fail "payload field stat failed"',
  '  [ "$actual_size" = "$field_length" ] || fail "truncated payload field"',
  'done',
  'read_line',
  '[ "$line" = "end" ] || fail "malformed payload terminator"',
  '[ "$seen_env" -eq 1 ] && [ "$seen_compose" -eq 1 ] && [ "$seen_caddyfile" -eq 1 ] && [ "$seen_github_app_key" -eq 1 ] && [ "$seen_expected_dashboard_digest" -eq 1 ] || fail "missing payload field"',
  'remaining_bytes="$(dd bs=1 count=1 status=none 2>/dev/null | wc -c)"',
  '[ "$remaining_bytes" -eq 0 ] || fail "trailing payload data"',
  String.raw`printf "%s\n" "stage=payload-decoded"`,
  'expected_dashboard_digest="$(cat -- "$stage/expected-dashboard-digest" 2>/dev/null)" || fail "expected dashboard digest read failed"',
  '[[ "$expected_dashboard_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "malformed expected dashboard digest"',
  'if [ -L "$DASHBOARD_ROOT" ] || { [ -e "$DASHBOARD_ROOT" ] && [ ! -d "$DASHBOARD_ROOT" ]; }; then fail "dashboard root is unsafe"; fi',
  'if [ -L "$DASHBOARD_CONFIG_DIR" ] || { [ -e "$DASHBOARD_CONFIG_DIR" ] && [ ! -d "$DASHBOARD_CONFIG_DIR" ]; }; then fail "dashboard config is unsafe"; fi',
  'install -d -m 0755 -o 0 -g 0 "$DASHBOARD_ROOT" >/dev/null 2>&1 || fail "dashboard root creation failed"',
  'install -d -m 0755 -o 0 -g 0 "$DASHBOARD_CONFIG_DIR" >/dev/null 2>&1 || fail "dashboard config creation failed"',
  'chown 0:0 "$DASHBOARD_ROOT" "$DASHBOARD_CONFIG_DIR" >/dev/null 2>&1 || fail "dashboard root ownership failed"',
  '[ "$(realpath -e "$DASHBOARD_ROOT" 2>/dev/null)" = "$DASHBOARD_ROOT" ] || fail "dashboard root is not canonical"',
  '[ "$(realpath -e "$DASHBOARD_CONFIG_DIR" 2>/dev/null)" = "$DASHBOARD_CONFIG_DIR" ] || fail "dashboard config is not canonical"',
  'if [ -L "$DASHBOARD_DATA_DIR" ] || { [ -e "$DASHBOARD_DATA_DIR" ] && [ ! -d "$DASHBOARD_DATA_DIR" ]; }; then fail "dashboard data is unsafe"; fi',
  'install -d -m 0700 -o 1000 -g 1000 "$DASHBOARD_DATA_DIR" >/dev/null 2>&1 || fail "dashboard data creation failed"',
  'chown -R 1000:1000 "$DASHBOARD_DATA_DIR" >/dev/null 2>&1 || fail "dashboard data ownership failed"',
  'chmod 0700 "$DASHBOARD_DATA_DIR" >/dev/null 2>&1 || fail "dashboard data mode failed"',
  '[ -d "$DASHBOARD_DATA_DIR" ] && [ ! -L "$DASHBOARD_DATA_DIR" ] && [ "$(realpath -e "$DASHBOARD_DATA_DIR" 2>/dev/null)" = "$DASHBOARD_DATA_DIR" ] || fail "dashboard data is not canonical"',
  'install -m 0600 -o 0 -g 0 "$stage/env" "$DASHBOARD_ENV_PATH" >/dev/null 2>&1 || fail "environment publication failed"',
  'install -m 0644 -o 0 -g 0 "$stage/compose" "$DASHBOARD_COMPOSE_PATH" >/dev/null 2>&1 || fail "compose publication failed"',
  'install -m 0644 -o 0 -g 0 "$stage/caddyfile" "$DASHBOARD_CADDYFILE_PATH" >/dev/null 2>&1 || fail "Caddyfile publication failed"',
  'install -m 0600 -o 0 -g 0 "$stage/github-app.pem" "$DASHBOARD_APP_KEY_PATH" >/dev/null 2>&1 || fail "GitHub App key publication failed"',
  'chmod 0600 "$DASHBOARD_APP_KEY_PATH" >/dev/null 2>&1 || fail "GitHub App key mode failed"',
  'chown 1000:1000 "$DASHBOARD_APP_KEY_PATH" >/dev/null 2>&1 || fail "GitHub App key ownership failed"',
  'rm -f -- "$DASHBOARD_LEGACY_OVERRIDE_PATH" >/dev/null 2>&1 || fail "legacy override removal failed"',
  String.raw`printf "%s\n" "stage=active-state-written"`,
  'cd "$DASHBOARD_ROOT" || fail "dashboard directory change failed"',
  'printf "%s\n" "stage=image-acquisition"',
  'docker compose pull >/dev/null 2>&1 || fail "compose pull failed"',
  'docker compose up -d --no-build --wait --wait-timeout 120 dashboard >/dev/null 2>&1 || fail "dashboard convergence failed"',
  'dashboard_container_id="$(docker compose ps -q dashboard 2>/dev/null)" || fail "dashboard container lookup failed"',
  '[ -n "$dashboard_container_id" ] || fail "dashboard container is missing"',
  'dashboard_image_sha="$(docker inspect --format \'{{.Image}}\' "$dashboard_container_id" 2>/dev/null)" || fail "dashboard image lookup failed"',
  '[ -n "$dashboard_image_sha" ] || fail "dashboard image identity is missing"',
  'dashboard_repo_digests="$(docker inspect --format \'{{json .RepoDigests}}\' "$dashboard_image_sha" 2>/dev/null)" || fail "dashboard digest lookup failed"',
  'case "$dashboard_repo_digests" in *"$expected_dashboard_digest"*) ;; *) fail "dashboard digest verification failed" ;; esac',
  'docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 caddy >/dev/null 2>&1 || fail "Caddy convergence failed"',
  String.raw`printf "%s\n" "stage=runtime-converged"`,
  String.raw`printf "%s\n" "stage=complete"`,
].join('\n')

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`
const REMOTE_SSH_PROGRAM = `/usr/bin/env -i PATH=${REMOTE_COMMAND_PATH} HOME=/root DOCKER_CONTEXT=default DOCKER_HOST=unix:///var/run/docker.sock /bin/bash -c ${shellQuote(REMOTE_TRANSACTION_PROGRAM)}`

export const REMOTE_PAYLOAD_PROTOCOL_VERSION = 2 as const

export const REMOTE_PAYLOAD_FIELD_LIMITS = {
  env: 64 * 1024,
  compose: 512 * 1024,
  caddyfile: 64 * 1024,
  github_app_key: 128 * 1024,
  expected_dashboard_digest: 71,
} as const

export const REMOTE_PAYLOAD_MAX_BYTES = 786432

export interface RemoteSshCommandOptions {
  host: string
  keyPath?: string
}

export interface RemoteProcess {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin?: {
    write: (data: Uint8Array) => void | Promise<void>
    end: () => void | Promise<void>
  }
  exited: Promise<number>
}

export interface RemoteSpawnOptions {
  env: Readonly<Record<string, string>>
  stdout: 'pipe'
  stderr: 'pipe'
  stdin: 'pipe'
}

export type RemoteSpawnFn = (command: string[], options: RemoteSpawnOptions) => RemoteProcess

export interface RemoteTransactionOptions {
  host: string
  payload: RemoteDeployPayload
  /** Environment for the local SSH client process; passed through unchanged. */
  env: Readonly<Record<string, string>>
  spawn: RemoteSpawnFn
  keyPath?: string
}

export type RemoteTransactionStage =
  | 'starting'
  | 'remote-transaction-started'
  | 'lock-contention'
  | 'lock-acquired'
  | 'payload-decoded'
  | 'image-acquisition'
  | 'active-state-written'
  | 'runtime-converged'
  | 'complete'

export interface RemoteTransactionResult {
  stage: RemoteTransactionStage
  evidence: readonly string[]
}

export class RemoteTransactionError extends Error {
  readonly stage: RemoteTransactionStage
  readonly exitCode?: number

  constructor(stage: RemoteTransactionStage, reason: string, exitCode?: number) {
    super(`Remote dashboard deploy failed at ${stage}: ${reason}`)
    this.name = 'RemoteTransactionError'
    this.stage = stage
    this.exitCode = exitCode
  }
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/i

export function buildRemoteSshCommand(options: RemoteSshCommandOptions): string[] {
  if (!HOST_RE.test(options.host)) {
    throw new Error('Invalid dashboard deploy host')
  }

  return [
    'ssh',
    ...(options.keyPath ? ['-i', options.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    `root@${options.host}`,
    REMOTE_SSH_PROGRAM,
  ]
}

const settle = async <T>(promise: Promise<T>): Promise<{value?: T; error?: unknown}> => {
  try {
    return {value: await promise}
  } catch (error) {
    return {error}
  }
}

const readOutput = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text()

const ALLOWED_STAGES = new Set<string>([
  'remote-transaction-started',
  'lock-contention',
  'lock-acquired',
  'payload-decoded',
  'image-acquisition',
  'active-state-written',
  'runtime-converged',
  'complete',
])

const stageFromOutput = (stdout: string): RemoteTransactionStage => {
  let stage: RemoteTransactionStage = 'starting'
  for (const line of stdout.split('\n')) {
    const candidate = line.startsWith('stage=') ? line.slice('stage='.length) : ''
    if (ALLOWED_STAGES.has(candidate)) stage = candidate as RemoteTransactionStage
  }
  return stage
}

const isAllowedEvidenceLine = (line: string): boolean => {
  const candidate = line.startsWith('stage=') ? line.slice('stage='.length) : ''
  if (ALLOWED_STAGES.has(candidate)) return true
  if (/^evidence=(?:service|container|mount):[a-z0-9][a-z0-9._/:@-]*$/.test(line)) return true
  if (/^evidence=image:[a-z0-9][a-z0-9._/:@-]*@sha256:[a-f0-9]{64}$/.test(line)) return true
  if (/^evidence=(?:digest|runtime-digest):sha256:[a-f0-9]{64}$/.test(line)) return true
  if (/^evidence=free-bytes:\d+$/.test(line)) return true
  if (
    /^evidence=prune:(?:reclaimed-bytes|eligible-images|protected-containers)=\d+(?:;(?:reclaimed-bytes|eligible-images|protected-containers)=\d+)*$/.test(
      line,
    )
  ) {
    return true
  }
  return /^evidence=health:(?:healthy|unhealthy|unknown)$/.test(line)
}

export async function runRemoteTransaction(options: RemoteTransactionOptions): Promise<RemoteTransactionResult> {
  const payload = encodeRemotePayload(options.payload)
  const command = buildRemoteSshCommand(options)
  const process = options.spawn(command, {env: options.env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe'})
  const stdoutPromise = settle(readOutput(process.stdout))
  const stderrPromise = settle(readOutput(process.stderr))
  const exitPromise = settle(process.exited)

  let inputFailure: 'stdin-write' | 'stdin-close' | 'stdin-missing' | undefined
  const stdin = process.stdin
  if (stdin) {
    const writeResult = await Promise.race([
      (async () => {
        try {
          await stdin.write(payload)
          return {kind: 'write' as const, error: undefined}
        } catch (error) {
          return {kind: 'write' as const, error}
        }
      })(),
      exitPromise.then(result => ({kind: 'exit' as const, result})),
    ])

    if (writeResult.kind === 'exit' || writeResult.error) {
      inputFailure = 'stdin-write'
    }

    if (!inputFailure) {
      const closeResult = await Promise.race([
        (async () => {
          try {
            await stdin.end()
            return {kind: 'close' as const, error: undefined}
          } catch (error) {
            return {kind: 'close' as const, error}
          }
        })(),
        exitPromise.then(result => ({kind: 'exit' as const, result})),
      ])

      if (closeResult.kind === 'exit' || closeResult.error) {
        inputFailure = 'stdin-close'
      }
    }
  } else {
    inputFailure = 'stdin-missing'
  }

  const [stdoutResult, stderrResult, exitResult] = await Promise.all([stdoutPromise, stderrPromise, exitPromise])
  const stdout = stdoutResult.value ?? ''
  const stage = stageFromOutput(stdout)

  const exitCode = exitResult.value
  if (exitCode !== undefined && exitCode !== 0) {
    throw new RemoteTransactionError(stage, 'remote process exited unsuccessfully', exitCode)
  }
  if (inputFailure) {
    throw new RemoteTransactionError(stage, inputFailure)
  }
  if (stdoutResult.error || stderrResult.error) {
    throw new RemoteTransactionError(stage, 'output drain failed')
  }
  if (exitResult.error) {
    throw new RemoteTransactionError(stage, 'remote process did not report an exit status')
  }
  if (stage !== 'complete') {
    throw new RemoteTransactionError(stage, 'completion marker missing', exitCode)
  }

  return {
    stage,
    evidence: stdout.split('\n').filter(isAllowedEvidenceLine),
  }
}

export interface RemoteDeployPayload {
  env: string
  compose: string
  caddyfile: string
  githubAppKey: string
  expectedDashboardDigest: string
}

type PayloadField = keyof typeof REMOTE_PAYLOAD_FIELD_LIMITS

const PAYLOAD_FIELDS: readonly [PayloadField, keyof RemoteDeployPayload][] = [
  ['env', 'env'],
  ['compose', 'compose'],
  ['caddyfile', 'caddyfile'],
  ['github_app_key', 'githubAppKey'],
  ['expected_dashboard_digest', 'expectedDashboardDigest'],
]

const DASHBOARD_DIGEST_RE = /^sha256:[0-9a-f]{64}$/

const decodeUtf8 = (bytes: Uint8Array, context: string): string => {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes)
  } catch {
    throw new Error(`Malformed remote deploy payload: invalid UTF-8 in ${context}`)
  }
}

const assertPayloadField = (field: PayloadField, value: string): Uint8Array => {
  if (value.length === 0) {
    throw new Error(`Malformed remote deploy payload: empty ${field} field`)
  }

  if (value.includes('\0')) {
    throw new Error(`Malformed remote deploy payload: NUL byte in ${field} field`)
  }

  const bytes = textEncoder.encode(value)
  const limit = REMOTE_PAYLOAD_FIELD_LIMITS[field]
  if (bytes.byteLength > limit) {
    throw new Error(`Remote deploy payload ${field} field exceeds its size limit`)
  }

  return bytes
}

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

export function encodeRemotePayload(payload: RemoteDeployPayload): Uint8Array {
  const parts: Uint8Array[] = [textEncoder.encode(PAYLOAD_HEADER)]

  for (const [wireField, payloadField] of PAYLOAD_FIELDS) {
    const value = payload[payloadField]
    if (payloadField === 'expectedDashboardDigest' && !DASHBOARD_DIGEST_RE.test(value)) {
      throw new Error('Malformed remote deploy payload: invalid expected dashboard digest')
    }
    const bytes = assertPayloadField(wireField, value)
    parts.push(textEncoder.encode(`field ${wireField} ${bytes.byteLength}\n`), bytes)
  }

  parts.push(textEncoder.encode(PAYLOAD_END))
  const encoded = concatBytes(parts)
  if (encoded.byteLength > REMOTE_PAYLOAD_MAX_BYTES) {
    throw new Error('Remote deploy payload exceeds its total size limit')
  }

  return encoded
}

class PayloadReader {
  readonly #bytes: Uint8Array
  #offset = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  get offset(): number {
    return this.#offset
  }

  readLine(context: string): string {
    const lineEnd = this.#bytes.indexOf(10, this.#offset)
    if (lineEnd === -1) {
      throw new Error(`Malformed remote deploy payload: missing ${context} terminator`)
    }

    const line = decodeUtf8(this.#bytes.subarray(this.#offset, lineEnd), context)
    this.#offset = lineEnd + 1
    return line
  }

  readBytes(length: number, field: PayloadField): string {
    const end = this.#offset + length
    if (end > this.#bytes.byteLength) {
      throw new Error(`Malformed remote deploy payload: truncated ${field} field`)
    }

    const value = decodeUtf8(this.#bytes.subarray(this.#offset, end), `${field} field`)
    this.#offset = end
    if (value.length === 0) {
      throw new Error(`Malformed remote deploy payload: empty ${field} field`)
    }
    if (value.includes('\0')) {
      throw new Error(`Malformed remote deploy payload: NUL byte in ${field} field`)
    }
    return value
  }
}

export function decodeRemotePayload(encoded: Uint8Array): RemoteDeployPayload {
  if (encoded.byteLength > REMOTE_PAYLOAD_MAX_BYTES) {
    throw new Error('Remote deploy payload exceeds its total size limit')
  }

  const reader = new PayloadReader(encoded)
  if (reader.readLine('protocol header') !== PAYLOAD_HEADER.slice(0, -1)) {
    throw new Error('Malformed remote deploy payload: unsupported protocol version')
  }

  const values: Partial<RemoteDeployPayload> = {}
  const seen = new Set<PayloadField>()

  while (true) {
    const line = reader.readLine('field header')
    if (line === 'end') break

    const match = /^field ([a-z_]+) (\d+)$/.exec(line)
    if (!match) {
      throw new Error('Malformed remote deploy payload: invalid field header')
    }

    const wireField = match[1] as PayloadField
    if (!Object.prototype.hasOwnProperty.call(REMOTE_PAYLOAD_FIELD_LIMITS, wireField)) {
      throw new Error('Malformed remote deploy payload: unknown field')
    }
    if (seen.has(wireField)) {
      throw new Error('Malformed remote deploy payload: duplicate field')
    }

    const lengthText = match[2]
    if (!lengthText) {
      throw new Error('Malformed remote deploy payload: invalid field length')
    }
    if (lengthText !== '0' && lengthText.startsWith('0')) {
      throw new Error('Malformed remote deploy payload: invalid field length')
    }
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length > REMOTE_PAYLOAD_FIELD_LIMITS[wireField]) {
      throw new Error(`Remote deploy payload ${wireField} field exceeds its size limit`)
    }

    seen.add(wireField)
    const payloadField = PAYLOAD_FIELDS.find(([name]) => name === wireField)?.[1]
    if (!payloadField) {
      throw new Error('Malformed remote deploy payload: unknown field')
    }
    values[payloadField] = reader.readBytes(length, wireField)
  }

  if (seen.size !== PAYLOAD_FIELDS.length) {
    throw new Error('Malformed remote deploy payload: missing field')
  }
  if (reader.offset !== encoded.byteLength) {
    throw new Error('Malformed remote deploy payload: trailing data')
  }

  const expectedDashboardDigest = values.expectedDashboardDigest as string
  if (!DASHBOARD_DIGEST_RE.test(expectedDashboardDigest)) {
    throw new Error('Malformed remote deploy payload: invalid expected dashboard digest')
  }

  return {
    env: values.env as string,
    compose: values.compose as string,
    caddyfile: values.caddyfile as string,
    githubAppKey: values.githubAppKey as string,
    expectedDashboardDigest,
  }
}
