import type {ActionCtx} from '../../lib/action-ctx'
import type {SpawnFn} from './remote'

import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'

import {z} from 'zod'

import {resolveTracesHost, resolveTracesOrigin} from './host'
import {defaultSpawn} from './remote'

declare const process: {
  env: Record<string, string | undefined>
}

export const keyOption = z
  .string()
  .optional()
  .describe('Environment variable name holding the SSH host. Falls back to TRACES_HOST, then traces.fro.bot.')

export type Targets = {ok: true; host: string; origin: string} | {ok: false; error: string}

export function resolveTargets(key: string | undefined, needOrigin: boolean): Targets {
  try {
    return {
      ok: true,
      host: resolveTracesHost(process.env, key),
      origin: needOrigin ? resolveTracesOrigin(process.env) : '',
    }
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
}

// ─── Shared by the sender and reader token commands ───────────────────────────
//
// Both lifecycles hold a bearer credential that is generated here, sent to the host on stdin, delivered once and
// proven against the live service. What they share lives here: token and void-line generation, the shell
// fragments both write-then-rename scripts are built from, output that cannot carry a token, the bounded proof
// loop, and delivery to a GitHub Actions secret.

// ─── Token and fingerprint ────────────────────────────────────────────────────

/** A fixed, recognisable prefix so a secret scanner or the redaction gate can match a token. */
export const TOKEN_PREFIX = 'trc_'
export const TOKEN_BYTES = 32
const FINGERPRINT_LENGTH = 12

export type RandomBytes = (length: number) => Uint8Array

const platformRandomBytes: RandomBytes = length => crypto.getRandomValues(new Uint8Array(length))

export function fingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, FINGERPRINT_LENGTH)
}

/**
 * A token file is never empty. A file with no real token holds one void line instead: a token nobody knows. A real
 * token is any non-blank line whose first field does not start with this prefix. A test pins this copy to
 * `apps/traces/src/host.ts`.
 */
export const VOID_TOKEN_PREFIX = 'trc_void_'

/** A draw that starts with the void prefix would be taken for a void line (hidden from `list`, immune to `revoke`). */
const TOKEN_DRAWS = 4

export function generateToken(randomBytes: RandomBytes = platformRandomBytes): {token: string; fingerprint: string} {
  for (let draw = 0; draw < TOKEN_DRAWS; draw += 1) {
    const bytes = randomBytes(TOKEN_BYTES)
    if (bytes.length !== TOKEN_BYTES) throw new Error(`the random source must return ${TOKEN_BYTES} bytes`)
    const token = `${TOKEN_PREFIX}${Buffer.from(bytes).toString('base64url')}`
    // One draw in about a billion. A source stuck on such a draw is an error, not a loop.
    if (!token.startsWith(VOID_TOKEN_PREFIX)) return {token, fingerprint: fingerprintOf(token)}
  }
  throw new Error('the random source kept returning a token that starts with the void prefix')
}

/** A fresh token nobody knows: generated here, sent on stdin, never printed, logged or kept. */
export function generateVoidToken(randomBytes: RandomBytes = platformRandomBytes): string {
  const bytes = randomBytes(TOKEN_BYTES)
  if (bytes.length !== TOKEN_BYTES) throw new Error(`the random source must return ${TOKEN_BYTES} bytes`)
  return `${VOID_TOKEN_PREFIX}${Buffer.from(bytes).toString('base64url')}`
}

/** `<void token> void <date>`: a deny-all file is exactly this one line. */
export function formatVoidLine(voidToken: string, createdAt: string): string {
  return `${voidToken} void ${createdAt}\n`
}

// ─── Shell fragments ──────────────────────────────────────────────────────────

export const script = (...steps: string[]): string => steps.join('; ')

/** Base64url characters in 32 bytes, unpadded. */
const VOID_TOKEN_BODY_LENGTH = Math.ceil((TOKEN_BYTES * 4) / 3)

/**
 * Read the void line from stdin into `vl` and refuse, before the lock is taken or anything is touched, one that is
 * not `<void token> void <date>` with a token of exactly the right shape: a mistake here would be written over a
 * token file. Nothing is printed: the line is a credential nobody is meant to know.
 */
export const READ_VOID_LINE = [
  'read -r vl',
  "vt=$(printf '%s' \"$vl\" | cut -d ' ' -f 1)",
  `case "$vt" in ${VOID_TOKEN_PREFIX}*) ;; *) exit 1 ;; esac`,
  'case "$vt" in *[!A-Za-z0-9_-]*) exit 1 ;; esac',
  `[ "\${#vt}" -eq ${VOID_TOKEN_PREFIX.length + VOID_TOKEN_BODY_LENGTH} ]`,
  'case "$vl" in "$vt void "?*) ;; *) exit 1 ;; esac',
]

/**
 * A lock taken before a file is read or copied and held until the script exits, which is after the rename.
 * Descriptor 9 holds the lock file open and `flock` takes the lock on it, so the lock is released by the shell
 * ending, however it ends. A lock not free in 30 seconds is a failure with its own sentinel and the file untouched.
 * The only thing ever redirected to is the lock file: a regular file under the app directory.
 */
export function lockFlock(lockFile: string, busySentinel: string): string[] {
  return [`l=${lockFile}`, 'exec 9>>"$l"', `flock -w 30 9 || { echo ${busySentinel}; exit 1; }`]
}

/**
 * A temporary file next to the token file (`$d` is its directory), removed again if the script stops before the
 * rename. The only deletion any of these commands does is of that file.
 */
export const TEMP_FILE = ['t=$(mktemp "$d/.token.XXXXXX")', `trap 'rm -f "$t"' EXIT`]

/**
 * Give the temporary file the token file's (`$f`) mode and owner. Where the token file does not exist yet, the
 * temporary file is readable by its group and owned like the directory, which deploy sets up for its reader.
 */
export const COPY_ATTRIBUTES =
  'if [ -f "$f" ]; then cp -p "$f" "$t"; else chmod 0640 "$t"; chown "$(ls -ld "$d" | awk \'{print $3":"$4}\')" "$t"; fi'

/** The host's fingerprint of a token, computed from the token itself and checked to be the right length. */
export const HASH_TOKEN =
  'h=$(printf %s "$tok" | sha256sum | cut -c1-12); case "$h" in ????????????) ;; *) exit 1 ;; esac'

// ─── Output that cannot carry a token ─────────────────────────────────────────

export interface Out {
  log: (message: string) => void
  error: (message: string) => void
}

const TOKEN_SHAPE = new RegExp(String.raw`${TOKEN_PREFIX}[\w-]{20,}`, 'g')

/** Replace every known secret, and anything shaped like a token, so a child's stderr or an error cannot leak it. */
export function scrub(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret !== '') result = result.replaceAll(secret, '[token]')
  }
  return result.replaceAll(TOKEN_SHAPE, '[token]')
}

function scrubbed(ctx: ActionCtx, secrets: readonly string[]): Out {
  return {
    log: message => ctx.console.log(scrub(message, secrets)),
    error: message => ctx.console.error(scrub(message, secrets)),
  }
}

/**
 * Run an action body. Anything it throws becomes a scrubbed error line and a failure. The caller exits after this
 * returns, outside the `try`, because `ctx.process.exit` throws.
 */
export async function guarded(
  ctx: ActionCtx,
  secrets: readonly string[],
  body: (out: Out) => Promise<boolean>,
): Promise<boolean> {
  const out = scrubbed(ctx, secrets)
  try {
    return await body(out)
  } catch (error) {
    out.error(error instanceof Error ? error.message : 'unexpected failure')
    return false
  }
}

// ─── The bounded proof loop ───────────────────────────────────────────────────

/** An HTTP status, or `none` when no answer was had (connection failed, ssh failed, no status line). */
export type ProbeStatus = number | 'none'

export interface ProveDeps {
  sleep?: ((ms: number) => Promise<void>) | undefined
  /** Proof requests before giving up while the service re-reads a file. */
  attempts?: number | undefined
  intervalMs?: number | undefined
}

export const DEFAULT_ATTEMPTS = 10
export const DEFAULT_INTERVAL_MS = 1000

export async function prove(
  probe: () => Promise<ProbeStatus>,
  accept: (status: number) => boolean,
  deps: ProveDeps,
): Promise<{proven: boolean; last: ProbeStatus}> {
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  let last: ProbeStatus = 'none'
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await probe()
    if (last !== 'none' && accept(last)) return {proven: true, last}
    if (attempt < attempts) await sleep(deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  }
  return {proven: false, last}
}

export const isSuccess = (status: number): boolean => status >= 200 && status < 300
export const isRefused = (status: number): boolean => status === 401

export const describeStatus = (status: ProbeStatus): string => (status === 'none' ? 'no answer' : String(status))

// ─── Delivery to a GitHub Actions secret ──────────────────────────────────────

// A repository name may start with a dot (`.github`), but never with a hyphen, and is never `.` or `..`.
export const REPO_SHAPE = /^[A-Z\d][A-Z\d-]*\/(?!\.{1,2}$)[\w.][\w.-]*$/i
export const SECRET_NAME_SHAPE = /^[A-Z_][A-Z\d_]*$/

export const GH_TIMEOUT_MS = 30_000

export function ghEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/** `gh secret set NAME ...` with the token as the whole of stdin. Never an argument. */
export async function setGithubSecret(
  command: string[],
  token: string,
  spawnFn: SpawnFn | undefined,
): Promise<{ok: true} | {ok: false; error: string}> {
  const spawn = spawnFn ?? defaultSpawn
  try {
    const child = spawn(command, {
      env: ghEnvironment(),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: new TextEncoder().encode(token),
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    })
    const [, stderr, exitCode] = await Promise.all([
      child.stdout === null ? Promise.resolve('') : new Response(child.stdout).text(),
      child.stderr === null ? Promise.resolve('') : new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode === 0) return {ok: true}
    return {ok: false, error: `gh exited ${exitCode}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`}
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : 'could not run gh'}
  }
}
