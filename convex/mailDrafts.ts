import { ConvexError, v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult } from './access'
import { mailboxIssue } from './mailbox'
import { validAssistantRun } from './assistantCoordinator'
import { routineBindingsIssue } from './mailRoutines'
import { proposalStale } from './mailFollowthrough'
import { hash } from '../shared/daymark'
import { gmailReplyHash, gmailReplyRoutingSchema, gmailReplySubject } from '../shared/gmailReply'
import { exactSender, gmailReadScope } from '../shared/emailWatches'
import { gmailComposeScope, mailboxRetentionMs, privateReplySchema, type PrivateMailDraft } from '../shared/mailbox'

const input = v.object({ to: v.string(), subject: v.string(), body: v.string() })
const identity = { id: v.id('mailDrafts'), version: v.number() }
const leased = { ...identity, lease: v.string() }
type Context = QueryCtx | MutationCtx
type Draft = Doc<'mailDrafts'>
const leaseMs = 180_000, approvalMs = 10 * 60_000
const draftHash = (value: Draft['input'], replyRouting?: Draft['replyRouting']) => gmailReplyHash(value, replyRouting)

export async function privateDraftOwner(ctx: Context, id: Id<'mailDrafts'>, version?: number) {
  const { household, subject } = await adult(ctx), draft = await ctx.db.get(id)
  if (!draft || draft.householdId !== household._id || draft.createdBy !== subject || draft.expiresAt <= Date.now()) throw new ConvexError('This private reply is unavailable.')
  if (version !== undefined && draft.version !== version) throw new ConvexError('This reply changed. Reopen it before continuing.')
  return draft
}

/** Recheck every binding at the boundary, including same-household adults and deleted sources. */
export async function privateReplySource(ctx: Context, messageId: Id<'mailMessages'>) {
  const message = await ctx.db.get(messageId)
  if (!message || message.expiresAt <= Date.now() || message.dismissed) return null
  const household = await ctx.db.get(message.householdId), mailbox = await ctx.db.get(message.mailboxId), connection = await ctx.db.get(message.connectionId)
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', message.createdBy)).unique()
  if (!household || household.deleted || member?.householdId !== household._id || !mailbox || mailbox.state !== 'active' || mailbox.createdBy !== message.createdBy || mailbox.householdId !== message.householdId || mailbox.connectionId !== message.connectionId || mailbox.connectionVersion !== message.connectionVersion || mailbox.accountKey !== message.accountKey || await mailboxIssue(ctx, mailbox)) return null
  if (!connection || (connection.provider ?? 'google') !== 'google' || connection.subject !== message.createdBy || connection.householdId !== message.householdId || connection.version !== message.connectionVersion || connection.status !== 'active' || !connection.cipher || !connection.scopes.includes(gmailReadScope) || !connection.email || !exactSender(connection.email)) return null
  if (message.threadId) {
    const latest = await ctx.db.query('mailMessages').withIndex('by_thread', q => q.eq('householdId', message.householdId).eq('createdBy', message.createdBy).eq('accountKey', message.accountKey).eq('threadId', message.threadId)).order('desc').first()
    if (latest && latest._id !== message._id && (latest.receivedAt > message.receivedAt || latest.receivedAt === message.receivedAt && latest._creationTime > message._creationTime)) return null
  }
  return { message, connection }
}

export async function mailDraftIssue(ctx: Context, draft: Draft, compose: boolean) {
  if (draft.expiresAt <= Date.now()) return 'This private reply expired. Check the email again.'
  if (draft.mailProposalBinding) {
    const origin = await ctx.db.get(draft.mailProposalBinding.id)
    if (!origin || origin.version !== draft.mailProposalBinding.version || origin.draftId !== draft._id || origin.householdId !== draft.householdId || origin.createdBy !== draft.createdBy || origin.mailboxId !== draft.mailboxId || origin.input.kind !== 'reply' || origin.input.messageId !== draft.messageId || await proposalStale(ctx, origin)) return 'The supporting email preparation changed. Prepare a fresh private reply.'
  }
  if (draft.mailRoutineBindings?.some(binding => binding.householdId !== draft.householdId || binding.createdBy !== draft.createdBy || binding.messageId !== draft.messageId || binding.sourceVersion !== draft.sourceVersion || binding.sourceHash !== draft.sourceHash || binding.mailboxId !== draft.mailboxId || binding.connectionId !== draft.connectionId || binding.connectionVersion !== draft.connectionVersion || binding.accountKey !== draft.accountKey)) return 'The private email routine binding changed. Prepare a fresh reply.'
  const routineIssue = await routineBindingsIssue(ctx, draft.mailRoutineBindings ?? [])
  if (routineIssue) return routineIssue
  if (draft.assistantRunId && !await validAssistantRun(ctx, { householdId: draft.householdId, createdBy: draft.createdBy, assistantRunId: draft.assistantRunId })) return 'The supporting assistant context changed. Ask Sola to prepare a fresh private reply.'
  const current = await privateReplySource(ctx, draft.messageId)
  if (!current || current.message.mailboxId !== draft.mailboxId || current.message.createdBy !== draft.createdBy || current.message.householdId !== draft.householdId || current.message.version !== draft.sourceVersion || current.message.contentHash !== draft.sourceHash || current.message.connectionId !== draft.connectionId || current.message.connectionVersion !== draft.connectionVersion || current.message.accountKey !== draft.accountKey || current.connection.email?.toLowerCase() !== draft.accountEmail) return 'The email or Gmail connection changed. Check the email and prepare a fresh reply.'
  if (draft.replyRouting) {
    const route = gmailReplyRoutingSchema.safeParse(draft.replyRouting), source = gmailReplyRoutingSchema.safeParse(current.message.replyRouting)
    if (!route.success || !source.success || JSON.stringify(route.data) !== JSON.stringify(source.data) || draft.input.subject !== route.data.subject) return 'The original Gmail conversation changed. Prepare a fresh private reply.'
  }
  if (compose && !current.connection.scopes.includes(gmailComposeScope)) return 'Allow saving Gmail drafts, then check the email and review a fresh reply.'
  if (compose && process.env.DAYMARK_ENVIRONMENT !== 'production' && !(process.env.DAYMARK_TEST_GOOGLE_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).includes(draft.accountEmail)) return 'Use an allowlisted dedicated Gmail test account before saving a draft.'
  return null
}

/** Already dispatched effects need account-bound read-back, not a fresh preparation approval.
 * Source corrections must block new writes without preventing verification of an earlier one.
 * Mailbox pause/removal, changed membership/account and revoked grants still stop provider reads.
 */
export async function mailDraftReceiptIssue(ctx: Context, draft: Draft) {
  if (draft.expiresAt <= Date.now()) return 'This private reply expired. Check the email again.'
  const mailbox = await ctx.db.get(draft.mailboxId), connection = await ctx.db.get(draft.connectionId)
  if (!mailbox || mailbox.householdId !== draft.householdId || mailbox.createdBy !== draft.createdBy || mailbox.connectionId !== draft.connectionId || mailbox.connectionVersion !== draft.connectionVersion || mailbox.accountKey !== draft.accountKey || await mailboxIssue(ctx, mailbox)) return 'The Gmail connection or mailbox access changed. Reconnect before checking the earlier result.'
  if (!connection || !connection.cipher || connection.email?.toLowerCase() !== draft.accountEmail || !exactSender(connection.email) || !connection.scopes.includes(gmailComposeScope)) return 'Gmail draft access changed. Reconnect before checking the earlier result.'
  return null
}

async function mailDraftWriteIssue(ctx: Context, draft: Draft) {
  const problem = await mailDraftIssue(ctx, draft, true)
  if (problem) return problem
  if (draft.approvedAt === undefined || draft.approvedAt + approvalMs <= Date.now()) return 'The Gmail draft approval expired. Review the reply again.'
  return null
}

export const list = query({ args: {}, handler: async (ctx): Promise<PrivateMailDraft[]> => {
  const { household, subject } = await adult(ctx)
  const drafts = await ctx.db.query('mailDrafts').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(100)
  const visible: Draft[] = []
  for (const d of drafts) {
    const mailbox = await ctx.db.get(d.mailboxId)
    if (d.expiresAt > Date.now() && mailbox && mailbox.state !== 'removed' && mailbox.householdId === household._id && mailbox.createdBy === subject) visible.push(d)
  }
  return visible.map(d => ({ id: d._id, messageId: d.messageId, sourceVersion: d.sourceVersion, connectionId: d.connectionId, connectionVersion: d.connectionVersion, version: d.version, ...d.input, status: d.status, accountEmail: d.accountEmail, ...(d.replyRouting ? { replyInThread: true } : {}), ...(d.gmailDraftId ? { gmailDraftId: d.gmailDraftId } : {}), ...(d.sentMessageId ? { sentMessageId: d.sentMessageId } : {}), ...(d.sendVerifiedAt ? { sendVerifiedAt: d.sendVerifiedAt } : {}), ...(d.issue ? { issue: d.issue } : {}), createdAt: d.createdAt }))
} })

export const prepare = mutation({ args: { messageId: v.id('mailMessages'), version: v.number(), instruction: v.string() }, handler: async (ctx, args): Promise<Id<'mailDrafts'>> => {
  const { household, subject } = await adult(ctx), current = await privateReplySource(ctx, args.messageId)
  if (!current || current.message.createdBy !== subject || current.message.householdId !== household._id) throw new ConvexError('This private email is unavailable. Check Gmail again.')
  if (current.message.version !== args.version) throw new ConvexError('The email changed. Review its latest content.')
  const instruction = args.instruction.trim()
  if (!instruction || instruction.length > 2000) throw new ConvexError('Describe the reply in 1–2,000 characters.')
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) throw new ConvexError('Reply preparation needs the model connection. No Gmail draft was created.')
  const to = exactSender(current.message.sender)
  if (!to) throw new ConvexError('The sender address is unavailable. A reply cannot be addressed safely.')
  const subjectLine = current.message.replyRouting?.subject ?? gmailReplySubject(current.message.subject)
  const preparationKey = hash(JSON.stringify([args.version, current.message.contentHash, current.message.mailboxId, current.message.connectionId, current.message.connectionVersion, current.message.accountKey, instruction]))
  const existing = (await ctx.db.query('mailDrafts').withIndex('by_preparation', q => q.eq('messageId', args.messageId).eq('preparationKey', preparationKey)).order('desc').take(100)).find(d => d.createdBy === subject && d.expiresAt > Date.now() && d.status !== 'failed')
  if (existing) return existing._id
  const id = await ctx.db.insert('mailDrafts', { householdId: household._id, createdBy: subject, messageId: args.messageId, mailboxId: current.message.mailboxId, sourceVersion: args.version, sourceHash: current.message.contentHash, connectionId: current.message.connectionId, connectionVersion: current.message.connectionVersion, accountKey: current.message.accountKey, accountEmail: current.connection.email!.toLowerCase(), replyRouting: current.message.replyRouting, version: 1, input: { to, subject: subjectLine, body: '' }, instruction, preparationKey, status: 'preparing', createdAt: Date.now(), expiresAt: Math.min(current.message.expiresAt, Date.now() + mailboxRetentionMs) })
  await ctx.scheduler.runAfter(0, internal.gmailDrafts.prepare, { id, version: 1 })
  await ctx.scheduler.runAfter(leaseMs + 10_000, internal.mailDrafts.recover, { id, version: 1 })
  return id
} })

export const edit = mutation({ args: { ...identity, input }, handler: async (ctx, args): Promise<number> => {
  const draft = await privateDraftOwner(ctx, args.id, args.version), problem = await mailDraftIssue(ctx, draft, false)
  if (problem) throw new ConvexError(problem)
  if (!['review', 'failed', 'saved'].includes(draft.status) || draft.sendOperationKey || draft.status !== 'saved' && draft.dispatchedAt !== undefined) throw new ConvexError('This reply cannot be edited while its Gmail save is being checked.')
  const clean = privateReplySchema.parse(args.input), version = draft.version + 1
  if (draft.replyRouting && clean.subject !== draft.replyRouting.subject) throw new ConvexError('Keep the original reply subject to reply in this Gmail conversation.')
  await ctx.db.patch(draft._id, { input: clean, status: 'review', version, ...(draft.status === 'saved' ? { previous: { input: draft.input, operationKey: draft.operationKey!, approvedHash: draft.approvedHash!, replyRouting: draft.replyRouting } } : {}), dispatchedAt: undefined, verifiedAt: undefined, issue: undefined, lease: undefined, leaseUntil: undefined, operationKey: undefined, approvedHash: undefined, approvedAt: undefined })
  return version
} })

/** This approval authorizes one Gmail draft create/update only. Sending is a separate review. */
export const approveSave = mutation({ args: { ...identity, input }, handler: async (ctx, args): Promise<number> => {
  const draft = await privateDraftOwner(ctx, args.id, args.version), problem = await mailDraftIssue(ctx, draft, true)
  if (problem) throw new ConvexError(problem)
  if (!['review', 'saved', 'failed'].includes(draft.status) || draft.sendOperationKey || draft.status !== 'saved' && draft.dispatchedAt !== undefined) throw new ConvexError('This reply already has a save in progress or needs review.')
  const clean = privateReplySchema.parse(args.input), version = draft.version + 1
  if (draft.replyRouting && clean.subject !== draft.replyRouting.subject) throw new ConvexError('Keep the original reply subject to reply in this Gmail conversation.')
  const approvedHash = draftHash(clean, draft.replyRouting), operationKey = hash(`gmail-draft:${draft._id}:${version}:${approvedHash}`)
  await ctx.db.patch(draft._id, { input: clean, version, status: 'saving', writeMode: draft.gmailDraftId ? 'update' : 'create', ...(draft.status === 'saved' ? { previous: { input: draft.input, operationKey: draft.operationKey!, approvedHash: draft.approvedHash!, replyRouting: draft.replyRouting } } : {}), dispatchedAt: undefined, verifiedAt: undefined, approvedHash, approvedAt: Date.now(), operationKey, issue: undefined, lease: undefined, leaseUntil: undefined })
  await ctx.scheduler.runAfter(0, internal.gmailDrafts.save, { id: draft._id, version })
  await ctx.scheduler.runAfter(leaseMs + 10_000, internal.mailDrafts.recover, { id: draft._id, version })
  return version
} })

export const reconcile = mutation({ args: identity, handler: async (ctx, args): Promise<number> => {
  const draft = await privateDraftOwner(ctx, args.id, args.version)
  if (draft.status !== 'uncertain' || !draft.operationKey || !draft.approvedHash || draft.dispatchedAt === undefined) throw new ConvexError('There is no uncertain Gmail draft save to check.')
  if ((draft.leaseUntil ?? 0) > Date.now()) return draft.version
  const problem = await mailDraftReceiptIssue(ctx, draft)
  if (problem) throw new ConvexError(problem)
  const version = draft.version + 1
  await ctx.db.patch(draft._id, { version, lease: undefined, leaseUntil: Date.now() + leaseMs, issue: 'Checking Gmail for the previously approved draft. Nothing will be sent or created.' })
  await ctx.scheduler.runAfter(0, internal.gmailDrafts.reconcile, { id: draft._id, version })
  await ctx.scheduler.runAfter(leaseMs + 10_000, internal.mailDrafts.recover, { id: draft._id, version })
  return version
} })

export const claimPreparation = internalMutation({ args: leased, handler: async (ctx, args) => {
  const draft = await ctx.db.get(args.id)
  if (!draft || draft.version !== args.version || draft.status !== 'preparing' || (draft.leaseUntil ?? 0) > Date.now()) return null
  const problem = await mailDraftIssue(ctx, draft, false)
  if (problem) { await ctx.db.patch(draft._id, { status: 'failed', issue: problem }); return null }
  const message = (await ctx.db.get(draft.messageId))!
  await ctx.db.patch(draft._id, { lease: args.lease, leaseUntil: Date.now() + leaseMs })
  return { to: draft.input.to, subject: draft.input.subject, instruction: draft.instruction, message: { sender: message.sender, subject: message.subject, text: message.text, receivedAt: message.receivedAt, extraction: message.extraction } }
} })

export const prepared = internalMutation({ args: { ...leased, body: v.optional(v.string()) }, handler: async (ctx, args) => {
  const draft = await ctx.db.get(args.id)
  if (!draft || draft.version !== args.version || draft.status !== 'preparing' || draft.lease !== args.lease) return false
  const problem = await mailDraftIssue(ctx, draft, false), clean = args.body ? privateReplySchema.safeParse({ ...draft.input, body: args.body }) : null
  if (problem || !clean?.success) await ctx.db.patch(draft._id, { status: 'failed', issue: problem ?? 'The reply could not be prepared. Nothing was saved to Gmail.', lease: undefined, leaseUntil: undefined, version: draft.version + 1 })
  else await ctx.db.patch(draft._id, { input: clean.data, status: 'review', version: draft.version + 1, issue: undefined, lease: undefined, leaseUntil: undefined })
  return true
} })

export const claimSave = internalMutation({ args: { ...leased, readOnly: v.boolean() }, handler: async (ctx, args) => {
  const draft = await ctx.db.get(args.id)
  if (!draft || draft.version !== args.version || draft.status !== (args.readOnly ? 'uncertain' : 'saving') || draft.lease || !draft.operationKey || !draft.approvedHash || draft.approvedHash !== draftHash(draft.input, draft.replyRouting) || (!args.readOnly && draft.dispatchedAt !== undefined) || (args.readOnly && draft.dispatchedAt === undefined)) return null
  const problem = await (args.readOnly ? mailDraftReceiptIssue(ctx, draft) : mailDraftWriteIssue(ctx, draft))
  if (problem) { await ctx.db.patch(draft._id, { status: draft.dispatchedAt === undefined ? 'failed' : 'uncertain', issue: problem, leaseUntil: undefined }); return null }
  await ctx.db.patch(draft._id, { lease: args.lease, leaseUntil: Date.now() + leaseMs })
  return { connectionId: draft.connectionId, connectionVersion: draft.connectionVersion, accountEmail: draft.accountEmail, input: draft.input, replyRouting: draft.replyRouting, operationKey: draft.operationKey, approvedHash: draft.approvedHash, gmailDraftId: draft.gmailDraftId, writeMode: draft.writeMode, previous: draft.previous }
} })

export const permitted = internalQuery({ args: leased, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  return !!d && d.version === args.version && d.lease === args.lease && (d.leaseUntil ?? 0) > Date.now() && ['saving', 'uncertain'].includes(d.status) && d.approvedHash === draftHash(d.input, d.replyRouting) && !await (d.dispatchedAt !== undefined ? mailDraftReceiptIssue(ctx, d) : mailDraftWriteIssue(ctx, d))
} })

/** Write-ahead journal: a replay cannot cross this mutation a second time. */
export const dispatch = internalMutation({ args: leased, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.version !== args.version || d.lease !== args.lease || (d.leaseUntil ?? 0) <= Date.now() || d.status !== 'saving' || d.dispatchedAt !== undefined || !d.operationKey || d.approvedHash !== draftHash(d.input, d.replyRouting) || await mailDraftWriteIssue(ctx, d)) return false
  await ctx.db.patch(d._id, { dispatchedAt: Date.now() })
  return true
} })

export const recordProviderId = internalMutation({ args: { ...leased, operationKey: v.string(), gmailDraftId: v.string() }, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.operationKey !== args.operationKey || d.dispatchedAt === undefined || !/^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(args.gmailDraftId) || d.gmailDraftId && d.gmailDraftId !== args.gmailDraftId) return false
  // The provider may already have acted when access is revoked; retain evidence without another read/write.
  await ctx.db.patch(d._id, { gmailDraftId: args.gmailDraftId })
  return true
} })

export const finished = internalMutation({ args: { ...leased, operationKey: v.string(), verified: v.boolean(), gmailDraftId: v.optional(v.string()), issue: v.optional(v.string()) }, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.operationKey !== args.operationKey || !['saving', 'uncertain'].includes(d.status)) return false
  if ((d.version !== args.version || d.lease !== args.lease) && d.dispatchedAt === undefined) return false
  if (args.gmailDraftId && (!/^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(args.gmailDraftId) || d.gmailDraftId && d.gmailDraftId !== args.gmailDraftId)) return false
  const verified = args.verified && d.dispatchedAt !== undefined && !!args.gmailDraftId
  await ctx.db.patch(d._id, { status: verified ? 'saved' : d.dispatchedAt !== undefined ? 'uncertain' : 'failed', version: d.version + 1, ...(args.gmailDraftId ? { gmailDraftId: args.gmailDraftId } : {}), ...(verified ? { verifiedAt: Date.now() } : {}), issue: verified ? undefined : args.issue ?? 'The Gmail draft save could not be confirmed. Recheck before doing anything else.', lease: undefined, leaseUntil: undefined })
  return true
} })

export const recover = internalMutation({ args: identity, handler: async (ctx, args) => {
  const d = await ctx.db.get(args.id)
  if (!d || d.version !== args.version || !['preparing', 'saving', 'uncertain'].includes(d.status)) return
  if ((d.leaseUntil ?? 0) > Date.now()) { await ctx.scheduler.runAfter(d.leaseUntil! - Date.now() + 1000, internal.mailDrafts.recover, args); return }
  await ctx.db.patch(d._id, { status: d.dispatchedAt === undefined ? 'failed' : 'uncertain', version: d.version + 1, issue: d.dispatchedAt === undefined ? 'Preparation was interrupted before a Gmail write. Review this reply again.' : 'The save was interrupted. Check Gmail for the approved draft; it will not be created again automatically.', lease: undefined, leaseUntil: undefined })
} })

export const purgeExpired = internalMutation({ args: {}, handler: async ctx => {
  const rows = await ctx.db.query('mailDrafts').withIndex('by_expiry', q => q.lte('expiresAt', Date.now())).take(100)
  for (const row of rows) await ctx.db.delete(row._id)
  if (rows.length === 100) await ctx.scheduler.runAfter(0, internal.mailDrafts.purgeExpired, {})
} })
