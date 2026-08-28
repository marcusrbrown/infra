import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import {HTTP_TIMEOUT_MS, managementHeaders} from '@marcusrbrown/infra-shared/cliproxy/management'
import {z} from 'zod'

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'

const ResetQuotaResponseSchema = z.object({
  status: z.literal('ok'),
  auth_index: z.string(),
  models: z.array(z.unknown()),
})

const AuthFileSchema = z.object({
  id: z.string(),
  auth_index: z.string(),
  name: z.string(),
  type: z.string(),
  provider: z.string(),
  email: z.string(),
})

const AuthFilesResponseSchema = z.object({
  files: z.array(AuthFileSchema),
})

const ManagementErrorSchema = z.object({error: z.string()})

type ResetQuotaResponse = z.infer<typeof ResetQuotaResponseSchema>
type AuthFile = z.infer<typeof AuthFileSchema>

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolveBaseUrl(input?: string): string {
  return stripTrailingSlash(input ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
}

function resolveManagementKey(input?: string): string {
  const key = input ?? process.env.CLIPROXY_MANAGEMENT_KEY

  if (!key) {
    throw new Error('Management API key is required. Pass --key or set CLIPROXY_MANAGEMENT_KEY.')
  }

  return key
}

export interface ResetQuotaOptions {
  url?: string
  key?: string
  list?: boolean
  json?: boolean
}

async function requestParsedJson<T>(endpoint: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(endpoint, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const body = await response.text()
  let payload: unknown

  try {
    payload = body.length === 0 ? null : JSON.parse(body)
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    const error = ManagementErrorSchema.safeParse(payload)
    if (error.success) {
      throw new Error(error.data.error)
    }

    throw new Error(`${init.method ?? 'GET'} ${endpoint} failed with HTTP ${response.status}: ${body}`)
  }

  return schema.parse(payload)
}

function formatAuthFile(file: AuthFile, index: number): string {
  return `${index + 1}. ${file.auth_index} — ${file.name} (${file.provider}, ${file.email})`
}

export async function cliproxyResetQuotaAction(
  authIndex: string | undefined,
  options: ResetQuotaOptions,
  ctx: ActionCtx,
): Promise<ResetQuotaResponse | AuthFile[]> {
  try {
    const baseUrl = resolveBaseUrl(options.url)
    const managementKey = resolveManagementKey(options.key)

    if (options.list) {
      const files = (
        await requestParsedJson(
          `${baseUrl}/v0/management/auth-files`,
          {
            method: 'GET',
            headers: managementHeaders(managementKey),
          },
          AuthFilesResponseSchema,
        )
      ).files

      if (options.json) {
        ctx.console.log(JSON.stringify(files, null, 2))
      } else if (files.length === 0) {
        ctx.console.log('No auth files configured')
      } else {
        for (const [index, file] of files.entries()) {
          ctx.console.log(formatAuthFile(file, index))
        }
      }

      return files
    }

    if (!authIndex) {
      throw new Error('auth_index is required. Pass an auth index or use --list to enumerate auth files.')
    }

    const payload = await requestParsedJson(
      `${baseUrl}/v0/management/reset-quota`,
      {
        method: 'POST',
        headers: managementHeaders(managementKey),
        body: JSON.stringify({auth_index: authIndex}),
      },
      ResetQuotaResponseSchema,
    )

    ctx.console.log(JSON.stringify(payload, null, 2))
    return payload
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.console.error(message)
    ctx.process.exit(1)
    return [] // unreachable; satisfies TS that all paths return
  }
}

export function registerCliproxyResetQuota(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'cliproxy reset-quota [auth-index]',
      'Reset the quota for one CLIProxyAPI auth record, or list valid auth indexes.',
    )
    .option(
      '--url [url]',
      z
        .string()
        .describe(
          'Base URL for CLIProxyAPI management requests. Falls back to CLIPROXY_URL or https://cliproxy.fro.bot.',
        ),
    )
    .option(
      '--key [key]',
      z.string().describe('Management API key. Falls back to CLIPROXY_MANAGEMENT_KEY when omitted.'),
    )
    .option('--list', 'List auth records and their auth indexes without resetting quota.')
    .option('--json', 'Output auth records as JSON when used with --list.')
    .example('# List valid auth indexes before resetting one')
    .example('infra cliproxy reset-quota --list')
    .example('# Reset quota for one auth record')
    .example('infra cliproxy reset-quota auth-index-123')
    .action(cliproxyResetQuotaAction)
}
