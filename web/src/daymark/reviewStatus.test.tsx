import { expect, it } from 'vitest'
import { reviewStatus, showReviewGuidance } from './reviewStatus'
import type { Deliverable } from './types'
import { event } from '../../../tests/fixtures/calendar'
const action = (status: Deliverable['status'] = 'succeeded'): Deliverable => ({ _id: 'synthetic-event', revision: 2, status, payload: { ...event, operation: 'delete', targetId: 'saved-event' }, receipts: [] })
it.each(['calendar_deletion_verified', 'apple_calendar_deleted'])('uses the current %s receipt to name a completed removal', outcome => {
  const a = { ...action(), receipts: [{ _id: 'receipt', revision: 2, outcome, verifiedAt: 1000 }] }
  expect(reviewStatus(a)).toBe('Calendar removed · verified')
  expect(showReviewGuidance([a])).toBe(false)
  expect(reviewStatus({ ...a, status: 'review' })).not.toContain('removed')
  expect(reviewStatus({ ...a, receipts: [{ ...a.receipts[0], revision: 1 }] })).not.toContain('removed')
})
it.each(['queued', 'executing', 'succeeded', 'uncertain', 'waiting', 'cancelled'] as const)('does not repeat pre-write guidance after work is %s', status => {
  expect(showReviewGuidance([action(status)])).toBe(false)
  if (status !== 'cancelled') expect(showReviewGuidance([action('review'), action(status)])).toBe(false)
})
it('keeps review guidance before a write and for conversation-only jobs', () => {
  expect(showReviewGuidance([])).toBe(true)
  expect(showReviewGuidance([action('review'), action('failed')])).toBe(true)
})
