import { Temporal } from '@js-temporal/polyfill'
import type { RoutineDefinition } from './routines.js'

const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
export function emptyRoutine(timezone: string, now = Date.now()): RoutineDefinition {
  return { title: '', outcome: { kind: 'personal_task', task: { title: '', notes: '' }, dueAfterDays: 0 }, schedule: { frequency: 'weekly', weekdays: [7], time: '', timezone, startDate: Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone).toPlainDate().toString() } }
}

/** Suggests editable fields only. Never saves a recurrence or infers permission. */
export function routineFromRequest(text: string, timezone: string, now = Date.now()): { definition: RoutineDefinition; note: string } | null {
  const input = text.trim().replace(/[.!]+$/, '')
  if (input.length > 2000 || /[\r\n]/.test(input)) return null
  // Anchored imperative grammar keeps quoted notices and capability questions out.
  const first = input.match(/^(?:please\s+)?every\s+(.+?)[,;]?\s+(add\b.+|remind me\b.+|prepare\b.+|draft\b.+|write\b.+)$/i)
  const last = first ? null : input.match(/^(?:please\s+)?(add\b.+|remind me\b.+|prepare\b.+|draft\b.+|write\b.+?)\s+every\s+(.+)$/i)
  if (!first && !last) return null
  const recurrence = (first ? first[1] : last![2]).trim().replace(/[,;]$/, '')
  const task = (first ? first[2] : last![1]).trim()
  const definition = emptyRoutine(timezone, now)
  const match = recurrence.match(/^(day|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:at\s+)?(.+))?$/i)
  let note = 'Review the schedule before saving. Nothing has been scheduled yet.'
  if (!match) {
    // Leave the frequency unselected instead of silently changing unsupported recurrence.
    definition.schedule.weekdays = []
    note = 'This wording needs a schedule. Choose daily or weekly and confirm the dates; other repeat patterns are not supported yet.'
  } else {
    const day = match[1].toLowerCase()
    if (day === 'day') { definition.schedule.frequency = 'daily'; delete definition.schedule.weekdays }
    else definition.schedule.weekdays = day === 'weekday' ? [1, 2, 3, 4, 5] : day === 'weekend' ? [6, 7] : [days.indexOf(day) + 1]
    const clock = match[2]?.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
    if (clock) {
      let hour = Number(clock[1]); const minute = Number(clock[2] ?? '0'), meridiem = clock[3]?.toLowerCase()
      if (minute < 60 && (meridiem ? hour >= 1 && hour <= 12 : hour <= 23 && !!clock[2])) {
        if (meridiem) hour = hour % 12 + (meridiem === 'pm' ? 12 : 0)
        definition.schedule.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      }
    }
    if (!definition.schedule.time) note = 'Choose an exact time, then review the routine before saving.'
  }
  if (/^(?:prepare|draft|write)\b/i.test(task)) {
    definition.title = task.slice(0, 200)
    definition.outcome = { kind: 'prepare_request', instruction: task }
  } else {
    const title = task.replace(/^(?:add\s+|remind me\s+(?:to\s+)?)/i, '').replace(/\s+to my (?:tasks|to-do list|list)$/i, '').trim()
    definition.title = title.slice(0, 200)
    definition.outcome = { kind: 'personal_task', task: { title: title.slice(0, 200), notes: '' }, dueAfterDays: 0 }
  }
  return { definition, note }
}

export function routineScheduleLabel(definition: RoutineDefinition): string {
  const s = definition.schedule
  const day = s.frequency === 'daily' ? 'Every day' : s.weekdays?.map(n => days[n - 1]?.slice(0, 3)).filter(Boolean).map(v => v![0].toUpperCase() + v!.slice(1)).join(', ') || 'Choose days'
  return `${day} · ${s.time || 'Choose time'} · ${s.timezone}`
}
