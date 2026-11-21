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

  // Tripwire, not a rule: the public status pages hide an app named here. Delete this test in the follow-up
  // change that takes `traces` off the list, after its first deploy has succeeded.
  it('holds traces until its first deploy', () => {
    expect(APPS_NOT_YET_DEPLOYED).toEqual(['traces'])
  })
})
