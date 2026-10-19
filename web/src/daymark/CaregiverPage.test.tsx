// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { getFunctionName } from 'convex/server'
import CaregiverPage from './CaregiverPage'
const state = vi.hoisted(() => ({ method: undefined as undefined | null | { method: 'identity' | 'code' }, request: undefined as undefined | null | Record<string, string>, calls: [] as { name: string; args: unknown }[] }))
vi.mock('convex/react', () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]); state.calls.push({ name, args })
    if (args === 'skip') return undefined
    return name === 'pickupIdentity:method' ? state.method : state.request
  },
  useMutation: () => vi.fn(), useAction: () => vi.fn(),
}))
const secret = 'a'.repeat(64)
const identity = { loading: false, authenticated: false, signIn: vi.fn() }
beforeEach(() => { vi.stubGlobal('window', { location: { hash: `#pickup=${secret}` } }); state.method = undefined; state.request = undefined; state.calls = []; vi.clearAllMocks() })
afterEach(() => vi.unstubAllGlobals())
it('shows request-specific sign-in without making family data queries or dispatching mail while signed out', () => {
  state.method = { method: 'identity' }
  const html = renderToStaticMarkup(<CaregiverPage identity={identity} />)
  expect(html).toContain('Continue with Google')
  expect(html).toContain('Use email')
  expect(html).toContain('You don’t need a Sola household or to install the app')
  expect(html).toContain('Sign-in creates or uses a secure identity')
  expect(html).not.toContain('Send verification code')
  expect(state.calls.filter(c => c.args !== 'skip')).toEqual([{ name: 'pickupIdentity:method', args: { secret } }])
  expect(identity.signIn).not.toHaveBeenCalled()
})
it('queries only the scoped view after authentication and renders only its permitted pickup details', () => {
  state.method = { method: 'identity' }; state.request = { child: 'Maya', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', message: 'Can you pick up Maya?', deadline: '2027-05-05T12:00:00Z' }
  const html = renderToStaticMarkup(<CaregiverPage identity={{ ...identity, authenticated: true }} />)
  expect(html).toContain('Pickup for Maya')
  expect(html).toContain('Accept pickup')
  expect(state.calls.filter(c => c.args !== 'skip').map(c => c.name)).toEqual(['pickupIdentity:method', 'pickupIdentity:view'])
})
it('offers account switching after a wrong-account or stale response without revealing recipient addresses', () => {
  state.method = { method: 'identity' }; state.request = null
  const html = renderToStaticMarkup(<CaregiverPage identity={{ ...identity, authenticated: true }} />)
  expect(html).toContain('This account can’t open the request')
  expect(html).toContain('Use another account')
  expect(html).toContain('Continue with Google')
  expect(html).toContain('Ask the parent for a current request')
  expect(html).not.toContain('Accept pickup')
  expect(html).not.toContain('@')
})
it('preserves the signed-out legacy code flow without an Auth0 provider', () => {
  state.method = { method: 'code' }
  const html = renderToStaticMarkup(<CaregiverPage />)
  expect(html).toContain('Send verification code')
  expect(html).not.toContain('Continue with Google')
  expect(html).not.toContain('Use email')
  expect(state.calls.filter(c => c.args !== 'skip').map(c => c.name)).toEqual(['pickupIdentity:method'])
})
it('does not switch Gmail identity requests to codes when sign-in is unconfigured', () => {
  state.method = { method: 'identity' }
  const html = renderToStaticMarkup(<CaregiverPage />)
  expect(html).toContain('Secure caregiver sign-in is not configured')
  expect(html).not.toContain('Send verification code')
})
it('withholds all controls and backend lookups for a malformed private fragment', () => {
  vi.stubGlobal('window', { location: { hash: `#pickup=${secret}&returnTo=https://other.example.test` } })
  const html = renderToStaticMarkup(<CaregiverPage identity={identity} />)
  expect(html).toContain('Ask the parent for a current request')
  expect(state.calls.every(c => c.args === 'skip')).toBe(true)
  expect(html).not.toContain('Continue with Google')
  expect(html).not.toContain('Use email')
  expect(html).not.toContain('Send verification code')
})
