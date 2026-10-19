// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import type { gmail_v1 } from '@googleapis/gmail'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { gmailComposeScope } from '../shared/mailbox'
import { gmailReadScope } from '../shared/emailWatches'
import { gmailReplyHash } from '../shared/gmailReply'
import { hash, sourceHash } from '../shared/daymark'
import { seal } from './googleCrypto'
const mocks = vi.hoisted(() => ({ profile: vi.fn(), get: vi.fn(), update: vi.fn(), create: vi.fn(), send: vi.fn(), list: vi.fn(), auth: undefined as unknown }))
vi.mock('@googleapis/gmail', () => ({ gmail: ({ auth }: { auth: unknown }) => { mocks.auth = auth; return { users: { getProfile: mocks.profile, drafts: { get: mocks.get, create: mocks.create, update: mocks.update, send: mocks.send, list: mocks.list } } } } }))
import { draftMime, diagnoseKnown } from './gmailDrafts'
import { draftDiagnosticSummary } from './gmailDraftDiagnosticSummary'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2027-05-05T08:00:00Z')
const input = { to: 'school@example.test', subject: 'Re: Synthetic picnic', body: 'Hi,\n\nWe can bring plates.\nThanks!' }
const routing = { threadId: 'synthetic-thread', inReplyTo: '<notice@school.example>', references: ['<notice@school.example>'], subject: input.subject }
const previous = { accountEmail: 'parent@example.test', input, replyRouting: routing, operationKey: hash('old-operation'), approvedHash: gmailReplyHash(input, routing) }
const pending = { ...previous, input: { ...input, body: 'We can bring plates and cups.' }, operationKey: hash('pending-operation'), approvedHash: gmailReplyHash({ ...input, body: 'We can bring plates and cups.' }, routing) }
let raw: ReturnType<typeof rawDraft>, full: ReturnType<typeof fullDraft>
const rawDraft = (mime = draftMime(previous)) => ({ id: 'known-draft', message: { id: 'current-message', threadId: routing.threadId, labelIds: ['DRAFT'], raw: Buffer.from(mime).toString('base64url') } })
const fullDraft = (body = input.body) => ({ id: 'known-draft', message: { id: 'current-message', threadId: routing.threadId, labelIds: ['DRAFT'], payload: { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url'), size: Buffer.byteLength(body) } } as gmail_v1.Schema$MessagePart } })
const htmlPart = (body: string): gmail_v1.Schema$MessagePart => ({ mimeType: 'text/html', body: { data: Buffer.from(body).toString('base64url'), size: Buffer.byteLength(body) } })
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks()
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', previous.accountEmail)
  vi.stubEnv('PROVIDER_TOKEN_KEY_ID', 'synthetic'); vi.stubEnv('PROVIDER_TOKEN_KEYS', JSON.stringify({ synthetic: randomBytes(32).toString('base64') }))
  raw = rawDraft(); full = fullDraft()
  mocks.profile.mockResolvedValue({ data: { emailAddress: previous.accountEmail } })
  mocks.get.mockImplementation(async ({ format }) => ({ data: format === 'raw' ? raw : full }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
async function fixture() {
  const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const ids = await t.run(async ctx => {
    const cipher = seal({ access_token: 'SYNTHETIC_ACCESS_TOKEN', refresh_token: 'SYNTHETIC_REFRESH_TOKEN', expiry_date: now + 3600000 }, `${householdId}:test|parent`)
    const connectionId = await ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', email: previous.accountEmail, status: 'active', version: 1, scopes: [gmailReadScope, gmailComposeScope], cipher })
    const accountKey = sourceHash(JSON.stringify([connectionId, previous.accountEmail]))
    const mailboxId = await ctx.db.insert('mailboxes', { householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now })
    const messageId = await ctx.db.insert('mailMessages', { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: 'synthetic-source', threadId: routing.threadId, replyRouting: routing, sender: input.to, subject: input.subject, text: 'Synthetic source', receivedAt: now - 1000, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'], version: 1, contentHash: 'source-hash', dismissed: false, expiresAt: now + 86400000 })
    const { accountEmail, ...old } = previous
    const draftId = await ctx.db.insert('mailDrafts', { householdId, createdBy: 'test|parent', messageId, mailboxId, sourceVersion: 1, sourceHash: 'source-hash', connectionId, connectionVersion: 1, accountKey, accountEmail, version: 7, input: pending.input, replyRouting: routing, instruction: 'Synthetic instruction', preparationKey: 'synthetic', status: 'failed', previous: old, gmailDraftId: 'known-draft', writeMode: 'update', operationKey: pending.operationKey, approvedHash: pending.approvedHash, approvedAt: now - 1200000, createdAt: now - 1200000, expiresAt: now + 86400000 })
    return { connectionId, mailboxId, messageId, draftId }
  })
  const inspect = () => t.action(internal.gmailDrafts.diagnoseKnown, { id: ids.draftId, version: 7 })
  return { t, householdId, ...ids, inspect }
}
it('reads only profile and known raw/full draft, reports all static comparisons, and leaves every record untouched despite expired write approval', async () => {
  const f = await fixture(), before = await f.t.run(async ctx => ({ d: await ctx.db.get(f.draftId), c: await ctx.db.get(f.connectionId), m: await ctx.db.get(f.mailboxId) }))
  const refresh = vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken')
  const result = await f.inspect()
  expect(result).toMatchObject({ diagnosticOnly: true, status: 'complete', approvalCurrent: false, accountMatches: true, crossReadMessageIdentity: true, markers: { operation: { count: 'single', matchesPrevious: true, matchesPending: false } }, strict: { previous: null, pending: 'operation_marker' }, previous: { recipient: true, subject: true, plainBodyExact: true }, pending: { plainBodyExact: false } })
  expect(mocks.profile).toHaveBeenCalledTimes(1); expect(mocks.get.mock.calls.map(c => c[0].format)).toEqual(['raw', 'full'])
  for (const [, options] of [...mocks.profile.mock.calls, ...mocks.get.mock.calls]) expect(options).toEqual({ timeout: 10000, retry: false, maxContentLength: 1024 * 1024 })
  expect((mocks.auth as OAuth2Client).credentials).toEqual({ access_token: 'SYNTHETIC_ACCESS_TOKEN' }); expect(refresh).not.toHaveBeenCalled()
  expect(await f.t.run(async ctx => ({ d: await ctx.db.get(f.draftId), c: await ctx.db.get(f.connectionId), m: await ctx.db.get(f.mailboxId) }))).toEqual(before)
  for (const fn of [mocks.update, mocks.create, mocks.send, mocks.list]) expect(fn).not.toHaveBeenCalled()
  expect((diagnoseKnown as unknown as { isInternal: boolean }).isInternal).toBe(true)
  const text = JSON.stringify(result)
  for (const secret of [input.to, input.body, previous.accountEmail, previous.operationKey, previous.approvedHash, 'SYNTHETIC_ACCESS_TOKEN', 'SYNTHETIC_REFRESH_TOKEN', 'known-draft', 'current-message', routing.threadId]) expect(text).not.toContain(secret)
})
it.each(['missing', 'different', 'duplicate'] as const)('distinguishes %s markers while independently reporting changed recipient/body and never logging MIME', async change => {
  const f = await fixture(), sentinel = 'SYNTHETIC_PRIVATE_BODY'
  let mime = draftMime(previous).replace(`To: ${input.to}`, 'To: changed@example.test')
  if (change === 'missing') mime = mime.replace(/X-Daymark-Draft-Operation: [^\r]+\r\n/, '').replace(/X-Daymark-Draft-Hash: [^\r]+\r\n/, '')
  if (change === 'different') mime = mime.replace(`X-Daymark-Draft-Operation: ${previous.operationKey}`, `X-Daymark-Draft-Operation: ${hash('other')}`).replace(`X-Daymark-Draft-Hash: ${previous.approvedHash}`, `X-Daymark-Draft-Hash: ${hash('other-body')}`)
  if (change === 'duplicate') mime = `X-Daymark-Draft-Operation: ${previous.operationKey}\r\n${mime}`
  raw = rawDraft(mime); full = fullDraft(sentinel)
  const logged = vi.spyOn(console, 'info'), result = await f.inspect()
  expect(result).toMatchObject({ status: 'complete', markers: { operation: { count: change === 'duplicate' ? 'duplicate' : change === 'missing' ? 'missing' : 'single', matchesPrevious: false, matchesPending: false } }, previous: { recipient: false, plainBodyExact: false }, pending: { plainBodyExact: false } })
  expect(JSON.stringify(result)).not.toContain(sentinel); expect(logged).not.toHaveBeenCalled()
})
it('flags multipart HTML/attachments and does not mistake normalized extracted text for exact plain body equivalence', async () => {
  const f = await fixture()
  full.message.payload = { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hi, We can bring plates. Thanks!').toString('base64url') } }, { mimeType: 'text/html', body: { data: Buffer.from('<p>Different HTML</p>').toString('base64url') } }, { mimeType: 'application/pdf', filename: 'PRIVATE_FILENAME.pdf', body: { attachmentId: 'PRIVATE_ATTACHMENT', size: 3 } }] }
  const result = await f.inspect()
  expect(result).toMatchObject({ status: 'complete', mime: { htmlPartPresent: true }, extraction: { complete: false, unreadAttachments: true }, previous: { plainBodyExact: false, extractedTextMatches: null } })
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_FILENAME|PRIVATE_ATTACHMENT|Different HTML/)
})
it.each(['\r\n', '\n\n', '\r\n\r\n'])('identifies terminal line breaks alone without changing exact comparison (%j)', async suffix => {
  const f = await fixture(); full = fullDraft(input.body + suffix)
  full.message.payload = { mimeType: 'multipart/alternative', parts: [full.message.payload, htmlPart(input.body.replace(/\n/g, '<br>'))] }
  const result = await f.inspect()
  expect(result).toMatchObject({ diagnosticOnly: true, previous: { plainBodyExact: false, plainBodyIgnoringTerminalLineBreaksMatches: true, htmlVisibleTextMatches: true, htmlSimplePlainRepresentationMatches: true }, pending: { plainBodyIgnoringTerminalLineBreaksMatches: false, htmlVisibleTextMatches: false, htmlSimplePlainRepresentationMatches: false }, mime: { htmlPartCount: 1, htmlExtractionIncomplete: false } })
  expect(JSON.stringify(result)).not.toContain(input.body)
})
it.each([input.body + ' \r\n', input.body + '\t\n', input.body.replace('bring plates', 'bring  plates'), input.body.replace('bring plates', 'bring\tplates')])('preserves sensitive spaces/tabs in terminal-line-break comparison (%#)', async body => {
  const f = await fixture(); full = fullDraft(body)
  expect(await f.inspect()).toMatchObject({ previous: { plainBodyExact: false, plainBodyIgnoringTerminalLineBreaksMatches: false, extractedTextMatches: true, htmlVisibleTextMatches: null }, mime: { htmlPartCount: 0, htmlExtractionIncomplete: false } })
})
it('labels HTML visible-text matches as lossy diagnostic comparisons even when hidden content is excluded', async () => {
  const f = await fixture()
  full.message.payload = { mimeType: 'multipart/alternative', parts: [full.message.payload, htmlPart(`<div hidden>SYNTHETIC_PRIVATE_HIDDEN</div>${input.body.replace(/\n/g, '<br>')}`)] }
  const result = await f.inspect()
  expect(result).toMatchObject({ diagnosticOnly: true, previous: { htmlVisibleTextMatches: true, htmlSimplePlainRepresentationMatches: false }, mime: { htmlPartCount: 1, htmlExtractionIncomplete: false } })
  expect(result).not.toHaveProperty('verified'); expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_HIDDEN')
})
it('reports HTML differences independently of the preferred plain alternative', async () => {
  const f = await fixture()
  full.message.payload = { mimeType: 'multipart/alternative', parts: [full.message.payload, htmlPart('SYNTHETIC_PRIVATE_CHANGED_HTML')] }
  const result = await f.inspect()
  expect(result).toMatchObject({ extraction: { complete: true, format: 'plain' }, previous: { plainBodyExact: true, htmlVisibleTextMatches: false }, mime: { htmlPartCount: 1, htmlExtractionIncomplete: false } })
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_CHANGED_HTML')
})
it('refuses structural matches when an otherwise simple HTML representation has an unread sibling attachment', async () => {
  const f = await fixture()
  full.message.payload = { mimeType: 'multipart/mixed', parts: [full.message.payload, htmlPart(input.body.replace(/\n/g, '<br>')), { mimeType: 'application/pdf', filename: 'private.pdf', body: { attachmentId: 'not-read' } }] }
  expect(await f.inspect()).toMatchObject({ previous: { htmlVisibleTextMatches: true, htmlSimplePlainRepresentationMatches: false }, extraction: { complete: false, unreadAttachments: true } })
})
it.each(['<link rel="stylesheet" href="https://example.test/private.css">', '<span style="display:none;display:block">Unclear visibility</span>', '<div>'.repeat(81)])('withholds HTML matches when bounded extraction cannot establish visible text (%#)', async prefix => {
  const f = await fixture()
  full.message.payload = { mimeType: 'multipart/alternative', parts: [full.message.payload, htmlPart(prefix + input.body.replace(/\n/g, '<br>'))] }
  expect(await f.inspect()).toMatchObject({ previous: { htmlVisibleTextMatches: null, htmlSimplePlainRepresentationMatches: false }, pending: { htmlVisibleTextMatches: null, htmlSimplePlainRepresentationMatches: false }, mime: { htmlPartCount: 1, htmlExtractionIncomplete: true } })
})
it('refuses to select among multiple HTML alternatives even if every extracted text matches', async () => {
  const f = await fixture(), html = htmlPart(input.body.replace(/\n/g, '<br>'))
  full.message.payload = { mimeType: 'multipart/alternative', parts: [full.message.payload, html, html] }
  expect(await f.inspect()).toMatchObject({ previous: { htmlVisibleTextMatches: null, htmlSimplePlainRepresentationMatches: false }, mime: { htmlPartCount: 2, htmlExtractionIncomplete: false } })
})
it('marks incomplete structure and withholds both body comparisons after the MIME part limit', async () => {
  const f = await fixture()
  full.message.payload = { mimeType: 'multipart/alternative', parts: [full.message.payload, htmlPart(input.body.replace(/\n/g, '<br>')), ...Array.from({ length: 100 }, () => ({ mimeType: 'application/octet-stream' }))] }
  expect(await f.inspect()).toMatchObject({ previous: { plainBodyIgnoringTerminalLineBreaksMatches: null, htmlVisibleTextMatches: null, htmlSimplePlainRepresentationMatches: false }, mime: { structureBounded: true, htmlPartCount: 1, htmlExtractionIncomplete: true } })
})
const escapedText = 'Hello &amp; &lt;friends&gt; "today" \'yes\'<br>Keep  two spaces\tand tabs'
function structuralSummary(html: string) {
  const proofInput = { ...input, body: 'Hello & <friends> "today" \'yes\'\nKeep  two spaces\tand tabs' }, proof = { ...previous, input: proofInput, approvedHash: gmailReplyHash(proofInput, routing) }
  const parsed = fullDraft(); parsed.message.payload = { mimeType: 'multipart/alternative', parts: [htmlPart(html)] }
  return draftDiagnosticSummary(rawDraft(draftMime(proof)), parsed, 'known-draft', proof, pending, { previous: null, pending: 'operation_marker' })
}
it.each([
  escapedText,
  `<div>${escapedText}</div>`,
  `<div dir="ltr">${escapedText}<br></div>\r\n`,
  `<div dir="auto">${escapedText.replace(/<br>/g, '<br/>')}<br/></div>`,
  `${escapedText.replace(/<br>/g, '<br />')}<br />\n`,
  escapedText.replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
])('recognizes only explicit escaped plaintext serialization templates (%#)', html => {
  const result = structuralSummary(html)
  expect(result).toMatchObject({ diagnosticOnly: true, previous: { htmlSimplePlainRepresentationMatches: true }, pending: { htmlSimplePlainRepresentationMatches: false } })
  expect(JSON.stringify(result)).not.toContain('friends'); expect(result).not.toHaveProperty('verified')
})
it.each([
  `<div style="color:black">${escapedText}</div>`,
  `<div class="gmail_default">${escapedText}</div>`,
  `<div dir="rtl">${escapedText}</div>`,
  `<div dir="ltr" hidden>${escapedText}</div>`,
  `<div aria-hidden="true">Hidden</div>${escapedText}`,
  `<strong>${escapedText}</strong>`,
  `<a href="https://example.test">${escapedText}</a>`,
  `${escapedText}<img src="https://example.test/pixel">`,
  `${escapedText}<!-- private comment -->`,
  `${escapedText}<div class="gmail_signature">Signature</div>`,
  escapedText.replace('Keep  two', 'Keep two'),
  escapedText.replace('\t', ' '),
  escapedText.replace('  ', '&nbsp; '),
  escapedText.replace(/<br>/g, '\n'),
  `${escapedText} <br>`,
  `<div>${escapedText}<br><br></div>`,
  `<div>\n${escapedText}</div>`,
])('refuses additional HTML structure, attributes, assets, hidden text, or changed whitespace (%#)', html => {
  expect(structuralSummary(html).previous.htmlSimplePlainRepresentationMatches).toBe(false)
})
it.each(['environment', 'allowlist', 'version', 'member', 'owner', 'mailbox', 'connection', 'read permission', 'compose permission', 'source', 'proof'] as const)('refuses %s changes before provider reads', async change => {
  const f = await fixture()
  if (change === 'environment') vi.stubEnv('DAYMARK_ENVIRONMENT', 'production')
  if (change === 'allowlist') vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', '')
  await f.t.run(async ctx => {
    if (change === 'version') await ctx.db.patch(f.draftId, { version: 8 })
    if (change === 'member') await ctx.db.delete((await ctx.db.query('memberships').first())!._id)
    if (change === 'owner') await ctx.db.patch(f.draftId, { createdBy: 'test|other' })
    if (change === 'mailbox') await ctx.db.patch(f.mailboxId, { state: 'paused' })
    if (change === 'connection') await ctx.db.patch(f.connectionId, { version: 2 })
    if (change === 'read permission' || change === 'compose permission') await ctx.db.patch(f.connectionId, { scopes: [change === 'read permission' ? gmailComposeScope : gmailReadScope] })
    if (change === 'source') await ctx.db.patch(f.messageId, { version: 2 })
    if (change === 'proof') await ctx.db.patch(f.draftId, { approvedHash: hash('wrong') })
  })
  expect(await f.inspect()).toMatchObject({ status: 'unavailable' }); expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled()
})
it('refuses expired credentials without refresh, leases or provider reads', async () => {
  const f = await fixture()
  await f.t.run(async ctx => { const c = (await ctx.db.get(f.connectionId))!; await ctx.db.patch(c._id, { cipher: seal({ access_token: 'synthetic', refresh_token: 'must-not-refresh', expiry_date: now + 120000 }, `${c.householdId}:${c.subject}`) }) })
  expect(await f.inspect()).toMatchObject({ status: 'credentials_expired' }); expect(mocks.profile).not.toHaveBeenCalled()
})
it('stops after account mismatch and after revocation between raw and full reads', async () => {
  const f = await fixture()
  mocks.profile.mockResolvedValue({ data: { emailAddress: 'other@example.test' } })
  expect(await f.inspect()).toMatchObject({ status: 'account_mismatch' }); expect(mocks.get).not.toHaveBeenCalled()
  mocks.profile.mockResolvedValue({ data: { emailAddress: previous.accountEmail } })
  mocks.get.mockImplementation(async () => { await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked' })); return { data: raw } })
  expect(await f.inspect()).toMatchObject({ status: 'read_stopped' }); expect(mocks.get).toHaveBeenCalledTimes(1)
})
it('flags concurrent replacement and thread changes between reads without treating any comparison as verification', async () => {
  const f = await fixture(); full.message.id = 'replacement-message'; full.message.threadId = 'changed-thread'
  expect(await f.inspect()).toMatchObject({ status: 'complete', crossReadMessageIdentity: false, thread: { crossRead: false } })
})
it('reports missing markers independently of subject, extra recipients, and exact versus normalized body differences', async () => {
  const f = await fixture()
  raw = rawDraft(draftMime(previous).replace(/X-Daymark-Draft-Operation: [^\r]+\r\n/, '').replace(/Subject: [^\r]+\r\n/, 'Subject: Changed subject\r\n').replace('To: ', 'Cc: hidden@example.test\r\nTo: '))
  full = fullDraft(input.body.replace('bring plates', 'bring  plates'))
  const result = await f.inspect()
  expect(result).toMatchObject({ status: 'complete', strict: { previous: 'operation_marker' }, additionalRecipientHeaders: true, previous: { recipient: true, subject: false, plainBodyExact: false, extractedTextMatches: true } })
  expect(JSON.stringify(result)).not.toContain('hidden@example.test')
})
it('stops when the bound approval snapshot changes between reads without modifying its dispatch state', async () => {
  const f = await fixture()
  mocks.get.mockImplementation(async () => { await f.t.run(ctx => ctx.db.patch(f.draftId, { version: 8 })); return { data: raw } })
  expect(await f.inspect()).toMatchObject({ status: 'read_stopped' }); expect(mocks.get).toHaveBeenCalledTimes(1)
  expect((await f.t.run(ctx => ctx.db.get(f.draftId)))?.dispatchedAt).toBeUndefined()
})
it('does not emit a payload or raw header values when provider data exceeds the diagnostic bound', async () => {
  const f = await fixture(); full = fullDraft('SYNTHETIC_PRIVATE_BODY'.repeat(10000))
  expect(await f.inspect()).toEqual({ diagnosticOnly: true, status: 'payload_limit', approvalCurrent: false })
  expect(mocks.get).toHaveBeenCalledTimes(2)
})
it('refuses malformed encrypted credential contents without throwing or contacting Gmail', async () => {
  const f = await fixture()
  await f.t.run(async ctx => { const c = (await ctx.db.get(f.connectionId))!; await ctx.db.patch(c._id, { cipher: seal(null, `${c.householdId}:${c.subject}`) }) })
  expect(await f.inspect()).toEqual({ diagnosticOnly: true, status: 'credentials_unavailable' }); expect(mocks.profile).not.toHaveBeenCalled()
})
it('does not attempt token refresh or repeat a provider read after an unauthorized response', async () => {
  const f = await fixture(), refresh = vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken')
  mocks.get.mockRejectedValue(Object.assign(new Error('PRIVATE_PROVIDER_401'), { response: { status: 401 } }))
  expect(await f.inspect()).toMatchObject({ status: 'read_stopped' }); expect(refresh).not.toHaveBeenCalled(); expect(mocks.get).toHaveBeenCalledTimes(1)
  expect((mocks.auth as OAuth2Client).refreshHandler).toBeUndefined()
})
it.each(['profile', 'raw', 'full'] as const)('enforces total deadline when %s finishes late', async stage => {
  const f = await fixture()
  if (stage === 'profile') mocks.profile.mockImplementation(async () => { vi.setSystemTime(now + 45000); return { data: { emailAddress: previous.accountEmail } } })
  else mocks.get.mockImplementation(async ({ format }) => { if (format === stage) vi.setSystemTime(now + 45000); return { data: format === 'raw' ? raw : full } })
  expect(await f.inspect()).toMatchObject({ status: 'read_stopped' }); expect(mocks.get.mock.calls.length).toBeLessThanOrEqual(stage === 'profile' ? 0 : stage === 'raw' ? 1 : 2)
})
it('sanitizes provider exceptions and never retries a failed read', async () => {
  const f = await fixture(); mocks.get.mockRejectedValue(new Error('PRIVATE_PROVIDER_EXCEPTION_TOKEN'))
  expect(await f.inspect()).toEqual({ diagnosticOnly: true, status: 'read_stopped', approvalCurrent: false }); expect(mocks.get).toHaveBeenCalledTimes(1)
})
