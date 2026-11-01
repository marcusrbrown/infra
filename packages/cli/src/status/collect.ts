import type {JsonValue, Observation, ObservationDetail, ObservationKind, ObservationSource} from './observation'

/** What one per-app collector hands back to the unified `status` command. */
export interface AppCollection {
  observations: Observation[]
  facts: Record<string, JsonValue>
}

export interface ObservationSpec {
  id: string
  kind: ObservationKind
  source: ObservationSource
}

export function observe(
  spec: ObservationSpec,
  result: 'pass' | 'fail' | 'unknown',
  options: {detail?: ObservationDetail; now?: Date} = {},
): Observation {
  return {
    id: spec.id,
    kind: spec.kind,
    source: spec.source,
    result,
    observedAt: (options.now ?? new Date()).toISOString(),
    ...(options.detail === undefined ? {} : {detail: options.detail}),
  }
}

/** Never attempted: missing config or not applicable. The source is always `config`. */
export function notMeasured(spec: Pick<ObservationSpec, 'id' | 'kind'>, reason: string): Observation {
  return {id: spec.id, kind: spec.kind, source: 'config', result: 'not_measured', observedAt: null, detail: {reason}}
}

export interface ComposeServiceRow {
  service: string
  state: string
  health: string
}

export interface ComposeResult {
  ok: boolean
  services: ComposeServiceRow[]
  error?: string
}

/**
 * Container health from a `docker compose ps` result.
 * - SSH or parse failure → `unknown`: the state could not be observed.
 * - No services and no error → `fail`: nothing is running.
 * - Any service not running (or unhealthy, where the app checks health) → `fail`.
 */
export function composeObservation(spec: ObservationSpec, result: ComposeResult): Observation {
  if (result.services.length === 0) {
    return result.error === undefined
      ? observe(spec, 'fail', {detail: {reason: 'no-services'}})
      : observe(spec, 'unknown', {detail: {reason: 'compose-failed'}})
  }

  return result.ok ? observe(spec, 'pass') : observe(spec, 'fail', {detail: {reason: 'degraded'}})
}

export function servicesFact(services: ComposeServiceRow[]): JsonValue {
  return services.map(({service, state, health}) => ({service, state, health}))
}
