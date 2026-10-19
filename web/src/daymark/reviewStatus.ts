import { statusText } from '../../../shared/daymark'
import type { Deliverable } from './types'

export function reviewStatus(action: Deliverable) {
  if (action.status === 'succeeded' && action.payload.kind === 'calendar' && action.receipts.some(receipt => (receipt.revision === undefined || receipt.revision === action.revision) && ['calendar_deletion_verified', 'apple_calendar_deleted'].includes(receipt.outcome))) return 'Calendar removed · verified'
  return statusText(action.status, action.payload.kind)
}
export function showReviewGuidance(actions: Deliverable[]) {
  const active = actions.filter(action => action.status !== 'cancelled')
  return !actions.length || active.length > 0 && active.every(action => ['review', 'failed'].includes(action.status))
}
