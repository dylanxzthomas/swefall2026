import { expect, it } from 'vitest'
import { appointmentEvent, appointmentHash, appointmentInputSchema, appointmentWindowSchema, verifyAppointment } from './appointmentBooking.js'
const rawEvent = { id: 7, title: 'Synthetic lesson', lengthInMinutes: 30, price: 0, bookingUrl: 'https://cal.com/test/lesson', locations: [{ type: 'address', address: 'Synthetic location' }], recurrence: null }
const input = { start: '2026-10-20T10:00:00.000Z', name: 'Synthetic Parent', email: 'parent@example.com', timezone: 'UTC' }
it('requires a bounded future-style window and normalizes reviewed attendee/slot fields', () => {
  expect(appointmentInputSchema.parse({ ...input, email: 'PARENT@example.com', name: ' Synthetic Parent ' })).toEqual(input)
  expect(() => appointmentWindowSchema.parse({ ...input, from: input.start, through: '2026-11-20T10:00:00.000Z' })).toThrow()
  expect(() => appointmentInputSchema.parse({ ...input, allowConflicts: true })).toThrow()
})
it.each([{ price: 10 }, { price: undefined }, { recurrence: { frequency: 'weekly' } }, { bookingUrl: 'https://example.com/lesson' }, { bookingRequiresAuthentication: true }, { seatsPerTimeSlot: 2 }, { bookingFields: [{ type: 'text', slug: 'phone', required: true }] }])('requires takeover for unsupported event configuration %j', change => expect(() => appointmentEvent({ ...rawEvent, ...change }, 7)).toThrow())
it('binds every exact attendee/slot/event field and verifies a real UID read-back', () => {
  const event = appointmentEvent(rawEvent, 7), hash = appointmentHash(input, event.hash), data = { uid: 'synthetic_uid', eventTypeId: 7, start: input.start, end: '2026-10-20T10:30:00Z', location: 'Synthetic location', status: 'accepted', attendees: [{ name: input.name, email: input.email, timeZone: input.timezone }], metadata: { solaOperation: 'operation', solaHash: hash } }
  expect(verifyAppointment(data, input, event, 'operation', hash)).toEqual({ uid: 'synthetic_uid', status: 'confirmed' })
  expect(verifyAppointment({ ...data, status: 'pending' }, input, event, 'operation', hash).status).toBe('pending')
  for (const bad of [{ eventTypeId: 8 }, { status: 'cancelled' }, { start: '2026-10-20T11:00:00Z' }, { metadata: { solaOperation: 'another', solaHash: hash } }, { attendees: [{ name: 'Another', email: input.email, timeZone: 'UTC' }] }, { guests: ['another@example.com'] }]) expect(() => verifyAppointment({ ...data, ...bad }, input, event, 'operation', hash)).toThrow()
  expect(appointmentHash({ ...input, name: 'Other Parent' }, event.hash)).not.toBe(hash)
})
