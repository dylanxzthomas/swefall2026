import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx, MutationCtx } from './_generated/server'
import { canUse, providerOf, selection } from './providerRules'
import { pickupEmailProof } from '../shared/pickupEmail'
import { gmailReadScope, exactSender } from '../shared/emailWatches'
import type { PickupDraft } from '../shared/daymark'
import { hash } from '../shared/daymark'

export async function pickupMailChoice(ctx: QueryCtx | MutationCtx, household: Doc<'households'>, subject: string, payload: PickupDraft) {
  const chosen = await selection(ctx, subject, 'email'), c = chosen.connection
  const caregiverId = payload.caregiverId && ctx.db.normalizeId('caregivers', payload.caregiverId), caregiver = caregiverId ? await ctx.db.get(caregiverId) : null
  const child = household.children.find(value => value.id === payload.childId)
  if (!caregiver || caregiver.householdId !== household._id || !child || !caregiver.childIds.includes(child.id)) return null
  if (!c || c.householdId !== household._id || c.subject !== subject || providerOf(c) !== 'google' || !c.cipher || !c.email || !exactSender(c.email) || !canUse(c, 'email') || !c.scopes.includes(gmailReadScope)) return null
  if (process.env.DAYMARK_ENVIRONMENT !== 'production' && !(process.env.DAYMARK_TEST_GOOGLE_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).includes(c.email.toLowerCase())) return null
  try {
    const proof = pickupEmailProof(payload, child.name, process.env.DAYMARK_WEB_URL ?? '', c.email, caregiver.email)
    return { connection: c, selectionVersion: chosen.version, proof, reviewHash: hash(JSON.stringify([proof.hash, c._id, c.version, chosen.version])) }
  }
  catch { return null }
}

export async function pickupMailReceiptIssue(ctx: QueryCtx | MutationCtx, approval: Doc<'approvals'>) {
  const c = approval.connectionId && await ctx.db.get(approval.connectionId), h = await ctx.db.get(approval.householdId)
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', approval.subject)).unique()
  if (!h || h.deleted || member?.householdId !== h._id || !c || c.subject !== approval.subject || c.householdId !== h._id || c.version !== approval.connectionVersion || !c.cipher || providerOf(c) !== 'google' || !canUse(c, 'email') || !c.scopes.includes(gmailReadScope) || c.email?.toLowerCase() !== approval.pickupEmail?.accountEmail) return 'The approved Gmail account changed. Reconnect before checking this request email.'
  return null
}
export async function pickupMailApprovalIssue(ctx: QueryCtx | MutationCtx, a: Doc<'actions'>, approval: Doc<'approvals'>) {
  if (approval.emailTransport !== 'gmail') return null
  if (a.payload.kind !== 'pickup' || approval.deliveryChannel !== 'email' || approval.verificationMethod !== 'identity' || !approval.pickupEmail) return 'The approved caregiver email changed. Review it again.'
  const h = await ctx.db.get(a.householdId), current = h && await pickupMailChoice(ctx, h, approval.subject, a.payload)
  if (!current || current.connection._id !== approval.connectionId || current.connection.version !== approval.connectionVersion || current.selectionVersion !== approval.selectionVersion || current.proof.to !== approval.destination || (['accountEmail', 'childName', 'webUrl', 'to', 'subject', 'body', 'hash'] as const).some(key => current.proof[key] !== approval.pickupEmail![key]) || current.proof.reminder?.at !== approval.pickupEmail.reminder?.at || current.proof.reminder?.subject !== approval.pickupEmail.reminder?.subject || current.proof.reminder?.body !== approval.pickupEmail.reminder?.body) return 'The caregiver message or sending account changed. Review the request again.'
  return null
}
/** Historical operations retain their own approval even after a correction or caregiver response. */
export async function pendingPickupMail(ctx: QueryCtx | MutationCtx, actionId: Id<'actions'>, subject: string) {
  const requests = await ctx.db.query('pickupRequests').withIndex('by_action', q => q.eq('actionId', actionId)).order('desc').collect()
  for (const r of requests) {
    if (r.emailTransport !== 'gmail' || !r.mailCipher || !r.attemptId) continue
    const attempt = await ctx.db.get(r.attemptId), approval = attempt && await ctx.db.get(attempt.approvalId)
    if (!approval || approval.subject !== subject || !attempt?.dispatched) continue
    if (r.followUpStatus === 'uncertain') return { requestId: r._id, reminder: true }
    if (!r.mailVerifiedAt) return { requestId: r._id, reminder: false }
  }
  return null
}
