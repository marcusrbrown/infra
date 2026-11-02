import {cpSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, describe, expect, it} from 'bun:test'

import {SERVICES} from '../data/services'
import {loadStatusHistory, readHistoryDir, StatusHistoryError} from './history-source'
import {resolveRunbooks} from './runbook-links'

const DOCS_ROOT = resolve(import.meta.dir, '../..')
const REPO_ROOT = resolve(DOCS_ROOT, '../..')
const FIXTURE = join(DOCS_ROOT, 'fixtures/history')

const scratch: string[] = []
function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'history-'))
  scratch.push(dir)
  cpSync(FIXTURE, dir, {recursive: true})
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, {recursive: true, force: true})
})

describe('loadStatusHistory', () => {
  it('uses the committed fixture when STATUS_HISTORY_DIR is unset', () => {
    const loaded = loadStatusHistory({}, DOCS_ROOT)

    expect(loaded.source).toBe('fixture')
    expect(Object.keys(loaded.history.apps)).toHaveLength(7)
  })

  it('reads STATUS_HISTORY_DIR when set', () => {
    const dir = copyFixture()
    const loaded = loadStatusHistory({STATUS_HISTORY_DIR: dir}, DOCS_ROOT)

    expect(loaded.source).toBe('artifact')
  })

  it('refuses the fixture when STATUS_HISTORY_REQUIRED=1 and no directory is set', () => {
    expect(() => loadStatusHistory({STATUS_HISTORY_REQUIRED: '1'}, DOCS_ROOT)).toThrow(/STATUS_HISTORY_REQUIRED/)
    expect(() => loadStatusHistory({STATUS_HISTORY_REQUIRED: '1', STATUS_HISTORY_DIR: ''}, DOCS_ROOT)).toThrow(
      /STATUS_HISTORY_REQUIRED/,
    )
  })

  it('reads the artifact when STATUS_HISTORY_REQUIRED=1 and a directory is set', () => {
    const dir = copyFixture()
    const env = {STATUS_HISTORY_REQUIRED: '1', STATUS_HISTORY_DIR: dir}

    expect(loadStatusHistory(env, DOCS_ROOT).source).toBe('artifact')
  })

  it('still uses the fixture when the flag is not 1', () => {
    expect(loadStatusHistory({STATUS_HISTORY_REQUIRED: '0'}, DOCS_ROOT).source).toBe('fixture')
  })

  it('fails with a clear message when the directory is missing', () => {
    expect(() => loadStatusHistory({STATUS_HISTORY_DIR: join(tmpdir(), 'no-such-history-dir')}, DOCS_ROOT)).toThrow(
      /Status history: meta\.json is missing/,
    )
  })
})

describe('readHistoryDir', () => {
  it('holds the fixture shape the page tests rely on', () => {
    const {history} = loadStatusHistory({}, DOCS_ROOT)
    const results = new Set(Object.values(history.apps).flatMap(samples => samples.flatMap(s => Object.values(s.r))))

    expect([...results].toSorted()).toEqual(['f', 'n', 'p', 'u'])
    expect(history.apps.vpn.at(-1)?.d?.['deploy-state']?.reason).toBe('at_gate')
  })

  it('rejects an unsupported schemaVersion', () => {
    const dir = copyFixture()
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({schemaVersion: 2, lastSampleAt: '2026-11-01T00:00:00.000Z'}))

    expect(() => readHistoryDir(dir)).toThrow(StatusHistoryError)
    expect(() => readHistoryDir(dir)).toThrow(/unsupported schemaVersion/)
  })

  it('rejects an invalid app file', () => {
    const dir = copyFixture()
    writeFileSync(join(dir, 'apps/gateway.json'), JSON.stringify([{t: 'yesterday'}]))

    expect(() => readHistoryDir(dir)).toThrow(/apps\/gateway\.json does not match/)
  })

  it('rejects a missing app file', () => {
    const dir = copyFixture()
    rmSync(join(dir, 'apps/vpn.json'))

    expect(() => readHistoryDir(dir)).toThrow(/apps\/vpn\.json is missing/)
  })

  it('rejects an unknown app file', () => {
    const dir = copyFixture()
    writeFileSync(join(dir, 'apps/rogue.json'), '[]')

    expect(() => readHistoryDir(dir)).toThrow(/unexpected file apps\/rogue\.json/)
  })

  it('rejects a history with no samples at all', () => {
    const dir = copyFixture()
    for (const app of Object.keys(SERVICES)) writeFileSync(join(dir, `apps/${app}.json`), '[]')

    expect(() => readHistoryDir(dir)).toThrow(/no samples/)
  })

  it('rejects malformed JSON', () => {
    const dir = copyFixture()
    writeFileSync(join(dir, 'meta.json'), '{')

    expect(() => readHistoryDir(dir)).toThrow(/not valid JSON/)
  })
})

describe('resolveRunbooks', () => {
  it('finds a runbook for every slug in services.ts, with its H1 as title', () => {
    for (const info of Object.values(SERVICES)) {
      for (const link of resolveRunbooks(info.runbooks, REPO_ROOT)) expect(link.title.length).toBeGreaterThan(0)
    }
  })

  it('throws for a slug with no runbook file', () => {
    expect(() => resolveRunbooks(['no-such-runbook'], REPO_ROOT)).toThrow(/no-such-runbook/)
  })
})
