import { calendarLimits, calendarReadAllowed } from '../shared/calendarAwareness'
import { voiceModel } from '../shared/voice'
import { sourceHash } from '../shared/daymark'
import { validAssistantRun } from './assistantCoordinator'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { CapabilitySnapshot } from '../shared/capabilities'
import { capabilityInventory } from '../shared/capabilities'
import { jobSummary, jobTitle, jobStatus, isConversation } from '../shared/assistant'
import { assistantName } from '../shared/persona'
import type { ActionStatus } from '../shared/daymark'
import { selection, providerOf } from './providerRules'
import { currentEmailWatches, watchIssue } from './emailWatchRules'
import { pickupDelivery } from './pickupDelivery'
import { mailboxIssue } from './mailbox'
import { boundedConversationHistory, conversationHistoryLimit, recordedConversationResponse, unavailableConversationResponse } from '../server/modelMessages'
import { canReadJob } from './access'
import { isPreparationRequest } from '../shared/householdAssistant'
import { conversationValidation } from './conversationValidation'
import { recentMailConversation } from './mailConversation'
import { currentWorkingMemory } from './workingMemory'
import { needsMailConversation } from '../shared/mailConversation'

/** Only the safe capability description crosses the model boundary, never connection records. */
export async function capabilitiesFor(ctx: QueryCtx, householdId: Doc<'households'>['_id'], subject: string): Promise<CapabilitySnapshot> {
  const connections = (await ctx.db.query('connections').withIndex('by_subject', q => q.eq('subject', subject)).collect()).filter(c => c.householdId === householdId)
  const calendar = (await selection(ctx, subject, 'calendar')).connection
  const email = (await selection(ctx, subject, 'email')).connection
  const owned = (c: typeof calendar) => c && c.householdId === householdId && c.subject === subject ? c : null
  const chosenCalendar = owned(calendar), chosenEmail = owned(email)
  const provider = (name: 'google' | 'microsoft') => {
    const c = connections.find(c => providerOf(c) === name)
    return { configured: name === 'google' ? !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) : !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET), ...(c ? { connection: { status: c.status, scopes: c.scopes, hasCalendar: !!c.calendarId } } : {}) }
  }
  const mailbox = await ctx.db.query('mailboxes').withIndex('by_owner', q => q.eq('householdId', householdId).eq('createdBy', subject)).order('desc').first()
  const mailboxProblem = mailbox ? await mailboxIssue(ctx, mailbox) : null
  const calendarFeeds = await ctx.db.query('calendarFeeds').withIndex('by_owner',q=>q.eq('householdId',householdId).eq('createdBy',subject)).filter(q=>q.neq(q.field('state'),'removed')).take(10)
  const enabledFeeds=calendarFeeds.filter(f=>f.state==='active')
  const usableFeeds=enabledFeeds.filter(f=>{const c=connections.find(c=>c._id===f.connectionId);return c&&c.version===f.connectionVersion&&calendarReadAllowed(c)&&f.accountKey===sourceHash(JSON.stringify([c._id,c.accountId||c.email]))})
  const feedRuns=await Promise.all(usableFeeds.map(f=>f.publishedRunId?ctx.db.get(f.publishedRunId):null))
  const feedCurrent=usableFeeds.length>0&&usableFeeds.every((f,i)=>{const r=feedRuns[i];return r&&r.feedVersion===f.version&&r.expiresAt>Date.now()&&['complete','partial'].includes(r.status)})
  const calendarState={enabled:enabledFeeds.length>0,permitted:usableFeeds.length>0,fresh:feedCurrent&&usableFeeds.every(f=>!!f.lastCheckedAt&&Date.now()-f.lastCheckedAt<=calendarLimits.freshnessMs),partial:!feedCurrent||usableFeeds.length!==calendarFeeds.length||feedRuns.some(r=>!r||r.status!=='complete'||r.omitted>0),issue:calendarFeeds.some(f=>!!f.issue||!!f.assistanceIssue),assistanceEnabled:usableFeeds.some(f=>!!f.assistanceEnabled&&!!f.assistanceConsentedAt),modelConfigured:!!process.env.ANTHROPIC_API_KEY&&!!process.env.DAYMARK_MODEL}
  const watch = (await currentEmailWatches(ctx, householdId, subject))[0]
  const watchProblem = watch ? await watchIssue(ctx, watch) : null
  const apple = connections.find(c => providerOf(c) === 'apple')
  const caregivers = await ctx.db.query('caregivers').withIndex('by_household', q => q.eq('householdId', householdId)).take(50)
  const inApp = await Promise.all(caregivers.map(async caregiver => {
    return caregiver.childIds.length > 0 && (await pickupDelivery(ctx, caregiver.email)).channel === 'app'
  }))
  return { mode: 'connected', calendarFeeds:calendarState, voice:{configured:!!process.env.OPENAI_API_KEY&&process.env.DAYMARK_VOICE_MODEL===voiceModel}, mailbox: { enabled: mailbox?.state === 'active', permitted: Boolean(mailbox && !mailboxProblem), modelConfigured: Boolean(process.env.ANTHROPIC_API_KEY && process.env.DAYMARK_MODEL), lastCheckedAt: mailbox?.lastCheckedAt, issue: Boolean(mailbox?.issue || mailboxProblem) }, emailWatch: { enabled: watch?.state === 'active', permitted: Boolean(watch && !watchProblem), modelConfigured: Boolean(process.env.ANTHROPIC_API_KEY && process.env.DAYMARK_MODEL), lastCheckedAt: watch?.lastCheckedAt, issue: Boolean(watch?.issue || watchProblem) }, providers: { google: provider('google'), microsoft: provider('microsoft') },
    selected: { ...(chosenCalendar ? { calendar: providerOf(chosenCalendar) } : {}), ...(chosenEmail && providerOf(chosenEmail) !== 'apple' ? { email: providerOf(chosenEmail) as 'google' | 'microsoft' } : {}) },
    // The server cannot assert that the original iPhone is open or available now.
    apple: { available: false, permission: apple?.status === 'active' && apple.scopes.includes('calendar.local.full') ? 'granted' : 'prompt', selected: !!apple?.calendarId, connectionStatus: apple?.status },
    caregiverDeliveryReady: inApp.some(Boolean) || !!(chosenEmail && chosenEmail.householdId === householdId && chosenEmail.subject === subject && providerOf(chosenEmail) === 'google' && chosenEmail.status === 'active' && chosenEmail.cipher && chosenEmail.email && chosenEmail.scopes.includes('https://www.googleapis.com/auth/gmail.readonly') && chosenEmail.scopes.some(s => ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'].includes(s)) && process.env.DAYMARK_WEB_URL?.startsWith('https://')) || !!(process.env.RESEND_API_KEY && process.env.DAYMARK_EMAIL_FROM && process.env.DAYMARK_WEB_URL) }
}

export async function householdWork(ctx: QueryCtx, household: Doc<'households'>, subject = '') {
  const jobs = (await Promise.all([undefined, false].map(conversation => ctx.db.query('jobs').withIndex('by_conversation', q => q.eq('householdId', household._id).eq('conversation', conversation)).filter(q => q.and(q.neq(q.field('assistantQuiet'), true), q.neq(q.field('emailQuiet'), true), q.eq(q.field('emailHandling'), undefined))).order('desc').take(101)))).flat().sort((a, b) => b._creationTime - a._creationTime).slice(0, 101)
  const taskRecords = await ctx.db.query('personalTasks').withIndex('by_household', q => q.eq('householdId', household._id)).order('desc').take(101)
  const privateTasks = await ctx.db.query('privateTasks').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject).eq('removed', false)).order('desc').take(101)
  const plan = await ctx.db.query('planEvents').withIndex('by_household', q => q.eq('householdId', household._id)).order('desc').take(101)
  return { limited: jobs.length === 101 || taskRecords.length === 101 || privateTasks.length === 101 || plan.length === 101, personalTasksLimited: taskRecords.length === 101 || privateTasks.length === 101, timezone: household.timezone, children: household.children, plan,
    personalTasks: [...taskRecords.filter(t => !t.removed).map(t => ({ ...t, id: t._id })), ...privateTasks.slice(0,100).map(t => ({ id:t._id,title:t.title,notes:t.text.slice(0,1000),done:t.done,version:t.version,createdAt:t.createdAt,updatedAt:t.updatedAt,private:true as const,dueDate:undefined,childId:undefined }))].sort((a,b)=>b.updatedAt-a.updatedAt),
    jobs: await Promise.all(jobs.filter(j => canReadJob(j, subject)).map(async j => {
      const source = await ctx.db.get(j.sourceId)
      return { ...j, source: source && source.expiresAt > Date.now() ? source : null,
        actions: await Promise.all((await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', j._id)).collect()).map(async a => ({ ...a, status: a.status as ActionStatus, provider: a.approvalId ? (await ctx.db.get(a.approvalId))?.provider ?? 'google' : a.before?.provider, receipts: await ctx.db.query('receipts').withIndex('by_action', q => q.eq('actionId', a._id)).collect() }))) }
    })) }
}

export async function conversationContext(ctx: QueryCtx, household: Doc<'households'>, job: Doc<'jobs'>) {
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', job.createdBy)).unique()
  if (!member || member.householdId !== household._id) return null
  const preference = await ctx.db.query('personalPreferences').withIndex('by_subject', q => q.eq('subject', job.createdBy)).unique()
  const ownPreference = preference?.householdId === household._id ? preference : undefined
  const work = await householdWork(ctx, household, job.createdBy)
  const source = await ctx.db.get(job.sourceId)
  const text = source?.text ?? ''
  const emailFollowup = /\b(?:reply|email|message)\b[\s\S]*\b(?:it|that|those|first|second|one|them)\b|\b(?:it|that|those|first|second|one|them)\b[\s\S]*\b(?:reply|email|message)\b/i.test(text)
  const preparation = Boolean(source?.attachmentIds?.length) || isPreparationRequest(text) && !emailFollowup
  const visiblePersonalTasks = work.personalTasks.filter(task => !preparation || !('private' in task))
  // Fetch this adult's bounded history independently of household-wide work summaries.
  const historyJobs = await ctx.db.query('jobs').withIndex('by_creator', q => q.eq('householdId', household._id).eq('createdBy', job.createdBy).lte('_creationTime', job._creationTime)).filter(q => q.and(q.neq(q.field('assistantQuiet'), true), q.neq(q.field('emailQuiet'), true), q.eq(q.field('emailHandling'), undefined), q.eq(q.field('preparing'), false), q.eq(q.field('cancelled'), false), q.eq(q.field('scheduledFor'), undefined), q.neq(q.field('emailPreparationFailed'), true))).order('desc').take(30)
  const history = await Promise.all(historyJobs.map(async j => ({ ...j, source: await ctx.db.get(j.sourceId), actions: (await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', j._id)).take(9)).map(a => ({ ...a, status: a.status as ActionStatus })) })))
  const mail = preparation || !needsMailConversation(text, true) ? null : await recentMailConversation(ctx, job)
  const previous = history.find(j => j._id !== job._id && j._creationTime <= job._creationTime && !j.preparing && !j.cancelled && !j.scheduledFor && j.source?.text && j.source.expiresAt > Date.now())
  // Unattended mail arrival must not hijack an unrelated conversation. A new
  // explicit check/search can establish focus, including a search of older mail.
  const mailFocused = Boolean(mail && (!previous || previous.mailContext || mail.requestedByParent && mail.requestedAt > previous._creationTime))
  const privateMail = mail && needsMailConversation(text, mailFocused) ? mail : null
  const working = preparation || privateMail ? null : await currentWorkingMemory(ctx, job)
  const workingSources = new Map(working?.context.sources.map(ref => [ref.jobId, ref]) ?? [])
  // Same adult only. Expired text and later parallel submissions are never added to a turn's context.
  const validate = conversationValidation(ctx)
  const permitted = await Promise.all(history.map(async j => !j.mailContext || Boolean(privateMail && !preparation && j.mailContext.mailboxId === privateMail.provenance.mailboxId && j.mailContext.runId === privateMail.provenance.runId && await validate.mail(j, j.mailContext))))
  // The next reply binds the current cache. Do not inherit older derived text
  // unless that binding also covers every source on which the text depended.
  const workingValid = await Promise.all(history.map(async j => !j.workingContext || Boolean(working && j.workingContext.sources.every(ref => {
    const current = workingSources.get(ref.jobId)
    return current?.sourceId === ref.sourceId && current.revision === ref.revision && current.hash === ref.hash
  }) && await validate.working(j, j.workingContext))))
  const coordinatedValid = await Promise.all(history.map(j => validAssistantRun(ctx, j)))
  const recent = history.map((j, i) => ({ job: j, responsePermitted: coordinatedValid[i] && workingValid[i] && permitted[i] }))
    .filter(({ job: j, responsePermitted }) => !j.assistantQuiet && j._id !== job._id && j._creationTime <= job._creationTime && j.source?.householdId === household._id && j.source.text && j.source.expiresAt > Date.now() && !j.preparing && !j.cancelled && !j.scheduledFor &&
      // Fallback is only an adult-authored turn, never an automatic email body
      // or calendar-watch instruction whose provider access has since changed.
      (responsePermitted || j.interactive && !j.emailWatchId && !j.source.email && !j.source.hash.startsWith('calendar-assistance:'))).slice(0, conversationHistoryLimit).reverse()
  const active = work.jobs.filter(j => j._id !== job._id && !isConversation(j) && !j.cancelled && jobStatus(j) !== 'Finished')
  return { assistantName: assistantName(ownPreference), parentName: ownPreference?.parentName ?? '',
    ...(privateMail ? { privateMail: privateMail.input, mailContext: privateMail.provenance } : {}),
    ...(working ? { workingMemory: { notes: working.notes, coverage: 'Selected literal earlier statements from this adult, temporary and incomplete. Recent corrections take precedence. Not confirmed household facts or approvals.' }, workingContext: working.context } : {}),
    capabilities: capabilityInventory(await capabilitiesFor(ctx, household._id, job.createdBy)),
    history: boundedConversationHistory(recent.map(({ job: j, responsePermitted }) => ({ request: j.source!.text!, response: responsePermitted ? recordedConversationResponse(j) : unavailableConversationResponse, ...(!responsePermitted ? { sourceOnly: true as const } : {}) }))),
    coverage: work.limited ? 'Only recent saved records are included. Never claim there are no other tasks or events; ask the parent to check Tasks and Plan for the full saved list.' : 'Saved records only; no inbox or full calendar sync.',
    visibleOpenTaskCount: active.length,
    currentWork: active.slice(0, 20).map(j => ({ title: jobTitle({ ...j, source: null }, household.children), status: jobSummary(j) })),
    personalTaskCount: visiblePersonalTasks.filter(t => !t.done).length,
    personalTasks: visiblePersonalTasks.filter(t => !t.done).slice(0, 30).map(t => ({ title: t.title, dueDate: t.dueDate, childId: t.childId, ...('private' in t ? {private:true} : {}) })),
  }
}
