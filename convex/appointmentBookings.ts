import { ConvexError, v } from 'convex/values'
import { mutation, query, internalMutation, internalQuery, type QueryCtx, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult } from './access'
import { sourceHash } from '../shared/daymark'
import { appointmentInputSchema, appointmentHash, verifyAppointment, type AppointmentRecord, type AppointmentEvent } from '../shared/appointmentBooking'

export function appointmentConfiguration(subject: string) {
  const key = process.env.CALCOM_API_KEY, eventTypeId = Number(process.env.CALCOM_EVENT_TYPE_ID), allowed = process.env.CALCOM_PILOT_SUBJECT
  if (!key || !Number.isSafeInteger(eventTypeId) || eventTypeId < 1 || !allowed || allowed !== subject) return null
  return { eventTypeId, configHash: sourceHash(JSON.stringify([key, eventTypeId, allowed])) }
}
async function memberAccess(ctx: Pick<QueryCtx, 'db'>, subject: string) {
  const config = appointmentConfiguration(subject), member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', subject)).unique(), household = member && await ctx.db.get(member.householdId)
  return config && household && !household.deleted ? { householdId: household._id, ...config } : null
}
async function current(ctx: Pick<QueryCtx, 'db'>, row: Doc<'appointmentBookings'>) { const access = await memberAccess(ctx, row.createdBy); return access?.householdId === row.householdId && access.configHash === row.configHash ? access : null }
const rowArgs = { id: v.id('appointmentBookings'), version: v.number() }, leaseArgs = { ...rowArgs, lease: v.string() }
async function owned(ctx: QueryCtx | MutationCtx, args: { id: Id<'appointmentBookings'>; version: number }) {
  const { subject, household } = await adult(ctx), row = await ctx.db.get(args.id)
  if (!row || row.createdBy !== subject || row.householdId !== household._id) throw new ConvexError('This appointment is unavailable.')
  if (row.version !== args.version) throw new ConvexError('This appointment changed. Review its latest version.')
  return row
}
export const settings = query({ args: {}, handler: async ctx => { const { subject } = await adult(ctx); return { configured: !!appointmentConfiguration(subject), provider: 'calcom' as const, scope: 'Dedicated free appointment pilot; not a general booking connector.' } } })
export const access = internalQuery({ args: { subject: v.string() }, handler: async (ctx, { subject }) => memberAccess(ctx, subject) })
export const list = query({ args: {}, handler: async (ctx): Promise<AppointmentRecord[]> => {
  const { subject, household } = await adult(ctx), rows = await ctx.db.query('appointmentBookings').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(50)
  return rows.filter(row => row.status !== 'cancelled' && (row.expiresAt > Date.now() || row.dispatchedAt)).map(row => ({ _id: row._id, version: row.version, status: row.status, input: row.input, event: row.event, slots: row.slots, checkedAt: row.checkedAt, expiresAt: row.expiresAt, providerUid: row.providerUid, verifiedAt: row.verifiedAt, issue: row.issue }))
} })
export const prepared = internalMutation({ args: { subject: v.string(), requestId: v.string(), requestHash: v.string(), configHash: v.string(), event: v.any(), input: v.any(), slots: v.array(v.string()) }, handler: async (ctx, args) => {
  const access = await memberAccess(ctx, args.subject)
  if (!access || access.configHash !== args.configHash || args.event.id !== access.eventTypeId) throw new ConvexError('Appointment configuration or access changed.')
  if (!args.requestId.trim() || args.requestId.length > 100 || args.slots.length > 200) throw new ConvexError('Choose a valid bounded appointment request.')
  const input = appointmentInputSchema.parse(args.input)
  if (!args.slots.includes(input.start)) throw new ConvexError('Choose one of the available appointment slots.')
  const previous = await ctx.db.query('appointmentBookings').withIndex('by_request', q => q.eq('householdId', access.householdId).eq('createdBy', args.subject).eq('requestId', args.requestId)).unique()
  if (previous) { if (previous.requestHash !== args.requestHash) throw new ConvexError('This request identifier was already used.'); return previous._id }
  const recent = await ctx.db.query('appointmentBookings').withIndex('by_owner', q => q.eq('householdId', access.householdId).eq('createdBy', args.subject)).order('desc').take(50)
  if (recent.filter(row => row.status === 'review' && row.expiresAt > Date.now()).length >= 20) throw new ConvexError('Review or remove an existing appointment proposal first.')
  return ctx.db.insert('appointmentBookings', { householdId: access.householdId, createdBy: args.subject, requestId: args.requestId, requestHash: args.requestHash, configHash: access.configHash, event: args.event, eventHash: args.event.hash, input, slots: [...new Set(args.slots)], checkedAt: Date.now(), expiresAt: Date.now() + 10 * 60000, status: 'review', version: 1, createdAt: Date.now(), updatedAt: Date.now() })
} })
function reviewable(row: Doc<'appointmentBookings'>) { if (!['review', 'failed'].includes(row.status) || row.dispatchedAt || row.expiresAt <= Date.now()) throw new ConvexError('Check fresh availability before reviewing this appointment.') }
export const update = mutation({ args: { ...rowArgs, input: v.any() }, handler: async (ctx, args) => { const row = await owned(ctx, args); reviewable(row); if (!await current(ctx, row)) throw new ConvexError('The appointment connection changed.'); const input = appointmentInputSchema.parse(args.input); if (!row.slots.includes(input.start)) throw new ConvexError('Choose an available slot.'); await ctx.db.patch(row._id, { input, status: 'review', version: row.version + 1, issue: undefined, updatedAt: Date.now() }); return row.version + 1 } })
export const approve = mutation({ args: { ...rowArgs, input: v.any(), approved: v.boolean() }, handler: async (ctx, args) => {
  const row = await owned(ctx, args)
  if (row.approvedHash && ['queued', 'dispatching', 'uncertain', 'confirmed', 'pending'].includes(row.status)) { if (row.approvedHash !== appointmentHash(appointmentInputSchema.parse(args.input), row.eventHash)) throw new ConvexError('This approval belongs to another appointment.'); return row._id }
  reviewable(row)
  if (!args.approved || !await current(ctx, row)) throw new ConvexError('Approve the exact appointment using the current connection.')
  const input = appointmentInputSchema.parse(args.input)
  if (!row.slots.includes(input.start) || Date.parse(input.start) <= Date.now()) throw new ConvexError('Choose a current available slot.')
  const duplicateKey = sourceHash(JSON.stringify([row.event.id, input.start, input.email]))
  const matching = await ctx.db.query('appointmentBookings').withIndex('by_duplicate', q => q.eq('householdId', row.householdId).eq('createdBy', row.createdBy).eq('duplicateKey', duplicateKey)).take(25)
  if (matching.some(other => other._id !== row._id && (other.dispatchedAt || other.status === 'queued'))) throw new ConvexError('An approved matching appointment already exists. Check its existing result before creating another.')
  const operationKey = `sola_${crypto.randomUUID().replaceAll('-', '')}`
  await ctx.db.patch(row._id, { input, duplicateKey, approvedHash: appointmentHash(input, row.eventHash), operationKey, approvedAt: Date.now(), status: 'queued', updatedAt: Date.now(), issue: undefined })
  await ctx.scheduler.runAfter(0, internal.calcom.execute, { id: row._id, version: row.version })
  await ctx.scheduler.runAfter(92000, internal.appointmentBookings.recover, {})
  return row._id
} })
export const remove = mutation({ args: rowArgs, handler: async (ctx, args) => { const row = await owned(ctx, args); if (row.dispatchedAt) throw new ConvexError('This booking may already exist. Manage cancellation with the provider; removing a proposal cannot cancel a reservation.'); await ctx.db.patch(row._id, { status: 'cancelled', version: row.version + 1, updatedAt: Date.now(), lease: undefined, leaseUntil: undefined, input: { start: row.input.start, name: 'Removed', email: 'removed@example.invalid', timezone: 'UTC' }, slots: [] }) } })
export const claim = internalMutation({ args: leaseArgs, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.version !== args.version || row.status !== 'queued' || row.dispatchedAt || (row.leaseUntil ?? 0) > Date.now()) return null
  if (!await current(ctx, row) || row.expiresAt <= Date.now() || !row.approvedHash || row.approvedHash !== appointmentHash(row.input, row.eventHash)) { await ctx.db.patch(row._id, { status: 'failed', issue: 'Approval, availability or account access changed. Check fresh availability.', updatedAt: Date.now() }); return null }
  await ctx.db.patch(row._id, { lease: args.lease, leaseUntil: Date.now() + 90000 })
  return row
} })
export const dispatch = internalMutation({ args: { ...leaseArgs, eventHash: v.string(), slot: v.string() }, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.version !== args.version || row.status !== 'queued' || row.lease !== args.lease || (row.leaseUntil ?? 0) <= Date.now() || row.dispatchedAt || !await current(ctx, row) || row.expiresAt <= Date.now() || row.eventHash !== args.eventHash || row.input.start !== args.slot || row.approvedHash !== appointmentHash(row.input, row.eventHash)) return null
  await ctx.db.patch(row._id, { status: 'dispatching', dispatchedAt: Date.now(), updatedAt: Date.now() }) // One durable attempt, before the HTTP request.
  return row
} })
export const recordedUid = internalMutation({ args: { ...leaseArgs, uid: v.string() }, handler: async (ctx, args) => { const row = await ctx.db.get(args.id); if (row && row.version === args.version && row.lease === args.lease && row.status === 'dispatching' && /^[A-Za-z0-9_-]{1,100}$/.test(args.uid)) await ctx.db.patch(row._id, { providerUid: args.uid }) } })
export const failed = internalMutation({ args: leaseArgs, handler: async (ctx, args) => { const row = await ctx.db.get(args.id); if (row && row.version === args.version && row.lease === args.lease && !['confirmed', 'pending'].includes(row.status)) await ctx.db.patch(row._id, { status: row.dispatchedAt ? 'uncertain' : 'failed', issue: row.dispatchedAt ? 'The provider result is not verified. Check the existing booking; nothing will be resubmitted.' : 'Availability or provider checks failed. Review fresh availability.', lease: undefined, leaseUntil: undefined, updatedAt: Date.now() }) } })
export const reconcileContext = internalQuery({ args: { ...rowArgs, subject: v.string() }, handler: async (ctx, args) => { const row = await ctx.db.get(args.id); return row && row.version === args.version && row.createdBy === args.subject && row.dispatchedAt && await current(ctx, row) ? row : null } })
export const verified = internalMutation({ args: { ...rowArgs, operationKey: v.string(), result: v.any() }, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.version !== args.version || !row.dispatchedAt || row.operationKey !== args.operationKey || !['dispatching', 'uncertain', 'confirmed', 'pending'].includes(row.status) || !await current(ctx, row)) return false
  const receipt = verifyAppointment(args.result, row.input, row.event as AppointmentEvent, row.operationKey, row.approvedHash!)
  await ctx.db.patch(row._id, { status: receipt.status, providerUid: receipt.uid, verifiedAt: Date.now(), issue: receipt.status === 'pending' ? 'The provider recorded this request and is waiting for the host to confirm.' : undefined, lease: undefined, leaseUntil: undefined, updatedAt: Date.now() })
  return true
} })
export const recover = internalMutation({ args: {}, handler: async (ctx): Promise<void> => { for (const status of ['queued', 'dispatching'] as const) for (const row of await ctx.db.query('appointmentBookings').withIndex('by_status', q => q.eq('status', status)).take(25)) { if ((row.leaseUntil ?? 0) > Date.now()) continue; if (row.dispatchedAt) await ctx.db.patch(row._id, { status: 'uncertain', lease: undefined, leaseUntil: undefined, issue: 'Execution was interrupted. Check the existing provider result; it will not be resubmitted.', updatedAt: Date.now() }); else await ctx.scheduler.runAfter(0, internal.calcom.execute, { id: row._id, version: row.version }) } } })
