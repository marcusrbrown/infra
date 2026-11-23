import {describe, expect, it} from 'bun:test'

// The collector config is the safety boundary between a leaked sender token and the stores, and
// between a trace's content and Tempo. These tests read the real file and assert its shape.

const GROUPS = ['marcusrbrown', 'fro-bot', 'workstation'] as const

// The six `gen_ai` content keys (OpenTelemetry GenAI conventions). None may reach Tempo.
const CONTENT_KEYS = [
  'gen_ai.system_instructions',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
] as const

const MIB = 1024 * 1024
const GIB = 1024 * MIB

type Rec = Record<string, unknown>

function record(value: unknown, label: string): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not a mapping`)
  return value as Rec
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a list`)
  return value
}

function strings(value: unknown, label: string): string[] {
  return list(value, label).map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${label}[${index}] is not a string`)
    return item
  })
}

const text = await Bun.file(new URL('otelcol.yaml', import.meta.url)).text()
const openIngest = await Bun.file(new URL('ingest/open.caddy', import.meta.url)).text()
const config = record(Bun.YAML.parse(text), 'otelcol.yaml')

const extensions = record(config.extensions, 'extensions')
const receivers = record(config.receivers, 'receivers')
const processors = record(config.processors, 'processors')
const exporters = record(config.exporters, 'exporters')
const service = record(config.service, 'service')
const pipelines = record(service.pipelines, 'service.pipelines')

interface PipelineShape {
  receivers: string[]
  processors: string[]
  exporters: string[]
}

function pipeline(name: string): PipelineShape {
  const body = record(pipelines[name], `pipeline ${name}`)
  return {
    receivers: strings(body.receivers ?? [], `${name}.receivers`),
    processors: strings(body.processors ?? [], `${name}.processors`),
    exporters: strings(body.exporters ?? [], `${name}.exporters`),
  }
}

function componentType(id: string): string {
  return id.split('/')[0] ?? id
}

// Names of every processor that a config wires into a pipeline or declares, by type.
function forbiddenProcessors(cfg: Rec): string[] {
  const forbidden = new Set(['batch', 'transform'])
  const declared = Object.keys(record(cfg.processors ?? {}, 'processors'))
  const wired = Object.values(record(record(cfg.service, 'service').pipelines, 'pipelines')).flatMap(body =>
    strings(record(body, 'pipeline').processors ?? [], 'processors'),
  )
  return [...declared, ...wired].filter(id => forbidden.has(componentType(id)))
}

function receiverHttp(id: string): Rec {
  return record(record(record(receivers[id], `receiver ${id}`).protocols, 'protocols').http, 'http')
}

function endpointPort(endpoint: unknown): number {
  if (typeof endpoint !== 'string') throw new Error('endpoint is not a string')
  return Number(endpoint.slice(endpoint.lastIndexOf(':') + 1))
}

describe('collector receivers', () => {
  it.each(GROUPS)('%s has its own port, path and token file', group => {
    const http = receiverHttp(`otlp/${group}`)
    expect(http.traces_url_path).toBe(`/${group}/v1/traces`)
    expect(record(http.auth, 'auth').authenticator).toBe(`bearertokenauth/${group}`)

    const auth = record(extensions[`bearertokenauth/${group}`], `bearertokenauth/${group}`)
    expect(auth.filename).toBe(`/etc/otelcol/tokens/${group}/token`)
  })

  it('gives every receiver a distinct port, and Caddy proxies each group to its own', () => {
    const ports = [...GROUPS.map(group => endpointPort(receiverHttp(`otlp/${group}`).endpoint)), 4414]
    expect(endpointPort(receiverHttp('otlp/canary').endpoint)).toBe(4414)
    expect(new Set(ports).size).toBe(ports.length)

    for (const group of GROUPS) {
      const port = endpointPort(receiverHttp(`otlp/${group}`).endpoint)
      const route = new RegExp(String.raw`handle /${group}/v1/traces \{[^}]*reverse_proxy collector:${port} `)
      expect(openIngest).toMatch(route)
    }
  })

  it('uses a token file in its own directory for every group', () => {
    const files = GROUPS.map(group => record(extensions[`bearertokenauth/${group}`], group).filename)
    expect(new Set(files).size).toBe(GROUPS.length)
  })

  it('lists every extension it wires in service.extensions', () => {
    const wired = strings(service.extensions, 'service.extensions')
    expect(wired).toContain('health_check')
    expect(wired).toContain('file_storage/queue')
    for (const group of GROUPS) expect(wired).toContain(`bearertokenauth/${group}`)
    for (const id of wired) expect(extensions[id]).toBeDefined()
  })

  it('caps the decompressed request body at 8 MiB on every receiver', () => {
    for (const id of Object.keys(receivers)) expect(receiverHttp(id).max_request_body_size).toBe(8 * MIB)
  })

  it('keeps the canary receiver private: no auth, no limiter, own pipeline', () => {
    expect(receiverHttp('otlp/canary').auth).toBeUndefined()
    const canary = pipeline('traces/intake-canary')
    expect(canary.receivers).toEqual(['otlp/canary'])
    expect(canary.processors).toEqual(['resource/canary'])
    expect(canary.processors.some(id => componentType(id) === 'ratelimit')).toBe(false)
  })

  it('exposes the health check and self-metrics', () => {
    expect(record(extensions.health_check, 'health_check').endpoint).toBe('0.0.0.0:13133')
    const readers = list(
      record(service.telemetry, 'telemetry').metrics ? record(record(service.telemetry, 't').metrics, 'm').readers : [],
      'readers',
    )
    expect(JSON.stringify(readers)).toContain('"port":8888')
  })
})

describe('collector intake pipelines', () => {
  it.each(GROUPS)('%s: processors are exactly the byte limiter and the group stamp', group => {
    const intake = pipeline(`traces/intake-${group}`)
    expect(intake.receivers).toEqual([`otlp/${group}`])
    // Refuse first, then stamp: a refused batch is never mutated.
    expect(intake.processors).toEqual([`ratelimit/${group}`, `resource/${group}`])
  })

  it.each(GROUPS)('%s: the limiter counts bytes with a 1 GiB allowance refilled at 32 KiB/s', group => {
    const limiter = record(processors[`ratelimit/${group}`], 'ratelimit')
    expect(limiter.strategy).toBe('bytes')
    expect(limiter.burst).toBe(GIB)
    expect(limiter.rate).toBe(32 * 1024)
    expect(limiter.throttle_behavior).toBe('error')
    // A group's own bucket: no shared metadata key.
    expect(limiter.metadata_keys).toBeUndefined()
  })

  it.each(GROUPS)('%s: the stamp overwrites any sender.group the sender supplied', group => {
    const stamp = record(processors[`resource/${group}`], 'resource')
    expect(stamp.attributes).toEqual([{key: 'sender.group', value: group, action: 'upsert'}])
  })

  it.each(GROUPS)('%s: exports to its own Langfuse exporter and to the Tempo connector only', group => {
    expect(pipeline(`traces/intake-${group}`).exporters).toEqual([`otlp_http/langfuse-${group}`, 'forward/tempo'])
  })

  it('gives a Langfuse exporter to exactly one pipeline each, never another group’s', () => {
    for (const id of Object.keys(exporters).filter(name => name.startsWith('otlp_http/langfuse-'))) {
      const users = Object.keys(pipelines).filter(name => pipeline(name).exporters.includes(id))
      expect(users).toEqual([`traces/intake-${id.slice('otlp_http/langfuse-'.length)}`])
    }
  })

  it('sends the whole trace to Langfuse: nothing but the intake processors runs before a Langfuse exporter', () => {
    const allowed = new Set(['ratelimit', 'resource'])
    for (const name of Object.keys(pipelines)) {
      const body = pipeline(name)
      if (!body.exporters.some(id => id.startsWith('otlp_http/langfuse-'))) continue
      expect(body.processors.every(id => allowed.has(componentType(id)))).toBe(true)
      expect(body.processors.some(id => componentType(id) === 'redaction')).toBe(false)
    }
  })

  it('reads the Langfuse credential from a file, never from tracked text', () => {
    for (const id of Object.keys(exporters).filter(name => name.startsWith('otlp_http/langfuse-'))) {
      const headers = record(record(exporters[id], id).headers, 'headers')
      expect(headers.Authorization).toBe(`Basic $\{file:/etc/otelcol/secrets/langfuse-basic}`)
    }
    expect(text).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}/)
    expect(text).not.toMatch(/Bearer /)
  })
})

describe('collector Tempo branch', () => {
  const tempo = pipeline('traces/tempo')
  const redaction = record(processors['redaction/tempo'], 'redaction/tempo')
  const allowedKeys = strings(redaction.allowed_keys, 'allowed_keys')

  it('has one shared pipeline fed by the connector whose only processor is the keep-list', () => {
    expect(tempo.receivers).toEqual(['forward/tempo'])
    expect(tempo.processors).toEqual(['redaction/tempo'])
    expect(tempo.exporters).toEqual(['otlp_http/tempo'])
  })

  it('is a keep-list, not a delete-list, and adds no bookkeeping attributes', () => {
    expect(redaction.allow_all_keys).toBe(false)
    expect(redaction.summary).toBe('silent')
    expect(redaction.blocked_key_patterns).toBeUndefined()
    expect(redaction.ignored_keys).toBeUndefined()
    expect(redaction.ignored_key_patterns).toBeUndefined()
  })

  it('contains none of the six content keys', () => {
    for (const key of CONTENT_KEYS) expect(allowedKeys).not.toContain(key)
  })

  // Deliberately a copy of the YAML list: changing what reaches Tempo takes a second, deliberate edit here.
  const APPROVED_KEYS = [
    // Operation, provider, model
    'gen_ai.operation.name',
    'gen_ai.provider.name',
    'gen_ai.system',
    'gen_ai.request.model',
    'gen_ai.response.model',
    // Token counts
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
    'gen_ai.usage.total_tokens',
    'gen_ai.usage.cache_read.input_tokens',
    'gen_ai.usage.cache_creation.input_tokens',
    'gen_ai.usage.reasoning.output_tokens',
    'gen_ai.usage.prompt_tokens',
    'gen_ai.usage.completion_tokens',
    // Finish reasons
    'gen_ai.response.finish_reasons',
    // Tool name and call id
    'gen_ai.tool.name',
    'gen_ai.tool.call.id',
    'gen_ai.tool.type',
    // Agent name
    'gen_ai.agent.name',
    'gen_ai.agent.id',
    // Session id, under each name Langfuse and the GenAI conventions use
    'langfuse.session.id',
    'session.id',
    'gen_ai.conversation.id',
    // Run identity fields
    'langfuse.trace.metadata.repository',
    'langfuse.trace.metadata.run_id',
    'langfuse.trace.metadata.run_attempt',
    'langfuse.trace.metadata.job',
    'langfuse.trace.metadata.trigger',
    // Error type, and the exception event's type and message
    'error.type',
    'exception.type',
    'exception.message',
    // Fro Bot Action lifecycle: fixed codes and ids only
    'fro_bot.outcome',
    'fro_bot.reason',
    'fro_bot.cache.tier',
    'fro_bot.invocation.id',
    'fro_bot.agent.role',
    'fro_bot.gate',
    'fro_bot.result',
    // Resource attributes
    'sender.group',
    'service.name',
  ]

  it('allows exactly the approved keys: no extras, none missing, no duplicates', () => {
    expect(new Set(APPROVED_KEYS).size).toBe(APPROVED_KEYS.length)
    expect(new Set(allowedKeys).size).toBe(allowedKeys.length)
    expect([...allowedKeys].sort()).toEqual([...APPROVED_KEYS].sort())
  })

  it('does not sanitize span names or attribute values', () => {
    expect(redaction.url_sanitizer).toBeUndefined()
    expect(redaction.db_sanitizer).toBeUndefined()
    expect(redaction.blocked_values).toBeUndefined()
  })
})

describe('collector pipelines overall', () => {
  it('has no batch or transform processor anywhere', () => {
    expect(forbiddenProcessors(config)).toEqual([])
  })

  it('fails the check for a config that adds a batch or transform processor to a pipeline', () => {
    const mutated = structuredClone(config)
    const mutatedPipelines = record(record(mutated.service, 'service').pipelines, 'pipelines')
    const intake = record(mutatedPipelines['traces/intake-workstation'], 'intake')
    intake.processors = [...strings(intake.processors, 'processors'), 'batch']
    expect(forbiddenProcessors(mutated)).toEqual(['batch'])

    const withTransform = structuredClone(config)
    record(withTransform.processors, 'processors')['transform/x'] = {}
    expect(forbiddenProcessors(withTransform)).toEqual(['transform/x'])
  })

  it('wires every declared receiver, processor, exporter and connector into a pipeline', () => {
    const used = new Set(
      Object.keys(pipelines).flatMap(name => {
        const body = pipeline(name)
        return [...body.receivers, ...body.processors, ...body.exporters]
      }),
    )
    for (const id of [...Object.keys(receivers), ...Object.keys(processors), ...Object.keys(exporters)]) {
      expect(used.has(id)).toBe(true)
    }
    expect(used.has('forward/tempo')).toBe(true)
  })
})

describe('collector exporters', () => {
  it('queue on disk, sized in bytes, and answer 503 rather than block when full', () => {
    const storage = record(extensions['file_storage/queue'], 'file_storage/queue')
    expect(record(storage.compaction, 'compaction').on_start).toBe(true)

    for (const [id, body] of Object.entries(exporters)) {
      const queue = record(record(body, id).sending_queue, `${id}.sending_queue`)
      expect(queue.enabled).toBe(true)
      expect(queue.storage).toBe('file_storage/queue')
      expect(queue.sizer).toBe('bytes')
      expect(typeof queue.queue_size).toBe('number')
      expect(queue.block_on_overflow).toBe(false)
    }
  })

  it('sizes the queues at 1 GiB per group, 64 MiB for the canary and 256 MiB for Tempo', () => {
    const size = (id: string) => record(record(exporters[id], id).sending_queue, 'queue').queue_size
    for (const group of GROUPS) expect(size(`otlp_http/langfuse-${group}`)).toBe(GIB)
    expect(size('otlp_http/langfuse-canary')).toBe(64 * MIB)
    expect(size('otlp_http/tempo')).toBe(256 * MIB)
  })

  it('reaches both backends by service name on the edge network', () => {
    expect(record(exporters['otlp_http/tempo'], 'tempo').endpoint).toBe('http://tempo:4318')
    for (const group of GROUPS) {
      const endpoint = record(exporters[`otlp_http/langfuse-${group}`], group).endpoint
      expect(endpoint).toBe('http://langfuse-web:3000/api/public/otel')
    }
  })
})
