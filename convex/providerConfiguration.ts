type ProviderEnvironment = Record<string, string | undefined>

// Shared by edge queries and Node actions. Never return key material to clients.
export function providerEncryptionConfigured(env: ProviderEnvironment = process.env): boolean {
  const id = env.PROVIDER_TOKEN_KEY_ID || env.GOOGLE_TOKEN_KEY_ID
  if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return false
  try {
    const keys: unknown = JSON.parse(env.PROVIDER_TOKEN_KEYS || env.GOOGLE_TOKEN_KEYS || '{}')
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.hasOwn(keys, id)) return false
    const key = (keys as Record<string, unknown>)[id]
    return typeof key === 'string' && atob(key).length === 32
  } catch { return false }
}

export function googleConnectionConfigured(env: ProviderEnvironment = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && providerEncryptionConfigured(env))
}
