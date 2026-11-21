import type {RemoteExec, RunResult} from '../server/provision'
import type {LifecycleRule} from './retention'

import {describe, expect, it} from 'bun:test'
import {
  addLifecycleScript,
  applyTtlScript,
  applyTtlSql,
  assertRetention,
  canonicalTtl,
  extractTtl,
  OBJECT_STORE_PREFIXES,
  parseLifecycle,
  parseTableStates,
  prefixState,
  readLifecycleScript,
  readTtlScript,
  readTtlSql,
  RETENTION_COMPOSE,
  RETENTION_TABLES,
  RetentionError,
  ttlExpression,
  ttlMatches,
} from './retention'

// ─── A tiny ClickHouse and object-store simulation behind one RemoteExec ──────

const ok = (stdout: string): RunResult => ({exitCode: 0, stdout, stderr: ''})
const fail = (stderr: string): RunResult => ({exitCode: 1, stdout: '', stderr})

const NORMALISED_30 = (column: string): string => `toDateTime(${column}) + toIntervalDay(30)`

interface SimOptions {
  /** Tables that exist, by name, with an optional starting TTL text (as ClickHouse echoes it). */
  tables?: Record<string, string | undefined>
  /** Rules the bucket starts with. */
  rules?: {Prefix: string; Days: number; Status?: string}[]
  /** ALTER answers success but the table does not keep it. */
  alterIgnored?: boolean
  /** ALTER fails for these tables (the whole statement list fails). */
  alterFails?: string[]
  /** `rule add` answers success but adds nothing. */
  addIgnored?: boolean
  /** The bucket has no lifecycle configuration at all. */
  noLifecycle?: boolean
}

class Sim {
  tables = new Map<string, string | undefined>()
  rules: {Prefix: string; Days: number; Status: string}[] = []
  commands: {command: string; stdin: string | undefined}[] = []
  constructor(private readonly options: SimOptions = {}) {
    for (const [name, ttl] of Object.entries(options.tables ?? {})) this.tables.set(name, ttl)
    this.rules = (options.rules ?? []).map(rule => ({Status: 'Enabled', ...rule}))
  }

  exec: RemoteExec = async (command, stdin) => {
    this.commands.push({command, stdin})
    if (command.includes('traces-step:retention-read-ttl')) {
      const rows = [...this.tables.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, ttl]) =>
          JSON.stringify({
            name,
            create_table_query: `CREATE TABLE default.${name}\n(\n    \`x\` String\n)\nENGINE = ReplacingMergeTree\n${ttl === undefined ? '' : `TTL ${ttl}\n`}SETTINGS index_granularity = 8192`,
          }),
        )
      return ok(`${rows.join('\n')}\nTRACES_TTL_READ\n`)
    }
    if (command.includes('traces-step:retention-apply-ttl')) {
      const statements = (stdin ?? '').split(';').filter(statement => statement.trim() !== '')
      const touched = statements.map(statement => /ALTER TABLE default\.(\w+) MODIFY TTL (.+)/.exec(statement.trim()))
      for (const match of touched) {
        const name = match?.[1]
        if (name !== undefined && this.options.alterFails?.includes(name)) return fail(`Code: 36. cannot alter ${name}`)
      }
      if (!this.options.alterIgnored) {
        for (const match of touched) {
          const name = match?.[1]
          const column = /toDateTime\((\w+)\)/.exec(match?.[2] ?? '')?.[1]
          if (name !== undefined && column !== undefined) this.tables.set(name, NORMALISED_30(column))
        }
      }
      return ok('TRACES_TTL_APPLIED\n')
    }
    if (command.includes('traces-step:retention-read-lifecycle')) {
      if (this.options.noLifecycle && this.rules.length === 0) return ok('TRACES_ILM_NONE\n')
      const document = {
        Rules: this.rules.map((rule, index) => ({
          ID: `rule-${index}`,
          Status: rule.Status,
          Expiration: {Days: rule.Days},
          Filter: {Prefix: rule.Prefix},
        })),
      }
      return ok(`${JSON.stringify(document, undefined, 2)}\nTRACES_ILM_READ\n`)
    }
    if (command.includes('traces-step:retention-add-lifecycle')) {
      const prefix = OBJECT_STORE_PREFIXES.find(
        candidate => command.includes(`--prefix`) && command.includes(candidate),
      )
      if (!this.options.addIgnored && prefix !== undefined)
        this.rules.push({Prefix: prefix, Days: 30, Status: 'Enabled'})
      return ok('TRACES_ILM_ADDED\n')
    }
    return fail('unexpected command')
  }

  get alterCalls(): number {
    return this.commands.filter(entry => entry.command.includes('retention-apply-ttl')).length
  }

  get addCalls(): number {
    return this.commands.filter(entry => entry.command.includes('retention-add-lifecycle')).length
  }
}

const REQUIRED_ONLY = {events_full: undefined, events_core: undefined}

describe('TTL text', () => {
  it('sets a 30-day TTL counted from the span start', () => {
    expect(ttlExpression('start_time')).toBe('toDateTime(start_time) + INTERVAL 30 DAY')
  })

  it('treats the interval function and the interval literal as the same rule', () => {
    expect(canonicalTtl('toDateTime(start_time)  +   toIntervalDay(30)')).toBe(
      canonicalTtl('toDateTime(start_time) + INTERVAL 30 DAY'),
    )
    expect(ttlMatches('start_time', 'toDateTime(start_time) + toIntervalDay(30)')).toBe(true)
  })

  it('does not match another length, another column or no TTL', () => {
    expect(ttlMatches('start_time', 'toDateTime(start_time) + toIntervalDay(31)')).toBe(false)
    expect(ttlMatches('start_time', 'toDateTime(timestamp) + toIntervalDay(30)')).toBe(false)
    expect(ttlMatches('start_time', 'toDateTime(start_time) + toIntervalDay(30), other TO VOLUME x')).toBe(false)
    expect(ttlMatches('start_time', undefined)).toBe(false)
  })

  it('reads the TTL line out of a table definition', () => {
    const query =
      'CREATE TABLE default.t\n(\n  `a` String\n)\nENGINE = X\nTTL toDateTime(a) + toIntervalDay(30)\nSETTINGS a = 1'
    expect(extractTtl(query)).toBe('toDateTime(a) + toIntervalDay(30)')
    expect(extractTtl('CREATE TABLE default.t\n(\n  `a` String\n)\nENGINE = X\nSETTINGS a = 1')).toBeUndefined()
  })

  // The shape `system.tables.create_table_query` has on the host: one line, TTL before SETTINGS.
  it('reads the TTL out of a one-line table definition', () => {
    const oneLine =
      'CREATE TABLE default.events_core (`id` String, `start_time` DateTime64(6)) ENGINE = ReplacingMergeTree(event_ts, is_deleted) PARTITION BY toYYYYMM(start_time) ORDER BY (project_id, start_time) TTL toDateTime(start_time) + toIntervalDay(30) SETTINGS enable_block_number_column = 1, prewarm_mark_cache = 1'
    expect(extractTtl(oneLine)).toBe('toDateTime(start_time) + toIntervalDay(30)')
    expect(ttlMatches('start_time', extractTtl(oneLine))).toBe(true)
    expect(extractTtl(oneLine.replace(/ TTL .* SETTINGS/, ' SETTINGS'))).toBeUndefined()
    expect(extractTtl('CREATE TABLE default.t (`a` DateTime) ENGINE = X ORDER BY a TTL a + toIntervalDay(30)')).toBe(
      'a + toIntervalDay(30)',
    )
  })

  it('covers the two proven tables as required and the older trace tables as optional', () => {
    const required = RETENTION_TABLES.filter(table => table.required).map(table => table.name)
    expect(required).toEqual(['events_full', 'events_core'])
    expect(RETENTION_TABLES.map(table => table.name)).toContain('observations')
    for (const table of RETENTION_TABLES) expect(table.column).toMatch(/^[a-z_]+$/)
  })
})

describe('parsing', () => {
  it('rejects a table answer that is not a row with the two fields', () => {
    expect(() => parseTableStates('not json\n')).toThrow('unreadable')
    expect(() => parseTableStates('{"name":"events_full"}\n')).toThrow('unexpected')
  })

  it('reads the three spellings of a lifecycle prefix and the day count', () => {
    const text = JSON.stringify({
      Rules: [
        {Status: 'Enabled', Expiration: {Days: 30}, Filter: {Prefix: 'events/'}},
        {Status: 'Enabled', Expiration: {Days: 30}, Prefix: 'media/'},
        {Status: 'Disabled', Expiration: {Days: 7}, Filter: {And: {Prefix: 'x/'}}},
      ],
    })
    expect(parseLifecycle(`warning\n${text}\n`)).toEqual([
      {prefix: 'events/', days: 30, enabled: true},
      {prefix: 'media/', days: 30, enabled: true},
      {prefix: 'x/', days: 7, enabled: false},
    ])
  })

  it('throws on a lifecycle answer that is not a rule document', () => {
    expect(() => parseLifecycle('nothing here')).toThrow('unreadable')
    expect(() => parseLifecycle('{"Other":[]}')).toThrow('no rule list')
  })

  it('classifies a prefix by its rules', () => {
    const rules: LifecycleRule[] = [
      {prefix: 'events/', days: 30, enabled: true},
      {prefix: 'media/', days: 90, enabled: true},
    ]
    expect(prefixState(rules, 'events/')).toBe('satisfied')
    expect(prefixState(rules, 'media/')).toBe('conflict')
    expect(prefixState(rules, 'exports/')).toBe('absent')
    expect(prefixState([{prefix: 'events/', days: 30, enabled: false}], 'events/')).toBe('conflict')
  })
})

describe('assertRetention: ClickHouse', () => {
  it('sets the TTL on a fresh database, reads it back and adds both lifecycle rules', async () => {
    const sim = new Sim({tables: {...REQUIRED_ONLY, traces: undefined}, noLifecycle: true})
    const outcome = await assertRetention(sim.exec)

    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') return
    expect(outcome.report.altered).toEqual(['events_full', 'events_core', 'traces'])
    expect(outcome.report.tables).toEqual(['events_full', 'events_core', 'traces'])
    expect(outcome.report.skipped).toEqual(['observations', 'observations_pid_tid_sorting', 'scores'])
    expect(outcome.report.prefixesAdded).toEqual([...OBJECT_STORE_PREFIXES])
    for (const [name, ttl] of sim.tables) {
      const table = RETENTION_TABLES.find(entry => entry.name === name)
      expect(ttl).toBe(NORMALISED_30(table?.column ?? ''))
    }
  })

  it('issues no ALTER and adds no rule when everything is already in place', async () => {
    const sim = new Sim({
      tables: {events_full: NORMALISED_30('start_time'), events_core: NORMALISED_30('start_time')},
      rules: [
        {Prefix: 'events/', Days: 30},
        {Prefix: 'media/', Days: 30},
      ],
    })
    const outcome = await assertRetention(sim.exec)
    expect(outcome.status).toBe('ready')
    expect(sim.alterCalls).toBe(0)
    expect(sim.addCalls).toBe(0)
  })

  it('alters only the table whose TTL differs', async () => {
    const sim = new Sim({
      tables: {events_full: NORMALISED_30('start_time'), events_core: 'toDateTime(start_time) + toIntervalDay(90)'},
      rules: [
        {Prefix: 'events/', Days: 30},
        {Prefix: 'media/', Days: 30},
      ],
    })
    const outcome = await assertRetention(sim.exec)
    if (outcome.status !== 'ready') throw new Error('expected ready')
    expect(outcome.report.altered).toEqual(['events_core'])
    const sql = sim.commands.find(entry => entry.command.includes('retention-apply-ttl'))?.stdin ?? ''
    expect(sql).toContain('ALTER TABLE default.events_core MODIFY TTL')
    expect(sql).not.toContain('events_full')
  })

  it('is "not ready" when a required table does not exist, names it, and changes nothing', async () => {
    const sim = new Sim({tables: {events_full: undefined}, noLifecycle: true})
    const outcome = await assertRetention(sim.exec)
    expect(outcome).toEqual({status: 'not-ready', missing: ['events_core']})
    expect(sim.alterCalls).toBe(0)
    expect(sim.addCalls).toBe(0)
  })

  it('is "not ready" on a database with no tables at all', async () => {
    const outcome = await assertRetention(new Sim({tables: {}}).exec)
    expect(outcome).toEqual({status: 'not-ready', missing: ['events_full', 'events_core']})
  })

  it('fails when the TTL read-back differs from 30 days', async () => {
    const sim = new Sim({tables: REQUIRED_ONLY, alterIgnored: true})
    const failure = assertRetention(sim.exec)
    await expect(failure).rejects.toBeInstanceOf(RetentionError)
    await expect(failure).rejects.toThrow('read-back differs from 30 days on events_full, events_core')
  })

  it('fails and names the tables when an existing table cannot be altered', async () => {
    const sim = new Sim({tables: REQUIRED_ONLY, alterFails: ['events_core']})
    const failure = assertRetention(sim.exec)
    await expect(failure).rejects.toBeInstanceOf(RetentionError)
    await expect(failure).rejects.toThrow('Could not set the 30-day TTL on events_full, events_core')
  })

  it('fails closed on an answer it does not recognise', async () => {
    const exec: RemoteExec = async () => ok('something else\n')
    await expect(assertRetention(exec)).rejects.toThrow('unrecognised answer')
    const exited: RemoteExec = async () => fail('ssh: connection refused')
    await expect(assertRetention(exited)).rejects.toThrow('exit 1')
  })
})

describe('assertRetention: object store', () => {
  const READY_TABLES = {events_full: NORMALISED_30('start_time'), events_core: NORMALISED_30('start_time')}

  it('shows the 30-day rule on the batch prefix after the run', async () => {
    const sim = new Sim({tables: READY_TABLES, noLifecycle: true})
    await assertRetention(sim.exec)
    expect(sim.rules).toEqual([
      {Prefix: 'events/', Days: 30, Status: 'Enabled'},
      {Prefix: 'media/', Days: 30, Status: 'Enabled'},
    ])
  })

  it('adds only the missing prefix', async () => {
    const sim = new Sim({tables: READY_TABLES, rules: [{Prefix: 'events/', Days: 30}]})
    const outcome = await assertRetention(sim.exec)
    if (outcome.status !== 'ready') throw new Error('expected ready')
    expect(outcome.report.prefixesAdded).toEqual(['media/'])
    expect(sim.addCalls).toBe(1)
  })

  it('refuses to guess when a rule on a prefix is not a 30-day expiry', async () => {
    const sim = new Sim({tables: READY_TABLES, rules: [{Prefix: 'events/', Days: 90}]})
    await expect(assertRetention(sim.exec)).rejects.toThrow('already has a rule on events/')
    expect(sim.addCalls).toBe(0)
  })

  it('fails when the read-back does not show the rule that was added', async () => {
    const sim = new Sim({tables: READY_TABLES, noLifecycle: true, addIgnored: true})
    await expect(assertRetention(sim.exec)).rejects.toThrow('Lifecycle read-back does not show a 30-day rule')
  })

  it('does not mistake an unrelated failure for "no rules"', async () => {
    const exec: RemoteExec = async command => {
      if (command.includes('retention-read-ttl')) {
        return ok(
          `${JSON.stringify({name: 'events_full', create_table_query: `x\nTTL ${NORMALISED_30('start_time')}\n`})}\n${JSON.stringify({name: 'events_core', create_table_query: `x\nTTL ${NORMALISED_30('start_time')}\n`})}\nTRACES_TTL_READ\n`,
        )
      }
      return {exitCode: 1, stdout: '', stderr: 'mc: <ERROR> Unable to connect'}
    }
    await expect(assertRetention(exec)).rejects.toThrow('exit 1')
  })
})

describe('remote scripts', () => {
  const scripts: Record<string, string> = {
    readTtl: readTtlScript(),
    applyTtl: applyTtlScript(),
    readLifecycle: readLifecycleScript(),
    addEvents: addLifecycleScript('events/'),
    addMedia: addLifecycleScript('media/'),
  }

  it('parse as bash', () => {
    for (const [name, script] of Object.entries(scripts)) {
      const parsed = Bun.spawnSync(['bash', '-n', '-c', script])
      expect({name, exit: parsed.exitCode, stderr: parsed.stderr.toString()}).toEqual({name, exit: 0, stderr: ''})
    }
  })

  it('end in a sentinel, never touch the null device and never delete anything', () => {
    for (const script of Object.values(scripts)) {
      expect(script).toContain('# traces-step:retention-')
      expect(script).not.toContain('/dev/null')
      expect(script).not.toMatch(/\brm\b/)
    }
  })

  it('leave the passwords to be expanded inside the container', () => {
    expect(scripts.readTtl).toContain('"$CLICKHOUSE_PASSWORD"')
    expect(scripts.readLifecycle).toContain('$MINIO_ROOT_PASSWORD')
    // The password variables sit in a single-quoted inner command, so the host shell never expands them.
    expect(scripts.readTtl).toMatch(/sh -c '[^']*\$CLICKHOUSE_PASSWORD/)
    expect(scripts.addEvents).toMatch(/sh -c '[^']*\$MINIO_ROOT_PASSWORD/)
  })

  it('use the same compose invocation as the rest of the deploy', () => {
    expect(RETENTION_COMPOSE).toBe('docker compose --project-directory /mnt/traces/app')
    for (const script of Object.values(scripts)) expect(script).toContain(RETENTION_COMPOSE)
  })

  it('refuse a lifecycle rule for a prefix outside the list', () => {
    expect(() => addLifecycleScript('exports/')).toThrow('unknown prefix')
    expect(() => addLifecycleScript("events/'; id #")).toThrow('unknown prefix')
  })

  it('send SQL on stdin only: one ALTER per table with the 30-day expression', () => {
    const sql = applyTtlSql(RETENTION_TABLES.filter(table => table.required))
    expect(sql).toBe(
      'ALTER TABLE default.events_full MODIFY TTL toDateTime(start_time) + INTERVAL 30 DAY;\nALTER TABLE default.events_core MODIFY TTL toDateTime(start_time) + INTERVAL 30 DAY;\n',
    )
    expect(readTtlSql()).toContain("name IN ('events_full', 'events_core'")
  })
})
