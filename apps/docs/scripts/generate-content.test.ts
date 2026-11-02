import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {afterEach, describe, expect, it} from 'bun:test'
import {generateContent, resolveSha} from './generate-content'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const SHA = 'abc1234'
const BLOB = `https://github.com/marcusrbrown/infra/blob/${SHA}`

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true})
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'infra-docs-'))
  temps.push(dir)
  return dir
}

const BASE_FILES: Record<string, string> = {
  'ARCHITECTURE.md': '# Architecture\n\nSee [structure](STRUCTURE.md#layout).\n',
  'STRUCTURE.md': '# Structure\n\nBack to [architecture](ARCHITECTURE.md).\n',
  'apps/vpn/AGENTS.md': '# VPN Deploy Package\n\nBody text.\n',
  'docs/runbooks/vpn-egress-box.md': '# VPN Egress Box\n\nRunbook.\n',
}

/** Builds a fixture repo, generates into a temp outDir, and returns a page reader. */
function run(files: Record<string, string> = {}, sha = SHA) {
  const repoRoot = tempDir()
  const outDir = tempDir()
  for (const [path, text] of Object.entries({...BASE_FILES, ...files})) {
    mkdirSync(dirname(join(repoRoot, path)), {recursive: true})
    writeFileSync(join(repoRoot, path), text)
  }
  const result = generateContent({repoRoot, outDir, sha})
  const page = (slug: string): string => readFileSync(join(outDir, `${slug}.md`), 'utf8')
  return {result, page, outDir, repoRoot}
}

function expectFailure(files: Record<string, string>): string {
  try {
    run(files)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected generateContent to throw')
}

function body(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')
}

describe('generateContent: page model', () => {
  it('maps sources to routes and strips the H1 into a Starlight title', () => {
    const {page, result} = run()
    expect(result.pages).toEqual(
      expect.arrayContaining([
        'architecture/overview',
        'architecture/structure',
        'guides/vpn',
        'runbooks/vpn-egress-box',
        'solutions/index',
      ]),
    )
    const vpn = page('guides/vpn')
    expect(vpn.startsWith('---\ntitle: "VPN Deploy Package"\n---\n')).toBe(true)
    expect(body(vpn)).toBe('Body text.\n')
    expect(page('runbooks/vpn-egress-box')).toContain('title: "VPN Egress Box"')
  })

  it('writes .md only and never MDX', () => {
    const {outDir} = run()
    const files = readdirSync(outDir, {recursive: true, withFileTypes: true}).filter(entry => entry.isFile())
    expect(files.length).toBeGreaterThan(0)
    expect(files.every(entry => entry.name.endsWith('.md'))).toBe(true)
  })

  it('quotes titles so YAML-special characters survive', () => {
    const {page} = run({'apps/vpn/AGENTS.md': '# Colon: "quoted" #hash `code`\n\nBody.\n'})
    expect(page('guides/vpn')).toContain(String.raw`title: "Colon: \"quoted\" #hash code"`)
  })

  it('removes only the first H1 and ignores a # line inside a fence', () => {
    const {page} = run({'apps/vpn/AGENTS.md': '```sh\n# not a title\n```\n\n# Real Title\n\n# Second\n'})
    const vpn = page('guides/vpn')
    expect(vpn).toContain('title: "Real Title"')
    expect(body(vpn)).toContain('# not a title')
    expect(body(vpn)).toContain('# Second')
    expect(body(vpn)).not.toContain('Real Title')
  })

  it('removes stale generated pages from earlier runs', () => {
    const repoRoot = tempDir()
    const outDir = tempDir()
    for (const [path, text] of Object.entries(BASE_FILES)) {
      mkdirSync(dirname(join(repoRoot, path)), {recursive: true})
      writeFileSync(join(repoRoot, path), text)
    }
    mkdirSync(join(outDir, 'runbooks'), {recursive: true})
    writeFileSync(join(outDir, 'runbooks/old.md'), 'stale')
    writeFileSync(join(outDir, 'index.md'), 'committed index')
    generateContent({repoRoot, outDir, sha: SHA})
    expect(existsSync(join(outDir, 'runbooks/old.md'))).toBe(false)
    expect(readFileSync(join(outDir, 'index.md'), 'utf8')).toBe('committed index')
  })
})

describe('generateContent: link rewriting', () => {
  const linkPage = (markdown: string, path = 'apps/vpn/AGENTS.md', slug = 'guides/vpn') =>
    body(run({[path]: `# T\n\n${markdown}\n`}).page(slug)).trim()

  it('rewrites a rendered runbook link to a site route', () => {
    expect(linkPage('[rb](../../docs/runbooks/vpn-egress-box.md)')).toBe('[rb](/infra/runbooks/vpn-egress-box/)')
  })

  it('preserves anchors on rendered targets and leaves in-page anchors alone', () => {
    expect(linkPage('[a](../../docs/runbooks/vpn-egress-box.md#bootstrap) and [b](#local)')).toBe(
      '[a](/infra/runbooks/vpn-egress-box/#bootstrap) and [b](#local)',
    )
    expect(linkPage('[s](../../STRUCTURE.md#layout)')).toBe('[s](/infra/architecture/structure/#layout)')
    expect(linkPage('[g](../../apps/vpn/AGENTS.md#iam-note)')).toBe('[g](/infra/guides/vpn/#iam-note)')
  })

  it('resolves sibling runbook links relative to the runbook', () => {
    const {page} = run({
      'docs/runbooks/a.md': '# A\n\n[b](b.md#x) [arch](../../ARCHITECTURE.md) [vpn](../../apps/vpn/AGENTS.md)\n',
      'docs/runbooks/b.md': '# B\n',
    })
    expect(body(page('runbooks/a')).trim()).toBe(
      '[b](/infra/runbooks/b/#x) [arch](/infra/architecture/overview/) [vpn](/infra/guides/vpn/)',
    )
  })

  it('rewrites other repo links to GitHub blob URLs at the build SHA', () => {
    expect(linkPage('[p](../../docs/plans/x.md)')).toBe(`[p](${BLOB}/docs/plans/x.md)`)
    expect(linkPage('[s](../../docs/solutions/best-practices/y-2026-06-20.md#why)')).toBe(
      `[s](${BLOB}/docs/solutions/best-practices/y-2026-06-20.md#why)`,
    )
  })

  it('sends README links to GitHub blob URLs', () => {
    expect(linkPage('[r](../../apps/dashboard/README.md) [root](../../README.md)')).toBe(
      `[r](${BLOB}/apps/dashboard/README.md) [root](${BLOB}/README.md)`,
    )
  })

  it('resolves nested directory links against the source file', () => {
    expect(linkPage('[e](evidence/retention/TEMPLATE.md)')).toBe(`[e](${BLOB}/apps/vpn/evidence/retention/TEMPLATE.md)`)
    expect(linkPage('[e](../../apps/umami/evidence/retention/README.md)', 'docs/runbooks/a.md', 'runbooks/a')).toBe(
      `[e](${BLOB}/apps/umami/evidence/retention/README.md)`,
    )
  })

  it('handles titles, images, angle destinations and reference definitions', () => {
    expect(linkPage('[p](../../docs/plans/x.md "Plan")')).toBe(`[p](${BLOB}/docs/plans/x.md "Plan")`)
    expect(linkPage('![img](../../docs/img.png)')).toBe(`![img](${BLOB}/docs/img.png)`)
    expect(linkPage('[p](<../../docs/plans/x.md>)')).toBe(`[p](<${BLOB}/docs/plans/x.md>)`)
    expect(linkPage('[ref]: ../../docs/runbooks/vpn-egress-box.md\n\n[x][ref]')).toBe(
      '[ref]: /infra/runbooks/vpn-egress-box/\n\n[x][ref]',
    )
  })

  it('leaves absolute, mailto and autolinks unchanged', () => {
    const text = '[a](https://example.com/x.md) [m](mailto:a@example.com) <https://example.com/y> [p](//cdn.example/x)'
    expect(linkPage(text)).toBe(text)
  })

  it('never rewrites links inside inline code or fenced code', () => {
    const text = [
      'Inline `[x](../../docs/plans/x.md)` and ``double `tick` [y](../../docs/runbooks/missing.md)`` stay.',
      '',
      '1. Step',
      '',
      '   ```md',
      '   [z](../../docs/plans/z.md) <vpc-ip>',
      '   ```',
      '',
      '~~~',
      '[t](../../docs/runbooks/missing.md)',
      '~~~',
      '',
      '> ```',
      '> [q](../../docs/plans/q.md)',
      '> ```',
      '',
      '[real](../../docs/plans/real.md)',
    ].join('\n')
    const out = linkPage(text)
    expect(out).toBe(text.replace('[real](../../docs/plans/real.md)', `[real](${BLOB}/docs/plans/real.md)`))
  })

  it('treats a fence as closed only by a matching fence', () => {
    const text = '````md\n```\n[x](../../docs/plans/x.md)\n```\n````\n\n[after](../../docs/plans/a.md)'
    expect(linkPage(text)).toBe(text.replace('(../../docs/plans/a.md)', `(${BLOB}/docs/plans/a.md)`))
  })
})

describe('generateContent: placeholders', () => {
  it('escapes tag-like placeholders outside code and keeps code verbatim', () => {
    const {page} = run({
      'apps/vpn/AGENTS.md': [
        '# VPN',
        '',
        'Set <vpc-ip> and <bucket>/<prefix> here; keep `<vpc-ip>` and:',
        '',
        '```sh',
        'ssh <vpc-ip>',
        '```',
        '',
        'Autolink <https://example.com/x> and <me@example.com> and a < b stay.',
        '',
      ].join('\n'),
    })
    const out = body(page('guides/vpn'))
    expect(out).toContain('Set &lt;vpc-ip> and &lt;bucket>/&lt;prefix> here;')
    expect(out).toContain('keep `<vpc-ip>`')
    expect(out).toContain('ssh <vpc-ip>')
    expect(out).toContain('<https://example.com/x> and <me@example.com> and a < b stay.')
    expect(out).not.toContain('Set <vpc-ip>')
  })

  it('renders escaped placeholders as visible text (CommonMark would swallow the raw tag)', () => {
    const {page} = run({'apps/vpn/AGENTS.md': '# VPN\n\nBind <vpc-ip>:9300 and `<vpc-ip>`.\n'})
    const html = Bun.markdown.html(body(page('guides/vpn')))
    expect(html).toContain('Bind &lt;vpc-ip&gt;:9300')
    expect(html).toContain('<code>&lt;vpc-ip&gt;</code>')
    expect(html).not.toContain('<vpc-ip>')
    // Control: the unescaped source loses the text, which is why the generator escapes it.
    expect(Bun.markdown.html('Bind <vpc-ip>:9300')).toContain('<vpc-ip>')
  })

  it('does not touch the destination of a link when escaping', () => {
    const {page} = run({'apps/vpn/AGENTS.md': '# VPN\n\n[<vpc-ip>](https://example.com/a)\n'})
    expect(body(page('guides/vpn')).trim()).toBe('[&lt;vpc-ip>](https://example.com/a)')
  })
})

describe('generateContent: failures', () => {
  it('fails a source with no H1, naming the file', () => {
    const message = expectFailure({'apps/vpn/AGENTS.md': 'No heading here.\n\n## Only h2\n'})
    expect(message).toContain('apps/vpn/AGENTS.md')
    expect(message).toMatch(/H1/)
  })

  it('does not count a # inside a fence as the H1', () => {
    const message = expectFailure({'apps/vpn/AGENTS.md': '```sh\n# comment\n```\n'})
    expect(message).toContain('apps/vpn/AGENTS.md')
  })

  it('fails a link to a missing rendered runbook, naming file and line', () => {
    const message = expectFailure({
      'apps/vpn/AGENTS.md': '# VPN\n\nok\n\nSee [gone](../../docs/runbooks/gone.md#x) now.\n',
    })
    expect(message).toContain('apps/vpn/AGENTS.md:5')
    expect(message).toContain('docs/runbooks/gone.md')
  })

  it('fails links to a missing guide or architecture page', () => {
    const message = expectFailure({
      'docs/runbooks/a.md': '# A\n\n[g](../../apps/nope/AGENTS.md)\n\n[s](../../STRUCTURE.md)\n',
      'STRUCTURE.md': '# Structure\n\n[a](../ARCHITECTURE.md)\n',
    })
    expect(message).toContain('docs/runbooks/a.md:3')
    expect(message).toContain('STRUCTURE.md:3')
  })

  it('reports every broken link, not just the first', () => {
    const message = expectFailure({
      'docs/runbooks/a.md': '# A\n\n[x](gone-1.md)\n\n[y](gone-2.md)\n',
    })
    expect(message).toContain('docs/runbooks/a.md:3')
    expect(message).toContain('docs/runbooks/a.md:5')
  })

  it('does not fail on a broken-looking link inside code', () => {
    expect(() => run({'docs/runbooks/a.md': '# A\n\n`[x](gone.md)`\n\n```\n[y](gone.md)\n```\n'})).not.toThrow()
  })

  it('fails a link that escapes the repository', () => {
    const message = expectFailure({'docs/runbooks/a.md': '# A\n\n[x](../../../etc/passwd)\n'})
    expect(message).toContain('docs/runbooks/a.md:3')
  })
})

describe('generateContent: solutions index', () => {
  const solution = (extra = '') =>
    `---\ntitle: "Example fix"\ndate: 2026-06-20\nproblem_type: best_practice\ncomponent: tooling\nseverity: low\nmodule: infra\n${extra}---\n\n# Example\n`

  it('builds the index from validated frontmatter and links to blobs at the SHA', () => {
    const {page} = run({
      'docs/solutions/best-practices/example-2026-06-20.md': solution(),
      'docs/solutions/best-practices/newer-2026-07-01.md': solution()
        .replace('2026-06-20', '2026-07-01')
        .replace('Example fix', 'Newer | <fix>'),
    })
    const index = page('solutions/index')
    expect(index).toContain('title: "Solutions"')
    expect(index).toContain(`[Example fix](${BLOB}/docs/solutions/best-practices/example-2026-06-20.md)`)
    expect(index).toContain('2026-06-20')
    expect(index).toContain('`infra`')
    expect(index).toContain('best_practice')
    expect(index.indexOf('Newer')).toBeLessThan(index.indexOf('Example fix'))
    expect(index).toContain(String.raw`Newer \| &lt;fix>`)
  })

  it('does not render individual solution docs', () => {
    const {outDir} = run({'docs/solutions/best-practices/example-2026-06-20.md': solution()})
    expect(readdirSync(join(outDir, 'solutions'))).toEqual(['index.md'])
  })

  it('still renders an index when there are no solutions', () => {
    expect(run().page('solutions/index')).toContain('title: "Solutions"')
  })

  it('fails the build on invalid frontmatter and names the file', () => {
    const message = expectFailure({
      'docs/solutions/best-practices/bad-2026-06-20.md': solution().replace('severity: low', 'severity: meh'),
    })
    expect(message).toContain('docs/solutions/best-practices/bad-2026-06-20.md: severity')
  })

  it('does not list a doc with invalid frontmatter', () => {
    const repoRoot = tempDir()
    const outDir = tempDir()
    mkdirSync(join(repoRoot, 'docs/solutions/best-practices'), {recursive: true})
    for (const [path, text] of Object.entries(BASE_FILES)) {
      mkdirSync(dirname(join(repoRoot, path)), {recursive: true})
      writeFileSync(join(repoRoot, path), text)
    }
    writeFileSync(join(repoRoot, 'docs/solutions/best-practices/bad-2026-06-20.md'), 'no frontmatter\n')
    expect(() => generateContent({repoRoot, outDir, sha: SHA})).toThrow('missing YAML frontmatter')
    expect(existsSync(join(outDir, 'solutions/index.md'))).toBe(false)
  })
})

describe('resolveSha', () => {
  it('prefers GITHUB_SHA', () => {
    expect(resolveSha({GITHUB_SHA: 'deadbeef'}, REPO_ROOT)).toBe('deadbeef')
  })

  it('falls back to git rev-parse HEAD', () => {
    expect(resolveSha({}, REPO_ROOT)).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('generateContent: real repo', () => {
  it('renders every guide, runbook and architecture page without broken links', () => {
    const outDir = tempDir()
    const {pages} = generateContent({repoRoot: REPO_ROOT, outDir, sha: SHA})
    const apps = readdirSync(join(REPO_ROOT, 'apps')).filter(app =>
      existsSync(join(REPO_ROOT, 'apps', app, 'AGENTS.md')),
    )
    const runbooks = readdirSync(join(REPO_ROOT, 'docs/runbooks')).filter(name => name.endsWith('.md'))
    expect(pages.filter(slug => slug.startsWith('guides/')).toSorted()).toEqual(
      apps.map(app => `guides/${app}`).toSorted(),
    )
    expect(pages).toContain('guides/agent')
    expect(pages.filter(slug => slug.startsWith('runbooks/'))).toHaveLength(runbooks.length)
    expect(pages).toEqual(
      expect.arrayContaining(['architecture/overview', 'architecture/structure', 'solutions/index']),
    )
    expect(body(readFileSync(join(outDir, 'guides/vpn.md'), 'utf8'))).not.toMatch(/^# /m)
  })
})
