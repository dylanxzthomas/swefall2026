import { v, ConvexError } from 'convex/values'
import { mutation, query, type QueryCtx, type MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { adult, sameHousehold } from './access'
import { checkedFamilyFact, factScope } from './memoryRules'
import { MEMORY_PROPOSAL_TTL, parseMemoryCandidate, parseMemoryRequest, type MemoryProposal } from '../shared/memoryProposals'
import { sourceHash } from '../shared/daymark'

async function checkedSource(ctx: QueryCtx | MutationCtx, householdId: Id<'households'>, subject: string, jobId?: Id<'jobs'>, revision?: number) {
  if (!jobId) { if (revision !== undefined) throw new ConvexError('Choose the original request.'); return }
  const job = await ctx.db.get(jobId), source = job && await ctx.db.get(job.sourceId)
  if (!job || job.householdId !== householdId || job.createdBy !== subject || job.cancelled || !source || !source.text && !source.attachmentIds?.length || source.householdId !== householdId || source.revision !== revision || source.expiresAt <= Date.now()) throw new ConvexError('The supporting request is unavailable or changed. Make a fresh memory request.')
  return source
}

async function ownedProposal(ctx: QueryCtx | MutationCtx, id: Id<'memoryProposals'>, version: number) {
  const { household, subject } = await adult(ctx), proposal = await ctx.db.get(id)
  if (!proposal || proposal.householdId !== household._id || proposal.subject !== subject) throw new ConvexError('This memory suggestion is unavailable.')
  if (proposal.version !== version || proposal.status !== 'proposed' || proposal.expiresAt <= Date.now()) throw new ConvexError('This memory suggestion changed or expired. Open its latest version.')
  return { household, subject, proposal }
}

export const list = query({ args: {}, handler: async (ctx): Promise<MemoryProposal[]> => {
  const { household, subject } = await adult(ctx)
  const proposals = await ctx.db.query('memoryProposals').withIndex('by_adult', q => q.eq('householdId', household._id).eq('subject', subject).eq('status', 'proposed')).order('desc').take(100)
  return proposals.filter(p => p.expiresAt > Date.now() && p.text).map(p => ({ _id: p._id, version: p.version, text: p.text!, ...(p.value ? { value: p.value } : {}), createdAt: p.createdAt, expiresAt: p.expiresAt }))
} })

export const propose = mutation({ args: { requestId: v.string(), text: v.string(), value: v.optional(v.any()), sourceJobId: v.optional(v.id('jobs')), sourceRevision: v.optional(v.number()) }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), request = parseMemoryRequest(args.text), requestId = args.requestId.trim()
  if (!request || !requestId || requestId.length > 100) throw new ConvexError('Start with “Remember …” and keep the detail under 2,000 characters.')
  const value = args.value === undefined ? undefined : await checkedFamilyFact(ctx, household, args.value)
  const requestHash = sourceHash(JSON.stringify({ text: request.text, value: value ?? null, sourceJobId: args.sourceJobId ?? null, sourceRevision: args.sourceRevision ?? null }))
  const previous = await ctx.db.query('memoryProposals').withIndex('by_request', q => q.eq('householdId', household._id).eq('subject', subject).eq('requestId', requestId)).unique()
  if (previous) {
    if (previous.requestHash !== requestHash) throw new ConvexError('This identifier belongs to a different memory request.')
    return previous._id
  }
  const supportingSource = await checkedSource(ctx, household._id, subject, args.sourceJobId, args.sourceRevision)
  const pending = await ctx.db.query('memoryProposals').withIndex('by_adult', q => q.eq('householdId', household._id).eq('subject', subject).eq('status', 'proposed')).take(100)
  for (const expired of pending.filter(p => p.expiresAt <= Date.now())) await ctx.db.patch(expired._id, { status: 'dismissed', version: expired.version + 1, text: undefined, value: undefined, sourceJobId: undefined, sourceRevision: undefined })
  if (pending.filter(p => p.expiresAt > Date.now()).length === 100) throw new ConvexError('Review or dismiss your existing memory suggestions first.')
  return ctx.db.insert('memoryProposals', { householdId: household._id, subject, requestId, requestHash, version: 1, status: 'proposed', text: request.text, ...(value ? { value } : {}), ...(args.sourceJobId ? { sourceJobId: args.sourceJobId, sourceRevision: args.sourceRevision } : {}), createdAt: Date.now(), expiresAt: Math.min(Date.now() + MEMORY_PROPOSAL_TTL, supportingSource?.expiresAt ?? Infinity) })
} })

export const confirm = mutation({ args: { id: v.id('memoryProposals'), version: v.number(), value: v.any(), replaceFactId: v.optional(v.id('memoryFacts')), replaceFactVersion: v.optional(v.number()) }, handler: async (ctx, args) => {
  const { household, subject, proposal } = await ownedProposal(ctx, args.id, args.version)
  await checkedSource(ctx, household._id, subject, proposal.sourceJobId, proposal.sourceRevision)
  const value = await checkedFamilyFact(ctx, household, args.value)
  const previous = args.replaceFactId ? await ctx.db.get(args.replaceFactId) : null
  if (args.replaceFactId) {
    sameHousehold(previous, household._id)
    if (!previous!.key.startsWith('family:') || previous!.version !== args.replaceFactVersion) throw new ConvexError('This saved detail changed. Review its latest version before replacing it.')
  } else if (args.replaceFactVersion !== undefined) throw new ConvexError('Choose the saved detail to replace.')
  // A retry or repeated wording cannot add an identical confirmed fact twice.
  const facts = await ctx.db.query('memoryFacts').withIndex('by_key', q => q.eq('householdId', household._id)).collect()
  const identical = facts.find(f => f.confirmed && f.key.startsWith('family:') && sourceHash(JSON.stringify(parseMemoryCandidate(f.value))) === sourceHash(JSON.stringify(value)))
  const fact = { householdId: household._id, key: previous?.key ?? `family:${crypto.randomUUID()}`, value, source: 'Adult-confirmed memory request', confirmed: true, updatedAt: Date.now(), version: (previous?.version ?? 0) + 1, scope: factScope(value) }
  let factId: Id<'memoryFacts'>
  if (previous) { await ctx.db.patch(previous._id, fact); factId = previous._id }
  else factId = identical?._id ?? await ctx.db.insert('memoryFacts', fact)
  await ctx.db.patch(proposal._id, { status: 'confirmed', version: proposal.version + 1, confirmedFactId: factId, text: undefined, value: undefined, sourceJobId: undefined, sourceRevision: undefined })
  return factId
} })

export const dismiss = mutation({ args: { id: v.id('memoryProposals'), version: v.number() }, handler: async (ctx, args) => {
  const { proposal } = await ownedProposal(ctx, args.id, args.version)
  await ctx.db.patch(proposal._id, { status: 'dismissed', version: proposal.version + 1, text: undefined, value: undefined, sourceJobId: undefined, sourceRevision: undefined })
} })

/** Erase unconfirmed content, retaining only a request tombstone to prevent retry resurrection. */
export async function expireMemoryProposals(ctx: MutationCtx) {
  const expired = await ctx.db.query('memoryProposals').withIndex('by_expiry', q => q.eq('status', 'proposed').lte('expiresAt', Date.now())).take(100)
  for (const proposal of expired) await ctx.db.patch(proposal._id, { status: 'dismissed', version: proposal.version + 1, text: undefined, value: undefined, sourceJobId: undefined, sourceRevision: undefined })
}
