import {describe, expect, it} from 'bun:test'

import {APP_IDS, APPS_ADDED_AFTER_V1, APPS_NOT_YET_DEPLOYED} from './history-schema'

describe('APPS_ADDED_AFTER_V1', () => {
  it('lists only known apps', () => {
    for (const app of APPS_ADDED_AFTER_V1) expect(APP_IDS).toContain(app)
  })
})

describe('APPS_NOT_YET_DEPLOYED', () => {
  it('lists only known apps', () => {
    for (const app of APPS_NOT_YET_DEPLOYED) expect(APP_IDS).toContain(app)
  })

  // Tripwire, not a rule: every app is deployed, so none is held off the public status pages. Replace it with the
  // new app's entry in the change that adds an app to the list.
  it('holds no app: every app is deployed', () => {
    expect(APPS_NOT_YET_DEPLOYED).toEqual([])
  })
})
