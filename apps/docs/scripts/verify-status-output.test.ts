import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {APP_IDS} from '@marcusrbrown/infra-shared/status/history-schema'
import {afterEach, describe, expect, it} from 'bun:test'

import {FIXTURE_MARKER, verifyStatusOutput, visibleText} from './verify-status-output'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, {recursive: true, force: true})
})

const STATUS = '<main><p>Last sample 2026-11-01 10:00 UTC</p></main>'
const SERVICE = '<main><p>3 samples recorded of about 4 expected</p><td>3 of 3 samples passed</td></main>'

function buildDist(options: {fixture: boolean; omit?: string; extra?: string}): string {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'))
  scratch.push(dist)
  const marker = options.fixture ? `<div ${FIXTURE_MARKER}></div>` : ''
  const write = (page: string, body: string) => {
    if (page === options.omit) return
    const path = join(dist, page, 'index.html')
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, `<html><body>${marker}${body}${options.extra ?? ''}</body></html>`)
  }
  write('status', STATUS)
  for (const app of APP_IDS) write(`services/${app}`, SERVICE)
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

describe('visibleText', () => {
  it('drops tags, scripts and styles', () => {
    expect(visibleText('<p class="a">hi <b>there</b></p><script>1 % 2</script>')).toContain('hi there')
    expect(visibleText('<script>1 % 2</script>')).not.toContain('%')
  })
})
