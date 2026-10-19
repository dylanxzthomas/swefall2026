import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { event } from '../tests/fixtures/calendar'
import { coordinatorStep } from '../shared/assistantCoordinator'

vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('DAYMARK_MODEL', ''); vi.mocked(extractStructured).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const outsider = t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await parent.mutation(api.library.savePreferences, { parentName: 'Casey', assistantName: 'Sola' })
  return { t, parent, outsider, householdId }
}
const useModel = () => { vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic') }

it('saves chat-created household tasks atomically and answers with current state without a model or external effects', async () => {
  const f = await fixture()
  const id = await f.parent.mutation(api.jobs.submit, { text: 'Add buy sunscreen to my tasks' })
  await f.parent.mutation(api.jobs.submit, { text: 'Add buy sunscreen to my tasks' })
  const tasks = await f.parent.query(api.personalTasks.list, {})
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ title: 'buy sunscreen', done: false })
  expect((await f.parent.query(api.jobs.list, {})).find(j => j._id === id)).toMatchObject({ conversation: true, actions: [] })
  const status = await f.parent.mutation(api.jobs.submit, { text: 'What needs my attention?' })
  expect((await f.t.run(ctx => ctx.db.get(status)))?.clarification).toContain('buy sunscreen')
  await f.parent.mutation(api.personalTasks.setDone, { id: tasks[0].id as any, version: 1, done: true })
  const refreshed = await f.parent.mutation(api.jobs.submit, { text: 'What needs my attention?' })
  expect(refreshed).not.toBe(status)
  expect((await f.t.run(ctx => ctx.db.get(refreshed)))?.clarification).toContain('Nothing in your saved tasks')
  expect(await f.outsider.query(api.personalTasks.list, {})).toEqual([])
  expect(await f.t.run(async ctx => [await ctx.db.query('actions').collect(), await ctx.db.query('approvals').collect(), await ctx.db.query('attempts').collect()])).toEqual([[], [], []])
  expect(extractStructured).not.toHaveBeenCalled()
})

it('grounds independent account answers in scopes and revocation, without claiming mail monitoring', async () => {
  const f = await fixture(); vi.stubEnv('MICROSOFT_CLIENT_ID', 'synthetic'); vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'synthetic')
  const connection = await f.t.run(async ctx => {
    const id = await ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|parent', provider: 'microsoft', version: 1, status: 'active', scopes: ['Mail.Send'], cipher: 'must-not-reach-the-model' })
    await ctx.db.insert('connectionPreferences', { householdId: f.householdId, subject: 'test|parent', emailConnectionId: id, version: 1 })
    return id
  })
  const ready = await f.parent.mutation(api.jobs.submit, { text: 'Can you send email?' })
  expect((await f.t.run(ctx => ctx.db.get(ready)))?.clarification).toMatch(/Outlook|approved/i)
  await f.t.run(ctx => ctx.db.patch(connection, { status: 'revoked' }))
  const revoked = await f.parent.mutation(api.jobs.submit, { text: 'Can you send email?' })
  expect((await f.t.run(ctx => ctx.db.get(revoked)))?.clarification).toMatch(/Reconnect/i)
  const scan = await f.parent.mutation(api.jobs.submit, { text: 'Can you read my email?' })
  expect((await f.t.run(ctx => ctx.db.get(scan)))?.clarification).toMatch(/not|isn’t|can’t/i)
  expect(extractStructured).not.toHaveBeenCalled()
})

it('keeps unfamiliar conversation inline when no model is configured', async () => {
  const f = await fixture()
  const id = await f.parent.mutation(api.jobs.submit, { text: 'I’m overwhelmed by the weekend plans.' })
  const job = (await f.parent.query(api.jobs.list, {})).find(j => j._id === id)
  expect(job).toMatchObject({ conversation: true, preparing: false, actions: [] })
  expect(job?.clarification).toContain('conversation isn’t connected')
  expect(await f.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())).toEqual([])
})

it('supplies bounded same-adult history and safe capabilities to conversational preparation', async () => {
  const f = await fixture()
  const first = await f.parent.mutation(api.jobs.submit, { text: 'Hello' })
  await f.t.run(async ctx => {
    await ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' })
    for (const [subject, text, expiresAt] of [['test|other', 'other adult private conversation', Date.now() + 10000], ['test|parent', 'expired conversation', Date.now() - 1]] as const) {
      const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text, hash: text, revision: 1, expiresAt })
      await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: subject, sourceId, conversation: true, preparing: false, cancelled: false, clarification: text })
    }
    await ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|parent', version: 1, status: 'active', scopes: ['gmail.send'], cipher: 'NEVER_INCLUDE_THIS' })
  })
  useModel()
  const answer = 'Let’s start with what needs doing before the weekend. What’s the most pressing thing?'
  vi.mocked(extractStructured).mockResolvedValue(coordinatorStep.parse({ tool: 'finish', query: '', id: '', from: '', through: '', answer, drafts: [] }))
  const id = await f.parent.mutation(api.jobs.submit, { text: 'Help me think through the weekend.' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  const input = vi.mocked(extractStructured).mock.calls[0][2] as any
  expect(input.assistant.parentName).toBe('Casey')
  expect(input.assistant.history).toHaveLength(1)
  expect(input.assistant.history[0].request).toBe('Hello')
  expect(JSON.stringify(input)).not.toMatch(/NEVER_INCLUDE_THIS|expired conversation|other adult private conversation/)
  const job = (await f.parent.query(api.jobs.list, {})).find(j => j._id === id)
  expect(job).toMatchObject({ conversation: true, preparing: false, actions: [] })
  expect(job?.clarification).toBe(answer)
  expect(await f.t.run(ctx => ctx.db.query('notifications').collect())).toEqual([])
  // A repeated question gets a fresh answer, not the old notice deduplication result.
  expect(await f.parent.mutation(api.jobs.submit, { text: 'Help me think through the weekend.' })).not.toBe(id)
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect(first).not.toBe(id)
})

it('keeps prepared outcomes behind review even when a model adds unsupported approval fields', async () => {
  const f = await fixture(); useModel()
  vi.mocked(extractStructured).mockImplementation(async schema => schema === coordinatorStep
    ? coordinatorStep.parse({ tool: 'prepare_notice', query: '', id: '', from: '', through: '', answer: '', drafts: [] })
    : { actions: [{ ...event, approved: true }], clarification: 'The calendar draft is ready for review.', approved: true, send: true } as any)
  const id = await f.parent.mutation(api.jobs.submit, { text: 'Prepare a calendar event for Maya’s field trip.' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  const job = (await f.parent.query(api.jobs.list, {})).find(j => j._id === id)!
  expect(job.conversation).not.toBe(true)
  expect(job.actions).toHaveLength(1)
  expect(job.actions[0]).toMatchObject({ status: 'review', receipts: [] })
  expect(job.actions[0].payload.approved).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  expect(vi.mocked(extractStructured).mock.calls.map(call => call[0] === coordinatorStep)).toEqual([true, false])
})

it('rejects contradictory model replies and lets interrupted work recover without external execution', async () => {
  const f = await fixture(); useModel()
  vi.mocked(extractStructured).mockResolvedValue({ conversation: true, actions: [event], clarification: 'Done.' })
  const id = await f.parent.mutation(api.jobs.submit, { text: 'Help me with the weekend.' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect((await f.parent.query(api.jobs.list, {})).find(j => j._id === id)).toMatchObject({ preparing: false, actions: [], clarification: 'Preparation stopped. Your request is saved; retry below.' })
  vi.mocked(extractStructured).mockRejectedValue(new Error('Interrupted synthetic model call'))
  await expect(f.parent.mutation(api.jobs.reviseSource, { jobId: id, revision: 1, text: 'Help me prepare for a family event.' })).rejects.toThrow('Private assistant preparation stays private')
  const next = await f.parent.mutation(api.jobs.submit,{text:'Help me prepare for a family event.'})
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect((await f.t.run(ctx => ctx.db.get(next)))?.preparing).toBe(false)
  expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
})

it('drops cancelled, stale and deauthorized conversation results', async () => {
  const f = await fixture(); useModel()
  const id = await f.parent.mutation(api.jobs.submit, { text: 'Help me organize this weekend.' })
  const args = { jobId: id, sourceRevision: 1, actions: [], clarification: 'A stale reply', conversation: true }
  await f.t.run(async ctx => { const job = await ctx.db.get(id); await ctx.db.patch(job!.sourceId, { revision: 2 }) })
  await f.t.mutation(internal.jobs.prepared, args)
  expect((await f.t.run(ctx => ctx.db.get(id)))?.clarification).toBe('')
  await f.parent.mutation(api.jobs.cancel, { jobId: id })
  await f.t.mutation(internal.jobs.prepared, { ...args, sourceRevision: 2 })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.conversation).not.toBe(true)
  const next = await f.parent.mutation(api.jobs.submit, { text: 'Help me organize next weekend.' })
  await f.t.run(async ctx => { const m = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(m!._id) })
  await f.t.mutation(internal.jobs.prepared, { ...args, jobId: next })
  expect((await f.t.run(ctx => ctx.db.get(next)))?.clarification).toContain('no longer has household access')
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect(extractStructured).not.toHaveBeenCalled()
})

it('keeps identical pending chat questions separate for each adult and includes work that needs clarification', async () => {
  const f = await fixture(); useModel()
  const other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await f.t.run(ctx => ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' }))
  await other.mutation(api.library.savePreferences, { parentName: 'Jordan', assistantName: 'Skye' })
  vi.mocked(extractStructured).mockResolvedValue({ conversation: true, actions: [], clarification: 'What would you like to sort out first?' })
  const first = await f.parent.mutation(api.jobs.submit, { text: 'How should I approach this weekend?' })
  const second = await other.mutation(api.jobs.submit, { text: 'How should I approach this weekend?' })
  expect(first).not.toBe(second)
  const unfinished = await f.parent.mutation(api.jobs.submit, { text: 'Prepare the school trip.' })
  await f.t.mutation(internal.jobs.prepared, { jobId: unfinished, sourceRevision: 1, actions: [], clarification: 'Which date?' })
  const context = await f.t.query(internal.jobs.context, { jobId: second })
  expect(context?.assistant?.parentName).toBe('Jordan')
  expect(context?.assistant?.currentWork.some(j => j.status === 'Which date?')).toBe(true)
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
})

it('recognizes eligible in-app caregiver delivery without transactional email configuration', async () => {
  const f = await fixture()
  vi.stubEnv('RESEND_API_KEY', ''); vi.stubEnv('DAYMARK_EMAIL_FROM', ''); vi.stubEnv('DAYMARK_WEB_URL', '')
  await f.t.run(async ctx => {
    const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|outsider')).unique()
    await ctx.db.insert('caregivers', { householdId: f.householdId, name: 'Synthetic caregiver', email: 'caregiver@example.test', childIds: ['maya'] })
    await ctx.db.insert('pickupPreferences', { householdId: member!.householdId, subject: 'test|outsider', email: 'caregiver@example.test', channel: 'app' })
  })
  const id = await f.parent.mutation(api.jobs.submit, { text: 'Can you arrange pickups?' })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.clarification).toContain('after your approval')
  expect((await f.t.run(ctx => ctx.db.get(id)))?.clarification).not.toContain('needs setup')
})

it('expires generated conversation text along with its source while preserving confirmed tasks', async () => {
  const f = await fixture()
  const id = await f.parent.mutation(api.jobs.submit, { text: 'Add buy sunscreen to my tasks' })
  await f.t.run(async ctx => { const job = await ctx.db.get(id); await ctx.db.patch(job!.sourceId, { expiresAt: Date.now() - 1 }) })
  await f.t.mutation(internal.privacy.expireSources, {})
  const job = (await f.parent.query(api.jobs.list, {})).find(j => j._id === id)
  expect(job?.source?.text).toBeUndefined()
  expect(job?.clarification).toBe('This conversation has expired.')
  expect((await f.parent.query(api.personalTasks.list, {}))[0].title).toBe('buy sunscreen')
})

it('avoids false all-clears and duplicate task creation when the bounded context is incomplete', async () => {
  const f = await fixture()
  await f.parent.mutation(api.jobs.submit, { text: 'Add buy sunscreen to my tasks' })
  await f.t.run(async ctx => {
    for (let i = 0; i < 102; i++) await ctx.db.insert('personalTasks', { householdId: f.householdId, requestId: `synthetic-${i}`, requestHash: `synthetic-${i}`, title: `Synthetic task ${i}`, notes: '', done: true, version: 1, createdAt: Date.now(), updatedAt: Date.now() })
  })
  const status = await f.parent.mutation(api.jobs.submit, { text: 'What needs my attention?' })
  expect((await f.t.run(ctx => ctx.db.get(status)))?.clarification).toContain('more saved records')
  const repeated = await f.parent.mutation(api.jobs.submit, { text: 'Add buy sunscreen to my tasks' })
  expect((await f.t.run(ctx => ctx.db.get(repeated)))?.clarification).toContain('haven’t added')
  expect((await f.parent.query(api.personalTasks.list, {})).filter(t => t.title === 'buy sunscreen')).toHaveLength(1)
})
