import { ConvexError, v } from 'convex/values'
import { query, internalMutation, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { adult, sameHousehold } from './access'
import { payloadSchema } from '../shared/daymark'
import { pickupDelivery } from './pickupDelivery'
import { pickupMailChoice, pickupMailReceiptIssue } from './pickupMailRules'
import { preparePickupRequest } from './pickups'
import { validate, finishAttempt } from './execution'
import type { PickupEmailReview } from '../shared/pickupEmail'
import { queueNotice } from './notifications'

const leaseMs = 120_000
const requestArgs = { requestId: v.id('pickupRequests'), lease: v.string(), reminder: v.boolean() }
const validId = (id: string) => /^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(id)
export const review = query({ args: { actionId: v.id('actions'), revision: v.number(), payload: v.any() }, handler: async (ctx, args): Promise<PickupEmailReview> => {
  const { household, subject } = await adult(ctx), a = await ctx.db.get(args.actionId)
  sameHousehold(a, household._id)
  if (!a || a.revision !== args.revision || a.payload.kind !== 'pickup') throw new ConvexError('This pickup changed. Reopen its review.')
  const payload = payloadSchema.parse(args.payload)
  if (payload.kind !== 'pickup') throw new ConvexError('Review a pickup request.')
  const id = payload.caregiverId && ctx.db.normalizeId('caregivers', payload.caregiverId), caregiver = id && await ctx.db.get(id)
  if (!caregiver || caregiver.householdId !== household._id) throw new ConvexError('Choose an eligible caregiver.')
  const delivery = await pickupDelivery(ctx, caregiver.email)
  if (delivery.channel === 'app') return { channel: 'app', to: caregiver.email }
  const choice = await pickupMailChoice(ctx, household, subject, payload)
  if (choice) return { channel: 'email', transport: 'gmail', from: choice.proof.accountEmail, to: choice.proof.to, subject: choice.proof.subject, body: choice.proof.body, reminder: choice.proof.reminder, hash: choice.reviewHash }
  if (process.env.RESEND_API_KEY && process.env.DAYMARK_EMAIL_FROM && process.env.DAYMARK_WEB_URL) return { channel: 'email', transport: 'resend', from: process.env.DAYMARK_EMAIL_FROM, to: caregiver.email }
  throw new ConvexError('Choose your connected Gmail sending account with email reading enabled before reviewing this request.')
} })

export const claim = internalMutation({ args: { actionId: v.id('actions'), attemptId: v.id('attempts'), tokenHash: v.string(), lease: v.string() }, handler: async (ctx, args) => {
  const a = await ctx.db.get(args.actionId), attempt = await ctx.db.get(args.attemptId), approval = a?.approvalId ? await ctx.db.get(a.approvalId) : null
  if (!a || !attempt || !approval || a.attemptId !== attempt._id || attempt.actionId !== a._id || attempt.approvalId !== approval._id || attempt.dispatched || attempt.finished || a.status !== 'executing' || approval.emailTransport !== 'gmail' || !approval.pickupEmail) return null
  if ((await ctx.db.query('pickupRequests').withIndex('by_action', q => q.eq('actionId', a._id)).collect()).some(r => r.attemptId === attempt._id)) return null
  const problem = await validate(ctx, a, approval)
  if (problem) throw new ConvexError(problem)
  const prepared = await preparePickupRequest(ctx, { ...args }), r = await ctx.db.get(prepared.requestId)
  await ctx.db.patch(prepared.requestId, { mailLease: args.lease, mailLeaseUntil: Date.now() + leaseMs })
  await ctx.scheduler.runAfter(leaseMs + 1000, internal.pickupMail.recover, { requestId: prepared.requestId, reminder: false, lease: args.lease })
  return { requestId: prepared.requestId, approval, payload: a.payload, child: prepared.child }
} })

async function bound(ctx: MutationCtx, requestId: Id<'pickupRequests'>) {
  const r = await ctx.db.get(requestId), a = r && await ctx.db.get(r.actionId), attempt = r?.attemptId ? await ctx.db.get(r.attemptId) : null, approval = attempt ? await ctx.db.get(attempt.approvalId) : null
  if (!r || !a || !approval || !attempt || r.emailTransport !== 'gmail' || approval.emailTransport !== 'gmail' || !approval.pickupEmail || attempt.actionId !== a._id || attempt.approvalId !== approval._id || r.revision !== approval.revision || r.senderAccountEmail !== approval.pickupEmail.accountEmail || r.recipientEmail !== approval.destination) return null
  return { r, a, approval, attempt }
}
export const prepared = internalMutation({ args: { ...requestArgs, cipher: v.string(), operationKey: v.string(), approvedHash: v.string(), reminderOperationKey: v.optional(v.string()), reminderApprovedHash: v.optional(v.string()) }, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!b || b.r.mailLease !== args.lease || b.r.mailCipher || b.attempt.dispatched || b.r.mailLeaseUntil! <= Date.now() || await validate(ctx, b.a, b.approval)) return false
  await ctx.db.patch(b.r._id, { mailCipher: args.cipher, mailOperationKey: args.operationKey, mailApprovedHash: args.approvedHash, followUpOperationKey: args.reminderOperationKey, followUpApprovedHash: args.reminderApprovedHash })
  return true
} })
export const permitted = internalMutation({ args: requestArgs, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!b || b.r.mailLease !== args.lease || (b.r.mailLeaseUntil ?? 0) <= Date.now() || !b.r.mailCipher) return false
  const dispatched = args.reminder ? b.r.followUpDispatchedAt !== undefined : b.attempt.dispatched
  if (dispatched) return !await pickupMailReceiptIssue(ctx, b.approval)
  if (args.reminder && (b.r.status !== 'waiting' || b.a.status !== 'waiting' || b.r.followUpStatus !== 'preparing' || !b.approval.pickupEmail?.reminder || Date.parse(b.approval.pickupEmail.reminder.at) > Date.now())) return false
  return !await validate(ctx, b.a, b.approval, { approvedPickupReminder: args.reminder })
} })
/** A dispatch journal prevents replay; it does not replace the final write authorization. */
export const sendPermitted = internalMutation({ args: requestArgs, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!b || b.r.mailLease !== args.lease || (b.r.mailLeaseUntil ?? 0) <= Date.now() || !b.r.mailCipher || b.r.expiresAt <= Date.now() || b.a.approvalId !== b.approval._id || b.a.attemptId !== b.attempt._id || !args.reminder && b.attempt.finished) return false
  if (args.reminder) {
    if (b.r.followUpDispatchedAt === undefined || b.r.followUpStatus !== 'dispatched' || b.r.status !== 'waiting' || b.a.status !== 'waiting') return false
  } else if (!b.attempt.dispatched || b.a.status !== 'executing' || !['prepared', 'waiting'].includes(b.r.status)) return false
  return !await validate(ctx, b.a, b.approval, { approvedPickupReminder: args.reminder })
} })
export const dispatchReminder = internalMutation({ args: requestArgs, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!args.reminder || !b || b.r.mailLease !== args.lease || (b.r.mailLeaseUntil ?? 0) <= Date.now() || b.r.followUpStatus !== 'preparing' || b.r.followUpDispatchedAt !== undefined || b.r.status !== 'waiting' || b.a.status !== 'waiting' || await validate(ctx, b.a, b.approval, { approvedPickupReminder: true })) return false
  await ctx.db.patch(b.r._id, { followUpDispatchedAt: Date.now(), followUpStatus: 'dispatched' })
  return true
} })
export const recordId = internalMutation({ args: { ...requestArgs, operationKey: v.string(), providerId: v.string() }, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!b || !validId(args.providerId) || (args.reminder ? b.r.followUpOperationKey !== args.operationKey || b.r.followUpDispatchedAt === undefined || b.r.followUpProviderId && b.r.followUpProviderId !== args.providerId : b.r.mailOperationKey !== args.operationKey || !b.attempt.dispatched || b.r.mailMessageId && b.r.mailMessageId !== args.providerId)) return false
  await ctx.db.patch(b.r._id, args.reminder ? { followUpProviderId: args.providerId } : { mailMessageId: args.providerId })
  return true
} })
export const finished = internalMutation({ args: { ...requestArgs, verified: v.boolean(), providerId: v.optional(v.string()) }, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!b || b.r.mailLease !== args.lease) return
  const dispatched = args.reminder ? b.r.followUpDispatchedAt !== undefined : b.attempt.dispatched
  const recorded = args.reminder ? b.r.followUpProviderId : b.r.mailMessageId
  if (args.providerId && (!validId(args.providerId) || recorded && recorded !== args.providerId)) return
  const verified = dispatched && args.verified && !!args.providerId
  const cancelledReminder = args.reminder && !dispatched && b.r.followUpStatus === 'cancelled'
  await ctx.db.patch(b.r._id, { mailLease: undefined, mailLeaseUntil: undefined, ...(args.reminder ? { followUpStatus: verified ? 'accepted' : cancelledReminder ? 'cancelled' : dispatched ? 'uncertain' : 'failed', ...(args.providerId ? { followUpProviderId: args.providerId } : {}) } : { ...(args.providerId ? { mailMessageId: args.providerId } : {}), ...(verified ? { mailVerifiedAt: Date.now(), ...(['prepared', 'waiting'].includes(b.r.status) ? { status: 'waiting' } : {}) } : {}) }) })
  if (!args.reminder) {
    if ((b.attempt.finished || b.a.attemptId !== b.attempt._id) && verified) {
      if (!b.attempt.finished) await ctx.db.patch(b.attempt._id, { finished: true })
      const receipts = await ctx.db.query('receipts').withIndex('by_action', q => q.eq('actionId', b.a._id)).collect()
      if (!receipts.some(r => r.revision === b.approval.revision && r.outcome === 'request_email_accepted' && r.providerId === args.providerId)) await ctx.db.insert('receipts', { householdId: b.r.householdId, actionId: b.a._id, revision: b.approval.revision, outcome: 'request_email_accepted', providerId: args.providerId, verifiedAt: Date.now() })
      if (b.a.approvalId === b.approval._id && b.a.revision === b.approval.revision && b.a.status === 'uncertain') await ctx.db.patch(b.a._id, { status: 'waiting', error: undefined })
    } else await finishAttempt(ctx, { attemptId: b.attempt._id, status: verified ? 'waiting' : dispatched ? 'uncertain' : 'failed', ...(verified ? { providerId: args.providerId } : {}), ...(!verified ? { error: dispatched ? 'The request email is unconfirmed. Check its result; it will not be sent again.' : 'The request stopped before sending. Review it again.' } : {}) })
    if (verified && b.r.status === 'prepared' && b.approval.pickupEmail?.reminder && !b.r.followUpStatus) {
      await ctx.db.patch(b.r._id, { followUpStatus: 'scheduled' })
      await ctx.scheduler.runAt(Math.max(Date.now(), Date.parse(b.approval.pickupEmail.reminder.at)), internal.pickupMailWorker.remind, { requestId: b.r._id })
    }
  } else if (!verified && !cancelledReminder) await queueNotice(ctx, b.a.jobId, 'help', `reminder:${b.r._id}`)
} })
export const claimRead = internalMutation({ args: { requestId: v.id('pickupRequests'), reminder: v.boolean(), lease: v.string() }, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!b || !b.r.mailCipher || (b.r.mailLeaseUntil ?? 0) > Date.now() || (args.reminder ? b.r.followUpDispatchedAt === undefined || b.r.followUpStatus !== 'uncertain' : !b.attempt.dispatched || b.r.mailVerifiedAt) || await pickupMailReceiptIssue(ctx, b.approval)) return null
  await ctx.db.patch(b.r._id, { mailLease: args.lease, mailLeaseUntil: Date.now() + leaseMs })
  await ctx.scheduler.runAfter(leaseMs + 1000, internal.pickupMail.recover, { requestId: b.r._id, reminder: args.reminder, lease: args.lease })
  return { requestId: b.r._id, cipher: b.r.mailCipher, approval: b.approval, providerId: args.reminder ? b.r.followUpProviderId : b.r.mailMessageId }
} })
export const claimReminder = internalMutation({ args: { requestId: v.id('pickupRequests'), lease: v.string() }, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!b || !b.r.mailCipher || b.r.followUpStatus !== 'scheduled' || !b.approval.pickupEmail?.reminder || b.r.status !== 'waiting' || b.a.status !== 'waiting' || b.r.followUpDispatchedAt !== undefined || Date.parse(b.approval.pickupEmail.reminder.at) > Date.now()) return null
  if (await validate(ctx, b.a, b.approval, { approvedPickupReminder: true })) { await ctx.db.patch(b.r._id, { followUpStatus: 'cancelled' }); return null }
  await ctx.db.patch(b.r._id, { followUpStatus: 'preparing', mailLease: args.lease, mailLeaseUntil: Date.now() + leaseMs })
  await ctx.scheduler.runAfter(leaseMs + 1000, internal.pickupMail.recover, { requestId: b.r._id, reminder: true, lease: args.lease })
  return { requestId: b.r._id, cipher: b.r.mailCipher, approval: b.approval }
} })
export const recover = internalMutation({ args: { requestId: v.id('pickupRequests'), reminder: v.boolean(), lease: v.string() }, handler: async (ctx, args) => {
  const b = await bound(ctx, args.requestId)
  if (!b || b.r.mailLease !== args.lease || (b.r.mailLeaseUntil ?? 0) > Date.now()) return
  if (args.reminder) {
    const cancelled = b.r.followUpDispatchedAt === undefined && b.r.followUpStatus === 'cancelled'
    await ctx.db.patch(b.r._id, { followUpStatus: cancelled ? 'cancelled' : b.r.followUpDispatchedAt !== undefined ? 'uncertain' : 'failed', mailLease: undefined, mailLeaseUntil: undefined })
    if (!cancelled) await queueNotice(ctx, b.a.jobId, 'help', `reminder:${b.r._id}`)
  }
  else { await ctx.db.patch(b.r._id, { mailLease: undefined, mailLeaseUntil: undefined }); if (!b.r.mailVerifiedAt) await finishAttempt(ctx, { attemptId: b.attempt._id, status: b.attempt.dispatched ? 'uncertain' : 'failed', error: 'The request email check was interrupted. Check its result before taking another action.' }) }
} })
