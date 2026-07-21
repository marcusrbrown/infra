import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'

import {z} from 'zod'

import {
  checkProviderAuthState,
  type ProviderAuthClassification,
  type ProviderAuthReason,
  type ProviderAuthState,
} from './status'

declare const process: {env: Record<string, string | undefined>}

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'
const PRODUCTION_LABEL = 'cliproxy-auth-monitor'
const TEST_LABEL = 'cliproxy-auth-monitor-test'
const PRODUCTION_IDENTITY_MARKER = '<!-- cliproxy-auth-monitor:v1 -->'
const TEST_IDENTITY_MARKER = '<!-- cliproxy-auth-monitor-test:v1 -->'
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
  probeReason: ProviderAuthReason
  transition: MonitorTransition
  issue: MonitorIssueAction[]
  discord: MonitorDiscordAction
  timestamp: string
}

export function formatMonitorRunSummary(summary: MonitorRunSummary): string {
  const issue = summary.issue.length > 0 ? summary.issue.join('+') : 'none'
  return `CLIProxy auth monitor summary: probe=${summary.probeState} reason=${summary.probeReason} transition=${summary.transition} issue=${issue} discord=${summary.discord} at ${summary.timestamp}`
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

function parseGhResponse(output: string): MonitorGhResponse {
  const separator = output.indexOf('\r\n\r\n')
  const splitLength = separator === -1 ? 2 : 4
  const splitAt = separator === -1 ? output.indexOf('\n\n') : separator
  if (splitAt < 0) throw new Error('github-invalid-response')
  const headers = output.slice(0, splitAt)
  const status = /^HTTP\/\S+\s+(\d{3})/m.exec(headers)?.[1]
  if (!status) throw new Error('github-invalid-response')
  return {status: Number(status), body: output.slice(splitAt + splitLength)}
}

async function runGhApiOnce(token: string, path: string, method: string, body?: string): Promise<MonitorGhResponse> {
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
    if (exitCode !== 0) throw new Error('github-transient')
    return parseGhResponse(stdout)
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
  identityMarker: string,
  state: 'dead' | 'healthy',
  timestamp: string,
  includeState: boolean,
): string {
  const markerPrefix = identityMarker === TEST_IDENTITY_MARKER ? 'cliproxy-auth-monitor-test' : 'cliproxy-auth-monitor'
  const marker = includeState ? `\n<!-- ${markerPrefix}:notified=${state} -->` : ''
  const remediation = state === 'dead' ? '\nRemediation: cliproxy login claude.' : ''
  return `${identityMarker}\nCLIProxyAPI Anthropic authentication monitor.${remediation}\nLast check: ${timestamp}.\n<!-- ${markerPrefix}:last-check=${timestamp} -->${marker}`
}

function issueHasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.some(candidate => candidate.name === label)
}

function notifiedState(body: string | null, identityMarker: string): 'dead' | 'healthy' | null {
  const markerPrefix = identityMarker === TEST_IDENTITY_MARKER ? 'cliproxy-auth-monitor-test' : 'cliproxy-auth-monitor'
  const match = body?.match(new RegExp(`<!-- ${markerPrefix}:notified=(dead|healthy) -->`))
  return match?.[1] === 'dead' || match?.[1] === 'healthy' ? match[1] : null
}

async function resolveIssue(client: GitHubClient, identityMarker: string, label: string): Promise<GitHubIssue | null> {
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

async function ensureLabel(client: GitHubClient, label: string): Promise<void> {
  const encoded = encodeURIComponent(label)
  const status = await client.requestStatus(`/labels/${encoded}`)
  if (status === 404) {
    await client.request('/labels', z.unknown(), {
      method: 'POST',
      body: JSON.stringify({name: label, color: 'b60205', description: 'CLIProxy auth monitor state'}),
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
  label: string,
  identityMarker: string,
  body: string,
  sleep: MonitorRuntime['sleep'],
): Promise<GitHubIssue> {
  await ensureLabel(client, label)
  for (let attempt = 1; attempt <= MAX_GITHUB_ATTEMPTS; attempt++) {
    try {
      return await client.request('/issues', githubIssueSchema, {
        method: 'POST',
        body: JSON.stringify({title: 'CLIProxy Anthropic authentication outage', body, labels: [label]}),
        retry: false,
      })
    } catch (error) {
      const retryable = error instanceof Error && /github-(?:transient|timeout)/.test(error.message)
      if (!retryable || attempt === MAX_GITHUB_ATTEMPTS) throw error
      const appeared = await resolveIssue(client, identityMarker, label)
      if (appeared) return appeared
      await sleep(attempt * 100)
    }
  }
  throw new Error('github-transient')
}

async function sendDiscord(
  webhook: string,
  state: 'dead' | 'healthy',
  timestamp: string,
  synthetic: boolean,
  runtime: MonitorRuntime,
): Promise<void> {
  const content =
    state === 'dead'
      ? `${synthetic ? '[synthetic test] ' : ''}CLIProxy Anthropic authentication is unavailable as of ${timestamp}. Run cliproxy login claude.`
      : `${synthetic ? '[synthetic test] ' : ''}CLIProxy Anthropic authentication recovered as of ${timestamp}.`
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
  identityMarker: string,
  state: 'dead' | 'healthy',
  timestamp: string,
): Promise<void> {
  await updateIssue(client, issue, issue.state, issueBody(identityMarker, state, timestamp, true))
}

function providerState(validation: Exclude<MonitorValidation, 'live'>): ProviderAuthClassification {
  return validation === 'synthetic-dead' ? {state: 'dead', reason: 'auth-401'} : {state: 'healthy', reason: 'ok'}
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

  const label = validation === 'live' ? PRODUCTION_LABEL : TEST_LABEL
  const client = createGitHubClient(inputs.githubToken, inputs.repository, runtime.sleep, runtime.ghApi)
  const timestamp = new Date().toISOString()
  try {
    const classification =
      validation === 'live' ? await checkProviderAuthState(proxyUrl, inputs.apiKey) : providerState(validation)
    const finish = (
      transition: MonitorTransition,
      issue: MonitorIssueAction[] = [],
      discord: MonitorDiscordAction = 'none',
    ): MonitorRunSummary => {
      const summary: MonitorRunSummary = {
        probeState: classification.state,
        probeReason: classification.reason,
        transition,
        issue,
        discord,
        timestamp,
      }
      ctx.console.log(formatMonitorRunSummary(summary))
      return summary
    }
    const identityMarker = validation === 'live' ? PRODUCTION_IDENTITY_MARKER : TEST_IDENTITY_MARKER
    const issue = await resolveIssue(client, identityMarker, label)

    if (classification.state === 'unknown') return finish('none')

    const target = classification.state === 'dead' ? 'dead' : 'healthy'
    if (!issue && target === 'healthy') return finish('none')

    const issueActions: MonitorIssueAction[] = []

    if (!issue) {
      const created = await createIssue(
        client,
        label,
        identityMarker,
        issueBody(identityMarker, 'dead', timestamp, false),
        runtime.sleep,
      )
      await sendDiscord(inputs.discordWebhook, 'dead', timestamp, validation !== 'live', runtime)
      await persistNotifiedMarker(client, created, identityMarker, 'dead', timestamp)
      return finish('outage', ['created'], 'outage-sent')
    }

    if (target === 'dead') {
      const currentMarker = notifiedState(issue.body, identityMarker)
      const wasOpen = issue.state === 'open'
      const body = issueBody(identityMarker, 'dead', timestamp, currentMarker === 'dead')
      await updateIssue(client, issue, 'open', body)
      issue.state = 'open'
      issueActions.push(wasOpen ? 'updated' : 'reopened')
      if (currentMarker === 'dead' && wasOpen) return finish('none', issueActions)
      await sendDiscord(inputs.discordWebhook, 'dead', timestamp, validation !== 'live', runtime)
      await persistNotifiedMarker(client, issue, identityMarker, 'dead', timestamp)
      return finish(wasOpen ? 'notification-retry' : 'outage', issueActions, 'outage-sent')
    }

    const currentMarker = notifiedState(issue.body, identityMarker)
    const wasOpen = issue.state === 'open'
    if (issue.state === 'open') {
      await updateIssue(
        client,
        issue,
        'closed',
        issueBody(identityMarker, currentMarker === 'dead' ? 'dead' : 'healthy', timestamp, currentMarker !== null),
      )
      issue.state = 'closed'
      issueActions.push('closed')
    } else if (currentMarker === 'healthy' || currentMarker === null) {
      return finish('none', issueActions)
    }

    if (currentMarker === 'dead') {
      await sendDiscord(inputs.discordWebhook, 'healthy', timestamp, validation !== 'live', runtime)
      await persistNotifiedMarker(client, issue, identityMarker, 'healthy', timestamp)
      return finish(wasOpen ? 'recovery' : 'notification-retry', issueActions, 'recovery-sent')
    }
    await persistNotifiedMarker(client, issue, identityMarker, 'healthy', timestamp)
    return finish('repair', issueActions)
  } catch (error) {
    const category =
      error instanceof Error && /trusted-label-mismatch/.test(error.message)
        ? 'trusted-label-mismatch'
        : error instanceof Error && /ambiguous-identity/.test(error.message)
          ? 'ambiguous-state'
          : 'reconciliation'
    safeError(ctx, category)
  }
}

export function registerCliproxyMonitor(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'cliproxy monitor',
      'Reconcile Anthropic provider authentication with one canonical GitHub issue and transition-only Discord alerts. Requires CLIPROXY_API_KEY, CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_ACTOR, and GITHUB_REPOSITORY_OWNER environment variables; prefer the cliproxy-auth-monitor.yaml GitHub Actions entrypoint for scheduled or synthetic validation.',
    )
    .option(
      '--validation [mode]',
      z
        .enum(monitorValidationModes)
        .default('live')
        .describe(
          'Validation mode (live, synthetic-dead, or synthetic-healthy): live probes Anthropic; synthetic modes are owner-only isolated test transitions.',
        ),
    )
    .example('# Run the live provider-auth monitor')
    .example('infra cliproxy monitor')
    .example('# Exercise the isolated outage transition as the repository owner')
    .example('infra cliproxy monitor --validation synthetic-dead')
    .action(cliproxyMonitorAction)
}
