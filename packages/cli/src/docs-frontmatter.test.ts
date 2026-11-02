import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {validateDoc} from '@marcusrbrown/infra-shared/docs/frontmatter'
import {describe, expect, it} from 'bun:test'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

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
