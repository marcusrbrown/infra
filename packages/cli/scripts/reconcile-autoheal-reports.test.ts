/// <reference types="bun" />

/**
 * Behavior contract for the repo-local Fro Bot autoheal reconciler.
 *
 * Every test drives `reconcileAutohealReports` through an injectable native
 * `fetch` boundary backed by an in-memory fake GitHub API. No test performs a
 * live network call, and no test depends on a fixed count from production.
 */

import type {FetchLike} from './reconcile-autoheal-reports'
import {describe, expect, it} from 'bun:test'
import {
  API_VERSION,
  BOT_LOGIN,
  dailyReportTitle,
  findMissingHeadings,
  LABEL_NAME,
  MANAGED_MARKER,
  nextLink,
  readReconcilerEnv,
  reconcileAutohealReports,
  REQUIRED_HEADINGS,
  runMarker,
  supersessionMarker,
} from './reconcile-autoheal-reports'

// ─── Fixture constants ───────────────────────────────────────────────────────

const REPO = 'owner/repo'
const DATE = '2026-09-12'
const RUN_ID = '34670890067'
const OTHER_RUN_ID = '34000000000'
const BOT_ID = 99001

// ─── Fake GitHub boundary ────────────────────────────────────────────────────

interface MockSpec {
  status?: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
  networkError?: string
}

interface RecordedRequest {
  method: string
  host: string
  path: string
  query: URLSearchParams
  body: string | null
  headers: Headers
}

interface FakeIssue {
  number: number
  id: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  login: string
  userId: number
  pullRequest?: boolean
}

interface FakeComment {
  id: number
  issueNumber: number
  body: string
  login: string
  userId: number
}

class FakeGitHub {
  botId = BOT_ID
  botLogin = BOT_LOGIN
  labelExists = true
  labelCreateStatus = 201
  labelProbeStatus: number | null = null
  issues: FakeIssue[] = []
  comments: FakeComment[] = []
  listPageSize: number | null = null
  commentPageSize: number | null = null
  override?: (request: RecordedRequest) => MockSpec | undefined
  requests: RecordedRequest[] = []
  mutations: RecordedRequest[] = []

  private nextCommentId = 80000

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? undefined)
    const body = typeof init?.body === 'string' ? init.body : null
    const request: RecordedRequest = {
      method,
      host: url.host,
      path: url.pathname,
      query: url.searchParams,
      body,
      headers,
    }
    this.requests.push(request)
    if (method !== 'GET') this.mutations.push(request)
    const spec = this.override?.(request) ?? this.route(request)
    if (spec.networkError !== undefined) throw new Error(spec.networkError)
    const responseHeaders = new Headers(spec.headers ?? {})
    const responseBody = spec.text ?? (spec.json === undefined ? '' : JSON.stringify(spec.json))
    return new Response(responseBody, {status: spec.status ?? 200, headers: responseHeaders})
  }

  issueRecord(issue: FakeIssue): Record<string, unknown> {
    return {
      number: issue.number,
      id: issue.id,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      html_url: `https://github.com/${REPO}/issues/${issue.number}`,
      user: {login: issue.login, id: issue.userId},
      labels: issue.labels.map(name => ({name})),
      ...(issue.pullRequest === true ? {pull_request: {url: 'https://api.github.com/pulls/x'}} : {}),
    }
  }

  commentRecord(comment: FakeComment): Record<string, unknown> {
    return {id: comment.id, body: comment.body, user: {login: comment.login, id: comment.userId}}
  }

  private route(request: RecordedRequest): MockSpec {
    const {path, method, query} = request
    const prefix = `/repos/${REPO}`

    if (path === '/user') return {json: {login: this.botLogin, id: this.botId}}

    if (path === `${prefix}/labels/${LABEL_NAME}`) {
      const status = this.labelProbeStatus ?? (this.labelExists ? 200 : 404)
      return {
        status,
        json: status === 200 ? {name: LABEL_NAME} : {message: status === 404 ? 'Not Found' : 'Forbidden'},
      }
    }

    if (path === `${prefix}/labels` && method === 'POST') {
      if (this.labelCreateStatus >= 200 && this.labelCreateStatus < 300) {
        this.labelExists = true
        return {status: this.labelCreateStatus, json: {name: LABEL_NAME}}
      }
      return {status: this.labelCreateStatus, json: {message: 'label create failed'}}
    }

    if (path === `${prefix}/issues` && method === 'GET') {
      const open = this.issues.filter(issue => issue.state === 'open').map(issue => this.issueRecord(issue))
      if (this.listPageSize === null) return {json: open}
      const page = Number(query.get('page') ?? '1')
      const start = (page - 1) * this.listPageSize
      const slice = open.slice(start, start + this.listPageSize)
      const headers: Record<string, string> = {}
      if (start + this.listPageSize < open.length) {
        headers.link = `<${prefix}/issues?state=open&per_page=${this.listPageSize}&page=${page + 1}>; rel="next"`
      }
      return {json: slice, headers}
    }

    const commentById = path.match(/^\/repos\/owner\/repo\/issues\/comments\/(\d+)$/)
    if (commentById !== null && method === 'GET') {
      const comment = this.comments.find(candidate => candidate.id === Number(commentById[1]))
      if (comment === undefined) return {status: 404, json: {message: 'Not Found'}}
      return {json: this.commentRecord(comment)}
    }

    const comments = path.match(/^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/)
    if (comments !== null) {
      const issueNumber = Number(comments[1])
      const list = this.comments.filter(comment => comment.issueNumber === issueNumber)
      if (method === 'GET') {
        if (this.commentPageSize === null) return {json: list.map(comment => this.commentRecord(comment))}
        const page = Number(query.get('page') ?? '1')
        const start = (page - 1) * this.commentPageSize
        const slice = list.slice(start, start + this.commentPageSize)
        const headers: Record<string, string> = {}
        if (start + this.commentPageSize < list.length) {
          headers.link = `<${prefix}/issues/${issueNumber}/comments?per_page=${this.commentPageSize}&page=${page + 1}>; rel="next"`
        }
        return {json: slice.map(comment => this.commentRecord(comment)), headers}
      }
      if (method === 'POST') {
        const parsed = request.body === null ? {} : (JSON.parse(request.body) as {body?: unknown})
        const comment: FakeComment = {
          id: this.nextCommentId++,
          issueNumber,
          body: typeof parsed.body === 'string' ? parsed.body : '',
          login: this.botLogin,
          userId: this.botId,
        }
        this.comments.push(comment)
        return {status: 201, json: this.commentRecord(comment)}
      }
    }

    const applyLabels = path.match(/^\/repos\/owner\/repo\/issues\/(\d+)\/labels$/)
    if (applyLabels !== null && method === 'POST') {
      const issue = this.issues.find(candidate => candidate.number === Number(applyLabels[1]))
      if (issue === undefined) return {status: 404, json: {message: 'Not Found'}}
      const parsed = request.body === null ? {} : (JSON.parse(request.body) as {labels?: unknown})
      if (Array.isArray(parsed.labels)) {
        for (const label of parsed.labels) {
          if (typeof label === 'string' && !issue.labels.includes(label)) issue.labels.push(label)
        }
      }
      return {status: 200, json: issue.labels.map(name => ({name}))}
    }

    const issue = path.match(/^\/repos\/owner\/repo\/issues\/(\d+)$/)
    if (issue !== null) {
      const record = this.issues.find(candidate => candidate.number === Number(issue[1]))
      if (record === undefined) return {status: 404, json: {message: 'Not Found'}}
      if (method === 'GET') return {json: this.issueRecord(record)}
      if (method === 'PATCH') {
        const parsed = request.body === null ? {} : (JSON.parse(request.body) as {state?: unknown})
        if (parsed.state === 'closed') record.state = 'closed'
        return {json: this.issueRecord(record)}
      }
    }

    return {status: 404, json: {message: 'Not Found'}}
  }
}

// ─── Fixture builders ────────────────────────────────────────────────────────

function reportBody(date: string, runId: string, extra = ''): string {
  const header = `## Daily Autohealing Report — ${date} (UTC)`
  const sections = REQUIRED_HEADINGS.map(heading => `${heading}\nNone.`).join('\n\n')
  return `${MANAGED_MARKER}\n${runMarker(runId)}\n\n${header}\n\n${sections}${extra}`
}

function managedReport(number: number, date: string, runId: string, overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number,
    id: 100_000 + number,
    title: dailyReportTitle(date),
    body: reportBody(date, runId),
    state: 'open',
    labels: [LABEL_NAME],
    login: BOT_LOGIN,
    userId: BOT_ID,
    ...overrides,
  }
}

function adoptableReport(number: number, date: string, runId: string, overrides: Partial<FakeIssue> = {}): FakeIssue {
  return managedReport(number, date, runId, {labels: [], ...overrides})
}

function supersessionFixture(): FakeGitHub {
  const server = new FakeGitHub()
  server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
  return server
}

function closureFixture(): FakeGitHub {
  const server = new FakeGitHub()
  server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
  server.comments = [
    {
      id: 2,
      issueNumber: 1300,
      body: `Superseded by #1317.\n\n${supersessionMarker(1317)}`,
      login: BOT_LOGIN,
      userId: BOT_ID,
    },
  ]
  return server
}

function options(
  server: FakeGitHub,
  overrides: Partial<Parameters<typeof reconcileAutohealReports>[0]> = {},
): Parameters<typeof reconcileAutohealReports>[0] {
  return {
    token: 'test-token-must-never-be-logged',
    repository: REPO,
    date: DATE,
    runId: RUN_ID,
    fetch: server.fetch,
    sleep: async () => {},
    ...overrides,
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('reconcile-autoheal-reports: pure contracts', () => {
  it('builds the exact daily title, run marker, and supersession marker', () => {
    expect(dailyReportTitle('2026-09-12')).toBe('Daily Autohealing Report — 2026-09-12')
    expect(runMarker('123')).toBe('<!-- fro-bot:autoheal-run:v1 run-id=123 -->')
    expect(supersessionMarker(1317)).toBe('<!-- fro-bot:autoheal-supersession:v1 canonical-issue-number=1317 -->')
  })

  it('extracts only the rel=next Link target', () => {
    expect(nextLink(null)).toBeNull()
    expect(nextLink('<https://api.github.com/a>; rel="last"')).toBeNull()
    expect(
      nextLink(
        '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=9>; rel="last"',
      ),
    ).toBe('https://api.github.com/repos/o/r/issues?page=2')
  })

  it('reports missing required headings exactly and case-sensitively', () => {
    expect(findMissingHeadings(reportBody(DATE, RUN_ID))).toEqual([])
    const degraded = reportBody(DATE, RUN_ID).replace('### Security', '### security')
    expect(findMissingHeadings(degraded)).toEqual(['### Security'])
  })

  it('resolves required environment inputs and rejects incomplete ones', () => {
    expect(readReconcilerEnv({})).toBeNull()
    expect(readReconcilerEnv({GH_TOKEN: 't', GITHUB_REPOSITORY: REPO, AUTOHEAL_DATE: DATE})).toBeNull()
    expect(
      readReconcilerEnv({GH_TOKEN: 't', GITHUB_REPOSITORY: REPO, AUTOHEAL_DATE: DATE, AUTOHEAL_RUN_ID: RUN_ID}),
    ).toEqual({token: 't', repository: REPO, date: DATE, runId: RUN_ID})
  })
})

// ─── Happy paths ─────────────────────────────────────────────────────────────

describe('reconcile-autoheal-reports: happy paths', () => {
  it('succeeds with no unnecessary mutation when one managed current report is proven', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID)]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.phase).toBe('complete')
    expect(summary.failure_code).toBeNull()
    expect(summary.canonical_issue_number).toBe(1317)
    expect(summary.canonical_issue_id).toBe(100_000 + 1317)
    expect(summary.eligible).toBe(1)
    expect(summary.final_open_managed).toBe(1)
    expect(summary.adopted).toBe(0)
    expect(summary.commented).toBe(0)
    expect(summary.closed).toBe(0)
    expect(server.mutations).toEqual([])
    expect(server.requests.length).toBeGreaterThan(0)
    expect(server.requests.every(request => request.headers.get('x-github-api-version') === API_VERSION)).toBe(true)
    expect(
      server.requests.every(
        request => request.headers.get('authorization') === 'Bearer test-token-must-never-be-logged',
      ),
    ).toBe(true)
  })

  it('adopts an unlabeled canonical report and supersedes older and future managed reports', async () => {
    const server = new FakeGitHub()
    server.issues = [
      adoptableReport(1317, DATE, RUN_ID),
      managedReport(1300, '2026-09-10', OTHER_RUN_ID),
      managedReport(1400, '2026-09-20', OTHER_RUN_ID),
    ]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.adopted).toBe(1)
    expect(summary.commented).toBe(2)
    expect(summary.closed).toBe(2)
    expect(summary.final_open_managed).toBe(1)

    expect(server.issues.find(issue => issue.number === 1317)?.labels).toContain(LABEL_NAME)
    expect(
      server.issues
        .filter(issue => issue.state === 'closed')
        .map(issue => issue.number)
        .sort((a, b) => a - b),
    ).toEqual([1300, 1400])

    const marker = supersessionMarker(1317)
    for (const number of [1300, 1400]) {
      const listed = server.comments.filter(comment => comment.issueNumber === number)
      expect(listed).toHaveLength(1)
      expect(listed[0]?.body).toContain(marker)
      expect(listed[0]?.userId).toBe(BOT_ID)
    }
    // The canonical issue is never commented on.
    expect(server.comments.filter(comment => comment.issueNumber === 1317)).toHaveLength(0)
  })

  it('finds an existing supersession marker through full comment pagination without duplicating it', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.commentPageSize = 1
    server.comments = [
      {id: 1, issueNumber: 1300, body: 'unrelated chatter', login: 'human', userId: 7},
      {
        id: 2,
        issueNumber: 1300,
        body: `Superseded by #1317.\n\n${supersessionMarker(1317)}`,
        login: BOT_LOGIN,
        userId: BOT_ID,
      },
    ]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.commented).toBe(0)
    expect(summary.closed).toBe(1)
    expect(
      server.mutations.filter(request => request.method === 'POST' && request.path.endsWith('/comments')),
    ).toHaveLength(0)
  })

  it('retries comment visibility once before creating a supersession comment', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.comments = [
      {
        id: 2,
        issueNumber: 1300,
        body: `Superseded by #1317.\n\n${supersessionMarker(1317)}`,
        login: BOT_LOGIN,
        userId: BOT_ID,
      },
    ]
    let commentReads = 0
    server.override = request => {
      if (request.method === 'GET' && request.path.endsWith('/1300/comments')) {
        commentReads += 1
        if (commentReads === 1) return {json: []}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(commentReads).toBe(2)
    expect(summary.commented).toBe(0)
    expect(summary.closed).toBe(1)
  })

  it('resumes a partial prior run: marker present, issue still open, only the close completes', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.comments = [
      {
        id: 2,
        issueNumber: 1300,
        body: `Superseded by #1317.\n\n${supersessionMarker(1317)}`,
        login: BOT_LOGIN,
        userId: BOT_ID,
      },
    ]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.commented).toBe(0)
    expect(summary.closed).toBe(1)
  })

  it('leaves an untrusted title collision untouched while still reconciling', async () => {
    const server = new FakeGitHub()
    const collision: FakeIssue = {
      number: 1500,
      id: 200_000,
      title: dailyReportTitle(DATE),
      body: `${MANAGED_MARKER}\n${runMarker(RUN_ID)}\n\nhostile prose`,
      state: 'open',
      labels: [],
      login: 'intruder',
      userId: 123,
    }
    server.issues = [managedReport(1317, DATE, RUN_ID), collision]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.untrusted_collisions).toBe(1)
    expect(summary.eligible).toBe(1)
    expect(server.issues.find(issue => issue.number === 1500)?.state).toBe('open')
    expect(server.issues.find(issue => issue.number === 1500)?.labels).toEqual([])
    expect(server.comments.filter(comment => comment.issueNumber === 1500)).toHaveLength(0)
  })

  it('excludes pull-request-shaped records from discovery', async () => {
    const server = new FakeGitHub()
    const pullRequest = managedReport(1600, DATE, RUN_ID, {pullRequest: true})
    server.issues = [managedReport(1317, DATE, RUN_ID), pullRequest]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.eligible).toBe(1)
    expect(summary.untrusted_collisions).toBe(0)
    expect(server.issues.find(issue => issue.number === 1600)?.state).toBe('open')
    expect(server.mutations).toEqual([])
  })

  it('completes discovery across Link next pages', async () => {
    const server = new FakeGitHub()
    server.listPageSize = 2
    server.issues = [
      managedReport(1317, DATE, RUN_ID),
      managedReport(1300, '2026-09-10', OTHER_RUN_ID),
      managedReport(1299, '2026-09-09', OTHER_RUN_ID),
    ]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.eligible).toBe(3)
    expect(summary.closed).toBe(2)
    expect(summary.final_open_managed).toBe(1)
  })
})

// ─── Label contract ──────────────────────────────────────────────────────────

describe('reconcile-autoheal-reports: label contract', () => {
  it('creates the label only after a confirmed 404 and reads it back', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    const labelCreates = server.mutations.filter(
      request => request.method === 'POST' && request.path === `/repos/${REPO}/labels`,
    )
    expect(labelCreates).toHaveLength(1)
    expect(server.labelExists).toBe(true)
  })

  it('fails closed before issue mutation when the label probe returns a non-404 error', async () => {
    const server = new FakeGitHub()
    server.labelProbeStatus = 403
    server.issues = [managedReport(1317, DATE, RUN_ID)]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_probe_failed')
    expect(server.mutations).toEqual([])
  })

  it('does not treat a 422 already_exists label create as benign', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.labelCreateStatus = 422
    server.issues = [managedReport(1317, DATE, RUN_ID)]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_create_failed')
    expect(server.labelExists).toBe(false)
  })
})

// ─── Validation + snapshot revalidation ──────────────────────────────────────

describe('reconcile-autoheal-reports: validation', () => {
  it('fails closed when no current-date report carries the run marker', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, OTHER_RUN_ID)]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('current_report_missing')
    expect(server.mutations).toEqual([])
  })

  it('fails closed when more than one current-date report carries the run marker', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1318, DATE, RUN_ID)]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('current_report_ambiguous')
    expect(server.mutations).toEqual([])
  })

  it('fails closed when a required heading is missing', async () => {
    const server = new FakeGitHub()
    const issue = managedReport(1317, DATE, RUN_ID)
    issue.body = `${MANAGED_MARKER}\n${runMarker(RUN_ID)}\n\n## Daily Autohealing Report — ${DATE} (UTC)\n\nNothing else.`
    server.issues = [issue]

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('heading_missing')
    expect(server.mutations).toEqual([])
  })

  it('fails closed when the eligible candidate cap is exceeded', async () => {
    const server = new FakeGitHub()
    server.issues = Array.from({length: 101}, (_unused, index) => adoptableReport(2000 + index, DATE, RUN_ID))

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('candidate_cap_exceeded')
    expect(server.mutations).toEqual([])
  })

  it('fails closed on a malformed discovery response', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues`) {
        return {text: 'not-json', headers: {'content-type': 'application/json'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('discovery_failed')
    expect(server.mutations).toEqual([])
  })

  it('fails closed when a later pagination page is unavailable', async () => {
    const server = new FakeGitHub()
    server.listPageSize = 1
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues` && request.query.get('page') === '2') {
        return {status: 500, json: {message: 'boom'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('pagination_incomplete')
    expect(server.mutations).toEqual([])
  })

  it('aborts before the first destructive mutation when fresh discovery diverges', async () => {
    const server = new FakeGitHub()
    const canonical = adoptableReport(1317, DATE, RUN_ID)
    const extra = adoptableReport(1417, DATE, RUN_ID)
    server.issues = [canonical]
    let listCalls = 0
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues`) {
        listCalls += 1
        if (listCalls === 2) return {json: [server.issueRecord(canonical), server.issueRecord(extra)]}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('snapshot_diverged')
    expect(summary.adopted).toBe(0)
    expect(server.mutations).toEqual([])
  })

  it('rejects a pre-write target whose numeric identity changed', async () => {
    const server = new FakeGitHub()
    const canonical = adoptableReport(1317, DATE, RUN_ID)
    server.issues = [canonical]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues/1317`) {
        return {json: {...server.issueRecord(canonical), id: canonical.id + 1}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('target_identity_mismatch')
    expect(server.mutations).toEqual([])
  })

  it('rejects a pre-write target that became pull-request-shaped', async () => {
    const server = new FakeGitHub()
    const canonical = adoptableReport(1317, DATE, RUN_ID)
    server.issues = [canonical]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues/1317`) {
        return {json: {...server.issueRecord(canonical), pull_request: {url: 'https://api.github.com/pulls/1317'}}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('target_pull_request')
    expect(server.mutations).toEqual([])
  })
})

// ─── Rate limit and readback budgets ─────────────────────────────────────────

describe('reconcile-autoheal-reports: bounded reads', () => {
  it('retries a 429 read once when retry-after guidance is present', async () => {
    const server = new FakeGitHub()
    server.issues = [adoptableReport(1317, DATE, RUN_ID)]
    let rateLimited = 0
    let wrapped = false
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues/1317`) {
        rateLimited += 1
        if (rateLimited === 1) return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1317/labels`) wrapped = true
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(rateLimited).toBeGreaterThanOrEqual(1)
    expect(wrapped).toBe(true)
  })

  it('fails closed on a 429 read when no retry guidance is provided', async () => {
    const server = new FakeGitHub()
    server.issues = [adoptableReport(1317, DATE, RUN_ID)]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues/1317`) {
        return {status: 429, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('rate_limit')
    expect(server.mutations).toEqual([])
  })

  it('fails closed when the canonical label readback never shows the applied label', async () => {
    const server = new FakeGitHub()
    const canonical = adoptableReport(1317, DATE, RUN_ID)
    server.issues = [canonical]
    let labelApplied = false
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1317/labels`) labelApplied = true
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues/1317` && labelApplied) {
        return {json: {...server.issueRecord(canonical), labels: []}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_apply_readback_failed')
  })

  it('fails closed when a supersession comment readback lacks the exact marker', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.override = request => {
      if (request.method === 'GET' && /^\/repos\/owner\/repo\/issues\/comments\/\d+$/.test(request.path)) {
        return {json: {id: 80000, body: 'missing the marker', user: {login: BOT_LOGIN, id: BOT_ID}}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('comment_readback_failed')
  })

  it('fails closed when no discovery run proves exactly one open managed report', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    let listCalls = 0
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues`) {
        listCalls += 1
        if (listCalls === 3) {
          // Final proof sees the noncanonical report still open.
          return {
            json: [
              server.issueRecord(managedReport(1317, DATE, RUN_ID)),
              server.issueRecord(managedReport(1300, '2026-09-10', OTHER_RUN_ID)),
            ],
          }
        }
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('final_proof_failed')
  })
})

// ─── Terminal summary safety ─────────────────────────────────────────────────

describe('reconcile-autoheal-reports: terminal summary', () => {
  it('emits one body-free machine-readable summary on success', async () => {
    const server = new FakeGitHub()
    const issue = managedReport(1317, DATE, RUN_ID)
    issue.body += '\nSUPER_SECRET_BODY_SENTINEL'
    server.issues = [issue]

    const summary = await reconcileAutohealReports(options(server))
    const line = JSON.stringify(summary)

    expect(summary.status).toBe('succeeded')
    expect(line).toContain('"workflow_run_id":"34670890067"')
    expect(line).not.toContain('SUPER_SECRET_BODY_SENTINEL')
    expect(line).not.toContain('test-token-must-never-be-logged')
    expect(line).not.toContain(MANAGED_MARKER)
  })

  it('emits one body-free machine-readable summary on a safe abort', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, OTHER_RUN_ID)]

    const summary = await reconcileAutohealReports(options(server))
    const line = JSON.stringify(summary)

    expect(summary.status).toBe('aborted')
    expect(summary.phase).toBe('validation')
    expect(summary.failure_reason).toBeTruthy()
    expect(line).not.toContain('test-token-must-never-be-logged')
  })
})

// ─── Orchestrator readback corrections ───────────────────────────────────────

describe('reconcile-autoheal-reports: label response validation', () => {
  it('fails closed when the label probe returns malformed JSON', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/labels/${LABEL_NAME}`) {
        return {text: 'not-json', headers: {'content-type': 'application/json'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_probe_failed')
    expect(server.mutations).toEqual([])
  })

  it('fails closed when the label probe returns a different name', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/labels/${LABEL_NAME}`) {
        return {status: 200, json: {name: 'other-label'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_probe_failed')
  })

  it('fails closed when the created label response has a different name', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/labels`) {
        return {status: 201, json: {name: 'other-label'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_create_failed')
  })

  it('fails closed when the label readback never shows the exact name', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    let created = false
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/labels`) {
        created = true
        return {status: 201, json: {name: LABEL_NAME}}
      }
      if (request.method === 'GET' && request.path === `/repos/${REPO}/labels/${LABEL_NAME}` && created) {
        return {status: 200, json: {name: 'other-label'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_readback_failed')
  })
})

describe('reconcile-autoheal-reports: pagination read budget', () => {
  it('retries a rate-limited later discovery page once within budget', async () => {
    const server = new FakeGitHub()
    server.listPageSize = 1
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    let pageTwoCalls = 0
    let rateLimitedResponses = 0
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues` && request.query.get('page') === '2') {
        pageTwoCalls += 1
        if (pageTwoCalls === 1) {
          rateLimitedResponses += 1
          return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
        }
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.eligible).toBe(2)
    expect(rateLimitedResponses).toBe(1)
    expect(pageTwoCalls).toBeGreaterThanOrEqual(2)
  })

  it('fails closed on a later discovery page rate limited without guidance', async () => {
    const server = new FakeGitHub()
    server.listPageSize = 1
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues` && request.query.get('page') === '2') {
        return {status: 429, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('pagination_incomplete')
    expect(server.mutations).toEqual([])
  })

  it('retries a rate-limited later comment page once within budget', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.commentPageSize = 1
    server.comments = [
      {id: 1, issueNumber: 1300, body: 'unrelated', login: 'human', userId: 7},
      {id: 2, issueNumber: 1300, body: `Superseded.\n\n${supersessionMarker(1317)}`, login: BOT_LOGIN, userId: BOT_ID},
    ]
    let pageTwoCalls = 0
    server.override = request => {
      if (
        request.method === 'GET' &&
        request.path === `/repos/${REPO}/issues/1300/comments` &&
        request.query.get('page') === '2'
      ) {
        pageTwoCalls += 1
        if (pageTwoCalls === 1) return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.commented).toBe(0)
    expect(summary.closed).toBe(1)
    expect(pageTwoCalls).toBe(2)
  })

  it('fails closed on a comment page rate limited without guidance', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues/1300/comments`) {
        return {status: 429, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('comment_list_failed')
  })
})

describe('reconcile-autoheal-reports: pagination origin safety', () => {
  it('rejects an off-origin absolute next link without contacting that origin', async () => {
    const server = new FakeGitHub()
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues`) {
        return {
          json: [server.issueRecord(managedReport(1317, DATE, RUN_ID))],
          headers: {link: '<https://evil.example/repos/owner/repo/issues?page=2>; rel="next"'},
        }
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('pagination_origin_mismatch')
    expect(server.requests.some(request => request.host === 'evil.example')).toBe(false)
  })
})

describe('reconcile-autoheal-reports: ambiguous write recovery', () => {
  it('continues when an ambiguous supersession-comment POST is proven by marker readback', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1300/comments`) {
        server.comments.push({
          id: 99991,
          issueNumber: 1300,
          body: supersessionMarker(1317),
          login: BOT_LOGIN,
          userId: BOT_ID,
        })
        return {networkError: 'connection reset'}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.commented).toBe(1)
    expect(summary.closed).toBe(1)
    expect(
      server.mutations.filter(request => request.method === 'POST' && request.path.endsWith('/comments')),
    ).toHaveLength(1)
  })

  it('aborts when an ambiguous supersession-comment POST is not proven', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1300/comments`) {
        return {networkError: 'connection reset'}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('comment_create_ambiguous')
    expect(summary.closed).toBe(0)
    expect(
      server.mutations.filter(request => request.method === 'POST' && request.path.endsWith('/comments')),
    ).toHaveLength(1)
  })

  it('continues when an ambiguous close PATCH is proven by issue readback', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.override = request => {
      if (request.method === 'PATCH' && request.path === `/repos/${REPO}/issues/1300`) {
        const issue = server.issues.find(candidate => candidate.number === 1300)
        if (issue !== undefined) issue.state = 'closed'
        return {networkError: 'connection reset'}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.closed).toBe(1)
  })

  it('aborts when an ambiguous close PATCH is not proven', async () => {
    const server = new FakeGitHub()
    server.issues = [managedReport(1317, DATE, RUN_ID), managedReport(1300, '2026-09-10', OTHER_RUN_ID)]
    server.override = request => {
      if (request.method === 'PATCH' && request.path === `/repos/${REPO}/issues/1300`) {
        return {networkError: 'connection reset'}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('close_ambiguous')
    expect(summary.closed).toBe(0)
  })
})

describe('reconcile-autoheal-reports: label creation ambiguity', () => {
  it('continues when an ambiguous label-creation POST is proven by bounded readback', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/labels`) {
        server.labelExists = true
        return {networkError: 'connection reset'}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(
      server.mutations.filter(request => request.method === 'POST' && request.path === `/repos/${REPO}/labels`),
    ).toHaveLength(1)
  })

  it('aborts with a specific safe code when an ambiguous label-creation POST is not proven', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/labels`) {
        return {networkError: 'connection reset'}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_create_ambiguous')
    expect(
      server.mutations.filter(request => request.method === 'POST' && request.path === `/repos/${REPO}/labels`),
    ).toHaveLength(1)
    expect(server.mutations.some(request => request.method === 'PATCH')).toBe(false)
  })
})

describe('reconcile-autoheal-reports: final proof heading contract', () => {
  it('fails final proof when the canonical heading contract changes after validation', async () => {
    const server = new FakeGitHub()
    const canonical = managedReport(1317, DATE, RUN_ID)
    server.issues = [canonical]
    let listCalls = 0
    server.override = request => {
      if (request.method === 'GET' && request.path === `/repos/${REPO}/issues`) {
        listCalls += 1
        if (listCalls === 3) {
          return {
            json: [{...server.issueRecord(canonical), body: canonical.body.replace('### Security', '### security')}],
          }
        }
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('final_proof_failed')
  })
})

// ─── Mutation rate-limit recovery (403/429) ──────────────────────────────────

describe('reconcile-autoheal-reports: label creation rate-limit recovery', () => {
  it('recovers a guided 403/429 by proving absence and retrying exactly once', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    let creates = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/labels`) {
        creates += 1
        if (creates === 1) return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(creates).toBe(2)
    expect(server.labelExists).toBe(true)
  })

  it('continues without retry when the readback already proves the created label', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    let creates = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/labels`) {
        creates += 1
        server.labelExists = true
        return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(creates).toBe(1)
  })

  it('fails closed without a duplicate write when the 403 carries no usable guidance', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    let creates = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/labels`) {
        creates += 1
        return {status: 403, json: {message: 'forbidden'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_create_rate_limited')
    expect(creates).toBe(1)
  })

  it('fails closed when the guided retry is still rate limited', async () => {
    const server = new FakeGitHub()
    server.labelExists = false
    server.issues = [managedReport(1317, DATE, RUN_ID)]
    let creates = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/labels`) {
        creates += 1
        return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_create_rate_limited')
    expect(creates).toBe(2)
  })
})

describe('reconcile-autoheal-reports: canonical label adoption rate-limit recovery', () => {
  it('recovers a guided 429 by proving absence and retrying exactly once', async () => {
    const server = new FakeGitHub()
    server.issues = [adoptableReport(1317, DATE, RUN_ID)]
    let applies = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1317/labels`) {
        applies += 1
        if (applies === 1) return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.adopted).toBe(1)
    expect(applies).toBe(2)
    expect(server.issues.find(issue => issue.number === 1317)?.labels).toContain(LABEL_NAME)
  })

  it('continues without retry when the readback already proves the adopted label', async () => {
    const server = new FakeGitHub()
    server.issues = [adoptableReport(1317, DATE, RUN_ID)]
    let applies = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1317/labels`) {
        applies += 1
        const issue = server.issues.find(candidate => candidate.number === 1317)
        if (issue !== undefined && !issue.labels.includes(LABEL_NAME)) issue.labels.push(LABEL_NAME)
        return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(applies).toBe(1)
  })

  it('fails closed without a duplicate write when guidance is absent', async () => {
    const server = new FakeGitHub()
    server.issues = [adoptableReport(1317, DATE, RUN_ID)]
    let applies = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1317/labels`) {
        applies += 1
        return {status: 403, json: {message: 'forbidden'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('label_apply_rate_limited')
    expect(applies).toBe(1)
  })
})

describe('reconcile-autoheal-reports: supersession comment rate-limit recovery', () => {
  it('continues without resending when the marker readback proves the guided 429 write', async () => {
    const server = supersessionFixture()
    let commentPosts = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1300/comments`) {
        commentPosts += 1
        server.comments.push({
          id: 70001,
          issueNumber: 1300,
          body: supersessionMarker(1317),
          login: BOT_LOGIN,
          userId: BOT_ID,
        })
        return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.commented).toBe(1)
    expect(summary.closed).toBe(1)
    expect(commentPosts).toBe(1)
  })

  it('fails closed without resending the non-idempotent write when guidance is absent', async () => {
    const server = supersessionFixture()
    let commentPosts = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1300/comments`) {
        commentPosts += 1
        return {status: 403, json: {message: 'forbidden'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('comment_create_rate_limited')
    expect(commentPosts).toBe(1)
    expect(server.comments.filter(comment => comment.issueNumber === 1300)).toHaveLength(0)
    expect(summary.closed).toBe(0)
  })

  it('retries the comment POST exactly once when guided and unproven, then succeeds', async () => {
    const server = supersessionFixture()
    let commentPosts = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1300/comments`) {
        commentPosts += 1
        if (commentPosts === 1) return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.commented).toBe(1)
    expect(summary.closed).toBe(1)
    expect(commentPosts).toBe(2)
  })

  it('fails closed after exactly one resend when the guided 429 persists', async () => {
    const server = supersessionFixture()
    let commentPosts = 0
    server.override = request => {
      if (request.method === 'POST' && request.path === `/repos/${REPO}/issues/1300/comments`) {
        commentPosts += 1
        return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('comment_create_rate_limited')
    expect(commentPosts).toBe(2)
    expect(server.comments.filter(comment => comment.issueNumber === 1300)).toHaveLength(0)
    expect(summary.commented).toBe(0)
    expect(summary.closed).toBe(0)
  })
})

describe('reconcile-autoheal-reports: issue closure rate-limit recovery', () => {
  it('continues without resending when the issue readback proves the guided 429 close', async () => {
    const server = closureFixture()
    let patches = 0
    server.override = request => {
      if (request.method === 'PATCH' && request.path === `/repos/${REPO}/issues/1300`) {
        patches += 1
        const issue = server.issues.find(candidate => candidate.number === 1300)
        if (issue !== undefined) issue.state = 'closed'
        return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.closed).toBe(1)
    expect(patches).toBe(1)
  })

  it('fails closed without resending the close when guidance is absent', async () => {
    const server = closureFixture()
    let patches = 0
    server.override = request => {
      if (request.method === 'PATCH' && request.path === `/repos/${REPO}/issues/1300`) {
        patches += 1
        return {status: 403, json: {message: 'forbidden'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('close_rate_limited')
    expect(patches).toBe(1)
    expect(summary.closed).toBe(0)
  })

  it('retries the close PATCH exactly once after network ambiguity and succeeds', async () => {
    const server = closureFixture()
    let patches = 0
    server.override = request => {
      if (request.method === 'PATCH' && request.path === `/repos/${REPO}/issues/1300`) {
        patches += 1
        if (patches === 1) return {networkError: 'connection reset'}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.closed).toBe(1)
    expect(patches).toBe(2)
  })

  it('retries the close PATCH exactly once after a guided 429 and succeeds', async () => {
    const server = closureFixture()
    let patches = 0
    server.override = request => {
      if (request.method === 'PATCH' && request.path === `/repos/${REPO}/issues/1300`) {
        patches += 1
        if (patches === 1) return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('succeeded')
    expect(summary.closed).toBe(1)
    expect(patches).toBe(2)
  })

  it('fails closed after exactly one resend when the guided 429 persists', async () => {
    const server = closureFixture()
    let patches = 0
    server.override = request => {
      if (request.method === 'PATCH' && request.path === `/repos/${REPO}/issues/1300`) {
        patches += 1
        return {status: 429, headers: {'retry-after': '0'}, json: {message: 'rate limited'}}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('close_rate_limited')
    expect(patches).toBe(2)
    expect(summary.closed).toBe(0)
  })

  it('fails closed after exactly one resend when the retried close is ambiguous', async () => {
    const server = closureFixture()
    let patches = 0
    server.override = request => {
      if (request.method === 'PATCH' && request.path === `/repos/${REPO}/issues/1300`) {
        patches += 1
        return {networkError: 'connection reset'}
      }
      return undefined
    }

    const summary = await reconcileAutohealReports(options(server))

    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('close_ambiguous')
    expect(patches).toBe(2)
    expect(summary.closed).toBe(0)
  })
})

// ─── Entrypoint regression (hermetic, no inherited secrets) ───────────────────

describe('reconcile-autoheal-reports: entrypoint regression', () => {
  it('emits exactly one body-free aborted missing_env summary with a nonzero exit', async () => {
    const scriptPath = new URL('./reconcile-autoheal-reports.ts', import.meta.url).pathname
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      GH_TOKEN: undefined,
      GITHUB_REPOSITORY: undefined,
      AUTOHEAL_DATE: undefined,
      AUTOHEAL_RUN_ID: undefined,
    }
    const proc = Bun.spawn({
      cmd: [process.execPath, scriptPath],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    const lines = stdout.split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(1)
    const summary = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(summary.status).toBe('aborted')
    expect(summary.failure_code).toBe('missing_env')
    expect(summary.phase).toBe('init')
    expect(Object.keys(summary).sort()).toEqual(
      [
        'adopted',
        'canonical_issue_id',
        'canonical_issue_number',
        'closed',
        'commented',
        'eligible',
        'failure_code',
        'failure_reason',
        'final_open_managed',
        'phase',
        'status',
        'untrusted_collisions',
        'workflow_run_id',
      ].sort(),
    )
    expect(stdout).not.toContain('Bearer')
    expect(exitCode).not.toBe(0)
  })
})
