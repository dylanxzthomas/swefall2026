import { expect, it } from 'vitest'
import { authenticationNotice, nativeSignInReturnMessage, pickupSecret, signInReturnPath, type AuthenticationState } from './authentication.js'

const signedOut: AuthenticationState = { identityLoading: false, identityAuthenticated: false, backendLoading: false, backendAuthenticated: false }
it('keeps anonymous and restored connected sessions quiet', () => {
  expect(authenticationNotice(signedOut)).toBeNull()
  expect(authenticationNotice({ ...signedOut, identityLoading: true })).toBeNull()
  expect(authenticationNotice({ ...signedOut, identityAuthenticated: true, backendAuthenticated: true })).toBeNull()
})
it('distinguishes backend verification in progress from a rejected sign-in', () => {
  expect(authenticationNotice({ ...signedOut, identityAuthenticated: true, backendLoading: true })).toMatchObject({ pending: true })
  expect(authenticationNotice({ ...signedOut, identityAuthenticated: true })).toMatchObject({ pending: false, reset: true })
})
it('reports OAuth cancellation without reflecting provider descriptions or credentials', () => {
  const notice = authenticationNotice({ ...signedOut, error: { error: 'access_denied', error_description: 'synthetic-token https://malicious.example.test/ <script>' } })
  expect(notice?.message).toContain('wasn’t completed')
  expect(notice?.message).not.toMatch(/synthetic-token|malicious|script/)
  expect(notice?.pending).toBe(false)
})
it('does not reflect errors from an already connected session', () => {
  const notice = authenticationNotice({ ...signedOut, identityAuthenticated: true, backendAuthenticated: true, error: new Error('synthetic-sensitive-detail') })
  expect(notice?.pending).toBe(false)
  expect(notice?.message).not.toContain('synthetic-sensitive-detail')
})
it.each([new Error('synthetic-sensitive-detail'), 'synthetic-sensitive-detail', 123, { error: 'invalid_state', message: 'synthetic-sensitive-detail' }])('shows a safe recovery message for unexpected errors', error => {
  const notice = authenticationNotice({ ...signedOut, error })
  expect(notice?.message).toContain('device workspace is still here')
  expect(notice?.message).not.toContain('synthetic-sensitive-detail')
})

it.each([
  new TypeError('Load failed'),
  new TypeError('Failed to fetch'),
  new TypeError('NetworkError when attempting to fetch resource.'),
  new Error("Timeout when executing 'fetch'"),
  { error: 'network_error', error_description: 'synthetic-sensitive-detail' },
  { error: 'timeout', message: 'synthetic-sensitive-detail' },
])('explains native network/configuration failures without claiming a completed sign-in', error => {
  const message = nativeSignInReturnMessage(error)
  expect(message).toContain('couldn’t connect')
  expect(message).toContain('sign-in setup needs checking')
  expect(message).toContain('draft is saved')
  expect(message).not.toContain('synthetic-sensitive-detail')
})

it.each(['state_mismatch', 'missing_transaction', 'invalid_state', 'invalid_grant'])('requires a new native sign-in after %s instead of reusing an invalid callback', error => {
  const message = nativeSignInReturnMessage({ error, state: 'synthetic-state', code_verifier: 'synthetic-verifier', error_description: 'synthetic-token https://private.example.test/callback?code=synthetic <script>' })
  expect(message).toContain('Start a new sign-in from Household')
  expect(message).not.toMatch(/synthetic|private|callback|script/)
})

it('explains native denial without displaying any provider details or prompting automatic continuation', () => {
  const message = nativeSignInReturnMessage({ error: 'access_denied', message: 'Load failed', error_description: 'synthetic-token https://private.example.test/' })
  expect(message).toContain('wasn’t completed')
  expect(message).toContain('when you’re ready')
  expect(message).not.toMatch(/synthetic|private|Load failed/)
})

it.each([undefined, null, 'Load failed', 123, new Error('synthetic-sensitive-detail'), { error: 'unknown', message: 'Load failed https://private.example.test/?token=synthetic' }, { get error() { throw new Error('synthetic-sensitive-detail') }, get message() { throw new Error('synthetic-sensitive-detail') } }])('keeps unexpected native errors generic and private', error => {
  const message = nativeSignInReturnMessage(error)
  expect(message).toBe('Sign-in return could not finish. Reopen sign-in to try again; your draft is saved.')
  expect(message).not.toMatch(/synthetic|private|token/)
})


it('keeps a caregiver secret only in the fixed fragment return across sign-in', () => {
  const secret = 'a'.repeat(64)
  expect(pickupSecret(`#pickup=${secret}`)).toBe(secret)
  expect(signInReturnPath({ pickupReturn: secret, returnTo: 'https://other.example.test' })).toBe(`/#pickup=${secret}`)
  expect(signInReturnPath({ pickupReturn: secret, connectionReturn: 'connected' })).toBe(`/#pickup=${secret}`)
})
it.each(['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65), 'https://other.example.test', '//other.example.test', `a${'a'.repeat(63)}&returnTo=https://other.example.test`, `%61${'a'.repeat(63)}`])('rejects malformed caregiver secrets and arbitrary sign-in destinations', value => {
  expect(pickupSecret(`#pickup=${value}`)).toBeNull()
  expect(signInReturnPath({ pickupReturn: value })).toBe('/')
})
it('does not read caregiver secrets from queries, additional fragments, or return URLs', () => {
  const secret = 'b'.repeat(64)
  for (const value of [`?pickup=${secret}`, `/#pickup=${secret}`, `#pickup=${secret}&other=1`, `#other=1&pickup=${secret}`, `#pickup=${secret}#second`]) expect(pickupSecret(value)).toBeNull()
  for (const value of [undefined, null, {}, { pickupReturn: { secret } }, { returnTo: `/#pickup=${secret}` }]) expect(signInReturnPath(value)).toBe('/')
})
