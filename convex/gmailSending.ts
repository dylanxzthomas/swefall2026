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
import { draftMime, readKnownDraftPreimage, matchesMessage, type Approved } from './gmailDrafts'

const args = { id: v.id('mailDrafts'), version: v.number() }
const opts = { timeout: 10000, retry: false, maxContentLength: 1024 * 1024 }
const opaqueId = (id: unknown): id is string => typeof id === 'string' && /^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(id)
type SendApproval = Approved & { gmailDraftId: string; previous: Omit<Approved, 'accountEmail' | 'gmailDraftId'>; sentMessageId?: string }
type Controls = { permitted(): Promise<boolean>; dispatch(): Promise<boolean>; recordId(id: string): Promise<unknown> }
async function account(api: gmail_v1.Gmail, a: SendApproval, permitted: () => Promise<boolean>) {
  draftMime(a)
  if (!opaqueId(a.gmailDraftId) || !await permitted()) throw new Error('Send permission changed.')
  const profile = (await api.users.getProfile({ userId: 'me', fields: 'emailAddress' }, opts)).data
  if (profile.emailAddress?.toLowerCase() !== a.accountEmail.toLowerCase()) throw new Error('The sending account changed.')
}
async function readSent(api: gmail_v1.Gmail, id: string, a: SendApproval, permitted: () => Promise<boolean>) {
  if (!await permitted()) throw new Error('Send verification access changed.')
  const message = (await api.users.messages.get({ userId: 'me', id, format: 'raw', fields: 'id,threadId,labelIds,raw' }, opts)).data
  return message.id === id && message.labelIds?.includes('SENT') === true && !message.labelIds.includes('DRAFT') && matchesMessage(message, a)
}

/** One journaled send. Supplying raw prevents a concurrent Gmail edit adding recipients or changing the approved body. */
export async function sendApprovedDraft(auth: OAuth2Client, a: SendApproval, controls: Controls) {
  const api = gmail({ version: 'v1', auth }), raw = Buffer.from(draftMime(a)).toString('base64url')
  await account(api, a, controls.permitted)
  if (!await readKnownDraftPreimage(api, a.gmailDraftId, { ...a.previous, accountEmail: a.accountEmail }, controls.permitted)) throw new Error('The saved draft changed outside Sola.')
  if (!await controls.dispatch()) throw new Error('Send approval changed before dispatch.')
  const result = (await api.users.drafts.send({ userId: 'me', requestBody: { id: a.gmailDraftId, message: { raw, ...(a.replyRouting ? { threadId: a.replyRouting.threadId } : {}) } }, fields: 'id' }, opts)).data
  if (!opaqueId(result.id)) throw new Error('Gmail did not return a sent-message identifier.')
  await controls.recordId(result.id)
  return { id: result.id, verified: await readSent(api, result.id, a, controls.permitted) }
}

/** Inspect the sent copy only. Failure or an absent match never grants another send. */
export async function findSentDraft(auth: OAuth2Client, a: SendApproval, permitted: () => Promise<boolean>) {
  const api = gmail({ version: 'v1', auth }), deadline = Date.now() + 90000
  const withinBudget = async () => Date.now() < deadline && await permitted()
  await account(api, a, withinBudget)
  if (a.sentMessageId) {
    if (!opaqueId(a.sentMessageId)) throw new Error('Invalid sent-message identifier.')
    try { return { id: a.sentMessageId, verified: await readSent(api, a.sentMessageId, a, withinBudget) } }
    catch (e) { if (providerCode(e) !== 404) throw e; return { verified: false } }
  }
  if (a.replyRouting) {
    if (!await withinBudget()) throw new Error('Sent-copy check ended.')
    let thread: gmail_v1.Schema$Thread
    try { thread = (await api.users.threads.get({ userId: 'me', id: a.replyRouting.threadId, format: 'minimal', fields: 'id,messages(id,labelIds)' }, opts)).data }
    catch (e) { if (providerCode(e) !== 404) throw e; return { verified: false } }
    if (thread.id !== a.replyRouting.threadId || (thread.messages?.length ?? 0) > 20) throw new Error('Invalid or oversized sent-copy thread.')
    const matches: string[] = [], seen = new Set<string>()
    for (const message of thread.messages ?? []) {
      if (!opaqueId(message.id) || seen.has(message.id)) throw new Error('Invalid sent-copy result.')
      seen.add(message.id)
      if (!message.labelIds?.includes('SENT') || message.labelIds.includes('DRAFT')) continue
      try { if (await readSent(api, message.id, a, withinBudget)) matches.push(message.id) }
      catch (e) { if (providerCode(e) !== 404) throw e }
    }
    return matches.length === 1 ? { id: matches[0], verified: true } : { verified: false }
  }
  const matches: string[] = [], seen = new Set<string>(); let pageToken: string | undefined
  for (let page = 0; page < 2; page++) {
    if (!await withinBudget()) throw new Error('Sent-copy check ended.')
    // Legacy standalone sends also need a bounded fallback when Gmail rewrites
    // Message-ID. A marker/content match is required; absence never grants replay.
    const result = (await api.users.messages.list({ userId: 'me', q: 'in:sent', maxResults: 10, ...(pageToken ? { pageToken } : {}), fields: 'messages(id),nextPageToken' }, opts)).data
    if ((result.messages?.length ?? 0) > 10) throw new Error('Too many sent-copy results.')
    for (const m of result.messages ?? []) {
      if (!opaqueId(m.id) || seen.has(m.id)) throw new Error('Invalid sent-copy result.')
      seen.add(m.id)
      try { if (await readSent(api, m.id, a, withinBudget)) matches.push(m.id) }
      catch (e) { if (providerCode(e) !== 404) throw e }
    }
    if (!result.nextPageToken) return matches.length === 1 ? { id: matches[0], verified: true } : { verified: false }
    if (!opaqueId(result.nextPageToken) || result.nextPageToken === pageToken) throw new Error('Invalid sent-copy cursor.')
    pageToken = result.nextPageToken
  }
  return { verified: false }
}

export const send = internalAction({ args, handler: async (ctx, input): Promise<void> => {
  const lease = { ...input, lease: randomBytes(20).toString('hex') }, current = await ctx.runMutation(internal.mailSending.claim, { ...lease, readOnly: false })
  if (!current) return
  try {
    const result = await withGoogle(ctx, { connectionId: current.connectionId, connectionVersion: current.connectionVersion } as Doc<'approvals'>, auth => sendApprovedDraft(auth, current, { permitted: () => ctx.runQuery(internal.mailSending.permitted, { ...lease, readOnly: false }), dispatch: () => ctx.runMutation(internal.mailSending.dispatch, lease), recordId: sentMessageId => ctx.runMutation(internal.mailSending.recordId, { ...lease, operationKey: current.operationKey, sentMessageId }) }))
    await ctx.runMutation(internal.mailSending.finished, { ...lease, operationKey: current.operationKey, sentMessageId: result.id, verified: result.verified })
  } catch { await ctx.runMutation(internal.mailSending.finished, { ...lease, operationKey: current.operationKey, verified: false }) }
} })
export const reconcile = internalAction({ args, handler: async (ctx, input): Promise<void> => {
  const lease = { ...input, lease: randomBytes(20).toString('hex') }, current = await ctx.runMutation(internal.mailSending.claim, { ...lease, readOnly: true })
  if (!current) return
  try {
    const result = await withGoogle(ctx, { connectionId: current.connectionId, connectionVersion: current.connectionVersion } as Doc<'approvals'>, auth => findSentDraft(auth, current, () => ctx.runQuery(internal.mailSending.permitted, { ...lease, readOnly: true })))
    await ctx.runMutation(internal.mailSending.finished, { ...lease, operationKey: current.operationKey, verified: result.verified, ...('id' in result ? { sentMessageId: result.id } : {}) })
  } catch { await ctx.runMutation(internal.mailSending.finished, { ...lease, operationKey: current.operationKey, verified: false }) }
} })
