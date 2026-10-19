import { ConvexError, v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult } from './access'
import { mailboxIssue, privateMessage } from './mailbox'
import { sourceHash } from '../shared/daymark'
import { attachmentExtractionSchema, attachmentSupport, mailAttachmentLimits, opaqueMailPart } from '../shared/mailAttachments'

type Context = Pick<QueryCtx, 'db'>
type Attachment = Doc<'mailAttachments'>
const identity = { id: v.id('mailAttachments'), version: v.number() }
const leased = { ...identity, lease: v.string() }
const descriptor = v.object({ partId: v.string(), attachmentId: v.optional(v.string()), filename: v.string(), mimeType: v.string(), size: v.number(), descriptorHash: v.string(), supported: v.boolean(), issue: v.optional(v.string()) })

/** Same-household membership does not confer access to a connected adult's mail. */
export async function attachmentContext(ctx: Context, row: Attachment) {
  const message = await ctx.db.get(row.messageId), mailbox = await ctx.db.get(row.mailboxId)
  if (!message || !mailbox || row.expiresAt <= Date.now() || message.expiresAt <= Date.now() || message.dismissed || message.version !== row.messageVersion || message.contentHash !== row.messageHash || message.createdBy !== row.createdBy || message.householdId !== row.householdId || message.mailboxId !== row.mailboxId || message.providerId !== row.providerId || message.connectionId !== row.connectionId || message.connectionVersion !== row.connectionVersion || message.accountKey !== row.accountKey || mailbox.version !== row.mailboxVersion || mailbox.createdBy !== row.createdBy || mailbox.householdId !== row.householdId || mailbox.connectionId !== row.connectionId || mailbox.connectionVersion !== row.connectionVersion || mailbox.accountKey !== row.accountKey || await mailboxIssue(ctx, mailbox)) return null
  return { message, mailbox }
}
async function owned(ctx: QueryCtx | MutationCtx, id: Id<'mailAttachments'>, version?: number) {
  const { household, subject } = await adult(ctx), row = await ctx.db.get(id)
  if (!row || row.householdId !== household._id || row.createdBy !== subject || !await attachmentContext(ctx, row)) throw new ConvexError('This private attachment is unavailable. Check its email again.')
  if (version !== undefined && row.version !== version) throw new ConvexError('This attachment changed. Reopen it before continuing.')
  return row
}
export const discoveryContext = query({ args: { messageId: v.id('mailMessages'), version: v.number() }, handler: async (ctx, args) => {
  const current = await privateMessage(ctx, args.messageId, args.version)
  if (current.message.dismissed) throw new ConvexError('This private email is unavailable.')
  const connection = await ctx.db.get(current.mailbox.connectionId)
  return { message: current.message, mailboxVersion: current.mailbox.version, accountEmail: connection!.email! }
} })
export const discoveryPermitted = internalQuery({ args: { messageId: v.id('mailMessages'), messageVersion: v.number(), messageHash: v.string(), mailboxVersion: v.number() }, handler: async (ctx, args) => {
  const message = await ctx.db.get(args.messageId)
  if (!message || message.version !== args.messageVersion || message.contentHash !== args.messageHash || message.dismissed || message.expiresAt <= Date.now()) return false
  const mailbox = await ctx.db.get(message.mailboxId)
  return !!mailbox && mailbox.version === args.mailboxVersion && mailbox.createdBy === message.createdBy && mailbox.householdId === message.householdId && mailbox.connectionId === message.connectionId && mailbox.connectionVersion === message.connectionVersion && mailbox.accountKey === message.accountKey && !await mailboxIssue(ctx, mailbox)
} })
export const discovered = internalMutation({ args: { messageId: v.id('mailMessages'), messageVersion: v.number(), messageHash: v.string(), mailboxVersion: v.number(), descriptors: v.array(descriptor) }, handler: async (ctx, args) => {
  const message = await ctx.db.get(args.messageId)
  if (!message || message.version !== args.messageVersion || message.contentHash !== args.messageHash || message.dismissed || message.expiresAt <= Date.now()) return false
  const mailbox = await ctx.db.get(message.mailboxId)
  if (!mailbox || mailbox.version !== args.mailboxVersion || mailbox.createdBy !== message.createdBy || mailbox.householdId !== message.householdId || mailbox.connectionId !== message.connectionId || mailbox.connectionVersion !== message.connectionVersion || mailbox.accountKey !== message.accountKey || await mailboxIssue(ctx, mailbox)) return false
  if (args.descriptors.length > mailAttachmentLimits.descriptors || new Set(args.descriptors.map(d => d.partId)).size !== args.descriptors.length) throw new Error('Invalid attachment descriptor count.')
  for (const d of args.descriptors) {
    if (!opaqueMailPart(d.partId) || d.attachmentId && !opaqueMailPart(d.attachmentId) || d.filename.length > 180 || d.mimeType.length > 100) throw new Error('Invalid attachment descriptor.')
    const base = { partId: d.partId, ...(d.attachmentId ? { attachmentId: d.attachmentId } : {}), filename: d.filename, mimeType: d.mimeType, size: d.size }
    if (d.descriptorHash !== sourceHash(JSON.stringify(base))) throw new Error('Invalid attachment descriptor fingerprint.')
    const issue = attachmentSupport(d.mimeType, d.size) ?? (!d.supported ? 'This attachment has no readable provider content.' : null)
    const old = await ctx.db.query('mailAttachments').withIndex('by_key', q => q.eq('mailboxId', mailbox._id).eq('providerId', message.providerId).eq('partId', d.partId)).unique()
    if (old && old.messageVersion === message.version && old.messageHash === message.contentHash && old.descriptorHash === d.descriptorHash && old.mailboxVersion === mailbox.version && old.connectionVersion === message.connectionVersion && old.expiresAt > Date.now()) continue
    const fields = { ...base, descriptorHash: d.descriptorHash, householdId: message.householdId, createdBy: message.createdBy, mailboxId: mailbox._id, mailboxVersion: mailbox.version, connectionId: message.connectionId, connectionVersion: message.connectionVersion, accountKey: message.accountKey, messageId: message._id, messageVersion: message.version, messageHash: message.contentHash, providerId: message.providerId, status: issue ? 'unsupported' as const : 'available' as const, attempts: 0, expiresAt: message.expiresAt, updatedAt: Date.now(), ...(issue ? { issue } : {}) }
    if (old) await ctx.db.patch(old._id, { ...fields, version: old.version + 1, consentedAt: undefined, text: undefined, summary: undefined, incomplete: undefined, issues: undefined, contentHash: undefined, byteHash: undefined, extractionMethod: undefined, lease: undefined, leaseUntil: undefined, ...(!issue ? { issue: undefined } : {}) })
    else await ctx.db.insert('mailAttachments', { ...fields, version: 1, createdAt: Date.now() })
  }
  const present = new Set(args.descriptors.map(d => d.partId))
  for (const old of await ctx.db.query('mailAttachments').withIndex('by_message', q => q.eq('messageId', message._id)).collect()) if (!present.has(old.partId)) await ctx.db.delete(old._id)
  return true
} })
export const list = query({ args: { messageId: v.optional(v.id('mailMessages')) }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx)
  const rows = args.messageId ? await ctx.db.query('mailAttachments').withIndex('by_message', q => q.eq('messageId', args.messageId!)).take(12) : await ctx.db.query('mailAttachments').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(100)
  const result = []
  for (const row of rows) if (row.householdId === household._id && row.createdBy === subject && await attachmentContext(ctx, row)) result.push({ id: row._id, version: row.version, descriptorHash: row.descriptorHash, messageId: row.messageId, filename: row.filename, mimeType: row.mimeType, size: row.size, status: row.status, text: row.text, summary: row.summary, incomplete: row.incomplete, issues: row.issues, extractionMethod: row.extractionMethod, issue: row.issue, expiresAt: row.expiresAt, updatedAt: row.updatedAt, retryable: row.status === 'failed' && row.attempts < mailAttachmentLimits.attempts })
  return result
} })
export const read = mutation({ args: { ...identity, descriptorHash: v.string(), consent: v.literal(true) }, handler: async (ctx, args): Promise<number> => {
  const row = await owned(ctx, args.id)
  if (args.descriptorHash !== row.descriptorHash) throw new ConvexError('The attachment changed. Review its current details.')
  // A repeated click from the same descriptor never creates another read/model call.
  if (['queued', 'running', 'complete'].includes(row.status)) return row.version
  if (row.version !== args.version) throw new ConvexError('This attachment changed. Reopen it before continuing.')
  if (!['available', 'failed'].includes(row.status) || row.attempts >= mailAttachmentLimits.attempts || attachmentSupport(row.mimeType, row.size)) throw new ConvexError('This attachment cannot be read. Use a supported smaller file or check Gmail again.')
  if (row.mimeType === 'application/pdf' || row.mimeType.startsWith('image/')) if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) throw new ConvexError('Reading PDFs and images needs the configured model connection.')
  const version = row.version + 1
  await ctx.db.patch(row._id, { status: 'queued', version, consentedAt: Date.now(), issue: undefined, lease: undefined, leaseUntil: undefined, updatedAt: Date.now() })
  await ctx.scheduler.runAfter(0, internal.gmailAttachments.read, { id: row._id, version })
  return version
} })
export const claim = internalMutation({ args: leased, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.version !== args.version || !['queued', 'running'].includes(row.status) || row.leaseUntil && row.leaseUntil > Date.now() || row.consentedAt === undefined) return null
  const context = await attachmentContext(ctx, row)
  if (!context) { await ctx.db.patch(row._id, { status: 'cancelled', lease: undefined, leaseUntil: undefined, issue: 'The email or Gmail access changed. Check the email again.', updatedAt: Date.now() }); return null }
  if (row.attempts >= mailAttachmentLimits.attempts) { await ctx.db.patch(row._id, { status: 'failed', issue: 'The private reading attempt limit was reached.', lease: undefined, leaseUntil: undefined, updatedAt: Date.now() }); return null }
  await ctx.db.patch(row._id, { status: 'running', attempts: row.attempts + 1, lease: args.lease, leaseUntil: Date.now() + mailAttachmentLimits.leaseMs, updatedAt: Date.now() })
  await ctx.scheduler.runAfter(mailAttachmentLimits.leaseMs + 1000, internal.mailAttachments.recover, { id: row._id, version: row.version })
  const connection = await ctx.db.get(row.connectionId)
  return { ...row, accountEmail: connection!.email! }
} })
async function held(ctx: Context, args: { id: Id<'mailAttachments'>; version: number; lease: string }) {
  const row = await ctx.db.get(args.id)
  return row && row.status === 'running' && row.version === args.version && row.lease === args.lease && (row.leaseUntil ?? 0) > Date.now() && await attachmentContext(ctx, row) ? row : null
}
export const permitted = internalQuery({ args: leased, handler: async (ctx, args) => !!await held(ctx, args) })
export const finish = internalMutation({ args: { ...leased, output: v.string(), byteHash: v.string(), extractionMethod: v.union(v.literal('utf8'), v.literal('model')) }, handler: async (ctx, args) => {
  const row = await held(ctx, args)
  if (!row) return false
  if (args.output.length > 125000 || !/^[a-f0-9]{64}$/.test(args.byteHash) || (args.extractionMethod === 'utf8') !== row.mimeType.startsWith('text/')) throw new Error('Invalid private extraction.')
  const result = attachmentExtractionSchema.parse(JSON.parse(args.output))
  if (!result.text.trim()) throw new Error('This attachment contained no readable text.')
  const issues = args.extractionMethod === 'model' ? ['Machine transcription; verify dates, names and numbers against the original.', ...result.issues].slice(0, 6) : result.issues
  const output = { ...result, issues, incomplete: args.extractionMethod === 'model' || result.incomplete }
  await ctx.db.patch(row._id, { ...output, byteHash: args.byteHash, extractionMethod: args.extractionMethod, contentHash: sourceHash(JSON.stringify([row.descriptorHash, args.byteHash, output])), status: 'complete', version: row.version + 1, issue: undefined, lease: undefined, leaseUntil: undefined, updatedAt: Date.now() })
  return true
} })
export const failed = internalMutation({ args: { ...leased, code: v.union(v.literal('access_changed'), v.literal('unavailable'), v.literal('unsupported'), v.literal('model_unavailable')) }, handler: async (ctx, args) => {
  const row = await held(ctx, args)
  if (!row) return false
  const issue = { access_changed: 'The Gmail account or attachment changed. Check the email again.', unavailable: 'Gmail could not provide this attachment. Retry or check the email again.', unsupported: 'This file could not be read safely. Use an unencrypted 1–10 page PDF, PNG, JPEG or UTF-8 text within the reading limits.', model_unavailable: 'The model could not read this attachment. No task or external action was created.' }[args.code]
  await ctx.db.patch(row._id, { status: args.code === 'unsupported' ? 'unsupported' : 'failed', issue, version: row.version + 1, lease: undefined, leaseUntil: undefined, updatedAt: Date.now() })
  return true
} })
export const recover = internalMutation({ args: identity, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.version !== args.version || !['queued', 'running'].includes(row.status) || (row.leaseUntil ?? 0) > Date.now()) return
  await ctx.scheduler.runAfter(0, internal.gmailAttachments.read, args)
} })
export type AttachmentReference = { id: Id<'mailAttachments'>; version: number; contentHash: string; expiresAt: number }
/** Read-only, private source material. OCR is explicitly distinguished from original text. */
export async function completedAttachmentContext(ctx: Context, householdId: Id<'households'>, subject: string, messageId?: Id<'mailMessages'>) {
  const rows = messageId ? await ctx.db.query('mailAttachments').withIndex('by_message', q => q.eq('messageId', messageId)).take(12) : await ctx.db.query('mailAttachments').withIndex('by_owner', q => q.eq('householdId', householdId).eq('createdBy', subject)).order('desc').take(100)
  const result = []
  for (const row of rows) if (row.householdId === householdId && row.createdBy === subject && row.status === 'complete' && row.consentedAt !== undefined && row.text && row.contentHash && await attachmentContext(ctx, row)) result.push({ id: row._id, version: row.version, contentHash: row.contentHash, expiresAt: row.expiresAt, messageId: row.messageId, filename: row.filename, text: row.text.slice(0, 4000), summary: row.summary ?? '', incomplete: row.incomplete ?? true, issues: row.issues ?? [], extractionMethod: row.extractionMethod ?? 'model' })
  return result.slice(0, 6)
}
export async function validAttachmentReferences(ctx: Context, householdId: Id<'households'>, subject: string, refs: readonly AttachmentReference[]) {
  if (refs.length > 6 || new Set(refs.map(r => r.id)).size !== refs.length) return false
  for (const ref of refs) {
    const row = await ctx.db.get(ref.id)
    if (!row || row.householdId !== householdId || row.createdBy !== subject || row.status !== 'complete' || row.consentedAt === undefined || row.version !== ref.version || row.contentHash !== ref.contentHash || row.expiresAt !== ref.expiresAt || !await attachmentContext(ctx, row)) return false
  }
  return true
}
