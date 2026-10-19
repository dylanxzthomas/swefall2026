import { Temporal } from '@js-temporal/polyfill'
import { start } from '@convex-dev/workflow'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'
import { internal } from './_generated/api'
import { sourceHash, type ActionStatus } from '../shared/daymark'
import { jobTitle } from '../shared/assistant'
import { personalTaskSchema } from '../shared/tasks'
import { privateTaskInputSchema } from '../shared/privateTasks'
import { directWorkAuthorization, resolvedWorkTarget, workTargetKinds, bareWorkReference, type WorkChange, type WorkItem } from '../shared/workControl'
import { routineJobIssue } from './routineRules'
import { pendingPickupMail } from './pickupMailRules'
import { cancelWaitingDependencies } from './dependencies'
import { pendingRequestClarification } from './requestClarifications'
type Owner = { householdId: Doc<'households'>['_id']; createdBy: string; jobId: Doc<'jobs'>['_id']; calendarTriggered?: boolean }
type Ctx = Pick<QueryCtx, 'db'>
export type WorkInventory = { items: WorkItem[]; limited: boolean; limitedKinds: WorkChange['kind'][]; coverage: string }
function snapshot(value: unknown) { return sourceHash(JSON.stringify(value)) }
/** A fresh, bounded inventory owned by this adult, never an arbitrary model ID. */
export async function coordinatorWorkInventory(ctx: Ctx, owner: Owner): Promise<WorkInventory> {
  const taskScan = await ctx.db.query('personalTasks').withIndex('by_household', q => q.eq('householdId', owner.householdId)).order('desc').take(101)
  const tasks = taskScan.filter(task => !task.removed)
  const privateTasks = await ctx.db.query('privateTasks').withIndex('by_owner', q => q.eq('householdId', owner.householdId).eq('createdBy', owner.createdBy).eq('removed', false)).order('desc').take(51)
  const jobScan = await ctx.db.query('jobs').withIndex('by_creator', q => q.eq('householdId', owner.householdId).eq('createdBy', owner.createdBy)).order('desc').take(101)
  const jobs = jobScan.filter(job => !job.assistantQuiet && !job.emailQuiet && !job.emailHandling)
  const items: WorkItem[] = tasks.slice(0, 50).map(t => ({ id: t._id, kind: 'personal_task', version: t.version, snapshot: snapshot(t), title: t.title, text: t.notes.slice(0, 300), dueDate: t.dueDate, done: t.done, createdAt: t.createdAt, updatedAt: t.updatedAt }))
  items.push(...privateTasks.slice(0, 50).map(t => ({ id: t._id, kind: 'private_task' as const, version: t.version, snapshot: snapshot(t), title: t.title, text: t.text.slice(0, 400), done: t.done, createdAt: t.createdAt, updatedAt: t.updatedAt })))
  for (const job of jobs.slice(0, 50)) {
    if (job._id === owner.jobId) continue
    const source = await ctx.db.get(job.sourceId)
    if (!source || source.householdId !== owner.householdId || source.expiresAt <= Date.now()) continue
    const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).take(9)
    const states = actions.map(a => ({ id: String(a._id), revision: a.revision, kind: String(a.payload.kind), status: a.status, revising: !!a.revisionRequest }))
    const clarification = await pendingRequestClarification(ctx, owner, job, source, actions)
    items.push({ id: job._id, kind: 'request', version: source.revision, snapshot: snapshot([job, source.revision, source.text, states]), title: jobTitle({ ...job, source, actions: actions.map(action => ({ ...action, status: action.status as ActionStatus })) }), text: source.text?.slice(0, 600) ?? '', createdAt: job._creationTime, updatedAt: job._creationTime, conversation: !!job.conversation, cancelled: job.cancelled, actions: states, ...(clarification ? { clarification } : {}) })
  }
  const limitedKinds: WorkChange['kind'][] = [...(tasks.length > 50 || taskScan.length === 101 ? ['personal_task' as const] : []), ...(privateTasks.length > 50 ? ['private_task' as const] : []), ...(jobs.length > 50 || jobScan.length === 101 ? ['request' as const] : [])]
  return { items, limited: limitedKinds.length > 0, limitedKinds, coverage: 'Up to 50 household tasks, 50 of your private tasks and 50 of your recent requests, scanning at most 101 recent household task and request records. Hidden requests and other adults’ private work are excluded. A limited list may omit older active work. IDs and snapshots must come from this read. No provider state is changed.' }
}
export type WorkResult = { changed: boolean; answer: string }
/** Called only from the held, versioned coordinator transaction. Failure returns
 * a truthful server answer, never a guessed mutation or a provider operation. */
export async function manageCoordinatorWork(ctx: MutationCtx, owner: Owner, sourceText: string, observed: WorkItem[], id: string, change: WorkChange): Promise<WorkResult> {
  const blocked = (answer: string): WorkResult => ({ changed: false, answer })
  const household = await ctx.db.get(owner.householdId), membership = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', owner.createdBy)).unique()
  if (!household || household.deleted || membership?.householdId !== owner.householdId) return blocked('Your household access changed. I haven’t changed that work.')
  const callerJob = await ctx.db.get(owner.jobId), callerSource = callerJob && await ctx.db.get(callerJob.sourceId)
  if (owner.calendarTriggered || !callerJob?.interactive || callerJob.householdId !== owner.householdId || callerJob.createdBy !== owner.createdBy || !callerSource || callerSource.householdId !== owner.householdId || callerSource.text !== sourceText || callerJob.emailWatchId || callerJob.mailRoutineBindings?.length || callerSource?.email || callerSource?.hash.startsWith('calendar-assistance:') || !directWorkAuthorization(sourceText, change)) return blocked('Tell me directly which task or request you want changed, and what to do. I haven’t changed anything.')
  const target = resolvedWorkTarget(observed, id, change)
  if (!target) return blocked('Which task or request do you mean? Tell me its title so I can change the right one.')
  const current = await coordinatorWorkInventory(ctx, owner), fresh = current.items.find(item => item.id === id && item.kind === change.kind)
  if (!fresh || !resolvedWorkTarget(current.items, id, change) || fresh.snapshot !== target.snapshot || fresh.version !== target.version) return blocked('That work changed while I was checking it. Please ask again with its current title; I haven’t changed anything.')
  const scope = workTargetKinds(change.authorization, bareWorkReference(change) ? [] : current.items, change)
  const latestRequest = change.kind === 'request' && scope.length === 1 && bareWorkReference(change) && (!fresh.conversation || /\bmessage\b/i.test(change.authorization))
  if (!latestRequest && current.limitedKinds.some(kind => scope.includes(kind))) return blocked('I can’t safely distinguish that item from the full saved list in this check. Open Tasks or the request and choose the exact item; I haven’t changed anything.')
  const label = `“${fresh.title}”`
  if (change.kind === 'personal_task') {
    const key = ctx.db.normalizeId('personalTasks', id), task = key && await ctx.db.get(key)
    if (!task || task.householdId !== owner.householdId || task.removed || task.version !== change.version) return blocked('That task is no longer available. Nothing changed.')
    if (change.operation === 'update') {
      if (change.title === undefined && change.text === undefined && change.dueDate === undefined) return blocked('What would you like to change about that task?')
      const input = personalTaskSchema.safeParse({ title: change.title ?? task.title, notes: change.text ?? task.notes, ...(change.dueDate !== null && (change.dueDate ?? task.dueDate) ? { dueDate: change.dueDate ?? task.dueDate } : {}), childId: task.childId })
      if (!input.success || !literalChanges(sourceText, change, household.timezone, { title: task.title, text: task.notes, dueDate: task.dueDate })) return blocked('Please state the new title, notes or date directly. I haven’t changed the task.')
      await ctx.db.patch(task._id, { ...input.data, dueDate: input.data.dueDate, version: task.version + 1, updatedAt: Date.now() })
      return { changed: true, answer: `Updated ${label}${input.data.dueDate ? `, due ${input.data.dueDate}` : ''}.` }
    }
    if (change.operation === 'done' || change.operation === 'reopen') {
      const done = change.operation === 'done'
      if (task.done !== done) await ctx.db.patch(task._id, { done, version: task.version + 1, updatedAt: Date.now() })
      return { changed: true, answer: done ? `Marked ${label} done.` : `Reopened ${label}.` }
    }
    if (change.operation !== 'remove' && change.operation !== 'cancel') return blocked('I can edit, finish, reopen or remove that task. Which would you like?')
    // Preserve the idempotency marker so old create retries cannot resurrect it.
    for (const suggestion of await ctx.db.query('emailTaskSuggestions').withIndex('by_personal_task', q => q.eq('personalTaskId', task._id)).collect()) await ctx.db.patch(suggestion._id, { title: 'Removed task', notes: '', dueDate: undefined, childId: undefined, evidence: [], issue: 'The saved task was removed. It will not be restored by a repeated save.' })
    await ctx.db.patch(task._id, { removed: true, title: '', notes: '', childId: undefined, dueDate: undefined, done: false, version: task.version + 1, updatedAt: Date.now() })
    return { changed: true, answer: `Removed ${label} from Tasks.` }
  }
  if (change.kind === 'private_task') {
    const key = ctx.db.normalizeId('privateTasks', id), task = key && await ctx.db.get(key)
    if (!task || task.householdId !== owner.householdId || task.createdBy !== owner.createdBy || task.removed || task.version !== change.version) return blocked('That private task is unavailable. Nothing changed.')
    if (change.dueDate !== undefined) return blocked('Private tasks don’t have a separate due date yet. I can edit its saved wording instead.')
    if (change.operation === 'update') {
      if (change.title === undefined && change.text === undefined && change.dueDate === undefined) return blocked('What would you like to change about that task?')
      const input = privateTaskInputSchema.safeParse({ title: change.title ?? task.title, text: change.text ?? task.text })
      if (!input.success || !literalChanges(sourceText, change, household.timezone, { title: task.title, text: task.text })) return blocked('Please state the new title or wording directly. I haven’t changed the task.')
      await ctx.db.patch(task._id, { ...input.data, version: task.version + 1, updatedAt: Date.now() })
      return { changed: true, answer: `Updated your private task ${label}.` }
    }
    if (change.operation === 'done' || change.operation === 'reopen') {
      const done = change.operation === 'done'
      if (task.done !== done) await ctx.db.patch(task._id, { done, version: task.version + 1, updatedAt: Date.now() })
      return { changed: true, answer: done ? `Marked your private task ${label} done.` : `Reopened your private task ${label}.` }
    }
    if (change.operation !== 'remove' && change.operation !== 'cancel') return blocked('I can edit, finish, reopen or remove that private task. Which would you like?')
    await ctx.db.patch(task._id, { removed: true, title: '', text: '', version: task.version + 1, updatedAt: Date.now() })
    return { changed: true, answer: `Removed ${label} from your private tasks.` }
  }
  const key = ctx.db.normalizeId('jobs', id), job = key && await ctx.db.get(key)
  if (!job || job._id === owner.jobId || job.householdId !== owner.householdId || job.createdBy !== owner.createdBy || job.cancelled && change.operation !== 'remove') return blocked('That request is unavailable. Nothing changed.')
  const activeLinkedDraft = job.assistantRunId ? await ctx.db.query('mailDrafts').withIndex('by_owner', q => q.eq('householdId', owner.householdId).eq('createdBy', owner.createdBy)).filter(q => q.and(q.eq(q.field('assistantRunId'), job.assistantRunId), q.or(...['preparing', 'saving', 'sending', 'uncertain', 'send_uncertain'].map(status => q.eq(q.field('status'), status))))).first() : null
  if (activeLinkedDraft) return blocked('That request has an active or unconfirmed Gmail draft operation. Open its reply and check the result first; I haven’t hidden or changed it.')
  const knownLinkedDraft = job.assistantRunId ? await ctx.db.query('mailDrafts').withIndex('by_owner', q => q.eq('householdId', owner.householdId).eq('createdBy', owner.createdBy)).filter(q => q.and(q.eq(q.field('assistantRunId'), job.assistantRunId), q.or(q.neq(q.field('gmailDraftId'), undefined), q.neq(q.field('sentMessageId'), undefined)))).first() : null
  const actions = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).collect()
  const attempts = (await Promise.all(actions.map(action => ctx.db.query('attempts').withIndex('by_action', q => q.eq('actionId', action._id)).collect()))).flat()
  const pickupRows = (await Promise.all(actions.filter(action => action.payload.kind === 'pickup').map(action => ctx.db.query('pickupRequests').withIndex('by_action', q => q.eq('actionId', action._id)).collect()))).flat()
  const pendingPickup = await Promise.all(actions.filter(action => action.payload.kind === 'pickup').map(action => pendingPickupMail(ctx, action._id, owner.createdBy)))
  if (actions.some(a => ['executing', 'uncertain'].includes(a.status)) || attempts.some(attempt => attempt.dispatched && !attempt.finished) || pendingPickup.some(Boolean) || pickupRows.some(row => ['dispatched', 'uncertain'].includes(row.followUpStatus ?? '') || row.followUpDispatchedAt !== undefined && !['accepted', 'cancelled', 'failed'].includes(row.followUpStatus ?? ''))) return blocked('That request has an active or unconfirmed action. Check its result first; I haven’t hidden or changed it.')
  if (change.operation === 'revise' || change.operation === 'update') {
    const editable = actions.filter(a => ['review', 'failed', 'queued'].includes(a.status) && !a.revisionRequest && !a.dependsOn)
    if (editable.length !== 1 || job.preparing || job.conversation || job.mailContext || job.workingContext || job.voiceSessionId || job.assistantRunId && (await ctx.db.get(job.assistantRunId))?.privateOnly) return blocked('Open that request’s review to choose the draft to change. I haven’t changed or approved it.')
    const action = editable[0], source = await ctx.db.get(job.sourceId)
    if (!source || source.expiresAt <= Date.now() || source.revision !== action.sourceRevision || await routineJobIssue(ctx, job)) return blocked('That request’s source or permission changed. Reopen its current review before editing.')
    if (!process.env.ANTHROPIC_API_KEY || !process.env.DAYMARK_MODEL) return blocked('Automatic draft revision needs the connected model. You can still edit the fields in its review.')
    if (action.payload.kind === 'pickup') await cancelWaitingDependencies(ctx, action)
    const revision = action.revision + 1
    await ctx.db.patch(action._id, { revision, status: 'review', approvalId: undefined, error: undefined, revisionNote: undefined, revisionRequest: { instruction: change.authorization, requestedBy: owner.createdBy, startedAt: Date.now() } })
    await start(ctx, internal.workflows.revise, { actionId: action._id, revision })
    await ctx.scheduler.runAfter(120000, internal.revisions.fail, { actionId: action._id, revision })
    return { changed: true, answer: `I’m revising ${label} with your change. Its old approval is cleared; review the updated draft before anything is sent or changed.` }
  }
  if (change.operation !== 'remove' && change.operation !== 'cancel') return blocked('I can revise, cancel or remove this request. A request cannot be marked as externally completed without a verified result.')
  // Queued approvals are invalidated atomically; already-dispatched/uncertain work
  // was refused above. Completed effects and provider receipts are never deleted.
  for (const action of actions) if (['review', 'failed', 'queued', 'waiting'].includes(action.status)) await ctx.db.patch(action._id, { status: 'cancelled', revision: action.revision + 1, approvalId: undefined, revisionRequest: undefined })
  await ctx.db.patch(job._id, { cancelled: true, preparing: false, scheduledFor: undefined, ...(change.operation === 'remove' ? { assistantQuiet: true } : {}) })
  const source = await ctx.db.get(job.sourceId)
  if (source) await ctx.db.patch(source._id, { revision: source.revision + 1, expiresAt: Math.min(source.expiresAt, Date.now() + 30 * 86400000) })
  const completed = !!knownLinkedDraft || actions.some(a => ['succeeded', 'saved', 'waiting'].includes(a.status))
  return { changed: true, answer: `${change.operation === 'remove' ? 'Removed' : 'Cancelled'} ${label}${change.operation === 'remove' ? ' from your conversation and active work' : ''}.${completed ? ' Earlier messages, calendar changes and caregiver agreements are unchanged; their receipts are preserved.' : ' No new email or calendar change was made.'}` }
}
function literalChanges(source: string, change: WorkChange, timezone: string, previous: { title: string; text: string; dueDate?: string }) {
  if (change.title !== undefined && change.title !== previous.title && !/\b(?:rename|title|name|call it)\b/i.test(source) && !/\bchange\b/i.test(source)) return false
  if (change.title !== undefined && change.title !== previous.title && /\b(?:due date|deadline|notes|description)\b/i.test(source) && !/\b(?:rename|title|name)\b/i.test(source)) return false
  if (change.text !== undefined && change.text !== previous.text && !/\b(?:notes|details|description|wording|text|say|read)\b/i.test(source)) return false
  if (change.text === '' && previous.text && !/\b(?:clear|remove|erase|empty|delete)\b[\s\S]{0,100}\b(?:notes|details|description|wording|text)\b/i.test(source)) return false
  if (change.dueDate !== undefined && change.dueDate !== previous.dueDate && !/\b(?:date|due|deadline|reschedule|move|postpone|today|tomorrow)\b/i.test(source)) return false
  if (![change.title, change.text].every(value => value == null || !value || source.toLocaleLowerCase().includes(value.toLocaleLowerCase()))) return false
  if (change.title !== undefined && change.title !== previous.title && !endsWithReviewedValue(source, change.title)) return false
  if (change.text !== undefined && change.text !== previous.text && change.text && !endsWithReviewedValue(source, change.text)) return false
  if (change.text === '' && !/\b(?:notes|details|description|wording|text)[\s.!?]*(?:(?:please|thanks|thank you)[\s.!?]*)?$/i.test(source)) return false
  if (change.dueDate === undefined) return true
  if (change.dueDate === null) return /\b(?:due date|deadline|date)[\s.!?]*(?:(?:please|thanks|thank you)[\s.!?]*)?$/i.test(source) && /\b(?:clear|remove|without|no)\b[\s\S]{0,30}\b(?:due date|deadline|date)\b/i.test(source)
  if (source.includes(change.dueDate)) return endsWithReviewedValue(source, change.dueDate)
  try {
    const today = Temporal.Instant.fromEpochMilliseconds(Date.now()).toZonedDateTimeISO(timezone).toPlainDate()
    if (/\btomorrow[\s.!?]*(?:(?:please|thanks|thank you)[\s.!?]*)?$/i.test(source)) return change.dueDate === today.add({ days: 1 }).toString()
    if (/\btoday[\s.!?]*(?:(?:please|thanks|thank you)[\s.!?]*)?$/i.test(source)) return change.dueDate === today.toString()
  } catch { /* An invalid timezone never permits an inferred date. */ }
  return false
}


function endsWithReviewedValue(source: string, value: string) {
  const lower = source.toLocaleLowerCase(), at = lower.lastIndexOf(value.toLocaleLowerCase())
  if (at < 0) return false
  return /^[\s“”"'`.!?]*(?:(?:please|thanks|thank you)[\s.!?]*)?$/i.test(source.slice(at + value.length))
}
