import { googleConnectionConfigured } from './providerConfiguration'
import { v, ConvexError } from 'convex/values'
import { query, mutation, internalQuery, internalMutation } from './_generated/server'
import { adult } from './access'
import { canUse, providerOf, selection } from './providerRules'
import { internal } from './_generated/api'
export const current = query({ args: {}, handler: async ctx => {
  const { subject } = await adult(ctx)
  const { connection: c } = await selection(ctx, subject, 'calendar')
  return c ? { status: c.status, scopes: c.scopes, calendarId: c.calendarId, calendarName: c.calendarName, email: c.email } : null
} })
export const begin = internalMutation({ args: { hash: v.string(), verifier: v.string(), purpose: v.string(), native: v.boolean(), provider: v.optional(v.union(v.literal('google'), v.literal('microsoft'))) }, handler: async (ctx, args) => {
  const { household, subject } = await adult(ctx)
  const provider = args.provider ?? 'google'
  let c = (await ctx.db.query('connections').withIndex('by_subject', q => q.eq('subject', subject)).collect()).find(c => providerOf(c) === provider)
  if (!c) { const id = await ctx.db.insert('connections', { householdId: household._id, subject, provider, status: 'disconnected', version: 1, scopes: [] }); c = (await ctx.db.get(id))! }
  if (c.householdId !== household._id) throw new ConvexError('This connection belongs to an unavailable household.')
  if (c.status === 'revoked' && c.cipher) throw new ConvexError('Disconnection is still finishing. Try connecting again shortly.')
  if (c.lockUntil && c.lockUntil > Date.now()) throw new ConvexError('An account operation is in progress. Try again shortly.')
  await ctx.db.insert('oauthStates', { householdId: household._id, subject, ...args, provider, connectionId: c._id, expiresAt: Date.now() + 10 * 60_000, consumed: false, connectionVersion: c.version })
  return { subject, householdId: household._id, connectionId: c._id }
} })
export const consume = internalMutation({ args: { hash: v.string(), provider: v.optional(v.union(v.literal('google'), v.literal('microsoft'))) }, handler: async (ctx, { hash, provider = 'google' }) => {
  const state = await ctx.db.query('oauthStates').withIndex('by_hash', q => q.eq('hash', hash)).unique()
  if (!state || (state.provider ?? 'google') !== provider || state.consumed || state.expiresAt < Date.now()) throw new ConvexError('This connection link expired or was already used.')
  const c = state.connectionId ? await ctx.db.get(state.connectionId) : (await ctx.db.query('connections').withIndex('by_subject', q => q.eq('subject', state.subject)).collect()).find(c => providerOf(c) === provider)
  const h = await ctx.db.get(state.householdId)
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', state.subject)).unique()
  if (member?.householdId !== state.householdId || !c || c.subject !== state.subject || c.householdId !== state.householdId || providerOf(c) !== provider || !h || h.deleted || c.version !== state.connectionVersion || (c.lockUntil ?? 0) > Date.now()) throw new ConvexError('The connection changed. Start again from Daymark.')
  await ctx.db.patch(state._id, { consumed: true })
  return { state, connection: c, timezone: h.timezone }
} })
export const connected = internalMutation({ args: { id: v.id('connections'), version: v.number(), cipher: v.string(), scopes: v.array(v.string()), calendarId: v.optional(v.string()), calendarName: v.optional(v.string()), accountId: v.optional(v.string()), email: v.optional(v.string()) }, handler: async (ctx, args) => {
  const c = await ctx.db.get(args.id)
  if (!c || c.version !== args.version || (c.lockUntil ?? 0) > Date.now()) return false
  const h = await ctx.db.get(c.householdId)
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', c.subject)).unique()
  if (!h || h.deleted || member?.householdId !== c.householdId) return false
  await ctx.db.patch(c._id, { cipher: args.cipher, scopes: args.scopes, calendarId: args.calendarId, calendarName: args.calendarName, accountId: args.accountId, email: args.email, status: 'active', version: c.version + 1 })
  const preference = await ctx.db.query('connectionPreferences').withIndex('by_subject', q => q.eq('subject', c.subject)).unique()
  const legacyCalendar = preference ? null : (await selection(ctx, c.subject, 'calendar')).connection
  const legacyEmail = preference ? null : (await selection(ctx, c.subject, 'email')).connection
  const choices = { calendarConnectionId: preference?.calendarConnectionId ?? (canUse(legacyCalendar, 'calendar') ? legacyCalendar?._id : undefined), emailConnectionId: preference?.emailConnectionId ?? (canUse(legacyEmail, 'email') ? legacyEmail?._id : undefined) }
  const updated = { ...c, ...args, status: 'active' }
  if (!choices.calendarConnectionId && canUse(updated, 'calendar')) choices.calendarConnectionId = c._id
  if (!choices.emailConnectionId && canUse(updated, 'email')) choices.emailConnectionId = c._id
  if (preference) await ctx.db.patch(preference._id, { ...choices, version: preference.version + 1 })
  else await ctx.db.insert('connectionPreferences', { householdId: c.householdId, subject: c.subject, version: 1, ...choices })
  return true
} })
export const acquire = internalMutation({ args: { id: v.id('connections'), version: v.number(), lock: v.string() }, handler: async (ctx, args) => {
  const c = await ctx.db.get(args.id)
  if (!c || c.version !== args.version || c.status !== 'active' || !c.cipher || (c.lockUntil ?? 0) > Date.now()) return null
  const h = await ctx.db.get(c.householdId)
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', c.subject)).unique()
  if (!h || h.deleted || member?.householdId !== c.householdId) return null
  await ctx.db.patch(c._id, { lock: args.lock, lockUntil: Date.now() + 120_000 })
  return c
} })
export const refreshed = internalMutation({ args: { id: v.id('connections'), version: v.number(), lock: v.string(), cipher: v.string(), scopes: v.optional(v.array(v.string())) }, handler: async (ctx, args) => {
  const c = await ctx.db.get(args.id)
  if (!c || c.version !== args.version || c.lock !== args.lock || c.status !== 'active') return false
  const household = await ctx.db.get(c.householdId)
  const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', c.subject)).unique()
  if (!household || household.deleted || member?.householdId !== c.householdId) return false
  const scopes = args.scopes ? [...new Set(args.scopes)].sort() : undefined
  const changed = scopes && JSON.stringify(scopes) !== JSON.stringify([...new Set(c.scopes)].sort())
  await ctx.db.patch(c._id, { cipher: args.cipher, ...(scopes ? { scopes } : {}), ...(changed ? { version: c.version + 1 } : {}) })
  // Any changed grant invalidates pending decisions even if refresh itself succeeded.
  return !changed
} })
export const release = internalMutation({ args: { id: v.id('connections'), lock: v.string(), reconnect: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const c = await ctx.db.get(args.id)
  if (c?.lock !== args.lock) return
  await ctx.db.patch(c._id, { lock: undefined, lockUntil: undefined, ...(args.reconnect && c.status === 'active' ? { status: 'reconnect', version: c.version + 1 } : {}) })
} })
export const disconnect = mutation({ args: { id: v.optional(v.id('connections')) }, handler: async (ctx, { id }) => {
  const { subject, household } = await adult(ctx)
  const c = id ? await ctx.db.get(id) : (await ctx.db.query('connections').withIndex('by_subject', q => q.eq('subject', subject)).collect()).find(c => providerOf(c) === 'google')
  if (!c || c.subject !== subject || c.householdId !== household._id) throw new ConvexError('This connection is unavailable.')
  // Local authorization is removed before the provider revocation runs.
  await ctx.db.patch(c._id, { status: 'revoked', version: c.version + 1, lock: undefined, lockUntil: undefined })
  for (const a of await ctx.db.query('actions').withIndex('by_household', q => q.eq('householdId', household._id)).collect()) {
    const approval = a.approvalId && await ctx.db.get(a.approvalId)
    if (approval && approval.connectionId === c._id && ['queued', 'waiting'].includes(a.status)) await ctx.db.patch(a._id, { status: 'cancelled', error: 'Account access disconnected.' })
  }
  if (c.provider !== 'apple') await ctx.scheduler.runAfter(0, providerOf(c) === 'microsoft' ? internal.microsoft.revoke : internal.google.revoke, { id: c._id, version: c.version + 1 })
} })
export const privateRecord = internalQuery({ args: { id: v.id('connections') }, handler: (ctx, { id }) => ctx.db.get(id) })
export const erase = internalMutation({ args: { id: v.id('connections'), version: v.number(), revoked: v.boolean() }, handler: async (ctx, args) => {
  const c = await ctx.db.get(args.id)
  if (c?.version === args.version) await ctx.db.patch(c._id, { cipher: undefined, status: args.revoked ? 'revoked' : 'revocation_unconfirmed' })
} })

export const overview = query({ args: {}, handler: async ctx => {
  const { subject, household } = await adult(ctx)
  const connections = (await ctx.db.query('connections').withIndex('by_subject', q => q.eq('subject', subject)).collect()).filter(c => c.householdId === household._id)
  const calendar = await selection(ctx, subject, 'calendar'), email = await selection(ctx, subject, 'email')
  return { items: connections.map(c => ({ id: c._id, provider: providerOf(c), nativeDeviceId: c.nativeDeviceId, version: c.version, status: c.status, scopes: c.scopes, calendarId: c.calendarId, calendarName: c.calendarName, email: c.email, calendar: canUse(c, 'calendar'), mail: canUse(c, 'email') })), calendarId: calendar.connection?._id, emailId: email.connection?._id, version: calendar.version, configured: { google: googleConnectionConfigured(), microsoft: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) } }
} })
export const choose = mutation({ args: { purpose: v.union(v.literal('calendar'), v.literal('email')), id: v.id('connections'), version: v.number() }, handler: async (ctx, args) => {
  const { subject, household } = await adult(ctx)
  const c = await ctx.db.get(args.id), current = await selection(ctx, subject, args.purpose)
  if (!c || c.subject !== subject || c.householdId !== household._id || !canUse(c, args.purpose)) throw new ConvexError('Connect this account before choosing it.')
  if (current.version !== args.version) throw new ConvexError('Account choices changed. Reopen settings.')
  const preference = await ctx.db.query('connectionPreferences').withIndex('by_subject', q => q.eq('subject', subject)).unique()
  const choice = args.purpose === 'calendar' ? { calendarConnectionId: c._id } : { emailConnectionId: c._id }
  if (preference) await ctx.db.patch(preference._id, { ...choice, version: preference.version + 1 })
  else { const calendar = await selection(ctx, subject, 'calendar'), email = await selection(ctx, subject, 'email'); await ctx.db.insert('connectionPreferences', { householdId: household._id, subject, version: 1, ...(calendar.connection ? { calendarConnectionId: calendar.connection._id } : {}), ...(email.connection ? { emailConnectionId: email.connection._id } : {}), ...choice }) }
} })
