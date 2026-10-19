import { ConvexError, v } from 'convex/values'
import { mutation, query, type MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { adult, sameHousehold } from './access'
import { personalTaskSchema, type PersonalTask, type PersonalTaskInput } from '../shared/tasks'
import { sourceHash } from '../shared/daymark'

const fields = { title: v.string(), notes: v.string(), dueDate: v.optional(v.string()), childId: v.optional(v.string()) }
function checkedInput(raw: PersonalTaskInput, children: { id: string }[]) {
  const value = personalTaskSchema.parse(raw)
  if (value.childId && !children.some(c => c.id === value.childId)) throw new ConvexError('Choose a child in this household.')
  return { ...value, childId: value.childId || undefined }
}
async function current(ctx: MutationCtx, id: Id<'personalTasks'>, version: number) {
  const { household } = await adult(ctx), task = await ctx.db.get(id)
  sameHousehold(task, household._id)
  if (task!.removed) throw new ConvexError('This task is unavailable.')
  if (task!.version !== version) throw new ConvexError('This task changed. Reopen it before editing.')
  return { task: task!, household }
}
export const list = query({ args: {}, handler: async (ctx): Promise<PersonalTask[]> => {
  const { household } = await adult(ctx)
  return (await ctx.db.query('personalTasks').withIndex('by_household', q => q.eq('householdId', household._id)).filter(q => q.neq(q.field('removed'), true)).order('desc').collect()).map(({ _id, _creationTime, householdId, requestId, requestHash, removed, ...task }) => ({ id: _id, ...task }))
} })
export const create = mutation({ args: { requestId: v.string(), ...fields }, handler: async (ctx, raw) => {
  const { household } = await adult(ctx), requestId = raw.requestId.trim()
  if (!requestId || requestId.length > 100) throw new ConvexError('This task needs a valid request identifier.')
  const value = checkedInput(raw, household.children), requestHash = sourceHash(JSON.stringify(value))
  const previous = await ctx.db.query('personalTasks').withIndex('by_request', q => q.eq('householdId', household._id).eq('requestId', requestId)).unique()
  if (previous) {
    if (previous.requestHash !== requestHash) throw new ConvexError('This request identifier was already used for a different task.')
    return previous._id
  }
  return ctx.db.insert('personalTasks', { householdId: household._id, requestId, requestHash, ...value, done: false, version: 1, createdAt: Date.now(), updatedAt: Date.now() })
} })
export const update = mutation({ args: { id: v.id('personalTasks'), version: v.number(), changes: v.object(fields) }, handler: async (ctx, args) => {
  const { task, household } = await current(ctx, args.id, args.version), value = checkedInput(args.changes, household.children)
  await ctx.db.patch(task._id, { ...value, dueDate: value.dueDate, version: task.version + 1, updatedAt: Date.now() })
} })
export const setDone = mutation({ args: { id: v.id('personalTasks'), version: v.number(), done: v.boolean() }, handler: async (ctx, args) => {
  const { task } = await current(ctx, args.id, args.version)
  if (task.done !== args.done) await ctx.db.patch(task._id, { done: args.done, version: task.version + 1, updatedAt: Date.now() })
} })
export const remove = mutation({ args: { id: v.id('personalTasks'), version: v.number() }, handler: async (ctx, args) => {
  const { task } = await current(ctx, args.id, args.version)
  for (const suggestion of await ctx.db.query('emailTaskSuggestions').withIndex('by_personal_task', q => q.eq('personalTaskId', task._id)).collect()) await ctx.db.patch(suggestion._id, { title: 'Removed task', notes: '', dueDate: undefined, childId: undefined, evidence: [], issue: 'The saved task was removed. It will not be restored by a repeated save.' })
  // Keep only the idempotency marker; a delayed create retry must not restore deleted work.
  await ctx.db.patch(task._id, { removed: true, title: '', notes: '', childId: undefined, dueDate: undefined, done: false, version: task.version + 1, updatedAt: Date.now() })
} })
