import { mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import { adult, remember } from './access'
import { validTimezone } from '../shared/daymark'
export const current = query({ args: {}, handler: async ctx => {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) return null
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', identity.tokenIdentifier)).unique()
  return member ? ctx.db.get(member.householdId) : null
} })
export const saveName = mutation({ args: { name: v.string() }, handler: async (ctx, args) => {
  const { household } = await adult(ctx), name = args.name.trim()
  if (!name || name.length > 80) throw new ConvexError('Give your household a name of up to 80 characters.')
  await ctx.db.patch(household._id, { name })
} })
export const save = mutation({ args: { timezone: v.string(), children: v.array(v.object({ id: v.string(), name: v.string() })) }, handler: async (ctx, args) => {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new ConvexError('Sign in first.')
  const deletion = await ctx.db.query('deletionJobs').withIndex('by_subject', q => q.eq('subject', identity.tokenIdentifier)).first()
  if (deletion) throw new ConvexError('Account deletion is still finishing. Household access remains disabled.')
  if (!validTimezone(args.timezone) || args.children.length > 20 || args.children.some(c => !c.name.trim() || c.name.length > 80 || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id)) || new Set(args.children.map(c => c.id)).size !== args.children.length) throw new ConvexError('Confirm valid household details.')
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', identity.tokenIdentifier)).unique()
  if (member) {
    await adult(ctx)
    await ctx.db.patch(member.householdId, args)
    await remember(ctx, member.householdId, 'timezone', args.timezone)
    await remember(ctx, member.householdId, 'children', args.children)
    return member.householdId
  }
  const householdId = await ctx.db.insert('households', { ...args, deleted: false })
  await remember(ctx, householdId, 'timezone', args.timezone)
  await remember(ctx, householdId, 'children', args.children)
  await ctx.db.insert('memberships', { householdId, subject: identity.tokenIdentifier, role: 'adult' })
  return householdId
} })
