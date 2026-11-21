// ─── Retention ────────────────────────────────────────────────────────────────
//
// "30 days" for Langfuse's data means two things this file asserts on every deploy and reads back:
//
//   1. ClickHouse: a TTL of 30 days after span start on every table that can hold trace content.
//      Langfuse's own project-level retention is an enterprise feature, so the TTL is set on the tables
//      directly. A table the probe proved (`events_full`, `events_core`) must exist; the deploy waits for
//      Langfuse's migrations to create it and never treats "not there yet" as a pass. The older trace
//      tables below are empty on this stack (the probe wrote 302 spans and only the two events tables held
//      rows) and are covered as a precaution: they take the TTL when they exist and are skipped when they do not.
//   2. Object store: every OTLP batch Langfuse uploads stays in the bucket until something deletes it, so a
//      lifecycle rule expires `events/` (batches) and `media/` (attachments extracted from trace content) at
//      30 days.
//
// Idempotent: a table that already carries the TTL gets no ALTER, and a prefix that already carries the rule
// gets no rule. A table that exists but cannot be altered, or a read-back that differs from what was set,
// throws; nothing here swallows a failure.
//
// Remote hygiene (same rules as the rest of the deploy): a recognised sentinel and exit 0 for every probe, no
// secret in argv (the ClickHouse and object-store passwords are read from the container's own environment),
// no redirect to the null device, no `rm`.

import type {RemoteExec, RunResult} from '../server/provision'

import {bashCommand, shellQuote} from '../server/provision'
import {TRACES_APP_DIR} from './host'

export const RETENTION_DAYS = 30

/** Same prefix every remote compose call uses; pinned to the deploy's own copy by a test. */
export const RETENTION_COMPOSE = `docker compose --project-directory ${TRACES_APP_DIR}`

export interface RetentionTable {
  name: string
  /** The time column the TTL counts from. Taken from each table's partition key in the probe. */
  column: string
  /** A required table that is missing means Langfuse has not finished its migrations: "not ready", never a pass. */
  required: boolean
}

/**
 * Tables that can hold trace content. `events_full` holds every span whole; `events_core` holds the first 200
 * characters of input, output and metadata values. Both were proven against the pinned Langfuse. The rest are
 * Langfuse's older trace, observation and score tables, empty in the probe.
 *
 * Not listed on purpose: `observations_batch_staging` (carries its own TTL), `audit_logs`, `topics`,
 * `topic_assignments`, `topic_facet_summaries`, `dataset_run_items_rmt` and `blob_storage_file_log` (settings,
 * datasets and bookkeeping an operator creates in the UI; no sender can write into them).
 */
export const RETENTION_TABLES: readonly RetentionTable[] = [
  {name: 'events_full', column: 'start_time', required: true},
  {name: 'events_core', column: 'start_time', required: true},
  {name: 'traces', column: 'timestamp', required: false},
  {name: 'observations', column: 'start_time', required: false},
  {name: 'observations_pid_tid_sorting', column: 'start_time', required: false},
  {name: 'scores', column: 'timestamp', required: false},
]

const TTL_READ_SENTINEL = 'TRACES_TTL_READ'
const TTL_APPLIED_SENTINEL = 'TRACES_TTL_APPLIED'
const ILM_READ_SENTINEL = 'TRACES_ILM_READ'
const ILM_NONE_SENTINEL = 'TRACES_ILM_NONE'
const ILM_ADDED_SENTINEL = 'TRACES_ILM_ADDED'

export const CLICKHOUSE_DATABASE = 'default'

/** What the deploy sets. */
export function ttlExpression(column: string): string {
  return `toDateTime(${column}) + INTERVAL ${RETENTION_DAYS} DAY`
}

/**
 * ClickHouse prints the interval as a function when it echoes a table back
 * (`TTL toDateTime(start_time) + toIntervalDay(30)`), which is what the probe read. Both spellings are the same
 * rule, so a comparison canonicalises before it compares.
 */
export function canonicalTtl(expression: string): string {
  return expression
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll(/\btoIntervalDay\((\d+)\)/g, 'INTERVAL $1 DAY')
}

export function ttlMatches(column: string, found: string | undefined): boolean {
  return found !== undefined && canonicalTtl(found) === canonicalTtl(ttlExpression(column))
}

/**
 * `text` with the inside of every single-quoted string and every backtick-quoted identifier replaced by `_`, so that a
 * search over the result cannot land in quoted text, and its parentheses cannot move a depth count. The quotes stay and
 * the length is unchanged, so an index into the result is an index into `text`. A quote inside a quoted run is escaped
 * as a backslash and the quote (`\'`) or as the quote doubled (`''`); a backslash escapes any character. A scanner for
 * this one job, not a SQL parser: no comments, no dollar quoting. A quote left open masks the rest.
 */
function maskQuoted(text: string): string {
  let masked = ''
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    if (quote === undefined) {
      if (char === "'" || char === '`') quote = char
      masked += char
    } else if (char === '\\') {
      masked += index + 1 < text.length ? '__' : '_'
      index++
    } else if (char === quote && text.charAt(index + 1) === quote) {
      masked += '__'
      index++
    } else if (char === quote) {
      masked += char
      quote = undefined
    } else {
      masked += '_'
    }
  }
  return masked
}

/** The indexes at which `needle` starts outside every parenthesis, in a text already masked by `maskQuoted`. */
function topLevelIndexes(masked: string, needle: string): number[] {
  const found: number[] = []
  let depth = 0
  for (let index = 0; index < masked.length; index++) {
    const char = masked.charAt(index)
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && masked.startsWith(needle, index)) found.push(index)
  }
  return found
}

/**
 * The table TTL clause in a `CREATE TABLE` statement as ClickHouse echoes it, or undefined for a table with none. Only a
 * ` TTL ` outside every parenthesis counts (a column's TTL sits inside the column list), and nothing inside a quoted
 * string or identifier does (a COMMENT can say anything).
 */
export function extractTtl(createStatement: string): string | undefined {
  // `system.tables.create_table_query` is one line, with the table TTL between the sorting key and SETTINGS:
  // `... ORDER BY (...) TTL toDateTime(start_time) + toIntervalDay(30) SETTINGS index_granularity = 8192`.
  // `SHOW CREATE TABLE` prints the same clauses on separate lines. Both are handled by flattening first.
  const flat = createStatement.replaceAll(/\s+/g, ' ').trim()
  const masked = maskQuoted(flat)
  const start = topLevelIndexes(masked, ' TTL ').at(-1)
  if (start === undefined) return undefined
  const from = start + ' TTL '.length
  // The clauses that can follow a table TTL. Without a SETTINGS clause a trailing COMMENT would otherwise be read as
  // part of the rule, and a correct TTL would fail its read-back.
  const end = [' SETTINGS ', ' COMMENT ']
    .flatMap(clause => topLevelIndexes(masked, clause))
    .filter(index => index >= from - 1)
    .toSorted((left, right) => left - right)
    .at(0)
  return flat.slice(from, end).trim()
}

export interface TableState {
  name: string
  ttl: string | undefined
}

/**
 * Parse the `JSONEachRow` answer to the table query. Anything that is not a row with the two expected string
 * fields is an error, not a table that is "absent".
 */
export function parseTableStates(stdout: string): TableState[] {
  const states: TableState[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed === TTL_READ_SENTINEL) continue
    let row: unknown
    try {
      row = JSON.parse(trimmed)
    } catch {
      throw new Error('Retention: unreadable table answer from ClickHouse')
    }
    if (
      typeof row !== 'object' ||
      row === null ||
      !('name' in row) ||
      !('create_table_query' in row) ||
      typeof row.name !== 'string' ||
      typeof row.create_table_query !== 'string'
    ) {
      throw new Error('Retention: unexpected table answer from ClickHouse')
    }
    states.push({name: row.name, ttl: extractTtl(row.create_table_query)})
  }
  return states
}

// ─── Remote commands ──────────────────────────────────────────────────────────

/**
 * The inner command runs in the ClickHouse container, where `CLICKHOUSE_PASSWORD` is already in the environment,
 * so the password is expanded there and never appears in this command string. The SQL comes in on stdin.
 */
const CLICKHOUSE_CLIENT = `${RETENTION_COMPOSE} exec -T clickhouse sh -c 'exec clickhouse-client --user clickhouse --password "$CLICKHOUSE_PASSWORD" --multiquery'`

function guardLine(guard: string): string {
  return guard === '' ? '' : `${guard}\n`
}

export function readTtlScript(): string {
  return `set -eu
# traces-step:retention-read-ttl
${CLICKHOUSE_CLIENT}
echo ${TTL_READ_SENTINEL}`
}

/** The SQL the read script gets on stdin. */
export function readTtlSql(): string {
  const names = RETENTION_TABLES.map(table => `'${table.name}'`).join(', ')
  return `SELECT name, create_table_query FROM system.tables WHERE database = '${CLICKHOUSE_DATABASE}' AND name IN (${names}) ORDER BY name FORMAT JSONEachRow;\n`
}

/**
 * `guard` is a shell fragment that runs first and may stop the script before it changes anything. The deploy passes
 * its ownership prelude (the deploy step lock, then the check: an overtaken deploy must not alter a table, and no
 * newer deploy may take the host while this step runs); with none, the script runs as it always did.
 */
export function applyTtlScript(guard = ''): string {
  return `set -eu
# traces-step:retention-apply-ttl
${guardLine(guard)}${CLICKHOUSE_CLIENT}
echo ${TTL_APPLIED_SENTINEL}`
}

/** One ALTER per table that needs it, and nothing for a table that already matches. */
export function applyTtlSql(tables: readonly RetentionTable[]): string {
  return tables
    .map(table => `ALTER TABLE ${CLICKHOUSE_DATABASE}.${table.name} MODIFY TTL ${ttlExpression(table.column)};\n`)
    .join('')
}

/** The bucket Langfuse writes to, and the prefixes that carry trace content. */
export const OBJECT_STORE_BUCKET = 'langfuse'
export const OBJECT_STORE_PREFIXES = ['events/', 'media/'] as const

/**
 * `mc` runs inside the object-store container. `MC_HOST_<alias>` defines the alias from the container's own
 * root credentials for this one command, so no alias file is written and no password is in this string.
 */
function mc(args: string): string {
  const alias = 'traces'
  const inner = `MC_HOST_${alias}="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@127.0.0.1:9000" exec mc ${args}`
  return `${RETENTION_COMPOSE} exec -T minio sh -c ${shellQuote(inner)}`
}

const ALIAS_BUCKET = `traces/${OBJECT_STORE_BUCKET}`

export function readLifecycleScript(): string {
  // `mc` answers a bucket with no lifecycle configuration by failing with a recognisable message. That one
  // message is "no rules". Any other failure is a failure.
  return String.raw`set -u
# traces-step:retention-read-lifecycle
out=$(${mc(`ilm rule export ${ALIAS_BUCKET}`)} 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
  printf '%s\n' "$out"
  echo ${ILM_READ_SENTINEL}
elif printf '%s' "$out" | grep -q 'lifecycle configuration does not exist'; then
  echo ${ILM_NONE_SENTINEL}
else
  printf '%s\n' "$out"
  exit 1
fi`
}

/** `guard` as for `applyTtlScript`. */
export function addLifecycleScript(prefix: string, guard = ''): string {
  if (!(OBJECT_STORE_PREFIXES as readonly string[]).includes(prefix)) {
    throw new Error(`Retention: refusing a lifecycle rule for an unknown prefix: ${prefix}`)
  }
  return `set -eu
# traces-step:retention-add-lifecycle
${guardLine(guard)}${mc(`ilm rule add --prefix ${shellQuote(prefix)} --expire-days ${RETENTION_DAYS} ${ALIAS_BUCKET}`)}
echo ${ILM_ADDED_SENTINEL}`
}

export interface LifecycleRule {
  prefix: string | undefined
  days: number | undefined
  enabled: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Parse `mc ilm rule export`: the S3 lifecycle document, `{"Rules":[{"Status","Expiration":{"Days"},
 * "Filter":{"Prefix"}}]}`. Older builds put `Prefix` on the rule itself, and a filter with tags nests it under
 * `And`; all three spellings are read. A document without a `Rules` array is an error.
 */
export function parseLifecycle(text: string): LifecycleRule[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('Retention: unreadable lifecycle answer from the object store')
  let document: unknown
  try {
    document = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('Retention: unreadable lifecycle answer from the object store')
  }
  const rules = asRecord(document)?.Rules
  if (!Array.isArray(rules)) throw new Error('Retention: lifecycle answer has no rule list')

  return rules.map((entry): LifecycleRule => {
    const rule = asRecord(entry)
    if (rule === undefined) throw new Error('Retention: lifecycle answer has a rule that is not an object')
    const filter = asRecord(rule.Filter)
    const and = asRecord(filter?.And)
    const prefixValue = filter?.Prefix ?? and?.Prefix ?? rule.Prefix
    const days = asRecord(rule.Expiration)?.Days
    return {
      prefix: typeof prefixValue === 'string' ? prefixValue : undefined,
      days: typeof days === 'number' ? days : undefined,
      enabled: rule.Status === 'Enabled',
    }
  })
}

export type PrefixState = 'satisfied' | 'absent' | 'conflict'

/**
 * A prefix is satisfied by an enabled rule that expires it after exactly 30 days. A rule on the same prefix
 * that does anything else is a conflict: it was set by someone, and the deploy will not guess.
 */
export function prefixState(rules: readonly LifecycleRule[], prefix: string): PrefixState {
  const forPrefix = rules.filter(rule => rule.prefix === prefix)
  if (forPrefix.length === 0) return 'absent'
  return forPrefix.some(rule => rule.enabled && rule.days === RETENTION_DAYS) ? 'satisfied' : 'conflict'
}

// ─── Running ──────────────────────────────────────────────────────────────────

function lastLine(result: RunResult): string | undefined {
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .findLast(line => line !== '')
}

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

async function step(
  exec: RemoteExec,
  label: string,
  script: string,
  accepted: readonly string[],
  stdin?: string,
): Promise<{result: RunResult; sentinel: string}> {
  const result = await exec(bashCommand(script), stdin)
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}): ${clip(result.stderr) || clip(result.stdout) || 'no output'}`,
    )
  }
  const last = lastLine(result)
  if (last === undefined || !accepted.includes(last)) {
    throw new Error(`${label}: unrecognised answer from the host (expected ${accepted.join(' or ')})`)
  }
  return {result, sentinel: last}
}

async function readTables(exec: RemoteExec): Promise<TableState[]> {
  const {result} = await step(exec, 'Read table TTLs', readTtlScript(), [TTL_READ_SENTINEL], readTtlSql())
  return parseTableStates(result.stdout)
}

async function readRules(exec: RemoteExec): Promise<LifecycleRule[]> {
  const {result, sentinel} = await step(exec, 'Read object-store lifecycle', readLifecycleScript(), [
    ILM_READ_SENTINEL,
    ILM_NONE_SENTINEL,
  ])
  return sentinel === ILM_NONE_SENTINEL ? [] : parseLifecycle(result.stdout)
}

export interface RetentionReport {
  /** Tables that now carry the TTL (read back). */
  tables: string[]
  /** Tables that were altered by this run. An empty list means every TTL was already in place. */
  altered: string[]
  /** Optional tables Langfuse has not created. */
  skipped: string[]
  /** Prefixes with the 30-day rule (read back), and the ones added by this run. */
  prefixes: string[]
  prefixesAdded: string[]
}

export type RetentionOutcome =
  | {status: 'ready'; report: RetentionReport}
  /** Langfuse has not created these required tables yet (migrations still running). The caller retries. */
  | {status: 'not-ready'; missing: string[]}

export class RetentionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetentionError'
  }
}

/**
 * Assert the TTL on the trace tables and the lifecycle rules on the object store, then read both back.
 * Throws a `RetentionError` when a table cannot be altered, a read-back differs, or a rule conflicts.
 *
 * `guard` goes at the start of every script that changes something (the TTL `ALTER`s and the lifecycle rules); the
 * reads never carry it.
 */
export async function assertRetention(exec: RemoteExec, guard = ''): Promise<RetentionOutcome> {
  const states = await readTables(exec)
  const byName = new Map(states.map(state => [state.name, state]))

  const missing = RETENTION_TABLES.filter(table => table.required && !byName.has(table.name)).map(table => table.name)
  if (missing.length > 0) return {status: 'not-ready', missing}

  const present = RETENTION_TABLES.filter(table => byName.has(table.name))
  const skipped = RETENTION_TABLES.filter(table => !byName.has(table.name)).map(table => table.name)
  const needing = present.filter(table => !ttlMatches(table.column, byName.get(table.name)?.ttl))

  if (needing.length > 0) {
    try {
      await step(exec, 'Apply table TTLs', applyTtlScript(guard), [TTL_APPLIED_SENTINEL], applyTtlSql(needing))
    } catch (error) {
      throw new RetentionError(
        `Could not set the 30-day TTL on ${needing.map(table => table.name).join(', ')}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const readBack = new Map((await readTables(exec)).map(state => [state.name, state]))
    const wrong = needing.filter(table => !ttlMatches(table.column, readBack.get(table.name)?.ttl))
    if (wrong.length > 0) {
      throw new RetentionError(
        `TTL read-back differs from 30 days on ${wrong.map(table => table.name).join(', ')}: the table did not keep the change`,
      )
    }
  }

  const prefixesAdded: string[] = []
  let rules = await readRules(exec)
  for (const prefix of OBJECT_STORE_PREFIXES) {
    const state = prefixState(rules, prefix)
    if (state === 'conflict') {
      throw new RetentionError(
        `The object store already has a rule on ${prefix} that is not a 30-day expiry; remove or fix it by hand`,
      )
    }
    if (state === 'absent') {
      await step(exec, `Add lifecycle rule for ${prefix}`, addLifecycleScript(prefix, guard), [ILM_ADDED_SENTINEL])
      prefixesAdded.push(prefix)
    }
  }
  if (prefixesAdded.length > 0) rules = await readRules(exec)
  const unsatisfied = OBJECT_STORE_PREFIXES.filter(prefix => prefixState(rules, prefix) !== 'satisfied')
  if (unsatisfied.length > 0) {
    throw new RetentionError(`Lifecycle read-back does not show a 30-day rule on ${unsatisfied.join(', ')}`)
  }

  return {
    status: 'ready',
    report: {
      tables: present.map(table => table.name),
      altered: needing.map(table => table.name),
      skipped,
      prefixes: [...OBJECT_STORE_PREFIXES],
      prefixesAdded,
    },
  }
}
