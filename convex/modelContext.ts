import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'

export const modelContextLimits = { facts: 40, caregivers: 30, events: 30 } as const

/** Bounded model reference data; this never establishes availability or approval. */
export async function modelHouseholdContext(ctx: Pick<QueryCtx, 'db'>, householdId: Id<'households'>, subject: string, targetId?: string | null) {
  const [facts, caregivers, events] = await Promise.all([
    ctx.db.query('memoryFacts').withIndex('by_confirmed_updated', q => q.eq('householdId', householdId).eq('confirmed', true)).order('desc').take(modelContextLimits.facts + 1),
    ctx.db.query('caregivers').withIndex('by_household', q => q.eq('householdId', householdId)).order('desc').take(modelContextLimits.caregivers + 1),
    ctx.db.query('planEvents').withIndex('by_owner', q => q.eq('householdId', householdId).eq('owner', subject)).order('desc').take(modelContextLimits.events + 1),
  ])
  const plan: Doc<'planEvents'>[] = events.slice(0, modelContextLimits.events)
  // A revision must retain the explicit event it is correcting, even when old.
  const normalized = targetId && ctx.db.normalizeId('planEvents', targetId)
  const target = normalized ? await ctx.db.get(normalized) : null
  if (target && target.householdId === householdId && target.owner === subject && !plan.some(p => p._id === target._id)) {
    if (plan.length === modelContextLimits.events) plan.pop()
    plan.push(target)
  }
  const limits = { facts: facts.length > modelContextLimits.facts, caregivers: caregivers.length > modelContextLimits.caregivers, events: events.length > modelContextLimits.events }
  return {
    facts: facts.slice(0, modelContextLimits.facts), caregivers: caregivers.slice(0, modelContextLimits.caregivers), plan,
    modelCoverage: {
      limited: Object.values(limits).some(Boolean), limits,
      description: Object.values(limits).some(Boolean)
        ? 'Only selected recent confirmed facts, caregivers and your saved Daymark events are supplied. Missing records are not evidence of absence or availability. Ask for the relevant details when needed; never claim an exhaustive list or invent an event match.'
        : 'Saved Daymark records only; no full external calendar synchronization or proof of availability.',
    },
  }
}
