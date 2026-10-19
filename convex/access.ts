import { ConvexError } from 'convex/values'
import type { QueryCtx, MutationCtx } from './_generated/server'
export async function adult(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new ConvexError('Sign in before uploading family information.')
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', identity.tokenIdentifier)).unique()
  if (!member) throw new ConvexError('Confirm your household first.')
  const household = await ctx.db.get(member.householdId)
  if (!household || household.deleted) throw new ConvexError('Household unavailable.')
  return { member, household, subject: identity.tokenIdentifier }
}
export function sameHousehold(record: { householdId: string } | null, householdId: string) {
  if (!record || record.householdId !== householdId) throw new ConvexError('This item is unavailable.')
}
export function canReadJob(job: { createdBy: string; conversation?: boolean; interactive?: boolean; preparing: boolean; mailContext?: unknown; emailPreparationFailed?: boolean }, subject: string) {
  // Household deliverables are shared; conversation and unclassified turns are private.
  return job.createdBy === subject || !job.mailContext && !job.conversation && !(job.interactive && (job.preparing || job.emailPreparationFailed))
}
export function readableJob(job: Parameters<typeof canReadJob>[0] | null, subject: string) {
  if (!job || !canReadJob(job, subject)) throw new ConvexError('This item is unavailable.')
}
export async function readableAttachment(ctx: QueryCtx | MutationCtx, file: import('./_generated/dataModel').Doc<'attachments'>, subject: string) {
  if (file.subject === subject) return
  const job = file.sourceId ? await ctx.db.query('jobs').withIndex('by_source', q => q.eq('sourceId', file.sourceId!)).first() : null
  readableJob(job, subject)
}
export async function remember(ctx: MutationCtx, householdId: import('./_generated/dataModel').Id<'households'>, key: string, value: unknown) {
  const previous = await ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', householdId).eq('key', key)).unique()
  const fact = { householdId, key, value, source: 'Adult-confirmed household settings', confirmed: true, updatedAt: Date.now(), version: (previous?.version ?? 0) + 1, scope: 'household' }
  if (previous) await ctx.db.patch(previous._id, fact); else await ctx.db.insert('memoryFacts', fact)
}
