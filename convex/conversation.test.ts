import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { event } from '../tests/fixtures/calendar'
import { coordinatorStep } from '../shared/assistantCoordinator'
import { recordedConversationResponse, unavailableConversationResponse } from '../server/modelMessages'
import type { ActionStatus } from '../shared/daymark'
import { sourceHash } from '../shared/daymark'
vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.mocked(extractStructured).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const alice = t.withIdentity({ subject: 'alice', tokenIdentifier: 'test|alice' }), bob = t.withIdentity({ subject: 'bob', tokenIdentifier: 'test|bob' })
  const householdId = await alice.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const otherHouseholdId = await bob.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await alice.mutation(api.library.savePreferences, { parentName: 'Taylor', assistantName: 'Skye' })
  await bob.mutation(api.library.savePreferences, { parentName: 'Casey', assistantName: 'Juniper' })
  return { t, alice, bob, householdId, otherHouseholdId }
}

it('keeps failed turns private and retries preparation once under simultaneous owner requests', async () => {
  const f = await fixture(), other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await f.t.run(ctx => ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' }))
  const id = await f.alice.mutation(api.jobs.submit, { text: 'Discuss a sensitive synthetic household concern' })
  await f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, preparationFailed: true, actions: [], clarification: 'Preparation stopped. Your source is saved.' })
  expect((await f.alice.query(api.jobs.list, {}))[0]).toMatchObject({ conversation: true, emailPreparationFailed: true, preparing: false })
  expect(await other.query(api.jobs.list, {})).toEqual([])
  await expect(other.mutation(api.jobs.retryConversation, { jobId: id, sourceRevision: 1 })).rejects.toThrow('cannot be retried')
  expect(await f.t.run(ctx => ctx.db.query('notifications').collect())).toEqual([])
  const retries = await Promise.allSettled(Array.from({ length: 50 }, () => f.alice.mutation(api.jobs.retryConversation, { jobId: id, sourceRevision: 1 })))
  expect(retries.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect((await f.t.run(ctx => ctx.db.get(id)))!).toMatchObject({ preparing: true, conversation: true })
  const sourceId = (await f.t.run(ctx => ctx.db.get(id)))!.sourceId
  expect((await f.t.run(ctx => ctx.db.get(sourceId)))!.revision).toBe(2)
  await f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, conversation: true, actions: [], clarification: 'Obsolete response' })
  expect((await f.t.run(ctx => ctx.db.get(id)))!.preparing).toBe(true)
  await f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 2, conversation: true, actions: [], clarification: 'A new private answer.' })
  expect((await f.alice.query(api.jobs.list, {}))[0].clarification).toBe('A new private answer.')
  expect(await other.query(api.jobs.list, {})).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})

it.each(['expired', 'membership', 'model'] as const)('retains privacy when preparation stops because of %s', async change => {
  const f = await fixture(), other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await f.t.run(ctx => ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' }))
  const id = await f.alice.mutation(api.jobs.submit, { text: 'Discuss a sensitive synthetic concern' })
  await f.t.run(async ctx => {
    if (change === 'expired') await ctx.db.patch((await ctx.db.get(id))!.sourceId, { expiresAt: Date.now() })
    if (change === 'membership') await ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|alice')).unique())!._id)
  })
  if (change === 'model') vi.stubEnv('ANTHROPIC_API_KEY', '')
  await f.t.action(internal.preparation.prepare, { jobId: id, sourceRevision: 1 })
  expect((await f.t.run(ctx => ctx.db.get(id)))!).toMatchObject({ preparing: false, conversation: true })
  expect(await other.query(api.jobs.list, {})).toEqual([])
  await expect(f.alice.mutation(api.jobs.retryConversation, { jobId: id, sourceRevision: 1 })).rejects.toThrow()
  expect(extractStructured).not.toHaveBeenCalled()
})

it('protects old failed turns without preventing explicit manual household draft creation', async () => {
  const f = await fixture(), other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await f.t.run(ctx => ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' }))
  const id = await f.alice.mutation(api.jobs.submit, { text: 'A synthetic request needing another attempt' })
  await f.t.run(ctx => ctx.db.patch(id, { preparing: false, conversation: undefined, emailPreparationFailed: true }))
  expect(await other.query(api.jobs.list, {})).toEqual([])
  await f.alice.mutation(api.jobs.addDraft, { jobId: id, payload: event })
  expect((await other.query(api.jobs.list, {}))[0].actions).toHaveLength(1)
})

it('answers curated conversation with current preferences without a workflow, model call, or external work', async () => {
  const f = await fixture(), first = await f.alice.mutation(api.jobs.submit, { text: 'Hello' })
  await f.alice.mutation(api.library.savePreferences, { parentName: 'Alex', assistantName: 'Skye' })
  const second = await f.alice.mutation(api.jobs.submit, { text: 'Hello' })
  expect(second).not.toBe(first)
  await f.alice.mutation(api.jobs.submit, { text: 'Thank you!' })
  const help = await f.alice.mutation(api.jobs.submit, { text: 'What can you do?' })
  const jobs = await f.alice.query(api.jobs.list, {})
  expect(jobs.find(job => job._id === first)?.clarification).toContain('Hi, Taylor.')
  expect(jobs.find(job => job._id === second)?.clarification).toContain('Hi, Alex.')
  expect(jobs.find(job => job._id === help)?.clarification).toContain('Connected accounts are needed')
  for (const job of jobs) {
    expect(job).toMatchObject({ conversation: true, preparing: false, createdBy: 'test|alice', householdId: f.householdId, actions: [] })
    expect(job.source?.expiresAt).toBe(Date.now() + 30 * 86400_000)
  }
  const sideEffects = await f.t.run(async ctx => ({ scheduled: await ctx.db.system.query('_scheduled_functions').collect(), actions: await ctx.db.query('actions').collect(), approvals: await ctx.db.query('approvals').collect(), attempts: await ctx.db.query('attempts').collect(), receipts: await ctx.db.query('receipts').collect(), notifications: await ctx.db.query('notifications').collect() }))
  expect(sideEffects).toEqual({ scheduled: [], actions: [], approvals: [], attempts: [], receipts: [], notifications: [] })
  expect(extractStructured).not.toHaveBeenCalled()
})

it('isolates conversation and personal replies by household and submitting adult', async () => {
  const f = await fixture(), aliceId = await f.alice.mutation(api.jobs.submit, { text: 'Hello Skye' }), bobId = await f.bob.mutation(api.jobs.submit, { text: 'Hello Juniper' })
  expect((await f.alice.query(api.jobs.list, {})).map(job => job._id)).toEqual([aliceId])
  expect((await f.bob.query(api.jobs.list, {})).map(job => job._id)).toEqual([bobId])
  await expect(f.bob.mutation(api.jobs.reviseSource, { jobId: aliceId, text: 'Hello', revision: 1 })).rejects.toThrow('unavailable')
  await expect(f.t.mutation(api.jobs.submit, { text: 'Hello' })).rejects.toThrow('Sign in')
  await expect(f.t.query(api.jobs.list, {})).rejects.toThrow('Sign in')
  // Another adult in the same household gets their own preferences, never the first adult's name.
  const other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await f.t.run(ctx => ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' }))
  await other.mutation(api.library.savePreferences, { parentName: 'Jordan', assistantName: 'Ash' })
  const otherId = await other.mutation(api.jobs.submit, { text: 'Hello Ash' })
  expect((await f.t.run(ctx => ctx.db.get(otherId)))?.clarification).toContain('Hi, Jordan.')
  expect((await other.query(api.jobs.list, {})).map(job => job._id)).toEqual([otherId])
  expect((await f.alice.query(api.jobs.list, {})).map(job => job._id)).toEqual([aliceId])
  await expect(other.mutation(api.jobs.reviseSource, { jobId: aliceId, text: 'Prepare a trip', revision: 1 })).rejects.toThrow('unavailable')
  await expect(other.mutation(api.jobs.cancel, { jobId: aliceId })).rejects.toThrow('unavailable')
  await expect(other.mutation(api.jobs.addDraft, { jobId: aliceId, payload: event })).rejects.toThrow('unavailable')
  // A stale preference belonging to a former household must not personalize this household's reply.
  await f.t.run(async ctx => { const preference = await ctx.db.query('personalPreferences').withIndex('by_subject', q => q.eq('subject', 'test|other')).unique(); await ctx.db.patch(preference!._id, { householdId: f.otherHouseholdId }) })
  const unpersonalized = await other.mutation(api.jobs.submit, { text: 'Hello' })
  expect((await f.t.run(ctx => ctx.db.get(unpersonalized)))?.clarification).toMatch(/^Hi\. /)
  expect(extractStructured).not.toHaveBeenCalled()
})

it('keeps unclassified turns and their files private until they become household deliverables', async () => {
  const f = await fixture(), other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await f.t.run(ctx => ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' }))
  const file = await f.t.run(async ctx => {
    const storageId = await ctx.storage.store(new Blob(['synthetic private text']))
    return ctx.db.insert('attachments', { householdId: f.householdId, subject: 'test|alice', storageId, name: 'private.png', size: 22, hash: 'synthetic', mediaType: 'image/png', status: 'ready', expiresAt: Date.now() + 86400_000 })
  })
  await expect(other.query(api.intake.status, { ids: [file] })).rejects.toThrow('unavailable')
  const id = await f.alice.mutation(api.jobs.submit, { text: 'Please prepare this notice', attachmentIds: [file] })
  expect(await other.query(api.jobs.list, {})).toEqual([])
  await expect(other.mutation(api.jobs.cancel, { jobId: id })).rejects.toThrow('unavailable')
  await expect(other.query(internal.intake.readable, { id: file })).rejects.toThrow('unavailable')
  await expect(other.mutation(internal.library.copyContext, { ids: [file], jobId: id })).rejects.toThrow('unavailable')
  vi.mocked(extractStructured).mockResolvedValue({ conversation: false, actions: [event], clarification: 'Calendar draft ready for review.' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect((await other.query(api.jobs.list, {})).map(j => j._id)).toEqual([id])
  expect(await other.query(internal.intake.readable, { id: file })).toMatchObject({ mediaType: 'image/png' })
  // Final household work can be reviewed without inheriting another adult's chat history.
  expect((await other.query(api.jobs.list, {}))[0].actions).toHaveLength(1)
})

it('still prepares operational text and greetings attached to a notice, preserving notice deduplication', async () => {
  const f = await fixture()
  vi.mocked(extractStructured).mockImplementation(async schema => schema === coordinatorStep
    ? coordinatorStep.parse({ tool: 'prepare_notice', query: '', id: '', from: '', through: '', answer: '', drafts: [] })
    : { actions: [event], clarification: '' } as any)
  const input = { text: 'Hello, prepare Maya’s school trip for October 8 at 2 PM.' }
  const notice = await f.alice.mutation(api.jobs.submit, input)
  expect(await f.alice.mutation(api.jobs.submit, input)).toBe(notice)
  const attachmentId = await f.t.run(async ctx => {
    const blob = new Blob(['synthetic school notice'], { type: 'image/png' }), storageId = await ctx.storage.store(blob)
    return ctx.db.insert('attachments', { householdId: f.householdId, subject: 'test|alice', storageId, name: 'school.png', size: blob.size, hash: 'synthetic-image', mediaType: 'image/png', status: 'ready', expiresAt: Date.now() + 86400_000 })
  })
  await expect(f.bob.mutation(api.jobs.submit, { text: 'Hello', attachmentIds: [attachmentId] })).rejects.toThrow('Attachments are unavailable')
  const attached = await f.alice.mutation(api.jobs.submit, { text: 'Hello', attachmentIds: [attachmentId] })
  for (const id of [notice, attached]) expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ preparing: true, clarification: '' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect(extractStructured).toHaveBeenCalledTimes(3)
  expect(vi.mocked(extractStructured).mock.calls.filter(call => call[0] === coordinatorStep)).toHaveLength(1)
  for (const job of await f.alice.query(api.jobs.list, {})) {
    expect(job.conversation).not.toBe(true)
    expect(job.preparing).toBe(false)
    expect(job.actions).toHaveLength(1)
    expect(job.actions[0].status).toBe('review')
  }
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})

const directAnswer=(answer:string)=>({tool:'finish',query:'',id:'',from:'',through:'',answer,drafts:[]})

it('keeps a former assistant greeting separate from new context-dependent conversation turns', async () => {
  const f = await fixture(), greeting = await f.alice.mutation(api.jobs.submit, { text: 'Hello Skye' })
  await f.alice.mutation(api.library.savePreferences, { parentName: 'Taylor', assistantName: 'Juniper' })
  vi.mocked(extractStructured).mockResolvedValue(directAnswer('What school detail should I prepare?'))
  const notice = await f.alice.mutation(api.jobs.submit, { text: 'Hello Skye' })
  expect(notice).not.toBe(greeting)
  expect(await f.alice.mutation(api.jobs.submit, { text: 'Hello Skye' })).not.toBe(notice)
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect((await f.t.run(ctx => ctx.db.get(notice)))?.conversation).toBe(true)
  expect((await f.t.run(ctx => ctx.db.get(notice)))?.clarification).toBe('What school detail should I prepare?')
  expect(extractStructured).toHaveBeenCalledTimes(2)
})

it('turns an explicitly revised conversational source into an ordinary reviewable request', async () => {
  const f = await fixture(), greeting = await f.alice.mutation(api.jobs.submit, { text: 'Hello' })
  vi.mocked(extractStructured).mockImplementation(async schema => schema === coordinatorStep
    ? coordinatorStep.parse({ tool: 'prepare_notice', query: '', id: '', from: '', through: '', answer: '', drafts: [] })
    : { actions: [], clarification: 'Confirm the school trip date.' } as any)
  await f.alice.mutation(api.jobs.reviseSource, { jobId: greeting, text: 'Prepare the school trip notice.', revision: 1 })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  const revised = await f.t.run(ctx => ctx.db.get(greeting))
  expect(revised?.conversation).not.toBe(true)
  expect(revised).toMatchObject({ preparing: false, clarification: 'Confirm the school trip date.' })
  expect(extractStructured).toHaveBeenCalledTimes(2)
})

it('passes durable same-adult dinner history to the next model turn and retains it for a fresh client', async () => {
  const f = await fixture()
  vi.mocked(extractStructured).mockResolvedValueOnce(directAnswer('Pasta or tacos are easy dinner options.'))
  await f.alice.mutation(api.jobs.submit, { text: 'what should I order for dinner' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  vi.mocked(extractStructured).mockResolvedValueOnce(directAnswer('In general, I’d pick tacos for dinner.'))
  await f.alice.mutation(api.jobs.submit, { text: 'just in general' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  const history = [{ request: 'what should I order for dinner', response: 'Pasta or tacos are easy dinner options.' }]
  expect(vi.mocked(extractStructured).mock.calls[1][5]).toEqual(history)
  const freshClient = f.t.withIdentity({ subject: 'alice', tokenIdentifier: 'test|alice' })
  vi.mocked(extractStructured).mockResolvedValueOnce(directAnswer('Try bean tacos.'))
  await freshClient.mutation(api.jobs.submit, { text: 'make those vegetarian' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect(vi.mocked(extractStructured).mock.calls[2][5]).toEqual([...history, { request: 'just in general', response: 'In general, I’d pick tacos for dinner.' }])
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('personalTasks').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('memoryFacts').filter(q => q.neq(q.field('key'), 'timezone')).filter(q => q.neq(q.field('key'), 'children')).collect())).toEqual([])
})

it('keeps prepared work and its clarification when the next turn reaches the coordinator', async () => {
  const f = await fixture()
  const first = await f.alice.mutation(api.jobs.submit, { text: 'Prepare Maya’s school trip on 2026-10-09 at 08:30.' })
  await f.t.mutation(internal.jobs.prepared, { jobId: first, sourceRevision: 1, actions: [event], clarification: 'Maya’s trip is ready for review. Is School the right location?' })
  vi.advanceTimersByTime(1)
  const followup = await f.alice.mutation(api.jobs.submit, { text: 'Actually, make it 3 PM and keep that location.' })
  const context = (await f.t.query(internal.jobs.context, { jobId: followup }))!
  const prior = (await f.alice.query(api.jobs.list, {})).find(j => j._id === first)!
  const response = recordedConversationResponse({ ...prior, actions: prior.actions.map(action => ({ ...action, status: action.status as ActionStatus })) })
  expect(context.assistant!.history.at(-1)).toMatchObject({ response })
  const runId = await f.t.mutation(internal.assistantCoordinator.start, { jobId: followup, sourceRevision: 1 })
  const run = (await f.t.run(ctx => ctx.db.get(runId!)))!
  expect(JSON.parse(run.baseContext!).history.at(-1)).toEqual({ request: 'Prepare Maya’s school trip on 2026-10-09 at 08:30.', response })
  vi.mocked(extractStructured).mockResolvedValueOnce(directAnswer('I understand the correction to Maya’s trip.'))
  await f.t.action(internal.coordinatorWorker.step, { id: run._id, version: run.version })
  expect(vi.mocked(extractStructured).mock.calls[0][5]?.at(-1)?.response).toContain('Is School the right location?')
  expect((await f.t.run(ctx => ctx.db.query('actions').collect()))).toHaveLength(1)
})

it('retains parent constraints after saved work changes without reusing stale derived answers', async () => {
  const f = await fixture()
  vi.mocked(extractStructured).mockResolvedValueOnce(directAnswer('Try bean tacos or rice bowls without mushrooms.'))
  const first = await f.alice.mutation(api.jobs.submit, { text: 'Suggest dinner. No mushrooms, please.' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  await f.alice.mutation(api.jobs.submit, { text: 'Add buy batteries to my tasks' })
  vi.advanceTimersByTime(1)
  const followup = await f.alice.mutation(api.jobs.submit, { text: 'Make those vegetarian.' })
  const history = (await f.t.query(internal.jobs.context, { jobId: followup }))!.assistant!.history
  expect(history.find(h => h.request === 'Suggest dinner. No mushrooms, please.')).toEqual({ request: 'Suggest dinner. No mushrooms, please.', response: unavailableConversationResponse, sourceOnly: true })
  expect(JSON.stringify(history)).not.toContain('Try bean tacos')
  const runId = await f.t.mutation(internal.assistantCoordinator.start, { jobId: followup, sourceRevision: 1 })
  const run = (await f.t.run(ctx => ctx.db.get(runId!)))!
  expect(JSON.parse(run.baseContext!).history.find((h: { request: string }) => h.request.startsWith('Suggest dinner'))).toMatchObject({ sourceOnly: true })
  expect(run.privateOnly).not.toBe(true) // Omitted private answers must not permanently disable new standalone work.
  const oldSource = (await f.t.run(ctx => ctx.db.get(first)))!.sourceId
  expect(run.refs.some((r: any) => r.kind === 'source' && r.id === oldSource)).toBe(true)
  // Hiding/revising the original parent source still invalidates the retained topic.
  await f.t.run(ctx => ctx.db.patch(oldSource, { revision: 2 }))
  vi.mocked(extractStructured).mockReset()
  await f.t.action(internal.coordinatorWorker.step, { id: run._id, version: run.version })
  expect(extractStructured).not.toHaveBeenCalled()
})

it.each(['email', 'watch', 'noninteractive', 'cancelled', 'expired', 'other-adult'] as const)('does not recover %s source text through the private parent-only fallback', async kind => {
  const f = await fixture()
  const oldId = await f.t.run(async ctx => {
    const text = `Excluded synthetic source ${kind}`
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text, hash: kind === 'watch' ? 'calendar-assistance:synthetic' : `synthetic-${kind}`, revision: 1, expiresAt: kind === 'expired' ? Date.now() - 1 : Date.now() + 86400000,
      ...(kind === 'email' ? { email: { sender: 'school@example.test', subject: 'Synthetic source', receivedAt: Date.now(), extraction: { format: 'plain' as const, truncated: false, incomplete: false, attachments: false, issues: [] } } } : {}) })
    const createdBy = kind === 'other-adult' ? 'test|other' : 'test|alice'
    const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, sourceId, createdBy, interactive: kind !== 'noninteractive', preparing: false, conversation: true, cancelled: kind === 'cancelled', clarification: 'Unavailable private derived answer.' })
    const assistantRunId = await ctx.db.insert('assistantRuns', { householdId: f.householdId, createdBy, jobId, sourceId, sourceRevision: 1, sourceHash: sourceHash(text), version: 1, status: 'complete', step: 1, attempts: 1, used: [], observations: '[]', refs: [{ kind: 'family', id: f.householdId, version: 0, hash: 'obsolete' }], answer: 'Unavailable private derived answer.', createdAt: Date.now(), expiresAt: Date.now() + 86400000 })
    await ctx.db.patch(jobId, { assistantRunId })
    return jobId
  })
  vi.advanceTimersByTime(1)
  const next = await f.alice.mutation(api.jobs.submit, { text: 'What should I do next?' })
  const context = (await f.t.query(internal.jobs.context, { jobId: next }))!.assistant!
  expect(JSON.stringify(context.history)).not.toContain('Excluded synthetic source')
  expect(JSON.stringify(context.history)).not.toContain('Unavailable private derived answer')
  const old = await f.t.run(ctx => ctx.db.get(oldId))
  expect(old).not.toBeNull() // Exclusion must not destroy saved data.
})

it('excludes another adult, another household, expired, cancelled, pending, future and scheduled turns from working context', async () => {
  const f = await fixture()
  const insert = async (text: string, changes: Record<string, unknown> = {}, sourceChanges: Record<string, unknown> = {}) => f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text, revision: 1, hash: text, expiresAt: Date.now() + 86400000, ...sourceChanges })
    return ctx.db.insert('jobs', { householdId: f.householdId, sourceId, createdBy: 'test|alice', conversation: true, preparing: false, cancelled: false, clarification: `Reply to ${text}`, ...changes })
  })
  await insert('Other adult', { createdBy: 'test|other' })
  await insert('Other household', { householdId: f.otherHouseholdId })
  await insert('Wrong source household', {}, { householdId: f.otherHouseholdId })
  await insert('Expired', {}, { expiresAt: Date.now() - 1 })
  await insert('Cancelled', { cancelled: true })
  await insert('Pending', { preparing: true })
  await insert('Scheduled', { scheduledFor: Date.now() + 60000 })
  for (let i = 0; i < 15; i++) await insert(`Completed ${i}`)
  const id = await insert('Current', { interactive: true, conversation: undefined, preparing: true })
  await insert('Future')
  const context = await f.t.query(internal.jobs.context, { jobId: id })
  expect(context?.assistant?.history.map(h => h.request)).toEqual(Array.from({ length: 12 }, (_, i) => `Completed ${i + 3}`))
  await f.t.run(async ctx => { const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|alice')).unique(); await ctx.db.delete(member!._id) })
  expect(await f.t.query(internal.jobs.context, { jobId: id })).toBeNull()
})

it('retains the last completed exchange through a burst of pending and later submissions', async () => {
  const f = await fixture()
  vi.setSystemTime(Date.parse('2026-10-08T09:00:00Z'))
  const insert = async (text: string, preparing: boolean) => f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text, revision: 1, hash: text, expiresAt: Date.now() + 86400000 })
    return ctx.db.insert('jobs', { householdId: f.householdId, sourceId, createdBy: 'test|alice', interactive: true, conversation: preparing ? undefined : true, preparing, cancelled: false, clarification: preparing ? '' : 'Try vegetarian tacos.' })
  })
  await insert('Suggest vegetarian dinner', false)
  for (let i = 0; i < 50; i++) { vi.advanceTimersByTime(1); await insert(`Pending earlier ${i}`, true) }
  vi.advanceTimersByTime(1)
  const current = await insert('Make those gluten-free', true)
  for (let i = 0; i < 50; i++) { vi.advanceTimersByTime(1); await insert(`Completed later ${i}`, false) }
  const context = await f.t.query(internal.jobs.context, { jobId: current })
  expect(context?.assistant?.history).toEqual([{ request: 'Suggest vegetarian dinner', response: 'Try vegetarian tacos.' }])
})

it('uses the bounded coordinator for discussion and refuses model-invented execution', async () => {
  const f = await fixture()
  vi.mocked(extractStructured).mockResolvedValue({ actions: [event], clarification: 'An invented calendar change.' })
  const id = await f.alice.mutation(api.jobs.submit, { text: 'What should I order for dinner?' })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  const job = (await f.alice.query(api.jobs.list, {})).find(j => j._id === id)!
  expect(job).toMatchObject({ conversation: true, emailPreparationFailed: true, actions: [] })
  const prompt = vi.mocked(extractStructured).mock.calls[0][1]
  expect(prompt).not.toContain('The following extraction rules')
  expect(prompt).toContain('No tool sends, approves, buys, books')
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})

it('waits for earlier same-adult preparation while letting another adult continue independently', async () => {
  const f = await fixture()
  const first = await f.alice.mutation(api.jobs.submit, { text: 'Suggest breakfast ideas' })
  vi.advanceTimersByTime(1)
  const followup = await f.alice.mutation(api.jobs.submit, { text: 'Make those dairy-free' })
  const bob = await f.bob.mutation(api.jobs.submit, { text: 'Suggest a quick lunch' })
  expect(await f.t.query(internal.jobs.waitingForEarlier, { jobId: first, sourceRevision: 1 })).toBe(false)
  expect(await f.t.query(internal.jobs.waitingForEarlier, { jobId: followup, sourceRevision: 1 })).toBe(true)
  expect(await f.t.query(internal.jobs.waitingForEarlier, { jobId: bob, sourceRevision: 1 })).toBe(false)
  await f.t.mutation(internal.jobs.prepared, { jobId: first, sourceRevision: 1, conversation: true, actions: [], clarification: 'Try oatmeal or scrambled eggs.' })
  expect(await f.t.query(internal.jobs.waitingForEarlier, { jobId: followup, sourceRevision: 1 })).toBe(false)
  expect((await f.t.query(internal.jobs.context, { jobId: followup }))!.assistant!.history.at(-1)?.response).toContain('oatmeal')
})

it('does not wait for cancelled, expired or later preparations', async () => {
  const f = await fixture()
  const expired = await f.alice.mutation(api.jobs.submit, { text: 'Earlier synthetic question' })
  vi.advanceTimersByTime(1)
  const cancelled = await f.alice.mutation(api.jobs.submit, { text: 'Another synthetic question' })
  vi.advanceTimersByTime(1)
  const current = await f.alice.mutation(api.jobs.submit, { text: 'Current synthetic question' })
  vi.advanceTimersByTime(1)
  await f.alice.mutation(api.jobs.submit, { text: 'Later synthetic question' })
  await f.t.run(async ctx => {
    await ctx.db.patch((await ctx.db.get(expired))!.sourceId, { expiresAt: Date.now() })
    await ctx.db.patch(cancelled, { cancelled: true })
  })
  expect(await f.t.query(internal.jobs.waitingForEarlier, { jobId: current, sourceRevision: 1 })).toBe(false)
})
