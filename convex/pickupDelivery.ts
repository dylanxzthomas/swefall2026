import type { QueryCtx, MutationCtx } from './_generated/server'

/** A verified caregiver chooses their own channel; a parent cannot opt them in. */
export async function pickupDelivery(ctx: QueryCtx | MutationCtx, email: string) {
  const preference = await ctx.db.query('pickupPreferences').withIndex('by_email', q => q.eq('email', email.toLowerCase())).unique()
  if (preference?.channel === 'app') {
    const household = await ctx.db.get(preference.householdId)
    const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', preference.subject)).unique()
    if (household && !household.deleted && member?.householdId === household._id) return { channel: 'app' as const, recipientSubject: preference.subject }
  }
  return { channel: 'email' as const, recipientSubject: undefined }
}
