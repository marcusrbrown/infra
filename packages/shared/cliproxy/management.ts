import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'

import {isMap, isNode, isScalar, isSeq, parseDocument, parse as parseYaml, type Document, type Node} from 'yaml'

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single model alias entry mapping a client-facing name to an upstream model. */
export interface OAuthModelAliasEntry {
  name: string
  alias: string
  fork: boolean
}

/**
 * The `oauth-model-alias` configuration object.
 * Keyed by provider; only `claude` is supported today.
 */
export interface OAuthModelAlias {
  claude: OAuthModelAliasEntry[]
}

/** A single model condition in a CLIProxyAPI payload override rule. */
export interface PayloadOverrideModel {
  name: string
  protocol: string
}

/** The infra-owned payload override fragment. */
export interface PayloadOverrideRule {
  models: PayloadOverrideModel[]
  params: {
    context_management: {
      edits: unknown[]
    }
  }
}

export const CLEAR_THINKING_RULE_MARKER = 'managed-by: infra/cliproxy-clear-thinking'

const CLEAR_THINKING_TARGET_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6'] as const

function isExactClearThinkingRule(rule: PayloadOverrideRule): boolean {
  if (rule.models.length !== CLEAR_THINKING_TARGET_MODELS.length) return false
  const names = new Set(rule.models.map(model => model.name))
  return (
    CLEAR_THINKING_TARGET_MODELS.every(name => names.has(name)) &&
    rule.models.every(model => model.protocol.toLowerCase() === 'claude')
  )
}

function assertExactClearThinkingRule(rule: PayloadOverrideRule): void {
  if (!isExactClearThinkingRule(rule)) {
    throw new Error('Tracked payload.override must target the exact affected models; refusing to broaden the rule')
  }
}

/** Hash the exact UTF-8 bytes of a raw management response/body. */
export function hashRawConfig(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

function matchesModelPattern(pattern: string, model: string): boolean {
  const parts = pattern.split('*')
  if (parts.length === 1) return pattern === model

  let offset = 0
  for (const [index, part] of parts.entries()) {
    if (part.length === 0) continue
    const position = model.indexOf(part, offset)
    if (position === -1 || (index === 0 && position !== 0)) return false
    if (index === parts.length - 1 && position + part.length !== model.length) return false
    offset = position + part.length
  }
  return true
}

/** Apply CLIProxyAPI's model/protocol condition semantics to a payload rule. */
export function payloadOverrideMatchesModel(rule: PayloadOverrideRule, model: string, protocol: string): boolean {
  return rule.models.some(
    condition =>
      matchesModelPattern(condition.name, model) && condition.protocol.toLowerCase() === protocol.toLowerCase(),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPayloadOverrideRule(value: unknown): value is PayloadOverrideRule {
  if (!isRecord(value) || !Array.isArray(value.models) || !isRecord(value.params)) {
    return false
  }

  const models = value.models.every(model => {
    if (!isRecord(model)) return false
    return typeof model.name === 'string' && typeof model.protocol === 'string'
  })

  const contextManagement = value.params.context_management
  return (
    models &&
    isRecord(contextManagement) &&
    Array.isArray(contextManagement.edits) &&
    contextManagement.edits.length === 0 &&
    Object.keys(contextManagement).length === 1
  )
}

function parseFidelityDocument(source: string): Document<Node, true> {
  const document = parseDocument(source, {keepSourceTokens: true, uniqueKeys: true})
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error('CLIProxy config YAML is malformed or ambiguous; refusing to mutate')
  }
  return document
}

function nodeToUnknown(node: unknown): unknown {
  return isNode(node) ? ((node as Node).toJSON() as unknown) : undefined
}

function payloadOverrideNodeToRule(node: unknown): PayloadOverrideRule | null {
  if (!isMap(node)) return null
  const value = nodeToUnknown(node)
  return isPayloadOverrideRule(value) ? value : null
}

function hasExactMarkerComment(comment: string | null | undefined): boolean {
  return (comment ?? '').split(/\r?\n/).some(line => line.trim() === CLEAR_THINKING_RULE_MARKER)
}

function hasManagedMarker(node: unknown): boolean {
  if (!isNode(node)) return false
  return hasExactMarkerComment(node.commentBefore) || hasExactMarkerComment(node.comment)
}

/**
 * Read only the infra-owned payload override fragment from a tracked config.
 * Runtime fields in the tracked template are deliberately ignored.
 */
export function readPayloadOverrideFromConfig(configPath: string): PayloadOverrideRule | null {
  const document = parseFidelityDocument(readFileSync(configPath, 'utf8'))
  const override = document.getIn(['payload', 'override'], true)
  if (!isSeq(override) || override.items.length === 0) return null

  const marked = override.items.filter(item => {
    return hasManagedMarker(item)
  })

  if (marked.length !== 1) {
    throw new Error('Tracked payload.override must contain exactly one managed clear-thinking rule')
  }

  const rule = payloadOverrideNodeToRule(marked[0])
  if (!rule) {
    throw new Error('Tracked managed payload.override rule has an unsupported shape')
  }
  assertExactClearThinkingRule(rule)

  return rule
}

export interface RawConfigMergeResult {
  body: string
  changed: boolean
}

export interface RawConfigSummary {
  apiKeyCount: number
  oauthModelAliasEntryCount: number
  payloadOverrideCount: number
}

function hasMaskedValue(value: string): boolean {
  return /^(?:\*+|x+|<[^>]+>|\[redacted\]|\[masked\]|redacted|masked)$/i.test(value.trim())
}

function validateRuntimeConfig(document: Document<Node, true>): void {
  const root = document.contents
  if (!isMap(root)) {
    throw new Error('CLIProxy config root must be a mapping; refusing to mutate')
  }

  const apiKeys = root.get('api-keys', true)
  if (!isSeq(apiKeys) || apiKeys.items.length === 0) {
    throw new Error('CLIProxy config api-keys must be a non-empty sequence; refusing to mutate')
  }
  for (const apiKey of apiKeys.items) {
    if (
      !isScalar(apiKey) ||
      typeof apiKey.value !== 'string' ||
      apiKey.value.trim().length === 0 ||
      hasMaskedValue(apiKey.value)
    ) {
      throw new Error('CLIProxy config api-keys contains an invalid or masked entry; refusing to mutate')
    }
  }

  const authDir = root.get('auth-dir', true)
  if (!isScalar(authDir) || authDir.value !== '/root/.cli-proxy-api') {
    throw new Error('CLIProxy config auth-dir is missing or unexpected; refusing to mutate')
  }

  const aliases = root.get('oauth-model-alias', true)
  if (aliases !== undefined && !isMap(aliases)) {
    throw new Error('CLIProxy config oauth-model-alias has an unsupported shape; refusing to mutate')
  }
  if (isMap(aliases)) {
    const claudeAliases = aliases.get('claude', true)
    if (claudeAliases !== undefined && !isSeq(claudeAliases)) {
      throw new Error('CLIProxy config oauth-model-alias.claude has an unsupported shape; refusing to mutate')
    }
  }

  const payload = root.get('payload', true)
  if (payload !== undefined && !isMap(payload)) {
    throw new Error('CLIProxy config payload has an unsupported shape; refusing to mutate')
  }

  const override = isMap(payload) ? payload.get('override', true) : undefined
  if (override !== undefined && !isSeq(override)) {
    throw new Error('CLIProxy config payload.override has an unsupported shape; refusing to mutate')
  }
}

/** Return bounded, secret-free runtime invariants for a raw config document. */
export function summarizeRawConfig(rawYaml: string): RawConfigSummary {
  const document = parseFidelityDocument(rawYaml)
  validateRuntimeConfig(document)
  const root = document.contents
  if (!isMap(root)) {
    throw new Error('CLIProxy config root must be a mapping; refusing to inspect')
  }

  const apiKeys = root.get('api-keys', true)
  const aliases = root.get('oauth-model-alias', true)
  const claudeAliases = isMap(aliases) ? aliases.get('claude', true) : undefined
  const payload = root.get('payload', true)
  const override = isMap(payload) ? payload.get('override', true) : undefined

  return {
    apiKeyCount: isSeq(apiKeys) ? apiKeys.items.length : 0,
    oauthModelAliasEntryCount: isSeq(claudeAliases) ? claudeAliases.items.length : 0,
    payloadOverrideCount: isSeq(override) ? override.items.length : 0,
  }
}

function invariantFingerprint(summary: RawConfigSummary): string {
  return JSON.stringify({
    apiKeyCount: summary.apiKeyCount,
    oauthModelAliasEntryCount: summary.oauthModelAliasEntryCount,
  })
}

function opaqueFingerprint(rawYaml: string): string {
  const document = parseFidelityDocument(rawYaml)
  const override = document.getIn(['payload', 'override'], true)
  if (isSeq(override)) {
    override.items = override.items.filter(item => !hasManagedMarker(item))
  }
  const root = document.contents
  if (isMap(root)) {
    const payload = root.get('payload', true)
    if (isMap(payload)) {
      const remainingOverride = payload.get('override', true)
      if (isSeq(remainingOverride) && remainingOverride.items.length === 0) {
        payload.delete('override')
      }
      if (payload.items.length === 0) {
        root.delete('payload')
      }
    }
  }
  const comparable: unknown = document.toJSON() as unknown
  return JSON.stringify(comparable)
}

function pathTouchesContextManagement(path: string): boolean {
  const normalized = path.trim().replace(/^\.+/, '')
  return normalized === 'context_management' || normalized.startsWith('context_management.')
}

function objectContainsContextManagementPath(value: unknown, prefix = ''): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return pathTouchesContextManagement(path) || objectContainsContextManagementPath(child, path)
  })
}

function nodeMatchesClearThinkingTarget(node: unknown): boolean {
  const value = nodeToUnknown(node)
  if (!isRecord(value) || !Array.isArray(value.models)) return false
  return value.models.some(model => {
    if (!isRecord(model)) return false
    const name = model.name
    const protocol = typeof model.protocol === 'string' ? model.protocol : ''
    if (typeof name !== 'string') return false
    return CLEAR_THINKING_TARGET_MODELS.some(
      target => matchesModelPattern(name, target) && (protocol.trim() === '' || protocol.toLowerCase() === 'claude'),
    )
  })
}

function nodeWritesContextManagement(node: unknown): boolean {
  const value = nodeToUnknown(node)
  return isRecord(value) && objectContainsContextManagementPath(value.params)
}

function nodeFiltersContextManagement(node: unknown): boolean {
  const value = nodeToUnknown(node)
  if (!isRecord(value) || !Array.isArray(value.params)) return false
  return value.params.some(path => typeof path === 'string' && pathTouchesContextManagement(path))
}

function assertPayloadOrderingDominance(document: Document<Node, true>, markerIndex: number | undefined): void {
  const payload = document.getIn(['payload'], true)
  if (!isMap(payload)) return

  const override = payload.get('override', true)
  if (markerIndex !== undefined && isSeq(override)) {
    const laterConflict = override.items
      .slice(markerIndex + 1)
      .some(item => nodeMatchesClearThinkingTarget(item) && nodeWritesContextManagement(item))
    if (laterConflict) {
      throw new Error(
        'CLIProxy config has a later unowned payload.override rule that can overwrite context_management; refusing to mutate',
      )
    }
  }

  const overrideRaw = payload.get('override-raw', true)
  if (isSeq(overrideRaw)) {
    const conflict = overrideRaw.items.some(
      item => nodeMatchesClearThinkingTarget(item) && nodeWritesContextManagement(item),
    )
    if (conflict) {
      throw new Error(
        'CLIProxy config has a matching payload.override-raw rule that can overwrite context_management; refusing to mutate',
      )
    }
  }

  const filter = payload.get('filter', true)
  if (isSeq(filter)) {
    const conflict = filter.items.some(
      item => nodeMatchesClearThinkingTarget(item) && nodeFiltersContextManagement(item),
    )
    if (conflict) {
      throw new Error(
        'CLIProxy config has a matching payload.filter rule that can remove context_management; refusing to mutate',
      )
    }
  }
}

function markedPayloadOverride(document: Document<Node, true>): {count: number; rule: PayloadOverrideRule | null} {
  const override = document.getIn(['payload', 'override'], true)
  if (!isSeq(override)) return {count: 0, rule: null}

  const marked = override.items.filter(item => {
    return hasManagedMarker(item)
  })
  return {count: marked.length, rule: marked.length === 1 ? ruleFromNode(marked[0]) : null}
}

export interface ApplyPayloadOverrideResult {
  changed: boolean
  beforeHash: string
  afterHash: string
  summary: RawConfigSummary
}

/**
 * Read, merge, optimistic-concurrency-check, write, and read back the raw config.
 * All raw YAML stays in memory and is intentionally absent from errors/results.
 */
export async function applyPayloadOverride({
  baseUrl,
  key,
  desired,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  desired: PayloadOverrideRule
  fetch?: typeof globalThis.fetch
}): Promise<ApplyPayloadOverrideResult> {
  assertExactClearThinkingRule(desired)
  const before = await readRawConfig({baseUrl, key, fetch: fetchFn})
  const beforeHash = hashRawConfig(before)
  const beforeSummary = summarizeRawConfig(before)
  const beforeOpaque = opaqueFingerprint(before)
  const merged = mergePayloadOverride(before, desired)

  if (!merged.changed) {
    return {
      changed: false,
      beforeHash,
      afterHash: beforeHash,
      summary: beforeSummary,
    }
  }

  const candidateSummary = summarizeRawConfig(merged.body)
  if (invariantFingerprint(candidateSummary) !== invariantFingerprint(beforeSummary)) {
    throw new Error('CLIProxy config runtime invariants changed during merge; refusing to mutate')
  }
  if (opaqueFingerprint(merged.body) !== beforeOpaque) {
    throw new Error('CLIProxy config opaque state changed during merge; refusing to mutate')
  }

  const candidateDocument = parseFidelityDocument(merged.body)
  const candidateOwned = markedPayloadOverride(candidateDocument)
  if (
    candidateOwned.count !== 1 ||
    !candidateOwned.rule ||
    canonicalRule(candidateOwned.rule) !== canonicalRule(desired)
  ) {
    throw new Error('CLIProxy config managed clear-thinking rule did not converge in memory; refusing to mutate')
  }

  const concurrent = await readRawConfig({baseUrl, key, fetch: fetchFn})
  if (hashRawConfig(concurrent) !== beforeHash) {
    throw new Error('CLIProxy config changed concurrently before PUT; refusing to overwrite')
  }

  await putRawConfig({baseUrl, key, body: merged.body, fetch: fetchFn})

  const readback = await readRawConfig({baseUrl, key, fetch: fetchFn})
  const readbackSummary = summarizeRawConfig(readback)
  if (invariantFingerprint(readbackSummary) !== invariantFingerprint(beforeSummary)) {
    throw new Error('CLIProxy config readback changed runtime invariants; refusing to report success')
  }
  if (opaqueFingerprint(readback) !== beforeOpaque) {
    throw new Error('CLIProxy config readback changed opaque state; refusing to report success')
  }
  const readbackDocument = parseFidelityDocument(readback)
  const readbackOwned = markedPayloadOverride(readbackDocument)
  if (
    readbackOwned.count !== 1 ||
    !readbackOwned.rule ||
    canonicalRule(readbackOwned.rule) !== canonicalRule(desired)
  ) {
    throw new Error('CLIProxy config readback did not contain the managed clear-thinking rule')
  }

  return {
    changed: true,
    beforeHash,
    afterHash: hashRawConfig(readback),
    summary: readbackSummary,
  }
}

export type RawConfigRestoreState = {state: 'noop'} | {state: 'restored'}

/** Restore an exact snapshot only when the live document is in a known state. */
export async function restoreRawConfig({
  baseUrl,
  key,
  snapshot,
  intendedHash,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  snapshot: string
  intendedHash: string
  fetch?: typeof globalThis.fetch
}): Promise<RawConfigRestoreState> {
  const current = await readRawConfig({baseUrl, key, fetch: fetchFn})
  const currentHash = hashRawConfig(current)
  const snapshotHash = hashRawConfig(snapshot)

  if (currentHash === snapshotHash) {
    return {state: 'noop'}
  }

  if (currentHash !== intendedHash) {
    throw new Error('CLIProxy config restore halted: live document is in an unknown third state')
  }

  await putRawConfig({baseUrl, key, body: snapshot, fetch: fetchFn})
  const readback = await readRawConfig({baseUrl, key, fetch: fetchFn})
  if (hashRawConfig(readback) !== snapshotHash) {
    throw new Error('CLIProxy config restore readback did not match the exact snapshot')
  }

  return {state: 'restored'}
}

function ruleFromNode(node: unknown): PayloadOverrideRule | null {
  if (!isMap(node)) return null
  const value = nodeToUnknown(node)
  return isPayloadOverrideRule(value) ? value : null
}

function canonicalRule(rule: PayloadOverrideRule): string {
  const models = [...rule.models]
    .map(model => ({name: model.name, protocol: model.protocol.toLowerCase()}))
    .sort((left, right) => `${left.name}\u0000${left.protocol}`.localeCompare(`${right.name}\u0000${right.protocol}`))
  return JSON.stringify({models, params: rule.params})
}

function isEquivalentRule(candidate: unknown, desired: PayloadOverrideRule): boolean {
  const rule = ruleFromNode(candidate)
  return rule !== null && canonicalRule(rule) === canonicalRule(desired)
}

function createManagedRule(document: Document<Node, true>, desired: PayloadOverrideRule): Node {
  const node = document.createNode(desired)
  node.comment = CLEAR_THINKING_RULE_MARKER
  return node
}

/**
 * Merge the single infra-owned rule into a raw live config document.
 * Only the marked sequence item is replaced; all other document nodes remain opaque.
 */
export function mergePayloadOverride(liveYaml: string, desired: PayloadOverrideRule): RawConfigMergeResult {
  assertExactClearThinkingRule(desired)
  const document = parseFidelityDocument(liveYaml)
  validateRuntimeConfig(document)

  const root = document.contents
  if (!isMap(root)) {
    throw new Error('CLIProxy config root must be a mapping; refusing to mutate')
  }

  let payload = root.get('payload', true)
  if (payload === undefined) {
    root.set('payload', document.createNode({override: []}))
    payload = root.get('payload', true)
  }
  if (!isMap(payload)) {
    throw new Error('CLIProxy config payload has an unsupported shape; refusing to mutate')
  }

  let override = payload.get('override', true)
  if (override === undefined) {
    payload.set('override', document.createNode([]))
    override = payload.get('override', true)
  }
  if (!isSeq(override)) {
    throw new Error('CLIProxy config payload.override has an unsupported shape; refusing to mutate')
  }

  const markerIndexes = override.items.flatMap((item, index) => {
    return hasManagedMarker(item) ? [index] : []
  })

  const equivalentIndexes = override.items.flatMap((item, index) => (isEquivalentRule(item, desired) ? [index] : []))

  const markerIndex = markerIndexes[0]
  const unmarkedEquivalentIndexes = equivalentIndexes.filter(index => index !== markerIndex)
  if (markerIndexes.length > 1) {
    throw new Error('CLIProxy config contains duplicate managed clear-thinking markers; refusing to mutate')
  }
  if (unmarkedEquivalentIndexes.length > 0) {
    throw new Error('CLIProxy config contains an equivalent unmarked clear-thinking rule; refusing to mutate')
  }

  assertPayloadOrderingDominance(document, markerIndex)

  if (markerIndex !== undefined && equivalentIndexes.includes(markerIndex)) {
    return {body: liveYaml, changed: false}
  }

  if (markerIndex === undefined) {
    override.add(createManagedRule(document, desired))
  } else {
    const existing = override.items[markerIndex]
    if (isMap(existing)) {
      const replacement = createManagedRule(document, desired)
      replacement.commentBefore = existing.commentBefore ?? null
      replacement.comment = existing.comment ?? (existing.commentBefore ? null : CLEAR_THINKING_RULE_MARKER)
      replacement.spaceBefore = existing.spaceBefore
      override.items[markerIndex] = replacement
    } else {
      throw new Error('CLIProxy config managed clear-thinking rule has an unsupported shape; refusing to mutate')
    }
  }

  const body = document.toString()
  return {body, changed: body !== liveYaml}
}

// ─── HTTP primitives ──────────────────────────────────────────────────────────

/** Default HTTP timeout for management API requests (10 seconds). */
export const HTTP_TIMEOUT_MS = 10_000

/**
 * Permissive parser for /v0/management/api-keys list responses. Returns [] on every
 * unknown shape. Use ONLY for display paths (e.g. `cliproxy keys list`) where
 * empty-on-malformed is acceptable. Mutating callers (createManagementApiKey,
 * deleteManagementApiKey, `cliproxy keys add`) must use parseManagementKeyList
 * below — the permissive default would cause a destructive PUT to replace the
 * entire key list with just the new key.
 */
export function toStringArray(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is string => typeof item === 'string')
  }

  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    const value = obj['api-keys'] ?? obj.api_keys
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string')
    }
  }

  return []
}

/**
 * Strict parser for /v0/management/api-keys list responses used by mutating callers.
 * Falls back to throw on any unknown shape — never returns [] on malformed input.
 * Accepts string[], {api-keys: string[]}, or {api_keys: string[]}. Throws on every other shape.
 */
export function parseManagementKeyList(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    if (!payload.every((item): item is string => typeof item === 'string')) {
      throw new Error(
        `Unexpected management key-list shape: top-level array contains non-string entries (got ${JSON.stringify(payload).slice(0, 100)})`,
      )
    }
    return payload
  }

  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    const value = obj['api-keys'] ?? obj.api_keys
    if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
      return value
    }
  }

  throw new Error(
    `Unexpected management key-list shape: expected string[] or {api-keys: string[]} (got ${JSON.stringify(payload).slice(0, 100)})`,
  )
}

/** Build management API request headers with the management key and JSON content-type. */
export function managementHeaders(key: string): Headers {
  const headers = new Headers()
  headers.set('x-management-key', key)
  headers.set('content-type', 'application/json')
  return headers
}

/**
 * Fetch a JSON endpoint with a timeout. Throws on non-2xx or malformed JSON.
 * Returns null on 204 No Content.
 *
 * JSON parse failures must surface — permissive parsing here caused a data-loss
 * class bug (PR #312 Fro Bot review): bad management JSON would silently become
 * null, then toStringArray(null) → [], then a destructive PUT would replace the
 * entire key list with just the new key.
 */
export async function requestJson(endpoint: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(endpoint, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${init.method ?? 'GET'} ${endpoint} failed with HTTP ${response.status}: ${body}`)
  }

  // 204 No Content is a valid empty response for some mutations.
  if (response.status === 204) return null

  try {
    return await response.json()
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError)
    throw new Error(`${init.method ?? 'GET'} ${endpoint} returned malformed JSON: ${message}`)
  }
}

function rawManagementHeaders(key: string): Headers {
  const headers = new Headers()
  headers.set('x-management-key', key)
  headers.set('accept', 'application/yaml, text/yaml, text/plain')
  return headers
}

/** Read the complete raw config document without parsing or logging its contents. */
export async function readRawConfig({
  baseUrl,
  key,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  fetch?: typeof globalThis.fetch
}): Promise<string> {
  const response = await fetchFn(`${baseUrl}/v0/management/config.yaml`, {
    method: 'GET',
    headers: rawManagementHeaders(key),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    await response.text()
    throw new Error(`GET /v0/management/config.yaml failed with HTTP ${response.status}`)
  }

  return response.text()
}

/** Replace the complete raw config document without exposing its body or key. */
export async function putRawConfig({
  baseUrl,
  key,
  body,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  body: string
  fetch?: typeof globalThis.fetch
}): Promise<void> {
  const headers = rawManagementHeaders(key)
  headers.set('content-type', 'application/yaml')
  const response = await fetchFn(`${baseUrl}/v0/management/config.yaml`, {
    method: 'PUT',
    headers,
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    await response.text()
    throw new Error(`PUT /v0/management/config.yaml failed with HTTP ${response.status}`)
  }

  await response.text()
}

// ─── OAuth model alias helpers ────────────────────────────────────────────────

/** Empty alias object — used as the canonical "nothing configured" value. */
function emptyAlias(): OAuthModelAlias {
  return {claude: []}
}

/**
 * Coerce a raw `fork` field value to boolean.
 * Accepts: true, false, "true", "false".
 * Returns undefined for any other value (signals rejection).
 *
 * The server read-back may return fork as a JSON string "true"/"false" instead
 * of a boolean — this normalizes both representations.
 */
function coerceFork(value: unknown): boolean | undefined {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/**
 * Parse and validate an array of raw claude alias entries.
 *
 * - Accepts `fork` as boolean OR string "true"/"false" (server read-back may return strings).
 * - Rejects entries with missing/empty name or alias, or unrecognized fork values.
 * - Calls `onDrop(index)` for each rejected entry so callers can warn.
 */
export function parseClaudeEntries(raw: unknown, onDrop?: (index: number) => void): OAuthModelAliasEntry[] {
  if (!Array.isArray(raw)) return []

  const result: OAuthModelAliasEntry[] = []
  for (const [i, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object') {
      onDrop?.(i)
      continue
    }
    const e = entry as Record<string, unknown>
    const name = e.name
    const alias = e.alias
    const forkCoerced = coerceFork(e.fork)

    if (
      typeof name !== 'string' ||
      name === '' ||
      typeof alias !== 'string' ||
      alias === '' ||
      forkCoerced === undefined
    ) {
      onDrop?.(i)
      continue
    }

    result.push({name, alias, fork: forkCoerced})
  }
  return result
}

/**
 * Read the `oauth-model-alias` block from a CLIProxyAPI config YAML file.
 * Returns an empty alias object when the key is absent or the file has no alias block.
 * Warns via console.warn when entries are dropped due to malformed shape.
 */
export function readOAuthModelAliasFromConfig(configPath: string): OAuthModelAlias {
  const raw = readFileSync(configPath, 'utf8')
  const parsed = parseYaml(raw) as Record<string, unknown> | null

  if (!parsed || typeof parsed !== 'object') {
    return emptyAlias()
  }

  const aliasBlock = parsed['oauth-model-alias']
  if (!aliasBlock || typeof aliasBlock !== 'object') {
    return emptyAlias()
  }

  const block = aliasBlock as Record<string, unknown>
  const claudeEntries = block.claude

  if (!Array.isArray(claudeEntries)) {
    return emptyAlias()
  }

  const dropped: number[] = []
  const claude = parseClaudeEntries(claudeEntries, index => dropped.push(index))

  if (dropped.length > 0) {
    console.warn(
      `\u001B[1;33m⚠\u001B[0m  oauth-model-alias: dropped ${dropped.length} malformed entr${dropped.length === 1 ? 'y' : 'ies'} at index ${dropped.join(', ')} in ${configPath} (missing/invalid name, alias, or fork field)`,
    )
  }

  return {claude}
}

/**
 * Apply an `OAuthModelAlias` to the CLIProxyAPI management API via a bare-object PUT.
 *
 * The body IS the OAuthModelAlias object `{claude: [...]}` — NOT wrapped in
 * `{value: ...}` or `{oauth-model-alias: ...}`. Those wrappers return 200 but
 * store nothing (verified live).
 *
 * The management key is NEVER included in thrown error messages.
 */
export async function applyOAuthModelAlias({
  baseUrl,
  key,
  body,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  body: OAuthModelAlias
  fetch?: typeof globalThis.fetch
}): Promise<void> {
  const endpoint = `${baseUrl}/v0/management/oauth-model-alias`
  const response = await fetchFn(endpoint, {
    method: 'PUT',
    headers: managementHeaders(key),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(`PUT /v0/management/oauth-model-alias failed with HTTP ${response.status}: ${responseBody}`)
  }
}

/**
 * Read back the current `oauth-model-alias` from the CLIProxyAPI management API.
 * The GET response wraps the value as `{"oauth-model-alias": {...}}`.
 * Returns an empty alias when the field is null or absent.
 * Tolerates `fork` returned as string "true"/"false" (server shape variance).
 */
export async function readBackOAuthModelAlias({
  baseUrl,
  key,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  fetch?: typeof globalThis.fetch
}): Promise<OAuthModelAlias> {
  const endpoint = `${baseUrl}/v0/management/oauth-model-alias`
  const response = await fetchFn(endpoint, {
    method: 'GET',
    headers: managementHeaders(key),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(`GET /v0/management/oauth-model-alias failed with HTTP ${response.status}: ${responseBody}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError)
    throw new Error(`GET /v0/management/oauth-model-alias returned malformed JSON: ${message}`)
  }

  if (!payload || typeof payload !== 'object') {
    return emptyAlias()
  }

  const wrapper = payload as Record<string, unknown>
  const aliasValue = wrapper['oauth-model-alias']

  if (!aliasValue || typeof aliasValue !== 'object') {
    return emptyAlias()
  }

  const aliasObj = aliasValue as Record<string, unknown>
  const claudeEntries = aliasObj.claude

  if (!Array.isArray(claudeEntries)) {
    return emptyAlias()
  }

  // No onDrop warning here — server shape variance (string fork) is expected and normalized silently.
  const claude = parseClaudeEntries(claudeEntries)

  return {claude}
}

/**
 * Order-insensitive set equality for two `OAuthModelAlias` objects.
 * Compares the `claude` arrays by `name`, `alias`, and `fork`.
 * Returns false if counts differ or any entry differs.
 */
export function setEqualOAuthModelAlias(desired: OAuthModelAlias, actual: OAuthModelAlias): boolean {
  if (desired.claude.length !== actual.claude.length) {
    return false
  }

  // Build a canonical key for each entry
  const entryKey = (e: OAuthModelAliasEntry): string => `${e.name}|${e.alias}|${e.fork}`

  const desiredKeys = new Set(desired.claude.map(entryKey))
  const actualKeys = new Set(actual.claude.map(entryKey))

  if (desiredKeys.size !== actualKeys.size) {
    return false
  }

  for (const key of desiredKeys) {
    if (!actualKeys.has(key)) {
      return false
    }
  }

  return true
}
