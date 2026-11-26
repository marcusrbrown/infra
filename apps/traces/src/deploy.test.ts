import type {RunResult} from '../server/provision'
import type {CanaryState, DeployDeps, DeployResult, GateInputs, IngestState} from './deploy'

import {Buffer} from 'node:buffer'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {describe, expect, it} from 'bun:test'
import * as deployModule from './deploy'
import {
  ALERT_CONTACT_POINT_UID,
  ALERT_RULE_GROUPS,
  AppliedButUnverifiedError,
  beginDeployScript,
  bootstrapProbeScript,
  buildEnvFile,
  buildEnvManagedFile,
  buildSecretFiles,
  canaryScript,
  closeMasterArgv,
  compareFileScript,
  createCollectorScript,
  createEmbedderScript,
  createPrometheusScript,
  deploy,
  DEPLOY_OVERTAKEN_SENTINEL,
  DeployOvertakenError,
  diskScript,
  driftScript,
  embedderVolumeScript,
  evaluateGates,
  evaluateGrafana,
  evaluateGrafanaAlerting,
  failedOperatorGates,
  failedSafetyGates,
  GATED_SERVICES,
  generateDeployId,
  generateVoidTokenLine,
  grafanaAlertingScript,
  grafanaSignInScript,
  hygieneScript,
  INGEST_SERVICES,
  INSIGHT_SERVICES,
  langfuseBasicValue,
  mayOpen,
  MONITORING_SERVICES,
  OperatorSurfaceError,
  ownershipPrelude,
  parseCanaryChecks,
  parseDrift,
  parseGrafanaAlerting,
  parseGrafanaProbe,
  parseHostState,
  parseIngestProbe,
  parseReporterDetail,
  prepareDirsScript,
  probeIngestScript,
  prometheusVolumeScript,
  provesState,
  pruneScript,
  pullScript,
  queueVolumeScript,
  readIngestStateScript,
  readInputs,
  removeOwnFileScript,
  REPORTER_DETAIL_COMMAND,
  runningDigestScript,
  SERVICES,
  setIngestStateCommand,
  sshArgv,
  sshChildEnv,
  tokenDirsScript,
  tokenFileScript,
  TRACES_DEPLOY_BUILD_INPUTS,
  TRACES_DEPLOY_SECRETS,
  TRACES_DEPLOY_VARS,
  UPLOADED_FILES,
  upScript,
  writeFileScript,
} from './deploy'
import {
  baseEnv,
  CAN_LOCK,
  FakeHost,
  installFlockStandIn,
  isReadOnlyStep,
  OTHER_DIGEST,
  PLACEHOLDER_DIGEST,
  secretValues,
  stepOf,
  testDeps,
} from './deploy.fixture'
import {CANARY_ONCE_FLAG, PATHS} from './health-report'
import {
  EMBEDDER_USER_ID,
  GRAFANA_USER_ID,
  PROMETHEUS_USER_ID,
  SENDER_GROUPS,
  TEMPO_USER_ID,
  TRACES_APP_DIR,
  TRACES_DEPLOY_MARKER,
  TRACES_DEPLOY_STEP_LOCK,
  TRACES_DOCKER_ROOT,
  TRACES_INGEST_LOCK,
  TRACES_LOCK_BUSY_SENTINEL,
  TRACES_PENDING_RESTARTS,
  TRACES_VOID_TOKEN_PREFIX,
} from './host'
import * as retentionModule from './retention'
import {addLifecycleScript, applyTtlScript, OBJECT_STORE_PREFIXES} from './retention'

const ok = (stdout: string): RunResult => ({exitCode: 0, stdout, stderr: ''})

const HERE = new URL('.', import.meta.url).pathname
const APP = join(HERE, '..')

/** Two deploy ids (32 hex characters each) for the tests that need to tell deploys apart. */
const ID_A = 'a1'.repeat(16)
const ID_B = 'b2'.repeat(16)

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Ran {
  result: DeployResult
  logs: string[]
}

async function run(
  host: FakeHost,
  env: Record<string, string | undefined> = baseEnv(),
  overrides: Partial<DeployDeps> = {},
): Promise<Ran> {
  const t = testDeps(host, overrides)
  const result = await deploy({env, deps: t.deps})
  return {result, logs: t.logs}
}

async function failure(
  host: FakeHost,
  env: Record<string, string | undefined> = baseEnv(),
  overrides: Partial<DeployDeps> = {},
): Promise<Error> {
  try {
    await run(host, env, overrides)
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('the deploy was expected to fail and succeeded')
}

const withoutKey = {TRACES_LANGFUSE_PUBLIC_KEY: undefined, TRACES_LANGFUSE_SECRET_KEY: undefined}
const bootstrap = {
  TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY: 'pk-lf-placeholder-boot-public',
  TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY: 'sk-lf-placeholder-boot-secret',
}

async function openStack(): Promise<FakeHost> {
  const host = new FakeHost()
  const {result} = await run(host)
  expect(result.ingest).toBe('open')
  return host
}

async function deployAndCollect(env: Record<string, string | undefined>): Promise<{host: FakeHost; logs: string[]}> {
  const host = new FakeHost()
  const t = testDeps(host)
  await expect(deploy({env, deps: t.deps})).resolves.toBeDefined()
  return {host, logs: t.logs}
}

function expectNoSecretOutsideStdin(env: Record<string, string | undefined>, host: FakeHost, logs: string[]): void {
  const argvText = host.calls.map(call => call.argv.join('\u0000')).join('\u0000')
  const commands = host.calls.map(call => call.command).join('\n')
  const logText = logs.join('\n')
  for (const secret of secretValues(env)) {
    const label = secret.slice(0, 14)
    expect({label, inArgv: argvText.includes(secret)}).toEqual({label, inArgv: false})
    expect({label, inCommand: commands.includes(secret)}).toEqual({label, inCommand: false})
    expect({label, inLog: logText.includes(secret)}).toEqual({label, inLog: false})
  }
}

/** The read-only operator-surface checks that run after the route is final and the marker is gone. */
const OPERATOR_STEPS = ['grafana-signin', 'grafana-alerting']

function nonSshSteps(host: FakeHost): string[] {
  return host.steps.filter(step => step !== 'ssh-exit')
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

describe('inputs', () => {
  it('exports the contract as three disjoint const lists', () => {
    const all = [...TRACES_DEPLOY_SECRETS, ...TRACES_DEPLOY_VARS, ...TRACES_DEPLOY_BUILD_INPUTS]
    expect(new Set(all).size).toBe(all.length)
    expect(all.every(name => name.startsWith('TRACES_'))).toBe(true)
    expect(TRACES_DEPLOY_VARS).toEqual(['TRACES_DOMAIN', 'TRACES_INGEST_OPEN'])
    expect(TRACES_DEPLOY_BUILD_INPUTS).toEqual(['TRACES_COLLECTOR_IMAGE'])
  })

  it('never lists a sender token, the snapshot token or a cloud API token', () => {
    const all: string[] = [...TRACES_DEPLOY_SECRETS, ...TRACES_DEPLOY_VARS, ...TRACES_DEPLOY_BUILD_INPUTS]
    expect(all).not.toContain('TRACES_SNAPSHOT_DO_TOKEN')
    expect(all).not.toContain('DIGITALOCEAN_ACCESS_TOKEN')
    expect(all.some(name => /SENDER|_TOKEN$/.test(name))).toBe(false)
  })

  it('lists the Discord webhook as a secret, for the host `.env` Grafana reads it from', () => {
    expect((TRACES_DEPLOY_SECRETS as readonly string[]).includes('TRACES_DISCORD_WEBHOOK_URL')).toBe(true)
    expect(readInputs(baseEnv()).discordWebhookUrl).toBe(baseEnv().TRACES_DISCORD_WEBHOOK_URL ?? '')
  })

  it('reads only the names it exports (and PATH, HOME, SSH_AUTH_SOCK, which are not inputs)', () => {
    const reads = new Set<string>()
    const values = baseEnv({
      TRACES_SNAPSHOT_DO_TOKEN: 'placeholder-snapshot-token',
      DIGITALOCEAN_ACCESS_TOKEN: 'placeholder-do-token',
      TRACES_SENDER_TOKEN: 'placeholder-sender-token',
    })
    const env = new Proxy(values, {
      get(target, name) {
        if (typeof name === 'string') reads.add(name)
        return Reflect.get(target, name)
      },
    })
    readInputs(env)
    const allowed = new Set<string>([
      ...TRACES_DEPLOY_SECRETS,
      ...TRACES_DEPLOY_VARS,
      ...TRACES_DEPLOY_BUILD_INPUTS,
      'SSH_AUTH_SOCK',
    ])
    expect([...reads].filter(name => !allowed.has(name))).toEqual([])
  })

  it('accepts a complete environment and reads the optional pairs', () => {
    const inputs = readInputs(baseEnv(bootstrap))
    expect(inputs.langfuseKey?.publicKey).toBe('pk-lf-placeholder-app-public-11')
    expect(inputs.bootstrapKey?.secretKey).toBe('sk-lf-placeholder-boot-secret')
    expect(inputs.ingestOpen).toBe(true)
  })

  it('treats an unset or empty key pair as "not yet", not as an error', () => {
    expect(readInputs(baseEnv({...withoutKey})).langfuseKey).toBeUndefined()
    expect(
      readInputs(baseEnv({TRACES_LANGFUSE_PUBLIC_KEY: '', TRACES_LANGFUSE_SECRET_KEY: ''})).langfuseKey,
    ).toBeUndefined()
  })

  it('opens ingest only for the exact value true', () => {
    expect(readInputs(baseEnv({TRACES_INGEST_OPEN: 'true'})).ingestOpen).toBe(true)
    for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true x']) {
      expect(readInputs(baseEnv({TRACES_INGEST_OPEN: value})).ingestOpen).toBe(false)
    }
    expect(readInputs(baseEnv({TRACES_INGEST_OPEN: 'TRUE'})).ingestOpenWarning).toContain('only the exact value `true`')
    expect(readInputs(baseEnv({TRACES_INGEST_OPEN: ''})).ingestOpenWarning).toBeUndefined()
    expect(readInputs(baseEnv({TRACES_INGEST_OPEN: 'false'})).ingestOpenWarning).toBeUndefined()
  })

  it('names the input and never echoes its value when one is invalid', () => {
    const cases: [string, string][] = [
      ['TRACES_POSTGRES_PASSWORD', 'short'],
      ['TRACES_POSTGRES_PASSWORD', 'has a space and $dollar and more characters'],
      ['TRACES_NEXTAUTH_SECRET', 'x'.repeat(200)],
      ['TRACES_ENCRYPTION_KEY', 'z'.repeat(64)],
      ['TRACES_ENCRYPTION_KEY', 'a'.repeat(63)],
      ['TRACES_LANGFUSE_USER_EMAIL', 'not-an-email'],
      ['TRACES_LANGFUSE_USER_PASSWORD', 'bad;value;with;shell;chars'],
      ['TRACES_DOMAIN', 'Traces.Fro.Bot'],
      ['TRACES_DOMAIN', 'nodot'],
      ['TRACES_COLLECTOR_IMAGE', 'ghcr.io/example/repo/traces-collector:latest'],
      ['TRACES_COLLECTOR_IMAGE', `docker.io/example/traces-collector@${PLACEHOLDER_DIGEST}`],
      ['TRACES_COLLECTOR_IMAGE', `ghcr.io/example/repo/traces-collector@sha256:${'a'.repeat(63)}`],
      ['TRACES_HOST', '-oProxyCommand=evil'],
      ['TRACES_HOST', 'host name with spaces'],
      ['TRACES_DISCORD_WEBHOOK_URL', 'http://discord.com/api/webhooks/123456789012345678/placeholder-token-0123456789'],
      [
        'TRACES_DISCORD_WEBHOOK_URL',
        'https://example.com/api/webhooks/123456789012345678/placeholder-token-0123456789',
      ],
      ['TRACES_DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/123456789012345678/short'],
      ['TRACES_DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/12/placeholder-token-0123456789 extra'],
      [
        'TRACES_DISCORD_WEBHOOK_URL',
        'https://discord.com/api/webhooks/123456789012345678/placeholder-token-0123456789?wait=true',
      ],
    ]
    for (const [name, value] of cases) {
      let message = ''
      try {
        readInputs(baseEnv({[name]: value}))
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect({name, failed: message !== ''}).toEqual({name, failed: true})
      expect(message).not.toContain(value)
    }
  })

  it('requires every required input, and says which', () => {
    for (const name of [
      'TRACES_HOST',
      'TRACES_DOMAIN',
      'TRACES_COLLECTOR_IMAGE',
      'TRACES_POSTGRES_PASSWORD',
      'TRACES_CLICKHOUSE_PASSWORD',
      'TRACES_CLICKHOUSE_READER_PASSWORD',
      'TRACES_REDIS_PASSWORD',
      'TRACES_MINIO_PASSWORD',
      'TRACES_NEXTAUTH_SECRET',
      'TRACES_SALT',
      'TRACES_ENCRYPTION_KEY',
      'TRACES_GRAFANA_ADMIN_PASSWORD',
      'TRACES_GRAFANA_SECRET_KEY',
      'TRACES_DISCORD_WEBHOOK_URL',
      'TRACES_LANGFUSE_USER_EMAIL',
      'TRACES_LANGFUSE_USER_PASSWORD',
    ]) {
      expect(() => readInputs(baseEnv({[name]: undefined}))).toThrow(name)
    }
  })

  it('refuses half a key pair', () => {
    expect(() => readInputs(baseEnv({TRACES_LANGFUSE_SECRET_KEY: undefined}))).toThrow('set together')
    expect(() => readInputs(baseEnv({TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY: 'pk-lf-placeholder-boot-public'}))).toThrow(
      'set together',
    )
  })

  it('needs an SSH identity: the key (CI) or the agent (local)', () => {
    expect(() => readInputs(baseEnv({TRACES_SSH_KEY: undefined}))).toThrow('SSH context')
    expect(readInputs(baseEnv({TRACES_SSH_KEY: undefined, SSH_AUTH_SOCK: '/agent.sock'})).sshKey).toBeUndefined()
  })

  it('rejects bad input before any SSH call is made', async () => {
    const host = new FakeHost()
    await expect(run(host, baseEnv({TRACES_HOST: '-oProxyCommand=evil'}))).rejects.toThrow('TRACES_HOST')
    await expect(run(host, baseEnv({TRACES_POSTGRES_PASSWORD: 'short'}))).rejects.toThrow('TRACES_POSTGRES_PASSWORD')
    expect(host.calls).toHaveLength(0)
  })

  it('refuses to start without the Discord webhook, before any SSH call, naming the input and never its value', async () => {
    const host = new FakeHost()
    await expect(run(host, baseEnv({TRACES_DISCORD_WEBHOOK_URL: undefined}))).rejects.toThrow(
      'TRACES_DISCORD_WEBHOOK_URL is required',
    )
    await expect(run(host, baseEnv({TRACES_DISCORD_WEBHOOK_URL: '  '}))).rejects.toThrow('TRACES_DISCORD_WEBHOOK_URL')
    expect(host.calls).toHaveLength(0)
  })

  // The Grafana sign-in check proves the admin password is the file's value from one 200. That also proves it is not
  // Grafana's default (`admin`) only because a default can never be the file's value: the floor keeps it out.
  it("refuses a Grafana admin password that is Grafana's default or too short, before any SSH call", async () => {
    for (const weak of ['admin', 'password', 'a'.repeat(15)]) {
      expect(() => readInputs(baseEnv({TRACES_GRAFANA_ADMIN_PASSWORD: weak}))).toThrow(
        'TRACES_GRAFANA_ADMIN_PASSWORD must be 16 to 128 characters long',
      )
    }
    expect(() => readInputs(baseEnv({TRACES_GRAFANA_ADMIN_PASSWORD: 'a'.repeat(16)}))).not.toThrow()
    const host = new FakeHost()
    await expect(run(host, baseEnv({TRACES_GRAFANA_ADMIN_PASSWORD: 'admin'}))).rejects.toThrow(
      'TRACES_GRAFANA_ADMIN_PASSWORD',
    )
    expect(host.calls).toHaveLength(0)
  })

  it('stops on a DNS failure before any SSH call', async () => {
    const host = new FakeHost()
    const error = await failure(host, baseEnv(), {
      resolve: async () => {
        throw new Error('no such name')
      },
    })
    expect(error.message).toContain('DNS preflight failed')
    expect(host.calls).toHaveLength(0)
  })

  it('stops when the name resolves to another address than the host', async () => {
    const host = new FakeHost()
    const error = await failure(host, baseEnv({TRACES_HOST: '198.51.100.9'}), {resolve: async () => ['198.51.100.7']})
    expect(error.message).toContain('does not resolve to the deploy host')
    expect(host.calls).toHaveLength(0)
  })
})

// ─── Files and the compose contract ───────────────────────────────────────────

describe('what lands on the host', () => {
  const inputs = readInputs(baseEnv())

  it('writes every variable the compose file requires into .env, and no ingest-state line', () => {
    const compose = readFileSync(join(APP, 'docker-compose.yaml'), 'utf8')
    const required = [...new Set([...compose.matchAll(/\$\{(\w+):\?\}/g)].map(match => match[1]))]
    const env = buildEnvFile(inputs)
    for (const name of required)
      expect(env).toContain(`\n${name}=`.replace('\n', env.startsWith(`${name}=`) ? '' : '\n'))
    expect(required.length).toBeGreaterThan(8)
    expect(env).not.toContain('TRACES_INGEST_STATE')
    expect(env.endsWith('\n')).toBe(true)
  })

  it('writes the Discord webhook into .env, where the compose file reads it for Grafana, and nowhere else', () => {
    const env = buildEnvFile(inputs)
    expect(env).toContain(`TRACES_DISCORD_WEBHOOK_URL=${baseEnv().TRACES_DISCORD_WEBHOOK_URL}\n`)
    const files = buildSecretFiles(inputs)
    for (const file of files) expect(file.content).not.toContain('discord.com')
    expect(buildEnvManagedFile(inputs)).toMatchObject({owner: 'root:root', mode: '0600'})
  })

  it('writes the bootstrap key variables only when the pair is supplied', () => {
    expect(buildEnvFile(inputs)).not.toContain('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')
    expect(buildEnvFile(inputs)).not.toContain('LANGFUSE_INIT_PROJECT_SECRET_KEY')
    const supplied = buildEnvFile(readInputs(baseEnv(bootstrap)))
    expect(supplied).toContain('LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-placeholder-boot-public')
    expect(supplied).toContain('LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-placeholder-boot-secret')
    // Organisation, project and user variables stay either way: they are idempotent upserts.
    expect(buildEnvFile(inputs)).toContain('LANGFUSE_INIT_ORG_ID=')
    expect(buildEnvFile(inputs)).toContain('LANGFUSE_INIT_USER_EMAIL=operator@example.invalid')
  })

  it('writes the collector credential as base64 of public:secret with no trailing newline', () => {
    const value = langfuseBasicValue({publicKey: 'pk-lf-a1a1a1a1', secretKey: 'sk-lf-b2b2b2b2'})
    expect(Buffer.from(value, 'base64').toString('utf8')).toBe('pk-lf-a1a1a1a1:sk-lf-b2b2b2b2')
    expect(value.endsWith('\n')).toBe(false)
    const file = buildSecretFiles(inputs).find(entry => entry.path === 'secrets/collector/langfuse-basic')
    expect(file?.content.endsWith('\n')).toBe(false)
  })

  it('writes a credential Langfuse refuses when there is no key pair yet, so the collector can still start', () => {
    const value = langfuseBasicValue(undefined)
    expect(Buffer.from(value, 'base64').toString('utf8')).toBe('pk-lf-unset:sk-lf-unset')
  })

  it('gives each secret file the owner and mode its container user needs', () => {
    const byPath = Object.fromEntries(buildSecretFiles(inputs).map(file => [file.path, file]))
    expect(byPath['secrets/collector/langfuse-basic']).toMatchObject({owner: 'root:65532', mode: '0440'})
    expect(byPath['secrets/grafana/admin-password']).toMatchObject({owner: '472:472', mode: '0400'})
    expect(byPath['secrets/grafana/secret-key']).toMatchObject({owner: '472:472', mode: '0400'})
    // The reporter runs as Tempo's user (Tempo's directories are 0700), so its files belong to that user.
    const reporter = `${TEMPO_USER_ID}:${TEMPO_USER_ID}`
    expect(byPath['secrets/reporter/clickhouse-password']).toMatchObject({owner: reporter, mode: '0400'})
    expect(byPath['secrets/reporter/minio-password']).toMatchObject({owner: reporter, mode: '0400'})
  })

  it("gives the reporter's secret directory to the reporter's group", () => {
    const script = prepareDirsScript(ID_A)
    expect(script).toContain(`-g ${TEMPO_USER_ID} -m 0750 ${TRACES_APP_DIR}/secrets/reporter`)
  })

  it('puts each secret where the consumer reads it', () => {
    const paths = buildSecretFiles(inputs).map(file => file.path)
    expect(paths).toContain(`secrets/reporter/${basename(PATHS.clickhousePasswordFile)}`)
    expect(paths).toContain(`secrets/reporter/${basename(PATHS.objectStorePasswordFile)}`)
    const compose = readFileSync(join(APP, 'docker-compose.yaml'), 'utf8')
    for (const file of ['admin-password', 'secret-key']) {
      expect(compose).toContain(`/run/secrets/grafana/${file}`)
      expect(paths).toContain(`secrets/grafana/${file}`)
    }
    expect(readFileSync(join(APP, 'config/otelcol.yaml'), 'utf8')).toContain('/etc/otelcol/secrets/langfuse-basic')
    expect(paths).toContain('secrets/collector/langfuse-basic')
  })

  it('uploads every file under config/, the compose file and the reporter source, and nothing that is missing', () => {
    const locals = UPLOADED_FILES.map(file => file.local)
    for (const local of locals) expect(() => readFileSync(join(APP, local))).not.toThrow()

    const found: string[] = []
    const walk = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(join(APP, directory), {withFileTypes: true})) {
        const relative = `${prefix}${entry.name}`
        if (entry.isDirectory()) walk(`${directory}/${entry.name}`, `${relative}/`)
        else if (!entry.name.endsWith('.test.ts')) found.push(`config/${relative}`.replace('config/config/', 'config/'))
      }
    }
    walk('config', '')
    // The mirror of the loss rules and its promtool cases are tests: Prometheus never loads them, so deploy never
    // uploads them, and nothing may mount them.
    const testOnly = ['config/prometheus/loss-rules.yml', 'config/prometheus/loss-rules.test.yml']
    for (const file of testOnly) {
      expect(found).toContain(file)
      expect(locals).not.toContain(file)
    }
    expect(readFileSync(join(APP, 'docker-compose.yaml'), 'utf8')).not.toContain('loss-rules')
    expect([...locals.filter(local => local.startsWith('config/'))].sort()).toEqual(
      found.filter(file => !testOnly.includes(file)).sort(),
    )
    expect(locals).toContain('docker-compose.yaml')
    expect(UPLOADED_FILES.find(file => file.local === 'src/health-report.ts')?.remote).toBe(
      'health-reporter/health-report.ts',
    )
  })

  it('uploads the Prometheus config, the Prometheus data source and the three alerting files, each restarting its own service', () => {
    const touches = Object.fromEntries(UPLOADED_FILES.map(file => [file.local, file.touches]))
    expect(touches['config/prometheus/prometheus.yml']).toEqual(['prometheus'])
    expect(touches['config/grafana/datasources/prometheus.yaml']).toEqual(['grafana'])
    for (const name of ['contact-points', 'policies', 'rules']) {
      expect(touches[`config/grafana/alerting/${name}.yaml`]).toEqual(['grafana'])
    }
  })

  it('creates the directories those files go into', () => {
    const script = prepareDirsScript(ID_A)
    expect(script).toContain(`${TRACES_APP_DIR}/config/prometheus`)
    expect(script).toContain(`${TRACES_APP_DIR}/config/grafana/alerting`)
  })

  it('lists exactly the compose services', () => {
    const compose = Bun.YAML.parse(readFileSync(join(APP, 'docker-compose.yaml'), 'utf8')) as {
      name: string
      services: Record<string, unknown>
      volumes: Record<string, unknown>
    }
    expect(Object.keys(compose.services).sort()).toEqual([...SERVICES].sort())
    expect(compose.name).toBe('traces')
    expect(Object.keys(compose.volumes)).toContain('collector_queue')
  })

  it('gates the collector, the backends and Caddy, and not Grafana, Prometheus or the reporter', () => {
    expect((SERVICES as readonly string[]).includes('prometheus')).toBe(true)
    expect((GATED_SERVICES as readonly string[]).includes('prometheus')).toBe(false)
    expect([...GATED_SERVICES].sort() as string[]).toEqual(
      [
        'caddy',
        'clickhouse',
        'collector',
        'langfuse-web',
        'langfuse-worker',
        'minio',
        'postgres',
        'redis',
        'tempo',
      ].sort(),
    )
  })
})

// ─── Remote scripts ───────────────────────────────────────────────────────────

describe('remote scripts', () => {
  const scripts: Record<string, string> = {
    begin: beginDeployScript(ID_A),
    drift: driftScript(),
    ingestState: readIngestStateScript(),
    removeMarker: removeOwnFileScript(ID_A, '.deploy-in-progress'),
    prepareDirs: prepareDirsScript(ID_A),
    tokenDirs: tokenDirsScript(),
    comparePlain: compareFileScript('config/otelcol.yaml', 'plain', {owner: 'root:root', mode: '0644'}),
    compareEnv: compareFileScript('.env', 'env', {owner: 'root:root', mode: '0600'}),
    writePlain: writeFileScript(ID_A, {
      path: 'secrets/grafana/admin-password',
      owner: '472:472',
      mode: '0400',
      kind: 'plain',
    }),
    writeEnv: writeFileScript(ID_A, {path: '.env', owner: 'root:root', mode: '0600', kind: 'env'}, 'held'),
    removeRestarts: removeOwnFileScript(ID_A, '.pending-restarts'),
    removePending: removeOwnFileScript(ID_A, 'secrets/bootstrap-pending'),
    probeIngest: probeIngestScript('traces.fro.bot'),
    disk: diskScript(),
    prune: pruneScript(ID_A),
    pull: pullScript(ID_A),
    upPrivate: upScript(ID_A, 'up-private', ['postgres', 'redis']),
    upForced: upScript(ID_A, 'up-stale', ['collector'], {force: true}),
    create: createCollectorScript(ID_A),
    queue: queueVolumeScript(ID_A),
    createPrometheus: createPrometheusScript(ID_A),
    prometheusVolume: prometheusVolumeScript(ID_A),
    createEmbedder: createEmbedderScript(ID_A),
    embedderVolume: embedderVolumeScript(ID_A),
    digest: runningDigestScript('collector'),
    bootstrap: bootstrapProbeScript(),
    hygiene: hygieneScript(),
    canary: canaryScript(ID_A),
    grafana: grafanaSignInScript(),
    grafanaAlerting: grafanaAlertingScript(),
    ...Object.fromEntries(SENDER_GROUPS.map(group => [`token-${group}`, tokenFileScript(group, ID_A)])),
  }

  it('parse as bash', () => {
    for (const [name, script] of Object.entries({...scripts, setState: setIngestStateCommand('held', ID_A)})) {
      const parsed = Bun.spawnSync(['bash', '-n', '-c', script])
      expect({name, exit: parsed.exitCode, stderr: parsed.stderr.toString()}).toEqual({name, exit: 0, stderr: ''})
    }
  })

  it('carry a step marker and end in a sentinel', () => {
    for (const [name, script] of Object.entries(scripts)) {
      expect({name, marker: script.includes('# traces-step:')}).toEqual({name, marker: true})
      const last = script.trimEnd().split('\n').at(-1) ?? ''
      expect({name, sentinel: /^(?:echo |fi$)/.test(last) || last.includes('TRACES_')}).toEqual({name, sentinel: true})
    }
  })

  it('never redirect to the null device and never delete outside the app directory or /tmp', () => {
    const everything = {
      ...scripts,
      setState: setIngestStateCommand('held', ID_A),
      detail: REPORTER_DETAIL_COMMAND,
    }
    for (const [name, script] of Object.entries(everything)) {
      expect({name, nullDevice: script.includes('/dev/null')}).toEqual({name, nullDevice: false})
      for (const line of script.split('\n')) {
        const remove = /\brm\b(.*)$/.exec(line)
        if (remove === null) continue
        const target = remove[1] ?? ''
        const allowed =
          /^ -f "\$t"/.test(target) ||
          target.includes(`${TRACES_APP_DIR}/`) ||
          /^ -f '?\$t'?;?$/.test(target.trim()) ||
          target.includes('docker image prune')
        expect({name, line, allowed}).toEqual({name, line, allowed: true})
      }
    }
  })

  it('refuse a service or path they were not built for', () => {
    expect(() => upScript(ID_A, 'up-x', ['not-a-service'])).toThrow('Unknown service')
    expect(() => upScript(ID_A, 'up-x', [])).toThrow('at least one service')
    expect(() => runningDigestScript('nope' as never)).toThrow('Unknown service')
    expect(() => tokenFileScript('stranger' as never, ID_A)).toThrow('Unknown sender group')
    expect(() => probeIngestScript('bad domain; id')).toThrow('Unsafe domain')
    const plain = {path: 'x', owner: 'root:root', mode: '0600', kind: 'plain'} as const
    expect(() => writeFileScript(ID_A, {...plain, path: 'a/../b'})).toThrow('Unsafe')
    expect(() => writeFileScript(ID_A, {...plain, owner: 'root:root; id'})).toThrow('owner')
    expect(() => writeFileScript(ID_A, {...plain, mode: '600'})).toThrow('mode')
    expect(() => writeFileScript(ID_A, {...plain, path: '.env', kind: 'env'})).toThrow('ingest state')
    expect(() => writeFileScript('not-an-id', plain)).toThrow('deploy id')
    expect(() => beginDeployScript('not-an-id')).toThrow('deploy id')
  })

  it('writes through a temporary file in the same directory and an atomic rename, owner and mode first', () => {
    const script = scripts.writePlain ?? ''
    const order = ['mktemp', 'cat > "$t"', 'chown 472:472', 'chmod 0400', 'mv -f']
    const positions = order.map(fragment => script.indexOf(fragment))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(scripts.writePlain).toContain('umask 077')
  })

  it('compares and writes .env without its ingest-state line, and appends the state on the host', () => {
    expect(scripts.compareEnv).toContain("grep -v '^TRACES_INGEST_STATE='")
    const writeEnv = scripts.writeEnv ?? ''
    expect(writeEnv).toContain('planned=held')
    expect(writeEnv).toContain(String.raw`printf 'TRACES_INGEST_STATE=%s\n' "$state" >> "$t"`)
    // The state on the host is re-read under the lock, in the script that replaces the file.
    expect(writeEnv).toContain('flock -w 30')
    expect(writeEnv.indexOf('flock -w 30')).toBeLessThan(writeEnv.indexOf('s/^TRACES_INGEST_STATE=//p'))
    expect(writeEnv.indexOf('s/^TRACES_INGEST_STATE=//p')).toBeLessThan(writeEnv.indexOf('mv -f'))
  })

  it('compares and prints nothing but a sentinel for a secret file', () => {
    expect(scripts.comparePlain).not.toMatch(/cat [^>]/)
    expect(scripts.comparePlain).toContain('cmp -s')
  })

  it('compares the numeric owner and the mode too, naming the pair the file should have', () => {
    expect(scripts.comparePlain).toContain("stat -c '%u:%g %a'")
    expect(scripts.comparePlain).toContain(`[ "$attr" = '0:0 644' ]`)
    expect(scripts.compareEnv).toContain(`[ "$attr" = '0:0 600' ]`)
    const attrs = (owner: string, mode: string): string => compareFileScript('x', 'plain', {owner, mode})
    expect(attrs('root:65532', '0440')).toContain(`[ "$attr" = '0:65532 440' ]`)
    expect(attrs('472:472', '0400')).toContain(`[ "$attr" = '472:472 400' ]`)
    expect(attrs(`${TEMPO_USER_ID}:${TEMPO_USER_ID}`, '0400')).toContain(
      `[ "$attr" = '${TEMPO_USER_ID}:${TEMPO_USER_ID} 400' ]`,
    )
    expect(() => attrs('root:root; id', '0644')).toThrow('owner')
    expect(() => attrs('root:root', '644')).toThrow('mode')
  })

  it('probe ingest from inside the host, through the real route, printing no body', () => {
    const script = scripts.probeIngest ?? ''
    expect(script).toContain('--resolve traces.fro.bot:443:127.0.0.1')
    expect(script).toContain('-X POST')
    expect(script).toContain("--data '{}'")
    for (const group of SENDER_GROUPS) expect(script).toContain(group)
    expect(script).not.toContain('Authorization')
  })

  it('send the bootstrap credential on stdin and print only a status code', () => {
    const script = scripts.bootstrap ?? ''
    expect(script).toContain('exec -T langfuse-web node -e')
    expect(script).toContain('process.stdin')
    expect(script).not.toMatch(/--header|-H /)
    expect(script).toContain('TRACES_BOOTSTRAP_HTTP=')
  })

  it('count bootstrap key variables without printing a value', () => {
    const script = scripts.hygiene ?? ''
    expect(script).toContain('grep -c')
    expect(script).not.toMatch(/\becho "\$\{?(pk|sk|key)/)
    expect(script).toContain('docker inspect')
  })

  it("makes the Grafana secret directory root:472, 0750: the group Grafana's compose user carries", () => {
    expect(scripts.prepareDirs).toContain(
      `install -d -o root -g ${GRAFANA_USER_ID} -m 0750 ${TRACES_APP_DIR}/secrets/grafana`,
    )
  })

  it('gives Prometheus its own data volume to its own user, once, and reads the owner back', () => {
    const script = scripts.prometheusVolume ?? ''
    expect(PROMETHEUS_USER_ID).toBe(65_534)
    expect(script).toContain('docker volume inspect traces_prometheus_data')
    expect(script).toContain(`chown ${PROMETHEUS_USER_ID}:${PROMETHEUS_USER_ID} "$mp"`)
    expect(script).toContain(`${TRACES_DOCKER_ROOT}/volumes/*/_data`)
    expect(script).toContain('stat -c')
    expect(script).toContain('TRACES_PROMETHEUS_VOLUME_READY')
    expect(script).not.toContain('traces_collector_queue')
    expect(scripts.createPrometheus).toContain('create --no-recreate prometheus')
    expect(scripts.createPrometheus).not.toContain('collector')
  })

  it('gives the embedder its own model volume to its own user, once, and reads the owner back', () => {
    const script = scripts.embedderVolume ?? ''
    expect(EMBEDDER_USER_ID).toBe(65_534)
    expect(script).toContain('docker volume inspect traces_embedder_models')
    expect(script).toContain(`chown ${EMBEDDER_USER_ID}:${EMBEDDER_USER_ID} "$mp"`)
    expect(script).toContain(`${TRACES_DOCKER_ROOT}/volumes/*/_data`)
    expect(script).toContain('stat -c')
    expect(script).toContain('TRACES_EMBEDDER_VOLUME_READY')
    expect(script).not.toContain('traces_collector_queue')
    expect(script).not.toContain('traces_prometheus_data')
    expect(scripts.createEmbedder).toContain('create --no-recreate embedder')
    expect(scripts.createEmbedder).not.toContain('collector')
  })

  it('check Grafana sign-in on its loopback port with the password read from the file on the host', () => {
    const script = scripts.grafana ?? ''
    expect(script).toContain('http://127.0.0.1:3001/api/user')
    expect(script).toContain('secrets/grafana/admin-password')
    // The credential is built inside the host's shell from the file and handed to curl as a config on stdin.
    expect(script).toContain('-K -')
    expect(script).toContain(String.raw`printf 'user = "admin:%s"\n' "$(cat "$file")"`)
    // No credential in any curl argument, and no request that spends a failed login on the admin account.
    expect(script).not.toMatch(/(?:-u|--user) /)
    expect(script).not.toContain('admin:admin')
    expect(script).not.toMatch(/--header|-H |Authorization|--basic/)
    // Only the status code is printed: the response body is captured and dropped, and curl's own errors are off.
    expect(script).toContain('TRACES_GRAFANA_FILE_HTTP=')
    expect(script).not.toContain('TRACES_GRAFANA_DEFAULT_HTTP')
    expect(script).not.toMatch(/curl [^\n]*-S/)
    expect(script).not.toMatch(/\bset -x\b|\bxtrace\b/)
  })

  it('keeps the Grafana probe on loopback: curl skips .curlrc (-q, its first argument) and any proxy from the host environment', () => {
    const script = scripts.grafana ?? ''
    const curls = script.split('\n').flatMap(line => (/\bcurl\b/.test(line) ? [line] : []))
    expect(curls).toHaveLength(1)
    // `-q` is only honoured as the very first argument.
    expect(curls[0]).toMatch(/\| curl -q /)
    expect(curls[0]).toContain("--noproxy '*'")
  })

  it('set the queue volume owner only under the Docker data root, and read it back', () => {
    const script = scripts.queue ?? ''
    expect(script).toContain('/mnt/traces/docker/volumes/*/_data')
    expect(script).toContain('chown 65532:65532')
    expect(script).toContain("stat -c '%u:%g'")
  })

  it('creates a missing token file by an atomic no-clobber link and never writes, truncates or removes an existing one', () => {
    for (const group of SENDER_GROUPS) {
      const script = scripts[`token-${group}`] ?? ''
      expect(script).toContain('ln "$t" "$f"')
      expect(script).not.toContain('set -C')
      expect(script).not.toMatch(/\bmv\b/)
      expect(script).not.toMatch(/\btruncate\b/)
      expect(script).not.toMatch(/\btee\b/)
      expect(script).toContain('chown root:65532')
      expect(script).toContain('chmod 0640')
      // The only thing removed is the temporary file; the only write is into it, from stdin.
      expect(script.split('\n').filter(line => /\brm\b/.test(line))).toEqual([`trap 'rm -f "$t"' EXIT`])
      expect(script.split('\n').filter(line => />\s*"\$t"/.test(line))).toEqual([
        String.raw`printf '%s\n' "$line" > "$t"`,
      ])
      // Nothing else is redirected anywhere but to stderr.
      // (and the step lock file, a regular file under the app directory, which the ownership check opens first).
      expect(
        script
          .split('\n')
          .filter(line => />/.test(line) && !/>\s*"\$t"|>&2/.test(line) && !line.startsWith('exec 8>>')),
      ).toEqual([])
      expect(script).toContain('line=$(cat)')
      expect(script).not.toContain('trc_void_')
    }
  })

  it('creates a missing token file as deny-all, and leaves an existing file alone, when it runs for real', () => {
    const root = mkdtempSync(join(tmpdir(), 'traces-token-test-'))
    try {
      const shim = join(root, 'shim')
      mkdirSync(shim)
      // `chown` to another user needs root, and macOS has no `flock`. The shims make both no-ops so the real script
      // runs unprivileged (the step lock itself is exercised below, with a real lock).
      for (const name of ['chown', 'flock']) {
        writeFileSync(join(shim, name), '#!/bin/sh\nexit 0\n')
        chmodSync(join(shim, name), 0o755)
      }

      // The deploy owns the host: its marker holds its id.
      writeFileSync(join(root, '.deploy-in-progress'), `${ID_A} 2023-11-14T22:13:20.000Z\n`)
      for (const group of SENDER_GROUPS) mkdirSync(join(root, 'tokens', group), {recursive: true})
      const existing = join(root, 'tokens', 'fro-bot', 'token')
      const bytes = Buffer.from('first-placeholder-token\nsecond-placeholder-token extra column\n')
      writeFileSync(existing, bytes)
      chmodSync(existing, 0o600)
      const empty = join(root, 'tokens', 'workstation', 'token')
      writeFileSync(empty, '')
      const voidLine = generateVoidTokenLine()

      const runScript = (group: (typeof SENDER_GROUPS)[number], stdin: string): {out: string; code: number} => {
        const result = Bun.spawnSync(['bash', '-o', 'pipefail', '-c', tokenFileScript(group, ID_A, root)], {
          env: {PATH: `${shim}:${process.env.PATH ?? ''}`},
          stdin: new TextEncoder().encode(stdin),
        })
        return {out: result.stdout.toString().trim(), code: result.exitCode}
      }

      const before = statSync(existing)
      expect(runScript('fro-bot', `${voidLine}\n`)).toEqual({out: 'TRACES_TOKEN_PRESENT', code: 0})
      expect(readFileSync(existing).equals(bytes)).toBe(true)
      const afterStat = statSync(existing)
      expect([afterStat.mtimeMs, afterStat.size, afterStat.mode]).toEqual([before.mtimeMs, before.size, before.mode])

      // Whatever mode an existing token file has, it is left as it is: not compared, not corrected, not rewritten.
      for (const mode of [0o644, 0o400, 0o666, 0o000]) {
        chmodSync(existing, mode)
        const modeBefore = statSync(existing).mode
        expect(runScript('fro-bot', `${voidLine}\n`)).toEqual({out: 'TRACES_TOKEN_PRESENT', code: 0})
        expect(statSync(existing).mode).toBe(modeBefore)
      }
      chmodSync(existing, 0o600)
      expect(readFileSync(existing).equals(bytes)).toBe(true)

      // An existing empty file is not repaired here either: the gate reports it.
      expect(runScript('workstation', `${voidLine}\n`)).toEqual({out: 'TRACES_TOKEN_PRESENT', code: 0})
      expect(readFileSync(empty).length).toBe(0)

      expect(runScript('marcusrbrown', `${voidLine}\n`)).toEqual({out: 'TRACES_TOKEN_CREATED', code: 0})
      const created = join(root, 'tokens', 'marcusrbrown', 'token')
      expect(readFileSync(created, 'utf8')).toBe(`${voidLine}\n`)
      // A second run is a no-op, even with a different line.
      expect(runScript('marcusrbrown', `${generateVoidTokenLine()}\n`)).toEqual({out: 'TRACES_TOKEN_PRESENT', code: 0})
      expect(readFileSync(created, 'utf8')).toBe(`${voidLine}\n`)
      // Nothing is left behind in the token directory but the token file.
      expect(readdirSync(join(root, 'tokens', 'marcusrbrown'))).toEqual(['token'])

      // Something that is not a regular file in its place is an error, never "created".
      rmSync(created)
      mkdirSync(created)
      expect(runScript('marcusrbrown', `${voidLine}\n`).code).not.toBe(0)
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  })

  it('uses the same on-host mechanism as `traces ingest` and `traces status`', () => {
    const remote = readFileSync(join(APP, '..', '..', 'packages/cli/src/commands/traces/remote.ts'), 'utf8')
    const command = setIngestStateCommand('held', ID_A)
    // Parts of the state-change command. Each is in the CLI's source and in this deploy's command.
    for (const fragment of [
      'set -e',
      't=$(mktemp ./.env.XXXXXX)',
      '{ grep -v \'^TRACES_INGEST_STATE=\' .env || true; cat; } > "$t"',
      'chmod 600 "$t"',
      'mv "$t" .env',
      'up -d --force-recreate --no-deps caddy',
      'TRACES_INGEST_STATE_SET=',
    ]) {
      expect({fragment, cli: remote.includes(fragment)}).toEqual({fragment, cli: true})
      expect({fragment, deploy: command.includes(fragment)}).toEqual({fragment, deploy: true})
    }
    expect(remote).toContain('docker compose --project-directory ')
    expect(command).toContain(`docker compose --project-directory ${TRACES_APP_DIR} up -d`)
    expect(command).toContain(`cd ${TRACES_APP_DIR}`)

    // The reporter's loopback detail, read by exec with the same trailing sentinel.
    expect(remote).toContain('exec -T health-reporter wget -q -O - http://127.0.0.1:8081/detail && echo && echo ')
    expect(remote).toContain("'TRACES_DETAIL_END'")
    expect(REPORTER_DETAIL_COMMAND).toBe(
      `docker compose --project-directory ${TRACES_APP_DIR} exec -T health-reporter wget -q -O - http://127.0.0.1:8081/detail && echo && echo TRACES_DETAIL_END`,
    )
  })

  // The deploy's canary: the reporter script run once in its own container. No new service, port or route.
  it('runs the canary through exec in the reporter container, with the flag the script reads', async () => {
    const script = canaryScript(ID_A)
    expect(script).toContain('# traces-step:reporter-canary\n')
    expect(script).toContain(
      `docker compose --project-directory ${TRACES_APP_DIR} exec -T health-reporter bun run --no-install /app/health-report.ts ${CANARY_ONCE_FLAG} && echo && echo TRACES_CANARY_END`,
    )
    // A step that changes the host: the step lock and the marker check come before the exec, which the lock outlives.
    const lines = script.split('\n')
    expect(lines.at(-1)).toContain('exec -T health-reporter')
    expect(script.indexOf(ownershipPrelude(ID_A))).toBeGreaterThan(-1)
    expect(script.indexOf(ownershipPrelude(ID_A))).toBeLessThan(script.indexOf('exec -T health-reporter'))
    const compose = await Bun.file(join(APP, 'docker-compose.yaml')).text()
    expect(compose).toContain('command: [bun, run, --no-install, /app/health-report.ts]')
  })
})

// ─── SSH ──────────────────────────────────────────────────────────────────────

describe('ssh', () => {
  const target = {
    host: 'deploy-host.invalid',
    identityFile: '/scratch/id',
    controlPath: '/scratch/cm-%C',
    knownHostsFile: undefined,
  }

  it('pins host keys, shares one connection and puts only a fixed command in argv', () => {
    const argv = sshArgv(target, 'bash -o pipefail -c true')
    expect(argv.slice(0, 3)).toEqual(['ssh', '-i', '/scratch/id'])
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('ControlMaster=auto')
    expect(argv).toContain('ControlPath=/scratch/cm-%C')
    expect(argv.at(-2)).toBe('root@deploy-host.invalid')
    expect(argv.at(-1)).toBe('bash -o pipefail -c true')
  })

  it('uses a pinned known_hosts file when one is given and the agent when there is no key file', () => {
    const argv = sshArgv({...target, identityFile: undefined, knownHostsFile: '/repo/.github/known_hosts'}, 'true')
    expect(argv).not.toContain('-i')
    expect(argv).toContain('UserKnownHostsFile=/repo/.github/known_hosts')
  })

  it('rejects a host that ssh would read as an option', () => {
    expect(() => sshArgv({...target, host: '-oProxyCommand=evil'}, 'true')).toThrow('Invalid TRACES_HOST')
    expect(() => closeMasterArgv({...target, host: '-x'})).toThrow('Invalid TRACES_HOST')
  })

  it('closes the shared connection with -O exit', () => {
    const argv = closeMasterArgv(target)
    expect(argv).toContain('-O')
    expect(argv).toContain('exit')
  })

  it('hands the ssh child no secret: only PATH, HOME and the agent socket', () => {
    const polluted = baseEnv({
      PATH: '/bin',
      HOME: '/home/x',
      SSH_AUTH_SOCK: '/agent.sock',
      GITHUB_TOKEN: 'placeholder-gh-token',
    })
    const child = sshChildEnv(polluted)
    expect(Object.keys(child).sort()).toEqual(['HOME', 'PATH', 'SSH_AUTH_SOCK'])
    for (const secret of [...secretValues(polluted), 'placeholder-gh-token']) {
      expect(Object.values(child).some(value => value.includes(secret))).toBe(false)
    }
    expect(sshChildEnv({})).toEqual({PATH: '/usr/bin:/bin', HOME: '/tmp'})
  })
})

// ─── Parsers ──────────────────────────────────────────────────────────────────

describe('host state', () => {
  const answer = (overrides: Record<string, string> = {}): string => {
    const values: Record<string, string> = {
      has_env: '1',
      marker: '0',
      ingest: 'open',
      env_bootstrap_public: '',
      env_bootstrap_secret: '',
      pending: '',
      restarts: '',
      epoch: '1700000000',
      ...overrides,
    }
    const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`)
    return `${lines.join('\n')}\nTRACES_HOST_STATE_READ\n`
  }

  it('reads a normal answer', () => {
    expect(parseHostState(answer())).toEqual({
      hasEnv: true,
      marker: false,
      ingest: 'open',
      envBootstrap: undefined,
      pendingBootstrap: undefined,
      pendingRestarts: [],
      epoch: 1_700_000_000,
    })
  })

  it('reads the bootstrap pair from the env file or the pending record, and pending restarts', () => {
    const state = parseHostState(
      answer({
        ingest: 'held',
        env_bootstrap_public: 'pk-lf-aaaaaaaa',
        env_bootstrap_secret: 'sk-lf-bbbbbbbb',
        pending: 'pk-lf-cccccccc:sk-lf-dddddddd',
        restarts: 'collector compose',
      }),
    )
    expect(state.envBootstrap).toEqual({publicKey: 'pk-lf-aaaaaaaa', secretKey: 'sk-lf-bbbbbbbb'})
    expect(state.pendingBootstrap).toEqual({publicKey: 'pk-lf-cccccccc', secretKey: 'sk-lf-dddddddd'})
    expect(state.pendingRestarts).toEqual(['collector', 'compose'])
  })

  it('reads the deploy marker', () => {
    expect(parseHostState(answer({marker: '1'})).marker).toBe(true)
  })

  it('treats a host with no .env as having no ingest state', () => {
    expect(parseHostState(answer({has_env: '0', ingest: 'none'})).ingest).toBe('none')
  })

  it('fails closed on an ingest state it does not know, half a key pair, an unknown restart or a missing marker answer', () => {
    expect(() => parseHostState(answer({ingest: 'wide-open'}))).toThrow('does not recognise')
    expect(() => parseHostState(answer({env_bootstrap_public: 'pk-lf-aaaaaaaa'}))).toThrow('complete key pair')
    expect(() => parseHostState(answer({restarts: 'rm-rf'}))).toThrow('pending-restart')
    expect(() => parseHostState(answer({epoch: '0'}))).toThrow('clock')
    expect(() => parseHostState(answer({marker: 'maybe'}))).toThrow('deploy marker')
    expect(() => parseHostState(answer().replace('marker=0\n', ''))).toThrow('deploy marker')
  })
})

describe('probes', () => {
  it('parses ingest codes and proves a state only when every group answers as that state does', () => {
    const lines = SENDER_GROUPS.map(group => `TRACES_INGEST_CODE ${group} 503`).join('\n')
    const statuses = parseIngestProbe(`${lines}\nTRACES_INGEST_PROBED\n`)
    expect(provesState(statuses, 'held')).toBe(true)
    expect(provesState(statuses, 'open')).toBe(false)
    expect(provesState({...statuses, workstation: 401}, 'held')).toBe(false)
    expect(provesState({marcusrbrown: 503, 'fro-bot': 503}, 'held')).toBe(false)
    expect(provesState(parseIngestProbe('TRACES_INGEST_CODE fro-bot 000\n'), 'held')).toBe(false)
    expect(provesState(Object.fromEntries(SENDER_GROUPS.map(g => [g, 404])), 'off')).toBe(true)
    expect(provesState(Object.fromEntries(SENDER_GROUPS.map(g => [g, 401])), 'open')).toBe(true)
  })

  it('reads the reporter detail only from a complete, well-formed answer', () => {
    const host = new FakeHost()
    const good = ok(`${JSON.stringify(host.reporterDetail())}\nTRACES_DETAIL_END\n`)
    expect(parseReporterDetail(good)?.ok).toBe(true)
    expect(parseReporterDetail({...good, exitCode: 1})).toBeUndefined()
    expect(parseReporterDetail(ok(JSON.stringify(host.reporterDetail())))).toBeUndefined()
    expect(parseReporterDetail(ok('not json\nTRACES_DETAIL_END\n'))).toBeUndefined()
    expect(parseReporterDetail(ok('{"schemaVersion":2}\nTRACES_DETAIL_END\n'))).toBeUndefined()
    const bad = {...host.reporterDetail(), checks: [{id: 'x', status: 'great', detail: 'y'}]}
    expect(parseReporterDetail(ok(`${JSON.stringify(bad)}\nTRACES_DETAIL_END\n`))).toBeUndefined()
  })

  it('reads the canary checks only from a complete, well-formed answer', () => {
    const host = new FakeHost()
    const body = JSON.stringify({schemaVersion: 1, checks: host.canaryChecks()})
    const good = ok(`${body}\nTRACES_CANARY_END\n`)
    expect(parseCanaryChecks(good)?.map(check => check.id)).toEqual(['canary-send', 'canary-langfuse', 'canary-tempo'])
    expect(parseCanaryChecks({...good, exitCode: 1})).toBeUndefined()
    expect(parseCanaryChecks(ok(body))).toBeUndefined()
    expect(parseCanaryChecks(ok(`${body}\nTRACES_DETAIL_END\n`))).toBeUndefined()
    expect(parseCanaryChecks(ok('not json\nTRACES_CANARY_END\n'))).toBeUndefined()
    expect(parseCanaryChecks(ok('{"schemaVersion":2,"checks":[]}\nTRACES_CANARY_END\n'))).toBeUndefined()
    expect(parseCanaryChecks(ok('{"schemaVersion":1}\nTRACES_CANARY_END\n'))).toBeUndefined()
    const bad = {schemaVersion: 1, checks: [{id: 'canary-send', status: 'great', detail: 'y'}]}
    expect(parseCanaryChecks(ok(`${JSON.stringify(bad)}\nTRACES_CANARY_END\n`))).toBeUndefined()
  })
})

// ─── Gates ────────────────────────────────────────────────────────────────────

describe('gates', () => {
  const detail = new FakeHost().reporterDetail()
  const canaryChecks = (change: Record<string, unknown>[] = []): CanaryState => ({
    state: 'ran',
    checks: parseCanaryChecks(
      ok(`${JSON.stringify({schemaVersion: 1, checks: change})}\nTRACES_CANARY_END\n`),
    ) as never,
  })
  const passingCanary = (): CanaryState => ({
    state: 'ran',
    checks: new FakeHost().canaryChecks() as never,
  })
  const passing = (): GateInputs => ({
    keyPairSet: true,
    ingestVariableTrue: true,
    retentionDetail: 'retention ok',
    tokenFiles: {marcusrbrown: 0, 'fro-bot': 1, workstation: 0},
    verdict: {
      state: 'fresh',
      detail: parseReporterDetail(ok(`${JSON.stringify(detail)}\nTRACES_DETAIL_END\n`)) as never,
    },
    canary: passingCanary(),
    bootstrap: {supplied: false, probe: 'dead', hygiene: {envFile: 0, running: 0}},
  })

  it('passes every gate and may open when nothing is missing', () => {
    const gates = evaluateGates(passing())
    expect(gates.map(gate => gate.status)).toEqual(Array.from({length: gates.length}, () => 'pass'))
    expect(mayOpen(gates)).toBe(true)
    expect(failedSafetyGates(gates)).toEqual([])
  })

  it('has a failing case for every gate that keeps the route closed', () => {
    const cases: [string, (input: GateInputs) => GateInputs][] = [
      ['langfuse-key', input => ({...input, keyPairSet: false})],
      ['ingest-variable', input => ({...input, ingestVariableTrue: false})],
      ['token-directories', input => ({...input, tokenFiles: {marcusrbrown: 0, 'fro-bot': 'absent', workstation: 0}})],
      ['token-directories', input => ({...input, tokenFiles: {marcusrbrown: 0, 'fro-bot': 'empty', workstation: 0}})],
      ['token-directories', input => ({...input, tokenFiles: undefined})],
      ['reporter-verdict', input => ({...input, verdict: {state: 'unreadable'}})],
      ['reporter-verdict', input => ({...input, verdict: {state: 'timeout', detail: undefined}})],
      ['canary', input => ({...input, verdict: {state: 'unreadable'}})],
      ['canary', input => ({...input, canary: {state: 'unreadable'}})],
      ['canary', input => ({...input, canary: {state: 'skipped'}})],
      ['canary', input => ({...input, canary: canaryChecks()})],
      ['bootstrap-key', input => ({...input, bootstrap: {...input.bootstrap, probe: 'live'}})],
      ['bootstrap-key', input => ({...input, bootstrap: {...input.bootstrap, probe: 'inconclusive'}})],
      ['bootstrap-key', input => ({...input, bootstrap: {...input.bootstrap, supplied: true, probe: 'dead'}})],
      [
        'bootstrap-variables',
        input => ({...input, bootstrap: {...input.bootstrap, hygiene: {envFile: 2, running: 0}}}),
      ],
      [
        'bootstrap-variables',
        input => ({...input, bootstrap: {...input.bootstrap, hygiene: {envFile: 0, running: 2}}}),
      ],
      ['bootstrap-variables', input => ({...input, bootstrap: {...input.bootstrap, hygiene: undefined}})],
    ]
    for (const [id, mutate] of cases) {
      const gates = evaluateGates(mutate(passing()))
      expect({id, open: mayOpen(gates), failed: gates.some(gate => gate.id === id && gate.status !== 'pass')}).toEqual({
        id,
        open: false,
        failed: true,
      })
    }
  })

  it('fails the reporter verdict when it is stale, has not run or is not ok', () => {
    const mutate = (change: Record<string, unknown>): GateInputs => ({
      ...passing(),
      verdict: {
        state: 'fresh',
        detail: parseReporterDetail(ok(`${JSON.stringify({...detail, ...change})}\nTRACES_DETAIL_END\n`)) as never,
      },
    })
    for (const change of [{stale: true}, {ran: false}, {ok: false}]) {
      expect(mayOpen(evaluateGates(mutate(change)))).toBe(false)
    }
  })

  describe('canary', () => {
    const failing = (id: string, status: string): CanaryState => ({
      state: 'ran',
      checks: (new FakeHost().canaryChecks() as {id: string; status: string; detail: string}[]).map(check =>
        check.id === id ? {...check, status, detail: `${id} did not pass`} : check,
      ) as never,
    })

    it.each(['canary-send', 'canary-langfuse', 'canary-tempo'])('fails and names %s when it fails', id => {
      const gates = evaluateGates({...passing(), canary: failing(id, 'fail')})
      expect(gates.find(gate => gate.id === 'canary')).toMatchObject({status: 'fail', kind: 'safety'})
      expect(gates.find(gate => gate.id === 'canary')?.detail).toContain(id)
      expect(gates.find(gate => gate.id === 'reporter-verdict')?.status).toBe('pass')
      expect(mayOpen(gates)).toBe(false)
      expect(failedSafetyGates(gates).map(gate => gate.id)).toEqual(['canary'])
    })

    it.each(['unknown', 'warn'])('does not pass a canary check that is %s', status => {
      const gates = evaluateGates({...passing(), canary: failing('canary-tempo', status)})
      expect(gates.find(gate => gate.id === 'canary')?.status).toBe('fail')
    })

    it('names a canary check that is missing from the answer', () => {
      const gates = evaluateGates({...passing(), canary: canaryChecks()})
      expect(gates.find(gate => gate.id === 'canary')?.detail).toContain('canary-send: missing')
    })

    it('reads the canary result and not the verdict: the periodic verdict carries no canary check', () => {
      expect((detail.checks as {id: string}[]).some(check => check.id.startsWith('canary'))).toBe(false)
      const gates = evaluateGates(passing())
      expect(gates.find(gate => gate.id === 'canary')).toMatchObject({status: 'pass'})
      expect(gates.find(gate => gate.id === 'reporter-verdict')).toMatchObject({status: 'pass'})
    })

    it('does not let a canary-shaped check in the verdict stand in for the canary result', () => {
      const withFailing = parseReporterDetail(
        ok(
          `${JSON.stringify({...detail, checks: [...(detail.checks as unknown[]), {id: 'canary-langfuse', status: 'fail', detail: 'x'}]})}\nTRACES_DETAIL_END\n`,
        ),
      ) as never
      const gates = evaluateGates({...passing(), verdict: {state: 'fresh', detail: withFailing}})
      expect(gates.find(gate => gate.id === 'canary')?.status).toBe('pass')
    })

    it('explains an unreadable or missing canary', () => {
      const gate = (canary: CanaryState) => evaluateGates({...passing(), canary}).find(entry => entry.id === 'canary')
      expect(gate({state: 'unreadable'})).toMatchObject({status: 'fail', detail: 'the canary could not be run'})
      expect(gate({state: 'skipped'})).toMatchObject({status: 'fail', detail: 'the canary was not run'})
    })
  })

  it('skips everything that needs a delivering stack when there is no key pair, and counts a skip as not open', () => {
    const gates = evaluateGates({
      ...passing(),
      keyPairSet: false,
      verdict: {state: 'skipped'},
      canary: {state: 'skipped'},
    })
    expect(gates.filter(gate => gate.status === 'skipped').map(gate => gate.id)).toEqual([
      'reporter-verdict',
      'canary',
      'bootstrap-key',
      'bootstrap-variables',
    ])
    expect(mayOpen(gates)).toBe(false)
    // No key pair is an expected state, not a failure.
    expect(failedSafetyGates(gates)).toEqual([])
  })

  it('never opens on an empty gate list', () => {
    expect(mayOpen([])).toBe(false)
  })

  describe('grafana-signin', () => {
    it('is not a gate that evaluateGates knows: the route gates are decided without it', () => {
      expect(evaluateGates(passing()).map(gate => gate.id)).not.toContain('grafana-signin')
      expect('grafana' in passing()).toBe(false)
    })

    it('passes on a 200 with the password file', () => {
      expect(evaluateGrafana({code: '200'})).toMatchObject({id: 'grafana-signin', status: 'pass', kind: 'operator'})
    })

    it.each(['401', '403', '000', '502', '302', '404'])('fails on HTTP %s', code => {
      expect(evaluateGrafana({code})).toMatchObject({id: 'grafana-signin', status: 'fail', kind: 'operator'})
    })

    it('says what failed, with the HTTP code and the runbook for a refused password, and prints no password', () => {
      const refused = evaluateGrafana({code: '401'}).detail
      expect(refused).toContain('the admin password file was not accepted (HTTP 401, expected 200)')
      expect(refused).toContain('Grafana sign-in check fails')
      expect(evaluateGrafana({code: '403'}).detail).toContain('HTTP 403, expected 200')
      expect(evaluateGrafana({code: '000'}).detail).toContain('did not answer')
      expect(evaluateGrafana({code: '000', error: 'spawn blew up'}).detail).toContain('could not be run: spawn blew up')
    })

    it('never decides the route: it fails the run, and mayOpen and the safety gates ignore it', () => {
      for (const code of ['401', '000', '502']) {
        const gates = [...evaluateGates(passing()), evaluateGrafana({code})]
        expect(mayOpen(gates)).toBe(true)
        expect(failedSafetyGates(gates)).toEqual([])
        expect(failedOperatorGates(gates).map(gate => gate.id)).toEqual(['grafana-signin'])
      }
      expect(failedOperatorGates([...evaluateGates(passing()), evaluateGrafana({code: '200'})])).toEqual([])
    })

    it('does not make a route that is not openable openable', () => {
      const pass = evaluateGrafana({code: '200'})
      expect(mayOpen([...evaluateGates({...passing(), ingestVariableTrue: false}), pass])).toBe(false)
      expect(
        mayOpen([...evaluateGates({...passing(), bootstrap: {...passing().bootstrap, probe: 'live'}}), pass]),
      ).toBe(false)
    })
  })

  describe('parseGrafanaProbe', () => {
    it('reads the code from a complete answer only', () => {
      const complete = 'TRACES_GRAFANA_FILE_HTTP=200\nTRACES_GRAFANA_PROBED\n'
      expect(parseGrafanaProbe(complete)).toBe('200')
      expect(parseGrafanaProbe(complete.replace('TRACES_GRAFANA_PROBED\n', ''))).toBeUndefined()
      expect(parseGrafanaProbe(complete.replace('TRACES_GRAFANA_FILE_HTTP=200\n', ''))).toBeUndefined()
      expect(parseGrafanaProbe(complete.replace('=200', '=2x0'))).toBeUndefined()
      expect(parseGrafanaProbe('')).toBeUndefined()
    })
  })
})

// ─── Deploys against the simulated host ───────────────────────────────────────

describe('storage and mount', () => {
  it('stops before writing anything when the storage answer is not recognised', async () => {
    const host = new FakeHost({storageAnswer: ok('something unexpected\n')})
    await expect(run(host)).rejects.toThrow('Traces storage check failed')
    expect(nonSshSteps(host)).toEqual(['storage-probe'])
  })

  it('stops when Docker or the sentinel is not on the volume', async () => {
    const wrong = ok(
      [
        'mount_source=/dev/sda',
        'root_source=/dev/vda1',
        'sentinel=traces-volume-v1',
        'docker_root=/var/lib/docker',
        'containerd_root=/mnt/traces/containerd',
        'docker_source=/dev/vda1',
        'containerd_source=/dev/sda',
        'TRACES_STORAGE_PROBED',
      ].join('\n'),
    )
    const host = new FakeHost({storageAnswer: wrong})
    await expect(run(host)).rejects.toThrow('Docker data root')
    expect(nonSshSteps(host)).toEqual(['storage-probe'])
  })

  it('checks storage before reading the host state or writing a byte', async () => {
    const host = new FakeHost()
    await run(host)
    expect(host.steps[0]).toBe('storage-probe')
    expect(host.indexOf('storage-probe')).toBeLessThan(host.indexOf('host-state'))
    expect(host.indexOf('storage-probe')).toBeLessThan(host.indexOf('prepare-dirs'))
  })
})

describe('first deploy', () => {
  it('with no Langfuse key pair completes with ingest off, says so, and never reads the reporter', async () => {
    const host = new FakeHost()
    const {result, logs} = await run(host, baseEnv(withoutKey))
    expect(result.ingest).toBe('off')
    expect(host.setStates()).toEqual([])
    expect(host.served).toBe('off')
    expect(host.envState).toBe('off')
    expect(result.unmet.join('\n')).toContain('langfuse-key')
    expect(logs.join('\n')).toContain('Ingest is OFF')
    expect(logs.join('\n')).toContain('TRACES_LANGFUSE_PUBLIC_KEY')
    expect(host.count('raw:reporter-detail')).toBe(0)
    expect(host.count('reporter-canary')).toBe(0)
  })

  it('with a key pair and ingest not asked for ends with ingest off and a message naming the missing gate', async () => {
    const host = new FakeHost()
    const {result, logs} = await run(host, baseEnv({TRACES_INGEST_OPEN: undefined}))
    expect(result.ingest).toBe('off')
    expect(result.unmet).toEqual(['ingest-variable: TRACES_INGEST_OPEN is not exactly true'])
    expect(host.setStates()).toEqual([])
    expect(logs.join('\n')).toContain('Gates not met')
  })

  it('with every gate passing and TRACES_INGEST_OPEN=true opens ingest and proves 401 on every path from inside the host', async () => {
    const host = new FakeHost()
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(result.unmet).toEqual([])
    expect(host.setStates()).toEqual(['open'])
    expect(host.served).toBe('open')
    expect(host.envState).toBe('open')
    expect(host.count('probe-ingest')).toBeGreaterThanOrEqual(1)
  })

  it('runs in the order the plan fixes: volume, host state, compare, dirs, files, pull, stores, retention, backends, reporter, caddy, gates, route, marker, Grafana', async () => {
    const host = new FakeHost()
    await run(host)
    const order = [
      'storage-probe',
      'host-state',
      'compare:docker-compose.yaml',
      'prepare-dirs',
      'token-file:marcusrbrown',
      'write:docker-compose.yaml',
      'write:.env',
      'prune-images',
      'disk-free',
      'pull',
      'create-collector',
      'queue-volume',
      'up-private',
      'retention-read-ttl',
      'up-public',
      'up-reporter',
      'digest:collector',
      'up-caddy',
      'token-dirs',
      'raw:reporter-detail',
      'reporter-canary',
      'bootstrap-hygiene',
      'raw:set-state:open',
      'create-prometheus',
      'prometheus-volume',
      'up-prometheus',
      'up-embedder',
      'remove:.deploy-in-progress',
      'grafana-signin',
      'grafana-alerting',
    ]
    const positions = order.map(step => host.indexOf(step))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(host.indexOf('retention-read-ttl')).toBeLessThan(host.indexOf('up-public'))
  })

  it('creates the collector container and fixes its queue volume before it starts', async () => {
    const host = new FakeHost()
    await run(host)
    expect(host.indexOf('create-collector')).toBeLessThan(host.indexOf('queue-volume'))
    expect(host.indexOf('queue-volume')).toBeLessThan(host.indexOf('up-public'))
  })

  it('writes the .env with the planned state off and no ingest-state line in the content', async () => {
    const host = new FakeHost()
    await run(host, baseEnv(withoutKey))
    expect(host.envState).toBe('off')
    expect(host.env).not.toContain('TRACES_INGEST_STATE')
  })

  it('recreates the reporter last so its verdict is newer than every change, and waits for that verdict', async () => {
    const host = new FakeHost()
    await run(host)
    expect(host.indexOf('up-reporter')).toBeGreaterThan(host.indexOf('up-public'))
    expect(host.indexOf('raw:reporter-detail')).toBeGreaterThan(host.indexOf('up-reporter'))
  })

  it('does not accept a verdict older than the restart, and then does not run the canary', async () => {
    const host = new FakeHost({verdictOffset: -5})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('no fresh reporter verdict')
    expect(error.message).toContain('canary')
    expect(host.count('reporter-canary')).toBe(0)
    expect(host.setStates()).toEqual([])
    expect(host.served).toBe('off')
  })

  it('runs the canary exactly once per deploy, after the fresh verdict and before the route changes', async () => {
    const host = new FakeHost()
    await run(host)
    expect(host.count('reporter-canary')).toBe(1)
    expect(host.indexOf('reporter-canary')).toBeGreaterThan(host.steps.lastIndexOf('raw:reporter-detail'))
    expect(host.indexOf('reporter-canary')).toBeLessThan(host.indexOf('raw:set-state:open'))
  })

  it('runs the canary once even when the verdict took several reads to arrive', async () => {
    let reads = 0
    const host = new FakeHost({
      override: step => {
        if (step !== 'raw:reporter-detail') return undefined
        reads += 1
        return reads < 2 ? ok('not the document\n') : undefined
      },
    })
    await run(host)
    expect(host.count('raw:reporter-detail')).toBe(2)
    expect(host.count('reporter-canary')).toBe(1)
  })

  it('runs the canary on a redeploy too, since the config or image may have changed', async () => {
    const host = new FakeHost()
    await run(host)
    await run(host)
    expect(host.count('reporter-canary')).toBe(2)
  })

  it.each([
    ['exec fails', true],
    ['prints a garbled document', 'garbled'],
  ] as const)(
    'a canary command that %s fails the canary gate and keeps ingest off',
    async (_label, canaryUnreadable) => {
      const host = new FakeHost({canaryUnreadable})
      const error = await failure(host)
      expect(error).toBeInstanceOf(AppliedButUnverifiedError)
      expect(error.message).toContain('canary')
      expect(host.setStates()).toEqual([])
      expect(host.served).toBe('off')
    },
  )

  it('shuts the shared connection and removes the key file whether or not the deploy succeeds', async () => {
    const host = new FakeHost({storageAnswer: ok('nope\n')})
    const t = testDeps(host)
    await expect(deploy({env: baseEnv(), deps: t.deps})).rejects.toThrow()
    expect(host.steps.at(-1)).toBe('ssh-exit')
    expect(t.cleaned.sort()).toEqual(['identity', 'temp'])
  })

  it('speaks ssh with the pinned options on every call', async () => {
    const host = new FakeHost()
    await run(host)
    for (const call of host.calls) {
      expect(call.argv[0]).toBe('ssh')
      expect(call.argv).toContain('StrictHostKeyChecking=yes')
      expect(call.argv).toContain('ControlMaster=auto')
      expect(call.argv).toContain('root@deploy-host.invalid')
    }
  })
})

describe('gates keep the route closed', () => {
  it('the canary reaches Tempo but not Langfuse: ingest stays off', async () => {
    const host = new FakeHost({checkStatus: {'canary-langfuse': 'fail'}})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('canary')
    expect(error.message).toContain('Ingest is off')
    expect(host.setStates()).toEqual([])
    expect(host.served).toBe('off')
  })

  it('the canary content marker is found in Tempo: ingest stays off', async () => {
    const host = new FakeHost({checkStatus: {'canary-tempo': 'fail'}})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(host.setStates()).toEqual([])
    expect(host.served).toBe('off')
  })

  it('the reporter verdict is failing for any other reason: ingest stays off', async () => {
    const host = new FakeHost({checkStatus: {'volume-space': 'fail'}})
    const error = await failure(host)
    expect(error.message).toContain('reporter-verdict')
    expect(host.setStates()).toEqual([])
  })

  it('the reporter cannot be read at all: ingest stays off', async () => {
    const host = new FakeHost({reporterUnreadable: true})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(host.setStates()).toEqual([])
  })

  it('a token directory is missing: ingest stays off', async () => {
    const host: FakeHost = new FakeHost({
      override: step => (step.startsWith('token-file:') ? ok('TRACES_TOKEN_PRESENT\n') : undefined),
    })
    const error = await failure(host)
    expect(error.message).toContain('token-directories')
    expect(host.setStates()).toEqual([])
  })

  it('the bootstrap key still authenticates: ingest stays closed', async () => {
    const host = new FakeHost()
    await run(host, baseEnv({...withoutKey, ...bootstrap}))
    expect(host.bootstrapKeyLive).toBe(true)
    // Deploy two: the app key is set and the bootstrap secrets are gone, but nobody deleted the key.
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('still accepts the bootstrap key')
    expect(host.setStates()).toEqual([])
    expect(host.served).toBe('off')
  })

  it('the bootstrap probe cannot answer: it is not read as "dead"', async () => {
    const host = new FakeHost()
    await run(host, baseEnv({...withoutKey, ...bootstrap}))
    host.bootstrapKeyLive = false
    host.options.bootstrapStatus = '000'
    const error = await failure(host)
    expect(error.message).toContain('could not be proven dead')
    expect(host.setStates()).toEqual([])
  })

  it('the bootstrap variables are still in a running container: ingest stays closed', async () => {
    const host: FakeHost = new FakeHost({
      override: step =>
        step === 'bootstrap-hygiene' ? ok('TRACES_HYGIENE env_file=0 running=2\nTRACES_HYGIENE_CHECKED\n') : undefined,
    })
    const error = await failure(host)
    expect(error.message).toContain('bootstrap-variables')
    expect(host.setStates()).toEqual([])
  })

  it('the bootstrap variables are still in the host .env: ingest stays closed', async () => {
    const host: FakeHost = new FakeHost({
      override: step =>
        step === 'bootstrap-hygiene' ? ok('TRACES_HYGIENE env_file=2 running=0\nTRACES_HYGIENE_CHECKED\n') : undefined,
    })
    const error = await failure(host)
    expect(error.message).toContain('bootstrap-variables')
    expect(host.setStates()).toEqual([])
  })

  it('the bootstrap pair is still supplied: the key is not opened over even when it answers 401', async () => {
    const host = new FakeHost()
    host.bootstrapKeyLive = false
    const error = await failure(host, baseEnv(bootstrap), {})
    // The first boot with the variables recreates the key, so the probe finds it live; either way the gate fails.
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('bootstrap-key')
    expect(host.setStates()).toEqual([])
  })
})

/** A curl that records its argv and stdin, then answers by the credential it was given. */
function installCurl(shim: string, password: string): void {
  writeFileSync(
    join(shim, 'curl'),
    String.raw`#!/bin/bash
printf '%s\n' "$@" >> "${shim}/curl-argv"
cred=""
for a in "$@"; do
  if [ "$a" = -K ]; then cred=$(cat); printf '%s\n' "$cred" >> "${shim}/curl-stdin"; fi
done
case "$cred" in
  *admin:${password}*) code=200 ;;
  *) code=401 ;;
esac
printf '{"login":"admin"}\nTRACES_HTTP=%s' "$code"
`,
  )
  chmodSync(join(shim, 'curl'), 0o755)
}

describe('the Grafana sign-in check', () => {
  const GRAFANA_PASSWORD = baseEnv().TRACES_GRAFANA_ADMIN_PASSWORD ?? ''
  const newImage = {TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}
  const probeCount = (host: FakeHost): number => host.count('grafana-signin')

  /** A runner that rejects, as a spawn or transport failure does, for the Grafana probe only. */
  const rejectingProbe =
    (host: FakeHost, message: string): DeployDeps['run'] =>
    async (argv, options) => {
      if (stepOf(argv.at(-1) ?? '') === 'grafana-signin') throw new Error(message)
      return host.run(argv, options)
    }

  it('passes on a 200 with the password file, and runs only after the route is final and the marker is gone', async () => {
    const host = new FakeHost()
    const {result, logs} = await run(host)
    expect(result.ingest).toBe('open')
    expect(result.unmet).toEqual([])
    expect(result.gates.find(gate => gate.id === 'grafana-signin')).toMatchObject({status: 'pass', kind: 'operator'})
    expect(logs.join('\n')).toContain('✓ grafana-signin')
    expect(probeCount(host)).toBe(1)
    expect(host.indexOf('grafana-signin')).toBeGreaterThan(host.indexOf('raw:set-state:open'))
    expect(host.indexOf('grafana-signin')).toBeGreaterThan(host.indexOf('remove:.deploy-in-progress'))
  })

  it('runs with no key pair too: Grafana does not depend on the Langfuse key', async () => {
    const host = new FakeHost()
    const {result} = await run(host, baseEnv(withoutKey))
    expect(result.ingest).toBe('off')
    expect(probeCount(host)).toBe(1)
  })

  it.each([
    [
      'the password file is refused (401): Grafana is on its defaults or its database predates the file',
      '401',
      ['HTTP 401, expected 200', 'Grafana sign-in check fails'],
    ],
    ['Grafana answers 403', '403', ['HTTP 403, expected 200']],
  ])('fails the run when %s, and does not retry a settled answer', async (_name, code, expected) => {
    const host = new FakeHost({grafana: code})
    const error = await failure(host)
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error.message).toContain('grafana-signin')
    for (const text of expected) expect(error.message).toContain(text)
    expect(probeCount(host)).toBe(1)
  })

  it.each([
    ['never answers', '000', 'did not answer'],
    ['keeps answering 502', '502', 'HTTP 502, expected 200'],
  ])('fails the run, after a bounded number of attempts, when Grafana %s', async (_name, code, expected) => {
    const host = new FakeHost({grafana: code})
    const error = await failure(host)
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error.message).toContain(expected)
    expect(probeCount(host)).toBe(3)
  })

  it('waits for a Grafana that is still starting, and passes once it answers 200', async () => {
    const host = new FakeHost({grafana: attempt => (attempt < 3 ? '000' : '200')})
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(probeCount(host)).toBe(3)
  })

  it('sleeps between attempts and not after the last one', async () => {
    const host = new FakeHost({grafana: '000'})
    const sleeps: number[] = []
    await failure(host, baseEnv(), {
      sleep: async ms => {
        sleeps.push(ms)
      },
      limits: {
        proofAttempts: 2,
        proofIntervalMs: 0,
        retentionAttempts: 2,
        retentionIntervalMs: 0,
        verdictAttempts: 2,
        verdictIntervalMs: 0,
        grafanaAttempts: 3,
        grafanaIntervalMs: 7,
      },
    })
    expect(sleeps).toEqual([7, 7])
  })

  it.each([
    ['a failed answer from the host', {exitCode: 255, stdout: '', stderr: 'ssh: dropped'}],
    ['an answer that is not the probe output', ok('this is not the probe output\n')],
    ['a code that is not three digits', ok('TRACES_GRAFANA_FILE_HTTP=2x0\nTRACES_GRAFANA_PROBED\n')],
  ])('treats %s as no answer', async (_name, reply) => {
    const host = new FakeHost({override: step => (step === 'grafana-signin' ? reply : undefined)})
    const error = await failure(host)
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error.message).toContain('did not answer')
    expect(probeCount(host)).toBe(3)
  })

  describe('is reported outside the route error handler', () => {
    it('a rejected probe execution is an operator-surface failure that names the cause, not a deploy failure', async () => {
      const host = new FakeHost()
      const t = testDeps(host, {run: rejectingProbe(host, 'spawn blew up')})
      const error = await deploy({env: baseEnv(), deps: t.deps}).then(
        () => undefined,
        (error_: unknown) => error_ as Error,
      )
      expect(error).toBeInstanceOf(OperatorSurfaceError)
      expect(error?.message).toContain('could not be run')
      expect(error?.message).toContain('spawn blew up')
      expect((error as OperatorSurfaceError).ingest).toBe('open')
      expect(host.served).toBe('open')
      expect(host.setStates()).toEqual(['open'])
      expect(host.marker).toBeUndefined()
    })

    it('a rejected probe execution does not hold a healthy open route', async () => {
      const host = await openStack()
      const before = host.calls.length
      const t = testDeps(host, {run: rejectingProbe(host, 'spawn blew up')})
      const error = await deploy({env: baseEnv(), deps: t.deps}).then(
        () => undefined,
        (error_: unknown) => error_ as Error,
      )
      expect(error).toBeInstanceOf(OperatorSurfaceError)
      expect(host.served).toBe('open')
      expect(host.envState).toBe('open')
      expect(host.calls.slice(before).filter(call => call.step.startsWith('raw:set-state'))).toEqual([])
      // No hold, no probe of a held route, no re-read of the route: the failure handler did not run.
      expect(host.calls.slice(before).filter(call => call.step === 'ingest-state')).toEqual([])
    })

    it('a probe that is still retrying when the route is decided starts after the route is written and the marker removed', async () => {
      const host = new FakeHost({grafana: '000'})
      const atProbe: {served: string; envState: string | undefined; marker: string | undefined; setStates: string[]}[] =
        []
      host.options.override = step => {
        if (step === 'grafana-signin') {
          atProbe.push({
            served: host.served,
            envState: host.envState,
            marker: host.marker,
            setStates: host.setStates(),
          })
        }
        return undefined
      }
      const error = await failure(host)
      expect(error).toBeInstanceOf(OperatorSurfaceError)
      expect(probeCount(host)).toBe(3)
      // Every attempt saw the final route and no marker: the route was decided before the first attempt began.
      expect(atProbe).toHaveLength(3)
      for (const seen of atProbe) {
        expect(seen).toEqual({served: 'open', envState: 'open', marker: undefined, setStates: ['open']})
      }
      const first = host.indexOf('grafana-signin')
      expect(host.indexOf('raw:set-state:open')).toBeLessThan(first)
      expect(host.indexOf('remove:.deploy-in-progress')).toBeLessThan(first)
      // Nothing but probes follows the route write.
      expect(
        host.steps.slice(host.indexOf('remove:.deploy-in-progress') + 1).filter(step => step !== 'ssh-exit'),
      ).toEqual(['grafana-signin', 'grafana-signin', 'grafana-signin'])
    })
  })

  describe('does not decide the route: whatever the probe does, the route is what the route gates decided', () => {
    type Outcome = [name: string, configure: (host: FakeHost) => void, rejected: boolean]
    const outcomes: Outcome[] = [
      ['passes', () => undefined, false],
      [
        'gets 401',
        host => {
          host.options.grafana = '401'
        },
        false,
      ],
      [
        'gets 403',
        host => {
          host.options.grafana = '403'
        },
        false,
      ],
      [
        'never answers',
        host => {
          host.options.grafana = '000'
        },
        false,
      ],
      [
        'answers 5xx',
        host => {
          host.options.grafana = '503'
        },
        false,
      ],
      [
        'returns malformed output',
        host => {
          host.options.override = step => (step === 'grafana-signin' ? ok('garbage') : undefined)
        },
        false,
      ],
      ['is rejected', () => undefined, true],
    ]

    /** Steps before the first probe, and the route the host ends with, for a deploy over `starting`. */
    async function outcome(
      [, configure, rejected]: Outcome,
      starting: 'open' | 'fresh',
      env: Record<string, string | undefined>,
    ): Promise<{before: string[]; served: string; envState: string | undefined; setStates: string[]}> {
      const host = starting === 'open' ? await openStack() : new FakeHost()
      const start = host.calls.length
      configure(host)
      const t = testDeps(host, rejected ? {run: rejectingProbe(host, 'spawn blew up')} : {})
      await deploy({env, deps: t.deps}).catch(() => undefined)
      // A rejected probe never reaches the host, so it leaves no call; the connection's exit is not a route step.
      const steps = host.calls
        .slice(start)
        .map(call => call.step)
        .filter(step => step !== 'ssh-exit')
      const probe = steps.indexOf('grafana-signin')
      return {
        before: steps.slice(0, probe === -1 ? steps.length : probe),
        served: host.served,
        envState: host.envState,
        setStates: host.setStates(),
      }
    }

    const healthy: Outcome = ['healthy', () => undefined, false]

    it.each(outcomes)(
      'on a fresh host, when the probe %s, the route steps and the end state are those of a healthy Grafana',
      async (...probe: Outcome) => {
        const expected = await outcome(healthy, 'fresh', baseEnv())
        expect(await outcome(probe, 'fresh', baseEnv())).toEqual(expected)
        expect(expected.served).toBe('open')
      },
    )

    it.each(outcomes)(
      'on an open route, when the probe %s, the route stays open and untouched',
      async (...probe: Outcome) => {
        const expected = await outcome(healthy, 'open', baseEnv())
        const seen = await outcome(probe, 'open', baseEnv())
        expect(seen).toEqual(expected)
        expect(seen.served).toBe('open')
        expect(seen.setStates).toEqual(['open'])
      },
    )

    it.each(outcomes)(
      'on a route held for an update, when the probe %s, the route is reopened as it would be',
      async (...probe: Outcome) => {
        const expected = await outcome(healthy, 'open', baseEnv(newImage))
        const seen = await outcome(probe, 'open', baseEnv(newImage))
        expect(seen).toEqual(expected)
        expect(seen.setStates).toEqual(['open', 'held', 'open'])
      },
    )

    it.each(outcomes)(
      'with ingest not asked for, when the probe %s, the route stays off',
      async (...probe: Outcome) => {
        const env = baseEnv({TRACES_INGEST_OPEN: undefined})
        const expected = await outcome(healthy, 'fresh', env)
        const seen = await outcome(probe, 'fresh', env)
        expect(seen).toEqual(expected)
        expect(seen.served).toBe('off')
        expect(seen.setStates).toEqual([])
      },
    )

    it('fails the run with an error that says where the route is', async () => {
      const open = await openStack()
      open.options.grafana = '401'
      const error = await failure(open)
      expect(error).toBeInstanceOf(OperatorSurfaceError)
      expect((error as OperatorSurfaceError).ingest).toBe('open')
      expect(error.message).toContain('Ingest is open')

      const off = new FakeHost({grafana: '401'})
      const offError = await failure(off, baseEnv({TRACES_INGEST_OPEN: undefined}))
      expect((offError as OperatorSurfaceError).ingest).toBe('off')
      expect(offError.message).toContain('Ingest is off')
    })

    it('is not run for a deploy that already failed: a failed safety gate still closes the route, and says so', async () => {
      const host = await openStack()
      host.options.grafana = '401'
      host.options.checkStatus = {'canary-langfuse': 'fail'}
      const before = host.count('grafana-signin')
      const error = await failure(host)
      expect(error).toBeInstanceOf(AppliedButUnverifiedError)
      expect(host.served).toBe('held')
      expect(host.count('grafana-signin')).toBe(before)
    })

    it('a later deploy with a working Grafana succeeds again', async () => {
      const host = new FakeHost({grafana: '401'})
      await failure(host)
      host.options.grafana = '200'
      const {result} = await run(host)
      expect(result.ingest).toBe('open')
    })
  })

  describe('keeps the password out of everything the deploy records', () => {
    it('sends no secret in the command text, argv or stdin of the check, and none reaches a log line or an error', async () => {
      const env = baseEnv()
      const host = new FakeHost({grafana: '401'})
      const t = testDeps(host)
      const error = await deploy({env, deps: t.deps}).then(
        () => undefined,
        (error_: unknown) => error_ as Error,
      )
      expect(error).toBeInstanceOf(OperatorSurfaceError)
      const calls = host.calls.filter(call => call.step === 'grafana-signin')
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.stdin).toBeUndefined()
        expect(call.command).not.toContain(GRAFANA_PASSWORD)
        expect(call.argv.join('\u0000')).not.toContain(GRAFANA_PASSWORD)
        expect(call.command).toContain('secrets/grafana/admin-password')
      }
      expectNoSecretOutsideStdin(env, host, t.logs)
      expect(error?.message).not.toContain(GRAFANA_PASSWORD)
    })

    it('builds the credential on the host: run for real, the password reaches curl on stdin only, and no output carries it', () => {
      const {root, shim, cleanup} = scratchHost()
      try {
        const password = 'scratch-grafana-password-0001'
        mkdirSync(join(root, 'secrets/grafana'), {recursive: true})
        writeFileSync(join(root, 'secrets/grafana/admin-password'), password)
        installCurl(shim, password)

        const result = runLocally(grafanaSignInScript(), root, shim)
        expect(result.code).toBe(0)
        expect(parseGrafanaProbe(result.out)).toBe('200')
        expect(result.out).not.toContain(password)
        expect(result.out).not.toContain('login')
        const argv = readFileSync(join(shim, 'curl-argv'), 'utf8').split('\n')
        expect(argv.join('\n')).not.toContain(password)
        // One request only: the password file's, never `admin:admin`.
        expect(readFileSync(join(shim, 'curl-stdin'), 'utf8').trim().split('\n')).toEqual([
          `user = "admin:${password}"`,
        ])
        expect(argv.join('\n')).not.toContain('admin:admin')
      } finally {
        cleanup()
      }
    })

    it('run for real: a wrong password gives the code curl reports, a missing file gives no request and no answer', () => {
      const {root, shim, cleanup} = scratchHost()
      try {
        installCurl(shim, 'the-right-password-0003')
        const missing = runLocally(grafanaSignInScript(), root, shim)
        expect(missing.code).toBe(0)
        expect(parseGrafanaProbe(missing.out)).toBe('000')
        expect(existsSync(join(shim, 'curl-argv'))).toBe(false)

        mkdirSync(join(root, 'secrets/grafana'), {recursive: true})
        writeFileSync(join(root, 'secrets/grafana/admin-password'), 'scratch-wrong-password-0002')
        const wrong = runLocally(grafanaSignInScript(), root, shim)
        expect(parseGrafanaProbe(wrong.out)).toBe('401')
        expect(wrong.out).not.toContain('scratch-wrong-password-0002')
      } finally {
        cleanup()
      }
    })
  })
})

// ─── Monitoring is not the route ──────────────────────────────────────────────
//
// Prometheus and Grafana exist to alert. Neither is on the path of a trace, so a failure of either must never hold,
// close or keep closed a route whose ingest checks pass. Nothing about them is in the route-critical pull or start:
// both are pulled and started after the route is decided, as operator gates (`prometheus-ready`, `grafana-ready`), and
// the reporter's ingest verdict (`ok`) is what the deploy and `traces ingest open` read.

describe('the services split into ingest and monitoring', () => {
  it('names two monitoring services and one insight service, which are no gated service and no ingest service', () => {
    expect([...MONITORING_SERVICES]).toEqual(['grafana', 'prometheus'])
    expect([...INSIGHT_SERVICES]).toEqual(['embedder'])
    expect([...INGEST_SERVICES, ...MONITORING_SERVICES, ...INSIGHT_SERVICES].sort()).toEqual([...SERVICES].sort())
    for (const service of [...MONITORING_SERVICES, ...INSIGHT_SERVICES]) {
      expect(INGEST_SERVICES as readonly string[]).not.toContain(service)
      expect(GATED_SERVICES as readonly string[]).not.toContain(service)
    }
  })

  // The route-critical `up` starts named services only, but a `depends_on` on a monitoring service in the compose
  // file would still tie an ingest service to it.
  it('has no ingest service that depends on a monitoring or an insight service', () => {
    const compose = Bun.YAML.parse(readFileSync(join(APP, 'docker-compose.yaml'), 'utf8')) as {
      services: Record<string, {depends_on?: string[] | Record<string, unknown>}>
    }
    for (const name of INGEST_SERVICES) {
      const deps = compose.services[name]?.depends_on
      const needs = deps === undefined ? [] : Array.isArray(deps) ? deps : Object.keys(deps)
      expect({
        name,
        needs: needs.filter(need =>
          ([...MONITORING_SERVICES, ...INSIGHT_SERVICES] as readonly string[]).includes(need),
        ),
      }).toEqual({name, needs: []})
    }
  })

  it('pulls only the ingest services in the route-critical pull, and only the named one in a monitoring pull', () => {
    const ingest = pullScript(ID_A)
    expect(/ pull ([^\n]+)\n/.exec(ingest)?.[1]?.split(' ')).toEqual([...INGEST_SERVICES])
    for (const service of [...MONITORING_SERVICES, ...INSIGHT_SERVICES]) {
      expect(ingest).not.toMatch(new RegExp(String.raw`\b${service}\b`))
    }
    expect(pullScript(ID_A, 'pull-embedder', ['embedder'])).toMatch(/ pull embedder\n/)
    expect(pullScript(ID_A, 'pull-grafana', ['grafana'])).toMatch(/ pull grafana\n/)
    expect(pullScript(ID_A, 'pull-grafana', ['grafana'])).toContain('# traces-step:pull-grafana')
    expect(() => pullScript(ID_A, 'pull-x', ['nope' as never])).toThrow('Unknown service')
    expect(() => pullScript(ID_A, 'pull-x', [])).toThrow('at least one service')
  })
})

describe('Prometheus and Grafana start after the route is decided', () => {
  const newImage = {TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}
  const steps = {
    prometheus: ['pull-prometheus', 'create-prometheus', 'prometheus-volume', 'up-prometheus'],
    grafana: ['pull-grafana', 'up-grafana'],
  } as const
  const gateOf = (error: Error, id: string) => (error as OperatorSurfaceError).result.gates.find(gate => gate.id === id)
  const all = [...steps.prometheus, ...steps.grafana]
  /** How many times a step ran after the first deploy that opened the stack, in the deploy under test. */
  const ranSince = (host: FakeHost, mark: number, step: string): number =>
    host.steps.slice(mark).filter(entry => entry === step).length

  it('passes as two operator gates, and leaves the route open', async () => {
    const host = new FakeHost()
    const {result, logs} = await run(host)
    expect(result.ingest).toBe('open')
    for (const id of ['prometheus-ready', 'grafana-ready']) {
      expect(result.gates.find(gate => gate.id === id)).toMatchObject({status: 'pass', kind: 'operator'})
      expect(logs.join('\n')).toContain(`✓ ${id}`)
    }
    expect(mayOpen(result.gates)).toBe(true)
  })

  it('runs every monitoring step once, guarded and under the step lock, after the route and before the marker goes', async () => {
    const host = new FakeHost()
    await run(host)
    for (const step of all) {
      expect({step, ran: host.count(step)}).toEqual({step, ran: 1})
      expect(host.indexOf(step)).toBeGreaterThan(host.indexOf('raw:set-state:open'))
      expect(host.indexOf(step)).toBeLessThan(host.indexOf('remove:.deploy-in-progress'))
      expect(host.indexOf(step)).toBeLessThan(host.indexOf('grafana-signin'))
    }
    // A service is pulled before it is created and started.
    expect(host.indexOf('pull-prometheus')).toBeLessThan(host.indexOf('create-prometheus'))
    expect(host.indexOf('create-prometheus')).toBeLessThan(host.indexOf('prometheus-volume'))
    expect(host.indexOf('prometheus-volume')).toBeLessThan(host.indexOf('up-prometheus'))
    expect(host.indexOf('pull-grafana')).toBeLessThan(host.indexOf('up-grafana'))
    expect(host.unguarded).toEqual([])
    expect(host.unlocked).toEqual([])
    expect(host.calls.find(call => call.step === 'up-prometheus')?.command).toContain(
      '--wait --wait-timeout 600 --force-recreate --no-deps prometheus\n',
    )
    expect(host.calls.find(call => call.step === 'up-grafana')?.command).toContain(
      '--wait --wait-timeout 600 --force-recreate --no-deps grafana\n',
    )
  })

  it('takes no monitoring service into the route-critical pull or start', async () => {
    const host = new FakeHost()
    await run(host)
    const pulled = host.calls.find(call => call.step === 'pull')?.command ?? ''
    expect(/ pull ([^\n]+)\n/.exec(pulled)?.[1]?.split(' ')).toEqual([...INGEST_SERVICES])
    for (const step of ['pull', 'up-private', 'up-public', 'up-caddy', 'up-reporter']) {
      const command = host.calls.find(call => call.step === step)?.command ?? ''
      for (const service of MONITORING_SERVICES) {
        expect({
          step,
          service,
          named: new RegExp(`(?:pull|--wait-timeout 600)[^\n]*\\b${service}\\b`).test(command),
        }).toEqual({
          step,
          service,
          named: false,
        })
      }
    }
    expect(host.calls.find(call => call.step === 'up-public')?.command).toMatch(/--wait-timeout 600 tempo collector\n/)
    // Every pull and start that precedes the route is before the route is set.
    for (const step of ['pull', 'up-private', 'up-public', 'up-reporter', 'up-caddy']) {
      expect(host.indexOf(step)).toBeLessThan(host.indexOf('raw:set-state:open'))
    }
  })

  // An image pull that fails (registry down, a bad digest, no disk), a compose start that fails (Grafana's bad alert
  // provisioning, Prometheus's bad config), a volume that cannot be handed over: each is monitoring, none holds ingest.
  it.each(all)(
    'a failing %s fails the run as an operator gate, and never holds or closes an open route',
    async step => {
      const host = await openStack()
      host.options.override = failAt(step)
      const error = await failure(host)
      const service = (steps.prometheus as readonly string[]).includes(step) ? 'prometheus' : 'grafana'
      expect(error).toBeInstanceOf(OperatorSurfaceError)
      expect(error.message).toContain(`${service}-ready`)
      expect((error as OperatorSurfaceError).ingest).toBe('open')
      expect(gateOf(error, `${service}-ready`)).toMatchObject({status: 'fail', kind: 'operator'})
      // The route was open before and is open after; the only state change in the whole history is the first open.
      expect(host.served).toBe('open')
      expect(host.setStates()).toEqual(['open'])
      expect(host.marker).toBeUndefined()
    },
  )

  it('a Prometheus image-pull failure on a deploy that holds the route for an update: held, then reopened, run failed', async () => {
    const host = await openStack()
    host.options.override = failAt('pull-prometheus')
    const error = await failure(host, baseEnv(newImage))
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
    expect(host.served).toBe('open')
    expect(host.steps.lastIndexOf('pull-prometheus')).toBeGreaterThan(host.steps.lastIndexOf('raw:set-state:open'))
  })

  it('a Grafana compose start failure on a deploy that holds the route for an update: held, then reopened, run failed', async () => {
    const host = await openStack()
    host.options.override = step =>
      step === 'up-grafana' ? {exitCode: 1, stdout: '', stderr: 'grafana failed to provision alerting'} : undefined
    const error = await failure(host, baseEnv(newImage))
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error.message).toContain('grafana-ready')
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
    expect(host.served).toBe('open')
  })

  it('reports both, and still changes nothing about the route, when both fail', async () => {
    const host = await openStack()
    host.options.override = step => (['pull-prometheus', 'up-grafana'].includes(step) ? failAt(step)(step) : undefined)
    const error = await failure(host)
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error.message).toContain('prometheus-ready')
    expect(error.message).toContain('grafana-ready')
    expect(host.setStates()).toEqual(['open'])
    expect(host.served).toBe('open')
  })

  it('starts Grafana when Prometheus failed, and Prometheus when Grafana failed: the two are independent', async () => {
    const first = await openStack()
    const firstMark = first.calls.length
    first.options.override = failAt('pull-prometheus')
    await failure(first)
    expect(ranSince(first, firstMark, 'up-grafana')).toBe(1)
    expect(ranSince(first, firstMark, 'up-prometheus')).toBe(0)
    const second = await openStack()
    const secondMark = second.calls.length
    second.options.override = failAt('pull-grafana')
    await failure(second)
    expect(ranSince(second, secondMark, 'up-prometheus')).toBe(1)
    expect(ranSince(second, secondMark, 'up-grafana')).toBe(0)
  })

  it('does not start a service whose image did not pull', async () => {
    const host = await openStack()
    const mark = host.calls.length
    host.options.override = failAt('pull-prometheus')
    await failure(host)
    expect(ranSince(host, mark, 'create-prometheus')).toBe(0)
    expect(ranSince(host, mark, 'up-prometheus')).toBe(0)
  })

  // The sign-in and alerting checks need Grafana. With it down they would spend their whole retry window (twelve
  // attempts) on a service that is not there and say nothing useful; they are skipped and `grafana-ready` is the failure.
  it('skips the Grafana sign-in and alerting checks when Grafana did not start, and names that one failure', async () => {
    const host = await openStack()
    const mark = host.calls.length
    host.options.override = failAt('up-grafana')
    const error = await failure(host)
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(ranSince(host, mark, 'grafana-signin')).toBe(0)
    expect(ranSince(host, mark, 'grafana-alerting')).toBe(0)
    expect(gateOf(error, 'grafana-signin')).toMatchObject({status: 'skipped', kind: 'operator'})
    expect(gateOf(error, 'grafana-signin')?.detail).toContain('grafana-ready')
    expect(gateOf(error, 'grafana-alerting')).toMatchObject({status: 'skipped', kind: 'operator'})
    expect(error.message).toContain('grafana-ready')
    expect(error.message).not.toContain('grafana-signin:')
    expect(error.message).not.toContain('grafana-alerting:')
  })

  it('still runs the Grafana checks when only Prometheus failed', async () => {
    const host = await openStack()
    const mark = host.calls.length
    host.options.override = failAt('up-prometheus')
    const error = await failure(host)
    expect(ranSince(host, mark, 'grafana-signin')).toBeGreaterThan(0)
    expect(ranSince(host, mark, 'grafana-alerting')).toBeGreaterThan(0)
    expect(gateOf(error, 'grafana-signin')).toMatchObject({status: 'pass'})
  })

  it('a deploy overtaken in the monitoring stage ends as overtaken, and is not reported as a monitoring failure', async () => {
    const host = new FakeHost()
    host.options.inFlight = step => {
      if (step === 'pull-grafana') host.marker = `${ID_B} 2023-11-14T22:13:20.000Z\n`
      return undefined
    }
    const error = await failure(host)
    expect(error).toBeInstanceOf(DeployOvertakenError)
    expect(host.refused).toEqual(['up-grafana'])
    expect(host.steps.slice(host.steps.lastIndexOf('up-grafana') + 1).filter(step => step !== 'ssh-exit')).toEqual([])
    expect(host.setStates()).toEqual(['open'])
  })

  it('names the services in the error, and says the route was not changed', async () => {
    const host = new FakeHost({override: failAt('up-grafana')})
    const error = await failure(host)
    expect(error.message).toContain('grafana-ready')
    expect(error.message).toContain('this failure did not change the route')
  })

  it('also runs when the route stays off (no key pair), and fails the run the same way', async () => {
    const host = new FakeHost()
    const {result} = await run(host, baseEnv(withoutKey))
    expect(result.ingest).toBe('off')
    expect(host.count('up-prometheus')).toBe(1)
    expect(host.count('up-grafana')).toBe(1)
    const failing = new FakeHost({override: failAt('up-grafana')})
    const error = await failure(failing, baseEnv(withoutKey))
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect((error as OperatorSurfaceError).ingest).toBe('off')
    expect(failing.setStates()).toEqual([])
  })

  it('is not started when a safety gate failed: that deploy fails first and the route is held', async () => {
    const host = new FakeHost({checkStatus: {'canary-langfuse': 'fail'}})
    const error = await failure(host)
    expect(error).not.toBeInstanceOf(OperatorSurfaceError)
    for (const step of all) expect({step, ran: host.count(step)}).toEqual({step, ran: 0})
    // The marker stays: the failed deploy is unfinished, so the next one holds an open route first.
    expect(host.marker).toBeDefined()
  })

  it('leaves a deploy that was overtaken alone: no hold, no probe, no further step', async () => {
    const host = new FakeHost()
    host.options.inFlight = step => {
      if (step === 'up-prometheus') host.marker = `${ID_B} 2023-11-14T22:13:20.000Z\n`
      return undefined
    }
    const error = await failure(host)
    expect(error).toBeInstanceOf(DeployOvertakenError)
    // The next step refused, and nothing ran after it.
    expect(host.refused).toEqual(['pull-grafana'])
    expect(host.steps.slice(host.steps.lastIndexOf('up-prometheus') + 1).filter(step => step !== 'ssh-exit')).toEqual([
      'pull-grafana',
    ])
    expect(host.setStates()).toEqual(['open'])
  })

  it('does not stop the verdict gate, which reads the ingest verdict', async () => {
    const host = new FakeHost({checkStatus: {'grafana-health': 'fail', 'prometheus-health': 'fail'}})
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(result.gates.find(gate => gate.id === 'reporter-verdict')).toMatchObject({status: 'pass'})
    expect(host.setStates()).toEqual(['open'])
  })

  describe('a changed monitoring file is applied in the monitoring stage', () => {
    const changeOnly = (changed: string) => ({
      readFile: async (relative: string) => `# ${relative}${relative === changed ? ' changed' : ''}\n`,
    })

    it.each([
      'config/grafana/alerting/rules.yaml',
      'config/grafana/alerting/contact-points.yaml',
      'config/grafana/alerting/policies.yaml',
      'config/grafana/datasources/prometheus.yaml',
      'config/grafana/datasources/tempo.yaml',
    ])(
      '%s: Grafana is recreated after the route, the route is not held, and the stale-service step is not used',
      async changed => {
        const host = await openStack()
        const t = testDeps(host, changeOnly(changed))
        const result = await deploy({env: baseEnv(), deps: t.deps})
        expect(result.changed).toEqual(['grafana'])
        expect(result.heldForUpdate).toBe(false)
        expect(host.setStates()).toEqual(['open'])
        expect(host.count('up-stale-public')).toBe(0)
        const started = host.calls.findLast(call => call.step === 'up-grafana')
        expect(started?.command).toContain('--force-recreate --no-deps grafana\n')
        expect(host.steps.lastIndexOf('up-grafana')).toBeGreaterThan(host.steps.lastIndexOf('raw:set-state:open'))
      },
    )

    it('config/prometheus/prometheus.yml: Prometheus is recreated after the route', async () => {
      const host = await openStack()
      const t = testDeps(host, changeOnly('config/prometheus/prometheus.yml'))
      const result = await deploy({env: baseEnv(), deps: t.deps})
      expect(result.changed).toEqual(['prometheus'])
      expect(result.heldForUpdate).toBe(false)
      expect(host.setStates()).toEqual(['open'])
      expect(host.calls.findLast(call => call.step === 'up-prometheus')?.command).toContain(
        '--force-recreate --no-deps prometheus\n',
      )
    })

    // The record of restarts is cleared before the monitoring stage. A monitoring start that failed leaves the files
    // equal to the host's on the next deploy, so the next deploy must recreate both anyway: it always does.
    it('recreates both on a deploy where no file changed, so a failed start is retried by the next deploy', async () => {
      const host = await openStack()
      host.options.override = failAt('up-grafana')
      await failure(host, baseEnv(), {readFile: changeOnly('config/grafana/alerting/rules.yaml').readFile})
      host.options.override = undefined
      const again = await run(host, baseEnv(), {readFile: changeOnly('config/grafana/alerting/rules.yaml').readFile})
      expect(again.result.changed).toEqual([])
      expect(again.result.ingest).toBe('open')
      expect(host.calls.findLast(call => call.step === 'up-grafana')?.command).toContain(
        '--force-recreate --no-deps grafana\n',
      )
      expect(host.calls.findLast(call => call.step === 'up-prometheus')?.command).toContain(
        '--force-recreate --no-deps prometheus\n',
      )
    })
  })
})

// The embedder serves Langfuse Topics, an insight feature. No trace passes through it, so it is the last of the services
// that start after the route is decided, and its failure is the operator gate `embedder-ready`: it fails the run and
// never holds, closes or keeps closed the route.
describe('the Topics embedder starts after the route is decided', () => {
  const newImage = {TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}
  const embedderSteps = ['pull-embedder', 'create-embedder', 'embedder-volume', 'up-embedder'] as const
  const gateOf = (error: Error, id: string) => (error as OperatorSurfaceError).result.gates.find(gate => gate.id === id)
  const ranSince = (host: FakeHost, mark: number, step: string): number =>
    host.steps.slice(mark).filter(entry => entry === step).length

  it('passes as an operator gate, and leaves the route open', async () => {
    const host = new FakeHost()
    const {result, logs} = await run(host)
    expect(result.ingest).toBe('open')
    expect(result.gates.find(gate => gate.id === 'embedder-ready')).toMatchObject({status: 'pass', kind: 'operator'})
    expect(logs.join('\n')).toContain('✓ embedder-ready')
    expect(mayOpen(result.gates)).toBe(true)
  })

  it('runs every step once, guarded and under the step lock, after the route and Grafana, before the marker goes', async () => {
    const host = new FakeHost()
    await run(host)
    for (const step of embedderSteps) {
      expect({step, ran: host.count(step)}).toEqual({step, ran: 1})
      expect(host.indexOf(step)).toBeGreaterThan(host.indexOf('raw:set-state:open'))
      expect(host.indexOf(step)).toBeGreaterThan(host.indexOf('up-grafana'))
      expect(host.indexOf(step)).toBeLessThan(host.indexOf('remove:.deploy-in-progress'))
    }
    expect(host.indexOf('pull-embedder')).toBeLessThan(host.indexOf('create-embedder'))
    expect(host.indexOf('create-embedder')).toBeLessThan(host.indexOf('embedder-volume'))
    expect(host.indexOf('embedder-volume')).toBeLessThan(host.indexOf('up-embedder'))
    expect(host.unguarded).toEqual([])
    expect(host.unlocked).toEqual([])
    expect(host.calls.find(call => call.step === 'up-embedder')?.command).toContain(
      '--wait --wait-timeout 600 --force-recreate --no-deps embedder\n',
    )
  })

  it('takes the embedder into no route-critical pull or start', async () => {
    const host = new FakeHost()
    await run(host)
    for (const step of ['pull', 'up-private', 'up-public', 'up-caddy', 'up-reporter', 'up-stale-private']) {
      const command = host.calls.find(call => call.step === step)?.command ?? ''
      expect({step, named: /\bembedder\b/.test(command)}).toEqual({step, named: false})
    }
    for (const step of ['pull', 'up-private', 'up-public', 'up-reporter', 'up-caddy']) {
      expect(host.indexOf(step)).toBeLessThan(host.indexOf('raw:set-state:open'))
    }
  })

  // An image pull that fails (registry down, no disk), a model that cannot be fetched so the start never turns healthy,
  // a volume that cannot be handed over: each is an insight failure and none holds ingest.
  it.each(embedderSteps)(
    'a failing %s fails the run as an operator gate, and never holds or closes an open route',
    async step => {
      const host = await openStack()
      host.options.override = failAt(step)
      const error = await failure(host)
      expect(error).toBeInstanceOf(OperatorSurfaceError)
      expect(error.message).toContain('embedder-ready')
      expect((error as OperatorSurfaceError).ingest).toBe('open')
      expect(gateOf(error, 'embedder-ready')).toMatchObject({status: 'fail', kind: 'operator'})
      expect(host.served).toBe('open')
      expect(host.setStates()).toEqual(['open'])
      expect(host.marker).toBeUndefined()
    },
  )

  it('a start that never turns healthy (the model did not download) on a deploy that holds the route: held, reopened, run failed', async () => {
    const host = await openStack()
    host.options.override = step =>
      step === 'up-embedder'
        ? {exitCode: 1, stdout: '', stderr: 'dependency failed to start: embedder is unhealthy'}
        : undefined
    const error = await failure(host, baseEnv(newImage))
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error.message).toContain('embedder-ready')
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
    expect(host.served).toBe('open')
  })

  it('does not start a service whose image did not pull', async () => {
    const host = await openStack()
    const mark = host.calls.length
    host.options.override = failAt('pull-embedder')
    await failure(host)
    expect(ranSince(host, mark, 'create-embedder')).toBe(0)
    expect(ranSince(host, mark, 'up-embedder')).toBe(0)
  })

  it('is independent of Prometheus and Grafana: each is started when another failed', async () => {
    const first = await openStack()
    const mark = first.calls.length
    first.options.override = step => (['pull-prometheus', 'up-grafana'].includes(step) ? failAt(step)(step) : undefined)
    const error = await failure(first)
    expect(error.message).toContain('prometheus-ready')
    expect(error.message).toContain('grafana-ready')
    expect(gateOf(error, 'embedder-ready')).toMatchObject({status: 'pass'})
    expect(ranSince(first, mark, 'up-embedder')).toBe(1)
    const second = await openStack()
    const secondMark = second.calls.length
    second.options.override = failAt('pull-embedder')
    await failure(second)
    expect(ranSince(second, secondMark, 'up-prometheus')).toBe(1)
    expect(ranSince(second, secondMark, 'up-grafana')).toBe(1)
  })

  it('still runs the Grafana checks when only the embedder failed', async () => {
    const host = await openStack()
    const mark = host.calls.length
    host.options.override = failAt('up-embedder')
    const error = await failure(host)
    expect(ranSince(host, mark, 'grafana-signin')).toBeGreaterThan(0)
    expect(gateOf(error, 'grafana-signin')).toMatchObject({status: 'pass'})
  })

  it('also runs when the route stays off (no key pair), and fails the run the same way', async () => {
    const host = new FakeHost()
    await run(host, baseEnv(withoutKey))
    expect(host.count('up-embedder')).toBe(1)
    const failing = new FakeHost({override: failAt('up-embedder')})
    const error = await failure(failing, baseEnv(withoutKey))
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect((error as OperatorSurfaceError).ingest).toBe('off')
    expect(failing.setStates()).toEqual([])
  })

  it('is not started when a safety gate failed: that deploy fails first and the route is held', async () => {
    const host = new FakeHost({checkStatus: {'canary-langfuse': 'fail'}})
    const error = await failure(host)
    expect(error).not.toBeInstanceOf(OperatorSurfaceError)
    for (const step of embedderSteps) expect({step, ran: host.count(step)}).toEqual({step, ran: 0})
  })

  it('a deploy overtaken while the embedder starts ends as overtaken, not as an insight failure', async () => {
    const host = new FakeHost()
    host.options.inFlight = step => {
      if (step === 'pull-embedder') host.marker = `${ID_B} 2023-11-14T22:13:20.000Z\n`
      return undefined
    }
    const error = await failure(host)
    expect(error).toBeInstanceOf(DeployOvertakenError)
    expect(host.refused).toEqual(['create-embedder'])
    expect(host.setStates()).toEqual(['open'])
  })

  it('does not stop the verdict gate or the route when the embedder is the only unhealthy check', async () => {
    const host = new FakeHost({checkStatus: {'embedder-health': 'fail'}})
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(result.gates.find(gate => gate.id === 'reporter-verdict')).toMatchObject({status: 'pass'})
    expect(host.setStates()).toEqual(['open'])
  })

  it('says in the error which service failed and that the route was not changed', async () => {
    const host = new FakeHost({override: failAt('up-embedder')})
    const error = await failure(host)
    expect(error.message).toContain('embedder-ready')
    expect(error.message).toContain('this failure did not change the route')
  })
})

describe('the reporter verdict the deploy reads is the ingest verdict', () => {
  const parse = (detail: Record<string, unknown>) =>
    parseReporterDetail({exitCode: 0, stdout: `${JSON.stringify(detail)}\nTRACES_DETAIL_END\n`, stderr: ''})
  const body = {schemaVersion: 1, ran: true, stale: false, ok: true, at: '2026-11-20T11:58:00.000Z'}

  it('opens with a passing ingest verdict while Grafana and Prometheus are failing', async () => {
    const host = new FakeHost({checkStatus: {'grafana-health': 'fail', 'prometheus-health': 'unknown'}})
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(host.served).toBe('open')
  })

  it('still fails the gate when an ingest check fails, and names it and not the monitoring checks', async () => {
    const host = new FakeHost({
      checkStatus: {'langfuse-worker': 'fail', 'grafana-health': 'fail'},
      verdict: {ok: false},
    })
    const error = await failure(host)
    expect(error.message).toContain('langfuse-worker')
    expect(error.message).not.toContain('grafana-health')
  })

  it('keeps the scope and the monitoring flag when it parses the answer', () => {
    const parsed = parse({
      ...body,
      monitoringOk: false,
      checks: [
        {id: 'collector-health', status: 'pass', detail: 'x', scope: 'ingest'},
        {id: 'grafana-health', status: 'fail', detail: 'y', scope: 'monitoring'},
      ],
    })
    expect(parsed?.monitoringOk).toBe(false)
    expect(parsed?.checks.map(entry => entry.scope)).toEqual(['ingest', 'monitoring'])
  })

  it('reads a reporter without the split fields, and refuses a scope or a flag of the wrong kind', () => {
    expect(parse({...body, checks: [{id: 'a', status: 'pass', detail: 'x'}]})).toMatchObject({ok: true})
    expect(parse({...body, checks: [{id: 'a', status: 'pass', detail: 'x', scope: 'other'}]})).toBeUndefined()
    expect(parse({...body, monitoringOk: 'yes', checks: []})).toBeUndefined()
  })
})

describe('the Grafana alerting check', () => {
  const GRAFANA_PASSWORD = baseEnv().TRACES_GRAFANA_ADMIN_PASSWORD ?? ''
  const WEBHOOK = baseEnv().TRACES_DISCORD_WEBHOOK_URL ?? ''
  const probeCount = (host: FakeHost): number => host.count('grafana-alerting')

  it('passes when the Discord contact point and every rule group are provisioned, after the route is final and the marker is gone', async () => {
    const host = new FakeHost()
    const {result, logs} = await run(host)
    expect(result.ingest).toBe('open')
    expect(result.gates.find(gate => gate.id === 'grafana-alerting')).toMatchObject({status: 'pass', kind: 'operator'})
    expect(logs.join('\n')).toContain('✓ grafana-alerting')
    expect(probeCount(host)).toBe(1)
    expect(host.indexOf('grafana-alerting')).toBeGreaterThan(host.indexOf('grafana-signin'))
    expect(host.indexOf('grafana-alerting')).toBeGreaterThan(host.indexOf('remove:.deploy-in-progress'))
  })

  it('runs with no key pair too: alerting does not depend on the Langfuse key', async () => {
    const host = new FakeHost()
    const {result} = await run(host, baseEnv(withoutKey))
    expect(result.ingest).toBe('off')
    expect(probeCount(host)).toBe(1)
  })

  it.each([
    ['the contact point is missing', 'no-contact-point', 'Discord contact point'],
    ['the contact point is not of type discord', 'wrong-type', 'type "webhook"'],
    ['a rule group is missing', 'no-group', 'rule group'],
    ['a rule group holds fewer rules than the file defines', 'partial-group', 'rule group'],
    ['Grafana refuses the credential', 'http-401', 'HTTP 401'],
  ] as const)(
    'fails the run when %s, and leaves the route as the route gates decided',
    async (_name, mode, expected) => {
      const host = new FakeHost({alerting: mode})
      const error = await failure(host)
      expect(error).toBeInstanceOf(OperatorSurfaceError)
      expect(error.message).toContain('grafana-alerting')
      expect(error.message).toContain(expected)
      expect((error as OperatorSurfaceError).ingest).toBe('open')
      expect(host.served).toBe('open')
      expect(host.setStates()).toEqual(['open'])
      expect(probeCount(host)).toBe(1)
    },
  )

  it.each([
    ['a failed answer from the host', {exitCode: 255, stdout: '', stderr: 'ssh: dropped'}],
    ['an answer that is not the probe output', ok('this is not the probe output\n')],
    [
      'a contact point list that is not JSON',
      ok('TRACES_GRAFANA_CP_HTTP=200\nTRACES_GRAFANA_CP_BODY=<html>\nTRACES_GRAFANA_ALERTING_PROBED\n'),
    ],
  ])('treats %s as a failed check, never as a pass', async (_name, reply) => {
    const host = new FakeHost({override: step => (step === 'grafana-alerting' ? reply : undefined)})
    const error = await failure(host)
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error.message).toContain('grafana-alerting')
    expect(error.message).toContain('could not be read')
  })

  it('reports a rejected execution as an operator-surface failure naming the cause', async () => {
    const host = new FakeHost()
    const t = testDeps(host, {
      run: async (argv, options) => {
        if (stepOf(argv.at(-1) ?? '') === 'grafana-alerting') throw new Error('spawn blew up')
        return host.run(argv, options)
      },
    })
    const error = await deploy({env: baseEnv(), deps: t.deps}).then(
      () => undefined,
      (error_: unknown) => error_ as Error,
    )
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error?.message).toContain('spawn blew up')
  })

  it('is not run when the sign-in check failed: one wrong password is already one failed login too many', async () => {
    const host = new FakeHost({grafana: '401'})
    const error = await failure(host)
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    expect(error.message).toContain('grafana-signin')
    expect(error.message).not.toContain('grafana-alerting')
    expect(probeCount(host)).toBe(0)
    const result = (error as OperatorSurfaceError).result
    expect(result.gates.find(gate => gate.id === 'grafana-alerting')).toMatchObject({
      status: 'skipped',
      kind: 'operator',
    })
  })

  it('does not run after a deploy that failed', async () => {
    const host = new FakeHost({override: failAt('pull')})
    await failure(host)
    expect(probeCount(host)).toBe(0)
  })

  it('is read only: two GETs of the provisioning API, never a test notification or a write', () => {
    const script = grafanaAlertingScript()
    expect(script).toContain('base=http://127.0.0.1:3001/api/v1/provisioning\n')
    expect(script).toContain('get "$base/contact-points"')
    expect(script).toContain('get "$base/alert-rules"')
    expect(script.match(/^get "/gm)).toHaveLength(2)
    expect(script).not.toMatch(
      /-X\b|--request|--data|--json|\bPOST\b|\bPUT\b|\bDELETE\b|\bPATCH\b|\btest|notif|receivers/i,
    )
    expect(script).toContain('secrets/grafana/admin-password')
    expect(script).toContain("curl -q -s --noproxy '*'")
    expect(script.match(/curl -q/g)).toHaveLength(1)
  })

  it('keeps the password and the webhook out of the command text, argv, stdin, logs and the error', async () => {
    const env = baseEnv()
    const host = new FakeHost({alerting: 'no-group'})
    const t = testDeps(host)
    const error = await deploy({env, deps: t.deps}).then(
      () => undefined,
      (error_: unknown) => error_ as Error,
    )
    expect(error).toBeInstanceOf(OperatorSurfaceError)
    for (const call of host.calls.filter(entry => entry.step === 'grafana-alerting')) {
      expect(call.stdin).toBeUndefined()
      for (const secret of [GRAFANA_PASSWORD, WEBHOOK]) {
        expect(call.command).not.toContain(secret)
        expect(call.argv.join('\u0000')).not.toContain(secret)
      }
    }
    expectNoSecretOutsideStdin(env, host, t.logs)
    expect(error?.message).not.toContain(WEBHOOK)
  })

  it('run for real against a recording curl: reads both lists, counts rules by group, and prints no settings', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      mkdirSync(join(root, 'secrets/grafana'), {recursive: true})
      writeFileSync(join(root, 'secrets/grafana/admin-password'), 'scratch-grafana-password-0001')
      writeFileSync(
        join(shim, 'curl'),
        String.raw`#!/bin/bash
printf '%s\n' "$@" >> "${shim}/curl-argv"
url=""
for a in "$@"; do url="$a"; done
cat > "${shim}/curl-stdin"
case "$url" in
  */contact-points) printf '[{"uid":"traces-discord","name":"Traces Discord","type":"discord","settings":{"url":"https://discord.com/api/webhooks/1/secret-token"},"provenance":"file"}]\nTRACES_HTTP=200' ;;
  */alert-rules) printf '[{"uid":"a","ruleGroup":"collector","title":"x"},{"uid":"b","ruleGroup":"collector"},{"uid":"c","ruleGroup":"tempo"}]\nTRACES_HTTP=200' ;;
  *) printf 'TRACES_HTTP=404' ;;
esac
`,
      )
      chmodSync(join(shim, 'curl'), 0o755)

      const result = runLocally(grafanaAlertingScript(), root, shim)
      expect(result.code).toBe(0)
      expect(result.out).not.toContain('secret-token')
      expect(result.out).not.toContain('discord.com')
      expect(result.out).not.toContain('scratch-grafana-password-0001')
      expect(parseGrafanaAlerting(result.out)).toMatchObject({
        contactPoints: {code: '200'},
        rules: {code: '200', groups: {collector: 2, tempo: 1}},
      })
      const argv = readFileSync(join(shim, 'curl-argv'), 'utf8')
      expect(argv).not.toContain('scratch-grafana-password-0001')
      expect(argv).toContain('/api/v1/provisioning/contact-points')
      expect(argv).toContain('/api/v1/provisioning/alert-rules')
    } finally {
      cleanup()
    }
  })

  it('run for real: with no password file it makes no request and gives no answer', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      writeFileSync(join(shim, 'curl'), '#!/bin/bash\ntouch "$0.called"\n')
      chmodSync(join(shim, 'curl'), 0o755)
      const result = runLocally(grafanaAlertingScript(), root, shim)
      expect(existsSync(join(shim, 'curl.called'))).toBe(false)
      expect(parseGrafanaAlerting(result.out)).toMatchObject({contactPoints: {code: '000'}, rules: {code: '000'}})
    } finally {
      cleanup()
    }
  })

  it('names the contact point and the rule groups the files provision, pinned to the files', async () => {
    const provision = (name: string): unknown =>
      Bun.YAML.parse(readFileSync(join(APP, `config/grafana/alerting/${name}.yaml`), 'utf8'))
    const point = (provision('contact-points') as {contactPoints: {receivers: {uid: string; type: string}[]}[]})
      .contactPoints[0]?.receivers[0]
    expect(point).toMatchObject({uid: ALERT_CONTACT_POINT_UID, type: 'discord'})
    const groups = (provision('rules') as {groups: {name: string; rules: unknown[]}[]}).groups
    expect(Object.fromEntries(groups.map(group => [group.name, group.rules.length]))).toEqual(
      Object.fromEntries(ALERT_RULE_GROUPS.map(group => [group.name, group.rules])),
    )
  })

  describe('evaluateGrafanaAlerting and parseGrafanaAlerting', () => {
    const answer = (extra = ''): string =>
      [
        'TRACES_GRAFANA_CP_HTTP=200',
        `TRACES_GRAFANA_CP_BODY=[{"uid":"${ALERT_CONTACT_POINT_UID}","name":"Traces Discord","type":"discord","settings":{}}]`,
        'TRACES_GRAFANA_RULES_HTTP=200',
        ...ALERT_RULE_GROUPS.map(group => `TRACES_GRAFANA_RULE_GROUP=${group.name} ${group.rules}`),
        extra,
        'TRACES_GRAFANA_ALERTING_PROBED',
        '',
      ].join('\n')

    it('reads a complete answer and passes it', () => {
      const parsed = parseGrafanaAlerting(answer())
      expect(parsed).toBeDefined()
      expect(evaluateGrafanaAlerting(parsed ?? {error: 'unreadable'})).toMatchObject({
        id: 'grafana-alerting',
        status: 'pass',
        kind: 'operator',
      })
    })

    it('refuses anything that is not a complete answer', () => {
      expect(parseGrafanaAlerting('')).toBeUndefined()
      expect(parseGrafanaAlerting(answer().replace('TRACES_GRAFANA_ALERTING_PROBED', ''))).toBeUndefined()
      expect(parseGrafanaAlerting(answer().replace('TRACES_GRAFANA_CP_HTTP=200\n', ''))).toBeUndefined()
      expect(parseGrafanaAlerting(answer().replace('TRACES_GRAFANA_RULES_HTTP=200\n', ''))).toBeUndefined()
    })

    it('fails on a rule group the file defines and Grafana lacks, and names it', () => {
      const first = ALERT_RULE_GROUPS[0]
      const parsed = parseGrafanaAlerting(
        answer().replace(`TRACES_GRAFANA_RULE_GROUP=${first?.name} ${first?.rules}\n`, ''),
      )
      const gate = evaluateGrafanaAlerting(parsed ?? {error: 'unreadable'})
      expect(gate.status).toBe('fail')
      expect(gate.detail).toContain(first?.name ?? 'missing')
    })
  })
})

describe('bootstrap lifecycle', () => {
  it('takes three deploys: bootstrap, then prove-dead while the key lives, then open', async () => {
    const host = new FakeHost()

    // 1. Bootstrap pair supplied, no application key yet: off, and the pair is in the host's .env.
    const first = await run(host, baseEnv({...withoutKey, ...bootstrap}))
    expect(first.result.ingest).toBe('off')
    expect(host.env).toContain('LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-placeholder-boot-public')
    expect(host.bootstrapKeyLive).toBe(true)

    // 2. Operator set the application key and deleted the bootstrap secrets, but not the key itself.
    const second = await failure(host)
    expect(second).toBeInstanceOf(AppliedButUnverifiedError)
    expect(host.env).not.toContain('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')
    expect(host.env).not.toContain('LANGFUSE_INIT_PROJECT_SECRET_KEY')
    expect(host.env).toContain('LANGFUSE_INIT_ORG_ID=')
    // The pair was set aside before .env was rewritten without it, so deploy three can still prove it dead.
    expect(host.bootstrapPending).toBe('pk-lf-placeholder-boot-public:sk-lf-placeholder-boot-secret')
    expect(host.indexOf('write:secrets/bootstrap-pending')).toBeLessThan(
      host.calls.findLastIndex(call => call.step === 'write:.env'),
    )
    expect(host.served).toBe('off')

    // 3. The operator deleted the bootstrap key in Langfuse. Deploy proves it and opens ingest.
    host.bootstrapKeyLive = false
    const third = await run(host)
    expect(third.result.ingest).toBe('open')
    expect(host.bootstrapPending).toBeUndefined()
    const probes = host.calls.filter(call => call.step === 'bootstrap-probe')
    expect(Buffer.from(probes.at(-1)?.stdin?.trim() ?? '', 'base64').toString('utf8')).toBe(
      'pk-lf-placeholder-boot-public:sk-lf-placeholder-boot-secret',
    )

    // 4. Nothing is on record any more: later deploys make no probe and still pass.
    const calls = host.calls.length
    await run(host)
    expect(host.calls.slice(calls).filter(call => call.step === 'bootstrap-probe')).toHaveLength(0)
  })

  it('does not drop the record while the key is still live', async () => {
    const host = new FakeHost()
    await run(host, baseEnv({...withoutKey, ...bootstrap}))
    await failure(host)
    await failure(host)
    expect(host.bootstrapPending).toBeDefined()
  })
})

describe('holding the route', () => {
  const newImage = {TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}

  it('holds before anything changes when a gated service is about to change, and proves 503', async () => {
    const host = await openStack()
    const start = host.calls.length
    host.options.checkStatus = {'canary-langfuse': 'fail'}
    await failure(host, baseEnv(newImage))
    const after = host.calls.slice(start).map(call => call.step)

    const held = after.indexOf('raw:set-state:held')
    expect(held).toBeGreaterThanOrEqual(0)
    const firstChange = after.findIndex(
      step =>
        (step.startsWith('write:') && step !== 'write:.deploy-in-progress') ||
        step.startsWith('up-') ||
        step === 'pull' ||
        step === 'prepare-dirs',
    )
    expect(held).toBeLessThan(firstChange)
    expect(after.indexOf('probe-ingest')).toBeGreaterThan(held)
    expect(after.indexOf('probe-ingest')).toBeLessThan(firstChange)
  })

  it('leaves the route held and fails when the canary fails after the update of an open stack (AE6)', async () => {
    const host = await openStack()
    host.options.checkStatus = {'canary-langfuse': 'fail'}
    const error = await failure(host, baseEnv(newImage))
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect((error as AppliedButUnverifiedError).ingest).toBe('held')
    expect(error.message).toContain('Ingest is held')
    expect(host.served).toBe('held')
    expect(host.setStates()).toEqual(['open', 'held'])
    // From outside the deploy: every ingest path answers 503.
    expect(host.options.probeOverride).toBeUndefined()
  })

  it('does not hold when no gated service changes', async () => {
    const host = await openStack()
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(result.changed).toEqual([])
    expect(host.setStates()).toEqual(['open'])
  })

  it('does not hold when only Grafana changes, and recreates only Grafana', async () => {
    const host = await openStack()
    const {result} = await run(host, baseEnv({TRACES_GRAFANA_ADMIN_PASSWORD: 'placeholder-grafana-admin-rotated'}))
    expect(result.changed).toEqual(['grafana'])
    expect(host.setStates()).toEqual(['open'])
    // Grafana is recreated in the monitoring stage, after the route, and not in the route-critical stale step.
    expect(host.count('up-stale-public')).toBe(0)
    const started = host.calls.findLast(call => call.step === 'up-grafana')
    expect(started?.command).toContain('--force-recreate --no-deps grafana')
    expect(host.steps.lastIndexOf('up-grafana')).toBeGreaterThan(host.steps.lastIndexOf('raw:set-state:open'))
    expect(host.count('up-stale-private')).toBe(0)
  })

  it('treats a rotated Discord webhook as a change to .env, like every other secret in it', async () => {
    const host = await openStack()
    const {result} = await run(
      host,
      baseEnv({
        TRACES_DISCORD_WEBHOOK_URL:
          'https://discord.com/api/webhooks/123456789012345678/placeholder-rotated-token-0123456789',
      }),
    )
    // `.env` is a compose input: compose recreates what it changes, and an open route is held for that.
    expect(result.changed).toContain('compose')
    expect(host.env).toContain('placeholder-rotated-token-0123456789')
  })

  it('holds when a collector config file changes, and reopens after the gates pass', async () => {
    const host = await openStack()
    const t = testDeps(host, {
      readFile: async relative => `# ${relative}${relative === 'config/otelcol.yaml' ? ' changed' : ''}\n`,
    })
    const result = await deploy({env: baseEnv(), deps: t.deps})
    expect(result.changed).toContain('collector')
    expect(result.heldForUpdate).toBe(true)
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
    expect(host.served).toBe('open')
    const stale = host.calls.findLast(call => call.step === 'up-stale-public')
    expect(stale?.command).toContain('--force-recreate --no-deps collector')
  })

  it('holds when the compose file or .env changes (compose recreates what it changes)', async () => {
    const host = await openStack()
    const t = testDeps(host, {
      readFile: async relative => `# ${relative}${relative === 'docker-compose.yaml' ? ' bumped' : ''}\n`,
    })
    const result = await deploy({env: baseEnv(), deps: t.deps})
    expect(result.changed).toContain('compose')
    expect(result.heldForUpdate).toBe(true)
  })

  it('does not touch the route and fails before changing anything when the hold cannot be proven', async () => {
    const host = await openStack()
    host.options.stateIgnored = true
    const writesBefore = host.writes().length
    const error = await failure(host, baseEnv(newImage))
    expect(error.message).toContain('Could not hold the ingest route')
    expect(error.message).toContain('traces ingest hold')
    // Nothing about the stack changed (the marker is written by the locked first read, not by a file write).
    expect(host.writes().slice(writesBefore)).toEqual([])
    expect(host.count('pull')).toBe(1)
    expect(host.count('up-private')).toBe(1)
  })

  it('holds an open route when the gates fail even though nothing gated changed', async () => {
    const host = await openStack()
    host.options.checkStatus = {'tempo-ready': 'fail'}
    const error = await failure(host)
    expect((error as AppliedButUnverifiedError).ingest).toBe('held')
    expect(host.served).toBe('held')
  })

  it('says the route stays held when a failure comes after the hold but before anything is applied', async () => {
    const host = await openStack()
    host.options.freeBytes = 1024 ** 3
    const error = await failure(host, baseEnv(newImage))
    expect(error).not.toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('stays held')
    expect(host.served).toBe('held')
  })

  it('holds an open route when the apply step fails without a gated change, and proves it', async () => {
    const host = await openStack()
    host.options.override = step => (step === 'up-public' ? {exitCode: 1, stdout: '', stderr: 'unhealthy'} : undefined)
    const error = await failure(host)
    expect((error as AppliedButUnverifiedError).ingest).toBe('held')
    expect(host.served).toBe('held')
  })

  it('does not claim the route is held when the hold cannot be proven', async () => {
    const host = await openStack()
    host.options.checkStatus = {'tempo-ready': 'fail'}
    host.options.stateIgnored = true
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect((error as AppliedButUnverifiedError).ingest).toBe('unknown')
    expect(error.message).toContain('traces ingest hold')
  })

  it('reopens a held route only through a deploy that passes every gate', async () => {
    const host = await openStack()
    // `traces ingest hold` by hand.
    host.envState = 'held'
    host.served = 'held'
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(host.setStates()).toEqual(['open', 'open'])
  })

  it('holds an open route, and says so, when TRACES_INGEST_OPEN is no longer true', async () => {
    const host = await openStack()
    const {result, logs} = await run(host, baseEnv({TRACES_INGEST_OPEN: undefined}))
    expect(result.ingest).toBe('held')
    expect(host.served).toBe('held')
    expect(logs.join('\n')).toContain('Ingest is HELD')
  })

  it('holds an open route and completes when the key pair is taken away', async () => {
    const host = await openStack()
    const {result, logs} = await run(host, baseEnv(withoutKey))
    expect(result.ingest).toBe('held')
    expect(host.served).toBe('held')
    expect(logs.join('\n')).toContain('langfuse-key')
  })
})

// ─── The host's truth, the marker and drift ───────────────────────────────────

const MARKER_FORMAT = /^[\da-f]{32} \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n$/

/** An override that fails one step when it is reached (something going wrong after the first change). */
function failAt(step: string): (current: string) => RunResult | undefined {
  return current => (current === step ? {exitCode: 1, stdout: '', stderr: `${step} failed`} : undefined)
}

describe('host contract', () => {
  it('keeps the four paths in host.ts and uses them', () => {
    expect(TRACES_DEPLOY_MARKER).toBe(`${TRACES_APP_DIR}/.deploy-in-progress`)
    expect(TRACES_PENDING_RESTARTS).toBe(`${TRACES_APP_DIR}/.pending-restarts`)
    expect(beginDeployScript(ID_A)).toContain(TRACES_DEPLOY_MARKER)
    expect(beginDeployScript(ID_A)).toContain(TRACES_PENDING_RESTARTS)
    expect(removeOwnFileScript(ID_A, '.deploy-in-progress')).toContain(TRACES_DEPLOY_MARKER)
    expect(removeOwnFileScript(ID_A, '.pending-restarts')).toContain(TRACES_PENDING_RESTARTS)
    expect(() => removeOwnFileScript(ID_A, '.env' as never)).toThrow('not a file this deploy owns')
  })

  it('runs every ingest state change under flock on the ingest lock, and says LOCK_BUSY when it cannot take it', () => {
    for (const state of ['off', 'held', 'open'] as const) {
      const command = setIngestStateCommand(state, ID_A)
      expect(command).toContain(TRACES_INGEST_LOCK)
      expect(command).toContain('flock -w 30')
      expect(command).toContain(TRACES_LOCK_BUSY_SENTINEL)
      // The lock is taken before the state is read, and held through the Caddy recreate.
      expect(command.indexOf('flock -w 30')).toBeLessThan(command.indexOf('grep -v'))
      expect(command.indexOf('grep -v')).toBeLessThan(command.indexOf('--force-recreate'))
      expect(command).not.toContain('/dev/null')
    }
  })

  it('reports a busy lock as its own failure, not as a missing confirmation', async () => {
    const host = new FakeHost({
      override: (step, call) =>
        step === 'raw:set-state' || call.command.includes('TRACES_INGEST_STATE_SET=')
          ? {exitCode: 1, stdout: 'LOCK_BUSY\n', stderr: ''}
          : undefined,
    })
    const error = await failure(host, baseEnv({TRACES_INGEST_OPEN: 'true'}))
    expect(error.message).toContain('ingest lock')
    expect(error.message).toContain('30 seconds')
  })

  it('every state change deploy makes goes through that command, in a full open and hold cycle', async () => {
    const host = await openStack()
    await run(host, baseEnv({TRACES_INGEST_OPEN: undefined}))
    const sets = host.calls.filter(call => call.step.startsWith('raw:set-state:'))
    expect(sets.length).toBeGreaterThanOrEqual(2)
    for (const call of sets) expect(call.command).toContain('flock -w 30')
  })
})

describe('deploy marker', () => {
  it('is written by the first read of the host, after the storage check and before any change, and removed last', async () => {
    const host = new FakeHost()
    await run(host)
    // The Grafana probe is read-only and runs after the marker is gone: it is not part of the marker's life.
    const steps = nonSshSteps(host).filter(step => !OPERATOR_STEPS.includes(step))
    expect(host.steps).not.toContain('write:.deploy-in-progress')
    expect(host.indexOf('host-state')).toBeGreaterThan(host.indexOf('storage-probe'))
    expect(host.indexOf('host-state')).toBeLessThan(host.indexOf('compare:docker-compose.yaml'))
    expect(host.indexOf('host-state')).toBeLessThan(host.indexOf('prepare-dirs'))
    expect(steps.at(-1)).toBe('remove:.deploy-in-progress')
    expect(host.marker).toBeUndefined()
  })

  it('is written before the hold, which is already a change to the host', async () => {
    const host = await openStack()
    const start = host.calls.length
    await run(host, baseEnv({TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}))
    const after = host.calls.slice(start).map(call => call.step)
    expect(after.indexOf('host-state')).toBeGreaterThanOrEqual(0)
    expect(after.indexOf('host-state')).toBeLessThan(after.indexOf('raw:set-state:held'))
  })

  it('holds one UTC timestamp on one line', async () => {
    const host = new FakeHost({override: failAt('pull')})
    await failure(host)
    expect(host.marker).toMatch(MARKER_FORMAT)
  })

  it('is still there after a failed deploy, whatever failed and wherever', async () => {
    const failures: [string, string][] = [
      ['a file write', 'write:docker-compose.yaml'],
      ['the pull', 'pull'],
      ['starting the stores', 'up-private'],
      ['starting the collector', 'up-public'],
      ['the digest check', 'digest:collector'],
      ['starting Caddy', 'up-caddy'],
      ['the gate read', 'token-dirs'],
    ]
    for (const [label, step] of failures) {
      const host = new FakeHost({override: failAt(step)})
      await failure(host)
      expect({label, marker: host.marker === undefined}).toEqual({label, marker: false})
    }
  })

  it('is still there when a gate fails after everything is up', async () => {
    const host = new FakeHost({checkStatus: {'canary-langfuse': 'fail'}})
    await failure(host)
    expect(host.marker).toMatch(MARKER_FORMAT)
    expect(host.steps).not.toContain('remove:.deploy-in-progress')
  })

  it('is still there when the hold before an update cannot be proven', async () => {
    const host = await openStack()
    host.options.stateIgnored = true
    await failure(host, baseEnv({TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}))
    expect(host.marker).toMatch(MARKER_FORMAT)
  })

  it('is absent after a successful deploy that opened ingest', async () => {
    const host = new FakeHost()
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(host.marker).toBeUndefined()
  })

  it('is absent after the legitimate "completed with ingest off, key pair unset" outcome', async () => {
    const host = new FakeHost()
    const {result} = await run(host, baseEnv(withoutKey))
    expect(result.ingest).toBe('off')
    expect(host.marker).toBeUndefined()
    expect(host.steps.filter(step => !OPERATOR_STEPS.includes(step)).at(-2)).toBe('remove:.deploy-in-progress')
  })

  it('is absent after a completed deploy that left the route off because TRACES_INGEST_OPEN is not true, or held an open route', async () => {
    const off = new FakeHost()
    expect((await run(off, baseEnv({TRACES_INGEST_OPEN: undefined}))).result.ingest).toBe('off')
    expect(off.marker).toBeUndefined()

    const held = await openStack()
    expect((await run(held, baseEnv({TRACES_INGEST_OPEN: undefined}))).result.ingest).toBe('held')
    expect(held.marker).toBeUndefined()
  })

  it('is removed only after the route is in its final state', async () => {
    const host = await openStack()
    await run(host, baseEnv({TRACES_INGEST_OPEN: undefined}))
    expect(host.calls.findLastIndex(call => call.step === 'remove:.deploy-in-progress')).toBeGreaterThan(
      host.calls.findLastIndex(call => call.step === 'raw:set-state:held'),
    )
  })

  it('is overwritten by the next deploy, which then removes it', async () => {
    const host = new FakeHost({override: failAt('pull')})
    await failure(host)
    expect(host.marker).toBeDefined()
    delete host.options.override
    host.clock += 3600
    await run(host)
    expect(host.marker).toBeUndefined()
  })

  it('makes a deploy treat an open route with a leftover marker as a change: hold first', async () => {
    const host = await openStack()
    host.marker = '2023-11-14T22:13:20.000Z\n'
    const {result} = await run(host)
    expect(result.heldForUpdate).toBe(true)
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
    expect(host.marker).toBeUndefined()
  })

  it('is not written when the deploy stops before any change (storage, DNS, input)', async () => {
    const host = new FakeHost({storageAnswer: ok('nope\n')})
    await failure(host)
    expect(host.marker).toBeUndefined()
    expect(host.steps).not.toContain('write:.deploy-in-progress')
  })
})

describe("the route after a failure follows the host, not this deploy's last write", () => {
  it('lost reply after a successful remote open: the route ends held and proven 503', async () => {
    const host = new FakeHost({loseReplyOn: 'open'})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect((error as AppliedButUnverifiedError).ingest).toBe('held')
    expect(error.message).toContain('Ingest is held')
    expect(host.served).toBe('held')
    expect(host.envState).toBe('held')
    expect(host.setStates()).toEqual(['open', 'held'])
    // The 503 was proven from inside the host after the hold.
    const lastHold = host.calls.findLastIndex(call => call.step === 'raw:set-state:held')
    expect(host.calls.slice(lastHold).some(call => call.step === 'probe-ingest')).toBe(true)
    expect(host.marker).toMatch(MARKER_FORMAT)
  })

  it('a manual open during the deploy, then a deploy failure: the route ends held', async () => {
    const host: FakeHost = new FakeHost({
      override: step => {
        if (step === 'pull') {
          // `traces ingest open` by another operator, while this deploy is running.
          host.envState = 'open'
          host.served = 'open'
          return undefined
        }
        return step === 'up-public' ? {exitCode: 1, stdout: '', stderr: 'unhealthy'} : undefined
      },
    })
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect((error as AppliedButUnverifiedError).ingest).toBe('held')
    expect(host.served).toBe('held')
    expect(host.setStates()).toEqual(['held'])
  })

  it('a manual open during a stage-phase failure ends held too', async () => {
    const host = new FakeHost()
    await run(host, baseEnv(withoutKey))
    host.options.override = step => {
      if (step === 'prepare-dirs') {
        host.envState = 'open'
        host.served = 'open'
        return undefined
      }
      return step === 'token-file:marcusrbrown' ? {exitCode: 1, stdout: '', stderr: 'disk error'} : undefined
    }
    const error = await failure(host)
    expect(error).not.toBeInstanceOf(AppliedButUnverifiedError)
    expect(host.served).toBe('held')
  })

  it('does not touch the route when the host says it is off and Caddy answers 404', async () => {
    const host = new FakeHost({override: failAt('up-public')})
    const error = await failure(host)
    expect((error as AppliedButUnverifiedError).ingest).toBe('off')
    expect(host.setStates()).toEqual([])
  })

  it('does not trust a .env that says held while Caddy still serves the open route', async () => {
    const host = await openStack()
    // `.env` says held, the container was never recreated: Caddy still answers as open.
    host.envState = 'held'
    host.options.override = failAt('pull')
    await failure(host)
    expect(host.served).toBe('held')
    expect(host.setStates().at(-1)).toBe('held')
  })

  it('says plainly that ingest may be open, and names the hold command, when the hold cannot be confirmed', async () => {
    const host = new FakeHost({loseReplyOn: 'open', probeOverride: () => ({})})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect((error as AppliedButUnverifiedError).ingest).toBe('unknown')
    expect(error.message).toContain('may be open')
    expect(error.message).toContain('traces ingest hold')
  })

  it('says the same when the host cannot be read at all after the failure', async () => {
    const host = new FakeHost({
      override: (step, call) => {
        if (step === 'up-public') return {exitCode: 1, stdout: '', stderr: 'unhealthy'}
        if (step === 'ingest-state' || call.command.includes('TRACES_INGEST_STATE_SET=')) {
          return {exitCode: 255, stdout: '', stderr: 'ssh: connection lost'}
        }
        return undefined
      },
    })
    const first = await failure(host)
    expect(first.message).toContain('may be open')
  })

  it('a stage failure after a successful hold stays held and says why', async () => {
    const host = await openStack()
    host.options.override = failAt('prepare-dirs')
    const error = await failure(
      host,
      baseEnv({TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}),
    )
    expect(error).not.toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('stays held')
    expect(host.served).toBe('held')
  })

  it('holds an open route when a stage failure happens with nothing gated changing', async () => {
    const host = await openStack()
    host.options.override = failAt('prepare-dirs')
    const error = await failure(host)
    expect(error.message).toContain('Ingest is held')
    expect(host.served).toBe('held')
  })
})

// The comparison runs after the deploy took its marker. A step of it that fails (a lost reply, or `stat` failing on the host)
// used to leave the deploy with the marker, an open route still open, and no word about the route.
describe('a failure while the files are compared with the host', () => {
  const compareFails = failAt('compare:config/otelcol.yaml')
  const changing = (step: string): boolean =>
    step.startsWith('write:') ||
    step.startsWith('up-') ||
    step.startsWith('token-file:') ||
    [
      'pull',
      'prune-images',
      'prepare-dirs',
      'create-collector',
      'queue-volume',
      'create-prometheus',
      'prometheus-volume',
      'create-embedder',
      'embedder-volume',
    ].includes(step)

  function expectNothingChanged(host: FakeHost, start: number): void {
    expect(host.calls.slice(start).filter(call => changing(call.step))).toEqual([])
    expect(host.pendingRestarts).toEqual([])
  }

  it('holds an open route, proves it, keeps the marker and says nothing was changed', async () => {
    const host = await openStack()
    const start = host.calls.length
    host.options.override = compareFails
    const error = await failure(host)

    expect(error.name).toBe('FilesNotComparedError')
    expect((error as Error & {ingest?: string}).ingest).toBe('held')
    expect(error).not.toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('could not be compared')
    expect(error.message).toContain('compare:config/otelcol.yaml failed')
    expect(error.message).toContain('The update was not applied')
    expect(error.message).toContain('Ingest is held')
    expect(error.message).toContain('marker')
    // Nothing claims the host was updated.
    expect(error.message).not.toMatch(/host was updated|Applied but unverified/)

    // The route: held, from the host's own answer, and proven on every ingest path.
    expect(host.served).toBe('held')
    expect(host.envState).toBe('held')
    expect(host.setStates()).toEqual(['open', 'held'])
    const lastHold = host.calls.findLastIndex(call => call.step === 'raw:set-state:held')
    expect(host.calls.slice(lastHold).some(call => call.step === 'probe-ingest')).toBe(true)
    // The marker stays, so the next deploy holds first.
    expect(host.marker).toMatch(MARKER_FORMAT)
    expectNothingChanged(host, start)
  })

  it('says so, and to hold by hand, when the route cannot be secured either', async () => {
    const host = await openStack()
    const start = host.calls.length
    host.options.override = (step, call) => {
      if (step === 'ingest-state' || call.command.includes('TRACES_INGEST_STATE_SET=')) {
        return {exitCode: 255, stdout: '', stderr: 'ssh: connection lost'}
      }
      return compareFails(step)
    }
    const error = await failure(host)

    expect(error.name).toBe('FilesNotComparedError')
    expect((error as Error & {ingest?: string}).ingest).toBe('unknown')
    expect(error.message).toContain('could not be compared')
    expect(error.message).toContain('The update was not applied')
    expect(error.message).toContain('may be open')
    expect(error.message).toContain('traces ingest hold')
    expect(error.message).not.toMatch(/host was updated|Applied but unverified/)
    expect(host.marker).toMatch(MARKER_FORMAT)
    expectNothingChanged(host, start)
  })

  it('keeps a held route held: nothing is set again, the marker stays', async () => {
    const host = await openStack()
    host.envState = 'held'
    host.served = 'held'
    const start = host.calls.length
    host.options.override = compareFails
    const error = await failure(host)

    expect(error.name).toBe('FilesNotComparedError')
    expect((error as Error & {ingest?: string}).ingest).toBe('held')
    expect(error.message).toContain('Ingest is held')
    expect(host.served).toBe('held')
    expect(host.setStates()).toEqual(['open'])
    expect(host.marker).toMatch(MARKER_FORMAT)
    expectNothingChanged(host, start)
  })

  it('leaves a host with no route as it is: ingest is off, nothing is set, the marker stays', async () => {
    const host = new FakeHost({override: compareFails})
    const error = await failure(host)

    expect(error.name).toBe('FilesNotComparedError')
    expect((error as Error & {ingest?: string}).ingest).toBe('off')
    expect(error.message).toContain('Ingest is off')
    expect(host.setStates()).toEqual([])
    expect(host.marker).toMatch(MARKER_FORMAT)
    expectNothingChanged(host, 0)
  })

  it('does not hold, probe or read the route when the deploy was overtaken meanwhile', async () => {
    const host = await openStack()
    const start = host.calls.length
    host.options.override = step =>
      step === 'compare:config/otelcol.yaml' ? {exitCode: 1, stdout: 'DEPLOY_OVERTAKEN\n', stderr: ''} : undefined
    const error = await failure(host)

    expect(error).toBeInstanceOf(DeployOvertakenError)
    expect(host.served).toBe('open')
    expect(host.setStates()).toEqual(['open'])
    const steps = host.calls.slice(start).map(call => call.step)
    expect(steps).not.toContain('ingest-state')
    expect(steps).not.toContain('probe-ingest')
    expectNothingChanged(host, start)
  })

  it('does not touch the route when a step reports the deploy step lock busy: its own error, as before', async () => {
    const host = await openStack()
    const start = host.calls.length
    host.options.override = step =>
      step === 'compare:config/otelcol.yaml' ? {exitCode: 1, stdout: 'DEPLOY_STEP_BUSY\n', stderr: ''} : undefined
    const error = await failure(host)

    expect(error.name).toBe('DeployStepBusyError')
    expect(error.message).not.toContain('could not be compared')
    expect(host.served).toBe('open')
    expect(host.setStates()).toEqual(['open'])
    const steps = host.calls.slice(start).map(call => call.step)
    expect(steps).not.toContain('ingest-state')
    expect(steps).not.toContain('probe-ingest')
    expectNothingChanged(host, start)
  })
})

async function holdsFor(
  change: (host: FakeHost) => void,
): Promise<{host: FakeHost; result: DeployResult; after: string[]}> {
  const host = await openStack()
  change(host)
  const start = host.calls.length
  const {result} = await run(host)
  return {host, result, after: host.calls.slice(start).map(call => call.step)}
}

function holdsBeforeAnyChange(after: string[]): void {
  const held = after.indexOf('raw:set-state:held')
  expect(held).toBeGreaterThanOrEqual(0)
  const firstChange = after.findIndex(
    step => step.startsWith('write:docker') || step === 'prepare-dirs' || step === 'pull' || step.startsWith('up-'),
  )
  expect(held).toBeLessThan(firstChange)
  expect(after.indexOf('probe-ingest')).toBeGreaterThan(held)
  expect(after.indexOf('probe-ingest')).toBeLessThan(firstChange)
  expect(after.indexOf('drift-check')).toBeLessThan(held)
}

describe('the route state deploy acts on cannot go stale', () => {
  it('reads the route and writes the marker in one script, under the ingest lock, in that order', () => {
    const script = beginDeployScript(ID_A)
    const lock = script.indexOf('flock -w 30')
    const read = script.indexOf('s/^TRACES_INGEST_STATE=//p')
    const marker = script.indexOf(`mv -f "$t" ${TRACES_DEPLOY_MARKER}`)
    expect(script).toContain(TRACES_INGEST_LOCK)
    expect(script).toContain(TRACES_LOCK_BUSY_SENTINEL)
    expect(lock).toBeGreaterThan(0)
    expect(lock).toBeLessThan(read)
    expect(read).toBeLessThan(marker)
    // The previous marker is reported before it is replaced.
    expect(script.indexOf("printf 'marker=1")).toBeLessThan(marker)
    expect(script).not.toContain('/dev/null')
  })

  it('has no separate, unlocked read or marker write', async () => {
    const host = new FakeHost()
    await run(host)
    expect(host.count('host-state')).toBe(1)
    expect(host.steps).not.toContain('write:.deploy-in-progress')
    expect(host.unlockedMarker).toBe(false)
    expect(host.marker).toBeUndefined()
  })

  it('refuses an open attempted at any point after the locked script, and the route stays as it was', async () => {
    const attempts: {step: string; opened: boolean}[] = []
    const host: FakeHost = new FakeHost({
      override: step => {
        // The point the old order left open: after the state was read and before the marker was written.
        if (step.startsWith('compare:') || step === 'drift-check' || step === 'prepare-dirs') {
          attempts.push({step, opened: host.manualOpen()})
        }
        return undefined
      },
    })
    await run(host, baseEnv(withoutKey))
    expect(attempts.length).toBeGreaterThan(5)
    expect(attempts.filter(attempt => attempt.opened)).toEqual([])
    expect(host.served).toBe('off')
    // Once the deploy has finished the marker is gone and the same open succeeds.
    expect(host.manualOpen()).toBe(true)
  })

  it('refuses an open between the read and the marker on a deploy of the collector configuration alone', async () => {
    const host = await openStack()
    host.manualHold()
    let attempt: boolean | undefined
    host.options.override = step => {
      if (step === 'compare:config/otelcol.yaml') attempt = host.manualOpen()
      return undefined
    }
    const t = testDeps(host, {
      readFile: async relative => `# ${relative}${relative === 'config/otelcol.yaml' ? ' changed' : ''}\n`,
    })
    await deploy({env: baseEnv(), deps: t.deps})
    expect(attempt).toBe(false)
    // The route the deploy opened is the one its own gates allowed.
    expect(host.setStates().at(-1)).toBe('open')
  })

  it('sees an open that completed before the locked script, and holds before it recreates the collector', async () => {
    const host = new FakeHost()
    await run(host, baseEnv(withoutKey))
    expect(host.manualOpen()).toBe(true)
    const start = host.calls.length
    const t = testDeps(host, {
      readFile: async relative => `# ${relative}${relative === 'config/otelcol.yaml' ? ' changed' : ''}\n`,
    })
    const result = await deploy({env: baseEnv(), deps: t.deps})
    const after = host.calls.slice(start).map(call => call.step)
    expect(result.heldForUpdate).toBe(true)
    expect(after.indexOf('raw:set-state:held')).toBeGreaterThanOrEqual(0)
    expect(after.indexOf('raw:set-state:held')).toBeLessThan(after.indexOf('up-stale-public'))
  })

  it('reports a busy ingest lock, in the first read, as its own failure', async () => {
    const host = new FakeHost({
      override: step => (step === 'host-state' ? {exitCode: 1, stdout: 'LOCK_BUSY\n', stderr: ''} : undefined),
    })
    const error = await failure(host)
    expect(error.message).toContain('LOCK_BUSY')
    expect(host.marker).toBeUndefined()
  })

  it('keeps an on-host hold or off when it rewrites .env, whatever it planned', () => {
    const cases: {onHost: string | undefined; planned: IngestState; written: string}[] = [
      {onHost: 'held', planned: 'open', written: 'held'},
      {onHost: 'off', planned: 'open', written: 'off'},
      {onHost: 'held', planned: 'held', written: 'held'},
      {onHost: 'off', planned: 'held', written: 'off'},
      {onHost: 'open', planned: 'held', written: 'held'},
      {onHost: 'open', planned: 'off', written: 'off'},
      {onHost: 'open', planned: 'open', written: 'open'},
      {onHost: undefined, planned: 'off', written: 'off'},
      {onHost: undefined, planned: 'held', written: 'held'},
    ]
    for (const {onHost, planned, written} of cases) {
      const {root, shim, cleanup} = scratchHost()
      try {
        if (onHost !== undefined) writeFileSync(join(root, '.env'), `OLD=1\nTRACES_INGEST_STATE=${onHost}\n`)
        writeFileSync(join(root, '.deploy-in-progress'), `${ID_A} 2023-11-14T22:13:20.000Z\n`)
        const script = writeFileScript(ID_A, {path: '.env', owner: 'root:root', mode: '0600', kind: 'env'}, planned)
        const result = runLocally(script, root, shim, 'NEW=2\n')
        expect({onHost, planned, code: result.code}).toEqual({onHost, planned, code: 0})
        expect(readFileSync(join(root, '.env'), 'utf8')).toBe(`NEW=2\nTRACES_INGEST_STATE=${written}\n`)
        expect(result.out).toContain(`TRACES_ENV_STATE=${written}`)
      } finally {
        cleanup()
      }
    }
  }, 30_000)

  it('a manual hold during the deploy survives the .env rewrite, and the deploy says what the host has', async () => {
    const host: FakeHost = new FakeHost({
      override: step => {
        if (step === 'write:docker-compose.yaml') host.manualHold()
        return undefined
      },
    })
    const {result, logs} = await run(host, baseEnv(withoutKey))
    expect(host.envState).toBe('held')
    expect(host.served).toBe('held')
    expect(result.ingest).toBe('held')
    expect(logs.join('\n')).toContain('Ingest is HELD')
  })

  it('opens again from a manual hold only at its own gated open step', async () => {
    const host: FakeHost = new FakeHost({
      override: step => {
        if (step === 'write:docker-compose.yaml') host.manualHold()
        return undefined
      },
    })
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    expect(host.setStates()).toEqual(['open'])
  })
})

describe('drift between the running stack and the files', () => {
  it('a running service whose config hash differs holds the route first, then reopens it', async () => {
    const {host, result, after} = await holdsFor(current =>
      current.running.set('tempo', {running: true, hash: 'stale'}),
    )
    holdsBeforeAnyChange(after)
    expect(result.heldForUpdate).toBe(true)
    expect(result.ingest).toBe('open')
    expect(result.drifted).toEqual(['tempo'])
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
  })

  it('a stopped gated service holds the route first', async () => {
    const {result, after} = await holdsFor(current => {
      const entry = current.running.get('minio')
      current.running.set('minio', {running: false, hash: entry?.hash ?? ''})
    })
    holdsBeforeAnyChange(after)
    expect(result.drifted).toEqual(['minio'])
  })

  it('a gated service with no container holds the route first', async () => {
    const {result, after} = await holdsFor(current => current.running.delete('collector'))
    holdsBeforeAnyChange(after)
    expect(result.drifted).toEqual(['collector'])
  })

  it('Caddy running an old configuration holds the route first', async () => {
    const {result, after} = await holdsFor(current => current.running.set('caddy', {running: true, hash: 'old'}))
    holdsBeforeAnyChange(after)
    expect(result.drifted).toEqual(['caddy'])
  })

  it('an ungated service that drifted does not hold the route', async () => {
    const {result, after} = await holdsFor(current => current.running.set('grafana', {running: true, hash: 'stale'}))
    expect(after).not.toContain('raw:set-state:held')
    expect(result.heldForUpdate).toBe(false)
  })

  it('files match, hashes match and everything runs: the route is not held (the plan requires it)', async () => {
    const host = await openStack()
    const start = host.calls.length
    const {result} = await run(host)
    const after = host.calls.slice(start).map(call => call.step)
    expect(after).toContain('drift-check')
    expect(after).not.toContain('raw:set-state:held')
    expect(after).not.toContain('raw:set-state:open')
    expect(result.heldForUpdate).toBe(false)
    expect(result.drifted).toEqual([])
    expect(result.ingest).toBe('open')
    expect(host.served).toBe('open')
    // Never answered 503 to a sender: the route was not touched after it opened.
    expect(host.setStates()).toEqual(['open'])
  })

  it('cannot verify the hashes: holds (fail closed)', async () => {
    const answers: [string, RunResult][] = [
      ['a failed command', {exitCode: 1, stdout: '', stderr: 'docker: unknown command'}],
      ['no sentinel', ok('same tempo\n')],
      ['a service missing from the answer', ok('same caddy\nTRACES_DRIFT_CHECKED\n')],
      ['an unknown word', ok(`${GATED_SERVICES.map(service => `fine ${service}`).join('\n')}\nTRACES_DRIFT_CHECKED\n`)],
    ]
    for (const [label, answer] of answers) {
      const host = await openStack()
      host.options.override = step => (step === 'drift-check' ? answer : undefined)
      const {result} = await run(host)
      expect({label, held: result.heldForUpdate}).toEqual({label, held: true})
    }
  })

  it('is not asked when it cannot matter: a first deploy, a route that is not open, or a change that already holds', async () => {
    const first = new FakeHost()
    await run(first)
    expect(first.count('drift-check')).toBe(0)

    const held = await openStack()
    held.envState = 'held'
    held.served = 'held'
    const start = held.calls.length
    await run(held)
    expect(held.calls.slice(start).map(call => call.step)).not.toContain('drift-check')

    const changed = await openStack()
    const before = changed.calls.length
    await run(changed, baseEnv({TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}))
    expect(changed.calls.slice(before).map(call => call.step)).not.toContain('drift-check')
  })

  it('compares the running container with `docker compose config --hash`, for every gated service, and changes nothing', () => {
    const script = driftScript()
    for (const service of GATED_SERVICES) expect(script).toContain(service)
    expect(script).toContain('config --hash')
    expect(script).toContain('com.docker.compose.config-hash')
    expect(script).toContain('ps -a -q')
    expect(script).not.toMatch(/\bup\b|\bstart\b|\brestart\b|\bcreate\b|\brm\b/)
  })

  it('parses only a complete answer', () => {
    const complete = `${GATED_SERVICES.map(service => `same ${service}`).join('\n')}\nTRACES_DRIFT_CHECKED\n`
    expect(parseDrift(complete)).toEqual([])
    expect(parseDrift(complete.replace('same tempo', 'drift tempo hash'))).toEqual(['tempo'])
    expect(parseDrift(complete.replace('same tempo', 'drift tempo stopped'))).toEqual(['tempo'])
    expect(parseDrift(complete.replace('same tempo', 'drift tempo missing'))).toEqual(['tempo'])
    expect(parseDrift(complete.replace('same tempo\n', ''))).toBeUndefined()
    expect(parseDrift(complete.replace('TRACES_DRIFT_CHECKED\n', ''))).toBeUndefined()
    expect(parseDrift(complete.replace('same tempo', 'same stranger'))).toBeUndefined()
  })

  it('reads the ingest state without changing anything', () => {
    const script = readIngestStateScript()
    expect(script).toContain('TRACES_INGEST_STATE_READ')
    expect(script).toContain('.env')
    expect(script).not.toMatch(/\bmv\b|\brm\b|>>?\s*\S/)
  })
})

/** Runs a script with the app directory swapped for a scratch one and `docker` replaced by a shim. */
function runLocally(script: string, root: string, shim?: string, stdin?: string): {out: string; code: number} {
  const result = Bun.spawnSync(['bash', '-o', 'pipefail', '-c', script.replaceAll(TRACES_APP_DIR, root)], {
    env: {PATH: `${shim ?? ''}:${process.env.PATH ?? ''}`},
    stdin: new TextEncoder().encode(stdin ?? ''),
  })
  return {out: result.stdout.toString(), code: result.exitCode}
}

/** The host is Ubuntu (GNU coreutils). macOS `stat` has no `-c`, so a shim stands in for the one form the scripts use. */
const HAS_GNU_STAT = Bun.spawnSync(['stat', '-c', '%u', '/']).exitCode === 0

function scratchHost(): {root: string; shim: string; cleanup: () => void} {
  const root = mkdtempSync(join(tmpdir(), 'traces-script-test-'))
  const shim = join(root, 'shim')
  mkdirSync(shim)
  if (!HAS_GNU_STAT) {
    writeFileSync(
      join(shim, 'stat'),
      `#!/bin/sh\nif [ "$1" = -c ] && [ "$2" = '%u:%g %a' ]; then exec /usr/bin/stat -f '%u:%g %Lp' "$3"; fi\nexec /usr/bin/stat "$@"\n`,
    )
    chmodSync(join(shim, 'stat'), 0o755)
  }
  // `chown` to another user needs root and there is no `flock` on every machine: both are no-ops here.
  for (const name of ['chown', 'flock']) {
    writeFileSync(join(shim, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(shim, name), 0o755)
  }
  writeFileSync(
    join(shim, 'docker'),
    `#!/bin/bash
case "$1" in
compose)
  shift
  while [ "$1" != config ] && [ "$1" != ps ]; do shift; done
  if [ "$1" = config ]; then
    [ -f "${shim}/no-hash" ] && exit 1
    echo "$3 hash-$3"
  else
    [ -f "${shim}/missing-$4" ] || echo "cid-$4"
  fi ;;
inspect)
  svc="\${4#cid-}"
  case "$3" in
    *Running*) if [ -f "${shim}/stopped-$svc" ]; then echo false; else echo true; fi ;;
    *) if [ -f "${shim}/stale-$svc" ]; then echo old-hash; else echo "hash-$svc"; fi ;;
  esac ;;
esac
`,
  )
  chmodSync(join(shim, 'docker'), 0o755)
  return {root, shim, cleanup: () => rmSync(root, {recursive: true, force: true})}
}

describe('scripts run for real against a scratch app directory', () => {
  it('the drift probe reports same, hash, stopped and missing from what docker says, and fails when it cannot ask', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      const probe = (): ReturnType<typeof parseDrift> | 'failed' => {
        const result = runLocally(driftScript(), root, shim)
        return result.code === 0 ? parseDrift(result.out) : 'failed'
      }
      expect(probe()).toEqual([])

      writeFileSync(join(shim, 'stale-tempo'), '')
      writeFileSync(join(shim, 'stopped-minio'), '')
      writeFileSync(join(shim, 'missing-collector'), '')
      expect(probe()).toEqual(['collector', 'minio', 'tempo'])

      writeFileSync(join(shim, 'no-hash'), '')
      expect(probe()).toBe('failed')
    } finally {
      cleanup()
    }
  })

  it('reads the ingest state out of .env, and none when there is no .env', () => {
    const {root, cleanup} = scratchHost()
    try {
      expect(runLocally(readIngestStateScript(), root).out).toBe('ingest=none\nTRACES_INGEST_STATE_READ\n')
      writeFileSync(join(root, '.env'), 'A=1\nTRACES_INGEST_STATE=held\n')
      expect(runLocally(readIngestStateScript(), root).out).toBe('ingest=held\nTRACES_INGEST_STATE_READ\n')
      writeFileSync(join(root, '.env'), 'A=1\n')
      expect(runLocally(readIngestStateScript(), root).out).toBe('ingest=off\nTRACES_INGEST_STATE_READ\n')
    } finally {
      cleanup()
    }
  })

  it('the first read reports the previous marker and the pending restarts, then writes a new marker', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      writeFileSync(join(root, '.env'), 'TRACES_INGEST_STATE=open\n')
      const clean = runLocally(beginDeployScript(ID_A), root, shim)
      expect(parseHostState(clean.out)).toMatchObject({
        hasEnv: true,
        marker: false,
        ingest: 'open',
        pendingRestarts: [],
      })
      // The marker is there now: this deploy's id and one UTC timestamp on one line.
      expect(readFileSync(join(root, '.deploy-in-progress'), 'utf8')).toMatch(MARKER_FORMAT)
      expect(readFileSync(join(root, '.deploy-in-progress'), 'utf8').startsWith(`${ID_A} `)).toBe(true)

      // A marker a failed deploy left (here in the old, timestamp-only form) is reported and then replaced: it never refuses.
      writeFileSync(join(root, '.deploy-in-progress'), '2023-11-14T22:13:20.000Z\n')
      writeFileSync(join(root, '.pending-restarts'), 'collector\ncompose\n')
      const dirty = runLocally(beginDeployScript(ID_B), root, shim)
      expect(dirty.code).toBe(0)
      expect(parseHostState(dirty.out)).toMatchObject({marker: true, pendingRestarts: ['collector', 'compose']})
      expect(readFileSync(join(root, '.deploy-in-progress'), 'utf8')).toMatch(MARKER_FORMAT)
      expect(readFileSync(join(root, '.deploy-in-progress'), 'utf8').startsWith(`${ID_B} `)).toBe(true)
    } finally {
      cleanup()
    }
  })
})

/** A scratch host and the owner (numeric, this user's) and mode a file in it can really have. */
function compareHost(): ReturnType<typeof scratchHost> & {
  file: string
  mine: string
  compare: (
    path: string,
    kind: 'plain' | 'env',
    attrs: {owner: string; mode: string},
    stdin: string,
    shimPath?: string,
  ) => {out: string; code: number}
} {
  const host = scratchHost()
  const {uid, gid} = statSync(host.root)
  const file = join(host.root, 'config.txt')
  return {
    ...host,
    file,
    mine: `${uid}:${gid}`,
    compare: (path, kind, attrs, stdin, shimPath) =>
      runLocally(compareFileScript(path, kind, attrs), host.root, shimPath ?? host.shim, stdin),
  }
}

describe('the file comparison, run for real against a scratch app directory', () => {
  const PLAIN = {owner: 'root:root', mode: '0644'} as const

  it('says absent, different, and same, from the content', () => {
    const host = compareHost()
    try {
      const attrs = {owner: host.mine, mode: '0644'}
      expect(host.compare('config.txt', 'plain', attrs, 'a\n')).toEqual({out: 'TRACES_FILE_ABSENT\n', code: 0})
      writeFileSync(host.file, 'a\n')
      chmodSync(host.file, 0o644)
      expect(host.compare('config.txt', 'plain', attrs, 'a\n')).toEqual({out: 'TRACES_FILE_SAME\n', code: 0})
      expect(host.compare('config.txt', 'plain', attrs, 'b\n')).toEqual({out: 'TRACES_FILE_DIFFERENT\n', code: 0})
    } finally {
      host.cleanup()
    }
  })

  it('says different, not same, when the content matches and the mode does not', () => {
    const host = compareHost()
    try {
      writeFileSync(host.file, 'a\n')
      chmodSync(host.file, 0o600)
      expect(host.compare('config.txt', 'plain', {owner: host.mine, mode: '0644'}, 'a\n').out).toBe(
        'TRACES_FILE_DIFFERENT\n',
      )
      expect(host.compare('config.txt', 'plain', {owner: host.mine, mode: '0600'}, 'a\n').out).toBe(
        'TRACES_FILE_SAME\n',
      )
    } finally {
      host.cleanup()
    }
  })

  it('says different, not same, when the content matches and the owner does not', () => {
    const host = compareHost()
    try {
      writeFileSync(host.file, 'a\n')
      chmodSync(host.file, 0o644)
      const [uid = '0', gid = '0'] = host.mine.split(':')
      for (const other of [`${Number(uid) + 1}:${gid}`, `${uid}:${Number(gid) + 1}`]) {
        expect(host.compare('config.txt', 'plain', {owner: other, mode: '0644'}, 'a\n').out).toBe(
          'TRACES_FILE_DIFFERENT\n',
        )
      }
      expect(host.compare('config.txt', 'plain', {owner: host.mine, mode: '0644'}, 'a\n').out).toBe(
        'TRACES_FILE_SAME\n',
      )
    } finally {
      host.cleanup()
    }
  })

  it('reads root as 0, so a file the deploy would give to root is compared as 0:0', () => {
    const host = compareHost()
    try {
      writeFileSync(host.file, 'a\n')
      chmodSync(host.file, 0o644)
      // Run unprivileged, the file belongs to this user: it can never match root:root unless this user is root.
      const expected = host.mine === '0:0' ? 'TRACES_FILE_SAME\n' : 'TRACES_FILE_DIFFERENT\n'
      expect(host.compare('config.txt', 'plain', PLAIN, 'a\n').out).toBe(expected)
    } finally {
      host.cleanup()
    }
  })

  it('compares .env without its ingest-state line, and its owner and mode too', () => {
    const host = compareHost()
    try {
      const env = join(host.root, '.env')
      writeFileSync(env, 'A=1\nTRACES_INGEST_STATE=open\n')
      chmodSync(env, 0o600)
      const attrs = {owner: host.mine, mode: '0600'}
      expect(host.compare('.env', 'env', attrs, 'A=1\n').out).toBe('TRACES_FILE_SAME\n')
      expect(host.compare('.env', 'env', {...attrs, mode: '0640'}, 'A=1\n').out).toBe('TRACES_FILE_DIFFERENT\n')
      expect(host.compare('.env', 'env', attrs, 'A=2\n').out).toBe('TRACES_FILE_DIFFERENT\n')
    } finally {
      host.cleanup()
    }
  })

  it('writes nothing, and leaves no temporary file behind', () => {
    const host = compareHost()
    try {
      writeFileSync(host.file, 'a\n')
      chmodSync(host.file, 0o600)
      const before = statSync(host.file)
      const entries = readdirSync(host.root).sort()
      const temporaries = (): string[] => readdirSync(tmpdir()).filter(name => name.startsWith('traces-cmp.'))
      const left = temporaries()
      host.compare('config.txt', 'plain', {owner: host.mine, mode: '0644'}, 'b\n')
      host.compare('config.txt', 'plain', {owner: host.mine, mode: '0600'}, 'a\n')
      const after = statSync(host.file)
      expect([after.mtimeMs, after.size, after.mode, after.uid]).toEqual([
        before.mtimeMs,
        before.size,
        before.mode,
        before.uid,
      ])
      expect(readFileSync(host.file, 'utf8')).toBe('a\n')
      expect(readdirSync(host.root).sort()).toEqual(entries)
      expect(temporaries()).toEqual(left)
    } finally {
      host.cleanup()
    }
  })

  it('fails, printing no sentinel, when the host cannot report the owner and mode (never counts it as same)', () => {
    const host = compareHost()
    try {
      writeFileSync(host.file, 'a\n')
      chmodSync(host.file, 0o644)
      const broken = join(host.root, 'broken-shim')
      mkdirSync(broken)
      writeFileSync(join(broken, 'stat'), '#!/bin/sh\nexit 1\n')
      chmodSync(join(broken, 'stat'), 0o755)
      const answer = host.compare(
        'config.txt',
        'plain',
        {owner: host.mine, mode: '0644'},
        'a\n',
        `${broken}:${host.shim}`,
      )
      expect(answer.code).not.toBe(0)
      expect(answer.out).not.toContain('TRACES_FILE_')
    } finally {
      host.cleanup()
    }
  })
})

describe('retention', () => {
  it('asserts the TTL and the lifecycle rules after the stores are up and before Tempo and the collector start', async () => {
    const host = new FakeHost()
    const {result} = await run(host)
    expect(result.retention.altered).toEqual(['events_full', 'events_core', 'topic_facet_summaries'])
    expect(result.retention.prefixes).toEqual(['events/', 'media/'])
    expect(host.rules).toEqual([
      {Prefix: 'events/', Days: 30},
      {Prefix: 'media/', Days: 30},
    ])
    expect(host.indexOf('up-private')).toBeLessThan(host.indexOf('retention-read-ttl'))
    expect(host.indexOf('retention-add-lifecycle')).toBeLessThan(host.indexOf('up-public'))
  })

  it('makes no ALTER and adds no rule on a deploy where everything is already in place', async () => {
    const host = new FakeHost()
    await run(host)
    const calls = host.calls.length
    await run(host)
    const second = host.calls.slice(calls).map(call => call.step)
    expect(second).not.toContain('retention-apply-ttl')
    expect(second).not.toContain('retention-add-lifecycle')
  })

  it('fails the deploy when the TTL read-back differs from 30 days', async () => {
    const host = new FakeHost({alterIgnored: true})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('read-back differs from 30 days')
    expect(host.setStates()).toEqual([])
    expect(host.count('up-public')).toBe(0)
  })

  it('fails and names the table when a known trace table is missing, after waiting for migrations', async () => {
    const host = new FakeHost({tables: {events_full: undefined}})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('events_core')
    expect(host.count('retention-read-ttl')).toBe(2)
    expect(host.count('up-public')).toBe(0)
  })

  // Langfuse Topics writes an LLM summary of each trace's content into this table. Without a TTL on it the deploy does
  // not pass: it waits for the migrations, then fails and names the table.
  it('fails and names the Topics summary table when Langfuse has not created it', async () => {
    const host = new FakeHost({tables: {events_full: undefined, events_core: undefined}})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('topic_facet_summaries')
    expect(host.count('up-public')).toBe(0)
  })

  it('sets the 30-day TTL on the Topics tables that exist, counted from unit_start_time', async () => {
    const host = new FakeHost({
      tables: {
        events_full: undefined,
        events_core: undefined,
        topic_facet_summaries: undefined,
        topic_assignments: undefined,
        topic_assignments_by_trace: undefined,
      },
    })
    await run(host)
    for (const name of ['topic_facet_summaries', 'topic_assignments', 'topic_assignments_by_trace']) {
      expect({name, ttl: host.tables.get(name)}).toEqual({name, ttl: 'toDateTime(unit_start_time) + toIntervalDay(30)'})
    }
    expect(host.tables.has('topics')).toBe(false)
  })

  it('succeeds once a table that was missing appears on a retry', async () => {
    const host = new FakeHost({tables: {events_full: undefined, topic_facet_summaries: undefined}})
    const t = testDeps(host, {
      sleep: async () => {
        host.tables.set('events_core', undefined)
      },
    })
    const result = await deploy({env: baseEnv(), deps: t.deps})
    expect(result.ingest).toBe('open')
  })
})

describe('the collector image and the host', () => {
  it('fails when the digest running on the host differs from the one built', async () => {
    const host = new FakeHost({runningDigest: OTHER_DIGEST})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('does not match the built digest')
    expect(host.setStates()).toEqual([])
  })

  it('fails before pulling when the volume has too little room', async () => {
    const host = new FakeHost({freeBytes: 1024 ** 3})
    const error = await failure(host)
    expect(error.message).toContain('are free on the volume')
    expect(host.count('pull')).toBe(0)
    expect(error).not.toBeInstanceOf(AppliedButUnverifiedError)
  })

  it('carries on when the image prune fails', async () => {
    const host: FakeHost = new FakeHost({
      override: step => (step === 'prune-images' ? {exitCode: 1, stdout: '', stderr: 'busy'} : undefined),
    })
    const {result, logs} = await run(host)
    expect(result.ingest).toBe('open')
    expect(logs.join('\n')).toContain('image prune failed')
  })
})

const VOID_LINE_FORMAT = /^trc_void_[\w-]{43} void \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n$/

// The deploy rewrote a file only when its content differed. A file whose content matched but whose owner had to change (the
// reporter's secrets, when the reporter's user changed) was left as it was, and the container could not read it.
describe('a managed file whose content matches but whose owner or mode differs', () => {
  const reporterOwner = `${TEMPO_USER_ID}:${TEMPO_USER_ID} 400`
  const stepsSince = (host: FakeHost, start: number): string[] => host.calls.slice(start).map(call => call.step)

  it('is left alone when content, owner and mode all match: no write, no hold, no recreate', async () => {
    const host = await openStack()
    const start = host.calls.length
    const {result} = await run(host)
    expect(result.changed).toEqual([])
    expect(result.heldForUpdate).toBe(false)
    expect(host.setStates()).toEqual(['open'])
    expect(stepsSince(host, start).filter(step => step.startsWith('write:'))).toEqual([])
    expect(stepsSince(host, start).filter(step => step.startsWith('up-stale'))).toEqual([])
  })

  it('is rewritten, and the service that mounts it recreated, when its owner differs', async () => {
    const host = await openStack()
    host.fileAttrs.set('secrets/grafana/admin-password', '0:0 400')
    const start = host.calls.length
    const {result} = await run(host)
    expect(result.changed).toEqual(['grafana'])
    expect(stepsSince(host, start)).toContain('write:secrets/grafana/admin-password')
    expect(host.fileAttrs.get('secrets/grafana/admin-password')).toBe('472:472 400')
    const restarted = host.calls.slice(start).find(call => call.step === 'up-grafana')
    expect(restarted?.command).toContain('--force-recreate --no-deps grafana')
    expect(stepsSince(host, start)).not.toContain('up-stale-public')
    // Grafana is not gated: the open route stays open.
    expect(host.setStates()).toEqual(['open'])
  })

  it('is rewritten, and the service that mounts it recreated, when its mode differs', async () => {
    const host = await openStack()
    host.fileAttrs.set('secrets/grafana/secret-key', '472:472 644')
    const start = host.calls.length
    const {result} = await run(host)
    expect(result.changed).toEqual(['grafana'])
    expect(stepsSince(host, start)).toContain('write:secrets/grafana/secret-key')
    expect(host.fileAttrs.get('secrets/grafana/secret-key')).toBe('472:472 400')
    const restarted = host.calls.slice(start).find(call => call.step === 'up-grafana')
    expect(restarted?.command).toContain('--force-recreate --no-deps grafana')
    expect(stepsSince(host, start)).not.toContain('up-stale-public')
  })

  it("puts the reporter's two secret files under the reporter's user when an older user owns them", async () => {
    const host = await openStack()
    for (const file of ['clickhouse-password', 'minio-password']) {
      expect(host.fileAttrs.get(`secrets/reporter/${file}`)).toBe(reporterOwner)
      host.fileAttrs.set(`secrets/reporter/${file}`, '10010:10010 400')
    }
    const start = host.calls.length
    const {result} = await run(host)
    const written = stepsSince(host, start).filter(step => step.startsWith('write:secrets/reporter/'))
    expect(written.sort()).toEqual([
      'write:secrets/reporter/clickhouse-password',
      'write:secrets/reporter/minio-password',
    ])
    for (const file of ['clickhouse-password', 'minio-password']) {
      expect(host.fileAttrs.get(`secrets/reporter/${file}`)).toBe(reporterOwner)
    }
    // The reporter reads both files on every run, so they restart nothing and the route is not held for them.
    expect(result.changed).toEqual([])
    expect(host.setStates()).toEqual(['open'])
  })

  it("holds the route first when the file is a gated service's, as it does for a content change", async () => {
    const host = await openStack()
    host.fileAttrs.set('config/otelcol.yaml', '0:0 600')
    const start = host.calls.length
    const {result} = await run(host)
    expect(result.changed).toContain('collector')
    expect(result.heldForUpdate).toBe(true)
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
    const steps = stepsSince(host, start)
    expect(steps.indexOf('raw:set-state:held')).toBeLessThan(steps.indexOf('write:config/otelcol.yaml'))
    const stale = host.calls.findLast(call => call.step === 'up-stale-public')
    expect(stale?.command).toContain('--force-recreate --no-deps collector')
    expect(host.fileAttrs.get('config/otelcol.yaml')).toBe('0:0 644')
  })

  it('counts .env as changed when its mode differs', async () => {
    const host = await openStack()
    host.fileAttrs.set('.env', '0:0 644')
    const start = host.calls.length
    const {result} = await run(host)
    expect(result.changed).toContain('compose')
    expect(stepsSince(host, start)).toContain('write:.env')
    expect(host.fileAttrs.get('.env')).toBe('0:0 600')
  })

  it('is never a token file: whatever owner or mode a token file has, deploy neither compares nor rewrites it', async () => {
    const host = await openStack()
    const odd = ['1234:5678 777', '0:0 0', '65532:65532 4755']
    for (const [index, group] of SENDER_GROUPS.entries()) host.tokenAttrs.set(group, odd[index] ?? '0:0 0')
    const snapshot = JSON.stringify([...host.tokens.entries(), ...host.tokenAttrs.entries()])
    const start = host.calls.length
    await run(host)
    await run(host, baseEnv({TRACES_GRAFANA_SECRET_KEY: 'placeholder-grafana-secret-rotated'}))
    expect(JSON.stringify([...host.tokens.entries(), ...host.tokenAttrs.entries()])).toBe(snapshot)
    const touching = stepsSince(host, start).filter(
      step => (step.startsWith('compare:') || step.startsWith('write:')) && step.includes('tokens/'),
    )
    expect(touching).toEqual([])
    expect(buildSecretFiles(readInputs(baseEnv())).some(file => file.path.startsWith('tokens/'))).toBe(false)
    expect(UPLOADED_FILES.some(file => file.remote.startsWith('tokens/'))).toBe(false)
  })
})

describe('tokens', () => {
  it('creates a missing token file as deny-all: exactly one void line and no real token', async () => {
    const host = new FakeHost()
    host.tokens.set('fro-bot', 'existing-placeholder-token\n')
    const t = testDeps(host)
    await deploy({env: baseEnv(), deps: t.deps})
    expect(host.tokens.get('fro-bot')).toBe('existing-placeholder-token\n')
    for (const group of ['marcusrbrown', 'workstation']) {
      const content = host.tokens.get(group) ?? ''
      expect({group, ok: VOID_LINE_FORMAT.test(content)}).toEqual({group, ok: true})
      expect(content.split('\n').filter(line => line !== '')).toHaveLength(1)
    }
    expect(t.voidLines).toHaveLength(3)
    expect(host.writes().filter(path => path.startsWith('tokens/'))).toEqual([])
    expect(t.logs.filter(line => line.includes('created a deny-all token file'))).toHaveLength(2)
  })

  it('creates each file with a line of its own', async () => {
    const host = new FakeHost()
    await run(host)
    const lines = SENDER_GROUPS.map(group => host.tokens.get(group))
    expect(new Set(lines).size).toBe(SENDER_GROUPS.length)
  })

  it('never lets the void line reach argv, a command string or a log line, and sends it on stdin to the token step only', async () => {
    const host = new FakeHost()
    const t = testDeps(host)
    await deploy({env: baseEnv(), deps: t.deps})
    expect(t.voidLines.length).toBeGreaterThan(0)
    const argvText = host.calls.map(call => call.argv.join('\u0000')).join('\u0000')
    const commands = host.calls.map(call => call.command).join('\n')
    const logText = t.logs.join('\n')
    for (const line of t.voidLines) {
      const secret = line.split(' ')[0] ?? line
      expect({
        inArgv: argvText.includes(secret),
        inCommand: commands.includes(secret),
        inLog: logText.includes(secret),
      }).toEqual({
        inArgv: false,
        inCommand: false,
        inLog: false,
      })
    }
    for (const call of host.calls) {
      if (call.step.startsWith('token-file:')) continue
      expect({step: call.step, void: (call.stdin ?? '').includes(TRACES_VOID_TOKEN_PREFIX)}).toEqual({
        step: call.step,
        void: false,
      })
    }
    for (const group of SENDER_GROUPS) {
      const stdin = host.calls.find(call => call.step === `token-file:${group}`)?.stdin ?? ''
      expect(stdin).toMatch(VOID_LINE_FORMAT)
    }
  })

  it('leaves every token file byte-identical across repeated deploys', async () => {
    const host = new FakeHost()
    await run(host)
    host.tokens.set('marcusrbrown', 'line-one\nline-two extra\n')
    host.tokens.set('workstation', 'another-placeholder\n')
    const snapshot = JSON.stringify([...host.tokens.entries()])
    await run(host)
    await run(host, baseEnv({TRACES_GRAFANA_SECRET_KEY: 'placeholder-grafana-secret-rotated'}))
    expect(JSON.stringify([...host.tokens.entries()])).toBe(snapshot)
  })

  it('an existing empty token file fails the gate and keeps ingest closed, saying how to repair it', async () => {
    const host = new FakeHost()
    host.tokens.set('fro-bot', '')
    const error = await failure(host)
    expect(error.message).toContain('token-directories')
    expect(error.message).toContain('fro-bot')
    expect(error.message).toContain('empty')
    expect(error.message).toContain('traces sender revoke --all')
    expect(host.setStates()).toEqual([])
    // It is reported, not repaired: the file is untouched.
    expect(host.tokens.get('fro-bot')).toBe('')
  })

  it('treats a file of only whitespace as empty, as the collector does', async () => {
    const host = new FakeHost()
    host.tokens.set('workstation', '  \n\t\n')
    const error = await failure(host)
    expect(error.message).toContain('workstation')
    expect(error.message).toContain('empty')
  })

  it('accepts a deny-all file and counts only real tokens', async () => {
    const host = new FakeHost()
    host.tokens.set('marcusrbrown', `${generateVoidTokenLine()}\n`)
    host.tokens.set('fro-bot', `${generateVoidTokenLine()}\nreal-placeholder-token created 2023-11-14\n\n`)
    const {result} = await run(host)
    expect(result.ingest).toBe('open')
    const gate = result.gates.find(entry => entry.id === 'token-directories')
    expect(gate?.status).toBe('pass')
    expect(gate?.detail).toContain('marcusrbrown 0')
    expect(gate?.detail).toContain('fro-bot 1')
  })

  it('generates the void line from 32 random bytes in the contract format', () => {
    const line = generateVoidTokenLine(new Date('2023-11-14T22:13:20.000Z'), size => new Uint8Array(size).fill(255))
    expect(line).toBe(`trc_void_${'_'.repeat(42)}8 void 2023-11-14T22:13:20.000Z`)
    expect(`${generateVoidTokenLine()}\n`).toMatch(VOID_LINE_FORMAT)
    expect(generateVoidTokenLine()).not.toBe(generateVoidTokenLine())
    expect(generateVoidTokenLine().startsWith(TRACES_VOID_TOKEN_PREFIX)).toBe(true)
  })
})

describe('secrets', () => {
  it('reach the host through stdin only: no argv, no log line, and the right bytes on stdin', async () => {
    const env = baseEnv()
    const {host, logs} = await deployAndCollect(env)
    expectNoSecretOutsideStdin(env, host, logs)

    const stdin = host.calls.map(call => call.stdin ?? '').join('\n')
    for (const name of [
      'TRACES_POSTGRES_PASSWORD',
      'TRACES_CLICKHOUSE_PASSWORD',
      'TRACES_CLICKHOUSE_READER_PASSWORD',
      'TRACES_REDIS_PASSWORD',
      'TRACES_MINIO_PASSWORD',
      'TRACES_NEXTAUTH_SECRET',
      'TRACES_SALT',
      'TRACES_ENCRYPTION_KEY',
      'TRACES_GRAFANA_ADMIN_PASSWORD',
      'TRACES_GRAFANA_SECRET_KEY',
      'TRACES_LANGFUSE_USER_PASSWORD',
    ]) {
      expect({name, onStdin: stdin.includes(env[name] ?? '\u0000')}).toEqual({name, onStdin: true})
    }
    expect(Buffer.from(host.stdinFor('write:secrets/collector/langfuse-basic') ?? '', 'base64').toString('utf8')).toBe(
      'pk-lf-placeholder-app-public-11:sk-lf-placeholder-app-secret-12',
    )
  })

  it('keep the bootstrap pair off argv and out of logs too, and send it on stdin', async () => {
    const env = baseEnv({...withoutKey, ...bootstrap})
    const {host, logs} = await deployAndCollect(env)
    expectNoSecretOutsideStdin(env, host, logs)
    expect(host.stdinFor('write:.env')).toContain('sk-lf-placeholder-boot-secret')
  })

  it('keep the key pair off argv and out of logs while the bootstrap probe runs', async () => {
    const host = new FakeHost()
    await run(host, baseEnv({...withoutKey, ...bootstrap}))
    host.bootstrapKeyLive = false
    const env = baseEnv()
    const t = testDeps(host)
    await deploy({env, deps: t.deps})
    expectNoSecretOutsideStdin({...env, ...bootstrap}, host, t.logs)
    expect(host.count('bootstrap-probe')).toBe(1)
  })

  it('never reach the ssh child through its environment', async () => {
    const env = baseEnv({PATH: '/usr/bin', HOME: '/root'})
    const child = sshChildEnv(env)
    for (const secret of secretValues(env)) {
      expect(Object.values(child).join('\n')).not.toContain(secret)
    }
  })

  it('never read a sender token: the inputs hold none and the host steps never open a token file', async () => {
    const host = new FakeHost()
    await run(host, baseEnv({TRACES_SENDER_TOKEN: 'placeholder-sender-token'}))
    const everything = host.calls.map(call => `${call.command}\n${call.stdin ?? ''}`).join('\n')
    expect(everything).not.toContain('placeholder-sender-token')
    expect(everything).not.toMatch(/cat [^\n]*tokens\//)
  })
})

describe('resuming after a failed deploy', () => {
  const newImage = {TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}

  it('records the restarts before writing files, keeps them when the deploy fails, and acts on them next time', async () => {
    const host = new FakeHost()
    await run(host)

    host.options.override = step => (step === 'up-private' ? {exitCode: 1, stdout: '', stderr: 'unhealthy'} : undefined)
    const error = await failure(host, baseEnv(newImage))
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(host.pendingRestarts).toContain('compose')
    expect(host.served).toBe('held')

    // The same inputs again: every file now matches the host, but the record says the restart never happened.
    delete host.options.override
    const {result} = await run(host, baseEnv(newImage))
    expect(result.changed).toContain('compose')
    expect(result.ingest).toBe('open')
    expect(host.pendingRestarts).toEqual([])
  })

  it('clears the record only after Caddy has been restarted too', async () => {
    const host = new FakeHost()
    await run(host)
    expect(host.indexOf('remove:.pending-restarts')).toBeGreaterThan(host.indexOf('up-caddy'))
    expect(host.indexOf('remove:.pending-restarts')).toBeLessThan(host.indexOf('token-dirs'))

    const failing = new FakeHost({
      override: step => (step === 'up-caddy' ? {exitCode: 1, stdout: '', stderr: 'bad'} : undefined),
    })
    await failure(failing)
    expect(failing.pendingRestarts).not.toEqual([])
  })

  it('holds a route that is open when a pending restart is found, even though every file matches', async () => {
    const host = new FakeHost()
    await run(host)
    host.pendingRestarts = ['collector']
    const calls = host.calls.length
    await run(host)
    expect(host.calls.slice(calls).map(call => call.step)).toContain('raw:set-state:held')
  })
})

// ─── Overlapping deploys: the newest one owns the host ───────────────────────

interface Latch {
  promise: Promise<void>
  open: () => void
}

function latch(): Latch {
  let open: () => void = () => {}
  const promise = new Promise<void>(done => {
    open = done
  })
  return {promise, open}
}

interface Overlap {
  /** What deploy A failed with. */
  aError: Error
  aSteps: string[]
  /** Lets deploy B carry on from where it paused (right after its first host script) and returns its result. */
  finishB: () => Promise<DeployResult>
}

/**
 * Two real deploys against one simulated host. Deploy A runs; the first time `startB` says so about one of A's
 * commands, deploy B starts and runs through its first host script (the one that takes the marker). Then A's
 * command carries on. B waits there (or, with `bFinishesFirst`, runs to its end) until the test lets it go.
 */
async function overlap(
  host: FakeHost,
  startB: (step: string, command: string, stdin: string | undefined) => boolean,
  options: {bFinishesFirst?: boolean} = {},
): Promise<Overlap> {
  const aSteps: string[] = []
  const began = latch()
  const release = latch()
  let b: Promise<DeployResult> | undefined

  const depsB = testDeps(host, {
    deployId: () => ID_B,
    run: async (argv, runOptions) => {
      const answer = await host.run(argv, runOptions)
      if (stepOf(argv.at(-1) ?? '') === 'host-state') {
        began.open()
        if (options.bFinishesFirst !== true) await release.promise
      }
      return answer
    },
  })
  const depsA = testDeps(host, {
    deployId: () => ID_A,
    run: async (argv, runOptions) => {
      const command = argv.at(-1) ?? ''
      const step = stepOf(command)
      aSteps.push(step)
      if (b === undefined && startB(step, command, runOptions?.stdin)) {
        b = deploy({env: baseEnv(), deps: depsB.deps})
        await began.promise
        if (options.bFinishesFirst === true) await b
      }
      return host.run(argv, runOptions)
    },
  })

  let aError: Error | undefined
  try {
    await deploy({env: baseEnv(), deps: depsA.deps})
  } catch (error) {
    aError = error instanceof Error ? error : new Error(String(error))
  }
  if (aError === undefined) throw new Error('deploy A was expected to be overtaken and it succeeded')
  return {
    aError,
    aSteps,
    finishB: async () => {
      release.open()
      if (b === undefined) throw new Error('deploy B never started')
      return b
    },
  }
}

/** Everything deploy A ran after the given step, apart from closing the ssh connection. */
function afterStep(o: Overlap, step: string): string[] {
  return o.aSteps.slice(o.aSteps.indexOf(step) + 1).filter(entry => entry !== 'unknown')
}

const isOpenAttempt = (step: string, _command: string, stdin: string | undefined): boolean =>
  step === 'raw:set-state' && (stdin ?? '').includes('TRACES_INGEST_STATE=open')

describe('overlapping deploys: the newest one owns the host', () => {
  it('names the deploy in the marker: its random id, then the UTC timestamp, on one line', async () => {
    let seen: string | undefined
    const host: FakeHost = new FakeHost({
      override: step => {
        if (step === 'pull') seen = host.marker
        return undefined
      },
    })
    await run(host, baseEnv(), {deployId: () => ID_A})
    expect(seen).toBe(`${ID_A} ${new Date(host.clock * 1000).toISOString()}\n`)
    expect(seen).toMatch(MARKER_FORMAT)
  })

  it('generates 16 random bytes as hex for each deploy, and refuses an id it cannot put in a script', async () => {
    expect(generateDeployId(() => new Uint8Array(16).fill(0xab))).toBe('ab'.repeat(16))
    expect(generateDeployId()).toMatch(/^[\da-f]{32}$/)
    expect(generateDeployId()).not.toBe(generateDeployId())

    const first = new FakeHost({override: failAt('pull')})
    await failure(first)
    const second = new FakeHost({override: failAt('pull')})
    await failure(second)
    expect(first.markerOwner()).toMatch(/^[\da-f]{32}$/)
    expect(first.markerOwner()).not.toBe(second.markerOwner())

    for (const bad of ['', 'short', 'A1'.repeat(16), `${ID_A}; id`, 'a1'.repeat(65)]) {
      const host = new FakeHost()
      await expect(run(host, baseEnv(), {deployId: () => bad})).rejects.toThrow('deploy id')
      expect(nonSshSteps(host)).toEqual([])
    }
  })

  it('a single deploy is unaffected: it opens, removes its own marker, and is never refused', async () => {
    const host = new FakeHost()
    const {result} = await run(host, baseEnv(), {deployId: () => ID_A})
    expect(result.ingest).toBe('open')
    expect(host.served).toBe('open')
    expect(host.marker).toBeUndefined()
    expect(host.refused).toEqual([])
    expect(host.unguarded).toEqual([])
  })

  it("a failed deploy's leftover marker never blocks the next deploy: it overwrites it, opens and removes it", async () => {
    const host = new FakeHost({override: failAt('pull')})
    await failure(host, baseEnv(), {deployId: () => ID_A})
    expect(host.markerOwner()).toBe(ID_A)
    delete host.options.override
    const {result} = await run(host, baseEnv(), {deployId: () => ID_B})
    expect(result.ingest).toBe('open')
    expect(host.marker).toBeUndefined()
    expect(host.refused).toEqual([])
  })

  it('refuses the overtaken deploy at its next mutating step, with the sentinel, and it changes nothing', async () => {
    const host = new FakeHost()
    const o = await overlap(host, step => step === 'prepare-dirs')
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    expect(o.aError.message).toContain(
      'ther deploy started on this host and took over; this one stopped without opening',
    )
    expect(host.refused).toEqual(['prepare-dirs'])
    expect(host.markerOwner()).toBe(ID_B)
    // It never opened, held, probed, read the route again or removed the marker, and wrote nothing.
    expect(afterStep(o, 'prepare-dirs')).toEqual([])
    expect(host.setStates()).toEqual([])
    expect(host.writes()).toEqual([])
    expect(host.served).toBe('none')

    // The newest deploy then carries on, opens (its gates pass) and removes the marker.
    const result = await o.finishB()
    expect(result.ingest).toBe('open')
    expect(host.setStates()).toEqual(['open'])
    expect(host.served).toBe('open')
    expect(host.marker).toBeUndefined()
    expect(host.refused).toEqual(['prepare-dirs'])
    expect(host.unguarded).toEqual([])
  })

  it('overtaken just before its canary: the canary is not run, and the newest deploy still finishes and opens', async () => {
    const host = new FakeHost()
    const o = await overlap(host, (_step, command) => command.includes('--canary-once'))
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    expect(host.refused).toEqual(['reporter-canary'])
    expect(host.canaryRuns).toBe(0)
    expect(host.setStates()).toEqual([])
    expect(host.markerOwner()).toBe(ID_B)

    const result = await o.finishB()
    expect(result.ingest).toBe('open')
    expect(host.canaryRuns).toBe(1)
    expect(host.setStates()).toEqual(['open'])
    expect(host.marker).toBeUndefined()
    expect(host.unguarded).toEqual([])
  })

  it('overtaken exactly at its open step: the route is not opened, and the newest deploy opens it', async () => {
    const host = new FakeHost()
    const o = await overlap(host, isOpenAttempt)
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    expect(o.aError.message).toContain('stopped without opening ingest')
    expect(host.refused).toEqual(['raw:set-state'])
    expect(host.served).toBe('off')
    expect(host.envState).toBe('off')
    expect(host.setStates()).toEqual([])
    expect(host.markerOwner()).toBe(ID_B)
    expect(afterStep(o, 'raw:set-state')).toEqual([])

    const result = await o.finishB()
    expect(result.ingest).toBe('open')
    expect(host.setStates()).toEqual(['open'])
    expect(host.marker).toBeUndefined()
  })

  it("overtaken just before it removes the marker: it leaves the newest deploy's marker, and says it had opened", async () => {
    const host = new FakeHost()
    const o = await overlap(host, step => step === 'remove:.deploy-in-progress')
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    expect(o.aError.message).toContain('stopped after it had opened ingest')
    expect(host.refused).toEqual(['remove:.deploy-in-progress'])
    expect(host.markerOwner()).toBe(ID_B)
    expect(afterStep(o, 'remove:.deploy-in-progress')).toEqual([])

    // B met an open route and a marker it did not write: it holds, updates, and opens when its gates pass.
    const result = await o.finishB()
    expect(result.ingest).toBe('open')
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
    expect(host.marker).toBeUndefined()
  })

  it('a deploy that finished first leaves no marker behind, and the older one is refused too', async () => {
    const host = new FakeHost()
    const o = await overlap(host, step => step === 'pull', {bFinishesFirst: true})
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    expect(host.refused).toEqual(['pull'])
    expect(host.marker).toBeUndefined()
    expect(host.setStates()).toEqual(['open'])
    expect(host.served).toBe('open')
    expect(afterStep(o, 'pull')).toEqual([])
    expect((await o.finishB()).ingest).toBe('open')
  })

  it('does not hold, probe, read the route or touch the marker after it is overtaken, even on an open route', async () => {
    const host = await openStack()
    const o = await overlap(host, step => step === 'prepare-dirs')
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    // The route A found open is still open: it belongs to the newest deploy now.
    expect(host.served).toBe('open')
    expect(host.setStates()).toEqual(['open'])
    expect(afterStep(o, 'prepare-dirs')).toEqual([])
    expect(host.markerOwner()).toBe(ID_B)

    const result = await o.finishB()
    expect(host.setStates()).toEqual(['open', 'held', 'open'])
    expect(result.heldForUpdate).toBe(true)
    expect(host.marker).toBeUndefined()
  })

  it('a failing deploy that finds out it was overtaken while it closes the route leaves the route alone', async () => {
    const host = await openStack()
    host.options.override = failAt('prepare-dirs')
    // Deploy B begins just as A starts to close the route after its failure.
    const o = await overlap(host, step => step === 'ingest-state')
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    expect(o.aError.message).toContain('prepare-dirs failed')
    expect(host.refused).toEqual(['raw:set-state'])
    expect(host.served).toBe('open')
    expect(host.setStates()).toEqual(['open'])
    expect(host.markerOwner()).toBe(ID_B)

    delete host.options.override
    expect((await o.finishB()).ingest).toBe('open')
    expect(host.marker).toBeUndefined()
  })

  it('does not swallow being overtaken at the image prune, a step whose own failure is tolerated', async () => {
    const host = new FakeHost()
    const o = await overlap(host, step => step === 'prune-images')
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    expect(host.refused).toEqual(['prune-images'])
    expect(afterStep(o, 'prune-images')).toEqual([])
    await o.finishB()
  })

  it('every step a deploy makes that changes the host carries the check, across first, update, resume and failure paths', async () => {
    const host = new FakeHost()
    await run(host, baseEnv({...withoutKey, ...bootstrap}))
    // The operator deletes the bootstrap key in the Langfuse UI, supplies the Application key and opens ingest.
    host.bootstrapKeyLive = false
    await run(host)
    // Every uploaded file changes too: the stores and the public services are recreated.
    await run(host, baseEnv({TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}), {
      readFile: async relative => `# ${relative} v2\n`,
    })
    host.options.override = failAt('up-public')
    await failure(
      host,
      baseEnv({TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${PLACEHOLDER_DIGEST}`}),
    )

    expect(host.unguarded).toEqual([])
    expect(host.refused).toEqual([])
    const changing = new Set(host.steps.filter(step => !isReadOnlyStep(step)))
    for (const expected of [
      'prepare-dirs',
      'token-file:fro-bot',
      'write:docker-compose.yaml',
      'write:.env',
      'write:.pending-restarts',
      'remove:.pending-restarts',
      'write:secrets/bootstrap-pending',
      'remove:secrets/bootstrap-pending',
      'prune-images',
      'pull',
      'create-collector',
      'queue-volume',
      'create-prometheus',
      'prometheus-volume',
      'create-embedder',
      'embedder-volume',
      'up-private',
      'up-stale-private',
      'up-public',
      'up-reporter',
      'up-caddy',
      'retention-apply-ttl',
      'retention-add-lifecycle',
      'raw:set-state:open',
      'raw:set-state:held',
      'remove:.deploy-in-progress',
    ]) {
      expect({expected, ran: changing.has(expected)}).toEqual({expected, ran: true})
    }
  })
})

// ─── The ownership check in every script that changes the host ────────────────

const SENDER_GROUP = SENDER_GROUPS[0]
const PLAIN_FILE = {path: 'secrets/grafana/admin-password', owner: '472:472', mode: '0400', kind: 'plain'} as const
const ENV_FILE = {path: '.env', owner: 'root:root', mode: '0600', kind: 'env'} as const

/** Every script builder that changes the host, by export name, with the scripts each can emit. */
const MUTATING_SCRIPTS: Record<string, string[]> = {
  prepareDirsScript: [prepareDirsScript(ID_A)],
  tokenFileScript: SENDER_GROUPS.map(group => tokenFileScript(group, ID_A)),
  writeFileScript: [writeFileScript(ID_A, PLAIN_FILE), writeFileScript(ID_A, ENV_FILE, 'held')],
  removeOwnFileScript: ['.pending-restarts', 'secrets/bootstrap-pending'].map(path => removeOwnFileScript(ID_A, path)),
  pruneScript: [pruneScript(ID_A)],
  pullScript: [pullScript(ID_A), pullScript(ID_A, 'pull-grafana', ['grafana'])],
  upScript: [upScript(ID_A, 'up-private', ['postgres', 'redis']), upScript(ID_A, 'up-x', ['collector'], {force: true})],
  createCollectorScript: [createCollectorScript(ID_A)],
  queueVolumeScript: [queueVolumeScript(ID_A)],
  createPrometheusScript: [createPrometheusScript(ID_A)],
  prometheusVolumeScript: [prometheusVolumeScript(ID_A)],
  createEmbedderScript: [createEmbedderScript(ID_A)],
  embedderVolumeScript: [embedderVolumeScript(ID_A)],
  canaryScript: [canaryScript(ID_A)],
  setIngestStateCommand: (['off', 'held', 'open'] as const).map(state => setIngestStateCommand(state, ID_A)),
  applyTtlScript: [applyTtlScript(ownershipPrelude(ID_A))],
  addLifecycleScript: OBJECT_STORE_PREFIXES.map(prefix => addLifecycleScript(prefix, ownershipPrelude(ID_A))),
}

/** Builders that change nothing on the host (a probe, a comparison against stdin, a read). */
const READ_ONLY_SCRIPTS: readonly string[] = [
  'compareFileScript',
  'tokenDirsScript',
  'readIngestStateScript',
  'driftScript',
  'probeIngestScript',
  'diskScript',
  'runningDigestScript',
  'bootstrapProbeScript',
  'hygieneScript',
  'grafanaSignInScript',
  'grafanaAlertingScript',
  'readTtlScript',
  'readLifecycleScript',
]

/** The builders that take ownership instead of checking it. */
const TAKEOVER_SCRIPTS: readonly string[] = ['beginDeployScript']

/** What a script can do to the host. Each of these must come after the check. */
const CHANGES = [
  /\bmktemp\b/,
  /\binstall\b/,
  /\bchown\b/,
  /\bchmod\b/,
  /\bmv\b/,
  /\brm\b/,
  /\bln\b/,
  /\bdocker\b/,
  /\bexec -T\b/,
  /\bcat > /,
  /\bprintf [^\n]*> /,
]

describe('the ownership check: a script that changes the host cannot lack it', () => {
  const prelude = ownershipPrelude(ID_A)

  it('refuses a deploy id that is not hex, and a marker path that is not safe', () => {
    expect(() => ownershipPrelude('abc')).toThrow('deploy id')
    expect(() => ownershipPrelude(`${ID_A}'; id #`)).toThrow('deploy id')
    expect(() => ownershipPrelude(ID_A, '/mnt/../etc/x')).toThrow('marker')
  })

  it('compares the marker with this deploy and prints the sentinel and exits non-zero otherwise', () => {
    expect(prelude).toContain(`[ -f ${TRACES_DEPLOY_MARKER} ]`)
    expect(prelude).toContain(`read -r traces_owner traces_rest < ${TRACES_DEPLOY_MARKER}`)
    expect(prelude).toContain(`[ "$traces_owner" = ${ID_A} ]`)
    expect(prelude).toContain(`echo ${DEPLOY_OVERTAKEN_SENTINEL}; exit 1`)
    expect(prelude).not.toContain('/dev/null')
    expect(prelude.split('\n')).toHaveLength(1)
  })

  it('classifies every script builder the deploy and retention modules export', () => {
    const exported = [...Object.entries(deployModule), ...Object.entries(retentionModule)]
      .filter(([name, value]) => typeof value === 'function' && /(?:Script|Command)$/.test(name))
      .map(([name]) => name)
    const known = new Set([...Object.keys(MUTATING_SCRIPTS), ...READ_ONLY_SCRIPTS, ...TAKEOVER_SCRIPTS])
    // A new builder fails here until someone decides whether it changes the host, and gives it the prelude if it does.
    expect(exported.filter(name => !known.has(name))).toEqual([])
    expect([...known].filter(name => !exported.includes(name))).toEqual([])
  })

  it('puts the check in every script that changes the host, before anything it changes', () => {
    for (const [builder, scripts] of Object.entries(MUTATING_SCRIPTS)) {
      expect({builder, scripts: scripts.length > 0}).toEqual({builder, scripts: true})
      for (const script of scripts) {
        const at = script.indexOf(prelude)
        expect({builder, has: at !== -1}).toEqual({builder, has: true})
        const rest = script.replace(prelude, '')
        expect({builder, once: rest.includes(prelude)}).toEqual({builder, once: false})
        for (const change of CHANGES) {
          const found = change.exec(script.slice(0, at))
          expect({builder, change: change.source, before: found?.[0]}).toEqual({
            builder,
            change: change.source,
            before: undefined,
          })
        }
      }
    }
  })

  it('checks, under the step lock, before it takes the ingest lock and acts, when it changes the route or removes the marker', () => {
    // Lock order is the step lock (inside the prelude), then the ingest lock. The step lock keeps the check true until
    // the script ends: nobody can take the host over while it is held, so there is no gap between check and act.
    const open = setIngestStateCommand('open', ID_A)
    expect(open.indexOf(prelude)).toBeGreaterThan(0)
    expect(open.indexOf(prelude)).toBeLessThan(open.indexOf('flock -w 30'))
    expect(open.indexOf('flock -w 30')).toBeLessThan(open.indexOf('mktemp'))
    expect(open.indexOf('flock -w 30')).toBeLessThan(open.indexOf('--force-recreate'))

    const env = writeFileScript(ID_A, ENV_FILE, 'held')
    expect(env.indexOf(prelude)).toBeLessThan(env.indexOf('flock -w 30'))
    expect(env.indexOf('flock -w 30')).toBeLessThan(env.indexOf('mktemp'))

    const remove = removeOwnFileScript(ID_A, '.deploy-in-progress')
    expect(remove).toContain(prelude)
    expect(remove.indexOf(prelude)).toBeLessThan(remove.indexOf('flock -w 30'))
    expect(remove.indexOf('flock -w 30')).toBeLessThan(remove.indexOf('rm -f'))
    expect(remove).toContain(TRACES_LOCK_BUSY_SENTINEL)
  })

  it('keeps the retention scripts free of ownership knowledge unless the deploy hands them the check', () => {
    expect(applyTtlScript()).not.toContain('traces_owner')
    expect(addLifecycleScript('events/')).not.toContain('traces_owner')
    expect(applyTtlScript(prelude)).toContain(prelude)
    expect(addLifecycleScript('events/', prelude)).toContain(prelude)
  })
})

describe('the ownership check, run for real against a scratch app directory', () => {
  const marker = (root: string): string => join(root, '.deploy-in-progress')
  const stamp = '2023-11-14T22:13:20.000Z'

  it('lets the owner write, and refuses everyone else without writing anything', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      const script = writeFileScript(ID_A, {path: 'out.txt', owner: 'root:root', mode: '0600', kind: 'plain'})
      const attempt = (): {out: string; code: number} => runLocally(script, root, shim, 'content\n')

      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      expect(attempt()).toEqual({out: 'TRACES_FILE_WRITTEN\n', code: 0})
      expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('content\n')
      rmSync(join(root, 'out.txt'))

      const refused: [string, () => void][] = [
        ['another deploy', () => writeFileSync(marker(root), `${ID_B} ${stamp}\n`)],
        ['no marker', () => rmSync(marker(root))],
        ['an empty marker', () => writeFileSync(marker(root), '')],
        ['a marker with no id', () => writeFileSync(marker(root), `${stamp}\n`)],
        ['an id that only starts the same', () => writeFileSync(marker(root), `${ID_A}0 ${stamp}\n`)],
        ['an id that only ends the same', () => writeFileSync(marker(root), `0${ID_A} ${stamp}\n`)],
        ['the id on a later line', () => writeFileSync(marker(root), `x\n${ID_A} ${stamp}\n`)],
      ]
      for (const [label, arrange] of refused) {
        arrange()
        expect({label, ...attempt()}).toEqual({label, out: 'DEPLOY_OVERTAKEN\n', code: 1})
        expect({
          label,
          files: readdirSync(root).filter(name => name === 'out.txt' || name.startsWith('.traces-tmp')),
        }).toEqual({
          label,
          files: [],
        })
      }
    } finally {
      cleanup()
    }
  })

  it('rewrites .env only for the owner', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      writeFileSync(join(root, '.env'), 'OLD=1\nTRACES_INGEST_STATE=held\n')
      const script = writeFileScript(ID_A, ENV_FILE, 'open')
      writeFileSync(marker(root), `${ID_B} ${stamp}\n`)
      expect(runLocally(script, root, shim, 'NEW=2\n')).toEqual({out: 'DEPLOY_OVERTAKEN\n', code: 1})
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('OLD=1\nTRACES_INGEST_STATE=held\n')
      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      expect(runLocally(script, root, shim, 'NEW=2\n').code).toBe(0)
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('NEW=2\nTRACES_INGEST_STATE=held\n')
    } finally {
      cleanup()
    }
  })

  it('removes the marker only when it still holds this deploy (compare and delete), and refuses when it is gone', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      const script = removeOwnFileScript(ID_A, '.deploy-in-progress')

      writeFileSync(marker(root), `${ID_B} ${stamp}\n`)
      expect(runLocally(script, root, shim)).toEqual({out: 'DEPLOY_OVERTAKEN\n', code: 1})
      expect(readFileSync(marker(root), 'utf8')).toBe(`${ID_B} ${stamp}\n`)

      rmSync(marker(root))
      expect(runLocally(script, root, shim)).toEqual({out: 'DEPLOY_OVERTAKEN\n', code: 1})

      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      expect(runLocally(script, root, shim)).toEqual({out: 'TRACES_REMOVED\n', code: 0})
      expect(readdirSync(root)).not.toContain('.deploy-in-progress')
    } finally {
      cleanup()
    }
  })

  it('does not touch the pending-restart record or the bootstrap record for a deploy that was overtaken', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      mkdirSync(join(root, 'secrets'))
      writeFileSync(join(root, '.pending-restarts'), 'collector\n')
      writeFileSync(join(root, 'secrets', 'bootstrap-pending'), 'pk:sk')
      writeFileSync(marker(root), `${ID_B} ${stamp}\n`)
      for (const path of ['.pending-restarts', 'secrets/bootstrap-pending']) {
        expect(runLocally(removeOwnFileScript(ID_A, path), root, shim)).toEqual({out: 'DEPLOY_OVERTAKEN\n', code: 1})
      }
      expect(readFileSync(join(root, '.pending-restarts'), 'utf8')).toBe('collector\n')
      expect(readFileSync(join(root, 'secrets', 'bootstrap-pending'), 'utf8')).toBe('pk:sk')
    } finally {
      cleanup()
    }
  })

  it('changes the route only for the owner: an overtaken open writes no state and recreates nothing', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      // A docker that records every call, replacing the drift shim.
      writeFileSync(join(shim, 'docker'), `#!/bin/sh\necho "$@" >> ${join(root, 'docker.log')}\nexit 0\n`)
      chmodSync(join(shim, 'docker'), 0o755)
      writeFileSync(join(root, '.env'), 'A=1\nTRACES_INGEST_STATE=off\n')
      const command = setIngestStateCommand('open', ID_A)

      writeFileSync(marker(root), `${ID_B} ${stamp}\n`)
      const refused = runLocally(command, root, shim, 'TRACES_INGEST_STATE=open\n')
      expect(refused).toEqual({out: 'DEPLOY_OVERTAKEN\n', code: 1})
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('A=1\nTRACES_INGEST_STATE=off\n')
      expect(readdirSync(root)).not.toContain('docker.log')
      expect(readdirSync(root).filter(name => name.startsWith('.env.'))).toEqual([])

      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      const opened = runLocally(command, root, shim, 'TRACES_INGEST_STATE=open\n')
      expect(opened).toEqual({out: 'TRACES_INGEST_STATE_SET=open\n', code: 0})
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('A=1\nTRACES_INGEST_STATE=open\n')
      expect(readFileSync(join(root, 'docker.log'), 'utf8')).toContain('--force-recreate --no-deps caddy')
    } finally {
      cleanup()
    }
  })

  it('creates a token file only for the owner', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      mkdirSync(join(root, 'tokens', SENDER_GROUP), {recursive: true})
      const run = (): {out: string; code: number} => {
        const result = Bun.spawnSync(['bash', '-o', 'pipefail', '-c', tokenFileScript(SENDER_GROUP, ID_A, root)], {
          env: {PATH: `${shim}:${process.env.PATH ?? ''}`},
          stdin: new TextEncoder().encode(`${generateVoidTokenLine()}\n`),
        })
        return {out: result.stdout.toString(), code: result.exitCode}
      }
      writeFileSync(marker(root), `${ID_B} ${stamp}\n`)
      expect(run()).toEqual({out: 'DEPLOY_OVERTAKEN\n', code: 1})
      expect(readdirSync(join(root, 'tokens', SENDER_GROUP))).toEqual([])
      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      expect(run()).toEqual({out: 'TRACES_TOKEN_CREATED\n', code: 0})
    } finally {
      cleanup()
    }
  })

  it('writes the deploy id and a timestamp into the marker as the first thing it takes from the host', () => {
    const {root, shim, cleanup} = scratchHost()
    try {
      writeFileSync(join(root, '.env'), 'TRACES_INGEST_STATE=open\n')
      writeFileSync(marker(root), `${ID_B} ${stamp}\n`)
      const taken = runLocally(beginDeployScript(ID_A), root, shim)
      // The previous deploy's marker is reported, then replaced by this deploy's own.
      expect(parseHostState(taken.out)).toMatchObject({marker: true, ingest: 'open'})
      expect(readFileSync(marker(root), 'utf8')).toMatch(MARKER_FORMAT)
      expect(readFileSync(marker(root), 'utf8').startsWith(`${ID_A} `)).toBe(true)
    } finally {
      cleanup()
    }
  })
})

// ─── The step lock: nothing of an older deploy runs once a newer one owns the host ────────────────────────────────

type Settled = {ok: true; result: DeployResult} | {ok: false; error: Error}

async function settled(promise: Promise<{result: DeployResult}>): Promise<Settled> {
  try {
    return {ok: true, result: (await promise).result}
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error : new Error(String(error))}
  }
}

/** Lets every pending microtask and the next timer run: whatever can progress has progressed. */
async function quiesce(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Deploy A passes the ownership check of one mutating step (`pauseAt`) and stays in flight inside it, holding the step
 * lock. Deploy B then starts, and everything that can progress is let progress.
 */
async function startWhileStepInFlight(pauseAt: string): Promise<{
  host: FakeHost
  a: Promise<Settled>
  b: Promise<Settled>
  finishStep: () => void
}> {
  const reached = latch()
  const release = latch()
  let paused = false
  const host = new FakeHost({
    inFlight: step => {
      if (step !== pauseAt || paused) return undefined
      paused = true
      reached.open()
      return release.promise
    },
  })
  const a = settled(run(host, baseEnv(), {deployId: () => ID_A}))
  await reached.promise
  const b = settled(run(host, baseEnv(), {deployId: () => ID_B}))
  await quiesce()
  return {host, a, b, finishStep: release.open}
}

describe('the step lock: a takeover waits for the older deploy’s step that is in flight', () => {
  it('B cannot take the host, run gates or open ingest while A is inside a step; when the step ends B takes over and A is refused', async () => {
    const {host, a, b, finishStep} = await startWhileStepInFlight('up-public')

    // A passed its check and is inside `up-public` (it can restart the collector). B asked to take over and waits.
    expect(host.stepLockHolder).toBe('up-public')
    expect(host.waitingForStepLock).toEqual(['host-state'])
    expect(host.markerOwner()).toBe(ID_A)
    expect(host.events.some(event => event.startsWith('marker:') && event !== `marker:${ID_A}`)).toBe(false)
    expect(host.setStates()).toEqual([])
    expect(host.served).not.toBe('open')
    // Everything the host has been asked since A entered the step is B's storage probe and its takeover, which waits.
    expect(host.steps.slice(host.steps.lastIndexOf('up-public') + 1)).toEqual(['storage-probe', 'host-state'])

    finishStep()
    const [resultA, resultB] = await Promise.all([a, b])

    // The takeover happened after A's step had finished, and A's next step was refused.
    expect(host.events.indexOf('done:up-public')).toBeGreaterThan(-1)
    expect(host.events.indexOf(`marker:${ID_B}`)).toBeGreaterThan(host.events.indexOf('done:up-public'))
    expect(resultA.ok).toBe(false)
    if (!resultA.ok) expect(resultA.error).toBeInstanceOf(DeployOvertakenError)
    expect(host.refused).toEqual(['up-reporter'])

    // B owned the host from its takeover on: it ran its gates and opened, and nothing of A ran after it began.
    expect(resultB.ok).toBe(true)
    if (resultB.ok) expect(resultB.result.ingest).toBe('open')
    expect(host.setStates()).toEqual(['open'])
    expect(host.served).toBe('open')
    expect(host.marker).toBeUndefined()
    expect(host.unlocked).toEqual([])
    expect(host.stepLockHolder).toBeUndefined()
    expect(host.waitingForStepLock).toEqual([])
  })

  it('a takeover that cannot get the lock in time fails cleanly: the marker is still A’s, nothing changed, and it says why', async () => {
    const {host, a, b, finishStep} = await startWhileStepInFlight('up-public')

    // Just inside the bound it is still waiting; at the bound it gives up.
    host.elapse(899)
    await quiesce()
    expect(host.waitingForStepLock).toEqual(['host-state'])
    host.elapse(1)
    const resultB = await b

    expect(resultB.ok).toBe(false)
    if (!resultB.ok) {
      expect(resultB.error.message).toMatch(/another deploy/i)
      expect(resultB.error.message).toContain('still running')
      expect(resultB.error.message).toContain('15 minutes')
      expect(resultB.error.message).toContain('Nothing was changed')
      expect(resultB.error.message).toContain('Retry')
    }
    expect(host.events).toContain('busy:host-state')
    expect(host.markerOwner()).toBe(ID_A)
    expect(host.waitingForStepLock).toEqual([])
    // B asked the host two things (the storage probe and the takeover) and changed nothing, held nothing, opened nothing.
    const afterA = host.steps.slice(host.steps.lastIndexOf('up-public') + 1).filter(step => step !== 'ssh-exit')
    expect(afterA).toEqual(['storage-probe', 'host-state'])
    expect(host.setStates()).toEqual([])

    // A is unaffected: it finishes its step and the rest of its deploy, and opens.
    finishStep()
    const resultA = await a
    expect(resultA.ok).toBe(true)
    if (resultA.ok) expect(resultA.result.ingest).toBe('open')
    expect(host.refused).toEqual([])
    expect(host.marker).toBeUndefined()
  })

  it('a single deploy is unaffected: every step that changes the host takes the lock, never waits, and releases it', async () => {
    const host = new FakeHost()
    const {result} = await run(host, baseEnv(), {deployId: () => ID_A})
    expect(result.ingest).toBe('open')
    expect(host.refused).toEqual([])
    expect(host.unguarded).toEqual([])
    expect(host.unlocked).toEqual([])
    expect(host.events.some(event => event.startsWith('busy:'))).toBe(false)
    expect(host.stepLockHolder).toBeUndefined()
    // One lock per step that changes the host, plus the takeover; each released.
    const mutating = host.steps.filter(step => step !== 'ssh-exit' && !isReadOnlyStep(step)).length
    expect(host.events.filter(event => event.startsWith('lock:'))).toHaveLength(mutating + 1)
    expect(host.events.filter(event => event.startsWith('done:'))).toHaveLength(mutating + 1)
    // The takeover is the first thing that takes it.
    expect(host.events[0]).toBe('lock:host-state')
  })

  it('an ordinary step that cannot get the lock fails with its own message, and the deploy closes the route as for any failure', async () => {
    const host = new FakeHost({
      override: step => (step === 'pull' ? {exitCode: 1, stdout: 'DEPLOY_STEP_BUSY\n', stderr: ''} : undefined),
    })
    const error = await failure(host, baseEnv(), {deployId: () => ID_A})
    expect(error.name).toBe('DeployStepBusyError')
    expect(error.message).toContain('could not start')
    expect(error.message).toContain('60 seconds')
    expect(error.message).toContain('taking over')
    // Not the takeover's message: this deploy owned the host when it asked.
    expect(error.message).not.toContain('Retry when')
    expect(host.markerOwner()).toBe(ID_A)
    expect(host.setStates()).toEqual([])
  })

  it('the canary holds the step lock from its check to the end of the exec, so a takeover waits for it', async () => {
    const {host, a, b, finishStep} = await startWhileStepInFlight('reporter-canary')

    expect(host.stepLockHolder).toBe('reporter-canary')
    expect(host.waitingForStepLock).toEqual(['host-state'])
    expect(host.markerOwner()).toBe(ID_A)
    expect(host.canaryRuns).toBe(0)

    finishStep()
    const [resultA, resultB] = await Promise.all([a, b])
    expect(host.events.indexOf(`marker:${ID_B}`)).toBeGreaterThan(host.events.indexOf('done:reporter-canary'))
    expect(resultA.ok).toBe(false)
    if (!resultA.ok) expect(resultA.error).toBeInstanceOf(DeployOvertakenError)
    expect(resultB.ok).toBe(true)
    expect(host.unlocked).toEqual([])
    expect(host.stepLockHolder).toBeUndefined()
  })

  it('a canary that cannot get the step lock fails with the step-busy error, runs nothing and opens nothing', async () => {
    const host = new FakeHost({
      override: step =>
        step === 'reporter-canary' ? {exitCode: 1, stdout: 'DEPLOY_STEP_BUSY\n', stderr: ''} : undefined,
    })
    const error = await failure(host, baseEnv(), {deployId: () => ID_A})
    // The canary runs after the files are applied, so the failure is reported as applied but unverified.
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('could not start')
    expect(error.message).toContain('60 seconds')
    expect(host.canaryRuns).toBe(0)
    expect(host.setStates()).toEqual([])
    expect(host.markerOwner()).toBe(ID_A)
  })

  it('a deploy refused as overtaken has already released the lock: the newer deploy is not kept waiting by it', async () => {
    const host = new FakeHost()
    const o = await overlap(host, step => step === 'prepare-dirs')
    expect(o.aError).toBeInstanceOf(DeployOvertakenError)
    expect(host.stepLockHolder).toBeUndefined()
    await o.finishB()
    expect(host.stepLockHolder).toBeUndefined()
  })
})

describe('the step lock in the script text', () => {
  const stepLock = `exec 8>>${TRACES_DEPLOY_STEP_LOCK}`
  const waitOf = (script: string): number => Number(/flock -w (\d+) 8/.exec(script)?.[1])
  const markerCheck = `[ -f ${TRACES_DEPLOY_MARKER} ]`
  const ingestLock = 'flock -w 30 9'

  const readOnly: Record<string, string> = {
    compareFileScript: compareFileScript('config/otelcol.yaml', 'plain', {owner: 'root:root', mode: '0644'}),
    tokenDirsScript: tokenDirsScript(),
    readIngestStateScript: readIngestStateScript(),
    driftScript: driftScript(),
    probeIngestScript: probeIngestScript('traces.fro.bot'),
    diskScript: diskScript(),
    runningDigestScript: runningDigestScript('collector'),
    bootstrapProbeScript: bootstrapProbeScript(),
    hygieneScript: hygieneScript(),
    grafanaSignInScript: grafanaSignInScript(),
    readTtlScript: retentionModule.readTtlScript(),
    readLifecycleScript: retentionModule.readLifecycleScript(),
  }

  const bothLocks: Record<string, string> = {
    begin: beginDeployScript(ID_A),
    setState: setIngestStateCommand('open', ID_A),
    writeEnv: writeFileScript(ID_A, ENV_FILE, 'held'),
    removeMarker: removeOwnFileScript(ID_A, '.deploy-in-progress'),
  }

  it('every script that changes the host takes it on descriptor 8 before its ownership check, and the ownership check is inside the prelude', () => {
    for (const [builder, scripts] of Object.entries(MUTATING_SCRIPTS)) {
      for (const script of scripts) {
        const lock = script.indexOf(stepLock)
        const check = script.indexOf(markerCheck)
        expect({builder, lock: lock !== -1, before: lock < check}).toEqual({builder, lock: true, before: true})
        expect({builder, prelude: script.includes(ownershipPrelude(ID_A))}).toEqual({builder, prelude: true})
        expect({builder, busy: script.includes('DEPLOY_STEP_BUSY')}).toEqual({builder, busy: true})
      }
    }
    expect(ownershipPrelude(ID_A)).toContain(stepLock)
    expect(ownershipPrelude(ID_A).split('\n')).toHaveLength(1)
  })

  it('takes the step lock before the ingest lock in every script that takes both, never the reverse', () => {
    for (const [name, script] of Object.entries(bothLocks)) {
      expect({name, step: script.includes(stepLock), ingest: script.includes(ingestLock)}).toEqual({
        name,
        step: true,
        ingest: true,
      })
      expect({name, order: script.indexOf(stepLock) < script.indexOf(ingestLock)}).toEqual({name, order: true})
      // One lock per descriptor: the ingest lock stays on 9.
      expect({name, ingestFd: script.includes(`exec 9>>${TRACES_INGEST_LOCK}`) || script.includes('exec 9>>')}).toEqual(
        {
          name,
          ingestFd: true,
        },
      )
    }
    expect(TRACES_DEPLOY_STEP_LOCK).not.toBe(TRACES_INGEST_LOCK)
  })

  it('the takeover takes the step lock before it takes the ingest lock and before it writes the marker, and waits longer than an ordinary step', () => {
    const begin = bothLocks.begin ?? ''
    expect(begin.indexOf(stepLock)).toBeGreaterThan(-1)
    expect(begin.indexOf(stepLock)).toBeLessThan(begin.indexOf(ingestLock))
    expect(begin.indexOf(stepLock)).toBeLessThan(begin.indexOf(`mv -f "$t" ${TRACES_DEPLOY_MARKER}`))
    // It takes the host; it never checks ownership, so it never refuses.
    expect(begin).not.toContain(DEPLOY_OVERTAKEN_SENTINEL)
    expect(begin).not.toContain('traces_owner')
    // 15 minutes for the takeover (a step can be an image pull or a service start); one minute for an ordinary step,
    // which only ever contends with a takeover, and that is brief.
    expect(waitOf(begin)).toBe(900)
    expect(waitOf(ownershipPrelude(ID_A))).toBe(60)
    expect(waitOf(pullScript(ID_A))).toBe(60)
  })

  it('read-only probes take neither lock', () => {
    for (const [name, script] of Object.entries(readOnly)) {
      expect({name, flock: script.includes('flock')}).toEqual({name, flock: false})
      expect({name, lock: script.includes('.lock')}).toEqual({name, lock: false})
    }
  })

  it('holds the ingest lock only around the state read and write and the Caddy recreate, so a manual hold never waits on a long step', () => {
    for (const [name, script] of Object.entries(bothLocks)) {
      expect({name, long: /\bpull\b|\btimeout\b|--wait|image prune|\bsleep\b/.test(script)}).toEqual({
        name,
        long: false,
      })
    }
    // The step-lock holders with long steps (a pull, a start) do not take the ingest lock at all.
    for (const script of [pullScript(ID_A), pruneScript(ID_A), upScript(ID_A, 'up-x', ['collector'], {force: true})]) {
      expect(script).not.toContain(ingestLock)
    }
  })

  it('the manual ingest commands in the CLI never take the step lock', () => {
    const remote = readFileSync(join(APP, '..', '..', 'packages/cli/src/commands/traces/remote.ts'), 'utf8')
    expect(remote).not.toContain('deploy-step')
    expect(remote).not.toContain('exec 8>>')
    expect(remote).toContain('flock -w 30 9')
  })
})

/** The scratch host with the no-op `flock` replaced by a real one. */
function lockedHost(): ReturnType<typeof scratchHost> {
  const host = scratchHost()
  rmSync(join(host.shim, 'flock'), {force: true})
  expect(installFlockStandIn(host.shim)).toBe(true)
  return host
}

/** A process that holds the step lock until `release` is called. Resolves when it holds it. */
async function holdStepLock(root: string, shim: string): Promise<{release: () => Promise<void>}> {
  const holder = Bun.spawn(
    [
      'bash',
      '-c',
      // `exec sleep`: the descriptor lives in the one process that is killed on release, so nothing outlives it.
      `exec 8>>${join(root, '.deploy-step.lock')}; flock -w 10 8 || exit 3; echo held; exec sleep 60`,
    ],
    {env: {PATH: `${shim}:${process.env.PATH ?? ''}`}, stdout: 'pipe', stderr: 'pipe'},
  )
  const first = await holder.stdout.getReader().read()
  expect(new TextDecoder().decode(first.value)).toContain('held')
  return {
    release: async () => {
      holder.kill()
      await holder.exited
    },
  }
}

function start(script: string, root: string, shim: string, stdin = ''): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(['bash', '-o', 'pipefail', '-c', script.replaceAll(TRACES_APP_DIR, root)], {
    env: {PATH: `${shim}:${process.env.PATH ?? ''}`},
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function outcome(child: ReturnType<typeof Bun.spawn>): Promise<{out: string; code: number}> {
  const out = await new Response(child.stdout as ReadableStream).text()
  return {out, code: await child.exited}
}

describe.skipIf(!CAN_LOCK)('the step lock, run for real against a scratch directory', () => {
  const stamp = '2023-11-14T22:13:20.000Z'
  const marker = (root: string): string => join(root, '.deploy-in-progress')
  const impatient = (script: string): string => script.replace(/flock -w \d+ 8/, 'flock -w 1 8')

  it('the takeover waits while the step lock is held and, with a short bound, fails with the sentinel and leaves the marker untouched', async () => {
    const {root, shim, cleanup} = lockedHost()
    try {
      writeFileSync(join(root, '.env'), 'A=1\nTRACES_INGEST_STATE=open\n')
      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      const holder = await holdStepLock(root, shim)

      const refused = await outcome(start(impatient(beginDeployScript(ID_B)), root, shim))
      expect(refused).toEqual({out: 'DEPLOY_STEP_BUSY\n', code: 1})
      expect(readFileSync(marker(root), 'utf8')).toBe(`${ID_A} ${stamp}\n`)
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('A=1\nTRACES_INGEST_STATE=open\n')
      expect(readdirSync(root).filter(name => name.startsWith('.traces-tmp'))).toEqual([])

      // Released, the same takeover proceeds and takes the host.
      await holder.release()
      const taken = await outcome(start(impatient(beginDeployScript(ID_B)), root, shim))
      expect(taken.code).toBe(0)
      expect(parseHostState(taken.out)).toMatchObject({hasEnv: true, ingest: 'open'})
      expect(readFileSync(marker(root), 'utf8').startsWith(`${ID_B} `)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('the takeover does not complete until the step that holds the lock ends, and then takes the host', async () => {
    const {root, shim, cleanup} = lockedHost()
    try {
      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      const holder = await holdStepLock(root, shim)

      const takeover = start(beginDeployScript(ID_B), root, shim)
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(takeover.exitCode).toBeNull()
      expect(readFileSync(marker(root), 'utf8')).toBe(`${ID_A} ${stamp}\n`)

      await holder.release()
      const taken = await outcome(takeover)
      expect(taken.code).toBe(0)
      expect(readFileSync(marker(root), 'utf8').startsWith(`${ID_B} `)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('an ordinary step waits for the lock too, and with a short bound changes nothing and says so', async () => {
    const {root, shim, cleanup} = lockedHost()
    try {
      const script = writeFileScript(ID_A, {path: 'out.txt', owner: 'root:root', mode: '0600', kind: 'plain'})
      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      const holder = await holdStepLock(root, shim)

      const refused = await outcome(start(impatient(script), root, shim, 'content\n'))
      expect(refused).toEqual({out: 'DEPLOY_STEP_BUSY\n', code: 1})
      expect(readdirSync(root).filter(name => name === 'out.txt' || name.startsWith('.traces-tmp'))).toEqual([])

      await holder.release()
      expect(await outcome(start(impatient(script), root, shim, 'content\n'))).toEqual({
        out: 'TRACES_FILE_WRITTEN\n',
        code: 0,
      })
      expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('content\n')
    } finally {
      cleanup()
    }
  })

  it('a step that passed its check holds the lock to the end of its shell: the takeover cannot slip in between check and finish', async () => {
    const {root, shim, cleanup} = lockedHost()
    try {
      writeFileSync(marker(root), `${ID_A} ${stamp}\n`)
      // A step of deploy A: its real prelude (lock, then check), then a slow body.
      const slowStep = `${ownershipPrelude(ID_A)}\nsleep 1.5\necho STEP_DONE`
      const stepA = start(slowStep, root, shim)
      await new Promise(resolve => setTimeout(resolve, 400))

      const takeover = start(beginDeployScript(ID_B), root, shim)
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(takeover.exitCode).toBeNull()
      expect(readFileSync(marker(root), 'utf8')).toBe(`${ID_A} ${stamp}\n`)

      expect((await outcome(stepA)).out).toBe('STEP_DONE\n')
      expect((await outcome(takeover)).code).toBe(0)
      expect(readFileSync(marker(root), 'utf8').startsWith(`${ID_B} `)).toBe(true)
    } finally {
      cleanup()
    }
  })
})
