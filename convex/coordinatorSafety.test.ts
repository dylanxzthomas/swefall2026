import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sourceHash } from '../shared/daymark'
import type { Id } from './_generated/dataModel'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(text = 'Help me keep the household organized.') {
  const t = convexTest(schema, modules); workflow.register(t)
  const owner = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await owner.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const sourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text, hash: 'turn', revision: 1, expiresAt: now + 86400000 }))
  const jobId = await t.run(ctx => ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', interactive: true, preparing: true, cancelled: false, clarification: '' }))
  const start = () => t.mutation(internal.assistantCoordinator.start, { jobId, sourceRevision: 1 })
  const tool = (tool = 'family_context', change: Record<string, unknown> = {}) => ({ tool, query: '', id: '', from: '', through: '', answer: '', drafts: [], ...change })
  return { t, owner, other, householdId, sourceId, jobId, text, start, tool }
}
it('binds the personal task snapshot supplied before the model chooses a read tool', async () => {
  const f = await fixture('What responsibilities do I have?'), task = await f.t.run(ctx => ctx.db.insert('personalTasks', { householdId: f.householdId, requestId: 'synthetic-task', requestHash: 'synthetic', title: 'Buy sunscreen', notes: '', version: 1, done: false, createdAt: now, updatedAt: now }))
  const id = (await f.start())!, lease = { id, version: 1, lease: 'lease' }
  const input = await f.t.mutation(internal.assistantCoordinator.claim, lease)
  expect(JSON.stringify(input?.assistant)).toContain('Buy sunscreen')
  await f.t.run(ctx => ctx.db.patch(task, { done: true, version: 2, updatedAt: now + 1 }))
  expect(await f.t.mutation(internal.assistantCoordinator.advance, { ...lease, result: JSON.stringify(f.tool('finish', { answer: 'You still need to buy sunscreen.' })) })).toBe(false)
})
it('requires exact-content identity when retrying an already-shared draft', async () => {
  const f = await fixture('Prepare a family dentist appointment.'), id = (await f.start())!, lease = { id, version: 1, lease: 'lease' }
  await f.t.mutation(internal.assistantCoordinator.claim, lease)
  await f.t.mutation(internal.assistantCoordinator.advance, { ...lease, result: JSON.stringify(f.tool('finish', { answer: 'Here is a draft.', drafts: [{ kind: 'calendar', title: 'Dentist', text: 'Family dentist appointment; please confirm date.', evidence: [{ sourceId: f.sourceId, quote: 'family dentist appointment' }] }] })) })
  const share = { id, version: 1, index: 0, operation: 'share' as const, consent: true as const, text: 'Prepare a family dentist appointment on October 20, 2026 at 10 AM.' }
  const shared = await f.owner.mutation(api.assistantCoordinator.review, share)
  expect(await f.owner.mutation(api.assistantCoordinator.review, share)).toBe(shared)
  await expect(f.owner.mutation(api.assistantCoordinator.review, { ...share, text: 'Prepare an appointment on October 21 instead.' })).rejects.toThrow()
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})
it('does not discard a useful answer when optional learning hits its daily quota', async () => {
  const f = await fixture('Every Sunday at 7 PM, remind me to pack school bags.'), id = (await f.start())!
  await f.t.mutation(internal.assistantCoordinator.claim, { id, version: 1, lease: 'first' })
  await f.t.mutation(internal.assistantCoordinator.advance, { id, version: 1, lease: 'first', result: JSON.stringify(f.tool('learn_process')) })
  await f.t.run(async ctx => { for (let i = 0; i < 10; i++) await ctx.db.insert('workflowCurations', { householdId: f.householdId, createdBy: 'test|parent', jobId: f.jobId, sourceId: f.sourceId, sourceRevision: i + 10, sourceHash: sourceHash(f.text), version: 1, status: 'complete', attempts: 1, createdAt: now, expiresAt: now + 86400000 }) })
  await f.t.mutation(internal.assistantCoordinator.claim, { id, version: 2, lease: 'second' })
  expect(await f.t.mutation(internal.assistantCoordinator.advance, { id, version: 2, lease: 'second', result: JSON.stringify(f.tool('finish', { answer: 'I can help you review a weekly packing routine.' })) })).toBe(true)
  expect((await f.owner.query(api.jobs.list, {})).find(job => job._id === f.jobId)?.preparing).toBe(false)
})
it('binds each historical response to its actual source when the parent repeated identical wording', async () => {
  const f = await fixture('Summarize our earlier discussion.')
  const connectionId = await f.t.run(ctx => ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|parent', provider: 'google', email: 'parent@example.test', status: 'active', version: 1, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }))
  const accountKey = sourceHash(JSON.stringify([connectionId, 'parent@example.test']))
  const mailboxId = await f.t.run(ctx => ctx.db.insert('mailboxes', { householdId: f.householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const ids: Id<'mailMessages'>[] = []
  for (const [offset, label] of [[-2000, 'B'], [-1000, 'A']] as const) {
    vi.setSystemTime(now + offset)
    const messageId = await f.t.run(ctx => ctx.db.insert('mailMessages', { householdId: f.householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: `synthetic-${label}`, sender: 'school@example.test', subject: `Synthetic ${label}`, text: `Private evidence ${label}`, receivedAt: now + offset, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'], version: 1, contentHash: `hash-${label}`, dismissed: false, expiresAt: now + 86400000 }))
    const text = 'What about that?', sourceId = await f.t.run(ctx => ctx.db.insert('sources', { householdId: f.householdId, text, hash: `conversation-${label}`, revision: 1, expiresAt: now + 86400000 }))
    const jobId = await f.t.run(ctx => ctx.db.insert('jobs', { householdId: f.householdId, sourceId, createdBy: 'test|parent', interactive: true, preparing: false, conversation: true, cancelled: false, clarification: `Private response ${label}` }))
    const runId = await f.t.run(ctx => ctx.db.insert('assistantRuns', { householdId: f.householdId, createdBy: 'test|parent', jobId, sourceId, sourceRevision: 1, sourceHash: sourceHash(text), version: 1, status: 'complete', step: 1, attempts: 1, used: [], observations: '[]', refs: [{ kind: 'source', id: sourceId, version: 1, hash: sourceHash(text) }, { kind: 'mail', id: messageId, version: 1, hash: `hash-${label}` }], answer: `Private response ${label}`, createdAt: now + offset, expiresAt: now + 86400000 }))
    await f.t.run(ctx => ctx.db.patch(jobId, { assistantRunId: runId })); ids.push(messageId)
  }
  vi.setSystemTime(now)
  const sourceId = await f.t.run(ctx => ctx.db.insert('sources', { householdId: f.householdId, text: 'Summarize our earlier discussion.', hash: 'current', revision: 1, expiresAt: now + 86400000 }))
  const jobId = await f.t.run(ctx => ctx.db.insert('jobs', { householdId: f.householdId, sourceId, createdBy: 'test|parent', interactive: true, preparing: true, cancelled: false, clarification: '' }))
  const id = (await f.t.mutation(internal.assistantCoordinator.start, { jobId, sourceRevision: 1 }))!, lease = { id, version: 1, lease: 'history' }, input = await f.t.mutation(internal.assistantCoordinator.claim, lease)
  expect(JSON.stringify(input?.assistant)).toContain('Private response B')
  expect(JSON.stringify(input?.assistant)).toContain('Private response A')
  await f.t.run(ctx => ctx.db.patch(ids[0], { dismissed: true, version: 2 }))
  expect(await f.t.mutation(internal.assistantCoordinator.advance, { ...lease, result: JSON.stringify(f.tool('finish', { answer: 'The earlier private response B remains relevant.' })) })).toBe(false)
})
it('uses the valid calendar snapshot while disclosing another disconnected feed without cancelling useful preparation', async () => {
  const f = await fixture('What is happening on our calendar?')
  for (const [label, status] of [['fresh', 'active'], ['disconnected', 'revoked']] as const) {
    const email = `${label}@example.test`, connectionId = await f.t.run(ctx => ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|parent', provider: 'google', email, status, version: 1, scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }))
    const feedId = await f.t.run(ctx => ctx.db.insert('calendarFeeds', { householdId: f.householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, provider: 'google', accountKey: sourceHash(JSON.stringify([connectionId, email])), version: 1, state: 'active', calendars: [{ id: 'primary', name: label, timezone: 'UTC' }], consentedAt: now, createdAt: now, lastCheckedAt: now }))
    const runId = await f.t.run(ctx => ctx.db.insert('calendarFeedRuns', { householdId: f.householdId, createdBy: 'test|parent', feedId, feedVersion: 1, connectionVersion: 1, version: 1, status: 'complete', from: now, through: now + 86400000, calendarIndex: 1, pages: 1, eventCount: 1, omitted: 0, createdAt: now, expiresAt: now + 86400000 }))
    await f.t.run(ctx => ctx.db.patch(feedId, { publishedRunId: runId }))
    await f.t.run(ctx => ctx.db.insert('calendarFeedEvents', { householdId: f.householdId, createdBy: 'test|parent', feedId, runId, key: label, event: { providerId: label, calendarId: 'primary', title: `${label} family appointment`, location: 'Synthetic', start: now + 3600000, end: now + 7200000, allDay: false, timezone: 'UTC', busy: true, recurring: false }, expiresAt: now + 86400000 }))
  }
  const id = (await f.start())!
  await f.t.mutation(internal.assistantCoordinator.claim, { id, version: 1, lease: 'calendar' })
  await f.t.mutation(internal.assistantCoordinator.advance, { id, version: 1, lease: 'calendar', result: JSON.stringify(f.tool('calendar_events', { from: new Date(now).toISOString(), through: new Date(now + 86400000).toISOString() })) })
  const input = await f.t.mutation(internal.assistantCoordinator.claim, { id, version: 2, lease: 'calendar-next' })
  expect(input).not.toBeNull()
  expect(JSON.stringify(input?.observations)).toContain('fresh family appointment')
  expect(JSON.stringify(input?.observations)).not.toContain('disconnected family appointment')
})
