import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { internal } from './_generated/api'
import { adult } from './access'
import { checkedFamilyFact, factScope } from './memoryRules'
import { sourceHash } from '../shared/daymark'
import { learnedCandidateSchema, validateCuration, type LearnedProposal } from '../shared/learnedWorkflows'
import { routineDefinitionSchema } from '../shared/routines'
import { validMailConversation } from './mailConversation'
import { validWorkingContext } from './workingMemory'
import { localAssistantReply } from '../shared/assistant'
import { capabilityReply } from '../shared/capabilities'
import { householdAssistantReply } from '../shared/householdAssistant'
import { routineJobIssue } from './routineRules'
import { mailRoutineDefinitionSchema } from '../shared/mailRoutines'
import { createReviewedMailRoutine } from './mailRoutines'

type ReadCtx = Pick<QueryCtx, 'db'>
type SourceRef = { householdId: Id<'households'>; createdBy: string; jobId: Id<'jobs'>; sourceId: Id<'sources'>; sourceRevision: number; sourceHash: string; expiresAt: number; familyHash?: string }
const requestArgs = { jobId: v.id('jobs'), sourceRevision: v.number() }
const versionArgs = { id: v.id('learnedWorkflows'), version: v.number() }
const leaseArgs = { id: v.id('workflowCurations'), version: v.number(), lease: v.string() }

async function familyHash(ctx: ReadCtx, household: Doc<'households'>) {
  const [facts, caregivers] = await Promise.all([ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', household._id)).take(100), ctx.db.query('caregivers').withIndex('by_household', q => q.eq('householdId', household._id)).take(100)])
  return sourceHash(JSON.stringify([household.timezone, household.children, facts.filter(f => f.confirmed).map(f => [f._id, f.version, f.value]), caregivers.map(c => [c._id, c.name, c.childIds])]))
}

async function validSource(ctx: ReadCtx, ref: SourceRef, knownFamilyHash?: string) {
  const [job, source, household, member] = await Promise.all([ctx.db.get(ref.jobId), ctx.db.get(ref.sourceId), ctx.db.get(ref.householdId), ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', ref.createdBy)).unique()])
  if (!household || household.deleted || member?.householdId !== ref.householdId || ref.expiresAt <= Date.now() || !job || job.householdId !== ref.householdId || job.createdBy !== ref.createdBy || job.sourceId !== ref.sourceId || job.cancelled || job.preparing || !source || source.householdId !== ref.householdId || source.revision !== ref.sourceRevision || !source.text || source.expiresAt < ref.expiresAt || sourceHash(source.text) !== ref.sourceHash) return null
  if (job.mailContext && !await validMailConversation(ctx, job, job.mailContext)) return null
  if (job.workingContext && !await validWorkingContext(ctx, job, job.workingContext)) return null
  if (await routineJobIssue(ctx, job)) return null
  if (ref.familyHash && ref.familyHash !== (knownFamilyHash ?? await familyHash(ctx, household))) return null
  return { job, source, household }
}

async function enqueueJob(ctx: MutationCtx, args: { jobId: Id<'jobs'>; sourceRevision: number }, owner?: string) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) throw new ConvexError('Connect the preparation model before learning suggestions.')
  const job = await ctx.db.get(args.jobId), source = job && await ctx.db.get(job.sourceId)
  if (!job || owner && job.createdBy !== owner || !source?.text || source.revision !== args.sourceRevision) throw new ConvexError('The supporting request changed or is unavailable.')
  const ref = { householdId: job.householdId, createdBy: job.createdBy, jobId: job._id, sourceId: source._id, sourceRevision: source.revision, sourceHash: sourceHash(source.text), expiresAt: Math.min(source.expiresAt, Date.now() + 30 * 86400_000) }
  if (!await validSource(ctx, ref)) throw new ConvexError('The supporting request changed or is unavailable.')
  const existing = await ctx.db.query('workflowCurations').withIndex('by_job', q => q.eq('jobId', job._id).eq('sourceRevision', source.revision)).unique()
  if (existing) {
    if (existing.status === 'failed') {
      if (existing.attempts >= 2) throw new ConvexError('This learning check reached its two-attempt limit. Start a fresh request when ready.')
      if (!await validSource(ctx, existing)) throw new ConvexError('The supporting request changed. Start a fresh learning request.')
      // An explicit retry reuses the same record, budget and source binding.
      // Concurrent requests see queued/running and cannot add another call.
      await ctx.db.patch(existing._id, { status: 'queued', issue: undefined, failureCode: undefined, lease: undefined, leaseUntil: undefined })
      await ctx.scheduler.runAfter(0, internal.workflowCurator.prepare, { id: existing._id, version: existing.version })
    }
    return existing._id
  }
  const recent = await ctx.db.query('workflowCurations').withIndex('by_owner', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy)).order('desc').take(100)
  if (recent.filter(row => row.createdAt >= Date.now() - 86400_000).length >= 10) throw new ConvexError('You have reached today’s ten learning checks. Existing suggestions are still available to review.')
  const pending = await ctx.db.query('learnedWorkflows').withIndex('by_owner', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy)).order('desc').take(100)
  if (pending.filter(row => row.status === 'review' && row.expiresAt > Date.now()).length >= 30) throw new ConvexError('Review your existing learning suggestions before preparing more.')
  const id = await ctx.db.insert('workflowCurations', { ...ref, familyHash: await familyHash(ctx, (await ctx.db.get(job.householdId))!), version: 1, status: 'queued', attempts: 0, createdAt: Date.now() })
  await ctx.scheduler.runAfter(0, internal.workflowCurator.prepare, { id, version: 1 })
  return id
}
export const request = mutation({ args: requestArgs, handler: async (ctx, args) => { const { subject } = await adult(ctx); return enqueueJob(ctx, args, subject) } })
export const enqueue = internalMutation({ args: requestArgs, handler: async (ctx, args) => enqueueJob(ctx, args) })

export const claim = internalMutation({ args: leaseArgs, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.version !== args.version || !['queued', 'running'].includes(row.status) || (row.leaseUntil ?? 0) > Date.now()) return null
  const current = await validSource(ctx, row)
  if (!current || row.attempts >= 2) { await ctx.db.patch(row._id, { status: current ? 'failed' : 'cancelled', issue: current ? 'Preparation did not finish within its call budget.' : 'The supporting request changed.', lease: undefined, leaseUntil: undefined }); return null }
  await ctx.db.patch(row._id, { status: 'running', attempts: row.attempts + 1, lease: args.lease, leaseUntil: Date.now() + 90000 })
  await ctx.scheduler.runAfter(91000, internal.learnedWorkflows.recover, { id: row._id, version: row.version })
  const [facts, caregivers] = await Promise.all([ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', row.householdId)).take(100), ctx.db.query('caregivers').withIndex('by_household', q => q.eq('householdId', row.householdId)).take(100)])
  return { parentText: current.source.text!.slice(0, 6000), now: new Date().toISOString(), timezone: current.household.timezone, children: current.household.children, caregivers: caregivers.map(c => ({ id: c._id, name: c.name, childIds: c.childIds })), confirmedFacts: facts.filter(f => f.confirmed).map(f => f.value) }
} })

async function held(ctx: MutationCtx, args: { id: Id<'workflowCurations'>; version: number; lease: string }) {
  const row = await ctx.db.get(args.id)
  return row && row.version === args.version && row.status === 'running' && row.lease === args.lease && (row.leaseUntil ?? 0) > Date.now() && await validSource(ctx, row) ? row : null
}
async function checkedValue(ctx: QueryCtx | MutationCtx, household: Doc<'households'>, kind: 'fact' | 'routine' | 'mail_routine', value: unknown) {
  if (kind === 'fact') return checkedFamilyFact(ctx, household, value)
  if (kind === 'mail_routine') return mailRoutineDefinitionSchema.parse(value)
  const checked = routineDefinitionSchema.parse(value)
  const childId = checked.outcome.kind === 'personal_task' ? checked.outcome.task.childId : undefined
  if (childId && !household.children.some(c => c.id === childId)) throw new ConvexError('Choose a confirmed child.')
  if (checked.outcome.kind === 'prepare_request' && (localAssistantReply(checked.outcome.instruction) || capabilityReply(checked.outcome.instruction, { mode: 'connected' }) || householdAssistantReply(checked.outcome.instruction, { timezone: checked.schedule.timezone, jobs: [], personalTasks: [], plan: [] }))) throw new ConvexError('Choose a task or a concrete calendar, email or pickup preparation.')
  return checked
}
export const finish = internalMutation({ args: { ...leaseArgs, result: v.string() }, handler: async (ctx, args) => {
  const row = await held(ctx, args)
  if (!row) return false
  if (args.result.length > 40000) throw new ConvexError('Preparation exceeded its response budget.')
  const current = (await validSource(ctx, row))!, result = validateCuration(JSON.parse(args.result), current.source.text!.slice(0, 6000))
  for (const candidate of result.candidates) {
    const value = await checkedValue(ctx, current.household, candidate.kind, candidate.value), key = sourceHash(JSON.stringify([candidate.kind, value]))
    const previous = await ctx.db.query('learnedWorkflows').withIndex('by_key', q => q.eq('householdId', row.householdId).eq('createdBy', row.createdBy).eq('key', key)).unique()
    if (previous) continue // A dismissed/approved exact suggestion stays decided; no resurrection.
    await ctx.db.insert('learnedWorkflows', { householdId: row.householdId, createdBy: row.createdBy, curationId: row._id, jobId: row.jobId, sourceId: row.sourceId, sourceRevision: row.sourceRevision, sourceHash: row.sourceHash, familyHash: row.familyHash, key, ...candidate, value, version: 1, status: 'review', createdAt: Date.now(), expiresAt: row.expiresAt })
  }
  await ctx.db.patch(row._id, { status: 'complete', lease: undefined, leaseUntil: undefined, issue: undefined })
  return true
} })
export const failed = internalMutation({ args: { ...leaseArgs, failureCode: v.optional(v.union(v.literal('invalid_output'), v.literal('grammar_limit'), v.literal('request_rejected'), v.literal('rate_limit'), v.literal('unavailable'))) }, handler: async (ctx, args) => { const row = await held(ctx, args); if (row) await ctx.db.patch(row._id, { status: 'failed', failureCode: args.failureCode, issue: 'Learning suggestions could not be prepared. Your existing memory and routines are unchanged.', lease: undefined, leaseUntil: undefined }) } })
export const recover = internalMutation({ args: { id: v.id('workflowCurations'), version: v.number() }, handler: async (ctx, args) => { const row = await ctx.db.get(args.id); if (row && row.version === args.version && ['queued', 'running'].includes(row.status) && (row.leaseUntil ?? 0) <= Date.now()) await ctx.scheduler.runAfter(0, internal.workflowCurator.prepare, args) } })

async function owned(ctx: QueryCtx | MutationCtx, args: { id: Id<'learnedWorkflows'>; version: number }) {
  const { household, subject } = await adult(ctx), row = await ctx.db.get(args.id)
  if (!row || row.householdId !== household._id || row.createdBy !== subject) throw new ConvexError('This suggestion is unavailable.')
  if (row.version !== args.version || row.status !== 'review' || !await validSource(ctx, row)) throw new ConvexError('This suggestion or its source changed. Review a fresh suggestion.')
  return { row, household, subject }
}
export const list = query({ args: {}, handler: async (ctx): Promise<LearnedProposal[]> => {
  const { household, subject } = await adult(ctx), rows = await ctx.db.query('learnedWorkflows').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(100)
  const result: LearnedProposal[] = [], fingerprint = await familyHash(ctx, household)
  for (const row of rows) if (row.status === 'review' && await validSource(ctx, row, fingerprint)) { const candidate = learnedCandidateSchema.parse({ kind: row.kind, title: row.title, reason: row.reason, quote: row.quote, value: row.value }); result.push({ ...candidate, _id: row._id, version: row.version, createdAt: row.createdAt, expiresAt: row.expiresAt }) }
  return result
} })
export const update = mutation({ args: { ...versionArgs, value: v.any() }, handler: async (ctx, args) => { const { row, household } = await owned(ctx, args), value = await checkedValue(ctx, household, row.kind, args.value); await ctx.db.patch(row._id, { value, version: row.version + 1 }); return row.version + 1 } })
export const dismiss = mutation({ args: versionArgs, handler: async (ctx, args) => { const { household, subject } = await adult(ctx), row = await ctx.db.get(args.id); if (!row || row.householdId !== household._id || row.createdBy !== subject) throw new ConvexError('This suggestion is unavailable.'); if (row.version !== args.version || row.status !== 'review') throw new ConvexError('This suggestion changed.'); await ctx.db.patch(row._id, { status: 'dismissed', version: row.version + 1, value: undefined, quote: '', reason: '', title: '' }) } })
export const approve = mutation({ args: { ...versionArgs, value: v.any(), shareConfirmed: v.boolean() }, handler: async (ctx, args) => {
  const { row, household, subject } = await owned(ctx, args)
  if (row.kind !== 'mail_routine' && !args.shareConfirmed) throw new ConvexError('Confirm sharing the exact reviewed detail with your household.')
  const value = await checkedValue(ctx, household, row.kind, args.value)
  let factId: Id<'memoryFacts'> | undefined, routineId: Id<'routines'> | undefined, mailRoutineId: Id<'mailRoutines'> | undefined
  if (row.kind === 'fact') {
    const checked = await checkedFamilyFact(ctx, household, value), facts = await ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', household._id)).collect()
    const identical = facts.find(f => f.confirmed && f.key.startsWith('family:') && sourceHash(JSON.stringify(f.value)) === sourceHash(JSON.stringify(checked)))
    factId = identical?._id ?? await ctx.db.insert('memoryFacts', { householdId: household._id, key: `family:${crypto.randomUUID()}`, value: checked, source: 'Parent-reviewed learning suggestion', confirmed: true, version: 1, updatedAt: Date.now(), scope: factScope(checked) })
  } else if (row.kind === 'mail_routine') {
    mailRoutineId = await createReviewedMailRoutine(ctx, household._id, subject, mailRoutineDefinitionSchema.parse(value), `learned:${row._id}`)
  } else {
    const definition = routineDefinitionSchema.parse(value), requestId = `learned:${row._id}`, requestHash = sourceHash(JSON.stringify([definition, false]))
    const existing = (await Promise.all((['active', 'paused', 'blocked', 'finished'] as const).map(state => ctx.db.query('routines').withIndex('by_state', q => q.eq('householdId', household._id).eq('state', state)).take(100)))).flat()
    if (existing.length >= 100) throw new ConvexError('Remove a saved routine before adding another; this household has 100 routines.')
    routineId = await ctx.db.insert('routines', { householdId: household._id, createdBy: subject, requestId, requestHash, definition, version: 1, state: 'paused', createdAt: Date.now(), updatedAt: Date.now() })
    await ctx.db.insert('routineVersions', { householdId: household._id, routineId, version: 1, definition, state: 'paused', changedBy: subject, createdAt: Date.now() })
  }
  await ctx.db.patch(row._id, { status: 'approved', version: row.version + 1, factId, routineId, mailRoutineId, value: undefined, quote: '', reason: '', title: '' })
  return { factId, routineId, mailRoutineId }
} })
export async function expireLearnedWorkflows(ctx: MutationCtx) {
  for (const table of ['learnedWorkflows', 'workflowCurations'] as const) for (const row of await ctx.db.query(table).withIndex('by_expiry', q => q.lte('expiresAt', Date.now())).take(100)) await ctx.db.delete(row._id)
}
