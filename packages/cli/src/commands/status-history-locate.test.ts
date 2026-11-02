import type {FetchLike} from '../status/github-api'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stripVTControlCharacters} from 'node:util'

import {describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {createCapturedCtx} from '../lib/mcp-ctx-fixture'
import {makeStatusDependencies} from './__fixtures__/status-dependencies'
import {MCP_ALLOWLIST} from './mcp'
import {registerStatus} from './status'
import {
  HISTORY_LOCATE_CALL_BUDGET,
  HISTORY_LOCATE_RUN_CHECK_BUDGET,
  locateHistory,
  SNAPSHOT_WORKFLOW_PATH,
  statusHistoryLocateAction,
} from './status-history-locate'

const TOKEN = 'ghs_locate_token_must_never_leak'
const REPOSITORY = 'marcusrbrown/infra'

interface FakeArtifact {
  runId: number
  createdAt: string
  expired?: boolean
  branch?: string | null
  name?: string
}

interface FakeRun {
  event?: string
  branch?: string | null
  path?: string
}

function artifact({runId, createdAt, expired = false, branch = 'main', name = 'status-history'}: FakeArtifact) {
  return {
    id: runId * 10,
    name,
    expired,
    created_at: createdAt,
    workflow_run: {id: runId, head_branch: branch},
  }
}

/**
 * A fake GitHub boundary: an artifact list, per-run details, the newest successful snapshot run, and optional
 * forced failures. Unless `latestSuccess` is given, the newest successful run is the newest usable artifact's run.
 */
function fakeApi(config: {
  artifacts: ReturnType<typeof artifact>[]
  totalCount?: number
  runs?: Record<number, FakeRun>
  failList?: boolean
  failRun?: number
  /** Run id of the newest successful snapshot run; `null` means there is none. */
  latestSuccess?: number | null
  failLatest?: boolean
}) {
  const usable = config.artifacts
    .filter(entry => {
      const run = config.runs?.[entry.workflow_run.id] ?? {}
      return (
        !entry.expired &&
        entry.name === 'status-history' &&
        entry.workflow_run.head_branch === 'main' &&
        ['schedule', 'workflow_dispatch'].includes(run.event ?? 'schedule') &&
        run.path === undefined &&
        (run.branch ?? 'main') === 'main'
      )
    })
    .toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
  const latestSuccess = config.latestSuccess === undefined ? (usable[0]?.workflow_run.id ?? null) : config.latestSuccess
  const calls: {url: string; authorization: string | null}[] = []
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(input)
    calls.push({url: input, authorization: new Headers(init?.headers).get('authorization')})

    if (url.pathname === `/repos/${REPOSITORY}/actions/artifacts`) {
      if (config.failList === true) return new Response('nope', {status: 500})
      return Response.json({total_count: config.totalCount ?? config.artifacts.length, artifacts: config.artifacts})
    }
    if (url.pathname === `/repos/${REPOSITORY}/actions/workflows/status-snapshot.yaml/runs`) {
      if (config.failLatest === true) return new Response('nope', {status: 500})
      return Response.json({
        total_count: latestSuccess === null ? 0 : 1,
        workflow_runs: latestSuccess === null ? [] : [{id: latestSuccess}],
      })
    }
    const match = /\/actions\/runs\/(\d+)$/.exec(url.pathname)
    if (match !== null) {
      const id = Number(match[1])
      if (config.failRun === id) return new Response('nope', {status: 502})
      const run = config.runs?.[id] ?? {}
      return Response.json({
        id,
        event: run.event ?? 'schedule',
        head_branch: run.branch === undefined ? 'main' : run.branch,
        path: run.path ?? SNAPSHOT_WORKFLOW_PATH,
      })
    }
    return new Response('not found', {status: 404})
  }
  return {fetchFn, calls}
}

function at(minutesAgo: number): string {
  return new Date(Date.UTC(2026, 10, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString()
}

describe('locateHistory', () => {
  it('selects the newest eligible artifact', async () => {
    const api = fakeApi({
      artifacts: [artifact({runId: 1, createdAt: at(90)}), artifact({runId: 2, createdAt: at(30)})],
    })

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'found', runId: 2})
    expect(api.calls.map(call => new URL(call.url).pathname)).toEqual([
      `/repos/${REPOSITORY}/actions/artifacts`,
      `/repos/${REPOSITORY}/actions/runs/2`,
      `/repos/${REPOSITORY}/actions/workflows/status-snapshot.yaml/runs`,
    ])
  })

  it('never selects a newer artifact built on a non-main branch', async () => {
    const api = fakeApi({
      artifacts: [artifact({runId: 9, createdAt: at(1), branch: 'attacker'}), artifact({runId: 3, createdAt: at(60)})],
    })

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'found', runId: 3})
    expect(api.calls.some(call => call.url.includes('/runs/9'))).toBe(false)
  })

  it('never selects a null-branch artifact or one with a different name', async () => {
    const api = fakeApi({
      artifacts: [
        artifact({runId: 8, createdAt: at(1), branch: null}),
        artifact({runId: 7, createdAt: at(2), name: 'other'}),
      ],
    })

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'empty'})
    expect(api.calls).toHaveLength(1)
  })

  it('skips an expired artifact', async () => {
    const api = fakeApi({
      artifacts: [artifact({runId: 5, createdAt: at(1), expired: true}), artifact({runId: 4, createdAt: at(50)})],
    })

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'found', runId: 4})
  })

  it('skips a run whose event is not schedule or workflow_dispatch', async () => {
    const api = fakeApi({
      artifacts: [artifact({runId: 6, createdAt: at(1)}), artifact({runId: 5, createdAt: at(40)})],
      runs: {6: {event: 'pull_request'}},
    })

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'found', runId: 5})
  })

  it('accepts a workflow_dispatch run', async () => {
    const api = fakeApi({artifacts: [artifact({runId: 6, createdAt: at(1)})], runs: {6: {event: 'workflow_dispatch'}}})

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'found', runId: 6})
  })

  it('skips a run of a different workflow', async () => {
    const api = fakeApi({
      artifacts: [artifact({runId: 6, createdAt: at(1)}), artifact({runId: 5, createdAt: at(40)})],
      runs: {6: {path: '.github/workflows/other.yaml'}},
    })

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'found', runId: 5})
  })

  it('skips a run that is not on main', async () => {
    const api = fakeApi({artifacts: [artifact({runId: 6, createdAt: at(1)})], runs: {6: {branch: 'feat/x'}}})

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'empty'})
  })

  it('reports empty only when the API lists no eligible artifact', async () => {
    expect(await locateHistory(fakeApi({artifacts: []}).fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'empty'})
    const allExpired = fakeApi({artifacts: [artifact({runId: 1, createdAt: at(1), expired: true})]})
    expect(await locateHistory(allExpired.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'empty'})
  })

  it('is an error, never empty, when the listing is truncated', async () => {
    const api = fakeApi({artifacts: [artifact({runId: 1, createdAt: at(1), expired: true})], totalCount: 250})

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'error', reason: 'incomplete-listing'})
  })

  it('is an error when the list call fails', async () => {
    const api = fakeApi({artifacts: [], failList: true})

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'error', reason: 'api-error'})
  })

  it('is an error when a run lookup fails, not a skip to an older artifact', async () => {
    const api = fakeApi({
      artifacts: [artifact({runId: 6, createdAt: at(1)}), artifact({runId: 5, createdAt: at(40)})],
      failRun: 6,
    })

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'error', reason: 'api-error'})
    expect(api.calls).toHaveLength(2)
  })

  it('is an error on a malformed response body', async () => {
    const fetchFn: FetchLike = async () => Response.json({artifacts: 'nope'})

    expect(await locateHistory(fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'error', reason: 'api-error'})
  })

  it('makes a bounded number of calls and errors, not empty, when the budget runs out', async () => {
    const many = Array.from({length: 40}, (_, index) => artifact({runId: index + 1, createdAt: at(index + 1)}))
    const api = fakeApi({artifacts: many, runs: Object.fromEntries(many.map((_, i) => [i + 1, {event: 'push'}]))})

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({
      state: 'error',
      reason: 'run-check-budget-exceeded',
    })
    expect(api.calls).toHaveLength(1 + HISTORY_LOCATE_RUN_CHECK_BUDGET)
    expect(api.calls.length).toBeLessThanOrEqual(HISTORY_LOCATE_CALL_BUDGET)
  })

  it('budgets one list call, the candidate run checks, and the latest-success check', async () => {
    expect(HISTORY_LOCATE_CALL_BUDGET).toBe(1 + HISTORY_LOCATE_RUN_CHECK_BUDGET + 1)

    // The worst case that still succeeds: every candidate but the last fails its run check.
    const many = Array.from({length: HISTORY_LOCATE_RUN_CHECK_BUDGET}, (_, index) =>
      artifact({runId: index + 1, createdAt: at(index + 1)}),
    )
    const api = fakeApi({
      artifacts: many,
      runs: Object.fromEntries(many.slice(0, -1).map((_, index) => [index + 1, {event: 'push'}])),
      latestSuccess: HISTORY_LOCATE_RUN_CHECK_BUDGET,
    })

    expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({
      state: 'found',
      runId: HISTORY_LOCATE_RUN_CHECK_BUDGET,
    })
    expect(api.calls).toHaveLength(HISTORY_LOCATE_CALL_BUDGET)
  })

  describe('stale-artifact guard', () => {
    it('refuses an artifact from run 100 when the newest successful snapshot run is 101', async () => {
      const api = fakeApi({artifacts: [artifact({runId: 100, createdAt: at(30)})], latestSuccess: 101})

      expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'error', reason: 'stale-artifact'})
    })

    it('finds the artifact when it is from the newest successful snapshot run', async () => {
      const api = fakeApi({artifacts: [artifact({runId: 101, createdAt: at(30)})], latestSuccess: 101})

      expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'found', runId: 101})
      expect(api.calls.map(call => new URL(call.url).pathname)).toEqual([
        `/repos/${REPOSITORY}/actions/artifacts`,
        `/repos/${REPOSITORY}/actions/runs/101`,
        `/repos/${REPOSITORY}/actions/workflows/status-snapshot.yaml/runs`,
      ])
    })

    it('is stale when an artifact was found but no snapshot run has succeeded', async () => {
      const api = fakeApi({artifacts: [artifact({runId: 100, createdAt: at(30)})], latestSuccess: null})

      expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'error', reason: 'stale-artifact'})
    })

    it('is an API error, not found, when the latest-success call fails', async () => {
      const api = fakeApi({artifacts: [artifact({runId: 100, createdAt: at(30)})], failLatest: true})

      expect(await locateHistory(api.fetchFn, TOKEN, REPOSITORY)).toEqual({state: 'error', reason: 'api-error'})
    })

    it('asks for the newest successful run of the snapshot workflow on main, one result', async () => {
      const api = fakeApi({artifacts: [artifact({runId: 100, createdAt: at(30)})]})
      await locateHistory(api.fetchFn, TOKEN, REPOSITORY)

      const latest = new URL(api.calls.at(-1)?.url ?? '')
      expect(latest.pathname).toBe(`/repos/${REPOSITORY}/actions/workflows/status-snapshot.yaml/runs`)
      expect(latest.searchParams.get('branch')).toBe('main')
      expect(latest.searchParams.get('status')).toBe('success')
      expect(latest.searchParams.get('per_page')).toBe('1')
    })

    it('makes no latest-success call when nothing was found', async () => {
      const empty = fakeApi({artifacts: []})
      await locateHistory(empty.fetchFn, TOKEN, REPOSITORY)

      expect(empty.calls).toHaveLength(1)
    })
  })

  it('asks for the named artifact with a page size and sends the token only as a bearer header', async () => {
    const api = fakeApi({artifacts: [artifact({runId: 1, createdAt: at(1)})]})
    await locateHistory(api.fetchFn, TOKEN, REPOSITORY)

    const list = new URL(api.calls[0]?.url ?? '')
    expect(list.origin).toBe('https://api.github.com')
    expect(list.searchParams.get('name')).toBe('status-history')
    expect(list.searchParams.get('per_page')).toBe('100')
    expect(api.calls.every(call => call.authorization === `Bearer ${TOKEN}` && !call.url.includes(TOKEN))).toBe(true)
  })
})

async function run(config: {api?: ReturnType<typeof fakeApi>; env?: Record<string, string | undefined>}) {
  const {ctx, captured} = createCapturedCtx()
  const api = config.api ?? fakeApi({artifacts: []})
  try {
    await statusHistoryLocateAction(
      ctx,
      {fetch: api.fetchFn},
      config.env ?? {GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY},
    )
  } catch (error) {
    if (captured.exit === null) throw error
  }
  return {captured, api}
}

describe('status history-locate action', () => {
  it('prints exactly `found run-id=<id>`', async () => {
    const {captured} = await run({api: fakeApi({artifacts: [artifact({runId: 321, createdAt: at(5)})]})})

    expect(captured.exit).toBeNull()
    expect(captured.stdout).toEqual(['found run-id=321'])
    expect(captured.stderr).toEqual([])
  })

  it('prints exactly `empty` when nothing exists', async () => {
    const {captured} = await run({})

    expect(captured.exit).toBeNull()
    expect(captured.stdout).toEqual(['empty'])
  })

  it('exits non-zero on an API error and prints nothing on stdout', async () => {
    const {captured} = await run({api: fakeApi({artifacts: [], failList: true})})

    expect(captured.exit).toEqual({code: 1})
    expect(captured.stdout).toEqual([])
    expect(captured.stderr).toEqual(['status history-locate failed: api-error'])
  })

  it('exits non-zero with nothing on stdout or in GITHUB_OUTPUT for a stale artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-locate-'))
    try {
      const file = join(dir, 'out')
      const {captured} = await run({
        env: {GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_OUTPUT: file},
        api: fakeApi({artifacts: [artifact({runId: 100, createdAt: at(30)})], latestSuccess: 101}),
      })

      expect(captured.exit).toEqual({code: 1})
      expect(captured.stdout).toEqual([])
      expect(captured.stderr).toEqual(['status history-locate failed: stale-artifact'])
      expect(await Bun.file(file).exists()).toBe(false)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('exits non-zero when the latest-success call fails', async () => {
    const {captured} = await run({
      api: fakeApi({artifacts: [artifact({runId: 100, createdAt: at(30)})], failLatest: true}),
    })

    expect(captured.exit).toEqual({code: 1})
    expect(captured.stdout).toEqual([])
    expect(captured.stderr).toEqual(['status history-locate failed: api-error'])
  })

  it('exits non-zero without any request when the token is missing or blank', async () => {
    for (const env of [{GITHUB_REPOSITORY: REPOSITORY}, {GITHUB_TOKEN: '  ', GITHUB_REPOSITORY: REPOSITORY}]) {
      const {captured, api} = await run({env})

      expect(captured.exit).toEqual({code: 1})
      expect(captured.stderr).toEqual(['status history-locate failed: missing-token'])
      expect(api.calls).toEqual([])
    }
  })

  it('accepts GH_TOKEN and falls back to the default repository', async () => {
    const api = fakeApi({artifacts: []})
    const {captured} = await run({api, env: {GH_TOKEN: TOKEN}})

    expect(captured.stdout).toEqual(['empty'])
    expect(api.calls).toHaveLength(1)
  })

  it('rejects a repository value that could change the request path', async () => {
    for (const GITHUB_REPOSITORY of ['../../user', 'a/b/c', 'a/b?x=1', 'a b/c']) {
      const {captured, api} = await run({env: {GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY}})

      expect(captured.exit).toEqual({code: 1})
      expect(captured.stderr).toEqual(['status history-locate failed: invalid-repository'])
      expect(api.calls).toEqual([])
    }
  })

  it('appends state and run-id to GITHUB_OUTPUT when set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-locate-'))
    try {
      const file = join(dir, 'out')
      const env = {GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_OUTPUT: file}

      await run({env, api: fakeApi({artifacts: [artifact({runId: 77, createdAt: at(5)})]})})
      expect(await readFile(file, 'utf8')).toBe('state=found\nrun-id=77\n')

      await run({env})
      expect(await readFile(file, 'utf8')).toBe('state=found\nrun-id=77\nstate=empty\n')
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('writes nothing to GITHUB_OUTPUT on an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-locate-'))
    try {
      const file = join(dir, 'out')
      const {captured} = await run({
        env: {GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_OUTPUT: file},
        api: fakeApi({artifacts: [], failList: true}),
      })

      expect(captured.exit).toEqual({code: 1})
      expect(await Bun.file(file).exists()).toBe(false)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('exits non-zero with no stdout when GITHUB_OUTPUT is unwritable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-locate-'))
    try {
      const {captured} = await run({
        env: {GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_OUTPUT: join(dir, 'missing', 'out')},
      })

      expect(captured.exit).toEqual({code: 1})
      expect(captured.stdout).toEqual([])
      expect(captured.stderr).toEqual(['status history-locate failed: output-file-error'])
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('never prints the token', async () => {
    const {captured} = await run({api: fakeApi({artifacts: [], failList: true})})

    expect([...captured.stdout, ...captured.stderr].join('\n')).not.toContain(TOKEN)
  })
})

describe('status history-locate registration', () => {
  it('is a goke subcommand and does not break `status snapshot` or `status` routing', () => {
    const cli = goke('infra')
    registerStatus(cli, makeStatusDependencies())
    cli.help()
    const help = stripVTControlCharacters(cli.helpText())

    expect(help).toContain('status history-locate')
    expect(help).toContain('status snapshot')

    const routed = goke('infra')
    registerStatus(routed, makeStatusDependencies())
    routed.parse(['bun', 'infra', 'status', 'history-locate'], {run: false})
    expect(routed.matchedCommandName).toBe('status history-locate')
  })

  it('stays off MCP_ALLOWLIST', () => {
    expect(MCP_ALLOWLIST.has('status history-locate')).toBe(false)
    expect([...MCP_ALLOWLIST].some(name => name.includes('history-locate'))).toBe(false)
  })
})
