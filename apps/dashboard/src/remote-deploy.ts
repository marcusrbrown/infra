const textEncoder = new TextEncoder()

const PAYLOAD_HEADER = 'dashboard-deploy-payload v1\n'
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
  'readonly MAX_TOTAL_BYTES=786432',
  'readonly MAX_ENV_BYTES=65536',
  'readonly MAX_COMPOSE_BYTES=524288',
  'readonly MAX_CADDYFILE_BYTES=65536',
  'readonly MAX_GITHUB_APP_KEY_BYTES=131072',
  'stage=""',
  String.raw`fail() { printf "%s\n" "$1" >&2; exit 1; }`,
  'cleanup() { if [ -n "$stage" ] && [ -d "$stage" ] && [ ! -L "$stage" ]; then rm -rf -- "$stage"; fi; }',
  'trap cleanup EXIT HUP INT TERM',
  String.raw`printf "%s\n" "stage=remote-transaction-started"`,
  'if [ -L "$RUNTIME_ROOT" ] || { [ -e "$RUNTIME_ROOT" ] && [ ! -d "$RUNTIME_ROOT" ]; }; then fail "runtime root is unsafe"; fi',
  'if [ ! -e "$RUNTIME_ROOT" ]; then install -d -m 0700 -o 0 -g 0 "$RUNTIME_ROOT" || fail "runtime root creation failed"; fi',
  '[ -d "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ] || fail "runtime root is not a directory"',
  '[ "$(realpath -e -- "$RUNTIME_ROOT")" = "$RUNTIME_ROOT" ] || fail "runtime root is not canonical"',
  'root_stat="$(stat -c "%u:%g:%a:%F" -- "$RUNTIME_ROOT")" || fail "runtime root stat failed"',
  '[ "$root_stat" = "0:0:700:directory" ] || fail "runtime root ownership or mode is unsafe"',
  'if [ -L "$LOCK_PATH" ] || { [ -e "$LOCK_PATH" ] && [ ! -f "$LOCK_PATH" ]; }; then fail "lock path is not a regular file"; fi',
  'if [ ! -e "$LOCK_PATH" ]; then install -m 0600 -o 0 -g 0 /dev/null "$LOCK_PATH" || fail "lock path creation failed"; fi',
  '[ -f "$LOCK_PATH" ] && [ ! -L "$LOCK_PATH" ] || fail "lock path is not a regular file"',
  'lock_stat="$(stat -c "%u:%g:%a:%F" -- "$LOCK_PATH")" || fail "lock path stat failed"',
  '[ "$lock_stat" = "0:0:600:regular file" ] || fail "lock path ownership or mode is unsafe"',
  'exec 9>"$LOCK_PATH" || fail "lock descriptor failed"',
  String.raw`if ! flock -w 180 9; then printf "%s\n" "stage=lock-contention"; exit 75; fi`,
  String.raw`printf "%s\n" "stage=lock-acquired"`,
  'stage="$(mktemp -d -- "$RUNTIME_ROOT/attempt.XXXXXX")" || fail "staging directory creation failed"',
  'chown 0:0 "$stage" || fail "staging directory ownership failed"',
  'chmod 0700 "$stage" || fail "staging directory mode failed"',
  '[ "$(realpath -e -- "$stage")" = "$stage" ] || fail "staging directory is not canonical"',
  'read_line() { IFS= read -r line || fail "malformed payload"; }',
  'read_line',
  '[ "$line" = "dashboard-deploy-payload v1" ] || fail "unsupported payload protocol"',
  'payload_bytes=0',
  'seen_env=0; seen_compose=0; seen_caddyfile=0; seen_github_app_key=0',
  'for field_number in 1 2 3 4; do',
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
  '    *) fail "unknown payload field" ;;',
  '  esac',
  '  [ "$field_length" -le "$field_limit" ] || fail "payload field exceeds size limit"',
  '  [ "$field_length" -gt 0 ] || fail "empty payload field"',
  '  payload_bytes=$((payload_bytes + field_length))',
  '  [ "$payload_bytes" -le "$MAX_TOTAL_BYTES" ] || fail "payload exceeds total size limit"',
  '  dd of="$target" bs=1 count="$field_length" status=none || fail "payload field read failed"',
  '  actual_size="$(stat -c "%s" -- "$target")" || fail "payload field stat failed"',
  '  [ "$actual_size" = "$field_length" ] || fail "truncated payload field"',
  'done',
  'read_line',
  '[ "$line" = "end" ] || fail "malformed payload terminator"',
  '[ "$seen_env" -eq 1 ] && [ "$seen_compose" -eq 1 ] && [ "$seen_caddyfile" -eq 1 ] && [ "$seen_github_app_key" -eq 1 ] || fail "missing payload field"',
  'remaining_bytes="$(dd bs=1 count=1 status=none | wc -c)"',
  '[ "$remaining_bytes" -eq 0 ] || fail "trailing payload data"',
  String.raw`printf "%s\n" "stage=payload-decoded"`,
  String.raw`printf "%s\n" "stage=complete"`,
].join('\n')

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`
const REMOTE_SSH_PROGRAM = `/usr/bin/env -i PATH=${REMOTE_COMMAND_PATH} HOME=/root DOCKER_CONTEXT=default DOCKER_HOST=unix:///var/run/docker.sock /bin/bash -c ${shellQuote(REMOTE_TRANSACTION_PROGRAM)}`

export const REMOTE_PAYLOAD_PROTOCOL_VERSION = 1 as const

export const REMOTE_PAYLOAD_FIELD_LIMITS = {
  env: 64 * 1024,
  compose: 512 * 1024,
  caddyfile: 64 * 1024,
  github_app_key: 128 * 1024,
} as const

export const REMOTE_PAYLOAD_MAX_BYTES = 786432

export interface RemoteSshCommandOptions {
  host: string
  keyPath?: string
  controlPath?: string
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
  controlPath?: string
}

export type RemoteTransactionStage =
  | 'starting'
  | 'remote-transaction-started'
  | 'lock-contention'
  | 'lock-acquired'
  | 'payload-decoded'
  | 'baseline-evidence'
  | 'post-prune-evidence'
  | 'headroom-verified'
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
    ...(options.controlPath
      ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${options.controlPath}`, '-o', 'ControlPersist=60s']
      : []),
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
  'baseline-evidence',
  'post-prune-evidence',
  'headroom-verified',
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
}

type PayloadField = keyof typeof REMOTE_PAYLOAD_FIELD_LIMITS

const PAYLOAD_FIELDS: readonly [PayloadField, keyof RemoteDeployPayload][] = [
  ['env', 'env'],
  ['compose', 'compose'],
  ['caddyfile', 'caddyfile'],
  ['github_app_key', 'githubAppKey'],
]

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

  return {
    env: values.env as string,
    compose: values.compose as string,
    caddyfile: values.caddyfile as string,
    githubAppKey: values.githubAppKey as string,
  }
}
