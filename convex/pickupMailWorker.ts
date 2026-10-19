'use node'
import { randomBytes } from 'node:crypto'
import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { seal, unseal } from './googleCrypto'
import { withGoogle } from './google'
import { hash } from '../shared/daymark'
import { pickupEmailMessage } from '../shared/pickupEmail'
import { sendPickupEmail, findPickupEmail } from './pickupGmailAdapter'
import type { Approved } from './gmailDrafts'

type Material = { invitation: Approved; reminder?: Approved }
const binding = (id: string) => `pickup-mail:${id}`
export const send = internalAction({ args: { actionId: v.id('actions'), attemptId: v.id('attempts') }, handler: async (ctx, args): Promise<void> => {
  const secret = randomBytes(32).toString('hex'), lease = randomBytes(20).toString('hex')
  const current = await ctx.runMutation(internal.pickupMail.claim, { ...args, tokenHash: hash(secret), lease })
  if (!current) return
  const request = { requestId: current.requestId, lease, reminder: false }
  try {
    const proof = current.approval.pickupEmail!
    const make = (reminder: boolean): Approved => {
      const input = { to: proof.to, ...pickupEmailMessage(current.payload as Parameters<typeof pickupEmailMessage>[0], proof.childName, proof.webUrl, secret, reminder) }
      return { accountEmail: proof.accountEmail, input, operationKey: hash(`${reminder ? 'pickup-reminder' : 'pickup-invitation'}:${args.attemptId}:${proof.hash}`), approvedHash: hash(JSON.stringify(input)) }
    }
    const material: Material = { invitation: make(false), ...(proof.reminder ? { reminder: make(true) } : {}) }
    if (!await ctx.runMutation(internal.pickupMail.prepared, { ...request, cipher: seal(material, binding(current.requestId)), operationKey: material.invitation.operationKey, approvedHash: material.invitation.approvedHash, ...(material.reminder ? { reminderOperationKey: material.reminder.operationKey, reminderApprovedHash: material.reminder.approvedHash } : {}) })) throw new Error('The caregiver message changed.')
    const result = await withGoogle(ctx, current.approval, auth => sendPickupEmail(auth, material.invitation, {
      permitted: () => ctx.runMutation(internal.pickupMail.permitted, request),
      sendPermitted: () => ctx.runMutation(internal.pickupMail.sendPermitted, request),
      dispatch: () => ctx.runMutation(internal.execution.dispatch, { attemptId: args.attemptId }),
      recordId: async providerId => { if (!await ctx.runMutation(internal.pickupMail.recordId, { ...request, operationKey: material.invitation.operationKey, providerId })) throw new Error('The email receipt could not be retained.') },
    }))
    await ctx.runMutation(internal.pickupMail.finished, { ...request, verified: result.verified, providerId: result.id })
  } catch { await ctx.runMutation(internal.pickupMail.finished, { ...request, verified: false }) }
} })

export const remind = internalAction({ args: { requestId: v.id('pickupRequests') }, handler: async (ctx, args): Promise<void> => {
  const lease = randomBytes(20).toString('hex'), current = await ctx.runMutation(internal.pickupMail.claimReminder, { ...args, lease })
  if (!current) return
  const request = { ...args, lease, reminder: true }
  try {
    const material = unseal<Material>(current.cipher, binding(args.requestId)), message = material.reminder
    if (!message || message.accountEmail !== current.approval.pickupEmail?.accountEmail || message.input.to !== current.approval.destination) throw new Error('The approved reminder is unavailable.')
    const result = await withGoogle(ctx, current.approval, auth => sendPickupEmail(auth, message, {
      permitted: () => ctx.runMutation(internal.pickupMail.permitted, request),
      sendPermitted: () => ctx.runMutation(internal.pickupMail.sendPermitted, request),
      dispatch: () => ctx.runMutation(internal.pickupMail.dispatchReminder, request),
      recordId: async providerId => { if (!await ctx.runMutation(internal.pickupMail.recordId, { ...request, operationKey: message.operationKey, providerId })) throw new Error('The reminder receipt could not be retained.') },
    }))
    await ctx.runMutation(internal.pickupMail.finished, { ...request, verified: result.verified, providerId: result.id })
  } catch { await ctx.runMutation(internal.pickupMail.finished, { ...request, verified: false }) }
} })

export const reconcile = internalAction({ args: { requestId: v.id('pickupRequests'), reminder: v.boolean() }, handler: async (ctx, args): Promise<void> => {
  const lease = randomBytes(20).toString('hex'), current = await ctx.runMutation(internal.pickupMail.claimRead, { ...args, lease })
  if (!current) return
  const request = { ...args, lease }
  try {
    const material = unseal<Material>(current.cipher, binding(args.requestId)), message = args.reminder ? material.reminder : material.invitation
    if (!message || message.accountEmail !== current.approval.pickupEmail?.accountEmail || message.input.to !== current.approval.destination) throw new Error('The earlier email proof is unavailable.')
    const result = await withGoogle(ctx, current.approval, auth => findPickupEmail(auth, { ...message, sentMessageId: current.providerId }, () => ctx.runMutation(internal.pickupMail.permitted, request)))
    await ctx.runMutation(internal.pickupMail.finished, { ...request, verified: result.verified, ...(result.id ? { providerId: result.id } : {}) })
  } catch { await ctx.runMutation(internal.pickupMail.finished, { ...request, verified: false }) }
} })
