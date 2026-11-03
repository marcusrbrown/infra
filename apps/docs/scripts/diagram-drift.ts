import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {basename, join, resolve} from 'node:path'
import GithubSlugger from 'github-slugger'
import {
  buildComposeOverride,
  CLIPROXY_EGRESS_HOST,
  OPENCODE_CATALOG_HOSTS,
  type ComposeOverrideOpts,
} from '../../gateway/src/deploy'
import {discoverSpecs} from './render-diagrams'

// Diagram drift checker. A pure `check` compares the node ids of each rendered diagram spec, an explicit mapping
// table, and facts read from the repo (compose files, the gateway's upstream compose and override, the egress
// allowlist, the deploy workflows, runbook headings, the apps/* directories). The readers turn a missing or empty
// source into a `SourceError`; `readRepoFacts` records those instead of throwing so one broken source never hides
// the findings for the others.

// ─── Facts ───────────────────────────────────────────────────────────────────

export type FactKind = 'app' | 'service' | 'volume' | 'egress-host' | 'job' | 'environment' | 'anchor'

/** Fact kinds a table may list as "not drawn". Egress hosts must always be drawn; anchors skip that direction. */
export type NotDrawnKind = Exclude<FactKind, 'egress-host' | 'anchor'>

/** One structural fact. The key is `(kind, file, id)`, so equal ids in different files stay distinct facts. */
export interface Fact {
  readonly kind: FactKind
  readonly file: string
  readonly id: string
}

export interface KindedFact<K extends FactKind> extends Fact {
  readonly kind: K
}

export type NotDrawnFact = KindedFact<NotDrawnKind>

/** Pseudo-files for facts that have no single file of their own. */
export const APPS_SOURCE = 'apps'
export const EGRESS_SOURCE = 'apps/gateway/src/deploy.ts'
export const GATEWAY_UPSTREAM_SOURCE = 'gateway:upstream-compose'
export const GATEWAY_OVERRIDE_SOURCE = 'gateway:compose-override'

export const composePath = (app: string): string => `apps/${app}/docker-compose.yaml`
export const workflowPath = (name: string): string => `.github/workflows/${name}`
export const runbookPath = (name: string): string => `docs/runbooks/${name}`

/** Constructors for table authors. The file is part of the fact key, so pass the same path the readers use. */
export const fact = {
  app: (id: string): KindedFact<'app'> => ({kind: 'app', file: APPS_SOURCE, id}),
  service: (file: string, id: string): KindedFact<'service'> => ({kind: 'service', file, id}),
  volume: (file: string, id: string): KindedFact<'volume'> => ({kind: 'volume', file, id}),
  egressHost: (id: string): KindedFact<'egress-host'> => ({kind: 'egress-host', file: EGRESS_SOURCE, id}),
  job: (file: string, id: string): KindedFact<'job'> => ({kind: 'job', file, id}),
  environment: (file: string, id: string): KindedFact<'environment'> => ({kind: 'environment', file, id}),
  anchor: (file: string, id: string): KindedFact<'anchor'> => ({kind: 'anchor', file, id}),
} as const

export function factKey(item: Fact): string {
  return `${item.kind}|${item.file}|${item.id}`
}

/** A source that could not be read. The message is shown to the operator as-is. */
export class SourceError extends Error {
  override readonly name = 'SourceError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKey(record: object, key: string): boolean {
  return Object.keys(record).includes(key)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─── Table and checker types ─────────────────────────────────────────────────

/** A node either stands for facts or is illustrative with a reason; "both" is not expressible. */
export type NodeMapping = {readonly facts: readonly Fact[]} | {readonly illustrative: string}

/** "Every fact of this kind in this file must be drawn or listed as not drawn" (direction 1). */
export interface FactScope {
  readonly kind: Exclude<FactKind, 'anchor'>
  readonly file: string
}

export interface NotDrawnEntry {
  readonly fact: NotDrawnFact
  readonly reason: string
}

export interface DiagramEntry {
  /** The facts this diagram must account for. Runbook maps leave this empty: a map draws one procedure. */
  readonly covers: readonly FactScope[]
  /** Keyed by spec node id, so a duplicate row is not expressible. */
  readonly nodes: Readonly<Record<string, NodeMapping>>
  readonly notDrawn?: readonly NotDrawnEntry[]
  /** The app has no compose file, and the table says so. */
  readonly noCompose?: {readonly app: string; readonly reason: string}
}

export interface OutOfScopeEntry {
  readonly outOfScope: string
}

export type TableEntry = DiagramEntry | OutOfScopeEntry

/** Keyed by spec name (the `name` that `discoverSpecs` returns). */
export type DriftTable = Readonly<Record<string, TableEntry>>

export type SpecInput =
  {readonly name: string; readonly nodeIds: readonly string[]} | {readonly name: string; readonly error: string}

export interface RepoFacts {
  readonly facts: readonly Fact[]
  /** Source files that were read successfully. */
  readonly sources: ReadonlySet<string>
  /** Source files that exist (or should) but could not be read, with the reason. */
  readonly sourceErrors: ReadonlyMap<string, string>
  /** Facts that exist but must not be mapped, keyed by `factKey`, with the reason. */
  readonly unmappable: ReadonlyMap<string, string>
}

export type Direction =
  | 'undrawn-fact'
  | 'missing-fact'
  | 'unmapped-node'
  | 'orphan-row'
  | 'conflict'
  | 'unmappable-fact'
  | 'stale-not-drawn'
  | 'source'
  | 'table'
  | 'spec'
  | 'unlisted-spec'
  | 'orphan-entry'

export interface Finding {
  readonly diagram: string
  /** The node id or the fact the finding is about. */
  readonly subject: string
  readonly direction: Direction
  /** `<diagram>: <what is wrong>`, ready to print. */
  readonly message: string
}

export interface CheckInput {
  readonly specs: readonly SpecInput[]
  readonly table: DriftTable
  readonly facts: RepoFacts
}

export interface RepoFactsExtra {
  readonly sources?: Iterable<string>
  readonly sourceErrors?: Iterable<readonly [string, string]>
  readonly unmappable?: Iterable<readonly [string, string]>
}

/** Builds a `RepoFacts`. Every file that carries a fact counts as a source that was read. */
export function repoFacts(facts: readonly Fact[], extra: RepoFactsExtra = {}): RepoFacts {
  return {
    facts,
    sources: new Set([...facts.map(item => item.file), ...(extra.sources ?? [])]),
    sourceErrors: new Map(extra.sourceErrors ?? []),
    unmappable: new Map(extra.unmappable ?? []),
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

function isGatewayFile(file: string): boolean {
  return file === GATEWAY_UPSTREAM_SOURCE || file === GATEWAY_OVERRIDE_SOURCE
}

function composeLabel(file: string): string {
  if (file === GATEWAY_UPSTREAM_SOURCE) return 'upstream compose'
  if (file === GATEWAY_OVERRIDE_SOURCE) return 'override compose'
  return 'compose'
}

function describeFact(item: Fact): string {
  switch (item.kind) {
    case 'app':
      return `app \`${item.id}\``
    case 'service':
      return `${composeLabel(item.file)} service \`${item.id}\``
    case 'volume':
      return `${composeLabel(item.file)} volume \`${item.id}\``
    case 'egress-host':
      return `egress host \`${item.id}\``
    case 'job':
      return `\`${basename(item.file)}\` job \`${item.id}\``
    case 'environment':
      return `\`${basename(item.file)}\` environment \`${item.id}\``
    case 'anchor':
      return `\`${basename(item.file)}\` heading anchor \`#${item.id}\``
  }
}

const GATEWAY_HINT =
  ' Fix it in the gateway diagram spec, in the mapping table, or in the `apps/gateway/upstream.json` ref if a pin bump caused it.' +
  ' Fro Bot cannot push `apps/docs` changes, so a human makes the fix on the Renovate branch.'

/** The one place that renders a finding, so every message names the diagram and the subject the same way. */
class Reporter {
  readonly findings: Finding[] = []
  private readonly sourceReported = new Set<string>()

  constructor(readonly diagram: string) {}

  add(direction: Direction, subject: string, text: string, about?: Fact): void {
    const hint = about !== undefined && isGatewayFile(about.file) ? GATEWAY_HINT : ''
    this.findings.push({diagram: this.diagram, subject, direction, message: `${this.diagram}: ${text}${hint}`})
  }

  /** Reports each unusable or missing source once per diagram. */
  source(file: string, facts: RepoFacts): void {
    if (this.sourceReported.has(file)) return
    this.sourceReported.add(file)
    const reason = facts.sourceErrors.get(file)
    const text = reason === undefined ? `source \`${file}\` is missing.` : `source \`${file}\` is unusable: ${reason}.`
    this.add('source', file, text)
  }
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map(finding => finding.message).join('\n')
}

// ─── Checker ─────────────────────────────────────────────────────────────────

function isIllustrative(mapping: NodeMapping): mapping is {readonly illustrative: string} {
  return 'illustrative' in mapping
}

function isOutOfScope(entry: TableEntry): entry is OutOfScopeEntry {
  return 'outOfScope' in entry
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

function widenKind(item: Fact): FactKind {
  return item.kind
}

function inScope(item: Fact, scopes: readonly FactScope[]): boolean {
  return scopes.some(scope => scope.kind === item.kind && scope.file === item.file)
}

function checkDiagram(
  name: string,
  nodeIds: readonly string[],
  entry: DiagramEntry,
  facts: RepoFacts,
  index: ReadonlyMap<string, Fact>,
): Finding[] {
  const report = new Reporter(name)
  const rows = Object.entries(entry.nodes)
  const notDrawn = entry.notDrawn ?? []

  // Table validity: reasons and facts must be present, and "not drawn" is closed to egress hosts and anchors.
  for (const [node, mapping] of rows) {
    if (isIllustrative(mapping)) {
      if (mapping.illustrative.trim() === '')
        report.add('table', node, `node \`${node}\` is illustrative but gives no reason.`)
    } else if (mapping.facts.length === 0) {
      report.add('table', node, `node \`${node}\` maps to no facts.`)
    }
  }
  for (const {fact: omitted, reason} of notDrawn) {
    // The type forbids these kinds; a hand-edited or JSON-built table can still carry them.
    const kind = widenKind(omitted)
    if (kind === 'egress-host' || kind === 'anchor') {
      report.add('table', omitted.id, `${describeFact(omitted)} cannot be listed as not drawn.`, omitted)
    } else if (reason.trim() === '') {
      report.add('table', omitted.id, `not-drawn ${describeFact(omitted)} gives no reason.`, omitted)
    }
  }
  if (entry.noCompose !== undefined) {
    const {app, reason} = entry.noCompose
    const file = composePath(app)
    if (reason.trim() === '')
      report.add('table', app, `app \`${app}\` is declared to have no compose file but gives no reason.`)
    if (facts.sources.has(file) || facts.sourceErrors.has(file)) {
      report.add('table', app, `app \`${app}\` is declared to have no compose file, but \`${file}\` exists.`)
    }
  }

  // Direction 5: duplicate node ids.
  for (const id of duplicates(nodeIds)) {
    report.add('conflict', id, `node id \`${id}\` appears more than once in the spec.`)
  }

  // Directions 3 and 4: spec nodes against table rows.
  const specNodes = new Set(nodeIds)
  for (const id of specNodes) {
    if (!hasKey(entry.nodes, id)) {
      report.add('unmapped-node', id, `node \`${id}\` is neither mapped nor listed as illustrative.`)
    }
  }
  for (const [node] of rows) {
    if (!specNodes.has(node)) report.add('orphan-row', node, `table row \`${node}\` has no node in the spec.`)
  }

  // Direction 5: a fact claimed by two nodes, or both mapped and not drawn.
  const claims = new Map<string, {fact: Fact; nodes: string[]}>()
  for (const [node, mapping] of rows) {
    if (isIllustrative(mapping)) continue
    for (const claimed of mapping.facts) {
      const key = factKey(claimed)
      const existing = claims.get(key)
      if (existing === undefined) claims.set(key, {fact: claimed, nodes: [node]})
      else if (!existing.nodes.includes(node)) existing.nodes.push(node)
    }
  }
  for (const {fact: claimed, nodes} of claims.values()) {
    // Runbook-map steps may share one anchor when a section covers more than one step.
    if (claimed.kind === 'anchor') continue
    const [first, second, ...rest] = nodes
    if (first !== undefined && second !== undefined) {
      const others = [second, ...rest].map(node => `\`${node}\``)
      const list = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others.at(-1)}`
      report.add(
        'conflict',
        claimed.id,
        `${describeFact(claimed)} is claimed by nodes \`${first}\` and ${list}.`,
        claimed,
      )
    }
  }
  const notDrawnKeys = new Set(notDrawn.map(item => factKey(item.fact)))
  for (const [key, {fact: claimed, nodes}] of claims) {
    if (notDrawnKeys.has(key)) {
      report.add(
        'conflict',
        claimed.id,
        `${describeFact(claimed)} is both mapped (node \`${nodes[0]}\`) and listed as not drawn.`,
        claimed,
      )
    }
  }

  // Sources the diagram depends on must exist and be readable (R14).
  for (const scope of entry.covers) {
    if (!facts.sources.has(scope.file)) report.source(scope.file, facts)
  }

  // Direction 2: a mapped fact that no longer exists.
  for (const [node, mapping] of rows) {
    if (isIllustrative(mapping)) continue
    for (const claimed of mapping.facts) {
      if (facts.sourceErrors.has(claimed.file)) {
        report.source(claimed.file, facts)
        continue
      }
      const key = factKey(claimed)
      if (!index.has(key)) {
        report.add(
          'missing-fact',
          node,
          `node \`${node}\` maps to ${describeFact(claimed)}, which no longer exists.`,
          claimed,
        )
        continue
      }
      const reason = facts.unmappable.get(key)
      if (reason !== undefined) {
        report.add(
          'unmappable-fact',
          node,
          `node \`${node}\` maps to ${describeFact(claimed)}, which cannot be mapped: ${reason}.`,
          claimed,
        )
      }
    }
  }

  // Direction 1: a fact in scope that is neither mapped nor listed as not drawn. Egress hosts never get the second
  // way out, whatever the table says.
  for (const candidate of facts.facts) {
    if (!inScope(candidate, entry.covers)) continue
    const key = factKey(candidate)
    if (claims.has(key)) continue
    if (candidate.kind !== 'egress-host' && notDrawnKeys.has(key)) continue
    const text =
      candidate.kind === 'egress-host'
        ? `${describeFact(candidate)} is not drawn (egress hosts cannot be listed as not drawn).`
        : candidate.file === GATEWAY_OVERRIDE_SOURCE
          ? `${describeFact(candidate)} is neither drawn nor listed as not drawn (no table row claims it as an override fact).`
          : `${describeFact(candidate)} is neither drawn nor listed as not drawn.`
    report.add('undrawn-fact', candidate.id, text, candidate)
  }

  // A not-drawn entry for a fact that is gone is table rot; make it visible instead of letting it pile up.
  for (const {fact: omitted} of notDrawn) {
    if (facts.sourceErrors.has(omitted.file) || index.has(factKey(omitted))) continue
    report.add(
      'stale-not-drawn',
      omitted.id,
      `not-drawn ${describeFact(omitted)} no longer exists; remove the entry.`,
      omitted,
    )
  }

  return report.findings
}

/** Compares every rendered spec against the table and the facts. Returns no findings only when all agree. */
export function check({specs, table, facts}: CheckInput): Finding[] {
  const findings: Finding[] = []
  const index = new Map(facts.facts.map(item => [factKey(item), item]))
  const specNames = new Set(specs.map(spec => spec.name))

  for (const spec of specs) {
    const report = new Reporter(spec.name)
    if (!hasKey(table, spec.name)) {
      report.add(
        'unlisted-spec',
        spec.name,
        'diagram spec has no table entry (add one, or list it as out of scope with a reason).',
      )
      findings.push(...report.findings)
      continue
    }
    const entry = table[spec.name]
    if (entry === undefined) continue
    if (isOutOfScope(entry)) {
      if (entry.outOfScope.trim() === '') report.add('table', spec.name, 'out-of-scope entry gives no reason.')
      findings.push(...report.findings)
      continue
    }
    if ('error' in spec) {
      report.add('spec', spec.name, `spec could not be read: ${spec.error}.`)
      findings.push(...report.findings)
      continue
    }
    findings.push(...checkDiagram(spec.name, spec.nodeIds, entry, facts, index))
  }

  for (const name of Object.keys(table)) {
    if (specNames.has(name)) continue
    const report = new Reporter(name)
    report.add('orphan-entry', name, 'table entry has no diagram spec.')
    findings.push(...report.findings)
  }
  return findings
}

// ─── Compose ─────────────────────────────────────────────────────────────────

function namesOf(value: unknown, what: string, file: string): string[] {
  if (value === undefined || value === null) return []
  if (!isRecord(value)) throw new SourceError(`${file}: \`${what}\` is not a mapping`)
  return Object.keys(value)
}

/**
 * Services and named volumes of one compose document. Names come from `Object.keys` because a volume with no body
 * (`caddy_data:`) parses to null. Bind mounts are not volumes. Empty, null and `include:` documents fail closed.
 */
export function parseComposeFacts(text: string, file: string): Fact[] {
  let document: unknown
  try {
    document = Bun.YAML.parse(text)
  } catch (error) {
    throw new SourceError(`${file}: not valid YAML (${errorText(error)})`)
  }
  if (!isRecord(document)) throw new SourceError(`${file}: compose file is empty or not a mapping`)
  if ('include' in document) {
    throw new SourceError(
      `${file}: a top-level \`include:\` is not supported; the drift check would miss the included services`,
    )
  }
  const services = namesOf(document.services, 'services', file)
  if (services.length === 0) throw new SourceError(`${file}: compose file declares no services`)
  return [
    ...services.map(id => fact.service(file, id)),
    ...namesOf(document.volumes, 'volumes', file).map(id => fact.volume(file, id)),
  ]
}

function readText(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new SourceError(`${label}: cannot read (${errorText(error)})`)
  }
}

export function readComposeFacts(repoRoot: string, app: string): Fact[] {
  const file = composePath(app)
  return parseComposeFacts(readText(join(repoRoot, file), file), file)
}

// ─── Gateway: upstream compose and override ──────────────────────────────────

export const UPSTREAM_PIN_PATH = 'apps/gateway/upstream.json'
export const UPSTREAM_CACHE_DIR = '.cache/upstream-compose'
export const UPSTREAM_REF_PATTERN = /^v\d+\.\d+\.\d+$/

export function upstreamComposeUrl(ref: string): string {
  return `https://raw.githubusercontent.com/fro-bot/agent/${ref}/deploy/compose.yaml`
}

/**
 * Downloads the upstream compose for the pinned ref into the ref-keyed cache path, from the repo root. The CI step
 * has the same shape. It reads the ref from `upstream.json` and refuses anything that is not a release tag.
 */
export const UPSTREAM_FETCH_SCRIPT = 'bun run fetch:upstream-compose'

export const UPSTREAM_DOWNLOAD_COMMAND =
  `ref="$(jq -r .ref ${UPSTREAM_PIN_PATH})" && ${String.raw`echo "$ref" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' && `}mkdir -p "${UPSTREAM_CACHE_DIR}/$ref" && ` +
  `curl -fsSL "${upstreamComposeUrl('$ref')}" -o "${UPSTREAM_CACHE_DIR}/$ref/compose.yaml"`

export function readUpstreamRef(repoRoot: string): string {
  let pin: unknown
  try {
    pin = JSON.parse(readText(join(repoRoot, UPSTREAM_PIN_PATH), UPSTREAM_PIN_PATH))
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError(`${UPSTREAM_PIN_PATH}: not valid JSON (${errorText(error)})`)
  }
  const ref = isRecord(pin) ? pin.ref : undefined
  if (typeof ref !== 'string' || !UPSTREAM_REF_PATTERN.test(ref)) {
    throw new SourceError(
      `${UPSTREAM_PIN_PATH}: \`ref\` must be a release tag like v1.2.3 (found ${JSON.stringify(ref)})`,
    )
  }
  return ref
}

export function upstreamComposeCachePath(ref: string): string {
  return `${UPSTREAM_CACHE_DIR}/${ref}/compose.yaml`
}

/** Reads the upstream compose downloaded for the current pin. A file downloaded for an older pin is never read. */
export function readUpstreamComposeFacts(repoRoot: string): Fact[] {
  const ref = readUpstreamRef(repoRoot)
  const relPath = upstreamComposeCachePath(ref)
  const path = join(repoRoot, relPath)
  if (!existsSync(path)) {
    throw new SourceError(
      `the upstream gateway compose for ${ref} is missing at ${relPath}. Download it from the repo root: ${UPSTREAM_FETCH_SCRIPT}`,
    )
  }
  return parseComposeFacts(readText(path, relPath), GATEWAY_UPSTREAM_SOURCE)
}

/** Production runs with announce, the operator listener and operator auth all enabled. Digests are placeholders. */
export const PRODUCTION_OVERRIDE_SNAPSHOT: ComposeOverrideOpts = {
  gatewayDigest: `sha256:${'a'.repeat(64)}`,
  workspaceDigest: `sha256:${'b'.repeat(64)}`,
  announceEnabled: true,
  operatorEnabled: true,
  operatorTrustedProxies: '10.0.0.5',
  operatorBindHost: '172.21.0.2',
  operatorBindPort: '9300',
  operatorPublicOrigin: 'https://operator.example.test',
  operatorVpcIp: '10.0.0.3',
  operatorAuthEnabled: true,
  operatorGithubClientIdFile: 'client-id',
  operatorGithubClientSecretFile: 'client-secret',
  operatorCsrfSecretFile: 'csrf-secret',
  operatorAllowlistFile: 'allowlist',
  operatorPushEnabled: true,
}

export function readOverrideFacts(): Fact[] {
  return parseComposeFacts(buildComposeOverride(PRODUCTION_OVERRIDE_SNAPSHOT), GATEWAY_OVERRIDE_SOURCE)
}

/**
 * Gateway facts: everything upstream defines, plus what only the override declares. An override service or volume that
 * merges into an upstream one is not a new fact, so an upstream rename leaves the override's old name unclaimed.
 */
export function mergeGatewayFacts(upstream: readonly Fact[], override: readonly Fact[]): Fact[] {
  const upstreamNames = new Set(upstream.map(item => `${item.kind}|${item.id}`))
  return [...upstream, ...override.filter(item => !upstreamNames.has(`${item.kind}|${item.id}`))]
}

// ─── Egress hosts ────────────────────────────────────────────────────────────

export function readEgressFacts(hosts: readonly string[] = [CLIPROXY_EGRESS_HOST, ...OPENCODE_CATALOG_HOSTS]): Fact[] {
  const unique = [...new Set(hosts)]
  if (unique.length === 0) throw new SourceError(`${EGRESS_SOURCE}: the egress allowlist is empty`)
  return unique.map(host => fact.egressHost(host))
}

// ─── Apps ────────────────────────────────────────────────────────────────────

/** `apps/*` directories that are not deployed, and why. A new directory fails until it is drawn or added here. */
export const NON_DEPLOYABLE_APPS: Readonly<Record<string, string>> = {
  docs: 'the public docs site; it publishes to GitHub Pages and has no deploy workflow',
  agent: 'an operator-run AWS provisioner; nothing is deployed from it',
}

function appDirectories(repoRoot: string): string[] {
  return readdirSync(join(repoRoot, 'apps'), {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .toSorted((a, b) => a.localeCompare(b))
}

export function readAppFacts(repoRoot: string): Fact[] {
  let directories: string[]
  try {
    directories = appDirectories(repoRoot)
  } catch (error) {
    throw new SourceError(`${APPS_SOURCE}: cannot list the apps directory (${errorText(error)})`)
  }
  const apps = directories.filter(name => !hasKey(NON_DEPLOYABLE_APPS, name))
  if (apps.length === 0) throw new SourceError(`${APPS_SOURCE}: found no deployable apps/* directory`)
  return apps.map(name => fact.app(name))
}

// ─── Workflows ───────────────────────────────────────────────────────────────

const LOCAL_WORKFLOW_PREFIX = './.github/workflows/'

export interface WorkflowRead {
  readonly facts: Fact[]
  /** File names (under `.github/workflows`) of the local reusable workflows the document calls. */
  readonly callees: string[]
}

function environmentName(environment: unknown, file: string, job: string): string | undefined {
  if (environment === undefined) return undefined
  if (typeof environment === 'string' && environment !== '') return environment
  if (isRecord(environment) && typeof environment.name === 'string' && environment.name !== '') return environment.name
  throw new SourceError(`${file}: job \`${job}\` has an environment this check does not recognise`)
}

/**
 * Job ids, environments and local reusable-workflow callees of one workflow. A callee must declare `workflow_call`,
 * and a callee that itself calls a reusable workflow, or a router job that calls anything but a local workflow, is
 * not recognised and fails closed.
 */
export function parseWorkflowFacts(text: string, file: string): WorkflowRead {
  let document: unknown
  try {
    document = Bun.YAML.parse(text)
  } catch (error) {
    throw new SourceError(`${file}: not valid YAML (${errorText(error)})`)
  }
  if (!isRecord(document)) throw new SourceError(`${file}: workflow is empty or not a mapping`)
  if (!isRecord(document.jobs) || Object.keys(document.jobs).length === 0) {
    throw new SourceError(`${file}: workflow declares no jobs`)
  }
  if (!isRecord(document.on)) throw new SourceError(`${file}: \`on\` is not a mapping of triggers`)
  const callable = 'workflow_call' in document.on
  const facts: Fact[] = []
  const callees: string[] = []
  for (const [id, job] of Object.entries(document.jobs)) {
    if (!isRecord(job)) throw new SourceError(`${file}: job \`${id}\` is not a mapping`)
    facts.push(fact.job(file, id))
    const environment = environmentName(job.environment, file, id)
    if (environment !== undefined) facts.push(fact.environment(file, environment))
    if (job.uses === undefined) continue
    if (typeof job.uses !== 'string' || !job.uses.startsWith(LOCAL_WORKFLOW_PREFIX)) {
      throw new SourceError(
        `${file}: job \`${id}\` calls ${JSON.stringify(job.uses)}, which is not a local reusable workflow`,
      )
    }
    if (callable)
      throw new SourceError(
        `${file}: job \`${id}\` calls a reusable workflow from a reusable workflow, which this check does not follow`,
      )
    callees.push(job.uses.slice(LOCAL_WORKFLOW_PREFIX.length))
  }
  if (!callable && callees.length === 0) {
    // Neither a callee nor a router that calls other workflows: not part of the pipeline this check understands.
    throw new SourceError(`${file}: workflow does not declare \`workflow_call\` and calls no local workflow`)
  }
  return {facts, callees}
}

// ─── Runbook anchors ─────────────────────────────────────────────────────────

const FENCE_RE = /^\s*(`{3,}|~{3,})/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(\S.*)?)?$/

/** The heading text as the site renders it: code, emphasis and link syntax stripped. */
function renderedHeading(raw: string): {text: string; hasAngle: boolean} {
  const codes: string[] = []
  let text = raw.replace(/[ \t]+#+[ \t]*$/, '').trim()
  text = text.replaceAll(/(`+)([^`]+)\1/g, (_match, _ticks: string, inner: string) => {
    codes.push(inner.trim())
    return `\0${codes.length - 1}\0`
  })
  const hasAngle = text.includes('<')
  text = text
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replaceAll(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replaceAll(/(^|\W)_{1,3}([^_]+)_{1,3}(?=\W|$)/g, '$1$2')
  text = text.replaceAll(/\0(\d+)\0/g, (_match, position: string) => codes[Number(position)] ?? '')
  return {text, hasAngle}
}

/**
 * Heading anchors of one runbook, slugged by `github-slugger` with one slugger per document so duplicates get the
 * same `-1` suffix as the site. Fenced code (``` and ~~~) and frontmatter are skipped, and the first H1 is never an
 * anchor because the site moves it to the page title. A heading with a `<` outside code is rewritten by the content
 * generator, so its anchor is reported as unmappable.
 */
export function parseRunbookAnchors(markdown: string, file: string): {facts: Fact[]; unmappable: Map<string, string>} {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  const slugger = new GithubSlugger()
  const facts: Fact[] = []
  const unmappable = new Map<string, string>()
  let index = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, position) => position > 0 && line.trim() === '---')
    if (close !== -1) index = close + 1
  }
  let fence: {char: string; length: number} | undefined
  let seenTitle = false
  for (; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const opening = FENCE_RE.exec(line)
    if (fence !== undefined) {
      const marker = opening?.[1]
      if (
        marker !== undefined &&
        marker.startsWith(fence.char) &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = undefined
      }
      continue
    }
    const marker = opening?.[1]
    if (marker !== undefined) {
      fence = {char: marker.charAt(0), length: marker.length}
      continue
    }
    const heading = HEADING_RE.exec(line)
    const level = heading?.[1]?.length
    const raw = heading?.[2]
    if (level === undefined || raw === undefined || raw.trim() === '') continue
    if (level === 1 && !seenTitle) {
      seenTitle = true
      continue
    }
    const {text, hasAngle} = renderedHeading(raw)
    const anchor = fact.anchor(file, slugger.slug(text))
    facts.push(anchor)
    if (hasAngle) {
      unmappable.set(
        factKey(anchor),
        'the heading contains `<`, which the content generator rewrites, so the anchor would not match the site',
      )
    }
  }
  return {facts, unmappable}
}

// ─── Specs ───────────────────────────────────────────────────────────────────

/** Node ids of a spec: `components` for architecture specs, `nodes` for workflow specs. Anything else fails. */
export function extractNodeIds(diagramType: string, document: unknown): string[] {
  const key = diagramType === 'architecture' ? 'components' : diagramType === 'workflow' ? 'nodes' : undefined
  if (key === undefined) throw new SourceError(`diagram type \`${diagramType}\` is not supported`)
  const list = isRecord(document) ? document[key] : undefined
  if (!Array.isArray(list)) throw new SourceError(`\`${key}\` is missing`)
  return list.map((node: unknown) => {
    const id = isRecord(node) ? node.id : undefined
    if (typeof id !== 'string' || id === '') throw new SourceError(`a node in \`${key}\` has no string id`)
    return id
  })
}

/** Reads every rendered spec's node ids. A spec that cannot be read becomes an `error` entry, not a throw. */
export function readSpecs(repoRoot: string): SpecInput[] {
  return discoverSpecs(repoRoot).map((spec): SpecInput => {
    try {
      return {
        name: spec.name,
        nodeIds: extractNodeIds(spec.type, JSON.parse(readFileSync(join(repoRoot, spec.path), 'utf8'))),
      }
    } catch (error) {
      return {name: spec.name, error: errorText(error)}
    }
  })
}

// ─── Reading the whole repository ────────────────────────────────────────────

interface Collector {
  readonly facts: Fact[]
  readonly sources: Set<string>
  readonly sourceErrors: Map<string, string>
  readonly unmappable: Map<string, string>
}

function collect(collector: Collector, label: string, read: () => Fact[]): Fact[] {
  try {
    const facts = read()
    collector.facts.push(...facts)
    collector.sources.add(label)
    return facts
  } catch (error) {
    collector.sourceErrors.set(label, errorText(error))
    return []
  }
}

function readWorkflows(repoRoot: string, collector: Collector): void {
  const router = workflowPath('deploy.yaml')
  let callees: string[] = []
  collect(collector, router, () => {
    const read = parseWorkflowFacts(readText(join(repoRoot, router), router), router)
    callees = read.callees
    return read.facts
  })
  for (const callee of callees) {
    const file = workflowPath(callee)
    collect(collector, file, () => {
      const read = parseWorkflowFacts(readText(join(repoRoot, file), file), file)
      return read.facts
    })
  }
}

function readRunbooks(repoRoot: string, collector: Collector): void {
  const dir = join(repoRoot, 'docs/runbooks')
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .toSorted((a, b) => a.localeCompare(b))
  } catch (error) {
    collector.sourceErrors.set('docs/runbooks', `cannot list the runbooks directory (${errorText(error)})`)
    return
  }
  for (const name of names) {
    const file = runbookPath(name)
    collect(collector, file, () => {
      const {facts, unmappable} = parseRunbookAnchors(readText(join(repoRoot, file), file), file)
      for (const [key, reason] of unmappable) collector.unmappable.set(key, reason)
      return facts
    })
  }
}

/** Reads every source. A source that fails is recorded in `sourceErrors`; the others are still read. */
export function readRepoFacts(repoRoot: string = resolve(import.meta.dir, '../../..')): RepoFacts {
  const collector: Collector = {facts: [], sources: new Set(), sourceErrors: new Map(), unmappable: new Map()}

  collect(collector, APPS_SOURCE, () => readAppFacts(repoRoot))
  collect(collector, EGRESS_SOURCE, () => readEgressFacts())

  let directories: string[] = []
  try {
    directories = appDirectories(repoRoot)
  } catch {
    // readAppFacts already recorded the unreadable apps directory.
  }
  for (const app of directories) {
    if (existsSync(join(repoRoot, composePath(app))))
      collect(collector, composePath(app), () => readComposeFacts(repoRoot, app))
  }

  // Both gateway sources are read independently so a missing download does not hide an override problem.
  const upstream: Fact[] = []
  const override: Fact[] = []
  collect(collector, GATEWAY_UPSTREAM_SOURCE, () => {
    upstream.push(...readUpstreamComposeFacts(repoRoot))
    return []
  })
  collect(collector, GATEWAY_OVERRIDE_SOURCE, () => {
    override.push(...readOverrideFacts())
    return []
  })
  collector.facts.push(...mergeGatewayFacts(upstream, override))

  readWorkflows(repoRoot, collector)
  readRunbooks(repoRoot, collector)

  return {
    facts: collector.facts,
    sources: collector.sources,
    sourceErrors: collector.sourceErrors,
    unmappable: collector.unmappable,
  }
}
