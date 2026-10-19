// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { Auth0Client } from '@auth0/auth0-spa-js'
import { browserAuthOptions, connectionReturn, signInReturnPath } from '../../../shared/authentication'

it('recovers a lost in-memory refresh token through the existing Auth0 session after a connector return', async () => {
  // Exercise the installed SDK's missing-token path, without a browser, account,
  // token, or network request. Cookies may still require interactive recovery.
  const iframe = vi.fn().mockResolvedValue({ id_token: 'synthetic-test-only' })
  const context = { cacheManager: { get: async () => undefined }, options: { ...browserAuthOptions, clientId: 'synthetic-client' }, worker: undefined, _getTokenFromIFrame: iframe }
  const refresh = (Auth0Client.prototype as any)._getTokenUsingRefreshToken
  const request = { authorizationParams: { scope: 'openid profile email' } }
  await expect(refresh.call({ ...context, options: { ...context.options, useRefreshTokensFallback: false } }, request)).rejects.toMatchObject({ error: 'missing_refresh_token' })
  expect(iframe).not.toHaveBeenCalled()
  await expect(refresh.call(context, request)).resolves.toMatchObject({ id_token: 'synthetic-test-only' })
  expect(iframe).toHaveBeenCalledOnce()
  expect(browserAuthOptions.cacheLocation).toBe('memory')
})

it('keeps only a fixed connector return across interactive sign-in, never a user-supplied redirect', () => {
  expect(connectionReturn('?connection=connected')).toBe('connected')
  expect(connectionReturn('?connection=cancelled')).toBe('cancelled')
  expect(connectionReturn('?connection=https://other.example.test')).toBeNull()
  expect(signInReturnPath({ connectionReturn: 'connected' })).toBe('/?connection=connected')
  expect(signInReturnPath({ connectionReturn: 'cancelled' })).toBe('/?connection=cancelled')
  for (const value of ['https://other.example.test', '//other.example.test', '/?token=synthetic', null, {}]) expect(signInReturnPath({ connectionReturn: value })).toBe('/')
  expect(signInReturnPath()).toBe('/')
})
