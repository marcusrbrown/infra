import {relative, resolve} from 'node:path'
import {describe, expect, it} from 'bun:test'
import {goke} from 'goke'
import {parse as parseYaml} from 'yaml'
import {registerAgentCommands} from './commands/agent'
import {MCP_ALLOWLIST} from './commands/mcp'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const INTERNAL_ORGS = new Set(['marcusrbrown'])
const ALLOWED_SHELL_SCRIPTS = new Set(['apps/keeweb/deploy.sh', 'apps/umami/retention.sh'])
const AGENT_MUTATING_COMMANDS = ['agent setup', 'agent storage', 'agent storage teardown'] as const

// ---------------------------------------------------------------------------
// MCP drift-guard: sensitive tool set (two-layer security model)
// ---------------------------------------------------------------------------
//
// These commands are source-gated: they are NOT in MCP_ALLOWLIST and are
// therefore never registered as MCP tools. They remain CLI-only.
//
// WHY each is source-gated (primary layer — MCP_ALLOWLIST exclusion):
//   cliproxy keys add    — mutating: creates live bearer tokens on the proxy
//   cliproxy keys remove — mutating: revokes live bearer tokens
//   cliproxy config set  — mutating: overwrites CLIProxyAPI runtime config
//   gateway backup       — secret-bearing: writes CA private key material to a tarball
//   cliproxy keys list   — secret-disclosing: prints live bearer tokens in plaintext
//   cliproxy config get  — secret-disclosing: dumps management config incl. management key
//   vpn deploy           — mutating: deploys WireGuard config to live VPN box
//   vpn logs             — sensitive: streams journalctl logs that may reveal peer IPs/traffic
//   vpn client add       — mutating: generates keypair + appends peer + triggers redeploy
//   vpn client list      — sensitive: lists peer public keys and tunnel IPs
//   vpn client remove    — mutating: removes peer + triggers redeploy
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
  // VPN: mutating / sensitive / log-streaming — CLI-only
  'vpn deploy',
  'vpn logs',
  'vpn client add',
  'vpn client list',
  'vpn client remove',
  // Broker: mutating / sensitive — CLI-only
  'broker deploy',
  'broker logs',
  'cliproxy monitor',
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
  it('registers the agent command group and its storage commands in the CLI bootstrap', async () => {
    const cliSource = await Bun.file(resolve(REPO_ROOT, 'packages/cli/src/cli.ts')).text()
    expect(cliSource).toContain("import {registerAgentCommands} from './commands/agent'")
    expect(cliSource).toMatch(/registerAgentCommands\(cli\)/)

    const cli = goke('infra')
    registerAgentCommands(cli)
    cli.help()

    expect(cli.helpText()).toContain('agent setup')
    expect(cli.helpText()).toContain('agent storage')
    expect(cli.helpText()).toContain('agent storage teardown')
  })

  it('keeps every mutating agent command out of the MCP allowlist', () => {
    for (const command of AGENT_MUTATING_COMMANDS) {
      expect(MCP_ALLOWLIST.has(command), `${command} must remain CLI-only`).toBe(false)
    }
    expect([...MCP_ALLOWLIST].some(command => command.startsWith('agent '))).toBe(false)
  })

  it('requires the CLIProxy auth monitor workflow', async () => {
    const workflowPath = resolve(REPO_ROOT, '.github/workflows/cliproxy-auth-monitor.yaml')

    expect(await Bun.file(workflowPath).exists()).toBe(true)
  })

  it('defines the monitor schedule and exact manual validation choices', async () => {
    const text = await Bun.file(resolve(REPO_ROOT, '.github/workflows/cliproxy-auth-monitor.yaml')).text()
    const parsed = parseYaml(text) as {
      on?: {
        schedule?: {cron?: string}[]
        workflow_dispatch?: {
          inputs?: {
            validation?: {type?: string; default?: string; options?: string[]}
          }
        }
      }
    }

    expect(parsed.on?.schedule).toEqual([{cron: '7,22,37,52 * * * *'}])
    const validation = parsed.on?.workflow_dispatch?.inputs?.validation
    expect({type: validation?.type, default: validation?.default, options: validation?.options}).toEqual({
      type: 'choice',
      default: 'live',
      options: ['live', 'synthetic-dead', 'synthetic-healthy'],
    })
    expect(text).not.toMatch(/pull_request(?:_target)?\s*:/)
    expect(text).toContain('VALIDATION=live')
  })

  it('keeps monitor workflow permissions, concurrency, and checkout hardened', async () => {
    const text = await Bun.file(resolve(REPO_ROOT, '.github/workflows/cliproxy-auth-monitor.yaml')).text()

    expect(text).toContain('contents: read')
    expect(text).toContain('issues: write')
    expect(text).toContain('group: cliproxy-auth-monitor')
    expect(text).toContain('cancel-in-progress: false')
    expect(text).not.toContain('environment:')
    expect(text).not.toContain('secrets: inherit')
    expect(text).toContain('persist-credentials: false')
    expect(text).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1')
    expect(text).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0')
    expect(text).toContain('bun install --frozen-lockfile --ignore-scripts')
  })

  it('binds only the monitor inputs and preserves safe output plus exit status', async () => {
    const text = await Bun.file(resolve(REPO_ROOT, '.github/workflows/cliproxy-auth-monitor.yaml')).text()

    for (const binding of [
      'GITHUB_TOKEN: $' + '{{ github.token }}',
      'GITHUB_REPOSITORY: $' + '{{ github.repository }}',
      'GITHUB_ACTOR: $' + '{{ github.actor }}',
      'GITHUB_REPOSITORY_OWNER: $' + '{{ github.repository_owner }}',
      'CLIPROXY_API_KEY: $' + '{{ secrets.CLIPROXY_API_KEY }}',
      'CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: $' + '{{ secrets.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK }}',
    ]) {
      expect(text).toContain(binding)
    }

    expect(text).toContain('bun run packages/cli/src/cli.ts cliproxy monitor')
    expect(text).toContain('$GITHUB_STEP_SUMMARY')
    expect(text).toMatch(/STATUS=\$\?/)
    expect(text).toMatch(/exit ["']?\$STATUS["']?/)
    expect(text).toContain('set -e')
    expect(text).toContain(String.raw`printf '%s\n' "$OUTPUT" >> "$GITHUB_STEP_SUMMARY"`)
    expect(text).toMatch(/STATUS=\$\?\s+set -e\s+OUTPUT=\$\(cat monitor-output\.txt\)\s+printf '%s\\n' "\$OUTPUT"/)
    expect(text).not.toContain('cat monitor-output.txt >> "$GITHUB_STEP_SUMMARY"')
    expect(text).toContain('NO_COLOR: 1')
    expect(text).not.toContain('ref: $' + '{{ github.event.repository.default_branch }}')
    expect(text).not.toContain('CLIPROXY_URL')
    expect(text).not.toMatch(/--api-key|--webhook|CLIPROXY_API_KEY.*\$VALIDATION/)
  })

  it('tripwire: workflow glob resolves to at least one file (catches dot-dir glob regressions)', () => {
    const workflows = listWorkflowFiles('.yaml')
    expect(workflows.length).toBeGreaterThan(0)
  })

  it('release workflow passes the app token only through changesets/action input', async () => {
    const text = await Bun.file(resolve(REPO_ROOT, '.github/workflows/release.yaml')).text()
    const parsed = parseYaml(text) as {
      jobs?: {release?: {steps?: {id?: string; env?: Record<string, string>; with?: Record<string, string>}[]}}
    }
    const steps = parsed.jobs?.release?.steps ?? []
    const changesetsStep = steps.find(step => step.id === 'changesets')

    expect(changesetsStep).toBeDefined()
    expect(changesetsStep?.with?.['github-token']).toBe('$' + '{{ steps.get-app-token.outputs.token }}')
    expect(changesetsStep?.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(changesetsStep?.env?.NPM_TOKEN).toBe('$' + '{{ secrets.NPM_TOKEN }}')
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

  it('allows only the exact approved shell script allowlist', () => {
    const files = listShellScriptFiles()
    const offenders = files.map(f => relative(REPO_ROOT, f)).filter(f => !ALLOWED_SHELL_SCRIPTS.has(f))
    expect(
      offenders,
      `Shell scripts must match the exact allowlist (${[...ALLOWED_SHELL_SCRIPTS].join(', ')}):`,
    ).toEqual([])
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
  'Approved shell scripts': 'conventions.test.ts: exact allowlist for shell scripts',
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

  it('deploy-gateway.yaml does NOT install doctl (firewall is provisioning-only, not deploy-time)', async () => {
    const text = await Bun.file(resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')).text()
    // The DO Cloud Firewall is created in provisioning (provision-droplet.ts), not in the deploy hot path.
    // The deploy job must NOT install doctl — it no longer needs it.
    expect(text).not.toMatch(/uses:\s+digitalocean\/action-doctl@[a-f0-9]{40}/)
    expect(text).not.toContain('digitalocean/action-doctl')
  })

  it('deploy-gateway.yaml does NOT forward DIGITALOCEAN_ACCESS_TOKEN to the deploy step', async () => {
    const text = await Bun.file(resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')).text()
    // DIGITALOCEAN_ACCESS_TOKEN is only needed for provisioning, not for the deploy hot path.
    // Verify it is not forwarded to the deploy step env block.
    const deployStepIndex = text.indexOf('name: Deploy gateway')
    expect(deployStepIndex).toBeGreaterThan(-1)
    const afterDeployStep = text.slice(deployStepIndex)
    expect(afterDeployStep).not.toContain('DIGITALOCEAN_ACCESS_TOKEN')
  })

  it('deploy-gateway.yaml still forwards GATEWAY_VPC_IP and DASHBOARD_VPC_IP to the deploy step', async () => {
    const text = await Bun.file(resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')).text()
    // GATEWAY_VPC_IP and DASHBOARD_VPC_IP are still needed by deploy.ts for the compose VPC-IP
    // publish and the DOCKER-USER iptables rule.
    const deployStepIndex = text.indexOf('name: Deploy gateway')
    expect(deployStepIndex).toBeGreaterThan(-1)
    const afterDeployStep = text.slice(deployStepIndex)
    expect(afterDeployStep).toContain('GATEWAY_VPC_IP')
    expect(afterDeployStep).toContain('DASHBOARD_VPC_IP')
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

// ─── operator auth/config secrets and tuning vars ────────────────────────────
//
// These assert the four operator auth/config secrets and three optional tuning vars are
// wired through deploy-gateway.yaml (workflow_call.secrets + inputs + deploy step env),
// deploy.yaml (fan-out secrets + with inputs), and the CLI passthrough.

const OPERATOR_AUTH_SECRETS = [
  'GATEWAY_OPERATOR_GITHUB_CLIENT_ID',
  'GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET',
  'GATEWAY_OPERATOR_CSRF_SECRET',
  'GATEWAY_OPERATOR_ALLOWLIST',
] as const

const OPERATOR_TUNING_SECRETS = [
  'GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS',
  'GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS',
  'GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS',
] as const

const OPERATOR_PUSH_VAPID_VARS = [
  'GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY',
  'GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT',
  'GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION',
] as const

const OPERATOR_PUSH_VAPID_PRIVATE_KEY = 'GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY' as const

describe('deploy-gateway.yaml: operator auth/config secrets in workflow_call.secrets', () => {
  const DEPLOY_GATEWAY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')

  for (const secret of OPERATOR_AUTH_SECRETS) {
    it(`workflow_call.secrets declares ${secret} as optional (required: false)`, async () => {
      const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
      const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
      const secrets = parsed?.on?.workflow_call?.secrets ?? {}
      expect(secrets).toHaveProperty(secret)
      expect(secrets[secret]?.required).toBe(false)
    })
  }
})

describe('deploy-gateway.yaml: operator tuning vars in workflow_call.secrets', () => {
  const DEPLOY_GATEWAY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')

  for (const secret of OPERATOR_TUNING_SECRETS) {
    it(`workflow_call.secrets declares ${secret} as optional (required: false)`, async () => {
      const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
      const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
      const secrets = parsed?.on?.workflow_call?.secrets ?? {}
      expect(secrets).toHaveProperty(secret)
      expect(secrets[secret]?.required).toBe(false)
    })
  }

  it('workflow_call.inputs does NOT declare any GATEWAY_OPERATOR_OAUTH_ tuning vars', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {on?: {workflow_call?: {inputs?: Record<string, unknown>}}}
    const inputs = parsed?.on?.workflow_call?.inputs ?? {}
    for (const secret of OPERATOR_TUNING_SECRETS) {
      expect(inputs).not.toHaveProperty(secret)
    }
  })
})

describe('deploy-gateway.yaml: deploy step env forwards operator auth/config vars', () => {
  const DEPLOY_GATEWAY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')

  for (const secret of OPERATOR_AUTH_SECRETS) {
    it(`Deploy gateway step env forwards ${secret}`, async () => {
      const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
      const parsed = parseYaml(text) as {
        jobs?: {'deploy-gateway'?: {steps?: {name?: string; env?: Record<string, string>}[]}}
      }
      const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
      const deployStep = steps.find(s => s.name === 'Deploy gateway')
      expect(deployStep).toBeDefined()
      expect(deployStep?.env).toHaveProperty(secret)
      expect(deployStep?.env?.[secret]).toContain(secret)
    })
  }

  for (const secret of OPERATOR_TUNING_SECRETS) {
    it(`Deploy gateway step env forwards ${secret} from secrets context (not inputs)`, async () => {
      const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
      const parsed = parseYaml(text) as {
        jobs?: {'deploy-gateway'?: {steps?: {name?: string; env?: Record<string, string>}[]}}
      }
      const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
      const deployStep = steps.find(s => s.name === 'Deploy gateway')
      expect(deployStep).toBeDefined()
      expect(deployStep?.env).toHaveProperty(secret)
      // Must source from secrets context, not inputs context
      expect(deployStep?.env?.[secret]).toMatch(/\$\{\{\s*secrets\./)
    })
  }
})

describe('deploy.yaml: fan-out passes operator auth/config secrets to deploy-gateway job', () => {
  const DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy.yaml')

  for (const secret of OPERATOR_AUTH_SECRETS) {
    it(`deploy-gateway job secrets block passes ${secret}`, async () => {
      const text = await Bun.file(DEPLOY_WORKFLOW).text()
      const parsed = parseYaml(text) as {
        jobs?: {'deploy-gateway'?: {secrets?: Record<string, string>}}
      }
      const secrets = parsed?.jobs?.['deploy-gateway']?.secrets ?? {}
      expect(secrets).toHaveProperty(secret)
      expect(secrets[secret]).toContain(secret)
    })
  }
})

describe('deploy.yaml: fan-out passes operator tuning vars via secrets: to deploy-gateway job', () => {
  const DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy.yaml')

  for (const secret of OPERATOR_TUNING_SECRETS) {
    it(`deploy-gateway job secrets block passes ${secret}`, async () => {
      const text = await Bun.file(DEPLOY_WORKFLOW).text()
      const parsed = parseYaml(text) as {
        jobs?: {'deploy-gateway'?: {secrets?: Record<string, string>}}
      }
      const secrets = parsed?.jobs?.['deploy-gateway']?.secrets ?? {}
      expect(secrets).toHaveProperty(secret)
      expect(secrets[secret]).toContain(secret)
    })
  }

  it('deploy-gateway job does NOT have a with: block for GATEWAY_OPERATOR_OAUTH_ tuning vars', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-gateway'?: {with?: Record<string, unknown>}}
    }
    const withBlock = parsed?.jobs?.['deploy-gateway']?.with ?? {}
    for (const secret of OPERATOR_TUNING_SECRETS) {
      expect(withBlock).not.toHaveProperty(secret)
    }
  })
})

// ─── operator push VAPID workflow forwarding ──────────────────────────────────

describe('deploy-gateway.yaml: operator push VAPID workflow contract', () => {
  const DEPLOY_GATEWAY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')

  async function readWorkflow() {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}
      jobs?: {
        'deploy-gateway'?: {
          steps?: {name?: string; env?: Record<string, string>; run?: string}[]
        }
      }
    }
    const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
    return {text, parsed, steps}
  }

  it('declares only the private VAPID key as an optional workflow_call secret', async () => {
    const {parsed} = await readWorkflow()
    const secrets = parsed?.on?.workflow_call?.secrets ?? {}

    expect(secrets).toHaveProperty(OPERATOR_PUSH_VAPID_PRIVATE_KEY)
    expect(secrets[OPERATOR_PUSH_VAPID_PRIVATE_KEY]?.required).toBe(false)
    for (const variable of OPERATOR_PUSH_VAPID_VARS) {
      expect(secrets).not.toHaveProperty(variable)
    }
  })

  it('forwards push metadata from vars and the private key from secrets only in the deploy step', async () => {
    const {steps} = await readWorkflow()
    const deployStep = steps.find(s => s.name === 'Deploy gateway')
    expect(deployStep).toBeDefined()

    for (const variable of OPERATOR_PUSH_VAPID_VARS) {
      expect(deployStep?.env).toHaveProperty(variable)
      expect(deployStep?.env?.[variable]).toBe(`\${{ vars.${variable} }}`)
    }

    expect(deployStep?.env).toHaveProperty(OPERATOR_PUSH_VAPID_PRIVATE_KEY)
    expect(deployStep?.env?.[OPERATOR_PUSH_VAPID_PRIVATE_KEY]).toBe(
      `\${{ secrets.${OPERATOR_PUSH_VAPID_PRIVATE_KEY} }}`,
    )
    expect(deployStep?.env).not.toHaveProperty('GATEWAY_OPERATOR_PUSH_ENABLED')

    const nonDeploySteps = steps.filter(s => s !== deployStep)
    for (const step of nonDeploySteps) {
      expect(JSON.stringify(step)).not.toContain(OPERATOR_PUSH_VAPID_PRIVATE_KEY)
    }
  })

  it('keeps VAPID values out of required-secret validation', async () => {
    const {steps} = await readWorkflow()
    const validationStep = steps.find(s => s.name === 'Validate required secrets')
    expect(validationStep).toBeDefined()

    const validationText = JSON.stringify(validationStep)
    for (const variable of [...OPERATOR_PUSH_VAPID_VARS, OPERATOR_PUSH_VAPID_PRIVATE_KEY]) {
      expect(validationText).not.toContain(variable)
    }
  })

  it('does not expose an independently operator-set gateway push enabled input', async () => {
    const {text, parsed} = await readWorkflow()
    const inputs = (parsed?.on?.workflow_call as {inputs?: Record<string, unknown>} | undefined)?.inputs ?? {}
    expect(text).not.toContain('GATEWAY_OPERATOR_PUSH_ENABLED')
    expect(inputs).not.toHaveProperty('GATEWAY_OPERATOR_PUSH_ENABLED')
  })
})

describe('deploy.yaml: aggregate router forwards the optional operator push private key', () => {
  const DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy.yaml')

  it('passes the private VAPID key through the deploy-gateway job secrets block', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-gateway'?: {secrets?: Record<string, string>}}
    }
    const secrets = parsed?.jobs?.['deploy-gateway']?.secrets ?? {}

    expect(secrets).toHaveProperty(OPERATOR_PUSH_VAPID_PRIVATE_KEY)
    expect(secrets[OPERATOR_PUSH_VAPID_PRIVATE_KEY]).toBe(`\${{ secrets.${OPERATOR_PUSH_VAPID_PRIVATE_KEY} }}`)
  })

  it('does not pass non-secret push metadata or an independent enabled flag through the aggregate router', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-gateway'?: {secrets?: Record<string, string>}}
    }
    const secrets = parsed?.jobs?.['deploy-gateway']?.secrets ?? {}

    for (const variable of OPERATOR_PUSH_VAPID_VARS) {
      expect(secrets).not.toHaveProperty(variable)
    }
    expect(text).not.toContain('GATEWAY_OPERATOR_PUSH_ENABLED')
  })
})

describe('CLI getGatewayDeployEnv: operator auth/config passthrough', () => {
  it('getGatewayDeployEnv includes all four operator auth/config secret vars', async () => {
    const {getGatewayDeployEnv} = await import('./commands/gateway/deploy')
    // Provide required env vars
    const origEnv = {...process.env}
    process.env.PATH = '/usr/bin'
    process.env.HOME = '/home/test'
    process.env.SSH_AUTH_SOCK = '/tmp/ssh.sock'
    try {
      const env = getGatewayDeployEnv()
      for (const secret of OPERATOR_AUTH_SECRETS) {
        expect(env).toHaveProperty(secret)
      }
    } finally {
      Object.assign(process.env, origEnv)
    }
  })

  it('getGatewayDeployEnv includes all three operator tuning vars', async () => {
    const {getGatewayDeployEnv} = await import('./commands/gateway/deploy')
    const origEnv = {...process.env}
    process.env.PATH = '/usr/bin'
    process.env.HOME = '/home/test'
    process.env.SSH_AUTH_SOCK = '/tmp/ssh.sock'
    try {
      const env = getGatewayDeployEnv()
      for (const secret of OPERATOR_TUNING_SECRETS) {
        expect(env).toHaveProperty(secret)
      }
    } finally {
      Object.assign(process.env, origEnv)
    }
  })

  it('getGatewayDeployEnv includes GATEWAY_IMAGE_DIGEST', async () => {
    const {getGatewayDeployEnv} = await import('./commands/gateway/deploy')
    const origEnv = {...process.env}
    process.env.PATH = '/usr/bin'
    process.env.HOME = '/home/test'
    process.env.SSH_AUTH_SOCK = '/tmp/ssh.sock'
    process.env.GATEWAY_IMAGE_DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    try {
      const env = getGatewayDeployEnv()
      expect(env).toHaveProperty('GATEWAY_IMAGE_DIGEST')
      expect(env.GATEWAY_IMAGE_DIGEST).toBe('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    } finally {
      Object.assign(process.env, origEnv)
    }
  })

  it('getGatewayDeployEnv includes WORKSPACE_IMAGE_DIGEST', async () => {
    const {getGatewayDeployEnv} = await import('./commands/gateway/deploy')
    const origEnv = {...process.env}
    process.env.PATH = '/usr/bin'
    process.env.HOME = '/home/test'
    process.env.SSH_AUTH_SOCK = '/tmp/ssh.sock'
    process.env.WORKSPACE_IMAGE_DIGEST = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    try {
      const env = getGatewayDeployEnv()
      expect(env).toHaveProperty('WORKSPACE_IMAGE_DIGEST')
      expect(env.WORKSPACE_IMAGE_DIGEST).toBe('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    } finally {
      Object.assign(process.env, origEnv)
    }
  })

  it('getGatewayDeployEnv includes GATEWAY_VPC_IP and DASHBOARD_VPC_IP (but NOT DIGITALOCEAN_ACCESS_TOKEN)', async () => {
    const {getGatewayDeployEnv} = await import('./commands/gateway/deploy')
    const origEnv = {...process.env}
    process.env.PATH = '/usr/bin'
    process.env.HOME = '/home/test'
    process.env.SSH_AUTH_SOCK = '/tmp/ssh.sock'
    try {
      const env = getGatewayDeployEnv()
      // VPC IPs are still needed by deploy.ts for compose publish + DOCKER-USER rule
      expect(env).toHaveProperty('GATEWAY_VPC_IP')
      expect(env).toHaveProperty('DASHBOARD_VPC_IP')
      // DIGITALOCEAN_ACCESS_TOKEN is provisioning-only — must NOT be in the deploy env
      expect(env).not.toHaveProperty('DIGITALOCEAN_ACCESS_TOKEN')
    } finally {
      Object.assign(process.env, origEnv)
    }
  })
})

// ─── deploy.yaml: aggregate router passes operator secrets to deploy-gateway ──

describe('deploy.yaml: aggregate router forwards operator secrets to deploy-gateway job', () => {
  const DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy.yaml')

  it('deploy-gateway job secrets block passes GATEWAY_OPERATOR_BIND_HOST', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {
        'deploy-gateway'?: {
          secrets?: Record<string, string>
        }
      }
    }
    const secrets = parsed?.jobs?.['deploy-gateway']?.secrets ?? {}
    expect(secrets).toHaveProperty('GATEWAY_OPERATOR_BIND_HOST')
    expect(secrets.GATEWAY_OPERATOR_BIND_HOST).toContain('GATEWAY_OPERATOR_BIND_HOST')
  })

  it('deploy-gateway job secrets block passes GATEWAY_OPERATOR_BIND_PORT', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {
        'deploy-gateway'?: {
          secrets?: Record<string, string>
        }
      }
    }
    const secrets = parsed?.jobs?.['deploy-gateway']?.secrets ?? {}
    expect(secrets).toHaveProperty('GATEWAY_OPERATOR_BIND_PORT')
    expect(secrets.GATEWAY_OPERATOR_BIND_PORT).toContain('GATEWAY_OPERATOR_BIND_PORT')
  })

  it('deploy-gateway job secrets block passes GATEWAY_OPERATOR_PUBLIC_ORIGIN', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {
        'deploy-gateway'?: {
          secrets?: Record<string, string>
        }
      }
    }
    const secrets = parsed?.jobs?.['deploy-gateway']?.secrets ?? {}
    expect(secrets).toHaveProperty('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
    expect(secrets.GATEWAY_OPERATOR_PUBLIC_ORIGIN).toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
  })
})

// ─── deploy-gateway.yaml: optional operator secret declarations ───────────────

describe('deploy-gateway.yaml: optional operator secret declarations (issue 1)', () => {
  const DEPLOY_GATEWAY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')

  it('workflow_call.secrets declares GATEWAY_OPERATOR_BIND_HOST as optional', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
    const secrets = parsed?.on?.workflow_call?.secrets ?? {}
    expect(secrets).toHaveProperty('GATEWAY_OPERATOR_BIND_HOST')
    expect(secrets.GATEWAY_OPERATOR_BIND_HOST?.required).toBe(false)
  })

  it('workflow_call.secrets declares GATEWAY_OPERATOR_BIND_PORT as optional', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
    const secrets = parsed?.on?.workflow_call?.secrets ?? {}
    expect(secrets).toHaveProperty('GATEWAY_OPERATOR_BIND_PORT')
    expect(secrets.GATEWAY_OPERATOR_BIND_PORT?.required).toBe(false)
  })

  it('workflow_call.secrets declares GATEWAY_OPERATOR_PUBLIC_ORIGIN as optional', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
    const secrets = parsed?.on?.workflow_call?.secrets ?? {}
    expect(secrets).toHaveProperty('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
    expect(secrets.GATEWAY_OPERATOR_PUBLIC_ORIGIN?.required).toBe(false)
  })

  it('Deploy gateway step env forwards GATEWAY_OPERATOR_BIND_HOST', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {
        'deploy-gateway'?: {
          steps?: {name?: string; env?: Record<string, string>}[]
        }
      }
    }
    const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
    const deployStep = steps.find(s => s.name === 'Deploy gateway')
    expect(deployStep).toBeDefined()
    expect(deployStep?.env).toHaveProperty('GATEWAY_OPERATOR_BIND_HOST')
    expect(deployStep?.env?.GATEWAY_OPERATOR_BIND_HOST).toContain('GATEWAY_OPERATOR_BIND_HOST')
  })

  it('Deploy gateway step env forwards GATEWAY_OPERATOR_BIND_PORT', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {
        'deploy-gateway'?: {
          steps?: {name?: string; env?: Record<string, string>}[]
        }
      }
    }
    const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
    const deployStep = steps.find(s => s.name === 'Deploy gateway')
    expect(deployStep).toBeDefined()
    expect(deployStep?.env).toHaveProperty('GATEWAY_OPERATOR_BIND_PORT')
    expect(deployStep?.env?.GATEWAY_OPERATOR_BIND_PORT).toContain('GATEWAY_OPERATOR_BIND_PORT')
  })

  it('Deploy gateway step env forwards GATEWAY_OPERATOR_PUBLIC_ORIGIN', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {
        'deploy-gateway'?: {
          steps?: {name?: string; env?: Record<string, string>}[]
        }
      }
    }
    const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
    const deployStep = steps.find(s => s.name === 'Deploy gateway')
    expect(deployStep).toBeDefined()
    expect(deployStep?.env).toHaveProperty('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
    expect(deployStep?.env?.GATEWAY_OPERATOR_PUBLIC_ORIGIN).toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
  })

  it('operator vars are NOT in the required-secret validation step env', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {
        'deploy-gateway'?: {
          steps?: {name?: string; env?: Record<string, string>; run?: string}[]
        }
      }
    }
    const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
    const validateStep = steps.find(s => s.name === 'Validate required secrets')
    expect(validateStep).toBeDefined()
    // Operator vars must NOT be in the validation step env (deploy script enforces all-or-none)
    expect(validateStep?.env ?? {}).not.toHaveProperty('GATEWAY_OPERATOR_BIND_HOST')
    expect(validateStep?.env ?? {}).not.toHaveProperty('GATEWAY_OPERATOR_BIND_PORT')
    expect(validateStep?.env ?? {}).not.toHaveProperty('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
  })
})

// ─── deploy.yaml: aggregate concurrency guard ────────────────────────────────
//
// The aggregate deploy.yaml must NOT have a top-level concurrency block.
// A top-level concurrency group cancels the entire fan-out run when a new
// merge arrives while the run waits at a per-app approval gate, stranding
// all pending app deploys. Each per-app reusable workflow already has its
// own concurrency group, so the aggregate group is redundant and harmful.
//
// Each per-app deploy workflow MUST have its own concurrency block with
// group `deploy-<app>-` and cancel-in-progress: false.

describe('deploy.yaml: no aggregate-level concurrency (regression guard)', () => {
  const DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy.yaml')

  it('deploy.yaml does not contain the deploy-aggregate concurrency group string', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    expect(text).not.toContain('deploy-aggregate')
  })

  it('deploy.yaml has no top-level concurrency: key (no line starting with "concurrency:" at column 0)', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const lines = text.split(/\r?\n/)
    const topLevelConcurrencyLines = lines.filter(line => line.startsWith('concurrency:'))
    expect(topLevelConcurrencyLines).toEqual([])
  })
})

describe('per-app deploy workflows: each has its own concurrency block', () => {
  const APPS = ['keeweb', 'cliproxy', 'gateway', 'umami', 'vpn', 'dashboard'] as const

  for (const app of APPS) {
    it(`deploy-${app}.yaml has concurrency group deploy-${app}- with cancel-in-progress: false`, async () => {
      const workflowPath = resolve(REPO_ROOT, `.github/workflows/deploy-${app}.yaml`)
      const text = await Bun.file(workflowPath).text()
      const parsed = parseYaml(text) as {concurrency?: {group?: string; 'cancel-in-progress'?: boolean}}
      expect(parsed.concurrency).toBeDefined()
      expect(parsed.concurrency?.group).toContain(`deploy-${app}-`)
      expect(parsed.concurrency?.['cancel-in-progress']).toBe(false)
    })
  }
})

// ─── VPC bridge secrets: CI-vs-local parity ──────────────────────────────────
//
// GATEWAY_VPC_IP and DASHBOARD_VPC_IP are optional (all-or-none via getOperatorVpcState)
// but must be forwarded through CI so the operator VPC bridge is not silently disabled
// when the secrets are set. DIGITALOCEAN_ACCESS_TOKEN is provisioning-only and must NOT
// be forwarded to the deploy step.
// These tests assert the end-to-end wiring without adding them to the required
// validation preflight (they are opt-in, like the operator listener vars).

const VPC_GATEWAY_SECRETS = ['GATEWAY_VPC_IP', 'DASHBOARD_VPC_IP'] as const
const VPC_DASHBOARD_SECRETS = ['GATEWAY_VPC_IP'] as const

describe('deploy-gateway.yaml: VPC bridge secrets wired end-to-end', () => {
  const DEPLOY_GATEWAY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-gateway.yaml')

  for (const secret of VPC_GATEWAY_SECRETS) {
    it(`workflow_call.secrets declares ${secret} as optional (required: false)`, async () => {
      const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
      const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
      const secrets = parsed?.on?.workflow_call?.secrets ?? {}
      expect(secrets).toHaveProperty(secret)
      expect(secrets[secret]?.required).toBe(false)
    })

    it(`Deploy gateway step env forwards ${secret} from secrets context`, async () => {
      const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
      const parsed = parseYaml(text) as {
        jobs?: {'deploy-gateway'?: {steps?: {name?: string; env?: Record<string, string>}[]}}
      }
      const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
      const deployStep = steps.find(s => s.name === 'Deploy gateway')
      expect(deployStep).toBeDefined()
      expect(deployStep?.env).toHaveProperty(secret)
      expect(deployStep?.env?.[secret]).toMatch(/\$\{\{\s*secrets\./)
    })
  }

  it('VPC bridge secrets are NOT in the required-secret validation step env', async () => {
    const text = await Bun.file(DEPLOY_GATEWAY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-gateway'?: {steps?: {name?: string; env?: Record<string, string>; run?: string}[]}}
    }
    const steps = parsed?.jobs?.['deploy-gateway']?.steps ?? []
    const validateStep = steps.find(s => s.name === 'Validate required secrets')
    expect(validateStep).toBeDefined()
    for (const secret of VPC_GATEWAY_SECRETS) {
      expect(validateStep?.env ?? {}).not.toHaveProperty(secret)
    }
  })
})

describe('deploy-dashboard.yaml: VPC bridge secret wired end-to-end', () => {
  const DEPLOY_DASHBOARD_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-dashboard.yaml')

  for (const secret of VPC_DASHBOARD_SECRETS) {
    it(`workflow_call.secrets declares ${secret} as optional (required: false)`, async () => {
      const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
      const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
      const secrets = parsed?.on?.workflow_call?.secrets ?? {}
      expect(secrets).toHaveProperty(secret)
      expect(secrets[secret]?.required).toBe(false)
    })

    it(`Deploy step env forwards ${secret} from secrets context`, async () => {
      const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
      const parsed = parseYaml(text) as {
        jobs?: {'deploy-dashboard'?: {steps?: {name?: string; env?: Record<string, string>}[]}}
      }
      const steps = parsed?.jobs?.['deploy-dashboard']?.steps ?? []
      const deployStep = steps.find(s => s.name === 'Deploy')
      expect(deployStep).toBeDefined()
      expect(deployStep?.env).toHaveProperty(secret)
      expect(deployStep?.env?.[secret]).toMatch(/\$\{\{\s*secrets\./)
    })
  }

  it('GATEWAY_VPC_IP is NOT in the required-secret validation step env', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-dashboard'?: {steps?: {name?: string; env?: Record<string, string>; run?: string}[]}}
    }
    const steps = parsed?.jobs?.['deploy-dashboard']?.steps ?? []
    const validateStep = steps.find(s => s.name === 'Validate required secrets')
    expect(validateStep).toBeDefined()
    expect(validateStep?.env ?? {}).not.toHaveProperty('GATEWAY_VPC_IP')
  })
})

describe('deploy.yaml: aggregate router forwards VPC bridge secrets', () => {
  const DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy.yaml')

  for (const secret of VPC_GATEWAY_SECRETS) {
    it(`deploy-gateway job secrets block passes ${secret}`, async () => {
      const text = await Bun.file(DEPLOY_WORKFLOW).text()
      const parsed = parseYaml(text) as {
        jobs?: {'deploy-gateway'?: {secrets?: Record<string, string>}}
      }
      const secrets = parsed?.jobs?.['deploy-gateway']?.secrets ?? {}
      expect(secrets).toHaveProperty(secret)
      expect(secrets[secret]).toContain(secret)
    })
  }

  for (const secret of VPC_DASHBOARD_SECRETS) {
    it(`deploy-dashboard job secrets block passes ${secret}`, async () => {
      const text = await Bun.file(DEPLOY_WORKFLOW).text()
      const parsed = parseYaml(text) as {
        jobs?: {'deploy-dashboard'?: {secrets?: Record<string, string>}}
      }
      const secrets = parsed?.jobs?.['deploy-dashboard']?.secrets ?? {}
      expect(secrets).toHaveProperty(secret)
      expect(secrets[secret]).toContain(secret)
    })
  }
})

// ─── deploy.yaml: deploy-dashboard is decoupled from deploy-gateway ──────────
//
// The dashboard is a standalone deployment. A gateway failure or slowness must
// not block dashboard deploys. deploy-dashboard must NOT declare needs: deploy-gateway,
// and its if: must NOT reference needs.deploy-gateway — locking in the decoupling
// so it cannot silently regress.

describe('deploy.yaml: deploy-dashboard is decoupled from deploy-gateway', () => {
  const DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy.yaml')

  it('deploy-dashboard needs: does NOT include deploy-gateway (standalone job)', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-dashboard'?: {needs?: string | string[]}}
    }
    const needs = parsed?.jobs?.['deploy-dashboard']?.needs ?? []
    const needsArr = Array.isArray(needs) ? needs : [needs]
    expect(needsArr).not.toContain('deploy-gateway')
  })

  it('deploy-dashboard if: does NOT reference needs.deploy-gateway (no gateway coupling)', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    // The if: expression must not reference needs.deploy-gateway in any form —
    // gateway state must not gate the dashboard deploy.
    expect(text).not.toMatch(/needs\.deploy-gateway/)
  })
})

// ─── deploy-dashboard.yaml: dispatch/call inputs and job structure ────────────
//
// Verifies the workflow contract for the dashboard release dispatch:
// - dispatch/call inputs version and digest with defaults
// - validate-inputs job exists and deploy-dashboard needs it
// - deploy step forwards DEPLOY_VERSION, DEPLOY_DIGEST
// - no direct ${{ inputs.* }} interpolation inside run: script bodies
// - audit path does not push to HEAD:main and uses a PR branch/gh pr create
// - deploy router dashboard job skips audit pin commits on push but not workflow_dispatch

describe('deploy-dashboard.yaml: dispatch/call inputs and job structure', () => {
  const DEPLOY_DASHBOARD_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-dashboard.yaml')

  it('workflow_dispatch and workflow_call both declare version input with default empty string', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      on?: {
        workflow_dispatch?: {inputs?: Record<string, {default?: unknown}>}
        workflow_call?: {inputs?: Record<string, {default?: unknown}>}
      }
    }
    expect(parsed.on?.workflow_dispatch?.inputs).toHaveProperty('version')
    expect(parsed.on?.workflow_dispatch?.inputs?.version?.default).toBe('')
    expect(parsed.on?.workflow_call?.inputs).toHaveProperty('version')
    expect(parsed.on?.workflow_call?.inputs?.version?.default).toBe('')
  })

  it('workflow_dispatch and workflow_call both declare digest input with default empty string', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      on?: {
        workflow_dispatch?: {inputs?: Record<string, {default?: unknown}>}
        workflow_call?: {inputs?: Record<string, {default?: unknown}>}
      }
    }
    expect(parsed.on?.workflow_dispatch?.inputs).toHaveProperty('digest')
    expect(parsed.on?.workflow_dispatch?.inputs?.digest?.default).toBe('')
    expect(parsed.on?.workflow_call?.inputs).toHaveProperty('digest')
    expect(parsed.on?.workflow_call?.inputs?.digest?.default).toBe('')
  })

  it('does not declare or forward the removed release fuse input', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const removedInputName = ['contract', 'version'].join('_')
    const removedEnvName = ['DEPLOY', 'CONTRACT', 'VERSION'].join('_')
    const parsed = parseYaml(text) as {
      on?: {
        workflow_dispatch?: {inputs?: Record<string, unknown>}
        workflow_call?: {inputs?: Record<string, unknown>}
      }
      jobs?: {'deploy-dashboard'?: {steps?: {name?: string; env?: Record<string, string>}[]}}
    }
    const deployStep = parsed.jobs?.['deploy-dashboard']?.steps?.find(step => step.name === 'Deploy')

    expect(parsed.on?.workflow_dispatch?.inputs).not.toHaveProperty(removedInputName)
    expect(parsed.on?.workflow_call?.inputs).not.toHaveProperty(removedInputName)
    expect(deployStep?.env).not.toHaveProperty(removedEnvName)
  })

  it('validate-inputs job exists', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {jobs?: Record<string, unknown>}
    expect(parsed.jobs).toHaveProperty('validate-inputs')
  })

  it('deploy-dashboard job needs validate-inputs', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {jobs?: {'deploy-dashboard'?: {needs?: string | string[]}}}
    const needs = parsed.jobs?.['deploy-dashboard']?.needs ?? []
    const needsArr = Array.isArray(needs) ? needs : [needs]
    expect(needsArr).toContain('validate-inputs')
  })

  it('Deploy step env forwards DEPLOY_VERSION from inputs', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-dashboard'?: {steps?: {name?: string; env?: Record<string, string>}[]}}
    }
    const steps = parsed.jobs?.['deploy-dashboard']?.steps ?? []
    const deployStep = steps.find(s => s.name === 'Deploy')
    expect(deployStep).toBeDefined()
    expect(deployStep?.env).toHaveProperty('DEPLOY_VERSION')
    expect(deployStep?.env?.DEPLOY_VERSION).toContain('inputs.version')
  })

  it('Deploy step env forwards DEPLOY_DIGEST from inputs', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-dashboard'?: {steps?: {name?: string; env?: Record<string, string>}[]}}
    }
    const steps = parsed.jobs?.['deploy-dashboard']?.steps ?? []
    const deployStep = steps.find(s => s.name === 'Deploy')
    expect(deployStep).toBeDefined()
    expect(deployStep?.env).toHaveProperty('DEPLOY_DIGEST')
    expect(deployStep?.env?.DEPLOY_DIGEST).toContain('inputs.digest')
  })

  it('no direct inputs.* interpolation inside run: script bodies', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {jobs?: Record<string, {steps?: {run?: string; env?: unknown}[]}>}
    // Pattern: ${{ inputs.* }} in run: body is a shell injection risk.
    // Inputs must be passed via step env: and referenced as shell vars.
    // Use non-global regex to avoid stateful lastIndex issues in loops.
    const inputsInRunRe = /\$\{\{\s*inputs\./
    const jobsWithViolations: string[] = []
    for (const [jobId, job] of Object.entries(parsed.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue
        if (inputsInRunRe.test(step.run)) {
          jobsWithViolations.push(jobId)
          break
        }
      }
    }
    expect(jobsWithViolations).toEqual([])
  })

  it('audit path does not push directly to HEAD:main', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    // Direct push to HEAD:main is blocked by branch protection
    expect(text).not.toContain('HEAD:main')
  })

  it('audit path uses gh pr create (PR-based write-back)', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    expect(text).toContain('gh pr create')
  })

  it('workflow_call.secrets declares APPLICATION_ID as required', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
    const secrets = parsed.on?.workflow_call?.secrets ?? {}
    expect(secrets).toHaveProperty('APPLICATION_ID')
    expect(secrets.APPLICATION_ID?.required).toBe(true)
  })

  it('workflow_call.secrets declares APPLICATION_PRIVATE_KEY as required', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {on?: {workflow_call?: {secrets?: Record<string, {required?: boolean}>}}}
    const secrets = parsed.on?.workflow_call?.secrets ?? {}
    expect(secrets).toHaveProperty('APPLICATION_PRIVATE_KEY')
    expect(secrets.APPLICATION_PRIVATE_KEY?.required).toBe(true)
  })

  it('does not use github.token anywhere (app token only)', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    expect(text).not.toContain('github.token')
  })

  it('Get app token step has no if: condition (runs unconditionally)', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-dashboard'?: {steps?: {name?: string; if?: unknown}[]}}
    }
    const steps = parsed.jobs?.['deploy-dashboard']?.steps ?? []
    const getTokenStep = steps.find(s => s.name === 'Get app token')
    expect(getTokenStep).toBeDefined()
    expect(getTokenStep?.if).toBeUndefined()
  })

  it('has top-level permissions: contents: read (project convention — no GITHUB_TOKEN write)', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {permissions?: {contents?: string}}
    expect(parsed.permissions).toBeDefined()
    expect(parsed.permissions?.contents).toBe('read')
  })

  it('deploy-dashboard job has no job-level permissions: block (no GITHUB_TOKEN write needed)', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {jobs?: {'deploy-dashboard'?: {permissions?: unknown}}}
    expect(parsed.jobs?.['deploy-dashboard']?.permissions).toBeUndefined()
  })
})

describe('deploy.yaml: dashboard job skips audit pin commits on push', () => {
  const DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy.yaml')

  it('deploy-dashboard if: skips commits whose message contains the audit pin prefix on push', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    // The if: condition must exclude audit pin commits on push events
    // by checking the head commit message does not contain the pin prefix
    expect(text).toContain('chore(dashboard): pin image to')
  })

  it('deploy.yaml passes APPLICATION_ID to deploy-dashboard job', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-dashboard'?: {secrets?: Record<string, string>}}
    }
    const secrets = parsed.jobs?.['deploy-dashboard']?.secrets ?? {}
    expect(secrets).toHaveProperty('APPLICATION_ID')
    expect(secrets.APPLICATION_ID).toContain('APPLICATION_ID')
  })

  it('deploy.yaml passes APPLICATION_PRIVATE_KEY to deploy-dashboard job', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'deploy-dashboard'?: {secrets?: Record<string, string>}}
    }
    const secrets = parsed.jobs?.['deploy-dashboard']?.secrets ?? {}
    expect(secrets).toHaveProperty('APPLICATION_PRIVATE_KEY')
    expect(secrets.APPLICATION_PRIVATE_KEY).toContain('APPLICATION_PRIVATE_KEY')
  })

  it('deploy-dashboard job in deploy.yaml has no permissions: block (no GITHUB_TOKEN used)', async () => {
    const text = await Bun.file(DEPLOY_WORKFLOW).text()
    const parsed = parseYaml(text) as {jobs?: {'deploy-dashboard'?: {permissions?: unknown}}}
    expect(parsed.jobs?.['deploy-dashboard']?.permissions).toBeUndefined()
  })
})

// ─── deploy-dashboard.yaml: pre-gate digest validation step ──────────────────
//
// A `Validate digest format` step must exist in the `validate-inputs` job,
// before the `Validate input mode` step. It must:
// - only run when inputs.digest != ''
// - expose INPUT_DIGEST via env (not direct interpolation in run:)
// - validate ^sha256:[0-9a-f]{64}$ and fail with a clear message on mismatch

describe('deploy-dashboard.yaml: pre-gate digest validation step', () => {
  const DEPLOY_DASHBOARD_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-dashboard.yaml')

  it('validate-inputs job has a "Validate digest format" step', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {jobs?: {'validate-inputs'?: {steps?: {name?: string}[]}}}
    const steps = parsed.jobs?.['validate-inputs']?.steps ?? []
    const digestStep = steps.find(s => s.name === 'Validate digest format')
    expect(digestStep).toBeDefined()
  })

  it('"Validate digest format" step has if: inputs.digest != \'\'', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'validate-inputs'?: {steps?: {name?: string; if?: unknown}[]}}
    }
    const steps = parsed.jobs?.['validate-inputs']?.steps ?? []
    const digestStep = steps.find(s => s.name === 'Validate digest format')
    expect(digestStep).toBeDefined()
    // The if: condition must reference inputs.digest
    expect(String(digestStep?.if ?? '')).toContain('inputs.digest')
  })

  it('"Validate digest format" step exposes INPUT_DIGEST via env (not direct interpolation)', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'validate-inputs'?: {steps?: {name?: string; env?: Record<string, string>}[]}}
    }
    const steps = parsed.jobs?.['validate-inputs']?.steps ?? []
    const digestStep = steps.find(s => s.name === 'Validate digest format')
    expect(digestStep).toBeDefined()
    expect(digestStep?.env).toHaveProperty('INPUT_DIGEST')
    expect(digestStep?.env?.INPUT_DIGEST).toContain('inputs.digest')
  })

  it('"Validate digest format" step run: validates sha256:<64hex> pattern', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'validate-inputs'?: {steps?: {name?: string; run?: string}[]}}
    }
    const steps = parsed.jobs?.['validate-inputs']?.steps ?? []
    const digestStep = steps.find(s => s.name === 'Validate digest format')
    expect(digestStep).toBeDefined()
    // Must contain the sha256 hex pattern
    expect(digestStep?.run ?? '').toMatch(/sha256[^\d\n\ra-f\u2028\u2029]*[\da-f].*64|sha256:\[0-9a-f\]/)
  })

  it('"Validate digest format" step appears before "Validate input mode" step', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {
      jobs?: {'validate-inputs'?: {steps?: {name?: string}[]}}
    }
    const steps = parsed.jobs?.['validate-inputs']?.steps ?? []
    const digestIdx = steps.findIndex(s => s.name === 'Validate digest format')
    const inputModeIdx = steps.findIndex(s => s.name === 'Validate input mode')
    expect(digestIdx).toBeGreaterThan(-1)
    expect(inputModeIdx).toBeGreaterThan(-1)
    expect(digestIdx).toBeLessThan(inputModeIdx)
  })
})

// ─── deploy-dashboard.yaml: audit step hardening ─────────────────────────────
//
// The audit PR step must:
// - revalidate version with CalVer before constructing branch/commit strings
// - use the stable `dashboard-pin` branch based on the latest origin/main
// - reapply only the dashboard image pin with awk after resetting to origin/main
// - supersede other open pin PRs before leaving at most one current PR
// - NOT use `|| true` around push/PR operations (audit failures must fail the step)

describe('deploy-dashboard.yaml: audit step hardening', () => {
  const DEPLOY_DASHBOARD_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-dashboard.yaml')

  it('audit PR step uses stable dashboard-pin branch based on latest origin/main', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    expect(afterAudit).toMatch(/branch=["']dashboard-pin["']/)
    expect(afterAudit).not.toMatch(/run_id|GITHUB_RUN_ID/)
    expect(afterAudit).toContain('git fetch origin main')
    expect(afterAudit).toMatch(/git checkout (?:-f )?-B .*origin\/main/)
  })

  it('audit PR step force-checks out the stable branch after capturing the deployed pin', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    const pinCaptureIdx = afterAudit.indexOf('pinned_image_line=')
    const checkoutIdx = afterAudit.indexOf('git checkout -f -B')
    expect(pinCaptureIdx).toBeGreaterThan(-1)
    expect(checkoutIdx).toBeGreaterThan(pinCaptureIdx)
  })

  it('audit PR step reapplies only the dashboard image pin with awk', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    expect(afterAudit).toMatch(/awk\s+-v\s+\w+=/)
    expect(afterAudit).toContain('apps/dashboard/docker-compose.yaml')
    expect(afterAudit).toContain('origin/main:apps/dashboard/docker-compose.yaml')
  })

  it('audit PR step revalidates version with CalVer regex before branch construction', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    const calVerPattern = String.raw`^[0-9]{4}\.[0-9]{2}\.[0-9]+$`
    const calVerIdx = afterAudit.indexOf(calVerPattern)
    const branchIdx = afterAudit.indexOf('branch=')
    expect(calVerIdx).toBeGreaterThan(-1)
    expect(branchIdx).toBeGreaterThan(calVerIdx)
  })

  it('audit PR step lists open pin PRs and closes superseded ones', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    expect(afterAudit).toContain('gh pr list --state open')
    expect(afterAudit).toContain('gh pr close')
  })

  it('audit PR supersede selector is limited to bot-owned dashboard pin branches', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    const supersedeStart = afterAudit.indexOf('supersede_open_pin_prs()')
    const supersedeEnd = afterAudit.indexOf('\n          git add ', supersedeStart)
    expect(supersedeStart).toBeGreaterThan(-1)
    expect(supersedeEnd).toBeGreaterThan(supersedeStart)
    const supersedeBlock = afterAudit.slice(supersedeStart, supersedeEnd)
    const jqQuery = supersedeBlock.match(/--jq\s+'([^']+)'/)?.[1]
    expect(jqQuery).toBeDefined()
    expect(jqQuery).toContain('headRefName')
    expect(jqQuery).toContain('startswith("dashboard-pin-")')
    expect(jqQuery).toContain('isCrossRepository == false')
    expect(jqQuery).toContain('.author.login')
    expect(supersedeBlock).toContain('author_login')
    expect(supersedeBlock).toMatch(/\[\[\s*"\$\{author_login\}"\s*==\s*"\$\{GIT_USER_NAME\}"\s*\]\]\s*\|\|\s*continue/)
    expect(jqQuery).not.toContain('title')
  })

  it('audit PR step pushes with force-with-lease and updates existing PRs in place', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    const branchRef = '$' + '{branch}'
    const existingRef = '$' + '{existing}'
    expect(afterAudit).toContain(`git push origin "${branchRef}" --force-with-lease`)
    expect(afterAudit).toContain(`gh pr edit "${existingRef}"`)
  })

  it('audit PR step creates or updates before superseding with a confirmed stable PR number', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    const branchRef = '$' + '{branch}'
    const existingRef = '$' + '{existing}'
    const stablePrRef = '$' + '{stable_pr_number}'
    const createIdx = afterAudit.indexOf('gh pr create')
    const editIdx = afterAudit.indexOf('gh pr edit')
    const stableSupersedeIdx = afterAudit.indexOf(`supersede_open_pin_prs "${stablePrRef}"`)
    expect(createIdx).toBeGreaterThan(-1)
    expect(editIdx).toBeGreaterThan(-1)
    expect(stableSupersedeIdx).toBeGreaterThan(Math.max(createIdx, editIdx))
    expect(afterAudit).toContain(`stable_pr_number="${existingRef}"`)
    expect(afterAudit).toContain(
      `stable_pr_number=$(gh pr list --state open --head "${branchRef}" --base main --json number --jq`,
    )
    expect(afterAudit).toContain('supersede_open_pin_prs ""')
  })

  it('audit PR reapply awk replaces exactly one dashboard image line', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    const reapplyStart = afterAudit.indexOf('if ! awk -v replacement=')
    const rewrittenComposeRef = '$' + '{rewritten_compose}'
    const reapplyEnd = afterAudit.indexOf(`mv "${rewrittenComposeRef}"`, reapplyStart)
    expect(reapplyStart).toBeGreaterThan(-1)
    expect(reapplyEnd).toBeGreaterThan(reapplyStart)
    const reapplyBlock = afterAudit.slice(reapplyStart, reapplyEnd)
    expect(reapplyBlock).toMatch(/count\s*!=\s*1/)
    expect(reapplyBlock).toContain('expected exactly one dashboard image line')
  })

  it('audit PR step does NOT use || true around push or PR operations', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    // || true around push or PR operations silences audit failures — must not be present
    expect(afterAudit).not.toMatch(/git push[^#\n]*\|\|\s*true/)
    expect(afterAudit).not.toMatch(/gh pr create[^#\n]*\|\|\s*true/)
    expect(afterAudit).not.toMatch(/gh pr edit[^#\n]*\|\|\s*true/)
    expect(afterAudit).not.toMatch(/gh pr close[^#\n]*\|\|\s*true/)
  })

  it('audit PR step preserves the deploy.yaml-compatible commit message prefix', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const auditStepIdx = text.indexOf('Open audit PR')
    expect(auditStepIdx).toBeGreaterThan(-1)
    const afterAudit = text.slice(auditStepIdx)
    expect(afterAudit).toContain('chore(dashboard): pin image to ')
  })
})

// ─── deploy-dashboard.yaml: job timeout-minutes ──────────────────────────────
//
// Both validate-inputs and deploy-dashboard jobs must have timeout-minutes set.
// Conservative values: validate 5, deploy 30.

describe('deploy-dashboard.yaml: job timeout-minutes', () => {
  const DEPLOY_DASHBOARD_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-dashboard.yaml')

  it('validate-inputs job has timeout-minutes: 5', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {jobs?: {'validate-inputs'?: {'timeout-minutes'?: number}}}
    expect(parsed.jobs?.['validate-inputs']?.['timeout-minutes']).toBe(5)
  })

  it('deploy-dashboard job has timeout-minutes: 30', async () => {
    const text = await Bun.file(DEPLOY_DASHBOARD_WORKFLOW).text()
    const parsed = parseYaml(text) as {jobs?: {'deploy-dashboard'?: {'timeout-minutes'?: number}}}
    expect(parsed.jobs?.['deploy-dashboard']?.['timeout-minutes']).toBe(30)
  })
})
