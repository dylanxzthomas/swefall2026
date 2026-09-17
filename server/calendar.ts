import * as ical from 'node-ical'
import type { Config } from './config.js'
import { icsUrls } from './config.js'
import { Events, People } from './db.js'
import { readLocalCalendar } from './brain/tools.js'
import { addDays, startOfDay } from './time.js'
import { emit } from './bus.js'
import type { Attendee } from '../shared/types.js'

interface RawEvent {
  uid: string
  title: string
  description: string | null
  location: string | null
  start: Date
  end: Date
  allDay: boolean
  attendees: { name: string; email: string | null }[]
}

type IcalAttendee = string | { params?: Record<string, unknown>; val?: string }

function attendeesOf(ev: ical.VEvent): { name: string; email: string | null }[] {
  const raw = (ev as unknown as { attendee?: IcalAttendee | IcalAttendee[] }).attendee
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  const out: { name: string; email: string | null }[] = []
  for (const a of list) {
    if (typeof a === 'string') {
      const email = a.replace(/^mailto:/i, '').trim()
      out.push({ name: email, email: email.includes('@') ? email.toLowerCase() : null })
      continue
    }
    const email = String(a.val ?? '').replace(/^mailto:/i, '').trim()
    const cn = typeof a.params?.CN === 'string' ? (a.params.CN as string).replace(/^"|"$/g, '').trim() : ''
    const name = cn || email
    if (name) out.push({ name, email: email.includes('@') ? email.toLowerCase() : null })
  }
  return out
}

function expand(data: ical.CalendarResponse, winStart: Date, winEnd: Date): RawEvent[] {
  const out: RawEvent[] = []
  for (const k of Object.keys(data)) {
    const ev = data[k] as ical.VEvent
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue
    const base = {
      title: String(ev.summary ?? '(untitled)'),
      description: ev.description ? String(ev.description) : null,
      location: ev.location ? String(ev.location) : null,
      allDay: (ev as unknown as { datetype?: string }).datetype === 'date',
      attendees: attendeesOf(ev),
    }
    const start = new Date(ev.start)
    const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 60 * 60_000)
    const duration = Math.max(0, end.getTime() - start.getTime())
    const rrule = (ev as unknown as { rrule?: { between: (a: Date, b: Date, inc: boolean) => Date[] } }).rrule
    if (rrule) {
      let dates: Date[] = []
      try {
        dates = rrule.between(winStart, winEnd, true)
      } catch {
        dates = []
      }
      const recurrences = (ev as unknown as { recurrences?: Record<string, ical.VEvent> }).recurrences ?? {}
      const exdates = (ev as unknown as { exdate?: Record<string, unknown> }).exdate ?? {}
      for (const d of dates) {
        const key = d.toISOString().slice(0, 10)
        let s = d
        let e = new Date(d.getTime() + duration)
        let cur = base
        if (recurrences[key]) {
          const r = recurrences[key]
          s = new Date(r.start)
          e = r.end ? new Date(r.end) : new Date(s.getTime() + duration)
          cur = { ...base, title: String(r.summary ?? base.title), description: r.description ? String(r.description) : base.description, location: r.location ? String(r.location) : base.location, attendees: attendeesOf(r).length ? attendeesOf(r) : base.attendees }
        } else if (exdates[key]) continue
        out.push({ ...cur, uid: `${ev.uid}_${key}`, start: s, end: e })
      }
      // Overridden single instances that fall outside the rrule dates still count.
      for (const [key, r] of Object.entries(recurrences)) {
        if (dates.some((d) => d.toISOString().slice(0, 10) === key)) continue
        const s = new Date(r.start)
        if (s < winStart || s > winEnd) continue
        out.push({ ...base, title: String(r.summary ?? base.title), uid: `${ev.uid}_${key}`, start: s, end: r.end ? new Date(r.end) : new Date(s.getTime() + duration) })
      }
      continue
    }
    if (end < winStart || start > winEnd) continue
    out.push({ ...base, uid: String(ev.uid ?? k), start, end })
  }
  return out
}

export interface RefreshResult {
  imported: number
  changed: string[]
  removed: string[]
  errors: string[]
}

/** Pull every feed plus the local calendar into the events table, attaching people to attendees. */
export async function refreshCalendar(cfg: Config): Promise<RefreshResult> {
  const winStart = addDays(startOfDay(new Date()), -1)
  const winEnd = addDays(startOfDay(new Date()), 14)
  const mine = new Set(cfg.user.emails.map((s) => s.toLowerCase()))
  const errors: string[] = []
  const changed: string[] = []
  let imported = 0

  const toAttendees = (list: { name: string; email: string | null }[]): Attendee[] =>
    list
      .filter((a) => !(a.email && mine.has(a.email)))
      .filter((a) => a.name.toLowerCase() !== cfg.user.name.toLowerCase())
      .map((a) => ({ name: a.name, email: a.email, person_id: People.ensureFromAttendee(a).id }))

  const seenIcs = new Set<string>()
  for (const url of icsUrls(cfg)) {
    try {
      const data = await ical.async.fromURL(url)
      for (const raw of expand(data, winStart, winEnd)) {
        seenIcs.add(raw.uid)
        const { event, changed: c } = Events.upsert({
          source: 'ics',
          uid: raw.uid,
          title: raw.title,
          description: raw.description,
          location: raw.location,
          start: raw.start.toISOString(),
          end: raw.end.toISOString(),
          all_day: raw.allDay ? 1 : 0,
          attendees: toAttendees(raw.attendees),
        })
        if (c) changed.push(event.id)
        imported++
      }
    } catch (err) {
      const host = (() => {
        try {
          return new URL(url).host
        } catch {
          return url.slice(0, 30)
        }
      })()
      errors.push(`${host}: ${(err as Error).message}`)
    }
  }
  let removed: string[] = []
  if (errors.length === 0) removed = Events.pruneMissing('ics', seenIcs, winStart, winEnd)

  const seenLocal = new Set<string>()
  for (const e of readLocalCalendar()) {
    const s = new Date(e.start)
    const en = new Date(e.end)
    if (Number.isNaN(s.getTime()) || Number.isNaN(en.getTime())) continue
    seenLocal.add(e.id)
    const { event, changed: c } = Events.upsert({
      source: 'local',
      uid: e.id,
      title: e.title,
      description: e.description ?? null,
      location: e.location ?? null,
      start: s.toISOString(),
      end: en.toISOString(),
      all_day: 0,
      attendees: toAttendees((e.attendees ?? []).map((a) => ({ name: a.name, email: a.email ? a.email.toLowerCase() : null }))),
    })
    if (c) changed.push(event.id)
    imported++
  }
  removed = removed.concat(Events.pruneMissing('local', seenLocal, winStart, winEnd))

  emit('calendar.refreshed', { imported, changed: changed.length, removed: removed.length, errors })
  return { imported, changed, removed, errors }
}
