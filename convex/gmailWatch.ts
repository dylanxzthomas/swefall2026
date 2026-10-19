'use node'
import { randomBytes } from 'node:crypto'
import { gmail, type gmail_v1 } from '@googleapis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { withGoogle } from './google'
import { providerCode } from './googleAdapter'
import { exactSender, watchBatchSize, watchQuery } from '../shared/emailWatches'
import { extractGmailMessage } from '../shared/gmailMessage'

type Window = { senders: string[]; from: number; through: number; pageToken?: string }
const opts = { timeout: 10_000, retry: false, maxContentLength: 1024 * 1024 }
class InvalidWatchCursor extends Error {}
const opaqueId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[^\s\u0000-\u001f\u007f]+$/u.test(value)
function details(error: unknown) {
  const body = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error
  const value = body && typeof body === 'object' ? body as { message?: unknown; errors?: { reason?: unknown; location?: unknown; message?: unknown }[] } : undefined
  return { message: typeof value?.message === 'string' ? value.message : '', errors: Array.isArray(value?.errors) ? value.errors.filter(entry => entry && typeof entry === 'object') : [] }
}
function invalidCursor(error: unknown): boolean {
  if (providerCode(error) !== 400) return false
  const value = details(error), cursor = /(?:invalid|expired)\b.{0,80}\bpage[ _-]?token\b|\bpage[ _-]?token\b.{0,80}\b(?:invalid|expired)/i
  return cursor.test(value.message) || value.errors.some(e => e.location === 'pageToken' || typeof e.message === 'string' && cursor.test(e.message))
}
function reconnectRequired(error: unknown): boolean {
  const code = providerCode(error), reasons = details(error).errors.map(e => e.reason)
  // Gmail reports quota exhaustion as 403 too; asking the parent to reconnect cannot repair it.
  if (code === 403 && reasons.length && reasons.every(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded'].includes(String(reason)))) return false
  return [400, 401, 403].includes(code)
}
/** Six bounded, read-only API operations; never fetch attachments or source-supplied links. */
export async function readWatchBatch(auth: OAuth2Client, window: Window, permitted: () => Promise<boolean>) {
  const api = gmail({ version: 'v1', auth })
  if (!await permitted()) throw new Error('Watch stopped.')
  let page: gmail_v1.Schema$ListMessagesResponse
  try { page = (await api.users.messages.list({ userId: 'me', q: watchQuery(window.senders, window.from, window.through), maxResults: watchBatchSize, includeSpamTrash: false, ...(window.pageToken ? { pageToken: window.pageToken } : {}) }, opts)).data }
  catch (error) { if (window.pageToken && invalidCursor(error)) throw new InvalidWatchCursor('Gmail rejected this page cursor.'); throw error }
  if ((page.messages?.length ?? 0) > watchBatchSize) throw new Error('Gmail returned more messages than the bounded page requested.')
  if (window.pageToken && page.nextPageToken === window.pageToken) throw new InvalidWatchCursor('Gmail repeated this page cursor.')
  const messages = []
  for (const item of (page.messages ?? []).slice(0, watchBatchSize)) {
    if (!opaqueId(item.id)) throw new Error('Gmail returned an invalid message identifier.')
    if (!await permitted()) throw new Error('Watch stopped.')
    let m: gmail_v1.Schema$Message
    try { m = (await api.users.messages.get({ userId: 'me', id: item.id, format: 'full', fields: 'id,threadId,internalDate,labelIds,snippet,payload' }, opts)).data }
    catch (e) { if (providerCode(e) === 404) continue; throw e }
    if (m.id !== item.id) throw new Error('Gmail returned a different message than requested.')
    if ((m.labelIds ?? []).some(l => ['SPAM', 'TRASH', 'SENT', 'DRAFT'].includes(l))) continue
    const headers = m.payload?.headers ?? [], from = headers.filter(h => h.name?.toLowerCase() === 'from')
    const sender = from.length === 1 ? exactSender(from[0].value ?? '') : null, receivedAt = Number(m.internalDate)
    if (!m.id || !sender || !window.senders.includes(sender) || !/^\d+$/.test(m.internalDate ?? '') || !Number.isSafeInteger(receivedAt) || receivedAt < window.from || receivedAt > window.through) continue
    const { text, ...extraction } = extractGmailMessage(m)
    // Keep the older flag conservative while consumers adopt the more precise source metadata.
    messages.push({ id: m.id, ...(opaqueId(m.threadId) ? { threadId: m.threadId } : {}), sender, subject: (headers.find(h => h.name?.toLowerCase() === 'subject')?.value ?? '(No subject)').slice(0, 300), text, receivedAt, truncated: extraction.truncated || extraction.incomplete, extraction })
  }
  return { messages, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) }
}
export const check = internalAction({ args: { id: v.id('emailWatches'), version: v.number() }, handler: async (ctx, args): Promise<void> => {
  const lease = { ...args, lease: randomBytes(20).toString('hex') }
  const current = await ctx.runMutation(internal.emailWatches.claim, lease)
  if (!current) return
  try {
    await withGoogle(ctx, { connectionId: current.connectionId, connectionVersion: current.connectionVersion } as Doc<'approvals'>, async auth => {
      const result = await readWatchBatch(auth, current, () => ctx.runQuery(internal.emailWatches.permitted, lease))
      await ctx.runMutation(internal.emailWatches.finish, { ...lease, ...result })
    })
  } catch (e) {
    if (e instanceof InvalidWatchCursor) await ctx.runMutation(internal.emailWatches.resetCursor, lease)
    else await ctx.runMutation(internal.emailWatches.failed, { ...lease, reconnect: reconnectRequired(e) })
  }
} })
