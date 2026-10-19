import { v, ConvexError } from 'convex/values'
import { mutation, query, internalMutation, type MutationCtx } from './_generated/server'
import { adult, remember } from './access'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { nextNotificationTime } from '../shared/notifications'
import { routineJobIssue } from './routineRules'
export const settings = query({ args: {}, handler: async ctx => {
  const { subject } = await adult(ctx), p = await ctx.db.query('notificationPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  return { enabled: p?.enabled ?? false, quietStart: p?.quietStart ?? '20:00', quietEnd: p?.quietEnd ?? '07:00', configured: !!process.env.APNS_PRIVATE_KEY && !!process.env.APNS_TEAM_ID && !!process.env.APNS_KEY_ID }
} })
export const save = mutation({ args: { enabled: v.boolean(), quietStart: v.string(), quietEnd: v.string(), token: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx)
  if (![args.quietStart, args.quietEnd].every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new ConvexError('Confirm quiet hours.')
  if (args.token && !/^[a-f0-9]{32,512}$/i.test(args.token)) throw new ConvexError('Phone registration is unavailable.')
  const p = await ctx.db.query('notificationPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  const value = { householdId: household._id, subject, enabled: args.enabled, quietStart: args.quietStart, quietEnd: args.quietEnd, lastActiveAt: Date.now() }
  if (p) await ctx.db.patch(p._id, value); else await ctx.db.insert('notificationPreferences', value)
  await remember(ctx, household._id, `notifications:${subject}`, { enabled: args.enabled, quietStart: args.quietStart, quietEnd: args.quietEnd })
  if (args.token) {
    const existing = await ctx.db.query('devices').withIndex('by_token', q => q.eq('token', args.token!)).unique()
    if (existing && existing.subject !== subject) throw new ConvexError('Sign out of the previous account on this phone before registering notifications.')
    if (!existing) await ctx.db.insert('devices', { householdId: household._id, subject, token: args.token })
  }
} })
export const presence = mutation({ args: {}, handler: async ctx => {
  const { subject } = await adult(ctx), p = await ctx.db.query('notificationPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  if (p) await ctx.db.patch(p._id, { lastActiveAt: Date.now() })
} })
export const unregister = mutation({ args: { token: v.string() }, handler: async (ctx, { token }) => {
  // Sign-out must still remove this adult's device after household deletion has blocked access.
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) return
  const device = await ctx.db.query('devices').withIndex('by_token', q => q.eq('token', token)).unique()
  if (device?.subject === identity.tokenIdentifier) await ctx.db.delete(device._id)
} })
export async function queueNotice(ctx: MutationCtx, jobId: Id<'jobs'>, kind: 'ready' | 'help', version: string) {
  const job = await ctx.db.get(jobId), household = job && await ctx.db.get(job.householdId)
  if (!job || job.cancelled || job.emailQuiet || job.emailHandling || !household || household.deleted) return
  if (kind === 'ready' && await routineJobIssue(ctx, job)) return
  const p = await ctx.db.query('notificationPreferences').withIndex('by_subject', q => q.eq('subject', job.createdBy)).unique()
  if (!p?.enabled) return
  // One notice for related results from this revision, without any school details in the payload.
  const key = `${jobId}:${kind}:${version}`
  if (await ctx.db.query('notifications').withIndex('by_key', q => q.eq('key', key)).unique()) return
  const id = await ctx.db.insert('notifications', { householdId: household._id, subject: job.createdBy, jobId, kind, key, status: 'queued', createdAt: Date.now() })
  await ctx.scheduler.runAt(nextNotificationTime(Date.now() + 15000, household.timezone, p.quietStart, p.quietEnd), internal.apns.send, { id })
}
export const claim = internalMutation({ args: { id: v.id('notifications') }, handler: async (ctx, { id }) => {
  const n = await ctx.db.get(id)
  if (!n || n.status !== 'queued') return null
  const p = await ctx.db.query('notificationPreferences').withIndex('by_subject', q => q.eq('subject', n.subject)).unique(), h = await ctx.db.get(n.householdId), job = await ctx.db.get(n.jobId)
  const actions = job ? await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).collect() : []
  if (job && n.kind === 'ready' && await routineJobIssue(ctx, job)) { await ctx.db.patch(id, { status: 'suppressed' }); return null }
  if (!p?.enabled || !h || h.deleted || !job || job.cancelled || p.lastActiveAt > Date.now() - 45000 || !job.clarification && !actions.some(a => ['review', 'failed', 'uncertain', ...(n.kind === 'help' ? ['waiting'] : [])].includes(a.status))) { await ctx.db.patch(id, { status: 'suppressed' }); return null }
  const at = nextNotificationTime(Date.now(), h.timezone, p.quietStart, p.quietEnd)
  if (at > Date.now()) { await ctx.scheduler.runAt(at, internal.apns.send, { id }); return null }
  const devices = await ctx.db.query('devices').withIndex('by_subject', q => q.eq('subject', n.subject)).collect()
  await ctx.db.patch(id, { status: devices.length ? 'dispatched' : 'no_registered_phone' })
  return devices.length ? { ...n, tokens: devices.map(d => d.token) } : null
} })
export const finished = internalMutation({ args: { id: v.id('notifications'), accepted: v.boolean(), invalidTokens: v.array(v.string()) }, handler: async (ctx, args) => {
  const n = await ctx.db.get(args.id)
  if (!n || n.status !== 'dispatched') return
  await ctx.db.patch(n._id, { status: args.accepted ? 'provider_accepted' : 'unconfirmed' })
  for (const token of args.invalidTokens) { const d = await ctx.db.query('devices').withIndex('by_token', q => q.eq('token', token)).unique(); if (d?.subject === n.subject) await ctx.db.delete(d._id) }
} })
