import { query, mutation } from './_generated/server'
import { v, ConvexError } from 'convex/values'
import { adult, sameHousehold } from './access'
import { checkedFamilyFact, factScope } from './memoryRules'
export const list = query({ args: {}, handler: async ctx => {
  const { household } = await adult(ctx)
  return ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', household._id)).collect()
} })
export const save = mutation({ args: { id: v.optional(v.id('memoryFacts')), version: v.optional(v.number()), value: v.any() }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), value = await checkedFamilyFact(ctx, household, args.value)
  const previous = args.id ? await ctx.db.get(args.id) : null
  if (args.id) { sameHousehold(previous, household._id); if (previous!.version !== args.version) throw new ConvexError('This saved fact changed. Open its latest version.') }
  const fact = { householdId: household._id, key: previous?.key ?? `family:${crypto.randomUUID()}`, value, source: 'Adult-confirmed household settings', confirmed: true, updatedAt: Date.now(), version: (previous?.version ?? 0) + 1, scope: factScope(value) }
  if (previous) { await ctx.db.patch(previous._id, fact); return previous._id }
  return ctx.db.insert('memoryFacts', fact)
} })
export const remove = mutation({ args: { id: v.id('memoryFacts'), version: v.number() }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), fact = await ctx.db.get(args.id)
  sameHousehold(fact, household._id)
  if (!fact!.key.startsWith('family:') || fact!.version !== args.version) throw new ConvexError('Open the latest saved fact before removing it.')
  await ctx.db.delete(args.id)
} })
