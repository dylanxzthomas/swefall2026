import { pendingPickupMail, pickupMailChoice } from './pickupMailRules'
import { validAssistantRun } from './assistantCoordinator'
import { canUse, selection, providerOf } from './providerRules'
import { modelMetrics, emailTriage, mailConversationContext } from './schema'
import { groundedEmailTask, emailTaskSemanticKey } from '../shared/emailTasks'
import { relatedContext, relatedMessages } from './emailFollowups'
import { guardEmailTriage, emailBody } from '../shared/emailTriage'
import { v, ConvexError } from 'convex/values'
import { start } from '@convex-dev/workflow'
import { mutation, query, internalMutation, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { queueNotice } from './notifications'
import { cancelWaitingDependencies } from './dependencies'
import { checkedFiles } from './emailFiles'
import { confirmedPickupConflict } from './pickupConflicts'
import { pickupDelivery } from './pickupDelivery'
import { adult, sameHousehold, canReadJob, readableJob } from './access'
import { availabilityAt, familyFactSchema } from '../shared/memory'
import { blockers, instant, payloadSchema, sourceHash, payloadHash } from '../shared/daymark'
import { localAssistantReply } from '../shared/assistant'
import { validateSchedule } from '../shared/tasks'
import { assistantName } from '../shared/persona'
import { capabilityReply } from '../shared/capabilities'
import { householdAssistantReply, isPreparationRequest } from '../shared/householdAssistant'
import { modelUnavailableReply } from '../shared/conversation'
import { capabilitiesFor, conversationContext, householdWork } from './assistantContext'
import { routineJobIssue } from './routineRules'
import { resolveApprovedTool } from '../shared/tools'
import { validMailConversation, unavailableMailContext } from './mailConversation'
import { conversationValidation } from './conversationValidation'
import { validWorkingContext, unavailableWorkingContext } from './workingMemory'
import { workingConversationContext } from './schema'
import { modelHouseholdContext } from './modelContext'

export const list = query({ args: {}, handler: async ctx => {
  const { household, subject } = await adult(ctx)
  const validate = conversationValidation(ctx)
  const jobs = await ctx.db.query('jobs').withIndex('by_household', q => q.eq('householdId', household._id)).order('desc').collect()
  return Promise.all(jobs.filter(job => canReadJob(job, subject) && !job.assistantQuiet && !job.emailQuiet && !job.emailHandling).map(async job => { const { mailRoutineBindings, ...visibleJob } = job; return ({ ...visibleJob,
    ...(job.assistantRunId && !await validAssistantRun(ctx, job) ? { clarification: 'The supporting context changed. Ask Sola for a fresh answer.' } : {}),
    ...(job.mailContext && !await validate.mail(job, job.mailContext) ? { clarification: unavailableMailContext } : {}),
    ...(job.workingContext && !await validate.working(job, job.workingContext) ? { clarification: unavailableWorkingContext } : {}),
    source: await ctx.db.get(job.sourceId).then(source => source && source.householdId === household._id && source.expiresAt > Date.now() ? source : null),
    files: await Promise.all(((await ctx.db.get(job.sourceId))?.attachmentIds ?? []).map(async id => { const f = await ctx.db.get(id); return f && f.status === 'ready' && f.expiresAt > Date.now() ? { id: f._id, name: f.name, hash: f.hash, size: f.size, mediaType: f.mediaType } : null })).then(files => files.filter(Boolean)),
    actions: await Promise.all((await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).collect()).map(async a => ({ ...a, pickupEmail: a.payload.kind === 'pickup' && !!await pendingPickupMail(ctx, a._id, subject), provider: a.approvalId ? ((await ctx.db.get(a.approvalId))?.provider ?? 'google') : a.before?.provider, receipts: await ctx.db.query('receipts').withIndex('by_action', q => q.eq('actionId', a._id)).collect() }))),
  }) }))
} })
export const plan = query({ args: {}, handler: async ctx => {
  const { household } = await adult(ctx)
  return ctx.db.query('planEvents').withIndex('by_household', q => q.eq('householdId', household._id)).collect()
} })
export const submit = mutation({ args: { text: v.string(), attachmentIds: v.optional(v.array(v.id('attachments'))) }, handler: async (ctx, { text, attachmentIds = [] }): Promise<Id<'jobs'>> => {
  const { household, subject } = await adult(ctx)
  text = text.trim()
  if ((!text && !attachmentIds.length) || text.length > 20000) throw new ConvexError('Share between 1 and 20,000 characters.')
  const files = await Promise.all(attachmentIds.map(id => ctx.db.get(id)))
  if (attachmentIds.length > 5 || new Set(attachmentIds).size !== attachmentIds.length || files.some(f => !f || f.householdId !== household._id || f.subject !== subject || f.status !== 'ready' || f.sourceId)) throw new ConvexError('Attachments are unavailable or still being checked.')
  const total = files.reduce((sum, f) => sum + f!.size, 0), pdfs = files.filter(f => f!.mediaType === 'application/pdf').length
  if (total > 10 * 1024 * 1024 || pdfs && files.length !== 1) throw new ConvexError('Share up to five images or one PDF, 10 MB total.')
  if (!attachmentIds.length) {
    const preference = await ctx.db.query('personalPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
    const localReply = localAssistantReply(text, preference?.householdId === household._id ? { parentName: preference.parentName, assistantName: assistantName(preference) } : { assistantName: assistantName() })
    const capabilityQuestion = capabilityReply(text, { mode: 'connected' })
    let reply = capabilityQuestion ? capabilityReply(text, await capabilitiesFor(ctx, household._id, subject)) : localReply
    const modelReady = Boolean(process.env.ANTHROPIC_API_KEY && process.env.DAYMARK_MODEL)
    const householdIntent = !reply && householdAssistantReply(text, { timezone: household.timezone, jobs: [], personalTasks: [], plan: [] })
    // Keep literal task creation atomic and inexpensive. Questions about what
    // needs attention should use the model's current reads and judgment instead
    // of a canned saved-record list when the assistant is connected.
    const work = householdIntent && (!modelReady || householdIntent.kind === 'personalTask') ? await householdWork(ctx, household, subject) : null
    const householdReply = work ? householdAssistantReply(text, work) : null
    reply ??= householdReply?.text ?? null
    if (householdReply?.kind === 'personalTask') {
      const input = householdReply.input
      const previous = work!.personalTasks.find(task => !task.done && task.title.toLocaleLowerCase() === input.title.toLocaleLowerCase() && task.dueDate === input.dueDate)
      if (previous) reply = `“${previous.title}” is already on your tasks${previous.dueDate ? `, due ${previous.dueDate}` : ''}.`
      else if (work!.personalTasksLimited) reply = 'I haven’t added this yet because I can’t check all your saved tasks for duplicates in this reply. Open Tasks to check the full list and add it there.'
      else {
        const requestId = `chat:${subject}:${Date.now()}:${sourceHash(text)}`
        await ctx.db.insert('personalTasks', { householdId: household._id, requestId, requestHash: sourceHash(JSON.stringify(input)), ...input, done: false, version: 1, createdAt: Date.now(), updatedAt: Date.now() })
      }
    }
    if (!reply && !isPreparationRequest(text) && !(process.env.ANTHROPIC_API_KEY && process.env.DAYMARK_MODEL)) reply = modelUnavailableReply
    if (reply) {
      // Conversation is repeatable and cannot capture the deduplication key of a future notice.
      const sourceId = await ctx.db.insert('sources', { householdId: household._id, text, attachmentIds: [], hash: `conversation:${sourceHash(text)}`, revision: 1, expiresAt: Date.now() + 30 * 86400_000 })
      return ctx.db.insert('jobs', { householdId: household._id, sourceId, createdBy: subject, interactive: true, conversation: true, preparing: false, cancelled: false, clarification: reply })
    }
  }
  // A contextual conversational turn must never reuse another adult's answer or an old turn.
  // Notices keep their content identity for duplicate prevention.
  const hash = !files.length && !isPreparationRequest(text) ? `turn:${subject}:${crypto.randomUUID()}` : sourceHash(text + (files.length ? '\nfiles:' + files.map(f => f!.hash).join(',') : ''))
  const existing = await ctx.db.query('sources').withIndex('by_hash', q => q.eq('householdId', household._id).eq('hash', hash)).first()
  if (existing) {
    const previous = await ctx.db.query('jobs').withIndex('by_source', q => q.eq('sourceId', existing._id)).first()
    if (previous && canReadJob(previous, subject)) return previous._id
  }
  const sourceId = await ctx.db.insert('sources', { householdId: household._id, text, attachmentIds, hash, revision: 1, expiresAt: Date.now() + 30 * 86400_000 })
  for (const file of files) await ctx.db.patch(file!._id, { sourceId })
  const jobId = await ctx.db.insert('jobs', { householdId: household._id, sourceId, createdBy: subject, interactive: true, preparing: true, cancelled: false, clarification: '' })
  await start(ctx, internal.workflows.prepare, { jobId, sourceRevision: 1 })
  return jobId
} })
export const schedule = mutation({ args: { text: v.string(), runAt: v.number(), requestId: v.string() }, handler: async (ctx, args): Promise<Id<'jobs'>> => {
  const { household, subject } = await adult(ctx), text = args.text.trim(), requestId = args.requestId.trim()
  if (!requestId || requestId.length > 100) throw new ConvexError('This scheduled request needs a valid identifier.')
  const hash = sourceHash(JSON.stringify([text, args.runAt]))
  const previous = await ctx.db.query('jobs').withIndex('by_schedule_request', q => q.eq('householdId', household._id).eq('scheduleRequestId', requestId)).unique()
  if (previous) {
    if (previous.scheduleRequestHash !== hash) throw new ConvexError('This identifier was already used for a different scheduled request.')
    return previous._id
  }
  validateSchedule(text, args.runAt)
  const preference = await ctx.db.query('personalPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  if (localAssistantReply(text, { assistantName: assistantName(preference?.householdId === household._id ? preference : undefined) }) || capabilityReply(text, { mode: 'connected' }) || householdAssistantReply(text, { timezone: household.timezone, jobs: [], personalTasks: [], plan: [] })) throw new ConvexError('Describe a school reply, calendar change, or pickup request to prepare later.')
  // Explicitly scheduled instructions are retained until 30 days after their preparation date.
  const sourceId = await ctx.db.insert('sources', { householdId: household._id, text, attachmentIds: [], hash: `scheduled:${sourceHash(text)}`, revision: 1, expiresAt: args.runAt + 30 * 86400_000 })
  const jobId = await ctx.db.insert('jobs', { householdId: household._id, sourceId, createdBy: subject, preparing: false, cancelled: false, clarification: '', scheduledFor: args.runAt, scheduleRequestId: requestId, scheduleRequestHash: hash })
  await ctx.scheduler.runAt(args.runAt, internal.jobs.startScheduled, { jobId, sourceRevision: 1, runAt: args.runAt })
  return jobId
} })
/** Retry preparation only; this cannot replay an approval or provider action. */
export const retryConversation = mutation({ args: { jobId: v.id('jobs'), sourceRevision: v.number() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), job = await ctx.db.get(args.jobId)
  if (!job || job.assistantRunId || job.householdId !== household._id || job.createdBy !== subject || !job.interactive || !job.conversation || !job.emailPreparationFailed || job.cancelled || job.preparing || job.scheduledFor !== undefined || job.mailContext || job.workingContext) throw new ConvexError('This conversation cannot be retried. Send a new request instead.')
  const source = await ctx.db.get(job.sourceId)
  if (!source || source.householdId !== household._id || source.revision !== args.sourceRevision || source.expiresAt <= Date.now() || !source.text && !source.attachmentIds?.length) throw new ConvexError('This request changed or expired. Share it again to continue.')
  const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).take(1)
  if (actions.length) throw new ConvexError('Review the existing work; retrying cannot replay its actions.')
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) throw new ConvexError('The assistant connection is unavailable. Your saved message is unchanged.')
  const revision = source.revision + 1
  await ctx.db.patch(source._id, { revision })
  await ctx.db.patch(job._id, { preparing: true, clarification: '', emailPreparationFailed: undefined })
  await start(ctx, internal.workflows.prepare, { jobId: job._id, sourceRevision: revision })
  return revision
} })
export const startScheduled = internalMutation({ args: { jobId: v.id('jobs'), sourceRevision: v.number(), runAt: v.number() }, handler: async (ctx, args): Promise<void> => {
  const job = await ctx.db.get(args.jobId)
  if (!job || job.cancelled || job.preparing || job.scheduledFor !== args.runAt || args.runAt > Date.now()) return
  const household = await ctx.db.get(job.householdId), source = await ctx.db.get(job.sourceId)
  if (!household || household.deleted || !source || source.revision !== args.sourceRevision) return
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', job.createdBy)).unique()
  if (!member || member.householdId !== household._id) { await ctx.db.patch(job._id, { scheduledFor: undefined, clarification: 'This request’s adult no longer has household access. Share it again to prepare a draft.' }); return }
  if (source.expiresAt <= Date.now() || !source.text) { await ctx.db.patch(job._id, { scheduledFor: undefined, clarification: 'The scheduled request expired. Share it again to prepare a draft.' }); return }
  await ctx.db.patch(job._id, { scheduledFor: undefined, preparing: true, clarification: '' })
  await ctx.db.patch(source._id, { expiresAt: Date.now() + 30 * 86400_000 })
  await start(ctx, internal.workflows.prepare, { jobId: job._id, sourceRevision: source.revision })
} })
export const reviseSource = mutation({ args: { jobId: v.id('jobs'), text: v.string(), revision: v.number() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), job = await ctx.db.get(args.jobId)
  sameHousehold(job, household._id)
  readableJob(job, subject)
  if (job!.mailRoutineBindings?.length) { const problem = await routineJobIssue(ctx, job!); if (problem) throw new ConvexError(problem) }
  if(job!.voiceSessionId || job!.assistantRunId && job!.conversation)throw new ConvexError('Private assistant preparation stays private. Review the exact prepared text before sharing household work.')
  if (job!.workingContext) throw new ConvexError('Earlier private conversation stays private. Share the current details as a new request to prepare household work.')
  if (job!.mailContext) throw new ConvexError('Review the source email to prepare a reply or share household work. Private email discussion stays private.')
  const source = await ctx.db.get(job!.sourceId)
  if (!source || source.revision !== args.revision || !args.text.trim() || args.text.length > 20000 || job!.cancelled) throw new ConvexError('This source changed. Reopen it before editing.')
  if (job!.scheduledFor !== undefined) {
    const preference = await ctx.db.query('personalPreferences').withIndex('by_subject', q => q.eq('subject', job!.createdBy)).unique()
    if (localAssistantReply(args.text, { assistantName: assistantName(preference?.householdId === household._id ? preference : undefined) }) || capabilityReply(args.text, { mode: 'connected' }) || householdAssistantReply(args.text, { timezone: household.timezone, jobs: [], personalTasks: [], plan: [] })) throw new ConvexError('Describe a school reply, calendar change, or pickup request to prepare later.')
  }
  const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', args.jobId)).collect()
  if (actions.some(a => ['executing', 'uncertain', 'waiting'].includes(a.status))) throw new ConvexError('Resolve the active or unconfirmed action before changing this source.')
  // Completed artifacts and their receipts survive; new preparation can propose corrections.
  for (const a of actions) if (!['succeeded', 'cancelled'].includes(a.status)) await ctx.db.patch(a._id, { status: 'cancelled', revision: a.revision + 1, approvalId: undefined, revisionRequest: undefined })
  const attachments = await Promise.all((source.attachmentIds ?? []).map(id => ctx.db.get(id)))
  const revisedHash = sourceHash(args.text.trim() + (attachments.length ? '\nfiles:' + attachments.map(f => f?.hash ?? 'expired').join(',') : ''))
  await ctx.db.patch(source._id, { email: undefined, text: args.text.trim(), hash: job!.scheduledFor ? `scheduled:${revisedHash}` : revisedHash, revision: source.revision + 1, expiresAt: Math.max(Date.now(), job!.scheduledFor ?? 0) + 30 * 86400_000 })
  await ctx.db.patch(job!._id, { preparing: !job!.scheduledFor, conversation: undefined, emailQuiet: undefined, emailTriage: undefined, emailHandling: undefined, emailSnoozedUntil: undefined, emailHandlingVersion: (job!.emailHandlingVersion ?? 0) + 1, emailReviewRequested: job!.emailWatchId ? true : undefined, clarification: '' })
  if (job!.scheduledFor) await ctx.scheduler.runAt(Math.max(Date.now(), job!.scheduledFor), internal.jobs.startScheduled, { jobId: job!._id, sourceRevision: source.revision + 1, runAt: job!.scheduledFor })
  else await start(ctx, internal.workflows.prepare, { jobId: job!._id, sourceRevision: source.revision + 1 })
} })
export const context = internalQuery({ args: { jobId: v.id('jobs') }, handler: async (ctx, { jobId }) => {
  const job = await ctx.db.get(jobId)
  if (!job || job.cancelled || job.scheduledFor !== undefined) return null
  const household = await ctx.db.get(job.householdId)
  if (!household || household.deleted) return null
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', job.createdBy)).unique()
  if (member?.householdId !== household._id) return null
  const watch = job.emailWatchId ? await ctx.db.get(job.emailWatchId) : null
  return { job, household, relatedMessages: await relatedContext(ctx, job), emailWatchInstruction: watch?.householdId === household._id && watch.createdBy === job.createdBy && watch.version === job.emailWatchVersion ? watch.instruction : undefined, routineIssue: await routineJobIssue(ctx, job), assistant: job.interactive ? await conversationContext(ctx, household, job) : null, ...await modelHouseholdContext(ctx, household._id, job.createdBy), source: await ctx.db.get(job.sourceId),
    files: await Promise.all(((await ctx.db.get(job.sourceId))?.attachmentIds ?? []).map(async id => { const f = await ctx.db.get(id); return f && f.status === 'ready' && f.expiresAt > Date.now() ? { id: f._id, name: f.name, hash: f.hash, size: f.size, mediaType: f.mediaType } : null })).then(files => files.filter(Boolean)) }
} })
/** Preserve same-adult dialogue order without holding an action or provider lease. */
export const waitingForEarlier = internalQuery({ args: { jobId: v.id('jobs'), sourceRevision: v.number() }, handler: async (ctx, args) => {
  const job = await ctx.db.get(args.jobId)
  if (!job?.interactive || !job.preparing || job.cancelled) return false
  const source = await ctx.db.get(job.sourceId)
  if (!source || source.revision !== args.sourceRevision || source.expiresAt <= Date.now()) return false
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', job.createdBy)).unique()
  if (member?.householdId !== job.householdId) return false
  const earlier = await ctx.db.query('jobs').withIndex('by_creator', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy).lt('_creationTime', job._creationTime)).filter(q => q.and(q.eq(q.field('interactive'), true), q.eq(q.field('preparing'), true), q.eq(q.field('cancelled'), false), q.eq(q.field('scheduledFor'), undefined))).order('desc').take(5)
  for (const prior of earlier) {
    const s = await ctx.db.get(prior.sourceId)
    if (s && s.householdId === job.householdId && s.expiresAt > Date.now()) return true
  }
  return false
} })
export const prepared = internalMutation({ args: { jobId: v.id('jobs'), sourceRevision: v.number(), actions: v.array(v.any()), clarification: v.string(), triage: v.optional(emailTriage), tasks: v.optional(v.array(v.any())), preparationFailed: v.optional(v.boolean()), conversation: v.optional(v.boolean()), mailContext: v.optional(mailConversationContext), workingContext: v.optional(workingConversationContext), metrics: v.optional(modelMetrics) }, handler: async (ctx, args) => {
  const job = await ctx.db.get(args.jobId)
  if (!job || job.cancelled || !job.preparing) return
  const source = await ctx.db.get(job.sourceId)
  if (!source || source.revision !== args.sourceRevision) return
  if (args.preparationFailed && job.emailWatchId) args.clarification = 'Preparation stopped. Your email is saved. Retry from Recent email checks; nothing has been sent.'
  if (source.expiresAt <= Date.now()) { await ctx.db.patch(job._id, { preparing: false, ...(job.interactive ? { conversation: true } : {}), clarification: 'The original notice expired. Share it again to prepare new work.' }); return }
  const household = await ctx.db.get(job.householdId)
  if (!household || household.deleted) return
  if (job.interactive) {
    const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', job.createdBy)).unique()
    if (!member || member.householdId !== household._id) { await ctx.db.patch(job._id, { preparing: false, conversation: true, clarification: 'This request’s adult no longer has household access.' }); return }
  }
  if(job.assistantRunId && (args.actions.length || args.tasks?.length)){const run=await ctx.db.get(job.assistantRunId);if(!run||run.phase!=='notice'||run.privateOnly||run.mailContext||run.workingContext||run.contextBindings?.some(b=>b.mailContext||b.workingContext)||(run.refs as any[]).some(ref=>['mail','calendar','attachment'].includes(ref.kind)))throw new ConvexError('Private assistant preparation cannot create household work.')}
  if (args.mailContext) {
    if (!job.interactive || !args.conversation || args.actions.length || args.tasks?.length) throw new ConvexError('Private email discussion cannot create household work.')
    if (!await validMailConversation(ctx, job, args.mailContext)) {
      await ctx.db.patch(job._id, { preparing: false, conversation: true, clarification: unavailableMailContext })
      return
    }
    await ctx.db.patch(job._id, { mailContext: args.mailContext })
    await ctx.db.patch(source._id, { expiresAt: Math.min(source.expiresAt, args.mailContext.expiresAt) })
  }
  if (args.workingContext) {
    if (!job.interactive || !args.conversation || args.actions.length || args.tasks?.length) throw new ConvexError('Private working context cannot create household work.')
    if (!await validWorkingContext(ctx, job, args.workingContext)) { await ctx.db.patch(job._id, { preparing: false, conversation: true, clarification: unavailableWorkingContext }); return }
    await ctx.db.patch(job._id, { workingContext: args.workingContext })
    await ctx.db.patch(source._id, { expiresAt: Math.min(source.expiresAt, args.workingContext.expiresAt) })
  }
  const routineIssue = await routineJobIssue(ctx, job)
  if (routineIssue) { await ctx.db.patch(job._id, { preparing: false, ...(job.interactive ? { conversation: true } : {}), clarification: routineIssue }); return }
  const triage = job.emailWatchId && !job.emailReviewRequested && args.triage ? guardEmailTriage(args.triage, emailBody(source), source.email?.extraction, args.actions.length + (args.tasks?.length ?? 0), args.clarification, source.email?.subject) : undefined
  if (triage?.decision === 'quiet') {
    await ctx.db.patch(job._id, { preparing: false, emailQuiet: true, emailTriage: triage, clarification: '', ...(args.metrics ? { preparationMetrics: args.metrics } : {}) })
    return
  }
  if (job.emailWatchId && source.email && emailBody(source) !== undefined) {
    const prior = await relatedMessages(ctx, job)
    const existing = (await Promise.all(prior.map(other => ctx.db.query('emailTaskSuggestions').withIndex('by_job', q => q.eq('jobId', other._id)).take(5)))).flat()
    for (const raw of (args.tasks ?? []).slice(0, 5)) {
      const grounded = groundedEmailTask(raw, emailBody(source)!, household.children)
      if (!grounded) continue
      const semanticKey = emailTaskSemanticKey(grounded.input)
      const decided = await Promise.all((['saved', 'dismissed'] as const).map(status => ctx.db.query('emailTaskSuggestions').withIndex('by_decision', q => q.eq('householdId', job.householdId).eq('createdBy', job.createdBy).eq('emailThreadKey', job.emailThreadKey ?? String(job._id)).eq('emailWatchVersion', job.emailWatchVersion).eq('semanticKey', semanticKey).eq('status', status)).first()))
      if (decided.some(Boolean) || existing.some(t => t.semanticKey === semanticKey && (t.jobId === job._id || t.status === 'saved' || t.status === 'dismissed'))) continue
      const id = await ctx.db.insert('emailTaskSuggestions', { householdId: job.householdId, jobId: job._id, sourceRevision: source.revision, version: 1, status: 'proposed', createdBy: job.createdBy, emailThreadKey: job.emailThreadKey ?? String(job._id), emailWatchVersion: job.emailWatchVersion, ...grounded.input, evidence: grounded.evidence, ...(grounded.issue ? { issue: grounded.issue } : {}), semanticKey })
      existing.push((await ctx.db.get(id))!)
    }
  }
  if (triage?.decision === 'uncertain' && !args.clarification.trim()) args.clarification = triage.reason
  if (args.conversation && args.actions.length) throw new ConvexError('A conversational reply cannot also create hidden work.')
  if (job.interactive && args.preparationFailed && args.actions.length) throw new ConvexError('Failed conversation preparation cannot create household work.')
  const sourceFiles = await Promise.all((source.attachmentIds ?? []).map(id => ctx.db.get(id)))
  if (args.actions.length && sourceFiles.some(f => !f || f.householdId !== job.householdId || f.sourceId !== source._id || f.status !== 'ready' || f.expiresAt <= Date.now())) { await ctx.db.patch(job._id, { preparing: false, ...(job.interactive ? { conversation: true } : {}), clarification: 'An original file is no longer available. Share the complete notice again.' }); return }
  for (const raw of args.actions.slice(0, 8)) {
    const payload = payloadSchema.parse(raw)
    let before
    if (payload.kind === 'calendar' && payload.targetId) {
      const targetId = ctx.db.normalizeId('planEvents', payload.targetId)
      const target = targetId ? await ctx.db.get(targetId) : null
      if (!target || target.householdId !== job.householdId || target.owner !== job.createdBy) { payload.targetId = null; args.clarification += ' Confirm whether this is a new event; an external calendar event cannot be silently changed.' }
      else before = target
    }
    await ctx.db.insert('actions', { householdId: job.householdId, jobId: job._id, sourceRevision: source.revision, revision: 1, payload, status: 'review', ...(before ? { before } : {}) })
  }
  const conversational = !args.actions.length && (args.conversation === true || job.interactive && args.preparationFailed === true)
  await ctx.db.patch(job._id, { preparing: false, emailPreparationFailed: args.preparationFailed || undefined, emailQuiet: undefined, ...(triage ? { emailTriage: triage } : {}), conversation: conversational || undefined, clarification: args.clarification, ...(args.metrics ? { preparationMetrics: args.metrics } : {}) })
  if (conversational) await ctx.db.patch(source._id, { hash: `conversation:${sourceHash(source.text ?? '')}` })
  else await queueNotice(ctx, job._id, 'ready', String(args.sourceRevision))
  if (conversational && !args.preparationFailed && !args.mailContext && !(job.assistantRunId && (await ctx.db.get(job.assistantRunId))?.calendarTriggered)) await start(ctx, internal.workflows.refreshWorkingMemory, { jobId: job._id })
} })
export const edit = mutation({ args: { actionId: v.id('actions'), revision: v.number(), payload: v.any() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), a = await ctx.db.get(args.actionId)
  sameHousehold(a, household._id)
  const job = a && await ctx.db.get(a.jobId)
  if (job?.mailRoutineBindings?.length) { const problem = await routineJobIssue(ctx, job); if (problem) throw new ConvexError(problem) }
  if (a!.revision !== args.revision || !['review', 'failed', 'queued'].includes(a!.status)) throw new ConvexError('This action changed or has started. Reopen it before editing.')
  const payload = payloadSchema.parse(args.payload)
  if (payload.kind !== a!.payload.kind) throw new ConvexError('Action type cannot change.')
  if (payload.kind === 'pickup') await cancelWaitingDependencies(ctx, a!)
  let before
  if (payload.kind === 'calendar' && payload.targetId) {
    const id = ctx.db.normalizeId('planEvents', payload.targetId), target = id ? await ctx.db.get(id) : null
    sameHousehold(target, household._id)
    if (target!.owner !== subject) throw new ConvexError('Only the connected adult can change this event.')
    before = payload.targetId === a!.payload.targetId && a!.before ? a!.before : target
  }
  await ctx.db.patch(a!._id, { payload, corrections: (a!.corrections ?? 0) + 1, revision: a!.revision + 1, status: 'review', error: undefined, approvalId: undefined, before, revisionRequest: undefined, revisionNote: undefined })
} })
export const approve = mutation({ args: { reviewMs: v.optional(v.number()), actions: v.array(v.object({ id: v.id('actions'), revision: v.number(), selectionVersion: v.optional(v.number()), nativeCalendar: v.optional(v.object({ calendarId: v.string(), version: v.number() })), deliveryChannel: v.optional(v.union(v.literal('email'), v.literal('app'))), pickupEmailHash: v.optional(v.string()) })) }, handler: async (ctx, args): Promise<void> => {
  const { household, subject } = await adult(ctx)
  if (!args.actions.length || args.actions.length > 8 || new Set(args.actions.map(a => a.id)).size !== args.actions.length) throw new ConvexError('Choose up to eight different actions.')
  for (const selected of args.actions) {
    const a = await ctx.db.get(selected.id)
    sameHousehold(a, household._id)
    if (a!.revision !== selected.revision) throw new ConvexError('This review changed. Please review the latest version.')
    if (a!.revisionRequest) throw new ConvexError('Wait for the revised draft or keep the previous version before approving.')
    if (['queued', 'executing', 'succeeded', 'waiting'].includes(a!.status)) continue
    if (!['review', 'failed'].includes(a!.status)) throw new ConvexError('This action needs reconciliation before it can run.')
    const job = await ctx.db.get(a!.jobId), source = job && await ctx.db.get(job.sourceId)
    if (!job || job.cancelled || !source || source.revision !== a!.sourceRevision) throw new ConvexError('The source changed. Review the new proposal.')
    const routineIssue = await routineJobIssue(ctx, job)
    if (routineIssue) throw new ConvexError(routineIssue)
    await checkedFiles(ctx, a!)
    const payload = payloadSchema.parse(a!.payload), issues = blockers(payload, household.children)
    if (issues.length) throw new ConvexError(issues.join(' '))
    const chosen = await selection(ctx, subject, payload.kind === 'email' ? 'email' : 'calendar'), connection = chosen.connection
    if ((payload.kind !== 'pickup' || payload.calendarUpdate) && chosen.version !== (selected.selectionVersion ?? 0)) throw new ConvexError('The calendar or email account changed. Reopen the review before approving.')
    if (connection?.provider === 'apple' && (payload.kind === 'calendar' || payload.kind === 'pickup' && payload.calendarUpdate) && (!selected.nativeCalendar || selected.nativeCalendar.calendarId !== connection.calendarId || selected.nativeCalendar.version !== connection.version)) throw new ConvexError('Review the selected calendar on the connected iPhone before approving.')
    let destination: string, delivery: Awaited<ReturnType<typeof pickupDelivery>> | undefined, gmail: Awaited<ReturnType<typeof pickupMailChoice>> = null
    if (payload.kind === 'pickup') {
      const earlierMail = await pendingPickupMail(ctx, a!._id, subject)
      if (earlierMail && !earlierMail.reminder) {
        const request = await ctx.db.get(earlierMail.requestId)
        if (request && ['prepared', 'waiting'].includes(request.status)) throw new ConvexError('The earlier request email is unconfirmed. Check its result before approving another request.')
      }
      if (await confirmedPickupConflict(ctx, household._id, payload as Parameters<typeof confirmedPickupConflict>[2])) throw new ConvexError('A confirmed arrangement overlaps this pickup. Review the family plan before sending another request.')
      const active = await ctx.db.query('actions').withIndex('by_household', q => q.eq('householdId', household._id)).collect()
      const pickupAt = instant(payload.date, payload.time!, payload.timezone).epochMilliseconds
      for (const request of await ctx.db.query('pickupRequests').withIndex('by_household', q => q.eq('householdId', household._id)).collect()) {
        if (request.emailTransport !== 'gmail' || request.mailVerifiedAt || !request.attemptId || !['prepared', 'waiting'].includes(request.status) || request.payload?.kind !== 'pickup' || request.payload.childId !== payload.childId) continue
        const attempt = await ctx.db.get(request.attemptId)
        if (attempt?.dispatched && Math.abs(instant(request.payload.date, request.payload.time, request.payload.timezone).epochMilliseconds - pickupAt) < 30 * 60_000) throw new ConvexError('An earlier request email for this pickup is unconfirmed. Check its result before contacting another caregiver.')
      }
      if (active.some(other => other._id !== a!._id && other.payload.kind === 'pickup' && other.payload.childId === payload.childId && ['queued', 'executing', 'waiting', 'uncertain'].includes(other.status) && Math.abs(instant(other.payload.date, other.payload.time, other.payload.timezone).epochMilliseconds - pickupAt) < 30 * 60_000)) throw new ConvexError('There is already an active or unconfirmed request for this pickup. Resolve it before contacting another caregiver.')
      const facts = await ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', household._id)).collect()
      const confirmed = facts.filter(f => f.confirmed).flatMap(f => { const parsed = familyFactSchema.safeParse(f.value); return parsed.success ? [parsed.data] : [] })
      if (availabilityAt(confirmed, payload.caregiverId!, payload.date, payload.time!, payload.timezone, household.timezone) === 'busy') throw new ConvexError('This caregiver is explicitly unavailable. Choose another option.')
      const id = ctx.db.normalizeId('caregivers', payload.caregiverId!), caregiver = id && await ctx.db.get(id)
      if (!caregiver || caregiver.householdId !== household._id || !caregiver.childIds.includes(payload.childId!)) throw new ConvexError('Confirm an eligible caregiver for this child.')
      delivery = await pickupDelivery(ctx, caregiver.email)
      if (delivery.channel !== (selected.deliveryChannel ?? 'email')) throw new ConvexError('The caregiver changed their delivery preference. Reopen the latest review before approving.')
      if (delivery.channel === 'email') gmail = await pickupMailChoice(ctx, household, subject, payload)
      if (gmail && (selected.pickupEmailHash !== gmail.reviewHash || gmail.selectionVersion !== (selected.selectionVersion ?? 0))) throw new ConvexError('Review the latest caregiver email and sending account before approving.')
      if (!gmail && selected.pickupEmailHash) throw new ConvexError('The caregiver sending account changed. Review the request again.')
      if (delivery.channel === 'email' && !gmail && (!process.env.RESEND_API_KEY || !process.env.DAYMARK_EMAIL_FROM || !process.env.DAYMARK_WEB_URL)) throw new ConvexError('Caregiver email is not configured. Nothing has been sent.')
      destination = caregiver.email
    } else {
      if (!connection || connection.householdId !== household._id || !canUse(connection, payload.kind)) throw new ConvexError(`Connect a ${payload.kind === 'calendar' ? 'calendar' : 'sending account'} before approving.`)
      destination = payload.kind === 'calendar' ? connection.calendarId! : payload.to
      if (payload.kind === 'calendar' && a!.before && (a!.before.owner !== subject || a!.before.calendarId !== connection.calendarId || (a!.before.connectionId && a!.before.connectionId !== connection._id) || (a!.before.provider ?? 'google') !== providerOf(connection))) throw new ConvexError('Reconnect the original account to change this event.')
    }
    if (payload.kind !== 'calendar' && process.env.DAYMARK_ENVIRONMENT !== 'production' && !(process.env.DAYMARK_TEST_EMAIL_RECIPIENTS ?? '').split(',').map(e => e.trim().toLowerCase()).includes(destination.toLowerCase())) throw new ConvexError('Only allowlisted dedicated test email recipients can be contacted in this environment.')
    const { tool } = resolveApprovedTool(payload, payload.kind === 'pickup' ? { deliveryChannel: delivery!.channel, ...(gmail ? { provider: 'google', emailTransport: 'gmail' } : {}) } : { provider: providerOf(connection!) })
    const approvalId = await ctx.db.insert('approvals', { toolName: tool.name, toolVersion: tool.version, ...(Number.isFinite(args.reviewMs) ? { reviewMs: Math.round(Math.max(0, Math.min(args.reviewMs!, 1800000))) } : {}), householdId: household._id, actionId: a!._id, revision: a!.revision, sourceRevision: source.revision, payloadHash: payloadHash(payload), subject, destination, expiresAt: payload.kind === 'pickup' ? Date.parse(payload.deadline) : Date.now() + 24 * 3600_000,
      ...(payload.kind !== 'pickup' ? { connectionId: connection!._id, connectionVersion: connection!.version, provider: providerOf(connection!), ...(connection!.nativeDeviceId ? { nativeDeviceId: connection!.nativeDeviceId } : {}), selectionVersion: chosen.version } : { deliveryChannel: delivery!.channel, ...(gmail ? { emailTransport: 'gmail' as const, verificationMethod: 'identity' as const, pickupEmail: gmail.proof, connectionId: gmail.connection._id, connectionVersion: gmail.connection.version, provider: 'google' as const, selectionVersion: gmail.selectionVersion } : {}), ...(delivery!.recipientSubject ? { recipientSubject: delivery!.recipientSubject } : {}) }) })
    await ctx.db.patch(a!._id, { status: 'queued', approvalId, error: undefined })
    if (payload.kind === 'pickup' && payload.calendarUpdate) {
      if (!connection || connection.householdId !== household._id || !canUse(connection, 'calendar') || !connection.calendarId) throw new ConvexError('Connect a calendar to approve the update after acceptance.')
      const cal = payload.calendarUpdate
      let before
      if (cal.targetId) {
        const targetId = ctx.db.normalizeId('planEvents', cal.targetId), target = targetId && await ctx.db.get(targetId)
        if (!target || target.householdId !== household._id || target.owner !== subject || target.calendarId !== connection.calendarId || (target.connectionId && target.connectionId !== connection._id) || (target.provider ?? 'google') !== providerOf(connection) || target.payload.childId !== payload.childId) throw new ConvexError('Choose this child’s event in your connected calendar.')
        before = target
      }
      // Superseded conditional work cannot outlive the pickup revision it was approved for.
      for (const old of await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', a!.jobId)).collect()) if (old.dependsOn === a!._id && old.status === 'waiting') await ctx.db.patch(old._id, { status: 'cancelled' })
      const dependent = await ctx.db.insert('actions', { householdId: household._id, jobId: a!.jobId, sourceRevision: source.revision, revision: 1, payload: cal, dependsOn: a!._id, dependencyRevision: a!.revision, status: 'waiting', ...(before ? { before } : {}) })
      const { tool: calendarTool } = resolveApprovedTool(cal, { provider: providerOf(connection) })
      const conditionalApproval = await ctx.db.insert('approvals', { toolName: calendarTool.name, toolVersion: calendarTool.version, householdId: household._id, actionId: dependent, revision: 1, sourceRevision: source.revision, payloadHash: payloadHash(cal), subject, destination: connection.calendarId, connectionId: connection._id, connectionVersion: connection.version, provider: providerOf(connection), ...(connection.nativeDeviceId ? { nativeDeviceId: connection.nativeDeviceId } : {}), selectionVersion: chosen.version, expiresAt: Date.parse(payload.deadline) + 3600_000 })
      await ctx.db.patch(dependent, { approvalId: conditionalApproval })
    }
    if (payload.kind !== 'calendar' || connection?.provider !== 'apple') await start(ctx, internal.workflows.execute, { actionId: a!._id, approvalId })
  }
} })
export const cancel = mutation({ args: { jobId: v.id('jobs') }, handler: async (ctx, { jobId }) => {
  const { household, subject } = await adult(ctx), job = await ctx.db.get(jobId)
  sameHousehold(job, household._id)
  readableJob(job, subject)
  if (job!.scheduledFor !== undefined) { const source = await ctx.db.get(job!.sourceId); if (source) await ctx.db.patch(source._id, { expiresAt: Math.min(source.expiresAt, Date.now() + 30 * 86400_000) }) }
  await ctx.db.patch(jobId, { cancelled: true, preparing: false, scheduledFor: undefined })
  for (const a of await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', jobId)).collect()) {
    if (['review', 'failed', 'queued', 'waiting'].includes(a.status)) await ctx.db.patch(a._id, { status: 'cancelled', revisionRequest: undefined })
  }
} })
export const reconcile = mutation({ args: { actionId: v.id('actions') }, handler: async (ctx, { actionId }): Promise<void> => {
  const { household, subject } = await adult(ctx), a = await ctx.db.get(actionId)
  sameHousehold(a, household._id)
  const approval = a!.approvalId && await ctx.db.get(a!.approvalId)
  if (a!.payload.kind === 'pickup') {
    const pending = await pendingPickupMail(ctx, actionId, subject)
    if (!pending) throw new ConvexError('There is no unconfirmed caregiver email to check for this account.')
    await ctx.scheduler.runAfter(0, internal.pickupMailWorker.reconcile, pending); return
  }
  if (!approval || approval.subject !== subject) throw new ConvexError('Only the approving account can check this result.')
  if (a!.status !== 'uncertain' || a!.payload.kind !== 'calendar') throw new ConvexError('This unconfirmed email must not be resent automatically.')
  await ctx.scheduler.runAfter(0, internal.google.reconcile, { actionId })
} })
export const addDraft = mutation({ args: { jobId: v.id('jobs'), payload: v.any() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), job = await ctx.db.get(args.jobId)
  sameHousehold(job, household._id)
  readableJob(job, subject)
  if (job!.mailRoutineBindings?.length) { const problem = await routineJobIssue(ctx, job!); if (problem) throw new ConvexError(problem) }
  if(job!.voiceSessionId || job!.assistantRunId && job!.conversation)throw new ConvexError('Private assistant preparation stays private. Review the exact prepared text before sharing household work.')
  if (job!.workingContext) throw new ConvexError('Earlier private conversation stays private. Share the current details as a new request to prepare household work.')
  if (job!.mailContext) throw new ConvexError('Review the source email to prepare a reply or share household work. Private email discussion stays private.')
  if (job!.cancelled || job!.preparing) throw new ConvexError('Wait for preparation before adding a draft.')
  if (job!.scheduledFor !== undefined) throw new ConvexError('This request is scheduled. Wait for preparation, or cancel it and start a new request.')
  const source = await ctx.db.get(job!.sourceId), payload = payloadSchema.parse(args.payload)
  if (!source || payload.kind === 'calendar' && payload.targetId) throw new ConvexError('Add a new draft, then choose an existing event in review.')
  const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job!._id)).collect()
  if (actions.filter(a => a.status !== 'cancelled').length >= 8) throw new ConvexError('This request already has eight actions.')
  await ctx.db.patch(job!._id, { conversation: undefined, emailPreparationFailed: undefined, emailQuiet: undefined, emailTriage: undefined, emailHandling: undefined, emailSnoozedUntil: undefined, emailHandlingVersion: (job!.emailHandlingVersion ?? 0) + 1, emailReviewRequested: job!.emailWatchId ? true : undefined })
  return ctx.db.insert('actions', { householdId: household._id, jobId: job!._id, sourceRevision: source.revision, revision: 1, payload, status: 'review' })
} })
export const calendarRefreshContext = query({ args: { actionId: v.id('actions') }, handler: async (ctx, { actionId }) => {
  const { household, subject } = await adult(ctx), a = await ctx.db.get(actionId)
  sameHousehold(a, household._id)
  if (a!.status !== 'review' || a!.revisionRequest || a!.payload.kind !== 'calendar' || !a!.before || a!.before.owner !== subject) throw new ConvexError('This calendar change is unavailable for refresh.')
  const { connection: c } = await selection(ctx, subject, 'calendar')
  if (!c || !canUse(c, 'calendar') || c.calendarId !== a!.before.calendarId || (a!.before.connectionId && a!.before.connectionId !== c._id) || (a!.before.provider ?? 'google') !== providerOf(c)) throw new ConvexError('Reconnect and select the original calendar.')
  return { actionId, revision: a!.revision, payload: a!.payload, connectionId: c._id, connectionVersion: c.version, provider: providerOf(c), eventId: a!.before.eventId, calendarId: a!.before.calendarId, timezone: a!.payload.timezone }
} })
export const refreshedBefore = internalMutation({ args: { actionId: v.id('actions'), revision: v.number(), payload: v.any(), etag: v.string() }, handler: async (ctx, args) => {
  const a = await ctx.db.get(args.actionId)
  if (!a || a.revision !== args.revision || a.status !== 'review' || !a.before) return
  await ctx.db.patch(a._id, { before: { ...a.before, payload: payloadSchema.parse(args.payload), etag: args.etag }, revision: a.revision + 1, approvalId: undefined, error: 'Current calendar details loaded. Review the old and proposed values before approving.' })
} })
