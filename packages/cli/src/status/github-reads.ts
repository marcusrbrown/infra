import type {GitHubReadOptions} from './github-api'
import type {AppId, Observation} from './observation'

import {observe} from './collect'
import {declaredObservation} from './declared'
import {GO_MONITOR_OBSERVATION_ID, MONITOR_OBSERVATION_ID} from './monitor-state'

/** The two GitHub-backed readers, shared by unified `status` and `status snapshot`. */
export interface GithubReaders {
  readDeployStates: (options: GitHubReadOptions) => Promise<Partial<Record<AppId, Observation>>>
  /** One observation per cliproxy route: `provider-route` and `provider-route-go`. */
  readMonitorState: (options: GitHubReadOptions) => Promise<Observation[]>
}

export interface GithubReads {
  deploy: PromiseSettledResult<Partial<Record<AppId, Observation>>>
  monitor: PromiseSettledResult<Observation[]>
}

/** Run both readers concurrently. Never rejects: a throwing reader is recorded and becomes `unknown` later. */
export async function runGithubReads(readers: GithubReaders, options: GitHubReadOptions): Promise<GithubReads> {
  const [deploy, monitor] = await Promise.allSettled([
    readers.readDeployStates(options),
    readers.readMonitorState(options),
  ])
  return {deploy, monitor}
}

function checkFailed(app: AppId, id: string, now: Date): Observation {
  return observe(declaredObservation(app, id), 'unknown', {detail: {reason: 'check-failed'}, now})
}

/** The GitHub-owned observations for one app: `deploy-state` for all, plus cliproxy's two route observations. */
export function githubObservationsFor(app: AppId, reads: GithubReads, now: Date): Observation[] {
  const observations: Observation[] = []

  if (reads.deploy.status === 'rejected') {
    observations.push(checkFailed(app, 'deploy-state', now))
  } else {
    const deployState = reads.deploy.value[app]
    if (deployState !== undefined) observations.push(deployState)
  }

  if (app === 'cliproxy') {
    if (reads.monitor.status === 'rejected') {
      observations.push(checkFailed(app, MONITOR_OBSERVATION_ID, now), checkFailed(app, GO_MONITOR_OBSERVATION_ID, now))
    } else {
      observations.push(...reads.monitor.value)
    }
  }

  return observations
}
