import {APP_IDS, APPS_NOT_YET_DEPLOYED} from '@marcusrbrown/infra-shared/status/history-schema'
import {describe, expect, it} from 'bun:test'

import {SERVICES} from './services'

describe('SERVICES', () => {
  it('has an entry for every app', () => {
    expect(Object.keys(SERVICES).toSorted()).toEqual([...APP_IDS].toSorted())
  })

  // The page says "Not yet deployed" itself for an app on the list; a summary that says it for a deployed app is wrong.
  it('says "not yet deployed" only for an app on the not-yet-deployed list', () => {
    for (const app of APP_IDS) {
      const claims = /not yet deployed/i.test(SERVICES[app].summary)
      expect({app, claims}).toEqual({app, claims: APPS_NOT_YET_DEPLOYED.includes(app)})
    }
  })

  it('describes the trace stack by its public surface only: the ingest endpoint and the health path', () => {
    const {summary} = SERVICES.traces

    expect(summary).toContain('ingest')
    expect(summary).toContain('health')
    expect(summary).not.toMatch(/langfuse|grafana/i)
    expect(summary).not.toMatch(/\d{1,3}(?:\.\d{1,3}){3}/)
  })
})
