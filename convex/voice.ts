import { ConvexError, v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query, type QueryCtx, type MutationCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { adult } from './access'
import { sourceHash } from '../shared/daymark'
import { validAssistantRun } from './assistantCoordinator'
import { voiceLimits, voiceModel, type VoiceSettings, type VoiceToolResult } from '../shared/voice'

type Context = Pick<QueryCtx, 'db'>
const toolsAvailable = () => !!process.env.ANTHROPIC_API_KEY && !!process.env.DAYMARK_MODEL
const configured = () => !!process.env.OPENAI_API_KEY && process.env.DAYMARK_VOICE_MODEL === voiceModel
async function currentOwner(ctx: Context, row: Doc<'voiceSessions'>) {
  const household = await ctx.db.get(row.householdId), membership = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', row.createdBy)).unique()
  return !!household && !household.deleted && membership?.householdId === row.householdId
}
export const settings = query({ args: {}, handler: async (ctx): Promise<VoiceSettings> => {
  const { household, subject } = await adult(ctx)
  const active = (await ctx.db.query('voiceSessions').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(30)).find(r => ['starting', 'active'].includes(r.status) && r.expiresAt > Date.now())
  return { configured: configured(), ...(configured() && toolsAvailable() ? { toolsAvailable: true } : {}), ...(configured() ? { model: voiceModel } : {}), ...(active ? { active: { id: active._id, version: active.version, expiresAt: active.expiresAt, status: active.status as 'starting' | 'active' } } : {}) }
} })
export const reserve = mutation({ args: { requestId: v.string(), consent: v.literal(true), toolsConsent: v.optional(v.literal(true)) }, handler: async (ctx, args): Promise<{ toolsEnabled: boolean; id: Id<'voiceSessions'>; version: number; assistantName: string; householdName: string; expiresAt: number } | null> => {
  const { household, subject } = await adult(ctx)
  if (!configured()) throw new ConvexError('Live voice is not configured. Use dictation or type a message.')
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.requestId)) throw new ConvexError('Start voice again from the current conversation.')
  const duplicate = await ctx.db.query('voiceSessions').withIndex('by_request', q => q.eq('householdId', household._id).eq('createdBy', subject).eq('requestId', args.requestId)).unique()
  if (duplicate) return null
  const recent = await ctx.db.query('voiceSessions').withIndex('by_owner', q => q.eq('householdId', household._id).eq('createdBy', subject)).order('desc').take(30)
  if (recent.some(r => ['starting', 'active'].includes(r.status) && r.expiresAt > Date.now())) throw new ConvexError('Stop your current voice conversation before starting another.')
  if (recent.filter(r => r.createdAt > Date.now() - 3600_000).length >= voiceLimits.startsPerHour || recent.filter(r => r.createdAt > Date.now() - 86400_000).length >= voiceLimits.startsPerDay) throw new ConvexError('Voice has reached its current usage limit. Please continue by typing.')
  const expiresAt = Date.now() + voiceLimits.sessionMs, toolsEnabled = args.toolsConsent === true && toolsAvailable()
  const id = await ctx.db.insert('voiceSessions', { householdId: household._id, createdBy: subject, requestId: args.requestId, toolsEnabled, version: 1, status: 'starting', createdAt: Date.now(), expiresAt, leaseUntil: Date.now() + voiceLimits.setupMs })
  await ctx.scheduler.runAfter(voiceLimits.setupMs + 1000, internal.voice.abandoned, { id, version: 1 })
  const preference = await ctx.db.query('personalPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  return { id, version: 1, toolsEnabled, assistantName: preference?.householdId === household._id ? preference.assistantName : 'Sola', householdName: household.name ?? 'Your household', expiresAt }
} })
export const permitted = internalQuery({ args: { id: v.id('voiceSessions'), version: v.number() }, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  return !!row && row.version === args.version && configured() && ['starting', 'active'].includes(row.status) && row.expiresAt > Date.now() && (row.status !== 'starting' || (row.leaseUntil ?? 0) > Date.now()) && await currentOwner(ctx, row)
} })
export const started = internalMutation({ args: { id: v.id('voiceSessions'), version: v.number(), providerCallId: v.string() }, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.version !== args.version || row.status !== 'starting' || row.expiresAt <= Date.now() || (row.leaseUntil ?? 0) <= Date.now() || !configured() || !await currentOwner(ctx, row)) return false
  if (!/^rtc_[A-Za-z0-9_-]{1,180}$/.test(args.providerCallId)) throw new Error('Invalid voice provider session.')
  await ctx.db.patch(row._id, { status: 'active', providerCallId: args.providerCallId, leaseUntil: undefined })
  await ctx.scheduler.runAfter(30000, internal.realtimeVoice.check, { id: row._id, version: row.version, providerCallId: args.providerCallId })
  return true
} })
export const failed = internalMutation({ args: { id: v.id('voiceSessions'), version: v.number(), failureCategory: v.optional(v.union(v.literal('quota'),v.literal('rate_limit'),v.literal('authentication'),v.literal('model_access'),v.literal('invalid_configuration'),v.literal('provider_unavailable'))), failureStatus: v.optional(v.number()) }, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.version !== args.version || row.status !== 'starting') return
  const diagnostic = args.failureCategory && Number.isInteger(args.failureStatus) && args.failureStatus! >= 400 && args.failureStatus! <= 599 ? ` (${args.failureCategory}; HTTP ${args.failureStatus})` : ''
  await ctx.db.patch(row._id, { status: 'failed', version: row.version + 1, leaseUntil: undefined, issue: `Voice could not connect${diagnostic}. No audio or transcript was saved by Sola.` })
} })
export const abandoned = internalMutation({ args: { id: v.id('voiceSessions'), version: v.number() }, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (row?.status === 'starting' && row.version === args.version && (row.leaseUntil ?? 0) <= Date.now()) await ctx.db.patch(row._id, { status: 'failed', version: row.version + 1, leaseUntil: undefined, issue: 'Voice setup expired. Start a new conversation.' })
} })
async function stopRow(ctx: MutationCtx, row: Doc<'voiceSessions'>) {
  const version = row.version + 1
  await ctx.db.patch(row._id, { status: 'stopped', version, leaseUntil: undefined })
  if (row.providerCallId) await ctx.scheduler.runAfter(0, internal.realtimeVoice.close, { id: row._id, providerCallId: row.providerCallId })
  return version
}
export const stop = mutation({ args: { id: v.id('voiceSessions'), version: v.number() }, handler: async (ctx, args): Promise<number> => {
  const { household, subject } = await adult(ctx), row = await ctx.db.get(args.id)
  if (!row || row.householdId !== household._id || row.createdBy !== subject) throw new ConvexError('This private voice session is unavailable.')
  if (row.status === 'stopped' || row.status === 'failed') return row.version
  if (row.version !== args.version) throw new ConvexError('This voice session changed. Reopen its current controls.')
  return stopRow(ctx, row)
} })
export const ended = internalMutation({ args: { id: v.id('voiceSessions'), providerCallId: v.string(), confirmed: v.boolean() }, handler: async (ctx, args) => {
  const row = await ctx.db.get(args.id)
  if (!row || row.providerCallId !== args.providerCallId) return
  await ctx.db.patch(row._id, { status: 'stopped', version: row.status === 'stopped' ? row.version : row.version + 1, leaseUntil: undefined, providerCallId:args.confirmed?undefined:row.providerCallId,issue: args.confirmed ? undefined : 'Microphone stopped. Provider session closure could not be confirmed.' })
} })

async function activeToolSession(ctx: QueryCtx | MutationCtx, id: Id<'voiceSessions'>, version: number) {
  const { household, subject } = await adult(ctx), row = await ctx.db.get(id)
  if (!row || row.householdId !== household._id || row.createdBy !== subject || row.status !== 'active' || row.version !== version || row.expiresAt <= Date.now() || !row.toolsEnabled || !configured() || !toolsAvailable()) throw new ConvexError('This private voice request is unavailable. Continue in the text conversation.')
  return row
}
/** A voice model can request preparation, never share a task or approve an action. */
export const request = mutation({ args: { id: v.id('voiceSessions'), version: v.number(), callId: v.string(), text: v.string() }, handler: async (ctx, args): Promise<{ requestId: Id<'voiceRequests'>; jobId: Id<'jobs'> }> => {
  const session = await activeToolSession(ctx, args.id, args.version)
  const text = args.text.trim()
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(args.callId) || !text || args.text.length > voiceLimits.transcriptCharacters) throw new ConvexError('Ask Sola a shorter request in this voice conversation.')
  const inputHash = sourceHash(text)
  const old = await ctx.db.query('voiceRequests').withIndex('by_call', q => q.eq('sessionId', session._id).eq('callId', args.callId)).unique()
  if (old) {
    if (old.createdBy !== session.createdBy || old.householdId !== session.householdId || old.sessionVersion !== session.version || old.inputHash !== inputHash || old.expiresAt <= Date.now() || !await ctx.db.get(old.jobId)) throw new ConvexError('This voice request changed. Make a new request.')
    return { requestId: old._id, jobId: old.jobId }
  }
  const previous = await ctx.db.query('voiceRequests').withIndex('by_session', q => q.eq('sessionId', session._id)).take(voiceLimits.requestsPerSession + 1)
  if (previous.length >= voiceLimits.requestsPerSession) throw new ConvexError('This voice conversation has reached its request limit. Continue by typing.')
  for (const row of previous) { const job = await ctx.db.get(row.jobId); if (job?.preparing && !job.cancelled) throw new ConvexError('Sola is still preparing your earlier request. Wait for its result or continue by typing.') }
  const expiresAt = Date.now() + 30 * 86400000
  const sourceId = await ctx.db.insert('sources', { householdId: session.householdId, text, attachmentIds: [], hash: `conversation:voice:${session._id}:${args.callId}`, revision: 1, expiresAt })
  const jobId = await ctx.db.insert('jobs', { householdId: session.householdId, createdBy: session.createdBy, sourceId, voiceSessionId: session._id, interactive: true, conversation: true, preparing: true, cancelled: false, clarification: '' })
  const requestId = await ctx.db.insert('voiceRequests', { householdId: session.householdId, createdBy: session.createdBy, sessionId: session._id, sessionVersion: session.version, callId: args.callId, inputHash, jobId, createdAt: Date.now(), expiresAt })
  await ctx.runMutation(internal.assistantCoordinator.start, { jobId, sourceRevision: 1 })
  return { requestId, jobId }
} })
export const result = query({ args: { id: v.id('voiceSessions'), version: v.number(), requestId: v.id('voiceRequests') }, handler: async (ctx, args): Promise<VoiceToolResult> => {
  const session = await activeToolSession(ctx, args.id, args.version), request = await ctx.db.get(args.requestId)
  if (!request || request.sessionId !== session._id || request.sessionVersion !== session.version || request.createdBy !== session.createdBy || request.householdId !== session.householdId || request.expiresAt <= Date.now()) throw new ConvexError('This private voice result is unavailable.')
  const job = await ctx.db.get(request.jobId), source = job ? await ctx.db.get(job.sourceId) : null
  const unavailable: VoiceToolResult = { status: 'failed', jobId: request.jobId, reviewRequired: false, answer: 'This request is no longer current. Open the private conversation to review or ask again.' }
  if (!job || job.createdBy !== session.createdBy || job.householdId !== session.householdId || job.voiceSessionId !== session._id || job.cancelled || !source || source.householdId !== session.householdId || source.expiresAt <= Date.now() || sourceHash(source.text ?? '') !== request.inputHash) return unavailable
  const run = job.assistantRunId ? await ctx.db.get(job.assistantRunId) : null
  if (!run || run.jobId !== job._id || run.sourceId !== source._id || !run.privateOnly || !await validAssistantRun(ctx, job)) return unavailable
  if (['failed', 'cancelled'].includes(run.status)) return { ...unavailable, answer: 'Sola could not finish this request. Nothing was approved or sent. Review the private conversation.' }
  if (run.status !== 'complete' || job.preparing) return { status: 'pending', jobId: job._id, reviewRequired: false }
  if (!run.answer?.trim()) return unavailable
  return { status: 'complete', jobId: job._id, answer: run.answer.slice(0, 6000), reviewRequired: (run.deliverables ?? []).some(d => d.status === 'review') }
} })
