import {describe, expect, it} from 'bun:test'

const manifestText = await Bun.file(new URL('builder-config.yaml', import.meta.url)).text()
const dockerfileText = await Bun.file(new URL('Dockerfile', import.meta.url)).text()

const otelcolUrl = new URL('../config/otelcol.yaml', import.meta.url)
const otelcolPresent = await Bun.file(otelcolUrl).exists()
// Unit 1 writes this file in parallel with Unit 2. Until it lands the cross-check is skipped, and the skip says so in
// the test name; the manifest-only assertions below still pin the component set.
const otelcolText = otelcolPresent ? await Bun.file(otelcolUrl).text() : ''

const SECTIONS = ['receivers', 'exporters', 'connectors', 'extensions', 'processors'] as const
type Section = (typeof SECTIONS)[number]

const CORE_PREFIX = 'go.opentelemetry.io/collector/'
const CONTRIB_PREFIX = 'github.com/open-telemetry/opentelemetry-collector-contrib/'

interface ManifestComponent {
  readonly section: Section
  readonly module: string
  readonly version: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the builder manifest into one entry per `gomod` line, failing on any shape the builder would reject. */
function parseManifest(text: string): ManifestComponent[] {
  const doc: unknown = Bun.YAML.parse(text)
  if (!isRecord(doc)) throw new Error('manifest is not a mapping')
  const components: ManifestComponent[] = []
  for (const section of SECTIONS) {
    const entries = doc[section]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) throw new Error(`${section} is not a list`)
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.gomod !== 'string') throw new Error(`${section}: entry has no gomod string`)
      const [, module, version] = /^(\S+) (v\d+\.\d+\.\d+)$/.exec(entry.gomod) ?? []
      if (module === undefined || version === undefined) {
        throw new Error(`${section}: gomod must be "<module> v<semver>": ${entry.gomod}`)
      }
      components.push({section, module, version})
    }
  }
  return components
}

/**
 * Version-set problems in a manifest, empty when the set is coherent: the core components share one version, the
 * contrib components share one version, and contrib equals core (the two repositories release in lockstep).
 * Elastic's processor carries its own version line and is not compared.
 */
function findVersionSkew(components: readonly ManifestComponent[]): string[] {
  const problems: string[] = []
  const versionsOf = (prefix: string): string[] => [
    ...new Set(components.filter(c => c.module.startsWith(prefix)).map(c => c.version)),
  ]
  const core = versionsOf(CORE_PREFIX)
  const contrib = versionsOf(CONTRIB_PREFIX)
  if (core.length > 1) problems.push(`core components carry different versions: ${core.join(', ')}`)
  if (contrib.length > 1) problems.push(`contrib components carry different versions: ${contrib.join(', ')}`)
  if (core.length === 1 && contrib.length === 1 && core[0] !== contrib[0]) {
    problems.push(`contrib ${contrib[0]} does not match core ${core[0]}`)
  }
  return problems
}

/** Component type (the part of an id before `/`) for every id in a service-level config section. */
function configTypes(config: unknown, section: Section): Set<string> {
  if (!isRecord(config)) throw new Error('otelcol config is not a mapping')
  const block = config[section]
  if (block === undefined) return new Set()
  if (!isRecord(block)) throw new Error(`otelcol ${section} is not a mapping`)
  return new Set(Object.keys(block).map(id => id.split('/', 1).join('')))
}

// The components the plan names, by collector component type. The test pins this table so a component slipped into
// the manifest (or dropped from it) without a matching config change fails here, not at first deploy.
const EXPECTED = {
  receivers: {otlp: 'go.opentelemetry.io/collector/receiver/otlpreceiver'},
  exporters: {otlp_http: 'go.opentelemetry.io/collector/exporter/otlphttpexporter'},
  connectors: {forward: 'go.opentelemetry.io/collector/connector/forwardconnector'},
  extensions: {
    bearertokenauth: `${CONTRIB_PREFIX}extension/bearertokenauthextension`,
    file_storage: `${CONTRIB_PREFIX}extension/storage/filestorage`,
    health_check: `${CONTRIB_PREFIX}extension/healthcheckextension`,
  },
  processors: {
    ratelimit: 'github.com/elastic/opentelemetry-collector-components/processor/ratelimitprocessor',
    redaction: `${CONTRIB_PREFIX}processor/redactionprocessor`,
    resource: `${CONTRIB_PREFIX}processor/resourceprocessor`,
  },
} as const satisfies Record<Section, Record<string, string>>

/**
 * Differences between the component types a collector config defines and the ones the manifest builds, per section.
 * Only the top-level sections count: service.pipelines and service.extensions reference ids defined there.
 */
function findConfigMismatches(components: readonly ManifestComponent[], config: unknown): string[] {
  const problems: string[] = []
  for (const section of SECTIONS) {
    const used = configTypes(config, section)
    const built = new Set(
      components
        .filter(c => c.section === section)
        .map(c => Object.entries(EXPECTED[section]).find(([, module]) => module === c.module)?.[0] ?? c.module),
    )
    for (const type of used)
      if (!built.has(type)) problems.push(`${section}: config uses "${type}", manifest does not build it`)
    for (const type of built)
      if (!used.has(type)) problems.push(`${section}: manifest builds "${type}", config does not use it`)
  }
  return problems
}

const manifest = parseManifest(manifestText)

describe('collector builder manifest', () => {
  it('lists exactly the components the stack uses, each once', () => {
    for (const section of SECTIONS) {
      const actual = manifest
        .filter(c => c.section === section)
        .map(c => c.module)
        .sort()
      expect(actual, section).toEqual(Object.values(EXPECTED[section]).sort())
    }
  })

  it('carries one coherent version set: core, contrib and the builder', () => {
    expect(findVersionSkew(manifest)).toEqual([])
  })

  it('pins the builder to the core version', () => {
    const match = /^ARG OCB_VERSION=(?<version>v\d+\.\d+\.\d+)$/m.exec(dockerfileText)
    const builderVersion = match?.groups?.version
    if (builderVersion === undefined) throw new Error('Dockerfile has no OCB_VERSION ARG')
    const coreVersions = new Set(manifest.filter(c => c.module.startsWith(CORE_PREFIX)).map(c => c.version))
    expect([...coreVersions]).toEqual([builderVersion])
  })

  it('carries a Renovate-readable pin on every component line', () => {
    // The custom manager in .github/renovate.json5 reads `- gomod: <module> v<semver>` lines. A line it cannot match
    // would silently freeze that component while the rest of the group moved.
    const gomodLines = manifestText.split('\n').filter(line => line.trimStart().startsWith('- gomod:'))
    expect(gomodLines).toHaveLength(manifest.length)
    for (const line of gomodLines) expect(line).toMatch(/^ {2}- gomod: \S+ v\d+\.\d+\.\d+$/)
  })

  it('writes the binary to the directory the Dockerfile copies from', () => {
    const doc = Bun.YAML.parse(manifestText)
    if (!isRecord(doc) || !isRecord(doc.dist)) throw new Error('manifest has no dist block')
    const copy = /^COPY --from=build (?<source>\S+) /m.exec(dockerfileText)
    expect(copy?.groups?.source).toBe(`${String(doc.dist.output_path)}/${String(doc.dist.name)}`)
  })

  it.skipIf(!otelcolPresent)(
    otelcolPresent
      ? 'includes every component type apps/traces/config/otelcol.yaml uses, and nothing else'
      : 'SKIPPED: apps/traces/config/otelcol.yaml not present yet; re-run once Unit 1 lands',
    () => {
      expect(findConfigMismatches(manifest, Bun.YAML.parse(otelcolText))).toEqual([])
    },
  )
})

describe('findVersionSkew', () => {
  const ok: ManifestComponent[] = [
    {section: 'receivers', module: `${CORE_PREFIX}receiver/otlpreceiver`, version: 'v0.165.0'},
    {section: 'exporters', module: `${CORE_PREFIX}exporter/otlphttpexporter`, version: 'v0.165.0'},
    {section: 'processors', module: `${CONTRIB_PREFIX}processor/resourceprocessor`, version: 'v0.165.0'},
    {section: 'processors', module: 'github.com/elastic/x/ratelimitprocessor', version: 'v0.81.0'},
  ]

  it('accepts a coherent set and ignores the Elastic processor version', () => {
    expect(findVersionSkew(ok)).toEqual([])
  })

  it('fails when core components carry different versions', () => {
    const skewed = ok.map(c => (c.module.endsWith('otlphttpexporter') ? {...c, version: 'v0.164.0'} : c))
    expect(findVersionSkew(skewed)).toEqual(['core components carry different versions: v0.165.0, v0.164.0'])
  })

  it('fails when contrib components carry different versions', () => {
    const skewed = [
      ...ok,
      {section: 'processors', module: `${CONTRIB_PREFIX}processor/redactionprocessor`, version: 'v0.164.0'} as const,
    ]
    expect(findVersionSkew(skewed).join('\n')).toContain('contrib components carry different versions')
  })

  it('fails when contrib and core move apart', () => {
    const skewed = ok.map(c => (c.module.startsWith(CONTRIB_PREFIX) ? {...c, version: 'v0.166.0'} : c))
    expect(findVersionSkew(skewed)).toEqual(['contrib v0.166.0 does not match core v0.165.0'])
  })
})

describe('findConfigMismatches', () => {
  const config = (extra: Record<string, unknown> = {}): unknown => ({
    receivers: {'otlp/a': {}, 'otlp/b': {}},
    exporters: {'otlp_http/lf-a': {}},
    connectors: {forward: {}},
    extensions: {'bearertokenauth/a': {}, 'file_storage/q': {}, health_check: {}},
    processors: {'resource/a': {}, 'ratelimit/a': {}, 'redaction/keep': {}},
    ...extra,
  })

  it('accepts a config whose component types match the manifest, however many ids share a type', () => {
    expect(findConfigMismatches(manifest, config())).toEqual([])
  })

  it('reports a component the config uses and the manifest lacks', () => {
    const noRedaction = manifest.filter(c => !c.module.endsWith('redactionprocessor'))
    expect(findConfigMismatches(noRedaction, config())).toEqual([
      'processors: config uses "redaction", manifest does not build it',
    ])
  })

  it('reports a component the manifest builds and the config never uses', () => {
    expect(findConfigMismatches(manifest, config({connectors: {}}))).toEqual([
      'connectors: manifest builds "forward", config does not use it',
    ])
  })

  it('reports an unknown config type, such as a batch processor', () => {
    const withBatch = config({processors: {'resource/a': {}, 'ratelimit/a': {}, 'redaction/keep': {}, batch: {}}})
    expect(findConfigMismatches(manifest, withBatch)).toEqual([
      'processors: config uses "batch", manifest does not build it',
    ])
  })
})

describe('parseManifest', () => {
  it('rejects a gomod line without a semver version', () => {
    expect(() => parseManifest('receivers:\n  - gomod: example.com/x latest\n')).toThrow('gomod must be')
  })

  it('rejects an entry without gomod', () => {
    expect(() => parseManifest('receivers:\n  - import: example.com/x\n')).toThrow('no gomod string')
  })
})

describe('collector Dockerfile', () => {
  const stages = [...dockerfileText.matchAll(/^FROM (?:--platform=\S+ )?(?<image>\S+)(?: AS (?<alias>\S+))?$/gm)].map(
    m => ({image: m.groups?.image ?? '', alias: m.groups?.alias}),
  )

  it('has a builder stage and a final stage', () => {
    expect(stages).toHaveLength(2)
    expect(stages[0]?.alias).toBe('build')
  })

  it('pins every base image by tag and sha256 digest', () => {
    for (const {image} of stages) expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/)
  })

  it('runs as a non-root user and starts the single binary directly', () => {
    expect(dockerfileText).toMatch(/^USER (?!0\b|root\b)\S+$/m)
    expect(dockerfileText).toMatch(/^ENTRYPOINT \["\/otelcol-traces"\]$/m)
    // No RUN and no shell-form ENTRYPOINT/CMD in the final stage: the image has no shell to run them.
    const finalStage = dockerfileText.slice(dockerfileText.lastIndexOf('\nFROM '))
    expect(finalStage).not.toMatch(/^RUN /m)
    expect(finalStage).not.toMatch(/^(?:ENTRYPOINT|CMD) (?!\[)/m)
  })

  it('compiles statically for the target platform without a host Go toolchain in the final image', () => {
    expect(dockerfileText).toMatch(/CGO_ENABLED=0/)
    expect(dockerfileText).toMatch(/GOARCH=\$TARGETARCH/)
    expect(stages[1]?.image.startsWith('golang')).toBe(false)
  })
})
