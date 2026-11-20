import type {RunResult} from '../server/provision'
import type {DeployDeps, DeployResult, GateInputs} from './deploy'

import {Buffer} from 'node:buffer'
import {chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {describe, expect, it} from 'bun:test'
import {
  AppliedButUnverifiedError,
  bootstrapProbeScript,
  buildEnvFile,
  buildSecretFiles,
  closeMasterArgv,
  compareFileScript,
  createCollectorScript,
  deploy,
  diskScript,
  driftScript,
  evaluateGates,
  failedSafetyGates,
  GATED_SERVICES,
  hostStateScript,
  hygieneScript,
  langfuseBasicValue,
  mayOpen,
  parseDrift,
  parseHostState,
  parseIngestProbe,
  parseReporterDetail,
  prepareDirsScript,
  probeIngestScript,
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
import {baseEnv, FakeHost, OTHER_DIGEST, PLACEHOLDER_DIGEST, secretValues, testDeps} from './deploy.fixture'
import {PATHS} from './health-report'
import {
  SENDER_GROUPS,
  TRACES_APP_DIR,
  TRACES_DEPLOY_MARKER,
  TRACES_INGEST_LOCK,
  TRACES_LOCK_BUSY_SENTINEL,
  TRACES_PENDING_RESTARTS,
} from './host'

const ok = (stdout: string): RunResult => ({exitCode: 0, stdout, stderr: ''})

const HERE = new URL('.', import.meta.url).pathname
const APP = join(HERE, '..')

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
      'TRACES_LANGFUSE_USER_EMAIL',
      'TRACES_LANGFUSE_USER_PASSWORD',
    ]) {
      expect(() => readInputs(baseEnv({[name]: undefined}))).toThrow()
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
    expect(byPath['secrets/reporter/clickhouse-password']).toMatchObject({owner: '10010:10010', mode: '0400'})
    expect(byPath['secrets/reporter/minio-password']).toMatchObject({owner: '10010:10010', mode: '0400'})
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
    expect([...locals.filter(local => local.startsWith('config/'))].sort()).toEqual([...found].sort())
    expect(locals).toContain('docker-compose.yaml')
    expect(UPLOADED_FILES.find(file => file.local === 'src/health-report.ts')?.remote).toBe(
      'health-reporter/health-report.ts',
    )
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

  it('gates the collector, the backends and Caddy, and not Grafana or the reporter', () => {
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
    hostState: hostStateScript(),
    drift: driftScript(),
    ingestState: readIngestStateScript(),
    removeMarker: removeOwnFileScript('.deploy-in-progress'),
    writeMarker: writeFileScript({path: '.deploy-in-progress', owner: 'root:root', mode: '0644', kind: 'plain'}),
    prepareDirs: prepareDirsScript(),
    tokenDirs: tokenDirsScript(),
    comparePlain: compareFileScript('config/otelcol.yaml', 'plain'),
    compareEnv: compareFileScript('.env', 'env'),
    writePlain: writeFileScript({
      path: 'secrets/grafana/admin-password',
      owner: '472:472',
      mode: '0400',
      kind: 'plain',
    }),
    writeEnv: writeFileScript({path: '.env', owner: 'root:root', mode: '0600', kind: 'env'}, 'held'),
    removeRestarts: removeOwnFileScript('.pending-restarts'),
    removePending: removeOwnFileScript('secrets/bootstrap-pending'),
    probeIngest: probeIngestScript('traces.fro.bot'),
    disk: diskScript(),
    prune: pruneScript(),
    pull: pullScript(),
    upPrivate: upScript('up-private', ['postgres', 'redis']),
    upForced: upScript('up-stale', ['collector'], {force: true}),
    create: createCollectorScript(),
    queue: queueVolumeScript(),
    digest: runningDigestScript('collector'),
    bootstrap: bootstrapProbeScript(),
    hygiene: hygieneScript(),
    ...Object.fromEntries(SENDER_GROUPS.map(group => [`token-${group}`, tokenFileScript(group)])),
  }

  it('parse as bash', () => {
    for (const [name, script] of Object.entries({...scripts, setState: setIngestStateCommand('held')})) {
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
    const everything = {...scripts, setState: setIngestStateCommand('held'), detail: REPORTER_DETAIL_COMMAND}
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
    expect(() => upScript('up-x', ['not-a-service'])).toThrow('Unknown service')
    expect(() => upScript('up-x', [])).toThrow('at least one service')
    expect(() => runningDigestScript('nope' as never)).toThrow('Unknown service')
    expect(() => tokenFileScript('stranger' as never)).toThrow('Unknown sender group')
    expect(() => probeIngestScript('bad domain; id')).toThrow('Unsafe domain')
    expect(() => writeFileScript({path: 'a/../b', owner: 'root:root', mode: '0600', kind: 'plain'})).toThrow('Unsafe')
    expect(() => writeFileScript({path: 'x', owner: 'root:root; id', mode: '0600', kind: 'plain'})).toThrow('owner')
    expect(() => writeFileScript({path: 'x', owner: 'root:root', mode: '600', kind: 'plain'})).toThrow('mode')
    expect(() => writeFileScript({path: '.env', owner: 'root:root', mode: '0600', kind: 'env'})).toThrow('ingest state')
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
    expect(scripts.writeEnv).toContain(String.raw`printf 'TRACES_INGEST_STATE=%s\n' held >> "$t"`)
  })

  it('compares and prints nothing but a sentinel for a secret file', () => {
    expect(scripts.comparePlain).not.toMatch(/cat [^>]/)
    expect(scripts.comparePlain).toContain('cmp -s')
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

  it('set the queue volume owner only under the Docker data root, and read it back', () => {
    const script = scripts.queue ?? ''
    expect(script).toContain('/mnt/traces/docker/volumes/*/_data')
    expect(script).toContain('chown 65532:65532')
    expect(script).toContain("stat -c '%u:%g'")
  })

  it('creates token files under noclobber and never writes, truncates or removes an existing one', () => {
    for (const group of SENDER_GROUPS) {
      const script = scripts[`token-${group}`] ?? ''
      expect(script).toContain('set -C')
      expect(script).not.toMatch(/\brm\b/)
      expect(script).not.toMatch(/\bmv\b/)
      expect(script).not.toMatch(/\btruncate\b/)
      expect(script).not.toMatch(/\btee\b/)
      expect(script).toContain('chown root:65532')
      expect(script).toContain('chmod 0640')
      // The only redirection that writes is the guarded, noclobber one.
      const writes = script.split('\n').filter(line => /(?:^|[^>])>\s*"?\$f/.test(line) || />>/.test(line))
      expect(writes).toEqual(['if (set -C; : > "$f"); then'])
    }
  })

  it('leaves token files alone when it runs for real: byte-identical, and an empty file is created only when absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'traces-token-test-'))
    try {
      const shim = join(root, 'shim')
      mkdirSync(shim)
      // `chown` to another user needs root. The shim makes it a no-op so the real script runs unprivileged.
      writeFileSync(join(shim, 'chown'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(shim, 'chown'), 0o755)

      for (const group of SENDER_GROUPS) mkdirSync(join(root, 'tokens', group), {recursive: true})
      const existing = join(root, 'tokens', 'fro-bot', 'token')
      const bytes = Buffer.from('first-placeholder-token\nsecond-placeholder-token extra column\n')
      writeFileSync(existing, bytes)
      chmodSync(existing, 0o600)
      const empty = join(root, 'tokens', 'workstation', 'token')
      writeFileSync(empty, '')

      const runScript = (group: (typeof SENDER_GROUPS)[number]): {out: string; code: number} => {
        const result = Bun.spawnSync(['bash', '-o', 'pipefail', '-c', tokenFileScript(group, root)], {
          env: {PATH: `${shim}:${process.env.PATH ?? ''}`},
        })
        return {out: result.stdout.toString().trim(), code: result.exitCode}
      }

      const before = statSync(existing)
      expect(runScript('fro-bot')).toEqual({out: 'TRACES_TOKEN_PRESENT', code: 0})
      expect(readFileSync(existing).equals(bytes)).toBe(true)
      const afterStat = statSync(existing)
      expect([afterStat.mtimeMs, afterStat.size, afterStat.mode]).toEqual([before.mtimeMs, before.size, before.mode])

      expect(runScript('workstation')).toEqual({out: 'TRACES_TOKEN_PRESENT', code: 0})
      expect(readFileSync(empty).length).toBe(0)

      expect(runScript('marcusrbrown')).toEqual({out: 'TRACES_TOKEN_CREATED', code: 0})
      expect(readFileSync(join(root, 'tokens', 'marcusrbrown', 'token')).length).toBe(0)
      // A second run is a no-op.
      expect(runScript('marcusrbrown')).toEqual({out: 'TRACES_TOKEN_PRESENT', code: 0})

      // Something that is not a regular file in its place is an error, never "created".
      rmSync(join(root, 'tokens', 'marcusrbrown', 'token'))
      mkdirSync(join(root, 'tokens', 'marcusrbrown', 'token'))
      expect(runScript('marcusrbrown').code).not.toBe(0)
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  })

  it('uses the same on-host mechanism as `traces ingest` and `traces status`', () => {
    const remote = readFileSync(join(APP, '..', '..', 'packages/cli/src/commands/traces/remote.ts'), 'utf8')
    const command = setIngestStateCommand('held')
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
})

// ─── Gates ────────────────────────────────────────────────────────────────────

describe('gates', () => {
  const detail = new FakeHost().reporterDetail()
  const passing = (): GateInputs => ({
    keyPairSet: true,
    ingestVariableTrue: true,
    retentionDetail: 'retention ok',
    tokenFiles: {marcusrbrown: true, 'fro-bot': true, workstation: true},
    verdict: {
      state: 'fresh',
      detail: parseReporterDetail(ok(`${JSON.stringify(detail)}\nTRACES_DETAIL_END\n`)) as never,
    },
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
      [
        'token-directories',
        input => ({...input, tokenFiles: {marcusrbrown: true, 'fro-bot': false, workstation: true}}),
      ],
      ['token-directories', input => ({...input, tokenFiles: undefined})],
      ['reporter-verdict', input => ({...input, verdict: {state: 'unreadable'}})],
      ['reporter-verdict', input => ({...input, verdict: {state: 'timeout', detail: undefined}})],
      ['canary', input => ({...input, verdict: {state: 'unreadable'}})],
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

  it('fails the reporter verdict when it is stale, has not run or is not ok, and the canary when one check fails', () => {
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
    const checks = (detail.checks as {id: string; status: string; detail: string}[]).map(check =>
      check.id === 'canary-langfuse' ? {...check, status: 'fail', detail: 'canary trace not found in Langfuse'} : check,
    )
    const gates = evaluateGates(mutate({checks, ok: true}))
    expect(gates.find(gate => gate.id === 'canary')).toMatchObject({status: 'fail'})
    expect(gates.find(gate => gate.id === 'canary')?.detail).toContain('canary-langfuse')
  })

  it('skips everything that needs a delivering stack when there is no key pair, and counts a skip as not open', () => {
    const gates = evaluateGates({...passing(), keyPairSet: false, verdict: {state: 'skipped'}})
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

  it('runs in the order the plan fixes: volume, host state, compare, dirs, files, pull, stores, retention, backends, reporter, caddy, gates', async () => {
    const host = new FakeHost()
    await run(host)
    const order = [
      'storage-probe',
      'host-state',
      'compare:docker-compose.yaml',
      'write:.deploy-in-progress',
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
      'bootstrap-hygiene',
      'raw:set-state:open',
      'remove:.deploy-in-progress',
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

  it('does not accept a verdict older than the restart', async () => {
    const host = new FakeHost({verdictOffset: -5})
    const error = await failure(host)
    expect(error).toBeInstanceOf(AppliedButUnverifiedError)
    expect(error.message).toContain('no fresh reporter verdict')
    expect(host.setStates()).toEqual([])
    expect(host.served).toBe('off')
  })

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
    const stale = host.calls.find(call => call.step === 'up-stale-public')
    expect(stale?.command).toContain('--force-recreate --no-deps grafana')
    expect(host.count('up-stale-private')).toBe(0)
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
    // Only the deploy marker was written: nothing about the stack changed.
    expect(host.writes().slice(writesBefore)).toEqual(['.deploy-in-progress'])
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

const MARKER_FORMAT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n$/

/** An override that fails one step when it is reached (something going wrong after the first change). */
function failAt(step: string): (current: string) => RunResult | undefined {
  return current => (current === step ? {exitCode: 1, stdout: '', stderr: `${step} failed`} : undefined)
}

describe('host contract', () => {
  it('keeps the four paths in host.ts and uses them', () => {
    expect(TRACES_DEPLOY_MARKER).toBe(`${TRACES_APP_DIR}/.deploy-in-progress`)
    expect(TRACES_PENDING_RESTARTS).toBe(`${TRACES_APP_DIR}/.pending-restarts`)
    expect(hostStateScript()).toContain(TRACES_DEPLOY_MARKER)
    expect(hostStateScript()).toContain(TRACES_PENDING_RESTARTS)
    expect(removeOwnFileScript('.deploy-in-progress')).toContain(TRACES_DEPLOY_MARKER)
    expect(removeOwnFileScript('.pending-restarts')).toContain(TRACES_PENDING_RESTARTS)
    expect(() => removeOwnFileScript('.env' as never)).toThrow('not a file this deploy owns')
  })

  it('runs every ingest state change under flock on the ingest lock, and says LOCK_BUSY when it cannot take it', () => {
    for (const state of ['off', 'held', 'open'] as const) {
      const command = setIngestStateCommand(state)
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
  it('is written after the storage check and the host state, before the first change, and removed last', async () => {
    const host = new FakeHost()
    await run(host)
    const steps = nonSshSteps(host)
    expect(host.indexOf('write:.deploy-in-progress')).toBeGreaterThan(host.indexOf('storage-probe'))
    expect(host.indexOf('write:.deploy-in-progress')).toBeGreaterThan(host.indexOf('host-state'))
    expect(host.indexOf('write:.deploy-in-progress')).toBeLessThan(host.indexOf('prepare-dirs'))
    expect(host.indexOf('write:.deploy-in-progress')).toBeLessThan(host.indexOf('write:docker-compose.yaml'))
    expect(steps.at(-1)).toBe('remove:.deploy-in-progress')
    expect(host.marker).toBeUndefined()
  })

  it('is written before the hold, which is already a change to the host', async () => {
    const host = await openStack()
    const start = host.calls.length
    await run(host, baseEnv({TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${OTHER_DIGEST}`}))
    const after = host.calls.slice(start).map(call => call.step)
    expect(after.indexOf('write:.deploy-in-progress')).toBeGreaterThanOrEqual(0)
    expect(after.indexOf('write:.deploy-in-progress')).toBeLessThan(after.indexOf('raw:set-state:held'))
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
    expect(host.steps.at(-2)).toBe('remove:.deploy-in-progress')
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
function runLocally(script: string, root: string, shim?: string): {out: string; code: number} {
  const result = Bun.spawnSync(['bash', '-o', 'pipefail', '-c', script.replaceAll(TRACES_APP_DIR, root)], {
    env: {PATH: `${shim ?? ''}:${process.env.PATH ?? ''}`},
  })
  return {out: result.stdout.toString(), code: result.exitCode}
}

function scratchHost(): {root: string; shim: string; cleanup: () => void} {
  const root = mkdtempSync(join(tmpdir(), 'traces-script-test-'))
  const shim = join(root, 'shim')
  mkdirSync(shim)
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

  it('the host-state probe reports the marker and the pending restarts from the contract paths', () => {
    const {root, cleanup} = scratchHost()
    try {
      writeFileSync(join(root, '.env'), 'TRACES_INGEST_STATE=open\n')
      const clean = parseHostState(runLocally(hostStateScript(), root).out)
      expect(clean).toMatchObject({hasEnv: true, marker: false, ingest: 'open', pendingRestarts: []})

      writeFileSync(join(root, '.deploy-in-progress'), '2023-11-14T22:13:20.000Z\n')
      writeFileSync(join(root, '.pending-restarts'), 'collector\ncompose\n')
      const dirty = parseHostState(runLocally(hostStateScript(), root).out)
      expect(dirty).toMatchObject({marker: true, pendingRestarts: ['collector', 'compose']})
    } finally {
      cleanup()
    }
  })
})

describe('retention', () => {
  it('asserts the TTL and the lifecycle rules after the stores are up and before Tempo and the collector start', async () => {
    const host = new FakeHost()
    const {result} = await run(host)
    expect(result.retention.altered).toEqual(['events_full', 'events_core'])
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

  it('succeeds once a table that was missing appears on a retry', async () => {
    const host = new FakeHost({tables: {events_full: undefined}})
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

describe('tokens', () => {
  it('creates empty token files only where they are absent and never writes inside tokens/', async () => {
    const host = new FakeHost()
    host.tokens.set('fro-bot', 'existing-placeholder-token\n')
    const {logs} = await run(host)
    expect(host.tokens.get('fro-bot')).toBe('existing-placeholder-token\n')
    expect(host.tokens.get('marcusrbrown')).toBe('')
    expect(host.tokens.get('workstation')).toBe('')
    expect(host.writes().filter(path => path.startsWith('tokens/'))).toEqual([])
    expect(logs.filter(line => line.includes('created an empty token file'))).toHaveLength(2)
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
