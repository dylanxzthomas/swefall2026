import { start } from '@convex-dev/workflow'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import { sourceHash } from '../shared/daymark'
import { askedClarificationFields, clarificationPayloadHash, directClarificationAnswer, type AnswerRequestReference, type ClarificationQuestion } from '../shared/requestClarifications'
import type { WorkItem } from '../shared/workControl'
import { routineJobIssue } from './routineRules'

type Ctx = Pick<QueryCtx, 'db'>
type Owner = { householdId: Doc<'households'>['_id']; createdBy: string; jobId: Doc<'jobs'>['_id']; calendarTriggered?: boolean }
export function clarificationRequestSnapshot(job: Doc<'jobs'>, source: Doc<'sources'>, actions: Doc<'actions'>[]) {
  return sourceHash(JSON.stringify([job, source.revision, source.text, actions.map(a => ({ id: String(a._id), revision: a.revision, kind: String(a.payload.kind), status: a.status, revising: !!a.revisionRequest }))]))
}
function authored(job: Doc<'jobs'>, source: Doc<'sources'>) {
  return job.interactive && !job.cancelled && !job.assistantQuiet && !job.emailQuiet && !job.emailHandling && !job.emailWatchId && !job.routineId && !job.mailRoutineBindings?.length && !job.voiceSessionId && !source.email && !source.hash.startsWith('calendar-assistance:') && !!source.text && source.expiresAt > Date.now()
}
function privateRun(run: Doc<'assistantRuns'>) {
  return run.privateOnly || run.calendarTriggered || run.mailContext || run.workingContext || run.contextBindings?.some(b => b.mailContext || b.workingContext) || run.refs.some(ref => ['mail', 'calendar', 'attachment'].includes(ref.kind))
}
async function unsent(ctx: Ctx, job: Doc<'jobs'>, action: Doc<'actions'>) {
  if (await ctx.db.query('attempts').withIndex('by_action', q => q.eq('actionId', action._id)).first() || await ctx.db.query('receipts').withIndex('by_action', q => q.eq('actionId', action._id)).first() || await ctx.db.query('pickupRequests').withIndex('by_action', q => q.eq('actionId', action._id)).first()) return false
  if (job.assistantRunId) {
    const run = await ctx.db.get(job.assistantRunId)
    if (!run || privateRun(run)) return false
    const drafts = await ctx.db.query('mailDrafts').withIndex('by_owner', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy)).order('desc').take(101)
    // Without an exhaustive journal we cannot rule out an older linked effect.
    if (drafts.length === 101 || drafts.some(draft => draft.assistantRunId === run._id)) return false
  }
  return true
}
/** Only a currently asked, unsent, single draft is eligible. No provider state is
 * imported into this continuation, even if the parent happens to name it. */
export async function pendingRequestClarification(ctx: Ctx, owner: Owner, job: Doc<'jobs'>, source: Doc<'sources'>, actions: Doc<'actions'>[]): Promise<ClarificationQuestion | undefined> {
  if (job.householdId !== owner.householdId || job.createdBy !== owner.createdBy || source.householdId !== owner.householdId || !authored(job, source) || job.preparing || job.conversation || job.scheduledFor || job.mailContext || job.workingContext || source.attachmentIds?.length || actions.length !== 1) return
  const a = actions[0]
  if (a.householdId !== owner.householdId || a.jobId !== job._id || a.sourceRevision !== source.revision || !['review', 'failed', 'queued'].includes(a.status) || a.revisionRequest || a.dependsOn || await routineJobIssue(ctx, job)) return
  const question = a.revisionNote !== undefined ? a.revisionNote : job.clarification
  const fields = askedClarificationFields(question, a.payload)
  if (!fields.length) return
  if (!await latestQuestion(ctx, owner, job, a)) return
  if (!await unsent(ctx, job, a)) return
  const questionKey = sourceHash(JSON.stringify([job._id, source._id, source.revision, a._id, a.revision, clarificationPayloadHash(a.payload), question, fields]))
  return { actionId: a._id, actionRevision: a.revision, sourceRevision: source.revision, questionKey, question, missingFields: fields }
}

/** The immediately preceding authored turn must own this question, or be a
 * successful server-bound answer to the same draft. Unrelated conversation is
 * never silently merged into an older request. */
async function latestQuestion(ctx: Ctx, owner: Owner, target: Doc<'jobs'>, action: Doc<'actions'>) {
  const caller = await ctx.db.get(owner.jobId)
  if (!caller) return false
  const prior = await ctx.db.query('jobs').withIndex('by_creator', q => q.eq('householdId', owner.householdId).eq('createdBy', owner.createdBy)).order('desc').take(51)
  for (const job of prior) {
    if (job._id === caller._id || job._creationTime > caller._creationTime) continue
    const source = await ctx.db.get(job.sourceId)
    if (!source || !authored(job, source)) continue
    if (job._id === target._id) return true
    if (job.preparing) return false
    const runs = await ctx.db.query('assistantRuns').withIndex('by_job', q => q.eq('jobId', job._id).eq('sourceRevision', source.revision)).collect()
    return runs.some(run => {
      if (run.status !== 'complete' || run.createdBy !== owner.createdBy || run.householdId !== owner.householdId || run.sourceHash !== sourceHash(source.text ?? '')) return false
      try { const observations: { tool?: string; result?: { changed?: boolean; targetJobId?: string; actionId?: string } }[] = JSON.parse(run.observations); const last = observations.at(-1); return last?.tool === 'answer_request' && last.result?.changed === true && last.result.targetJobId === target._id && last.result.actionId === action._id } catch { return false }
    })
  }
  return false
}

export async function answerRequestClarification(ctx: MutationCtx, owner: Owner, answer: string, observed: WorkItem[], id: string, reference: AnswerRequestReference) {
  const blocked = (message: string) => ({ changed: false, answer: message })
  const household = await ctx.db.get(owner.householdId), member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', owner.createdBy)).unique()
  if (!household || household.deleted || member?.householdId !== owner.householdId) return blocked('Your household access changed. I haven’t changed that draft.')
  const caller = await ctx.db.get(owner.jobId), parentSource = caller && await ctx.db.get(caller.sourceId)
  if (owner.calendarTriggered || !caller || !parentSource || caller.householdId !== owner.householdId || caller.createdBy !== owner.createdBy || parentSource.householdId !== owner.householdId || !authored(caller, parentSource) || parentSource.text !== answer || parentSource.attachmentIds?.length || !directClarificationAnswer(answer)) return blocked('Tell me the missing detail directly, or open the draft to make a different change. I haven’t changed it.')
  const previous = observed.find(item => item.id === id && item.kind === 'request')
  const metadata = previous?.clarification
  if (!previous || !metadata || previous.snapshot !== reference.snapshot || previous.version !== reference.version || metadata.actionId !== reference.actionId || metadata.actionRevision !== reference.actionRevision || metadata.sourceRevision !== reference.sourceRevision || metadata.questionKey !== reference.questionKey) return blocked('I need to check the current draft and its question before using that answer.')
  const key = ctx.db.normalizeId('jobs', id), job = key && await ctx.db.get(key), source = job && await ctx.db.get(job.sourceId)
  if (!job || !source) return blocked('That request is no longer available. Nothing changed.')
  const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).take(9)
  const fresh = await pendingRequestClarification(ctx, owner, job, source, actions)
  if (!fresh || clarificationRequestSnapshot(job, source, actions) !== reference.snapshot || source.revision !== reference.version || fresh.questionKey !== reference.questionKey || fresh.actionId !== reference.actionId || fresh.actionRevision !== reference.actionRevision || !await latestQuestion(ctx, owner, job, actions[0])) return blocked('That question or conversation changed. Open the current draft or tell me which request you mean; I haven’t changed it.')
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) return blocked('Automatic draft revision needs the connected model. You can still edit the draft in its review.')
  const action = actions[0], revision = action.revision + 1
  // Normalize the displayed current question so a concurrent question edit also
  // invalidates the pending result, including questions from an earlier revision.
  await ctx.db.patch(job._id, { clarification: fresh.question })
  await ctx.db.patch(action._id, { revision, status: 'review', approvalId: undefined, error: undefined, revisionNote: undefined, revisionRequest: { instruction: answer, requestedBy: owner.createdBy, startedAt: Date.now(), clarification: { questionKey: fresh.questionKey, question: fresh.question, fields: fresh.missingFields, originalPayloadHash: clarificationPayloadHash(action.payload), originalActionRevision: action.revision, sourceRevision: source.revision, answerJobId: caller._id, answerSourceId: parentSource._id, answerSourceRevision: parentSource.revision, answerHash: sourceHash(answer) } } })
  await start(ctx, internal.workflows.revise, { actionId: action._id, revision })
  await ctx.scheduler.runAfter(120000, internal.revisions.fail, { actionId: action._id, revision })
  return { changed: true, answer: 'I’m adding that detail to the existing draft. I’ll return it for review before anything is sent or changed.', targetJobId: job._id, actionId: action._id }
}

/** Recheck both independently versioned sources before reading or committing a
 * model response. A removed, changed or expired answer cannot retain authority. */
export async function validClarificationBinding(ctx: Ctx, action: Doc<'actions'>, job: Doc<'jobs'>, source: Doc<'sources'>) {
  const request = action.revisionRequest, binding = request?.clarification
  if (!binding) return true
  if (job.createdBy !== request.requestedBy || source.revision !== binding.sourceRevision || action.revision !== binding.originalActionRevision + 1 || clarificationPayloadHash(action.payload) !== binding.originalPayloadHash || !authored(job, source) || job.clarification !== binding.question || job.conversation || job.preparing || job.mailContext || job.workingContext || source.attachmentIds?.length) return false
  const answerJob = await ctx.db.get(binding.answerJobId), answerSource = await ctx.db.get(binding.answerSourceId)
  if (!answerJob || !answerSource || answerJob.householdId !== job.householdId || answerJob.createdBy !== request.requestedBy || answerJob.sourceId !== answerSource._id || answerSource.householdId !== job.householdId || !authored(answerJob, answerSource) || answerSource.revision !== binding.answerSourceRevision || answerSource.text !== request.instruction || sourceHash(answerSource.text ?? '') !== binding.answerHash) return false
  const fields = askedClarificationFields(binding.question, action.payload)
  if (!binding.fields.length || !binding.fields.every(field => fields.includes(field)) || !directClarificationAnswer(request.instruction)) return false
  const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).take(2)
  if (actions.length !== 1 || actions[0]._id !== action._id) return false
  return unsent(ctx, job, action)
}
