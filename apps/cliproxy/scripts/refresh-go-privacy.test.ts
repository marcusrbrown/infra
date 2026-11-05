import type {ModelEntry, PrivacySnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {parseSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {parsePrivacyTable, PrivacyTableError} from '@marcusrbrown/infra-shared/opencode-go/parse-privacy-table'
import {afterEach, describe, expect, it} from 'bun:test'
import {
  COMMIT_API_URL,
  DEFAULT_SNAPSHOT_PATH,
  diffSnapshots,
  goMdxUrl,
  refreshGoPrivacy,
  serializeSnapshot,
  type FetchLike,
} from './refresh-go-privacy'

const FIXTURES = new URL('../../../packages/shared/opencode-go/__fixtures__/', import.meta.url)
const readFixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8')

const MDX = readFixture('go.mdx')
const OLD_SHA = '5eeb906b27f993c26037196b6d4a2a95cb606f6b'
const NEW_SHA = 'a'.repeat(40)

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true})
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'infra-go-privacy-'))
  temps.push(dir)
  return dir
}

/** The table the fixture parses to, stamped with `commit`. */
const tableAt = (commit: string): PrivacySnapshot => parsePrivacyTable(MDX, commit)

interface Harness {
  readonly dir: string
  readonly snapshotPath: string
  readonly bodyPath: string
  readonly calls: {url: string; init: RequestInit | undefined}[]
  readonly fetch: FetchLike
}

/**
 * A temp snapshot plus a fake fetch. The API answers with `sha`; the raw URL answers with `mdx`. Nothing touches
 * the network or the tracked snapshot.
 */
function harness(
  snapshot: PrivacySnapshot,
  options: {sha?: string; mdx?: string; apiResponse?: () => Response; rawResponse?: () => Response} = {},
): Harness {
  const dir = tempDir()
  const snapshotPath = join(dir, 'privacy-snapshot.json')
  writeFileSync(snapshotPath, serializeSnapshot(snapshot))
  const calls: Harness['calls'] = []
  const sha = options.sha ?? NEW_SHA
  const fetch: FetchLike = (url, init) => {
    calls.push({url, init})
    if (url === COMMIT_API_URL) return Promise.resolve(options.apiResponse?.() ?? Response.json({sha}))
    return Promise.resolve(options.rawResponse?.() ?? new Response(options.mdx ?? MDX))
  }
  return {dir, snapshotPath, bodyPath: join(dir, 'pr-body.md'), calls, fetch}
}

const run = (h: Harness) => refreshGoPrivacy({snapshotPath: h.snapshotPath, bodyPath: h.bodyPath, fetch: h.fetch})

function flip(entry: ModelEntry | undefined, field: 'zeroRetention' | 'trainsOnData'): ModelEntry {
  if (entry === undefined) throw new Error('fixture entry missing')
  return {...entry, [field]: !entry[field]}
}

/** The fixture's table with one model dropped, one flipped and one invented, so a refresh sees all three kinds. */
function staleSnapshot(): {snapshot: PrivacySnapshot; added: string; removed: string; changed: string} {
  const current = tableAt(OLD_SHA)
  const [added, changed] = Object.keys(current.models)
  if (added === undefined || changed === undefined) throw new Error('fixture has too few models')
  const {[added]: _dropped, ...rest} = current.models
  const flipped = flip(rest[changed], 'zeroRetention')
  return {
    snapshot: {...current, models: {...rest, [changed]: flipped, 'retired-model': flipped}},
    added,
    removed: 'retired-model',
    changed,
  }
}

const leftovers = (dir: string): string[] => readdirSync(dir).filter(name => name.endsWith('.tmp'))

describe('refreshGoPrivacy: unchanged table', () => {
  it('writes nothing and reports unchanged, even though the dev commit moved', async () => {
    const h = harness(tableAt(OLD_SHA))
    const before = readFileSync(h.snapshotPath, 'utf8')

    const result = await run(h)

    expect(result).toEqual({changed: false, sourceCommit: NEW_SHA})
    expect(readFileSync(h.snapshotPath, 'utf8')).toBe(before)
    expect(JSON.parse(before).source.commit).toBe(OLD_SHA)
    expect(existsSync(h.bodyPath)).toBe(false)
    expect(leftovers(h.dir)).toEqual([])
  })

  it('serializes exactly like the tracked snapshot, so an unchanged table is a byte-for-byte no-op', () => {
    const tracked = readFileSync(DEFAULT_SNAPSHOT_PATH, 'utf8')
    expect(serializeSnapshot(JSON.parse(tracked))).toBe(tracked)
  })
})

describe('refreshGoPrivacy: changed table', () => {
  it('rewrites the snapshot with the new source commit and the parsed models', async () => {
    const {snapshot} = staleSnapshot()
    const h = harness(snapshot)

    const result = await run(h)

    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA})
    const written = readFileSync(h.snapshotPath, 'utf8')
    expect(written).toBe(serializeSnapshot(tableAt(NEW_SHA)))
    expect(parseSnapshot(JSON.parse(written)).source.commit).toBe(NEW_SHA)
    expect(leftovers(h.dir)).toEqual([])
  })

  it('writes a PR body that lists added, removed and changed models with the compare link', async () => {
    const {snapshot, added, removed, changed} = staleSnapshot()
    const h = harness(snapshot)

    await run(h)

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain(`https://github.com/anomalyco/opencode/compare/${OLD_SHA}...${NEW_SHA}`)
    expect(body).toContain('### Added (1)')
    expect(body).toContain(`- \`${added}\`: zero retention:`)
    expect(body).toContain('### Removed (1)')
    expect(body).toContain(`- \`${removed}\`: was zero retention:`)
    expect(body).toContain('### Changed (1)')
    expect(body).toMatch(new RegExp(`- \`${changed}\`: was zero retention: \\w+, .*; now zero retention: \\w+, `))
    expect(body).toContain('trains on data:')
    expect(body).toContain('region-gated:')
    expect(body).toContain('agreement expiry:')
  })

  it('renders "None." for a section with no entries', async () => {
    const current = tableAt(OLD_SHA)
    const [changed] = Object.keys(current.models)
    if (changed === undefined) throw new Error('fixture has no models')
    const h = harness({
      ...current,
      models: {...current.models, [changed]: flip(current.models[changed], 'trainsOnData')},
    })

    await run(h)

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Added (0)\n\nNone.')
    expect(body).toContain('### Removed (0)\n\nNone.')
    expect(body).toContain('### Changed (1)')
  })

  it('marks a before-entry that fails the schema as an invalid entry instead of throwing', async () => {
    const current = tableAt(OLD_SHA)
    const [broken] = Object.keys(current.models)
    if (broken === undefined) throw new Error('fixture has no models')
    const h = harness(current)
    const raw = JSON.parse(readFileSync(h.snapshotPath, 'utf8'))
    raw.models[broken] = {zeroRetention: 'maybe'}
    writeFileSync(h.snapshotPath, `${JSON.stringify(raw, null, 2)}\n`)

    await run(h)

    expect(readFileSync(h.bodyPath, 'utf8')).toContain(`- \`${broken}\`: was invalid entry; now zero retention:`)
  })

  it('omits the body when no bodyPath is given', async () => {
    const {snapshot} = staleSnapshot()
    const h = harness(snapshot)

    const result = await refreshGoPrivacy({snapshotPath: h.snapshotPath, fetch: h.fetch})

    expect(result.changed).toBe(true)
    expect(existsSync(h.bodyPath)).toBe(false)
  })

  it('fetches go.mdx at exactly the resolved SHA, and sends no credentials when no token is set', async () => {
    const {snapshot} = staleSnapshot()
    const h = harness(snapshot)

    await run(h)

    expect(h.calls.map(call => call.url)).toEqual([COMMIT_API_URL, goMdxUrl(NEW_SHA)])
    expect(goMdxUrl(NEW_SHA)).toBe(
      `https://raw.githubusercontent.com/anomalyco/opencode/${NEW_SHA}/services/www/src/docs/content/console/go.mdx`,
    )
    for (const {init} of h.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(JSON.stringify(init?.headers ?? {}).toLowerCase()).not.toContain('authorization')
    }
  })

  it('sends GITHUB_TOKEN as a bearer on the API lookup only, never to raw.githubusercontent.com', async () => {
    const token = 'ghs_test-sentinel-token'
    const h = harness(staleSnapshot().snapshot)

    await refreshGoPrivacy({snapshotPath: h.snapshotPath, bodyPath: h.bodyPath, fetch: h.fetch, githubToken: token})

    const [api, raw] = h.calls
    expect(api?.url).toBe(COMMIT_API_URL)
    expect(raw?.url).toBe(goMdxUrl(NEW_SHA))
    expect(api?.init?.headers).toMatchObject({Authorization: `Bearer ${token}`})
    expect(JSON.stringify(raw?.init ?? {})).not.toContain(token)
    expect(JSON.stringify(raw?.init?.headers ?? {}).toLowerCase()).not.toContain('authorization')
  })

  it('treats an empty token as unset', async () => {
    const h = harness(staleSnapshot().snapshot)

    await refreshGoPrivacy({snapshotPath: h.snapshotPath, fetch: h.fetch, githubToken: ''})

    expect(JSON.stringify(h.calls[0]?.init?.headers ?? {}).toLowerCase()).not.toContain('authorization')
  })

  it('never puts the token in an error message', async () => {
    const token = 'ghs_test-sentinel-token'
    const h = harness(staleSnapshot().snapshot, {
      apiResponse: () => new Response('bad credentials', {status: 401, statusText: 'Unauthorized'}),
    })

    const error = await refreshGoPrivacy({
      snapshotPath: h.snapshotPath,
      fetch: h.fetch,
      githubToken: token,
    }).catch((error_: unknown) => error_)

    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).not.toContain(token)
  })

  it('reports an integration: parser and fixtures are unaffected by a refresh that adds, removes and changes models', async () => {
    const {snapshot} = staleSnapshot()
    const h = harness(snapshot)
    const fixtureBefore = {mdx: readFixture('go.mdx'), expected: readFixture('go.expected.json')}
    const trackedBefore = readFileSync(DEFAULT_SNAPSHOT_PATH, 'utf8')

    await run(h)

    // The refresh wrote a different snapshot, in the temp copy only.
    expect(readFileSync(h.snapshotPath, 'utf8')).not.toBe(serializeSnapshot(snapshot))
    // The Unit 1 fixtures and tracked snapshot stay as they were, and the parser still maps the fixture to them.
    expect(readFixture('go.mdx')).toBe(fixtureBefore.mdx)
    expect(readFixture('go.expected.json')).toBe(fixtureBefore.expected)
    expect(readFileSync(DEFAULT_SNAPSHOT_PATH, 'utf8')).toBe(trackedBefore)
    expect(parsePrivacyTable(MDX, OLD_SHA)).toEqual(JSON.parse(fixtureBefore.expected))
    expect(parseSnapshot(JSON.parse(readFileSync(h.snapshotPath, 'utf8'))).invalid).toEqual([])
  })
})

async function expectUntouched(h: Harness, pattern: RegExp | typeof PrivacyTableError): Promise<void> {
  const before = readFileSync(h.snapshotPath, 'utf8')
  await expect(run(h)).rejects.toThrow(pattern)
  expect(readFileSync(h.snapshotPath, 'utf8')).toBe(before)
  expect(existsSync(h.bodyPath)).toBe(false)
  expect(leftovers(h.dir)).toEqual([])
}

describe('refreshGoPrivacy: failures leave the snapshot untouched', () => {
  it('rejects when the commit API answers non-2xx', async () => {
    const h = harness(staleSnapshot().snapshot, {
      apiResponse: () => new Response('rate limited', {status: 403, statusText: 'Forbidden'}),
    })
    await expectUntouched(h, /commits\/dev failed: 403 Forbidden/)
    expect(h.calls).toHaveLength(1)
  })

  it('rejects when the commit API body is not JSON', async () => {
    const h = harness(staleSnapshot().snapshot, {apiResponse: () => new Response('<html>')})
    await expectUntouched(h, /not JSON/)
    expect(h.calls).toHaveLength(1)
  })

  it('rejects when the raw fetch answers non-2xx', async () => {
    const h = harness(staleSnapshot().snapshot, {
      rawResponse: () => new Response('nope', {status: 404, statusText: 'Not Found'}),
    })
    await expectUntouched(h, /failed: 404 Not Found/)
  })

  it('rejects when the raw fetch itself throws', async () => {
    const h = harness(staleSnapshot().snapshot)
    const failing: FetchLike = url =>
      url === COMMIT_API_URL
        ? Promise.resolve(Response.json({sha: NEW_SHA}))
        : Promise.reject(new Error('socket hang up'))
    const before = readFileSync(h.snapshotPath, 'utf8')

    await expect(
      refreshGoPrivacy({snapshotPath: h.snapshotPath, bodyPath: h.bodyPath, fetch: failing}),
    ).rejects.toThrow('socket hang up')
    expect(readFileSync(h.snapshotPath, 'utf8')).toBe(before)
  })

  it('rejects an empty body', async () => {
    const h = harness(staleSnapshot().snapshot, {mdx: '  \n'})
    await expectUntouched(h, /empty body/)
  })

  it('fails closed with PrivacyTableError when the table no longer parses', async () => {
    const h = harness(staleSnapshot().snapshot, {mdx: MDX.replace('| Not used       |', '| Maybe          |')})
    await expectUntouched(h, PrivacyTableError)
  })

  it('fails closed on a page with no rows at all', async () => {
    const h = harness(staleSnapshot().snapshot, {mdx: '# Go\n\nNothing here.\n'})
    await expectUntouched(h, PrivacyTableError)
  })

  it('rejects an unreadable current snapshot before any request', async () => {
    const h = harness(tableAt(OLD_SHA))
    writeFileSync(h.snapshotPath, '{ nope')
    await expect(run(h)).rejects.toThrow(/cannot read the current snapshot/)
    expect(h.calls).toHaveLength(0)
  })

  it('rejects a current snapshot whose envelope is malformed', async () => {
    const h = harness(tableAt(OLD_SHA))
    writeFileSync(h.snapshotPath, JSON.stringify({schemaVersion: 2, models: {}}))
    await expect(run(h)).rejects.toThrow(/invalid shape/)
    expect(h.calls).toHaveLength(0)
  })

  const BAD_SHAS: readonly (readonly [string, string])[] = [
    ['not hex', 'z'.repeat(40)],
    ['uppercase', 'A'.repeat(40)],
    ['too short', 'a'.repeat(39)],
    ['too long', 'a'.repeat(41)],
    ['a ref name', 'dev'],
    ['a path traversal', `${'a'.repeat(30)}/../../x`],
    ['a trailing newline', `${'a'.repeat(40)}\n`],
    ['empty', ''],
  ]
  for (const [label, sha] of BAD_SHAS) {
    it(`rejects a SHA that is ${label} before the raw fetch`, async () => {
      const h = harness(staleSnapshot().snapshot, {sha})
      await expectUntouched(h, /did not return a 40-hex commit SHA/)
      expect(h.calls.map(call => call.url)).toEqual([COMMIT_API_URL])
    })
  }

  it('rejects a SHA that is not a string', async () => {
    const h = harness(staleSnapshot().snapshot, {apiResponse: () => Response.json({sha: 12345})})
    await expectUntouched(h, /did not return a 40-hex commit SHA/)
    expect(h.calls).toHaveLength(1)
  })
})

describe('diffSnapshots', () => {
  const entry = {zeroRetention: true, trainsOnData: false, regionGated: false, agreementExpiry: null}

  it('classifies added, removed and changed ids, sorted', () => {
    const diff = diffSnapshots(
      {b: entry, a: entry, keep: entry, gone: entry},
      {
        z: entry,
        y: entry,
        keep: entry,
        a: {...entry, zeroRetention: false},
        b: {...entry, agreementExpiry: '2026-12-01'},
      },
    )
    expect(diff).toEqual({added: ['y', 'z'], removed: ['gone'], changed: ['a', 'b']})
  })

  it('ignores key order inside an entry', () => {
    const reordered = {agreementExpiry: null, regionGated: false, trainsOnData: false, zeroRetention: true}
    expect(diffSnapshots({m: entry}, {m: reordered})).toEqual({added: [], removed: [], changed: []})
  })
})
