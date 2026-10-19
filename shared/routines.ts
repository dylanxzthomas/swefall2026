import { Temporal } from '@js-temporal/polyfill'
import { z } from 'zod'

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine(value => {
  try { return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString() === value } catch { return false }
}, 'Choose a real calendar date.')
const timezoneSchema = z.string().trim().min(1).max(100).refine(value => {
  if (/^[+\-\u2212]/.test(value)) return false
  try { Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value); return true } catch { return false }
}, 'Choose a named timezone, such as America/Los_Angeles.')
const weekdaySchema = z.number().int().min(1).max(7)
const weekdaysSchema = z.array(weekdaySchema).transform(values => [...new Set(values)].sort((a, b) => a - b)).pipe(z.array(weekdaySchema).min(1).max(7))
const exceptionsSchema = z.array(dateSchema).transform(values => [...new Set(values)].sort()).pipe(z.array(dateSchema).max(366, 'Choose no more than 366 exception dates.'))

/** A schedule authorizes preparation or an internal task, never an external write. */
export const routineScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly']),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a time from 00:00 to 23:59.'),
  timezone: timezoneSchema,
  startDate: dateSchema,
  endDate: dateSchema.optional(),
  weekdays: weekdaysSchema.optional(),
  exceptDates: exceptionsSchema.optional(),
}).strict().superRefine((schedule, ctx) => {
  if (schedule.frequency === 'weekly' && !schedule.weekdays?.length) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Choose at least one weekday for a weekly routine.' })
  if (schedule.frequency === 'daily' && schedule.weekdays !== undefined) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Weekdays are only used for weekly routines.' })
  if (schedule.endDate && schedule.endDate < schedule.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after the start date.' })
})

export const routineDefinitionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('personal_task'),
      task: z.object({ title: z.string().trim().min(1).max(200), notes: z.string().trim().max(2000), childId: z.string().trim().min(1).max(100).optional() }).strict(),
      dueAfterDays: z.number().int().min(0).max(30),
    }).strict(),
    z.object({ kind: z.literal('prepare_request'), instruction: z.string().trim().min(1).max(20000) }).strict(),
  ]),
  schedule: routineScheduleSchema,
}).strict()

export type RoutineSchedule = z.infer<typeof routineScheduleSchema>
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>
export type Routine = { id: string; version: number; state: 'active' | 'paused' | 'blocked' | 'finished' | 'removed'; definition?: RoutineDefinition; nextRunAt?: number; lastRunAt?: number; issue?: string; createdAt: number; updatedAt: number; canEdit: boolean }
export type RoutineRun = { id: string; version: number; localDate: string; scheduledAt: number; caughtUpFrom?: number; createdAt: number; personalTaskId?: string; jobId?: string; status: string; summary: string; issue?: string }
export type RoutineOccurrence = {
  at: number
  /** Nominal date in the saved schedule, even if a timezone gap shifts the actual date. */
  localDate: string
}

const compare = Temporal.PlainDate.compare
const lastDate = Temporal.PlainDate.from('9999-12-31')
// At most 366 excluded occurrences, plus the query boundary and a skipped local date.
// Weekly routines jump directly to selected weekdays instead of scanning intervening days.
const maxCandidates = 370

function checkedInstant(value: number): Temporal.Instant {
  if (!Number.isSafeInteger(value)) throw new RangeError('Use an integer epoch time in milliseconds.')
  return Temporal.Instant.fromEpochMilliseconds(value)
}

function eligibleDate(schedule: RoutineSchedule, date: Temporal.PlainDate, direction: 1 | -1): Temporal.PlainDate {
  if (schedule.frequency === 'daily') return date
  const offset = Math.min(...schedule.weekdays!.map(day => (direction * (day - date.dayOfWeek) + 7) % 7))
  return date.add({ days: direction * offset })
}

function occurrence(schedule: RoutineSchedule, date: Temporal.PlainDate): RoutineOccurrence {
  // Reconstruct each wall-clock occurrence. Adding 24 hours would drift across DST.
  // Compatible means forward through gaps and the first instance during overlaps.
  const at = date.toPlainDateTime(schedule.time).toZonedDateTime(schedule.timezone, { disambiguation: 'compatible' }).epochMilliseconds
  return { at, localDate: date.toString() }
}

/** First eligible occurrence strictly after the instant. Start/end dates are inclusive. */
export function nextOccurrence(schedule: RoutineSchedule, afterExclusiveMs: number): RoutineOccurrence | null {
  schedule = routineScheduleSchema.parse(schedule)
  const after = checkedInstant(afterExclusiveMs)
  const start = Temporal.PlainDate.from(schedule.startDate), end = schedule.endDate ? Temporal.PlainDate.from(schedule.endDate) : lastDate
  const reference = after.toZonedDateTimeISO(schedule.timezone).toPlainDate()
  if (compare(reference, end.add({ days: 1 })) > 0) return null
  // A whole-date timezone gap can move the previous nominal date into this actual date.
  let date = compare(reference, start) <= 0 ? start : reference.subtract({ days: 1 })
  const excluded = new Set(schedule.exceptDates ?? [])
  for (let attempt = 0; attempt < maxCandidates; attempt++) {
    date = eligibleDate(schedule, date, 1)
    if (compare(date, end) > 0) return null
    if (!excluded.has(date.toString())) {
      const candidate = occurrence(schedule, date)
      if (candidate.at > afterExclusiveMs) return candidate
    }
    date = date.add({ days: 1 })
  }
  // Valid schedules have at most 366 exclusions, so exhaustion would signal a bug.
  throw new Error('Could not resolve the next routine occurrence within its search bound.')
}

/** Latest eligible occurrence in the inclusive instant range, without choosing catch-up policy. */
export function latestOccurrence(schedule: RoutineSchedule, atOrBeforeMs: number, notBeforeMs: number): RoutineOccurrence | null {
  schedule = routineScheduleSchema.parse(schedule)
  const before = checkedInstant(atOrBeforeMs)
  checkedInstant(notBeforeMs)
  if (notBeforeMs > atOrBeforeMs) return null
  const start = Temporal.PlainDate.from(schedule.startDate), end = schedule.endDate ? Temporal.PlainDate.from(schedule.endDate) : lastDate
  const reference = before.toZonedDateTimeISO(schedule.timezone).toPlainDate()
  let date = compare(reference, end) > 0 ? end : reference
  const excluded = new Set(schedule.exceptDates ?? [])
  for (let attempt = 0; attempt < maxCandidates; attempt++) {
    date = eligibleDate(schedule, date, -1)
    if (compare(date, start) < 0) return null
    if (!excluded.has(date.toString())) {
      const candidate = occurrence(schedule, date)
      if (candidate.at < notBeforeMs) return null
      if (candidate.at <= atOrBeforeMs) return candidate
    }
    date = date.subtract({ days: 1 })
  }
  throw new Error('Could not resolve the latest routine occurrence within its search bound.')
}
