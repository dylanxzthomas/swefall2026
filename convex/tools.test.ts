import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { event } from '../tests/fixtures/calendar'
import { payloadHash } from '../shared/daymark'
import { deliver } from './transactional'
vi.mock('./transactional', () => ({ deliver: vi.fn(() => { throw new Error('Unexpected external email') }) }))
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2027-05-05T08:00:00Z')); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'alex@example.test'); vi.mocked(deliver).mockClear() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(provider: 'google' | 'microsoft' | 'apple' = 'google') {
  const t = convexTest(schema, modules); workflow.register(t)
  const adult = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent', email: 'parent@example.test', emailVerified: true })
  const householdId = await adult.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const ids = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic notice', hash: 'fixture', revision: 1, expiresAt: Date.now() + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, clarification: '' })
    const actionId = await ctx.db.insert('actions', { householdId, jobId, sourceRevision: 1, revision: 1, payload: event, status: 'queued' })
    const nativeDeviceId = provider === 'apple' ? '00000000-0000-0000-0000-000000000001' : undefined
    const scopes = [provider === 'apple' ? 'calendar.local.full' : provider === 'microsoft' ? 'Calendars.ReadWrite' : 'https://www.googleapis.com/auth/calendar.app.created']
    const connectionId = await ctx.db.insert('connections', { householdId, subject: 'test|parent', status: 'active', version: 1, provider, scopes, calendarId: 'synthetic-calendar', ...(nativeDeviceId ? { nativeDeviceId } : {}) })
    await ctx.db.insert('connectionPreferences', { householdId, subject: 'test|parent', version: 1, calendarConnectionId: connectionId })
    const approvalId = await ctx.db.insert('approvals', { householdId, actionId, revision: 1, sourceRevision: 1, payloadHash: payloadHash(event), subject: 'test|parent', destination: 'synthetic-calendar', expiresAt: Date.now() + 86400000, connectionId, connectionVersion: 1, selectionVersion: 1, provider, ...(nativeDeviceId ? { nativeDeviceId } : {}) })
    await ctx.db.patch(actionId, { approvalId }); return { sourceId, jobId, actionId, approvalId, connectionId }
  })
  return { t, adult, householdId, ...ids }
}
it('preflights current provider grants without dispatching or claiming success, including legacy approvals', async () => {
  for (const provider of ['google', 'microsoft', 'apple'] as const) {
    const f = await fixture(provider)
    expect(await f.t.mutation(internal.tools.preflight, { actionId: f.actionId, approvalId: f.approvalId })).toMatchObject({ name: `calendar.${provider}.commit`, version: 1 })
    expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
    expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
  }
})
it('blocks revoked grants, stale approvals, unknown versions and unsupported inputs before any attempt', async () => {
  for (const change of ['scope', 'source', 'tool', 'input', 'cancel']) {
    const f = await fixture()
    await f.t.run(async ctx => {
      if (change === 'scope') await ctx.db.patch(f.connectionId, { scopes: [] })
      if (change === 'source') await ctx.db.patch(f.sourceId, { revision: 2 })
      if (change === 'tool') await ctx.db.patch(f.approvalId, { toolName: 'calendar.google.commit', toolVersion: 99 })
      if (change === 'input') await ctx.db.patch(f.actionId, { payload: { ...event, url: 'https://untrusted.example/execute' } })
      if (change === 'cancel') await ctx.db.patch(f.jobId, { cancelled: true })
    })
    await f.t.action(internal.tools.execute, { actionId: f.actionId, approvalId: f.approvalId })
    const a = await f.t.run(ctx => ctx.db.get(f.actionId)); expect(a).toMatchObject({ status: 'review' }); expect(a?.approvalId).toBeUndefined()
    expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
    expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
  }
})
it('rejects exhausted attempts and uncertain actions without invoking a provider', async () => {
  const f = await fixture(), other = await fixture()
  await f.t.run(async ctx => { for (let n = 0; n < 8; n++) await ctx.db.insert('attempts', { householdId: f.householdId, actionId: f.actionId, approvalId: f.approvalId, dispatched: false, finished: true, startedAt: Date.now() }) })
  expect(await f.t.mutation(internal.tools.preflight, { actionId: f.actionId, approvalId: f.approvalId })).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.error).toContain('execution limit')
  // A review action has no executable approval even when given an existing approval ID.
  expect(await f.t.mutation(internal.tools.preflight, { actionId: f.actionId, approvalId: f.approvalId })).toBeNull()
  await other.t.run(ctx => ctx.db.patch(other.actionId, { status: 'uncertain' }))
  await other.t.action(internal.tools.execute, { actionId: other.actionId, approvalId: other.approvalId })
  expect(await other.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
})
it('rejects an approval whose persisted action binding differs, even if the action points to it', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const other = await ctx.db.insert('actions', { householdId: f.householdId, jobId: f.jobId, sourceRevision: 1, revision: 1, payload: event, status: 'review' })
    await ctx.db.patch(f.approvalId, { actionId: other })
  })
  expect(await f.t.mutation(internal.tools.preflight, { actionId: f.actionId, approvalId: f.approvalId })).toBeNull()
  expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})
it('keeps Apple work queued for its authorized phone and never reports a cloud receipt', async () => {
  const f = await fixture('apple')
  await f.t.action(internal.tools.execute, { actionId: f.actionId, approvalId: f.approvalId })
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.status).toBe('queued')
  expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})
it('executes the approved in-app caregiver adapter once and preserves its actual delivery semantics', async () => {
  const f = await fixture()
  const caregiver = f.t.withIdentity({ subject: 'alex', tokenIdentifier: 'test|alex', email: 'alex@example.test', emailVerified: true })
  await caregiver.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await caregiver.mutation(api.pickups.saveDeliverySettings, { channel: 'app' })
  const caregiverId = await f.adult.mutation(api.pickups.addCaregiver, { name: 'Alex', email: 'alex@example.test', childIds: ['maya'] })
  const payload = { kind: 'pickup', childId: 'maya', caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you pick up Maya?', evidence: {} }
  await f.t.run(ctx => ctx.db.patch(f.actionId, { status: 'review', payload, approvalId: undefined }))
  await f.adult.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1, deliveryChannel: 'app' }] })
  const action = (await f.t.run(ctx => ctx.db.get(f.actionId)))!, args = { actionId: f.actionId, approvalId: action.approvalId! }
  await Promise.all([f.t.action(internal.tools.execute, args), f.t.action(internal.tools.execute, args)])
  expect(await caregiver.query(api.pickups.inbox, {})).toHaveLength(1)
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.status).toBe('waiting')
  const receipts = await f.t.run(ctx => ctx.db.query('receipts').collect())
  expect(receipts.map(receipt => receipt.outcome)).toEqual(['request_available_in_app'])
  expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toHaveLength(1)
  expect(deliver).not.toHaveBeenCalled()
})

it('stops obsolete email and app reminder tools while preserving already dispatched results', async () => {
  for (const channel of ['email', 'app'] as const) for (const change of ['version', 'name'] as const) {
    const f = await fixture()
    const requestId = await f.t.run(async ctx => {
      const caregiverId = await ctx.db.insert('caregivers', { householdId: f.householdId, name: 'Alex', email: 'alex@example.test', childIds: ['maya'] })
      const payload = { kind: 'pickup' as const, childId: 'maya', caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'Gate', deadline: '2027-05-05T12:00:00Z', followUpAt: new Date(Date.now()).toISOString(), message: 'Can you pick up Maya?', evidence: {} }
      await ctx.db.patch(f.actionId, { status: 'waiting', payload })
      await ctx.db.patch(f.approvalId, { payloadHash: payloadHash(payload), destination: 'alex@example.test', connectionId: undefined, connectionVersion: undefined, provider: undefined, deliveryChannel: channel, toolName: `caregiver.${channel}.request`, toolVersion: 1 })
      return ctx.db.insert('pickupRequests', { householdId: f.householdId, actionId: f.actionId, caregiverId, revision: 1, tokenHash: 'synthetic', expiresAt: Date.now() + 3600000, status: 'waiting', deliveryChannel: channel, followUpStatus: 'scheduled', ...(channel === 'email' ? { followUpCipher: 'synthetic-cipher' } : {}) })
    })
    await f.t.run(ctx => ctx.db.patch(f.approvalId, change === 'version' ? { toolVersion: 99 } : { toolName: 'calendar.google.commit' }))
    if (channel === 'email') expect(await f.t.mutation(internal.pickups.claimFollowup, { requestId })).toBeNull()
    else await f.t.mutation(internal.pickups.remindInApp, { requestId })
    expect(await f.t.run(ctx => ctx.db.get(requestId))).toMatchObject({ followUpStatus: 'cancelled' })
    expect((await f.t.run(ctx => ctx.db.get(requestId)))?.followUpCipher).toBeUndefined()
    // A result already handed off keeps its original identity and is not suppressed.
    await f.t.run(ctx => ctx.db.patch(requestId, { followUpStatus: 'dispatched' }))
    await f.t.mutation(internal.pickups.followupFinished, { requestId, status: 'accepted', providerId: 'synthetic-provider-result' })
    expect(await f.t.run(ctx => ctx.db.get(requestId))).toMatchObject({ followUpStatus: 'accepted', followUpProviderId: 'synthetic-provider-result' })
  }
  expect(deliver).not.toHaveBeenCalled()
})
