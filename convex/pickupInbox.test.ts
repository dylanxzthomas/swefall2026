import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { deliver } from './transactional'

vi.mock('./transactional', () => ({ deliver: vi.fn(() => { throw new Error('Unexpected email delivery') }) }))
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2027-05-05T08:00:00Z'))
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'alex@example.test,jordan@example.test')
  vi.stubEnv('RESEND_API_KEY', ''); vi.stubEnv('DAYMARK_EMAIL_FROM', ''); vi.stubEnv('DAYMARK_WEB_URL', '')
  vi.mocked(deliver).mockClear()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent', email: 'parent@example.test', emailVerified: true })
  const alex = t.withIdentity({ subject: 'alex', tokenIdentifier: 'test|alex', email: 'alex@example.test', emailVerified: true })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const recipientHousehold = await alex.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await alex.mutation(api.pickups.saveDeliverySettings, { channel: 'app' })
  const caregiverId = await parent.mutation(api.pickups.addCaregiver, { name: 'Alex', email: 'alex@example.test', childIds: ['maya'] })
  const ids = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Private source that must not reach the caregiver', hash: 'notice', revision: 1, expiresAt: Date.now() + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, clarification: '' })
    return { sourceId, jobId }
  })
  const payload = { kind: 'pickup', childId: 'maya', caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you pick up Maya?', evidence: {} }
  const actionId = await parent.mutation(api.jobs.addDraft, { jobId: ids.jobId, payload })
  return { t, parent, alex, householdId, recipientHousehold, caregiverId, actionId, payload, ...ids }
}
async function send(f: Awaited<ReturnType<typeof fixture>>) {
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1, deliveryChannel: 'app' }] })
  const a = (await f.t.run(ctx => ctx.db.get(f.actionId)))!
  const claim = await f.t.mutation(internal.execution.claim, { actionId: f.actionId, approvalId: a.approvalId! })
  await f.t.action(internal.pickups.send, { actionId: f.actionId, attemptId: claim!.attemptId })
  return (await f.alex.query(api.pickups.inbox, {}))[0]
}
it('delivers one in-app request, exposes only scoped details, and records one acceptance without email', async () => {
  const f = await fixture(), request = await send(f)
  expect(request).toMatchObject({ child: 'Maya', location: 'North gate', revision: 1 })
  expect(JSON.stringify(request)).not.toContain('Private source')
  expect(request).not.toHaveProperty('householdId')
  expect(await f.alex.query(api.jobs.list, {})).toEqual([])
  expect(await f.parent.query(api.pickups.inbox, {})).toEqual([])
  await expect(f.parent.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'accept', suggestion: '' })).rejects.toThrow('no longer available')
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1, deliveryChannel: 'app' }] })
  const a = (await f.t.run(ctx => ctx.db.get(f.actionId)))!
  await f.t.mutation(internal.pickups.deliverInApp, { requestId: request.id, attemptId: a.attemptId! })
  expect(await f.t.run(ctx => ctx.db.query('pickupRequests').collect())).toHaveLength(1)
  await f.alex.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'accept', suggestion: '' })
  await expect(f.alex.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'accept', suggestion: '' })).rejects.toThrow('no longer available')
  expect(await f.alex.query(api.pickups.inbox, {})).toEqual([])
  const receipts = await f.t.run(ctx => ctx.db.query('receipts').collect())
  expect(receipts.map(r => r.outcome)).toEqual(['request_available_in_app', 'caregiver_accepted_not_pickup_completed'])
  expect(deliver).not.toHaveBeenCalled()
})
it('requires a verified mailbox and the same recipient identity, not merely a guessed email', async () => {
  const f = await fixture(), request = await send(f)
  const unverified = f.t.withIdentity({ subject: 'alex', tokenIdentifier: 'test|alex', email: 'alex@example.test', emailVerified: false })
  expect(await unverified.query(api.pickups.inbox, {})).toEqual([])
  await expect(unverified.mutation(api.pickups.saveDeliverySettings, { channel: 'app' })).rejects.toThrow('Verify')
  await expect(unverified.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'accept', suggestion: '' })).rejects.toThrow('Verify')
  const stranger = f.t.withIdentity({ subject: 'stranger', tokenIdentifier: 'test|stranger', email: 'alex@example.test', emailVerified: true })
  await stranger.mutation(api.households.save, { timezone: 'UTC', children: [] })
  expect(await stranger.query(api.pickups.inbox, {})).toEqual([])
  await expect(stranger.mutation(api.pickups.saveDeliverySettings, { channel: 'app' })).rejects.toThrow('already linked')
})
it('a changed delivery choice invalidates the approval before dispatch instead of switching channels', async () => {
  const f = await fixture()
  await expect(f.parent.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1 }] })).rejects.toThrow('delivery preference')
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1, deliveryChannel: 'app' }] })
  const a = (await f.t.run(ctx => ctx.db.get(f.actionId)))!
  const claim = await f.t.mutation(internal.execution.claim, { actionId: f.actionId, approvalId: a.approvalId! })
  await f.alex.mutation(api.pickups.saveDeliverySettings, { channel: 'email' })
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: claim!.attemptId })).toBe(false)
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
  expect(deliver).not.toHaveBeenCalled()
})
it('an interrupted in-app delivery can be reviewed again and a late worker cannot deliver the old attempt', async () => {
  const f = await fixture()
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1, deliveryChannel: 'app' }] })
  const a = (await f.t.run(ctx => ctx.db.get(f.actionId)))!
  const claim = await f.t.mutation(internal.execution.claim, { actionId: f.actionId, approvalId: a.approvalId! })
  const request = await f.t.mutation(internal.pickups.prepareRequest, { actionId: f.actionId, tokenHash: 'synthetic-interrupted' })
  await f.t.mutation(internal.execution.dispatch, { attemptId: claim!.attemptId })
  await f.t.mutation(internal.execution.interrupted, { attemptId: claim!.attemptId })
  await f.t.mutation(internal.pickups.deliverInApp, { requestId: request.requestId, attemptId: claim!.attemptId })
  expect(await f.alex.query(api.pickups.inbox, {})).toEqual([])
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.status).toBe('failed')
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
  const delivered = await send(f)
  expect(delivered.id).not.toBe(request.requestId)
  expect(await f.alex.query(api.pickups.inbox, {})).toHaveLength(1)
  expect((await f.t.run(ctx => ctx.db.get(request.requestId)))?.status).toBe('superseded')
  expect(deliver).not.toHaveBeenCalled()
})
it('cancelled, obsolete, expired and deleted-household requests cannot be answered', async () => {
  for (const change of ['cancel', 'source', 'revision', 'expiry', 'household', 'recipient']) {
    const f = await fixture(), request = await send(f)
    await f.t.run(async ctx => {
      if (change === 'cancel') await ctx.db.patch(f.jobId, { cancelled: true })
      if (change === 'source') await ctx.db.patch(f.sourceId, { revision: 2 })
      if (change === 'revision') await ctx.db.patch(f.actionId, { revision: 2 })
      if (change === 'expiry') await ctx.db.patch(request.id, { expiresAt: Date.now() - 1 })
      if (change === 'household') await ctx.db.patch(f.householdId, { deleted: true })
      if (change === 'recipient') await ctx.db.patch(f.recipientHousehold, { deleted: true })
    })
    expect(await f.alex.query(api.pickups.inbox, {})).toEqual([])
    await expect(f.alex.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'accept', suggestion: '' })).rejects.toThrow()
  }
})
it('decline prepares an untried eligible caregiver with explicit availability and fresh approval', async () => {
  const f = await fixture()
  const other = await f.parent.mutation(api.pickups.addCaregiver, { name: 'Jordan', email: 'jordan@example.test', childIds: ['maya'] })
  await f.parent.mutation(api.memory.save, { value: { kind: 'availability', caregiverId: other, date: '2027-05-05', start: '14:00', end: '16:00', available: true } })
  const request = await send(f)
  await f.alex.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'decline', suggestion: '' })
  const a = (await f.t.run(ctx => ctx.db.get(f.actionId)))!
  expect(a).toMatchObject({ status: 'review', revision: 2, payload: { caregiverId: other, deadline: '2027-05-05T10:00:00.000Z' } })
  expect(a.approvalId).toBeUndefined()
  expect(a.revisionNote).toContain('explicitly confirmed availability')
  expect(await f.t.run(ctx => ctx.db.query('pickupRequests').collect())).toHaveLength(1)
  await expect(f.parent.mutation(api.jobs.approve, { actions: [{ id: a._id, revision: 1, deliveryChannel: 'app' }] })).rejects.toThrow('changed')
  expect(deliver).not.toHaveBeenCalled()
})
it('expiry proposes another caregiver, but an urgent pickup requires direct contact', async () => {
  for (const urgent of [false, true]) {
    const f = await fixture()
    const other = await f.parent.mutation(api.pickups.addCaregiver, { name: 'Jordan', email: 'jordan@example.test', childIds: ['maya'] })
    const request = await send(f)
    vi.setSystemTime(new Date(urgent ? '2027-05-05T14:00:00Z' : '2027-05-05T12:00:01Z'))
    await f.t.mutation(internal.pickups.expire, { requestId: request.id })
    const a = (await f.t.run(ctx => ctx.db.get(f.actionId)))!
    expect(a.status).toBe('review')
    expect(a.payload.caregiverId).toBe(urgent ? f.caregiverId : other)
    expect(a.revisionNote).toContain(urgent ? 'Contact an eligible caregiver directly' : 'availability is unknown')
    vi.setSystemTime(new Date('2027-05-05T08:00:00Z'))
  }
})
it('never recommends an ineligible or explicitly unavailable replacement', async () => {
  const f = await fixture()
  const other = await f.parent.mutation(api.pickups.addCaregiver, { name: 'Jordan', email: 'jordan@example.test', childIds: ['maya'] })
  await f.parent.mutation(api.memory.save, { value: { kind: 'availability', caregiverId: other, date: '2027-05-05', start: '14:00', end: '16:00', available: false } })
  const ineligible = await f.parent.mutation(api.pickups.addCaregiver, { name: 'Sam', email: 'sam@example.test', childIds: ['maya'] })
  await f.parent.mutation(api.pickups.updateCaregiver, { id: ineligible, name: 'Sam', email: 'sam@example.test', childIds: [] })
  const request = await send(f)
  await f.alex.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'decline', suggestion: '' })
  const a = (await f.t.run(ctx => ctx.db.get(f.actionId)))!
  expect(a.payload.caregiverId).toBe(f.caregiverId)
  expect(a.revisionNote).toContain('No untried eligible caregiver')
  expect(a.approvalId).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('pickupRequests').collect())).toHaveLength(1)
})
it('suggestions do not confirm coverage and changed availability prevents acceptance', async () => {
  const f = await fixture(), request = await send(f)
  await f.parent.mutation(api.memory.save, { value: { kind: 'availability', caregiverId: f.caregiverId, date: '2027-05-05', start: '14:00', end: '16:00', available: false } })
  await expect(f.alex.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'accept', suggestion: '' })).rejects.toThrow('availability changed')
  await f.alex.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'suggest', suggestion: 'Can we use the south gate at 16:00?' })
  const a = (await f.t.run(ctx => ctx.db.get(f.actionId)))!
  expect(a).toMatchObject({ status: 'review', revision: 2 })
  expect(a.error).toContain('south gate')
  expect((await f.t.run(ctx => ctx.db.query('receipts').collect())).some(r => r.outcome === 'caregiver_accepted_not_pickup_completed')).toBe(false)
})
it('checks household availability in its own timezone even when the pickup is on a different date', async () => {
  const f = await fixture()
  await f.parent.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] })
  await f.parent.mutation(api.memory.save, { value: { kind: 'availability', caregiverId: f.caregiverId, date: '2027-05-05', start: '17:00', end: '19:00', available: false } })
  await f.parent.mutation(api.jobs.edit, { actionId: f.actionId, revision: 1, payload: { ...f.payload, date: '2027-05-06', time: '01:00', deadline: '2027-05-05T23:00:00Z' } })
  await expect(f.parent.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 2, deliveryChannel: 'app' }] })).rejects.toThrow('unavailable')
})
it('makes one approved in-app reminder visible and never adds an email channel', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.actionId, { payload: { ...f.payload, followUpAt: '2027-05-05T09:00:00Z' } }))
  const request = await send(f)
  vi.setSystemTime(new Date('2027-05-05T09:00:01Z'))
  await f.t.mutation(internal.pickups.remindInApp, { requestId: request.id })
  await f.t.mutation(internal.pickups.remindInApp, { requestId: request.id })
  expect((await f.alex.query(api.pickups.inbox, {}))[0].reminder).toBe(true)
  expect(deliver).not.toHaveBeenCalled()
})
