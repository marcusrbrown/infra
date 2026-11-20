import {describe, expect, it} from 'bun:test'

import {APP_IDS, APPS_ADDED_AFTER_V1} from './history-schema'

describe('APPS_ADDED_AFTER_V1', () => {
  it('lists only known apps', () => {
    for (const app of APPS_ADDED_AFTER_V1) expect(APP_IDS).toContain(app)
  })
})
