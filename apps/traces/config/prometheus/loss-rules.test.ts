import {readFileSync} from 'node:fs'
import {describe, expect, it, setDefaultTimeout} from 'bun:test'

setDefaultTimeout(120_000)

// The four loss rules count a counter that is not exported until its first increment. `increase()` sees nothing on
// a series that goes absent, then 1, then flat, so each rule also reads "present now, absent 5 minutes ago", behind
// a guard that the target was scraped then. The increase half keeps its 30 minute window. `loss-rules.yml` mirrors those queries for `promtool test rules`, and
// `loss-rules.test.yml` holds the cases. Two things are checked here: the mirror is the Grafana rules (so the tested
// query is the deployed one), and promtool passes it.

const LOSS_RULES = ['CollectorExportFailures', 'IngestRefused503', 'TempoDiscards', 'TempoAttributeTruncation'] as const

const here = new URL('.', import.meta.url).pathname
const read = (path: string): string => readFileSync(`${here}${path}`, 'utf8')

type Rec = Record<string, unknown>

function record(value: unknown, label: string): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not a mapping`)
  return value as Rec
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a list`)
  return value as unknown[]
}

/** The query (`A`) of each Grafana rule, by title. */
function grafanaQueries(): Map<string, string> {
  const file = record(Bun.YAML.parse(read('../grafana/alerting/rules.yaml')), 'rules.yaml')
  const queries = new Map<string, string>()
  for (const group of list(file.groups, 'groups')) {
    for (const entry of list(record(group, 'group').rules, 'rules')) {
      const rule = record(entry, 'rule')
      const node = list(rule.data, 'data')
        .map(candidate => record(candidate, 'node'))
        .find(candidate => candidate.refId === 'A')
      queries.set(String(rule.title), String(record(node?.model, 'A.model').expr))
    }
  }
  return queries
}

function mirrorQueries(): Map<string, string> {
  const file = record(Bun.YAML.parse(read('loss-rules.yml')), 'loss-rules.yml')
  const queries = new Map<string, string>()
  for (const group of list(file.groups, 'groups')) {
    for (const entry of list(record(group, 'group').rules, 'rules')) {
      const rule = record(entry, 'rule')
      queries.set(String(rule.alert), String(rule.expr))
    }
  }
  return queries
}

describe('the loss rules mirror', () => {
  it('holds exactly the four loss rules, and no rule file is loaded by Prometheus', () => {
    expect([...mirrorQueries().keys()].sort()).toEqual([...LOSS_RULES].sort())
    expect(read('prometheus.yml')).not.toMatch(/^\s*rule_files:/m)
  })

  // The promtool cases test the mirror's query. If it differs from the Grafana rule, they test something not deployed.
  it.each(LOSS_RULES)('%s: the query is the Grafana rule query, character for character', title => {
    const grafana = grafanaQueries().get(title)
    expect(grafana).toBeDefined()
    expect(mirrorQueries().get(title)).toBe(grafana)
  })

  it('has cases for every rule that both fire and stay quiet', () => {
    const file = record(Bun.YAML.parse(read('loss-rules.test.yml')), 'loss-rules.test.yml')
    expect(file.rule_files).toEqual(['loss-rules.yml'])
    const checks = list(file.tests, 'tests').flatMap(entry =>
      list(record(entry, 'test').alert_rule_test, 'alert_rule_test').map(check => record(check, 'check')),
    )
    for (const title of LOSS_RULES) {
      const own = checks.filter(check => check.alertname === title)
      const fires = own.filter(check => list(check.exp_alerts, 'exp_alerts').length > 0)
      const quiet = own.filter(check => list(check.exp_alerts, 'exp_alerts').length === 0)
      expect({title, fires: fires.length > 0, quiet: quiet.length > 0}).toEqual({title, fires: true, quiet: true})
    }
    for (const check of checks) expect(LOSS_RULES as readonly string[]).toContain(String(check.alertname))
  })

  // Every query keeps the three parts of the idiom, so a rewrite that drops one fails here before it fails in promtool.
  it.each(LOSS_RULES)(
    '%s: reads the 30 minute increase, the series new in the last 5 minutes, and the 5 minute scrape guard',
    title => {
      const expr = mirrorQueries().get(title) ?? ''
      expect(expr).toMatch(/^\(.*increase\(.*\[30m\].*\) > 0\) or \(/)
      expect(expr).toContain(' unless ')
      expect(expr).toContain(' offset 5m')
      expect(expr).not.toContain(' offset 30m')
      expect(expr).toMatch(/and on\(\) \(up\{job="(?:otelcol|tempo)"\} offset 5m == 1\)\)$/)
      // A plain `+` between two vectors drops every series missing from one side.
      expect(expr).not.toMatch(/\)\)\s*\+\s*sum/)
    },
  )

  it('guards each rule with the scrape job of the metric it reads', () => {
    const queries = mirrorQueries()
    expect(queries.get('CollectorExportFailures')).toContain('up{job="otelcol"}')
    expect(queries.get('IngestRefused503')).toContain('up{job="otelcol"}')
    expect(queries.get('TempoDiscards')).toContain('up{job="tempo"}')
    expect(queries.get('TempoAttributeTruncation')).toContain('up{job="tempo"}')
    expect(queries.get('IngestRefused503')).toContain('http_route=""')
  })
})

// ─── promtool, in the pinned image ────────────────────────────────────────────

// The image under test is whatever docker-compose.yaml pins, so a Renovate bump changes what this runs. It is skipped
// when docker is not running or the image is not already local: it never pulls, and the container has no network.
function readComposePrometheusImage(): string {
  const compose = readFileSync(`${here}../../docker-compose.yaml`, 'utf8')
  const image = /^ {4}image: (prom\/prometheus:\S+@sha256:[0-9a-f]{64})$/m.exec(compose)?.[1]
  if (image === undefined) throw new Error('docker-compose.yaml does not pin a prom/prometheus image by tag and digest')
  return image
}

const prometheusImage = readComposePrometheusImage()

/** The exit code of a probe command; a machine with no `docker` binary reads as a failed probe. */
function probe(command: string[]): number {
  try {
    return Bun.spawnSync(command).exitCode
  } catch {
    return 127
  }
}

const dockerAvailable = probe(['docker', 'info']) === 0
const imageAvailable = dockerAvailable && probe(['docker', 'image', 'inspect', prometheusImage]) === 0
const integrationTest = dockerAvailable && imageAvailable ? it : it.skip

function promtool(...args: string[]): {exitCode: number; output: string} {
  const result = Bun.spawnSync([
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${here}:/w:ro`,
    '-w',
    '/w',
    '--entrypoint',
    'promtool',
    prometheusImage,
    ...args,
  ])
  return {exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}`}
}

describe('promtool in the pinned Prometheus image (needs docker and the image locally)', () => {
  integrationTest('accepts the mirror rules file', () => {
    const checked = promtool('check', 'rules', '/w/loss-rules.yml')
    expect({exitCode: checked.exitCode, output: checked.output}).toMatchObject({exitCode: 0})
    expect(checked.output).toContain('4 rules found')
  })

  integrationTest('passes every case: new series fire, old counts and the canary route do not', () => {
    const tested = promtool('test', 'rules', '/w/loss-rules.test.yml')
    expect({exitCode: tested.exitCode, output: tested.output}).toMatchObject({exitCode: 0})
    expect(tested.output).toContain('SUCCESS')
  })
})
