import type {AppId, HistoryMeta} from '@marcusrbrown/infra-shared/status/history-schema'
import type {HistorySourceKind} from './history-source'
import type {AppView} from './history-view'

import {loadStatusHistory} from './history-source'
import {buildHistoryView} from './history-view'

export interface StatusData {
  source: HistorySourceKind
  meta: HistoryMeta
  views: Record<AppId, AppView>
  /** Build time for a real artifact. The fixture is frozen in time, so it is viewed as of its newest sample. */
  now: Date
}

/** Load and validate history, then build every app's view. Throws if history is missing or invalid. */
export function loadStatusData(): StatusData {
  const {history, source} = loadStatusHistory()
  const now = source === 'fixture' ? new Date(history.meta.lastSampleAt) : new Date()
  return {source, meta: history.meta, views: buildHistoryView(history, now), now}
}
