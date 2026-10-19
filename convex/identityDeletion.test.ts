// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { deleteIdentity } from './identityDeletion'
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('deletes only the captured Auth0 subject and treats uncertain responses as unconfirmed', async () => {
  vi.stubEnv('AUTH0_DOMAIN', 'https://synthetic.auth0.test')
  vi.stubEnv('AUTH0_MANAGEMENT_CLIENT_ID', 'synthetic-client'); vi.stubEnv('AUTH0_MANAGEMENT_CLIENT_SECRET', 'synthetic-secret')
  const request = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'synthetic-token' })).mockResolvedValueOnce(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', request)
  await deleteIdentity('auth0|synthetic-user')
  expect(request.mock.calls[1][0]).toBe('https://synthetic.auth0.test/api/v2/users/auth0%7Csynthetic-user')
  expect(request.mock.calls[1][1].method).toBe('DELETE')
  request.mockResolvedValueOnce(Response.json({ access_token: 'synthetic-token' })).mockResolvedValueOnce(new Response(null, { status: 503 }))
  await expect(deleteIdentity('auth0|synthetic-user')).rejects.toThrow('unconfirmed')
  request.mockResolvedValueOnce(Response.json({ access_token: 'synthetic-token' })).mockResolvedValueOnce(new Response(null, { status: 404 }))
  await deleteIdentity('auth0|synthetic-user')
  vi.stubEnv('AUTH0_DOMAIN', 'https://synthetic.auth0.test/untrusted-path')
  await expect(deleteIdentity('auth0|synthetic-user')).rejects.toThrow('issuer')
})
