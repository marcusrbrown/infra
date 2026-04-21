import {relative, resolve} from 'node:path'
import {describe, expect, it} from 'bun:test'
import {parse as parseYaml} from 'yaml'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const INTERNAL_ORGS = new Set(['marcusrbrown'])
const ALLOWED_SHELL_SCRIPTS = new Set(['apps/keeweb/deploy.sh'])

// Accepted version-comment forms on SHA-pinned `uses:` lines:
//   # v6.0.2                        (semver tag)
//   # renovate-changesets@0.2.31    (scoped release tag)
const VERSION_COMMENT_RE = /^#\s+(?:v\d+(?:\.\d+){0,2}|[\w@/-]+@\d+(?:\.\d+){0,2})\s*$/

// Match `[- ]uses: owner/repo@<sha>[ trailing]` — step-level (indented, possibly dash-prefixed) and job-level.
// Uses [ \t] instead of \s to avoid regex backtracking ambiguity between overlapping quantifiers.
const USES_SHA_LINE_RE = /^[ \t]+(?:-[ \t]+)?uses:[ \t]+(\S+)@([a-f0-9]{7,})(?:[ \t]+(\S.*))?$/

interface Violation {
  file: string
  detail: string
}

// `.github/` is a dot-directory; Bun.Glob skips dot-dirs by default, so every
// glob that traverses `.github/` must pass `{ dot: true }`. Without it, the
// workflow rules silently pass on an empty file set. The tripwire test at the
// top of the suite asserts the file count is >= 1 to catch this regression.
function listWorkflowFiles(extension: '.yaml' | '.yml'): string[] {
  const glob = new Bun.Glob(`.github/workflows/*${extension}`)
  return [...glob.scanSync({cwd: REPO_ROOT, absolute: true, dot: true})]
}

function listPackageJsonFiles(): string[] {
  // Bun.Glob auto-excludes node_modules/** by default; no package.json lives under dot-dirs.
  const glob = new Bun.Glob('**/package.json')
  return [...glob.scanSync({cwd: REPO_ROOT, absolute: true})].filter(f => !f.includes('/node_modules/'))
}

function listShellScriptFiles(): string[] {
  const glob = new Bun.Glob('**/*.sh')
  return [...glob.scanSync({cwd: REPO_ROOT, absolute: true})].filter(
    f => !f.includes('/node_modules/') && !f.includes('/.cache/') && !f.includes('/dist/'),
  )
}

/**
 * Detect cross-org `secrets: inherit` on reusable-workflow job calls.
 *
 * Rules:
 *   - Jobs without a `uses:` string are step-based and out of scope.
 *   - `uses:` values starting with `./` or `../` are local reusable workflows; `secrets: inherit` is legitimate.
 *   - `uses:` values whose owner (first path segment) is in INTERNAL_ORGS are same-org; `secrets: inherit` is legitimate.
 *   - Everything else is cross-org and must not use `secrets: inherit`.
 */
export function findCrossOrgSecretsInherit(parsed: unknown): {jobId: string; uses: string}[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const jobs = (parsed as {jobs?: Record<string, unknown>}).jobs
  if (typeof jobs !== 'object' || jobs === null) return []

  const violations: {jobId: string; uses: string}[] = []
  for (const [jobId, jobRaw] of Object.entries(jobs)) {
    if (typeof jobRaw !== 'object' || jobRaw === null) continue
    const job = jobRaw as {uses?: unknown; secrets?: unknown}
    if (typeof job.uses !== 'string') continue
    if (job.uses.startsWith('./') || job.uses.startsWith('../')) continue
    const owner = job.uses.split('/')[0] ?? ''
    if (INTERNAL_ORGS.has(owner)) continue
    if (job.secrets === 'inherit') {
      violations.push({jobId, uses: job.uses})
    }
  }
  return violations
}

describe('repo conventions', () => {
  it('tripwire: workflow glob resolves to at least one file (catches dot-dir glob regressions)', () => {
    const workflows = listWorkflowFiles('.yaml')
    expect(workflows.length).toBeGreaterThan(0)
  })

  it('no `bundledDependencies` in any package.json', async () => {
    const files = listPackageJsonFiles()
    const offenders: string[] = []
    for (const file of files) {
      const json = (await Bun.file(file).json()) as Record<string, unknown>
      if ('bundledDependencies' in json) {
        offenders.push(relative(REPO_ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it("apps/keeweb/config/config.json has settings.dropboxSecret === ''", async () => {
    const configPath = resolve(REPO_ROOT, 'apps/keeweb/config/config.json')
    const config = (await Bun.file(configPath).json()) as {
      settings?: {dropboxSecret?: unknown}
    }
    expect(config.settings?.dropboxSecret).toBe('')
  })

  it('no `secrets: inherit` on any job whose `uses:` points to a cross-org workflow', async () => {
    const files = listWorkflowFiles('.yaml')
    const violations: Violation[] = []
    for (const file of files) {
      const text = await Bun.file(file).text()
      const parsed = parseYaml(text, {merge: true})
      for (const v of findCrossOrgSecretsInherit(parsed)) {
        violations.push({
          file: relative(REPO_ROOT, file),
          detail: `job '${v.jobId}' uses '${v.uses}' with secrets: inherit`,
        })
      }
    }
    expect(violations).toEqual([])
  })

  it('no `ssh-keyscan` under .github/workflows/**', async () => {
    const files = listWorkflowFiles('.yaml')
    const violations: Violation[] = []
    for (const file of files) {
      const text = await Bun.file(file).text()
      const lines = text.split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if (/\bssh-keyscan\b/.test(line)) {
          violations.push({
            file: relative(REPO_ROOT, file),
            detail: `line ${index + 1}: ${line.trim()}`,
          })
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('every SHA-pinned `uses:` line has a trailing `# vX.Y.Z` or `# scope@X.Y.Z` comment', async () => {
    const files = listWorkflowFiles('.yaml')
    const violations: Violation[] = []
    for (const file of files) {
      const text = await Bun.file(file).text()
      const lines = text.split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        const match = line.match(USES_SHA_LINE_RE)
        if (!match) continue
        const [, ref = '', sha = '', tail] = match
        const shortSha = sha.slice(0, 7)
        if (tail === undefined) {
          violations.push({
            file: relative(REPO_ROOT, file),
            detail: `line ${index + 1}: missing version comment on '${ref}@${shortSha}…'`,
          })
        } else if (!VERSION_COMMENT_RE.test(tail.trim())) {
          violations.push({
            file: relative(REPO_ROOT, file),
            detail: `line ${index + 1}: malformed version comment '${tail.trim()}' on '${ref}@${shortSha}…'`,
          })
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('no `.yml` files under .github/workflows/ (use `.yaml`)', () => {
    const files = listWorkflowFiles('.yml')
    expect(files.map(f => relative(REPO_ROOT, f))).toEqual([])
  })

  it('no `.sh` files outside `apps/keeweb/deploy.sh`', () => {
    const files = listShellScriptFiles()
    const offenders = files.map(f => relative(REPO_ROOT, f)).filter(f => !ALLOWED_SHELL_SCRIPTS.has(f))
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (enforced) marker drift detection
// ---------------------------------------------------------------------------
//
// Every bullet in AGENTS.md tagged `(enforced)` must map to a known
// enforcement mechanism (test or ESLint rule). Adding `(enforced)` without
// backing enforcement, or deleting the enforcement while keeping the marker,
// both cause a test failure here.
//
// Manifest keys are unique substrings of the AGENTS.md bullet text.
// Values describe where the enforcement lives — they are documentation only.
const ENFORCED_MANIFEST: Record<string, string> = {
  'Only bash script': 'conventions.test.ts: no .sh files outside apps/keeweb/deploy.sh',
  'GitHub Actions': 'conventions.test.ts: .yaml extension + SHA-pin version comment',
  'Cross-org reusable workflows': 'conventions.test.ts: no secrets: inherit on cross-org jobs',
  'as any': 'eslint.config.ts: @typescript-eslint/no-explicit-any + ban-ts-comment at error',
  'No secret values in tracked files': 'conventions.test.ts: settings.dropboxSecret === empty string',
  'ssh-keyscan': 'conventions.test.ts: no ssh-keyscan under .github/workflows/**',
  'Never `secrets: inherit`': 'conventions.test.ts: no secrets: inherit on cross-org jobs',
  bundledDependencies: 'conventions.test.ts: no bundledDependencies in any package.json',
}

describe('(enforced) marker drift', () => {
  it('every (enforced) bullet in AGENTS.md is accounted for in the enforcement manifest', async () => {
    const agentsMd = await Bun.file(resolve(REPO_ROOT, 'AGENTS.md')).text()
    const enforcedLines = agentsMd.split(/\r?\n/).filter((l: string) => /\(enforced\)/.test(l))

    // Tripwire — if the grep logic breaks, the whole suite silently passes with 0 checks
    expect(enforcedLines.length).toBeGreaterThan(0)

    const unmatched = enforcedLines.filter(
      (line: string) => !Object.keys(ENFORCED_MANIFEST).some((key: string) => line.includes(key)),
    )
    expect(unmatched, 'New (enforced) bullet has no manifest entry — add enforcement before tagging').toEqual([])
  })

  it('every manifest entry corresponds to an actual (enforced) bullet in AGENTS.md', async () => {
    const agentsMd = await Bun.file(resolve(REPO_ROOT, 'AGENTS.md')).text()
    const enforcedLines = agentsMd.split(/\r?\n/).filter((l: string) => /\(enforced\)/.test(l))

    const stale = Object.keys(ENFORCED_MANIFEST).filter(
      (key: string) => !enforcedLines.some((l: string) => l.includes(key)),
    )
    expect(stale, 'Manifest entry has no matching (enforced) bullet in AGENTS.md — remove or update').toEqual([])
  })

  it('@typescript-eslint/no-explicit-any is configured at error severity in eslint.config.ts', async () => {
    const eslintConfig = await Bun.file(resolve(REPO_ROOT, 'eslint.config.ts')).text()
    // Matches: '@typescript-eslint/no-explicit-any': 'error'
    expect(eslintConfig).toMatch(/'@typescript-eslint\/no-explicit-any'\s*:\s*'error'/)
  })

  it('@typescript-eslint/ban-ts-comment is configured in eslint.config.ts', async () => {
    const eslintConfig = await Bun.file(resolve(REPO_ROOT, 'eslint.config.ts')).text()
    expect(eslintConfig).toContain('@typescript-eslint/ban-ts-comment')
  })
})

// ---------------------------------------------------------------------------
// Per-app invariants
// ---------------------------------------------------------------------------
//
// Guard that critical safety mechanisms in each app are not accidentally
// removed. These are the runtime equivalents of (enforced) markers: code that
// must remain present for the documented behaviour to hold.

describe('per-app invariants', () => {
  it('cliproxy deploy.ts guards config.yaml upload with a remoteFileExists() check', async () => {
    const deployTs = await Bun.file(resolve(REPO_ROOT, 'apps/cliproxy/src/deploy.ts')).text()
    // The guard: remoteFileExists(host, `${REMOTE_DIR}/config/config.yaml`, env)
    // This prevents overwriting runtime API keys on the server.
    expect(deployTs).toContain('remoteFileExists')
    expect(deployTs).toContain('config.yaml')
  })

  it('keeweb build.ts defines an EXPECTED_SHA256 constant for archive integrity', async () => {
    const buildTs = await Bun.file(resolve(REPO_ROOT, 'apps/keeweb/src/build.ts')).text()
    // EXPECTED_SHA256 is the KeeWeb release zip checksum; its presence proves
    // SHA verification is wired in and was not accidentally stripped.
    expect(buildTs).toMatch(/const\s+EXPECTED_SHA256\s*=/)
  })
})

describe('findCrossOrgSecretsInherit', () => {
  it('flags a cross-org reusable workflow that uses `secrets: inherit`', () => {
    const parsed = parseYaml(`
jobs:
  build:
    uses: bfra-me/.github/.github/workflows/example.yaml@abc1234
    secrets: inherit
`)
    const violations = findCrossOrgSecretsInherit(parsed)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.jobId).toBe('build')
    expect(violations[0]?.uses).toContain('bfra-me/')
  })

  it('allows a same-org reusable workflow to use `secrets: inherit`', () => {
    const parsed = parseYaml(`
jobs:
  release:
    uses: marcusrbrown/infra/.github/workflows/release.yaml@sha
    secrets: inherit
`)
    expect(findCrossOrgSecretsInherit(parsed)).toEqual([])
  })

  it('allows a local (./) reusable workflow to use `secrets: inherit`', () => {
    const parsed = parseYaml(`
jobs:
  build:
    uses: ./.github/workflows/local.yaml
    secrets: inherit
`)
    expect(findCrossOrgSecretsInherit(parsed)).toEqual([])
  })

  it('ignores `secrets: inherit` strings appearing inside prose block scalars', () => {
    // Mirrors fro-bot.yaml: SCHEDULE_PROMPT contains the literal string
    // `secrets: inherit` inside a prompt heredoc, but no job-level key exists.
    const parsed = parseYaml(`
env:
  SCHEDULE_PROMPT: |
    Remember: never use secrets: inherit with cross-org workflows.
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`)
    expect(findCrossOrgSecretsInherit(parsed)).toEqual([])
  })

  it('does not flag jobs without a `uses:` key (step-based jobs)', () => {
    const parsed = parseYaml(`
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`)
    expect(findCrossOrgSecretsInherit(parsed)).toEqual([])
  })
})
