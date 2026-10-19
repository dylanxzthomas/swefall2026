import type { CalendarDraft } from './daymark.js'
import { calendarTimes } from './daymark.js'
import { eventInstant } from './calendarAwareness.js'

export type CalendarAgenda = {
  owner?: string; from?: number; through?: number; truncated: boolean; availabilityKnown: boolean
  events: { id: string; title: string; start: number; end: number; allDay: boolean; location: string; provider: string; providerId?: string; calendarId?: string; connectionId?: string; connectionVersion?: number; etag?: string }[]
  coverage: { feedId: string; complete: boolean; fresh: boolean; from: number; through: number; issue?: string; provider?: string; connectionId?: string; connectionVersion?: number; calendars?: string[] }[]
}
export type SavedCalendarIdentity = {
  owner?: string; provider?: string; connectionId?: string; connectionVersion?: number; calendarId?: string; eventId?: string; etag?: string
}

/** A shared receipt is history. Only the owner may compare it with private reads. */
export function calendarPlanStatus(saved: SavedCalendarIdentity & { payload: CalendarDraft }, agenda?: CalendarAgenda) {
  const historical = 'Last verified calendar details'
  if (!agenda?.owner || saved.owner !== agenda.owner || !saved.connectionId || saved.connectionVersion === undefined || !saved.calendarId || !saved.eventId) return historical
  const provider = saved.provider ?? 'google'
  const coverage = agenda.coverage.find(c => c.connectionId === saved.connectionId && c.connectionVersion === saved.connectionVersion && c.provider === provider && c.calendars?.includes(saved.calendarId!) && c.complete && c.fresh && !c.issue)
  if (!coverage) return historical
  const current = agenda.events.find(e => e.connectionId === saved.connectionId && e.connectionVersion === saved.connectionVersion && e.provider === provider && e.calendarId === saved.calendarId && e.providerId === saved.eventId)
  if (current) return current.etag && saved.etag && current.etag !== saved.etag
    ? 'Calendar changed since this save · current event shown above'
    : 'Last verified details · current event shown above'
  // An event might have moved outside the window. Absence is not proof of deletion.
  if (!agenda.truncated && agenda.from !== undefined && agenda.through !== undefined) try {
    const times = calendarTimes(saved.payload)
    const start = times.start.date ? eventInstant(times.start.date, saved.payload.timezone, true) : Date.parse(times.start.dateTime!)
    const end = times.end.date ? eventInstant(times.end.date, saved.payload.timezone, true) : Date.parse(times.end.dateTime!)
    if (coverage.from <= start && coverage.through >= end && agenda.from <= start && agenda.through >= end) return 'Not in the latest checked window · previously verified details'
  } catch { /* Incomplete legacy records remain historical. */ }
  return historical
}
