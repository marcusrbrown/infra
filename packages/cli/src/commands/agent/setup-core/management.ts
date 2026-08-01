const MANAGEMENT_KEY_ENV = 'CLIPROXY_MANAGEMENT_KEY'

export function resolveManagementKey(input?: string): string {
  const key = input ?? process.env[MANAGEMENT_KEY_ENV]

  if (!key) {
    throw new Error(`Management API key is required. Pass --key or set ${MANAGEMENT_KEY_ENV}.`)
  }

  return key
}
