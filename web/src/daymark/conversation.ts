import { isConversation } from '../../../shared/assistant'
import type { DaymarkState, Deliverable, Job, Receipt } from './types'

export type ConversationUpdate = { kind: 'outcome'; id: string; jobId: string; at: number; text: string }
const completed = (action: Deliverable) => ['succeeded', 'saved', 'waiting'].includes(action.status)
function outcomeText(action: Deliverable, receipt: Receipt, state: DaymarkState) {
  const kind = action.payload.kind
  if (receipt.outcome === 'caregiver_accepted_not_pickup_completed' && action.payload.kind === 'pickup') {
    const { caregiverId, childId } = action.payload
    const caregiver = state.caregivers.find(c => c._id === caregiverId)?.name ?? 'The caregiver'
    const child = state.household?.children.find(c => c.id === childId)?.name
    return `${caregiver} accepted ${child ? `${child}’s pickup` : 'the pickup request'}.`
  }
  if (receipt.outcome === 'request_email_accepted' && kind === 'pickup') return 'Your pickup request was accepted for sending. Waiting for the caregiver’s answer.'
  if (receipt.outcome === 'request_available_in_app' && kind === 'pickup') return 'The pickup request is in the caregiver’s Sola inbox. Waiting for their answer.'
  if (['calendar_deletion_verified', 'apple_calendar_deleted'].includes(receipt.outcome) && kind === 'calendar') return 'The event was removed from your calendar.'
  if (['calendar_read_back_verified', 'apple_calendar_readback'].includes(receipt.outcome) && kind === 'calendar') return 'Your calendar was updated.'
  if (['gmail_accepted', 'microsoft_accepted'].includes(receipt.outcome) && kind === 'email') return 'Your email was accepted for sending. Recipient delivery isn’t confirmed.'
  if (receipt.outcome === 'saved_on_device' && kind === 'calendar' && state.storage === 'device') return 'The event was saved to this device’s plan.'
  return null
}

/** Derive only from already-authorized records. No local history can outlive its source job. */
export function conversationUpdates(state: DaymarkState): ConversationUpdate[] {
  const messages = new Map<string, ConversationUpdate>()
  for (const job of state.jobs) for (const action of job.actions) for (const receipt of action.receipts) {
    // Older device receipts predate revision fields. Their terminal action is
    // immutable; connected receipts must always establish their exact revision.
    if (receipt.revision !== action.revision && !(receipt.revision === undefined && state.storage === 'device' && completed(action))) continue
    if (!Number.isFinite(receipt.verifiedAt) || receipt.verifiedAt <= 0) continue
    const text = outcomeText(action, receipt, state)
    if (!text) continue
    const id = `outcome:${JSON.stringify([job._id, action._id, action.revision, receipt.outcome, receipt.providerId ?? receipt.requestId ?? ''])}`
    const previous = messages.get(id)
    if (!previous || receipt.verifiedAt < previous.at) messages.set(id, { kind: 'outcome', id, jobId: job._id, at: receipt.verifiedAt, text })
  }
  for (const request of state.arrangements) {
    const job = state.jobs.find(job => job.actions.some(action => action._id === request.actionId))
    if (!job || request.payload?.kind !== 'pickup' || !request.respondedAt || !Number.isFinite(request.respondedAt) || !((request.status === 'declined' && request.response === 'decline') || (request.status === 'suggested' && request.response === 'suggest'))) continue
    const caregiver = request.caregiver || 'The caregiver'
    const text = request.response === 'decline' ? `${caregiver} declined the earlier pickup request. Review the next option before contacting anyone.` : `${caregiver} suggested a change to the earlier pickup request. Review it before approving an arrangement.`
    const id = `response:${request.id}:${request.response}`
    messages.set(id, { kind: 'outcome', id, jobId: job._id, at: request.respondedAt, text })
  }
  return [...messages.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

export function conversationReply(job: Job) {
  if (job.cancelled) return 'Remaining work in this request is cancelled.'
  if (job.scheduledFor) return 'I’ll prepare this at the scheduled time. Any changes or messages will need your approval.'
  if (job.preparing) return ''
  if (isConversation(job)) return job.clarification
  if (job.clarification) return job.clarification
  const kinds = [...new Set(job.actions.filter(a => a.status !== 'cancelled').map(a => a.payload.kind))]
  if (!kinds.length) return job.cancelled ? 'This request is cancelled.' : job.clarification || 'I need a little more detail before preparing this.'
  return kinds.length > 1 ? 'I’ve prepared the details for you to review.' : kinds[0] === 'calendar' ? 'I’ve prepared the calendar change for you to review.' : kinds[0] === 'email' ? 'I’ve prepared a reply for you to review.' : 'I’ve prepared the pickup request for you to review.'
}

/** Observed activity, never generated reasoning or an inferred provider outcome. */
export function conversationActivity(job: Job, runs: NonNullable<DaymarkState['assistantRuns']> = []) {
  if (job.cancelled) return null
  const run = runs.find(r => r.jobId === job._id && !r.stale && ['queued', 'running'].includes(r.status))
  if (run || job.preparing) return 'Working on your request…'
  if (job.actions.some(a => a.revisionRequest)) return 'Preparing your changes…'
  const action = job.actions.find(a => a.status === 'executing')
  if (action) return action.payload.kind === 'calendar' ? 'Updating your calendar…' : action.payload.kind === 'email' ? 'Sending your approved email…' : 'Sending your approved pickup request…'
  if (job.actions.some(a => a.status === 'queued')) return 'Your approved request is waiting to run.'
  return null
}

export const conversationTargetId = (jobId: string) => `conversation-job-${encodeURIComponent(jobId)}`
