import { Temporal } from '@js-temporal/polyfill'
import { start } from '@convex-dev/workflow'
import { paginationOptsValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { mutation, query, internalMutation, type MutationCtx, type QueryCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult, sameHousehold } from './access'
import { sourceHash } from '../shared/daymark'
import { routineDefinitionSchema, nextOccurrence, latestOccurrence, type RoutineDefinition } from '../shared/routines'
import { localAssistantReply } from '../shared/assistant'
import { capabilityReply } from '../shared/capabilities'
import { householdAssistantReply } from '../shared/householdAssistant'
import { jobStatus, jobSummary } from '../shared/assistant'
import { routineJobIssue } from './routineRules'
import type { ActionStatus } from '../shared/daymark'

const currentArgs = { id: v.id('routines'), version: v.number() }
const runArgs = { id: v.id('routines'), version: v.number(), expectedAt: v.number() }

async function visibleRoutines(ctx: Pick<QueryCtx, 'db'>, householdId: Id<'households'>) {
  return (await Promise.all((['active', 'paused', 'blocked', 'finished'] as const).map(state => ctx.db.query('routines').withIndex('by_state', q => q.eq('householdId', householdId).eq('state', state)).take(100)))).flat().sort((a, b) => b._creationTime - a._creationTime)
}

function checkedDefinition(raw: unknown, household: Doc<'households'>): RoutineDefinition {
  const parsed = routineDefinitionSchema.safeParse(raw)
  if (!parsed.success) throw new ConvexError(parsed.error.issues[0]?.message ?? 'Confirm the routine details.')
  const definition = parsed.data, outcome = definition.outcome
  if (outcome.kind === 'personal_task' && outcome.task.childId && !household.children.some(c => c.id === outcome.task.childId)) throw new ConvexError('Choose a child in this household.')
  if (outcome.kind === 'prepare_request' && (localAssistantReply(outcome.instruction) || capabilityReply(outcome.instruction, { mode: 'connected' }) || householdAssistantReply(outcome.instruction, { timezone: definition.schedule.timezone, jobs: [], personalTasks: [], plan: [] }))) throw new ConvexError('Save a personal-task routine or describe a calendar, email or pickup draft to prepare.')
  return definition
}

async function owned(ctx: MutationCtx, id: Id<'routines'>, version: number) {
  const { household, subject } = await adult(ctx), routine = await ctx.db.get(id)
  sameHousehold(routine, household._id)
  if (routine!.state === 'removed' || routine!.createdBy !== subject) throw new ConvexError('Only the adult who saved this routine can change it.')
  if (routine!.version !== version) throw new ConvexError('This routine changed. Reopen it before editing.')
  return { routine: routine!, household, subject }
}

async function cancelTimer(ctx: MutationCtx, routine: Doc<'routines'>) {
  if (!routine.timerId) return
  const timer = await ctx.db.system.get(routine.timerId)
  if (timer?.state.kind === 'pending') await ctx.scheduler.cancel(routine.timerId)
}

async function schedule(ctx: MutationCtx, id: Id<'routines'>, version: number, at: number) {
  return ctx.scheduler.runAt(at, internal.routines.run, { id, version, expectedAt: at })
}

async function saveVersion(ctx: MutationCtx, routine: Doc<'routines'>, definition: RoutineDefinition, state: 'active' | 'paused', subject: string) {
  const next = state === 'active' ? nextOccurrence(definition.schedule, Date.now()) : null
  if (state === 'active' && !next) throw new ConvexError('Choose a schedule with a future occurrence before enabling this routine.')
  await cancelTimer(ctx, routine)
  const version = routine.version + 1
  await ctx.db.insert('routineVersions', { householdId: routine.householdId, routineId: routine._id, version, definition, state, changedBy: subject, createdAt: Date.now() })
  const timerId = next ? await schedule(ctx, routine._id, version, next.at) : undefined
  await ctx.db.patch(routine._id, { definition, state, version, nextRunAt: next?.at, timerId, issue: undefined, updatedAt: Date.now() })
  return version
}

export const create = mutation({ args: { requestId: v.string(), definition: v.any(), enabled: v.boolean() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), requestId = args.requestId.trim()
  if (!requestId || requestId.length > 100) throw new ConvexError('This routine needs a valid request identifier.')
  const definition = checkedDefinition(args.definition, household), requestHash = sourceHash(JSON.stringify([definition, args.enabled]))
  const previous = await ctx.db.query('routines').withIndex('by_request', q => q.eq('householdId', household._id).eq('createdBy', subject).eq('requestId', requestId)).unique()
  if (previous) {
    if (previous.requestHash !== requestHash) throw new ConvexError('This request identifier was already used for another routine.')
    return previous._id // Retrying a deleted or edited creation never enables it again.
  }
  const saved = await visibleRoutines(ctx, household._id)
  if (saved.length >= 100) throw new ConvexError('This household has 100 saved routines. Remove one before adding another.')
  const next = args.enabled ? nextOccurrence(definition.schedule, Date.now()) : null
  if (args.enabled && !next) throw new ConvexError('Choose a schedule with a future occurrence before enabling this routine.')
  const state = args.enabled ? 'active' as const : 'paused' as const
  const id = await ctx.db.insert('routines', { householdId: household._id, createdBy: subject, requestId, requestHash, definition, version: 1, state, nextRunAt: next?.at, createdAt: Date.now(), updatedAt: Date.now() })
  await ctx.db.insert('routineVersions', { householdId: household._id, routineId: id, version: 1, definition, state, changedBy: subject, createdAt: Date.now() })
  if (next) await ctx.db.patch(id, { timerId: await schedule(ctx, id, 1, next.at) })
  return id
} })

export const settings = query({ args: {}, handler: async ctx => {
  await adult(ctx)
  return { preparationModelConfigured: !!(process.env.ANTHROPIC_API_KEY && process.env.DAYMARK_MODEL), catchUp: 'latest_only' as const, maxSaved: 100 }
} })

export const list = query({ args: {}, handler: async ctx => {
  const { household, subject } = await adult(ctx)
  return (await visibleRoutines(ctx, household._id))
    .map(({ requestId, requestHash, timerId, createdBy, ...routine }) => ({ ...routine, canEdit: createdBy === subject }))
} })

export const update = mutation({ args: { ...currentArgs, definition: v.any() }, handler: async (ctx, args) => {
  const { routine, household, subject } = await owned(ctx, args.id, args.version)
  return saveVersion(ctx, routine, checkedDefinition(args.definition, household), routine.state === 'active' ? 'active' : 'paused', subject)
} })

export const setPaused = mutation({ args: { ...currentArgs, paused: v.boolean() }, handler: async (ctx, args) => {
  const { routine, household, subject } = await owned(ctx, args.id, args.version)
  const state = args.paused ? 'paused' : 'active'
  if (routine.state === state) return routine.version
  // Resuming starts with the next future occurrence; intentionally paused dates are not missed runs.
  return saveVersion(ctx, routine, checkedDefinition(routine.definition, household), state, subject)
} })

export const remove = mutation({ args: currentArgs, handler: async (ctx, args) => {
  const { routine } = await owned(ctx, args.id, args.version)
  await cancelTimer(ctx, routine)
  await ctx.db.patch(routine._id, { state: 'removed', version: routine.version + 1, definition: undefined, nextRunAt: undefined, timerId: undefined, issue: undefined, updatedAt: Date.now() })
  await ctx.scheduler.runAfter(0, internal.routines.eraseVersions, { id: routine._id })
  // Keep a content-free creation marker and occurrence IDs. Existing tasks/receipts have their own lifecycle.
} })

export const versions = query({ args: { id: v.id('routines'), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), routine = await ctx.db.get(args.id)
  sameHousehold(routine, household._id)
  if (routine!.state === 'removed') throw new ConvexError('This routine was removed.')
  return ctx.db.query('routineVersions').withIndex('by_routine', q => q.eq('routineId', args.id)).order('desc').paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 50) })
} })

export const occurrences = query({ args: { id: v.id('routines'), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), routine = await ctx.db.get(args.id)
  sameHousehold(routine, household._id)
  const result = await ctx.db.query('routineOccurrences').withIndex('by_routine', q => q.eq('routineId', args.id)).order('desc').paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 50) })
  const page = await Promise.all(result.page.map(async occurrence => {
    if (occurrence.personalTaskId) {
      const task = await ctx.db.get(occurrence.personalTaskId)
      return { ...occurrence, status: !task || task.removed ? 'removed' : task.done ? 'done_by_parent' : 'needs_parent', summary: !task || task.removed ? 'The personal task was removed.' : task.done ? 'Marked done by the parent.' : 'Saved to Tasks for the parent to do.' }
    }
    const job = occurrence.jobId && await ctx.db.get(occurrence.jobId)
    if (!job) return { ...occurrence, status: 'unavailable', summary: 'The request is no longer available.' }
    const actions = await Promise.all((await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).collect()).map(async a => ({ ...a, status: a.status as ActionStatus, provider: a.approvalId ? (await ctx.db.get(a.approvalId))?.provider ?? 'google' : a.before?.provider, receipts: await ctx.db.query('receipts').withIndex('by_action', q => q.eq('actionId', a._id)).collect() })))
    const issue = await routineJobIssue(ctx, job)
    const status = job.cancelled ? 'cancelled' : jobStatus({ ...job, actions })
    return { ...occurrence, status: issue && status !== 'Finished' && status !== 'cancelled' ? 'Needs you' : status, summary: jobSummary({ ...job, actions }), ...(issue ? { issue } : {}) }
  }))
  return { ...result, page }
} })

async function runOccurrence(ctx: MutationCtx, args: { id: Id<'routines'>; version: number; expectedAt: number }): Promise<void> {
  const routine = await ctx.db.get(args.id), now = Date.now()
  if (!routine || routine.state !== 'active' || routine.version !== args.version || routine.nextRunAt !== args.expectedAt || args.expectedAt > now) return
  const household = await ctx.db.get(routine.householdId), member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', routine.createdBy)).unique()
  let definition: RoutineDefinition
  try {
    if (!household || household.deleted || member?.householdId !== household._id) throw new ConvexError('The adult who saved this routine no longer has household access.')
    definition = checkedDefinition(routine.definition, household)
  } catch {
    await cancelTimer(ctx, routine)
    await ctx.db.patch(routine._id, { state: 'blocked', issue: 'Household access or saved routine details changed. Review the routine before resuming.', nextRunAt: undefined, timerId: undefined, updatedAt: now })
    return
  }
  const occurrence = latestOccurrence(definition.schedule, now, args.expectedAt)
  if (!occurrence) { await ctx.db.patch(routine._id, { state: 'blocked', issue: 'The saved occurrence no longer matches its schedule. Review the routine.', nextRunAt: undefined, timerId: undefined }); return }
  const previous = await ctx.db.query('routineOccurrences').withIndex('by_occurrence', q => q.eq('routineId', routine._id).eq('localDate', occurrence.localDate)).unique()
  if (!previous) {
    const record = { householdId: routine.householdId, routineId: routine._id, version: routine.version, localDate: occurrence.localDate, scheduledAt: occurrence.at, ...(occurrence.at > args.expectedAt ? { caughtUpFrom: args.expectedAt } : {}), createdAt: now }
    const occurrenceId = await ctx.db.insert('routineOccurrences', record)
    if (definition.outcome.kind === 'personal_task') {
      const task = definition.outcome.task, dueDate = Temporal.PlainDate.from(occurrence.localDate).add({ days: definition.outcome.dueAfterDays }).toString()
      const personalTaskId = await ctx.db.insert('personalTasks', { householdId: routine.householdId, requestId: `routine-occurrence:${occurrenceId}`, requestHash: sourceHash(JSON.stringify([task, dueDate])), ...task, dueDate, done: false, version: 1, createdAt: now, updatedAt: now })
      await ctx.db.patch(occurrenceId, { personalTaskId })
    } else {
      const sourceId = await ctx.db.insert('sources', { householdId: routine.householdId, text: definition.outcome.instruction, attachmentIds: [], hash: `routine:${routine._id}:${occurrence.localDate}`, revision: 1, expiresAt: now + 30 * 86400_000 })
      const jobId = await ctx.db.insert('jobs', { householdId: routine.householdId, sourceId, createdBy: routine.createdBy, routineId: routine._id, routineVersion: routine.version, routineDate: occurrence.localDate, routineTimezone: definition.schedule.timezone, routineScheduledAt: occurrence.at, preparing: true, cancelled: false, clarification: '' })
      await ctx.db.patch(occurrenceId, { jobId })
      await start(ctx, internal.workflows.prepare, { jobId, sourceRevision: 1 })
    }
  }
  const next = nextOccurrence(definition.schedule, now)
  await cancelTimer(ctx, routine)
  const timerId = next ? await schedule(ctx, routine._id, routine.version, next.at) : undefined
  await ctx.db.patch(routine._id, { state: next ? 'active' : 'finished', nextRunAt: next?.at, timerId, lastRunAt: occurrence.at, updatedAt: now, issue: undefined })
}

export const run = internalMutation({ args: runArgs, handler: runOccurrence })

// The exact timer is the primary trigger. A bounded sweep recovers a missed/failed timer.
export const recover = internalMutation({ args: {}, handler: async (ctx): Promise<void> => {
  const due = await ctx.db.query('routines').withIndex('by_due', q => q.eq('state', 'active').gt('nextRunAt', 0).lte('nextRunAt', Date.now())).take(25)
  for (const routine of due) await ctx.scheduler.runAfter(0, internal.routines.run, { id: routine._id, version: routine.version, expectedAt: routine.nextRunAt! })
} })

export const eraseVersions = internalMutation({ args: { id: v.id('routines') }, handler: async (ctx, { id }): Promise<void> => {
  const routine = await ctx.db.get(id)
  if (!routine || routine.state !== 'removed') return
  const records = await ctx.db.query('routineVersions').withIndex('by_routine', q => q.eq('routineId', id)).take(50)
  for (const record of records) await ctx.db.delete(record._id)
  if (records.length === 50) await ctx.scheduler.runAfter(0, internal.routines.eraseVersions, { id })
} })
