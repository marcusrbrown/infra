import type {AppCollection} from './collect'
import type {AppId, AppStatus, Observation, ObservationKind, ObservationResult, ObservationSource} from './observation'

import {notMeasured, observe} from './collect'
import {PUBLIC_REACHABILITY_ID} from './public-probes'

/**
 * Who supplies a declared observation:
 * - `probe`: the shared public probe
 * - `collector`: the app's SSH/API collector
 * - `github`: the GitHub Deployments reader or the auth monitor reader
 * - `not-applicable`: the app has nothing to measure; reported as not measured
 */
export type ObservationOwner = 'probe' | 'collector' | 'github' | 'not-applicable'

export interface DeclaredObservation {
  id: string
  kind: ObservationKind
  /** Source used when the observation has to be synthesized because its producer failed. */
  source: ObservationSource
  owner: ObservationOwner
}

const publicReachability: DeclaredObservation = {
  id: PUBLIC_REACHABILITY_ID,
  kind: 'reachability',
  source: 'http',
  owner: 'probe',
}

const deployState: DeclaredObservation = {
  id: 'deploy-state',
  kind: 'deploy-state',
  source: 'github-api',
  owner: 'github',
}

const composeServices: DeclaredObservation = {
  id: 'compose-services',
  kind: 'container-health',
  source: 'ssh',
  owner: 'collector',
}

/** Every app always lists the observations it owns, so a failure stays inside the observation that failed. */
export const DECLARED_OBSERVATIONS: Record<AppId, readonly DeclaredObservation[]> = {
  keeweb: [publicReachability, deployState],
  cliproxy: [
    publicReachability,
    {id: 'container-running', kind: 'container-health', source: 'ssh', owner: 'collector'},
    deployState,
    {id: 'provider-route', kind: 'end-to-end', source: 'monitor', owner: 'github'},
  ],
  gateway: [
    publicReachability,
    composeServices,
    {id: 'workspace-memory', kind: 'resource', source: 'ssh', owner: 'collector'},
    deployState,
  ],
  umami: [publicReachability, composeServices, deployState],
  dashboard: [publicReachability, composeServices, deployState],
  vpn: [
    {id: PUBLIC_REACHABILITY_ID, kind: 'reachability', source: 'config', owner: 'not-applicable'},
    {id: 'wireguard-interface', kind: 'container-health', source: 'ssh', owner: 'collector'},
    deployState,
    {id: 'egress-route', kind: 'end-to-end', source: 'config', owner: 'not-applicable'},
  ],
  broker: [publicReachability, deployState],
}

/** The declaration for one of an app's observations; collectors build their observations from it. */
export function declaredObservation(app: AppId, id: string): DeclaredObservation {
  const declared = DECLARED_OBSERVATIONS[app].find(entry => entry.id === id)
  if (declared === undefined) {
    throw new Error(`${app} does not declare observation "${id}"`)
  }

  return declared
}

export type ProbeOutcome = {kind: 'ok'; observation: Observation} | {kind: 'failed'} | {kind: 'none'}

export type CollectorOutcome =
  | {kind: 'ok'; collection: AppCollection}
  | {kind: 'missing-config'}
  | {kind: 'failed'}
  | {kind: 'timeout'}
  | {kind: 'none'}

function unknown(declared: DeclaredObservation, reason: string, now: Date): Observation {
  return observe(declared, 'unknown', {detail: {reason}, now})
}

function resolveObservation(
  declared: DeclaredObservation,
  probe: ProbeOutcome,
  collector: CollectorOutcome,
  github: readonly Observation[],
  now: Date,
): Observation {
  switch (declared.owner) {
    case 'not-applicable':
      return notMeasured(declared, declared.owner)
    case 'github':
      return github.find(observation => observation.id === declared.id) ?? unknown(declared, 'missing-result', now)
    case 'probe':
      if (probe.kind === 'ok') return probe.observation
      return unknown(declared, probe.kind === 'failed' ? 'check-failed' : 'missing-result', now)
    case 'collector':
      if (collector.kind === 'missing-config') return notMeasured(declared, 'missing-config')
      if (collector.kind === 'failed') return unknown(declared, 'check-failed', now)
      if (collector.kind === 'timeout') return unknown(declared, 'timeout', now)
      if (collector.kind === 'none') return unknown(declared, 'missing-result', now)
      return (
        collector.collection.observations.find(observation => observation.id === declared.id) ??
        unknown(declared, 'missing-result', now)
      )
  }
}

/**
 * Build one app's entry from its declaration: every declared observation appears exactly once, in
 * declared order. Observations a collector returns but the app did not declare are dropped. `github` holds
 * what the GitHub readers produced for this app; a declared observation they did not supply is `unknown`.
 */
export function assembleAppStatus(
  app: AppId,
  probe: ProbeOutcome,
  collector: CollectorOutcome,
  now: Date,
  github: readonly Observation[] = [],
): AppStatus {
  return {
    app,
    observations: DECLARED_OBSERVATIONS[app].map(declared =>
      resolveObservation(declared, probe, collector, github, now),
    ),
    facts: collector.kind === 'ok' ? collector.collection.facts : {},
  }
}

const SEVERITY: Record<ObservationResult, number> = {pass: 0, not_measured: 1, unknown: 2, fail: 3}

/** The worst result among an app's observations of one kind, or `undefined` when it declares none. */
export function worstResult(app: AppStatus, kind: ObservationKind): ObservationResult | undefined {
  let worst: ObservationResult | undefined
  for (const observation of app.observations) {
    if (observation.kind !== kind) continue
    if (worst === undefined || SEVERITY[observation.result] > SEVERITY[worst]) {
      worst = observation.result
    }
  }

  return worst
}
