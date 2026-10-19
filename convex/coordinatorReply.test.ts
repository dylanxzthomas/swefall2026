import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { hash, sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import { gmailComposeScope, privateReplySchema } from '../shared/mailbox'
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
  await t.mutation(internal.assistantCoordinator.advance, { id, version: 2, lease: 'finish', result: JSON.stringify({ ...tool('finish'), answer: 'Review this private reply.', drafts: [{ kind: 'email', title: 'Reply to the picnic email', text: 'We can bring plates.', evidence }] }) })
  const args = { id, version: 2, index: 0, text: 'Thank you. We can bring plates.', operation: 'reply' as const }
  return { t, owner, other, householdId, sourceId, jobId, connectionId, mailboxId, messages, id, args, addMessage }
}
it('creates one private reviewed reply from the verified sender, preserves parent edits and never approves or shares', async () => {
  const f = await fixture(), view = (await f.owner.query(api.assistantCoordinator.list, {}))[0]
  const replyRouting = { threadId: 'picnic-0', inReplyTo: '<picnic@school.example>', references: ['<picnic@school.example>'], subject: 'Re: Picnic' }
  await f.t.run(ctx => ctx.db.patch(f.messages[0], { replyRouting }))
  expect(view.drafts[0].replySource).toEqual({ messageId: f.messages[0], version: 1, to: 'school@example.test', subject: 'Re: Picnic', accountEmail: 'parent@example.test' })
  expect(JSON.stringify(view)).not.toMatch(/cipher|accountKey|preparationKey/)
  expect(await f.t.run(ctx => ctx.db.query('mailDrafts').collect())).toEqual([])
  const ids = await Promise.all(Array.from({ length: 50 }, () => f.owner.mutation(api.assistantCoordinator.review, f.args)))
  expect(new Set(ids).size).toBe(1)
  const id = ids[0] as Id<'mailDrafts'>, draft = (await f.t.run(ctx => ctx.db.get(id)))!
  expect(draft).toMatchObject({ assistantRunId: f.id, createdBy: 'test|parent', messageId: f.messages[0], sourceVersion: 1, version: 1, status: 'review', replyRouting, input: { to: 'school@example.test', subject: 'Re: Picnic', body: f.args.text } })
  expect((await f.owner.query(api.assistantCoordinator.list, {}))[0].drafts[0].privateMailDraftId).toBe(id)
  await f.owner.mutation(api.mailDrafts.edit, { id, version: 1, input: { ...draft.input, body: 'My independently edited private reply.' } })
  expect(await f.owner.mutation(api.assistantCoordinator.review, f.args)).toBe(id)
  expect((await f.owner.query(api.mailDrafts.list, {}))[0]).toMatchObject({ body: 'My independently edited private reply.', version: 2 })
  await expect(f.owner.mutation(api.assistantCoordinator.review, { ...f.args, text: 'Different body.' })).rejects.toThrow('different details')
  await expect(f.other.mutation(api.assistantCoordinator.review, f.args)).rejects.toThrow('unavailable')
  expect(await f.other.query(api.mailDrafts.list, {})).toEqual([])
  for (const table of ['actions', 'approvals', 'attempts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('jobs').collect())).toHaveLength(1)
})
it('requires one cited and run-bound private source and keeps ambiguous email on the generic path', async () => {
  for (const change of ['none', 'multiple', 'unbound', 'sender', 'owner'] as const) {
    const f = await fixture(change === 'none' ? 0 : change === 'multiple' ? 2 : 1)
    if (change === 'unbound') await f.t.run(async ctx => { const run = (await ctx.db.get(f.id))!; await ctx.db.patch(f.id, { refs: run.refs.filter(ref => ref.kind !== 'mail') }) })
    if (change === 'sender') await f.t.run(ctx => ctx.db.patch(f.messages[0], { sender: 'school@example.test, stranger@example.test' }))
    if (change === 'owner') await f.t.run(ctx => ctx.db.patch(f.messages[0], { createdBy: 'test|other' }))
    expect((await f.owner.query(api.assistantCoordinator.list, {}))[0].drafts[0]?.replySource).toBeUndefined()
    await expect(f.owner.mutation(api.assistantCoordinator.review, f.args)).rejects.toThrow()
    expect(await f.t.run(ctx => ctx.db.query('mailDrafts').collect())).toEqual([])
  }
})
it('rechecks run revision, source, grant, pause, expiry and newer thread before creation or replay', async () => {
  for (const change of ['revision', 'source', 'grant', 'pause', 'expiry', 'thread', 'sender'] as const) for (const replay of [false, true]) {
    const f = await fixture()
    if (replay) await f.owner.mutation(api.assistantCoordinator.review, f.args)
    if (change === 'revision') await f.t.run(async ctx => { const run = (await ctx.db.get(f.id))!; await ctx.db.patch(f.id, { version: run.version + 1 }) })
    if (change === 'source') await f.t.run(ctx => ctx.db.patch(f.messages[0], { version: 2, contentHash: 'changed' }))
    if (change === 'grant') await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 }))
    if (change === 'pause') await f.t.run(ctx => ctx.db.patch(f.mailboxId, { state: 'paused', version: 2 }))
    if (change === 'expiry') vi.setSystemTime(now + 86400001)
    if (change === 'thread') await f.addMessage('picnic-0', now)
    if (change === 'sender') await f.t.run(ctx => ctx.db.patch(f.messages[0], { sender: 'invalid sender' }))
    // A retry of the exact journalled decision may retain its original run version.
    if (change === 'revision' && replay) expect(await f.owner.mutation(api.assistantCoordinator.review, f.args)).toBeTruthy()
    else await expect(f.owner.mutation(api.assistantCoordinator.review, f.args)).rejects.toThrow()
    expect(await f.t.run(ctx => ctx.db.query('mailDrafts').collect())).toHaveLength(replay ? 1 : 0)
    vi.setSystemTime(now)
  }
})
it('rejects oversized or empty reviewed bodies without creating private or shared work', async () => {
  const f = await fixture()
  for (const text of ['', ' ', 'x'.repeat(4001)]) await expect(f.owner.mutation(api.assistantCoordinator.review, { ...f.args, text })).rejects.toThrow('4,000')
  expect(await f.t.run(ctx => ctx.db.query('mailDrafts').collect())).toEqual([])
})
it('rechecks secondary coordinator sources at direct private edit, Gmail save and send boundaries', async () => {
  for (const phase of ['review', 'save-claim', 'save-dispatch', 'send-review', 'send-dispatch'] as const) for (const context of ['secondary-mail', 'parent-source'] as const) {
    const f = await fixture(2)
    await f.t.run(async ctx => {
      const run = (await ctx.db.get(f.id))!
      await ctx.db.patch(f.id, { deliverables: run.deliverables!.map(d => ({ ...d, evidence: [d.evidence[0]] })) })
      await ctx.db.patch(f.connectionId, { scopes: [gmailReadScope, gmailComposeScope] })
    })
    const id = (await f.owner.mutation(api.assistantCoordinator.review, f.args)) as Id<'mailDrafts'>
    const input = (await f.t.run(ctx => ctx.db.get(id)))!.input
    const saveLease = { id, version: 2, lease: 'save' }, sendLease = { id, version: 2, lease: 'send' }
    if (phase.startsWith('save')) {
      await f.owner.mutation(api.mailDrafts.approveSave, { id, version: 1, input })
      if (phase === 'save-dispatch') expect(await f.t.mutation(internal.mailDrafts.claimSave, { ...saveLease, readOnly: false })).toBeTruthy()
    }
    if (phase.startsWith('send')) {
      await f.t.run(ctx => ctx.db.patch(id, { status: 'saved', gmailDraftId: 'synthetic-existing-draft', approvedHash: hash(JSON.stringify(privateReplySchema.parse(input))), operationKey: 'synthetic-save', verifiedAt: now }))
      if (phase === 'send-dispatch') {
        await f.owner.mutation(api.mailSending.approve, { id, version: 1, input })
        expect(await f.t.mutation(internal.mailSending.claim, { ...sendLease, readOnly: false })).toBeTruthy()
      }
    }
    // The primary reply source and its connection stay current; only another read changes.
    if (context === 'secondary-mail') await f.t.run(ctx => ctx.db.patch(f.messages[1], { version: 2, contentHash: 'secondary-source-changed' }))
    else await f.t.run(ctx => ctx.db.patch(f.sourceId, { revision: 2, text: 'The parent corrected the request.' }))
    expect(await f.t.run(ctx => ctx.db.get(f.messages[0]))).toMatchObject({ version: 1, contentHash: sourceHash('Please bring plates.') })
    if (phase === 'review') {
      await expect(f.owner.mutation(api.mailDrafts.edit, { id, version: 1, input })).rejects.toThrow('supporting assistant context changed')
      await expect(f.owner.mutation(api.mailDrafts.approveSave, { id, version: 1, input })).rejects.toThrow('supporting assistant context changed')
    } else if (phase === 'save-claim') expect(await f.t.mutation(internal.mailDrafts.claimSave, { ...saveLease, readOnly: false })).toBeNull()
    else if (phase === 'save-dispatch') {
      expect(await f.t.query(internal.mailDrafts.permitted, saveLease)).toBe(false)
      expect(await f.t.mutation(internal.mailDrafts.dispatch, saveLease)).toBe(false)
    } else if (phase === 'send-review') await expect(f.owner.mutation(api.mailSending.approve, { id, version: 1, input })).rejects.toThrow('supporting assistant context changed')
    else {
      expect(await f.t.query(internal.mailSending.permitted, { ...sendLease, readOnly: false })).toBe(false)
      expect(await f.t.mutation(internal.mailSending.dispatch, sendLease)).toBe(false)
    }
    const row = (await f.t.run(ctx => ctx.db.get(id)))!
    expect(row.dispatchedAt).toBeUndefined(); expect(row.sendDispatchedAt).toBeUndefined()
  }
})
