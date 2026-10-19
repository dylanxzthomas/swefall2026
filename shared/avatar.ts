import { isConversation, type Task } from './assistant.js'

export const avatarMoods = ['idle', 'listening', 'working', 'review', 'done', 'resting'] as const
export type AvatarMood = typeof avatarMoods[number]

const verifiedOutcomes = {
  calendar: ['calendar_read_back_verified', 'calendar_deletion_verified', 'apple_calendar_readback', 'apple_calendar_deleted'],
  email: ['gmail_accepted', 'microsoft_accepted'],
  pickup: ['caregiver_accepted_not_pickup_completed'],
}

/** The expression supplements status text; a queued, copied, or uncertain action is never a success pose. */
export function jobAvatarMood(job: Task): AvatarMood {
  if (job.cancelled || job.scheduledFor) return 'resting'
  if (isConversation(job)) return 'idle'
  const actions = job.actions.filter(action => action.status !== 'cancelled')
  if (actions.some(action => ['failed', 'uncertain'].includes(action.status))) return 'review'
  if (job.preparing || actions.some(action => action.revisionRequest || action.status === 'executing')) return 'working'
  if (actions.some(action => action.status === 'review' || action.status === 'saved' && action.payload.kind !== 'calendar')) return 'review'
  if (actions.some(action => ['queued', 'waiting'].includes(action.status))) return 'resting'
  if (actions.length && actions.every(action => {
    const outcomes = action.receipts?.map(receipt => receipt.outcome) ?? []
    if (action.status === 'saved' && action.payload.kind === 'calendar') return outcomes.includes('saved_on_device')
    return action.status === 'succeeded' && outcomes.some(outcome => verifiedOutcomes[action.payload.kind].includes(outcome))
  })) return 'done'
  return job.actions.length && !actions.length ? 'resting' : 'review'
}

export function headerAvatarMood(jobs: readonly Task[], composing: boolean, submitting: boolean): AvatarMood {
  if (submitting) return 'working'
  if (composing) return 'listening'
  const moods = jobs.filter(job => !isConversation(job)).map(jobAvatarMood)
  if (moods.includes('working')) return 'working'
  if (moods.includes('review')) return 'review'
  return moods.length && moods.every(mood => mood === 'resting') ? 'resting' : 'idle'
}
