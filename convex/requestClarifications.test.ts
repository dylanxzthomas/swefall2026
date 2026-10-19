import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sourceHash, type CalendarDraft } from '../shared/daymark'
import { event } from '../tests/fixtures/calendar'
import type { WorkItem } from '../shared/workControl'
import { coordinatorWorkInventory } from './coordinatorWork'
import { extractStructured } from '../server/model'
vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-19T12:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.mocked(extractStructured).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
const partial = { ...event, title: 'Maya dentist', date: '2026-11-02', endDate: '2026-11-02', location: 'Oak Dental', startTime: null, endTime: null }
async function fixture(answer = '3 PM to 4 PM.', variant = '') {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] })
  const original = 'Add Maya dentist on 2026-11-02 at Oak Dental to my calendar.'
  const targetSourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text: original, hash: sourceHash(original), revision: 1, expiresAt: now + 86400000, attachmentIds: [] }))
  const targetJobId = await t.run(ctx => ctx.db.insert('jobs', { householdId, createdBy: 'test|parent', sourceId: targetSourceId, interactive: true, preparing: false, cancelled: false, clarification: 'What time does it start and end?' }))
  const actionId = await t.run(ctx => ctx.db.insert('actions', { householdId, jobId: targetJobId, sourceRevision: 1, revision: 1, payload: partial, status: 'review' }))
  if (variant === 'unrelated') { vi.advanceTimersByTime(1); const sourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text: 'Suggest dinner', hash: 'dinner', revision: 1, expiresAt: now + 86400000 })); await t.run(ctx => ctx.db.insert('jobs', { householdId, createdBy: 'test|parent', sourceId, interactive: true, conversation: true, preparing: false, cancelled: false, clarification: 'Try pasta.' })) }
  vi.advanceTimersByTime(2)
  const sourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text: answer, hash: sourceHash(answer), revision: 1, expiresAt: now + 86400000, attachmentIds: [] }))
  const jobId = await t.run(ctx => ctx.db.insert('jobs', { householdId, createdBy: 'test|parent', sourceId, interactive: true, preparing: true, cancelled: false, clarification: '' }))
  const runId = (await t.mutation(internal.assistantCoordinator.start, { jobId, sourceRevision: 1 }))!
  const tool = (tool: string, extra: object = {}) => ({ tool, query: '', id: '', from: '', through: '', answer: '', drafts: [], ...extra })
  await t.mutation(internal.assistantCoordinator.claim, { id: runId, version: 1, lease: 'read' })
  await t.mutation(internal.assistantCoordinator.advance, { id: runId, version: 1, lease: 'read', result: JSON.stringify(tool('read_work')) })
  const step = (await t.mutation(internal.assistantCoordinator.claim, { id: runId, version: 2, lease: 'answer' }))!
  const item = (step.observations as { tool: string; result: { items: WorkItem[] } }[]).find(o => o.tool === 'read_work')!.result.items.find(i => i.id === targetJobId)!
  const reference = { version: item.version, snapshot: item.snapshot, actionId, actionRevision: 1, sourceRevision: 1, questionKey: item.clarification?.questionKey ?? 'unavailable' }
  const respond = (override: object = {}) => t.mutation(internal.assistantCoordinator.advance, { id: runId, version: 2, lease: 'answer', result: JSON.stringify(tool('answer_request', { id: targetJobId, clarification: { ...reference, ...override } })) })
  const finish = (payload: CalendarDraft = { ...partial, startTime: '15:00', endTime: '16:00', evidence: { ...partial.evidence, startTime: '3 PM', endTime: '4 PM' } }, clarification = '') => t.mutation(internal.revisions.finish, { actionId, revision: 2, payload, clarification })
  return { t, parent, householdId, original, targetSourceId, targetJobId, actionId, sourceId, jobId, runId, item, respond, finish }
}
it('answers the current question in the same draft, clears approval, preserves original request and needs fresh review', async () => {
  const f = await fixture()
  expect(f.item.clarification).toMatchObject({ actionId: f.actionId, missingFields: ['startTime', 'endTime'] })
  expect(await f.respond()).toBe(true)
  const pending = await f.t.run(ctx => ctx.db.get(f.actionId))
  expect(pending).toMatchObject({ revision: 2, status: 'review', payload: partial, revisionRequest: { instruction: '3 PM to 4 PM.', clarification: { answerJobId: f.jobId, answerSourceId: f.sourceId, fields: ['startTime', 'endTime'] } } })
  expect(pending?.approvalId).toBeUndefined()
  expect(await f.finish()).toBe(true)
  expect(await f.t.run(ctx => ctx.db.get(f.actionId))).toMatchObject({ revision: 3, status: 'review', payload: { ...partial, startTime: '15:00', endTime: '16:00' } })
  expect(await f.t.run(ctx => ctx.db.get(f.targetSourceId))).toMatchObject({ text: f.original, revision: 1 })
  expect(await f.t.run(ctx => ctx.db.get(f.targetJobId))).toMatchObject({ clarification: '' })
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toHaveLength(1)
  for (const table of ['approvals', 'attempts', 'receipts', 'planEvents', 'mailDrafts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('accepts one answer once under concurrent retries without creating another draft', async () => {
  const f = await fixture(), results = await Promise.all(Array.from({ length: 20 }, () => f.respond()))
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toHaveLength(1)
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.revision).toBe(2)
})
it.each(['For example, 3 PM to 4 PM', 'School notice: 3 PM to 4 PM', 'Sarah said 3 PM to 4 PM'])('does not merge explicitly reported or example text into the pending draft: %s', async answer => {
  const f = await fixture(answer); await f.respond()
  expect(await f.t.run(ctx => ctx.db.get(f.actionId))).toMatchObject({ revision: 1, payload: partial })
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.revisionRequest).toBeUndefined()
})
it.each(['unrelated', 'zero', 'question', 'source', 'action', 'cancelled', 'private', 'owner', 'executing', 'uncertain', 'receipt', 'multiple'])('refuses stale, ambiguous or ineligible existing questions: %s', async variant => {
  const f = await fixture('3 PM to 4 PM.', variant)
  await f.t.run(async ctx => {
    if (variant === 'zero') await ctx.db.delete(f.actionId)
    if (variant === 'question') await ctx.db.patch(f.targetJobId, { clarification: 'Where will it be?' })
    if (variant === 'source') await ctx.db.patch(f.targetSourceId, { revision: 2 })
    if (variant === 'action') await ctx.db.patch(f.actionId, { revision: 2 })
    if (variant === 'cancelled') await ctx.db.patch(f.targetJobId, { cancelled: true })
    if (variant === 'private') await ctx.db.patch(f.targetJobId, { workingContext: { sources: [], expiresAt: now + 86400000 } })
    if (variant === 'owner') await ctx.db.patch(f.targetJobId, { createdBy: 'test|other' })
    if (variant === 'executing' || variant === 'uncertain') await ctx.db.patch(f.actionId, { status: variant })
    if (variant === 'receipt') await ctx.db.insert('receipts', { householdId: f.householdId, actionId: f.actionId, revision: 1, outcome: 'saved', verifiedAt: now })
    if (variant === 'multiple') await ctx.db.insert('actions', { householdId: f.householdId, jobId: f.targetJobId, sourceRevision: 1, revision: 1, payload: partial, status: 'review' })
  })
  await f.respond()
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.revisionRequest).toBeUndefined()
})
it.each(['changed-answer', 'expired-answer', 'removed-answer', 'question', 'new-action', 'new-receipt', 'owner-access'])('rejects a late revision after its bound authority changes: %s', async variant => {
  const f = await fixture(); await f.respond()
  await f.t.run(async ctx => {
    if (variant === 'changed-answer') await ctx.db.patch(f.sourceId, { text: '5 PM to 6 PM.', revision: 2 })
    if (variant === 'expired-answer') await ctx.db.patch(f.sourceId, { expiresAt: now - 1 })
    if (variant === 'removed-answer') await ctx.db.patch(f.jobId, { assistantQuiet: true })
    if (variant === 'question') await ctx.db.patch(f.targetJobId, { clarification: 'Different question?' })
    if (variant === 'new-action') await ctx.db.insert('actions', { householdId: f.householdId, jobId: f.targetJobId, sourceRevision: 1, revision: 1, payload: partial, status: 'review' })
    if (variant === 'new-receipt') await ctx.db.insert('receipts', { householdId: f.householdId, actionId: f.actionId, revision: 2, outcome: 'saved', verifiedAt: now })
    if (variant === 'owner-access') { const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(member!._id) }
  })
  expect(await f.t.query(internal.revisions.context, { actionId: f.actionId, revision: 2 })).toBeNull()
  expect(await f.finish()).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.payload).toEqual(partial)
})
it('rejects a model answer that changes other fields or invents evidence', async () => {
  const f = await fixture(); await f.respond()
  await expect(f.finish({ ...partial, title: 'Wrong appointment', startTime: '15:00', endTime: '16:00', evidence: { ...partial.evidence, startTime: '3 PM', endTime: '4 PM' } })).rejects.toThrow('requested missing details')
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.payload).toEqual(partial)
})
it('does not advertise a missing-detail binding for a request with no draft', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.delete(f.actionId))
  const result = await f.t.run(ctx => coordinatorWorkInventory(ctx, { householdId: f.householdId, createdBy: 'test|parent', jobId: f.jobId }))
  expect(result.items.find(item => item.id === f.targetJobId)?.clarification).toBeUndefined()
})
it('can answer a fresh remaining question through the trusted prior continuation receipt', async () => {
  const f = await fixture('3 PM.'); await f.respond()
  vi.mocked(extractStructured).mockResolvedValueOnce({ updates: [{ field: 'startTime', value: '15:00', quote: '3 PM' }], clarification: 'What time does it end?' })
  await f.t.action(internal.preparation.revise, { actionId: f.actionId, revision: 2 })
  expect(await f.t.run(ctx => ctx.db.get(f.actionId))).toMatchObject({ revision: 3, payload: { startTime: '15:00', endTime: null } })
  vi.advanceTimersByTime(3)
  const sourceId = await f.t.run(ctx => ctx.db.insert('sources', { householdId: f.householdId, text: '4 PM.', hash: sourceHash('4 PM.'), revision: 1, expiresAt: now + 86400000 }))
  const jobId = await f.t.run(ctx => ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId, interactive: true, preparing: true, cancelled: false, clarification: '' }))
  const runId = (await f.t.mutation(internal.assistantCoordinator.start, { jobId, sourceRevision: 1 }))!
  const step = (tool: string, extra: object = {}) => ({ tool, query: '', id: '', from: '', through: '', answer: '', drafts: [], ...extra })
  await f.t.mutation(internal.assistantCoordinator.claim, { id: runId, version: 1, lease: 'again-read' })
  await f.t.mutation(internal.assistantCoordinator.advance, { id: runId, version: 1, lease: 'again-read', result: JSON.stringify(step('read_work')) })
  const context = (await f.t.mutation(internal.assistantCoordinator.claim, { id: runId, version: 2, lease: 'again-answer' }))!
  const item = (context.observations as { tool: string; result: { items: WorkItem[] } }[]).find(o => o.tool === 'read_work')!.result.items.find(i => i.id === f.targetJobId)!
  expect(item.clarification).toMatchObject({ question: 'What time does it end?', missingFields: ['endTime'], actionRevision: 3 })
  await f.t.mutation(internal.assistantCoordinator.advance, { id: runId, version: 2, lease: 'again-answer', result: JSON.stringify(step('answer_request', { id: item.id, clarification: { version: item.version, snapshot: item.snapshot, actionId: f.actionId, actionRevision: 3, sourceRevision: 1, questionKey: item.clarification!.questionKey } })) })
  vi.mocked(extractStructured).mockResolvedValueOnce({ updates: [{ field: 'endTime', value: '16:00', quote: '4 PM' }], clarification: '' })
  await f.t.action(internal.preparation.revise, { actionId: f.actionId, revision: 4 })
  expect((vi.mocked(extractStructured).mock.calls[1][2] as { parentInstruction: string }).parentInstruction).toBe('4 PM.')
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.payload).toMatchObject({ startTime: '15:00', endTime: '16:00' })
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toHaveLength(1)
})
