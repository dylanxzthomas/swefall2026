import { assistantName } from './persona.js'
import type { ActionStatus, Payload } from './daymark.js'

export type TaskStatus = 'Needs you' | 'Working' | 'Finished'
export type TaskFilter = 'All' | TaskStatus
type Action = { status: ActionStatus; payload: Payload; revisionRequest?: unknown; error?: string; provider?: string; receipts?: { outcome: string }[] }
export type Task = { preparing: boolean; cancelled: boolean; clarification: string; conversation?: boolean; scheduledFor?: number; source?: { text?: string } | null; actions: readonly Action[] }
type Context = { storage?: 'device'; timezone?: string }
const compact = (value: string, limit = 130) => {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}
const done = (action: Action) => action.status === 'cancelled' || action.status === 'succeeded' || action.status === 'saved' && action.payload.kind === 'calendar'
const needsYou = (action: Action) => !action.revisionRequest && ['review', 'failed', 'uncertain'].includes(action.status) || action.status === 'saved' && action.payload.kind !== 'calendar'

export function isConversation(job: Task): boolean {
  return job.conversation === true && !job.actions.length && !job.preparing && !job.scheduledFor
}

export function jobStatus(job: Task): TaskStatus {
  if (job.cancelled) return 'Finished'
  if (job.scheduledFor) return 'Working'
  if (job.actions.some(needsYou)) return 'Needs you'
  if (job.preparing || job.actions.some(a => a.revisionRequest || ['queued', 'executing', 'waiting'].includes(a.status))) return 'Working'
  if (isConversation(job) || job.actions.length > 0 && job.actions.every(done)) return 'Finished'
  // A clarification or interrupted preparation with no artifact still needs a parent.
  return 'Needs you'
}

export function jobTitle(job: Task, children: readonly { id: string; name: string }[] = []): string {
  const first = job.actions.find(a => a.status !== 'cancelled') ?? job.actions[0]
  if (first) {
    const p = first.payload
    const title = p.kind === 'calendar' ? p.title || 'Calendar change' : p.kind === 'email' ? p.subject || 'School email' : `${children.find(c => c.id === p.childId)?.name ?? 'School'} pickup`
    const additional = job.actions.filter(a => a !== first && a.status !== 'cancelled').length
    return compact(`${title}${additional ? ` + ${additional} more` : ''}`, 100)
  }
  return compact(job.source?.text ?? '', 100) || (isConversation(job) ? 'Conversation' : 'Shared school notice')
}

function actionSummary(action: Action, context: Context) {
  const kind = action.payload.kind
  const noun = kind === 'calendar' ? 'Calendar' : kind === 'email' ? 'Email' : 'Pickup request'
  if (action.revisionRequest) return 'Preparing your change'
  if (action.status === 'cancelled') return 'Cancelled'
  if (action.status === 'saved' && kind === 'calendar') return 'Saved to this device’s plan'
  if (action.status === 'succeeded') {
    const outcomes = action.receipts?.map(r => r.outcome) ?? []
    if (kind === 'calendar') return outcomes.some(o => ['calendar_deletion_verified', 'apple_calendar_deleted'].includes(o)) ? 'Calendar removal verified' : outcomes.includes('apple_calendar_readback') ? `Saved in Apple Calendar on ${context.storage === 'device' ? 'this' : 'the connected'} iPhone` : 'Calendar updated'
    if (kind === 'email') return 'Email accepted · delivery unverified'
    return 'Caregiver accepted'
  }
  if (action.status === 'uncertain') return `${kind === 'pickup' ? 'Request delivery' : `${noun} result`} unconfirmed`
  if (action.status === 'failed') return `${noun} ${/reconnect|connection|disconnected/i.test(action.error ?? '') ? 'needs reconnection' : 'needs attention'}`
  if (action.status === 'waiting') return 'Waiting for caregiver acceptance'
  if (action.status === 'queued') return action.provider === 'apple' ? `Approved · waiting for ${context.storage === 'device' ? 'this' : 'the connected'} iPhone` : 'Approved · waiting to run'
  if (action.status === 'executing') return kind === 'calendar' ? 'Updating your calendar' : kind === 'email' ? 'Sending your email' : 'Sending the pickup request'
  if (context.storage === 'device' && kind !== 'calendar' || action.status === 'saved' && kind !== 'calendar') return kind === 'email' ? 'Email draft · not sent' : 'Pickup request · not sent'
  return kind === 'calendar' ? 'Calendar change ready for review' : kind === 'email' ? 'Email ready for review' : 'Pickup request ready for review'
}

export function jobSummary(job: Task, context: Context = {}): string {
  if (job.cancelled) {
    const completed = job.actions.find(a => done(a) && a.status !== 'cancelled')
    return completed ? `${actionSummary(completed, context)}; remaining work cancelled` : 'Cancelled'
  }
  if (job.scheduledFor) return context.storage === 'device' ? 'Scheduled to prepare · when Daymark is open' : 'Scheduled to prepare · approval before action'
  if (isConversation(job)) return compact(job.clarification)
  if (!job.actions.length) return job.preparing ? 'Preparing your request' : compact(job.clarification) || 'Open the request to add the missing details'
  const attention = job.actions.filter(needsYou)
  const completed = job.actions.filter(a => done(a) && a.status !== 'cancelled')
  if (attention.length && completed.length) return `${actionSummary(completed[0], context)}; ${actionSummary(attention[0], context).replace(/^./, c => c.toLowerCase())}`
  if (attention.length) return actionSummary(attention[0], context)
  const working = job.actions.find(a => a.revisionRequest || ['queued', 'executing', 'waiting'].includes(a.status))
  if (working) return completed.length ? `${actionSummary(completed[0], context)}; ${actionSummary(working, context).replace(/^./, c => c.toLowerCase())}` : actionSummary(working, context)
  if (job.preparing) return 'Preparing your request'
  return [...new Set(job.actions.map(a => actionSummary(a, context)))].join(' · ')
}

export type AssistantReplyOptions = Context & { parentName?: string; assistantName?: string }
/** Small, explicit local replies. Operational requests always reach preparation. */
export function localAssistantReply(text: string, options: AssistantReplyOptions = {}): string | null {
  const input = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
  if (!input || input.length > 120) return null
  const name = compact(options.parentName ?? '', 40)
  const assistant = compact(assistantName(options), 40)
  const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening']
  if (greetings.some(greeting => [greeting, `${greeting} there`, `${greeting} daymark`, `${greeting} ${assistant.toLowerCase()}`].includes(input))) return `Hi${name ? `, ${name}` : ''}. What can I take off your list? Tell me what needs sorting, or ask what needs your attention.`
  if (/^(thanks|thank you|thanks a lot|thank you very much|thank you so much|thanks daymark|thank you daymark)$/.test(input)) return 'You’re welcome. Send over the next thing whenever you’re ready.'
  if (/^(help|help me|what can you do|what do you do|how can you help( me)?|how does this work|what can i ask( you)?|show me what you can do|who are you)$/.test(input)) {
    const capabilities = options.storage === 'device'
      ? 'Share a school notice and I can prepare an editable calendar draft for your device plan. I can also prepare school replies and pickup requests for you to copy and send. In the iPhone app, you can connect Apple Calendar and approve calendar changes. Nothing is sent just by asking.'
      : 'I can prepare school calendar changes, school emails, and pickup requests. You review the details and choose what to approve. Connected accounts are needed for calendar updates and email sending; a pickup is only arranged after the caregiver accepts.'
    return `I’m ${assistant}, your AI assistant in Daymark. ${capabilities}`
  }
  return null
}
