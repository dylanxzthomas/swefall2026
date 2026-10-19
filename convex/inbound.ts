import { v, ConvexError } from 'convex/values'
import { query, mutation, internalMutation, internalQuery } from './_generated/server'
import { adult, sameHousehold } from './access'
import { internal } from './_generated/api'
import { start } from '@convex-dev/workflow'
import { sourceHash } from '../shared/daymark'
export const current = query({ args: {}, handler: async ctx => {
  const { household, subject } = await adult(ctx)
  const alias = (await ctx.db.query('forwarding').withIndex('by_household', q => q.eq('householdId', household._id)).collect()).find(a => a.subject === subject)
  return { configured: !!process.env.DAYMARK_INBOUND_DOMAIN && !!process.env.RESEND_WEBHOOK_SECRET, address: alias ? `${alias.alias}@${process.env.DAYMARK_INBOUND_DOMAIN}` : null, sender: alias?.sender, notices: (await ctx.db.query('inbound').withIndex('by_household', q => q.eq('householdId', household._id)).order('desc').take(30)).map(r => ({ id: r._id, status: r.status, reason: r.reason, sender: r.sender, title: r.title, jobId: r.jobId })) }
} })
export const enable = mutation({ args: {}, handler: async ctx => {
  const { household, subject } = await adult(ctx), identity = await ctx.auth.getUserIdentity()
  if (!process.env.DAYMARK_INBOUND_DOMAIN || !process.env.RESEND_WEBHOOK_SECRET) throw new ConvexError('Notice forwarding is not configured.')
  if (!identity?.email || !identity.emailVerified) throw new ConvexError('Verify the email on your sign-in account before enabling forwarding.')
  const old = (await ctx.db.query('forwarding').withIndex('by_household', q => q.eq('householdId', household._id)).collect()).find(a => a.subject === subject)
  const sender = identity.email.toLowerCase()
  if (old) { await ctx.db.patch(old._id, { sender }); return }
  const alias = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
  await ctx.db.insert('forwarding', { householdId: household._id, subject, alias, sender })
} })
export const received = internalMutation({ args: { to: v.array(v.string()), providerId: v.string() }, handler: async (ctx, args) => {
  for (const recipient of args.to.slice(0, 10)) {
    const [name, domain] = recipient.toLowerCase().split('@')
    if (domain !== process.env.DAYMARK_INBOUND_DOMAIN?.toLowerCase()) continue
    const alias = await ctx.db.query('forwarding').withIndex('by_alias', q => q.eq('alias', name)).unique()
    if (!alias || (await ctx.db.get(alias.householdId))?.deleted !== false) continue
    if (await ctx.db.query('inbound').withIndex('by_provider', q => q.eq('aliasId', alias._id).eq('providerId', args.providerId)).unique()) continue
    const id = await ctx.db.insert('inbound', { householdId: alias.householdId, aliasId: alias._id, providerId: args.providerId, status: 'queued', expiresAt: Date.now() + 30 * 86400_000 })
    await ctx.scheduler.runAfter(0, internal.forwarding.ingest, { id })
  }
} })
export const context = internalQuery({ args: { id: v.id('inbound') }, handler: async (ctx, { id }) => {
  const item = await ctx.db.get(id), alias = item && await ctx.db.get(item.aliasId), household = item && await ctx.db.get(item.householdId)
  if (!item || item.status !== 'queued' || !alias || !household || household.deleted || item.expiresAt <= Date.now()) return null
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', alias.subject)).unique()
  return member?.householdId === household._id ? { item, alias } : null
} })
export const held = internalMutation({ args: { id: v.id('inbound'), status: v.string(), reason: v.string(), sender: v.optional(v.string()), title: v.optional(v.string()) }, handler: async (ctx, args) => {
  const r = await ctx.db.get(args.id)
  if (r?.status === 'queued') { const { id, ...details } = args; await ctx.db.patch(id, details) }
} })
export const retry = mutation({ args: { id: v.id('inbound') }, handler: async (ctx, { id }) => {
  const { household } = await adult(ctx), item = await ctx.db.get(id); sameHousehold(item, household._id)
  if (item!.status !== 'failed' || item!.expiresAt <= Date.now()) throw new ConvexError('Only failed, unexpired intake can be retried.')
  await ctx.db.patch(id, { status: 'queued', reason: undefined }); await ctx.scheduler.runAfter(0, internal.forwarding.ingest, { id })
} })
const file = v.object({ storageId: v.id('_storage'), name: v.string(), size: v.number(), mediaType: v.string(), hash: v.string() })
export const commit = internalMutation({ args: { id: v.id('inbound'), text: v.string(), sender: v.string(), title: v.string(), files: v.array(file) }, handler: async (ctx, args) => {
  const item = await ctx.db.get(args.id), alias = item && await ctx.db.get(item.aliasId), household = item && await ctx.db.get(item.householdId)
  if (!item || !alias || !household || household.deleted || item.status !== 'queued' || item.expiresAt <= Date.now() || alias.sender !== args.sender) return false
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', alias.subject)).unique()
  if (member?.householdId !== household._id) return false
  const hash = sourceHash(args.text + (args.files.length ? '\nfiles:' + args.files.map(f => f.hash).join(',') : ''))
  const previous = await ctx.db.query('sources').withIndex('by_hash', q => q.eq('householdId', household._id).eq('hash', hash)).first()
  const oldJob = previous && await ctx.db.query('jobs').withIndex('by_source', q => q.eq('sourceId', previous._id)).first()
  if (oldJob) { await ctx.db.patch(item._id, { status: 'received', jobId: oldJob._id, sender: args.sender, title: args.title }); return false }
  const sourceId = await ctx.db.insert('sources', { householdId: household._id, text: args.text, hash, revision: 1, expiresAt: item.expiresAt })
  const attachmentIds = []
  for (const f of args.files) attachmentIds.push(await ctx.db.insert('attachments', { ...f, householdId: household._id, subject: alias.subject, sourceId, status: 'ready', expiresAt: item.expiresAt }))
  await ctx.db.patch(sourceId, { attachmentIds })
  const jobId = await ctx.db.insert('jobs', { householdId: household._id, sourceId, createdBy: alias.subject, preparing: true, cancelled: false, clarification: '' })
  await ctx.db.patch(item._id, { status: 'received', jobId, sender: args.sender, title: args.title })
  await start(ctx, internal.workflows.prepare, { jobId, sourceRevision: 1 })
  return true
} })
