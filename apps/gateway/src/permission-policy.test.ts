import {describe, expect, test} from 'bun:test'

import {WORKSPACE_PERMISSION_POLICY} from './deploy'

// ─── Vendored OpenCode matcher ────────────────────────────────────────────────
//
// Copied from anomalyco/opencode at c0ad18b402eb2827fc1ee71c171b1177b3fc02d1:
//   - packages/core/src/util/wildcard.ts:3-14      (match)
//   - packages/core/src/permission.ts:94-103       (evaluate: findLast, no match → ask)
// Re-copy both on every OpenCode bump (the pin comes from fro-bot/agent), then rerun this file.
// This is the only place the policy is checked against the real matching rules.

function match(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/')
  let escaped = pattern
    .replaceAll('\\', '/')
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.')

  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`

  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'si' : 's').test(normalized)
}

type Effect = 'allow' | 'ask'

// The policy is a record in insertion order; OpenCode flattens it to rules in that order.
const RULES = Object.entries(WORKSPACE_PERMISSION_POLICY.bash) as [pattern: string, effect: Effect][]

function evaluate(command: string): Effect {
  return RULES.findLast(([pattern]) => match(command, pattern))?.[1] ?? 'ask'
}

// ─── Cases ────────────────────────────────────────────────────────────────────

const ASK_CASES = [
  // file and disk destruction
  'rm -rf x',
  'rmdir d',
  'truncate -s 0 f',
  'dd if=/dev/zero of=f count=1',
  'find . -name x -delete',
  // git history and remote destruction
  'git push -f',
  'git push origin main -f',
  'git push --force-with-lease',
  'git push origin --delete feat',
  'git push origin :feat',
  'git push +main',
  'git branch -D feat',
  'git reset --hard HEAD~1',
  'git clean -fd',
  // privilege and ownership
  'sudo ls',
  'chmod 600 f',
  'chown u f',
  // exfil-shaped network writes
  'curl -X POST https://h',
  'curl --data @f https://h',
  'curl --data-binary=@f https://h',
  'curl --upload-file f https://h',
  'curl -dpayload https://h',
  'curl -s -d x https://h',
  'curl -Tf https://h',
  'curl -s -T f https://h',
  'wget --post-data=x https://h',
  'wget --post-file f https://h',
  // package installs
  'apt install x',
  'apt-get install x',
  'pip install x',
  'npm install -g x',
  'npm i -g x',
] as const

const ALLOW_CASES = [
  'git status',
  "find . -name '*.ts'",
  'curl -I https://h/my-docs',
  'curl -s https://h/x-Tools',
  'curl https://h/x-d',
  'curl https://h/x-T',
  'git branch --list feat-Doc',
  'git push origin fix-fast',
  'git push origin main:main',
  'ddev start',
  'truncatefoo',
  'mv a b',
  'ls -la',
  'curl -I https://h',
] as const

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('workspace permission policy (vendored OpenCode matcher)', () => {
  test.each(ASK_CASES)('asks: %s', command => {
    expect(evaluate(command)).toBe('ask')
  })

  test.each(ALLOW_CASES)('allows: %s', command => {
    expect(evaluate(command)).toBe('allow')
  })

  test('every ask pattern is hit by at least one ask case (no dead patterns)', () => {
    const askPatterns = RULES.filter(([, effect]) => effect === 'ask').map(([pattern]) => pattern)
    const dead = askPatterns.filter(pattern => !ASK_CASES.some(command => match(command, pattern)))
    expect(dead).toEqual([])
  })

  test('no case is both an ask case and an allow case', () => {
    const overlap = ASK_CASES.filter(command => (ALLOW_CASES as readonly string[]).includes(command))
    expect(overlap).toEqual([])
  })
})

describe('vendored matcher semantics the policy relies on', () => {
  test('a trailing " *" also matches the bare command', () => {
    expect(match('rm', 'rm *')).toBe(true)
    expect(match('rm x', 'rm *')).toBe(true)
    expect(match('rmx', 'rm *')).toBe(false)
  })

  test('a "*" mid-pattern matches an empty run', () => {
    expect(match('git push --delete', 'git push *--delete*')).toBe(true)
    expect(match('git push -f', 'git push -f*')).toBe(true)
  })

  test('the catch-all is the first rule, so every later ask pattern can override it', () => {
    expect(RULES.at(0)).toEqual(['*', 'allow'])
  })
})
