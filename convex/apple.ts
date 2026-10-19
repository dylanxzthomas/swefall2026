import { v, ConvexError } from 'convex/values'
import { action, mutation, query, type QueryCtx, type MutationCtx } from './_generated/server'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { adult, sameHousehold } from './access'
import { finishAttempt } from './execution'
import { nativeOperation, type NativeCalendarOperation } from '../shared/nativeCalendar'
import { payloadSchema } from '../shared/daymark'

const deviceId = v.string()
function validDevice(id: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ConvexError('Open this connection on its original iPhone.') }
export const register = mutation({ args: { deviceId, calendarId: v.string(), title: v.string(), account: v.string() }, handler: async (ctx, args) => {
  const { subject, household } = await adult(ctx); validDevice(args.deviceId)
  if (!args.calendarId || args.calendarId.length > 1000 || !args.title || args.title.length > 300 || args.account.length > 300) throw new ConvexError('Choose a writable calendar on this iPhone.')
  const existing = (await ctx.db.query('connections').withIndex('by_subject', q => q.eq('subject', subject)).collect()).find(c => c.provider === 'apple' && c.nativeDeviceId === args.deviceId)
  const fields = { householdId: household._id, subject, provider: 'apple' as const, nativeDeviceId: args.deviceId, status: 'active', scopes: ['calendar.local.full'], calendarId: args.calendarId, calendarName: args.title, email: args.account }
  if (existing && existing.status === 'active' && existing.calendarId === args.calendarId && existing.calendarName === args.title && existing.email === args.account) return { id: existing._id, version: existing.version }
  if (existing) { await ctx.db.patch(existing._id, { ...fields, version: existing.version + 1 }); return { id: existing._id, version: existing.version + 1 } }
  const id = await ctx.db.insert('connections', { ...fields, version: 1 }); return { id, version: 1 }
} })
async function authorized(ctx: QueryCtx | MutationCtx, actionId: Id<'actions'>, installation: string) {
  const { subject, household } = await adult(ctx); validDevice(installation)
  const a = await ctx.db.get(actionId); sameHousehold(a, household._id)
  const approval = a?.approvalId ? await ctx.db.get(a.approvalId) : null
  if (!a || !approval || approval.subject !== subject || approval.provider !== 'apple' || approval.nativeDeviceId !== installation || a.payload.kind !== 'calendar') throw new ConvexError('This Apple Calendar operation belongs to another review or iPhone.')
  return { a, approval }
}
function operation(a: any, approval: any): NativeCalendarOperation {
  const payload = payloadSchema.parse(a.payload)
  if (payload.kind !== 'calendar') throw new ConvexError('Choose a calendar operation.')
  const before = a.before ? { ...nativeOperation('before', 1, 1, { ...a.before.payload, targetId: null }, { calendarId: a.before.calendarId, version: 1 }), eventId: a.before.eventId, fingerprint: a.before.etag } : undefined
  return nativeOperation(`cloud:${a._id}`, approval.revision, approval.sourceRevision, payload, { calendarId: approval.destination, version: approval.connectionVersion ?? 0 }, before)
}
export const pending = query({ args: { deviceId }, handler: async (ctx, args) => {
  const { subject, household } = await adult(ctx); validDevice(args.deviceId)
  const result: { id: Id<'actions'>; approvalId: Id<'approvals'>; status: string; revision: number }[] = []
  for (const a of await ctx.db.query('actions').withIndex('by_household', q => q.eq('householdId', household._id)).collect()) {
    if (!a.approvalId || !['queued', 'executing', 'uncertain'].includes(a.status)) continue
    const approval = await ctx.db.get(a.approvalId)
    if (approval?.provider === 'apple' && approval.subject === subject && approval.nativeDeviceId === args.deviceId) result.push({ id: a._id, approvalId: approval._id, status: a.status, revision: a.revision })
  }
  return result
} })
export const context = query({ args: { actionId: v.id('actions'), deviceId }, handler: async (ctx, args) => {
  const { a, approval } = await authorized(ctx, args.actionId, args.deviceId)
  return { actionId: a._id, approvalId: approval._id, attemptId: a.attemptId, status: a.status, operation: operation(a, approval) }
} })
// The context query checks the signed-in household and original phone; internal execution
// mutations perform their usual source, revision, account and destination checks again.
export const claim = action({ args: { actionId: v.id('actions'), deviceId }, handler: async (ctx, args): Promise<{ attemptId: Id<'attempts'>; operation: NativeCalendarOperation } | null> => {
  const data = await ctx.runQuery(api.apple.context, args)
  const claimed = await ctx.runMutation(internal.execution.claim, { actionId: data.actionId, approvalId: data.approvalId })
  return claimed ? { attemptId: claimed.attemptId, operation: data.operation } : null
} })
export const dispatch = action({ args: { actionId: v.id('actions'), deviceId, attemptId: v.id('attempts') }, handler: async (ctx, args): Promise<boolean> => {
  const data = await ctx.runQuery(api.apple.context, { actionId: args.actionId, deviceId: args.deviceId })
  if (data.attemptId !== args.attemptId) return false
  return ctx.runMutation(internal.execution.dispatch, { attemptId: args.attemptId })
} })
export const finish = mutation({ args: { actionId: v.id('actions'), deviceId, attemptId: v.id('attempts'), status: v.union(v.literal('verified'), v.literal('uncertain'), v.literal('review')), eventId: v.optional(v.string()), fingerprint: v.optional(v.string()), message: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { a, approval } = await authorized(ctx, args.actionId, args.deviceId)
  const attempt = await ctx.db.get(args.attemptId)
  if (!attempt || a.attemptId !== args.attemptId || attempt.approvalId !== approval._id || a.status === 'succeeded') return
  if (attempt.finished && a.status !== 'uncertain') return
  if (args.status === 'verified' && (!attempt.dispatched || !args.eventId || a.payload.operation !== 'delete' && !args.fingerprint)) throw new ConvexError('A native calendar read-back is required.')
  // An uncertain native attempt may return later with read-back evidence; this does not dispatch again.
  if (attempt.finished) await ctx.db.patch(attempt._id, { finished: false })
  await finishAttempt(ctx, { attemptId: attempt._id, status: args.status === 'verified' ? 'succeeded' : args.status, error: args.message?.slice(0, 1000), ...(args.status === 'verified' ? { providerId: args.eventId, etag: args.fingerprint, outcome: a.payload.operation === 'delete' ? 'apple_calendar_deleted' : 'apple_calendar_readback' } : {}) })
  if (args.status === 'review') await ctx.db.patch(a._id, { revision: a.revision + 1, approvalId: undefined, attemptId: undefined })
} })
export const refresh = action({ args: { actionId: v.id('actions'), deviceId, revision: v.number(), payload: v.any(), fingerprint: v.string() }, handler: async (ctx, args): Promise<void> => {
  const data = await ctx.runQuery(api.jobs.calendarRefreshContext, { actionId: args.actionId })
  const owner = await ctx.runQuery(api.apple.refreshContext, { actionId: args.actionId, deviceId: args.deviceId })
  if (owner.revision !== args.revision || data.revision !== args.revision) throw new ConvexError('This review changed. Refresh it again.')
  const payload = payloadSchema.parse(args.payload)
  if (payload.kind !== 'calendar' || !args.fingerprint) throw new ConvexError('Native calendar details are incomplete.')
  await ctx.runMutation(internal.jobs.refreshedBefore, { actionId: args.actionId, revision: args.revision, payload, etag: args.fingerprint })
} })
export const refreshContext = query({ args: { actionId: v.id('actions'), deviceId }, handler: async (ctx, args) => {
  const { subject, household } = await adult(ctx); validDevice(args.deviceId)
  const a = await ctx.db.get(args.actionId); sameHousehold(a, household._id)
  const connection = a?.before?.connectionId ? await ctx.db.get(a.before.connectionId as Id<'connections'>) : null
  if (!a || a.status !== 'review' || a.payload.kind !== 'calendar' || !a.before || connection?.subject !== subject || connection?.provider !== 'apple' || connection.nativeDeviceId !== args.deviceId) throw new ConvexError('Refresh this event on its original iPhone.')
  return { revision: a.revision, eventId: a.before.eventId as string, calendarId: a.before.calendarId as string, payload: payloadSchema.parse(a.before.payload) }
} })
