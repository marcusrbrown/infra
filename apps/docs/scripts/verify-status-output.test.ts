import type {AppId} from '@marcusrbrown/infra-shared/status/history-schema'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {APP_IDS, APPS_NOT_YET_DEPLOYED} from '@marcusrbrown/infra-shared/status/history-schema'
import {afterEach, describe, expect, it} from 'bun:test'

import {NOT_YET_DEPLOYED_LABEL, NOT_YET_DEPLOYED_TEXT} from '../src/lib/history-view'
import {FIXTURE_MARKER, STALE_HOOK, verifyStatusOutput, visibleText} from './verify-status-output'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, {recursive: true, force: true})
})

const LAST_SAMPLE = `<p>Last sample <time>2026-11-01 10:00 UTC</time></p><p ${STALE_HOOK} hidden>stale</p>`
const COVERAGE = '<p>3 samples recorded of about 3 expected</p>'
const PASSED = '<td>3 of 3 samples passed</td>'

const SERVICE = `<main>${LAST_SAMPLE}${COVERAGE}${PASSED}</main>`
/** What `AppStatus.astro` renders for an app that is not yet deployed. */
const NOT_DEPLOYED_SERVICE = `<main>${LAST_SAMPLE}<h2>Current status</h2><p>${NOT_YET_DEPLOYED_TEXT}</p></main>`
/** What `status.astro` renders for its row. */
const notDeployedRow = (app: AppId): string =>
  `<tr><th scope="row"><a href="/infra/services/${app}/">${app}</a></th><td colspan="3">${NOT_YET_DEPLOYED_LABEL}</td><td>${NOT_YET_DEPLOYED_LABEL}</td></tr>`

/** A status page body that holds `inner` and a table row for every app on the real list. */
const statusBody = (inner: string): string =>
  `<main>${inner}<table><tbody>${APPS_NOT_YET_DEPLOYED.map(notDeployedRow).join('')}</tbody></table></main>`

interface DistOptions {
  fixture: boolean
  omit?: string
  extra?: string
  /** Replaces the status page body. */
  status?: string
  /** Replaces the gateway service page body; every other service page keeps the full body. */
  gateway?: string
  /** The apps that are not yet deployed; their pages and status rows are built as such. Defaults to the real list. */
  notYetDeployed?: readonly AppId[]
  /** Replaces one app's service page body. */
  bodies?: Partial<Record<AppId, string>>
  /** Replaces one app's row on the status page. */
  rows?: Partial<Record<AppId, string>>
}

function buildDist(options: DistOptions): string {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'))
  scratch.push(dist)
  const marker = options.fixture ? `<div ${FIXTURE_MARKER}></div>` : ''
  const write = (page: string, body: string) => {
    if (page === options.omit) return
    const path = join(dist, page, 'index.html')
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, `<html><body>${marker}${body}${options.extra ?? ''}</body></html>`)
  }
  const hidden = options.notYetDeployed ?? APPS_NOT_YET_DEPLOYED
  const rows = hidden.map(app => options.rows?.[app] ?? notDeployedRow(app)).join('')
  write('status', options.status ?? `<main>${LAST_SAMPLE}<table><tbody>${rows}</tbody></table></main>`)
  for (const app of APP_IDS) {
    const normal = app === 'gateway' ? (options.gateway ?? SERVICE) : SERVICE
    write(`services/${app}`, options.bodies?.[app] ?? (hidden.includes(app) ? NOT_DEPLOYED_SERVICE : normal))
  }
  return dist
}

describe('verifyStatusOutput', () => {
  it('passes for a fixture build that carries the marker', () => {
    expect(verifyStatusOutput(buildDist({fixture: true}), {expectFixture: true})).toEqual([])
  })

  it('passes for a real-history build without the marker', () => {
    expect(verifyStatusOutput(buildDist({fixture: false}), {expectFixture: false})).toEqual([])
  })

  it('reports a missing page', () => {
    const problems = verifyStatusOutput(buildDist({fixture: true, omit: 'services/gateway'}), {expectFixture: true})

    expect(problems).toEqual(['services/gateway/index.html was not built'])
  })

  it('reports a fixture marker on a real-history build, and a missing one on a fixture build', () => {
    expect(verifyStatusOutput(buildDist({fixture: true}), {expectFixture: false})[0]).toContain(
      'carries the fixture marker',
    )
    expect(verifyStatusOutput(buildDist({fixture: false}), {expectFixture: true})[0]).toContain(
      'missing the fixture marker',
    )
  })

  it('reports a percentage next to a figure', () => {
    const problems = verifyStatusOutput(buildDist({fixture: false, extra: '<p>Availability 99.9%</p>'}), {
      expectFixture: false,
    })

    expect(problems.some(problem => problem.includes('percentage'))).toBe(true)
  })

  it('ignores a percentage in inline styles and scripts', () => {
    const extra = '<div style="width: 100%"></div><style>.a{width:50%}</style><script>var x = 5 % 2</script>'

    expect(verifyStatusOutput(buildDist({fixture: false, extra}), {expectFixture: false})).toEqual([])
  })
})

describe('verifyStatusOutput: each required item', () => {
  it('reports a service page with no coverage figure', () => {
    const dist = buildDist({fixture: false, gateway: `<main>${LAST_SAMPLE}${PASSED}</main>`})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual(['services/gateway: missing the coverage figure'])
  })

  it('reports a service page with no passed-sample count', () => {
    const dist = buildDist({fixture: false, gateway: `<main>${LAST_SAMPLE}${COVERAGE}</main>`})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual([
      'services/gateway: missing "N of M samples passed"',
    ])
  })

  it('reports a status page with no "Last sample"', () => {
    const dist = buildDist({fixture: false, status: statusBody(`<p ${STALE_HOOK} hidden>stale</p>`)})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual(['status: missing the last-sample time'])
  })

  it('reports a service page with no stale-warning hook', () => {
    const dist = buildDist({
      fixture: false,
      gateway: `<main><p>Last sample <time>2026-11-01 10:00 UTC</time></p>${COVERAGE}${PASSED}</main>`,
    })

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual([
      'services/gateway: missing the stale-warning hook',
    ])
  })

  it('reports a service page with no "Last sample"', () => {
    const dist = buildDist({fixture: false, gateway: `<main><p ${STALE_HOOK} hidden>x</p>${COVERAGE}${PASSED}</main>`})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual(['services/gateway: missing the last-sample time'])
  })

  it('reports a status page with no stale-warning hook', () => {
    const dist = buildDist({fixture: false, status: statusBody('<p>Last sample <time>x</time></p>')})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual(['status: missing the stale-warning hook'])
  })
})

describe('verifyStatusOutput: a service with no samples yet', () => {
  // An app added after the history began has no samples until the next snapshot writes its file.
  const NO_DATA = '<p>No data yet. No samples have been recorded for this service.</p><td>No data yet</td>'

  it('passes with the no-data text instead of the coverage and passed-sample figures', () => {
    const dist = buildDist({fixture: false, gateway: `<main>${LAST_SAMPLE}${NO_DATA}</main>`})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual([])
  })

  it('still requires the last-sample time and the stale-warning hook', () => {
    const dist = buildDist({fixture: false, gateway: `<main>${NO_DATA}</main>`})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual([
      'services/gateway: missing the last-sample time',
      'services/gateway: missing the stale-warning hook',
    ])
  })

  it('still reports a percentage', () => {
    const dist = buildDist({fixture: false, gateway: `<main>${LAST_SAMPLE}${NO_DATA}<p>99%</p></main>`})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual([
      'services/gateway: shows a percentage next to a figure',
    ])
  })

  it('does not excuse a page that shows neither the figures nor the no-data text', () => {
    const dist = buildDist({fixture: false, gateway: `<main>${LAST_SAMPLE}</main>`})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual([
      'services/gateway: missing the coverage figure',
      'services/gateway: missing "N of M samples passed"',
    ])
  })
})

describe('verifyStatusOutput: a service that is not yet deployed', () => {
  const HIDDEN: readonly AppId[] = ['traces']
  const check = (dist: string) => verifyStatusOutput(dist, {expectFixture: false, notYetDeployed: HIDDEN})
  const dist = (options: Partial<DistOptions> = {}) => buildDist({fixture: false, notYetDeployed: HIDDEN, ...options})

  it('passes for the statement, with no coverage or passed-sample figure', () => {
    expect(check(dist())).toEqual([])
  })

  it('reports a page that shows its health instead of the statement', () => {
    const problems = check(dist({bodies: {traces: SERVICE}}))

    expect(problems).toContain('services/traces: missing the not-yet-deployed statement')
    expect(problems).toContain('services/traces: shows a coverage figure for an app that is not yet deployed')
    expect(problems).toContain('services/traces: shows a passed-sample count for an app that is not yet deployed')
  })

  it.each(['Failing: Deploy state', 'Checks passed', 'Partly measured', 'Unknown: Reachability'])(
    'reports the verdict text "%s" on it',
    verdict => {
      const body = `<main>${LAST_SAMPLE}<p>${NOT_YET_DEPLOYED_TEXT}</p><p>${verdict}</p></main>`

      expect(check(dist({bodies: {traces: body}}))).toEqual([
        'services/traces: shows a verdict for an app that is not yet deployed',
      ])
    },
  )

  it('reports the "No data yet" text on it: that state belongs to a deployed app', () => {
    const body = `<main>${LAST_SAMPLE}<p>${NOT_YET_DEPLOYED_TEXT}</p><p>No data yet. No samples have been recorded for this service.</p></main>`

    expect(check(dist({bodies: {traces: body}}))).toEqual([
      'services/traces: shows "No data yet" for an app that is not yet deployed',
    ])
  })

  it('still requires the last-sample time and the stale-warning hook, and still reports a percentage', () => {
    const body = `<main><p>${NOT_YET_DEPLOYED_TEXT}</p><p>99%</p></main>`

    expect(check(dist({bodies: {traces: body}}))).toEqual([
      'services/traces: shows a percentage next to a figure',
      'services/traces: missing the last-sample time',
      'services/traces: missing the stale-warning hook',
    ])
  })

  it('reports a status row that shows results instead of the statement', () => {
    const row =
      '<tr><th scope="row"><a href="/infra/services/traces/">traces</a></th><td>❌ Fail</td><td>❓ Unknown</td><td>⚪ Not measured</td><td>❌ Failing: Deploy state</td></tr>'

    expect(check(dist({rows: {traces: row}}))).toEqual([
      'status: the traces row does not say it is not yet deployed',
      'status: the traces row shows a result or verdict for an app that is not yet deployed',
    ])
  })

  it('reports a status page that has no row for it', () => {
    const status = `<main>${LAST_SAMPLE}<table><tbody></tbody></table></main>`

    expect(check(dist({status}))).toEqual(['status: no row for traces'])
  })

  it('still holds every other service to the coverage and passed-sample figures', () => {
    const body = `<main>${LAST_SAMPLE}</main>`

    expect(check(dist({bodies: {gateway: body}}))).toEqual([
      'services/gateway: missing the coverage figure',
      'services/gateway: missing "N of M samples passed"',
    ])
  })

  it('expects a normal page for the app once the list is empty', () => {
    const normal = verifyStatusOutput(buildDist({fixture: false, notYetDeployed: []}), {
      expectFixture: false,
      notYetDeployed: [],
    })
    const staleStatement = verifyStatusOutput(
      buildDist({fixture: false, notYetDeployed: [], bodies: {traces: NOT_DEPLOYED_SERVICE}}),
      {
        expectFixture: false,
        notYetDeployed: [],
      },
    )

    expect(normal).toEqual([])
    expect(staleStatement).toEqual([
      'services/traces: missing the coverage figure',
      'services/traces: missing "N of M samples passed"',
    ])
  })

  // Wiring with the real list, no injection. Delete with the other traces tripwire when traces is deployed.
  it('applies the real not-yet-deployed list when none is injected', () => {
    expect(APPS_NOT_YET_DEPLOYED).toContain('traces')
    const built = buildDist({fixture: false, bodies: {traces: SERVICE}})

    expect(verifyStatusOutput(built, {expectFixture: false})).toContain(
      'services/traces: missing the not-yet-deployed statement',
    )
  })
})

describe('visibleText', () => {
  it('drops tags, scripts and styles', () => {
    expect(visibleText('<p class="a">hi <b>there</b></p><script>1 % 2</script>')).toContain('hi there')
    expect(visibleText('<script>1 % 2</script>')).not.toContain('%')
  })
})
