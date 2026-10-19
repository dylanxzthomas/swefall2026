import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import type { Id } from './_generated/dataModel'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test'); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'school@example.test') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(count = 1) {
  const t = convexTest(schema, modules); workflow.register(t)
  const owner = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await owner.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const sourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text: 'Prepare a private reply to the picnic email.', hash: 'parent-turn', revision: 1, expiresAt: now + 86400000 }))
  const jobId = await t.run(ctx => ctx.db.insert('jobs', { householdId, createdBy: 'test|parent', sourceId, interactive: true, preparing: true, cancelled: false, clarification: '' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', email: 'parent@example.test', cipher: 'synthetic-unused', status: 'active', version: 1, scopes: [gmailReadScope] }))
  const accountKey = sourceHash(JSON.stringify([connectionId, 'parent@example.test']))
  const mailboxId = await t.run(ctx => ctx.db.insert('mailboxes', { householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const addMessage = (threadId = 'picnic', receivedAt = now - 1000) => t.run(ctx => ctx.db.insert('mailMessages', { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: threadId + receivedAt, threadId, sender: 'School Office <school@example.test>', subject: 'Picnic', text: 'Please bring plates.', receivedAt, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'], version: 1, contentHash: sourceHash('Please bring plates.'), dismissed: false, expiresAt: now + 86400000 }))
  const messages: Id<'mailMessages'>[] = []; for (let i = 0; i < count; i++) messages.push(await addMessage(`picnic-${i}`))
  const id = (await t.mutation(internal.assistantCoordinator.start, { jobId, sourceRevision: 1 }))!
  const tool = (name: string) => ({ tool: name, query: '', id: '', from: '', through: '', answer: '', drafts: [] })
  await t.mutation(internal.assistantCoordinator.claim, { id, version: 1, lease: 'read' })
  await t.mutation(internal.assistantCoordinator.advance, { id, version: 1, lease: 'read', result: JSON.stringify(tool('mail_search')) })
  await t.mutation(internal.assistantCoordinator.claim, { id, version: 2, lease: 'finish' })
  const evidence = count ? messages.map(sourceId => ({ sourceId, quote: 'Please bring plates.' })) : [{ sourceId, quote: 'Prepare a private reply' }]
  await t.mutation(internal.assistantCoordinator.advance, { id, version: 2, lease: 'finish', result: JSON.stringify({ ...tool('finish'), answer: 'Review this private reply.', drafts: [{ kind: 'task', title: 'Bring plates', text: 'Bring plates to the picnic.', evidence }, { kind: 'email', title: 'Reply to the picnic email', text: 'We can bring plates.', evidence }, { kind: 'calendar', title: 'Review picnic plan', text: 'Prepare the picnic plan for review.', evidence }] }) })
  const args = { id, version: 2, index: 1, text: 'Thank you. We can bring plates.', operation: 'reply' as const }
  return { t, owner, other, householdId, sourceId, jobId, connectionId, mailboxId, messages, id, args, addMessage }
}

const keepArgs = (f: Awaited<ReturnType<typeof fixture>>) => ({ id: f.id, version: 2, index: 0, text: 'Bring only the plates.', operation: 'keep' as const })
it.each(['keep', 'done'] as const)('keeps sibling reply and calendar review usable after an explicit task %s', async operation => {
  const f = await fixture(), before = (await f.t.run(ctx => ctx.db.get(f.id)))!
  expect((await f.owner.query(api.assistantCoordinator.list, {}))[0]).toMatchObject({ stale: false, drafts: expect.any(Array) })
  const taskId = await f.owner.mutation(api.assistantCoordinator.review, { ...keepArgs(f), operation })
  const after = (await f.t.run(ctx => ctx.db.get(f.id)))!
  expect(after.refs.filter(ref => ref.kind !== 'family')).toEqual(before.refs.filter(ref => ref.kind !== 'family'))
  expect(after.refs.filter(ref => ref.kind === 'family')).not.toEqual(before.refs.filter(ref => ref.kind === 'family'))
  expect(after.contextBindings).toEqual(before.contextBindings)
  expect(after.mailContext).toEqual(before.mailContext); expect(after.workingContext).toEqual(before.workingContext)
  const view = (await f.owner.query(api.assistantCoordinator.list, {}))[0]
  expect(view.stale).toBe(false); expect(view.drafts).toHaveLength(3)
  expect(view.drafts[0].privateTaskId).toBe(taskId)
  expect((await f.owner.query(api.privateTasks.list, {})).tasks).toEqual([expect.objectContaining({ id: taskId, text: 'Bring only the plates.', done: operation === 'done' })])
  const draftId = (await f.owner.mutation(api.assistantCoordinator.review, { ...f.args, version: 3 })) as Id<'mailDrafts'>
  const reply = (await f.t.run(ctx => ctx.db.get(draftId)))!
  await f.owner.mutation(api.mailDrafts.edit, { id: draftId, version: 1, input: { ...reply.input, body: 'My edited private reply.' } })
  const sharedId = await f.owner.mutation(api.assistantCoordinator.review, { id: f.id, version: 4, index: 2, text: 'Prepare only this picnic plan.', operation: 'share', consent: true })
  const sharedSource = await f.t.run(async ctx => { const job = await ctx.db.get(sharedId as Id<'jobs'>); return ctx.db.get(job!.sourceId) })
  expect(sharedSource!.text).toBe('Prepare only this picnic plan.')
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})
it('preserves an already handed-off private reply when a sibling task is kept', async () => {
  const f = await fixture(), draftId = (await f.owner.mutation(api.assistantCoordinator.review, f.args)) as Id<'mailDrafts'>
  await f.owner.mutation(api.assistantCoordinator.review, { ...keepArgs(f), version: 3 })
  expect((await f.owner.query(api.assistantCoordinator.list, {}))[0]).toMatchObject({ stale: false, version: 4 })
  const reply = (await f.t.run(ctx => ctx.db.get(draftId)))!
  await f.owner.mutation(api.mailDrafts.edit, { id: draftId, version: 1, input: { ...reply.input, body: 'A private correction after task review.' } })
  expect((await f.owner.query(api.mailDrafts.list, {}))[0].body).toBe('A private correction after task review.')
})
it.each(['task', 'family', 'mail', 'source', 'saved-task-edit'] as const)('preserves invalidation after a later external %s change and never refreshes on keep replay', async change => {
  const f = await fixture(), keep = keepArgs(f)
  const savedId = (await f.owner.mutation(api.assistantCoordinator.review, keep)) as Id<'privateTasks'>
  const draftId = (await f.owner.mutation(api.assistantCoordinator.review, { ...f.args, version: 3 })) as Id<'mailDrafts'>
  const before = (await f.t.run(ctx => ctx.db.get(f.id)))!, reply = (await f.t.run(ctx => ctx.db.get(draftId)))!
  if (change === 'task') await f.t.mutation(internal.privateTasks.keep, { householdId: f.householdId, subject: 'test|parent', key: 'another_review:0', title: 'External task', text: 'Another explicitly kept task.' })
  if (change === 'family') await f.owner.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [] })
  if (change === 'mail') await f.t.run(ctx => ctx.db.patch(f.messages[0], { version: 2, contentHash: 'external-mail-change' }))
  if (change === 'source') await f.t.run(ctx => ctx.db.patch(f.sourceId, { revision: 2, text: 'A changed parent request.' }))
  if (change === 'saved-task-edit') await f.owner.mutation(api.privateTasks.update, { id: savedId, version: 1, title: 'My later correction', text: 'Updated independently after review.' })
  expect((await f.owner.query(api.assistantCoordinator.list, {}))[0]).toMatchObject({ stale: true, drafts: [] })
  expect(await f.owner.mutation(api.assistantCoordinator.review, keep)).toBe(savedId)
  const after = (await f.t.run(ctx => ctx.db.get(f.id)))!
  expect(after.refs).toEqual(before.refs); expect(after.contextBindings).toEqual(before.contextBindings); expect(after.version).toBe(before.version)
  expect((await f.owner.query(api.assistantCoordinator.list, {}))[0].stale).toBe(true)
  await expect(f.owner.mutation(api.mailDrafts.edit, { id: draftId, version: 1, input: reply.input })).rejects.toThrow('supporting assistant context changed')
  await expect(f.owner.mutation(api.assistantCoordinator.review, { id: f.id, version: 4, index: 2, text: 'Prepare the picnic plan.', operation: 'share', consent: true })).rejects.toThrow('sources changed')
})
it('never refreshes stale context when an external family change preceded the initial keep', async () => {
  const f = await fixture(), before = (await f.t.run(ctx => ctx.db.get(f.id)))!
  await f.owner.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [] })
  await expect(f.owner.mutation(api.assistantCoordinator.review, keepArgs(f))).rejects.toThrow('sources changed')
  expect((await f.t.run(ctx => ctx.db.get(f.id)))!.refs).toEqual(before.refs)
  expect((await f.owner.query(api.privateTasks.list, {})).tasks).toEqual([])
})
it('coalesces 50 keeps without duplicate tasks or invalidating sibling preparation', async () => {
  const f = await fixture(), keep = keepArgs(f)
  const ids = await Promise.all(Array.from({ length: 50 }, () => f.owner.mutation(api.assistantCoordinator.review, keep)))
  expect(new Set(ids).size).toBe(1)
  expect((await f.owner.query(api.privateTasks.list, {})).tasks).toHaveLength(1)
  const view = (await f.owner.query(api.assistantCoordinator.list, {}))[0]
  expect(view).toMatchObject({ stale: false, version: 3 }); expect(view.drafts).toHaveLength(3)
})
