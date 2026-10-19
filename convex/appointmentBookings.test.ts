import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { appointmentEvent, appointmentHash } from '../shared/appointmentBooking'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T09:00:00Z'), input = { start: '2026-10-20T10:00:00.000Z', name: 'Synthetic Parent', email: 'parent@example.com', timezone: 'UTC' }, rawEvent = { id: 7, title: 'Synthetic lesson', lengthInMinutes: 30, price: 0, bookingUrl: 'https://cal.com/test/lesson', locations: [{ type: 'address', address: 'Synthetic location' }] }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('CALCOM_API_KEY', 'synthetic-key'); vi.stubEnv('CALCOM_EVENT_TYPE_ID', '7'); vi.stubEnv('CALCOM_PILOT_SUBJECT', 'test|owner') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
async function fixture() {
  const t = convexTest(schema, modules), owner = t.withIdentity({ subject: 'owner', tokenIdentifier: 'test|owner' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await owner.mutation(api.households.save, { timezone: 'UTC', children: [] }); await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const access = (await t.query(internal.appointmentBookings.access, { subject: 'test|owner' }))!, event = appointmentEvent(rawEvent, 7)
  const id = await t.mutation(internal.appointmentBookings.prepared, { subject: 'test|owner', requestId: 'request', requestHash: 'synthetic', configHash: access.configHash, event, input, slots: [input.start] })
  const approve = () => owner.mutation(api.appointmentBookings.approve, { id, version: 1, input, approved: true })
  const row = () => t.run(ctx => ctx.db.get(id))
  const claim = async () => { await approve(); return t.mutation(internal.appointmentBookings.claim, { id, version: 1, lease: 'lease' }) }
  const receipt = (operationKey: string) => ({ uid: 'synthetic_uid', eventTypeId: 7, start: input.start, end: '2026-10-20T10:30:00Z', status: 'accepted', location: 'Synthetic location', attendees: [{ name: input.name, email: input.email, timeZone: 'UTC' }], metadata: { solaOperation: operationKey, solaHash: appointmentHash(input, event.hash) } })
  return { t, owner, other, householdId, event, id, approve, row, claim, receipt }
}
it('isolates private proposals and fails closed without exact configured pilot identity', async () => {
  const f = await fixture(); expect(await f.other.query(api.appointmentBookings.list, {})).toEqual([])
  await expect(f.other.mutation(api.appointmentBookings.approve, { id: f.id, version: 1, input, approved: true })).rejects.toThrow('unavailable')
  expect((await f.owner.query(api.appointmentBookings.list, {}))[0]).not.toHaveProperty('configHash')
  vi.stubEnv('CALCOM_PILOT_SUBJECT', ''); expect((await f.owner.query(api.appointmentBookings.settings, {})).configured).toBe(false)
  await expect(f.approve()).rejects.toThrow('current connection')
})
it('binds edited attendee/slot/version and requires a distinct checked approval', async () => {
  const f = await fixture(), changed = { ...input, name: 'Edited Parent' }
  await expect(f.owner.mutation(api.appointmentBookings.approve, { id: f.id, version: 1, input, approved: false })).rejects.toThrow('Approve')
  expect(await f.owner.mutation(api.appointmentBookings.update, { id: f.id, version: 1, input: changed })).toBe(2)
  await expect(f.approve()).rejects.toThrow('changed')
  await expect(f.owner.mutation(api.appointmentBookings.update, { id: f.id, version: 2, input: { ...changed, start: '2026-10-20T11:00:00Z' } })).rejects.toThrow('available')
  await f.owner.mutation(api.appointmentBookings.approve, { id: f.id, version: 2, input: changed, approved: true })
  expect((await f.row())!.approvedHash).toBe(appointmentHash(changed, f.event.hash))
  await expect(f.owner.mutation(api.appointmentBookings.update, { id: f.id, version: 2, input })).rejects.toThrow('fresh availability')
})
it('coalesces fifty approvals and grants only one dispatch, after writing the durable journal', async () => {
  const f = await fixture(); const ids = await Promise.all(Array.from({ length: 50 }, f.approve)); expect(new Set(ids)).toEqual(new Set([f.id]))
  const leases = await Promise.all(Array.from({ length: 50 }, (_, i) => f.t.mutation(internal.appointmentBookings.claim, { id: f.id, version: 1, lease: `lease${i}` }))); expect(leases.filter(Boolean)).toHaveLength(1)
  const lease = `lease${leases.findIndex(Boolean)}`, args = { id: f.id, version: 1, lease, eventHash: f.event.hash, slot: input.start }
  const dispatches = await Promise.all(Array.from({ length: 50 }, () => f.t.mutation(internal.appointmentBookings.dispatch, args))); expect(dispatches.filter(Boolean)).toHaveLength(1)
  expect(await f.row()).toMatchObject({ status: 'dispatching', dispatchedAt: now, approvedHash: appointmentHash(input, f.event.hash) })
})
it('blocks duplicate attendee/slot bookings from a new request even when name or timezone is edited', async () => {
  const f = await fixture(); await f.approve()
  const access = (await f.t.query(internal.appointmentBookings.access, { subject: 'test|owner' }))!
  const second = await f.t.mutation(internal.appointmentBookings.prepared, { subject: 'test|owner', requestId: 'another', requestHash: 'another', configHash: access.configHash, event: f.event, input, slots: [input.start] })
  await expect(f.owner.mutation(api.appointmentBookings.approve, { id: second, version: 1, input: { ...input, name: 'Edited Spelling', timezone: 'America/Los_Angeles' }, approved: true })).rejects.toThrow('matching appointment')
  expect((await f.t.run(ctx => ctx.db.get(second)))!.dispatchedAt).toBeUndefined()
})
it('can stop queued work before dispatch without representing removal as a provider cancellation', async () => {
  const f = await fixture(); await f.claim(); await f.owner.mutation(api.appointmentBookings.remove, { id: f.id, version: 1 })
  expect(await f.t.mutation(internal.appointmentBookings.dispatch, { id: f.id, version: 1, lease: 'lease', eventHash: f.event.hash, slot: input.start })).toBeNull()
  expect((await f.row())!.status).toBe('cancelled')
})
it.each(['expiry', 'configuration', 'membership', 'slot', 'event'] as const)('blocks stale %s before dispatch', async change => {
  const f = await fixture(); await f.claim()
  if (change === 'expiry') vi.setSystemTime(Date.now() + 600001)
  if (change === 'configuration') vi.stubEnv('CALCOM_API_KEY', 'rotated-synthetic-key')
  if (change === 'membership') await f.t.run(async ctx => ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|owner')).unique())!._id))
  expect(await f.t.mutation(internal.appointmentBookings.dispatch, { id: f.id, version: 1, lease: 'lease', eventHash: change === 'event' ? 'changed' : f.event.hash, slot: change === 'slot' ? '2026-10-20T11:00:00Z' : input.start })).toBeNull()
  expect((await f.row())!.dispatchedAt).toBeUndefined()
})
it('rechecks availability, journals before the only provider POST and verifies UID read-back', async () => {
  const f = await fixture(); await f.approve()
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (options.method === 'POST') { expect((await f.row())!.status).toBe('dispatching'); return new Response(JSON.stringify({ status: 'success', data: { uid: 'synthetic_uid' } })) }
    const data = url.includes('event-types') ? rawEvent : url.includes('/slots?') ? { '2026-10-20': [{ start: input.start }] } : f.receipt((await f.row())!.operationKey!)
    return new Response(JSON.stringify({ status: 'success', data }))
  }); vi.stubGlobal('fetch', fetcher)
  await f.t.action(internal.calcom.execute, { id: f.id, version: 1 }); await f.t.action(internal.calcom.execute, { id: f.id, version: 1 })
  expect(fetcher.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1)
  expect(await f.row()).toMatchObject({ status: 'confirmed', providerUid: 'synthetic_uid', verifiedAt: now })
})
it('keeps an ambiguous create uncertain, never repeats it, and reconciles using reads only', async () => {
  const f = await fixture(); await f.approve()
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (options.method === 'POST') throw new Error('Synthetic interrupted response after server accepted.')
    return new Response(JSON.stringify({ status: 'success', data: url.includes('event-types') ? rawEvent : { '2026-10-20': [{ start: input.start }] } }))
  }); vi.stubGlobal('fetch', fetcher)
  await f.t.action(internal.calcom.execute, { id: f.id, version: 1 }); expect((await f.row())!.status).toBe('uncertain')
  await f.t.action(internal.calcom.execute, { id: f.id, version: 1 }); expect(fetcher.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1)
  const read = vi.fn(async (url: string, options: RequestInit) => { expect(options.method).toBe('GET'); const receipt = f.receipt((await f.row())!.operationKey!); return new Response(JSON.stringify({ status: 'success', data: url.includes('bookings?') ? [receipt] : receipt })) }); vi.stubGlobal('fetch', read)
  expect(await f.owner.action(api.calcom.reconcile, { id: f.id, version: 1 })).toBe(true); expect((await f.row())!.status).toBe('confirmed')
})
it('recovers interrupted dispatch read-only, distinguishes pending host confirmation and ignores late failure', async () => {
  const f = await fixture(); await f.claim(); await f.t.mutation(internal.appointmentBookings.dispatch, { id: f.id, version: 1, lease: 'lease', eventHash: f.event.hash, slot: input.start }); vi.setSystemTime(Date.now() + 91001)
  await f.t.mutation(internal.appointmentBookings.recover, {}); expect((await f.row())!.status).toBe('uncertain')
  const row = (await f.row())!, result = { ...f.receipt(row.operationKey!), status: 'pending' }
  expect(await f.t.mutation(internal.appointmentBookings.verified, { id: f.id, version: 1, operationKey: row.operationKey!, result })).toBe(true)
  expect((await f.row())!.status).toBe('pending')
  await f.t.mutation(internal.appointmentBookings.failed, { id: f.id, version: 1, lease: 'lease' }); expect((await f.row())!.status).toBe('pending')
  await expect(f.owner.mutation(api.appointmentBookings.remove, { id: f.id, version: 1 })).rejects.toThrow('may already exist')
})
