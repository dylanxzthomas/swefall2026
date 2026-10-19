import { z } from 'zod'
import { instant } from './daymark.js'
const name = z.string().trim().min(1).max(100)
export const familyFactSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('school'), childId: name, school: name, className: z.string().trim().max(100) }),
  z.object({ kind: z.literal('contact'), childId: name, name, email: z.email(), role: z.string().trim().max(100) }),
  z.object({ kind: z.literal('routine'), childId: name, caregiverId: name, weekday: z.number().int().min(1).max(7), time: z.string(), location: name }),
  z.object({ kind: z.literal('availability'), caregiverId: name, date: z.string(), start: z.string(), end: z.string(), available: z.boolean() }),
])
export type FamilyFact = z.infer<typeof familyFactSchema>
export function availabilityAt(facts: FamilyFact[], caregiverId: string, date: string, time: string, timezone: string, availabilityTimezone = timezone) {
  const at = instant(date, time, timezone).epochMilliseconds
  const matches = facts.filter((f): f is Extract<FamilyFact, { kind: 'availability' }> => f.kind === 'availability' && f.caregiverId === caregiverId && instant(f.date, f.start, availabilityTimezone).epochMilliseconds <= at && instant(f.date, f.end, availabilityTimezone).epochMilliseconds > at)
  if (matches.some(f => !f.available)) return 'busy'
  return matches.some(f => f.available) ? 'available' : 'unknown'
}
