// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { hash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import { gmailComposeScope } from '../shared/mailbox'
import { draftMime, type Approved } from './gmailDrafts'
import * as pickupAdapter from './pickupGmailAdapter'
import { unseal } from './googleCrypto'

const mocks = vi.hoisted(() => ({ profile: vi.fn(), send: vi.fn(), get: vi.fn(), list: vi.fn(), withGoogle: vi.fn(), draftCreate: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { getProfile: mocks.profile, messages: { send: mocks.send, get: mocks.get, list: mocks.list }, drafts: { create: mocks.draftCreate } } }) }))
vi.mock('./google', () => ({ withGoogle: mocks.withGoogle }))
const modules = import.meta.glob('./**/*.ts')
const now = Date.parse('2027-05-05T08:00:00Z'), reminderAt = '2027-05-05T08:05:00Z'
let sent: Map<string, string>
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks()
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test')
  vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'alex@example.test'); vi.stubEnv('DAYMARK_WEB_URL', 'https://response.example.test')
  vi.stubEnv('PROVIDER_TOKEN_KEY_ID', 'synthetic'); vi.stubEnv('PROVIDER_TOKEN_KEYS', JSON.stringify({ synthetic: randomBytes(32).toString('base64') }))
  vi.stubEnv('RESEND_API_KEY', ''); vi.stubEnv('DAYMARK_EMAIL_FROM', '')
  mocks.withGoogle.mockImplementation(async (_ctx, _approval, callback) => callback({}))
  mocks.profile.mockResolvedValue({ data: { emailAddress: 'parent@example.test' } })
  sent = new Map()
  mocks.send.mockImplementation(async args => { const id = `sent-${sent.size + 1}`; sent.set(id, args.requestBody.raw); return { data: { id } } })
  mocks.get.mockImplementation(async ({ id }) => ({ data: { id, labelIds: ['SENT'], raw: sent.get(id) } }))
  mocks.list.mockImplementation(async () => ({ data: { messages: [...sent.keys()].map(id => ({ id })) } }))
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

async function fixture(reminder = false) {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent', email: 'parent@example.test', emailVerified: true })
  const caregiver = t.withIdentity({ subject: 'caregiver', tokenIdentifier: 'test|caregiver', email: 'alex@example.test', emailVerified: true })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const caregiverId = await parent.mutation(api.pickups.addCaregiver, { name: 'Alex', email: 'alex@example.test', childIds: ['maya'] })
  const ids = await t.run(async ctx => {
    const connectionId = await ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', email: 'parent@example.test', status: 'active', version: 1, cipher: 'synthetic-token-not-used', scopes: [gmailComposeScope, gmailReadScope] })
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic pickup request', hash: 'synthetic-source', revision: 1, expiresAt: now + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, clarification: '' })
    const payload = { kind: 'pickup' as const, childId: 'maya', caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you pick up Maya?', evidence: {}, ...(reminder ? { followUpAt: reminderAt } : {}) }
    const actionId = await ctx.db.insert('actions', { householdId, jobId, sourceRevision: 1, revision: 1, status: 'review', payload })
    return { connectionId, sourceId, jobId, actionId, payload }
  })
  await parent.mutation(api.connections.choose, { purpose: 'email', id: ids.connectionId, version: 0 })
  const review = await parent.query(api.pickupMail.review, { actionId: ids.actionId, revision: 1, payload: ids.payload })
  const approve = async () => {
    await parent.mutation(api.jobs.approve, { actions: [{ id: ids.actionId, revision: 1, selectionVersion: 1, deliveryChannel: 'email', pickupEmailHash: review.hash }] })
    const action = (await t.run(ctx => ctx.db.get(ids.actionId)))!
    return (await t.run(ctx => ctx.db.get(action.approvalId!)))!
  }
  const claim = async () => {
    const approval = await approve()
    const claimed = await t.mutation(internal.execution.claim, { actionId: ids.actionId, approvalId: approval._id })
    expect(claimed).not.toBeNull()
    return { ...claimed!, approval }
  }
  const state = () => t.run(async ctx => ({ action: await ctx.db.get(ids.actionId), requests: await ctx.db.query('pickupRequests').collect(), attempts: await ctx.db.query('attempts').collect(), receipts: await ctx.db.query('receipts').collect() }))
  const send = async () => { const claimed = await claim(); await t.action(internal.pickupMailWorker.send, { actionId: ids.actionId, attemptId: claimed.attemptId }); return claimed }
  return { t, parent, caregiver, householdId, caregiverId, ...ids, review, approve, claim, state, send }
}
const contents = (raw: string) => {
  const mime = Buffer.from(raw, 'base64url').toString('utf8'), body = Buffer.from(mime.slice(mime.indexOf('\r\n\r\n') + 4).replace(/\s/g, ''), 'base64').toString('utf8')
  return { mime, body, secret: body.match(/#pickup=([a-f0-9]{64})/)![1] }
}
const material = (request: { _id: string; mailCipher?: string }) => unseal<{ invitation: Approved; reminder?: Approved }>(request.mailCipher!, `pickup-mail:${request._id}`)

it('reviews, approves, journals and verifies one exact invitation before waiting, then accepts an independently signed-in caregiver without a household', async () => {
  const f = await fixture()
  expect(f.review).toMatchObject({ channel: 'email', transport: 'gmail', from: 'parent@example.test', to: 'alex@example.test', subject: 'A pickup request' })
  expect(f.review.body).toContain('#pickup=[private link]')
  const originalSend = mocks.send.getMockImplementation()!, originalGet = mocks.get.getMockImplementation()!
  mocks.send.mockImplementation(async args => {
    const s = await f.state(), r = s.requests[0]
    expect(s.action?.status).toBe('executing'); expect(s.attempts).toHaveLength(1); expect(s.attempts[0].dispatched).toBe(true)
    expect(r.status).toBe('prepared'); expect(r.mailMessageId).toBeUndefined(); expect(s.receipts).toEqual([])
    expect(r.mailCipher).toBeTruthy()
    expect(args.requestBody.raw).toBe(Buffer.from(draftMime(material(r).invitation)).toString('base64url'))
    return originalSend(args)
  })
  mocks.get.mockImplementation(async args => {
    const s = await f.state()
    expect(s.requests[0].mailMessageId).toBe(args.id); expect(s.action?.status).toBe('executing'); expect(s.receipts).toEqual([])
    return originalGet(args)
  })
  const claimed = await f.send(), s = await f.state(), r = s.requests[0], saved = material(r), delivered = contents(sent.get('sent-1')!)
  expect(claimed.approval).toMatchObject({ toolName: 'caregiver.gmail.request', connectionId: f.connectionId, connectionVersion: 1, selectionVersion: 1, emailTransport: 'gmail', verificationMethod: 'identity', pickupEmail: { body: f.review.body, subject: f.review.subject } })
  expect(hash(JSON.stringify([claimed.approval.pickupEmail!.hash, f.connectionId, 1, 1]))).toBe(f.review.hash)
  expect(s.action?.status).toBe('waiting'); expect(s.attempts[0]).toMatchObject({ dispatched: true, finished: true })
  expect(r).toMatchObject({ status: 'waiting', mailMessageId: 'sent-1', mailVerifiedAt: now, mailOperationKey: saved.invitation.operationKey, mailApprovedHash: saved.invitation.approvedHash, tokenHash: hash(delivered.secret) })
  expect(s.receipts).toHaveLength(1); expect(s.receipts[0]).toMatchObject({ outcome: 'request_email_accepted', providerId: 'sent-1', revision: 1 })
  expect(delivered.body.replace(delivered.secret, '[private link]')).toBe(f.review.body!.replace(/\n/g, '\r\n'))
  expect(delivered.mime).toContain(`X-Daymark-Draft-Operation: ${saved.invitation.operationKey}`)
  expect(r.mailCipher).not.toContain(delivered.secret)
  for (const visible of [await f.parent.query(api.jobs.list, {}), await f.parent.query(api.pickups.arrangements, {}), await f.parent.query(api.pickupMail.review, { actionId: f.actionId, revision: 1, payload: f.payload })]) {
    expect(JSON.stringify(visible)).not.toContain(delivered.secret); expect(JSON.stringify(visible)).not.toContain(r.mailCipher)
  }
  expect(await f.t.query(api.pickupIdentity.view, { secret: delivered.secret })).toBeNull()
  expect(await f.parent.query(api.pickupIdentity.view, { secret: delivered.secret })).toBeNull()
  expect(await f.caregiver.query(api.pickupIdentity.view, { secret: delivered.secret })).toMatchObject({ child: 'Maya', location: 'North gate' })
  expect(await f.t.run(ctx => ctx.db.query('memberships').collect())).toHaveLength(1)
  await f.caregiver.mutation(api.pickupIdentity.respond, { secret: delivered.secret, response: 'accept', suggestion: '' })
  const accepted = await f.state()
  expect(accepted.action?.status).toBe('succeeded')
  expect(accepted.requests[0]).toMatchObject({ status: 'accepted', responderSubject: 'test|caregiver', responderEmail: 'alex@example.test', identityVerifiedAt: now })
  expect(accepted.receipts.map(r => r.outcome)).toEqual(['request_email_accepted', 'caregiver_accepted_not_pickup_completed'])
  await f.t.action(internal.pickupMailWorker.send, { actionId: f.actionId, attemptId: claimed.attemptId })
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.draftCreate).not.toHaveBeenCalled()
})

it.each(['missing review hash', 'wrong review hash', 'selection', 'reviewed body', 'reminder timing'] as const)('requires current exact review for %s before creating approval or sending', async change => {
  const f = await fixture(true)
  if (change === 'reviewed body' || change === 'reminder timing') await f.t.run(ctx => ctx.db.patch(f.actionId, { payload: { ...f.payload, ...(change === 'reviewed body' ? { message: 'A changed request' } : { followUpAt: '2027-05-05T08:06:00Z' }) } }))
  await expect(f.parent.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1, selectionVersion: change === 'selection' ? 0 : 1, deliveryChannel: 'email', ...(change === 'missing review hash' ? {} : { pickupEmailHash: change === 'wrong review hash' ? hash('other') : f.review.hash }) }] })).rejects.toThrow()
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['source', 'account', 'selection', 'body', 'reminder', 'canonical body', 'canonical reminder', 'child name', 'origin', 'send permission', 'read permission', 'revoked connection', 'recipient allowlist'] as const)('stops %s changes after preparation but before dispatch', async change => {
  const f = await fixture(true), claimed = await f.claim()
  mocks.withGoogle.mockImplementation(async (_ctx, _approval, callback) => {
    await f.t.run(async ctx => {
      if (change === 'source') await ctx.db.patch(f.sourceId, { revision: 2 })
      if (change === 'account') await ctx.db.patch(f.connectionId, { email: 'other@example.test' })
      if (change === 'selection') { const preference = (await ctx.db.query('connectionPreferences').first())!; await ctx.db.patch(preference._id, { version: 2, emailConnectionId: undefined }) }
      if (change === 'body' || change === 'reminder') await ctx.db.patch(f.actionId, { payload: { ...f.payload, ...(change === 'body' ? { message: 'Changed request body' } : { followUpAt: '2027-05-05T08:06:00Z' }) } })
      if (change === 'canonical body' || change === 'canonical reminder') {
        const proof = claimed.approval.pickupEmail!
        await ctx.db.patch(claimed.approval._id, { pickupEmail: { ...proof, ...(change === 'canonical body' ? { body: 'Changed canonical invitation' } : { reminder: { ...proof.reminder!, body: 'Changed canonical reminder' } }) } })
      }
      if (change === 'child name') await ctx.db.patch(f.householdId, { children: [{ id: 'maya', name: 'Sam' }] })
      if (change === 'send permission') await ctx.db.patch(f.connectionId, { scopes: [gmailReadScope] })
      if (change === 'read permission') await ctx.db.patch(f.connectionId, { scopes: [gmailComposeScope] })
      if (change === 'revoked connection') await ctx.db.patch(f.connectionId, { status: 'revoked' })
    })
    if (change === 'origin') vi.stubEnv('DAYMARK_WEB_URL', 'https://other-response.example.test')
    if (change === 'recipient allowlist') vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', '')
    return callback({})
  })
  await f.t.action(internal.pickupMailWorker.send, { actionId: f.actionId, attemptId: claimed.attemptId })
  const s = await f.state()
  expect(s.attempts[0]).toMatchObject({ dispatched: false, finished: true }); expect(s.receipts).toEqual([])
  expect(s.requests[0].mailCipher).toBeTruthy(); expect(s.requests[0].mailMessageId).toBeUndefined()
  expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled()
})

it('rechecks revocation after the account profile read and before dispatch', async () => {
  const f = await fixture()
  mocks.profile.mockImplementation(async () => { await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked' })); return { data: { emailAddress: 'parent@example.test' } } })
  await f.send()
  const s = await f.state()
  expect(s.attempts[0].dispatched).toBe(false); expect(s.receipts).toEqual([]); expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['wrong recipient', 'wrong body', 'wrong marker', 'DRAFT label'] as const)('keeps provider acceptance uncertain when SENT read-back has %s', async change => {
  const f = await fixture()
  mocks.get.mockImplementation(async ({ id }) => {
    let mime = Buffer.from(sent.get(id)!, 'base64url').toString()
    if (change === 'wrong recipient') mime = mime.replace('To: alex@example.test', 'To: other@example.test')
    if (change === 'wrong body') mime = mime.slice(0, mime.indexOf('\r\n\r\n') + 4) + Buffer.from('Changed body').toString('base64')
    if (change === 'wrong marker') mime = mime.replace(/X-Daymark-Draft-Operation: [^\r]+/, `X-Daymark-Draft-Operation: ${hash('other')}`)
    return { data: { id, raw: Buffer.from(mime).toString('base64url'), labelIds: change === 'DRAFT label' ? ['SENT', 'DRAFT'] : ['SENT'] } }
  })
  await f.send()
  const s = await f.state()
  expect(s.action?.status).toBe('uncertain'); expect(s.requests[0].mailMessageId).toBe('sent-1'); expect(s.requests[0].mailVerifiedAt).toBeUndefined()
  expect(s.receipts).toEqual([]); expect(s.attempts[0]).toMatchObject({ dispatched: true, finished: true }); expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('recovers a lost provider ID after timeout through the public recheck using immutable encrypted material and no second send', async () => {
  const f = await fixture(), acceptedSend = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { const result = await acceptedSend(args); const id = result.data.id; sent.set(id, Buffer.from(Buffer.from(sent.get(id)!, 'base64url').toString().replace(/Message-ID: [^\r]+/, 'Message-ID: <provider-rewritten@mail.gmail.com>')).toString('base64url')); throw new Error('Synthetic timeout after acceptance') })
  const claimed = await f.send(), before = await f.state(), request = before.requests[0]
  expect(before.action?.status).toBe('uncertain'); expect(request.mailMessageId).toBeUndefined(); expect(before.receipts).toEqual([])
  const encrypted = request.mailCipher, operation = request.mailOperationKey
  await f.t.run(ctx => ctx.db.patch(f.sourceId, { revision: 2 }))
  await f.parent.mutation(api.jobs.reconcile, { actionId: f.actionId })
  expect((await f.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())).some(fn => fn.name === 'pickupMailWorker:reconcile')).toBe(true)
  await f.t.action(internal.pickupMailWorker.reconcile, { requestId: request._id, reminder: false })
  const recovered = await f.state()
  expect(recovered.action?.status).toBe('waiting'); expect(recovered.requests[0]).toMatchObject({ status: 'waiting', mailMessageId: 'sent-1', mailVerifiedAt: now, mailCipher: encrypted, mailOperationKey: operation })
  expect(recovered.receipts).toHaveLength(1); expect(recovered.receipts[0]).toMatchObject({ outcome: 'request_email_accepted', providerId: 'sent-1', revision: 1 })
  await expect(f.parent.mutation(api.jobs.reconcile, { actionId: f.actionId })).rejects.toThrow('no unconfirmed')
  await f.t.action(internal.pickupMailWorker.reconcile, { requestId: request._id, reminder: false })
  await f.t.action(internal.pickupMailWorker.send, { actionId: f.actionId, attemptId: claimed.attemptId })
  expect((await f.state()).receipts).toHaveLength(1); expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'in:sent', maxResults: 10 }), expect.objectContaining({ retry: false }))
})

it('retains immutable provider evidence when the caregiver declines while the send is in flight', async () => {
  const f = await fixture(), acceptedSend = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => {
    const result = await acceptedSend(args), secret = contents(args.requestBody.raw).secret
    await f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'decline', suggestion: '' })
    expect((await f.state()).action).toMatchObject({ status: 'review', revision: 2 })
    return result
  })
  await f.send()
  const s = await f.state()
  expect(s.action).toMatchObject({ status: 'review', revision: 2 }); expect(s.action?.approvalId).toBeUndefined()
  expect(s.requests[0]).toMatchObject({ status: 'declined', responderSubject: 'test|caregiver', mailMessageId: 'sent-1', mailVerifiedAt: now })
  expect(s.attempts[0]).toMatchObject({ dispatched: true, finished: true })
  expect(s.receipts).toHaveLength(1); expect(s.receipts[0]).toMatchObject({ revision: 1, outcome: 'request_email_accepted', providerId: 'sent-1' })
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('keeps a lost-ID send uncertain when recovery finds two exact copies, without sending again', async () => {
  const f = await fixture(), acceptedSend = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { await acceptedSend(args); throw new Error('Synthetic timeout after acceptance') })
  await f.send()
  const request = (await f.state()).requests[0]
  sent.set('duplicate-copy', sent.get('sent-1')!)
  await f.parent.mutation(api.jobs.reconcile, { actionId: f.actionId })
  await f.t.action(internal.pickupMailWorker.reconcile, { requestId: request._id, reminder: false })
  const s = await f.state()
  expect(s.action?.status).toBe('uncertain'); expect(s.requests[0].mailVerifiedAt).toBeUndefined(); expect(s.receipts).toEqual([])
  expect(mocks.get).toHaveBeenCalledTimes(2); expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('sends only the one explicitly approved reminder at its scheduled time from the original encrypted template', async () => {
  const f = await fixture(true)
  await f.send()
  const before = await f.state(), r = before.requests[0], encrypted = r.mailCipher, saved = material(r)
  expect(r.followUpStatus).toBe('scheduled'); expect(saved.reminder).toBeTruthy()
  expect(await f.t.mutation(internal.pickupMail.claimReminder, { requestId: r._id, lease: 'too-early' })).toBeNull()
  await f.t.action(internal.pickupMailWorker.remind, { requestId: r._id })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.parse(reminderAt))
  const acceptedSend = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => {
    const current = (await f.state()).requests[0]
    expect(current).toMatchObject({ followUpStatus: 'dispatched', followUpDispatchedAt: Date.parse(reminderAt) })
    expect(args.requestBody.raw).toBe(Buffer.from(draftMime(saved.reminder!)).toString('base64url'))
    return acceptedSend(args)
  })
  await f.t.action(internal.pickupMailWorker.remind, { requestId: r._id })
  const after = await f.state(), reminder = contents(sent.get('sent-2')!), invitation = contents(sent.get('sent-1')!)
  expect(after.action?.status).toBe('waiting'); expect(after.requests[0]).toMatchObject({ followUpStatus: 'accepted', followUpProviderId: 'sent-2', mailCipher: encrypted })
  expect(reminder.secret).toBe(invitation.secret)
  expect(reminder.body.replace(reminder.secret, '[private link]')).toBe(f.review.reminder!.body.replace(/\n/g, '\r\n'))
  await f.t.action(internal.pickupMailWorker.remind, { requestId: r._id })
  expect(mocks.send).toHaveBeenCalledTimes(2); expect(after.receipts).toHaveLength(1)
})

it('reconciles a lost reminder ID using only reads, without replay or changing the invitation receipt', async () => {
  const f = await fixture(true)
  await f.send()
  const request = (await f.state()).requests[0], acceptedSend = mocks.send.getMockImplementation()!
  vi.setSystemTime(Date.parse(reminderAt))
  mocks.send.mockImplementation(async args => { await acceptedSend(args); throw new Error('Synthetic lost reminder response') })
  await f.t.action(internal.pickupMailWorker.remind, { requestId: request._id })
  expect((await f.state()).requests[0]).toMatchObject({ followUpStatus: 'uncertain' })
  expect((await f.state()).requests[0].followUpProviderId).toBeUndefined()
  await f.parent.mutation(api.jobs.reconcile, { actionId: f.actionId })
  await f.t.action(internal.pickupMailWorker.reconcile, { requestId: request._id, reminder: true })
  const recovered = await f.state()
  expect(recovered.requests[0]).toMatchObject({ followUpStatus: 'accepted', followUpProviderId: 'sent-2', mailMessageId: 'sent-1' })
  expect(recovered.action?.status).toBe('waiting'); expect(recovered.receipts).toHaveLength(1)
  await f.t.action(internal.pickupMailWorker.remind, { requestId: request._id })
  expect(mocks.send).toHaveBeenCalledTimes(2)
})

it.each(['no reminder approved', 'declined', 'connection revoked', 'source changed', 'sending selection changed'] as const)('does not send a reminder for %s', async change => {
  const f = await fixture(change !== 'no reminder approved')
  await f.send()
  const request = (await f.state()).requests[0]
  if (change === 'declined') await f.caregiver.mutation(api.pickupIdentity.respond, { secret: contents(sent.get('sent-1')!).secret, response: 'decline', suggestion: '' })
  if (change === 'connection revoked') await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked' }))
  if (change === 'source changed') await f.t.run(ctx => ctx.db.patch(f.sourceId, { revision: 2 }))
  if (change === 'sending selection changed') await f.t.run(async ctx => { const p = (await ctx.db.query('connectionPreferences').first())!; await ctx.db.patch(p._id, { version: 2 }) })
  vi.setSystemTime(Date.parse(reminderAt))
  await f.t.action(internal.pickupMailWorker.remind, { requestId: request._id })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect((await f.state()).requests[0].followUpDispatchedAt).toBeUndefined()
})

it('retains a returned ID after send-time revocation and refuses provider recovery with the revoked account', async () => {
  const f = await fixture(), acceptedSend = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { const result = await acceptedSend(args); await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked' })); return result })
  await f.send()
  const s = await f.state()
  expect(s.action?.status).toBe('uncertain'); expect(s.requests[0].mailMessageId).toBe('sent-1'); expect(s.receipts).toEqual([])
  expect(mocks.get).not.toHaveBeenCalled()
  await f.parent.mutation(api.jobs.reconcile, { actionId: f.actionId })
  await f.t.action(internal.pickupMailWorker.reconcile, { requestId: s.requests[0]._id, reminder: false })
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled()
})

it('cannot replay a cancelled reminder after its sending permission returns', async () => {
  const f = await fixture(true)
  await f.send()
  const request = (await f.state()).requests[0]
  vi.setSystemTime(Date.parse(reminderAt))
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked' }))
  await f.t.action(internal.pickupMailWorker.remind, { requestId: request._id })
  expect((await f.state()).requests[0].followUpStatus).toBe('cancelled')
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'active' }))
  await f.t.action(internal.pickupMailWorker.remind, { requestId: request._id })
  expect((await f.state()).requests[0].followUpDispatchedAt).toBeUndefined()
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('stale invitation and reminder recovery timers cannot clear a later expired reminder or reconciliation lease', async () => {
  const f = await fixture(true)
  await f.send()
  const request = (await f.state()).requests[0]
  const timers = await f.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())
  const invitationTimer = timers.find(fn => fn.name === 'pickupMail:recover')!
  const invitationArgs = invitationTimer.args[0] as { requestId: typeof request._id; reminder: boolean; lease: string }
  vi.setSystemTime(Date.parse(reminderAt))
  expect(await f.t.mutation(internal.pickupMail.claimReminder, { requestId: request._id, lease: 'reminder-lease' })).not.toBeNull()
  expect(await f.t.mutation(internal.pickupMail.dispatchReminder, { requestId: request._id, reminder: true, lease: 'reminder-lease' })).toBe(true)
  vi.setSystemTime(Date.parse(reminderAt) + 120001)
  await f.t.mutation(internal.pickupMail.recover, invitationArgs)
  expect((await f.state()).requests[0]).toMatchObject({ mailLease: 'reminder-lease', followUpStatus: 'dispatched' })
  const reminderArgs = { requestId: request._id, reminder: true, lease: 'reminder-lease' }
  await f.t.mutation(internal.pickupMail.recover, reminderArgs)
  expect((await f.state()).requests[0].followUpStatus).toBe('uncertain')
  expect(await f.t.mutation(internal.pickupMail.claimRead, { requestId: request._id, reminder: true, lease: 'reconcile-lease' })).not.toBeNull()
  vi.setSystemTime(Date.parse(reminderAt) + 240002)
  await f.t.mutation(internal.pickupMail.recover, reminderArgs)
  expect((await f.state()).requests[0]).toMatchObject({ mailLease: 'reconcile-lease', followUpStatus: 'uncertain' })
  await f.t.action(internal.pickupMailWorker.remind, { requestId: request._id })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect((await f.state()).receipts).toHaveLength(1)
})

it('keeps an owned historical email recheck after source and action corrections clear the current approval, without restoring old action state', async () => {
  const f = await fixture(), acceptedSend = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { await acceptedSend(args); throw new Error('Synthetic lost invitation response') })
  await f.send()
  const original = await f.state(), request = original.requests[0]
  expect(original.action?.status).toBe('uncertain'); expect(request.mailMessageId).toBeUndefined()
  // Model the corrected proposal transaction while retaining the dispatched
  // request and its original attempt/approval as immutable historical evidence.
  const changedPayload = { ...f.payload, time: '16:00', location: 'South gate', message: 'Please review the corrected pickup.' }
  await f.t.run(async ctx => {
    await ctx.db.patch(f.sourceId, { revision: 2, text: 'Corrected synthetic source', hash: 'corrected-source' })
    await ctx.db.patch(f.actionId, { status: 'review', revision: 2, sourceRevision: 2, approvalId: undefined, payload: changedPayload, error: 'Review the corrected pickup.' })
    await ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other-parent', role: 'adult' })
  })
  const otherParent = f.t.withIdentity({ subject: 'other-parent', tokenIdentifier: 'test|other-parent' })
  const ownerView = await f.parent.query(api.jobs.list, {}), otherView = await otherParent.query(api.jobs.list, {})
  expect(ownerView.find(job => job._id === f.jobId)!.actions.find(action => action._id === f.actionId)!.pickupEmail).toBe(true)
  expect(otherView.find(job => job._id === f.jobId)!.actions.find(action => action._id === f.actionId)!.pickupEmail).toBe(false)
  await expect(otherParent.mutation(api.jobs.reconcile, { actionId: f.actionId })).rejects.toThrow('this account')
  await f.parent.mutation(api.jobs.reconcile, { actionId: f.actionId })
  const timers = await f.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())
  expect(timers.some(fn => fn.name === 'pickupMailWorker:reconcile' && fn.args[0].requestId === request._id && fn.args[0].reminder === false)).toBe(true)
  await f.t.action(internal.pickupMailWorker.reconcile, { requestId: request._id, reminder: false })
  const recovered = await f.state()
  expect(recovered.action).toMatchObject({ status: 'review', revision: 2, sourceRevision: 2, payload: changedPayload, error: 'Review the corrected pickup.' })
  expect(recovered.action?.approvalId).toBeUndefined()
  expect(recovered.requests[0]).toMatchObject({ mailMessageId: 'sent-1', mailVerifiedAt: now, mailCipher: request.mailCipher, mailOperationKey: request.mailOperationKey })
  expect(recovered.receipts).toHaveLength(1); expect(recovered.receipts[0]).toMatchObject({ outcome: 'request_email_accepted', providerId: 'sent-1', revision: 1 })
  const secret = contents(sent.get('sent-1')!).secret
  expect(await f.caregiver.query(api.pickupIdentity.view, { secret })).toBeNull()
  expect((await f.parent.query(api.jobs.list, {})).find(job => job._id === f.jobId)!.actions.find(action => action._id === f.actionId)!.pickupEmail).toBe(false)
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it.each(['uncertain', 'reset to review'] as const)('blocks a new same-pickup request from the original dispatched snapshot when the earlier action is %s', async originalState => {
  const f = await fixture(), acceptedSend = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { await acceptedSend(args); throw new Error('Synthetic lost invitation response') })
  await f.send()
  if (originalState === 'reset to review') await f.t.run(ctx => ctx.db.patch(f.actionId, { status: 'review', revision: 2, approvalId: undefined, payload: { ...f.payload, time: '18:00', location: 'Corrected location' } }))
  const alternateCaregiver = await f.parent.mutation(api.pickups.addCaregiver, { name: 'Jordan', email: 'jordan@example.test', childIds: ['maya'] })
  vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'alex@example.test,jordan@example.test')
  const payload = { ...f.payload, caregiverId: alternateCaregiver, message: 'Could Jordan handle the original pickup?' }
  const newAction = await f.t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId: f.householdId, text: 'Another synthetic pickup request', hash: 'other-source', revision: 1, expiresAt: now + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId: f.householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, clarification: '' })
    return ctx.db.insert('actions', { householdId: f.householdId, jobId, sourceRevision: 1, revision: 1, status: 'review', payload })
  })
  const reviewed = await f.parent.query(api.pickupMail.review, { actionId: newAction, revision: 1, payload })
  await expect(f.parent.mutation(api.jobs.approve, { actions: [{ id: newAction, revision: 1, selectionVersion: 1, deliveryChannel: 'email', pickupEmailHash: reviewed.hash }] })).rejects.toThrow('earlier request email for this pickup is unconfirmed')
  expect(await f.t.run(ctx => ctx.db.get(newAction))).toMatchObject({ status: 'review', revision: 1 })
  expect((await f.t.run(ctx => ctx.db.get(newAction)))?.approvalId).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toHaveLength(1)
  const s = await f.state()
  expect(s.requests).toHaveLength(1); expect(s.requests[0].mailVerifiedAt).toBeUndefined(); expect(s.receipts).toEqual([])
  expect(mocks.send).toHaveBeenCalledTimes(1)
})


it.each(['scheduled', 'preparing', 'interrupted preparation'] as const)('cancels an unsent %s reminder after an independently verified caregiver response', async phase => {
  const f = await fixture(true)
  await f.send()
  const request = (await f.state()).requests[0], secret = contents(sent.get('sent-1')!).secret
  vi.setSystemTime(Date.parse(reminderAt))
  if (phase !== 'scheduled') expect(await f.t.mutation(internal.pickupMail.claimReminder, { requestId: request._id, lease: 'response-race' })).not.toBeNull()
  await f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'accept', suggestion: '' })
  if (phase === 'preparing') {
    expect(await f.t.mutation(internal.pickupMail.dispatchReminder, { requestId: request._id, reminder: true, lease: 'response-race' })).toBe(false)
    await f.t.mutation(internal.pickupMail.finished, { requestId: request._id, reminder: true, lease: 'response-race', verified: false })
  }
  if (phase === 'interrupted preparation') {
    vi.setSystemTime(Date.parse(reminderAt) + 120001)
    await f.t.mutation(internal.pickupMail.recover, { requestId: request._id, reminder: true, lease: 'response-race' })
  }
  await f.t.action(internal.pickupMailWorker.remind, { requestId: request._id })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  const state = await f.state()
  expect(state.action?.status).toBe('succeeded')
  expect(state.requests[0]).toMatchObject({ status: 'accepted', followUpStatus: 'cancelled' })
  expect(state.requests[0].followUpDispatchedAt).toBeUndefined()
  expect(state.receipts.map(r => r.outcome)).toEqual(['request_email_accepted', 'caregiver_accepted_not_pickup_completed'])
})


it.each(['invitation cancellation', 'invitation revision', 'reminder acceptance', 'reminder cancellation', 'reminder expiry'] as const)('rechecks write eligibility after the awaited dispatch journal for %s without authorizing a replay', async race => {
  const reminder = race.startsWith('reminder'), f = await fixture(reminder)
  if (reminder) { await f.send(); vi.setSystemTime(Date.parse(reminderAt)) }
  const send = pickupAdapter.sendPickupEmail
  let entered!: () => void, release!: () => void
  const journaled = new Promise<void>(resolve => { entered = resolve }), continueDispatch = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(pickupAdapter, 'sendPickupEmail').mockImplementation((auth, proof, controls) => send(auth, proof, {
    ...controls,
    dispatch: async () => { const allowed = await controls.dispatch(); expect(allowed).toBe(true); entered(); await continueDispatch; return allowed },
  }))
  const requestBefore = (await f.state()).requests[0]
  const pending = reminder ? f.t.action(internal.pickupMailWorker.remind, { requestId: requestBefore._id }) : f.send()
  await journaled
  if (race.endsWith('cancellation')) await f.parent.mutation(api.jobs.cancel, { jobId: f.jobId })
  if (race === 'invitation revision') await f.t.run(ctx => ctx.db.patch(f.actionId, { revision: 2, status: 'review', approvalId: undefined }))
  if (race === 'reminder acceptance') await f.caregiver.mutation(api.pickupIdentity.respond, { secret: contents(sent.get('sent-1')!).secret, response: 'accept', suggestion: '' })
  if (race === 'reminder expiry') vi.setSystemTime(Date.parse(f.payload.deadline))
  release(); await pending
  expect(mocks.send).toHaveBeenCalledTimes(reminder ? 1 : 0)
  const state = await f.state(), request = state.requests[0]
  if (reminder) {
    expect(request.followUpDispatchedAt).toBeDefined()
    expect(request.followUpProviderId).toBeUndefined()
    await f.t.action(internal.pickupMailWorker.remind, { requestId: request._id })
  } else {
    expect(state.attempts[0]).toMatchObject({ dispatched: true, finished: true })
    expect(request.mailMessageId).toBeUndefined()
    await f.t.action(internal.pickupMailWorker.send, { actionId: f.actionId, attemptId: state.attempts[0]._id })
  }
  expect(mocks.send).toHaveBeenCalledTimes(reminder ? 1 : 0)
  expect(state.receipts.filter(r => r.outcome === 'request_email_accepted')).toHaveLength(reminder ? 1 : 0)
})

it('still verifies immutable provider evidence if cancellation happens after Gmail receives the message', async () => {
  const f = await fixture(), acceptedSend = mocks.send.getMockImplementation()!
  mocks.send.mockImplementation(async args => { const result = await acceptedSend(args); await f.parent.mutation(api.jobs.cancel, { jobId: f.jobId }); return result })
  await f.send()
  const state = await f.state(), request = state.requests[0]
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(request).toMatchObject({ mailMessageId: 'sent-1', mailVerifiedAt: now })
  expect(state.receipts).toHaveLength(1)
  expect(state.receipts[0]).toMatchObject({ outcome: 'request_email_accepted', providerId: 'sent-1', revision: 1 })
  expect(await f.caregiver.query(api.pickupIdentity.view, { secret: contents(sent.get('sent-1')!).secret })).toBeNull()
})
