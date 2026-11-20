import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {FetchLike} from './ingest'
import type {SpawnFn} from './remote'

import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'

import {z} from 'zod'

import {resolveTracesHost, resolveTracesOrigin, TRACES_APP_DIR, TRACES_GROUPS} from './host'
import {defaultSpawn, hasSentinel, REMOTE_COMMANDS, runRemote} from './remote'

declare const process: {
  env: Record<string, string | undefined>
  stdout: {isTTY?: boolean}
}

// ─── Sender tokens ────────────────────────────────────────────────────────────
//
// A sender token is a bearer credential the collector checks against one file per group, one token per line,
// first whitespace-separated field only. These commands are the only writers of those files.
//
// Where a token exists: on the host, in that file, and at the sender. Nowhere else.
//   - It is generated here, from the platform CSPRNG, and held in memory only until it has been delivered.
//   - It reaches the host on stdin, never in an argv. The remote commands are fixed text; only the group, which
//     is validated against the three known names, selects among them.
//   - Only its fingerprint (first 12 hex characters of its SHA-256) is ever printed, logged or stored beside it.
//   - `list` computes fingerprints on the host, so no token text leaves it. Only `revoke` reads token text
//     back, into memory, to prove the removed token is now refused.
//
// Every change to a file is a new file written in the same directory and renamed over the old one, so the
// collector never sees a partial file, and the file keeps its mode and owner. The whole read-copy-rename runs
// under one `flock` on the token lock, so two token commands never interleave and a stale copy can never undo a
// revoke. A change is "done" only when a
// request with the token has been seen to behave as the file now says.

export type TracesGroup = (typeof TRACES_GROUPS)[number]

function isGroup(value: string): value is TracesGroup {
  return (TRACES_GROUPS as readonly string[]).includes(value)
}

function assertGroup(value: string): asserts value is TracesGroup {
  if (!isGroup(value)) throw new Error('not a sender group')
}

// ─── Token and fingerprint ────────────────────────────────────────────────────

/** A fixed, recognisable prefix so a secret scanner or the redaction gate can match a token. */
export const TOKEN_PREFIX = 'trc_'
const TOKEN_BYTES = 32
const FINGERPRINT_LENGTH = 12

/** The `gh secret set` name used when `--secret-name` is not given, for both GitHub groups. */
export const DEFAULT_SECRET_NAME = 'TRACES_INGEST_TOKEN'

export type RandomBytes = (length: number) => Uint8Array

const platformRandomBytes: RandomBytes = length => crypto.getRandomValues(new Uint8Array(length))

export function fingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, FINGERPRINT_LENGTH)
}

export function generateToken(randomBytes: RandomBytes = platformRandomBytes): {token: string; fingerprint: string} {
  const bytes = randomBytes(TOKEN_BYTES)
  if (bytes.length !== TOKEN_BYTES) throw new Error(`the random source must return ${TOKEN_BYTES} bytes`)
  const token = `${TOKEN_PREFIX}${Buffer.from(bytes).toString('base64url')}`
  return {token, fingerprint: fingerprintOf(token)}
}

/** `<token> <fingerprint> <date>`: the collector reads the first field only. */
export function formatTokenLine(token: string, fingerprint: string, createdAt: string): string {
  return `${token} ${fingerprint} ${createdAt}\n`
}

// ─── Remote commands ──────────────────────────────────────────────────────────

const COMPOSE = `docker compose --project-directory ${TRACES_APP_DIR}`

/** The token directories, repeated from the app's host layout; a test pins them to apps/traces. */
const TOKEN_ROOT = `${TRACES_APP_DIR}/tokens`

/** The lock every read-then-replace of a token file holds; a test pins it to apps/traces. */
export const TRACES_TOKENS_LOCK = `${TOKEN_ROOT}/.lock`

/** Each group's receiver port in the collector config; a test pins them to otelcol.yaml. */
const RECEIVER_PORTS: Record<TracesGroup, number> = {marcusrbrown: 4411, 'fro-bot': 4412, workstation: 4413}

type TokenOp = 'list' | 'lines' | 'append' | 'remove' | 'empty'

export function senderSentinel(op: TokenOp, group: string): string {
  assertGroup(group)
  return `TRACES_SENDER_${op.toUpperCase()}_DONE=${group}`
}

/** What a token script prints, and exits non-zero, when the token lock was not free within 30 seconds. */
export function lockBusySentinel(group: string): string {
  assertGroup(group)
  return `TRACES_SENDER_LOCK_BUSY=${group}`
}

const REMOVED_PREFIX = 'TRACES_TOKEN_REMOVED='
const PROBE_PREFIX = 'TRACES_PROBE_STATUS='

const script = (...steps: string[]): string => steps.join('; ')

/** The directory, the token file in it, and a refusal to go on when the file is a directory. */
function locate(group: string): string[] {
  assertGroup(group)
  return [`d=${TOKEN_ROOT}/${group}`, 'f="$d/token"', 'test -d "$d"', 'test ! -d "$f"']
}

/**
 * The token lock, taken before the file is read or copied and held until the script exits, which is after the
 * rename. Descriptor 9 holds the lock file open and `flock` takes the lock on it, so the lock is released by the
 * shell ending, however it ends. Without it, an append could copy the file, a revoke could finish, and the
 * append's rename would put the revoked token back. A lock not free in 30 seconds is a failure with its own
 * sentinel and the file untouched. The only thing ever redirected to is the lock file: a regular file under the
 * app directory.
 */
function lockTokens(group: string): string[] {
  return [`l=${TRACES_TOKENS_LOCK}`, 'exec 9>>"$l"', `flock -w 30 9 || { echo ${lockBusySentinel(group)}; exit 1; }`]
}

/**
 * A temporary file next to the token file, removed again if the script stops before the rename. The only
 * deletion any of these commands does is of that file.
 */
const TEMP_FILE = ['t=$(mktemp "$d/.token.XXXXXX")', `trap 'rm -f "$t"' EXIT`]

/**
 * Give the temporary file the token file's mode and owner. Where the token file does not exist yet, the
 * temporary file is readable by its group and owned like the directory, which deploy sets up for the collector.
 */
const COPY_ATTRIBUTES =
  'if [ -f "$f" ]; then cp -p "$f" "$t"; else chmod 0640 "$t"; chown "$(ls -ld "$d" | awk \'{print $3":"$4}\')" "$t"; fi'

/** One `read` loop over the token file: `tok` is the first field, `date` the third. A last line with no newline counts. */
const EACH_LINE = 'while read -r tok skip date rest || [ -n "$tok" ]; do if [ -z "$tok" ]; then continue; fi'

/** The host's fingerprint of a token, computed from the token itself and checked to be the right length. */
const HASH_TOKEN = 'h=$(printf %s "$tok" | sha256sum | cut -c1-12); case "$h" in ????????????) ;; *) exit 1 ;; esac'

function readScript(group: string, op: 'list' | 'lines'): string {
  const print =
    op === 'lines'
      ? String.raw`if [ -z "$date" ]; then date=unknown; fi; printf "TRACES_TOKEN %s %s %s\n" "$h" "$date" "$tok"`
      : String.raw`if [ -z "$date" ]; then date=unknown; fi; printf "TRACES_TOKEN %s %s\n" "$h" "$date"`
  return script(
    'set -e',
    ...locate(group),
    `if [ -f "$f" ]; then ${EACH_LINE}; ${HASH_TOKEN}; ${print}; done < "$f"; fi`,
    `echo ${senderSentinel(op, group)}`,
  )
}

export const SENDER_REMOTE = {
  /** `TRACES_TOKEN <fingerprint> <date>` per line. No token text. */
  list: (group: string): string => readScript(group, 'list'),
  /** `TRACES_TOKEN <fingerprint> <date> <token>` per line. Used only to prove a removed token is refused. */
  lines: (group: string): string => readScript(group, 'lines'),
  /** Append the line on stdin to the group's file, by writing a new file and renaming it over the old one. */
  append: (group: string): string =>
    script(
      'set -e',
      ...lockTokens(group),
      ...locate(group),
      ...TEMP_FILE,
      COPY_ATTRIBUTES,
      '{ if [ -s "$f" ]; then cat "$f"; if [ -n "$(tail -c 1 "$f")" ]; then echo; fi; fi; cat; } > "$t"',
      'mv -f "$t" "$f"',
      `echo ${senderSentinel('append', group)}`,
    ),
  /**
   * Remove every line whose token has the fingerprint on stdin, and drop blank lines, by the same
   * write-and-rename. Prints how many lines it removed.
   */
  remove: (group: string): string =>
    script(
      'set -e',
      'read -r fp',
      'case "$fp" in ????????????) ;; *) exit 1 ;; esac',
      ...lockTokens(group),
      ...locate(group),
      'test -f "$f"',
      ...TEMP_FILE,
      'cp -p "$f" "$t"',
      'n=0',
      String.raw`while read -r tok rest || [ -n "$tok" ]; do if [ -z "$tok" ]; then continue; fi; ${HASH_TOKEN}; if [ "$h" = "$fp" ]; then n=$((n+1)); elif [ -n "$rest" ]; then printf "%s %s\n" "$tok" "$rest"; else printf "%s\n" "$tok"; fi; done < "$f" > "$t"`,
      'mv -f "$t" "$f"',
      `echo ${REMOVED_PREFIX}$n`,
      `echo ${senderSentinel('remove', group)}`,
    ),
  /** Replace the group's file with an empty one, by the same write-and-rename. */
  empty: (group: string): string =>
    script(
      'set -e',
      ...lockTokens(group),
      ...locate(group),
      ...TEMP_FILE,
      COPY_ATTRIBUTES,
      ': > "$t"',
      'mv -f "$t" "$f"',
      `echo ${senderSentinel('empty', group)}`,
    ),
  /**
   * One authenticated request to the group's private receiver, made from the health reporter container
   * (the collector image has no shell, and nothing publishes its ports). The token is read from stdin by a
   * short Bun program; the body is an empty OTLP export. Prints the status line, or exits non-zero.
   */
  probe: (group: string): string => {
    assertGroup(group)
    const url = `http://collector:${RECEIVER_PORTS[group]}/${group}/v1/traces`
    const program = [
      'Bun.stdin.text()',
      `.then(function(t){return fetch("${url}",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+t.trim()},body:JSON.stringify({resourceSpans:[]}),signal:AbortSignal.timeout(5000)})})`,
      `.then(function(r){console.log("${PROBE_PREFIX}"+r.status);process.exit(0)},function(){process.exit(1)})`,
    ].join('')
    return `${COMPOSE} exec -T health-reporter bun -e '${program}'`
  },
} as const

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface SenderDeps {
  /** Runs ssh and gh. */
  spawn?: SpawnFn
  /** Reaches the public endpoint. The default is the global `fetch`. */
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  /** Proof requests before giving up while the collector re-reads a file. */
  attempts?: number
  intervalMs?: number
  randomBytes?: RandomBytes
  now?: () => Date
  /** Whether standard output is a terminal. The default reads `process.stdout.isTTY`. */
  isTty?: boolean
}

const DEFAULT_ATTEMPTS = 10
const DEFAULT_INTERVAL_MS = 1000
const REQUEST_TIMEOUT_MS = 10_000
const GH_TIMEOUT_MS = 30_000

/** An empty OTLP JSON export: valid, writes nothing to either backend. */
const PROBE_BODY = JSON.stringify({resourceSpans: []})

// ─── Output that cannot carry a token ─────────────────────────────────────────

interface Out {
  log: (message: string) => void
  error: (message: string) => void
}

const TOKEN_SHAPE = new RegExp(String.raw`${TOKEN_PREFIX}[\w-]{20,}`, 'g')

/** Replace every known token, and anything shaped like one, so a child's stderr or an error cannot leak it. */
function scrub(text: string, secrets: readonly string[]): string {
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
 * Run an action body. Anything it throws becomes a scrubbed error line and a failure. The caller exits after
 * this returns, outside the `try`, because `ctx.process.exit` throws.
 */
async function guarded(
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

// ─── A busy token lock ────────────────────────────────────────────────────────

/** The script found the token lock held for 30 seconds and changed nothing. Exit non-zero, sentinel on its own line. */
function isLockBusy(result: Awaited<ReturnType<typeof runRemote>>, group: TracesGroup): boolean {
  return result.exitCode !== 0 && result.stdout.split('\n').some(line => line.trim() === lockBusySentinel(group))
}

const lockBusyMessage = (group: TracesGroup): string =>
  `The ${group} token lock is busy: another token command was still running on the host after 30 seconds. Nothing was changed. Run this again in a minute.`

// ─── Reading the host ─────────────────────────────────────────────────────────

interface TokenEntry {
  fingerprint: string
  date: string
  /** Present only for entries read with `lines`. */
  token?: string
}

type ReadResult = {ok: true; entries: TokenEntry[]} | {ok: false; error: string}

const ENTRY_LINE = /^TRACES_TOKEN ([\da-f]{12}) (\S+)(?: (\S+))?$/
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/

function parseEntries(stdout: string, withToken: boolean): TokenEntry[] {
  const entries: TokenEntry[] = []
  for (const line of stdout.split('\n')) {
    const match = ENTRY_LINE.exec(line.trim())
    if (match === null) continue
    const [, fingerprint, date, token] = match
    if (fingerprint === undefined || date === undefined) continue
    if (withToken && token === undefined) continue
    entries.push({
      fingerprint,
      date: DATE_SHAPE.test(date) ? date : 'unknown',
      ...(withToken && token !== undefined ? {token} : {}),
    })
  }
  return entries
}

async function readEntries(
  host: string,
  group: TracesGroup,
  op: 'list' | 'lines',
  deps: SenderDeps,
): Promise<ReadResult> {
  const result = await runRemote(host, SENDER_REMOTE[op](group), deps.spawn === undefined ? {} : {spawn: deps.spawn})
  if (!hasSentinel(result, senderSentinel(op, group))) {
    return {ok: false, error: `exit ${result.exitCode}: ${result.stderr || 'no confirmation from the host'}`}
  }
  return {ok: true, entries: parseEntries(result.stdout, op === 'lines')}
}

// ─── Proving a token against the live collector ───────────────────────────────

/** An HTTP status, or `none` when no answer was had (connection failed, ssh failed, no status line). */
type ProbeStatus = number | 'none'

interface Route {
  /** For messages: where the proof was made. */
  label: string
  probe: (token: string) => Promise<ProbeStatus>
}

async function publicProbe(
  origin: string,
  group: TracesGroup,
  token: string | undefined,
  deps: SenderDeps,
): Promise<ProbeStatus> {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  try {
    const response = await fetchFn(`${origin}/${group}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : {authorization: `Bearer ${token}`}),
      },
      body: token === undefined ? '{}' : PROBE_BODY,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    response.body?.cancel().catch(() => undefined)
    return response.status
  } catch {
    return 'none'
  }
}

async function privateProbe(host: string, group: TracesGroup, token: string, deps: SenderDeps): Promise<ProbeStatus> {
  try {
    const result = await runRemote(host, SENDER_REMOTE.probe(group), {
      stdin: `${token}\n`,
      ...(deps.spawn === undefined ? {} : {spawn: deps.spawn}),
    })
    if (result.exitCode !== 0) return 'none'
    const match = new RegExp(String.raw`^${PROBE_PREFIX}(\d{3})$`, 'm').exec(result.stdout)
    return match?.[1] === undefined ? 'none' : Number(match[1])
  } catch {
    return 'none'
  }
}

function privateRoute(host: string, group: TracesGroup, deps: SenderDeps): Route {
  return {
    label: `the ${group} receiver, reached over ssh`,
    probe: token => privateProbe(host, group, token, deps),
  }
}

/**
 * The public route is used only when the host says it is open AND an unauthenticated request from outside is
 * answered 401 by the collector on this group's path. A held route answers 503 to every token, and a stack
 * restored behind a closed firewall may say "open" and be unreachable, so anything else proves over ssh.
 */
async function chooseRoute(host: string, origin: string, group: TracesGroup, deps: SenderDeps): Promise<Route> {
  const configured = await runRemote(
    host,
    REMOTE_COMMANDS.readIngestState,
    deps.spawn === undefined ? {} : {spawn: deps.spawn},
  )
  const state =
    configured.exitCode === 0 ? /^TRACES_INGEST_STATE=(off|held|open)$/m.exec(configured.stdout)?.[1] : undefined
  if (state === 'open' && (await publicProbe(origin, group, undefined, deps)) === 401) {
    return {label: `the public endpoint for ${group}`, probe: token => publicProbe(origin, group, token, deps)}
  }
  return privateRoute(host, group, deps)
}

async function prove(
  route: Route,
  token: string,
  accept: (status: number) => boolean,
  deps: SenderDeps,
): Promise<{proven: boolean; last: ProbeStatus}> {
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  let last: ProbeStatus = 'none'
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await route.probe(token)
    if (last !== 'none' && accept(last)) return {proven: true, last}
    if (attempt < attempts) await sleep(deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  }
  return {proven: false, last}
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300
const isRefused = (status: number): boolean => status === 401

const describeStatus = (status: ProbeStatus): string => (status === 'none' ? 'no answer' : String(status))

// ─── Targets ──────────────────────────────────────────────────────────────────

type Targets = {ok: true; host: string; origin: string} | {ok: false; error: string}

function resolveTargets(key: string | undefined, needOrigin: boolean): Targets {
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

// ─── Delivery ─────────────────────────────────────────────────────────────────

export interface AddOptions {
  key?: string | undefined
  /** `OWNER/REPO`, repeatable: a repository Actions secret. */
  repo?: string[] | undefined
  /** An organisation Actions secret, visible to `orgRepo` only. */
  org?: string | undefined
  orgRepo?: string[] | undefined
  secretName?: string | undefined
  /** Print a workstation token even when standard output is not a terminal. */
  print?: boolean | undefined
}

const REPO_SHAPE = /^[A-Z\d][A-Z\d-]*\/\w[\w.-]*$/i
const ORG_SHAPE = /^[A-Z\d][A-Z\d-]*$/i
const REPO_NAME_SHAPE = /^\w[\w.-]*$/
const SECRET_NAME_SHAPE = /^[A-Z_][A-Z\d_]*$/

interface GithubTarget {
  label: string
  command: string[]
}

type DeliveryPlan = {kind: 'github'; secretName: string; targets: GithubTarget[]} | {kind: 'terminal'}

type PlanResult = {ok: true; plan: DeliveryPlan} | {ok: false; error: string}

/** Decide where the token goes, and refuse before anything is issued if there is nowhere safe to put it. */
function planDelivery(group: TracesGroup, options: AddOptions, isTty: boolean): PlanResult {
  const repos = options.repo ?? []
  const orgRepos = options.orgRepo ?? []
  const hasGithubOptions =
    repos.length > 0 || options.org !== undefined || orgRepos.length > 0 || options.secretName !== undefined

  if (group === 'workstation') {
    if (hasGithubOptions) {
      return {
        ok: false,
        error:
          'The workstation token is printed, not stored in GitHub: drop --repo, --org, --org-repo and --secret-name.',
      }
    }
    if (options.print !== true && !isTty) {
      return {
        ok: false,
        error: 'Refusing to print a token to something that is not a terminal. Run it in a terminal, or pass --print.',
      }
    }
    return {ok: true, plan: {kind: 'terminal'}}
  }

  if (options.print === true) {
    return {
      ok: false,
      error: `--print applies to the workstation group only. The ${group} token goes to a GitHub Actions secret and is never printed.`,
    }
  }
  const secretName = options.secretName ?? DEFAULT_SECRET_NAME
  if (!SECRET_NAME_SHAPE.test(secretName)) {
    return {
      ok: false,
      error: 'Invalid --secret-name: use upper-case letters, digits and underscores, not starting with a digit.',
    }
  }
  for (const repo of repos) {
    if (!REPO_SHAPE.test(repo)) return {ok: false, error: 'Invalid --repo: expected OWNER/REPO.'}
  }
  if (options.org !== undefined && !ORG_SHAPE.test(options.org)) {
    return {ok: false, error: 'Invalid --org: expected an organisation name.'}
  }
  for (const name of orgRepos) {
    if (!REPO_NAME_SHAPE.test(name))
      return {ok: false, error: 'Invalid --org-repo: expected a repository name, without the owner.'}
  }
  if (options.org !== undefined && orgRepos.length === 0) {
    return {
      ok: false,
      error:
        '--org needs at least one --org-repo: an organisation secret is only ever visible to selected repositories.',
    }
  }
  if (options.org === undefined && orgRepos.length > 0) {
    return {ok: false, error: '--org-repo needs --org.'}
  }

  const targets: GithubTarget[] = repos.map(repo => ({
    label: `repository ${repo}`,
    command: ['gh', 'secret', 'set', secretName, '--repo', repo],
  }))
  if (options.org !== undefined) {
    targets.push({
      label: `organisation ${options.org} (selected repositories: ${orgRepos.join(', ')})`,
      command: [
        'gh',
        'secret',
        'set',
        secretName,
        '--org',
        options.org,
        '--visibility',
        'selected',
        '--repos',
        orgRepos.join(','),
      ],
    })
  }
  if (targets.length === 0) {
    return {
      ok: false,
      error: `Nowhere to put the ${group} token. Pass --repo OWNER/REPO (repeatable), or --org ORG with --org-repo NAME (repeatable). There is no default target.`,
    }
  }
  return {ok: true, plan: {kind: 'github', secretName, targets}}
}

function ghEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/** `gh secret set NAME ...` with the token as the whole of stdin. Never an argument. */
async function setGithubSecret(
  command: string[],
  token: string,
  deps: SenderDeps,
): Promise<{ok: true} | {ok: false; error: string}> {
  const spawn = deps.spawn ?? defaultSpawn
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

// ─── add ──────────────────────────────────────────────────────────────────────

async function addFlow(
  group: string,
  options: AddOptions,
  ctx: ActionCtx,
  out: Out,
  secrets: string[],
  deps: SenderDeps,
): Promise<boolean> {
  if (!isGroup(group)) {
    out.error(`Unknown group. Valid groups: ${TRACES_GROUPS.join(', ')}`)
    return false
  }

  const isTty = deps.isTty ?? process.stdout.isTTY === true
  const planned = planDelivery(group, options, isTty)
  if (!planned.ok) {
    out.error(planned.error)
    return false
  }
  const targets = resolveTargets(options.key, true)
  if (!targets.ok) {
    out.error(targets.error)
    return false
  }
  const {host, origin} = targets

  // Everything above can refuse without having issued anything.
  const {token, fingerprint} = generateToken(deps.randomBytes)
  secrets.push(token)
  const createdAt = (deps.now?.() ?? new Date()).toISOString()

  const existing = await readEntries(host, group, 'list', deps)
  if (!existing.ok) {
    out.error(`Could not read the ${group} token file on the host (${existing.error}). Nothing was changed.`)
    return false
  }

  const written = await runRemote(host, SENDER_REMOTE.append(group), {
    stdin: formatTokenLine(token, fingerprint, createdAt),
    ...(deps.spawn === undefined ? {} : {spawn: deps.spawn}),
  })
  if (isLockBusy(written, group)) {
    out.error(lockBusyMessage(group))
    return false
  }
  if (!hasSentinel(written, senderSentinel('append', group))) {
    // The write may have landed with only the reply lost, so name the token (by fingerprint) and both ways to settle it.
    out.error(
      `The host did not confirm the write (exit ${written.exitCode}: ${written.stderr || 'no confirmation'}). The ${group} token ${fingerprint} may or may not be in the token file, and it was not delivered anywhere. To see whether it landed, run: infra traces sender list. If it did, remove it with: infra traces sender revoke ${group} ${fingerprint}`,
    )
    return false
  }
  out.log(`Token ${fingerprint} written to the ${group} token file.`)

  const route = await chooseRoute(host, origin, group, deps)
  const proof = await prove(route, token, isSuccess, deps)
  if (!proof.proven) {
    out.error(
      `Token ${fingerprint} is in the ${group} token file but is not live: ${route.label} answered ${describeStatus(proof.last)}. It was not delivered. Remove it with: infra traces sender revoke ${group} ${fingerprint}`,
    )
    return false
  }
  out.log(`Token ${fingerprint} is live: ${route.label} answered ${describeStatus(proof.last)}.`)

  const delivered = await deliver(group, planned.plan, token, fingerprint, origin, ctx, out, deps)
  if (!delivered) return false

  if (existing.entries.length > 0) {
    out.log(
      `${group} already had ${existing.entries.length} token${existing.entries.length === 1 ? '' : 's'}; both are accepted until you revoke the old one. After the sender uses the new token, revoke each of these:`,
    )
    for (const entry of existing.entries) out.log(`  infra traces sender revoke ${group} ${entry.fingerprint}`)
  }
  return true
}

async function deliver(
  group: TracesGroup,
  plan: DeliveryPlan,
  token: string,
  fingerprint: string,
  origin: string,
  ctx: ActionCtx,
  out: Out,
  deps: SenderDeps,
): Promise<boolean> {
  if (plan.kind === 'terminal') {
    // The one deliberate print of a token, to the operator's own terminal, once.
    out.log(`New ${group} token (fingerprint ${fingerprint}). It is shown once and is stored nowhere else:`)
    ctx.console.log(token)
    out.log(
      `Put it in the sender's configuration as the bearer token for ${origin}/${group}/v1/traces (Authorization: Bearer <token>).`,
    )
    return true
  }

  const done: string[] = []
  for (const target of plan.targets) {
    const result = await setGithubSecret(target.command, token, deps)
    if (!result.ok) {
      out.error(
        `The host accepted token ${fingerprint} for ${group} and it is live, but delivery to ${target.label} failed (${result.error}). ${
          done.length === 0 ? 'It was delivered nowhere.' : `It was delivered to: ${done.join('; ')}.`
        } The token is not shown. Revoke it with \`infra traces sender revoke ${group} ${fingerprint}\` and run add again.`,
      )
      return false
    }
    done.push(target.label)
    out.log(`Delivered to ${target.label} as secret ${plan.secretName}.`)
  }
  return true
}

export async function tracesSenderAddAction(
  group: string,
  options: AddOptions,
  ctx: ActionCtx,
  deps: SenderDeps = {},
): Promise<void> {
  const secrets: string[] = []
  const ok = await guarded(ctx, secrets, out => addFlow(group, options, ctx, out, secrets, deps))
  if (!ok) ctx.process.exit(1)
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function tracesSenderListAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  deps: SenderDeps = {},
): Promise<void> {
  const ok = await guarded(ctx, [], async out => {
    const targets = resolveTargets(options.key, false)
    if (!targets.ok) {
      out.error(targets.error)
      return false
    }

    let allRead = true
    for (const group of TRACES_GROUPS) {
      const result = await readEntries(targets.host, group, 'list', deps)
      if (!result.ok) {
        out.error(`${group}: the token file could not be read (${result.error}).`)
        allRead = false
        continue
      }
      out.log(group)
      if (result.entries.length === 0) out.log('  (no tokens)')
      for (const entry of result.entries) out.log(`  ${entry.fingerprint}  ${entry.date}`)
    }
    return allRead
  })
  if (!ok) ctx.process.exit(1)
}

// ─── revoke ───────────────────────────────────────────────────────────────────

export interface RevokeOptions {
  key?: string | undefined
  all?: boolean | undefined
}

const FINGERPRINT_SHAPE = /^[\da-f]{12}$/

const HOLD_HINT =
  'This is an emergency: run `infra traces ingest hold` now, then find out why the collector still accepts it.'

async function revokeOne(
  group: string | undefined,
  fingerprintInput: string | undefined,
  options: RevokeOptions,
  out: Out,
  secrets: string[],
  deps: SenderDeps,
): Promise<boolean> {
  if (group === undefined || !isGroup(group)) {
    out.error(
      group === undefined
        ? `Name a group (${TRACES_GROUPS.join(', ')}) and a fingerprint, or pass --all.`
        : `Unknown group. Valid groups: ${TRACES_GROUPS.join(', ')}`,
    )
    return false
  }
  if (fingerprintInput === undefined) {
    out.error(`Name the fingerprint to revoke. \`infra traces sender list\` shows them.`)
    return false
  }
  const fingerprint = fingerprintInput.toLowerCase()
  if (!FINGERPRINT_SHAPE.test(fingerprint)) {
    // The input is not echoed: it may be a token pasted in the wrong place.
    out.error('A fingerprint is 12 hexadecimal characters, as `infra traces sender list` prints them.')
    return false
  }
  const targets = resolveTargets(options.key, true)
  if (!targets.ok) {
    out.error(targets.error)
    return false
  }
  const {host, origin} = targets

  // The token text is read first, into memory, because the proof needs it after the line is gone.
  const current = await readEntries(host, group, 'lines', deps)
  if (!current.ok) {
    out.error(`Could not read the ${group} token file on the host (${current.error}). Nothing was changed.`)
    return false
  }
  for (const entry of current.entries) {
    if (entry.token !== undefined) secrets.push(entry.token)
  }
  const matches = current.entries.filter(entry => entry.fingerprint === fingerprint)
  const tokens = matches.flatMap(entry => (entry.token === undefined ? [] : [entry.token]))
  if (tokens.length === 0) {
    const present = current.entries.map(entry => entry.fingerprint)
    out.error(
      `No token in the ${group} file has fingerprint ${fingerprint}. Fingerprints present: ${present.length === 0 ? '(none)' : present.join(', ')}. Nothing was changed.`,
    )
    return false
  }

  const removed = await runRemote(host, SENDER_REMOTE.remove(group), {
    stdin: `${fingerprint}\n`,
    ...(deps.spawn === undefined ? {} : {spawn: deps.spawn}),
  })
  if (isLockBusy(removed, group)) {
    out.error(lockBusyMessage(group))
    return false
  }
  if (!hasSentinel(removed, senderSentinel('remove', group))) {
    out.error(
      `The host did not confirm the removal (exit ${removed.exitCode}: ${removed.stderr || 'no confirmation'}). The token may still be in the file. Check with \`infra traces sender list\`.`,
    )
    return false
  }
  const count = Number(new RegExp(String.raw`^${REMOVED_PREFIX}(\d+)$`, 'm').exec(removed.stdout)?.[1])

  const route = await chooseRoute(host, origin, group, deps)
  let ok = true
  for (const token of tokens) {
    const proof = await prove(route, token, isRefused, deps)
    if (proof.proven) continue
    ok = false
    out.error(
      proof.last !== 'none' && isSuccess(proof.last)
        ? `Token ${fingerprint} (${group}) was removed from the file but still accepted: ${route.label} answered ${describeStatus(proof.last)}. ${HOLD_HINT}`
        : `Token ${fingerprint} (${group}) was removed from the file, but its refusal could not be proven: ${route.label} answered ${describeStatus(proof.last)}. Do not rely on it until a check answers 401. If it may still be accepted, run \`infra traces ingest hold\`.`,
    )
  }
  if (!ok) return false

  if (count !== tokens.length) {
    out.error(
      `Token ${fingerprint} (${group}) was refused, but the host removed ${Number.isNaN(count) ? 'an unknown number of' : count} lines where ${tokens.length} were expected. The file changed while this ran: check \`infra traces sender list\`.`,
    )
    return false
  }
  out.log(`Token ${fingerprint} revoked from ${group}: ${route.label} answered 401 for it.`)
  return true
}

async function revokeAll(options: RevokeOptions, out: Out, secrets: string[], deps: SenderDeps): Promise<boolean> {
  // The public hostname is never used here: after a restore its ports are closed at the cloud firewall, and a
  // closed route proves nothing. Every proof is made against the private receivers over ssh.
  const targets = resolveTargets(options.key, false)
  if (!targets.ok) {
    out.error(targets.error)
    return false
  }
  const {host} = targets

  let ok = true
  const removedFingerprints: string[] = []
  for (const group of TRACES_GROUPS) {
    const current = await readEntries(host, group, 'lines', deps)
    if (!current.ok) {
      out.error(`${group}: the token file could not be read (${current.error}); it was not emptied.`)
      ok = false
      continue
    }
    for (const entry of current.entries) {
      if (entry.token !== undefined) secrets.push(entry.token)
    }

    const emptied = await runRemote(
      host,
      SENDER_REMOTE.empty(group),
      deps.spawn === undefined ? {} : {spawn: deps.spawn},
    )
    if (isLockBusy(emptied, group)) {
      out.error(`${group}: ${lockBusyMessage(group)} It was not emptied.`)
      ok = false
      continue
    }
    if (!hasSentinel(emptied, senderSentinel('empty', group))) {
      out.error(
        `${group}: the host did not confirm the file was emptied (exit ${emptied.exitCode}: ${emptied.stderr || 'no confirmation'}). Tokens may still be accepted.`,
      )
      ok = false
      continue
    }

    const route = privateRoute(host, group, deps)
    for (const entry of current.entries) {
      if (entry.token === undefined) continue
      const proof = await prove(route, entry.token, isRefused, deps)
      if (proof.proven) {
        out.log(`${group}: removed ${entry.fingerprint}; the private receiver answers 401 for it.`)
        removedFingerprints.push(`${group} ${entry.fingerprint}`)
        continue
      }
      ok = false
      out.error(
        proof.last !== 'none' && isSuccess(proof.last)
          ? `${group}: token ${entry.fingerprint} was removed from the file but still accepted (${route.label} answered ${describeStatus(proof.last)}). ${HOLD_HINT}`
          : `${group}: token ${entry.fingerprint} was removed from the file, but its refusal could not be proven (${route.label} answered ${describeStatus(proof.last)}). If it may still be accepted, run \`infra traces ingest hold\`.`,
      )
    }
    if (current.entries.length === 0) out.log(`${group}: the file was already empty.`)
  }

  if (ok) {
    out.log(
      removedFingerprints.length === 0
        ? 'Every token file is empty.'
        : `Every token file is empty and every listed token is refused. Removed: ${removedFingerprints.join(', ')}.`,
    )
    out.log(
      'This command does not touch GitHub secrets: delete the matching ones yourself, and issue new tokens with `infra traces sender add`.',
    )
  }
  return ok
}

export async function tracesSenderRevokeAction(
  group: string | undefined,
  fingerprint: string | undefined,
  options: RevokeOptions,
  ctx: ActionCtx,
  deps: SenderDeps = {},
): Promise<void> {
  const secrets: string[] = []
  const ok = await guarded(ctx, secrets, async out => {
    if (options.all === true) {
      if (group !== undefined || fingerprint !== undefined) {
        out.error('--all takes no group and no fingerprint.')
        return false
      }
      return revokeAll(options, out, secrets, deps)
    }
    return revokeOne(group, fingerprint, options, out, secrets, deps)
  })
  if (!ok) ctx.process.exit(1)
}

// ─── Command registration ─────────────────────────────────────────────────────

const keyOption = z
  .string()
  .optional()
  .describe('Environment variable name holding the SSH host. Falls back to TRACES_HOST, then traces.fro.bot.')

export function registerTracesSender(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'traces sender add <group>',
      `Issue a sender token for marcusrbrown, fro-bot or workstation. Writes it to the host, proves it is accepted, then delivers it once: to a GitHub Actions secret (${DEFAULT_SECRET_NAME} by default) or, for workstation, to this terminal.`,
    )
    .option('--repo [repo]', z.array(z.string()).describe('OWNER/REPO to set the Actions secret on (repeatable).'))
    .option(
      '--org [org]',
      z.string().describe('Organisation to set the Actions secret on, visible to the --org-repo repositories only.'),
    )
    .option(
      '--org-repo [repo]',
      z.array(z.string()).describe('Repository name (no owner) that may read the organisation secret (repeatable).'),
    )
    .option('--secret-name [name]', z.string().describe(`Secret name. Default ${DEFAULT_SECRET_NAME}.`))
    .option('--print', 'Print a workstation token even when standard output is not a terminal.')
    .option('--key [key]', keyOption)
    .action((group, options, ctx) => tracesSenderAddAction(group, options, ctx))

  cli
    .command('traces sender list', 'List sender tokens per group: fingerprint and creation date. Never token text.')
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesSenderListAction(options, ctx))

  cli
    .command(
      'traces sender revoke [group] [fingerprint]',
      'Remove one sender token and prove it is now refused. With --all (no group, no fingerprint): empty every group file and prove every old token is refused on its private receiver.',
    )
    .option('--all', 'Empty every group token file. Proves over ssh only, never through the public hostname.')
    .option('--key [key]', keyOption)
    .action((group, fingerprint, options, ctx) => tracesSenderRevokeAction(group, fingerprint, options, ctx))
}
