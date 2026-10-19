import { ConvexError } from 'convex/values'
import type { QueryCtx, MutationCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'
import { parseMemoryCandidate } from '../shared/memoryProposals'
import { instant } from '../shared/daymark'

export async function checkedFamilyFact(ctx: QueryCtx | MutationCtx, household: Doc<'households'>, raw: unknown) {
  const value = parseMemoryCandidate(raw)
  if ('childId' in value && !household.children.some(child => child.id === value.childId)) throw new ConvexError('Choose a confirmed child.')
  if ('caregiverId' in value) {
    const id = ctx.db.normalizeId('caregivers', value.caregiverId), caregiver = id && await ctx.db.get(id)
    if (!caregiver || caregiver.householdId !== household._id || 'childId' in value && !caregiver.childIds.includes(value.childId)) throw new ConvexError('Choose an eligible caregiver.')
  }
  if (value.kind === 'routine' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new ConvexError('Confirm the routine time.')
  if (value.kind === 'availability') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || ![value.start, value.end].every(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new ConvexError('Confirm the availability date and times.')
    if (instant(value.date, value.end, household.timezone).epochMilliseconds <= instant(value.date, value.start, household.timezone).epochMilliseconds) throw new ConvexError('Availability must end after it starts.')
  }
  return value
}

export function factScope(value: ReturnType<typeof parseMemoryCandidate>) {
  return value.kind === 'routine' ? 'recurring' : value.kind === 'availability' ? 'one-time' : 'household'
}
