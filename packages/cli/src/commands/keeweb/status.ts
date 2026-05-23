import type {goke} from 'goke'

import type {ActionCtx} from '../../__test__/mcp-ctx-fixture'
import type {StatusSummary} from '../status'

import path from 'node:path'
import {z} from 'zod'

const SITE_URL = 'https://kw.igg.ms/'
const GH_REPO = 'marcusrbrown/infra'
const HTTP_TIMEOUT_MS = 10_000

type CheckLevel = 'ok' | 'warning' | 'error'

interface CheckResult {
  title: string
  level: CheckLevel
  summary: string
  details?: string[]
}

const ghRunSchema = z.array(
  z.object({
    createdAt: z.string().min(1),
    url: z.url(),
  }),
)

function levelLabel(level: CheckLevel): string {
  if (level === 'ok') {
    return 'OK'
  }

  if (level === 'warning') {
    return 'WARN'
  }

  return 'ERROR'
}

export function formatDurationMs(durationMs: number): string {
  return `${Math.max(0, Math.round(durationMs))}ms`
}

export function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

export function hashSha256(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return hasher.digest('hex')
}

async function streamToText(stream?: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return ''
  }

  return await new Response(stream).text()
}

export async function checkHttpReachability(verbose: boolean): Promise<CheckResult> {
  const startedAt = performance.now()

  try {
    const response = await fetch(SITE_URL, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const elapsedMs = performance.now() - startedAt
    const details: string[] = []

    if (verbose) {
      details.push(`URL: ${SITE_URL}`)
      details.push(`Status text: ${response.statusText || '(none)'}`)

      if (response.headers.get('content-type')) {
        details.push(`Content-Type: ${response.headers.get('content-type')}`)
      }

      if (response.headers.get('server')) {
        details.push(`Server: ${response.headers.get('server')}`)
      }
    }

    return {
      title: 'HTTP reachability',
      level: response.ok ? 'ok' : 'error',
      summary: `GET ${SITE_URL} → ${response.status} (${formatDurationMs(elapsedMs)})`,
      details,
    }
  } catch (error) {
    const elapsedMs = performance.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)

    return {
      title: 'HTTP reachability',
      level: 'error',
      summary: `Request failed after ${formatDurationMs(elapsedMs)}: ${message}`,
      details: verbose ? [`URL: ${SITE_URL}`, `Timeout: ${HTTP_TIMEOUT_MS}ms`] : undefined,
    }
  }
}

export async function checkLastDeploy(verbose: boolean): Promise<CheckResult> {
  try {
    const proc = Bun.spawn(
      [
        'gh',
        'run',
        'list',
        '--workflow=Deploy KeeWeb',
        '--status=success',
        '--limit=1',
        '--json',
        'createdAt,url',
        '--repo',
        GH_REPO,
      ],
      {
        stderr: 'pipe',
        stdout: 'pipe',
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      streamToText(proc.stdout),
      streamToText(proc.stderr),
    ])

    if (exitCode !== 0) {
      const baseDetails = stderr.trim() ? [stderr.trim()] : []
      const verboseDetails = verbose && stdout.trim() ? [...baseDetails, `Raw stdout: ${stdout.trim()}`] : baseDetails

      return {
        title: 'Last successful deploy',
        level: 'warning',
        summary: `Unable to query GitHub Actions (gh exited ${exitCode})`,
        details: verboseDetails,
      }
    }

    const parsed = ghRunSchema.safeParse(JSON.parse(stdout))
    if (!parsed.success) {
      return {
        title: 'Last successful deploy',
        level: 'warning',
        summary: 'GitHub CLI output did not match expected schema',
        details: verbose ? [parsed.error.message, `Raw stdout: ${stdout.trim()}`] : undefined,
      }
    }

    const [latestRun] = parsed.data

    if (!latestRun) {
      return {
        title: 'Last successful deploy',
        level: 'warning',
        summary: 'No successful Deploy KeeWeb workflow runs found',
      }
    }

    const details = [`Run URL: ${latestRun.url}`]

    if (verbose) {
      details.push(`Raw createdAt: ${latestRun.createdAt}`)
    }

    return {
      title: 'Last successful deploy',
      level: 'ok',
      summary: `${formatDate(latestRun.createdAt)}`,
      details,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return {
      title: 'Last successful deploy',
      level: 'warning',
      summary: `Unable to query GitHub Actions: ${message}`,
      details: verbose
        ? ['Requires GitHub CLI authenticated with access to marcusrbrown/infra', 'Install: https://cli.github.com/']
        : undefined,
    }
  }
}

export async function checkContentHash(verbose: boolean): Promise<CheckResult> {
  const distIndexPath = path.resolve(import.meta.dir, '../../../../../apps/keeweb/dist/index.html')
  const localFile = Bun.file(distIndexPath)
  const localExists = await localFile.exists()

  if (!localExists) {
    return {
      title: 'Content hash',
      level: 'warning',
      summary: `Local dist file not found: ${distIndexPath}`,
      details: ['Run: bun run --cwd apps/keeweb build'],
    }
  }

  try {
    const response = await fetch(SITE_URL, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })

    if (!response.ok) {
      return {
        title: 'Content hash',
        level: 'warning',
        summary: `Could not fetch remote index.html (HTTP ${response.status})`,
        details: verbose ? [`URL: ${SITE_URL}`] : undefined,
      }
    }

    const [remoteBody, localBody] = await Promise.all([response.text(), localFile.text()])
    const remoteHash = hashSha256(remoteBody)
    const localHash = hashSha256(localBody)

    const details = verbose ? [`Remote SHA-256: ${remoteHash}`, `Local SHA-256: ${localHash}`] : undefined

    if (remoteHash === localHash) {
      return {
        title: 'Content hash',
        level: 'ok',
        summary: 'Remote index.html matches local dist/index.html',
        details,
      }
    }

    return {
      title: 'Content hash',
      level: 'warning',
      summary: 'Remote index.html differs from local dist/index.html',
      details,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      title: 'Content hash',
      level: 'warning',
      summary: `Could not compare hashes: ${message}`,
      details: verbose ? [`URL: ${SITE_URL}`, `Local path: ${distIndexPath}`] : undefined,
    }
  }
}

function printCheckResult(result: CheckResult, ctx: ActionCtx): void {
  ctx.console.log(`[${levelLabel(result.level)}] ${result.title}`)
  ctx.console.log(`  ${result.summary}`)

  if (result.details && result.details.length > 0) {
    for (const detail of result.details) {
      ctx.console.log(`  - ${detail}`)
    }
  }
}

function formatCheckSummary(result: CheckResult): string {
  return `${levelLabel(result.level)}: ${result.summary}`
}

export async function getKeewebStatusSummary(verbose: boolean): Promise<StatusSummary> {
  const [httpResult, lastDeployResult, contentHashResult] = await Promise.all([
    checkHttpReachability(verbose),
    checkLastDeploy(verbose),
    checkContentHash(verbose),
  ])

  return {
    app: 'keeweb',
    http: formatCheckSummary(httpResult),
    lastDeploy: formatCheckSummary(lastDeployResult),
    version: '—',
    contentHash: formatCheckSummary(contentHashResult),
    usageStats: '—',
  }
}

export async function keewebStatusAction(options: {verbose?: boolean}, ctx: ActionCtx): Promise<void> {
  const verbose = options.verbose === true

  ctx.console.log('KeeWeb status')
  ctx.console.log('')

  const results = await Promise.all([
    checkHttpReachability(verbose),
    checkLastDeploy(verbose),
    checkContentHash(verbose),
  ])

  for (const result of results) {
    printCheckResult(result, ctx)
    ctx.console.log('')
  }

  const errorCount = results.filter(result => result.level === 'error').length
  const warningCount = results.filter(result => result.level === 'warning').length

  ctx.console.log(`Summary: ${results.length} checks, ${errorCount} errors, ${warningCount} warnings`)

  if (errorCount > 0) {
    ctx.process.exit(1)
  }
}

export function registerKeewebStatus(cli: ReturnType<typeof goke>): void {
  cli
    .command('keeweb status', 'Show operational health of the KeeWeb deployment')
    .option('--verbose', 'Enable verbose output for all commands')
    .action(keewebStatusAction)
}
