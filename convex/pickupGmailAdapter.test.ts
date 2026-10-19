// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../shared/daymark'
import { draftMime, type Approved } from './gmailDrafts'
const mocks = vi.hoisted(() => ({ profile: vi.fn(), send: vi.fn(), get: vi.fn(), list: vi.fn(), createDraft: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { getProfile: mocks.profile, messages: { send: mocks.send, get: mocks.get, list: mocks.list }, drafts: { create: mocks.createDraft } } }) }))
import { findPickupEmail, sendPickupEmail } from './pickupGmailAdapter'

const input = { to: 'caregiver@example.test', subject: 'Pickup request for Tuesday 🌞', body: 'Please review this pickup request.\n\nhttps://example.test/pickup#synthetic-secret' }
const approval: Approved = { accountEmail: 'parent@example.test', input, operationKey: hash('synthetic-pickup-invitation'), approvedHash: hash(JSON.stringify(input)) }
const auth = {} as any
const message = (id = 'sent-one', mime = draftMime(approval)) => ({ id, labelIds: ['SENT'], raw: Buffer.from(mime).toString('base64url') })
const controls = () => ({ permitted: vi.fn(async () => true), sendPermitted: vi.fn(async () => true), dispatch: vi.fn(async () => true), recordId: vi.fn(async (_id: string) => true) })
const recover = (value: Approved & { sentMessageId?: string } = approval, permitted = async () => true) => findPickupEmail(auth, value, permitted)
beforeEach(() => {
  vi.resetAllMocks()
  mocks.profile.mockResolvedValue({ data: { emailAddress: approval.accountEmail } })
  mocks.send.mockResolvedValue({ data: { id: 'sent-one' } })
  mocks.get.mockImplementation(async ({ id }) => ({ data: message(id) }))
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'sent-one' }] } })
})
afterEach(() => { vi.restoreAllMocks() })

it('awaits the durable dispatch and ID journals around one exact MIME send before SENT read-back', async () => {
  const c = controls(), order: string[] = []
  let releaseDispatch!: () => void, releaseRecord!: () => void
  c.dispatch.mockImplementation(async () => { order.push('journal'); await new Promise<void>(resolve => { releaseDispatch = resolve }); return true })
  mocks.send.mockImplementation(async () => { order.push('send'); return { data: { id: 'sent-one' } } })
  c.recordId.mockImplementation(async () => { order.push('record'); await new Promise<void>(resolve => { releaseRecord = resolve }); return true })
  mocks.get.mockImplementation(async ({ id }) => { order.push('read'); return { data: message(id) } })
  const pending = sendPickupEmail(auth, approval, c)
  await vi.waitFor(() => expect(order).toEqual(['journal']))
  expect(mocks.send).not.toHaveBeenCalled()
  releaseDispatch()
  await vi.waitFor(() => expect(order).toEqual(['journal', 'send', 'record']))
  expect(mocks.get).not.toHaveBeenCalled()
  releaseRecord()
  expect(await pending).toEqual({ id: 'sent-one', verified: true })
  expect(order).toEqual(['journal', 'send', 'record', 'read'])
  expect(c.dispatch).toHaveBeenCalledTimes(1)
  expect(c.recordId).toHaveBeenCalledWith('sent-one')
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ userId: 'me', requestBody: { raw: Buffer.from(draftMime(approval)).toString('base64url') }, fields: 'id' }, { timeout: 10000, retry: false, maxContentLength: 1024 * 1024 })
  expect(mocks.get).toHaveBeenCalledWith({ userId: 'me', id: 'sent-one', format: 'raw', fields: 'id,threadId,labelIds,raw' }, expect.objectContaining({ retry: false }))
  expect(mocks.createDraft).not.toHaveBeenCalled()
})

it.each(['permission', 'account', 'payload', 'journal', 'during journal', 'final write eligibility'] as const)('stops before send when %s changes', async change => {
  const c = controls()
  let value = approval
  if (change === 'final write eligibility') c.sendPermitted.mockResolvedValue(false)
  if (change === 'permission') c.permitted.mockResolvedValue(false)
  if (change === 'account') mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  if (change === 'payload') value = { ...approval, input: { ...input, to: 'other@example.test' } }
  if (change === 'journal') c.dispatch.mockResolvedValue(false)
  if (change === 'during journal') c.dispatch.mockImplementation(async () => { c.permitted.mockResolvedValue(false); return true })
  await expect(sendPickupEmail(auth, value, c)).rejects.toThrow()
  expect(mocks.send).not.toHaveBeenCalled(); expect(c.recordId).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled()
})

it.each(['missing ID', 'bad ID', 'timeout', 'record failure', 'read failure'] as const)('leaves %s uncertain without repeating the send', async failure => {
  const c = controls()
  if (failure === 'missing ID') mocks.send.mockResolvedValue({ data: {} })
  if (failure === 'bad ID') mocks.send.mockResolvedValue({ data: { id: 'bad id' } })
  if (failure === 'timeout') mocks.send.mockRejectedValue(new Error('timeout after possible acceptance'))
  if (failure === 'record failure') c.recordId.mockRejectedValue(new Error('journal unavailable'))
  if (failure === 'read failure') mocks.get.mockRejectedValue(new Error('read unavailable'))
  await expect(sendPickupEmail(auth, approval, c)).rejects.toThrow()
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(c.dispatch).toHaveBeenCalledTimes(1)
  if (['missing ID', 'bad ID', 'timeout', 'record failure'].includes(failure)) expect(mocks.get).not.toHaveBeenCalled()
})

it('retains the returned ID but stops verification if access is revoked after sending', async () => {
  const c = controls()
  mocks.send.mockImplementation(async () => { c.permitted.mockResolvedValue(false); return { data: { id: 'sent-one' } } })
  await expect(sendPickupEmail(auth, approval, c)).rejects.toThrow('access changed')
  expect(c.recordId).toHaveBeenCalledWith('sent-one'); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.send).toHaveBeenCalledTimes(1)
})

it.each(['recipient', 'body', 'operation', 'hash', 'bcc', 'wrong ID', 'not SENT', 'DRAFT', 'missing Message-ID'] as const)('rejects a changed %s in the sent copy', async change => {
  let mime = draftMime(approval)
  if (change === 'recipient') mime = mime.replace(input.to, 'other@example.test')
  if (change === 'body') mime = mime.slice(0, mime.indexOf('\r\n\r\n') + 4) + Buffer.from('Changed body').toString('base64')
  if (change === 'operation') mime = mime.replace(`X-Daymark-Draft-Operation: ${approval.operationKey}`, `X-Daymark-Draft-Operation: ${hash('other')}`)
  if (change === 'hash') mime = mime.replace(`X-Daymark-Draft-Hash: ${approval.approvedHash}`, `X-Daymark-Draft-Hash: ${hash('other')}`)
  if (change === 'bcc') mime = `Bcc: other@example.test\r\n${mime}`
  if (change === 'missing Message-ID') mime = mime.replace(/Message-ID: [^\r]+\r\n/, '')
  const data = message(change === 'wrong ID' ? 'unrequested' : 'sent-one', mime)
  if (change === 'not SENT') data.labelIds = ['INBOX']
  if (change === 'DRAFT') data.labelIds = ['SENT', 'DRAFT']
  mocks.get.mockResolvedValue({ data })
  expect(await sendPickupEmail(auth, approval, controls())).toEqual({ id: 'sent-one', verified: false })
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it('sends an independently approved reminder with its own exact contents and markers', async () => {
  const reminderInput = { ...input, subject: 'Reminder: pickup request', body: `Reminder: ${input.body}` }
  const reminder = { ...approval, input: reminderInput, operationKey: hash('synthetic-reminder'), approvedHash: hash(JSON.stringify(reminderInput)) }
  mocks.get.mockResolvedValue({ data: message('sent-one', draftMime(reminder)) })
  expect(await sendPickupEmail(auth, reminder, controls())).toEqual({ id: 'sent-one', verified: true })
  expect(mocks.send.mock.calls[0][0].requestBody.raw).toBe(Buffer.from(draftMime(reminder)).toString('base64url'))
})

it('checks a known ID directly and leaves a missing known copy uncertain without a fallback search', async () => {
  expect(await recover({ ...approval, sentMessageId: 'sent-one' })).toEqual({ id: 'sent-one', verified: true })
  mocks.get.mockRejectedValue({ response: { status: 404 } })
  expect(await recover({ ...approval, sentMessageId: 'sent-one' })).toEqual({ verified: false })
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['', 'bad id', 'id\nheader'])('rejects invalid known ID %j without reading or sending', async sentMessageId => {
  await expect(recover({ ...approval, sentMessageId })).rejects.toThrow('identifier')
  expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})

it('recovers the unique complete exact match when Gmail rewrites transport Message-ID', async () => {
  const mime = draftMime(approval).replace(/Message-ID: [^\r]+/, 'Message-ID: <provider-generated@mail.gmail.com>')
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'unrelated' }, { id: 'sent-one' }] } })
  mocks.get.mockImplementation(async ({ id }) => ({ data: message(id, id === 'sent-one' ? mime : mime.replace(input.to, 'other@example.test')) }))
  expect(await recover()).toEqual({ id: 'sent-one', verified: true })
  expect(mocks.list).toHaveBeenCalledWith({ userId: 'me', q: 'in:sent', maxResults: 10, fields: 'messages(id),nextPageToken' }, expect.objectContaining({ retry: false }))
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.createDraft).not.toHaveBeenCalled()
})

it('cannot verify two exact matches or an empty complete listing', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }, { id: 'two' }] } })
  expect(await recover()).toEqual({ verified: false })
  mocks.list.mockResolvedValue({ data: {} })
  expect(await recover()).toEqual({ verified: false })
  expect(mocks.send).not.toHaveBeenCalled()
})

it('uses the second page for a complete unique match', async () => {
  mocks.list.mockResolvedValueOnce({ data: { messages: [{ id: 'other' }], nextPageToken: 'page-two' } }).mockResolvedValueOnce({ data: { messages: [{ id: 'sent-one' }] } })
  mocks.get.mockImplementation(async ({ id }) => ({ data: message(id, id === 'sent-one' ? draftMime(approval) : draftMime(approval).replace(input.to, 'other@example.test')) }))
  expect(await recover()).toEqual({ id: 'sent-one', verified: true })
  expect(mocks.list.mock.calls[1][0]).toMatchObject({ pageToken: 'page-two' })
})

it.each(['duplicate ID', 'duplicate across pages', 'invalid ID', 'invalid cursor', 'repeated cursor', 'oversized page', 'malformed listing'] as const)('rejects %s without reporting a partial match', async invalid => {
  if (invalid === 'duplicate ID') mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }, { id: 'one' }] } })
  if (invalid === 'duplicate across pages') mocks.list.mockResolvedValueOnce({ data: { messages: [{ id: 'one' }], nextPageToken: 'page-two' } }).mockResolvedValueOnce({ data: { messages: [{ id: 'one' }] } })
  if (invalid === 'invalid ID') mocks.list.mockResolvedValue({ data: { messages: [{ id: 'bad id' }] } })
  if (invalid === 'invalid cursor') mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }], nextPageToken: '' } })
  if (invalid === 'repeated cursor') mocks.list.mockResolvedValue({ data: { messages: [], nextPageToken: 'again' } })
  if (invalid === 'oversized page') mocks.list.mockResolvedValue({ data: { messages: Array.from({ length: 11 }, (_, i) => ({ id: `sent-${i}` })) } })
  if (invalid === 'malformed listing') mocks.list.mockResolvedValue({ data: { messages: {} } })
  await expect(recover()).rejects.toThrow()
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.list.mock.calls.length).toBeLessThanOrEqual(2); expect(mocks.get.mock.calls.length).toBeLessThanOrEqual(20)
})

it('does not verify a unique match in an incomplete listing beyond twenty raw reads', async () => {
  mocks.list.mockImplementation(async ({ pageToken }) => ({ data: { messages: Array.from({ length: 10 }, (_, i) => ({ id: `${pageToken ?? 'first'}-${i}` })), nextPageToken: pageToken ? 'third' : 'second' } }))
  mocks.get.mockImplementation(async ({ id }) => ({ data: message(id, id === 'first-0' ? draftMime(approval) : draftMime(approval).replace(input.to, 'other@example.test')) }))
  expect(await recover()).toEqual({ verified: false })
  expect(mocks.list).toHaveBeenCalledTimes(2); expect(mocks.get).toHaveBeenCalledTimes(20); expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['not found', 'network error'] as const)('leaves a partial candidate read uncertain for %s', async failure => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }, { id: 'two' }] } })
  mocks.get.mockResolvedValueOnce({ data: message('one') }).mockRejectedValueOnce(failure === 'not found' ? { response: { status: 404 } } : new Error('network unavailable'))
  if (failure === 'not found') expect(await recover()).toEqual({ verified: false })
  else await expect(recover()).rejects.toThrow('network unavailable')
  expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['before profile', 'after profile', 'between reads', 'after final read', 'account'] as const)('stops recovery for changed access %s', async change => {
  const permitted = vi.fn(async () => true)
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }, { id: 'two' }] } })
  if (change === 'before profile') permitted.mockResolvedValue(false)
  if (change === 'after profile') mocks.profile.mockImplementation(async () => { permitted.mockResolvedValue(false); return { data: { emailAddress: approval.accountEmail } } })
  if (change === 'between reads') mocks.get.mockImplementationOnce(async ({ id }) => { permitted.mockResolvedValue(false); return { data: message(id) } })
  if (change === 'after final read') { mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }] } }); mocks.get.mockImplementation(async ({ id }) => { permitted.mockResolvedValue(false); return { data: message(id) } }) }
  if (change === 'account') mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  await expect(recover(approval, permitted)).rejects.toThrow(/access changed|account changed/)
  if (['before profile', 'after profile', 'account'].includes(change)) expect(mocks.list).not.toHaveBeenCalled()
  expect(mocks.get.mock.calls.length).toBeLessThanOrEqual(1); expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['profile', 'listing', 'raw read', 'permission check'] as const)('enforces the ninety-second budget even when %s completes late', async late => {
  const now = 1000000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const expire = () => vi.mocked(Date.now).mockReturnValue(now + 90000)
  let permitted = async () => true
  if (late === 'profile') mocks.profile.mockImplementation(async () => { expire(); return { data: { emailAddress: approval.accountEmail } } })
  if (late === 'listing') mocks.list.mockImplementation(async () => { expire(); return { data: { messages: [{ id: 'sent-one' }] } } })
  if (late === 'raw read') mocks.get.mockImplementation(async ({ id }) => { expire(); return { data: message(id) } })
  if (late === 'permission check') permitted = async () => { expire(); return true }
  await expect(recover(approval, permitted)).rejects.toThrow('bounded check ended')
  if (late !== 'raw read') expect(mocks.get).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('rejects accidental threaded routing before any provider operation', async () => {
  const threaded = { ...approval, replyRouting: { threadId: 'thread-one', inReplyTo: '<source@example.test>', references: ['<source@example.test>'], subject: input.subject } }
  await expect(sendPickupEmail(auth, threaded, controls())).rejects.toThrow('standalone')
  await expect(recover(threaded)).rejects.toThrow('standalone')
  expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
