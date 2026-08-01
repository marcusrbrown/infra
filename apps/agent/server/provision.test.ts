import {describe, expect, it} from 'bun:test'

import {
  createIamClientFromEnv,
  ensureGitHubOidcProvider,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  performProvisioning,
  type IAMClientLike,
} from './provision'

interface CommandShape {
  constructor: {name: string}
  input: Record<string, unknown>
}

interface FakeCall {
  name: string
  input: Record<string, unknown>
}

type CommandHandler = (command: CommandShape, calls: FakeCall[]) => Promise<unknown>

function makeClient(handler: CommandHandler): {client: IAMClientLike; calls: FakeCall[]} {
  const calls: FakeCall[] = []
  const send = async (command: CommandShape): Promise<unknown> => {
    calls.push({name: command.constructor.name, input: command.input})
    return handler(command, calls)
  }

  return {
    client: {send: send as unknown as IAMClientLike['send']},
    calls,
  }
}

function providerDetails(arn: string, clientIds: string[] = [GITHUB_OIDC_AUDIENCE]): Record<string, unknown> {
  return {
    Url: GITHUB_OIDC_PROVIDER_URL,
    ClientIDList: clientIds,
    ThumbprintList: ['bounded-fixture-thumbprint'],
    CreateDate: new Date('2026-08-01T00:00:00.000Z'),
    Arn: arn,
  }
}

function listResponse(...arns: string[]): Record<string, unknown> {
  return {
    OpenIDConnectProviderList: arns.map(Arn => ({Arn})),
  }
}

describe('GitHub OIDC provider provisioning', () => {
  it('creates the provider with the canonical URL and STS audience when absent', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse()
      if (command.constructor.name === 'CreateOpenIDConnectProviderCommand') {
        return {OpenIDConnectProviderArn: providerArn}
      }
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    const result = await ensureGitHubOidcProvider(client)

    expect(result).toEqual({classification: 'absent', changed: true, providerArn})
    const create = calls.find(call => call.name === 'CreateOpenIDConnectProviderCommand')
    expect(create?.input).toEqual({
      Url: GITHUB_OIDC_PROVIDER_URL,
      ClientIDList: [GITHUB_OIDC_AUDIENCE],
    })
  })

  it('does not mutate a provider that already has the STS audience', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    const result = await ensureGitHubOidcProvider(client)

    expect(result).toEqual({classification: 'current', changed: false, providerArn})
    expect(calls.map(call => call.name)).toEqual([
      'ListOpenIDConnectProvidersCommand',
      'GetOpenIDConnectProviderCommand',
      'GetOpenIDConnectProviderCommand',
    ])
  })

  it('appends the STS audience without recreating or changing thumbprints', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    let getCount = 0
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') {
        getCount += 1
        return providerDetails(
          providerArn,
          getCount === 1 ? ['other-audience'] : ['other-audience', GITHUB_OIDC_AUDIENCE],
        )
      }
      if (command.constructor.name === 'AddClientIDToOpenIDConnectProviderCommand') return {}
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    const result = await ensureGitHubOidcProvider(client)

    expect(result).toEqual({classification: 'current', changed: true, providerArn})
    expect(calls.find(call => call.name === 'AddClientIDToOpenIDConnectProviderCommand')?.input).toEqual({
      OpenIDConnectProviderArn: providerArn,
      ClientID: GITHUB_OIDC_AUDIENCE,
    })
    expect(calls.some(call => call.name === 'CreateOpenIDConnectProviderCommand')).toBe(false)
    expect(calls.some(call => call.name === 'UpdateOpenIDConnectProviderThumbprintCommand')).toBe(false)
  })

  it('halts when more than one canonical GitHub provider is present', async () => {
    const firstArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com-1'
    const secondArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com-2'
    const {client} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(firstArn, secondArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') {
        return providerDetails(command.input.OpenIDConnectProviderArn === firstArn ? firstArn : secondArn)
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    await expect(ensureGitHubOidcProvider(client)).rejects.toThrow(/multiple.*GitHub OIDC providers/i)
  })

  it('halts on URL drift for an ARN that claims the canonical GitHub provider', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') {
        return {
          ...providerDetails(providerArn),
          Url: 'https://malicious.example.invalid',
        }
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    await expect(ensureGitHubOidcProvider(client)).rejects.toThrow(/URL drifted/i)
    expect(calls.some(call => call.name === 'CreateOpenIDConnectProviderCommand')).toBe(false)
  })

  it('confirms the canonical provider after an EntityAlreadyExists create race', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    let listCount = 0
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') {
        listCount += 1
        return listCount === 1 ? listResponse() : listResponse(providerArn)
      }
      if (command.constructor.name === 'CreateOpenIDConnectProviderCommand') {
        const error = new Error('Provider already exists')
        error.name = 'EntityAlreadyExists'
        throw error
      }
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    const result = await ensureGitHubOidcProvider(client)

    expect(result).toEqual({classification: 'current', changed: false, providerArn})
    expect(calls.map(call => call.name)).toEqual([
      'ListOpenIDConnectProvidersCommand',
      'CreateOpenIDConnectProviderCommand',
      'ListOpenIDConnectProvidersCommand',
      'GetOpenIDConnectProviderCommand',
      'GetOpenIDConnectProviderCommand',
    ])
  })

  it('fails closed when only ambient AWS credentials are present', () => {
    expect(() =>
      createIamClientFromEnv({
        AWS_ACCESS_KEY_ID: 'ambient-access-key-fixture',
        AWS_SECRET_ACCESS_KEY: 'ambient-secret-fixture',
      }),
    ).toThrow(/Missing dedicated.*AGENT_AWS_ACCESS_KEY_ID.*AGENT_AWS_SECRET_ACCESS_KEY/i)
  })

  it('emits the handoff manifest with the OIDC provider ARN populated', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    const {client} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse()
      if (command.constructor.name === 'CreateOpenIDConnectProviderCommand') {
        return {OpenIDConnectProviderArn: providerArn}
      }
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })
    const lines: string[] = []

    await performProvisioning({client, printLine: line => lines.push(line)})

    expect(lines).toHaveLength(1)
    const manifest = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(manifest.oidc_provider_arn).toBe(providerArn)
    expect(manifest.owner).toBe('')
    expect(manifest.key_layout_version).toBe('')
    expect(Object.keys(manifest)).toEqual(
      expect.arrayContaining([
        'owner',
        'repo',
        'repository_id',
        'repository_owner_id',
        'bucket',
        'bucket_region',
        'expected_bucket_owner',
        's3_prefix',
        'session_prefix',
        'lock_key',
        'role_name',
        'role_arn',
        'policy_name',
        'action_ref_verified',
        'key_layout_version',
        'oidc_provider_arn',
      ]),
    )
  })
})
