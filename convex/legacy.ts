import { mutation, query } from './_generated/server'
import { v, ConvexError } from 'convex/values'
import { z } from 'zod'
import { itemSchema } from '../shared/household'
import { hash } from '../shared/daymark'
import { adult } from './access'
const snapshot = z.object({ items: z.array(z.unknown()).max(5000) })
export const importRecords = mutation({ args: { origin: v.union(v.literal('phone'), v.literal('sqlite-export')), json: v.string() }, handler: async (ctx, args) => {
  const { household } = await adult(ctx)
  if (args.json.length > 750000) throw new ConvexError('Import a legacy export under 750 KB.')
  const existing = await ctx.db.query('legacyRecords').withIndex('by_origin', q => q.eq('householdId', household._id).eq('origin', args.origin)).unique()
  if (existing) return existing.items.length
  const input = snapshot.parse(JSON.parse(args.json)), items = input.items.map(item => itemSchema.parse(item))
  await ctx.db.insert('legacyRecords', { householdId: household._id, origin: args.origin, fingerprint: hash(args.json), items, importedAt: Date.now() })
  // No old approvals, external-completion flags, drafts, or workflow starts are imported.
  return items.length
} })
export const list = query({ args: {}, handler: async ctx => {
  const { household } = await adult(ctx)
  return ctx.db.query('legacyRecords').withIndex('by_origin', q => q.eq('householdId', household._id)).collect()
} })
