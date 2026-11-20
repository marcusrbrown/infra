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
  const changesetsIn = (dir: string): string[] => readdirSync(dir).filter(name => name.endsWith('.md'))
  const withChangeset = (h: Harness, dir: string) =>
    refreshGoPrivacy({snapshotPath: h.snapshotPath, bodyPath: h.bodyPath, changesetDir: dir, fetch: h.fetch})

  it('writes exactly one patch changeset for @marcusrbrown/infra, named after the source commit, when the snapshot changed', async () => {
    const h = harness(staleSnapshot().snapshot)
    const dir = tempDir()

    const result = await withChangeset(h, dir)

    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA, changesetFile: 'opencode-go-privacy-aaaaaaa.md'})
    expect(readdirSync(dir)).toEqual(['opencode-go-privacy-aaaaaaa.md'])
    expect(readFileSync(join(dir, 'opencode-go-privacy-aaaaaaa.md'), 'utf8')).toBe(
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
    expect(readdirSync(dir)).toEqual([])
  })

  it('writes no changeset unless a directory is given', async () => {
    const h = harness(staleSnapshot().snapshot)

    const result = await run(h)

    expect(result.changed).toBe(true)
    expect(result.changesetFile).toBeUndefined()
    expect(readdirSync(h.dir).sort()).toEqual(['pr-body.md', 'privacy-snapshot.json'])
  })

  it('names the file after the upstream commit alone, so a re-run for the same commit rewrites the same file', async () => {
    const dir = tempDir()

    const first = await withChangeset(harness(staleSnapshot().snapshot), dir)
    const before = readFileSync(join(dir, first.changesetFile ?? ''), 'utf8')
    const second = await withChangeset(harness(staleSnapshot().snapshot), dir)

    expect(second.changesetFile).toBe(first.changesetFile)
    expect(changesetsIn(dir)).toEqual(['opencode-go-privacy-aaaaaaa.md'])
    expect(readFileSync(join(dir, second.changesetFile ?? ''), 'utf8')).toBe(before)
  })

  it('a refresh for a newer upstream commit names a different file and leaves an earlier pending one alone', async () => {
    const dir = tempDir()

    const first = await withChangeset(harness(staleSnapshot().snapshot, {sha: NEW_SHA}), dir)
    const second = await withChangeset(harness(staleSnapshot().snapshot, {sha: NEWER_SHA}), dir)

    expect(first.changesetFile).toBe('opencode-go-privacy-aaaaaaa.md')
    expect(second.changesetFile).toBe('opencode-go-privacy-bbbbbbb.md')
    expect(changesetsIn(dir)).toEqual(['opencode-go-privacy-aaaaaaa.md', 'opencode-go-privacy-bbbbbbb.md'])
    expect(readFileSync(join(dir, 'opencode-go-privacy-bbbbbbb.md'), 'utf8')).toContain('`bbbbbbb`')
  })

  it('writes nothing when the refresh fails before the compare', async () => {
    const h = harness(staleSnapshot().snapshot, {liveResponse: () => new Response('nope', {status: 503})})
    const dir = tempDir()

    await expect(withChangeset(h, dir)).rejects.toThrow()

    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves the snapshot untouched when the changeset cannot be written', async () => {
    const h = harness(staleSnapshot().snapshot)
    const before = readFileSync(h.snapshotPath, 'utf8')
    const notADirectory = join(h.dir, 'blocker')
    writeFileSync(notADirectory, '')

    await expect(withChangeset(h, notADirectory)).rejects.toThrow()

    expect(readFileSync(h.snapshotPath, 'utf8')).toBe(before)
  })

  it('refuses a commit that is not 40 lowercase hex before it reaches a path', () => {
    expect(changesetFileName(NEW_SHA)).toBe('opencode-go-privacy-aaaaaaa.md')
    expect(() => changesetFileName('../../etc/passwd')).toThrow()
    expect(() => changesetFileName('A'.repeat(40))).toThrow()
    expect(() => renderChangeset('abc')).toThrow()
  })

  it('reports the changeset to the workflow as a bare file name, and only when one was written', () => {
    expect(workflowOutputs({changed: false, sourceCommit: NEW_SHA})).toBe('changed=false\n')
    expect(workflowOutputs({changed: true, sourceCommit: NEW_SHA})).toBe('changed=true\n')
    expect(
      workflowOutputs({changed: true, sourceCommit: NEW_SHA, changesetFile: 'opencode-go-privacy-aaaaaaa.md'}),
    ).toBe('changed=true\nchangeset=opencode-go-privacy-aaaaaaa.md\n')
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

    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA})
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

    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA})
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

    expect(result).toEqual({changed: true, sourceCommit: NEW_SHA})
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
