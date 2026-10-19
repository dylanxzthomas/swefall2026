'use node'
import { createHash } from 'node:crypto'
import { ConvexError, v } from 'convex/values'
import { action, internalAction } from './_generated/server'
import { api, internal } from './_generated/api'
import { validVoiceOffer, voiceCallId, voiceConfiguration, voiceLimits, voiceModel, voiceProviderOrigin, type VoiceSession, type VoiceFailureCategory } from '../shared/voice'

/** Allowlisted diagnostics only: never retain a provider body, message, or key. */
export class VoiceProviderError extends Error {
  constructor(readonly category: VoiceFailureCategory, readonly status: number) { super('Voice provider connection failed.') }
}
async function providerRejection(response: Response): Promise<VoiceProviderError> {
  let code = ''
  try { const body = await response.text(); if (body.length <= 24000) { const data = JSON.parse(body); code = typeof data?.error?.code === 'string' ? data.error.code : '' } } catch { /* Keep only the fixed fallback category. */ }
  const category: VoiceFailureCategory = code === 'insufficient_quota' ? 'quota' : response.status === 429 ? 'rate_limit' : response.status === 401 ? 'authentication' : response.status === 403 || response.status === 404 || code === 'model_not_found' ? 'model_access' : response.status === 400 ? 'invalid_configuration' : 'provider_unavailable'
  return new VoiceProviderError(category, response.status)
}

/** SDP passes through the trusted backend; no persistent or ephemeral key reaches the client. */
export async function createVoiceCall(key: string, sdp: string, names: { assistantName: string; householdName: string; toolsEnabled?: boolean }, safety: string, transport: typeof fetch = fetch) {
  if (!key || !validVoiceOffer(sdp) || !/^[a-f0-9]{64}$/.test(safety)) throw new Error('Invalid voice configuration.')
  const form = new FormData(); form.set('sdp', sdp); form.set('session', JSON.stringify(voiceConfiguration(names.assistantName, names.householdName, names.toolsEnabled === true)))
  const response = await transport(`${voiceProviderOrigin}/v1/realtime/calls`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'OpenAI-Safety-Identifier': safety }, body: form, signal: AbortSignal.timeout(20000), redirect: 'error' })
  const callId = voiceCallId(response.headers.get('Location'))
  if (!response.ok) throw await providerRejection(response)
  if (!callId) throw new Error('Voice provider connection failed.')
  try {
    const answer = await response.text()
    if (!validVoiceOffer(answer)) throw new Error('Invalid voice answer.')
    return { sdp: answer, callId }
  } catch { await closeVoiceCall(key, callId, transport); throw new Error('Voice provider connection failed.') }
}
export async function closeVoiceCall(key: string, callId: string, transport: typeof fetch = fetch): Promise<boolean> {
  if (!key || !/^rtc_[A-Za-z0-9_-]{1,180}$/.test(callId)) return false
  try {
    const response = await transport(`${voiceProviderOrigin}/v1/realtime/calls/${callId}/hangup`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000), redirect: 'error' })
    return response.ok || response.status === 404 || response.status === 410
  } catch { return false }
}
export const start = action({ args: { sdp: v.string(), requestId: v.string(), consent: v.literal(true), toolsConsent: v.optional(v.literal(true)) }, handler: async (ctx, args): Promise<VoiceSession> => {
  if (!validVoiceOffer(args.sdp)) throw new ConvexError('Voice could not start. Retry from this device’s microphone controls.')
  const reservation = await ctx.runMutation(api.voice.reserve, { requestId: args.requestId, consent: args.consent, ...(args.toolsConsent ? { toolsConsent: true } : {}) })
  if (!reservation) throw new ConvexError('This voice request was already used. Start a new conversation.')
  const identity = { id: reservation.id, version: reservation.version }
  let providerCallId: string | undefined
  try {
    if (!await ctx.runQuery(internal.voice.permitted, identity)) throw new Error('Voice session stopped.')
    const user = await ctx.auth.getUserIdentity()
    if (!user) throw new Error('Voice session stopped.')
    const result = await createVoiceCall(process.env.OPENAI_API_KEY!, args.sdp, reservation, createHash('sha256').update(user.tokenIdentifier).digest('hex'))
    providerCallId = result.callId
    if (!await ctx.runMutation(internal.voice.started, { ...identity, providerCallId })) throw new Error('Voice session stopped.')
    return { ...identity, sdp: result.sdp, expiresAt: reservation.expiresAt, model: voiceModel, toolsEnabled: reservation.toolsEnabled }
  } catch (cause) {
    if (providerCallId) await closeVoiceCall(process.env.OPENAI_API_KEY ?? '', providerCallId)
    await ctx.runMutation(internal.voice.failed, { ...identity, ...(cause instanceof VoiceProviderError ? { failureCategory: cause.category, failureStatus: cause.status } : {}) })
    throw new ConvexError('Voice could not connect. Check microphone access or continue by typing.')
  }
} })
export const close = internalAction({ args: { id: v.id('voiceSessions'), providerCallId: v.string(), attempt: v.optional(v.number()) }, handler: async (ctx, args): Promise<void> => {
  const confirmed = await closeVoiceCall(process.env.OPENAI_API_KEY ?? '', args.providerCallId)
  await ctx.runMutation(internal.voice.ended, { id: args.id, providerCallId: args.providerCallId, confirmed })
  if (!confirmed && (args.attempt ?? 0) < 3) await ctx.scheduler.runAfter(10000 * ((args.attempt ?? 0) + 1), internal.realtimeVoice.close, { ...args, attempt: (args.attempt ?? 0) + 1 })
} })
export const check = internalAction({ args: { id: v.id('voiceSessions'), version: v.number(), providerCallId: v.string() }, handler: async (ctx, args): Promise<void> => {
  if (!await ctx.runQuery(internal.voice.permitted, { id: args.id, version: args.version })) {
    await ctx.runAction(internal.realtimeVoice.close, { id: args.id, providerCallId: args.providerCallId })
    return
  }
  await ctx.scheduler.runAfter(Math.min(30000, voiceLimits.sessionMs), internal.realtimeVoice.check, args)
} })
