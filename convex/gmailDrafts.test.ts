// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../shared/daymark'
import { gmailReplyHash } from '../shared/gmailReply'
const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn(), profile: vi.fn(), send: vi.fn(), update: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { getProfile: mocks.profile, drafts: { create: mocks.create, get: mocks.get, list: mocks.list, send: mocks.send, update: mocks.update } } }) }))
import { createApprovedDraft, draftMime, findApprovedDraft, matchesDraft } from './gmailDrafts'
const input = { to: 'school@example.test', subject: 'Re: Picnic — supplies 🌞', body: 'Hi there,\n\nWe can bring plates.\nThanks!' }
const approval = { accountEmail: 'parent@example.test', input, operationKey: hash('synthetic-operation'), approvedHash: hash(JSON.stringify(input)) }
const providerDraft = (id = 'draft-id', mime = draftMime(approval)) => ({ id, message: { id: 'message-id', labelIds: ['DRAFT'], raw: Buffer.from(mime).toString('base64url') } })
const controls = () => ({ permitted: vi.fn(async () => true), dispatch: vi.fn(async () => true), recordId: vi.fn(async () => true) })
beforeEach(() => {
  vi.resetAllMocks(); mocks.profile.mockResolvedValue({ data: { emailAddress: approval.accountEmail } })
  mocks.create.mockResolvedValue({ data: { id: 'draft-id' } }); mocks.get.mockResolvedValue({ data: providerDraft() }); mocks.list.mockResolvedValue({ data: { drafts: [{ id: 'draft-id' }] } })
})
afterEach(() => { vi.restoreAllMocks() })
it('discovers a lost draft ID by exact threaded contents and markers after Gmail rewrites Message-ID', async () => {
  const replyRouting = { threadId: 'source-thread', inReplyTo: '<notice@school.example>', references: ['<notice@school.example>'], subject: input.subject }
  const value = { ...approval, replyRouting, approvedHash: gmailReplyHash(input, replyRouting) }
  const mime = draftMime(value).replace(`Message-ID: <daymark.${value.operationKey}@draft.daymark.invalid>`, 'Message-ID: <rewritten@gmail.example>')
  mocks.get.mockResolvedValue({ data: { ...providerDraft('draft-id', mime), message: { ...providerDraft('draft-id', mime).message, threadId: replyRouting.threadId } } })
  expect(await findApprovedDraft({} as any, value, async () => true)).toEqual({ id: 'draft-id', verified: true })
  expect(mocks.list.mock.calls[0][0]).toMatchObject({ q: 'in:drafts', maxResults: 10 })
  mocks.get.mockResolvedValue({ data: { ...providerDraft('draft-id', mime), message: { ...providerDraft('draft-id', mime).message, threadId: 'wrong-thread' } } })
  expect(await findApprovedDraft({} as any, value, async () => true)).toEqual({ verified: false })
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it('does not mistake a unique exact draft in a partial fallback listing for a completed recovery', async () => {
  mocks.list.mockImplementation(async ({ pageToken }) => ({ data: { drafts: Array.from({ length: 10 }, (_, i) => ({ id: `${pageToken ?? 'first'}-${i}` })), nextPageToken: pageToken ? 'third' : 'second' } }))
  mocks.get.mockImplementation(async ({ id }) => {
    let mime = draftMime(approval).replace(`Message-ID: <daymark.${approval.operationKey}@draft.daymark.invalid>`, 'Message-ID: <rewritten@gmail.example>')
    if (id !== 'first-0') mime = mime.replace(`X-Daymark-Draft-Operation: ${approval.operationKey}`, `X-Daymark-Draft-Operation: ${hash('other')}`)
    return { data: providerDraft(id, mime) }
  })
  expect(await findApprovedDraft({} as any, approval, async () => true)).toEqual({ verified: false })
  expect(mocks.list).toHaveBeenCalledTimes(2); expect(mocks.get).toHaveBeenCalledTimes(20)
  expect(mocks.create).not.toHaveBeenCalled()
})
it('recovers a legacy standalone draft with rewritten Message-ID and rejects an oversized fallback page', async () => {
  const mime = draftMime(approval).replace(`Message-ID: <daymark.${approval.operationKey}@draft.daymark.invalid>`, 'Message-ID: <rewritten@gmail.example>')
  mocks.get.mockResolvedValue({ data: providerDraft('draft-id', mime) })
  expect(await findApprovedDraft({} as any, approval, async () => true)).toEqual({ id: 'draft-id', verified: true })
  mocks.list.mockResolvedValue({ data: { drafts: Array.from({ length: 11 }, (_, i) => ({ id: `draft-${i}` })) } })
  await expect(findApprovedDraft({} as any, approval, async () => true)).rejects.toThrow('too many')
  expect(mocks.get).toHaveBeenCalledTimes(1)
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it.each(['account', 'permission between reads', 'deadline'] as const)('stops lost-ID draft recovery for changed %s', async change => {
  const permitted = vi.fn(async () => true)
  mocks.list.mockResolvedValue({ data: { drafts: [{ id: 'one' }, { id: 'two' }] } })
  mocks.get.mockImplementation(async ({ id }) => ({ data: providerDraft(id) }))
  if (change === 'account') mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  if (change === 'permission between reads') permitted.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  if (change === 'deadline') {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now)
    mocks.list.mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(now + 90000); return { data: { drafts: [{ id: 'one' }] } } })
  }
  await expect(findApprovedDraft({} as any, approval, permitted)).rejects.toThrow(/different account|access changed/)
  expect(mocks.get).toHaveBeenCalledTimes(change === 'permission between reads' ? 1 : 0)
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it('writes one reviewed MIME, records its ID before reading, and exposes no send or update call', async () => {
  const c = controls(), calls: string[] = []
  c.dispatch.mockImplementation(async () => { calls.push('journal'); return true })
  mocks.create.mockImplementation(async () => { calls.push('create'); return { data: { id: 'draft-id' } } })
  c.recordId.mockImplementation(async () => { calls.push('record'); return true })
  mocks.get.mockImplementation(async () => { calls.push('read'); return { data: providerDraft() } })
  expect(await createApprovedDraft({} as any, approval, c)).toEqual({ id: 'draft-id', verified: true })
  expect(calls).toEqual(['journal', 'create', 'record', 'read'])
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'me', requestBody: { message: { raw: Buffer.from(draftMime(approval)).toString('base64url') } } }), expect.objectContaining({ retry: false }))
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
})
it.each(['to', 'from', 'subject', 'body', 'marker', 'hash', 'bcc', 'duplicate', 'label', 'id'] as const)('rejects a changed %s despite the provider claiming a saved draft', async change => {
  let mime = draftMime(approval), value = providerDraft()
  if (change === 'to') mime = mime.replace(input.to, 'other@example.test')
  if (change === 'from') mime = mime.replace(approval.accountEmail, 'other@example.test')
  if (change === 'subject') mime = mime.replace(/Subject: .+\r\n/, 'Subject: Other\r\n')
  if (change === 'body') mime = `${mime.slice(0, mime.indexOf('\r\n\r\n') + 4)}${Buffer.from('Changed body').toString('base64')}`
  if (change === 'marker') mime = mime.replace(`X-Daymark-Draft-Operation: ${approval.operationKey}`, `X-Daymark-Draft-Operation: ${hash('other')}`)
  if (change === 'hash') mime = mime.replace(`X-Daymark-Draft-Hash: ${approval.approvedHash}`, `X-Daymark-Draft-Hash: ${hash('other')}`)
  if (change === 'bcc') mime = `Bcc: hidden@example.test\r\n${mime}`
  if (change === 'duplicate') mime = `To: ${input.to}\r\n${mime}`
  value = providerDraft('draft-id', mime)
  if (change === 'label') value.message.labelIds = ['SENT']
  if (change === 'id') value.id = 'unrequested-draft'
  expect(matchesDraft(value, approval, 'draft-id')).toBe(false)
})
it('round trips long UTF-8 subjects as folded encoded words and blocks header injection', () => {
  const long = { ...input, subject: 'Family 🌞 schedule '.repeat(15).slice(0, 300).trim() }, data = { ...approval, input: long, approvedHash: hash(JSON.stringify(long)) }
  const mime = draftMime(data)
  expect(matchesDraft(providerDraft('draft-id', mime), data, 'draft-id')).toBe(true)
  expect(mime.split('\r\n').filter(line => line.startsWith('Subject:') || line.startsWith(' ')).every(line => line.length < 78)).toBe(true)
  const injected = { ...input, subject: 'Hi\r\nBcc: attacker@example.test' }
  expect(() => draftMime({ ...approval, input: injected, approvedHash: hash(JSON.stringify(injected)) })).toThrow()
})
it('stops before dispatch for revoked access, mismatched token account or altered approved payload', async () => {
  const c = controls(); c.permitted.mockResolvedValue(false)
  await expect(createApprovedDraft({} as any, approval, c)).rejects.toThrow('access changed')
  expect(mocks.profile).not.toHaveBeenCalled(); expect(c.dispatch).not.toHaveBeenCalled()
  c.permitted.mockResolvedValue(true); mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  await expect(createApprovedDraft({} as any, approval, c)).rejects.toThrow('different account')
  expect(c.dispatch).not.toHaveBeenCalled()
  await expect(createApprovedDraft({} as any, { ...approval, approvedHash: 'wrong' }, c)).rejects.toThrow('invalid')
  expect(mocks.create).not.toHaveBeenCalled()
})
it('does not read after revoked access following create, retaining provider ID via callback', async () => {
  const c = controls(); c.permitted.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  await expect(createApprovedDraft({} as any, approval, c)).rejects.toThrow('access changed')
  expect(c.recordId).toHaveBeenCalledWith('draft-id'); expect(mocks.get).not.toHaveBeenCalled()
})
it('throws for missing provider IDs and does not retry ambiguous creates', async () => {
  const c = controls(); mocks.create.mockResolvedValue({ data: {} })
  await expect(createApprovedDraft({} as any, approval, c)).rejects.toThrow('uncertain')
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(c.recordId).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled()
  mocks.create.mockRejectedValue(new Error('timeout after provider acceptance'))
  await expect(createApprovedDraft({} as any, approval, controls())).rejects.toThrow('timeout')
  expect(mocks.create).toHaveBeenCalledTimes(2)
})
it('reconciles by a known draft ID with reads only and leaves deletions uncertain', async () => {
  expect(await findApprovedDraft({} as any, { ...approval, gmailDraftId: 'draft-id' }, async () => true)).toEqual({ id: 'draft-id', verified: true })
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled()
  mocks.get.mockRejectedValue({ response: { status: 404 } })
  expect(await findApprovedDraft({} as any, { ...approval, gmailDraftId: 'draft-id' }, async () => true)).toEqual({ verified: false })
})
it('finds one exact operation marker without create or send, and cannot verify duplicate matches', async () => {
  expect(await findApprovedDraft({} as any, approval, async () => true)).toEqual({ id: 'draft-id', verified: true })
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'in:drafts', maxResults: 10 }), expect.objectContaining({ retry: false }))
  mocks.list.mockResolvedValue({ data: { drafts: [{ id: 'one' }, { id: 'two' }] } }); mocks.get.mockImplementation(async ({ id }) => ({ data: providerDraft(id) }))
  expect(await findApprovedDraft({} as any, approval, async () => true)).toEqual({ verified: false })
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it('bounds uncertain reconciliation to twenty draft reads and never interprets partial search as absence', async () => {
  mocks.list.mockImplementation(async ({ pageToken }) => ({ data: { drafts: Array.from({ length: 10 }, (_, i) => ({ id: `${pageToken ?? 'first'}-${i}` })), nextPageToken: pageToken ? 'third' : 'second' } }))
  mocks.get.mockImplementation(async ({ id }) => ({ data: providerDraft(id) }))
  expect(await findApprovedDraft({} as any, approval, async () => true)).toEqual({ verified: false })
  expect(mocks.list).toHaveBeenCalledTimes(2); expect(mocks.get).toHaveBeenCalledTimes(20); expect(mocks.create).not.toHaveBeenCalled()
})

it('reports only fixed verification categories and never provider headers or body text', async () => {
  const { draftVerificationIssue, messageVerificationIssue } = await import('./gmailDrafts')
  const sensitive = 'SYNTHETIC_PRIVATE_BODY_SENTINEL'
  const mime = draftMime(approval).replace(`Message-ID: <daymark.${approval.operationKey}@draft.daymark.invalid>`, `Message-ID: ${sensitive}`)
  expect(draftVerificationIssue(providerDraft('draft-id', mime), approval, 'draft-id')).toBe('message_identity')
  expect(messageVerificationIssue(providerDraft('draft-id', mime).message, approval)).not.toContain(sensitive)
  expect(draftVerificationIssue(providerDraft(), approval, 'draft-id')).toBeNull()
})

it('accepts a provider-rewritten transport Message-ID only with the same draft and exact approved content', async () => {
  const mime = draftMime(approval).replace(/Message-ID: [^\r]+/, 'Message-ID: <generated-by-google@mail.gmail.com>')
  mocks.get.mockResolvedValue({ data: providerDraft('draft-id', mime) })
  expect(await findApprovedDraft({} as any, { ...approval, gmailDraftId: 'draft-id' }, async () => true)).toEqual({ id: 'draft-id', verified: true })
  expect(matchesDraft(providerDraft('another-draft', mime), approval, 'draft-id')).toBe(false)
  expect(matchesDraft(providerDraft('draft-id', mime.replace(input.to, 'other@example.test')), approval, 'draft-id')).toBe(false)
  expect(matchesDraft(providerDraft('draft-id', mime.replace(approval.operationKey, hash('other'))), approval, 'draft-id')).toBe(false)
  expect(mocks.create).not.toHaveBeenCalled()
})

it.each(['', '<missing-domain>', '<one@example.test>, <two@example.test>', '<one@example.test>\r\nMessage-ID: <two@example.test>'])('rejects a missing, malformed or duplicate transport identity: %s', header => {
  const mime = draftMime(approval).replace(/Message-ID: [^\r]+/, `Message-ID: ${header}`)
  expect(matchesDraft(providerDraft('draft-id', mime), approval, 'draft-id')).toBe(false)
})
