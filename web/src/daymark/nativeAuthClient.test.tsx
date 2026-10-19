// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Auth0Client, type ICache } from '@auth0/auth0-spa-js'
import { NativeAuthClient } from './nativeAuthClient'

const domain = 'native-test.example.test', clientId = 'synthetic-native-client'
const redirectUri = 'com.example.test://native-test.example.test/callback'

function memoryCache() {
  const values = new Map<string, unknown>()
  const cache: ICache = {
    async get<T>(key: string) { return values.get(key) as T | undefined },
    async set<T>(key: string, value: T) { values.set(key, value) },
    async remove(key: string) { values.delete(key) },
    async allKeys() { return [...values.keys()] },
  }
  return { cache, values }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
  vi.stubGlobal('document', { cookie: '', createElement: () => { throw new Error('Native restoration must not open an iframe') } })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No network allowed in this test')))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('native session restoration', () => {
  it('bypasses only the browser-cookie optimization using the public SDK method', async () => {
    const { cache } = memoryCache()
    const browser = new Auth0Client({ domain, clientId, cache, useRefreshTokens: true })
    const browserToken = vi.spyOn(browser, 'getTokenSilently').mockResolvedValue(undefined)
    await browser.checkSession()
    expect(browserToken).not.toHaveBeenCalled()

    const native = new NativeAuthClient({ domain, clientId, redirectUri, cache })
    const nativeToken = vi.spyOn(native, 'getTokenSilently').mockResolvedValue(undefined)
    const logout = vi.spyOn(native, 'logout')
    await native.checkSession()
    expect(nativeToken).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(logout).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('passes SDK refresh options unchanged and does not expose the returned token', async () => {
    const native = new NativeAuthClient({ domain, clientId, redirectUri, cache: memoryCache().cache })
    const token = vi.spyOn(native, 'getTokenSilently').mockResolvedValue('synthetic-test-token')
    const options = { cacheMode: 'off' as const, timeoutInSeconds: 5 }
    await expect(native.checkSession(options)).resolves.toBeUndefined()
    expect(token).toHaveBeenCalledExactlyOnceWith(options)
  })

  it('treats a real SDK empty-cache result as signed out without an iframe or request', async () => {
    const { cache, values } = memoryCache()
    const native = new NativeAuthClient({ domain, clientId, redirectUri, cache })
    const logout = vi.spyOn(native, 'logout')
    await expect(native.checkSession()).resolves.toBeUndefined()
    expect(logout).toHaveBeenCalledExactlyOnceWith({ openUrl: false })
    await expect(native.getUser()).resolves.toBeUndefined()
    expect(values.size).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['invalid_grant', 'login_required', 'access_denied'])('fails closed and clears the local SDK session after %s', async code => {
    const native = new NativeAuthClient({ domain, clientId, redirectUri, cache: memoryCache().cache })
    const error = { error: code, error_description: 'synthetic detail must not become UI text' }
    vi.spyOn(native, 'getTokenSilently').mockRejectedValue(error)
    const logout = vi.spyOn(native, 'logout').mockResolvedValue()
    await expect(native.checkSession()).rejects.toBe(error)
    expect(logout).toHaveBeenCalledExactlyOnceWith({ openUrl: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { error: 'network_error' }, { error: 'timeout' }, { error: 'mfa_required' },
    new TypeError('Load failed'), new Error('Secure storage is locked'),
  ])('preserves storage and rejects initialization for a temporary or interactive failure', async error => {
    const { cache } = memoryCache()
    const native = new NativeAuthClient({ domain, clientId, redirectUri, cache })
    vi.spyOn(native, 'getTokenSilently').mockRejectedValue(error)
    const logout = vi.spyOn(native, 'logout')
    const remove = vi.spyOn(cache, 'remove'), set = vi.spyOn(cache, 'set')
    await expect(native.checkSession()).rejects.toBe(error)
    expect(logout).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('does not hide a Keychain failure while clearing a rejected session', async () => {
    const native = new NativeAuthClient({ domain, clientId, redirectUri, cache: memoryCache().cache })
    vi.spyOn(native, 'getTokenSilently').mockRejectedValue({ error: 'invalid_grant' })
    const locked = new Error('Secure storage is locked')
    vi.spyOn(native, 'logout').mockRejectedValue(locked)
    await expect(native.checkSession()).rejects.toBe(locked)
  })

  it('leaves logout authoritative: a later startup cannot silently create a session', async () => {
    const native = new NativeAuthClient({ domain, clientId, redirectUri, cache: memoryCache().cache })
    await native.logout({ openUrl: false })
    await native.checkSession()
    await expect(native.isAuthenticated()).resolves.toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
