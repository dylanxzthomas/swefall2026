import { v, ConvexError } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { internalMutation, mutation, query } from './_generated/server'
import { adult } from './access'
import { internal } from './_generated/api'
import { sourceHash } from '../shared/daymark'
import { workingMemorySchema } from '../shared/workingMemory'
import { workingConversationContext, modelMetrics } from './schema'

type Ctx = Pick<QueryCtx, 'db'>
type Reference = NonNullable<Doc<'jobs'>['workingContext']>['sources'][number]
export const unavailableWorkingContext = 'The earlier conversation context changed or expired. Tell me the current details to continue.'
async function member(ctx: Ctx, householdId: Id<'households'>, subject: string) {
  const h = await ctx.db.get(householdId), m = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  return Boolean(h && !h.deleted && m?.householdId === householdId)
}
async function request(ctx: Ctx, householdId: Id<'households'>, subject: string, id: Id<'jobs'>) {
  const job = await ctx.db.get(id)
  if (!job || job.householdId !== householdId || job.createdBy !== subject || !job.interactive || !job.conversation || job.preparing || job.cancelled || job.assistantQuiet || job.emailPreparationFailed || job.scheduledFor !== undefined || job.mailContext || job.emailWatchId) return null
  const source = await ctx.db.get(job.sourceId)
  if (!source || source.householdId !== householdId || source.email || source.attachmentIds?.length || !source.text || source.expiresAt <= Date.now() || (await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', id)).take(1)).length) return null
  return { job, source }
}
export async function validWorkingContext(ctx: Ctx, job: Pick<Doc<'jobs'>, 'householdId' | 'createdBy'>, context: NonNullable<Doc<'jobs'>['workingContext']>) {
  if (context.expiresAt <= Date.now() || context.sources.length > 24 || !context.sources.length || new Set(context.sources.map(r => r.jobId)).size !== context.sources.length || !await member(ctx, job.householdId, job.createdBy)) return false
  const cache = await ctx.db.query('workingMemories').withIndex('by_owner', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy)).unique()
  for (const ref of context.sources) {
    const r = await request(ctx, job.householdId, job.createdBy, ref.jobId)
    if (!r || r.job._creationTime <= (cache?.resetBefore ?? 0) || r.source._id !== ref.sourceId || r.source.revision !== ref.revision || sourceHash(r.source.text!) !== ref.hash || r.source.expiresAt < context.expiresAt) return false
  }
  return true
}
export async function currentWorkingMemory(ctx: Ctx, job: Doc<'jobs'>) {
  const cache = await ctx.db.query('workingMemories').withIndex('by_owner', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy)).unique()
  if (!cache?.notes?.length || !cache.context || !await validWorkingContext(ctx, job, cache.context)) return null
  const before = await Promise.all(cache.context.sources.map(ref => ctx.db.get(ref.jobId)))
  if (before.some(j => !j || j._creationTime >= job._creationTime)) return null
  return { notes: cache.notes, context: cache.context }
}
const reference = (r: NonNullable<Awaited<ReturnType<typeof request>>>): Reference => ({ jobId: r.job._id, sourceId: r.source._id, revision: r.source.revision, hash: sourceHash(r.source.text!) })
const contextKey = (sources: Reference[]) => sourceHash(JSON.stringify(sources.map(r => [r.jobId, r.sourceId, r.revision, r.hash])))

export const settings = query({ args: {}, handler: async ctx => {
  const { household, subject } = await adult(ctx)
  const cache = await ctx.db.query('workingMemories').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).unique()
  const valid = cache?.context && await validWorkingContext(ctx, { householdId: household._id, createdBy: subject }, cache.context)
  return { version: cache?.resetVersion ?? 0, excerptCount: valid ? cache?.notes?.length ?? 0 : 0, ...(cache?.resetBefore ? { resetAt: cache.resetBefore } : {}) }
} })

/** Clears only this adult's older context and invalidates pending selectors. */
export const reset = mutation({ args: { version: v.number() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx)
  const cache = await ctx.db.query('workingMemories').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).unique()
  if (!Number.isSafeInteger(args.version) || args.version < 0 || args.version !== (cache?.resetVersion ?? 0)) throw new ConvexError('Working context changed. Open the latest settings and try again.')
  if (cache?.refreshTimerId && (await ctx.db.system.get(cache.refreshTimerId))?.state.kind === 'pending') await ctx.scheduler.cancel(cache.refreshTimerId)
  const value = { resetBefore: Date.now(), resetVersion: args.version + 1, notes: undefined, context: undefined, lease: undefined, leaseUntil: undefined, pendingJobId: undefined, refreshTimerId: undefined, refreshAt: undefined, claimedThrough: undefined, inputKey: 'reset', completedInputKey: undefined, metrics: undefined, nextAttemptAt: 0, updatedAt: Date.now() }
  if (cache) await ctx.db.patch(cache._id, value)
  else await ctx.db.insert('workingMemories', { householdId: household._id, createdBy: subject, ...value })
  return value.resetVersion
} })

/** One durable timer coalesces later turns; a closed app need not prompt again. */
export const resume = internalMutation({ args: { id: v.id('workingMemories'), resetVersion: v.number(), expectedAt: v.number() }, handler: async (ctx, args) => {
  const cache = await ctx.db.get(args.id)
  if (!cache?.pendingJobId || !cache.refreshTimerId || cache.refreshAt !== args.expectedAt || args.expectedAt > Date.now() || (cache.resetVersion ?? 0) !== args.resetVersion) return false
  const jobId = cache.pendingJobId
  await ctx.db.patch(cache._id, { pendingJobId: undefined, refreshTimerId: undefined, refreshAt: undefined })
  if (!await request(ctx, cache.householdId, cache.createdBy, jobId) || !await member(ctx, cache.householdId, cache.createdBy)) return false
  await ctx.scheduler.runAfter(0, internal.workingMemoryWorker.refresh, { jobId })
  return true
} })

/** One writer per adult; cooldown bounds model cost across rapid conversation. */
export const claim = internalMutation({ args: { jobId: v.id('jobs'), lease: v.string() }, handler: async (ctx, args) => {
  const job = await ctx.db.get(args.jobId)
  if (!job || !await member(ctx, job.householdId, job.createdBy) || !await request(ctx, job.householdId, job.createdBy, job._id) || !process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) return null
  const old = await ctx.db.query('workingMemories').withIndex('by_owner', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy)).unique()
  if (old && ((old.leaseUntil ?? 0) > Date.now() || old.nextAttemptAt > Date.now())) {
    if (job._creationTime > (old.claimedThrough ?? 0)) {
      const pending = old.pendingJobId && await ctx.db.get(old.pendingJobId)
      if (!pending || pending._creationTime < job._creationTime) await ctx.db.patch(old._id, { pendingJobId: job._id })
      if (!old.refreshTimerId) {
        const refreshAt = Math.max(old.nextAttemptAt, old.leaseUntil ?? 0)
        const refreshTimerId = await ctx.scheduler.runAt(refreshAt, internal.workingMemory.resume, { id: old._id, resetVersion: old.resetVersion ?? 0, expectedAt: refreshAt })
        await ctx.db.patch(old._id, { refreshTimerId, refreshAt })
      }
    }
    return null
  }
  const jobs = await ctx.db.query('jobs').withIndex('by_creator', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy).lte('_creationTime', job._creationTime)).filter(q => q.and(q.eq(q.field('interactive'), true), q.eq(q.field('conversation'), true), q.neq(q.field('assistantQuiet'), true), q.eq(q.field('preparing'), false), q.eq(q.field('cancelled'), false), q.neq(q.field('emailPreparationFailed'), true), q.eq(q.field('mailContext'), undefined), q.eq(q.field('emailWatchId'), undefined), q.eq(q.field('scheduledFor'), undefined))).order('desc').take(31)
  const eligible = (await Promise.all(jobs.filter(j => j._creationTime > (old?.resetBefore ?? 0)).map(j => request(ctx, job.householdId, job.createdBy, j._id)))).filter(r => r !== null)
  const older = eligible.slice(12, 30).reverse()
  if (!older.length) return null
  // Carry only still-valid literal excerpts, never the previous selection's reasoning.
  const previous = old?.notes && old.context && await validWorkingContext(ctx, job, old.context) ? old.notes : []
  for (const note of previous) {
    if (older.some(r => r.job._id === note.jobId)) continue
    const r = await request(ctx, job.householdId, job.createdBy, note.jobId)
    if (r && r.job._creationTime < older[0].job._creationTime && older.length < 24) older.unshift(r)
  }
  const sources = older.map(reference), inputKey = contextKey(sources)
  if (old?.completedInputKey === inputKey && old.context && await validWorkingContext(ctx, job, old.context)) return null
  const context = { sources, expiresAt: Math.min(...older.map(r => r.source.expiresAt)) }
  const value = { householdId: job.householdId, createdBy: job.createdBy, inputKey, claimedThrough: job._creationTime, lease: args.lease, leaseUntil: Date.now() + 120000, nextAttemptAt: Date.now() + 300000 }
  const id = old ? (await ctx.db.patch(old._id, value), old._id) : await ctx.db.insert('workingMemories', value)
  return { id, inputKey, lease: args.lease, context, requests: older.map(r => ({ jobId: r.job._id, request: r.source.text!.slice(0, 3000) })) }
} })

export const finish = internalMutation({ args: { id: v.id('workingMemories'), inputKey: v.string(), lease: v.string(), context: workingConversationContext, notes: v.array(v.object({ jobId: v.id('jobs'), quote: v.string() })), metrics: v.optional(modelMetrics) }, handler: async (ctx, args) => {
  const cache = await ctx.db.get(args.id)
  if (!cache || cache.inputKey !== args.inputKey || cache.lease !== args.lease || (cache.leaseUntil ?? 0) <= Date.now()) return false
  if (contextKey(args.context.sources) !== args.inputKey) return false
  if (!await validWorkingContext(ctx, { householdId: cache.householdId, createdBy: cache.createdBy }, args.context)) { await ctx.db.patch(cache._id, { lease: undefined, leaseUntil: undefined }); return false }
  const parsed = workingMemorySchema.safeParse({ notes: args.notes })
  if (!parsed.success || new Set(args.notes.map(n => `${n.jobId}:${n.quote}`)).size !== args.notes.length) return false
  for (const note of args.notes) {
    if (!args.context.sources.some(r => r.jobId === note.jobId)) return false
    const r = await request(ctx, cache.householdId, cache.createdBy, note.jobId)
    if (!r?.source.text!.slice(0, 3000).includes(note.quote)) return false
  }
  await ctx.db.patch(cache._id, { notes: args.notes, context: args.context, completedInputKey: args.inputKey, lease: undefined, leaseUntil: undefined, updatedAt: Date.now(), ...(args.metrics ? { metrics: args.metrics } : {}) })
  return true
} })
export const failed = internalMutation({ args: { id: v.id('workingMemories'), inputKey: v.string(), lease: v.string() }, handler: async (ctx, args) => {
  const cache = await ctx.db.get(args.id)
  if (!cache || cache.inputKey !== args.inputKey || cache.lease !== args.lease) return false
  await ctx.db.patch(cache._id, { lease: undefined, leaseUntil: undefined, nextAttemptAt: Date.now() + 900000 })
  return true
} })
