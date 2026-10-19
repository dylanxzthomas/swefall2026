import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
it('expires raw sources and quotes while retaining minimal receipts', async () => {
  const t = convexTest(schema, modules)
  const f = await t.run(async ctx => {
    const householdId = await ctx.db.insert('households', { timezone: 'UTC', children: [], deleted: false })
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic private source', hash: 'x', revision: 1, expiresAt: Date.now() - 1 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'alice', preparing: false, cancelled: false, clarification: '' })
    const actionId = await ctx.db.insert('actions', { householdId, jobId, revision: 1, sourceRevision: 1, status: 'succeeded', payload: { evidence: { date: 'Synthetic quote' } } })
    await ctx.db.insert('receipts', { householdId, actionId, revision: 1, providerId: 'synthetic', outcome: 'calendar_read_back_verified', verifiedAt: Date.now() })
    return { sourceId, actionId }
  })
  await t.mutation(internal.privacy.expireSources, {})
  expect((await t.run(ctx => ctx.db.get(f.sourceId)))?.text).toBeUndefined()
  expect((await t.run(ctx => ctx.db.get(f.actionId)))?.payload.evidence).toEqual({})
  expect(await t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(1)
})
it('deletion immediately blocks household access and durable cleanup removes family records', async () => {
  const t = convexTest(schema, modules), user = t.withIdentity({ subject: 'alice' })
  const householdId = await user.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await user.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
  await expect(user.query(api.jobs.list, {})).rejects.toThrow('unavailable')
  const deletion = (await t.run(ctx => ctx.db.query('deletionJobs').collect()))[0]
  await t.mutation(internal.privacy.eraseHousehold, { householdId, jobId: deletion._id })
  expect(await t.run(ctx => ctx.db.get(householdId))).toBeNull()
  expect(await t.run(ctx => ctx.db.query('memberships').collect())).toHaveLength(0)
})
it('legacy import is explicit, scoped, idempotent and never replays completion', async () => {
  const t = convexTest(schema, modules), user = t.withIdentity({ subject: 'alice' })
  await user.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const json = JSON.stringify({ items: [{ kind: 'event', title: 'Old trip', date: '2026-10-09', time: '08:30', duration: 30, owner: null, person: null, notes: '', done: true }], captures: [{ status: 'approved', items: [] }] })
  expect(await user.mutation(api.legacy.importRecords, { origin: 'phone', json })).toBe(1)
  expect(await user.mutation(api.legacy.importRecords, { origin: 'phone', json })).toBe(1)
  expect(await t.run(ctx => ctx.db.query('legacyRecords').collect())).toHaveLength(1)
  expect(await t.run(ctx => ctx.db.query('actions').collect())).toHaveLength(0)
  expect(await t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(0)
})
