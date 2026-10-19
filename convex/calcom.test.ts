import { expect, it, vi } from 'vitest'
import { CalcomProvider } from './calcom'
import { appointmentEvent, appointmentHash } from '../shared/appointmentBooking'
const rawEvent = { id: 7, title: 'Synthetic lesson', lengthInMinutes: 30, price: 0, bookingUrl: 'https://cal.com/test/lesson', locations: [{ type: 'address', address: 'Synthetic location' }] }, event = appointmentEvent(rawEvent, 7), input = { start: '2026-10-20T10:00:00.000Z', name: 'Synthetic Parent', email: 'parent@example.com', timezone: 'UTC' }
const response = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }))
it('pins endpoint API versions, restricts network destination and submits no permission/limit bypasses', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response(rawEvent)).mockResolvedValueOnce(response({ '2026-10-20': [{ start: input.start }] })).mockResolvedValueOnce(response({ uid: 'synthetic_uid' }))
  const provider = new CalcomProvider('synthetic-key', fetcher)
  await provider.event(7); expect(await provider.slots(7, input.start, '2026-10-20T11:00:00Z')).toEqual([input.start]); await provider.create(input, event, 'operation')
  expect(fetcher.mock.calls.map(call => call[1].headers['cal-api-version'])).toEqual(['2026-06-12', '2024-09-04', '2026-02-25'])
  expect(fetcher.mock.calls.every(call => call[0].startsWith('https://api.cal.com/v2/') && call[1].redirect === 'error')).toBe(true)
  const body = JSON.parse(fetcher.mock.calls[2][1].body)
  expect(body).toMatchObject({ eventTypeId: 7, metadata: { solaOperation: 'operation', solaHash: appointmentHash(input, event.hash) }, leadEnrichmentOptOut: true })
  for (const forbidden of ['allowConflicts', 'allowBookingOutOfBounds', 'skipBookingLimits', 'guests', 'instant', 'routing', 'payment']) expect(body[forbidden]).toBeUndefined()
})
it('does not retry failed creates or echo raw provider diagnostics', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('private diagnostic synthetic-key', { status: 429 })), provider = new CalcomProvider('synthetic-key', fetcher)
  await expect(provider.create(input, event, 'operation')).rejects.toThrow('provider rejected')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('recovers only one exact operation using bounded read-only search followed by UID read-back', async () => {
  const data = { uid: 'synthetic_uid', eventTypeId: 7, start: input.start, end: '2026-10-20T10:30:00Z', location: 'Synthetic location', status: 'accepted', attendees: [{ name: input.name, email: input.email, timeZone: 'UTC' }], metadata: { solaOperation: 'operation', solaHash: appointmentHash(input, event.hash) } }
  const fetcher = vi.fn().mockResolvedValueOnce(response([data])).mockResolvedValueOnce(response(data)), provider = new CalcomProvider('synthetic-key', fetcher)
  expect(await provider.find(input, event, 'operation', appointmentHash(input, event.hash))).toEqual(data)
  expect(fetcher.mock.calls.every(call => call[1].method === 'GET')).toBe(true)
  expect(fetcher.mock.calls[0][0]).toContain('limit=100')
  const absent = new CalcomProvider('synthetic-key', vi.fn().mockResolvedValue(response([])))
  expect(await absent.find(input, event, 'operation', appointmentHash(input, event.hash))).toBeNull()
})
it('rejects malformed/oversized/outside-window availability and unsafe UID paths', async () => {
  for (const value of [{ '2026-10-20': [{ start: '2026-10-21T10:00:00Z' }] }, { '2026-10-20': [{ start: 'not a date' }] }, []]) {
    const provider = new CalcomProvider('synthetic-key', vi.fn().mockResolvedValue(response(value)))
    await expect(provider.slots(7, input.start, '2026-10-20T11:00:00Z')).rejects.toThrow()
  }
  const fetcher = vi.fn(), provider = new CalcomProvider('synthetic-key', fetcher)
  await expect(provider.booking('../../account')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled()
})
