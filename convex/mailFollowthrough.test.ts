import { afterEach, beforeEach, expect, it } from 'vitest'
import { vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import { mailAgentLimits, type MailProposalInput } from '../shared/mailFollowthrough'
import { retainReviewedTask } from './mailFollowthrough'
import { validMailSummary } from './mailbox'
import { recentMailConversation, validMailConversation } from './mailConversation'
import { modelHouseholdContext } from './modelContext'
import type { Id } from './_generated/dataModel'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-08T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'parent@example.test' }))
  const accountKey = sourceHash(JSON.stringify([connectionId, 'parent@example.test']))
  const mailboxId = await t.run(ctx => ctx.db.insert('mailboxes', { householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const addMessage = (text = 'Return the museum form by October 12. Bring lunch.', threadId = 'thread-1', receivedAt = now - 1000) => t.run(ctx => ctx.db.insert('mailMessages', { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: `message-${threadId}-${receivedAt}`, threadId, sender: 'school@example.test', subject: 'Museum trip', text, receivedAt, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'], version: 1, contentHash: sourceHash(text), expiresAt: now + 86400_000, dismissed: false }))
  const messageId = await addMessage()
  const addRun = (messageIds: Id<'mailMessages'>[] = [messageId]) => t.run(ctx => ctx.db.insert('mailRuns', { householdId, createdBy: 'test|parent', mailboxId, mailboxVersion: 1, connectionId, connectionVersion: 1, accountKey, requestId: `check-${Date.now()}-${messageIds.length}`, requestHash: 'synthetic', request: 'Check my email', kind: 'check', query: '', lookbackDays: 30, mode: 'baseline', scope: 'inbox', status: 'complete', version: 1, scanned: messageIds.length, segmentScanned: messageIds.length, from: now - 86400_000, through: now, createdAt: now, expiresAt: now + 86400_000, messageIds, hasMore: false }))
  const runId = await addRun()
  const start = async (id = runId, ids = [messageId]) => {
    const sources = await t.run(async ctx => Promise.all(ids.map(async id => { const m = (await ctx.db.get(id))!; return { id, version: m.version, hash: m.contentHash } })))
    return (await t.mutation(internal.mailFollowthrough.start, { runId: id, runVersion: 1, sources }))!
  }
  const agentId = await start()
  const claim = (version = 1, id = agentId, lease = `lease-${version}`) => t.mutation(internal.mailFollowthrough.claim, { id, version, lease })
  const advance = (result: unknown, version = 1, id = agentId, lease = `lease-${version}`) => t.mutation(internal.mailFollowthrough.advance, { id, version, lease, result: JSON.stringify(result) })
  const proposal = (kind: MailProposalInput['kind'] = 'task'): MailProposalInput => ({ kind, messageId, title: 'Return museum form', details: 'Bring lunch.', dueDate: '2026-10-12', date: '', startTime: '', endTime: '', timezone: '', location: '', question: kind === 'calendar' ? 'What are the date and times?' : '', replyBody: kind === 'reply' ? 'Could you confirm the return time?' : '', evidence: [{ messageId, quote: 'Return the museum form by October 12.' }] })
  const finish = (proposals = [proposal()]) => ({ tool: 'finish', messageId: '', answer: 'The form is due October 12.', evidence: [{ messageId, quote: 'Return the museum form by October 12.' }], proposals })
  return { t, parent, other, householdId, mailboxId, connectionId, messageId, runId, agentId, addMessage, addRun, start, claim, advance, proposal, finish }
}
it('supplies current shared work and only this adult’s private tasks and requests, with truthful bounded coverage', async () => {
  const f = await fixture()
  const sharedId = await f.parent.mutation(api.personalTasks.create, { requestId: 'recorded-form', title: 'Return museum form', notes: 'For Maya’s October museum trip.', dueDate: '2026-10-12', childId: 'maya' })
  await f.parent.mutation(api.personalTasks.setDone, { id: sharedId, version: 1, done: true })
  const privateId = await f.t.mutation(internal.privateTasks.keep, { householdId: f.householdId, subject: 'test|parent', key: 'parent-private:0', title: 'Ask school about lunch', text: 'Current parent-only wording.' })
  await f.parent.mutation(api.privateTasks.update, { id: privateId, version: 1, title: 'Lunch is packed', text: 'Edited current private wording.' })
  await f.t.mutation(internal.privateTasks.keep, { householdId: f.householdId, subject: 'test|other', key: 'other-private:0', title: 'OTHER ADULT SECRET', text: 'Other adult private instructions.' })
  await f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'Maya museum trip on October 12, 2026.', attachmentIds: [], hash: 'test-source', revision: 1, expiresAt: now + 86400_000 })
    const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId, preparing: false, cancelled: false, clarification: '' })
    const payload = { kind: 'calendar', title: 'Maya museum trip', date: '2026-10-12', startTime: '08:00', endDate: '2026-10-12', endTime: '14:00', timezone: 'UTC' }
    const actionId = await ctx.db.insert('actions', { householdId: f.householdId, jobId, sourceRevision: 1, revision: 2, payload, status: 'review' })
    await ctx.db.insert('receipts', { householdId: f.householdId, actionId, revision: 1, outcome: 'calendar_read_back_verified', verifiedAt: now - 1000, providerId: 'OLD PROVIDER SECRET' })
    await ctx.db.insert('receipts', { householdId: f.householdId, actionId, revision: 2, outcome: 'MODEL INSTRUCTIONS TO SEND', verifiedAt: now, providerId: 'PROVIDER SECRET' })
    for (const [createdBy, text, hidden] of [['test|other', 'OTHER REQUEST SECRET', false], ['test|parent', 'HIDDEN REQUEST SECRET', true]] as const) {
      const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text, attachmentIds: [], hash: 'test-hidden', revision: 1, expiresAt: now + 86400_000 })
      await ctx.db.insert('jobs', { householdId: f.householdId, createdBy, sourceId, assistantQuiet: hidden, preparing: false, cancelled: false, clarification: '' })
    }
  })
  const input = await f.claim()
  expect(input?.savedWork.householdTasks).toMatchObject([{ id: sharedId, version: 2, title: 'Return museum form', dueDate: '2026-10-12', done: true }])
  expect(input?.savedWork.privateTasks).toMatchObject([{ id: privateId, version: 2, title: 'Lunch is packed', text: 'Edited current private wording.' }])
  expect(input?.savedWork.requests).toMatchObject([{ recordedStatus: 'Needs you', actions: [{ status: 'review', revision: 2, verifiedOutcomes: [] }] }])
  expect(input?.savedWork.coverage.limited).toBe(false)
  expect(input?.savedWork.coverage.description).toContain("parent's recorded report")
  expect(JSON.stringify(input)).not.toMatch(/OTHER ADULT|OTHER REQUEST|HIDDEN REQUEST|PROVIDER SECRET|MODEL INSTRUCTIONS TO SEND/)
  expect((await f.t.run(ctx => ctx.db.get(f.agentId)))?.familyHash).toMatch(/^mail-work-v1:/)
})
it('rejects model output and later review when saved work changes, without requiring a family-context tool call', async () => {
  for (const kind of ['task-edit', 'task-done', 'task-remove', 'private-edit', 'private-remove', 'new-request', 'request-outcome'] as const) {
    const f = await fixture()
    const taskId = await f.parent.mutation(api.personalTasks.create, { requestId: `bound-${kind}`, title: 'Return museum form', notes: 'Current obligation.' })
    const privateId = await f.t.mutation(internal.privateTasks.keep, { householdId: f.householdId, subject: 'test|parent', key: 'bound-private:0', title: 'Permission form', text: 'Due October 12.' })
    const request = await f.t.run(async ctx => {
      const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'Museum trip', attachmentIds: [], hash: 'test', revision: 1, expiresAt: now + 86400_000 })
      const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId, preparing: false, cancelled: false, clarification: '' })
      const actionId = await ctx.db.insert('actions', { householdId: f.householdId, jobId, sourceRevision: 1, revision: 1, payload: { kind: 'calendar', title: 'Museum trip' }, status: 'review' })
      return { sourceId, jobId, actionId }
    })
    await f.claim()
    await f.advance(f.finish())
    const secondRun = await f.addRun(), secondAgent = await f.start(secondRun)
    await f.claim(1, secondAgent)
    if (kind === 'task-edit') await f.parent.mutation(api.personalTasks.update, { id: taskId, version: 1, changes: { title: 'Return zoo form', notes: 'Different trip.' } })
    if (kind === 'task-done') await f.parent.mutation(api.personalTasks.setDone, { id: taskId, version: 1, done: true })
    if (kind === 'task-remove') await f.parent.mutation(api.personalTasks.remove, { id: taskId, version: 1 })
    if (kind === 'private-edit') await f.parent.mutation(api.privateTasks.update, { id: privateId, version: 1, title: 'Updated private form', text: 'New deadline.' })
    if (kind === 'private-remove') await f.parent.mutation(api.privateTasks.remove, { id: privateId, version: 1 })
    if (kind === 'new-request') await f.t.run(async ctx => { await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId: request.sourceId, preparing: true, cancelled: false, clarification: '' }) })
    if (kind === 'request-outcome') await f.t.run(async ctx => {
      await ctx.db.patch(request.actionId, { status: 'succeeded' })
      await ctx.db.insert('receipts', { householdId: f.householdId, actionId: request.actionId, revision: 1, outcome: 'calendar_read_back_verified', verifiedAt: now })
    })
    expect(await f.advance(f.finish(), 1, secondAgent), kind).toBe(false)
    expect((await f.parent.query(api.mailFollowthrough.list, {}))[0]?.stale, kind).toBe(true)
    expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
    expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
  }
})
it('keeps valid sibling proposals current after their own explicit keep/share but rejects independent subsequent edits', async () => {
  for (const operation of ['edit', 'done', 'remove'] as const) {
    const f = await fixture(); await f.claim(); await f.advance(f.finish([f.proposal(), f.proposal('calendar'), f.proposal('reply')]))
    const proposals = await f.parent.query(api.mailFollowthrough.list, {}), task = proposals.find(p => p.kind === 'task')!, calendar = proposals.find(p => p.kind === 'calendar')!
    await f.parent.mutation(api.mailFollowthrough.decide, { id: task.id as Id<'mailProposals'>, version: task.version, operation: 'keep' })
    expect((await f.parent.query(api.mailFollowthrough.list, {})).every(p => !p.stale)).toBe(true)
    const jobId = await f.parent.mutation(api.mailFollowthrough.shareCalendar, { id: calendar.id as Id<'mailProposals'>, version: calendar.version, text: 'Maya museum trip, October 12, 2026.', consent: true })
    expect((await f.parent.query(api.mailFollowthrough.list, {})).every(p => !p.stale)).toBe(true)
    expect(await f.parent.mutation(api.mailFollowthrough.shareCalendar, { id: calendar.id as Id<'mailProposals'>, version: calendar.version, text: 'Maya museum trip, October 12, 2026.', consent: true })).toBe(jobId)
    const saved = (await f.parent.query(api.privateTasks.list, {})).tasks[0]
    if (operation === 'edit') await f.parent.mutation(api.privateTasks.update, { id: saved.id as Id<'privateTasks'>, version: saved.version, title: 'Updated form', text: 'Independent parent correction.' })
    if (operation === 'done') await f.parent.mutation(api.privateTasks.setDone, { id: saved.id as Id<'privateTasks'>, version: saved.version, done: true })
    if (operation === 'remove') await f.parent.mutation(api.privateTasks.remove, { id: saved.id as Id<'privateTasks'>, version: saved.version })
    expect((await f.parent.query(api.mailFollowthrough.list, {})).every(p => p.stale)).toBe(true)
    const reply = proposals.find(p => p.kind === 'reply')!
    await expect(f.parent.mutation(api.mailFollowthrough.reviewReply, { id: reply.id as Id<'mailProposals'>, version: reply.version })).rejects.toThrow('current complete')
  }
})
it('shows the current saved private task decision and scrubs removed follow-up wording in later model inputs', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0]
  await f.parent.mutation(api.mailFollowthrough.decide, { id: p.id as Id<'mailProposals'>, version: p.version, operation: 'keep' })
  const task = (await f.parent.query(api.privateTasks.list, {})).tasks[0]
  await f.parent.mutation(api.privateTasks.update, { id: task.id as Id<'privateTasks'>, version: task.version, title: 'Edited form reminder', text: 'Keep only this wording.' })
  await f.parent.mutation(api.privateTasks.setDone, { id: task.id as Id<'privateTasks'>, version: 2, done: true })
  const input = await f.claim(1, await f.start(await f.addRun()))
  expect(input?.priorFollowups[0]).toMatchObject({ title: 'Edited form reminder', status: 'done', savedTaskVersion: 3 })
  await f.parent.mutation(api.privateTasks.remove, { id: task.id as Id<'privateTasks'>, version: 3 })
  const removed = await f.claim(1, await f.start(await f.addRun()))
  expect(removed?.savedWork.privateTasks).toEqual([])
  expect(removed?.priorFollowups[0]).toMatchObject({ title: '', status: 'removed' })
  expect(JSON.stringify(removed)).not.toContain('Keep only this wording.')
})
it('caps saved-work inputs, reports missing coverage and never feeds removed task text back to the model', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    for (let i = 0; i <= mailAgentLimits.savedWork.tasks; i++) await ctx.db.insert('personalTasks', { householdId: f.householdId, requestId: `bounded-${i}`, requestHash: 'synthetic', title: `Form ${i}`, notes: 'x'.repeat(600), done: i % 2 === 0, version: 1, createdAt: now, updatedAt: now })
    await ctx.db.insert('personalTasks', { householdId: f.householdId, requestId: 'removed', requestHash: 'synthetic', title: 'REMOVED SECRET TITLE', notes: 'REMOVED SECRET NOTES', removed: true, done: false, version: 2, createdAt: now, updatedAt: now })
  })
  const input = await f.claim()
  expect(input?.savedWork.householdTasks).toHaveLength(mailAgentLimits.savedWork.tasks)
  expect(input?.savedWork.coverage).toMatchObject({ limited: true, limits: { tasks: true } })
  expect(input?.savedWork.householdTasks.every(t => t.text.length === mailAgentLimits.savedWork.textChars && t.textTruncated)).toBe(true)
  expect(JSON.stringify(input)).not.toContain('REMOVED SECRET')
  await f.advance({ ...f.finish([]), answer: 'The supplied email asks for the form; older saved tasks were outside this check.' })
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
})
it('does not invalidate private preparation because another adult edits private work or another household adds work', async () => {
  const f = await fixture(), otherTask = await f.t.mutation(internal.privateTasks.keep, { householdId: f.householdId, subject: 'test|other', key: 'other-bound:0', title: 'OTHER PRIVATE', text: 'Private wording.' })
  await f.claim()
  await f.other.mutation(api.privateTasks.update, { id: otherTask, version: 1, title: 'OTHER UPDATED', text: 'Other adult correction.' })
  const outsider = f.t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'sam', name: 'Sam' }] })
  await outsider.mutation(api.personalTasks.create, { requestId: 'outside', title: 'OTHER HOUSEHOLD', notes: 'Other household work.' })
  expect(await f.advance(f.finish())).toBe(true)
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0].stale).toBe(false)
  expect(await f.other.query(api.mailFollowthrough.list, {})).toEqual([])
})
it('does not stale its own originating email-check request when that request finishes', async () => {
  const f = await fixture()
  const jobId = await f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'Check my email.', hash: 'interactive-check', attachmentIds: [], revision: 1, expiresAt: now + 86400_000 })
    const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId, interactive: true, preparing: true, cancelled: false, clarification: '' })
    const assistantRunId = await ctx.db.insert('assistantRuns', { householdId: f.householdId, createdBy: 'test|parent', jobId, sourceId, sourceRevision: 1, sourceHash: sourceHash('Check my email.'), privateOnly: true, version: 1, status: 'running', step: 1, attempts: 1, used: [], observations: '[]', refs: [], createdAt: now, expiresAt: now + 86400_000 })
    await ctx.db.patch(jobId, { assistantRunId })
    await ctx.db.patch(f.runId, { agentRequested: true, agentJobId: jobId, agentSourceRevision: 1, agentSourceHash: sourceHash('Check my email.') })
    return jobId
  })
  expect((await f.claim())?.savedWork.requests).toEqual([])
  expect(await f.advance(f.finish())).toBe(true)
  await f.t.run(ctx => ctx.db.patch(jobId, { preparing: false, conversation: true, clarification: 'The check is ready.' }))
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0].stale).toBe(false)
})
it('invalidates task-aware summaries and their conversation provenance after the recorded task changes', async () => {
  const f = await fixture(), taskId = await f.parent.mutation(api.personalTasks.create, { requestId: 'summary-task', title: 'Return museum form', notes: 'Recorded form task.' })
  await f.claim(); await f.advance(f.finish([]))
  const context = await f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'What about that form?', hash: 'test-followup', attachmentIds: [], revision: 1, expiresAt: now + 86400_000 })
    const id = await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId, preparing: false, conversation: true, cancelled: false, clarification: '' })
    const job = (await ctx.db.get(id))!, run = (await ctx.db.get(f.runId))!
    expect(await validMailSummary(ctx, run)).toBe(true)
    return { job, mail: await recentMailConversation(ctx, job) }
  })
  expect(context.mail?.input.summary).toBe('The form is due October 12.')
  await f.parent.mutation(api.personalTasks.setDone, { id: taskId, version: 1, done: true })
  await f.t.run(async ctx => {
    expect(await validMailSummary(ctx, (await ctx.db.get(f.runId))!)).toBe(false)
    expect(await validMailConversation(ctx, context.job, context.mail!.provenance)).toBe(false)
    expect(await recentMailConversation(ctx, context.job)).toBeNull()
  })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].answer).toBe('The source emails or saved work changed. Check Gmail again for an updated summary.')
})
it('retains the original family-only hash contract for pre-rollout proposals and summaries', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  await f.t.run(async ctx => {
    const h = (await ctx.db.get(f.householdId))!, context = await modelHouseholdContext(ctx, f.householdId, 'test|parent')
    const originalFamily = { household: { name: h.name, timezone: h.timezone, children: h.children }, facts: context.facts.slice(0, 12).map(f => ({ key: f.key, value: f.value, version: f.version })), savedEvents: context.plan.slice(0, 10).map(e => ({ id: e._id, payload: e.payload, etag: e.etag })), coverage: { ...context.modelCoverage, description: 'Up to 12 confirmed facts and 10 saved events. Not a complete external calendar or proof of availability.' } }
    const familyHash = sourceHash(JSON.stringify(originalFamily)), p = (await ctx.db.query('mailProposals').collect())[0]
    await ctx.db.patch(f.agentId, { familyHash }); await ctx.db.patch(p._id, { familyHash })
  })
  await f.parent.mutation(api.personalTasks.create, { requestId: 'later-task', title: 'A newly added task', notes: '' })
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0].stale).toBe(false)
  expect(await f.t.run(async ctx => validMailSummary(ctx, (await ctx.db.get(f.runId))!))).toBe(true)
})
it('stops scanning through tombstones and chat history and reports that older work may be missing', async () => {
  const f = await fixture()
  await f.parent.mutation(api.personalTasks.create, { requestId: 'older-form', title: 'OLDER FORM OUTSIDE WINDOW', notes: 'Older active task.' })
  await f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'Chat body should not be read into saved-work requests.', attachmentIds: [], hash: 'test-chat', revision: 1, expiresAt: now + 86400_000 })
    for (let i = 0; i < mailAgentLimits.savedWork.taskScan; i++) await ctx.db.insert('personalTasks', { householdId: f.householdId, requestId: `tombstone-${i}`, requestHash: 'synthetic', title: '', notes: '', removed: true, done: false, version: 2, createdAt: now, updatedAt: now })
    for (let i = 0; i <= mailAgentLimits.savedWork.requestScan; i++) await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId, preparing: false, conversation: true, cancelled: false, clarification: 'Ordinary chat.' })
  })
  const input = await f.claim()
  expect(input?.savedWork.householdTasks).toEqual([])
  expect(input?.savedWork.requests).toEqual([])
  expect(input?.savedWork.coverage).toMatchObject({ limited: true, limits: { tasks: true, requests: true } })
  expect(JSON.stringify(input)).not.toMatch(/OLDER FORM OUTSIDE WINDOW|Chat body should not be read/)
})
it('omits private/provider-derived request content rather than recursively reusing revoked model context', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    for (const origin of ['mail', 'voice', 'private-run'] as const) {
      const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: `REVOKED PRIVATE ${origin} SOURCE`, attachmentIds: [], hash: 'test-private', revision: 1, expiresAt: now + 86400_000 })
      const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, createdBy: 'test|parent', sourceId, preparing: false, cancelled: false, clarification: `REVOKED PRIVATE ${origin} ANSWER`, ...(origin === 'mail' ? { mailContext: { mailboxId: f.mailboxId, mailboxVersion: 0, runId: f.runId, runVersion: 0, summaryHash: 'revoked', expiresAt: now + 86400_000, messages: [] } } : {}) })
      const runId = await ctx.db.insert('assistantRuns', { householdId: f.householdId, createdBy: 'test|parent', jobId, sourceId, sourceRevision: 1, sourceHash: 'test-private', privateOnly: origin !== 'voice', calendarTriggered: origin === 'voice', version: 1, status: 'complete', step: 1, attempts: 1, used: [], observations: '[]', refs: [], createdAt: now, expiresAt: now + 86400_000 })
      await ctx.db.patch(jobId, { assistantRunId: runId })
      await ctx.db.insert('actions', { householdId: f.householdId, jobId, sourceRevision: 1, revision: 1, payload: { kind: 'email', subject: `REVOKED PRIVATE ${origin} ACTION` }, status: 'review' })
    }
  })
  const input = await f.claim()
  expect(input?.savedWork.requests).toEqual([])
  expect(input?.savedWork.coverage.limits.requests).toBe(true)
  expect(input?.savedWork.coverage.description).toContain('private-derived requests')
  expect(JSON.stringify(input)).not.toContain('REVOKED PRIVATE')
  expect(await f.advance(f.finish())).toBe(true)
})
it('lets the model choose a read tool, resumes from its durable observation, then saves only private proposals', async () => {
  const f = await fixture(), first = await f.claim()
  expect(first?.messages).toHaveLength(1)
  await f.advance({ tool: 'family_context', messageId: '', answer: '', evidence: [], proposals: [] })
  const second = await f.claim(2)
  expect(second?.used).toEqual(['family_context:'])
  expect(JSON.stringify(second?.observations)).toContain('Maya')
  expect(JSON.stringify(second)).not.toMatch(/cipher|refreshToken|accessToken|clientSecret/)
  await f.advance(f.finish(), 2)
  expect((await f.t.run(ctx => ctx.db.get(f.agentId)))?.status).toBe('complete')
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0]).toMatchObject({ title: 'Return museum form', status: 'review', stale: false })
  expect(await f.other.query(api.mailFollowthrough.list, {})).toEqual([])
  await expect(f.t.query(api.mailFollowthrough.list, {})).rejects.toThrow('Sign in')
  for (const table of ['personalTasks', 'actions', 'approvals', 'attempts', 'jobs', 'mailDrafts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('coalesces 50 simultaneous starts, claims and final responses into one private preparation', async () => {
  const f = await fixture()
  expect(new Set(await Promise.all(Array.from({ length: 50 }, () => f.start()))).size).toBe(1)
  const claims = await Promise.all(Array.from({ length: 50 }, (_, i) => f.claim(1, f.agentId, `concurrent-${i}`)))
  expect(claims.filter(Boolean)).toHaveLength(1)
  const lease = (await f.t.run(ctx => ctx.db.get(f.agentId)))!.lease!
  const finished = await Promise.all(Array.from({ length: 50 }, () => f.advance(f.finish(), 1, f.agentId, lease)))
  expect(finished.filter(Boolean)).toHaveLength(1)
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toHaveLength(1)
})
it('rejects invented evidence and repeated or unauthorized tools before committing preparation', async () => {
  const f = await fixture(); await f.claim()
  await expect(f.advance({ ...f.finish(), evidence: [{ messageId: f.messageId, quote: 'Invented' }] })).rejects.toThrow('evidence')
  await expect(f.advance({ tool: 'read_thread', messageId: 'outsider', answer: '', evidence: [], proposals: [] })).rejects.toThrow('supplied')
  await f.advance({ tool: 'read_thread', messageId: f.messageId, answer: '', evidence: [], proposals: [] })
  await f.claim(2)
  await expect(f.advance({ tool: 'read_thread', messageId: f.messageId, answer: '', evidence: [], proposals: [] }, 2)).rejects.toThrow('already used')
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
})
it('recovers abandoned leases with bounded model attempts and rejects their late responses', async () => {
  const f = await fixture(); await f.claim()
  vi.setSystemTime(now + mailAgentLimits.leaseMs + 1)
  const replacement = await f.claim(1, f.agentId, 'replacement')
  expect(replacement).not.toBeNull()
  expect(await f.advance(f.finish())).toBe(false)
  for (let n = 2; n < mailAgentLimits.attempts; n++) { vi.setSystemTime(Date.now() + mailAgentLimits.leaseMs + 1); expect(await f.claim(1, f.agentId, `replacement-${n}`)).not.toBeNull() }
  vi.setSystemTime(Date.now() + mailAgentLimits.leaseMs + 1)
  expect(await f.claim()).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(f.agentId)))?.status).toBe('failed')
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
})
it('invalidates in-flight output and review when the source, grant, family facts or expiry change', async () => {
  for (const change of ['source', 'grant', 'family', 'expiry'] as const) {
    const f = await fixture(); await f.claim()
    if (change === 'family') { await f.advance({ tool: 'family_context', messageId: '', answer: '', evidence: [], proposals: [] }); await f.claim(2); await f.parent.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] }) }
    else if (change === 'source') await f.t.run(ctx => ctx.db.patch(f.messageId, { version: 2, contentHash: 'changed' }))
    else if (change === 'grant') await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
    else vi.setSystemTime(now + 86400_000 + 1)
    expect(await f.advance(f.finish(), change === 'family' ? 2 : 1)).toBe(false)
    expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
    vi.setSystemTime(now)
  }
})
it('keeps, edits, completes and reopens private parent tasks without household promotion or external approval', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = p.id as Id<'mailProposals'>
  await expect(f.other.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'keep' })).rejects.toThrow('unavailable')
  await f.parent.mutation(api.mailFollowthrough.update, { id, version: 1, input: { ...f.proposal(), title: 'Return Maya’s form' } })
  await expect(f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'keep' })).rejects.toThrow('changed')
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 2, operation: 'keep' })
  const saved = (await f.parent.query(api.privateTasks.list, {})).tasks[0]
  expect(saved).toMatchObject({ title: 'Return Maya’s form', text: 'Bring lunch.\nDue: 2026-10-12', done: false, version: 1 })
  await expect(f.parent.mutation(api.mailFollowthrough.decide, { id, version: 3, operation: 'done' })).rejects.toThrow('Tasks')
  await f.parent.mutation(api.privateTasks.setDone, { id: saved.id as Id<'privateTasks'>, version: 1, done: true })
  await f.parent.mutation(api.privateTasks.setDone, { id: saved.id as Id<'privateTasks'>, version: 2, done: false })
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0]).toMatchObject({ status: 'kept', title: 'Return Maya’s form', version: 3, privateTaskId: saved.id })
  expect((await f.parent.query(api.privateTasks.list, {})).tasks[0]).toMatchObject({ done: false, version: 3 })
  expect(await f.t.run(ctx => ctx.db.query('personalTasks').collect())).toEqual([])
})
it('honors snooze and dismissal when unrelated new mail arrives and does not recreate accepted work', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = p.id as Id<'mailProposals'>
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'snooze', until: now + 60_000 })
  const unrelated = await f.addMessage('An informational recap.', 'unrelated')
  const run = await f.addRun([f.messageId, unrelated]), agent = await f.start(run, [f.messageId, unrelated])
  await f.claim(1, agent); await f.advance(f.finish(), 1, agent)
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0].status).toBe('snoozed')
  vi.setSystemTime(now + 60_001)
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 2, operation: 'keep' })
  await expect(f.parent.mutation(api.mailFollowthrough.decide, { id, version: 3, operation: 'dismiss' })).rejects.toThrow('Tasks')
  const next = await f.addRun(), nextAgent = await f.start(next)
  await f.claim(1, nextAgent); await f.advance(f.finish(), 1, nextAgent)
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0].status).toBe('kept')
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toHaveLength(1)
})

it('retains only reviewed private task text after email expiry or removal and never overwrites independent edits on replay', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = p.id as Id<'mailProposals'>
  const versions = await Promise.all(Array.from({ length: 50 }, () => f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'keep' })))
  expect(new Set(versions)).toEqual(new Set([2]))
  const saved = (await f.parent.query(api.privateTasks.list, {})).tasks[0], taskId = saved.id as Id<'privateTasks'>
  const row = (await f.t.run(ctx => ctx.db.get(taskId)))!
  for (const key of ['evidence', 'sourceId', 'sources', 'messageId', 'mailboxId', 'runId', 'accountKey', 'expiresAt']) expect(row).not.toHaveProperty(key)
  expect(JSON.stringify(row)).not.toContain('Return the museum form by October 12.')
  await f.parent.mutation(api.privateTasks.update, { id: taskId, version: 1, title: 'My corrected task', text: 'Only the details I chose.' })
  expect(await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'keep' })).toBe(2)
  await expect(f.parent.mutation(api.mailFollowthrough.update, { id, version: 2, input: f.proposal() })).rejects.toThrow('Tasks')
  await f.t.run(ctx => ctx.db.delete(f.messageId))
  vi.setSystemTime(now + 86400_001)
  await f.t.mutation(internal.privacy.expireSources, {})
  expect(await f.t.run(ctx => ctx.db.get(id))).toBeNull()
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toEqual([expect.objectContaining({ id: taskId, title: 'My corrected task', text: 'Only the details I chose.', version: 2 })])
  expect((await f.other.query(api.privateTasks.list, {})).tasks).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('personalTasks').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})

it('keeps a changed thread proposal as a new independent task without replacing an earlier saved edit', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const old = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = old.id as Id<'mailProposals'>
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'keep' })
  const first = (await f.parent.query(api.privateTasks.list, {})).tasks[0]
  await f.parent.mutation(api.privateTasks.update, { id: first.id as Id<'privateTasks'>, version: 1, title: 'My original saved task', text: 'My correction stays independent.' })
  const text = 'Bring the new signed form on October 13.', messageId = await f.addMessage(text, 'thread-1', now)
  const runId = await f.addRun([messageId]), agent = await f.start(runId, [messageId]); await f.claim(1, agent)
  const proposal = { ...f.proposal(), messageId, title: 'Bring the updated form', evidence: [{ messageId, quote: text }], dueDate: '2026-10-13' }
  await f.advance({ tool: 'finish', messageId: '', answer: 'The new form needs review.', evidence: proposal.evidence, proposals: [proposal] }, 1, agent)
  const next = (await f.parent.query(api.mailFollowthrough.list, {}))[0]
  expect(next.id).toBe(id); expect(next.privateTaskId).toBeUndefined(); expect(next.status).toBe('review')
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: next.version, operation: 'keep' })
  const tasks = (await f.parent.query(api.privateTasks.list, {})).tasks
  expect(tasks).toHaveLength(2)
  expect(tasks).toContainEqual(expect.objectContaining({ id: first.id, title: 'My original saved task', text: 'My correction stays independent.', version: 2 }))
  expect(tasks).toContainEqual(expect.objectContaining({ title: 'Bring the updated form', text: 'Bring lunch.\nDue: 2026-10-13', version: 1 }))
})

it('preserves a kept task through mailbox removal without retaining private source records', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = p.id as Id<'mailProposals'>
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'keep' })
  const saved = (await f.parent.query(api.privateTasks.list, {})).tasks[0]
  await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 1 })
  await f.t.mutation(internal.mailbox.eraseMailbox, { id: f.mailboxId })
  for (const table of ['mailAgents', 'mailProposals', 'mailMessages', 'mailRuns'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toEqual([saved])
  await f.parent.mutation(api.privateTasks.setDone, { id: saved.id as Id<'privateTasks'>, version: 1, done: true })
  expect((await f.parent.query(api.privateTasks.list, {})).tasks[0]).toMatchObject({ id: saved.id, done: true, version: 2 })
  expect((await f.other.query(api.privateTasks.list, {})).tasks).toEqual([])
  for (const table of ['personalTasks', 'actions', 'approvals', 'attempts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})

it('preserves a legacy completed task when explicitly retained and cannot resurrect a removed saved task on replay', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = p.id as Id<'mailProposals'>
  await f.t.run(ctx => ctx.db.patch(id, { status: 'done' }))
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'keep' })
  const saved = (await f.parent.query(api.privateTasks.list, {})).tasks[0], taskId = saved.id as Id<'privateTasks'>
  expect(saved.done).toBe(true)
  await expect(f.parent.mutation(api.mailFollowthrough.decide, { id, version: 2, operation: 'reopen' })).rejects.toThrow('Tasks')
  await f.parent.mutation(api.privateTasks.remove, { id: taskId, version: 1 })
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'keep' })
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toEqual([])
  expect(await f.t.run(ctx => ctx.db.get(taskId))).toMatchObject({ removed: true, title: '', text: '' })
})
it('coalesces 50 legacy keep migrations and preserves independent edits, completion and removal', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const id = (await f.parent.query(api.mailFollowthrough.list, {}))[0].id as Id<'mailProposals'>
  await f.t.run(ctx => ctx.db.patch(id, { status: 'kept', version: 4 }))
  const migrate = () => f.t.run(async ctx => retainReviewedTask(ctx, (await ctx.db.get(id))!))
  expect(new Set(await Promise.all(Array.from({ length: 50 }, migrate))).size).toBe(1)
  const saved = (await f.parent.query(api.privateTasks.list, {})).tasks[0], taskId = saved.id as Id<'privateTasks'>
  const row = (await f.t.run(ctx => ctx.db.get(taskId)))!
  expect(row.key).toBe(`${id}_4:0`)
  for (const key of ['evidence', 'sourceId', 'sources', 'messageId', 'mailboxId', 'runId', 'accountKey', 'expiresAt']) expect(row).not.toHaveProperty(key)
  await f.parent.mutation(api.privateTasks.update, { id: taskId, version: 1, title: 'My retained edit', text: 'Only my selected details.' })
  await f.parent.mutation(api.privateTasks.setDone, { id: taskId, version: 2, done: true })
  await migrate()
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toEqual([expect.objectContaining({ id: taskId, title: 'My retained edit', text: 'Only my selected details.', done: true, version: 3 })])
  await f.parent.mutation(api.privateTasks.remove, { id: taskId, version: 3 })
  await Promise.all(Array.from({ length: 50 }, migrate))
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('privateTasks').collect())).toEqual([expect.objectContaining({ _id: taskId, removed: true, title: '', text: '' })])
})
it('retains earlier explicit keeps before legacy proposal expiry, mailbox removal or a new thread correction', async () => {
  for (const change of ['expiry', 'mailbox', 'correction'] as const) {
    const f = await fixture(); await f.claim(); await f.advance(f.finish())
    const id = (await f.parent.query(api.mailFollowthrough.list, {}))[0].id as Id<'mailProposals'>
    await f.t.run(ctx => ctx.db.patch(id, { status: 'done', version: 3, input: { ...f.proposal(), title: 'My legacy reviewed form' } }))
    if (change === 'expiry') { vi.setSystemTime(now + 86400_001); await f.t.mutation(internal.privacy.expireSources, {}); expect(await f.t.run(ctx => ctx.db.get(id))).toBeNull() }
    else if (change === 'mailbox') { await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 1 }); await f.t.mutation(internal.mailbox.eraseMailbox, { id: f.mailboxId }); expect(await f.t.run(ctx => ctx.db.get(id))).toBeNull() }
    else {
      const text = 'Bring the updated form on October 13.', messageId = await f.addMessage(text, 'thread-1', now)
      const run = await f.addRun([messageId]), agent = await f.start(run, [messageId]); await f.claim(1, agent)
      const input = { ...f.proposal(), messageId, title: 'New form to review', evidence: [{ messageId, quote: text }] }
      await f.advance({ tool: 'finish', messageId: '', answer: 'Review the updated form.', evidence: input.evidence, proposals: [input] }, 1, agent)
      expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'review', version: 4, input: expect.objectContaining({ title: 'New form to review' }) })
      expect((await f.parent.query(api.mailFollowthrough.list, {}))[0].privateTaskId).toBeUndefined()
    }
    expect((await f.parent.query(api.privateTasks.list, {})).tasks).toEqual([expect.objectContaining({ title: 'My legacy reviewed form', done: true, text: 'Bring lunch.\nDue: 2026-10-12' })])
    expect((await f.other.query(api.privateTasks.list, {})).tasks).toEqual([])
    for (const table of ['personalTasks', 'actions', 'approvals', 'attempts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
    vi.setSystemTime(now)
  }
})
it('does not migrate unaccepted proposals, removed membership or deleted households during expiry', async () => {
  for (const state of ['review', 'dismissed', 'snoozed', 'withdrawn', 'membership', 'household'] as const) {
    const f = await fixture(); await f.claim(); await f.advance(f.finish())
    const id = (await f.parent.query(api.mailFollowthrough.list, {}))[0].id as Id<'mailProposals'>
    await f.t.run(async ctx => {
      await ctx.db.patch(id, { status: state === 'membership' || state === 'household' ? 'kept' : state })
      if (state === 'household') await ctx.db.patch(f.householdId, { deleted: true })
      if (state === 'membership') { const membership = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(membership!._id) }
    })
    vi.setSystemTime(now + 86400_001)
    await f.t.mutation(internal.privacy.expireSources, {})
    expect(await f.t.run(ctx => ctx.db.query('privateTasks').collect())).toEqual([])
    expect(await f.t.run(ctx => ctx.db.get(id))).toBeNull()
    vi.setSystemTime(now)
  }
})
it('makes a newer thread correction stale and withdraws obsolete unaccepted proposals on a fresh grounded pass', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const newer = await f.addMessage('The museum trip is cancelled. No form is needed.', 'thread-1', now)
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0]
  expect(p.stale).toBe(true)
  await expect(f.parent.mutation(api.mailFollowthrough.decide, { id: p.id as Id<'mailProposals'>, version: 1, operation: 'keep' })).rejects.toThrow('changed')
  const run = await f.addRun([newer]), agent = await f.start(run, [newer]); await f.claim(1, agent)
  await f.advance({ tool: 'finish', messageId: '', answer: 'The trip was cancelled.', evidence: [{ messageId: newer, quote: 'The museum trip is cancelled.' }], proposals: [] }, 1, agent)
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
})
it('copies a reply into private draft review once and never saves or sends it to Gmail', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish([f.proposal('reply')]))
  const replyRouting = { threadId: 'thread-1', inReplyTo: '<museum@school.example>', references: ['<museum@school.example>'], subject: 'Re: Museum trip' }
  await f.t.run(ctx => ctx.db.patch(f.messageId, { replyRouting }))
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = p.id as Id<'mailProposals'>
  const draft = await f.parent.mutation(api.mailFollowthrough.reviewReply, { id, version: 1 })
  expect(await f.t.run(ctx => ctx.db.get(draft))).toMatchObject({ replyRouting })
  expect(await f.parent.mutation(api.mailFollowthrough.reviewReply, { id, version: 2 })).toBe(draft)
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'review', to: 'school@example.test', body: 'Could you confirm the return time?' })
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  await expect(f.parent.mutation(api.mailFollowthrough.decide, { id, version: 2, operation: 'done' })).rejects.toThrow('cannot be marked')
})
it('shares only a reviewed calendar preview and deletes private follow-through with its mailbox', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish([f.proposal('calendar')]))
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = p.id as Id<'mailProposals'>
  await expect(f.parent.mutation(api.mailFollowthrough.shareCalendar, { id, version: 1, text: 'Only this selected calendar information.', consent: false as true })).rejects.toThrow()
  const jobs = await Promise.all(Array.from({ length: 20 }, () => f.parent.mutation(api.mailFollowthrough.shareCalendar, { id, version: 1, text: 'Only this selected calendar information.', consent: true })))
  expect(new Set(jobs).size).toBe(1)
  const source = await f.t.run(async ctx => ctx.db.get((await ctx.db.get(jobs[0]))!.sourceId))
  expect(source?.text).toBe('Only this selected calendar information.')
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 1 })
  await f.t.mutation(internal.mailbox.eraseMailbox, { id: f.mailboxId })
  for (const table of ['mailAgents', 'mailProposals', 'mailMessages'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('repairs rejected model output with bounded feedback and no partially committed proposals', async () => {
  const f = await fixture(); await f.claim()
  const bad = { ...f.finish(), evidence: [], messageId: f.messageId }
  expect(await f.t.mutation(internal.mailFollowthrough.commitStep, { id: f.agentId, version: 1, lease: 'lease-1', result: JSON.stringify(bad) })).toMatchObject({ accepted: false, code: 'source_evidence' })
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
  expect(await f.t.mutation(internal.mailFollowthrough.repair, { id: f.agentId, version: 1, lease: 'lease-1', code: 'source_evidence' })).toBe(true)
  const input = await f.claim(2)
  expect(JSON.stringify(input?.observations)).toContain('validationFeedback')
  expect(input?.remainingSteps).toBe(4)
  await f.advance(f.finish(), 2)
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toHaveLength(1)
})
it('durably wakes snoozed follow-ups and ignores old timers after edits or dismissal', async () => {
  const f = await fixture(); await f.claim(); await f.advance(f.finish())
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0], id = p.id as Id<'mailProposals'>
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 1, operation: 'snooze', until: now + 60_000 })
  await f.parent.mutation(api.mailFollowthrough.update, { id, version: 2, input: { ...f.proposal(), title: 'Edited while snoozed' } })
  expect(await f.t.mutation(internal.mailFollowthrough.wake, { id, version: 3 })).toBe(false)
  vi.setSystemTime(now + 60_001)
  expect(await f.t.mutation(internal.mailFollowthrough.wake, { id, version: 2 })).toBe(false)
  expect(await f.t.mutation(internal.mailFollowthrough.wake, { id, version: 3 })).toBe(true)
  expect((await f.t.run(ctx => ctx.db.get(id)))?.status).toBe('review')
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 4, operation: 'snooze', until: now + 120_000 })
  await f.parent.mutation(api.mailFollowthrough.decide, { id, version: 5, operation: 'dismiss' })
  vi.setSystemTime(now + 120_001)
  expect(await f.t.mutation(internal.mailFollowthrough.wake, { id, version: 5 })).toBe(false)
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0].status).toBe('dismissed')
})
it('coalesces 50 private retries, preserves tool progress and resumes without another Gmail scan', async () => {
  const f = await fixture(); await f.claim()
  await f.advance({ tool: 'family_context', messageId: '', answer: '', evidence: [], proposals: [] })
  await f.claim(2)
  await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: 2, lease: 'lease-2', code: 'rate_limit' })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].followthrough).toMatchObject({ status: 'failed', version: 2, retryable: true })
  const retry = () => f.parent.mutation(api.mailFollowthrough.retry, { runId: f.runId, runVersion: 1, agentVersion: 2 })
  expect(new Set(await Promise.all(Array.from({ length: 50 }, retry)))).toEqual(new Set([3]))
  const stored = (await f.t.run(ctx => ctx.db.get(f.agentId)))!
  expect(stored).toMatchObject({ status: 'queued', version: 3, attempts: 2, step: 1, used: ['family_context:'], failureCode: 'rate_limit' })
  expect(stored.observations).toContain('Maya')
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))!).toMatchObject({ version: 1, status: 'complete', scanned: 1 })
  expect(await f.claim(3)).toBeNull()
  vi.setSystemTime(now + 60_001)
  const claims = await Promise.all(Array.from({ length: 50 }, (_, i) => f.claim(3, f.agentId, `retry-${i}`)))
  expect(claims.filter(Boolean)).toHaveLength(1)
  const lease = (await f.t.run(ctx => ctx.db.get(f.agentId)))!.lease!
  expect(await f.advance(f.finish(), 3, f.agentId, lease)).toBe(true)
  expect(await retry()).toBe(3) // Late delivery of the same retry does not recreate work.
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toHaveLength(1)
  for (const table of ['jobs', 'actions', 'approvals', 'attempts', 'mailDrafts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('keeps retries within the original six-call budget and rejects obsolete failures and output', async () => {
  const f = await fixture(); await f.claim()
  for (let attempt = 1; attempt <= mailAgentLimits.attempts; attempt++) {
    await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: attempt, lease: `lease-${attempt}`, code: 'unavailable' })
    const retry = () => f.parent.mutation(api.mailFollowthrough.retry, { runId: f.runId, runVersion: 1, agentVersion: attempt })
    if (attempt === mailAgentLimits.attempts) {
      expect((await f.parent.query(api.mailbox.runs, {}))[0].followthrough?.retryable).toBe(false)
      await expect(retry()).rejects.toThrow('limit'); break
    }
    expect(await retry()).toBe(attempt + 1)
    expect(await f.advance(f.finish(), attempt)).toBe(false)
    expect(await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: attempt, lease: `lease-${attempt}` })).toBe(false)
    vi.setSystemTime(Date.now() + 60_001)
    expect(await f.claim(attempt + 1)).not.toBeNull()
  }
  expect((await f.t.run(ctx => ctx.db.get(f.agentId)))?.attempts).toBe(6)
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
})
it('refuses retry for another adult, unsigned callers or a changed run revision', async () => {
  const f = await fixture(); await f.claim()
  await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: 1, lease: 'lease-1' })
  const args = { runId: f.runId, runVersion: 1, agentVersion: 1 }
  await expect(f.other.mutation(api.mailFollowthrough.retry, args)).rejects.toThrow('unavailable')
  await expect(f.t.mutation(api.mailFollowthrough.retry, args)).rejects.toThrow('Sign in')
  await expect(f.parent.mutation(api.mailFollowthrough.retry, { ...args, agentVersion: 7 })).rejects.toThrow('changed')
  await f.t.run(ctx => ctx.db.patch(f.runId, { version: 2 }))
  await expect(f.parent.mutation(api.mailFollowthrough.retry, args)).rejects.toThrow('changed')
})
it('hides retry and rejects it when sources, family, mailbox, account, membership or expiry change', async () => {
  for (const change of ['source', 'family', 'paused', 'grant', 'account', 'membership', 'expiry', 'removed'] as const) {
    const f = await fixture(); await f.claim()
    await f.advance({ tool: 'family_context', messageId: '', answer: '', evidence: [], proposals: [] }); await f.claim(2)
    await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: 2, lease: 'lease-2' })
    if (change === 'source') await f.t.run(ctx => ctx.db.patch(f.messageId, { version: 2 }))
    if (change === 'family') await f.parent.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] })
    if (change === 'paused' || change === 'removed') await f.t.run(ctx => ctx.db.patch(f.mailboxId, { state: change === 'paused' ? 'paused' : 'removed' }))
    if (change === 'grant') await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
    if (change === 'account') await f.t.run(ctx => ctx.db.patch(f.connectionId, { email: 'another@example.test' }))
    if (change === 'membership') await f.t.run(async ctx => ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique())!._id))
    if (change === 'expiry') vi.setSystemTime(now + 86400_001)
    if (change !== 'membership') expect((await f.parent.query(api.mailbox.runs, {}))[0]?.followthrough?.retryable ?? false).toBe(false)
    await expect(f.parent.mutation(api.mailFollowthrough.retry, { runId: f.runId, runVersion: 1, agentVersion: 2 })).rejects.toThrow()
    expect(await f.t.run(ctx => ctx.db.query('mailProposals').collect())).toEqual([])
    vi.setSystemTime(now)
  }
})
it('rejects late failure reports after a lease expires, preserving interrupted recovery', async () => {
  const f = await fixture(); await f.claim()
  vi.setSystemTime(now + mailAgentLimits.leaseMs + 1)
  expect(await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: 1, lease: 'lease-1' })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(f.agentId)))?.status).toBe('running')
  expect(await f.claim(1, f.agentId, 'replacement')).not.toBeNull()
  expect(await f.advance(f.finish(), 1, f.agentId, 'replacement')).toBe(true)
})
it('cancels a scheduled retry if permission is revoked before it wakes', async () => {
  const f = await fixture(); await f.claim()
  await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: 1, lease: 'lease-1' })
  await f.parent.mutation(api.mailFollowthrough.retry, { runId: f.runId, runVersion: 1, agentVersion: 1 })
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 }))
  vi.setSystemTime(now + 60_001)
  expect(await f.claim(2)).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(f.agentId)))?.status).toBe('cancelled')
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
})


it('automatically retries temporary background model failures without renewing its call budget or duplicating proposals', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.runId, { requestId: 'poll:synthetic-background', status: 'partial', hasMore: true }))
  await f.t.run(ctx => ctx.db.patch(f.mailboxId, { activeRunId: f.runId }))
  for (let version = 1; version <= mailAgentLimits.attempts; version++) {
    expect(await f.claim(version)).not.toBeNull()
    await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version, lease: `lease-${version}`, stage: 'model', code: 'rate_limit' })
    await f.t.mutation(internal.mailFollowthrough.recover, { id: f.agentId })
    expect((await f.t.run(ctx => ctx.db.get(f.agentId)))?.status).toBe('failed') // Backoff is real.
    vi.setSystemTime(Date.now() + 60_000)
    await Promise.all(Array.from({ length: 10 }, () => f.t.mutation(internal.mailFollowthrough.recover, { id: f.agentId })))
    const agent = (await f.t.run(ctx => ctx.db.get(f.agentId)))!
    expect(agent.attempts).toBe(version)
    expect(agent.version).toBe(version < mailAgentLimits.attempts ? version + 1 : version)
    expect(agent.status).toBe(version < mailAgentLimits.attempts ? 'queued' : 'failed')
    expect(await f.t.mutation(internal.mailbox.resumePrepared, { id: f.runId, version: 1 })).toBe(false)
  }
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})

it.each(['manual', 'validation', 'backend', 'revoked', 'expired'] as const)('does not automatically retry %s preparation failures', async reason => {
  const f = await fixture()
  if (reason !== 'manual') await f.t.run(ctx => ctx.db.patch(f.runId, { requestId: 'poll:synthetic-background' }))
  await f.claim()
  await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: 1, lease: 'lease-1', stage: ['validation', 'backend'].includes(reason) ? 'validation' : 'model', code: reason === 'backend' ? 'backend_failure' : reason === 'validation' ? 'unverified_output' : 'unavailable' })
  if (reason === 'revoked') await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 }))
  if (reason === 'expired') await f.t.run(ctx => ctx.db.patch(f.messageId, { expiresAt: now }))
  vi.setSystemTime(now + 60_000)
  await f.t.mutation(internal.mailFollowthrough.recover, { id: f.agentId })
  expect(await f.t.run(ctx => ctx.db.get(f.agentId))).toMatchObject({ status: 'failed', version: 1, attempts: 1 })
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
})

it('completes a recovered background preparation exactly once before opening its next read batch', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.runId, { requestId: 'poll:synthetic-background', status: 'partial', hasMore: true, pageToken: 'remaining' }))
  await f.t.run(ctx => ctx.db.patch(f.mailboxId, { activeRunId: f.runId }))
  await f.claim()
  await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: 1, lease: 'lease-1', stage: 'model', code: 'unavailable' })
  vi.setSystemTime(now + 60_000)
  await f.t.mutation(internal.mailFollowthrough.recover, { id: f.agentId })
  expect(await f.claim(2)).not.toBeNull()
  expect(await f.advance(f.finish(), 2)).toBe(true)
  expect(await f.advance(f.finish(), 2)).toBe(false)
  expect(await f.t.mutation(internal.mailbox.resumePrepared, { id: f.runId, version: 1 })).toBe(true)
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ version: 2, status: 'queued', pageToken: 'remaining', messageIds: [] })
  expect((await f.parent.query(api.mailFollowthrough.list, {}))).toMatchObject([{ title: 'Return museum form', status: 'review', stale: false }])
  expect(await f.other.query(api.mailFollowthrough.list, {})).toEqual([])
  for (const table of ['jobs', 'actions', 'approvals', 'attempts', 'mailDrafts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})


it('lets an explicit fresh check recover failed background preparation without letting a second adult or an automatic poll skip it', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.runId, { requestId: 'poll:synthetic-background', status: 'partial', hasMore: true, pageToken: 'remaining' }))
  await f.t.run(ctx => ctx.db.patch(f.mailboxId, { activeRunId: f.runId, nextCheckAt: now }))
  await f.claim()
  const request = { requestId: 'fresh-after-failure', kind: 'check' as const, query: '', lookbackDays: 30, request: 'Check my email again' }
  await expect(f.parent.mutation(api.mailbox.request, request)).rejects.toThrow('already open')
  await f.t.mutation(internal.mailFollowthrough.failed, { id: f.agentId, version: 1, lease: 'lease-1', stage: 'validation', code: 'backend_failure' })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].canContinue).toBe(false)
  await f.t.mutation(internal.mailbox.poll, {})
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))?.version).toBe(1)
  await expect(f.other.mutation(api.mailbox.request, request)).rejects.toThrow('Enable')
  const id = await f.parent.mutation(api.mailbox.request, request)
  expect(id).not.toBe(f.runId)
  expect(await f.parent.mutation(api.mailbox.request, request)).toBe(id)
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'cancelled', version: 2 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'queued', mode: 'baseline', version: 1 })
  expect((await f.t.run(ctx => ctx.db.get(f.agentId)))?.attempts).toBe(1)
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})
