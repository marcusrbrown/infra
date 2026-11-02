import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {APP_IDS} from '@marcusrbrown/infra-shared/status/history-schema'
import {afterEach, describe, expect, it} from 'bun:test'

import {FIXTURE_MARKER, STALE_HOOK, verifyStatusOutput, visibleText} from './verify-status-output'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, {recursive: true, force: true})
})

const LAST_SAMPLE = `<p>Last sample <time>2026-11-01 10:00 UTC</time></p><p ${STALE_HOOK} hidden>stale</p>`
const COVERAGE = '<p>3 samples recorded of about 3 expected</p>'
const PASSED = '<td>3 of 3 samples passed</td>'

const STATUS = `<main>${LAST_SAMPLE}</main>`
const SERVICE = `<main>${LAST_SAMPLE}${COVERAGE}${PASSED}</main>`

interface DistOptions {
  fixture: boolean
  omit?: string
  extra?: string
  /** Replaces the status page body. */
  status?: string
  /** Replaces the gateway service page body; every other service page keeps the full body. */
  gateway?: string
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
  write('status', options.status ?? STATUS)
  for (const app of APP_IDS) write(`services/${app}`, app === 'gateway' ? (options.gateway ?? SERVICE) : SERVICE)
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
    const dist = buildDist({fixture: false, status: `<main><p ${STALE_HOOK} hidden>stale</p></main>`})

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
    const dist = buildDist({fixture: false, status: '<main><p>Last sample <time>x</time></p></main>'})

    expect(verifyStatusOutput(dist, {expectFixture: false})).toEqual(['status: missing the stale-warning hook'])
  })
})

describe('visibleText', () => {
  it('drops tags, scripts and styles', () => {
    expect(visibleText('<p class="a">hi <b>there</b></p><script>1 % 2</script>')).toContain('hi there')
    expect(visibleText('<script>1 % 2</script>')).not.toContain('%')
  })
})
