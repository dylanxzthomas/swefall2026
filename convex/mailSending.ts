import { ConvexError, v } from 'convex/values'
import { mutation, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { mailDraftIssue, mailDraftReceiptIssue, privateDraftOwner } from './mailDrafts'
import { privateReplySchema } from '../shared/mailbox'
import { gmailReplyHash } from '../shared/gmailReply'
import { hash } from '../shared/daymark'

const identity = { id: v.id('mailDrafts'), version: v.number() }
const leased = { ...identity, lease: v.string() }
const leaseMs = 180_000, approvalMs = 10 * 60_000
const input = v.object({ to: v.string(), subject: v.string(), body: v.string() })
const opaqueId = (id: string) => /^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(id)
const digest = (value: Doc<'mailDrafts'>['input'], replyRouting?: Doc<'mailDrafts'>['replyRouting']) => gmailReplyHash(value, replyRouting)
async function issue(ctx: QueryCtx | MutationCtx, d: Doc<'mailDrafts'>, readOnly = false) {
  const problem = await (readOnly || d.sendDispatchedAt !== undefined ? mailDraftReceiptIssue(ctx, d) : mailDraftIssue(ctx, d, true))
  if (problem) return problem
  if (process.env.DAYMARK_ENVIRONMENT !== 'production' && !(process.env.DAYMARK_TEST_EMAIL_RECIPIENTS ?? '').split(',').map(s => s.trim().toLowerCase()).includes(d.input.to.toLowerCase())) return 'Choose an allowlisted test recipient before sending a pilot email.'
  if (!d.gmailDraftId || !opaqueId(d.gmailDraftId) || !d.operationKey || !d.approvedHash || !d.verifiedAt || d.approvedHash !== digest(d.input, d.replyRouting)) return 'Save and verify this exact reply in Gmail Drafts before reviewing a send.'
  if (!readOnly && d.sendDispatchedAt === undefined && d.sendApprovedAt !== undefined && d.sendApprovedAt + approvalMs <= Date.now()) return 'The send approval expired. Review the reply again.'
  return null
}

/** Google compose permission does not replace this exact, separate human approval. */
export const approve = mutation({ args: { ...identity, input }, handler: async (ctx, args) => {
  const d = await privateDraftOwner(ctx, args.id, args.version)
  const clean = privateReplySchema.parse(args.input)
  if (d.replyRouting && clean.subject !== d.replyRouting.subject) throw new ConvexError('Keep the original reply subject to reply in this Gmail conversation.')
  if (d.status !== 'saved' || d.sendOperationKey || digest(clean, d.replyRouting) !== d.approvedHash) throw new ConvexError('Save the current edited reply as a Gmail draft before approving a send.')
  const problem = await issue(ctx, d)
  if (problem) throw new ConvexError(problem)
  const version = d.version + 1, sendOperationKey = hash(`gmail-send:${d._id}:${version}:${digest(clean, d.replyRouting)}`)
  await ctx.db.patch(d._id, { status: 'sending', version, sendOperationKey, sendApprovedHash: digest(clean, d.replyRouting), sendApprovedAt: Date.now(), sendDispatchedAt: undefined, sentMessageId: undefined, sendVerifiedAt: undefined, lease: undefined, leaseUntil: undefined, issue: undefined })
  await ctx.scheduler.runAfter(0, internal.gmailSending.send, { id: d._id, version })
  await ctx.scheduler.runAfter(leaseMs + 10000, internal.mailSending.recover, { id: d._id, version })
  return version
} })

export const reconcile = mutation({ args: identity, handler: async (ctx, args) => {
  const d = await privateDraftOwner(ctx, args.id, args.version)
  if (d.status !== 'send_uncertain' || d.sendDispatchedAt === undefined || !d.sendOperationKey) throw new ConvexError('There is no uncertain send to check.')
  if ((d.leaseUntil ?? 0) > Date.now()) return d.version
  const problem = await issue(ctx, d, true)
  if (problem) throw new ConvexError(problem)
  const version = d.version + 1
  await ctx.db.patch(d._id, { version, lease: undefined, leaseUntil: Date.now() + leaseMs, issue: 'Checking for the exact sent copy. No email will be sent again.' })
  await ctx.scheduler.runAfter(0, internal.gmailSending.reconcile, { id: d._id, version })
  await ctx.scheduler.runAfter(leaseMs + 10000, internal.mailSending.recover, { id: d._id, version })
  return version
} })

export const reviewAgain = mutation({ args: identity, handler: async (ctx, args) => {
  const d = await privateDraftOwner(ctx, args.id, args.version)
  if (d.status !== 'send_failed' || d.sendDispatchedAt !== undefined) throw new ConvexError('An attempted send cannot be repeated. Check its result first.')
  if (d.mailRoutineBindings?.length || d.mailProposalBinding) { const problem = await mailDraftIssue(ctx, d, true); if (problem) throw new ConvexError(problem) }
  const version = d.version + 1
  await ctx.db.patch(d._id, { version, status: 'saved', sendOperationKey: undefined, sendApprovedHash: undefined, sendApprovedAt: undefined, issue: undefined, lease: undefined, leaseUntil: undefined })
  return version
} })

export const claim = internalMutation({ args: { ...leased, readOnly: v.boolean() }, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.version !== args.version || d.status !== (args.readOnly ? 'send_uncertain' : 'sending') || d.lease || !d.sendOperationKey || d.sendApprovedHash !== digest(d.input, d.replyRouting) || (args.readOnly ? d.sendDispatchedAt === undefined : d.sendDispatchedAt !== undefined)) return null
  const problem = await issue(ctx, d, args.readOnly)
  if (problem) { await ctx.db.patch(d._id, { status: d.sendDispatchedAt === undefined ? 'send_failed' : 'send_uncertain', issue: problem, leaseUntil: undefined }); return null }
  await ctx.db.patch(d._id, { lease: args.lease, leaseUntil: Date.now() + leaseMs })
  return { connectionId: d.connectionId, connectionVersion: d.connectionVersion, accountEmail: d.accountEmail, input: d.input, replyRouting: d.replyRouting, gmailDraftId: d.gmailDraftId!, operationKey: d.sendOperationKey, approvedHash: d.sendApprovedHash!, previous: { input: d.input, operationKey: d.operationKey!, approvedHash: d.approvedHash!, replyRouting: d.replyRouting }, sentMessageId: d.sentMessageId }
} })

export const permitted = internalQuery({ args: { ...leased, readOnly: v.boolean() }, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  return !!d && d.version === args.version && d.lease === args.lease && (d.leaseUntil ?? 0) > Date.now() && ['sending', 'send_uncertain'].includes(d.status) && d.sendApprovedHash === digest(d.input, d.replyRouting) && !await issue(ctx, d, args.readOnly)
} })

export const dispatch = internalMutation({ args: leased, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.version !== args.version || d.lease !== args.lease || (d.leaseUntil ?? 0) <= Date.now() || d.status !== 'sending' || d.sendDispatchedAt !== undefined || !d.sendOperationKey || d.sendApprovedHash !== digest(d.input, d.replyRouting) || await issue(ctx, d)) return false
  await ctx.db.patch(d._id, { sendDispatchedAt: Date.now() })
  return true
} })

export const recordId = internalMutation({ args: { ...leased, operationKey: v.string(), sentMessageId: v.string() }, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.sendOperationKey !== args.operationKey || d.sendDispatchedAt === undefined || !opaqueId(args.sentMessageId) || d.sentMessageId && d.sentMessageId !== args.sentMessageId) return false
  await ctx.db.patch(d._id, { sentMessageId: args.sentMessageId })
  return true
} })

export const finished = internalMutation({ args: { ...leased, operationKey: v.string(), verified: v.boolean(), sentMessageId: v.optional(v.string()) }, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.sendOperationKey !== args.operationKey || !['sending', 'send_uncertain'].includes(d.status) || (d.version !== args.version || d.lease !== args.lease) && d.sendDispatchedAt === undefined) return false
  if (args.sentMessageId && (!opaqueId(args.sentMessageId) || d.sentMessageId && d.sentMessageId !== args.sentMessageId)) return false
  const verified = args.verified && d.sendDispatchedAt !== undefined && !!args.sentMessageId
  await ctx.db.patch(d._id, { status: verified ? 'sent' : d.sendDispatchedAt === undefined ? 'send_failed' : 'send_uncertain', version: d.version + 1, ...(args.sentMessageId ? { sentMessageId: args.sentMessageId } : {}), ...(verified ? { sendVerifiedAt: Date.now() } : {}), issue: verified ? undefined : d.sendDispatchedAt === undefined ? 'Sending stopped before dispatch. Review the saved draft and connection.' : 'The send result is unconfirmed. Check for the sent copy; Sola will not automatically send it again.', lease: undefined, leaseUntil: undefined })
  return true
} })

export const recover = internalMutation({ args: identity, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.version !== args.version || !['sending', 'send_uncertain'].includes(d.status)) return
  if ((d.leaseUntil ?? 0) > Date.now()) { await ctx.scheduler.runAfter(d.leaseUntil! - Date.now() + 1000, internal.mailSending.recover, args); return }
  await ctx.db.patch(d._id, { status: d.sendDispatchedAt === undefined ? 'send_failed' : 'send_uncertain', version: d.version + 1, issue: d.sendDispatchedAt === undefined ? 'Sending was interrupted before dispatch. Review the saved draft again.' : 'Sending was interrupted. Check the sent copy before taking any further action.', lease: undefined, leaseUntil: undefined })
} })
