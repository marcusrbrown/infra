import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {afterEach, describe, expect, it} from 'bun:test'
import {
  APPS_SOURCE,
  check,
  composePath,
  EGRESS_SOURCE,
  extractNodeIds,
  fact,
  factKey,
  formatFindings,
  GATEWAY_OVERRIDE_SOURCE,
  GATEWAY_UPSTREAM_SOURCE,
  mergeGatewayFacts,
  parseComposeFacts,
  parseRunbookAnchors,
  parseWorkflowFacts,
  readAppFacts,
  readEgressFacts,
  readOverrideFacts,
  readRepoFacts,
  readSpecs,
  readUpstreamComposeFacts,
  repoFacts,
  runbookPath,
  SourceError,
  UPSTREAM_FETCH_SCRIPT,
  workflowPath,
  type DiagramEntry,
  type DriftTable,
  type Fact,
  type Finding,
  type NodeMapping,
  type SpecInput,
  type TableEntry,
} from './diagram-drift'

// Fixture-level tests for the pure checker and the source readers, then the real mapping table and the real-repo
// check at the bottom. Only the two "real export" sanity checks and the real-repo check read this repository.

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true})
})

function tempRoot(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'infra-drift-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), {recursive: true})
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

function run(specs: readonly SpecInput[], table: Record<string, TableEntry>, facts: Fact[]): Finding[] {
  return check({specs, table, facts: repoFacts(facts)})
}

function messages(findings: readonly Finding[]): string[] {
  return findings.map(finding => finding.message)
}

const UMAMI = composePath('umami')
const UMAMI_COMPOSE = `
services:
  umami:
    image: ghcr.io/umami-software/umami@sha256:${'a'.repeat(64)}
  db:
    image: postgres@sha256:${'b'.repeat(64)}
volumes:
  umami-db-data-pg18:
`
const UMAMI_ENTRY: DiagramEntry = {
  covers: [
    {kind: 'service', file: UMAMI},
    {kind: 'volume', file: UMAMI},
  ],
  nodes: {
    app: {facts: [fact.service(UMAMI, 'umami')]},
    db: {facts: [fact.service(UMAMI, 'db'), fact.volume(UMAMI, 'umami-db-data-pg18')]},
    visitor: {illustrative: 'an external person'},
  },
}
const UMAMI_SPEC: SpecInput = {name: 'apps-umami', nodeIds: ['app', 'db', 'visitor']}

describe('check: agreement', () => {
  it('returns no findings when specs, table and facts agree', () => {
    const findings = run([UMAMI_SPEC], {'apps-umami': UMAMI_ENTRY}, parseComposeFacts(UMAMI_COMPOSE, UMAMI))
    expect(formatFindings(findings)).toBe('')
  })

  it('accepts a not-drawn fact with a reason and an out-of-scope spec with a reason', () => {
    const entry: DiagramEntry = {
      ...UMAMI_ENTRY,
      notDrawn: [{fact: fact.service(UMAMI, 'redis'), reason: 'cache sidecar the diagram leaves out'}],
    }
    const facts = parseComposeFacts(UMAMI_COMPOSE.replace('volumes:', '  redis:\n    image: redis\nvolumes:'), UMAMI)
    const specs: SpecInput[] = [UMAMI_SPEC, {name: 'operator-path', error: 'unsupported type'}]
    const table = {'apps-umami': entry, 'operator-path': {outOfScope: 'no single structural source'}}
    expect(formatFindings(run(specs, table, facts))).toBe('')
  })
})

describe('AE1: direction 1 — a fact that is neither drawn nor not-drawn', () => {
  it('names the undrawn compose service', () => {
    const facts = parseComposeFacts(UMAMI_COMPOSE.replace('volumes:', '  redis:\n    image: redis\nvolumes:'), UMAMI)
    const findings = run([UMAMI_SPEC], {'apps-umami': UMAMI_ENTRY}, facts)
    expect(messages(findings)).toEqual([
      'apps-umami: compose service `redis` is neither drawn nor listed as not drawn.',
    ])
    expect(findings[0]).toMatchObject({diagram: 'apps-umami', subject: 'redis', direction: 'undrawn-fact'})
  })

  it('names an undrawn volume', () => {
    const facts = parseComposeFacts(
      UMAMI_COMPOSE.replace('umami-db-data-pg18:', 'umami-db-data-pg18:\n  extra:'),
      UMAMI,
    )
    expect(messages(run([UMAMI_SPEC], {'apps-umami': UMAMI_ENTRY}, facts))).toEqual([
      'apps-umami: compose volume `extra` is neither drawn nor listed as not drawn.',
    ])
  })
})

describe('AE2: direction 2 — a mapped fact that no longer exists', () => {
  const ROUTER = workflowPath('deploy.yaml')
  const routerText = (detectJob: string): string => `
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  ${detectJob}:
    runs-on: ubuntu-latest
    steps: []
  deploy-keeweb:
    needs: ${detectJob}
    uses: ./.github/workflows/deploy-keeweb.yaml
`
  const entry: DiagramEntry = {
    covers: [{kind: 'job', file: ROUTER}],
    nodes: {
      detect: {facts: [fact.job(ROUTER, 'detect-changes')]},
      reusable: {facts: [fact.job(ROUTER, 'deploy-keeweb')]},
    },
  }
  const spec: SpecInput = {name: 'deploy-pipeline', nodeIds: ['detect', 'reusable']}

  it('passes while the job exists', () => {
    const {facts} = parseWorkflowFacts(routerText('detect-changes'), ROUTER)
    expect(formatFindings(run([spec], {'deploy-pipeline': entry}, facts))).toBe('')
  })

  it('names the node, the workflow file and the missing job when the router renames it', () => {
    const {facts} = parseWorkflowFacts(routerText('detect-changed'), ROUTER)
    const findings = run([spec], {'deploy-pipeline': entry}, facts)
    expect(messages(findings)).toContain(
      'deploy-pipeline: node `detect` maps to `deploy.yaml` job `detect-changes`, which no longer exists.',
    )
    expect(findings.find(finding => finding.direction === 'missing-fact')).toMatchObject({
      diagram: 'deploy-pipeline',
      subject: 'detect',
    })
    // The renamed job is also undrawn.
    expect(messages(findings)).toContain(
      'deploy-pipeline: `deploy.yaml` job `detect-changed` is neither drawn nor listed as not drawn.',
    )
  })
})

describe('AE3: gateway facts come from the upstream compose plus the override', () => {
  const UP = GATEWAY_UPSTREAM_SOURCE
  const OV = GATEWAY_OVERRIDE_SOURCE
  const upstreamText = (extra = '', workspace = 'workspace'): string => `
name: fro-bot
services:
  gateway:
    image: g
  ${workspace}:
    image: w
  mitmproxy:
    image: m
${extra}
volumes:
  mitmproxy-certs:
  workspace-repos:
`
  const overrideText = `
services:
  gateway:
    image: g2
  workspace:
    image: w2
  caddy:
    image: c
volumes:
  caddy_data:
  caddy_config:
`
  const entry: DiagramEntry = {
    covers: [
      {kind: 'service', file: UP},
      {kind: 'volume', file: UP},
      {kind: 'service', file: OV},
      {kind: 'volume', file: OV},
    ],
    nodes: {
      gateway: {facts: [fact.service(UP, 'gateway')]},
      workspace: {facts: [fact.service(UP, 'workspace')]},
      mitm: {facts: [fact.service(UP, 'mitmproxy')]},
      certs: {facts: [fact.volume(UP, 'mitmproxy-certs')]},
      repos: {facts: [fact.volume(UP, 'workspace-repos')]},
      caddy: {
        facts: [fact.service(OV, 'caddy'), fact.volume(OV, 'caddy_data'), fact.volume(OV, 'caddy_config')],
      },
    },
  }
  const spec: SpecInput = {name: 'apps-gateway', nodeIds: Object.keys(entry.nodes)}
  const gatewayFacts = (upstream: string): Fact[] =>
    mergeGatewayFacts(parseComposeFacts(upstream, UP), parseComposeFacts(overrideText, OV))

  it('passes when the upstream and override match the diagram', () => {
    expect(formatFindings(run([spec], {'apps-gateway': entry}, gatewayFacts(upstreamText())))).toBe('')
  })

  it('does not treat an override service that merges into an upstream service as a new fact', () => {
    const facts = gatewayFacts(upstreamText())
    expect(facts.map(factKey)).not.toContain(factKey(fact.service(OV, 'workspace')))
    expect(facts.map(factKey)).toContain(factKey(fact.service(OV, 'caddy')))
  })

  it('names a service the upstream gains, and says how to fix it', () => {
    const findings = run([spec], {'apps-gateway': entry}, gatewayFacts(upstreamText('  sidecar:\n    image: s')))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain(
      'apps-gateway: upstream compose service `sidecar` is neither drawn nor listed as not drawn.',
    )
    expect(findings[0]?.message).toContain('apps/gateway/upstream.json')
    expect(findings[0]?.message).toContain('Fro Bot cannot push')
  })

  it('stays green when only an image or digest changes', () => {
    const facts = gatewayFacts(upstreamText().replaceAll('image: g', 'image: g@sha256:9'))
    expect(formatFindings(run([spec], {'apps-gateway': entry}, facts))).toBe('')
  })

  it('fails on an upstream rename while the override still declares the old name', () => {
    const findings = run([spec], {'apps-gateway': entry}, gatewayFacts(upstreamText('', 'sandbox')))
    const text = messages(findings).join('\n')
    expect(text).toContain('upstream compose service `sandbox` is neither drawn nor listed as not drawn')
    expect(text).toContain('override compose service `workspace`')
    expect(text).toContain('no table row claims it as an override fact')
    expect(text).toContain('node `workspace` maps to upstream compose service `workspace`, which no longer exists')
    expect(findings).toHaveLength(3)
  })

  it('accepts an override-only service only when an override row claims it', () => {
    const noCaddyRow: DiagramEntry = {
      ...entry,
      nodes: {...entry.nodes, caddy: {illustrative: 'wrongly illustrative'}},
    }
    const findings = run([spec], {'apps-gateway': noCaddyRow}, gatewayFacts(upstreamText()))
    expect(messages(findings).join('\n')).toContain('override compose service `caddy`')
  })
})

describe('AE4: every egress host must be drawn', () => {
  const entry: DiagramEntry = {
    covers: [{kind: 'egress-host', file: EGRESS_SOURCE}],
    nodes: {
      proxy: {facts: [fact.egressHost('a.example.test')]},
      catalog: {facts: [fact.egressHost('b.example.test'), fact.egressHost('c.example.test')]},
    },
  }
  const spec: SpecInput = {name: 'apps-gateway', nodeIds: ['proxy', 'catalog']}
  const hosts = ['a.example.test', 'b.example.test', 'c.example.test']

  it('passes when every host is drawn', () => {
    expect(formatFindings(run([spec], {'apps-gateway': entry}, readEgressFacts(hosts)))).toBe('')
  })

  it('names a new host that no node draws', () => {
    const findings = run([spec], {'apps-gateway': entry}, readEgressFacts([...hosts, 'd.example.test']))
    expect(messages(findings)).toEqual([
      'apps-gateway: egress host `d.example.test` is not drawn (egress hosts cannot be listed as not drawn).',
    ])
    expect(findings[0]?.direction).toBe('undrawn-fact')
  })

  it('fails closed when the egress list is empty', () => {
    expect(() => readEgressFacts([])).toThrow(SourceError)
  })
})

describe('AE5: direction 4 — a table row whose node is not in the spec', () => {
  it('names the stale row', () => {
    const entry: DiagramEntry = {
      covers: [{kind: 'service', file: UMAMI}],
      nodes: {...UMAMI_ENTRY.nodes, certs: {illustrative: 'removed from the spec'}},
    }
    const findings = run([UMAMI_SPEC], {'apps-umami': entry}, parseComposeFacts(UMAMI_COMPOSE, UMAMI))
    expect(messages(findings)).toEqual(['apps-umami: table row `certs` has no node in the spec.'])
    expect(findings[0]).toMatchObject({subject: 'certs', direction: 'orphan-row'})
  })
})

describe('AE6: structure-free changes stay green', () => {
  it('produces identical facts and zero findings when only an image digest changes', () => {
    const before = parseComposeFacts(UMAMI_COMPOSE, UMAMI)
    const after = parseComposeFacts(UMAMI_COMPOSE.replaceAll('a'.repeat(64), 'c'.repeat(64)), UMAMI)
    expect(after).toEqual(before)
    expect(formatFindings(run([UMAMI_SPEC], {'apps-umami': UMAMI_ENTRY}, after))).toBe('')
  })
})

describe('direction 3: a spec node that is neither mapped nor illustrative', () => {
  it('names the node', () => {
    const spec: SpecInput = {name: 'apps-umami', nodeIds: ['app', 'db', 'visitor', 'mystery']}
    const findings = run([spec], {'apps-umami': UMAMI_ENTRY}, parseComposeFacts(UMAMI_COMPOSE, UMAMI))
    expect(messages(findings)).toEqual(['apps-umami: node `mystery` is neither mapped nor listed as illustrative.'])
    expect(findings[0]?.direction).toBe('unmapped-node')
  })
})

describe('direction 5: conflicting table entries', () => {
  const facts = parseComposeFacts(UMAMI_COMPOSE, UMAMI)

  it('fails when two nodes claim the same fact', () => {
    const entry: DiagramEntry = {
      ...UMAMI_ENTRY,
      nodes: {...UMAMI_ENTRY.nodes, shadow: {facts: [fact.service(UMAMI, 'umami')]}},
    }
    const spec: SpecInput = {name: 'apps-umami', nodeIds: [...Object.keys(entry.nodes)]}
    const findings = run([spec], {'apps-umami': entry}, facts)
    expect(messages(findings)).toEqual(['apps-umami: compose service `umami` is claimed by nodes `app` and `shadow`.'])
    expect(findings[0]?.direction).toBe('conflict')
  })

  it('fails when a fact is both mapped and listed as not drawn', () => {
    const entry: DiagramEntry = {
      ...UMAMI_ENTRY,
      notDrawn: [{fact: fact.service(UMAMI, 'db'), reason: 'left out'}],
    }
    const findings = run([UMAMI_SPEC], {'apps-umami': entry}, facts)
    expect(messages(findings)).toEqual([
      'apps-umami: compose service `db` is both mapped (node `db`) and listed as not drawn.',
    ])
    expect(findings[0]?.direction).toBe('conflict')
  })

  it('fails on duplicate node ids in a spec', () => {
    const spec: SpecInput = {name: 'apps-umami', nodeIds: ['app', 'db', 'visitor', 'db']}
    const findings = run([spec], {'apps-umami': UMAMI_ENTRY}, facts)
    expect(messages(findings)).toEqual(['apps-umami: node id `db` appears more than once in the spec.'])
    expect(findings[0]?.direction).toBe('conflict')
  })
})

describe('table validity', () => {
  const facts = parseComposeFacts(UMAMI_COMPOSE, UMAMI)

  it('requires a non-empty reason on an illustrative node', () => {
    const entry: DiagramEntry = {...UMAMI_ENTRY, nodes: {...UMAMI_ENTRY.nodes, visitor: {illustrative: '  '}}}
    const findings = run([UMAMI_SPEC], {'apps-umami': entry}, facts)
    expect(messages(findings)).toEqual(['apps-umami: node `visitor` is illustrative but gives no reason.'])
    expect(findings[0]?.direction).toBe('table')
  })

  it('requires facts on a mapped node', () => {
    const entry: DiagramEntry = {...UMAMI_ENTRY, nodes: {...UMAMI_ENTRY.nodes, visitor: {facts: []}}}
    expect(messages(run([UMAMI_SPEC], {'apps-umami': entry}, facts))).toEqual([
      'apps-umami: node `visitor` maps to no facts.',
    ])
  })

  it('requires a non-empty reason on a not-drawn fact', () => {
    const entry: DiagramEntry = {
      ...UMAMI_ENTRY,
      notDrawn: [{fact: fact.service(UMAMI, 'redis'), reason: ''}],
    }
    const withRedis = parseComposeFacts(
      UMAMI_COMPOSE.replace('volumes:', '  redis:\n    image: redis\nvolumes:'),
      UMAMI,
    )
    const findings = run([UMAMI_SPEC], {'apps-umami': entry}, withRedis)
    expect(messages(findings)).toEqual(['apps-umami: not-drawn compose service `redis` gives no reason.'])
  })

  it('flags a not-drawn entry whose fact no longer exists', () => {
    const entry: DiagramEntry = {
      ...UMAMI_ENTRY,
      notDrawn: [{fact: fact.service(UMAMI, 'redis'), reason: 'left out'}],
    }
    const findings = run([UMAMI_SPEC], {'apps-umami': entry}, facts)
    expect(messages(findings)).toEqual([
      'apps-umami: not-drawn compose service `redis` no longer exists; remove the entry.',
    ])
    expect(findings[0]?.direction).toBe('stale-not-drawn')
  })

  it('requires a non-empty reason on an out-of-scope spec', () => {
    const findings = run([{name: 'operator-path', nodeIds: []}], {'operator-path': {outOfScope: ' '}}, facts)
    expect(messages(findings)).toEqual(['operator-path: out-of-scope entry gives no reason.'])
  })

  it('fails a spec with no table entry and a table entry with no spec', () => {
    const findings = run(
      [UMAMI_SPEC, {name: 'extra', nodeIds: []}],
      {'apps-umami': UMAMI_ENTRY, ghost: {outOfScope: 'x'}},
      facts,
    )
    expect(findings.map(finding => `${finding.diagram}:${finding.direction}`).toSorted()).toEqual([
      'extra:unlisted-spec',
      'ghost:orphan-entry',
    ])
    expect(messages(findings).join('\n')).toContain('extra: diagram spec has no table entry')
    expect(messages(findings).join('\n')).toContain('ghost: table entry has no diagram spec')
  })

  it('reports a spec that could not be read', () => {
    const findings = run([{name: 'apps-umami', error: 'not valid JSON'}], {'apps-umami': UMAMI_ENTRY}, facts)
    expect(messages(findings)).toEqual(['apps-umami: spec could not be read: not valid JSON.'])
    expect(findings[0]?.direction).toBe('spec')
  })

  it('fails a declared no-compose app that gains a compose file', () => {
    const keeweb = composePath('keeweb')
    const entry: DiagramEntry = {
      covers: [],
      noCompose: {app: 'keeweb', reason: 'static site, rsync deploy'},
      nodes: {site: {illustrative: 'no compose file defines it'}},
    }
    const spec: SpecInput = {name: 'apps-keeweb', nodeIds: ['site']}
    expect(formatFindings(run([spec], {'apps-keeweb': entry}, []))).toBe('')
    const findings = run([spec], {'apps-keeweb': entry}, parseComposeFacts(UMAMI_COMPOSE, keeweb))
    expect(messages(findings)).toEqual([
      `apps-keeweb: app \`keeweb\` is declared to have no compose file, but \`${keeweb}\` exists.`,
    ])
    expect(findings[0]?.direction).toBe('table')
  })
})

describe('source failures never pass (R14)', () => {
  it('fails when a covered compose file is missing', () => {
    const findings = run([UMAMI_SPEC], {'apps-umami': UMAMI_ENTRY}, [])
    expect(findings.map(finding => finding.direction)).toContain('source')
    expect(messages(findings).join('\n')).toContain(`source \`${UMAMI}\` is missing`)
  })

  it('reports an unreadable source once instead of flooding the mapped facts', () => {
    const facts = repoFacts([], {sourceErrors: [[UMAMI, `${UMAMI}: compose file is empty`]]})
    const findings = check({specs: [UMAMI_SPEC], table: {'apps-umami': UMAMI_ENTRY}, facts})
    expect(messages(findings)).toEqual([
      `apps-umami: source \`${UMAMI}\` is unusable: ${UMAMI}: compose file is empty.`,
    ])
  })

  it('reports an unreadable runbook once, not one missing-fact finding per mapped step', () => {
    const file = runbookPath('broken.md')
    const entry: DiagramEntry = {
      covers: [],
      nodes: {one: {facts: [fact.anchor(file, 'a')]}, two: {facts: [fact.anchor(file, 'b')]}},
    }
    const facts = repoFacts([], {sourceErrors: [[file, 'cannot read']]})
    const findings = check({
      specs: [{name: 'runbooks-broken', nodeIds: ['one', 'two']}],
      table: {'runbooks-broken': entry},
      facts,
    })
    expect(messages(findings)).toEqual([`runbooks-broken: source \`${file}\` is unusable: cannot read.`])
  })

  it('fails when a mapped runbook anchor is in a runbook that does not exist', () => {
    const entry: DiagramEntry = {covers: [], nodes: {step: {facts: [fact.anchor(runbookPath('gone.md'), 'a')]}}}
    const findings = run([{name: 'runbooks-gone', nodeIds: ['step']}], {'runbooks-gone': entry}, [])
    expect(messages(findings)).toEqual([
      'runbooks-gone: node `step` maps to `gone.md` heading anchor `#a`, which no longer exists.',
    ])
  })
})

describe('compose reader', () => {
  const FILE = composePath('x')

  it('lists services and volumes by name, including volumes with no body', () => {
    const facts = parseComposeFacts('services:\n  a:\n    image: i\nvolumes:\n  caddy_data:\n  other: {}\n', FILE)
    expect(facts.map(factKey)).toEqual([
      factKey(fact.service(FILE, 'a')),
      factKey(fact.volume(FILE, 'caddy_data')),
      factKey(fact.volume(FILE, 'other')),
    ])
  })

  it('does not count bind mounts as volumes', () => {
    const text = 'services:\n  a:\n    image: i\n    volumes:\n      - ./data:/data\n      - named:/n\n'
    expect(parseComposeFacts(text, FILE).map(factKey)).toEqual([factKey(fact.service(FILE, 'a'))])
  })

  it.each([
    ['an empty file', ''],
    ['a null document', 'null\n'],
    ['a comment-only file', '# nothing\n'],
    ['a scalar document', 'just text\n'],
    ['no services', 'name: x\nvolumes:\n  v:\n'],
    ['an empty services map', 'services: {}\n'],
    ['a top-level include', 'include:\n  - other.yaml\nservices:\n  a:\n    image: i\n'],
    ['invalid YAML', 'services: [unterminated\n'],
  ])('fails closed on %s', (_name, text) => {
    expect(() => parseComposeFacts(text, FILE)).toThrow(SourceError)
  })
})

describe('upstream compose reader', () => {
  const UPSTREAM = 'services:\n  gateway:\n    image: g\nvolumes:\n  certs:\n'

  it('reads the file for the pinned ref', () => {
    const root = tempRoot({
      'apps/gateway/upstream.json': '{"repo":"fro-bot/agent","ref":"v1.2.3"}',
      '.cache/upstream-compose/v1.2.3/compose.yaml': UPSTREAM,
    })
    expect(readUpstreamComposeFacts(root).map(factKey)).toEqual([
      factKey(fact.service(GATEWAY_UPSTREAM_SOURCE, 'gateway')),
      factKey(fact.volume(GATEWAY_UPSTREAM_SOURCE, 'certs')),
    ])
  })

  it('never reads a file downloaded for an older pin', () => {
    const root = tempRoot({
      'apps/gateway/upstream.json': '{"repo":"fro-bot/agent","ref":"v1.2.4"}',
      '.cache/upstream-compose/v1.2.3/compose.yaml': UPSTREAM,
    })
    expect(() => readUpstreamComposeFacts(root)).toThrow('.cache/upstream-compose/v1.2.4/compose.yaml')
  })

  it('fails with the fetch command when the file is missing', () => {
    const root = tempRoot({'apps/gateway/upstream.json': '{"repo":"fro-bot/agent","ref":"v1.2.3"}'})
    expect(() => readUpstreamComposeFacts(root)).toThrow(SourceError)
    expect(() => readUpstreamComposeFacts(root)).toThrow(UPSTREAM_FETCH_SCRIPT)
  })

  it('fails on an empty download', () => {
    const root = tempRoot({
      'apps/gateway/upstream.json': '{"repo":"fro-bot/agent","ref":"v1.2.3"}',
      '.cache/upstream-compose/v1.2.3/compose.yaml': '',
    })
    expect(() => readUpstreamComposeFacts(root)).toThrow(SourceError)
  })

  it('reports a ref that is not a release tag as a source error', () => {
    const root = tempRoot({'apps/gateway/upstream.json': JSON.stringify({repo: 'fro-bot/agent', ref: 'main'})})
    expect(() => readUpstreamComposeFacts(root)).toThrow(SourceError)
    expect(() => readUpstreamComposeFacts(root)).toThrow('release tag')
  })

  it('fails when upstream.json is missing or malformed', () => {
    expect(() => readUpstreamComposeFacts(tempRoot())).toThrow(SourceError)
    expect(() => readUpstreamComposeFacts(tempRoot({'apps/gateway/upstream.json': '{'}))).toThrow(SourceError)
  })
})

describe('workflow reader', () => {
  const ROUTER = workflowPath('deploy.yaml')
  const CALLEE = workflowPath('deploy-keeweb.yaml')

  it('lists router jobs and local callees', () => {
    const text = `
on:
  push:
jobs:
  detect-changes:
    runs-on: ubuntu-latest
  deploy-keeweb:
    needs: detect-changes
    uses: ./.github/workflows/deploy-keeweb.yaml
`
    const {facts, callees} = parseWorkflowFacts(text, ROUTER)
    expect(facts.map(factKey)).toEqual([
      factKey(fact.job(ROUTER, 'detect-changes')),
      factKey(fact.job(ROUTER, 'deploy-keeweb')),
    ])
    expect(callees).toEqual(['deploy-keeweb.yaml'])
  })

  it('keeps a router job and a callee job with the same id apart', () => {
    const router = parseWorkflowFacts(
      'on:\n  push:\njobs:\n  deploy-keeweb:\n    uses: ./.github/workflows/deploy-keeweb.yaml\n',
      ROUTER,
    )
    const callee = parseWorkflowFacts(
      'on:\n  workflow_call:\njobs:\n  deploy-keeweb:\n    environment: keeweb\n    runs-on: x\n',
      CALLEE,
    )
    const keys = [...router.facts, ...callee.facts].map(factKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain(factKey(fact.job(ROUTER, 'deploy-keeweb')))
    expect(keys).toContain(factKey(fact.job(CALLEE, 'deploy-keeweb')))
    expect(keys).toContain(factKey(fact.environment(CALLEE, 'deploy-keeweb', 'keeweb')))
  })

  it('accepts environment as a string or as {name}', () => {
    const text = `
on:
  workflow_dispatch:
  workflow_call:
jobs:
  notify:
    runs-on: x
  deploy:
    runs-on: x
    environment:
      name: gate-one
      url: https://example.test
`
    const {facts} = parseWorkflowFacts(text, CALLEE)
    expect(facts.map(factKey)).toContain(factKey(fact.environment(CALLEE, 'deploy', 'gate-one')))
  })

  it('accepts workflow_call with a null value (checks the key, not truthiness)', () => {
    const text = 'on:\n  workflow_call:\njobs:\n  a:\n    runs-on: x\n'
    expect(parseWorkflowFacts(text, CALLEE).facts).toHaveLength(1)
  })

  it.each([
    ['a workflow with no jobs', 'on:\n  workflow_call:\n'],
    ['a callee that is not callable', 'on:\n  push:\njobs:\n  a:\n    runs-on: x\n'],
    ['a non-mapping `on`', 'on: push\njobs:\n  a:\n    runs-on: x\n'],
    ['an environment of an unknown shape', 'on:\n  workflow_call:\njobs:\n  a:\n    environment: [x]\n'],
    ['an environment mapping without a name', 'on:\n  workflow_call:\njobs:\n  a:\n    environment:\n      url: x\n'],
    ['a job that is not a mapping', 'on:\n  workflow_call:\njobs:\n  a: nope\n'],
    ['an empty file', ''],
  ])('fails closed on %s', (_name, text) => {
    expect(() => parseWorkflowFacts(text, CALLEE)).toThrow(SourceError)
  })

  it('fails closed on a router job that calls something other than a local workflow', () => {
    const text = 'on:\n  push:\njobs:\n  a:\n    uses: octo/repo/.github/workflows/x.yaml@main\n'
    expect(() => parseWorkflowFacts(text, ROUTER)).toThrow(SourceError)
  })

  it('fails closed on a callee that itself calls a reusable workflow', () => {
    const text = 'on:\n  workflow_call:\njobs:\n  a:\n    uses: ./.github/workflows/other.yaml\n'
    expect(() => parseWorkflowFacts(text, CALLEE)).toThrow(SourceError)
  })
})

describe('environment ownership', () => {
  const CALLEE = workflowPath('deploy-keeweb.yaml')
  const calleeText = (owner: 'notify' | 'deploy-keeweb'): string => `
on:
  workflow_call:
jobs:
  notify:
    runs-on: ubuntu-latest${owner === 'notify' ? '\n    environment: keeweb' : ''}
  deploy-keeweb:
    runs-on: ubuntu-latest${owner === 'deploy-keeweb' ? '\n    environment: keeweb' : ''}
`
  const entry: DiagramEntry = {
    covers: [
      {kind: 'job', file: CALLEE},
      {kind: 'environment', file: CALLEE},
    ],
    nodes: {
      notify: {facts: [fact.job(CALLEE, 'notify')]},
      deploy: {facts: [fact.job(CALLEE, 'deploy-keeweb')]},
      gate: {facts: [fact.environment(CALLEE, 'deploy-keeweb', 'keeweb')]},
    },
  }
  const spec: SpecInput = {name: 'deploy-pipeline', nodeIds: ['notify', 'deploy', 'gate']}

  it('passes while the gate environment sits on the deploy job', () => {
    const {facts} = parseWorkflowFacts(calleeText('deploy-keeweb'), CALLEE)
    expect(formatFindings(run([spec], {'deploy-pipeline': entry}, facts))).toBe('')
  })

  it('fails when the environment moves to the notify job', () => {
    const {facts} = parseWorkflowFacts(calleeText('notify'), CALLEE)
    const findings = run([spec], {'deploy-pipeline': entry}, facts)
    expect(messages(findings)).toContain(
      'deploy-pipeline: node `gate` maps to `deploy-keeweb.yaml` job `deploy-keeweb` environment `keeweb`, which no longer exists.',
    )
    expect(messages(findings)).toContain(
      'deploy-pipeline: `deploy-keeweb.yaml` job `notify` environment `keeweb` is neither drawn nor listed as not drawn.',
    )
    expect(findings.map(finding => finding.direction).toSorted()).toEqual(['missing-fact', 'undrawn-fact'])
  })
})

describe('runbook anchors', () => {
  const FILE = runbookPath('example.md')
  const anchors = (markdown: string): string[] => parseRunbookAnchors(markdown, FILE).facts.map(item => item.id)

  it('never makes the H1 an anchor', () => {
    expect(anchors('# Title\n\n## First step\n\n## Second step\n')).toEqual(['first-step', 'second-step'])
  })

  it('only skips the first H1', () => {
    expect(anchors('# Title\n\n# Another top\n')).toEqual(['another-top'])
  })

  it('renders inline code, emphasis and links before slugging', () => {
    const md =
      '# T\n\n## Run `vpn deploy --force-server-key`\n\n## The **hard** _stop_\n\n## See [the guide](./guide.md)\n'
    expect(anchors(md)).toEqual(['run-vpn-deploy---force-server-key', 'the-hard-stop', 'see-the-guide'])
  })

  it('keeps underscores inside identifiers and code', () => {
    expect(anchors('# T\n\n## Set `snake_case` and my_var\n')).toEqual(['set-snake_case-and-my_var'])
  })

  it('suffixes duplicate headings the way the site does', () => {
    expect(anchors('# T\n\n## Verify\n\n## Verify\n\n## Verify\n')).toEqual(['verify', 'verify-1', 'verify-2'])
  })

  it('ignores headings in backtick and tilde fences', () => {
    const md = [
      '# T',
      '',
      '```bash',
      '# not a heading',
      '```',
      '',
      '~~~',
      '## nor this',
      '~~~',
      '',
      '## Real',
      '',
    ].join('\n')
    expect(anchors(md)).toEqual(['real'])
  })

  it('does not close a fence with a shorter or different fence', () => {
    const md = [
      '# T',
      '',
      '````md',
      '```',
      '## inside',
      '```',
      '````',
      '',
      '~~~',
      '```',
      '## inside too',
      '~~~',
      '',
      '## Out',
      '',
    ].join('\n')
    expect(anchors(md)).toEqual(['out'])
  })

  it('skips frontmatter', () => {
    expect(anchors('---\ntitle: x\n# comment\n---\n\n# T\n\n## Step\n')).toEqual(['step'])
  })

  it('handles closing hashes and trailing spaces', () => {
    expect(anchors('# T\n\n## Step one ##\n\n## Step two   \n')).toEqual(['step-one', 'step-two'])
  })

  it('marks a heading with an angle bracket as unmappable', () => {
    const {facts, unmappable} = parseRunbookAnchors('# T\n\n## Add `<name>` peer\n\n## Remove <name> peer\n', FILE)
    expect(facts.map(item => item.id)).toHaveLength(2)
    const placeholder = facts[1]
    expect(placeholder).toBeDefined()
    if (placeholder === undefined) return
    expect(unmappable.has(factKey(placeholder))).toBe(true)
    // An angle bracket inside inline code is untouched by the site, so it stays mappable.
    expect(unmappable.size).toBe(1)
  })

  it('skips headings inside HTML comments, on one line or several', () => {
    const md = [
      '# T',
      '',
      '<!-- ## Hidden one -->',
      '',
      '<!--',
      '## Hidden two',
      '-->',
      '',
      '## Kept <!-- ## inline hidden -->',
      '',
      '## After',
      '',
    ].join('\n')
    expect(anchors(md)).toEqual(['kept', 'after'])
  })

  it('resumes after a comment closes mid-line', () => {
    expect(anchors('# T\n\n<!-- start\nstill hidden -->\n## Back\n')).toEqual(['back'])
  })

  it('does not treat a comment opener inside a fence as a comment', () => {
    const md = ['# T', '', '```html', '<!--', '```', '', '## Visible', ''].join('\n')
    expect(anchors(md)).toEqual(['visible'])
  })

  it('ignores a fence-looking line inside a comment', () => {
    const md = ['# T', '', '<!--', '```', '-->', '', '## Visible', ''].join('\n')
    expect(anchors(md)).toEqual(['visible'])
  })

  it('marks a heading with an ampersand as unmappable, but not one inside inline code', () => {
    const {facts, unmappable} = parseRunbookAnchors('# T\n\n## Fish & chips\n\n## Run `a && b`\n', FILE)
    const [entity, code] = facts
    expect(entity).toBeDefined()
    expect(code).toBeDefined()
    if (entity === undefined || code === undefined) return
    expect(unmappable.get(factKey(entity))).toContain('`&`')
    expect(unmappable.has(factKey(code))).toBe(false)
  })

  it('fails a node that maps to a heading with an ampersand', () => {
    const {facts, unmappable} = parseRunbookAnchors('# T\n\n## Fish & chips\n', FILE)
    const entry: DiagramEntry = {covers: [], nodes: {step: {facts: [fact.anchor(FILE, 'fish--chips')]}}}
    const findings = check({
      specs: [{name: 'runbooks-example', nodeIds: ['step']}],
      table: {'runbooks-example': entry},
      facts: repoFacts(facts, {unmappable}),
    })
    expect(findings.map(finding => finding.direction)).toEqual(['unmappable-fact'])
    expect(messages(findings)[0]).toContain('`&`')
  })

  it('fails a node that maps to an unmappable heading', () => {
    const {facts, unmappable} = parseRunbookAnchors('# T\n\n## Remove <name> peer\n', FILE)
    const entry: DiagramEntry = {covers: [], nodes: {step: {facts: [fact.anchor(FILE, 'remove-name-peer')]}}}
    const findings = check({
      specs: [{name: 'runbooks-example', nodeIds: ['step']}],
      table: {'runbooks-example': entry},
      facts: repoFacts(facts, {unmappable}),
    })
    expect(findings.map(finding => finding.direction)).toEqual(['unmappable-fact'])
    expect(messages(findings)[0]).toContain('node `step`')
    expect(messages(findings)[0]).toContain('`<`')
  })

  describe('as a runbook-map table', () => {
    const entry: DiagramEntry = {
      covers: [],
      nodes: {
        decide: {facts: [fact.anchor(FILE, 'first-step')]},
        run: {facts: [fact.anchor(FILE, 'first-step')]},
        verify: {facts: [fact.anchor(FILE, 'verify')]},
      },
    }
    const spec: SpecInput = {name: 'runbooks-example', nodeIds: ['decide', 'run', 'verify']}
    const facts = parseRunbookAnchors('# T\n\n## First step\n\n## Verify\n\n## Unmapped extra\n', FILE).facts

    it('lets several steps share one anchor, and does not flag headings no node maps to', () => {
      expect(formatFindings(run([spec], {'runbooks-example': entry}, facts))).toBe('')
    })

    it('fails when a mapped heading is renamed', () => {
      const renamed = parseRunbookAnchors('# T\n\n## First step\n\n## Verification\n', FILE).facts
      expect(messages(run([spec], {'runbooks-example': entry}, renamed))).toEqual([
        'runbooks-example: node `verify` maps to `example.md` heading anchor `#verify`, which no longer exists.',
      ])
    })
  })
})

describe('apps reader', () => {
  it('lists apps/* directories minus the non-deployable ones', () => {
    const root = tempRoot({
      'apps/broker/x': '',
      'apps/keeweb/x': '',
      'apps/docs/x': '',
      'apps/agent/x': '',
      'apps/stray-file.txt': '',
    })
    expect(readAppFacts(root).map(item => item.id)).toEqual(['broker', 'keeweb'])
    expect(readAppFacts(root).every(item => item.file === APPS_SOURCE)).toBe(true)
  })

  it('surfaces a new apps/* directory until it is drawn or excluded', () => {
    const root = tempRoot({'apps/broker/x': '', 'apps/newcomer/x': ''})
    const entry: DiagramEntry = {
      covers: [{kind: 'app', file: APPS_SOURCE}],
      nodes: {'app-broker': {facts: [fact.app('broker')]}},
    }
    const findings = run([{name: 'topology', nodeIds: ['app-broker']}], {topology: entry}, readAppFacts(root))
    expect(messages(findings)).toEqual(['topology: app `newcomer` is neither drawn nor listed as not drawn.'])
  })

  it('fails closed when there are no deployable apps', () => {
    expect(() => readAppFacts(tempRoot({'apps/docs/x': ''}))).toThrow(SourceError)
  })
})

describe('node extraction', () => {
  it('reads component ids from architecture specs and node ids from workflow specs', () => {
    expect(extractNodeIds('architecture', {components: [{id: 'a'}, {id: 'b'}]})).toEqual(['a', 'b'])
    expect(extractNodeIds('workflow', {nodes: [{id: 'x'}, {id: 'y'}]})).toEqual(['x', 'y'])
  })

  it('keeps duplicate ids so the checker can report them', () => {
    expect(extractNodeIds('architecture', {components: [{id: 'a'}, {id: 'a'}]})).toEqual(['a', 'a'])
  })

  it.each([
    ['an unknown diagram type', 'sequence', {components: [{id: 'a'}]}],
    ['an architecture spec without components', 'architecture', {nodes: []}],
    ['a node without a string id', 'workflow', {nodes: [{label: 'x'}]}],
    ['a non-object document', 'workflow', null],
  ])('fails on %s', (_name, type, json) => {
    expect(() => extractNodeIds(type, json)).toThrow(SourceError)
  })
})

describe('repo facts aggregation', () => {
  it('records an unreadable upstream compose as a source error instead of throwing', () => {
    const root = tempRoot({
      'apps/gateway/upstream.json': '{"repo":"fro-bot/agent","ref":"v1.2.3"}',
      'apps/umami/docker-compose.yaml': UMAMI_COMPOSE,
    })
    const facts = readRepoFacts(root)
    expect(facts.sourceErrors.get(GATEWAY_UPSTREAM_SOURCE)).toContain(UPSTREAM_FETCH_SCRIPT)
    // The other sources are still read.
    expect(facts.facts.map(factKey)).toContain(factKey(fact.service(UMAMI, 'umami')))
    expect(facts.sources.has(UMAMI)).toBe(true)
  })

  it('records a present but empty app compose file as a source error', () => {
    const root = tempRoot({'apps/umami/docker-compose.yaml': ''})
    const facts = readRepoFacts(root)
    expect(facts.sourceErrors.has(UMAMI)).toBe(true)
    expect(facts.sources.has(UMAMI)).toBe(false)
  })

  it('reads the workflows the router calls and the runbooks', () => {
    const root = tempRoot({
      '.github/workflows/deploy.yaml':
        'on:\n  push:\njobs:\n  detect:\n    runs-on: x\n  d:\n    uses: ./.github/workflows/deploy-a.yaml\n',
      '.github/workflows/deploy-a.yaml':
        'on:\n  workflow_call:\njobs:\n  deploy-a:\n    environment: a\n    runs-on: x\n',
      'docs/runbooks/one.md': '# One\n\n## Step\n',
    })
    const facts = readRepoFacts(root)
    const keys = facts.facts.map(factKey)
    expect(keys).toContain(factKey(fact.job(workflowPath('deploy.yaml'), 'detect')))
    expect(keys).toContain(factKey(fact.environment(workflowPath('deploy-a.yaml'), 'deploy-a', 'a')))
    expect(keys).toContain(factKey(fact.anchor(runbookPath('one.md'), 'step')))
  })

  it('records a missing callee workflow as a source error', () => {
    const root = tempRoot({
      '.github/workflows/deploy.yaml': 'on:\n  push:\njobs:\n  d:\n    uses: ./.github/workflows/deploy-gone.yaml\n',
    })
    expect(readRepoFacts(root).sourceErrors.has(workflowPath('deploy-gone.yaml'))).toBe(true)
  })
})

// ─── Real exports of apps/gateway/src/deploy.ts ──────────────────────────────

describe('gateway deploy exports', () => {
  it('reads the egress allowlist from the exported constants', () => {
    const ids = readEgressFacts().map(item => item.id)
    expect(ids).toContain('cliproxy.fro.bot')
    expect(ids.length).toBeGreaterThanOrEqual(3)
  })

  it('emits Caddy and its two volumes in the production override snapshot', () => {
    const keys = readOverrideFacts().map(factKey)
    expect(keys).toContain(factKey(fact.service(GATEWAY_OVERRIDE_SOURCE, 'caddy')))
    expect(keys).toContain(factKey(fact.volume(GATEWAY_OVERRIDE_SOURCE, 'caddy_data')))
    expect(keys).toContain(factKey(fact.volume(GATEWAY_OVERRIDE_SOURCE, 'caddy_config')))
  })
})

// ─── The real mapping table ──────────────────────────────────────────────────
//
// One entry per rendered spec, keyed by the name `discoverSpecs` returns. Each node maps to the facts it stands for or
// is illustrative with a reason. Labels, digests and pins are never checked. To change a diagram or a source, edit the
// spec and this table in the same PR; the failure message names the diagram, the node or fact, and the direction.
//
// Hostnames appear here, not in the specs: spec text must not contain them, so the egress rows carry the mapping.

const REPO_ROOT = resolve(import.meta.dir, '../../..')

const maps = (...facts: Fact[]): NodeMapping => ({facts})
const illustrative = (reason: string): NodeMapping => ({illustrative: reason})

const gatewayFact = {
  upstreamService: (id: string) => fact.service(GATEWAY_UPSTREAM_SOURCE, id),
  upstreamVolume: (id: string) => fact.volume(GATEWAY_UPSTREAM_SOURCE, id),
  overrideService: (id: string) => fact.service(GATEWAY_OVERRIDE_SOURCE, id),
  overrideVolume: (id: string) => fact.volume(GATEWAY_OVERRIDE_SOURCE, id),
} as const

/** A Caddy node covers the service and its two volumes in the app's compose file. */
const caddyOf = (app: string): NodeMapping => {
  const file = composePath(app)
  return maps(fact.service(file, 'caddy'), fact.volume(file, 'caddy_data'), fact.volume(file, 'caddy_config'))
}

const composeScopes = (app: string): DiagramEntry['covers'] => [
  {kind: 'service', file: composePath(app)},
  {kind: 'volume', file: composePath(app)},
]

const DEPLOYED_APPS = ['keeweb', 'cliproxy', 'gateway', 'umami', 'vpn', 'dashboard', 'broker'] as const

const ROUTER = workflowPath('deploy.yaml')
const calleeOf = (app: string): string => workflowPath(`deploy-${app}.yaml`)

const GATEWAY_ENTRY: DiagramEntry = {
  covers: [
    {kind: 'service', file: GATEWAY_UPSTREAM_SOURCE},
    {kind: 'volume', file: GATEWAY_UPSTREAM_SOURCE},
    {kind: 'service', file: GATEWAY_OVERRIDE_SOURCE},
    {kind: 'volume', file: GATEWAY_OVERRIDE_SOURCE},
    {kind: 'egress-host', file: EGRESS_SOURCE},
  ],
  nodes: {
    webhook: illustrative('Webhook senders are external callers.'),
    dashboard: illustrative('The dashboard Caddy belongs to the dashboard deployment.'),
    ghcr: illustrative('GHCR is an external registry.'),
    discord: illustrative('Discord is an external service.'),
    gateway: maps(gatewayFact.upstreamService('gateway')),
    workspace: maps(gatewayFact.upstreamService('workspace')),
    repos: maps(gatewayFact.upstreamVolume('workspace-repos')),
    mitm: maps(gatewayFact.upstreamService('mitmproxy')),
    certs: maps(gatewayFact.upstreamVolume('mitmproxy-certs')),
    // These facts exist while the operator listener is enabled, as in production; the test snapshot assumes that.
    caddy: maps(
      gatewayFact.overrideService('caddy'),
      gatewayFact.overrideVolume('caddy_data'),
      gatewayFact.overrideVolume('caddy_config'),
    ),
    cliproxy: maps(fact.egressHost('cliproxy.fro.bot')),
    catalog: maps(fact.egressHost('models.dev'), fact.egressHost('models.opencode.ai')),
    state: illustrative('Object storage is set by environment values, not by the compose files.'),
  },
}

const PIPELINE_ENTRY: DiagramEntry = {
  covers: [
    {kind: 'job', file: ROUTER},
    ...DEPLOYED_APPS.flatMap((app): DiagramEntry['covers'] => [
      {kind: 'job', file: calleeOf(app)},
      {kind: 'environment', file: calleeOf(app)},
    ]),
  ],
  nodes: {
    push: illustrative('A push to main is a trigger, not repo structure.'),
    detect: maps(fact.job(ROUTER, 'detect-changes')),
    reusable: maps(...DEPLOYED_APPS.map(app => fact.job(ROUTER, `deploy-${app}`))),
    notify: maps(...DEPLOYED_APPS.map(app => fact.job(calleeOf(app), 'notify'))),
    discord: illustrative('Discord is an external service.'),
    gate: maps(...DEPLOYED_APPS.map(app => fact.environment(calleeOf(app), `deploy-${app}`, app))),
    deploy: maps(...DEPLOYED_APPS.map(app => fact.job(calleeOf(app), `deploy-${app}`))),
    host: illustrative('The target host is outside the repo.'),
  },
  notDrawn: [
    {
      fact: fact.job(calleeOf('gateway'), 'build-images'),
      reason: 'It is an app-specific pre-deploy job that the generic pipeline leaves out.',
    },
    {
      fact: fact.job(calleeOf('gateway'), 'scan-images'),
      reason: 'It is an app-specific pre-deploy job that the generic pipeline leaves out.',
    },
    {
      fact: fact.job(calleeOf('dashboard'), 'validate-inputs'),
      reason: 'It is an app-specific pre-deploy job that the generic pipeline leaves out.',
    },
  ],
}

/** A runbook-map entry: every node maps to one or more heading anchors, and several nodes may share one. */
function runbookEntry(file: string, nodes: Readonly<Record<string, readonly string[]>>): DiagramEntry {
  return {
    covers: [],
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([node, anchors]) => [
        node,
        maps(...anchors.map(id => fact.anchor(runbookPath(file), id))),
      ]),
    ),
  }
}

const TABLE = {
  topology: {
    covers: [{kind: 'app', file: APPS_SOURCE}],
    nodes: {
      'gh-actions': illustrative('GitHub Actions is an external platform.'),
      ...Object.fromEntries(DEPLOYED_APPS.map(app => [`app-${app}`, maps(fact.app(app))])),
      'operator-browser': illustrative('The operator browser is not part of the repo.'),
      ghcr: illustrative('GHCR is an external registry.'),
      consumers: illustrative('Agent runs happen in consumer repos outside this repo.'),
      providers: illustrative('Model providers are external services.'),
    },
  },

  'apps-broker': {
    covers: composeScopes('broker'),
    nodes: {
      runner: illustrative('The Actions run is an external caller.'),
      caddy: caddyOf('broker'),
      // One node claims the service. The checker rejects a fact claimed by two nodes, so the other three modules that
      // run inside the same container are illustrative.
      oidc: illustrative('It is a module inside the broker service.'),
      policy: illustrative('It is a module inside the broker service.'),
      mint: maps(fact.service(composePath('broker'), 'broker')),
      live: illustrative('It is in-memory state with no compose volume.'),
      sweeper: illustrative('It is a module inside the broker service.'),
      cliproxy: illustrative('CLIProxyAPI is a separate deployment.'),
    },
  },

  'apps-cliproxy': {
    covers: composeScopes('cliproxy'),
    nodes: {
      clients: illustrative('API clients are external callers.'),
      operator: illustrative('The operator is a person, not a service.'),
      caddy: caddyOf('cliproxy'),
      proxy: maps(fact.service(composePath('cliproxy'), 'cli-proxy-api')),
      auth: maps(fact.volume(composePath('cliproxy'), 'cliproxy_auth')),
      config: illustrative('config.yaml is a bind-mounted host file, not a compose volume.'),
      providers: illustrative('Model providers are external services.'),
      deploy: illustrative('deploy.ts runs from the repo, not inside the stack.'),
    },
  },

  'apps-dashboard': {
    covers: composeScopes('dashboard'),
    nodes: {
      browser: illustrative('The operator browser is not part of the repo.'),
      caddy: caddyOf('dashboard'),
      dashboard: maps(fact.service(composePath('dashboard'), 'dashboard')),
      data: illustrative('Host files are bind mounts, not compose volumes.'),
      github: illustrative('GitHub is an external service.'),
      gateway: illustrative('The gateway listener belongs to the gateway deployment.'),
      ghcr: illustrative('GHCR is an external registry.'),
      deploy: illustrative('deploy.ts runs from the repo, not inside the stack.'),
    },
  },

  'apps-gateway': GATEWAY_ENTRY,

  'apps-keeweb': {
    covers: [],
    noCompose: {app: 'keeweb', reason: 'KeeWeb ships static files to a host and has no compose stack.'},
    nodes: {
      release: illustrative('The KeeWeb release zip is downloaded at build time.'),
      build: illustrative('build.ts is a repo script, not a compose service.'),
      secret: illustrative('The Dropbox app secret is a CI secret.'),
      dist: illustrative('dist/ is a build output directory.'),
      deploy: illustrative('deploy.sh runs in CI, not in a stack.'),
      site: illustrative('The site directory lives on the host.'),
      activate: illustrative('The activation script is a host file.'),
      nginx: illustrative('The nginx config is a host file.'),
    },
  },

  'apps-umami': {
    covers: composeScopes('umami'),
    nodes: {
      visitors: illustrative('Tracked sites are external callers.'),
      admin: illustrative('The admin is a person, not a service.'),
      caddy: caddyOf('umami'),
      umami: maps(fact.service(composePath('umami'), 'umami')),
      db: maps(fact.service(composePath('umami'), 'db'), fact.volume(composePath('umami'), 'umami-db-data-pg18')),
      retention: illustrative('The retention timer is a host systemd unit, not a compose service.'),
      deploy: illustrative('deploy.ts runs from the repo, not inside the stack.'),
    },
  },

  'apps-vpn': {
    covers: [],
    noCompose: {app: 'vpn', reason: 'The VPN box runs WireGuard on the host and has no compose stack.'},
    nodes: {
      peers: illustrative('WireGuard clients are external devices.'),
      key: illustrative('server.key is a file on the host.'),
      wg0: illustrative('wg-quick@wg0 is a host systemd unit.'),
      conf: illustrative('wg0.conf is a rendered host file.'),
      internet: illustrative('The internet is outside the repo.'),
      deploy: illustrative('deploy.ts runs from the repo, not on the box.'),
      cli: illustrative('The vpn client command runs on the operator machine.'),
      roster: illustrative('VPN_PEERS is a GitHub Environment secret.'),
    },
  },

  'deploy-pipeline': PIPELINE_ENTRY,

  'runbooks-dashboard-rollback': runbookEntry('dashboard-released-image-rollback.md', {
    detect: ['when-to-use'],
    paired: ['contract-changes-roll-back-paired'],
    'stop-paired': ['contract-changes-roll-back-paired'],
    prior: ['step-1-identify-the-prior-digest', 'a-newer-release-exists-and-is-known-good'],
    revert: ['step-2-revert-the-compose-pin-commit', 'the-revert-conflicts'],
    pr: ['step-3-push-and-open-a-pr', 'step-4-merge-and-deploy'],
    approve: ['step-4-merge-and-deploy'],
    deploy: ['step-4-merge-and-deploy'],
    'stop-failed': ['deployment-stops-before-or-during-rollback'],
    verify: ['step-5-verify'],
  }),

  'runbooks-umami-pg-upgrade': runbookEntry('umami-postgres-major-upgrade.md', {
    pre: ['1-pre-flight-read-only'],
    backup: ['2-backup-feeds-staging'],
    staging: ['3-staging-validation-workstation-only-before-the-pin-pr-is-written'],
    quiesce: ['41-disable-the-retention-timer', '42-deploy-freeze', '43-quiesce-and-final-dump'],
    'gate-dump': ['44-verify-the-cutover-dump-hard-gate'],
    switch: [
      '45-stop-pg15-db-leave-umami_umami-db-data-untouched',
      '46-switch-the-droplet-compose-by-hand-start-only-pg18-db',
    ],
    'gate-layout': ['47-layout-gates-hard-stop-before-restore'],
    restore: ['48-restore-with-the-staging-validated-flags-manifest-gate-before-umami', '49-start-umami-internal-only'],
    'gate-manifest': [
      '48-restore-with-the-staging-validated-flags-manifest-gate-before-umami',
      '49-start-umami-internal-only',
    ],
    caddy: ['410-start-caddy-the-point-of-no-return'],
    verify: ['61-verify-the-live-stack', '63-supervised-retention-on-pg18', '8-finalize'],
    revert: ['71-pre-caddy-revert-explicit-sequence'],
    'rollback-choice': ['7-rollback-matrix-r4', '72-after-caddy-starts-lossy-explicit-decision'],
  }),

  'runbooks-vpn-key-rotation': runbookEntry('vpn-egress-box.md', {
    decide: ['rotate-the-wireguard-server-key'],
    run: ['rotate-the-wireguard-server-key'],
    'wipe-guard': ['wipe-guard'],
    rotate: ['rotate-the-wireguard-server-key'],
    render: ['rotate-the-wireguard-server-key'],
    // The health gate is described only inside the wipe guard section.
    health: ['wipe-guard'],
    reissue: ['option-b-regenerate-and-reissue', 'client-onboarding'],
    verify: ['step-5-verify'],
    abort: ['wipe-guard'],
  }),

  'status-snapshot': {outOfScope: 'It is a data flow with no single repo source of structural facts.'},
  'operator-path': {outOfScope: 'It is a request sequence with no single repo source of structural facts.'},
} satisfies DriftTable

// ─── Real-repo check ─────────────────────────────────────────────────────────

describe('published diagrams against the repo', () => {
  it('has no drift between the diagram specs, the mapping table and the repo sources', () => {
    const specs = readSpecs(REPO_ROOT)
    expect(specs.length).toBeGreaterThan(0)
    const findings = check({specs, table: TABLE, facts: readRepoFacts(REPO_ROOT)})
    expect(findings, formatFindings(findings)).toEqual([])
  })
})

// Pin the real table's `covers` scopes: inject one extra fact into the real facts and require the matching finding.
describe('the real table catches an undrawn fact', () => {
  const specs = readSpecs(REPO_ROOT)
  const real = readRepoFacts(REPO_ROOT)

  function findingsWith(extra: Fact): Finding[] {
    return check({specs, table: TABLE, facts: {...real, facts: [...real.facts, extra]}})
  }

  it('flags an extra egress host on the gateway diagram', () => {
    const findings = findingsWith(fact.egressHost('extra.example.test'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      diagram: 'apps-gateway',
      subject: 'extra.example.test',
      direction: 'undrawn-fact',
    })
  })

  it('flags an extra upstream gateway service on the gateway diagram', () => {
    const findings = findingsWith(fact.service(GATEWAY_UPSTREAM_SOURCE, 'extra-sidecar'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({diagram: 'apps-gateway', subject: 'extra-sidecar', direction: 'undrawn-fact'})
  })

  it('flags an extra compose service in apps/umami on the umami diagram', () => {
    const findings = findingsWith(fact.service(composePath('umami'), 'redis'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({diagram: 'apps-umami', subject: 'redis', direction: 'undrawn-fact'})
  })
})
