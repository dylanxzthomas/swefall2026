import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { instant } from '../shared/daymark'
import { availabilityAt, familyFactSchema } from '../shared/memory'
import { confirmedPickupConflict } from './pickupConflicts'

/** Prepare only. A different recipient always returns to a fresh parent review. */
export async function nextPickupDraft(ctx: MutationCtx, action: Doc<'actions'>) {
  const p = action.payload, now = Date.now()
  const at = instant(p.date, p.time, p.timezone).epochMilliseconds
  if (at - now < 2 * 3600_000) return { revisionNote: 'Pickup is less than two hours away. Contact an eligible caregiver directly; asynchronous requests cannot guarantee coverage.' }
  const household = await ctx.db.get(action.householdId)
  if (!household || household.deleted) return {}
  const requests = await ctx.db.query('pickupRequests').withIndex('by_household', q => q.eq('householdId', action.householdId)).collect()
  const tried = new Set(requests.filter(r => r.actionId === action._id).map(r => String(r.caregiverId)))
  tried.add(p.caregiverId)
  const records = await ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', action.householdId)).collect()
  const facts = records.filter(f => f.confirmed).flatMap(f => { const value = familyFactSchema.safeParse(f.value); return value.success ? [value.data] : [] })
  const caregivers = await ctx.db.query('caregivers').withIndex('by_household', q => q.eq('householdId', action.householdId)).collect()
  const triedEmails = new Set(caregivers.filter(c => tried.has(c._id)).map(c => c.email.trim().toLowerCase()))
  const eligible = caregivers.filter(c => c.childIds.includes(p.childId) && !tried.has(c._id) && !triedEmails.has(c.email.trim().toLowerCase()) && availabilityAt(facts, c._id, p.date, p.time, p.timezone, household.timezone) !== 'busy')
  const checked = await Promise.all(eligible.map(async c => ({ caregiver: c, conflict: await confirmedPickupConflict(ctx, household._id, { ...p, caregiverId: c._id }) })))
  const candidates = checked.filter(c => !c.conflict).map(c => c.caregiver).sort((a, b) => Number(availabilityAt(facts, b._id, p.date, p.time, p.timezone, household.timezone) === 'available') - Number(availabilityAt(facts, a._id, p.date, p.time, p.timezone, household.timezone) === 'available') || a.name.localeCompare(b.name))
  const next = candidates[0]
  if (!next) return { revisionNote: 'No untried eligible caregiver is available in your saved details. Add another eligible caregiver or arrange coverage directly.' }
  const confirmed = availabilityAt(facts, next._id, p.date, p.time, p.timezone, household.timezone) === 'available'
  const { calendarUpdate: _calendar, followUpAt: _reminder, ...base } = p
  return {
    payload: { ...base, caregiverId: next._id, deadline: new Date(Math.min(at - 3600_000, now + 2 * 3600_000)).toISOString(), message: `Can you pick up ${household.children.find(c => c.id === p.childId)?.name ?? 'this child'} on ${p.date} at ${p.time} (${p.timezone}) from ${p.location}?`, evidence: {} },
    revisionNote: `${next.name} is eligible for this child${confirmed ? ' and has explicitly confirmed availability' : '; availability is unknown'}. A new request is ready for your review. Nothing has been sent.${p.calendarUpdate || p.followUpAt ? ' Review any calendar update or reminder again for this caregiver.' : ''}`,
  }
}
