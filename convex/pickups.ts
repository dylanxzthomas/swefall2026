import { routineJobIssue } from './routineRules'
import { queueNotice } from './notifications'
import { cancelWaitingDependencies } from './dependencies'
import { deliver } from './transactional'
import { start } from '@convex-dev/workflow'
import { v, ConvexError } from 'convex/values'
import { mutation, query, internalMutation, internalQuery, action, internalAction, type MutationCtx, type QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult, remember, sameHousehold } from './access'
import { hash, payloadHash } from '../shared/daymark'
import { z } from 'zod'
import { pickupDelivery } from './pickupDelivery'
import { finishAttempt, validate } from './execution'
import { nextPickupDraft } from './pickupAlternatives'
import { familyFactSchema, availabilityAt } from '../shared/memory'
import { confirmedPickupConflict } from './pickupConflicts'
import { resolveApprovedTool } from '../shared/tools'

async function uniqueCaregiverEmail(ctx: MutationCtx, householdId: Id<'households'>, email: string, except?: Id<'caregivers'>) {
  const caregivers = await ctx.db.query('caregivers').withIndex('by_household', q => q.eq('householdId', householdId)).collect()
  if (caregivers.some(c => c._id !== except && c.email.trim().toLowerCase() === email)) throw new ConvexError('This caregiver email is already saved. Edit their existing eligible children instead.')
}

function token() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('') }
export const list = query({ args: {}, handler: async ctx => {
  const { household } = await adult(ctx)
  const caregivers = await ctx.db.query('caregivers').withIndex('by_household', q => q.eq('householdId', household._id)).collect()
  return Promise.all(caregivers.map(async c => ({ ...c, deliveryChannel: (await pickupDelivery(ctx, c.email)).channel })))
} })
export const addCaregiver = mutation({ args: { name: v.string(), email: v.string(), childIds: v.array(v.string()) }, handler: async (ctx, args) => {
  const { household } = await adult(ctx)
  if (!args.name.trim() || args.name.length > 80 || !z.email().safeParse(args.email).success || !args.childIds.length || args.childIds.some(id => !household.children.some(c => c.id === id))) throw new ConvexError('Confirm the caregiver name, email, and eligible children.')
  await uniqueCaregiverEmail(ctx, household._id, args.email.trim().toLowerCase())
  const id = await ctx.db.insert('caregivers', { householdId: household._id, ...args, email: args.email.toLowerCase().trim() })
  await remember(ctx, household._id, `caregiver:${id}`, { ...args, email: args.email.toLowerCase().trim() })
  return id
} })
export const updateCaregiver = mutation({ args: { id: v.id('caregivers'), name: v.string(), email: v.string(), childIds: v.array(v.string()) }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), old = await ctx.db.get(args.id)
  sameHousehold(old, household._id)
  if (!args.name.trim() || args.name.length > 80 || !z.email().safeParse(args.email).success || args.childIds.some(id => !household.children.some(c => c.id === id))) throw new ConvexError('Confirm caregiver details and eligible children.')
  const { id, ...details } = args
  details.email = details.email.trim().toLowerCase()
  await uniqueCaregiverEmail(ctx, household._id, details.email, id)
  await ctx.db.patch(id, { ...details, ...(details.email !== old!.email ? { verifiedAt: undefined } : {}) })
  await remember(ctx, household._id, `caregiver:${id}`, details)
  for (const a of await ctx.db.query('actions').withIndex('by_household', q => q.eq('householdId', household._id)).collect()) {
    if (a.payload.kind !== 'pickup' || a.payload.caregiverId !== id || !['queued', 'waiting'].includes(a.status)) continue
    if (details.email !== old!.email || !details.childIds.includes(a.payload.childId)) {
      await cancelWaitingDependencies(ctx, a)
      await ctx.db.patch(a._id, { status: 'review', revision: a.revision + 1, approvalId: undefined, error: 'Caregiver details changed. Review a new request.' })
    }
  }
} })
export const arrangements = query({ args: {}, handler: async ctx => {
  const { household } = await adult(ctx)
  const requests = await ctx.db.query('pickupRequests').withIndex('by_household', q => q.eq('householdId', household._id)).collect()
  return Promise.all(requests.map(async r => ({ id: r._id, status: r.status, response: r.response, respondedAt: r.respondedAt, suggestion: r.suggestion, followUpStatus: r.followUpStatus, actionId: r.actionId, caregiver: (await ctx.db.get(r.caregiverId))?.name, payload: r.payload ?? (await ctx.db.get(r.actionId))?.payload })))
} })
export async function preparePickupRequest(ctx: MutationCtx, args: { actionId: Id<'actions'>; tokenHash: string; attemptId?: Id<'attempts'> }) {
  const a = await ctx.db.get(args.actionId)
  if (!a || a.payload.kind !== 'pickup' || a.status !== 'executing') throw new Error('Pickup is not approved for execution.')
  const id = ctx.db.normalizeId('caregivers', a.payload.caregiverId)!, caregiver = await ctx.db.get(id)
  if (!caregiver || caregiver.householdId !== a.householdId) throw new Error('Caregiver unavailable.')
  const previous = await ctx.db.query('pickupRequests').withIndex('by_action', q => q.eq('actionId', a._id)).collect()
  for (const request of previous) if (request.status !== 'accepted') await ctx.db.patch(request._id, { status: 'superseded' })
  const expiresAt = Date.parse(a.payload.deadline)
  const approval = a.approvalId && await ctx.db.get(a.approvalId)
  const deliveryChannel = approval?.deliveryChannel ?? 'email'
  const requestId = await ctx.db.insert('pickupRequests', { deliveryChannel, ...(args.attemptId ? { attemptId: args.attemptId } : {}), ...(approval?.emailTransport === 'gmail' ? { emailTransport: 'gmail' as const, verificationMethod: 'identity' as const, recipientEmail: approval.destination, senderAccountEmail: approval.pickupEmail?.accountEmail } : {}), ...(approval?.recipientSubject ? { recipientSubject: approval.recipientSubject } : {}), payload: a.payload, householdId: a.householdId, actionId: a._id, revision: a.revision, caregiverId: id, tokenHash: args.tokenHash, expiresAt, status: 'prepared' })
  await ctx.scheduler.runAt(Math.max(Date.now() + 60_000, expiresAt - 30 * 60_000), internal.pickups.approaching, { requestId })
  await ctx.scheduler.runAt(expiresAt, internal.pickups.expire, { requestId })
  const household = await ctx.db.get(a.householdId)
  return { requestId, deliveryChannel, caregiver, child: household?.children.find(c => c.id === a.payload.childId)?.name ?? '', payload: a.payload }
}
export const prepareRequest = internalMutation({ args: { actionId: v.id('actions'), tokenHash: v.string() }, handler: preparePickupRequest })
export const sent = internalMutation({ args: { requestId: v.id('pickupRequests') }, handler: async (ctx, { requestId }) => {
  const r = await ctx.db.get(requestId)
  if (r?.status === 'prepared') await ctx.db.patch(requestId, { status: 'waiting' })
} })
export const send = internalAction({ args: { actionId: v.id('actions'), attemptId: v.id('attempts') }, handler: async (ctx, args): Promise<void> => {
  let dispatched = false, inApp = false
  try {
    const secret = token()
    const r = await ctx.runMutation(internal.pickups.prepareRequest, { actionId: args.actionId, tokenHash: hash(secret) })
    inApp = r.deliveryChannel === 'app'
    if (inApp) {
      if (!await ctx.runMutation(internal.execution.dispatch, { attemptId: args.attemptId })) return
      await ctx.runMutation(internal.pickups.deliverInApp, { requestId: r.requestId, attemptId: args.attemptId })
      return
    }
    const root = process.env.DAYMARK_WEB_URL
    if (!root || !root.startsWith('https://')) throw new Error('Secure response page is not configured.')
    if (!await ctx.runMutation(internal.execution.dispatch, { attemptId: args.attemptId })) return
    dispatched = true
    const messageId = await deliver(r.caregiver.email, 'A pickup request from Daymark', `${r.payload.message}\n\nChild: ${r.child}\nPickup: ${r.payload.date} ${r.payload.time} (${r.payload.timezone})\nLocation: ${r.payload.location}\nReply before: ${r.payload.deadline}\n\nVerify your email and respond privately:\n${root}/#pickup=${secret}\n\nA request is not a confirmed arrangement.`, `pickup-${args.attemptId}`)
    await ctx.runMutation(internal.pickups.sent, { requestId: r.requestId })
    await ctx.runMutation(internal.execution.finish, { attemptId: args.attemptId, status: 'waiting', providerId: messageId })
    if (r.payload.followUpAt) { try { await ctx.runAction(internal.pickupFollowup.schedule, { requestId: r.requestId, secret }) } catch { await ctx.runMutation(internal.pickups.followupFinished, { requestId: r.requestId, status: 'failed' }) } }
  } catch {
    await ctx.runMutation(internal.execution.finish, { attemptId: args.attemptId, status: dispatched ? 'uncertain' : 'failed', error: inApp ? 'The in-app request could not be saved. Review to try again.' : dispatched ? 'The request email may have been accepted. It will not be resent automatically.' : 'Caregiver email is unavailable. Nothing has been sent.' })
  }
} })
export async function currentRequest(ctx: QueryCtx | MutationCtx, r: Doc<'pickupRequests'> | null) {
  if (!r || r.expiresAt <= Date.now() || !['waiting', 'prepared'].includes(r.status)) throw new ConvexError('This private request expired or is no longer available.')
  const a = await ctx.db.get(r.actionId) as Doc<'actions'> | null, h = await ctx.db.get(r.householdId), job = a && await ctx.db.get(a.jobId)
  if (!a || !h || h.deleted || !job || job.cancelled || a.revision !== r.revision || !['waiting', 'uncertain', 'executing'].includes(a.status)) throw new ConvexError('This request changed or was cancelled.')
  const caregiver = await ctx.db.get(r.caregiverId)
  const approval = a.approvalId && await ctx.db.get(a.approvalId)
  const source = await ctx.db.get(job.sourceId)
  if (!source || source.revision !== a.sourceRevision) throw new ConvexError('The source changed. Ask the parent for a new request.')
  if (!caregiver || !caregiver.childIds.includes(a.payload.childId) || (approval && caregiver.email !== approval.destination) || !h.children.some((c: any) => c.id === a.payload.childId)) throw new ConvexError('Caregiver eligibility or recipient changed. Ask the parent for a new request.')
  return { r, a, h }
}
async function available(ctx: QueryCtx | MutationCtx, secret: string) {
  const r = await ctx.db.query('pickupRequests').withIndex('by_token', q => q.eq('tokenHash', hash(secret))).unique()
  if (r?.verificationMethod === 'identity') throw new ConvexError('Sign in with the caregiver email to open this request.')
  if (r?.deliveryChannel === 'app') throw new ConvexError('Open this request in your signed-in Daymark account.')
  return currentRequest(ctx, r)
}
export const challenge = internalMutation({ args: { secret: v.string(), codeHash: v.string() }, handler: async (ctx, args) => {
  const { r } = await available(ctx, args.secret)
  if ((r.challengeCount ?? 0) >= 5 || (r.codeSentAt ?? 0) > Date.now() - 60_000 || (r.verificationAttempts ?? 0) >= 5) throw new ConvexError('Wait a minute before requesting another code. Repeated attempts lock this link.')
  await ctx.db.patch(r._id, { codeHash: args.codeHash, codeExpiresAt: Date.now() + 10 * 60_000, codeSentAt: Date.now(), challengeCount: (r.challengeCount ?? 0) + 1 })
  return { email: (await ctx.db.get(r.caregiverId))!.email, requestId: r._id }
} })
export const requestCode = action({ args: { secret: v.string() }, handler: async (ctx, args): Promise<void> => {
  if (args.secret.length !== 64) throw new ConvexError('Invalid private link.')
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')
  const r = await ctx.runMutation(internal.pickups.challenge, { secret: args.secret, codeHash: hash(`${args.secret}:${code}`) })
  await deliver(r.email, 'Your Daymark verification code', `Your code is ${code}. It expires in 10 minutes. This verifies access only to the pickup request in your private link.`, `verify-${r.requestId}-${hash(code)}`)
} })
export const verify = mutation({ args: { secret: v.string(), code: v.string(), session: v.string() }, handler: async (ctx, args) => {
  const { r } = await available(ctx, args.secret)
  if (args.session.length !== 64 || !/^[a-f0-9]+$/.test(args.session)) return false
  if ((r.verificationAttempts ?? 0) >= 5 || !r.codeHash || (r.codeExpiresAt ?? 0) < Date.now()) return false
  if (r.codeHash !== hash(`${args.secret}:${args.code}`)) {
    // Return instead of throw so the rate-limit counter commits.
    await ctx.db.patch(r._id, { verificationAttempts: (r.verificationAttempts ?? 0) + 1 })
    return false
  }
  await ctx.db.patch(r._id, { sessionHash: hash(args.session), sessionExpiresAt: Math.min(r.expiresAt, Date.now() + 30 * 60_000), codeHash: undefined })
  await ctx.db.patch(r.caregiverId, { verifiedAt: Date.now() })
  return true
} })
export const view = query({ args: { secret: v.string(), session: v.string() }, handler: async (ctx, args) => {
  try {
    const { r, a, h } = await available(ctx, args.secret)
    if (r.sessionHash !== hash(args.session) || (r.sessionExpiresAt ?? 0) < Date.now()) return null
    const p = a.payload
    return { child: h.children.find((c: any) => c.id === p.childId)?.name, date: p.date, time: p.time, timezone: p.timezone, location: p.location, message: p.message, deadline: p.deadline }
  } catch { return null }
} })
export const respond = mutation({ args: { secret: v.string(), session: v.string(), response: v.union(v.literal('accept'), v.literal('decline'), v.literal('suggest')), suggestion: v.string() }, handler: async (ctx, args) => {
  const { r, a } = await available(ctx, args.secret)
  if (r.sessionHash !== hash(args.session) || (r.sessionExpiresAt ?? 0) < Date.now()) throw new ConvexError('Verify your email again.')
  await recordResponse(ctx, r, a, args)
} })
export async function recordResponse(ctx: MutationCtx, r: Doc<'pickupRequests'>, a: Doc<'actions'>, args: { response: 'accept' | 'decline' | 'suggest'; suggestion: string }) {
  if (args.suggestion.length > 2000 || args.response === 'suggest' && !args.suggestion.trim()) throw new ConvexError('Describe your suggested change.')
  if (args.response === 'accept') {
    const facts = await ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', r.householdId)).collect()
    const confirmed = facts.filter(f => f.confirmed).flatMap(f => { const parsed = familyFactSchema.safeParse(f.value); return parsed.success ? [parsed.data] : [] })
    const household = await ctx.db.get(r.householdId)
    if (availabilityAt(confirmed, r.caregiverId, a.payload.date, a.payload.time, a.payload.timezone, household!.timezone) === 'busy') throw new ConvexError('Saved availability changed. Suggest a change so the parent can resolve it.')
    if (await confirmedPickupConflict(ctx, r.householdId, a.payload, r._id)) throw new ConvexError('This overlaps another confirmed pickup. Suggest a change so the parent can resolve it.')
  }
  await ctx.db.patch(r._id, { status: args.response === 'accept' ? 'accepted' : args.response === 'decline' ? 'declined' : 'suggested', response: args.response, suggestion: args.suggestion, respondedAt: Date.now(), ...(r.emailTransport === 'gmail' && ['scheduled', 'preparing'].includes(r.followUpStatus ?? '') && r.followUpDispatchedAt === undefined ? { followUpStatus: 'cancelled' as const } : {}) })
  await ctx.db.patch(a._id, { status: args.response === 'accept' ? 'succeeded' : 'review', error: args.response === 'accept' ? undefined : args.response === 'decline' ? 'Caregiver declined. Choose another eligible caregiver and review a new request.' : `Caregiver suggested: ${args.suggestion}. Edit and approve before this becomes an arrangement.`, ...(args.response !== 'accept' ? { revision: a.revision + 1, approvalId: undefined } : {}) })
  if (args.response !== 'accept') {
    await cancelWaitingDependencies(ctx, a)
    if (args.response === 'decline') await ctx.db.patch(a._id, await nextPickupDraft(ctx, a))
    await queueNotice(ctx, a.jobId, 'help', `response:${r._id}`)
  }
  if (args.response === 'accept') {
    for (const dependent of await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', a.jobId)).collect()) {
      if (dependent.dependsOn === a._id && dependent.dependencyRevision === a.revision && dependent.status === 'waiting' && dependent.approvalId) {
        await ctx.db.patch(dependent._id, { status: 'queued' })
        const approval = await ctx.db.get(dependent.approvalId)
        if (approval?.provider !== 'apple') await start(ctx, internal.workflows.execute, { actionId: dependent._id, approvalId: dependent.approvalId })
      }
    }
  }
  if (args.response === 'accept') await ctx.db.insert('receipts', { householdId: r.householdId, actionId: a._id, revision: a.revision, providerId: r._id, outcome: 'caregiver_accepted_not_pickup_completed', verifiedAt: Date.now() })
}
export const expire = internalMutation({ args: { requestId: v.id('pickupRequests') }, handler: async (ctx, { requestId }) => {
  const r = await ctx.db.get(requestId)
  if (!r || !['waiting', 'prepared'].includes(r.status) || r.expiresAt > Date.now()) return
  await ctx.db.patch(r._id, { status: 'expired' })
  const a = await ctx.db.get(r.actionId)
  if (a) await queueNotice(ctx, a.jobId, 'help', String(a.sourceRevision))
  if (a && a.revision === r.revision && ['waiting', 'uncertain'].includes(a.status)) {
    await cancelWaitingDependencies(ctx, a)
    await ctx.db.patch(a._id, { status: 'review', revision: a.revision + 1, approvalId: undefined, error: 'No answer before the deadline. Choose the next option; pickup is not confirmed.' })
    await ctx.db.patch(a._id, await nextPickupDraft(ctx, a))
  }
} })

export const scheduleFollowup = internalMutation({ args: { requestId: v.id('pickupRequests'), cipher: v.string() }, handler: async (ctx, args) => {
  const r = await ctx.db.get(args.requestId), a = r && await ctx.db.get(r.actionId)
  if (!r || !a || !a.payload.followUpAt || r.status !== 'waiting' || r.followUpStatus || a.revision !== r.revision) return
  const at = Date.parse(a.payload.followUpAt)
  if (!Number.isFinite(at) || at >= r.expiresAt) return
  await ctx.db.patch(r._id, { followUpCipher: args.cipher, followUpStatus: 'scheduled' })
  await ctx.scheduler.runAt(Math.max(Date.now(), at), internal.pickupFollowup.send, { requestId: r._id })
} })
function approvedFollowupTool(a: Doc<'actions'>, approval: Doc<'approvals'> | null | undefined, channel: 'email' | 'app') {
  if (!approval || approval.actionId !== a._id || approval.householdId !== a.householdId) throw new Error('The reminder approval no longer matches its request.')
  const { tool } = resolveApprovedTool(a.payload, approval)
  if (tool.name !== `caregiver.${channel}.request`) throw new Error('The approved reminder tool changed.')
}
export const claimFollowup = internalMutation({ args: { requestId: v.id('pickupRequests') }, handler: async (ctx, { requestId }) => {
  const r = await ctx.db.get(requestId), a = r && await ctx.db.get(r.actionId)
  if (!r || !a || r.followUpStatus !== 'scheduled' || !r.followUpCipher) return null
  const h = await ctx.db.get(r.householdId), job = await ctx.db.get(a.jobId), approval = a.approvalId && await ctx.db.get(a.approvalId), caregiver = await ctx.db.get(r.caregiverId)
  const source = job && await ctx.db.get(job.sourceId), member = approval && await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', approval.subject)).unique()
  const routineIssue = job ? await routineJobIssue(ctx, job) : null
  if (routineIssue || !h || h.deleted || !job || job.cancelled || !source || source.revision !== a.sourceRevision || !member || member.householdId !== h._id || r.status !== 'waiting' || a.status !== 'waiting' || a.revision !== r.revision || r.expiresAt <= Date.now() || !approval || approval.revision !== a.revision || approval.sourceRevision !== a.sourceRevision || approval.expiresAt <= Date.now() || approval.payloadHash !== payloadHash(a.payload) || !caregiver || caregiver.email !== approval.destination || !caregiver.childIds.includes(a.payload.childId) || !h.children.some(c => c.id === a.payload.childId)) { await ctx.db.patch(requestId, { followUpCipher: undefined, followUpStatus: 'cancelled' }); return null }
  try { approvedFollowupTool(a, approval, 'email') } catch { await ctx.db.patch(requestId, { followUpCipher: undefined, followUpStatus: 'cancelled' }); return null }
  if (Date.parse(a.payload.followUpAt) > Date.now()) return null
  // Once claimed, even an interrupted worker never sends this reminder a second time.
  await ctx.db.patch(requestId, { followUpStatus: 'dispatched', followUpCipher: undefined })
  return { ...a.payload, child: h.children.find(c => c.id === a.payload.childId)?.name ?? '', cipher: r.followUpCipher, email: caregiver.email }
} })
export const followupFinished = internalMutation({ args: { requestId: v.id('pickupRequests'), status: v.string(), providerId: v.optional(v.string()) }, handler: async (ctx, args) => {
  const r = await ctx.db.get(args.requestId)
  if (r && (!r.followUpStatus || r.followUpStatus === 'dispatched')) {
    await ctx.db.patch(r._id, { followUpStatus: args.status, ...(args.providerId ? { followUpProviderId: args.providerId } : {}) })
    const action = await ctx.db.get(r.actionId)
    if (action && ['failed', 'uncertain'].includes(args.status)) await queueNotice(ctx, action.jobId, 'help', `reminder:${r._id}`)
  }
} })

export const approaching = internalMutation({ args: { requestId: v.id('pickupRequests') }, handler: async (ctx, { requestId }) => {
  const r = await ctx.db.get(requestId), a = r && await ctx.db.get(r.actionId)
  if (!r || !a || r.status !== 'waiting' || a.status !== 'waiting' || a.revision !== r.revision || r.expiresAt <= Date.now()) return
  await queueNotice(ctx, a.jobId, 'help', `deadline:${r._id}`)
} })

async function verifiedRecipient(ctx: QueryCtx | MutationCtx) {
  const { subject } = await adult(ctx), identity = (await ctx.auth.getUserIdentity())!
  if (!identity.emailVerified || !identity.email) throw new ConvexError('Verify the email on your sign-in account first.')
  return { subject, email: identity.email.trim().toLowerCase() }
}
export const deliverySettings = query({ args: {}, handler: async ctx => {
  const { subject } = await adult(ctx), identity = (await ctx.auth.getUserIdentity())!
  const preference = await ctx.db.query('pickupPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  const email = identity.email?.trim().toLowerCase()
  return { verified: !!identity.emailVerified && !!email, email, channel: preference && preference.email === email ? preference.channel : 'email' as const }
} })
export const saveDeliverySettings = mutation({ args: { channel: v.union(v.literal('email'), v.literal('app')) }, handler: async (ctx, { channel }) => {
  const { household } = await adult(ctx), recipient = await verifiedRecipient(ctx)
  const owner = await ctx.db.query('pickupPreferences').withIndex('by_email', q => q.eq('email', recipient.email)).unique()
  if (owner && owner.subject !== recipient.subject) throw new ConvexError('This verified email is already linked to another Daymark account.')
  const previous = await ctx.db.query('pickupPreferences').withIndex('by_subject', q => q.eq('subject', recipient.subject)).unique()
  const value = { householdId: household._id, ...recipient, channel }
  if (previous) await ctx.db.patch(previous._id, value); else await ctx.db.insert('pickupPreferences', value)
} })
export const deliverInApp = internalMutation({ args: { requestId: v.id('pickupRequests'), attemptId: v.id('attempts') }, handler: async (ctx, args) => {
  const r = await ctx.db.get(args.requestId), attempt = await ctx.db.get(args.attemptId)
  if (attempt?.finished) return
  const a = r && await ctx.db.get(r.actionId), approval = a?.approvalId && await ctx.db.get(a.approvalId)
  if (!r || !a || !approval || !attempt?.dispatched || a.attemptId !== attempt._id || a.status !== 'executing' || a.revision !== r.revision || r.deliveryChannel !== 'app' || !r.recipientSubject) throw new ConvexError('This in-app request is no longer available.')
  const reason = await validate(ctx, a, approval)
  if (reason) throw new ConvexError(reason)
  // The visible request and its receipt commit together; a lost response cannot duplicate it.
  await ctx.db.patch(r._id, { status: 'waiting' })
  await finishAttempt(ctx, { attemptId: attempt._id, status: 'waiting', providerId: r._id })
  if (a.payload.followUpAt) {
    await ctx.db.patch(r._id, { followUpStatus: 'scheduled' })
    await ctx.scheduler.runAt(Date.parse(a.payload.followUpAt), internal.pickups.remindInApp, { requestId: r._id })
  }
} })
export const remindInApp = internalMutation({ args: { requestId: v.id('pickupRequests') }, handler: async (ctx, { requestId }) => {
  const r = await ctx.db.get(requestId)
  if (!r || r.deliveryChannel !== 'app' || r.followUpStatus !== 'scheduled') return
  try {
    const { a } = await currentRequest(ctx, r)
    const job = await ctx.db.get(a.jobId)
    if (!job || await routineJobIssue(ctx, job)) { await ctx.db.patch(r._id, { followUpStatus: 'cancelled' }); return }
    const approval = a.approvalId ? await ctx.db.get(a.approvalId) : null
    approvedFollowupTool(a, approval, 'app')
    if (!a.payload.followUpAt || Date.parse(a.payload.followUpAt) > Date.now()) return
    await ctx.db.patch(r._id, { followUpStatus: 'available_in_app', followUpProviderId: r._id })
  } catch { await ctx.db.patch(r._id, { followUpStatus: 'cancelled' }) }
} })
export const inbox = query({ args: {}, handler: async ctx => {
  let recipient
  try { recipient = await verifiedRecipient(ctx) } catch { return [] }
  const requests = await ctx.db.query('pickupRequests').withIndex('by_recipient', q => q.eq('recipientSubject', recipient.subject)).collect()
  const visible = await Promise.all(requests.map(async r => {
    try {
      if (r.deliveryChannel !== 'app' || r.status !== 'waiting') return null
      const { a, h } = await currentRequest(ctx, r), caregiver = await ctx.db.get(r.caregiverId)
      if (caregiver?.email !== recipient.email) return null
      const p = a.payload
      // No household ID, source, calendar, contacts, or other job details leave this boundary.
      return { id: r._id, revision: r.revision, child: h.children.find(c => c.id === p.childId)?.name ?? '', date: p.date, time: p.time as string, timezone: p.timezone, location: p.location, message: p.message, deadline: p.deadline, reminder: r.followUpStatus === 'available_in_app' }
    } catch { return null }
  }))
  return visible.filter(x => x !== null).sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline))
} })
export const respondInApp = mutation({ args: { requestId: v.id('pickupRequests'), revision: v.number(), response: v.union(v.literal('accept'), v.literal('decline'), v.literal('suggest')), suggestion: v.string() }, handler: async (ctx, args) => {
  const recipient = await verifiedRecipient(ctx), r = await ctx.db.get(args.requestId)
  if (!r || r.recipientSubject !== recipient.subject || r.deliveryChannel !== 'app' || r.revision !== args.revision || r.status !== 'waiting') throw new ConvexError('This request is no longer available. Reopen the current request.')
  const { a } = await currentRequest(ctx, r), caregiver = await ctx.db.get(r.caregiverId)
  if (caregiver?.email !== recipient.email) throw new ConvexError('Sign in with the verified email this request was sent to.')
  await ctx.db.patch(r.caregiverId, { verifiedAt: Date.now() })
  await recordResponse(ctx, r, a, args)
} })
