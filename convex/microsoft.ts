'use node'
import { randomBytes } from 'node:crypto'
import { v, ConvexError } from 'convex/values'
import { action, internalAction, type ActionCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { internal } from './_generated/api'
import { hash } from '../shared/daymark'
import { seal, unseal } from './googleCrypto'
import { ReviewRequired, providerCode } from './googleAdapter'
import { microsoftRequest, MicrosoftError } from './microsoftAdapter'

export const microsoftCalendarScope = 'Calendars.ReadWrite'
export const microsoftMailScope = 'Mail.Send'
export const microsoftCalendarReadScope = 'Calendars.Read'
export class MicrosoftConnectionBusy extends Error {}
type Credentials = { access_token: string; refresh_token: string; expiry_date: number; scope: string; accountId: string }
type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
const binding = (connection: { _id: string; householdId: string; subject: string }) => `${connection.householdId}:${connection.subject}:microsoft:${connection._id}`
const normalizeScopes = (scope: string) => [...new Set(scope.split(/\s+/).filter(Boolean).map(value => value.replace(/^https:\/\/graph\.microsoft\.com\//, '')))]
function config() {
  const clientId = process.env.MICROSOFT_CLIENT_ID, clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  const tenant = process.env.MICROSOFT_TENANT || 'common', site = process.env.CONVEX_SITE_URL
  if (!clientId || !clientSecret || !site) throw new ConvexError('Microsoft connection is not configured.')
  if (!/^(common|organizations|consumers|[a-zA-Z0-9.-]+)$/.test(tenant)) throw new Error('Microsoft tenant configuration is invalid.')
  return { clientId, clientSecret, endpoint: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`, redirectUri: `${site}/microsoft/callback` }
}
async function tokenRequest(parameters: Record<string, string>): Promise<TokenResponse> {
  const settings = config()
  const response = await fetch(`${settings.endpoint}/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, ...parameters }) })
  if (!response.ok) throw new MicrosoftError(response.status)
  const result = await response.json() as TokenResponse
  if (!result.access_token || !result.expires_in || result.expires_in < 1) throw new Error('Microsoft did not return usable access credentials.')
  return result
}
export const connect = action({ args: { purpose: v.union(v.literal('calendar_read'), v.literal('calendar'), v.literal('email')), native: v.boolean() }, handler: async (ctx, args): Promise<string> => {
  if (!await ctx.auth.getUserIdentity()) throw new ConvexError('Sign in first.')
  const settings = config(), state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
  const started = await ctx.runMutation(internal.connections.begin, { provider: 'microsoft', hash: hash(state), verifier: seal(verifier, hash(state)), purpose: args.purpose, native: args.native })
  const current = await ctx.runQuery(internal.connections.privateRecord, { id: started.connectionId })
  const scopes = new Set(['offline_access', 'User.Read', args.purpose === 'calendar_read' ? microsoftCalendarReadScope : args.purpose === 'calendar' ? microsoftCalendarScope : microsoftMailScope])
  // Incremental consent must keep the other capability available on the same account.
  for (const scope of current?.scopes ?? []) if ([microsoftCalendarScope, microsoftCalendarReadScope, microsoftMailScope].includes(scope)) scopes.add(scope)
  return `${settings.endpoint}/authorize?${new URLSearchParams({ client_id: settings.clientId, response_type: 'code', redirect_uri: settings.redirectUri,
    response_mode: 'query', scope: [...scopes].join(' '), state, prompt: 'select_account', code_challenge_method: 'S256', code_challenge: Buffer.from(hash(verifier), 'hex').toString('base64url') })}`
} })
export const callback = internalAction({ args: { state: v.string(), code: v.optional(v.string()) }, handler: async (ctx, args): Promise<string> => {
  const { state, connection } = await ctx.runMutation(internal.connections.consume, { hash: hash(args.state), provider: 'microsoft' })
  const returnTo = state.native ? 'com.dylanxzthomas.wren://microsoft/return' : process.env.DAYMARK_WEB_URL
  if (!returnTo || (!state.native && !/^https:\/\//.test(returnTo) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(returnTo))) throw new Error('Trusted return URL missing.')
  if (!args.code) return `${returnTo}?connection=cancelled`
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code: args.code, redirect_uri: config().redirectUri, code_verifier: unseal<string>(state.verifier, hash(args.state)) })
  const scopes = normalizeScopes(tokens.scope ?? '')
  if (!scopes.includes(state.purpose === 'calendar_read' ? microsoftCalendarReadScope : state.purpose === 'calendar' ? microsoftCalendarScope : microsoftMailScope) || !scopes.includes('User.Read')) throw new Error('Requested Microsoft permission was not granted. A work or school administrator may need to approve it.')
  // User.Read resolves the identity directly with Microsoft's bearer-authorized API. No unverified JWT claims are trusted.
  const { data: profile } = await microsoftRequest<{ id?: string; mail?: string; userPrincipalName?: string }>(tokens.access_token!, '/me?$select=id,mail,userPrincipalName')
  const email = (profile.mail || profile.userPrincipalName || '').trim().toLowerCase()
  if (!profile.id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A Microsoft account with an accessible mailbox is required.')
  if (process.env.DAYMARK_ENVIRONMENT !== 'production' && !(process.env.DAYMARK_TEST_MICROSOFT_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).includes(email)) throw new Error('Use an explicitly allowlisted dedicated Microsoft test account in this environment.')
  const old = connection.cipher ? unseal<Credentials>(connection.cipher, binding(connection)) : undefined
  const accountId = connection.accountId ?? old?.accountId
  if (accountId && accountId !== profile.id && !['revoked', 'disconnected', 'revocation_unconfirmed'].includes(connection.status)) throw new Error('Disconnect the previous Microsoft account before changing accounts.')
  const sameAccount = accountId === profile.id
  const credentials: Credentials = { access_token: tokens.access_token!, refresh_token: tokens.refresh_token ?? (sameAccount ? old?.refresh_token ?? '' : ''), expiry_date: Date.now() + tokens.expires_in! * 1000, scope: scopes.join(' '), accountId: profile.id }
  if (!credentials.refresh_token) throw new Error('Offline Microsoft consent is required. Reconnect the account.')
  let calendarId = sameAccount ? connection.calendarId : undefined, calendarName = sameAccount ? connection.calendarName : undefined
  if (scopes.includes(microsoftCalendarScope)) {
    // Connection itself makes no calendar write. Approval later shows the exact default calendar being used.
    const { data: calendar } = await microsoftRequest<{ id?: string; name?: string; canEdit?: boolean }>(credentials.access_token, '/me/calendar?$select=id,name,canEdit')
    if (!calendar.id || calendar.canEdit !== true) throw new Error('The Microsoft default calendar is not writable. Check the account or administrator policy.')
    calendarId = calendar.id; calendarName = calendar.name || 'Outlook calendar'
  }
  const saved = await ctx.runMutation(internal.connections.connected, { id: connection._id, version: state.connectionVersion, cipher: seal(credentials, binding(connection)), scopes, email, accountId: profile.id, ...(calendarId ? { calendarId, calendarName } : {}) })
  if (!saved) throw new Error('The connection changed during consent. Open Daymark to reconnect.')
  return `${returnTo}?connection=connected`
} })
export async function withMicrosoft<T>(ctx: ActionCtx, id: Id<'connections'>, version: number, run: (token: string) => Promise<T>): Promise<T> {
  const lock = randomBytes(20).toString('hex')
  const connection = await ctx.runMutation(internal.connections.acquire, { id, version, lock })
  if (!connection?.cipher) {
    const current = await ctx.runQuery(internal.connections.privateRecord, { id })
    if (current?.status === 'active' && current.version === version && (current.lockUntil ?? 0) > Date.now()) throw new MicrosoftConnectionBusy()
    throw new ReviewRequired('Microsoft connection changed. Reconnect and review again.')
  }
  let reconnect = false
  try {
    if (connection.provider !== 'microsoft') throw new ReviewRequired('The approved Microsoft account no longer matches. Review again.')
    let credentials = unseal<Credentials>(connection.cipher, binding(connection))
    if (!credentials.access_token || credentials.expiry_date < Date.now() + 60_000) {
      let refreshed: TokenResponse
      try { refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token, scope: ['offline_access', 'User.Read', ...normalizeScopes(credentials.scope).filter(scope => [microsoftCalendarScope, microsoftCalendarReadScope, microsoftMailScope].includes(scope))].join(' ') }) }
      catch (error) { reconnect = [400, 401].includes(providerCode(error)); throw error }
      const scopes = normalizeScopes(refreshed.scope ?? credentials.scope)
      if (connection.scopes.some(scope => [microsoftCalendarScope, microsoftCalendarReadScope, microsoftMailScope].includes(scope) && !scopes.includes(scope))) { reconnect = true; throw new ReviewRequired('Microsoft permissions changed. Reconnect and review again.') }
      credentials = { ...credentials, access_token: refreshed.access_token!, refresh_token: refreshed.refresh_token ?? credentials.refresh_token, expiry_date: Date.now() + refreshed.expires_in! * 1000, scope: scopes.join(' ') }
      if (!await ctx.runMutation(internal.connections.refreshed, { id, version, lock, cipher: seal(credentials, binding(connection)) })) throw new ReviewRequired('Microsoft access was revoked during refresh.')
    }
    // Direct fetch never performs a hidden refresh or retry while executing a send.
    return await run(credentials.access_token)
  } catch (error) { if (providerCode(error) === 401) reconnect = true; throw error }
  finally { await ctx.runMutation(internal.connections.release, { id, lock, reconnect }) }
}
export const revoke = internalAction({ args: { id: v.id('connections'), version: v.number() }, handler: async (ctx, args): Promise<void> => {
  const connection = await ctx.runQuery(internal.connections.privateRecord, { id: args.id })
  if (!connection || connection.provider !== 'microsoft' || connection.version !== args.version) return
  // Graph's revokeSignInSessions needs unrelated privileges and signs out other apps; personal accounts do not support it.
  // Remove Daymark's credentials immediately. The parent can remove app consent in Microsoft account permissions.
  await ctx.runMutation(internal.connections.erase, { ...args, revoked: false })
} })
