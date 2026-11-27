import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {RemoteDeps, RemoteResult} from './remote'

import * as clack from '@clack/prompts'
import {z} from 'zod'

import {
  READER_GRAFANA_PLACEHOLDER,
  READER_LANGFUSE_PLACEHOLDER,
  TRACES_APP_DIR,
  TRACES_GRAFANA_MCP_TOKEN_FILE,
  TRACES_READER_LANGFUSE_FILE,
} from './host'
import {hasSentinel, REMOTE_DEADLINE_MS, runRemote, withRemoteSession} from './remote'
import {guarded, keyOption, ONE_READER_COMMAND_AT_A_TIME, resolveTargets, script, type Out} from './token-common'

declare const process: {
  env: Record<string, string | undefined>
  stdin: {isTTY?: boolean}
}

// ─── Reader backend credentials ───────────────────────────────────────────────
//
// The gate reads Langfuse with a Viewer key pair and Grafana MCP reads Grafana with a Viewer service-account token.
// Both live in files on the host. These commands install, rotate and check them, and no credential ever reaches
// this terminal, an argv, a log or a GitHub secret:
//
//   - Langfuse: the operator creates a Viewer key in the UI (the one manual step) and pastes it at a hidden prompt.
//     It goes to the host on ssh stdin into a staged file, the gate's own check entrypoint proves it reads and that
//     Langfuse refuses a REST write and an MCP write by role, and only then is it switched in. The old pair stays as
//     `.previous` until the operator has deleted it in the UI and `--confirm-old-revoked` proves Langfuse refuses it.
//   - Grafana: the service account and its token are made on the host, with the admin password the host holds,
//     through Grafana's loopback API. The token is written by the host script straight into the staged file; only
//     numeric ids come back. The commit point is a Grafana MCP read through the gate after the switch.
//
// Every check goes through the gate container (`docker compose exec -T reader-gate bun /app/check.ts`), which talks
// to the upstream directly, so no reader token is needed and `reader add` has no bootstrap cycle with these.
//
// Run one `traces reader` command at a time; concurrent runs against the same host are not supported. There is no
// lock: the steps of one run are separate ssh calls, and what protects a run from its own interruption is a hash
// check of the staged Langfuse file before the switch, a hash check of the live Grafana file before cleanup, and a
// rollback when the Grafana commit throws.

const STAGED_SUFFIX = '.staged'
const PREVIOUS_SUFFIX = '.previous'

/** The old Langfuse pair, hard-linked here by the switch until the new pair is live. Not read by the gate. */
const TMP_SUFFIX = '.tmp'

/** The Langfuse pair as the gate container sees it; `check.ts` accepts the live, staged and previous names only. */
const GATE_LANGFUSE_FILE = '/run/secrets/reader-gate/langfuse-basic'

const COMPOSE = `docker compose --project-directory ${TRACES_APP_DIR}`

const GRAFANA_ADMIN_PASSWORD_FILE = `${TRACES_APP_DIR}/secrets/grafana/admin-password`
const GRAFANA_BASE = 'http://127.0.0.1:3001'

/** The service account the token belongs to, matched by exact name. */
export const GRAFANA_ACCOUNT_NAME = 'agent-reader'

const CREDENTIALS = {
  langfuse: {file: TRACES_READER_LANGFUSE_FILE, placeholder: READER_LANGFUSE_PLACEHOLDER},
  grafana: {file: TRACES_GRAFANA_MCP_TOKEN_FILE, placeholder: READER_GRAFANA_PLACEHOLDER},
} as const

type Credential = keyof typeof CREDENTIALS

const dirOf = (file: string): string => file.slice(0, file.lastIndexOf('/'))

// ─── Remote commands ──────────────────────────────────────────────────────────

const sentinels = {
  stage: 'TRACES_READER_BACKEND_STAGED',
  discard: 'TRACES_READER_BACKEND_DISCARDED',
  switched: 'TRACES_READER_BACKEND_SWITCHED',
  restore: 'TRACES_READER_BACKEND_RESTORED',
  drop: 'TRACES_READER_BACKEND_PREVIOUS_DROPPED',
  status: 'TRACES_READER_BACKEND_STATUS_DONE',
  api: 'TRACES_GRAFANA_API_DONE',
  createToken: 'TRACES_GRAFANA_CREATE_TOKEN_DONE',
  tokenCheck: 'TRACES_GRAFANA_TOKEN_CHECK_DONE',
  liveChecked: 'TRACES_GRAFANA_LIVE_CHECKED',
  settle: 'TRACES_READER_BACKEND_SETTLE_DONE',
} as const

/** Printed, with exit 1 and nothing changed, when the staged Langfuse file is not the one that was checked. */
export const STAGED_CHANGED_SENTINEL = 'TRACES_READER_BACKEND_STAGED_CHANGED'

/**
 * Printed, with exit 1, by a switch that found the leftover of an earlier switch that stopped part way. The leftover
 * is removed, the live pair is unchanged and the staged pair is kept.
 */
export const SWITCH_INCOMPLETE_SENTINEL = 'TRACES_READER_BACKEND_SWITCH_INCOMPLETE'

/** The same for the Grafana flow, whose token creation and gate read can each wait on Grafana. */
export const GRAFANA_REMOTE_DEADLINE_MS = 300_000

/** Printed, with exit 1 and nothing changed, when a previous pair is still waiting to be confirmed revoked. */
export const PREVIOUS_PENDING_SENTINEL = 'TRACES_READER_BACKEND_PREVIOUS_PENDING'

const HTTP_PREFIX = 'TRACES_GRAFANA_HTTP='
const BODY_PREFIX = 'TRACES_GRAFANA_BODY='
const TOKEN_ID_PREFIX = 'TRACES_GRAFANA_TOKEN_ID='
const STAGED_PREFIX = 'TRACES_GRAFANA_STAGED='
const KEPT_PREFIX = 'TRACES_READER_BACKEND_PREVIOUS='
const CREDENTIAL_PREFIX = 'TRACES_READER_CREDENTIAL '
const UNDO_PREFIX = 'TRACES_READER_BACKEND_UNDO='
const KEY_SHA_PREFIX = 'TRACES_GRAFANA_KEY_SHA='
const STAGED_SHA_PREFIX = 'TRACES_READER_BACKEND_STAGED_SHA='
const LIVE_PREFIX = 'TRACES_GRAFANA_LIVE='
const SETTLED_PREFIX = 'TRACES_READER_BACKEND_SETTLED='

const langfuse = CREDENTIALS.langfuse
const grafana = CREDENTIALS.grafana

/** A 64-hex-character SHA-256 on the next stdin line. */
const readSha = (name: string): string[] => [
  `read -r ${name}`,
  `case "$${name}" in ''|*[!0-9a-f]*) exit 1 ;; esac`,
  `[ "\${#${name}}" -eq 64 ] || exit 1`,
]

/** The sha256 of a file, 64 hex characters. */
const SHA_OF = (file: string): string => `"$(sha256sum "${file}" | cut -c1-64)"`

/** Give the staged file the directory's group, which deploy sets to the uid of the service that reads it. */
const OWN_LIKE_DIRECTORY = `chown "$(ls -ld "$d" | awk '{print $3":"$4}')" "$t"`

/**
 * Curl through `-K -` with the admin password read from its secret file inside the script: the password is in a
 * curl config on stdin through the shell's own `printf` (a builtin), so it is in no argv. The probe stays on
 * loopback whatever the host's environment holds: `-q` skips `.curlrc`, `--noproxy '*'` ignores proxy variables.
 * The password alphabet is URL-safe (`requireUrlSafe` in deploy), so it needs no quoting inside the config.
 */
const CURL = `curl -q -s --noproxy '*' --max-time 15 -K -`

const STATUS_LINE = String.raw`code=$(printf '%s' "$out" | sed -n 's/.*TRACES_HTTP=\([0-9]*\)$/\1/p' | tail -n 1)`

/** The only requests the host script makes for the operator CLI: method and path together, nothing else. */
const API_ALLOWED = [
  'GET /api/user',
  'POST /api/serviceaccounts',
  String.raw`GET /api/serviceaccounts/search\?perpage=100&query=${GRAFANA_ACCOUNT_NAME}`,
  'GET /api/serviceaccounts/[0-9]+',
  'GET /api/serviceaccounts/[0-9]+/tokens',
  'DELETE /api/serviceaccounts/[0-9]+/tokens/[0-9]+',
].join('|')

/**
 * Settle what an interrupted Langfuse switch can leave behind, by comparing hashes, never by name alone. A previous
 * pair is only one waiting to be revoked when it is not the live pair: revoking a copy of the live pair would take
 * reads down. Sets `settled` and prints it, and leaves `$p` (the previous file) standing only when it is pending:
 *
 *   - `.previous` or `.previous.tmp` holding the live pair: the switch stopped before its commit (or an older script
 *     stopped after copying). Nothing is pending; the leftover is removed (`cleaned`).
 *   - `.previous.tmp` holding another pair, with the live file already replaced: the switch stopped after its commit and
 *     before its last rename. The tmp file is the old pair, so it becomes `.previous` (`recovered`), pending as usual.
 *
 * Needs `f`. Sets `p`, `q` (the tmp file), `lv` (the live file's hash, empty without one) and `settled`.
 */
const SETTLE = [
  `p="$f${PREVIOUS_SUFFIX}"`,
  `q="$p${TMP_SUFFIX}"`,
  `lv=; if [ -f "$f" ]; then lv=${SHA_OF('$f')}; fi`,
  'settled=none',
  `if [ -e "$q" ]; then if [ ${SHA_OF('$q')} = "$lv" ]; then rm -f "$q"; settled=cleaned; elif [ ! -e "$p" ]; then mv -f "$q" "$p"; settled=recovered; fi; fi`,
  `if [ -e "$p" ] && [ ${SHA_OF('$p')} = "$lv" ]; then rm -f "$p"; settled=cleaned; fi`,
  `echo ${SETTLED_PREFIX}$settled`,
]

export const READER_BACKEND_REMOTE = {
  /**
   * Write the pair on stdin to `langfuse-basic.staged`: a new file in the credential directory, owned like it, mode
   * 0440, renamed into place. The shape is checked first; the placeholder is refused. A previous pair that has not
   * been confirmed revoked stops it, so one old pair is never lost track of; the leftover of an interrupted switch is
   * not one (see `SETTLE`).
   */
  stageLangfuse: script(
    'set -e',
    'read -r pair',
    'case "$pair" in pk-lf-*:sk-lf-*) ;; *) exit 1 ;; esac',
    'case "$pair" in *[!A-Za-z0-9:_-]*) exit 1 ;; esac',
    `case "\${pair#*:}" in *:*) exit 1 ;; esac`,
    `[ "$pair" != '${READER_LANGFUSE_PLACEHOLDER}' ]`,
    `d=${dirOf(langfuse.file)}`,
    `f=${langfuse.file}`,
    'test -d "$d"',
    ...SETTLE,
    `if [ -e "$p" ]; then echo ${PREVIOUS_PENDING_SENTINEL}; exit 1; fi`,
    'umask 077',
    't=$(mktemp "$d/.langfuse-basic.XXXXXX")',
    `trap 'rm -f "$t"' EXIT`,
    'printf %s "$pair" > "$t"',
    OWN_LIKE_DIRECTORY,
    'chmod 0440 "$t"',
    `mv -f "$t" "$f${STAGED_SUFFIX}"`,
    String.raw`printf '%s%s\n' '${STAGED_SHA_PREFIX}' ${SHA_OF(`$f${STAGED_SUFFIX}`)}`,
    `echo ${sentinels.stage}`,
  ),
  /**
   * Make the staged Langfuse pair live, in an order a stop at any point survives. The staged file's hash must be the
   * one on stdin (the file that was checked). Then:
   *
   *   1. hard-link the live pair to `.previous.tmp` (the live file is untouched; a stop here leaves the old state
   *      and a tmp file equal to live, which `SETTLE` removes);
   *   2. rename the staged file over the live file (the one commit; a rename is atomic, so readers see the old pair
   *      or the new, never neither);
   *   3. rename `.previous.tmp` to `.previous` (a stop between 2 and 3 leaves the old pair in the tmp file, which
   *      `SETTLE` recovers as `.previous`).
   *
   * At no point is the old pair on disk under no name, and `.previous` is never a copy of the live pair. A live pair
   * that is the placeholder, or the staged pair itself, has nothing to keep. A leftover from an earlier stop is
   * settled first, and stops this switch (`TRACES_READER_BACKEND_SWITCH_INCOMPLETE`, staged pair kept) when it was
   * one that held the live pair. Prints whether a previous pair was kept.
   */
  switchLangfuse: script(
    'set -e',
    ...readSha('want'),
    `f=${langfuse.file}`,
    `test -f "$f${STAGED_SUFFIX}"`,
    `got=$(sha256sum "$f${STAGED_SUFFIX}" | cut -c1-64)`,
    `if [ "$got" != "$want" ]; then echo ${STAGED_CHANGED_SENTINEL}; exit 1; fi`,
    ...SETTLE,
    `if [ "$settled" = cleaned ]; then echo ${SWITCH_INCOMPLETE_SENTINEL}; exit 1; fi`,
    `if [ -e "$p" ]; then echo ${PREVIOUS_PENDING_SENTINEL}; exit 1; fi`,
    'kept=none',
    `if [ -f "$f" ] && [ "$(cat "$f")" != '${READER_LANGFUSE_PLACEHOLDER}' ] && [ "$lv" != "$want" ]; then ln "$f" "$q"; kept=kept; fi`,
    `mv -f "$f${STAGED_SUFFIX}" "$f"`,
    'if [ "$kept" = kept ]; then mv -f "$q" "$p"; fi',
    `echo ${KEPT_PREFIX}$kept`,
    `echo ${sentinels.switched}`,
  ),
  /** Settle the leftover of an interrupted Langfuse switch (see `SETTLE`) and print what was found. Changes no live pair. */
  settleLangfuse: script(
    'set -e',
    `f=${langfuse.file}`,
    `test -d "${dirOf(langfuse.file)}"`,
    ...SETTLE,
    `echo ${sentinels.settle}`,
  ),
  /** Remove a staged file that was not switched in. The only deletion besides the previous file. */
  discardStaged: (credential: Credential): string =>
    script('set -e', `f=${CREDENTIALS[credential].file}`, `rm -f "$f${STAGED_SUFFIX}"`, `echo ${sentinels.discard}`),
  /** Remove the previous file, once its credential is proven refused. */
  dropPrevious: (credential: Credential): string =>
    script('set -e', `f=${CREDENTIALS[credential].file}`, `rm -f "$f${PREVIOUS_SUFFIX}"`, `echo ${sentinels.drop}`),
  /**
   * Make the staged Grafana token live. The live token is first copied to `.previous` (a placeholder counts: the
   * proof that it is refused is then trivial). Without a live file there is nothing to keep. A stop between the copy
   * and the rename leaves `.previous` equal to the live file, which `undoGrafanaSwitch` and `status` read by hash.
   */
  switchGrafana: script(
    'set -e',
    `f=${grafana.file}`,
    `test -f "$f${STAGED_SUFFIX}"`,
    `rm -f "$f${PREVIOUS_SUFFIX}"`,
    `if [ -f "$f" ]; then cp -p "$f" "$f${PREVIOUS_SUFFIX}"; fi`,
    `mv -f "$f${STAGED_SUFFIX}" "$f"`,
    `echo ${sentinels.switched}`,
  ),
  /**
   * Undo a Grafana switch whose outcome is not known. A staged file still there means the switch never happened: it
   * is removed and the live file was never touched (`unchanged`). Otherwise the previous token is put back as the
   * live one (`restored`). Fails, changing nothing, when neither is possible.
   */
  undoGrafanaSwitch: script(
    'set -e',
    `f=${grafana.file}`,
    `if [ -e "$f${STAGED_SUFFIX}" ]; then rm -f "$f${STAGED_SUFFIX}"; r=unchanged; else test -f "$f${PREVIOUS_SUFFIX}"; mv -f "$f${PREVIOUS_SUFFIX}" "$f"; r=restored; fi`,
    `echo ${UNDO_PREFIX}$r`,
    `echo ${sentinels.restore}`,
  ),
  /** The gate's check entrypoint, with its JSON on stdin. It prints one sentinel line and listens on no port. */
  gateCheck: `${COMPOSE} exec -T reader-gate bun /app/check.ts`,
  /**
   * One Grafana API request from the host, as admin, on loopback. Stdin: the method, the path, then the body. Only
   * the requests in the allowlist run, and never a token creation: that response holds the key, and its script
   * writes it to a file instead of printing it. Prints the status and the body on one line.
   */
  grafanaApi: script(
    'set -u',
    'read -r method',
    'read -r path',
    'body=$(cat)',
    `pw=${GRAFANA_ADMIN_PASSWORD_FILE}`,
    `printf '%s %s' "$method" "$path" | grep -Eq '^(${API_ALLOWED})$' || exit 1`,
    String.raw`case "$body" in *[!A-Za-z0-9:,{}\"_\ -]*) exit 1 ;; esac`,
    'code=000',
    'resp=',
    `if [ -s "$pw" ]; then ${[
      String.raw`esc=$(printf '%s' "$body" | sed 's/"/\\"/g')`,
      String.raw`if [ -n "$body" ]; then data=$(printf 'data = "%s"\n' "$esc"); else data=; fi`,
      String.raw`out=$({ printf 'user = "admin:%s"\n' "$(cat "$pw")"; [ -n "$data" ] && printf '%s\n' "$data"; } | ${CURL} -X "$method" -H 'content-type: application/json' -H 'accept: application/json' -w '\nTRACES_HTTP=%{http_code}' "${GRAFANA_BASE}$path") || true`,
      STATUS_LINE,
      String.raw`resp=$(printf '%s' "$out" | sed 's/TRACES_HTTP=[0-9]*$//' | tr -d '\n' | cut -c1-20000)`,
    ].join('; ')}; fi`,
    `echo ${HTTP_PREFIX}\${code:-000}`,
    String.raw`printf '%s%s\n' '${BODY_PREFIX}' "$resp"`,
    `echo ${sentinels.api}`,
  ),
  /**
   * Create a token on the service account and write its key straight into `token.staged`. Stdin: the account id and
   * the token name. Prints the status and the new token's id only: the key is never printed. A token made but not
   * staged (no key in the answer) is reported by id so the caller can delete it.
   */
  createGrafanaToken: script(
    'set -u',
    'read -r id',
    'read -r name',
    `case "$id" in ''|*[!0-9]*) exit 1 ;; esac`,
    `case "$name" in ''|*[!A-Za-z0-9-]*) exit 1 ;; esac`,
    `pw=${GRAFANA_ADMIN_PASSWORD_FILE}`,
    `f=${grafana.file}`,
    `d=${dirOf(grafana.file)}`,
    'test -d "$d"',
    'umask 077',
    't=$(mktemp "$d/.token.XXXXXX")',
    `trap 'rm -f "$t"' EXIT`,
    'code=000',
    'out=',
    `if [ -s "$pw" ]; then ${[
      String.raw`out=$(printf 'user = "admin:%s"\ndata = "{\\"name\\":\\"%s\\",\\"secondsToLive\\":0}"\n' "$(cat "$pw")" "$name" | ${CURL} -X POST -H 'content-type: application/json' -H 'accept: application/json' -w '\nTRACES_HTTP=%{http_code}' "${GRAFANA_BASE}/api/serviceaccounts/$id/tokens") || true`,
      STATUS_LINE,
    ].join('; ')}; fi`,
    String.raw`tid=$(printf '%s' "$out" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' | head -n 1)`,
    String.raw`key=$(printf '%s' "$out" | sed -n 's|.*"key":"\([A-Za-z0-9_=+/.-]*\)".*|\1|p' | head -n 1)`,
    `echo ${HTTP_PREFIX}\${code:-000}`,
    `if [ -n "$tid" ]; then echo ${TOKEN_ID_PREFIX}$tid; fi`,
    `if [ "\${code:-000}" = 200 ] && [ -n "$key" ] && [ -n "$tid" ]; then printf %s "$key" > "$t"; ${OWN_LIKE_DIRECTORY}; chmod 0440 "$t"; mv -f "$t" "$f${STAGED_SUFFIX}"; echo ${STAGED_PREFIX}1; printf '%s%s\\n' '${KEY_SHA_PREFIX}' "$(printf %s "$key" | sha256sum | cut -c1-64)"; fi`,
    `echo ${sentinels.createToken}`,
  ),
  /**
   * Whether the live Grafana token file still holds the key whose SHA-256 is on stdin line 1. Prints `same` or
   * `changed`; only the answer, never a value.
   */
  verifyGrafanaLive: script(
    'set -e',
    ...readSha('want'),
    `f=${grafana.file}`,
    `if [ -f "$f" ] && [ "$(sha256sum "$f" | cut -c1-64)" = "$want" ]; then s=same; else s=changed; fi`,
    `echo ${LIVE_PREFIX}$s`,
    `echo ${sentinels.liveChecked}`,
  ),
  /**
   * Ask Grafana, with the token in one of the credential files, who it is signed in as: 200 for a live token, 401
   * for a deleted one. Stdin: `staged`, `live` or `previous`. The token is read from the file and handed to curl as a
   * config on stdin, so it is in no argv, and nothing of it is printed.
   */
  checkGrafanaToken: script(
    'set -u',
    'read -r which',
    `f=${grafana.file}`,
    `case "$which" in staged) file="$f${STAGED_SUFFIX}" ;; previous) file="$f${PREVIOUS_SUFFIX}" ;; live) file="$f" ;; *) exit 1 ;; esac`,
    'code=000',
    `if [ -s "$file" ]; then ${[
      'tok=$(cat "$file")',
      'case "$tok" in *[!A-Za-z0-9_=+/.-]*) tok= ;; esac',
      String.raw`if [ -n "$tok" ]; then out=$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | ${CURL} -w '\nTRACES_HTTP=%{http_code}' "${GRAFANA_BASE}/api/user") || true; ${STATUS_LINE}; fi`,
    ].join('; ')}; fi`,
    `echo ${HTTP_PREFIX}\${code:-000}`,
    `echo ${sentinels.tokenCheck}`,
  ),
  /**
   * Each credential as `placeholder`, `installed` or `pending-old-revocation`, by comparing files on the host. A
   * previous file (`.previous`, or the `.previous.tmp` of a switch that stopped) is a pending revocation only when its
   * hash is not the live file's: one equal to it is the leftover of an interrupted switch, reported as its own line,
   * and revoking it would revoke the live pair.
   */
  status: script(
    'set -e',
    ...(Object.keys(CREDENTIALS) as Credential[]).flatMap(name => {
      const {file, placeholder} = CREDENTIALS[name]
      return [
        `f=${file}`,
        'j=0',
        `if [ ! -f "$f" ]; then s=missing; elif [ "$(cat "$f")" = '${placeholder}' ]; then s=placeholder; else s=installed; lv=${SHA_OF('$f')}; for x in "$f${PREVIOUS_SUFFIX}" "$f${PREVIOUS_SUFFIX}${TMP_SUFFIX}"; do if [ -f "$x" ]; then if [ ${SHA_OF('$x')} = "$lv" ]; then j=1; else s=pending-old-revocation; fi; fi; done; fi`,
        `echo ${CREDENTIAL_PREFIX}${name} $s`,
        `if [ -f "$f${STAGED_SUFFIX}" ]; then echo ${CREDENTIAL_PREFIX}${name} staged-file-left-over; fi`,
        `if [ "$j" = 1 ]; then echo ${CREDENTIAL_PREFIX}${name} interrupted-switch-left-over; fi`,
      ]
    }),
    `echo ${sentinels.status}`,
  ),
} as const

// ─── The gate's check ─────────────────────────────────────────────────────────

/** The check kinds `check.ts` takes: JSON on stdin, one sentinel line out. */
type CheckInput = {kind: 'langfuse' | 'langfuse-refused'; credentialFile: string} | {kind: 'grafana-mcp'}

type CheckVerdict = {ok: true} | {ok: false; reason: string}

// The reason is words, optionally followed by `:` and a three-digit HTTP status (`read-failed:404`).
const SENTINEL_LINE = /^READER_CHECK_(OK|FAIL) ([a-z-]+)(?: ([a-z-]{1,40}(?::\d{3})?))?$/

/**
 * Exactly one sentinel line, for the kind that was asked, or a failure. The exit code is not the verdict: the check
 * exits 0 either way. An answer with no line, two lines, another kind or an unexpected reason is a failure.
 */
export function parseCheck(result: RemoteResult, kind: CheckInput['kind']): CheckVerdict {
  const lines = result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('READER_CHECK_'))
  if (lines.length !== 1) return {ok: false, reason: lines.length === 0 ? 'no-answer' : 'ambiguous-answer'}
  const match = SENTINEL_LINE.exec(lines[0] ?? '')
  if (match === null || match[2] !== kind) return {ok: false, reason: 'unrecognised-answer'}
  if (match[1] === 'OK') return match[3] === undefined ? {ok: true} : {ok: false, reason: 'unrecognised-answer'}
  return {ok: false, reason: match[3] ?? 'unspecified'}
}

async function gateCheck(host: string, input: CheckInput, deps: BackendDeps): Promise<CheckVerdict> {
  const result = await runOn(host, READER_BACKEND_REMOTE.gateCheck, deps, `${JSON.stringify(input)}\n`)
  return parseCheck(result, input.kind)
}

const gateFile = (suffix: '' | typeof STAGED_SUFFIX | typeof PREVIOUS_SUFFIX): string =>
  `${GATE_LANGFUSE_FILE}${suffix}`

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface BackendDeps extends RemoteDeps {
  /** Asks for a secret without echo. `undefined` is a cancelled prompt. The default reads the terminal. */
  prompt?: ((message: string) => Promise<string | undefined>) | undefined
  now?: (() => Date) | undefined
  /** How long one remote call may take. Defaults to `REMOTE_DEADLINE_MS`. */
  deadlineMs?: number | undefined
  /** Whether standard input is a terminal. The default reads `process.stdin.isTTY`. */
  isTty?: boolean | undefined
  /** The whole of standard input, for a run without a terminal. The default reads the process's. */
  readStdin?: (() => Promise<string>) | undefined
}

/** A hidden prompt on the terminal. A cancel (Ctrl-C) is `undefined`, never an exit: the ssh session closes first. */
async function promptHidden(message: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return undefined
  const value = await clack.password({message, mask: ''})
  return clack.isCancel(value) ? undefined : value
}

async function runOn(host: string, command: string, deps: BackendDeps, stdin?: string): Promise<RemoteResult> {
  return runRemote(host, command, {
    spawn: deps.spawn,
    session: deps.session,
    signal: AbortSignal.timeout(deps.deadlineMs ?? REMOTE_DEADLINE_MS),
    ...(stdin === undefined ? {} : {stdin}),
  })
}

const confirmed = (result: RemoteResult, sentinel: string): boolean => hasSentinel(result, sentinel)

const hasLine = (result: RemoteResult, sentinel: string): boolean =>
  result.stdout.split('\n').some(line => line.trim() === sentinel)

const describeFailure = (result: RemoteResult): string =>
  `exit ${result.exitCode}: ${result.stderr || 'no confirmation'}`

// ─── backend langfuse ─────────────────────────────────────────────────────────

const PUBLIC_KEY_SHAPE = /^pk-lf-[A-Za-z\d-]{8,}$/
const SECRET_KEY_SHAPE = /^sk-lf-[A-Za-z\d-]{8,}$/

export interface LangfuseOptions {
  key?: string | undefined
  /** Prove Langfuse refuses the previous pair, then delete it. Prompts for nothing. */
  confirmOldRevoked?: boolean | undefined
}

const PREVIOUS_PENDING_MESSAGE =
  'A previous Langfuse pair is still waiting to be confirmed revoked. Delete it in the Langfuse UI (Settings, API keys) and run `infra traces reader backend langfuse --confirm-old-revoked` first. Nothing was changed.'

/** Say what the host settled of an earlier switch that stopped part way, when it settled anything. */
function logSettled(result: RemoteResult, out: Out): void {
  const settled = /^TRACES_READER_BACKEND_SETTLED=(none|cleaned|recovered)$/m.exec(result.stdout)?.[1]
  if (settled === 'cleaned') {
    out.log(
      'An earlier switch stopped part way and left a copy of the live pair. The copy was removed: there is no old pair to delete, and the live pair is unchanged.',
    )
  } else if (settled === 'recovered') {
    out.log(
      'An earlier switch stopped after the new pair went live and before the old pair was named `.previous`. The old pair was recovered as `.previous`.',
    )
  }
}

async function langfuseInstall(host: string, pair: string, out: Out, deps: BackendDeps): Promise<boolean> {
  const staged = await runOn(host, READER_BACKEND_REMOTE.stageLangfuse, deps, `${pair}\n`)
  logSettled(staged, out)
  if (hasLine(staged, PREVIOUS_PENDING_SENTINEL)) {
    out.error(PREVIOUS_PENDING_MESSAGE)
    return false
  }
  if (!confirmed(staged, sentinels.stage)) {
    out.error(`The host did not stage the pair (${describeFailure(staged)}). Nothing was changed.`)
    return false
  }

  // The hash of the file the host wrote, computed on the host: the pair is hashed nowhere on this side.
  const stagedSha = new RegExp(`^${STAGED_SHA_PREFIX}([0-9a-f]{64})$`, 'm').exec(staged.stdout)?.[1]
  if (stagedSha === undefined) {
    await discard(host, 'langfuse', out, deps)
    out.error(
      'The host did not report a hash of the staged pair. It was not switched in and was removed; the live pair is unchanged.',
    )
    return false
  }

  const verdict = await gateCheck(host, {kind: 'langfuse', credentialFile: gateFile(STAGED_SUFFIX)}, deps)
  if (!verdict.ok) {
    await discard(host, 'langfuse', out, deps)
    out.error(
      `The staged Langfuse pair failed the gate's check (${verdict.reason}). It was not switched in; the live pair is unchanged. A key that reads but is not refused a write has the wrong role: create a Viewer key.`,
    )
    return false
  }
  out.log('The staged pair reads Langfuse, and Langfuse refuses both a REST write and an MCP write by role.')

  // The staged file's hash is the one the host reported when it wrote it: a file swapped since is not the one checked.
  const switched = await runOn(host, READER_BACKEND_REMOTE.switchLangfuse, deps, `${stagedSha}\n`)
  logSettled(switched, out)
  if (hasLine(switched, SWITCH_INCOMPLETE_SENTINEL)) {
    // The staged pair was checked and is still the one that was checked: it stays, for the next run to switch in.
    out.error(
      'The switch did not complete; staged pair kept. The live pair is unchanged and still serves reads. Run this command again.',
    )
    return false
  }
  if (hasLine(switched, PREVIOUS_PENDING_SENTINEL)) {
    await discard(host, 'langfuse', out, deps)
    out.error(PREVIOUS_PENDING_MESSAGE)
    return false
  }
  if (hasLine(switched, STAGED_CHANGED_SENTINEL)) {
    await discard(host, 'langfuse', out, deps)
    out.error(
      'The staged pair changed after the check, so it was not switched in and was removed. The live pair is unchanged.',
    )
    return false
  }
  if (!confirmed(switched, sentinels.switched)) {
    await discard(host, 'langfuse', out, deps)
    out.error(
      `The host did not confirm the switch (${describeFailure(switched)}). The staged pair was removed; check \`infra traces reader backend status\`.`,
    )
    return false
  }
  out.log('The new pair is live.')
  const kept = /^TRACES_READER_BACKEND_PREVIOUS=(kept|none)$/m.exec(switched.stdout)?.[1]
  out.log(
    kept === 'kept'
      ? 'The old pair is kept on the host as `.previous`. Delete that key in the Langfuse UI, then run `infra traces reader backend langfuse --confirm-old-revoked`.'
      : 'There was no previous pair to revoke.',
  )
  return true
}

async function discard(host: string, credential: Credential, out: Out, deps: BackendDeps): Promise<void> {
  const result = await runOn(host, READER_BACKEND_REMOTE.discardStaged(credential), deps)
  if (!confirmed(result, sentinels.discard)) {
    out.error(`The staged ${credential} file could not be removed (${describeFailure(result)}). Remove it by hand.`)
  }
}

async function langfuseConfirm(host: string, out: Out, deps: BackendDeps): Promise<boolean> {
  // A switch that stopped part way can leave the old pair under a temporary name, or a copy of the live pair under
  // `.previous`. Settle that first: only a previous pair that is not the live one is worth proving refused.
  const settled = await runOn(host, READER_BACKEND_REMOTE.settleLangfuse, deps)
  if (!confirmed(settled, sentinels.settle)) {
    out.error(`Could not read the previous pair on the host (${describeFailure(settled)}). Nothing was changed.`)
    return false
  }
  logSettled(settled, out)
  const verdict = await gateCheck(host, {kind: 'langfuse-refused', credentialFile: gateFile(PREVIOUS_SUFFIX)}, deps)
  if (!verdict.ok) {
    out.error(
      verdict.reason === 'credential-missing'
        ? 'There is no previous Langfuse pair waiting. Nothing was changed.'
        : verdict.reason === 'still-accepted'
          ? 'Langfuse still accepts the previous pair. Delete that key in the Langfuse UI, then run this again. Nothing was changed.'
          : `Could not prove Langfuse refuses the previous pair (${verdict.reason}). The previous file was kept.`,
    )
    return false
  }
  out.log('Langfuse refuses the previous pair.')
  const dropped = await runOn(host, READER_BACKEND_REMOTE.dropPrevious('langfuse'), deps)
  if (!confirmed(dropped, sentinels.drop)) {
    out.error(`The previous file could not be removed (${describeFailure(dropped)}). Remove it by hand.`)
    return false
  }
  out.log('The previous pair was deleted from the host.')
  return true
}

const NOT_A_PAIR = 'That is not a Langfuse key pair: expected pk-lf-... and sk-lf-.... Nothing was changed.'

const isKeyPair = (publicKey: string, secretKey: string): boolean =>
  PUBLIC_KEY_SHAPE.test(publicKey) && SECRET_KEY_SHAPE.test(secretKey)

type PairRead = {ok: true; pair: string} | {ok: false; error: string}

/**
 * The Langfuse pair, from two hidden prompts when there is a terminal (or a prompt was injected), otherwise from one
 * line `<public>:<secret>` on stdin. Either way it never reaches an argv or an environment, and the same shapes apply.
 * Everything read is added to `secrets` so no output can carry it.
 */
async function readPair(deps: BackendDeps, secrets: string[]): Promise<PairRead> {
  const interactive = deps.prompt !== undefined || (deps.isTty ?? process.stdin.isTTY === true)
  if (interactive) {
    const ask = deps.prompt ?? promptHidden
    const publicKey = await ask('Langfuse Viewer public key (pk-lf-...)')
    if (publicKey !== undefined) secrets.push(publicKey)
    const secretKey = publicKey === undefined ? undefined : await ask('Langfuse Viewer secret key (sk-lf-...)')
    if (secretKey !== undefined) secrets.push(secretKey)
    if (publicKey === undefined || secretKey === undefined) {
      return {
        ok: false,
        error:
          'No key pair was entered (the prompt needs a terminal and was cancelled or unavailable). Nothing was changed.',
      }
    }
    return isKeyPair(publicKey.trim(), secretKey.trim())
      ? {ok: true, pair: `${publicKey.trim()}:${secretKey.trim()}`}
      : {ok: false, error: NOT_A_PAIR}
  }

  const text = await (deps.readStdin ?? (() => Bun.stdin.text()))()
  if (text !== '') secrets.push(text, text.trim())
  const line = text.replace(/\r?\n$/, '')
  if (line.trim() === '') {
    return {
      ok: false,
      error:
        'No key pair was entered. Run this in a terminal, or pipe one line, <public key>:<secret key>, to its standard input. Nothing was changed.',
    }
  }
  const parts = line.split(':')
  const [publicKey, secretKey] = parts
  if (parts.length !== 2 || publicKey === undefined || secretKey === undefined) return {ok: false, error: NOT_A_PAIR}
  secrets.push(publicKey, secretKey)
  return isKeyPair(publicKey, secretKey) ? {ok: true, pair: line} : {ok: false, error: NOT_A_PAIR}
}

export async function tracesReaderBackendLangfuseAction(
  options: LangfuseOptions,
  ctx: ActionCtx,
  deps: BackendDeps = {},
): Promise<void> {
  const secrets: string[] = []
  // The pair is read before any connection: a cancel or a bad paste costs no ssh session, and a long wait cannot
  // outlive the multiplexed connection. On a terminal it is two hidden prompts; without one, one line on stdin.
  let pair: string | undefined
  let promptFailure: string | undefined
  if (options.confirmOldRevoked !== true) {
    const read = await readPair(deps, secrets)
    if (read.ok) pair = read.pair
    else promptFailure = read.error
    if (pair !== undefined) secrets.push(pair)
  }

  const ok = await withRemoteSession(deps.spawn, session =>
    guarded(ctx, secrets, async out => {
      if (promptFailure !== undefined) {
        out.error(promptFailure)
        return false
      }
      const targets = resolveTargets(options.key, false)
      if (!targets.ok) {
        out.error(targets.error)
        return false
      }
      const {host} = targets
      const withSession = {...deps, session}
      return options.confirmOldRevoked === true
        ? langfuseConfirm(host, out, withSession)
        : langfuseInstall(host, pair ?? '', out, withSession)
    }),
  )
  if (!ok) ctx.process.exit(1)
}

// ─── backend grafana ──────────────────────────────────────────────────────────

const serviceAccountSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  role: z.string().optional(),
  isDisabled: z.boolean().optional(),
})
const searchSchema = z.object({serviceAccounts: z.array(serviceAccountSchema)})
const tokenListSchema = z.array(z.object({id: z.number().int().positive()}))

interface ApiAnswer {
  code: number | 'none'
  body: unknown
}

/** One Grafana API request through the host. The sign-in is a request like any other: Grafana has no session here. */
async function grafanaApi(
  host: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: unknown,
  deps: BackendDeps,
): Promise<ApiAnswer> {
  const result = await runOn(
    host,
    READER_BACKEND_REMOTE.grafanaApi,
    deps,
    `${method}\n${path}\n${body === undefined ? '' : JSON.stringify(body)}`,
  )
  if (!confirmed(result, sentinels.api)) return {code: 'none', body: undefined}
  const code = /^TRACES_GRAFANA_HTTP=(\d{3})$/m.exec(result.stdout)?.[1]
  const text = /^TRACES_GRAFANA_BODY=(.*)$/m.exec(result.stdout)?.[1] ?? ''
  let parsed: unknown
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return {code: code === undefined || code === '000' ? 'none' : Number(code), body: parsed}
}

const isOk = (answer: ApiAnswer): boolean => typeof answer.code === 'number' && answer.code >= 200 && answer.code < 300
const describeCode = (answer: ApiAnswer): string => (answer.code === 'none' ? 'no answer' : String(answer.code))

async function tokenCheck(
  host: string,
  which: 'staged' | 'previous' | 'live',
  deps: BackendDeps,
): Promise<number | 'none'> {
  const result = await runOn(host, READER_BACKEND_REMOTE.checkGrafanaToken, deps, `${which}\n`)
  if (!confirmed(result, sentinels.tokenCheck)) return 'none'
  const code = /^TRACES_GRAFANA_HTTP=(\d{3})$/m.exec(result.stdout)?.[1]
  return code === undefined || code === '000' ? 'none' : Number(code)
}

type Step =
  | 'sign-in'
  | 'find-service-account'
  | 'create-service-account'
  | 'create-token'
  | 'check-staged-token'
  | 'switch'
  | 'check-mcp-read'

/**
 * A rollback that threw (the host could not be reached) has done an unknown part of its work. Say what is pending and
 * touch nothing: the new token may be the live one.
 */
async function rollBackOrReport(
  host: string,
  accountId: number,
  tokenId: number,
  out: Out,
  deps: BackendDeps,
): Promise<void> {
  try {
    await rollBack(host, accountId, tokenId, true, out, deps)
  } catch (error) {
    out.error(
      `The rollback could not reach the host (${error instanceof Error ? error.message : 'error'}). The state is pending: token ${tokenId} was created on service account ${accountId} and the live file may use it. If the switch landed, \`${grafana.file}${PREVIOUS_SUFFIX}\` holds the prior token. Nothing was deleted. When the host is reachable, run this command again: it reconciles.`,
    )
  }
}

/** What a run that failed before the commit point must undo, and what it could not. */
async function rollBack(
  host: string,
  accountId: number,
  tokenId: number,
  switched: boolean,
  out: Out,
  deps: BackendDeps,
): Promise<void> {
  if (switched) {
    const restored = await runOn(host, READER_BACKEND_REMOTE.undoGrafanaSwitch, deps)
    if (!confirmed(restored, sentinels.restore)) {
      // The live file may still point at the new token, so it is not deleted: that would take reads down.
      out.error(
        `The previous token could not be put back (${describeFailure(restored)}). Token ${tokenId} was NOT deleted, because the live file may still use it. Fix the file by hand or run this command again.`,
      )
      return
    }
    out.log(
      restored.stdout.includes(`${UNDO_PREFIX}unchanged`)
        ? 'The live token file was never changed; the previous token keeps serving reads.'
        : 'The previous token was put back; it keeps serving reads.',
    )
  } else {
    await discard(host, 'grafana', out, deps)
  }
  const deleted = await grafanaApi(
    host,
    'DELETE',
    `/api/serviceaccounts/${accountId}/tokens/${tokenId}`,
    undefined,
    deps,
  )
  if (isOk(deleted) || deleted.code === 404) out.log(`The new token ${tokenId} was deleted.`)
  else {
    out.error(
      `The new token ${tokenId} could not be deleted (Grafana answered ${describeCode(deleted)}). It is not in use: the next run deletes it.`,
    )
  }
}

async function grafanaInstall(host: string, out: Out, deps: BackendDeps): Promise<boolean> {
  const fail = (step: Step, why: string): false => {
    out.error(`Step ${step} failed: ${why}`)
    return false
  }

  // One sign-in, and no second try: Grafana counts failed logins per user, and a wrong password must cost one.
  const signIn = await grafanaApi(host, 'GET', '/api/user', undefined, deps)
  if (!isOk(signIn)) {
    return fail(
      'sign-in',
      `Grafana answered ${describeCode(signIn)} to the admin sign-in. Nothing was changed, and it was not tried again. See "Grafana sign-in check fails" in docs/runbooks/trace-collection.md.`,
    )
  }

  const found = await grafanaApi(
    host,
    'GET',
    `/api/serviceaccounts/search?perpage=100&query=${GRAFANA_ACCOUNT_NAME}`,
    undefined,
    deps,
  )
  const search = isOk(found) ? searchSchema.safeParse(found.body) : undefined
  if (search === undefined || !search.success) {
    return fail('find-service-account', `Grafana answered ${describeCode(found)}. Nothing was changed.`)
  }
  // The search matches by substring; only the exact name is the account.
  const exact = search.data.serviceAccounts.filter(account => account.name === GRAFANA_ACCOUNT_NAME)
  if (exact.length > 1) {
    return fail(
      'find-service-account',
      `${exact.length} service accounts are named ${GRAFANA_ACCOUNT_NAME}. Nothing was changed.`,
    )
  }
  let accountId: number
  const existing = exact[0]
  if (existing === undefined) {
    const created = await grafanaApi(
      host,
      'POST',
      '/api/serviceaccounts',
      {name: GRAFANA_ACCOUNT_NAME, role: 'Viewer', isDisabled: false},
      deps,
    )
    const account = isOk(created) ? serviceAccountSchema.safeParse(created.body) : undefined
    if (account === undefined || !account.success) {
      return fail('create-service-account', `Grafana answered ${describeCode(created)}. Nothing was changed.`)
    }
    accountId = account.data.id
    out.log(`Created service account ${accountId} (${GRAFANA_ACCOUNT_NAME}, Viewer).`)
  } else {
    if (existing.role !== 'Viewer' || existing.isDisabled === true) {
      return fail(
        'find-service-account',
        `service account ${existing.id} (${GRAFANA_ACCOUNT_NAME}) is ${existing.isDisabled === true ? 'disabled' : `${existing.role ?? 'unknown'}, not Viewer`}. Fix it in Grafana. Nothing was changed.`,
      )
    }
    accountId = existing.id
    out.log(`Using service account ${accountId} (${GRAFANA_ACCOUNT_NAME}, Viewer).`)
  }

  const stamp = (deps.now?.() ?? new Date()).toISOString().replaceAll(/\D/g, '').slice(0, 14)
  const made = await runOn(
    host,
    READER_BACKEND_REMOTE.createGrafanaToken,
    deps,
    `${accountId}\n${GRAFANA_ACCOUNT_NAME}-${stamp}\n`,
  )
  const tokenId = Number(/^TRACES_GRAFANA_TOKEN_ID=(\d+)$/m.exec(made.stdout)?.[1])
  const madeCode = /^TRACES_GRAFANA_HTTP=(\d{3})$/m.exec(made.stdout)?.[1]
  const staged = hasLine(made, `${STAGED_PREFIX}1`)
  // The key's hash, not the key: it lets cleanup prove the live file still holds this token before it deletes others.
  const keySha = new RegExp(`^${KEY_SHA_PREFIX}([0-9a-f]{64})$`, 'm').exec(made.stdout)?.[1]
  if (
    !confirmed(made, sentinels.createToken) ||
    madeCode !== '200' ||
    !staged ||
    keySha === undefined ||
    Number.isNaN(tokenId)
  ) {
    if (Number.isNaN(tokenId)) {
      out.error(
        `Step create-token failed: no token was created (${madeCode === undefined ? describeFailure(made) : `Grafana answered ${madeCode}`}). Nothing was changed.`,
      )
      await discard(host, 'grafana', out, deps)
    } else {
      out.error(
        `Step create-token failed: token ${tokenId} exists but was not staged (Grafana answered ${madeCode ?? 'nothing'}).`,
      )
      await rollBack(host, accountId, tokenId, false, out, deps)
    }
    return false
  }
  out.log(`Created token ${tokenId} on service account ${accountId}. Its key stays on the host.`)

  // From here until the MCP read passes, any failure undoes the new token and leaves the previous one serving.
  const direct = await tokenCheck(host, 'staged', deps)
  if (direct !== 200) {
    out.error(
      `Step check-staged-token failed: Grafana answered ${direct === 'none' ? 'no answer' : direct} to the new token. The live file is unchanged.`,
    )
    await rollBack(host, accountId, tokenId, false, out, deps)
    return false
  }

  // The commit point. A step that fails by returning and one that throws (the host could not be reached) take the
  // same way back: the mv may have landed with only the reply lost, so the previous token is put back if the file moved.
  const committed = await commitGrafana(host, deps)
  if (!committed.ok) {
    out.error(`Step ${committed.step} failed: ${committed.why}`)
    await rollBackOrReport(host, accountId, tokenId, out, deps)
    return false
  }
  out.log('The gate reads Grafana through the new token: it is live, and is never rolled back from here.')
  return grafanaCleanup(host, accountId, tokenId, keySha, out, deps)
}

type Commit = {ok: true} | {ok: false; step: Step; why: string}

/** Switch the staged token in and prove an MCP read through the gate. Nothing here rolls back; the caller does. */
async function commitGrafana(host: string, deps: BackendDeps): Promise<Commit> {
  let step: Step = 'switch'
  try {
    const switched = await runOn(host, READER_BACKEND_REMOTE.switchGrafana, deps)
    if (!confirmed(switched, sentinels.switched)) {
      return {ok: false, step, why: `${describeFailure(switched)}. Checking whether the live file changed.`}
    }
    step = 'check-mcp-read'
    const mcp = await gateCheck(host, {kind: 'grafana-mcp'}, deps)
    if (!mcp.ok) return {ok: false, step, why: `the gate's Grafana MCP read answered ${mcp.reason}.`}
    return {ok: true}
  } catch (error) {
    const why = error instanceof Error ? error.message : 'error'
    return {ok: false, step, why: `${why}. Checking whether the live file changed.`}
  }
}

/** Delete every other token on the account, prove each gone, prove the previous token refused, then drop it. */
async function grafanaCleanup(
  host: string,
  accountId: number,
  keep: number,
  keySha: string,
  out: Out,
  deps: BackendDeps,
): Promise<boolean> {
  // Nothing is deleted unless the live file still holds the kept token: a token another run switched in is not ours to
  // revoke. The comparison is by hash; a value is never printed.
  const live = await runOn(host, READER_BACKEND_REMOTE.verifyGrafanaLive, deps, `${keySha}\n`)
  if (!confirmed(live, sentinels.liveChecked) || !hasLine(live, `${LIVE_PREFIX}same`)) {
    out.error(
      confirmed(live, sentinels.liveChecked)
        ? `Cleanup deleted nothing: the live token file no longer holds token ${keep}. Another change replaced it. Check \`infra traces reader backend status\` and run this command again.`
        : `Cleanup deleted nothing: could not verify that the live token file still holds token ${keep} (${describeFailure(live)}). Run this command again.`,
    )
    return false
  }
  const tokensPath = `/api/serviceaccounts/${accountId}/tokens`
  const listing = await grafanaApi(host, 'GET', tokensPath, undefined, deps)
  const parsed = isOk(listing) ? tokenListSchema.safeParse(listing.body) : undefined
  if (parsed === undefined || !parsed.success) {
    out.error(
      `Cleanup could not list the account's tokens (Grafana answered ${describeCode(listing)}). The new token ${keep} is live. Run this command again to delete the others.`,
    )
    return false
  }
  const others = parsed.data.map(token => token.id).filter(id => id !== keep)
  const failedDeletes: number[] = []
  for (const id of others) {
    const deleted = await grafanaApi(host, 'DELETE', `${tokensPath}/${id}`, undefined, deps)
    if (!isOk(deleted) && deleted.code !== 404) failedDeletes.push(id)
  }

  // Read back by id: a token whose value this host never held can only be proven gone by its absence from the list.
  const readBack = await grafanaApi(host, 'GET', tokensPath, undefined, deps)
  const after = isOk(readBack) ? tokenListSchema.safeParse(readBack.body) : undefined
  const remaining =
    after === undefined || !after.success ? others : after.data.map(token => token.id).filter(id => id !== keep)
  if (after === undefined || !after.success) {
    out.error(
      `Cleanup could not read the token list back (Grafana answered ${describeCode(readBack)}), so deletions are unproven.`,
    )
  }

  const previous = await tokenCheck(host, 'previous', deps)
  const previousRefused = previous === 401
  if (!previousRefused) {
    out.error(
      previous === 200
        ? 'Grafana still accepts the previous token. It is kept as `.previous`; run this command again.'
        : 'Could not prove Grafana refuses the previous token. It is kept as `.previous`; run this command again.',
    )
  }

  const clean = remaining.length === 0 && failedDeletes.length === 0 && previousRefused && after?.success === true
  if (!clean) {
    if (remaining.length > 0 || failedDeletes.length > 0) {
      out.error(
        `Token ids still to delete on service account ${accountId}: ${[...new Set([...remaining, ...failedDeletes])].sort((a, b) => a - b).join(', ')}. Token ${keep} stays live. Run this command again: it deletes them and converges.`,
      )
    }
    return false
  }

  const dropped = await runOn(host, READER_BACKEND_REMOTE.dropPrevious('grafana'), deps)
  if (!confirmed(dropped, sentinels.drop)) {
    out.error(`The previous file could not be removed (${describeFailure(dropped)}). Remove it by hand.`)
    return false
  }
  out.log(
    others.length === 0
      ? `Service account ${accountId} holds token ${keep} only.`
      : `Deleted tokens ${others.join(', ')}; service account ${accountId} holds token ${keep} only. Grafana refuses the previous token.`,
  )
  return true
}

export async function tracesReaderBackendGrafanaAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  deps: BackendDeps = {},
): Promise<void> {
  const ok = await withRemoteSession(deps.spawn, session =>
    guarded(ctx, [], async out => {
      const targets = resolveTargets(options.key, false)
      if (!targets.ok) {
        out.error(targets.error)
        return false
      }
      const {host} = targets
      const withSession = {...deps, session, deadlineMs: deps.deadlineMs ?? GRAFANA_REMOTE_DEADLINE_MS}
      return grafanaInstall(host, out, withSession)
    }),
  )
  if (!ok) ctx.process.exit(1)
}

// ─── backend status ───────────────────────────────────────────────────────────

const STATE_TEXT: Record<string, string> = {
  placeholder: 'placeholder (no credential installed: reads through this route fail)',
  installed: 'installed',
  'pending-old-revocation': 'installed; the old credential is not yet confirmed revoked',
  missing: 'missing (run a deploy)',
  'staged-file-left-over': 'a staged file is left over from an interrupted run',
  'interrupted-switch-left-over':
    'a copy of the live credential is left over from an interrupted switch (not an old credential; nothing to revoke)',
}

/** Lines that note a leftover file beside a credential: a second line for the same credential, never its state. */
const NOTE_STATES = new Set(['staged-file-left-over', 'interrupted-switch-left-over'])

export interface StatusOptions {
  key?: string | undefined
  /** One JSON object, `{langfuse, grafana}`, each a state name, instead of text. */
  json?: boolean | undefined
}

export async function tracesReaderBackendStatusAction(
  options: StatusOptions,
  ctx: ActionCtx,
  deps: BackendDeps = {},
): Promise<void> {
  const ok = await withRemoteSession(deps.spawn, session =>
    guarded(ctx, [], async out => {
      const targets = resolveTargets(options.key, false)
      if (!targets.ok) {
        out.error(targets.error)
        return false
      }
      const result = await runOn(targets.host, READER_BACKEND_REMOTE.status, {...deps, session})
      if (!confirmed(result, sentinels.status)) {
        out.error(`Could not read the credential state (${describeFailure(result)}).`)
        return false
      }
      const seen = new Set<string>()
      // The state of each credential; the left-over staged file is a second line for the same one, in text only.
      const states: Partial<Record<Credential, string>> = {}
      for (const match of result.stdout.matchAll(/^TRACES_READER_CREDENTIAL (langfuse|grafana) ([a-z-]+)$/gm)) {
        const [, name, state] = match
        if (name === undefined || state === undefined) continue
        seen.add(name)
        if (!NOTE_STATES.has(state) && (name === 'langfuse' || name === 'grafana')) states[name] = state
        if (options.json !== true) out.log(`${name}: ${STATE_TEXT[state] ?? 'unknown state'}`)
      }
      if (seen.size !== 2 || states.langfuse === undefined || states.grafana === undefined) {
        out.error('The host did not report both credentials.')
        return false
      }
      if (options.json === true) out.log(JSON.stringify({langfuse: states.langfuse, grafana: states.grafana}))
      return true
    }),
  )
  if (!ok) ctx.process.exit(1)
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerTracesReaderBackend(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'traces reader backend langfuse',
      `Install or rotate the Langfuse Viewer key the reader gate reads with. Prompts for the pair without echo (or reads one <public>:<secret> line from stdin when there is no terminal), proves it on the host (reads; REST and MCP writes refused by role), then switches it in and keeps the old pair until --confirm-old-revoked. ${ONE_READER_COMMAND_AT_A_TIME}`,
    )
    .option(
      '--confirm-old-revoked',
      'Prove Langfuse refuses the previous pair (delete it in the UI first), then delete it from the host.',
    )
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesReaderBackendLangfuseAction(options, ctx))

  cli
    .command(
      'traces reader backend grafana',
      `Create or rotate the Grafana service-account token (agent-reader, Viewer) on the host. The key never leaves the host: only ids are printed. Proves a Grafana MCP read through the gate, then deletes every other token. ${ONE_READER_COMMAND_AT_A_TIME}`,
    )
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesReaderBackendGrafanaAction(options, ctx))

  cli
    .command(
      'traces reader backend status',
      `Report each reader backend credential as placeholder, installed or pending old-key revocation. Never prints a value. ${ONE_READER_COMMAND_AT_A_TIME}`,
    )
    .option(
      '--json',
      z
        .boolean()
        .describe(
          'Output one JSON object, {langfuse, grafana}: each is placeholder, installed, pending-old-revocation or missing.',
        ),
    )
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesReaderBackendStatusAction(options, ctx))
}
