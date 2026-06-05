import {relative, resolve} from 'node:path'
import {describe, expect, it} from 'bun:test'
import {parse as parseYaml} from 'yaml'
import {MCP_ALLOWLIST} from './commands/mcp'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const INTERNAL_ORGS = new Set(['marcusrbrown'])
const ALLOWED_SHELL_SCRIPTS = new Set(['apps/keeweb/deploy.sh'])

// ---------------------------------------------------------------------------
// MCP drift-guard: sensitive tool set (two-layer security model)
// ---------------------------------------------------------------------------
//
// These 6 commands are source-gated: they are NOT in MCP_ALLOWLIST and are
// therefore never registered as MCP tools. They remain CLI-only.
//
// WHY each is source-gated (primary layer — MCP_ALLOWLIST exclusion):
//   cliproxy keys add    — mutating: creates live bearer tokens on the proxy
//   cliproxy keys remove — mutating: revokes live bearer tokens
//   cliproxy config set  — mutating: overwrites CLIProxyAPI runtime config
//   gateway backup       — secret-bearing: writes CA private key material to a tarball
//   cliproxy keys list   — secret-disclosing: prints live bearer tokens in plaintext
//   cliproxy config get  — secret-disclosing: dumps management config incl. management key
//
// Defense-in-depth (secondary layer — opencode.jsonc `permission: deny`):
// Even if MCP_ALLOWLIST were mistakenly re-expanded, opencode's native tool
// permission check provides a backstop that denies these tool calls centrally
// before execution. Both layers must stay in sync; the test below enforces it.
//
// A conventions test below asserts every entry (a) is NOT in MCP_ALLOWLIST
// (source-gated out) and (b) is still denied in opencode.jsonc under the
// prefixed tool id (defense-in-depth backstop).
const SENSITIVE_MCP_COMMANDS: readonly string[] = [
  'cliproxy keys add',
  'cliproxy keys remove',
  'cliproxy config set',
  'gateway backup',
  'cliproxy keys list',
  'cliproxy config get',
]

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

/**
 * Detect dorny/paths-filter steps that use negation patterns without declaring
 * `predicate-quantifier: every`. The default quantifier (`some`) applies OR-logic
 * across patterns, which silently makes negations truthy whenever any other file
 * matches — the opposite of the intended behaviour.
 *
 * Rule: any step using dorny/paths-filter that contains a filter pattern starting
 * with `!` MUST also set `predicate-quantifier: every` in the same step's `with:` block.
 */
export interface PathsFilterQuantifierViolation {
  file?: string
  jobId: string
  stepIndex: number
  reason: string
}

export function findPathsFilterQuantifierViolations(workflowText: string): PathsFilterQuantifierViolation[] {
  const parsed = parseYaml(workflowText, {merge: true}) as unknown
  if (typeof parsed !== 'object' || parsed === null) return []
  const jobs = (parsed as {jobs?: Record<string, unknown>}).jobs
  if (typeof jobs !== 'object' || jobs === null) return []

  const violations: PathsFilterQuantifierViolation[] = []

  for (const [jobId, jobRaw] of Object.entries(jobs)) {
    if (typeof jobRaw !== 'object' || jobRaw === null) continue
    const job = jobRaw as {steps?: unknown[]}
    if (!Array.isArray(job.steps)) continue

    for (const [index, stepRaw] of job.steps.entries()) {
      if (typeof stepRaw !== 'object' || stepRaw === null) continue
      const step = stepRaw as {uses?: unknown; with?: Record<string, unknown>}
      if (typeof step.uses !== 'string') continue
      if (!step.uses.startsWith('dorny/paths-filter')) continue

      const withBlock = step.with ?? {}
      const filtersRaw = withBlock.filters
      if (typeof filtersRaw !== 'string') continue

      // Parse the inner YAML of the filters block to inspect pattern lists
      const filters = parseYaml(filtersRaw, {merge: true}) as unknown
      if (typeof filters !== 'object' || filters === null) continue

      let hasNegation = false
      for (const patternsRaw of Object.values(filters as Record<string, unknown>)) {
        const patterns = Array.isArray(patternsRaw) ? patternsRaw : [patternsRaw]
        for (const p of patterns) {
          if (typeof p === 'string' && p.startsWith('!')) {
            hasNegation = true
            break
          }
        }
        if (hasNegation) break
      }

      if (!hasNegation) continue

      const quantifier = withBlock['predicate-quantifier']
      if (quantifier !== 'every') {
        violations.push({
          jobId,
          stepIndex: index,
          reason:
            quantifier === undefined
              ? `job '${jobId}' step ${index} uses dorny/paths-filter with negation patterns but is missing predicate-quantifier: every`
              : `job '${jobId}' step ${index} uses dorny/paths-filter with negation patterns but predicate-quantifier is '${String(quantifier)}' (must be 'every')`,
        })
      }
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

  it('opencode.jsonc mcp.infra.command uses local repo source (not bunx published package)', async () => {
    const jsoncText = await Bun.file(resolve(REPO_ROOT, 'opencode.jsonc')).text()
    const stripped = jsoncText
      .split('\n')
      .map(line => (/^\s*\/\//.test(line) ? '' : line))
      .join('\n')
      .replaceAll(/,(\s*[}\]])/g, '$1')
    const opencode = JSON.parse(stripped) as {mcp?: {infra?: {command?: unknown}}}

    const infraCommand = opencode.mcp?.infra?.command
    expect(Array.isArray(infraCommand), 'mcp.infra.command must be an array').toBe(true)

    const cmd = infraCommand as string[]
    expect(
      cmd,
      'mcp.infra.command must be ["bun", "run", "packages/cli/src/cli.ts", "mcp"] — use local source, not bunx',
    ).toEqual(['bun', 'run', 'packages/cli/src/cli.ts', 'mcp'])

    // Explicit regression guard: bunx @marcusrbrown/infra resolves stale published
    // package cache and exits before the MCP handshake, causing connection closed.
    expect(cmd.join(' ')).not.toContain('bunx')
    expect(cmd.join(' ')).not.toContain('@marcusrbrown/infra')
  })

  it('gates every sensitive infra MCP tool in opencode.jsonc', async () => {
    // Parse opencode.jsonc tolerantly: it uses JSONC syntax (// line comments,
    // trailing commas). Strategy:
    //   1. Strip full-line comments — lines whose first non-whitespace is `//`.
    //      This avoids breaking the `https://` in the $schema string value.
    //   2. Strip trailing commas before `}` or `]`.
    //   3. JSON.parse the result.
    const jsoncText = await Bun.file(resolve(REPO_ROOT, 'opencode.jsonc')).text()
    const stripped = jsoncText
      .split('\n')
      .map(line => (/^\s*\/\//.test(line) ? '' : line))
      .join('\n')
      .replaceAll(/,(\s*[}\]])/g, '$1')
    const opencode = JSON.parse(stripped) as {permission?: Record<string, unknown>}

    // Parse sanity: permission block must be present (catches a broken parse).
    // opencode permission-checks MCP tool calls via the `permission` map (tool ids
    // `<server>_<tool>`); we assert the canonical `permission: "deny"` form here.
    const permission = opencode.permission ?? {}
    expect(Object.keys(permission).length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const cmd of SENSITIVE_MCP_COMMANDS) {
      // (a) Primary gate: the command must NOT be in MCP_ALLOWLIST (source-gated out).
      //     If someone re-adds it to the allowlist, this catches the regression immediately.
      if (MCP_ALLOWLIST.has(cmd)) {
        violations.push(
          `'${cmd}' is in SENSITIVE_MCP_COMMANDS AND in MCP_ALLOWLIST — source-gate regression: remove it from MCP_ALLOWLIST`,
        )
      }
      // (b) Defense-in-depth backstop: the tool must still be denied in opencode.jsonc.
      //     This catches the case where MCP_ALLOWLIST is mistakenly re-expanded.
      //     The infra MCP server converts command names to tool names with underscores,
      //     and OpenCode prefixes with the server name, giving "infra_<underscored>".
      const toolId = `infra_${cmd.replaceAll(' ', '_')}`
      if (permission[toolId] !== 'deny') {
        violations.push(
          `${toolId}: not denied in opencode.jsonc permission (found: ${JSON.stringify(permission[toolId])}) — defense-in-depth backstop missing`,
        )
      }
    }
    expect(
      violations,
      `Sensitive infra MCP tools must be source-gated (not in MCP_ALLOWLIST) and denied in opencode.jsonc:\n${violations.join('\n')}`,
    ).toEqual([])
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

describe('findPathsFilterQuantifierViolations', () => {
  it('paths-filter with negations and predicate-quantifier: every → 0 violations', () => {
    const yaml = `
jobs:
  detect:
    runs-on: ubuntu-latest
    steps:
      - uses: dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d # v4.0.1
        with:
          predicate-quantifier: every
          filters: |
            app:
              - 'apps/myapp/**'
              - '!apps/myapp/**/*.md'
`
    expect(findPathsFilterQuantifierViolations(yaml)).toEqual([])
  })

  it('paths-filter with negations and missing predicate-quantifier → 1 violation', () => {
    const yaml = `
jobs:
  detect:
    runs-on: ubuntu-latest
    steps:
      - uses: dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d # v4.0.1
        with:
          filters: |
            app:
              - 'apps/myapp/**'
              - '!apps/myapp/**/*.md'
`
    const violations = findPathsFilterQuantifierViolations(yaml)
    expect(violations).toEqual([
      {
        jobId: 'detect',
        stepIndex: 0,
        reason: `job 'detect' step 0 uses dorny/paths-filter with negation patterns but is missing predicate-quantifier: every`,
      },
    ])
  })

  it('paths-filter with negations and predicate-quantifier: some → 1 violation', () => {
    const yaml = `
jobs:
  detect:
    runs-on: ubuntu-latest
    steps:
      - uses: dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d # v4.0.1
        with:
          predicate-quantifier: some
          filters: |
            app:
              - 'apps/myapp/**'
              - '!apps/myapp/**/*.md'
`
    const violations = findPathsFilterQuantifierViolations(yaml)
    expect(violations).toEqual([
      {
        jobId: 'detect',
        stepIndex: 0,
        reason: `job 'detect' step 0 uses dorny/paths-filter with negation patterns but predicate-quantifier is 'some' (must be 'every')`,
      },
    ])
  })

  it('paths-filter without negations → 0 violations regardless of quantifier', () => {
    const yaml = `
jobs:
  detect:
    runs-on: ubuntu-latest
    steps:
      - uses: dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d # v4.0.1
        with:
          filters: |
            app:
              - 'apps/myapp/**'
              - 'apps/myapp/**/*.ts'
`
    expect(findPathsFilterQuantifierViolations(yaml)).toEqual([])
  })

  it('bare-string negation filter without predicate-quantifier → 1 violation', () => {
    const yaml = `
jobs:
  detect:
    runs-on: ubuntu-latest
    steps:
      - uses: dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d # v4.0.1
        with:
          filters: |
            cliproxy: '!apps/cliproxy/**/*.md'
`
    const violations = findPathsFilterQuantifierViolations(yaml)
    expect(violations).toEqual([
      {
        jobId: 'detect',
        stepIndex: 0,
        reason: `job 'detect' step 0 uses dorny/paths-filter with negation patterns but is missing predicate-quantifier: every`,
      },
    ])
  })

  it('bare-string negation filter with predicate-quantifier: every → 0 violations', () => {
    const yaml = `
jobs:
  detect:
    runs-on: ubuntu-latest
    steps:
      - uses: dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d # v4.0.1
        with:
          predicate-quantifier: every
          filters: |
            cliproxy: '!apps/cliproxy/**/*.md'
`
    expect(findPathsFilterQuantifierViolations(yaml)).toEqual([])
  })
})

describe('dorny/paths-filter quantifier guard', () => {
  it('tripwire: workflow glob resolves to at least one file (catches dot-dir glob regressions)', () => {
    // `.github/` is a dot-directory; Bun.Glob skips dot-dirs by default unless `dot: true` is set.
    const glob = new Bun.Glob('.github/workflows/**')
    const files = [...glob.scanSync({cwd: REPO_ROOT, absolute: true, dot: true})]
    expect(files.length).toBeGreaterThan(0)
  })

  it('all workflow files using dorny/paths-filter with negations declare predicate-quantifier: every', async () => {
    const files = listWorkflowFiles('.yaml')
    expect(files.length).toBeGreaterThan(0)

    const violations: PathsFilterQuantifierViolation[] = []
    for (const file of files) {
      const text = await Bun.file(file).text()
      for (const v of findPathsFilterQuantifierViolations(text)) {
        violations.push({...v, file: relative(REPO_ROOT, file)})
      }
    }
    expect(violations).toEqual([])
  })
})
