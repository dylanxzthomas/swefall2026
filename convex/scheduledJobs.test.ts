import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { event } from '../tests/fixtures/calendar'
vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.mocked(extractStructured).mockReset().mockResolvedValue({ actions: [event], clarification: '' }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const alice = t.withIdentity({ subject: 'alice', tokenIdentifier: 'test|alice' }), bob = t.withIdentity({ subject: 'bob', tokenIdentifier: 'test|bob' })
  const householdId = await alice.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await bob.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const input = { text: 'Prepare Maya’s synthetic school trip notice.', requestId: 'synthetic-schedule', runAt: Date.now() + 1000 }
  return { t, alice, bob, householdId, input }
}

it('prepares only when the durable timer is due, exactly once, and leaves actions awaiting approval', async () => {
  const f = await fixture(), jobId = await f.alice.mutation(api.jobs.schedule, f.input)
  expect(await f.alice.mutation(api.jobs.schedule, f.input)).toBe(jobId)
  expect((await f.alice.query(api.jobs.list, {}))[0]).toMatchObject({ scheduledFor: f.input.runAt, preparing: false, actions: [] })
  await f.t.action(internal.preparation.prepare, { jobId, sourceRevision: 1 })
  await f.t.mutation(internal.jobs.startScheduled, { jobId, sourceRevision: 1, runAt: f.input.runAt })
  await vi.advanceTimersByTimeAsync(999); await f.t.finishInProgressScheduledFunctions()
  expect(extractStructured).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  const job = (await f.alice.query(api.jobs.list, {}))[0]
  expect(job.scheduledFor).toBeUndefined(); expect(job.preparing).toBe(false)
  expect(job.actions).toHaveLength(1); expect(job.actions[0].status).toBe('review')
  await f.t.mutation(internal.jobs.startScheduled, { jobId, sourceRevision: 1, runAt: f.input.runAt })
  expect(await f.alice.mutation(api.jobs.schedule, f.input)).toBe(jobId)
  expect(extractStructured).toHaveBeenCalledTimes(1)
  expect(await f.t.run(async ctx => ({ approvals: await ctx.db.query('approvals').collect(), receipts: await ctx.db.query('receipts').collect(), attempts: await ctx.db.query('attempts').collect() }))).toEqual({ approvals: [], receipts: [], attempts: [] })
})

it('isolates schedules, rejects reused request IDs with changed contents, and guards invalid requests', async () => {
  const f = await fixture(), jobId = await f.alice.mutation(api.jobs.schedule, f.input)
  expect(await f.bob.query(api.jobs.list, {})).toEqual([])
  await expect(f.t.mutation(api.jobs.schedule, f.input)).rejects.toThrow('Sign in')
  await expect(f.bob.mutation(api.jobs.cancel, { jobId })).rejects.toThrow('unavailable')
  await expect(f.bob.mutation(api.jobs.reviseSource, { jobId, revision: 1, text: 'Changed school notice' })).rejects.toThrow('unavailable')
  await expect(f.alice.mutation(api.jobs.schedule, { ...f.input, text: 'Different school notice' })).rejects.toThrow('different scheduled')
  await expect(f.alice.mutation(api.jobs.addDraft, { jobId, payload: event })).rejects.toThrow('scheduled')
  for (const changes of [{ runAt: Date.now() - 1 }, { runAt: Date.now() + 367 * 86400_000 }, { text: ' ' }, { text: 'Hello Sola' }, { text: 'help' }, { text: 'What needs my attention?' }, { text: 'Can you read my email?' }, { text: 'Add buy sunscreen to my tasks' }, { requestId: '' }]) await expect(f.alice.mutation(api.jobs.schedule, { ...f.input, requestId: 'new-request', ...changes })).rejects.toThrow()
  expect(await f.alice.query(api.jobs.list, {})).toHaveLength(1)
})

it('preserves the future time across source edits and prevents the old revision from starting work', async () => {
  const f = await fixture(), jobId = await f.alice.mutation(api.jobs.schedule, f.input)
  const revisedText = 'Prepare the revised synthetic trip on October 9.'
  await expect(f.alice.mutation(api.jobs.reviseSource, { jobId, revision: 1, text: 'What can you do?' })).rejects.toThrow('prepare later')
  await f.alice.mutation(api.jobs.reviseSource, { jobId, revision: 1, text: revisedText })
  const revised = (await f.alice.query(api.jobs.list, {}))[0]
  expect(revised).toMatchObject({ scheduledFor: f.input.runAt, preparing: false, source: { text: revisedText, revision: 2 } })
  expect(extractStructured).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000); await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect(extractStructured).toHaveBeenCalledTimes(1)
  expect(vi.mocked(extractStructured).mock.calls[0][2]).toMatchObject({ source: revisedText })
  await f.t.mutation(internal.jobs.startScheduled, { jobId, sourceRevision: 1, runAt: f.input.runAt })
  expect(extractStructured).toHaveBeenCalledTimes(1)
})

it('cancels scheduled preparation without letting its timer or repeated submission resurrect it', async () => {
  const f = await fixture(), jobId = await f.alice.mutation(api.jobs.schedule, f.input)
  await f.alice.mutation(api.jobs.cancel, { jobId })
  expect(await f.alice.mutation(api.jobs.schedule, f.input)).toBe(jobId)
  await vi.advanceTimersByTimeAsync(1000); await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  const job = (await f.alice.query(api.jobs.list, {}))[0]
  expect(job).toMatchObject({ cancelled: true, preparing: false, actions: [] })
  expect(job.scheduledFor).toBeUndefined(); expect(extractStructured).not.toHaveBeenCalled()
  expect(job.source!.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 86400_000)
})

it('never starts scheduled work after household deletion or removal of the requesting adult', async () => {
  for (const change of ['deleted', 'membership']) {
    const f = await fixture(), jobId = await f.alice.mutation(api.jobs.schedule, f.input)
    await f.t.run(async ctx => {
      if (change === 'deleted') await ctx.db.patch(f.householdId, { deleted: true })
      else { const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|alice')).unique(); await ctx.db.delete(member!._id) }
    })
    await vi.advanceTimersByTimeAsync(1000); await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await f.t.run(ctx => ctx.db.get(jobId)))?.preparing).toBe(false)
    expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
    expect(extractStructured).not.toHaveBeenCalled()
  }
})

it('retains future instructions beyond the ordinary source window and expires them normally after cancellation', async () => {
  const f = await fixture(), scheduledFor = Date.now() + 60 * 86400_000
  const jobId = await f.alice.mutation(api.jobs.schedule, { ...f.input, runAt: scheduledFor })
  vi.setSystemTime(Date.now() + 31 * 86400_000)
  await f.t.mutation(internal.privacy.expireSources, {})
  let job = (await f.alice.query(api.jobs.list, {}))[0]
  expect(job.source?.text).toBe(f.input.text); expect(job.source?.expiresAt).toBe(scheduledFor + 30 * 86400_000)
  await f.alice.mutation(api.jobs.cancel, { jobId })
  vi.setSystemTime(Date.now() + 31 * 86400_000)
  await f.t.mutation(internal.privacy.expireSources, {})
  job = (await f.alice.query(api.jobs.list, {}))[0]
  expect(job.source?.text).toBeUndefined()
  await f.t.mutation(internal.jobs.startScheduled, { jobId, sourceRevision: 1, runAt: scheduledFor })
  expect(extractStructured).not.toHaveBeenCalled()
})
