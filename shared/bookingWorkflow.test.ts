import { afterEach, expect, it, vi } from 'vitest'
import { bookingHash, type BookingApproval, type BookingDraft, type BookingReservation } from './booking.js'
import { BookingTakeoverRequired, executeBooking, reconcileBooking, type BookingAccess, type BookingCheckpoint, type BookingWorkflowContext } from './bookingWorkflow.js'

afterEach(() => { vi.useRealTimers() })
function fixture() {
  const draft: BookingDraft = { kind: 'booking', childId: null, site: 'synthetic_activity', venue: 'Synthetic studio', service: 'Family pottery', slotId: 'morning', date: '2027-05-08', startTime: '10:00', timezone: 'America/Los_Angeles', participants: 2, priceMinor: 4000, currency: 'USD', cancellationTerms: 'Cancel 24 hours before.', accountLabel: 'Synthetic parent', quoteVersion: 1, expiresAt: Date.now() + 3600_000, evidence: {} }
  const approval: BookingApproval = { draftHash: bookingHash(draft), operationKey: 'synthetic_operation_001', approvedAt: Date.now(), connectionId: 'synthetic-connection', connectionVersion: 1 }
  const records = new Map<string, BookingCheckpoint>()
  let access: BookingAccess = { cancelled: false, connection: { id: approval.connectionId, version: 1, accountLabel: draft.accountLabel, site: draft.site, state: 'ready' } }, reservation: BookingReservation | null = null
  const context: BookingWorkflowContext = { spendLimitMinor: 4000, timeoutMs: 1000, readAccess: vi.fn(async () => structuredClone(access)),
    checkpoints: {
      read: vi.fn(async key => structuredClone(records.get(key) ?? null)),
      claim: vi.fn(async value => { if (records.has(value.operationKey)) return false; records.set(value.operationKey, structuredClone(value)); return true }),
      settle: vi.fn(async (key, hash, result) => { const current = records.get(key); if (!current || current.draftHash !== hash) throw new Error('Wrong checkpoint.'); if (current.state !== 'verified') records.set(key, { ...current, ...result }) }),
    },
    adapter: { site: 'synthetic_activity', inspect: vi.fn(async () => structuredClone(draft)), submit: vi.fn(async ({ booking, operationKey }) => { expect(records.get(operationKey)?.state).toBe('dispatched'); reservation = { reservationId: 'synthetic_001', status: 'confirmed', operationKey, draftHash: bookingHash(booking), accountLabel: booking.accountLabel, booking } }), readReservation: vi.fn(async () => structuredClone(reservation)) },
  }
  return { context, draft, approval, records, setAccess: (value: BookingAccess) => { access = value }, access: () => access }
}

it('requires exact current approval, connection and price before it can submit', async () => {
  const f = fixture()
  expect((await executeBooking(f.context, f.draft, null)).state).toBe('needs_review')
  expect((await executeBooking(f.context, { ...f.draft, participants: 3 }, f.approval)).state).toBe('needs_review')
  expect((await executeBooking({ ...f.context, spendLimitMinor: 3999 }, f.draft, f.approval)).state).toBe('needs_review')
  f.setAccess({ cancelled: false, connection: { ...f.access().connection!, version: 2 } })
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('needs_review')
  f.setAccess({ cancelled: false, connection: null })
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('connection_needed')
  expect(f.context.adapter.inspect).not.toHaveBeenCalled(); expect(f.context.adapter.submit).not.toHaveBeenCalled(); expect(f.records.size).toBe(0)
})

it('stops changed quotes, cancelled requests, takeover and access revoked while inspecting', async () => {
  const f = fixture()
  vi.mocked(f.context.adapter.inspect).mockResolvedValueOnce({ ...f.draft, priceMinor: 5000, quoteVersion: 2 })
  expect(await executeBooking(f.context, f.draft, f.approval)).toMatchObject({ state: 'needs_review', changes: ['priceMinor', 'quoteVersion'] })
  vi.mocked(f.context.adapter.inspect).mockRejectedValueOnce(new BookingTakeoverRequired('captcha'))
  expect(await executeBooking(f.context, f.draft, f.approval)).toMatchObject({ state: 'takeover', reason: 'captcha' })
  vi.mocked(f.context.adapter.inspect).mockImplementationOnce(async () => { f.setAccess({ ...f.access(), cancelled: true }); return f.draft })
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('cancelled')
  expect(f.context.adapter.submit).not.toHaveBeenCalled(); expect(f.records.size).toBe(0)
})

it('records dispatch before submission and reads back before recording verification', async () => {
  const f = fixture(), result = await executeBooking(f.context, f.draft, f.approval)
  expect(result.state).toBe('verified'); expect(f.records.get(f.approval.operationKey)?.state).toBe('verified')
  expect(f.context.adapter.submit).toHaveBeenCalledTimes(1); expect(f.context.adapter.readReservation).toHaveBeenCalledTimes(1)
  // Historical evidence survives cancellation/revocation without a new provider call.
  f.setAccess({ cancelled: true, connection: { ...f.access().connection!, state: 'revoked' } })
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('verified')
  expect(f.context.adapter.submit).toHaveBeenCalledTimes(1); expect(f.context.adapter.readReservation).toHaveBeenCalledTimes(1)
})

it('never resubmits after dispatch, including empty read-back and a lost local result write', async () => {
  const f = fixture()
  vi.mocked(f.context.adapter.submit).mockRejectedValueOnce(new Error('Interrupted before response.'))
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('uncertain')
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('uncertain')
  expect(f.context.adapter.submit).toHaveBeenCalledTimes(1)
  const other = fixture()
  vi.mocked(other.context.checkpoints.settle).mockRejectedValueOnce(new Error('Result persistence unavailable.'))
  expect((await executeBooking(other.context, other.draft, other.approval)).state).toBe('uncertain')
  expect((await executeBooking(other.context, other.draft, other.approval)).state).toBe('verified')
  expect(other.context.adapter.submit).toHaveBeenCalledTimes(1)
})

it('handles a checkpoint write that commits then disconnects without risking a new submission', async () => {
  const f = fixture()
  vi.mocked(f.context.checkpoints.claim).mockImplementationOnce(async value => { f.records.set(value.operationKey, value); throw new Error('Checkpoint response lost.') })
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('uncertain')
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('uncertain')
  expect(f.context.adapter.submit).not.toHaveBeenCalled(); expect(f.context.adapter.readReservation).toHaveBeenCalledTimes(1)
})

it('rechecks cancellation after claiming dispatch and preserves the operation for read-only recovery', async () => {
  const f = fixture()
  vi.mocked(f.context.checkpoints.claim).mockImplementationOnce(async value => { f.records.set(value.operationKey, value); f.setAccess({ ...f.access(), cancelled: true }); return true })
  expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('cancelled')
  expect(f.context.adapter.submit).not.toHaveBeenCalled(); expect(f.records.get(f.approval.operationKey)?.state).toBe('uncertain')
  expect((await reconcileBooking(f.context, f.draft, f.approval.operationKey)).state).toBe('uncertain')
  expect(f.context.adapter.submit).not.toHaveBeenCalled()
})

it('stops an overlong browser step and does not proceed to submit after the step later resolves', async () => {
  vi.useFakeTimers()
  const f = fixture(); let resolve: (value: BookingDraft) => void = () => {}; let signal: AbortSignal | undefined
  vi.mocked(f.context.adapter.inspect).mockImplementationOnce(async (_request, currentSignal) => { signal = currentSignal; return new Promise<BookingDraft>(done => { resolve = done }) })
  const work = executeBooking(f.context, f.draft, f.approval)
  await vi.advanceTimersByTimeAsync(1001)
  expect((await work).state).toBe('needs_review'); expect(signal?.aborted).toBe(true)
  resolve(f.draft); await Promise.resolve(); expect(f.context.adapter.submit).not.toHaveBeenCalled(); expect(f.records.size).toBe(0)
})

it('does not reveal a cached receipt before the caller is authorized', async () => {
  const f = fixture(); expect((await executeBooking(f.context, f.draft, f.approval)).state).toBe('verified')
  vi.mocked(f.context.readAccess).mockRejectedValue(new Error('Household unavailable.'))
  await expect(reconcileBooking(f.context, f.draft, f.approval.operationKey)).rejects.toThrow('Household unavailable')
})
