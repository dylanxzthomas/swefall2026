import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import type { MailProposalInput } from '../shared/mailFollowthrough'
import { mailRoutineDecisionLimit } from './mailRoutines'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-15T18:00:00Z')
const definition = { title: 'Permission slips', condition: 'A new email asks for a school permission form.', instruction: 'Prepare a task with the form deadline and what I need to return.' }
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
  const create = (requestId = 'routine-1', changes = {}) => parent.mutation(api.mailRoutines.create, { requestId, definition: { ...definition, ...changes } })
  const id = await create()
  const activate = (version = 1) => parent.mutation(api.mailRoutines.setPaused, { id, version, paused: false })
  const addMessage = (receivedAt = now + 100, text = 'Please return the museum permission form by October 20.', providerId = `provider-${receivedAt}`, threadId = providerId) => t.run(ctx => ctx.db.insert('mailMessages', { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId, threadId, sender: 'school@example.test', subject: 'Museum permission', text, receivedAt, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'], version: 1, contentHash: sourceHash(text), expiresAt: now + 86400_000, dismissed: false }))
  let runCount = 0
  const start = async (ids: Id<'mailMessages'>[]) => {
    const runId = await t.run(ctx => ctx.db.insert('mailRuns', { householdId, createdBy: 'test|parent', mailboxId, mailboxVersion: 1, connectionId, connectionVersion: 1, accountKey, requestId: `run-${++runCount}`, requestHash: 'synthetic', request: 'Check new mail', kind: 'check', query: '', lookbackDays: 30, mode: 'history', scope: 'inbox', status: 'complete', version: 1, scanned: ids.length, segmentScanned: ids.length, from: now - 86400_000, through: now + 500, createdAt: Date.now(), expiresAt: now + 86400_000, messageIds: ids, hasMore: false }))
    const sources = await t.run(async ctx => Promise.all(ids.map(async id => { const m = (await ctx.db.get(id))!; return { id, version: m.version, hash: m.contentHash } })))
    const agentId = (await t.mutation(internal.mailFollowthrough.start, { runId, runVersion: 1, sources }))!
    return { runId, agentId }
  }
  const claim = (agentId: Id<'mailAgents'>, lease = 'fixture') => t.mutation(internal.mailFollowthrough.claim, { id: agentId, version: 1, lease })
  const proposal = (messageId: Id<'mailMessages'>, routineVersion: number | null = 2): MailProposalInput => ({ kind: 'task', messageId, title: 'Return the permission form', details: 'Return the form to school.', dueDate: '2026-10-20', date: '', startTime: '', endTime: '', timezone: '', location: '', question: '', replyBody: '', evidence: [{ messageId, quote: 'Please return the museum permission form by October 20.' }], ...(routineVersion ? { routineRefs: [{ id, version: routineVersion }] } : {}) })
  const finish = (agentId: Id<'mailAgents'>, messageId: Id<'mailMessages'>, proposals = [proposal(messageId)], lease = 'fixture') => t.mutation(internal.mailFollowthrough.advance, { id: agentId, version: 1, lease, result: JSON.stringify({ tool: 'finish', messageId: '', answer: 'The form needs your review.', evidence: [{ messageId, quote: 'Please return the museum permission form by October 20.' }], proposals }) })
  return { t, parent, other, id, householdId, connectionId, mailboxId, create, activate, addMessage, start, claim, proposal, finish }
}
it('saves private paused routines with exact request idempotency, stale protection and no automatic work', async () => {
  const f = await fixture()
  expect(await f.create()).toBe(f.id)
  expect((await f.parent.query(api.mailRoutines.list, {}))[0]).toMatchObject({ id: f.id, version: 1, state: 'paused', definition })
  expect(await f.other.query(api.mailRoutines.list, {})).toEqual([])
  await expect(f.t.query(api.mailRoutines.list, {})).rejects.toThrow('Sign in')
  await expect(f.other.mutation(api.mailRoutines.setPaused, { id: f.id, version: 1, paused: false })).rejects.toThrow('unavailable')
  await expect(f.other.query(api.mailRoutines.history, { id: f.id })).rejects.toThrow('unavailable')
  await expect(f.create('routine-1', { instruction: 'A different instruction' })).rejects.toThrow('identifier')
  await f.parent.mutation(api.mailRoutines.update, { id: f.id, version: 1, definition: { ...definition, title: 'My slips' } })
  await expect(f.activate()).rejects.toThrow('changed')
  await f.parent.mutation(api.mailRoutines.remove, { id: f.id, version: 2 })
  expect(await f.create()).toBe(f.id)
  expect(await f.parent.query(api.mailRoutines.list, {})).toEqual([])
  for (const table of ['mailAgents', 'mailProposals', 'mailRoutineDecisions', 'jobs', 'approvals', 'attempts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('requires current private Gmail consent and limits saved routines per adult', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  await expect(f.activate()).rejects.toThrow('Enable Gmail')
  for (let n = 1; n < 10; n++) await f.create(`routine-${n + 1}`, { title: `Routine ${n}` })
  await expect(f.create('eleventh', { title: 'Another routine' })).rejects.toThrow('10 email routines')
  expect(await f.parent.query(api.mailRoutines.list, {})).toHaveLength(10)
})
it('adds routines to the same model pass only for new messages and saves one source-bound private proposal', async () => {
  const f = await fixture(); await f.activate(); vi.setSystemTime(now + 100)
  const old = await f.addMessage(now), fresh = await f.addMessage(), { agentId } = await f.start([old, fresh]), claim = await f.claim(agentId)
  expect(claim?.routines).toEqual([{ id: f.id, version: 2, definition, eligibleMessageIds: [fresh] }])
  expect(JSON.stringify(claim)).not.toMatch(/refreshToken|accessToken|cipher/)
  await expect(f.finish(agentId, old)).rejects.toThrow('eligible routine')
  expect(await f.finish(agentId, fresh)).toBe(true)
  const proposals = await f.parent.query(api.mailFollowthrough.list, {})
  expect(proposals).toHaveLength(1); expect(proposals[0]).toMatchObject({ routineRefs: [{ id: f.id, version: 2 }], stale: false, status: 'review' })
  const row = (await f.t.run(ctx => ctx.db.query('mailProposals').collect()))[0]
  expect(row.mailRoutineBindings?.[0]).toMatchObject({ routineId: f.id, routineVersion: 2, messageId: fresh, mailboxId: f.mailboxId, connectionVersion: 1, activatedAt: now })
  const decisions = await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())
  expect(decisions).toHaveLength(1); expect(decisions[0]).toMatchObject({ decision: 'prepared', messageId: fresh })
  expect(await f.parent.query(api.mailRoutines.history, { id: f.id })).toEqual([expect.objectContaining({ status: 'prepared', routineVersion: 2 })])
  expect((await f.parent.query(api.mailRoutines.list, {}))[0].lastPreparedAt).toBe(now + 100)
  for (const table of ['jobs', 'actions', 'approvals', 'attempts', 'mailDrafts', 'privateTasks'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('coalesces concurrent starts and finishes, preserves dismissal and never replays the same provider message', async () => {
  const f = await fixture(); await f.activate(); const m = await f.addMessage(), { agentId } = await f.start([m])
  const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => f.claim(agentId, `lease-${i}`)))
  expect(claims.filter(Boolean)).toHaveLength(1)
  const lease = (await f.t.run(ctx => ctx.db.get(agentId)))!.lease!
  const finishes = await Promise.all(Array.from({ length: 12 }, () => f.finish(agentId, m, [f.proposal(m)], lease)))
  expect(finishes.filter(Boolean)).toHaveLength(1)
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0]
  await f.parent.mutation(api.mailFollowthrough.decide, { id: p.id as Id<'mailProposals'>, version: p.version, operation: 'dismiss' })
  const again = await f.start([m]); expect((await f.claim(again.agentId))?.routines).toEqual([])
  await expect(f.finish(again.agentId, m)).rejects.toThrow('eligible routine')
  await f.finish(again.agentId, m, [f.proposal(m, null)])
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0].status).toBe('dismissed')
  expect(await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())).toHaveLength(1)
})
it('records a quiet model decision without a task and keeps ordinary generic follow-ups working', async () => {
  const f = await fixture(); await f.activate(); const m = await f.addMessage(), first = await f.start([m]); await f.claim(first.agentId)
  await f.finish(first.agentId, m, [])
  expect(await f.parent.query(api.mailFollowthrough.list, {})).toEqual([])
  expect(await f.parent.query(api.mailRoutines.history, { id: f.id })).toEqual([])
  expect((await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect()))[0].decision).toBe('skipped')
  const second = await f.start([m]); expect((await f.claim(second.agentId))?.routines).toEqual([])
  await f.finish(second.agentId, m, [f.proposal(m, null)])
  expect((await f.parent.query(api.mailFollowthrough.list, {}))[0]).toMatchObject({ stale: false, status: 'review' })
})
it('invalidates in-flight routine work after pause, editing, removal or revoked access', async () => {
  for (const change of ['pause', 'edit', 'remove', 'grant', 'source'] as const) {
    const f = await fixture(); await f.activate(); const m = await f.addMessage(), { agentId } = await f.start([m]); await f.claim(agentId)
    if (change === 'pause') await f.parent.mutation(api.mailRoutines.setPaused, { id: f.id, version: 2, paused: true })
    if (change === 'edit') await f.parent.mutation(api.mailRoutines.update, { id: f.id, version: 2, definition: { ...definition, instruction: 'Prepare a calendar review instead.' } })
    if (change === 'remove') await f.parent.mutation(api.mailRoutines.remove, { id: f.id, version: 2 })
    if (change === 'grant') await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
    if (change === 'source') await f.t.run(ctx => ctx.db.patch(m, { version: 2 }))
    expect(await f.finish(agentId, m)).toBe(false)
    expect(await f.t.run(ctx => ctx.db.query('mailProposals').collect())).toEqual([])
    expect(await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())).toEqual([])
  }
})
it('gates pending edit/keep/share/reply after routine pause but preserves explicitly saved independent tasks', async () => {
  const f = await fixture(); await f.activate(); const m = await f.addMessage(), { agentId } = await f.start([m]); await f.claim(agentId)
  const task = f.proposal(m), calendar = { ...task, kind: 'calendar' as const, question: 'What are the pickup times?' }, reply = { ...task, kind: 'reply' as const, replyBody: 'Could you confirm the deadline?' }
  await f.finish(agentId, m, [task, calendar, reply])
  const proposals = await f.parent.query(api.mailFollowthrough.list, {}), p = proposals.find(p => p.kind === 'task')!
  await f.parent.mutation(api.mailFollowthrough.decide, { id: p.id as Id<'mailProposals'>, version: 1, operation: 'keep' })
  await f.parent.mutation(api.mailRoutines.setPaused, { id: f.id, version: 2, paused: true })
  const c = proposals.find(p => p.kind === 'calendar')!, r = proposals.find(p => p.kind === 'reply')!
  await expect(f.parent.mutation(api.mailFollowthrough.update, { id: c.id as Id<'mailProposals'>, version: 1, input: calendar })).rejects.toThrow('changed')
  await expect(f.parent.mutation(api.mailFollowthrough.shareCalendar, { id: c.id as Id<'mailProposals'>, version: 1, text: 'Prepare only this calendar entry.', consent: true })).rejects.toThrow('current')
  await expect(f.parent.mutation(api.mailFollowthrough.reviewReply, { id: r.id as Id<'mailProposals'>, version: 1 })).rejects.toThrow('current')
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toHaveLength(1)
  expect((await f.parent.query(api.mailFollowthrough.list, {})).every(p => p.stale)).toBe(true)
  expect((await f.parent.query(api.mailRoutines.history, { id: f.id }))[0].status).toBe('superseded')
})
it('resume and active edits move the new-message boundary forward instead of catching up old emails', async () => {
  const f = await fixture(); await f.activate()
  vi.setSystemTime(now + 200)
  await f.parent.mutation(api.mailRoutines.setPaused, { id: f.id, version: 2, paused: true })
  const whilePaused = await f.addMessage(now + 250)
  vi.setSystemTime(now + 300); await f.parent.mutation(api.mailRoutines.setPaused, { id: f.id, version: 3, paused: false })
  const a = await f.start([whilePaused]); expect((await f.claim(a.agentId))?.routines).toEqual([])
  vi.setSystemTime(now + 400)
  await f.parent.mutation(api.mailRoutines.update, { id: f.id, version: 4, definition: { ...definition, instruction: 'Keep the same deadline but ask about missing details.' } })
  const beforeEdit = await f.addMessage(now + 350), afterEdit = await f.addMessage(now + 450), b = await f.start([beforeEdit, afterEdit])
  expect((await f.claim(b.agentId))?.routines[0]).toMatchObject({ version: 5, eligibleMessageIds: [afterEdit] })
})
it('cannot erase routine provenance when editing and combines overlapping routines without duplicate cards', async () => {
  const f = await fixture(); await f.activate(); const second = await f.create('routine-other', { title: 'School paperwork' }); await f.parent.mutation(api.mailRoutines.setPaused, { id: second, version: 1, paused: false })
  const m = await f.addMessage(), { agentId } = await f.start([m]); await f.claim(agentId)
  const p = { ...f.proposal(m), routineRefs: [{ id: f.id, version: 2 }, { id: second, version: 2 }] }
  await f.finish(agentId, m, [p])
  const result = (await f.parent.query(api.mailFollowthrough.list, {}))[0]
  expect(await f.t.run(ctx => ctx.db.query('mailProposals').collect())).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())).toHaveLength(2)
  await expect(f.parent.mutation(api.mailFollowthrough.update, { id: result.id as Id<'mailProposals'>, version: 1, input: f.proposal(m, null) })).rejects.toThrow('references')
})
it('stops routine preparation at the durable decision limit without stopping generic email help', async () => {
  const f = await fixture(); await f.activate(); await f.t.run(ctx => ctx.db.patch(f.id, { decisionCount: mailRoutineDecisionLimit - 1 }))
  const a = await f.addMessage(now + 100), b = await f.addMessage(now + 200), run = await f.start([a, b]), input = await f.claim(run.agentId)
  expect(input?.routines[0].eligibleMessageIds).toHaveLength(1)
  await f.finish(run.agentId, a)
  expect((await f.parent.query(api.mailRoutines.list, {}))[0].issue).toContain('saved-message limit')
  const next = await f.start([b]); expect((await f.claim(next.agentId))?.routines).toEqual([])
  await f.finish(next.agentId, b, [f.proposal(b, null)])
  expect((await f.parent.query(api.mailFollowthrough.list, {})).some(p => p.messageId === b && !p.stale)).toBe(true)
})
it('coalesces the same new message across independently claimed scan runs and cannot replay a paused review', async () => {
  const f = await fixture(); await f.activate(); const m = await f.addMessage(), a = await f.start([m]), b = await f.start([m])
  expect((await f.claim(a.agentId))?.routines).toHaveLength(1)
  expect((await f.claim(b.agentId))?.routines).toHaveLength(1)
  const results = await Promise.allSettled([f.finish(a.agentId, m), f.finish(b.agentId, m)])
  expect(results.filter(r => r.status === 'fulfilled' && r.value === true)).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('mailProposals').collect())).toHaveLength(1)
  const p = (await f.parent.query(api.mailFollowthrough.list, {}))[0]
  await f.parent.mutation(api.mailRoutines.setPaused, { id: f.id, version: 2, paused: true })
  await expect(f.parent.mutation(api.mailFollowthrough.decide, { id: p.id as Id<'mailProposals'>, version: p.version, operation: 'keep' })).rejects.toThrow('changed')
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toEqual([])
})
it('rejects another adult’s routine references even within the same household', async () => {
  const f = await fixture(); await f.activate()
  const foreignId = await f.other.mutation(api.mailRoutines.create, { definition, requestId: 'foreign' })
  const m = await f.addMessage(), a = await f.start([m]); const claim = await f.claim(a.agentId)
  expect(claim?.routines.map(r => r.id)).toEqual([f.id])
  await expect(f.finish(a.agentId, m, [{ ...f.proposal(m), routineRefs: [{ id: foreignId, version: 1 }] }])).rejects.toThrow('eligible routine')
  expect(await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())).toEqual([])
  expect(await f.other.query(api.mailFollowthrough.list, {})).toEqual([])
})
