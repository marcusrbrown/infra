import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {afterEach, describe, expect, it} from 'bun:test'
import {
  buildReport,
  defang,
  extractHtml,
  formatAnnotation,
  formatFinding,
  loadConfig,
  parseAllowlist,
  parseTlds,
  runCli,
  scanDist,
  scanSource,
  scanText,
  type Finding,
  type GateConfig,
} from './redaction-gate'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const REAL = loadConfig()

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true})
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'redaction-gate-'))
  temps.push(dir)
  return dir
}

function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true})
    writeFileSync(join(root, path), content)
  }
}

/** The real secret rules and TLD list, with a fixture allowlist. */
function withAllowlist(allowlist: GateConfig['allowlist'] = []): GateConfig {
  return {...REAL, allowlist}
}

const NONE = withAllowlist()

function fixtureRepo(files: Record<string, string>): string {
  const root = tempDir()
  writeTree(root, files)
  return root
}

function fixtureDist(files: Record<string, string | Uint8Array>): string {
  const root = tempDir()
  writeTree(root, files)
  return root
}

function run(argv: string[], env: Record<string, string | undefined>, options: Parameters<typeof runCli>[3]) {
  let out = ''
  let err = ''
  const code = runCli(argv, env, {out: text => (out += text), err: text => (err += text)}, options)
  return {code, out, err}
}

// Secret-shaped fixtures are assembled at runtime so no scanner sees a literal token in this file.
const GITHUB_TOKEN = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('')
const JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
].join('.')

function scan(text: string, config: GateConfig = NONE, file = 'doc.md', scopePath = file): Finding[] {
  return scanText(config, file, scopePath, text)
}

function ipValues(text: string): string[] {
  return scan(text)
    .filter(finding => finding.kind === 'ip')
    .map(finding => finding.value)
}

function hostValues(text: string, config: GateConfig = NONE): string[] {
  return scan(text, config)
    .filter(finding => finding.kind === 'hostname')
    .map(finding => finding.value)
}

describe('IP findings', () => {
  it('fails a public IPv4, plain and defanged', () => {
    expect(ipValues('resolver 8.8.8.8')).toEqual(['8.8.8.8'])
    expect(ipValues('resolver 8.8.8[.]8')).toEqual(['8.8.8.8'])
    expect(ipValues('resolver 8[dot]8[dot]8[dot]8')).toEqual(['8.8.8.8'])
    expect(ipValues('resolver 8(.)8(dot)8[DOT]8')).toEqual(['8.8.8.8'])
  })

  it('passes private, loopback, unspecified and documentation IPv4', () => {
    for (const ip of ['10.116.0.3', '172.28.0.2', '127.0.0.1', '0.0.0.0', '203.0.113.5', '192.168.1.1']) {
      expect(ipValues(`host ${ip}:9300`)).toEqual([])
    }
  })

  it('fails a global IPv6 and passes ULA, link-local and loopback', () => {
    expect(ipValues('edge 2606:4700::1 here')).toEqual(['2606:4700::1'])
    expect(ipValues('edge [2606:4700::1]:443')).toEqual(['2606:4700::1'])
    for (const ip of ['fd00::1', 'fe80::1', '::1', '2001:db8::1']) expect(ipValues(`addr ${ip} ok`)).toEqual([])
  })

  it('unwraps IPv4-mapped IPv6 before classifying', () => {
    expect(ipValues('v4-mapped ::ffff:8.8.8.8')).toEqual(['::ffff:8.8.8.8'])
    expect(ipValues('v4-mapped ::ffff:10.0.0.1')).toEqual([])
  })

  it('does not treat versions, timestamps, MACs or C++ scopes as addresses', () => {
    const text = 'version 1.2.3 at 12:30:45 mac aa:bb:cc:dd:ee:ff std::vector Foo::Bar v1.2.3.4 1.2.3.4.5'
    expect(ipValues(text)).toEqual([])
  })

  it('reports the line of the address', () => {
    const [finding] = scan('one\ntwo\nconnect to 8.8.4.4 now\n')
    expect(finding).toEqual({kind: 'ip', value: '8.8.4.4', file: 'doc.md', line: 3})
  })
})

describe('hostname findings', () => {
  it('fails an unlisted host and names the file and line', () => {
    const findings = scan('intro\n\nDeploys to box.heatvision.co today.\n', NONE, 'apps/keeweb/AGENTS.md')
    expect(findings).toEqual([{kind: 'hostname', value: 'box.heatvision.co', file: 'apps/keeweb/AGENTS.md', line: 3}])
    expect(formatFinding(findings[0] as Finding)).toBe(
      'apps/keeweb/AGENTS.md:3: hostname box.heatvision.co is not on the allowlist',
    )
  })

  it('fails a defanged URL host in any case', () => {
    expect(hostValues('HXXPS://box[.]heatvision[.]co')).toEqual(['box.heatvision.co'])
    expect(hostValues('hxxp://box(dot)heatvision(.)co/path')).toEqual(['box.heatvision.co'])
    expect(hostValues('box%2Eheatvision.co')).toEqual(['box.heatvision.co'])
    expect(hostValues('url(data:image/svg+xml,%3Csvg xmlns=%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27')).toEqual([
      'www.w3.org',
    ])
  })

  it('finds URL hosts for http, https, ws, wss and protocol-relative forms', () => {
    const text = [
      'a http://one.heatvision.co/x',
      'b https://two.heatvision.co:8443/x',
      'c ws://three.heatvision.co',
      'd wss://four.heatvision.co/socket',
      'e <script src="//five.heatvision.co/a.js">',
    ].join('\n')
    expect(hostValues(text).toSorted()).toEqual([
      'five.heatvision.co',
      'four.heatvision.co',
      'one.heatvision.co',
      'three.heatvision.co',
      'two.heatvision.co',
    ])
  })

  it('finds bare hosts in prose and code', () => {
    expect(hostValues('run `ssh deploy@host.heatvision.co` first')).toEqual(['host.heatvision.co'])
    expect(hostValues('see (docs.github.com) and *.fro.bot, then ghcr.io/org/img:1.0')).toEqual([
      'docs.github.com',
      'fro.bot',
      'ghcr.io',
    ])
    expect(hostValues('path /etc/letsencrypt/live/box.heatvision.co/fullchain.pem')).toEqual(['box.heatvision.co'])
  })

  it('takes the host after URL userinfo and never prints the userinfo', () => {
    const findings = scan('clone https://admin:hunter2@evil.heatvision.co/x.git')
    expect(findings).toEqual([{kind: 'hostname', value: 'evil.heatvision.co', file: 'doc.md', line: 1}])
    const output = JSON.stringify([buildReport(findings), findings.map(formatAnnotation)])
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain('admin')
  })

  it('does not flag filenames, dotted identifiers, versions, SHAs or npm scopes', () => {
    const text = [
      'AGENTS.md deploy.sh lib.rs conftest.py package.json docker-compose.yaml eslint.config.ts',
      'process.env import.meta.dir console.log res.status Bun.write fs.readFileSync',
      'version 1.2.3 v7.x v0.130.1 gpt-5.5-fast 10.0.1 e.g. i.e. vx.y.z',
      'sha 0123456789abcdef0123456789abcdef01234567',
      'pkg `@bfra.me/eslint-config` and @bfra.me/tsconfig',
      'https://localhost:3000 http://gateway:9300 https://example.com https://svc.internal/x host.example.org',
      'wg0.conf umami.dump.list stage.retention.check docker-compose.yaml.new',
      'viewer.kind.cloud logger.info config.app',
    ].join('\n')
    expect(hostValues(text)).toEqual([])
  })

  it('does not take a host from the middle of a longer token', () => {
    expect(hostValues('box.heatvision.co.conf foo_bar.heatvision.co x-y.heatvision.co_z')).toEqual([])
  })

  it('passes an allowlisted host only inside its scope', () => {
    const config = withAllowlist([
      {host: 'www.w3.org', reason: 'xmlns in diagrams', scope: ['diagrams/*.html']},
      {host: 'github.com', reason: 'repo links', scope: ['**/*.md']},
    ])
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    expect(scanText(config, 'diagrams/a.html', 'diagrams/a.html', svg)).toEqual([])
    expect(scanText(config, 'pages/a.html', 'pages/a.html', svg).map(formatFinding)).toEqual([
      'pages/a.html:1: hostname www.w3.org is not on the allowlist',
    ])
    expect(scanText(config, 'apps/x/AGENTS.md', 'apps/x/AGENTS.md', 'https://github.com/o/r')).toEqual([])
    expect(scanText(config, 'a.html', 'a.html', 'https://github.com/o/r')).toHaveLength(1)
  })

  it('does not let one allowlisted host cover its siblings', () => {
    const config = withAllowlist([{host: 'fro.bot', reason: 'apex', scope: ['**/*.md']}])
    expect(hostValues('fro.bot and gateway.fro.bot', config)).toEqual(['gateway.fro.bot'])
  })
})

describe('secret findings', () => {
  it('reports a GitHub token by pattern ID only', () => {
    const findings = scan(`export TOKEN=${GITHUB_TOKEN}\n`)
    expect(findings).toEqual([{kind: 'secret', id: 'github-pat', file: 'doc.md', line: 1}])
    const rendered = [formatFinding, formatAnnotation].map(format => format(findings[0] as Finding)).join('\n')
    expect(rendered).toContain('github-pat')
    expect(rendered).not.toContain(GITHUB_TOKEN)
    expect(rendered).not.toContain(GITHUB_TOKEN.slice(4, 16))
  })

  it('reports a JWT by pattern ID only, with no host or IP findings from its segments', () => {
    const findings = scan(`Authorization: Bearer ${JWT}`)
    expect(findings.map(finding => finding.kind)).toEqual(['secret'])
    expect(findings.map(formatFinding).join('\n')).not.toContain('eyJ')
  })

  it('drops host and IP candidates that overlap a secret match (one finding per line and ID)', () => {
    const rules = [{id: 'test-secret', regex: /tok:[a-z0-9.]+/g, keywords: []}]
    const config: GateConfig = {...NONE, rules}
    const findings = scanText(
      config,
      'doc.md',
      'doc.md',
      'key tok:abc.heatvision.co and tok:8.8.8.8 and beside.heatvision.co',
    )
    expect(findings.map(formatFinding)).toEqual([
      'doc.md:1: secret pattern test-secret',
      'doc.md:1: hostname beside.heatvision.co is not on the allowlist',
    ])
  })

  it('still reports a host that sits on the same line as, but outside, a secret', () => {
    const findings = scan(`curl https://api.heatvision.co/cb?token=${JWT}`)
    expect(findings.map(finding => finding.kind).toSorted()).toEqual(['hostname', 'secret'])
    expect(findings.map(formatFinding).join('\n')).not.toContain(JWT.slice(0, 24))
  })

  it('does not flag a SHA, base64 inside an SVG data URI, or a three-part version', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
    const text = [
      'commit 0123456789abcdef0123456789abcdef01234567',
      `background: url("data:image/svg+xml;base64,${btoa(svg)}")`,
      'bun 1.2.3',
    ].join('\n')
    expect(scan(text)).toEqual([])
  })
})

describe('HTML extraction', () => {
  it('rejoins a hostname that syntax highlighting split across inline spans', () => {
    const html =
      '<pre><code><span style="c">ssh</span> <span>deploy@host</span><span>.heatvision</span><span>.co</span></code></pre>'
    const findings = scanText(NONE, 'p.html', 'p.html', html)
    expect(findings.map(finding => (finding.kind === 'hostname' ? finding.value : ''))).toEqual(['host.heatvision.co'])
  })

  it('does not fuse text across block elements', () => {
    expect(scanText(NONE, 'p.html', 'p.html', '<p>see box.heatvision.</p><p>co</p>')).toEqual([])
  })

  it('scans attribute values and decodes entities', () => {
    const html = '<a href="https://attr.heatvision.co/x" data-x="box&#46;heatvision&period;co">link</a>'
    const hosts = scanText(NONE, 'p.html', 'p.html', html).map(finding =>
      finding.kind === 'hostname' ? finding.value : '',
    )
    expect(hosts.toSorted()).toEqual(['attr.heatvision.co', 'box.heatvision.co'])
  })

  it('scans script bodies and comments verbatim', () => {
    const html = '<script>fetch("https://api.heatvision.co/v1")</script><!-- see ops.heatvision.co -->'
    const hosts = scanText(NONE, 'p.html', 'p.html', html).map(finding =>
      finding.kind === 'hostname' ? finding.value : '',
    )
    expect(hosts.toSorted()).toEqual(['api.heatvision.co', 'ops.heatvision.co'])
  })

  it('reports line numbers from the original HTML', () => {
    const html = '<!doctype html>\n<html>\n<body>\n<p>one</p>\n<p>8.8.8.8</p>\n</body>\n</html>\n'
    expect(scanText(NONE, 'p.html', 'p.html', html)).toEqual([{kind: 'ip', value: '8.8.8.8', file: 'p.html', line: 5}])
  })

  it('keeps the text of a plain view identical to the source', () => {
    expect(extractHtml('<p>hello</p>').text.trim()).toBe('hello')
    expect(defang('a[.]b').text).toBe('a.b')
    expect(defang('a[.]b').map).toEqual([0, 1, 4])
  })
})

describe('config validation', () => {
  const entry = {host: 'mrbro.dev', reason: 'site origin', scope: ['**/*.md']}

  it('accepts a well-formed allowlist', () => {
    expect(parseAllowlist([entry])).toEqual([entry])
  })

  it.each([
    ['a wildcard host', {...entry, host: '*.fro.bot'}],
    ['an uppercase host', {...entry, host: 'MrBro.dev'}],
    ['a single-label host', {...entry, host: 'localhost'}],
    ['an empty reason', {...entry, reason: ' '}],
    ['a missing reason', {host: 'mrbro.dev', scope: ['**/*.md']}],
    ['an empty scope', {...entry, scope: []}],
    ['a match-everything scope', {...entry, scope: ['**/*']}],
  ])('rejects %s', (_name, bad) => {
    expect(() => parseAllowlist([bad])).toThrow()
  })

  it('rejects a TLD that is also a file extension', () => {
    expect(() => parseTlds({tlds: ['com', 'sh'], fileExtensions: ['sh']})).toThrow(/sh/)
  })

  it('loads the committed config with a reason on every allowlist entry', () => {
    expect(REAL.rules.length).toBeGreaterThan(150)
    expect(REAL.allowlist.length).toBeGreaterThan(0)
    for (const entry of REAL.allowlist) expect(entry.reason.length).toBeGreaterThan(10)
  })

  it('excludes the generic high-entropy rule', () => {
    expect(REAL.rules.some(rule => rule.id === 'generic-api-key')).toBe(false)
  })
})

describe('reporting', () => {
  const host = (n: number, line = 1): Finding => ({kind: 'hostname', value: `h${n}.heatvision.co`, file: 'a.md', line})

  it('deduplicates identical findings', () => {
    const report = buildReport([host(1), host(1), host(1, 2)])
    expect(report.total).toBe(2)
  })

  it('caps the printed findings at 50 and says how many were hidden', () => {
    const report = buildReport(Array.from({length: 60}, (_, n) => host(n)))
    expect(report.total).toBe(60)
    expect(report.lines).toHaveLength(51)
    expect(report.lines.at(-1)).toContain('10 more')
    expect(report.annotations).toHaveLength(50)
    expect(report.summary).toBe('redaction gate: 60 findings')
  })

  it('formats annotations with escaped properties and the same masking', () => {
    expect(formatAnnotation({kind: 'ip', value: '8.8.8.8', file: 'a,b:c.md', line: 7})).toBe(
      '::error file=a%2Cb%3Ac.md,line=7::globally reachable IP 8.8.8.8',
    )
    expect(formatAnnotation({kind: 'secret', id: 'github-pat', file: 'a.md', line: 2})).toBe(
      '::error file=a.md,line=2::secret pattern github-pat',
    )
  })
})

describe('source pass', () => {
  it('scans exactly the rendered files and reports real line numbers', () => {
    const root = fixtureRepo({
      'ARCHITECTURE.md': '# Architecture\n\nok\n',
      'STRUCTURE.md': '# Structure\n\n\n\nDeploys to a.heatvision.co\n',
      'apps/vpn/AGENTS.md': '# VPN\n\ndns 8.8.8.8\n',
      'docs/runbooks/rotate.md': '# Rotate\n\n```sh\nssh deploy@b.heatvision.co\n```\n',
      'README.md': '# Readme\n\nnot rendered: c.heatvision.co\n',
      'docs/brainstorms/idea.md': '# Idea\n\nnot rendered: d.heatvision.co\n',
    })
    const findings = scanSource(NONE, root)
    expect(findings.map(formatFinding)).toEqual([
      'STRUCTURE.md:5: hostname a.heatvision.co is not on the allowlist',
      'apps/vpn/AGENTS.md:3: globally reachable IP 8.8.8.8',
      'docs/runbooks/rotate.md:4: hostname b.heatvision.co is not on the allowlist',
    ])
  })

  it('scans solution frontmatter titles, and nothing else in a solution', () => {
    const root = fixtureRepo({
      'ARCHITECTURE.md': '# A\n',
      'docs/solutions/fix.md':
        '---\ntitle: Rotating the e.heatvision.co key\ndate: 2026-01-01\nmodule: infra\nproblem_type: ops\n---\n\n# Body\n\nbody mentions f.heatvision.co\n',
    })
    expect(scanSource(NONE, root).map(formatFinding)).toEqual([
      'docs/solutions/fix.md:2: hostname e.heatvision.co is not on the allowlist',
    ])
  })

  it('scans diagram specs', () => {
    const root = fixtureRepo({
      'ARCHITECTURE.md': '# A\n',
      'apps/docs/diagrams/apps/vpn.architecture.json': '{\n  "label": "egress 8.8.4.4"\n}\n',
    })
    expect(scanSource(NONE, root).map(formatFinding)).toEqual([
      'apps/docs/diagrams/apps/vpn.architecture.json:2: globally reachable IP 8.8.4.4',
    ])
  })

  it('passes a clean fixture', () => {
    const root = fixtureRepo({'ARCHITECTURE.md': '# A\n\nSee `10.116.0.3` and AGENTS.md.\n'})
    expect(scanSource(NONE, root)).toEqual([])
  })
})

describe('dist pass', () => {
  it('scans text files of any extension', () => {
    const dist = fixtureDist({
      'index.html': '<p>fine</p>',
      'notes.weirdext': 'resolver 8.8.8.8\nand h.heatvision.co\n',
      'data.map': '{"x":"y.heatvision.co"}',
      noext: 'z.heatvision.co',
    })
    expect(scanDist(NONE, dist, 'dist').map(formatFinding).toSorted()).toEqual([
      'dist/data.map:1: hostname y.heatvision.co is not on the allowlist',
      'dist/noext:1: hostname z.heatvision.co is not on the allowlist',
      'dist/notes.weirdext:1: globally reachable IP 8.8.8.8',
      'dist/notes.weirdext:2: hostname h.heatvision.co is not on the allowlist',
    ])
  })

  it('matches allowlist scopes against dist-relative paths', () => {
    const config = withAllowlist([{host: 'www.w3.org', reason: 'xmlns', scope: ['diagrams/*.html']}])
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    const dist = fixtureDist({'diagrams/a.html': svg, 'other/b.html': svg})
    expect(scanDist(config, dist, 'dist').map(formatFinding)).toEqual([
      'dist/other/b.html:1: hostname www.w3.org is not on the allowlist',
    ])
  })

  it('fails binary files that are not on the image and font list, and allows the ones that are', () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81])
    const dist = fixtureDist({
      'logo.png': binary,
      'inter.woff2': binary,
      'favicon.ico': binary,
      'payload.bin': binary,
      'archive.tar.gz': new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
      noextension: binary,
    })
    expect(scanDist(NONE, dist, 'dist').map(formatFinding).toSorted()).toEqual([
      'dist/archive.tar.gz: binary file type .gz is not on the allowed list',
      'dist/noextension: binary file type (no extension) is not on the allowed list',
      'dist/payload.bin: binary file type .bin is not on the allowed list',
    ])
  })

  it('scans a text file even when it carries an image extension', () => {
    const dist = fixtureDist({'logo.png': 'z.heatvision.co'})
    expect(scanDist(NONE, dist, 'dist')).toHaveLength(1)
  })

  it('skips gzipped Pagefind fragments; their text is what the scanned HTML already contains', () => {
    const phrase = 'leaks to box.heatvision.co from 8.8.8.8'
    const fragment = Bun.gzipSync(
      new TextEncoder().encode(`pagefind_dcd${JSON.stringify({url: '/a/', content: phrase})}`),
    )
    const dist = fixtureDist({
      'a/index.html': `<main><p>${phrase}</p></main>`,
      'pagefind/fragment/en_abc.pf_fragment': fragment,
      'pagefind/index/en_abc.pf_index': fragment,
      'pagefind/pagefind.en_abc.pf_meta': fragment,
      'pagefind/wasm.en.pagefind': fragment,
    })
    const files = scanDist(NONE, dist, 'dist').map(finding => finding.file)
    expect(files.length).toBeGreaterThan(0)
    expect(new Set(files)).toEqual(new Set(['dist/a/index.html']))
  })

  it('does not skip a Pagefind-named file that is not gzip, or a gzip file outside pagefind/', () => {
    const dist = fixtureDist({
      'pagefind/fragment/en_x.pf_fragment': 'h.heatvision.co',
      'elsewhere/en_x.pf_fragment': Bun.gzipSync(new TextEncoder().encode('h.heatvision.co')),
    })
    expect(scanDist(NONE, dist, 'dist').map(formatFinding).toSorted()).toEqual([
      'dist/elsewhere/en_x.pf_fragment: binary file type .pf_fragment is not on the allowed list',
      'dist/pagefind/fragment/en_x.pf_fragment:1: hostname h.heatvision.co is not on the allowlist',
    ])
  })

  const realDist = resolve(import.meta.dir, '../dist')
  it.skipIf(!existsSync(join(realDist, 'pagefind')))(
    'real build: everything in a Pagefind fragment was already found in the scanned HTML',
    () => {
      const open = {...REAL, allowlist: []}
      const valuesOf = (text: string, scopePath: string): Set<string> =>
        new Set(
          scanText(open, scopePath, scopePath, text).map(finding =>
            finding.kind === 'secret' ? `secret:${finding.id}` : finding.kind === 'binary' ? '' : finding.value,
          ),
        )

      const fromHtml = new Set<string>()
      for (const path of new Bun.Glob('**/*.html').scanSync({cwd: realDist})) {
        for (const value of valuesOf(readFileSync(join(realDist, path), 'utf8'), path)) fromHtml.add(value)
      }
      expect(fromHtml.size).toBeGreaterThan(0)

      let fragments = 0
      for (const path of new Bun.Glob('pagefind/fragment/*.pf_fragment').scanSync({cwd: realDist})) {
        const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(readFileSync(join(realDist, path)))))
        const data = JSON.parse(text.slice('pagefind_dcd'.length)) as {content: string; meta?: Record<string, string>}
        const fragmentText = [data.content, ...Object.values(data.meta ?? {})].join('\n')
        for (const value of valuesOf(fragmentText, 'fragment.txt')) expect(fromHtml.has(value)).toBe(true)
        fragments++
      }
      expect(fragments).toBeGreaterThan(0)
    },
    60_000,
  )
})

describe('CLI', () => {
  const dirtyRepo = (): string => {
    const root = tempDir()
    writeTree(root, {'ARCHITECTURE.md': `# A\n\nresolver 8.8.8.8\ntoken ${GITHUB_TOKEN}\n`})
    return root
  }

  it('exits 0 when clean and 1 on any finding', () => {
    const clean = tempDir()
    writeTree(clean, {'ARCHITECTURE.md': '# A\n'})
    expect(run(['--source'], {}, {repoRoot: clean, config: NONE})).toMatchObject({
      code: 0,
      out: 'redaction gate: clean\n',
    })
    expect(run(['--source'], {}, {repoRoot: dirtyRepo(), config: NONE}).code).toBe(1)
  })

  it('prints values for IPs, pattern IDs for secrets, and annotations only under GitHub Actions', () => {
    const repoRoot = dirtyRepo()
    const quiet = run(['--source'], {}, {repoRoot, config: NONE})
    expect(quiet.out).toContain('ARCHITECTURE.md:3: globally reachable IP 8.8.8.8')
    expect(quiet.out).toContain('ARCHITECTURE.md:4: secret pattern github-pat')
    expect(quiet.out).not.toContain('::error')
    expect(quiet.out).not.toContain(GITHUB_TOKEN)

    const summaryFile = join(tempDir(), 'summary.md')
    const ci = run(['--source'], {GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile}, {repoRoot, config: NONE})
    expect(ci.out).toContain('::error file=ARCHITECTURE.md,line=3::globally reachable IP 8.8.8.8')
    expect(ci.out).toContain('::error file=ARCHITECTURE.md,line=4::secret pattern github-pat')
    const summary = readFileSync(summaryFile, 'utf8')
    expect(summary).toContain('github-pat')
    for (const output of [ci.out, ci.err, summary]) expect(output).not.toContain(GITHUB_TOKEN)
  })

  it('scans a dist directory', () => {
    const dist = tempDir()
    writeTree(dist, {'index.html': '<p>8.8.8.8</p>'})
    const result = run(['--dist', dist], {}, {config: NONE})
    expect(result.code).toBe(1)
    expect(result.out).toContain('index.html:1: globally reachable IP 8.8.8.8')
  })

  it('exits 2 on bad usage or a missing dist directory', () => {
    expect(run([], {}, {config: NONE}).code).toBe(2)
    expect(run(['--bogus'], {}, {config: NONE}).code).toBe(2)
    expect(run(['--dist'], {}, {config: NONE}).code).toBe(2)
    expect(run(['--dist', join(tempDir(), 'missing')], {}, {config: NONE}).code).toBe(2)
  })
})

describe('corpus', () => {
  it('the real repo sources pass the gate', () => {
    const findings = scanSource(REAL, REPO_ROOT)
    expect(findings.map(formatFinding)).toEqual([])
  })
})
