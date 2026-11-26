import {readdirSync} from 'node:fs'

import {describe, expect, it} from 'bun:test'

import {ENDPOINTS, METRIC_NAMES, PATHS, PORTS, THRESHOLDS} from './src/health-report'
import {GRAFANA_USER_ID, PROMETHEUS_USER_ID, TEMPO_USER_ID, TRACES_SENTINEL_PATH} from './src/host'

// Reads the real compose file and the service configs beside it. Image tags and digests are
// Renovate-managed, so these tests assert their format and never copy a value.

type Rec = Record<string, unknown>

function record(value: unknown, label: string): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not a mapping`)
  return value as Rec
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a list`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${label}[${index}] is not a string`)
    return item
  })
}

function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text()
}

const compose = record(Bun.YAML.parse(await read('docker-compose.yaml')), 'compose')
const services = record(compose.services, 'services')
const names = Object.keys(services)

function service(name: string): Rec {
  return record(services[name], name)
}

function environment(name: string): Record<string, string> {
  const env = record(service(name).environment ?? {}, `${name}.environment`)
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]))
}

function networksOf(name: string): string[] {
  return strings(service(name).networks, `${name}.networks`).sort()
}

function walkKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) walkKeys(item, keys)
  else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      walkKeys(child, keys)
    }
  }
  return keys
}

// Compose and collector interpolation syntax, built here so the lint rule against `${` in plain strings stays on.
const interpolation = (inner: string): string => `$\{${inner}}`

const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]*:\w[\w.-]*@sha256:[0-9a-f]{64}$/

describe('traces compose: images', () => {
  it('pins every image as name:tag@sha256:<64 hex>, except the collector, which deploy supplies', () => {
    for (const name of names.filter(candidate => candidate !== 'collector')) {
      expect(service(name).image).toMatch(PINNED_IMAGE)
    }
  })

  it('takes the collector image from a required variable that carries its own tag and digest', () => {
    expect(service('collector').image).toBe(interpolation('TRACES_COLLECTOR_IMAGE:?'))
  })

  it('has no AI gateway service and turns the gateway and in-app agent off', () => {
    expect(names.filter(name => /gateway/i.test(name))).toEqual([])
    for (const name of names) expect(String(service(name).image)).not.toMatch(/ai-gateway/)
    for (const name of ['langfuse-web', 'langfuse-worker']) {
      const env = environment(name)
      expect(env.LANGFUSE_AI_GATEWAY_DEPLOYED).toBe('false')
      expect(env.LANGFUSE_IN_APP_AGENT_ENABLED).toBe('false')
      expect(env.LANGFUSE_AI_GATEWAY_SERVICE_KEY).toBeUndefined()
    }
  })

  it('runs Langfuse web and worker at the same release', () => {
    const tag = (name: string) => /:([^@]+)@/.exec(String(service(name).image))?.[1]
    expect(tag('langfuse-web')).toBeDefined()
    expect(tag('langfuse-web')).toBe(tag('langfuse-worker'))
  })
})

describe('traces compose: exposure', () => {
  it('publishes 80 and 443 on Caddy only', () => {
    expect(strings(service('caddy').ports, 'caddy.ports')).toEqual(['80:80', '443:443'])
  })

  it('publishes one loopback port each for Langfuse web and Grafana', () => {
    expect(strings(service('langfuse-web').ports, 'ports')).toEqual(['127.0.0.1:3000:3000'])
    expect(strings(service('grafana').ports, 'ports')).toEqual(['127.0.0.1:3001:3000'])
  })

  it('gives no other service a ports entry', () => {
    const published = names.filter(name => service(name).ports !== undefined).sort()
    expect(published).toEqual(['caddy', 'grafana', 'langfuse-web'])
  })

  it('never uses host networking, privilege, or the Docker socket', () => {
    for (const name of names) {
      const body = service(name)
      expect(body.network_mode).toBeUndefined()
      expect(body.privileged).toBeUndefined()
      expect(body.pid).toBeUndefined()
      const volumes = body.volumes === undefined ? [] : strings(body.volumes, `${name}.volumes`)
      for (const volume of volumes) expect(volume).not.toContain('docker.sock')
    }
  })
})

describe('traces compose: networks', () => {
  it('declares exactly the edge and backend networks, and puts every service on one explicitly', () => {
    expect(Object.keys(record(compose.networks, 'networks')).sort()).toEqual(['backend', 'edge'])
    for (const name of names) expect(networksOf(name).length).toBeGreaterThan(0)
  })

  it('puts the collector and Caddy on the edge network only', () => {
    expect(networksOf('collector')).toEqual(['edge'])
    expect(networksOf('caddy')).toEqual(['edge'])
  })

  it('keeps the stores, Grafana and the worker off the edge network', () => {
    for (const name of ['clickhouse', 'postgres', 'redis', 'minio', 'grafana', 'langfuse-worker']) {
      expect(networksOf(name)).toEqual(['backend'])
    }
  })

  it('bridges the two networks only through Langfuse web, Prometheus, Tempo and the health reporter', () => {
    const bridges = names.filter(name => networksOf(name).length === 2).sort()
    expect(bridges).toEqual(['health-reporter', 'langfuse-web', 'prometheus', 'tempo'])
  })
})

describe('traces compose: operations', () => {
  it('restarts every service unless stopped and caps its logs', () => {
    for (const name of names) {
      const body = service(name)
      expect(body.restart).toBe('unless-stopped')
      const logging = record(body.logging, `${name}.logging`)
      expect(logging.driver).toBe('json-file')
      const options = record(logging.options, `${name}.logging.options`)
      expect(String(options['max-size'])).toMatch(/^\d+m$/)
      expect(Number(options['max-file'])).toBeGreaterThan(0)
    }
  })

  it('gives every service a healthcheck except the two distroless images with no shell', () => {
    const without = names.filter(name => service(name).healthcheck === undefined).sort()
    expect(without).toEqual(['collector', 'tempo'])
  })

  it('never makes another service wait for the collector or Tempo to be healthy', () => {
    for (const name of names) {
      const deps = service(name).depends_on
      if (deps === undefined || Array.isArray(deps)) continue
      for (const target of ['collector', 'tempo']) {
        expect(record(deps, 'depends_on')[target]).not.toEqual({condition: 'service_healthy'})
      }
    }
  })

  it('puts no memory limit on ClickHouse', () => {
    const keys = walkKeys(service('clickhouse'))
    for (const key of [
      'mem_limit',
      'mem_reservation',
      'memswap_limit',
      'deploy',
      'resources',
      'limits',
      'oom_kill_disable',
    ]) {
      expect(keys.has(key)).toBe(false)
    }
  })

  it('starts Caddy with ingest off unless deploy says otherwise', () => {
    const env = environment('caddy')
    expect(env.TRACES_INGEST_STATE).toBe(interpolation('TRACES_INGEST_STATE:-off'))
    expect(env.TRACES_DOMAIN).toBe(interpolation('TRACES_DOMAIN:?'))
  })

  it('mounts the ingest states and secrets as directories, so an atomic replace is seen', () => {
    const caddy = strings(service('caddy').volumes, 'caddy.volumes')
    expect(caddy).toContain('./config/ingest:/etc/caddy/ingest:ro')
    const collector = strings(service('collector').volumes, 'collector.volumes')
    expect(collector).toContain('./tokens:/etc/otelcol/tokens:ro')
    expect(collector).toContain('./secrets/collector:/etc/otelcol/secrets:ro')
    expect(collector).toContain('./config/otelcol.yaml:/etc/otelcol/config.yaml:ro')
    expect(collector.some(volume => volume.startsWith('collector_queue:/var/lib/otelcol'))).toBe(true)
  })

  it('mounts every named volume it uses and declares each one', () => {
    const declared = Object.keys(record(compose.volumes, 'volumes'))
    const used = names.flatMap(name =>
      strings(service(name).volumes ?? [], `${name}.volumes`)
        .map(volume => volume.split(':')[0] ?? '')
        .filter(source => !source.startsWith('.') && !source.startsWith('/')),
    )
    for (const volume of used) expect(declared).toContain(volume)
    for (const volume of declared) expect(used).toContain(volume)
  })
})

describe('traces compose: health reporter', () => {
  const reporter = (): Rec => service('health-reporter')
  const volumes = (): string[] => strings(reporter().volumes, 'health-reporter.volumes')

  it('runs as a non-root user on a read-only root filesystem with no capabilities', () => {
    expect(String(reporter().user)).toMatch(/^[1-9]\d*:[1-9]\d*$/)
    expect(reporter().read_only).toBe(true)
    expect(strings(reporter().cap_drop, 'cap_drop')).toEqual(['ALL'])
    expect(strings(reporter().security_opt, 'security_opt')).toContain('no-new-privileges:true')
  })

  // Tempo creates its data directories with mode 0700, so only its own user can list `blocks`. A reporter that
  // runs as anyone else reads "Permission denied", reports the Tempo age check as unknown, and ingest never opens.
  it("runs as Tempo's user, which Tempo gets from its image", () => {
    expect(String(reporter().user)).toBe(`${TEMPO_USER_ID}:${TEMPO_USER_ID}`)
    expect(service('tempo').user).toBeUndefined()
  })

  it("mounts Tempo's data read-only, from the same named volume Tempo writes", () => {
    const tempoMount = strings(service('tempo').volumes, 'tempo.volumes').find(volume => volume.endsWith(':/var/tempo'))
    expect(tempoMount).toBe('tempo_data:/var/tempo')
    const reporterMounts = volumes().filter(volume => volume.startsWith('tempo_data:'))
    expect(reporterMounts).toEqual(['tempo_data:/var/tempo:ro'])
    expect(PATHS.tempoBlocks.startsWith('/var/tempo/')).toBe(true)
  })

  it('publishes no port and shares no host namespace', () => {
    expect(reporter().ports).toBeUndefined()
    expect(reporter().network_mode).toBeUndefined()
    expect(reporter().pid).toBeUndefined()
  })

  it('is on both networks and does not wait for the stack it reports on', () => {
    expect(networksOf('health-reporter')).toEqual(['backend', 'edge'])
    expect(reporter().depends_on).toBeUndefined()
  })

  it('runs its source from a read-only bind mount without installing anything', () => {
    expect(volumes()).toContain('./health-reporter:/app:ro')
    const command = strings(reporter().command, 'command')
    expect(command).toContain('--no-install')
    expect(command.at(-1)).toBe('/app/health-report.ts')
  })

  it('mounts every host path read-only', () => {
    for (const volume of volumes()) expect(volume.endsWith(':ro')).toBe(true)
  })

  it('reads the volume through its sentinel file, mounted where the reporter looks for it', () => {
    expect(volumes()).toContain(`${TRACES_SENTINEL_PATH}:${PATHS.volumeSentinel}:ro`)
    expect(volumes().some(volume => volume.endsWith(`:${PATHS.rootProbe}:ro`))).toBe(true)
  })

  it('reads Tempo blocks and its two secret files from the paths the reporter uses', () => {
    expect(volumes()).toContain('tempo_data:/var/tempo:ro')
    expect(PATHS.tempoBlocks.startsWith('/var/tempo/')).toBe(true)
    const secretMount = volumes().find(volume => volume.startsWith('./secrets/reporter:'))
    expect(secretMount).toBeDefined()
    const target = String(secretMount).split(':')[1] ?? ''
    expect(PATHS.clickhousePasswordFile.startsWith(`${target}/`)).toBe(true)
    expect(PATHS.objectStorePasswordFile.startsWith(`${target}/`)).toBe(true)
  })

  it('never mounts sender tokens, the collector secrets, the Docker socket or a store directory', () => {
    for (const volume of volumes()) {
      expect(volume).not.toMatch(
        /tokens|secrets\/collector|secrets\/grafana|docker\.sock|clickhouse_data|postgres_data|minio_data|redis_data/,
      )
    }
  })

  it('has no secret in its environment', () => {
    expect(Object.keys(environment('health-reporter'))).toEqual(['BUN_RUNTIME_TRANSPILER_CACHE_PATH'])
  })

  it('is the upstream Caddy proxies /healthz to, on the port the reporter listens on', async () => {
    const caddyfile = await read('config/Caddyfile')
    expect(caddyfile).toContain(`reverse_proxy health-reporter:${PORTS.public}`)
  })

  it('has a liveness healthcheck on the loopback listener, which the verdict cannot turn unhealthy', () => {
    const test = strings(record(reporter().healthcheck, 'healthcheck').test, 'healthcheck.test').join(' ')
    expect(test).toContain(`http://127.0.0.1:${PORTS.detail}/live`)
    expect(test).not.toContain('healthz')
  })

  it('reaches every dependency by a service name and port that exist in this file', () => {
    const published: Record<string, number[]> = {
      collector: [13133, 8888, 4414],
      tempo: [3200],
      'langfuse-web': [3000],
      'langfuse-worker': [3030],
      grafana: [3000],
      clickhouse: [8123],
      minio: [9000],
    }
    const urls = Object.values(ENDPOINTS).map(url => new URL(url))
    for (const url of urls) {
      expect(names).toContain(url.hostname)
      expect(published[url.hostname]).toContain(Number(url.port))
    }
    // Everything the reporter talks to is reachable from a network it joins.
    for (const url of urls) {
      const shared = networksOf(url.hostname).filter(network => networksOf('health-reporter').includes(network))
      expect(shared.length).toBeGreaterThan(0)
    }
  })

  it('passes ClickHouse the reader password as a required variable and mounts the reader user file', () => {
    expect(environment('clickhouse').CLICKHOUSE_READER_PASSWORD).toBe(interpolation('CLICKHOUSE_READER_PASSWORD:?'))
    expect(strings(service('clickhouse').volumes, 'clickhouse.volumes')).toContain(
      './config/clickhouse-users/traces-reader.xml:/etc/clickhouse-server/users.d/traces-reader.xml:ro',
    )
  })

  it('makes both Langfuse services listen on every interface, so loopback healthchecks can reach them', () => {
    for (const name of ['langfuse-web', 'langfuse-worker']) {
      expect(environment(name).HOSTNAME).toBe('0.0.0.0')
      expect(JSON.stringify(service(name).healthcheck)).toContain('http://127.0.0.1:')
    }
  })

  // The image keeps its own files in config.d and users.d (one makes the server listen beyond localhost).
  // A directory mounted over either hides them: the healthcheck passes and other containers are refused.
  it('mounts single files into the ClickHouse config directories, never a directory over them', () => {
    const mounts = strings(service('clickhouse').volumes, 'clickhouse.volumes')
    expect(mounts).toContain(
      './config/clickhouse/system-log-ttl.xml:/etc/clickhouse-server/config.d/system-log-ttl.xml:ro',
    )
    for (const mount of mounts) {
      const target = mount.split(':')[1] ?? ''
      expect(target).not.toMatch(/^\/etc\/clickhouse-server(\/(config|users)\.d)?\/?$/)
    }
  })
})

describe('traces compose: secrets and telemetry', () => {
  it('writes no secret value into the file: sensitive names take a required variable', () => {
    const sensitive = /PASSWORD|SECRET|SALT|ENCRYPTION_KEY|REDIS_AUTH|REDISCLI_AUTH|DATABASE_URL|WEBHOOK/
    for (const name of names) {
      for (const [key, value] of Object.entries(environment(name))) {
        if (!sensitive.test(key) || key.endsWith('__FILE')) continue
        // Bootstrap values are optional by design; deploy sets them for the first start only.
        const pattern = key.startsWith('LANGFUSE_INIT_') ? /^\$\{[A-Z0-9_]+:-\}$/ : /\$\{[A-Z0-9_]+:\?\}/
        expect(value).toMatch(pattern)
      }
    }
  })

  it.each(['langfuse-web', 'langfuse-worker'])('%s: telemetry off, sign-up off, API key roles on', name => {
    const env = environment(name)
    expect(env.TELEMETRY_ENABLED).toBe('false')
    expect(env.AUTH_DISABLE_SIGNUP).toBe('true')
    expect(env.API_AUTH_MIGRATION).toBe('enforce')
    expect(env.API_KEY_PROJECT_ROLES_ENABLE).toBe('true')
    // The UI is reached through an SSH tunnel, so its URL is loopback.
    expect(env.NEXTAUTH_URL).toMatch(/^http:\/\/localhost:\d+$/)
  })

  it('Langfuse web hides the sign-up form and carries the web-only secret', () => {
    const env = environment('langfuse-web')
    expect(env.NEXT_PUBLIC_SIGN_UP_DISABLED).toBe('true')
    expect(env.NEXTAUTH_SECRET).toBe(interpolation('NEXTAUTH_SECRET:?'))
  })

  it('Grafana: no anonymous access, sign-up, sharing, metrics, analytics, update checks, Gravatar, news or pre-installer', () => {
    const env = environment('grafana')
    const off = [
      'GF_AUTH_ANONYMOUS_ENABLED',
      'GF_USERS_ALLOW_SIGN_UP',
      'GF_USERS_ALLOW_ORG_CREATE',
      'GF_PUBLIC_DASHBOARDS_ENABLED',
      'GF_SNAPSHOTS_ENABLED',
      'GF_SNAPSHOTS_EXTERNAL_ENABLED',
      'GF_METRICS_ENABLED',
      'GF_ANALYTICS_REPORTING_ENABLED',
      'GF_ANALYTICS_CHECK_FOR_UPDATES',
      'GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES',
      'GF_ANALYTICS_FEEDBACK_LINKS_ENABLED',
      'GF_NEWS_NEWS_FEED_ENABLED',
      'GF_PLUGINS_PREINSTALL_AUTO_UPDATE',
      'GF_PLUGINS_PLUGIN_ADMIN_ENABLED',
      'GF_CLOUD_MIGRATION_ENABLED',
    ]
    for (const key of off) expect(env[key]).toBe('false')
    expect(env.GF_SECURITY_DISABLE_GRAVATAR).toBe('true')
    expect(env.GF_PLUGINS_PREINSTALL_DISABLED).toBe('true')
  })

  it('Grafana reads its admin password and secret key from files', () => {
    const env = environment('grafana')
    expect(env.GF_SECURITY_ADMIN_PASSWORD__FILE).toMatch(/^\/run\/secrets\/grafana\//)
    expect(env.GF_SECURITY_SECRET_KEY__FILE).toMatch(/^\/run\/secrets\/grafana\//)
    expect(env.GF_SECURITY_ADMIN_PASSWORD).toBeUndefined()
    expect(env.GF_SECURITY_SECRET_KEY).toBeUndefined()
  })

  // The image's default user is 472 with group 0. Deploy makes the secret directory `root:472`, mode 0750, so a
  // process whose group is 0 cannot enter it: Grafana logs "Permission denied" for both files and starts on its
  // built-in admin password (`admin`) and secret key. Pinning the group to 472 is what lets it read them.
  it('Grafana runs as 472:472, so its group matches the group of the secret directory', () => {
    expect(GRAFANA_USER_ID).toBe(472)
    expect(String(service('grafana').user)).toBe(`${GRAFANA_USER_ID}:${GRAFANA_USER_ID}`)
  })
})

describe('Tempo config', async () => {
  const tempoText = await read('config/tempo.yaml')
  const tempo = record(Bun.YAML.parse(tempoText), 'tempo')

  it('limits a trace to 20 MB', () => {
    const overrides = record(tempo.overrides, 'overrides')
    const global = record(record(overrides.defaults, 'defaults').global, 'global')
    expect(global.max_bytes_per_trace).toBe(20_000_000)
  })

  it('keeps blocks for 720 hours on both the scheduler and the worker', () => {
    const worker = record(record(tempo.backend_worker, 'backend_worker').compaction, 'compaction')
    expect(worker.block_retention).toBe('720h')
    const scheduler = record(tempo.backend_scheduler, 'backend_scheduler')
    const retention = record(record(record(scheduler.provider, 'provider').compaction, 'c').compaction, 'cc')
    expect(retention.block_retention).toBe('720h')
  })

  it('leaves the attribute limit at its default', () => {
    expect(walkKeys(tempo).has('max_attribute_bytes')).toBe(false)
    expect(walkKeys(tempo).has('max_span_attr_byte')).toBe(false)
  })

  it('turns usage reporting off', () => {
    expect(record(tempo.usage_report, 'usage_report').reporting_enabled).toBe(false)
  })

  it('stores locally under the mounted volume', () => {
    const trace = record(record(tempo.storage, 'storage').trace, 'trace')
    expect(trace.backend).toBe('local')
    expect(record(trace.wal, 'wal').path).toMatch(/^\/var\/tempo\//)
    expect(record(trace.local, 'local').path).toMatch(/^\/var\/tempo\//)
    expect(strings(service('tempo').volumes, 'tempo.volumes')).toContain('tempo_data:/var/tempo')
  })
})

/**
 * The text of an XML document outside its comments, joined by newlines. It scans for the comment delimiters one
 * at a time instead of stripping a pattern, so no input can leave a `<!--` behind, and an unterminated comment
 * (which no XML parser accepts) throws instead of being skipped.
 */
function outsideComments(text: string): string {
  const segments: string[] = []
  let rest = text
  for (;;) {
    const open = rest.indexOf('<!--')
    if (open === -1) {
      segments.push(rest)
      return segments.join('\n')
    }
    segments.push(rest.slice(0, open))
    const close = rest.indexOf('-->', open + '<!--'.length)
    if (close === -1) throw new Error('unterminated XML comment')
    rest = rest.slice(close + '-->'.length)
  }
}

describe('outsideComments', () => {
  it('keeps what is outside comments and drops what is inside, however the delimiters are arranged', () => {
    expect(outsideComments('<a/><!-- x --><b/>')).toBe('<a/>\n<b/>')
    expect(outsideComments('<!-- a --><!-- b -->')).toBe('\n\n')
    expect(outsideComments('<!-- <!-- x --> live <!-- y -->')).toBe('\n live \n')
    expect(outsideComments('<!-<!-- x -->-->')).toBe('<!-\n-->')
    expect(outsideComments('no comments')).toBe('no comments')
  })

  it('rejects an unterminated comment', () => {
    expect(() => outsideComments('<a/><!-- never closed')).toThrow('unterminated XML comment')
  })
})

describe('ClickHouse config', async () => {
  const dir = new URL('config/clickhouse/', import.meta.url)
  const files = readdirSync(dir).filter(name => name.endsWith('.xml'))
  // Only what a server reads: a setting or table named inside a comment is neither present nor absent.
  const xml = (
    await Promise.all(files.map(async name => outsideComments(await Bun.file(new URL(name, dir)).text())))
  ).join('\n')

  it('gives the system log tables that hold query text a short TTL', () => {
    for (const table of ['query_log', 'query_thread_log', 'text_log', 'part_log', 'trace_log']) {
      const match = new RegExp(
        String.raw`<${table}>\s*<ttl>event_date \+ INTERVAL (\d+) DAY DELETE</ttl>\s*</${table}>`,
      ).exec(xml)
      expect(match?.[1]).toBeDefined()
      expect(Number(match?.[1])).toBeLessThanOrEqual(7)
    }
  })

  it('sets nothing that caps memory', () => {
    expect(xml).not.toMatch(/max_server_memory_usage|max_memory_usage|memory_ratio/i)
  })
})

describe('Grafana provisioning', async () => {
  const datasource = record(Bun.YAML.parse(await read('config/grafana/datasources/tempo.yaml')), 'datasource')

  it('provisions one read-only Tempo data source reached by service name', () => {
    const sources = datasource.datasources
    expect(Array.isArray(sources) && sources).toHaveLength(1)
    const [first] = sources as unknown[]
    const tempo = record(first, 'datasource[0]')
    expect(tempo.type).toBe('tempo')
    expect(tempo.url).toBe('http://tempo:3200')
    expect(tempo.editable).toBe(false)
    expect(strings(service('grafana').volumes, 'grafana.volumes')).toContain(
      './config/grafana/datasources:/etc/grafana/provisioning/datasources:ro',
    )
  })

  it('provisions Prometheus beside it, read-only and not the default, at the uid the alert rules name', async () => {
    const file = record(Bun.YAML.parse(await read('config/grafana/datasources/prometheus.yaml')), 'datasource')
    const sources = file.datasources as unknown[]
    expect(sources).toHaveLength(1)
    const prometheus = record(sources[0], 'datasource[0]')
    expect(prometheus.type).toBe('prometheus')
    expect(prometheus.uid).toBe('prometheus')
    expect(prometheus.url).toBe('http://prometheus:9090')
    expect(prometheus.access).toBe('proxy')
    expect(prometheus.isDefault).toBe(false)
    expect(prometheus.editable).toBe(false)
    expect(datasource.datasources).toHaveLength(1)
    expect(record((datasource.datasources as unknown[])[0], 'tempo').isDefault).toBe(true)
  })
})

describe('traces compose: Prometheus', () => {
  const prometheus = (): Rec => service('prometheus')
  const flags = (): string[] => strings(prometheus().command, 'prometheus.command')

  it('is on the Prometheus 3.13 line, pinned by tag and digest', () => {
    expect(String(prometheus().image)).toMatch(/^prom\/prometheus:v3\.13\.\d+@sha256:[0-9a-f]{64}$/)
  })

  // Renovate holds the image to the 3.13 line with `allowedVersions`; this keeps the rule and the pin together.
  it('is held to its line by a Renovate rule that the pinned tag satisfies', async () => {
    const config = record(
      Bun.JSON5.parse(await Bun.file(new URL('../../.github/renovate.json5', import.meta.url)).text()),
      'renovate',
    )
    const rule = (config.packageRules as unknown[])
      .map(entry => record(entry, 'rule'))
      .find(entry => Array.isArray(entry.matchPackageNames) && entry.matchPackageNames.includes('prom/prometheus'))
    expect(rule?.matchFileNames).toEqual(['apps/traces/docker-compose.yaml'])
    const allowed = String(rule?.allowedVersions)
    expect(allowed.startsWith('/') && allowed.endsWith('/')).toBe(true)
    const tag = /:([^@]+)@/.exec(String(prometheus().image))?.[1] ?? ''
    expect(new RegExp(allowed.slice(1, -1)).test(tag)).toBe(true)
    expect(new RegExp(allowed.slice(1, -1)).test('v3.14.0')).toBe(false)
    expect(new RegExp(allowed.slice(1, -1)).test('v3.130.0')).toBe(false)
  })

  it('joins the edge network, to scrape the collector and Tempo, and the backend one, so Grafana can query it', () => {
    expect(networksOf('prometheus')).toEqual(['backend', 'edge'])
    expect(prometheus().depends_on).toBeUndefined()
  })

  it('publishes no port and shares no host namespace', () => {
    expect(prometheus().ports).toBeUndefined()
    expect(prometheus().expose).toBeUndefined()
    expect(prometheus().network_mode).toBeUndefined()
    expect(prometheus().pid).toBeUndefined()
  })

  it('runs as the image’s own user (nobody) on a read-only root filesystem with no capabilities', () => {
    expect(PROMETHEUS_USER_ID).toBe(65_534)
    expect(String(prometheus().user)).toBe(`${PROMETHEUS_USER_ID}:${PROMETHEUS_USER_ID}`)
    expect(prometheus().read_only).toBe(true)
    expect(strings(prometheus().cap_drop, 'cap_drop')).toEqual(['ALL'])
    expect(strings(prometheus().security_opt, 'security_opt')).toContain('no-new-privileges:true')
  })

  it('keeps 15 days or 2 GB, whichever is reached first', () => {
    expect(flags()).toContain('--storage.tsdb.retention.time=15d')
    expect(flags()).toContain('--storage.tsdb.retention.size=2GB')
    expect(flags()).toContain('--storage.tsdb.path=/prometheus')
    expect(flags()).toContain('--config.file=/etc/prometheus/prometheus.yml')
  })

  it('turns no management surface on: no lifecycle endpoint, admin API or remote-write receiver', () => {
    for (const flag of flags()) {
      expect(flag).not.toMatch(/enable-lifecycle|enable-admin-api|remote-write-receiver|web\.enable|otlp/i)
    }
  })

  it('mounts its configuration read-only as a file and keeps its data on a named volume it owns', () => {
    const mounts = strings(prometheus().volumes, 'prometheus.volumes')
    expect(mounts).toContain('./config/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro')
    expect(mounts).toContain('prometheus_data:/prometheus')
    expect(mounts).toHaveLength(2)
    expect(Object.keys(record(compose.volumes, 'volumes'))).toContain('prometheus_data')
  })

  it('has no environment and no secret', () => {
    expect(environment('prometheus')).toEqual({})
  })

  it('checks itself at its own health endpoint, which the image’s wget can reach', () => {
    const test = strings(record(prometheus().healthcheck, 'healthcheck').test, 'healthcheck.test').join(' ')
    expect(test).toContain('wget')
    expect(test).toContain('http://127.0.0.1:9090/-/healthy')
  })

  it('scrapes the collector, Tempo, the reporter and itself every 30 seconds, and nothing else', async () => {
    const config = record(Bun.YAML.parse(await read('config/prometheus/prometheus.yml')), 'prometheus.yml')
    expect(record(config.global, 'global').scrape_interval).toBe('30s')
    const jobs = (config.scrape_configs as unknown[]).map(job => record(job, 'job'))
    const targets = Object.fromEntries(
      jobs.map(job => [
        String(job.job_name),
        (job.static_configs as unknown[]).flatMap(entry => strings(record(entry, 'static').targets, 'targets')),
      ]),
    )
    expect(targets).toEqual({
      otelcol: ['collector:8888'],
      tempo: ['tempo:3200'],
      'health-reporter': [`health-reporter:${PORTS.metrics}`],
      prometheus: ['localhost:9090'],
    })
    for (const job of jobs) {
      expect(job.metrics_path).toBeUndefined()
      expect(job.basic_auth).toBeUndefined()
    }
  })

  it('scrapes only services that exist and share a network with it, at the ports the stack serves', async () => {
    const config = record(Bun.YAML.parse(await read('config/prometheus/prometheus.yml')), 'prometheus.yml')
    for (const job of config.scrape_configs as unknown[]) {
      for (const entry of record(job, 'job').static_configs as unknown[]) {
        for (const target of strings(record(entry, 'static').targets, 'targets')) {
          const [host = '', port = ''] = target.split(':')
          if (host === 'localhost') continue
          expect(names).toContain(host)
          expect(networksOf(host).filter(network => networksOf('prometheus').includes(network)).length).toBeGreaterThan(
            0,
          )
          const metricsUrl = Object.values(ENDPOINTS).find(
            url => new URL(url).hostname === host && new URL(url).port === port,
          )
          if (host !== 'health-reporter') expect(metricsUrl).toBeDefined()
        }
      }
    }
    expect(String(PORTS.metrics)).toBe('8082')
  })

  it('has no Alertmanager, no rule files and no remote write: alerts are Grafana-managed', async () => {
    const config = record(Bun.YAML.parse(await read('config/prometheus/prometheus.yml')), 'prometheus.yml')
    for (const key of ['alerting', 'rule_files', 'remote_write', 'remote_read']) expect(config[key]).toBeUndefined()
    expect(names.filter(name => /alertmanager/i.test(name))).toEqual([])
  })
})

describe('collector mounts match the collector config', async () => {
  const collectorConfig = await read('config/otelcol.yaml')

  it('reads token files and the Langfuse credential from the mounted directories', () => {
    expect(collectorConfig).toContain('/etc/otelcol/tokens/')
    expect(collectorConfig).toContain('/etc/otelcol/secrets/langfuse-basic')
    expect(collectorConfig).toContain('/var/lib/otelcol/queue')
  })
})

// ─── Grafana-managed alerting ─────────────────────────────────────────────────

const ALERTING_DIR = 'config/grafana/alerting'
const RULE_TITLES = [
  'TracesTargetDown',
  'CollectorQueueFilling',
  'CollectorExportFailures',
  'IngestRefused503',
  'TempoDiscards',
  'TempoAttributeTruncation',
  'LangfuseDown',
  'GrafanaDown',
  'VolumeSpaceWarning',
  'VolumeSpaceCritical',
  'RootSpace',
  'DataOlderThan31d',
  'ReporterStale',
] as const

interface RuleCase {
  group: string
  folder: string
  title: string
  uid: string
  condition: string
  refs: Record<string, Rec>
  expr: string
  noDataState: string
  execErrState: string
  for: string
  labels: Record<string, string>
  annotations: Record<string, string>
  comparison: {operator: string; value: number}
}

describe('Grafana alerting provisioning', async () => {
  const contactFile = record(Bun.YAML.parse(await read(`${ALERTING_DIR}/contact-points.yaml`)), 'contact-points')
  const policyFile = record(Bun.YAML.parse(await read(`${ALERTING_DIR}/policies.yaml`)), 'policies')
  const rulesText = await read(`${ALERTING_DIR}/rules.yaml`)
  const rulesFile = record(Bun.YAML.parse(rulesText), 'rules')
  const reporterSource = await Bun.file(new URL('src/health-report.ts', import.meta.url)).text()

  const groups = (rulesFile.groups as unknown[]).map(group => record(group, 'group'))
  const rules: RuleCase[] = groups.flatMap(group =>
    (group.rules as unknown[]).map(entry => {
      const rule = record(entry, 'rule')
      const data = (rule.data as unknown[]).map(node => record(node, 'node'))
      const refs = Object.fromEntries(data.map(node => [String(node.refId), node]))
      const query = record(record(refs.A, 'A').model, 'A.model')
      const math = record(record(refs.C, 'C').model, 'C.model')
      const comparison = /^\$B (>=|>|<=|<) ([\d.]+)$/.exec(String(math.expression))
      return {
        group: String(group.name),
        folder: String(group.folder),
        title: String(rule.title),
        uid: String(rule.uid),
        condition: String(rule.condition),
        refs,
        expr: String(query.expr),
        noDataState: String(rule.noDataState),
        execErrState: String(rule.execErrState),
        for: String(rule.for),
        labels: rule.labels as Record<string, string>,
        annotations: rule.annotations as Record<string, string>,
        comparison: {operator: comparison?.[1] ?? '?', value: Number(comparison?.[2])},
      }
    }),
  )
  const rule = (title: string): RuleCase => {
    const found = rules.find(candidate => candidate.title === title)
    if (found === undefined) throw new Error(`no rule ${title}`)
    return found
  }

  it('is one folder and exactly the rules the design lists', () => {
    expect(rules.map(candidate => candidate.title).sort()).toEqual([...RULE_TITLES].sort())
    expect(new Set(rules.map(candidate => candidate.folder))).toEqual(new Set(['Traces stack']))
    expect(new Set(rules.map(candidate => candidate.uid)).size).toBe(rules.length)
    for (const candidate of rules) expect(candidate.uid).toMatch(/^traces-[a-z0-9-]{1,30}$/)
    for (const group of groups) {
      expect(group.orgId).toBe(1)
      expect(group.interval).toMatch(/^\d+m$/)
    }
    expect(rulesFile.apiVersion).toBe(1)
  })

  it('mounts the alerting directory read-only where Grafana reads it, and the three files are the whole of it', () => {
    expect(strings(service('grafana').volumes, 'grafana.volumes')).toContain(
      './config/grafana/alerting:/etc/grafana/provisioning/alerting:ro',
    )
    expect(readdirSync(new URL(`${ALERTING_DIR}/`, import.meta.url)).sort()).toEqual([
      'contact-points.yaml',
      'policies.yaml',
      'rules.yaml',
    ])
  })

  it('has one Discord contact point whose URL is the environment variable only Grafana receives', () => {
    expect(contactFile.apiVersion).toBe(1)
    const points = contactFile.contactPoints as unknown[]
    expect(points).toHaveLength(1)
    const point = record(points[0], 'contact point')
    const receivers = point.receivers as unknown[]
    expect(receivers).toHaveLength(1)
    const receiver = record(receivers[0], 'receiver')
    expect(receiver.type).toBe('discord')
    expect(receiver.uid).toBe('traces-discord')
    expect(receiver.disableResolveMessage).toBe(false)
    expect(record(receiver.settings, 'settings').url).toBe('$TRACES_DISCORD_WEBHOOK_URL')

    expect(environment('grafana').TRACES_DISCORD_WEBHOOK_URL).toBe(interpolation('TRACES_DISCORD_WEBHOOK_URL:?'))
    for (const name of names.filter(candidate => candidate !== 'grafana')) {
      expect(JSON.stringify(service(name))).not.toContain('TRACES_DISCORD_WEBHOOK_URL')
    }
  })

  it('writes no webhook address into any tracked provisioning file', async () => {
    for (const file of ['contact-points.yaml', 'policies.yaml', 'rules.yaml']) {
      expect(await read(`${ALERTING_DIR}/${file}`)).not.toMatch(/discord(app)?\.com|webhooks\//i)
    }
  })

  it('routes every alert to that contact point, regrouped and repeated on a schedule, with no sub-routes', () => {
    expect(policyFile.apiVersion).toBe(1)
    const policies = policyFile.policies as unknown[]
    expect(policies).toHaveLength(1)
    const policy = record(policies[0], 'policy')
    const point = record((contactFile.contactPoints as unknown[])[0], 'contact point')
    expect(policy.receiver).toBe(point.name)
    expect(policy.group_by).toEqual(['grafana_folder', 'alertname'])
    expect(policy.group_wait).toBe('30s')
    expect(policy.group_interval).toBe('5m')
    expect(policy.repeat_interval).toBe('4h')
    expect(policy.routes).toBeUndefined()
    expect(policy.matchers).toBeUndefined()
    expect(policy.object_matchers).toBeUndefined()
  })

  it('queries the Prometheus data source and ends in one math condition on a reduced value', () => {
    for (const candidate of rules) {
      expect(candidate.condition).toBe('C')
      const query = record(candidate.refs.A, 'A')
      expect(query.datasourceUid).toBe('prometheus')
      const queryModel = record(query.model, 'A.model')
      expect(queryModel.instant).toBe(true)
      expect(record(candidate.refs.B, 'B').datasourceUid).toBe('__expr__')
      expect(record(record(candidate.refs.B, 'B').model, 'B.model')).toMatchObject({type: 'reduce', expression: 'A'})
      expect(record(record(candidate.refs.C, 'C').model, 'C.model')).toMatchObject({type: 'math'})
      expect(Object.keys(candidate.refs).sort()).toEqual(['A', 'B', 'C'])
    }
  })

  it('names a severity on every rule, and uses nothing outside critical, warning and info', () => {
    for (const candidate of rules) expect(['critical', 'warning', 'info']).toContain(candidate.labels.severity ?? '')
    expect(rule('TracesTargetDown').labels.severity).toBe('critical')
    expect(rule('TempoDiscards').labels.severity).toBe('critical')
    expect(rule('TempoAttributeTruncation').labels.severity).toBe('info')
    expect(rule('VolumeSpaceWarning').labels.severity).toBe('warning')
    expect(rule('VolumeSpaceCritical').labels.severity).toBe('critical')
  })

  // Absence means different things. A loss counter that was never incremented is not exported (OpenTelemetry SDK, and
  // Tempo), so "no data" is "no loss" and must never alert. A missing `up` series, or a reporter that has recorded
  // no run, is a monitoring gap and must. A broken query keeps the last state, except the one rule that says the
  // monitoring itself is blind.
  it('treats no data and a failing query deliberately, rule by rule', () => {
    const alerting = new Set(['TracesTargetDown', 'ReporterStale'])
    for (const candidate of rules) {
      expect({title: candidate.title, noData: candidate.noDataState}).toEqual({
        title: candidate.title,
        noData: alerting.has(candidate.title) ? 'Alerting' : 'OK',
      })
      expect({title: candidate.title, error: candidate.execErrState}).toEqual({
        title: candidate.title,
        error: candidate.title === 'TracesTargetDown' ? 'Alerting' : 'KeepLast',
      })
    }
  })

  it('never alerts on a loss counter that is absent, and adds the two failure counters without losing either', () => {
    for (const title of ['CollectorExportFailures', 'IngestRefused503', 'TempoDiscards', 'TempoAttributeTruncation']) {
      const candidate = rule(title)
      expect({title, noData: candidate.noDataState}).toEqual({title, noData: 'OK'})
      expect({title, for: candidate.for}).toEqual({title, for: '0s'})
      expect(candidate.comparison).toEqual({operator: '>', value: 0})
      expect(candidate.expr).toContain('[30m]')
      // A plain `+` between two vectors drops every series that is missing from one side.
      expect(candidate.expr).not.toMatch(/\)\s*\+\s*(sum|increase)/)
    }
    const failures = rule('CollectorExportFailures').expr
    expect(failures).toContain('sum by (exporter)')
    expect(failures).toContain('increase(otelcol_exporter_send_failed_spans[30m])')
    expect(failures).toContain('increase(otelcol_exporter_enqueue_failed_spans[30m])')
    // Joined by `or` over a distinguishing label. One name regex would make `increase` (which drops the metric name)
    // return two series with one labelset, which Prometheus rejects as an error.
    expect(failures).toMatch(/label_replace\(increase\(otelcol_exporter_send_failed_spans.*\) or label_replace\(/)
    expect(failures).not.toContain('__name__')
  })

  it('excludes the canary route from the 503 rule, as the reporter does', () => {
    expect(rule('IngestRefused503').expr).toContain('http_response_status_code="503"')
    expect(rule('IngestRefused503').expr).toContain('http_route=""')
  })

  it('takes its thresholds from the reporter, so the alert and the verdict agree', () => {
    expect(rule('CollectorQueueFilling').comparison).toEqual({operator: '>=', value: THRESHOLDS.queueFullFraction})
    expect(rule('VolumeSpaceWarning').comparison).toEqual({operator: '>=', value: THRESHOLDS.volumeWarnPercent / 100})
    expect(rule('VolumeSpaceCritical').comparison).toEqual({operator: '>=', value: THRESHOLDS.volumeFailPercent / 100})
    expect(rule('RootSpace').comparison).toEqual({operator: '>=', value: THRESHOLDS.rootFailPercent / 100})
    expect(rule('DataOlderThan31d').comparison).toEqual({operator: '>', value: THRESHOLDS.maxDataAgeDays * 86_400})
    expect(rule('ReporterStale').comparison).toEqual({
      operator: '>',
      value: ((THRESHOLDS.staleAfterIntervals + 1) * THRESHOLDS.intervalMs) / 1000,
    })
    for (const title of ['TracesTargetDown', 'LangfuseDown', 'GrafanaDown']) {
      expect(rule(title).comparison).toEqual({operator: '<', value: 1})
    }
  })

  it('reads the reporter gauges by the names the reporter exports and the filters it labels them with', () => {
    expect(rule('VolumeSpaceWarning').expr).toBe(`${METRIC_NAMES.diskUsedRatio}{mount="volume"}`)
    expect(rule('RootSpace').expr).toBe(`${METRIC_NAMES.diskUsedRatio}{mount="root"}`)
    expect(rule('GrafanaDown').expr).toBe(`${METRIC_NAMES.probeUp}{target="grafana"}`)
    expect(rule('LangfuseDown').expr).toContain(`${METRIC_NAMES.probeUp}{target=~"langfuse-web|langfuse-worker"}`)
    expect(rule('DataOlderThan31d').expr).toBe(METRIC_NAMES.oldestDataAge)
    expect(rule('ReporterStale').expr).toBe(`time() - ${METRIC_NAMES.lastRun}`)
  })

  it('uses only metric names the reporter reads or exports', () => {
    const exported = new Set<string>(Object.values(METRIC_NAMES))
    for (const candidate of rules) {
      const used =
        candidate.expr.match(/\b(?:otelcol|tempo|traces)_[a-z_]+|\bhttp_server_request_duration_count\b|\bup\b/g) ?? []
      expect({title: candidate.title, used: used.length > 0}).toEqual({title: candidate.title, used: true})
      for (const name of used) {
        const known = exported.has(name) || name === 'up' || reporterSource.includes(name)
        expect({title: candidate.title, name, known}).toEqual({title: candidate.title, name, known: true})
      }
    }
    for (const name of ['otelcol_exporter_send_failed_spans', 'otelcol_exporter_enqueue_failed_spans']) {
      expect(reporterSource).toContain(name)
    }
  })

  it('holds a state for five minutes before it fires, except the loss counters', () => {
    for (const candidate of rules) {
      const loss = ['CollectorExportFailures', 'IngestRefused503', 'TempoDiscards', 'TempoAttributeTruncation']
      if (loss.includes(candidate.title)) continue
      expect({title: candidate.title, for: candidate.for}).toMatchObject({for: expect.stringMatching(/^(5|10|15)m$/)})
    }
    expect(rule('TracesTargetDown').for).toBe('5m')
    expect(rule('CollectorQueueFilling').for).toBe('5m')
    expect(rule('LangfuseDown').for).toBe('5m')
    expect(rule('GrafanaDown').for).toBe('5m')
  })

  // The message is fixed text, the rule's own labels and numbers. No template reads a span, a log line or a body.
  it('writes fixed text, labels and values into every message, and nothing else', () => {
    const fixedLabels = new Set(['exporter', 'job', 'instance', 'target', 'mount', 'store', 'reason'])
    for (const candidate of rules) {
      expect(Object.keys(candidate.annotations).sort()).toEqual(['description', 'summary'])
      for (const text of Object.values(candidate.annotations)) {
        for (const template of text.matchAll(/\{\{(.*?)\}\}/g)) {
          const body = (template[1] ?? '').trim()
          const label = /^\$labels\.(\w+)$/.exec(body)?.[1]
          const value = /^(?:printf "%\.\d+f" )?\$values\.B\.Value$/.test(body)
          expect({title: candidate.title, body, ok: (label !== undefined && fixedLabels.has(label)) || value}).toEqual({
            title: candidate.title,
            body,
            ok: true,
          })
        }
        expect(text.replaceAll(/\{\{.*?\}\}/g, '')).not.toContain('$')
      }
    }
  })
})
