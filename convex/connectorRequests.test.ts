import { expect, it } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
const modules = import.meta.glob('./**/*.ts')
const input = { service: 'Synthetic swim school', outcome: 'Find a Saturday lesson for me to review.' }
async function fixture() {
  const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' }), outsider = t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  return { t, parent, other, outsider, householdId }
}
it('saves privately per adult, with no provider call, approval or executable job', async () => {
  const f = await fixture(), id = await f.parent.mutation(api.connectorRequests.create, { ...input, requestId: 'one' })
  expect(await f.parent.query(api.connectorRequests.list, {})).toEqual([expect.objectContaining({ id, ...input, status: 'requested', version: 1 })])
  for (const account of [f.other, f.outsider]) {
    expect(await account.query(api.connectorRequests.list, {})).toEqual([])
    await expect(account.mutation(api.connectorRequests.dismiss, { id, version: 1 })).rejects.toThrow('unavailable')
  }
  await expect(f.t.query(api.connectorRequests.list, {})).rejects.toThrow('Sign in')
  expect(await f.t.run(async ctx => Promise.all([ctx.db.query('jobs').collect(), ctx.db.query('approvals').collect(), ctx.db.query('attempts').collect(), ctx.db.query('connections').collect(), ctx.db.query('oauthStates').collect(), ctx.db.system.query('_scheduled_functions').collect()]))).toEqual([[], [], [], [], [], []])
  const listed = JSON.stringify(await f.parent.query(api.connectorRequests.list, {}))
  expect(listed).not.toContain('test|parent'); expect(listed).not.toContain('requestHash')
})
it('deduplicates identical open work and reserves every retry ID, including duplicate aliases', async () => {
  const f = await fixture()
  const ids = await Promise.all(['one', 'two', 'one'].map(requestId => f.parent.mutation(api.connectorRequests.create, { ...input, requestId })))
  expect(new Set(ids).size).toBe(1)
  expect(await f.parent.query(api.connectorRequests.list, {})).toHaveLength(1)
  for (const requestId of ['one', 'two']) await expect(f.parent.mutation(api.connectorRequests.create, { ...input, outcome: 'A different job', requestId })).rejects.toThrow('different connector request')
  const otherId = await f.other.mutation(api.connectorRequests.create, { ...input, requestId: 'one' })
  expect(otherId).not.toBe(ids[0])
})
it('rejects stale dismissal, clears dismissed text, and never revives it from delayed retries', async () => {
  const f = await fixture(), id = await f.parent.mutation(api.connectorRequests.create, { ...input, requestId: 'one' })
  await expect(f.parent.mutation(api.connectorRequests.dismiss, { id, version: 0 })).rejects.toThrow('changed')
  await f.parent.mutation(api.connectorRequests.dismiss, { id, version: 1 })
  await expect(f.parent.mutation(api.connectorRequests.dismiss, { id, version: 1 })).rejects.toThrow('changed')
  expect(await f.parent.mutation(api.connectorRequests.create, { ...input, requestId: 'one' })).toBe(id)
  expect(await f.parent.query(api.connectorRequests.list, {})).toEqual([])
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'dismissed', outcome: '', version: 2 })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.service).toBeUndefined()
  expect(await f.parent.mutation(api.connectorRequests.create, { ...input, requestId: 'fresh' })).not.toBe(id)
})
it('refuses hidden permissions and removes both records and retry markers with the household', async () => {
  const f = await fixture()
  await expect(f.parent.mutation(api.connectorRequests.create, { ...input, requestId: 'invalid', approved: true } as any)).rejects.toThrow()
  await expect(f.parent.mutation(api.connectorRequests.create, { service: 'App', outcome: ' ', requestId: 'blank' })).rejects.toThrow()
  await f.parent.mutation(api.connectorRequests.create, { ...input, requestId: 'one' })
  await f.other.mutation(api.connectorRequests.create, { ...input, requestId: 'other' })
  await f.outsider.mutation(api.connectorRequests.create, { ...input, requestId: 'outsider' })
  const deletion = await f.t.run(async ctx => { await ctx.db.patch(f.householdId, { deleted: true }); return ctx.db.insert('deletionJobs', { householdId: f.householdId, requestedAt: Date.now(), status: 'pending', identityStatus: 'deleted' }) })
  await f.t.mutation(internal.privacy.eraseHousehold, { householdId: f.householdId, jobId: deletion })
  expect(await f.t.run(ctx => ctx.db.query('connectorRequests').collect())).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('connectorRequestKeys').collect())).toHaveLength(1)
  expect(await f.outsider.query(api.connectorRequests.list, {})).toHaveLength(1)
})
