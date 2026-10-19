import type { Id, Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { gmailReadScope } from '../shared/emailWatches'

export async function watchIssue(ctx: Pick<QueryCtx, 'db'>, watch: Doc<'emailWatches'>) {
  const household = await ctx.db.get(watch.householdId)
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', watch.createdBy)).unique()
  if (!household || household.deleted || member?.householdId !== watch.householdId) return 'Household access changed. Review this watch before resuming.'
  const c = await ctx.db.get(watch.connectionId)
  if (!c || c.householdId !== watch.householdId || c.subject !== watch.createdBy || (c.provider ?? 'google') !== 'google' || c.status !== 'active' || c.version !== watch.connectionVersion || !c.scopes.includes(gmailReadScope)) return 'Gmail reading access changed. Reconnect and explicitly resume this watch.'
  return null
}
export async function emailWatchJobIssue(ctx: Pick<QueryCtx, 'db'>, job: Doc<'jobs'>, ignoreHandling = false) {
  if (!job.emailWatchId) return null
  const watch = await ctx.db.get(job.emailWatchId)
  if (!watch || watch.householdId !== job.householdId || watch.createdBy !== job.createdBy || watch.version !== job.emailWatchVersion || watch.state !== 'active') return 'This email watch changed or stopped. Start a new request to use the saved details; nothing else will be sent from this check.'
  const accessIssue = await watchIssue(ctx, watch)
  if (accessIssue) return accessIssue
  if (!ignoreHandling && job.emailHandling) return 'This email was set aside. Restore its current review before approving work.'
  if (job.emailThreadKey) {
    const latest = await ctx.db.query('jobs').withIndex('by_email_thread', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy).eq('emailThreadKey', job.emailThreadKey).eq('emailWatchVersion', job.emailWatchVersion)).order('desc').first()
    if (latest && latest.emailWatchId === job.emailWatchId && ((latest.emailWatchReceivedAt ?? 0) > (job.emailWatchReceivedAt ?? 0) || latest.emailWatchReceivedAt === job.emailWatchReceivedAt && latest._creationTime > job._creationTime)) return 'A newer message in this email thread needs review. Use its fresh preparation before approving older work.'
  }
  return null
}

export async function currentEmailWatches(ctx: Pick<QueryCtx, 'db'>, householdId: Id<'households'>, subject: string) {
  const records = await Promise.all((['active', 'paused', 'blocked'] as const).map(state => ctx.db.query('emailWatches').withIndex('by_owner_state', q => q.eq('householdId', householdId).eq('createdBy', subject).eq('state', state)).first()))
  return records.filter((record): record is Doc<'emailWatches'> => record !== null)
}
