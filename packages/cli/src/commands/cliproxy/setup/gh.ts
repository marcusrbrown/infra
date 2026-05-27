/// <reference types="bun" />

import type {SpinnerResult} from '@clack/prompts'

import {confirm, log, spinner} from '@clack/prompts'

import {managementHeaders, requestJson, toStringArray} from '../shared'
import {cancelAndExit, promptValue} from './prompts'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

// ─── Local helpers ────────────────────────────────────────────────────────────

/** Local copy — avoids a circular import with setup.ts (gh → setup → gh). */
function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─── Spawn helpers ────────────────────────────────────────────────────────────

export async function withSpinner<T>(message: string, run: (spinnerInstance: SpinnerResult) => Promise<T>): Promise<T> {
  const spinnerInstance = spinner()
  spinnerInstance.start(message)

  try {
    const result = await run(spinnerInstance)
    spinnerInstance.stop(message)
    return result
  } catch (error) {
    spinnerInstance.error(`${message} failed`)
    throw error
  }
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return {stdout, stderr, exitCode}
}

export async function runGh(args: string[]): Promise<CommandResult> {
  return runCommand('gh', args)
}

// ─── Rate-limit helpers ───────────────────────────────────────────────────────

export function isGhRateLimitError(text: string): boolean {
  return /rate limit/i.test(text)
}

/**
 * Query the GitHub API rate limit reset time. The `rate_limit` endpoint is
 * exempt from rate limiting itself, so this should succeed even when the
 * primary GraphQL limit is exhausted. Returns a formatted local time string
 * or a fallback phrase when the endpoint is unreachable.
 */
async function queryRateLimitReset(): Promise<string> {
  try {
    const result = await runGh(['api', 'rate_limit'])
    if (result.exitCode === 0) {
      const parsed = JSON.parse(result.stdout) as {
        resources?: {graphql?: {reset?: number}; core?: {reset?: number}}
      }
      const reset = parsed.resources?.graphql?.reset ?? parsed.resources?.core?.reset
      if (reset) {
        return new Date(reset * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
      }
    }
  } catch {
    // Fall through to generic phrase
  }
  return 'an unknown time'
}

/**
 * Run a GitHub API operation wrapped in a spinner, retrying indefinitely on
 * rate-limit errors when in interactive mode. In non-interactive mode the
 * error is re-thrown with the reset time appended so the caller can surface
 * it without prompting.
 */
export async function withGhRetry<T>(
  label: string,
  fn: (spinnerInstance: SpinnerResult) => Promise<T>,
  interactive: boolean,
  queryReset: () => Promise<string> = queryRateLimitReset,
): Promise<T> {
  for (;;) {
    try {
      return await withSpinner(label, fn)
    } catch (error) {
      const message = extractErrorMessage(error)
      if (!isGhRateLimitError(message)) {
        throw error
      }
      const reset = await queryReset()
      if (!interactive) {
        throw new Error(`${message} — GitHub API rate limit resets at ${reset}. Re-run when ready.`)
      }
      log.warn(`GitHub API rate limit exceeded. Resets at ${reset}.`)
      const retry = await promptValue(
        confirm({
          message: 'Retry this step when ready?',
          active: 'retry',
          inactive: 'abort',
          initialValue: true,
        }),
        'Setup aborted after rate limit.',
      )
      if (!retry) {
        cancelAndExit('Setup aborted after GitHub API rate limit.')
      }
    }
  }
}

// ─── Preflight assertions ─────────────────────────────────────────────────────

export async function assertGhInstalled(): Promise<void> {
  if (!Bun.which('gh')) {
    throw new Error('GitHub CLI is required for cliproxy setup. Install gh first: https://cli.github.com/')
  }
}

export async function assertGhAuthenticated(): Promise<void> {
  const result = await runGh(['auth', 'status'])
  if (result.exitCode !== 0) {
    throw new Error(`GitHub CLI is not authenticated. Run "gh auth login" first. ${result.stderr.trim()}`.trim())
  }
}

export async function assertRepoAccess(repo: string): Promise<void> {
  const {z} = await import('zod')
  const ghRepoViewSchema = z.object({
    nameWithOwner: z.string(),
    viewerPermission: z.string(),
  })

  const result = await runGh(['repo', 'view', repo, '--json', 'nameWithOwner,viewerPermission'])
  if (result.exitCode !== 0) {
    throw new Error(`Unable to access ${repo}. ${result.stderr.trim()}`.trim())
  }

  const parsed = ghRepoViewSchema.parse(JSON.parse(result.stdout))
  const writePermissions = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

  if (!writePermissions.has(parsed.viewerPermission)) {
    throw new Error(
      `GitHub CLI does not have write access to ${parsed.nameWithOwner}. Current permission: ${parsed.viewerPermission}.`,
    )
  }
}

export async function listExistingGhNames(repo: string, kind: 'secret' | 'variable'): Promise<string[]> {
  const {z} = await import('zod')
  const ghNameListSchema = z.array(z.object({name: z.string()}))

  const result = await runGh([kind, 'list', '--repo', repo, '--json', 'name'])
  if (result.exitCode !== 0) {
    throw new Error(`Unable to list existing GitHub ${kind}s for ${repo}. ${result.stderr.trim()}`.trim())
  }

  return ghNameListSchema.parse(JSON.parse(result.stdout)).map(entry => entry.name)
}

// ─── Management API key helpers ───────────────────────────────────────────────

export async function createManagementApiKey(baseUrl: string, managementKey: string, keyValue: string): Promise<void> {
  const endpoint = `${baseUrl}/v0/management/api-keys`
  const currentPayload = await requestJson(endpoint, {
    method: 'GET',
    headers: managementHeaders(managementKey),
  })
  const currentKeys = toStringArray(currentPayload)

  if (currentKeys.includes(keyValue)) {
    return
  }

  await requestJson(endpoint, {
    method: 'PUT',
    headers: managementHeaders(managementKey),
    body: JSON.stringify([...currentKeys, keyValue]),
  })
}

export async function deleteManagementApiKey(baseUrl: string, managementKey: string, keyValue: string): Promise<void> {
  const endpoint = `${baseUrl}/v0/management/api-keys`
  const currentPayload = await requestJson(endpoint, {
    method: 'GET',
    headers: managementHeaders(managementKey),
  })
  const currentKeys = toStringArray(currentPayload)
  const filtered = currentKeys.filter(k => k !== keyValue)

  if (filtered.length === currentKeys.length) {
    return
  }

  await requestJson(endpoint, {
    method: 'PUT',
    headers: managementHeaders(managementKey),
    body: JSON.stringify(filtered),
  })
}

// ─── GitHub value application ─────────────────────────────────────────────────

export async function applyGhValue(
  kind: 'secret' | 'variable',
  name: string,
  repo: string,
  value: string,
): Promise<void> {
  if (kind === 'secret') {
    const child = Bun.spawn(['gh', 'secret', 'set', name, '--repo', repo], {
      stdin: new Blob([value]).stream(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })

    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])

    if (exitCode !== 0) {
      throw new Error(`gh secret set ${name} failed: ${stderr.trim()}`.trim())
    }
    return
  }

  const result = await runGh([kind, 'set', name, '--repo', repo, '--body', value])
  if (result.exitCode !== 0) {
    throw new Error(`gh ${kind} set ${name} failed: ${result.stderr.trim()}`.trim())
  }
}
