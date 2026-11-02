import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, posix, resolve} from 'node:path'

// Renders the Archify specs in apps/docs/diagrams into standalone HTML (no browser needed), publishes only the
// *.html files under public/diagrams, and writes the manifest the <Diagram> component reads.

const SPEC_DIR = 'apps/docs/diagrams'
const RENDER_DIR = 'apps/docs/.diagrams'
const PUBLIC_DIR = 'apps/docs/public/diagrams'
const MANIFEST_PATH = 'apps/docs/src/generated/diagrams.json'
const ARCHIFY_BIN = '.agents/skills/archify/bin/archify.mjs'
const SPEC_FILE_RE = /^(?<stem>.+)\.(?<type>[a-z]+)\.json$/

export interface DiagramSpec {
  /** Repo-relative POSIX path of the spec. */
  path: string
  /** Archify diagram type, taken from the `<name>.<type>.json` file name. */
  type: string
  /** Output file stem: the path under `diagrams/` with `/` flattened to `-`. */
  name: string
}

export interface ManifestEntry {
  name: string
  title: string
  /** Short SHA of the last commit that touched the spec, or `unmerged` when it has none yet. */
  specCommit: string
}

export interface RenderOptions {
  repoRoot: string
}

function walk(dir: string, rel: string, found: string[]): void {
  for (const entry of readdirSync(join(dir, rel), {withFileTypes: true}).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const next = posix.join(rel, entry.name)
    if (entry.isDirectory()) walk(dir, next, found)
    else if (SPEC_FILE_RE.test(entry.name)) found.push(next)
  }
}

export function discoverSpecs(repoRoot: string): DiagramSpec[] {
  const specDir = join(repoRoot, SPEC_DIR)
  if (!existsSync(specDir)) return []
  const relPaths: string[] = []
  walk(specDir, '', relPaths)
  const specs = relPaths.map((relPath): DiagramSpec => {
    const match = SPEC_FILE_RE.exec(relPath)
    const {stem = '', type = ''} = match?.groups ?? {}
    return {path: posix.join(SPEC_DIR, relPath), type, name: stem.replaceAll('/', '-')}
  })
  return specs.toSorted((a, b) => a.name.localeCompare(b.name))
}

function fail(spec: DiagramSpec, message: string): never {
  throw new Error(`diagram spec ${spec.path}: ${message}`)
}

function assertNotShallow(repoRoot: string): void {
  const result = Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], {cwd: repoRoot})
  const answer = result.stdout.toString().trim()
  if (result.exitCode !== 0) {
    throw new Error(`cannot render diagrams: not a git checkout (${result.stderr.toString().trim()})`)
  }
  if (answer !== 'false') {
    throw new Error(
      'cannot render diagrams from a shallow checkout: the "spec last changed in" labels need git history ' +
        '(use fetch-depth: 0, or `git fetch --unshallow`)',
    )
  }
}

function specCommit(repoRoot: string, spec: DiagramSpec): string {
  const result = Bun.spawnSync(['git', 'log', '-1', '--format=%h', '--', spec.path], {cwd: repoRoot})
  if (result.exitCode !== 0) fail(spec, `git log failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim() || 'unmerged'
}

function readSpec(repoRoot: string, spec: DiagramSpec): {title: string} {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(repoRoot, spec.path), 'utf8'))
  } catch (error) {
    return fail(spec, `not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const document = parsed as {diagram_type?: unknown; meta?: {title?: unknown; output?: unknown}}
  if (document.diagram_type !== spec.type) {
    fail(spec, `diagram_type is ${JSON.stringify(document.diagram_type)} but the file name says "${spec.type}"`)
  }
  const expectedOutput = `${RENDER_DIR}/${spec.name}.html`
  if (document.meta?.output !== expectedOutput) {
    fail(spec, `meta.output must be "${expectedOutput}", found ${JSON.stringify(document.meta?.output)}`)
  }
  const title = document.meta?.title
  if (typeof title !== 'string' || title.trim() === '') fail(spec, 'meta.title is missing')
  return {title}
}

function runArchify(repoRoot: string, spec: DiagramSpec): void {
  const bin = join(repoRoot, ARCHIFY_BIN)
  if (!existsSync(bin)) throw new Error(`Archify is not installed at ${ARCHIFY_BIN}`)
  const output = `${RENDER_DIR}/${spec.name}.html`
  // The update check is a network call; a docs build must stay offline and deterministic.
  const result = Bun.spawnSync(['node', bin, 'deliver', spec.type, spec.path, output, '--json'], {
    cwd: repoRoot,
    env: {...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1', NO_COLOR: '1'},
  })
  if (result.exitCode !== 0) {
    const detail = (result.stdout.toString() + result.stderr.toString()).trim().slice(0, 2000)
    fail(spec, `archify deliver failed with exit ${result.exitCode}\n${detail}`)
  }
  if (!existsSync(join(repoRoot, output))) fail(spec, `archify deliver succeeded but wrote no ${output}`)
}

/** Renders every spec, publishes the HTML and writes the manifest. Throws, naming the spec, on the first failure. */
export function renderDiagrams({repoRoot}: RenderOptions): ManifestEntry[] {
  assertNotShallow(repoRoot)
  const specs = discoverSpecs(repoRoot)
  const seen = new Map<string, DiagramSpec>()
  for (const spec of specs) {
    const clash = seen.get(spec.name)
    if (clash !== undefined) fail(spec, `produces the same name "${spec.name}" as ${clash.path}`)
    seen.set(spec.name, spec)
  }

  const renderDir = join(repoRoot, RENDER_DIR)
  const publicDir = join(repoRoot, PUBLIC_DIR)
  rmSync(renderDir, {recursive: true, force: true})
  rmSync(publicDir, {recursive: true, force: true})
  mkdirSync(renderDir, {recursive: true})
  mkdirSync(publicDir, {recursive: true})

  const entries: ManifestEntry[] = []
  for (const spec of specs) {
    const {title} = readSpec(repoRoot, spec)
    runArchify(repoRoot, spec)
    entries.push({name: spec.name, title, specCommit: specCommit(repoRoot, spec)})
  }

  // `deliver` leaves a <name>.delivery.json receipt beside each page; only the pages are published.
  for (const file of readdirSync(renderDir)) {
    if (file.endsWith('.html')) copyFileSync(join(renderDir, file), join(publicDir, file))
  }

  const manifestFile = join(repoRoot, MANIFEST_PATH)
  mkdirSync(dirname(manifestFile), {recursive: true})
  writeFileSync(manifestFile, `${JSON.stringify(entries, null, 2)}\n`)
  return entries
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '../../..')
  try {
    const entries = renderDiagrams({repoRoot})
    process.stdout.write(`rendered ${entries.length} diagrams into ${join(repoRoot, PUBLIC_DIR)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
