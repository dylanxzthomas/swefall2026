import { gmailReplySubject } from '../shared/gmailReply'
import { validAttachmentReferences } from './mailAttachments'
import { ZodError } from 'zod'
import { calendarReadAllowed,calendarLimits } from '../shared/calendarAwareness'
import { v, ConvexError } from 'convex/values'
import { mutation, query, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult } from './access'
import { extractionSchema, sourceHash } from '../shared/daymark'
import { checkedCoordinatorStep, coordinatorLimits, type CoordinatorDraft, type CoordinatorView } from '../shared/assistantCoordinator'
import { capabilitiesFor } from './assistantContext'
import { capabilityInventory } from '../shared/capabilities'
import { modelHouseholdContext } from './modelContext'
import { mailboxIssue } from './mailbox'
import { privateReplySource } from './mailDrafts'
import { exactSender } from '../shared/emailWatches'
import { privateReplySchema } from '../shared/mailbox'
import { validMailConversation } from './mailConversation'
import { validWorkingContext } from './workingMemory'
import { recordedConversationResponse, unavailableConversationResponse, type ConversationExchange } from '../server/modelMessages'
import type { ActionStatus } from '../shared/daymark'
import { coordinatorWorkInventory, manageCoordinatorWork } from './coordinatorWork'
import type { WorkItem } from '../shared/workControl'
import { answerRequestClarification } from './requestClarifications'
import { selection } from './providerRules'
import { googleCalendarEventsScope } from '../shared/googlePermissions'
type CoordinatorInput = { source: { sourceId: string; text?: string }; assistant: ({ history?: ConversationExchange[] } & Record<string, unknown>) | null; capabilities: ReturnType<typeof capabilityInventory>; observations: unknown; used: string[]; step: number; remainingSteps: number; now: string;canPrepareNotice:boolean;canLearn:boolean;trigger:'request'|'calendar' }
type Ctx = Pick<QueryCtx, 'db'>
type Run = Doc<'assistantRuns'>
type Ref = { kind: 'source' | 'mail' | 'calendar' | 'attachment' | 'family'; id: string; version: number; hash: string;consentVersion?:number }
async function family(ctx: Ctx, run: Pick<Run, 'householdId' | 'createdBy'>) {
  const h = await ctx.db.get(run.householdId), context = await modelHouseholdContext(ctx, run.householdId, run.createdBy)
  const tasks=await ctx.db.query('personalTasks').withIndex('by_household',q=>q.eq('householdId',run.householdId)).order('desc').take(101)
  const privateTasks=await ctx.db.query('privateTasks').withIndex('by_owner',q=>q.eq('householdId',run.householdId).eq('createdBy',run.createdBy).eq('removed',false)).order('desc').take(101)
  return { household: h ? { name: h.name, timezone: h.timezone, children: h.children } : null, facts: context.facts.map(f => ({ value: f.value, version: f.version })), caregivers:context.caregivers.map(c=>({id:c._id,name:c.name,childIds:c.childIds})),personalTasks:tasks.filter(t=>!t.removed).map(t=>({id:t._id,title:t.title,done:t.done,removed:t.removed,version:t.version,dueDate:t.dueDate})), privateTasks:privateTasks.slice(0,30).map(t=>({id:t._id,title:t.title,text:t.text.slice(0,800),textTruncated:t.text.length>800,done:t.done,version:t.version})), privateTasksLimited:privateTasks.length>30, privateTaskVersions:sourceHash(JSON.stringify(privateTasks.map(t=>[t._id,t.version,t.done]))), savedEvents: context.plan.map(p => ({ payload: p.payload, etag: p.etag })), coverage: context.modelCoverage }
}
function privateContext(r:Run){return !!(r.privateOnly||r.mailContext||r.workingContext||r.contextBindings?.some(b=>b.mailContext||b.workingContext)||(r.refs as Ref[]).some(ref=>['mail','calendar','attachment'].includes(ref.kind)))}
async function refsValid(ctx: Ctx, r: Run): Promise<boolean> {
  for (const ref of r.refs as Ref[]) {
    if (ref.kind === 'family') { if (sourceHash(JSON.stringify(await family(ctx, r))) !== ref.hash) return false; continue }
    if (ref.kind === 'source') {
      const id=ctx.db.normalizeId('sources',ref.id),row=id?await ctx.db.get(id):null
      if(!row || row.householdId!==r.householdId || row.expiresAt<=Date.now() || row.revision!==ref.version || sourceHash(row.text??'')!==ref.hash)return false
    } else if(ref.kind === 'mail') {
      const id=ctx.db.normalizeId('mailMessages',ref.id),row=id?await ctx.db.get(id):null
      if(!row || row.householdId!==r.householdId || row.createdBy!==r.createdBy || row.expiresAt<=Date.now() || row.dismissed || row.version!==ref.version || row.contentHash!==ref.hash)return false
      const box=await ctx.db.get(row.mailboxId)
      if(!box || box.createdBy!==r.createdBy || await mailboxIssue(ctx,box) || row.connectionId!==box.connectionId || row.connectionVersion!==box.connectionVersion || row.accountKey!==box.accountKey)return false
    } else if(ref.kind === 'attachment') {
      const id=ctx.db.normalizeId('mailAttachments',ref.id),row=id?await ctx.db.get(id):null
      if(!row || !await validAttachmentReferences(ctx,r.householdId,r.createdBy,[{id:row._id,version:ref.version,contentHash:ref.hash,expiresAt:row.expiresAt}]))return false
    } else if(ref.kind === 'calendar') {
      const id=ctx.db.normalizeId('calendarFeeds',ref.id),row=id?await ctx.db.get(id):null
      if(!row || row.householdId!==r.householdId || row.createdBy!==r.createdBy || row.state!=='active' || row.version!==ref.version || String(row.publishedRunId)!==ref.hash || ref.consentVersion!==undefined&&(!row.assistanceEnabled||row.assistanceVersion!==ref.consentVersion))return false
      const c=await ctx.db.get(row.connectionId),snapshot=row.publishedRunId?await ctx.db.get(row.publishedRunId):null
      if(!c || c.householdId!==r.householdId || c.subject!==r.createdBy || c.status!=='active' || c.version!==row.connectionVersion || !calendarReadAllowed(c) || !snapshot || snapshot.feedVersion!==row.version || snapshot.expiresAt<=Date.now() || Date.now()-(row.lastCheckedAt??0)>calendarLimits.freshnessMs)return false
    } else return false
  }
  return true
}
export async function validAssistantRun(ctx: Ctx, job: Pick<Doc<'jobs'>, 'householdId' | 'createdBy' | 'assistantRunId'>): Promise<boolean> {
  if (!job.assistantRunId) return true
  const r = await ctx.db.get(job.assistantRunId)
  return !!r && r.householdId === job.householdId && r.createdBy === job.createdBy && await valid(ctx, r)
}
/** Capture before a verified own plan effect; invoke after it in the same mutation. */
export async function preserveNoticeContext(ctx: MutationCtx, action: Pick<Doc<'actions'>, 'jobId' | 'householdId' | 'sourceRevision'>) {
  const job = await ctx.db.get(action.jobId), r = job?.assistantRunId ? await ctx.db.get(job.assistantRunId) : null
  if (!job || !r || r.jobId !== job._id || r.householdId !== action.householdId || r.createdBy !== job.createdBy || r.sourceId !== job.sourceId || r.sourceRevision !== action.sourceRevision || r.phase !== 'notice' || r.status !== 'complete' || !await valid(ctx, r)) return null
  return async () => {
    const hash = sourceHash(JSON.stringify(await family(ctx, r)))
    await ctx.db.patch(r._id, { refs: (r.refs as Ref[]).map(ref => ref.kind === 'family' ? { ...ref, hash } : ref) })
  }
}
/** Exact parent-reviewed calendar sharing may add its own original-event record. */
export async function preserveCalendarHandoffContext(ctx: MutationCtx, id: Id<'assistantRuns'>) {
  const r = await ctx.db.get(id)
  if (!r || r.status !== 'complete' || !await valid(ctx, r)) return null
  return async () => {
    const hash = sourceHash(JSON.stringify(await family(ctx, r)))
    await ctx.db.patch(r._id, { refs: (r.refs as Ref[]).map(ref => ref.kind === 'family' ? { ...ref, hash } : ref) })
  }
}
async function valid(ctx: Ctx, r: Run): Promise<boolean> {
  const h = await ctx.db.get(r.householdId), j = await ctx.db.get(r.jobId), s = await ctx.db.get(r.sourceId)
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', r.createdBy)).unique()
  if(!h || h.deleted || member?.householdId!==h._id || !j || j.cancelled || !s || s.revision!==r.sourceRevision || sourceHash(s.text??'')!==r.sourceHash || s.expiresAt<=Date.now() || r.expiresAt<=Date.now())return false
  for(const binding of [{mailContext:r.mailContext,workingContext:r.workingContext},...(r.contextBindings??[])])if(binding.mailContext&&!await validMailConversation(ctx,r,binding.mailContext) || binding.workingContext&&!await validWorkingContext(ctx,r,binding.workingContext))return false
  return refsValid(ctx,r)
}
export const start = internalMutation({ args: { jobId: v.id('jobs'), sourceRevision: v.number(), mailContext: v.optional(v.any()), workingContext: v.optional(v.any()),calendarContext:v.optional(v.object({feedId:v.id('calendarFeeds'),feedVersion:v.number(),runId:v.id('calendarFeedRuns'),assistanceVersion:v.number(),changes:v.array(v.object({sourceId:v.string(),text:v.string()}))})) }, handler: async (ctx, args): Promise<Id<'assistantRuns'> | null> => {
  const j = await ctx.db.get(args.jobId), s = j ? await ctx.db.get(j.sourceId) : null
  if (!j || !j.interactive || !j.preparing || j.cancelled || !s || s.revision !== args.sourceRevision || !s.text || s.expiresAt <= Date.now()) return null
  const old = await ctx.db.query('assistantRuns').withIndex('by_job', q => q.eq('jobId', j._id).eq('sourceRevision', s.revision)).unique(); if (old) return old._id
  const meter = await usage(ctx,j)
  if ((meter?.runs ?? 0) >= coordinatorLimits.dailyRuns) { await ctx.db.patch(j._id,{preparing:false,conversation:true,emailPreparationFailed:true,clarification:'Sola reached today’s preparation limit. Your request is saved; try again tomorrow.'});return null }
  await countUsage(ctx,j,'runs')
  const context = await ctx.runQuery(internal.jobs.context, { jobId: j._id })
  const rawBase = context?.assistant
  const base = rawBase ? (({mailContext:_mail,workingContext:_working,...safe})=>safe)(rawBase) : undefined
  const refs: Ref[] = [{ kind: 'source', id: s._id, version: s.revision, hash: sourceHash(s.text) },{kind:'family',id:j.householdId,version:0,hash:sourceHash(JSON.stringify(await family(ctx,j)))}]
  const contextBindings:NonNullable<Run['contextBindings']>=[]
  let expiresAt = Math.min(s.expiresAt, args.mailContext?.expiresAt ?? Infinity, args.workingContext?.expiresAt ?? Infinity)
  const historyJobs = await ctx.db.query('jobs').withIndex('by_creator', q => q.eq('householdId', j.householdId).eq('createdBy', j.createdBy).lt('_creationTime', j._creationTime)).filter(q => q.and(q.eq(q.field('preparing'), false), q.eq(q.field('cancelled'), false))).order('desc').take(30)
  const history: ConversationExchange[] = []
  let privateOnly=!!j.voiceSessionId || !!args.calendarContext
  for (const exchange of base?.history ?? []) {
    for (const previous of historyJobs) {
      const original = await ctx.db.get(previous.sourceId)
      if (!original?.text || original.expiresAt <= Date.now() || original.text.slice(0,3000) !== exchange.request) continue
      const previousActions = (await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', previous._id)).take(9)).map(a => ({ ...a, status: a.status as ActionStatus }))
      const expected = exchange.sourceOnly ? unavailableConversationResponse : recordedConversationResponse({ ...previous, actions: previousActions })
      if (expected.slice(0,2000) !== exchange.response || previous.assistantQuiet) continue
      if (exchange.sourceOnly) {
        if (!previous.interactive || original.email || previous.emailWatchId || original.hash.startsWith('calendar-assistance:')) continue
        refs.push({ kind:'source', id:original._id, version:original.revision, hash:sourceHash(original.text) })
        expiresAt = Math.min(expiresAt, original.expiresAt)
        history.push(exchange); break
      }
      const derived = previous.assistantRunId ? await ctx.db.get(previous.assistantRunId) : null
      if (derived && !await valid(ctx,derived)) continue
      const inherited = derived ? derived.refs as Ref[] : []
      if (refs.length + inherited.length > 200) continue
      refs.push({ kind:'source',id:original._id,version:original.revision,hash:sourceHash(original.text) }, ...inherited)
      contextBindings.push({...(previous.mailContext?{mailContext:previous.mailContext}:{}),...(previous.workingContext?{workingContext:previous.workingContext}:{})},...(derived?.contextBindings??[]),...(derived?[{...(derived.mailContext?{mailContext:derived.mailContext}:{}),...(derived.workingContext?{workingContext:derived.workingContext}:{})}]:[]))
      expiresAt = Math.min(expiresAt,original.expiresAt,derived?.expiresAt ?? Infinity)
      privateOnly ||= !!derived?.privateOnly
      history.push(exchange); break
    }
  }
  const initialObservations:unknown[]=[]
  if(args.calendarContext){
    const c=args.calendarContext,f=await ctx.db.get(c.feedId),snapshot=await ctx.db.get(c.runId)
    if(!f||!snapshot||f.householdId!==j.householdId||f.createdBy!==j.createdBy||!f.assistanceEnabled||f.assistanceVersion!==c.assistanceVersion||f.version!==c.feedVersion||f.publishedRunId!==c.runId||snapshot.status!=='complete'||snapshot.feedVersion!==f.version||c.changes.length>10||c.changes.some(e=>!e.sourceId||e.sourceId.length>200||e.text.length>4000))return null
    const ref:Ref={kind:'calendar',id:f._id,version:f.version,hash:String(c.runId),consentVersion:c.assistanceVersion}
    const testRun={householdId:j.householdId,createdBy:j.createdBy,refs:[ref]} as Run
    if(!await refsValid(ctx,testRun))return null
    refs.push(ref);expiresAt=Math.min(expiresAt,snapshot.expiresAt,(f.lastCheckedAt??Date.now())+calendarLimits.freshnessMs)
    initialObservations.push({tool:'calendar_changes',result:{changes:c.changes,coverage:'Changes in selected, explicitly enabled private calendars. Prepare only useful follow-ups for review. No event was changed by Sola.'},evidence:c.changes})
  }
  const id = await ctx.db.insert('assistantRuns', { householdId: j.householdId, createdBy: j.createdBy, jobId: j._id, sourceId: s._id, sourceRevision: s.revision, sourceHash: sourceHash(s.text),...(privateOnly?{privateOnly:true}:{}),...(args.calendarContext?{calendarTriggered:true}:{}), baseContext:JSON.stringify(base ? {...base,history}:null),contextBindings:[...new Map(contextBindings.filter(b=>b.mailContext||b.workingContext).map(b=>[JSON.stringify(b),b])).values()], version: 1, status: 'queued', step: 0, attempts: 0, used: [], observations: JSON.stringify(initialObservations), refs:[...new Map(refs.map(ref=>[`${ref.kind}:${ref.id}`,ref])).values()], createdAt: Date.now(), expiresAt, ...(args.mailContext ? { mailContext: args.mailContext } : {}), ...(args.workingContext ? { workingContext: args.workingContext } : {}) })
  await ctx.db.patch(j._id, { conversation: true, assistantRunId: id })
  await ctx.scheduler.runAfter(0, internal.coordinatorWorker.step, { id, version: 1 }); return id
} })
async function usage(ctx: Ctx, r: Pick<Run,'householdId'|'createdBy'>) { return ctx.db.query('assistantUsage').withIndex('by_day',q=>q.eq('householdId',r.householdId).eq('createdBy',r.createdBy).eq('day',new Date().toISOString().slice(0,10))).unique() }
async function countUsage(ctx: Pick<import('./_generated/server').MutationCtx,'db'>, r: Pick<Run,'householdId'|'createdBy'>,field:'runs'|'calls') {
 const meter=await usage(ctx,r)
 if(meter) await ctx.db.patch(meter._id,{[field]:meter[field]+1})
 else await ctx.db.insert('assistantUsage',{householdId:r.householdId,createdBy:r.createdBy,day:new Date().toISOString().slice(0,10),runs:field==='runs'?1:0,calls:field==='calls'?1:0,expiresAt:Date.now()+14*86400000})
}
const leased = { id: v.id('assistantRuns'), version: v.number(), lease: v.string() }
export type CoordinatorCorrection = 'arguments' | 'evidence' | 'duplicate' | 'private' | 'steps' | 'format'
const correctionReasons = ['arguments', 'evidence', 'duplicate', 'private', 'steps', 'format'] as const
function invalidStep(reason: CoordinatorCorrection, message: string): never {
  throw new ConvexError({ code: 'coordinator_validation', reason, message })
}
/** Only this typed payload is retryable. Backend exceptions are never model feedback. */
export function coordinatorCorrection(error: unknown): CoordinatorCorrection | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data) || data.code !== 'coordinator_validation' || !('reason' in data)) return null
  return correctionReasons.includes(data.reason as CoordinatorCorrection) ? data.reason as CoordinatorCorrection : null
}
function checkedStep(raw: string, evidence: { sourceId: string; text: string }[], used: string[]) {
  try { return checkedCoordinatorStep(JSON.parse(raw), evidence, used) }
  catch (error) {
    // Categorize at the validation boundary, before transport can redact messages.
    if (error instanceof SyntaxError || error instanceof ZodError) invalidStep('format', 'Return the specified tool response schema.')
    const message = error instanceof Error ? error.message : ''
    const reason = message === 'Use only the arguments supported by this tool.' || message === 'Only Gmail checks accept a historical window.' || message === 'Read tools cannot publish results.' ? 'arguments' : message === 'Choose a different read or finish.' ? 'duplicate' : message === 'Use exact evidence from supplied sources.' ? 'evidence' : null
    if (reason) invalidStep(reason, message)
    throw error
  }
}
async function held(ctx: Ctx, a: { id: Id<'assistantRuns'>; version: number; lease: string }) { const r = await ctx.db.get(a.id); return r && r.version === a.version && r.status === 'running' && r.lease === a.lease && (r.leaseUntil ?? 0) > Date.now() && await valid(ctx, r) ? r : null }
export const claim = internalMutation({ args: {...leased,phase:v.optional(v.literal('notice'))}, handler: async (ctx, a): Promise<CoordinatorInput | null> => {
  const r = await ctx.db.get(a.id)
  if (!r || r.phase!==a.phase || (r.notBefore??0)>Date.now() || r.waitingMailRunId || r.version !== a.version || !['queued', 'running'].includes(r.status) || (r.leaseUntil ?? 0) > Date.now()) return null
  if (!await valid(ctx, r) || r.attempts >= coordinatorLimits.attempts || r.step >= coordinatorLimits.steps) {
    await ctx.db.patch(r._id, { status: 'cancelled', issue: 'The context changed or preparation reached its limit. Send a fresh request.', lease: undefined, leaseUntil: undefined })
    await ctx.db.patch(r.jobId, { preparing: false, conversation: true, emailPreparationFailed:true, clarification: 'The context changed or preparation reached its limit. Send a fresh request.' }); return null
  }
  const meter=await usage(ctx,r)
  if((meter?.calls??0)>=coordinatorLimits.dailyCalls){await ctx.db.patch(r._id,{status:'failed',issue:'Sola reached today’s preparation limit. Try again tomorrow.',lease:undefined,leaseUntil:undefined});await ctx.db.patch(r.jobId,{preparing:false,conversation:true,emailPreparationFailed:true,clarification:'Sola reached today’s preparation limit. Your request is saved; try again tomorrow.'});return null}
  await countUsage(ctx,r,'calls')
  await ctx.db.patch(r._id, { notBefore:undefined,issue:undefined,failureCode:undefined,failureStatus:undefined,status: 'running', attempts: r.attempts + 1, lease: a.lease, leaseUntil: Date.now() + coordinatorLimits.lease })
  await ctx.scheduler.runAfter(coordinatorLimits.lease + 1000, internal.assistantCoordinator.recover, { id: r._id })
  const source = (await ctx.db.get(r.sourceId))!
  return { canLearn:!r.calendarTriggered,trigger:r.calendarTriggered?'calendar':'request',canPrepareNotice:!privateContext(r),source: { sourceId: source._id, text: source.text }, assistant: JSON.parse(r.baseContext ?? 'null'), capabilities: capabilityInventory(await capabilitiesFor(ctx, r.householdId, r.createdBy)), observations: JSON.parse(r.observations), used: r.used, step: r.step + 1, remainingSteps: coordinatorLimits.steps - r.step, now: new Date().toISOString() }
} })
export const advance = internalMutation({ args: { ...leased, result: v.string() }, handler: async (ctx, a): Promise<boolean> => {
  const r = await held(ctx, a); if (!r || r.phase==='notice') return false
  if (a.result.length > 70000) invalidStep('format', 'Preparation output exceeded its limit.')
  const source = (await ctx.db.get(r.sourceId))!, observations = JSON.parse(r.observations) as any[]
  const evidence = [{ sourceId: String(source._id), text: source.text ?? '' }, ...observations.flatMap(o => o.evidence ?? [])]
  const { step, key } = checkedStep(a.result, evidence, r.used)
  if(step.tool==='prepare_notice'){
    // The delegated extractor receives ONLY the parent's source and confirmed
    // household data. Private read observations/history cannot become shared work.
    if(r.step+1>=coordinatorLimits.steps)invalidStep('steps', 'Finish within the step budget.')
    if(privateContext(r))invalidStep('private', 'Use private finish drafts for work with private context.')
    const version=r.version+1
    await ctx.db.patch(r._id,{phase:'notice',status:'queued',version,step:r.step+1,used:[...r.used,key],lease:undefined,leaseUntil:undefined})
    await ctx.scheduler.runAfter(0,internal.coordinatorWorker.prepareNotice,{id:r._id,version});return true
  }
  if (step.tool === 'finish') {
    if (!step.answer) invalidStep('format', 'Provide an answer before finishing.')
    await ctx.db.patch(r._id, { status: 'complete', answer: step.answer, deliverables: step.drafts.map(d => ({ ...d, status: 'review' })), step: r.step + 1, lease: undefined, leaseUntil: undefined })
    await ctx.runMutation(internal.jobs.prepared, { jobId: r.jobId, sourceRevision: r.sourceRevision, clarification: step.answer, actions: [], conversation: true, ...(r.mailContext ? { mailContext: r.mailContext } : {}), ...(r.workingContext ? { workingContext: r.workingContext } : {}) });
    if(r.calendarTriggered && !step.drafts.length)await ctx.db.patch(r.jobId,{assistantQuiet:true,clarification:''})
    if (r.learnRequested) try { await ctx.runMutation(internal.learnedWorkflows.enqueue, { jobId: r.jobId, sourceRevision: r.sourceRevision }) } catch { await ctx.db.patch(r._id,{issue:'Your answer is ready. Learning suggestions could not be queued; review your existing suggestions first.'}) }
    return true
  }
  if (step.tool === 'manage_work' || step.tool === 'answer_request') {
    const observed = observations.filter(o => o.tool === 'read_work').flatMap(o => (o.result?.items ?? []) as WorkItem[])
    const result = step.tool === 'answer_request'
      ? await answerRequestClarification(ctx, r, source.text ?? '', observed, step.id, step.clarification!)
      : await manageCoordinatorWork(ctx, r, source.text ?? '', observed, step.id, step.work!)
    // The immutable receipt describes this transaction only. Detaching mutable
    // context prevents our own task edit from hiding its receipt; conversation
    // and creator keep it private, and no prepared provider action is created.
    await ctx.db.patch(r._id, { status:'complete', answer:result.answer, deliverables:[], step:r.step+1, used:[...r.used,key], observations:JSON.stringify([...observations,{tool:step.tool,result}]), lease:undefined, leaseUntil:undefined })
    await ctx.db.patch(r.jobId, { preparing:false, conversation:true, clarification:result.answer, assistantRunId:undefined, mailContext:undefined, workingContext:undefined, emailPreparationFailed:undefined })
    await ctx.db.patch(source._id, { hash:`conversation:${sourceHash(source.text ?? '')}` })
    return true
  }
  if (r.step + 1 >= coordinatorLimits.steps) invalidStep('steps', 'Finish within the step budget.')
  let data: unknown, refs: Ref[] = r.refs as Ref[], nextEvidence: { sourceId: string; text: string }[] = [], expiresAt = r.expiresAt
  if(step.tool==='read_work') data = await coordinatorWorkInventory(ctx, r)
  if(step.tool==='gmail_check'){
    try{
      const mail=await ctx.runMutation(internal.assistantMail.request,{jobId:r.jobId,sourceRevision:r.sourceRevision,query:step.query,lookbackDays:step.lookbackDays??30}),version=r.version+1
      await ctx.db.patch(r._id,{status:'queued',version,step:r.step+1,used:[...r.used,key],waitingMailRunId:mail.runId,waitingMailRunVersion:mail.version,mailWaitUntil:Date.now()+10*60000,lease:undefined,leaseUntil:undefined})
      await ctx.scheduler.runAfter(5000,internal.assistantCoordinator.resumeMail,{id:r._id,version});return true
    }catch{data={available:false,coverage:'A fresh Gmail check could not start. The parent may need to connect/resume private Gmail or finish an existing check. No new messages were read by this tool.'}}
  }
  if (step.tool === 'family_context') { data = await family(ctx, r); refs = [...refs.filter(s => s.kind !== 'family'), { kind: 'family', id: r.householdId, version: 0, hash: sourceHash(JSON.stringify(data)) }] }
  if (step.tool === 'mail_search') {
    const rows = await ctx.db.query('mailMessages').withIndex('by_owner', q => q.eq('householdId', r.householdId).eq('createdBy', r.createdBy)).order('desc').take(100)
    const matches = rows.filter(m => !m.dismissed && m.expiresAt > Date.now() && (!step.query || `${m.sender} ${m.subject} ${m.text}`.toLowerCase().includes(step.query.toLowerCase()))).slice(0, coordinatorLimits.messages)
    const messages = []
    for (const m of matches) { const box = await ctx.db.get(m.mailboxId); if (!box || await mailboxIssue(ctx, box) || box.connectionVersion !== m.connectionVersion || box.accountKey !== m.accountKey) continue; messages.push({ sourceId: m._id, text: m.text.slice(0, coordinatorLimits.chars), sender: m.sender, subject: m.subject,receivedAt:m.receivedAt,extraction:m.extraction,textTruncated:m.text.length>coordinatorLimits.chars }); refs.push({ kind: 'mail', id: m._id, version: m.version, hash: m.contentHash }); expiresAt = Math.min(expiresAt, m.expiresAt) }
    nextEvidence = messages; data = { messages, coverage: 'Up to 20 matches from 100 recent saved messages. This does not scan unread Gmail or attachments.' }
  }
  if (step.tool === 'calendar_events') {
    const from = step.from ? Date.parse(step.from) : Date.now(), through = step.through ? Date.parse(step.through) : from + 7 * 86400000
    if (!Number.isFinite(from) || !Number.isFinite(through) || through <= from || through - from > 97 * 86400000) invalidStep('arguments', 'Choose a valid bounded calendar window.')
    data = await ctx.runQuery(internal.calendarFeeds.contextForAdult, { householdId: r.householdId, subject: r.createdBy, from, through })
    const freshIds=new Set(((data as any).coverage??[]).filter((c:any)=>c.fresh).map((c:any)=>String(c.feedId)))
    data={...(data as any),events:((data as any).events??[]).filter((e:any)=>freshIds.has(String(e.feedId)))}
    const feeds = await ctx.db.query('calendarFeeds').withIndex('by_owner', q => q.eq('householdId', r.householdId).eq('createdBy', r.createdBy)).take(10)
    for (const f of feeds) if (freshIds.has(String(f._id)) && f.publishedRunId) { refs.push({ kind: 'calendar', id: f._id, version: f.version, hash: String(f.publishedRunId) }); const snap = await ctx.db.get(f.publishedRunId); if (snap) expiresAt = Math.min(expiresAt, snap.expiresAt, (f.lastCheckedAt ?? Date.now()) + calendarLimits.freshnessMs) }
    const events = (data as any).events ?? []
    nextEvidence = events.map((e: any) => ({ sourceId: e.id ?? e.key ?? e.providerId ?? e.event?.providerId, text: JSON.stringify(e) })).filter((e: any) => typeof e.sourceId === 'string')
  }
  if (step.tool === 'read_attachment') {
    const id = ctx.db.normalizeId('mailAttachments', step.id), row = id ? await ctx.db.get(id) : null
    if (!row || row.householdId !== r.householdId || row.createdBy !== r.createdBy || row.status !== 'complete' || !row.consentedAt) data = { available: false, instruction: 'Open the private email and review attachment processing first.' }
    else { const candidate: Ref = { kind: 'attachment', id: row._id, version: row.version, hash: row.contentHash ?? '' }; if (!await refsValid(ctx, { ...r, refs: [...refs, candidate] })) throw new ConvexError('Attachment source or access changed.'); refs.push(candidate); expiresAt = Math.min(expiresAt, row.expiresAt); nextEvidence = [{ sourceId: row._id, text: (row.text ?? '').slice(0, 12000) }]; data = { ...nextEvidence[0], filename: row.filename, extractionMethod: row.extractionMethod, incomplete: row.incomplete, coverage: 'Model transcription may contain errors and requires parent review.' } }
  }
  if (step.tool === 'learn_process') { if(r.calendarTriggered)throw new ConvexError('Learning suggestions require a parent request.'); await ctx.db.patch(r._id, { learnRequested: true }); data = { requested: true, instruction: 'Suggestions require editable parent review. Nothing has been remembered or activated.' } }
  const version = r.version + 1
  refs = [...new Map(refs.map(ref => [`${ref.kind}:${ref.id}`, ref])).values()]
  await ctx.db.patch(r._id, { observations: JSON.stringify([...observations, { tool: step.tool, result: data, evidence: nextEvidence }]), refs, expiresAt, used: [...r.used, key], step: r.step + 1, version, status: 'queued', lease: undefined, leaseUntil: undefined })
  await ctx.scheduler.runAfter(0, internal.coordinatorWorker.step, { id: r._id, version }); return true
} })
/** A nested mutation rolls back a rejected step; only fixed categories cross the worker boundary. */
export const commitStep = internalMutation({ args: { ...leased, result: v.string() }, handler: async (ctx, args): Promise<{ accepted: boolean; correction?: CoordinatorCorrection; failureCode?: 'backend_failure' }> => {
  try { return { accepted: await ctx.runMutation(internal.assistantCoordinator.advance, args) } }
  catch (error) {
    const correction = coordinatorCorrection(error)
    return correction ? { accepted: false, correction } : { accepted: false, failureCode: 'backend_failure' }
  }
} })
export const resumeMail=internalMutation({args:{id:v.id('assistantRuns'),version:v.number()},handler:async(ctx,a):Promise<boolean>=>{
  const r=await ctx.db.get(a.id)
  if(!r || r.version!==a.version || r.status!=='queued' || !r.waitingMailRunId || r.waitingMailRunVersion===undefined)return false
  if(!await valid(ctx,r)){await ctx.db.patch(r._id,{status:'cancelled',waitingMailRunId:undefined,waitingMailRunVersion:undefined,issue:'The request or access changed.'});await ctx.db.patch(r.jobId,{preparing:false,conversation:true,emailPreparationFailed:true,clarification:'The request or access changed. Ask Sola for a fresh check.'});return false}
  const mail=await ctx.runQuery(internal.assistantMail.result,{jobId:r.jobId,sourceRevision:r.sourceRevision,runId:r.waitingMailRunId,version:r.waitingMailRunVersion})
  if(!mail.ready && Date.now()<(r.mailWaitUntil??0)){await ctx.scheduler.runAfter(10000,internal.assistantCoordinator.resumeMail,a);return false}
  const refs=r.refs as Ref[],messages=mail.ready?mail.messages:[]
  for(const m of messages)refs.push({kind:'mail',id:m.sourceId,version:m.version,hash:m.hash})
  const observations=[...JSON.parse(r.observations),{tool:'gmail_check',result:{status:mail.status,coverage:mail.coverage,issue:mail.issue,messages:messages.map(m=>({sourceId:m.sourceId,text:m.text,sender:m.sender,subject:m.subject,extraction:m.extraction}))},evidence:messages.map(m=>({sourceId:m.sourceId,text:m.text}))}]
  const version=r.version+1
  await ctx.db.patch(r._id,{version,waitingMailRunId:undefined,waitingMailRunVersion:undefined,mailWaitUntil:undefined,observations:JSON.stringify(observations),refs:[...new Map(refs.map(ref=>[`${ref.kind}:${ref.id}`,ref])).values()],expiresAt:Math.min(r.expiresAt,...messages.map(m=>m.expiresAt))})
  await ctx.scheduler.runAfter(0,internal.coordinatorWorker.step,{id:r._id,version});return true
}})
export const noticeInput=internalMutation({args:leased,handler:async(ctx,a)=>{
  const r=await held(ctx,a);if(!r||r.phase!=='notice'||privateContext(r))return null
  const source=await ctx.db.get(r.sourceId),context=await modelHouseholdContext(ctx,r.householdId,r.createdBy),h=await ctx.db.get(r.householdId)
  return{source:source?.text??'',now:new Date().toISOString(),timezone:h?.timezone,children:h?.children,household:{timezone:h?.timezone,children:h?.children},confirmedFacts:context.facts.filter(f=>f.confirmed),caregivers:context.caregivers.map(c=>({id:c._id,name:c.name,childIds:c.childIds})),existingEvents:context.plan.map(p=>({...p.payload,id:p._id})),coverage:context.modelCoverage}
}})
export const noticeFinished=internalMutation({args:{...leased,result:v.string()},handler:async(ctx,a)=>{
 const r=await held(ctx,a);if(!r||r.phase!=='notice'||privateContext(r))return false
 if(a.result.length>70000)throw new ConvexError('Preparation output exceeded its limit.')
 const parsed=extractionSchema.parse(JSON.parse(a.result)),source=await ctx.db.get(r.sourceId)
 for(const action of parsed.actions)for(const [field,quote] of Object.entries(action.evidence))if(!source?.text?.includes(quote))delete action.evidence[field]
 await ctx.db.patch(r._id,{status:'complete',deliverables:[],answer:parsed.clarification,lease:undefined,leaseUntil:undefined})
 await ctx.runMutation(internal.jobs.prepared,{jobId:r.jobId,sourceRevision:r.sourceRevision,...parsed});return true
}})
export const correct = internalMutation({args:{...leased,reason:v.optional(v.union(v.literal('arguments'),v.literal('evidence'),v.literal('duplicate'),v.literal('private'),v.literal('steps'),v.literal('format')))},handler:async(ctx,a)=>{
 const r=await held(ctx,a);if(!r)return false
 const observations=JSON.parse(r.observations) as {tool?:string}[]
 let consecutive=0;for(let i=observations.length-1;i>=0&&observations[i].tool==='validation';i--)consecutive++
 if(r.attempts>=coordinatorLimits.attempts || consecutive>=2)return false
 const version=r.version+1,feedback={arguments:'Leave query/id/from/through empty when unused. learn_process has no arguments: use empty query/id/from/through, null lookbackDays, empty answer and an empty drafts array. lookbackDays must be null except for gmail_check. Every non-finish tool including answer_request and manage_work must return answer as an empty string and drafts as an empty array. answer_request uses a nonempty id plus clarification with exact version/snapshot/actionId/actionRevision/sourceRevision/questionKey from read_work; omit work and do not put the parent answer anywhere in the tool response. Calendar windows must be valid ISO timestamps, through after from, at most 97 days.',evidence:'A draft quoted text not present in its cited source. Copy a short exact quote from the supplied source text, or finish with an answer and no drafts.',duplicate:'This read already ran. Use its saved observation; finish or choose a different necessary read.',private:'prepare_notice is unavailable because private context is present. Finish with private editable drafts and exact source evidence, or use learn_process for memory/routine suggestions.',steps:'The final step must be finish. Return the useful answer from existing observations and disclose missing information.',format:'Return only the specified tool response schema; unsupported fields or tool names cannot be executed. finish requires a nonempty answer.'}[a.reason??'format']
 await ctx.db.patch(r._id,{version,status:'queued',observations:JSON.stringify([...JSON.parse(r.observations),{tool:'validation',result:{reason:a.reason??'format',instruction:`The previous response did not meet the tool contract. ${feedback} No requested action was executed.`}}]),lease:undefined,leaseUntil:undefined})
 await ctx.scheduler.runAfter(0,internal.coordinatorWorker.step,{id:r._id,version});return true
}})
export const fail = internalMutation({ args: { ...leased, failureCode: v.optional(v.union(v.literal('model_request'), v.literal('model_quota'), v.literal('model_unavailable'), v.literal('model_output'), v.literal('backend_failure'))), failureStatus: v.optional(v.number()), transient: v.optional(v.boolean()) }, handler: async (ctx, a) => {
  const r = await held(ctx, a)
  if (!r) return false
  const retries = r.transientRetries ?? 0
  const transientCode = a.failureCode === 'model_quota' || a.failureCode === 'model_unavailable' || a.failureCode === 'model_request' && a.failureStatus === 408
  if (a.transient && transientCode && retries < coordinatorLimits.transientRetries && r.attempts < coordinatorLimits.attempts && r.step < coordinatorLimits.steps) {
    // Only preparation is retried. Saved observations and request identity stay
    // intact; a stale callback cannot claim the new version or replay a write.
    const delay = retries === 0 ? 3000 : 12000, version = r.version + 1
    await ctx.db.patch(r._id, { version, transientRetries: retries + 1, status: 'queued', notBefore: Date.now() + delay, failureCode: a.failureCode, failureStatus: a.failureStatus, issue: 'The model connection was interrupted. Sola is retrying this preparation.', lease: undefined, leaseUntil: undefined })
    await ctx.scheduler.runAfter(delay, r.phase === 'notice' ? internal.coordinatorWorker.prepareNotice : internal.coordinatorWorker.step, { id: r._id, version })
    return true
  }
  await ctx.db.patch(r._id, { failureCode: a.failureCode ?? 'backend_failure', failureStatus: a.failureStatus, status: 'failed', issue: 'Preparation stopped. Your request is saved; nothing was sent or changed.', lease: undefined, leaseUntil: undefined })
  await ctx.db.patch(r.jobId, { preparing: false, conversation: true, emailPreparationFailed: true, clarification: 'Preparation stopped. Your request is saved; retry below.' })
  return true
} })
export const recover = internalMutation({ args: { id: v.id('assistantRuns') }, handler: async (ctx, { id }) => { const r = await ctx.db.get(id); if (!r || !['queued','running'].includes(r.status) || (r.leaseUntil ?? 0) > Date.now())return; const delay=Math.max(0,(r.notBefore??0)-Date.now()); await ctx.scheduler.runAfter(delay,r.waitingMailRunId?internal.assistantCoordinator.resumeMail:r.phase==='notice'?internal.coordinatorWorker.prepareNotice:internal.coordinatorWorker.step,{id,version:r.version}) } })
export const retry = mutation({ args: { id: v.id('assistantRuns'), version: v.number() }, handler: async (ctx, a) => {
  const { household, subject } = await adult(ctx), r = await ctx.db.get(a.id)
  if (!r || r.createdBy !== subject || r.householdId !== household._id || r.version !== a.version || r.status !== 'failed' || r.attempts >= coordinatorLimits.attempts || !await valid(ctx, r)) throw new ConvexError('This preparation changed or cannot be retried. Send a fresh request.')
  await ctx.db.patch(r._id, { status: 'queued', version: r.version + 1, issue: undefined,notBefore:Date.now()+15000 }); await ctx.db.patch(r.jobId, { preparing: true, emailPreparationFailed:undefined })
  await ctx.scheduler.runAfter(15000, r.phase==='notice'?internal.coordinatorWorker.prepareNotice:internal.coordinatorWorker.step, { id: r._id, version: r.version + 1 })
} })
async function coordinatorReplySource(ctx: QueryCtx | MutationCtx, r: Run, draft: CoordinatorDraft) {
  if (draft.kind !== 'email' || draft.status === 'dismissed' || draft.sharedJobId) return null
  const ids = [...new Set(draft.evidence.map(e => ctx.db.normalizeId('mailMessages', e.sourceId)).filter((id): id is Id<'mailMessages'> => !!id))]
  if (ids.length !== 1) return null
  const ref = (r.refs as Ref[]).find(ref => ref.kind === 'mail' && ref.id === ids[0])
  if (!ref) return null
  const current = await privateReplySource(ctx, ids[0])
  if (!current || current.message.householdId !== r.householdId || current.message.createdBy !== r.createdBy || current.message.version !== ref.version || current.message.contentHash !== ref.hash || draft.evidence.some(e => e.sourceId === ids[0] && !current.message.text.includes(e.quote))) return null
  const to = exactSender(current.message.sender)
  if (!to) return null
  const subject = current.message.replyRouting?.subject ?? gmailReplySubject(current.message.subject)
  if (!subject.trim()) return null
  return { ...current, metadata: { messageId: String(current.message._id), version: current.message.version, to, subject, accountEmail: current.connection.email!.toLowerCase() } }
}
export async function coordinatorCalendarSource(ctx: QueryCtx | MutationCtx, r: Run, draft: CoordinatorDraft) {
  if (draft.kind !== 'calendar' || draft.status === 'dismissed' || draft.sharedJobId) return null
  const ids = [...new Set(draft.evidence.map(e => ctx.db.normalizeId('calendarFeedEvents', e.sourceId)).filter((id): id is Id<'calendarFeedEvents'> => !!id))]
  if (ids.length !== 1) return null
  const row = await ctx.db.get(ids[0]), feed = row && await ctx.db.get(row.feedId)
  if (!row || !feed || row.householdId !== r.householdId || row.createdBy !== r.createdBy || row.expiresAt <= Date.now() || row.event.recurring || !row.event.etag || !r.refs.some((raw: any) => raw.kind === 'calendar' && raw.id === feed._id && raw.version === feed.version && raw.hash === String(row.runId))) return null
  const c = await ctx.db.get(feed.connectionId), chosen = await selection(ctx, r.createdBy, 'calendar')
  if (!c || c.subject !== r.createdBy || c.householdId !== r.householdId || c.status !== 'active' || c.version !== feed.connectionVersion || chosen.connection?._id !== c._id || c.calendarId !== row.event.calendarId || !c.scopes.includes(feed.provider === 'google' ? googleCalendarEventsScope : 'Calendars.ReadWrite')) return null
  return { eventId: String(row._id), title: row.event.title, provider: feed.provider }
}
export const list = query({ args: {}, handler: async (ctx): Promise<CoordinatorView[]> => {
  const { household, subject } = await adult(ctx), rows = await ctx.db.query('assistantRuns').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(50), result: CoordinatorView[] = []
  for (const r of rows) if (r.expiresAt > Date.now()) {
    const stale = !await valid(ctx, r), drafts: CoordinatorDraft[] = []
    if (!stale) for (const draft of (r.deliverables ?? []) as CoordinatorDraft[]) {
      const current = await coordinatorReplySource(ctx, r, draft)
      const calendarSource = await coordinatorCalendarSource(ctx, r, draft)
      const calendarReviewRequired = draft.kind === 'calendar' && draft.evidence.some(e => !!ctx.db.normalizeId('calendarFeedEvents', e.sourceId))
      const { replySource: _metadata, calendarSource: _calendar, calendarReviewRequired: _required, ...saved } = draft
      drafts.push({ ...saved, ...(current ? { replySource: current.metadata } : {}), ...(calendarSource ? { calendarSource } : {}), ...(calendarReviewRequired ? { calendarReviewRequired: true } : {}) })
    }
    result.push({ id:r._id,jobId:r.jobId,version:r.version,status:r.status,stale,retryable:!stale && r.status === 'failed' && r.attempts < coordinatorLimits.attempts,issue:r.issue,drafts })
  }
  return result
} })
export const review = mutation({ args: { id:v.id('assistantRuns'),version:v.number(),index:v.number(),text:v.string(),operation:v.union(v.literal('keep'),v.literal('done'),v.literal('dismiss'),v.literal('share'),v.literal('reply')),consent:v.optional(v.literal(true)) }, handler: async (ctx,a):Promise<string|undefined> => {
  const {household,subject}=await adult(ctx),r=await ctx.db.get(a.id)
  if(!r || r.householdId!==household._id || r.createdBy!==subject || r.status!=='complete' || !Number.isInteger(a.index))throw new ConvexError('Private preparation is unavailable.')
  const drafts=(r.deliverables??[]) as CoordinatorDraft[],d=drafts[a.index]
  if(!d)throw new ConvexError('This draft is unavailable.')
  if(a.operation==='reply'){
    const text=a.text.trim()
    if(!text || text.length>4000)throw new ConvexError('Keep the reviewed reply between 1 and 4,000 characters.')
    if(!await valid(ctx,r))throw new ConvexError('This preparation or its sources changed. Send a fresh request.')
    const current=await coordinatorReplySource(ctx,r,d)
    if(!current || d.status==='dismissed' || d.sharedJobId)throw new ConvexError('Review one current private email source before preparing a private reply.')
    if(d.privateMailDraftId){
      const id=ctx.db.normalizeId('mailDrafts',d.privateMailDraftId),saved=id?await ctx.db.get(id):null
      if(d.text!==text || !saved || saved.householdId!==household._id || saved.createdBy!==subject || saved.expiresAt<=Date.now() || saved.messageId!==current.message._id || saved.sourceVersion!==current.message.version || saved.sourceHash!==current.message.contentHash)throw new ConvexError('This reply was already reviewed with different details. Edit its private draft instead.')
      return saved._id
    }
    if(r.version!==a.version)throw new ConvexError('This preparation changed. Reopen its current review.')
    const input=privateReplySchema.parse({to:current.metadata.to,subject:current.metadata.subject,body:text}),m=current.message
    const id=await ctx.db.insert('mailDrafts',{householdId:household._id,assistantRunId:r._id,createdBy:subject,mailboxId:m.mailboxId,messageId:m._id,sourceVersion:m.version,sourceHash:m.contentHash,connectionId:m.connectionId,connectionVersion:m.connectionVersion,accountKey:m.accountKey,accountEmail:current.metadata.accountEmail,replyRouting:m.replyRouting,version:1,input,instruction:'Parent-reviewed private assistant reply',preparationKey:sourceHash(`coordinator:${r._id}:${a.index}:${m._id}:${m.version}:${m.contentHash}:${text}`),status:'review',createdAt:Date.now(),expiresAt:Math.min(r.expiresAt,m.expiresAt)})
    drafts[a.index]={...d,text,privateMailDraftId:id,status:'kept'}
    await ctx.db.patch(r._id,{deliverables:drafts,version:r.version+1});return id
  }
  if(a.operation==='keep' && d.privateTaskId){if(d.text!==a.text.trim())throw new ConvexError('This task was already kept. Edit the saved private task instead.');return d.privateTaskId}
  if(a.operation==='done' && d.privateTaskId)throw new ConvexError('Open the saved private task to change its completion.')
  if(a.operation==='share' && d.sharedJobId){if(d.text!==a.text.trim() || !a.consent)throw new ConvexError('This sharing request changed. Review the exact text again.');return d.sharedJobId}
  if(r.version!==a.version || a.operation!=='dismiss' && !await valid(ctx,r))throw new ConvexError('This preparation or its sources changed. Send a fresh request.')
  const text=a.text.trim();if(!text || text.length>10000)throw new ConvexError('Keep the reviewed draft between 1 and 10,000 characters.')
  if(a.operation==='share'){
    if(!a.consent || d.kind==='task')throw new ConvexError('Review exact sharing before preparing a household draft.')
    if(d.kind==='calendar' && d.evidence.some(e=>!!ctx.db.normalizeId('calendarFeedEvents',e.sourceId)))throw new ConvexError('Review the existing connected calendar event directly. Its identity must not become a new event.')
    // Submitted text is exactly what the parent reviewed. No private observation is copied.
    const jobId=await ctx.runMutation(internal.assistantSharing.prepare,{householdId:household._id,subject,text,kind:d.kind})
    drafts[a.index]={...d,text,sharedJobId:jobId,status:'kept'}
    await ctx.db.patch(r._id,{deliverables:drafts,version:r.version+1});return jobId
  }
  if(d.kind!=='task' && a.operation!=='dismiss')throw new ConvexError('Only a parent task can be kept or marked done.')
  const privateTaskId=d.kind==='task' && a.operation!=='dismiss' ? await ctx.runMutation(internal.privateTasks.keep,{householdId:household._id,subject,key:`${r._id}:${a.index}`,title:d.title,text,done:a.operation==='done'}) : undefined
  // The run was current before this explicit review. Account only for its own
  // saved task in this transaction; sibling work retains every other binding.
  const familyHash=privateTaskId?sourceHash(JSON.stringify(await family(ctx,r))):undefined
  const refs=familyHash?(r.refs as Ref[]).map(ref=>ref.kind==='family'?{...ref,hash:familyHash}:ref):r.refs
  drafts[a.index]={...d,text,...(privateTaskId?{privateTaskId}:{}),status:a.operation==='keep'?'kept':a.operation==='done'?'done':'dismissed'};await ctx.db.patch(r._id,{deliverables:drafts,version:r.version+1,refs});return privateTaskId
} })
