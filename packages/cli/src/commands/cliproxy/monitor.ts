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
const NOTIFIED_MARKER = /<!-- cliproxy-auth-monitor(?:-test)?:notified=(dead|healthy) -->/
const GITHUB_API = 'https://api.github.com'
const MAX_DISCORD_ATTEMPTS = 3

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

interface MonitorInputs {
  apiKey: string
  discordWebhook: string
  githubToken: string
  repository: string
  actor: string
  owner: string
}

interface GitHubClient {
  request: <T>(path: string, init?: RequestInit) => Promise<T>
  requestStatus: (path: string, init?: RequestInit) => Promise<number>
}

function safeError(ctx: ActionCtx, category: string): void {
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

function readInputs(validation: MonitorValidation): MonitorInputs | null {
  const env = process.env
  const values = {
    apiKey: env.CLIPROXY_API_KEY,
    discordWebhook: env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK,
    githubToken: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    actor: env.GITHUB_ACTOR,
    owner: env.GITHUB_REPOSITORY_OWNER,
  }

  if (validation !== 'live' && values.actor !== values.owner) return null
  if (validation === 'live' && !values.apiKey) return null
  if (!values.discordWebhook || !values.githubToken || !values.repository || !values.actor || !values.owner) return null
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repository ?? '')) return null

  return {
    apiKey: values.apiKey ?? '',
    discordWebhook: values.discordWebhook as string,
    githubToken: values.githubToken as string,
    repository: values.repository as string,
    actor: values.actor as string,
    owner: values.owner as string,
  }
}

function createGitHubClient(token: string, repository: string): GitHubClient {
  const base = `${GITHUB_API}/repos/${repository}`
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  }

  async function requestStatus(path: string, init?: RequestInit): Promise<number> {
    const response = await fetch(`${base}${path}`, {...init, headers: {...headers, ...(init?.headers ?? {})}})
    return response.status
  }

  return {
    async request<T>(path: string, init?: RequestInit) {
      const response = await fetch(`${base}${path}`, {...init, headers: {...headers, ...(init?.headers ?? {})}})
      if (!response.ok) throw new Error(`github-${response.status}`)
      return (await response.json()) as T
    },
    requestStatus,
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
  return `${identityMarker}\nCLIProxyAPI Anthropic authentication monitor.\nLast check: ${timestamp}.\n<!-- ${markerPrefix}:last-check=${timestamp} -->${marker}`
}

function issueHasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.some(candidate => candidate.name === label)
}

function notifiedState(body: string | null): 'dead' | 'healthy' | null {
  return (body?.match(NOTIFIED_MARKER)?.[1] as 'dead' | 'healthy' | undefined) ?? null
}

async function resolveIssue(client: GitHubClient, identityMarker: string, label: string): Promise<GitHubIssue | null> {
  const issues: GitHubIssue[] = []
  let page = 1
  while (true) {
    const path = page === 1 ? '/issues?state=all&per_page=100' : `/issues?state=all&per_page=100&page=${page}`
    const batch = await client.request<GitHubIssue[]>(path)
    issues.push(...batch)
    if (batch.length < 100) break
    page++
  }
  const marked = issues.filter(
    issue => issue.pull_request === undefined && issue.body?.includes(identityMarker) === true,
  )
  const labeled = marked.filter(issue => issueHasLabel(issue, label))
  if (labeled.length > 1) throw new Error('ambiguous-identity')
  if (labeled.length === 1) return labeled[0] ?? null
  if (marked.length > 1) throw new Error('ambiguous-identity')
  return marked[0] ?? null
}

async function restoreLabel(client: GitHubClient, issue: GitHubIssue, label: string): Promise<void> {
  if (issueHasLabel(issue, label)) return
  await client.request(`/issues/${issue.number}/labels`, {
    method: 'POST',
    body: JSON.stringify({labels: [label]}),
  })
}

async function ensureLabel(client: GitHubClient, label: string): Promise<void> {
  const encoded = encodeURIComponent(label)
  const status = await client.requestStatus(`/labels/${encoded}`)
  if (status === 404) {
    await client.request('/labels', {
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
  await client.request(`/issues/${issue.number}`, {
    method: 'PATCH',
    body: JSON.stringify({state, body}),
  })
}

async function createIssue(client: GitHubClient, label: string, body: string): Promise<GitHubIssue> {
  await ensureLabel(client, label)
  return client.request<GitHubIssue>('/issues', {
    method: 'POST',
    body: JSON.stringify({title: 'CLIProxy Anthropic authentication outage', body, labels: [label]}),
  })
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms))
}

async function sendDiscord(webhook: string, state: 'dead' | 'healthy', timestamp: string): Promise<void> {
  const content =
    state === 'dead'
      ? `CLIProxy Anthropic authentication is unavailable as of ${timestamp}. Run cliproxy login claude.`
      : `CLIProxy Anthropic authentication recovered as of ${timestamp}.`
  for (let attempt = 1; attempt <= MAX_DISCORD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({content, allowed_mentions: {parse: []}}),
      })
      if (response.ok) return
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === MAX_DISCORD_ATTEMPTS) {
        throw new Error(`discord-${response.status}`)
      }
      const retryAfter = Number(response.headers.get('retry-after') ?? '0')
      await sleep(Math.min(1000, Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 0))
    } catch (error) {
      if (attempt === MAX_DISCORD_ATTEMPTS || (error instanceof Error && /^discord-\d{3}$/.test(error.message)))
        throw error
      await sleep(0)
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
): Promise<MonitorRunSummary | void> {
  const validation = options.validation ?? 'live'
  const inputs = readInputs(validation)
  const syntheticUnauthorized =
    validation !== 'live' &&
    process.env.GITHUB_ACTOR !== undefined &&
    process.env.GITHUB_REPOSITORY_OWNER !== undefined &&
    process.env.GITHUB_ACTOR !== process.env.GITHUB_REPOSITORY_OWNER
  if (!inputs) return safeError(ctx, syntheticUnauthorized ? 'synthetic-unauthorized' : 'invalid-inputs')

  const proxyUrl = process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL
  if (!validateProxyOrigin(proxyUrl)) return safeError(ctx, 'untrusted-proxy-origin')

  const label = validation === 'live' ? PRODUCTION_LABEL : TEST_LABEL
  const client = createGitHubClient(inputs.githubToken, inputs.repository)
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
    if (issue && !issueHasLabel(issue, label)) {
      await restoreLabel(client, issue, label)
      issueActions.push('label-restored')
    }

    if (!issue) {
      const created = await createIssue(client, label, issueBody(identityMarker, 'dead', timestamp, false))
      await sendDiscord(inputs.discordWebhook, 'dead', timestamp)
      await persistNotifiedMarker(client, created, identityMarker, 'dead', timestamp)
      return finish('outage', ['created'], 'outage-sent')
    }

    if (target === 'dead') {
      const currentMarker = notifiedState(issue.body)
      const wasOpen = issue.state === 'open'
      const body = issueBody(identityMarker, 'dead', timestamp, currentMarker === 'dead')
      await updateIssue(client, issue, 'open', body)
      issue.state = 'open'
      issueActions.push(wasOpen ? 'updated' : 'reopened')
      if (currentMarker === 'dead' && wasOpen) return finish('none', issueActions)
      await sendDiscord(inputs.discordWebhook, 'dead', timestamp)
      await persistNotifiedMarker(client, issue, identityMarker, 'dead', timestamp)
      return finish(wasOpen ? 'notification-retry' : 'outage', issueActions, 'outage-sent')
    }

    const currentMarker = notifiedState(issue.body)
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
      await sendDiscord(inputs.discordWebhook, 'healthy', timestamp)
      await persistNotifiedMarker(client, issue, identityMarker, 'healthy', timestamp)
      return finish(wasOpen ? 'recovery' : 'notification-retry', issueActions, 'recovery-sent')
    }
    await persistNotifiedMarker(client, issue, identityMarker, 'healthy', timestamp)
    return finish('repair', issueActions)
  } catch (error) {
    const category =
      error instanceof Error && /ambiguous-identity/.test(error.message) ? 'ambiguous-state' : 'reconciliation'
    safeError(ctx, category)
  }
}

export function registerCliproxyMonitor(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'cliproxy monitor',
      'Reconcile Anthropic provider authentication with one canonical GitHub issue and transition-only Discord alerts.',
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
