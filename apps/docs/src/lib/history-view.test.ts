import type {HistorySample} from '@marcusrbrown/infra-shared/status/history-schema'

import {describe, expect, it} from 'bun:test'

import {
  buildAppView,
  buildHistoryView,
  coverageLabel,
  GAP_THRESHOLD_MS,
  isStale,
  passLabel,
  STALE_THRESHOLD_MS,
} from './history-view'

const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const MINUTE = 60_000
const at = (minutes: number): string => new Date(T0 + minutes * MINUTE).toISOString()

let runCounter = 0
function sample(minutes: number, r: HistorySample['r'], d: HistorySample['d'] | undefined = undefined): HistorySample {
  runCounter += 1
  return {t: at(minutes), run: String(1000 + runCounter), att: 1, r, ...(d === undefined ? {} : {d})}
}

const reachability = (code: 'p' | 'f' | 'u' | 'n') => ({'public-reachability': code, 'deploy-state': 'p' as const})

function defined<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${label} to be defined`)
  return value
}

describe('constants', () => {
  it('exports the gap and stale thresholds', () => {
    expect(GAP_THRESHOLD_MS).toBe(45 * MINUTE)
    expect(STALE_THRESHOLD_MS).toBe(90 * MINUTE)
  })
})

describe('samples passed', () => {
  it('reads "3 of 3 samples passed" for three samples 30 minutes apart, with no gap', () => {
    const samples = [0, 30, 60].map(m => sample(m, reachability('p')))
    const view = buildAppView('keeweb', samples, new Date(at(60)))
    const reach = view.observations.find(o => o.id === 'public-reachability')

    expect(reach?.counts).toEqual({total: 3, passed: 3, failed: 0, unknown: 0, notMeasured: 0})
    expect(passLabel(defined(reach, 'public-reachability observation').counts)).toBe('3 of 3 samples passed')
    expect(view.gaps).toEqual([])
    expect(view.latestSampleAt).toBe(at(60))
  })

  it('counts fail, unknown and not_measured separately from pass', () => {
    const samples = [
      sample(0, reachability('p')),
      sample(30, reachability('f')),
      sample(60, reachability('u')),
      sample(90, reachability('u')),
      sample(120, {'public-reachability': 'n', 'deploy-state': 'p'}),
      sample(150, reachability('p')),
    ]
    const view = buildAppView('keeweb', samples, new Date(at(150)))
    const reach = view.observations.find(o => o.id === 'public-reachability')

    expect(reach?.counts).toEqual({total: 6, passed: 2, failed: 1, unknown: 2, notMeasured: 1})
    expect(passLabel(defined(reach, 'public-reachability observation').counts)).toBe('2 of 6 samples passed')
    expect(view.cells.reachability.result).toBe('pass')
  })

  it('counts only the samples that carry an observation', () => {
    const samples = [sample(0, {'deploy-state': 'p'}), sample(30, reachability('p'))]
    const view = buildAppView('keeweb', samples, new Date(at(30)))

    expect(view.observations.find(o => o.id === 'public-reachability')?.counts.total).toBe(1)
    expect(view.observations.find(o => o.id === 'deploy-state')?.counts.total).toBe(2)
  })
})

describe('gaps', () => {
  it('marks one gap for samples at T and T+75 minutes', () => {
    const view = buildAppView('keeweb', [sample(0, reachability('p')), sample(75, reachability('p'))], new Date(at(75)))

    expect(view.gaps).toEqual([{from: at(0), to: at(75), minutes: 75}])
  })

  it('does not mark an interval of exactly 45 minutes', () => {
    const view = buildAppView('keeweb', [sample(0, reachability('p')), sample(45, reachability('p'))], new Date(at(45)))

    expect(view.gaps).toEqual([])
  })

  it('never treats the first sample after bootstrap as a gap', () => {
    // Bootstrap happened long after the window opened: one sample, recorded 3 hours before "now".
    const view = buildAppView('keeweb', [sample(0, reachability('p'))], new Date(at(180)))

    expect(view.gaps).toEqual([])
  })

  it('finds gaps whatever order the samples arrive in', () => {
    const view = buildAppView(
      'keeweb',
      [sample(100, reachability('p')), sample(0, reachability('p'))],
      new Date(at(100)),
    )

    expect(view.gaps).toHaveLength(1)
    expect(view.gaps[0]?.from).toBe(at(0))
  })
})

describe('coverage', () => {
  it('reads "3 samples recorded of about 3 expected" for samples at 10:00, 10:30 and 11:00', () => {
    const samples = [0, 30, 60].map(m => sample(m, reachability('p')))
    const view = buildAppView('keeweb', samples, new Date(at(60)))

    expect(coverageLabel(view.coverage)).toBe('3 samples recorded of about 3 expected')
  })

  it('reads "1 sample recorded of about 1 expected" for a lone bootstrap sample', () => {
    const view = buildAppView('keeweb', [sample(0, reachability('p'))], new Date(at(0)))

    expect(coverageLabel(view.coverage)).toBe('1 sample recorded of about 1 expected')
  })

  it('reads "100 samples recorded of about 337 expected" for a 7-day window', () => {
    const samples = Array.from({length: 100}, (_, index) => sample(index * 30, reachability('p')))
    const view = buildAppView('keeweb', samples, new Date(T0 + 7 * 24 * 60 * MINUTE))

    expect(view.coverage.recorded).toBe(100)
    expect(view.coverage.expected).toBe(337)
    expect(coverageLabel(view.coverage)).toBe('100 samples recorded of about 337 expected')
  })

  it('starts the window at the first sample, or 90 days back, whichever is later', () => {
    const now = new Date(T0 + 120 * 24 * 60 * MINUTE)
    const old = sample(0, reachability('p'))
    const recent = {...sample(0, reachability('p')), t: new Date(now.getTime() - 60 * MINUTE).toISOString()}
    const view = buildAppView('keeweb', [old, recent], now)

    expect(view.coverage.recorded).toBe(1)
    expect(view.coverage.expected).toBe(3)
    expect(view.coverage.windowStart).toBe(recent.t)
  })

  it('caps the window at 90 days', () => {
    const now = new Date(T0 + 200 * 24 * 60 * MINUTE)
    const view = buildAppView(
      'keeweb',
      [{...sample(0, reachability('p')), t: new Date(now.getTime() - 100 * 24 * 60 * MINUTE).toISOString()}],
      now,
    )

    expect(view.coverage.recorded).toBe(0)
    expect(view.coverage.expected).toBe(90 * 48 + 1)
  })

  it('never renders a percentage', () => {
    const samples = [sample(0, reachability('p')), sample(30, reachability('f'))]
    const view = buildAppView('keeweb', samples, new Date(at(30)))
    const text = [
      view.verdictLabel,
      coverageLabel(view.coverage),
      ...view.observations.map(o => passLabel(o.counts)),
    ].join(' ')

    expect(text).not.toContain('%')
  })
})

describe('container health', () => {
  it('is not part of the public view: no cell and no observation row', () => {
    const samples = [sample(0, {'public-reachability': 'p', 'compose-services': 'f', 'deploy-state': 'p'})]
    const view = buildAppView('umami', samples, new Date(at(0)))

    expect(Object.keys(view.cells)).toEqual(['reachability', 'deploy-state', 'end-to-end'])
    expect(view.observations.map(o => o.id)).toEqual(['public-reachability', 'deploy-state'])
    // A recorded container failure never turns the public verdict red.
    expect(view.verdict).toBe('pass')
  })
})

describe('vpn', () => {
  it('reads reachability and end-to-end as not measured, and shows deploy state', () => {
    const samples = [
      sample(0, {'deploy-state': 'u'}, {'deploy-state': {reason: 'at_gate', since: at(-20)}}),
      sample(30, {'deploy-state': 'u'}, {'deploy-state': {reason: 'at_gate', since: at(-20)}}),
    ]
    const view = buildAppView('vpn', samples, new Date(at(30)))

    expect(view.cells.reachability.result).toBe('not_measured')
    expect(view.cells['end-to-end'].result).toBe('not_measured')
    expect(view.deploy.state).toBe('at_gate')
    expect(view.verdict).not.toBe('pass')
    expect(view.verdictLabel).toContain('not measured')
  })

  it('treats an explicitly recorded not_measured the same as an absent observation', () => {
    const view = buildAppView('vpn', [sample(0, {'public-reachability': 'n', 'deploy-state': 'p'})], new Date(at(0)))

    expect(view.cells.reachability.result).toBe('not_measured')
    expect(view.deploy.state).toBe('succeeded')
  })
})

describe('gateway', () => {
  const healthy = {'public-reachability': 'p', 'deploy-state': 'p'} as const

  it('never renders as fully healthy while end-to-end is not measured', () => {
    const samples = [sample(0, healthy, {'public-reachability': {statusCode: 200, contractVersion: '1.14.0'}})]
    const view = buildAppView('gateway', samples, new Date(at(0)))

    expect(view.cells.reachability.result).toBe('pass')
    expect(view.cells['end-to-end'].result).toBe('not_measured')
    expect(view.verdict).toBe('partial')
    expect(view.verdictLabel).toBe('Reachable; model route not measured')
  })

  it('still fails when reachability fails', () => {
    const view = buildAppView(
      'gateway',
      [sample(0, {'public-reachability': 'f', 'deploy-state': 'p'})],
      new Date(at(0)),
    )

    expect(view.verdict).toBe('fail')
  })
})

describe('deploy state', () => {
  it('shows at_gate with its since time', () => {
    const view = buildAppView(
      'vpn',
      [sample(0, {'deploy-state': 'u'}, {'deploy-state': {reason: 'at_gate', since: at(-45)}})],
      new Date(at(0)),
    )

    expect(view.deploy).toMatchObject({state: 'at_gate', since: at(-45)})
    expect(view.deploy.label).toBe('Waiting at the approval gate')
  })

  it('shows running, none, succeeded and failed', () => {
    const state = (r: 'p' | 'f' | 'u' | 'n', reason?: string) =>
      buildAppView(
        'keeweb',
        [
          sample(
            0,
            {'public-reachability': 'p', 'deploy-state': r},
            reason === undefined ? undefined : {'deploy-state': {reason}},
          ),
        ],
        new Date(at(0)),
      ).deploy.state

    expect(state('u', 'running')).toBe('running')
    expect(state('n', 'none')).toBe('none')
    expect(state('p')).toBe('succeeded')
    expect(state('f')).toBe('failed')
    expect(state('u', 'api-error')).toBe('unknown')
  })

  it('does not call a deploy waiting at the gate "unknown" in the verdict', () => {
    const view = buildAppView(
      'keeweb',
      [
        sample(
          0,
          {'public-reachability': 'p', 'deploy-state': 'u'},
          {'deploy-state': {reason: 'at_gate', since: at(-5)}},
        ),
      ],
      new Date(at(0)),
    )

    expect(view.verdict).toBe('partial')
    expect(view.verdictLabel).toContain('approval')
  })
})

describe('deploy verdict', () => {
  const claimsDeploy = (label: string) => /deploy succeeded/i.test(label)

  it('claims "last deploy succeeded" only when the deploy state is succeeded', () => {
    const view = buildAppView('keeweb', [sample(0, reachability('p'))], new Date(at(0)))

    expect(view.deploy.state).toBe('succeeded')
    expect(view.verdict).toBe('pass')
    expect(view.verdictLabel).toContain('last deploy succeeded')
  })

  it('is not "Checks passed" when reachability passes but the deploy observation is absent', () => {
    const view = buildAppView('keeweb', [sample(0, {'public-reachability': 'p'})], new Date(at(0)))

    expect(view.deploy.state).toBe('not_measured')
    expect(view.verdict).not.toBe('pass')
    expect(claimsDeploy(view.verdictLabel)).toBe(false)
  })

  it('is partial when the deploy state is not_measured', () => {
    const view = buildAppView('keeweb', [sample(0, {'public-reachability': 'p', 'deploy-state': 'n'})], new Date(at(0)))

    expect(view.verdict).toBe('partial')
    expect(view.verdictLabel).toBe('Reachable; deploy state not measured')
  })

  it('is unknown when the deploy state is unknown for a reason other than the gate or a running deploy', () => {
    const view = buildAppView(
      'keeweb',
      [sample(0, {'public-reachability': 'p', 'deploy-state': 'u'}, {'deploy-state': {reason: 'api-error'}})],
      new Date(at(0)),
    )

    expect(view.verdict).toBe('unknown')
    expect(view.verdictLabel).toContain('Deploy state')
  })

  it('does not claim a succeeded deploy for a deployment that never ran', () => {
    const view = buildAppView(
      'keeweb',
      [sample(0, {'public-reachability': 'p', 'deploy-state': 'n'}, {'deploy-state': {reason: 'none'}})],
      new Date(at(0)),
    )

    expect(view.verdict).toBe('partial')
    expect(claimsDeploy(view.verdictLabel)).toBe(false)
  })
})

describe('end-to-end probe', () => {
  const route = (code: 'p' | 'f' | 'u', probeMinutes: number, reason: string) =>
    sample(
      60,
      {'public-reachability': 'p', 'deploy-state': 'p', 'provider-route': code},
      {'provider-route': {reason, probeAt: at(probeMinutes)}},
    )

  it('reports the probe age from probeAt, relative to the sample', () => {
    const view = buildAppView('cliproxy', [route('p', 50, 'ok')], new Date(at(60)))

    expect(view.endToEnd).toMatchObject({
      result: 'pass',
      measured: true,
      probeAt: at(50),
      probeAgeMinutes: 10,
      stale: false,
    })
    expect(view.verdict).toBe('pass')
  })

  it('flags a stale probe', () => {
    const view = buildAppView('cliproxy', [route('u', 0, 'stale')], new Date(at(60)))

    expect(view.endToEnd).toMatchObject({result: 'unknown', probeAgeMinutes: 60, stale: true})
    expect(view.verdict).toBe('unknown')
  })

  it('flags a probe older than the gap threshold even when its result passed', () => {
    const view = buildAppView('cliproxy', [route('p', 0, 'ok')], new Date(at(60)))

    expect(view.endToEnd.stale).toBe(true)
  })

  it('reports a dead route as failing', () => {
    const view = buildAppView('cliproxy', [route('f', 55, 'dead')], new Date(at(60)))

    expect(view.verdict).toBe('fail')
    expect(view.verdictLabel).toContain('End-to-end')
  })

  it('has no probe time when end-to-end is not measured', () => {
    const view = buildAppView('keeweb', [sample(0, reachability('p'))], new Date(at(0)))

    expect(view.endToEnd).toMatchObject({measured: false, result: 'not_measured', stale: false})
    expect(view.endToEnd.probeAt).toBeUndefined()
  })
})

describe('end-to-end probe: the Go route never blends into the Claude cell', () => {
  const both = (
    claude: 'p' | 'f' | 'u',
    go: 'p' | 'f' | 'u',
    detail: HistorySample['d'] = {},
    minutes = 60,
  ): HistorySample =>
    sample(
      minutes,
      {'public-reachability': 'p', 'deploy-state': 'p', 'provider-route': claude, 'provider-route-go': go},
      {'provider-route': {reason: 'ok', probeAt: at(minutes - 10)}, ...detail},
    )

  it('builds the cell, verdict and endToEnd from provider-route when provider-route-go fails', () => {
    const withGoFail = buildAppView(
      'cliproxy',
      [both('p', 'f', {'provider-route-go': {reason: 'quota-or-billing', probeAt: at(50)}})],
      new Date(at(60)),
    )
    const claudeOnly = buildAppView(
      'cliproxy',
      [
        sample(
          60,
          {'public-reachability': 'p', 'deploy-state': 'p', 'provider-route': 'p'},
          {'provider-route': {reason: 'ok', probeAt: at(50)}},
        ),
      ],
      new Date(at(60)),
    )

    expect(withGoFail.cells['end-to-end']).toEqual(claudeOnly.cells['end-to-end'])
    expect(withGoFail.cells['end-to-end'].result).toBe('pass')
    expect(withGoFail.endToEnd).toEqual(claudeOnly.endToEnd)
    expect(withGoFail.verdict).toBe('pass')
    expect(withGoFail.verdictLabel).toBe(claudeOnly.verdictLabel)
  })

  it('still fails on a dead Claude route when Go passes', () => {
    const view = buildAppView('cliproxy', [both('f', 'p')], new Date(at(60)))

    expect(view.cells['end-to-end'].result).toBe('fail')
    expect(view.verdict).toBe('fail')
  })

  it('takes the stale flag from the Claude probe only, in both directions', () => {
    const goStale = buildAppView(
      'cliproxy',
      [both('p', 'u', {'provider-route-go': {reason: 'stale', probeAt: at(0)}})],
      new Date(at(60)),
    )
    const claudeStale = buildAppView(
      'cliproxy',
      [
        sample(
          60,
          {
            'public-reachability': 'p',
            'deploy-state': 'p',
            'provider-route': 'u',
            'provider-route-go': 'p',
          },
          {'provider-route': {reason: 'stale', probeAt: at(0)}, 'provider-route-go': {reason: 'ok', probeAt: at(55)}},
        ),
      ],
      new Date(at(60)),
    )

    expect(goStale.endToEnd.stale).toBe(false)
    expect(goStale.cells['end-to-end'].note).toBeUndefined()
    expect(goStale.verdict).toBe('pass')
    expect(claudeStale.endToEnd.stale).toBe(true)
    expect(claudeStale.verdict).toBe('unknown')
  })

  it('does not publish a Go row in Phase 1', () => {
    const view = buildAppView('cliproxy', [both('p', 'p')], new Date(at(60)))

    expect(view.observations.map(observation => observation.id)).toEqual([
      'public-reachability',
      'deploy-state',
      'provider-route',
    ])
  })

  it('renders an older sample that predates provider-route-go exactly as before', () => {
    const older = sample(
      60,
      {'public-reachability': 'p', 'deploy-state': 'p', 'provider-route': 'p'},
      {'provider-route': {reason: 'ok', probeAt: at(50)}},
    )
    const view = buildAppView('cliproxy', [older], new Date(at(60)))

    expect(view.endToEnd).toMatchObject({result: 'pass', measured: true, stale: false})
    expect(view.verdict).toBe('pass')
    expect(view.cells['end-to-end'].result).toBe('pass')
  })
})

describe('generatedAt staleness', () => {
  it('is stale only after 90 minutes', () => {
    expect(isStale(at(0), new Date(at(90)))).toBe(false)
    expect(isStale(at(0), new Date(at(91)))).toBe(true)
  })
})

describe('buildHistoryView', () => {
  it('builds a view for every app, with no samples reading as unknown', () => {
    const empty = {keeweb: [], cliproxy: [], gateway: [], umami: [], dashboard: [], vpn: [], broker: []}
    const views = buildHistoryView({meta: {schemaVersion: 1, lastSampleAt: at(0)}, apps: empty}, new Date(at(0)))

    expect(Object.keys(views)).toEqual(['keeweb', 'cliproxy', 'gateway', 'umami', 'dashboard', 'vpn', 'broker'])
    expect(views.keeweb.verdict).toBe('unknown')
    expect(views.keeweb.latestSampleAt).toBeUndefined()
  })
})
