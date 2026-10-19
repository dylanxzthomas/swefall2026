import { ConvexError, v } from 'convex/values'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { hash, payloadHash } from '../shared/daymark'
import { currentRequest, recordResponse } from './pickups'

const unavailable = 'This private request changed, expired, or is no longer available.'
async function emailRequest(ctx: QueryCtx | MutationCtx, secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new ConvexError(unavailable)
  const request = await ctx.db.query('pickupRequests').withIndex('by_token', q => q.eq('tokenHash', hash(secret))).unique()
  if (!request || request.deliveryChannel === 'app') throw new ConvexError(unavailable)
  return currentRequest(ctx, request)
}

// The link reveals only which verification flow to use. No family details or
// recipient address leave the boundary until the verified identity matches.
export const method = query({ args: { secret: v.string() }, handler: async (ctx, { secret }) => {
  try {
    const { r } = await emailRequest(ctx, secret)
    if (r.emailTransport === 'gmail' && r.verificationMethod !== 'identity' || r.verificationMethod === 'identity' && r.emailTransport !== 'gmail') return null
    return { method: r.emailTransport === 'gmail' ? 'identity' as const : 'code' as const }
  } catch { return null }
} })

async function verifiedRequest(ctx: QueryCtx | MutationCtx, secret: string) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity?.tokenIdentifier || identity.emailVerified !== true || !identity.email) throw new ConvexError('Sign in with the verified caregiver email chosen by the parent.')
  const current = await emailRequest(ctx, secret), { r, a } = current
  if (r.emailTransport !== 'gmail' || r.verificationMethod !== 'identity') throw new ConvexError(unavailable)
  const email = identity.email.trim().toLowerCase()
  const caregiver = await ctx.db.get(r.caregiverId), approval = a.approvalId ? await ctx.db.get(a.approvalId) : null
  if (!email || email !== r.recipientEmail || caregiver?.email.trim().toLowerCase() !== email || !approval || !approval.pickupEmail || approval.destination.trim().toLowerCase() !== email || approval.actionId !== a._id || approval.householdId !== r.householdId || approval.revision !== r.revision || approval.sourceRevision !== a.sourceRevision || approval.payloadHash !== payloadHash(a.payload) || approval.emailTransport !== 'gmail' || approval.verificationMethod !== 'identity' || r.recipientEmail !== approval.destination) throw new ConvexError('Sign in with the verified caregiver email chosen by the parent, or ask for a current request.')
  return { ...current, approval, subject: identity.tokenIdentifier, email }
}

export const view = query({ args: { secret: v.string() }, handler: async (ctx, { secret }) => {
  try {
    const { a, approval } = await verifiedRequest(ctx, secret), p = a.payload
    return { child: approval.pickupEmail!.childName, date: p.date, time: p.time, timezone: p.timezone, location: p.location, message: p.message, deadline: p.deadline }
  } catch { return null }
} })

export const respond = mutation({ args: { secret: v.string(), response: v.union(v.literal('accept'), v.literal('decline'), v.literal('suggest')), suggestion: v.string() }, handler: async (ctx, args) => {
  const { r, a, subject, email } = await verifiedRequest(ctx, args.secret)
  await recordResponse(ctx, r, a, args)
  // Response and independent identity evidence commit atomically, after all
  // current-request, availability and overlap guards succeed.
  await ctx.db.patch(r._id, { responderSubject: subject, responderEmail: email, identityVerifiedAt: Date.now() })
} })
