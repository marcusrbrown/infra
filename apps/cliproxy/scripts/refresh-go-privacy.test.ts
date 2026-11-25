import type {ModelEntry, PrivacySnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {buildSnapshot} from '@marcusrbrown/infra-shared/opencode-go/build-snapshot'
import {parseSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {GO_LIVE_MODELS_URL, LiveModelsError, parseLiveModels} from '@marcusrbrown/infra-shared/opencode-go/live-models'
import {parsePrivacyDocs, PrivacyTableError} from '@marcusrbrown/infra-shared/opencode-go/parse-privacy-table'
import {afterEach, describe, expect, it} from 'bun:test'
import {
  changesetFileName,
  COMMIT_API_URL,
  DEFAULT_SNAPSHOT_PATH,
  diffSnapshots,
  goMdxUrl,
  refreshGoPrivacy,
  renderChangeset,
  runIdentityFromEnv,
  serializeSnapshot,
  workflowOutputs,
  type FetchLike,
} from './refresh-go-privacy'

const FIXTURES = new URL('../../../packages/shared/opencode-go/__fixtures__/', import.meta.url)
const readFixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8')

const MDX = readFixture('go.mdx')
const LIVE_JSON = readFixture('live-models.json')
const OLD_SHA = '011f9043e8a90dc9a1ac42fb1181486dd4d13b71'
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

/** The snapshot the fixture page and API response build to, stamped with `commit`. */
const tableAt = (commit: string): PrivacySnapshot =>
  buildSnapshot(parsePrivacyDocs(MDX), parseLiveModels(JSON.parse(LIVE_JSON)).models, commit).snapshot

/** The recorded live response with one model's entry changed by `change`. */
function liveWith(id: string, change: (entry: Record<string, unknown>) => void): string {
  const body = JSON.parse(LIVE_JSON) as {data: Record<string, unknown>[]}
  const entry = body.data.find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error(`fixture has no ${id}`)
  change(entry)
  return JSON.stringify(body)
}

interface Harness {
  readonly dir: string
  readonly snapshotPath: string
  readonly bodyPath: string
  readonly calls: {url: string; init: RequestInit | undefined}[]
  readonly fetch: FetchLike
}

/**
 * A temp snapshot plus a fake fetch. The commit API answers with `sha`, the raw URL with `mdx` and the Go models
 * endpoint with `live`. Nothing touches the network or the tracked snapshot.
 */
function harness(
  snapshot: PrivacySnapshot,
  options: {
    sha?: string
    mdx?: string
    live?: string
    apiResponse?: () => Response
    rawResponse?: () => Response
    liveResponse?: () => Response
  } = {},
): Harness {
  const dir = tempDir()
  const snapshotPath = join(dir, 'privacy-snapshot.json')
  writeFileSync(snapshotPath, serializeSnapshot(snapshot))
  const calls: Harness['calls'] = []
  const sha = options.sha ?? NEW_SHA
  const fetch: FetchLike = (url, init) => {
    calls.push({url, init})
    if (url === COMMIT_API_URL) return Promise.resolve(options.apiResponse?.() ?? Response.json({sha}))
    if (url === GO_LIVE_MODELS_URL) {
      return Promise.resolve(options.liveResponse?.() ?? new Response(options.live ?? LIVE_JSON))
    }
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
    const {snapshot, changed} = staleSnapshot()
    const h = harness(snapshot)

    const result = await run(h)

    // The one restriction: the stale snapshot wrongly clears `changed`; the refresh puts its zero-retention flag right.
    expect(snapshot.models[changed]?.zeroRetention).toBe(true)
    expect(tableAt(NEW_SHA).models[changed]?.zeroRetention).toBe(false)
    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA, restricted: 1})
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

    expect(h.calls.map(call => call.url)).toEqual([COMMIT_API_URL, goMdxUrl(NEW_SHA), GO_LIVE_MODELS_URL])
    expect(goMdxUrl(NEW_SHA)).toBe(
      `https://raw.githubusercontent.com/anomalyco/opencode/${NEW_SHA}/services/site/src/docs/content/console/go.mdx`,
    )
    for (const {init} of h.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(JSON.stringify(init?.headers ?? {}).toLowerCase()).not.toContain('authorization')
    }
  })

  it('sends GITHUB_TOKEN as a bearer on the API lookup only, never to raw.githubusercontent.com or opencode.ai', async () => {
    const token = 'ghs_test-sentinel-token'
    const h = harness(staleSnapshot().snapshot)

    await refreshGoPrivacy({snapshotPath: h.snapshotPath, bodyPath: h.bodyPath, fetch: h.fetch, githubToken: token})

    const [api, raw, liveCall] = h.calls
    expect(api?.url).toBe(COMMIT_API_URL)
    expect(raw?.url).toBe(goMdxUrl(NEW_SHA))
    expect(liveCall?.url).toBe(GO_LIVE_MODELS_URL)
    expect(api?.init?.headers).toMatchObject({Authorization: `Bearer ${token}`})
    for (const call of [raw, liveCall]) {
      expect(JSON.stringify(call?.init ?? {})).not.toContain(token)
      expect(JSON.stringify(call?.init?.headers ?? {}).toLowerCase()).not.toContain('authorization')
    }
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
    expect(tableAt(OLD_SHA)).toEqual(JSON.parse(fixtureBefore.expected))
    expect(parseSnapshot(JSON.parse(readFileSync(h.snapshotPath, 'utf8'))).invalid).toEqual([])
  })
})

describe('refreshGoPrivacy: the release changeset', () => {
  const NEWER_SHA = 'b'.repeat(40)
  const NAME_SHAPE = /^opencode-go-privacy-[0-9a-f]{7}-\d{1,20}-\d{1,4}\.md$/
  /** `readdirSync` order is not specified, so every listing is sorted before it is compared. */
  const listing = (dir: string): string[] => readdirSync(dir).sort()
  const changesetsIn = (dir: string): string[] => listing(dir).filter(name => name.endsWith('.md'))
  const runAt = (n: number, attempt = '1') => ({runId: String(n), runAttempt: attempt})
  const withChangeset = (h: Harness, dir: string, run = runAt(1001)) =>
    refreshGoPrivacy({
      snapshotPath: h.snapshotPath,
      bodyPath: h.bodyPath,
      changeset: {dir, ...run},
      fetch: h.fetch,
    })
  /** The live list with `glm-5.3` region-restricted: a different snapshot at the same docs commit. */
  const restrictedLive = () =>
    liveWith('glm-5.3', entry => {
      ;(entry.go as Record<string, unknown>).limited_regions = true
    })
  const snapshotOf = (h: Harness): PrivacySnapshot => JSON.parse(readFileSync(h.snapshotPath, 'utf8'))

  it('writes exactly one patch changeset for @marcusrbrown/infra, named after the commit and the run, when the snapshot changed', async () => {
    const h = harness(staleSnapshot().snapshot)
    const dir = tempDir()

    const result = await withChangeset(h, dir)

    expect(result).toEqual({
      changed: true,
      sourceCommit: NEW_SHA,
      restricted: 1,
      changesetFile: 'opencode-go-privacy-aaaaaaa-1001-1.md',
    })
    expect(listing(dir)).toEqual(['opencode-go-privacy-aaaaaaa-1001-1.md'])
    expect(readFileSync(join(dir, 'opencode-go-privacy-aaaaaaa-1001-1.md'), 'utf8')).toBe(
      "---\n'@marcusrbrown/infra': patch\n---\n\nRefresh the bundled OpenCode Go privacy snapshot to upstream commit `aaaaaaa` of `anomalyco/opencode`.\n",
    )
    expect(leftovers(dir)).toEqual([])
  })

  it('the front matter has exactly one release line, naming one package with a patch bump', async () => {
    const h = harness(staleSnapshot().snapshot)
    const dir = tempDir()

    await withChangeset(h, dir)

    const text = readFileSync(join(dir, changesetsIn(dir)[0] ?? ''), 'utf8')
    const match = /^---\n((?:[^\n]*\n)*?)---\n\n([^\n]+)\n$/.exec(text)
    expect(match).not.toBeNull()
    expect((match?.[1] ?? '').trimEnd().split('\n')).toEqual(["'@marcusrbrown/infra': patch"])
    expect(match?.[2]).toMatch(/^Refresh the bundled OpenCode Go privacy snapshot/)
  })

  it('writes no changeset when the snapshot is unchanged, even though the dev commit moved', async () => {
    const h = harness(tableAt(OLD_SHA))
    const dir = tempDir()

    const result = await withChangeset(h, dir)

    expect(result).toEqual({changed: false, sourceCommit: NEW_SHA})
    expect(listing(dir)).toEqual([])
  })

  it('writes no changeset unless a target is given', async () => {
    const h = harness(staleSnapshot().snapshot)

    const result = await run(h)

    expect(result.changed).toBe(true)
    expect(result.changesetFile).toBeUndefined()
    expect(listing(h.dir)).toEqual(['pr-body.md', 'privacy-snapshot.json'])
  })

  it('names the file after the run, so identical inputs under different run identities get different files', async () => {
    const dir = tempDir()

    const first = await withChangeset(harness(staleSnapshot().snapshot), dir, runAt(1001, '1'))
    const rerun = await withChangeset(harness(staleSnapshot().snapshot), dir, runAt(1001, '2'))
    const later = await withChangeset(harness(staleSnapshot().snapshot), dir, runAt(1002, '1'))

    expect([first.changesetFile, rerun.changesetFile, later.changesetFile]).toEqual([
      'opencode-go-privacy-aaaaaaa-1001-1.md',
      'opencode-go-privacy-aaaaaaa-1001-2.md',
      'opencode-go-privacy-aaaaaaa-1002-1.md',
    ])
    expect(changesetsIn(dir)).toHaveLength(3)
  })

  it('a refresh for a newer upstream commit adds its own file and leaves an earlier pending one alone', async () => {
    const dir = tempDir()

    const first = await withChangeset(harness(staleSnapshot().snapshot, {sha: NEW_SHA}), dir, runAt(1001))
    const before = readFileSync(join(dir, first.changesetFile ?? ''), 'utf8')
    const second = await withChangeset(harness(staleSnapshot().snapshot, {sha: NEWER_SHA}), dir, runAt(1002))

    expect(first.changesetFile).toBe('opencode-go-privacy-aaaaaaa-1001-1.md')
    expect(second.changesetFile).toBe('opencode-go-privacy-bbbbbbb-1002-1.md')
    expect(changesetsIn(dir)).toEqual([first.changesetFile ?? '', second.changesetFile ?? ''])
    expect(readFileSync(join(dir, first.changesetFile ?? ''), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, second.changesetFile ?? ''), 'utf8')).toContain('`bbbbbbb`')
  })

  it('at one docs commit the snapshot goes A, then B, then A again: every run adds a new file and earlier ones stay byte-identical', async () => {
    const dir = tempDir()
    const read = (name: string) => readFileSync(join(dir, name), 'utf8')

    // Run 1 proposes A: the stale snapshot refreshed against the recorded live list.
    const h1 = harness(staleSnapshot().snapshot)
    const r1 = await withChangeset(h1, dir, runAt(2001))
    const name1 = r1.changesetFile ?? ''
    const text1 = read(name1)

    // Run 2 starts from A (merged) with the first changeset still pending, and proposes B: the live list now restricts
    // one more model at the same docs commit.
    const h2 = harness(snapshotOf(h1), {live: restrictedLive()})
    const r2 = await withChangeset(h2, dir, runAt(2002))
    const name2 = r2.changesetFile ?? ''
    const text2 = read(name2)

    // Run 3 starts from B with both earlier changesets pending, and proposes A again: byte-for-byte the snapshot
    // run 1 proposed.
    const h3 = harness(snapshotOf(h2))
    const r3 = await withChangeset(h3, dir, runAt(2003))
    const name3 = r3.changesetFile ?? ''

    expect(readFileSync(h3.snapshotPath, 'utf8')).toBe(readFileSync(h1.snapshotPath, 'utf8'))
    expect([r1, r2, r3].map(result => result.sourceCommit)).toEqual([NEW_SHA, NEW_SHA, NEW_SHA])
    expect(new Set([name1, name2, name3]).size).toBe(3)
    expect(changesetsIn(dir)).toEqual([name1, name2, name3])
    expect(read(name1)).toBe(text1)
    expect(read(name2)).toBe(text2)
    // Run 3 relaxes glm-5.3 again, which restricts nothing.
    expect(workflowOutputs(r3)).toBe(`changed=true\nchangeset=${name3}\nrestricted=0\n`)
  })

  describe('a run identity that could reach a path wrongly is refused before anything is written or fetched', () => {
    const badIds = ['', 'abc', '12a', '../1', '1/2', '1 2', ' 1', '1\n', '1\n2', '-1', '1.0', '9'.repeat(21)]
    const badAttempts = ['', 'x', '1.0', '-1', '../1', '1/1', '12345', '1\n']

    for (const [field, values] of [
      ['runId', badIds],
      ['runAttempt', badAttempts],
    ] as const) {
      for (const bad of values) {
        it(`${field} ${JSON.stringify(bad)}`, async () => {
          const h = harness(staleSnapshot().snapshot)
          const dir = tempDir()
          const before = readFileSync(h.snapshotPath, 'utf8')

          await expect(withChangeset(h, dir, {...runAt(1001), [field]: bad})).rejects.toThrow(/run identity/)

          expect(h.calls).toEqual([])
          expect(listing(dir)).toEqual([])
          expect(existsSync(h.bodyPath)).toBe(false)
          expect(readFileSync(h.snapshotPath, 'utf8')).toBe(before)
        })
      }
    }
  })

  it('writes nothing when the refresh fails before the compare', async () => {
    const h = harness(staleSnapshot().snapshot, {liveResponse: () => new Response('nope', {status: 503})})
    const dir = tempDir()

    await expect(withChangeset(h, dir)).rejects.toThrow()

    expect(listing(dir)).toEqual([])
  })

  it('leaves the snapshot untouched when the changeset cannot be written', async () => {
    const h = harness(staleSnapshot().snapshot)
    const before = readFileSync(h.snapshotPath, 'utf8')
    const notADirectory = join(h.dir, 'blocker')
    writeFileSync(notADirectory, '')

    await expect(withChangeset(h, notADirectory)).rejects.toThrow()

    expect(readFileSync(h.snapshotPath, 'utf8')).toBe(before)
  })

  it('builds the file name from the commit and the run identity alone, and refuses a bad commit', () => {
    const name = changesetFileName(NEW_SHA, runAt(123456789, '2'))
    expect(name).toBe('opencode-go-privacy-aaaaaaa-123456789-2.md')
    expect(name).toMatch(NAME_SHAPE)
    expect(() => changesetFileName('../../etc/passwd', runAt(1))).toThrow()
    expect(() => changesetFileName('A'.repeat(40), runAt(1))).toThrow()
    expect(() => renderChangeset('abc')).toThrow()
  })

  it('takes the run identity from the CI environment, and falls back to a UTC timestamp to the second off CI', () => {
    expect(runIdentityFromEnv({GITHUB_RUN_ID: '44608849873', GITHUB_RUN_ATTEMPT: '2'}, new Date())).toEqual({
      runId: '44608849873',
      runAttempt: '2',
    })
    // Off CI: digits only, so it passes the same pattern as a run id, and 14 digits cannot equal a real run id.
    expect(runIdentityFromEnv({}, new Date('2026-11-19T22:02:24.999Z'))).toEqual({
      runId: '20261119220224',
      runAttempt: '1',
    })
    expect(runIdentityFromEnv({GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: ''}, new Date('2026-01-02T03:04:05Z'))).toEqual({
      runId: '20260102030405',
      runAttempt: '1',
    })
    // A half-set CI environment is a mistake, not a local run.
    expect(() => runIdentityFromEnv({GITHUB_RUN_ID: '1'}, new Date())).toThrow(/run identity/)
    expect(() => runIdentityFromEnv({GITHUB_RUN_ATTEMPT: '1'}, new Date())).toThrow(/run identity/)
  })

  it('reports the changeset to the workflow as a bare file name, and only when one was written', () => {
    const name = changesetFileName(NEW_SHA, runAt(1))
    expect(workflowOutputs({changed: false, sourceCommit: NEW_SHA})).toBe('changed=false\n')
    expect(workflowOutputs({changed: true, sourceCommit: NEW_SHA, restricted: 0})).toBe('changed=true\nrestricted=0\n')
    expect(workflowOutputs({changed: true, sourceCommit: NEW_SHA, restricted: 0, changesetFile: name})).toBe(
      `changed=true\nchangeset=${name}\nrestricted=0\n`,
    )
  })
})

describe('refreshGoPrivacy: the PR body reports where the sources differ', () => {
  it('lists an API-only restriction in its own section, with both values and the snapshot value', async () => {
    const live = liveWith('glm-5.3', entry => {
      ;(entry.go as Record<string, unknown>).limited_regions = true
    })
    const h = harness(staleSnapshot().snapshot, {live})

    await run(h)

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Sources disagree (0)\n\nNone.')
    expect(body).toContain('### API-only restrictions (1)')
    expect(body).toContain(
      '- `glm-5.3` (`GLM-5.3`), region-gated: API limited_regions: true; docs: no availability statement; snapshot: yes',
    )
  })

  it('on today’s inputs both report sections are empty, because the page and the API agree on Beam Free', async () => {
    const h = harness(staleSnapshot().snapshot)

    await run(h)

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Sources disagree (0)\n\nNone.')
    expect(body).toContain('### API-only restrictions (0)\n\nNone.')
    expect(body).toContain('### Left out of the snapshot (0)\n\nNone.')
  })

  it('Beam Free stays region-gated when only the API drops its limit, and the PR body says so', async () => {
    const live = liveWith('beam-free', entry => {
      ;(entry.go as Record<string, unknown>).limited_regions = false
    })
    const h = harness(staleSnapshot().snapshot, {live})

    await run(h)

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(JSON.parse(readFileSync(h.snapshotPath, 'utf8')).models['beam-free'].regionGated).toBe(true)
    expect(body).toContain('### Sources disagree (1)')
    expect(body).toContain(
      '- `beam-free` (`Beam Free`), region-gated: API limited_regions: false; docs: availability limited to permitted regions; snapshot: yes',
    )
  })

  it('lists a retention conflict under "Sources disagree" and keeps the restrictive value', async () => {
    const live = liveWith('glm-5.3', entry => {
      ;(entry.go as Record<string, unknown>).zdr = false
    })
    const h = harness(staleSnapshot().snapshot, {live})

    await run(h)

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Sources disagree (1)')
    expect(body).toContain('- `glm-5.3` (`GLM-5.3`), zero retention: API zdr: false; docs: 0 days; snapshot: no')
    expect(JSON.parse(readFileSync(h.snapshotPath, 'utf8')).models['glm-5.3'].zeroRetention).toBe(false)
  })

  it('renders upstream names as one bounded plain line in the disagreement and left-out sections', async () => {
    const nasty = '# GLM `5.3`'
    const live = JSON.parse(LIVE_JSON) as {data: Record<string, unknown>[]}
    const target = live.data.find(entry => entry.id === 'glm-5.3')
    if (target === undefined) throw new Error('fixture has no glm-5.3')
    target.name = nasty
    ;(target.go as Record<string, unknown>).zdr = false
    live.data.push({...live.data[0], id: 'brand-new', name: '# New\n- Model |x| <b>'})
    const mdx = MDX.replace('| GLM-5.3                    | 0 days         |', `| ${nasty} | 0 days |`)
    expect(mdx).not.toBe(MDX)
    const h = harness(staleSnapshot().snapshot, {mdx, live: JSON.stringify(live)})
    const lines: string[] = []

    await refreshGoPrivacy({
      snapshotPath: h.snapshotPath,
      bodyPath: h.bodyPath,
      fetch: h.fetch,
      log: line => lines.push(line),
    })

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('- `glm-5.3` (`# GLM 5.3`), zero retention: API zdr: false; docs: 0 days; snapshot: no')
    expect(body).toContain('- live model `brand-new` named `# New - Model |x| <b>`: no Privacy row on the page')
    expect(lines).toEqual([
      'left out: live model `brand-new` named `# New - Model |x| <b>`: no Privacy row on the page',
    ])
    // The hostile names add no lines of their own: the report is one line per entry.
    expect(body.split('\n').filter(line => line.includes('New') || line.includes('# GLM'))).toHaveLength(2)
  })

  it('does not report the docs-only Global rule', async () => {
    const h = harness(staleSnapshot().snapshot)
    await run(h)
    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).not.toContain('deepseek')
    expect(body).not.toContain('longcat')
  })

  it('names the live endpoint it read, so the reviewer can reproduce the input', async () => {
    const h = harness(staleSnapshot().snapshot)
    await run(h)
    expect(readFileSync(h.bodyPath, 'utf8')).toContain(GO_LIVE_MODELS_URL)
  })
})

describe('refreshGoPrivacy: a live model with no privacy fields is left out and reported', () => {
  const NO_PRIVACY_LINE =
    'live model `glm-5.3` named `GLM-5.3`: upstream published no privacy fields (`go`) for it, so it has no entry'
  const withoutGo = (...ids: string[]): string => {
    const body = JSON.parse(LIVE_JSON) as {data: Record<string, unknown>[]}
    for (const entry of body.data) if (ids.includes(String(entry.id))) delete entry.go
    return JSON.stringify(body)
  }
  const runLogged = (h: Harness) => {
    const lines: string[] = []
    return {
      lines,
      done: refreshGoPrivacy({
        snapshotPath: h.snapshotPath,
        bodyPath: h.bodyPath,
        fetch: h.fetch,
        log: line => lines.push(line),
      }),
    }
  }

  it('succeeds with one model without go: no entry for it, and the body and the log report it in their own words', async () => {
    const h = harness(staleSnapshot().snapshot, {live: withoutGo('glm-5.3')})
    const {lines, done} = runLogged(h)

    await done

    const written = JSON.parse(readFileSync(h.snapshotPath, 'utf8')) as PrivacySnapshot
    expect(written.models['glm-5.3']).toBeUndefined()
    expect(Object.keys(written.models)).toHaveLength(30)
    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Left out of the snapshot (1)')
    expect(body).toContain(`- ${NO_PRIVACY_LINE}`)
    expect(lines).toEqual([`left out: ${NO_PRIVACY_LINE}`])
  })

  it('does not report its Privacy row as a row with no live model', async () => {
    const h = harness(staleSnapshot().snapshot, {live: withoutGo('glm-5.3')})
    await run(h)
    expect(readFileSync(h.bodyPath, 'utf8')).not.toContain('Privacy row `GLM-5.3`')
  })

  it('a model that is in the committed snapshot drops out, and that alone opens a PR with the removal', async () => {
    const committed = tableAt(OLD_SHA)
    expect(committed.models['glm-5.3']).toBeDefined()
    const h = harness(committed, {live: withoutGo('glm-5.3')})

    const result = await run(h)

    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA, restricted: 1})
    expect(JSON.parse(readFileSync(h.snapshotPath, 'utf8')).models['glm-5.3']).toBeUndefined()
    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Removed (1)')
    expect(body).toContain('- `glm-5.3`: was zero retention: yes')
    expect(body).toContain(`- ${NO_PRIVACY_LINE}`)
  })

  it('leads the PR body with a loud line when an exposed model drops out for want of privacy fields', async () => {
    const h = harness(tableAt(OLD_SHA), {live: withoutGo('glm-5.3')})
    await run(h)
    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body.indexOf('upstream published no privacy fields')).toBeGreaterThan(-1)
    const lead = body.split('\n').find(line => line.startsWith('**Warning'))
    expect(lead).toContain('`glm-5.3`')
    expect(body.indexOf(lead ?? '')).toBeLessThan(body.indexOf('### Added'))
  })

  describe('the warning line is true: it names only models the previous snapshot made eligible', () => {
    const TODAY = new Date('2026-11-19T00:00:00Z')
    const runOn = (h: Harness, now = TODAY) =>
      refreshGoPrivacy({snapshotPath: h.snapshotPath, bodyPath: h.bodyPath, fetch: h.fetch, now: () => now})
    const warningOf = (body: string): string | undefined => body.split('\n').find(line => line.startsWith('**Warning'))

    it('an eligible model that loses go gets the warning, and it says why the model was exposed', async () => {
      const h = harness(tableAt(OLD_SHA), {live: withoutGo('glm-5.3')})
      await runOn(h)
      const warning = warningOf(readFileSync(h.bodyPath, 'utf8'))
      expect(warning).toContain('`glm-5.3`')
      expect(warning).toContain('eligible under the previous snapshot')
      expect(warning).not.toContain('currently exposes')
    })

    it.each([
      ['not zero retention', 'beam-free'],
      ['region-gated', 'longcat-2.5-free'],
      ['not zero retention (55 days)', 'gemini-4-argon'],
      ['trains on data', 'iceman-contributor-free'],
    ])(
      'a listed model that was already ineligible (%s) gets no warning, but is still removed and reported',
      async (_why, id) => {
        const committed = tableAt(OLD_SHA)
        expect(committed.models[id]).toBeDefined()
        const h = harness(committed, {live: withoutGo(id)})

        const result = await runOn(h)

        expect(result.changed).toBe(true)
        const body = readFileSync(h.bodyPath, 'utf8')
        expect(warningOf(body)).toBeUndefined()
        expect(body).toContain('### Removed (1)')
        expect(body).toContain(`- \`${id}\`: was `)
        expect(body).toContain('upstream published no privacy fields')
        expect(JSON.parse(readFileSync(h.snapshotPath, 'utf8')).models[id]).toBeUndefined()
      },
    )

    it('a model whose agreement had expired is ineligible under the previous snapshot, so no warning', async () => {
      const committed = tableAt(OLD_SHA)
      const glm = committed.models['glm-5.3']
      if (glm === undefined) throw new Error('fixture has no glm-5.3')
      const h = harness(
        {...committed, models: {...committed.models, 'glm-5.3': {...glm, agreementExpiry: '2026-11-01'}}},
        {live: withoutGo('glm-5.3')},
      )
      await runOn(h)
      expect(warningOf(readFileSync(h.bodyPath, 'utf8'))).toBeUndefined()
    })

    it('with an eligible and an ineligible model both losing go, the warning names only the eligible one and counts it', async () => {
      const h = harness(tableAt(OLD_SHA), {live: withoutGo('glm-5.3', 'beam-free')})
      await runOn(h)
      const warning = warningOf(readFileSync(h.bodyPath, 'utf8'))
      expect(warning).toContain('`glm-5.3`')
      expect(warning).not.toContain('beam-free')
      expect(warning).toContain('1 model(s)')
    })

    it('a model that is eligible only because the live list says so: a model missing from the live list is not eligible', async () => {
      // `glm-5.3` is in the snapshot, but upstream no longer lists it at all: it is not "dropped for want of go".
      const body = JSON.parse(LIVE_JSON) as {data: {id: string}[]}
      body.data = body.data.filter(entry => entry.id !== 'glm-5.3')
      const h = harness(tableAt(OLD_SHA), {live: JSON.stringify(body)})
      await runOn(h)
      expect(warningOf(readFileSync(h.bodyPath, 'utf8'))).toBeUndefined()
    })
  })

  it('a model without go and a restriction on another model arrive together: both land in one changed snapshot', async () => {
    const committed = tableAt(OLD_SHA)
    expect(committed.models['kimi-k3']).toMatchObject({zeroRetention: true, regionGated: false})
    const body = JSON.parse(withoutGo('glm-5.3')) as {data: Record<string, unknown>[]}
    const kimi = body.data.find(entry => entry.id === 'kimi-k3')
    if (kimi === undefined) throw new Error('fixture has no kimi-k3')
    ;(kimi.go as Record<string, unknown>).zdr = false
    ;(kimi.go as Record<string, unknown>).limited_regions = true
    const h = harness(committed, {live: JSON.stringify(body)})
    const {lines, done} = (() => {
      const captured: string[] = []
      return {
        lines: captured,
        done: refreshGoPrivacy({
          snapshotPath: h.snapshotPath,
          bodyPath: h.bodyPath,
          fetch: h.fetch,
          log: line => captured.push(line),
        }),
      }
    })()

    const result = await done

    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA, restricted: 2})
    const written = JSON.parse(readFileSync(h.snapshotPath, 'utf8')) as PrivacySnapshot
    expect(written.models['glm-5.3']).toBeUndefined()
    expect(written.models['kimi-k3']).toMatchObject({zeroRetention: false, regionGated: true})
    const prBody = readFileSync(h.bodyPath, 'utf8')
    expect(prBody).toContain('### Removed (1)')
    expect(prBody).toContain('- `glm-5.3`: was zero retention: yes')
    expect(prBody).toContain('- `kimi-k3`: was zero retention: yes, trains on data: no, region-gated: no')
    expect(prBody).toContain('now zero retention: no, trains on data: no, region-gated: yes')
    expect(prBody).toContain('### Left out of the snapshot (1)')
    expect(prBody).toContain('upstream published no privacy fields')
    expect(prBody).toContain('- `kimi-k3` (`Kimi K3`), zero retention: API zdr: false; docs: 0 days; snapshot: no')
    expect(lines).toHaveLength(1)
  })

  it('has no warning line when the model was not exposed anyway', async () => {
    const committed = tableAt(OLD_SHA)
    const {'glm-5.3': _dropped, ...rest} = committed.models
    const h = harness({...committed, models: rest}, {live: withoutGo('glm-5.3')})
    const {lines, done} = runLogged(h)
    const result = await done
    expect(result.changed).toBe(false)
    expect(lines).toEqual([`left out: ${NO_PRIVACY_LINE}`])
    expect(existsSync(h.bodyPath)).toBe(false)
  })

  it('throws and leaves the snapshot untouched when more than half of the entries have no go object', async () => {
    const ids = (JSON.parse(LIVE_JSON) as {data: {id: string}[]}).data.slice(0, 16).map(entry => entry.id)
    const h = harness(staleSnapshot().snapshot, {live: withoutGo(...ids)})
    await expectUntouched(h, /more than half/)
  })

  it('throws when no entry has a go object', async () => {
    const ids = (JSON.parse(LIVE_JSON) as {data: {id: string}[]}).data.map(entry => entry.id)
    await expectUntouched(harness(staleSnapshot().snapshot, {live: withoutGo(...ids)}), /no entry has a go object/)
  })

  it('still throws on a go object that is present but malformed', async () => {
    const body = JSON.parse(LIVE_JSON) as {data: Record<string, unknown>[]}
    ;(body.data[0]?.go as Record<string, unknown>).zdr = 'yes'
    await expectUntouched(harness(staleSnapshot().snapshot, {live: JSON.stringify(body)}), LiveModelsError)
  })
})

describe('refreshGoPrivacy: a model one source does not know is left out and reported', () => {
  const addLive = (id: string, name: string): string => {
    const body = JSON.parse(LIVE_JSON) as {data: Record<string, unknown>[]}
    body.data.push({...body.data[0], id, name})
    return JSON.stringify(body)
  }
  const KIMI_BULLET = '- **LongCat 2.5 Free:** select'
  const withKimiGlobal = MDX.replace(
    KIMI_BULLET,
    () => `- **Kimi K3:** select **Global** under **Regions**.\n${KIMI_BULLET}`,
  )
  const runLogged = (h: Harness) => {
    const lines: string[] = []
    return {
      lines,
      done: refreshGoPrivacy({
        snapshotPath: h.snapshotPath,
        bodyPath: h.bodyPath,
        fetch: h.fetch,
        log: line => lines.push(line),
      }),
    }
  }

  it('lists a live model with no Privacy row in the PR body and the log, and writes no entry for it', async () => {
    const h = harness(staleSnapshot().snapshot, {live: addLive('brand-new', 'Brand New')})
    const {lines, done} = runLogged(h)

    await done

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Left out of the snapshot (1)')
    expect(body).toContain('- live model `brand-new` named `Brand New`: no Privacy row on the page')
    expect(lines).toEqual(['left out: live model `brand-new` named `Brand New`: no Privacy row on the page'])
    expect(JSON.parse(readFileSync(h.snapshotPath, 'utf8')).models['brand-new']).toBeUndefined()
  })

  it('lists a Privacy row with no live model, naming the missing side', async () => {
    const live = liveWith('glm-5.3', entry => {
      entry.name = 'Something Else'
    })
    const h = harness(staleSnapshot().snapshot, {live})
    const {lines, done} = runLogged(h)

    await done

    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('- Privacy row `GLM-5.3`: no live model')
    expect(body).toContain('- live model `glm-5.3` named `Something Else`: no Privacy row on the page')
    expect(lines).toHaveLength(2)
  })

  it('prints the report even when nothing changed and no PR opens', async () => {
    const h = harness(tableAt(OLD_SHA), {live: addLive('brand-new', 'Brand New')})
    const {lines, done} = runLogged(h)

    const result = await done

    expect(result).toEqual({changed: false, sourceCommit: NEW_SHA})
    expect(lines).toEqual(['left out: live model `brand-new` named `Brand New`: no Privacy row on the page'])
    expect(existsSync(h.bodyPath)).toBe(false)
  })

  it('prints nothing when every model is matched', async () => {
    const h = harness(staleSnapshot().snapshot)
    const {lines, done} = runLogged(h)
    await done
    expect(lines).toEqual([])
    expect(readFileSync(h.bodyPath, 'utf8')).toContain('### Left out of the snapshot (0)\n\nNone.')
  })

  it('an exposed model that becomes unmatched drops out of the snapshot, and that alone opens a PR with the removal', async () => {
    const committed = tableAt(OLD_SHA)
    expect(committed.models['glm-5.3']).toBeDefined()
    const live = liveWith('glm-5.3', entry => {
      entry.name = 'Something Else'
    })
    const h = harness(committed, {live})

    const result = await run(h)

    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA, restricted: 1})
    expect(JSON.parse(readFileSync(h.snapshotPath, 'utf8')).models['glm-5.3']).toBeUndefined()
    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Removed (1)')
    expect(body).toContain('- `glm-5.3`: was zero retention: yes')
    expect(body).toContain('### Left out of the snapshot (2)')
  })

  it('a new unmatched model plus a new Global restriction on an exposed model: the restriction reaches the snapshot', async () => {
    const committed = tableAt(OLD_SHA)
    expect(committed.models['kimi-k3']?.regionGated).toBe(false)
    const h = harness(committed, {mdx: withKimiGlobal, live: addLive('new-model', 'New Model')})
    const {lines, done} = runLogged(h)

    const result = await done

    expect(result.changed).toBe(true)
    const written = JSON.parse(readFileSync(h.snapshotPath, 'utf8')) as PrivacySnapshot
    expect(written.models['kimi-k3']?.regionGated).toBe(true)
    expect(written.models['new-model']).toBeUndefined()
    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('- `kimi-k3`: was zero retention: yes, trains on data: no, region-gated: no')
    expect(body).toContain('now zero retention: yes, trains on data: no, region-gated: yes')
    expect(body).toContain('- live model `new-model` named `New Model`: no Privacy row on the page')
    expect(lines).toEqual(['left out: live model `new-model` named `New Model`: no Privacy row on the page'])
  })

  it('still throws when the join is ambiguous, and writes nothing', async () => {
    const body = JSON.parse(LIVE_JSON) as {data: Record<string, unknown>[]}
    body.data.push({...body.data[0], id: 'glm-5.3-copy', name: 'GLM 5.3'})
    await expectUntouched(harness(staleSnapshot().snapshot, {live: JSON.stringify(body)}), /same name/)
  })
})

describe('refreshGoPrivacy: a footnote for a live model with no Privacy row', () => {
  const HUNGERG_FOOTNOTE =
    '- **HungerG Free:** Free for a limited time. No data training: your prompts and completions are not used to train models.'
  const REASON = 'footnote only, no Privacy row, so it has no entry'
  const mdxWith = (line: string): string => MDX.replace('- **Grok 4.7:**', () => `${line}\n- **Grok 4.7:**`)
  const addLive = (id: string, name: string): string => {
    const body = JSON.parse(LIVE_JSON) as {data: Record<string, unknown>[]}
    body.data.push({...body.data[0], id, name})
    return JSON.stringify(body)
  }
  const runLogged = (h: Harness) => {
    const lines: string[] = []
    return {
      lines,
      done: refreshGoPrivacy({
        snapshotPath: h.snapshotPath,
        bodyPath: h.bodyPath,
        fetch: h.fetch,
        log: line => lines.push(line),
      }),
    }
  }

  it('leaves the model out, reports it in the PR body and the log, and keeps the rest of the snapshot', async () => {
    const h = harness(staleSnapshot().snapshot, {
      mdx: mdxWith(HUNGERG_FOOTNOTE),
      live: addLive('hungerg-free', 'HungerG Free'),
    })
    const {lines, done} = runLogged(h)

    const result = await done

    expect(result.changed).toBe(true)
    const written = JSON.parse(readFileSync(h.snapshotPath, 'utf8')) as PrivacySnapshot
    expect(written.models['hungerg-free']).toBeUndefined()
    expect(written.models).toEqual(tableAt(NEW_SHA).models)
    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain('### Left out of the snapshot (1)')
    expect(body).toContain(`- live model \`hungerg-free\` named \`HungerG Free\`: ${REASON}`)
    expect(lines).toEqual([`left out: live model \`hungerg-free\` named \`HungerG Free\`: ${REASON}`])
  })

  it('prints the report even when nothing changed and no PR opens', async () => {
    const h = harness(tableAt(OLD_SHA), {
      mdx: mdxWith(HUNGERG_FOOTNOTE),
      live: addLive('hungerg-free', 'HungerG Free'),
    })
    const {lines, done} = runLogged(h)

    expect(await done).toEqual({changed: false, sourceCommit: NEW_SHA})
    expect(lines).toEqual([`left out: live model \`hungerg-free\` named \`HungerG Free\`: ${REASON}`])
    expect(existsSync(h.bodyPath)).toBe(false)
  })

  it('renders an upstream name as one bounded plain line in the PR body and the log', async () => {
    const nasty = '# Hunger `G` |x| [link] <b>'
    const h = harness(staleSnapshot().snapshot, {
      mdx: mdxWith(`- **${nasty}:** Free for a limited time.`),
      live: addLive('hungerg-free', nasty),
    })
    const {lines, done} = runLogged(h)

    await done

    const entry = `- live model \`hungerg-free\` named \`# Hunger G |x| [link] <b>\`: ${REASON}`
    const body = readFileSync(h.bodyPath, 'utf8')
    expect(body).toContain(entry)
    expect(lines).toEqual([`left out: ${entry.slice(2)}`])
    expect(body.split('\n').filter(line => line.includes('Hunger'))).toHaveLength(1)
  })

  it('fails as before, and writes nothing, when the model is not in the live list', async () => {
    await expectUntouched(
      harness(staleSnapshot().snapshot, {mdx: mdxWith(HUNGERG_FOOTNOTE)}),
      /"HungerG Free" does not name a model in the Privacy table/,
    )
  })

  it('fails as before, and writes nothing, for a misspelled label', async () => {
    await expectUntouched(
      harness(staleSnapshot().snapshot, {
        mdx: mdxWith('- **Kimi K3x:** Hosted in China.'),
        live: addLive('hungerg-free', 'HungerG Free'),
      }),
      /"Kimi K3x" does not name a model in the Privacy table/,
    )
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

  it('rejects when the live models endpoint answers non-2xx', async () => {
    const h = harness(staleSnapshot().snapshot, {
      liveResponse: () => new Response('down', {status: 503, statusText: 'Service Unavailable'}),
    })
    await expectUntouched(h, /models failed: 503 Service Unavailable/)
  })

  it('rejects when the live models endpoint fetch itself throws', async () => {
    const h = harness(staleSnapshot().snapshot)
    const failing: FetchLike = url =>
      url === GO_LIVE_MODELS_URL ? Promise.reject(new Error('socket hang up')) : h.fetch(url)
    const before = readFileSync(h.snapshotPath, 'utf8')

    await expect(
      refreshGoPrivacy({snapshotPath: h.snapshotPath, bodyPath: h.bodyPath, fetch: failing}),
    ).rejects.toThrow('socket hang up')
    expect(readFileSync(h.snapshotPath, 'utf8')).toBe(before)
    expect(existsSync(h.bodyPath)).toBe(false)
  })

  it('rejects a live models body that is not JSON', async () => {
    const h = harness(staleSnapshot().snapshot, {live: '<html>'})
    await expectUntouched(h, /not JSON/)
  })

  it('rejects a live models response whose privacy field is not a boolean', async () => {
    const live = liveWith('glm-5.3', entry => {
      ;(entry.go as Record<string, unknown>).zdr = 'true'
    })
    await expectUntouched(harness(staleSnapshot().snapshot, {live}), LiveModelsError)
  })

  it('writes nothing when only the live response is bad, even though the page parses', async () => {
    const h = harness(staleSnapshot().snapshot, {live: JSON.stringify({object: 'list', data: []})})
    await expectUntouched(h, LiveModelsError)
    expect(h.calls.map(call => call.url)).toEqual([COMMIT_API_URL, goMdxUrl(NEW_SHA), GO_LIVE_MODELS_URL])
  })

  it('rejects an empty body', async () => {
    const h = harness(staleSnapshot().snapshot, {mdx: '  \n'})
    await expectUntouched(h, /empty body/)
  })

  it('fails closed with PrivacyTableError when the table no longer parses', async () => {
    const h = harness(staleSnapshot().snapshot, {mdx: MDX.replace('| 0 days         |', '| Maybe          |')})
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

// A refresh that takes away a model the previous snapshot made eligible is time-sensitive: the proxy keeps serving it
// until the PR merges and the gated deploy is approved. The count feeds the alert job.
describe('refreshGoPrivacy: models the PR would restrict', () => {
  const TODAY = new Date('2026-11-19T00:00:00Z')
  const withGo = (id: string, change: (go: Record<string, unknown>) => void): string =>
    liveWith(id, entry => change(entry.go as Record<string, unknown>))
  const withoutGo = (...ids: string[]): string => {
    const body = JSON.parse(LIVE_JSON) as {data: Record<string, unknown>[]}
    for (const entry of body.data) if (ids.includes(String(entry.id))) delete entry.go
    return JSON.stringify(body)
  }
  const restrictedOf = async (h: Harness, now = TODAY) => {
    const result = await refreshGoPrivacy({
      snapshotPath: h.snapshotPath,
      bodyPath: h.bodyPath,
      fetch: h.fetch,
      now: () => now,
    })
    if (!result.changed) throw new Error('expected a changed snapshot')
    return result.restricted
  }

  it.each([
    ['zero retention lost', (go: Record<string, unknown>) => (go.zdr = false)],
    ['training turned on', (go: Record<string, unknown>) => (go.training = true)],
    ['newly region-gated', (go: Record<string, unknown>) => (go.limited_regions = true)],
  ])('counts a model eligible before and not after: %s', async (_why, change) => {
    const committed = tableAt(OLD_SHA)
    expect(committed.models['glm-5.3']).toMatchObject({zeroRetention: true, trainsOnData: false, regionGated: false})
    const h = harness(committed, {live: withGo('glm-5.3', change)})

    expect(await restrictedOf(h)).toBe(1)
  })

  it('counts a model removed while it was exposed, once for each such model', async () => {
    expect(await restrictedOf(harness(tableAt(OLD_SHA), {live: withoutGo('glm-5.3')}))).toBe(1)
    expect(await restrictedOf(harness(tableAt(OLD_SHA), {live: withoutGo('glm-5.3', 'kimi-k3')}))).toBe(2)
  })

  it('does not count a model the previous snapshot already kept out', async () => {
    // beam-free, gemini-4-argon and iceman-contributor-free are not eligible in the committed table.
    for (const id of ['beam-free', 'gemini-4-argon', 'iceman-contributor-free']) {
      const committed = tableAt(OLD_SHA)
      expect(committed.models[id]).toBeDefined()
      expect(await restrictedOf(harness(committed, {live: withoutGo(id)}))).toBe(0)
    }
  })

  it('does not count a relaxation or an addition: only a model that loses exposure counts', async () => {
    const committed = tableAt(OLD_SHA)
    const glm = committed.models['glm-5.3']
    if (glm === undefined) throw new Error('fixture has no glm-5.3')
    // The previous snapshot excluded glm-5.3 and had one extra model; the refresh restores and drops them.
    const previous: PrivacySnapshot = {
      ...committed,
      models: {...committed.models, 'glm-5.3': {...glm, zeroRetention: false}, 'retired-model': glm},
    }
    expect(await restrictedOf(harness(previous))).toBe(0)

    const {'kimi-k3': _dropped, ...rest} = committed.models
    expect(await restrictedOf(harness({...committed, models: rest}))).toBe(0)
  })

  it('does not count a model that was not on the live list, so the proxy was not serving it', async () => {
    const body = JSON.parse(LIVE_JSON) as {data: {id: string}[]}
    body.data = body.data.filter(entry => entry.id !== 'glm-5.3')
    expect(await restrictedOf(harness(tableAt(OLD_SHA), {live: JSON.stringify(body)}))).toBe(0)
  })

  it('does not count a model whose agreement had expired under the previous snapshot', async () => {
    const committed = tableAt(OLD_SHA)
    const glm = committed.models['glm-5.3']
    if (glm === undefined) throw new Error('fixture has no glm-5.3')
    const previous = {...committed, models: {...committed.models, 'glm-5.3': {...glm, agreementExpiry: '2026-11-01'}}}
    expect(await restrictedOf(harness(previous, {live: withoutGo('glm-5.3')}))).toBe(0)
  })

  it('counts a model whose agreement was valid on the run date and the next snapshot drops', async () => {
    const committed = tableAt(OLD_SHA)
    const glm = committed.models['glm-5.3']
    if (glm === undefined) throw new Error('fixture has no glm-5.3')
    const previous = {...committed, models: {...committed.models, 'glm-5.3': {...glm, agreementExpiry: '2026-11-19'}}}
    expect(await restrictedOf(harness(previous, {live: withoutGo('glm-5.3')}))).toBe(1)
  })

  it('is computed without a PR body path, so the count never depends on a side output', async () => {
    const h = harness(tableAt(OLD_SHA), {live: withGo('glm-5.3', go => (go.zdr = false))})
    const result = await refreshGoPrivacy({snapshotPath: h.snapshotPath, fetch: h.fetch, now: () => TODAY})
    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA, restricted: 1})
  })

  it('reports no count when the snapshot did not change', async () => {
    const result = await refreshGoPrivacy({
      snapshotPath: harness(tableAt(OLD_SHA)).snapshotPath,
      fetch: harness(tableAt(OLD_SHA)).fetch,
    })
    expect(result).toEqual({changed: false, sourceCommit: NEW_SHA})
    expect(workflowOutputs(result)).toBe('changed=false\n')
  })

  it('reports the count to the workflow as a bare decimal and nothing else about the models', async () => {
    const h = harness(tableAt(OLD_SHA), {live: withoutGo('glm-5.3', 'kimi-k3')})
    const result = await refreshGoPrivacy({
      snapshotPath: h.snapshotPath,
      fetch: h.fetch,
      now: () => TODAY,
      changeset: {dir: tempDir(), runId: '77', runAttempt: '1'},
    })
    expect(workflowOutputs(result)).toBe('changed=true\nchangeset=opencode-go-privacy-aaaaaaa-77-1.md\nrestricted=2\n')
    expect(workflowOutputs(result)).not.toMatch(/glm|kimi/)
  })
})
