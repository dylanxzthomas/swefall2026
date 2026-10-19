import { v, ConvexError } from 'convex/values'
import { action, mutation, query, internalMutation, internalQuery, type QueryCtx, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { adult, sameHousehold, readableJob, readableAttachment } from './access'
import { defaultPreferences, libraryChangesSchema, preferencesSchema, validateLibraryFiles, type LibraryItem } from '../shared/library'
import { assistantName } from '../shared/persona'

export const list = query({ args: {}, handler: async (ctx): Promise<LibraryItem[]> => {
  const { household } = await adult(ctx)
  return (await ctx.db.query('library').withIndex('by_household', q => q.eq('householdId', household._id)).order('desc').collect()).map(({ _id, _creationTime, householdId, storageId, ...item }) => ({ id: _id, ...item }))
} })
export const preferences = query({ args: {}, handler: async ctx => {
  const { household, subject } = await adult(ctx), preference = await ctx.db.query('personalPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  return preference?.householdId === household._id ? { parentName: preference.parentName, assistantName: assistantName(preference), avatar: preference.avatar ?? 'robin' as const } : defaultPreferences
} })
export const savePreferences = mutation({ args: { parentName: v.string(), assistantName: v.string(), avatar: v.optional(v.union(v.literal('robin'), v.literal('initial'))) }, handler: async (ctx, raw) => {
  const { household, subject } = await adult(ctx), value = preferencesSchema.parse(raw)
  const previous = await ctx.db.query('personalPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  const avatar = raw.avatar ?? previous?.avatar ?? 'robin'
  if (previous) { sameHousehold(previous, household._id); await ctx.db.patch(previous._id, { ...value, avatar }) }
  else await ctx.db.insert('personalPreferences', { householdId: household._id, subject, ...value, avatar })
} })
export const saveArtifact = mutation({ args: { actionId: v.id('actions') }, handler: async (ctx, { actionId }) => {
  const { household } = await adult(ctx), a = await ctx.db.get(actionId)
  sameHousehold(a, household._id)
  const previous = await ctx.db.query('library').withIndex('by_action', q => q.eq('householdId', household._id).eq('actionId', actionId)).unique()
  if (previous) return previous._id
  const p = a!.payload, title = (p.kind === 'calendar' ? p.title : p.kind === 'email' ? p.subject : 'Pickup request').trim().slice(0, 200) || 'Untitled deliverable'
  return ctx.db.insert('library', { householdId: household._id, kind: 'artifact', title, collection: '', ...(p.childId ? { childId: p.childId } : {}), pinned: false, createdAt: Date.now(), version: 1, actionId, jobId: a!.jobId })
} })
export const update = mutation({ args: { id: v.id('library'), version: v.number(), changes: v.object({ title: v.string(), collection: v.string(), childId: v.optional(v.string()), pinned: v.boolean() }) }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), item = await ctx.db.get(args.id), changes = libraryChangesSchema.parse(args.changes)
  sameHousehold(item, household._id)
  if (item!.version !== args.version) throw new ConvexError('This Library item changed. Reopen it before editing.')
  if (changes.childId && !household.children.some(c => c.id === changes.childId)) throw new ConvexError('Choose a child in this household.')
  await ctx.db.patch(item!._id, { ...changes, childId: changes.childId || undefined, version: item!.version + 1 })
} })
export const remove = mutation({ args: { id: v.id('library'), version: v.number() }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), item = await ctx.db.get(args.id)
  sameHousehold(item, household._id)
  if (item!.version !== args.version) throw new ConvexError('This Library item changed. Reopen it before removing it.')
  if (item!.storageId) await ctx.storage.delete(item!.storageId)
  await ctx.db.delete(item!._id)
} })
async function readableSources(ctx: QueryCtx | MutationCtx, ids: Id<'attachments'>[], jobId?: Id<'jobs'>) {
  const { household, subject } = await adult(ctx)
  if (!ids.length || ids.length > 5 || new Set(ids).size !== ids.length) throw new ConvexError('Choose up to five different files.')
  if (jobId) {
    const job = await ctx.db.get(jobId); sameHousehold(job, household._id)
    readableJob(job, subject)
    const source = job && await ctx.db.get(job.sourceId)
    if (!source || source.expiresAt <= Date.now() || ids.some(id => !source.attachmentIds?.includes(id))) throw new ConvexError('The original file expired or is no longer part of this request.')
  }
  const files = await Promise.all(ids.map(async id => {
    const file = await ctx.db.get(id); sameHousehold(file, household._id)
    await readableAttachment(ctx, file!, subject)
    if (file!.status !== 'ready' || file!.expiresAt <= Date.now() || !file!.hash) throw new ConvexError('Wait for a valid file to finish checking before saving it.')
    return file!
  }))
  validateLibraryFiles(files)
  return { household, files }
}
export const copyContext = internalMutation({ args: { ids: v.array(v.id('attachments')), jobId: v.optional(v.id('jobs')) }, handler: async (ctx, args) => {
  const { files } = await readableSources(ctx, args.ids, args.jobId)
  // Record a rollout boundary before writing any copies. Cleanup preserves preexisting, unclassified blobs.
  const cleanup = await ctx.db.query('storageCleanup').withIndex('by_key', q => q.eq('key', 'private-files')).unique()
  if (!cleanup) await ctx.db.insert('storageCleanup', { key: 'private-files', since: Date.now() })
  return files.map(f => ({ id: f._id, storageId: f.storageId, hash: f.hash!, name: f.name, size: f.size, mediaType: f.mediaType }))
} })
export const copied = internalMutation({ args: { files: v.array(v.object({ id: v.id('attachments'), storageId: v.id('_storage'), hash: v.string() })), jobId: v.optional(v.id('jobs')), collection: v.string(), childId: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { household, files } = await readableSources(ctx, args.files.map(f => f.id), args.jobId)
  const metadata = libraryChangesSchema.parse({ title: 'Saved file', collection: args.collection, childId: args.childId, pinned: false })
  if (metadata.childId && !household.children.some(c => c.id === metadata.childId)) throw new ConvexError('Choose a child in this household.')
  const result: { id: Id<'library'>; usedStorageId?: Id<'_storage'> }[] = []
  for (const copy of args.files) {
    const file = files.find(f => f._id === copy.id)!
    const storedCopy = await ctx.db.system.get(copy.storageId)
    if (!storedCopy || storedCopy.sha256 !== file.hash || storedCopy.size !== file.size) throw new ConvexError('This saved copy could not be verified. Select the current file again.')
    if (file.hash !== copy.hash) throw new ConvexError('This file changed. Select the current file again.')
    const previous = await ctx.db.query('library').withIndex('by_file', q => q.eq('householdId', household._id).eq('fileId', file._id)).unique()
    if (previous) { result.push({ id: previous._id }); continue }
    // Library owns a distinct storage object: source expiry cannot remove an explicitly kept file.
    const id = await ctx.db.insert('library', { householdId: household._id, kind: 'media', title: file.name || 'Saved file', collection: metadata.collection, childId: metadata.childId, pinned: false, createdAt: Date.now(), version: 1, fileId: file._id, ...(args.jobId ? { jobId: args.jobId } : {}), storageId: copy.storageId, mediaType: file.mediaType, size: file.size })
    result.push({ id, usedStorageId: copy.storageId })
  }
  return result
} })
export const saveFiles = action({ args: { ids: v.array(v.id('attachments')), jobId: v.optional(v.id('jobs')), collection: v.string(), childId: v.optional(v.string()) }, handler: async (ctx, args): Promise<string[]> => {
  const files = await ctx.runMutation(internal.library.copyContext, { ids: args.ids, ...(args.jobId ? { jobId: args.jobId } : {}) })
  const copies: { id: Id<'attachments'>; storageId: Id<'_storage'>; hash: string }[] = []
  let committed = false
  try {
    for (const file of files) {
      const source = await ctx.storage.get(file.storageId)
      if (!source) throw new ConvexError('The original file is no longer available.')
      const storageId = await ctx.storage.store(new Blob([await source.arrayBuffer()], { type: file.mediaType }))
      copies.push({ id: file.id, storageId, hash: file.hash })
    }
    const result = await ctx.runMutation(internal.library.copied, { files: copies, collection: args.collection, ...(args.childId ? { childId: args.childId } : {}), ...(args.jobId ? { jobId: args.jobId } : {}) })
    committed = true
    const used = new Set(result.flatMap(item => item.usedStorageId ? [item.usedStorageId] : []))
    await ctx.runMutation(internal.library.discardCopies, { ids: copies.filter(copy => !used.has(copy.storageId)).map(copy => copy.storageId) })
    return result.map(item => item.id)
  } catch (error) { if (!committed) await ctx.runMutation(internal.library.discardCopies, { ids: copies.map(copy => copy.storageId) }); throw error }
} })
export const readable = internalQuery({ args: { id: v.id('library') }, handler: async (ctx, { id }) => {
  const { household } = await adult(ctx), item = await ctx.db.get(id)
  sameHousehold(item, household._id)
  return item?.kind === 'media' && item.storageId ? { storageId: item.storageId, mediaType: item.mediaType } : null
} })

export const discardCopies = internalMutation({ args: { ids: v.array(v.id('_storage')) }, handler: async (ctx, args) => {
  if (args.ids.length > 5) throw new ConvexError('Only one file batch can be cleaned at a time.')
  for (const id of args.ids) {
    // A lost mutation response does not prove commit failed. Never discard a referenced copy.
    const kept = await ctx.db.query('library').withIndex('by_storage', q => q.eq('storageId', id)).first()
    const original = await ctx.db.query('attachments').withIndex('by_storage', q => q.eq('storageId', id)).first()
    if (!kept && !original) await ctx.storage.delete(id)
  }
} })
