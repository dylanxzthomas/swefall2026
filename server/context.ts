import type { Config } from './config.js'
import type { CalEvent, Checkin, Person } from '../shared/types.js'
import { Checkins, Commitments, Events, Facts, Notes, Observations, People } from './db.js'
import { addDays, fmtDay, fmtNowLong, fmtTime, startOfDay } from './time.js'

const clean = (s: string | null | undefined) => (s ?? '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim()

function eventLine(ev: CalEvent, withDay: boolean): string {
  const who = ev.attendees.map((a) => a.name).join(', ')
  const when = ev.all_day ? `${withDay ? fmtDay(ev.start) + ', ' : ''}all day` : `${withDay ? fmtDay(ev.start) + ' ' : ''}${fmtTime(ev.start)} to ${fmtTime(ev.end)}`
  const bits = [`${when}: ${clean(ev.title)}`]
  if (who) bits.push(`with ${clean(who)}`)
  if (ev.location) bits.push(`at ${clean(ev.location)}`)
  return `- ${bits.join(', ')} [event id ${ev.id}]${ev.description ? `\n  Notes on the invite: ${clean(ev.description).slice(0, 300)}` : ''}`
}

function checkinLine(c: Checkin): string {
  const s = c.status === 'done' ? `done${c.summary ? `: ${clean(c.summary)}` : ''}` : c.status
  return `- ${fmtTime(c.scheduled_for)}: ${clean(c.title)} (${s})`
}

function personBlock(p: Person, factLimit: number): string {
  const facts = Facts.forPerson(p.id).slice(0, factLimit)
  const open = Commitments.forPerson(p.id).filter((c) => c.status === 'open')
  const head = [p.name]
  const desc = [p.role, p.company].filter(Boolean).join(', ')
  if (desc) head.push(desc)
  const lines = [`- ${clean(head.join('; '))} [person id ${p.id}]`]
  if (p.relationship) lines.push(`  Relationship: ${clean(p.relationship)}`)
  if (p.last_contact_at) lines.push(`  Last contact: ${fmtDay(p.last_contact_at)}`)
  if (p.summary) lines.push(`  Summary: ${clean(p.summary)}`)
  if (p.wants) lines.push(`  Wants: ${clean(p.wants)}`)
  if (p.avoid) lines.push(`  Avoid: ${clean(p.avoid)}`)
  if (p.notes) lines.push(`  Notes: ${clean(p.notes).slice(0, 400)}`)
  for (const f of facts) lines.push(`  Fact (${fmtDay(f.created_at)}, ${clean(f.source)}): ${clean(f.text)}${f.evidence ? ` ["${clean(f.evidence).slice(0, 160)}"]` : ''}`)
  for (const c of open) lines.push(`  Open: ${c.owner === 'me' ? 'they are owed' : 'they owe'} "${clean(c.text)}"${c.due ? ` (due ${fmtDay(c.due)})` : ''} [commitment id ${c.id}]`)
  return lines.join('\n')
}

export interface WorldOptions {
  checkin?: Checkin
  event?: CalEvent
  now?: Date
}

/** Everything the brain is allowed to know right now, as data. Untrusted text is wrapped as information, never as instruction. */
export function worldContext(cfg: Config, opts: WorldOptions = {}): string {
  const now = opts.now ?? new Date()
  const dayStart = startOfDay(now)
  const tomorrow = addDays(dayStart, 1)
  const dayAfter = addDays(dayStart, 2)
  const week = addDays(dayStart, 8)

  const todayEvents = Events.between(dayStart, tomorrow)
  const tomorrowEvents = Events.between(tomorrow, dayAfter)
  const laterEvents = Events.between(dayAfter, week)
  const todayCheckins = Checkins.between(dayStart, tomorrow)
  const tomorrowCheckins = Checkins.between(tomorrow, dayAfter)

  // People who matter for the next two days: attendees, open commitments, queued observations, recently in touch.
  const relevant = new Map<string, Person>()
  const addPerson = (id: string | null | undefined) => {
    if (!id || relevant.has(id)) return
    const p = People.get(id)
    if (p) relevant.set(id, p)
  }
  for (const ev of [...todayEvents, ...tomorrowEvents, ...laterEvents]) for (const a of ev.attendees) addPerson(a.person_id)
  for (const c of Commitments.open()) addPerson(c.person_id)
  const queued = Observations.queued()
  for (const o of queued) addPerson(o.person_id)
  for (const p of People.all()
    .filter((p) => p.last_contact_at)
    .sort((a, b) => (b.last_contact_at! < a.last_contact_at! ? -1 : 1))
    .slice(0, 8))
    addPerson(p.id)
  const focusIds = new Set((opts.event?.attendees ?? []).map((a) => a.person_id).filter(Boolean) as string[])
  for (const id of focusIds) addPerson(id)

  const peopleLines = Array.from(relevant.values())
    .slice(0, 30)
    .map((p) => personBlock(p, focusIds.has(p.id) ? 15 : 3))

  const sections: string[] = []
  sections.push(`<now>${fmtNowLong(now, cfg.user.timezone)}</now>`)

  if (opts.event) {
    sections.push(`<focus>\nThe meeting this conversation is about:\n${eventLine(opts.event, true)}\n</focus>`)
  }
  if (opts.checkin?.reason) sections.push(`<why>${clean(opts.checkin.reason)}</why>`)

  sections.push(
    `<today date="${fmtDay(dayStart)}">\nCalendar:\n${todayEvents.length ? todayEvents.map((e) => eventLine(e, false)).join('\n') : '- nothing on the calendar'}\nConversations with you:\n${todayCheckins.length ? todayCheckins.map(checkinLine).join('\n') : '- none'}\n</today>`,
  )
  sections.push(
    `<tomorrow date="${fmtDay(tomorrow)}">\n${tomorrowEvents.length ? tomorrowEvents.map((e) => eventLine(e, false)).join('\n') : '- nothing on the calendar'}\n${tomorrowCheckins.length ? 'Conversations with you:\n' + tomorrowCheckins.map(checkinLine).join('\n') : ''}\n</tomorrow>`,
  )
  if (laterEvents.length) sections.push(`<later>\n${laterEvents.map((e) => eventLine(e, true)).join('\n')}\n</later>`)

  sections.push(`<people>\n${peopleLines.length ? peopleLines.join('\n') : '- no one on file yet'}\n</people>`)

  const open = Commitments.open()
  sections.push(
    `<commitments>\n${
      open.length
        ? open
            .map((c) => {
              const who = c.person_id ? People.get(c.person_id)?.name ?? 'someone' : 'no one in particular'
              const dir = c.owner === 'me' ? `${cfg.user.name} owes ${who}` : `${who} owes ${cfg.user.name}`
              const age = Math.round((now.getTime() - new Date(c.created_at).getTime()) / 86_400_000)
              return `- ${dir}: "${clean(c.text)}"${c.due ? `, due ${fmtDay(c.due)}${new Date(c.due) < now ? ' (past due)' : ''}` : ''}, open ${age} day${age === 1 ? '' : 's'} [commitment id ${c.id}]`
            })
            .join('\n')
        : '- none open'
    }\n</commitments>`,
  )

  const recentSurfaced = Observations.surfacedSince(addDays(now, -7))
  const obsLine = (o: import('../shared/types.js').Observation) =>
    `- [${o.id}] ${o.kind}, ${o.status}${o.surface_when === 'never' ? ', note to self, not to be spoken' : ''}${o.surfaced_at ? `, said ${fmtDay(o.surfaced_at)}` : `, made ${fmtDay(o.created_at)}`}: ${clean(o.text)}\n  Evidence: ${o.evidence.map(clean).join(' | ')}${o.outcome ? `\n  Outcome: ${clean(o.outcome)}` : ''}`
  sections.push(
    `<observations>\nQueued (not yet said):\n${queued.length ? queued.map(obsLine).join('\n') : '- none'}\nSaid in the last week:\n${recentSurfaced.length ? recentSurfaced.map(obsLine).join('\n') : '- none'}\n</observations>`,
  )

  const recent = Checkins.recentEnded(5)
  sections.push(
    `<recent_conversations>\n${recent.length ? recent.map((c) => `- ${fmtDay(c.scheduled_for)} ${fmtTime(c.scheduled_for)} ${clean(c.title)} (${c.status})${c.summary ? `: ${clean(c.summary)}` : ''}`).join('\n') : '- none yet'}\n</recent_conversations>`,
  )

  const notes = Notes.recent('self', 5)
  if (notes.length) sections.push(`<notes_to_self>\n${notes.map((n) => `- ${fmtDay(n.created_at)}: ${clean(n.text)}`).join('\n')}\n</notes_to_self>`)

  return sections.join('\n\n')
}
