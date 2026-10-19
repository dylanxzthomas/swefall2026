import { Temporal } from '@js-temporal/polyfill'
import { calendarTimes, hash, instant, payloadHash, type CalendarDraft } from './daymark.js'
export type NativeCalendarChoice = { id: string; title: string; account: string }
export type NativeCalendarState = { available: boolean; permission: 'prompt' | 'granted' | 'denied'; calendars: NativeCalendarChoice[]; selectedId?: string; version: number }
export type NativeEvent = { eventId: string; calendarId: string; fingerprint: string; title: string; location: string; notes: string; start: number; end: number; allDay: boolean; timezone: string }
export type NativeCalendarOperation = { operationId: string; approvalHash: string; calendarId: string; operation: 'save' | 'delete'; title: string; location: string; notes: string; start: number; end: number; allDay: boolean; timezone: string; eventId?: string; expectedFingerprint?: string }
export type NativeCalendarResult = { status: 'verified' | 'uncertain' | 'review'; eventId?: string; fingerprint?: string; verifiedAt?: number; message?: string }
export function nativeOperation(actionId: string, revision: number, sourceRevision: number, payload: CalendarDraft, destination: { calendarId: string; version: number }, before?: NativeEvent): NativeCalendarOperation {
  if (payload.operation === 'delete' && !before) throw new Error('Choose an existing Apple Calendar event to remove.')
  const times = payload.operation === 'delete' ? undefined : calendarTimes(payload)
  if (payload.targetId && (!before || before.calendarId !== destination.calendarId)) throw new Error('The original Apple Calendar destination changed. Refresh the event and review again.')
  const content = { actionId, revision, sourceRevision, payload: payloadHash(payload), destination, fingerprint: before?.fingerprint }
  return { operationId: hash(`apple:${actionId}:${revision}`), approvalHash: hash(JSON.stringify(content)), calendarId: destination.calendarId, operation: payload.operation ?? 'save', title: times ? payload.title : before!.title, location: times ? payload.location : before!.location, notes: times ? payload.notes : before!.notes, start: times ? times.start.date ? instant(times.start.date, '00:00', payload.timezone).epochMilliseconds : Date.parse(times.start.dateTime!) : before!.start, end: times ? times.end.date ? instant(times.end.date, '00:00', payload.timezone).epochMilliseconds : Date.parse(times.end.dateTime!) : before!.end, allDay: times ? payload.allDay : before!.allDay, timezone: times ? payload.timezone : before!.timezone, ...(before ? { eventId: before.eventId, expectedFingerprint: before.fingerprint } : {}) }
}
export function validateNativeDestination(current: NativeCalendarState | undefined, reviewed?: { calendarId: string; version: number }) {
  if (!current?.selectedId && !reviewed) return
  if (!reviewed || !current?.available || current.permission !== 'granted' || reviewed.calendarId !== current.selectedId || reviewed.version !== current.version || !current.calendars.some(c => c.id === reviewed.calendarId)) throw new Error('The Apple Calendar selection changed. Review the current destination before approving.')
}

export function nativeEventPayload(event: NativeEvent, previous: CalendarDraft): CalendarDraft {
  const start = Temporal.Instant.fromEpochMilliseconds(event.start).toZonedDateTimeISO(event.timezone), end = Temporal.Instant.fromEpochMilliseconds(event.end).toZonedDateTimeISO(event.timezone)
  return { ...previous, title: event.title, location: event.location, notes: event.notes, allDay: event.allDay, timezone: event.timezone, date: start.toPlainDate().toString(), startTime: event.allDay ? null : start.toPlainTime().toString({ smallestUnit: 'minute' }), endDate: (event.allDay ? end.subtract({ days: 1 }) : end).toPlainDate().toString(), endTime: event.allDay ? null : end.toPlainTime().toString({ smallestUnit: 'minute' }) }
}
