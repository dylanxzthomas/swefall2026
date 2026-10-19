import { z } from 'zod'

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T12:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}, 'Use a valid date')
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const memberSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(60), role: z.enum(['adult', 'child']) })
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  members: z.array(memberSchema).min(1).max(20),
  notes: z.string().max(4000),
}).refine(p => new Set(p.members.map(m => m.id)).size === p.members.length, 'Family members must be unique')

export const itemSchema = z.object({
  kind: z.enum(['event', 'task', 'shopping']),
  title: z.string().trim().min(1).max(200),
  date: daySchema.nullable(),
  time: timeSchema.nullable(),
  duration: z.number().int().min(5).max(1440),
  owner: z.string().nullable(),
  person: z.string().nullable(),
  notes: z.string().max(2000),
}).refine(i => !i.time || !!i.date, 'A time needs a date')

export type HouseholdProfile = z.infer<typeof profileSchema>
export type ItemInput = z.infer<typeof itemSchema>
export interface HouseholdItem extends ItemInput { id: string; done: boolean; sourceId: string | null; createdAt: string }
export interface Capture { id: string; text: string; createdAt: string; mode: 'ai' | 'guided'; status: 'pending' | 'approved' | 'dismissed'; items: ItemInput[]; questions: string[] }
export interface HouseholdData { profile: HouseholdProfile; items: HouseholdItem[]; captures: Capture[] }
export interface HouseholdState extends HouseholdData { mode: 'ai' | 'guided' }
export interface Attention { id: string; kind: 'conflict' | 'unassigned' | 'overdue' | 'undated'; title: string; detail: string; itemIds: string[] }

export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function offsetDay(day: string, offset: number): string {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + offset)
  return localDay(d)
}

export function attention(data: HouseholdData, today = localDay()): Attention[] {
  const open = data.items.filter(i => !i.done)
  const end = offsetDay(today, 7)
  const alerts: Attention[] = []
  const name = (id: string | null) => data.profile.members.find(m => m.id === id)?.name ?? 'Someone'
  for (const item of open) {
    if (item.kind === 'shopping') continue
    if (!item.date) alerts.push({ id: `undated-${item.id}`, kind: 'undated', title: `${item.title} needs a date`, detail: 'Choose a date so this appears in the family plan.', itemIds: [item.id] })
    else if (item.date < today) alerts.push({ id: `overdue-${item.id}`, kind: 'overdue', title: `Check on ${item.title}`, detail: 'The date has passed. Mark it done or choose a new date.', itemIds: [item.id] })
    else if (item.date < end && !item.owner) alerts.push({ id: `owner-${item.id}`, kind: 'unassigned', title: `Who has ${item.title}?`, detail: 'Assign an adult to take responsibility.', itemIds: [item.id] })
  }
  const timed = open.filter(i => i.kind === 'event' && i.date && i.time && i.date >= today && i.date < end)
  const stamp = (i: HouseholdItem) => new Date(`${i.date}T${i.time}:00`).getTime()
  for (let a = 0; a < timed.length; a++) for (let b = a + 1; b < timed.length; b++) {
    const x = timed[a], y = timed[b]
    const adultOverlap = x.owner && x.owner === y.owner
    const childOverlap = x.person && x.person === y.person
    if ((adultOverlap || childOverlap) && stamp(x) < stamp(y) + y.duration * 60000 && stamp(y) < stamp(x) + x.duration * 60000) {
      alerts.push({ id: `conflict-${x.id}-${y.id}`, kind: 'conflict', title: `${name(adultOverlap ? x.owner : x.person)} has overlapping plans`, detail: `${x.title} and ${y.title}. Check the times or change who is responsible.`, itemIds: [x.id, y.id] })
    }
  }
  return alerts.sort((a, b) => Number(b.kind === 'conflict') - Number(a.kind === 'conflict'))
}

export function planText(data: HouseholdData, today = localDay()): string {
  const member = (id: string | null) => data.profile.members.find(m => m.id === id)?.name ?? 'Unassigned'
  const lines = [`${data.profile.name} · ${today} to ${offsetDay(today, 6)}`, '', 'FAMILY PLAN']
  for (let n = 0; n < 7; n++) {
    const day = offsetDay(today, n)
    lines.push('', day)
    const items = data.items.filter(i => !i.done && i.kind !== 'shopping' && i.date === day).sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'))
    lines.push(...(items.length ? items.map(i => `- ${i.time ?? 'Any time'} ${i.title} · ${member(i.owner)}${i.notes ? ` (${i.notes})` : ''}`) : ['- No plans added']))
  }
  lines.push('', 'SHOPPING', ...data.items.filter(i => !i.done && i.kind === 'shopping').map(i => `- ${i.title}`))
  lines.push('', 'NEEDS A DECISION', ...attention(data, today).map(a => `- ${a.title}: ${a.detail}`))
  return lines.join('\n')
}
