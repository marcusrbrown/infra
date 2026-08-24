import {readFile} from 'node:fs/promises'
import {describe, expect, it, setDefaultTimeout} from 'bun:test'

setDefaultTimeout(120_000)

interface CommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

const appDirectory = new URL('.', import.meta.url).pathname
const applySqlPath = `${appDirectory}/retention.sql`
const checkSqlPath = `${appDirectory}/retention-check.sql`
const postgresImage = 'postgres:15-alpine'
const dockerProbe = Bun.spawnSync(['docker', 'info'])
const dockerAvailable = dockerProbe.exitCode === 0
const imageProbe = dockerAvailable ? Bun.spawnSync(['docker', 'image', 'inspect', postgresImage]) : undefined
const postgresImageAvailable = imageProbe?.exitCode === 0
const dockerReason = dockerAvailable
  ? `required image ${postgresImage} is not available locally`
  : dockerProbe.stderr.toString().trim() || 'docker info exited non-zero'
const integrationTest = dockerAvailable && postgresImageAvailable ? it : it.skip

const schemaSql = `
CREATE SCHEMA retention_test;
SET search_path = retention_test, public;

CREATE TABLE session (
  session_id uuid PRIMARY KEY,
  created_at timestamptz
);
CREATE TABLE website_event (
  event_id uuid PRIMARY KEY,
  session_id uuid,
  created_at timestamptz
);
CREATE TABLE event_data (
  event_data_id uuid PRIMARY KEY,
  website_event_id uuid,
  created_at timestamptz
);
CREATE TABLE session_data (
  session_data_id uuid PRIMARY KEY,
  session_id uuid,
  created_at timestamptz
);
CREATE TABLE revenue (
  revenue_id uuid PRIMARY KEY,
  session_id uuid,
  created_at timestamptz
);
CREATE TABLE session_replay (
  replay_id uuid PRIMARY KEY,
  website_id uuid NOT NULL,
  session_id uuid,
  visit_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  created_at timestamptz
);
CREATE TABLE session_replay_saved (
  saved_replay_id uuid PRIMARY KEY,
  website_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  UNIQUE (website_id, visit_id),
  created_at timestamptz
);
CREATE TABLE heatmap_event (
  heatmap_event_id uuid PRIMARY KEY,
  session_id uuid,
  created_at timestamptz NOT NULL
);
`

const basePsqlArgs = (container: string): string[] => [
  'docker',
  'exec',
  '-i',
  container,
  'psql',
  '-X',
  '-v',
  'ON_ERROR_STOP=1',
  '-U',
  'umami',
  '-d',
  'umami',
  '-A',
  '-t',
]

async function runCommand(command: string[], input?: string): Promise<CommandResult> {
  const process = Bun.spawn(command, {
    stderr: 'pipe',
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
  })

  if (input !== undefined) {
    const stdin = process.stdin
    if (stdin === undefined) {
      throw new Error('command stdin was not available')
    }
    stdin.write(input)
    stdin.end()
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  return {exitCode, stderr, stdout}
}

async function psql(container: string, sql: string): Promise<CommandResult> {
  return runCommand(basePsqlArgs(container), `SET search_path = retention_test, public;\n${sql}`)
}

async function runRetention(container: string, sql: string): Promise<CommandResult> {
  const source = await readFile(sql, 'utf8')
  return psql(container, source)
}

async function resetDatabase(container: string): Promise<void> {
  const drop = await psql(container, 'DROP SCHEMA IF EXISTS retention_test CASCADE;')
  if (drop.exitCode !== 0) {
    throw new Error(`schema drop failed: ${drop.stderr}`)
  }
  const create = await psql(container, schemaSql)
  if (create.exitCode !== 0) {
    throw new Error(`schema create failed: ${create.stderr}`)
  }
  const verify = await psql(container, "SELECT to_regclass('retention_test.session') IS NOT NULL;")
  if (verify.exitCode !== 0 || queryLines(verify).join() !== 't') {
    throw new Error(`schema verification failed: ${verify.stdout}\n${verify.stderr}`)
  }
}

async function waitForPostgres(container: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await psql(container, 'SELECT 1;')
    if (result.exitCode === 0) return
    await Bun.sleep(1000)
  }

  throw new Error('PostgreSQL container did not become ready within 90 seconds')
}

function expectOutput(result: CommandResult, text: string): void {
  expect(`${result.stdout}\n${result.stderr}`).toContain(text)
}

function queryLines(result: CommandResult): string[] {
  return result.stdout
    .trim()
    .split('\n')
    .filter(line => line.length > 0 && line !== 'SET')
}

describe('Umami retention PostgreSQL 15 integration', () => {
  integrationTest(
    dockerAvailable
      ? 'covers retention safety scenarios against PostgreSQL 15'
      : `requires Docker daemon (skipped: ${dockerReason})`,
    async () => {
      const container = `umami-retention-integration-${process.pid}-${Date.now()}`
      const start = await runCommand([
        'docker',
        'run',
        '--detach',
        '--rm',
        '--name',
        container,
        '--env',
        'POSTGRES_DB=umami',
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        '--env',
        'POSTGRES_USER=umami',
        postgresImage,
      ])

      expect(start.exitCode).toBe(0)

      try {
        await waitForPostgres(container)

        await resetDatabase(container)
        const ordinaryFixture = `
INSERT INTO session VALUES
  ('00000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('00000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP - INTERVAL '12 months');
INSERT INTO website_event VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP - INTERVAL '12 months');
INSERT INTO event_data VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP - INTERVAL '12 months');
INSERT INTO session_data VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP - INTERVAL '12 months');
INSERT INTO revenue VALUES
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP - INTERVAL '12 months');
INSERT INTO session_replay VALUES
  ('50000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 0, CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('50000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000002', 0, CURRENT_TIMESTAMP - INTERVAL '12 months');
INSERT INTO session_replay_saved VALUES
  ('60000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('60000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP - INTERVAL '12 months');
INSERT INTO heatmap_event VALUES
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('70000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP - INTERVAL '12 months');
`
        expect((await psql(container, ordinaryFixture)).exitCode).toBe(0)

        const check = await runRetention(container, checkSqlPath)
        expect(check.exitCode).toBe(0)
        expectOutput(check, 'RETENTION|mode=check|table=event_data|before=1|deleted=0|protected=0|remaining=1')
        expectOutput(check, 'RETENTION|mode=check|table=session|before=1|deleted=0|protected=0|remaining=1')

        const ordinaryApply = await runRetention(container, applySqlPath)
        expect(ordinaryApply.exitCode).toBe(0)
        expectOutput(ordinaryApply, 'RETENTION|mode=apply|table=event_data|before=1|deleted=1|protected=0|remaining=0')
        expectOutput(ordinaryApply, 'RETENTION|mode=apply|table=session|before=1|deleted=1|protected=0|remaining=0')
        expectOutput(ordinaryApply, 'orphan_table=session_replay|before=0|after=0|delta=0')

        const ordinaryCounts = await psql(
          container,
          `SET search_path = retention_test, public;
SELECT 'event_data=' || count(*) FROM event_data
UNION ALL SELECT 'website_event=' || count(*) FROM website_event
UNION ALL SELECT 'session_data=' || count(*) FROM session_data
UNION ALL SELECT 'revenue=' || count(*) FROM revenue
UNION ALL SELECT 'session_replay=' || count(*) FROM session_replay
UNION ALL SELECT 'session_replay_saved=' || count(*) FROM session_replay_saved
UNION ALL SELECT 'heatmap_event=' || count(*) FROM heatmap_event
UNION ALL SELECT 'session=' || count(*) FROM session
ORDER BY 1;`,
        )
        expect(ordinaryCounts.exitCode).toBe(0)
        for (const table of [
          'event_data',
          'website_event',
          'session_data',
          'revenue',
          'session_replay',
          'session_replay_saved',
          'heatmap_event',
          'session',
        ]) {
          expect(ordinaryCounts.stdout).toContain(`${table}=1`)
        }

        await resetDatabase(container)
        const savedMarkerWithExpiredChunk = await psql(
          container,
          `INSERT INTO session VALUES
  ('00000000-0000-0000-0000-000000000100', CURRENT_TIMESTAMP - INTERVAL '1 month'),
  ('00000000-0000-0000-0000-000000000101', CURRENT_TIMESTAMP - INTERVAL '1 month');
INSERT INTO session_replay VALUES
  ('50000000-0000-0000-0000-000000000100', '80000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000100', '90000000-0000-0000-0000-000000000100', 0, CURRENT_TIMESTAMP - INTERVAL '14 months'),
  ('50000000-0000-0000-0000-000000000101', '80000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000101', '90000000-0000-0000-0000-000000000101', 0, CURRENT_TIMESTAMP - INTERVAL '1 month');
INSERT INTO session_replay_saved VALUES
  ('60000000-0000-0000-0000-000000000100', '80000000-0000-0000-0000-000000000100', '90000000-0000-0000-0000-000000000100', CURRENT_TIMESTAMP - INTERVAL '1 month'),
  ('60000000-0000-0000-0000-000000000101', '80000000-0000-0000-0000-000000000101', '90000000-0000-0000-0000-000000000101', CURRENT_TIMESTAMP - INTERVAL '1 month');`,
        )
        expect(savedMarkerWithExpiredChunk.exitCode).toBe(0)

        const savedMarkerCheck = await runRetention(container, checkSqlPath)
        expect(savedMarkerCheck.exitCode).toBe(0)
        expectOutput(
          savedMarkerCheck,
          'RETENTION|mode=check|table=session_replay_saved|before=1|deleted=0|protected=0|remaining=1',
        )

        const savedMarkerApply = await runRetention(container, applySqlPath)
        expect(savedMarkerApply.exitCode).toBe(0)
        expectOutput(
          savedMarkerApply,
          'RETENTION|mode=apply|table=session_replay|before=1|deleted=1|protected=0|remaining=0',
        )
        expectOutput(
          savedMarkerApply,
          'RETENTION|mode=apply|table=session_replay_saved|before=1|deleted=1|protected=0|remaining=0',
        )
        expect(
          queryLines(
            await psql(
              container,
              `SELECT count(*) FROM session_replay WHERE website_id = '80000000-0000-0000-0000-000000000100' AND visit_id = '90000000-0000-0000-0000-000000000100';
SELECT count(*) FROM session_replay_saved WHERE website_id = '80000000-0000-0000-0000-000000000100' AND visit_id = '90000000-0000-0000-0000-000000000100';
SELECT count(*) FROM session_replay WHERE website_id = '80000000-0000-0000-0000-000000000101' AND visit_id = '90000000-0000-0000-0000-000000000101';
SELECT count(*) FROM session_replay_saved WHERE website_id = '80000000-0000-0000-0000-000000000101' AND visit_id = '90000000-0000-0000-0000-000000000101';`,
            ),
          ),
        ).toEqual(['0', '0', '1', '1'])

        await resetDatabase(container)
        const concurrentSavedMarkerFixture = await psql(
          container,
          `INSERT INTO session VALUES ('00000000-0000-0000-0000-000000000102', CURRENT_TIMESTAMP - INTERVAL '1 month');
INSERT INTO session_replay VALUES
  ('50000000-0000-0000-0000-000000000102', '80000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000102', '90000000-0000-0000-0000-000000000102', 0, CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO session_replay_saved VALUES
  ('60000000-0000-0000-0000-000000000102', '80000000-0000-0000-0000-000000000102', '90000000-0000-0000-0000-000000000102', CURRENT_TIMESTAMP - INTERVAL '1 month');
CREATE FUNCTION resave_replay_marker_during_chunk_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO session_replay_saved (saved_replay_id, website_id, visit_id, created_at)
  VALUES ('60000000-0000-0000-0000-000000000103', OLD.website_id, OLD.visit_id, CURRENT_TIMESTAMP);
  RETURN OLD;
END
$$;
CREATE TRIGGER resave_replay_marker_trigger
AFTER DELETE ON session_replay
FOR EACH ROW EXECUTE FUNCTION resave_replay_marker_during_chunk_delete();`,
        )
        expect(concurrentSavedMarkerFixture.exitCode).toBe(0)

        const concurrentSavedMarkerApply = await runRetention(container, applySqlPath)
        expect(concurrentSavedMarkerApply.exitCode).toBe(0)
        expectOutput(
          concurrentSavedMarkerApply,
          'RETENTION|mode=apply|table=session_replay_saved|before=1|deleted=2|protected=0|remaining=0',
        )
        expectOutput(
          concurrentSavedMarkerApply,
          'RETENTION|mode=apply|table=session_replay|before=1|deleted=1|protected=0|remaining=0',
        )
        expect(
          queryLines(
            await psql(
              container,
              `SELECT count(*) FROM session_replay WHERE website_id = '80000000-0000-0000-0000-000000000102' AND visit_id = '90000000-0000-0000-0000-000000000102';
SELECT count(*) FROM session_replay_saved WHERE website_id = '80000000-0000-0000-0000-000000000102' AND visit_id = '90000000-0000-0000-0000-000000000102';`,
            ),
          ),
        ).toEqual(['0', '0'])

        await resetDatabase(container)
        const transitiveFixture = await psql(
          container,
          `INSERT INTO session VALUES ('00000000-0000-0000-0000-000000000012', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO website_event VALUES ('10000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000012', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO event_data VALUES ('20000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000012', CURRENT_TIMESTAMP - INTERVAL '12 months');`,
        )
        expect(transitiveFixture.exitCode).toBe(0)

        const transitiveCheck = await runRetention(container, checkSqlPath)
        expect(transitiveCheck.exitCode).toBe(0)
        expectOutput(
          transitiveCheck,
          'RETENTION|mode=check|table=website_event|before=1|deleted=0|protected=1|remaining=0',
        )
        expectOutput(transitiveCheck, 'RETENTION|mode=check|table=session|before=1|deleted=0|protected=1|remaining=0')

        const transitiveApply = await runRetention(container, applySqlPath)
        expect(transitiveApply.exitCode).toBe(0)
        expectOutput(
          transitiveApply,
          'RETENTION|mode=apply|table=website_event|before=1|deleted=0|protected=1|remaining=0',
        )
        expectOutput(transitiveApply, 'RETENTION|mode=apply|table=session|before=1|deleted=0|protected=1|remaining=0')
        expect(
          queryLines(
            await psql(
              container,
              'SELECT count(*) FROM session; SELECT count(*) FROM website_event; SELECT count(*) FROM event_data;',
            ),
          ),
        ).toEqual(['1', '1', '1'])

        await resetDatabase(container)
        const survivingChild = await psql(
          container,
          `SET search_path = retention_test, public;
INSERT INTO session VALUES ('00000000-0000-0000-0000-000000000010', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO website_event VALUES ('10000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO event_data VALUES ('20000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000010', CURRENT_TIMESTAMP - INTERVAL '12 months');
INSERT INTO session_data VALUES ('30000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO revenue VALUES ('40000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO session_replay VALUES
  ('50000000-0000-0000-0000-000000000010', '80000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010', '90000000-0000-0000-0000-000000000010', 0, CURRENT_TIMESTAMP - INTERVAL '12 months'),
  ('50000000-0000-0000-0000-000000000011', '80000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010', '90000000-0000-0000-0000-000000000010', 1, CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO heatmap_event VALUES
  ('70000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010', CURRENT_TIMESTAMP - INTERVAL '12 months'),
  ('70000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000010', CURRENT_TIMESTAMP - INTERVAL '14 months');`,
        )
        if (survivingChild.exitCode !== 0) {
          throw new Error(`${survivingChild.stdout}\n${survivingChild.stderr}`)
        }
        const blockedApply = await runRetention(container, applySqlPath)
        expect(blockedApply.exitCode).toBe(0)
        expectOutput(
          blockedApply,
          'RETENTION|mode=apply|table=website_event|before=1|deleted=0|protected=1|remaining=0',
        )
        expectOutput(blockedApply, 'RETENTION|mode=apply|table=session|before=1|deleted=0|protected=1|remaining=0')
        expectOutput(blockedApply, 'RETENTION|mode=apply|table=session_data|before=1|deleted=1|protected=0|remaining=0')
        expectOutput(blockedApply, 'RETENTION|mode=apply|table=revenue|before=1|deleted=1|protected=0|remaining=0')
        expectOutput(
          blockedApply,
          'RETENTION|mode=apply|table=session_replay|before=1|deleted=1|protected=0|remaining=0',
        )
        expectOutput(
          blockedApply,
          'RETENTION|mode=apply|table=heatmap_event|before=1|deleted=1|protected=0|remaining=0',
        )
        const blockedCounts = await psql(
          container,
          'SELECT count(*) FROM session; SELECT count(*) FROM website_event; SELECT count(*) FROM event_data; SELECT count(*) FROM session_data; SELECT count(*) FROM revenue; SELECT count(*) FROM session_replay; SELECT count(*) FROM heatmap_event;',
        )
        expect(queryLines(blockedCounts)).toEqual(['1', '1', '1', '0', '0', '1', '1'])

        await resetDatabase(container)
        const baselineOrphan = await psql(
          container,
          `INSERT INTO session VALUES ('00000000-0000-0000-0000-000000000020', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO event_data VALUES ('20000000-0000-0000-0000-000000000020', '10000000-0000-0000-0000-000000000020', CURRENT_TIMESTAMP - INTERVAL '12 months');`,
        )
        expect(baselineOrphan.exitCode).toBe(0)
        const baselineApply = await runRetention(container, applySqlPath)
        expect(baselineApply.exitCode).toBe(0)
        expectOutput(baselineApply, 'orphan_table=event_data|before=1|after=1|delta=0')
        expect(
          queryLines(await psql(container, 'SELECT count(*) FROM session; SELECT count(*) FROM event_data;')),
        ).toEqual(['0', '1'])

        await resetDatabase(container)
        const triggerFixture = await psql(
          container,
          `INSERT INTO session VALUES ('00000000-0000-0000-0000-000000000030', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO website_event VALUES ('10000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000030', CURRENT_TIMESTAMP - INTERVAL '14 months');
INSERT INTO event_data VALUES ('20000000-0000-0000-0000-000000000030', '10000000-0000-0000-0000-000000000030', CURRENT_TIMESTAMP - INTERVAL '14 months');
CREATE FUNCTION create_retention_orphan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO event_data VALUES ('20000000-0000-0000-0000-000000000031', OLD.event_id, CURRENT_TIMESTAMP - INTERVAL '12 months');
  RETURN OLD;
END
$$;
CREATE TRIGGER retention_orphan_trigger AFTER DELETE ON website_event FOR EACH ROW EXECUTE FUNCTION create_retention_orphan();`,
        )
        expect(triggerFixture.exitCode).toBe(0)
        const orphanDeltaApply = await runRetention(container, applySqlPath)
        expect(orphanDeltaApply.exitCode).not.toBe(0)
        expectOutput(orphanDeltaApply, 'orphan delta')
        expect(
          queryLines(
            await psql(
              container,
              'SELECT count(*) FROM session; SELECT count(*) FROM website_event; SELECT count(*) FROM event_data;',
            ),
          ),
        ).toEqual(['1', '1', '1'])

        await resetDatabase(container)
        const nullFixture = await psql(
          container,
          `INSERT INTO session VALUES
  ('00000000-0000-0000-0000-000000000040', NULL),
  ('00000000-0000-0000-0000-000000000041', CURRENT_TIMESTAMP - INTERVAL '14 months');`,
        )
        expect(nullFixture.exitCode).toBe(0)
        const nullCheck = await runRetention(container, checkSqlPath)
        expect(nullCheck.exitCode).not.toBe(0)
        expectOutput(nullCheck, 'table=session|null_created_at=1')
        const nullApply = await runRetention(container, applySqlPath)
        expect(nullApply.exitCode).not.toBe(0)
        expectOutput(nullApply, 'retention blocked: null created_at timestamps')
        expect(queryLines(await psql(container, 'SELECT count(*) FROM session;'))).toEqual(['2'])

        await resetDatabase(container)
        const lockFixture = await psql(
          container,
          "INSERT INTO session VALUES ('00000000-0000-0000-0000-000000000050', CURRENT_TIMESTAMP - INTERVAL '14 months');",
        )
        expect(lockFixture.exitCode).toBe(0)
        const holder = Bun.spawn(
          [
            'docker',
            'exec',
            container,
            'psql',
            '-X',
            '-U',
            'umami',
            '-d',
            'umami',
            '-c',
            "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('umami-retention', 0)); SELECT pg_sleep(3);",
          ],
          {stderr: 'pipe', stdout: 'pipe'},
        )
        await Bun.sleep(500)
        const lockApply = await runRetention(container, applySqlPath)
        expect(lockApply.exitCode).not.toBe(0)
        expectOutput(lockApply, 'retention advisory lock is already held')
        await holder.exited
      } finally {
        await runCommand(['docker', 'rm', '--force', container])
      }
    },
  )
})
