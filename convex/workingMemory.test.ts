import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { unavailableWorkingContext } from './workingMemory'
import { event } from '../tests/fixtures/calendar'
import type { Id } from './_generated/dataModel'
import { conversationValidation } from './conversationValidation'
import { coordinatorStep } from '../shared/assistantCoordinator'
vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-08T09:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.mocked(extractStructured).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(count = 14) {
  const t = convexTest(schema, modules); workflow.register(t)
  const owner = t.withIdentity({ subject: 'owner', tokenIdentifier: 'test|owner' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await owner.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const ids: Id<'jobs'>[] = []
  for (let i = 0; i < count; i++) {
    vi.advanceTimersByTime(1)
    ids.push(await t.run(async ctx => {
      const text = i === 0 ? 'I prefer vegetarian dinners with rice.' : `Synthetic discussion ${i}`
      const sourceId = await ctx.db.insert('sources', { householdId, text, hash: text, revision: 1, expiresAt: now + 86400000 })
      return ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|owner', interactive: true, conversation: true, preparing: false, cancelled: false, clarification: 'A synthetic reply.' })
    }))
  }
  const claim = () => t.mutation(internal.workingMemory.claim, { jobId: ids.at(-1)!, lease: 'lease' })
  return { t, owner, other, householdId, ids, claim }
}

it('compacts only literal parent excerpts and supplies private context after the recent transcript', async () => {
  const f = await fixture(), claim = (await f.claim())!
  expect(claim.requests).toHaveLength(2)
  expect(JSON.stringify(claim.requests)).not.toContain('A synthetic reply')
  expect(await f.t.mutation(internal.workingMemory.finish, { id: claim.id, inputKey: claim.inputKey, lease: claim.lease, context: claim.context, notes: [{ jobId: f.ids[0], quote: 'I prefer vegetarian dinners with rice.' }] })).toBe(true)
  vi.advanceTimersByTime(1)
  const id = await f.owner.mutation(api.jobs.submit, { text: 'Which dinner would fit my earlier preferences?' })
  const context = (await f.t.query(internal.jobs.context, { jobId: id }))!.assistant!
  expect(context.history).toHaveLength(12)
  expect(context.history.some(h => h.request.includes('vegetarian'))).toBe(false)
  expect(context.workingMemory!.notes).toEqual([{ jobId: f.ids[0], quote: 'I prefer vegetarian dinners with rice.' }])
  vi.mocked(extractStructured).mockResolvedValue(coordinatorStep.parse({ tool: 'finish', query: '', id: '', from: '', through: '', answer: 'A vegetarian rice bowl fits your earlier preference.', drafts: [] }))
  await f.t.action(internal.preparation.prepare, { jobId: id, sourceRevision: 1 })
  const run = (await f.owner.query(api.assistantCoordinator.list, {})).find(r => r.jobId === id)!
  await f.t.action(internal.coordinatorWorker.step, { id: run.id as Id<'assistantRuns'>, version: run.version })
  const input = vi.mocked(extractStructured).mock.calls[0][2] as any
  expect(input.assistant.workingContext).toBeUndefined()
  expect(input.assistant.workingMemory.notes[0].quote).toContain('vegetarian')
  const reply = (await f.owner.query(api.jobs.list, {})).find(j => j._id === id)!
  expect(reply).toMatchObject({ conversation: true, actions: [], workingContext: { expiresAt: now + 86400000 } })
  expect(reply.clarification).toBe('A vegetarian rice bowl fits your earlier preference.')
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
  await expect(f.owner.mutation(api.jobs.addDraft, { jobId: id, payload: event })).rejects.toThrow('stays private')
  await expect(f.owner.mutation(api.jobs.reviseSource, { jobId: id, revision: 1, text: 'Shared event' })).rejects.toThrow('stays private')
  vi.advanceTimersByTime(1)
  const notice = await f.owner.mutation(api.jobs.submit, { text: 'Event: Museum trip\nDate: 2026-10-12\nTime: 8 AM to 9 AM' })
  const familyPreparation = (await f.t.query(internal.jobs.context, { jobId: notice }))!.assistant!
  expect(familyPreparation.workingMemory).toBeUndefined()
  expect(familyPreparation.history.some(h => h.response.includes('vegetarian rice bowl'))).toBe(false)

})

it('does not invoke compaction for twelve or fewer usable turns', async () => {
  const f = await fixture(12)
  await f.t.action(internal.workingMemoryWorker.refresh, { jobId: f.ids.at(-1)! })
  expect(extractStructured).not.toHaveBeenCalled()
  expect(await f.t.run(ctx => ctx.db.query('workingMemories').collect())).toEqual([])
})

it('accepts one of fifty claims, refuses duplicate completion, and cools down rapid refreshes', async () => {
  const f = await fixture()
  const claims = await Promise.all(Array.from({ length: 50 }, (_, i) => f.t.mutation(internal.workingMemory.claim, { jobId: f.ids.at(-1)!, lease: `lease-${i}` })))
  expect(claims.filter(Boolean)).toHaveLength(1)
  const c = claims.find(Boolean)!
  const args = { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] }
  expect(await f.t.mutation(internal.workingMemory.finish, args)).toBe(true)
  expect(await f.t.mutation(internal.workingMemory.finish, args)).toBe(false)
  expect(await f.claim()).toBeNull()
  vi.advanceTimersByTime(300001)
  expect(await f.claim()).toBeNull() // Identical sources need no second model call.
})

it.each(['invented', 'unknown', 'oversize', 'duplicate'] as const)('rejects %s compacted excerpts', async bad => {
  const f = await fixture(), c = (await f.claim())!
  const note = { jobId: bad === 'unknown' ? f.ids.at(-1)! : f.ids[0], quote: bad === 'invented' ? 'The family likes hamburgers.' : bad === 'oversize' ? 'x'.repeat(501) : 'vegetarian dinners' }
  expect(await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: bad === 'duplicate' ? [note, note] : [note] })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(c.id)))!.notes).toBeUndefined()
})

it.each(['revision', 'expiry', 'cancellation', 'source-deletion', 'membership'] as const)('invalidates pending compaction and derived replies after %s changes', async change => {
  const f = await fixture(), c = (await f.claim())!
  await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] })
  vi.advanceTimersByTime(1)
  const id = await f.owner.mutation(api.jobs.submit, { text: 'What fits the preference I mentioned earlier?' })
  await f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, conversation: true, actions: [], clarification: 'Vegetarian rice.', workingContext: c.context })
  await f.t.run(async ctx => {
    const sourceId = (await ctx.db.get(f.ids[0]))!.sourceId
    if (change === 'revision') await ctx.db.patch(sourceId, { revision: 2, text: 'I now prefer noodles.' })
    if (change === 'expiry') await ctx.db.patch(sourceId, { expiresAt: Date.now() })
    if (change === 'cancellation') await ctx.db.patch(f.ids[0], { cancelled: true })
    if (change === 'source-deletion') await ctx.db.delete(sourceId)
    if (change === 'membership') await ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|owner')).unique())!._id)
  })
  if (change === 'membership') expect(await f.t.query(internal.jobs.context, { jobId: id })).toBeNull()
  else {
    expect((await f.owner.query(api.jobs.list, {})).find(j => j._id === id)!.clarification).toBe(unavailableWorkingContext)
    const next = await f.owner.mutation(api.jobs.submit, { text: 'What fits my preferences now?' })
    expect((await f.t.query(internal.jobs.context, { jobId: next }))!.assistant!.workingMemory).toBeUndefined()
  }
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
})

it('refuses late private-context output and forbids using it to create shared work', async () => {
  const f = await fixture(), c = (await f.claim())!
  vi.advanceTimersByTime(1)
  const id = await f.owner.mutation(api.jobs.submit, { text: 'What fits my preferences?' })
  await expect(f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, conversation: false, actions: [event], clarification: 'Unapproved shared result', workingContext: c.context })).rejects.toThrow('cannot create')
  await f.t.run(ctx => ctx.db.patch(c.context.sources[1].sourceId, { revision: 2 }))
  await f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, conversation: true, actions: [], clarification: 'A stale private response.', workingContext: c.context })
  expect((await f.owner.query(api.jobs.list, {})).find(j => j._id === id)!.clarification).toBe(unavailableWorkingContext)
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})

it('excludes email, prepared household work and another adult; a new notice gets no working notes', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    await ctx.db.patch(f.ids[1], { createdBy: 'test|other' })
    const source = (await ctx.db.get(f.ids[2]))!.sourceId
    await ctx.db.patch(source, { attachmentIds: [] })
    await ctx.db.patch(f.ids[3], { conversation: undefined })
  })
  // Only twelve eligible ordinary conversations remain.
  expect(await f.claim()).toBeNull()
  const notice = await f.owner.mutation(api.jobs.submit, { text: 'Event: Museum trip\nDate: 2026-10-12\nTime: 8 AM to 9 AM' })
  expect((await f.t.query(internal.jobs.context, { jobId: notice }))!.assistant!.workingMemory).toBeUndefined()
})

it('recovers an expired lease, backs off model failures, and erases working context with the household', async () => {
  const f = await fixture(), first = (await f.claim())!
  vi.advanceTimersByTime(300001)
  const second = (await f.t.mutation(internal.workingMemory.claim, { jobId: f.ids.at(-1)!, lease: 'recovered' }))!
  expect(second.id).toBe(first.id)
  expect(await f.t.mutation(internal.workingMemory.finish, { id: first.id, inputKey: first.inputKey, lease: first.lease, context: first.context, notes: [] })).toBe(false)
  await f.t.mutation(internal.workingMemory.failed, { id: second.id, inputKey: second.inputKey, lease: second.lease })
  expect(await f.claim()).toBeNull()
  await f.owner.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
  const deletion = (await f.t.run(ctx => ctx.db.query('deletionJobs').collect()))[0]
  await f.t.mutation(internal.privacy.eraseHousehold, { householdId: f.householdId, jobId: deletion._id })
  expect(await f.t.run(ctx => ctx.db.query('workingMemories').collect())).toEqual([])
})

it('retries a failed changed-source selection while retaining the previous valid excerpts', async () => {
  const f = await fixture(), first = (await f.claim())!
  await f.t.mutation(internal.workingMemory.finish, { id: first.id, inputKey: first.inputKey, lease: first.lease, context: first.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] })
  vi.advanceTimersByTime(300001)
  const next = await f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'One more synthetic discussion', hash: 'another', revision: 1, expiresAt: now + 86400000 })
    return ctx.db.insert('jobs', { householdId: f.householdId, sourceId, createdBy: 'test|owner', interactive: true, conversation: true, preparing: false, cancelled: false, clarification: 'Another reply.' })
  })
  const changed = (await f.t.mutation(internal.workingMemory.claim, { jobId: next, lease: 'changed' }))!
  expect(changed.inputKey).not.toBe(first.inputKey)
  await f.t.mutation(internal.workingMemory.failed, { id: changed.id, inputKey: changed.inputKey, lease: changed.lease })
  expect((await f.t.run(ctx => ctx.db.get(first.id)))!.notes![0].quote).toBe('vegetarian dinners')
  vi.advanceTimersByTime(900001)
  expect(await f.t.mutation(internal.workingMemory.claim, { jobId: next, lease: 'retry' })).not.toBeNull()
})

it('rejects changed source text and a substituted source set even without a revision increment', async () => {
  const f = await fixture(), c = (await f.claim())!
  expect(await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: { ...c.context, sources: c.context.sources.slice(0, 1) }, notes: [] })).toBe(false)
  await f.t.run(ctx => ctx.db.patch(c.context.sources[1].sourceId, { text: 'Changed but still revision one' }))
  expect(await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] })).toBe(false)
})

it('purges expired excerpts even when empty cache records precede them', async () => {
  const f = await fixture(), c = (await f.claim())!
  await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] })
  await f.t.run(async ctx => {
    for (let i = 0; i < 101; i++) await ctx.db.insert('workingMemories', { householdId: f.householdId, createdBy: `empty-${i}`, inputKey: 'empty', nextAttemptAt: now })
  })
  vi.advanceTimersByTime(86400001)
  await f.t.mutation(internal.privacy.expireSources, {})
  const cache = (await f.t.run(ctx => ctx.db.get(c.id)))!
  expect(cache.notes).toBeUndefined()
  expect(cache.context).toBeUndefined()
})

it('reuses source checks within one query but never across adults or later source changes', async () => {
  const f = await fixture(), c = (await f.claim())!
  await f.t.run(async ctx => {
    const get = vi.fn(ctx.db.get.bind(ctx.db))
    const db = new Proxy(ctx.db, { get(target, key) { return key === 'get' ? get : Reflect.get(target, key) } })
    const validate = conversationValidation({ db }), owner = { householdId: f.householdId, createdBy: 'test|owner' }
    expect((await Promise.all(Array.from({ length: 50 }, () => validate.working(owner, c.context)))).every(Boolean)).toBe(true)
    expect(get.mock.calls.length).toBeLessThan(10)
    expect(await validate.working({ ...owner, createdBy: 'test|other' }, c.context)).toBe(false)
  })
  await f.t.run(ctx => ctx.db.patch(c.context.sources[0].sourceId, { revision: 2 }))
  await f.t.run(async ctx => {
    expect(await conversationValidation(ctx).working({ householdId: f.householdId, createdBy: 'test|owner' }, c.context)).toBe(false)
  })
})

it('clears only the owner’s older context, prevents backfill and refuses a late selector', async () => {
  const f = await fixture(), c = (await f.claim())!
  await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] })
  vi.advanceTimersByTime(1)
  const derived = await f.owner.mutation(api.jobs.submit, { text: 'What fits my earlier preferences?' })
  await f.t.mutation(internal.jobs.prepared, { jobId: derived, sourceRevision: 1, conversation: true, actions: [], clarification: 'Vegetarian rice.', workingContext: c.context })
  expect(await f.owner.query(api.workingMemory.settings, {})).toMatchObject({ excerptCount: 1, version: 0 })
  expect(await f.other.query(api.workingMemory.settings, {})).toEqual({ excerptCount: 0, version: 0 })
  await f.other.mutation(api.workingMemory.reset, { version: 0 })
  expect((await f.owner.query(api.workingMemory.settings, {})).excerptCount).toBe(1)
  vi.advanceTimersByTime(300001)
  const pending = (await f.t.mutation(internal.workingMemory.claim, { jobId: derived, lease: 'before-reset' }))!
  const beforeJobs = await f.t.run(ctx => ctx.db.query('jobs').collect())
  expect(await f.owner.mutation(api.workingMemory.reset, { version: 0 })).toBe(1)
  expect(await f.owner.query(api.workingMemory.settings, {})).toMatchObject({ excerptCount: 0, version: 1, resetAt: Date.now() })
  expect(await f.t.mutation(internal.workingMemory.finish, { id: pending.id, inputKey: pending.inputKey, lease: pending.lease, context: pending.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] })).toBe(false)
  expect(await f.t.run(ctx => ctx.db.query('jobs').collect())).toEqual(beforeJobs)
  expect((await f.owner.query(api.jobs.list, {})).find(j => j._id === derived)!.clarification).toBe(unavailableWorkingContext)
  vi.advanceTimersByTime(1)
  const next = await f.owner.mutation(api.jobs.submit, { text: 'What are we discussing now?' })
  await f.t.mutation(internal.jobs.prepared, { jobId: next, sourceRevision: 1, conversation: true, actions: [], clarification: 'A fresh conversation.' })
  expect(await f.t.mutation(internal.workingMemory.claim, { jobId: next, lease: 'after-reset' })).toBeNull()
  expect((await f.t.query(internal.jobs.context, { jobId: next }))!.assistant!.workingMemory).toBeUndefined()
})

it('accepts one of fifty concurrent reset requests, rejects stale/invalid versions and requires sign-in', async () => {
  const f = await fixture(), c = (await f.claim())!
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => f.owner.mutation(api.workingMemory.reset, { version: 0 })))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(await f.owner.query(api.workingMemory.settings, {})).toMatchObject({ version: 1, excerptCount: 0 })
  for (const version of [0, -1, 1.5]) await expect(f.owner.mutation(api.workingMemory.reset, { version })).rejects.toThrow('changed')
  await expect(f.t.mutation(api.workingMemory.reset, { version: 1 })).rejects.toThrow('Sign in')
  await expect(f.t.query(api.workingMemory.settings, {})).rejects.toThrow('Sign in')
  expect(await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [] })).toBe(false)
})

async function completedTurn(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  vi.advanceTimersByTime(1)
  return f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text, hash: text, revision: 1, expiresAt: now + 86400000 })
    return ctx.db.insert('jobs', { householdId: f.householdId, sourceId, createdBy: 'test|owner', interactive: true, conversation: true, preparing: false, cancelled: false, clarification: 'A synthetic response.' })
  })
}

it('coalesces fifty newer completed turns into one durable timer and refreshes the latest after cooldown', async () => {
  const f = await fixture(), c = (await f.claim())!
  await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] })
  const newer = []
  for (let i = 0; i < 50; i++) newer.push(await completedTurn(f, `A newer synthetic message ${i}`))
  await Promise.all(newer.map((jobId, i) => f.t.mutation(internal.workingMemory.claim, { jobId, lease: `newer-${i}` })))
  const cache = (await f.t.run(ctx => ctx.db.get(c.id)))!
  expect(cache.pendingJobId).toBe(newer.at(-1))
  expect(cache.refreshAt).toBe(cache.nextAttemptAt)
  const timers = await f.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())
  expect(timers.filter(t => t.name === 'workingMemory:resume')).toHaveLength(1)
  const resume = { id: cache._id, resetVersion: 0, expectedAt: cache.refreshAt! }
  expect(await f.t.mutation(internal.workingMemory.resume, resume)).toBe(false)
  vi.setSystemTime(cache.refreshAt!)
  expect(await f.t.mutation(internal.workingMemory.resume, resume)).toBe(true)
  expect(await f.t.mutation(internal.workingMemory.resume, resume)).toBe(false)
  const next = (await f.t.mutation(internal.workingMemory.claim, { jobId: newer.at(-1)!, lease: 'after-cooldown' }))!
  expect(next.requests.some(r => r.request.includes('newer synthetic'))).toBe(true)
  expect((await f.t.run(ctx => ctx.db.get(c.id)))!.pendingJobId).toBeUndefined()
})

it('cancels a queued refresh when cleared and refuses an old timer after newer activity', async () => {
  const f = await fixture(), c = (await f.claim())!
  const next = await completedTurn(f, 'My dinner preference changed to noodles.')
  await f.t.mutation(internal.workingMemory.claim, { jobId: next, lease: 'during-lease' })
  const cache = (await f.t.run(ctx => ctx.db.get(c.id)))!
  expect(cache.refreshTimerId).toBeDefined()
  const resume = { id: c.id, resetVersion: 0, expectedAt: cache.refreshAt! }
  await f.owner.mutation(api.workingMemory.reset, { version: 0 })
  expect((await f.t.run(ctx => ctx.db.system.get(cache.refreshTimerId!)))!.state.kind).toBe('canceled')
  vi.setSystemTime(cache.refreshAt!)
  expect(await f.t.mutation(internal.workingMemory.resume, resume)).toBe(false)
  expect(await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [] })).toBe(false)
})

it.each(['membership', 'expiry', 'cancellation'] as const)('drops queued refresh after %s changes and never schedules a provider write', async change => {
  const f = await fixture(), c = (await f.claim())!
  const next = await completedTurn(f, 'Another synthetic conversation')
  await f.t.mutation(internal.workingMemory.claim, { jobId: next, lease: 'waiting' })
  const cache = (await f.t.run(ctx => ctx.db.get(c.id)))!
  await f.t.run(async ctx => {
    if (change === 'membership') await ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|owner')).unique())!._id)
    if (change === 'expiry') await ctx.db.patch((await ctx.db.get(next))!.sourceId, { expiresAt: Date.now() })
    if (change === 'cancellation') await ctx.db.patch(next, { cancelled: true })
  })
  vi.setSystemTime(cache.refreshAt!)
  expect(await f.t.mutation(internal.workingMemory.resume, { id: c.id, resetVersion: 0, expectedAt: cache.refreshAt! })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(c.id)))!.pendingJobId).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})

it('respects selection failure backoff when an earlier queued timer wakes and rejects its replay', async () => {
  const f = await fixture(), c = (await f.claim())!
  const next = await completedTurn(f, 'A newer synthetic parent preference')
  await f.t.mutation(internal.workingMemory.claim, { jobId: next, lease: 'queued' })
  const before = (await f.t.run(ctx => ctx.db.get(c.id)))!
  await f.t.mutation(internal.workingMemory.failed, { id: c.id, inputKey: c.inputKey, lease: c.lease })
  vi.setSystemTime(before.refreshAt!)
  const previousTimer = { id: c.id, resetVersion: 0, expectedAt: before.refreshAt! }
  expect(await f.t.mutation(internal.workingMemory.resume, previousTimer)).toBe(true)
  expect(await f.t.mutation(internal.workingMemory.claim, { jobId: next, lease: 'before-backoff' })).toBeNull()
  const after = (await f.t.run(ctx => ctx.db.get(c.id)))!
  expect(after.refreshAt).toBe(after.nextAttemptAt)
  expect(after.refreshAt).toBeGreaterThan(before.refreshAt!)
  expect(after.pendingJobId).toBe(next)
  expect(after.refreshTimerId).not.toBe(before.refreshTimerId)
  expect(await f.t.mutation(internal.workingMemory.resume, previousTimer)).toBe(false)
  vi.setSystemTime(after.refreshAt!)
  expect(await f.t.mutation(internal.workingMemory.resume, { id: c.id, resetVersion: 0, expectedAt: after.refreshAt! })).toBe(true)
  expect(await f.t.mutation(internal.workingMemory.claim, { jobId: next, lease: 'after-backoff' })).not.toBeNull()
})

it('does not carry an older derived reply through a replacement cache that lacks its sources', async () => {
  const f = await fixture(), c = (await f.claim())!
  await f.t.mutation(internal.workingMemory.finish, { id: c.id, inputKey: c.inputKey, lease: c.lease, context: c.context, notes: [{ jobId: f.ids[0], quote: 'vegetarian dinners' }] })
  vi.advanceTimersByTime(1)
  const earlier = await f.owner.mutation(api.jobs.submit, { text: 'What fits my earlier preferences?' })
  await f.t.mutation(internal.jobs.prepared, { jobId: earlier, sourceRevision: 1, conversation: true, actions: [], clarification: 'A vegetarian rice bowl.', workingContext: c.context })
  // A later selection legitimately dropped one of the earlier source records.
  await f.t.run(ctx => ctx.db.patch(c.id, { notes: [{ jobId: f.ids[1], quote: 'Synthetic discussion 1' }], context: { sources: [c.context.sources[1]], expiresAt: c.context.expiresAt } }))
  vi.advanceTimersByTime(1)
  const next = await f.owner.mutation(api.jobs.submit, { text: 'Tell me more about those ideas' })
  const context = (await f.t.query(internal.jobs.context, { jobId: next }))!.assistant!
  expect(context.workingMemory!.notes[0].quote).toBe('Synthetic discussion 1')
  expect(context.history.some(h => h.response.includes('vegetarian rice bowl'))).toBe(false)
})
