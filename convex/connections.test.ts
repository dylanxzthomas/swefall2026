import { describe, expect, it } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
const modules = import.meta.glob('./**/*.ts')
describe('Google authorization storage', () => {
  it('consumes OAuth state once and binds it to the authenticated adult', async () => {
    const t = convexTest(schema, modules), alice = t.withIdentity({ subject: 'alice', tokenIdentifier: 'alice' })
    await alice.mutation(api.households.save, { timezone: 'UTC', children: [] })
    await alice.mutation(internal.connections.begin, { hash: 'random-state-hash', verifier: 'encrypted-verifier', purpose: 'calendar', native: false })
    const { state, connection } = await t.mutation(internal.connections.consume, { hash: 'random-state-hash' })
    expect(connection.subject).toBe(state.subject)
    await expect(t.mutation(internal.connections.consume, { hash: 'random-state-hash' })).rejects.toThrow('already used')
    await expect(t.mutation(internal.connections.consume, { hash: 'wrong-state' })).rejects.toThrow('expired')
  })
  it('serializes token access and rejects writes by an obsolete connection', async () => {
    const t = convexTest(schema, modules), alice = t.withIdentity({ subject: 'alice', tokenIdentifier: 'alice' })
    const h = await alice.mutation(api.households.save, { timezone: 'UTC', children: [] })
    const id = await t.run(ctx => ctx.db.insert('connections', { householdId: h, subject: 'alice', status: 'active', version: 1, cipher: 'secret-not-for-client', scopes: [] }))
    expect(await t.mutation(internal.connections.acquire, { id, version: 1, lock: 'first' })).not.toBeNull()
    expect(await t.mutation(internal.connections.acquire, { id, version: 1, lock: 'second' })).toBeNull()
    await t.run(ctx => ctx.db.patch(id, { version: 2, status: 'revoked' }))
    expect(await t.mutation(internal.connections.refreshed, { id, version: 1, lock: 'first', cipher: 'stale-token' })).toBe(false)
  })
})

it('rejects consent return and token storage after the adult loses household membership', async () => {
  const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'consent-parent', tokenIdentifier: 'consent-parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await parent.mutation(internal.connections.begin, { hash: 'revoked-consent', verifier: 'synthetic-encrypted', purpose: 'watch', native: false })
  const id = await t.run(async ctx => {
    const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'consent-parent')).unique()
    await ctx.db.delete(member!._id)
    return (await ctx.db.query('connections').first())!._id
  })
  await expect(t.mutation(internal.connections.consume, { hash: 'revoked-consent' })).rejects.toThrow('connection changed')
  expect(await t.mutation(internal.connections.connected, { id, version: 1, cipher: 'synthetic-never-persisted', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] })).toBe(false)
  expect((await t.run(ctx => ctx.db.get(id)))?.cipher).toBeUndefined()
  expect((await t.run(ctx => ctx.db.get(householdId)))?.deleted).toBe(false)
})

it('invalidates the connection version when refreshed provider grants change', async () => {
  const t = convexTest(schema, modules), adult = t.withIdentity({ subject: 'scope-parent', tokenIdentifier: 'scope-parent' })
  const householdId = await adult.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const id = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'scope-parent', status: 'active', version: 1, cipher: 'synthetic-cipher', scopes: ['read', 'compose'] }))
  expect(await t.mutation(internal.connections.acquire, { id, version: 1, lock: 'scope-lock' })).not.toBeNull()
  expect(await t.mutation(internal.connections.refreshed, { id, version: 1, lock: 'scope-lock', cipher: 'synthetic-refreshed', scopes: ['read'] })).toBe(false)
  expect(await t.query(internal.connections.privateRecord, { id })).toMatchObject({ version: 2, scopes: ['read'] })
  expect(await t.mutation(internal.connections.acquire, { id, version: 1, lock: 'stale' })).toBeNull()
})
it('does not lease or refresh a connection after its owning adult loses membership', async () => {
  const t = convexTest(schema, modules), adult = t.withIdentity({ subject: 'removed-parent', tokenIdentifier: 'removed-parent' })
  const householdId = await adult.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const id = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'removed-parent', status: 'active', version: 1, cipher: 'synthetic-cipher', scopes: ['read'] }))
  await t.mutation(internal.connections.acquire, { id, version: 1, lock: 'live-lock' })
  await t.run(async ctx => { const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'removed-parent')).unique(); await ctx.db.delete(member!._id) })
  expect(await t.mutation(internal.connections.refreshed, { id, version: 1, lock: 'live-lock', cipher: 'synthetic-not-stored' })).toBe(false)
  await t.mutation(internal.connections.release, { id, lock: 'live-lock' })
  expect(await t.mutation(internal.connections.acquire, { id, version: 1, lock: 'new-lock' })).toBeNull()
})
