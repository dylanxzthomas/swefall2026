// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../shared/daymark'
import { gmailReplyHash } from '../shared/gmailReply'

const mocks = vi.hoisted(() => ({ profile: vi.fn(), get: vi.fn(), update: vi.fn(), create: vi.fn(), send: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { getProfile: mocks.profile, drafts: { get: mocks.get, update: mocks.update, create: mocks.create, send: mocks.send } } }) }))
import { draftMime, updateApprovedDraft, type Approved } from './gmailDrafts'

const previousInput = { to: 'school@example.test', subject: 'Re: Picnic 🌞', body: 'We can bring plates.' }
const input = { ...previousInput, body: 'Hi there,\n\nWe can bring plates and cups.\nThanks!' }
const previous = { input: previousInput, operationKey: hash('synthetic-draft-save'), approvedHash: hash(JSON.stringify(previousInput)) }
const approval = { accountEmail: 'parent@example.test', input, operationKey: hash('synthetic-draft-update'), approvedHash: hash(JSON.stringify(input)), gmailDraftId: 'saved-draft', previous }
const oldApproval = { ...previous, accountEmail: approval.accountEmail }
const providerDraft = (data: Approved, mime = draftMime(data), id = approval.gmailDraftId) => ({ id, message: { id: 'draft-message', labelIds: ['DRAFT'], raw: Buffer.from(mime).toString('base64url') } })
const controls = () => ({ permitted: vi.fn(async () => true), dispatch: vi.fn(async () => true), recordId: vi.fn(async (_id: string): Promise<void> => {}) })
const options = { timeout: 10000, retry: false, maxContentLength: 1024 * 1024 }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.profile.mockResolvedValue({ data: { emailAddress: approval.accountEmail } })
  mocks.get.mockResolvedValueOnce({ data: providerDraft(oldApproval) }).mockResolvedValue({ data: providerDraft(approval) })
  mocks.update.mockResolvedValue({ data: { id: approval.gmailDraftId } })
})

it('does not overwrite the same draft ID when its verified conversation changed in Gmail', async () => {
  const replyRouting = { threadId: 'source-thread', inReplyTo: '<notice@school.example>', references: ['<notice@school.example>'], subject: input.subject }
  const value = { ...approval, replyRouting, approvedHash: gmailReplyHash(input, replyRouting), previous: { ...previous, replyRouting, approvedHash: gmailReplyHash(previousInput, replyRouting) } }
  const before = providerDraft({ ...oldApproval, replyRouting, approvedHash: value.previous.approvedHash })
  mocks.get.mockReset().mockResolvedValue({ data: { ...before, message: { ...before.message, threadId: 'another-thread' } } })
  const c = controls()
  await expect(updateApprovedDraft({} as any, value, c)).rejects.toThrow('changed outside Sola')
  expect(c.dispatch).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
})

it('checks old contents, journals one same-ID replacement with exact approved MIME, records the ID, then verifies new contents', async () => {
  const calls: string[] = [], c = controls()
  mocks.profile.mockImplementation(async () => { calls.push('account'); return { data: { emailAddress: approval.accountEmail.toUpperCase() } } })
  mocks.get.mockReset().mockImplementation(async () => { calls.push('read'); return { data: providerDraft(calls.includes('update') ? approval : oldApproval) } })
  c.dispatch.mockImplementation(async () => { calls.push('journal'); return true })
  mocks.update.mockImplementation(async () => { calls.push('update'); return { data: { id: approval.gmailDraftId } } })
  c.recordId.mockImplementation(async () => { calls.push('record') })

  expect(await updateApprovedDraft({} as any, approval, c)).toEqual({ id: approval.gmailDraftId, verified: true })
  expect(calls).toEqual(['account', 'read', 'journal', 'update', 'record', 'read'])
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ userId: 'me', id: approval.gmailDraftId, requestBody: { id: approval.gmailDraftId, message: { raw: Buffer.from(draftMime(approval)).toString('base64url') } }, fields: 'id' }, options)
  expect(mocks.get).toHaveBeenCalledTimes(2)
  for (const call of mocks.get.mock.calls) expect(call).toEqual([{ userId: 'me', id: approval.gmailDraftId, format: 'raw', fields: 'id,message(id,threadId,labelIds,raw)' }, options])
  expect(c.dispatch).toHaveBeenCalledTimes(1)
  expect(c.recordId).toHaveBeenCalledExactlyOnceWith(approval.gmailDraftId)
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['missing ID', 'invalid ID', 'missing proof'] as const)('rejects %s without provider access', async change => {
  const value = { ...approval, ...(change === 'missing ID' ? { gmailDraftId: undefined } : change === 'invalid ID' ? { gmailDraftId: 'bad\nid' } : { previous: undefined }) }, c = controls()
  await expect(updateApprovedDraft({} as any, value, c)).rejects.toThrow('proof is missing')
  expect(mocks.profile).not.toHaveBeenCalled()
  expect(mocks.get).not.toHaveBeenCalled()
  expect(c.dispatch).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
})

it.each(['recipient', 'body', 'operation', 'hash', 'hidden recipient', 'duplicate recipient', 'draft ID', 'draft label'] as const)('blocks replacement when previous %s changed in Gmail', async change => {
  let mime = draftMime(oldApproval)
  if (change === 'recipient') mime = mime.replace(previousInput.to, 'other@example.test')
  if (change === 'body') mime = mime.replace(Buffer.from(previousInput.body).toString('base64'), Buffer.from('Changed outside Sola.').toString('base64'))
  if (change === 'operation') mime = mime.replace(`X-Daymark-Draft-Operation: ${previous.operationKey}`, `X-Daymark-Draft-Operation: ${hash('other')}`)
  if (change === 'hash') mime = mime.replace(`X-Daymark-Draft-Hash: ${previous.approvedHash}`, `X-Daymark-Draft-Hash: ${hash('other')}`)
  if (change === 'hidden recipient') mime = `Bcc: hidden@example.test\r\n${mime}`
  if (change === 'duplicate recipient') mime = `To: ${previousInput.to}\r\n${mime}`
  const value = providerDraft(oldApproval, mime, change === 'draft ID' ? 'another-draft' : approval.gmailDraftId)
  if (change === 'draft label') value.message.labelIds = ['SENT']
  mocks.get.mockReset().mockResolvedValue({ data: value })
  const c = controls()
  await expect(updateApprovedDraft({} as any, approval, c)).rejects.toThrow('changed outside Sola')
  expect(c.dispatch).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
  expect(c.recordId).not.toHaveBeenCalled()
})

it.each(['initial permission', 'account', 'permission before old read', 'dispatch guard'] as const)('stops before updating for changed %s', async change => {
  const c = controls()
  if (change === 'initial permission') c.permitted.mockResolvedValue(false)
  if (change === 'account') mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  if (change === 'permission before old read') c.permitted.mockResolvedValueOnce(true).mockResolvedValue(false)
  if (change === 'dispatch guard') c.dispatch.mockResolvedValue(false)
  await expect(updateApprovedDraft({} as any, approval, c)).rejects.toThrow(/access changed|different account|approval changed/)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(c.recordId).not.toHaveBeenCalled()
  if (change !== 'dispatch guard') expect(c.dispatch).not.toHaveBeenCalled()
  if (change === 'initial permission') expect(mocks.profile).not.toHaveBeenCalled()
  if (change !== 'dispatch guard') expect(mocks.get).not.toHaveBeenCalled()
})

it('rejects an altered approved payload before checking the provider', async () => {
  await expect(updateApprovedDraft({} as any, { ...approval, input: { ...input, to: 'other@example.test' } }, controls())).rejects.toThrow('invalid')
  expect(mocks.profile).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
})

it('awaits the dispatch journal and provider-ID journal before proceeding', async () => {
  let allowDispatch!: (value: boolean) => void, allowRecord!: () => void
  const c = controls()
  c.dispatch.mockImplementation(() => new Promise<boolean>(resolve => { allowDispatch = resolve }))
  c.recordId.mockImplementation(() => new Promise<void>(resolve => { allowRecord = resolve }))
  const result = updateApprovedDraft({} as any, approval, c)
  await vi.waitFor(() => expect(c.dispatch).toHaveBeenCalledTimes(1))
  expect(mocks.update).not.toHaveBeenCalled()
  allowDispatch(true)
  await vi.waitFor(() => expect(c.recordId).toHaveBeenCalledTimes(1))
  expect(mocks.get).toHaveBeenCalledTimes(1)
  allowRecord()
  expect(await result).toEqual({ id: approval.gmailDraftId, verified: true })
})

it.each([undefined, 'different-draft'] as const)('leaves an unexpected update ID (%s) uncertain with no follow-up write or ID journal', async id => {
  mocks.update.mockResolvedValue({ data: { id } })
  const c = controls()
  await expect(updateApprovedDraft({} as any, approval, c)).rejects.toThrow('expected draft')
  expect(mocks.update).toHaveBeenCalledTimes(1)
  expect(mocks.get).toHaveBeenCalledTimes(1)
  expect(c.recordId).not.toHaveBeenCalled()
  expect(mocks.create).not.toHaveBeenCalled()
})

it('does not replay an ambiguous replacement or proceed to read-back', async () => {
  mocks.update.mockRejectedValue(new Error('timeout after provider acceptance'))
  const c = controls()
  await expect(updateApprovedDraft({} as any, approval, c)).rejects.toThrow('timeout')
  expect(mocks.update).toHaveBeenCalledTimes(1)
  expect(mocks.get).toHaveBeenCalledTimes(1)
  expect(c.recordId).not.toHaveBeenCalled()
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('retains the returned ID before denied read-back access without claiming verification', async () => {
  const c = controls()
  c.permitted.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  await expect(updateApprovedDraft({} as any, approval, c)).rejects.toThrow('access changed')
  expect(c.recordId).toHaveBeenCalledExactlyOnceWith(approval.gmailDraftId)
  expect(mocks.update).toHaveBeenCalledTimes(1)
  expect(mocks.get).toHaveBeenCalledTimes(1)
})

it('returns unverified when Gmail returns the old contents after a successful replacement', async () => {
  mocks.get.mockReset().mockResolvedValue({ data: providerDraft(oldApproval) })
  const c = controls()
  expect(await updateApprovedDraft({} as any, approval, c)).toEqual({ id: approval.gmailDraftId, verified: false })
  expect(c.recordId).toHaveBeenCalledExactlyOnceWith(approval.gmailDraftId)
  expect(mocks.update).toHaveBeenCalledTimes(1)
})

it('does not read or retry after provider-ID journaling fails', async () => {
  const c = controls()
  c.recordId.mockRejectedValue(new Error('journal unavailable'))
  await expect(updateApprovedDraft({} as any, approval, c)).rejects.toThrow('journal unavailable')
  expect(mocks.update).toHaveBeenCalledTimes(1)
  expect(mocks.get).toHaveBeenCalledTimes(1)
})
