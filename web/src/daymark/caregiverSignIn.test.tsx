import { expect, it } from 'vitest'
import { pickupSecret, signInReturnPath } from '../../../shared/authentication'
import { caregiverSignInOptions, type CaregiverSignInMethod } from './caregiverSignIn'

const secret = 'a'.repeat(64)
it.each(['google', 'email'] as const)('preserves only the private pickup return for %s without requesting mail or additional scopes', method => {
  const options = caregiverSignInOptions(`#pickup=${secret}`, method)
  expect(options).toEqual({ appState: { pickupReturn: secret }, authorizationParams: { prompt: 'login', ...(method === 'google' ? { connection: 'google-oauth2' } : {}) } })
  expect(signInReturnPath(options.appState)).toBe(`/#pickup=${secret}`)
  expect(pickupSecret(`#pickup=${secret}`)).toBe(secret)
  expect(options.authorizationParams).not.toHaveProperty('scope')
  expect(options.authorizationParams).not.toHaveProperty('connection_scope')
  expect(options.authorizationParams).not.toHaveProperty('redirect_uri')
  expect(options.appState).not.toHaveProperty('returnTo')
})
it.each(['', '#pickup=' + 'A'.repeat(64), `#pickup=${secret}&returnTo=https://other.example.test`, `#other=1&pickup=${secret}`, `/#pickup=${secret}`, '#pickup=https://other.example.test'])('refuses a malformed or redirected request %j', fragment => {
  expect(() => caregiverSignInOptions(fragment, 'google')).toThrow('current private pickup link')
  expect(() => caregiverSignInOptions(fragment, 'email')).toThrow('current private pickup link')
})
it('allows no arbitrary connection or caller-controlled destination', () => {
  expect(() => caregiverSignInOptions(`#pickup=${secret}`, 'other-provider' as CaregiverSignInMethod)).toThrow()
  expect(signInReturnPath({ ...caregiverSignInOptions(`#pickup=${secret}`, 'google').appState, returnTo: 'https://other.example.test' })).toBe(`/#pickup=${secret}`)
})
