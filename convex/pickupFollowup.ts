'use node'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { seal, unseal } from './googleCrypto'
import { deliver } from './transactional'
export const schedule = internalAction({ args: { requestId: v.id('pickupRequests'), secret: v.string() }, handler: async (ctx, args): Promise<void> => {
  const cipher = seal(args.secret, `pickup-followup:${args.requestId}`)
  await ctx.runMutation(internal.pickups.scheduleFollowup, { requestId: args.requestId, cipher })
} })
export const send = internalAction({ args: { requestId: v.id('pickupRequests') }, handler: async (ctx, args): Promise<void> => {
  const request = await ctx.runMutation(internal.pickups.claimFollowup, args)
  if (!request) return
  let dispatched = false
  try {
    const secret = unseal<string>(request.cipher, `pickup-followup:${args.requestId}`)
    const root = process.env.DAYMARK_WEB_URL
    if (!root?.startsWith('https://')) throw new Error('Private reply page unavailable.')
    dispatched = true
    const providerId = await deliver(request.email, 'One reminder: Daymark pickup request', `${request.message}\n\nChild: ${request.child}\nPickup: ${request.date} ${request.time} (${request.timezone})\nLocation: ${request.location}\nReply before: ${request.deadline}\n\nVerify and respond: ${root}/#pickup=${secret}\n\nThis is the one reminder approved by the parent.`, `pickup-followup-${args.requestId}`)
    await ctx.runMutation(internal.pickups.followupFinished, { ...args, status: 'accepted', providerId })
  } catch { await ctx.runMutation(internal.pickups.followupFinished, { ...args, status: dispatched ? 'uncertain' : 'failed' }) }
} })
