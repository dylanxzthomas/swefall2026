'use node'
import { randomBytes } from 'node:crypto'
import { ConvexError, v } from 'convex/values'
import { action, internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { appointmentEvent, appointmentWindowSchema, appointmentHash, verifyAppointment, type AppointmentInput, type AppointmentEvent } from '../shared/appointmentBooking'
import { sourceHash } from '../shared/daymark'

// Cal.com versions are endpoint-specific. These are pinned to the current primary API contract.
// https://cal.com/docs/api-reference/v2/bookings/create-a-booking
// https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type
export class CalcomProvider {
  constructor(private readonly key: string, private readonly request: typeof fetch = fetch) {}
  private async call(path: string, version: string, body?: unknown): Promise<any> {
    const response = await this.request(`https://api.cal.com/v2/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.key}`, 'cal-api-version': version, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error('The appointment provider rejected this request.') // Never echo response bodies, credentials or attendee information.
    if (Number(response.headers.get('content-length') ?? 0) > 250000) throw new Error('The appointment provider response exceeded its limit.')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('The appointment provider returned no response body.')
    const chunks: Uint8Array[] = []; let size = 0
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 250000) throw new Error('The appointment provider response exceeded its limit.'); chunks.push(chunk.value) } } finally { await reader.cancel().catch(() => {}) }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const result = JSON.parse(text)
    if (result.status !== 'success' || !result.data || typeof result.data !== 'object') throw new Error('The appointment provider response was incomplete.')
    return result.data
  }
  async event(id: number): Promise<AppointmentEvent> { return appointmentEvent(await this.call(`event-types/${id}`, '2026-06-12'), id) }
  async slots(id: number, from: string, through: string): Promise<string[]> {
    const query = new URLSearchParams({ eventTypeId: String(id), start: from, end: through, timeZone: 'UTC' }), data = await this.call(`slots?${query}`, '2024-09-04')
    if (Array.isArray(data) || Object.keys(data).length > 8) throw new Error('The provider returned an invalid availability window.')
    const slots: string[] = []
    for (const [date, rows] of Object.entries(data)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(rows) || rows.length > 200) throw new Error('The provider returned malformed availability.')
      for (const row of rows) { const time = Date.parse((row as { start?: string })?.start ?? ''); if (!Number.isFinite(time) || time < Date.parse(from) || time > Date.parse(through)) throw new Error('The provider returned a slot outside the requested window.'); slots.push(new Date(time).toISOString()) }
    }
    if (slots.length > 200) throw new Error('Choose a shorter availability window.')
    return [...new Set(slots)].sort()
  }
  async create(input: AppointmentInput, event: AppointmentEvent, operationKey: string) {
    // No conflicts/booking-limit overrides, payment, instant, recurrence, guest, routing or arbitrary URL fields.
    return this.call('bookings', '2026-02-25', { start: input.start, eventTypeId: event.id, attendee: { name: input.name, email: input.email, timeZone: input.timezone, language: 'en' }, leadEnrichmentOptOut: true, metadata: { solaOperation: operationKey, solaHash: appointmentHash(input, event.hash) } })
  }
  async booking(uid: string): Promise<unknown> { if (!/^[A-Za-z0-9_-]{1,100}$/.test(uid)) throw new Error('Invalid provider booking identifier.'); return this.call(`bookings/${encodeURIComponent(uid)}`, '2026-02-25') }
  async find(input: AppointmentInput, event: AppointmentEvent, operationKey: string, hash: string): Promise<unknown | null> {
    // Bounded read-only recovery. A missing operation marker never permits another create.
    const query = new URLSearchParams({ attendeeEmail: input.email, afterStart: new Date(Date.parse(input.start) - 1000).toISOString(), beforeEnd: new Date(Date.parse(input.start) + (event.duration + 1) * 60000).toISOString(), limit: '100' })
    const rows = await this.call(`bookings?${query}`, '2026-05-01')
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('The provider returned an invalid booking list.')
    const matching = rows.filter(row => row?.metadata?.solaOperation === operationKey)
    if (matching.length !== 1) return null
    const checked = verifyAppointment(matching[0], input, event, operationKey, hash)
    return this.booking(checked.uid)
  }
}
export const inspect = action({ args: { requestId: v.string(), from: v.string(), through: v.string(), name: v.string(), email: v.string(), timezone: v.string() }, handler: async (ctx, args): Promise<string> => {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new ConvexError('Sign in before checking appointment availability.')
  const access = await ctx.runQuery(internal.appointmentBookings.access, { subject: identity.tokenIdentifier })
  if (!access) throw new ConvexError('The restricted Cal.com pilot is not configured for this account.')
  const { requestId, ...raw } = args, window = appointmentWindowSchema.parse(raw)
  if (Date.parse(window.from) <= Date.now() || Date.parse(window.through) > Date.now() + 366 * 86400_000) throw new ConvexError('Choose a future appointment window within one year.')
  try {
    const provider = new CalcomProvider(process.env.CALCOM_API_KEY!), [event, slots] = await Promise.all([provider.event(access.eventTypeId), provider.slots(access.eventTypeId, window.from, window.through)])
    if (!slots.length) throw new ConvexError('No available slots were returned in this window.')
    return await ctx.runMutation(internal.appointmentBookings.prepared, { subject: identity.tokenIdentifier, requestId, requestHash: sourceHash(JSON.stringify(window)), configHash: access.configHash, event, input: { start: slots[0], name: window.name, email: window.email, timezone: window.timezone }, slots })
  } catch { throw new ConvexError('Availability could not be prepared. Confirm a free, ordinary Cal.com test event without payment, recurrence or extra verification; try again with a shorter window.') }
} })
export const execute = internalAction({ args: { id: v.id('appointmentBookings'), version: v.number() }, handler: async (ctx, args): Promise<void> => {
  const lease = { ...args, lease: randomBytes(20).toString('hex') }, row = await ctx.runMutation(internal.appointmentBookings.claim, lease)
  if (!row) return
  try {
    const provider = new CalcomProvider(process.env.CALCOM_API_KEY!), [event, slots] = await Promise.all([provider.event(row.event.id), provider.slots(row.event.id, row.input.start, new Date(Date.parse(row.input.start) + 1000).toISOString())])
    if (event.hash !== row.eventHash || !slots.includes(row.input.start)) throw new Error('Appointment availability changed.')
    const dispatch = await ctx.runMutation(internal.appointmentBookings.dispatch, { ...lease, eventHash: event.hash, slot: row.input.start })
    if (!dispatch) return
    const result = await provider.create(row.input, event, row.operationKey!)
    if (!result || typeof result.uid !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(result.uid)) throw new Error('No provider identifier.')
    await ctx.runMutation(internal.appointmentBookings.recordedUid, { ...lease, uid: result.uid })
    const readback = await provider.booking(result.uid)
    await ctx.runMutation(internal.appointmentBookings.verified, { ...args, operationKey: row.operationKey!, result: readback })
  } catch { await ctx.runMutation(internal.appointmentBookings.failed, lease) }
} })
export const reconcile = action({ args: { id: v.id('appointmentBookings'), version: v.number() }, handler: async (ctx, args): Promise<boolean> => {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new ConvexError('Sign in to check this appointment.')
  const row = await ctx.runQuery(internal.appointmentBookings.reconcileContext, { ...args, subject: identity.tokenIdentifier })
  if (!row) throw new ConvexError('Reconnect the original appointment account before checking this result.')
  try {
    const provider = new CalcomProvider(process.env.CALCOM_API_KEY!), result = row.providerUid ? await provider.booking(row.providerUid) : await provider.find(row.input, row.event, row.operationKey!, row.approvedHash!)
    if (!result) return false
    return await ctx.runMutation(internal.appointmentBookings.verified, { ...args, operationKey: row.operationKey!, result })
  } catch { return false }
} })
