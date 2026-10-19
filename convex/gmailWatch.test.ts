// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import { OAuth2Client } from 'google-auth-library'
import schema from './schema'
import { api, internal } from './_generated/api'
import { seal } from './googleCrypto'
import { gmailReadScope, watchIntervalMs } from '../shared/emailWatches'
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), send: vi.fn(), modify: vi.fn(), attachment: vi.fn(), auth: vi.fn() }))
vi.mock('@googleapis/gmail', () => ({ gmail: ({ auth }: { auth: unknown }) => { mocks.auth(auth); return { users: { messages: { ...mocks, attachments: { get: mocks.attachment } } } } } }))
import { readWatchBatch } from './gmailWatch'
const window = { senders: ['school@example.test'], from: 1000, through: 5000 }
const mail = (id = 'one', from = 'School <school@example.test>') => ({ id, internalDate: '2000', labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Trip reminder' }], body: { data: Buffer.from('Pack lunch.').toString('base64url') } } })
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('uses one filtered list and at most five reads; never sends, changes labels or retrieves attachments', async () => {
  mocks.list.mockResolvedValue({ data: { messages: Array.from({ length: 5 }, (_, i) => ({ id: String(i) })), nextPageToken: 'next' } })
  mocks.get.mockImplementation(async ({ id }) => ({ data: mail(id) }))
  const permitted = vi.fn(async () => true), result = await readWatchBatch({} as any, window, permitted)
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ userId: 'me', maxResults: 5, includeSpamTrash: false, q: expect.stringContaining('from:school@example.test') }), expect.objectContaining({ retry: false, timeout: 10000 }))
  expect(mocks.get).toHaveBeenCalledTimes(5); expect(permitted).toHaveBeenCalledTimes(6)
  expect(result.messages[0]).toMatchObject({ sender: 'school@example.test', text: 'Pack lunch.', truncated: false })
  expect(result.nextPageToken).toBe('next'); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.modify).not.toHaveBeenCalled()
})
it('rechecks consent before each message and ignores mismatched senders and excluded mailbox labels', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }, { id: 'two' }] } })
  mocks.get.mockResolvedValueOnce({ data: mail('one', 'unknown@example.test') })
  const allowed = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  await expect(readWatchBatch({} as any, window, allowed)).rejects.toThrow('stopped')
  expect(mocks.get).toHaveBeenCalledTimes(1)
  mocks.get.mockImplementation(async ({ id }) => ({ data: { ...mail(id), labelIds: ['TRASH'] } }))
  expect((await readWatchBatch({} as any, window, async () => true)).messages).toEqual([])
})
it('labels fallback previews or long content incomplete and never treats an attached text file as email body', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }] } })
  mocks.get.mockResolvedValue({ data: { ...mail(), snippet: 'Short preview', payload: { ...mail().payload, mimeType: 'multipart/mixed', body: undefined, parts: [{ mimeType: 'text/plain', filename: 'attachment.txt', body: { data: Buffer.from('Must not read attachment').toString('base64url') } }] } } })
  expect((await readWatchBatch({} as any, window, async () => true)).messages[0]).toMatchObject({ text: 'Short preview', truncated: true, extraction: { format: 'snippet', incomplete: true, attachments: true, truncated: false } })
  mocks.get.mockResolvedValue({ data: { ...mail(), payload: { ...mail().payload, body: { data: Buffer.from('a'.repeat(20000)).toString('base64url') } } } })
  const message = (await readWatchBatch({} as any, window, async () => true)).messages[0]
  expect(message.text).toHaveLength(16000); expect(message.truncated).toBe(true)
  expect(message.extraction).toMatchObject({ format: 'plain', incomplete: true, truncated: true, attachments: false })
  expect(mocks.attachment).not.toHaveBeenCalled()
})
it('reads a complete HTML newsletter instead of the snippet and preserves received time without fetching links', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }] } })
  const fetch = vi.spyOn(globalThis, 'fetch')
  try {
    mocks.get.mockResolvedValue({ data: { ...mail(), snippet: 'Field trip', payload: { ...mail().payload, mimeType: 'text/html', headers: [...mail().payload.headers, { name: 'Date', value: 'October 1, 2026' }], body: { data: Buffer.from('<style>.preview{display:none}</style><div class="preview">Old date Oct 10</div><p>Field trip Oct 12 at 9&#58;30 AM.</p><p>Return by 2:15 PM. <a href="http://127.0.0.1/private">Read details</a></p>').toString('base64url') } } } })
    const result = (await readWatchBatch({} as any, window, async () => true)).messages[0]
    expect(result).toMatchObject({ receivedAt: 2000, text: 'Field trip Oct 12 at 9:30 AM.\n\nReturn by 2:15 PM. Read details', truncated: false, extraction: { format: 'html', incomplete: false, truncated: false, attachments: false, issues: [] } })
    expect(mocks.attachment).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.modify).not.toHaveBeenCalled()
  } finally { fetch.mockRestore() }
})
it('never invents text from invalid UTF-8 or accepts a malformed internal date', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }] } })
  mocks.get.mockResolvedValue({ data: { ...mail(), snippet: 'Partial preview', payload: { ...mail().payload, body: { data: '_w' } } } })
  expect((await readWatchBatch({} as any, window, async () => true)).messages[0]).toMatchObject({ text: 'Partial preview', truncated: true, extraction: { format: 'snippet', incomplete: true, issues: expect.arrayContaining(['An email body section contains invalid UTF-8 text.']) } })
  for (const internalDate of ['2e3', '2000.5', '', '-2000', '9007199254740992']) {
    mocks.get.mockResolvedValue({ data: { ...mail(), internalDate } })
    expect((await readWatchBatch({} as any, window, async () => true)).messages).toEqual([])
  }
})
it('does not hide partial provider failures as a completed scan', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }, { id: 'two' }] } })
  mocks.get.mockResolvedValueOnce({ data: mail() }).mockRejectedValueOnce({ response: { status: 429 } })
  await expect(readWatchBatch({} as any, window, async () => true)).rejects.toMatchObject({ response: { status: 429 } })
})
it('returns only a bounded opaque Gmail thread identifier and requests it explicitly', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }] } })
  mocks.get.mockResolvedValue({ data: { ...mail(), threadId: 'thread-opaque-123' } })
  expect((await readWatchBatch({} as any, window, async () => true)).messages[0].threadId).toBe('thread-opaque-123')
  expect(mocks.get).toHaveBeenLastCalledWith(expect.objectContaining({ fields: expect.stringContaining('threadId') }), expect.anything())
  for (const threadId of ['', ' ', 'has\ncontrol', 'x'.repeat(201), '🌞'.repeat(101), 123, null]) {
    mocks.get.mockResolvedValue({ data: { ...mail(), threadId } })
    expect((await readWatchBatch({} as any, window, async () => true)).messages[0]).not.toHaveProperty('threadId')
  }
})
it('refuses oversized pages or mismatched message IDs rather than silently advancing past unread mail', async () => {
  mocks.list.mockResolvedValue({ data: { messages: Array.from({ length: 6 }, (_, i) => ({ id: String(i) })), nextPageToken: 'skip-unread' } })
  await expect(readWatchBatch({} as any, window, async () => true)).rejects.toThrow('more messages')
  expect(mocks.get).not.toHaveBeenCalled()
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'requested' }] } })
  mocks.get.mockResolvedValue({ data: mail('different') })
  await expect(readWatchBatch({} as any, window, async () => true)).rejects.toThrow('different message')
  mocks.list.mockResolvedValue({ data: { messages: [{ id: ' ' }] } })
  await expect(readWatchBatch({} as any, window, async () => true)).rejects.toThrow('invalid message identifier')
})
it('continues after a deleted message but does not discard later messages on that page', async () => {
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'deleted' }, { id: 'present' }], nextPageToken: 'page-two' } })
  mocks.get.mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValueOnce({ data: mail('present') })
  const result = await readWatchBatch({} as any, window, async () => true)
  expect(result.messages.map(m => m.id)).toEqual(['present']); expect(result.nextPageToken).toBe('page-two')
})

const modules = import.meta.glob('./**/*.ts')
async function fixture() {
  vi.stubEnv('PROVIDER_TOKEN_KEYS', JSON.stringify({ test: Buffer.alloc(32, 17).toString('base64') })); vi.stubEnv('PROVIDER_TOKEN_KEY_ID', 'test')
  vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-client'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-secret'); vi.stubEnv('CONVEX_SITE_URL', 'https://synthetic.convex.site')
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-only'); vi.stubEnv('DAYMARK_MODEL', 'synthetic-only')
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const otherHouseholdId = await other.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'parent@example.test', cipher: seal({ access_token: 'synthetic-parent-access', expiry_date: Date.now() + 3600000 }, `${householdId}:test|parent`) }))
  const otherConnectionId = await t.run(ctx => ctx.db.insert('connections', { householdId: otherHouseholdId, subject: 'test|other', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'other@example.test', cipher: seal({ access_token: 'synthetic-other-access', expiry_date: Date.now() + 3600000 }, `${otherHouseholdId}:test|other`) }))
  const watch = { requestId: 'synthetic-watch', title: 'School notices', senders: ['school@example.test'], instruction: 'Prepare school notice details for review.', consent: true as const }
  const id = await parent.mutation(api.emailWatches.create, { ...watch, connectionId })
  const otherId = await other.mutation(api.emailWatches.create, { ...watch, connectionId: otherConnectionId })
  return { t, parent, other, householdId, otherHouseholdId, connectionId, otherConnectionId, id, otherId, through: Date.now() }
}
const error = (status: number, reason: string, message = reason) => ({ response: { status, data: { error: { message, errors: [{ reason, message }] } } } })

it('retries documented Gmail quota 403s without revoking account access or advancing the scan', async () => {
  for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']) {
    const f = await fixture()
    mocks.list.mockRejectedValue(error(403, reason))
    await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
    expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ state: 'active', nextCheckAt: Date.now() + watchIntervalMs })
    expect((await f.t.run(ctx => ctx.db.get(f.id)))?.lastCheckedAt).toBeUndefined()
    expect(await f.t.run(ctx => ctx.db.get(f.connectionId))).toMatchObject({ status: 'active', version: 1 })
  }
  expect(mocks.get).not.toHaveBeenCalled()
})
it('requires attention for real permission errors and leaves transient server failures retryable', async () => {
  for (const [status, reason, blocked] of [[401, 'authError', true], [403, 'insufficientPermissions', true], [403, 'domainPolicy', true], [429, 'rateLimitExceeded', false], [503, 'backendError', false]] as const) {
    const f = await fixture()
    mocks.list.mockRejectedValue(error(status, reason))
    await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
    expect((await f.t.run(ctx => ctx.db.get(f.id)))?.state).toBe(blocked ? 'blocked' : 'active')
    expect((await f.t.run(ctx => ctx.db.get(f.id)))?.lastCheckedAt).toBeUndefined()
  }
})
it('resets only invalid pagination cursors while retaining the entire unfinished time window', async () => {
  for (const rejected of [error(400, 'invalidArgument', 'Invalid page token'), error(400, 'badRequest', 'The pageToken has expired')]) {
    const f = await fixture(), from = f.through - 10000
    await f.t.run(ctx => ctx.db.patch(f.id, { pageToken: 'expired-cursor', windowFrom: from, windowThrough: f.through }))
    mocks.list.mockRejectedValue(rejected)
    await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
    const saved = await f.t.run(ctx => ctx.db.get(f.id))
    expect(saved).toMatchObject({ state: 'active', windowFrom: from, windowThrough: f.through })
    expect(saved?.pageToken).toBeUndefined(); expect(saved?.lease).toBeUndefined(); expect(saved?.lastCheckedAt).toBeUndefined()
    expect(await f.t.run(ctx => ctx.db.get(f.connectionId))).toMatchObject({ status: 'active', version: 1 })
  }
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.id, { pageToken: 'still-valid' }))
  mocks.list.mockRejectedValue(error(400, 'invalidArgument', 'Invalid query filter'))
  await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ state: 'blocked', pageToken: 'still-valid' })
})
it('recovers a repeated provider cursor instead of polling that same page forever', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.id, { pageToken: 'looping-cursor', windowFrom: f.through - 10000, windowThrough: f.through }))
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }], nextPageToken: 'looping-cursor' } })
  await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
  const watch = await f.t.run(ctx => ctx.db.get(f.id))
  expect(watch).toMatchObject({ state: 'active', windowFrom: f.through - 10000, windowThrough: f.through })
  expect(watch?.pageToken).toBeUndefined(); expect(watch?.lastCheckedAt).toBeUndefined()
  expect(mocks.get).not.toHaveBeenCalled()
})
it('recovers partial pages by retrying their cursor, deduplicates repeats, and advances only after the final page', async () => {
  const f = await fixture(), message = (id: string) => ({ ...mail(id), internalDate: String(f.through - 1000) })
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'one' }, { id: 'two' }], nextPageToken: 'page-two' } })
  mocks.get.mockResolvedValueOnce({ data: message('one') }).mockRejectedValueOnce(error(503, 'backendError'))
  await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
  expect(await f.t.run(ctx => ctx.db.query('emailWatchMessages').collect())).toHaveLength(0)
  vi.setSystemTime(Date.now() + watchIntervalMs)
  mocks.get.mockImplementation(async ({ id }) => ({ data: message(id) }))
  await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.pageToken).toBe('page-two')
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.lastCheckedAt).toBeUndefined()
  vi.setSystemTime(Date.now() + watchIntervalMs)
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'two' }, { id: 'three' }] } })
  await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
  expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ pageToken: 'page-two' }), expect.anything())
  expect(await f.t.run(ctx => ctx.db.query('emailWatchMessages').collect())).toHaveLength(3)
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.lastCheckedAt).toBe(f.through)
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.modify).not.toHaveBeenCalled(); expect(mocks.attachment).not.toHaveBeenCalled()
})
it('uses only each watch owner’s token and blocks substituted household connections before reads', async () => {
  const f = await fixture()
  mocks.list.mockResolvedValue({ data: { messages: [] } })
  await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
  await f.t.action(internal.gmailWatch.check, { id: f.otherId, version: 1 })
  expect(mocks.auth.mock.calls.map(([auth]) => auth.credentials)).toEqual([{ access_token: 'synthetic-parent-access' }, { access_token: 'synthetic-other-access' }])
  await f.t.run(ctx => ctx.db.patch(f.id, { connectionId: f.otherConnectionId, nextCheckAt: Date.now() }))
  await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.state).toBe('blocked')
})
it('discards an in-flight page after pause and cannot reuse a token refresh revoked during that refresh', async () => {
  const f = await fixture()
  mocks.list.mockImplementationOnce(async () => { await f.parent.mutation(api.emailWatches.setPaused, { id: f.id, version: 1, paused: true }); return { data: { messages: [{ id: 'one' }] } } })
  await f.t.action(internal.gmailWatch.check, { id: f.id, version: 1 })
  expect(mocks.get).not.toHaveBeenCalled(); expect(await f.t.run(ctx => ctx.db.query('emailWatchMessages').collect())).toEqual([])
  await f.other.mutation(api.emailWatches.setPaused, { id: f.otherId, version: 1, paused: false })
  await f.t.run(ctx => ctx.db.patch(f.otherConnectionId, { cipher: seal({ access_token: 'synthetic-expired', refresh_token: 'synthetic-refresh', expiry_date: 0 }, `${f.otherHouseholdId}:test|other`) }))
  vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockImplementationOnce(async () => { await f.other.mutation(api.connections.disconnect, { id: f.otherConnectionId }); return { credentials: { access_token: 'synthetic-refreshed', expiry_date: Date.now() + 3600000 }, res: null } as any })
  await f.t.action(internal.gmailWatch.check, { id: f.otherId, version: 2 })
  expect(mocks.list).toHaveBeenCalledTimes(1)
  expect(await f.t.run(ctx => ctx.db.get(f.otherConnectionId))).toMatchObject({ status: 'revoked', version: 2 })
  expect(await f.t.run(ctx => ctx.db.query('emailWatchMessages').collect())).toEqual([])
})
