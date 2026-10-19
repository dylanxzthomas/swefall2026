import { routineJobIssue } from './routineRules'
import { ConvexError, v } from 'convex/values'
import { start } from '@convex-dev/workflow'
import { mutation, internalMutation, internalQuery, type QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { adult, sameHousehold } from './access'
import { payloadSchema } from '../shared/daymark'
import { cancelWaitingDependencies } from './dependencies'
import { checkedFiles } from './emailFiles'
import { modelMetrics } from './schema'
import { queueNotice } from './notifications'
import { modelHouseholdContext } from './modelContext'
import { validClarificationBinding } from './requestClarifications'
import { validateClarificationRevision } from '../shared/requestClarifications'

async function pending(ctx: Pick<QueryCtx, 'db'>, actionId: Id<'actions'>, revision: number) {
  const action = await ctx.db.get(actionId)
  if (!action || action.revision !== revision || !action.revisionRequest || action.status !== 'review') return null
  const job = await ctx.db.get(action.jobId), household = await ctx.db.get(action.householdId)
  const source = job && await ctx.db.get(job.sourceId)
  if (!job || job.cancelled || !household || household.deleted || !source || source.revision !== action.sourceRevision) return null
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', action.revisionRequest!.requestedBy)).unique()
  if (member?.householdId !== household._id) return null
  if (!await validClarificationBinding(ctx, action, job, source)) return null
  return { action, job, household, source, routineIssue: await routineJobIssue(ctx, job) }
}

export const request = mutation({ args: { actionId: v.id('actions'), revision: v.number(), instruction: v.string() }, handler: async (ctx, args): Promise<number> => {
  const { household, subject } = await adult(ctx), action = await ctx.db.get(args.actionId)
  sameHousehold(action, household._id)
  if (action!.revision !== args.revision || action!.revisionRequest || !['review', 'failed', 'queued'].includes(action!.status)) throw new ConvexError('This draft changed or has already started. Reopen it before requesting a change.')
  const instruction = args.instruction.trim()
  if (!instruction || instruction.length > 2000) throw new ConvexError('Describe the change in 1–2,000 characters.')
  const job = await ctx.db.get(action!.jobId), source = job && await ctx.db.get(job.sourceId)
  if (!job || job.cancelled || !source || source.revision !== action!.sourceRevision || source.expiresAt <= Date.now() || !source.text && !source.attachmentIds?.length) throw new ConvexError('The original notice changed or expired. Reopen the current request or edit the fields directly.')
  const routineIssue = await routineJobIssue(ctx, job)
  if (routineIssue) throw new ConvexError(routineIssue)
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) throw new ConvexError('Automatic revisions are not connected. You can still edit this draft directly. Nothing was sent.')
  if (action!.payload.kind === 'pickup') await cancelWaitingDependencies(ctx, action!)
  const revision = action!.revision + 1
  // Invalidate an existing queued approval before any model work is scheduled.
  await ctx.db.patch(action!._id, { revision, status: 'review', approvalId: undefined, error: undefined, revisionNote: undefined, revisionRequest: { instruction, requestedBy: subject, startedAt: Date.now() } })
  await start(ctx, internal.workflows.revise, { actionId: action!._id, revision })
  await ctx.scheduler.runAfter(120000, internal.revisions.fail, { actionId: action!._id, revision })
  return revision
} })

export const cancel = mutation({ args: { actionId: v.id('actions'), revision: v.number() }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), action = await ctx.db.get(args.actionId)
  sameHousehold(action, household._id)
  if (action!.revision !== args.revision || !action!.revisionRequest || action!.status !== 'review') throw new ConvexError('This draft changed. Reopen it before keeping the previous version.')
  await ctx.db.patch(action!._id, { revision: action!.revision + 1, revisionRequest: undefined, revisionNote: 'Kept the previous draft. Review it before approving.', approvalId: undefined })
} })

export const context = internalQuery({ args: { actionId: v.id('actions'), revision: v.number() }, handler: async (ctx, args) => {
  const value = await pending(ctx, args.actionId, args.revision)
  if (!value || value.routineIssue || value.source.expiresAt <= Date.now() || value.action.revisionRequest!.startedAt + 120000 <= Date.now()) return null
  const { household, source } = value
  const files = await Promise.all((source.attachmentIds ?? []).map(id => ctx.db.get(id)))
  if (files.some(f => !f || f.householdId !== household._id || f.sourceId !== source._id || f.status !== 'ready' || f.expiresAt <= Date.now() || !f.hash)) return null
  return { ...value,
    files: files.filter(f => f && f.householdId === household._id && f.status === 'ready' && f.expiresAt > Date.now()).map(f => ({ id: f!._id, name: f!.name, hash: f!.hash!, storageId: f!.storageId, mediaType: f!.mediaType })),
    ...await modelHouseholdContext(ctx, household._id, value.action.revisionRequest!.requestedBy, value.action.payload.kind === 'calendar' ? value.action.payload.targetId : null),
  }
} })

export const finish = internalMutation({ args: { actionId: v.id('actions'), revision: v.number(), payload: v.any(), clarification: v.string(), metrics: v.optional(modelMetrics) }, handler: async (ctx, args) => {
  const value = await pending(ctx, args.actionId, args.revision)
  if (!value || value.source.expiresAt <= Date.now() || value.action.revisionRequest!.startedAt + 120000 <= Date.now()) return false
  if (value.routineIssue) { await ctx.db.patch(value.action._id, { revision: value.action.revision + 1, revisionRequest: undefined, approvalId: undefined, error: value.routineIssue }); return false }
  const { action, household } = value, payload = payloadSchema.parse(args.payload)
  const binding = action.revisionRequest!.clarification
  if (binding && !validateClarificationRevision(binding, action.payload, payload, action.revisionRequest!.instruction)) throw new Error('The answer can fill only the requested missing details. The previous draft is preserved.')
  const files = await Promise.all((value.source.attachmentIds ?? []).map(id => ctx.db.get(id)))
  if (files.some(f => !f || f.householdId !== household._id || f.sourceId !== value.source._id || f.status !== 'ready' || f.expiresAt <= Date.now() || !f.hash)) throw new Error('An original file changed or expired while preparing the revision.')
  if (payload.kind !== action.payload.kind) throw new Error('A revision cannot change the action type.')
  // A wording change cannot bypass a source's portal, payment, or signature requirement.
  if (payload.kind === 'email' && action.payload.requirement) payload.requirement = action.payload.requirement
  if (payload.childId && !household.children.some(child => child.id === payload.childId)) throw new Error('Choose a confirmed child.')
  await checkedFiles(ctx, { ...action, payload })
  let before
  if (payload.kind === 'calendar' && payload.targetId) {
    const id = ctx.db.normalizeId('planEvents', payload.targetId), target = id && await ctx.db.get(id)
    if (!target || target.householdId !== household._id || target.owner !== action.revisionRequest!.requestedBy) throw new Error('Choose an event from your Daymark calendar.')
    before = payload.targetId === action.payload.targetId && action.before ? action.before : target
  }
  if (payload.kind === 'pickup' && payload.caregiverId) {
    const id = ctx.db.normalizeId('caregivers', payload.caregiverId), caregiver = id && await ctx.db.get(id)
    if (!caregiver || caregiver.householdId !== household._id || !caregiver.childIds.includes(payload.childId!)) throw new Error('Choose an eligible caregiver for this child.')
  }
  await ctx.db.patch(action._id, { payload, before, revision: action.revision + 1, corrections: (action.corrections ?? 0) + 1, status: 'review', approvalId: undefined, revisionRequest: undefined, revisionNote: args.clarification.slice(0, 2000) || 'Draft revised. Review the changes before approving.', ...(args.metrics ? { revisionMetrics: args.metrics } : {}) })
  if (binding) await ctx.db.patch(value.job._id, { clarification: args.clarification.slice(0, 2000) })
  await queueNotice(ctx, action.jobId, 'ready', `revision:${action._id}:${action.revision + 1}`)
  return true
} })

export const fail = internalMutation({ args: { actionId: v.id('actions'), revision: v.number() }, handler: async (ctx, args) => {
  const value = await pending(ctx, args.actionId, args.revision)
  if (!value) {
    const action = await ctx.db.get(args.actionId)
    if (action?.revision === args.revision && action.revisionRequest) await ctx.db.patch(action._id, { revisionRequest: undefined })
    return
  }
  await ctx.db.patch(value.action._id, { revision: value.action.revision + 1, revisionRequest: undefined, approvalId: undefined, error: value.routineIssue ?? 'Could not prepare that change. The previous draft is preserved; edit it directly or ask again. Nothing was sent.' })
  if (!value.routineIssue) await queueNotice(ctx, value.action.jobId, 'help', `revision:${value.action._id}:${value.action.revision + 1}`)
} })
