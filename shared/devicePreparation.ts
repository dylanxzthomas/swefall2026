import { Temporal } from '@js-temporal/polyfill'
import type { Payload } from './daymark.js'

type Context = { timezone: string; children: { id: string; name: string }[]; caregivers: { _id: string; name: string; childIds: string[] }[] }
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const named = (text: string, name: string) => new RegExp(`(?:^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}])`, 'iu').test(text)

/** Literal offline preparation, never a simulated model result or provider action. */
export function prepareOnDevice(text: string, context: Context): { actions: Payload[]; clarification: string } {
  const matches = context.children.filter(c => named(text, c.name))
  const childId = matches.length === 1 ? matches[0].id : null
  const evidence: Record<string, string> = {}
  if (childId) evidence.childId = matches[0].name
  let date = ''
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/)
  const longDate = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+)(\d{4})\b/i)
  try {
    if (iso) date = Temporal.PlainDate.from(iso[0]).toString()
    else if (longDate) date = Temporal.PlainDate.from({ year: Number(longDate[3]), month: months.indexOf(longDate[1].toLowerCase()) + 1, day: Number(longDate[2]) }, { overflow: 'reject' }).toString()
    if (date) evidence.date = iso?.[0] ?? longDate![0]
  } catch { /* A malformed date remains unresolved. */ }
  const times = [...text.matchAll(/\b(?:(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?|(\d{2}):([0-5]\d))\b/gi)].flatMap(m => {
    const hour = Number(m[1] ?? m[4]), minute = m[2] ?? m[5] ?? '00'
    if (m[3] ? hour < 1 || hour > 12 : hour > 23) return []
    return [{ value: `${String(m[3] ? hour % 12 + (m[3].toLowerCase() === 'p' ? 12 : 0) : hour).padStart(2, '0')}:${minute}`, quote: m[0] }]
  })
  const location = text.match(/(?:^|\n)\s*(?:location|where)\s*:\s*([^\n]+)/i)?.[1]?.trim() ?? ''
  const explicitTitle = text.match(/(?:^|\n)\s*(?:event|title|subject)\s*:\s*([^\n]+)/i)?.[1]?.trim()
  const title = explicitTitle ?? (text.split(/[\n.!?]/)[0].replace(/^(?:please\s+)?(?:add|save)\s+(?:this\s+)?(?:to\s+(?:my|the)\s+calendar[:\s]*)?/i, '').trim().slice(0, 160) || 'School notice')
  const actions: Payload[] = []
  const wantsEmail = /\b(email|reply|rsvp|write to|tell (?:the|my) teacher)\b/i.test(text)
  const wantsPickup = /\b(pick\s?up|collect .* (?:school|gate))\b/i.test(text)
  const wantsCalendar = /\b(calendar|event|field trip|dismissal|deadline|school closed)\b/i.test(text) || !wantsEmail && !wantsPickup
  if (wantsCalendar) {
    const allDay = /\b(all.day|date.only)\b/i.test(text)
    const startTime = times.length >= 1 ? times[0].value : null, endTime = times.length === 2 ? times[1].value : null
    actions.push({ kind: 'calendar', childId, title, date, endDate: date, allDay, startTime: allDay ? null : startTime, endTime: allDay ? null : endTime, timezone: context.timezone, location, notes: text.slice(0, 2000), targetId: null, evidence: { ...evidence, ...(startTime ? { startTime: times[0].quote } : {}), ...(endTime ? { endTime: times[1].quote } : {}) } })
  }
  if (wantsEmail) {
    const addresses = [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])]
    const body = text.match(/(?:^|\n)\s*(?:message|body)\s*:\s*([\s\S]+)/i)?.[1]?.trim() ?? text.replace(/^(?:please\s+)?(?:draft|write|send)\s+(?:an?\s+)?(?:email|reply)(?:\s+to\s+\S+@\S+)?\s*[:—-]?\s*/i, '').trim()
    const requirement = /\b(portal|signature|sign this|payment|pay online|permission form)\b/i.test(text) ? 'The notice mentions a portal, form, signature, or payment. Complete that requirement separately; an email does not submit it.' : ''
    actions.push({ kind: 'email', childId, to: addresses.length === 1 ? addresses[0] : '', subject: explicitTitle ?? title, body, requirement, evidence: { ...evidence }, attachments: [] })
  }
  if (wantsPickup) {
    const caregivers = context.caregivers.filter(c => childId && c.childIds.includes(childId) && named(text, c.name))
    actions.push({ kind: 'pickup', childId, caregiverId: caregivers.length === 1 ? caregivers[0]._id : null, date, time: times.length === 1 ? times[0].value : null, timezone: context.timezone, location, deadline: '', message: text.slice(0, 3000), evidence: { ...evidence } })
  }
  return { actions, clarification: 'Basic drafts prepared on this device. Nothing has been sent.' }
}
