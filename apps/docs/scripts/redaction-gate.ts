import {appendFileSync, existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import {extname, join, relative, resolve, sep} from 'node:path'
import {discoverSources} from './generate-content'
import {isGloballyReachableIp, parseIp, parseIpv4, parseIpv6} from './ip-classify'

// Blocks publication of globally routable IPs, unlisted hostnames and secret-shaped strings.
//
//   bun apps/docs/scripts/redaction-gate.ts --source        # source markdown, real line numbers
//   bun apps/docs/scripts/redaction-gate.ts --dist <dir>    # built output, backstop
//
// Order of checks per file: secret rules first; defanged forms are then normalized; IP and hostname
// candidates that overlap a secret match are dropped, because the secret finding already covers them
// and carries the pattern ID only. A `Finding` of kind `secret` has no field that could hold the value.

const REDACTION_DIR = resolve(import.meta.dir, '../redaction')
const MAX_FINDINGS = 50

export type Finding =
  | {kind: 'secret'; id: string; file: string; line: number}
  | {kind: 'ip'; value: string; file: string; line: number}
  | {kind: 'hostname'; value: string; file: string; line: number}
  | {kind: 'binary'; extension: string; file: string}
  | {kind: 'symlink'; file: string}

export interface SecretRule {
  id: string
  regex: RegExp
  secretGroup?: number
  entropy?: number
  keywords: readonly string[]
}

export interface AllowEntry {
  host: string
  reason: string
  scope: readonly string[]
}

export interface GateConfig {
  rules: readonly SecretRule[]
  allowlist: readonly AllowEntry[]
  tlds: ReadonlySet<string>
}

// ---------------------------------------------------------------------------------------------------
// Config loading

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSecretRules(data: unknown): SecretRule[] {
  if (!Array.isArray(data)) throw new TypeError('secret-rules.json must be an array')
  return data.map((raw: unknown, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.regex !== 'string') {
      throw new TypeError(`secret-rules.json[${index}] needs string id and regex`)
    }
    const flags = typeof raw.flags === 'string' ? raw.flags : ''
    const keywords = Array.isArray(raw.keywords) ? raw.keywords.map(String) : []
    return {
      id: raw.id,
      regex: new RegExp(raw.regex, `${flags.replaceAll('g', '')}g`),
      ...(typeof raw.secretGroup === 'number' && {secretGroup: raw.secretGroup}),
      ...(typeof raw.entropy === 'number' && {entropy: raw.entropy}),
      keywords: keywords.map(keyword => keyword.toLowerCase()),
    }
  })
}

export function parseAllowlist(data: unknown): AllowEntry[] {
  if (!Array.isArray(data)) throw new TypeError('hostname-allowlist.json must be an array')
  return data.map((raw: unknown, index) => {
    const where = `hostname-allowlist.json[${index}]`
    if (!isRecord(raw)) throw new TypeError(`${where} must be an object`)
    const {host, reason, scope} = raw
    if (typeof host !== 'string' || !HOSTNAME_RE.test(host) || host !== host.toLowerCase() || !host.includes('.')) {
      throw new TypeError(`${where}.host must be an exact lowercase hostname (wildcards are not allowed)`)
    }
    if (typeof reason !== 'string' || reason.trim() === '') throw new TypeError(`${where}.reason is required`)
    if (!Array.isArray(scope) || scope.length === 0 || !scope.every(item => typeof item === 'string' && item !== '')) {
      throw new TypeError(`${where}.scope must be a non-empty array of globs`)
    }
    if (scope.some(item => item === '**' || item === '**/*' || item === '*')) {
      throw new TypeError(`${where}.scope must name a file class, not every file`)
    }
    return {host, reason, scope: scope as string[]}
  })
}

export function parseTlds(data: unknown): ReadonlySet<string> {
  if (!isRecord(data) || !Array.isArray(data.tlds) || !Array.isArray(data.fileExtensions)) {
    throw new TypeError('hostname-tlds.json needs tlds and fileExtensions arrays')
  }
  const extensions = new Set(data.fileExtensions.map(String))
  const tlds = data.tlds.map(String)
  const clash = tlds.filter(tld => extensions.has(tld))
  if (clash.length > 0) {
    throw new TypeError(`hostname-tlds.json: ${clash.join(', ')} listed as both a TLD and a file extension`)
  }
  return new Set(tlds)
}

export function loadConfig(dir = REDACTION_DIR): GateConfig {
  return {
    rules: parseSecretRules(readJson(join(dir, 'secret-rules.json'))),
    allowlist: parseAllowlist(readJson(join(dir, 'hostname-allowlist.json'))),
    tlds: parseTlds(readJson(join(dir, 'hostname-tlds.json'))),
  }
}

// ---------------------------------------------------------------------------------------------------
// Views: the text that is scanned, plus where each character came from in the original file

interface View {
  text: string
  /** `origin[i]` is the offset in the original file of `text[i]`; absent means the view is the file itself. */
  origin?: readonly number[]
}

class ViewBuilder {
  text = ''
  origin: number[] = []

  push(chars: string, from: number): void {
    this.text += chars
    this.origin.push(...Array.from({length: chars.length}, () => from))
  }

  pushRun(chars: string, from: number): void {
    this.text += chars
    for (let i = 0; i < chars.length; i++) this.origin.push(from + i)
  }

  build(): View {
    return {text: this.text, origin: this.origin}
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  sol: '/',
  period: '.',
  colon: ':',
  commat: '@',
  num: '#',
  lowbar: '_',
  hyphen: '-',
  dash: '-',
}
const ENTITY_RE = /&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z][a-z0-9]{1,31}));/iy

function decodeEntitiesInto(builder: ViewBuilder, source: string, start: number, end: number): void {
  let i = start
  while (i < end) {
    if (source[i] === '&') {
      ENTITY_RE.lastIndex = i
      const match = ENTITY_RE.exec(source)
      if (match !== null && i + match[0].length <= end) {
        let decoded: string | undefined
        if (match[1] !== undefined || match[2] !== undefined) {
          const code = match[1] === undefined ? Number(match[2]) : Number.parseInt(match[1], 16)
          decoded = code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : undefined
        } else {
          decoded = NAMED_ENTITIES[(match[3] ?? '').toLowerCase()]
        }
        if (decoded !== undefined) {
          builder.push(decoded, i)
          i += match[0].length
          continue
        }
      }
    }
    builder.push(source.charAt(i), i)
    i++
  }
}

const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'tspan',
  'u',
  'var',
  'wbr',
])
const RAW_TEXT_TAGS = new Set(['script', 'style'])
const TAG_NAME_RE = /^<\/?([a-z][a-z0-9:-]*)/i
const ATTRIBUTE_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/dg

/** End of the tag that starts at `start`, honoring quoted attribute values. */
function findTagEnd(source: string, start: number): number {
  let quote = ''
  for (let i = start + 1; i < source.length; i++) {
    const char = source.charAt(i)
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return i
    }
  }
  return -1
}

export interface HtmlViews {
  /** What a reader sees: text nodes, entities decoded, inline tags dropped, block tags as line breaks. */
  visible: View
  /** What a reader does not see but the page ships: attribute values, comments, script and style bodies. */
  invisible: View
}

/**
 * Two streams per HTML file, so that neither can corrupt the other.
 *
 * `visible`: inline tags are dropped, so a token that Shiki split across `<span>`s is whole again; block tags
 * become line breaks, so neighbouring elements do not fuse into one token. Attribute values never enter it, or
 * they would sit between the two halves of a split token.
 *
 * `invisible`: every attribute value, comment body and script or style body on its own line(s), each character
 * keeping its offset in the original file for line numbers.
 */
export function extractHtml(source: string): HtmlViews {
  const visible = new ViewBuilder()
  const invisible = new ViewBuilder()
  let i = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) {
      decodeEntitiesInto(visible, source, i, source.length)
      break
    }
    decodeEntitiesInto(visible, source, i, lt)
    const next = source.charAt(lt + 1)
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4)
      const end = close === -1 ? source.length : close
      invisible.push('\n', lt)
      invisible.pushRun(source.slice(lt + 4, end), lt + 4)
      invisible.push('\n', end)
      i = close === -1 ? source.length : close + 3
    } else if (next === '!' || next === '?') {
      const close = source.indexOf('>', lt)
      i = close === -1 ? source.length : close + 1
    } else if (/[a-z/]/i.test(next)) {
      const end = findTagEnd(source, lt)
      if (end === -1) {
        decodeEntitiesInto(visible, source, lt, source.length)
        break
      }
      const tag = source.slice(lt, end + 1)
      const name = (TAG_NAME_RE.exec(tag)?.[1] ?? '').toLowerCase()
      if (!INLINE_TAGS.has(name)) visible.push('\n', lt)
      if (!tag.startsWith('</')) {
        for (const match of tag.matchAll(ATTRIBUTE_RE)) {
          const group = [2, 3, 4].find(n => match[n] !== undefined)
          const span = group === undefined ? undefined : match.indices?.[group]
          if (span === undefined) continue
          invisible.push('\n', lt + span[0])
          decodeEntitiesInto(invisible, source, lt + span[0], lt + span[1])
          invisible.push('\n', lt + span[1])
        }
      }
      i = end + 1
      if (RAW_TEXT_TAGS.has(name) && !tag.startsWith('</')) {
        const closer = new RegExp(String.raw`</${name}\b`, 'i')
        const rest = source.slice(i)
        const found = closer.exec(rest)
        const bodyEnd = found === null ? source.length : i + found.index
        invisible.push('\n', i)
        invisible.pushRun(source.slice(i, bodyEnd), i)
        invisible.push('\n', bodyEnd)
        i = bodyEnd
      }
    } else {
      visible.push('<', lt)
      i = lt + 1
    }
  }
  return {visible: visible.build(), invisible: invisible.build()}
}

// ---------------------------------------------------------------------------------------------------
// Defang normalization

const DEFANG_RE =
  /\[\.\]|\[dot\]|\(\.\)|\(dot\)|\[:\](?=\/\/)|hxxps?(?=:\/\/|\[:\]\/\/)|%2e|%2f|%3a|%40|[\u3002\uFF0E\uFF61]/gi
/** URL-encoded punctuation (`http%3A%2F%2Fhost`, as in a CSS `data:` URI) would otherwise glue onto the host. */
const PERCENT_ESCAPES: Readonly<Record<string, string>> = {'%2e': '.', '%2f': '/', '%3a': ':', '%40': '@'}

interface Normalized {
  text: string
  /** `map[i]` is the index in the input of `text[i]`. */
  map: number[]
}

/**
 * `[.]`, `[dot]`, `(.)`, `(dot)` become `.`; `hxxp(s)` becomes `http(s)`, in any case; `%2E`, `%2F`, `%3A` and
 * `%40` become `.`, `/`, `:` and `@`; the ideographic, fullwidth and halfwidth full stops (U+3002, U+FF0E,
 * U+FF61) become `.`.
 */
export function defang(input: string): Normalized {
  let text = ''
  const map: number[] = []
  let cursor = 0
  const copy = (from: number, to: number): void => {
    text += input.slice(from, to)
    for (let i = from; i < to; i++) map.push(i)
  }
  for (const match of input.matchAll(DEFANG_RE)) {
    const at = match.index ?? 0
    copy(cursor, at)
    const token = match[0].toLowerCase()
    if (token.startsWith('hxx')) {
      text += token.replace('hxx', 'htt')
      for (let i = 0; i < token.length; i++) map.push(at + i)
    } else {
      text += PERCENT_ESCAPES[token] ?? (token === '[:]' ? ':' : '.')
      map.push(at)
    }
    cursor = at + match[0].length
  }
  copy(cursor, input.length)
  return {text, map}
}

// ---------------------------------------------------------------------------------------------------
// Detection

interface Span {
  start: number
  end: number
}

function overlaps(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some(span => start < span.end && span.start < end)
}

function entropyOf(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let total = 0
  for (const count of counts.values()) {
    const p = count / value.length
    total -= p * Math.log2(p)
  }
  return total
}

interface SecretHit {
  id: string
  span: Span
}

function findSecrets(text: string, rules: readonly SecretRule[]): SecretHit[] {
  const hits: SecretHit[] = []
  const lower = text.toLowerCase()
  for (const rule of rules) {
    if (rule.keywords.length > 0 && !rule.keywords.some(keyword => lower.includes(keyword))) continue
    for (const match of text.matchAll(rule.regex)) {
      if (match[0] === '') continue
      if (rule.entropy !== undefined) {
        const secret = match[rule.secretGroup ?? 1] ?? match[0]
        if (entropyOf(secret) <= rule.entropy) continue
      }
      const start = match.index ?? 0
      hits.push({id: rule.id, span: {start, end: start + match[0].length}})
    }
  }
  return hits
}

const SPECIAL_USE_SUFFIXES = ['.localhost', '.local', '.test', '.example', '.invalid', '.internal', '.home.arpa']
const SPECIAL_USE_DOMAINS = ['example.com', 'example.net', 'example.org']

/** RFC 2606 / 6761 / 6762 / 8375 names never resolve on the public internet, like the private IP ranges. */
function isSpecialUseName(host: string): boolean {
  return (
    host === 'localhost' ||
    SPECIAL_USE_SUFFIXES.some(suffix => host.endsWith(suffix)) ||
    SPECIAL_USE_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))
  )
}

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const DOTTED_NAME_TAIL_RE = new RegExp(String.raw`${LABEL}(?:\.${LABEL})+$`, 'i')
const BARE_HOST_RE = new RegExp(String.raw`(?<![\w.-])(?:\*\.)?(${LABEL}(?:\.${LABEL})+)(?![\w-])`, 'gi')
// Group 1: scheme (any `scheme://` with an authority: postgres, ssh, redis, https...; absent for protocol-relative
// `//host`), group 2: userinfo, group 3: host. `file:///path` has no authority, so it does not match.
const URL_RE = /(?:([a-z][a-z0-9+.-]*):|(?<![\w:/.-]))\/\/(?:([^\s/?#<>"'`\\]*)@)?([^\s/?#:<>"'`\\@[\]]+)/gi
// SCP-style remote `user@host.tld:path` (git over SSH). Group 1: user, group 2: host. The path must follow the
// colon directly, so `ops@host.tld: text` in prose is not a remote.
const SCP_RE = new RegExp(String.raw`(?<![\w.@-])([\w.-]+)@(${LABEL}(?:\.${LABEL})+)(?=:[\w~./-])`, 'gi')
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g
const IPV6_RE = /(?<![\w:.])[0-9a-f:.]*:[0-9a-f:.]*/gi

interface Candidate {
  kind: 'ip' | 'hostname'
  value: string
  start: number
  end: number
}

function validHostname(host: string): boolean {
  return host.length <= 253 && host.split('.').every(label => label.length <= 63) && HOSTNAME_RE.test(host)
}

function findIps(text: string): Candidate[] {
  const found: Candidate[] = []
  const v6Spans: Span[] = []
  for (const match of text.matchAll(IPV6_RE)) {
    let token = match[0]
    const start = match.index ?? 0
    while (token.length > 1 && parseIpv6(token) === undefined && /[.:]$/.test(token) && !token.endsWith('::')) {
      token = token.slice(0, -1)
    }
    const after = text.charAt(start + token.length)
    if (parseIpv6(token) === undefined || /\w/.test(after)) continue
    const ip = parseIp(token)
    if (ip === undefined) continue
    v6Spans.push({start, end: start + token.length})
    if (isGloballyReachableIp(ip))
      found.push({kind: 'ip', value: token.toLowerCase(), start, end: start + token.length})
  }
  for (const match of text.matchAll(IPV4_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(v6Spans, start, end) || parseIpv4(match[0]) === undefined) continue
    const ip = parseIp(match[0])
    if (ip !== undefined && isGloballyReachableIp(ip)) found.push({kind: 'ip', value: match[0], start, end})
  }
  return found
}

function findHostnames(text: string, tlds: ReadonlySet<string>): Candidate[] {
  const found: Candidate[] = []
  const userinfo: Span[] = []

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    const scheme = match[1]
    // `file://` names a path, not a host: `file:///etc/hosts`, and tools that take `file://merged.json`.
    if (scheme?.toLowerCase() === 'file') continue
    const info = match[2]
    if (info !== undefined) {
      const infoStart = start + match[0].indexOf('//') + 2
      userinfo.push({start: infoStart, end: infoStart + info.length + 1})
    }
    const hostText = match[3] ?? ''
    const raw = hostText.replace(/\.$/, '')
    const host = (validHostname(raw.toLowerCase()) ? raw : (DOTTED_NAME_TAIL_RE.exec(raw)?.[0] ?? '')).toLowerCase()
    if (!host.includes('.') || parseIp(host) !== undefined || !validHostname(host)) continue
    // A scheme makes it a URL host whatever the TLD; bare `//x.y` is also comment and path syntax.
    if (scheme === undefined && !tlds.has(host.slice(host.lastIndexOf('.') + 1))) continue
    const hostStart = start + match[0].length - hostText.length
    found.push({kind: 'hostname', value: host, start: hostStart, end: hostStart + raw.length})
  }

  for (const match of text.matchAll(SCP_RE)) {
    const start = (match.index ?? 0) + match[0].length - (match[2] ?? '').length
    const host = (match[2] ?? '').toLowerCase()
    userinfo.push({start: match.index ?? 0, end: start})
    if (parseIp(host) !== undefined || !validHostname(host)) continue
    found.push({kind: 'hostname', value: host, start, end: start + host.length})
  }

  for (const match of text.matchAll(BARE_HOST_RE)) {
    const start = (match.index ?? 0) + match[0].length - (match[1] ?? '').length
    const host = (match[1] ?? '').toLowerCase()
    const tld = host.slice(host.lastIndexOf('.') + 1)
    if (!tlds.has(tld) || !validHostname(host) || overlaps(userinfo, start, start + host.length)) continue
    // `@scope.name/pkg` is an npm scope or an @mention; `user@host` has a word character before the `@`.
    if (text[start - 1] === '@' && !/[\w.-]/.test(text[start - 2] ?? '')) continue
    found.push({kind: 'hostname', value: host, start, end: start + host.length})
  }
  return found
}

const globCache = new Map<string, Bun.Glob>()

function inScope(entry: AllowEntry, scopePath: string): boolean {
  return entry.scope.some(pattern => {
    let glob = globCache.get(pattern)
    if (glob === undefined) {
      glob = new Bun.Glob(pattern)
      globCache.set(pattern, glob)
    }
    return glob.match(scopePath)
  })
}

export function isAllowed(config: GateConfig, host: string, scopePath: string): boolean {
  return config.allowlist.some(entry => entry.host === host && inScope(entry, scopePath))
}

// ---------------------------------------------------------------------------------------------------
// Scanning

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((starts[mid] ?? 0) <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

/**
 * Scans one view. `file` is what findings show; `scopePath` is what allowlist globs match (repo-relative
 * for the source pass, dist-relative for the dist pass); `original` is the file text, for line numbers.
 */
export function scanView(config: GateConfig, file: string, scopePath: string, original: string, view: View): Finding[] {
  const findings: Finding[] = []
  const starts = lineStarts(original)
  const toLine = (viewOffset: number): number => lineAt(starts, view.origin?.[viewOffset] ?? viewOffset)

  const secrets = findSecrets(view.text, config.rules)
  for (const hit of secrets) findings.push({kind: 'secret', id: hit.id, file, line: toLine(hit.span.start)})
  const secretSpans = secrets.map(hit => hit.span)

  const normalized = defang(view.text)
  const candidates = [...findIps(normalized.text), ...findHostnames(normalized.text, config.tlds)]
  for (const candidate of candidates) {
    const viewStart = normalized.map[candidate.start] ?? candidate.start
    const viewEnd = (normalized.map[candidate.end - 1] ?? candidate.end - 1) + 1
    if (overlaps(secretSpans, viewStart, viewEnd)) continue
    const line = toLine(viewStart)
    if (candidate.kind === 'ip') {
      findings.push({kind: 'ip', value: candidate.value, file, line})
    } else if (!isSpecialUseName(candidate.value) && !isAllowed(config, candidate.value, scopePath)) {
      findings.push({kind: 'hostname', value: candidate.value, file, line})
    }
  }
  return dedupe(findings)
}

const HTML_EXTENSIONS = new Set(['.html', '.htm'])

export function scanText(config: GateConfig, file: string, scopePath: string, text: string): Finding[] {
  if (!HTML_EXTENSIONS.has(extname(scopePath).toLowerCase())) return scanView(config, file, scopePath, text, {text})
  const {visible, invisible} = extractHtml(text)
  return dedupe([
    ...scanView(config, file, scopePath, text, visible),
    ...scanView(config, file, scopePath, text, invisible),
  ])
}

/** Frontmatter fields of a solution document that the solutions index renders. */
const SOLUTION_FIELDS = new Set(['title', 'module', 'problem_type'])

function solutionFrontmatterView(text: string): View | undefined {
  if (!text.startsWith('---\n')) return undefined
  const close = text.indexOf('\n---', 4)
  if (close === -1) return undefined
  const builder = new ViewBuilder()
  let offset = 0
  for (const line of text.slice(0, close).split('\n')) {
    const key = /^([a-z_]+):/.exec(line)?.[1]
    if (key !== undefined && SOLUTION_FIELDS.has(key)) {
      builder.pushRun(line, offset)
      builder.push('\n', offset + line.length)
    }
    offset += line.length + 1
  }
  return builder.build()
}

function gitTracked(repoRoot: string, pathspec: string): string[] {
  try {
    const result = Bun.spawnSync(['git', 'ls-files', '-z', '--', pathspec], {cwd: repoRoot})
    if (result.exitCode !== 0) return []
    return result.stdout
      .toString()
      .split('\0')
      .filter(path => path !== '')
  } catch {
    return []
  }
}

interface Tree {
  files: string[]
  symlinks: string[]
}

/** Regular files and symlinks under `dir`. A symlink is reported, never followed. */
function walk(dir: string): Tree {
  const tree: Tree = {files: [], symlinks: []}
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      tree.symlinks.push(path)
    } else if (entry.isDirectory()) {
      const sub = walk(path)
      tree.files.push(...sub.files)
      tree.symlinks.push(...sub.symlinks)
    } else if (entry.isFile()) {
      tree.files.push(path)
    }
  }
  return {files: tree.files.toSorted(), symlinks: tree.symlinks.toSorted()}
}

/** The rendered sources, the solution frontmatter, the diagram specs and the committed site pages. */
export function scanSource(config: GateConfig, repoRoot: string): Finding[] {
  const findings: Finding[] = []
  const scanFile = (relPath: string, view?: (text: string) => View | undefined): void => {
    const text = readFileSync(join(repoRoot, relPath), 'utf8').replaceAll('\r\n', '\n')
    const scoped = view === undefined ? {text} : view(text)
    if (scoped !== undefined) findings.push(...scanView(config, relPath, relPath, text, scoped))
  }

  for (const source of discoverSources(repoRoot)) scanFile(source.relPath)

  const solutions = join(repoRoot, 'docs/solutions')
  if (existsSync(solutions)) {
    for (const path of new Bun.Glob('docs/solutions/**/*.md').scanSync({cwd: repoRoot})) {
      scanFile(path, solutionFrontmatterView)
    }
  }

  const diagrams = join(repoRoot, 'apps/docs/diagrams')
  if (existsSync(diagrams)) {
    for (const path of new Bun.Glob('apps/docs/diagrams/**/*.json').scanSync({cwd: repoRoot})) scanFile(path)
  }

  for (const path of gitTracked(repoRoot, 'apps/docs/src/content/docs')) {
    if (/\.mdx?$/.test(path)) scanFile(path)
  }
  return findings
}

/** Image and font types the build emits. Anything binary outside this list fails the gate. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
])

/**
 * Pagefind writes gzipped files. Fragments carry the page text verbatim, so they are decompressed and
 * scanned like any text file. The index, metadata, filter and wasm containers are binary even when
 * decompressed (CBOR word tables, WebAssembly); they hold tokenized words, not the page text.
 */
const PAGEFIND_FRAGMENT_EXTENSION = '.pf_fragment'
const PAGEFIND_OPAQUE_EXTENSIONS = new Set(['.pf_index', '.pf_meta', '.pf_filter', '.pagefind'])

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b
}

function pagefindKind(distRelPath: string, bytes: Uint8Array): 'fragment' | 'opaque' | undefined {
  if (!distRelPath.split('/').includes('pagefind') || !isGzip(bytes)) return undefined
  const extension = extname(distRelPath).toLowerCase()
  if (extension === PAGEFIND_FRAGMENT_EXTENSION) return 'fragment'
  return PAGEFIND_OPAQUE_EXTENSIONS.has(extension) ? 'opaque' : undefined
}
const UTF8 = new TextDecoder('utf-8', {fatal: true})

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return UTF8.decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Every text-decodable file in `distDir`, whatever its extension, plus the text inside Pagefind fragments.
 * Any symlink fails: the Pages upload dereferences symlinks, so a target outside the scan would ship.
 */
export function scanDist(config: GateConfig, distDir: string, displayDir = distDir): Finding[] {
  const findings: Finding[] = []
  const tree = walk(distDir)
  const relOf = (path: string): string => relative(distDir, path).split(sep).join('/')
  for (const path of tree.symlinks) findings.push({kind: 'symlink', file: join(displayDir, relOf(path))})
  for (const path of tree.files) {
    const rel = relOf(path)
    const shown = join(displayDir, rel)
    const raw = new Uint8Array(readFileSync(path))
    const pagefind = pagefindKind(rel, raw)
    if (pagefind === 'opaque') continue
    let bytes = raw
    if (pagefind === 'fragment') {
      try {
        bytes = Bun.gunzipSync(raw)
      } catch {
        findings.push({kind: 'binary', extension: extname(rel).toLowerCase(), file: shown})
        continue
      }
    }
    const text = decodeText(bytes)
    if (text === undefined) {
      const extension = extname(rel).toLowerCase()
      if (!BINARY_EXTENSIONS.has(extension)) findings.push({kind: 'binary', extension, file: shown})
      continue
    }
    const normalized = text.replaceAll('\r\n', '\n')
    if (pagefind === 'fragment') {
      // Fragment text is the rendered page text, so it is scoped like that page's HTML (allowlist globs for
      // `**/*.html`), but it is plain text: never run it through the HTML extractor.
      const scope = `${rel.slice(0, -extname(rel).length)}.html`
      findings.push(...scanView(config, shown, scope, normalized, {text: normalized}))
    } else {
      findings.push(...scanText(config, shown, rel, normalized))
    }
  }
  return findings
}

// ---------------------------------------------------------------------------------------------------
// Reporting

export function dedupe(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>()
  const unique: Finding[] = []
  for (const finding of findings) {
    const key =
      finding.kind === 'secret'
        ? `secret|${finding.id}|${finding.file}|${finding.line}`
        : finding.kind === 'binary'
          ? `binary|${finding.file}`
          : finding.kind === 'symlink'
            ? `symlink|${finding.file}`
            : `${finding.kind}|${finding.value}|${finding.file}|${finding.line}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(finding)
  }
  return unique
}

function location(finding: Finding): string {
  return finding.kind === 'binary' || finding.kind === 'symlink' ? finding.file : `${finding.file}:${finding.line}`
}

function describe(finding: Finding): string {
  switch (finding.kind) {
    case 'secret': {
      return `secret pattern ${finding.id}`
    }
    case 'ip': {
      return `globally reachable IP ${finding.value}`
    }
    case 'hostname': {
      return `hostname ${finding.value} is not on the allowlist`
    }
    case 'binary': {
      return `binary file type ${finding.extension === '' ? '(no extension)' : finding.extension} is not on the allowed list`
    }
    case 'symlink': {
      return 'symlink is not allowed (the Pages upload would follow it)'
    }
  }
}

export function formatFinding(finding: Finding): string {
  return `${location(finding)}: ${describe(finding)}`
}

const escapeData = (value: string): string =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const escapeProperty = (value: string): string => escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')

export function formatAnnotation(finding: Finding): string {
  const line = finding.kind === 'binary' || finding.kind === 'symlink' ? '' : `,line=${finding.line}`
  return `::error file=${escapeProperty(finding.file)}${line}::${escapeData(describe(finding))}`
}

export interface Report {
  lines: string[]
  annotations: string[]
  summary: string
  total: number
}

export function buildReport(findings: readonly Finding[], max = MAX_FINDINGS): Report {
  const unique = dedupe(findings)
  const shown = unique.slice(0, max)
  const hidden = unique.length - shown.length
  const lines = shown.map(formatFinding)
  if (hidden > 0) lines.push(`... and ${hidden} more finding(s) not shown`)
  const noun = unique.length === 1 ? 'finding' : 'findings'
  return {
    lines,
    annotations: shown.map(formatAnnotation),
    summary: unique.length === 0 ? 'redaction gate: clean' : `redaction gate: ${unique.length} ${noun}`,
    total: unique.length,
  }
}

// ---------------------------------------------------------------------------------------------------
// CLI

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

const USAGE = 'usage: redaction-gate.ts [--source] [--dist <dir>]'

export function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  options: {repoRoot?: string; config?: GateConfig} = {},
): number {
  let source = false
  const dists: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source') {
      source = true
    } else if (arg === '--dist') {
      const dir = argv[++i]
      if (dir === undefined || dir.startsWith('--')) {
        io.err(`--dist needs a directory\n${USAGE}\n`)
        return 2
      }
      dists.push(dir)
    } else {
      io.err(`unknown argument ${String(arg)}\n${USAGE}\n`)
      return 2
    }
  }
  if (!source && dists.length === 0) {
    io.err(`${USAGE}\n`)
    return 2
  }

  const repoRoot = options.repoRoot ?? resolve(import.meta.dir, '../../..')
  const findings: Finding[] = []
  try {
    const config = options.config ?? loadConfig()
    if (source) findings.push(...scanSource(config, repoRoot))
    for (const dist of dists) {
      if (!existsSync(dist) || !statSync(dist).isDirectory()) throw new Error(`dist directory not found: ${dist}`)
      findings.push(...scanDist(config, resolve(dist), dist))
    }
  } catch (error) {
    io.err(`redaction gate failed to run: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const report = buildReport(findings)
  for (const line of report.lines) io.out(`${line}\n`)
  if (env.GITHUB_ACTIONS) for (const annotation of report.annotations) io.out(`${annotation}\n`)
  io.out(`${report.summary}\n`)
  if (env.GITHUB_STEP_SUMMARY) {
    const body =
      report.total === 0 ? [] : ['', ...report.lines.map(line => `- ${line.replaceAll('|', String.raw`\|`)}`)]
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${report.summary}\n${body.join('\n')}\n`)
  }
  return report.total === 0 ? 0 : 1
}

if (import.meta.main) {
  process.exit(
    runCli(process.argv.slice(2), process.env, {
      out: text => process.stdout.write(text),
      err: text => process.stderr.write(text),
    }),
  )
}
