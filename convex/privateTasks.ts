import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { adult } from './access'
import { privateTaskInputSchema, privateTaskKeepHash, type PrivateTask } from '../shared/privateTasks'
const versionArgs = { id: v.id('privateTasks'), version: v.number() }

/** Only explicit parent review boundaries call this. Model tools cannot save tasks. */
export const keep = internalMutation({ args: { householdId: v.id('households'), subject: v.string(), key: v.string(), title: v.string(), text: v.string(), done: v.optional(v.boolean()) }, handler: async (ctx, args): Promise<Id<'privateTasks'>> => {
  const household = await ctx.db.get(args.householdId), membership = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', args.subject)).unique()
  if (!household || household.deleted || membership?.householdId !== household._id) throw new ConvexError('Household access changed. This task was not saved.')
  if (!/^[A-Za-z0-9_-]{1,150}:[0-5]$/.test(args.key)) throw new ConvexError('Choose the original reviewed assistant task.')
  const input = privateTaskInputSchema.parse({ title: args.title, text: args.text }), done = args.done ?? false, keptHash = privateTaskKeepHash(input, done)
  const previous = await ctx.db.query('privateTasks').withIndex('by_key', q => q.eq('householdId', household._id).eq('createdBy', args.subject).eq('key', args.key)).unique()
  if (previous) {
    if (previous.keptHash !== keptHash) throw new ConvexError('This task was already kept with different details. Edit the saved task instead.')
    return previous._id // Replayed original decisions never overwrite later edits, completion or removal.
  }
  return ctx.db.insert('privateTasks', { householdId: household._id, createdBy: args.subject, key: args.key, keptHash, ...input, done, removed: false, version: 1, createdAt: Date.now(), updatedAt: Date.now() })
} })
export const list = query({ args: {}, handler: async (ctx): Promise<{ tasks: PrivateTask[]; limited: boolean }> => {
  const { household, subject } = await adult(ctx), rows = await ctx.db.query('privateTasks').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject).eq('removed', false)).order('desc').take(201)
  return { tasks: rows.slice(0, 200).map(row => ({ id: row._id, title: row.title, text: row.text, done: row.done, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt })), limited: rows.length > 200 }
} })
async function owned(ctx: MutationCtx, args: { id: Id<'privateTasks'>; version: number }) {
  const { household, subject } = await adult(ctx), row = await ctx.db.get(args.id)
  if (!row || row.householdId !== household._id || row.createdBy !== subject || row.removed) throw new ConvexError('This private task is unavailable.')
  if (row.version !== args.version) throw new ConvexError('This task changed. Reopen its latest version before editing.')
  return row
}
export const update = mutation({ args: { ...versionArgs, title: v.string(), text: v.string() }, handler: async (ctx, args) => {
  const row = await owned(ctx, args), input = privateTaskInputSchema.parse({ title: args.title, text: args.text })
  await ctx.db.patch(row._id, { ...input, version: row.version + 1, updatedAt: Date.now() })
  return row.version + 1
} })
export const setDone = mutation({ args: { ...versionArgs, done: v.boolean() }, handler: async (ctx, args) => {
  const row = await owned(ctx, args)
  if (row.done === args.done) return row.version
  await ctx.db.patch(row._id, { done: args.done, version: row.version + 1, updatedAt: Date.now() })
  return row.version + 1
} })
export const remove = mutation({ args: versionArgs, handler: async (ctx, args) => {
  const row = await owned(ctx, args)
  // A content-free decision marker prevents a delayed keep from resurrecting removed private work.
  await ctx.db.patch(row._id, { removed: true, title: '', text: '', version: row.version + 1, updatedAt: Date.now() })
} })
