/* eslint-disable no-template-curly-in-string -- the host scripts are shell text, and `${...}` is shell expansion */
import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {FetchLike} from './ingest'
import type {RemoteDeps, RemoteResult, RunRemoteOptions} from './remote'

import {randomBytes} from 'node:crypto'
import {chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'

import {z} from 'zod'

import {TRACES_READER_DIR, TRACES_READER_LOCK} from './host'
import {hasSentinel, REMOTE_DEADLINE_MS, runRemote, withRemoteSession} from './remote'
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
  ONE_READER_COMMAND_AT_A_TIME,
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

/** What `append` prints, and exits non-zero, when a fresh add finds a line for the consumer already in the file. */
export const READER_CONSUMER_EXISTS_SENTINEL = 'TRACES_READER_CONSUMER_EXISTS'

const ENTRY_PREFIX = 'TRACES_READER '
const REMOVED_PREFIX = 'TRACES_READER_REMOVED='
const REAL_PREFIX = 'TRACES_READER_REAL='
const BAD_PREFIX = 'TRACES_READER_BAD='
const PROBE_PREFIX = 'TRACES_READER_PROBE_STATUS='
const DENY_FP_PREFIX = 'TRACES_READER_DENY_FP='
const DENY_LINES_PREFIX = 'TRACES_READER_DENY_LINES='
const DENY_VOID_PREFIX = 'TRACES_READER_DENY_VOID='

/** The directory, the token file in it, and a refusal to go on when the file is a directory. */
const LOCATE = [`d=${TRACES_READER_DIR}`, 'f="$d/token"', 'test -d "$d"', 'test ! -d "$f"']

const LOCK = lockFlock(TRACES_READER_LOCK, READER_LOCK_BUSY_SENTINEL)

/** The characters the gate's `trim()` strips from a blank line, as ASCII: space, tab, CR, form feed, vertical tab. */
const BLANK_CHARACTERS = String.raw`ws=$(printf ' \t\r\f\v')`

const shellFunction = (name: string, ...body: string[]): string => `${name}() { ${body.join('; ')}; }`

/** The gate's `TOKEN_PATTERN` (`^trc_[\w-]{32,128}$`): `trc_` and 32 to 128 characters of `[A-Za-z0-9_-]`. */
const IS_TOKEN = shellFunction(
  'istoken',
  'case "$1" in trc_*) ;; *) return 1 ;; esac',
  'case "$1" in *[!A-Za-z0-9_-]*) return 1 ;; esac',
  '[ "${#1}" -ge 36 ] && [ "${#1}" -le 132 ]',
)

/**
 * The gate's `isDate`: `YYYY-MM-DDT<time>Z` where the time is `HH:MM`, `HH:MM:SS` or `HH:MM:SS.f` (one digit or more) and
 * the date and time are in range. The gate asks `Date.parse`, which takes day 1 to 31 of any month, hour 24 only as
 * `24:00:00`, minute and second 0 to 59.
 */
const IS_DATE = shellFunction(
  'isdate',
  'case "$1" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z) ;; *) return 1 ;; esac',
  'dm=${1#*-}; mo=${dm%%-*}; dd=${dm#*-}; dd=${dd%%T*}; tm=${1#*T}; tm=${tm%Z}',
  '[ "$mo" -ge 1 ] && [ "$mo" -le 12 ] && [ "$dd" -ge 1 ] && [ "$dd" -le 31 ] || return 1',
  'fr=0',
  'case "$tm" in [0-9][0-9]:[0-9][0-9]) hh=${tm%%:*}; mi=${tm#*:}; ss=0 ;; [0-9][0-9]:[0-9][0-9]:[0-9][0-9]) hh=${tm%%:*}; tr=${tm#*:}; mi=${tr%%:*}; ss=${tr#*:} ;; [0-9][0-9]:[0-9][0-9]:[0-9][0-9].*) hh=${tm%%:*}; tr=${tm#*:}; mi=${tr%%:*}; ss=${tr#*:}; fr=${ss#*.}; ss=${ss%%.*}; case "$fr" in ""|*[!0-9]*) return 1 ;; esac ;; *) return 1 ;; esac',
  '[ "$mi" -le 59 ] && [ "$ss" -le 59 ] || return 1',
  '[ "$hh" -le 23 ] && return 0',
  '[ "$hh" -eq 24 ] && [ "$mi" -eq 0 ] && [ "$ss" -eq 0 ] || return 1',
  'case "$fr" in *[!0]*) return 1 ;; esac',
)

/**
 * `classify "$line"` sets `kind` to `blank`, `real`, `void` or `bad`, and `tok`, `f2`, `f3`, `f4` to the first four
 * fields. It mirrors the gate's parser (`apps/traces/reader-gate/tokens.ts`) rule for rule, and the fields are split the
 * same way: on single spaces only, so a doubled space, a leading or trailing space or a tab is a field of its own or part
 * of one, and the line is `bad`. A blank line (only ASCII whitespace) is skipped, as the gate skips it. A real line is
 * exactly four fields (token, fingerprint, consumer, date), the fingerprint is the first 12 hex characters of the token's
 * SHA-256, and a void line is exactly three (a void token, `void`, a date). A line that is none of these is `bad`, and
 * the gate denies the whole file for it. A test holds this to the gate on a list of files.
 */
const CLASSIFY = [
  BLANK_CHARACTERS,
  IS_TOKEN,
  IS_DATE,
  shellFunction(
    'classify',
    'tok=; f2=; f3=; f4=; nf=1; kind=bad',
    'case "$1" in *[!"$ws"]*) ;; *) kind=blank; return 0 ;; esac',
    'tok=${1%% *}; rest=${1#"$tok"}',
    'if [ -n "$rest" ]; then rest=${rest# }; nf=2; f2=${rest%% *}; rest=${rest#"$f2"}; fi',
    'if [ "$nf" -ge 2 ] && [ -n "$rest" ]; then rest=${rest# }; nf=3; f3=${rest%% *}; rest=${rest#"$f3"}; fi',
    'if [ "$nf" -ge 3 ] && [ -n "$rest" ]; then rest=${rest# }; nf=4; f4=${rest%% *}; rest=${rest#"$f4"}; fi',
    'if [ "$nf" -ge 4 ] && [ -n "$rest" ]; then nf=5; fi',
    'case "$tok" in trc_void_*) if [ "$nf" -eq 3 ] && [ "$f2" = void ] && istoken "$tok" && isdate "$f3"; then kind=void; fi; return 0 ;; esac',
    '[ "$nf" -eq 4 ] || return 0',
    'istoken "$tok" || return 0',
    'case "$f2" in *[!0-9a-f]*|"") return 0 ;; ????????????) ;; *) return 0 ;; esac',
    'case "$f3" in [a-z]*) ;; *) return 0 ;; esac',
    'case "$f3" in *[!a-z0-9-]*) return 0 ;; esac',
    '[ "${#f3}" -le 31 ] || return 0',
    'isdate "$f4" || return 0',
    'h=$(printf %s "$tok" | sha256sum | cut -c1-12)',
    '[ "$h" = "$f2" ] || return 0',
    'kind=real',
  ),
].join('; ')

/**
 * One loop over the token file, a line at a time. `kind`, `tok` and the fields are set by `classify`; a blank line is
 * skipped. A last line with no newline counts. The caller closes it with `; done < "$f"`.
 */
const EACH_LINE =
  'while IFS= read -r line || [ -n "$line" ]; do classify "$line"; if [ "$kind" = blank ]; then continue; fi'

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
  // A token twice is one the gate refuses (its map would hold it once): the second line is malformed. A file with no
  // line at all is `empty` to the gate, which denies everything.
  const each = `${EACH_LINE}; nonblank=$((nonblank+1)); if [ "$kind" = real ]; then case "$seen" in *" $tok "*) kind=bad ;; *) seen="$seen$tok " ;; esac; fi; case "$kind" in real) ${print} ;; void) ;; *) bad=$((bad+1)) ;; esac; done < "$f"`
  return script(
    'set -e',
    ...LOCATE,
    CLASSIFY,
    'bad=0',
    'nonblank=0',
    "seen=' '",
    `if [ -f "$f" ]; then ${each}; if [ "$nonblank" -eq 0 ]; then bad=$((bad+1)); fi; fi`,
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
   * Append the line on stdin line 1 to the token file by writing a new file and renaming it over the old one. The line
   * must classify as a reader line (four fields, the fingerprint of its token), or nothing is touched. Stdin line 2 is
   * `replace` when the new line goes beside the consumer's old one; anything else, or no line, is a fresh add. A fresh
   * add also rechecks under the lock that the file holds no reader line for the consumer, and when it does prints
   * `TRACES_READER_CONSUMER_EXISTS` and exits 1 without writing: the check the caller made before the lock can be
   * stale. Run one reader command at a time: nothing here guards against a `revoke --all` between the caller's read
   * and this write.
   */
  append: script(
    'set -e',
    'IFS= read -r line',
    'IFS= read -r mode || mode=',
    CLASSIFY,
    'classify "$line"',
    '[ "$kind" = real ]',
    'nl="$tok $f2 $f3 $f4"',
    'who="$f3"',
    ...LOCK,
    ...LOCATE,
    `if [ "$mode" != replace ] && [ -f "$f" ]; then ${EACH_LINE}; if [ "$kind" = real ] && [ "$f3" = "$who" ]; then echo ${READER_CONSUMER_EXISTS_SENTINEL}; exit 1; fi; done < "$f"; fi`,
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
  /**
   * Replace the file with the void line on stdin and nothing else (deny-all), by the same write-and-rename. Under the
   * same lock, first print the fingerprint of every reader line it is about to replace (`TRACES_READER_DENY_FP=`), so
   * the caller can prove refusal for exactly those tokens. Then read the file back, still under the lock, and print how
   * many lines it holds and how many are void lines: the caller requires one and one.
   */
  deny: script(
    'set -e',
    ...READ_VOID_LINE,
    CLASSIFY,
    ...LOCK,
    ...LOCATE,
    ...TEMP_FILE,
    COPY_ATTRIBUTES,
    `if [ -f "$f" ]; then while IFS= read -r line || [ -n "$line" ]; do classify "$line"; if [ "$kind" = real ]; then echo ${DENY_FP_PREFIX}$f2; fi; done < "$f"; fi`,
    String.raw`printf "%s\n" "$vl" > "$t"`,
    'mv -f "$t" "$f"',
    'n=0',
    'v=0',
    `while IFS= read -r line || [ -n "$line" ]; do classify "$line"; case "$kind" in blank) ;; void) n=$((n+1)); v=$((v+1)) ;; *) n=$((n+1)) ;; esac; done < "$f"`,
    `echo ${DENY_LINES_PREFIX}$n`,
    `echo ${DENY_VOID_PREFIX}$v`,
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
  /** How long one remote call may take. Defaults to `REMOTE_DEADLINE_MS`. */
  deadlineMs?: number | undefined
}

const REQUEST_TIMEOUT_MS = 10_000

/** Every call gets its own deadline: a host that stops answering fails the command instead of holding it. */
const remoteOptions = (deps: ReaderDeps): RunRemoteOptions => ({
  spawn: deps.spawn,
  session: deps.session,
  signal: AbortSignal.timeout(deps.deadlineMs ?? REMOTE_DEADLINE_MS),
})

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

const isConsumerExists = (result: RemoteResult): boolean =>
  result.exitCode !== 0 && result.stdout.split('\n').some(line => line.trim() === READER_CONSUMER_EXISTS_SENTINEL)

const alreadyHasTokenMessage = (consumer: string, fingerprints: readonly string[]): string =>
  `${consumer} already has a reader token${fingerprints.length > 0 ? ` (${fingerprints.join(', ')})` : ''}. Pass --replace to install a new one beside it and remove the old one after delivery, or revoke it first with: infra traces reader revoke ${consumer}`

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

/**
 * An exclusive 0600 file; with `replace`, a new 0600 file renamed over the old one. The staging file has a name of
 * its own on every run, so one left by an interrupted run never blocks a retry, and it is removed on any failure.
 */
function writeWorkstationFile(path: string, token: string, replace: boolean): void {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700})
  const staging = replace && existsSync(path)
  const target = staging ? `${path}.${randomBytes(8).toString('hex')}.tmp` : path
  // `wx` fails if the path exists: a file is never overwritten in place, and a symlink is never followed. Past this
  // line `target` is a file this call created, so removing it on failure removes nothing else.
  const fd = openSync(target, 'wx', 0o600)
  try {
    try {
      writeSync(fd, token)
    } finally {
      closeSync(fd)
    }
    chmodSync(target, 0o600)
    if (staging) renameSync(target, path)
  } catch (error) {
    rmSync(target, {force: true})
    throw error
  }
}

/** `delivered` and `pending` name the destinations that hold the token and those that do not; empty for a file or a terminal. */
type Delivery = {ok: true} | {ok: false; error: string; delivered: string[]; pending: string[]}

async function deliver(
  consumer: string,
  plan: DeliveryPlan,
  token: string,
  fingerprint: string,
  options: AddOptions,
  ctx: ActionCtx,
  out: Out,
  deps: ReaderDeps,
): Promise<Delivery> {
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
        delivered: [],
        pending: [],
      }
    }
    out.log(`Wrote the ${consumer} token to ${plan.path} (mode 0600).`)
    return {ok: true}
  }
  const done: string[] = []
  for (const [index, target] of plan.targets.entries()) {
    const result = await setGithubSecret(target.command, token, deps.spawn)
    if (!result.ok) {
      return {
        ok: false,
        error: `delivery to ${target.label} failed (${result.error}).${done.length === 0 ? ' It was delivered nowhere.' : ''}`,
        delivered: done,
        pending: plan.targets.slice(index).map(entry => entry.label),
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
      alreadyHasTokenMessage(
        consumer,
        previous.map(entry => entry.fingerprint),
      ),
    )
    return false
  }
  const replacing = previous.length > 0

  const {token, fingerprint} = generateToken(deps.randomBytes)
  secrets.push(token)
  const createdAt = (deps.now?.() ?? new Date()).toISOString()

  const written = await runRemote(host, READER_REMOTE.append, {
    ...remoteOptions(deps),
    stdin: `${token} ${fingerprint} ${consumer} ${createdAt}\n${replace ? 'replace' : 'fresh'}\n`,
  })
  if (isLockBusy(written)) {
    out.error(LOCK_BUSY_MESSAGE)
    return false
  }
  if (isConsumerExists(written)) {
    // Another add for this consumer landed after the read above. The host refused under the lock and wrote nothing, so
    // the new token is in no file and there is nothing to revoke.
    out.error(
      `${alreadyHasTokenMessage(consumer, [])} Another command added it after this one checked, so nothing was written.`,
    )
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
    const partial = delivered.delivered.length > 0
    const where = partial
      ? ` Delivered to: ${delivered.delivered.join(', ')}. Not delivered to: ${delivered.pending.join(', ')}.`
      : ''
    if (replacing) {
      out.error(
        `The ${consumer} token ${fingerprint} is live, but ${delivered.error}${where} The consumer may or may not hold it, so neither token was revoked. The consumer now has ${previous.length + 1} tokens.`,
      )
      out.error(`If the new token did not arrive, revoke it: infra traces reader revoke ${consumer} ${fingerprint}`)
      for (const entry of previous) {
        out.error(
          `Once the consumer uses the new one, revoke the old one: infra traces reader revoke ${consumer} ${entry.fingerprint}`,
        )
      }
      return false
    }
    if (partial) {
      // Some destination holds it, so revoking would break that one. The state is uncertain: keep the token and say how to end it.
      out.error(
        `The ${consumer} token ${fingerprint} is live and was NOT revoked, because it reached some destinations: ${delivered.error}${where}`,
      )
      out.error(`To finish: ${finishCommand(consumer, options)}`)
      out.error(`To withdraw it instead: infra traces reader revoke ${consumer} ${fingerprint}`)
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

/** The command that ends a partial delivery: a new token to every destination, then the partly delivered one removed. */
function finishCommand(consumer: string, options: AddOptions): string {
  const repos = (options.repo ?? []).map(repo => `--repo ${repo}`).join(' ')
  const secret = options.secretName === undefined ? '' : ` --secret-name ${options.secretName}`
  return `infra traces reader add ${consumer} --replace ${repos}${secret}`
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

export interface ListOptions {
  key?: string | undefined
  /** One JSON object on standard output instead of text. */
  json?: boolean | undefined
}

export async function tracesReaderListAction(
  options: ListOptions,
  ctx: ActionCtx,
  deps: ReaderDeps = {},
): Promise<void> {
  const ok = await withRemoteSession(deps.spawn, session =>
    guarded(ctx, [], out => listFlow(options, out, {...deps, session})),
  )
  if (!ok) ctx.process.exit(1)
}

/** The roster as data: no token, no void line. `duplicates` are the consumers with more than one line. */
export interface ListReport {
  consumers: {consumer: string; fingerprint: string; date: string}[]
  duplicates: string[]
  malformed: number
}

function buildListReport(entries: readonly ReaderEntry[], malformed: number): ListReport {
  const names = [...new Set(entries.map(entry => entry.consumer))].sort()
  return {
    consumers: names.flatMap(name =>
      entries
        .filter(entry => entry.consumer === name)
        .map(({consumer, fingerprint, date}) => ({consumer, fingerprint, date})),
    ),
    duplicates: names.filter(name => entries.filter(entry => entry.consumer === name).length > 1),
    malformed,
  }
}

async function listFlow(options: ListOptions, out: Out, deps: ReaderDeps): Promise<boolean> {
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
  if (options.json === true) {
    out.log(JSON.stringify(buildListReport(result.entries, result.bad)))
    // The exit code is the text mode's: a file the gate would refuse fails the command.
    if (result.bad > 0) out.error(malformedMessage(result.bad))
    return result.bad === 0
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
const DENY_FP_LINE = new RegExp(String.raw`^${DENY_FP_PREFIX}([\da-f]{12})$`, 'gm')

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
  // The host read the file back under the same lock. Anything but the one void line means a writer that does not take
  // the lock got in, and the file is not deny-all.
  const lines = countOf(denied.stdout, DENY_LINES_PREFIX)
  const voids = countOf(denied.stdout, DENY_VOID_PREFIX)
  if (lines !== 1 || voids !== 1) {
    out.error(
      `The token file was rewritten, but a read-back under the lock did not hold exactly one void line (${Number.isNaN(lines) ? 'an unknown number of' : lines} lines, ${Number.isNaN(voids) ? 'an unknown number of' : voids} void). Another writer changed it, so the file is not deny-all and tokens may still be accepted. Run \`infra traces reader list\`, then run \`infra traces reader revoke --all\` again.`,
    )
    return false
  }

  // The lines the host replaced, by fingerprint, read under the lock. Refusal is proven for exactly those tokens whose
  // value this command holds (it read them before the lock). A fingerprint it holds no value for was added after that
  // read: the file is deny-all, but the refusal of that token cannot be proven from here.
  const replaced = new Set([...denied.stdout.matchAll(DENY_FP_LINE)].map(match => match[1]))
  const held = new Set(current.entries.filter(entry => entry.token !== undefined).map(entry => entry.fingerprint))
  const unknown = [...replaced].filter(fingerprint => fingerprint !== undefined && !held.has(fingerprint)).sort()
  if (unknown.length > 0) {
    out.error(
      `The host replaced ${unknown.length === 1 ? 'a line' : `${unknown.length} lines`} this command had not read (fingerprint ${unknown.join(', ')}): a token was added during revoke; run revoke --all again. The file is deny-all, but refusal of that token was not proven.`,
    )
  }

  const route = await chooseRoute(host, origin, deps)
  let ok = unknown.length === 0
  for (const entry of current.entries) {
    if (entry.token === undefined || !replaced.has(entry.fingerprint)) continue
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
      `Issue a reader token for a consumer (lower-case name). Writes it to the host, proves both agent routes accept it, then delivers it once: to a GitHub Actions secret (${DEFAULT_READER_SECRET_NAME} by default) with --repo, otherwise to a 0600 file on this machine. ${ONE_READER_COMMAND_AT_A_TIME}`,
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
    .command(
      'traces reader list',
      `List reader tokens per consumer: fingerprint and date. Never token text. ${ONE_READER_COMMAND_AT_A_TIME}`,
    )
    .option(
      '--json',
      z
        .boolean()
        .describe(
          'Output one JSON object: consumers (consumer, fingerprint, date), duplicates (consumers with more than one token) and malformed (a count). Exit codes are the same.',
        ),
    )
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesReaderListAction(options, ctx))

  cli
    .command(
      'traces reader revoke [consumer] [fingerprint]',
      `Remove every reader token of a consumer, or one by fingerprint, and prove both routes now answer 401. With --all (no consumer, no fingerprint): make the file deny-all, the reader kill switch. ${ONE_READER_COMMAND_AT_A_TIME}`,
    )
    .option('--all', 'Make the reader token file deny-all and prove every old token is refused.')
    .option('--key [key]', keyOption)
    .action((consumer, fingerprint, options, ctx) => tracesReaderRevokeAction(consumer, fingerprint, options, ctx))
}
