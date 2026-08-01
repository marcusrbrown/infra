import type {CommandResult} from './setup-core/gh'
import type {StorageManifest} from './storage'

import {parse as parseYaml} from 'yaml'
import {runGh} from './setup-core/gh'
import {interpretGhContentResult} from './setup-core/workflow-analyzer'

const WORKFLOW_PATH = '.github/workflows/fro-bot.yaml'
const STORAGE_ENVIRONMENT = 'fro-bot-storage'
const STORAGE_EVENTS = new Set(['schedule', 'workflow_dispatch'])
const CONTENT_EVENTS = new Set([
  'pull_request_target',
  'workflow_run',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issues',
  'issue_comment',
  'discussion',
  'discussion_comment',
])
const REQUIRED_S3_INPUTS = [
  'role-to-assume',
  's3-bucket',
  'aws-region',
  's3-prefix',
  's3-expected-bucket-owner',
] as const

type Mapping = Record<string, unknown>
type TriState = 'true' | 'false' | 'unknown'

export interface EnvironmentProtectionRule {
  type?: unknown
  reviewers?: unknown
}

export interface EnvironmentBranchPolicy {
  name?: unknown
  type?: unknown
}

export interface EnvironmentReadback {
  name: string
  protection_rules?: readonly EnvironmentProtectionRule[]
  deployment_branch_policy?: {
    protected_branches?: unknown
    custom_branch_policies?: unknown
  }
  branch_policies?: readonly EnvironmentBranchPolicy[]
}

export interface WorkflowVerifyDeps {
  runGh?: (args: string[]) => Promise<CommandResult>
  /**
   * Reusable workflows are a second trust boundary. The caller must provide a
   * verifier that has inspected the referenced workflow at its immutable SHA.
   */
  verifyReusableWorkflow?: (uses: string) => Promise<void>
}

export interface WorkflowVerificationResult {
  workflowYamlCompliant: boolean
  environmentPolicyVerified: boolean
  violations: readonly string[]
  workflowViolations: readonly string[]
  environmentViolations: readonly string[]
  diff: string
}

interface ParsedWorkflow {
  raw: string
  value: Mapping
}

interface JobAnalysis {
  id: string
  job: Mapping
  needs: readonly string[]
  contentReachable: boolean
  safeReachable: boolean
  dynamic: boolean
}

interface ExprLiteral {
  kind: 'literal'
  value: boolean
}

interface ExprComparison {
  kind: 'comparison'
  left: string
  operator: '==' | '!='
  right: string
}

interface ExprUnary {
  kind: 'not'
  expression: Expr
}

interface ExprBinary {
  kind: 'and' | 'or'
  left: Expr
  right: Expr
}

type Expr = ExprLiteral | ExprComparison | ExprUnary | ExprBinary

interface EvalContext {
  event: string
  ref: string
}

interface Token {
  kind: 'identifier' | 'string' | 'operator' | 'leftParen' | 'rightParen' | 'not'
  value: string
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function extractWorkflow(value: unknown): Mapping | undefined {
  if (!isMapping(value)) return undefined
  return value
}

function extractTriggers(workflow: Mapping): string[] | undefined {
  const on = workflow.on ?? workflow.true
  if (typeof on === 'string') return [on]
  if (Array.isArray(on) && on.every(event => typeof event === 'string')) return on
  if (isMapping(on)) return Object.keys(on)
  return undefined
}

function extractJobs(workflow: Mapping): {jobs: Mapping; violations: string[]} {
  if (!isMapping(workflow.jobs)) return {jobs: {}, violations: ['Workflow must define a jobs mapping.']}

  const violations: string[] = []
  const jobs: Mapping = {}
  for (const [jobId, rawJob] of Object.entries(workflow.jobs)) {
    if (!isMapping(rawJob)) {
      violations.push(`Job '${jobId}' is not a mapping.`)
      continue
    }
    jobs[jobId] = rawJob
  }
  return {jobs, violations}
}

function tokeniseExpression(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    const character = source[index] ?? ''
    if (/\s/.test(character)) {
      index += 1
      continue
    }

    if (source.startsWith('&&', index) || source.startsWith('||', index)) {
      const value = source.slice(index, index + 2)
      tokens.push({kind: 'operator', value})
      index += 2
      continue
    }

    if (source.startsWith('==', index) || source.startsWith('!=', index)) {
      const value = source.slice(index, index + 2)
      tokens.push({kind: 'operator', value})
      index += 2
      continue
    }

    if (character === '(') {
      tokens.push({kind: 'leftParen', value: character})
      index += 1
      continue
    }
    if (character === ')') {
      tokens.push({kind: 'rightParen', value: character})
      index += 1
      continue
    }
    if (character === '!') {
      tokens.push({kind: 'not', value: character})
      index += 1
      continue
    }

    if (character === "'" || character === '"') {
      const quote = character
      let end = index + 1
      while (end < source.length && source[end] !== quote) end += 1
      if (end >= source.length) throw new Error('unterminated string literal')
      tokens.push({kind: 'string', value: source.slice(index + 1, end)})
      index = end + 1
      continue
    }

    const identifier = /^[A-Z_][\w.-]*/i.exec(source.slice(index))
    if (identifier?.[0]) {
      tokens.push({kind: 'identifier', value: identifier[0]})
      index += identifier[0].length
      continue
    }

    throw new Error(`unsupported character '${character}'`)
  }

  return tokens
}

class ExpressionParser {
  private readonly tokens: readonly Token[]
  private index = 0

  constructor(source: string) {
    this.tokens = tokeniseExpression(source)
  }

  parse(): Expr {
    const expression = this.parseOr()
    if (this.index !== this.tokens.length) throw new Error('trailing expression tokens')
    return expression
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private consume(): Token {
    const token = this.peek()
    if (!token) throw new Error('unexpected end of expression')
    this.index += 1
    return token
  }

  private parseOr(): Expr {
    let expression = this.parseAnd()
    while (this.peek()?.value === '||') {
      this.consume()
      expression = {kind: 'or', left: expression, right: this.parseAnd()}
    }
    return expression
  }

  private parseAnd(): Expr {
    let expression = this.parseUnary()
    while (this.peek()?.value === '&&') {
      this.consume()
      expression = {kind: 'and', left: expression, right: this.parseUnary()}
    }
    return expression
  }

  private parseUnary(): Expr {
    if (this.peek()?.kind === 'not') {
      this.consume()
      return {kind: 'not', expression: this.parseUnary()}
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Expr {
    if (this.peek()?.kind === 'leftParen') {
      this.consume()
      const expression = this.parseOr()
      if (this.consume().kind !== 'rightParen') throw new Error('unclosed parenthesized expression')
      return expression
    }

    const left = this.consume()
    if (left.kind === 'identifier' && (left.value === 'true' || left.value === 'false')) {
      return {kind: 'literal', value: left.value === 'true'}
    }
    if (left.kind !== 'identifier') throw new Error('expected a GitHub context identifier')
    if (!['github.event_name', 'github.ref', 'github.ref_name'].includes(left.value)) {
      throw new Error(`dynamic identifier '${left.value}'`)
    }

    const operator = this.consume()
    if (operator.kind !== 'operator' || !['==', '!='].includes(operator.value)) {
      throw new Error(`expected == or != after '${left.value}'`)
    }
    const right = this.consume()
    if (right.kind !== 'string') throw new Error('expected a quoted static comparison value')
    return {kind: 'comparison', left: left.value, operator: operator.value as '==' | '!=', right: right.value}
  }
}

function evaluateExpression(expression: Expr, context: EvalContext): TriState {
  switch (expression.kind) {
    case 'literal':
      return expression.value ? 'true' : 'false'
    case 'comparison': {
      const actual =
        expression.left === 'github.event_name'
          ? context.event
          : expression.left === 'github.ref'
            ? context.ref
            : context.ref === 'refs/heads/main'
              ? 'main'
              : (context.ref.split('/').at(-1) ?? '')
      const matches = actual === expression.right
      return (expression.operator === '==' ? matches : !matches) ? 'true' : 'false'
    }
    case 'not': {
      const value = evaluateExpression(expression.expression, context)
      return value === 'unknown' ? value : value === 'true' ? 'false' : 'true'
    }
    case 'and': {
      const left = evaluateExpression(expression.left, context)
      const right = evaluateExpression(expression.right, context)
      if (left === 'false' || right === 'false') return 'false'
      if (left === 'unknown' || right === 'unknown') return 'unknown'
      return 'true'
    }
    case 'or': {
      const left = evaluateExpression(expression.left, context)
      const right = evaluateExpression(expression.right, context)
      if (left === 'true' || right === 'true') return 'true'
      if (left === 'unknown' || right === 'unknown') return 'unknown'
      return 'false'
    }
  }
}

function parseIfCondition(value: unknown): {expression?: Expr; error?: string} {
  if (value === undefined) return {expression: {kind: 'literal', value: true}}
  if (typeof value === 'boolean') return {expression: {kind: 'literal', value}}
  if (typeof value !== 'string') return {error: 'if condition is not a static expression'}

  let source = value.trim()
  if (source.startsWith('${{') && source.endsWith('}}')) source = source.slice(3, -2).trim()
  try {
    return {expression: new ExpressionParser(source).parse()}
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)}
  }
}

function normalizeNeeds(value: unknown): {needs: string[]; error?: string} {
  if (value === undefined) return {needs: []}
  if (typeof value === 'string') {
    return value.includes('${{') ? {needs: [], error: 'needs contains a dynamic expression'} : {needs: [value]}
  }
  if (Array.isArray(value) && value.every(need => typeof need === 'string')) {
    return value.some(need => need.includes('${{'))
      ? {needs: [], error: 'needs contains a dynamic expression'}
      : {needs: value}
  }
  return {needs: [], error: 'needs must be a string or an array of job ids'}
}

function isStaticMatrixValue(value: unknown): boolean {
  if (typeof value === 'string') return !value.includes('${{')
  return value === null || typeof value === 'number' || typeof value === 'boolean'
}

function validateMatrix(job: Mapping): string | undefined {
  const strategy = job.strategy
  if (strategy === undefined) return undefined
  if (!isMapping(strategy)) return 'strategy must be a static mapping'
  if (!('matrix' in strategy)) return undefined
  const matrix = strategy.matrix
  if (!isMapping(matrix)) return 'matrix must be a static mapping; dynamic expressions are not provably safe'

  let expansionCount = 1
  for (const [key, value] of Object.entries(matrix)) {
    if (key === 'include' || key === 'exclude') {
      if (
        !Array.isArray(value) ||
        !value.every(entry => isMapping(entry) && Object.values(entry).every(isStaticMatrixValue))
      ) {
        return 'matrix include/exclude contains a dynamic expression'
      }
      continue
    }
    if (!Array.isArray(value) || value.length === 0 || !value.every(isStaticMatrixValue)) {
      return `matrix.${key} is dynamic or empty`
    }
    expansionCount *= Math.max(1, value.length)
    if (expansionCount > 64) return 'matrix expands beyond the conservative 64-combination limit'
  }
  return undefined
}

function effectivePermission(workflowPermissions: unknown, job: Mapping, permission: string): unknown {
  const jobPermissions = isMapping(job.permissions) ? job.permissions : undefined
  if (jobPermissions && permission in jobPermissions) return jobPermissions[permission]
  if (workflowPermissions === 'write-all') return 'write'
  if (workflowPermissions === 'read-all') return 'read'
  if (isMapping(workflowPermissions)) return workflowPermissions[permission]
  return undefined
}

function hasWorkflowLevelIdToken(workflowPermissions: unknown): boolean {
  return isMapping(workflowPermissions) && 'id-token' in workflowPermissions
}

function isStorageCapable(job: Mapping): boolean {
  return (
    isMapping(job.permissions) && job.permissions['id-token'] === 'write' && job.environment === STORAGE_ENVIRONMENT
  )
}

function eventContexts(events: readonly string[]): EvalContext[] {
  return events.flatMap(event => {
    if (event === 'schedule') return [{event, ref: 'refs/heads/main'}]
    if (event === 'workflow_dispatch') {
      return [
        {event, ref: 'refs/heads/main'},
        {event, ref: 'refs/heads/other'},
      ]
    }
    return [
      {event, ref: 'refs/heads/main'},
      {event, ref: 'refs/heads/other'},
    ]
  })
}

function analyzeReachability(
  jobId: string,
  job: Mapping,
  events: readonly string[],
  workflowPermissions: unknown,
  violations: string[],
): JobAnalysis {
  const needsResult = normalizeNeeds(job.needs)
  if (needsResult.error) violations.push(`Job '${jobId}': ${needsResult.error}.`)

  const condition = parseIfCondition(job.if)
  let dynamic = false
  let contentReachable = false
  let safeReachable = false
  if (condition.error) {
    dynamic = true
    contentReachable = true
    if (isStorageCapable(job) || effectivePermission(workflowPermissions, job, 'id-token') === 'write') {
      violations.push(`Job '${jobId}' has a dynamic if condition and cannot be proven safe: ${condition.error}.`)
    }
  }

  if (condition.expression) {
    for (const context of eventContexts(events)) {
      const value = evaluateExpression(condition.expression, context)
      if (value === 'unknown') {
        dynamic = true
        contentReachable = true
        if (isStorageCapable(job) || effectivePermission(workflowPermissions, job, 'id-token') === 'write') {
          violations.push(`Job '${jobId}' has an undecidable reachability expression.`)
        }
        continue
      }
      if (value !== 'true') continue
      if (STORAGE_EVENTS.has(context.event) && (context.event === 'schedule' || context.ref === 'refs/heads/main')) {
        safeReachable = true
      }
      if (
        !STORAGE_EVENTS.has(context.event) ||
        (context.event === 'workflow_dispatch' && context.ref !== 'refs/heads/main')
      ) {
        contentReachable = true
      }
    }
  }

  return {
    id: jobId,
    job,
    needs: needsResult.needs,
    contentReachable,
    safeReachable,
    dynamic,
  }
}

function stepValues(job: Mapping): Mapping[] {
  if (!Array.isArray(job.steps)) return []
  return job.steps.filter(isMapping)
}

function checkStorageAction(jobId: string, job: Mapping, violations: string[]): void {
  if (typeof job.uses === 'string') return
  if (!Array.isArray(job.steps)) {
    violations.push(`Storage job '${jobId}' must define steps containing fro-bot/agent.`)
    return
  }

  const agentSteps = stepValues(job).filter(
    step => typeof step.uses === 'string' && step.uses.startsWith('fro-bot/agent@'),
  )
  if (agentSteps.length === 0) {
    violations.push(`Storage job '${jobId}' must contain a fro-bot/agent action step.`)
    return
  }

  for (const [index, step] of agentSteps.entries()) {
    const uses = String(step.uses)
    const ref = uses.split('@').at(-1) ?? ''
    if (!/^[0-9a-f]{40}$/i.test(ref))
      violations.push(`Storage job '${jobId}' agent step ${index + 1} is not SHA-pinned.`)

    if (!isMapping(step.with)) {
      violations.push(`Storage job '${jobId}' agent step ${index + 1} is missing its S3 inputs.`)
      continue
    }
    for (const input of REQUIRED_S3_INPUTS) {
      const value = step.with[input]
      if (value === undefined || value === null || value === '') {
        violations.push(`Storage job '${jobId}' agent step ${index + 1} is missing S3 input '${input}'.`)
      }
    }
  }
}

function checkReusableWorkflow(
  jobId: string,
  job: Mapping,
  deps: WorkflowVerifyDeps,
  violations: string[],
): Promise<void>[] {
  if (typeof job.uses !== 'string') return []
  const uses = job.uses
  const ref = uses.split('@').at(-1) ?? ''
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    violations.push(`Storage job '${jobId}' uses an unpinned reusable workflow '${uses}'.`)
    return []
  }
  if (!deps.verifyReusableWorkflow) {
    violations.push(`Storage job '${jobId}' reusable workflow '${uses}' has not been separately verified.`)
    return []
  }
  return [
    deps.verifyReusableWorkflow(uses).catch(error => {
      violations.push(
        `Storage job '${jobId}' reusable workflow verification failed: ${error instanceof Error ? error.message : String(error)}.`,
      )
    }),
  ]
}

function hasHandoff(job: Mapping): boolean {
  const serialized = stringifyUnknown(job)
  return (
    /needs\.[\w-]+\.outputs\./.test(serialized) ||
    /actions\/(?:download-artifact|upload-artifact|cache|cache\/restore|cache\/save)@/.test(serialized)
  )
}

function hasStaticAwsCredentials(job: Mapping): boolean {
  const serialized = stringifyUnknown(job)
  return /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws-access-key-id|aws-secret-access-key/.test(serialized)
}

function ancestors(jobId: string, analyses: ReadonlyMap<string, JobAnalysis>): Set<string> {
  const visited = new Set<string>()
  const pending = [...(analyses.get(jobId)?.needs ?? [])]
  while (pending.length > 0) {
    const next = pending.pop()
    if (!next || visited.has(next)) continue
    visited.add(next)
    pending.push(...(analyses.get(next)?.needs ?? []))
  }
  return visited
}

function validateNeedsGraph(analyses: ReadonlyMap<string, JobAnalysis>, violations: string[]): void {
  for (const analysis of analyses.values()) {
    for (const need of analysis.needs) {
      if (!analyses.has(need)) violations.push(`Job '${analysis.id}' needs unknown job '${need}'.`)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (jobId: string): void => {
    if (visiting.has(jobId)) {
      violations.push(`Job needs graph contains a cycle involving '${jobId}'.`)
      return
    }
    if (visited.has(jobId)) return
    visiting.add(jobId)
    for (const need of analyses.get(jobId)?.needs ?? []) {
      if (analyses.has(need)) visit(need)
    }
    visiting.delete(jobId)
    visited.add(jobId)
  }
  for (const jobId of analyses.keys()) visit(jobId)
}

function formatStorageWorkflowSnippet(): string {
  return `jobs:
  fro-bot-content:
    # Keep the existing content-triggered work here, but do not grant id-token.
    permissions:
      contents: read
  fro-bot-storage:
    if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')
    environment: fro-bot-storage
    permissions:
      contents: read
      id-token: write
    timeout-minutes: 30
    steps:
      - uses: fro-bot/agent@<40-character-commit-sha>
        with:
          role-to-assume: \${{ vars.FRO_BOT_S3_ROLE_TO_ASSUME }}
          s3-bucket: \${{ vars.FRO_BOT_S3_BUCKET }}
          aws-region: \${{ vars.FRO_BOT_S3_REGION }}
          s3-prefix: \${{ vars.FRO_BOT_S3_PREFIX }}
          s3-expected-bucket-owner: \${{ vars.FRO_BOT_S3_EXPECTED_BUCKET_OWNER }}`
}

function formatWorkflowDiff(workflow: string, violations: readonly string[]): string {
  const lines = workflow.trimEnd().split('\n')
  const jobsIndex = lines.findIndex(line => /^jobs:\s*$/.test(line))
  const currentJobs = jobsIndex === -1 ? [] : lines.slice(jobsIndex)
  const proposedJobs = formatStorageWorkflowSnippet().split('\n')
  const oldStart = jobsIndex === -1 ? lines.length + 1 : jobsIndex + 1
  const oldCount = currentJobs.length
  const newStart = oldStart
  return [
    '--- a/.github/workflows/fro-bot.yaml',
    '+++ b/.github/workflows/fro-bot.yaml',
    `@@ -${oldStart},${oldCount} +${newStart},${proposedJobs.length} @@`,
    ...currentJobs.map(line => `-${line}`),
    ...proposedJobs.map(line => `+${line}`),
    '',
    '# Violations detected:',
    ...violations.map(violation => `# - ${violation}`),
  ].join('\n')
}

function environmentResult(
  environmentValue: unknown,
  branchPoliciesValue: unknown,
): {verified: boolean; violations: string[]} {
  const violations: string[] = []
  if (!isMapping(environmentValue)) {
    violations.push('GitHub Environment fro-bot-storage is missing or returned an invalid response.')
    return {verified: false, violations}
  }

  const protectionRules = Array.isArray(environmentValue.protection_rules) ? environmentValue.protection_rules : []
  const hasReviewer = protectionRules.some(
    rule =>
      isMapping(rule) &&
      rule.type === 'required_reviewers' &&
      Array.isArray(rule.reviewers) &&
      rule.reviewers.length > 0,
  )
  if (!hasReviewer) violations.push('GitHub Environment fro-bot-storage has no required reviewer protection rule.')

  const branchPolicy = environmentValue.deployment_branch_policy
  if (
    !isMapping(branchPolicy) ||
    branchPolicy.protected_branches !== false ||
    branchPolicy.custom_branch_policies !== true
  ) {
    violations.push('GitHub Environment fro-bot-storage does not use a custom deployment-branch policy.')
  }

  const branchPolicies = isMapping(branchPoliciesValue) ? branchPoliciesValue.branch_policies : undefined
  if (
    !Array.isArray(branchPolicies) ||
    branchPolicies.length !== 1 ||
    !isMapping(branchPolicies[0]) ||
    branchPolicies[0].name !== 'main' ||
    branchPolicies[0].type !== 'branch'
  ) {
    violations.push('GitHub Environment fro-bot-storage deployment branches are not exactly main.')
  }

  return {verified: violations.length === 0, violations}
}

async function readJson(result: CommandResult, description: string): Promise<unknown> {
  if (result.exitCode !== 0) {
    throw new Error(`${description}: ${result.stderr.trim() || `gh exited with code ${result.exitCode}`}`)
  }
  try {
    return JSON.parse(result.stdout) as unknown
  } catch (error) {
    throw new Error(`${description}: malformed JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

async function verifyEnvironmentPolicy(
  repo: string,
  gh: (args: string[]) => Promise<CommandResult>,
): Promise<{verified: boolean; violations: string[]}> {
  const environmentPath = `/repos/${repo}/environments/${STORAGE_ENVIRONMENT}`
  const branchPoliciesPath = `${environmentPath}/deployment-branch-policies`
  const [environmentResponse, branchPoliciesResponse] = await Promise.all([
    gh(['api', environmentPath]),
    gh(['api', branchPoliciesPath]),
  ])

  let environmentValue: unknown
  let branchPoliciesValue: unknown
  try {
    environmentValue = await readJson(environmentResponse, 'GitHub Environment readback failed')
  } catch (error) {
    return {verified: false, violations: [error instanceof Error ? error.message : String(error)]}
  }
  try {
    branchPoliciesValue = await readJson(branchPoliciesResponse, 'GitHub Environment branch-policy readback failed')
  } catch (error) {
    return {verified: false, violations: [error instanceof Error ? error.message : String(error)]}
  }
  return environmentResult(environmentValue, branchPoliciesValue)
}

async function readWorkflow(
  repo: string,
  gh: (args: string[]) => Promise<CommandResult>,
): Promise<{content?: string; violation?: string}> {
  const result = await gh([
    'api',
    '--header',
    'Accept: application/vnd.github.raw',
    `/repos/${repo}/contents/${WORKFLOW_PATH}`,
  ])
  if (result.exitCode !== 0) {
    const check = interpretGhContentResult(result)
    return {
      violation:
        check.kind === 'missing'
          ? `GitHub workflow ${WORKFLOW_PATH} is missing.`
          : `GitHub workflow ${WORKFLOW_PATH} is unreachable: ${check.kind === 'unreachable' ? check.reason : 'unknown error'}.`,
    }
  }
  return {content: result.stdout}
}

async function inspectWorkflowYaml(
  content: string,
  deps: WorkflowVerifyDeps,
): Promise<{violations: string[]; reusableChecks: Promise<void>[]}> {
  const violations: string[] = []
  const reusableChecks: Promise<void>[] = []
  let parsed: ParsedWorkflow
  try {
    const value = extractWorkflow(parseYaml(content, {merge: true}) as unknown)
    if (!value) throw new Error('top-level YAML value must be a mapping')
    parsed = {raw: content, value}
  } catch (error) {
    return {
      violations: [`Workflow YAML could not be parsed: ${error instanceof Error ? error.message : String(error)}.`],
      reusableChecks,
    }
  }

  const events = extractTriggers(parsed.value)
  if (!events || events.length === 0) {
    violations.push('Workflow must declare a statically known on mapping.')
    return {violations, reusableChecks}
  }
  const unknownEvents = events.filter(event => !STORAGE_EVENTS.has(event))
  if (unknownEvents.some(event => !CONTENT_EVENTS.has(event))) {
    violations.push(
      `Workflow has an event not provably safe for storage: ${unknownEvents.filter(event => !CONTENT_EVENTS.has(event)).join(', ')}.`,
    )
  }

  const workflowPermissions = parsed.value.permissions
  if (hasWorkflowLevelIdToken(workflowPermissions)) {
    violations.push('workflow-level id-token permission is forbidden; id-token must be job-level only.')
  }
  if (workflowPermissions === 'write-all') {
    violations.push('workflow-level write-all permissions are forbidden because they include id-token.')
  }

  const {jobs, violations: jobShapeViolations} = extractJobs(parsed.value)
  violations.push(...jobShapeViolations)
  const analyses = new Map<string, JobAnalysis>()
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = rawJob as Mapping
    analyses.set(jobId, analyzeReachability(jobId, job, events, workflowPermissions, violations))
  }
  validateNeedsGraph(analyses, violations)

  let storageJobCount = 0
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = rawJob as Mapping
    const analysis = analyses.get(jobId)
    if (!analysis) continue
    const jobIdToken = isMapping(job.permissions) ? job.permissions['id-token'] : undefined
    const effectiveIdToken = effectivePermission(workflowPermissions, job, 'id-token')
    const storageJob = isStorageCapable(job)

    if (jobIdToken === 'write' && !storageJob) {
      violations.push(`Job '${jobId}' grants job-level id-token: write without environment ${STORAGE_ENVIRONMENT}.`)
    }
    if (jobIdToken !== undefined && jobIdToken !== 'write' && jobIdToken !== 'none' && jobIdToken !== 'read') {
      violations.push(`Job '${jobId}' has an undecidable id-token permission.`)
    }
    if (effectiveIdToken === 'write' && jobIdToken !== 'write') {
      violations.push(`Job '${jobId}' receives id-token: write through workflow-level or non-explicit permissions.`)
    }

    if (!storageJob) continue
    storageJobCount += 1
    if (!analysis.safeReachable || analysis.contentReachable || analysis.dynamic) {
      violations.push(
        `Storage job '${jobId}' is reachable outside schedule and workflow_dispatch on refs/heads/main${analysis.dynamic ? ' or has dynamic reachability' : ''}.`,
      )
    }
    const matrixViolation = validateMatrix(job)
    if (matrixViolation) violations.push(`Storage job '${jobId}': ${matrixViolation}.`)
    if (hasStaticAwsCredentials(job)) {
      violations.push(`Storage job '${jobId}' exposes static AWS credentials; use GitHub OIDC only.`)
    }

    if (
      typeof job['timeout-minutes'] !== 'number' ||
      !Number.isInteger(job['timeout-minutes']) ||
      job['timeout-minutes'] <= 0
    ) {
      violations.push(`Storage job '${jobId}' must set a positive explicit timeout-minutes value.`)
    }

    checkStorageAction(jobId, job, violations)
    reusableChecks.push(...checkReusableWorkflow(jobId, job, deps, violations))

    const ancestorIds = ancestors(jobId, analyses)
    const contentAncestors = [...ancestorIds].filter(ancestorId => {
      const ancestor = analyses.get(ancestorId)
      return ancestor?.contentReachable || ancestor?.dynamic
    })
    if (contentAncestors.length > 0 && hasHandoff(job)) {
      violations.push(
        `Storage job '${jobId}' has an artifact/cache/output handoff from content-reachable job(s): ${contentAncestors.join(', ')}.`,
      )
    }
  }

  if (storageJobCount === 0)
    violations.push(
      `No storage-capable job found with job-level id-token: write and environment ${STORAGE_ENVIRONMENT}.`,
    )
  return {violations, reusableChecks}
}

export async function inspectWorkflow(
  repo: string,
  _manifest: StorageManifest,
  deps: WorkflowVerifyDeps = {},
): Promise<WorkflowVerificationResult> {
  const gh = deps.runGh ?? runGh
  const workflow = await readWorkflow(repo, gh)
  const workflowInspection = workflow.violation
    ? {violations: [workflow.violation], reusableChecks: [] as Promise<void>[]}
    : await inspectWorkflowYaml(workflow.content ?? '', deps)
  await Promise.all(workflowInspection.reusableChecks)
  const workflowViolations = workflowInspection.violations
  const environment = await verifyEnvironmentPolicy(repo, gh)
  const result: WorkflowVerificationResult = {
    workflowYamlCompliant: workflowViolations.length === 0,
    environmentPolicyVerified: environment.verified,
    violations: [...workflowViolations, ...environment.violations],
    workflowViolations,
    environmentViolations: environment.violations,
    diff: formatWorkflowDiff(workflow.content ?? '', workflowViolations),
  }
  return result
}

export async function verifyWorkflow(
  repo: string,
  _manifest: StorageManifest,
  deps: WorkflowVerifyDeps = {},
): Promise<void> {
  const gh = deps.runGh ?? runGh
  const workflow = await readWorkflow(repo, gh)
  const workflowInspection = workflow.violation
    ? {violations: [workflow.violation], reusableChecks: [] as Promise<void>[]}
    : await inspectWorkflowYaml(workflow.content ?? '', deps)
  await Promise.all(workflowInspection.reusableChecks)
  const environment = await verifyEnvironmentPolicy(repo, gh)
  const workflowViolations = workflowInspection.violations
  if (workflowViolations.length === 0 && environment.verified) return

  const result: WorkflowVerificationResult = {
    workflowYamlCompliant: workflowViolations.length === 0,
    environmentPolicyVerified: environment.verified,
    violations: [...workflowViolations, ...environment.violations],
    workflowViolations,
    environmentViolations: environment.violations,
    diff: formatWorkflowDiff(workflow.content ?? '', workflowViolations),
  }
  const report = [
    `Workflow storage verification failed for ${repo}.`,
    `Workflow YAML compliant: ${result.workflowYamlCompliant ? 'YES' : 'NO'}`,
    ...result.workflowViolations.map(violation => `- ${violation}`),
    `GitHub Environment policy verified: ${result.environmentPolicyVerified ? 'YES' : 'NO'}`,
    ...result.environmentViolations.map(violation => `- ${violation}`),
  ]
  if (result.workflowViolations.length > 0) {
    report.push('Suggested unified diff (the workflow was not modified):', result.diff)
  }
  throw new Error(report.join('\n'))
}
