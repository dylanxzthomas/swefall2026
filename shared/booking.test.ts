import { expect, it } from 'vitest'
import { bookingSchema, bookingHash, bookingChanges, bookingReadback, checkBookingApproval, type BookingDraft } from './booking.js'

const draft: BookingDraft = { kind: 'booking', childId: null, site: 'synthetic_activity', venue: 'Test Activity Studio', service: 'Family pottery', slotId: 'pottery-am', date: '2027-05-08', startTime: '10:00', timezone: 'America/Los_Angeles', participants: 2, priceMinor: 4000, currency: 'USD', cancellationTerms: 'Cancel up to 24 hours before for a full refund.', accountLabel: 'Synthetic parent', quoteVersion: 1, expiresAt: 1810000000000, evidence: { service: 'Family pottery', price: '$40.00 total' } }
const approval = { draftHash: bookingHash(draft), operationKey: 'synthetic_operation_key', approvedAt: draft.expiresAt - 60000, connectionId: 'synthetic-connection', connectionVersion: 1 }
const connection = { id: approval.connectionId, version: approval.connectionVersion }

it('validates a bounded synthetic booking and rejects hidden authority, unsupported websites and invalid times', () => {
  expect(bookingSchema.parse(draft)).toEqual(draft)
  for (const changes of [{ site: 'arbitrary_website' }, { approved: true }, { currency: 'EUR' }, { participants: 0 }, { participants: 11 }, { priceMinor: -1 }, { priceMinor: 20.5 }, { expiresAt: Infinity }, { date: '2027-02-31' }, { date: '2027-03-14', startTime: '02:30' }, { date: '2027-11-07', startTime: '01:30' }, { timezone: 'unknown' }]) expect(() => bookingSchema.parse({ ...draft, ...changes })).toThrow()
})

it('binds every reviewed field, distinguishes material changes and survives database key reordering', () => {
  const reordered = Object.fromEntries(Object.entries(draft).reverse()) as BookingDraft
  reordered.evidence = { price: '$40.00 total', service: 'Family pottery' }
  expect(bookingHash(reordered)).toBe(bookingHash(draft)); expect(bookingChanges(draft, reordered)).toEqual([])
  for (const changes of [{ participants: 3 }, { priceMinor: 5000 }, { cancellationTerms: 'No refunds' }, { accountLabel: 'Another synthetic adult' }, { expiresAt: draft.expiresAt + 1 }, { quoteVersion: 2 }, { childId: 'maya' }, { evidence: { price: 'Changed evidence' } }]) {
    const current = { ...draft, ...changes }
    expect(bookingHash(current)).not.toBe(bookingHash(draft))
    expect(bookingChanges(draft, current)).toEqual(Object.keys(changes))
    expect(() => checkBookingApproval(current, approval, approval.approvedAt, 10000, connection)).toThrow('changed after approval')
  }
})

it('requires explicit current approval within quote lifetime and the total price limit', () => {
  expect(checkBookingApproval(draft, approval, approval.approvedAt, 4000, connection)).toEqual(approval)
  expect(() => checkBookingApproval(draft, null, approval.approvedAt, 4000, connection)).toThrow('approve')
  expect(() => checkBookingApproval(draft, approval, draft.expiresAt, 4000, connection)).toThrow('expired')
  expect(() => checkBookingApproval(draft, approval, approval.approvedAt - 1, 4000, connection)).toThrow('expired')
  expect(() => checkBookingApproval(draft, approval, approval.approvedAt, 3999, connection)).toThrow('price')
})

it('verifies actual reservation fields, account and operation identity instead of trusting a success label', () => {
  const receipt = { reservationId: 'reservation_1', status: 'confirmed' as const, operationKey: approval.operationKey, accountLabel: draft.accountLabel, draftHash: bookingHash(draft), booking: draft }
  expect(bookingReadback(draft, receipt, approval.operationKey)).toMatchObject({ verified: true, differences: [], reservation: receipt })
  expect(bookingReadback(draft, { status: 'confirmed' }, approval.operationKey).verified).toBe(false)
  expect(bookingReadback(draft, { ...receipt, accountLabel: 'Another adult' }, approval.operationKey).differences).toContain('accountLabel')
  expect(bookingReadback(draft, { ...receipt, operationKey: 'another_operation_key' }, approval.operationKey).differences).toContain('operationKey')
  expect(bookingReadback(draft, { ...receipt, booking: { ...draft, priceMinor: 5000 } }, approval.operationKey).differences).toContain('priceMinor')
  expect(bookingReadback(draft, { ...receipt, status: 'pending' }, approval.operationKey).verified).toBe(false)
})
