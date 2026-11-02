import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, posix, resolve} from 'node:path'
import {parseFrontmatter, validateDoc} from '@marcusrbrown/infra-shared/docs/frontmatter'

// Copies the rendered operator docs into the gitignored Starlight content tree.
// Titles come from the H1, repo links become site routes or SHA-pinned GitHub blobs, `<placeholders>` are escaped.

const SITE_BASE = '/infra'
const REPO_URL = 'https://github.com/marcusrbrown/infra'
const GENERATED_DIRS = ['architecture', 'guides', 'runbooks', 'solutions'] as const

export interface GenerateOptions {
  repoRoot: string
  outDir: string
  sha: string
}

export interface GenerateResult {
  /** Content slugs written, e.g. `guides/vpn`. */
  pages: string[]
}

interface Source {
  relPath: string
  slug: string
}

interface Range {
  start: number
  end: number
}

interface Edit extends Range {
  text: string
}

// A repo path the site renders; links to one that is missing must fail instead of falling back to GitHub.
const RENDERED_PATH_RE = /^(?:ARCHITECTURE\.md|STRUCTURE\.md|apps\/[^/]+\/AGENTS\.md|docs\/runbooks\/[^/]+\.md)$/

const H1_RE = /^ {0,3}#[ \t]+(\S.*)$/
const CLOSING_HASHES_RE = /\s#+$/
const REF_DEF_RE = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*(<[^>\n]*>|\S+)/
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const URI_AUTOLINK_RE = /<[a-z][a-z0-9+.-]{1,31}:[^\s<>]*>/iy
const EMAIL_AUTOLINK_RE = /<[\w.!#$%&'*+/=?^`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*>/iy

function discoverSources(repoRoot: string): Source[] {
  const sources: Source[] = []
  const add = (relPath: string, slug: string): void => {
    if (existsSync(join(repoRoot, relPath))) sources.push({relPath, slug})
  }
  add('ARCHITECTURE.md', 'architecture/overview')
  add('STRUCTURE.md', 'architecture/structure')
  const appsDir = join(repoRoot, 'apps')
  if (existsSync(appsDir)) {
    for (const app of readdirSync(appsDir).toSorted()) add(`apps/${app}/AGENTS.md`, `guides/${app}`)
  }
  const runbooksDir = join(repoRoot, 'docs/runbooks')
  if (existsSync(runbooksDir)) {
    for (const name of readdirSync(runbooksDir).toSorted()) {
      if (name.endsWith('.md')) add(`docs/runbooks/${name}`, `runbooks/${name.slice(0, -3)}`)
    }
  }
  return sources
}

/** A code-fence line: optional indentation and blockquote markers, then 3+ backticks or tildes. */
function parseFence(line: string): {marker: string; info: string} | undefined {
  let start = 0
  while (line[start] === ' ' || line[start] === '\t' || line[start] === '>') start++
  const char = line[start]
  if (char !== '`' && char !== '~') return undefined
  let end = start
  while (line[end] === char) end++
  return end - start >= 3 ? {marker: line.slice(start, end), info: line.slice(end)} : undefined
}

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

/** Code spans inside one paragraph: a backtick run closes on the next run of the same length. */
function codeSpans(text: string, base: number): Range[] {
  const spans: Range[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '\\') {
      i += 2
    } else if (char === '`') {
      let runEnd = i
      while (text[runEnd] === '`') runEnd++
      const run = runEnd - i
      let search = runEnd
      let close = -1
      while (search < text.length) {
        const next = text.indexOf('`', search)
        if (next === -1) break
        let nextEnd = next
        while (text[nextEnd] === '`') nextEnd++
        if (nextEnd - next === run) {
          close = nextEnd
          break
        }
        search = nextEnd
      }
      if (close === -1) {
        i = runEnd
      } else {
        spans.push({start: base + i, end: base + close})
        i = close
      }
    } else {
      i++
    }
  }
  return spans
}

/** Fenced code blocks (any indentation, so list-nested fences count) and inline code spans. */
function findCodeRanges(text: string): Range[] {
  const ranges: Range[] = []
  let fence: {char: string; length: number; start: number} | undefined
  let paragraphStart = -1
  let paragraphEnd = -1
  const flush = (): void => {
    if (paragraphStart !== -1) ranges.push(...codeSpans(text.slice(paragraphStart, paragraphEnd), paragraphStart))
    paragraphStart = -1
  }

  let offset = 0
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(offset, lineEnd)
    if (fence === undefined) {
      const open = parseFence(line)
      const marker = open?.marker ?? ''
      // A backtick fence's info string cannot contain a backtick (that would be an inline span).
      if (open !== undefined && !(marker.startsWith('`') && open.info.includes('`'))) {
        flush()
        fence = {char: marker.charAt(0), length: marker.length, start: offset}
      } else if (line.trim() === '') {
        flush()
      } else {
        if (paragraphStart === -1) paragraphStart = offset
        paragraphEnd = lineEnd
      }
    } else {
      const close = parseFence(line)
      const marker = close?.marker ?? ''
      if (
        close !== undefined &&
        marker.startsWith(fence.char) &&
        marker.length >= fence.length &&
        close.info.trim() === ''
      ) {
        ranges.push({start: fence.start, end: lineEnd})
        fence = undefined
      }
    }
    if (newline === -1) break
    offset = newline + 1
  }
  flush()
  if (fence !== undefined) ranges.push({start: fence.start, end: text.length})
  return ranges.toSorted((a, b) => a.start - b.start)
}

function inRanges(ranges: readonly Range[], offset: number): Range | undefined {
  return ranges.find(range => offset >= range.start && offset < range.end)
}

interface LinkContext {
  relPath: string
  sha: string
  rendered: ReadonlyMap<string, string>
  starts: readonly number[]
  errors: string[]
}

function rewriteDestination(dest: string, offset: number, ctx: LinkContext): string {
  // In-page anchors, absolute URLs (any scheme), protocol-relative and root-absolute links are left alone.
  if (dest === '' || dest.startsWith('#') || dest.startsWith('/') || SCHEME_RE.test(dest)) return dest
  const suffixAt = dest.search(/[#?]/)
  const path = suffixAt === -1 ? dest : dest.slice(0, suffixAt)
  const suffix = suffixAt === -1 ? '' : dest.slice(suffixAt)
  const target = posix.normalize(posix.join(posix.dirname(ctx.relPath), path))
  const where = `${ctx.relPath}:${lineAt(ctx.starts, offset)}`
  if (target === '..' || target.startsWith('../')) {
    ctx.errors.push(`${where}: link "${dest}" escapes the repository`)
    return dest
  }
  const slug = ctx.rendered.get(target)
  if (slug !== undefined) return `${SITE_BASE}/${slug}/${suffix}`
  if (RENDERED_PATH_RE.test(target)) {
    ctx.errors.push(`${where}: link "${dest}" targets rendered page ${target}, which does not exist`)
    return dest
  }
  return `${REPO_URL}/blob/${ctx.sha}/${target}${suffix}`
}

/** Finds `](dest ...)` inline destinations and `[ref]: dest` definitions outside code. */
function findDestinations(text: string, code: readonly Range[]): Range[] {
  const found: Range[] = []
  for (let i = 0; i < text.length - 1; i++) {
    const hit = text[i] === ']' && text[i + 1] === '('
    const skip = hit ? inRanges(code, i) : undefined
    if (skip !== undefined) {
      i = skip.end - 1
    } else if (hit) {
      let cursor = i + 2
      while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
      if (text[cursor] === '<') {
        const close = text.indexOf('>', cursor)
        const newline = text.indexOf('\n', cursor)
        if (close !== -1 && (newline === -1 || close < newline)) found.push({start: cursor + 1, end: close})
      } else {
        const start = cursor
        let depth = 0
        while (cursor < text.length) {
          const char = text[cursor]
          if (char === '\\') {
            cursor += 2
            continue
          }
          if (char === undefined || /\s/.test(char)) break
          if (char === '(') depth++
          else if (char === ')') {
            if (depth === 0) break
            depth--
          }
          cursor++
        }
        if (cursor > start) found.push({start, end: cursor})
      }
    }
  }

  let offset = 0
  for (const line of text.split('\n')) {
    const match = REF_DEF_RE.exec(line)
    if (match !== null && inRanges(code, offset) === undefined) {
      const raw = match[1] ?? ''
      const start = offset + line.indexOf(raw, match[0].length - raw.length)
      found.push(
        raw.startsWith('<') ? {start: start + 1, end: start + raw.length - 1} : {start, end: start + raw.length},
      )
    }
    offset += line.length + 1
  }
  return found.toSorted((a, b) => a.start - b.start)
}

/** `<tag-like>` text outside code would be swallowed as raw HTML; escape it. Autolinks and comments stay. */
function findAngleEscapes(text: string, skipRanges: readonly Range[]): Edit[] {
  const edits: Edit[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '<') continue
    const skipped = inRanges(skipRanges, i)
    if (skipped !== undefined) {
      i = skipped.end - 1
      continue
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4)
      i = close === -1 ? text.length : close + 2
      continue
    }
    if (!/[a-z/]/i.test(text[i + 1] ?? '') || text[i - 1] === '\\') continue
    URI_AUTOLINK_RE.lastIndex = i
    EMAIL_AUTOLINK_RE.lastIndex = i
    const autolink = URI_AUTOLINK_RE.exec(text) ?? EMAIL_AUTOLINK_RE.exec(text)
    if (autolink !== null) {
      i += autolink[0].length - 1
      continue
    }
    edits.push({start: i, end: i + 1, text: '&lt;'})
  }
  return edits
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = ''
  let cursor = 0
  for (const edit of edits.toSorted((a, b) => a.start - b.start)) {
    out += text.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  return out + text.slice(cursor)
}

function plainTitle(raw: string): string {
  return raw
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll('`', '')
    .trim()
}

/** Finds the first H1 outside code; returns the title and the range to delete (heading plus following blank lines). */
function findH1(text: string, code: readonly Range[]): {title: string; remove: Range} | undefined {
  let offset = 0
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const match = H1_RE.exec(line)
    if (match !== null && inRanges(code, offset) === undefined) {
      let end = offset + line.length + 1
      for (let next = index + 1; next < lines.length && (lines[next] ?? '').trim() === ''; next++) {
        end += (lines[next] ?? '').length + 1
      }
      const heading = (match[1] ?? '').trimEnd().replace(CLOSING_HASHES_RE, '')
      return {title: plainTitle(heading), remove: {start: offset, end: Math.min(end, text.length)}}
    }
    offset += line.length + 1
  }
  return undefined
}

function frontmatter(title: string): string {
  // JSON string syntax is valid YAML double-quoted scalar syntax.
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n`
}

/** Rewrites links and escapes placeholders in a markdown fragment that has no H1 handling of its own. */
function transformFragment(text: string, ctx: LinkContext): {text: string; code: Range[]; edits: Edit[]} {
  const code = findCodeRanges(text)
  const destinations = findDestinations(text, code)
  const edits: Edit[] = destinations.map(range => ({
    ...range,
    text: rewriteDestination(text.slice(range.start, range.end), range.start, ctx),
  }))
  edits.push(
    ...findAngleEscapes(
      text,
      [...code, ...destinations].toSorted((a, b) => a.start - b.start),
    ),
  )
  return {text, code, edits}
}

function renderSource(source: Source, text: string, ctx: Omit<LinkContext, 'relPath' | 'starts'>): string | undefined {
  const normalized = text.replaceAll('\r\n', '\n')
  const linkContext: LinkContext = {...ctx, relPath: source.relPath, starts: lineStarts(normalized)}
  const {code, edits} = transformFragment(normalized, linkContext)
  const heading = findH1(normalized, code)
  if (heading === undefined) {
    ctx.errors.push(`${source.relPath}: no H1 heading found (the page title comes from the first H1)`)
    return undefined
  }
  // Edits inside the removed heading are moot (and would overlap the removal).
  const kept = edits.filter(edit => edit.end <= heading.remove.start || edit.start >= heading.remove.end)
  const body = applyEdits(normalized, [...kept, {...heading.remove, text: ''}])
  return `${frontmatter(heading.title)}${body.trimStart().trimEnd()}\n`
}

function escapeCell(value: string): string {
  return value.replaceAll('|', String.raw`\|`).replaceAll(/\s+/g, ' ')
}

function buildSolutionsIndex(repoRoot: string, sha: string, errors: string[]): string {
  const files = existsSync(join(repoRoot, 'docs/solutions'))
    ? [...new Bun.Glob('docs/solutions/**/*.md').scanSync({cwd: repoRoot})].toSorted()
    : []
  const entries: {date: string; path: string; row: string}[] = []
  for (const path of files) {
    const text = readFileSync(join(repoRoot, path), 'utf8')
    const violations = validateDoc(path, text, repoRoot)
    const parsed = parseFrontmatter(text)
    if (violations.length > 0 || 'error' in parsed) {
      errors.push(...violations)
      continue
    }
    const {title, date, module, problem_type: problemType} = parsed.data
    const link = `[${escapeCell(String(title))}](${REPO_URL}/blob/${sha}/${path})`
    entries.push({
      date: String(date),
      path,
      row: `| ${String(date)} | ${link} | \`${escapeCell(String(module))}\` | ${escapeCell(String(problemType))} |`,
    })
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path))

  const intro =
    'Solved problems and the lessons kept from them. Each entry links to the source document on GitHub; ' +
    'the documents are not rendered on this site.'
  const table =
    entries.length === 0
      ? 'No solutions recorded yet.'
      : ['| Date | Solution | Module | Type |', '| --- | --- | --- | --- |', ...entries.map(entry => entry.row)].join(
          '\n',
        )
  const markdown = `${intro}\n\n${table}\n`
  // Same escaping as every other page; table rows have no rendered-page links to rewrite.
  const context: LinkContext = {
    relPath: 'docs/solutions',
    sha,
    rendered: new Map(),
    starts: lineStarts(markdown),
    errors,
  }
  const {edits} = transformFragment(markdown, context)
  return `${frontmatter('Solutions')}${applyEdits(markdown, edits)}`
}

export function resolveSha(env: Record<string, string | undefined>, repoRoot: string): string {
  const fromEnv = env.GITHUB_SHA?.trim()
  if (fromEnv) return fromEnv
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: repoRoot})
  const sha = result.stdout.toString().trim()
  if (result.exitCode !== 0 || sha === '')
    throw new Error('cannot resolve the build SHA: set GITHUB_SHA or run inside a git checkout')
  return sha
}

export function generateContent({repoRoot, outDir, sha}: GenerateOptions): GenerateResult {
  const sources = discoverSources(repoRoot)
  const rendered = new Map(sources.map(source => [source.relPath, source.slug]))
  const errors: string[] = []
  const pages = new Map<string, string>()

  for (const source of sources) {
    const text = readFileSync(join(repoRoot, source.relPath), 'utf8')
    const page = renderSource(source, text, {sha, rendered, errors})
    if (page !== undefined) pages.set(source.slug, page)
  }
  pages.set('solutions/index', buildSolutionsIndex(repoRoot, sha, errors))

  if (errors.length > 0) {
    throw new Error(`docs content generation failed (${errors.length} problem(s)):\n${errors.join('\n')}`)
  }

  for (const dir of GENERATED_DIRS) rmSync(join(outDir, dir), {recursive: true, force: true})
  for (const [slug, page] of pages) {
    const file = join(outDir, `${slug}.md`)
    mkdirSync(dirname(file), {recursive: true})
    writeFileSync(file, page)
  }
  return {pages: [...pages.keys()].toSorted()}
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '../../..')
  const outDir = resolve(import.meta.dir, '../src/content/docs')
  try {
    const {pages} = generateContent({repoRoot, outDir, sha: resolveSha(process.env, repoRoot)})
    process.stdout.write(`generated ${pages.length} pages into ${outDir}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
