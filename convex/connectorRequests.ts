import { ConvexError, v } from 'convex/values'
import { query, mutation } from './_generated/server'
import { adult } from './access'
import { connectorRequestSchema, connectorRequestKey, connectorRequestId, connectorRequestLimit, type ConnectorRequest } from '../shared/connectorRequests'
import { sourceHash } from '../shared/daymark'

export const list = query({ args: {}, handler: async (ctx): Promise<ConnectorRequest[]> => {
  const { household, subject } = await adult(ctx)
  const records = await ctx.db.query('connectorRequests').withIndex('by_owner_status', q => q.eq('householdId', household._id).eq('requestedBy', subject).eq('status', 'requested')).order('desc').take(connectorRequestLimit)
  return records.map(({ _id, service, outcome, status, version, createdAt, updatedAt }) => ({ id: _id, service, outcome, status, version, createdAt, updatedAt }))
} })
export const create = mutation({ args: { requestId: v.string(), service: v.optional(v.string()), outcome: v.string() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), requestId = connectorRequestId(args.requestId)
  const value = connectorRequestSchema.parse({ service: args.service, outcome: args.outcome }), requestHash = sourceHash(connectorRequestKey(value))
  const previous = await ctx.db.query('connectorRequestKeys').withIndex('by_request', q => q.eq('householdId', household._id).eq('requestedBy', subject).eq('requestId', requestId)).unique()
  if (previous) { if (previous.requestHash !== requestHash) throw new ConvexError('This identifier was already used for a different connector request.'); return previous.connectorRequestId }
  const identical = await ctx.db.query('connectorRequests').withIndex('by_open_request', q => q.eq('householdId', household._id).eq('requestedBy', subject).eq('status', 'requested').eq('requestHash', requestHash)).unique()
  const now = Date.now()
  let id = identical?._id
  if (!id) {
    const open = await ctx.db.query('connectorRequests').withIndex('by_owner_status', q => q.eq('householdId', household._id).eq('requestedBy', subject).eq('status', 'requested')).take(connectorRequestLimit)
    if (open.length >= connectorRequestLimit) throw new ConvexError('Dismiss an existing connector request before saving another.')
    id = await ctx.db.insert('connectorRequests', { householdId: household._id, requestedBy: subject, requestHash, ...value, status: 'requested', version: 1, createdAt: now, updatedAt: now })
  }
  await ctx.db.insert('connectorRequestKeys', { householdId: household._id, requestedBy: subject, requestId, requestHash, connectorRequestId: id })
  return id
} })
export const dismiss = mutation({ args: { id: v.id('connectorRequests'), version: v.number() }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx), request = await ctx.db.get(args.id)
  if (!request || request.householdId !== household._id || request.requestedBy !== subject) throw new ConvexError('This connector request is unavailable.')
  if (request.version !== args.version || request.status !== 'requested') throw new ConvexError('This connector request changed. Reopen the latest version.')
  // Retain only the identity and deduplication markers; a delayed retry cannot restore dismissed text.
  await ctx.db.patch(request._id, { service: undefined, outcome: '', status: 'dismissed', version: request.version + 1, updatedAt: Date.now() })
} })
