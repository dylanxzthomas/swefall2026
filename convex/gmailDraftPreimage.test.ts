// @vitest-environment node
import type { gmail_v1 } from '@googleapis/gmail'
import { beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../shared/daymark'
import { gmailReplyHash } from '../shared/gmailReply'
import { plainDraftBodyMatches } from '../shared/gmailDraftForm'
const mocks = vi.hoisted(() => ({ profile: vi.fn(), get: vi.fn(), update: vi.fn(), send: vi.fn(), list: vi.fn(), messageGet: vi.fn(), threadGet: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { getProfile: mocks.profile, drafts: { get: mocks.get, update: mocks.update, send: mocks.send, list: mocks.list }, messages: { get: mocks.messageGet }, threads: { get: mocks.threadGet } } }) }))
import { draftMime, findApprovedDraft, matchesDraft, matchesMessage, updateApprovedDraft, type Approved } from './gmailDrafts'
import { findSentDraft, sendApprovedDraft } from './gmailSending'
import { matchesNormalizedKnownPreimage } from './gmailDraftPreimage'

const id = 'known-sola-draft', accountEmail = 'parent@example.test'
const input = { to: 'school@example.test', subject: 'Re: Synthetic supplies', body: 'Hi,\n\nWe can bring  plates & cups.\nThanks!\tParent' }
const replyRouting = { threadId: 'source-thread', inReplyTo: '<source@school.example>', references: ['<earlier@school.example>', '<source@school.example>'], subject: input.subject }
const proof = (body: string, key: string): Approved => ({ accountEmail, input: { ...input, body }, replyRouting, operationKey: hash(key), approvedHash: gmailReplyHash({ ...input, body }, replyRouting) })
const a = proof(input.body, 'saved-A'), b = proof('Hi,\n\nWe can bring plates and cups.\nThanks!', 'update-B')
const options = { timeout: 10000, retry: false, maxContentLength: 1024 * 1024 }
const headers = (mime: string) => mime.replace(/\r\n[ \t]+/g, ' ').split('\r\n').map(line => ({ name: line.slice(0, line.indexOf(':')), value: line.slice(line.indexOf(':') + 1).trim() }))
const htmlFor = (p: Approved) => `<div dir="ltr">${p.input.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}<br></div>`
function normal(p: Approved) {
  const top = draftMime(p).split('\r\n\r\n')[0].replace(/X-Daymark-Draft-(?:Operation|Hash): [^\r]+\r\n/g, '').replace('Content-Type: text/plain; charset=UTF-8', 'Content-Type: multipart/alternative; boundary="synthetic-boundary"').replace('\r\nContent-Transfer-Encoding: base64', '')
  const part = (type: string, text: string): gmail_v1.Schema$MessagePart => ({ mimeType: type, headers: [{ name: 'Content-Type', value: `${type}; charset="UTF-8"` }], body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') } })
  const text = p.input.body.replace(/\n/g, '\r\n') + '\r\n', html = htmlFor(p)
  const message = { id: 'immutable-message', threadId: replyRouting.threadId, labelIds: ['DRAFT'] }
  const raw: gmail_v1.Schema$Draft = { id, message: { ...message, raw: Buffer.from(`${top}\r\n\r\n--synthetic-boundary\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${text}\r\n--synthetic-boundary\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n${html}\r\n--synthetic-boundary--\r\n`).toString('base64url') } }
  const full: gmail_v1.Schema$Draft = { id, message: { ...message, payload: { mimeType: 'multipart/alternative', headers: headers(top), body: { size: 0 }, parts: [part('text/plain', text), part('text/html', html)] } } }
  return { raw, full }
}
const strictDraft = (p: Approved): gmail_v1.Schema$Draft => ({ id, message: { id: 'new-immutable-message', threadId: replyRouting.threadId, labelIds: ['DRAFT'], raw: Buffer.from(draftMime(p)).toString('base64url') } })
const controls = () => ({ permitted: vi.fn(async () => true), dispatch: vi.fn(async () => true), recordId: vi.fn(async (_id: string) => {}) })
let saved: ReturnType<typeof normal>
beforeEach(() => {
  vi.resetAllMocks(); saved = normal(a)
  mocks.profile.mockResolvedValue({ data: { emailAddress: accountEmail } })
  mocks.update.mockResolvedValue({ data: { id } }); mocks.send.mockResolvedValue({ data: { id: 'sent-id' } })
  mocks.get.mockImplementation(async ({ format }) => ({ data: format === 'full' ? saved.full : saved.raw }))
})
function setup(mode: 'update' | 'send') {
  const previous = mode === 'update' ? a : b, approved = mode === 'update' ? b : { ...b, operationKey: hash('send-C') }
  saved = normal(previous)
  let dispatched = false
  mocks.update.mockImplementation(async () => { dispatched = true; return { data: { id } } })
  mocks.get.mockImplementation(async ({ format }) => ({ data: dispatched ? strictDraft(approved) : format === 'full' ? saved.full : saved.raw }))
  mocks.messageGet.mockResolvedValue({ data: { ...strictDraft(approved).message, id: 'sent-id', labelIds: ['SENT'] } })
  const { accountEmail: _account, ...prior } = previous, value = { ...approved, gmailDraftId: id, previous: prior }
  return { previous, approved, value, run: (c = controls()) => mode === 'update' ? updateApprovedDraft({} as any, value, c) : sendApprovedDraft({} as any, value, c) }
}
it.each(['update', 'send'] as const)('allows only exact known-draft normalization before %s, retains one dispatch/ID, and sends canonical approved MIME', async mode => {
  const f = setup(mode), c = controls(), calls: string[] = []
  mocks.get.mockImplementation(async ({ format }) => { calls.push(format); return { data: mode === 'update' && c.recordId.mock.calls.length ? strictDraft(f.approved) : format === 'full' ? saved.full : saved.raw } })
  c.dispatch.mockImplementation(async () => { calls.push('dispatch'); return true }); c.recordId.mockImplementation(async () => { calls.push('record') })
  expect(await f.run(c)).toEqual({ id: mode === 'update' ? id : 'sent-id', verified: true })
  expect(calls).toEqual(mode === 'update' ? ['raw', 'full', 'dispatch', 'record', 'raw'] : ['raw', 'full', 'dispatch', 'record'])
  expect(c.dispatch).toHaveBeenCalledTimes(1); expect(c.recordId).toHaveBeenCalledTimes(1)
  const write = mode === 'update' ? mocks.update : mocks.send
  expect(write).toHaveBeenCalledTimes(1)
  expect(write.mock.calls[0][0].requestBody).toEqual({ id, message: { raw: Buffer.from(draftMime(f.approved)).toString('base64url'), threadId: replyRouting.threadId } })
  expect(mocks.get.mock.calls[1]).toEqual([{ userId: 'me', id, format: 'full', fields: 'id,message(id,threadId,labelIds,payload)' }, options])
  expect(mocks.list).not.toHaveBeenCalled()
})
it.each(['update', 'send'] as const)('keeps strict %s preimage on its existing one-read fast path', async mode => {
  const f = setup(mode), c = controls()
  mocks.get.mockImplementation(async () => ({ data: strictDraft(c.recordId.mock.calls.length ? f.approved : f.previous) }))
  expect((await f.run(c)).verified).toBe(true)
  expect(mocks.get.mock.calls.map(call => call[0].format)).toEqual(mode === 'update' ? ['raw', 'raw'] : ['raw'])
})
it.each(['update', 'send'] as const)('rejects a SENT label before %s even when the raw MIME still passes the global strict verifier', async mode => {
  const f = setup(mode), c = controls(), before = strictDraft(f.previous)
  before.message!.labelIds = ['DRAFT', 'SENT']
  mocks.get.mockResolvedValue({ data: before })
  await expect(f.run(c)).rejects.toThrow('changed outside Sola')
  expect(mocks.get).toHaveBeenCalledTimes(1); expect(c.dispatch).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it.each(['body space', 'body tab', 'body content', 'two terminal breaks', 'lone CR', 'HTML hidden', 'HTML style', 'HTML link', 'HTML comment', 'HTML signature', 'HTML whitespace', 'extra part', 'duplicate plain', 'duplicate HTML', 'nested parts', 'attachment', 'unsupported charset', 'unsupported encoding', 'invalid bytes', 'byte count', 'duplicate part header', 'part disposition', 'full ID', 'full message', 'full thread', 'full SENT', 'full recipients', 'full marker', 'full duplicate', 'oversize'] as const)('blocks normalized update before dispatch for changed %s', async change => {
  const f = setup('update'), c = controls(), payload = saved.full.message!.payload!, plain = payload.parts![0], html = payload.parts![1]
  const body = (p: gmail_v1.Schema$MessagePart, text: string) => { p.body = { data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text) } }
  if (change === 'body space') body(plain, a.input.body.replace('  ', ' '))
  if (change === 'body tab') body(plain, a.input.body.replace('\t', ' '))
  if (change === 'body content') body(plain, 'Changed outside Sola')
  if (change === 'two terminal breaks') body(plain, a.input.body + '\r\n\r\n')
  if (change === 'lone CR') body(plain, a.input.body + '\r')
  if (change === 'HTML hidden') body(html, `<div hidden>secret</div>${htmlFor(a)}`)
  if (change === 'HTML style') body(html, htmlFor(a).replace('dir="ltr"', 'style="color:black"'))
  if (change === 'HTML link') body(html, `<a href="https://example.test">${htmlFor(a)}</a>`)
  if (change === 'HTML comment') body(html, htmlFor(a) + '<!-- secret -->')
  if (change === 'HTML signature') body(html, htmlFor(a) + '<div>Signature</div>')
  if (change === 'HTML whitespace') body(html, htmlFor(a).replace('  ', ' '))
  if (change === 'extra part') payload.parts!.push({ mimeType: 'application/pdf' })
  if (change === 'duplicate plain') payload.parts = [plain, plain]
  if (change === 'duplicate HTML') payload.parts = [html, html]
  if (change === 'nested parts') html.parts = [{ mimeType: 'text/html' }]
  if (change === 'attachment') html.body!.attachmentId = 'not-read'
  if (change === 'unsupported charset') plain.headers![0].value = 'text/plain; charset=ISO-8859-1'
  if (change === 'unsupported encoding') plain.headers!.push({ name: 'Content-Transfer-Encoding', value: 'binary' })
  if (change === 'invalid bytes') plain.body = { data: Buffer.from([0xff]).toString('base64url'), size: 1 }
  if (change === 'byte count') plain.body!.size!++
  if (change === 'duplicate part header') plain.headers!.push(plain.headers![0])
  if (change === 'part disposition') html.headers!.push({ name: 'Content-Disposition', value: 'inline' })
  if (change === 'full ID') saved.full.id = 'other-draft'
  if (change === 'full message') saved.full.message!.id = 'other-message'
  if (change === 'full thread') saved.full.message!.threadId = 'other-thread'
  if (change === 'full SENT') saved.full.message!.labelIds = ['SENT', 'DRAFT']
  if (change === 'full recipients') payload.headers!.push({ name: 'Bcc', value: 'hidden@example.test' })
  if (change === 'full marker') payload.headers!.push({ name: 'X-Daymark-Draft-Hash', value: a.approvedHash })
  if (change === 'full duplicate') payload.headers!.push(payload.headers![0])
  if (change === 'oversize') body(html, 'x'.repeat(200000))
  await expect(f.run(c)).rejects.toThrow('changed outside Sola')
  expect(c.dispatch).not.toHaveBeenCalled(); expect(c.recordId).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it.each(['operation marker', 'approval marker', 'both wrong markers', 'duplicate marker', 'duplicate header', 'To', 'Cc', 'Bcc', 'Resent-To', 'thread', 'parent', 'references', 'subject', 'sender', 'ID', 'label', 'legacy standalone', 'multipart mixed'] as const)('refuses changed raw %s without the extra full read', async change => {
  const f = setup('update'), c = controls()
  let mime = Buffer.from(saved.raw.message!.raw!, 'base64url').toString()
  if (change === 'operation marker' || change === 'both wrong markers') mime = `X-Daymark-Draft-Operation: ${hash('wrong')}\r\n${mime}`
  if (change === 'approval marker' || change === 'both wrong markers') mime = `X-Daymark-Draft-Hash: ${hash('wrong')}\r\n${mime}`
  if (change === 'duplicate marker') mime = `X-Daymark-Draft-Hash: ${a.approvedHash}\r\nX-Daymark-Draft-Hash: ${a.approvedHash}\r\n${mime}`
  if (change === 'duplicate header') mime = `To: ${input.to}\r\n${mime}`
  if (change === 'To') mime = mime.replace(input.to, 'changed@example.test')
  if (['Cc', 'Bcc', 'Resent-To'].includes(change)) mime = `${change}: hidden@example.test\r\n${mime}`
  if (change === 'parent') mime = mime.replace(replyRouting.inReplyTo, '<other@example.test>')
  if (change === 'references') mime = mime.replace('<earlier@school.example>', '<other@example.test>')
  if (change === 'subject') mime = mime.replace(/Subject: [^\r]+\r\n/, 'Subject: Changed\r\n')
  if (change === 'sender') mime = mime.replace(accountEmail, 'other@example.test')
  if (change === 'multipart mixed') mime = mime.replace('multipart/alternative', 'multipart/mixed')
  if (change === 'thread') saved.raw.message!.threadId = 'other-thread'
  if (change === 'ID') saved.raw.id = 'other-draft'
  if (change === 'label') saved.raw.message!.labelIds = ['DRAFT', 'SENT']
  if (change === 'legacy standalone') f.value.previous.replyRouting = undefined
  saved.raw.message!.raw = Buffer.from(mime).toString('base64url')
  await expect(f.run(c)).rejects.toThrow()
  expect(mocks.get.mock.calls.map(call => call[0].format)).toEqual(['raw']); expect(c.dispatch).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
})
it.each(['update', 'send'] as const)('rechecks permission after each fallback read before %s and never dispatches after revocation', async mode => {
  for (const stage of ['raw', 'full']) {
    const f = setup(mode), c = controls(); let allowed = true
    c.permitted.mockImplementation(async () => allowed)
    mocks.get.mockImplementation(async ({ format }) => { if (format === stage) allowed = false; return { data: format === 'full' ? saved.full : saved.raw } })
    await expect(f.run(c)).rejects.toThrow('approval changed')
    expect(c.dispatch).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.get.mock.calls.filter(call => call[0].format === 'full').length).toBe(stage === 'raw' ? 0 : 1)
    mocks.get.mockClear()
  }
})
it('never turns normalized MIME into global verification, post-update success, or known/unknown-ID recovery', async () => {
  const f = setup('update'), c = controls()
  expect(matchesDraft(saved.raw, a, id)).toBe(false); expect(matchesNormalizedKnownPreimage(saved.raw, saved.full, a, id)).toBe(true)
  mocks.get.mockImplementation(async ({ format }) => ({ data: format === 'full' ? saved.full : c.recordId.mock.calls.length ? normal(b).raw : saved.raw }))
  expect(await f.run(c)).toEqual({ id, verified: false })
  mocks.get.mockClear().mockImplementation(async () => ({ data: saved.raw })); mocks.list.mockResolvedValue({ data: { drafts: [{ id }] } })
  expect(await findApprovedDraft({} as any, a, async () => true)).toEqual({ verified: false })
  expect(await findApprovedDraft({} as any, { ...a, gmailDraftId: id }, async () => true)).toEqual({ id, verified: false })
  expect(mocks.get.mock.calls.every(call => call[0].format === 'raw')).toBe(true)
  expect(mocks.update).toHaveBeenCalledTimes(1)
})
it('leaves a normalized SENT copy unverified and does not use the fallback during unknown-ID SENT recovery', async () => {
  const f = setup('send'), normalized = normal(f.approved).raw.message!
  normalized.id = 'sent-id'; normalized.labelIds = ['SENT']
  mocks.messageGet.mockResolvedValue({ data: normalized })
  expect(matchesMessage(normalized, f.approved)).toBe(false)
  expect(await f.run()).toEqual({ id: 'sent-id', verified: false })
  mocks.get.mockClear(); mocks.threadGet.mockResolvedValue({ data: { id: replyRouting.threadId, messages: [{ id: 'sent-id', labelIds: ['SENT'] }] } })
  expect(await findSentDraft({} as any, f.value, async () => true)).toEqual({ verified: false })
  expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.send).toHaveBeenCalledTimes(1)
})
it('permits only exact line endings or one added terminal line break, preserving spaces, tabs and blank paragraphs', () => {
  expect(plainDraftBodyMatches('a\r\nb\r\n', 'a\nb')).toBe(true)
  for (const value of ['a\nb\n\n', 'a\nb \n', 'a\nb\t\n', 'a\rb', 'a\n\nb']) expect(plainDraftBodyMatches(value, 'a\nb')).toBe(false)
})
it.each(['update', 'send'] as const)('does not replay an ambiguous %s after accepting the narrow preimage', async mode => {
  const f = setup(mode), c = controls(), write = mode === 'update' ? mocks.update : mocks.send
  write.mockRejectedValue(new Error('synthetic timeout after dispatch'))
  await expect(f.run(c)).rejects.toThrow('timeout')
  expect(c.dispatch).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1); expect(c.recordId).not.toHaveBeenCalled()
  expect(mocks.get.mock.calls.map(call => call[0].format)).toEqual(['raw', 'full']); expect(mocks.messageGet).not.toHaveBeenCalled()
})
it.each(['update', 'send'] as const)('does not dispatch %s or retry when the extra full read fails', async mode => {
  const f = setup(mode), c = controls()
  mocks.get.mockImplementation(async ({ format }) => { if (format === 'full') throw new Error('synthetic read failure'); return { data: saved.raw } })
  await expect(f.run(c)).rejects.toThrow('read failure')
  expect(c.dispatch).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.get.mock.calls.map(call => call[0].format)).toEqual(['raw', 'full'])
})
