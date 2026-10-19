import { ConvexError, v } from 'convex/values'
import { start } from '@convex-dev/workflow'
import { mutation, query, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult } from './access'
import { emailWatchJobIssue } from './emailWatchRules'
import { emailBody } from '../shared/emailTriage'
import { personalTaskSchema } from '../shared/tasks'
import { sourceHash } from '../shared/daymark'
import type { EmailTaskSuggestion } from '../shared/emailTasks'

export async function relatedMessages(ctx: Pick<QueryCtx, 'db'>, job: Doc<'jobs'>) {
  if (!job.emailThreadKey) return []
  return ctx.db.query('jobs').withIndex('by_email_thread', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy).eq('emailThreadKey', job.emailThreadKey).eq('emailWatchVersion', job.emailWatchVersion)).order('desc').take(6)
}
export async function relatedContext(ctx: Pick<QueryCtx, 'db'>, job: Doc<'jobs'>) {
  const result = []
  for (const other of await relatedMessages(ctx, job)) {
    if (other._id === job._id || (other.emailWatchReceivedAt ?? 0) > (job.emailWatchReceivedAt ?? 0) || other.emailWatchId !== job.emailWatchId) continue
    const source = await ctx.db.get(other.sourceId)
    if (!source?.email || source.expiresAt <= Date.now()) continue
    const body = emailBody(source)
    const tasks = await ctx.db.query('emailTaskSuggestions').withIndex('by_job', q => q.eq('jobId', other._id)).take(5)
    const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', other._id)).take(8)
    result.push({ subject: source.email.subject, receivedAt: source.email.receivedAt, body: body?.slice(0, 2000), truncated: (body?.length ?? 0) > 2000 || source.email.extraction.incomplete || source.email.extraction.truncated, tasks: tasks.map(t => ({ title: t.title, dueDate: t.dueDate, status: t.status })), actions: actions.map(a => ({ kind: a.payload.kind, status: a.status })) })
  }
  return result
}
async function ownedJob(ctx: MutationCtx, jobId: Id<'jobs'>, sourceRevision: number) {
  const { household, subject } = await adult(ctx), job = await ctx.db.get(jobId)
  if (!job || job.householdId !== household._id || job.createdBy !== subject || !job.emailWatchId || job.cancelled) throw new ConvexError('This email check is unavailable.')
  const source = await ctx.db.get(job.sourceId)
  if (!source?.email || source.revision !== sourceRevision || source.expiresAt <= Date.now()) throw new ConvexError('The original email changed or expired. Share it again.')
  const issue = await emailWatchJobIssue(ctx, job, true)
  if (issue) throw new ConvexError(issue)
  return { household, job, source }
}
export const suggestions = query({ args: {}, handler: async (ctx): Promise<EmailTaskSuggestion[]> => {
  const { household, subject } = await adult(ctx), result: EmailTaskSuggestion[] = []
  // Bound the inbox surface independently of total household history.
  const watches = await ctx.db.query('emailWatches').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(5)
  for (const watch of watches) for (const job of await ctx.db.query('jobs').withIndex('by_email_watch', q => q.eq('emailWatchId', watch._id)).order('desc').take(20)) {
    if (job.createdBy !== subject || job.householdId !== household._id) continue
    const source = await ctx.db.get(job.sourceId)
    if (!source?.email || source.expiresAt <= Date.now()) continue
    const issue = await emailWatchJobIssue(ctx, job)
    for (const t of await ctx.db.query('emailTaskSuggestions').withIndex('by_job', q => q.eq('jobId', job._id)).take(5)) {
      result.push({ id: t._id, jobId: job._id, sourceRevision: t.sourceRevision, version: t.version, status: t.status, input: { title: t.title, notes: t.notes, ...(t.dueDate ? { dueDate: t.dueDate } : {}), ...(t.childId ? { childId: t.childId } : {}) }, evidence: t.evidence, issue: issue ?? t.issue, personalTaskId: t.personalTaskId, canSave: t.status === 'proposed' && !job.preparing && !job.cancelled && !job.emailHandling && !issue && source.revision === t.sourceRevision })
    }
  }
  return result.slice(0, 100)
} })
const suggestionIdentity = { id: v.id('emailTaskSuggestions'), version: v.number(), sourceRevision: v.number() }
export const saveTask = mutation({ args: { ...suggestionIdentity, input: v.object({ title: v.string(), notes: v.string(), dueDate: v.optional(v.string()), childId: v.optional(v.string()) }) }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), t = await ctx.db.get(args.id)
  const job = t ? await ctx.db.get(t.jobId) : null
  if (!t || t.householdId !== household._id || !job || job.createdBy !== subject || job.householdId !== household._id) throw new ConvexError('This task suggestion is unavailable.')
  const parsed = personalTaskSchema.safeParse(args.input)
  if (!parsed.success) throw new ConvexError('Give this task a title and a valid date if needed.')
  const input = { ...parsed.data, childId: parsed.data.childId || undefined }, hash = sourceHash(JSON.stringify(input))
  if (input.childId && !household.children.some(c => c.id === input.childId)) throw new ConvexError('Choose a child in this household.')
  // A committed save is retryable, but can never restore a task the parent later removed.
  if (t.status === 'saved' && t.sourceRevision === args.sourceRevision && t.version === args.version + 1 && t.savedHash === hash) return t.personalTaskId
  if (t.status !== 'proposed' || t.version !== args.version || t.sourceRevision !== args.sourceRevision) throw new ConvexError('This suggestion changed. Reopen its latest review.')
  await ownedJob(ctx, job._id, args.sourceRevision)
  if (job.preparing || job.emailHandling) throw new ConvexError('Restore this email’s current review before saving a task.')
  const personalTaskId = await ctx.db.insert('personalTasks', { householdId: household._id, requestId: `email:${t._id}`, requestHash: hash, ...input, done: false, version: 1, createdAt: Date.now(), updatedAt: Date.now() })
  await ctx.db.patch(t._id, { status: 'saved', version: t.version + 1, personalTaskId, savedHash: hash, ...input, dueDate: input.dueDate, childId: input.childId })
  return personalTaskId
} })
export const dismissTask = mutation({ args: suggestionIdentity, handler: async (ctx, args) => {
  const t = await ctx.db.get(args.id)
  if (!t) throw new ConvexError('This task suggestion is unavailable.')
  await ownedJob(ctx, t.jobId, args.sourceRevision)
  if (t.status !== 'proposed' || t.version !== args.version || t.sourceRevision !== args.sourceRevision) throw new ConvexError('This suggestion changed. Reopen its latest review.')
  await ctx.db.patch(t._id, { status: 'dismissed', version: t.version + 1 })
} })
export const handleMessage = mutation({ args: { jobId: v.id('jobs'), sourceRevision: v.number(), handlingVersion: v.number(), operation: v.union(v.literal('dismiss'), v.literal('snooze'), v.literal('restore')), until: v.optional(v.number()) }, handler: async (ctx, args) => {
  const { job } = await ownedJob(ctx, args.jobId, args.sourceRevision)
  if ((job.emailHandlingVersion ?? 0) !== args.handlingVersion) throw new ConvexError('This email review changed. Reopen it before deciding.')
  const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).collect()
  if (job.preparing || actions.some(a => !['review', 'cancelled'].includes(a.status))) throw new ConvexError('Resolve active work or recorded results before setting this email aside.')
  if (args.operation === 'restore' && !job.emailHandling) return
  if (args.operation === 'snooze' && (!Number.isSafeInteger(args.until) || args.until! <= Date.now() || args.until! > Date.now() + 7 * 86400_000)) throw new ConvexError('Choose a snooze time within the next seven days.')
  const version = args.handlingVersion + 1
  await ctx.db.patch(job._id, { emailHandling: args.operation === 'restore' ? undefined : args.operation === 'dismiss' ? 'dismissed' : 'snoozed', emailSnoozedUntil: args.operation === 'snooze' ? args.until : undefined, emailHandlingVersion: version })
  if (args.operation === 'snooze') await ctx.scheduler.runAt(args.until!, internal.emailFollowups.wake, { jobId: job._id, version, sourceRevision: args.sourceRevision })
} })
export const wake = internalMutation({ args: { jobId: v.id('jobs'), version: v.number(), sourceRevision: v.number() }, handler: async (ctx, args) => {
  const job = await ctx.db.get(args.jobId)
  if (!job || job.emailHandling !== 'snoozed' || job.emailHandlingVersion !== args.version || (job.emailSnoozedUntil ?? Infinity) > Date.now() || job.cancelled) return
  const source = await ctx.db.get(job.sourceId)
  if (!source?.email || source.revision !== args.sourceRevision || source.expiresAt <= Date.now()) return
  if (await emailWatchJobIssue(ctx, job, true)) return
  // Returning an existing review is not preparation, approval, or an external write.
  await ctx.db.patch(job._id, { emailHandling: undefined, emailSnoozedUntil: undefined, emailHandlingVersion: args.version + 1 })
} })
export const retry = mutation({ args: { jobId: v.id('jobs'), sourceRevision: v.number() }, handler: async (ctx, args) => {
  const { job } = await ownedJob(ctx, args.jobId, args.sourceRevision)
  if (job.preparing) return job._id
  if (!job.emailPreparationFailed || job.emailHandling || !(process.env.ANTHROPIC_API_KEY && process.env.DAYMARK_MODEL)) throw new ConvexError('This preparation cannot be retried now. Check its latest review and model settings.')
  if ((await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).collect()).length) throw new ConvexError('Review existing drafts; retry does not replay actions.')
  await ctx.db.patch(job._id, { preparing: true, emailPreparationFailed: undefined, clarification: '' })
  await start(ctx, internal.workflows.prepare, args)
  return job._id
} })
