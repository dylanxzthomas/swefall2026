import { Temporal } from '@js-temporal/polyfill'
import { isConversation, jobStatus, jobSummary, jobTitle, type Task } from './assistant.js'
import { calendarTimes, type Payload } from './daymark.js'
import { personalTaskSchema, type PersonalTask, type PersonalTaskInput } from './tasks.js'

export type HouseholdAssistantContext = {
  jobs: readonly Task[]
  personalTasks: readonly PersonalTask[]
  plan: readonly { payload: Payload }[]
  children?: readonly { id: string; name: string }[]
  timezone: string
  now?: number
  storage?: 'device'
  limited?: boolean
}
export type HouseholdAssistantResult = { kind: 'reply'; text: string } | { kind: 'personalTask'; input: PersonalTaskInput; text: string }
const compact = (text: string, length = 130) => {
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > length ? `${value.slice(0, length - 1).trimEnd()}…` : value
}
const normalized = (text: string) => text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
const reply = (text: string): HouseholdAssistantResult => ({ kind: 'reply', text })
const bullets = (items: string[]) => items.slice(0, 6).map(item => `• ${item}`).join('\n') + (items.length > 6 ? `\nAnd ${items.length - 6} more in Tasks.` : '')
const todayFor = (context: HouseholdAssistantContext) => Temporal.Instant.fromEpochMilliseconds(context.now ?? Date.now()).toZonedDateTimeISO(context.timezone).toPlainDate()

// Status answers use authoritative current actions. Original notices and old chat replies
// may have expired, contain instructions, or describe a state that is no longer true.
function workLine(job: Task, context: HouseholdAssistantContext): string {
  const safe = { ...job, source: null, clarification: '' }
  const title = job.actions.length ? jobTitle(safe, context.children) : job.scheduledFor ? 'Scheduled request' : 'Request needing details'
  const status = !job.actions.length && !job.preparing && !job.scheduledFor ? 'Open it to confirm the missing details' : jobSummary(safe, context)
  return `${title} — ${status}`
}

function personalTaskRequest(text: string, context: HouseholdAssistantContext): HouseholdAssistantResult | null {
  const input = text.trim().replace(/[.!]+$/, '')
  const match = input.match(/^(?:please\s+)?(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my|the)\s+(?:tasks|task list|to-do list|todo list|list)$/i)
    ?? input.match(/^(?:please\s+)?(?:add|create)\s+(?:a\s+)?task\s*(?::|to\s|for\s)\s*(.+)$/i)
    ?? input.match(/^(?:please\s+)?remind me to\s+(.+)$/i)
  if (!match) return null
  let title = match[1].trim(), dueDate: string | undefined
  if (/^(?:today|tomorrow|\d{4}-\d{2}-\d{2})$/i.test(title)) return reply('Tell me what the task is as well as when it is due, such as “Add pack lunch tomorrow to my tasks.”')
  if (/\b(?:at\s+\d|in\s+\d+\s+(?:minutes?|hours?)|every\s|daily\b|weekly\b|monthly\b)/i.test(title)) return reply('I can save a task with a due date, but I can’t set timed or recurring reminder alerts here yet. Add it in Tasks, or ask me to add it to your tasks without an alert time.')
  const due = title.match(/\s+(?:(?:due|by|on)\s+)?(today|tomorrow|\d{4}-\d{2}-\d{2})$/i)
  if (due) {
    try {
      dueDate = /^\d/.test(due[1]) ? Temporal.PlainDate.from(due[1]).toString() : todayFor(context).add({ days: due[1].toLowerCase() === 'tomorrow' ? 1 : 0 }).toString()
      title = title.slice(0, -due[0].length).trim()
    } catch { return reply('That date needs a correction. Use a real date like 2026-10-08, or choose a due date in Tasks.') }
  }
  const task = personalTaskSchema.safeParse({ title, notes: '', ...(dueDate ? { dueDate } : {}) })
  if (!task.success) return reply('Give the task a short title, up to 200 characters. You can add more detail in Tasks.')
  const reminder = /remind me to/i.test(input) ? ' This saves a task, not a reminder alert.' : ''
  return { kind: 'personalTask', input: task.data, text: `Added “${task.data.title}” to your tasks${dueDate ? `, due ${dueDate}` : ''}.${reminder}` }
}

/** Grounded local intents only. A personalTask result must be saved before its text is shown. */
export function householdAssistantReply(text: string, context: HouseholdAssistantContext): HouseholdAssistantResult | null {
  const task = personalTaskRequest(text, context)
  if (task) return task
  // Avoid a false all-clear when the server's bounded context does not cover the whole workspace.
  if (context.limited) {
    const result = householdAssistantReply(text, { ...context, limited: false })
    return result ? reply('There are more saved records than I can check in one reply. Open Tasks or Plan for the full list; I haven’t checked your inbox or other calendars.') : null
  }
  const input = normalized(text)
  const active = context.jobs.filter(job => !job.cancelled && !isConversation(job) && jobStatus(job) !== 'Finished')
  if (/^(?:what needs my attention(?: today)?|what do i need to do(?: today)?|what(?:'s| is) on my (?:task|to-do|todo) list|show (?:me )?my tasks|what are my tasks)$/.test(input)) {
    const personal = context.personalTasks.filter(task => !task.done).slice().sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.createdAt - b.createdAt)
    const attention = active.filter(job => jobStatus(job) === 'Needs you')
    const sections: string[] = []
    if (attention.length) sections.push(`Ready for your attention:\n${bullets(attention.map(job => workLine(job, context)))}`)
    if (personal.length) sections.push(`On your list:\n${bullets(personal.map(task => `${compact(task.title)}${task.dueDate ? ` — due ${task.dueDate}` : ''}`))}`)
    if (!sections.length) sections.push('Nothing in your saved tasks needs your attention right now.')
    sections.push('This is based on the work saved here; I haven’t checked your inbox or your full calendar.')
    return reply(sections.join('\n\n'))
  }
  if (/^(?:what are you (?:handling|working on|taking care of|doing)(?: for me)?|what(?:'s| is) in progress|show (?:me )?(?:your|assistant) tasks|what (?:have you|has sola) got (?:planned|scheduled))$/.test(input)) {
    return reply(active.length ? `Here’s where your requests stand:\n${bullets(active.map(job => workLine(job, context)))}\n\nOnly recorded work is shown. Anything sent or changed outside the app still needs your approval.` : 'I’m not handling any saved requests right now. Your personal to-dos stay in Tasks; I won’t mark them done for you.')
  }
  const calendar = input.match(/^(?:what(?:'s| is) on (?:my|the) (?:calendar|plan)|show (?:me )?(?:my|the) (?:calendar|plan)|what do i have(?: planned| scheduled)?|what(?:'s| is) happening) (today|tomorrow)$/)
  if (calendar) {
    let day: Temporal.PlainDate
    try { day = todayFor(context).add({ days: calendar[1] === 'tomorrow' ? 1 : 0 }) } catch { return reply('Confirm your household timezone in Settings so I can tell which events fall on that day.') }
    const start = day.toZonedDateTime(context.timezone).epochMilliseconds, end = day.add({ days: 1 }).toZonedDateTime(context.timezone).epochMilliseconds
    const events = context.plan.flatMap(item => {
      const p = item.payload
      if (p.kind !== 'calendar' || p.operation === 'delete') return []
      try {
        const time = calendarTimes(p)
        if (p.allDay) return p.date <= day.toString() && p.endDate >= day.toString() ? [{ start, label: `${compact(p.title)} — all day` }] : []
        const eventStart = Temporal.Instant.from(time.start.dateTime!), eventEnd = Temporal.Instant.from(time.end.dateTime!)
        if (eventStart.epochMilliseconds >= end || eventEnd.epochMilliseconds <= start) return []
        const label = eventStart.epochMilliseconds < start ? 'continues from the previous day' : new Intl.DateTimeFormat('en-US', { timeZone: context.timezone, hour: 'numeric', minute: '2-digit' }).format(eventStart.epochMilliseconds)
        return [{ start: eventStart.epochMilliseconds, label: `${compact(p.title)} — ${label}` }]
      } catch { return [] }
    }).sort((a, b) => a.start - b.start)
    const lines = events.slice(0, 6).map(event => `• ${event.label}`).join('\n')
    return reply(`${events.length ? `Saved for ${calendar[1]} (${day}):\n${lines}${events.length > 6 ? `\nAnd ${events.length - 6} more in Calendar.` : ''}` : `There are no events saved here for ${calendar[1]} (${day}).`}\n\nI’m using ${context.storage === 'device' ? 'this device’s saved plan' : 'Daymark’s saved calendar records'}, in ${context.timezone}. This isn’t a full sync of your other calendars.`)
  }
  return null
}

/** Keep open-ended chat out of the literal notice parser, which otherwise defaults to a calendar draft. */
export function isPreparationRequest(text: string): boolean {
  const value = text.trim()
  if (/(?:^|\n)\s*(?:event|subject|date|time|location)\s*:/i.test(value)) return true
  if (/^(?:what|why|how|who|when|where)\b/i.test(value)) return false
  if (/\b(?:draft|prepare|write|send|reply|rsvp|arrange|add|save|update|change|cancel|remove)\b[\s\S]*\b(?:email|reply|message|pickup|pick up|calendar|event|school notice|school trip)\b/i.test(value)) return true
  if (/\b(?:pick\s?up|collect .*(?:school|gate))\b/i.test(value)) return true
  if (/\b(?:school notice|school note|field trip|early dismissal|school closed|permission slip)\b/i.test(value)) return true
  return /\b(?:event|meeting|appointment|trip|practice|concert|birthday)\b[\s\S]*\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2})\b/i.test(value)
}
