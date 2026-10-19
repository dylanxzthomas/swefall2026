import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { instant } from '../shared/daymark'

type Pickup = { caregiverId: string; childId: string; date: string; time: string; timezone: string }

/** Accepted request snapshots remain authoritative after draft/contact corrections. */
export async function confirmedPickupConflict(ctx: QueryCtx | MutationCtx, householdId: Id<'households'>, payload: Pickup, except?: Id<'pickupRequests'>) {
  const at = instant(payload.date, payload.time, payload.timezone).epochMilliseconds
  const caregiverId = ctx.db.normalizeId('caregivers', payload.caregiverId)
  const caregiver = caregiverId && await ctx.db.get(caregiverId)
  const email = caregiver?.email.trim().toLowerCase()
  const requests = await ctx.db.query('pickupRequests').withIndex('by_household', q => q.eq('householdId', householdId)).collect()
  for (const request of requests) {
    if (request._id === except || request.status !== 'accepted') continue
    const action = await ctx.db.get(request.actionId)
    const previous = request.payload ?? action?.payload
    if (!previous || Math.abs(at - instant(previous.date, previous.time, previous.timezone).epochMilliseconds) >= 30 * 60_000) continue
    if (previous.childId === payload.childId || request.caregiverId === payload.caregiverId) return true
    // Old workspaces may contain duplicate caregiver records. A second record
    // for the same mailbox must not bypass the arrangement conflict check.
    const approval = action?.approvalId && await ctx.db.get(action.approvalId)
    const contact = await ctx.db.get(request.caregiverId)
    const previousEmail = (approval?.destination ?? contact?.email)?.trim().toLowerCase()
    if (email && email === previousEmail) return true
  }
  return false
}
