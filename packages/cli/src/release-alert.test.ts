/// <reference types="bun" />

import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {describe, expect, it} from 'bun:test'
import {parse as parseYaml} from 'yaml'

// ─── Release Alert deterministic harness ─────────────────────────────────────
//
// This suite extracts the alert step's real `run` block from
// `.github/workflows/release-alert.yaml` and executes it with `/bin/bash`
// against a temporary fake `gh` boundary. The fake records every invocation and
// serves fixture JSON, so the assertions cover the workflow's actual
// create-versus-comment decision logic rather than a reimplementation of it.
//
// The synthetic `workflow_dispatch` contract is RED until U2 lands; the
// production characterization tests describe behavior that exists today.

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/release-alert.yaml')
const SYSTEM_BASH = '/bin/bash'
const RUN_TIMEOUT_MS = 20_000

const PRODUCTION_TITLE = 'Release workflow failure'
const PRODUCTION_LABEL = 'release-publish-failure'
const PRODUCTION_MARKER = '<!-- release-publish-failure:v1 -->'
const SYNTHETIC_TITLE = 'Release workflow failure (synthetic validation)'
const SYNTHETIC_LABEL = 'release-publish-failure-test'
const SYNTHETIC_MARKER = '<!-- release-publish-failure-test:v1 -->'

const WORKFLOW_RUN_URL = 'https://github.com/owner/repo/actions/runs/987654321'
const HEAD_SHA = 'cafebabecafebabecafebabecafebabecafebabe'
const WORKFLOW_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const ACTIVE_RUN_ID = '1234567890'
const ACTIVE_RUN_URL = `https://github.com/owner/repo/actions/runs/${ACTIVE_RUN_ID}`

// ─── Workflow parsing ────────────────────────────────────────────────────────

interface WorkflowStep {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
}

interface WorkflowJob {
  if?: string
  permissions?: Record<string, string>
  env?: Record<string, string>
  steps?: WorkflowStep[]
}

interface ParsedWorkflow {
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  concurrency?: Record<string, unknown>
  jobs?: Record<string, WorkflowJob>
}

function loadWorkflow(): ParsedWorkflow {
  return parseYaml(readFileSync(WORKFLOW_PATH, 'utf8')) as ParsedWorkflow
}

function alertJob(workflow: ParsedWorkflow): WorkflowJob {
  const job = workflow.jobs?.alert
  if (!job) throw new Error('release-alert.yaml: missing `alert` job')
  return job
}

function alertStep(workflow: ParsedWorkflow): WorkflowStep {
  const steps = alertJob(workflow).steps ?? []
  const named = steps.find(step => step.name === 'Report failed release' && typeof step.run === 'string')
  const step = named ?? steps.find(candidate => typeof candidate.run === 'string')
  if (!step?.run) throw new Error('release-alert.yaml: missing the alert run step')
  return step
}

function extractAlertRunBlock(workflow: ParsedWorkflow = loadWorkflow()): string {
  return alertStep(workflow).run ?? ''
}

// ─── GitHub context resolution ───────────────────────────────────────────────

type Scenario = 'production-failure' | 'synthetic'

interface RunOptions {
  scenario: Scenario
  actor?: string
  repositoryOwner?: string
  fixture?: GhFixture
}

function buildContext(options: RunOptions): Record<string, string> {
  const synthetic = options.scenario === 'synthetic'
  return {
    'github.repository': 'owner/repo',
    'github.repository_owner': options.repositoryOwner ?? 'owner',
    'github.actor': options.actor ?? 'owner',
    'github.event_name': synthetic ? 'workflow_dispatch' : 'workflow_run',
    'github.token': 'test-token',
    'github.run_id': ACTIVE_RUN_ID,
    'github.run_number': '31',
    'github.sha': WORKFLOW_SHA,
    'github.workflow': 'Release Alert',
    'github.ref': 'refs/heads/main',
    'github.server_url': 'https://github.com',
    'github.event.workflow_run.html_url': synthetic ? '' : WORKFLOW_RUN_URL,
    'github.event.workflow_run.head_sha': synthetic ? '' : HEAD_SHA,
    'github.event.workflow_run.conclusion': synthetic ? '' : 'failure',
    'github.event.workflow_run.id': synthetic ? '' : '987654321',
    'github.event.workflow_run.run_number': synthetic ? '' : '7',
    'github.event.workflow_run.head_branch': synthetic ? '' : 'main',
  }
}

function resolveTemplate(value: string, context: Record<string, string>): string {
  return value.replaceAll(/\$\{\{\s*([^}\s]+)\s*\}\}/g, (_match: string, expression: string) => {
    const resolved = context[expression]
    if (resolved === undefined) {
      throw new Error(`release-alert harness: unsupported workflow expression: \${{ ${expression} }}`)
    }
    return resolved
  })
}

function resolveEnv(env: Record<string, string> | undefined, context: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(env ?? {})) {
    resolved[name] = resolveTemplate(value, context)
  }
  return resolved
}

// Mirrors the raw `GITHUB_*` variables GitHub Actions injects. We intentionally
// do not invent a run-URL variable: the synthetic path must build the active run
// URL from the same primitives production runners expose.
function rawGithubEnv(context: Record<string, string>): Record<string, string> {
  return {
    GITHUB_REPOSITORY: context['github.repository'] ?? '',
    GITHUB_REPOSITORY_OWNER: context['github.repository_owner'] ?? '',
    GITHUB_ACTOR: context['github.actor'] ?? '',
    GITHUB_EVENT_NAME: context['github.event_name'] ?? '',
    GITHUB_RUN_ID: context['github.run_id'] ?? '',
    GITHUB_RUN_NUMBER: context['github.run_number'] ?? '',
    GITHUB_SHA: context['github.sha'] ?? '',
    GITHUB_WORKFLOW: context['github.workflow'] ?? '',
    GITHUB_REF: context['github.ref'] ?? '',
    GITHUB_SERVER_URL: context['github.server_url'] ?? '',
    GITHUB_TOKEN: context['github.token'] ?? '',
  }
}

// ─── Fake `gh` boundary ──────────────────────────────────────────────────────

type GhResponse =
  {json: unknown; exitCode?: number; stderr?: string} | {body: string; exitCode?: number; stderr?: string}

interface GhFixture {
  labelExists?: boolean
  labelName?: string
  listIssues?: Record<string, unknown>[]
  issuePages?: Record<string, unknown>[][]
  createIssue?: GhResponse
  createComment?: GhResponse
  issueReadback?: GhResponse[]
  commentReadback?: GhResponse[]
}

interface GhCall {
  argv: string[]
  command: string
  method?: string
  endpoint?: string
  fields?: Record<string, string>
  body?: string
}

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  calls: GhCall[]
  summary: string
}

const FAKE_GH_SOURCE = String.raw`#!/usr/bin/env bun
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

const args = process.argv.slice(2)
const config = JSON.parse(readFileSync(process.env.GH_CONFIG, 'utf8'))
const stateDir = process.env.GH_STATE_DIR

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function parseApi(invocation) {
  let method = 'GET'
  let endpoint = null
  const fields = {}
  let wantsStdin = false
  const takesValue = new Set(['-H', '--header', '--hostname', '--cache', '-p', '--preview', '--template'])
  for (let i = 0; i < invocation.length; i++) {
    const token = invocation[i]
    if (token === '--method' || token === '-X') {
      method = invocation[++i] || method
    } else if (token.startsWith('--method=')) {
      method = token.slice('--method='.length)
    } else if (token.length > 2 && token.startsWith('-X')) {
      method = token.slice(2)
    } else if (token === '-f' || token === '--raw-field' || token === '-F' || token === '--field') {
      const pair = invocation[++i] || ''
      const eq = pair.indexOf('=')
      if (eq >= 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1)
    } else if (token === '--input' || token === '-i') {
      if ((invocation[++i] || '') === '-') wantsStdin = true
    } else if (token === '--jq' || token === '-q') {
      i += 1
    } else if (takesValue.has(token)) {
      i += 1
    } else if (token.startsWith('-')) {
      continue
    } else if (endpoint === null) {
      endpoint = token
    }
  }
  return {method: String(method).toUpperCase(), endpoint, fields, wantsStdin}
}

function nextSequence(sequence, key) {
  if (!Array.isArray(sequence) || sequence.length === 0) return {json: {}}
  const counterPath = join(stateDir, key)
  const index = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0
  writeFileSync(counterPath, String(index + 1))
  return sequence[Math.min(index, sequence.length - 1)]
}

function requestedJsonFields(invocation) {
  for (let i = 0; i < invocation.length; i++) {
    const token = invocation[i]
    if (token === '--json') return String(invocation[i + 1] || '').split(',').map(value => value.trim()).filter(Boolean)
    if (token.startsWith('--json=')) return token.slice('--json='.length).split(',').map(value => value.trim()).filter(Boolean)
  }
  return []
}

function projectIssue(issue, fields) {
  if (fields.length === 0) return issue
  const projected = {}
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(issue, field)) projected[field] = issue[field]
  }
  return projected
}

function defaultCreateIssueResponse() {
  return {json: {number: 4242, id: 9000, html_url: 'https://github.com/owner/repo/issues/4242'}}
}

function defaultCreateCommentResponse() {
  return {json: {id: 7000, html_url: 'https://github.com/owner/repo/issues/4242#issuecomment-7000'}}
}

function emit(spec) {
  const response = spec || {}
  if (response.stderr) process.stderr.write(String(response.stderr) + '\n')
  let output = ''
  if (typeof response.body === 'string') output = response.body
  else if (Object.prototype.hasOwnProperty.call(response, 'json')) output = JSON.stringify(response.json)
  if (output) process.stdout.write(output + '\n')
  process.exit(typeof response.exitCode === 'number' ? response.exitCode : 0)
}

let method
let endpoint
let fields = {}
let stdinText = ''
if (args[0] === 'api') {
  const parsed = parseApi(args.slice(1))
  method = parsed.method
  endpoint = parsed.endpoint
  fields = parsed.fields
  if (parsed.wantsStdin) stdinText = readStdin()
}

appendFileSync(
  process.env.GH_CALL_LOG,
  JSON.stringify({argv: args, command: args.join(' '), method: method, endpoint: endpoint, fields: fields, body: stdinText}) + '\n',
)

if (args[0] === 'label' && args[1] === 'view') {
  if (config.labelExists === false) emit({stderr: 'could not resolve to a Label', exitCode: 1})
  else emit({json: {name: config.labelName || 'label'}})
} else if (args[0] === 'label' && args[1] === 'create') {
  emit({json: {name: config.labelName || 'label'}})
} else if (args[0] === 'issue' && args[1] === 'list') {
  const fields = requestedJsonFields(args)
  emit({json: (config.listIssues || []).map(issue => projectIssue(issue, fields))})
} else if (args[0] === 'issue' && args[1] === 'create') {
  emit(config.createIssue || defaultCreateIssueResponse())
} else if (args[0] === 'issue' && args[1] === 'comment') {
  emit(config.createComment || defaultCreateCommentResponse())
} else if (args[0] === 'api') {
  const path = endpoint || ''
  if (method === 'GET' && /\/issues(\?|$)/.test(path) && !/\/issues\/\d+/.test(path) && !/\/comments/.test(path)) {
    const paginated = args.indexOf('--paginate') >= 0 || args.indexOf('--slurp') >= 0
    if (paginated) emit({json: config.issuePages || [config.listIssues || []]})
    else emit({json: config.listIssues || []})
  } else if (method === 'GET' && /\/issues\/\d+(\?|$)/.test(path)) {
    emit(nextSequence(config.issueReadback, 'issue-readback'))
  } else if (method === 'GET' && /\/issues\/comments\/\d+(\?|$)/.test(path)) {
    emit(nextSequence(config.commentReadback, 'comment-readback'))
  } else if (method === 'POST' && /\/issues(\?|$)/.test(path) && !/\/comments/.test(path)) {
    emit(config.createIssue || defaultCreateIssueResponse())
  } else if (method === 'POST' && /\/issues\/\d+\/comments(\?|$)/.test(path)) {
    emit(config.createComment || defaultCreateCommentResponse())
  } else {
    emit({stderr: 'unhandled gh api call: ' + args.join(' '), exitCode: 1})
  }
} else {
  emit({stderr: 'unhandled gh invocation: ' + args.join(' '), exitCode: 1})
}
`

function shellQuote(value: string): string {
  const escaped = value.replaceAll("'", String.raw`'\''`)
  return `'${escaped}'`
}

function writeFakeGh(root: string, binDir: string): void {
  const logicPath = join(root, 'fake-gh.ts')
  writeFileSync(logicPath, FAKE_GH_SOURCE, 'utf8')
  const wrapperPath = join(binDir, 'gh')
  writeFileSync(wrapperPath, `#!/bin/sh\nexec bun ${shellQuote(logicPath)} "$@"\n`, 'utf8')
  chmodSync(wrapperPath, 0o755)
}

function readCalls(callLog: string): GhCall[] {
  if (!existsSync(callLog)) return []
  return readFileSync(callLog, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as GhCall)
}

async function runReleaseAlert(options: RunOptions): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'release-alert-test-'))
  try {
    const workflow = loadWorkflow()
    const runBlock = extractAlertRunBlock(workflow)
    const context = buildContext(options)

    const binDir = join(dir, 'bin')
    const stateDir = join(dir, 'state')
    const runPath = join(dir, 'run.sh')
    const configPath = join(dir, 'fixtures.json')
    const callLog = join(dir, 'gh-calls.jsonl')
    const summaryPath = join(dir, 'step-summary.md')

    mkdirSync(binDir, {recursive: true})
    mkdirSync(stateDir, {recursive: true})
    writeFileSync(runPath, runBlock, 'utf8')
    writeFileSync(configPath, JSON.stringify(options.fixture ?? {}), 'utf8')
    writeFileSync(callLog, '', 'utf8')
    writeFileSync(summaryPath, '', 'utf8')
    writeFakeGh(dir, binDir)

    const environment: Record<string, string> = {
      PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: dir,
      TMPDIR: dir,
      GH_CONFIG: configPath,
      GH_STATE_DIR: stateDir,
      GH_CALL_LOG: callLog,
      GITHUB_STEP_SUMMARY: summaryPath,
      ...rawGithubEnv(context),
      ...resolveEnv(alertJob(workflow).env, context),
      ...resolveEnv(alertStep(workflow).env, context),
    }

    const proc = Bun.spawn([SYSTEM_BASH, runPath], {
      cwd: dir,
      env: environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    let execution: {stdout: string; stderr: string; exitCode: number}
    try {
      const finished = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]).then(([stdout, stderr, exitCode]) => ({stdout, stderr, exitCode}))
      execution = await Promise.race([
        finished,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            proc.kill('SIGKILL')
            reject(new Error(`release-alert run timed out after ${RUN_TIMEOUT_MS}ms`))
          }, RUN_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }

    return {
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      calls: readCalls(callLog),
      summary: readFileSync(summaryPath, 'utf8'),
    }
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

// ─── Call classification / field extraction ──────────────────────────────────

function isCreateIssue(call: GhCall): boolean {
  if (call.argv[0] === 'issue' && call.argv[1] === 'create') return true
  const endpoint = call.endpoint ?? ''
  return (
    call.argv[0] === 'api' &&
    call.method === 'POST' &&
    /\/issues(?:\?|$)/.test(endpoint) &&
    !/\/comments/.test(endpoint)
  )
}

function isComment(call: GhCall): boolean {
  if (call.argv[0] === 'issue' && call.argv[1] === 'comment') return true
  return call.argv[0] === 'api' && call.method === 'POST' && /\/issues\/\d+\/comments/.test(call.endpoint ?? '')
}

function isIssueRead(call: GhCall): boolean {
  return call.argv[0] === 'api' && call.method === 'GET' && /\/issues\/\d+(?:\?|$)/.test(call.endpoint ?? '')
}

function isCommentRead(call: GhCall): boolean {
  return call.argv[0] === 'api' && call.method === 'GET' && /\/issues\/comments\/\d+(?:\?|$)/.test(call.endpoint ?? '')
}

function commentIssueNumber(call: GhCall): number | undefined {
  if (call.argv[0] === 'issue' && call.argv[1] === 'comment') return Number(call.argv[2])
  const match = (call.endpoint ?? '').match(/\/issues\/(\d+)\/comments/)
  return match ? Number(match[1]) : undefined
}

interface MutationFields {
  title?: string
  body?: string
  labels: string[]
}

function mutationFields(call: GhCall): MutationFields {
  let title: string | undefined
  let body: string | undefined
  const labels: string[] = []

  for (let index = 0; index < call.argv.length; index++) {
    const token = call.argv[index]
    if (token === '--title') title = call.argv[index + 1]
    else if (token === '--body') body = call.argv[index + 1]
    else if (token === '--label') {
      const label = call.argv[index + 1]
      if (label) labels.push(label)
    }
  }

  const fields = call.fields ?? {}
  if (typeof fields.title === 'string') title = fields.title
  if (typeof fields.body === 'string') body = fields.body
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'labels[]' || key === 'labels') labels.push(value)
  }

  const stdin = call.body ?? ''
  if (stdin.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(stdin) as {title?: unknown; body?: unknown; labels?: unknown}
      if (typeof parsed.title === 'string') title = parsed.title
      if (typeof parsed.body === 'string') body = parsed.body
      if (Array.isArray(parsed.labels)) {
        for (const label of parsed.labels) {
          if (typeof label === 'string') labels.push(label)
        }
      }
    } catch {
      // Stdin was not a JSON mutation body; ignore it.
    }
  }

  return {title, body, labels}
}

function jsonResponse(json: unknown, exitCode = 0): GhResponse {
  return {json, exitCode}
}

function textResponse(body: string, exitCode = 0): GhResponse {
  return {body, exitCode}
}

function expectSingle(calls: GhCall[], label: string): GhCall {
  expect(calls, `expected exactly one ${label} call`).toHaveLength(1)
  const only = calls[0]
  if (!only) throw new Error(`expected exactly one ${label} call`)
  return only
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function productionFixture(overrides: GhFixture = {}): GhFixture {
  return {labelExists: true, listIssues: [], ...overrides}
}

function productionIssue(number = 1209): Record<string, unknown> {
  const url = `https://github.com/owner/repo/issues/${number}`
  return {
    number,
    state: 'open',
    title: PRODUCTION_TITLE,
    body: `${PRODUCTION_MARKER}\n\nProduction incident`,
    labels: [{name: PRODUCTION_LABEL}],
    html_url: url,
    url,
  }
}

function syntheticIssue(overrides: {number?: number; title?: string; body?: string; labels?: string[]} = {}) {
  const number = overrides.number ?? 40
  const labels = overrides.labels ?? [SYNTHETIC_LABEL]
  const url = `https://github.com/owner/repo/issues/${number}`
  return {
    number,
    state: 'open',
    title: overrides.title ?? SYNTHETIC_TITLE,
    body: overrides.body ?? `${SYNTHETIC_MARKER}\n\nSynthetic validation`,
    labels: labels.map(name => ({name})),
    html_url: url,
    url,
  }
}

interface SyntheticExchange {
  number: number
  id: number
  htmlUrl: string
  createResponse: GhResponse
  readbackResponse: GhResponse
}

// One canonical synthetic create/readback pair. Every successful readback fixture
// carries the full identity (number/id/html_url/title/body/labels) the planned
// exact-object verification is expected to check.
function syntheticExchange(number: number, id: number): SyntheticExchange {
  const htmlUrl = `https://github.com/owner/repo/issues/${number}`
  const record = {
    number,
    id,
    state: 'open',
    title: SYNTHETIC_TITLE,
    body: SYNTHETIC_MARKER,
    labels: [{name: SYNTHETIC_LABEL}],
    html_url: htmlUrl,
    url: htmlUrl,
  }
  return {
    number,
    id,
    htmlUrl,
    createResponse: jsonResponse({number, id, html_url: htmlUrl, url: htmlUrl}),
    readbackResponse: jsonResponse(record),
  }
}

// ─── Harness sanity + production characterization ────────────────────────────

describe('release-alert: harness and production characterization', () => {
  it('executes the extracted workflow run block through the fake gh boundary', async () => {
    const result = await runReleaseAlert({scenario: 'production-failure', fixture: productionFixture()})

    expect(result.exitCode).toBe(0)
    expect(result.calls.length).toBeGreaterThan(0)
    expect(result.calls[0]?.argv[0]).toBe('label')
  })

  it('creates the production issue with the current title, label, marker, and body when none is open', async () => {
    const result = await runReleaseAlert({scenario: 'production-failure', fixture: productionFixture()})

    expect(result.exitCode).toBe(0)
    const createCall = expectSingle(result.calls.filter(isCreateIssue), 'create issue')
    const details = mutationFields(createCall)
    expect(details.title).toBe(PRODUCTION_TITLE)
    expect(details.labels).toContain(PRODUCTION_LABEL)
    expect(details.body).toContain(PRODUCTION_MARKER)
    expect(details.body).toContain(WORKFLOW_RUN_URL)
    expect(details.body).toContain(HEAD_SHA)
    expect(details.body).toContain('failure')
    expect(result.calls.filter(isComment)).toHaveLength(0)
  })

  it('comments on the oldest matching open production issue instead of creating a duplicate', async () => {
    const result = await runReleaseAlert({
      scenario: 'production-failure',
      fixture: productionFixture({listIssues: [productionIssue(1210), productionIssue(1209)]}),
    })

    expect(result.exitCode).toBe(0)
    const commentCall = expectSingle(result.calls.filter(isComment), 'comment')
    expect(commentIssueNumber(commentCall)).toBe(1209)
    expect(result.calls.filter(isCreateIssue)).toHaveLength(0)
    const details = mutationFields(commentCall)
    expect(details.body).toContain(PRODUCTION_MARKER)
    expect(details.body).toContain(WORKFLOW_RUN_URL)
  })

  it('creates the production label when it is missing before listing issues', async () => {
    const result = await runReleaseAlert({
      scenario: 'production-failure',
      fixture: productionFixture({labelExists: false}),
    })

    expect(result.exitCode).toBe(0)
    const labelCreate = result.calls.find(call => call.argv[0] === 'label' && call.argv[1] === 'create')
    expect(labelCreate).toBeDefined()
    expect(labelCreate?.argv).toContain(PRODUCTION_LABEL)
  })
})

// ─── Synthetic contract (RED until U2) ───────────────────────────────────────

describe('release-alert: synthetic dispatch contract', () => {
  it('fails an unauthorized manual dispatch before any gh call', async () => {
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      actor: 'intruder',
      repositoryOwner: 'owner',
      fixture: {labelExists: true, listIssues: []},
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls).toHaveLength(0)
  })

  it('creates exactly one synthetic issue and reads back that exact issue when no synthetic match is open', async () => {
    const exchange = syntheticExchange(501, 9501)
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [
          productionIssue(1209),
          syntheticIssue({number: 900, body: 'synthetic title but no reserved marker'}),
        ],
        createIssue: exchange.createResponse,
        issueReadback: [exchange.readbackResponse],
      },
    })

    expect(result.exitCode).toBe(0)
    const createCall = expectSingle(result.calls.filter(isCreateIssue), 'create issue')
    const details = mutationFields(createCall)
    expect(details.title).toBe(SYNTHETIC_TITLE)
    expect(details.labels).toContain(SYNTHETIC_LABEL)
    expect(details.body).toContain(SYNTHETIC_MARKER)
    expect(details.body).toContain(ACTIVE_RUN_URL)
    expect(result.calls.filter(isComment)).toHaveLength(0)

    const reads = result.calls.filter(isIssueRead)
    expect(reads.length).toBeGreaterThanOrEqual(1)
    expect(reads[0]?.endpoint).toContain(`/issues/${exchange.number}`)
    expect(result.summary).toContain(`/issues/${exchange.number}`)
  })

  it('comments on the one exact synthetic match and never creates another issue', async () => {
    const matchNumber = 502
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [productionIssue(1209), syntheticIssue({number: matchNumber})],
        createComment: jsonResponse({
          id: 7502,
          html_url: `https://github.com/owner/repo/issues/${matchNumber}#issuecomment-7502`,
        }),
        commentReadback: [
          jsonResponse({
            id: 7502,
            body: `${SYNTHETIC_MARKER}\n${ACTIVE_RUN_URL}`,
            html_url: `https://github.com/owner/repo/issues/${matchNumber}#issuecomment-7502`,
          }),
        ],
      },
    })

    expect(result.exitCode).toBe(0)
    const commentCall = expectSingle(result.calls.filter(isComment), 'comment')
    expect(commentIssueNumber(commentCall)).toBe(matchNumber)
    expect(mutationFields(commentCall).body).toContain(ACTIVE_RUN_URL)
    expect(result.calls.filter(isCreateIssue)).toHaveLength(0)

    const commentReads = result.calls.filter(isCommentRead)
    expect(commentReads.length).toBeGreaterThanOrEqual(1)
    expect(commentReads[0]?.endpoint).toContain('/issues/comments/')
    expect(result.summary).toContain(`/issues/${matchNumber}`)
  })

  it('fails closed without mutation when multiple issues match the full synthetic identity', async () => {
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [syntheticIssue({number: 601}), syntheticIssue({number: 602})],
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter(isCreateIssue)).toHaveLength(0)
    expect(result.calls.filter(isComment)).toHaveLength(0)
  })

  it('does not adopt an issue that matches only part of the synthetic identity', async () => {
    const exchange = syntheticExchange(703, 9503)
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [
          syntheticIssue({number: 701, body: 'title and label, but no reserved marker'}),
          syntheticIssue({number: 702, labels: []}),
        ],
        createIssue: exchange.createResponse,
        issueReadback: [exchange.readbackResponse],
      },
    })

    expect(result.exitCode).toBe(0)
    const createCall = expectSingle(result.calls.filter(isCreateIssue), 'create issue')
    expect(mutationFields(createCall).title).toBe(SYNTHETIC_TITLE)
    expect(result.calls.filter(isComment)).toHaveLength(0)
  })

  it('retries the exact issue readback once when the first response is stale', async () => {
    const exchange = syntheticExchange(801, 9801)
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [],
        createIssue: exchange.createResponse,
        issueReadback: [{body: '', exitCode: 1, stderr: 'HTTP 404: Not Found'}, exchange.readbackResponse],
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.calls.filter(isIssueRead)).toHaveLength(2)
  }, 30_000)

  it('fails closed after three stale exact issue readbacks', async () => {
    const exchange = syntheticExchange(802, 9802)
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [],
        createIssue: exchange.createResponse,
        issueReadback: [
          {body: '', exitCode: 1, stderr: 'HTTP 404: Not Found'},
          {body: '', exitCode: 1, stderr: 'HTTP 404: Not Found'},
          {body: '', exitCode: 1, stderr: 'HTTP 404: Not Found'},
        ],
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter(isIssueRead)).toHaveLength(3)
  }, 30_000)

  it('treats malformed readback JSON as retryable and exhausts the bounded budget', async () => {
    const exchange = syntheticExchange(803, 9803)
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [],
        createIssue: exchange.createResponse,
        issueReadback: [textResponse('not-json-at-all'), textResponse('still-not-json'), textResponse('nope')],
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter(isIssueRead)).toHaveLength(3)
  }, 30_000)

  it('fails immediately without retrying when the create response is malformed', async () => {
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [],
        createIssue: textResponse('this is not json'),
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter(isCreateIssue)).toHaveLength(1)
    expect(result.calls.filter(isComment)).toHaveLength(0)
    expect(result.calls.filter(isIssueRead)).toHaveLength(0)
  })

  it('fails immediately when the create-issue response has an invalid canonical shape', async () => {
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [],
        createIssue: jsonResponse({number: 501, html_url: 'https://github.com/owner/repo/issues/501'}),
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter(isCreateIssue)).toHaveLength(1)
    expect(result.calls.filter(isComment)).toHaveLength(0)
    expect(result.calls.filter(isIssueRead)).toHaveLength(0)
  })

  it('fails immediately when the create-comment response has an invalid canonical shape', async () => {
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [syntheticIssue({number: 502})],
        createComment: jsonResponse({id: 7502, html_url: 12345}),
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter(isComment)).toHaveLength(1)
    expect(result.calls.filter(isCreateIssue)).toHaveLength(0)
    expect(result.calls.filter(isCommentRead)).toHaveLength(0)
  })

  it('fails closed with zero mutation when exact matches are split across paginated pages', async () => {
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        issuePages: [[syntheticIssue({number: 601})], [syntheticIssue({number: 602})]],
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter(isCreateIssue)).toHaveLength(0)
    expect(result.calls.filter(isComment)).toHaveLength(0)
    expect(result.calls.some(call => call.argv.includes('--paginate'))).toBe(true)
    expect(result.calls.some(call => call.argv.includes('--slurp'))).toBe(true)
  })

  it('ignores pull-request-shaped records when matching the synthetic identity', async () => {
    const exchange = syntheticExchange(704, 9504)
    const pullRequest = {
      number: 705,
      state: 'open',
      title: SYNTHETIC_TITLE,
      body: SYNTHETIC_MARKER,
      labels: [{name: SYNTHETIC_LABEL}],
      pull_request: {url: 'https://api.github.com/repos/owner/repo/pulls/705'},
    }
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        issuePages: [[pullRequest]],
        createIssue: exchange.createResponse,
        issueReadback: [exchange.readbackResponse],
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.calls.filter(isComment)).toHaveLength(0)
    const createCall = expectSingle(result.calls.filter(isCreateIssue), 'create issue')
    expect(mutationFields(createCall).title).toBe(SYNTHETIC_TITLE)
  })

  it('fails closed when the exact comment readback lacks the reserved marker', async () => {
    const matchNumber = 502
    const commentId = 7502
    const commentUrl = `https://github.com/owner/repo/issues/${matchNumber}#issuecomment-${commentId}`
    const staleComment = jsonResponse({
      id: commentId,
      body: `missing the reserved marker\n${ACTIVE_RUN_URL}`,
      html_url: commentUrl,
    })
    const result = await runReleaseAlert({
      scenario: 'synthetic',
      fixture: {
        labelExists: true,
        listIssues: [syntheticIssue({number: matchNumber})],
        createComment: jsonResponse({id: commentId, html_url: commentUrl}),
        commentReadback: [staleComment, staleComment, staleComment],
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter(isComment)).toHaveLength(1)
    expect(result.calls.filter(isCommentRead)).toHaveLength(3)
  }, 30_000)
})
