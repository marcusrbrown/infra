import type {AppStatus} from './observation'
import {OBSERVATION_KINDS_BY_ID} from '@marcusrbrown/infra-shared/status/history-schema'
import {describe, expect, it} from 'bun:test'
import {composeObservation, notMeasured, observe} from './collect'
import {assembleAppStatus, DECLARED_OBSERVATIONS, declaredObservation, worstResult} from './declared'
import {APP_IDS, appStatusSchema, observationSchema} from './observation'

const NOW = new Date('2026-11-01T12:00:00.000Z')

describe('DECLARED_OBSERVATIONS', () => {
  it('declares unique ids per app and covers every app', () => {
    expect(Object.keys(DECLARED_OBSERVATIONS).sort()).toEqual([...APP_IDS].sort())
    for (const app of APP_IDS) {
      const ids = DECLARED_OBSERVATIONS[app].map(declared => declared.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('matches the id-to-kind map the public site reads from the shared history schema', () => {
    for (const app of APP_IDS) {
      const declared = Object.fromEntries(DECLARED_OBSERVATIONS[app].map(entry => [entry.id, entry.kind]))
      expect(OBSERVATION_KINDS_BY_ID[app]).toEqual(declared)
    }
  })

  it('looks up a declaration and rejects an undeclared id', () => {
    expect(declaredObservation('gateway', 'workspace-memory')).toMatchObject({kind: 'resource', owner: 'collector'})
    expect(() => declaredObservation('keeweb', 'workspace-memory')).toThrow('keeweb does not declare')
  })
})

describe('assembleAppStatus', () => {
  it('produces schema-valid entries for every app in every outcome combination', () => {
    for (const app of APP_IDS) {
      for (const collector of [{kind: 'missing-config'}, {kind: 'failed'}, {kind: 'none'}] as const) {
        for (const probe of [{kind: 'failed'}, {kind: 'none'}] as const) {
          expect(appStatusSchema.safeParse(assembleAppStatus(app, probe, collector, NOW)).success).toBe(true)
        }
      }
    }
  })

  it('keeps the collector facts only when the collector succeeded', () => {
    const collection = {observations: [], facts: {a: 1}}

    expect(assembleAppStatus('keeweb', {kind: 'none'}, {kind: 'ok', collection}, NOW).facts).toEqual({a: 1})
    expect(assembleAppStatus('keeweb', {kind: 'none'}, {kind: 'failed'}, NOW).facts).toEqual({})
  })

  it('uses the declared source for a failed collector and config for a missing one', () => {
    const failed = assembleAppStatus('gateway', {kind: 'none'}, {kind: 'failed'}, NOW)
    const missing = assembleAppStatus('gateway', {kind: 'none'}, {kind: 'missing-config'}, NOW)

    expect(failed.observations.find(entry => entry.id === 'compose-services')).toMatchObject({
      source: 'ssh',
      result: 'unknown',
      observedAt: NOW.toISOString(),
    })
    expect(missing.observations.find(entry => entry.id === 'compose-services')).toMatchObject({
      source: 'config',
      result: 'not_measured',
      observedAt: null,
    })
  })
})

describe('worstResult', () => {
  const entry = (result: 'pass' | 'fail' | 'unknown' | 'not_measured') =>
    result === 'not_measured'
      ? notMeasured({id: 'x', kind: 'reachability'}, 'missing-config')
      : observe({id: 'x', kind: 'reachability', source: 'http'}, result, {now: NOW})

  const app = (...results: ('pass' | 'fail' | 'unknown' | 'not_measured')[]): AppStatus => ({
    app: 'keeweb',
    observations: results.map((result, index) => ({...entry(result), id: `x${index}`})),
    facts: {},
  })

  it('orders fail above unknown above not_measured above pass', () => {
    expect(worstResult(app('pass', 'not_measured', 'unknown', 'fail'), 'reachability')).toBe('fail')
    expect(worstResult(app('pass', 'not_measured', 'unknown'), 'reachability')).toBe('unknown')
    expect(worstResult(app('pass', 'not_measured'), 'reachability')).toBe('not_measured')
    expect(worstResult(app('pass', 'pass'), 'reachability')).toBe('pass')
  })

  it('returns undefined for a kind the app does not declare', () => {
    expect(worstResult(app('pass'), 'resource')).toBeUndefined()
  })
})

describe('collect helpers', () => {
  it('builds schema-valid observations and never leaks the declaration owner', () => {
    const observation = observe(declaredObservation('gateway', 'compose-services'), 'pass', {now: NOW})

    expect(observationSchema.safeParse(observation).success).toBe(true)
    expect('owner' in observation).toBe(false)
  })

  it('omits detail when none is given', () => {
    expect('detail' in observe({id: 'x', kind: 'resource', source: 'ssh'}, 'pass', {now: NOW})).toBe(false)
  })

  it('maps compose results: unknown on SSH error, fail on empty or degraded, pass when ok', () => {
    const spec = declaredObservation('umami', 'compose-services')
    const service = {service: 'umami', state: 'running', health: 'healthy'}

    expect(composeObservation(spec, {ok: false, services: [], error: 'boom'})).toMatchObject({result: 'unknown'})
    expect(composeObservation(spec, {ok: true, services: []})).toMatchObject({result: 'fail'})
    expect(composeObservation(spec, {ok: false, services: [service]})).toMatchObject({result: 'fail'})
    expect(composeObservation(spec, {ok: true, services: [service]})).toMatchObject({result: 'pass'})
  })
})
