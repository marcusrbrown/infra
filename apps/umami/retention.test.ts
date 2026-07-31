import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'bun:test'

const appDirectory = new URL('.', import.meta.url).pathname
const runnerPath = join(appDirectory, 'retention.sh')
const checkSqlPath = join(appDirectory, 'retention-check.sql')
const applySqlPath = join(appDirectory, 'retention.sql')

const tables = [
  'event_data',
  'website_event',
  'session_data',
  'revenue',
  'session_replay',
  'session_replay_saved',
  'heatmap_event',
  'session',
] as const

async function artifact(path: string): Promise<string> {
  expect(await Bun.file(path).exists()).toBe(true)
  return readFile(path, 'utf8')
}

interface CommandResult {
  args: string[]
  exitCode: number
  stderr: string
  sql: string
  stdout: string
}

async function runRunner(
  mode: '--apply' | '--check' = '--check',
  options: {composePath?: string; dockerBody?: string; dockerExitCode?: number} = {},
): Promise<CommandResult> {
  const directory = await mkdtemp(join(tmpdir(), 'umami-retention-test-'))
  const dockerPath = join(directory, 'docker')
  const argsPath = join(directory, 'docker-args')
  const sqlPath = join(directory, 'docker-sql')
  const composePath = options.composePath ?? join(directory, 'compose file.yaml')

  await writeFile(composePath, 'services:\n  db:\n    image: postgres:15-alpine\n')
  await writeFile(
    dockerPath,
    String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$@" > "$UMAMI_RETENTION_TEST_ARGS"
cat > "$UMAMI_RETENTION_TEST_SQL"
${options.dockerBody ?? String.raw`printf '%s\n' 'RETENTION|mode=check|table=event_data|before=0|deleted=0|remaining=0'`}
exit ${options.dockerExitCode ?? 0}
`,
  )
  await chmod(dockerPath, 0o755)

  const result = Bun.spawnSync({
    cmd: ['bash', runnerPath, mode, '--compose-file', composePath],
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      UMAMI_RETENTION_TEST_ARGS: argsPath,
      UMAMI_RETENTION_TEST_SQL: sqlPath,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })

  const args = (await Bun.file(argsPath).exists()) ? (await readFile(argsPath, 'utf8')).trim().split('\n') : []
  const sql = (await Bun.file(sqlPath).exists()) ? await readFile(sqlPath, 'utf8') : ''
  const output = {
    args,
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    sql,
    stdout: result.stdout.toString(),
  }

  await rm(directory, {force: true, recursive: true})
  return output
}

describe('Umami retention SQL', () => {
  it('uses the exact PostgreSQL 13-calendar-month cutoff', async () => {
    const [checkSql, applySql] = await Promise.all([artifact(checkSqlPath), artifact(applySqlPath)])

    expect(checkSql).toContain("CURRENT_TIMESTAMP - INTERVAL '13 months'")
    expect(applySql).toContain("CURRENT_TIMESTAMP - INTERVAL '13 months'")
  })

  it('covers every time-bounded analytics table', async () => {
    const applySql = await artifact(applySqlPath)

    for (const table of tables) {
      expect(applySql).toContain(table)
    }
  })

  it('deletes children before session and protects session rows with surviving-dependency checks', async () => {
    const applySql = await artifact(applySqlPath)
    const deletePositions = tables.map(table => {
      const position = applySql.search(new RegExp(String.raw`DELETE FROM ${table}(?:\s|$)`, 'i'))
      expect(position).toBeGreaterThanOrEqual(0)
      return position
    })

    expect(deletePositions).toEqual([...deletePositions].sort((left, right) => left - right))

    const sessionDelete = applySql.slice(deletePositions.at(-1))
    expect(sessionDelete).toContain('NOT EXISTS')
    expect(sessionDelete).toContain('website_event')
    expect(sessionDelete).toContain('session_data')
    expect(sessionDelete).toContain('revenue')
    expect(sessionDelete).toContain('session_replay')
    expect(sessionDelete).toContain('heatmap_event')
  })

  it('targets only rows strictly older than the calendar cutoff', async () => {
    const applySql = await artifact(applySqlPath)

    expect(applySql).toContain('created_at < (SELECT cutoff FROM retention_context)')
    expect(applySql).not.toContain('created_at <= (SELECT cutoff FROM retention_context)')
  })

  it('keeps check mode read-only and reports zero deletions', async () => {
    const checkSql = await artifact(checkSqlPath)

    expect(checkSql).toContain('BEGIN READ ONLY;')
    expect(checkSql).toContain("'RETENTION|mode=check|table=%s|before=%s|deleted=0|protected=%s|remaining=%s'")
    expect(checkSql).not.toMatch(/\b(?:DELETE|INSERT|UPDATE|CREATE|ALTER|TRUNCATE)\b/i)

    const result = await runRunner('--check')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('RETENTION|mode=check')
    expect(result.sql).not.toMatch(/\bDELETE\b/i)
  })

  it('wraps apply mode in a fail-fast transaction and checks for orphans before commit', async () => {
    const [runner, applySql] = await Promise.all([artifact(runnerPath), artifact(applySqlPath)])

    expect(runner).toContain('set -Eeuo pipefail')
    expect(runner).toContain('ON_ERROR_STOP=1')
    expect(applySql.indexOf('BEGIN;')).toBeLessThan(applySql.indexOf('COMMIT;'))
    expect(applySql).toContain('RAISE EXCEPTION')
    expect(applySql).toContain('retention orphan delta increased')
    expect(applySql).toContain('COMMIT;')
  })

  it('separates protected expired parents from eligible remaining rows', async () => {
    const [checkSql, applySql] = await Promise.all([artifact(checkSqlPath), artifact(applySqlPath)])

    expect(checkSql).toContain('protected=%s')
    expect(applySql).toContain('protected_count')
    expect(applySql).toContain('protected=%s')
    expect(checkSql).toContain('event_data.created_at >= retention_context.cutoff')
    expect(checkSql).toContain('session_replay.created_at >= retention_context.cutoff')
    expect(checkSql).toContain('heatmap_event.created_at >= retention_context.cutoff')
    expect(applySql).toContain('session_replay.session_id = session.session_id')
    expect(applySql).toContain('heatmap_event.session_id = session.session_id')
    expect(applySql).toContain('website_event.created_at < (SELECT cutoff FROM retention_context)')
    expect(applySql).toContain('session.created_at < (SELECT cutoff FROM retention_context)')
  })

  it('fails closed when expired rows remain after the delete pass', async () => {
    const applySql = await artifact(applySqlPath)

    expect(applySql).toContain('retention incomplete')
    expect(applySql).toContain('remaining_count <> 0')
    expect(applySql.indexOf('remaining_count <> 0')).toBeLessThan(applySql.indexOf('COMMIT;'))
  })

  it('uses orphan baselines and fails only on a positive orphan delta', async () => {
    const applySql = await artifact(applySqlPath)

    expect(applySql).toContain('before_count')
    expect(applySql).toContain('after_count')
    expect(applySql).toContain('delta')
    expect(applySql).toContain('orphan delta')
    expect(applySql).toContain('after_count > before_count')
    expect(applySql).toContain('session_replay')
    expect(applySql).toContain('heatmap_event')
  })

  it('censuses null timestamps and guards before the first destructive statement', async () => {
    const [checkSql, applySql] = await Promise.all([artifact(checkSqlPath), artifact(applySqlPath)])
    const firstDelete = applySql.indexOf('DELETE FROM')
    const nullGuard = applySql.indexOf('retention blocked: null created_at timestamps')

    expect(checkSql).toContain('null_created_at')
    expect(applySql).toContain('null_created_at')
    expect(applySql).toContain('retention blocked: null created_at timestamps')
    expect(nullGuard).toBeGreaterThanOrEqual(0)
    expect(nullGuard).toBeLessThan(firstDelete)
  })

  it('uses a transaction-scoped PostgreSQL advisory lock', async () => {
    const [checkSql, applySql] = await Promise.all([artifact(checkSqlPath), artifact(applySqlPath)])

    expect(applySql).toContain("pg_try_advisory_xact_lock(hashtextextended('umami-retention', 0))")
    expect(checkSql).toContain("pg_try_advisory_xact_lock(hashtextextended('umami-retention', 0))")
    expect(applySql).not.toContain('pg_advisory_xact_lock(hashtextextended')
    expect(applySql).toContain('retention advisory lock is already held')
    expect(applySql).toContain("SET LOCAL lock_timeout = '5s';")
    expect(applySql).toContain("SET LOCAL statement_timeout = '15min';")
    expect(checkSql).toContain("SET LOCAL lock_timeout = '5s';")
    expect(checkSql).toContain("SET LOCAL statement_timeout = '15min';")
  })

  it('does not reset, drop, truncate, or destroy the compose volume', async () => {
    const source = await Promise.all([artifact(runnerPath), artifact(checkSqlPath), artifact(applySqlPath)])
    const combined = source.join('\n')

    expect(combined).not.toMatch(/docker compose[^\n]*(?:down|rm|volume|reset)/i)
    expect(combined).not.toMatch(/\b(?:DROP\s+(?:DATABASE|SCHEMA|TABLE|OWNED)|TRUNCATE|RESET)\b/i)
  })

  it('emits deterministic before/deleted/remaining records', async () => {
    const [checkSql, applySql] = await Promise.all([artifact(checkSqlPath), artifact(applySqlPath)])
    const countPattern = /RETENTION\|mode=apply\|table=%s\|before=%s\|deleted=%s\|protected=%s\|remaining=%s/

    expect(applySql).toContain("'RETENTION|mode=apply|table=%s|before=%s|deleted=%s|protected=%s|remaining=%s'")
    expect(applySql).toMatch(countPattern)
    expect(checkSql).toContain("'RETENTION|mode=check|table=%s|before=%s|deleted=0|protected=%s|remaining=%s'")
    expect(applySql).toContain('orphan_table')
    expect(applySql).toContain('orphans')
    expect(applySql).toContain('before=%s|after=%s|delta=%s')
  })

  it('quotes the compose path and does not log credentials', async () => {
    const secret = 'do-not-print-this-password'
    const composeDirectory = await mkdtemp(join(tmpdir(), 'umami retention compose-'))
    const composePath = join(composeDirectory, 'compose file.yaml')
    const result = await runRunner('--check', {composePath})

    expect(result.exitCode).toBe(0)
    expect(result.args).toContain('--file')
    expect(result.args[result.args.indexOf('--file') + 1]).toBe(composePath)
    expect(result.args).toContain('exec')
    expect(result.stdout).not.toContain(secret)
    expect(result.stderr).not.toContain(secret)

    const runner = await artifact(runnerPath)
    expect(runner).toContain('set -Eeuo pipefail')
    expect(runner).not.toContain('set -x')
    expect(runner).not.toContain('POSTGRES_PASSWORD')
    expect(runner).not.toContain('UMAMI_DB_PASSWORD')

    await rm(composeDirectory, {force: true, recursive: true})
  })

  it('propagates a compose or psql failure without continuing', async () => {
    const result = await runRunner('--apply', {
      dockerBody: String.raw`printf '%s\n' 'raw psql failure' >&2`,
      dockerExitCode: 23,
    })

    expect(result.exitCode).toBe(23)
    expect(result.sql).toContain('BEGIN;')
    expect(result.sql).toContain('DELETE FROM event_data')
    expect(result.stderr).toContain('raw psql failure')
    expect(result.stderr).toContain('RETENTION|mode=apply|status=failure|exit=23|reason=psql')
  })
})
