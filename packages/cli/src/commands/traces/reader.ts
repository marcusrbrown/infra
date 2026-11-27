import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {FetchLike} from './ingest'
import type {RemoteDeps, RemoteResult, RunRemoteOptions} from './remote'

import {chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'

import {z} from 'zod'

import {TRACES_READER_DIR, TRACES_READER_LOCK} from './host'
import {hasSentinel, runRemote, withRemoteSession} from './remote'
import {
  COPY_ATTRIBUTES,
  describeStatus,
  formatVoidLine,
  generateToken,
  generateVoidToken,
  guarded,
  isRefused,
  isSuccess,
  keyOption,
  lockFlock,
  prove,
  READ_VOID_LINE,
  REPO_SHAPE,
  resolveTargets,
  script,
  SECRET_NAME_SHAPE,
  setGithubSecret,
  TEMP_FILE,
  type Out,
  type ProbeStatus,
  type ProveDeps,
  type RandomBytes,
} from './token-common'

declare const process: {
  env: Record<string, string | undefined>
  stdout: {isTTY?: boolean}
}

// ─── Reader tokens ────────────────────────────────────────────────────────────
//
// A reader token is a bearer credential the reader gate checks against one file, one line per token:
//
//   <token> <fp12> <consumer> <iso-date>        a reader
//   <void token> void <iso-date>                 no reader (the file is never empty)
//
// It follows the sender lifecycle (see `sender.ts`): generated here, sent to the host on stdin, only its
// fingerprint ever printed, every change a new file renamed over the old one under one `flock`, and a change is
// done only when requests behave as the file now says. What differs:
//
//   - A token belongs to a named consumer, and the file holds at most one line per consumer unless a replacement
//     is under way. `add` refuses an existing consumer without `--replace`; `list` flags a consumer with two lines.
//   - The gate fails closed: one malformed line denies every token. Every script here classifies each line the way
//     the gate parses it, counts the lines that are neither a reader nor a void line, and `add` refuses to write to a
//     file the gate would reject.
//   - Proof is a request through both agent routes on the public origin, or, when the public route does not answer
//     as the gate does, the same request made from the host over ssh. Both routes are proven for every token: 200
//     to prove a token live, 401 to prove it removed.

export const CONSUMER_PATTERN = /^[a-z][a-z0-9-]{0,30}$/

/** The `gh secret set` name used when `--secret-name` is not given. */
export const DEFAULT_READER_SECRET_NAME = 'TRACES_READER_TOKEN'

/** The two agent routes. The public path is what a consumer calls; the proof request differs only in method. */
export const READER_ROUTES = ['langfuse', 'grafana'] as const
export type ReaderRoute = (typeof READER_ROUTES)[number]

const ROUTE_PATHS: Record<ReaderRoute, string> = {
  langfuse: '/agent/langfuse/api/public/health',
  grafana: '/agent/grafana/mcp',
}

/** An MCP `initialize`: the cheapest request the Grafana route accepts (POST only). It changes nothing upstream. */
const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'infra-reader-proof', version: '1'}},
})
const MCP_ACCEPT = 'application/json, text/event-stream'

// ─── Remote commands ──────────────────────────────────────────────────────────

type ReaderOp = 'list' | 'lines' | 'append' | 'remove' | 'deny'

export const readerSentinel = (op: ReaderOp): string => `TRACES_READER_${op.toUpperCase()}_DONE`

/** What a token script prints, and exits non-zero, when the reader lock was not free within 30 seconds. */
export const READER_LOCK_BUSY_SENTINEL = 'TRACES_READER_LOCK_BUSY'

const ENTRY_PREFIX = 'TRACES_READER '
const REMOVED_PREFIX = 'TRACES_READER_REMOVED='
const REAL_PREFIX = 'TRACES_READER_REAL='
const BAD_PREFIX = 'TRACES_READER_BAD='
const PROBE_PREFIX = 'TRACES_READER_PROBE_STATUS='

/** The directory, the token file in it, and a refusal to go on when the file is a directory. */
const LOCATE = [`d=${TRACES_READER_DIR}`, 'f="$d/token"', 'test -d "$d"', 'test ! -d "$f"']

const LOCK = lockFlock(TRACES_READER_LOCK, READER_LOCK_BUSY_SENTINEL)

/**
 * `classify "$@"` sets `kind` to `real`, `void` or `bad` from the fields of one line, and `tok`, `f2`, `f3`, `f4`
 * from its first four fields. It mirrors the gate's parser: a real line is exactly four fields (token, fingerprint,
 * consumer, date), the fingerprint is the first 12 hex characters of the token's SHA-256, and a void line is exactly
 * three. A line that is neither is `bad`, and the gate denies the whole file for it.
 */
const CLASSIFY = `classify() { ${[
  'argc=$#',
  `tok=\${1:-}`,
  `f2=\${2:-}`,
  `f3=\${3:-}`,
  `f4=\${4:-}`,
  'kind=bad',
  'case "$tok" in trc_void_*) if [ "$f2" = void ] && [ -n "$f3" ] && [ "$argc" -eq 3 ]; then kind=void; fi; return 0 ;; esac',
  '[ "$argc" -eq 4 ] || return 0',
  'case "$tok" in trc_*) ;; *) return 0 ;; esac',
  'case "$tok" in *[!A-Za-z0-9_-]*) return 0 ;; esac',
  `[ "\${#tok}" -ge 36 ] || return 0`,
  `[ "\${#tok}" -le 132 ] || return 0`,
  'case "$f2" in *[!0-9a-f]*) return 0 ;; ????????????) ;; *) return 0 ;; esac',
  'case "$f3" in [a-z]*) ;; *) return 0 ;; esac',
  'case "$f3" in *[!a-z0-9-]*) return 0 ;; esac',
  `[ "\${#f3}" -le 31 ] || return 0`,
  'case "$f4" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z) ;; *) return 0 ;; esac',
  'h=$(printf %s "$tok" | sha256sum | cut -c1-12)',
  '[ "$h" = "$f2" ] || return 0',
  'kind=real',
].join('; ')}; }`

/**
 * One loop over the token file, a line at a time with globbing off. A blank line is skipped; `kind`, `tok` and the
 * fields are set by `classify`. A last line with no newline counts. The caller closes it with `; done < "$f"`.
 */
const EACH_LINE =
  'while IFS= read -r line || [ -n "$line" ]; do set -f; set -- $line; if [ $# -eq 0 ]; then continue; fi; classify "$@"'

/** The consumer name on the first stdin line, in the shape the gate accepts, before anything is touched. */
const READ_CONSUMER = [
  'read -r name sel',
  'case "$name" in [a-z]*) ;; *) exit 1 ;; esac',
  'case "$name" in *[!a-z0-9-]*) exit 1 ;; esac',
  `[ "\${#name}" -le 31 ]`,
  'case "$sel" in -) ;; *[!0-9a-f]*) exit 1 ;; ????????????) ;; *) exit 1 ;; esac',
]

function readScript(op: 'list' | 'lines'): string {
  const print =
    op === 'lines'
      ? String.raw`printf "${ENTRY_PREFIX}%s %s %s %s\n" "$f2" "$f3" "$f4" "$tok"`
      : String.raw`printf "${ENTRY_PREFIX}%s %s %s\n" "$f2" "$f3" "$f4"`
  return script(
    'set -e',
    ...LOCATE,
    CLASSIFY,
    'bad=0',
    `if [ -f "$f" ]; then ${EACH_LINE}; case "$kind" in real) ${print} ;; void) ;; *) bad=$((bad+1)) ;; esac; done < "$f"; fi`,
    `echo ${BAD_PREFIX}$bad`,
    `echo ${readerSentinel(op)}`,
  )
}

export const READER_REMOTE = {
  /** `TRACES_READER <fingerprint> <consumer> <date>` per reader line, and the count of malformed lines. No token text. */
  list: readScript('list'),
  /** The same with the token text last. Used to prove a removed token is refused, and only then. */
  lines: readScript('lines'),
  /**
   * Append the line on stdin to the token file by writing a new file and renaming it over the old one. The line
   * must classify as a reader line (four fields, the fingerprint of its token), or nothing is touched.
   */
  append: script(
    'set -e',
    'IFS= read -r line',
    CLASSIFY,
    'set -f',
    'set -- $line',
    'classify "$@"',
    '[ "$kind" = real ]',
    'nl="$tok $f2 $f3 $f4"',
    ...LOCK,
    ...LOCATE,
    ...TEMP_FILE,
    COPY_ATTRIBUTES,
    String.raw`{ if [ -s "$f" ]; then cat "$f"; if [ -n "$(tail -c 1 "$f")" ]; then echo; fi; fi; printf "%s\n" "$nl"; } > "$t"`,
    'mv -f "$t" "$f"',
    `echo ${readerSentinel('append')}`,
  ),
  /**
   * Remove every reader line of the consumer on stdin line 1, or, when stdin line 1 also names a fingerprint
   * (`-` for none), only the line with that fingerprint. Line 2 is the void line written instead of everything else
   * when no reader line is left, so the file is never empty. Every other line is kept byte for byte and blank lines
   * are dropped. Prints how many lines it removed, how many reader lines remain, and how many lines were malformed.
   */
  remove: script(
    'set -e',
    ...READ_CONSUMER,
    ...READ_VOID_LINE,
    CLASSIFY,
    ...LOCK,
    ...LOCATE,
    'test -f "$f"',
    ...TEMP_FILE,
    'cp -p "$f" "$t"',
    'n=0',
    'r=0',
    'b=0',
    String.raw`${EACH_LINE}; case "$kind" in real) if [ "$f3" = "$name" ] && { [ "$sel" = - ] || [ "$f2" = "$sel" ]; }; then n=$((n+1)); continue; fi; r=$((r+1)) ;; bad) b=$((b+1)) ;; esac; printf "%s\n" "$line"; done < "$f" > "$t"`,
    String.raw`if [ "$r" -eq 0 ]; then printf "%s\n" "$vl" > "$t"; fi`,
    'mv -f "$t" "$f"',
    `echo ${REMOVED_PREFIX}$n`,
    `echo ${REAL_PREFIX}$r`,
    `echo ${BAD_PREFIX}$b`,
    `echo ${readerSentinel('remove')}`,
  ),
  /** Replace the file with the void line on stdin and nothing else (deny-all), by the same write-and-rename. */
  deny: script(
    'set -e',
    ...READ_VOID_LINE,
    ...LOCK,
    ...LOCATE,
    ...TEMP_FILE,
    COPY_ATTRIBUTES,
    String.raw`printf "%s\n" "$vl" > "$t"`,
    'mv -f "$t" "$f"',
    `echo ${readerSentinel('deny')}`,
  ),
  /**
   * One authenticated request to the public origin, made from the host: the same request a consumer makes, with the
   * hostname pinned to loopback (`--resolve`) so it works when the cloud firewall is closed. Stdin: the hostname, the
   * route (`langfuse` or `grafana`) and the token, one per line. The token goes into a curl config on stdin
   * (`-K -`), so it is in no argv; the response body is captured and dropped. Prints the status line, `000` for no
   * answer.
   */
  probe: script(
    'set -u',
    'read -r domain',
    'read -r which',
    'read -r tok',
    `case "$domain" in [A-Za-z0-9]*) ;; *) exit 1 ;; esac`,
    `case "$domain" in *[!A-Za-z0-9.-]*) exit 1 ;; esac`,
    'case "$tok" in trc_*) ;; *) exit 1 ;; esac',
    'case "$tok" in *[!A-Za-z0-9_-]*) exit 1 ;; esac',
    `case "$which" in langfuse) set -- -X GET "https://$domain${ROUTE_PATHS.langfuse}" ;; grafana) set -- -X POST -H 'content-type: application/json' -H 'accept: ${MCP_ACCEPT}' --data-binary '${INITIALIZE_BODY}' "https://$domain${ROUTE_PATHS.grafana}" ;; *) exit 1 ;; esac`,
    String.raw`out=$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -q -s --noproxy '*' --resolve "$domain:443:127.0.0.1" --max-time 10 -K - -w '\nTRACES_HTTP=%{http_code}' "$@") || true`,
    String.raw`code=$(printf '%s' "$out" | sed -n 's/.*TRACES_HTTP=\([0-9]*\)$/\1/p' | tail -n 1)`,
    `echo ${PROBE_PREFIX}\${code:-000}`,
  ),
} as const

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface ReaderDeps extends RemoteDeps, ProveDeps {
  /** Reaches the public origin. The default is the global `fetch`. */
  fetch?: FetchLike | undefined
  randomBytes?: RandomBytes | undefined
  now?: (() => Date) | undefined
  /** Whether standard output is a terminal. The default reads `process.stdout.isTTY`. */
  isTty?: boolean | undefined
  /** The home directory for the default workstation file. The default reads `HOME`. */
  homeDir?: string | undefined
}

const REQUEST_TIMEOUT_MS = 10_000

const remoteOptions = (deps: ReaderDeps): RunRemoteOptions => ({spawn: deps.spawn, session: deps.session})

// ─── Reading the host ─────────────────────────────────────────────────────────

interface ReaderEntry {
  fingerprint: string
  consumer: string
  date: string
  /** Present only for entries read with `lines`. */
  token?: string
}

type ReadResult = {ok: true; entries: ReaderEntry[]; bad: number} | {ok: false; error: string}

const ENTRY_LINE = /^TRACES_READER ([\da-f]{12}) ([a-z][\da-z-]{0,30}) (\S+)(?: (trc_[\w-]+))?$/

function parseEntries(stdout: string, withToken: boolean): ReaderEntry[] {
  const entries: ReaderEntry[] = []
  for (const line of stdout.split('\n')) {
    const match = ENTRY_LINE.exec(line.trim())
    if (match === null) continue
    const [, fingerprint, consumer, date, token] = match
    if (fingerprint === undefined || consumer === undefined || date === undefined) continue
    if (withToken && token === undefined) continue
    entries.push({fingerprint, consumer, date, ...(withToken && token !== undefined ? {token} : {})})
  }
  return entries
}

const countOf = (stdout: string, prefix: string): number =>
  Number(new RegExp(String.raw`^${prefix}(\d+)$`, 'm').exec(stdout)?.[1])

async function readEntries(host: string, op: 'list' | 'lines', deps: ReaderDeps): Promise<ReadResult> {
  const result = await runRemote(host, READER_REMOTE[op], remoteOptions(deps))
  if (!hasSentinel(result, readerSentinel(op))) {
    return {ok: false, error: `exit ${result.exitCode}: ${result.stderr || 'no confirmation from the host'}`}
  }
  const bad = countOf(result.stdout, BAD_PREFIX)
  return {ok: true, entries: parseEntries(result.stdout, op === 'lines'), bad: Number.isNaN(bad) ? 0 : bad}
}

const isLockBusy = (result: RemoteResult): boolean =>
  result.exitCode !== 0 && result.stdout.split('\n').some(line => line.trim() === READER_LOCK_BUSY_SENTINEL)

const LOCK_BUSY_MESSAGE =
  'The reader token lock is busy: another reader command was still running on the host after 30 seconds. Nothing was changed. Run this again in a minute.'

const malformedMessage = (count: number): string =>
  `The reader token file holds ${count} malformed line${count === 1 ? '' : 's'}, so the gate refuses every token until it is fixed.`

// ─── Proving a token against the live gate ────────────────────────────────────

interface Route {
  /** For messages: where the proof was made. */
  label: string
  probe: (route: ReaderRoute, token: string | undefined) => Promise<ProbeStatus>
}

async function publicProbe(
  origin: string,
  route: ReaderRoute,
  token: string | undefined,
  deps: ReaderDeps,
): Promise<ProbeStatus> {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const headers: Record<string, string> =
    route === 'grafana' ? {'content-type': 'application/json', accept: MCP_ACCEPT} : {accept: 'application/json'}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  try {
    const response = await fetchFn(`${origin}${ROUTE_PATHS[route]}`, {
      method: route === 'grafana' ? 'POST' : 'GET',
      headers,
      ...(route === 'grafana' ? {body: INITIALIZE_BODY} : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    response.body?.cancel().catch(() => undefined)
    return response.status
  } catch {
    return 'none'
  }
}

async function privateProbe(
  host: string,
  origin: string,
  route: ReaderRoute,
  token: string,
  deps: ReaderDeps,
): Promise<ProbeStatus> {
  try {
    const result = await runRemote(host, READER_REMOTE.probe, {
      ...remoteOptions(deps),
      stdin: `${new URL(origin).hostname}\n${route}\n${token}\n`,
    })
    if (result.exitCode !== 0) return 'none'
    const code = new RegExp(String.raw`^${PROBE_PREFIX}(\d{3})$`, 'm').exec(result.stdout)?.[1]
    return code === undefined || code === '000' ? 'none' : Number(code)
  } catch {
    return 'none'
  }
}

/**
 * The public route is used only when an unauthenticated request from outside is answered 401 by the gate on both
 * routes. Anything else (closed firewall after a restore, a proxy in the way) is proven from the host over ssh.
 */
async function chooseRoute(host: string, origin: string, deps: ReaderDeps): Promise<Route> {
  const unauthenticated = await Promise.all(READER_ROUTES.map(route => publicProbe(origin, route, undefined, deps)))
  if (unauthenticated.every(status => status === 401)) {
    return {label: 'the public origin', probe: (route, token) => publicProbe(origin, route, token, deps)}
  }
  return {
    label: 'the origin reached from the host over ssh',
    probe: (route, token) =>
      token === undefined ? Promise.resolve('none') : privateProbe(host, origin, route, token, deps),
  }
}

interface RouteProof {
  route: ReaderRoute
  proven: boolean
  last: ProbeStatus
}

/** Prove the token on every route, one after the other, each with its own bounded retries. */
async function proveOnRoutes(
  route: Route,
  token: string,
  accept: (status: number) => boolean,
  deps: ReaderDeps,
): Promise<RouteProof[]> {
  const proofs: RouteProof[] = []
  for (const name of READER_ROUTES) {
    const proof = await prove(() => route.probe(name, token), accept, deps)
    proofs.push({route: name, ...proof})
  }
  return proofs
}

const describeProofs = (proofs: readonly RouteProof[]): string =>
  proofs.map(proof => `${proof.route} ${describeStatus(proof.last)}`).join(', ')

// ─── Delivery ─────────────────────────────────────────────────────────────────

export interface AddOptions {
  key?: string | undefined
  /** `OWNER/REPO`, repeatable: a repository Actions secret. */
  repo?: string[] | undefined
  secretName?: string | undefined
  /** A workstation file other than the default. */
  file?: string | undefined
  /** Show the token on this terminal instead of writing a file. A terminal only. */
  print?: boolean | undefined
  /** Install the new token beside the consumer's existing one and remove the old one once delivery is done. */
  replace?: boolean | undefined
}

interface GithubTarget {
  label: string
  command: string[]
}

type DeliveryPlan =
  {kind: 'github'; secretName: string; targets: GithubTarget[]} | {kind: 'file'; path: string} | {kind: 'terminal'}

type PlanResult = {ok: true; plan: DeliveryPlan} | {ok: false; error: string}

/**
 * The workstation file, outside any checkout: `~/.config/infra/traces-reader-<consumer>.token`. Under the home
 * directory's config directory a repository, a sync folder and a backup of the working tree never meet it, and the
 * consumer name (validated) makes it unique per consumer.
 */
export function defaultWorkstationFile(home: string, consumer: string): string {
  return join(home, '.config', 'infra', `traces-reader-${consumer}.token`)
}

/** Whether the path is inside a git checkout: some directory above it holds a `.git`. */
function insideCheckout(path: string): boolean {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return true
    if (dirname(directory) === directory) return false
  }
}

/** Decide where the token goes, and refuse before anything is issued if there is nowhere safe to put it. */
function planDelivery(consumer: string, options: AddOptions, deps: ReaderDeps): PlanResult {
  const repos = options.repo ?? []
  if (repos.length > 0) {
    if (options.file !== undefined || options.print === true) {
      return {ok: false, error: '--repo delivers to a GitHub Actions secret: drop --file and --print.'}
    }
    const secretName = options.secretName ?? DEFAULT_READER_SECRET_NAME
    if (!SECRET_NAME_SHAPE.test(secretName)) {
      return {
        ok: false,
        error: 'Invalid --secret-name: use upper-case letters, digits and underscores, not starting with a digit.',
      }
    }
    for (const repo of repos) {
      if (!REPO_SHAPE.test(repo)) return {ok: false, error: 'Invalid --repo: expected OWNER/REPO.'}
    }
    return {
      ok: true,
      plan: {
        kind: 'github',
        secretName,
        targets: repos.map(repo => ({
          label: `repository ${repo}`,
          command: ['gh', 'secret', 'set', secretName, '--repo', repo],
        })),
      },
    }
  }
  if (options.secretName !== undefined) return {ok: false, error: '--secret-name needs --repo.'}

  if (options.print === true) {
    if (options.file !== undefined) return {ok: false, error: '--print and --file are two destinations: pick one.'}
    if (!(deps.isTty ?? process.stdout.isTTY === true)) {
      return {
        ok: false,
        error: 'Refusing to print a token to something that is not a terminal. Write the file instead.',
      }
    }
    return {ok: true, plan: {kind: 'terminal'}}
  }

  const home = deps.homeDir ?? process.env.HOME
  const requested =
    options.file ?? (home === undefined || home === '' ? undefined : defaultWorkstationFile(home, consumer))
  if (requested === undefined) return {ok: false, error: 'No home directory to put the token file in: pass --file.'}
  const path = resolve(requested)
  if (insideCheckout(path)) {
    return {ok: false, error: 'The token file would be inside a git checkout. Pass a --file outside any checkout.'}
  }
  if (existsSync(path) && options.replace !== true) {
    return {ok: false, error: 'The token file already exists. Pass --replace to replace it, or another --file.'}
  }
  return {ok: true, plan: {kind: 'file', path}}
}

/** An exclusive 0600 file; with `replace`, a new 0600 file renamed over the old one. */
function writeWorkstationFile(path: string, token: string, replace: boolean): void {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700})
  const target = replace && existsSync(path) ? `${path}.new` : path
  // `wx` fails if the path exists: a file is never overwritten in place, and a symlink is never followed.
  const fd = openSync(target, 'wx', 0o600)
  try {
    writeSync(fd, token)
  } finally {
    closeSync(fd)
  }
  try {
    chmodSync(target, 0o600)
    if (target !== path) renameSync(target, path)
  } catch (error) {
    if (target !== path) rmSync(target, {force: true})
    throw error
  }
}

async function deliver(
  consumer: string,
  plan: DeliveryPlan,
  token: string,
  fingerprint: string,
  options: AddOptions,
  ctx: ActionCtx,
  out: Out,
  deps: ReaderDeps,
): Promise<{ok: true} | {ok: false; error: string}> {
  if (plan.kind === 'terminal') {
    // The one deliberate print of a token, to the operator's own terminal, once.
    out.log(`New ${consumer} token (fingerprint ${fingerprint}). It is shown once and is stored nowhere else:`)
    ctx.console.log(token)
    return {ok: true}
  }
  if (plan.kind === 'file') {
    try {
      writeWorkstationFile(plan.path, token, options.replace === true)
    } catch (error) {
      return {
        ok: false,
        error: `the token file could not be written (${error instanceof Error ? error.message : 'error'})`,
      }
    }
    out.log(`Wrote the ${consumer} token to ${plan.path} (mode 0600).`)
    return {ok: true}
  }
  const done: string[] = []
  for (const target of plan.targets) {
    const result = await setGithubSecret(target.command, token, deps.spawn)
    if (!result.ok) {
      return {
        ok: false,
        error: `delivery to ${target.label} failed (${result.error}). ${
          done.length === 0 ? 'It was delivered nowhere.' : `It was delivered to: ${done.join('; ')}.`
        }`,
      }
    }
    done.push(target.label)
    out.log(`Delivered to ${target.label} as secret ${plan.secretName}.`)
  }
  return {ok: true}
}

// ─── Removing tokens ──────────────────────────────────────────────────────────

type RemoveResult = {ok: true; removed: number; real: number; bad: number} | {ok: false; error: string}

/** Remove the consumer's lines (or only the one with `fingerprint`) and say what the host did. */
async function removeLines(
  host: string,
  consumer: string,
  fingerprint: string | undefined,
  secrets: string[],
  deps: ReaderDeps,
): Promise<RemoveResult> {
  const voidToken = generateVoidToken(deps.randomBytes)
  secrets.push(voidToken)
  const voidLine = formatVoidLine(voidToken, (deps.now?.() ?? new Date()).toISOString())
  const removed = await runRemote(host, READER_REMOTE.remove, {
    ...remoteOptions(deps),
    stdin: `${consumer} ${fingerprint ?? '-'}\n${voidLine}`,
  })
  if (isLockBusy(removed)) return {ok: false, error: LOCK_BUSY_MESSAGE}
  if (!hasSentinel(removed, readerSentinel('remove'))) {
    return {
      ok: false,
      error: `the host did not confirm the removal (exit ${removed.exitCode}: ${removed.stderr || 'no confirmation'})`,
    }
  }
  return {
    ok: true,
    removed: countOf(removed.stdout, REMOVED_PREFIX),
    real: countOf(removed.stdout, REAL_PREFIX),
    bad: countOf(removed.stdout, BAD_PREFIX),
  }
}

const HOLD_HINT =
  'This is an emergency: run `infra traces reader revoke --all` now, then find out why the gate still accepts it.'

/** Prove every removed token refused on both routes. Prints one error per route that is not. */
async function proveRefused(
  label: string,
  tokens: readonly string[],
  route: Route,
  out: Out,
  deps: ReaderDeps,
): Promise<boolean> {
  let ok = true
  for (const token of tokens) {
    for (const proof of await proveOnRoutes(route, token, isRefused, deps)) {
      if (proof.proven) continue
      ok = false
      out.error(
        proof.last !== 'none' && isSuccess(proof.last)
          ? `${label} was removed from the file but is still accepted: ${route.label} answered ${describeStatus(proof.last)} on the ${proof.route} route. ${HOLD_HINT}`
          : `${label} was removed from the file, but its refusal on the ${proof.route} route could not be proven: ${route.label} answered ${describeStatus(proof.last)}. Do not rely on it until a check answers 401. If it may still be accepted, run \`infra traces reader revoke --all\`.`,
      )
    }
  }
  return ok
}

// ─── add ──────────────────────────────────────────────────────────────────────

async function addFlow(
  consumer: string,
  options: AddOptions,
  ctx: ActionCtx,
  out: Out,
  secrets: string[],
  deps: ReaderDeps,
): Promise<boolean> {
  if (!CONSUMER_PATTERN.test(consumer)) {
    out.error(
      'Invalid consumer name: lower-case letters, digits and hyphens, starting with a letter, 31 characters at most.',
    )
    return false
  }
  const planned = planDelivery(consumer, options, deps)
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
  const replace = options.replace === true

  // Everything above, and the read below, can refuse without having issued anything.
  const existing = await readEntries(host, replace ? 'lines' : 'list', deps)
  if (!existing.ok) {
    out.error(`Could not read the reader token file on the host (${existing.error}). Nothing was changed.`)
    return false
  }
  for (const entry of existing.entries) {
    if (entry.token !== undefined) secrets.push(entry.token)
  }
  if (existing.bad > 0) {
    out.error(`${malformedMessage(existing.bad)} Nothing was changed.`)
    return false
  }
  const previous = existing.entries.filter(entry => entry.consumer === consumer)
  if (previous.length > 0 && !replace) {
    out.error(
      `${consumer} already has a reader token (${previous.map(entry => entry.fingerprint).join(', ')}). Pass --replace to install a new one beside it and remove the old one after delivery, or revoke it first with: infra traces reader revoke ${consumer}`,
    )
    return false
  }
  const replacing = previous.length > 0

  const {token, fingerprint} = generateToken(deps.randomBytes)
  secrets.push(token)
  const createdAt = (deps.now?.() ?? new Date()).toISOString()

  const written = await runRemote(host, READER_REMOTE.append, {
    ...remoteOptions(deps),
    stdin: `${token} ${fingerprint} ${consumer} ${createdAt}\n`,
  })
  if (isLockBusy(written)) {
    out.error(LOCK_BUSY_MESSAGE)
    return false
  }
  if (!hasSentinel(written, readerSentinel('append'))) {
    out.error(
      `The host did not confirm the write (exit ${written.exitCode}: ${written.stderr || 'no confirmation'}). The ${consumer} token ${fingerprint} may or may not be in the token file, and it was not delivered anywhere. To see whether it landed, run: infra traces reader list. If it did, remove it with: infra traces reader revoke ${consumer} ${fingerprint}`,
    )
    return false
  }
  out.log(`Token ${fingerprint} written to the reader token file for ${consumer}.`)

  const route = await chooseRoute(host, origin, deps)
  const live = await proveOnRoutes(route, token, isSuccess, deps)
  if (!live.every(proof => proof.proven)) {
    out.error(
      `Token ${fingerprint} is in the reader token file but is not live: ${route.label} answered ${describeProofs(live)}. Removing it.`,
    )
    await revokeNew(host, consumer, fingerprint, token, route, out, secrets, deps)
    return false
  }
  out.log(`Token ${fingerprint} is live: ${route.label} answered ${describeProofs(live)}.`)

  const delivered = await deliver(consumer, planned.plan, token, fingerprint, options, ctx, out, deps)
  if (!delivered.ok) {
    if (replacing) {
      out.error(
        `The ${consumer} token ${fingerprint} is live, but ${delivered.error} The consumer may or may not hold it, so neither token was revoked. The consumer now has ${previous.length + 1} tokens.`,
      )
      out.error(`If the new token did not arrive, revoke it: infra traces reader revoke ${consumer} ${fingerprint}`)
      for (const entry of previous) {
        out.error(
          `Once the consumer uses the new one, revoke the old one: infra traces reader revoke ${consumer} ${entry.fingerprint}`,
        )
      }
      return false
    }
    out.error(
      `The ${consumer} token ${fingerprint} was live, but ${delivered.error} The token is not shown. Revoking it: nobody held it, so run add again.`,
    )
    await revokeNew(host, consumer, fingerprint, token, route, out, secrets, deps)
    return false
  }

  if (!replacing) return true
  let ok = true
  for (const entry of previous) {
    const removed = await removeLines(host, consumer, entry.fingerprint, secrets, deps)
    if (!removed.ok) {
      out.error(
        `${removed.error}. The old token ${entry.fingerprint} may still be accepted: check \`infra traces reader list\`.`,
      )
      ok = false
      continue
    }
    const refused =
      entry.token === undefined
        ? false
        : await proveRefused(`Old token ${entry.fingerprint}`, [entry.token], route, out, deps)
    if (refused) {
      out.log(`Old token ${entry.fingerprint} removed: ${route.label} answers 401 for it on both routes.`)
    } else {
      ok = false
    }
  }
  return ok
}

/** Take a token this command wrote back out and prove it refused; say what is left to do if that does not work. */
async function revokeNew(
  host: string,
  consumer: string,
  fingerprint: string,
  token: string,
  route: Route,
  out: Out,
  secrets: string[],
  deps: ReaderDeps,
): Promise<void> {
  const removed = await removeLines(host, consumer, fingerprint, secrets, deps)
  if (!removed.ok) {
    out.error(
      `${removed.error}. Token ${fingerprint} may still be in the file: run \`infra traces reader revoke ${consumer} ${fingerprint}\`.`,
    )
    return
  }
  if (await proveRefused(`Token ${fingerprint}`, [token], route, out, deps)) {
    out.log(`Token ${fingerprint} was removed and is refused on both routes. Run add again.`)
  }
}

export async function tracesReaderAddAction(
  consumer: string,
  options: AddOptions,
  ctx: ActionCtx,
  deps: ReaderDeps = {},
): Promise<void> {
  const secrets: string[] = []
  // The exit comes after the session ends: `ctx.process.exit` would skip closing the connection.
  const ok = await withRemoteSession(deps.spawn, session =>
    guarded(ctx, secrets, out => addFlow(consumer, options, ctx, out, secrets, {...deps, session})),
  )
  if (!ok) ctx.process.exit(1)
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function tracesReaderListAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  deps: ReaderDeps = {},
): Promise<void> {
  const ok = await withRemoteSession(deps.spawn, session =>
    guarded(ctx, [], out => listFlow(options, out, {...deps, session})),
  )
  if (!ok) ctx.process.exit(1)
}

async function listFlow(options: {key?: string | undefined}, out: Out, deps: ReaderDeps): Promise<boolean> {
  const targets = resolveTargets(options.key, false)
  if (!targets.ok) {
    out.error(targets.error)
    return false
  }
  const result = await readEntries(targets.host, 'list', deps)
  if (!result.ok) {
    out.error(`The reader token file could not be read (${result.error}).`)
    return false
  }
  if (result.entries.length === 0) out.log('(no reader tokens)')
  const consumers = [...new Set(result.entries.map(entry => entry.consumer))].sort()
  for (const consumer of consumers) {
    const own = result.entries.filter(entry => entry.consumer === consumer)
    out.log(consumer)
    for (const entry of own) out.log(`  ${entry.fingerprint}  ${entry.date}`)
    if (own.length > 1) {
      out.log(
        `  ! ${consumer} has ${own.length} tokens: a replacement did not finish. Revoke the one it no longer uses: infra traces reader revoke ${consumer} <fingerprint>`,
      )
    }
  }
  if (result.bad > 0) {
    out.error(malformedMessage(result.bad))
    return false
  }
  return true
}

// ─── revoke ───────────────────────────────────────────────────────────────────

export interface RevokeOptions {
  key?: string | undefined
  all?: boolean | undefined
}

const FINGERPRINT_SHAPE = /^[\da-f]{12}$/

async function revokeOne(
  consumer: string | undefined,
  fingerprintInput: string | undefined,
  options: RevokeOptions,
  out: Out,
  secrets: string[],
  deps: ReaderDeps,
): Promise<boolean> {
  if (consumer === undefined || !CONSUMER_PATTERN.test(consumer)) {
    out.error(
      consumer === undefined
        ? 'Name a consumer (and optionally one fingerprint), or pass --all.'
        : 'Invalid consumer name: lower-case letters, digits and hyphens, starting with a letter, 31 characters at most.',
    )
    return false
  }
  const fingerprint = fingerprintInput?.toLowerCase()
  if (fingerprint !== undefined && !FINGERPRINT_SHAPE.test(fingerprint)) {
    // The input is not echoed: it may be a token pasted in the wrong place.
    out.error('A fingerprint is 12 hexadecimal characters, as `infra traces reader list` prints them.')
    return false
  }
  const targets = resolveTargets(options.key, true)
  if (!targets.ok) {
    out.error(targets.error)
    return false
  }
  const {host, origin} = targets

  // The token text is read first, into memory, because the proof needs it after the line is gone.
  const current = await readEntries(host, 'lines', deps)
  if (!current.ok) {
    out.error(`Could not read the reader token file on the host (${current.error}). Nothing was changed.`)
    return false
  }
  for (const entry of current.entries) {
    if (entry.token !== undefined) secrets.push(entry.token)
  }
  const matches = current.entries.filter(
    entry => entry.consumer === consumer && (fingerprint === undefined || entry.fingerprint === fingerprint),
  )
  const tokens = matches.flatMap(entry => (entry.token === undefined ? [] : [entry.token]))
  if (tokens.length === 0) {
    const present = current.entries.filter(entry => entry.consumer === consumer).map(entry => entry.fingerprint)
    out.error(
      fingerprint === undefined
        ? `${consumer} holds no reader token. Consumers present: ${[...new Set(current.entries.map(entry => entry.consumer))].join(', ') || '(none)'}. Nothing was changed.`
        : `No reader token of ${consumer} has fingerprint ${fingerprint}. Fingerprints present: ${present.length === 0 ? '(none)' : present.join(', ')}. Nothing was changed.`,
    )
    return false
  }

  const removed = await removeLines(host, consumer, fingerprint, secrets, deps)
  if (!removed.ok) {
    out.error(`${removed.error}. The tokens may still be in the file. Check \`infra traces reader list\`.`)
    return false
  }

  const route = await chooseRoute(host, origin, deps)
  const label =
    fingerprint === undefined
      ? `${consumer}: ${matches.map(entry => entry.fingerprint).join(', ')}`
      : `Token ${fingerprint} (${consumer})`
  if (!(await proveRefused(label, tokens, route, out, deps))) return false

  if (removed.removed !== tokens.length) {
    out.error(
      `${label} was refused, but the host removed ${Number.isNaN(removed.removed) ? 'an unknown number of' : removed.removed} lines where ${tokens.length} were expected. The file changed while this ran: check \`infra traces reader list\`.`,
    )
    return false
  }
  out.log(`${label} revoked: ${route.label} answered 401 for ${tokens.length === 1 ? 'it' : 'each'} on both routes.`)
  if (removed.real === 0) out.log('No reader token remains. The file holds one void line, so the gate accepts nothing.')
  if (removed.bad > 0) out.error(malformedMessage(removed.bad))
  return true
}

async function revokeAll(options: RevokeOptions, out: Out, secrets: string[], deps: ReaderDeps): Promise<boolean> {
  const targets = resolveTargets(options.key, true)
  if (!targets.ok) {
    out.error(targets.error)
    return false
  }
  const {host, origin} = targets

  const current = await readEntries(host, 'lines', deps)
  if (!current.ok) {
    out.error(`Could not read the reader token file on the host (${current.error}); it was not rewritten.`)
    return false
  }
  for (const entry of current.entries) {
    if (entry.token !== undefined) secrets.push(entry.token)
  }

  // A new void line every time, so the file always changes and is never empty.
  const voidToken = generateVoidToken(deps.randomBytes)
  secrets.push(voidToken)
  const denied = await runRemote(host, READER_REMOTE.deny, {
    ...remoteOptions(deps),
    stdin: formatVoidLine(voidToken, (deps.now?.() ?? new Date()).toISOString()),
  })
  if (isLockBusy(denied)) {
    out.error(`${LOCK_BUSY_MESSAGE} The file was not rewritten.`)
    return false
  }
  if (!hasSentinel(denied, readerSentinel('deny'))) {
    out.error(
      `The host did not confirm the file was rewritten (exit ${denied.exitCode}: ${denied.stderr || 'no confirmation'}). Tokens may still be accepted.`,
    )
    return false
  }

  const route = await chooseRoute(host, origin, deps)
  let ok = true
  for (const entry of current.entries) {
    if (entry.token === undefined) continue
    if (await proveRefused(`${entry.consumer}: ${entry.fingerprint}`, [entry.token], route, out, deps)) {
      out.log(`${entry.consumer}: removed ${entry.fingerprint}; both routes answer 401 for it.`)
    } else {
      ok = false
    }
  }
  if (!ok) return false
  out.log('No reader token remains: the file holds one void line, so the gate accepts nothing.')
  out.log(
    'Copies still exist where the tokens were delivered (GitHub Actions secrets, workstation files): they are dead, but delete them. Issue new tokens with `infra traces reader add`.',
  )
  return true
}

export async function tracesReaderRevokeAction(
  consumer: string | undefined,
  fingerprint: string | undefined,
  options: RevokeOptions,
  ctx: ActionCtx,
  deps: ReaderDeps = {},
): Promise<void> {
  const secrets: string[] = []
  const ok = await withRemoteSession(deps.spawn, session =>
    guarded(ctx, secrets, async out => {
      const withSession = {...deps, session}
      if (options.all === true) {
        if (consumer !== undefined || fingerprint !== undefined) {
          out.error('--all takes no consumer and no fingerprint.')
          return false
        }
        return revokeAll(options, out, secrets, withSession)
      }
      return revokeOne(consumer, fingerprint, options, out, secrets, withSession)
    }),
  )
  if (!ok) ctx.process.exit(1)
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerTracesReader(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'traces reader add <consumer>',
      `Issue a reader token for a consumer (lower-case name). Writes it to the host, proves both agent routes accept it, then delivers it once: to a GitHub Actions secret (${DEFAULT_READER_SECRET_NAME} by default) with --repo, otherwise to a 0600 file on this machine.`,
    )
    .option('--repo [repo]', z.array(z.string()).describe('OWNER/REPO to set the Actions secret on (repeatable).'))
    .option('--secret-name [name]', z.string().describe(`Secret name. Default ${DEFAULT_READER_SECRET_NAME}.`))
    .option(
      '--file [path]',
      z.string().describe('Workstation token file. Default ~/.config/infra/traces-reader-<consumer>.token.'),
    )
    .option('--print', 'Show the token on this terminal instead of writing a file. Refused when not a terminal.')
    .option('--replace', "Replace the consumer's existing token: install the new one, deliver it, then remove the old.")
    .option('--key [key]', keyOption)
    .action((consumer, options, ctx) => tracesReaderAddAction(consumer, options, ctx))

  cli
    .command('traces reader list', 'List reader tokens per consumer: fingerprint and date. Never token text.')
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesReaderListAction(options, ctx))

  cli
    .command(
      'traces reader revoke [consumer] [fingerprint]',
      'Remove every reader token of a consumer, or one by fingerprint, and prove both routes now answer 401. With --all (no consumer, no fingerprint): make the file deny-all, the reader kill switch.',
    )
    .option('--all', 'Make the reader token file deny-all and prove every old token is refused.')
    .option('--key [key]', keyOption)
    .action((consumer, fingerprint, options, ctx) => tracesReaderRevokeAction(consumer, fingerprint, options, ctx))
}
