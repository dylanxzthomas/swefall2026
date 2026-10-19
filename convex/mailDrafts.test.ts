// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { gmailReplyHash, type GmailReplyRouting } from '../shared/gmailReply'
import { hash, sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import { gmailComposeScope } from '../shared/mailbox'
const mocks = vi.hoisted(() => ({ threadGet: vi.fn(), create: vi.fn(), get: vi.fn(), list: vi.fn(), profile: vi.fn(), send: vi.fn(), update: vi.fn(), sentGet: vi.fn(), sentList: vi.fn(), model: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { getProfile: mocks.profile, threads: { get: mocks.threadGet }, drafts: { create: mocks.create, get: mocks.get, list: mocks.list, send: mocks.send, update: mocks.update }, messages: { get: mocks.sentGet, list: mocks.sentList } } }) }))
vi.mock('./google', () => ({ withGoogle: async (_ctx: unknown, _approval: unknown, fn: (auth: object) => Promise<unknown>) => fn({}) }))
vi.mock('../server/model', () => ({ extractStructured: mocks.model }))
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-06T12:00:00Z')
const reply = { to: 'school@example.test', subject: 'Re: Picnic', body: 'Thanks. We can bring plates.' }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks()
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-not-used'); vi.stubEnv('DAYMARK_MODEL', 'synthetic-not-used')
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test')
  vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'school@example.test')
  mocks.model.mockResolvedValue({ body: reply.body }); mocks.profile.mockResolvedValue({ data: { emailAddress: 'parent@example.test' } })
  let raw = '', threadId: string | undefined
  mocks.create.mockImplementation(async args => { raw = args.requestBody.message.raw; threadId = args.requestBody.message.threadId; return { data: { id: 'saved-draft' } } })
  mocks.get.mockImplementation(async ({ id }) => ({ data: { id, message: { id: 'saved-message', threadId, labelIds: ['DRAFT'], raw } } }))
  mocks.update.mockImplementation(async args => { raw = args.requestBody.message.raw; threadId = args.requestBody.message.threadId; return { data: { id: args.id } } })
  let sentRaw = '', sentThreadId: string | undefined
  mocks.send.mockImplementation(async args => { sentRaw = args.requestBody.message.raw; sentThreadId = args.requestBody.message.threadId; return { data: { id: 'sent-message' } } })
  mocks.sentGet.mockImplementation(async ({ id }) => ({ data: { id, threadId: sentThreadId, labelIds: ['SENT'], raw: sentRaw } }))
  mocks.sentList.mockResolvedValue({ data: { messages: [{ id: 'sent-message' }] } })
  mocks.list.mockResolvedValue({ data: { drafts: [] } })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(compose = true, replyRouting?: GmailReplyRouting) {
  const t = convexTest(schema, modules)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' }), outsider = t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', email: 'parent@example.test', cipher: 'synthetic-unused', status: 'active', version: 1, scopes: [gmailReadScope, ...(compose ? [gmailComposeScope] : [])] }))
  const accountKey = sourceHash(JSON.stringify([connectionId, 'parent@example.test']))
  const mailboxId = await t.run(ctx => ctx.db.insert('mailboxes', { householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const messageId = await t.run(ctx => ctx.db.insert('mailMessages', { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: 'synthetic-source', threadId: 'synthetic-thread', replyRouting, sender: 'school@example.test', subject: 'Picnic', text: 'Please bring plates.', receivedAt: now - 1000, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'], version: 1, contentHash: sourceHash('Please bring plates.'), dismissed: false, expiresAt: now + 86400_000 }))
  const start = () => parent.mutation(api.mailDrafts.prepare, { messageId, version: 1, instruction: 'Say we can bring plates.' })
  const review = async () => { const id = await start(); await t.action(internal.gmailDrafts.prepare, { id, version: 1 }); return id }
  const saved = async () => { const id = await review(); await parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply }); await t.action(internal.gmailDrafts.save, { id, version: 3 }); return id }
  return { t, parent, other, outsider, householdId, connectionId, accountKey, mailboxId, messageId, start, review, saved }
}
const replyRouting = { threadId: 'synthetic-thread', inReplyTo: '<school-notice@example.test>', references: ['<earlier@example.test>', '<school-notice@example.test>'], subject: reply.subject }
it('carries server-owned reply routing through review, exact save, same-ID update, separately approved send and SENT verification', async () => {
  const f = await fixture(true, replyRouting), id = await f.saved()
  const saved = (await f.t.run(ctx => ctx.db.get(id)))!
  expect(saved).toMatchObject({ status: 'saved', replyRouting, approvedHash: gmailReplyHash(reply, replyRouting) })
  expect(mocks.create.mock.calls[0][0].requestBody.message.threadId).toBe(replyRouting.threadId)
  const updated = { ...reply, body: 'Thanks. We can bring plates and cups.' }
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 4, input: updated })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.previous).toMatchObject({ input: reply, replyRouting, approvedHash: gmailReplyHash(reply, replyRouting) })
  await f.t.action(internal.gmailDrafts.save, { id, version: 5 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'saved', version: 6, gmailDraftId: 'saved-draft', replyRouting })
  expect(mocks.update.mock.calls[0][0]).toMatchObject({ id: 'saved-draft', requestBody: { id: 'saved-draft', message: { threadId: replyRouting.threadId } } })
  await f.parent.mutation(api.mailSending.approve, { id, version: 6, input: updated })
  await f.t.action(internal.gmailSending.send, { id, version: 7 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'sent', version: 8, sentMessageId: 'sent-message', replyRouting })
  const message = mocks.send.mock.calls[0][0].requestBody.message
  expect(message.threadId).toBe(replyRouting.threadId)
  const mime = Buffer.from(message.raw, 'base64url').toString()
  expect(mime).toContain(`In-Reply-To: ${replyRouting.inReplyTo}\r\n`)
  expect(mime).toContain(`References: ${replyRouting.references.join('\r\n ')}\r\n`)
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.update).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(1)
})
it('does not let client approval or model output replace the hidden source routing', async () => {
  mocks.model.mockResolvedValue({ body: reply.body, replyRouting: { ...replyRouting, threadId: 'model-selected-thread' } })
  const f = await fixture(true, replyRouting), id = await f.review()
  expect((await f.t.run(ctx => ctx.db.get(id)))?.replyRouting).toEqual(replyRouting)
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply, replyRouting: { ...replyRouting, threadId: 'attacker-thread' } } as any)).rejects.toThrow()
  await expect(f.parent.mutation(api.mailDrafts.edit, { id, version: 2, input: { ...reply, subject: 'A different conversation' } })).rejects.toThrow('original reply subject')
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: { ...reply, subject: 'A different conversation' } })).rejects.toThrow('original reply subject')
  expect(mocks.create).not.toHaveBeenCalled()
})
it('blocks new writes if source routing changes, while reconciling an earlier dispatched save from its immutable snapshot', async () => {
  const f = await fixture(true, replyRouting), id = await f.review()
  mocks.get.mockRejectedValueOnce(new Error('Synthetic interrupted read-back'))
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  await f.t.run(ctx => ctx.db.patch(f.messageId, { replyRouting: { ...replyRouting, threadId: 'other-thread' } }))
  await f.parent.mutation(api.mailDrafts.reconcile, { id, version: 4 })
  await f.t.action(internal.gmailDrafts.reconcile, { id, version: 5 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'saved', version: 6, replyRouting })
  await expect(f.parent.mutation(api.mailSending.approve, { id, version: 6, input: reply })).rejects.toThrow('conversation changed')
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled()
})
it('blocks dispatch if a thread snapshot changes after exact approval', async () => {
  const f = await fixture(true, replyRouting), id = await f.review()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  const lease = { id, version: 3, lease: 'synthetic-thread-lease' }
  expect(await f.t.mutation(internal.mailDrafts.claimSave, { ...lease, readOnly: false })).toMatchObject({ replyRouting })
  await f.t.run(ctx => ctx.db.patch(id, { replyRouting: { ...replyRouting, threadId: 'other-thread' } }))
  expect(await f.t.mutation(internal.mailDrafts.dispatch, lease)).toBe(false)
  expect(mocks.create).not.toHaveBeenCalled()
})
it('recovers lost create and send IDs with rewritten Message-IDs from the original threaded proof without replaying writes', async () => {
  const f = await fixture(true, replyRouting), id = await f.review()
  const acceptedCreate = mocks.create.getMockImplementation()!, acceptedSend = mocks.send.getMockImplementation()!
  const rewritten = (args: any) => ({ ...args, requestBody: { ...args.requestBody, message: { ...args.requestBody.message, raw: Buffer.from(Buffer.from(args.requestBody.message.raw, 'base64url').toString().replace(/Message-ID: [^\r]+/, 'Message-ID: <rewritten@gmail.example>')).toString('base64url') } } })
  mocks.create.mockImplementation(async args => { await acceptedCreate(rewritten(args)); throw new Error('Synthetic timeout after draft acceptance') })
  mocks.list.mockResolvedValue({ data: { drafts: [{ id: 'saved-draft' }] } })
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'uncertain', version: 4 })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.gmailDraftId).toBeUndefined()
  await f.parent.mutation(api.mailDrafts.reconcile, { id, version: 4 })
  await f.t.action(internal.gmailDrafts.reconcile, { id, version: 5 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'saved', version: 6, gmailDraftId: 'saved-draft' })
  mocks.send.mockImplementation(async args => { await acceptedSend(rewritten(args)); throw new Error('Synthetic timeout after send acceptance') })
  mocks.threadGet.mockResolvedValue({ data: { id: replyRouting.threadId, messages: [{ id: 'synthetic-source', labelIds: ['INBOX'] }, { id: 'sent-message', labelIds: ['SENT'] }] } })
  await f.parent.mutation(api.mailSending.approve, { id, version: 6, input: reply })
  await f.t.action(internal.gmailSending.send, { id, version: 7 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'send_uncertain', version: 8 })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.sentMessageId).toBeUndefined()
  await f.parent.mutation(api.mailSending.reconcile, { id, version: 8 })
  await f.t.action(internal.gmailSending.reconcile, { id, version: 9 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'sent', version: 10, sentMessageId: 'sent-message', replyRouting })
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.update).not.toHaveBeenCalled()
})
it.each(['changed', 'deleted', 'dismissed', 'expired'] as const)('reconciles an already dispatched draft after its source is %s without another write', async change => {
  const f = await fixture(), id = await f.review()
  mocks.get.mockRejectedValueOnce(new Error('Synthetic interrupted read-back'))
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'uncertain', version: 4, gmailDraftId: 'saved-draft' })
  await f.t.run(async ctx => {
    if (change === 'changed') await ctx.db.patch(f.messageId, { version: 2, contentHash: sourceHash('Changed source') })
    if (change === 'deleted') await ctx.db.delete(f.messageId)
    if (change === 'dismissed') await ctx.db.patch(f.messageId, { dismissed: true })
    if (change === 'expired') await ctx.db.patch(f.messageId, { expiresAt: now })
  })
  await f.parent.mutation(api.mailDrafts.reconcile, { id, version: 4 })
  await f.t.action(internal.gmailDrafts.reconcile, { id, version: 5 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'saved', version: 6, gmailDraftId: 'saved-draft' })
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
  await expect(f.parent.mutation(api.mailSending.approve, { id, version: 6, input: reply })).rejects.toThrow('changed')
})
it.each(['changed', 'deleted', 'dismissed', 'expired'] as const)('verifies an accepted send after its source is %s without resending', async change => {
  const f = await fixture(), id = await f.saved(), send = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { await send(args); throw new Error('Synthetic timeout after acceptance') })
  await f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply })
  await f.t.action(internal.gmailSending.send, { id, version: 5 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'send_uncertain', version: 6 })
  await f.t.run(async ctx => {
    if (change === 'changed') await ctx.db.patch(f.messageId, { version: 2, contentHash: sourceHash('Changed source') })
    if (change === 'deleted') await ctx.db.delete(f.messageId)
    if (change === 'dismissed') await ctx.db.patch(f.messageId, { dismissed: true })
    if (change === 'expired') await ctx.db.patch(f.messageId, { expiresAt: now })
  })
  await f.parent.mutation(api.mailSending.reconcile, { id, version: 6 })
  await f.t.action(internal.gmailSending.reconcile, { id, version: 7 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'sent', version: 8, sentMessageId: 'sent-message' })
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1)
})
it.each(['draft', 'send'] as const)('finishes %s read-back when source context changes after dispatch', async kind => {
  const f = await fixture(), id = kind === 'draft' ? await f.review() : await f.saved()
  const write = kind === 'draft' ? mocks.create : mocks.send, original = write.getMockImplementation()!
  write.mockImplementation(async args => {
    const result = await original(args)
    await f.t.run(ctx => ctx.db.patch(f.messageId, { version: 2, contentHash: sourceHash('New source') }))
    return result
  })
  if (kind === 'draft') {
    await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
    await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  } else {
    await f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply })
    await f.t.action(internal.gmailSending.send, { id, version: 5 })
  }
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: kind === 'draft' ? 'saved' : 'sent' })
  expect(write).toHaveBeenCalledTimes(1)
})
it.each(['draft', 'send'] as const)('still blocks %s receipt reads after mailbox/account access changes', async kind => {
  for (const change of ['pause', 'removed', 'revoked', 'scope', 'account', 'member', 'household'] as const) {
    const f = await fixture(), id = kind === 'draft' ? await f.review() : await f.saved()
    if (kind === 'draft') {
      mocks.get.mockRejectedValueOnce(new Error('Synthetic read failure'))
      await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
      await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
    } else {
      mocks.sentGet.mockRejectedValueOnce(new Error('Synthetic read failure'))
      await f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply })
      await f.t.action(internal.gmailSending.send, { id, version: 5 })
    }
    await f.t.run(async ctx => {
      if (change === 'pause' || change === 'removed') await ctx.db.patch(f.mailboxId, { state: change === 'pause' ? 'paused' : 'removed' })
      if (change === 'revoked') await ctx.db.patch(f.connectionId, { status: 'revoked' })
      if (change === 'scope') await ctx.db.patch(f.connectionId, { scopes: [gmailReadScope] })
      if (change === 'account') await ctx.db.patch(f.connectionId, { email: 'different@example.test' })
      if (change === 'member') { const m = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(m!._id) }
      if (change === 'household') await ctx.db.patch(f.householdId, { deleted: true })
    })
    mocks.profile.mockClear(); mocks.get.mockClear(); mocks.sentGet.mockClear()
    await expect(kind === 'draft' ? f.parent.mutation(api.mailDrafts.reconcile, { id, version: 4 }) : f.parent.mutation(api.mailSending.reconcile, { id, version: 6 })).rejects.toThrow()
    expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.sentGet).not.toHaveBeenCalled()
  }
})
it('expires a queued Gmail draft approval before any provider request, with a fresh review required', async () => {
  const f = await fixture(), id = await f.review()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  vi.setSystemTime(now + 10 * 60_000)
  await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'failed', issue: expect.stringContaining('approval expired') })
  expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 3, input: reply })
  await f.t.action(internal.gmailDrafts.save, { id, version: 4 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'saved' })
  expect(mocks.create).toHaveBeenCalledTimes(1)
})
it('rechecks Gmail draft approval age immediately before dispatch', async () => {
  const f = await fixture(), id = await f.review()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  // Expire the approval while preserving the worker lease to isolate the approval guard.
  mocks.profile.mockImplementation(async () => {
    await f.t.run(ctx => ctx.db.patch(id, { approvedAt: now - 10 * 60_000 }))
    return { data: { emailAddress: 'parent@example.test' } }
  })
  await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect(mocks.create).not.toHaveBeenCalled()
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'failed' })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.dispatchedAt).toBeUndefined()
})
it('prepares privately without compose consent, shares no model context with other adults, and never writes before approval', async () => {
  const f = await fixture(false), id = await f.start()
  expect(await f.start()).toBe(id)
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'preparing', body: '', accountEmail: 'parent@example.test', connectionId: f.connectionId, connectionVersion: 1 })
  await f.t.action(internal.gmailDrafts.prepare, { id, version: 1 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'review', version: 2, ...reply })
  expect(await f.other.query(api.mailDrafts.list, {})).toEqual([]); expect(await f.outsider.query(api.mailDrafts.list, {})).toEqual([])
  await expect(f.other.mutation(api.mailDrafts.prepare, { messageId: f.messageId, version: 1, instruction: 'Peek' })).rejects.toThrow('unavailable')
  await expect(f.other.mutation(api.mailDrafts.edit, { id, version: 2, input: reply })).rejects.toThrow('unavailable')
  await expect(f.other.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })).rejects.toThrow('unavailable')
  await expect(f.other.mutation(api.mailDrafts.reconcile, { id, version: 2 })).rejects.toThrow('unavailable')
  await expect(f.t.query(api.mailDrafts.list, {})).rejects.toThrow('Sign in')
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })).rejects.toThrow('Allow saving')
  const context = mocks.model.mock.calls[0][2]
  expect(Object.keys(context).sort()).toEqual(['instruction', 'message', 'subject', 'to'])
  expect(JSON.stringify(context)).not.toMatch(/synthetic-unused|test\|parent|connectionId|accountKey/)
  expect(mocks.model.mock.calls[0][1]).toContain('untrusted reference material')
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it('edits locally, rejects stale approvals, journals before one create, and requires MIME read-back before saved', async () => {
  const f = await fixture(), id = await f.review(), edited = { ...reply, body: 'We will bring paper plates.' }
  expect(await f.parent.mutation(api.mailDrafts.edit, { id, version: 2, input: edited })).toBe(3)
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })).rejects.toThrow('changed')
  expect(await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 3, input: edited })).toBe(4)
  expect((await f.parent.query(api.mailDrafts.list, {}))[0].status).toBe('saving')
  const normalCreate = mocks.create.getMockImplementation()!
  mocks.create.mockImplementation(async args => {
    const d = await f.t.run(ctx => ctx.db.get(id))
    expect(d).toMatchObject({ status: 'saving', dispatchedAt: now, approvedHash: hash(JSON.stringify(edited)) })
    expect(d?.operationKey).toHaveLength(64)
    return normalCreate(args)
  })
  await f.t.action(internal.gmailDrafts.save, { id, version: 4 })
  await f.t.action(internal.gmailDrafts.save, { id, version: 4 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'saved', gmailDraftId: 'saved-draft', version: 5, body: edited.body })
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.get).toHaveBeenCalledTimes(1)
  expect(mocks.create.mock.calls[0][1]).toMatchObject({ retry: false, timeout: 10000 }); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
})
it.each(['source-version', 'content-hash', 'newer-thread', 'source-delete', 'source-expired', 'dismissed', 'pause', 'member', 'household', 'connection-version', 'connection-email', 'scope'] as const)('stops %s changes between approval and dispatch before provider access', async change => {
  const f = await fixture(), id = await f.review()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  await f.t.run(async ctx => {
    if (change === 'source-version') await ctx.db.patch(f.messageId, { version: 2 })
    if (change === 'content-hash') await ctx.db.patch(f.messageId, { contentHash: 'changed' })
    if (change === 'newer-thread') { const m = (await ctx.db.get(f.messageId))!; const { _id, _creationTime, ...data } = m; await ctx.db.insert('mailMessages', { ...data, providerId: 'new-message', receivedAt: now, text: 'Correction: do not bring plates.' }) }
    if (change === 'source-delete') await ctx.db.delete(f.messageId)
    if (change === 'source-expired') await ctx.db.patch(f.messageId, { expiresAt: now })
    if (change === 'dismissed') await ctx.db.patch(f.messageId, { dismissed: true })
    if (change === 'pause') await ctx.db.patch(f.mailboxId, { state: 'paused' })
    if (change === 'member') { const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(member!._id) }
    if (change === 'household') await ctx.db.patch(f.householdId, { deleted: true })
    if (change === 'connection-version') await ctx.db.patch(f.connectionId, { version: 2 })
    if (change === 'connection-email') await ctx.db.patch(f.connectionId, { email: 'replacement@example.test' })
    if (change === 'scope') await ctx.db.patch(f.connectionId, { scopes: [gmailReadScope] })
  })
  await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled()
  expect((await f.t.run(ctx => ctx.db.get(id)))?.status).toBe('failed')
})
it('discards late model output after source changes and never lets the model choose recipients', async () => {
  const f = await fixture(), id = await f.start()
  mocks.model.mockImplementation(async () => { await f.t.run(ctx => ctx.db.patch(f.messageId, { version: 2 })); return { body: 'Done', to: 'attacker@example.test' } })
  await f.t.action(internal.gmailDrafts.prepare, { id, version: 1 })
  const d = (await f.parent.query(api.mailDrafts.list, {}))[0]
  expect(d).toMatchObject({ status: 'failed', to: reply.to, body: '' }); expect(mocks.create).not.toHaveBeenCalled()
})
it('treats a missing create ID as uncertain and never replays a write on recovery or reconciliation', async () => {
  const f = await fixture(), id = await f.review()
  mocks.create.mockResolvedValue({ data: {} })
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply }); await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'uncertain', version: 4 })
  await expect(f.parent.mutation(api.mailDrafts.edit, { id, version: 4, input: reply })).rejects.toThrow('cannot be edited')
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id, version: 4, input: reply })).rejects.toThrow('already')
  expect(await f.parent.mutation(api.mailDrafts.reconcile, { id, version: 4 })).toBe(5)
  expect(await f.parent.mutation(api.mailDrafts.reconcile, { id, version: 5 })).toBe(5)
  await f.t.action(internal.gmailDrafts.reconcile, { id, version: 5 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'uncertain', version: 6 })
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.list).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled()
})
it('retains the provider ID after late revocation without claiming verification', async () => {
  const f = await fixture(), id = await f.review()
  mocks.create.mockImplementation(async () => { await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 })); return { data: { id: 'created-before-revoke' } } })
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply }); await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'uncertain', gmailDraftId: 'created-before-revoke' })
  expect(mocks.get).not.toHaveBeenCalled()
})
it('blocks swapped token accounts before the dispatch journal or create', async () => {
  const f = await fixture(), id = await f.review()
  mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply }); await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.dispatchedAt).toBeUndefined(); expect(mocks.create).not.toHaveBeenCalled()
})
it('recovers interrupted work conservatively while retaining a late result for the same operation', async () => {
  const f = await fixture(), id = await f.review()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  const lease = { id, version: 3, lease: 'synthetic-lease' }
  const current = await f.t.mutation(internal.mailDrafts.claimSave, { ...lease, readOnly: false })
  expect(await f.t.mutation(internal.mailDrafts.dispatch, lease)).toBe(true)
  expect(await f.t.mutation(internal.mailDrafts.dispatch, lease)).toBe(false)
  vi.setSystemTime(now + 200_000); await f.t.mutation(internal.mailDrafts.recover, { id, version: 3 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'uncertain', version: 4 })
  expect(await f.t.mutation(internal.mailDrafts.recordProviderId, { ...lease, operationKey: current!.operationKey, gmailDraftId: 'late-id' })).toBe(true)
  expect(await f.t.mutation(internal.mailDrafts.finished, { ...lease, operationKey: current!.operationKey, verified: true, gmailDraftId: 'late-id' })).toBe(true)
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'saved', gmailDraftId: 'late-id', version: 5 })
})
it('expires private drafts and never recreates them from a late provider result', async () => {
  const f = await fixture(), id = await f.review()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  const lease = { id, version: 3, lease: 'lease' }, current = await f.t.mutation(internal.mailDrafts.claimSave, { ...lease, readOnly: false })
  await f.t.mutation(internal.mailDrafts.dispatch, lease)
  vi.setSystemTime(now + 86400_000); expect(await f.parent.query(api.mailDrafts.list, {})).toEqual([])
  await f.t.mutation(internal.mailDrafts.purgeExpired, {})
  expect(await f.t.mutation(internal.mailDrafts.finished, { ...lease, operationKey: current!.operationKey, verified: true, gmailDraftId: 'late-id' })).toBe(false)
  expect(await f.t.run(ctx => ctx.db.get(id))).toBeNull()
})
it('hides removed mailbox drafts immediately even before source cleanup', async () => {
  const f = await fixture(), id = await f.review()
  await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 1 })
  expect(await f.parent.query(api.mailDrafts.list, {})).toEqual([])
  expect(await f.t.run(ctx => ctx.db.get(id))).not.toBeNull()
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })).rejects.toThrow('changed')
})
it('rechecks a correction arriving during account verification at the dispatch journal', async () => {
  const f = await fixture(), id = await f.review()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  mocks.profile.mockImplementation(async () => {
    await f.t.run(async ctx => { const m = (await ctx.db.get(f.messageId))!; const { _id, _creationTime, ...data } = m; await ctx.db.insert('mailMessages', { ...data, providerId: 'correction', receivedAt: now, text: 'The picnic is cancelled.' }) })
    return { data: { emailAddress: 'parent@example.test' } }
  })
  await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect(mocks.create).not.toHaveBeenCalled()
  expect((await f.t.run(ctx => ctx.db.get(id)))?.dispatchedAt).toBeUndefined()
})
it('lets a fresh consent-bound source prepare again without reusing an old-account-version draft', async () => {
  const f = await fixture(), oldId = await f.review()
  await f.t.run(async ctx => {
    await ctx.db.patch(f.connectionId, { version: 2 })
    await ctx.db.patch(f.mailboxId, { connectionVersion: 2 })
    await ctx.db.patch(f.messageId, { connectionVersion: 2 })
  })
  const freshId = await f.start()
  expect(freshId).not.toBe(oldId)
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id: oldId, version: 2, input: reply })).rejects.toThrow('changed')
})
it('refuses unsupported sender or model configuration before queuing private preparation', async () => {
  const f = await fixture()
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  await expect(f.start()).rejects.toThrow('model connection')
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic')
  await f.t.run(ctx => ctx.db.patch(f.messageId, { sender: '(Sender unavailable)' }))
  await expect(f.start()).rejects.toThrow('sender address')
  expect(await f.parent.query(api.mailDrafts.list, {})).toEqual([]); expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled()
})

it('edits an existing Gmail draft only after fresh approval, updates the same ID, and never creates or sends a second copy', async () => {
  const f = await fixture(), id = await f.saved(), input = { ...reply, body: 'Correction: we can bring cups instead.' }
  expect(await f.parent.mutation(api.mailDrafts.edit, { id, version: 4, input })).toBe(5)
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id, version: 4, input })).rejects.toThrow('changed')
  expect(mocks.update).not.toHaveBeenCalled()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 5, input })
  await f.t.action(internal.gmailDrafts.save, { id, version: 6 })
  await f.t.action(internal.gmailDrafts.save, { id, version: 6 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'saved', version: 7, gmailDraftId: 'saved-draft', body: input.body })
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.update).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled()
})

it('refuses replacing a draft that changed in Gmail before the approved update', async () => {
  const f = await fixture(), id = await f.saved()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 4, input: { ...reply, body: 'New approved text' } })
  mocks.get.mockResolvedValue({ data: { id: 'saved-draft', message: { id: 'saved-message', labelIds: ['DRAFT'], raw: Buffer.from('Unapproved Gmail edit').toString('base64url') } } })
  await f.t.action(internal.gmailDrafts.save, { id, version: 5 })
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.create).toHaveBeenCalledTimes(1)
  expect((await f.t.run(ctx => ctx.db.get(id)))?.dispatchedAt).toBeUndefined()
})

it('requires a separate exact private send approval and verifies the sent MIME without claiming recipient delivery', async () => {
  const f = await fixture(), id = await f.saved()
  expect(mocks.send).not.toHaveBeenCalled()
  for (const other of [f.other, f.outsider]) await expect(other.mutation(api.mailSending.approve, { id, version: 4, input: reply })).rejects.toThrow('unavailable')
  await expect(f.parent.mutation(api.mailSending.approve, { id, version: 4, input: { ...reply, body: 'Unverified changes' } })).rejects.toThrow('Save the current')
  expect(await f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply })).toBe(5)
  const send = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => {
    expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'sending', sendDispatchedAt: now, sendApprovedHash: hash(JSON.stringify(reply)) })
    return send(args)
  })
  await f.t.action(internal.gmailSending.send, { id, version: 5 })
  await f.t.action(internal.gmailSending.send, { id, version: 5 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'sent', version: 6, sentMessageId: 'sent-message', sendVerifiedAt: now })
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.sentGet).toHaveBeenCalledTimes(1)
  expect(mocks.send.mock.calls[0][0].requestBody).toMatchObject({ id: 'saved-draft', message: { raw: expect.any(String) } })
  expect(mocks.send.mock.calls[0][1]).toMatchObject({ retry: false, timeout: 10000 })
  expect(await f.other.query(api.mailDrafts.list, {})).toEqual([])
  await expect(f.parent.mutation(api.mailDrafts.edit, { id, version: 6, input: reply })).rejects.toThrow('cannot be edited')
  await expect(f.parent.mutation(api.mailSending.approve, { id, version: 6, input: reply })).rejects.toThrow('Save the current')
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})

it.each(['source', 'member', 'paused', 'connection', 'scope', 'recipient', 'approval-expiry', 'gmail-edit'] as const)('blocks %s changes before sending', async change => {
  const f = await fixture(), id = await f.saved()
  await f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply })
  await f.t.run(async ctx => {
    if (change === 'source') await ctx.db.patch(f.messageId, { version: 2 })
    if (change === 'member') { const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(member!._id) }
    if (change === 'paused') await ctx.db.patch(f.mailboxId, { state: 'paused' })
    if (change === 'connection') await ctx.db.patch(f.connectionId, { version: 2 })
    if (change === 'scope') await ctx.db.patch(f.connectionId, { scopes: [gmailReadScope] })
  })
  if (change === 'recipient') vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', '')
  if (change === 'approval-expiry') vi.setSystemTime(now + 600000)
  if (change === 'gmail-edit') mocks.get.mockResolvedValue({ data: { id: 'saved-draft', message: { id: 'saved-message', labelIds: ['DRAFT'], raw: 'unapproved' } } })
  await f.t.action(internal.gmailSending.send, { id, version: 5 })
  expect(mocks.send).not.toHaveBeenCalled()
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'send_failed' })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.sendDispatchedAt).toBeUndefined()
})

it('does not retry an ambiguous send, reconciles only the exact sent copy, and handles repeated recovery safely', async () => {
  const f = await fixture(), id = await f.saved(), send = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { await send(args); throw new Error('Synthetic timeout after provider accepted') })
  await f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply }); await f.t.action(internal.gmailSending.send, { id, version: 5 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'send_uncertain', version: 6 })
  await expect(f.parent.mutation(api.mailSending.reviewAgain, { id, version: 6 })).rejects.toThrow('cannot be repeated')
  expect(await f.parent.mutation(api.mailSending.reconcile, { id, version: 6 })).toBe(7)
  expect(await f.parent.mutation(api.mailSending.reconcile, { id, version: 7 })).toBe(7)
  await f.t.action(internal.gmailSending.reconcile, { id, version: 7 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'sent', version: 8, sentMessageId: 'sent-message' })
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.sentList).toHaveBeenCalledTimes(1)
})

it('keeps an accepted provider ID after revocation while reporting the send unconfirmed', async () => {
  const f = await fixture(), id = await f.saved(), send = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { const result = await send(args); await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 })); return result })
  await f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply }); await f.t.action(internal.gmailSending.send, { id, version: 5 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'send_uncertain', sentMessageId: 'sent-message' })
  expect(mocks.sentGet).not.toHaveBeenCalled(); expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('requires review again after an undispatched interruption and never mistakes a saved draft for a sent message', async () => {
  const f = await fixture(), id = await f.saved()
  await f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply })
  vi.setSystemTime(now + 200000); await f.t.mutation(internal.mailSending.recover, { id, version: 5 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'send_failed', version: 6 })
  await f.parent.mutation(api.mailSending.reviewAgain, { id, version: 6 })
  await f.parent.mutation(api.mailSending.approve, { id, version: 7, input: reply })
  const getter = mocks.sentGet.getMockImplementation()!
  mocks.sentGet.mockImplementation(async args => ({ data: { ...(await getter(args)).data, labelIds: ['DRAFT'] } }))
  await f.t.action(internal.gmailSending.send, { id, version: 8 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'send_uncertain' })
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('allows fresh review after a draft failure before dispatch, without replaying an attempted write', async () => {
  const f = await fixture(), id = await f.review()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 2, input: reply })
  mocks.profile.mockRejectedValueOnce(new Error('Synthetic network failure before write'))
  await f.t.action(internal.gmailDrafts.save, { id, version: 3 })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'failed', version: 4 })
  expect(mocks.create).not.toHaveBeenCalled()
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 4, input: reply })
  await f.t.action(internal.gmailDrafts.save, { id, version: 5 })
  expect((await f.parent.query(api.mailDrafts.list, {}))[0].status).toBe('saved')
  expect(mocks.create).toHaveBeenCalledTimes(1)
})

it('allows one send approval and one dispatch under fifty duplicate requests and worker replays', async () => {
  const f = await fixture(), id = await f.saved()
  const approvals = await Promise.allSettled(Array.from({ length: 50 }, () => f.parent.mutation(api.mailSending.approve, { id, version: 4, input: reply })))
  expect(approvals.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  await Promise.all(Array.from({ length: 50 }, () => f.t.action(internal.gmailSending.send, { id, version: 5 })))
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'sent', version: 6 })
  expect(await f.other.query(api.mailDrafts.list, {})).toEqual([])
})

it('updates one existing draft under fifty duplicate approvals and worker replays', async () => {
  const f = await fixture(), id = await f.saved(), input = { ...reply, body: 'We will bring cups.' }
  const approvals = await Promise.allSettled(Array.from({ length: 50 }, () => f.parent.mutation(api.mailDrafts.approveSave, { id, version: 4, input })))
  expect(approvals.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  await Promise.all(Array.from({ length: 50 }, () => f.t.action(internal.gmailDrafts.save, { id, version: 5 })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.update).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled()
  expect((await f.parent.query(api.mailDrafts.list, {}))[0]).toMatchObject({ status: 'saved', version: 6, gmailDraftId: 'saved-draft', body: input.body })
})


it('exposes server-owned reply routing as a display flag without exposing route headers', async () => {
  const f = await fixture(true, replyRouting), id = await f.review()
  const row = (await f.parent.query(api.mailDrafts.list, {})).find(d => d.id === id)
  expect(row?.replyInThread).toBe(true)
  expect(row).not.toHaveProperty('replyRouting')
  expect(row).not.toHaveProperty('inReplyTo')
})
it('does not label a legacy standalone reply as belonging to its source conversation', async () => {
  const f = await fixture(), id = await f.review()
  expect((await f.parent.query(api.mailDrafts.list, {})).find(d => d.id === id)?.replyInThread).toBeUndefined()
})


it('reports a known Gmail pre-image conflict without overwriting, dispatching or creating another draft', async () => {
  const f = await fixture(true, replyRouting), id = await f.saved()
  const read = mocks.get.getMockImplementation()!
  mocks.get.mockImplementation(async args => {
    const result = await read(args)
    const mime = Buffer.from(result.data.message.raw, 'base64url').toString().replace(/X-Daymark-Draft-Operation: [^\r]+/, 'X-Daymark-Draft-Operation: changed-by-client')
    return { data: { ...result.data, message: { ...result.data.message, raw: Buffer.from(mime).toString('base64url') } } }
  })
  await f.parent.mutation(api.mailDrafts.approveSave, { id, version: 4, input: { ...reply, body: 'Reviewed new reply.' } })
  await f.t.action(internal.gmailDrafts.save, { id, version: 5 })
  const result = await f.t.run(ctx => ctx.db.get(id))
  expect(result).toMatchObject({ status: 'failed', gmailDraftId: 'saved-draft' })
  expect(result?.dispatchedAt).toBeUndefined()
  expect(result?.issue).toContain('Nothing was overwritten or sent')
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})
