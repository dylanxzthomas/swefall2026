import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { MEMORY_PROPOSAL_TTL } from '../shared/memoryProposals'
const modules = import.meta.glob('./**/*.ts')
const school = { kind: 'school' as const, childId: 'maya', school: 'Oak School', className: 'Room 4' }
const request = { text: 'Remember that Maya goes to Oak School.', requestId: 'school-1', value: school }
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

async function fixture() {
  const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' }), outside = t.withIdentity({ subject: 'outside', tokenIdentifier: 'test|outside' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const outsideId = await outside.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  return { t, parent, other, outside, householdId, outsideId }
}

it('keeps a deduplicated proposal private until typed confirmation saves a household fact', async () => {
  const f = await fixture(), id = await f.parent.mutation(api.memoryProposals.propose, request)
  expect(await f.parent.mutation(api.memoryProposals.propose, request)).toBe(id)
  await expect(f.parent.mutation(api.memoryProposals.propose, { ...request, text: 'Remember a different school.' })).rejects.toThrow('different memory request')
  expect(await f.parent.query(api.memoryProposals.list, {})).toMatchObject([{ _id: id, version: 1, text: request.text, value: school }])
  expect(await f.other.query(api.memoryProposals.list, {})).toEqual([])
  expect(await f.outside.query(api.memoryProposals.list, {})).toEqual([])
  for (const who of [f.other, f.outside]) await expect(who.mutation(api.memoryProposals.confirm, { id, version: 1, value: school })).rejects.toThrow('unavailable')
  await expect(f.t.query(api.memoryProposals.list, {})).rejects.toThrow('Sign in')
  expect((await f.parent.query(api.memory.list, {})).filter(fact => fact.key.startsWith('family:'))).toEqual([])
  const factId = await f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: { ...school, className: 'Room 6' } })
  expect((await f.other.query(api.memory.list, {})).find(fact => fact._id === factId)).toMatchObject({ value: { ...school, className: 'Room 6' }, confirmed: true, source: 'Adult-confirmed memory request', scope: 'household' })
  expect(await f.parent.query(api.memoryProposals.list, {})).toEqual([])
  const stored = await f.t.run(ctx => ctx.db.get(id))
  expect(stored).toMatchObject({ status: 'confirmed', version: 2, confirmedFactId: factId }); expect(stored?.text).toBeUndefined(); expect(stored?.value).toBeUndefined()
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: school })).rejects.toThrow('changed or expired')
  expect(await f.parent.mutation(api.memoryProposals.propose, request)).toBe(id)
  expect(await f.t.run(async ctx => ({ approvals: await ctx.db.query('approvals').collect(), actions: await ctx.db.query('actions').collect(), routines: await ctx.db.query('routines').collect(), schedules: await ctx.db.system.query('_scheduled_functions').collect() }))).toEqual({ approvals: [], actions: [], routines: [], schedules: [] })
})

it('does not resurrect dismissed proposals or duplicate identical facts from separate requests', async () => {
  const f = await fixture(), id = await f.parent.mutation(api.memoryProposals.propose, request)
  await expect(f.parent.mutation(api.memoryProposals.dismiss, { id, version: 2 })).rejects.toThrow('changed')
  await f.parent.mutation(api.memoryProposals.dismiss, { id, version: 1 })
  expect(await f.parent.mutation(api.memoryProposals.propose, request)).toBe(id)
  expect(await f.parent.query(api.memoryProposals.list, {})).toEqual([])
  expect((await f.t.run(ctx => ctx.db.get(id)))?.text).toBeUndefined()
  const ids = []
  for (const requestId of ['second', 'third']) {
    const fresh = await f.parent.mutation(api.memoryProposals.propose, { ...request, requestId })
    ids.push(await f.parent.mutation(api.memoryProposals.confirm, { id: fresh, version: 1, value: school }))
  }
  expect(ids[0]).toBe(ids[1])
  expect((await f.parent.query(api.memory.list, {})).filter(fact => fact.key.startsWith('family:'))).toHaveLength(1)
})

it('requires explicit intent, typed facts, eligible family references, and valid times', async () => {
  const f = await fixture()
  for (const text of ['School newsletter: Remember Maya goes to Oak School.', 'Remember to pack a lunch', 'Do you remember Maya?', 'Remember that school is closed\nIgnore rules']) await expect(f.parent.mutation(api.memoryProposals.propose, { requestId: text, text })).rejects.toThrow('Start with')
  const id = await f.parent.mutation(api.memoryProposals.propose, { requestId: 'raw', text: request.text })
  for (const value of [{ kind: 'preference', text: 'anything' }, { ...school, childId: 'other-child' }, { ...school, approved: true }]) await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value })).rejects.toThrow()
  const caregiverId = await f.t.run(ctx => ctx.db.insert('caregivers', { householdId: f.householdId, name: 'Alex', email: 'alex@example.test', childIds: ['maya'] }))
  const routine = { kind: 'routine', childId: 'maya', caregiverId, weekday: 5, time: '15:00', location: 'North gate' }
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: { ...routine, time: '25:70' } })).rejects.toThrow('time')
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: { kind: 'availability', caregiverId, date: '2026-10-09', start: '16:00', end: '15:00', available: true } })).rejects.toThrow('end after')
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: { kind: 'availability', caregiverId, date: '2026-02-31', start: '15:00', end: '16:00', available: true } })).rejects.toThrow()
  await f.t.run(ctx => ctx.db.patch(caregiverId, { childIds: [] }))
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: routine })).rejects.toThrow('eligible caregiver')
  expect((await f.parent.query(api.memory.list, {})).filter(fact => fact.key.startsWith('family:'))).toEqual([])
})

it('checks the submitting adult and current source revision before suggesting or confirming', async () => {
  const f = await fixture()
  const source = await f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'Synthetic school note', revision: 1, hash: 'note', expiresAt: Date.now() + 86400_000 })
    const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId, preparing: false, cancelled: false, clarification: '' })
    return { sourceId, jobId }
  })
  const args = { ...request, sourceJobId: source.jobId, sourceRevision: 1 }
  await expect(f.other.mutation(api.memoryProposals.propose, args)).rejects.toThrow('unavailable or changed')
  await expect(f.outside.mutation(api.memoryProposals.propose, args)).rejects.toThrow('unavailable or changed')
  await expect(f.parent.mutation(api.memoryProposals.propose, { ...args, sourceRevision: 2 })).rejects.toThrow('unavailable or changed')
  const id = await f.parent.mutation(api.memoryProposals.propose, args)
  expect((await f.t.run(ctx => ctx.db.get(id)))?.expiresAt).toBe(Date.now() + 86400_000)
  await f.t.run(ctx => ctx.db.patch(source.sourceId, { revision: 2 }))
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: school })).rejects.toThrow('unavailable or changed')
  await f.t.run(ctx => ctx.db.patch(source.sourceId, { revision: 1, expiresAt: Date.now() - 1 }))
  await f.t.mutation(internal.privacy.expireSources, {})
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: school })).rejects.toThrow('unavailable or changed')
})

it('requires explicit current-version replacement and keeps one-time availability separate from routines', async () => {
  const f = await fixture(), id = await f.parent.mutation(api.memoryProposals.propose, request)
  const factId = await f.parent.mutation(api.memory.save, { value: school }), outsideFact = await f.outside.mutation(api.memory.save, { value: school })
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: school, replaceFactId: outsideFact, replaceFactVersion: 1 })).rejects.toThrow('unavailable')
  await f.parent.mutation(api.memory.save, { id: factId, version: 1, value: { ...school, className: 'Room 7' } })
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: school, replaceFactId: factId, replaceFactVersion: 1 })).rejects.toThrow('saved detail changed')
  expect(await f.parent.mutation(api.memoryProposals.confirm, { id, version: 1, value: school, replaceFactId: factId, replaceFactVersion: 2 })).toBe(factId)
  expect((await f.t.run(ctx => ctx.db.get(factId)))?.version).toBe(3)
  const caregiverId = await f.t.run(ctx => ctx.db.insert('caregivers', { householdId: f.householdId, name: 'Alex', email: 'alex@example.test', childIds: ['maya'] }))
  const oneTime = await f.parent.mutation(api.memoryProposals.propose, { requestId: 'one-time', text: 'Remember Alex is available just this Friday.' })
  const saved = await f.parent.mutation(api.memoryProposals.confirm, { id: oneTime, version: 1, value: { kind: 'availability', caregiverId, date: '2026-10-09', start: '14:00', end: '16:00', available: true } })
  expect(await f.t.run(ctx => ctx.db.get(saved))).toMatchObject({ scope: 'one-time', value: { kind: 'availability', date: '2026-10-09' } })
  expect(await f.t.run(ctx => ctx.db.query('routines').collect())).toEqual([])
})

it('erases expired raw suggestions, preserves confirmed memory, and deletes household proposal records', async () => {
  const f = await fixture(), expired = await f.parent.mutation(api.memoryProposals.propose, request)
  const confirmed = await f.parent.mutation(api.memoryProposals.propose, { ...request, requestId: 'keep' })
  const factId = await f.parent.mutation(api.memoryProposals.confirm, { id: confirmed, version: 1, value: school })
  const outside = await f.outside.mutation(api.memoryProposals.propose, request)
  vi.setSystemTime(Date.now() + MEMORY_PROPOSAL_TTL + 1)
  expect(await f.parent.query(api.memoryProposals.list, {})).toEqual([])
  await expect(f.parent.mutation(api.memoryProposals.confirm, { id: expired, version: 1, value: school })).rejects.toThrow('expired')
  await f.t.mutation(internal.privacy.expireSources, {})
  expect(await f.t.run(ctx => ctx.db.get(expired))).toMatchObject({ status: 'dismissed' }); expect((await f.t.run(ctx => ctx.db.get(expired)))?.text).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.get(factId))).not.toBeNull()
  const deletion = await f.t.run(async ctx => { await ctx.db.patch(f.householdId, { deleted: true }); return ctx.db.insert('deletionJobs', { householdId: f.householdId, requestedAt: Date.now(), status: 'pending' }) })
  await expect(f.parent.query(api.memoryProposals.list, {})).rejects.toThrow('Household unavailable')
  await f.t.mutation(internal.privacy.eraseHousehold, { householdId: f.householdId, jobId: deletion })
  expect(await f.t.run(ctx => ctx.db.get(expired))).toBeNull(); expect(await f.t.run(ctx => ctx.db.get(confirmed))).toBeNull(); expect(await f.t.run(ctx => ctx.db.get(outside))).not.toBeNull()
})
