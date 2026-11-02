import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {afterEach, describe, expect, it} from 'bun:test'
import {discoverSpecs, renderDiagrams} from './render-diagrams'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

// CI test jobs check out shallow; the real render is exercised by site.yaml's full-history build.
const SHALLOW_CHECKOUT =
  Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], {cwd: REPO_ROOT}).stdout.toString().trim() === 'true'
const ARCHIFY = join(REPO_ROOT, '.agents/skills/archify')
const ARCHIFY_BIN = join(ARCHIFY, 'bin/archify.mjs')

const MONITORED_APPS = ['broker', 'cliproxy', 'dashboard', 'gateway', 'keeweb', 'umami', 'vpn']
const RUNBOOK_MAPS = ['umami-pg-upgrade', 'vpn-key-rotation', 'dashboard-rollback']

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true})
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'infra-diagrams-'))
  temps.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    {cwd},
  )
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/** A throwaway repo that reuses the real Archify install through a symlink. */
function makeRepo(specs: Record<string, string>, {commit = true}: {commit?: boolean} = {}): string {
  const root = tempDir()
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, '.agents/skills'), {recursive: true})
  symlinkSync(ARCHIFY, join(root, '.agents/skills/archify'))
  for (const [path, text] of Object.entries(specs)) {
    mkdirSync(dirname(join(root, path)), {recursive: true})
    writeFileSync(join(root, path), text)
  }
  writeFileSync(join(root, 'README.md'), 'fixture\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'init')
  if (commit && Object.keys(specs).length > 0) {
    git(root, 'add', 'apps')
    git(root, 'commit', '-q', '-m', 'add specs')
  }
  return root
}

const minimalSpec = (output: string): string =>
  JSON.stringify({
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {title: 'Fixture Diagram', output, quality_profile: 'standard'},
    components: [
      {id: 'a', type: 'frontend', label: 'A', pos: [40, 40], size: [120, 60]},
      {id: 'b', type: 'backend', label: 'B', pos: [260, 40], size: [120, 60]},
    ],
    connections: [{from: 'a', to: 'b', label: 'calls'}],
  })

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

interface WorkflowNode {
  id: string
  icon?: string
  tag?: string
}

const specs = discoverSpecs(REPO_ROOT)

describe('diagram specs', () => {
  it('ships the v1 set of 14 diagrams', () => {
    expect(specs.map(spec => spec.name).toSorted()).toEqual(
      [
        'deploy-pipeline',
        'operator-path',
        'status-snapshot',
        'topology',
        ...MONITORED_APPS.map(app => `apps-${app}`),
        ...RUNBOOK_MAPS.map(name => `runbooks-${name}`),
      ].toSorted(),
    )
  })

  for (const spec of specs) {
    it(`${spec.path} validates and points meta.output at the render path`, () => {
      const result = Bun.spawnSync(['node', ARCHIFY_BIN, 'validate', spec.type, spec.path, '--json'], {
        cwd: REPO_ROOT,
        env: {...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1'},
      })
      expect(result.exitCode, result.stdout.toString()).toBe(0)
      const meta = readJson(join(REPO_ROOT, spec.path)).meta as {output: string}
      expect(meta.output).toBe(`apps/docs/.diagrams/${spec.name}.html`)
    })
  }

  it('marks a STOP or decision node and an irreversible node on every runbook map', () => {
    for (const name of RUNBOOK_MAPS) {
      const spec = readJson(join(REPO_ROOT, `apps/docs/diagrams/runbooks/${name}.workflow.json`))
      const nodes = spec.nodes as WorkflowNode[]
      const gates = nodes.filter(
        node => ['stop', 'decision'].includes(node.icon ?? '') && /^(?:STOP|DECISION)/.test(node.tag ?? ''),
      )
      const irreversible = nodes.filter(node => (node.tag ?? '').startsWith('IRREVERSIBLE'))
      expect(gates.length, `${name}: STOP or decision nodes`).toBeGreaterThan(0)
      expect(irreversible.length, `${name}: irreversible nodes`).toBeGreaterThan(0)
    }
  })

  it('draws exactly the 7 monitored apps in the topology', () => {
    const topology = readJson(join(REPO_ROOT, 'apps/docs/diagrams/topology.architecture.json'))
    const components = topology.components as {id: string}[]
    const apps = components.filter(component => component.id.startsWith('app-')).map(component => component.id.slice(4))
    expect(apps.toSorted()).toEqual(MONITORED_APPS)
    expect(components.some(component => component.id === 'app-agent')).toBe(false)
  })

  it('keeps IP literals and hostnames out of every spec', () => {
    for (const spec of specs) {
      const text = readFileSync(join(REPO_ROOT, spec.path), 'utf8')
      expect(text, spec.path).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
      expect(text, spec.path).not.toMatch(/\b[a-z0-9-]+\.(?:fro\.bot|heatvision\.co|igg\.ms)\b/i)
    }
  })
})

describe('renderDiagrams', () => {
  it('renders HTML, publishes only *.html and writes the manifest', () => {
    const repoRoot = makeRepo({
      'apps/docs/diagrams/one.architecture.json': minimalSpec('apps/docs/.diagrams/one.html'),
      'apps/docs/diagrams/nested/two.architecture.json': minimalSpec('apps/docs/.diagrams/nested-two.html'),
    })

    const entries = renderDiagrams({repoRoot})

    expect(entries.map(entry => entry.name)).toEqual(['nested-two', 'one'])
    const diagramsDir = join(repoRoot, 'apps/docs/.diagrams')
    expect(readdirSync(diagramsDir).some(file => file.endsWith('.delivery.json'))).toBe(true)

    const published = readdirSync(join(repoRoot, 'apps/docs/public/diagrams'))
    expect(published.toSorted()).toEqual(['nested-two.html', 'one.html'])
    expect(published.some(file => file.includes('delivery'))).toBe(false)

    const manifest = JSON.parse(readFileSync(join(repoRoot, 'apps/docs/src/generated/diagrams.json'), 'utf8')) as {
      name: string
      title: string
      specCommit: string
    }[]
    expect(manifest.map(entry => entry.name)).toEqual(['nested-two', 'one'])
    expect(manifest[0]?.title).toBe('Fixture Diagram')
    expect(manifest[0]?.specCommit).toBe(
      git(repoRoot, 'log', '-1', '--format=%h', '--', 'apps/docs/diagrams/nested/two.architecture.json'),
    )
    expect(manifest[0]?.specCommit).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('labels a spec that has no commit yet as unmerged', () => {
    const repoRoot = makeRepo(
      {'apps/docs/diagrams/draft.architecture.json': minimalSpec('apps/docs/.diagrams/draft.html')},
      {commit: false},
    )
    const entries = renderDiagrams({repoRoot})
    expect(entries).toEqual([{name: 'draft', title: 'Fixture Diagram', specCommit: 'unmerged'}])
  })

  it('removes stale published diagrams on the next run', () => {
    const repoRoot = makeRepo({'apps/docs/diagrams/one.architecture.json': minimalSpec('apps/docs/.diagrams/one.html')})
    mkdirSync(join(repoRoot, 'apps/docs/public/diagrams'), {recursive: true})
    writeFileSync(join(repoRoot, 'apps/docs/public/diagrams/old.html'), '<html></html>')
    renderDiagrams({repoRoot})
    expect(readdirSync(join(repoRoot, 'apps/docs/public/diagrams'))).toEqual(['one.html'])
  })

  it('fails on a shallow checkout', () => {
    const origin = makeRepo({'apps/docs/diagrams/one.architecture.json': minimalSpec('apps/docs/.diagrams/one.html')})
    const parent = tempDir()
    const clone = join(parent, 'clone')
    git(parent, 'clone', '-q', '--depth', '1', `file://${origin}`, clone)
    expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('true')

    expect(() => renderDiagrams({repoRoot: clone})).toThrow(/shallow/i)
    expect(existsSync(join(clone, 'apps/docs/public/diagrams'))).toBe(false)
  })

  it('fails the build and names the spec when validation fails', () => {
    const repoRoot = makeRepo({
      'apps/docs/diagrams/good.architecture.json': minimalSpec('apps/docs/.diagrams/good.html'),
      'apps/docs/diagrams/broken.architecture.json': JSON.stringify({
        schema_version: 1,
        diagram_type: 'architecture',
        meta: {title: 'Broken', output: 'apps/docs/.diagrams/broken.html'},
      }),
    })
    expect(() => renderDiagrams({repoRoot})).toThrow(/apps\/docs\/diagrams\/broken\.architecture\.json/)
  })

  it('fails and names the spec when meta.output is not the render path', () => {
    const repoRoot = makeRepo({
      'apps/docs/diagrams/drift.architecture.json': minimalSpec('somewhere/else.html'),
    })
    expect(() => renderDiagrams({repoRoot})).toThrow(/apps\/docs\/diagrams\/drift\.architecture\.json.*meta\.output/s)
  })

  it('fails when the file name type disagrees with diagram_type', () => {
    const repoRoot = makeRepo({
      'apps/docs/diagrams/mixed.workflow.json': minimalSpec('apps/docs/.diagrams/mixed.html'),
    })
    expect(() => renderDiagrams({repoRoot})).toThrow(/apps\/docs\/diagrams\/mixed\.workflow\.json.*diagram_type/s)
  })
})

describe('render-diagrams CLI', () => {
  it.skipIf(SHALLOW_CHECKOUT)(
    'works with cwd set to apps/docs and publishes only HTML',
    () => {
      const result = Bun.spawnSync(['bun', 'run', 'scripts/render-diagrams.ts'], {
        cwd: join(REPO_ROOT, 'apps/docs'),
        env: {...process.env, NO_COLOR: '1'},
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)

      const published = readdirSync(join(REPO_ROOT, 'apps/docs/public/diagrams'))
      expect(published.length).toBe(specs.length)
      expect(published.every(file => file.endsWith('.html'))).toBe(true)
      expect(published.some(file => file.includes('delivery'))).toBe(false)

      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/docs/src/generated/diagrams.json'), 'utf8')) as {
        name: string
      }[]
      expect(manifest.map(entry => entry.name).toSorted()).toEqual(specs.map(spec => spec.name).toSorted())
    },
    180_000,
  )
})
