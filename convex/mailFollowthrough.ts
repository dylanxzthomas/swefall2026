import { gmailReplySubject } from '../shared/gmailReply'
import { start as startWorkflow } from '@convex-dev/workflow'
import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult } from './access'
import { mailboxIssue } from './mailbox'
import { activeRoutineSnapshots, availableRoutineMessages, validRoutineSnapshots, routineBinding, routineBindingsIssue, routineMessageKey } from './mailRoutines'
import { mailProposalInput, mailSourceReference } from './schema'
import { modelHouseholdContext } from './modelContext'
import { sourceHash } from '../shared/daymark'
import { exactSender } from '../shared/emailWatches'
import { privateReplySchema } from '../shared/mailbox'
import { checkedMailProposal, mailAgentLimits, validateMailAgentStep, type PrivateMailProposal } from '../shared/mailFollowthrough'
import { jobStatus, jobTitle } from '../shared/assistant'
import type { ActionStatus } from '../shared/daymark'

type ReadCtx = Pick<QueryCtx, 'db'>
type Agent = Doc<'mailAgents'>
const identity = { id: v.id('mailAgents'), version: v.number() }
const leased = { ...identity, lease: v.string() }
const proposalIdentity = { id: v.id('mailProposals'), version: v.number() }

async function saveReviewedTask(ctx: MutationCtx, p: Doc<'mailProposals'>, done: boolean) {
  return ctx.runMutation(internal.privateTasks.keep, { householdId: p.householdId, subject: p.createdBy, key: `${p._id}_${p.version}:0`, title: p.input.title, text: [p.input.details, p.input.dueDate && `Due: ${p.input.dueDate}`, p.input.question && `Still needed: ${p.input.question}`].filter(Boolean).join('\n') || p.input.title, done })
}
/** Preserve earlier explicit keeps before replacing or erasing their source-bound review. */
export async function retainReviewedTask(ctx: MutationCtx, p: Doc<'mailProposals'>) {
  if (p.privateTaskId || p.input.kind !== 'task' || !['kept', 'done'].includes(p.status)) return p.privateTaskId
  const household = await ctx.db.get(p.householdId), membership = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', p.createdBy)).unique()
  if (!household || household.deleted || membership?.householdId !== p.householdId) return
  const privateTaskId = await saveReviewedTask(ctx, p, p.status === 'done')
  await ctx.db.patch(p._id, { privateTaskId })
  return privateTaskId
}

/** Never expose connection documents, token envelopes, other adults' records or raw DB objects to a model. */
async function familyContext(ctx: ReadCtx, householdId: Id<'households'>, subject: string) {
  const household = await ctx.db.get(householdId), context = await modelHouseholdContext(ctx, householdId, subject)
  return { household: household ? { name: household.name, timezone: household.timezone, children: household.children } : null,
    facts: context.facts.slice(0, 12).map(f => ({ key: f.key, value: f.value, version: f.version })),
    savedEvents: context.plan.slice(0, 10).map(e => ({ id: e._id, payload: e.payload, etag: e.etag })), coverage: { ...context.modelCoverage, description: 'Up to 12 confirmed facts and 10 saved events. Not a complete external calendar or proof of availability.' } }
}
const workHashPrefix = 'mail-work-v1:'
type HashCache = { hashes: Map<string, Promise<string>>; work: Map<string, ReturnType<typeof readSavedWork>>; family: Map<string, ReturnType<typeof familyContext>> }
const hashCache = (): HashCache => ({ hashes: new Map(), work: new Map(), family: new Map() })
const verifiedOutcomes = new Set(['calendar_read_back_verified', 'calendar_deletion_verified', 'apple_calendar_readback', 'apple_calendar_deleted', 'gmail_accepted', 'microsoft_accepted', 'request_available_in_app', 'request_email_accepted', 'caregiver_accepted_not_pickup_completed'])
/** Current app records, not inferred completion. Private records never cross adult boundaries.
 * Bind versions plus full content hashes even when model-visible wording is truncated. */
async function readSavedWork(ctx: ReadCtx, householdId: Id<'households'>, subject: string) {
  const limit = mailAgentLimits.savedWork
  const [taskRows, privateTasks, jobRows] = await Promise.all([
    ctx.db.query('personalTasks').withIndex('by_household', q => q.eq('householdId', householdId)).order('desc').take(limit.taskScan + 1),
    ctx.db.query('privateTasks').withIndex('by_owner', q => q.eq('householdId', householdId).eq('createdBy', subject).eq('removed', false)).order('desc').take(limit.privateTasks + 1),
    ctx.db.query('jobs').withIndex('by_creator', q => q.eq('householdId', householdId).eq('createdBy', subject)).order('desc').take(limit.requestScan + 1),
  ])
  const tasks = taskRows.slice(0, limit.taskScan).filter(t => !t.removed)
  const jobs = jobRows.slice(0, limit.requestScan).filter(j => !j.assistantQuiet && !j.emailQuiet && !j.conversation && !j.emailHandling)
  const requests = []
  let incompleteActions = false
  const omittedRequestIds: Id<'jobs'>[] = []
  // Retain one extra candidate so excluding the originating check can still supply 15 requests.
  for (const job of jobs) {
    if (requests.length >= limit.requests + 1) break
    // Do not recursively validate assistant/mail summaries while constructing their
    // saved-work snapshot. Unvalidated connector-derived work is omitted instead.
    if (job.mailContext || job.workingContext || job.emailWatchId || job.voiceSessionId || job.mailRoutineBindings?.length) { omittedRequestIds.push(job._id); continue }
    if (job.assistantRunId) {
      const run = await ctx.db.get(job.assistantRunId)
      if (!run || run.householdId !== householdId || run.createdBy !== subject || run.privateOnly || run.calendarTriggered || run.mailContext || run.workingContext || run.contextBindings?.some(b => b.mailContext || b.workingContext) || run.refs.some(ref => !ref || !['source', 'family'].includes(ref.kind))) { omittedRequestIds.push(job._id); continue }
    }
    const source = await ctx.db.get(job.sourceId)
    if (!source || source.householdId !== householdId || source.expiresAt <= Date.now()) continue
    if (source.email) { omittedRequestIds.push(job._id); continue }
    const rows = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).take(limit.actions + 1)
    const actions = rows.slice(0, limit.actions).filter(a => a.householdId === householdId && a.sourceRevision === source.revision)
    incompleteActions ||= rows.length > limit.actions
    const states = await Promise.all(actions.map(async action => {
      const receiptRows = await ctx.db.query('receipts').withIndex('by_action', q => q.eq('actionId', action._id)).order('desc').take(9)
      const receipts = receiptRows.slice(0, 8).filter(r => r.householdId === householdId && r.revision === action.revision && verifiedOutcomes.has(r.outcome))
      const payload = action.payload ?? {}, details: Record<string, string> = {}
      for (const key of ['title', 'subject', 'date', 'startTime', 'endDate', 'endTime', 'time', 'timezone', 'location', 'childId']) if (typeof payload[key] === 'string') details[key] = payload[key].slice(0, limit.textChars)
      return { id: action._id, revision: action.revision, kind: ['calendar', 'email', 'pickup'].includes(payload.kind) ? payload.kind as string : 'unknown', status: action.status, revising: !!action.revisionRequest, details,
        contentHash: sourceHash(JSON.stringify([payload, action.revisionRequest])), outcomesLimited: receiptRows.length > 8 || receipts.length > 4, verifiedOutcomes: receipts.slice(0, 4).map(r => ({ outcome: r.outcome, verifiedAt: r.verifiedAt })) }
    }))
    const typedActions = actions.map(a => ({ ...a, status: a.status as ActionStatus }))
    requests.push({ id: job._id, version: source.revision, title: jobTitle({ ...job, source, actions: typedActions }), text: (source.text ?? '').slice(0, limit.requestChars), textTruncated: (source.text?.length ?? 0) > limit.requestChars,
      contentHash: sourceHash(JSON.stringify([source.text, job.clarification])), recordedStatus: jobStatus({ ...job, actions: typedActions }), preparing: job.preparing, cancelled: job.cancelled, preparationFailed: !!job.emailPreparationFailed, scheduledFor: job.scheduledFor,
      question: job.clarification.slice(0, limit.textChars), createdAt: job._creationTime, actions: states, actionsLimited: rows.length > limit.actions })
  }
  const limits = { tasks: taskRows.length > limit.taskScan || tasks.length > limit.tasks, privateTasks: privateTasks.length > limit.privateTasks, requests: jobRows.length > limit.requestScan || jobs.length > limit.requests || omittedRequestIds.length > 0, actions: incompleteActions }
  return {
    requestCandidates: jobs.map(j => j._id), omittedRequestIds, requestScanLimited: jobRows.length > limit.requestScan,
    householdTasks: tasks.slice(0, limit.tasks).map(t => ({ id: t._id, version: t.version, title: t.title, text: t.notes.slice(0, limit.textChars), textTruncated: t.notes.length > limit.textChars, contentHash: sourceHash(t.notes), dueDate: t.dueDate, childId: t.childId, done: t.done, updatedAt: t.updatedAt })),
    privateTasks: privateTasks.slice(0, limit.privateTasks).map(t => ({ id: t._id, version: t.version, title: t.title, text: t.text.slice(0, limit.textChars), textTruncated: t.text.length > limit.textChars, contentHash: sourceHash(t.text), done: t.done, updatedAt: t.updatedAt })), requests,
    coverage: { limited: Object.values(limits).some(Boolean), limits, description: `Up to ${limit.tasks} shared household tasks from ${limit.taskScan} recent records, ${limit.privateTasks} of your private tasks, and ${limit.requests} non-chat requests from ${limit.requestScan} recent records you created (${limit.actions} actions each; up to 4 current-revision outcomes from 8 recent receipt records per action). Wording may be truncated; older, removed, hidden, expired and other adults' private records are absent. Connector/private-derived requests whose access is not revalidated here are omitted. Missing records do not establish absence. Task completion is the parent's recorded report; request status is app state. Only listed verified outcomes establish their specific provider result, never real-world completion.` },
  }
}
async function savedWork(ctx: ReadCtx, householdId: Id<'households'>, subject: string, excludeJobId?: Id<'jobs'>, cache?: HashCache) {
  const key = `${householdId}:${subject}`
  let pending = cache?.work.get(key)
  if (!pending) { pending = readSavedWork(ctx, householdId, subject); cache?.work.set(key, pending) }
  const { requestCandidates, omittedRequestIds, requestScanLimited, ...work } = await pending
  const requests = work.requests.filter(j => j.id !== excludeJobId).slice(0, mailAgentLimits.savedWork.requests)
  const limits = { ...work.coverage.limits, requests: requestScanLimited || requestCandidates.filter(id => id !== excludeJobId).length > mailAgentLimits.savedWork.requests || omittedRequestIds.some(id => id !== excludeJobId), actions: requests.some(j => j.actionsLimited || j.actions.some(a => a.outcomesLimited)) }
  return { ...work, requests, coverage: { ...work.coverage, limits, limited: Object.values(limits).some(Boolean) } }
}
async function currentFamilyHash(ctx: ReadCtx, owner: Pick<Agent, 'householdId' | 'createdBy' | 'runId'>, enhanced: boolean, cache?: HashCache) {
  const run = enhanced ? await ctx.db.get(owner.runId) : null
  const excludeJobId = run?.householdId === owner.householdId && run.createdBy === owner.createdBy ? run.agentJobId : undefined
  const key = `${enhanced ? 'work' : 'legacy'}:${owner.householdId}:${owner.createdBy}:${excludeJobId ?? ''}`
  let pending = cache?.hashes.get(key)
  if (!pending) {
    pending = (async () => {
      const ownerKey = `${owner.householdId}:${owner.createdBy}`
      let contextRead = cache?.family.get(ownerKey)
      if (!contextRead) { contextRead = familyContext(ctx, owner.householdId, owner.createdBy); cache?.family.set(ownerKey, contextRead) }
      const context = await contextRead
      return (enhanced ? workHashPrefix : '') + sourceHash(JSON.stringify(enhanced ? { ...context, savedWork: await savedWork(ctx, owner.householdId, owner.createdBy, excludeJobId, cache) } : context))
    })()
    cache?.hashes.set(key, pending)
  }
  return pending
}
async function validSources(ctx: ReadCtx, mailbox: Doc<'mailboxes'>, refs: Agent['sources']) {
  if (!refs.length || refs.length > mailAgentLimits.messages || new Set(refs.map(s => s.id)).size !== refs.length) return null
  const messages = await Promise.all(refs.map(s => ctx.db.get(s.id)))
  if (messages.some((m, i) => !m || m.householdId !== mailbox.householdId || m.createdBy !== mailbox.createdBy || m.mailboxId !== mailbox._id || m.connectionId !== mailbox.connectionId || m.connectionVersion !== mailbox.connectionVersion || m.accountKey !== mailbox.accountKey || m.expiresAt <= Date.now() || m.dismissed || m.version !== refs[i].version || m.contentHash !== refs[i].hash)) return null
  return messages as Doc<'mailMessages'>[]
}
async function agentContext(ctx: ReadCtx, agent: Agent, hashes?: HashCache) {
  const mailbox = await ctx.db.get(agent.mailboxId), run = await ctx.db.get(agent.runId)
  if (!mailbox || !run || run.version !== agent.runVersion || !['complete', 'partial'].includes(run.status) || run.expiresAt <= Date.now() || run.mailboxVersion !== mailbox.version || await mailboxIssue(ctx, mailbox)) return null
  const messages = await validSources(ctx, mailbox, agent.sources)
  if (!messages || !await validRoutineSnapshots(ctx, mailbox, agent.routines ?? [])) return null
  if (agent.familyHash && agent.familyHash !== await currentFamilyHash(ctx, agent, agent.familyHash.startsWith(workHashPrefix), hashes)) return null
  return { mailbox, run, messages }
}
/** A task-aware summary is current only while the exact work its model read is current. */
export async function validFollowthroughSummary(ctx: ReadCtx, run: Doc<'mailRuns'>, hashes?: HashCache, knownAgent?: Agent | null) {
  const agent = knownAgent === undefined ? await ctx.db.query('mailAgents').withIndex('by_run', q => q.eq('runId', run._id).eq('runVersion', run.version)).unique() : knownAgent
  if (agent && (agent.runId !== run._id || agent.runVersion !== run.version)) return false
  if (!agent?.familyHash?.startsWith(workHashPrefix)) return true // Preserve the legacy source-only contract.
  return agent.householdId === run.householdId && agent.createdBy === run.createdBy && agent.status === 'complete' && agent.expiresAt > Date.now() && !!await agentContext(ctx, agent, hashes)
}
/** Share only raw reads from this query snapshot, never an across-request private cache. */
export function followthroughSummaryReads(ctx: ReadCtx) {
  const hashes = hashCache()
  return (run: Doc<'mailRuns'>, agent?: Agent | null) => validFollowthroughSummary(ctx, run, hashes, agent)
}
/** Both the displayed control and the mutation use the current access/source gate. */
export async function retryEligible(ctx: ReadCtx, agent: Agent) {
  return agent.status === 'failed' && agent.attempts < mailAgentLimits.attempts && agent.step < mailAgentLimits.steps && agent.expiresAt > Date.now() && !!await agentContext(ctx, agent)
}
export const retry = mutation({ args: { runId: v.id('mailRuns'), runVersion: v.number(), agentVersion: v.number() }, handler: async (ctx, args): Promise<number> => {
  const { household, subject } = await adult(ctx)
  const run = await ctx.db.get(args.runId)
  if (!run || run.householdId !== household._id || run.createdBy !== subject) throw new ConvexError('Private preparation is unavailable.')
  const agent = await ctx.db.query('mailAgents').withIndex('by_run', q => q.eq('runId', run._id).eq('runVersion', args.runVersion)).unique()
  if (!agent || run.version !== args.runVersion || agent.householdId !== household._id || agent.createdBy !== subject) throw new ConvexError('This preparation changed. Check Gmail again.')
  // Coalesce double taps and transport retries without starting another model call.
  if (agent.retryOfVersion === args.agentVersion && ['queued', 'running', 'complete'].includes(agent.status) && await agentContext(ctx, agent)) return agent.version
  if (agent.version !== args.agentVersion || !await retryEligible(ctx, agent)) throw new ConvexError('This preparation or its access changed, or reached its limit. Check Gmail again.')
  const version = agent.version + 1
  // Preserve observations, used tools and ALL call/step budgets across manual retry.
  await ctx.db.patch(agent._id, { version, status: 'queued', retryOfVersion: args.agentVersion, issue: undefined, lease: undefined, leaseUntil: undefined })
  await ctx.scheduler.runAfter(Math.max(0, (agent.retryAfter ?? 0) - Date.now()), internal.mailAgent.step, { id: agent._id, version })
  return version
} })
async function held(ctx: ReadCtx, args: { id: Id<'mailAgents'>; version: number; lease: string }) {
  const agent = await ctx.db.get(args.id)
  return agent && agent.version === args.version && agent.status === 'running' && agent.lease === args.lease && (agent.leaseUntil ?? 0) > Date.now() && await agentContext(ctx, agent) ? agent : null
}
const ref = (m: Doc<'mailMessages'>) => ({ id: m._id, version: m.version, hash: m.contentHash })
const modelMessage = (m: Doc<'mailMessages'>) => ({ id: m._id, sender: m.sender, subject: m.subject, receivedAt: m.receivedAt, text: m.text.slice(0, mailAgentLimits.bodyChars), extraction: m.extraction, textTruncated: m.text.length > mailAgentLimits.bodyChars })
const proposalKey = (m: Doc<'mailMessages'>, kind: string) => sourceHash(JSON.stringify([m.accountKey, m.threadId || m.providerId, kind]))

export const start = internalMutation({ args: { runId: v.id('mailRuns'), runVersion: v.number(), sources: v.array(mailSourceReference) }, handler: async (ctx, args): Promise<Id<'mailAgents'> | null> => {
  const existing = await ctx.db.query('mailAgents').withIndex('by_run', q => q.eq('runId', args.runId).eq('runVersion', args.runVersion)).unique()
  if (existing) return existing._id
  const run = await ctx.db.get(args.runId), mailbox = run ? await ctx.db.get(run.mailboxId) : null
  if (!run || !mailbox || run.version !== args.runVersion || !['complete', 'partial'].includes(run.status) || run.expiresAt <= Date.now() || mailbox.version !== run.mailboxVersion || await mailboxIssue(ctx, mailbox)) return null
  const messages = await validSources(ctx, mailbox, args.sources)
  if (!messages) return null
  const routines = await activeRoutineSnapshots(ctx, mailbox)
  const id = await ctx.db.insert('mailAgents', { routines, householdId: run.householdId, createdBy: run.createdBy, mailboxId: run.mailboxId, runId: run._id, runVersion: run.version, sources: args.sources, version: 1, status: 'queued', step: 0, attempts: 0, used: [], observations: '[]', createdAt: Date.now(), expiresAt: Math.min(run.expiresAt, ...messages.map(m => m.expiresAt)) })
  await ctx.scheduler.runAfter(0, internal.mailAgent.step, { id, version: 1 })
  return id
} })
export const claim = internalMutation({ args: leased, handler: async (ctx, args) => {
  const agent = await ctx.db.get(args.id)
  if (!agent || agent.version !== args.version || !['queued', 'running'].includes(agent.status) || (agent.leaseUntil ?? 0) > Date.now() || (agent.retryAfter ?? 0) > Date.now()) return null
  const current = await agentContext(ctx, agent)
  if (!current || agent.expiresAt <= Date.now()) { await ctx.db.patch(agent._id, { status: 'cancelled', issue: 'Source or access changed. Check Gmail again.', lease: undefined, leaseUntil: undefined }); return null }
  if (agent.attempts >= mailAgentLimits.attempts || agent.step >= mailAgentLimits.steps) { await ctx.db.patch(agent._id, { status: 'failed', issue: 'Preparation reached its limit. Check Gmail again to try fresh sources.' }); return null }
  // Always bind current saved work before a model call, even when it chooses no read tool.
  // Older preparations keep their original hash contract until their next valid claim.
  const work = await savedWork(ctx, agent.householdId, agent.createdBy, current.run.agentJobId)
  const familyHash = workHashPrefix + sourceHash(JSON.stringify({ ...await familyContext(ctx, agent.householdId, agent.createdBy), savedWork: work }))
  await ctx.db.patch(agent._id, { familyHash, status: 'running', attempts: agent.attempts + 1, lease: args.lease, leaseUntil: Date.now() + mailAgentLimits.leaseMs })
  await ctx.scheduler.runAfter(mailAgentLimits.leaseMs + 1000, internal.mailFollowthrough.recover, { id: agent._id })
  const previous = (await ctx.db.query('mailProposals').withIndex('by_mailbox', q => q.eq('mailboxId', agent.mailboxId)).order('desc').take(60)).filter(p => p.expiresAt > Date.now())
  const priorFollowups = await Promise.all(previous.map(async p => {
    const task = p.privateTaskId ? await ctx.db.get(p.privateTaskId) : null
    const ownTask = task?.householdId === agent.householdId && task.createdBy === agent.createdBy ? task : null
    return { messageId: p.input.messageId, kind: p.input.kind, title: p.privateTaskId ? ownTask && !ownTask.removed ? ownTask.title : '' : p.input.title,
      status: p.privateTaskId ? !ownTask || ownTask.removed ? 'removed' : ownTask.done ? 'done' : 'kept' : p.status,
      ...(ownTask ? { savedTaskId: ownTask._id, savedTaskVersion: ownTask.version } : {}), sourceChanged: p.sources.some(s => !agent.sources.some(a => a.id === s.id && a.version === s.version && a.hash === s.hash)) }
  }))
  return { request: current.run.request, savedWork: work, now: new Date().toISOString(), step: agent.step + 1, remainingSteps: mailAgentLimits.steps - agent.step,
    coverage: `${current.run.status === 'partial' ? 'Partial' : 'Finished'} scan; ${current.run.scanned} read attempts; ${current.messages.length} selected saved messages. Attachments, linked pages and external calendars were not read.`,
    routines: await availableRoutineMessages(ctx, agent.routines ?? [], current.messages),
    messages: current.messages.map(modelMessage), used: agent.used, observations: JSON.parse(agent.observations) as unknown,
    priorFollowups }
} })
export const advance = internalMutation({ args: { ...leased, result: v.string() }, handler: async (ctx, args): Promise<boolean> => {
  const agent = await held(ctx, args)
  if (!agent) return false
  const current = (await agentContext(ctx, agent))!
  if (args.result.length > 50_000) throw new ConvexError('Preparation output exceeded its limit.')
  const routines = await availableRoutineMessages(ctx, agent.routines ?? [], current.messages)
  const step = validateMailAgentStep(JSON.parse(args.result), current.messages.map(modelMessage), agent.used, routines)
  if (step.tool !== 'finish') {
    if (agent.step + 1 >= mailAgentLimits.steps) throw new ConvexError('Finish within the preparation limit.')
    let data: unknown, sources = agent.sources, familyHash = agent.familyHash
    if (step.tool === 'family_context') { data = { ...await familyContext(ctx, agent.householdId, agent.createdBy), savedWork: await savedWork(ctx, agent.householdId, agent.createdBy, current.run.agentJobId) }; familyHash = workHashPrefix + sourceHash(JSON.stringify(data)) }
    else {
      const message = current.messages.find(m => m._id === step.messageId)!
      const candidates = message.threadId ? await ctx.db.query('mailMessages').withIndex('by_thread', q => q.eq('householdId', agent.householdId).eq('createdBy', agent.createdBy).eq('accountKey', current.mailbox.accountKey).eq('threadId', message.threadId)).order('desc').take(20) : [message]
      const eligible = candidates.filter(m => m.mailboxId === agent.mailboxId && m.connectionVersion === current.mailbox.connectionVersion && m.connectionId === current.mailbox.connectionId && !m.dismissed && m.expiresAt > Date.now() && !m.labels.some(l => ['SPAM', 'TRASH', 'DRAFT'].includes(l)))
      const combined = [...current.messages, ...eligible.filter(m => !current.messages.some(old => old._id === m._id))].slice(0, mailAgentLimits.messages)
      sources = combined.map(ref)
      data = { messages: eligible.filter(m => combined.some(c => c._id === m._id)).map(modelMessage), coverage: 'Saved thread messages only; unread or expired mail may be missing.' }
    }
    const observations = [...JSON.parse(agent.observations), { tool: step.tool, messageId: step.messageId, result: data }]
    const version = agent.version + 1
    await ctx.db.patch(agent._id, { sources, familyHash, observations: JSON.stringify(observations), expiresAt: Math.min(agent.expiresAt, ...(await validSources(ctx, current.mailbox, sources))!.map(m => m.expiresAt)), used: [...agent.used, `${step.tool}:${step.messageId}`], step: agent.step + 1, version, status: 'queued', lease: undefined, leaseUntil: undefined })
    await ctx.scheduler.runAfter(0, internal.mailAgent.step, { id: agent._id, version })
    return true
  }
  const proposedKeys = new Set<string>(), prepared = new Map<string, Id<'mailProposals'>[]>()
  for (const input of step.proposals) {
    const primary = current.messages.find(m => m._id === input.messageId)!, key = proposalKey(primary, input.kind)
    // Newer saved thread context supersedes older preparation, even if omitted by model.
    if (await newerThread(ctx, primary)) throw new ConvexError('A newer thread message needs review.')
    if (proposedKeys.has(key)) throw new ConvexError('Combine related follow-ups in one thread.')
    proposedKeys.add(key)
    const old = await ctx.db.query('mailProposals').withIndex('by_key', q => q.eq('mailboxId', agent.mailboxId).eq('key', key)).unique()
    const primaryRef = agent.sources.find(s => s.id === primary._id)!
    const samePrimary = old?.sources.some(s => s.id === primaryRef.id && s.version === primaryRef.version && s.hash === primaryRef.hash)
    // A fresh secondary source can repair unaccepted review work, but never
    // reopen an explicit decision or erase a paused/changed routine's origin.
    if (old && samePrimary && (old.privateTaskId || ['kept', 'done', 'dismissed', 'snoozed'].includes(old.status) || await routineBindingsIssue(ctx, old.mailRoutineBindings))) continue
    const mailRoutineBindings = samePrimary ? [...(old?.mailRoutineBindings ?? [])] : []
    for (const ref of input.routineRefs ?? []) if (!mailRoutineBindings.some(b => b.routineId === ref.id)) mailRoutineBindings.push(routineBinding(agent.routines!.find(r => r.id === ref.id && r.version === ref.version)!, current.mailbox, primary))
    // Durable deduplication intentionally omits earlier routine decisions from
    // later model inputs. Their still-valid provenance must survive refresh.
    const reviewedInput = mailRoutineBindings.length ? checkedMailProposal({ ...input, routineRefs: mailRoutineBindings.map(b => ({ id: b.routineId, version: b.routineVersion })) }) : input
    if (old && samePrimary && old.familyHash === agent.familyHash && old.expiresAt > Date.now() && JSON.stringify(old.input.routineRefs ?? []) === JSON.stringify(reviewedInput.routineRefs ?? []) && !await proposalStale(ctx, old)) continue
    const fields = { mailRoutineBindings, householdId: agent.householdId, createdBy: agent.createdBy, mailboxId: agent.mailboxId, runId: agent.runId, sources: agent.sources, familyHash: agent.familyHash, key, input: reviewedInput, status: 'review' as const, snoozedUntil: undefined, draftId: undefined, sharedJobId: undefined, sharedHash: undefined, privateTaskId: undefined, expiresAt: agent.expiresAt }
    let proposalId: Id<'mailProposals'>
    if (old) { await retainReviewedTask(ctx, old); await ctx.db.patch(old._id, { ...fields, version: old.version + 1 }); proposalId = old._id }
    else proposalId = await ctx.db.insert('mailProposals', { ...fields, version: 1, createdAt: Date.now() })
    for (const r of reviewedInput.routineRefs ?? []) { const decisionKey = `${r.id}:${primary._id}`; prepared.set(decisionKey, [...(prepared.get(decisionKey) ?? []), proposalId]) }
  }
  // A source-backed fresh pass can quietly retract unaccepted obsolete proposals.
  for (const message of current.messages) for (const kind of ['task', 'calendar', 'reply']) {
    const key = proposalKey(message, kind)
    if (proposedKeys.has(key)) continue
    const old = await ctx.db.query('mailProposals').withIndex('by_key', q => q.eq('mailboxId', agent.mailboxId).eq('key', key)).unique()
    if (old && ['review', 'snoozed'].includes(old.status) && sourceHash(JSON.stringify(old.sources)) !== sourceHash(JSON.stringify(agent.sources))) await ctx.db.patch(old._id, { status: 'withdrawn', version: old.version + 1 })
  }
  // One permanent content-free decision key per routine/provider message, shared by all runs.
  // Bodies and source references are cleared on expiry; the key prevents replay afterward.
  for (const r of routines) {
    for (const messageId of r.eligibleMessageIds) {
      const m = current.messages.find(m => m._id === messageId)!, proposalIds = prepared.get(`${r.id}:${m._id}`) ?? []
      await ctx.db.insert('mailRoutineDecisions', { householdId: agent.householdId, createdBy: agent.createdBy, routineId: r.id, routineVersion: r.version, key: routineMessageKey(m), decision: proposalIds.length ? 'prepared' : 'skipped', createdAt: Date.now(), mailboxId: agent.mailboxId, messageId: m._id, sourceVersion: m.version, sourceHash: m.contentHash, runId: agent.runId, proposalIds, expiresAt: Math.min(agent.expiresAt, m.expiresAt) })
    }
    const saved = (await ctx.db.get(r.id))!
    await ctx.db.patch(r.id, { decisionCount: saved.decisionCount + r.eligibleMessageIds.length, ...(r.eligibleMessageIds.some(id => prepared.has(`${r.id}:${id}`)) ? { lastPreparedAt: Date.now() } : {}) })
  }
  const summarized = await ctx.runMutation(internal.mailbox.finishSummary, { id: agent.runId, version: agent.runVersion, sources: agent.sources, answer: step.answer, evidence: step.evidence })
  if (!summarized) throw new ConvexError('The sources changed before preparation was saved.')
  await ctx.db.patch(agent._id, { status: 'complete', step: agent.step + 1, lease: undefined, leaseUntil: undefined })
  return true
} })
/** Catch inside the backend, where provider log redaction cannot hide the validation category.
 * The nested mutation rolls back all proposals if any part of the step fails. */
export const commitStep = internalMutation({ args: { ...leased, result: v.string() }, handler: async (ctx, args): Promise<{ accepted: boolean; code?: 'source_evidence' | 'proposal_fields' | 'stale_thread' | 'summary_changed' | 'backend_failure' }> => {
  try { return { accepted: await ctx.runMutation(internal.mailFollowthrough.advance, args) } }
  catch (e) {
    const message = e instanceof Error ? e.message : ''
    const code = /verified evidence|verified sources|unique, verified|supplied private source/i.test(message) ? 'source_evidence' : /valid date|valid time|timezone|missing calendar|reply text|Combine related|already used|read step|Finish within|eligible routine/i.test(message) ? 'proposal_fields' : /newer thread/i.test(message) ? 'stale_thread' : /sources changed before/i.test(message) ? 'summary_changed' : 'backend_failure'
    return { accepted: false, code }
  }
} })
async function newerThread(ctx: ReadCtx, m: Doc<'mailMessages'>) {
  if (!m.threadId) return false
  const latest = await ctx.db.query('mailMessages').withIndex('by_thread', q => q.eq('householdId', m.householdId).eq('createdBy', m.createdBy).eq('accountKey', m.accountKey).eq('threadId', m.threadId)).order('desc').first()
  return !!latest && latest._id !== m._id && latest.expiresAt > Date.now() && (latest.receivedAt > m.receivedAt || latest.receivedAt === m.receivedAt && latest._creationTime > m._creationTime)
}
/** Allow bounded model correction, without committing rejected output or treating it as evidence. */
export const repair = internalMutation({ args: { ...leased, code: v.string() }, handler: async (ctx, args) => {
  if (!['source_evidence', 'proposal_fields'].includes(args.code)) return false
  const agent = await held(ctx, args)
  if (!agent || agent.attempts >= mailAgentLimits.attempts) return false
  const feedback = args.code === 'source_evidence' ? 'Rejected: use empty top-level messageId on finish, nonempty top-level evidence, and exact literal body quotes from supplied IDs. Each proposal needs its primary source evidence; only one proposal per kind and primary message.' : 'Rejected: use valid dates, times and timezone; ask for missing calendar details; provide reply text; never repeat a tool. Combine each thread’s related responsibilities. Use only supplied active routine id/version and eligible message references.'
  const version = agent.version + 1
  await ctx.db.patch(agent._id, { version, status: 'queued', observations: JSON.stringify([...JSON.parse(agent.observations), { validationFeedback: feedback }]), lease: undefined, leaseUntil: undefined })
  await ctx.scheduler.runAfter(0, internal.mailAgent.step, { id: agent._id, version })
  return true
} })
const transientBackgroundFailure = (agent: Agent, run: Doc<'mailRuns'> | null) => !!run && !run.agentRequested && /^(poll|enable):/.test(run.requestId) && agent.failureStage === 'model' && ['rate_limit', 'unavailable'].includes(agent.failureCode ?? '')
export const failed = internalMutation({ args: { ...leased, stage: v.optional(v.union(v.literal('model'), v.literal('validation'))), code: v.optional(v.union(v.literal('grammar_limit'), v.literal('request_rejected'), v.literal('rate_limit'), v.literal('unverified_output'), v.literal('source_evidence'), v.literal('proposal_fields'), v.literal('stale_thread'), v.literal('summary_changed'), v.literal('backend_failure'), v.literal('unavailable'))) }, handler: async (ctx, args) => {
  const agent = await ctx.db.get(args.id)
  if (!agent || agent.version !== args.version || agent.lease !== args.lease || agent.status !== 'running' || (agent.leaseUntil ?? 0) <= Date.now()) return false
  const delay = args.code === 'rate_limit' ? 60_000 : Math.min(60_000, 15_000 * 2 ** Math.max(0, agent.attempts - 1))
  await ctx.db.patch(agent._id, { status: 'failed', failureStage: args.stage ?? 'model', failureCode: args.code ?? 'unavailable', issue: 'Sola couldn’t finish preparing follow-ups. Your saved emails are still available; nothing was sent or changed.', retryAfter: Date.now() + delay, lease: undefined, leaseUntil: undefined })
  const failed = { ...agent, failureStage: args.stage ?? 'model' as const, failureCode: args.code ?? 'unavailable' as const }
  if (agent.attempts < mailAgentLimits.attempts && transientBackgroundFailure(failed, await ctx.db.get(agent.runId))) await ctx.scheduler.runAfter(delay, internal.mailFollowthrough.recover, { id: agent._id })
  return true
} })
export const recover = internalMutation({ args: { id: v.id('mailAgents') }, handler: async (ctx, { id }) => {
  const agent = await ctx.db.get(id)
  if (!agent || (agent.leaseUntil ?? 0) > Date.now() || (agent.retryAfter ?? 0) > Date.now()) return
  if (agent.status === 'failed' && transientBackgroundFailure(agent, await ctx.db.get(agent.runId)) && await retryEligible(ctx, agent)) {
    const version = agent.version + 1
    await ctx.db.patch(id, { version, status: 'queued', lease: undefined, leaseUntil: undefined })
    await ctx.scheduler.runAfter(0, internal.mailAgent.step, { id, version })
  } else if (['queued', 'running'].includes(agent.status)) await ctx.scheduler.runAfter(0, internal.mailAgent.step, { id, version: agent.version })
} })
export async function proposalStale(ctx: ReadCtx, p: Doc<'mailProposals'>, hashes?: HashCache) {
  const mailbox = await ctx.db.get(p.mailboxId)
  if (!mailbox || await mailboxIssue(ctx, mailbox) || p.expiresAt <= Date.now() || await routineBindingsIssue(ctx, p.mailRoutineBindings)) return true
  const messages = await validSources(ctx, mailbox, p.sources), primary = messages?.find(m => m._id === p.input.messageId)
  return !primary || await newerThread(ctx, primary) || !!p.familyHash && p.familyHash !== await currentFamilyHash(ctx, p, p.familyHash.startsWith(workHashPrefix), hashes)
}
/** Only a validated parent keep/share may advance the hashes of its own valid siblings.
 * Capture before the effect; unrelated edits or already-stale preparation never get reblessed. */
async function preserveFamilyContext(ctx: MutationCtx, proposal: Doc<'mailProposals'>) {
  if (!proposal.familyHash?.startsWith(workHashPrefix)) return async () => {}
  const hashes = hashCache()
  const siblings = (await ctx.db.query('mailProposals').withIndex('by_owner', q => q.eq('householdId', proposal.householdId).eq('createdBy', proposal.createdBy)).order('desc').take(100)).filter(p => p.runId === proposal.runId)
  // A chosen older proposal can lie outside the bounded recent sibling window.
  if (!siblings.some(p => p._id === proposal._id)) siblings.push(proposal)
  const valid: Doc<'mailProposals'>[] = []
  for (const sibling of siblings) if (sibling.familyHash === proposal.familyHash && !await proposalStale(ctx, sibling, hashes)) valid.push(sibling)
  return async () => {
    const hash = await currentFamilyHash(ctx, proposal, true)
    for (const sibling of valid) await ctx.db.patch(sibling._id, { familyHash: hash })
    const agent = (await ctx.db.query('mailAgents').withIndex('by_run', q => q.eq('runId', proposal.runId)).take(7)).find(a => a.status === 'complete' && a.familyHash === proposal.familyHash)
    if (agent?.householdId === proposal.householdId && agent.createdBy === proposal.createdBy && agent.familyHash === proposal.familyHash) await ctx.db.patch(agent._id, { familyHash: hash })
  }
}
export const list = query({ args: {}, handler: async (ctx): Promise<PrivateMailProposal[]> => {
  const { household, subject } = await adult(ctx)
  const rows = await ctx.db.query('mailProposals').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(100)
  const result: PrivateMailProposal[] = [], hashes = hashCache()
  for (const p of rows) {
    const mailbox = await ctx.db.get(p.mailboxId)
    if (!mailbox || mailbox.state === 'removed' || p.expiresAt <= Date.now() || p.status === 'withdrawn') continue
    result.push({ ...p.input, id: p._id, runId: p.runId, version: p.version, createdAt: p.createdAt, expiresAt: p.expiresAt, status: p.status === 'snoozed' && (p.snoozedUntil ?? Infinity) <= Date.now() ? 'review' : p.status, stale: await proposalStale(ctx, p, hashes), ...(p.snoozedUntil ? { snoozedUntil: p.snoozedUntil } : {}), ...(p.privateTaskId ? { privateTaskId: p.privateTaskId } : {}) })
  }
  return result
} })
async function ownedProposal(ctx: MutationCtx, id: Id<'mailProposals'>, version: number, replayKeep = false) {
  const { household, subject } = await adult(ctx), p = await ctx.db.get(id)
  if (!p || p.householdId !== household._id || p.createdBy !== subject || p.expiresAt <= Date.now()) throw new ConvexError('This private follow-up is unavailable.')
  if (p.version !== version && !(replayKeep && p.privateTaskId)) throw new ConvexError('This follow-up changed. Reopen its current version.')
  return p
}
export const update = mutation({ args: { ...proposalIdentity, input: mailProposalInput }, handler: async (ctx, args) => {
  const p = await ownedProposal(ctx, args.id, args.version)
  if (p.privateTaskId) throw new ConvexError('Open your saved private task in Tasks to edit it.')
  if (await proposalStale(ctx, p)) throw new ConvexError('The source or connection changed. Check Gmail again.')
  const input = checkedMailProposal(args.input)
  if (input.kind !== p.input.kind || input.messageId !== p.input.messageId || JSON.stringify(input.evidence) !== JSON.stringify(p.input.evidence) || JSON.stringify(input.routineRefs ?? []) !== JSON.stringify(p.input.routineRefs ?? [])) throw new ConvexError('Keep the original source references.')
  if (!['review', 'kept', 'snoozed'].includes(p.status) || p.draftId || p.sharedJobId) throw new ConvexError('Open the existing reply or current follow-up to edit it.')
  await ctx.db.patch(p._id, { input, version: p.version + 1 })
  if (p.status === 'snoozed' && p.snoozedUntil) await ctx.scheduler.runAt(p.snoozedUntil, internal.mailFollowthrough.wake, { id: p._id, version: p.version + 1 })
  return p.version + 1
} })
export const decide = mutation({ args: { ...proposalIdentity, operation: v.union(v.literal('keep'), v.literal('done'), v.literal('reopen'), v.literal('dismiss'), v.literal('snooze')), until: v.optional(v.number()) }, handler: async (ctx, args) => {
  const p = await ownedProposal(ctx, args.id, args.version, args.operation === 'keep')
  if (p.privateTaskId) {
    if (args.operation === 'keep') return p.version // A delayed original keep never overwrites an independent task edit or removal.
    throw new ConvexError('Open your saved private task in Tasks to change or remove it.')
  }
  if (await proposalStale(ctx, p) && args.operation !== 'dismiss') throw new ConvexError('The source or connection changed. Check Gmail again.')
  let status: Doc<'mailProposals'>['status']
  if (args.operation === 'dismiss') status = 'dismissed'
  else if (args.operation === 'snooze') {
    if (!args.until || !Number.isSafeInteger(args.until) || args.until <= Date.now() || args.until >= p.expiresAt || p.status !== 'review') throw new ConvexError('Choose a later time before this source expires.')
    status = 'snoozed'
  } else {
    if (p.input.kind !== 'task') throw new ConvexError('Calendar and reply proposals need their own review; they cannot be marked completed here.')
    if (args.operation === 'keep' && !['review', 'kept', 'done'].includes(p.status) && !(p.status === 'snoozed' && (p.snoozedUntil ?? Infinity) <= Date.now()) || args.operation === 'done' && p.status !== 'kept' || args.operation === 'reopen' && !['done', 'dismissed'].includes(p.status)) throw new ConvexError('This task changed. Reopen its current status.')
    status = args.operation === 'done' || args.operation === 'keep' && p.status === 'done' ? 'done' : 'kept'
  }
  // Keep only the editable task details the parent reviewed. Email bodies,
  // quotations, account IDs and source lifetimes never enter the saved task.
  const preserveContext = ['kept', 'done'].includes(status) && p.input.kind === 'task' ? await preserveFamilyContext(ctx, p) : null
  const privateTaskId = ['kept', 'done'].includes(status) && p.input.kind === 'task'
    ? await saveReviewedTask(ctx, p, status === 'done')
    : undefined
  await ctx.db.patch(p._id, { status, version: p.version + 1, snoozedUntil: status === 'snoozed' ? args.until : undefined, ...(privateTaskId ? { privateTaskId } : {}) })
  await preserveContext?.()
  if (status === 'snoozed') await ctx.scheduler.runAt(args.until!, internal.mailFollowthrough.wake, { id: p._id, version: p.version + 1 })
  return p.version + 1
} })
/** A durable write wakes reactive subscribers even when the app was closed. Old timers are harmless. */
export const wake = internalMutation({ args: proposalIdentity, handler: async (ctx, args) => {
  const p = await ctx.db.get(args.id)
  if (!p || p.version !== args.version || p.status !== 'snoozed' || (p.snoozedUntil ?? Infinity) > Date.now() || p.expiresAt <= Date.now()) return false
  const mailbox = await ctx.db.get(p.mailboxId)
  if (!mailbox || await mailboxIssue(ctx, mailbox) || await routineBindingsIssue(ctx, p.mailRoutineBindings)) return false
  await ctx.db.patch(p._id, { status: 'review', snoozedUntil: undefined, version: p.version + 1 })
  return true
} })
/** Copies reviewed preparation into the existing private draft review, without a provider write or approval. */
export const reviewReply = mutation({ args: proposalIdentity, handler: async (ctx, args): Promise<Id<'mailDrafts'>> => {
  const p = await ownedProposal(ctx, args.id, args.version)
  if (p.input.kind !== 'reply' || p.input.question || await proposalStale(ctx, p) || p.status !== 'review') throw new ConvexError('Review current complete reply details first.')
  if (p.draftId) return p.draftId
  const message = (await ctx.db.get(p.input.messageId as Id<'mailMessages'>))!, connection = (await ctx.db.get(message.connectionId))!
  const to = exactSender(message.sender)
  if (!to || !connection.email) throw new ConvexError('The source sender is unavailable.')
  const input = privateReplySchema.parse({ to, subject: message.replyRouting?.subject ?? gmailReplySubject(message.subject), body: p.input.replyBody })
  const id = await ctx.db.insert('mailDrafts', { mailProposalBinding: { id: p._id, version: p.version + 1 }, mailRoutineBindings: p.mailRoutineBindings, householdId: p.householdId, createdBy: p.createdBy, mailboxId: p.mailboxId, messageId: message._id, sourceVersion: message.version, sourceHash: message.contentHash, connectionId: message.connectionId, connectionVersion: message.connectionVersion, accountKey: message.accountKey, accountEmail: connection.email.toLowerCase(), replyRouting: message.replyRouting, version: 1, input, instruction: 'Reviewed private follow-up', preparationKey: sourceHash(`proposal:${p._id}:${p.version}`), status: 'review', createdAt: Date.now(), expiresAt: p.expiresAt })
  await ctx.db.patch(p._id, { draftId: id, version: p.version + 1 })
  return id
} })

/** Only this exact edited preview is promoted into household preparation; sharing never approves execution. */
export const shareCalendar = mutation({ args: { ...proposalIdentity, text: v.string(), consent: v.literal(true) }, handler: async (ctx, args): Promise<Id<'jobs'>> => {
  const p = await ownedProposal(ctx, args.id, args.version), text = args.text.trim()
  if (p.input.kind !== 'calendar' || p.status !== 'review' || await proposalStale(ctx, p) || !text || text.length > 20000) throw new ConvexError('Review a current calendar proposal and the exact text to share.')
  const hash = sourceHash(text)
  if (p.sharedJobId) { if (p.sharedHash !== hash) throw new ConvexError('This proposal was already shared with different text. Open the existing request.'); return p.sharedJobId }
  const preserveContext = await preserveFamilyContext(ctx, p)
  const sourceId = await ctx.db.insert('sources', { householdId: p.householdId, text, attachmentIds: [], hash: `private-calendar:${p._id}:${p.version}:${hash}`, revision: 1, expiresAt: p.expiresAt })
  const jobId = await ctx.db.insert('jobs', { mailRoutineBindings: p.mailRoutineBindings, householdId: p.householdId, createdBy: p.createdBy, sourceId, preparing: true, cancelled: false, clarification: '' })
  await ctx.db.patch(p._id, { sharedJobId: jobId, sharedHash: hash })
  await preserveContext()
  await startWorkflow(ctx, internal.workflows.prepare, { jobId, sourceRevision: 1 })
  return jobId
} })
