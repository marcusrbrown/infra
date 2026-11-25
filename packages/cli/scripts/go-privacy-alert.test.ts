/// <reference types="bun" />

/**
 * Behavior contract for the OpenCode Go privacy refresh alert.
 *
 * `gh` and `fetch` are injected fakes, so no test reaches GitHub or Discord. The fake GitHub keeps real state
 * (labels, issues) and honours the `state` and `labels` query of the list call, so a test that expects an old
 * closed issue to be ignored proves the query, not only the filter.
 */

import type {FetchLike} from './deploy-gate-notify'
import type {GhResult, GhRunner, RestrictionPlan} from './go-privacy-alert'
import {describe, expect, it} from 'bun:test'
import {
  ALERT_LABEL,
  buildDiscordContent,
  buildRestrictionContent,
  planAlert,
  planRestriction,
  readAlertEnv,
  readRestrictionEnv,
  REAL_MARKER,
  REHEARSAL_MARKER,
  runIssueStep,
  runNotifyStep,
  runRestrictionStep,
} from './go-privacy-alert'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WEBHOOK = 'https://discord.example/api/webhooks/1234567890/SECRET-token_value'
const REPO = 'marcusrbrown/infra'
const RUN_URL = 'https://github.com/marcusrbrown/infra/actions/runs/9876543210'
const RUNBOOK_URL =
  'https://github.com/marcusrbrown/infra/blob/main/docs/runbooks/cliproxy-opencode-go.md#the-scheduled-refresh-is-failing'

function details(result: string, prefix = '- '): string[] {
  return [
    `${prefix}Workflow: OpenCode Go Privacy`,
    `${prefix}Run: ${RUN_URL}`,
    `${prefix}Refresh job result: ${result}`,
    `${prefix}Runbook: ${RUNBOOK_URL}`,
  ]
}

/** The detail lines of a Discord message: the issue link sits before the runbook. */
function discordDetails(result: string, issue: number): string[] {
  const [workflow, run, outcome, runbook] = details(result, '')
  return [workflow ?? '', run ?? '', outcome ?? '', `Issue: https://github.com/${REPO}/issues/${issue}`, runbook ?? '']
}

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '9876543210',
    GITHUB_WORKFLOW: 'OpenCode Go Privacy',
    GITHUB_ACTOR: 'marcusrbrown',
    GITHUB_REPOSITORY_OWNER: 'marcusrbrown',
    ALERT_REFRESH_RESULT: 'failure',
    ALERT_REHEARSE: 'none',
    ALERT_RUN_ATTEMPT: '1',
    ...overrides,
  }
}

interface FakeIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: string[]
  pull_request?: unknown
}

interface GhCall {
  readonly args: readonly string[]
  readonly stdin: string | undefined
  readonly method: string
}

interface FakeGhOptions {
  readonly labels?: readonly string[]
  /** Return a failing result for a call to make an API call fail; otherwise the fake answers. */
  readonly fail?: (call: GhCall) => GhResult | undefined
}

function fakeGh(initial: FakeIssue[], options: FakeGhOptions = {}) {
  const issues = [...initial]
  const labels = new Set(options.labels ?? [])
  const calls: GhCall[] = []
  let nextNumber = Math.max(100, ...issues.map(issue => issue.number + 1))
  let nextId = 5000

  const ok = (stdout: string): GhResult => ({code: 0, stdout, stderr: ''})

  const gh: GhRunner = async (args, stdin) => {
    const methodIndex = args.indexOf('--method')
    const method = methodIndex === -1 ? 'GET' : (args[methodIndex + 1] ?? 'GET')
    const call: GhCall = {args, stdin, method}
    calls.push(call)
    const forced = options.fail?.(call)
    if (forced !== undefined) return forced

    const path = args.at(-1) ?? ''
    const body = stdin === undefined ? {} : (JSON.parse(stdin) as Record<string, unknown>)

    if (method === 'GET' && args.includes('--paginate')) {
      const query = new URLSearchParams(path.split('?')[1] ?? '')
      const state = query.get('state') ?? 'open'
      const label = query.get('labels')
      const matched = issues.filter(
        issue => (state === 'all' || issue.state === state) && (label === null || issue.labels.includes(label)),
      )
      // Two issues per page, slurped: the script must flatten the pages.
      const pages: FakeIssue[][] = []
      for (let index = 0; index < matched.length; index += 2) pages.push(matched.slice(index, index + 2))
      return ok(JSON.stringify(pages.length === 0 ? [[]] : pages.map(page => page.map(toApiIssue))))
    }
    const labelProbe = /^repos\/[^/]+\/[^/]+\/labels\/(.+)$/.exec(path)
    if (method === 'GET' && labelProbe !== null) {
      const exists = labels.has(decodeURIComponent(labelProbe[1] ?? ''))
      return exists
        ? ok('HTTP/2.0 200 OK\n')
        : {code: 1, stdout: 'HTTP/2.0 404 Not Found\n', stderr: 'gh: Not Found (HTTP 404)'}
    }
    if (method === 'POST' && /\/labels$/.test(path)) {
      labels.add(String(body.name))
      return ok(JSON.stringify({id: nextId++, name: body.name}))
    }
    if (method === 'POST' && /\/issues$/.test(path)) {
      const number = nextNumber++
      issues.push({
        number,
        title: String(body.title),
        body: String(body.body),
        state: 'open',
        labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
      })
      return ok(
        JSON.stringify({number, id: nextId++, state: 'open', html_url: `https://github.com/${REPO}/issues/${number}`}),
      )
    }
    const comment = /\/issues\/(\d+)\/comments$/.exec(path)
    if (method === 'POST' && comment !== null) {
      return ok(
        JSON.stringify({id: nextId++, html_url: `https://github.com/${REPO}/issues/${comment[1]}#issuecomment-1`}),
      )
    }
    const patch = /\/issues\/(\d+)$/.exec(path)
    if (method === 'PATCH' && patch !== null) {
      const issue = issues.find(candidate => candidate.number === Number(patch[1]))
      if (issue === undefined) return {code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)'}
      issue.state = body.state === 'closed' ? 'closed' : 'open'
      return ok(JSON.stringify({number: issue.number, state: issue.state}))
    }
    return {code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}`}
  }

  return {
    gh,
    calls,
    issues,
    labels,
    writes: () => calls.filter(call => call.method !== 'GET'),
    /** Every JSON payload sent to GitHub, as text. */
    payloads: () => calls.flatMap(call => (call.stdin === undefined ? [] : [call.stdin])),
    comments: () =>
      calls
        .filter(call => /\/comments$/.test(call.args.at(-1) ?? ''))
        .map(call => ({
          issue: Number(/issues\/(\d+)\/comments$/.exec(call.args.at(-1) ?? '')?.[1]),
          body: String((JSON.parse(call.stdin ?? '{}') as {body?: unknown}).body),
        })),
  }
}

function toApiIssue(issue: FakeIssue): unknown {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(name => ({name})),
    ...(issue.pull_request === undefined ? {} : {pull_request: issue.pull_request}),
  }
}

function realIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number: 7,
    title: 'OpenCode Go privacy refresh is failing',
    body: `${REAL_MARKER}\nolder text`,
    state: 'open',
    labels: [ALERT_LABEL],
    ...overrides,
  }
}

function rehearsalIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return realIssue({
    number: 8,
    title: '[Rehearsal] OpenCode Go privacy refresh alert',
    body: `${REHEARSAL_MARKER}\nolder rehearsal`,
    ...overrides,
  })
}

interface IssueRun {
  readonly exitCode: number
  readonly outputs: Record<string, string>
  readonly logs: string[]
}

async function issueStep(
  overrides: Record<string, string | undefined>,
  fake: ReturnType<typeof fakeGh>,
): Promise<IssueRun> {
  const outputs: Record<string, string> = {}
  const logs: string[] = []
  const result = await runIssueStep(baseEnv(overrides), {
    gh: fake.gh,
    writeOutput: (name, value) => {
      outputs[name] = value
    },
    log: line => logs.push(line),
    appendSummary: line => logs.push(line),
  })
  return {exitCode: result.exitCode, outputs, logs}
}

interface Delivery {
  readonly calls: {url: string; body: string}[]
  readonly logs: string[]
  readonly sleeps: number[]
}

type Responder = (call: number, signal: AbortSignal | undefined) => Promise<Response> | Response

async function notifyStep(
  overrides: Record<string, string | undefined>,
  responder: Responder = () => new Response(null, {status: 204}),
): Promise<Delivery & {summary: Awaited<ReturnType<typeof runNotifyStep>>}> {
  const calls: {url: string; body: string}[] = []
  const logs: string[] = []
  const sleeps: number[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({url: String(input), body: String(init?.body ?? '')})
    return responder(calls.length, init?.signal ?? undefined)
  }
  const summary = await runNotifyStep(
    baseEnv({
      ALERT_NOTIFY: 'created',
      ALERT_ISSUE_NUMBER: '101',
      CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: WEBHOOK,
      ...overrides,
    }),
    {
      fetch: fetchImpl,
      sleep: async ms => {
        sleeps.push(ms)
      },
      log: line => logs.push(line),
      appendSummary: line => logs.push(line),
      timeoutMs: 20,
    },
  )
  return {calls, logs, sleeps, summary}
}

// ─── Decision ────────────────────────────────────────────────────────────────

describe('planAlert', () => {
  it.each([
    ['failure', {kind: 'alert', identity: 'real'}],
    ['cancelled', {kind: 'alert', identity: 'real'}],
    ['success', {kind: 'clear', identity: 'real'}],
    ['skipped', {kind: 'none'}],
  ] as const)('maps a %s refresh to %j', (result, expected) => {
    expect(planAlert({refreshResult: result, rehearse: 'none'})).toEqual(expected)
  })

  it('ignores the real result in a rehearsal and uses the rehearsal identity', () => {
    for (const result of ['failure', 'cancelled', 'success', 'skipped'] as const) {
      expect(planAlert({refreshResult: result, rehearse: 'fail'})).toEqual({kind: 'alert', identity: 'rehearsal'})
      expect(planAlert({refreshResult: result, rehearse: 'clear'})).toEqual({kind: 'clear', identity: 'rehearsal'})
    }
  })
})

describe('readAlertEnv', () => {
  it('treats an empty rehearsal input (a scheduled run) as none', () => {
    expect(readAlertEnv(baseEnv({ALERT_REHEARSE: ''})).rehearse).toBe('none')
    expect(readAlertEnv(baseEnv({ALERT_REHEARSE: undefined})).rehearse).toBe('none')
  })

  it('rejects a result or rehearsal value outside the known sets rather than guessing', () => {
    expect(() => readAlertEnv(baseEnv({ALERT_REFRESH_RESULT: 'timed_out'}))).toThrow()
    expect(() => readAlertEnv(baseEnv({ALERT_REFRESH_RESULT: ''}))).toThrow()
    expect(() => readAlertEnv(baseEnv({ALERT_REHEARSE: 'maybe'}))).toThrow()
  })

  it('reads the first attempt only from the exact value 1, and anything else as a re-run', () => {
    expect(readAlertEnv(baseEnv({ALERT_RUN_ATTEMPT: '1'})).attempt).toBe('first')
    expect(readAlertEnv(baseEnv({ALERT_RUN_ATTEMPT: '2'})).attempt).toBe('rerun')
    expect(readAlertEnv(baseEnv({ALERT_RUN_ATTEMPT: '12'})).attempt).toBe('rerun')
    for (const bad of [undefined, '', 'x', '0', '-1', '1.0', '2x']) {
      expect(readAlertEnv(baseEnv({ALERT_RUN_ATTEMPT: bad})).attempt).toBe('invalid')
    }
  })

  it('requires the repository and run id, since an alert without a run link is no use', () => {
    expect(() => readAlertEnv(baseEnv({GITHUB_RUN_ID: ''}))).toThrow()
    expect(() => readAlertEnv(baseEnv({GITHUB_REPOSITORY: ''}))).toThrow()
  })
})

// ─── Issue step ──────────────────────────────────────────────────────────────

describe('issue step: failure', () => {
  it('creates one labelled, marked issue on the first failing run and asks for one Discord message', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.issues).toHaveLength(1)
    expect(fake.issues[0]?.labels).toEqual([ALERT_LABEL])
    expect(fake.issues[0]?.body?.startsWith(`${REAL_MARKER}\n`)).toBe(true)
    expect(fake.issues[0]?.title).toBe('OpenCode Go privacy refresh is failing')
    expect(run.outputs).toEqual({notify: 'created', 'issue-number': '100'})
  })

  it('writes this exact issue body', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    await issueStep({}, fake)

    expect(fake.issues[0]?.body).toBe(
      [
        REAL_MARKER,
        'The scheduled refresh of the OpenCode Go privacy snapshot failed. Until a refresh succeeds the snapshot cannot change, so a model whose terms upstream has tightened stays exposed. Check upstream now: see "The scheduled refresh is failing" in the runbook.',
        '',
        ...details('failure'),
        '',
        'This issue closes when a refresh succeeds.',
      ].join('\n'),
    )
  })

  it('treats a cancelled refresh (the reported result of a timeout) like a failure', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'cancelled'}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.issues[0]?.body).toContain('- Refresh job result: cancelled')
  })

  it('comments on the open issue of the same outage and asks for no Discord message', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(fake.issues).toHaveLength(1)
    expect(fake.comments()).toEqual([
      {
        issue: 7,
        body: ['The refresh failed again.', '', ...details('failure')].join('\n'),
      },
    ])
    expect(run.outputs).toEqual({notify: 'none', 'issue-number': '7'})
    expect(fake.writes().map(call => call.method)).toEqual(['POST'])
  })

  it('does not treat a labelled issue without the marker as ours: it is ignored and ours is created', async () => {
    const stray = realIssue({number: 3, body: 'someone filed this by hand'})
    const fake = fakeGh([stray], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(fake.issues).toHaveLength(2)
    expect(run.outputs.notify).toBe('created')
    // The stray issue is untouched.
    expect(fake.comments().filter(comment => comment.issue === 3)).toEqual([])
    expect(fake.issues.find(issue => issue.number === 3)?.state).toBe('open')
  })

  it('does not treat a marked issue without the label as ours', async () => {
    const fake = fakeGh([realIssue({labels: []})], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.comments()).toEqual([])
  })

  it('does not treat a pull request carrying the marker as ours', async () => {
    const fake = fakeGh([realIssue({pull_request: {url: 'x'}})], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(run.outputs.notify).toBe('created')
  })

  it('does not reopen a closed issue from an earlier outage: it opens a new one', async () => {
    const fake = fakeGh([realIssue({state: 'closed'})], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(fake.issues).toHaveLength(2)
    expect(fake.issues.find(issue => issue.number === 7)?.state).toBe('closed')
    expect(run.outputs).toEqual({notify: 'created', 'issue-number': '100'})
    expect(fake.writes().some(call => call.method === 'PATCH')).toBe(false)
  })

  it('creates the label on first use when it does not exist', async () => {
    const fake = fakeGh([])
    await issueStep({}, fake)

    expect(fake.labels.has(ALERT_LABEL)).toBe(true)
    const methods = fake.writes().map(call => `${call.method} ${call.args.at(-1)}`)
    expect(methods).toEqual([`POST repos/${REPO}/labels`, `POST repos/${REPO}/issues`])
  })

  it('does not touch the label when an open issue exists', async () => {
    const fake = fakeGh([realIssue()])
    await issueStep({}, fake)

    expect(fake.calls.some(call => /\/labels\//.test(call.args.at(-1) ?? ''))).toBe(false)
  })

  it('fails the job when the issue API fails, so a broken alert path is a red run', async () => {
    const fake = fakeGh([], {
      labels: [ALERT_LABEL],
      fail: call => (call.method === 'POST' ? {code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 500)'} : undefined),
    })
    const run = await issueStep({}, fake)

    expect(run.exitCode).toBe(1)
    expect(run.outputs.notify ?? 'none').toBe('none')
    expect(run.logs.join('\n')).toContain('::error::')
    // The error line names the stage, never the GitHub response text.
    expect(run.logs.join('\n')).not.toContain('Server Error')
  })

  it('fails the job when the list call fails or returns malformed JSON', async () => {
    const down = await issueStep(
      {},
      fakeGh([], {
        fail: call => (call.args.includes('--paginate') ? {code: 1, stdout: '', stderr: 'boom'} : undefined),
      }),
    )
    expect(down.exitCode).toBe(1)

    const garbage = await issueStep(
      {},
      fakeGh([], {
        fail: call => (call.args.includes('--paginate') ? {code: 0, stdout: 'not json', stderr: ''} : undefined),
      }),
    )
    expect(garbage.exitCode).toBe(1)
  })

  // A listing entry that is not exactly what the script reads must fail the whole lookup: an empty-array guess for a
  // missing `labels` would hide an open alert issue, and the run would open a duplicate.
  describe('a malformed issue listing takes no action', () => {
    const valid = toApiIssue(realIssue()) as Record<string, unknown>
    const without = (field: string): Record<string, unknown> => {
      const {[field]: _removed, ...rest} = valid
      return rest
    }
    const listing = (entry: unknown) =>
      fakeGh([], {
        labels: [ALERT_LABEL],
        fail: call =>
          call.args.includes('--paginate') ? {code: 0, stdout: JSON.stringify([[entry]]), stderr: ''} : undefined,
      })

    it.each([
      ['labels missing', without('labels')],
      ['labels null', {...valid, labels: null}],
      ['labels a string', {...valid, labels: ALERT_LABEL}],
      ['labels an object', {...valid, labels: {name: ALERT_LABEL}}],
      ['a label entry without a name', {...valid, labels: [{}]}],
      ['a label entry that is a bare string', {...valid, labels: [ALERT_LABEL]}],
      ['a label name that is not a string', {...valid, labels: [{name: 5}]}],
      ['a label entry that is null', {...valid, labels: [null]}],
      ['number missing', without('number')],
      ['number a string', {...valid, number: '7'}],
      ['number a fraction', {...valid, number: 7.5}],
      ['state missing', without('state')],
      ['state a number', {...valid, state: 1}],
      ['body missing', without('body')],
      ['body a number', {...valid, body: 5}],
      ['pull_request a string', {...valid, pull_request: 'x'}],
      ['an entry that is not an object', 42],
      ['an entry that is null', null],
    ])('fails the lookup and writes nothing when %s', async (_name, entry) => {
      for (const result of ['failure', 'success']) {
        const fake = listing(entry)
        const run = await issueStep({ALERT_REFRESH_RESULT: result}, fake)

        expect(run.exitCode).toBe(1)
        expect(run.outputs).toEqual({notify: 'none'})
        expect(fake.writes()).toEqual([])
        // The list call is the only call: no label probe either.
        expect(fake.calls).toHaveLength(1)
        expect(run.logs.join('\n')).toContain('github-api:list-issues-malformed')
      }
    })

    it('still reads what GitHub really sends: a null body and a null pull_request', async () => {
      const fake = listing({...valid, body: null, pull_request: null})
      const run = await issueStep({}, fake)

      expect(run.exitCode).toBe(0)
      // A null body has no marker, so the entry is not ours and ours is created beside it.
      expect(run.outputs.notify).toBe('created')
    })
  })

  it('writes notify=none when any step fails, so the Discord step has an explicit value', async () => {
    const run = await issueStep(
      {},
      fakeGh([], {
        fail: call => (call.args.includes('--paginate') ? {code: 1, stdout: '', stderr: 'boom'} : undefined),
      }),
    )
    expect(run.exitCode).toBe(1)
    expect(run.outputs).toEqual({notify: 'none'})
  })

  it('fails the job when the create response lacks an issue number', async () => {
    const fake = fakeGh([], {
      labels: [ALERT_LABEL],
      fail: call =>
        call.method === 'POST' && /\/issues$/.test(call.args.at(-1) ?? '')
          ? {code: 0, stdout: '{}', stderr: ''}
          : undefined,
    })
    expect((await issueStep({}, fake)).exitCode).toBe(1)
  })

  it('fails the job when the label probe returns neither success nor 404', async () => {
    const fake = fakeGh([], {
      fail: call =>
        /\/labels\//.test(call.args.at(-1) ?? '')
          ? {code: 1, stdout: 'HTTP/2.0 403 Forbidden\n', stderr: ''}
          : undefined,
    })
    const run = await issueStep({}, fake)

    expect(run.exitCode).toBe(1)
    expect(fake.writes()).toEqual([])
  })
})

describe('issue step: success', () => {
  it('comments, closes and asks for one recovery message when an alert issue is open', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'success'}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.comments()).toEqual([
      {
        issue: 7,
        body: ['The refresh succeeded, so this issue is closed.', '', ...details('success')].join('\n'),
      },
    ])
    expect(fake.issues[0]?.state).toBe('closed')
    expect(run.outputs).toEqual({notify: 'recovered', 'issue-number': '7'})
    // Comment first, so the issue never closes without the run link.
    expect(fake.writes().map(call => call.method)).toEqual(['POST', 'PATCH'])
  })

  it('does nothing, and calls nothing that writes, when no alert issue is open', async () => {
    const fake = fakeGh([realIssue({state: 'closed'}), rehearsalIssue({state: 'closed'})], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'success'}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.writes()).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })

  it('does nothing when only an unmarked labelled issue is open', async () => {
    const fake = fakeGh([realIssue({body: 'by hand'})], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'success'}, fake)

    expect(fake.writes()).toEqual([])
    expect(run.outputs.notify).toBe('none')
  })

  it('closes every open marked issue of an outage that somehow got two, with one recovery request', async () => {
    const fake = fakeGh([realIssue({number: 7}), realIssue({number: 9})], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'success'}, fake)

    expect(fake.issues.map(issue => issue.state)).toEqual(['closed', 'closed'])
    expect(run.outputs.notify).toBe('recovered')
    expect(run.outputs['issue-number']).toBe('7')
  })

  it('leaves an open rehearsal issue alone: only the explicit clear closes it', async () => {
    const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'success'}, fake)

    expect(fake.issues[0]?.state).toBe('open')
    expect(fake.writes()).toEqual([])
    expect(run.outputs.notify).toBe('none')
  })

  it('still emits the recovery request when it closes a real issue beside an open rehearsal issue', async () => {
    const fake = fakeGh([rehearsalIssue(), realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'success'}, fake)

    expect(fake.issues.find(issue => issue.number === 7)?.state).toBe('closed')
    expect(fake.issues.find(issue => issue.number === 8)?.state).toBe('open')
    expect(fake.comments().map(comment => comment.issue)).toEqual([7])
    expect(run.outputs).toEqual({notify: 'recovered', 'issue-number': '7'})
  })

  it('fails the job when the close is not confirmed by the response', async () => {
    const fake = fakeGh([realIssue()], {
      labels: [ALERT_LABEL],
      fail: call =>
        call.method === 'PATCH' ? {code: 0, stdout: '{"number":7,"state":"open"}', stderr: ''} : undefined,
    })
    expect((await issueStep({ALERT_REFRESH_RESULT: 'success'}, fake)).exitCode).toBe(1)
  })
})

// A re-run replays the first attempt's `needs.refresh.result`, which can be older than the current outage. A re-run
// therefore never reconciles anything: the capability is deleted, not guarded by a freshness check.
describe('issue step: a re-run never updates the alert', () => {
  const LOG_LINE = '::notice::A re-run does not update the OpenCode Go privacy alert. Dispatch a fresh refresh instead.'

  it('does not close a newer outage on a replayed success, makes no API call and requests no notification', async () => {
    // Monday's refresh succeeded but its alert job failed. Tuesday's refresh failed and opened this issue. Someone
    // re-runs Monday's failed job: attempt 2, still reading Monday's success.
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'success', ALERT_RUN_ATTEMPT: '2'}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.calls).toEqual([])
    expect(fake.issues[0]?.state).toBe('open')
    expect(run.outputs).toEqual({notify: 'none'})
    expect(run.logs).toContain(LOG_LINE)
  })

  it.each(['failure', 'cancelled'] as const)(
    'neither opens nor comments on a replayed %s, in either direction',
    async result => {
      const empty = fakeGh([], {labels: [ALERT_LABEL]})
      const created = await issueStep({ALERT_REFRESH_RESULT: result, ALERT_RUN_ATTEMPT: '2'}, empty)
      expect(empty.calls).toEqual([])
      expect(empty.issues).toEqual([])
      expect(created.outputs).toEqual({notify: 'none'})

      const open = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
      await issueStep({ALERT_REFRESH_RESULT: result, ALERT_RUN_ATTEMPT: '3'}, open)
      expect(open.calls).toEqual([])
    },
  )

  it('applies to rehearsals too: a replayed rehearsal dispatch makes no API call', async () => {
    for (const rehearse of ['fail', 'clear']) {
      const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL]})
      const run = await issueStep({ALERT_REHEARSE: rehearse, ALERT_RUN_ATTEMPT: '2'}, fake)

      expect(run.exitCode).toBe(0)
      expect(fake.calls).toEqual([])
      expect(run.outputs).toEqual({notify: 'none'})
    }
  })

  it('leaves the first attempt unchanged', async () => {
    const failing = fakeGh([], {labels: [ALERT_LABEL]})
    expect((await issueStep({ALERT_RUN_ATTEMPT: '1'}, failing)).outputs.notify).toBe('created')

    const recovering = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'success', ALERT_RUN_ATTEMPT: '1'}, recovering)
    expect(run.outputs.notify).toBe('recovered')
    expect(recovering.issues[0]?.state).toBe('closed')
    expect(run.logs.join('\n')).not.toContain('re-run')
  })

  it.each([undefined, '', '  ', 'two', '1.5', '-1', '0', '1e3', '01x', '99999'])(
    'treats the attempt value %j as a re-run: it does nothing and says so',
    async attempt => {
      const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
      const run = await issueStep({ALERT_REFRESH_RESULT: 'success', ALERT_RUN_ATTEMPT: attempt}, fake)

      expect(run.exitCode).toBe(0)
      expect(fake.calls).toEqual([])
      expect(run.outputs).toEqual({notify: 'none'})
      expect(run.logs.some(line => line.startsWith('::warning::The run attempt value is missing or invalid'))).toBe(
        true,
      )
    },
  )
})

describe('issue step: skipped', () => {
  it('does nothing and makes no API call at all', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REFRESH_RESULT: 'skipped'}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.calls).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })
})

describe('issue step: rehearsal', () => {
  it('is owner-only and refuses before any API call', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'fail', GITHUB_ACTOR: 'someone-else'}, fake)

    expect(run.exitCode).toBe(1)
    expect(fake.calls).toEqual([])
  })

  it('opens a marked rehearsal issue under its own marker, whatever the real refresh did', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'fail', ALERT_REFRESH_RESULT: 'skipped'}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.issues[0]?.title).toBe('[Rehearsal] OpenCode Go privacy refresh alert')
    expect(fake.issues[0]?.body?.startsWith(`${REHEARSAL_MARKER}\n`)).toBe(true)
    expect(fake.issues[0]?.body).not.toContain(REAL_MARKER)
    expect(fake.issues[0]?.body).toContain('Rehearsal')
    expect(fake.issues[0]?.body).toContain('- Refresh job result: failure (rehearsal; no refresh ran)')
  })

  it('never lets an open rehearsal issue absorb a real failure', async () => {
    const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.comments()).toEqual([])
  })

  it('comments on an open rehearsal issue when rehearsed again, without another Discord message', async () => {
    const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'fail'}, fake)

    expect(run.outputs).toEqual({notify: 'none', 'issue-number': '8'})
    expect(fake.comments()[0]?.body).toContain('Rehearsal')
  })

  it('closes the rehearsal issue on a clear rehearsal and leaves a real alert issue alone', async () => {
    const fake = fakeGh([rehearsalIssue(), realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'clear'}, fake)

    expect(fake.issues.find(issue => issue.number === 8)?.state).toBe('closed')
    expect(fake.issues.find(issue => issue.number === 7)?.state).toBe('open')
    expect(run.outputs).toEqual({notify: 'recovered', 'issue-number': '8'})
  })
})

// ─── Discord ─────────────────────────────────────────────────────────────────

describe('notify step', () => {
  it('posts nothing when no message was asked for', async () => {
    const run = await notifyStep({ALERT_NOTIFY: 'none'})

    expect(run.calls).toEqual([])
    expect(run.summary.outcome).toBe('skipped')
  })

  it('posts the failure message once, with mentions off and embeds suppressed', async () => {
    const run = await notifyStep({})

    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]?.url).toBe(WEBHOOK)
    const payload = JSON.parse(run.calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(payload.allowed_mentions).toEqual({parse: []})
    expect(payload.flags).toBe(4)
    expect(payload.content).toBe(
      [
        '**OpenCode Go privacy refresh failed**',
        'Until it succeeds the snapshot cannot change, so a model whose terms upstream has tightened stays exposed. Check upstream now.',
        ...discordDetails('failure', 101),
      ].join('\n'),
    )
    expect(run.summary.outcome).toBe('sent')
  })

  it('posts the recovery message', async () => {
    const run = await notifyStep({ALERT_NOTIFY: 'recovered', ALERT_REFRESH_RESULT: 'success', ALERT_ISSUE_NUMBER: '7'})

    const content = (JSON.parse(run.calls[0]?.body ?? '{}') as {content: string}).content
    expect(content).toBe(
      [
        '**OpenCode Go privacy refresh recovered**',
        'The refresh succeeded. The alert issue is closed.',
        ...discordDetails('success', 7),
      ].join('\n'),
    )
  })

  it('marks a rehearsal message', async () => {
    const run = await notifyStep({ALERT_REHEARSE: 'fail'})

    const content = (JSON.parse(run.calls[0]?.body ?? '{}') as {content: string}).content
    expect(content.startsWith('**[REHEARSAL] OpenCode Go privacy refresh failed**')).toBe(true)
    expect(content).toContain('Rehearsal: no refresh ran and nothing is wrong.')
  })

  it('skips with a log line, and does not fail, when the webhook is unset or blank', async () => {
    for (const webhook of [undefined, '', '   ']) {
      const run = await notifyStep({CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: webhook})
      expect(run.calls).toEqual([])
      expect(run.summary).toMatchObject({outcome: 'skipped', reason: 'webhook-unset'})
      expect(run.logs.join('\n')).toContain('skipped')
    }
  })

  it('retries a 429 and a 5xx, then reports the fixed reason without failing', async () => {
    const run = await notifyStep({}, () => new Response('upstream text', {status: 503}))

    expect(run.calls).toHaveLength(3)
    expect(run.summary).toMatchObject({outcome: 'failed', reason: 'http-503'})
    expect(run.logs.some(line => line.startsWith('::warning::'))).toBe(true)
  })

  it('does not retry a client error', async () => {
    const run = await notifyStep({}, () => new Response('nope', {status: 404}))

    expect(run.calls).toHaveLength(1)
    expect(run.summary).toMatchObject({outcome: 'failed', reason: 'http-404'})
  })

  it('reports a network error and a timeout as fixed reasons, never as error text', async () => {
    const network = await notifyStep({}, () => {
      throw new TypeError(`connect ECONNREFUSED ${WEBHOOK}`)
    })
    expect(network.summary).toMatchObject({outcome: 'failed', reason: 'network'})

    const hung = await notifyStep({}, (_call, signal) => {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error(`aborted ${WEBHOOK}`)))
      })
    })
    expect(hung.summary).toMatchObject({outcome: 'failed', reason: 'timeout'})
  })

  it('never writes the webhook, the response text or an error message to any log line', async () => {
    const outcomes = [
      await notifyStep({}),
      await notifyStep({}, () => new Response(`echo ${WEBHOOK}`, {status: 500})),
      await notifyStep({}, () => {
        throw new TypeError(`connect ECONNREFUSED ${WEBHOOK}`)
      }),
      await notifyStep({CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: 'not a url'}),
    ]
    for (const run of outcomes) {
      const text = run.logs.join('\n')
      expect(text).not.toContain(WEBHOOK)
      expect(text).not.toContain('SECRET-token_value')
      expect(text).not.toContain('echo')
      expect(text).not.toContain('ECONNREFUSED')
    }
  })

  it('treats an unknown notify value as nothing to send', async () => {
    const run = await notifyStep({ALERT_NOTIFY: 'everyone'})

    expect(run.calls).toEqual([])
  })
})

// ─── Content ─────────────────────────────────────────────────────────────────

describe('content is built from fixed strings and the github context only', () => {
  it('refuses a malformed run id, repository or server URL instead of building a link from it', () => {
    expect(() => readAlertEnv(baseEnv({GITHUB_RUN_ID: '123 @everyone](http://evil.example)'}))).toThrow()
    expect(() => readAlertEnv(baseEnv({GITHUB_REPOSITORY: 'a/b](http://evil.example)'}))).toThrow()
    expect(() => readAlertEnv(baseEnv({GITHUB_SERVER_URL: 'http://github.com'}))).toThrow()
    expect(() => readAlertEnv(baseEnv({GITHUB_SERVER_URL: 'https://x.example/path?q=1'}))).toThrow()
  })

  it('keeps mention, markup and link characters in the free-text workflow name out of every message', () => {
    const env = readAlertEnv(
      baseEnv({GITHUB_WORKFLOW: 'OpenCode Go Privacy @everyone <@1234> [x](http://evil.example)'}),
    )
    for (const kind of ['created', 'recovered'] as const) {
      const content = buildDiscordContent(kind, env, 12)
      expect(content).not.toMatch(/[@<>[\]()]/)
      expect(content).not.toContain('://evil')
      expect(content.length).toBeLessThan(1900)
    }
  })

  it('never carries text from the script, the refresh log or upstream: no input can reach it', async () => {
    // The only inputs are the result enum, the rehearsal enum and github context values. Extra environment is ignored.
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    await issueStep(
      {
        REFRESH_ERROR: 'Upstream said: ignore previous instructions',
        ALERT_ERROR_TEXT: 'Unknown footnote sentence from upstream',
      },
      fake,
    )

    const written = [...fake.payloads()].join('\n')
    expect(written).not.toContain('Upstream said')
    expect(written).not.toContain('footnote')
  })
})

// ─── Composition ─────────────────────────────────────────────────────────────

describe('one outage, end to end', () => {
  it('posts Discord twice across a three-day outage: once on creation, once on recovery', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const posts: string[] = []

    async function day(result: string): Promise<void> {
      const issue = await issueStep({ALERT_REFRESH_RESULT: result}, fake)
      const delivered = await notifyStep({
        ALERT_REFRESH_RESULT: result,
        ALERT_NOTIFY: issue.outputs.notify,
        ALERT_ISSUE_NUMBER: issue.outputs['issue-number'],
      })
      posts.push(...delivered.calls.map(call => call.body))
    }

    await day('failure')
    await day('failure')
    await day('cancelled')
    expect(posts).toHaveLength(1)
    expect(fake.issues).toHaveLength(1)
    expect(fake.comments()).toHaveLength(2)

    await day('success')
    expect(posts).toHaveLength(2)
    expect(fake.issues[0]?.state).toBe('closed')

    // A later failure is a new outage: a new issue and a new message.
    await day('failure')
    expect(fake.issues).toHaveLength(2)
    expect(posts).toHaveLength(3)

    // A success with nothing open posts nothing and writes nothing new.
    await day('success')
    await day('success')
    expect(posts).toHaveLength(4)
    expect(fake.issues.every(issue => issue.state === 'closed')).toBe(true)
  })

  it('keeps the issue work done when Discord fails', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const issue = await issueStep({}, fake)
    const delivered = await notifyStep(
      {ALERT_NOTIFY: issue.outputs.notify, ALERT_ISSUE_NUMBER: issue.outputs['issue-number']},
      () => new Response('', {status: 429}),
    )

    expect(issue.exitCode).toBe(0)
    expect(fake.issues).toHaveLength(1)
    expect(delivered.summary.outcome).toBe('failed')
  })
})

// ─── Restriction notice ──────────────────────────────────────────────────────

// A successful refresh whose PR takes away a model the proxy serves is time-sensitive: the model stays exposed until
// the PR merges and the gated deploy is approved. The notice is a Discord message only; it opens no issue.
describe('restriction notice', () => {
  const PR_URL = `https://github.com/${REPO}/pull/2085`
  const PULLS_URL = `https://github.com/${REPO}/pulls`
  const RESTRICTION_RUNBOOK_URL =
    'https://github.com/marcusrbrown/infra/blob/main/docs/runbooks/cliproxy-opencode-go.md#snapshot-refresh-pr-review'

  const restrictEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> =>
    baseEnv({
      ALERT_REFRESH_RESULT: 'success',
      ALERT_RESTRICTED: '2',
      ALERT_PR_URL: PR_URL,
      CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: WEBHOOK,
      ...overrides,
    })

  async function restrictStep(
    overrides: Record<string, string | undefined> = {},
    responder: Responder = () => new Response(null, {status: 204}),
  ) {
    const calls: {url: string; body: string}[] = []
    const logs: string[] = []
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({url: String(input), body: String(init?.body ?? '')})
      return responder(calls.length, init?.signal ?? undefined)
    }
    const summary = await runRestrictionStep(restrictEnv(overrides), {
      fetch: fetchImpl,
      sleep: async () => {},
      log: line => logs.push(line),
      appendSummary: line => logs.push(line),
      timeoutMs: 20,
    })
    const content = calls[0] === undefined ? undefined : (JSON.parse(calls[0].body) as {content: string}).content
    return {calls, logs, summary, content}
  }

  describe('decision table', () => {
    const real = (count: number, link: string): RestrictionPlan => ({kind: 'send', identity: 'real', count, link})

    it.each<[string, Record<string, string>, RestrictionPlan]>([
      // [name, env overrides, expected plan]
      ['restricted models and a valid PR', {}, real(2, PR_URL)],
      ['one restricted model', {ALERT_RESTRICTED: '1'}, real(1, PR_URL)],
      ['leading zeros read as a decimal', {ALERT_RESTRICTED: '007'}, real(7, PR_URL)],
      ['nothing restricted (zero)', {ALERT_RESTRICTED: '0'}, {kind: 'skip', reason: 'nothing-restricted'}],
      ['nothing restricted (output absent)', {ALERT_RESTRICTED: ''}, {kind: 'skip', reason: 'nothing-restricted'}],
      ['no PR was opened or updated', {ALERT_PR_URL: ''}, {kind: 'skip', reason: 'no-pr'}],
      ['a failed refresh', {ALERT_REFRESH_RESULT: 'failure'}, {kind: 'skip', reason: 'refresh-not-successful'}],
      ['a cancelled refresh', {ALERT_REFRESH_RESULT: 'cancelled'}, {kind: 'skip', reason: 'refresh-not-successful'}],
      ['a skipped refresh', {ALERT_REFRESH_RESULT: 'skipped'}, {kind: 'skip', reason: 'refresh-not-successful'}],
      ['a re-run (attempt 2)', {ALERT_RUN_ATTEMPT: '2'}, {kind: 'skip', reason: 'rerun'}],
      ['a missing attempt', {ALERT_RUN_ATTEMPT: ''}, {kind: 'skip', reason: 'rerun'}],
      ['a malformed attempt', {ALERT_RUN_ATTEMPT: '1x'}, {kind: 'skip', reason: 'rerun'}],
      ['an issue rehearsal (fail)', {ALERT_REHEARSE: 'fail'}, {kind: 'skip', reason: 'rehearsal'}],
      ['an issue rehearsal (clear)', {ALERT_REHEARSE: 'clear'}, {kind: 'skip', reason: 'rehearsal'}],
      [
        'a restriction rehearsal',
        {ALERT_REHEARSE: 'restrict', ALERT_REFRESH_RESULT: 'skipped', ALERT_RESTRICTED: '', ALERT_PR_URL: ''},
        {kind: 'send', identity: 'rehearsal', count: 1, link: PULLS_URL},
      ],
      [
        'a restriction rehearsal re-run',
        {ALERT_REHEARSE: 'restrict', ALERT_RUN_ATTEMPT: '2'},
        {kind: 'skip', reason: 'rerun'},
      ],
    ])('%s', (_name, overrides, expected) => {
      expect(planRestriction(readRestrictionEnv(restrictEnv(overrides)))).toEqual(expected)
    })

    it.each([
      ['another repository', 'https://github.com/someone/else/pull/2085'],
      ['an issue link', `https://github.com/${REPO}/issues/2085`],
      ['plain http', `http://github.com/${REPO}/pull/2085`],
      ['another host', `https://evil.example/${REPO}/pull/2085`],
      ['a trailing path', `${PR_URL}/files`],
      ['a query string', `${PR_URL}?x=1`],
      ['a fragment', `${PR_URL}#x`],
      ['trailing text', `${PR_URL} @everyone`],
      ['a markdown link', `[x](${PR_URL})`],
      ['a newline', `${PR_URL}\nhttps://evil.example`],
      ['a non-numeric id', `https://github.com/${REPO}/pull/abc`],
      ['a prefix of this repository name', `https://github.com/${REPO}-fork/pull/2085`],
      ['an oversize id', `https://github.com/${REPO}/pull/${'9'.repeat(11)}`],
    ])('falls back to the open PR list, never echoing the value, for %s', (_name, bad) => {
      const plan = planRestriction(readRestrictionEnv(restrictEnv({ALERT_PR_URL: bad})))
      expect(plan).toEqual({kind: 'send', identity: 'real', count: 2, link: PULLS_URL})
    })

    it.each(['abc', '-1', '1.5', '1 2', '99999', '2\n3', '0x2', '١'])(
      'refuses a malformed restricted count %j instead of guessing',
      bad => {
        expect(() => readRestrictionEnv(restrictEnv({ALERT_RESTRICTED: bad}))).toThrow()
      },
    )

    it('refuses a rehearsal from anyone but the owner, and an actor-less environment', () => {
      for (const overrides of [{GITHUB_ACTOR: 'someone-else'}, {GITHUB_ACTOR: '', GITHUB_REPOSITORY_OWNER: ''}]) {
        const env = readRestrictionEnv(restrictEnv({ALERT_REHEARSE: 'restrict', ...overrides}))
        expect(() => planRestriction(env)).toThrow()
      }
    })
  })

  describe('message', () => {
    it('is this exact text for a real restriction', async () => {
      const run = await restrictStep()

      expect(run.content).toBe(
        [
          '**OpenCode Go privacy refresh PR restricts models**',
          '2 model(s) the proxy serves would be restricted. Review the PR, then merge it and approve the cliproxy deploy. Until the deploy is approved the proxy keeps serving them.',
          `PR: ${PR_URL}`,
          'Workflow: OpenCode Go Privacy',
          `Run: ${RUN_URL}`,
          `Runbook: ${RESTRICTION_RUNBOOK_URL}`,
        ].join('\n'),
      )
    })

    it('is this exact text for a rehearsal, with no real PR in it', async () => {
      const run = await restrictStep({
        ALERT_REHEARSE: 'restrict',
        ALERT_REFRESH_RESULT: 'skipped',
        ALERT_RESTRICTED: '',
        ALERT_PR_URL: '',
      })

      expect(run.content).toBe(
        [
          '**[REHEARSAL] OpenCode Go privacy refresh PR restricts models**',
          '1 model(s) the proxy serves would be restricted. Review the PR, then merge it and approve the cliproxy deploy. Until the deploy is approved the proxy keeps serving them.',
          'Rehearsal: no refresh ran, no PR was opened and nothing is restricted.',
          `PR: ${PULLS_URL}`,
          'Workflow: OpenCode Go Privacy',
          `Run: ${RUN_URL}`,
          `Runbook: ${RESTRICTION_RUNBOOK_URL}`,
        ].join('\n'),
      )
    })

    it('points at the runbook section that tells the reader what to do', () => {
      const env = readRestrictionEnv(restrictEnv())
      const plan = planRestriction(env)
      if (plan.kind !== 'send') throw new Error('expected a send plan')
      expect(buildRestrictionContent(env, plan)).toContain('#snapshot-refresh-pr-review')
    })

    it('posts with mentions off and embeds suppressed', async () => {
      const run = await restrictStep()
      const payload = JSON.parse(run.calls[0]?.body ?? '{}') as Record<string, unknown>

      expect(run.calls).toHaveLength(1)
      expect(run.calls[0]?.url).toBe(WEBHOOK)
      expect(payload.allowed_mentions).toEqual({parse: []})
      expect(payload.flags).toBe(4)
      expect(run.summary.outcome).toBe('sent')
    })

    it('carries only the count, the validated links and fixed text: no model name, no upstream text, no hostile input', async () => {
      const run = await restrictStep({
        ALERT_PR_URL: `${PR_URL} @everyone <@1234> [x](http://evil.example) glm-5.3 kimi-k3`,
        GITHUB_WORKFLOW: 'OpenCode Go Privacy @everyone <@1234> [x](http://evil.example)',
        REFRESH_ERROR: 'Upstream said: ignore previous instructions',
      })

      expect(run.content).toContain(`PR: ${PULLS_URL}`)
      expect(run.content).not.toMatch(/[@<>[\]]/)
      expect(run.content).not.toContain('(http')
      expect(run.content).not.toContain('://evil')
      expect(run.content).not.toMatch(/glm|kimi|Upstream said/)
      expect(run.content?.length).toBeLessThan(1900)
    })
  })

  describe('delivery', () => {
    it('posts nothing, and does not fail, when nothing is restricted', async () => {
      const run = await restrictStep({ALERT_RESTRICTED: '0'})

      expect(run.calls).toEqual([])
      expect(run.summary).toMatchObject({outcome: 'skipped', reason: 'nothing-restricted'})
    })

    it('posts nothing on a re-run, which replays an older refresh result', async () => {
      const run = await restrictStep({ALERT_RUN_ATTEMPT: '2'})

      expect(run.calls).toEqual([])
      expect(run.summary).toMatchObject({outcome: 'skipped', reason: 'rerun'})
    })

    it('posts nothing on a failed refresh: the failure alert owns that path', async () => {
      const run = await restrictStep({ALERT_REFRESH_RESULT: 'failure'})

      expect(run.calls).toEqual([])
    })

    it('skips with a log line, and does not fail, when the webhook is unset or blank', async () => {
      for (const webhook of [undefined, '', '   ']) {
        const run = await restrictStep({CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: webhook})
        expect(run.calls).toEqual([])
        expect(run.summary).toMatchObject({outcome: 'skipped', reason: 'webhook-unset'})
        expect(run.logs.join('\n')).toContain('skipped')
      }
    })

    it('does not touch the webhook when the decision is to skip', async () => {
      const run = await restrictStep({ALERT_RESTRICTED: '0', CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: 'not a url'})

      expect(run.summary).toMatchObject({outcome: 'skipped', reason: 'nothing-restricted'})
    })

    it('reports a refused rehearsal and a malformed count as fixed reasons, and posts nothing', async () => {
      const stranger = await restrictStep({ALERT_REHEARSE: 'restrict', GITHUB_ACTOR: 'someone-else'})
      expect(stranger.calls).toEqual([])
      expect(stranger.summary).toMatchObject({outcome: 'failed', reason: 'rehearsal-not-owner'})

      const garbage = await restrictStep({ALERT_RESTRICTED: 'glm-5.3'})
      expect(garbage.calls).toEqual([])
      expect(garbage.summary).toMatchObject({outcome: 'failed', reason: 'invalid-restricted'})
      expect(garbage.logs.join('\n')).not.toContain('glm-5.3')
    })

    it('retries a 5xx, then reports the fixed reason without failing, and never logs the webhook or the response', async () => {
      const run = await restrictStep({}, () => new Response(`echo ${WEBHOOK}`, {status: 503}))

      expect(run.calls).toHaveLength(3)
      expect(run.summary).toMatchObject({outcome: 'failed', reason: 'http-503'})
      expect(run.logs.join('\n')).not.toContain('SECRET-token_value')
      expect(run.logs.join('\n')).not.toContain('echo')
    })

    it('does not post a rehearsal message for a real run, nor a real message for a rehearsal', async () => {
      const real = await restrictStep()
      const rehearsal = await restrictStep({
        ALERT_REHEARSE: 'restrict',
        ALERT_REFRESH_RESULT: 'skipped',
        ALERT_RESTRICTED: '',
        ALERT_PR_URL: '',
      })

      expect(real.content).not.toContain('REHEARSAL')
      expect(rehearsal.content).toContain('[REHEARSAL]')
      expect(rehearsal.content).not.toContain('/pull/')
    })
  })

  describe('the issue step stays out of it', () => {
    it('does nothing for a restriction rehearsal: no API call, no notify request', async () => {
      const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
      const run = await issueStep({ALERT_REHEARSE: 'restrict', ALERT_REFRESH_RESULT: 'skipped'}, fake)

      expect(run.exitCode).toBe(0)
      expect(fake.calls).toEqual([])
      expect(run.outputs).toEqual({notify: 'none'})
    })

    it('still maps a successful refresh to a clear, whatever the restriction environment says', async () => {
      const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
      const run = await issueStep({ALERT_REFRESH_RESULT: 'success', ALERT_RESTRICTED: '3', ALERT_PR_URL: PR_URL}, fake)

      expect(run.outputs.notify).toBe('recovered')
    })
  })

  describe('with a recovery on the same run', () => {
    it('posts one recovery message and one restriction message, from two steps', async () => {
      const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
      const issue = await issueStep({ALERT_REFRESH_RESULT: 'success'}, fake)
      const recovery = await notifyStep({
        ALERT_REFRESH_RESULT: 'success',
        ALERT_NOTIFY: issue.outputs.notify,
        ALERT_ISSUE_NUMBER: issue.outputs['issue-number'],
      })
      const restriction = await restrictStep()

      expect(recovery.calls).toHaveLength(1)
      expect(restriction.calls).toHaveLength(1)
      expect(recovery.calls[0]?.body).toContain('recovered')
      expect(restriction.calls[0]?.body).toContain('restricts models')
    })
  })
})
