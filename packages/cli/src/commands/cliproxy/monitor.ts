import type {OpenCodeGoSettings, ParsedSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import type {goke} from 'goke'

import type {ActionCtx} from '../../lib/action-ctx'

import {z} from 'zod'
import {GO_PROBE_LINE_PREFIX} from '../../status/monitor-state'
import {
  checkProviderAuthState,
  probeGoRoute,
  resolveGoSettings,
  type GoRouteClassification,
  type GoRouteReason,
  type ProviderAuthClassification,
  type ProviderAuthReason,
  type ProviderAuthState,
} from './status'

declare const process: {env: Record<string, string | undefined>}

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'
const GO_RUNBOOK = 'docs/runbooks/cliproxy-opencode-go.md'
const MAX_DISCORD_ATTEMPTS = 3
const MAX_GITHUB_ATTEMPTS = 3
const GITHUB_TIMEOUT_MS = 10_000
const DISCORD_TIMEOUT_MS = 10_000

export const monitorValidationModes = ['live', 'synthetic-dead', 'synthetic-healthy'] as const
export type MonitorValidation = (typeof monitorValidationModes)[number]

export interface MonitorOptions {
  validation?: MonitorValidation
}

export type MonitorTransition = 'none' | 'outage' | 'recovery' | 'repair' | 'notification-retry'
export type MonitorIssueAction = 'created' | 'reopened' | 'closed' | 'updated' | 'label-restored'
export type MonitorDiscordAction = 'none' | 'outage-sent' | 'recovery-sent'

export interface MonitorRunSummary {
  probeState: ProviderAuthState
  probeReason: ProviderAuthReason | GoRouteReason
  transition: MonitorTransition
  issue: MonitorIssueAction[]
  discord: MonitorDiscordAction
  timestamp: string
}

const CLAUDE_SUMMARY_PREFIX = 'CLIProxy auth monitor summary:'
const CLAUDE_PROBE_PREFIX = 'CLIProxy auth monitor probe:'
const GO_SUMMARY_PREFIX = 'CLIProxy Go monitor summary:'

export function formatMonitorRunSummary(summary: MonitorRunSummary, summaryPrefix = CLAUDE_SUMMARY_PREFIX): string {
  const issue = summary.issue.length > 0 ? summary.issue.join('+') : 'none'
  return `${summaryPrefix} probe=${summary.probeState} reason=${summary.probeReason} transition=${summary.transition} issue=${issue} discord=${summary.discord} at ${summary.timestamp}`
}

/**
 * Early, reconciliation-free observation line. Carries only the probe outcome and its timestamp so a dead route stays
 * observable even when issue or Discord reconciliation later fails. The prefix must never match the daily report's
 * `CLIProxy auth monitor summary:` line.
 */
export function formatMonitorProbeLine(
  probe: Pick<MonitorRunSummary, 'probeState' | 'probeReason' | 'timestamp'>,
  probePrefix = CLAUDE_PROBE_PREFIX,
): string {
  return `${probePrefix} probe=${probe.probeState} reason=${probe.probeReason} at ${probe.timestamp}`
}

/** The Go route's early observation line: same shape as the Claude one, with its own prefix. */
export function formatGoMonitorProbeLine(
  probe: Pick<MonitorRunSummary, 'probeState' | 'probeReason' | 'timestamp'>,
): string {
  return formatMonitorProbeLine(probe, GO_PROBE_LINE_PREFIX)
}

/**
 * The Go route's billing observation, printed right after its probe line when a 2xx named a `billing_source`.
 * Its own prefix keeps it out of `parseGoProbeLine`, which reads only the strict probe line.
 */
export function formatGoBillingLine(billingSource: string): string {
  return `CLIProxy Go monitor billing: billing_source=${billingSource}`
}

/**
 * Everything that differs between the two monitored routes: the label, the identity and notification markers, the
 * issue title and body, the Discord text and the output prefixes. The Claude values are fixed; the Go route has
 * its own so the two never share an issue, a label or an alert.
 */
interface RouteConfig {
  label: string
  identityMarker: string
  /** The `<!-- <prefix>:last-check=… -->` / `:notified=…` marker family. */
  markerPrefix: string
  issueTitle: string
  labelDescription: string
  issueDescription: string
  remediation: (reason: string) => string
  discordDead: (timestamp: string, synthetic: boolean, reason: string) => string
  discordHealthy: (timestamp: string, synthetic: boolean) => string
  summaryPrefix: string
}

const syntheticPrefix = (synthetic: boolean): string => (synthetic ? '[synthetic test] ' : '')

function claudeRoute(label: string, identityMarker: string, markerPrefix: string): RouteConfig {
  return {
    label,
    identityMarker,
    markerPrefix,
    issueTitle: 'CLIProxy Anthropic authentication outage',
    labelDescription: 'CLIProxy auth monitor state',
    issueDescription: 'CLIProxyAPI Anthropic authentication monitor.',
    remediation: () => '\nRemediation: cliproxy login claude.',
    discordDead: (timestamp, synthetic) =>
      `${syntheticPrefix(synthetic)}CLIProxy Anthropic authentication is unavailable as of ${timestamp}. Run cliproxy login claude.`,
    discordHealthy: (timestamp, synthetic) =>
      `${syntheticPrefix(synthetic)}CLIProxy Anthropic authentication recovered as of ${timestamp}.`,
    summaryPrefix: CLAUDE_SUMMARY_PREFIX,
  }
}

const PRODUCTION_ROUTE = claudeRoute(
  'cliproxy-auth-monitor',
  '<!-- cliproxy-auth-monitor:v1 -->',
  'cliproxy-auth-monitor',
)
const TEST_ROUTE = claudeRoute(
  'cliproxy-auth-monitor-test',
  '<!-- cliproxy-auth-monitor-test:v1 -->',
  'cliproxy-auth-monitor-test',
)

/** The reason as issue and Discord text: `session-header-dropped` says what broke, the others stay the bare token. */
function goReasonText(reason: string): string {
  return reason === 'session-header-dropped'
    ? `${reason} — the proxy stopped forwarding the session header, so Go answers 400 MissingSessionID`
    : reason
}

/** The OpenCode Go route. Live only: the synthetic modes exercise the Claude route's isolated test issue. */
const GO_ROUTE: RouteConfig = {
  label: 'cliproxy-go-monitor',
  identityMarker: '<!-- cliproxy-go-monitor:v1 -->',
  markerPrefix: 'cliproxy-go-monitor',
  issueTitle: 'CLIProxy OpenCode Go route outage',
  labelDescription: 'CLIProxy Go monitor state',
  issueDescription: 'CLIProxyAPI OpenCode Go route monitor.',
  remediation: reason => `\nReason: ${goReasonText(reason)}.\nRemediation: see ${GO_RUNBOOK}.`,
  discordDead: (timestamp, synthetic, reason) =>
    `${syntheticPrefix(synthetic)}CLIProxy OpenCode Go route is unavailable as of ${timestamp} (reason: ${goReasonText(reason)}). See ${GO_RUNBOOK}.`,
  discordHealthy: (timestamp, synthetic) =>
    `${syntheticPrefix(synthetic)}CLIProxy OpenCode Go route recovered as of ${timestamp}.`,
  summaryPrefix: GO_SUMMARY_PREFIX,
}

interface GitHubIssue {
  number: number
  state: 'open' | 'closed'
  title: string
  body: string | null
  labels: {name?: string}[]
  pull_request?: unknown
}

const githubIssueSchema = z.object({
  number: z.number().int().nonnegative(),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.object({name: z.string().optional()})),
  pull_request: z.unknown().optional(),
})
const githubIssuesSchema = z.array(githubIssueSchema)

interface MonitorInputs {
  apiKey: string
  discordWebhook: string
  githubToken: string
  repository: string
  actor: string
  owner: string
}

interface GitHubClient {
  request: <T>(
    path: string,
    schema: z.ZodType<T>,
    init?: {method?: string; body?: string; retry?: boolean},
  ) => Promise<T>
  requestStatus: (path: string, init?: {method?: string; body?: string}) => Promise<number>
}

type MonitorInputFailure =
  | 'missing-CLIPROXY_API_KEY'
  | 'missing-CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK'
  | 'missing-GITHUB_TOKEN'
  | 'missing-GITHUB_REPOSITORY'
  | 'missing-GITHUB_ACTOR'
  | 'missing-GITHUB_REPOSITORY_OWNER'
  | 'malformed-GITHUB_REPOSITORY'
  | 'synthetic-unauthorized'

type MonitorInputResult = {ok: true; inputs: MonitorInputs} | {ok: false; category: MonitorInputFailure}
type MonitorFailureCategory =
  MonitorInputFailure | 'untrusted-proxy-origin' | 'trusted-label-mismatch' | 'ambiguous-state' | 'reconciliation'

export interface MonitorRuntime {
  fetch: typeof fetch
  sleep: (milliseconds: number) => Promise<void>
  ghApi: (token: string, path: string, method: string, body?: string) => Promise<MonitorGhResponse>
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  /** Tracked OpenCode Go settings. Defaults to the committed ones; tests inject their own. */
  goSettings?: OpenCodeGoSettings
  /** Parsed OpenCode Go privacy snapshot. Defaults to the committed one; tests inject their own. */
  goSnapshot?: ParsedSnapshot
}

const defaultMonitorRuntime: MonitorRuntime = {
  fetch: globalThis.fetch,
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  ghApi: (token, path, method, body) => runGhApiOnce(token, path, method, body),
  setTimeout,
  clearTimeout,
}

function safeError(ctx: ActionCtx, category: MonitorFailureCategory): void {
  ctx.console.error(`CLIProxy auth monitor failed: ${category}`)
  ctx.process.exit(1)
}

function validateProxyOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'cliproxy.fro.bot' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

function readInputs(validation: MonitorValidation): MonitorInputResult {
  const env = process.env
  const values = {
    apiKey: env.CLIPROXY_API_KEY,
    discordWebhook: env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK,
    githubToken: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    actor: env.GITHUB_ACTOR,
    owner: env.GITHUB_REPOSITORY_OWNER,
  }

  if (validation !== 'live' && values.actor !== values.owner) return {ok: false, category: 'synthetic-unauthorized'}
  if (validation === 'live' && !values.apiKey) return {ok: false, category: 'missing-CLIPROXY_API_KEY'}
  if (!values.discordWebhook) return {ok: false, category: 'missing-CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK'}
  if (!values.githubToken) return {ok: false, category: 'missing-GITHUB_TOKEN'}
  if (!values.repository) return {ok: false, category: 'missing-GITHUB_REPOSITORY'}
  if (!values.actor) return {ok: false, category: 'missing-GITHUB_ACTOR'}
  if (!values.owner) return {ok: false, category: 'missing-GITHUB_REPOSITORY_OWNER'}
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repository)) return {ok: false, category: 'malformed-GITHUB_REPOSITORY'}

  return {
    ok: true,
    inputs: {
      apiKey: values.apiKey ?? '',
      discordWebhook: values.discordWebhook,
      githubToken: values.githubToken,
      repository: values.repository,
      actor: values.actor,
      owner: values.owner,
    },
  }
}

export interface MonitorGhResponse {
  status: number
  body: string
}

const GH_ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'] as const

export function createGhEnvironment(token: string): Record<string, string> {
  const environment: Record<string, string> = {
    GH_TOKEN: token,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  }
  for (const name of GH_ENV_ALLOWLIST) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

function tryParseGhResponse(output: string): MonitorGhResponse | null {
  const separator = output.indexOf('\r\n\r\n')
  const splitLength = separator === -1 ? 2 : 4
  const splitAt = separator === -1 ? output.indexOf('\n\n') : separator
  if (splitAt < 0) return null
  const headers = output.slice(0, splitAt)
  const status = /^HTTP\/\S+\s+(\d{3})/m.exec(headers)?.[1]
  if (!status) return null
  return {status: Number(status), body: output.slice(splitAt + splitLength)}
}

export function interpretGhApiResult(exitCode: number, stdout: string): MonitorGhResponse {
  const parsed = tryParseGhResponse(stdout)
  if (parsed) return parsed
  if (exitCode !== 0) throw new Error('github-transient')
  throw new Error('github-invalid-response')
}

export async function runGhApiOnce(
  token: string,
  path: string,
  method: string,
  body?: string,
): Promise<MonitorGhResponse> {
  const child = Bun.spawn(['gh', 'api', path, '--include', '--method', method, ...(body ? ['--input', '-'] : [])], {
    stdin: body ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: createGhEnvironment(token),
  })
  if (body && child.stdin) {
    child.stdin.write(body)
    child.stdin.end()
  }
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const operation = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      child.kill()
      reject(new Error('github-timeout'))
    }, GITHUB_TIMEOUT_MS)
  })
  try {
    const [stdout, _stderr, exitCode] = await Promise.race([operation, timeout])
    return interpretGhApiResult(exitCode, stdout)
  } catch (error) {
    if (timedOut || (error instanceof Error && error.message.startsWith('github-'))) throw error
    throw new Error('github-transient')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createGitHubClient(
  token: string,
  repository: string,
  sleep: MonitorRuntime['sleep'],
  ghApi: MonitorRuntime['ghApi'],
): GitHubClient {
  const base = `/repos/${repository}`
  async function requestApi(
    path: string,
    method: string,
    body: string | undefined,
    allowClientError = false,
    retry = true,
  ): Promise<MonitorGhResponse> {
    const maxAttempts = retry ? MAX_GITHUB_ATTEMPTS : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await ghApi(token, `${base}${path}`, method, body)
        if (response.status >= 200 && response.status < 300) return response
        if (allowClientError && response.status !== 429 && response.status < 500) return response
        if (response.status !== 429 && response.status < 500) throw new Error('github-http')
        throw new Error('github-transient')
      } catch (error) {
        const retryable = error instanceof Error && /github-(?:transient|timeout)/.test(error.message)
        if (!retryable || attempt === maxAttempts) throw error
        await sleep(attempt * 100)
      }
    }
    throw new Error('github-transient')
  }
  return {
    async request<T>(path: string, schema: z.ZodType<T>, init?: {method?: string; body?: string; retry?: boolean}) {
      const response = await requestApi(path, init?.method ?? 'GET', init?.body, false, init?.retry ?? true)
      try {
        return schema.parse(JSON.parse(response.body))
      } catch {
        throw new Error('github-malformed-response')
      }
    },
    async requestStatus(path: string, init?: {method?: string; body?: string}) {
      return (await requestApi(path, init?.method ?? 'GET', init?.body, true)).status
    },
  }
}

function issueBody(
  route: RouteConfig,
  state: 'dead' | 'healthy',
  timestamp: string,
  includeState: boolean,
  reason: string,
): string {
  const marker = includeState ? `\n<!-- ${route.markerPrefix}:notified=${state} -->` : ''
  const remediation = state === 'dead' ? route.remediation(reason) : ''
  return `${route.identityMarker}\n${route.issueDescription}${remediation}\nLast check: ${timestamp}.\n<!-- ${route.markerPrefix}:last-check=${timestamp} -->${marker}`
}

function issueHasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.some(candidate => candidate.name === label)
}

function notifiedState(body: string | null, route: RouteConfig): 'dead' | 'healthy' | null {
  const match = body?.match(new RegExp(`<!-- ${route.markerPrefix}:notified=(dead|healthy) -->`))
  return match?.[1] === 'dead' || match?.[1] === 'healthy' ? match[1] : null
}

async function resolveIssue(client: GitHubClient, route: RouteConfig): Promise<GitHubIssue | null> {
  const {identityMarker, label} = route
  const issues: GitHubIssue[] = []
  let page = 1
  while (true) {
    const path = page === 1 ? '/issues?state=all&per_page=100' : `/issues?state=all&per_page=100&page=${page}`
    const batch = await client.request(path, githubIssuesSchema)
    issues.push(...batch)
    if (batch.length < 100) break
    page++
  }
  const trusted = issues.filter(issue => issue.pull_request === undefined && issueHasLabel(issue, label))
  if (trusted.some(issue => issue.body?.includes(identityMarker) !== true)) throw new Error('trusted-label-mismatch')
  const marked = trusted
    .filter(issue => issue.body?.includes(identityMarker) === true)
    .sort((left, right) => left.number - right.number)
  return marked[0] ?? null
}

async function ensureLabel(client: GitHubClient, route: RouteConfig): Promise<void> {
  const {label} = route
  const encoded = encodeURIComponent(label)
  const status = await client.requestStatus(`/labels/${encoded}`)
  if (status === 404) {
    await client.request('/labels', z.unknown(), {
      method: 'POST',
      body: JSON.stringify({name: label, color: 'b60205', description: route.labelDescription}),
    })
    return
  }
  if (status < 200 || status >= 300) throw new Error(`github-${status}`)
}

async function updateIssue(
  client: GitHubClient,
  issue: GitHubIssue,
  state: 'open' | 'closed',
  body: string,
): Promise<void> {
  await client.request(`/issues/${issue.number}`, z.unknown(), {
    method: 'PATCH',
    body: JSON.stringify({state, body}),
  })
}

async function createIssue(
  client: GitHubClient,
  route: RouteConfig,
  body: string,
  sleep: MonitorRuntime['sleep'],
): Promise<GitHubIssue> {
  await ensureLabel(client, route)
  for (let attempt = 1; attempt <= MAX_GITHUB_ATTEMPTS; attempt++) {
    try {
      return await client.request('/issues', githubIssueSchema, {
        method: 'POST',
        body: JSON.stringify({title: route.issueTitle, body, labels: [route.label]}),
        retry: false,
      })
    } catch (error) {
      const retryable = error instanceof Error && /github-(?:transient|timeout)/.test(error.message)
      if (!retryable || attempt === MAX_GITHUB_ATTEMPTS) throw error
      const appeared = await resolveIssue(client, route)
      if (appeared) return appeared
      await sleep(attempt * 100)
    }
  }
  throw new Error('github-transient')
}

async function sendDiscord(
  webhook: string,
  route: RouteConfig,
  state: 'dead' | 'healthy',
  timestamp: string,
  synthetic: boolean,
  reason: string,
  runtime: MonitorRuntime,
): Promise<void> {
  const content =
    state === 'dead' ? route.discordDead(timestamp, synthetic, reason) : route.discordHealthy(timestamp, synthetic)
  for (let attempt = 1; attempt <= MAX_DISCORD_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = runtime.setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS)
      let response: Response
      try {
        response = await runtime.fetch(webhook, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({content, allowed_mentions: {parse: []}}),
          signal: controller.signal,
        })
      } finally {
        runtime.clearTimeout(timeout)
      }
      if (response.ok) return
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === MAX_DISCORD_ATTEMPTS) {
        throw new Error(`discord-${response.status}`)
      }
      const retryAfter = Number(response.headers.get('retry-after') ?? '0')
      await runtime.sleep(Math.min(1000, Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 0))
    } catch (error) {
      if (attempt === MAX_DISCORD_ATTEMPTS || (error instanceof Error && /^discord-\d{3}$/.test(error.message)))
        throw error
      await runtime.sleep(0)
    }
  }
}

async function persistNotifiedMarker(
  client: GitHubClient,
  issue: GitHubIssue,
  route: RouteConfig,
  state: 'dead' | 'healthy',
  timestamp: string,
  reason: string,
): Promise<void> {
  await updateIssue(client, issue, issue.state, issueBody(route, state, timestamp, true, reason))
}

function providerState(validation: Exclude<MonitorValidation, 'live'>): ProviderAuthClassification {
  return validation === 'synthetic-dead' ? {state: 'dead', reason: 'auth-401'} : {state: 'healthy', reason: 'ok'}
}

interface Reconciliation {
  route: RouteConfig
  classification: {state: ProviderAuthState; reason: ProviderAuthReason | GoRouteReason}
  inputs: MonitorInputs
  client: GitHubClient
  runtime: MonitorRuntime
  timestamp: string
  synthetic: boolean
  ctx: ActionCtx
}

/**
 * Reconcile one route's canonical issue and transition-only Discord alert with its probe result. Each route has its
 * own issue, label and markers, so a route can neither open, close nor update the other's issue. Throws on any
 * GitHub or Discord failure; the caller decides what that costs.
 */
async function reconcileRoute(input: Reconciliation): Promise<MonitorRunSummary> {
  const {route, classification, inputs, client, runtime, timestamp, synthetic, ctx} = input
  const {reason} = classification
  const finish = (
    transition: MonitorTransition,
    issue: MonitorIssueAction[] = [],
    discord: MonitorDiscordAction = 'none',
  ): MonitorRunSummary => {
    const summary: MonitorRunSummary = {
      probeState: classification.state,
      probeReason: reason,
      transition,
      issue,
      discord,
      timestamp,
    }
    ctx.console.log(formatMonitorRunSummary(summary, route.summaryPrefix))
    return summary
  }
  const issue = await resolveIssue(client, route)

  if (classification.state === 'unknown') return finish('none')

  const target = classification.state === 'dead' ? 'dead' : 'healthy'
  if (!issue && target === 'healthy') return finish('none')

  const issueActions: MonitorIssueAction[] = []

  if (!issue) {
    const created = await createIssue(client, route, issueBody(route, 'dead', timestamp, false, reason), runtime.sleep)
    await sendDiscord(inputs.discordWebhook, route, 'dead', timestamp, synthetic, reason, runtime)
    await persistNotifiedMarker(client, created, route, 'dead', timestamp, reason)
    return finish('outage', ['created'], 'outage-sent')
  }

  if (target === 'dead') {
    const currentMarker = notifiedState(issue.body, route)
    const wasOpen = issue.state === 'open'
    const body = issueBody(route, 'dead', timestamp, currentMarker === 'dead', reason)
    await updateIssue(client, issue, 'open', body)
    issue.state = 'open'
    issueActions.push(wasOpen ? 'updated' : 'reopened')
    if (currentMarker === 'dead' && wasOpen) return finish('none', issueActions)
    await sendDiscord(inputs.discordWebhook, route, 'dead', timestamp, synthetic, reason, runtime)
    await persistNotifiedMarker(client, issue, route, 'dead', timestamp, reason)
    return finish(wasOpen ? 'notification-retry' : 'outage', issueActions, 'outage-sent')
  }

  const currentMarker = notifiedState(issue.body, route)
  const wasOpen = issue.state === 'open'
  if (issue.state === 'open') {
    await updateIssue(
      client,
      issue,
      'closed',
      issueBody(route, currentMarker === 'dead' ? 'dead' : 'healthy', timestamp, currentMarker !== null, reason),
    )
    issue.state = 'closed'
    issueActions.push('closed')
  } else if (currentMarker === 'healthy' || currentMarker === null) {
    return finish('none', issueActions)
  }

  if (currentMarker === 'dead') {
    await sendDiscord(inputs.discordWebhook, route, 'healthy', timestamp, synthetic, reason, runtime)
    await persistNotifiedMarker(client, issue, route, 'healthy', timestamp, reason)
    return finish(wasOpen ? 'recovery' : 'notification-retry', issueActions, 'recovery-sent')
  }
  await persistNotifiedMarker(client, issue, route, 'healthy', timestamp, reason)
  return finish('repair', issueActions)
}

function failureCategory(error: unknown): MonitorFailureCategory {
  if (error instanceof Error && /trusted-label-mismatch/.test(error.message)) return 'trusted-label-mismatch'
  if (error instanceof Error && /ambiguous-identity/.test(error.message)) return 'ambiguous-state'
  return 'reconciliation'
}

export async function cliproxyMonitorAction(
  options: MonitorOptions,
  ctx: ActionCtx,
  runtime: MonitorRuntime = defaultMonitorRuntime,
): Promise<MonitorRunSummary | void> {
  const validation = options.validation ?? 'live'
  const inputResult = readInputs(validation)
  if (!inputResult.ok) return safeError(ctx, inputResult.category)
  const inputs = inputResult.inputs

  const proxyUrl = process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL
  if (!validateProxyOrigin(proxyUrl)) return safeError(ctx, 'untrusted-proxy-origin')

  const live = validation === 'live'
  const claude = live ? PRODUCTION_ROUTE : TEST_ROUTE
  const client = createGitHubClient(inputs.githubToken, inputs.repository, runtime.sleep, runtime.ghApi)
  const timestamp = new Date().toISOString()
  const synthetic = !live
  // A route's failure is recorded, not thrown, so the other route still probes and reconciles. Either failing is an
  // operational failure of the run: the exit code reflects both.
  const failures: {name: string; category: MonitorFailureCategory}[] = []

  // Both probe lines print before any reconciliation, so a dead route stays observable when GitHub or Discord fail.
  let claudeProbe: ProviderAuthClassification | undefined
  try {
    claudeProbe = live ? await checkProviderAuthState(proxyUrl, inputs.apiKey) : providerState(validation)
    ctx.console.log(formatMonitorProbeLine({probeState: claudeProbe.state, probeReason: claudeProbe.reason, timestamp}))
  } catch (error) {
    failures.push({name: 'auth', category: failureCategory(error)})
  }

  let goProbe: GoRouteClassification | undefined
  // The Go route is off on purpose when the tracked settings say so: no probe, no line, no issue, no alert.
  let goSettings: OpenCodeGoSettings | undefined
  if (live) {
    try {
      goSettings = resolveGoSettings(runtime.goSettings)
    } catch {
      failures.push({name: 'Go', category: 'reconciliation'})
    }
  }
  if (goSettings?.enabled === true) {
    try {
      const observed = await probeGoRoute(proxyUrl, inputs.apiKey, {settings: goSettings, snapshot: runtime.goSnapshot})
      goProbe = observed.classification
      ctx.console.log(formatGoMonitorProbeLine({probeState: goProbe.state, probeReason: goProbe.reason, timestamp}))
      if (observed.billingSource !== undefined) ctx.console.log(formatGoBillingLine(observed.billingSource))
    } catch {
      failures.push({name: 'Go', category: 'reconciliation'})
    }
  }

  let claudeSummary: MonitorRunSummary | undefined
  if (claudeProbe !== undefined) {
    try {
      claudeSummary = await reconcileRoute({
        route: claude,
        classification: claudeProbe,
        inputs,
        client,
        runtime,
        timestamp,
        synthetic,
        ctx,
      })
    } catch (error) {
      failures.push({name: 'auth', category: failureCategory(error)})
    }
  }

  if (goProbe !== undefined) {
    try {
      await reconcileRoute({
        route: GO_ROUTE,
        classification: goProbe,
        inputs,
        client,
        runtime,
        timestamp,
        synthetic: false,
        ctx,
      })
    } catch (error) {
      failures.push({name: 'Go', category: failureCategory(error)})
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) ctx.console.error(`CLIProxy ${failure.name} monitor failed: ${failure.category}`)
    ctx.process.exit(1)
    return
  }
  return claudeSummary
}

export function registerCliproxyMonitor(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'cliproxy monitor',
      'Reconcile Anthropic and OpenCode Go provider routes, each with its own canonical GitHub issue and transition-only Discord alerts. Requires CLIPROXY_API_KEY, CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_ACTOR, and GITHUB_REPOSITORY_OWNER environment variables; prefer the cliproxy-auth-monitor.yaml GitHub Actions entrypoint for scheduled or synthetic validation.',
    )
    .option(
      '--validation [mode]',
      z
        .enum(monitorValidationModes)
        .default('live')
        .describe(
          'Validation mode (live, synthetic-dead, or synthetic-healthy): live probes Anthropic and OpenCode Go; synthetic modes are owner-only isolated Anthropic test transitions.',
        ),
    )
    .example('# Run the live provider-auth monitor')
    .example('infra cliproxy monitor')
    .example('# Exercise the isolated outage transition as the repository owner')
    .example('infra cliproxy monitor --validation synthetic-dead')
    .action(cliproxyMonitorAction)
}
