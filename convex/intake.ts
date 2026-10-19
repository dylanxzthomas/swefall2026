import { v } from 'convex/values'
import { query, internalMutation, internalQuery } from './_generated/server'
import { adult, sameHousehold, readableAttachment } from './access'
import { internal } from './_generated/api'
export const accepted = internalMutation({ args: { storageId: v.id('_storage'), name: v.string(), size: v.number(), mediaType: v.string() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx)
  const id = await ctx.db.insert('attachments', { ...args, householdId: household._id, subject, status: 'checking', expiresAt: Date.now() + 30 * 86400_000 })
  await ctx.scheduler.runAfter(0, internal.files.validate, { id })
  return id
} })
export const status = query({ args: { ids: v.array(v.id('attachments')) }, handler: async (ctx, { ids }) => {
  const { household, subject } = await adult(ctx)
  if (ids.length > 5) return []
  return Promise.all(ids.map(async id => { const file = await ctx.db.get(id); sameHousehold(file, household._id); await readableAttachment(ctx, file!, subject); return { id, name: file!.name, status: file!.status, error: file!.error } }))
} })
export const privateFile = internalQuery({ args: { id: v.id('attachments') }, handler: (ctx, { id }) => ctx.db.get(id) })
export const validated = internalMutation({ args: { id: v.id('attachments'), hash: v.optional(v.string()), storageId: v.optional(v.id('_storage')), mediaType: v.optional(v.string()), size: v.optional(v.number()), name: v.optional(v.string()), error: v.optional(v.string()) }, handler: async (ctx, args) => {
  const file = await ctx.db.get(args.id)
  if (!file || file.status !== 'checking') return false
  await ctx.db.patch(file._id, { hash: args.hash, status: args.error ? 'rejected' : 'ready', error: args.error, ...(args.storageId ? { storageId: args.storageId, mediaType: args.mediaType!, size: args.size ?? file.size, name: args.name ?? file.name } : {}) })
  return true
} })

export const readable = internalQuery({ args: { id: v.id('attachments') }, handler: async (ctx, { id }) => {
  const { household, subject } = await adult(ctx), file = await ctx.db.get(id)
  sameHousehold(file, household._id)
  await readableAttachment(ctx, file!, subject)
  return file?.status === 'ready' && file.expiresAt > Date.now() ? { storageId: file.storageId, mediaType: file.mediaType } : null
} })
