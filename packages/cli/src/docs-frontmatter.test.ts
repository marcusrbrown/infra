import {existsSync, readFileSync} from 'node:fs'
import {basename, dirname, resolve} from 'node:path'
import {describe, expect, it} from 'bun:test'
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

type Frontmatter = Record<string, unknown>

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

function parseFrontmatter(text: string): {data: Frontmatter} | {error: string} {
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

function checkModule(fm: Frontmatter): string | undefined {
  const value = fm.module
  if (typeof value !== 'string' || value.trim() === '') return 'module: must be a non-empty string'
  if (isOneOf(MODULE_NAMES, value)) return undefined
  // A literal repo-relative file or directory path; no globs, no escaping the repo root.
  const segments = value.split('/')
  const isRepoRelative = !value.startsWith('/') && segments.every(s => s !== '' && s !== '.' && s !== '..')
  if (isRepoRelative && existsSync(resolve(REPO_ROOT, value))) return undefined
  return `module: ${JSON.stringify(value)} is not an existing repo path or one of ${MODULE_NAMES.join(', ')}`
}

function compact(messages: (string | undefined)[]): string[] {
  return messages.filter((message): message is string => message !== undefined)
}

function validateSolution(fm: Frontmatter, relPath: string): string[] {
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
    checkModule(fm),
    checkEnum(fm, 'root_cause', ROOT_CAUSES, false),
    checkEnum(fm, 'resolution_type', RESOLUTION_TYPES, false),
    checkDate(fm, 'last_updated', false) ??
      (isIsoDate(lastUpdated) && isIsoDate(date) && lastUpdated < date
        ? `last_updated: ${lastUpdated} is earlier than date ${date}`
        : undefined),
  ])
}

function validatePlan(fm: Frontmatter, relPath: string): string[] {
  return compact([
    checkText(fm, 'title'),
    checkEnum(fm, 'type', PLAN_TYPES, true),
    checkEnum(fm, 'status', PLAN_STATUSES, true),
    checkDate(fm, 'date', true) ?? checkDateMatchesFilename(fm, relPath, LEADING_DATE_RE),
    checkDate(fm, 'deepened', false),
  ])
}

function validateBrainstorm(fm: Frontmatter, relPath: string): string[] {
  return compact([
    checkDate(fm, 'date', true) ?? checkDateMatchesFilename(fm, relPath, LEADING_DATE_RE),
    checkText(fm, 'topic'),
    checkEnum(fm, 'status', BRAINSTORM_STATUSES, false),
  ])
}

/** Returns `path: message` for every schema violation in one doc. `relPath` is repo-relative, forward-slashed. */
function validateDoc(relPath: string, text: string): string[] {
  const parsed = parseFrontmatter(text)
  let messages: string[]
  if ('error' in parsed) messages = [parsed.error]
  else if (relPath.startsWith('docs/solutions/')) messages = validateSolution(parsed.data, relPath)
  else if (relPath.startsWith('docs/plans/')) messages = validatePlan(parsed.data, relPath)
  else if (relPath.startsWith('docs/brainstorms/')) messages = validateBrainstorm(parsed.data, relPath)
  else messages = ['not under a known docs family']
  return messages.map(message => `${relPath}: ${message}`)
}

function collectViolations(pattern: string): string[] {
  const files = [...new Bun.Glob(pattern).scanSync({cwd: REPO_ROOT})].toSorted()
  expect(files.length, `${pattern} matched no files (glob regression?)`).toBeGreaterThan(0)
  return files.flatMap(file => validateDoc(file, readFileSync(resolve(REPO_ROOT, file), 'utf8')))
}

describe('docs frontmatter schema (repo docs)', () => {
  it.each(['docs/solutions/**/*.md', 'docs/plans/*.md', 'docs/brainstorms/*.md'])('%s conforms', pattern => {
    const violations = collectViolations(pattern)
    expect(violations, `${violations.length} violation(s):\n${violations.join('\n')}`).toEqual([])
  })
})

describe('docs frontmatter validator', () => {
  const fm = (fields: Record<string, string | undefined>): string =>
    `---\n${Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')}\n---\n\n# Body\n`

  const SOLUTION_PATH = 'docs/solutions/best-practices/example-2026-06-20.md'
  const PLAN_PATH = 'docs/plans/2026-06-20-001-feat-example-plan.md'
  const BRAINSTORM_PATH = 'docs/brainstorms/2026-06-20-example-requirements.md'
  const solution = (extra: Record<string, string | undefined> = {}) =>
    fm({
      title: '"Example"',
      date: '2026-06-20',
      problem_type: 'best_practice',
      component: 'tooling',
      severity: 'low',
      module: 'apps/gateway',
      ...extra,
    })
  const plan = (extra: Record<string, string | undefined> = {}) =>
    fm({title: '"feat: Example"', type: 'feat', status: 'active', date: '2026-06-20', ...extra})
  const brainstorm = (extra: Record<string, string | undefined> = {}) =>
    fm({date: '2026-06-20', topic: 'example', ...extra})

  it('accepts valid docs, including optional fields and legacy category', () => {
    expect(validateDoc(SOLUTION_PATH, solution())).toEqual([])
    expect(
      validateDoc(
        SOLUTION_PATH,
        solution({
          root_cause: 'config_error',
          resolution_type: 'code_fix',
          last_updated: '2026-06-21',
          category: 'whatever',
          module: 'agent-storage',
        }),
      ),
    ).toEqual([])
    // Knowledge-track types without their own directory share best-practices/.
    expect(validateDoc(SOLUTION_PATH, solution({problem_type: 'tooling_decision'}))).toEqual([])
    expect(validateDoc(PLAN_PATH, plan({deepened: '2026-06-21'}))).toEqual([])
    expect(validateDoc(BRAINSTORM_PATH, brainstorm({status: 'superseded'}))).toEqual([])
    expect(validateDoc(BRAINSTORM_PATH, brainstorm({status: undefined}))).toEqual([])
    // module: existing repo file, existing repo dir (apps/gateway is the default above), or a named alias.
    for (const module of ['opencode.jsonc', '.github/workflows/release.yaml', 'packages/cli', 'infra']) {
      expect(validateDoc(SOLUTION_PATH, solution({module}))).toEqual([])
    }
  })

  const rejected: [name: string, path: string, text: string, field: string][] = [
    ['no frontmatter', SOLUTION_PATH, '# Just a heading\n', 'missing YAML frontmatter block'],
    ['unquoted ": " in title', PLAN_PATH, plan({title: 'feat: Example'}), 'frontmatter is not valid YAML'],
    ['empty title', SOLUTION_PATH, solution({title: '""'}), 'title'],
    ['solution date != filename', SOLUTION_PATH, solution({date: '2026-06-19'}), 'date'],
    ['malformed date', SOLUTION_PATH, solution({date: '2026-13-45'}), 'date'],
    ['missing problem_type', SOLUTION_PATH, solution({problem_type: undefined}), 'problem_type'],
    ['unknown problem_type', SOLUTION_PATH, solution({problem_type: 'vibes'}), 'problem_type'],
    ['wrong directory', 'docs/solutions/workflow-issues/example-2026-06-20.md', solution(), 'problem_type'],
    ['unknown component', SOLUTION_PATH, solution({component: 'kitchen_sink'}), 'component'],
    ['unknown severity', SOLUTION_PATH, solution({severity: 'meh'}), 'severity'],
    ['bare gateway module', SOLUTION_PATH, solution({module: 'gateway'}), 'module'],
    ['nonexistent module path', SOLUTION_PATH, solution({module: 'apps/nope'}), 'module'],
    ['module glob', SOLUTION_PATH, solution({module: '"apps/*"'}), 'module'],
    ['module escaping repo root', SOLUTION_PATH, solution({module: '../infra'}), 'module'],
    ['unknown root_cause', SOLUTION_PATH, solution({root_cause: 'gremlins'}), 'root_cause'],
    ['unknown resolution_type', SOLUTION_PATH, solution({resolution_type: 'prayer'}), 'resolution_type'],
    ['last_updated before date', SOLUTION_PATH, solution({last_updated: '2026-06-01'}), 'last_updated'],
    ['plan bad type', PLAN_PATH, plan({type: 'feature'}), 'type'],
    ['plan bad status', PLAN_PATH, plan({status: 'done'}), 'status'],
    ['plan date != filename', PLAN_PATH, plan({date: '2026-06-21'}), 'date'],
    ['plan bad deepened', PLAN_PATH, plan({deepened: 'soon'}), 'deepened'],
    ['brainstorm missing topic', BRAINSTORM_PATH, brainstorm({topic: undefined}), 'topic'],
    ['brainstorm bad status', BRAINSTORM_PATH, brainstorm({status: 'ready-for-planning'}), 'status'],
    ['brainstorm status draft', BRAINSTORM_PATH, brainstorm({status: 'draft'}), 'status'],
    ['brainstorm date != filename', BRAINSTORM_PATH, brainstorm({date: '2026-06-21'}), 'date'],
  ]

  it.each(rejected)('rejects: %s', (_name, path, text, field) => {
    const errors = validateDoc(path, text)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.startsWith(`${path}: ${field}`)).toBe(true)
  })
})
