import type {goke} from 'goke'

import type {ActionCtx} from '../../lib/action-ctx'
import type {AppCollection} from '../../status/collect'

import {join} from 'node:path'
import {z} from 'zod'
import {findRepoRoot} from '../../lib/repo-root'
import {DEPLOY_STATE_REF, mapDeploymentState} from '../../status/deploy-state'

const SITE_URL = 'https://kw.igg.ms/'
const GH_REPO = 'marcusrbrown/infra'
const HTTP_TIMEOUT_MS = 10_000
const DEPLOYMENT_ENVIRONMENT = 'keeweb'
/** Newest `main` deployments to inspect, one status read each. Deploys are rare; this never walks history. */
const DEPLOYMENT_SCAN_LIMIT = 10
const LAST_DEPLOY_TITLE = 'Last successful deploy'

type CheckLevel = 'ok' | 'info' | 'warning' | 'error'

interface CheckResult {
  title: string
  level: CheckLevel
  summary: string
  details?: string[]
  /** Machine-readable outcome for the typed status contract: the run's ISO time, or `match`/`differs`. */
  value?: string
}

const deploymentListSchema = z.array(z.object({id: z.number().int().positive(), ref: z.string()}))
const deploymentStatusListSchema = z.array(
  z.object({
    state: z.string().min(1).max(32),
    created_at: z.iso.datetime(),
    target_url: z.string().optional(),
  }),
)

function levelLabel(level: CheckLevel): string {
  if (level === 'ok') {
    return 'OK'
  }

  if (level === 'info') {
    return 'INFO'
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

type GhApiResult<T> = {ok: true; data: T} | {ok: false; result: CheckResult}

/** `gh api` GET of `path`, parsed through `schema`. Any failure comes back as a ready-to-print warning. */
async function ghApiJson<T>(
  path: string,
  schema: z.ZodType<T>,
  verbose: boolean,
  signal?: AbortSignal,
): Promise<GhApiResult<T>> {
  const proc = Bun.spawn(['gh', 'api', path], {
    stderr: 'pipe',
    stdout: 'pipe',
    ...(signal === undefined ? {} : {signal}),
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    streamToText(proc.stdout),
    streamToText(proc.stderr),
  ])

  if (exitCode !== 0) {
    const baseDetails = stderr.trim() ? [stderr.trim()] : []
    const verboseDetails = verbose && stdout.trim() ? [...baseDetails, `Raw stdout: ${stdout.trim()}`] : baseDetails

    return {
      ok: false,
      result: {
        title: LAST_DEPLOY_TITLE,
        level: 'warning',
        summary: `Unable to query GitHub deployments (gh exited ${exitCode})`,
        details: verboseDetails,
      },
    }
  }

  const parsed = schema.safeParse(JSON.parse(stdout))
  if (!parsed.success) {
    return {
      ok: false,
      result: {
        title: LAST_DEPLOY_TITLE,
        level: 'warning',
        summary: 'GitHub CLI output did not match expected schema',
        details: verbose ? [parsed.error.message, `Raw stdout: ${stdout.trim()}`] : undefined,
      },
    }
  }

  return {ok: true, data: parsed.data}
}

/**
 * The newest `main` deployment of the `keeweb` environment whose latest status is `success`.
 *
 * A gated deploy job creates that deployment and its status, so this is evidence from the deploy job itself. Router
 * and standalone deploys both write it. A workflow run that succeeded with the deploy job skipped creates none, so it
 * can never be counted. A failed lookup is never skipped over: an older success would be reported as the latest.
 */
export async function checkLastDeploy(verbose: boolean, signal?: AbortSignal): Promise<CheckResult> {
  try {
    const deployments = await ghApiJson(
      `/repos/${GH_REPO}/deployments?environment=${DEPLOYMENT_ENVIRONMENT}&ref=${DEPLOY_STATE_REF}&per_page=${DEPLOYMENT_SCAN_LIMIT}`,
      deploymentListSchema,
      verbose,
      signal,
    )
    if (!deployments.ok) {
      return deployments.result
    }

    // The `ref` filter is a request, not a guarantee: re-check it.
    const mainDeployments = deployments.data.filter(deployment => deployment.ref === DEPLOY_STATE_REF)

    for (const deployment of mainDeployments) {
      const statuses = await ghApiJson(
        `/repos/${GH_REPO}/deployments/${deployment.id}/statuses?per_page=1`,
        deploymentStatusListSchema,
        verbose,
        signal,
      )
      if (!statuses.ok) {
        return statuses.result
      }

      const [latest] = statuses.data
      if (latest === undefined || mapDeploymentState(latest.state).result !== 'pass') {
        continue
      }

      const details = latest.target_url === undefined ? [] : [`Deploy job: ${latest.target_url}`]

      if (verbose) {
        details.push(`Raw created_at: ${latest.created_at}`)
      }

      return {
        title: LAST_DEPLOY_TITLE,
        level: 'ok',
        summary: `${formatDate(latest.created_at)}`,
        details,
        value: latest.created_at,
      }
    }

    return {
      title: LAST_DEPLOY_TITLE,
      level: 'warning',
      summary: 'No successful KeeWeb deployments found on main',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return {
      title: LAST_DEPLOY_TITLE,
      level: 'warning',
      summary: `Unable to query GitHub deployments: ${message}`,
      details: verbose
        ? ['Requires GitHub CLI authenticated with access to marcusrbrown/infra', 'Install: https://cli.github.com/']
        : undefined,
    }
  }
}

/**
 * Detect whether root is a source checkout of this monorepo.
 *
 * A source checkout has the repo root discoverable from the module directory.
 * We confirm the layout by checking for a source-only marker file that is
 * never shipped in the CLI package. This is more robust than checking for
 * `node_modules` in the path, which misses unpacked tarballs and global-style
 * installs.
 */
async function isSourceCheckout(root: string): Promise<boolean> {
  // apps/keeweb/src/build.ts is a source-only file never included in the CLI package
  const sourceMarker = join(root, 'apps', 'keeweb', 'src', 'build.ts')
  return Bun.file(sourceMarker).exists()
}

export async function checkContentHash(verbose: boolean, repoRoot?: string): Promise<CheckResult> {
  // When running from a packaged install (bunx, npm global, unpacked tarball, etc.),
  // findRepoRoot() throws because there is no workspace marker. Treat that as
  // "not a source checkout" and return a clean, non-path-noisy info result.
  let root: string
  if (repoRoot === undefined) {
    try {
      root = findRepoRoot()
    } catch {
      return {
        title: 'Content hash',
        level: 'info',
        summary: 'Content hash not available: local KeeWeb dist is only present in a source checkout',
        details: verbose
          ? ['Clone the repo and run: bun run --cwd apps/keeweb build', 'Then re-run status from the source checkout']
          : undefined,
      }
    }
  } else {
    root = repoRoot
  }

  const distIndexPath = join(root, 'apps', 'keeweb', 'dist', 'index.html')

  // When the injected root has no source marker (e.g. tests simulating packaged installs),
  // return the same clean info result.
  const sourceCheckout = await isSourceCheckout(root)
  if (!sourceCheckout) {
    return {
      title: 'Content hash',
      level: 'info',
      summary: 'Content hash not available: local KeeWeb dist is only present in a source checkout',
      details: verbose
        ? ['Clone the repo and run: bun run --cwd apps/keeweb build', 'Then re-run status from the source checkout']
        : undefined,
    }
  }

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
        value: 'match',
      }
    }

    return {
      title: 'Content hash',
      level: 'warning',
      summary: 'Remote index.html differs from local dist/index.html',
      details,
      value: 'differs',
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

/**
 * KeeWeb has no SSH path: reachability comes from the shared public probe, so this collector only supplies
 * facts. `lastDeploy` is the newest successful `main` deployment's time (null when `gh` cannot say) and
 * `contentHash` compares the live page with the local build.
 */
export async function getKeewebStatusSummary(signal?: AbortSignal): Promise<AppCollection> {
  const [lastDeployResult, contentHashResult] = await Promise.all([
    checkLastDeploy(false, signal),
    checkContentHash(false),
  ])

  return {
    observations: [],
    facts: {
      lastDeploy: lastDeployResult.value ?? null,
      contentHash: contentHashResult.value ?? 'unavailable',
    },
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
