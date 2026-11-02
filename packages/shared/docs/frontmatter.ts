import {existsSync} from 'node:fs'
import {basename, dirname, resolve} from 'node:path'
import {parse as parseYaml} from 'yaml'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

// Vendored from the ce:compound skill (references/schema.yaml + yaml-schema.md); CI has no plugin cache.
const PROBLEM_TYPES = [
  'build_error',
  'test_failure',
  'runtime_error',
  'performance_issue',
  'database_issue',
  'security_issue',
  'ui_bug',
  'integration_issue',
  'logic_error',
  'developer_experience',
  'workflow_issue',
  'best_practice',
  'documentation_gap',
  'architecture_pattern',
  'design_pattern',
  'tooling_decision',
  'convention',
] as const
const COMPONENTS = [
  'rails_model',
  'rails_controller',
  'rails_view',
  'service_object',
  'background_job',
  'database',
  'frontend_stimulus',
  'hotwire_turbo',
  'email_processing',
  'brief_system',
  'assistant',
  'authentication',
  'payments',
  'development_workflow',
  'testing_framework',
  'documentation',
  'tooling',
] as const
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
const ROOT_CAUSES = [
  'missing_association',
  'missing_include',
  'missing_index',
  'wrong_api',
  'scope_issue',
  'thread_violation',
  'async_timing',
  'memory_leak',
  'config_error',
  'logic_error',
  'test_isolation',
  'missing_validation',
  'missing_permission',
  'missing_workflow_step',
  'inadequate_documentation',
  'missing_tooling',
  'incomplete_setup',
] as const
const RESOLUTION_TYPES = [
  'code_fix',
  'migration',
  'config_change',
  'test_fix',
  'dependency_update',
  'environment_setup',
  'workflow_improvement',
  'documentation_update',
  'tooling_addition',
  'seed_data_update',
] as const
const PROBLEM_TYPE_DIRS = {
  build_error: 'build-errors',
  test_failure: 'test-failures',
  runtime_error: 'runtime-errors',
  performance_issue: 'performance-issues',
  database_issue: 'database-issues',
  security_issue: 'security-issues',
  ui_bug: 'ui-bugs',
  integration_issue: 'integration-issues',
  logic_error: 'logic-errors',
  developer_experience: 'developer-experience',
  workflow_issue: 'workflow-issues',
  best_practice: 'best-practices',
  documentation_gap: 'documentation-gaps',
  architecture_pattern: 'best-practices',
  design_pattern: 'best-practices',
  tooling_decision: 'best-practices',
  convention: 'best-practices',
} as const satisfies Record<(typeof PROBLEM_TYPES)[number], string>

// Repo-local vocabulary.
const MODULE_NAMES = ['agent-storage', 'fro-bot', 'infra', 'tooling'] as const
const PLAN_TYPES = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore'] as const
const PLAN_STATUSES = ['active', 'completed', 'superseded'] as const
const BRAINSTORM_STATUSES = ['active', 'completed', 'superseded'] as const

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TRAILING_DATE_RE = /-(\d{4}-\d{2}-\d{2})\.md$/
const LEADING_DATE_RE = /^(\d{4}-\d{2}-\d{2})-/

export type Frontmatter = Record<string, unknown>

function isRecord(value: unknown): value is Frontmatter {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends readonly string[]>(allowed: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const time = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value)
}

export function parseFrontmatter(text: string): {data: Frontmatter} | {error: string} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return {error: 'missing YAML frontmatter block'}
  let parsed: unknown
  try {
    parsed = parseYaml(match[1] ?? '')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {error: `frontmatter is not valid YAML: ${message.split('\n')[0]}`}
  }
  return isRecord(parsed) ? {data: parsed} : {error: 'frontmatter is not a YAML mapping'}
}

function checkText(fm: Frontmatter, key: string): string | undefined {
  const value = fm[key]
  return typeof value === 'string' && value.trim() !== '' ? undefined : `${key}: must be a non-empty string`
}

function checkEnum(fm: Frontmatter, key: string, allowed: readonly string[], required: boolean): string | undefined {
  const value = fm[key]
  if (value === undefined || value === null) return required ? `${key}: required field is missing` : undefined
  return isOneOf(allowed, value) ? undefined : `${key}: ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`
}

function checkDate(fm: Frontmatter, key: string, required: boolean): string | undefined {
  const value = fm[key]
  if (value === undefined || value === null) return required ? `${key}: required field is missing` : undefined
  return isIsoDate(value) ? undefined : `${key}: ${JSON.stringify(value)} is not a valid YYYY-MM-DD date`
}

// Compares only when `date` itself is valid, so one bad date reports one error.
function checkDateMatchesFilename(fm: Frontmatter, relPath: string, filenameRe: RegExp): string | undefined {
  const fileDate = filenameRe.exec(basename(relPath))?.[1]
  if (fileDate === undefined) return 'filename: no YYYY-MM-DD date found'
  return fm.date === fileDate ? undefined : `date: ${JSON.stringify(fm.date)} does not match filename date ${fileDate}`
}

function checkModule(fm: Frontmatter, repoRoot: string): string | undefined {
  const value = fm.module
  if (typeof value !== 'string' || value.trim() === '') return 'module: must be a non-empty string'
  if (isOneOf(MODULE_NAMES, value)) return undefined
  // A literal repo-relative file or directory path; no globs, no escaping the repo root.
  const segments = value.split('/')
  const isRepoRelative = !value.startsWith('/') && segments.every(s => s !== '' && s !== '.' && s !== '..')
  if (isRepoRelative && existsSync(resolve(repoRoot, value))) return undefined
  return `module: ${JSON.stringify(value)} is not an existing repo path or one of ${MODULE_NAMES.join(', ')}`
}

function compact(messages: (string | undefined)[]): string[] {
  return messages.filter((message): message is string => message !== undefined)
}

export function validateSolution(fm: Frontmatter, relPath: string, repoRoot = REPO_ROOT): string[] {
  const dateError = checkDate(fm, 'date', true)
  const problemType = fm.problem_type
  const expectedDir = isOneOf(PROBLEM_TYPES, problemType) ? PROBLEM_TYPE_DIRS[problemType] : undefined
  const {last_updated: lastUpdated, date} = fm
  return compact([
    checkText(fm, 'title'),
    dateError ?? checkDateMatchesFilename(fm, relPath, TRAILING_DATE_RE),
    checkEnum(fm, 'problem_type', PROBLEM_TYPES, true),
    expectedDir !== undefined && dirname(relPath) !== `docs/solutions/${expectedDir}`
      ? `problem_type: ${String(problemType)} belongs in docs/solutions/${expectedDir}/, found in ${dirname(relPath)}/`
      : undefined,
    checkEnum(fm, 'component', COMPONENTS, true),
    checkEnum(fm, 'severity', SEVERITIES, true),
    checkModule(fm, repoRoot),
    checkEnum(fm, 'root_cause', ROOT_CAUSES, false),
    checkEnum(fm, 'resolution_type', RESOLUTION_TYPES, false),
    checkDate(fm, 'last_updated', false) ??
      (isIsoDate(lastUpdated) && isIsoDate(date) && lastUpdated < date
        ? `last_updated: ${lastUpdated} is earlier than date ${date}`
        : undefined),
  ])
}

export function validatePlan(fm: Frontmatter, relPath: string): string[] {
  return compact([
    checkText(fm, 'title'),
    checkEnum(fm, 'type', PLAN_TYPES, true),
    checkEnum(fm, 'status', PLAN_STATUSES, true),
    checkDate(fm, 'date', true) ?? checkDateMatchesFilename(fm, relPath, LEADING_DATE_RE),
    checkDate(fm, 'deepened', false),
  ])
}

export function validateBrainstorm(fm: Frontmatter, relPath: string): string[] {
  return compact([
    checkDate(fm, 'date', true) ?? checkDateMatchesFilename(fm, relPath, LEADING_DATE_RE),
    checkText(fm, 'topic'),
    checkEnum(fm, 'status', BRAINSTORM_STATUSES, false),
  ])
}

/**
 * Returns `path: message` for every schema violation in one doc. `relPath` is repo-relative, forward-slashed;
 * `repoRoot` is where a solution's `module` path must exist.
 */
export function validateDoc(relPath: string, text: string, repoRoot = REPO_ROOT): string[] {
  const parsed = parseFrontmatter(text)
  let messages: string[]
  if ('error' in parsed) messages = [parsed.error]
  else if (relPath.startsWith('docs/solutions/')) messages = validateSolution(parsed.data, relPath, repoRoot)
  else if (relPath.startsWith('docs/plans/')) messages = validatePlan(parsed.data, relPath)
  else if (relPath.startsWith('docs/brainstorms/')) messages = validateBrainstorm(parsed.data, relPath)
  else messages = ['not under a known docs family']
  return messages.map(message => `${relPath}: ${message}`)
}
