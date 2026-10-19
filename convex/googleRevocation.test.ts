// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import { OAuth2Client } from 'google-auth-library'
import schema from './schema'
import { api, internal } from './_generated/api'
import { seal } from './googleCrypto'
import { gmailReadScope } from '../shared/emailWatches'

const modules = import.meta.glob('./**/*.ts')
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('PROVIDER_TOKEN_KEYS', JSON.stringify({ test: Buffer.alloc(32, 9).toString('base64') })); vi.stubEnv('PROVIDER_TOKEN_KEY_ID', 'test')
  vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-client'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-secret'); vi.stubEnv('CONVEX_SITE_URL', 'https://synthetic.convex.site')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture() {
  const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const id = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, email: 'synthetic@example.test', scopes: [gmailReadScope], cipher: seal({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }, `${householdId}:test|parent`) }))
  return { t, parent, other, id }
}

it('stops local authorization before revocation, then erases credentials after Google confirms', async () => {
  const f = await fixture(), revoke = vi.spyOn(OAuth2Client.prototype, 'revokeToken').mockResolvedValue({} as any)
  await f.parent.mutation(api.connections.disconnect, { id: f.id })
  expect((await f.parent.query(api.mailbox.settings, {})).connection).toMatchObject({ status: 'revoked', revocationPending: true, readAllowed: false })
  expect(await f.t.mutation(internal.connections.acquire, { id: f.id, version: 2, lock: 'late-read' })).toBeNull()
  await f.t.action(internal.google.revoke, { id: f.id, version: 2 })
  expect(revoke).toHaveBeenCalledExactlyOnceWith('synthetic-refresh')
  expect((await f.parent.query(api.mailbox.settings, {})).connection).toMatchObject({ status: 'revoked', revocationPending: false, readAllowed: false })
  expect((await f.t.query(internal.connections.privateRecord, { id: f.id }))?.cipher).toBeUndefined()
})

it('reports failed Google revocation privately while deleting local credentials and blocking reads', async () => {
  const f = await fixture()
  vi.spyOn(OAuth2Client.prototype, 'revokeToken').mockRejectedValue(new Error('synthetic-sensitive-provider-error'))
  await f.parent.mutation(api.connections.disconnect, { id: f.id })
  await f.t.action(internal.google.revoke, { id: f.id, version: 2 })
  const settings = await f.parent.query(api.mailbox.settings, {})
  expect(settings.connection).toMatchObject({ status: 'revocation_unconfirmed', revocationPending: false, readAllowed: false, composeAllowed: false })
  expect(JSON.stringify(settings)).not.toMatch(/synthetic-refresh|synthetic-access|cipher|synthetic-sensitive/)
  expect((await f.other.query(api.mailbox.settings, {})).connection).toBeNull()
  expect(await f.parent.query(api.mailbox.messages, {})).toEqual([])
  expect(await f.t.mutation(internal.connections.acquire, { id: f.id, version: 2, lock: 'late-read' })).toBeNull()
  expect((await f.t.query(internal.connections.privateRecord, { id: f.id }))?.cipher).toBeUndefined()
})

it('ignores stale revocation work after the connection changes', async () => {
  const f = await fixture(), revoke = vi.spyOn(OAuth2Client.prototype, 'revokeToken').mockResolvedValue({} as any)
  await f.t.action(internal.google.revoke, { id: f.id, version: 0 })
  expect(revoke).not.toHaveBeenCalled()
  expect((await f.t.query(internal.connections.privateRecord, { id: f.id }))?.status).toBe('active')
})
