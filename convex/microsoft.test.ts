// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import { event } from '../tests/fixtures/calendar'
import { microsoftEventBody } from './microsoftAdapter'
import schema from './schema'
import { api, internal } from './_generated/api'
import { hash } from '../shared/daymark'
import { seal, unseal } from './googleCrypto'
import { MicrosoftConnectionBusy, withMicrosoft } from './microsoft'
const modules = import.meta.glob('./**/*.ts')
const fetchMock = vi.fn()
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('PROVIDER_TOKEN_KEYS', JSON.stringify({ test: Buffer.alloc(32, 4).toString('base64') })); vi.stubEnv('PROVIDER_TOKEN_KEY_ID', 'test')
  vi.stubEnv('MICROSOFT_CLIENT_ID', 'synthetic-client'); vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'synthetic-secret')
  vi.stubEnv('CONVEX_SITE_URL', 'https://synthetic.convex.site'); vi.stubEnv('DAYMARK_WEB_URL', 'https://synthetic.example.test')
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_MICROSOFT_EMAILS', 'outlook-parent@example.test'); vi.stubEnv('MICROSOFT_TENANT', 'common')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
async function setup() {
  const t = convexTest(schema, modules), alice = t.withIdentity({ subject: 'alice', tokenIdentifier: 'alice' })
  const householdId = await alice.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [] })
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'alice', provider: 'microsoft', status: 'active', version: 1, scopes: ['User.Read', 'Mail.Send'], accountId: 'account-one', email: 'outlook-parent@example.test' }))
  const binding = `${householdId}:alice:microsoft:${connectionId}`
  const credentials = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expiry_date: Date.now() + 3_600_000, scope: 'User.Read Mail.Send', accountId: 'account-one' }
  await t.run(ctx => ctx.db.patch(connectionId, { cipher: seal(credentials, binding) }))
  const context = { runMutation: (reference: any, args: any) => t.mutation(reference, args), runQuery: (reference: any, args: any) => t.query(reference, args) }
  return { t, alice, householdId, connectionId, binding, credentials, context }
}
describe('Microsoft OAuth and token lifecycle', () => {
  it('uses PKCE with provider-bound one-use state, preserves mail consent, and connects the real default calendar', async () => {
    const { t, alice, connectionId, binding } = await setup()
    const url = new URL(await alice.action(api.microsoft.connect, { purpose: 'calendar', native: false }))
    expect(url.origin).toBe('https://login.microsoftonline.com'); expect(url.pathname).toContain('/common/')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['Calendars.ReadWrite', 'Mail.Send', 'offline_access', 'User.Read']))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_secret')).toBeNull()
    const state = url.searchParams.get('state')!
    await expect(t.mutation(internal.connections.consume, { hash: hash(state), provider: 'google' })).rejects.toThrow('expired')
    fetchMock.mockResolvedValueOnce(json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'User.Read Mail.Send Calendars.ReadWrite' }))
      .mockResolvedValueOnce(json({ id: 'account-one', mail: 'outlook-parent@example.test' }))
      .mockResolvedValueOnce(json({ id: 'calendar-id', name: 'Family calendar', canEdit: true }))
    expect(await t.action(internal.microsoft.callback, { state, code: 'synthetic-code' })).toBe('https://synthetic.example.test?connection=connected')
    const connection = await t.query(internal.connections.privateRecord, { id: connectionId })
    expect(connection).toMatchObject({ provider: 'microsoft', accountId: 'account-one', calendarId: 'calendar-id', calendarName: 'Family calendar', version: 2 })
    expect(connection?.cipher).not.toContain('new-access')
    expect(unseal(connection!.cipher!, binding)).toMatchObject({ refresh_token: 'new-refresh' })
    const parameters = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(Buffer.from(hash(parameters.get('code_verifier')!), 'hex').toString('base64url')).toBe(url.searchParams.get('code_challenge'))
    expect(fetchMock.mock.calls.slice(1).every(([, request]) => !request.method)).toBe(true)
    await expect(t.action(internal.microsoft.callback, { state, code: 'replay' })).rejects.toThrow('already used')
  })
  it('rejects account replacement or a non-allowlisted account without modifying the stored connection', async () => {
    for (const profile of [{ id: 'account-two', mail: 'outlook-parent@example.test' }, { id: 'account-one', mail: 'personal@example.test' }]) {
      const { t, alice, connectionId } = await setup()
      const state = new URL(await alice.action(api.microsoft.connect, { purpose: 'email', native: false })).searchParams.get('state')!
      fetchMock.mockResolvedValueOnce(json({ access_token: 'new', refresh_token: 'new', expires_in: 3600, scope: 'User.Read Mail.Send' })).mockResolvedValueOnce(json(profile))
      await expect(t.action(internal.microsoft.callback, { state, code: 'synthetic-code' })).rejects.toThrow(profile.id === 'account-two' ? 'Disconnect the previous' : 'allowlisted')
      expect(await t.query(internal.connections.privateRecord, { id: connectionId })).toMatchObject({ accountId: 'account-one', version: 1 })
    }
  })
  it('releases the token lock after use and refuses a parallel account operation', async () => {
    const { t, context, connectionId } = await setup()
    await withMicrosoft(context as any, connectionId, 1, async token => {
      expect(token).toBe('synthetic-access')
      await expect(withMicrosoft(context as any, connectionId, 1, async () => undefined)).rejects.toBeInstanceOf(MicrosoftConnectionBusy)
    })
    expect((await t.query(internal.connections.privateRecord, { id: connectionId }))?.lock).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rotates encrypted refresh credentials before giving a token to the external operation', async () => {
    const { t, context, connectionId, credentials, binding } = await setup()
    await t.run(ctx => ctx.db.patch(connectionId, { cipher: seal({ ...credentials, expiry_date: 0 }, binding) }))
    fetchMock.mockResolvedValueOnce(json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: 'User.Read Mail.Send' }))
    await withMicrosoft(context as any, connectionId, 1, async token => {
      expect(token).toBe('rotated-access')
      const record = await t.query(internal.connections.privateRecord, { id: connectionId })
      expect(unseal(record!.cipher!, binding)).toMatchObject({ refresh_token: 'rotated-refresh' })
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('never dispatches after permission loss or revocation while refreshing', async () => {
    const { t, context, connectionId, credentials, binding } = await setup()
    await t.run(ctx => ctx.db.patch(connectionId, { cipher: seal({ ...credentials, expiry_date: 0 }, binding) }))
    fetchMock.mockImplementationOnce(async () => {
      await t.run(ctx => ctx.db.patch(connectionId, { status: 'revoked', version: 2 }))
      return json({ access_token: 'new', expires_in: 3600, scope: 'User.Read Mail.Send' })
    })
    const run = vi.fn()
    await expect(withMicrosoft(context as any, connectionId, 1, run)).rejects.toThrow('revoked during refresh')
    expect(run).not.toHaveBeenCalled()
    expect(await t.query(internal.connections.privateRecord, { id: connectionId })).toMatchObject({ status: 'revoked', version: 2 })
  })
  it('requires reconnection after a refresh grant fails or drops a previously approved scope', async () => {
    for (const response of [new Response(null, { status: 400 }), json({ access_token: 'new', expires_in: 3600, scope: 'User.Read' })]) {
      const { t, context, connectionId, credentials, binding } = await setup()
      await t.run(ctx => ctx.db.patch(connectionId, { cipher: seal({ ...credentials, expiry_date: 0 }, binding) }))
      fetchMock.mockResolvedValueOnce(response)
      const run = vi.fn()
      await expect(withMicrosoft(context as any, connectionId, 1, run)).rejects.toThrow()
      expect(run).not.toHaveBeenCalled()
      expect(await t.query(internal.connections.privateRecord, { id: connectionId })).toMatchObject({ status: 'reconnect', version: 2 })
    }
  })
  it('removes Daymark credentials without falsely claiming global provider revocation', async () => {
    const { t, connectionId } = await setup()
    await t.run(ctx => ctx.db.patch(connectionId, { status: 'revoked', version: 2 }))
    await t.action(internal.microsoft.revoke, { id: connectionId, version: 2 })
    const record = await t.query(internal.connections.privateRecord, { id: connectionId })
    expect(record?.cipher).toBeUndefined(); expect(record?.status).toBe('revocation_unconfirmed')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})


describe('approved Microsoft execution through durable state', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'teacher@example.test') })
  afterEach(() => vi.useRealTimers())
  async function prepared() {
    const fixture = await setup(), { t, alice, householdId, connectionId } = fixture
    workflow.register(t)
    await t.run(async ctx => {
      await ctx.db.patch(householdId, { children: [{ id: 'maya', name: 'Maya' }] })
      await ctx.db.patch(connectionId, { scopes: ['User.Read', 'Mail.Send', 'Calendars.ReadWrite'], calendarId: 'outlook-calendar' })
    })
    await alice.mutation(api.connections.choose, { purpose: 'calendar', id: connectionId, version: 0 })
    await alice.mutation(api.connections.choose, { purpose: 'email', id: connectionId, version: 1 })
    const jobId = await t.run(async ctx => {
      const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic school notice', hash: 'synthetic-notice', revision: 1, expiresAt: Date.now() + 86400000 })
      return ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'alice', preparing: false, cancelled: false, clarification: '' })
    })
    const calendarAction = await alice.mutation(api.jobs.addDraft, { jobId, payload: event })
    const emailAction = await alice.mutation(api.jobs.addDraft, { jobId, payload: { kind: 'email', childId: 'maya', to: 'teacher@example.test', subject: 'Synthetic RSVP', body: 'Maya will attend.', requirement: '', evidence: {} } })
    await alice.mutation(api.jobs.approve, { actions: [{ id: calendarAction, revision: 1, selectionVersion: 2 }, { id: emailAction, revision: 1, selectionVersion: 2 }] })
    const execute = async (actionId: typeof calendarAction) => {
      const action = (await t.run(ctx => ctx.db.get(actionId)))!
      await t.action(internal.google.execute, { actionId, approvalId: action.approvalId! })
    }
    return { ...fixture, jobId, calendarAction, emailAction, execute }
  }
  it('persists the verified Outlook event and an accepted email without a fabricated message ID', async () => {
    const f = await prepared()
    fetchMock.mockResolvedValueOnce(json({ value: [] })).mockResolvedValueOnce(json({ id: 'outlook-event' }, 201))
      .mockResolvedValueOnce(json({ ...microsoftEventBody(event, f.calendarAction, 1), id: 'outlook-event', '@odata.etag': 'readback-version' }))
    await f.execute(f.calendarAction)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202, headers: { 'request-id': 'graph-request' } }))
    await f.execute(f.emailAction)
    expect((await f.t.run(ctx => ctx.db.get(f.calendarAction)))?.status).toBe('succeeded')
    expect((await f.t.run(ctx => ctx.db.get(f.emailAction)))?.status).toBe('succeeded')
    expect(await f.t.run(ctx => ctx.db.query('planEvents').collect())).toEqual([expect.objectContaining({ connectionId: f.connectionId, provider: 'microsoft', eventId: 'outlook-event', calendarId: 'outlook-calendar', etag: 'readback-version' })])
    const receipts = await f.t.run(ctx => ctx.db.query('receipts').collect())
    expect(receipts).toHaveLength(2)
    expect(receipts.find(receipt => receipt.actionId === f.emailAction)).toMatchObject({ outcome: 'microsoft_accepted', requestId: 'graph-request' })
    expect(receipts.find(receipt => receipt.actionId === f.emailAction)?.providerId).toBeUndefined()
  })
  it('preserves a completed calendar when email times out and never replays that send', async () => {
    const f = await prepared()
    fetchMock.mockResolvedValueOnce(json({ value: [] })).mockResolvedValueOnce(json({ id: 'outlook-event' }, 201))
      .mockResolvedValueOnce(json({ ...microsoftEventBody(event, f.calendarAction, 1), id: 'outlook-event', '@odata.etag': 'readback-version' }))
    await f.execute(f.calendarAction)
    fetchMock.mockRejectedValueOnce(new Error('connection lost after request'))
    await f.execute(f.emailAction)
    expect((await f.t.run(ctx => ctx.db.get(f.emailAction)))?.status).toBe('uncertain')
    expect((await f.t.run(ctx => ctx.db.get(f.calendarAction)))?.status).toBe('succeeded')
    expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(1)
    const requestCount = fetchMock.mock.calls.length
    await f.execute(f.emailAction)
    await expect(f.alice.mutation(api.jobs.approve, { actions: [{ id: f.emailAction, revision: 1, selectionVersion: 2 }] })).rejects.toThrow('reconciliation')
    expect(fetchMock).toHaveBeenCalledTimes(requestCount)
  })
  it('stops after provider preflight when the selected account changes before dispatch', async () => {
    const f = await prepared()
    fetchMock.mockImplementationOnce(async () => {
      await f.t.run(async ctx => {
        const preference = (await ctx.db.query('connectionPreferences').collect())[0]
        await ctx.db.patch(preference._id, { version: preference.version + 1 })
      })
      return json({ value: [] })
    })
    await f.execute(f.calendarAction)
    expect((await f.t.run(ctx => ctx.db.get(f.calendarAction)))?.status).toBe('review')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(0)
    expect((await f.t.run(ctx => ctx.db.query('attempts').collect()))[0]).toMatchObject({ dispatched: false, finished: true })
  })
})
