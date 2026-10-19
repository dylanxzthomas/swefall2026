import { z } from 'zod'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { Temporal } from '@js-temporal/polyfill'

const short = z.string().trim().max(300)
export const calendarSchema = z.object({
  kind: z.literal('calendar'), operation: z.enum(['save', 'delete']).optional(), title: short, childId: z.string().nullable(),
  date: z.string(), startTime: z.string().nullable(), endDate: z.string(), endTime: z.string().nullable(),
  allDay: z.boolean(), timezone: z.string(), location: short, notes: z.string().max(2000),
  targetId: z.string().nullable(), evidence: z.record(z.string(), z.string().max(2000)),
})
export const emailSchema = z.object({
  kind: z.literal('email'), childId: z.string().nullable(), to: z.string().max(320),
  subject: short, body: z.string().max(12000), requirement: z.string().max(2000),
  attachments: z.array(z.object({ id: z.string(), name: z.string().max(200), hash: z.string() })).max(5).optional(),
  evidence: z.record(z.string(), z.string().max(2000)),
})
export const pickupSchema = z.object({
  kind: z.literal('pickup'), childId: z.string().nullable(), caregiverId: z.string().nullable(),
  date: z.string(), time: z.string().nullable(), timezone: z.string(), location: short,
  calendarUpdate: calendarSchema.optional(), followUpAt: z.string().optional(),
  deadline: z.string(), message: z.string().max(3000), evidence: z.record(z.string(), z.string().max(2000)),
})
export const payloadSchema = z.discriminatedUnion('kind', [calendarSchema, emailSchema, pickupSchema])
export type CalendarDraft = z.infer<typeof calendarSchema>
export type EmailDraft = z.infer<typeof emailSchema>
export type PickupDraft = z.infer<typeof pickupSchema>
export type Payload = z.infer<typeof payloadSchema>
export type ActionStatus = 'review' | 'queued' | 'executing' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled' | 'waiting' | 'saved'
export const extractionSchema = z.object({ actions: z.array(payloadSchema).max(8), clarification: z.string().max(2000) })
export const hash = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)))
export const sourceHash = (text: string) => hash(text.trim().replace(/\r\n/g, '\n'))
export const payloadHash = (payload: Payload) => hash(JSON.stringify(payloadSchema.parse(payload)))
export function validTimezone(value: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true } catch { return false }
}
export function instant(date: string, time: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Enter a complete date and time.')
  return Temporal.ZonedDateTime.from(`${date}T${time}:00[${timezone}]`, { disambiguation: 'reject', overflow: 'reject' })
}
export function localDateTime(value: string, timezone: string) {
  try { return Temporal.Instant.from(value).toZonedDateTimeISO(timezone).toPlainDateTime().toString({ smallestUnit: 'minute' }) } catch { return /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) ? value : '' }
}
export function dateTimeInstant(value: string, timezone: string) {
  try { const [date, time] = value.split('T'); return instant(date, time, timezone).toInstant().toString() } catch { return value }
}
export function calendarTimes(p: CalendarDraft) {
  if (!validTimezone(p.timezone)) throw new Error('Confirm the timezone.')
  if (p.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !/^\d{4}-\d{2}-\d{2}$/.test(p.endDate)) throw new Error('Confirm both dates.')
    const start = Temporal.PlainDate.from(p.date), end = Temporal.PlainDate.from(p.endDate)
    if (Temporal.PlainDate.compare(end, start) < 0) throw new Error('End date must follow the start date.')
    return { start: { date: start.toString() }, end: { date: end.add({ days: 1 }).toString() } }
  }
  if (!p.startTime || !p.endTime) throw new Error('Confirm the start and end time. No duration has been assumed.')
  const start = instant(p.date, p.startTime, p.timezone), end = instant(p.endDate, p.endTime, p.timezone)
  if (end.epochMilliseconds <= start.epochMilliseconds) throw new Error('End time must follow the start time.')
  return { start: { dateTime: start.toInstant().toString(), timeZone: p.timezone }, end: { dateTime: end.toInstant().toString(), timeZone: p.timezone } }
}
export function blockers(payload: Payload, children: { id: string }[], now = Date.now()): string[] {
  const errors: string[] = []
  if (payload.kind === 'pickup' && !payload.childId || payload.childId && !children.some(c => c.id === payload.childId)) errors.push('Confirm the child.')
  if (payload.kind === 'calendar') {
    if (!payload.title) errors.push('Add an event title.')
    if (payload.operation === 'delete' && !payload.targetId) errors.push('Choose an existing Daymark event to remove.')
    try { if (payload.operation !== 'delete') calendarTimes(payload) } catch (e) { errors.push((e as Error).message) }
  } else if (payload.kind === 'email') {
    if (!z.email().safeParse(payload.to).success || /[\r\n]/.test(payload.to)) errors.push('Confirm a valid recipient email.')
    if (!payload.subject || /[\r\n]/.test(payload.subject) || !payload.body.trim()) errors.push('Complete the subject and message.')
    if (payload.requirement) errors.push(payload.requirement)
  } else {
    if (payload.calendarUpdate) {
      if (payload.calendarUpdate.childId !== payload.childId) errors.push('The calendar update must concern the same child.')
      errors.push(...blockers(payload.calendarUpdate, children, now))
    }
    if (!payload.caregiverId) errors.push('Choose an eligible caregiver.')
    if (!payload.location || !payload.message.trim()) errors.push('Confirm the pickup location and message.')
    try {
      const at = instant(payload.date, payload.time ?? '', payload.timezone).epochMilliseconds
      const deadline = Temporal.Instant.from(payload.deadline).epochMilliseconds
      if (at - now < 2 * 3600_000) errors.push('Contact them directly. Email is not dependable for pickup less than two hours away.')
      if (payload.followUpAt !== undefined) {
        try { const followup = Temporal.Instant.from(payload.followUpAt).epochMilliseconds; if (followup <= now || followup >= deadline) errors.push('Set the one reminder after now and before the response deadline.') }
        catch { errors.push('Choose a reminder date and time, or turn off the reminder.') }
      }
      if (deadline <= now || deadline >= at) errors.push('Set a response deadline before pickup and after now.')
    } catch { errors.push('Confirm pickup time, timezone, and response deadline.') }
  }
  return errors
}
export function eventBody(p: CalendarDraft, actionId: string, revision: number) {
  return { summary: p.title, location: p.location, description: p.notes, ...calendarTimes(p),
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { daymarkAction: actionId, daymarkRevision: String(revision) } } }
}
export function sameEvent(actual: any, expected: ReturnType<typeof eventBody>) {
  const sameTime = (a: any, b: any) => b.date ? a?.date === b.date : Boolean(a?.dateTime) && Date.parse(a.dateTime) === Date.parse(b.dateTime)
  return actual.status !== 'cancelled' && actual.summary === expected.summary && (actual.location ?? '') === expected.location &&
    (actual.description ?? '') === expected.description && sameTime(actual.start, expected.start) && sameTime(actual.end, expected.end) &&
    actual.extendedProperties?.private?.daymarkAction === expected.extendedProperties.private.daymarkAction &&
    actual.extendedProperties?.private?.daymarkRevision === expected.extendedProperties.private.daymarkRevision
}
export function statusText(status: ActionStatus, kind: Payload['kind']) {
  if (status === 'saved') return 'Saved to this device’s plan'
  if (status === 'succeeded') return kind === 'calendar' ? 'Calendar updated · verified' : kind === 'email' ? 'Email sent · provider accepted' : 'Caregiver accepted'
  return ({ review: 'Ready to review', queued: 'Approved · waiting to run', executing: 'Working', failed: 'Needs your help', uncertain: 'Result unconfirmed', cancelled: 'Cancelled', waiting: 'Waiting for caregiver' } as Record<string, string>)[status]
}
