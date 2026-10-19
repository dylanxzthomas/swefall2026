'use node'
import { gmail, type gmail_v1 } from '@googleapis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import { draftMime, matchesMessage, type Approved } from './gmailDrafts'
import { providerCode } from './googleAdapter'

const opts = { timeout: 10000, retry: false, maxContentLength: 1024 * 1024 }
const opaqueId = (id: unknown): id is string => typeof id === 'string' && /^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(id)
type Controls = { permitted(): Promise<boolean>; sendPermitted(): Promise<boolean>; dispatch(): Promise<boolean>; recordId(id: string): Promise<unknown> }

function approvedMime(approval: Approved) {
  if (approval.replyRouting) throw new Error('Caregiver email must be a standalone message.')
  return draftMime(approval)
}
async function guard(permitted: () => Promise<boolean>) {
  if (!await permitted()) throw new Error('Caregiver email access changed or its bounded check ended.')
}
async function account(api: gmail_v1.Gmail, approval: Approved, permitted: () => Promise<boolean>) {
  await guard(permitted)
  const profile = (await api.users.getProfile({ userId: 'me', fields: 'emailAddress' }, opts)).data
  if (profile.emailAddress?.toLowerCase() !== approval.accountEmail.toLowerCase()) throw new Error('The caregiver email sending account changed.')
  await guard(permitted)
}
async function readSent(api: gmail_v1.Gmail, id: string, approval: Approved, permitted: () => Promise<boolean>) {
  await guard(permitted)
  const message = (await api.users.messages.get({ userId: 'me', id, format: 'raw', fields: 'id,threadId,labelIds,raw' }, opts)).data
  await guard(permitted)
  return message.id === id && message.labelIds?.includes('SENT') === true && !message.labelIds.includes('DRAFT') && matchesMessage(message, approval)
}

/** One exact send, journaled before dispatch. A lost response never authorizes replay. */
export async function sendPickupEmail(auth: OAuth2Client, approval: Approved, controls: Controls): Promise<{ id: string; verified: boolean }> {
  const raw = Buffer.from(approvedMime(approval)).toString('base64url'), api = gmail({ version: 'v1', auth })
  await account(api, approval, controls.permitted)
  await guard(controls.permitted)
  if (!await controls.dispatch()) throw new Error('Caregiver email approval changed before dispatch.')
  await guard(controls.permitted)
  await guard(controls.sendPermitted)
  const result = (await api.users.messages.send({ userId: 'me', requestBody: { raw }, fields: 'id' }, opts)).data
  if (!opaqueId(result.id)) throw new Error('Gmail did not return a sent-message identifier. The result is uncertain.')
  await controls.recordId(result.id)
  return { id: result.id, verified: await readSent(api, result.id, approval, controls.permitted) }
}

/** Read-only reconciliation: only a unique exact match from a complete bounded listing verifies delivery. */
export async function findPickupEmail(auth: OAuth2Client, approval: Approved & { sentMessageId?: string }, permitted: () => Promise<boolean>): Promise<{ id?: string; verified: boolean }> {
  approvedMime(approval)
  const api = gmail({ version: 'v1', auth }), deadline = Date.now() + 90000
  const withinBudget = async () => Date.now() < deadline && await permitted() && Date.now() < deadline
  await account(api, approval, withinBudget)
  if (approval.sentMessageId !== undefined) {
    if (!opaqueId(approval.sentMessageId)) throw new Error('Invalid caregiver sent-message identifier.')
    try { return { id: approval.sentMessageId, verified: await readSent(api, approval.sentMessageId, approval, withinBudget) } }
    catch (error) { if (providerCode(error) !== 404) throw error; return { verified: false } }
  }
  const matches: string[] = [], seenIds = new Set<string>(), seenCursors = new Set<string>()
  let pageToken: string | undefined
  for (let page = 0; page < 2; page++) {
    await guard(withinBudget)
    // Gmail can replace RFC Message-ID. Both stable operation markers and the
    // exact approved contents must match; the transport header alone is no proof.
    const result = (await api.users.messages.list({ userId: 'me', q: 'in:sent', maxResults: 10, ...(pageToken ? { pageToken } : {}), fields: 'messages(id),nextPageToken' }, opts)).data
    await guard(withinBudget)
    if (result.messages != null && !Array.isArray(result.messages)) throw new Error('Invalid caregiver sent-copy listing.')
    if ((result.messages?.length ?? 0) > 10) throw new Error('Too many caregiver sent-copy results.')
    for (const message of result.messages ?? []) {
      if (!opaqueId(message?.id) || seenIds.has(message.id)) throw new Error('Invalid caregiver sent-copy result.')
      seenIds.add(message.id)
      try { if (await readSent(api, message.id, approval, withinBudget)) matches.push(message.id) }
      catch (error) {
        if (providerCode(error) !== 404) throw error
        // A disappearing candidate makes this listing incomplete.
        return { verified: false }
      }
    }
    if (result.nextPageToken == null) return matches.length === 1 ? { id: matches[0], verified: true } : { verified: false }
    if (!opaqueId(result.nextPageToken) || seenCursors.has(result.nextPageToken)) throw new Error('Invalid caregiver sent-copy cursor.')
    seenCursors.add(result.nextPageToken)
    pageToken = result.nextPageToken
  }
  return { verified: false }
}
