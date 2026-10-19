// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../shared/daymark'
import { gmailReplyHash } from '../shared/gmailReply'

const mocks = vi.hoisted(() => ({ threadGet: vi.fn(), profile: vi.fn(), draftGet: vi.fn(), send: vi.fn(), messageGet: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { getProfile: mocks.profile, threads: { get: mocks.threadGet }, drafts: { get: mocks.draftGet, send: mocks.send, create: mocks.create, update: mocks.update }, messages: { get: mocks.messageGet, list: mocks.list } } }) }))
import { draftMime } from './gmailDrafts'
import { findSentDraft, sendApprovedDraft } from './gmailSending'

const input = { to: 'school@example.test', subject: 'Re: Picnic — supplies 🌞', body: 'Hi there,\n\nWe can bring plates.\nThanks!' }
const previous = { input, operationKey: hash('synthetic-saved-operation'), approvedHash: hash(JSON.stringify(input)) }
const approval = { accountEmail: 'parent@example.test', input, operationKey: hash('synthetic-send-operation'), approvedHash: hash(JSON.stringify(input)), gmailDraftId: 'approved-draft', previous }
const oldApproval = { ...previous, accountEmail: approval.accountEmail }
const draft = (mime = draftMime(oldApproval)) => ({ id: approval.gmailDraftId, message: { id: 'draft-message', labelIds: ['DRAFT'], raw: Buffer.from(mime).toString('base64url') } })
const sent = (id = 'sent-message', mime = draftMime(approval)) => ({ id, labelIds: ['SENT'], raw: Buffer.from(mime).toString('base64url') })
const controls = () => ({ permitted: vi.fn(async () => true), dispatch: vi.fn(async () => true), recordId: vi.fn(async (_id: string): Promise<void> => {}) })
const options = { timeout: 10000, retry: false, maxContentLength: 1024 * 1024 }
const replyRouting = { threadId: 'source-thread', inReplyTo: '<notice@school.example>', references: ['<notice@school.example>'], subject: input.subject }
const threaded = { ...approval, replyRouting, approvedHash: gmailReplyHash(input, replyRouting), previous: { ...previous, replyRouting, approvedHash: gmailReplyHash(input, replyRouting) } }
const rewritten = (id = 'sent-message') => ({ ...sent(id, draftMime(threaded).replace(`Message-ID: <daymark.${approval.operationKey}@draft.daymark.invalid>`, 'Message-ID: <rewritten@gmail.example>')), threadId: replyRouting.threadId })
const noRecoveryWrites = () => { expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.draftGet).not.toHaveBeenCalled() }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.profile.mockResolvedValue({ data: { emailAddress: approval.accountEmail } })
  mocks.draftGet.mockResolvedValue({ data: draft() })
  mocks.send.mockResolvedValue({ data: { id: 'sent-message' } })
  mocks.messageGet.mockImplementation(async ({ id }: { id: string }) => ({ data: sent(id) }))
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'sent-message' }] } })
})
afterEach(() => { vi.restoreAllMocks() })

it('recovers an unknown sent ID from only the approved thread despite Gmail rewriting Message-ID', async () => {
  mocks.threadGet.mockResolvedValue({ data: { id: replyRouting.threadId, messages: [{ id: 'source', labelIds: ['INBOX'] }, { id: 'draft', labelIds: ['DRAFT'] }, { id: 'sent-message', labelIds: ['SENT'] }] } })
  mocks.messageGet.mockResolvedValue({ data: rewritten() })
  expect(await findSentDraft({} as any, threaded, async () => true)).toEqual({ id: 'sent-message', verified: true })
  expect(mocks.threadGet).toHaveBeenCalledExactlyOnceWith({ userId: 'me', id: replyRouting.threadId, format: 'minimal', fields: 'id,messages(id,labelIds)' }, options)
  expect(mocks.messageGet).toHaveBeenCalledTimes(1)
  expect(mocks.list).not.toHaveBeenCalled()
  noRecoveryWrites()
})

it.each(['duplicate exact copies', 'altered payload', 'wrong thread', 'overflow', 'duplicate candidate', 'invalid candidate', 'missing thread'] as const)('refuses threaded unknown-ID recovery for %s', async change => {
  const thread = { id: replyRouting.threadId, messages: [{ id: 'sent-message', labelIds: ['SENT'] }] }
  if (change === 'duplicate exact copies') thread.messages.push({ id: 'another', labelIds: ['SENT'] })
  if (change === 'wrong thread') thread.id = 'other-thread'
  if (change === 'overflow') thread.messages = Array.from({ length: 21 }, (_, i) => ({ id: `sent-${i}`, labelIds: ['SENT'] }))
  if (change === 'duplicate candidate') thread.messages.push(thread.messages[0])
  if (change === 'invalid candidate') thread.messages[0].id = 'bad\nid'
  mocks.threadGet.mockResolvedValue({ data: thread })
  mocks.messageGet.mockImplementation(async ({ id }: { id: string }) => ({ data: change === 'altered payload' ? { ...rewritten(id), raw: sent(id).raw } : rewritten(id) }))
  if (change === 'missing thread') mocks.threadGet.mockRejectedValue({ response: { status: 404 } })
  const result = findSentDraft({} as any, threaded, async () => true)
  if (['wrong thread', 'overflow', 'duplicate candidate', 'invalid candidate'].includes(change)) await expect(result).rejects.toThrow(/Invalid/)
  else expect(await result).toEqual({ verified: false })
  if (change === 'wrong thread' || change === 'overflow') expect(mocks.messageGet).not.toHaveBeenCalled()
  expect(mocks.list).not.toHaveBeenCalled()
  noRecoveryWrites()
})

it('limits a complete threaded recovery to twenty candidates and raw reads', async () => {
  mocks.threadGet.mockResolvedValue({ data: { id: replyRouting.threadId, messages: Array.from({ length: 20 }, (_, i) => ({ id: `sent-${i}`, labelIds: ['SENT'] })) } })
  mocks.messageGet.mockImplementation(async ({ id }: { id: string }) => ({ data: id === 'sent-0' ? rewritten(id) : sent(id) }))
  expect(await findSentDraft({} as any, threaded, async () => true)).toEqual({ id: 'sent-0', verified: true })
  expect(mocks.messageGet).toHaveBeenCalledTimes(20)
  noRecoveryWrites()
})

it.each(['account', 'permission before thread', 'permission between reads', 'deadline'] as const)('stops threaded unknown-ID recovery after changed %s', async change => {
  const permitted = vi.fn(async () => true)
  mocks.threadGet.mockResolvedValue({ data: { id: replyRouting.threadId, messages: [{ id: 'one', labelIds: ['SENT'] }, { id: 'two', labelIds: ['SENT'] }] } })
  mocks.messageGet.mockImplementation(async ({ id }: { id: string }) => ({ data: rewritten(id) }))
  if (change === 'account') mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  if (change === 'permission before thread') permitted.mockResolvedValueOnce(true).mockResolvedValue(false)
  if (change === 'permission between reads') permitted.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  if (change === 'deadline') {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now)
    mocks.threadGet.mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(now + 90000); return { data: { id: replyRouting.threadId, messages: [{ id: 'one', labelIds: ['SENT'] }] } } })
  }
  await expect(findSentDraft({} as any, threaded, permitted)).rejects.toThrow(/changed|ended/)
  if (change === 'account' || change === 'permission before thread') expect(mocks.threadGet).not.toHaveBeenCalled()
  expect(mocks.messageGet).toHaveBeenCalledTimes(change === 'permission between reads' ? 1 : 0)
  noRecoveryWrites()
})

it('recovers a legacy standalone send with rewritten Message-ID by exact markers and content in a complete bounded listing', async () => {
  mocks.messageGet.mockResolvedValue({ data: sent('sent-message', draftMime(approval).replace(`Message-ID: <daymark.${approval.operationKey}@draft.daymark.invalid>`, 'Message-ID: <rewritten@gmail.example>')) })
  expect(await findSentDraft({} as any, approval, async () => true)).toEqual({ id: 'sent-message', verified: true })
  expect(mocks.list.mock.calls[0][0].q).toBe('in:sent')
  expect(mocks.threadGet).not.toHaveBeenCalled()
  noRecoveryWrites()
})

it.each(['thread', 'parent', 'references', 'duplicate parent'] as const)('requires the approved %s in threaded SENT read-back and read-only recovery', async change => {
  const replyRouting = { threadId: 'source-thread', inReplyTo: '<notice@school.example>', references: ['<earlier@school.example>', '<notice@school.example>'], subject: input.subject }
  const value = { ...approval, replyRouting, approvedHash: gmailReplyHash(input, replyRouting), previous: { ...previous, replyRouting, approvedHash: gmailReplyHash(input, replyRouting) } }
  mocks.draftGet.mockResolvedValue({ data: { ...draft(draftMime({ ...oldApproval, replyRouting, approvedHash: value.previous.approvedHash })), message: { ...draft(draftMime({ ...oldApproval, replyRouting, approvedHash: value.previous.approvedHash })).message, threadId: replyRouting.threadId } } })
  let mime = draftMime(value)
  if (change === 'parent') mime = mime.replace(`In-Reply-To: ${replyRouting.inReplyTo}`, 'In-Reply-To: <other@school.example>')
  if (change === 'references') mime = mime.replace(`References: ${replyRouting.references.join('\r\n ')}`, `References: ${replyRouting.inReplyTo}`)
  if (change === 'duplicate parent') mime = `In-Reply-To: ${replyRouting.inReplyTo}\r\n${mime}`
  mocks.messageGet.mockResolvedValue({ data: { ...sent('sent-message', mime), threadId: change === 'thread' ? 'another-thread' : replyRouting.threadId } })
  expect(await sendApprovedDraft({} as any, value, controls())).toEqual({ id: 'sent-message', verified: false })
  expect(mocks.send.mock.calls[0][0].requestBody.message.threadId).toBe(replyRouting.threadId)
  expect(await findSentDraft({} as any, { ...value, sentMessageId: 'sent-message' }, async () => true)).toEqual({ id: 'sent-message', verified: false })
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('checks the verified saved draft, journals one exact-content send, records its ID, then verifies the SENT copy', async () => {
  const calls: string[] = [], c = controls()
  mocks.profile.mockImplementation(async () => { calls.push('account'); return { data: { emailAddress: approval.accountEmail.toUpperCase() } } })
  mocks.draftGet.mockImplementation(async () => { calls.push('old draft'); return { data: draft() } })
  c.dispatch.mockImplementation(async () => { calls.push('journal'); return true })
  mocks.send.mockImplementation(async () => { calls.push('send'); return { data: { id: 'sent-message' } } })
  c.recordId.mockImplementation(async () => { calls.push('record') })
  mocks.messageGet.mockImplementation(async () => { calls.push('sent read'); return { data: sent() } })

  expect(await sendApprovedDraft({} as any, approval, c)).toEqual({ id: 'sent-message', verified: true })
  expect(calls).toEqual(['account', 'old draft', 'journal', 'send', 'record', 'sent read'])
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ userId: 'me', requestBody: { id: approval.gmailDraftId, message: { raw: Buffer.from(draftMime(approval)).toString('base64url') } }, fields: 'id' }, options)
  expect(mocks.draftGet).toHaveBeenCalledExactlyOnceWith({ userId: 'me', id: approval.gmailDraftId, format: 'raw', fields: 'id,message(id,threadId,labelIds,raw)' }, options)
  expect(mocks.messageGet).toHaveBeenCalledExactlyOnceWith({ userId: 'me', id: 'sent-message', format: 'raw', fields: 'id,threadId,labelIds,raw' }, options)
  expect(c.dispatch).toHaveBeenCalledTimes(1)
  expect(c.recordId).toHaveBeenCalledExactlyOnceWith('sent-message')
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
})

it.each(['permission', 'account', 'permission before saved read', 'dispatch'] as const)('blocks changed %s before send', async change => {
  const c = controls()
  if (change === 'permission') c.permitted.mockResolvedValue(false)
  if (change === 'account') mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  if (change === 'permission before saved read') c.permitted.mockResolvedValueOnce(true).mockResolvedValue(false)
  if (change === 'dispatch') c.dispatch.mockResolvedValue(false)
  await expect(sendApprovedDraft({} as any, approval, c)).rejects.toThrow(/permission changed|account changed|approval changed/)
  expect(mocks.send).not.toHaveBeenCalled()
  expect(c.recordId).not.toHaveBeenCalled()
  expect(mocks.messageGet).not.toHaveBeenCalled()
  if (change !== 'dispatch') expect(c.dispatch).not.toHaveBeenCalled()
  if (change !== 'dispatch') expect(mocks.draftGet).not.toHaveBeenCalled()
  if (change === 'permission') expect(mocks.profile).not.toHaveBeenCalled()
})

it.each(['draft ID', 'payload hash'] as const)('rejects invalid approved %s before any provider read', async change => {
  const value = { ...approval, ...(change === 'draft ID' ? { gmailDraftId: 'bad\nid' } : { approvedHash: hash('altered') }) }
  const c = controls()
  await expect(sendApprovedDraft({} as any, value, c)).rejects.toThrow()
  expect(mocks.profile).not.toHaveBeenCalled()
  expect(c.dispatch).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['recipient', 'body', 'operation marker', 'hash marker', 'bcc', 'missing draft label', 'wrong ID'] as const)('blocks sending a saved draft with changed %s', async change => {
  let mime = draftMime(oldApproval)
  if (change === 'recipient') mime = mime.replace(input.to, 'other@example.test')
  if (change === 'body') mime = `${mime.slice(0, mime.indexOf('\r\n\r\n') + 4)}${Buffer.from('Changed body').toString('base64')}`
  if (change === 'operation marker') mime = mime.replace(`X-Daymark-Draft-Operation: ${previous.operationKey}`, `X-Daymark-Draft-Operation: ${hash('other')}`)
  if (change === 'hash marker') mime = mime.replace(`X-Daymark-Draft-Hash: ${previous.approvedHash}`, `X-Daymark-Draft-Hash: ${hash('other')}`)
  if (change === 'bcc') mime = `Bcc: hidden@example.test\r\n${mime}`
  const value = draft(mime)
  if (change === 'missing draft label') value.message.labelIds = ['SENT']
  if (change === 'wrong ID') value.id = 'other-draft'
  mocks.draftGet.mockResolvedValue({ data: value })
  const c = controls()
  await expect(sendApprovedDraft({} as any, approval, c)).rejects.toThrow('changed outside Sola')
  expect(c.dispatch).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(c.recordId).not.toHaveBeenCalled()
})

it('awaits the durable dispatch and sent-ID journals', async () => {
  let allowDispatch!: (value: boolean) => void, allowRecord!: () => void
  const c = controls()
  c.dispatch.mockImplementation(() => new Promise<boolean>(resolve => { allowDispatch = resolve }))
  c.recordId.mockImplementation(() => new Promise<void>(resolve => { allowRecord = resolve }))
  const result = sendApprovedDraft({} as any, approval, c)
  await vi.waitFor(() => expect(c.dispatch).toHaveBeenCalledTimes(1))
  expect(mocks.send).not.toHaveBeenCalled()
  allowDispatch(true)
  await vi.waitFor(() => expect(c.recordId).toHaveBeenCalledTimes(1))
  expect(mocks.messageGet).not.toHaveBeenCalled()
  allowRecord()
  expect(await result).toEqual({ id: 'sent-message', verified: true })
})

it('does not replay an ambiguous send; later recovery only reads the exact SENT copy', async () => {
  mocks.send.mockRejectedValue(new Error('timeout after provider acceptance'))
  const c = controls()
  await expect(sendApprovedDraft({} as any, approval, c)).rejects.toThrow('timeout')
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(c.dispatch).toHaveBeenCalledTimes(1)
  expect(c.recordId).not.toHaveBeenCalled()
  expect(mocks.messageGet).not.toHaveBeenCalled()
  expect(await findSentDraft({} as any, approval, async () => true)).toEqual({ id: 'sent-message', verified: true })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
})

it.each([undefined, '', 'bad\nid'] as const)('does not journal an invalid sent ID (%s) or replay the send', async id => {
  mocks.send.mockResolvedValue({ data: { id } })
  const c = controls()
  await expect(sendApprovedDraft({} as any, approval, c)).rejects.toThrow('sent-message identifier')
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(c.recordId).not.toHaveBeenCalled()
  expect(mocks.messageGet).not.toHaveBeenCalled()
})

it('records the sent ID before read permission is revoked', async () => {
  const c = controls()
  c.permitted.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  await expect(sendApprovedDraft({} as any, approval, c)).rejects.toThrow('verification access changed')
  expect(c.recordId).toHaveBeenCalledExactlyOnceWith('sent-message')
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.messageGet).not.toHaveBeenCalled()
})

it('does not continue or resend when sent-ID journaling fails', async () => {
  const c = controls()
  c.recordId.mockRejectedValue(new Error('journal unavailable'))
  await expect(sendApprovedDraft({} as any, approval, c)).rejects.toThrow('journal unavailable')
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.messageGet).not.toHaveBeenCalled()
})

it.each(['recipient', 'body', 'operation marker', 'hash marker', 'message identity', 'bcc', 'duplicate to', 'not SENT', 'still DRAFT', 'wrong ID'] as const)('leaves a send unverified for changed SENT-copy %s', async change => {
  let mime = draftMime(approval)
  if (change === 'recipient') mime = mime.replace(input.to, 'other@example.test')
  if (change === 'body') mime = `${mime.slice(0, mime.indexOf('\r\n\r\n') + 4)}${Buffer.from('Changed body').toString('base64')}`
  if (change === 'operation marker') mime = mime.replace(`X-Daymark-Draft-Operation: ${approval.operationKey}`, `X-Daymark-Draft-Operation: ${hash('other')}`)
  if (change === 'hash marker') mime = mime.replace(`X-Daymark-Draft-Hash: ${approval.approvedHash}`, `X-Daymark-Draft-Hash: ${hash('other')}`)
  if (change === 'message identity') mime = mime.replace(`Message-ID: <daymark.${approval.operationKey}@draft.daymark.invalid>`, 'Message-ID: malformed')
  if (change === 'bcc') mime = `Bcc: hidden@example.test\r\n${mime}`
  if (change === 'duplicate to') mime = `To: ${input.to}\r\n${mime}`
  const value = sent(change === 'wrong ID' ? 'other-message' : 'sent-message', mime)
  if (change === 'not SENT') value.labelIds = ['INBOX']
  if (change === 'still DRAFT') value.labelIds = ['SENT', 'DRAFT']
  mocks.messageGet.mockResolvedValue({ data: value })
  const c = controls()
  expect(await sendApprovedDraft({} as any, approval, c)).toEqual({ id: 'sent-message', verified: false })
  expect(c.recordId).toHaveBeenCalledExactlyOnceWith('sent-message')
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('reconciles a known sent ID without searching, and a deleted SENT copy remains unverified', async () => {
  const value = { ...approval, sentMessageId: 'sent-message' }
  expect(await findSentDraft({} as any, value, async () => true)).toEqual({ id: 'sent-message', verified: true })
  expect(mocks.list).not.toHaveBeenCalled()
  mocks.messageGet.mockRejectedValue({ response: { status: 404 } })
  expect(await findSentDraft({} as any, value, async () => true)).toEqual({ verified: false })
  expect(mocks.list).not.toHaveBeenCalled()
  noRecoveryWrites()
})

it('inspects a bounded SENT listing and requires exactly one copy matching the approved operation and content', async () => {
  expect(await findSentDraft({} as any, approval, async () => true)).toEqual({ id: 'sent-message', verified: true })
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ userId: 'me', q: 'in:sent', maxResults: 10, fields: 'messages(id),nextPageToken' }, options)
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }, { id: 'two' }] } })
  expect(await findSentDraft({} as any, approval, async () => true)).toEqual({ verified: false })
  mocks.list.mockResolvedValue({ data: { messages: [] } })
  expect(await findSentDraft({} as any, approval, async () => true)).toEqual({ verified: false })
  noRecoveryWrites()
})

it('ignores a deleted or mismatching search candidate and verifies a remaining exact match', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'deleted' }, { id: 'altered' }, { id: 'exact' }] } })
  mocks.messageGet.mockImplementation(async ({ id }: { id: string }) => {
    if (id === 'deleted') throw { response: { status: 404 } }
    return { data: sent(id, id === 'altered' ? draftMime(oldApproval) : draftMime(approval)) }
  })
  expect(await findSentDraft({} as any, approval, async () => true)).toEqual({ id: 'exact', verified: true })
  noRecoveryWrites()
})

it('bounds recovery to two pages and twenty reads without treating a partial search as proof', async () => {
  mocks.list.mockImplementation(async ({ pageToken }: { pageToken?: string }) => ({ data: { messages: Array.from({ length: 10 }, (_, i) => ({ id: `${pageToken ?? 'first'}-${i}` })), nextPageToken: pageToken ? 'third' : 'second' } }))
  mocks.messageGet.mockImplementation(async ({ id }: { id: string }) => ({ data: sent(id, id === 'first-0' ? draftMime(approval) : draftMime(oldApproval)) }))
  expect(await findSentDraft({} as any, approval, async () => true)).toEqual({ verified: false })
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(mocks.list.mock.calls[1][0]).toMatchObject({ pageToken: 'second' })
  expect(mocks.messageGet).toHaveBeenCalledTimes(20)
  noRecoveryWrites()
})

it.each(['oversized page', 'invalid ID', 'duplicate ID', 'invalid cursor', 'repeated cursor'] as const)('rejects malformed recovery %s without a write', async change => {
  if (change === 'oversized page') mocks.list.mockResolvedValue({ data: { messages: Array.from({ length: 11 }, (_, i) => ({ id: `message-${i}` })) } })
  if (change === 'invalid ID') mocks.list.mockResolvedValue({ data: { messages: [{ id: 'bad\nid' }] } })
  if (change === 'duplicate ID') mocks.list.mockResolvedValue({ data: { messages: [{ id: 'same' }, { id: 'same' }] } })
  if (change === 'invalid cursor') mocks.list.mockResolvedValue({ data: { nextPageToken: 'bad\ncursor' } })
  if (change === 'repeated cursor') mocks.list.mockResolvedValue({ data: { nextPageToken: 'same' } })
  await expect(findSentDraft({} as any, approval, async () => true)).rejects.toThrow(/Too many|Invalid/)
  noRecoveryWrites()
})

it.each(['account', 'permission', 'between candidates', 'deadline'] as const)('stops read-only recovery for changed %s', async change => {
  const permitted = vi.fn(async () => true)
  if (change === 'account') mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  if (change === 'permission') permitted.mockResolvedValue(false)
  if (change === 'between candidates') {
    mocks.list.mockResolvedValue({ data: { messages: [{ id: 'first' }, { id: 'second' }] } })
    permitted.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  }
  if (change === 'deadline') {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    mocks.profile.mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(now + 90000); return { data: { emailAddress: approval.accountEmail } } })
  }
  await expect(findSentDraft({} as any, approval, permitted)).rejects.toThrow(/changed|ended/)
  noRecoveryWrites()
  if (change === 'between candidates') expect(mocks.messageGet).toHaveBeenCalledTimes(1)
  else expect(mocks.messageGet).not.toHaveBeenCalled()
  if (change === 'permission') expect(mocks.profile).not.toHaveBeenCalled()
})

it.each([true, false])('propagates provider failures during %s known-ID recovery without replay', async knownId => {
  mocks.messageGet.mockRejectedValue({ response: { status: 503 } })
  await expect(findSentDraft({} as any, { ...approval, ...(knownId ? { sentMessageId: 'sent-message' } : {}) }, async () => true)).rejects.toEqual({ response: { status: 503 } })
  expect(mocks.messageGet).toHaveBeenCalledTimes(1)
  noRecoveryWrites()
})
